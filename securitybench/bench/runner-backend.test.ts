import { describe, expect, test } from "bun:test";
import { modelsToRun } from "./constants";
import {
  resolveMaxConcurrency,
  resolveRunnerBackend,
} from "./runner-backend";

describe("SecurityBench runner backend", () => {
  test("defaults to Lavalamp", () => {
    expect(resolveRunnerBackend(undefined)).toBe("lavalamp");
  });

  test("retains explicit AI SDK execution", () => {
    expect(resolveRunnerBackend("ai-sdk")).toBe("ai-sdk");
    expect(resolveRunnerBackend("lavalamp")).toBe("lavalamp");
  });

  test("rejects unknown backend", () => {
    expect(() => resolveRunnerBackend("other")).toThrow(
      "SECURITYBENCH_RUNNER must be lavalamp or ai-sdk"
    );
  });

  test("every benchmark model has a harness model ID", () => {
    expect(modelsToRun.length).toBeGreaterThan(0);
    for (const model of modelsToRun) {
      expect(model.modelId.length).toBeGreaterThan(0);
    }
  });

  test("uses bounded Lavalamp concurrency and retains AI SDK throughput", () => {
    expect(resolveMaxConcurrency("lavalamp", undefined)).toBe(4);
    expect(resolveMaxConcurrency("ai-sdk", undefined)).toBe(80);
    expect(resolveMaxConcurrency("lavalamp", "7")).toBe(7);
  });

  test("rejects invalid concurrency overrides", () => {
    expect(() => resolveMaxConcurrency("lavalamp", "0")).toThrow(
      "SECURITYBENCH_MAX_CONCURRENCY must be a positive integer"
    );
    expect(() => resolveMaxConcurrency("lavalamp", "2.5")).toThrow(
      "SECURITYBENCH_MAX_CONCURRENCY must be a positive integer"
    );
  });
});
