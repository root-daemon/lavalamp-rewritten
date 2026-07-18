import type { FlueEvent } from '../tui/ipc';

export interface GuiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

export type GuiPermissionDecision = 'allow' | 'always_allow' | 'deny';

export type GuiEventInput =
  | { type: 'host.ready'; workspace: string; model?: string }
  | { type: 'turn.started' }
  | { type: 'text.delta'; delta: string }
  | { type: 'thinking.delta'; delta: string }
  | { type: 'runtime.event'; event: FlueEvent }
  | {
      type: 'tool.started';
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | {
      type: 'tool.completed';
      toolCallId: string;
      result?: unknown;
      isError: boolean;
      durationMs?: number;
    }
  | { type: 'terminal.output'; chunk: string; stream: 'stdout' | 'stderr' }
  | {
      type: 'permission.requested';
      requestId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | {
      type: 'permission.resolved';
      requestId: string;
      decision: GuiPermissionDecision;
    }
  | { type: 'question.requested'; requestId: string; questions: unknown[] }
  | { type: 'question.resolved'; requestId: string }
  | { type: 'turn.completed'; usage: GuiUsage; model?: string; provider?: string }
  | { type: 'turn.failed'; message: string }
  | { type: 'turn.cancelled' };

export type GuiEvent = GuiEventInput & {
  id: number;
  timestamp: number;
};

export interface PendingPermission {
  requestId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface PendingQuestion {
  requestId: string;
  questions: unknown[];
}

export interface GuiSnapshot {
  cursor: number;
  processing: boolean;
  assistantText: string;
  thinkingText: string;
  terminalOutput: string;
  workspace?: string;
  model?: string;
  provider?: string;
  error?: string;
  pendingPermission?: PendingPermission;
  pendingQuestion?: PendingQuestion;
  usage: GuiUsage;
}

export interface GuiApiError {
  code: string;
  message: string;
}

export type GuiApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: GuiApiError };

export const EMPTY_USAGE: GuiUsage = {
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  input: 0,
  output: 0,
  totalTokens: 0,
};
