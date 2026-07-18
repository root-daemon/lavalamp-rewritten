import type { AgentBackend } from './backend';

export type RuntimeMode = 'build' | 'ask' | 'plan';

export interface RuntimeEvent {
  type: string;
  text?: string;
  delta?: string;
  content?: string;
  toolName?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  durationMs?: number;
  message?: string;
  chunk?: string;
  stream?: 'stdout' | 'stderr';
  diff?: string;
  plan?: unknown;
  usage?: RuntimeUsage;
  [key: string]: unknown;
}

export interface RuntimeUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; total: number } | null;
}

export interface RuntimeResult {
  backend: AgentBackend;
  text: string;
  usage: RuntimeUsage;
  model: { provider: string; id: string };
  sessionId?: string;
  threadId?: string;
  turnId?: string;
}

export interface RuntimeCallbacks {
  onStarted?: () => void;
  onEvent?: (event: RuntimeEvent) => void;
  onResult?: (result: RuntimeResult) => void;
  onError?: (error: Error) => void;
}

export interface RuntimeModel {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  inputModalities: string[];
  supportedReasoningEfforts: string[];
}

export type RuntimeSubagentStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'stopped';

export interface RuntimeSubagent {
  id: string;
  parentId?: string;
  name: string;
  role?: string;
  task: string;
  status: RuntimeSubagentStatus;
  result?: string;
  error?: string;
  startedAt: number;
  model?: string;
}

export interface RuntimeSubagentMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface RuntimeSubagentInspection {
  subagent: RuntimeSubagent;
  messages: RuntimeSubagentMessage[];
}

export interface RuntimeInput {
  text: string;
  images?: string[];
}

export interface RuntimeSession {
  sessionId: string;
  threadId?: string;
  mode: RuntimeMode;
}

export interface OpenSessionOptions {
  sessionId: string;
  threadId?: string;
  mode: RuntimeMode;
}

export interface AgentRuntime {
  readonly backend: AgentBackend;
  start(): Promise<void>;
  openSession(options: OpenSessionOptions): Promise<RuntimeSession>;
  sendTurn(input: RuntimeInput, callbacks: RuntimeCallbacks): string;
  switchMode(mode: RuntimeMode): Promise<RuntimeSession>;
  compact(): Promise<void>;
  undoLastTurn(): Promise<RuntimeSession>;
  interrupt(): Promise<void>;
  listModels(): Promise<RuntimeModel[]>;
  shutdown(): Promise<void>;
}
