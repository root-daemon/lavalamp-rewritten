import { describe, expect, test } from 'bun:test';
import { HELP_COMMANDS } from '../src/tui/slash-data.ts';
import { loginFromTui, type TuiLoginProgress } from '../src/tui/login.ts';

describe('TUI login', () => {
  test('advertises /login in slash-command help', () => {
    expect(HELP_COMMANDS).toContainEqual(['/login', 'Log in to the active backend']);
  });

  test('opens Codex browser auth and waits for completion', async () => {
    const calls: string[] = [];
    const progress: TuiLoginProgress[] = [];
    const runtime = {
      account: { account: null, requiresOpenaiAuth: true },
      isProcessing: false,
      async login() {
        calls.push('login');
        return { authUrl: 'https://example.com/sign-in', loginId: 'login-1' };
      },
      async waitForLogin(loginId: string) {
        calls.push(`wait:${loginId}`);
      },
      async readAccount() {
        calls.push('read-account');
        return { account: { email: 'dev@example.com' }, requiresOpenaiAuth: true };
      },
    };

    await loginFromTui({
      backend: 'codex',
      cloudflareLogin: async () => {
        throw new Error('unexpected Cloudflare login');
      },
      onProgress: (event) => progress.push(event),
      openBrowser: async (url) => {
        calls.push(`open:${url}`);
        return true;
      },
      runtime,
    });

    expect(calls).toEqual([
      'login',
      'wait:login-1',
      'open:https://example.com/sign-in',
      'read-account',
    ]);
    expect(progress).toEqual([
      { message: 'Complete sign-in in your browser...', tone: 'info' },
      { message: 'Codex login complete.', tone: 'success' },
    ]);
  });

  test('shows the Codex login URL when no browser opener is available', async () => {
    const progress: TuiLoginProgress[] = [];

    await loginFromTui({
      backend: 'codex',
      cloudflareLogin: async () => undefined,
      onProgress: (event) => progress.push(event),
      openBrowser: async () => false,
      runtime: {
        account: { account: null, requiresOpenaiAuth: true },
        isProcessing: false,
        login: async () => ({
          authUrl: 'https://example.com/sign-in',
          loginId: 'login-1',
        }),
        readAccount: async () => ({ account: {}, requiresOpenaiAuth: true }),
        waitForLogin: async () => undefined,
      },
    });

    expect(progress[0]).toEqual({
      detail: 'https://example.com/sign-in',
      message: 'Open this URL to sign in:',
      tone: 'info',
    });
  });

  test('does not restart Codex login when the account is authenticated', async () => {
    const progress: TuiLoginProgress[] = [];

    await loginFromTui({
      backend: 'codex',
      cloudflareLogin: async () => undefined,
      onProgress: (event) => progress.push(event),
      openBrowser: async () => true,
      runtime: {
        account: { account: { email: 'dev@example.com' }, requiresOpenaiAuth: true },
        isProcessing: false,
      },
    });

    expect(progress).toEqual([
      { message: 'Codex is already logged in.', tone: 'success' },
    ]);
  });

  test('delegates Flue authentication to the Cloudflare login flow', async () => {
    const calls: string[] = [];
    const progress: TuiLoginProgress[] = [];

    await loginFromTui({
      backend: 'flue',
      cloudflareLogin: async () => {
        calls.push('cloudflare-login');
      },
      onProgress: (event) => progress.push(event),
      openBrowser: async () => true,
      runtime: { isProcessing: false },
    });

    expect(calls).toEqual(['cloudflare-login']);
    expect(progress).toEqual([
      { message: 'Opening Cloudflare login...', tone: 'info' },
      { message: 'Cloudflare login complete.', tone: 'success' },
    ]);
  });

  test('rejects login while a prompt is running', async () => {
    expect(
      loginFromTui({
        backend: 'codex',
        cloudflareLogin: async () => undefined,
        onProgress: () => undefined,
        openBrowser: async () => true,
        runtime: { isProcessing: true },
      }),
    ).rejects.toThrow('cannot log in while a prompt is running');
  });
});
