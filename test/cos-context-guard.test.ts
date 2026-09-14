import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';
import { prependUserPrompt } from '../src/shared/user-prompt.js';

function page() {
  const dom = new JSDOM(`
    <form>
      <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
      <button data-testid="send-button" type="button">Send</button>
    </form>
  `, { runScripts: 'outside-only' });
  dom.window.eval(readFileSync('extension/chatgpt-dom.js', 'utf8'));
  dom.window.eval(readFileSync('extension/cos-context-guard.js', 'utf8'));
  return dom;
}

function mountUser(dom: JSDOM, id: string, text: string) {
  const section = dom.window.document.createElement('section');
  section.setAttribute('data-testid', `conversation-turn-${id}`);
  const holder = dom.window.document.createElement('div');
  holder.setAttribute('data-message-id', id);
  holder.setAttribute('data-message-author-role', 'user');
  const raw = dom.window.document.createElement('div');
  raw.className = 'markdown';
  raw.textContent = text;
  holder.append(raw);
  section.append(holder);
  dom.window.document.body.append(section);
  return { holder, raw };
}

it('replaces a newly sent COS transport frame with only the authored request before Fiber source recovery', async () => {
  const dom = page();
  try {
    const old = mountUser(dom, 'old-user', 'Earlier request');
    const sent = prependUserPrompt('List C:\\Users\\xnn36', 'Private CoS routing context.  \nSecond line.');
    const editor = dom.window.document.querySelector('#prompt-textarea') as HTMLElement;
    // JSDOM has no layout-backed innerText. The guard deliberately falls back to textContent.
    editor.textContent = sent;

    dom.window.document.querySelector<HTMLButtonElement>('[data-testid="send-button"]')!.click();

    // Model the live Markdown renderer consuming transport-only whitespace. The strict DOM
    // parser cannot recover this frame on its own; the pre-send receipt still can.
    const rendered = sent.replace('context.  ', 'context.');
    const current = mountUser(dom, 'new-user', rendered);
    await Promise.resolve();

    expect(old.raw.hasAttribute('data-clf-prompt-hidden')).toBe(false);
    expect(current.raw.hasAttribute('data-clf-prompt-hidden')).toBe(true);
    expect(current.raw.textContent).toBe(rendered);
    expect(current.raw.nextElementSibling?.getAttribute('data-clf-user-text')).not.toBeNull();
    expect(current.raw.nextElementSibling?.textContent).toBe('List C:\\Users\\xnn36');
  } finally {
    (dom.window as any).__CLF_CONTEXT_GUARD__?.stop();
    dom.window.close();
  }
});

it('does not hide ordinary or invalid marker-like user input', async () => {
  const dom = page();
  try {
    const editor = dom.window.document.querySelector('#prompt-textarea') as HTMLElement;
    editor.textContent = '[[COS_CONTEXT:12]]\nnot a valid frame\n\nVisible request';
    dom.window.document.querySelector<HTMLButtonElement>('[data-testid="send-button"]')!.click();
    const current = mountUser(dom, 'literal-user', editor.textContent || '');
    await Promise.resolve();

    expect(current.raw.hasAttribute('data-clf-prompt-hidden')).toBe(false);
    expect(current.raw.nextElementSibling?.matches('[data-clf-user-text]')).not.toBe(true);
  } finally {
    (dom.window as any).__CLF_CONTEXT_GUARD__?.stop();
    dom.window.close();
  }
});
