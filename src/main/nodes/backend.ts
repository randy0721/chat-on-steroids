import type { CallToolResult } from '@modelcontextprotocol/client';
import nodePath from 'node:path';
import { LOCAL_NODE_ID, type ExecutionSnapshot, type NodeRuntimeInfo } from '../../shared/nodes.js';
import { DEFAULT_EXEC_YIELD_TIME_MS, DEFAULT_WRITE_STDIN_YIELD_TIME_MS } from '../codex/unified-exec-constants.js';
import { composeCommandBatch } from '../codex/command-batch.js';
import type { ShellType } from '../codex/shell.js';
import { DEFAULT_READ_BYTES, MAX_READ_BYTES } from '../fsops.js';
import {
  DEFAULT_APPLY_PATCH_FILE_UPDATE_MODE,
  MAX_PATCH_SOURCE_BYTES,
  parsePatch,
  type Hunk
} from '../codex/apply-patch/index.js';
import { deriveNewContentsFromChunks } from '../codex/apply-patch/file-update.js';
import { currentCall, noteCount } from '../mcp/call-context.js';
import type { SurfaceId } from '../mcp/surfaces.js';
import { globToRegExp } from '../search.js';
import {
  SessionExecutionTargetError,
  withSessionExecutionTargetLease
} from '../session/store.js';
import { ExecutionHandleError, executionHandles, type HandleOwner } from './handles.js';
import { RemoteNodeConnectionError, type RemoteNodeConnection } from './connection.js';
import { NodeRegistryError, nodeRegistry } from './registry.js';
import { routesComputerTool } from './router.js';

export type BackendToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface BackendToolResult {
  content: BackendToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

type LocalHandler = () => Promise<BackendToolResult>;

interface RemoteExecArgs {
  cmd?: string;
  cmds?: string[];
  workdir?: string;
  tty?: boolean;
  yield_time_ms?: number;
  max_output_tokens?: number;
  shell?: string;
  login?: boolean;
}

interface RemoteWriteStdinArgs {
  session_id: number | string;
  chars?: string;
  yield_time_ms?: number;
  max_output_tokens?: number;
}

interface RemoteFindArgs {
  query: string;
  path?: string;
  mode?: 'name' | 'content';
  include?: string;
  exclude?: string[];
  case_sensitive?: boolean;
  regex?: boolean;
  max_results?: number;
}

interface ProcessStructured {
  kind: 'process';
  pid: number;
  state: 'running' | 'waiting' | 'completed' | 'terminated' | 'missing';
  running: boolean;
  completed: boolean;
  blocked: boolean;
  waitingForInput: boolean;
  exitCode: number | null;
  output: string;
  readFrom: number | null;
  readCount: number;
  totalLines: number | null;
  remaining: number | null;
  evicted: boolean;
  evictedLines: number;
  evictedChars: number;
  truncated: boolean;
  shell: string | null;
  cwd: string | null;
  terminationAccepted: boolean | null;
  terminationResult: string | null;
}

interface SearchStructuredResult {
  file: string;
  type: 'file' | 'content';
  line?: number;
  match?: string;
}

interface SearchStructured {
  kind: 'search';
  sessionId: string | null;
  state: 'running' | 'completed' | 'error' | 'missing';
  running: boolean;
  completed: boolean;
  error: boolean;
  errorMessage: string | null;
  incomplete: boolean;
  results: SearchStructuredResult[];
  offset: number;
  returnedCount: number;
  totalResults: number;
  totalMatches: number;
  hasMoreResults: boolean;
  stopAccepted: boolean | null;
  stopResult: string | null;
}

type RemoteFileSnapshot =
  | { exists: false }
  | { exists: true; content: string };

type RemotePatchOperation =
  | { kind: 'write'; path: string; expected: RemoteFileSnapshot; content: string; displayPath: string }
  | { kind: 'delete'; path: string; expected: Extract<RemoteFileSnapshot, { exists: true }>; displayPath: string }
  | {
      kind: 'move';
      path: string;
      destination: string;
      expected: Extract<RemoteFileSnapshot, { exists: true }>;
      destinationExpected: RemoteFileSnapshot;
      content: string;
      displayPath: string;
    };

function textResult(text: string, isError = false): BackendToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function errorCode(error: unknown): string {
  if (error instanceof NodeRegistryError || error instanceof RemoteNodeConnectionError ||
      error instanceof ExecutionHandleError || error instanceof SessionExecutionTargetError) {
    return error.code;
  }
  return 'REMOTE_TOOL_ERROR';
}

function routedFailure(error: unknown): BackendToolResult {
  const code = errorCode(error);
  const raw = error instanceof Error ? error.message : String(error);
  const detail = raw.startsWith(`${code}:`) ? raw : `${code}: ${raw}`;
  return textResult(detail, true);
}

function executionTarget(execution: ExecutionSnapshot) {
  return {
    nodeId: execution.nodeId,
    workspace: execution.workspace,
    bindingVersion: execution.bindingVersion,
    nodeConfigVersion: execution.nodeConfigVersion
  };
}

function toolNames(connection: RemoteNodeConnection): Set<string> {
  return new Set(connection.tools.map(tool => tool.name));
}

function requireTool(connection: RemoteNodeConnection, name: string): void {
  if (!toolNames(connection).has(name)) {
    throw new NodeRegistryError('CAPABILITY_UNAVAILABLE', `remote node does not publish required tool ${name}`);
  }
}

function mcpContent(result: CallToolResult): BackendToolContent[] {
  const converted: BackendToolContent[] = [];
  for (const item of result.content ?? []) {
    if (item.type === 'text') converted.push({ type: 'text', text: item.text });
    else if (item.type === 'image') converted.push({ type: 'image', data: item.data, mimeType: item.mimeType });
  }
  return converted.length > 0 ? converted : [{ type: 'text', text: '(remote tool returned no text or image content)' }];
}

function remoteToolError(name: string, result: CallToolResult): BackendToolResult {
  const content = mcpContent(result);
  const first = content.find(item => item.type === 'text');
  const prefix = `REMOTE_TOOL_ERROR: ${name} failed on the frozen remote node`;
  if (first?.type === 'text') first.text = `${prefix}: ${first.text}`;
  else content.unshift({ type: 'text', text: prefix });
  return { content, isError: true };
}

function processStructured(result: CallToolResult, tool: string): ProcessStructured {
  const value = result.structuredContent as Record<string, unknown> | undefined;
  if (!value || typeof value !== 'object' || value.kind !== 'process' || typeof value.pid !== 'number' ||
      typeof value.state !== 'string' || typeof value.running !== 'boolean' || typeof value.completed !== 'boolean' ||
      typeof value.blocked !== 'boolean' || typeof value.waitingForInput !== 'boolean' ||
      !(value.exitCode === null || typeof value.exitCode === 'number') || typeof value.output !== 'string') {
    throw new NodeRegistryError('REMOTE_TOOL_ERROR', `${tool} did not return the required structured process contract`);
  }
  return value as unknown as ProcessStructured;
}

function searchStructured(result: CallToolResult, tool: string): SearchStructured {
  const value = result.structuredContent as Record<string, unknown> | undefined;
  if (!value || value.kind !== 'search' ||
      !(value.sessionId === null || typeof value.sessionId === 'string') ||
      typeof value.state !== 'string' || typeof value.running !== 'boolean' ||
      typeof value.completed !== 'boolean' || typeof value.error !== 'boolean' ||
      !Array.isArray(value.results) || typeof value.offset !== 'number' ||
      typeof value.returnedCount !== 'number' || typeof value.totalResults !== 'number' ||
      typeof value.totalMatches !== 'number' || typeof value.hasMoreResults !== 'boolean') {
    throw new NodeRegistryError('REMOTE_TOOL_ERROR', `${tool} did not return the required structured search contract`);
  }
  return value as unknown as SearchStructured;
}

function handleOwner(execution: ExecutionSnapshot): HandleOwner {
  return {
    sessionId: execution.sessionId,
    nodeId: execution.nodeId,
    bindingVersion: execution.bindingVersion,
    agentInstanceId: execution.agentInstanceId
  };
}

function processResult(
  process: ProcessStructured,
  wallTimeMs: number,
  sessionId?: string,
  batchMarker?: string | null
): BackendToolResult {
  const output = batchMarker
    ? process.output.split(` [clf-batch:${batchMarker}]`).join('')
    : process.output;
  const stillRunning = process.running && !process.completed && process.state !== 'terminated' && process.state !== 'missing';
  const structuredContent: Record<string, unknown> = {
    wall_time_seconds: wallTimeMs / 1000,
    ...(process.completed && process.exitCode !== null ? { exit_code: process.exitCode } : {}),
    ...(stillRunning && sessionId ? { session_id: sessionId } : {}),
    output
  };
  const state = stillRunning && sessionId
    ? `Process running with session ID ${sessionId}.`
    : process.state === 'terminated'
      ? 'Process terminated.'
      : process.completed
        ? `Process exited with code ${process.exitCode ?? 'unknown'}.`
        : `Process state: ${process.state}.`;
  const truncation = process.truncated
    ? `\n[Remote output truncated${process.evictedLines > 0 ? `; ${process.evictedLines} earliest lines were evicted` : ''}.]`
    : '';
  return {
    content: [{ type: 'text', text: `${state}${output ? `\n${output}` : ''}${truncation}` }],
    structuredContent
  };
}

function remoteShellType(shell: string): ShellType | null {
  const base = shell.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase().replace(/\.exe$/i, '') ?? '';
  if (base === 'powershell' || base === 'pwsh') return 'powershell';
  if (base === 'cmd') return 'cmd';
  if (base === 'bash') return 'bash';
  if (base === 'zsh') return 'zsh';
  if (base === 'sh') return 'sh';
  return null;
}

function encodeProcessRemoteHandle(pid: number, batchMarker: string | null): string {
  return JSON.stringify({ pid, batchMarker });
}

function decodeProcessRemoteHandle(raw: string): { pid: number; batchMarker: string | null } | null {
  if (/^-?\d+$/.test(raw)) {
    const pid = Number(raw);
    return Number.isSafeInteger(pid) ? { pid, batchMarker: null } : null;
  }
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; batchMarker?: unknown };
    if (!Number.isSafeInteger(parsed.pid) || !(parsed.batchMarker === null || typeof parsed.batchMarker === 'string')) return null;
    return { pid: parsed.pid as number, batchMarker: parsed.batchMarker as string | null };
  } catch {
    return null;
  }
}

