import { describe, expect, test } from 'bun:test';
import { CodexSubagentTracker } from '../src/runtime/codex/subagents.ts';

describe('Codex subagent tracker', () => {
  test('introduces child threads and maps active lifecycle state', () => {
    const tracker = new CodexSubagentTracker('root-1');

    tracker.observeThreadStarted({
      agentNickname: 'Atlas',
      agentRole: 'explorer',
      id: 'child-1',
      parentThreadId: 'root-1',
      status: { activeFlags: [], type: 'active' },
    });

    expect(tracker.list()).toEqual([
      expect.objectContaining({
        id: 'child-1',
        name: 'Atlas',
        parentId: 'root-1',
        role: 'explorer',
        status: 'running',
      }),
    ]);
  });

  test('enriches out-of-order collab calls and preserves terminal state', () => {
    const tracker = new CodexSubagentTracker('root-1');

    tracker.observeCollabItem({
      agentsStates: {
        'child-1': { message: 'Authentication scan complete', status: 'completed' },
      },
      id: 'collab-1',
      model: 'gpt-5.6-terra',
      prompt: 'Inspect authentication flows',
      receiverThreadIds: ['child-1'],
      senderThreadId: 'root-1',
      status: 'completed',
      tool: 'spawnAgent',
      type: 'collabAgentToolCall',
    });
    tracker.observeThreadStarted({
      agentNickname: null,
      agentRole: 'explorer',
      id: 'child-1',
      parentThreadId: 'root-1',
      status: { type: 'idle' },
    });
    tracker.observeThreadStatus('child-1', { type: 'notLoaded' });

    expect(tracker.list()[0]).toMatchObject({
      id: 'child-1',
      model: 'gpt-5.6-terra',
      result: 'Authentication scan complete',
      role: 'explorer',
      status: 'completed',
      task: 'Inspect authentication flows',
    });
  });

  test('accepts nested descendants and ignores unrelated or malformed threads', () => {
    const tracker = new CodexSubagentTracker('root-1');
    tracker.observeThreadStarted({
      id: 'child-1',
      parentThreadId: 'root-1',
      status: { type: 'active' },
    });
    tracker.observeThreadStarted({
      id: 'grandchild-1',
      parentThreadId: 'child-1',
      status: { type: 'active' },
    });
    tracker.observeThreadStarted({
      id: 'unrelated',
      parentThreadId: 'other-root',
      status: { type: 'active' },
    });
    tracker.observeThreadStarted({ parentThreadId: 'root-1' });

    expect(tracker.list().map((subagent) => subagent.id)).toEqual([
      'child-1',
      'grandchild-1',
    ]);
  });

  test('reopens a completed child when Codex resumes it', () => {
    const tracker = new CodexSubagentTracker('root-1');
    tracker.observeCollabItem({
      agentsStates: { 'child-1': { status: 'completed', message: 'First pass' } },
      receiverThreadIds: ['child-1'],
      senderThreadId: 'root-1',
      status: 'completed',
      tool: 'wait',
      type: 'collabAgentToolCall',
    });
    tracker.observeCollabItem({
      agentsStates: { 'child-1': { status: 'running', message: null } },
      receiverThreadIds: ['child-1'],
      senderThreadId: 'root-1',
      status: 'completed',
      tool: 'resumeAgent',
      type: 'collabAgentToolCall',
    });

    expect(tracker.get('child-1')?.status).toBe('running');
  });

  test('does not treat a completed spawn call as a completed child', () => {
    const tracker = new CodexSubagentTracker('root-1');
    tracker.observeCollabItem({
      receiverThreadIds: ['child-1'],
      senderThreadId: 'root-1',
      status: 'completed',
      tool: 'spawnAgent',
      type: 'collabAgentToolCall',
    });

    expect(tracker.get('child-1')?.status).toBe('pending');
  });
});
