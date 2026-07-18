import type {
  OnBashStream,
  OnPermissionRequest,
  OnQuestionRequest,
  PermissionDecision,
  PromptCallbacks,
  PromptImage,
} from '../tui/ipc';
import { FlueProcess } from '../tui/ipc';
import type { GuiPermissionDecision } from './contracts';
import { GuiEventStore } from './event-store';

export interface GuiProcess {
  onPermissionRequest?: OnPermissionRequest;
  onQuestionRequest?: OnQuestionRequest;
  onBashStream?: OnBashStream;
  start(): Promise<void>;
  prompt(
    message: string,
    callbacks?: PromptCallbacks,
    sessionId?: string,
    images?: PromptImage[],
  ): string;
  sendPermissionResponse(
    requestId: string,
    decision: PermissionDecision,
    alwaysAllow?: boolean,
  ): void;
  sendQuestionResponse(
    requestId: string,
    answers: Record<string, unknown>,
  ): void;
  cancel(): void;
  shutdown(): Promise<void>;
}

export interface GuiRuntimeOptions {
  process: GuiProcess;
  store: GuiEventStore;
}

export class GuiRuntime {
  private readonly process: GuiProcess;
  readonly store: GuiEventStore;

  constructor(options: GuiRuntimeOptions) {
    this.process = options.process;
    this.store = options.store;
  }

  static create(options: {
    serverPath: string;
    workspace: string;
    agentName?: string;
    sessionId?: string;
    store?: GuiEventStore;
  }): GuiRuntime {
    return new GuiRuntime({
      process: new FlueProcess(
        options.serverPath,
        options.workspace,
        options.agentName ?? 'build',
        options.sessionId,
      ),
      store: options.store ?? new GuiEventStore(),
    });
  }

  async start(options: { workspace: string; model?: string }): Promise<void> {
    this.process.onPermissionRequest = (request) => {
      this.store.append({
        args: request.args,
        requestId: request.requestId,
        toolName: request.toolName,
        type: 'permission.requested',
      });
    };
    this.process.onQuestionRequest = (request) => {
      this.store.append({
        questions: request.questions,
        requestId: request.requestId,
        type: 'question.requested',
      });
    };
    this.process.onBashStream = (chunk, stream) => {
      this.store.append({ chunk, stream, type: 'terminal.output' });
    };
    await this.process.start();
    this.store.append({
      model: options.model,
      type: 'host.ready',
      workspace: options.workspace,
    });
  }

  submitPrompt(prompt: string, sessionId?: string): string {
    if (this.store.snapshot().processing) {
      throw new Error('A turn is already running');
    }
    const trimmed = prompt.trim();
    if (trimmed.length === 0) {
      throw new Error('Prompt is required');
    }
    this.store.append({ content: trimmed, type: 'user.message' });
    return this.process.prompt(trimmed, {
      onError: (error) => {
        this.store.append({ message: error.message, type: 'turn.failed' });
      },
      onEvent: (event) => {
        switch (event.type) {
          case 'text_delta':
            this.store.append({
              delta: event.text ?? event.delta ?? '',
              type: 'text.delta',
            });
            break;
          case 'thinking_delta':
            this.store.append({
              delta: event.delta ?? event.content ?? '',
              type: 'thinking.delta',
            });
            break;
          case 'tool_start':
            this.store.append({
              args: event.args ?? {},
              toolCallId: event.toolCallId ?? `tool-${Date.now()}`,
              toolName: event.toolName ?? 'unknown',
              type: 'tool.started',
            });
            break;
          case 'tool':
            this.store.append({
              durationMs: event.durationMs,
              isError: Boolean(event.isError),
              result: event.result,
              toolCallId: event.toolCallId ?? 'unknown',
              type: 'tool.completed',
            });
            break;
          default:
            this.store.append({ event, type: 'runtime.event' });
            break;
        }
      },
      onResult: (result) => {
        this.store.append({
          model: result.model.id,
          provider: result.model.provider,
          type: 'turn.completed',
          usage: {
            cacheRead: result.usage.cacheRead,
            cacheWrite: result.usage.cacheWrite,
            cost: result.usage.cost.total,
            input: result.usage.input,
            output: result.usage.output,
            totalTokens: result.usage.totalTokens,
          },
        });
      },
      onStarted: () => {
        this.store.append({ type: 'turn.started' });
      },
    }, sessionId);
  }

  respondPermission(
    requestId: string,
    decision: GuiPermissionDecision,
  ): void {
    const pending = this.store.snapshot().pendingPermission;
    if (pending?.requestId !== requestId) {
      throw new Error('Permission request is no longer pending');
    }
    this.process.sendPermissionResponse(
      requestId,
      decision === 'deny' ? 'deny' : 'allow',
      decision === 'always_allow',
    );
    this.store.append({ decision, requestId, type: 'permission.resolved' });
  }

  respondQuestion(
    requestId: string,
    answers: Record<string, unknown>,
  ): void {
    const pending = this.store.snapshot().pendingQuestion;
    if (pending?.requestId !== requestId) {
      throw new Error('Question request is no longer pending');
    }
    this.process.sendQuestionResponse(requestId, answers);
    this.store.append({ requestId, type: 'question.resolved' });
  }

  cancel(): void {
    if (!this.store.snapshot().processing) {
      return;
    }
    this.process.cancel();
    this.store.append({ type: 'turn.cancelled' });
  }

  async shutdown(): Promise<void> {
    await this.process.shutdown();
  }
}
