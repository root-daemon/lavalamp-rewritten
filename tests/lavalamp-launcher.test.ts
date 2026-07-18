import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

describe('bin/lavalamp launcher environment', () => {
  test('preserves caller PORT in every runtime branch', async () => {
    const launcher = await readFile(
      resolve(import.meta.dir, '../bin/lavalamp'),
      'utf8',
    );
    const runtimeInvocations = launcher.match(/bun src\/run\.ts/g) ?? [];
    const callerAwarePorts = launcher.match(/PORT="\$\{PORT:-48392\}"/g) ?? [];

    expect(runtimeInvocations).toHaveLength(4);
    expect(callerAwarePorts).toHaveLength(runtimeInvocations.length);
    expect(launcher).not.toContain('PORT=48392 bun src/run.ts');
  });
});
