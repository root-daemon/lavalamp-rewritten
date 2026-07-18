import {
  EMPTY_USAGE,
  type GuiEvent,
  type GuiEventInput,
  type GuiSnapshot,
} from './contracts';

export class GuiEventStore {
  private readonly maxEvents: number;
  private events: GuiEvent[] = [];
  private nextId = 1;
  private current: GuiSnapshot = {
    assistantText: '',
    cursor: 0,
    processing: false,
    messages: [],
    terminalOutput: '',
    thinkingText: '',
    tools: [],
    usage: { ...EMPTY_USAGE },
  };

  constructor(options: { maxEvents?: number } = {}) {
    this.maxEvents = Math.max(1, options.maxEvents ?? 2_000);
  }

  append(input: GuiEventInput): GuiEvent {
    const event = {
      ...input,
      id: this.nextId++,
      timestamp: Date.now(),
    } as GuiEvent;
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }
    this.reduce(event);
    return event;
  }

  after(cursor: number): GuiEvent[] {
    return this.events.filter((event) => event.id > cursor);
  }

  snapshot(): GuiSnapshot {
    return structuredClone(this.current);
  }

  replaceMessages(messages: GuiSnapshot['messages']): void {
    this.current = {
      ...this.current,
      assistantText: '',
      error: undefined,
      messages: messages.slice(-80),
      processing: false,
      terminalOutput: '',
      thinkingText: '',
      tools: [],
    };
  }

  resetTurn(): void {
    this.current = {
      ...this.current,
      assistantText: '',
      error: undefined,
      processing: false,
      terminalOutput: '',
      thinkingText: '',
    };
  }

  private reduce(event: GuiEvent): void {
    this.current = { ...this.current, cursor: event.id };
    switch (event.type) {
      case 'host.ready':
        this.current = {
          ...this.current,
          backend: event.backend,
          mode: event.mode,
          workspace: event.workspace,
          model: event.model,
        };
        break;
      case 'backend.changed':
        this.current = {
          ...this.current,
          backend: event.backend,
          mode: event.mode,
          model: event.model,
        };
        break;
      case 'mode.changed':
        this.current = { ...this.current, mode: event.mode };
        break;
      case 'model.changed':
        this.current = { ...this.current, model: event.model };
        break;
      case 'notice':
        this.current = { ...this.current, error: undefined };
        break;
      case 'user.message':
        this.current = {
          ...this.current,
          messages: [
            ...this.current.messages,
            { content: event.content, role: 'user' as const },
          ].slice(-80),
        };
        break;
      case 'turn.started':
        this.current = {
          ...this.current,
          assistantText: '',
          error: undefined,
          processing: true,
          terminalOutput: '',
          thinkingText: '',
        };
        break;
      case 'text.delta':
        this.current = {
          ...this.current,
          assistantText: this.current.assistantText + event.delta,
        };
        break;
      case 'thinking.delta':
        this.current = {
          ...this.current,
          thinkingText: this.current.thinkingText + event.delta,
        };
        break;
      case 'terminal.output':
        this.current = {
          ...this.current,
          terminalOutput: (this.current.terminalOutput + event.chunk).slice(-80_000),
        };
        break;
      case 'tool.started':
        this.current = {
          ...this.current,
          tools: [
            ...this.current.tools,
            {
              id: event.toolCallId,
              isError: false,
              name: event.toolName,
              status: 'running' as const,
              summary: summarizeArgs(event.args),
            },
          ].slice(-30),
        };
        break;
      case 'tool.completed':
        this.current = {
          ...this.current,
          tools: this.current.tools.map((tool) =>
            tool.id === event.toolCallId
              ? {
                  ...tool,
                  durationMs: event.durationMs,
                  isError: event.isError,
                  status: event.isError ? ('failed' as const) : ('completed' as const),
                }
              : tool,
          ),
        };
        break;
      case 'permission.requested':
        this.current = {
          ...this.current,
          pendingPermission: {
            args: event.args,
            requestId: event.requestId,
            toolName: event.toolName,
          },
        };
        break;
      case 'permission.resolved':
        if (this.current.pendingPermission?.requestId === event.requestId) {
          this.current = { ...this.current, pendingPermission: undefined };
        }
        break;
      case 'question.requested':
        this.current = {
          ...this.current,
          pendingQuestion: {
            questions: event.questions,
            requestId: event.requestId,
          },
        };
        break;
      case 'question.resolved':
        if (this.current.pendingQuestion?.requestId === event.requestId) {
          this.current = { ...this.current, pendingQuestion: undefined };
        }
        break;
      case 'turn.completed':
        this.current = {
          ...this.current,
          messages:
            this.current.assistantText.length > 0
              ? [
                  ...this.current.messages,
                  { content: this.current.assistantText, role: 'assistant' as const },
                ].slice(-80)
              : this.current.messages,
          backend: event.backend ?? this.current.backend,
          model: event.model ?? this.current.model,
          processing: false,
          provider: event.provider,
          usage: event.usage,
        };
        break;
      case 'turn.failed':
        this.current = {
          ...this.current,
          error: event.message,
          processing: false,
        };
        break;
      case 'turn.cancelled':
        this.current = { ...this.current, processing: false };
        break;
      default:
        break;
    }
  }

  resetConversation(): void {
    this.current = {
      ...this.current,
      assistantText: '',
      error: undefined,
      messages: [],
      pendingPermission: undefined,
      pendingQuestion: undefined,
      processing: false,
      terminalOutput: '',
      thinkingText: '',
      tools: [],
      usage: { ...EMPTY_USAGE },
    };
  }

  compactMessages(): void {
    const half = Math.ceil(this.current.messages.length / 2);
    this.current = {
      ...this.current,
      messages: this.current.messages.slice(half),
      thinkingText: '',
      terminalOutput: '',
    };
  }

  undoLastTurn(): void {
    const next = [...this.current.messages];
    for (let i = 0; i < 2 && next.length > 0; i++) {
      next.pop();
    }
    this.current = {
      ...this.current,
      assistantText: '',
      error: undefined,
      messages: next,
      processing: false,
      thinkingText: '',
      tools: [],
    };
  }
}

function summarizeArgs(args: Record<string, unknown>): string {
  for (const key of ['cmd', 'path', 'query', 'url', 'filePath']) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) {
      return value.slice(0, 240);
    }
  }
  const keys = Object.keys(args);
  return keys.length === 0 ? 'No arguments' : keys.slice(0, 4).join(', ');
}
