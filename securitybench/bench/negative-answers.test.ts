import { describe, expect, test } from "bun:test";
import { isCorrect } from "./index";

describe("strict benchmark scoring", () => {
  const input = {
    answers: ["VERDICT: SAFE"],
    negative_answers: ["VERDICT: VULNERABLE"],
  };

  test("accepts only a canonical answer", () => {
    expect(isCorrect({ ...input, result: "VERDICT: SAFE" })).toBe(true);
    expect(isCorrect({ ...input, result: "  verdict: safe\n" })).toBe(true);
  });

  test("rejects preambles and explanations", () => {
    expect(
      isCorrect({
        ...input,
        result: "I'll analyze this handler.VERDICT: SAFE",
      })
    ).toBe(false);
    expect(
      isCorrect({ ...input, result: "VERDICT: SAFE because input is bound" })
    ).toBe(false);
  });

  test("rejects partial and multiple answers", () => {
    expect(isCorrect({ ...input, result: "SAFE" })).toBe(false);
    expect(
      isCorrect({
        ...input,
        result: "VERDICT: SAFE / VERDICT: VULNERABLE",
      })
    ).toBe(false);
  });

  test("accepts one of several canonical aliases", () => {
    expect(
      isCorrect({
        answers: ["PATCH: OPTION_A", "PATCH: OPTION_B"],
        result: "PATCH: OPTION_B",
      })
    ).toBe(true);
  });
});
