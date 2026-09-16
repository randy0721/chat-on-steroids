import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { emptyEvidence, runInCallContext, type CallContext } from '../src/main/mcp/call-context.js';
import { routeExecutionTool } from '../src/main/nodes/backend.js';
import { RemoteNodeConnectionError } from '../src/main/nodes/connection.js';
import { executionHandles } from '../src/main/nodes/handles.js';
import { nodeRegistry } from '../src/main/nodes/registry.js';
import {
  bindSessionExecutionTarget,
  createSession,
  initSessionStore,
  resetSessionStoreForTests
} from '../src/main/session/store.js';
import type { ExecutionSnapshot, NodeRuntimeInfo } from '../src/shared/nodes.js';

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-node-backend-'));
  initDurableStore(directory);
  initSessionStore(directory);
  executionHandles.clear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  executionHandles.clear();
  resetSessionStoreForTests();
  resetDurableForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

async function remoteExecution(nodeId = 'office', agentInstanceId = 'agent-one') {
  const session = await createSession({ conversationId: `conversation-${nodeId}`, title: 'Remote' });
  const target = await bindSessionExecutionTarget(session.id, {
    nodeId,
    workspace: 'C:\\work\\crm',
    nodeConfigVersion: 3
  });
  const execution: ExecutionSnapshot = {
    ...target,
    sessionId: session.id,
    inputId: randomUUID(),
    machineId: `machine-${nodeId}`,
    agentInstanceId
  };
  return { session, execution };
}

function context(execution: ExecutionSnapshot): CallContext {
  return {
    startedAt: Date.now(),
    transportKey: null,
    agent: null,
    caller: {
      transportKey: null,
      requestId: `request-${execution.inputId}`,
      conversationId: `conversation-${execution.nodeId}`,
      sessionId: execution.sessionId
    },
    execution,
    outcome: null,
    evidence: emptyEvidence()
  };
}

function runtime(execution: ExecutionSnapshot): NodeRuntimeInfo {
  return {
    nodeId: execution.nodeId,
    machineId: execution.machineId,
    agentInstanceId: execution.agentInstanceId,
    platform: 'win32',
    defaultShell: 'PowerShell',
    approvedRoots: ['C:\\work'],
    capabilities: ['desktop-commander-mcp', 'files', 'terminal'],
    protocolVersion: 1
  };
}

function fakeConnection(toolNames: string[], callTool: (params: any) => Promise<any>) {
  return {
    tools: toolNames.map(name => ({ name })),
    callTool
  } as any;
}

function remoteTextInfo(path: string, lineCount = 3, size = 64) {
  return {
    content: [{ type: 'text', text: 'human metadata prose is irrelevant' }],
    structuredContent: {
      kind: 'file_info', path, exists: true, isFile: true, isDirectory: false,
      size, fileType: 'text', metadata: { lineCount }
    }
  };
}

function lease(execution: ExecutionSnapshot, connection: any) {
  vi.spyOn(nodeRegistry, 'withExecutionConnection').mockImplementation(async (expected, fn) => {
    expect(expected).toMatchObject({
      nodeId: execution.nodeId,
      nodeConfigVersion: execution.nodeConfigVersion,
      machineId: execution.machineId,
      agentInstanceId: execution.agentInstanceId
    });
    return fn(connection, runtime(execution));
  });
}

