import { beforeEach, expect, it, vi } from 'vitest';
import type { InputArgs, InputEntry } from '../src/main/session/input.js';
const ports = vi.hoisted(() => ({ backgroundChats: false, running: false as boolean | null, connect: vi.fn(), status: { state: 'connected', detail: '' },
  browser: { connected: false, present: false, lastSeenAt: null as number | null, compatible: null as boolean | null }, open: vi.fn(), bridge: vi.fn(), enqueue: vi.fn(), cancel: vi.fn(), note: vi.fn(),
  createSession: vi.fn(), projectWorkspace: vi.fn(), rows: [] as InputEntry[], listeners: new Set<() => void>() }));
vi.mock('../src/main/connection.js', () => ({ connect: ports.connect, getStatus: () => ports.status, onStatusChange: (fn: () => void) => { ports.listeners.add(fn); return () => ports.listeners.delete(fn); } }));
vi.mock('../src/main/bridge.js', () => ({ bridgeStatus: async () => ports.browser, browserWakeConnected: () => ports.browser.connected, startBridge: ports.bridge }));
vi.mock('../src/main/browser.js', () => ({ openInPreferredBrowser: ports.open, isPreferredBrowserRunning: async () => ports.running }));
vi.mock('../src/main/config.js', () => ({ getConfig: () => ({ ui: { backgroundChats: ports.backgroundChats } }) }));
vi.mock('../src/main/session/input.js', () => ({ enqueueInput: ports.enqueue, cancelInput: ports.cancel, noteInputStartupError: ports.note, listInputs: async () => ports.rows }));
vi.mock('../src/main/session/store.js', () => ({ createSession: ports.createSession, getSession: vi.fn(), withSessionExecutionTargetLease: async (_id: string, _target: unknown, work: () => Promise<unknown>) => work() }));
vi.mock('../src/main/projects.js', () => ({ projectWorkspace: ports.projectWorkspace }));
import { sendDesktopInput, cancelDesktopInput, retryQueuedInputBrowser, resetInputStartupForTests } from '../src/main/session/start-input.js';
const request: InputArgs = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', sessionId: null, text: 'Please start', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null };
beforeEach(() => {
  vi.resetAllMocks(); resetInputStartupForTests();
  ports.rows = []; ports.listeners.clear(); ports.backgroundChats = false; ports.running = false;
  ports.status = { state: 'connected', detail: '' }; ports.browser = { connected: false, present: false, lastSeenAt: null, compatible: null };
  ports.bridge.mockResolvedValue(8765); ports.open.mockResolvedValue('chrome.exe');
  ports.createSession.mockResolvedValue({ id: 'session-created', conversationId: null });
  ports.projectWorkspace.mockResolvedValue({ virtual: '/work/project', real: '/native/project' });
  ports.enqueue.mockImplementation(async (input: InputArgs, _finishOwner?: unknown, options?: { opening?: boolean }): Promise<InputEntry> => {
    const row: InputEntry = { ...input, ...(options?.opening ? { opening: true } : {}), state: 'queued', owner: null, createdAt: 1,
      conversationId: options?.opening ? null : input.sessionId ? 'exact-conversation' : null };
    ports.rows.push(row); return row;
  });
  ports.note.mockImplementation(async (id, error) => { const row = ports.rows.find(entry => entry.id === id); if (row) row.error = error ?? undefined; return row; });
});
it('waits for the existing connector readiness event before publishing input', async () => {
  ports.status = { state: 'connecting-tunnel', detail: 'Starting tunnel' };
  const pending = sendDesktopInput(request, { nodeId: 'local', workspace: null });
  await vi.waitFor(() => expect(ports.listeners.size).toBe(1));
  expect(ports.enqueue).not.toHaveBeenCalled(); expect(ports.open).not.toHaveBeenCalled();
  ports.status = { state: 'connected', detail: '' };
  for (const listener of ports.listeners) listener();
  await pending;
  expect(ports.enqueue).toHaveBeenCalledTimes(1); expect(ports.listeners.size).toBe(0);
  expect(ports.createSession).toHaveBeenCalledTimes(1);
  expect(ports.createSession.mock.invocationCallOrder[0]).toBeLessThan(ports.enqueue.mock.invocationCallOrder[0]!);
  expect(ports.enqueue.mock.calls[0]?.[0]).toMatchObject({ sessionId: 'session-created' });
  expect(ports.enqueue.mock.calls[0]?.[2]).toMatchObject({ opening: true, executionSnapshot: { nodeId: 'local', sessionId: 'session-created', inputId: request.id } });
});
it('retries only the failed browser wake for the same queued UUID', async () => {
  ports.open.mockRejectedValueOnce(new Error('startup refused'));
  await sendDesktopInput(request, { nodeId: 'local', workspace: null });
  expect(ports.rows[0]?.error).toContain('Browser startup failed');
  await Promise.all([retryQueuedInputBrowser(request.id), retryQueuedInputBrowser(request.id)]);
  expect(ports.open).toHaveBeenCalledTimes(2);
  expect(ports.enqueue).toHaveBeenCalledTimes(1);
  expect(ports.rows).toHaveLength(1);
  expect(ports.rows[0]).toMatchObject({ id: request.id, state: 'queued', error: undefined });
  expect(await retryQueuedInputBrowser(request.id)).toBeNull();
  ports.rows[0]!.state = 'browser'; ports.rows[0]!.error = 'Message queued. Browser startup failed: old';
  expect(await retryQueuedInputBrowser(request.id)).toBeNull();
});
it('connects before publication and opens exactly one marked bootstrap while Chrome starts', async () => {
  let release!: () => void;
  ports.open.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve('chrome.exe'); }));
  const first = sendDesktopInput(request, { nodeId: 'local', workspace: null });
  await vi.waitFor(() => expect(ports.open).toHaveBeenCalledTimes(1));
  const second = sendDesktopInput({ ...request, id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' }, { nodeId: 'local', workspace: null });
  await vi.waitFor(() => expect(ports.enqueue).toHaveBeenCalledTimes(2));
  expect(ports.open).toHaveBeenCalledTimes(1); release(); await Promise.all([first, second]);
  const url = new URL(ports.open.mock.calls[0]![0]);
  expect(url.searchParams.get('cos-input')).toBe(request.id);
  expect(ports.connect.mock.invocationCallOrder[0]).toBeLessThan(ports.enqueue.mock.invocationCallOrder[0]!);
});
it('preserves setup failures without queueing or opening a browser', async () => {
  ports.status = { state: 'disconnected', detail: 'Add a folder before connecting.' };
  await expect(sendDesktopInput(request, { nodeId: 'local', workspace: null })).rejects.toThrow('Add a folder');
  expect(ports.enqueue).not.toHaveBeenCalled(); expect(ports.open).not.toHaveBeenCalled();
});
it('keeps a failed browser launch queued and opens existing targets by exact identity', async () => {
  ports.open.mockRejectedValueOnce(new Error('Chrome refused startup'));
  expect(await sendDesktopInput({ ...request, sessionId: 'session-existing' }, undefined, { nodeId: 'local', workspace: null, bindingVersion: 1, nodeConfigVersion: 1 })).toMatchObject({ state: 'queued' });
  expect(ports.open).toHaveBeenCalledWith('https://chatgpt.com/c/exact-conversation');
  expect(ports.note).toHaveBeenCalledWith(request.id, expect.stringContaining('Message queued. Browser startup failed'));
  ports.browser = { connected: true, present: true, lastSeenAt: 10, compatible: true };
  await sendDesktopInput(request, { nodeId: 'local', workspace: null }); expect(ports.open).toHaveBeenCalledTimes(1);
  ports.browser = { connected: false, present: false, lastSeenAt: 10, compatible: true };
  await sendDesktopInput(request, { nodeId: 'local', workspace: null }); expect(ports.open).toHaveBeenCalledTimes(2);
});

