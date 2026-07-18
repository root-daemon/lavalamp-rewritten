import { readFileSync } from 'node:fs';
import { AnalyticsRecorder } from '../analytics';
import type {
  OnBashStream,
  OnPermissionRequest,
  OnQuestionRequest,
  PermissionDecision,
  PromptImage,
} from '../tui/ipc';
import type { AgentBackend } from '../runtime/backend';
import { createRuntimeProcess } from '../runtime/process';
import type { RuntimeCallbacks, RuntimeMode, RuntimeModel } from '../runtime/types';
import type { GuiPermissionDecision, GuiQuestion } from './contracts';
import { GuiEventStore } from './event-store';

export interface GuiProcess {
  readonly backend?: AgentBackend;
  onPermissionRequest?: OnPermissionRequest;
  onQuestionRequest?: OnQuestionRequest;
  onBashStream?: OnBashStream;
  start(): Promise<void>;
  prompt(
    message: string,
    callbacks?: RuntimeCallbacks,
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
  clearThread?(): void;
  restart?(): Promise<void>;
  setAgentName?(name: string): void;
  compact?(): Promise<unknown>;
  undoLastTurn?(): Promise<unknown>;
  switchMode?(mode: RuntimeMode): Promise<unknown>;
  listModels?(): Promise<RuntimeModel[]>;
  setModel?(model: string): Promise<void>;
  shutdown(): Promise<void>;
}

export interface GuiRuntimeOptions {
  process: GuiProcess;
  store: GuiEventStore;
}

export class GuiRuntime {
  private process: GuiProcess;
  readonly store: GuiEventStore;
  private readonly serverPath?: string;
  private readonly workspace?: string;
  private backend: AgentBackend;
  private mode: RuntimeMode;
  private model?: string;
  private sessionId?: string;
  private sudo = false;
  private analytics?: AnalyticsRecorder;
  private analyticsTurn?: string;
  private queuedPrompts: Array<{
    prompt: string;
    sessionId?: string;
    images: PromptImage[];
  }> = [];
  private pendingImages: PromptImage[] = [];

  constructor(options: GuiRuntimeOptions & {
    backend?: AgentBackend;
    mode?: RuntimeMode;
    model?: string;
    serverPath?: string;
    sessionId?: string;
    workspace?: string;
  }) {
    this.process = options.process;
    this.store = options.store;
    this.backend = options.backend ?? options.process.backend ?? 'flue';
    this.mode = options.mode ?? 'build';
    this.model = options.model;
    this.serverPath = options.serverPath;
    this.sessionId = options.sessionId;
    this.workspace = options.workspace;
    this.startAnalytics();
  }

  static create(options: {
    serverPath: string;
    workspace: string;
    backend?: AgentBackend;
    model?: string;
    agentName?: string;
    sessionId?: string;
    store?: GuiEventStore;
  }): GuiRuntime {
    const mode = agentNameToMode(options.agentName ?? 'build');
    return new GuiRuntime({
      backend: options.backend ?? 'flue',
      mode,
      model: options.model,
      process: createRuntimeProcess({
        agentName: modeToAgentName(mode),
        allowModelFallback: options.backend === 'codex',
        backend: options.backend ?? 'flue',
        cwd: options.workspace,
        model: options.model,
        serverPath: options.serverPath,
        sessionId: options.sessionId,
      }),
      serverPath: options.serverPath,
      sessionId: options.sessionId,
      store: options.store ?? new GuiEventStore(),
      workspace: options.workspace,
    });
  }

  async start(options: { workspace: string; model?: string }): Promise<void> {
    this.wireProcess();
    await this.process.start();
    this.store.append({
      backend: this.backend,
      mode: this.mode,
      model: options.model ?? this.model,
      type: 'host.ready',
      workspace: options.workspace,
    });
  }

