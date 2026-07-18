import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { spawn } from 'node:child_process';

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

export function guiLaunchPath(repoRoot: string, env: GuiEnvironment): string {
  const repoBin = join(repoRoot, 'bin');
  const pathEntries = [env.PATH, process.env.PATH]
    .flatMap((entry) => entry?.split(delimiter) ?? [])
    .filter((entry) => entry.length > 0);
  if (!pathEntries.includes(repoBin)) {
    pathEntries.unshift(repoBin);
  }
  return pathEntries.join(delimiter);
}

export function guiLaunchEnvironment(options: {
  repoRoot: string;
  workspace: string;
  env: GuiEnvironment;
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...options.env,
    LAVALAMP_CLI_BINARY: join(options.repoRoot, 'bin', 'lavalamp'),
    LAVALAMP_WORKSPACE: options.workspace,
    PATH: guiLaunchPath(options.repoRoot, options.env),
  };
}

export function launchGui(options: {
  repoRoot: string;
  workspace: string;
  env: GuiEnvironment;
}): Promise<number> {
  const binary = resolveGuiBinary(options.repoRoot, options.env);
  if (!binary) {
    console.error(
      '[lavalamp] Native GUI not built. Run `bun run gui:build`, then retry `lavalamp gui`.',
    );
    return Promise.resolve(1);
  }

  const child = spawn(binary, [], {
    cwd: options.workspace,
    detached: process.platform !== 'win32',
    env: guiLaunchEnvironment(options),
    stdio: 'ignore',
  });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(code);
    };
    const onSignal = (signal: NodeJS.Signals) => {
      if (child.pid !== undefined) {
        try {
          if (process.platform === 'win32') {
            child.kill(signal);
          } else {
            process.kill(-child.pid, signal);
          }
        } catch {
          child.kill(signal);
        }
      }
      finish(signal === 'SIGINT' ? 130 : 143);
    };
    const cleanup = () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    };

    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    child.once('error', (error) => {
      console.error(`[lavalamp] Failed to launch native GUI: ${error.message}`);
      finish(1);
    });
    child.once('exit', (code, signal) => {
      if (signal === 'SIGINT') finish(130);
      else if (signal === 'SIGTERM') finish(143);
      else finish(code ?? 0);
    });
  });
}
