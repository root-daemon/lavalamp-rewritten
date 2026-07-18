import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadCodexSession,
  saveCodexSession,
} from '../src/tui/sessions.ts';
import { sessionPath } from '../src/storage/paths.ts';

let temporaryHome: string | undefined;
const originalHome = process.env.LAVALAMP_HOME;

afterEach(() => {
  if (temporaryHome !== undefined) {
    rmSync(temporaryHome, { force: true, recursive: true });
  }
  if (originalHome === undefined) {
    delete process.env.LAVALAMP_HOME;
  } else {
    process.env.LAVALAMP_HOME = originalHome;
  }
});

describe('Codex session metadata', () => {
  test('stores only the Codex thread mapping and metadata', () => {
    temporaryHome = mkdtempSync(join(tmpdir(), 'lavalamp-codex-session-'));
    process.env.LAVALAMP_HOME = temporaryHome;

    saveCodexSession({
      backend: 'codex',
      codexThreadId: '019-thread',
      cwd: '/workspace',
      id: 'session_codex',
      mode: 'build',
      name: 'Codex session',
      savedAt: 123,
      version: 2,
    });

    expect(loadCodexSession('session_codex')).toEqual({
      backend: 'codex',
      codexThreadId: '019-thread',
      cwd: '/workspace',
      id: 'session_codex',
      mode: 'build',
      name: 'Codex session',
      savedAt: 123,
      version: 2,
    });
    const raw = JSON.parse(readFileSync(sessionPath('session_codex'), 'utf8'));
    expect(raw.messages).toBeUndefined();
  });

  test('does not interpret a legacy Flue transcript as Codex metadata', () => {
    temporaryHome = mkdtempSync(join(tmpdir(), 'lavalamp-codex-session-'));
    process.env.LAVALAMP_HOME = temporaryHome;

    expect(loadCodexSession('missing')).toBeNull();
  });
});
