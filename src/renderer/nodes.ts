import type { ExecutionTarget } from '../shared/nodes.js';
import type { OpeningExecutionSelection, RendererNodeView } from '../shared/types.js';
import { $, el, run, toast, executionErrorDialog } from './dom.js';
import { t, ui } from './i18n.js';

const LOCAL_NODE_ID = 'local';

let nodes: RendererNodeView[] = [];
let loading = false;
let composerIsNewChat = true;
let composerSessionId: string | null = null;
let currentBinding: ExecutionTarget | null = null;
let composerNodeId = LOCAL_NODE_ID;
let composerWorkspace = '';
let validatedWorkspace: { nodeId: string; workspace: string } | null = null;
let sessionRebound: ((sessionId: string, target: ExecutionTarget) => void) | null = null;

function nodeById(id: string): RendererNodeView | undefined {
  return nodes.find(node => node.id === id);
}

function statusLabel(node: RendererNodeView): string {
  if (node.status === 'local') return t('Local');
  if (node.status === 'connected') return t('Connected');
  if (node.status === 'connecting') return t('Connecting…');
  if (node.status === 'error') return t('Connection error');
  return t('Disconnected');
}

function replaceNode(next: RendererNodeView): void {
  const index = nodes.findIndex(node => node.id === next.id);
  if (index === -1) nodes.push(next);
  else nodes[index] = next;
  paintRemoteNodes();
  paintComposerSelector();
}

async function refreshNodes(): Promise<void> {
  if (loading) return;
  loading = true;
  try {
    const next = await run(window.api.listNodes());
    if (!next) return;
    nodes = next;
    if (!nodeById(composerNodeId) && currentBinding?.nodeId !== composerNodeId) {
      composerNodeId = LOCAL_NODE_ID;
      composerWorkspace = '';
      validatedWorkspace = null;
    }
    paintRemoteNodes();
    paintComposerSelector();
  } finally {
    loading = false;
  }
}

function actionButton(label: string, action: () => Promise<void>): HTMLButtonElement {
  const button = el('button', 'btn', () => t(label)) as HTMLButtonElement;
  button.type = 'button';
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    try { await action(); }
    finally { button.disabled = false; }
  });
  return button;
}

function openEditor(node?: RendererNodeView): void {
  const editor = $<HTMLFormElement>('remoteNodeEditor');
  $<HTMLInputElement>('remoteNodeId').value = node?.id ?? crypto.randomUUID();
  $<HTMLInputElement>('remoteNodeName').value = node?.name ?? '';
  $<HTMLInputElement>('remoteNodeEndpoint').value = node?.endpoint ?? '';
  $<HTMLInputElement>('remoteNodeMachine').value = node?.expectedMachineId ?? '';
  $<HTMLInputElement>('remoteNodeToken').value = '';
  editor.hidden = false;
  $<HTMLInputElement>('remoteNodeName').focus();
}

function paintRemoteNodes(): void {
  const list = $('remoteNodesList');
  const remote = nodes.filter(node => node.transport === 'remote-stdio-ws');
  if (!remote.length) {
    list.replaceChildren(el('p', 'muted remote-nodes-empty', () => t('No remote nodes configured.')));
    return;
  }
  list.replaceChildren(...remote.map(node => {
    const row = el('div', 'remote-node-row');
    const copy = el('div', 'remote-node-copy');
    const heading = el('div', 'remote-node-heading');
    heading.append(el('b', '', node.name), el('span', `remote-node-status is-${node.status}`, () => statusLabel(node)));
    const endpoint = el('code', 'remote-node-endpoint', node.endpoint ?? '');
    const details = el('span', 'muted', () => node.runtimeInfo
      ? t('{0} · {1} approved roots', [node.runtimeInfo.platform, node.runtimeInfo.approvedRoots.length])
      : node.credentialConfigured ? t('Credential stored') : t('Credential missing'));
    copy.append(heading, endpoint, details);

    const actions = el('div', 'remote-node-actions');
    actions.append(actionButton('Edit', async () => openEditor(node)));
    actions.append(actionButton('Test', async () => {
      const tested = await run(window.api.testNode(node.id));
      if (tested) toast(t('Connection test passed · {0}', [tested.runtimeInfo.machineId]));
      await refreshNodes();
    }));
    if (node.status === 'connected') {
      actions.append(actionButton('Disconnect', async () => {
        const next = await run(window.api.disconnectNode(node.id));
        if (next) replaceNode(next);
      }));
    } else {
      actions.append(actionButton('Connect', async () => {
        const next = await run(window.api.connectNode(node.id));
        if (next) replaceNode(next);
        else await refreshNodes();
      }));
    }
    actions.append(actionButton('Remove', async () => {
      if (!window.confirm(t('Remove remote node “{0}”?', [node.name]))) return;
      const removed = await run(window.api.removeNode(node.id));
      if (!removed) return;
      if (composerNodeId === node.id) resetComposerNodeSelection();
      await refreshNodes();
    }));
    row.append(copy, actions);
    return row;
  }));
}

