import { join, resolve } from 'node:path';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { startTui } from './tui/app';
import { resolveConfig } from './config/user-config';
import { lavalampDataDir } from './storage/paths';
import { preflightInteractiveAuth } from './run/auth-preflight';
import { runPrint } from './run/headless-print';
import { runRepl } from './run/headless-repl';
import { offerUpdate, runUpdateCommand } from './run/update';
import packageJson from '../package.json' with { type: 'json' };
import {
  assertBackendSupported,
  parseBackend,
  resolveBackend,
  type AgentBackend,
} from './runtime/backend';
import { loadCodexSession, sessionBackend } from './tui/sessions';

// @ts-ignore
import serverCode from '../dist/server.mjs' with { type: 'text' };

const workspaceRoot = process.env.LAVALAMP_WORKSPACE ?? process.cwd();
const config = resolveConfig();
const env = process.env as Record<string, string | undefined>;

const subcommand = process.argv[2];
const version = packageJson.version;
if (subcommand === 'update') {
  process.exit(await runUpdateCommand(version));
}
if (
  subcommand === 'login' ||
  subcommand === 'logout' ||
  subcommand === 'status'
) {
  await import('./cli/auth');
  process.exit(0);
}
if (subcommand === 'config' || subcommand === 'models') {
  await import('./cli/config');
  process.exit(0);
}

const repoRoot = resolve(import.meta.dir, '..');
let serverPath = join(repoRoot, 'dist', 'server.mjs');

if (!existsSync(serverPath)) {
  const dataDir = lavalampDataDir();
  mkdirSync(dataDir, { recursive: true });
  serverPath = join(dataDir, 'server.mjs');
  writeFileSync(serverPath, serverCode, 'utf8');
}

function findFlag(flags: string[]): number {
  for (const f of flags) {
    const idx = process.argv.indexOf(f);
    if (idx !== -1) {
      return idx;
    }
  }
  return -1;
}

function findFlagValue(flags: string[]): string | null {
  const idx = findFlag(flags);
  if (idx === -1) {
    return null;
  }
  return process.argv[idx + 1] ?? null;
}

const versionIdx = findFlag(['-v', '--version']);
const helpIdx = findFlag(['-h', '--help']);

if (versionIdx !== -1) {
  console.log(`lavalamp ${version}`);
  process.exit(0);
}

if (helpIdx !== -1) {
  console.log(`lavalamp — AI coding harness

USAGE:
  lavalamp                       Start interactive session in current directory
  lavalamp ask                   Start interactive read-only session to ask questions about the codebase
  lavalamp ask "PROMPT"          Ask a single question about the codebase and exit
  lavalamp -p "PROMPT"           Run a single prompt and exit
  lavalamp --repl                TUI-less interactive REPL (multi-turn, stdin pipe)
  lavalamp --simple              Plain stdin/stdout chat (no TUI rendering)
  lavalamp --continue            Resume a previous session
  lavalamp --workspace /path     Set workspace directory (default: cwd)
  lavalamp --model MODEL         Override default model
  lavalamp --backend BACKEND     Select flue or codex
  lavalamp models                List known models
  lavalamp update                Download and install the latest release
  lavalamp config show           Show persisted config
  lavalamp config set KEY VALUE  Persist model/Gateway config

OPTIONS:
  -p, --print PROMPT             Run a single prompt and exit
      --repl                     TUI-less interactive REPL
      --simple                   Plain text chat mode
      --yes, --auto-approve      Auto-approve tool calls in headless modes
      --sudo                     Dangerously auto-approve all tools (headless only; no OS elevation)
  -c, --continue [SESSION_ID]    Resume a previous session
  -w, --workspace PATH           Set workspace directory
  -m, --model MODEL              Override the configured model
      --backend BACKEND          Agent backend: flue or codex
      --output-format FORMAT     Output format: text or json
      --quiet                    Suppress diagnostic status messages
      --no-update-check          Skip the interactive startup update check
  -h, --help                     Show this help
  -v, --version                  Show version
`);
  process.exit(0);
}

const askFlagIdx = findFlag(['-a', '--ask']);
const askIdx = askFlagIdx !== -1 ? askFlagIdx : subcommand === 'ask' ? 2 : -1;
const askMode = askIdx !== -1 || process.env.LAVALAMP_ASK === '1';
const askPromptArg = askIdx === -1 ? undefined : process.argv[askIdx + 1];

// Print mode is active if -p/--print is passed OR if -a/--ask is passed WITH a prompt argument
const hasAskPrompt =
  askPromptArg !== undefined && !askPromptArg.startsWith('-');
const printIdx = findFlag(['-p', '--print', '--inline']);
const isPrintMode = printIdx !== -1 || hasAskPrompt;
const printPromptIdx = printIdx !== -1 ? printIdx : askIdx;

