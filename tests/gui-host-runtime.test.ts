import { describe, expect, test } from 'bun:test';
import { GuiEventStore } from '../src/gui-host/event-store';
import { GuiRuntime, type GuiProcess } from '../src/gui-host/runtime';
import type {
  PermissionDecision,
  PromptImage,
} from '../src/tui/ipc';
import type { RuntimeCallbacks } from '../src/runtime/types';

class FakeProcess implements GuiProcess {
  callbacks?: RuntimeCallbacks;
  onPermissionRequest?: GuiProcess['onPermissionRequest'];
  onQuestionRequest?: GuiProcess['onQuestionRequest'];
  onBashStream?: GuiProcess['onBashStream'];
  onSubagentsChanged?: GuiProcess['onSubagentsChanged'];
  onSubagentsComplete?: GuiProcess['onSubagentsComplete'];
  permissionResponses: Array<[string, PermissionDecision, boolean | undefined]> = [];
  questionResponses: Array<[string, Record<string, unknown>]> = [];
  started = false;
  stopped = false;
  stoppedSubagents: string[] = [];
  deployedQueries: string[][] = [];

  async start(): Promise<void> {
    this.started = true;
  }

  prompt(
    _message: string,
    callbacks: RuntimeCallbacks,
    _sessionId?: string,
    _images?: PromptImage[],
  ): string {
    this.callbacks = callbacks;
    callbacks.onStarted?.();
    return 'request-1';
  }

  sendPermissionResponse(
    requestId: string,
    decision: PermissionDecision,
    alwaysAllow?: boolean,
  ): void {
    this.permissionResponses.push([requestId, decision, alwaysAllow]);
  }

  sendQuestionResponse(
    requestId: string,
    answers: Record<string, unknown>,
  ): void {
    this.questionResponses.push([requestId, answers]);
  }

  cancel(): void {}

  listSubagents() { return []; }
  async inspectSubagent(id: string) {
    return {
      messages: [{ content: 'Done', role: 'assistant' as const }],
      subagent: {
        id,
        name: 'Atlas',
        task: 'Inspect auth',
        status: 'completed' as const,
        startedAt: 1,
      },
    };
  }
  async stopSubagent(id: string) { this.stoppedSubagents.push(id); }
  async deploySubagents(queries: string[]) { this.deployedQueries.push(queries); }
  async clearSubagents() {}

  async shutdown(): Promise<void> {
    this.stopped = true;
  }
}

