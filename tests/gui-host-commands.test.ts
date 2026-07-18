import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
import type { PermissionDecision, PromptImage } from '../src/tui/ipc';
import type { SubAgent } from '../src/tui/state';
import type { RuntimeCallbacks } from '../src/runtime/types';

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
});