it('cancels a first send while waiting for connection without publishing or opening Chrome', async () => {
  ports.status = { state: 'connecting-tunnel', detail: '' };
  const pending = sendDesktopInput(request, { nodeId: 'local', workspace: null });
  const rejected = expect(pending).rejects.toThrow('Input cancelled');
  await vi.waitFor(() => expect(ports.listeners.size).toBe(1));
  expect(await cancelDesktopInput(request.id)).toBe(true);
  await rejected;
  expect(ports.listeners.size).toBe(0);
  expect(ports.enqueue).not.toHaveBeenCalled();
  expect(ports.open).not.toHaveBeenCalled();
});
it('leaves delivery with the existing browser while its wake transport reconnects', async () => {
  ports.running = true;
  ports.browser = { connected: false, present: true, lastSeenAt: Date.now(), compatible: true };
  await sendDesktopInput(request, { nodeId: 'local', workspace: null });
  expect(ports.open).not.toHaveBeenCalled();
  expect(ports.rows[0]).toMatchObject({ state: 'queued', error: undefined });
});
it('preserves background placement for a cold authored send and its explicit retry', async () => {
  ports.backgroundChats = true;
  ports.open.mockRejectedValueOnce(new Error('startup refused'));
  await sendDesktopInput(request, { nodeId: 'local', workspace: null });
  await retryQueuedInputBrowser(request.id);
  expect(ports.open).toHaveBeenCalledTimes(2);
  for (const call of ports.open.mock.calls) expect(call[1]).toEqual({ backgroundStartup: true });
  expect(ports.enqueue).toHaveBeenCalledTimes(1);
});
it('cancels an enqueue that commits after the user stopped startup', async () => {
  let commit!: () => void;
  ports.enqueue.mockImplementation(() => new Promise(resolve => { commit = () => resolve({ ...request, state: 'queued' }); }));
  const pending = sendDesktopInput(request, { nodeId: 'local', workspace: null });
  const rejected = expect(pending).rejects.toThrow('Input cancelled');
  await vi.waitFor(() => expect(ports.enqueue).toHaveBeenCalled());
  expect(await cancelDesktopInput(request.id)).toBe(true);
  commit(); await rejected;
  expect(ports.cancel).toHaveBeenCalledWith(request.id);
  expect(ports.open).not.toHaveBeenCalled();
});

