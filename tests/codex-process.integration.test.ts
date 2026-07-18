import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
});

const FAKE_CODEX = `#!/usr/bin/env bun
if (process.argv.includes('--version')) {
  console.log('codex-cli 0.144.5');
  process.exit(0);
}

const decoder = new TextDecoder();
let buffer = '';
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk);
  while (buffer.includes('\\n')) {
    const index = buffer.indexOf('\\n');
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialized') continue;
    let result = {};
    if (message.method === 'account/read') {
      result = { account: { type: 'chatgpt' }, requiresOpenaiAuth: true };
    } else if (message.method === 'model/list') {
      result = { data: [{ id: 'gpt-test', displayName: 'Test', description: 'fixture', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], inputModalities: ['text'], isDefault: true }], nextCursor: null };
    } else if (message.method === 'thread/start') {
      result = { thread: { id: 'thread-test', turns: [] }, model: 'gpt-test', modelProvider: 'openai' };
    } else if (message.method === 'turn/start') {
      result = { turn: { id: 'turn-test' } };
    }
    console.log(JSON.stringify({ id: message.id, result }));
    if (message.method === 'turn/start') {
      setTimeout(() => {
        console.log(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'thread-test', turnId: 'turn-test', itemId: 'a', delta: 'hello back' } }));
        console.log(JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-test', turnId: 'turn-test', tokenUsage: { last: { totalTokens: 5, inputTokens: 3, cachedInputTokens: 1, outputTokens: 2, reasoningOutputTokens: 0 } } } }));
        console.log(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id: 'turn-test', status: 'completed', error: null, items: [] } } }));
      }, 5);
    }
  }
}
`;
