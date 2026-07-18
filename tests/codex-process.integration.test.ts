import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexProcess } from '../src/runtime/codex/runtime';
import type { RuntimeEvent, RuntimeResult } from '../src/runtime/types';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe('Codex process integration', () => {
  test('initializes, probes, lazily starts a thread, and completes a streamed turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lavalamp-codex-'));
    tempDirs.push(dir);
    const executable = join(dir, 'codex');
    await writeFile(executable, FAKE_CODEX, 'utf8');
    await chmod(executable, 0o755);

    const runtime = new CodexProcess(dir, { executable, model: 'gpt-test' });
    await runtime.start();
    expect(runtime.codexThreadId).toBeUndefined();
    expect(await runtime.listModels()).toEqual([expect.objectContaining({
      id: 'gpt-test',
      isDefault: true,
      supportedReasoningEfforts: ['medium'],
    })]);

    const events: RuntimeEvent[] = [];
    const result = await new Promise<RuntimeResult>((resolve, reject) => {
      runtime.prompt('hello', { onError: reject, onEvent: (event) => events.push(event), onResult: resolve }, 'session_test');
    });

    expect(runtime.codexThreadId).toBe('thread-test');
    expect(events).toContainEqual(expect.objectContaining({ text: 'hello back', type: 'text_delta' }));
    expect(result).toMatchObject({
      backend: 'codex',
      sessionId: 'session_test',
      text: 'hello back',
      threadId: 'thread-test',
      turnId: 'turn-test',
      usage: { input: 3, output: 2, totalTokens: 5, cost: null },
    });
    await runtime.shutdown();
  });

  test('tracks, lazily inspects, and interrupts native subagent threads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lavalamp-codex-'));
    tempDirs.push(dir);
    const executable = join(dir, 'codex');
    await writeFile(executable, FAKE_CODEX, 'utf8');
    await chmod(executable, 0o755);

    const runtime = new CodexProcess(dir, { executable, model: 'gpt-test' });
    const updates: string[][] = [];
    runtime.onSubagentsChanged = (subagents) => {
      updates.push(subagents.map((subagent) => `${subagent.id}:${subagent.status}`));
    };
    await runtime.start();
    await new Promise<RuntimeResult>((resolve, reject) => {
      runtime.prompt('delegate', { onError: reject, onResult: resolve });
    });

    expect(updates).toContainEqual(['child-test:running']);
    expect(runtime.listSubagents()).toEqual([
      expect.objectContaining({
        id: 'child-test',
        name: 'Atlas',
        role: 'explorer',
        status: 'running',
        task: 'Inspect authentication',
      }),
    ]);

    const inspection = await runtime.inspectSubagent('child-test');
    expect(inspection.messages).toEqual([
      { role: 'user', content: 'Inspect authentication' },
      { role: 'assistant', content: 'Still checking.' },
    ]);
    await runtime.stopSubagent('child-test');
    await runtime.shutdown();

    const requests = await readFile(join(dir, 'requests.log'), 'utf8');
    expect(requests).toContain('argv:app-server --enable multi_agent --stdio');
    expect(requests).toContain('request:thread/read');
    expect(requests).toContain('request:turn/interrupt');
  });

  test('stops active children before clearing tracked subagents', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lavalamp-codex-'));
    tempDirs.push(dir);
    const executable = join(dir, 'codex');
    await writeFile(executable, FAKE_CODEX, 'utf8');
    await chmod(executable, 0o755);

    const runtime = new CodexProcess(dir, { executable, model: 'gpt-test' });
    await runtime.start();
    await new Promise<RuntimeResult>((resolve, reject) => {
      runtime.prompt('delegate', { onError: reject, onResult: resolve });
    });

    await runtime.clearSubagents();

    expect(runtime.listSubagents()).toEqual([]);
    const requests = await readFile(join(dir, 'requests.log'), 'utf8');
    expect(requests).toContain('request:turn/interrupt');
    await runtime.shutdown();
  });

  test('keeps pending children visible when Codex has no interruptible turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lavalamp-codex-'));
    tempDirs.push(dir);
    const executable = join(dir, 'codex');
    await writeFile(executable, FAKE_CODEX, 'utf8');
    await chmod(executable, 0o755);

    const runtime = new CodexProcess(dir, { executable, model: 'gpt-test' });
    await runtime.start();
    await new Promise<RuntimeResult>((resolve, reject) => {
      runtime.prompt('delegate pending', { onError: reject, onResult: resolve });
    });

    await expect(runtime.stopSubagent('pending-child')).rejects.toThrow(
      'has no active turn to interrupt',
    );
    expect(runtime.listSubagents()).toEqual([
      expect.objectContaining({ id: 'pending-child', status: 'pending' }),
    ]);
    await expect(runtime.clearSubagents()).rejects.toThrow(
      'has no active turn to interrupt',
    );
    expect(runtime.listSubagents()).toHaveLength(1);
    await runtime.shutdown();
  });
});