it.each([true, null])('queues authored input without activating a running or unknown browser (%s)', async state => {
  ports.running = state;
  await sendDesktopInput(request, { nodeId: 'local', workspace: null });
  expect(ports.open).not.toHaveBeenCalled();
  expect(ports.rows[0]).toMatchObject({ state: 'queued', error: undefined });
});

it('refuses a missing explicit selection before starting the connection or browser', async () => {
  await expect(sendDesktopInput(request)).rejects.toThrow('TARGET_CONTEXT_UNRESOLVED');
  expect(ports.connect).not.toHaveBeenCalled();
  expect(ports.enqueue).not.toHaveBeenCalled();
  expect(ports.open).not.toHaveBeenCalled();
});

it('freezes the click-time binding before connection readiness and ignores later selection mutation', async () => {
  ports.status = { state: 'connecting-tunnel', detail: '' };
  const target = { nodeId: 'local', workspace: null, bindingVersion: 1, nodeConfigVersion: 1 };
  const pending = sendDesktopInput({ ...request, sessionId: 'session-existing' }, undefined, target);
  await vi.waitFor(() => expect(ports.listeners.size).toBe(1));
  target.nodeId = 'other-computer';
  ports.status = { state: 'connected', detail: '' };
  for (const listener of ports.listeners) listener();
  await pending;
  expect(ports.enqueue.mock.calls[0]?.[2]?.executionSnapshot).toMatchObject({ nodeId: 'local', sessionId: 'session-existing', inputId: request.id });
});

it('rejects a known incompatible extension before publishing an input or connecting', async () => {
  ports.browser.compatible = false;
  await expect(sendDesktopInput(request, { nodeId: 'local', workspace: null })).rejects.toThrow('execution-proof protocol is incompatible');
  expect(ports.createSession).not.toHaveBeenCalled();
  expect(ports.enqueue).not.toHaveBeenCalled();
  expect(ports.connect).not.toHaveBeenCalled();
});
