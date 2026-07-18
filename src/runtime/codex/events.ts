import type { RuntimeEvent } from '../types';

type RecordValue = Record<string, unknown>;

export function translateCodexNotification(
  method: string,
  rawParams: unknown,
): RuntimeEvent[] {
  const params = asRecord(rawParams);
  switch (method) {
    case 'item/agentMessage/delta': {
      const delta = stringValue(params.delta);
      return [{ delta, text: delta, type: 'text_delta' }];
    }
    case 'item/reasoning/summaryTextDelta':
    case 'item/reasoning/textDelta': {
      const delta = stringValue(params.delta);
      return [{ content: delta, delta, type: 'thinking_delta' }];
    }
    case 'item/started':
      return startedItem(asRecord(params.item));
    case 'item/completed':
      return completedItem(asRecord(params.item));
    case 'item/commandExecution/outputDelta':
      return [{
        chunk: stringValue(params.delta),
        stream: params.stream === 'stderr' ? 'stderr' : 'stdout',
        type: 'command_output',
      }];
    case 'turn/diff/updated':
      return [{ diff: stringValue(params.diff), type: 'diff_updated' }];
    case 'turn/plan/updated':
      return [{ plan: params.plan, type: 'plan_updated' }];
    case 'thread/compacted':
      return [{ type: 'compaction' }];
    case 'warning':
    case 'configWarning':
      return [{ message: stringValue(params.message ?? params.summary), type: 'warning' }];
    case 'error': {
      const error = asRecord(params.error);
      return [{ message: stringValue(error.message), type: 'error' }];
    }
    default:
      return [];
  }
}

function startedItem(item: RecordValue): RuntimeEvent[] {
  const id = stringValue(item.id);
  const type = stringValue(item.type);
  if (type === 'commandExecution') {
    return [{
      args: { command: stringValue(item.command), cwd: stringValue(item.cwd) },
      toolCallId: id,
      toolName: type,
      type: 'tool_start',
    }];
  }
  if (type === 'fileChange') {
    return [{
      args: { changes: item.changes },
      toolCallId: id,
      toolName: type,
      type: 'tool_start',
    }];
  }
  if (type === 'mcpToolCall' || type === 'webSearch' || type === 'collabAgentToolCall') {
    return [{ args: item, toolCallId: id, toolName: type, type: 'tool_start' }];
  }
  return [];
}

function completedItem(item: RecordValue): RuntimeEvent[] {
  const id = stringValue(item.id);
  const type = stringValue(item.type);
  if (type === 'commandExecution') {
    const status = stringValue(item.status);
    return [{
      durationMs: numberValue(item.durationMs),
      isError: status === 'failed' || status === 'declined',
      result: {
        exitCode: item.exitCode ?? null,
        output: item.aggregatedOutput ?? '',
        status,
      },
      toolCallId: id,
      toolName: type,
      type: 'tool',
    }];
  }
  if (type === 'fileChange' || type === 'mcpToolCall' || type === 'webSearch' || type === 'collabAgentToolCall') {
    const status = stringValue(item.status);
    return [{
      durationMs: numberValue(item.durationMs),
      isError: status === 'failed' || status === 'declined',
      result: item,
      toolCallId: id,
      toolName: type,
      type: 'tool',
    }];
  }
  return [];
}

function asRecord(value: unknown): RecordValue {
  return typeof value === 'object' && value !== null
    ? value as RecordValue
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
