import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
  permissionResponses: Array<[string, PermissionDecision, boolean | undefined]> = [];
  questionResponses: Array<[string, Record<string, unknown>]> = [];
  started = false;
  stopped = false;
  cancelled = 0;
  cleared = 0;
  restarted = 0;
  prompts: string[] = [];
  promptImages: PromptImage[][] = [];

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
    this.promptImages.push(images ?? []);
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

  cancel(): void {
    this.cancelled += 1;
  }

  clearThread(): void {
    this.cleared += 1;
  }

  async restart(): Promise<void> {
    this.restarted += 1;
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
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
      questions: [
        {
          default: 'Native',
          id: 'choice',
          options: [{ label: 'Native', value: 'native' }, 'TUI'],
          question: 'Which interface?',
          type: 'select',
        },
      ],
      requestId: 'question-1',
      type: 'question_request',
    });
    expect(store.snapshot().pendingQuestion).toEqual({
      questions: [
        {
          defaultValue: 'Native',
          id: 'choice',
          options: ['Native', 'TUI'],
          question: 'Which interface?',
          type: 'select',
        },
      ],
      requestId: 'question-1',
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

  test('queues a follow-up prompt and starts it after the active turn', async () => {
    const process = new FakeProcess();
    const store = new GuiEventStore();
    const runtime = new GuiRuntime({ process, store });
    await runtime.start({ workspace: '/repo' });

    runtime.submitPrompt('First task');
    expect(runtime.queuePrompt('Then verify it')).toBe('queued-1');
    process.callbacks?.onResult?.({
      model: { id: 'model-a', provider: 'cloudflare' },
      text: 'Done',
      usage: { cacheRead: 0, cacheWrite: 0, cost: null, input: 1, output: 1, totalTokens: 2 },
    });
    await Promise.resolve();

    expect(process.prompts).toEqual(['First task', 'Then verify it']);
    expect(store.snapshot()).toMatchObject({ processing: true });
  });

  test('attaches a clipboard image to the next prompt only', async () => {
    const process = new FakeProcess();
    const store = new GuiEventStore();
    const runtime = new GuiRuntime({ process, store });
    const imagePath = join(mkdtempSync(join(tmpdir(), 'lavalamp-gui-image-')), 'image.png');
    writeFileSync(imagePath, Buffer.from([1, 2, 3]));
    await runtime.start({ workspace: '/repo' });

    runtime.attachImage(imagePath);
    runtime.submitPrompt('Inspect this image');

    expect(process.promptImages[0]).toMatchObject([
      { data: 'AQID', mimeType: 'image/png', path: imagePath, type: 'image' },
    ]);
  });

  test('starts a clean runtime-backed session', async () => {
    const process = new FakeProcess();
    const store = new GuiEventStore();
    const runtime = new GuiRuntime({ process, store });
    await runtime.start({ workspace: '/repo' });
    runtime.submitPrompt('Old task');

    await runtime.newSession();

    expect(process.cancelled).toBe(1);
    expect(process.cleared).toBe(1);
    expect(process.restarted).toBe(1);
    expect(store.snapshot()).toMatchObject({ messages: [], processing: false, tools: [] });
  });

  test('restarts an injected runtime when sudo mode changes', async () => {
    const process = new FakeProcess();
    const store = new GuiEventStore();
    const runtime = new GuiRuntime({ process, store });
    await runtime.start({ workspace: '/repo' });
    runtime.submitPrompt('Old task');
    process.callbacks?.onResult?.({
      model: { id: 'model-a', provider: 'cloudflare' },
      text: 'Done',
      usage: { cacheRead: 0, cacheWrite: 0, cost: null, input: 1, output: 1, totalTokens: 2 },
    });

    await runtime.setSudo(true);

    expect(process.restarted).toBe(1);
    expect(store.snapshot()).toMatchObject({ messages: [], processing: false });
  });
});
