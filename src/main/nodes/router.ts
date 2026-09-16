import { randomUUID } from 'node:crypto';
import {
  LOCAL_NODE_CONFIG_VERSION,
  LOCAL_NODE_ID,
  type ExecutionSnapshot,
  type ExecutionTarget,
  type NodeErrorCode
} from '../../shared/nodes.js';
import { getSession } from '../session/store.js';
import type { CallContext } from '../mcp/call-context.js';
import type { SurfaceId } from '../mcp/surfaces.js';
import { nodeRegistry, NodeRegistryError, type NodeRegistrySnapshot } from './registry.js';

/**
 * P1 starts with one executable backend: the process already hosting CoS.
 * The instance id is deliberately process-scoped. Restoring a frozen snapshot after a
 * restart must never pretend it still names the same executor instance.
 */
const LOCAL_MACHINE_ID = 'local';
const LOCAL_AGENT_INSTANCE_ID = randomUUID();

export class ExecutionRouterError extends Error {
  constructor(readonly code: NodeErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'ExecutionRouterError';
  }
}

/** Built-in target used until the node registry/UI can select another configured node. */
export function localExecutionTarget(workspace: string | null = null, bindingVersion = 1): ExecutionTarget {
  return {
    nodeId: LOCAL_NODE_ID,
    workspace,
    bindingVersion,
    nodeConfigVersion: LOCAL_NODE_CONFIG_VERSION
  };
}

/** Freeze one input against the exact local executor instance that accepted it. */
export function freezeLocalExecution(
  target: ExecutionTarget,
  sessionId: string,
  inputId: string
): ExecutionSnapshot {
  if (target.nodeId !== LOCAL_NODE_ID) {
    throw new ExecutionRouterError('NODE_OFFLINE', 'remote execution is not enabled in this build; the input was not retargeted to this computer');
  }
  if (target.nodeConfigVersion !== LOCAL_NODE_CONFIG_VERSION) {
    throw changed('the built-in local node configuration epoch is invalid');
  }
  return {
    ...target,
    sessionId,
    inputId,
    machineId: LOCAL_MACHINE_ID,
    agentInstanceId: LOCAL_AGENT_INSTANCE_ID
  };
}

function registryFailure(error: unknown, fallback: NodeErrorCode = 'NODE_OFFLINE'): ExecutionRouterError {
  if (error instanceof NodeRegistryError) return new ExecutionRouterError(error.code, error.message.replace(/^[A-Z_]+:\s*/, ''));
  return new ExecutionRouterError(fallback, error instanceof Error ? error.message : String(error));
}

/**
 * Freezes one queued input against the exact executor instance that is ready now.
 *
 * A remote target is never implicitly connected here. Node selection and connection lifecycle are
 * explicit main-process actions; accepting an input only records an already-authenticated,
 * initialized and tool-discovered runtime. This keeps queueing from silently changing machines or
 * configuration revisions while a send is being prepared.
 */
export async function freezeExecution(
  target: ExecutionTarget,
  sessionId: string,
  inputId: string
): Promise<ExecutionSnapshot> {
  if (target.nodeId === LOCAL_NODE_ID) return freezeLocalExecution(target, sessionId, inputId);

  let snapshot: NodeRegistrySnapshot | null;
  try {
    snapshot = await nodeRegistry.get(target.nodeId);
  } catch (error) {
    throw registryFailure(error, 'TARGET_CONTEXT_UNRESOLVED');
  }
  if (!snapshot || snapshot.config.transport !== 'remote-stdio-ws') {
    throw new ExecutionRouterError('NODE_OFFLINE', `remote node ${target.nodeId} is not configured; the input was not retargeted`);
  }
  if (snapshot.config.configVersion !== target.nodeConfigVersion) {
    throw changed(`remote node ${target.nodeId} configuration changed before this input could be frozen`);
  }
  if (snapshot.error?.code === 'AUTH_FAILED' || snapshot.error?.code === 'NODE_IDENTITY_MISMATCH') {
    throw new ExecutionRouterError(snapshot.error.code, snapshot.error.message.replace(/^[A-Z_]+:\s*/, ''));
  }
  const connection = await nodeRegistry.currentConnection(target.nodeId);
  const runtime = connection?.runtimeInfo ?? null;
  if (!connection || !runtime) {
    throw new ExecutionRouterError('NODE_OFFLINE', `remote node ${target.nodeId} is not ready; no local fallback was attempted`);
  }
  if (runtime.nodeId !== target.nodeId ||
      (snapshot.config.expectedMachineId && runtime.machineId !== snapshot.config.expectedMachineId)) {
    throw new ExecutionRouterError('NODE_IDENTITY_MISMATCH', `remote node ${target.nodeId} runtime identity does not match its configured machine`);
  }
  return {
    ...target,
    sessionId,
    inputId,
    machineId: runtime.machineId,
    agentInstanceId: runtime.agentInstanceId
  };
}

const CORE_COMPUTER_TOOLS = new Set([
  'read',
  'view_image',
  'find',
  'apply_patch',
  'exec_command',
  'write_stdin',
  'download_artifact'
]);