const FAKE_CODEX = `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const logPath = new URL('./requests.log', import.meta.url);
if (process.argv.includes('--version')) {
  console.log('codex-cli 0.144.5');
  process.exit(0);
}
appendFileSync(logPath, 'argv:' + process.argv.slice(2).join(' ') + '\\n');

const decoder = new TextDecoder();
let buffer = '';
let pendingMode = false;
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk);
  while (buffer.includes('\\n')) {
    const index = buffer.indexOf('\\n');
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialized') continue;
    appendFileSync(logPath, 'request:' + message.method + '\\n');
    let result = {};
    if (message.method === 'account/read') {
      result = { account: { type: 'chatgpt' }, requiresOpenaiAuth: true };
    } else if (message.method === 'model/list') {
      result = { data: [{ id: 'gpt-test', displayName: 'Test', description: 'fixture', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], inputModalities: ['text'], isDefault: true }], nextCursor: null };
    } else if (message.method === 'thread/start') {
      result = { thread: { id: 'thread-test', turns: [] }, model: 'gpt-test', modelProvider: 'openai' };
    } else if (message.method === 'turn/start') {
      pendingMode = message.params.input[0].text.includes('pending');
      result = { turn: { id: 'turn-test' } };
    } else if (message.method === 'thread/read') {
      result = pendingMode
        ? { thread: { id: 'pending-child', parentThreadId: 'thread-test', turns: [] } }
        : { thread: { id: 'child-test', parentThreadId: 'thread-test', turns: [{ id: 'child-turn', status: 'inProgress', items: [{ id: 'child-user', type: 'userMessage', content: [{ type: 'text', text: 'Inspect authentication' }] }, { id: 'child-agent', type: 'agentMessage', text: 'Still checking.' }] }] } };
    }
    console.log(JSON.stringify({ id: message.id, result }));
    if (message.method === 'turn/start') {
      setTimeout(() => {
        const childId = pendingMode ? 'pending-child' : 'child-test';
        const childStatus = pendingMode ? 'pendingInit' : 'running';
        if (!pendingMode) console.log(JSON.stringify({ method: 'thread/started', params: { thread: { id: childId, parentThreadId: 'thread-test', agentNickname: 'Atlas', agentRole: 'explorer', preview: 'Inspect authentication', createdAt: 1, status: { type: 'active', activeFlags: [] }, turns: [] } } }));
        console.log(JSON.stringify({ method: 'item/started', params: { threadId: 'thread-test', turnId: 'turn-test', item: { id: 'collab-1', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'inProgress', senderThreadId: 'thread-test', receiverThreadIds: [childId], prompt: 'Inspect authentication', model: 'gpt-test', reasoningEffort: 'medium', agentsStates: { [childId]: { status: childStatus, message: null } } } } }));
        console.log(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'thread-test', turnId: 'turn-test', itemId: 'a', delta: 'hello back' } }));
        console.log(JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-test', turnId: 'turn-test', tokenUsage: { last: { totalTokens: 5, inputTokens: 3, cachedInputTokens: 1, outputTokens: 2, reasoningOutputTokens: 0 } } } }));
        console.log(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id: 'turn-test', status: 'completed', error: null, items: [] } } }));
      }, 5);
    }
  }
}
`;
