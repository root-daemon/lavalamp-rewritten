import { describe, expect, test } from 'bun:test';
import {
  inspectFlueSubagent,
  projectFlueSubagent,
} from '../src/tui/subs.ts';

describe('Flue subagent projection', () => {
  test('maps manager lifecycle states into the runtime contract', () => {
    expect(projectFlueSubagent({
      id: 'sub-1',
      query: 'scan auth',
      result: 'No regressions',
      startTime: 1,
      status: 'done',
    })).toEqual({
      id: 'sub-1',
      name: 'sub-1',
      result: 'No regressions',
      startedAt: 1,
      status: 'completed',
      task: 'scan auth',
    });

    expect(projectFlueSubagent({
      error: 'deadline exceeded',
      id: 'sub-2',
      query: 'scan data',
      startTime: 2,
      status: 'timed_out',
    })).toMatchObject({ error: 'deadline exceeded', status: 'failed' });
  });

  test('builds a read-only inspection from captured query and result', () => {
    expect(inspectFlueSubagent({
      id: 'sub-1',
      query: 'scan auth',
      result: 'No regressions',
      startTime: 1,
      status: 'done',
    })).toEqual({
      messages: [
        { content: 'scan auth', role: 'user' },
        { content: 'No regressions', role: 'assistant' },
      ],
      subagent: expect.objectContaining({ id: 'sub-1', status: 'completed' }),
    });
  });
});
