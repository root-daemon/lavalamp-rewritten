import type { AgentBackend } from '../runtime/backend';
import type { RuntimeProcess } from '../runtime/process';
import { isCodexLoginRequired } from '../runtime/codex/runtime';

export interface TuiLoginProgress {
  detail?: string;
  message: string;
  tone: 'info' | 'success';
}

interface TuiLoginOptions {
  backend: AgentBackend;
  cloudflareLogin: () => Promise<unknown>;
  onProgress: (event: TuiLoginProgress) => void;
  openBrowser: (url: string) => Promise<boolean>;
  runtime: Pick<
    RuntimeProcess,
    | 'account'
    | 'isProcessing'
    | 'login'
    | 'readAccount'
    | 'waitForLogin'
  >;
}

export async function loginFromTui(options: TuiLoginOptions): Promise<void> {
  if (options.runtime.isProcessing) {
    throw new Error('cannot log in while a prompt is running');
  }

  if (options.backend === 'flue') {
    options.onProgress({
      message: 'Opening Cloudflare login...',
      tone: 'info',
    });
    await options.cloudflareLogin();
    options.onProgress({
      message: 'Cloudflare login complete.',
      tone: 'success',
    });
    return;
  }

  if (!isCodexLoginRequired(options.runtime.account)) {
    options.onProgress({
      message: 'Codex is already logged in.',
      tone: 'success',
    });
    return;
  }

  if (
    options.runtime.login === undefined ||
    options.runtime.readAccount === undefined ||
    options.runtime.waitForLogin === undefined
  ) {
    throw new Error('the active Codex runtime does not support login');
  }

  const attempt = await options.runtime.login();
  const completion = options.runtime.waitForLogin(attempt.loginId);
  const opened = await options.openBrowser(attempt.authUrl);
  options.onProgress(
    opened
      ? { message: 'Complete sign-in in your browser...', tone: 'info' }
      : {
          detail: attempt.authUrl,
          message: 'Open this URL to sign in:',
          tone: 'info',
        },
  );
  await completion;
  await options.runtime.readAccount();
  options.onProgress({ message: 'Codex login complete.', tone: 'success' });
}
