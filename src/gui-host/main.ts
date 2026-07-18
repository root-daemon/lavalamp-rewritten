import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { login as cloudflareLogin } from '../auth/login';
import { openBrowser } from '../auth/browser';
import { AnalyticsStore, formatAnalyticsRows } from '../analytics';
import { BenchmarkCatalog } from '../benchmarks/catalog';
import { listCustomBenchmarks } from '../benchmarks/custom';
import { BenchmarkRunStore } from '../benchmarks/run-store';
import { officialBenchmarkSources } from '../benchmarks/sources';
import {
  type BenchmarkBrowserTab,
  createBenchmarkBrowserModel,
  renderBenchmarkDetails,
} from '../tui/benchmarks';
import { BUILD_MODEL, listModels } from '../config/models';
import { resolveRuntimeRoute, routeSummary } from '../config/runtime-route';
import { resolveConfig, updateConfig } from '../config/user-config';
import type { AgentBackend } from '../runtime/backend';
import { parseBackend } from '../runtime/backend';
import { isAllowAll, loadAutorun, setAllowAll } from '../permissions/autorun';
import { getDefaultRules, loadRules } from '../permissions/rules';
import { copyTextToClipboard, pasteImageFromClipboard } from '../storage/clipboard';
import { benchmarkCacheDir, benchmarkWorkspaceDir } from '../storage/paths';
import { discoverSkills } from '../tui/discover';
import { HELP_COMMANDS, HELP_KEYS } from '../tui/slash-data';
import {
  listSessions as listChatSessions,
  loadSession,
} from '../tui/sessions';
import type { GuiCommandResult } from './contracts';
import { GuiRuntime } from './runtime';
import { createGuiHostServer } from './server';
import { readWorkspaceStatus } from './workspace-status';

export interface GuiHostMainOptions {
  serverPath: string;
  workspace: string;
  backend?: AgentBackend;
  model?: string;
  agentName?: string;
  sessionId?: string;
  port?: number;
  token?: string;
}

export interface GuiCommandDeps {
  cloudflareLogin?: () => Promise<unknown>;
  openBrowser?: (url: string) => Promise<boolean>;
  pasteImageFromClipboard?: (workspaceRoot: string) => Promise<string | null>;
}

export async function runGuiHost(options: GuiHostMainOptions): Promise<void> {
  const token = options.token ?? randomUUID();
  const runtime = GuiRuntime.create({
    agentName: options.agentName,
    backend: options.backend,
    model: options.model,
    serverPath: options.serverPath,
    sessionId: options.sessionId,
    workspace: options.workspace,
  });
  const server = createGuiHostServer({
    listModels,
    listSessions: () =>
      listChatSessions().map((session) => ({
        messageCount: session.messageCount,
        prompt: session.name,
        savedAt: session.savedAt,
        sessionId: session.id,
      })),
    loadSession: (sessionId) =>
      loadSession(sessionId)
        ?.filter((message) => message.role !== 'system')
        .map((message) => ({
          content: message.content,
          role: message.role as 'user' | 'assistant',
        })) ?? null,
    port: options.port,
    runCommand: (command) =>
      runGuiCommand(runtime, options.workspace, options.serverPath, command),
    runtime,
    token,
    workspace: options.workspace,
  });

  process.stdout.write(`LAVALAMP_GUI_READY ${server.port} ${token}\n`);
  const runtimeStart = runtime
    .start({ model: options.model, workspace: options.workspace })
    .catch((error: unknown) => {
      runtime.store.append({
        message: error instanceof Error ? error.message : String(error),
        type: 'turn.failed',
      });
    });

  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      clearInterval(orphanCheck);
      server.stop(true);
      await runtimeStart;
      await runtime.shutdown();
      resolve();
    };
    const orphanCheck = setInterval(() => {
      if (process.ppid <= 1) void stop();
    }, 1000);
    process.once('SIGINT', () => void stop());
    process.once('SIGTERM', () => void stop());
  });
}

