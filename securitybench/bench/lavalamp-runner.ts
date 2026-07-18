import { resolve } from "node:path";

export type LavalampCommandRequest = {
  command: string;
  args: string[];
  signal: AbortSignal;
};

export type LavalampCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type LavalampCommandExecutor = (
  request: LavalampCommandRequest
) => Promise<LavalampCommandResult>;

export type LavalampRunInput = {
  modelId: string;
  systemPrompt: string;
  prompt: string;
  timeoutMs: number;
};

export type LavalampRunResult = {
  text: string;
  cost: number;
  completionTokens: number;
  raw: Record<string, unknown>;
};

export type LavalampRunnerOptions = {
  binaryPath?: string;
  execute?: LavalampCommandExecutor;
};

export function composeBenchmarkPrompt(systemPrompt: string, prompt: string) {
  return `<benchmark_system_prompt>\n${systemPrompt}\n</benchmark_system_prompt>\n\n<benchmark_test_prompt>\n${prompt}\n</benchmark_test_prompt>`;
}

const executeCommand: LavalampCommandExecutor = async (request) => {
  const child = Bun.spawn([request.command, ...request.args], {
    env: process.env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const abort = () => child.kill();
  request.signal.addEventListener("abort", abort, { once: true });

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stderr, stdout };
  } finally {
    request.signal.removeEventListener("abort", abort);
  }
};

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export async function runLavalamp(
  input: LavalampRunInput,
  options: LavalampRunnerOptions = {}
): Promise<LavalampRunResult> {
  const binaryPath =
    options.binaryPath ??
    process.env.SECURITYBENCH_LAVALAMP_BIN ??
    resolve(import.meta.dir, "../../bin/lavalamp");
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs);

  let commandResult: LavalampCommandResult;
  try {
    commandResult = await (options.execute ?? executeCommand)({
      args: [
        "--model",
        input.modelId,
        "--print",
        composeBenchmarkPrompt(input.systemPrompt, input.prompt),
        "--output-format",
        "json",
        "--quiet",
      ],
      command: binaryPath,
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) {
      throw new Error(`Lavalamp timed out after ${input.timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (timedOut) {
    throw new Error(`Lavalamp timed out after ${input.timeoutMs}ms`);
  }
  if (commandResult.exitCode !== 0) {
    const detail = commandResult.stderr.trim() || commandResult.stdout.trim();
    throw new Error(
      `Lavalamp exited with code ${commandResult.exitCode}${
        detail ? `: ${detail}` : ""
      }`
    );
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(commandResult.stdout.trim()) as Record<string, unknown>;
  } catch {
    throw new Error("Lavalamp returned invalid JSON");
  }

  if (typeof raw.text !== "string") {
    throw new Error("Lavalamp JSON response missing text");
  }
  const usage =
    typeof raw.usage === "object" && raw.usage !== null
      ? (raw.usage as Record<string, unknown>)
      : {};
  const usageCost =
    typeof usage.cost === "object" && usage.cost !== null
      ? (usage.cost as Record<string, unknown>)
      : {};

  return {
    completionTokens: numeric(usage.output ?? usage.outputTokens),
    cost: numeric(usageCost.total),
    raw,
    text: raw.text,
  };
}
