import { createHash } from 'node:crypto';
import {
  LOCAL_NODE_CONFIG_VERSION,
  LOCAL_NODE_ID,
  nodeConfigSchema,
  type NodeConfig,
  type NodeErrorCode,
  type NodeRuntimeInfo
} from '../../shared/nodes.js';
import { readDurable, writeDurableNow } from '../durable.js';
import { clearSecret, getSecret, setSecret, type SecretKey } from '../secrets.js';
import {
  connectRemoteNode,
  RemoteNodeConnectionError,
  type RemoteNodeConnection,
  type RemoteNodeConnectionErrorCode,
  type RemoteNodeConnectionOptions
} from './connection.js';

const STATE_NAME = 'node-registry';
const STATE_VERSION = 1;
const CREDENTIAL_PREFIX = 'setup:node:';
const LOCAL_NODE: NodeConfig = Object.freeze({
  id: LOCAL_NODE_ID,
  name: 'This computer',
  transport: 'local',
  configVersion: LOCAL_NODE_CONFIG_VERSION
});

interface PersistedNodeRegistry {
  version: typeof STATE_VERSION;
  /** Highest remote configuration epoch ever durably assigned, including removed nodes. */
  lastConfigVersion: number;
  /** Local is built in and is never serialized here. */
  nodes: NodeConfig[];
}

export interface RemoteNodeInput {
  id: string;
  name: string;
  endpoint: string;
  expectedMachineId?: string;
}

export type NodeConnectionState = 'local' | 'disconnected' | 'connecting' | 'connected' | 'error';

export interface NodeStatusError {
  code: NodeErrorCode | RemoteNodeConnectionErrorCode;
  message: string;
}

export interface NodeRegistrySnapshot {
  config: NodeConfig;
  state: NodeConnectionState;
  runtimeInfo: NodeRuntimeInfo | null;
  error: NodeStatusError | null;
}

export class NodeRegistryError extends Error {
  constructor(readonly code: NodeErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'NodeRegistryError';
  }
}

type ConnectRemote = (options: RemoteNodeConnectionOptions) => Promise<RemoteNodeConnection>;
type GetSecret = (key: SecretKey) => Promise<string | null>;
type SetSecret = (key: SecretKey, value: string) => Promise<void>;
type ClearSecret = (key: SecretKey) => Promise<void>;

export interface NodeRegistryDependencies {
  connectRemote?: ConnectRemote;
  getSecret?: GetSecret;
  setSecret?: SetSecret;
  clearSecret?: ClearSecret;
}

interface LiveNode {
  epoch: number;
  connection: RemoteNodeConnection | null;
  connecting: Promise<RemoteNodeConnection> | null;
  state: Exclude<NodeConnectionState, 'local'>;
  error: NodeStatusError | null;
  /** Serializes the final execution check/dispatch boundary with connection invalidation. */
  operation: Promise<void>;
}

export interface ExecutionConnectionExpectation {
  nodeId: string;
  nodeConfigVersion: number;
  machineId: string;
  agentInstanceId: string;
}

function cloneConfig(config: NodeConfig): NodeConfig {
  return { ...config };
}

function cloneRuntime(info: NodeRuntimeInfo | null): NodeRuntimeInfo | null {
  return info
    ? { ...info, approvedRoots: [...info.approvedRoots], capabilities: [...info.capabilities] }
    : null;
}

function statusError(error: unknown): NodeStatusError {
  if (error instanceof RemoteNodeConnectionError) return { code: error.code, message: error.message };
  if (error instanceof NodeRegistryError) return { code: error.code, message: error.message };
  return { code: 'NODE_OFFLINE', message: error instanceof Error ? error.message : String(error) };
}

function credentialRef(nodeId: string, configVersion: number): SecretKey {
  // The shared NodeId contract allows arbitrary UTF-8. Hash the id so even a 128-character
  // non-ASCII name cannot expand an encoded secret key beyond NodeConfig.credentialRef's bound.
  const digest = createHash('sha256').update(nodeId, 'utf8').digest('hex').slice(0, 32);
  return `${CREDENTIAL_PREFIX}${digest}:${configVersion}` as SecretKey;
}