describe('remote execution backend', () => {
  it('routes remote read through the frozen connection and never invokes the local filesystem handler', async () => {
    const { execution } = await remoteExecution();
    const local = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'LOCAL' }] }));
    const callTool = vi.fn(async (params: any) => {
      if (params.name === 'get_file_info') return remoteTextInfo(params.arguments.path, 1);
      expect(params).toMatchObject({
        name: 'read_file',
        arguments: { path: 'C:\\work\\crm\\README.md', offset: 0, includeStatusMessage: false }
      });
      return { content: [{ type: 'text', text: `remote:${params.arguments.path}` }] };
    });
    lease(execution, fakeConnection(['read_file', 'get_file_info'], callTool));

    const result = await runInCallContext(context(execution), () =>
      routeExecutionTool('core', 'read', { paths: ['C:\\work\\crm\\README.md'] }, local)
    );

    expect(local).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(result.isError).not.toBe(true);
    expect(result.content.map(item => item.type === 'text' ? item.text : '').join('\n')).toContain('remote:C:\\work\\crm\\README.md');
  });

  it('resolves relative remote reads against the frozen workspace and expands globs only on the frozen node', async () => {
    const { execution } = await remoteExecution();
    const calls: any[] = [];
    const callTool = vi.fn(async (params: any) => {
      calls.push(params);
      if (params.name === 'start_search') {
        expect(params.arguments).toMatchObject({
          path: 'C:\\work\\crm\\src',
          pattern: '*.ts',
          searchType: 'files'
        });
        return {
          content: [{ type: 'text', text: 'human search prose is irrelevant' }],
          structuredContent: {
            kind: 'search', sessionId: 'glob-raw-1', state: 'completed', running: false, completed: true,
            error: false, errorMessage: null, incomplete: false,
            results: [
              { file: 'C:\\work\\crm\\src\\a.ts', type: 'file' },
              { file: 'C:\\work\\crm\\src\\nested\\ignored.ts', type: 'file' },
              { file: 'C:\\work\\crm\\src\\b.ts', type: 'file' }
            ],
            offset: 0, returnedCount: 3, totalResults: 3, totalMatches: 3, hasMoreResults: false,
            stopAccepted: null, stopResult: null
          }
        };
      }
      if (params.name === 'read_file') {
        expect(params.arguments).toMatchObject({ offset: 1, length: 2, includeStatusMessage: false });
        return { content: [{ type: 'text', text: `remote:${params.arguments.path}:lines2-3` }] };
      }
      if (params.name === 'get_file_info') return remoteTextInfo(params.arguments.path, 3);
      throw new Error(`unexpected ${params.name}`);
    });
    lease(execution, fakeConnection(['read_file', 'get_file_info', 'start_search', 'get_more_search_results', 'stop_search'], callTool));
    const local = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'LOCAL' }] }));

    const result = await runInCallContext(context(execution), () =>
      routeExecutionTool('core', 'read', { paths: ['src/*.ts:2-3'] }, local)
    );

    expect(local).not.toHaveBeenCalled();
    expect(result.isError).not.toBe(true);
    expect(calls.filter(call => call.name === 'read_file').map(call => call.arguments.path)).toEqual([
      'C:\\work\\crm\\src\\a.ts',
      'C:\\work\\crm\\src\\b.ts'
    ]);
    const text = result.content.map(item => item.type === 'text' ? item.text : '').join('\n');
    expect(text).toContain('remote:C:\\work\\crm\\src\\a.ts:lines2-3');
    expect(text).toContain('remote:C:\\work\\crm\\src\\b.ts:lines2-3');
    expect(text).not.toContain('ignored.ts');
    expect(text).not.toContain('glob-raw-1');
  });

  it('resolves a plain relative remote read from the frozen workspace rather than the remote process cwd', async () => {
    const { execution } = await remoteExecution();
    const callTool = vi.fn(async (params: any) => {
      if (params.name === 'get_file_info') return remoteTextInfo(params.arguments.path, 1);
      expect(params).toMatchObject({
        name: 'read_file',
        arguments: { path: 'C:\\work\\crm\\README.md', offset: 0, includeStatusMessage: false }
      });
      return { content: [{ type: 'text', text: 'workspace-read' }] };
    });
    lease(execution, fakeConnection(['read_file', 'get_file_info'], callTool));
    const local = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'LOCAL' }] }));

    const result = await runInCallContext(context(execution), () =>
      routeExecutionTool('core', 'read', { paths: ['README.md'] }, local)
    );
    expect(result.isError).not.toBe(true);
    expect(local).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it('renders remote directory reads from structured listing data rather than DesktopCommander prose', async () => {
    const { execution } = await remoteExecution();
    const callTool = vi.fn(async (params: any) => {
      if (params.name === 'get_file_info') {
        return {
          content: [{ type: 'text', text: 'directory metadata prose' }],
          structuredContent: {
            kind: 'file_info', path: params.arguments.path, exists: true,
            isFile: false, isDirectory: true, size: 0, fileType: 'directory'
          }
        };
      }
      if (params.name === 'list_directory') {
        expect(params.arguments).toEqual({ path: 'C:\\work\\crm\\src', depth: 1 });
        return {
          content: [{ type: 'text', text: '[THIS HUMAN LISTING MUST NOT BE PARSED]' }],
          structuredContent: {
            kind: 'directory_listing', path: params.arguments.path, depth: 1,
            entries: [
              { name: 'index.ts', relativePath: 'index.ts', path: 'C:\\work\\crm\\src\\index.ts', type: 'file', size: 123 },
              { name: 'nested', relativePath: 'nested', path: 'C:\\work\\crm\\src\\nested', type: 'directory', size: null }
            ]
          }
        };
      }
      throw new Error(`unexpected ${params.name}`);
    });
    lease(execution, fakeConnection(['read_file', 'get_file_info', 'list_directory'], callTool));
    const local = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'LOCAL' }] }));

    const result = await runInCallContext(context(execution), () =>
      routeExecutionTool('core', 'read', { paths: ['src'] }, local)
    );
    const text = result.content.map(item => item.type === 'text' ? item.text : '').join('\n');
    expect(result.isError).not.toBe(true);
    expect(text).toContain('f index.ts  123 bytes');
    expect(text).toContain('d nested');
    expect(text).not.toContain('HUMAN LISTING');
    expect(local).not.toHaveBeenCalled();
  });

  it('keeps a remote PID internal, returns one opaque handle, and completes it through write_stdin', async () => {
    const { execution } = await remoteExecution();
    const calls: string[] = [];
    const connection = fakeConnection(
      ['start_process', 'read_process_output', 'interact_with_process', 'force_terminate'],
      async (params: any) => {
        calls.push(params.name);
        if (params.name === 'start_process') {
          expect(params.arguments.cwd).toBe('C:\\work\\crm\\scripts');
          return {
            content: [{ type: 'text', text: 'human text containing PID 4242' }],
            structuredContent: {
              kind: 'process', pid: 4242, state: 'running', running: true, completed: false,
              blocked: true, waitingForInput: false, exitCode: null, output: 'started',
              readFrom: null, readCount: 0, totalLines: 1, remaining: 0,
              evicted: false, evictedLines: 0, evictedChars: 0, truncated: false,
              shell: 'PowerShell', cwd: params.arguments.cwd, terminationAccepted: null, terminationResult: null
            }
          };
        }
        return {
          content: [{ type: 'text', text: 'done' }],
          structuredContent: {
            kind: 'process', pid: 4242, state: 'completed', running: false, completed: true,
            blocked: false, waitingForInput: false, exitCode: 0, output: 'done',
            readFrom: 1, readCount: 1, totalLines: 2, remaining: 0,
            evicted: false, evictedLines: 0, evictedChars: 0, truncated: false,
            shell: 'PowerShell', cwd: 'C:\\work\\crm', terminationAccepted: null, terminationResult: null
          }
        };
      }
    );
    lease(execution, connection);
    const local = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'LOCAL' }] }));

    const started = await runInCallContext(context(execution), () =>
      routeExecutionTool('core', 'exec_command', { cmd: 'ping -t 127.0.0.1', workdir: 'scripts' }, local)
    );
    expect(local).not.toHaveBeenCalled();
    const handle = started.structuredContent?.session_id;
    expect(handle).toEqual(expect.stringMatching(/^nh_[A-Za-z0-9_-]+$/));
    expect(JSON.stringify(started.structuredContent)).not.toContain('4242');

    const completed = await runInCallContext(context(execution), () =>
      routeExecutionTool('core', 'write_stdin', { session_id: handle }, local)
    );
    expect(calls).toEqual(['start_process', 'read_process_output']);
    expect(completed.structuredContent).toMatchObject({ exit_code: 0, output: 'done' });
    expect(() => executionHandles.remote(String(handle), {
      sessionId: execution.sessionId,
      nodeId: execution.nodeId,
      bindingVersion: execution.bindingVersion,
      agentInstanceId: execution.agentInstanceId
    })).toThrow('HANDLE_EXPIRED');
  });

  it('maps remote Ctrl-C to force_terminate, never sends it as process input, and expires the opaque handle', async () => {
    const { execution } = await remoteExecution();
    const calls: string[] = [];
    const callTool = vi.fn(async (params: any) => {
      calls.push(params.name);
      if (params.name === 'start_process') {
        return {
          content: [{ type: 'text', text: 'started' }],
          structuredContent: {
            kind: 'process', pid: 5150, state: 'running', running: true, completed: false,
            blocked: true, waitingForInput: false, exitCode: null, output: '',
            readFrom: null, readCount: 0, totalLines: 0, remaining: 0,
            evicted: false, evictedLines: 0, evictedChars: 0, truncated: false,
            shell: 'PowerShell', cwd: 'C:\\work\\crm', terminationAccepted: null, terminationResult: null
          }
        };
      }
      if (params.name === 'force_terminate') {
        expect(params.arguments).toEqual({ pid: 5150 });
        return {
          content: [{ type: 'text', text: 'terminated' }],
          structuredContent: {
            kind: 'process', pid: 5150, state: 'terminated', running: false, completed: true,
            blocked: false, waitingForInput: false, exitCode: null, output: 'terminated',
            readFrom: null, readCount: 0, totalLines: 0, remaining: 0,
            evicted: false, evictedLines: 0, evictedChars: 0, truncated: false,
            shell: 'PowerShell', cwd: 'C:\\work\\crm', terminationAccepted: true, terminationResult: 'terminated'
          }
        };
      }
      throw new Error(`unexpected ${params.name}`);
    });
    lease(execution, fakeConnection(
      ['start_process', 'read_process_output', 'interact_with_process', 'force_terminate'],
      callTool
    ));
    const local = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'LOCAL' }] }));
    const started = await runInCallContext(context(execution), () =>
      routeExecutionTool('core', 'exec_command', { cmd: 'long-running-task' }, local)
    );
    const handle = String(started.structuredContent?.session_id);

    const terminated = await runInCallContext(context(execution), () =>
      routeExecutionTool('core', 'write_stdin', { session_id: handle, chars: '\u0003' }, local)
    );

    expect(calls).toEqual(['start_process', 'force_terminate']);
    expect(calls).not.toContain('interact_with_process');
    expect(terminated.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Process terminated') });
    expect(terminated.structuredContent).toMatchObject({ output: 'terminated' });
    expect(() => executionHandles.remote(handle, {
      sessionId: execution.sessionId,
      nodeId: execution.nodeId,
      bindingVersion: execution.bindingVersion,
      agentInstanceId: execution.agentInstanceId
    })).toThrow('HANDLE_EXPIRED');
    expect(local).not.toHaveBeenCalled();
  });

  it('expires the opaque process handle when the executor agent instance changes', async () => {
    const first = await remoteExecution('office', 'agent-one');
    const startConnection = fakeConnection(['start_process'], async () => ({
      content: [{ type: 'text', text: 'started' }],
      structuredContent: {
        kind: 'process', pid: 99, state: 'running', running: true, completed: false,
        blocked: true, waitingForInput: false, exitCode: null, output: '',
        readFrom: null, readCount: 0, totalLines: 0, remaining: 0,
        evicted: false, evictedLines: 0, evictedChars: 0, truncated: false,
        shell: 'PowerShell', cwd: 'C:\\work\\crm', terminationAccepted: null, terminationResult: null
      }
    }));
    lease(first.execution, startConnection);
    const local = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'LOCAL' }] }));
    const started = await runInCallContext(context(first.execution), () =>
      routeExecutionTool('core', 'exec_command', { cmd: 'long-task' }, local)
    );
    const handle = String(started.structuredContent?.session_id);

    vi.restoreAllMocks();
    const newExecution = { ...first.execution, inputId: randomUUID(), agentInstanceId: 'agent-two' };
    const newConnection = fakeConnection(['read_process_output'], vi.fn(async () => { throw new Error('must not call remote'); }));
    lease(newExecution, newConnection);
    const result = await runInCallContext(context(newExecution), () =>
      routeExecutionTool('core', 'write_stdin', { session_id: handle }, local)
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('HANDLE_EXPIRED') });
    expect(newConnection.callTool).not.toHaveBeenCalled();
  });

  it('reports post-send transport uncertainty once and never replays the remote mutation', async () => {
    const { execution } = await remoteExecution();
    const callTool = vi.fn(async () => {
      throw new RemoteNodeConnectionError(
        'EXECUTION_STATUS_UNKNOWN',
        'request was handed to transport and the node disconnected; it was not replayed',
        true
      );
    });
    lease(execution, fakeConnection(['start_process'], callTool));
    const local = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'LOCAL' }] }));

    const result = await runInCallContext(context(execution), () =>
      routeExecutionTool('core', 'exec_command', { cmd: 'mutate-something' }, local)
    );
    expect(callTool).toHaveBeenCalledOnce();
    expect(local).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('EXECUTION_STATUS_UNKNOWN') });
  });

  it('preflights remote apply_patch against remote file content and writes the reconstructed text without invoking local patch code', async () => {
    const { execution } = await remoteExecution();
    const files = new Map<string, string>([['C:\\work\\crm\\a.txt', 'one\ntwo\nthree\n']]);
    const callTool = vi.fn(async (params: any) => {
      const filePath = params.arguments.path as string;
      if (params.name === 'get_file_info') {
        if (!files.has(filePath)) {
          return {
            content: [{ type: 'text', text: 'ENOENT' }], isError: true,
            structuredContent: { kind: 'file_info', path: filePath, exists: false, errorCode: 'ENOENT' }
          };
        }
        const content = files.get(filePath)!;
        return {
          content: [{ type: 'text', text: 'info' }],
          structuredContent: { kind: 'file_info', path: filePath, exists: true, isFile: true, size: Buffer.byteLength(content) }
        };
      }
      if (params.name === 'read_file') {
        return { content: [{ type: 'text', text: files.get(filePath)! }] };
      }
      if (params.name === 'create_directory') return { content: [{ type: 'text', text: 'ok' }] };
      if (params.name === 'write_file') {
        files.set(filePath, params.arguments.content);
        return { content: [{ type: 'text', text: 'written' }] };
      }
      throw new Error(`unexpected ${params.name}`);
    });
    lease(execution, fakeConnection(['get_file_info', 'read_file', 'create_directory', 'write_file'], callTool));
    const local = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'LOCAL PATCH' }] }));
    const patch = [
      '*** Begin Patch',
      '*** Update File: a.txt',
      '@@',
      ' one',
      '-two',
      '+TWO',
      ' three',
      '*** End Patch'
    ].join('\n');

    const result = await runInCallContext(context(execution), () =>
      routeExecutionTool('core', 'apply_patch', { patch }, local)
    );
    expect(local).not.toHaveBeenCalled();
    expect(result.isError).not.toBe(true);
    expect(files.get('C:\\work\\crm\\a.txt')).toBe('one\nTWO\nthree\n');
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('M a.txt') });
  });

  it('refuses a remote patch when the baseline changes after preflight and before mutation', async () => {
    const { execution } = await remoteExecution();
    const filePath = 'C:\\work\\crm\\a.txt';
    let content = 'old\n';
    let reads = 0;
    const write = vi.fn();
    const callTool = vi.fn(async (params: any) => {
      if (params.name === 'get_file_info') {
        return {
          content: [{ type: 'text', text: 'info' }],
          structuredContent: { kind: 'file_info', path: filePath, exists: true, isFile: true, size: Buffer.byteLength(content) }
        };
      }
      if (params.name === 'read_file') {
        reads += 1;
        const returned = content;
        if (reads === 1) content = 'concurrent\n';
        return { content: [{ type: 'text', text: returned }] };
      }
      if (params.name === 'write_file') {
        write();
        return { content: [{ type: 'text', text: 'written' }] };
      }
      if (params.name === 'create_directory') return { content: [{ type: 'text', text: 'ok' }] };
      throw new Error(`unexpected ${params.name}`);
    });
    lease(execution, fakeConnection(['get_file_info', 'read_file', 'create_directory', 'write_file'], callTool));
    const local = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'LOCAL PATCH' }] }));
    const patch = ['*** Begin Patch', '*** Update File: a.txt', '@@', '-old', '+new', '*** End Patch'].join('\n');
    const result = await runInCallContext(context(execution), () =>
      routeExecutionTool('core', 'apply_patch', { patch }, local)
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('TARGET_CHANGED') });
    expect(write).not.toHaveBeenCalled();
    expect(local).not.toHaveBeenCalled();
  });

  it('adapts the structured remote search job without parsing or exposing its raw session id', async () => {
    const { execution } = await remoteExecution();
    const callTool = vi.fn(async (params: any) => {
      if (params.name === 'start_search') {
        expect(params.arguments.path).toBe('C:\\work\\crm\\src');
        return {
          content: [{ type: 'text', text: 'human prose intentionally irrelevant search-raw-777' }],
          structuredContent: {
            kind: 'search', sessionId: 'search-raw-777', state: 'running', running: true, completed: false,
            error: false, errorMessage: null, incomplete: false,
            results: [{ file: 'C:\\work\\crm\\one.ts', type: 'file' }],
            offset: 0, returnedCount: 1, totalResults: 1, totalMatches: 1, hasMoreResults: true,
            stopAccepted: null, stopResult: null
          }
        };
      }
      if (params.name === 'get_more_search_results') {
        expect(params.arguments.sessionId).toBe('search-raw-777');
        return {
          content: [{ type: 'text', text: 'done' }],
          structuredContent: {
            kind: 'search', sessionId: 'search-raw-777', state: 'completed', running: false, completed: true,
            error: false, errorMessage: null, incomplete: false,
            results: [{ file: 'C:\\work\\crm\\two.ts', type: 'file' }],
            offset: 1, returnedCount: 1, totalResults: 2, totalMatches: 2, hasMoreResults: false,
            stopAccepted: null, stopResult: null
          }
        };
      }
      throw new Error(`unexpected ${params.name}`);
    });
    lease(execution, fakeConnection(['start_search', 'get_more_search_results', 'stop_search'], callTool));
    const local = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'LOCAL FIND' }] }));
    const result = await runInCallContext(context(execution), () =>
      routeExecutionTool('core', 'find', { query: '.ts', path: 'src', mode: 'name' }, local)
    );
    expect(result.isError).not.toBe(true);
    const text = result.content.map(item => item.type === 'text' ? item.text : '').join('\n');
    expect(text).toContain('one.ts');
    expect(text).toContain('two.ts');
    expect(text).not.toContain('search-raw-777');
    expect(executionHandles.size).toBe(0);
    expect(local).not.toHaveBeenCalled();
  });

  it('resolves a relative remote view_image path against the frozen workspace', async () => {
    const { execution } = await remoteExecution();
    const callTool = vi.fn(async (params: any) => {
      expect(params).toEqual({
        name: 'read_file',
        arguments: { path: 'C:\\work\\crm\\artifacts\\shot.png' }
      });
      return { content: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }] };
    });
    lease(execution, fakeConnection(['read_file'], callTool));
    const local = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'LOCAL IMAGE' }] }));
    const result = await runInCallContext(context(execution), () =>
      routeExecutionTool('core', 'view_image', { path: 'artifacts/shot.png' }, local)
    );
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }]);
    expect(local).not.toHaveBeenCalled();
  });

  it('routes stable Windows Desktop methods through the frozen remote helper without touching the control-host desktop', async () => {
    const { execution } = await remoteExecution();
    const callTool = vi.fn(async (params: any) => {
      expect(params).toMatchObject({
        name: 'cos_windows_desktop',
        arguments: {
          context_key: `${execution.sessionId}:${execution.bindingVersion}`,
          method: 'get_window_state',
          arguments: { window: { app: 'fixture.exe', id: 71 }, include_screenshot: true }
        }
      });
      return {
        content: [
          { type: 'text', text: '{"window":{"app":"fixture.exe","id":71}}' },
          { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }
        ],
        structuredContent: {
          kind: 'windows_desktop', method: 'get_window_state',
          value: { window: { app: 'fixture.exe', id: 71 }, screenshots: [{ id: 'frame-1' }] }
        }
      };
    });
    lease(execution, fakeConnection(['cos_windows_desktop'], callTool));
    const local = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'LOCAL DESKTOP' }] }));
    const result = await runInCallContext(context(execution), () =>
      routeExecutionTool('desktop', 'get_window_state', {
        window: { app: 'fixture.exe', id: 71 }, include_screenshot: true
      }, local)
    );
    expect(local).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledOnce();
    expect(result.isError).not.toBe(true);
    expect(result.content.some(item => item.type === 'image')).toBe(true);
    expect(result.structuredContent).toMatchObject({ kind: 'windows_desktop', method: 'get_window_state' });
  });
});
