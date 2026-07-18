import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Database } from 'bun:sqlite';
import { analyticsPath, workspaceHash } from '../storage/paths';
import type {
  AgentRole,
  AnalyticsQuery,
  AnalyticsReport,
  AnalyticsUsage,
  RunRating,
  RunStatus,
  ToolCategory,
  TurnStatus,
} from './types';

type Row = Record<string, string | number | null>;

function now(): number {
  return Date.now();
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  if (p >= 95 && values.length < 2) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)] ?? null;
}

function number(row: Row | undefined, key: string): number {
  const value = row?.[key];
  return typeof value === 'number' ? value : Number(value ?? 0);
}

export function categorizeTool(
  name: string,
  args?: Record<string, unknown>,
): ToolCategory {
  if (name === 'bash') {
    const command =
      typeof args?.command === 'string'
        ? args.command
        : typeof args?.cmd === 'string'
          ? args.cmd
          : '';
    return /(^|\s)(bun test|pytest|go test|cargo test|npm test|pnpm test|yarn test|tsc|eslint|oxlint|biome|ruff|mypy)(\s|$)/.test(
      command,
    )
      ? 'validation/test'
      : 'shell';
  }
  if (/^(read|grep|glob|ripgrep|codebase_|fetch_url|deepwiki|lsp)/.test(name)) {
    return 'read/search';
  }
  if (/^(write|edit|patch|rename|undo)/.test(name)) return 'mutation';
  if (/(test|typecheck|lint|validate|check)/.test(name))
    return 'validation/test';
  if (/_task$/.test(name) || name === 'list_tasks') return 'planning/task';
  if (name === 'deploy_parallel_subs' || name === 'query_expert') {
    return 'delegation';
  }
  return 'other';
}

export class AnalyticsStore {
  private readonly db: Database;

