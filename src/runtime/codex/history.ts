import type { Message, ToolCall } from '../../tui/state';

export function reconstructCodexMessages(thread: unknown): Message[] {
  const turns = readArray(readRecord(thread)?.turns);
  const messages: Message[] = [];

  for (const turn of turns) {
    const items = readArray(readRecord(turn)?.items);
    let assistantText = '';
    let assistantId: string | undefined;
    const thinking: string[] = [];
    const toolCalls: ToolCall[] = [];

    for (const value of items) {
      const item = readRecord(value);
      if (item === undefined || typeof item.type !== 'string') {
        continue;
      }
      const id = typeof item.id === 'string' ? item.id : crypto.randomUUID();
      if (item.type === 'userMessage') {
        const content = readArray(item.content)
          .map((part) => readRecord(part))
          .filter((part): part is Record<string, unknown> => part !== undefined)
          .filter((part) => part.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text as string)
          .join('\n');
        messages.push({ id, role: 'user', content, timestamp: Date.now() });
        continue;
      }
      if (item.type === 'agentMessage' && typeof item.text === 'string') {
        assistantId = id;
        assistantText += item.text;
        continue;
      }
      if (item.type === 'reasoning') {
        const summary = readArray(item.summary).filter(
          (entry): entry is string => typeof entry === 'string',
        );
        thinking.push(...summary);
        continue;
      }
      const toolCall = itemToToolCall(item, id);
      if (toolCall !== undefined) {
        toolCalls.push(toolCall);
      }
    }

    if (assistantText !== '' || thinking.length > 0 || toolCalls.length > 0) {
      messages.push({
        id: assistantId ?? `assistant_${readRecord(turn)?.id ?? crypto.randomUUID()}`,
        role: 'assistant',
        content: assistantText,
        ...(thinking.length > 0 ? { thinking: thinking.join('\n') } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        timestamp: Date.now(),
      });
    }
  }

  return messages;
}

function itemToToolCall(item: Record<string, unknown>, id: string): ToolCall | undefined {
  if (item.type === 'commandExecution') {
    return {
      id,
      name: 'commandExecution',
      args: {
        command: item.command,
        cwd: item.cwd,
      },
      result: {
        status: item.status,
        output: item.aggregatedOutput,
        exitCode: item.exitCode,
      },
      isError: item.status === 'failed' || item.status === 'declined',
      ...(typeof item.durationMs === 'number' ? { durationMs: item.durationMs } : {}),
    };
  }
  if (item.type === 'fileChange' || item.type === 'mcpToolCall' || item.type === 'webSearch') {
    return {
      id,
      name: item.type,
      args: item,
      result: item,
      isError: item.status === 'failed' || item.status === 'declined',
    };
  }
  return undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
