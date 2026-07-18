import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type {
  GuiCiCheckSnapshot,
  GuiPullRequestSnapshot,
  GuiRepoStatusSnapshot,
} from './contracts';
import { workspaceDataDir } from '../storage/paths';
import { readWorkspaceStatus } from './workspace-status';

const CACHE_MS = 5000;

interface CacheEntry {
  expiresAt: number;
  value: GuiRepoStatusSnapshot;
}

export interface RepoStatusReader {
  read(): GuiRepoStatusSnapshot;
}

export function createRepoStatusReader(workspace: string): RepoStatusReader {
  let cache: CacheEntry | null = null;
  return {
    read() {
      const now = Date.now();
      if (cache !== null && cache.expiresAt > now) return cache.value;
      const value = readRepoStatus(workspace);
      cache = { expiresAt: now + CACHE_MS, value };
      return value;
    },
  };
}

export function readRepoStatus(workspace: string): GuiRepoStatusSnapshot {
  const repo = git(workspace, ['rev-parse', '--show-toplevel']);
  if (!repo.ok) {
    return {
      ahead: 0,
      behind: 0,
      branch: 'not a git repository',
      git: false,
      checks: [],
      remotes: [],
      repository: workspace,
      status: 'Git unavailable',
      worktrees: [],
    };
  }

  const workspaceStatus = readWorkspaceStatus(workspace);
  const repository = repo.stdout.trim() || workspace;
  const head = git(workspace, ['log', '-1', '--pretty=format:%h %s']);
  const remotes = readRemotes(workspace);
  const primaryWebUrl = remotes.find((remote) => remote.name === 'origin')?.webUrl
    ?? remotes.find((remote) => remote.webUrl !== undefined)?.webUrl;
  const branch = workspaceStatus.branch === 'detached'
    ? currentCommit(workspace)
    : workspaceStatus.branch;
  const branchQuery = encodeURIComponent(branch);
  const githubReview = readGithubReview(workspace);

  return {
    actionsUrl: primaryWebUrl === undefined
      ? undefined
      : `${primaryWebUrl}/actions?query=branch%3A${branchQuery}`,
    ahead: workspaceStatus.ahead,
    behind: workspaceStatus.behind,
    branch: workspaceStatus.branch,
    git: true,
    head: head.ok ? head.stdout.trim() : undefined,
    pullRequestUrl: primaryWebUrl === undefined
      ? undefined
      : `${primaryWebUrl}/pulls?q=is%3Apr+head%3A${branchQuery}`,
    pullRequest: githubReview.pullRequest,
    remotes,
    repository,
    status: workspaceStatus.summary,
    upstream: workspaceStatus.upstream,
    webUrl: primaryWebUrl,
    checks: githubReview.checks,
    worktrees: parseWorktrees(
      git(workspace, ['worktree', 'list', '--porcelain']).stdout ?? '',
      repository,
    ),
  };
}

export function formatRepoStatusRows(status: GuiRepoStatusSnapshot): string[] {
  if (!status.git) return ['No git repository found.'];
  return [
    `repository: ${status.repository}`,
    `branch: ${status.branch}${status.upstream === undefined ? '' : ` -> ${status.upstream}`}`,
    `head: ${status.head ?? 'No commits yet'}`,
    `sync: ahead ${status.ahead} · behind ${status.behind}`,
    `status: ${status.status}`,
    ...(status.pullRequest === undefined
      ? []
      : [
          `pull request: #${status.pullRequest.number} ${status.pullRequest.title}`,
          `review: ${status.pullRequest.reviewDecision ?? 'pending'} · merge: ${status.pullRequest.mergeStateStatus ?? status.pullRequest.state}`,
          `checks: ${checkSummary(status.checks)}`,
        ]),
    '',
    'remotes:',
    ...(status.remotes.length === 0
      ? ['No remotes configured.']
      : status.remotes.map((remote) => `${remote.name}: ${remote.url}`)),
    '',
    'links:',
    ...(status.webUrl === undefined
      ? ['No GitHub remote detected.']
      : [
          `github: ${status.webUrl}`,
          `pull requests: ${status.pullRequestUrl ?? 'unavailable'}`,
          `actions: ${status.actionsUrl ?? 'unavailable'}`,
        ]),
    '',
    'worktrees:',
    ...(status.worktrees.length === 0
      ? ['No worktrees found.']
      : status.worktrees.map((worktree) => {
          const branchLabel = worktree.branch ?? worktree.head ?? 'unknown';
          const current = worktree.current ? ' *' : '';
          return `${branchLabel.padEnd(24)} ${worktree.path}${current}`;
        })),
  ];
}

