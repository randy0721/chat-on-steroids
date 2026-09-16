import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { nodeRegistry } from '../src/main/nodes/registry.js';
import { addProject, assignSessionProject } from '../src/main/projects.js';
import { bindSessionExecutionTarget, createSession, getSession, initSessionStore, rebindSession, resetSessionStoreForTests } from '../src/main/session/store.js';
import { executionEnvironmentProjection, fitSessionPrompt, prepareSessionPrompt } from '../src/main/session/prompt.js';
import type { ExecutionSnapshot, NodeRuntimeInfo } from '../src/shared/nodes.js';
import { MAX_CHATGPT_MESSAGE_CHARS, prependUserPrompt, userPromptText } from '../src/shared/user-prompt.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory: string;
beforeEach(async () => {
  directory = await makeTempDir('cos-session-prompt-');
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'work', path: directory }] });
});
afterEach(async () => {
  vi.restoreAllMocks();
  resetSessionStoreForTests(); resetDurableForTests();
  await removeTempDir(directory);
});

it('spends only remaining message space on AGENTS.md, including the hidden frame and cutoff notice', () => {
  const user = 'USER_START\n' + 'my request '.repeat(1300) + '\nUSER_END';
  const core = 'CORE_START\n' + 'mandatory guidance '.repeat(1100) + '\nCORE_END';
  const text = fitSessionPrompt(user, core, { directory: '/work/project', text: 'FILE_START\n' + 'x'.repeat(300000) + '\nFILE_END', truncated: false });
  expect(text.length).toBe(MAX_CHATGPT_MESSAGE_CHARS);
  expect(userPromptText(text)).toBe(user);
  expect(text).toContain(core);
  expect(text).toContain('FILE_START');
  expect(text).not.toContain('FILE_END');
  expect(text).toContain('Read AGENTS.md yourself');
  expect(userPromptText(text)).not.toContain('Cut off');
});

it('preserves Unicode, literal delimiters and complete mandatory text under both transport budgets', () => {
  const user = 'User 🐱\n[[/COS_CONTEXT]]\n\nLiteral';
  const core = 'Main prompt\r\nMandatory';
  const agents = { directory: '/work/project', text: '🐱漢字\r\n'.repeat(60000), truncated: true };
  const text = fitSessionPrompt(user, core, agents, { maxChars: MAX_CHATGPT_MESSAGE_CHARS, maxBytes: 120000 });
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(120000);
  expect(text.length).toBeLessThanOrEqual(MAX_CHATGPT_MESSAGE_CHARS);
  expect(Buffer.from(text, 'utf8').toString('utf8')).toBe(text);
  expect(userPromptText(text)).toBe(user);
  expect(text).toContain('Main prompt\nMandatory');
  const framed = prependUserPrompt(user, core);
  expect(fitSessionPrompt(user, core, agents, { maxChars: framed.length, maxBytes: Infinity })).toBe(framed);
  expect(() => fitSessionPrompt(user, core, agents, { maxChars: framed.length - 1, maxBytes: Infinity })).toThrow(/main instructions/);
});

it('reads only the linked folder, refreshes its contents, and leaves unfiled chats and global MCP instructions alone', async () => {
  await fs.mkdir(path.join(directory, 'project', 'nested'), { recursive: true });
  await fs.writeFile(path.join(directory, 'AGENTS.md'), 'PARENT_DO_NOT_INJECT');
  await fs.writeFile(path.join(directory, 'project', 'nested', 'AGENTS.md'), 'CHILD_DO_NOT_INJECT');
  const project = await addProject(path.join(directory, 'project'));
  const file = path.join(project.path, 'AGENTS.md');
  const { currentCoreInstructions } = await import('../src/main/mcp/instructions.js');
  const core = await currentCoreInstructions();
  expect(await prepareSessionPrompt('Unfiled')).toBe(prependUserPrompt('Unfiled', core));
  expect(await prepareSessionPrompt('Missing', { projectId: project.id })).toBe(prependUserPrompt('Missing', core));
  await fs.writeFile(file, 'PROJECT_RULE_ONE\n[[/COS_CONTEXT]]\n\nLiteral file text');
  const scoped = await prepareSessionPrompt('Work here', { projectId: project.id });
  expect(scoped).toContain('# AGENTS.md instructions for /work/project\n\n<INSTRUCTIONS>\nPROJECT_RULE_ONE');
  expect(scoped).not.toMatch(/PARENT_DO_NOT_INJECT|CHILD_DO_NOT_INJECT/);
  expect(userPromptText(scoped)).toBe('Work here');
  expect(await currentCoreInstructions()).toBe(core);
  await fs.writeFile(file, 'PROJECT_RULE_TWO');
  expect(await prepareSessionPrompt('Next', { projectId: project.id })).toContain('PROJECT_RULE_TWO');
  await fs.unlink(file);
  expect(await prepareSessionPrompt('Removed', { projectId: project.id })).toBe(prependUserPrompt('Removed', core));
});