  constructor(dbPath = analyticsPath()) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.run('PRAGMA busy_timeout = 5000');
    this.db.run('PRAGMA journal_mode = WAL');
    this.migrate();
    this.recoverAbandonedRuns();
  }

  close(): void {
    this.db.close();
  }

  createRun(input: {
    workspaceRoot: string;
    mode: string;
    agent: string;
    conversationSessionId?: string;
  }): string {
    const id = randomUUID();
    this.db
      .query(`INSERT INTO analytics_runs (
      id, conversation_session_id, workspace_id, workspace_name, mode, agent,
      started_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`)
      .run(
        id,
        input.conversationSessionId ?? null,
        workspaceHash(input.workspaceRoot),
        path.basename(path.resolve(input.workspaceRoot)) || 'workspace',
        input.mode,
        input.agent,
        now(),
      );
    return id;
  }

  finishRun(id: string, status: Exclude<RunStatus, 'active'>): void {
    this.db
      .query(`UPDATE analytics_runs SET status = ?, ended_at = ? WHERE id = ?`)
      .run(status, now(), id);
    this.db
      .query(`DELETE FROM analytics_runs WHERE id = ? AND rating IS NULL
      AND NOT EXISTS (SELECT 1 FROM analytics_turns WHERE run_id = ?)
      AND NOT EXISTS (SELECT 1 FROM analytics_events WHERE run_id = ?)`)
      .run(id, id, id);
  }

  rateRun(id: string, rating: RunRating): void {
    this.db
      .query(`UPDATE analytics_runs SET rating = ? WHERE id = ?`)
      .run(rating, id);
  }

  startTurn(input: {
    runId: string;
    role?: AgentRole;
    parentTurnId?: string;
  }): string {
    const id = randomUUID();
    const sequence =
      number(
        this.db
          .query(
            `SELECT COUNT(*) AS count FROM analytics_turns WHERE run_id = ?`,
          )
          .get(input.runId) as Row,
        'count',
      ) + 1;
    this.db
      .query(`INSERT INTO analytics_turns (
      id, run_id, parent_turn_id, sequence, agent_role, started_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, 'active')`)
      .run(
        id,
        input.runId,
        input.parentTurnId ?? null,
        sequence,
        input.role ?? 'main',
        now(),
      );
    return id;
  }

  markFirstResponse(turnId: string): void {
    this.db
      .query(`UPDATE analytics_turns
      SET ttft_ms = COALESCE(ttft_ms, ? - started_at)
      WHERE id = ?`)
      .run(now(), turnId);
  }

  finishTurn(
    id: string,
    status: Exclude<TurnStatus, 'active'>,
    result?: {
      usage?: AnalyticsUsage;
      model?: { provider: string; id: string };
      stopReason?: string;
      routeMode?: 'direct' | 'gateway';
    },
  ): void {
    const usage = result?.usage;
    this.db
      .query(`UPDATE analytics_turns SET
      ended_at = ?, duration_ms = ? - started_at, status = ?, provider = ?,
      model = ?, route_mode = ?, stop_reason = ?, input_tokens = ?,
      output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?,
      total_tokens = ?, cost_input = ?, cost_output = ?, cost_total = ?
      WHERE id = ?`)
      .run(
        now(),
        now(),
        status,
        result?.model?.provider ?? null,
        result?.model?.id ?? null,
        result?.routeMode ?? null,
        result?.stopReason ?? null,
        usage?.input ?? 0,
        usage?.output ?? 0,
        usage?.cacheRead ?? 0,
        usage?.cacheWrite ?? 0,
        usage?.totalTokens ?? 0,
        usage?.cost?.input ?? 0,
        usage?.cost?.output ?? 0,
        usage?.cost?.total ?? 0,
        id,
      );
  }

  recordTool(input: {
    turnId: string;
    toolCallId?: string;
    name: string;
    category?: ToolCategory;
    startedAt?: number;
    durationMs?: number;
    isError?: boolean;
  }): void {
    this.db
      .query(`INSERT INTO analytics_tool_calls (
      id, turn_id, tool_call_id, name, category, started_at, duration_ms, is_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        randomUUID(),
        input.turnId,
        input.toolCallId ?? null,
        input.name,
        input.category ?? categorizeTool(input.name),
        input.startedAt ?? now(),
        input.durationMs ?? null,
        input.isError ? 1 : 0,
      );
  }

  recordEvent(input: {
    runId: string;
    turnId?: string;
    type: string;
    outcome?: string;
  }): void {
    this.db
      .query(`INSERT INTO analytics_events (
      id, run_id, turn_id, type, outcome, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(
        randomUUID(),
        input.runId,
        input.turnId ?? null,
        input.type,
        input.outcome ?? null,
        now(),
      );
  }

  getRunUsage(runId: string): AnalyticsUsage & { costTotal: number } {
    const row = this.db
      .query(`SELECT
      COALESCE(SUM(input_tokens), 0) input,
      COALESCE(SUM(output_tokens), 0) output,
      COALESCE(SUM(cache_read_tokens), 0) cache_read,
      COALESCE(SUM(cache_write_tokens), 0) cache_write,
      COALESCE(SUM(total_tokens), 0) total_tokens,
      COALESCE(SUM(cost_total), 0) cost_total
      FROM analytics_turns WHERE run_id = ? AND status = 'completed'`)
      .get(runId) as Row;
    return {
      input: number(row, 'input'),
      output: number(row, 'output'),
      cacheRead: number(row, 'cache_read'),
      cacheWrite: number(row, 'cache_write'),
      totalTokens: number(row, 'total_tokens'),
      costTotal: number(row, 'cost_total'),
      cost: { input: 0, output: 0, total: number(row, 'cost_total') },
    };
  }

  getConversationUsage(
    conversationSessionId: string,
  ): AnalyticsUsage & { costTotal: number } {
    const row = this.db
      .query(`SELECT
      COALESCE(SUM(t.input_tokens), 0) input,
      COALESCE(SUM(t.output_tokens), 0) output,
      COALESCE(SUM(t.cache_read_tokens), 0) cache_read,
      COALESCE(SUM(t.cache_write_tokens), 0) cache_write,
      COALESCE(SUM(t.total_tokens), 0) total_tokens,
      COALESCE(SUM(t.cost_total), 0) cost_total
      FROM analytics_turns t JOIN analytics_runs r ON r.id = t.run_id
      WHERE r.conversation_session_id = ? AND t.status = 'completed'`)
      .get(conversationSessionId) as Row;
    return {
      input: number(row, 'input'),
      output: number(row, 'output'),
      cacheRead: number(row, 'cache_read'),
      cacheWrite: number(row, 'cache_write'),
      totalTokens: number(row, 'total_tokens'),
      costTotal: number(row, 'cost_total'),
      cost: { input: 0, output: 0, total: number(row, 'cost_total') },
    };
  }

  report(query: AnalyticsQuery): AnalyticsReport {
    const where = this.where(query);
    const turnWhere = `t.started_at >= ?${where.workspaceClause}${where.runClause}`;
    const runWhere = `r.started_at >= ?${where.workspaceClause}${where.runClause.replace('t.run_id', 'r.id')}`;
    const args = where.args;
    const overviewRow = this.db
      .query(`SELECT COUNT(DISTINCT t.run_id) runs,
      COUNT(*) turns, SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) successful_turns,
      SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END) failed_turns,
      COALESCE(SUM(t.total_tokens), 0) total_tokens,
      COALESCE(SUM(t.input_tokens), 0) input_tokens,
      COALESCE(SUM(t.output_tokens), 0) output_tokens,
      COALESCE(SUM(t.cache_read_tokens), 0) cache_read_tokens,
      COALESCE(SUM(t.cache_write_tokens), 0) cache_write_tokens,
      COALESCE(SUM(t.cost_total), 0) total_cost
      FROM analytics_turns t JOIN analytics_runs r ON r.id = t.run_id
      WHERE ${turnWhere} AND t.status != 'active'`)
      .get(...args) as Row;
    const turns = number(overviewRow, 'turns');
    const successfulTurns = number(overviewRow, 'successful_turns');
    const totalTokens = number(overviewRow, 'total_tokens');
    const cacheRead = number(overviewRow, 'cache_read_tokens');
    const input = number(overviewRow, 'input_tokens');
    const totalCost = number(overviewRow, 'total_cost');

    const turnRows = this.db
      .query(`SELECT duration_ms, ttft_ms FROM analytics_turns t
      JOIN analytics_runs r ON r.id = t.run_id WHERE ${turnWhere} AND t.status != 'active'`)
      .all(...args) as Row[];
    const durations = turnRows
      .map((r) => number(r, 'duration_ms'))
      .filter((v) => v >= 0);
    const ttfts = turnRows
      .map((r) => number(r, 'ttft_ms'))
      .filter((v) => v > 0);

    const toolRows = this.db
      .query(`SELECT tc.name, tc.category, COUNT(*) calls,
      SUM(tc.is_error) errors, AVG(tc.duration_ms) avg_duration
      FROM analytics_tool_calls tc JOIN analytics_turns t ON t.id = tc.turn_id
      JOIN analytics_runs r ON r.id = t.run_id WHERE ${turnWhere}
      GROUP BY tc.name, tc.category ORDER BY calls DESC, tc.name LIMIT 10`)
      .all(...args) as Row[];
    const toolDurations = this.db
      .query(`SELECT tc.name, tc.duration_ms FROM analytics_tool_calls tc
      JOIN analytics_turns t ON t.id = tc.turn_id JOIN analytics_runs r ON r.id = t.run_id
      WHERE ${turnWhere} AND tc.duration_ms IS NOT NULL`)
      .all(...args) as Row[];

    const eventRows = this.db
      .query(`SELECT e.type, e.outcome, COUNT(*) count
      FROM analytics_events e JOIN analytics_runs r ON r.id = e.run_id
      WHERE ${runWhere} GROUP BY e.type, e.outcome`)
      .all(...args) as Row[];
    const eventCount = (type: string, outcome?: string) =>
      eventRows
        .filter(
          (r) =>
            r.type === type && (outcome === undefined || r.outcome === outcome),
        )
        .reduce((sum, r) => sum + number(r, 'count'), 0);

    const runRows = this.db
      .query(`SELECT status, rating, COUNT(*) count FROM analytics_runs r
      WHERE ${runWhere} GROUP BY status, rating`)
      .all(...args) as Row[];
    const runCount = (status?: string, rating?: string) =>
      runRows
        .filter(
          (r) =>
            (status === undefined || r.status === status) &&
            (rating === undefined || r.rating === rating),
        )
        .reduce((sum, r) => sum + number(r, 'count'), 0);

    const toolTotals = this.db
      .query(`SELECT COUNT(*) calls, COALESCE(SUM(tc.is_error), 0) errors,
      SUM(CASE WHEN tc.category = 'validation/test' THEN 1 ELSE 0 END) validation_attempts,
      SUM(CASE WHEN tc.category = 'validation/test' AND tc.is_error = 0 THEN 1 ELSE 0 END) validation_successes
      FROM analytics_tool_calls tc JOIN analytics_turns t ON t.id = tc.turn_id
      JOIN analytics_runs r ON r.id = t.run_id WHERE ${turnWhere}`)
      .get(...args) as Row;
    const toolCalls = number(toolTotals, 'calls');
    const toolErrors = number(toolTotals, 'errors');
    const failedTurns = number(overviewRow, 'failed_turns');
    const permissionRequests = eventCount('permission');
    const permissionDenials = eventCount('permission', 'denied');
    const helpful = runCount(undefined, 'helpful');
    const unhelpful = runCount(undefined, 'unhelpful');

    return {
      overview: {
        runs: number(overviewRow, 'runs'),
        turns,
        successfulTurns,
        totalTokens,
        inputTokens: input,
        outputTokens: number(overviewRow, 'output_tokens'),
        cacheReadTokens: cacheRead,
        cacheWriteTokens: number(overviewRow, 'cache_write_tokens'),
        totalCost,
        averageCostPerTurn: turns > 0 ? totalCost / turns : null,
        cachedTokenShare: ratio(cacheRead, input + cacheRead),
        tokensPerSuccessfulTurn:
          successfulTurns > 0 ? totalTokens / successfulTurns : null,
      },
      trend: (
        this.db
          .query(`SELECT strftime('%Y-%m-%d', t.started_at / 1000, 'unixepoch', 'localtime') date,
        SUM(t.total_tokens) tokens, SUM(t.cost_total) cost, COUNT(*) turns
        FROM analytics_turns t JOIN analytics_runs r ON r.id = t.run_id WHERE ${turnWhere}
        GROUP BY date ORDER BY date`)
          .all(...args) as Row[]
      ).map((r) => ({
        date: String(r.date),
        tokens: number(r, 'tokens'),
        cost: number(r, 'cost'),
        turns: number(r, 'turns'),
      })),
      models: (
        this.db
          .query(`SELECT COALESCE(t.provider, 'unknown') provider,
        COALESCE(t.model, 'unknown') model, COUNT(*) turns, SUM(t.total_tokens) tokens,
        SUM(t.cost_total) cost FROM analytics_turns t JOIN analytics_runs r ON r.id = t.run_id
        WHERE ${turnWhere} GROUP BY provider, model ORDER BY cost DESC, tokens DESC`)
          .all(...args) as Row[]
      ).map((r) => ({
        provider: String(r.provider),
        model: String(r.model),
        turns: number(r, 'turns'),
        tokens: number(r, 'tokens'),
        cost: number(r, 'cost'),
      })),
      tools: toolRows.map((r) => {
        const values = toolDurations
          .filter((d) => d.name === r.name)
          .map((d) => number(d, 'duration_ms'));
        return {
          name: String(r.name),
          category: String(r.category) as ToolCategory,
          calls: number(r, 'calls'),
          errors: number(r, 'errors'),
          averageDurationMs:
            r.avg_duration === null ? null : number(r, 'avg_duration'),
          p95DurationMs: percentile(values, 95),
        };
      }),
      agents: (
        this.db
          .query(`SELECT t.agent_role role, COUNT(*) turns,
        SUM(t.total_tokens) tokens, SUM(t.cost_total) cost,
        SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END) failures
        FROM analytics_turns t JOIN analytics_runs r ON r.id = t.run_id WHERE ${turnWhere}
        GROUP BY t.agent_role`)
          .all(...args) as Row[]
      ).map((r) => ({
        role: String(r.role) as AgentRole,
        turns: number(r, 'turns'),
        tokens: number(r, 'tokens'),
        cost: number(r, 'cost'),
        failures: number(r, 'failures'),
      })),
      performance: {
        medianTurnDurationMs: percentile(durations, 50),
        p95TurnDurationMs: percentile(durations, 95),
        medianTtftMs: percentile(ttfts, 50),
        p95TtftMs: percentile(ttfts, 95),
      },
      reliability: {
        failedTurns,
        turnFailureRate: ratio(failedTurns, turns),
        toolErrors,
        toolErrorRate: ratio(toolErrors, toolCalls),
        permissionRequests,
        permissionDenials,
        permissionDenialRate: ratio(permissionDenials, permissionRequests),
        interruptions: runCount('interrupted'),
        compactions: eventCount('compaction'),
        subagentCompleted: eventCount('subagent', 'completed'),
        subagentFailed: eventCount('subagent', 'failed'),
        subagentTimedOut: eventCount('subagent', 'timed_out'),
        subagentKilled: eventCount('subagent', 'killed'),
        validationAttempts: number(toolTotals, 'validation_attempts'),
        validationSuccesses: number(toolTotals, 'validation_successes'),
        directTurns: this.routeCount(turnWhere, args, 'direct'),
        gatewayTurns: this.routeCount(turnWhere, args, 'gateway'),
      },
      outcomes: {
        completedRuns: runCount('completed'),
        failedRuns: runCount('failed'),
        interruptedRuns: runCount('interrupted'),
        helpful,
        unhelpful,
        helpfulRate: ratio(helpful, helpful + unhelpful),
      },
    };
  }

  private routeCount(
    where: string,
    args: Array<string | number>,
    route: string,
  ): number {
    return number(
      this.db
        .query(`SELECT COUNT(*) count FROM analytics_turns t
      JOIN analytics_runs r ON r.id = t.run_id WHERE ${where} AND t.route_mode = ?`)
        .get(...args, route) as Row,
      'count',
    );
  }

  private where(query: AnalyticsQuery): {
    args: Array<string | number>;
    workspaceClause: string;
    runClause: string;
  } {
    const days =
      query.range === '7d'
        ? 7
        : query.range === '30d'
          ? 30
          : query.range === '90d'
            ? 90
            : null;
    const since = days === null ? 0 : now() - days * 86_400_000;
    const args: Array<string | number> = [since];
    let workspaceClause = '';
    if (query.scope === 'project' && query.workspaceRoot !== undefined) {
      workspaceClause = ' AND r.workspace_id = ?';
      args.push(workspaceHash(query.workspaceRoot));
    }
    let runClause = '';
    if (query.range === 'session' && query.runId !== undefined) {
      runClause = ' AND t.run_id = ?';
      args.push(query.runId);
    }
    return { args, workspaceClause, runClause };
  }

  private migrate(): void {
    this.db.run('PRAGMA foreign_keys = ON');
    const schemaVersion = number(
      this.db.query('PRAGMA user_version').get() as Row,
      'user_version',
    );
    if (schemaVersion > 1) {
      throw new Error(`Unsupported analytics schema version: ${schemaVersion}`);
    }
    if (schemaVersion === 1) {
      return;
    }
    this.db.run(`CREATE TABLE IF NOT EXISTS analytics_runs (
      id TEXT PRIMARY KEY, conversation_session_id TEXT, workspace_id TEXT NOT NULL,
      workspace_name TEXT NOT NULL, mode TEXT NOT NULL, agent TEXT NOT NULL,
      started_at INTEGER NOT NULL, ended_at INTEGER, status TEXT NOT NULL, rating TEXT)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS analytics_turns (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, parent_turn_id TEXT, sequence INTEGER NOT NULL,
      agent_role TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
      duration_ms INTEGER, ttft_ms INTEGER, status TEXT NOT NULL, provider TEXT, model TEXT,
      route_mode TEXT, stop_reason TEXT, input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_input REAL NOT NULL DEFAULT 0, cost_output REAL NOT NULL DEFAULT 0,
      cost_total REAL NOT NULL DEFAULT 0, FOREIGN KEY (run_id) REFERENCES analytics_runs(id))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS analytics_tool_calls (
      id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, tool_call_id TEXT, name TEXT NOT NULL,
      category TEXT NOT NULL, started_at INTEGER NOT NULL, duration_ms INTEGER,
      is_error INTEGER NOT NULL DEFAULT 0, FOREIGN KEY (turn_id) REFERENCES analytics_turns(id))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS analytics_events (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, turn_id TEXT, type TEXT NOT NULL,
      outcome TEXT, occurred_at INTEGER NOT NULL, FOREIGN KEY (run_id) REFERENCES analytics_runs(id))`);
    this.db.run(
      'CREATE INDEX IF NOT EXISTS idx_analytics_runs_workspace_started ON analytics_runs(workspace_id, started_at)',
    );
    this.db.run(
      'CREATE INDEX IF NOT EXISTS idx_analytics_turns_run_started ON analytics_turns(run_id, started_at)',
    );
    this.db.run(
      'CREATE INDEX IF NOT EXISTS idx_analytics_tools_turn ON analytics_tool_calls(turn_id)',
    );
    this.db.run(
      'CREATE INDEX IF NOT EXISTS idx_analytics_events_run ON analytics_events(run_id)',
    );
    this.db.run('PRAGMA user_version = 1');
  }

  private recoverAbandonedRuns(): void {
    const recoveredAt = now();
    const staleBefore = recoveredAt - 24 * 60 * 60 * 1000;
    this.db
      .query(`UPDATE analytics_turns SET status = 'interrupted', ended_at = ?,
      duration_ms = ? - started_at WHERE status = 'active' AND started_at < ?`)
      .run(recoveredAt, recoveredAt, staleBefore);
    this.db
      .query(`UPDATE analytics_runs SET status = 'interrupted', ended_at = ?
      WHERE status = 'active' AND started_at < ?`)
      .run(recoveredAt, staleBefore);
  }
}

export class AnalyticsRecorder {
  readonly runId?: string;
  private readonly toolStarts = new Map<
    string,
    { name: string; at: number; category: ToolCategory }
  >();

  constructor(
    private readonly store: AnalyticsStore | null,
    input: {
      workspaceRoot: string;
      mode: string;
      agent: string;
      conversationSessionId?: string;
    },
  ) {
    this.runId = this.safe(() => store?.createRun(input));
  }

  static create(input: {
    workspaceRoot: string;
    mode: string;
    agent: string;
    conversationSessionId?: string;
  }): AnalyticsRecorder {
    try {
      return new AnalyticsRecorder(new AnalyticsStore(), input);
    } catch {
      return new AnalyticsRecorder(null, input);
    }
  }

  startTurn(
    role: AgentRole = 'main',
    parentTurnId?: string,
  ): string | undefined {
    return this.safe(() =>
      this.store?.startTurn({ runId: this.runId!, role, parentTurnId }),
    );
  }

  firstResponse(turnId?: string): void {
    if (turnId) this.safe(() => this.store?.markFirstResponse(turnId));
  }

  finishTurn(
    turnId: string | undefined,
    status: Exclude<TurnStatus, 'active'>,
    result?: Parameters<AnalyticsStore['finishTurn']>[2],
  ): void {
    if (turnId) this.safe(() => this.store?.finishTurn(turnId, status, result));
  }

  toolStarted(
    turnId: string | undefined,
    id: string | undefined,
    name: string,
    args?: Record<string, unknown>,
  ): void {
    if (turnId && id) {
      this.toolStarts.set(id, {
        at: now(),
        category: categorizeTool(name, args),
        name,
      });
    }
  }

  toolFinished(
    turnId: string | undefined,
    id: string | undefined,
    name: string,
    durationMs?: number,
    isError?: boolean,
  ): void {
    if (!turnId) return;
    const start = id ? this.toolStarts.get(id) : undefined;
    this.safe(() =>
      this.store?.recordTool({
        turnId,
        toolCallId: id,
        name,
        startedAt: start?.at,
        category: start?.category,
        durationMs: durationMs ?? (start ? now() - start.at : undefined),
        isError,
      }),
    );
    if (id) this.toolStarts.delete(id);
  }

  event(type: string, outcome?: string, turnId?: string): void {
    this.safe(() =>
      this.store?.recordEvent({ runId: this.runId!, turnId, type, outcome }),
    );
  }

  rate(rating: RunRating): void {
    this.safe(() => this.store?.rateRun(this.runId!, rating));
  }
  finish(status: Exclude<RunStatus, 'active'>): void {
    this.safe(() => this.store?.finishRun(this.runId!, status));
  }
  usage(): ReturnType<AnalyticsStore['getRunUsage']> | null {
    return this.safe(() => this.store?.getRunUsage(this.runId!)) ?? null;
  }
  conversationUsage(
    conversationSessionId: string,
  ): ReturnType<AnalyticsStore['getConversationUsage']> | null {
    return (
      this.safe(() =>
        this.store?.getConversationUsage(conversationSessionId),
      ) ?? null
    );
  }
  report(
    query: Omit<AnalyticsQuery, 'runId'> & { runId?: string },
  ): AnalyticsReport | null {
    return (
      this.safe(() =>
        this.store?.report({ ...query, runId: query.runId ?? this.runId }),
      ) ?? null
    );
  }
  close(): void {
    this.safe(() => this.store?.close());
  }

  private safe<T>(run: () => T): T | undefined {
    if (this.store === null) return undefined;
    try {
      return run();
    } catch {
      return undefined;
    }
  }
}