export async function runGuiCommand(
  runtime: GuiRuntime,
  workspace: string,
  serverPath: string,
  raw: string,
  deps: GuiCommandDeps = {},
): Promise<GuiCommandResult> {
  const command = raw.trim();
  const cmd = command.split(/\s+/)[0]?.toLowerCase() ?? '';
  const arg = command.slice(cmd.length).trim();
  switch (cmd) {
    case '/help':
      return {
        title: '/help',
        rows: [
          'Commands:',
          ...HELP_COMMANDS.map(([name, desc]) => `${name.padEnd(14)} ${desc}`),
          '',
          'Keys:',
          ...HELP_KEYS.map(([key, desc]) => `${key.padEnd(14)} ${desc}`),
          '',
          'GUI:',
          '/repo          Show repo, branch, remote, worktrees, PR and CI links',
          '/changes       Show git branch, changed files, and diff stat',
          '/diff [path]   Show working tree diff',
        ],
      };
    case '/clear':
      runtime.cancel();
      await runtime.restart();
      runtime.store.resetConversation();
      return { title: '/clear', rows: ['Started a clean GUI session.'] };
    case '/sessions': {
      const sessions = listChatSessions();
      if (arg.length > 0) {
        const matches = sessions.filter(
          (session) =>
            session.id === arg ||
            session.id.startsWith(arg) ||
            session.name.toLowerCase().includes(arg.toLowerCase()),
        );
        if (matches.length === 0) {
          return { title: '/sessions', rows: [`No session matches: ${arg}`] };
        }
        if (matches.length > 1) {
          return {
            title: '/sessions',
            rows: [
              `Multiple sessions match: ${arg}`,
              ...matches.map(
                (session) =>
                  `${session.id}  ${session.name}  ${session.messageCount} messages`,
              ),
            ],
          };
        }
        const chosen = matches[0];
        if (chosen === undefined) {
          return { title: '/sessions', rows: [`No session matches: ${arg}`] };
        }
        const messages = loadSession(chosen.id)
          ?.filter((message) => message.role !== 'system')
          .map((message) => ({
            content: message.content,
            role: message.role as 'user' | 'assistant',
          }));
        if (messages === undefined) {
          return { title: '/sessions', rows: [`Session could not be loaded: ${chosen.id}`] };
        }
        runtime.store.replaceMessages(messages);
        return {
          title: '/sessions',
          rows: [`loaded: ${chosen.id}`, chosen.name, `${messages.length} messages`],
        };
      }
      return {
        title: '/sessions',
        rows:
          sessions.length === 0
            ? ['No saved sessions.']
            : [
                'usage: /sessions <id-or-search>',
                ...sessions.map(
                  (session) =>
                    `${session.id}  ${session.name}  ${session.messageCount} messages`,
                ),
              ],
      };
    }
    case '/compact': {
      const before = runtime.store.snapshot().messages.length;
      await runtime.compact();
      const after = runtime.store.snapshot().messages.length;
      return {
        title: '/compact',
        rows: [`Kept last ${after} of ${before} messages.`],
      };
    }
    case '/memory':
      return readProjectMemory(workspace);
    case '/model':
    case '/models': {
      if (arg.length > 0) {
        await runtime.setModel(arg);
        const backend = runtime.store.snapshot().backend ?? 'flue';
        updateConfig(backend === 'codex' ? { codexModel: arg } : { defaultModel: arg });
        return {
          title: cmd,
          rows: [`model set: ${arg}`],
        };
      }
      const models = (await runtime.listModels()).length > 0
        ? await runtime.listModels()
        : listModels();
      return {
        title: cmd,
        rows: models.map((model) =>
          `${model.id}${model.displayName === undefined ? '' : `  ${model.displayName}`}`,
        ),
      };
    }
    case '/backend': {
      if (arg.length > 0) {
        const backend = parseBackend(arg);
        if (backend === undefined) {
          return { title: '/backend', rows: ['usage: /backend flue|codex'] };
        }
        await runtime.setBackend(backend);
        updateConfig({ backend });
        return {
          title: '/backend',
          rows: [`backend set: ${backend}; started a clean session`],
        };
      }
      const snapshot = runtime.store.snapshot();
      return {
        title: '/backend',
        rows: [
          `backend: ${snapshot.backend ?? 'flue'}`,
          'usage: /backend flue|codex',
        ],
      };
    }
    case '/login': {
      const rows: string[] = [];
      try {
        await runtime.login({
          cloudflareLogin:
            deps.cloudflareLogin ??
            (() => cloudflareLogin({ allowManualPrompt: false })),
          onProgress: (event) => {
            rows.push(event.message);
            if (event.detail !== undefined) rows.push(event.detail);
          },
          openBrowser: deps.openBrowser ?? openBrowser,
        });
      } catch (error) {
        rows.push(error instanceof Error ? error.message : String(error));
      }
      return {
        title: '/login',
        rows: rows.length > 0 ? rows : ['Login complete.'],
      };
    }
    case '/benchmark':
    case '/benchmarks':
      return readBenchmarkSummary(workspace, arg);
    case '/gateway':
      return setOrReadGateway(runtime, workspace, arg);
    case '/usage': {
      const usage = runtime.store.snapshot().usage;
      return {
        title: '/usage',
        rows: [
          `total: ${usage.totalTokens} tokens - $${usage.cost.toFixed(4)}`,
          `input: ${usage.input} - output: ${usage.output}`,
          `cache read: ${usage.cacheRead} - cache write: ${usage.cacheWrite}`,
        ],
      };
    }
    case '/analytics':
      return readAnalyticsReport(workspace, arg);
    case '/rate':
      return rateCurrentRun(runtime, arg);
    case '/workspace':
      return readWorkspaceSummary(workspace);
    case '/repo':
      return readRepoOverview(workspace);
    case '/changes':
      return readGitChanges(workspace);
    case '/diff':
      return readGitDiff(workspace, arg);
    case '/skills': {
      const skills = discoverSkills(workspace);
      return {
        title: '/skills',
        rows: skills.length === 0 ? ['No skills found.'] : skills.map((skill) => `#${skill}`),
      };
    }
    case '/mcp':
      return readMcpConfig();
    case '/tools':
      return readRegisteredTools(serverPath);
    case '/subagents':
      return readSubagents(runtime);
    case '/sudo':
      return setOrReadSudo(workspace, arg);
    case '/permissions': {
      const rules = loadRules(workspace);
      return {
        title: '/permissions',
        rows: (rules.length > 0 ? rules : getDefaultRules()).map((rule) => {
          const qualifier =
            rule.commandClass !== undefined
              ? ` (${rule.commandClass} shell)`
              : rule.argPattern !== undefined
                ? ` (${rule.argPattern})`
                : '';
          return `${rule.action.padEnd(5)} ${rule.tool}${qualifier}`;
        }),
      };
    }
    case '/copy':
    {
      const transcript = runtime.store.snapshot().messages
        .map((message) => `${message.role === 'user' ? '> ' : '~ '}${message.content}`)
        .join('\n\n');
      return {
        title: '/copy',
        rows: [
          transcript.length > 0 && copyTextToClipboard(transcript)
            ? 'Session copied to clipboard.'
            : 'No transcript available to copy.',
        ],
      };
    }
    case '/build':
      await runtime.setMode('build');
      return {
        title: '/build',
        rows: ['mode set: build'],
      };
    case '/plan': {
      const nextMode = runtime.store.snapshot().mode === 'plan' ? 'build' : 'plan';
      await runtime.setMode(nextMode);
      return {
        title: '/plan',
        rows: [`mode set: ${nextMode}`],
      };
    }
    case '/ask':
      await runtime.setMode('ask');
      return {
        title: '/ask',
        rows: ['mode set: ask'],
      };
    case '/undo': {
      if (runtime.store.snapshot().messages.length === 0) {
        return { title: '/undo', rows: ['nothing to undo'] };
      }
      const result = await runtime.undo();
      const restoreMsg = result.restoreError !== undefined
        ? ` (failed to restore backup: ${result.restoreError})`
        : result.restoredWorkspace
          ? ' and restored workspace files'
          : '';
      return {
        title: '/undo',
        rows: [`removed last ${result.removedMessages} messages${restoreMsg}`],
      };
    }
    case '/paste-image': {
      const imgPath = await (deps.pasteImageFromClipboard ?? pasteImageFromClipboard)(
        workspace,
      );
      if (imgPath === null || imgPath.length === 0) {
        return {
          title: '/paste-image',
          rows: ['No image found in clipboard.'],
        };
      }
      const tag = runtime.attachImage(imgPath);
      return {
        insertText: tag,
        title: '/paste-image',
        rows: [`Attached ${tag}`, imgPath],
      };
    }
    case '/quit':
      return { title: '/quit', rows: ['Close the Lavalamp window to exit.'] };
    default:
      return { title: cmd || '/command', rows: [`unknown command: ${cmd}`] };
  }
}

