import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

describe('bin/lavalamp launcher environment', () => {
  test('preserves caller PORT in the centralized runtime invocation', async () => {
    const launcher = await readFile(
      resolve(import.meta.dir, '../bin/lavalamp'),
      'utf8',
    );
    const runtimeInvocations = launcher.match(/bun "\$\{EXTRA_ARGS\[@\]\}"/g) ?? [];
    const callerAwarePorts = launcher.match(/PORT="\$\{PORT:-48392\}"/g) ?? [];

    expect(runtimeInvocations).toHaveLength(1);
    expect(callerAwarePorts).toHaveLength(runtimeInvocations.length);
    expect(launcher).not.toContain('PORT=48392 bun');
  });

  test('routes gui and hidden gui-host subcommands without changing default TUI', async () => {
    const launcher = await readFile(
      resolve(import.meta.dir, '../bin/lavalamp'),
      'utf8',
    );
    expect(launcher).toContain('gui|gui-host|benchmark|benchmarks)');
    expect(launcher).toContain('bun run "${REPO_DIR}/src/run.ts" "$@"');
    expect(launcher).toContain('else\n  EXTRA_ARGS=(src/run.ts)');
  });
});