export function routesComputerTool(surface: SurfaceId, name: string): boolean {
  if (surface === 'desktop') return true;
  return surface === 'core' && CORE_COMPUTER_TOOLS.has(name);
}

/**
 * Top-level calls that should acquire the exact frozen input snapshot before execution begins.
 * `exec` itself is not a computer mutation, but code-mode children must inherit one already
 * resolved authority instead of independently resolving a target midway through the script.
 */
function spawnsWorker(surface: SurfaceId, name: string, args: unknown): boolean {
  return surface === 'core' && name === 'agents' && !!args && typeof args === 'object' && (args as { action?: string }).action === 'spawn';
}

export function requiresExecutionContext(surface: SurfaceId, name: string, args?: unknown): boolean {
  return routesComputerTool(surface, name) || spawnsWorker(surface, name, args) || ((surface === 'core' || surface === 'desktop') && name === 'exec');
}

function changed(detail: string): ExecutionRouterError {
  return new ExecutionRouterError('TARGET_CHANGED', detail);
}

/**
 * Admission fence for the stable model-facing computer tools.
 *
 * Exact request -> input snapshot resolution happens in the kernel before any top-level
 * computer handler is admitted. This function therefore never reconstructs authority from the
 * session's current target: missing frozen authority is an error even when that current target
 * happens to be local. Nested code-mode calls arrive with the parent's already-frozen snapshot.
 */
export async function executionAdmission(
  context: CallContext,
  surface: SurfaceId,
  name: string,
  args?: unknown
): Promise<ExecutionRouterError | null> {
  if (!routesComputerTool(surface, name) && !spawnsWorker(surface, name, args)) return null;

  const execution = context.execution;
  const sessionId = context.caller.sessionId;
  if (!execution || !sessionId || !context.caller.conversationId) {
    return new ExecutionRouterError(
      'TARGET_CONTEXT_UNRESOLVED',
      'this call has no exact frozen input target; no local fallback was attempted'
    );
  }
  if (sessionId !== execution.sessionId) {
    return changed('the proven session does not own this frozen execution snapshot');
  }
  const session = await getSession(execution.sessionId);
  const target = session?.executionTarget;
  if (!session || !target) return changed('the frozen execution session or target is unavailable');
  if (target.nodeId !== execution.nodeId || target.workspace !== execution.workspace ||
      target.bindingVersion !== execution.bindingVersion || target.nodeConfigVersion !== execution.nodeConfigVersion) {
    return changed('the session target changed after this input was frozen');
  }
  if (execution.nodeId === LOCAL_NODE_ID) {
    if (execution.nodeConfigVersion !== LOCAL_NODE_CONFIG_VERSION) {
      return changed('the built-in local node configuration epoch no longer matches the frozen input');
    }
    if (execution.machineId !== LOCAL_MACHINE_ID || execution.agentInstanceId !== LOCAL_AGENT_INSTANCE_ID) {
      return changed('the local executor instance changed after this input was frozen');
    }
    return null;
  }

  let registered: NodeRegistrySnapshot | null;
  try {
    registered = await nodeRegistry.get(execution.nodeId);
  } catch (error) {
    return registryFailure(error, 'TARGET_CONTEXT_UNRESOLVED');
  }
  if (!registered || registered.config.transport !== 'remote-stdio-ws') {
    return new ExecutionRouterError('NODE_OFFLINE', `remote node ${execution.nodeId} is no longer configured; no local fallback was attempted`);
  }
  if (registered.config.configVersion !== execution.nodeConfigVersion) {
    return changed(`remote node ${execution.nodeId} configuration changed after this input was frozen`);
  }
  if (registered.error?.code === 'AUTH_FAILED' || registered.error?.code === 'NODE_IDENTITY_MISMATCH') {
    return new ExecutionRouterError(registered.error.code, registered.error.message.replace(/^[A-Z_]+:\s*/, ''));
  }
  const connection = await nodeRegistry.currentConnection(execution.nodeId);
  const runtime = connection?.runtimeInfo ?? null;
  if (!connection || !runtime) {
    return new ExecutionRouterError('NODE_OFFLINE', `remote node ${execution.nodeId} is not connected to the frozen executor instance; no local fallback was attempted`);
  }
  if (runtime.machineId !== execution.machineId || runtime.nodeId !== execution.nodeId) {
    return new ExecutionRouterError('NODE_IDENTITY_MISMATCH', `remote node ${execution.nodeId} no longer identifies the frozen machine`);
  }
  if (runtime.agentInstanceId !== execution.agentInstanceId) {
    return changed(`remote node ${execution.nodeId} restarted or reconnected after this input was frozen`);
  }
  return null;
}

/** Test/debug seam; never use this value as a model-visible selector. */
export function localExecutionIdentity(): { machineId: string; agentInstanceId: string } {
  return { machineId: LOCAL_MACHINE_ID, agentInstanceId: LOCAL_AGENT_INSTANCE_ID };
}
