import {
  Client,
  ReadBuffer,
  serializeMessage,
  type CallToolRequestOptions,
  type CallToolRequestParams,
  type CallToolResult,
  type JSONRPCMessage,
  type ListToolsResult,
  type Tool,
  type Transport,
  type TransportSendOptions
} from '@modelcontextprotocol/client';
import WebSocket, { type RawData } from 'ws';
import {
  nodeRuntimeInfoSchema,
  type NodeConfig,
  type NodeErrorCode,
  type NodeRuntimeInfo
} from '../../shared/nodes.js';

const NODE_PROTOCOL_VERSION = 1;
const NODE_HELLO_TYPE = 'cos-desktop-commander/node-hello';
const NODE_ACCEPT_TYPE = 'cos-desktop-commander/node-accept';
const MAX_CONTROL_FRAME_BYTES = 16 * 1024;
const DEFAULT_MAX_BINARY_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_MCP_BUFFER_BYTES = 16 * 1024 * 1024;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_MS = 15_000;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PLATFORMS = new Set(['win32', 'darwin', 'linux']);

export type RemoteNodeConnectionErrorCode =
  | NodeErrorCode
  | 'NODE_PROTOCOL_MISMATCH'
  | 'NODE_PROTOCOL_ERROR';

export class RemoteNodeConnectionError extends Error {
  readonly causeValue?: unknown;

  constructor(
    readonly code: RemoteNodeConnectionErrorCode,
    detail: string,
    readonly requestMayHaveBeenSent = false,
    cause?: unknown
  ) {
    super(`${code}: ${detail}`);
    this.name = 'RemoteNodeConnectionError';
    this.causeValue = cause;
  }
}

interface NodeHello {
  type: typeof NODE_HELLO_TYPE;
  protocolVersion: typeof NODE_PROTOCOL_VERSION;
  machineId: string;
  agentInstanceId: string;
  platform: NodeRuntimeInfo['platform'];
  defaultShell: string;
  capabilities: string[];
  maxBinaryFrameBytes: number;
}

export interface RemoteNodeTransportOptions {
  endpoint: string;
  token: string;
  expectedMachineId?: string;
  handshakeTimeoutMs?: number;
  heartbeatMs?: number;
  maxBinaryFrameBytes?: number;
  maxMcpBufferBytes?: number;
}

function rawBytes(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.concat(data);
}

function boundedPositive(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RemoteNodeConnectionError('NODE_PROTOCOL_ERROR', `${name} must be a positive integer`);
  }
  return resolved;
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new RemoteNodeConnectionError('NODE_PROTOCOL_ERROR', `${field} is invalid`);
  }
  return value;
}

function parseHello(raw: string, expectedMachineId: string | undefined): NodeHello {
  if (Buffer.byteLength(raw, 'utf8') > MAX_CONTROL_FRAME_BYTES) {
    throw new RemoteNodeConnectionError('NODE_PROTOCOL_ERROR', 'node HELLO exceeds the control-frame limit');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new RemoteNodeConnectionError('NODE_PROTOCOL_ERROR', 'node HELLO is not valid JSON', false, error);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RemoteNodeConnectionError('NODE_PROTOCOL_ERROR', 'node HELLO is not an object');
  }
  const hello = value as Record<string, unknown>;
  if (hello.type !== NODE_HELLO_TYPE) {
    throw new RemoteNodeConnectionError('NODE_PROTOCOL_ERROR', 'node sent an unknown control frame');
  }
  if (hello.protocolVersion !== NODE_PROTOCOL_VERSION) {
    throw new RemoteNodeConnectionError(
      'NODE_PROTOCOL_MISMATCH',
      `node protocol version ${String(hello.protocolVersion)} is unsupported`
    );
  }
  const machineId = identifier(hello.machineId, 'machineId');
  const agentInstanceId = identifier(hello.agentInstanceId, 'agentInstanceId');
  if (expectedMachineId && machineId !== expectedMachineId) {
    throw new RemoteNodeConnectionError(
      'NODE_IDENTITY_MISMATCH',
      `expected machine ${expectedMachineId}, connected to ${machineId}`
    );
  }
  if (typeof hello.platform !== 'string' || !PLATFORMS.has(hello.platform)) {
    throw new RemoteNodeConnectionError('NODE_PROTOCOL_ERROR', 'node platform is invalid');
  }
  if (typeof hello.defaultShell !== 'string' || hello.defaultShell.length > 120) {
    throw new RemoteNodeConnectionError('NODE_PROTOCOL_ERROR', 'node defaultShell is invalid');
  }
  if (!Array.isArray(hello.capabilities) || hello.capabilities.length > 64 ||
      hello.capabilities.some(capability => typeof capability !== 'string' || !/^[a-z0-9._-]{1,64}$/i.test(capability))) {
    throw new RemoteNodeConnectionError('NODE_PROTOCOL_ERROR', 'node capabilities are invalid');
  }
  if (!Number.isSafeInteger(hello.maxBinaryFrameBytes) || (hello.maxBinaryFrameBytes as number) <= 0) {
    throw new RemoteNodeConnectionError('NODE_PROTOCOL_ERROR', 'node binary frame contract is invalid');
  }
  return {
    type: NODE_HELLO_TYPE,
    protocolVersion: NODE_PROTOCOL_VERSION,
    machineId,
    agentInstanceId,
    platform: hello.platform as NodeRuntimeInfo['platform'],
    defaultShell: hello.defaultShell,
    capabilities: [...hello.capabilities] as string[],
    maxBinaryFrameBytes: hello.maxBinaryFrameBytes as number
  };
}

