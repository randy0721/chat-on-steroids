import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import {
  attachInitialConversation,
  bindSessionExecutionTarget,
  createSession,
  getSession,
  initSessionStore,
  resetSessionStoreForTests,
  withSessionExecutionTargetLease
} from '../src/main/session/store.js';
import { executionAdmission, freezeExecution, freezeLocalExecution } from '../src/main/nodes/router.js';
import { nodeRegistry } from '../src/main/nodes/registry.js';
import { LOCAL_NODE_CONFIG_VERSION, LOCAL_NODE_ID } from '../src/shared/nodes.js';
import { emptyEvidence, type CallContext } from '../src/main/mcp/call-context.js';

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-nodes-'));
  initDurableStore(directory);
  initSessionStore(directory);
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetSessionStoreForTests();
  resetDurableForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('session-bound execution foundation', () => {
  it('persists a target before conversation attachment and increments every accepted binding epoch', async () => {
    const created = await createSession({ conversationId: null, title: 'Opening' });
    expect(created.executionTarget).toEqual({
      nodeId: LOCAL_NODE_ID,
      workspace: null,
      bindingVersion: 1,
      nodeConfigVersion: LOCAL_NODE_CONFIG_VERSION
    });

    const remote = await bindSessionExecutionTarget(created.id, {
      nodeId: 'office-windows', workspace: 'C:\\work\\crm', nodeConfigVersion: 7
    });
    expect(remote.bindingVersion).toBe(2);
    const localAgain = await bindSessionExecutionTarget(created.id, {
      nodeId: LOCAL_NODE_ID, workspace: null, nodeConfigVersion: LOCAL_NODE_CONFIG_VERSION
    });
    expect(localAgain.bindingVersion).toBe(3);

    expect(await attachInitialConversation(created.id, 'conversation-one')).toBe(true);
    expect(await attachInitialConversation(created.id, 'conversation-two')).toBe(false);
    resetSessionStoreForTests();
    initSessionStore(directory);
    expect(await getSession(created.id)).toMatchObject({
      conversationId: 'conversation-one',
      executionTarget: { nodeId: LOCAL_NODE_ID, bindingVersion: 3 }
    });
  });

  it('freezes the local executor instance and refuses a rebound or remote session before handler execution', async () => {
    const session = await createSession({ conversationId: 'conversation-one', title: 'Bound' });
    const inputId = randomUUID();
    const execution = freezeLocalExecution(session.executionTarget!, session.id, inputId);
    const context: CallContext = {
      startedAt: Date.now(), transportKey: null, agent: null, outcome: null, evidence: emptyEvidence(),
      caller: { transportKey: null, requestId: 'request-one', conversationId: 'conversation-one', sessionId: session.id },
      execution
    };
    expect(await executionAdmission(context, 'core', 'read')).toBeNull();
    expect((await executionAdmission({ ...context, execution: null }, 'core', 'read'))?.code)
      .toBe('TARGET_CONTEXT_UNRESOLVED');
    expect((await executionAdmission({ ...context, caller: { ...context.caller, conversationId: null, sessionId: null }, execution: null }, 'core', 'exec_command'))?.code)
      .toBe('TARGET_CONTEXT_UNRESOLVED');

    await bindSessionExecutionTarget(session.id, { nodeId: 'office-windows', workspace: 'C:\\work', nodeConfigVersion: 2 });
    expect((await executionAdmission(context, 'core', 'read'))?.code).toBe('TARGET_CHANGED');
    expect((await executionAdmission({ ...context, execution: null }, 'core', 'exec_command'))?.code).toBe('TARGET_CONTEXT_UNRESOLVED');
    const rebound = await getSession(session.id);
    expect(() => freezeLocalExecution(rebound!.executionTarget!, session.id, randomUUID()))
      .toThrow('NODE_OFFLINE');
  });

  it('freezes an already-ready remote runtime and refuses config or agent drift without local fallback', async () => {
    const session = await createSession({ conversationId: 'conversation-remote', title: 'Remote' });
    const target = await bindSessionExecutionTarget(session.id, {
      nodeId: 'office-windows', workspace: 'C:\\work\\crm', nodeConfigVersion: 7
    });
    const runtime = {
      nodeId: 'office-windows', machineId: 'office-machine', agentInstanceId: 'agent-one',
      platform: 'win32' as const, defaultShell: 'PowerShell', approvedRoots: ['C:\\work'],
      capabilities: ['files', 'terminal'], protocolVersion: 1
    };
    vi.spyOn(nodeRegistry, 'get').mockResolvedValue({
      config: {
        id: 'office-windows', name: 'Office', transport: 'remote-stdio-ws', endpoint: 'ws://office.test',
        credentialRef: 'setup:node:test:7', expectedMachineId: 'office-machine', configVersion: 7
      },
      state: 'connected', runtimeInfo: runtime, error: null
    });
    vi.spyOn(nodeRegistry, 'currentConnection').mockResolvedValue({ runtimeInfo: runtime } as never);

    const execution = await freezeExecution(target, session.id, randomUUID());
    expect(execution).toMatchObject({
      nodeId: 'office-windows', workspace: 'C:\\work\\crm', bindingVersion: target.bindingVersion,
      nodeConfigVersion: 7, machineId: 'office-machine', agentInstanceId: 'agent-one'
    });
    const context: CallContext = {
      startedAt: Date.now(), transportKey: null, agent: null, outcome: null, evidence: emptyEvidence(),
      caller: { transportKey: null, requestId: 'request-remote', conversationId: 'conversation-remote', sessionId: session.id },
      execution
    };
    expect(await executionAdmission(context, 'core', 'read')).toBeNull();

    vi.mocked(nodeRegistry.currentConnection).mockResolvedValue({
      runtimeInfo: { ...runtime, agentInstanceId: 'agent-two' }
    } as never);
    expect((await executionAdmission(context, 'core', 'read'))?.code).toBe('TARGET_CHANGED');

    vi.mocked(nodeRegistry.get).mockResolvedValue({
      config: {
        id: 'office-windows', name: 'Office', transport: 'remote-stdio-ws', endpoint: 'ws://office.test',
        credentialRef: 'setup:node:test:8', expectedMachineId: 'office-machine', configVersion: 8
      },
      state: 'disconnected', runtimeInfo: null, error: null
    });
    expect((await executionAdmission(context, 'core', 'read'))?.code).toBe('TARGET_CHANGED');
  });

  it('serializes a target rebind behind an execution lease on the frozen session epoch', async () => {
    const session = await createSession({ conversationId: 'conversation-lease', title: 'Lease' });
    const original = session.executionTarget!;
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    let entered = false;
    const running = withSessionExecutionTargetLease(session.id, original, async () => {
      entered = true;
      await wait;
      return 'old-target-finished';
    });
    while (!entered) await Promise.resolve();

    let rebound = false;
    const binding = bindSessionExecutionTarget(session.id, {
      nodeId: 'office-windows', workspace: 'C:\\work', nodeConfigVersion: 4
    }).then(value => {
      rebound = true;
      return value;
    });
    await Promise.resolve();
    expect(rebound).toBe(false);

    release();
    await expect(running).resolves.toBe('old-target-finished');
    const next = await binding;
    expect(next.bindingVersion).toBe(original.bindingVersion + 1);
    await expect(withSessionExecutionTargetLease(session.id, original, async () => 'must-not-run'))
      .rejects.toMatchObject({ code: 'TARGET_CHANGED' });
  });
});