function readSubagents(runtime: GuiRuntime): GuiCommandResult {
  const subagents = runtime.store.snapshot().subagents;
  if (subagents.length === 0) {
    return { title: '/subagents', rows: ['No subagents.'] };
  }
  return {
    title: '/subagents',
    rows: subagents.map((subagent) => {
      const pid = subagent.pid === undefined ? '' : ` pid:${subagent.pid}`;
      const error = subagent.error === undefined ? '' : ` error:${subagent.error}`;
      const seconds = Math.max(0, Math.round(subagent.durationMs / 1000));
      return `${subagent.id.padEnd(6)} ${subagent.status.padEnd(9)} ${seconds}s${pid}  ${subagent.query}${error}`;
    }),
  };
}

function runGit(
  workspace: string,
  args: string[],
): { stdout: string; stderr: string; status: number | null; error?: Error } {
  const result = spawnSync('git', args, {
    cwd: workspace,
    encoding: 'utf8',
    maxBuffer: 512 * 1024,
  });
  return {
    error: result.error,
    status: result.status,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  };
}

function readGitChanges(workspace: string): GuiCommandResult {
  const status = readWorkspaceStatus(workspace);
  if (!status.git) return { title: '/changes', rows: ['No git repository found.'] };

  return {
    title: '/changes',
    rows: [
      `branch: ${status.branch}${status.upstream === undefined ? '' : ` -> ${status.upstream}`}`,
      `changed files: ${status.changes.length}`,
      ...(status.changes.length === 0
        ? ['Working tree clean.']
        : status.changes.map((change) => `${change.status.padEnd(2)} ${change.path}`)),
      ...(status.diffStat.length > 0 ? ['', 'diff stat:', ...status.diffStat] : []),
    ],
  };
}