function isNodeCredentialRef(value: string | undefined): value is SecretKey {
  return typeof value === 'string' && value.startsWith(CREDENTIAL_PREFIX) && value.length <= 256;
}

function remoteEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new NodeRegistryError('TARGET_CONTEXT_UNRESOLVED', 'remote node endpoint is invalid');
  }
  if (endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:') {
    throw new NodeRegistryError('TARGET_CONTEXT_UNRESOLVED', 'remote node endpoint must use ws:// or wss://');
  }
  return endpoint.href;
}

function parsePersisted(value: unknown): PersistedNodeRegistry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NodeRegistryError('TARGET_CONTEXT_UNRESOLVED', 'durable node registry is malformed');
  }
  const raw = value as Partial<PersistedNodeRegistry>;
  if (raw.version !== STATE_VERSION || !Number.isSafeInteger(raw.lastConfigVersion) || (raw.lastConfigVersion ?? -1) < 0 || !Array.isArray(raw.nodes)) {
    throw new NodeRegistryError('TARGET_CONTEXT_UNRESOLVED', 'durable node registry version or epoch is invalid');
  }
  const seen = new Set<string>();
  const nodes = raw.nodes.map((item) => {
    const parsed = nodeConfigSchema.safeParse(item);
    if (!parsed.success || parsed.data.id === LOCAL_NODE_ID || parsed.data.transport !== 'remote-stdio-ws' ||
        !parsed.data.endpoint || !isNodeCredentialRef(parsed.data.credentialRef) || seen.has(parsed.data.id)) {
      throw new NodeRegistryError('TARGET_CONTEXT_UNRESOLVED', 'durable node registry contains an invalid remote node');
    }
    remoteEndpoint(parsed.data.endpoint);
    seen.add(parsed.data.id);
    return parsed.data;
  });
  const maxVersion = nodes.reduce((max, node) => Math.max(max, node.configVersion), 0);
  if ((raw.lastConfigVersion as number) < maxVersion) {
    throw new NodeRegistryError('TARGET_CONTEXT_UNRESOLVED', 'durable node registry config epoch moved backwards');
  }
  return { version: STATE_VERSION, lastConfigVersion: raw.lastConfigVersion as number, nodes };
}

/**
 * Main-process authority for execution-node configuration and live connection status.
 *
 * Remote credentials never enter the durable state. The durable row contains only a namespaced
 * secret reference, while the token itself stays in the OS-backed secrets store. A remote node
 * is never selected implicitly: every lifecycle method takes one exact node id and there is no
 * failover or reconnect loop in this owner.
 */
export class NodeRegistry {
  private readonly connectRemote: ConnectRemote;
  private readonly readSecret: GetSecret;
  private readonly writeSecret: SetSecret;
  private readonly removeSecret: ClearSecret;
  private configs = new Map<string, NodeConfig>();
  private live = new Map<string, LiveNode>();
  private lastConfigVersion = 0;
  private loaded = false;
  private loading: Promise<void> | null = null;
  private mutation: Promise<void> = Promise.resolve();

  constructor(dependencies: NodeRegistryDependencies = {}) {
    this.connectRemote = dependencies.connectRemote ?? connectRemoteNode;
    this.readSecret = dependencies.getSecret ?? getSecret;
    this.writeSecret = dependencies.setSecret ?? setSecret;
    this.removeSecret = dependencies.clearSecret ?? clearSecret;
  }

  async initialize(): Promise<void> {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    const load = (async () => {
      const raw = await readDurable<unknown>(STATE_NAME);
      const restored = raw === null
        ? { version: STATE_VERSION, lastConfigVersion: 0, nodes: [] } satisfies PersistedNodeRegistry
        : parsePersisted(raw);
      this.configs = new Map(restored.nodes.map(node => [node.id, cloneConfig(node)]));
      this.lastConfigVersion = restored.lastConfigVersion;
      this.loaded = true;
    })();
    this.loading = load;
    try {
      await load;
    } finally {
      if (this.loading === load) this.loading = null;
    }
  }

