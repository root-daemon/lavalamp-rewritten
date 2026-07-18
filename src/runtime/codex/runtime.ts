import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as v from 'valibot';
import type {
  RuntimeCallbacks,
  RuntimeMode,
  RuntimeModel,
  RuntimeResult,
  RuntimeSubagent,
  RuntimeSubagentInspection,
  RuntimeUsage,
} from '../types';
import type {
  PermissionRequestMsg,
  PromptImage,
  QuestionRequestMsg,
} from '../../tui/ipc';
import { assertBackendSupported } from '../backend';
import { approvalResponse, type ApprovalDecision } from './approvals';
import { translateCodexNotification } from './events';
import {
  CodexJsonlPeer,
  type ServerNotification,
  type ServerRequest,
} from './jsonl';

export const MIN_CODEX_VERSION = [0, 144, 4] as const;

export interface CodexSessionPolicy {
  approvalPolicy: 'on-request' | 'never';
  autoApprove: boolean;
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
}

export function parseCodexVersion(output: string): [number, number, number] | undefined {
  const match = output.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/);
  if (match === null) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isSupportedCodexVersion(output: string): boolean {
  const parsed = parseCodexVersion(output);
  if (parsed === undefined) {
    return false;
  }
  for (let index = 0; index < MIN_CODEX_VERSION.length; index++) {
    const value = parsed[index] ?? 0;
    const minimum = MIN_CODEX_VERSION[index] ?? 0;
    if (value !== minimum) {
      return value > minimum;
    }
  }
  return true;
}

export function codexSessionPolicy(
  mode: RuntimeMode,
  autoApprove: boolean,
  sudo: boolean,
): CodexSessionPolicy {
  if (sudo) {
    return {
      approvalPolicy: 'never',
      autoApprove: false,
      sandbox: 'danger-full-access',
    };
  }
  if (mode === 'ask' || mode === 'plan') {
    return {
      approvalPolicy: 'never',
      autoApprove: false,
      sandbox: 'read-only',
    };
  }
  return {
    approvalPolicy: 'on-request',
    autoApprove,
    sandbox: 'workspace-write',
  };
}

const threadResponseSchema = v.looseObject({
  model: v.optional(v.string()),
  modelProvider: v.optional(v.string()),
  thread: v.looseObject({
    id: v.string(),
    turns: v.optional(v.array(v.unknown())),
  }),
});

const turnResponseSchema = v.looseObject({
  turn: v.looseObject({ id: v.string() }),
});

const modelListSchema = v.looseObject({
  data: v.array(v.looseObject({
    description: v.optional(v.string()),
    displayName: v.string(),
    id: v.string(),
    inputModalities: v.optional(v.array(v.string())),
    isDefault: v.boolean(),
    supportedReasoningEfforts: v.optional(v.array(v.unknown())),
  })),
});

const accountSchema = v.looseObject({
  account: v.nullable(v.unknown()),
  requiresOpenaiAuth: v.boolean(),
});

interface ActiveTurn {
  callbacks: RuntimeCallbacks;
  clientRequestId: string;
  model: string;
  sessionId?: string;
  text: string;
  turnId?: string;
  usage: RuntimeUsage;
}

interface PendingServerRequest {
  id: number | string;
  method: string;
  params: unknown;
}

export interface CodexProcessOptions {
  allowModelFallback?: boolean;
  autoApprove?: boolean;
  debug?: boolean;
  executable?: string;
  mode?: RuntimeMode;
  model?: string;
  sudo?: boolean;
  version?: string;
}

export class CodexProcess {
  private accountState: unknown;
  private active: ActiveTurn | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly debug: boolean;
  private readonly executable: string;
  private mode: RuntimeMode;
  private model?: string;
  private modelCatalog: RuntimeModel[] = [];
  private readonly loginWaiters = new Map<string, {
    reject: (error: Error) => void;
    resolve: () => void;
  }>();
  private readonly completedLogins = new Map<string, Error | null>();
  private nextSessionStartSource: 'startup' | 'clear' = 'startup';
  private peer: CodexJsonlPeer | null = null;
  private readonly pendingServerRequests = new Map<string, PendingServerRequest>();
  private ready = false;
  private shutdownRequested = false;
  private thread: Record<string, unknown> | null = null;
  private threadId?: string;
  private threadModelProvider = 'openai';

