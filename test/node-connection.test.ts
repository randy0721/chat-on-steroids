import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { ReadBuffer, serializeMessage, type JSONRPCMessage } from '@modelcontextprotocol/client';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import {
  connectRemoteNode,
  type RemoteNodeConnection
} from '../src/main/nodes/connection.js';
import type { NodeConfig } from '../src/shared/nodes.js';

const TOKEN = 'test-node-token';
const MACHINE = 'office-win-01';
const INSTANCE = 'agent-instance-01';

function rawBytes(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.concat(data);
}

interface FakeNodeOptions {
  machineId?: string;
  protocolVersion?: number;
  sendHello?: boolean;
  binaryBeforeHello?: boolean;
  dropToolCall?: boolean;
  oversizedToolsList?: boolean;
  coalesceToolCalls?: boolean;
  approvedRoots?: string[];
}

class FakeNode {
  readonly server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
  readonly authorizations: Array<string | undefined> = [];
  readonly accepts: unknown[] = [];
  readonly requests: JSONRPCMessage[] = [];
  connections = 0;
  private sockets = new Set<WebSocket>();
  private pendingToolReplies: Buffer[] = [];

  private constructor(readonly options: FakeNodeOptions) {}

  static async start(options: FakeNodeOptions = {}): Promise<FakeNode> {
    const node = new FakeNode(options);
    await once(node.server, 'listening');
    node.server.on('connection', (socket, request) => node.connected(socket, request.headers.authorization));
    return node;
  }

