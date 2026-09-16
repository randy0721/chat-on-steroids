import { describe, expect, it } from 'vitest';
import {
  registerNodesIpc,
  rendererNodeView,
  validateRemoteWorkspace,
  type NodeRegistryIpcPort,
  type NodeSessionRebindPort
} from '../src/main/nodes-ipc.js';
import type { ExecutionTarget, NodeRuntimeInfo } from '../src/shared/nodes.js';
import type { NodeRegistrySnapshot, RemoteNodeInput } from '../src/main/nodes/registry.js';

const windowsRuntime = (nodeId = 'office'): NodeRuntimeInfo => ({
  nodeId,
  machineId: 'office-machine',
  agentInstanceId: 'office-agent',
  platform: 'win32',
  defaultShell: 'powershell.exe',
  approvedRoots: ['D:\\work', 'C:\\shared'],
  capabilities: ['read', 'exec_command'],
  protocolVersion: 1
});

function remoteSnapshot(overrides: Partial<NodeRegistrySnapshot> = {}): NodeRegistrySnapshot {
  return {
    config: {
      id: 'office',
      name: 'Office PC',
      transport: 'remote-stdio-ws',
      endpoint: 'wss://office.example/node',
      credentialRef: 'setup:node:raw-secret-reference:7',
      expectedMachineId: 'office-machine',
      configVersion: 7
    },
    state: 'disconnected',
    runtimeInfo: null,
    error: null,
    ...overrides
  };
}