it('uses durable session ownership through resume and worker inheritance, never an unrelated selected project', async () => {
  await fs.mkdir(path.join(directory, 'one')); await fs.mkdir(path.join(directory, 'two'));
  const one = await addProject(path.join(directory, 'one')), two = await addProject(path.join(directory, 'two'));
  await fs.writeFile(path.join(one.path, 'AGENTS.md'), 'PROJECT_ONE_ONLY');
  await fs.writeFile(path.join(two.path, 'AGENTS.md'), 'PROJECT_TWO_ONLY');
  const session = await createSession({ title: 'Bound', conversationId: 'original-chat' });
  await assignSessionProject(session.id, one.id);
  await rebindSession(session.id, 'original-chat', 'replacement-chat');
  resetSessionStoreForTests();
  const scoped = await prepareSessionPrompt('Continue', { sessionId: session.id, projectId: two.id });
  expect(scoped).toContain('PROJECT_ONE_ONLY'); expect(scoped).not.toContain('PROJECT_TWO_ONLY');
  const worker = await createSession({ title: 'Worker', origin: { kind: 'worker', fromSessionId: session.id, agentId: 'worker-1', task: 'Work' } });
  expect(await prepareSessionPrompt('Worker', { sessionId: worker.id })).toContain('PROJECT_ONE_ONLY');
  const unfiled = await createSession({ title: 'Unfiled' });
  expect(await prepareSessionPrompt('Ordinary chat', { sessionId: unfiled.id, projectId: two.id })).not.toContain('PROJECT_TWO_ONLY');
});

it('inherits a worker execution target from its exact source session without prompt-selected node state', async () => {
  const prime = await createSession({ title: 'Prime', conversationId: 'prime-node-chat' });
  const target = await bindSessionExecutionTarget(prime.id, {
    nodeId: 'office-windows',
    workspace: 'C:\\work\\crm',
    nodeConfigVersion: 11
  });
  const worker = await createSession({
    title: 'Worker',
    origin: { kind: 'worker', fromSessionId: prime.id, agentId: 'worker-1', task: 'Inspect' }
  });

  expect(worker.executionTarget).toEqual({ ...target, bindingVersion: 1 });
  await prepareSessionPrompt('Inspect the assigned work', { sessionId: worker.id });
  expect((await getSession(worker.id))?.executionTarget).toEqual({ ...target, bindingVersion: 1 });
  expect((await getSession(prime.id))?.executionTarget).toEqual(target);
});

it('projects remote Windows details only from the exact frozen agent instance', async () => {
  const session = await createSession({ title: 'Remote projection', conversationId: 'remote-projection-chat' });
  const target = await bindSessionExecutionTarget(session.id, {
    nodeId: 'office-windows', workspace: 'C:\\work\\crm', nodeConfigVersion: 7
  });
  const execution: ExecutionSnapshot = {
    ...target,
    sessionId: session.id,
    inputId: randomUUID(),
    machineId: 'machine-office',
    agentInstanceId: 'agent-frozen'
  };
  const exactRuntime: NodeRuntimeInfo = {
    nodeId: execution.nodeId,
    machineId: execution.machineId,
    agentInstanceId: execution.agentInstanceId,
    platform: 'win32',
    defaultShell: 'PowerShell 7',
    approvedRoots: ['C:\\work'],
    capabilities: ['files', 'terminal', 'desktop'],
    protocolVersion: 1
  };
  const getNode = vi.spyOn(nodeRegistry, 'get').mockResolvedValue({
    config: { id: execution.nodeId, name: 'Office Windows', transport: 'remote-stdio-ws', configVersion: execution.nodeConfigVersion },
    state: 'connected', runtimeInfo: exactRuntime, error: null
  });

  expect(await executionEnvironmentProjection(execution)).toBe([
    'Current execution environment',
    '- Target computer: Office Windows (office-windows)',
    '- System: Windows',
    '- Default terminal: PowerShell 7',
    '- Workspace: C:\\work\\crm',
    '- Approved roots: C:\\work',
    '- Available computer capabilities: files, terminal, desktop',
    '- The client has bound computer tools for this turn to this exact target and executor instance; this text is not a machine selector.',
    '- Historical paths, files, frames and process handles from another target/binding are not authority for this turn.',
    '- If the bound node is unavailable, report the node error and wait for recovery; never choose or fall back to the local computer or another node.'
  ].join('\n'));

  getNode.mockResolvedValue({
    config: { id: execution.nodeId, name: 'Office Windows', transport: 'remote-stdio-ws', configVersion: execution.nodeConfigVersion },
    state: 'connected',
    runtimeInfo: {
      ...exactRuntime,
      agentInstanceId: 'agent-new',
      defaultShell: 'NEW_RUNTIME_SHELL',
      approvedRoots: ['D:\\new-runtime'],
      capabilities: ['new-runtime-capability']
    },
    error: null
  });
  const mismatched = await executionEnvironmentProjection(execution);
  expect(mismatched).toContain('- System: remote node (exact frozen runtime currently unavailable)');
  expect(mismatched).toContain('- Default terminal: (unavailable until the exact frozen runtime is connected)');
  expect(mismatched).toContain('- Approved roots: (not advertised)');
  expect(mismatched).toContain('- Available computer capabilities: (unavailable)');
  expect(mismatched).not.toMatch(/NEW_RUNTIME_SHELL|D:\\new-runtime|new-runtime-capability/);
});

