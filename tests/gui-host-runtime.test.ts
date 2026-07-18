import { describe, expect, test } from 'bun:test';
import { GuiEventStore } from '../src/gui-host/event-store';
import {
  GuiRuntime,
  type GuiProcess,
  type GuiSubAgentManager,
} from '../src/gui-host/runtime';
import type {
  PermissionDecision,
  PromptImage,
} from '../src/tui/ipc';
import type { RuntimeCallbacks } from '../src/runtime/types';
import type { SubAgent } from '../src/tui/state';

class FakeProcess implements GuiProcess {
  callbacks?: RuntimeCallbacks;
  images: PromptImage[] | undefined;
  isProcessing = false;
  onPermissionRequest?: GuiProcess['onPermissionRequest'];
  onQuestionRequest?: GuiProcess['onQuestionRequest'];
  onBashStream?: GuiProcess['onBashStream'];
  prompts: string[] = [];
  permissionResponses: Array<[string, PermissionDecision, boolean | undefined]> = [];
  questionResponses: Array<[string, Record<string, unknown>]> = [];
  started = false;
  stopped = false;

  async start(): Promise<void> {
    this.started = true;
  }

  prompt(
    message: string,
    callbacks: RuntimeCallbacks,
    _sessionId?: string,
    images?: PromptImage[],
  ): string {
    this.prompts.push(message);
    this.callbacks = callbacks;
    this.images = images;
    callbacks.onStarted?.();
    return `request-${this.prompts.length}`;
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

  async shutdown(): Promise<void> {
    this.stopped = true;
  }
}

class FakeSubAgentManager implements GuiSubAgentManager {
  deployed: string[][] = [];
  killed = false;
  onUpdate?: (subs: SubAgent[]) => void;
  onAllComplete?: (summary: string) => void;
  private subs: SubAgent[] = [];

  async deploy(queries: string[]): Promise<void> {
    this.deployed.push(queries);
    this.subs = queries.map((query, index) => ({
      id: `sub-${index + 1}`,
      query,
      startTime: 1000,
      status: 'running',
    }));
    this.onUpdate?.(this.subs);
  }

  killAll(): void {
    this.killed = true;
    this.subs = this.subs.map((sub) => ({ ...sub, status: 'killed' }));
    this.onUpdate?.(this.subs);
  }