async function remoteExec(
  connection: RemoteNodeConnection,
  runtime: NodeRuntimeInfo,
  args: RemoteExecArgs,
  execution: ExecutionSnapshot
): Promise<BackendToolResult> {
  requireTool(connection, 'start_process');
  const requestedShell = args.shell ?? runtime.defaultShell;
  let command = args.cmd;
  let batchMarker: string | null = null;
  if (args.cmds !== undefined) {
    const shellType = remoteShellType(requestedShell);
    if (!shellType) {
      return textResult(
        `CAPABILITY_UNAVAILABLE: remote batch execution cannot classify shell ${JSON.stringify(requestedShell)}; no command was run.`,
        true
      );
    }
    const batch = composeCommandBatch(args.cmds, shellType);
    command = batch.command;
    batchMarker = batch.marker;
  }
  if (!command) return textResult('REMOTE_TOOL_ERROR: exec_command requires one cmd or cmds after schema validation', true);
  const cwd = args.workdir !== undefined
    ? resolveRemotePath(runtime, execution, args.workdir)
    : execution.workspace ?? undefined;
  const started = Date.now();
  const result = await connection.callTool({
    name: 'start_process',
    arguments: {
      command,
      timeout_ms: args.yield_time_ms ?? DEFAULT_EXEC_YIELD_TIME_MS,
      shell: requestedShell,
      ...(cwd ? { cwd } : {})
    }
  });
  if (result.isError) return remoteToolError('start_process', result);
  const process = processStructured(result, 'start_process');
  if (process.pid < 0 || process.state === 'missing') {
    return textResult(`REMOTE_TOOL_ERROR: remote process failed to start${process.output ? `: ${process.output}` : ''}`, true);
  }
  const running = process.running && !process.completed;
  const opaque = running
    ? executionHandles.create(handleOwner(execution), encodeProcessRemoteHandle(process.pid, batchMarker))
    : undefined;
  return processResult(process, Date.now() - started, opaque, batchMarker);
}