function ipcHarness(sessionOverrides: Partial<NodeSessionRebindPort> = {}) {
  const snapshots = new Map<string, NodeRegistrySnapshot>([
    ['local', {
      config: { id: 'local', name: 'This computer', transport: 'local', configVersion: 1 },
      state: 'local', runtimeInfo: null, error: null
    }],
    ['office', remoteSnapshot()]
  ]);
  const receivedTokens: Array<string | undefined> = [];
  const boundTargets: Array<Omit<ExecutionTarget, 'bindingVersion'>> = [];
  let bindingVersion = 4;
  const registry: NodeRegistryIpcPort = {
    list: async () => [...snapshots.values()],
    get: async id => snapshots.get(id) ?? null,
    upsertRemote: async (input: RemoteNodeInput, token?: string) => {
      receivedTokens.push(token);
      const previous = snapshots.get(input.id);
      snapshots.set(input.id, remoteSnapshot({
        config: {
          id: input.id,
          name: input.name,
          transport: 'remote-stdio-ws',
          endpoint: input.endpoint,
          credentialRef: previous?.config.credentialRef ?? 'setup:node:new-secret-reference:8',
          ...(input.expectedMachineId ? { expectedMachineId: input.expectedMachineId } : {}),
          configVersion: (previous?.config.configVersion ?? 7) + 1
        }
      }));
      return snapshots.get(input.id)!.config;
    },
    removeRemote: async id => snapshots.delete(id),
    testConnection: async id => windowsRuntime(id),
    connect: async id => {
      snapshots.set(id, remoteSnapshot({ state: 'connected', runtimeInfo: windowsRuntime(id) }));
      return {};
    },
    disconnect: async id => {
      snapshots.set(id, remoteSnapshot({ state: 'disconnected', runtimeInfo: null }));
    }
  };
  const sessions: NodeSessionRebindPort = {
    session: async id => ({
      id,
      conversationId: 'conversation-1234',
      activeTurnId: null,
      origin: { kind: 'desktop' }
    }),
    inputs: async () => [],
    inFlight: () => 0,
    backgroundRunning: () => [],
    executionHandleCount: () => 0,
    activeRun: () => null,
    continuationOpen: () => false,
    localWorkspace: async () => '/project',
    bind: async (_id, target) => {
      boundTargets.push({ ...target });
      return { ...target, bindingVersion: ++bindingVersion };
    },
    ...sessionOverrides
  };
  const handlers = new Map<string, (payload?: unknown) => Promise<unknown>>();
  const register = (<T>(channel: string, handler: (payload: unknown) => Promise<T>) => {
    handlers.set(channel, handler);
  });
  registerNodesIpc(register, registry, sessions);
  const invoke = <T>(channel: string, payload?: unknown): Promise<T> => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing IPC handler ${channel}`);
    return handler(payload) as Promise<T>;
  };
  return { handlers, invoke, receivedTokens, boundTargets };
}

describe('node renderer IPC', () => {
  it('projects credential state without ever returning token or raw credentialRef', async () => {
    const view = rendererNodeView(remoteSnapshot());
    expect(view).toMatchObject({ id: 'office', credentialConfigured: true, status: 'disconnected' });
    expect(view).not.toHaveProperty('credentialRef');
    expect(JSON.stringify(view)).not.toContain('raw-secret-reference');

    const { invoke, receivedTokens } = ipcHarness();
    const saved = await invoke<Record<string, unknown>>('nodes:save', {
      id: 'office', name: 'Office renamed', endpoint: 'wss://office.example/node', token: 'TOP_SECRET_TOKEN'
    });
    expect(receivedTokens).toEqual(['TOP_SECRET_TOKEN']);
    expect(saved).toMatchObject({ id: 'office', name: 'Office renamed', credentialConfigured: true });
    expect(JSON.stringify(saved)).not.toContain('TOP_SECRET_TOKEN');
    expect(JSON.stringify(saved)).not.toContain('credentialRef');

    const listed = await invoke<unknown[]>('nodes:list');
    expect(JSON.stringify(listed)).not.toContain('raw-secret-reference');
    expect(JSON.stringify(listed)).not.toContain('credentialRef');
  });

  it('exposes fixed CRUD/test/connect/disconnect channels with safe lifecycle results', async () => {
    const { handlers, invoke } = ipcHarness();
    expect([...handlers.keys()]).toEqual([
      'nodes:list', 'nodes:save', 'nodes:remove', 'nodes:test', 'nodes:connect', 'nodes:disconnect', 'nodes:validateWorkspace', 'nodes:rebindSession'
    ]);

    const tested = await invoke<{ runtimeInfo: NodeRuntimeInfo }>('nodes:test', { id: 'office' });
    expect(tested.runtimeInfo.machineId).toBe('office-machine');
    expect(await invoke('nodes:connect', { id: 'office' })).toMatchObject({ status: 'connected', runtimeInfo: { nodeId: 'office' } });
    expect(await invoke('nodes:disconnect', { id: 'office' })).toMatchObject({ status: 'disconnected', runtimeInfo: null });
    expect(await invoke('nodes:remove', { id: 'office' })).toBe(true);
  });

  it('validates remote workspaces lexically against remote approvedRoots without host path resolution', async () => {
    expect(validateRemoteWorkspace(windowsRuntime(), 'D:\\work\\project')).toEqual({
      nodeId: 'office', workspace: 'D:\\work\\project', approvedRoot: 'D:\\work'
    });
    expect(validateRemoteWorkspace(windowsRuntime(), 'd:/WORK/project')).toMatchObject({ approvedRoot: 'D:\\work' });
    expect(() => validateRemoteWorkspace(windowsRuntime(), 'D:\\work\\..\\secret')).toThrow('parent traversal');
    expect(() => validateRemoteWorkspace(windowsRuntime(), 'D:\\elsewhere')).toThrow('outside');

    const linux: NodeRuntimeInfo = { ...windowsRuntime(), platform: 'linux', approvedRoots: ['/srv/work'] };
    expect(validateRemoteWorkspace(linux, '/srv/work/project')).toMatchObject({ approvedRoot: '/srv/work' });
    expect(() => validateRemoteWorkspace(linux, '/srv/Work/project')).toThrow('outside');

    const { invoke } = ipcHarness();
    await expect(invoke('nodes:validateWorkspace', { nodeId: 'office', workspace: 'D:\\work' }))
      .rejects.toThrow('Connect this remote node');
    await invoke('nodes:connect', { id: 'office' });
    await expect(invoke('nodes:validateWorkspace', { nodeId: 'office', workspace: 'D:\\work\\project' }))
      .resolves.toMatchObject({ approvedRoot: 'D:\\work' });
  });

  it('rebinds only after main derives local workspace or validates the connected remote workspace', async () => {
    const { invoke, boundTargets } = ipcHarness();
    const local = await invoke<ExecutionTarget>('nodes:rebindSession', {
      sessionId: 'session-abcd1234', nodeId: 'local', workspace: '/renderer/must-not-win'
    });
    expect(local).toEqual({ nodeId: 'local', workspace: '/project', nodeConfigVersion: 1, bindingVersion: 5 });
    expect(boundTargets[0]).toEqual({ nodeId: 'local', workspace: '/project', nodeConfigVersion: 1 });

    await invoke('nodes:connect', { id: 'office' });
    const remote = await invoke<ExecutionTarget>('nodes:rebindSession', {
      sessionId: 'session-abcd1234', nodeId: 'office', workspace: 'D:\\work\\repo'
    });
    expect(remote).toEqual({ nodeId: 'office', workspace: 'D:\\work\\repo', nodeConfigVersion: 7, bindingVersion: 6 });
    expect(remote.bindingVersion).toBeGreaterThan(local.bindingVersion);

    await expect(invoke('nodes:rebindSession', {
      sessionId: 'session-abcd1234', nodeId: 'office', workspace: 'D:\\outside'
    })).rejects.toThrow('outside');
    expect(boundTargets).toHaveLength(2);
  });

  it.each([
    ['active turn', { session: async (id: string) => ({ id, conversationId: 'conversation-1234', activeTurnId: 'turn-1', origin: { kind: 'desktop' as const } }) }, 'active turn'],
    ['queued input', { inputs: async () => [{ sessionId: 'session-abcd1234', state: 'queued' }] }, 'queued or in-flight session input'],
    ['browser input', { inputs: async () => [{ sessionId: 'session-abcd1234', state: 'browser' }] }, 'queued or in-flight session input'],
    ['tool input', { inputs: async () => [{ sessionId: null, deliveredSessionId: 'session-abcd1234', state: 'tool' }] }, 'queued or in-flight session input'],
    ['in-flight tool call', { inFlight: () => 1 }, 'running tool calls'],
    ['background process', { backgroundRunning: () => [77] }, 'background command sessions'],
    ['remote execution handle', { executionHandleCount: () => 1 }, 'remote process handles'],
    ['active worker family', { activeRun: () => 'run-1' }, 'active worker family'],
    ['open continuation', { continuationOpen: () => true }, 'Compact & Resume'],
    ['worker session', { session: async (id: string) => ({ id, conversationId: 'worker-chat', activeTurnId: null, origin: { kind: 'worker' as const } }) }, 'Worker and helper sessions'],
    ['helper session', { session: async (id: string) => ({ id, conversationId: 'helper-chat', activeTurnId: null, origin: { kind: 'helper' as const } }) }, 'Worker and helper sessions']
  ] as const)('server rejects rebind while %s is present', async (_label, overrides, message) => {
    const { invoke, boundTargets } = ipcHarness(overrides as Partial<NodeSessionRebindPort>);
    await expect(invoke('nodes:rebindSession', { sessionId: 'session-abcd1234', nodeId: 'local' }))
      .rejects.toThrow(message);
    expect(boundTargets).toHaveLength(0);
  });

  it('checks idle again after target validation before committing the new binding', async () => {
    let reads = 0;
    const { invoke, boundTargets } = ipcHarness({
      session: async id => ({
        id,
        conversationId: 'conversation-1234',
        activeTurnId: ++reads >= 2 ? 'turn-started-during-validation' : null,
        origin: { kind: 'desktop' }
      })
    });
    await expect(invoke('nodes:rebindSession', { sessionId: 'session-abcd1234', nodeId: 'local' }))
      .rejects.toThrow('active turn');
    expect(boundTargets).toHaveLength(0);
  });
});
