import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

type GuiEnvironment = Record<string, string | undefined>;

export function guiBinaryCandidates(
  repoRoot: string,
  env: GuiEnvironment,
): string[] {
  return [
    env.LAVALAMP_GUI_BINARY,
    join(repoRoot, 'gui', 'zig-out', 'bin', 'lavalamp-gui'),
    join(
      repoRoot,
      'gui',
      'zig-out',
      'Lavalamp.app',
      'Contents',
      'MacOS',
      'lavalamp-gui',
    ),
  ].filter((candidate): candidate is string => Boolean(candidate));
}

export function resolveGuiBinary(
  repoRoot: string,
  env: GuiEnvironment,
  exists: (path: string) => boolean = existsSync,
): string | null {
  return guiBinaryCandidates(repoRoot, env).find(exists) ?? null;
}

export function launchGui(options: {
  repoRoot: string;
  workspace: string;
  env: GuiEnvironment;
}): number {
  const binary = resolveGuiBinary(options.repoRoot, options.env);
  if (!binary) {
    console.error(
      '[lavalamp] Native GUI not built. Run `bun run gui:build`, then retry `lavalamp gui`.',
    );
    return 1;
  }

  const result = spawnSync(binary, [], {
    cwd: options.workspace,
    env: {
      ...process.env,
      ...options.env,
      LAVALAMP_WORKSPACE: options.workspace,
    },
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(`[lavalamp] Failed to launch native GUI: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 0;
}
