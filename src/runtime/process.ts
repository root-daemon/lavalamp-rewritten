import { FlueProcess } from '../tui/ipc';
import type {
  PermissionRequestMsg,
  PromptImage,
  QuestionRequestMsg,
} from '../tui/ipc';
import type { AgentBackend } from './backend';
import { CodexProcess } from './codex/runtime';
import type {
  RuntimeCallbacks,
  RuntimeMode,
  RuntimeModel,
  RuntimeSubagent,
  RuntimeSubagentInspection,
} from './types';

export interface RuntimeProcess {
  readonly backend: AgentBackend;
  readonly codexThreadId?: string;
  readonly canonicalThread?: unknown;
  readonly account?: unknown;
  readonly isProcessing: boolean;
  onPermissionRequest?: (request: PermissionRequestMsg) => void;
  onQuestionRequest?: (request: QuestionRequestMsg) => void;
  onBashStream?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  onServerRequestResolved?: (requestId: string) => void;
  onSubagentsChanged?: (subagents: RuntimeSubagent[]) => void;
  onSubagentsComplete?: (summary: string) => void;
  start(): Promise<void>;
  prompt(message: string, callbacks?: RuntimeCallbacks, sessionId?: string, images?: PromptImage[]): string;
  cancel(): void;
  restart(): Promise<void>;
  shutdown(): Promise<void>;
  setAgentName(name: string): void;
  sendPermissionResponse(requestId: string, decision: 'allow' | 'deny', alwaysAllow?: boolean): void;
  sendQuestionResponse(requestId: string, answers: Record<string, unknown>): void;
  compact?(): Promise<void>;
  interrupt?(): Promise<void>;
  resumeThread?(threadId: string): Promise<unknown>;
  switchMode?(mode: RuntimeMode): Promise<unknown>;
  clearThread?(): void;
  undoLastTurn?(): Promise<unknown>;
  listModels?(): Promise<RuntimeModel[]>;
  setModel?(model: string): Promise<void>;
  login?(): Promise<{ authUrl: string; loginId: string }>;
  readAccount?(): Promise<unknown>;
  waitForLogin?(loginId: string): Promise<void>;
  listSubagents(): RuntimeSubagent[];
  inspectSubagent(id: string): Promise<RuntimeSubagentInspection>;
  stopSubagent(id: string): Promise<void>;
  deploySubagents(queries: string[]): Promise<void>;
}

export interface CreateRuntimeProcessOptions {
  agentName: string;
  allowModelFallback?: boolean;
  autoApprove?: boolean;
  backend: AgentBackend;
  cwd: string;
  model?: string;
  serverPath: string;
  sessionId?: string;
  sudo?: boolean;
  version?: string;
}

export function createRuntimeProcess(options: CreateRuntimeProcessOptions): RuntimeProcess {
  if (options.backend === 'codex') {
    const process = new CodexProcess(options.cwd, {
      allowModelFallback: options.allowModelFallback,
      autoApprove: options.autoApprove,
      mode: options.agentName === 'explore' ? 'ask' : options.agentName === 'plan' ? 'plan' : 'build',
      model: options.model,
      sudo: options.sudo,
      version: options.version,
    });
    return Object.assign(process, { backend: 'codex' as const });
  }
  return new FlueRuntimeProcess(options);
}

class FlueRuntimeProcess implements RuntimeProcess {
  readonly backend = 'flue' as const;
  private readonly process: FlueProcess;

  constructor(options: CreateRuntimeProcessOptions) {
    this.process = new FlueProcess(
      options.serverPath,
      options.cwd,
      options.agentName,
      options.sessionId,
    );
  }

  get isProcessing(): boolean { return this.process.isProcessing; }
  get onPermissionRequest() { return this.process.onPermissionRequest; }
  set onPermissionRequest(value) { this.process.onPermissionRequest = value; }
  get onQuestionRequest() { return this.process.onQuestionRequest; }
  set onQuestionRequest(value) { this.process.onQuestionRequest = value; }
  get onBashStream() { return this.process.onBashStream; }
  set onBashStream(value) { this.process.onBashStream = value; }
  start() { return this.process.start(); }
  cancel() { this.process.cancel(); }
  restart() { return this.process.restart(); }
  shutdown() { return this.process.shutdown(); }
  setAgentName(name: string) { this.process.setAgentName(name); }
  sendPermissionResponse(requestId: string, decision: 'allow' | 'deny', alwaysAllow?: boolean) {
    this.process.sendPermissionResponse(requestId, decision, alwaysAllow);
  }
  sendQuestionResponse(requestId: string, answers: Record<string, unknown>) {
    this.process.sendQuestionResponse(requestId, answers);
  }
  prompt(message: string, callbacks: RuntimeCallbacks = {}, sessionId?: string, images?: PromptImage[]): string {
    return this.process.prompt(message, {
      ...callbacks,
      onResult: callbacks.onResult === undefined ? undefined : (result) => callbacks.onResult?.({
        backend: 'flue',
        ...result,
      }),
    }, sessionId, images);
  }

  listSubagents(): RuntimeSubagent[] { return []; }
  async inspectSubagent(id: string): Promise<RuntimeSubagentInspection> {
    throw new Error(`Subagent not found: ${id}`);
  }
  async stopSubagent(_id: string): Promise<void> {}
  async deploySubagents(_queries: string[]): Promise<void> {}
}
