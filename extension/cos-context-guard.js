/**
 * Presentation guard for framed CoS user prompts.
 *
 * ChatGPT's Markdown renderer can normalize the native message before the Fiber/provider
 * source is available (for example by consuming trailing spaces). The strict frame parser
 * correctly refuses that mutated text, but the refusal used to leave the whole
 * `[[COS_CONTEXT:...]]` transport frame visible in the user's chat until a later exact
 * source arrived — and on some page revisions that source never arrived at all.
 *
 * The one moment we already possess the exact bytes is immediately before Send. Capture a
 * valid frame there, remember which user messages already exist, and when the corresponding
 * new user bubble mounts, visually replace it with only the authored request. This guard uses
 * CSS generated content rather than another text node: recorder/receipt textContent therefore
 * remains the native message, and the normal exact-source presenter can take over later.
 */
(() => {
  'use strict';

  try { globalThis.__CLF_CONTEXT_GUARD__?.stop?.(); } catch { /* replacement is best effort */ }

  const MAX_PENDING_MS = 30_000;
  const MAX_KNOWN = 32;
  const STYLE_ID = 'clf-context-guard-style';
  const USER = '[data-message-author-role="user"]';
  const RAW = '.whitespace-pre-wrap:not([data-clf-user-text]), .markdown:not([data-clf-user-text])';
  const SEND = 'button[data-testid="send-button"], button[data-testid="composer-submit-button"], form button[aria-label^="Send" i]';
  const EDITOR = '#prompt-textarea, form [contenteditable="true"][role="textbox"], form [contenteditable="true"]';
  const FRAME_HEAD = /^(?:\[\[CLF-(?:HANDOFF|RESUME):[A-Za-z0-9_-]{16,64}\]\]\s*)?\[\[COS_CONTEXT:\d{1,6}\]\]/;

  let pending = null;
  let observer = null;
  const known = new Map();

  function installStyle() {
    document.getElementById(STYLE_ID)?.remove();
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      [data-clf-context-guard] {
        visibility: hidden !important;
        font-size: 0 !important;
        line-height: 0 !important;
      }
      [data-clf-context-guard] > * {
        display: none !important;
      }
      [data-clf-context-guard]::after {
        display: block !important;
        visibility: visible !important;
        content: attr(data-clf-context-authored);
        white-space: pre-wrap !important;
        overflow-wrap: anywhere;
        font-family: var(--clf-context-font-family, inherit) !important;
        font-size: var(--clf-context-font-size, 1rem) !important;
        font-weight: var(--clf-context-font-weight, 400) !important;
        line-height: var(--clf-context-line-height, 1.5) !important;
        color: var(--clf-context-color, currentColor) !important;
      }
    `;
    (document.head || document.documentElement).append(style);
  }

  function editorText(editor) {
    if (!editor) return '';
    // innerText is the browser's editor value: unlike textContent it preserves the line
    // breaks represented by <br>/<p>, which are part of the transport frame's byte count.
    const value = typeof editor.innerText === 'string' ? editor.innerText : editor.textContent || '';
    return String(value).replace(/\r\n?/g, '\n');
  }

  function currentUserMessages() {
    return [...document.querySelectorAll(`${USER}[data-message-id]`)];
  }

  function captureFrame() {
    const api = globalThis.CLF_DOM;
    if (!api || typeof api.userPromptText !== 'function') return;
    const editor = document.querySelector(EDITOR);
    const raw = editorText(editor).trimStart();
    if (!raw) return;
    const authored = api.userPromptText(raw);
    if (authored === null) return;

    const existing = currentUserMessages();
    pending = {
      authored,
      at: Date.now(),
      beforeIds: new Set(existing.map(node => node.getAttribute('data-message-id')).filter(Boolean)),
      beforeNodes: new WeakSet(existing)
    };
  }

  function remember(id, authored) {
    if (!id) return;
    known.delete(id);
    known.set(id, authored);
    while (known.size > MAX_KNOWN) known.delete(known.keys().next().value);
  }

  function clearGuard(raw) {
    raw.removeAttribute('data-clf-context-guard');
    raw.removeAttribute('data-clf-context-authored');
    for (const name of [
      '--clf-context-font-family', '--clf-context-font-size', '--clf-context-font-weight',
      '--clf-context-line-height', '--clf-context-color'
    ]) raw.style?.removeProperty?.(name);
  }

  function present(raw, authored) {
    // If the normal presenter already has exact provider bytes, it owns this bubble. Its
    // sibling is real DOM text that follows ChatGPT's typography exactly; the guard is only
    // the pre-Fiber fallback.
    if (raw.hasAttribute('data-clf-prompt-hidden') && raw.nextElementSibling?.matches?.('[data-clf-user-text]')) {
      clearGuard(raw);
      return;
    }
    let computed = null;
    try { computed = getComputedStyle(raw); } catch { /* structural test DOM */ }
    if (computed) {
      raw.style.setProperty('--clf-context-font-family', computed.fontFamily || 'inherit');
      raw.style.setProperty('--clf-context-font-size', computed.fontSize || '1rem');
      raw.style.setProperty('--clf-context-font-weight', computed.fontWeight || '400');
      raw.style.setProperty('--clf-context-line-height', computed.lineHeight || '1.5');
      raw.style.setProperty('--clf-context-color', computed.color || 'currentColor');
    }
    raw.setAttribute('data-clf-context-authored', authored);
    raw.setAttribute('data-clf-context-guard', '');
  }

  function reconcileKnown() {
    for (const holder of document.querySelectorAll(`${USER}[data-message-id]`)) {
      const id = holder.getAttribute('data-message-id');
      const authored = id ? known.get(id) : null;
      if (authored === undefined || authored === null) continue;
      const raw = holder.querySelector(RAW);
      if (!raw) continue;
      present(raw, authored);
    }
  }

  function tryPresent() {
    reconcileKnown();
    const shot = pending;
    if (!shot) return;
    if (Date.now() - shot.at > MAX_PENDING_MS) {
      pending = null;
      return;
    }

    // Newest first. During SPA navigation React can remount historical bubbles; ids from the
    // pre-send snapshot exclude those, while the visible transport header is an additional
    // proof that this is the framed message we just submitted.
    const holders = [...document.querySelectorAll(USER)].reverse();
    for (const holder of holders) {
      const id = holder.getAttribute('data-message-id');
      if (shot.beforeNodes.has(holder)) continue;
      if (id && shot.beforeIds.has(id)) continue;
      const raw = holder.querySelector(RAW);
      if (!raw) continue;
      const visible = String(raw.textContent || '').trimStart();
      if (!FRAME_HEAD.test(visible)) continue;
      present(raw, shot.authored);
      remember(id, shot.authored);
      pending = null;
      return;
    }
  }

  function onClick(event) {
    if (!event.target?.closest?.(SEND)) return;
    captureFrame();
  }

  function onSubmit(event) {
    const form = event.target;
    if (!form?.querySelector?.(EDITOR)) return;
    captureFrame();
  }

  function onKeydown(event) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    const editor = event.target?.closest?.(EDITOR);
    if (!editor) return;
    captureFrame();
  }

  installStyle();
  document.addEventListener('click', onClick, true);
  document.addEventListener('submit', onSubmit, true);
  document.addEventListener('keydown', onKeydown, true);

  observer = new MutationObserver(() => tryPresent());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Test/debug seam only. Production code never needs to call it; exposing a tiny handle keeps
  // this guard independently verifiable without reaching into the recorder's large content.js.
  globalThis.__CLF_CONTEXT_GUARD__ = {
    capture: captureFrame,
    present: tryPresent,
    stop() {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('submit', onSubmit, true);
      document.removeEventListener('keydown', onKeydown, true);
      observer?.disconnect();
      observer = null;
      pending = null;
      known.clear();
      document.getElementById(STYLE_ID)?.remove();
      for (const raw of document.querySelectorAll('[data-clf-context-guard]')) clearGuard(raw);
    }
  };
})();
