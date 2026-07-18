export type RunnerBackend = "lavalamp" | "ai-sdk";

export function resolveRunnerBackend(
  value: string | undefined
): RunnerBackend {
  const backend = value ?? "lavalamp";
  if (backend !== "lavalamp" && backend !== "ai-sdk") {
    throw new Error("SECURITYBENCH_RUNNER must be lavalamp or ai-sdk");
  }
  return backend;
}

export function resolveMaxConcurrency(
  backend: RunnerBackend,
  value: string | undefined
): number {
  if (value === undefined) {
    return backend === "lavalamp" ? 4 : 80;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      "SECURITYBENCH_MAX_CONCURRENCY must be a positive integer"
    );
  }
  return parsed;
}
