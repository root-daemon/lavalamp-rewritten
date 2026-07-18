import * as readline from 'node:readline';
import type { PermissionRequestMsg, QuestionRequestMsg } from '../tui/ipc';
import { preflightHeadlessAuth, type PreflightContext } from './auth-preflight';
import { resolveRuntimeRoute } from '../config/runtime-route';
import { BUILD_MODEL } from '../config/models';
import { withTerminalProgress } from './terminal-progress';
import type { AgentBackend } from '../runtime/backend';
import { createRuntimeProcess } from '../runtime/process';
import { saveCodexSession } from '../tui/sessions';
import { isCodexLoginRequired } from '../runtime/codex/runtime';
import type { RuntimeResult } from '../runtime/types';

export interface PrintOptions {
  backend: AgentBackend;
  allowModelFallback?: boolean;
  autoApprove: boolean;
  prompt: string;
  stdinContent: string;
  quiet: boolean;
  outputFormat: 'text' | 'json';
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

export async function runPrint(opts: PrintOptions): Promise<void> {
  const fullPrompt =
    opts.stdinContent.length > 0 && opts.prompt !== opts.stdinContent
      ? `${opts.stdinContent}\n\n---\n\n${opts.prompt}`
      : opts.prompt;

  if (!opts.quiet) {
    console.error(`[lavalamp] Running: ${opts.prompt}`);
    console.error(`[lavalamp] Workspace: ${opts.workspaceRoot}`);
  }

  const preflightCtx: PreflightContext = {
    backend: opts.backend,
    config: opts.config,
    env: opts.env,
    model: opts.model,
    outputFormat: opts.outputFormat,
  };

  if (!(await preflightHeadlessAuth(preflightCtx))) {
    process.exit(1);
  }

  const flue = createRuntimeProcess({
    agentName: opts.agentName ?? 'build',
    allowModelFallback: opts.allowModelFallback,
    autoApprove: opts.autoApprove,
    backend: opts.backend,
    cwd: opts.workspaceRoot,
    model: opts.model,
    serverPath: opts.serverPath,
    sudo: opts.sudo,
  });
  const isTTY = process.stdin.isTTY ?? false;
  const permissionInput =
    isTTY && !opts.autoApprove
      ? readline.createInterface({ input: process.stdin, output: process.stderr })
      : null;
  let pBashRunning = false;

  flue.onPermissionRequest = (request: PermissionRequestMsg) => {
    if (opts.autoApprove) {
      flue.sendPermissionResponse(request.requestId, 'allow');
      return;
    }
    if (permissionInput === null) {
      flue.sendPermissionResponse(request.requestId, 'deny');
      if (!opts.quiet && opts.outputFormat !== 'json') {
        process.stderr.write(
          `\n[lavalamp] Denied ${request.toolName}; use --yes to allow tool calls in non-interactive mode.\n`,
        );
      }
      return;
    }
    let serializedArgs: string;
    try {
      serializedArgs = JSON.stringify(request.args, null, 2);
    } catch {
      serializedArgs = String(request.args);
    }
    const visibleArgs =
      serializedArgs.length > 4000
        ? `${serializedArgs.slice(0, 4000)}\n... (arguments truncated)`
        : serializedArgs;
    permissionInput.question(
      `\n[lavalamp] ${request.toolName} requests permission:\n${visibleArgs}\nAllow? [y/N] `,
      (answer) => {
        const allow = answer.trim().toLowerCase().startsWith('y');
        flue.sendPermissionResponse(request.requestId, allow ? 'allow' : 'deny');
      },
    );
  };

  flue.onQuestionRequest = (request: QuestionRequestMsg) => {
    const answers: Record<string, unknown> = {};
    for (const question of request.questions) {
      answers[question.id] =
        question.default ?? (question.type === 'multiselect' ? [] : '');
    }
    flue.sendQuestionResponse(request.requestId, answers);
  };

  flue.onBashStream = (chunk: string, stream: 'stdout' | 'stderr') => {
    if (opts.quiet || opts.outputFormat === 'json') {
      return;
    }
    if (!pBashRunning) {
      pBashRunning = true;
      process.stderr.write('  ┌─ bash\n');
    }
    if (stream === 'stderr') {
      process.stderr.write(chunk);
    } else {
      process.stdout.write(chunk);
    }
  };

  try {
    await flue.start();
    if (opts.backend === 'codex' && isCodexLoginRequired(flue.account)) {
      throw new Error('Codex authentication required. Run `lavalamp login --backend codex`.');
    }
    if (opts.threadId !== undefined) {
      await flue.resumeThread?.(opts.threadId);
    }
  } catch (error: unknown) {
    permissionInput?.close();
    const msg = error instanceof Error ? error.message : String(error);
    if (opts.outputFormat === 'json') {
      process.stdout.write(`${JSON.stringify({ error: msg })}\n`);
    } else {
      console.error(`[lavalamp] Error: ${msg}`);
    }
    process.exit(1);
  }

  let exitCode = 0;
  const sessionId = opts.sessionId ?? `session_${Date.now()}`;
  if (opts.outputFormat === 'json') {
    let fullText = '';
    let usage: Record<string, unknown> = {};
    let modelInfo: Record<string, unknown> = {};
    const route = opts.backend === 'flue' ? resolveRuntimeRoute({
      config: opts.config,
      env: opts.env,
      model: opts.model,
      preferredModel: BUILD_MODEL,
    }) : null;

    exitCode = await new Promise<number>((resolveExit) => {
      const callbacks = withTerminalProgress({
        onError: (err) => {
          process.stdout.write(`${JSON.stringify({ error: err.message })}\n`);
          resolveExit(1);
        },
        onEvent: (event) => {
          if (event.type === 'text_delta') {
            fullText += event.text ?? event.delta ?? '';
          }
        },
        onResult: (result) => {
          if (!fullText && typeof result.text === 'string') {
            fullText = result.text;
          }
          if (result !== undefined && result.usage !== undefined) {
            usage = result.usage as unknown as Record<string, unknown>;
          }
          if (result !== undefined && result.model !== undefined) {
            modelInfo = result.model as Record<string, unknown>;
          }
          saveCodexResult(result, sessionId, opts);
          const provider =
            typeof modelInfo.provider === 'string'
              ? modelInfo.provider
              : route?.provider ?? 'openai';
          process.stdout.write(
            `${JSON.stringify({
              backend: opts.backend,
              cost: opts.backend === 'codex' ? null : (usage as { cost?: unknown }).cost ?? {},
              model: modelInfo,
              route: route === null ? null : {
                gatewayId: route.usesGateway ? route.gatewayId : undefined,
                mode: route.mode,
                provider,
              },
              sessionId,
              text: fullText,
              ...(result.threadId === undefined ? {} : { threadId: result.threadId }),
              ...(result.turnId === undefined ? {} : { turnId: result.turnId }),
              usage,
            })}\n`,
          );
          resolveExit(0);
        },
      });
      try {
        flue.prompt(fullPrompt, callbacks, sessionId);
      } catch (error: unknown) {
        callbacks.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    });
  } else {
    let streamedText = '';
    exitCode = await new Promise<number>((resolveExit) => {
      const callbacks = withTerminalProgress({
        onError: (err) => {
          console.error(`\n  error: ${err.message}`);
          resolveExit(1);
        },
        onEvent: (event) => {
          if (event.type === 'text_delta') {
            const delta = event.text ?? event.delta ?? '';
            streamedText += delta;
            process.stdout.write(delta);
          } else if (event.type === 'tool_start') {
            if (event.toolName === 'bash' && !opts.quiet) {
              pBashRunning = false;
            }
          } else if (event.type === 'tool') {
            if (pBashRunning) {
              pBashRunning = false;
              if (!opts.quiet) {
                process.stderr.write('  └─\n');
              }
            }
          }
        },
        onResult: (result) => {
          saveCodexResult(result, sessionId, opts);
          if (!streamedText && typeof result.text === 'string') {
            process.stdout.write(result.text);
          }
          if (!opts.quiet && result !== undefined && result.usage !== undefined) {
            const u = result.usage;
            const modelStr =
              result.model !== undefined
                ? `${result.model.provider}/${result.model.id}`
                : '';
            const cost = u.cost === null ? '' : ` | $${u.cost.total.toFixed(4)}`;
            console.error(`\n  ${u.totalTokens} tok${cost} | ${modelStr}`);
          }
          resolveExit(0);
        },
      });
      try {
        flue.prompt(fullPrompt, callbacks, sessionId);
      } catch (error: unknown) {
        callbacks.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    });
  }
  await flue.shutdown();
  permissionInput?.close();
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

function saveCodexResult(
  result: RuntimeResult,
  sessionId: string,
  opts: PrintOptions,
): void {
  if (opts.backend !== 'codex' || result.threadId === undefined) {
    return;
  }
  saveCodexSession({
    version: 2,
    id: sessionId,
    backend: 'codex',
    codexThreadId: result.threadId,
    cwd: opts.workspaceRoot,
    mode: opts.agentName === 'explore' ? 'ask' : 'build',
    name: opts.prompt.slice(0, 45) || 'Codex Session',
    savedAt: Date.now(),
  });
}