function readGitDiff(workspace: string, arg: string): GuiCommandResult {
  const repo = runGit(workspace, ['rev-parse', '--show-toplevel']);
  if (repo.status !== 0) {
    return { title: '/diff', rows: ['No git repository found.'] };
  }
  const pathArgs = arg.length > 0 ? ['--', arg] : ['--'];
  const working = runGit(workspace, ['diff', ...pathArgs]);
  if (working.status !== 0) {
    return { title: '/diff', rows: [`git diff failed: ${firstGitError(working)}`] };
  }
  const cached = working.stdout.trim().length > 0
    ? { stdout: '', status: 0, stderr: '' }
    : runGit(workspace, ['diff', '--cached', ...pathArgs]);
  if (cached.status !== 0) {
    return { title: '/diff', rows: [`git diff --cached failed: ${firstGitError(cached)}`] };
  }
  const diff = working.stdout.trim().length > 0 ? working.stdout : cached.stdout;
  if (diff.trim().length === 0) {
    return {
      title: arg.length > 0 ? `/diff ${arg}` : '/diff',
      rows: ['No working tree diff.'],
    };
  }
  const rows = diff.trimEnd().split('\n');
  const limit = 220;
  return {
    title: arg.length > 0 ? `/diff ${arg}` : '/diff',
    rows: rows.length > limit
      ? [...rows.slice(0, limit), `… truncated ${rows.length - limit} lines`]
      : rows,
  };
}

function firstGitError(result: { error?: Error; stderr: string; status: number | null }): string {
  if (result.error !== undefined) return result.error.message;
  const stderr = result.stderr.trim();
  return stderr.length > 0 ? (stderr.split('\n')[0] ?? stderr) : `exit ${result.status ?? 'unknown'}`;
}

function readWorkspaceSummary(workspace: string): GuiCommandResult {
  const status = readWorkspaceStatus(workspace);
  return {
    title: '/workspace',
    rows: [
      `workspace: ${workspace}`,
      `branch: ${status.branch}${status.upstream === undefined ? '' : ` -> ${status.upstream}`}`,
      `status: ${status.summary}`,
      '',
      'changes:',
      ...(status.changes.length === 0
        ? ['No file changes.']
        : status.changes.map((change) => `${change.status.padEnd(2)} ${change.path}`)),
      '',
      'diff stat:',
      ...(status.diffStat.length === 0 ? ['No diff stat.'] : status.diffStat),
    ],
  };
}

