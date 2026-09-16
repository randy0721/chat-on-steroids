import { describe, expect, it } from 'vitest';
import { ExecutionHandleError, ExecutionHandleStore, type HandleOwner } from '../src/main/nodes/handles.js';

const owner = (overrides: Partial<HandleOwner> = {}): HandleOwner => ({
  sessionId: '2026-09-15-abcd1234',
  nodeId: 'office',
  bindingVersion: 7,
  agentInstanceId: 'agent-instance-one',
  ...overrides
});

describe('ExecutionHandleStore', () => {
  it('returns only an opaque local id and resolves its exact remote handle for the owner epoch', () => {
    const store = new ExecutionHandleStore();
    const id = store.create(owner(), 'remote-process-7391');
    expect(id).toMatch(/^nh_[A-Za-z0-9_-]+$/);
    expect(id).not.toContain('7391');
    expect(store.remote(id, owner())).toBe('remote-process-7391');
    expect(store.resolve(id, owner())).toMatchObject({
      id,
      sessionId: owner().sessionId,
      nodeId: 'office',
      bindingVersion: 7,
      agentInstanceId: 'agent-instance-one',
      remoteHandle: 'remote-process-7391'
    });
  });

  it.each([
    ['cross-session', { sessionId: '2026-09-15-ffff9999' }],
    ['different-node', { nodeId: 'lab' }],
    ['rebind', { bindingVersion: 8 }],
    ['new-agent', { agentInstanceId: 'agent-instance-two' }]
  ] as const)('rejects %s resolution as HANDLE_EXPIRED', (_name, changed) => {
    const store = new ExecutionHandleStore();
    const id = store.create(owner(), 'remote-handle');
    expect(() => store.resolve(id, owner(changed))).toThrow(ExecutionHandleError);
    try {
      store.resolve(id, owner(changed));
    } catch (error) {
      expect(error).toMatchObject({ code: 'HANDLE_EXPIRED' });
      expect((error as Error).message).toContain('HANDLE_EXPIRED');
    }
    // A foreign lookup cannot destroy the rightful owner's handle.
    expect(store.remote(id, owner())).toBe('remote-handle');
  });

  it('expires revoked and session-retired handles without affecting another session', () => {
    const store = new ExecutionHandleStore();
    const first = store.create(owner(), 'one');
    const second = store.create(owner(), 'two');
    const otherOwner = owner({ sessionId: '2026-09-15-feedbeef' });
    const other = store.create(otherOwner, 'other');
    expect(store.countSession(owner().sessionId)).toBe(2);
    expect(store.countSession(otherOwner.sessionId)).toBe(1);
    expect(store.revoke(first)).toBe(true);
    expect(store.countSession(owner().sessionId)).toBe(1);
    expect(() => store.resolve(first, owner())).toThrow('HANDLE_EXPIRED');
    expect(store.revokeSession(owner().sessionId)).toBe(1);
    expect(() => store.resolve(second, owner())).toThrow('HANDLE_EXPIRED');
    expect(store.remote(other, otherOwner)).toBe('other');
    expect(store.size).toBe(1);
  });

  it('keeps identical remote PIDs opaque and isolated across nodes and sessions', () => {
    const store = new ExecutionHandleStore();
    const office = owner();
    const lab = owner({
      sessionId: '2026-09-15-feedbeef',
      nodeId: 'lab',
      agentInstanceId: 'lab-agent-one'
    });
    const officeHandle = store.create(office, '4242');
    const labHandle = store.create(lab, '4242');

    expect(officeHandle).not.toBe(labHandle);
    expect(officeHandle).not.toContain('4242');
    expect(labHandle).not.toContain('4242');
    expect(store.remote(officeHandle, office)).toBe('4242');
    expect(store.remote(labHandle, lab)).toBe('4242');
    expect(() => store.remote(officeHandle, lab)).toThrow('HANDLE_EXPIRED');
    expect(() => store.remote(labHandle, office)).toThrow('HANDLE_EXPIRED');
  });

  it('validates the internal ownership tuple before publishing an opaque handle', () => {
    const store = new ExecutionHandleStore();
    expect(() => store.create(owner({ bindingVersion: 0 }), 'remote')).toThrow();
    expect(() => store.create(owner(), '')).toThrow();
    expect(store.size).toBe(0);
  });
});
