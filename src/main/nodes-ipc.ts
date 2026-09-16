import { z } from 'zod';
import type { ExecutionTarget, NodeRuntimeInfo } from '../shared/nodes.js';
import type {
  RemoteNodeSaveRequest,
  RemoteWorkspaceValidation,
  RendererNodeTestResult,
  RendererNodeView
} from '../shared/types.js';
import { currentRunId } from './agents.js';
import { backgroundExecObligations } from './codex/ownership.js';
import { inFlightToolCalls } from './mcp/call-context.js';
import { getSessionProject } from './projects.js';
import { listInputs } from './session/input.js';
import { continuationForSession } from './session/continuation.js';
import { bindSessionExecutionTarget, getSession } from './session/store.js';
import { executionHandles } from './nodes/handles.js';
import {
  nodeRegistry,
  type NodeRegistrySnapshot,
  type RemoteNodeInput
} from './nodes/registry.js';

type IpcRegister = <T>(channel: string, handler: (payload: unknown) => Promise<T>) => void;

export interface NodeRegistryIpcPort {
  list(): Promise<NodeRegistrySnapshot[]>;
  get(nodeId: string): Promise<NodeRegistrySnapshot | null>;
  upsertRemote(input: RemoteNodeInput, token?: string): Promise<unknown>;
  removeRemote(nodeId: string): Promise<boolean>;
  testConnection(nodeId: string): Promise<NodeRuntimeInfo>;
  connect(nodeId: string): Promise<unknown>;
  disconnect(nodeId: string): Promise<void>;
}

interface RebindSessionView {
  id: string;
  conversationId: string | null;
  activeTurnId?: string | null;
  origin?: { kind: 'resume' | 'worker' | 'helper' | 'desktop' } | null;
}

interface RebindInputView {
  sessionId: string | null;
  deliveredSessionId?: string | null;
  state: string;
}

export interface NodeSessionRebindPort {
  session(id: string): Promise<RebindSessionView | null>;
  inputs(): Promise<RebindInputView[]>;
  inFlight(conversationId: string | null): number;
  backgroundRunning(sessionId: string): readonly unknown[];
  executionHandleCount(sessionId: string): number;
  activeRun(conversationId: string): string | null;
  continuationOpen(sessionId: string): boolean;
  localWorkspace(sessionId: string): Promise<string | null>;
  bind(id: string, target: Omit<ExecutionTarget, 'bindingVersion'>): Promise<ExecutionTarget>;
}

const defaultSessionRebindPort: NodeSessionRebindPort = {
  session: id => getSession(id),
  inputs: () => listInputs(),
  inFlight: conversationId => inFlightToolCalls(conversationId),
  backgroundRunning: sessionId => backgroundExecObligations(sessionId).running,
  // The handle store currently exposes this as countSession; keep the IPC contract phrased in
  // terms of execution handles so a future store rename does not leak into renderer semantics.
  executionHandleCount: sessionId => executionHandles.countSession(sessionId),
  activeRun: conversationId => currentRunId(conversationId),
  continuationOpen: sessionId => continuationForSession(sessionId) !== null,
  localWorkspace: async sessionId => (await getSessionProject(sessionId))?.virtual ?? null,
  bind: (id, target) => bindSessionExecutionTarget(id, target)
};

const nodeIdArg = z.object({ id: z.string().min(1).max(128) }).strict();
const saveNodeArg = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(160),
  endpoint: z.string().min(1).max(4096),
  expectedMachineId: z.string().max(256).optional(),
  token: z.string().max(16_384).optional()
}).strict();
const workspaceArg = z.object({
  nodeId: z.string().min(1).max(128),
  workspace: z.string().min(1).max(32_768)
}).strict();
const rebindArg = z.object({
  sessionId: z.string().min(8).max(64),
  nodeId: z.string().min(1).max(128),
  workspace: z.string().max(32_768).optional()
}).strict();

