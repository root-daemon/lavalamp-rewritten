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

export function resolveTestRuns(value: string | undefined): number {
  if (value === undefined) {
    return 30;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("SECURITYBENCH_TEST_RUNS must be a positive integer");
  }
  return parsed;
}

export function resolveLavalampModelIds(
  backend: RunnerBackend,
  value: string | undefined
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (backend !== "lavalamp") {
    throw new Error(
      "SECURITYBENCH_MODELS is only available with the lavalamp backend"
    );
  }
  const modelIds = value
    .split(",")
    .map((modelId) => modelId.trim())
    .filter(Boolean);
  if (modelIds.length === 0) {
    throw new Error("SECURITYBENCH_MODELS must contain at least one model ID");
  }
  return modelIds;
}
