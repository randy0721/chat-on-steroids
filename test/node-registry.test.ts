import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RemoteNodeConnectionError, type RemoteNodeConnection, type RemoteNodeConnectionOptions } from '../src/main/nodes/connection.js';
import { NodeRegistry, NodeRegistryError } from '../src/main/nodes/registry.js';
import { initDurableStore, readDurable, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';
import type { NodeRuntimeInfo } from '../src/shared/nodes.js';
import type { SecretKey } from '../src/main/secrets.js';

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-node-registry-'));
  initDurableStore(directory);
});

afterEach(async () => {
  resetDurableForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

const runtime = (nodeId: string, agentInstanceId = 'agent-one'): NodeRuntimeInfo => ({
  nodeId,
  machineId: `machine-${nodeId}`,
  agentInstanceId,
  platform: 'win32',
  defaultShell: 'powershell.exe',
  approvedRoots: [],
  capabilities: ['files', 'processes'],
  protocolVersion: 1
});

class FakeConnection {
  closed = 0;
  readonly transport = { lastError: null as RemoteNodeConnectionError | null };
  constructor(private info: NodeRuntimeInfo | null) {}
  get runtimeInfo(): NodeRuntimeInfo | null { return this.info ? { ...this.info, approvedRoots: [], capabilities: [...this.info.capabilities] } : null; }
  async close(): Promise<void> { this.closed += 1; this.info = null; }
  fail(error: RemoteNodeConnectionError): void { this.transport.lastError = error; this.info = null; }
}

function harness() {
  const secrets = new Map<string, string>();
  const opened: Array<{ options: RemoteNodeConnectionOptions; connection: FakeConnection }> = [];
  const registry = new NodeRegistry({
    getSecret: async (key: SecretKey) => secrets.get(key) ?? null,
    setSecret: async (key: SecretKey, value: string) => { secrets.set(key, value); },
    clearSecret: async (key: SecretKey) => { secrets.delete(key); },
    connectRemote: async (options) => {
      const connection = new FakeConnection(runtime(options.node.id, `agent-${opened.length + 1}`));
      opened.push({ options, connection });
      return connection as unknown as RemoteNodeConnection;
    }
  });
  return { registry, secrets, opened };
}

describe('NodeRegistry', () => {
  it('always projects the built-in local node without persisting it', async () => {
    const { registry } = harness();
    expect(await registry.list()).toEqual([
      expect.objectContaining({
        config: expect.objectContaining({ id: 'local', transport: 'local', configVersion: 1 }),
        state: 'local',
        runtimeInfo: null,
        error: null
      })
    ]);
    expect(await readDurable('node-registry')).toBeNull();
  });

  it('persists only secret references and keeps configVersion monotonic across update, removal and re-add', async () => {
    const first = harness();
    const created = await first.registry.upsertRemote({ id: 'office', name: 'Office PC', endpoint: 'ws://office.test:8766' }, 'TOP_SECRET_TOKEN');
    expect(created).toMatchObject({ id: 'office', transport: 'remote-stdio-ws', configVersion: 1 });
    expect(created.credentialRef).toMatch(/^setup:node:/);
    expect(first.secrets.get(created.credentialRef!)).toBe('TOP_SECRET_TOKEN');

    const onDisk = await readDurable<Record<string, unknown>>('node-registry');
    expect(JSON.stringify(onDisk)).not.toContain('TOP_SECRET_TOKEN');
    expect(JSON.stringify(onDisk)).toContain(created.credentialRef!);
    expect(JSON.stringify(onDisk)).not.toContain('"id":"local"');

    const restored = new NodeRegistry({
      getSecret: async key => first.secrets.get(key) ?? null,
      setSecret: async (key, value) => { first.secrets.set(key, value); },
      clearSecret: async key => { first.secrets.delete(key); },
      connectRemote: async () => { throw new Error('not used'); }
    });
    expect((await restored.get('office'))?.config.configVersion).toBe(1);
    const updated = await restored.upsertRemote({ id: 'office', name: 'Office PC', endpoint: 'ws://office.test:9000' });
    expect(updated.configVersion).toBe(2);
    expect(updated.credentialRef).toBe(created.credentialRef);
    expect(await restored.removeRemote('office')).toBe(true);
    const readded = await restored.upsertRemote({ id: 'office', name: 'Office PC 2', endpoint: 'wss://office.example/ws' }, 'NEW_TOKEN');
    expect(readded.configVersion).toBe(3);
    expect(readded.credentialRef).not.toBe(created.credentialRef);
    expect(first.secrets.has(created.credentialRef!)).toBe(false);
  });

  it('publishes remote runtime info only after the exact connection is ready and never fails over', async () => {
    const secrets = new Map<string, string>();
    let release!: (connection: RemoteNodeConnection) => void;
    const waiting = new Promise<RemoteNodeConnection>(resolve => { release = resolve; });
    const registry = new NodeRegistry({
      getSecret: async key => secrets.get(key) ?? null,
      setSecret: async (key, value) => { secrets.set(key, value); },
      clearSecret: async key => { secrets.delete(key); },
      connectRemote: async () => waiting
    });
    await registry.upsertRemote({ id: 'office', name: 'Office', endpoint: 'ws://office.test:8766' }, 'token');
    const connecting = registry.connect('office');
    await Promise.resolve();
    expect(await registry.get('office')).toMatchObject({ state: 'connecting', runtimeInfo: null });

    const live = new FakeConnection(runtime('office'));
    release(live as unknown as RemoteNodeConnection);
    await expect(connecting).resolves.toBe(live);
    expect(await registry.get('office')).toMatchObject({
      state: 'connected',
      runtimeInfo: { nodeId: 'office', machineId: 'machine-office', agentInstanceId: 'agent-one' }
    });
    await expect(registry.connect('missing')).rejects.toMatchObject({ code: 'NODE_OFFLINE' });
    await registry.disconnect('office');
    expect(live.closed).toBe(1);
    expect(await registry.get('office')).toMatchObject({ state: 'disconnected', runtimeInfo: null });
  });

  it('uses a fresh ephemeral connection for testConnection without replacing the live connection', async () => {
    const { registry, opened } = harness();
    await registry.upsertRemote({ id: 'office', name: 'Office', endpoint: 'ws://office.test:8766' }, 'token');
    const live = await registry.connect('office');
    expect(opened).toHaveLength(1);
    const tested = await registry.testConnection('office');
    expect(tested.agentInstanceId).toBe('agent-2');
    expect(opened).toHaveLength(2);
    expect(opened[1]!.connection.closed).toBe(1);
    expect(await registry.currentConnection('office')).toBe(live);
    expect(await registry.get('office')).toMatchObject({ state: 'connected', runtimeInfo: { agentInstanceId: 'agent-1' } });
  });

  it('invalidates a live connection on config or credential epoch changes', async () => {
    const { registry, opened } = harness();
    await registry.upsertRemote({ id: 'office', name: 'Office', endpoint: 'ws://office.test:8766' }, 'one');
    await registry.connect('office');
    expect(opened[0]!.connection.closed).toBe(0);
    const changed = await registry.setCredential('office', 'two');
    expect(changed.configVersion).toBe(2);
    expect(opened[0]!.connection.closed).toBe(1);
    expect(await registry.get('office')).toMatchObject({ state: 'disconnected', runtimeInfo: null });
  });

  it('serializes credential rotation after a concurrent config edit instead of restoring stale config', async () => {
    const { registry } = harness();
    await registry.upsertRemote({ id: 'office', name: 'Old name', endpoint: 'ws://old.test:8766' }, 'one');
    const changed = registry.upsertRemote({ id: 'office', name: 'New name', endpoint: 'ws://new.test:9000' });
    const rotated = registry.setCredential('office', 'two');
    await expect(changed).resolves.toMatchObject({ configVersion: 2 });
    await expect(rotated).resolves.toMatchObject({ configVersion: 3, name: 'New name', endpoint: 'ws://new.test:9000/' });
    expect((await registry.get('office'))?.config).toMatchObject({ configVersion: 3, name: 'New name', endpoint: 'ws://new.test:9000/' });
  });

  it('projects a typed connection failure after a previously ready node disconnects', async () => {
    const { registry, opened } = harness();
    await registry.upsertRemote({ id: 'office', name: 'Office', endpoint: 'ws://office.test:8766' }, 'token');
    await registry.connect('office');
    opened[0]!.connection.fail(new RemoteNodeConnectionError('NODE_OFFLINE', 'heartbeat timed out'));
    expect(await registry.get('office')).toMatchObject({
      state: 'error',
      runtimeInfo: null,
      error: { code: 'NODE_OFFLINE', message: expect.stringContaining('heartbeat timed out') }
    });
    expect(await registry.currentConnection('office')).toBeNull();
  });

  it('holds config/disconnect revocation behind the final execution check and rejects the old epoch afterwards', async () => {
    const { registry, opened } = harness();
    const config = await registry.upsertRemote({ id: 'office', name: 'Office', endpoint: 'ws://office.test:8766' }, 'one');
    await registry.connect('office');
    const info = (await registry.get('office'))!.runtimeInfo!;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let entered = false;
    const execution = registry.withExecutionConnection({
      nodeId: 'office',
      nodeConfigVersion: config.configVersion,
      machineId: info.machineId,
      agentInstanceId: info.agentInstanceId
    }, async connection => {
      entered = true;
      expect(connection).toBe(await registry.currentConnection('office'));
      await blocked;
      return 'finished-on-old-instance';
    });

    while (!entered) await Promise.resolve();
    const rotated = registry.setCredential('office', 'two');
    await Promise.resolve();
    expect(opened[0]!.connection.closed).toBe(0);
    release();
    await expect(execution).resolves.toBe('finished-on-old-instance');
    await expect(rotated).resolves.toMatchObject({ configVersion: config.configVersion + 1 });
    expect(opened[0]!.connection.closed).toBe(1);

    await expect(registry.withExecutionConnection({
      nodeId: 'office',
      nodeConfigVersion: config.configVersion,
      machineId: info.machineId,
      agentInstanceId: info.agentInstanceId
    }, async () => 'must-not-run')).rejects.toMatchObject({ code: 'TARGET_CHANGED' });
  });

  it('requires the frozen machine and agent instance when leasing a remote connection', async () => {
    const { registry } = harness();
    const config = await registry.upsertRemote({ id: 'office', name: 'Office', endpoint: 'ws://office.test:8766' }, 'token');
    await registry.connect('office');
    const info = (await registry.get('office'))!.runtimeInfo!;

    await expect(registry.withExecutionConnection({
      nodeId: 'office', nodeConfigVersion: config.configVersion,
      machineId: 'another-machine', agentInstanceId: info.agentInstanceId
    }, async () => undefined)).rejects.toMatchObject({ code: 'NODE_IDENTITY_MISMATCH' });
    await expect(registry.withExecutionConnection({
      nodeId: 'office', nodeConfigVersion: config.configVersion,
      machineId: info.machineId, agentInstanceId: 'another-agent'
    }, async () => undefined)).rejects.toMatchObject({ code: 'TARGET_CHANGED' });
  });

  it('fails auth without a stored credential and records only the typed node status', async () => {
    const { registry, secrets } = harness();
    const config = await registry.upsertRemote({ id: 'office', name: 'Office', endpoint: 'ws://office.test:8766' }, 'token');
    secrets.delete(config.credentialRef!);
    await expect(registry.connect('office')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(await registry.get('office')).toMatchObject({ state: 'error', runtimeInfo: null, error: { code: 'AUTH_FAILED' } });
  });

  it('will not dereference a durable credentialRef outside the node secret namespace', async () => {
    await writeDurableNow('node-registry', {
      version: 1,
      lastConfigVersion: 8,
      nodes: [{
        id: 'hostile', name: 'Hostile', transport: 'remote-stdio-ws', endpoint: 'ws://hostile.test',
        credentialRef: 'openaiApiKey', configVersion: 8
      }]
    });
    const registry = harness().registry;
    await expect(registry.initialize()).rejects.toMatchObject({ code: 'TARGET_CONTEXT_UNRESOLVED' });
  });

  it('rejects replacement or removal of the local built-in node', async () => {
    const { registry } = harness();
    await expect(registry.upsertRemote({ id: 'local', name: 'Other', endpoint: 'ws://other.test' }, 'token'))
      .rejects.toBeInstanceOf(NodeRegistryError);
    await expect(registry.removeRemote('local')).rejects.toMatchObject({ code: 'TARGET_CHANGED' });
  });
});
