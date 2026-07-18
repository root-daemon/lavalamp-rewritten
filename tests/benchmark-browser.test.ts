import { describe, expect, test } from 'bun:test';
import {
  createBenchmarkBrowserModel,
  moveBenchmarkSelection,
  nextBenchmarkTab,
  renderBenchmarkDetails,
} from '../src/tui/benchmarks';
import type {
  BenchmarkRun,
  PublicBenchmarkSnapshot,
} from '../src/benchmarks/types';

const publicItem: PublicBenchmarkSnapshot = {
  categories: ['terminal'],
  description: 'Terminal tasks',
  harborDataset: 'terminal-bench/terminal-bench-2',
  id: 'terminal-bench-2',
  leaderboard: [{ name: 'Agent A', rank: 1, score: 65.2 }],
  metrics: ['resolve_rate'],
  name: 'Terminal-Bench 2.0',
  retrievedAt: '2026-07-18T00:00:00.000Z',
  runnable: true,
  schemaVersion: 1,
  sourceUrls: ['https://tbench.ai'],
  stale: false,
  taskCount: 89,
  version: '2.0',
};

const run: BenchmarkRun = {
  benchmarkId: 'terminal-bench-2',
  benchmarkVersion: '2.0',
  completedAt: '2026-07-18T01:00:00.000Z',
  id: 'run-1',
  observed: true,
  profileFingerprint: 'abc',
  scaffold: 'lavalamp@0.1.2',
  schemaVersion: 1,
  trials: [
    {
      cost: 0.5,
      durationMs: 2_000,
      reward: 0,
      status: 'failed',
      taskId: 'task-a',
      tokens: 300,
      failureCategory: 'retrieval',
    },
  ],
};

describe('benchmark TUI browser model', () => {
  test('combines public, custom, and saved run entries', () => {
    const model = createBenchmarkBrowserModel(
      [publicItem],
      [{ id: 'regressions', path: '/repo/benchmarks/regressions' }],
      [run],
    );

    expect(model.entries.map((entry) => entry.kind)).toEqual([
      'public',
      'custom',
      'run',
    ]);
    expect(renderBenchmarkDetails(model)).toContain('65.20%');
  });

  test('clamps selection and cycles overview, runs, failures, provenance', () => {
    const model = createBenchmarkBrowserModel([publicItem], [], [run]);
    moveBenchmarkSelection(model, 10);
    expect(model.selected).toBe(1);
    moveBenchmarkSelection(model, -10);
    expect(model.selected).toBe(0);

    expect(model.tab).toBe('overview');
    nextBenchmarkTab(model);
    nextBenchmarkTab(model);
    expect(model.tab).toBe('failures');
    expect(renderBenchmarkDetails(model)).toContain('retrieval');
  });
});