function acceptFrame(hello: NodeHello): string {
  return JSON.stringify({
    type: NODE_ACCEPT_TYPE,
    protocolVersion: NODE_PROTOCOL_VERSION,
    machineId: hello.machineId,
    agentInstanceId: hello.agentInstanceId
  });
}

/**
 * One authenticated WebSocket connection to one remote node. Text frames are reserved for the
 * node HELLO/ACCEPT control handshake; after that, binary frames are a continuous MCP stdio byte
 * stream. `ReadBuffer` is deliberately the SDK's stdio framer so WebSocket message boundaries do
 * not become JSON-RPC boundaries.
 */
export class RemoteNodeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private readonly endpoint: string;
  private readonly token: string;
  private readonly expectedMachineId?: string;
  private readonly handshakeTimeoutMs: number;
  private readonly heartbeatMs: number;
  private readonly maxBinaryFrameBytes: number;
  private readonly maxMcpBufferBytes: number;
  private readonly reader: ReadBuffer;
  private socket: WebSocket | null = null;
  private startPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private startResolve: (() => void) | null = null;
  private startReject: ((error: Error) => void) | null = null;
  private handshakeTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private awaitingPong = false;
  private accepted = false;
  private closing = false;
  private closeEmitted = false;
  private _hello: NodeHello | null = null;
  private _lastError: RemoteNodeConnectionError | null = null;
  private _outboundRequestCount = 0;

  constructor(options: RemoteNodeTransportOptions) {
    let endpoint: URL;
    try {
      endpoint = new URL(options.endpoint);
    } catch (error) {
      throw new RemoteNodeConnectionError('NODE_OFFLINE', 'remote node endpoint is invalid', false, error);
    }
    if (endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:') {
      throw new RemoteNodeConnectionError('NODE_OFFLINE', 'remote node endpoint must use ws:// or wss://');
    }
    if (!options.token) throw new RemoteNodeConnectionError('AUTH_FAILED', 'remote node credential is empty');
    this.endpoint = endpoint.href;
    this.token = options.token;
    this.expectedMachineId = options.expectedMachineId?.trim() || undefined;
    this.handshakeTimeoutMs = boundedPositive(options.handshakeTimeoutMs, DEFAULT_HANDSHAKE_TIMEOUT_MS, 'handshakeTimeoutMs');
    this.heartbeatMs = boundedPositive(options.heartbeatMs, DEFAULT_HEARTBEAT_MS, 'heartbeatMs');
    this.maxBinaryFrameBytes = boundedPositive(options.maxBinaryFrameBytes, DEFAULT_MAX_BINARY_FRAME_BYTES, 'maxBinaryFrameBytes');
    this.maxMcpBufferBytes = boundedPositive(options.maxMcpBufferBytes, DEFAULT_MAX_MCP_BUFFER_BYTES, 'maxMcpBufferBytes');
    this.reader = new ReadBuffer({ maxBufferSize: this.maxMcpBufferBytes });
  }

  get hello(): Readonly<NodeHello> | null { return this._hello; }
  get connected(): boolean { return this.accepted && this.socket?.readyState === WebSocket.OPEN && !this.closing; }
  get lastError(): RemoteNodeConnectionError | null { return this._lastError; }
  get outboundRequestCount(): number { return this._outboundRequestCount; }

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.closing) throw new RemoteNodeConnectionError('NODE_OFFLINE', 'remote node transport is closed');
    this.startPromise = new Promise<void>((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
      const socket = new WebSocket(this.endpoint, {
        headers: { Authorization: `Bearer ${this.token}` },
        perMessageDeflate: false,
        maxPayload: this.maxBinaryFrameBytes
      });
      this.socket = socket;
      this.handshakeTimer = setTimeout(() => {
        this.fail(new RemoteNodeConnectionError('NODE_OFFLINE', `node handshake timed out after ${this.handshakeTimeoutMs}ms`), 1008, 'node handshake timed out');
      }, this.handshakeTimeoutMs);
      this.handshakeTimer.unref?.();

      socket.on('open', () => this.startHeartbeat());
      socket.on('pong', () => { this.awaitingPong = false; });
      socket.on('unexpected-response', (_request, response) => {
        const error = response.statusCode === 401 || response.statusCode === 403
          ? new RemoteNodeConnectionError('AUTH_FAILED', `remote node rejected authentication with HTTP ${response.statusCode}`)
          : new RemoteNodeConnectionError('NODE_OFFLINE', `remote node WebSocket upgrade failed with HTTP ${response.statusCode}`);
        response.destroy();
        this.fail(error);
      });
      socket.on('message', (data, isBinary) => this.receive(data, isBinary));
      socket.on('error', error => {
        if (this._lastError || this.closing) return;
        this.noteError(new RemoteNodeConnectionError('NODE_OFFLINE', error.message, false, error));
      });
      socket.on('close', (code, reasonBytes) => this.closed(code, reasonBytes.toString()));
    });
    return this.startPromise;
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    const socket = this.socket;
    if (!this.accepted || !socket || socket.readyState !== WebSocket.OPEN || this.closing) {
      throw this._lastError ?? new RemoteNodeConnectionError('NODE_OFFLINE', 'remote node is not connected');
    }
    const serialized = serializeMessage(message);
    const bytes = Buffer.from(serialized, 'utf8');
    if (bytes.length > this.maxMcpBufferBytes) {
      throw new RemoteNodeConnectionError('NODE_PROTOCOL_ERROR', `outbound MCP message exceeds ${this.maxMcpBufferBytes} bytes`);
    }
    const isRequest = 'method' in message && 'id' in message;
    if (isRequest) this._outboundRequestCount += 1;
    await new Promise<void>((resolve, reject) => {
      socket.send(bytes, { binary: true }, error => {
        if (!error) {
          resolve();
          return;
        }
        const failure = new RemoteNodeConnectionError('NODE_OFFLINE', `sending MCP bytes failed: ${error.message}`, isRequest, error);
        this.noteError(failure);
        reject(failure);
      });
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.clearTimers();
    this.reader.clear();
    const socket = this.socket;
    this.closePromise = new Promise<void>(resolve => {
      if (!socket || socket.readyState === WebSocket.CLOSED) {
        this.emitClose();
        resolve();
        return;
      }
      const finish = () => {
        clearTimeout(force);
        this.emitClose();
        resolve();
      };
      const force = setTimeout(() => {
        try { socket.terminate(); } catch {}
        finish();
      }, 500);
      force.unref?.();
      socket.once('close', finish);
      try {
        if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
        else socket.close(1000, 'client close');
      } catch {
        finish();
      }
    });
    return this.closePromise;
  }

  private receive(data: RawData, isBinary: boolean): void {
    if (!this.accepted) {
      if (isBinary) {
        this.fail(new RemoteNodeConnectionError('NODE_PROTOCOL_ERROR', 'received MCP bytes before node HELLO/ACCEPT completed'), 1002, 'MCP bytes before node handshake');
        return;
      }
      let hello: NodeHello;
      try {
        hello = parseHello(rawBytes(data).toString('utf8'), this.expectedMachineId);
        if (hello.maxBinaryFrameBytes !== DEFAULT_MAX_BINARY_FRAME_BYTES) {
          throw new RemoteNodeConnectionError('NODE_PROTOCOL_MISMATCH', 'node binary frame contract does not match this client');
        }
      } catch (error) {
        this.fail(
          error instanceof RemoteNodeConnectionError ? error : new RemoteNodeConnectionError('NODE_PROTOCOL_ERROR', String(error)),
          1008,
          'node handshake rejected'
        );
        return;
      }
      this._hello = hello;
      // Mark accepted before sending the control frame: WebSocket preserves message ordering, and
      // the node may send its first binary stdout bytes before ws's send callback fires locally.
      this.accepted = true;
      this.socket!.send(acceptFrame(hello), { binary: false }, error => {
        if (error) {
          this.fail(new RemoteNodeConnectionError('NODE_OFFLINE', `sending node ACCEPT failed: ${error.message}`, false, error));
          return;
        }
        this.clearHandshakeTimer();
        this.startResolve?.();
        this.startResolve = null;
        this.startReject = null;
      });
      return;
    }

    if (!isBinary) {
      this.fail(new RemoteNodeConnectionError('NODE_PROTOCOL_ERROR', 'unexpected text control frame after node handshake'), 1002, 'unexpected control frame');
      return;
    }
    const bytes = rawBytes(data);
    if (bytes.length > this.maxBinaryFrameBytes) {
      this.fail(new RemoteNodeConnectionError('NODE_PROTOCOL_ERROR', `binary MCP frame exceeds ${this.maxBinaryFrameBytes} bytes`), 1009, 'binary frame too large');
      return;
    }
    try {
      this.reader.append(bytes);
      while (true) {
        const message = this.reader.readMessage();
        if (!message) break;
        this.onmessage?.(message);
      }
    } catch (error) {
      this.fail(new RemoteNodeConnectionError('NODE_PROTOCOL_ERROR', 'invalid or oversized MCP stdio stream', false, error), 1002, 'invalid MCP stream');
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN || this.closing) return;
      if (this.awaitingPong) {
        this.fail(new RemoteNodeConnectionError('NODE_OFFLINE', 'remote node heartbeat timed out'));
        return;
      }
      this.awaitingPong = true;
      try { socket.ping(); }
      catch (error) { this.fail(new RemoteNodeConnectionError('NODE_OFFLINE', 'remote node heartbeat failed', false, error)); }
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  private noteError(error: RemoteNodeConnectionError): void {
    if (!this._lastError) this._lastError = error;
    this.onerror?.(error);
  }

  private fail(error: RemoteNodeConnectionError, code = 1011, reason = 'node transport failed'): void {
    if (!this._lastError) this.noteError(error);
    this.startReject?.(error);
    this.startResolve = null;
    this.startReject = null;
    this.clearTimers();
    const socket = this.socket;
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      this.emitClose();
      return;
    }
    try {
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else socket.close(code, reason);
    } catch {
      try { socket.terminate(); } catch {}
    }
  }

  private closed(code: number, reason: string): void {
    this.clearTimers();
    this.reader.clear();
    if (!this.closing && !this._lastError) {
      const error = !this.accepted && code === 1008 && /unauthor/i.test(reason)
        ? new RemoteNodeConnectionError('AUTH_FAILED', 'remote node rejected authentication')
        : new RemoteNodeConnectionError('NODE_OFFLINE', `remote node closed ${code}: ${reason || '(no reason)'}`);
      this.noteError(error);
    }
    if (!this.accepted && this._lastError) this.startReject?.(this._lastError);
    this.startResolve = null;
    this.startReject = null;
    this.emitClose();
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }

  private clearTimers(): void {
    this.clearHandshakeTimer();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private emitClose(): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.onclose?.();
  }
}

