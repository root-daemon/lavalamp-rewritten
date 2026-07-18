#!/usr/bin/env bash
set -euo pipefail

cat > /app/src/score.ts <<'EOF'
export interface TrialResult {
  reward: number;
  status: 'completed' | 'failed' | 'timed_out';
}

export function scoreTrials(trials: TrialResult[]): number {
  if (trials.length === 0) {
    return 0;
  }
  return (
    trials.reduce((total, trial) => total + trial.reward, 0) / trials.length
  );
}
EOF