function checkSummary(checks: GuiCiCheckSnapshot[]): string {
  if (checks.length === 0) return 'unavailable';
  const counts = checks.reduce(
    (acc, check) => {
      const bucket = (check.bucket ?? check.state).toLowerCase();
      if (bucket.includes('pass') || bucket === 'success' || bucket === 'completed') {
        acc.pass += 1;
      } else if (bucket.includes('fail') || bucket === 'failure' || bucket === 'cancelled') {
        acc.fail += 1;
      } else {
        acc.pending += 1;
      }
      return acc;
    },
    { fail: 0, pass: 0, pending: 0 },
  );
  return `${counts.pass} passing · ${counts.fail} failing · ${counts.pending} pending`;
}

function readGithubReview(workspace: string): {
  checks: GuiCiCheckSnapshot[];
  pullRequest?: GuiPullRequestSnapshot;
} {
  const pr = ghJson(workspace, [
    'pr',
    'view',
    '--json',
    'number,title,state,url,reviewDecision,mergeStateStatus,isDraft',
  ]);
  if (!pr.ok) return { checks: [] };
  const pullRequest = parsePullRequest(pr.value);
  if (pullRequest === undefined) return { checks: [] };
  return {
    checks: readGithubChecks(workspace),
    pullRequest,
  };
}

function readGithubChecks(workspace: string): GuiCiCheckSnapshot[] {
  const checks = ghJson(workspace, [
    'pr',
    'checks',
    '--json',
    'name,state,bucket,link',
  ]);
  if (!checks.ok || !Array.isArray(checks.value)) return [];
  return checks.value.flatMap((value) => {
    if (value === null || typeof value !== 'object') return [];
    const check = value as Record<string, unknown>;
    const name = typeof check.name === 'string' ? check.name : undefined;
    const state = typeof check.state === 'string' ? check.state : undefined;
    if (name === undefined || state === undefined) return [];
    return [{
      bucket: typeof check.bucket === 'string' ? check.bucket : undefined,
      name,
      state,
      url: typeof check.link === 'string' ? check.link : undefined,
    }];
  });
}

function parsePullRequest(value: unknown): GuiPullRequestSnapshot | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const pr = value as Record<string, unknown>;
  const number = typeof pr.number === 'number' ? pr.number : undefined;
  const title = typeof pr.title === 'string' ? pr.title : undefined;
  const state = typeof pr.state === 'string' ? pr.state : undefined;
  const url = typeof pr.url === 'string' ? pr.url : undefined;
  if (number === undefined || title === undefined || state === undefined || url === undefined) {
    return undefined;
  }
  return {
    isDraft: typeof pr.isDraft === 'boolean' ? pr.isDraft : undefined,
    mergeStateStatus: typeof pr.mergeStateStatus === 'string' ? pr.mergeStateStatus : undefined,
    number,
    reviewDecision: typeof pr.reviewDecision === 'string' ? pr.reviewDecision : undefined,
    state,
    title,
    url,
  };
}

function ghJson(
  workspace: string,
  args: string[],
): { ok: true; value: unknown } | { ok: false; error: string } {
  const result = spawnSync('gh', args, {
    cwd: workspace,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 512 * 1024,
    shell: false,
    timeout: 2000,
  });
  if (result.status !== 0) {
    return {
      error: (result.stderr || result.error?.message || 'gh command failed').trim(),
      ok: false,
    };
  }
  try {
    return { ok: true, value: JSON.parse(result.stdout) as unknown };
  } catch {
    return { error: 'gh returned invalid JSON', ok: false };
  }
}

