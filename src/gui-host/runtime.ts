import type {
  OnBashStream,
  OnPermissionRequest,
  OnQuestionRequest,
  PermissionDecision,
  PromptImage,
} from '../tui/ipc';
import type { GuiPermissionDecision } from './contracts';
import type {
  RuntimeSubagent,
  RuntimeSubagentInspection,
  RuntimeCallbacks,
} from '../runtime/types';
import { GuiEventStore } from './event-store';
import { createRuntimeProcess } from '../runtime/process';
import type { AgentBackend } from '../runtime/backend';

export interface GuiProcess {
  readonly backend: AgentBackend;
  onPermissionRequest?: OnPermissionRequest;
  onQuestionRequest?: OnQuestionRequest;
  onBashStream?: OnBashStream;
  onSubagentsChanged?: (subagents: RuntimeSubagent[]) => void;
  onSubagentsComplete?: (summary: string) => void;
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
  restart(): Promise<void>;
  shutdown(): Promise<void>;
  listSubagents(): RuntimeSubagent[];
  inspectSubagent(id: string): Promise<RuntimeSubagentInspection>;
  stopSubagent(id: string): Promise<void>;
  deploySubagents(queries: string[]): Promise<void>;
  clearSubagents(): Promise<void>;
}

export interface GuiRuntimeOptions {
  process: GuiProcess;
  store: GuiEventStore;
}

export class GuiRuntime {
  private readonly process: GuiProcess;
  private cancelling = false;
  private pendingSubagentSummary?: string;
  private recovering = false;
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
    backend?: AgentBackend;
    model?: string;
  }): GuiRuntime {
    return new GuiRuntime({
      process: createRuntimeProcess({
        agentName: options.agentName ?? 'build',
        backend: options.backend ?? 'flue',
        cwd: options.workspace,
        model: options.model,
        serverPath: options.serverPath,
        sessionId: options.sessionId,
      }),
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
    this.process.onSubagentsChanged = (subagents) => {
      this.store.append({ subagents, type: 'subagents.updated' });
    };
    this.process.onSubagentsComplete = (summary) => {
      this.pendingSubagentSummary = this.pendingSubagentSummary === undefined
        ? summary
        : `${this.pendingSubagentSummary}\n\n${summary}`;
      this.submitPendingSubagentSummary();
    };
    await this.process.start();
    this.store.append({
      model: options.model,
      type: 'host.ready',
      workspace: options.workspace,
    });
  }

  submitPrompt(prompt: string, sessionId?: string): string {
    if (this.recovering) {
      throw new Error('Runtime is restarting');
    }
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
        if (this.cancelling) {
          return;
        }
        this.store.append({ message: error.message, type: 'turn.failed' });
        if (this.process.backend === 'flue' && this.pendingSubagentSummary !== undefined) {
          this.recoverFlue();
        } else {
          this.submitPendingSubagentSummary();
        }
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
            if (event.toolName === 'deploy_parallel_subs') {
              const queries = parallelDeployQueries(event.result);
              if (queries.length > 0) {
                void this.process.deploySubagents(queries).catch((error: unknown) => {
                  this.store.append({
                    event: {
                      message: error instanceof Error ? error.message : String(error),
                      type: 'error',
                    },
                    type: 'runtime.event',
                  });
                });
              }
            }
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
            cost: result.usage.cost?.total ?? 0,
            input: result.usage.input,
            output: result.usage.output,
            totalTokens: result.usage.totalTokens,
          },
        });
        this.submitPendingSubagentSummary();
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
    this.cancelling = true;
    try {
      this.process.cancel();
    } finally {
      this.cancelling = false;
    }
    this.store.append({ type: 'turn.cancelled' });
    if (this.process.backend === 'flue') {
      this.recoverFlue();
    } else {
      this.submitPendingSubagentSummary();
    }
  }

  inspectSubagent(id: string): Promise<RuntimeSubagentInspection> {
    return this.process.inspectSubagent(id);
  }

  stopSubagent(id: string): Promise<void> {
    return this.process.stopSubagent(id);
  }

  async shutdown(): Promise<void> {
    await this.process.shutdown();
  }

  private submitSubagentSummary(summary: string): void {
    this.submitPrompt(
      `The parallel research has completed. Here are the findings:\n\n${summary}\n\nPlease analyze these results and continue with your task.`,
    );
  }

  private submitPendingSubagentSummary(): void {
    if (this.recovering || this.store.snapshot().processing) {
      return;
    }
    const summary = this.pendingSubagentSummary;
    this.pendingSubagentSummary = undefined;
    if (summary !== undefined) {
      try {
        this.submitSubagentSummary(summary);
      } catch (error) {
        this.pendingSubagentSummary = summary;
        if (this.process.backend === 'flue') {
          this.recoverFlue();
          return;
        }
        throw error;
      }
    }
  }

  private recoverFlue(): void {
    if (this.recovering) {
      return;
    }
    this.recovering = true;
    void this.process.restart().then(() => {
      this.recovering = false;
      this.submitPendingSubagentSummary();
    }).catch((error: unknown) => {
      this.recovering = false;
      this.store.append({
        event: {
          message: error instanceof Error ? error.message : String(error),
          type: 'error',
        },
        type: 'runtime.event',
      });
    });
  }
}

function parallelDeployQueries(result: unknown): string[] {
  let value = result;
  if (typeof result === 'string') {
    try {
      value = JSON.parse(result) as unknown;
    } catch {
      return [];
    }
  }
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  const marker = value as Record<string, unknown>;
  return marker.type === 'parallel_deploy' && Array.isArray(marker.queries)
    ? marker.queries.filter((query): query is string => typeof query === 'string')
    : [];
}