  get url(): string {
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('fake node is not listening');
    return `ws://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    this.server.close();
    await once(this.server, 'close');
  }

  private connected(socket: WebSocket, authorization: string | undefined): void {
    this.connections += 1;
    this.authorizations.push(authorization);
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    if (this.options.binaryBeforeHello) {
      socket.send(Buffer.from('{"jsonrpc":"2.0"}\n'), { binary: true });
      return;
    }
    if (this.options.sendHello === false) return;
    socket.send(JSON.stringify({
      type: 'cos-desktop-commander/node-hello',
      protocolVersion: this.options.protocolVersion ?? 1,
      machineId: this.options.machineId ?? MACHINE,
      agentInstanceId: INSTANCE,
      platform: 'win32',
      defaultShell: 'PowerShell',
      capabilities: ['desktop-commander-mcp', 'files', 'terminal'],
      maxBinaryFrameBytes: 8 * 1024 * 1024
    }), { binary: false });

    const reader = new ReadBuffer({ maxBufferSize: 1024 * 1024 });
    socket.on('message', (data, isBinary) => {
      if (!isBinary) {
        this.accepts.push(JSON.parse(rawBytes(data).toString('utf8')));
        return;
      }
      reader.append(rawBytes(data));
      while (true) {
        const message = reader.readMessage();
        if (!message) break;
        this.requests.push(message);
        this.reply(socket, message);
      }
    });
  }

  private reply(socket: WebSocket, message: JSONRPCMessage): void {
    if (!('method' in message) || !('id' in message)) return;
    if (message.method === 'initialize') {
      const response = serializeMessage({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: '远端节点', version: '1.0.0' }
        }
      });
      const bytes = Buffer.from(response, 'utf8');
      const marker = Buffer.from('远', 'utf8');
      const markerAt = bytes.indexOf(marker);
      // Split in the middle of a UTF-8 code point; WebSocket chunk boundaries are not stdio boundaries.
      socket.send(bytes.subarray(0, markerAt + 1), { binary: true });
      socket.send(bytes.subarray(markerAt + 1), { binary: true });
      return;
    }
    if (message.method === 'tools/list') {
      const description = this.options.oversizedToolsList ? 'x'.repeat(1024) : 'Echo one value';
      socket.send(Buffer.from(serializeMessage({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [{
            name: 'echo',
            description,
            inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }
          }, ...(this.options.approvedRoots ? [{
            name: 'get_config', description: 'config', inputSchema: { type: 'object', properties: {} }
          }] : [])]
        }
      })), { binary: true });
      return;
    }
    if (message.method === 'tools/call') {
      if (this.options.dropToolCall) {
        socket.close(1011, 'simulated loss after receive');
        return;
      }
      if (message.params?.name === 'get_config') {
        socket.send(Buffer.from(serializeMessage({
          jsonrpc: '2.0', id: message.id, result: {
            content: [{ type: 'text', text: 'config' }],
            structuredContent: { config: { allowedDirectories: this.options.approvedRoots, defaultShell: 'pwsh.exe' } }
          }
        })), { binary: true });
        return;
      }
      const value = (message.params?.arguments as { value?: string } | undefined)?.value ?? '';
      const reply = Buffer.from(serializeMessage({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: value }] }
      }));
      if (this.options.coalesceToolCalls) {
        this.pendingToolReplies.push(reply);
        if (this.pendingToolReplies.length === 2) {
          socket.send(Buffer.concat(this.pendingToolReplies.splice(0)), { binary: true });
        }
      } else {
        socket.send(reply, { binary: true });
      }
      return;
    }
    socket.send(Buffer.from(serializeMessage({ jsonrpc: '2.0', id: message.id, result: {} })), { binary: true });
  }
}

const nodes: FakeNode[] = [];
const connections: RemoteNodeConnection[] = [];

afterEach(async () => {
  await Promise.all(connections.splice(0).map(connection => connection.close().catch(() => undefined)));
  await Promise.all(nodes.splice(0).map(node => node.close()));
});

function config(endpoint: string, expectedMachineId = MACHINE): NodeConfig {
  return {
    id: 'office-windows',
    name: 'Office Windows',
    transport: 'remote-stdio-ws',
    endpoint,
    credentialRef: 'node:office-windows',
    expectedMachineId,
    configVersion: 1
  };
}

async function connect(node: FakeNode, overrides: Partial<Parameters<typeof connectRemoteNode>[0]> = {}): Promise<RemoteNodeConnection> {
  nodes.push(node);
  const connection = await connectRemoteNode({
    node: config(node.url),
    token: TOKEN,
    handshakeTimeoutMs: 500,
    heartbeatMs: 5_000,
    ...overrides
  });
  connections.push(connection);
  return connection;
}

describe('remote node WebSocket MCP transport', () => {
  it('authenticates, accepts the exact HELLO, reassembles split UTF-8, then publishes runtime info after tool discovery', async () => {
    const node = await FakeNode.start();
    const connection = await connect(node);

    expect(node.authorizations).toEqual([`Bearer ${TOKEN}`]);
    expect(node.accepts).toEqual([expect.objectContaining({
      type: 'cos-desktop-commander/node-accept',
      protocolVersion: 1,
      machineId: MACHINE,
      agentInstanceId: INSTANCE
    })]);
    expect(node.requests.map(request => 'method' in request ? request.method : '')).toContain('initialize');
    expect(node.requests.map(request => 'method' in request ? request.method : '')).toContain('tools/list');
    expect(connection.runtimeInfo).toEqual({
      nodeId: 'office-windows',
      machineId: MACHINE,
      agentInstanceId: INSTANCE,
      platform: 'win32',
      defaultShell: 'PowerShell',
      approvedRoots: [],
      capabilities: ['desktop-commander-mcp', 'files', 'terminal'],
      protocolVersion: 1
    });
    expect(connection.tools.map(tool => tool.name)).toEqual(['echo']);
    expect((await connection.callTool({ name: 'echo', arguments: { value: 'ok' } })).content)
      .toEqual([{ type: 'text', text: 'ok' }]);
    await connection.close();
    await connection.close();
    expect(connection.runtimeInfo).toBeNull();
  });

  it('discovers approved roots/default shell from structured get_config before publishing runtime info', async () => {
    const node = await FakeNode.start({ approvedRoots: ['C:\\work', 'D:\\shared'] });
    const connection = await connect(node);
    expect(connection.runtimeInfo).toMatchObject({
      approvedRoots: ['C:\\work', 'D:\\shared'],
      defaultShell: 'pwsh.exe'
    });
    expect(node.requests.filter(request => 'method' in request && request.method === 'tools/call')).toHaveLength(1);
  });

  it('reassembles multiple MCP messages delivered in one binary WebSocket message', async () => {
    const node = await FakeNode.start({ coalesceToolCalls: true });
    const connection = await connect(node);

    const [one, two] = await Promise.all([
      connection.callTool({ name: 'echo', arguments: { value: 'one' } }),
      connection.callTool({ name: 'echo', arguments: { value: 'two' } })
    ]);
    expect(one.content).toEqual([{ type: 'text', text: 'one' }]);
    expect(two.content).toEqual([{ type: 'text', text: 'two' }]);
  });

  it.each([
    ['identity', { machineId: 'wrong-machine' }, 'NODE_IDENTITY_MISMATCH'],
    ['version', { protocolVersion: 999 }, 'NODE_PROTOCOL_MISMATCH']
  ] as const)('rejects a bad %s HELLO before MCP initialize', async (_kind, options, code) => {
    const node = await FakeNode.start(options);
    nodes.push(node);
    await expect(connectRemoteNode({
      node: config(node.url), token: TOKEN, handshakeTimeoutMs: 500, heartbeatMs: 5_000
    })).rejects.toMatchObject({ code });
    expect(node.requests).toHaveLength(0);
    expect(node.accepts).toHaveLength(0);
  });

  it('rejects binary MCP bytes before HELLO/ACCEPT', async () => {
    const node = await FakeNode.start({ binaryBeforeHello: true });
    nodes.push(node);
    await expect(connectRemoteNode({
      node: config(node.url), token: TOKEN, handshakeTimeoutMs: 500, heartbeatMs: 5_000
    })).rejects.toMatchObject({ code: 'NODE_PROTOCOL_ERROR' });
    expect(node.accepts).toHaveLength(0);
  });

  it('bounds the HELLO deadline and never silently reconnects', async () => {
    const node = await FakeNode.start({ sendHello: false });
    nodes.push(node);
    await expect(connectRemoteNode({
      node: config(node.url), token: TOKEN, handshakeTimeoutMs: 40, heartbeatMs: 5_000
    })).rejects.toMatchObject({ code: 'NODE_OFFLINE' });
    expect(node.connections).toBe(1);
  });

  it('surfaces disconnect after a tools/call send as EXECUTION_STATUS_UNKNOWN and does not replay', async () => {
    const node = await FakeNode.start({ dropToolCall: true });
    const connection = await connect(node);

    await expect(connection.callTool({ name: 'echo', arguments: { value: 'mutate-once' } }))
      .rejects.toMatchObject({ code: 'EXECUTION_STATUS_UNKNOWN', requestMayHaveBeenSent: true });
    expect(node.requests.filter(request => 'method' in request && request.method === 'tools/call')).toHaveLength(1);
    expect(node.connections).toBe(1);
    expect(connection.runtimeInfo).toBeNull();
  });

  it('rejects an oversized partial MCP stream and retires the connection', async () => {
    const node = await FakeNode.start({ oversizedToolsList: true });
    nodes.push(node);
    await expect(connectRemoteNode({
      node: config(node.url),
      token: TOKEN,
      handshakeTimeoutMs: 500,
      heartbeatMs: 5_000,
      maxMcpBufferBytes: 256
    })).rejects.toBeInstanceOf(Error);
    expect(node.connections).toBe(1);
  });
});