  list(): SubAgent[] {
    return this.subs;
  }
}

describe('GUI runtime adapter', () => {
  test('normalizes prompt streaming, tools, terminal output, and result', async () => {
    const originalShowLogs = process.env.LAVALAMP_GUI_SHOW_LOGS;
    process.env.LAVALAMP_GUI_SHOW_LOGS = '1';
    const guiProcess = new FakeProcess();
    const store = new GuiEventStore();
    const runtime = new GuiRuntime({ process: guiProcess, store });
    try {
      await runtime.start({ model: 'model-a', workspace: '/repo' });

      runtime.submitPrompt('Fix tests', 'session-1');
      guiProcess.callbacks?.onEvent?.({ type: 'text_delta', delta: 'Done' });
      guiProcess.callbacks?.onEvent?.({
        args: { cmd: 'bun test' },
        toolCallId: 'tool-1',
        toolName: 'bash',
        type: 'tool_start',
      });
      guiProcess.onBashStream?.('3 pass\n', 'stdout');
      guiProcess.callbacks?.onEvent?.({
        durationMs: 25,
        isError: false,
        result: 'ok',
        toolCallId: 'tool-1',
        toolName: 'bash',
        type: 'tool',
      });
      guiProcess.callbacks?.onResult?.({
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
    } finally {
      if (originalShowLogs === undefined) {
        delete process.env.LAVALAMP_GUI_SHOW_LOGS;
      } else {
        process.env.LAVALAMP_GUI_SHOW_LOGS = originalShowLogs;
      }
    }
  });

  test('suppresses terminal stream in GUI snapshots by default', async () => {
    const originalShowLogs = process.env.LAVALAMP_GUI_SHOW_LOGS;
    delete process.env.LAVALAMP_GUI_SHOW_LOGS;
    const guiProcess = new FakeProcess();
    const store = new GuiEventStore();
    const runtime = new GuiRuntime({ process: guiProcess, store });
    try {
      await runtime.start({ workspace: '/repo' });
      guiProcess.onBashStream?.('hidden\n', 'stdout');
      expect(store.snapshot().terminalOutput).toBe('');
    } finally {
      if (originalShowLogs === undefined) {
        delete process.env.LAVALAMP_GUI_SHOW_LOGS;
      } else {
        process.env.LAVALAMP_GUI_SHOW_LOGS = originalShowLogs;
      }
    }
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

  test('forwards only referenced native image attachments', async () => {
    const process = new FakeProcess();
    const store = new GuiEventStore();
    const runtime = new GuiRuntime({ process, store });
    await runtime.start({ workspace: '/repo' });

    runtime.attachImage('/repo/.lavalamp/attachments/one.png');
    const secondTag = runtime.attachImage('/repo/.lavalamp/attachments/two.png');
    runtime.submitPrompt(`Inspect ${secondTag}`, 'session-1');

    expect(process.images).toEqual([
      {
        data: '',
        mimeType: 'image/png',
        path: '/repo/.lavalamp/attachments/two.png',
        type: 'image',
      },
    ]);
  });

  test('queues prompts while a turn is running and drains them in order', async () => {
    const process = new FakeProcess();
    const store = new GuiEventStore();
    const runtime = new GuiRuntime({ process, store });
    await runtime.start({ workspace: '/repo' });

    expect(runtime.submitPrompt('First turn', 'session-1')).toBe('request-1');
    expect(runtime.submitPrompt('Second turn', 'session-1')).toBe('queued-1');
    expect(store.snapshot()).toMatchObject({
      processing: true,
      queueSize: 1,
    });
    expect(process.prompts).toEqual(['First turn']);

    process.callbacks?.onResult?.({
      model: { id: 'model-a', provider: 'cloudflare' },
      text: 'Done',
      usage: {
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, total: 0 },
        input: 0,
        output: 0,
        totalTokens: 0,
      },
    });

    expect(process.prompts).toEqual(['First turn', 'Second turn']);
    expect(store.snapshot()).toMatchObject({
      processing: true,
      queueSize: 0,
    });
  });

  test('deploys TUI parallel subagents and queues their follow-up summary', async () => {
    const process = new FakeProcess();
    const subagents = new FakeSubAgentManager();
    const store = new GuiEventStore();
    const runtime = new GuiRuntime({
      backend: 'flue',
      process,
      serverPath: '/server.mjs',
      store,
      subAgentManager: subagents,
      workspace: '/repo',
    });
    await runtime.start({ workspace: '/repo' });

    runtime.submitPrompt('Investigate parity', 'session-1');
    process.callbacks?.onEvent?.({
      result: JSON.stringify({
        queries: ['auth path', 'model picker', 'workspace diff', 'extra ignored'],
        type: 'parallel_deploy',
      }),
      toolCallId: 'tool-subagents',
      toolName: 'deploy_parallel_subs',
      type: 'tool',
    });

    expect(subagents.deployed).toEqual([
      ['auth path', 'model picker', 'workspace diff'],
    ]);
    expect(store.snapshot().subagents).toMatchObject([
      { id: 'sub-1', query: 'auth path', status: 'running' },
      { id: 'sub-2', query: 'model picker', status: 'running' },
      { id: 'sub-3', query: 'workspace diff', status: 'running' },
    ]);

    subagents.onAllComplete?.('## Research Results\n\nDone');
    expect(store.snapshot().queueSize).toBe(1);

    process.callbacks?.onResult?.({
      backend: 'flue',
      model: { id: 'model-a', provider: 'cloudflare' },
      text: 'Original done',
      usage: {
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, total: 0 },
        input: 0,
        output: 0,
        totalTokens: 0,
      },
    });

    expect(process.prompts[1]).toContain('The parallel research has completed.');
    expect(process.prompts[1]).toContain('## Research Results');
  });

  test('switches runtime workspace with a fresh process and clean GUI session', async () => {
    const firstProcess = new FakeProcess();
    const secondProcess = new FakeProcess();
    const store = new GuiEventStore();
    const createdWorkspaces: string[] = [];
    const runtime = new GuiRuntime({
      backend: 'flue',
      mode: 'build',
      process: firstProcess,
      processFactory: (options) => {
        createdWorkspaces.push(options.cwd);
        return secondProcess;
      },
      serverPath: '/server.mjs',
      store,
      workspace: '/repo',
    });
    await runtime.start({ workspace: '/repo' });
    runtime.store.append({ content: 'old task', type: 'user.message' });

    await runtime.switchWorkspace('/repo-worktree');

    expect(firstProcess.stopped).toBe(true);
    expect(secondProcess.started).toBe(true);
    expect(createdWorkspaces).toEqual(['/repo-worktree']);
    expect(runtime.workspaceRoot()).toBe('/repo-worktree');
    expect(store.snapshot()).toMatchObject({
      messages: [],
      processing: false,
      workspace: '/repo-worktree',
    });
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
});