function readRepoOverview(workspace: string): GuiCommandResult {
  const repo = runGit(workspace, ['rev-parse', '--show-toplevel']);
  if (repo.status !== 0) {
    return { title: '/repo', rows: ['No git repository found.'] };
  }
  const status = readWorkspaceStatus(workspace);
  const repoRoot = repo.stdout.trim() || workspace;
  const head = runGit(workspace, ['log', '-1', '--pretty=format:%h %s']);
  const remoteNames = runGit(workspace, ['remote']);
  const remotes = remoteNames.status === 0
    ? remoteNames.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    : [];
  const remoteRows = remotes.flatMap((name) => {
    const url = runGit(workspace, ['remote', 'get-url', name]);
    if (url.status !== 0) return [`${name}: unavailable`];
    return [`${name}: ${url.stdout.trim()}`];
  });
  const originUrl = remoteRows
    .find((row) => row.startsWith('origin: '))
    ?.slice('origin: '.length);
  const webUrl = originUrl === undefined ? null : githubWebUrl(originUrl);
  const branch = status.branch === 'detached' ? currentCommit(workspace) : status.branch;
  const branchQuery = encodeURIComponent(branch);
  const worktrees = parseWorktrees(runGit(workspace, ['worktree', 'list', '--porcelain']).stdout);

  return {
    title: '/repo',
    rows: [
      `repository: ${repoRoot}`,
      `branch: ${status.branch}${status.upstream === undefined ? '' : ` -> ${status.upstream}`}`,
      `head: ${head.status === 0 ? head.stdout.trim() : firstGitError(head)}`,
      `sync: ahead ${status.ahead ?? 0} · behind ${status.behind ?? 0}`,
      `status: ${status.summary}`,
      '',
      'remotes:',
      ...(remoteRows.length === 0 ? ['No remotes configured.'] : remoteRows),
      '',
      'links:',
      ...(webUrl === null
        ? ['No GitHub remote detected.']
        : [
            `github: ${webUrl}`,
            `pull requests: ${webUrl}/pulls?q=is%3Apr+head%3A${branchQuery}`,
            `actions: ${webUrl}/actions?query=branch%3A${branchQuery}`,
          ]),
      '',
      'worktrees:',
      ...(worktrees.length === 0
        ? ['No worktrees found.']
        : worktrees.map((worktree) => {
            const branchLabel = worktree.branch ?? worktree.head ?? 'unknown';
            return `${branchLabel.padEnd(24)} ${worktree.path}`;
          })),
    ],
  };
}

function currentCommit(workspace: string): string {
  const commit = runGit(workspace, ['rev-parse', '--short', 'HEAD']);
  return commit.status === 0 ? commit.stdout.trim() : 'detached';
}

function githubWebUrl(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim().replace(/\.git$/, '');
  const ssh = /^git@github\.com:([^/]+)\/(.+)$/.exec(trimmed);
  if (ssh !== null) return `https://github.com/${ssh[1]}/${ssh[2]}`;
  const https = /^https:\/\/github\.com\/([^/]+)\/(.+)$/.exec(trimmed);
  if (https !== null) return `https://github.com/${https[1]}/${https[2]}`;
  return null;
}

function parseWorktrees(raw: string): Array<{ path: string; head?: string; branch?: string }> {
  const worktrees: Array<{ path: string; head?: string; branch?: string }> = [];
  let current: { path: string; head?: string; branch?: string } | null = null;
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
      current = { path: value };
    } else if (current !== null && key === 'HEAD') {
      current.head = value.slice(0, 7);
    } else if (current !== null && key === 'branch') {
      current.branch = value.replace(/^refs\/heads\//, '');
    }
  }
  if (current !== null) worktrees.push(current);
  return worktrees;
}

function readProjectMemory(workspace: string): GuiCommandResult {
  try {
    const lines = readFileSync(join(workspace, 'AGENTS.md'), 'utf8')
      .split('\n')
      .slice(0, 30);
    return { title: '/memory', rows: lines.length === 0 ? ['AGENTS.md is empty.'] : lines };
  } catch {
    return { title: '/memory', rows: ['No AGENTS.md found.'] };
  }
}

