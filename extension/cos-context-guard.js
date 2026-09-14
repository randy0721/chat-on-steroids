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
 * new user bubble mounts, apply the same presentation shape used by chatgpt-dom.js: hide the
 * native renderer and put only the authored request beside it. Native message bytes are never
 * changed, so receipts, recording and provider input keep the full frame.
 */
(() => {
  'use strict';

  const MAX_PENDING_MS = 30_000;
  const USER = '[data-message-author-role="user"]';
  const RAW = '.whitespace-pre-wrap:not([data-clf-user-text]), .markdown:not([data-clf-user-text])';
  const SEND = 'button[data-testid="send-button"], button[data-testid="composer-submit-button"], form button[aria-label^="Send" i]';
  const EDITOR = '#prompt-textarea, form [contenteditable="true"][role="textbox"], form [contenteditable="true"]';
  const FRAME_HEAD = /^(?:\[\[CLF-(?:HANDOFF|RESUME):[A-Za-z0-9_-]{16,64}\]\]\s*)?\[\[COS_CONTEXT:\d{1,6}\]\]/;

  let pending = null;
  let observer = null;

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
      raw,
      authored,
      at: Date.now(),
      beforeIds: new Set(existing.map(node => node.getAttribute('data-message-id')).filter(Boolean)),
      beforeNodes: new WeakSet(existing)
    };
  }

  function present(raw, authored) {
    let display = raw.nextElementSibling?.matches?.('[data-clf-user-text]') ? raw.nextElementSibling : null;
    if (!display) {
      display = document.createElement('div');
      display.setAttribute('data-clf-user-text', '');
      display.className = 'whitespace-pre-wrap';
      display.dir = 'auto';
      raw.after(display);
    }
    if (display.textContent !== authored) display.textContent = authored;
    raw.setAttribute('data-clf-prompt-hidden', '');
  }

  function tryPresent() {
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
    }
  };
})();