async function remoteWriteStdin(
  connection: RemoteNodeConnection,
  args: RemoteWriteStdinArgs,
  execution: ExecutionSnapshot
): Promise<BackendToolResult> {
  if (typeof args.session_id !== 'string' || !args.session_id.startsWith('nh_')) {
    return textResult('HANDLE_EXPIRED: remote process operations require the opaque session_id returned by this exact remote exec_command', true);
  }
  let raw: string;
  try {
    raw = executionHandles.remote(args.session_id, handleOwner(execution));
  } catch (error) {
    return routedFailure(error);
  }
  const decoded = decodeProcessRemoteHandle(raw);
  if (!decoded) {
    executionHandles.revoke(args.session_id);
    return textResult('HANDLE_EXPIRED: the remote process handle is invalid', true);
  }
  const { pid, batchMarker } = decoded;

  const started = Date.now();
  let result: CallToolResult;
  const cancelling = args.chars === '\u0003';
  if (cancelling) {
    requireTool(connection, 'force_terminate');
    result = await connection.callTool({ name: 'force_terminate', arguments: { pid } });
  } else if (args.chars !== undefined && args.chars.length > 0) {
    requireTool(connection, 'interact_with_process');
    result = await connection.callTool({
      name: 'interact_with_process',
      arguments: {
        pid,
        input: args.chars,
        timeout_ms: args.yield_time_ms ?? DEFAULT_WRITE_STDIN_YIELD_TIME_MS,
        wait_for_prompt: true
      }
    });
  } else {
    requireTool(connection, 'read_process_output');
    result = await connection.callTool({
      name: 'read_process_output',
      arguments: {
        pid,
        timeout_ms: args.yield_time_ms ?? DEFAULT_WRITE_STDIN_YIELD_TIME_MS,
        offset: 0
      }
    });
  }
  if (result.isError) {
    const structured = result.structuredContent as Record<string, unknown> | undefined;
    if (structured && typeof structured === 'object' && structured.kind === 'process' && structured.state === 'missing') {
      executionHandles.revoke(args.session_id);
      return textResult('HANDLE_EXPIRED: the remote process no longer exists on this executor instance', true);
    }
    return remoteToolError(cancelling ? 'force_terminate' : args.chars ? 'interact_with_process' : 'read_process_output', result);
  }
  const process = processStructured(result, cancelling ? 'force_terminate' : args.chars ? 'interact_with_process' : 'read_process_output');
  if (process.completed || process.state === 'terminated' || process.state === 'missing' || !process.running) {
    executionHandles.revoke(args.session_id);
  }
  return processResult(
    process,
    Date.now() - started,
    process.running && !process.completed && process.state !== 'terminated' && process.state !== 'missing'
      ? args.session_id
      : undefined,
    batchMarker
  );
}

interface ReadArgs {
  paths: string[];
  start_line?: number;
  end_line?: number;
  max_bytes?: number;
}

interface PathRange {
  path: string;
  start?: number;
  end?: number;
}

interface RemoteReadTarget extends PathRange {
  displayPath: string;
}

interface RemoteFileInfo {
  isFile: boolean;
  isDirectory: boolean;
  size: number | null;
  fileType: string | null;
  lineCount: number | null;
}

interface RemoteDirectoryEntry {
  name: string;
  relativePath: string;
  type: 'file' | 'directory' | 'other';
  size: number | null;
}

const MAX_REMOTE_GLOB_MATCHES = 20;
const MAX_REMOTE_READ_TARGETS = 40;
const REMOTE_GLOB_SCAN_LIMIT = 5_000;
const MAX_REMOTE_READ_IMAGES = 4;
const MAX_REMOTE_READ_IMAGE_BYTES = 12 * 1024 * 1024;

function splitTrailingRange(value: string): PathRange {
  const match = /^(.*):(\d+)(?:-(\d+))?$/.exec(value);
  if (!match || !match[1]) return { path: value };
  const start = Number(match[2]);
  const end = match[3] === undefined ? start : Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return { path: value };
  return { path: match[1], start, end };
}

function containsGlob(path: string): boolean {
  return /[*?]/.test(path);
}

function remotePathApi(runtime: NodeRuntimeInfo): typeof nodePath.win32 | typeof nodePath.posix {
  return runtime.platform === 'win32' ? nodePath.win32 : nodePath.posix;
}

function resolveRemotePath(
  runtime: NodeRuntimeInfo,
  execution: ExecutionSnapshot,
  requested: string
): string {
  const pathApi = remotePathApi(runtime);
  if (pathApi.isAbsolute(requested)) return pathApi.normalize(requested);
  if (!execution.workspace) {
    throw new NodeRegistryError(
      'TARGET_CONTEXT_UNRESOLVED',
      `WORKSPACE_REQUIRED: remote path ${requested} is relative but this turn has no frozen workspace`
    );
  }
  return pathApi.resolve(execution.workspace, requested);
}

