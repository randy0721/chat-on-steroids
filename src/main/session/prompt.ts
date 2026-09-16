import path from 'node:path';
import { readFileStream } from '../codex/filesystem.js';
import { effectiveCapabilities, getConfig } from '../config.js';
import { currentCoreInstructions } from '../mcp/instructions.js';
import { getSessionProject, projectWorkspace } from '../projects.js';
import { resolvePath } from '../sandbox.js';
import { MAX_CHATGPT_MESSAGE_CHARS, prependUserPrompt } from '../../shared/user-prompt.js';
import { LOCAL_NODE_ID, type ExecutionSnapshot } from '../../shared/nodes.js';
import { nodeRegistry } from '../nodes/registry.js';
import { withSessionExecutionTargetLease } from './store.js';

type PromptScope = { sessionId?: string | null; projectId?: string | null; executionSnapshot?: ExecutionSnapshot };
export type PromptLimits = { maxChars: number; maxBytes: number };
type ProjectInstructions = { directory: string; text: string; truncated: boolean };
const limits: PromptLimits = { maxChars: MAX_CHATGPT_MESSAGE_CHARS, maxBytes: Infinity };
const cutNotice = '\n\n[Cut off because of the message limit. Read AGENTS.md yourself for the remaining instructions.]';

function platformName(platform: NodeJS.Platform | 'win32' | 'darwin' | 'linux'): string {
  return platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : platform;
}

/**
 * Small model-visible projection of the client-owned execution binding. Routing authority stays in
 * ExecutionSnapshot; this prose is explanatory only and deliberately contains no credential or
 * model-selectable node field.
 */
export async function executionEnvironmentProjection(execution: ExecutionSnapshot | undefined): Promise<string> {
  if (!execution) {
    return [
      'Current execution environment',
      '- Target computer: unresolved',
      '- Computer tools must fail closed until the client provides exact execution identity.',
      '- Do not choose a computer from UI state, history, paths, or tool arguments; do not fall back to the local machine.'
    ].join('\n');
  }

  if (execution.nodeId === LOCAL_NODE_ID) {
    const config = getConfig();
    const caps = effectiveCapabilities(config);
    const capabilities = [
      caps.read || caps.browse || caps.metadata ? 'files' : null,
      caps.command ? 'terminal' : null,
      caps.create || caps.edit || caps.move || caps.deleteFile ? 'patch' : null,
      caps.screen || caps.control ? 'desktop' : null
    ].filter((value): value is string => value !== null);
    const shell = process.platform === 'win32' ? 'PowerShell' : process.env.SHELL || 'system default shell';
    return [
      'Current execution environment',
      `- Target computer: Local (${execution.nodeId})`,
      `- System: ${platformName(process.platform)}`,
      `- Default terminal: ${shell}`,
      `- Workspace: ${execution.workspace ?? '(not bound)'}`,
      `- Available computer capabilities: ${capabilities.join(', ') || 'none'}`,
      '- The client has bound computer tools for this turn to this exact target and executor instance.',
      '- Historical paths, files, frames and process handles from another target/binding are not authority for this turn.',
      '- If the bound node is unavailable, report the node error and wait for recovery; never choose or fall back to another computer.'
    ].join('\n');
  }

  const registered = await nodeRegistry.get(execution.nodeId).catch(() => null);
  const sameConfig = registered?.config.configVersion === execution.nodeConfigVersion;
  const runtime = sameConfig && registered?.runtimeInfo?.machineId === execution.machineId &&
    registered.runtimeInfo.agentInstanceId === execution.agentInstanceId
    ? registered.runtimeInfo : null;
  const name = sameConfig ? registered!.config.name : execution.nodeId;
  return [
    'Current execution environment',
    `- Target computer: ${name} (${execution.nodeId})`,
    `- System: ${runtime ? platformName(runtime.platform) : 'remote node (exact frozen runtime currently unavailable)'}`,
    `- Default terminal: ${runtime?.defaultShell ?? '(unavailable until the exact frozen runtime is connected)'}`,
    `- Workspace: ${execution.workspace ?? '(not bound)'}`,
    `- Approved roots: ${runtime?.approvedRoots.length ? runtime.approvedRoots.join(', ') : '(not advertised)'}`,
    `- Available computer capabilities: ${runtime?.capabilities.length ? runtime.capabilities.join(', ') : '(unavailable)'}`,
    '- The client has bound computer tools for this turn to this exact target and executor instance; this text is not a machine selector.',
    '- Historical paths, files, frames and process handles from another target/binding are not authority for this turn.',
    '- If the bound node is unavailable, report the node error and wait for recovery; never choose or fall back to the local computer or another node.'
  ].join('\n');
}

