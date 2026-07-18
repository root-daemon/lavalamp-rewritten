import { afterEach, describe, expect, test } from 'bun:test';
import type { GuiPermissionDecision } from '../src/gui-host/contracts';
import { GuiEventStore } from '../src/gui-host/event-store';
import {
  createGuiHostServer,
  type GuiHostRuntime,
} from '../src/gui-host/server';

class FakeRuntime implements GuiHostRuntime {
  readonly store = new GuiEventStore();
  prompts: Array<[string, string | undefined]> = [];
  permissions: Array<[string, GuiPermissionDecision]> = [];
  questions: Array<[string, Record<string, unknown>]> = [];
  cancelled = false;

  submitPrompt(prompt: string, sessionId?: string): string {
    this.prompts.push([prompt, sessionId]);
    this.store.append({ type: 'turn.started' });
    return 'request-1';
  }

  respondPermission(id: string, decision: GuiPermissionDecision): void {
    this.permissions.push([id, decision]);
  }

  respondQuestion(id: string, answers: Record<string, unknown>): void {
    this.questions.push([id, answers]);
  }

  cancel(): void {
    this.cancelled = true;
  }

  async shutdown(): Promise<void> {}
}

const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function fixture() {
  const runtime = new FakeRuntime();
  const server = createGuiHostServer({
    hostname: '127.0.0.1',
    listModels: () => [{ displayName: 'Model A', id: 'model-a' }],
    listSessions: () => [{ prompt: 'Fix tests', sessionId: 'session-a' }],
    loadSession: (sessionId) =>
      sessionId === 'session-a'
        ? [{ content: 'Fix tests', role: 'user' as const }]
        : null,
    port: 0,
    runCommand: (command) => ({
      rows: [`handled ${command}`],
      title: command.split(/\s+/)[0] ?? '/command',
    }),
    runtime,
    token: 'secret-token',
    workspace: '/repo',
  });
  servers.push(server);
  const base = `http://${server.hostname}:${server.port}`;
  const request = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: 'Bearer secret-token',
        'content-type': 'application/json',
        ...init.headers,
      },
    });
  return { request, runtime };
}

describe('GUI host server', () => {
  test('allows unauthenticated health but protects API data', async () => {
    const { request } = fixture();
    const health = await request('/v1/health', { headers: {} });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      ok: true,
      data: { ready: true, workspace: '/repo' },
    });

    const denied = await request('/v1/events', {
      headers: { authorization: 'Bearer wrong' },
    });
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({
      ok: false,
      error: { code: 'unauthorized' },
    });
  });

  test('submits prompts and reads incremental events with snapshot', async () => {
    const { request, runtime } = fixture();
    const submitted = await request('/v1/prompts', {
      body: JSON.stringify({ prompt: 'Fix tests', sessionId: 'session-a' }),
      method: 'POST',
    });
    expect(submitted.status).toBe(202);
    expect(runtime.prompts).toEqual([['Fix tests', 'session-a']]);
    runtime.store.append({ delta: 'Working', type: 'text.delta' });

    const events = await request('/v1/events?after=1');
    expect(await events.json()).toMatchObject({
      ok: true,
      data: {
        events: [{ delta: 'Working', id: 2, type: 'text.delta' }],
        snapshot: { assistantText: 'Working', cursor: 2 },
      },
    });
  });

  test('validates prompt payload and body size', async () => {
    const { request } = fixture();
    const invalid = await request('/v1/prompts', {
      body: JSON.stringify({ prompt: '   ' }),
      method: 'POST',
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: { code: 'invalid_prompt' },
    });

    const oversized = await request('/v1/prompts', {
      body: JSON.stringify({ prompt: 'x'.repeat(1_048_577) }),
      method: 'POST',
    });
    expect(oversized.status).toBe(413);
  });

  test('routes permissions, questions, cancellation, sessions, and models', async () => {
    const { request, runtime } = fixture();
    await request('/v1/permissions/perm-1', {
      body: JSON.stringify({ decision: 'always_allow' }),
      method: 'POST',
    });
    await request('/v1/questions/question-1', {
      body: JSON.stringify({ answers: { choice: 'native' } }),
      method: 'POST',
    });
    await request('/v1/cancel', { body: '{}', method: 'POST' });

    expect(runtime.permissions).toEqual([['perm-1', 'always_allow']]);
    expect(runtime.questions).toEqual([
      ['question-1', { choice: 'native' }],
    ]);
    expect(runtime.cancelled).toBe(true);
    expect(await (await request('/v1/sessions')).json()).toMatchObject({
      data: [{ sessionId: 'session-a' }],
    });
    expect(await (await request('/v1/models')).json()).toMatchObject({
      data: [{ id: 'model-a' }],
    });

    const resumed = await request('/v1/session', {
      body: JSON.stringify({ sessionId: 'session-a' }),
      method: 'POST',
    });
    expect(await resumed.json()).toMatchObject({
      data: {
        messages: [{ content: 'Fix tests', role: 'user' }],
        sessionId: 'session-a',
      },
    });
  });

  test('offers compact native snapshot and raw prompt endpoints', async () => {
    const { request, runtime } = fixture();
    const prompt = await request('/v1/native/prompts', {
      body: 'Fix "quoted" tests\nwithout JSON escaping',
      headers: {
        authorization: 'Bearer secret-token',
        'content-type': 'text/plain',
        'x-lavalamp-session': 'session-a',
      },
      method: 'POST',
    });
    expect(prompt.status).toBe(202);
    expect(runtime.prompts).toEqual([
      ['Fix "quoted" tests\nwithout JSON escaping', 'session-a'],
    ]);

    const snapshot = await request('/v1/native/snapshot');
    expect(await snapshot.json()).toMatchObject({
      ok: true,
      data: {
        models: [{ id: 'model-a' }],
        sessions: [{ sessionId: 'session-a' }],
        snapshot: { processing: true },
      },
    });
  });

  test('runs native slash commands through authenticated host API', async () => {
    const { request } = fixture();
    const command = await request('/v1/native/commands', {
      body: '/usage',
      headers: { 'content-type': 'text/plain' },
      method: 'POST',
    });
    expect(command.status).toBe(200);
    expect(await command.json()).toMatchObject({
      data: { rows: ['handled /usage'], title: '/usage' },
      ok: true,
    });
  });
});