function setWorkspaceStatus(message: string): void {
  $('composerNodeStatus').textContent = message;
}

async function validateComposerWorkspace(): Promise<void> {
  const node = nodeById(composerNodeId);
  if (!node || node.transport !== 'remote-stdio-ws') return;
  const input = $<HTMLInputElement>('composerWorkspace');
  composerWorkspace = input.value.trim();
  validatedWorkspace = null;
  if (!composerWorkspace) {
    setWorkspaceStatus(t('Choose a workspace inside one of this node’s approved roots.'));
    return;
  }
  const result = await run(window.api.validateNodeWorkspace(node.id, composerWorkspace));
  if (!result || input.value.trim() !== composerWorkspace || composerNodeId !== node.id) return;
  validatedWorkspace = { nodeId: result.nodeId, workspace: result.workspace };
  setWorkspaceStatus(composerIsNewChat
    ? t('Workspace approved · this computer will own the new chat.')
    : t('Workspace approved · switch this chat when ready.'));
  paintRebindAction();
}

function selectionMatchesBinding(): boolean {
  if (!currentBinding || composerNodeId !== currentBinding.nodeId) return false;
  if (composerNodeId === LOCAL_NODE_ID) return true;
  return composerWorkspace === (currentBinding.workspace ?? '');
}

function paintRebindAction(): void {
  const button = $<HTMLButtonElement>('composerNodeRebind');
  button.hidden = composerIsNewChat || composerSessionId === null || selectionMatchesBinding();
  if (button.hidden) return;
  const node = nodeById(composerNodeId);
  const remoteReady = node?.transport !== 'remote-stdio-ws' ||
    (node.status === 'connected' && validatedWorkspace?.nodeId === composerNodeId && validatedWorkspace.workspace === composerWorkspace);
  button.disabled = !node || !remoteReady || button.dataset.busy === 'true';
}

function currentBindingStatus(): string {
  if (!currentBinding) return t('This session has no durable execution binding yet.');
  const node = nodeById(currentBinding.nodeId);
  const name = currentBinding.nodeId === LOCAL_NODE_ID ? t('This computer') : node?.name ?? currentBinding.nodeId;
  const workspace = currentBinding.workspace ? ` · ${currentBinding.workspace}` : '';
  return t('Current binding · {0} · version {1}{2}', [name, currentBinding.bindingVersion, workspace]);
}

