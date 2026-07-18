interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface ServerRequest {
  id: number | string;
  method: string;
  params: unknown;
}

export interface ServerNotification {
  method: string;
  params: unknown;
}

interface PendingRequest {
  method: string;
  params: unknown;
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  retryIndex: number;
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export interface CodexJsonlPeerOptions {
  requestTimeoutMs?: number;
  retryDelaysMs?: number[];
}

export class CodexJsonlPeer {
  private buffer = '';
  private closedError: Error | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly requests = new Set<PendingRequest>();
  private readonly requestTimeoutMs: number;
  private readonly retryDelaysMs: number[];
  private readonly jitterRetries: boolean;
  onNotification?: (notification: ServerNotification) => void;
  onRequest?: (request: ServerRequest) => void;

  constructor(
    private readonly writeLine: (line: string) => void,
    options: CodexJsonlPeerOptions = {},
  ) {
    this.jitterRetries = options.retryDelaysMs === undefined;
    this.retryDelaysMs = options.retryDelaysMs ?? [100, 200, 400, 800, 1600];
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closedError !== null) {
      return Promise.reject(this.closedError);
    }
    return new Promise((resolve, reject) => {
      const request: PendingRequest = {
        method,
        params,
        reject,
        resolve,
        retryIndex: 0,
        settled: false,
      };
      this.requests.add(request);
      if (this.requestTimeoutMs > 0) {
        request.timer = setTimeout(() => {
          this.finish(request, new Error(`Codex request timed out: ${method}`));
        }, this.requestTimeoutMs);
      }
      this.sendAttempt(request);
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  respond(id: number | string, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    this.write({ error: { code, message }, id });
  }

  feed(chunk: string): void {
    if (this.closedError !== null) {
      return;
    }
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline === -1) {
        return;
      }
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length === 0) {
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        this.close(new Error('Codex app-server emitted malformed JSONL.'));
        return;
      }
      this.handleMessage(value);
    }
  }

  close(error: Error): void {
    if (this.closedError !== null) {
      return;
    }
    this.closedError = error;
    const requests = new Set(this.requests);
    this.pending.clear();
    for (const request of requests) {
      this.finish(request, error);
    }
  }

  private sendAttempt(request: PendingRequest): void {
    if (request.settled) {
      return;
    }
    if (this.closedError !== null) {
      this.finish(request, this.closedError);
      return;
    }
    const id = this.nextId++;
    this.pending.set(id, request);
    this.write({ id, method: request.method, params: request.params });
  }

  private handleMessage(value: unknown): void {
    if (typeof value !== 'object' || value === null) {
      return;
    }
    const message = value as Record<string, unknown>;
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        if (
          (typeof message.id === 'number' || typeof message.id === 'string') &&
          this.onRequest !== undefined
        ) {
          this.onRequest({
            id: message.id,
            method: message.method,
            params: message.params,
          });
        }
      } else if (this.onNotification !== undefined) {
        this.onNotification({ method: message.method, params: message.params });
      }
      return;
    }
    if (typeof message.id !== 'number') {
      return;
    }
    const request = this.pending.get(message.id);
    if (request === undefined) {
      return;
    }
    this.pending.delete(message.id);
    if (isRpcError(message.error)) {
      if (
        message.error.code === -32001 &&
        request.retryIndex < this.retryDelaysMs.length
      ) {
        const baseDelay = this.retryDelaysMs[request.retryIndex] ?? 0;
        const delay = this.jitterRetries
          ? Math.round(baseDelay * (0.8 + Math.random() * 0.4))
          : baseDelay;
        request.retryIndex++;
        setTimeout(() => this.sendAttempt(request), delay);
        return;
      }
      this.finish(request, new Error(message.error.message));
      return;
    }
    this.finish(request, undefined, message.result);
  }

  private finish(request: PendingRequest, error?: Error, value?: unknown): void {
    if (request.settled) return;
    request.settled = true;
    if (request.timer !== undefined) clearTimeout(request.timer);
    this.requests.delete(request);
    for (const [id, pending] of this.pending) {
      if (pending === request) this.pending.delete(id);
    }
    if (error !== undefined) request.reject(error);
    else request.resolve(value);
  }

  private write(message: Record<string, unknown>): void {
    this.writeLine(`${JSON.stringify(message)}\n`);
  }
}

function isRpcError(value: unknown): value is RpcError {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const error = value as Record<string, unknown>;
  return typeof error.code === 'number' && typeof error.message === 'string';
}
