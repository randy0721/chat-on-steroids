/** Explicit desktop sends bring up the existing connection/browser authorities. */
import { connect, getStatus, onStatusChange } from '../connection.js';
import { startBridge, bridgeStatus } from '../bridge.js';
import { wakeBrowserUrl, resetBrowserStartupForTests } from '../browser-startup.js';
import { getConfig } from '../config.js';
import { enqueueInput, cancelInput, listInputs, noteInputStartupError, type InputArgs, type InputEntry } from './input.js';
import { createSession, withSessionExecutionTargetLease } from './store.js';
import { projectWorkspace } from '../projects.js';
import { userTitle } from './title.js';
import { freezeExecution, localExecutionTarget } from '../nodes/router.js';
import { nodeRegistry } from '../nodes/registry.js';
import { validateRemoteWorkspace } from '../nodes-ipc.js';
import type { OpeningExecutionSelection } from '../../shared/types.js';
import type { ExecutionTarget } from '../../shared/nodes.js';

function wakeBrowser(entry: InputEntry, retry = false): Promise<void> {
  const marker = `cos-input=${encodeURIComponent(entry.id)}`;
  return wakeBrowserUrl(entry.conversationId ? `https://chatgpt.com/c/${encodeURIComponent(entry.conversationId)}` : `https://chatgpt.com/?${marker}#${marker}`, retry, getConfig().ui.backgroundChats === true);
}
async function assertBrowserProtocol(): Promise<void> {
  if ((await bridgeStatus()).compatible === false) {
    throw new Error('TARGET_CONTEXT_UNRESOLVED: reload the Chat On Steroids browser extension and refresh the ChatGPT page before sending; its execution-proof protocol is incompatible');
  }
}
async function ready(signal?: AbortSignal): Promise<void> {
  await connect();
  signal?.throwIfAborted();
  // startTunnel returns a lifecycle handle before OpenAI /readyz or cloudflared's URL.
  // Await that existing status authority for this operation; never publish input early.
  await new Promise<void>((resolve, reject) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => { unsubscribe(); signal?.removeEventListener('abort', abort); reject(new Error('The connector did not become ready. Check its connection status and try again.')); }, 65000);
    timer.unref?.();
    const abort = () => { clearTimeout(timer); unsubscribe(); reject(signal?.reason); };
    signal?.addEventListener('abort', abort, { once: true });
    const inspect = () => {
      const status = getStatus();
      if (['starting-server', 'connecting-tunnel', 'offline'].includes(status.state)) return;
      clearTimeout(timer); unsubscribe(); signal?.removeEventListener('abort', abort);
      if (status.state === 'connected') resolve();
      else reject(new Error(status.detail || 'Finish connection setup before sending.'));
    };
    unsubscribe = onStatusChange(inspect); inspect();
  });
  if (!await startBridge()) throw new Error('The browser bridge could not start. Your message has not been queued.');
  await assertBrowserProtocol();
}
async function deliver(entry: InputEntry, retry = false): Promise<InputEntry> {
  try {
    await wakeBrowser(entry, retry);
    return await noteInputStartupError(entry.id, null) ?? entry;
  } catch (error) {
    return await noteInputStartupError(entry.id, `Message queued. Browser startup failed: ${(error as Error).message}`) ?? entry;
  }
}
// Only in-progress pre-publication work lives here; durable outbox state owns delivery.
const starting = new Map<string, AbortController>();
export async function cancelDesktopInput(id: string): Promise<boolean> {
  const start = starting.get(id);
  if (start) { start.abort(new Error('Input cancelled')); return true; }
  return cancelInput(id);
}
async function openingExecutionTarget(
  selection: OpeningExecutionSelection | undefined,
  localWorkspace: string | null
): Promise<ExecutionTarget> {
  if (!selection) throw new Error('TARGET_CONTEXT_UNRESOLVED: choose an execution computer before sending');
  if (selection.nodeId === 'local') return localExecutionTarget(localWorkspace);
  const snapshot = await nodeRegistry.get(selection.nodeId);
  if (!snapshot || snapshot.config.transport !== 'remote-stdio-ws') {
    throw new Error(`NODE_OFFLINE: Remote node ${selection.nodeId} is not configured`);
  }
  if (snapshot.state !== 'connected' || !snapshot.runtimeInfo) {
    throw new Error(`NODE_OFFLINE: Remote node ${snapshot.config.name} is not connected`);
  }
  if (!selection.workspace) throw new Error('TARGET_CONTEXT_UNRESOLVED: choose an approved remote workspace before sending');
  const workspace = validateRemoteWorkspace(snapshot.runtimeInfo, selection.workspace).workspace;
  return {
    nodeId: snapshot.config.id,
    workspace,
    bindingVersion: 1,
    nodeConfigVersion: snapshot.config.configVersion
  };
}

