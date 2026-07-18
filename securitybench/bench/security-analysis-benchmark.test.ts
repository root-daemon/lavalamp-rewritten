import { describe, expect, test } from "bun:test";
import { readFile } from "fs/promises";
import { join } from "path";

type Axis = "detection" | "safe-twin" | "exploit-trace" | "remediation";

type SecurityCase = {
  id: string;
  axis: Axis;
  cwe: "CWE-89" | "CWE-78" | "CWE-22" | "CWE-79";
  rationale: string;
  provenance: { source: string; basis: string };
  prompt: string;
  answers: string[];
  negative_answers: string[];
};

type SecuritySuite = {
  id: string;
  name: string;
  description: string;
  system_prompt: string;
  tests: SecurityCase[];
};

const expectedFullAnswers = {
  "sqli-detect-vulnerable": "VERDICT: VULNERABLE; CWE: CWE-89",
  "sqli-safe-twin": "VERDICT: SAFE",
  "sqli-exploit-trace": "EXPLOIT_PATH: OPTION_B",
  "sqli-remediation": "PATCH: OPTION_A",
  "command-detect-vulnerable": "VERDICT: VULNERABLE; CWE: CWE-78",
  "command-safe-twin": "VERDICT: SAFE",
  "command-exploit-trace": "EXPLOIT_PATH: OPTION_C",
  "command-remediation": "PATCH: OPTION_A",
  "path-detect-vulnerable": "VERDICT: VULNERABLE; CWE: CWE-22",
  "path-safe-twin": "VERDICT: SAFE",
  "path-exploit-trace": "EXPLOIT_PATH: OPTION_A",
  "path-remediation": "PATCH: OPTION_C",
  "xss-detect-vulnerable": "VERDICT: VULNERABLE; CWE: CWE-79",
  "xss-safe-twin": "VERDICT: SAFE",
  "xss-exploit-trace": "EXPLOIT_PATH: OPTION_B",
  "xss-remediation": "PATCH: OPTION_C",
} as const;

async function loadSuite(filename: string): Promise<SecuritySuite> {
  const raw = await readFile(join(import.meta.dir, "tests", filename), "utf8");
  return JSON.parse(raw) as SecuritySuite;
}

function countsBy<T extends string>(values: T[]) {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

describe("Security Analysis Benchmark datasets", () => {
  test("full suite has complete balanced ground truth", async () => {
    const suite = await loadSuite("security-analysis-test.json");
    const expectedIds = Object.keys(expectedFullAnswers);

    expect(suite.id).toBe("security-analysis-v1");
    expect(suite.name).toBe("Security Analysis Benchmark v1");
    expect(suite.tests).toHaveLength(16);
    expect(new Set(suite.tests.map((item) => item.id)).size).toBe(16);
    expect(suite.tests.map((item) => item.id).sort()).toEqual(expectedIds.sort());
    expect(countsBy(suite.tests.map((item) => item.axis))).toEqual({
      detection: 4,
      "safe-twin": 4,
      "exploit-trace": 4,
      remediation: 4,
    });
    expect(countsBy(suite.tests.map((item) => item.cwe))).toEqual({
      "CWE-89": 4,
      "CWE-78": 4,
      "CWE-22": 4,
      "CWE-79": 4,
    });

    for (const item of suite.tests) {
      expect(item.answers).toEqual([
        expectedFullAnswers[item.id as keyof typeof expectedFullAnswers],
      ]);
      expect(item.negative_answers.length).toBeGreaterThan(0);
      expect(new Set(item.negative_answers).size).toBe(
        item.negative_answers.length
      );
      expect(
        item.negative_answers.some(
          (answer) => answer.toLowerCase() === item.answers[0].toLowerCase()
        )
      ).toBe(false);
      expect(item.rationale.trim().length).toBeGreaterThan(20);
      expect(item.provenance.source).toBe("OWASP Benchmark");
      expect(item.provenance.basis.trim().length).toBeGreaterThan(10);

      if (item.axis === "exploit-trace" || item.axis === "remediation") {
        expect(item.prompt.match(/OPTION_[ABC]:/g)).toHaveLength(3);
        expect(item.negative_answers).toHaveLength(2);
      }
    }

    const forbiddenName = ["smo", "ke"].join("");
    expect(JSON.stringify(suite).toLowerCase()).not.toContain(forbiddenName);
  });

  test("lite suite is exact SQL injection and command injection subset", async () => {
    const full = await loadSuite("security-analysis-test.json");
    const lite = await loadSuite("security-analysis-lite-test.json");
    const expectedSubset = full.tests.filter((item) =>
      ["CWE-89", "CWE-78"].includes(item.cwe)
    );

    expect(lite.id).toBe("security-analysis-lite-v1");
    expect(lite.name).toBe("Security Analysis Benchmark Lite v1");
    expect(lite.system_prompt).toBe(full.system_prompt);
    expect(lite.tests).toHaveLength(8);
    expect(lite.tests).toEqual(expectedSubset);
  });
});