export function createRepoWorktree(
  workspace: string,
  branch: string,
  targetPath?: string,
): { ok: true; path: string; branch: string } | { ok: false; error: string } {
  const repo = git(workspace, ['rev-parse', '--show-toplevel']);
  if (!repo.ok) return { error: 'No git repository found.', ok: false };

  const normalizedBranch = branch.trim();
  if (!isSafeBranchName(normalizedBranch)) {
    return {
      error: 'branch must use letters, numbers, slash, dot, underscore, or dash',
      ok: false,
    };
  }

  const path = targetPath === undefined || targetPath.trim().length === 0
    ? join(workspaceDataDir(workspace), 'worktrees', cleanSegment(normalizedBranch))
    : resolve(workspace, targetPath.trim());

  mkdirSync(dirname(path), { recursive: true });
  const result = git(workspace, ['worktree', 'add', '-b', normalizedBranch, path]);
  if (!result.ok) {
    return { error: result.error || 'git worktree add failed', ok: false };
  }
  return { branch: normalizedBranch, ok: true, path };
}

function isSafeBranchName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 160 &&
    !value.startsWith('-') &&
    !value.includes('..') &&
    !value.includes('@{') &&
    !value.endsWith('/') &&
    !value.endsWith('.lock') &&
    /^[A-Za-z0-9._/-]+$/.test(value)
  );
}

function cleanSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'task';
}

function readRemotes(workspace: string): GuiRepoStatusSnapshot['remotes'] {
  const remoteNames = git(workspace, ['remote']);
  if (!remoteNames.ok) return [];
  return remoteNames.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((name) => {
      const url = git(workspace, ['remote', 'get-url', name]);
      if (!url.ok) return [];
      const remoteUrl = url.stdout.trim();
      return [{
        name,
        url: remoteUrl,
        webUrl: githubWebUrl(remoteUrl) ?? undefined,
      }];
    });
}

function currentCommit(workspace: string): string {
  const commit = git(workspace, ['rev-parse', '--short', 'HEAD']);
  return commit.ok ? commit.stdout.trim() : 'detached';
}

function githubWebUrl(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim().replace(/\.git$/, '');
  const ssh = /^git@github\.com:([^/]+)\/(.+)$/.exec(trimmed);
  if (ssh !== null) return `https://github.com/${ssh[1]}/${ssh[2]}`;
  const https = /^https:\/\/github\.com\/([^/]+)\/(.+)$/.exec(trimmed);
  if (https !== null) return `https://github.com/${https[1]}/${https[2]}`;
  return null;
}

function parseWorktrees(
  raw: string,
  currentRepository: string,
): GuiRepoStatusSnapshot['worktrees'] {
  const worktrees: GuiRepoStatusSnapshot['worktrees'] = [];
  let current: GuiRepoStatusSnapshot['worktrees'][number] | null = null;
  for (const line of raw.split('\n')) {
    if (line.length === 0) {
      if (current !== null) worktrees.push(current);
      current = null;
      continue;
    }
    const [key, ...rest] = line.split(' ');
    const value = rest.join(' ');
    if (key === 'worktree') {
      if (current !== null) worktrees.push(current);
      current = {
        current: value === currentRepository,
        path: value,
      };
    } else if (current !== null && key === 'HEAD') {
      current.head = value.slice(0, 7);
    } else if (current !== null && key === 'branch') {
      current.branch = value.replace(/^refs\/heads\//, '');
    }
  }
  if (current !== null) worktrees.push(current);
  return worktrees;
}

function git(
  workspace: string,
  args: string[],
): { ok: true; stdout: string } | { ok: false; stdout?: string; error: string } {
  const result = spawnSync('git', args, {
    cwd: workspace,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 1024 * 1024,
    shell: false,
  });
  if (result.status === 0) return { ok: true, stdout: result.stdout ?? '' };
  return {
    error: (result.stderr || result.error?.message || 'git command failed').trim(),
    ok: false,
    stdout: result.stdout ?? '',
  };
}
