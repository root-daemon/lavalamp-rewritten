import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BenchmarkCatalog,
  type BenchmarkSource,
} from '../src/benchmarks/catalog';
import {
  parseCursorBenchHtml,
  parseSweAtlasHtml,
  parseTerminalBenchHtml,
} from '../src/benchmarks/sources';
import type { PublicBenchmarkSnapshot } from '../src/benchmarks/types';

const now = '2026-07-18T00:00:00.000Z';

describe('public benchmark sources', () => {
  test('parses Terminal-Bench task metadata and escaped leaderboard rows', () => {
    const snapshot = parseTerminalBenchHtml(
      'Showing <!-- -->89<!-- --> tasks',
      String.raw`{"rows":[{"agent":"Lava","model":["Model X"],"accuracy":0.652,"stderr":0.02}]}`,
      now,
    );

    expect(snapshot).toMatchObject({
      harborDataset: 'terminal-bench/terminal-bench-2',
      id: 'terminal-bench-2',
      runnable: true,
      taskCount: 89,
      version: '2.0',
    });
    expect(snapshot.leaderboard[0]).toMatchObject({
      name: 'Lava',
      model: 'Model X',
      score: 65.2,
    });
  });

  test('parses SWE Atlas and CursorBench official leaderboard markup', () => {
    const swe = parseSweAtlasHtml(
      String.raw`Codebase QnA consists of 124 tasks {"entries":[{"model":"Opus 4.8 (Claude Code)","rank":1,"score":57.26}]}`,
      now,
    );
    const cursor = parseCursorBenchHtml(
      '<h1>CursorBench 3.2</h1><g aria-label="Composer 2.5: 56.1%, $0.44 avg cost per task"></g>',
      now,
    );

    expect(swe.taskCount).toBe(124);
    expect(swe.leaderboard[0]).toMatchObject({ rank: 1, score: 57.26 });
    expect(cursor).toMatchObject({
      id: 'cursorbench',
      runnable: false,
      version: '3.2',
    });
    expect(cursor.leaderboard[0]).toMatchObject({ cost: 0.44, score: 56.1 });
  });
});

function snapshot(score: number): PublicBenchmarkSnapshot {
  return {
    categories: ['terminal'],
    description: 'fixture',
    harborDataset: 'terminal-bench/terminal-bench-2',
    id: 'terminal-bench-2',
    leaderboard: [{ name: 'agent', rank: 1, score }],
    metrics: ['resolve_rate'],
    name: 'Terminal-Bench 2.0',
    retrievedAt: now,
    runnable: true,
    schemaVersion: 1,
    sourceUrls: ['https://example.test'],
    stale: false,
    taskCount: 89,
    version: '2.0',
  };
}

describe('benchmark snapshot cache', () => {
  test('writes successful refreshes and returns the stale cache on failure', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'lavalamp-benchmarks-'));
    let fail = false;
    const source: BenchmarkSource = {
      id: 'terminal-bench-2',
      async fetch() {
        if (fail) {
          throw new Error('upstream unavailable');
        }
        return snapshot(65.2);
      },
    };
    const catalog = new BenchmarkCatalog(cacheDir, [source]);

    const fresh = await catalog.refresh('terminal-bench-2');
    fail = true;
    const fallback = await catalog.refresh('terminal-bench-2');

    expect(fresh.stale).toBe(false);
    expect(fallback).toMatchObject({ stale: true, leaderboard: fresh.leaderboard });
    expect(
      JSON.parse(
        readFileSync(join(cacheDir, 'terminal-bench-2.json'), 'utf8'),
      ).stale,
    ).toBe(false);
    expect(readdirSync(join(cacheDir, 'terminal-bench-2'))).toHaveLength(1);
  });

  test('reports a source failure when no valid cache exists', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'lavalamp-benchmarks-'));
    const source: BenchmarkSource = {
      id: 'terminal-bench-2',
      async fetch() {
        throw new Error('broken parser');
      },
    };

    await expect(
      new BenchmarkCatalog(cacheDir, [source]).refresh('terminal-bench-2'),
    ).rejects.toThrow('broken parser');
  });
});