function remoteGlobPlan(
  runtime: NodeRuntimeInfo,
  execution: ExecutionSnapshot,
  requested: string
): { root: string; pattern: string } {
  const pathApi = remotePathApi(runtime);
  const normalised = runtime.platform === 'win32' ? requested.replace(/\\/g, '/') : requested;
  const wildcard = normalised.search(/[*?]/);
  if (wildcard < 0) return { root: resolveRemotePath(runtime, execution, requested), pattern: '' };
  const separator = normalised.lastIndexOf('/', wildcard);
  const base = separator >= 0 ? normalised.slice(0, separator) : '';
  const pattern = separator >= 0 ? normalised.slice(separator + 1) : normalised;
  const baseForResolve = runtime.platform === 'win32' && /^[A-Za-z]:$/.test(base) ? `${base}\\` : base;
  const root = base
    ? resolveRemotePath(
        runtime,
        execution,
        runtime.platform === 'win32' ? baseForResolve.replace(/\//g, '\\') : baseForResolve
      )
    : execution.workspace;
  if (!root) {
    throw new NodeRegistryError(
      'TARGET_CONTEXT_UNRESOLVED',
      `WORKSPACE_REQUIRED: remote read glob ${requested} is relative but this turn has no frozen workspace`
    );
  }
  return { root: pathApi.normalize(root), pattern };
}

async function expandRemoteReadGlob(
  connection: RemoteNodeConnection,
  runtime: NodeRuntimeInfo,
  execution: ExecutionSnapshot,
  requested: string
): Promise<{ matches: string[]; truncated: 'matches' | 'scan' | null }> {
  requireTool(connection, 'start_search');
  requireTool(connection, 'get_more_search_results');
  requireTool(connection, 'stop_search');
  const { root, pattern } = remoteGlobPlan(runtime, execution, requested);
  const matcher = globToRegExp(pattern.replace(/\\/g, '/'), false);
  const pathApi = remotePathApi(runtime);
  const started = await connection.callTool({
    name: 'start_search',
    arguments: {
      path: root,
      pattern,
      searchType: 'files',
      ignoreCase: true,
      maxResults: REMOTE_GLOB_SCAN_LIMIT + 1,
      contextLines: 0,
      timeout_ms: 10_000,
      earlyTermination: false,
      literalSearch: false
    }
  });
  if (started.isError) return Promise.reject(new NodeRegistryError(
    'REMOTE_TOOL_ERROR',
    `start_search failed while expanding remote read glob ${requested}`
  ));
  let search = searchStructured(started, 'start_search');
  if (!search.sessionId) {
    throw new NodeRegistryError('REMOTE_TOOL_ERROR', `start_search returned no session while expanding ${requested}`);
  }
  const sessionId = search.sessionId;
  const matches: string[] = [];
  const seen = new Set<string>();
  let scanned = 0;
  let offset = search.returnedCount;
  let truncated: 'matches' | 'scan' | null = null;

  const append = (items: SearchStructuredResult[]) => {
    for (const item of items) {
      if (item.type !== 'file') continue;
      scanned += 1;
      const absolute = pathApi.isAbsolute(item.file) ? pathApi.normalize(item.file) : pathApi.resolve(root, item.file);
      const relative = pathApi.relative(root, absolute).replace(/\\/g, '/');
      if (!matcher.test(relative)) continue;
      const key = runtime.platform === 'win32' ? absolute.toLowerCase() : absolute;
      if (seen.has(key)) continue;
      seen.add(key);
      if (matches.length >= MAX_REMOTE_GLOB_MATCHES) {
        truncated = 'matches';
        break;
      }
      matches.push(absolute);
    }
  };
  append(search.results);

  try {
    const deadline = Date.now() + 10_000;
    while (!truncated && !search.completed && !search.error && scanned < REMOTE_GLOB_SCAN_LIMIT && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      const more = await connection.callTool({
        name: 'get_more_search_results',
        arguments: {
          sessionId,
          offset,
          length: Math.min(100, REMOTE_GLOB_SCAN_LIMIT + 1 - scanned)
        }
      });
      if (more.isError) {
        const structured = searchStructured(more, 'get_more_search_results');
        throw new NodeRegistryError(
          'REMOTE_TOOL_ERROR',
          structured.errorMessage ?? `remote glob search ${sessionId} failed`
        );
      }
      search = searchStructured(more, 'get_more_search_results');
      offset += search.returnedCount;
      append(search.results);
    }
    if (!truncated && !search.completed && scanned >= REMOTE_GLOB_SCAN_LIMIT) truncated = 'scan';
    if (search.error && matches.length === 0) {
      throw new NodeRegistryError('REMOTE_TOOL_ERROR', search.errorMessage ?? `remote glob search failed for ${requested}`);
    }
  } finally {
    if (!search.completed) {
      try {
        await connection.callTool({ name: 'stop_search', arguments: { sessionId } });
      } catch {
        // The search is read-only and the exact node lease still owns this call. If the transport
        // vanished, there is nothing safe or useful to replay merely to stop an already-lost job.
      }
    }
  }

  return { matches, truncated };
}

function boundedUtf8(text: string, maxBytes: number | undefined): { text: string; truncated: boolean } {
  if (!maxBytes || Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
  const bytes = Buffer.from(text, 'utf8');
  return {
    text: bytes.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/, ''),
    truncated: true
  };
}

function parseRemoteFileInfo(result: CallToolResult, path: string): RemoteFileInfo {
  const value = result.structuredContent as Record<string, unknown> | undefined;
  if (result.isError) {
    const reason = value?.kind === 'file_info' && value.exists === false
      ? 'path does not exist'
      : contentText(result, 'get_file_info');
    throw new NodeRegistryError('REMOTE_TOOL_ERROR', `could not inspect remote read path ${path}: ${reason}`);
  }
  if (!value || value.kind !== 'file_info' || value.exists !== true) {
    throw new NodeRegistryError('REMOTE_TOOL_ERROR', `get_file_info did not return structured metadata for ${path}`);
  }
  const metadata = value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata)
    ? value.metadata as Record<string, unknown>
    : undefined;
  return {
    isFile: value.isFile === true,
    isDirectory: value.isDirectory === true,
    size: typeof value.size === 'number' && Number.isFinite(value.size) ? value.size : null,
    fileType: typeof value.fileType === 'string' ? value.fileType : null,
    lineCount: typeof metadata?.lineCount === 'number' && Number.isSafeInteger(metadata.lineCount)
      ? metadata.lineCount
      : null
  };
}

function parseRemoteDirectoryListing(result: CallToolResult, path: string): RemoteDirectoryEntry[] {
  if (result.isError) throw new NodeRegistryError('REMOTE_TOOL_ERROR', `list_directory failed for ${path}`);
  const value = result.structuredContent as Record<string, unknown> | undefined;
  if (!value || value.kind !== 'directory_listing' || !Array.isArray(value.entries)) {
    throw new NodeRegistryError('REMOTE_TOOL_ERROR', `list_directory did not return structured entries for ${path}`);
  }
  const entries: RemoteDirectoryEntry[] = [];
  for (const item of value.entries) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (typeof row.name !== 'string' || typeof row.relativePath !== 'string') continue;
    if (row.type !== 'file' && row.type !== 'directory' && row.type !== 'other') continue;
    entries.push({
      name: row.name,
      relativePath: row.relativePath,
      type: row.type,
      size: typeof row.size === 'number' && Number.isFinite(row.size) ? row.size : null
    });
  }
  return entries;
}

function numberRemoteText(text: string, firstLine: number, maxBytes: number): {
  text: string;
  lastLine: number;
  truncated: boolean;
} {
  const lines = text.split('\n');
  const kept: string[] = [];
  let bytes = 0;
  for (let index = 0; index < lines.length; index++) {
    const rendered = `${firstLine + index}\t${lines[index] ?? ''}`;
    const cost = Buffer.byteLength(rendered, 'utf8') + (kept.length === 0 ? 0 : 1);
    if (kept.length > 0 && bytes + cost > maxBytes) break;
    kept.push(rendered);
    bytes += cost;
  }
  return {
    text: kept.join('\n'),
    lastLine: firstLine + kept.length - 1,
    truncated: kept.length < lines.length
  };
}

function remoteReadLength(info: RemoteFileInfo, startLine: number, maxBytes: number, explicitEnd?: number): number {
  if (explicitEnd !== undefined) return Math.max(1, explicitEnd - startLine + 1);
  if (info.lineCount === null) return 1_000;
  const remainingLines = Math.max(1, info.lineCount - startLine + 1);
  if (info.size === null || info.lineCount === 0) return Math.min(remainingLines, 10_000);
  const averageBytes = Math.max(1, info.size / info.lineCount);
  return Math.min(remainingLines, Math.max(1, Math.ceil(maxBytes / averageBytes) + 1), 10_000);
}