  onPermissionRequest?: (request: PermissionRequestMsg) => void;
  onQuestionRequest?: (request: QuestionRequestMsg) => void;
  onBashStream?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  onServerRequestResolved?: (requestId: string) => void;
  onSubagentsChanged?: (subagents: RuntimeSubagent[]) => void;
  onSubagentsComplete?: (summary: string) => void;

  constructor(
    private readonly cwd: string,
    options: CodexProcessOptions = {},
  ) {
    this.executable = options.executable ?? 'codex';
    this.model = options.model;
    this.mode = options.mode ?? 'build';
    this.autoApprove = options.autoApprove ?? false;
    this.allowModelFallback = options.allowModelFallback ?? false;
    this.sudo = options.sudo ?? false;
    this.debug = options.debug ?? process.env.LAVALAMP_DEBUG === '1';
    this.clientVersion = options.version ?? '0.1.2';
  }

  private readonly autoApprove: boolean;
  private readonly allowModelFallback: boolean;
  private readonly clientVersion: string;
  private readonly sudo: boolean;

  get isProcessing(): boolean {
    return this.active !== null;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get codexThreadId(): string | undefined {
    return this.threadId;
  }

  get canonicalThread(): unknown {
    return this.thread;
  }

  get account(): unknown {
    return this.accountState;
  }

  setAgentName(name: string): void {
    this.mode = name === 'explore' ? 'ask' : name === 'plan' ? 'plan' : 'build';
  }

  async start(): Promise<void> {
    if (this.ready) {
      return;
    }
    assertBackendSupported('codex');
    const version = await codexVersion(this.executable);
    if (!isSupportedCodexVersion(version)) {
      throw new Error(
        `Codex CLI >= ${MIN_CODEX_VERSION.join('.')} is required (found ${version.trim() || 'unknown'}).`,
      );
    }

    this.shutdownRequested = false;
    const child = spawn(this.executable, ['app-server', '--stdio'], {
      cwd: this.cwd,
      env: process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    const peer = new CodexJsonlPeer((line) => {
      if (!child.stdin.write(line)) {
        child.stdin.once('drain', () => undefined);
      }
    });
    this.peer = peer;
    peer.onNotification = (notification) => this.handleNotification(notification);
    peer.onRequest = (request) => this.handleServerRequest(request);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => peer.feed(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (this.debug) {
        process.stderr.write(`[codex] ${chunk}`);
      }
    });
    child.once('error', (error) => this.handleExit(error));
    child.once('exit', (code, signal) => {
      this.handleExit(
        new Error(`Codex app-server exited (${signal ?? `code ${code ?? 'unknown'}`}).`),
      );
    });

    try {
      await peer.request('initialize', {
        clientInfo: {
          name: 'lavalamp',
          title: 'Lavalamp',
          version: this.clientVersion,
        },
        capabilities: { experimentalApi: false },
      });
      peer.notify('initialized');
      const account = await peer.request('account/read', { refreshToken: false });
      const parsedAccount = v.safeParse(accountSchema, account);
      if (!parsedAccount.success) {
        throw new Error('Codex account/read returned an incompatible response.');
      }
      this.accountState = parsedAccount.output;
      this.modelCatalog = await this.fetchModels();
      if (this.model !== undefined && !this.modelCatalog.some((entry) => entry.id === this.model)) {
        if (!this.allowModelFallback) {
          throw new Error(`Unknown Codex model: ${this.model}`);
        }
        process.stderr.write(
          `[lavalamp] Warning: configured Codex model ${this.model} is unavailable; using the server default.\n`,
        );
        this.model = undefined;
      }
      this.ready = true;
    } catch (error) {
      await this.terminateChild();
      throw error;
    }
  }

  async listModels(): Promise<RuntimeModel[]> {
    this.requireReady();
    if (this.modelCatalog.length === 0) {
      this.modelCatalog = await this.fetchModels();
    }
    return [...this.modelCatalog];
  }

  async setModel(model: string): Promise<void> {
    const models = await this.listModels();
    if (!models.some((entry) => entry.id === model)) {
      throw new Error(`Unknown Codex model: ${model}`);
    }
    this.model = model;
  }

  async readAccount(): Promise<unknown> {
    this.requireReady();
    const result = await this.requirePeer().request('account/read', { refreshToken: false });
    const parsed = v.safeParse(accountSchema, result);
    if (!parsed.success) {
      throw new Error('Codex account/read returned an incompatible response.');
    }
    this.accountState = parsed.output;
    return parsed.output;
  }

  async login(): Promise<{ authUrl: string; loginId: string }> {
    this.requireReady();
    const result = asRecord(await this.requirePeer().request('account/login/start', { type: 'chatgpt' }));
    if (result.type !== 'chatgpt' || typeof result.authUrl !== 'string' || typeof result.loginId !== 'string') {
      throw new Error('Codex did not return a ChatGPT browser login URL.');
    }
    return { authUrl: result.authUrl, loginId: result.loginId };
  }

  async logout(): Promise<void> {
    this.requireReady();
    await this.requirePeer().request('account/logout', undefined);
    await this.readAccount();
  }

  waitForLogin(loginId: string): Promise<void> {
    if (this.completedLogins.has(loginId)) {
      const result = this.completedLogins.get(loginId);
      this.completedLogins.delete(loginId);
      return result === null ? Promise.resolve() : Promise.reject(result);
    }
    return new Promise((resolve, reject) => {
      this.loginWaiters.set(loginId, { reject, resolve });
    });
  }

  prompt(
    message: string,
    callbacks: RuntimeCallbacks = {},
    sessionId?: string,
    images?: PromptImage[],
  ): string {
    this.requireReady();
    if (this.active !== null) {
      throw new Error('A Codex turn is already running.');
    }
    const clientRequestId = `req_${randomUUID()}`;
    const active: ActiveTurn = {
      callbacks,
      clientRequestId,
      model: this.model ?? this.defaultModelId() ?? 'default',
      sessionId,
      text: '',
      usage: emptyUsage(),
    };
    this.active = active;
    void this.beginTurn(message, images, active).catch((error: unknown) => {
      if (this.active === active) {
        this.active = null;
      }
      callbacks.onError?.(toError(error));
    });
    return clientRequestId;
  }

  async resumeThread(threadId: string): Promise<unknown> {
    this.requireReady();
    if (this.active !== null) {
      throw new Error('Cannot resume a Codex thread while a turn is running.');
    }
    const result = await this.requirePeer().request('thread/resume', {
      threadId,
      ...this.threadSettings(false),
    });
    this.acceptThreadResponse(result, 'thread/resume');
    return this.thread;
  }

  async forkThread(lastTurnId?: string): Promise<unknown> {
    this.requireReady();
    if (this.threadId === undefined) {
      throw new Error('No Codex thread is available to fork.');
    }
    const result = await this.requirePeer().request('thread/fork', {
      threadId: this.threadId,
      ...(lastTurnId === undefined ? {} : { lastTurnId }),
      ...this.threadSettings(false),
    });
    this.acceptThreadResponse(result, 'thread/fork');
    return this.thread;
  }

  async switchMode(mode: RuntimeMode): Promise<unknown> {
    if (this.mode === mode) {
      return this.thread;
    }
    this.mode = mode;
    if (this.threadId !== undefined) {
      return this.forkThread();
    }
    return null;
  }

  clearThread(): void {
    if (this.active !== null) {
      throw new Error('Cannot clear a Codex thread while a turn is running.');
    }
    this.thread = null;
    this.threadId = undefined;
    this.nextSessionStartSource = 'clear';
  }

  async undoLastTurn(): Promise<unknown> {
    this.requireReady();
    const turns = Array.isArray(this.thread?.turns) ? this.thread.turns : [];
    if (turns.length <= 1) {
      this.thread = null;
      this.threadId = undefined;
      this.nextSessionStartSource = 'startup';
      return null;
    }
    const preceding = asRecord(turns[turns.length - 2]);
    if (typeof preceding.id !== 'string') {
      throw new Error('Codex history does not contain a valid preceding turn.');
    }
    return this.forkThread(preceding.id);
  }

  async compact(): Promise<void> {
    this.requireReady();
    if (this.threadId === undefined) {
      return;
    }
    await this.requirePeer().request('thread/compact/start', { threadId: this.threadId });
  }

  async interrupt(): Promise<void> {
    if (this.active?.turnId === undefined || this.threadId === undefined) {
      return;
    }
    await this.requirePeer().request('turn/interrupt', {
      threadId: this.threadId,
      turnId: this.active.turnId,
    });
  }

  cancel(): void {
    void this.interrupt();
  }

  sendPermissionResponse(
    requestId: string,
    decision: 'allow' | 'deny',
    alwaysAllow = false,
  ): void {
    const pending = this.pendingServerRequests.get(requestId);
    if (pending === undefined) {
      return;
    }
    this.pendingServerRequests.delete(requestId);
    const mapped: ApprovalDecision = decision === 'deny' ? 'deny' : alwaysAllow ? 'always' : 'allow';
    try {
      this.requirePeer().respond(
        pending.id,
        approvalResponse(pending.method, mapped, pending.params),
      );
    } catch (error) {
      this.requirePeer().respondError(pending.id, -32602, toError(error).message);
    }
  }

  sendQuestionResponse(requestId: string, answers: Record<string, unknown>): void {
    const pending = this.pendingServerRequests.get(requestId);
    if (pending === undefined) {
      return;
    }
    this.pendingServerRequests.delete(requestId);
    const normalized: Record<string, { answers: string[] }> = {};
    for (const [id, answer] of Object.entries(answers)) {
      normalized[id] = {
        answers: Array.isArray(answer)
          ? answer.map(String)
          : [String(answer ?? '')],
      };
    }
    this.requirePeer().respond(pending.id, { answers: normalized });
  }

  async restart(): Promise<void> {
    const threadId = this.threadId;
    await this.terminateChild();
    this.ready = false;
    await this.start();
    if (threadId !== undefined) {
      await this.resumeThread(threadId);
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownRequested) {
      return;
    }
    this.shutdownRequested = true;
    this.rejectActive(new Error('Shutting down'));
    await this.terminateChild();
  }

  listSubagents(): RuntimeSubagent[] {
    return [];
  }

  async inspectSubagent(id: string): Promise<RuntimeSubagentInspection> {
    throw new Error(`Subagent not found: ${id}`);
  }

  async stopSubagent(_id: string): Promise<void> {}

  async deploySubagents(_queries: string[]): Promise<void> {}

  private async beginTurn(
    message: string,
    images: PromptImage[] | undefined,
    active: ActiveTurn,
  ): Promise<void> {
    if (this.threadId === undefined) {
      const result = await this.requirePeer().request('thread/start', this.threadSettings(true));
      this.acceptThreadResponse(result, 'thread/start');
    }
    const input: Array<Record<string, unknown>> = [{
      type: 'text',
      text: message,
      text_elements: [],
    }];
    for (const image of images ?? []) {
      if (typeof image.path === 'string') {
        input.push({ type: 'localImage', path: image.path });
      }
    }
    const result = await this.requirePeer().request('turn/start', {
      threadId: this.threadId,
      input,
      cwd: this.cwd,
      model: this.model,
    });
    const parsed = v.safeParse(turnResponseSchema, result);
    if (!parsed.success) {
      throw new Error('Codex turn/start returned an incompatible response.');
    }
    active.turnId = parsed.output.turn.id;
    active.callbacks.onStarted?.();
  }

  private handleNotification(notification: ServerNotification): void {
    if (notification.method === 'account/login/completed') {
      const params = asRecord(notification.params);
      const loginId = params.loginId;
      if (typeof loginId === 'string') {
        const waiter = this.loginWaiters.get(loginId);
        this.loginWaiters.delete(loginId);
        if (waiter !== undefined) {
          if (params.success === true) {
            waiter.resolve();
          } else {
            waiter.reject(new Error(
              typeof params.error === 'string' ? params.error : 'Codex login failed.',
            ));
          }
        } else {
          this.completedLogins.set(
            loginId,
            params.success === true
              ? null
              : new Error(typeof params.error === 'string' ? params.error : 'Codex login failed.'),
          );
        }
      }
      return;
    }
    const notificationParams = asRecord(notification.params);
    if (
      typeof notificationParams.threadId === 'string' &&
      this.threadId !== undefined &&
      notificationParams.threadId !== this.threadId
    ) {
      return;
    }
    if (notification.method === 'item/started' || notification.method === 'item/completed') {
      const item = asRecord(notificationParams.item);
      if (typeof item.id !== 'string' || typeof item.type !== 'string') {
        this.rejectActive(new Error(`Codex emitted a malformed ${notification.method} notification.`));
        return;
      }
    }
    if (notification.method === 'thread/tokenUsage/updated') {
      const active = this.active;
      if (active !== null) {
        active.usage = parseUsage(notification.params);
        active.callbacks.onEvent?.({ type: 'usage', usage: active.usage });
      }
      return;
    }
    if (notification.method === 'turn/completed') {
      this.completeTurn(notification.params);
      return;
    }
    if (notification.method === 'serverRequest/resolved') {
      const requestId = asRecord(notification.params).requestId;
      if (typeof requestId === 'string' || typeof requestId === 'number') {
        const localId = `codex_${String(requestId)}`;
        this.pendingServerRequests.delete(localId);
        this.onServerRequestResolved?.(localId);
      }
      return;
    }
    const events = translateCodexNotification(notification.method, notification.params);
    if (events.length === 0 && this.debug) {
      process.stderr.write(`[codex] ignored notification ${notification.method}\n`);
    }
    for (const event of events) {
      if (event.type === 'text_delta') {
        this.active && (this.active.text += event.text ?? event.delta ?? '');
      }
      if (event.type === 'command_output') {
        this.onBashStream?.(event.chunk ?? '', event.stream ?? 'stdout');
      }
      this.active?.callbacks.onEvent?.(event);
    }
  }

  private completeTurn(params: unknown): void {
    const active = this.active;
    if (active === null) {
      return;
    }
    const value = asRecord(params);
    const turn = asRecord(value.turn);
    if (typeof value.threadId !== 'string' || typeof turn.id !== 'string' || typeof turn.status !== 'string') {
      this.rejectActive(new Error('Codex emitted a malformed turn/completed notification.'));
      return;
    }
    if (this.threadId !== value.threadId || (active.turnId !== undefined && active.turnId !== turn.id)) {
      return;
    }
    if (active.text.length === 0 && Array.isArray(turn.items)) {
      active.text = turn.items
        .map(asRecord)
        .filter((item) => item.type === 'agentMessage' && typeof item.text === 'string')
        .map((item) => item.text as string)
        .join('');
    }
    this.active = null;
    const result: RuntimeResult = {
      backend: 'codex',
      text: active.text,
      usage: active.usage,
      model: { provider: this.threadModelProvider, id: active.model },
      ...(active.sessionId === undefined ? {} : { sessionId: active.sessionId }),
      threadId: value.threadId,
      turnId: turn.id,
    };
    if (this.thread !== null) {
      const turns = Array.isArray(this.thread.turns) ? this.thread.turns : [];
      this.thread.turns = [...turns.filter((entry) => asRecord(entry).id !== turn.id), turn];
    }
    active.callbacks.onEvent?.({ status: turn.status, turnId: turn.id, type: 'turn_completed' });
    if (turn.status === 'failed') {
      const error = asRecord(turn.error);
      active.callbacks.onError?.(new Error(
        typeof error.message === 'string' ? error.message : 'Codex turn failed.',
      ));
      return;
    }
    active.callbacks.onResult?.(result);
  }

  private handleServerRequest(request: ServerRequest): void {
    const requestId = `codex_${String(request.id)}`;
    if (isApprovalMethod(request.method)) {
      if (this.sudo || (this.autoApprove && shouldAutoApproveCodexRequest(request.method, request.params))) {
        this.requirePeer().respond(request.id, approvalResponse(request.method, 'allow', request.params));
        return;
      }
      if (this.autoApprove || this.onPermissionRequest === undefined) {
        this.requirePeer().respond(request.id, approvalResponse(request.method, 'deny', request.params));
        return;
      }
      this.pendingServerRequests.set(requestId, request);
      this.onPermissionRequest({
        allowSession: supportsSessionDecision(request.params),
        noTimeout: true,
        type: 'permission_request',
        requestId,
        toolName: approvalToolName(request.method),
        args: asRecord(request.params),
      });
      return;
    }
    if (request.method === 'item/tool/requestUserInput') {
      const questions = readQuestions(request.params);
      if (this.onQuestionRequest === undefined) {
        const answers = Object.fromEntries(questions.map((question) => [question.id, question.default ?? '']));
        this.pendingServerRequests.set(requestId, request);
        this.sendQuestionResponse(requestId, answers);
        return;
      }
      this.pendingServerRequests.set(requestId, request);
      this.onQuestionRequest({ type: 'question_request', requestId, questions });
      return;
    }
    this.requirePeer().respondError(request.id, -32601, `Unsupported Codex server request: ${request.method}`);
    this.active?.callbacks.onEvent?.({
      message: `Denied unsupported Codex server request: ${request.method}`,
      type: 'warning',
    });
  }

  private acceptThreadResponse(result: unknown, method: string): void {
    const parsed = v.safeParse(threadResponseSchema, result);
    if (!parsed.success) {
      throw new Error(`Codex ${method} returned an incompatible response.`);
    }
    this.thread = parsed.output.thread;
    this.threadId = parsed.output.thread.id;
    if (method === 'thread/start') {
      this.nextSessionStartSource = 'startup';
    }
    this.threadModelProvider = parsed.output.modelProvider ?? 'openai';
    if (this.model === undefined && parsed.output.model !== undefined) {
      this.model = parsed.output.model;
    }
  }

  private async fetchModels(): Promise<RuntimeModel[]> {
    const result = await this.requirePeer().request('model/list', { includeHidden: false });
    const parsed = v.safeParse(modelListSchema, result);
    if (!parsed.success) {
      throw new Error('Codex model/list returned an incompatible response.');
    }
    return parsed.output.data.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      description: model.description ?? '',
      isDefault: model.isDefault,
      inputModalities: model.inputModalities ?? [],
      supportedReasoningEfforts: (model.supportedReasoningEfforts ?? []).flatMap((entry) => {
        if (typeof entry === 'string') {
          return [entry];
        }
        const option = asRecord(entry);
        const effort = option.reasoningEffort ?? option.effort;
        return typeof effort === 'string' ? [effort] : [];
      }),
    }));
  }

  private threadSettings(includeStartSource: boolean): Record<string, unknown> {
    const policy = codexSessionPolicy(this.mode, this.autoApprove, this.sudo);
    return {
      cwd: this.cwd,
      ...(this.model === undefined ? {} : { model: this.model }),
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
      ...(this.mode === 'plan' ? { developerInstructions: PLAN_MODE_INSTRUCTIONS } : {}),
      ...(includeStartSource ? { sessionStartSource: this.nextSessionStartSource } : {}),
    };
  }

  private defaultModelId(): string | undefined {
    return this.modelCatalog.find((entry) => entry.isDefault)?.id;
  }

  private requirePeer(): CodexJsonlPeer {
    if (this.peer === null) {
      throw new Error('Codex app-server is not started.');
    }
    return this.peer;
  }

  private requireReady(): void {
    if (!this.ready || this.peer === null || this.child === null) {
      throw new Error('Codex app-server is not started.');
    }
  }

  private rejectActive(error: Error): void {
    const active = this.active;
    this.active = null;
    active?.callbacks.onError?.(error);
  }

  private handleExit(error: Error): void {
    this.peer?.close(error);
    this.ready = false;
    this.child = null;
    this.rejectActive(error);
    for (const waiter of this.loginWaiters.values()) {
      waiter.reject(error);
    }
    this.loginWaiters.clear();
    this.completedLogins.clear();
  }

  private async terminateChild(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.pendingServerRequests.clear();
    if (child === null || child.exitCode !== null || child.signalCode !== null) {
      this.peer = null;
      return;
    }
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
    this.peer?.close(new Error('Codex app-server stopped.'));
    this.peer = null;
  }
}

