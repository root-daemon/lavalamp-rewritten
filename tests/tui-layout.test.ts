import { describe, expect, test } from 'bun:test';
import { INPUT_STACK_ORDER, orderedInputStack } from '../src/tui/input-stack.ts';
import { formatSubagentInspection } from '../src/tui/subagent-inspection.ts';
import { HELP_COMMANDS } from '../src/tui/slash-data.ts';
import { stopFirstRunningSubagent } from '../src/tui/events/Keybindings.ts';

describe('TUI input stack layout', () => {
  test('completion is mounted directly above the input separator and row', () => {
    expect(INPUT_STACK_ORDER).toEqual([
      'confirmBox',
      'permissionBox',
      'completionBox',
      'inputSeparatorTop',
      'inputRow',
    ]);
  });

  test('ordered input stack returns completion adjacent to the input row', () => {
    const stack = orderedInputStack({
      completionBox: 'completion',
      confirmBox: 'confirm',
      inputRow: 'input',
      inputSeparatorTop: 'separator',
      permissionBox: 'permission',
    });

    expect(stack).toEqual([
      'confirm',
      'permission',
      'completion',
      'separator',
      'input',
    ]);
  });
});

describe('TUI subagent inspection', () => {
  test('formats a read-only child transcript without tool noise', () => {
    const content = formatSubagentInspection({
      messages: [
        { role: 'user', content: 'Inspect auth' },
        { role: 'assistant', content: 'No regression found.' },
      ],
      subagent: {
        id: 'child-1',
        name: 'Atlas',
        role: 'explorer',
        task: 'Inspect auth',
        status: 'completed',
        startedAt: 1,
      },
    });

    expect(content).toContain('# Atlas');
    expect(content).toContain('Status: completed');
    expect(content).toContain('## User\n\nInspect auth');
    expect(content).toContain('## Assistant\n\nNo regression found.');
  });

  test('advertises subagent inspection in slash help', () => {
    expect(HELP_COMMANDS).toContainEqual([
      '/subagents',
      'List or inspect subagents',
    ]);
  });

  test('stops a running subagent through the runtime callback', () => {
    const stopped: string[] = [];
    const handled = stopFirstRunningSubagent(
      [{ id: 'child-1', status: 'running' }],
      (id) => { stopped.push(id); },
    );

    expect(stopped).toEqual(['child-1']);
    expect(handled).toBe(true);
  });
});