async function remoteRead(
  connection: RemoteNodeConnection,
  runtime: NodeRuntimeInfo,
  args: ReadArgs,
  execution: ExecutionSnapshot
): Promise<BackendToolResult> {
  requireTool(connection, 'read_file');
  requireTool(connection, 'get_file_info');
  const content: BackendToolContent[] = [];
  const targets: RemoteReadTarget[] = [];
  const notes: string[] = [];
  let successes = 0;
  let failures = 0;

  for (const requested of args.paths) {
    if (targets.length >= MAX_REMOTE_READ_TARGETS) {
      notes.push(`(stopped expanding at ${MAX_REMOTE_READ_TARGETS} paths)`);
      break;
    }
    const ranged = splitTrailingRange(requested);
    if (containsGlob(ranged.path)) {
      try {
        const expanded = await expandRemoteReadGlob(connection, runtime, execution, ranged.path);
        if (expanded.matches.length === 0) {
          notes.push(`${ranged.path}: no matches`);
          continue;
        }
        targets.push(...expanded.matches
          .slice(0, MAX_REMOTE_READ_TARGETS - targets.length)
          .map(path => ({ path, displayPath: path, start: ranged.start, end: ranged.end })));
        if (expanded.truncated === 'matches') {
          notes.push(`${ranged.path}: more than ${MAX_REMOTE_GLOB_MATCHES} matches, narrow the pattern`);
        } else if (expanded.truncated === 'scan') {
          notes.push(`${ranged.path}: glob scan stopped after ${REMOTE_GLOB_SCAN_LIMIT} candidates; more matches may exist`);
        }
      } catch (error) {
        failures += 1;
        content.push({ type: 'text', text: `--- ${requested} — ERROR ---\n${error instanceof Error ? error.message : String(error)}` });
      }
      continue;
    }
    try {
      const resolved = resolveRemotePath(runtime, execution, ranged.path);
      targets.push({ path: resolved, displayPath: resolved, start: ranged.start, end: ranged.end });
    } catch (error) {
      failures += 1;
      content.push({ type: 'text', text: `--- ${requested} — ERROR ---\n${error instanceof Error ? error.message : String(error)}` });
    }
  }

  const sharedRangeTargets = targets.filter(target => target.start === undefined && target.end === undefined).length;
  if (sharedRangeTargets > 1 && (args.start_line !== undefined || args.end_line !== undefined)) {
    notes.push(`(start_line/end_line applied to each of the ${sharedRangeTargets} files this call resolved to)`);
  }

  let remaining = MAX_READ_BYTES;
  let imageCount = 0;
  let imageBytes = 0;
  for (const target of targets) {
    if (remaining <= 0) {
      notes.push('(output cap reached; read the remaining paths in another call)');
      break;
    }
    const start = target.start ?? args.start_line;
    const end = target.end ?? args.end_line;
    let info: RemoteFileInfo;
    try {
      info = parseRemoteFileInfo(
        await connection.callTool({ name: 'get_file_info', arguments: { path: target.path } }),
        target.path
      );
    } catch (error) {
      failures += 1;
      content.push({
        type: 'text',
        text: `--- ${target.displayPath} — ERROR ---\n${error instanceof Error ? error.message : String(error)}`
      });
      continue;
    }

    if (info.isDirectory) {
      requireTool(connection, 'list_directory');
      try {
        const listed = await connection.callTool({
          name: 'list_directory',
          arguments: { path: target.path, depth: 1 }
        });
        const entries = parseRemoteDirectoryListing(listed, target.path)
          .filter(entry => !entry.relativePath.includes('/') && !entry.relativePath.includes('\\'));
        const body = entries.map(entry => {
          const kind = entry.type === 'directory' ? 'd' : entry.type === 'file' ? 'f' : '?';
          return `${kind} ${entry.name}${entry.size === null ? '' : `  ${entry.size} bytes`}`;
        }).join('\n');
        const rendered = entries.length === 0
          ? `--- ${target.displayPath} — empty folder ---`
          : `--- ${target.displayPath} — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, one level ---\n${body}`;
        const bounded = boundedUtf8(rendered, Math.min(args.max_bytes ?? DEFAULT_READ_BYTES, remaining));
        content.push({
          type: 'text',
          text: bounded.text + (bounded.truncated ? '\n(output truncated at requested max_bytes)' : '')
        });
        remaining -= Buffer.byteLength(bounded.text, 'utf8');
        successes += 1;
      } catch (error) {
        failures += 1;
        content.push({
          type: 'text',
          text: `--- ${target.displayPath} — ERROR ---\n${error instanceof Error ? error.message : String(error)}`
        });
      }
      continue;
    }

    if (!info.isFile) {
      failures += 1;
      content.push({
        type: 'text',
        text: `--- ${target.displayPath} — ERROR ---\nREMOTE_TOOL_ERROR: path is not a regular file or directory`
      });
      continue;
    }

    const perFileLimit = Math.min(args.max_bytes ?? DEFAULT_READ_BYTES, remaining);
    const firstLine = start ?? 1;
    const offset = firstLine - 1;
    const length = remoteReadLength(info, firstLine, perFileLimit, end);
    const result = await connection.callTool({
      name: 'read_file',
      arguments: {
        path: target.path,
        offset,
        length,
        includeStatusMessage: false
      }
    });
    if (result.isError) {
      failures += 1;
      const failed = remoteToolError('read_file', result);
      content.push({ type: 'text', text: `--- ${target.displayPath} — ERROR ---` }, ...failed.content);
      continue;
    }
    successes += 1;
    const blocks = mcpContent(result);
    const images = blocks.filter((item): item is Extract<BackendToolContent, { type: 'image' }> => item.type === 'image');
    if (images.length > 0) {
      content.push({
        type: 'text',
        text: `--- ${target.displayPath}${info.size === null ? '' : ` — ${info.size} bytes`} ---`
      });
    }
    for (const item of blocks) {
      if (item.type === 'text') {
        // DesktopCommander's image/PDF model-facing read includes a human text summary. Images
        // already have a typed MCP block, so do not mistake that summary for file content.
        if (images.length > 0) continue;
        const numbered = numberRemoteText(item.text, firstLine, perFileLimit);
        const range = info.lineCount === null
          ? `lines ${firstLine}-${numbered.lastLine}`
          : `lines ${firstLine}-${numbered.lastLine} of ${info.lineCount}`;
        const header = `--- ${target.displayPath} — ${range}${info.size === null ? '' : `, ${info.size} bytes`} ---`;
        const hasMore = info.lineCount !== null && numbered.lastLine < info.lineCount;
        const note = numbered.truncated
          ? `\n(output cap reached; continue from line ${numbered.lastLine + 1} or raise max_bytes up to ${MAX_READ_BYTES})`
          : hasMore
            ? `\n(more lines follow — continue from line ${numbered.lastLine + 1})`
            : '';
        const bounded = boundedUtf8(`${header}\n${numbered.text}${note}`, perFileLimit);
        content.push({
          type: 'text',
          text: bounded.text + (bounded.truncated ? '\n(output truncated at requested max_bytes)' : '')
        });
        remaining -= Buffer.byteLength(bounded.text, 'utf8');
      } else if (imageCount >= MAX_REMOTE_READ_IMAGES || imageBytes + item.data.length > MAX_REMOTE_READ_IMAGE_BYTES) {
        notes.push('(remote image output cap reached; read remaining images in another call or use view_image)');
      } else {
        imageCount += 1;
        imageBytes += item.data.length;
        content.push(item);
      }
    }
  }

  if (notes.length > 0) content.push({ type: 'text', text: notes.join('\n') });
  noteCount(successes);
  if (successes === 0 && failures > 0) return { content, isError: true };
  return { content: content.length ? content : [{ type: 'text', text: 'Nothing to read.' }] };
}

