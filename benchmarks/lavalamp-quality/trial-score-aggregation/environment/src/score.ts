export interface TrialResult {
  reward: number;
  status: 'completed' | 'failed' | 'timed_out';
}

export function scoreTrials(trials: TrialResult[]): number {
  const completed = trials.filter((trial) => trial.status === 'completed');
  if (completed.length === 0) {
    return 0;
  }
  return (
    completed.reduce((total, trial) => total + trial.reward, 0) /
    completed.length
  );
}
