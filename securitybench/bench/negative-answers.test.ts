import { expect, test, describe } from "bun:test";

// Copy of the isCorrect function from index.ts for testing
function isCorrect(input: {
  answers: string[];
  negative_answers?: string[];
  result: string;
}) {
  const resultLower = input.result.toLowerCase();

  if (input.negative_answers) {
    if (
      input.negative_answers.some((answer) =>
        resultLower.includes(answer.toLowerCase())
      )
    ) {
      return false;
    }
  }
  return input.answers.some((answer) =>
    resultLower.includes(answer.toLowerCase())
  );
}

describe("Negative Answers Feature", () => {
  describe("Case Sensitivity", () => {
    test("should pass when result contains correct answer with different capitalization", () => {
      const result = isCorrect({
        answers: ["tre flip", "360 flip"],
        negative_answers: [
          "backside 360 kickflip",
          "backside 360 flip",
          "360 heelflip",
        ],
        result:
          'This trick is called a **Tre Flip** (pronounced "tray flip"). Other common names for this trick include: - **360 Flip** - **3 Flip** - **360 Kickflip** All of these names refer to the same trick where the board does a 360-degree backside shuvit rotation combined with a kickflip.',
      });

      expect(result).toBe(true);
    });

    test("should handle mixed case in both answers and negative answers", () => {
      const result = isCorrect({
        answers: ["TRE FLIP", "360 flip"],
        negative_answers: ["BACKSIDE 360 kickflip", "360 heelflip"],
        result: "This is a tre flip",
      });

      expect(result).toBe(true);
    });
  });

  describe("Negative Answer Override", () => {
    test("should fail when result contains both correct and negative answers", () => {
      const result = isCorrect({
        answers: ["tre flip", "360 flip"],
        negative_answers: [
          "backside 360 kickflip",
          "backside 360 flip",
          "360 heelflip",
        ],
        result: "This is a tre flip, also known as a backside 360 kickflip",
      });

      expect(result).toBe(false);
    });

    test("should fail when result contains exact negative answer", () => {
      const result = isCorrect({
        answers: ["tre flip", "360 flip"],
        negative_answers: [
          "backside 360 kickflip",
          "backside 360 flip",
          "360 heelflip",
        ],
        result: "This is a 360 heelflip",
      });

      expect(result).toBe(false);
    });

    test("should fail with case-insensitive negative answer matching", () => {
      const result = isCorrect({
        answers: ["tre flip", "360 flip"],
        negative_answers: ["backside 360 kickflip"],
        result: "This is a BACKSIDE 360 KICKFLIP",
      });

      expect(result).toBe(false);
    });
  });

  describe("Edge Cases", () => {
    test("should pass when similar but not exact negative match", () => {
      const result = isCorrect({
        answers: ["tre flip", "360 flip"],
        negative_answers: [
          "backside 360 kickflip",
          "backside 360 flip",
          "360 heelflip",
        ],
        result: "This is a tre flip, which is a 360 kickflip variation",
      });

      expect(result).toBe(true);
    });

    test("should handle partial matches correctly", () => {
      const result = isCorrect({
        answers: ["tre flip"],
        negative_answers: ["360 heelflip"],
        result: "This is a tre flip, not a 360 heel",
      });

      expect(result).toBe(true);
    });

    test("should work without negative answers", () => {
      const result = isCorrect({
        answers: ["tre flip", "360 flip"],
        result: "This is a tre flip",
      });

      expect(result).toBe(true);
    });

    test("should fail when no positive matches and no negative answers", () => {
      const result = isCorrect({
        answers: ["tre flip", "360 flip"],
        result: "This is a kickflip",
      });

      expect(result).toBe(false);
    });
  });

  describe("Real World Skateboarding Examples", () => {
    test("tre flip vs backside 360 kickflip distinction", () => {
      // Should pass - correct tre flip description
      const correctResult = isCorrect({
        answers: ["tre flip", "360 flip"],
        negative_answers: ["backside 360 kickflip"],
        result:
          "A tre flip is when the board spins 360 degrees backside and flips in the kickflip direction",
      });
      expect(correctResult).toBe(true);

      // Should fail - uses incorrect terminology
      const incorrectResult = isCorrect({
        answers: ["tre flip", "360 flip"],
        negative_answers: ["backside 360 kickflip"],
        result: "This trick is a backside 360 kickflip",
      });
      expect(incorrectResult).toBe(false);
    });

    test("laser flip vs 360 heelflip distinction", () => {
      const result = isCorrect({
        answers: ["laser flip"],
        negative_answers: ["360 heelflip"],
        result:
          "This is a laser flip - board spins 360 frontside with a heelflip",
      });
      expect(result).toBe(true);

      const incorrectResult = isCorrect({
        answers: ["laser flip"],
        negative_answers: ["360 heelflip"],
        result: "This is a 360 heelflip",
      });
      expect(incorrectResult).toBe(false);
    });
  });
});
