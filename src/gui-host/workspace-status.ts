import { spawnSync } from 'node:child_process';
import type { GuiWorkspaceStatusSnapshot } from './contracts';

const CACHE_MS = 2000;
const MAX_CHANGES = 24;
const MAX_DIFF_STAT_LINES = 16;

interface CacheEntry {
  expiresAt: number;
  value: GuiWorkspaceStatusSnapshot;
}

export interface WorkspaceStatusReader {
  read(): GuiWorkspaceStatusSnapshot;
}

export function createWorkspaceStatusReader(workspace: string): WorkspaceStatusReader {
  let cache: CacheEntry | null = null;
  return {
    read() {
      const now = Date.now();
      if (cache !== null && cache.expiresAt > now) return cache.value;
      const value = readWorkspaceStatus(workspace);
      cache = { expiresAt: now + CACHE_MS, value };
      return value;
    },
  };
}

export function readWorkspaceStatus(workspace: string): GuiWorkspaceStatusSnapshot {
  const status = git(workspace, ['status', '--short', '--branch', '--untracked-files=normal']);
  if (!status.ok) {
    return {
      ahead: 0,
      behind: 0,
      branch: 'not a git repository',
      changes: [],
      clean: true,
      diffStat: [],
      error: status.error,
      git: false,
      summary: 'Git unavailable',
    };
  }

  const lines = status.stdout.split('\n').filter((line) => line.trim().length > 0);
  const branch = parseBranch(lines[0] ?? '## unknown');
  const changes = lines.slice(1).map(parseChange).slice(0, MAX_CHANGES);
  const counts = changes.reduce(
    (acc, change) => {
      if (change.untracked) acc.untracked += 1;
      if (change.staged) acc.staged += 1;
      if (change.unstaged) acc.unstaged += 1;
      return acc;
    },
    { staged: 0, unstaged: 0, untracked: 0 },
  );
  const diffStat = [...diffStatLines(workspace, ['diff', '--stat', '--']), ...diffStatLines(workspace, ['diff', '--cached', '--stat', '--'])]
    .filter((line, index, rows) => rows.indexOf(line) === index)
    .slice(0, MAX_DIFF_STAT_LINES);
  const clean = lines.length <= 1;
  const parts = [
    `${changes.length} changed`,
    counts.staged > 0 ? `${counts.staged} staged` : '',
    counts.unstaged > 0 ? `${counts.unstaged} unstaged` : '',
    counts.untracked > 0 ? `${counts.untracked} untracked` : '',
    branch.ahead > 0 ? `${branch.ahead} ahead` : '',
    branch.behind > 0 ? `${branch.behind} behind` : '',
  ].filter(Boolean);

  return {
    ahead: branch.ahead,
    behind: branch.behind,
    branch: branch.branch,
    changes,
    clean,
    diffStat,
    git: true,
    summary: clean && branch.ahead === 0 && branch.behind === 0 ? 'Clean working tree' : parts.join(' · '),
    upstream: branch.upstream,
  };
}

function diffStatLines(workspace: string, args: string[]): string[] {
  const result = git(workspace, args);
  if (!result.ok) return [];
  return result.stdout.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
}

function parseBranch(line: string): {
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
} {
  const text = line.replace(/^##\s*/, '');
  const trackingMatch = /^(.*?)\.\.\.([^\s]+)(?:\s+\[(.*)\])?$/.exec(text);
  if (trackingMatch !== null) {
    const flags = trackingMatch[3] ?? '';
    return {
      ahead: countFlag(flags, 'ahead'),
      behind: countFlag(flags, 'behind'),
      branch: trackingMatch[1] ?? 'unknown',
      upstream: trackingMatch[2],
    };
  }
  return { ahead: 0, behind: 0, branch: text || 'unknown' };
}

function countFlag(flags: string, name: 'ahead' | 'behind'): number {
  const match = new RegExp(`${name} (\\d+)`).exec(flags);
  return match === null ? 0 : Number(match[1]);
}

function parseChange(line: string): GuiWorkspaceStatusSnapshot['changes'][number] {
  const stagedCode = line[0] ?? ' ';
  const unstagedCode = line[1] ?? ' ';
  const untracked = stagedCode === '?' && unstagedCode === '?';
  return {
    path: line.slice(3).trim(),
    staged: !untracked && stagedCode !== ' ' && stagedCode !== '?',
    status: `${stagedCode}${unstagedCode}`.trim(),
    unstaged: !untracked && unstagedCode !== ' ' && unstagedCode !== '?',
    untracked,
  };
}

function git(
  workspace: string,
  args: string[],
): { ok: true; stdout: string } | { ok: false; error: string } {
  const result = spawnSync('git', args, {
    cwd: workspace,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 1024 * 1024,
    shell: false,
  });
  if (result.status === 0) return { ok: true, stdout: result.stdout };
  return {
    error: (result.stderr || result.error?.message || 'git command failed').trim(),
    ok: false,
  };
}
