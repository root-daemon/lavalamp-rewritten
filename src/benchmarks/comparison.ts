import type { BenchmarkRun } from './types';
import type { AgentProfile } from './profiles';

export type { BenchmarkRun } from './types';

export interface ProfileComparison {
  runId: string;
  profileFingerprint: string;
  score: number;
  cost: number;
  durationMs: number;
  tokens: number;
  improved: number;
  regressed: number;
  unchanged: number;
  failures: number;
  profileDiff: ProfileDiff;
}

type ProfileControl = 'retrieval' | 'workflow' | 'orchestration' | 'budget';
export type ProfileDiff = Partial<
  Record<ProfileControl, { baseline: string; variant: string }>
>;

export interface ExperimentComparison {
  schemaVersion: 1;
  benchmarkId: string;
  benchmarkVersion: string;
  baselineRunId: string;
  recommendedRunId: string;
  profiles: ProfileComparison[];
}

function taskIds(run: BenchmarkRun): string[] {
  return run.trials.map((trial) => trial.taskId).toSorted();
}

function assertComparable(runs: BenchmarkRun[]): void {
  if (runs.length < 2) {
    throw new Error('Benchmark comparison requires at least two runs');
  }
  const baseline = runs[0] as BenchmarkRun;
  const expectedTasks = JSON.stringify(taskIds(baseline));
  for (const run of runs.slice(1)) {
    if (
      run.benchmarkId !== baseline.benchmarkId ||
      run.benchmarkVersion !== baseline.benchmarkVersion ||
      run.benchmarkReference !== baseline.benchmarkReference ||
      run.model !== baseline.model ||
      run.seed !== baseline.seed ||
      run.scaffold !== baseline.scaffold ||
      JSON.stringify(taskIds(run)) !== expectedTasks
    ) {
      throw new Error(
        `Benchmark runs ${baseline.id} and ${run.id} are not comparable`,
      );
    }
  }
}

function profileDiff(
  baseline: AgentProfile | undefined,
  variant: AgentProfile | undefined,
): ProfileDiff {
  if (baseline === undefined || variant === undefined) {
    return {};
  }
  const diff: ProfileDiff = {};
  for (const field of [
    'retrieval',
    'workflow',
    'orchestration',
    'budget',
  ] as const) {
    if (baseline[field] !== variant[field]) {
      diff[field] = {
        baseline: baseline[field],
        variant: variant[field],
      };
    }
  }
  return diff;
}

export function compareBenchmarkRuns(
  runs: BenchmarkRun[],
): ExperimentComparison {
  assertComparable(runs);
  const baseline = runs[0] as BenchmarkRun;
  const baselineRewards = new Map(
    baseline.trials.map((trial) => [trial.taskId, trial.reward]),
  );
  const profiles = runs.map((run) => {
    let improved = 0;
    let regressed = 0;
    let unchanged = 0;
    for (const trial of run.trials) {
      const previous = baselineRewards.get(trial.taskId) as number;
      if (trial.reward > previous) {
        improved++;
      } else if (trial.reward < previous) {
        regressed++;
      } else {
        unchanged++;
      }
    }
    return {
      cost: run.trials.reduce((sum, trial) => sum + trial.cost, 0),
      durationMs: run.trials.reduce(
        (sum, trial) => sum + trial.durationMs,
        0,
      ),
      failures: run.trials.filter(
        (trial) => trial.status !== 'completed' || trial.reward <= 0,
      ).length,
      improved,
      profileDiff: profileDiff(baseline.profile, run.profile),
      profileFingerprint: run.profileFingerprint,
      regressed,
      runId: run.id,
      score:
        run.trials.length === 0
          ? 0
          : (run.trials.reduce((sum, trial) => sum + trial.reward, 0) * 100) /
            run.trials.length,
      tokens: run.trials.reduce((sum, trial) => sum + trial.tokens, 0),
      unchanged,
    };
  });
  const recommended = profiles.toSorted(
    (left, right) =>
      right.score - left.score ||
      left.cost - right.cost ||
      left.durationMs - right.durationMs,
  )[0] as ProfileComparison;

  return {
    baselineRunId: baseline.id,
    benchmarkId: baseline.benchmarkId,
    benchmarkVersion: baseline.benchmarkVersion,
    profiles,
    recommendedRunId: recommended.runId,
    schemaVersion: 1,
  };
}
