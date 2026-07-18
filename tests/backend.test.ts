import { describe, expect, test } from 'bun:test';
import {
  assertBackendSupported,
  resolveBackend,
} from '../src/runtime/backend.ts';
import { createRuntimeProcess } from '../src/runtime/process.ts';

describe('backend resolution', () => {
  test('defaults to flue when no source selects a backend', () => {
    expect(resolveBackend({})).toBe('flue');
  });

  test('uses explicit selection before config', () => {
    expect(
      resolveBackend({ configured: 'flue', explicit: 'codex' }),
    ).toBe('codex');
  });

  test('uses a resumed session backend before config', () => {
    expect(
      resolveBackend({ configured: 'codex', session: 'flue' }),
    ).toBe('flue');
  });

  test('rejects an explicit backend that conflicts with a session', () => {
    expect(() =>
      resolveBackend({ explicit: 'codex', session: 'flue' }),
    ).toThrow('uses the flue backend');
  });

  test('rejects Codex on Windows without affecting Flue', () => {
    expect(() => assertBackendSupported('codex', 'win32')).toThrow(
      'supported on macOS and Linux',
    );
    expect(() => assertBackendSupported('flue', 'win32')).not.toThrow();
  });
});

describe('runtime subagent contract', () => {
  test.each(['flue', 'codex'] as const)(
    '%s exposes backend-neutral subagent operations',
    (backend) => {
      const process = createRuntimeProcess({
        agentName: 'build',
        backend,
        cwd: '/repo',
        serverPath: '/repo/server.mjs',
      });

      expect(typeof process.listSubagents).toBe('function');
      expect(typeof process.inspectSubagent).toBe('function');
      expect(typeof process.stopSubagent).toBe('function');
      expect(typeof process.deploySubagents).toBe('function');
    },
  );
});
