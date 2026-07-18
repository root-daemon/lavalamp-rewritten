import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GuiEventStore } from '../src/gui-host/event-store';
import { runGuiCommand } from '../src/gui-host/main';
import { GuiRuntime, type GuiProcess } from '../src/gui-host/runtime';
import type { PermissionDecision, PromptImage } from '../src/tui/ipc';
import type { RuntimeCallbacks } from '../src/runtime/types';

class FakeProcess implements GuiProcess {
  readonly backend = 'flue' as const;
  isProcessing = false;
  restarted = false;

  async start(): Promise<void> {}

  prompt(
    _message: string,
    callbacks?: RuntimeCallbacks,
    _sessionId?: string,
    _images?: PromptImage[],
  ): string {
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
