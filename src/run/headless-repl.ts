import * as readline from 'node:readline';
import type { PermissionRequestMsg, QuestionRequestMsg } from '../tui/ipc';
import {
  preflightHeadlessAuth,
  preflightSimpleAuth,
  type PreflightContext,
} from './auth-preflight';
import { createSimpleEventStream } from './simple-event-stream';
import { withTerminalProgress } from './terminal-progress';
import type { AgentBackend } from '../runtime/backend';
import { createRuntimeProcess } from '../runtime/process';
import type { RuntimeEvent, RuntimeResult } from '../runtime/types';
import { saveCodexSession } from '../tui/sessions';
import { resolveRuntimeRoute } from '../config/runtime-route';
import { isCodexLoginRequired } from '../runtime/codex/runtime';
import { AnalyticsRecorder } from '../analytics';

export interface ReplOptions {
  backend: AgentBackend;
  allowModelFallback?: boolean;
  quiet: boolean;
  outputFormat: 'text' | 'json';
  simpleMode?: boolean;
  workspaceRoot: string;
  serverPath: string;
  config: any;
  env: Record<string, string | undefined>;
  model?: string;
  agentName?: string;
  sudo?: boolean;
  sessionId?: string;
  threadId?: string;
}

function defaultQuestionAnswers(
  questions: QuestionRequestMsg['questions'],
): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const q of questions) {
    answers[q.id] = q.default ?? (q.type === 'multiselect' ? [] : '');
  }
  return answers;
}

