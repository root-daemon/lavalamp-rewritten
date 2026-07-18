import { describe, expect, test } from 'bun:test';
import { EMPTY_USAGE } from '../src/gui-host/contracts';
import { GuiEventStore } from '../src/gui-host/event-store';

describe('GUI event store', () => {
  test('assigns monotonic IDs and returns only events after cursor', () => {
    const store = new GuiEventStore({ maxEvents: 10 });
    const first = store.append({ type: 'turn.started' });
    const second = store.append({ delta: 'hello', type: 'text.delta' });

    expect(first.id).toBe(1);
    expect(second.id).toBe(2);
    expect(store.after(1)).toEqual([second]);
  });

  test('bounds retained events without losing accumulated snapshot', () => {
    const store = new GuiEventStore({ maxEvents: 2 });
    store.append({ type: 'turn.started' });
    store.append({ delta: 'hello ', type: 'text.delta' });
    store.append({ delta: 'world', type: 'text.delta' });
    store.append({
      type: 'turn.completed',
      usage: {
        cacheRead: 3,
        cacheWrite: 0,
        cost: 0.02,
        input: 10,
        output: 5,
        totalTokens: 18,
      },
    });

    expect(store.after(0).map((event) => event.id)).toEqual([3, 4]);
    expect(store.snapshot()).toMatchObject({
      assistantText: 'hello world',
      cursor: 4,
      processing: false,
      usage: { cost: 0.02, totalTokens: 18 },
    });
  });

  test('tracks pending permission and clears it after decision', () => {
    const store = new GuiEventStore({ maxEvents: 10 });
    store.append({
      args: { cmd: 'bun test' },
      requestId: 'perm-1',
      toolName: 'bash',
      type: 'permission.requested',
    });
    expect(store.snapshot().pendingPermission?.requestId).toBe('perm-1');

    store.append({
      decision: 'allow',
      requestId: 'perm-1',
      type: 'permission.resolved',
    });
    expect(store.snapshot().pendingPermission).toBeUndefined();
  });

  test('retains conversation messages and tool lifecycle for native rendering', () => {
    const store = new GuiEventStore({ maxEvents: 20 });
    store.append({ content: 'Fix tests', type: 'user.message' });
    store.append({ type: 'turn.started' });
    store.append({ delta: 'Done', type: 'text.delta' });
    store.append({
      args: { cmd: 'bun test' },
      toolCallId: 'tool-1',
      toolName: 'bash',
      type: 'tool.started',
    });
    store.append({
      durationMs: 20,
      isError: false,
      result: '3 pass',
      toolCallId: 'tool-1',
      type: 'tool.completed',
    });
    store.append({
      type: 'turn.completed',
      usage: { ...EMPTY_USAGE },
    });

    expect(store.snapshot()).toMatchObject({
      messages: [
        { content: 'Fix tests', role: 'user' },
        { content: 'Done', role: 'assistant' },
      ],
      tools: [
        {
          durationMs: 20,
          isError: false,
          name: 'bash',
          status: 'completed',
          summary: 'bun test',
        },
      ],
    });
  });

  test('replaces conversation when native GUI opens a saved session', () => {
    const store = new GuiEventStore();
    store.append({ content: 'Current prompt', type: 'user.message' });
    store.append({ type: 'turn.started' });
    store.replaceMessages([
      { content: 'Saved prompt', role: 'user' },
      { content: 'Saved answer', role: 'assistant' },
    ]);

    expect(store.snapshot()).toMatchObject({
      messages: [
        { content: 'Saved prompt', role: 'user' },
        { content: 'Saved answer', role: 'assistant' },
      ],
      processing: false,
      tools: [],
    });
  });

  test('replaces subagent lifecycle state without changing the main turn', () => {
    const store = new GuiEventStore();
    store.append({ type: 'turn.started' });
    store.append({
      subagents: [{
        id: 'child-1',
        name: 'Atlas',
        task: 'Inspect auth',
        status: 'running',
        startedAt: 1,
      }],
      type: 'subagents.updated',
    });

    expect(store.snapshot()).toMatchObject({
      processing: true,
      subagents: [{ id: 'child-1', name: 'Atlas', status: 'running' }],
    });
  });
});