  async list(): Promise<NodeRegistrySnapshot[]> {
    await this.initialize();
    return [this.localSnapshot(), ...[...this.configs.values()].map(config => this.snapshotFor(config))];
  }

  async get(nodeId: string): Promise<NodeRegistrySnapshot | null> {
    await this.initialize();
    if (nodeId === LOCAL_NODE_ID) return this.localSnapshot();
    const config = this.configs.get(nodeId);
    return config ? this.snapshotFor(config) : null;
  }

  async getConfig(nodeId: string): Promise<NodeConfig | null> {
    return (await this.get(nodeId))?.config ?? null;
  }

  /**
   * Creates or edits one remote node. New nodes require a credential. Existing nodes retain their
   * current credential unless `token` is supplied. Any accepted change receives a new durable
   * configVersion before it becomes visible in memory.
   */
  async upsertRemote(input: RemoteNodeInput, token?: string): Promise<NodeConfig> {
    await this.initialize();
    return this.serializeMutation(() => this.upsertRemoteLocked(this.normalizeInput(input), token));
  }

  async setCredential(nodeId: string, token: string): Promise<NodeConfig> {
    await this.initialize();
    return this.serializeMutation(async () => {
      // Read only after earlier registry mutations have committed. Capturing this row before
      // entering the mutation queue could make a credential-only edit overwrite a newer endpoint
      // or display name with a stale snapshot.
      const current = this.configs.get(nodeId);
      if (!current || current.transport !== 'remote-stdio-ws' || !current.endpoint) {
        throw new NodeRegistryError('NODE_OFFLINE', `remote node ${nodeId} is not configured`);
      }
      return this.upsertRemoteLocked(this.normalizeInput({
        id: current.id,
        name: current.name,
        endpoint: current.endpoint,
        ...(current.expectedMachineId ? { expectedMachineId: current.expectedMachineId } : {})
      }), token);
    });
  }

  async removeRemote(nodeId: string): Promise<boolean> {
    await this.initialize();
    if (nodeId === LOCAL_NODE_ID) throw new NodeRegistryError('TARGET_CHANGED', 'the built-in local node cannot be removed');
    return this.serializeMutation(async () => {
      const previous = this.configs.get(nodeId);
      if (!previous) return false;
      // Clearing first is the safer cross-store partial failure: if the durable write then fails,
      // the node stays configured but cannot authenticate. The opposite order could orphan a live
      // credential with no remaining registry row from which a retry could discover it.
      if (isNodeCredentialRef(previous.credentialRef)) await this.removeSecret(previous.credentialRef);
      await this.persist([...this.configs.values()].filter(node => node.id !== nodeId), this.lastConfigVersion);
      this.configs.delete(nodeId);
      await this.invalidate(nodeId);
      this.live.delete(nodeId);
      return true;
    });
  }