export async function runRepl(opts: ReplOptions): Promise<void> {
  const isTTY = process.stdin.isTTY ?? false;
  const autoApprove =
    process.argv.includes('--sudo') ||
    process.argv.includes('--yes') ||
    process.argv.includes('--auto-approve');
  const simple = opts.simpleMode === true;

  if (!opts.quiet && !simple) {
    console.error(`[lavalamp] REPL — workspace: ${opts.workspaceRoot}`);
    if (autoApprove) {
      console.error('[lavalamp] --yes: all tool calls auto-approved');
    } else if (!isTTY) {
      console.error(
        '[lavalamp] piped stdin: destructive tools auto-denied (use --yes to allow)',
      );
    }
    if (isTTY) {
      console.error(
        '[lavalamp] /exit or Ctrl+D to quit · /clear to reset · Ctrl+C to cancel turn',
      );
    }
    console.error('');
  }

  const preflightCtx: PreflightContext = {
    backend: opts.backend,
    config: opts.config,
    env: opts.env,
    model: opts.model,
    outputFormat: opts.outputFormat,
  };

  if (simple && isTTY) {
    await preflightSimpleAuth(preflightCtx, opts.quiet);
  } else if (!(await preflightHeadlessAuth(preflightCtx))) {
    process.exit(1);
  }

  const analytics = AnalyticsRecorder.create({
    agent: opts.agentName ?? 'build',
    mode: simple ? 'simple' : 'repl',
    workspaceRoot: opts.workspaceRoot,
  });
  const route =
    opts.backend === 'flue'
      ? resolveRuntimeRoute({
          config: opts.config,
          env: opts.env,
          model: opts.model,
        })
      : null;
  let analyticsTurn: string | undefined;

  const flue = createRuntimeProcess({
    agentName: opts.agentName ?? 'build',
    allowModelFallback: opts.allowModelFallback,
    autoApprove,
    backend: opts.backend,
    cwd: opts.workspaceRoot,
    model: opts.model,
    serverPath: opts.serverPath,
    sudo: opts.sudo,
  });
  const sessionId = opts.sessionId ?? `session_${Date.now()}`;
  let flueStarted = false;
  let startupError: Error | null = null;
  let startupPromise: Promise<void> | null = null;
  let needsRestart = false;
  let processing = false;
  let bashRunning = false;

  async function ensureFlueStarted(): Promise<void> {
    if (flueStarted) {
      return;
    }
    if (startupError !== null) {
      throw startupError;
    }
    if (startupPromise === null) {
      startupPromise = flue
        .start()
        .then(async () => {
          if (opts.backend === 'codex' && isCodexLoginRequired(flue.account)) {
            throw new Error('Codex authentication required. Run `lavalamp login --backend codex`.');
          }
          if (opts.threadId !== undefined) {
            await flue.resumeThread?.(opts.threadId);
            opts.threadId = undefined;
          }
          flueStarted = true;
        })
        .catch((error: unknown) => {
          const err = error instanceof Error ? error : new Error(String(error));
          startupError = err;
          throw err;
        });
    }
    await startupPromise;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: simple ? '> ' : 'lavalamp> ',
    terminal: isTTY,
  });

  flue.onBashStream = (chunk: string, stream: 'stdout' | 'stderr') => {
    if (opts.quiet || opts.outputFormat === 'json' || simple) {
      return;
    }
    if (!bashRunning) {
      bashRunning = true;
      process.stderr.write('  ┌─ bash\n');
    }
    if (stream === 'stderr') {
      process.stderr.write(chunk);
    } else {
      process.stdout.write(chunk);
    }
  };

  flue.onPermissionRequest = (req: PermissionRequestMsg) => {
    if (autoApprove) {
      analytics.event('permission', 'allowed', analyticsTurn);
      flue.sendPermissionResponse(req.requestId, 'allow');
      return;
    }
    if (!isTTY) {
      analytics.event('permission', 'denied', analyticsTurn);
      flue.sendPermissionResponse(req.requestId, 'deny');
      if (!opts.quiet && !simple) {
        process.stderr.write(
          `  [denied: ${req.toolName} — use --yes to allow]\n`,
        );
      }
      return;
    }
    const prompt = simple
      ? `[allow ${req.toolName}? y/N] `
      : `  [permission] ${req.toolName} — allow? [y/N] `;
    rl.question(prompt, (answer) => {
      const allow = answer.trim().toLowerCase().startsWith('y');
      analytics.event(
        'permission',
        allow ? 'allowed' : 'denied',
        analyticsTurn,
      );
      flue.sendPermissionResponse(req.requestId, allow ? 'allow' : 'deny');
    });
  };

  flue.onQuestionRequest = (request: QuestionRequestMsg) => {
    flue.sendQuestionResponse(
      request.requestId,
      defaultQuestionAnswers(request.questions),
    );
  };

  async function shutdown(): Promise<void> {
    if (flueStarted) {
      try {
        await flue.shutdown();
      } catch {}
    }
    rl.close();
    analytics.finish('completed');
    analytics.close();
    process.exit(0);
  }

  function sendTurn(text: string): Promise<void> {
    return new Promise((resolve) => {
      processing = true;
      analyticsTurn = analytics.startTurn();
      let stopReason: string | undefined;
      let streamed = '';
      const simpleEvents = createSimpleEventStream((chunk) => {
        process.stdout.write(chunk);
      });

      const handleError = (err: Error) => {
        analytics.finishTurn(analyticsTurn, 'failed');
        analyticsTurn = undefined;
        if (simple && opts.outputFormat !== 'json') {
          simpleEvents.finish();
        }
        if (opts.outputFormat === 'json') {
          process.stdout.write(`${JSON.stringify({ error: err.message })}\n`);
        } else if (simple) {
          process.stderr.write(`error: ${err.message}\n`);
        } else {
          process.stderr.write(`\n  error: ${err.message}\n`);
        }
        processing = false;
        resolve();
      };

      const handleResult = (result: RuntimeResult) => {
        analytics.finishTurn(analyticsTurn, 'completed', {
          model: result.model,
          routeMode: route?.mode,
          stopReason,
          usage: result.usage,
        });
        analyticsTurn = undefined;
        if (opts.backend === 'codex' && result.threadId !== undefined) {
          saveCodexSession({
            version: 2,
            id: sessionId,
            backend: 'codex',
            codexThreadId: result.threadId,
            cwd: opts.workspaceRoot,
            mode: opts.agentName === 'explore' ? 'ask' : 'build',
            name: text.slice(0, 45) || 'Codex Session',
            savedAt: Date.now(),
          });
        }
        if (simple && opts.outputFormat !== 'json') {
          simpleEvents.finish();
        }
        if (opts.outputFormat === 'json') {
          process.stdout.write(
            `${JSON.stringify({
              backend: opts.backend,
              cost: result.usage.cost,
              model: result.model,
              route: opts.backend === 'codex' ? null : resolveRuntimeRoute({
                config: opts.config,
                env: opts.env,
                model: opts.model,
              }),
              sessionId: result.sessionId ?? sessionId,
              text: streamed || result.text,
              ...(result.threadId === undefined ? {} : { threadId: result.threadId }),
              ...(result.turnId === undefined ? {} : { turnId: result.turnId }),
              usage: result.usage,
            })}\n`,
          );
        } else {
          if (!streamed && typeof result.text === 'string') {
            process.stdout.write(result.text);
            streamed = result.text;
          }
          if (streamed && !streamed.endsWith('\n')) {
            process.stdout.write('\n');
          }
          if (!opts.quiet && !simple && result.usage !== undefined) {
            const u = result.usage;
            const modelStr =
              result.model !== undefined
                ? `${result.model.provider}/${result.model.id}`
                : '';
            const cost = u.cost === null ? '' : ` | $${u.cost.total.toFixed(4)}`;
            process.stderr.write(`  ${u.totalTokens} tok${cost} | ${modelStr}\n`);
          }
        }
        processing = false;
        resolve();
      };

      const handleEvent = (event: RuntimeEvent) => {
        if (typeof event.stopReason === 'string') {
          stopReason = event.stopReason;
        }
        if (event.type === 'text_delta' || event.type === 'thinking_delta') {
          analytics.firstResponse(analyticsTurn);
        } else if (event.type === 'tool_start') {
          analytics.toolStarted(
            analyticsTurn,
            event.toolCallId,
            event.toolName ?? 'unknown',
            event.args,
          );
        } else if (event.type === 'tool') {
          analytics.toolFinished(
            analyticsTurn,
            event.toolCallId,
            event.toolName ?? 'unknown',
            event.durationMs,
            Boolean(event.isError),
          );
        } else if (event.type === 'compaction_start') {
          analytics.event('compaction', 'started', analyticsTurn);
        }
        if (simple && opts.outputFormat !== 'json') {
          if (event.type === 'text_delta') {
            streamed += event.text ?? event.delta ?? '';
          }
          simpleEvents.handle(event);
          return;
        }

        if (event.type === 'text_delta') {
          const delta = event.text ?? event.delta ?? '';
          streamed += delta;
          if (opts.outputFormat !== 'json') {
            process.stdout.write(delta);
          }
        } else if (event.type === 'tool_start') {
          if (
            event.toolName === 'bash' &&
            !opts.quiet &&
            opts.outputFormat !== 'json' &&
            !simple
          ) {
            bashRunning = false;
          }
        } else if (event.type === 'tool') {
          if (bashRunning) {
            bashRunning = false;
            if (!opts.quiet && opts.outputFormat !== 'json' && !simple) {
              process.stderr.write('  └─\n');
            }
          }
        }
      };

      const callbacks = withTerminalProgress({
        onError: handleError,
        onEvent: handleEvent,
        onResult: handleResult,
      });
      try {
        flue.prompt(text, callbacks, sessionId);
      } catch (err: unknown) {
        callbacks.onError?.(
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    });
  }

  let chain = Promise.resolve();

  async function handleLine(line: string): Promise<void> {
    const input = line.trim();

    if (!input) {
      if (isTTY) {
        rl.prompt();
      }
      return;
    }

    if (input === '/exit' || input === '/quit') {
      await shutdown();
      return;
    }

    if (input === '/help') {
      if (simple) {
        process.stderr.write('/exit · /quit · Ctrl+D to quit\n');
        process.stderr.write('/clear · reset conversation\n');
        process.stderr.write('/help · this message\n');
      } else {
        process.stderr.write('  /exit · /quit — leave REPL\n');
        process.stderr.write('  /clear — reset conversation context\n');
        process.stderr.write('  /help — this message\n');
        process.stderr.write(
          '  Ctrl+C — cancel current turn (or exit when idle)\n',
        );
        process.stderr.write('  Ctrl+D — exit\n');
      }
      if (isTTY) {
        rl.prompt();
      }
      return;
    }

    if (input === '/clear') {
      try {
        await ensureFlueStarted();
        if (opts.backend === 'codex') {
          flue.clearThread?.();
        } else {
          await flue.restart();
        }
        flueStarted = true;
        startupPromise = null;
        startupError = null;
        if (!opts.quiet && !simple) {
          process.stderr.write('  [context cleared]\n');
        }
      } catch (err: unknown) {
        if (!opts.quiet && !simple) {
          process.stderr.write(
            `  [clear failed: ${err instanceof Error ? err.message : String(err)}]\n`,
          );
        }
      }
      if (isTTY) {
        rl.prompt();
      }
      return;
    }

    rl.pause();
    try {
      await ensureFlueStarted();
      await sendTurn(input);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (opts.outputFormat === 'json') {
        process.stdout.write(`${JSON.stringify({ error: msg })}\n`);
      } else {
        process.stderr.write(`error: ${msg}\n`);
      }
    }
    if (needsRestart && flueStarted) {
      needsRestart = false;
      try {
        await flue.restart();
      } catch (err: unknown) {
        if (!opts.quiet && !simple) {
          process.stderr.write(
            `  [restart failed: ${err instanceof Error ? err.message : String(err)}]\n`,
          );
        }
      }
    }
    if (isTTY) {
      rl.resume();
      rl.prompt();
    }
  }

  rl.on('line', (line: string) => {
    chain = chain.then(() => handleLine(line));
  });

  rl.on('close', () => {
    chain
      .then(async () => {
        if (flueStarted) {
          try {
            await flue.shutdown();
          } catch {}
        }
      })
      .finally(() => {
        analytics.finish('completed');
        analytics.close();
        process.exit(0);
      })
      .catch(() => {
        process.exit(0);
      });
  });

  process.on('SIGINT', () => {
    if (processing) {
      analytics.finishTurn(analyticsTurn, 'interrupted');
      analytics.event('interruption', 'user', analyticsTurn);
      analyticsTurn = undefined;
      needsRestart = true;
      flue.cancel();
      flueStarted = false;
      startupPromise = null;
      if (!simple) {
        process.stderr.write('\n  [cancelled]\n');
      } else {
        process.stderr.write('\n');
      }
    } else {
      chain = chain.then(() => shutdown());
    }
  });

  if (isTTY) {
    rl.prompt();
  }
}