export async function sendDesktopInput(
  input: InputArgs,
  openingExecution?: OpeningExecutionSelection,
  expectedExecutionTarget?: ExecutionTarget
): Promise<InputEntry> {
  if (input.sessionId !== null && openingExecution) {
    throw new Error('Execution target selection cannot rebind an existing session');
  }
  if (starting.has(input.id)) throw new Error('Input already starting');
  const controller = new AbortController(); starting.set(input.id, controller);
  try {
    await assertBrowserProtocol();
    let admitted = input;
    let opening = false;
    let executionTarget = expectedExecutionTarget ? { ...expectedExecutionTarget } : null;
    if (input.sessionId === null) {
      // The durable session owns target selection before any browser side effect. Renderer
      // selection is only opening intent: main re-validates the exact live node/config/workspace,
      // persists that binding, and only then freezes/enqueues the first input.
      const workspace = input.projectId ? await projectWorkspace(input.projectId) : null;
      controller.signal.throwIfAborted();
      executionTarget = await openingExecutionTarget(openingExecution, workspace?.virtual ?? null);
      controller.signal.throwIfAborted();
      const session = await createSession({
        conversationId: null,
        title: userTitle(input.text, input.text) || 'New chat',
        titleSource: 'fallback',
        origin: { kind: 'desktop', fromSessionId: null, agentId: null, task: '' },
        ...(input.projectId ? { projectId: input.projectId } : {}),
        executionTarget
      });
      admitted = { ...input, sessionId: session.id };
      opening = true;
    }
    if (!executionTarget) throw new Error('TARGET_CONTEXT_UNRESOLVED: this send has no selected execution binding; select the computer again');
    const sessionId = admitted.sessionId!;
    // 在连接等待之前冻结；后续 UI 切换不能改变这条 input 的目标或执行器实例。
    const executionSnapshot = await withSessionExecutionTargetLease(sessionId, executionTarget,
      () => freezeExecution(executionTarget!, sessionId, input.id));
    if (input.mode !== 'finish') await ready(controller.signal);
    controller.signal.throwIfAborted();
    const entry = await enqueueInput(admitted, undefined, { opening, executionSnapshot });
    // Cancellation can arrive while the durable enqueue is committing.
    if (controller.signal.aborted) { await cancelInput(input.id); controller.signal.throwIfAborted(); }
    starting.delete(input.id);
    if (entry.state !== 'queued' || entry.attachmentDelivery === 'tool' || input.mode === 'finish') return entry;
    return deliver(entry);
  } finally { if (starting.get(input.id) === controller) starting.delete(input.id); }
}
export async function retryQueuedInputBrowser(id: string): Promise<InputEntry | null> {
  const eligible = (entry: InputEntry | undefined): entry is InputEntry => !!entry && entry.state === 'queued' && entry.purpose !== 'decision' && !!entry.error?.startsWith('Message queued. Browser startup failed:');
  if (!eligible((await listInputs()).find(entry => entry.id === id))) return null;
  await ready();
  const entry = (await listInputs()).find(row => row.id === id);
  return eligible(entry) ? deliver(entry, true) : null;
}
export function resetInputStartupForTests(): void { resetBrowserStartupForTests(); starting.clear(); }