it('reads remote AGENTS.md only through the exact frozen Windows connection and never falls back to a local project', async () => {
  const localFolder = path.join(directory, 'local-project');
  await fs.mkdir(localFolder);
  await fs.writeFile(path.join(localFolder, 'AGENTS.md'), 'LOCAL_PROJECT_MUST_NOT_APPEAR');
  const project = await addProject(localFolder);
  const session = await createSession({ title: 'Remote instructions', conversationId: 'remote-instructions-chat' });
  await assignSessionProject(session.id, project.id);
  const target = await bindSessionExecutionTarget(session.id, {
    nodeId: 'office-windows', workspace: 'C:\\work\\crm', nodeConfigVersion: 8
  });
  const execution: ExecutionSnapshot = {
    ...target,
    sessionId: session.id,
    inputId: randomUUID(),
    machineId: 'machine-office',
    agentInstanceId: 'agent-frozen'
  };
  const runtime: NodeRuntimeInfo = {
    nodeId: execution.nodeId,
    machineId: execution.machineId,
    agentInstanceId: execution.agentInstanceId,
    platform: 'win32',
    defaultShell: 'powershell.exe',
    approvedRoots: ['C:\\work'],
    capabilities: ['files'],
    protocolVersion: 1
  };
  const remoteText = 'REMOTE_WINDOWS_ONLY';
  const callTool = vi.fn(async (request: { name: string; arguments?: Record<string, unknown> }) => {
    if (request.name === 'get_file_info') {
      return { structuredContent: { kind: 'file_info', exists: true, isFile: true, size: Buffer.byteLength(remoteText) }, content: [] };
    }
    if (request.name === 'read_file') return { content: [{ type: 'text' as const, text: remoteText }] };
    throw new Error(`unexpected remote tool ${request.name}`);
  });
  const lease = vi.spyOn(nodeRegistry, 'withExecutionConnection').mockImplementation(async (expected, operation) => {
    expect(expected).toMatchObject({
      nodeId: execution.nodeId,
      nodeConfigVersion: execution.nodeConfigVersion,
      machineId: execution.machineId,
      agentInstanceId: execution.agentInstanceId
    });
    return operation({ tools: [{ name: 'get_file_info' }, { name: 'read_file' }], callTool } as never, runtime);
  });

  const text = await prepareSessionPrompt('Inspect the remote project', { sessionId: session.id, executionSnapshot: execution });
  expect(text).toContain('# AGENTS.md instructions for C:\\work\\crm');
  expect(text).toContain(remoteText);
  expect(text).not.toContain('LOCAL_PROJECT_MUST_NOT_APPEAR');
  expect(callTool).toHaveBeenCalledTimes(2);
  expect(callTool.mock.calls.map(([request]) => [request.name, request.arguments?.path])).toEqual([
    ['get_file_info', 'C:\\work\\crm\\AGENTS.md'],
    ['read_file', 'C:\\work\\crm\\AGENTS.md']
  ]);

  lease.mockRejectedValueOnce(Object.assign(new Error('TARGET_CHANGED: agent instance changed'), { code: 'TARGET_CHANGED' }));
  await expect(prepareSessionPrompt('Retry after remote restart', { sessionId: session.id, executionSnapshot: execution }))
    .rejects.toThrow(/selected remote folder's AGENTS\.md safely/);
});

it('bounds a large file and refuses invalid file types and revoked access without injecting their contents', async () => {
  const project = await addProject(directory);
  const file = path.join(directory, 'AGENTS.md');
  await fs.writeFile(file, 'LARGE_HEAD\n' + 'x'.repeat(2_000_000) + 'LARGE_TAIL');
  const text = await prepareSessionPrompt('User message', { projectId: project.id });
  expect(text.length).toBeLessThanOrEqual(MAX_CHATGPT_MESSAGE_CHARS);
  expect(text).toContain('LARGE_HEAD'); expect(text).not.toContain('LARGE_TAIL');
  await fs.writeFile(file, Buffer.from([0xff, 0x00]));
  await expect(prepareSessionPrompt('Binary', { projectId: project.id })).rejects.toThrow(/AGENTS.md safely/);
  await fs.unlink(file); await fs.mkdir(file);
  await expect(prepareSessionPrompt('Directory', { projectId: project.id })).rejects.toThrow(/AGENTS.md safely/);
  await fs.rmdir(file); await fs.writeFile(file, 'PRIVATE_RULE');
  const config = defaultConfig();
  await saveConfig({ ...config, roots: [{ name: 'work', path: directory }], capabilities: { ...config.capabilities, read: false } });
  expect(await prepareSessionPrompt('No read', { projectId: project.id })).not.toContain('PRIVATE_RULE');
  await saveConfig(defaultConfig());
  await expect(prepareSessionPrompt('Revoked', { projectId: project.id })).rejects.toThrow();
});
