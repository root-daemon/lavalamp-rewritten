import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GuiEventStore } from '../src/gui-host/event-store';
import { runGuiCommand } from '../src/gui-host/main';
import {
  GuiRuntime,
  type GuiProcess,
  type GuiSubAgentManager,
} from '../src/gui-host/runtime';
import { resolveConfig } from '../src/config/user-config';
import { benchmarkWorkspaceDir } from '../src/storage/paths';
import type { PermissionDecision, PromptImage } from '../src/tui/ipc';
import type { SubAgent } from '../src/tui/state';
import type { RuntimeCallbacks } from '../src/runtime/types';
import type { BenchmarkRun } from '../src/benchmarks/types';

class FakeProcess implements GuiProcess {
  readonly backend = 'flue' as const;
  isProcessing = false;
  restarted = false;
  lastCallbacks?: RuntimeCallbacks;

  async start(): Promise<void> {}

  prompt(
    _message: string,
    callbacks?: RuntimeCallbacks,
    _sessionId?: string,
    _images?: PromptImage[],
  ): string {
    this.lastCallbacks = callbacks;
    callbacks?.onStarted?.();
    return 'request-1';
  }

  sendPermissionResponse(
    _requestId: string,
    _decision: PermissionDecision,
    _alwaysAllow?: boolean,
  ): void {}

  sendQuestionResponse(
    _requestId: string,
    _answers: Record<string, unknown>,
  ): void {}

  cancel(): void {}

  async restart(): Promise<void> {
    this.restarted = true;
  }

  async shutdown(): Promise<void> {}
}

class FakeSubAgentManager implements GuiSubAgentManager {
  onUpdate?: (subs: SubAgent[]) => void;
  onAllComplete?: (summary: string) => void;
  deployed: string[][] = [];
  private readonly subs: SubAgent[] = [];

  async deploy(queries: string[]): Promise<void> {
    this.deployed.push(queries);
    this.subs.splice(0, this.subs.length);
    for (const [index, query] of queries.entries()) {
      this.subs.push({
        id: `sub-${index + 1}`,
        query,
        startTime: Date.now() - 1200,
        status: 'running',
      });
    }
    this.onUpdate?.(this.list());
  }

  killAll(): void {
    this.subs.splice(0, this.subs.length);
  }

  list(): SubAgent[] {
    return this.subs.map((subagent) => ({ ...subagent }));
  }
}

let root: string;
let previousHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lavalamp-gui-commands-'));
  mkdirSync(join(root, 'workspace'));
  previousHome = process.env.LAVALAMP_HOME;
  process.env.LAVALAMP_HOME = join(root, 'home');
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.LAVALAMP_HOME;
  } else {
    process.env.LAVALAMP_HOME = previousHome;
  }
  rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const process = new FakeProcess();
  const workspace = join(root, 'workspace');
  const runtime = new GuiRuntime({
    backend: 'flue',
    mode: 'build',
    process,
    store: new GuiEventStore(),
    workspace,
  });
  return { process, runtime, workspace };
}