function paintComposerSelector(): void {
  const menu = $<HTMLDetailsElement>('nodeMenu');
  menu.hidden = false;
  const select = $<HTMLSelectElement>('composerNode');
  const prior = composerNodeId;
  const options = nodes.map(node => {
    const option = document.createElement('option');
    option.value = node.id;
    option.textContent = node.status === 'local' ? t('This computer') : `${node.name} · ${statusLabel(node)}`;
    return option;
  });
  if (currentBinding && !nodes.some(node => node.id === currentBinding!.nodeId)) {
    const unavailable = document.createElement('option');
    unavailable.value = currentBinding.nodeId;
    unavailable.textContent = t('{0} · unavailable', [currentBinding.nodeId]);
    options.push(unavailable);
  }
  select.replaceChildren(...options);
  if (!nodes.some(node => node.id === prior)) {
    const local = document.createElement('option');
    local.value = LOCAL_NODE_ID; local.textContent = t('This computer');
    select.prepend(local); composerNodeId = LOCAL_NODE_ID;
  }
  select.value = composerNodeId;
  const node = nodeById(composerNodeId);
  ui($('composerNodeLabel'), 'textContent', () => node?.transport === 'remote-stdio-ws' ? node.name : t('This computer'));

  const workspaceRow = $('composerWorkspaceRow');
  const workspaceInput = $<HTMLInputElement>('composerWorkspace');
  const roots = $<HTMLDataListElement>('composerWorkspaceRoots');
  const remote = node?.transport === 'remote-stdio-ws' ? node : null;
  workspaceRow.hidden = !remote;
  roots.replaceChildren(...(remote?.runtimeInfo?.approvedRoots ?? []).map(root => {
    const option = document.createElement('option'); option.value = root; return option;
  }));
  workspaceInput.value = remote ? composerWorkspace : '';
  workspaceInput.disabled = !remote || remote.status !== 'connected';
  if (!composerIsNewChat && selectionMatchesBinding()) setWorkspaceStatus(currentBindingStatus());
  else if (!remote) setWorkspaceStatus(composerIsNewChat ? t('New chats currently open on this computer.') : t('Switch this chat to this computer.'));
  else if (remote.status !== 'connected') setWorkspaceStatus(t('Connect this node in Settings before choosing a workspace.'));
  else if (validatedWorkspace?.nodeId === remote.id && validatedWorkspace.workspace === composerWorkspace) {
    setWorkspaceStatus(composerIsNewChat
      ? t('Workspace approved · this computer will own the new chat.')
      : t('Workspace approved · switch this chat when ready.'));
  } else setWorkspaceStatus(t('Choose a workspace inside one of this node’s approved roots.'));
  paintRebindAction();
}

export function resetComposerNodeSelection(): void {
  composerNodeId = LOCAL_NODE_ID;
  composerWorkspace = '';
  validatedWorkspace = null;
  paintComposerSelector();
}

export function setComposerNodeContext(session: { id: string; executionTarget?: ExecutionTarget } | null): void {
  composerIsNewChat = session === null;
  composerSessionId = session?.id ?? null;
  currentBinding = session?.executionTarget ? { ...session.executionTarget } : null;
  composerNodeId = currentBinding?.nodeId ?? LOCAL_NODE_ID;
  composerWorkspace = currentBinding?.workspace ?? '';
  validatedWorkspace = currentBinding?.nodeId !== LOCAL_NODE_ID && currentBinding?.workspace
    ? { nodeId: currentBinding.nodeId, workspace: currentBinding.workspace }
    : null;
  paintComposerSelector();
}

/** 同步捕获点击发送时的选择，后续模型发现、规划和 IPC 等待只使用这份副本。 */
export function composerExecutionSelection(sessionId: string | null): {
  openingExecution?: OpeningExecutionSelection;
  expectedExecutionTarget?: ExecutionTarget;
} | null {
  if (sessionId !== composerSessionId) {
    executionErrorDialog(t('The selected chat changed. Select it again before sending.')); return null;
  }
  if (!composerIsNewChat) {
    if (!currentBinding || composerNodeId !== currentBinding.nodeId ||
        (composerNodeId !== LOCAL_NODE_ID && composerWorkspace !== currentBinding.workspace)) {
      executionErrorDialog(t('Apply the selected computer binding before sending.')); return null;
    }
    return { expectedExecutionTarget: { ...currentBinding } };
  }
  if (composerNodeId === LOCAL_NODE_ID) return { openingExecution: { nodeId: LOCAL_NODE_ID, workspace: null } };
  if (!validatedWorkspace || validatedWorkspace.nodeId !== composerNodeId || validatedWorkspace.workspace !== composerWorkspace) {
    executionErrorDialog(t('Choose and validate an approved remote workspace before sending.')); return null;
  }
  return { openingExecution: { nodeId: composerNodeId, workspace: composerWorkspace } };
}