  /** Opens one exact configured node. Concurrent callers share only this node's in-flight connect. */
  async connect(nodeId: string): Promise<RemoteNodeConnection> {
    await this.initialize();
    if (nodeId === LOCAL_NODE_ID) throw new NodeRegistryError('CAPABILITY_UNAVAILABLE', 'the built-in local node does not use RemoteNodeConnection');
    const config = this.configs.get(nodeId);
    if (!config) throw new NodeRegistryError('NODE_OFFLINE', `remote node ${nodeId} is not configured`);
    const live = this.liveFor(nodeId);
    if (live.connection?.runtimeInfo) {
      live.state = 'connected';
      live.error = null;
      return live.connection;
    }
    if (live.connection) {
      live.connection = null;
      live.state = 'disconnected';
    }
    if (live.connecting) return live.connecting;

    const epoch = live.epoch;
    const configVersion = config.configVersion;
    let attempt!: Promise<RemoteNodeConnection>;
    attempt = (async () => {
      live.state = 'connecting';
      live.error = null;
      try {
        const connection = await this.open(config);
        const current = this.configs.get(nodeId);
        if (!current || current.configVersion !== configVersion || live.epoch !== epoch) {
          await connection.close().catch(() => undefined);
          if (!current || current.configVersion !== configVersion) {
            throw new NodeRegistryError('TARGET_CHANGED', `node ${nodeId} changed while its connection was opening`);
          }
          throw new NodeRegistryError('NODE_OFFLINE', `node ${nodeId} connection was cancelled`);
        }
        live.connection = connection;
        live.state = 'connected';
        live.error = null;
        return connection;
      } catch (error) {
        if (live.epoch === epoch && this.configs.get(nodeId)?.configVersion === configVersion) {
          live.connection = null;
          live.state = 'error';
          live.error = statusError(error);
        }
        throw error;
      } finally {
        if (live.connecting === attempt) live.connecting = null;
      }
    })();
    live.connecting = attempt;
    return attempt;
  }

  /**
   * Performs a fresh auth + HELLO + MCP initialize + tools/list probe and always closes it. It
   * does not replace a live connection and therefore cannot accidentally retarget current work.
   */
  async testConnection(nodeId: string): Promise<NodeRuntimeInfo> {
    await this.initialize();
    if (nodeId === LOCAL_NODE_ID) throw new NodeRegistryError('CAPABILITY_UNAVAILABLE', 'the built-in local node has no remote connection to test');
    const config = this.configs.get(nodeId);
    if (!config) throw new NodeRegistryError('NODE_OFFLINE', `remote node ${nodeId} is not configured`);
    const configVersion = config.configVersion;
    const connection = await this.open(config);
    try {
      const runtime = connection.runtimeInfo;
      if (!runtime) throw new NodeRegistryError('NODE_OFFLINE', `node ${nodeId} disconnected before its runtime information was available`);
      if (this.configs.get(nodeId)?.configVersion !== configVersion) {
        throw new NodeRegistryError('TARGET_CHANGED', `node ${nodeId} changed while its connection test was running`);
      }
      return cloneRuntime(runtime)!;
    } finally {
      await connection.close().catch(() => undefined);
    }
  }

  async disconnect(nodeId: string): Promise<void> {
    await this.initialize();
    if (nodeId === LOCAL_NODE_ID) return;
    if (!this.configs.has(nodeId)) throw new NodeRegistryError('NODE_OFFLINE', `remote node ${nodeId} is not configured`);
    await this.invalidate(nodeId);
  }

  /** Returns an already-connected exact node only; it never starts or fails over to another one. */
  async currentConnection(nodeId: string): Promise<RemoteNodeConnection | null> {
    await this.initialize();
    const live = this.live.get(nodeId);
    if (!live?.connection) return null;
    if (!live.connection.runtimeInfo) {
      const transportError = live.connection.transport.lastError;
      live.connection = null;
      live.state = transportError ? 'error' : 'disconnected';
      live.error = transportError ? statusError(transportError) : null;
      return null;
    }
    return live.connection;
  }

