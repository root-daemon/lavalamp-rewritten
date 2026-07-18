import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BenchmarkRunStore } from '../src/benchmarks/run-store';
import {
  runBenchmarkCli,
  type BenchmarkCliContext,
} from '../src/benchmarks/cli';
import type { PublicBenchmarkSnapshot } from '../src/benchmarks/types';

const cursor: PublicBenchmarkSnapshot = {
  categories: ['coding'],
  description: 'private tasks',
  id: 'cursorbench',
  leaderboard: [{ name: 'Composer', rank: 1, score: 56.1 }],
  metrics: ['score'],
  name: 'CursorBench 3.2',
  retrievedAt: '2026-07-18T00:00:00.000Z',
  runnable: false,
  schemaVersion: 1,
  sourceUrls: ['https://cursor.com/cursorbench'],
  stale: false,
  version: '3.2',
};

function context(workspace: string): {
  ctx: BenchmarkCliContext;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const dataDir = mkdtempSync(join(tmpdir(), 'lavalamp-data-'));
  return {
    ctx: {
      catalog: {
        ids: () => ['cursorbench'],
        get: async () => cursor,
        list: async () => [cursor],
        refresh: async () => cursor,
      },
      dataDir,
      executeHarbor: async (invocation) => {
        const trialDir = join(invocation.config.outputDir, 'task-a');
        mkdirSync(trialDir, { recursive: true });
        writeFileSync(
          join(trialDir, 'result.json'),
          JSON.stringify({ task_name: 'task-a', reward: 1 }),
        );
        return 0;
      },
      model: 'openai/gpt-5',
      preflight: () => [],
      stderr: (line) => stderr.push(line),
      stdout: (line) => stdout.push(line),
      version: '0.1.2',
      workspaceRoot: workspace,
    },
    stderr,
    stdout,
  };
}

describe('benchmark run store', () => {
  test('saves and lists newest runs without exposing environment values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lavalamp-runs-'));
    const store = new BenchmarkRunStore(dir);
    store.save({
      benchmarkId: 'custom',
      benchmarkVersion: 'local',
      completedAt: '2026-07-18T00:00:00.000Z',
      id: 'run-1',
      observed: true,
      profileFingerprint: 'abc',
      scaffold: 'lavalamp@0.1.2',
      schemaVersion: 1,
      trials: [],
    });

    expect(store.list()).toHaveLength(1);
    expect(store.load('run-1')?.benchmarkId).toBe('custom');
    expect(existsSync(join(dir, 'run-1.json'))).toBe(true);
  });
});

describe('benchmark CLI', () => {
  test('lists internet-backed catalog data as JSON', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'lavalamp-workspace-'));
    const { ctx, stdout } = context(workspace);

    const code = await runBenchmarkCli(['list', '--output-format', 'json'], ctx);

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join('\n'))[0]).toMatchObject({
      id: 'cursorbench',
      runnable: false,
    });
  });

  test('scaffolds and validates a custom suite', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'lavalamp-workspace-'));
    const { ctx, stdout } = context(workspace);

    expect(await runBenchmarkCli(['init', 'regressions'], ctx)).toBe(0);
    expect(await runBenchmarkCli(['validate', 'regressions'], ctx)).toBe(0);
    expect(await runBenchmarkCli(['list'], ctx)).toBe(0);
    expect(stdout.join('\n')).toContain('valid');
    expect(stdout.at(-1)).toContain('regressions');
  });

  test('includes Harbor schema errors when validating a custom suite', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'lavalamp-workspace-'));
    const { ctx, stderr } = context(workspace);
    await runBenchmarkCli(['init', 'regressions'], ctx);
    ctx.validateHarbor = async () => ['Harbor rejected task.toml'];

    const code = await runBenchmarkCli(['validate', 'regressions'], ctx);

    expect(code).toBe(1);
    expect(stderr.join('\n')).toContain('Harbor rejected task.toml');
  });

  test('rejects attempts to run reference-only benchmarks', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'lavalamp-workspace-'));
    const { ctx, stderr } = context(workspace);

    const code = await runBenchmarkCli(['run', 'cursorbench'], ctx);

    expect(code).toBe(1);
    expect(stderr.join('\n')).toContain('reference-only');
  });

  test('runs multiple profiles and persists paired results', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'lavalamp-workspace-'));
    const { ctx, stdout } = context(workspace);
    await runBenchmarkCli(['init', 'regressions'], ctx);

    const code = await runBenchmarkCli(
      [
        'run',
        'regressions',
        '--profile',
        'baseline',
        '--profile',
        'optimized',
        '--sample',
        '1',
        '--seed',
        '42',
        '--output-format',
        'json',
      ],
      ctx,
    );

    const payload = JSON.parse(stdout.at(-1) as string);
    expect(code).toBe(0);
    expect(payload.runs).toHaveLength(2);
    expect(payload.comparison.recommendedRunId).toBeDefined();
  });

  test('stores evidence-checked opt-in failure analysis', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'lavalamp-workspace-'));
    const { ctx, stdout } = context(workspace);
    await runBenchmarkCli(['init', 'regressions'], ctx);
    ctx.executeHarbor = async (invocation) => {
      const trialDir = join(invocation.config.outputDir, 'task-a');
      mkdirSync(trialDir, { recursive: true });
      writeFileSync(
        join(trialDir, 'result.json'),
        JSON.stringify({ task_name: 'task-a', reward: 0 }),
      );
      return 0;
    };
    ctx.analyzeFailure = async (_deterministic, evidence) => ({
      category: 'retrieval',
      confidence: 0.8,
      evidence: [evidence[0] as string],
      method: 'llm',
      recommendedChange: {
        field: 'retrieval',
        rationale: 'Broaden discovery.',
        value: 'semantic',
      },
      schemaVersion: 1,
      summary: 'The agent did not find the required code.',
    });

    const code = await runBenchmarkCli(
      [
        'run',
        'regressions',
        '--model',
        'openai/gpt-5',
        '--analyze',
        '--output-format',
        'json',
      ],
      ctx,
    );

    const trial = JSON.parse(stdout.at(-1) as string).runs[0].trials[0];
    expect(code).toBe(0);
    expect(trial.failureAnalysis).toMatchObject({
      category: 'retrieval',
      method: 'llm',
    });
  });
});
