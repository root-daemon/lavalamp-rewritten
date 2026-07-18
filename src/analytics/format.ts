import type { AnalyticsReport } from './types';

const blocks = '▁▂▃▄▅▆▇█';
const dash = '—';

function count(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function money(value: number): string {
  return `$${value.toFixed(4)}`;
}
function optionalMoney(value: number | null): string {
  return value === null ? dash : money(value);
}
function percent(value: number | null): string {
  return value === null ? dash : `${(value * 100).toFixed(1)}%`;
}
function duration(value: number | null): string {
  return value === null
    ? dash
    : value >= 1000
      ? `${(value / 1000).toFixed(1)}s`
      : `${Math.round(value)}ms`;
}

function sparkline(values: number[]): string {
  if (values.length === 0) return dash;
  const max = Math.max(...values);
  if (max <= 0) return blocks[0]!.repeat(values.length);
  return values
    .map((value) => blocks[Math.min(7, Math.floor((value / max) * 7))])
    .join('');
}

export function formatAnalyticsRows(report: AnalyticsReport): string[] {
  const o = report.overview;
  const r = report.reliability;
  const p = report.performance;
  const out = report.outcomes;
  const rows = [
    '  overview',
    `  ${o.runs} runs · ${o.turns} turns · ${count(o.totalTokens)} tokens · ${money(o.totalCost)}`,
    `  input ${count(o.inputTokens)} · output ${count(o.outputTokens)} · cache read ${count(o.cacheReadTokens)} · write ${count(o.cacheWriteTokens)}`,
    `  avg/turn ${optionalMoney(o.averageCostPerTurn)} · cache ${percent(o.cachedTokenShare)} · ${o.tokensPerSuccessfulTurn === null ? dash : count(o.tokensPerSuccessfulTurn)} tok/success`,
    '',
    '  trend',
    `  tokens ${sparkline(report.trend.map((day) => day.tokens))}`,
    `  cost   ${sparkline(report.trend.map((day) => day.cost))}`,
    '',
    '  performance',
    `  turn p50 ${duration(p.medianTurnDurationMs)} · p95 ${duration(p.p95TurnDurationMs)} · TTFT p50 ${duration(p.medianTtftMs)} · p95 ${duration(p.p95TtftMs)}`,
    '',
    '  reliability',
    `  turn errors ${percent(r.turnFailureRate)} · tool errors ${percent(r.toolErrorRate)} · permission denials ${percent(r.permissionDenialRate)}`,
    `  interrupted ${r.interruptions} · compactions ${r.compactions} · validation ${r.validationSuccesses}/${r.validationAttempts}`,
    `  routes direct ${r.directTurns} · gateway ${r.gatewayTurns}`,
    `  subagents done ${r.subagentCompleted} · failed ${r.subagentFailed} · timeout ${r.subagentTimedOut} · killed ${r.subagentKilled}`,
    '',
    '  models',
    ...report.models
      .slice(0, 5)
      .map(
        (model) =>
          `  ${model.provider}/${model.model} · ${model.turns} turns · ${count(model.tokens)} tok · ${money(model.cost)}`,
      ),
    '',
    '  agents',
    ...report.agents.map(
      (agent) =>
        `  ${agent.role} · ${agent.turns} turns · ${count(agent.tokens)} tok · ${money(agent.cost)} · ${agent.failures} failures`,
    ),
    '',
    '  top tools',
    ...report.tools
      .slice(0, 5)
      .map(
        (tool) =>
          `  ${tool.name} · ${tool.calls} calls · ${tool.errors} errors · avg ${duration(tool.averageDurationMs)} · p95 ${duration(tool.p95DurationMs)}`,
      ),
    '',
    '  outcomes',
    `  completed ${out.completedRuns} · failed ${out.failedRuns} · interrupted ${out.interruptedRuns} · helpful ${percent(out.helpfulRate)} (${out.helpful + out.unhelpful} rated)`,
  ];
  return rows;
}

export function formatAnalyticsText(report: AnalyticsReport): string {
  return formatAnalyticsRows(report).join('\n');
}
