import { describe, expect, test } from 'bun:test';
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
});
