import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCustomBenchmark,
  validateCustomBenchmark,
} from '../src/benchmarks/custom';
import {
  buildHarborInvocation,
  ensureHarborAgentAdapter,
  normalizeHarborResults,
} from '../src/benchmarks/harbor';
import {
  parseAgentProfile,
  resolveAgentProfile,
} from '../src/benchmarks/profiles';

describe('custom benchmarks', () => {
  test('scaffolds a repository-owned Harbor dataset with a passing oracle', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'lavalamp-workspace-'));

    const suite = createCustomBenchmark(workspace, 'project-regressions');

    expect(suite).toBe(join(workspace, 'benchmarks', 'project-regressions'));
    for (const file of [
      'dataset.toml',
      'example/instruction.md',
      'example/task.toml',
      'example/environment/Dockerfile',
      'example/solution/solve.sh',
      'example/tests/test.sh',
    ]) {
      expect(existsSync(join(suite, file))).toBe(true);
    }
    expect(readFileSync(join(suite, 'dataset.toml'), 'utf8')).toContain(
      '[[tasks]]',
    );
    expect(validateCustomBenchmark(workspace, suite)).toEqual([]);
  });

  test('rejects unsafe suite names and reports missing required files', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'lavalamp-workspace-'));
    expect(() => createCustomBenchmark(workspace, '../escape')).toThrow(
      'Invalid benchmark name',
    );
    const suite = join(workspace, 'benchmarks', 'broken');
    expect(validateCustomBenchmark(workspace, suite)).toContain(
      'Missing dataset.toml',
    );
  });
});

const profile = resolveAgentProfile(
  parseAgentProfile({
    budget: 'balanced',
    name: 'optimized',
    orchestration: 'experts',
    retrieval: 'semantic_graph',
    schemaVersion: 1,
    workflow: 'plan_verify',
  }),
);

describe('Harbor integration', () => {
  test('builds equivalent public and local Docker invocations', () => {
    const publicRun = buildHarborInvocation({
      agentImportPath: 'harbor_agent.lavalamp_agent:LavalampAgent',
      benchmark: {
        id: 'terminal-bench-2',
        kind: 'registry',
        reference: 'terminal-bench/terminal-bench-2',
        version: '2.0',
      },
      concurrency: 2,
      jobName: 'run-public',
      model: 'openai/gpt-5',
      outputDir: '/tmp/results',
      profile,
      sample: 5,
      seed: 42,
    });
    const localRun = buildHarborInvocation({
      ...publicRun.config,
      benchmark: {
        id: 'project-regressions',
        kind: 'path',
        reference: '/repo/benchmarks/project-regressions',
        version: 'local',
      },
      jobName: 'run-local',
    });

    expect(publicRun.args).toContain('--dataset');
    expect(publicRun.args).toContain('terminal-bench/terminal-bench-2');
    expect(publicRun.args).toContain('--agent');
    expect(publicRun.args).not.toContain('--agent-import-path');
    expect(publicRun.args).toContain('--jobs-dir');
    expect(publicRun.args).toContain('--n-tasks');
    expect(publicRun.args).not.toContain('--limit');
    expect(publicRun.args).toContain('--agent-timeout-multiplier');
    expect(localRun.args).toContain('--path');
    expect(localRun.args).toContain('/repo/benchmarks/project-regressions');
    expect(publicRun.env.LAVALAMP_AGENT_PROFILE).toContain('semantic_graph');
    expect(publicRun.env.LAVALAMP_BENCHMARK_SEED).toBe('42');
  });

  test('materializes the custom Harbor agent without embedding credentials', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'lavalamp-data-'));
    const adapter = ensureHarborAgentAdapter(dataDir);
    const source = readFileSync(adapter.file, 'utf8');

    expect(adapter.importPath).toBe(
      'harbor_agent.lavalamp_agent:LavalampAgent',
    );
    expect(source).toContain('class LavalampAgent');
    expect(source).toContain('LAVALAMP_AGENT_PROFILE');
    expect(source).toContain('LAVALAMP_MODEL');
    expect(source).toContain('LAVALAMP_WORKSPACE');
    expect(source).toContain('env=runtime_env');
    expect(source).not.toContain('API_KEY=');
  });

  test('normalizes completed, timed-out, and partial Harbor trials', () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'harbor-results-'));
    const first = join(outputDir, 'task-a');
    const second = join(outputDir, 'task-b');
    Bun.spawnSync(['mkdir', '-p', first, second]);
    writeFileSync(
      join(first, 'result.json'),
      JSON.stringify({
        task_name: 'task-a',
        reward: 1,
        duration_ms: 2_000,
        agent_result: { total_tokens: 300, cost_usd: 0.12 },
      }),
    );
    writeFileSync(
      join(second, 'result.json'),
      JSON.stringify({ task_name: 'task-b', status: 'timed_out' }),
    );

    const run = normalizeHarborResults({
      benchmarkId: 'project-regressions',
      benchmarkVersion: 'local',
      completedAt: '2026-07-18T00:00:00.000Z',
      model: 'openai/gpt-5',
      outputDir,
      profileFingerprint: profile.fingerprint,
      runId: 'run-1',
      scaffold: 'lavalamp@0.1.2',
    });

    expect(run.trials).toHaveLength(2);
    expect(run.trials[0]).toMatchObject({
      cost: 0.12,
      reward: 1,
      taskId: 'task-a',
      tokens: 300,
    });
    expect(run.trials[1]).toMatchObject({
      reward: 0,
      status: 'timed_out',
    });
  });
});
