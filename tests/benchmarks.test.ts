import { describe, expect, test } from 'bun:test';
import {
  compareBenchmarkRuns,
  type BenchmarkRun,
} from '../src/benchmarks/comparison';
import {
  classifyFailure,
  parseLlmFailureAnalysis,
  type FailureSignals,
} from '../src/benchmarks/failures';
import {
  parseAgentProfile,
  resolveAgentProfile,
} from '../src/benchmarks/profiles';

describe('benchmark agent profiles', () => {
  test('validates and resolves the four supported controls', () => {
    const profile = parseAgentProfile({
      budget: 'balanced',
      name: 'search-and-verify',
      orchestration: 'experts',
      retrieval: 'semantic_graph',
      schemaVersion: 1,
      workflow: 'plan_verify',
    });

    const resolved = resolveAgentProfile(profile);

    expect(resolved.enabledToolGroups).toEqual([
      'lexical',
      'semantic',
      'graph',
      'experts',
    ]);
    expect(resolved.instructions).toContain('plan');
    expect(resolved.instructions).toContain('verify');
    expect(resolved.maxSubagents).toBe(2);
    expect(resolved.timeoutSeconds).toBe(900);
    expect(resolved.fingerprint).toMatch(/^[a-f0-9]{12}$/);
  });

  test('fingerprints normalized profiles deterministically', () => {
    const first = resolveAgentProfile(
      parseAgentProfile({
        schemaVersion: 1,
        name: 'same',
        retrieval: 'lexical',
        workflow: 'direct',
        orchestration: 'solo',
        budget: 'fast',
      }),
    );
    const second = resolveAgentProfile(
      parseAgentProfile({
        budget: 'fast',
        orchestration: 'solo',
        retrieval: 'lexical',
        name: 'same',
        workflow: 'direct',
        schemaVersion: 1,
      }),
    );

    expect(first.fingerprint).toBe(second.fingerprint);
  });

  test('rejects unsupported controls', () => {
    expect(() =>
      parseAgentProfile({
        schemaVersion: 1,
        name: 'invalid',
        retrieval: 'magical',
        workflow: 'direct',
        orchestration: 'solo',
        budget: 'fast',
      }),
    ).toThrow('Invalid agent profile');
  });
});

function run(
  id: string,
  profileFingerprint: string,
  rewards: Record<string, number>,
  cost: number,
): BenchmarkRun {
  return {
    benchmarkId: 'swe-atlas-qna',
    benchmarkVersion: '1',
    completedAt: '2026-07-18T00:00:00.000Z',
    id,
    observed: true,
    profileFingerprint,
    scaffold: 'lavalamp@0.1.2',
    schemaVersion: 1,
    trials: Object.entries(rewards).map(([taskId, reward]) => ({
      cost: cost / Object.keys(rewards).length,
      durationMs: 1_000,
      reward,
      status: 'completed',
      taskId,
      tokens: 100,
    })),
  };
}

describe('benchmark comparisons', () => {
  test('reports paired task transitions against the baseline', () => {
    const baseline = run('baseline', 'aaa', { a: 0, b: 1, c: 0 }, 3);
    baseline.profile = {
      budget: 'balanced',
      name: 'baseline',
      orchestration: 'solo',
      retrieval: 'lexical',
      schemaVersion: 1,
      workflow: 'direct',
    };
    const variant = run('variant', 'bbb', { a: 1, b: 0, c: 0 }, 2);
    variant.profile = {
      ...baseline.profile,
      name: 'variant',
      retrieval: 'semantic',
      workflow: 'plan_verify',
    };
    const comparison = compareBenchmarkRuns([baseline, variant]);

    expect(comparison.profiles[1]).toMatchObject({
      improved: 1,
      regressed: 1,
      unchanged: 1,
      failures: 2,
      score: 100 / 3,
    });
    expect(comparison.profiles[1]?.profileDiff).toEqual({
      retrieval: { baseline: 'lexical', variant: 'semantic' },
      workflow: { baseline: 'direct', variant: 'plan_verify' },
    });
    expect(comparison.recommendedRunId).toBe('variant');
  });

  test('rejects runs with different task sets or benchmark versions', () => {
    const left = run('left', 'aaa', { a: 1 }, 1);
    const right = run('right', 'bbb', { b: 1 }, 1);
    right.benchmarkVersion = '2';

    expect(() => compareBenchmarkRuns([left, right])).toThrow(
      'not comparable',
    );
  });
});

describe('deterministic failure analysis', () => {
  const base: FailureSignals = {
    editsMade: 0,
    environmentError: false,
    graderFeedback: '',
    relevantFilesOpened: true,
    searches: 1,
    testsRun: 1,
    timedOut: false,
  };

  test('classifies environment and timeout failures before agent mistakes', () => {
    expect(
      classifyFailure({ ...base, environmentError: true }).category,
    ).toBe('environment');
    expect(classifyFailure({ ...base, timedOut: true }).category).toBe(
      'resource',
    );
  });

  test('uses trajectory evidence for retrieval and verification failures', () => {
    const retrieval = classifyFailure({
      ...base,
      relevantFilesOpened: false,
      searches: 12,
    });
    const verification = classifyFailure({
      ...base,
      editsMade: 2,
      testsRun: 0,
    });

    expect(retrieval.category).toBe('retrieval');
    expect(retrieval.evidence).toContain('Relevant files were never opened');
    expect(verification.category).toBe('verification');
  });

  test('accepts structured LLM analysis only when it cites recorded evidence', () => {
    const raw = JSON.stringify({
      category: 'retrieval',
      confidence: 0.82,
      evidence: ['Trial status: failed'],
      recommendedChange: {
        field: 'retrieval',
        rationale: 'Broaden repository discovery.',
        value: 'semantic',
      },
      summary: 'The agent failed before locating relevant code.',
    });

    const result = parseLlmFailureAnalysis(raw, ['Trial status: failed']);

    expect(result.method).toBe('llm');
    expect(result.recommendedChange).toMatchObject({
      field: 'retrieval',
      value: 'semantic',
    });
  });

  test('rejects LLM evidence that is absent from the recorded trajectory', () => {
    const raw = JSON.stringify({
      category: 'reasoning',
      confidence: 0.9,
      evidence: ['The agent ignored package.json'],
      recommendedChange: {
        field: 'budget',
        rationale: 'Allow more reasoning time.',
        value: 'deep',
      },
      summary: 'The reasoning was incomplete.',
    });

    expect(() =>
      parseLlmFailureAnalysis(raw, ['Trial status: failed']),
    ).toThrow('unrecorded evidence');
  });
});
