import type {
  OnBashStream,
  OnPermissionRequest,
  OnQuestionRequest,
  PermissionDecision,
  PromptImage,
} from '../tui/ipc';
import { attachmentsForPrompt, type AttachedImage } from '../tui/attachments';
import type { TuiLoginProgress } from '../tui/login';
import { loginFromTui } from '../tui/login';
import type { AgentBackend } from '../runtime/backend';
import { createRuntimeProcess } from '../runtime/process';
import type { RuntimeCallbacks, RuntimeMode, RuntimeModel } from '../runtime/types';
import { AnalyticsRecorder, type RunRating } from '../analytics';
import type { GuiPermissionDecision } from './contracts';
import { GuiEventStore } from './event-store';

export interface GuiProcess {
  readonly backend?: AgentBackend;
  readonly account?: unknown;
  readonly isProcessing: boolean;
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
  restart?(): Promise<void>;
  setAgentName?(name: string): void;
  compact?(): Promise<unknown>;
  undoLastTurn?(): Promise<unknown>;
  switchMode?(mode: RuntimeMode): Promise<unknown>;
  listModels?(): Promise<RuntimeModel[]>;
  setModel?(model: string): Promise<void>;
  login?(): Promise<{ authUrl: string; loginId: string }>;
  readAccount?(): Promise<unknown>;
  waitForLogin?(loginId: string): Promise<void>;
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
  private analytics?: AnalyticsRecorder;
  private activeTurnId?: string;
  private imageAttachments: AttachedImage[] = [];
  private imageCounter = 0;

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
    if (options.workspace !== undefined) {
      this.analytics = AnalyticsRecorder.create({
        agent: modeToAgentName(this.mode),
        conversationSessionId: options.sessionId,
        mode: this.mode,
        workspaceRoot: options.workspace,
      });
    }
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
      this.analytics?.event('permission', 'requested', this.activeTurnId);
      this.store.append({
        args: request.args,
        requestId: request.requestId,
        toolName: request.toolName,
        type: 'permission.requested',
      });
    };
    this.process.onQuestionRequest = (request) => {
      this.analytics?.event('question', 'requested', this.activeTurnId);
      this.store.append({
        questions: request.questions,
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
    const promptAttachments = attachmentsForPrompt(trimmed, this.imageAttachments);
    this.imageAttachments = [];
    const images: PromptImage[] = promptAttachments.map((image) => ({
      data: '',
      mimeType: 'image/png',
      path: image.path,
      type: 'image',
    }));
    this.store.append({ content: trimmed, type: 'user.message' });
    return this.process.prompt(trimmed, {
      onError: (error) => {
        this.analytics?.finishTurn(this.activeTurnId, 'failed');
        this.activeTurnId = undefined;
        this.store.append({ message: error.message, type: 'turn.failed' });
      },
      onEvent: (event) => {
        switch (event.type) {
          case 'text_delta':
            this.analytics?.firstResponse(this.activeTurnId);
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
            this.analytics?.toolStarted(
              this.activeTurnId,
              event.toolCallId,
              event.toolName ?? 'unknown',
              event.args ?? {},
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
              this.activeTurnId,
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
        this.analytics?.finishTurn(this.activeTurnId, 'completed', {
          model: result.model,
          usage: result.usage,
        });
        this.activeTurnId = undefined;
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
      },
      onStarted: () => {
        this.activeTurnId = this.analytics?.startTurn();
        this.store.append({ type: 'turn.started' });
      },
    }, sessionId, images);
  }

  attachImage(path: string): string {
    this.imageCounter += 1;
    const tag = `[Image ${this.imageCounter}]`;
    this.imageAttachments.push({ path, tag });
    return tag;
  }

  async login(options: {
    cloudflareLogin: () => Promise<unknown>;
    onProgress: (event: TuiLoginProgress) => void;
    openBrowser: (url: string) => Promise<boolean>;
  }): Promise<void> {
    await loginFromTui({
      backend: this.backend,
      cloudflareLogin: options.cloudflareLogin,
      onProgress: options.onProgress,
      openBrowser: options.openBrowser,
      runtime: this.process,
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
    this.analytics?.finish('completed');
    this.analytics = this.workspace === undefined
      ? undefined
      : AnalyticsRecorder.create({
          agent: modeToAgentName(mode),
          conversationSessionId: this.sessionId,
          mode,
          workspaceRoot: this.workspace,
        });
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

    await this.process.shutdown();
    this.backend = backend;
    this.sessionId = `session_${Date.now()}`;
    this.analytics?.finish('completed');
    this.analytics = this.workspace === undefined
      ? undefined
      : AnalyticsRecorder.create({
          agent: modeToAgentName(this.mode),
          conversationSessionId: this.sessionId,
          mode: this.mode,
          workspaceRoot: this.workspace,
        });
    this.process = createRuntimeProcess({
      agentName: modeToAgentName(this.mode),
      allowModelFallback: backend === 'codex',
      backend,
      cwd: this.workspace,
      model: this.model,
      serverPath: this.serverPath,
      sessionId: this.sessionId,
    });
    this.wireProcess();
    await this.process.start();
    this.store.resetConversation();
    this.store.append({
      backend,
      mode: this.mode,
      model: this.model,
      type: 'backend.changed',
    });
  }

  async compact(): Promise<void> {
    if (this.process.compact !== undefined) {
      await this.process.compact();
      this.analytics?.event('compaction', 'completed', this.activeTurnId);
      this.store.append({ message: 'Context compacted', type: 'notice' });
      return;
    }
    this.analytics?.event('compaction', 'completed', this.activeTurnId);
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
    this.analytics?.event(
      'permission',
      decision === 'deny' ? 'denied' : 'allowed',
      this.activeTurnId,
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
    this.analytics?.event('question', 'answered', this.activeTurnId);
    this.store.append({ requestId, type: 'question.resolved' });
  }

  cancel(): void {
    if (!this.store.snapshot().processing) {
      return;
    }
    this.process.cancel();
    this.analytics?.finishTurn(this.activeTurnId, 'interrupted');
    this.activeTurnId = undefined;
    this.store.append({ type: 'turn.cancelled' });
  }

  async restart(): Promise<void> {
    if (this.store.snapshot().processing) {
      throw new Error('Cannot restart while a turn is running');
    }
    await this.process.restart?.();
  }

  rate(rating: RunRating): void {
    this.analytics?.rate(rating);
  }

  async shutdown(): Promise<void> {
    const processing = this.store.snapshot().processing;
    if (processing) {
      this.analytics?.finishTurn(this.activeTurnId, 'interrupted');
      this.activeTurnId = undefined;
    }
    this.analytics?.finish(processing ? 'interrupted' : 'completed');
    this.analytics?.close();
    await this.process.shutdown();
  }
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