/** One selected folder, never cwd inference, global discovery or a recursive document scan. */
async function projectInstructions(scope: PromptScope): Promise<ProjectInstructions | null> {
  if ((!scope.sessionId && !scope.projectId) || !effectiveCapabilities(getConfig()).read) return null;
  const execution = scope.executionSnapshot;
  if (execution && execution.nodeId !== LOCAL_NODE_ID) {
    if (!execution.workspace) return null;
    const expected = {
      nodeId: execution.nodeId,
      workspace: execution.workspace,
      bindingVersion: execution.bindingVersion,
      nodeConfigVersion: execution.nodeConfigVersion
    };
    try {
      return await withSessionExecutionTargetLease(execution.sessionId, expected, () =>
        nodeRegistry.withExecutionConnection(execution, async (connection, runtime) => {
          const names = new Set(connection.tools.map(tool => tool.name));
          if (!names.has('get_file_info') || !names.has('read_file')) {
            throw new Error('remote node does not publish the restricted read tools');
          }
          const platformPath = runtime.platform === 'win32' ? path.win32 : path.posix;
          const filename = platformPath.join(execution.workspace!, 'AGENTS.md');
          const info = await connection.callTool({ name: 'get_file_info', arguments: { path: filename } });
          const structured = info.structuredContent as Record<string, unknown> | undefined;
          if (info.isError) {
            if (structured?.kind === 'file_info' && structured.exists === false) return null;
            throw new Error('remote AGENTS.md metadata read failed');
          }
          if (!structured || structured.kind !== 'file_info' || structured.exists !== true || structured.isFile !== true ||
              typeof structured.size !== 'number' || structured.size < 0) {
            throw new Error('remote AGENTS.md metadata is invalid');
          }
          const budget = MAX_CHATGPT_MESSAGE_CHARS * 4;
          if (structured.size > budget) {
            throw new Error('remote AGENTS.md exceeds the bounded prompt-read budget');
          }
          const read = await connection.callTool({ name: 'read_file', arguments: { path: filename, offset: 0, length: 100_000 } });
          if (read.isError) throw new Error('remote AGENTS.md content read failed');
          const text = (read.content ?? []).filter((item): item is Extract<typeof item, { type: 'text' }> => item.type === 'text')
            .map(item => item.text).join('\n');
          if (Buffer.byteLength(text, 'utf8') > budget || text.includes('\0')) {
            throw new Error('remote AGENTS.md content is not a bounded UTF-8 text file');
          }
          return text.trim() ? { directory: execution.workspace!, text, truncated: false } : null;
        })
      );
    } catch {
      // Never fall through to local project/path resolution for a remote-bound opening.
      throw new Error('Could not read the selected remote folder\'s AGENTS.md safely');
    }
  }
  // Existing sessions own their project; a caller-provided project cannot replace that binding.
  const folder = scope.sessionId ? await getSessionProject(scope.sessionId)
    : await projectWorkspace(scope.projectId!);
  if (!folder) return null;
  const filename = path.join(folder.real, 'AGENTS.md');
  try {
    const resolved = await resolvePath(getConfig().roots, filename, { allowMissing: true });
    // At most four UTF-8 bytes per available UTF-16 code unit, plus one byte to detect overflow.
    // Stream a bounded prefix so even a gigabyte AGENTS.md never becomes a gigabyte allocation.
    const budget = MAX_CHATGPT_MESSAGE_CHARS * 4;
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of readFileStream(resolved.real)) {
      const kept = chunk.subarray(0, Math.max(0, budget + 1 - bytes));
      chunks.push(kept);
      bytes += kept.length;
      if (bytes > budget) break;
    }
    const data = Buffer.concat(chunks);
    // Streaming decode leaves an incomplete final codepoint out of a shortened prefix.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, budget), { stream: bytes > budget });
    if (text.includes('\0')) throw new Error('AGENTS.md must be a UTF-8 text file');
    // Permission/path changes during the asynchronous read cannot publish another folder's text.
    const current = scope.sessionId ? await getSessionProject(scope.sessionId) : await projectWorkspace(scope.projectId!);
    const checked = await resolvePath(getConfig().roots, filename);
    if (!current || current.real !== folder.real || checked.real !== resolved.real || !effectiveCapabilities(getConfig()).read)
      throw new Error('Project instructions changed location or permission while being read');
    return text.trim() ? { directory: current.virtual, text, truncated: bytes > budget } : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // Do not expose native filesystem paths through the browser bridge's error response.
    throw new Error('Could not read the selected folder\'s AGENTS.md safely');
  }
}

/** User text and the complete Core prompt are mandatory; only project instructions spend slack. */
export function fitSessionPrompt(text: string, core: string, agents: ProjectInstructions | null = null, budget = limits): string {
  const fits = (value: string): boolean => value.length <= Math.min(MAX_CHATGPT_MESSAGE_CHARS, budget.maxChars) &&
    Buffer.byteLength(value, 'utf8') <= budget.maxBytes;
  const base = prependUserPrompt(text, core);
  if (!fits(base)) throw new Error('The message and main instructions exceed the delivery limit (maximum 96,000 characters). Shorten the message or standing instructions.');
  if (!agents) return base;
  const content = agents.text.replace(/\r\n?/g, '\n');
  const render = (length: number, shortened: boolean): string => {
    // Never split a UTF-16 surrogate pair at the character budget boundary.
    if (length > 0 && /[\uD800-\uDBFF]/.test(content[length - 1]!)) length--;
    const instructions = `# AGENTS.md instructions for ${agents.directory}\n\n<INSTRUCTIONS>\n${content.slice(0, length)}${shortened ? cutNotice : ''}\n</INSTRUCTIONS>`;
    return prependUserPrompt(text, `${core}\n\n${instructions}`);
  };
  const full = render(content.length, agents.truncated);
  if (fits(full)) return full;
  // Include the framing, length header and truncation notice in the exact final budget.
  let low = 0, high = content.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(render(middle, true))) low = middle;
    else high = middle - 1;
  }
  return low > 0 ? render(low, true) : base;
}

/** Opening normal/worker messages only. Callers own first-message eligibility;
 * follow-ups, helpers, handoff requests and resumed bootstraps never call this. */
export async function prepareSessionPrompt(text: string, scope: PromptScope = {}, budget = limits): Promise<string> {
  const projection = scope.executionSnapshot ? await executionEnvironmentProjection(scope.executionSnapshot) : '';
  const core = `${await currentCoreInstructions()}${projection ? `\n\n${projection}` : ''}`;
  fitSessionPrompt(text, core, null, budget); // Reject mandatory overflow before reading optional files.
  return fitSessionPrompt(text, core, await projectInstructions(scope), budget);
}
