/**
 * Standalone Windows desktop runtime used by managed remote nodes.
 *
 * This is deliberately not the Electron app. It reuses the exact CoS Windows automation owner
 * (PowerShell helper, frame/ref fencing and Window2 adapter) behind a tiny JSON-line protocol.
 * The parent DesktopCommander process owns this child for one remote agent instance, so a bridge
 * reconnect/restart drops every observation context together with that agent instance.
 */
import readline from 'node:readline';
import { createWindowsComputerApi, WINDOWS_API_METHODS, type WindowsComputerApi } from '../computer/windows-api.js';
import { getWindowState, stopComputerHelper, ComputerError } from '../computer/index.js';
import { browserTabChord, isBrowserProcess } from '../computer/browser-chords.js';

interface RuntimeRequest {
  id: string;
  contextKey: string;
  method: string;
  args?: unknown;
}

const allowedMethods = new Set<string>(WINDOWS_API_METHODS);
const contexts = new Map<string, WindowsComputerApi>();
const MAX_CONTEXTS = 64;

function validRequest(value: unknown): value is RuntimeRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === 'string' && row.id.length > 0 && row.id.length <= 128 &&
    typeof row.contextKey === 'string' && row.contextKey.length > 0 && row.contextKey.length <= 256 &&
    typeof row.method === 'string' && allowedMethods.has(row.method);
}

function apiFor(key: string): WindowsComputerApi {
  let api = contexts.get(key);
  if (!api) api = createWindowsComputerApi();
  contexts.delete(key);
  contexts.set(key, api);
  while (contexts.size > MAX_CONTEXTS) contexts.delete(contexts.keys().next().value!);
  return api;
}

async function refuseBrowserChord(method: string, args: unknown): Promise<string | null> {
  if (method !== 'press_key' || !args || typeof args !== 'object' || Array.isArray(args)) return null;
  const row = args as { key?: unknown; window?: { id?: unknown } };
  if (typeof row.key !== 'string' || !row.window || typeof row.window.id !== 'number') return null;
  const chord = browserTabChord(row.key.split('+').map(name => name.trim()));
  if (!chord) return null;
  const target = (await getWindowState({ window: row.window.id, includeScreenshot: false, includeUi: false })).window;
  if (!isBrowserProcess(target.process)) return null;
  return `BROWSER_TAB_CHORD: ${chord} would manage tabs/windows or browser history in ${JSON.stringify(target.title)} (${target.process}). Use the page in its own browser window and native controls instead.`;
}

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function handle(request: RuntimeRequest): Promise<void> {
  try {
    if (process.platform !== 'win32') {
      throw new ComputerError('DESKTOP_SESSION_UNAVAILABLE: managed Windows desktop runtime requires win32.');
    }
    const refusal = await refuseBrowserChord(request.method, request.args);
    if (refusal) throw new ComputerError(refusal);
    const api = apiFor(request.contextKey);
    const invoke = api[request.method as keyof WindowsComputerApi];
    if (typeof invoke !== 'function') throw new ComputerError(`CAPABILITY_UNAVAILABLE: unsupported Windows desktop method ${request.method}`);
    const value = await (invoke as (input: unknown) => Promise<unknown>)(request.args ?? {});
    write({ id: request.id, ok: true, value: value ?? null });
  } catch (error) {
    write({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue: Promise<void> = Promise.resolve();
lines.on('line', line => {
  let parsed: unknown;
  try { parsed = JSON.parse(line); }
  catch {
    write({ id: null, ok: false, error: 'REMOTE_DESKTOP_PROTOCOL_ERROR: request is not valid JSON' });
    return;
  }
  if (!validRequest(parsed)) {
    write({ id: typeof (parsed as { id?: unknown })?.id === 'string' ? (parsed as { id: string }).id : null,
      ok: false, error: 'REMOTE_DESKTOP_PROTOCOL_ERROR: invalid request' });
    return;
  }
  queue = queue.then(() => handle(parsed), () => handle(parsed));
});

async function shutdown(): Promise<void> {
  lines.close();
  await stopComputerHelper().catch(() => undefined);
}

process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
process.stdin.once('end', () => { void shutdown().finally(() => process.exit(0)); });