/** The only node shape allowed to leave the main process. */
export function rendererNodeView(snapshot: NodeRegistrySnapshot): RendererNodeView {
  return {
    id: snapshot.config.id,
    name: snapshot.config.name,
    transport: snapshot.config.transport,
    endpoint: snapshot.config.endpoint ?? null,
    expectedMachineId: snapshot.config.expectedMachineId ?? null,
    configVersion: snapshot.config.configVersion,
    credentialConfigured: snapshot.config.transport === 'remote-stdio-ws' && Boolean(snapshot.config.credentialRef),
    status: snapshot.state,
    runtimeInfo: snapshot.runtimeInfo
      ? {
          ...snapshot.runtimeInfo,
          approvedRoots: [...snapshot.runtimeInfo.approvedRoots],
          capabilities: [...snapshot.runtimeInfo.capabilities]
        }
      : null
  };
}

function segments(value: string, windows: boolean): string[] {
  const normalized = windows ? value.replace(/\//g, '\\') : value;
  return normalized.split(windows ? /\\+/ : /\/+/).filter(part => part && part !== '.');
}

function comparableRemotePath(value: string, platform: NodeRuntimeInfo['platform']): string {
  const windows = platform === 'win32';
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('\0')) throw new Error('Remote workspace is invalid');
  const parts = segments(trimmed, windows);
  if (parts.includes('..')) throw new Error('Remote workspace cannot contain parent traversal');
  if (windows) {
    if (!/^[a-zA-Z]:[\\/]/.test(trimmed) && !/^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(trimmed)) {
      throw new Error('Remote Windows workspace must be an absolute path');
    }
    const normalized = trimmed.replace(/[\\/]+/g, '\\').replace(/\\+$/, '');
    return normalized.toLowerCase();
  }
  if (!trimmed.startsWith('/')) throw new Error('Remote workspace must be an absolute path');
  const normalized = `/${parts.join('/')}`;
  return normalized === '' ? '/' : normalized;
}

function pathWithin(candidate: string, root: string, platform: NodeRuntimeInfo['platform']): boolean {
  const separator = platform === 'win32' ? '\\' : '/';
  const child = comparableRemotePath(candidate, platform);
  const parent = comparableRemotePath(root, platform);
  if (child === parent) return true;
  const prefix = parent.endsWith(separator) ? parent : `${parent}${separator}`;
  return child.startsWith(prefix);
}

/**
 * Validate only against the remote node's own strings. Never resolve/realpath these on this Mac.
 * Rejecting traversal is deliberate: lexical containment is the strongest statement this process
 * can make without asking the remote filesystem to reinterpret the path.
 */
export function validateRemoteWorkspace(runtime: NodeRuntimeInfo, workspace: string): RemoteWorkspaceValidation {
  const candidate = workspace.trim();
  const approvedRoot = runtime.approvedRoots.find(root => pathWithin(candidate, root, runtime.platform));
  if (!approvedRoot) throw new Error('Remote workspace is outside this node’s approved roots');
  return { nodeId: runtime.nodeId, workspace: candidate, approvedRoot };
}

async function requiredNode(registry: NodeRegistryIpcPort, id: string): Promise<NodeRegistrySnapshot> {
  const snapshot = await registry.get(id);
  if (!snapshot) throw new Error(`Remote node ${id} is not configured`);
  return snapshot;
}

async function assertSessionIdleForRebind(sessionId: string, sessions: NodeSessionRebindPort): Promise<RebindSessionView> {
  const session = await sessions.session(sessionId);
  if (!session) throw new Error('Session not found');
  if (session.origin?.kind === 'worker' || session.origin?.kind === 'helper') {
    throw new Error('Worker and helper sessions cannot change execution computers directly');
  }
  if (session.activeTurnId) throw new Error('Wait for the active turn to finish before changing execution computers');

  const pending = (await sessions.inputs()).some(entry =>
    (entry.sessionId === sessionId || entry.deliveredSessionId === sessionId) &&
    (entry.state === 'queued' || entry.state === 'browser' || entry.state === 'tool'));
  if (pending) throw new Error('Wait for queued or in-flight session input to finish before changing execution computers');

  if (sessions.inFlight(session.conversationId) > 0) {
    throw new Error('Wait for running tool calls to finish before changing execution computers');
  }
  if (sessions.backgroundRunning(sessionId).length > 0) {
    throw new Error('Stop or finish background command sessions before changing execution computers');
  }
  if (sessions.executionHandleCount(sessionId) > 0) {
    throw new Error('Close active remote process handles before changing execution computers');
  }
  if (session.conversationId && sessions.activeRun(session.conversationId)) {
    throw new Error('Finish or clear this chat’s active worker family before changing execution computers');
  }
  if (sessions.continuationOpen(sessionId)) {
    throw new Error('Finish or cancel Compact & Resume before changing execution computers');
  }
  return session;
}

