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
import { resolveConfig } from '../config/user-config';
import { createRuntimeProcess } from '../runtime/process';
import type { RuntimeCallbacks, RuntimeMode, RuntimeModel } from '../runtime/types';
import { AnalyticsRecorder, type RunRating } from '../analytics';
import { SubAgentManager } from '../tui/subs';
import type { SubAgent } from '../tui/state';
import { BackupEngine } from '../storage/backups';
import { planMutationBackup } from '../storage/mutation-backups';
import type { GuiPermissionDecision, GuiSubagentSnapshot } from './contracts';
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
  subAgentManager?: GuiSubAgentManager;
}

export interface GuiSubAgentManager {
  onUpdate?: (subs: SubAgent[]) => void;
  onAllComplete?: (summary: string) => void;
  deploy(queries: string[]): Promise<void>;
  killAll(): void;
  list(): SubAgent[];
}

export interface GuiUndoResult {
  removedMessages: number;
  restoredWorkspace: boolean;
  restoreError?: string;
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
  private readonly injectedSubAgentManager?: GuiSubAgentManager;
  private subManager?: GuiSubAgentManager;
  private backupEngine?: BackupEngine;
  private backupHistory: string[] = [];
  private turnBackupId: string | null = null;
  private imageAttachments: AttachedImage[] = [];
  private imageCounter = 0;
  private promptQueue: Array<{
    prompt: string;
    sessionId?: string;
    images: PromptImage[];
  }> = [];

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
    this.injectedSubAgentManager = options.subAgentManager;
    if (options.workspace !== undefined) {
      try {
        this.backupEngine = new BackupEngine(options.workspace);
      } catch {
        this.backupEngine = undefined;
      }
      this.analytics = AnalyticsRecorder.create({
        agent: modeToAgentName(this.mode),
        conversationSessionId: options.sessionId,
        mode: this.mode,
        workspaceRoot: options.workspace,
      });
    }
    this.configureSubagents();
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
    const trimmed = prompt.trim();
    if (trimmed.length === 0) {
      throw new Error('Prompt is required');
    }
    const images = this.collectPromptImages(trimmed);
    if (this.store.snapshot().processing) {
      this.promptQueue.push({ images, prompt: trimmed, sessionId });
      this.store.append({ content: trimmed, type: 'prompt.queued' });
      return `queued-${this.promptQueue.length}`;
    }
    return this.startPrompt(trimmed, sessionId, images);
  }

  private collectPromptImages(prompt: string): PromptImage[] {
    const promptAttachments = attachmentsForPrompt(prompt, this.imageAttachments);
    this.imageAttachments = [];
    return promptAttachments.map((image) => ({
      data: '',
      mimeType: 'image/png',
      path: image.path,
      type: 'image',
    }));
  }

  private startPrompt(
    prompt: string,
    sessionId: string | undefined,
    images: PromptImage[],
  ): string {
    this.turnBackupId = null;
    this.store.append({ content: prompt, type: 'user.message' });
    return this.process.prompt(prompt, {
      onError: (error) => {
        this.analytics?.finishTurn(this.activeTurnId, 'failed');
        this.activeTurnId = undefined;
        this.store.append({ message: error.message, type: 'turn.failed' });
        this.drainPromptQueue();
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
            this.createMutationBackup(
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
            if (event.toolName === 'deploy_parallel_subs') {
              this.deployParallelSubagents(event.result);
            }
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
        this.drainPromptQueue();
      },
      onStarted: () => {
        this.activeTurnId = this.analytics?.startTurn();
        this.store.append({ type: 'turn.started' });
      },
    }, sessionId, images);
  }

  private drainPromptQueue(): void {
    if (this.store.snapshot().processing || this.promptQueue.length === 0) {
      return;
    }
    const next = this.promptQueue.shift();
    if (next === undefined) return;
    this.store.append({ type: 'prompt.dequeued' });
    try {
      this.startPrompt(next.prompt, next.sessionId, next.images);
    } catch (error) {
      this.store.append({
        message: error instanceof Error ? error.message : String(error),
        type: 'turn.failed',
      });
      this.drainPromptQueue();
    }
  }

  private clearPromptQueue(): void {
    if (this.promptQueue.length === 0) return;
    this.promptQueue = [];
    this.store.append({ type: 'prompt.queue_cleared' });
  }

  private configureSubagents(): void {
    if (this.subManager !== undefined) {
      this.stopSubagents();
    }
    if (this.backend !== 'flue' || this.workspace === undefined) {
      return;
    }
    const manager = this.injectedSubAgentManager ?? (() => {
      if (this.serverPath === undefined) return undefined;
      return new SubAgentManager(
        this.serverPath,
        this.workspace,
        modeToAgentName(this.mode),
        this.analytics,
        () => this.activeTurnId,
      );
    })();
    if (manager === undefined) {
      this.store.append({ subagents: [], type: 'subagents.updated' });
      return;
    }
    manager.onUpdate = (subs) => this.publishSubagents(subs);
    manager.onAllComplete = (summary) => {
      this.publishSubagents(manager.list());
      const followUp = `The parallel research has completed. Here are the findings:\n\n${summary}\n\nPlease analyze these results and continue with your task.`;
      try {
        this.submitPrompt(followUp, this.sessionId);
      } catch (error) {
        this.store.append({
          message: `subagent follow-up failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          type: 'turn.failed',
        });
      }
    };
    this.subManager = manager;
    this.publishSubagents(manager.list());
  }

  private stopSubagents(): void {
    const manager = this.subManager;
    if (manager === undefined) return;
    manager.onAllComplete = undefined;
    manager.onUpdate = undefined;
    manager.killAll();
    this.subManager = undefined;
    this.store.append({ subagents: [], type: 'subagents.updated' });
  }

  private deployParallelSubagents(result: unknown): void {
    const marker = parseSubagentDeployMarker(result);
    if (marker === undefined) return;
    const manager = this.subManager;
    if (manager === undefined) {
      this.store.append({
        message: 'Subagents require the flue backend.',
        type: 'notice',
      });
      return;
    }
    manager.deploy(marker.queries).catch((error: unknown) => {
      this.store.append({
        message: `subagents failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        type: 'turn.failed',
      });
    });
  }

  private publishSubagents(subagents: SubAgent[]): void {
    this.store.append({
      subagents: subagents.map(toSubagentSnapshot),
      type: 'subagents.updated',
    });
  }

  private createMutationBackup(
    name: string,
    args: Record<string, unknown>,
  ): void {
    const backupEngine = this.backupEngine;
    if (backupEngine === undefined) return;
    const plan = planMutationBackup(name, args);
    if (plan === null) return;
    try {
      if (this.turnBackupId === null) {
        this.turnBackupId = backupEngine.createBackup(plan.paths);
        this.backupHistory.push(this.turnBackupId);
      } else {
        backupEngine.extendBackup(this.turnBackupId, plan.paths);
      }
    } catch {}
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
    this.configureSubagents();
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

    const config = resolveConfig();
    const nextModel = backend === 'codex'
      ? config.codexModel || undefined
      : config.defaultModel || undefined;

    this.stopSubagents();
    await this.process.shutdown();
    this.backend = backend;
    this.model = nextModel;
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
      model: nextModel,
      serverPath: this.serverPath,
      sessionId: this.sessionId,
    });
    this.wireProcess();
    await this.process.start();
    this.store.resetConversation();
    this.store.append({
      backend,
      mode: this.mode,
      model: nextModel,
      type: 'backend.changed',
    });
    this.configureSubagents();
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

  async undo(): Promise<GuiUndoResult> {
    const before = this.store.snapshot().messages.length;
    const restore = this.restoreLastBackup();
    await this.process.undoLastTurn?.();
    this.store.undoLastTurn();
    const removedMessages = Math.max(
      0,
      before - this.store.snapshot().messages.length,
    );
    return { removedMessages, ...restore };
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
    this.clearPromptQueue();
    this.stopSubagents();
    if (this.store.snapshot().processing) {
      this.process.cancel();
      this.analytics?.finishTurn(this.activeTurnId, 'interrupted');
      this.activeTurnId = undefined;
      this.store.append({ type: 'turn.cancelled' });
    }
  }

  async restart(): Promise<void> {
    if (this.store.snapshot().processing) {
      throw new Error('Cannot restart while a turn is running');
    }
    this.clearPromptQueue();
    this.stopSubagents();
    await this.process.restart?.();
    this.configureSubagents();
  }

  rate(rating: RunRating): void {
    this.analytics?.rate(rating);
  }

  async shutdown(): Promise<void> {
    const processing = this.store.snapshot().processing;
    this.clearPromptQueue();
    this.stopSubagents();
    if (processing) {
      this.analytics?.finishTurn(this.activeTurnId, 'interrupted');
      this.activeTurnId = undefined;
    }
    this.analytics?.finish(processing ? 'interrupted' : 'completed');
    this.analytics?.close();
    await this.process.shutdown();
  }

  private restoreLastBackup(): {
    restoredWorkspace: boolean;
    restoreError?: string;
  } {
    const backupId = this.backupHistory.pop();
    if (backupId === undefined || this.backupEngine === undefined) {
      return { restoredWorkspace: false };
    }
    try {
      this.backupEngine.restoreBackup(backupId);
      return { restoredWorkspace: true };
    } catch (error) {
      return {
        restoredWorkspace: false,
        restoreError: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function parseSubagentDeployMarker(
  result: unknown,
): { queries: string[] } | undefined {
  const marker =
    typeof result === 'string'
      ? (() => {
          try {
            return JSON.parse(result) as unknown;
          } catch {
            return undefined;
          }
        })()
      : result;
  if (marker === undefined || marker === null || typeof marker !== 'object') {
    return undefined;
  }
  const candidate = marker as { type?: unknown; queries?: unknown };
  if (candidate.type !== 'parallel_deploy' || !Array.isArray(candidate.queries)) {
    return undefined;
  }
  const queries = candidate.queries
    .filter((query): query is string => typeof query === 'string')
    .map((query) => query.trim())
    .filter((query) => query.length > 0)
    .slice(0, 3);
  return queries.length === 0 ? undefined : { queries };
}

function toSubagentSnapshot(sub: SubAgent): GuiSubagentSnapshot {
  return {
    durationMs: Math.max(0, Date.now() - sub.startTime),
    error: sub.error,
    id: sub.id,
    pid: sub.pid,
    query: sub.query,
    result: sub.result,
    status: sub.status,
  };
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