function readAnalyticsReport(workspace: string, arg: string): GuiCommandResult {
  const scope = arg === 'global' ? 'global' : 'project';
  const range =
    arg === 'session' ||
    arg === '7d' ||
    arg === '30d' ||
    arg === '90d' ||
    arg === 'all'
      ? arg
      : '30d';
  try {
    const store = new AnalyticsStore();
    try {
      const report = store.report({ range, scope, workspaceRoot: workspace });
      return {
        title: `/analytics ${arg || '30d'}`,
        rows: formatAnalyticsRows(report).map((row) => row.trimEnd()),
      };
    } finally {
      store.close();
    }
  } catch {
    return { title: '/analytics', rows: ['Analytics unavailable.'] };
  }
}

function rateCurrentRun(runtime: GuiRuntime, arg: string): GuiCommandResult {
  if (arg !== 'helpful' && arg !== 'unhelpful') {
    return {
      title: '/rate',
      rows: ['usage: /rate helpful|unhelpful'],
    };
  }
  runtime.rate(arg);
  return {
    title: '/rate',
    rows: [`current GUI run rated ${arg}`],
  };
}

async function setOrReadGateway(
  runtime: GuiRuntime,
  workspace: string,
  arg: string,
): Promise<GuiCommandResult> {
  if (arg.length > 0) {
    if (runtime.store.snapshot().processing) {
      return {
        title: '/gateway',
        rows: ['Cannot change Gateway while a prompt is running.'],
      };
    }
    if (arg.toLowerCase() === 'off') {
      updateConfig({
        gatewayEnabled: false,
        preferredProviderRoute: 'direct',
      });
      await runtime.restart();
      return { title: '/gateway', rows: ['AI Gateway disabled.'] };
    }
    updateConfig({
      gatewayEnabled: true,
      gatewayId: arg,
      preferredProviderRoute: 'gateway',
    });
    await runtime.restart();
    return { title: '/gateway', rows: [`AI Gateway enabled: ${arg}`] };
  }

  const config = resolveConfig();
  const route = resolveRuntimeRoute({
    config,
    env: process.env as Record<string, string | undefined>,
    model: runtime.store.snapshot().model,
    preferredModel: BUILD_MODEL,
  });
  return {
    title: '/gateway',
    rows: [
      `gateway: ${config.gatewayEnabled ? 'on' : 'off'}`,
      `id: ${config.gatewayId || '(none)'}`,
      `route: ${routeSummary(route)}`,
      'use /gateway <id> to enable · /gateway off to disable',
      `workspace: ${workspace}`,
    ],
  };
}

function setOrReadSudo(workspace: string, arg: string): GuiCommandResult {
  loadAutorun(workspace);
  const normalized = arg.toLowerCase();
  if (normalized === 'enable' || normalized === 'on') {
    setAllowAll(workspace, true);
    return {
      title: '/sudo',
      rows: ['sudo enabled: all tools allowed'],
    };
  }
  if (normalized === 'disable' || normalized === 'off') {
    setAllowAll(workspace, false);
    return {
      title: '/sudo',
      rows: ['sudo disabled'],
    };
  }
  return {
    title: '/sudo',
    rows: [
      `sudo: ${isAllowAll() ? 'enabled' : 'disabled'}`,
      'usage: /sudo enable|off',
      'sudo allows every tool without permission prompts.',
    ],
  };
}

const BENCHMARK_TABS = new Set<BenchmarkBrowserTab>([
  'overview',
  'runs',
  'failures',
  'provenance',
]);