  private wireProcess(): void {
    this.process.onPermissionRequest = (request) => {
      this.analytics?.event('permission', 'requested', this.analyticsTurn);
      this.store.append({
        args: request.args,
        requestId: request.requestId,
        toolName: request.toolName,
        type: 'permission.requested',
      });
    };
    this.process.onQuestionRequest = (request) => {
      this.analytics?.event('question', 'requested', this.analyticsTurn);
      this.store.append({
        questions: normalizeQuestions(request.questions),
        requestId: request.requestId,
        type: 'question.requested',
      });
    };
    if (process.env.LAVALAMP_GUI_SHOW_LOGS === '1') {
      this.process.onBashStream = (chunk, stream) => {
        this.store.append({ chunk, stream, type: 'terminal.output' });
      };
    }
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
    const images = this.pendingImages.splice(0);
    return this.process.prompt(trimmed, {
      onError: (error) => {
        this.finishAnalyticsTurn('failed');
        this.store.append({ message: error.message, type: 'turn.failed' });
        this.scheduleQueuedPrompt();
      },
      onEvent: (event) => {
        switch (event.type) {
          case 'text_delta':
            this.analytics?.firstResponse(this.analyticsTurn);
            this.store.append({
              delta: event.text ?? event.delta ?? '',
              type: 'text.delta',
            });
            break;
          case 'thinking_delta':
            this.analytics?.firstResponse(this.analyticsTurn);
            this.store.append({
              delta: event.delta ?? event.content ?? '',
              type: 'thinking.delta',
            });
            break;
          case 'tool_start':
            this.analytics?.toolStarted(
              this.analyticsTurn,
              event.toolCallId,
              event.toolName ?? 'unknown',
              event.args,
            );
            this.store.append({
              args: event.args ?? {},
              toolCallId: event.toolCallId ?? `tool-${Date.now()}`,
              toolName: event.toolName ?? 'unknown',
              type: 'tool.started',
            });
            break;
          case 'tool':
            this.analytics?.toolFinished(
              this.analyticsTurn,
              event.toolCallId,
              event.toolName ?? 'unknown',
              event.durationMs,
              Boolean(event.isError),
            );
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
        this.analytics?.finishTurn(this.analyticsTurn, 'completed', {
          model: result.model,
          usage: result.usage,
        });
        this.analyticsTurn = undefined;
        this.store.append({
          backend: result.backend ?? this.backend,
          model: result.model.id,
          provider: result.model.provider,
          type: 'turn.completed',
          usage: {
            cacheRead: result.usage.cacheRead,
            cacheWrite: result.usage.cacheWrite,
            cost: result.usage.cost?.total ?? 0,
            input: result.usage.input,
            output: result.usage.output,
            totalTokens: result.usage.totalTokens,
          },
        });
        this.scheduleQueuedPrompt();
      },
      onStarted: () => {
        this.analyticsTurn = this.analytics?.startTurn();
        this.store.append({ type: 'turn.started' });
      },
    }, sessionId, images);
  }

  queuePrompt(prompt: string, sessionId?: string): string {
    const trimmed = prompt.trim();
    if (trimmed.length === 0) throw new Error('Prompt is required');
    if (!this.store.snapshot().processing && this.queuedPrompts.length === 0) {
      return this.submitPrompt(trimmed, sessionId);
    }
    this.queuedPrompts.push({
      images: this.pendingImages.splice(0),
      prompt: trimmed,
      sessionId,
    });
    return `queued-${this.queuedPrompts.length}`;
  }

  attachImage(path: string): void {
    this.pendingImages.push({
      data: this.backend === 'codex' ? '' : readFileSync(path).toString('base64'),
      mimeType: 'image/png',
      path,
      type: 'image',
    });
  }

  private scheduleQueuedPrompt(): void {
    queueMicrotask(() => {
      if (this.store.snapshot().processing) return;
      const next = this.queuedPrompts.shift();
      if (next === undefined) return;
      try {
        this.pendingImages.unshift(...next.images);
        this.submitPrompt(next.prompt, next.sessionId);
      } catch (error) {
        this.store.append({
          message: error instanceof Error ? error.message : String(error),
          type: 'turn.failed',
        });
        this.scheduleQueuedPrompt();
      }
    });
  }

  async setMode(mode: RuntimeMode): Promise<void> {
    if (mode === this.mode) return;
    if (this.store.snapshot().processing) {
      throw new Error('Cannot change mode while a turn is running');
    }
    if (this.process.switchMode !== undefined) {
      await this.process.switchMode(mode);
    } else {
      this.process.setAgentName?.(modeToAgentName(mode));
      await this.process.restart?.();
    }
    this.mode = mode;
    this.store.append({ mode, type: 'mode.changed' });
  }

  async setModel(model: string): Promise<void> {
    if (this.store.snapshot().processing) {
      throw new Error('Cannot change model while a turn is running');
    }
    if (this.process.setModel !== undefined) {
      await this.process.setModel(model);
    } else {
      this.model = model;
      await this.process.restart?.();
    }
    this.model = model;
    this.store.append({ model, type: 'model.changed' });
  }

  async setBackend(backend: AgentBackend): Promise<void> {
    if (backend === this.backend) return;
    if (this.store.snapshot().processing) {
      throw new Error('Cannot change backend while a turn is running');
    }
    if (this.serverPath === undefined || this.workspace === undefined) {
      throw new Error('Runtime factory is unavailable');
    }

    this.finishAnalyticsRun('completed');
    await this.process.shutdown();
    this.backend = backend;
    this.sessionId = `session_${Date.now()}`;
    this.process = createRuntimeProcess({
      agentName: modeToAgentName(this.mode),
      allowModelFallback: backend === 'codex',
      backend,
      cwd: this.workspace,
      model: this.model,
      serverPath: this.serverPath,
      sessionId: this.sessionId,
      sudo: this.sudo,
    });
    this.wireProcess();
    await this.process.start();
    this.startAnalytics();
    this.store.resetConversation();
    this.store.append({
      backend,
      mode: this.mode,
      model: this.model,
      type: 'backend.changed',
    });
  }

  async setSudo(enabled: boolean): Promise<void> {
    if (this.store.snapshot().processing) {
      throw new Error('Cannot change sudo mode while a turn is running');
    }
    this.sudo = enabled;
    this.sessionId = `session_${Date.now()}`;
    if (this.serverPath !== undefined && this.workspace !== undefined) {
      this.finishAnalyticsRun('completed');
      await this.process.shutdown();
      this.process = createRuntimeProcess({
        agentName: modeToAgentName(this.mode),
        allowModelFallback: this.backend === 'codex',
        backend: this.backend,
        cwd: this.workspace,
        model: this.model,
        serverPath: this.serverPath,
        sessionId: this.sessionId,
        sudo: enabled,
      });
      this.wireProcess();
      await this.process.start();
      this.startAnalytics();
    } else {
      await this.process.restart?.();
    }
    this.store.resetConversation();
  }

  async newSession(): Promise<void> {
    this.queuedPrompts = [];
    this.pendingImages = [];
    if (this.store.snapshot().processing) {
      this.process.cancel();
      this.finishAnalyticsTurn('interrupted');
    }
    this.sessionId = `session_${Date.now()}`;
    if (this.serverPath !== undefined && this.workspace !== undefined) {
      this.finishAnalyticsRun('completed');
      await this.process.shutdown();
      this.process = createRuntimeProcess({
        agentName: modeToAgentName(this.mode),
        allowModelFallback: this.backend === 'codex',
        backend: this.backend,
        cwd: this.workspace,
        model: this.model,
        serverPath: this.serverPath,
        sessionId: this.sessionId,
        sudo: this.sudo,
      });
      this.wireProcess();
      await this.process.start();
      this.startAnalytics();
    } else {
      this.process.clearThread?.();
      await this.process.restart?.();
    }
    this.store.resetConversation();
  }

  async compact(): Promise<void> {
    if (this.process.compact !== undefined) {
      await this.process.compact();
      this.store.append({ message: 'Context compacted', type: 'notice' });
      return;
    }
    this.store.compactMessages();
  }

  async undo(): Promise<void> {
    await this.process.undoLastTurn?.();
    this.store.undoLastTurn();
  }

  async listModels(): Promise<RuntimeModel[]> {
    return (await this.process.listModels?.()) ?? [];
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
    this.analytics?.event('permission', decision, this.analyticsTurn);
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
    this.analytics?.event('question', 'answered', this.analyticsTurn);
    this.store.append({ requestId, type: 'question.resolved' });
  }

  cancel(): void {
    this.queuedPrompts = [];
    this.pendingImages = [];
    if (!this.store.snapshot().processing) {
      return;
    }
    this.process.cancel();
    this.finishAnalyticsTurn('interrupted');
    this.store.append({ type: 'turn.cancelled' });
  }

  async shutdown(): Promise<void> {
    if (this.store.snapshot().processing) this.finishAnalyticsTurn('interrupted');
    this.finishAnalyticsRun('completed');
    await this.process.shutdown();
  }

  private startAnalytics(): void {
    if (this.workspace === undefined) return;
    this.analytics = AnalyticsRecorder.create({
      agent: this.mode,
      conversationSessionId: this.sessionId,
      mode: 'gui',
      workspaceRoot: this.workspace,
    });
  }

  private finishAnalyticsTurn(status: 'failed' | 'interrupted'): void {
    this.analytics?.finishTurn(this.analyticsTurn, status);
    this.analyticsTurn = undefined;
  }

  private finishAnalyticsRun(status: 'completed' | 'interrupted'): void {
    this.analytics?.finish(status);
    this.analytics?.close();
    this.analytics = undefined;
    this.analyticsTurn = undefined;
  }
}

function normalizeQuestions(questions: unknown[]): GuiQuestion[] {
  return questions.flatMap((value, index) => {
    if (value === null || typeof value !== 'object') return [];
    const raw = value as Record<string, unknown>;
    const id = typeof raw.id === 'string' && raw.id.length > 0
      ? raw.id
      : `question-${index + 1}`;
    const type = raw.type === 'multiselect'
      ? 'multiselect'
      : raw.type === 'select'
        ? 'select'
        : 'input';
    const options = Array.isArray(raw.options)
      ? raw.options.flatMap((option) => {
          if (typeof option === 'string') return [option];
          if (option !== null && typeof option === 'object') {
            const label = (option as Record<string, unknown>).label;
            return typeof label === 'string' ? [label] : [];
          }
          return [];
        })
      : [];
    const defaultValue =
      typeof raw.default === 'string' ||
      (Array.isArray(raw.default) && raw.default.every((item) => typeof item === 'string'))
        ? raw.default as string | string[]
        : undefined;
    return [{
      defaultValue,
      id,
      options,
      question: typeof raw.question === 'string'
        ? raw.question
        : typeof raw.label === 'string'
          ? raw.label
          : 'Please provide an answer.',
      type,
    }];
  });
}

function agentNameToMode(agentName: string): RuntimeMode {
  if (agentName === 'explore') return 'ask';
  if (agentName === 'plan') return 'plan';
  return 'build';
}

function modeToAgentName(mode: RuntimeMode): string {
  if (mode === 'ask') return 'explore';
  return mode;
}
