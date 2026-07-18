import type { GuiPermissionDecision } from './contracts';
import type { GuiMessageSnapshot } from './contracts';
import type { GuiEventStore } from './event-store';

const MAX_BODY_BYTES = 1024 * 1024;

export interface GuiHostRuntime {
  readonly store: GuiEventStore;
  submitPrompt(prompt: string, sessionId?: string): string;
  respondPermission(requestId: string, decision: GuiPermissionDecision): void;
  respondQuestion(
    requestId: string,
    answers: Record<string, unknown>,
  ): void;
  cancel(): void;
  shutdown(): Promise<void>;
}

export interface GuiHostServerOptions {
  runtime: GuiHostRuntime;
  token: string;
  workspace: string;
  hostname?: string;
  port?: number;
  listSessions?: () => unknown[];
  listModels?: () => unknown[];
  loadSession?: (sessionId: string) => GuiMessageSnapshot[] | null;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    headers: { 'cache-control': 'no-store' },
    status,
  });
}

function success<T>(data: T, status = 200): Response {
  return json({ data, ok: true }, status);
}

function failure(code: string, message: string, status: number): Response {
  return json({ error: { code, message }, ok: false }, status);
}

async function parseBody(
  request: Request,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_BODY_BYTES) {
    return {
      ok: false,
      response: failure('body_too_large', 'Request body exceeds 1 MiB', 413),
    };
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) {
    return {
      ok: false,
      response: failure('body_too_large', 'Request body exceeds 1 MiB', 413),
    };
  }
  if (bytes.byteLength === 0) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        ok: false,
        response: failure('invalid_json', 'JSON body must be an object', 400),
      };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return {
      ok: false,
      response: failure('invalid_json', 'Request body is not valid JSON', 400),
    };
  }
}

function isPermissionDecision(value: unknown): value is GuiPermissionDecision {
  return value === 'allow' || value === 'always_allow' || value === 'deny';
}

export function createGuiHostServer(
  options: GuiHostServerOptions,
): Bun.Server<undefined> {
  const hostname = options.hostname ?? '127.0.0.1';
  if (hostname !== '127.0.0.1' && hostname !== '::1' && hostname !== 'localhost') {
    throw new Error('GUI host must bind to a loopback address');
  }

  return Bun.serve({
    hostname,
    port: options.port ?? 34_197,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/v1/health' && request.method === 'GET') {
        return success({ ready: true, workspace: options.workspace });
      }

      if (request.headers.get('authorization') !== `Bearer ${options.token}`) {
        return failure('unauthorized', 'Bearer token is required', 401);
      }

      try {
        if (url.pathname === '/v1/native/snapshot' && request.method === 'GET') {
          return success({
            models: options.listModels?.() ?? [],
            sessions: options.listSessions?.() ?? [],
            snapshot: options.runtime.store.snapshot(),
          });
        }

        if (url.pathname === '/v1/native/prompts' && request.method === 'POST') {
          const declaredLength = Number(request.headers.get('content-length') ?? '0');
          if (declaredLength > MAX_BODY_BYTES) {
            return failure('body_too_large', 'Request body exceeds 1 MiB', 413);
          }
          const prompt = await request.text();
          if (new TextEncoder().encode(prompt).byteLength > MAX_BODY_BYTES) {
            return failure('body_too_large', 'Request body exceeds 1 MiB', 413);
          }
          if (prompt.trim().length === 0) {
            return failure('invalid_prompt', 'prompt must be non-empty', 400);
          }
          const sessionId = request.headers.get('x-lavalamp-session') ?? undefined;
          const requestId = options.runtime.submitPrompt(prompt, sessionId);
          return success({ requestId }, 202);
        }

        if (url.pathname === '/v1/events' && request.method === 'GET') {
          const rawCursor = url.searchParams.get('after') ?? '0';
          const cursor = Number(rawCursor);
          if (!Number.isSafeInteger(cursor) || cursor < 0) {
            return failure('invalid_cursor', 'after must be a positive integer', 400);
          }
          return success({
            events: options.runtime.store.after(cursor),
            snapshot: options.runtime.store.snapshot(),
          });
        }

        if (url.pathname === '/v1/session' && request.method === 'POST') {
          const body = await parseBody(request);
          if (!body.ok) return body.response;
          const sessionId =
            typeof body.value.sessionId === 'string'
              ? body.value.sessionId
              : undefined;
          const messages = sessionId === undefined
            ? []
            : options.loadSession?.(sessionId);
          if (sessionId !== undefined && messages == null) {
            return failure('session_not_found', 'Session was not found', 404);
          }
          options.runtime.store.replaceMessages(messages ?? []);
          return success({
            messages: messages ?? [],
            sessionId,
            snapshot: options.runtime.store.snapshot(),
          });
        }

        if (url.pathname === '/v1/prompts' && request.method === 'POST') {
          const body = await parseBody(request);
          if (!body.ok) return body.response;
          const prompt = body.value.prompt;
          if (typeof prompt !== 'string' || prompt.trim().length === 0) {
            return failure('invalid_prompt', 'prompt must be a non-empty string', 400);
          }
          const sessionId =
            typeof body.value.sessionId === 'string'
              ? body.value.sessionId
              : undefined;
          const requestId = options.runtime.submitPrompt(prompt, sessionId);
          return success({ requestId }, 202);
        }

        if (url.pathname.startsWith('/v1/permissions/') && request.method === 'POST') {
          const requestId = decodeURIComponent(url.pathname.slice('/v1/permissions/'.length));
          if (requestId.length === 0) {
            return failure('invalid_request_id', 'Permission request ID is required', 400);
          }
          const body = await parseBody(request);
          if (!body.ok) return body.response;
          if (!isPermissionDecision(body.value.decision)) {
            return failure('invalid_decision', 'decision must be allow, always_allow, or deny', 400);
          }
          options.runtime.respondPermission(requestId, body.value.decision);
          return success({ requestId });
        }

        if (url.pathname.startsWith('/v1/questions/') && request.method === 'POST') {
          const requestId = decodeURIComponent(url.pathname.slice('/v1/questions/'.length));
          const body = await parseBody(request);
          if (!body.ok) return body.response;
          const answers = body.value.answers;
          if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) {
            return failure('invalid_answers', 'answers must be an object', 400);
          }
          options.runtime.respondQuestion(
            requestId,
            answers as Record<string, unknown>,
          );
          return success({ requestId });
        }

        if (url.pathname === '/v1/cancel' && request.method === 'POST') {
          options.runtime.cancel();
          return success({ cancelled: true });
        }

        if (url.pathname === '/v1/sessions' && request.method === 'GET') {
          return success(options.listSessions?.() ?? []);
        }

        if (url.pathname === '/v1/models' && request.method === 'GET') {
          return success(options.listModels?.() ?? []);
        }

        return failure('not_found', 'Route not found', 404);
      } catch (error) {
        return failure(
          'request_failed',
          error instanceof Error ? error.message : String(error),
          409,
        );
      }
    },
  });
}
