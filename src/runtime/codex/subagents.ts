import type {
  RuntimeSubagent,
  RuntimeSubagentStatus,
} from '../types';

type RecordValue = Record<string, unknown>;

const TERMINAL_STATUSES = new Set<RuntimeSubagentStatus>([
  'completed',
  'failed',
  'interrupted',
  'stopped',
]);

export class CodexSubagentTracker {
  private readonly subagents = new Map<string, RuntimeSubagent>();

  constructor(
    private rootThreadId?: string,
    private readonly onChange?: (subagents: RuntimeSubagent[]) => void,
  ) {}

  setRootThreadId(threadId: string | undefined): void {
    this.rootThreadId = threadId;
  }

  observeThreadStarted(rawThread: unknown): void {
    const thread = asRecord(rawThread);
    const id = stringValue(thread.id);
    const parentId = stringValue(thread.parentThreadId);
    if (
      id === undefined ||
      parentId === undefined ||
      (parentId !== this.rootThreadId && !this.subagents.has(parentId))
    ) {
      return;
    }
    const existing = this.subagents.get(id);
    const role = stringValue(thread.agentRole) ?? existing?.role;
    const next: RuntimeSubagent = {
      id,
      name: stringValue(thread.agentNickname) ?? existing?.name ?? role ?? shortName(id),
      parentId,
      role,
      task: existing?.task ?? stringValue(thread.preview) ?? '',
      status: mergeStatus(existing?.status, threadStatus(thread.status)),
      startedAt: existing?.startedAt ?? timestampValue(thread.createdAt),
      ...(existing?.model === undefined ? {} : { model: existing.model }),
      ...(existing?.result === undefined ? {} : { result: existing.result }),
      ...(existing?.error === undefined ? {} : { error: existing.error }),
    };
    this.subagents.set(id, next);
    this.emit();
  }

  observeThreadStatus(threadId: string, rawStatus: unknown): void {
    const existing = this.subagents.get(threadId);
    if (existing === undefined) {
      return;
    }
    this.subagents.set(threadId, {
      ...existing,
      status: mergeStatus(existing.status, threadStatus(rawStatus)),
    });
    this.emit();
  }

  observeCollabItem(rawItem: unknown): void {
    const item = asRecord(rawItem);
    if (
      item.type !== 'collabAgentToolCall' ||
      (stringValue(item.senderThreadId) !== this.rootThreadId &&
        !this.subagents.has(stringValue(item.senderThreadId) ?? ''))
    ) {
      return;
    }
    const receiverIds = Array.isArray(item.receiverThreadIds)
      ? item.receiverThreadIds.flatMap((value) => {
          const id = stringValue(value);
          return id === undefined ? [] : [id];
        })
      : [];
    const states = asRecord(item.agentsStates);
    let changed = false;
    for (const id of receiverIds) {
      const existing = this.subagents.get(id);
      const state = asRecord(states[id]);
      const stateStatus = collabStatus(state.status);
      const message = stringValue(state.message);
      const nextStatus = stateStatus ?? toolStatus(item.status);
      const status = nextStatus === 'pending' || nextStatus === 'running'
        ? nextStatus
        : mergeStatus(existing?.status, nextStatus);
      const isFailure = status === 'failed';
      this.subagents.set(id, {
        id,
        name: existing?.name ?? shortName(id),
        parentId: existing?.parentId ?? stringValue(item.senderThreadId),
        role: existing?.role,
        task: stringValue(item.prompt) ?? existing?.task ?? '',
        status,
        startedAt: existing?.startedAt ?? Date.now(),
        model: stringValue(item.model) ?? existing?.model,
        result: isFailure ? existing?.result : message ?? existing?.result,
        error: isFailure ? message ?? existing?.error : existing?.error,
      });
      changed = true;
    }
    if (changed) {
      this.emit();
    }
  }

  get(id: string): RuntimeSubagent | undefined {
    const value = this.subagents.get(id);
    return value === undefined ? undefined : { ...value };
  }

  list(): RuntimeSubagent[] {
    return [...this.subagents.values()].map((subagent) => ({ ...subagent }));
  }

  clear(): void {
    if (this.subagents.size === 0) {
      return;
    }
    this.subagents.clear();
    this.emit();
  }

  markInterrupted(id: string): void {
    const existing = this.subagents.get(id);
    if (existing === undefined || TERMINAL_STATUSES.has(existing.status)) {
      return;
    }
    this.subagents.set(id, { ...existing, status: 'interrupted' });
    this.emit();
  }

  private emit(): void {
    this.onChange?.(this.list());
  }
}

function mergeStatus(
  current: RuntimeSubagentStatus | undefined,
  next: RuntimeSubagentStatus | undefined,
): RuntimeSubagentStatus {
  if (current !== undefined && TERMINAL_STATUSES.has(current)) {
    return current;
  }
  return next ?? current ?? 'pending';
}

function threadStatus(value: unknown): RuntimeSubagentStatus | undefined {
  const type = stringValue(asRecord(value).type);
  switch (type) {
    case 'active': return 'running';
    case 'idle': return 'completed';
    case 'systemError': return 'failed';
    case 'notLoaded': return 'stopped';
    default: return undefined;
  }
}

function collabStatus(value: unknown): RuntimeSubagentStatus | undefined {
  switch (stringValue(value)) {
    case 'pendingInit': return 'pending';
    case 'running': return 'running';
    case 'interrupted': return 'interrupted';
    case 'completed': return 'completed';
    case 'errored': return 'failed';
    case 'shutdown':
    case 'notFound': return 'stopped';
    default: return undefined;
  }
}

function toolStatus(value: unknown): RuntimeSubagentStatus | undefined {
  switch (stringValue(value)) {
    case 'inProgress': return 'running';
    case 'failed': return 'failed';
    default: return undefined;
  }
}

function asRecord(value: unknown): RecordValue {
  return typeof value === 'object' && value !== null
    ? value as RecordValue
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function timestampValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? value * 1_000
    : Date.now();
}

function shortName(id: string): string {
  return `agent-${id.slice(0, 8)}`;
}
