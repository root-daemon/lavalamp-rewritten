import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const launcher = join(root, 'bin', 'lavalamp');
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { force: true, recursive: true });
  }
});

async function launch(...args: string[]) {
  const fixture = mkdtempSync(join(tmpdir(), 'lavalamp-launcher-'));
  fixtures.push(fixture);
  const invocation = join(fixture, 'invocation.txt');
  const bunStub = join(fixture, 'bun');
  writeFileSync(
    bunStub,
    '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$LAVALAMP_TEST_INVOCATION"\n',
  );
  chmodSync(bunStub, 0o755);

  const child = Bun.spawn(['bash', launcher, ...args], {
    cwd: root,
    env: {
      ...process.env,
      LAVALAMP_TEST_INVOCATION: invocation,
      PATH: `${fixture}:${process.env.PATH ?? ''}`,
    },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {
    args: exitCode === 0 ? readFileSync(invocation, 'utf8').trim().split('\n') : [],
    exitCode,
    stderr,
  };
}

describe('Bash launcher', () => {
  test('starts the TUI without arguments on macOS Bash', async () => {
    const result = await launch();

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(result.args).toEqual(['src/run.ts']);
  });

  test('forwards an explicit backend to the runtime', async () => {
    const result = await launch('--backend', 'codex');

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(result.args).toEqual(['src/run.ts', '--backend', 'codex']);
  });
});