describe('GUI host commands', () => {
  test('renders real analytics and benchmark command output', async () => {
    const { runtime, workspace } = fixture();
    const analytics = await runGuiCommand(runtime, workspace, '/server.mjs', '/analytics');
    expect(analytics.rows.join('\n')).toContain('overview');
    expect(analytics.rows.join('\n')).not.toContain('TUI-only');

    const benchmarks = await runGuiCommand(runtime, workspace, '/server.mjs', '/benchmarks');
    expect(benchmarks.rows.join('\n')).not.toContain('TUI-only');
  });

  test('renders benchmark browser tabs and selection through GUI command output', async () => {
    const { runtime, workspace } = fixture();
    mkdirSync(join(workspace, 'benchmarks', 'regressions'), { recursive: true });
    writeFileSync(join(workspace, 'benchmarks', 'regressions', 'dataset.toml'), '[dataset]\n');
    const run: BenchmarkRun = {
      benchmarkId: 'regressions',
      benchmarkVersion: 'local',
      completedAt: '2026-07-18T00:00:00.000Z',
      id: 'run-a',
      observed: true,
      profileFingerprint: 'profile-a',
      scaffold: 'lavalamp@test',
      schemaVersion: 1,
      trials: [
        {
          cost: 0,
          durationMs: 1000,
          failureCategory: 'retrieval',
          reward: 0,
          status: 'failed',
          taskId: 'task-a',
          tokens: 10,
        },
      ],
    };
    const runDir = join(benchmarkWorkspaceDir(workspace), 'runs');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'run-a.json'), JSON.stringify(run));

    const failures = await runGuiCommand(
      runtime,
      workspace,
      '/server.mjs',
      '/benchmarks failures regressions',
    );

    expect(failures.rows.join('\n')).toContain('view: failures');
    expect(failures.rows.join('\n')).toContain('› 1. regressions · custom');
    expect(failures.rows.join('\n')).toContain('retrieval');
  });

  test('supports gateway status and changes through the GUI command path', async () => {
    const { process, runtime, workspace } = fixture();
    const status = await runGuiCommand(runtime, workspace, '/server.mjs', '/gateway');
    expect(status.rows.join('\n')).toContain('gateway: off');

    const enabled = await runGuiCommand(runtime, workspace, '/server.mjs', '/gateway team');
    expect(enabled.rows).toEqual(['AI Gateway enabled: team']);
    expect(process.restarted).toBe(true);
  });

  test('clear starts a clean backend session', async () => {
    const { process, runtime, workspace } = fixture();
    runtime.store.append({ content: 'old prompt', type: 'user.message' });

    const cleared = await runGuiCommand(runtime, workspace, '/server.mjs', '/clear');

    expect(cleared.rows).toEqual(['Started a clean GUI session.']);
    expect(process.restarted).toBe(true);
    expect(runtime.store.snapshot().messages).toEqual([]);
  });

  test('persists GUI model changes and toggles plan mode', async () => {
    const { runtime, workspace } = fixture();
    const model = await runGuiCommand(runtime, workspace, '/server.mjs', '/model model-b');
    expect(model.rows).toEqual(['model set: model-b']);
    expect(resolveConfig().defaultModel).toBe('model-b');

    const planOn = await runGuiCommand(runtime, workspace, '/server.mjs', '/plan');
    expect(planOn.rows).toEqual(['mode set: plan']);
    const planOff = await runGuiCommand(runtime, workspace, '/server.mjs', '/plan');
    expect(planOff.rows).toEqual(['mode set: build']);
  });

  test('loads saved sessions from the slash command by id or search text', async () => {
    const { runtime, workspace } = fixture();
    const sessions = join(root, 'home', 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, 'session-a.json'),
      JSON.stringify({
        id: 'session-a',
        messages: [
          { content: 'Restore this task', role: 'user' },
          { content: 'Restored answer', role: 'assistant' },
        ],
        name: 'Restore GUI parity',
        savedAt: Date.now(),
      }),
    );

    const loaded = await runGuiCommand(runtime, workspace, '/server.mjs', '/sessions Restore');

    expect(loaded.rows).toEqual([
      'loaded: session-a',
      'Restore GUI parity',
      '2 messages',
    ]);
    expect(runtime.store.snapshot().messages).toEqual([
      { content: 'Restore this task', role: 'user' },
      { content: 'Restored answer', role: 'assistant' },
    ]);
  });

  test('renders MCP servers with command and args like the TUI command', async () => {
    const { runtime, workspace } = fixture();
    const previousHome = process.env.HOME;
    const fakeHome = join(root, 'fake-home');
    const configDir = join(fakeHome, '.config', 'opencode');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'opencode.json'),
      JSON.stringify({
        mcpServers: {
          browser: {
            args: ['--port', '9222'],
            command: 'npx',
          },
          memory: {},
        },
      }),
    );

    try {
      process.env.HOME = fakeHome;
      const mcp = await runGuiCommand(runtime, workspace, '/server.mjs', '/mcp');
      expect(mcp.rows).toEqual([
        'MCP servers:',
        'browser',
        'npx --port 9222',
        'memory',
      ]);
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  test('undo restores workspace backup for mutating tool calls', async () => {
    const { process, runtime, workspace } = fixture();
    const target = join(workspace, 'tracked.txt');
    writeFileSync(target, 'before\n');

    runtime.submitPrompt('Change tracked file');
    process.lastCallbacks?.onEvent?.({
      args: { path: 'tracked.txt' },
      toolCallId: 'tool-write',
      toolName: 'write',
      type: 'tool_start',
    });
    writeFileSync(target, 'after\n');
    process.lastCallbacks?.onEvent?.({
      delta: 'Changed file',
      type: 'text_delta',
    });
    process.lastCallbacks?.onResult?.({
      backend: 'flue',
      model: { id: 'model-a', provider: 'cloudflare' },
      text: 'Changed file',
      usage: {
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, total: 0 },
        input: 0,
        output: 0,
        totalTokens: 0,
      },
    });

    const undone = await runGuiCommand(runtime, workspace, '/server.mjs', '/undo');

    expect(undone.rows).toEqual([
      'removed last 2 messages and restored workspace files',
    ]);
    expect(readFileSync(target, 'utf8')).toBe('before\n');
    expect(runtime.store.snapshot().messages).toEqual([]);
  });

  test('supports safe sudo state, explicit enable, rating, and subagent output', async () => {
    const { runtime, workspace } = fixture();
    const sudoStatus = await runGuiCommand(runtime, workspace, '/server.mjs', '/sudo');
    expect(sudoStatus.rows.join('\n')).toContain('sudo: disabled');

    const sudoEnabled = await runGuiCommand(runtime, workspace, '/server.mjs', '/sudo enable');
    expect(sudoEnabled.rows).toEqual(['sudo enabled: all tools allowed']);

    const rated = await runGuiCommand(runtime, workspace, '/server.mjs', '/rate helpful');
    expect(rated.rows).toEqual(['current GUI run rated helpful']);

    const subagents = await runGuiCommand(runtime, workspace, '/server.mjs', '/subagents');
    expect(subagents.rows).toEqual(['No subagents.']);

    runtime.store.append({
      subagents: [
        {
          durationMs: 2500,
          id: 'sub-1',
          pid: 1234,
          query: 'Audit auth parity',
          status: 'running',
        },
      ],
      type: 'subagents.updated',
    });
    const activeSubagents = await runGuiCommand(
      runtime,
      workspace,
      '/server.mjs',
      '/subagents',
    );
    expect(activeSubagents.rows).toEqual([
      'sub-1  running   3s pid:1234  Audit auth parity',
    ]);
  });

  test('deploys TUI parallel subagent markers through GUI runtime', () => {
    const process = new FakeProcess();
    const subAgentManager = new FakeSubAgentManager();
    const workspace = join(root, 'workspace');
    const runtime = new GuiRuntime({
      backend: 'flue',
      mode: 'build',
      process,
      store: new GuiEventStore(),
      subAgentManager,
      workspace,
    });

    runtime.submitPrompt('parent task');
    process.lastCallbacks?.onEvent?.({
      durationMs: 5,
      isError: false,
      result: JSON.stringify({
        queries: ['audit auth', 'audit tui parity', 'audit ui'],
        type: 'parallel_deploy',
      }),
      toolCallId: 'tool-1',
      toolName: 'deploy_parallel_subs',
      type: 'tool',
    });

    expect(subAgentManager.deployed).toEqual([
      ['audit auth', 'audit tui parity', 'audit ui'],
    ]);
    expect(runtime.store.snapshot().subagents.map((subagent) => subagent.query)).toEqual([
      'audit auth',
      'audit tui parity',
      'audit ui',
    ]);
  });

  test('backs login and paste-image commands with GUI host behavior', async () => {
    const { runtime, workspace } = fixture();
    const calls: string[] = [];
    const login = await runGuiCommand(runtime, workspace, '/server.mjs', '/login', {
      cloudflareLogin: async () => {
        calls.push('cloudflare-login');
      },
      openBrowser: async () => true,
    });

    expect(calls).toEqual(['cloudflare-login']);
    expect(login.rows).toEqual([
      'Opening Cloudflare login...',
      'Cloudflare login complete.',
    ]);

    const pasted = await runGuiCommand(
      runtime,
      workspace,
      '/server.mjs',
      '/paste-image',
      { pasteImageFromClipboard: async () => '/tmp/image.png' },
    );

    expect(pasted.insertText).toBe('[Image 1]');
    expect(pasted.rows).toEqual(['Attached [Image 1]', '/tmp/image.png']);
  });

  test('renders read-only git changes and diff output for GUI review', async () => {
    const { runtime, workspace } = fixture();
    spawnSync('git', ['init'], { cwd: workspace });
    writeFileSync(join(workspace, 'tracked.txt'), 'old\n');
    spawnSync('git', ['add', 'tracked.txt'], { cwd: workspace });
    writeFileSync(join(workspace, 'tracked.txt'), 'new\n');
    writeFileSync(join(workspace, 'untracked.txt'), 'new file\n');

    const changes = await runGuiCommand(runtime, workspace, '/server.mjs', '/changes');
    expect(changes.rows.join('\n')).toContain('changed files: 2');
    expect(changes.rows.join('\n')).toContain('tracked.txt');
    expect(changes.rows.join('\n')).toContain('untracked.txt');
    expect(changes.rows.join('\n')).toContain('diff stat:');

    const diff = await runGuiCommand(runtime, workspace, '/server.mjs', '/diff tracked.txt');
    expect(diff.rows.join('\n')).toContain('-old');
    expect(diff.rows.join('\n')).toContain('+new');
  });

  test('renders repository orchestration links and worktrees for GUI review', async () => {
    const { runtime, workspace } = fixture();
    const previousPath = process.env.PATH;
    const fakeBin = join(root, 'fake-bin');
    mkdirSync(fakeBin, { recursive: true });
    const fakeGh = join(fakeBin, 'gh');
    writeFileSync(
      fakeGh,
      [
        '#!/usr/bin/env bash',
        'if [[ "$*" == "pr view --json number,title,state,url,reviewDecision,mergeStateStatus,isDraft" ]]; then',
        '  echo \'{"number":7,"title":"GUI parity","state":"OPEN","url":"https://github.com/owner/repo/pull/7","reviewDecision":"APPROVED","mergeStateStatus":"CLEAN","isDraft":false}\'',
        '  exit 0',
        'fi',
        'if [[ "$*" == "pr checks --json name,state,bucket,link" ]]; then',
        '  echo \'[{"name":"test","state":"SUCCESS","bucket":"pass","link":"https://github.com/owner/repo/actions/runs/1"},{"name":"lint","state":"PENDING","bucket":"pending"}]\'',
        '  exit 0',
        'fi',
        'exit 1',
        '',
      ].join('\n'),
    );
    chmodSync(fakeGh, 0o755);
    process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;
    spawnSync('git', ['init', '-b', 'feature/gui'], { cwd: workspace });
    writeFileSync(join(workspace, 'tracked.txt'), 'first\n');
    spawnSync('git', ['add', 'tracked.txt'], { cwd: workspace });
    spawnSync(
      'git',
      [
        '-c',
        'commit.gpgSign=false',
        '-c',
        'user.name=Test User',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'initial commit',
      ],
      { cwd: workspace },
    );
    spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:owner/repo.git'], {
      cwd: workspace,
    });

    try {
      const repo = await runGuiCommand(runtime, workspace, '/server.mjs', '/repo');
      const output = repo.rows.join('\n');

      expect(repo.title).toBe('/repo');
      expect(output).toContain(`repository: ${realpathSync(workspace)}`);
      expect(output).toContain('branch: feature/gui');
      expect(output).toContain('head: ');
      expect(output).toContain('initial commit');
      expect(output).toContain('origin: git@github.com:owner/repo.git');
      expect(output).toContain('github: https://github.com/owner/repo');
      expect(output).toContain('pull request: #7 GUI parity');
      expect(output).toContain('review: APPROVED · merge: CLEAN');
      expect(output).toContain('checks: 1 passing · 0 failing · 1 pending');
      expect(output).toContain(
        'pull requests: https://github.com/owner/repo/pulls?q=is%3Apr+head%3Afeature%2Fgui',
      );
      expect(output).toContain(
        'actions: https://github.com/owner/repo/actions?query=branch%3Afeature%2Fgui',
      );
      expect(output).toContain('worktrees:');
      expect(output).toContain('feature/gui');
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
  });

  test('creates git worktree task lanes through the GUI command path', async () => {
    const { runtime, workspace } = fixture();
    spawnSync('git', ['init', '-b', 'main'], { cwd: workspace });
    writeFileSync(join(workspace, 'tracked.txt'), 'first\n');
    spawnSync('git', ['add', 'tracked.txt'], { cwd: workspace });
    spawnSync(
      'git',
      [
        '-c',
        'commit.gpgSign=false',
        '-c',
        'user.name=Test User',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'initial commit',
      ],
      { cwd: workspace },
    );

    const created = await runGuiCommand(
      runtime,
      workspace,
      '/server.mjs',
      '/worktree new task/gui-lane',
    );
    const output = created.rows.join('\n');

    expect(created.title).toBe('/worktree');
    expect(output).toContain('created: task/gui-lane');
    expect(output).toContain('path: ');
    expect(output).toContain('task/gui-lane');
    expect(output).toContain('worktrees:');

    const listed = await runGuiCommand(runtime, workspace, '/server.mjs', '/worktree');
    expect(listed.rows.join('\n')).toContain('task/gui-lane');
  });
});
