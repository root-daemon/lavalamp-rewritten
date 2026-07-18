export type RunStatus = 'active' | 'completed' | 'failed' | 'interrupted';
export type TurnStatus = 'active' | 'completed' | 'failed' | 'interrupted';
export type RunRating = 'helpful' | 'unhelpful';
export type AgentRole = 'main' | 'subagent';
export type ToolCategory =
  | 'read/search'
  | 'mutation'
  | 'shell'
  | 'validation/test'
  | 'planning/task'
  | 'delegation'
  | 'other';

export interface AnalyticsUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; total: number } | null;
}

export interface AnalyticsQuery {
  workspaceRoot?: string;
  scope: 'project' | 'global';
  range: 'session' | '7d' | '30d' | '90d' | 'all';
  runId?: string;
}

export interface AnalyticsReport {
  overview: {
    runs: number;
    turns: number;
    successfulTurns: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalCost: number;
    averageCostPerTurn: number | null;
    cachedTokenShare: number | null;
    tokensPerSuccessfulTurn: number | null;
  };
  trend: Array<{ date: string; tokens: number; cost: number; turns: number }>;
  models: Array<{
    provider: string;
    model: string;
    turns: number;
    tokens: number;
    cost: number;
  }>;
  tools: Array<{
    name: string;
    category: ToolCategory;
    calls: number;
    errors: number;
    averageDurationMs: number | null;
    p95DurationMs: number | null;
  }>;
  agents: Array<{
    role: AgentRole;
    turns: number;
    tokens: number;
    cost: number;
    failures: number;
  }>;
  performance: {
    medianTurnDurationMs: number | null;
    p95TurnDurationMs: number | null;
    medianTtftMs: number | null;
    p95TtftMs: number | null;
  };
  reliability: {
    failedTurns: number;
    turnFailureRate: number | null;
    toolErrors: number;
    toolErrorRate: number | null;
    permissionRequests: number;
    permissionDenials: number;
    permissionDenialRate: number | null;
    interruptions: number;
    compactions: number;
    subagentCompleted: number;
    subagentFailed: number;
    subagentTimedOut: number;
    subagentKilled: number;
    validationAttempts: number;
    validationSuccesses: number;
    directTurns: number;
    gatewayTurns: number;
  };
  outcomes: {
    completedRuns: number;
    failedRuns: number;
    interruptedRuns: number;
    helpful: number;
    unhelpful: number;
    helpfulRate: number | null;
  };
}
