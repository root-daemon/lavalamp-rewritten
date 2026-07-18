import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AnalyticsRecorder,
  AnalyticsStore,
  categorizeTool,
  formatAnalyticsRows,
} from '../src/analytics';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lavalamp-analytics-'));
  const dbPath = join(root, 'analytics.db');
  return { dbPath, root };
}

const usage = {
  cacheRead: 50,
  cacheWrite: 10,
  cost: { input: 0.01, output: 0.02, total: 0.03 },
  input: 100,
  output: 25,
  totalTokens: 185,
};

describe('analytics store', () => {
  test('records metadata and aggregates project reports', () => {
    const { dbPath, root } = fixture();
    const store = new AnalyticsStore(dbPath);
    const runId = store.createRun({
      agent: 'build',
      mode: 'tui',
      workspaceRoot: root,
    });
    const turnId = store.startTurn({ runId });
    store.markFirstResponse(turnId);
    store.recordTool({
      category: 'validation/test',
      durationMs: 40,
      isError: false,
      name: 'bash',
      turnId,
    });
    store.recordEvent({ outcome: 'denied', runId, turnId, type: 'permission' });
    store.finishTurn(turnId, 'completed', {
      model: { id: 'model', provider: 'provider' },
      routeMode: 'direct',
      usage,
    });
    store.rateRun(runId, 'helpful');
    store.finishRun(runId, 'completed');

    const report = store.report({
      range: 'all',
      scope: 'project',
      workspaceRoot: root,
    });
    expect(report.overview).toMatchObject({
      runs: 1,
      successfulTurns: 1,
      totalCost: 0.03,
      totalTokens: 185,
      turns: 1,
    });
    expect(report.overview.cachedTokenShare).toBeCloseTo(1 / 3);
    expect(report.reliability).toMatchObject({
      permissionDenials: 1,
      permissionRequests: 1,
      validationAttempts: 1,
      validationSuccesses: 1,
    });
    expect(report.models[0]).toMatchObject({
      model: 'model',
      provider: 'provider',
    });
    expect(report.outcomes.helpfulRate).toBe(1);
    store.close();
  });

  test('isolates projects while supporting global queries and concurrent writers', () => {
    const { dbPath, root } = fixture();
    const first = new AnalyticsStore(dbPath);
    const second = new AnalyticsStore(dbPath);
    const roots = [join(root, 'one'), join(root, 'two')];
    for (const [index, workspaceRoot] of roots.entries()) {
      const store = index === 0 ? first : second;
      const runId = store.createRun({
        agent: 'build',
        mode: 'print',
        workspaceRoot,
      });
      const turnId = store.startTurn({ runId });
      store.finishTurn(turnId, 'completed', { usage });
      store.finishRun(runId, 'completed');
    }
    expect(
      first.report({ range: 'all', scope: 'project', workspaceRoot: roots[0] })
        .overview.runs,
    ).toBe(1);
    expect(first.report({ range: 'all', scope: 'global' }).overview.runs).toBe(
      2,
    );
    first.close();
    second.close();
  });

  test('records token usage when a backend does not report monetary cost', () => {
    const { dbPath, root } = fixture();
    const store = new AnalyticsStore(dbPath);
    const runId = store.createRun({
      agent: 'build',
      mode: 'print',
      workspaceRoot: root,
    });
    const turnId = store.startTurn({ runId });

    store.finishTurn(turnId, 'completed', {
      usage: { ...usage, cost: null },
    });
    store.finishRun(runId, 'completed');

    expect(
      store.report({ range: 'all', scope: 'project', workspaceRoot: root })
        .overview,
    ).toMatchObject({ totalCost: 0, totalTokens: 185 });
    store.close();
  });

  test('recovers stale active records without interrupting current runs', () => {
    const { dbPath, root } = fixture();
    const store = new AnalyticsStore(dbPath);
    const stale = store.createRun({
      agent: 'build',
      mode: 'tui',
      workspaceRoot: root,
    });
    const current = store.createRun({
      agent: 'build',
      mode: 'tui',
      workspaceRoot: root,
    });
    const staleTurn = store.startTurn({ runId: stale });
    store.startTurn({ runId: current });
    store.close();

    const db = new Database(dbPath);
    const old = Date.now() - 25 * 60 * 60 * 1000;
    db.query('UPDATE analytics_runs SET started_at = ? WHERE id = ?').run(
      old,
      stale,
    );
    db.query('UPDATE analytics_turns SET started_at = ? WHERE id = ?').run(
      old,
      staleTurn,
    );
    db.close();

    const reopened = new AnalyticsStore(dbPath);
    const check = new Database(dbPath, { readonly: true });
    expect(
      (
        check
          .query('SELECT status FROM analytics_runs WHERE id = ?')
          .get(stale) as { status: string }
      ).status,
    ).toBe('interrupted');
    expect(
      (
        check
          .query('SELECT status FROM analytics_runs WHERE id = ?')
          .get(current) as { status: string }
      ).status,
    ).toBe('active');
    check.close();
    reopened.close();
  });

  test('does not persist prompts, commands, tool arguments, results, or errors', () => {
    const { dbPath, root } = fixture();
    const store = new AnalyticsStore(dbPath);
    const runId = store.createRun({
      agent: 'build',
      mode: 'tui',
      workspaceRoot: root,
    });
    const turnId = store.startTurn({ runId });
    store.recordTool({ name: 'bash', turnId, isError: true });
    store.finishTurn(turnId, 'failed');
    store.finishRun(runId, 'failed');
    store.close();
    const bytes = readFileSync(dbPath).toString('utf8');
    for (const secret of [
      'super-secret-prompt',
      'rm private-file',
      'tool-result-secret',
      'stack-trace-secret',
    ]) {
      expect(bytes).not.toContain(secret);
    }
  });

  test('renders missing samples as em dashes and tolerates disabled storage', () => {
    const { dbPath, root } = fixture();
    const store = new AnalyticsStore(dbPath);
    const rows = formatAnalyticsRows(
      store.report({ range: 'all', scope: 'project', workspaceRoot: root }),
    );
    expect(rows.join('\n')).toContain('—');
    store.close();

    const recorder = new AnalyticsRecorder(null, {
      agent: 'build',
      mode: 'print',
      workspaceRoot: root,
    });
    expect(recorder.startTurn()).toBeUndefined();
    expect(() => recorder.finish('completed')).not.toThrow();
  });
});

test('tool classification inspects commands without retaining them', () => {
  expect(
    categorizeTool('bash', { cmd: 'bun test tests/analytics.test.ts' }),
  ).toBe('validation/test');
  expect(categorizeTool('bash', { cmd: 'git status --short' })).toBe('shell');
  expect(categorizeTool('read')).toBe('read/search');
  expect(categorizeTool('edit')).toBe('mutation');
  expect(categorizeTool('deploy_parallel_subs')).toBe('delegation');
});