export interface RemoteNodeConnectionOptions {
  node: NodeConfig;
  token: string;
  handshakeTimeoutMs?: number;
  heartbeatMs?: number;
  maxBinaryFrameBytes?: number;
  maxMcpBufferBytes?: number;
}

/** Ready MCP client bound to one exact authenticated remote node instance. */
export class RemoteNodeConnection {
  private closed = false;

  private constructor(
    readonly node: NodeConfig,
    readonly transport: RemoteNodeTransport,
    readonly client: Client,
    private _runtimeInfo: NodeRuntimeInfo,
    private _tools: Tool[]
  ) {}

  static async connect(options: RemoteNodeConnectionOptions): Promise<RemoteNodeConnection> {
    if (options.node.transport !== 'remote-stdio-ws' || !options.node.endpoint) {
      throw new RemoteNodeConnectionError('NODE_OFFLINE', `node ${options.node.id} is not configured for remote-stdio-ws`);
    }
    const transport = new RemoteNodeTransport({
      endpoint: options.node.endpoint,
      token: options.token,
      expectedMachineId: options.node.expectedMachineId,
      handshakeTimeoutMs: options.handshakeTimeoutMs,
      heartbeatMs: options.heartbeatMs,
      maxBinaryFrameBytes: options.maxBinaryFrameBytes,
      maxMcpBufferBytes: options.maxMcpBufferBytes
    });
    const client = new Client({ name: 'Chat On Steroids Remote Node', version: '1.0.0' });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const hello = transport.hello;
      if (!hello || !transport.connected) {
        throw transport.lastError ?? new RemoteNodeConnectionError('NODE_OFFLINE', 'node disconnected during MCP initialization');
      }
      const names = new Set(listed.tools.map(tool => tool.name));
      let approvedRoots: string[] = [];
      let discoveredDefaultShell = hello.defaultShell;
      if (names.has('get_config')) {
        const configResult = await client.callTool({ name: 'get_config', arguments: { origin: 'ui' } });
        if (configResult.isError) {
          throw new RemoteNodeConnectionError('NODE_PROTOCOL_ERROR', 'remote node get_config failed during runtime discovery');
        }
        const structured = configResult.structuredContent as Record<string, unknown> | undefined;
        const config = structured?.config;
        if (!config || typeof config !== 'object' || Array.isArray(config)) {
          throw new RemoteNodeConnectionError('NODE_PROTOCOL_ERROR', 'remote node get_config did not return structured config');
        }
        const row = config as Record<string, unknown>;
        if (!Array.isArray(row.allowedDirectories) || row.allowedDirectories.length > 128 ||
            row.allowedDirectories.some(root => typeof root !== 'string' || root.length === 0 || root.length > 32_768 || root.includes('\0'))) {
          throw new RemoteNodeConnectionError('NODE_PROTOCOL_ERROR', 'remote node approved roots are invalid');
        }
        approvedRoots = [...new Set(row.allowedDirectories as string[])];
        if (typeof row.defaultShell === 'string' && row.defaultShell.trim() && row.defaultShell.length <= 120) {
          discoveredDefaultShell = row.defaultShell;
        }
      }
      const capabilities = new Set(hello.capabilities);
      if (names.has('read_file') && names.has('list_directory')) capabilities.add('files');
      if (names.has('start_process') && names.has('read_process_output') && names.has('interact_with_process')) capabilities.add('terminal');
      if (names.has('get_file_info') && names.has('write_file') && names.has('move_file')) capabilities.add('patch');
      if (names.has('cos_windows_desktop')) capabilities.add('windows-desktop');
      const runtimeInfo = nodeRuntimeInfoSchema.parse({
        nodeId: options.node.id,
        machineId: hello.machineId,
        agentInstanceId: hello.agentInstanceId,
        platform: hello.platform,
        defaultShell: discoveredDefaultShell,
        approvedRoots,
        capabilities: [...capabilities],
        protocolVersion: hello.protocolVersion
      });
      return new RemoteNodeConnection(options.node, transport, client, runtimeInfo, [...listed.tools]);
    } catch (error) {
      await client.close().catch(() => transport.close().catch(() => undefined));
      throw error;
    }
  }

  /** Runtime identity is live only after HELLO, MCP initialize and tools/list all succeeded. */
  get runtimeInfo(): NodeRuntimeInfo | null {
    return !this.closed && this.transport.connected ? { ...this._runtimeInfo, capabilities: [...this._runtimeInfo.capabilities], approvedRoots: [...this._runtimeInfo.approvedRoots] } : null;
  }

  get tools(): Tool[] {
    return this.transport.connected && !this.closed ? [...this._tools] : [];
  }

  async listTools(): Promise<ListToolsResult> {
    this.assertConnected();
    try {
      const listed = await this.client.listTools(undefined, { cacheMode: 'refresh' });
      this._tools = [...listed.tools];
      return listed;
    } catch (error) {
      throw this.connectionFailure(error, this.transport.outboundRequestCount, false);
    }
  }

  async callTool(params: CallToolRequestParams, options?: CallToolRequestOptions): Promise<CallToolResult> {
    this.assertConnected();
    const beforeSend = this.transport.outboundRequestCount;
    try {
      return await this.client.callTool(params, options);
    } catch (error) {
      throw this.connectionFailure(error, beforeSend, true);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client.close().catch(() => this.transport.close());
  }

  private assertConnected(): void {
    if (this.closed || !this.transport.connected) {
      throw this.transport.lastError ?? new RemoteNodeConnectionError('NODE_OFFLINE', `node ${this.node.id} is not connected`);
    }
  }

  private connectionFailure(error: unknown, beforeSend: number, mutatingUnknown: boolean): unknown {
    if (error instanceof RemoteNodeConnectionError) return error;
    const transportError = this.transport.lastError;
    if (!transportError) return error;
    const sent = this.transport.outboundRequestCount > beforeSend;
    if (mutatingUnknown && sent) {
      return new RemoteNodeConnectionError(
        'EXECUTION_STATUS_UNKNOWN',
        `node ${this.node.id} disconnected after the MCP request was handed to the transport; it was not replayed`,
        true,
        error
      );
    }
    return transportError;
  }
}

export function connectRemoteNode(options: RemoteNodeConnectionOptions): Promise<RemoteNodeConnection> {
  return RemoteNodeConnection.connect(options);
}