export const PLAN_MODE_INSTRUCTIONS = [
  'You are in Lavalamp plan mode.',
  'Research and produce a concrete implementation plan without modifying files or running mutating commands.',
  'Resolve architecture, dependencies, risks, tests, and verification steps before presenting the plan.',
].join('\n');

async function codexVersion(executable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, ['--version'], { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error !== null) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error('Codex CLI was not found on PATH. Install Codex, then run "lavalamp status --backend codex".'));
          return;
        }
        reject(new Error(`Unable to run Codex CLI: ${stderr || error.message}`));
        return;
      }
      resolve(stdout || stderr);
    });
  });
}

function emptyUsage(): RuntimeUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: null,
  };
}

function parseUsage(params: unknown): RuntimeUsage {
  const total = asRecord(asRecord(asRecord(params).tokenUsage).last);
  return {
    input: numberValue(total.inputTokens),
    output: numberValue(total.outputTokens),
    cacheRead: numberValue(total.cachedInputTokens),
    cacheWrite: 0,
    totalTokens: numberValue(total.totalTokens),
    cost: null,
  };
}

function numberValue(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isApprovalMethod(method: string): boolean {
  return method === 'item/commandExecution/requestApproval' ||
    method === 'item/fileChange/requestApproval' ||
    method === 'item/permissions/requestApproval';
}

export function shouldAutoApproveCodexRequest(method: string, params: unknown): boolean {
  if (method === 'item/permissions/requestApproval') {
    return false;
  }
  if (method !== 'item/commandExecution/requestApproval' && method !== 'item/fileChange/requestApproval') {
    return false;
  }
  const request = asRecord(params);
  return request.networkApprovalContext == null &&
    (!Array.isArray(request.proposedNetworkPolicyAmendments) || request.proposedNetworkPolicyAmendments.length === 0) &&
    request.grantRoot == null;
}

export function isCodexLoginRequired(state: unknown): boolean {
  const account = asRecord(state);
  return account.requiresOpenaiAuth === true && account.account == null;
}

function approvalToolName(method: string): string {
  if (method === 'item/commandExecution/requestApproval') return 'commandExecution';
  if (method === 'item/fileChange/requestApproval') return 'fileChange';
  return 'permissions';
}

function supportsSessionDecision(params: unknown): boolean {
  const available = asRecord(params).availableDecisions;
  if (!Array.isArray(available)) {
    return true;
  }
  return available.includes('acceptForSession') || available.includes('session');
}

function readQuestions(params: unknown): Array<Record<string, unknown> & { id: string }> {
  const questions = asRecord(params).questions;
  if (!Array.isArray(questions)) {
    return [];
  }
  return questions.flatMap((value) => {
    const question = asRecord(value);
    if (typeof question.id !== 'string') {
      return [];
    }
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option) => {
        const item = asRecord(option);
        return typeof item.label === 'string' ? [{ label: item.label, value: item.label }] : [];
      })
      : undefined;
    return [{
      ...question,
      id: question.id,
      type: options === undefined ? 'text' : 'select',
      ...(options === undefined ? {} : { options }),
    }];
  });
}
