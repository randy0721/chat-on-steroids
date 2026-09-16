import { z } from 'zod';

/** Stable client-owned identity for one execution computer. */
export type NodeId = string;
export type Platform = 'win32' | 'darwin' | 'linux';

export const LOCAL_NODE_ID = 'local';
export const LOCAL_NODE_CONFIG_VERSION = 1;

export const nodeConfigSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(160),
  transport: z.enum(['local', 'remote-stdio-ws']),
  endpoint: z.string().max(4096).optional(),
  credentialRef: z.string().max(256).optional(),
  expectedMachineId: z.string().max(256).optional(),
  configVersion: z.number().int().positive()
}).strict();

export type NodeConfig = z.infer<typeof nodeConfigSchema>;

export const nodeRuntimeInfoSchema = z.object({
  nodeId: z.string().min(1).max(128),
  machineId: z.string().min(1).max(256),
  agentInstanceId: z.string().min(1).max(256),
  platform: z.enum(['win32', 'darwin', 'linux']),
  defaultShell: z.string().max(4096),
  approvedRoots: z.array(z.string().max(32768)).max(256),
  capabilities: z.array(z.string().min(1).max(128)).max(256),
  protocolVersion: z.number().int().nonnegative()
}).strict();

export type NodeRuntimeInfo = z.infer<typeof nodeRuntimeInfoSchema>;

export const executionTargetSchema = z.object({
  nodeId: z.string().min(1).max(128),
  workspace: z.string().max(32768).nullable(),
  bindingVersion: z.number().int().positive(),
  nodeConfigVersion: z.number().int().positive()
}).strict();

export type ExecutionTarget = z.infer<typeof executionTargetSchema>;

export const executionSnapshotSchema = executionTargetSchema.extend({
  sessionId: z.string().min(8).max(64),
  inputId: z.string().uuid(),
  machineId: z.string().min(1).max(256),
  agentInstanceId: z.string().min(1).max(256)
}).strict();

export type ExecutionSnapshot = z.infer<typeof executionSnapshotSchema>;

export const executionHandleSchema = z.object({
  id: z.string().min(1).max(256),
  sessionId: z.string().min(8).max(64),
  nodeId: z.string().min(1).max(128),
  bindingVersion: z.number().int().positive(),
  agentInstanceId: z.string().min(1).max(256),
  remoteHandle: z.string().min(1).max(1024)
}).strict();

export type ExecutionHandle = z.infer<typeof executionHandleSchema>;

export type NodeErrorCode =
  | 'TARGET_CONTEXT_UNRESOLVED'
  | 'TARGET_CHANGED'
  | 'NODE_OFFLINE'
  | 'AUTH_FAILED'
  | 'NODE_IDENTITY_MISMATCH'
  | 'CAPABILITY_UNAVAILABLE'
  | 'HANDLE_EXPIRED'
  | 'EXECUTION_STATUS_UNKNOWN'
  | 'REMOTE_TOOL_ERROR';