  /**
   * Runs one already-frozen execution against the exact ready connection it named.
   *
   * The per-node operation queue is deliberately held through the callback. Config edits and
   * disconnects use the same queue, so they cannot close/replace the connection in the gap between
   * this final identity check and handing the MCP request to that connection. There is no implicit
   * connect, reconnect, failover or replay here.
   */
  async withExecutionConnection<T>(
    expected: ExecutionConnectionExpectation,
    fn: (connection: RemoteNodeConnection, runtime: NodeRuntimeInfo) => Promise<T>
  ): Promise<T> {
    await this.initialize();
    if (expected.nodeId === LOCAL_NODE_ID) {
      throw new NodeRegistryError('CAPABILITY_UNAVAILABLE', 'the built-in local node has no remote execution connection');
    }
    return this.serializeLive(expected.nodeId, async () => {
      const config = this.configs.get(expected.nodeId);
      if (!config) throw new NodeRegistryError('NODE_OFFLINE', `remote node ${expected.nodeId} is not configured`);
      if (config.configVersion !== expected.nodeConfigVersion) {
        throw new NodeRegistryError('TARGET_CHANGED', `node ${expected.nodeId} configuration changed after the input was frozen`);
      }
      const live = this.live.get(expected.nodeId);
      const connection = live?.connection ?? null;
      const runtime = connection?.runtimeInfo ?? null;
      if (!connection || !runtime) {
        throw new NodeRegistryError('NODE_OFFLINE', `node ${expected.nodeId} is not connected to the frozen executor instance`);
      }
      if (runtime.nodeId !== expected.nodeId || runtime.machineId !== expected.machineId) {
        throw new NodeRegistryError(
          'NODE_IDENTITY_MISMATCH',
          `node ${expected.nodeId} runtime identity no longer matches the frozen machine`
        );
      }
      if (runtime.agentInstanceId !== expected.agentInstanceId) {
        throw new NodeRegistryError(
          'TARGET_CHANGED',
          `node ${expected.nodeId} agent instance changed after the input was frozen`
        );
      }
      return fn(connection, cloneRuntime(runtime)!);
    });
  }

  async close(): Promise<void> {
    await this.initialize();
    const pending = [...this.live.values()].map(node => node.connecting).filter((value): value is Promise<RemoteNodeConnection> => !!value);
    await Promise.all([...this.live.keys()].map(id => this.invalidate(id)));
    // A connect invalidated before RemoteNodeConnection materializes cannot be directly closed by
    // invalidate(). Its epoch check closes itself as soon as the bounded handshake settles.
    await Promise.allSettled(pending);
  }

  private normalizeInput(input: RemoteNodeInput): RemoteNodeInput {
    const id = input.id.trim();
    const name = input.name.trim();
    if (id === LOCAL_NODE_ID) throw new NodeRegistryError('TARGET_CHANGED', 'the built-in local node cannot be replaced');
    if (!id || id.length > 128 || !name || name.length > 160) {
      throw new NodeRegistryError('TARGET_CONTEXT_UNRESOLVED', 'remote node id or name is invalid');
    }
    const endpoint = remoteEndpoint(input.endpoint.trim());
    const expectedMachineId = input.expectedMachineId?.trim() || undefined;
    if (expectedMachineId && expectedMachineId.length > 256) {
      throw new NodeRegistryError('TARGET_CONTEXT_UNRESOLVED', 'expected machine id is invalid');
    }
    return { id, name, endpoint, ...(expectedMachineId ? { expectedMachineId } : {}) };
  }

  private async open(config: NodeConfig): Promise<RemoteNodeConnection> {
    if (!isNodeCredentialRef(config.credentialRef)) {
      throw new NodeRegistryError('AUTH_FAILED', `node ${config.id} has no usable credential reference`);
    }
    const token = await this.readSecret(config.credentialRef);
    if (!token) throw new NodeRegistryError('AUTH_FAILED', `node ${config.id} credential is unavailable`);
    return this.connectRemote({ node: cloneConfig(config), token });
  }