async function rebindExistingSession(): Promise<void> {
  const sessionId = composerSessionId;
  if (composerIsNewChat || !sessionId || selectionMatchesBinding()) return;
  const node = nodeById(composerNodeId);
  if (!node) { setWorkspaceStatus(t('The selected execution computer is unavailable.')); return; }
  if (node.transport === 'remote-stdio-ws' &&
      (!validatedWorkspace || validatedWorkspace.nodeId !== node.id || validatedWorkspace.workspace !== composerWorkspace)) {
    setWorkspaceStatus(t('Choose and validate an approved remote workspace before switching this chat.'));
    return;
  }
  const button = $<HTMLButtonElement>('composerNodeRebind');
  button.dataset.busy = 'true';
  paintRebindAction();
  const reply = await window.api.rebindSessionExecution(
    sessionId,
    node.id,
    node.transport === 'remote-stdio-ws' ? composerWorkspace : undefined
  );
  delete button.dataset.busy;
  if (!reply.ok) {
    setWorkspaceStatus(reply.error);
    toast(reply.error);
    paintRebindAction();
    return;
  }
  currentBinding = { ...reply.data };
  composerNodeId = reply.data.nodeId;
  composerWorkspace = reply.data.workspace ?? '';
  validatedWorkspace = reply.data.nodeId !== LOCAL_NODE_ID && reply.data.workspace
    ? { nodeId: reply.data.nodeId, workspace: reply.data.workspace }
    : null;
  sessionRebound?.(sessionId, reply.data);
  paintComposerSelector();
}

export function initNodes(onSessionRebound?: (sessionId: string, target: ExecutionTarget) => void): void {
  sessionRebound = onSessionRebound ?? null;
  $('remoteNodesRefresh').addEventListener('click', () => void refreshNodes());
  $('remoteNodeAdd').addEventListener('click', () => openEditor());
  $('remoteNodeCancel').addEventListener('click', () => { $<HTMLFormElement>('remoteNodeEditor').hidden = true; });
  $<HTMLFormElement>('remoteNodeEditor').addEventListener('submit', async event => {
    event.preventDefault();
    const id = $<HTMLInputElement>('remoteNodeId').value;
    const tokenInput = $<HTMLInputElement>('remoteNodeToken');
    const token = tokenInput.value;
    let saved: RendererNodeView | null = null;
    try {
      saved = await run(window.api.saveNode({
        id,
        name: $<HTMLInputElement>('remoteNodeName').value,
        endpoint: $<HTMLInputElement>('remoteNodeEndpoint').value,
        expectedMachineId: $<HTMLInputElement>('remoteNodeMachine').value || undefined,
        ...(token ? { token } : {})
      }));
    } finally {
      // Never retain a credential in renderer state after the one inward IPC call completes.
      tokenInput.value = '';
    }
    if (!saved) return;
    $<HTMLFormElement>('remoteNodeEditor').hidden = true;
    replaceNode(saved);
  });

  $<HTMLSelectElement>('composerNode').addEventListener('change', event => {
    composerNodeId = (event.currentTarget as HTMLSelectElement).value || LOCAL_NODE_ID;
    composerWorkspace = '';
    validatedWorkspace = null;
    const remote = nodeById(composerNodeId);
    if (remote?.status === 'connected' && remote.runtimeInfo?.approvedRoots[0]) {
      composerWorkspace = remote.runtimeInfo.approvedRoots[0];
    }
    paintComposerSelector();
    if (composerWorkspace) void validateComposerWorkspace();
  });
  $<HTMLInputElement>('composerWorkspace').addEventListener('input', event => {
    composerWorkspace = (event.currentTarget as HTMLInputElement).value.trim();
    validatedWorkspace = null;
    setWorkspaceStatus(t('Validate this remote workspace before sending.'));
  });
  $<HTMLInputElement>('composerWorkspace').addEventListener('change', () => void validateComposerWorkspace());
  $('composerNodeRebind').addEventListener('click', () => void rebindExistingSession());

  paintComposerSelector();
  void refreshNodes();
}