async function remoteViewImage(
  connection: RemoteNodeConnection,
  runtime: NodeRuntimeInfo,
  args: { path: string },
  execution: ExecutionSnapshot
): Promise<BackendToolResult> {
  requireTool(connection, 'read_file');
  const remotePath = resolveRemotePath(runtime, execution, args.path);
  const result = await connection.callTool({ name: 'read_file', arguments: { path: remotePath } });
  if (result.isError) return remoteToolError('read_file', result);
  const images = mcpContent(result).filter((item): item is Extract<BackendToolContent, { type: 'image' }> => item.type === 'image');
  if (images.length === 0) {
    return textResult(`REMOTE_TOOL_ERROR: ${remotePath} did not return an image from the frozen remote node`, true);
  }
  return { content: images };
}

function formatSearchResults(results: readonly SearchStructuredResult[]): string[] {
  return results.map(result =>
    result.type === 'content'
      ? `${result.file}:${result.line ?? '?'}: ${result.match ?? ''}`
      : result.file
  );
}

async function remoteFind(
  connection: RemoteNodeConnection,
  runtime: NodeRuntimeInfo,
  args: RemoteFindArgs,
  execution: ExecutionSnapshot
): Promise<BackendToolResult> {
  requireTool(connection, 'start_search');
  requireTool(connection, 'get_more_search_results');
  requireTool(connection, 'stop_search');
  if (args.exclude !== undefined) {
    return textResult(
      'CAPABILITY_UNAVAILABLE: this remote search backend cannot preserve an explicit `exclude` list yet; no search was started.',
      true
    );
  }
  const root = args.path !== undefined
    ? resolveRemotePath(runtime, execution, args.path)
    : execution.workspace;
  if (!root) {
    return textResult('WORKSPACE_REQUIRED: remote find needs a frozen workspace or an explicit remote path; no local filesystem was searched.', true);
  }
  const limit = Math.min(500, Math.max(1, Math.floor(args.max_results ?? 50)));
  const started = await connection.callTool({
    name: 'start_search',
    arguments: {
      path: root,
      pattern: args.query,
      searchType: (args.mode ?? 'name') === 'content' ? 'content' : 'files',
      ...(args.include ? { filePattern: args.include } : {}),
      ignoreCase: args.case_sensitive !== true,
      maxResults: limit,
      contextLines: 0,
      timeout_ms: 10_000,
      earlyTermination: false,
      literalSearch: args.regex !== true
    }
  });
  if (started.isError) return remoteToolError('start_search', started);
  let search = searchStructured(started, 'start_search');
  if (!search.sessionId) return textResult('REMOTE_TOOL_ERROR: start_search returned no remote search session id', true);
  const opaque = executionHandles.create(handleOwner(execution), search.sessionId);
  const seen = new Set<string>();
  const results: SearchStructuredResult[] = [];
  const append = (items: SearchStructuredResult[]) => {
    for (const item of items) {
      const key = `${item.type}\u0000${item.file}\u0000${item.line ?? ''}\u0000${item.match ?? ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push(item);
      }
    }
  };
  append(search.results);
  let offset = search.returnedCount;
  const deadline = Date.now() + 10_000;

  try {
    while (!search.completed && !search.error && results.length < limit && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      const remoteSession = executionHandles.remote(opaque, handleOwner(execution));
      const more = await connection.callTool({
        name: 'get_more_search_results',
        arguments: { sessionId: remoteSession, offset, length: Math.min(100, limit - results.length) }
      });
      if (more.isError) {
        const structured = searchStructured(more, 'get_more_search_results');
        if (structured.state === 'missing') {
          throw new ExecutionHandleError('the remote search session no longer exists');
        }
        return remoteToolError('get_more_search_results', more);
      }
      search = searchStructured(more, 'get_more_search_results');
      append(search.results);
      offset += search.returnedCount;
    }

    if (!search.completed && !search.error) {
      const remoteSession = executionHandles.remote(opaque, handleOwner(execution));
      const stopped = await connection.callTool({ name: 'stop_search', arguments: { sessionId: remoteSession } });
      if (!stopped.isError) searchStructured(stopped, 'stop_search');
    }
  } finally {
    executionHandles.revoke(opaque);
  }

  const limited = results.slice(0, limit);
  noteCount(limited.length);
  const lines = formatSearchResults(limited);
  const notes = [
    ...(search.incomplete ? ['(remote search completed with inaccessible paths; results may be incomplete)'] : []),
    ...(!search.completed ? ['(remote search stopped at the bounded 10-second find deadline)'] : [])
  ];
  if (search.error && limited.length === 0) {
    return textResult(`REMOTE_TOOL_ERROR: remote search failed: ${search.errorMessage ?? 'unknown search error'}`, true);
  }
  return textResult([...lines, ...notes].join('\n') || 'No matches found.');
}

function contentText(result: CallToolResult, tool: string): string {
  const blocks = mcpContent(result).filter((item): item is Extract<BackendToolContent, { type: 'text' }> => item.type === 'text');
  if (blocks.length !== 1) {
    throw new NodeRegistryError('REMOTE_TOOL_ERROR', `${tool} did not return exactly one text payload`);
  }
  return blocks[0]!.text;
}

async function remoteFileSnapshot(connection: RemoteNodeConnection, path: string): Promise<RemoteFileSnapshot> {
  requireTool(connection, 'get_file_info');
  requireTool(connection, 'read_file');
  const infoResult = await connection.callTool({ name: 'get_file_info', arguments: { path } });
  const info = infoResult.structuredContent as Record<string, unknown> | undefined;
  if (infoResult.isError) {
    if (info?.kind === 'file_info' && info.exists === false) return { exists: false };
    throw new NodeRegistryError(
      'REMOTE_TOOL_ERROR',
      `could not verify remote patch path ${path}: ${contentText(infoResult, 'get_file_info')}`
    );
  }
  if (!info || info.kind !== 'file_info' || info.exists !== true) {
    throw new NodeRegistryError('REMOTE_TOOL_ERROR', `get_file_info did not return structured existence metadata for ${path}`);
  }
  if (info.isFile !== true) {
    throw new NodeRegistryError('REMOTE_TOOL_ERROR', `remote patch target is not a regular file: ${path}`);
  }
  if (typeof info.size === 'number' && info.size > MAX_PATCH_SOURCE_BYTES) {
    throw new NodeRegistryError(
      'REMOTE_TOOL_ERROR',
      `remote patch target exceeds the ${MAX_PATCH_SOURCE_BYTES}-byte safety limit: ${path}`
    );
  }
  const readResult = await connection.callTool({
    name: 'read_file',
    arguments: { path, offset: 0, length: Number.MAX_SAFE_INTEGER, includeStatusMessage: false }
  });
  if (readResult.isError) {
    throw new NodeRegistryError('REMOTE_TOOL_ERROR', `could not read remote patch source ${path}: ${contentText(readResult, 'read_file')}`);
  }
  return { exists: true, content: contentText(readResult, 'read_file') };
}

function snapshotsEqual(left: RemoteFileSnapshot, right: RemoteFileSnapshot): boolean {
  if (left.exists !== right.exists) return false;
  return !left.exists || left.content === (right as Extract<RemoteFileSnapshot, { exists: true }>).content;
}

function patchPathApi(runtime: NodeRuntimeInfo): typeof nodePath.win32 | typeof nodePath.posix {
  return runtime.platform === 'win32' ? nodePath.win32 : nodePath.posix;
}

async function preflightRemotePatch(
  connection: RemoteNodeConnection,
  runtime: NodeRuntimeInfo,
  patch: string,
  execution: ExecutionSnapshot
): Promise<{ operations: RemotePatchOperation[]; summary: string[] }> {
  const parsed = parsePatch(patch);
  if (parsed.environmentId !== null) {
    throw new Error('apply_patch environment selection is unavailable for this turn');
  }
  if (!execution.workspace) {
    throw new Error('WORKSPACE_REQUIRED: the remote session has no frozen workspace; no patch was applied');
  }
  const pathApi = patchPathApi(runtime);
  const resolve = (spelled: string): string => pathApi.resolve(execution.workspace!, spelled);
  const pending = new Map<string, RemoteFileSnapshot>();
  const operations: RemotePatchOperation[] = [];
  const summary: string[] = [];

  const state = async (path: string): Promise<RemoteFileSnapshot> => {
    const staged = pending.get(path);
    if (staged) return staged;
    const snapshot = await remoteFileSnapshot(connection, path);
    pending.set(path, snapshot);
    return snapshot;
  };

  for (const hunk of parsed.hunks as Hunk[]) {
    if (hunk.kind === 'add_file') {
      const path = resolve(hunk.path);
      const before = await state(path);
      operations.push({ kind: 'write', path, expected: before, content: hunk.contents, displayPath: hunk.path });
      pending.set(path, { exists: true, content: hunk.contents });
      summary.push(`A ${hunk.path}`);
      continue;
    }

    const source = resolve(hunk.path);
    const before = await state(source);
    if (!before.exists) throw new Error(`Failed to read file to ${hunk.kind === 'delete_file' ? 'delete' : 'update'} ${source}: file does not exist`);

    if (hunk.kind === 'delete_file') {
      operations.push({ kind: 'delete', path: source, expected: before, displayPath: hunk.path });
      pending.set(source, { exists: false });
      summary.push(`D ${hunk.path}`);
      continue;
    }

    const derived = await deriveNewContentsFromChunks(
      source,
      hunk.chunks,
      DEFAULT_APPLY_PATCH_FILE_UPDATE_MODE,
      before.content
    );
    if (hunk.movePath === null) {
      operations.push({ kind: 'write', path: source, expected: before, content: derived.newContents, displayPath: hunk.path });
      pending.set(source, { exists: true, content: derived.newContents });
    } else {
      const destination = resolve(hunk.movePath);
      const normalizedDestination = pathApi.normalize(destination);
      const normalizedSource = pathApi.normalize(source);
      const samePath = runtime.platform === 'win32'
        ? normalizedDestination.toLowerCase() === normalizedSource.toLowerCase()
        : normalizedDestination === normalizedSource;
      if (samePath) {
        throw new Error('move source and destination resolve to the same file');
      }
      const destinationBefore = await state(destination);
      operations.push({
        kind: 'move',
        path: source,
        destination,
        expected: before,
        destinationExpected: destinationBefore,
        content: derived.newContents,
        displayPath: hunk.path
      });
      pending.set(source, { exists: false });
      pending.set(destination, { exists: true, content: derived.newContents });
    }
    summary.push(`M ${hunk.path}`);
  }
  if (operations.length === 0) throw new Error('No files were modified.');
  return { operations, summary };
}

async function remoteWriteText(connection: RemoteNodeConnection, runtime: NodeRuntimeInfo, path: string, content: string): Promise<void> {
  requireTool(connection, 'create_directory');
  requireTool(connection, 'write_file');
  const parent = patchPathApi(runtime).dirname(path);
  const mkdir = await connection.callTool({ name: 'create_directory', arguments: { path: parent } });
  if (mkdir.isError) throw new NodeRegistryError('REMOTE_TOOL_ERROR', `failed to create remote patch parent ${parent}: ${contentText(mkdir, 'create_directory')}`);
  const write = await connection.callTool({ name: 'write_file', arguments: { path, content, mode: 'rewrite' } });
  if (write.isError) throw new NodeRegistryError('REMOTE_TOOL_ERROR', `failed to write remote patch target ${path}: ${contentText(write, 'write_file')}`);
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function remoteDeleteFile(
  connection: RemoteNodeConnection,
  runtime: NodeRuntimeInfo,
  path: string,
  execution: ExecutionSnapshot
): Promise<void> {
  if (runtime.platform !== 'win32') {
    throw new NodeRegistryError('CAPABILITY_UNAVAILABLE', 'remote apply_patch deletion is currently supported only by the Windows node runtime');
  }
  requireTool(connection, 'start_process');
  const result = await connection.callTool({
    name: 'start_process',
    arguments: {
      command: `Remove-Item -LiteralPath ${quotePowerShellLiteral(path)} -Force -ErrorAction Stop`,
      timeout_ms: DEFAULT_EXEC_YIELD_TIME_MS,
      shell: runtime.defaultShell,
      ...(execution.workspace ? { cwd: execution.workspace } : {})
    }
  });
  if (result.isError) throw new NodeRegistryError('REMOTE_TOOL_ERROR', `failed to delete remote patch target ${path}: ${contentText(result, 'start_process')}`);
  const process = processStructured(result, 'start_process');
  if (process.running && !process.completed) {
    throw new RemoteNodeConnectionError(
      'EXECUTION_STATUS_UNKNOWN',
      `remote delete for ${path} is still running after the bounded wait; it was not replayed`,
      true
    );
  }
  if (process.exitCode !== 0) {
    throw new NodeRegistryError('REMOTE_TOOL_ERROR', `remote delete failed for ${path}: ${process.output || `exit ${process.exitCode}`}`);
  }
}

async function assertRemoteSnapshot(connection: RemoteNodeConnection, path: string, expected: RemoteFileSnapshot): Promise<void> {
  const actual = await remoteFileSnapshot(connection, path);
  if (!snapshotsEqual(actual, expected)) {
    throw new NodeRegistryError('TARGET_CHANGED', `remote patch baseline changed before mutation: ${path}`);
  }
}

async function remoteApplyPatch(
  connection: RemoteNodeConnection,
  runtime: NodeRuntimeInfo,
  args: { patch: string },
  execution: ExecutionSnapshot
): Promise<BackendToolResult> {
  let plan: { operations: RemotePatchOperation[]; summary: string[] };
  try {
    plan = await preflightRemotePatch(connection, runtime, args.patch, execution);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return textResult(`apply_patch verification failed: ${message}`, true);
  }

  const committed: string[] = [];
  try {
    for (const operation of plan.operations) {
      await assertRemoteSnapshot(connection, operation.path, operation.expected);
      if (operation.kind === 'write') {
        await remoteWriteText(connection, runtime, operation.path, operation.content);
      } else if (operation.kind === 'delete') {
        await remoteDeleteFile(connection, runtime, operation.path, execution);
      } else {
        await assertRemoteSnapshot(connection, operation.destination, operation.destinationExpected);
        // Preserve CoS move semantics: write the reconstructed destination first, then remove the
        // source. If source removal has an unknown outcome, do not attempt an automatic rollback.
        await remoteWriteText(connection, runtime, operation.destination, operation.content);
        try {
          await remoteDeleteFile(connection, runtime, operation.path, execution);
        } catch (error) {
          if (error instanceof RemoteNodeConnectionError && error.code === 'EXECUTION_STATUS_UNKNOWN') throw error;
          const sourceStill = await remoteFileSnapshot(connection, operation.path);
          const destinationStill = await remoteFileSnapshot(connection, operation.destination);
          if (snapshotsEqual(sourceStill, operation.expected) &&
              snapshotsEqual(destinationStill, { exists: true, content: operation.content })) {
            if (operation.destinationExpected.exists) {
              await remoteWriteText(connection, runtime, operation.destination, operation.destinationExpected.content);
            } else {
              await remoteDeleteFile(connection, runtime, operation.destination, execution);
            }
          }
          throw error;
        }
      }
      committed.push(operation.displayPath);
    }
  } catch (error) {
    const prefix = committed.length > 0
      ? `remote apply_patch stopped after committing ${committed.length} operation(s) (${committed.join(', ')}): `
      : 'remote apply_patch failed before any planned file mutation completed: ';
    if (error instanceof RemoteNodeConnectionError) {
      throw new RemoteNodeConnectionError(
        error.code,
        `${prefix}${error.message.replace(/^[A-Z_]+:\s*/, '')}`,
        error.requestMayHaveBeenSent
      );
    }
    if (error instanceof NodeRegistryError) {
      throw new NodeRegistryError(error.code, `${prefix}${error.message.replace(/^[A-Z_]+:\s*/, '')}`);
    }
    throw new NodeRegistryError('REMOTE_TOOL_ERROR', `${prefix}${error instanceof Error ? error.message : String(error)}`);
  }

  return textResult(`Success. Updated the following files:\n${plan.summary.join('\n')}`);
}

async function executeRemote(
  connection: RemoteNodeConnection,
  runtime: NodeRuntimeInfo,
  surface: SurfaceId,
  name: string,
  args: unknown,
  _execution: ExecutionSnapshot
): Promise<BackendToolResult> {
  if (surface === 'desktop') {
    if (runtime.platform !== 'win32') {
      return textResult(`CAPABILITY_UNAVAILABLE: remote desktop Window2 methods require a Windows node; ${runtime.nodeId} is ${runtime.platform}.`, true);
    }
    requireTool(connection, 'cos_windows_desktop');
    const result = await connection.callTool({
      name: 'cos_windows_desktop',
      arguments: {
        context_key: `${_execution.sessionId}:${_execution.bindingVersion}`,
        method: name,
        arguments: args && typeof args === 'object' ? args as Record<string, unknown> : {}
      }
    });
    if (result.isError) return remoteToolError('cos_windows_desktop', result);
    return {
      content: mcpContent(result),
      ...(result.structuredContent && typeof result.structuredContent === 'object'
        ? { structuredContent: result.structuredContent as Record<string, unknown> }
        : {})
    };
  }
  if (surface !== 'core') {
    return textResult(`CAPABILITY_UNAVAILABLE: ${surface} is not an execution-node computer surface`, true);
  }
  if (name === 'read') return remoteRead(connection, runtime, args as ReadArgs, _execution);
  if (name === 'view_image') return remoteViewImage(connection, runtime, args as { path: string }, _execution);
  if (name === 'find') return remoteFind(connection, runtime, args as RemoteFindArgs, _execution);
  if (name === 'apply_patch') return remoteApplyPatch(connection, runtime, args as { patch: string }, _execution);
  if (name === 'exec_command') return remoteExec(connection, runtime, args as RemoteExecArgs, _execution);
  if (name === 'write_stdin') return remoteWriteStdin(connection, args as RemoteWriteStdinArgs, _execution);

  // Terminal/process, patch, search and artifact adapters are added beside this switch. Until their
  // exact semantic contracts are present, failing closed is safer than dropping into the control
  // host implementation or passing a superficially similar DesktopCommander tool through.
  return textResult(
    `CAPABILITY_UNAVAILABLE: ${name} is not yet adapted for remote node ${runtime.nodeId}; no local fallback was attempted.`,
    true
  );
}

/**
 * Internal backend switch for stable model-facing computer tools.
 *
 * Schemas are validated by the registrar before reaching here. The frozen snapshot is model-
 * invisible and comes only from exact request/input correlation. Local snapshots call the original
 * handler. Remote snapshots hold both the durable session target lease and NodeRegistry execution
 * lease through dispatch, closing the rebind/config/reconnect check-to-side-effect races.
 */
export async function routeExecutionTool(
  surface: SurfaceId,
  name: string,
  args: unknown,
  local: LocalHandler
): Promise<BackendToolResult> {
  if (!routesComputerTool(surface, name)) return local();
  const context = currentCall();
  const execution = context?.execution ?? null;
  if (!execution) {
    // Admission should already have refused this. Keep this second fence so a future call site that
    // bypasses dispatch cannot accidentally turn missing authority into local execution.
    return textResult('TARGET_CONTEXT_UNRESOLVED: no exact frozen execution snapshot; no local fallback was attempted', true);
  }
  if (execution.nodeId === LOCAL_NODE_ID) return local();

  try {
    return await withSessionExecutionTargetLease(execution.sessionId, executionTarget(execution), () =>
      nodeRegistry.withExecutionConnection(execution, (connection, runtime) =>
        executeRemote(connection, runtime, surface, name, args, execution)
      )
    );
  } catch (error) {
    return routedFailure(error);
  }
}
