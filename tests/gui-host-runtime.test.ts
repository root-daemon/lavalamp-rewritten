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
  images: PromptImage[] | undefined;
  isProcessing = false;
  onPermissionRequest?: GuiProcess['onPermissionRequest'];
  onQuestionRequest?: GuiProcess['onQuestionRequest'];
  onBashStream?: GuiProcess['onBashStream'];
  permissionResponses: Array<[string, PermissionDecision, boolean | undefined]> = [];
  questionResponses: Array<[string, Record<string, unknown>]> = [];
  started = false;
  stopped = false;

  async start(): Promise<void> {
    this.started = true;
  }

  prompt(
    _message: string,
    callbacks: RuntimeCallbacks,
    _sessionId?: string,
    images?: PromptImage[],
  ): string {
    this.callbacks = callbacks;
    this.images = images;
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