function readBenchmarkSummary(workspace: string, arg: string): GuiCommandResult {
  const catalog = new BenchmarkCatalog(
    benchmarkCacheDir(),
    officialBenchmarkSources(),
  );
  const snapshots = catalog.ids().flatMap((id) => {
    const snapshot = catalog.readCached(id);
    return snapshot === null ? [] : [snapshot];
  });
  const runs = new BenchmarkRunStore(
    join(benchmarkWorkspaceDir(workspace), 'runs'),
  ).list();
  const model = createBenchmarkBrowserModel(
    snapshots,
    listCustomBenchmarks(workspace),
    runs,
  );
  const entries = model.entries;
  if (entries.length === 0) {
    return {
      title: '/benchmarks',
      rows: [
        'No benchmark data found.',
        'Run `lavalamp benchmark refresh` or create a custom suite.',
      ],
    };
  }
  const options = parseBenchmarkArgs(arg);
  model.tab = options.tab;
  if (options.selector !== undefined) {
    const selected = selectBenchmarkEntry(model.entries, options.selector);
    if (selected === -1) {
      return {
        title: '/benchmarks',
        rows: [
          `No benchmark matches: ${options.selector}`,
          'usage: /benchmarks [overview|runs|failures|provenance] [index-or-search]',
        ],
      };
    }
    model.selected = selected;
  }
  const selectedEntry = model.entries[model.selected];
  const rows = [
    `entries: ${entries.length} · saved runs: ${runs.length}`,
    `view: ${model.tab} · selected: ${model.selected + 1}/${entries.length}`,
    'usage: /benchmarks [overview|runs|failures|provenance] [index-or-search]',
    '',
    'suites & runs:',
    ...entries.map((entry, index) => {
      const kind =
        entry.kind === 'public'
          ? entry.snapshot?.runnable
            ? 'public'
            : 'reference'
          : entry.kind;
      const marker = index === model.selected ? '›' : ' ';
      return `${marker} ${index + 1}. ${entry.label} · ${kind}`;
    }),
    '',
    selectedEntry === undefined ? 'selected:' : `selected: ${selectedEntry.label}`,
    ...renderBenchmarkDetails(model).split('\n'),
  ];
  return { title: '/benchmarks', rows };
}

function parseBenchmarkArgs(arg: string): {
  selector?: string;
  tab: BenchmarkBrowserTab;
} {
  const parts = arg.split(/\s+/).filter((part) => part.length > 0);
  let tab: BenchmarkBrowserTab = 'overview';
  const selectorParts: string[] = [];
  for (const part of parts) {
    if (BENCHMARK_TABS.has(part as BenchmarkBrowserTab)) {
      tab = part as BenchmarkBrowserTab;
    } else {
      selectorParts.push(part);
    }
  }
  return {
    selector: selectorParts.length === 0 ? undefined : selectorParts.join(' '),
    tab,
  };
}

function selectBenchmarkEntry(
  entries: { id: string; label: string }[],
  selector: string,
): number {
  const asIndex = Number(selector);
  if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= entries.length) {
    return asIndex - 1;
  }
  const needle = selector.toLowerCase();
  return entries.findIndex(
    (entry) =>
      entry.id.toLowerCase() === needle ||
      entry.id.toLowerCase().includes(needle) ||
      entry.label.toLowerCase().includes(needle),
  );
}

function readMcpConfig(): GuiCommandResult {
  const home = process.env.HOME;
  if (home === undefined) return { title: '/mcp', rows: ['HOME unavailable.'] };
  try {
    const raw = readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8');
    const cfg = JSON.parse(raw) as {
      mcp?: Record<string, unknown>;
      mcpServers?: Record<string, unknown>;
    };
    const servers = cfg.mcpServers ?? cfg.mcp ?? {};
    const names = Object.keys(servers);
    if (names.length === 0) {
      return { title: '/mcp', rows: ['No MCP servers configured.'] };
    }
    const rows = ['MCP servers:'];
    for (const name of names) {
      const value = servers[name];
      const server = value !== null && typeof value === 'object'
        ? (value as { args?: unknown; command?: unknown })
        : {};
      const command = typeof server.command === 'string' ? server.command : '';
      const args = Array.isArray(server.args) ? server.args.join(' ') : '';
      rows.push(name);
      if (command.length > 0) {
        rows.push(`${command} ${args}`.trim());
      }
    }
    return {
      title: '/mcp',
      rows,
    };
  } catch {
    return { title: '/mcp', rows: ['No MCP config found.'] };
  }
}

function readRegisteredTools(serverPath: string): GuiCommandResult {
  try {
    const content = readFileSync(serverPath, 'utf8');
    const toolNames = new Set<string>();
    for (const match of content.matchAll(/name:\s*["']([^"']+)["']/g)) {
      if (match[1] !== undefined) toolNames.add(match[1]);
    }
    return {
      title: '/tools',
      rows:
        toolNames.size === 0
          ? ['No tools found in harness.']
          : [...toolNames].toSorted(),
    };
  } catch {
    return { title: '/tools', rows: ['Could not read harness build.'] };
  }
}
