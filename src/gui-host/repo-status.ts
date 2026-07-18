import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { GuiRepoStatusSnapshot } from './contracts';
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
    remotes,
    repository,
    status: workspaceStatus.summary,
    upstream: workspaceStatus.upstream,
    webUrl: primaryWebUrl,
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