async function rebindTarget(
  registry: NodeRegistryIpcPort,
  sessions: NodeSessionRebindPort,
  sessionId: string,
  nodeId: string,
  workspace: string | undefined
): Promise<Omit<ExecutionTarget, 'bindingVersion'>> {
  const snapshot = await requiredNode(registry, nodeId);
  if (snapshot.config.transport === 'local') {
    // Renderer paths are never trusted for local workspaces. A project binding, when present,
    // is resolved again by main through the approved-root sandbox and reduced to its virtual path.
    return {
      nodeId: snapshot.config.id,
      workspace: await sessions.localWorkspace(sessionId),
      nodeConfigVersion: snapshot.config.configVersion
    };
  }
  if (!snapshot.runtimeInfo || snapshot.state !== 'connected') {
    throw new Error(`Remote node ${snapshot.config.name} is not connected`);
  }
  if (!workspace?.trim()) throw new Error('Choose an approved remote workspace before rebinding this session');
  const validated = validateRemoteWorkspace(snapshot.runtimeInfo, workspace);
  return {
    nodeId: snapshot.config.id,
    workspace: validated.workspace,
    nodeConfigVersion: snapshot.config.configVersion
  };
}

/** Fixed renderer IPC surface for node configuration/lifecycle. */
export function registerNodesIpc(
  register: IpcRegister,
  registry: NodeRegistryIpcPort = nodeRegistry,
  sessions: NodeSessionRebindPort = defaultSessionRebindPort
): void {
  register('nodes:list', async () => (await registry.list()).map(rendererNodeView));

  register('nodes:save', async (payload): Promise<RendererNodeView> => {
    const parsed: RemoteNodeSaveRequest = saveNodeArg.parse(payload);
    await registry.upsertRemote({
      id: parsed.id,
      name: parsed.name,
      endpoint: parsed.endpoint,
      ...(parsed.expectedMachineId?.trim() ? { expectedMachineId: parsed.expectedMachineId } : {})
    }, parsed.token);
    return rendererNodeView(await requiredNode(registry, parsed.id.trim()));
  });

  register('nodes:remove', async (payload) => registry.removeRemote(nodeIdArg.parse(payload).id));

  register('nodes:test', async (payload): Promise<RendererNodeTestResult> => {
    const id = nodeIdArg.parse(payload).id;
    const runtimeInfo = await registry.testConnection(id);
    return { node: rendererNodeView(await requiredNode(registry, id)), runtimeInfo };
  });

  register('nodes:connect', async (payload): Promise<RendererNodeView> => {
    const id = nodeIdArg.parse(payload).id;
    await registry.connect(id);
    return rendererNodeView(await requiredNode(registry, id));
  });

  register('nodes:disconnect', async (payload): Promise<RendererNodeView> => {
    const id = nodeIdArg.parse(payload).id;
    await registry.disconnect(id);
    return rendererNodeView(await requiredNode(registry, id));
  });

  register('nodes:validateWorkspace', async (payload): Promise<RemoteWorkspaceValidation> => {
    const { nodeId, workspace } = workspaceArg.parse(payload);
    const snapshot = await requiredNode(registry, nodeId);
    if (snapshot.config.transport !== 'remote-stdio-ws') throw new Error('Choose a remote node for a remote workspace');
    if (!snapshot.runtimeInfo || snapshot.state !== 'connected') {
      throw new Error('Connect this remote node before choosing a workspace');
    }
    return validateRemoteWorkspace(snapshot.runtimeInfo, workspace);
  });

  register('nodes:rebindSession', async (payload): Promise<ExecutionTarget> => {
    const { sessionId, nodeId, workspace } = rebindArg.parse(payload);
    // All safety gates live in main. The first pass rejects quickly; the second pass runs after
    // node/workspace resolution so state that changed while validation awaited is refused too.
    await assertSessionIdleForRebind(sessionId, sessions);
    await rebindTarget(registry, sessions, sessionId, nodeId, workspace);
    await assertSessionIdleForRebind(sessionId, sessions);
    const target = await rebindTarget(registry, sessions, sessionId, nodeId, workspace);
    return sessions.bind(sessionId, target);
  });
}
