#!/usr/bin/env bun
import { execFile } from 'node:child_process';
import { login } from '../auth/login';
import { loadCredentials, clearCredentials } from '../auth/credentials';
import { parseBackend, resolveBackend } from '../runtime/backend';
import { resolveConfig } from '../config/user-config';
import { CodexProcess } from '../runtime/codex/runtime';

const command = process.argv[2];

function selectedBackend() {
  const index = process.argv.indexOf('--backend');
  const explicit =
    index === -1 ? undefined : parseBackend(process.argv[index + 1]);
  return resolveBackend({ explicit, configured: resolveConfig().backend });
}

async function withCodex<T>(
  fn: (runtime: CodexProcess) => Promise<T>,
): Promise<T> {
  const runtime = new CodexProcess(process.cwd());
  try {
    await runtime.start();
    return await fn(runtime);
  } finally {
    await runtime.shutdown();
  }
}

async function openBrowser(url: string): Promise<boolean> {
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'linux'
        ? 'xdg-open'
        : undefined;
  if (command === undefined) {
    return false;
  }
  return new Promise((resolve) => {
    execFile(command, [url], (error) => resolve(error === null));
  });
}

async function codexAuth(command: string): Promise<void> {
  await withCodex(async (runtime) => {
    if (command === 'login') {
      const login = await runtime.login();
      const wait = runtime.waitForLogin(login.loginId);
      if (!(await openBrowser(login.authUrl))) {
        console.log(`[lavalamp] Open this URL to sign in:\n${login.authUrl}`);
      } else {
        console.log('[lavalamp] Opened Codex sign-in in your browser.');
      }
      await wait;
      console.log('[lavalamp] Codex login complete.');
      return;
    }
    if (command === 'logout') {
      await runtime.logout();
      console.log('[lavalamp] Codex account logged out.');
      return;
    }
    const state = (await runtime.readAccount()) as { account?: unknown };
    console.log(
      state.account == null
        ? '[lavalamp] Codex is not logged in. Run "lavalamp login --backend codex".'
        : '[lavalamp] Codex authentication is available.',
    );
  });
}

async function main() {
  if (selectedBackend() === 'codex') {
    if (command === 'login' || command === 'logout' || command === 'status') {
      try {
        await codexAuth(command);
      } catch (error) {
        console.error(
          `[lavalamp] Codex ${command} failed: ${(error as Error).message}`,
        );
        process.exit(1);
      }
      return;
    }
  }
  switch (command) {
    case 'login': {
      try {
        const creds = await login();
        console.log(
          `[lavalamp] Logged in as account ${creds.accountId.slice(0, 8)}...`,
        );
      } catch (error: unknown) {
        console.error(`[lavalamp] Login failed: ${(error as Error).message}`);
        process.exit(1);
      }
      break;
    }

    case 'logout': {
      clearCredentials();
      console.log('[lavalamp] Credentials removed.');
      break;
    }

    case 'status': {
      const creds = loadCredentials();
      if (creds) {
        console.log(
          `[lavalamp] Logged in as account ${creds.accountId.slice(0, 8)}...`,
        );
      } else {
        console.log(
          '[lavalamp] Not logged in. Run "lavalamp login" to authenticate.',
        );
      }
      break;
    }

    case undefined: {
      console.error('Usage: lavalamp {login|logout|status}');
      process.exit(1);
    }
    default: {
      console.error('Usage: lavalamp {login|logout|status}');
      process.exit(1);
    }
  }
}

await main();