const replIdx = findFlag(['--repl']);
const simpleIdx = findFlag(['--simple']);
const simpleMode = simpleIdx !== -1;
const continueIdx = process.argv.indexOf('--continue');
const resumeSession = continueIdx !== -1;
const continueArg =
  continueIdx !== -1 ? process.argv[continueIdx + 1] : undefined;
const resumeSessionId =
  resumeSession && continueArg !== undefined && !continueArg.startsWith('-')
    ? continueArg
    : undefined;
const backendFlag = findFlagValue(['--backend']);
let explicitBackend: AgentBackend | undefined;
try {
  explicitBackend = backendFlag === null ? undefined : parseBackend(backendFlag);
} catch (error) {
  console.error(`[lavalamp] Error: ${(error as Error).message}`);
  process.exit(1);
}
let backend: AgentBackend;
try {
  backend = resolveBackend({
    explicit: explicitBackend,
    configured: config.backend,
    session: resumeSessionId === undefined ? undefined : sessionBackend(resumeSessionId),
  });
  assertBackendSupported(backend);
} catch (error) {
  console.error(`[lavalamp] Error: ${(error as Error).message}`);
  process.exit(1);
}
const modelFlag = findFlagValue(['-m', '--model']);
const allowModelFallback =
  backend === 'codex' && modelFlag === null && env.LAVALAMP_MODEL === undefined;
const model =
  modelFlag ?? env.LAVALAMP_MODEL ??
  (backend === 'codex'
    ? config.codexModel.length > 0 ? config.codexModel : undefined
    : config.defaultModel.length > 0 ? config.defaultModel : undefined);
const codexResumeRecord = backend === 'codex' && resumeSessionId !== undefined
  ? loadCodexSession(resumeSessionId)
  : null;
const outputFormatStr =
  findFlagValue(['--output-format', '--format']) ?? 'text';
const quiet = process.argv.includes('--quiet');
const sudoMode = process.argv.includes('--sudo');
const autoApprove =
  sudoMode ||
  process.argv.includes('--yes') ||
  process.argv.includes('--auto-approve');

if (sudoMode && !isPrintMode && replIdx === -1 && !simpleMode) {
  console.error(
    '[lavalamp] Error: --sudo is only available with -p, --repl, or --simple',
  );
  process.exit(1);
}

if (outputFormatStr !== 'text' && outputFormatStr !== 'json') {
  console.error('[lavalamp] Error: --output-format must be text or json');
  process.exit(1);
}
const outputFormat = outputFormatStr as 'text' | 'json';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return '';
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const agentName = askMode ? 'explore' : 'build';
  const replLikeMode = replIdx !== -1 || simpleMode;
  const checkForUpdates =
    !isPrintMode &&
    !replLikeMode &&
    (process.stdin.isTTY ?? false) &&
    (process.stdout.isTTY ?? false) &&
    (process.stderr.isTTY ?? false) &&
    process.env.LAVALAMP_NO_UPDATE_CHECK !== '1' &&
    !process.argv.includes('--no-update-check');

  if (checkForUpdates && (await offerUpdate(version))) {
    return;
  }

  if (isPrintMode) {
    let prompt = process.argv[printPromptIdx + 1] ?? '';
    const stdinContent = await readStdin();

    if (!prompt && stdinContent.length > 0) {
      prompt = stdinContent;
    } else if (!prompt && stdinContent.length === 0) {
      console.error('[lavalamp] Error: prompt argument required');
      process.exit(1);
    }

    await runPrint({
      allowModelFallback,
      backend,
      autoApprove,
      prompt,
      stdinContent,
      quiet,
      outputFormat,
      workspaceRoot,
      serverPath,
      config,
      env,
      model,
      agentName,
      sudo: sudoMode,
      sessionId: resumeSessionId,
      threadId: codexResumeRecord?.codexThreadId,
    });
  } else if (replLikeMode) {
    await runRepl({
      allowModelFallback,
      backend,
      quiet: quiet || simpleMode,
      outputFormat,
      workspaceRoot,
      serverPath,
      config,
      env,
      model,
      agentName,
      simpleMode,
      sudo: sudoMode,
      sessionId: resumeSessionId,
      threadId: codexResumeRecord?.codexThreadId,
    });
  } else {
    await preflightInteractiveAuth({
      backend,
      config,
      env,
      model,
      outputFormat,
    });

    await startTui({
      allowModelFallback,
      agentName,
      backend,
      cwd: workspaceRoot,
      model,
      resumeSession,
      resumeSessionId,
      serverPath,
    }).catch((error: unknown) => {
      console.error(`[lavalamp] Fatal: ${(error as Error).message}`);
      process.exit(1);
    });
  }
}

await main();
