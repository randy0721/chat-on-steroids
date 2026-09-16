import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionTarget } from '../src/shared/nodes.js';

let dom: JSDOM | undefined;

afterEach(() => {
  dom?.window.close();
  dom = undefined;
  vi.resetModules();
});

function shell(): JSDOM {
  return new JSDOM(`<!doctype html><html><body>
    <button id="remoteNodesRefresh"></button><button id="remoteNodeAdd"></button><button id="remoteNodeCancel"></button>
    <div id="remoteNodesList"></div>
    <form id="remoteNodeEditor" hidden><input id="remoteNodeId"><input id="remoteNodeName"><input id="remoteNodeEndpoint"><input id="remoteNodeMachine"><input id="remoteNodeToken"></form>
    <details id="nodeMenu"><summary><span id="composerNodeLabel"></span></summary><div>
      <select id="composerNode"></select>
      <label id="composerWorkspaceRow"><input id="composerWorkspace"></label>
      <datalist id="composerWorkspaceRoots"></datalist>
      <p id="composerNodeStatus"></p>
      <button id="composerNodeRebind" type="button"></button>
    </div></details>
  </body></html>`, { url: 'https://local.test/' });
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('renderer execution node selector', () => {
  it('shows an existing binding, requests an explicit rebind, and surfaces server refusal inline', async () => {
    dom = shell();
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      Element: dom.window.Element,
      Node: dom.window.Node
    });

    const rebind = vi.fn()
      .mockResolvedValueOnce({ ok: true, data: { nodeId: 'office', workspace: 'D:\\work', nodeConfigVersion: 7, bindingVersion: 4 } satisfies ExecutionTarget })
      .mockResolvedValueOnce({ ok: false, error: 'Wait for running tool calls to finish before changing execution computers' });
    Object.defineProperty(dom.window, 'api', { value: {
      listNodes: vi.fn(async () => ({ ok: true, data: [
        { id: 'local', name: 'This computer', transport: 'local', endpoint: null, expectedMachineId: null, configVersion: 1, credentialConfigured: false, status: 'local', runtimeInfo: null },
        { id: 'office', name: 'Office PC', transport: 'remote-stdio-ws', endpoint: 'wss://office.example/node', expectedMachineId: null,
          configVersion: 7, credentialConfigured: true, status: 'connected', runtimeInfo: { nodeId: 'office', machineId: 'machine-office', agentInstanceId: 'agent-1', platform: 'win32', defaultShell: 'powershell.exe', approvedRoots: ['D:\\work'], capabilities: [], protocolVersion: 1 } }
      ] })),
      validateNodeWorkspace: vi.fn(async (nodeId: string, workspace: string) => ({ ok: true, data: { nodeId, workspace, approvedRoot: 'D:\\work' } })),
      rebindSessionExecution: rebind,
      saveNode: vi.fn(), removeNode: vi.fn(), testNode: vi.fn(), connectNode: vi.fn(), disconnectNode: vi.fn()
    }, configurable: true });

    const nodes = await import('../src/renderer/nodes.js');
    const rebound = vi.fn();
    nodes.initNodes(rebound);
    await settle();

    nodes.setComposerNodeContext({
      id: 'session-abcd1234',
      executionTarget: { nodeId: 'local', workspace: '/project', nodeConfigVersion: 1, bindingVersion: 3 }
    });
    const captured = nodes.composerExecutionSelection('session-abcd1234');
    expect(captured).toEqual({ expectedExecutionTarget: { nodeId: 'local', workspace: '/project', nodeConfigVersion: 1, bindingVersion: 3 } });
    expect(document.getElementById('nodeMenu')!.hidden).toBe(false);
    expect(document.getElementById('composerNodeLabel')!.textContent).toBe('This computer');
    expect(document.getElementById('composerNodeStatus')!.textContent).toContain('version 3');
    expect((document.getElementById('composerNodeRebind') as HTMLButtonElement).hidden).toBe(true);

    const select = document.getElementById('composerNode') as HTMLSelectElement;
    select.value = 'office';
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await settle();
    const apply = document.getElementById('composerNodeRebind') as HTMLButtonElement;
    expect(apply.hidden).toBe(false);
    expect(apply.disabled).toBe(false);
    apply.click();
    await settle();
    expect(rebind).toHaveBeenNthCalledWith(1, 'session-abcd1234', 'office', 'D:\\work');
    expect(rebound).toHaveBeenCalledWith('session-abcd1234', expect.objectContaining({ nodeId: 'office', bindingVersion: 4 }));
    expect(captured?.expectedExecutionTarget?.nodeId).toBe('local');
    expect(document.getElementById('composerNodeStatus')!.textContent).toContain('version 4');

    select.value = 'local';
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    apply.click();
    await settle();
    expect(rebind).toHaveBeenNthCalledWith(2, 'session-abcd1234', 'local', undefined);
    expect(document.getElementById('composerNodeStatus')!.textContent).toBe('Wait for running tool calls to finish before changing execution computers');
  });
});

it('shows a persistent modal for missing bindings and IPC target failures', async () => {
  dom = shell();
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom!.window.Event('close')); };
  const nodes = await import('../src/renderer/nodes.js');
  nodes.setComposerNodeContext({ id: 'missing-binding' });
  expect(nodes.composerExecutionSelection('missing-binding')).toBeNull();
  expect(document.querySelector('dialog[open][role="alertdialog"]')?.textContent).toContain('Apply the selected computer binding');
  const { run } = await import('../src/renderer/dom.js');
  expect(await run(Promise.resolve({ ok: false, error: 'NODE_OFFLINE: remote computer disconnected' }))).toBeNull();
  expect(document.querySelectorAll('dialog[open]')).toHaveLength(1);
  expect(document.querySelector('dialog[open]')?.textContent).toContain('Your message was not sent');
  (document.querySelector('dialog button') as HTMLButtonElement).click();
  expect(document.querySelector('dialog')).toBeNull();
  nodes.setComposerNodeContext(null);
  expect(nodes.composerExecutionSelection(null)).toEqual({ openingExecution: { nodeId: 'local', workspace: null } });
});
