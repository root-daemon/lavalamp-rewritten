import type { FailureAnalysis } from './failures';
import type { AgentProfile } from './profiles';

export type BenchmarkFailureCategory =
  | 'environment'
  | 'retrieval'
  | 'reasoning'
  | 'execution'
  | 'verification'
  | 'resource'
  | 'submission'
  | 'unknown';

export interface TaskTrialResult {
  taskId: string;
  reward: number;
  status: 'completed' | 'failed' | 'timed_out' | 'cancelled';
  durationMs: number;
  tokens: number;
  cost: number;
  failureCategory?: BenchmarkFailureCategory;
  failureAnalysis?: FailureAnalysis;
  artifactPath?: string;
}

export interface BenchmarkRun {
  schemaVersion: 1;
  id: string;
  benchmarkId: string;
  benchmarkVersion: string;
  benchmarkReference?: string;
  scaffold: string;
  harborVersion?: string;
  model?: string;
  profile?: AgentProfile;
  profileFingerprint: string;
  seed?: number;
  observed: true;
  completedAt: string;
  trials: TaskTrialResult[];
}

export interface LeaderboardRow {
  rank: number;
  name: string;
  score: number;
  model?: string;
  scaffold?: string;
  cost?: number;
}

export interface PublicBenchmarkSnapshot {
  schemaVersion: 1;
  id: 'terminal-bench-2' | 'swe-atlas-qna' | 'cursorbench';
  name: string;
  version: string;
  description: string;
  taskCount?: number;
  categories: string[];
  metrics: string[];
  leaderboard: LeaderboardRow[];
  sourceUrls: string[];
  retrievedAt: string;
  stale: boolean;
  runnable: boolean;
  harborDataset?: string;
}
