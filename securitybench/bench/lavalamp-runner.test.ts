import { describe, expect, test } from "bun:test";
import {
  composeBenchmarkPrompt,
  runLavalamp,
  type LavalampCommandExecutor,
} from "./lavalamp-runner";

describe("Lavalamp benchmark runner", () => {
  test("composes suite instructions separately from test input", () => {
    expect(composeBenchmarkPrompt("Return only token.", "Inspect code.")).toBe(
      "<benchmark_system_prompt>\nReturn only token.\n</benchmark_system_prompt>\n\n<benchmark_test_prompt>\nInspect code.\n</benchmark_test_prompt>"
    );
  });

  test("forwards model and parses Lavalamp JSON usage", async () => {
    const requests: Parameters<LavalampCommandExecutor>[0][] = [];
    const execute: LavalampCommandExecutor = async (request) => {
      requests.push(request);
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          text: "VERDICT: SAFE",
          usage: {
            output: 17,
            cost: { total: 0.0042 },
          },
        }),
      };
    };

    const result = await runLavalamp(
      {
        modelId: "anthropic/claude-sonnet-4.6",
        prompt: "Inspect code.",
        systemPrompt: "Return only token.",
        timeoutMs: 500,
      },
      { binaryPath: "/repo/bin/lavalamp", execute }
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].command).toBe("/repo/bin/lavalamp");
    expect(requests[0].args).toEqual([
      "--model",
      "anthropic/claude-sonnet-4.6",
      "--print",
      composeBenchmarkPrompt("Return only token.", "Inspect code."),
      "--output-format",
      "json",
      "--quiet",
    ]);
    expect(result.text).toBe("VERDICT: SAFE");
    expect(result.completionTokens).toBe(17);
    expect(result.cost).toBe(0.0042);
  });

  test("reports non-zero exit with stderr", async () => {
    const execute: LavalampCommandExecutor = async () => ({
      exitCode: 1,
      stderr: "authentication failed",
      stdout: "",
    });

    await expect(
      runLavalamp(
        {
          modelId: "openai/gpt-5",
          prompt: "test",
          systemPrompt: "system",
          timeoutMs: 500,
        },
        { execute }
      )
    ).rejects.toThrow("Lavalamp exited with code 1: authentication failed");
  });

  test("rejects malformed JSON and missing response text", async () => {
    const malformed: LavalampCommandExecutor = async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "not json",
    });
    const missingText: LavalampCommandExecutor = async () => ({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({ usage: {} }),
    });
    const input = {
      modelId: "openai/gpt-5",
      prompt: "test",
      systemPrompt: "system",
      timeoutMs: 500,
    };

    await expect(runLavalamp(input, { execute: malformed })).rejects.toThrow(
      "Lavalamp returned invalid JSON"
    );
    await expect(runLavalamp(input, { execute: missingText })).rejects.toThrow(
      "Lavalamp JSON response missing text"
    );
  });

  test("aborts execution after timeout", async () => {
    let aborted = false;
    const execute: LavalampCommandExecutor = (request) =>
      new Promise((_, reject) => {
        request.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });

    await expect(
      runLavalamp(
        {
          modelId: "openai/gpt-5",
          prompt: "test",
          systemPrompt: "system",
          timeoutMs: 5,
        },
        { execute }
      )
    ).rejects.toThrow("Lavalamp timed out after 5ms");
    expect(aborted).toBe(true);
  });
});
