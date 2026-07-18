import { describe, expect, test } from 'bun:test';
import { translateCodexNotification } from '../src/runtime/codex/events.ts';

describe('Codex event translation', () => {
  test('maps assistant and reasoning deltas', () => {
    expect(
      translateCodexNotification('item/agentMessage/delta', {
        delta: 'hello',
        itemId: 'a',
        threadId: 't',
        turnId: 'u',
      }),
    ).toEqual([{ delta: 'hello', text: 'hello', type: 'text_delta' }]);

    expect(
      translateCodexNotification('item/reasoning/summaryTextDelta', {
        delta: 'thinking',
        itemId: 'r',
        threadId: 't',
        turnId: 'u',
      }),
    ).toEqual([{ content: 'thinking', delta: 'thinking', type: 'thinking_delta' }]);
  });

  test('maps command item lifecycle and output', () => {
    const item = {
      aggregatedOutput: 'done',
      command: 'bun test',
      cwd: '/repo',
      durationMs: 12,
      exitCode: 0,
      id: 'cmd-1',
      status: 'completed',
      type: 'commandExecution',
    };
    expect(
      translateCodexNotification('item/started', { item, threadId: 't', turnId: 'u' }),
    ).toEqual([
      {
        args: { command: 'bun test', cwd: '/repo' },
        toolCallId: 'cmd-1',
        toolName: 'commandExecution',
        type: 'tool_start',
      },
    ]);
    expect(
      translateCodexNotification('item/completed', { item, threadId: 't', turnId: 'u' }),
    ).toEqual([
      {
        durationMs: 12,
        isError: false,
        result: { exitCode: 0, output: 'done', status: 'completed' },
        toolCallId: 'cmd-1',
        toolName: 'commandExecution',
        type: 'tool',
      },
    ]);
    expect(
      translateCodexNotification('item/commandExecution/outputDelta', {
        delta: 'line',
        itemId: 'cmd-1',
        threadId: 't',
        turnId: 'u',
      }),
    ).toEqual([{ chunk: 'line', stream: 'stdout', type: 'command_output' }]);
  });

  test('ignores unknown notifications', () => {
    expect(translateCodexNotification('future/event', { value: true })).toEqual([]);
  });
});
