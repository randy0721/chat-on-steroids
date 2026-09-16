import { randomBytes } from 'node:crypto';
import { executionHandleSchema, type ExecutionHandle } from '../../shared/nodes.js';

const MAX_HANDLES = 10_000;

export interface HandleOwner {
  sessionId: string;
  nodeId: string;
  bindingVersion: number;
  agentInstanceId: string;
}

export class ExecutionHandleError extends Error {
  readonly code = 'HANDLE_EXPIRED' as const;

  constructor(detail = 'the execution handle no longer belongs to this session, binding, node, or agent instance') {
    super(`HANDLE_EXPIRED: ${detail}`);
    this.name = 'ExecutionHandleError';
  }
}

function opaqueId(): string {
  return `nh_${randomBytes(24).toString('base64url')}`;
}

function ownerMatches(handle: ExecutionHandle, owner: HandleOwner): boolean {
  return handle.sessionId === owner.sessionId &&
    handle.nodeId === owner.nodeId &&
    handle.bindingVersion === owner.bindingVersion &&
    handle.agentInstanceId === owner.agentInstanceId;
}

/**
 * Process-local indirection for remote process/session handles. Model-visible callers receive only
 * the random opaque id. Resolution requires the exact durable session binding and the exact live
 * agent instance that created it, so Compact & Resume target changes and node restarts cannot
 * accidentally reuse remote authority from an older execution epoch.
 */
export class ExecutionHandleStore {
  private readonly handles = new Map<string, ExecutionHandle>();

  create(owner: HandleOwner, remoteHandle: string): string {
    const parsed = executionHandleSchema.omit({ id: true }).parse({ ...owner, remoteHandle });
    let id = opaqueId();
    while (this.handles.has(id)) id = opaqueId();
    const handle = executionHandleSchema.parse({ id, ...parsed });
    this.handles.set(id, handle);
    this.trim();
    return id;
  }

  resolve(id: string, owner: HandleOwner): ExecutionHandle {
    const handle = this.handles.get(id);
    if (!handle || !ownerMatches(handle, owner)) throw new ExecutionHandleError();
    // Return a clone so no caller can mutate the ownership record held by the store.
    return { ...handle };
  }

  remote(id: string, owner: HandleOwner): string {
    return this.resolve(id, owner).remoteHandle;
  }

  revoke(id: string): boolean {
    return this.handles.delete(id);
  }

  revokeSession(sessionId: string): number {
    let removed = 0;
    for (const [id, handle] of this.handles) {
      if (handle.sessionId !== sessionId) continue;
      this.handles.delete(id);
      removed += 1;
    }
    return removed;
  }

  countSession(sessionId: string): number {
    let count = 0;
    for (const handle of this.handles.values()) {
      if (handle.sessionId === sessionId) count += 1;
    }
    return count;
  }

  clear(): void {
    this.handles.clear();
  }

  get size(): number {
    return this.handles.size;
  }

  private trim(): void {
    while (this.handles.size > MAX_HANDLES) {
      const oldest = this.handles.keys().next().value as string | undefined;
      if (!oldest) return;
      this.handles.delete(oldest);
    }
  }
}

export const executionHandles = new ExecutionHandleStore();