  private async upsertRemoteLocked(normalized: RemoteNodeInput, token?: string): Promise<NodeConfig> {
    const previous = this.configs.get(normalized.id);
    const trimmedToken = token?.trim();
    if (!previous && !trimmedToken) {
      throw new NodeRegistryError('AUTH_FAILED', `node ${normalized.id} needs a credential before it can be configured`);
    }
    const unchanged = previous && !trimmedToken &&
      previous.name === normalized.name &&
      previous.endpoint === normalized.endpoint &&
      previous.expectedMachineId === normalized.expectedMachineId;
    if (unchanged) return cloneConfig(previous);

    const nextVersion = this.lastConfigVersion + 1;
    const nextCredentialRef = trimmedToken ? credentialRef(normalized.id, nextVersion) : previous!.credentialRef!;
    if (!isNodeCredentialRef(nextCredentialRef)) {
      throw new NodeRegistryError('AUTH_FAILED', `node ${normalized.id} has no usable credential reference`);
    }
    const next = nodeConfigSchema.parse({
      id: normalized.id,
      name: normalized.name,
      transport: 'remote-stdio-ws',
      endpoint: normalized.endpoint,
      credentialRef: nextCredentialRef,
      ...(normalized.expectedMachineId ? { expectedMachineId: normalized.expectedMachineId } : {}),
      configVersion: nextVersion
    });

    if (trimmedToken) await this.writeSecret(nextCredentialRef, trimmedToken);
    try {
      await this.persist([...this.configs.values()].filter(node => node.id !== next.id).concat(next), nextVersion);
    } catch (error) {
      if (trimmedToken) await this.removeSecret(nextCredentialRef).catch(() => undefined);
      throw error;
    }

    this.configs.set(next.id, next);
    this.lastConfigVersion = nextVersion;
    const oldRef = previous?.credentialRef;
    await this.invalidate(next.id);
    if (trimmedToken && oldRef && oldRef !== nextCredentialRef && isNodeCredentialRef(oldRef)) {
      await this.removeSecret(oldRef).catch(() => undefined);
    }
    return cloneConfig(next);
  }

  private liveFor(nodeId: string): LiveNode {
    const existing = this.live.get(nodeId);
    if (existing) return existing;
    const live: LiveNode = {
      epoch: 0,
      connection: null,
      connecting: null,
      state: 'disconnected',
      error: null,
      operation: Promise.resolve()
    };
    this.live.set(nodeId, live);
    return live;
  }

  private async invalidate(nodeId: string): Promise<void> {
    await this.serializeLive(nodeId, () => this.invalidateLocked(nodeId));
  }

  private async invalidateLocked(nodeId: string): Promise<void> {
    const live = this.liveFor(nodeId);
    live.epoch += 1;
    const connection = live.connection;
    live.connection = null;
    live.connecting = null;
    live.state = 'disconnected';
    live.error = null;
    if (connection) await connection.close().catch(() => undefined);
  }

  private serializeLive<T>(nodeId: string, operation: () => Promise<T>): Promise<T> {
    const live = this.liveFor(nodeId);
    const run = live.operation.then(operation, operation);
    live.operation = run.then(() => undefined, () => undefined);
    return run;
  }

  private localSnapshot(): NodeRegistrySnapshot {
    return { config: cloneConfig(LOCAL_NODE), state: 'local', runtimeInfo: null, error: null };
  }

  private snapshotFor(config: NodeConfig): NodeRegistrySnapshot {
    const live = this.live.get(config.id);
    if (!live) return { config: cloneConfig(config), state: 'disconnected', runtimeInfo: null, error: null };
    const runtime = live.connection?.runtimeInfo ?? null;
    if (live.state === 'connected' && !runtime) {
      const transportError = live.connection?.transport.lastError ?? null;
      live.connection = null;
      live.state = transportError ? 'error' : 'disconnected';
      live.error = transportError ? statusError(transportError) : null;
    }
    return {
      config: cloneConfig(config),
      state: live.state,
      runtimeInfo: cloneRuntime(runtime),
      error: live.error ? { ...live.error } : null
    };
  }

  private async persist(nodes: NodeConfig[], lastConfigVersion: number): Promise<void> {
    await writeDurableNow(STATE_NAME, {
      version: STATE_VERSION,
      lastConfigVersion,
      nodes: nodes.map(cloneConfig)
    } satisfies PersistedNodeRegistry);
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutation.then(operation, operation);
    this.mutation = run.then(() => undefined, () => undefined);
    return run;
  }
}

/** Production singleton. Callers should project configuration/status from this owner. */
export const nodeRegistry = new NodeRegistry();