describe('GUI runtime adapter', () => {
  test('normalizes prompt streaming, tools, terminal output, and result', async () => {
    const process = new FakeProcess();
    const store = new GuiEventStore();
    const runtime = new GuiRuntime({ process, store });
    await runtime.start({ model: 'model-a', workspace: '/repo' });

    runtime.submitPrompt('Fix tests', 'session-1');
    process.callbacks?.onEvent?.({ type: 'text_delta', delta: 'Done' });
    process.callbacks?.onEvent?.({
      args: { cmd: 'bun test' },
      toolCallId: 'tool-1',
      toolName: 'bash',
      type: 'tool_start',
    });
    process.onBashStream?.('3 pass\n', 'stdout');
    process.callbacks?.onEvent?.({
      durationMs: 25,
      isError: false,
      result: 'ok',
      toolCallId: 'tool-1',
      toolName: 'bash',
      type: 'tool',
    });
    process.callbacks?.onResult?.({
      backend: 'flue',
      model: { id: 'model-a', provider: 'cloudflare' },
      text: 'Done',
      usage: {
        cacheRead: 2,
        cacheWrite: 0,
        cost: { input: 0.01, output: 0.02, total: 0.03 },
        input: 8,
        output: 4,
        totalTokens: 14,
      },
    });

    expect(store.after(0).map((event) => event.type)).toEqual([
      'host.ready',
      'user.message',
      'turn.started',
      'text.delta',
      'tool.started',
      'terminal.output',
      'tool.completed',
      'turn.completed',
    ]);
    expect(store.snapshot()).toMatchObject({
      assistantText: 'Done',
      processing: false,
      terminalOutput: '3 pass\n',
      usage: { cost: 0.03, totalTokens: 14 },
    });
  });

  test('routes permission and question responses through active process', async () => {
    const process = new FakeProcess();
    const store = new GuiEventStore();
    const runtime = new GuiRuntime({ process, store });
    await runtime.start({ workspace: '/repo' });

    process.onPermissionRequest?.({
      args: { path: 'src/a.ts' },
      requestId: 'perm-1',
      toolName: 'edit',
      type: 'permission_request',
    });
    runtime.respondPermission('perm-1', 'always_allow');
    process.onQuestionRequest?.({
      questions: [{ id: 'choice', type: 'text' }],
      requestId: 'question-1',
      type: 'question_request',
    });
    runtime.respondQuestion('question-1', { choice: 'native' });

    expect(process.permissionResponses).toEqual([
      ['perm-1', 'allow', true],
    ]);
    expect(process.questionResponses).toEqual([
      ['question-1', { choice: 'native' }],
    ]);
    expect(store.snapshot().pendingPermission).toBeUndefined();
    expect(store.snapshot().pendingQuestion).toBeUndefined();
  });

  test('records runtime errors and shuts process down', async () => {
    const process = new FakeProcess();
    const store = new GuiEventStore();
    const runtime = new GuiRuntime({ process, store });
    await runtime.start({ workspace: '/repo' });
    runtime.submitPrompt('Fail', 'session-1');
    process.callbacks?.onError?.(new Error('provider unavailable'));

    expect(store.snapshot()).toMatchObject({
      error: 'provider unavailable',
      processing: false,
    });
    await runtime.shutdown();
    expect(process.stopped).toBe(true);
  });

  test('normalizes subagent updates and exposes read-only control', async () => {
    const process = new FakeProcess();
    const store = new GuiEventStore();
    const runtime = new GuiRuntime({ process, store });
    await runtime.start({ workspace: '/repo' });

    process.onSubagentsChanged?.([{
      id: 'child-1',
      name: 'Atlas',
      task: 'Inspect auth',
      status: 'running',
      startedAt: 1,
    }]);
    expect(store.snapshot().subagents).toEqual([
      expect.objectContaining({ id: 'child-1', status: 'running' }),
    ]);
    expect(await runtime.inspectSubagent('child-1')).toMatchObject({
      subagent: { id: 'child-1' },
    });
    await runtime.stopSubagent('child-1');
    expect(process.stoppedSubagents).toEqual(['child-1']);
  });

  test('deploys Flue research markers and feeds the summary back after the turn', async () => {
    const process = new FakeProcess();
    const runtime = new GuiRuntime({ process, store: new GuiEventStore() });
    await runtime.start({ workspace: '/repo' });
    runtime.submitPrompt('Compare approaches');

    process.callbacks?.onEvent?.({
      result: JSON.stringify({
        queries: ['Inspect auth', 'Inspect storage'],
        type: 'parallel_deploy',
      }),
      toolCallId: 'deploy-1',
      toolName: 'deploy_parallel_subs',
      type: 'tool',
    });
    expect(process.deployedQueries).toEqual([
      ['Inspect auth', 'Inspect storage'],
    ]);

    process.onSubagentsComplete?.('Both scans passed.');
    process.callbacks?.onResult?.({
      backend: 'flue',
      model: { id: 'model-a', provider: 'cloudflare' },
      text: '',
      usage: {
        cacheRead: 0,
        cacheWrite: 0,
        cost: null,
        input: 0,
        output: 0,
        totalTokens: 0,
      },
    });

    expect(process.callbacks).toBeDefined();
    expect(runtime.store.snapshot().messages.at(-1)?.content).toContain(
      'Both scans passed.',
    );
  });
});
