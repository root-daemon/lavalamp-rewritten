# Security Analysis Benchmark v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add validated full and Lite security-analysis datasets using Skatebench's existing JSON runner contract.

**Architecture:** Store one canonical 16-case suite and one exact eight-case subset in `bench/tests`. Add optional task metadata to the shared TypeScript contract and use Bun tests to enforce structure, coverage, answer exclusivity, source-to-sink ground truth, and exact subset equivalence.

**Tech Stack:** TypeScript, Bun test runner, JSON benchmark suites.

## Global Constraints

- Full dataset name: `Security Analysis Benchmark v1`.
- Lite dataset name: `Security Analysis Benchmark Lite v1`.
- Do not use the word prohibited by the user anywhere in either dataset.
- Full suite contains exactly 16 tests across CWE-89, CWE-78, CWE-22, and CWE-79.
- Lite suite contains exactly the eight unmodified CWE-89 and CWE-78 tests from Full.
- Each CWE has detection, safe-twin, exploit-trace, and remediation axes.
- Each test has one canonical positive answer and exhaustive mutually exclusive negative tokens.
- No new runtime dependencies.

---

### Task 1: Add dataset metadata contract and validation tests

**Files:**
- Modify: `bench/index.ts:17-29`
- Create: `bench/security-analysis-benchmark.test.ts`

**Interfaces:**
- Consumes: existing `TestCase` and `TestSuite` JSON structure.
- Produces: `SecurityAnalysisAxis`, `TestProvenance`, optional metadata on `TestCase`, and validation coverage for both suites.

- [ ] **Step 1: Write failing dataset tests**

Create a Bun test that loads both JSON files and asserts:

```ts
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
  "xss-remediation": "PATCH: OPTION_C"
} as const;
```

The test must also check unique IDs, one answer per test, no positive/negative overlap, four cases per axis, four cases per CWE, metadata completeness, no prohibited name, and exact deep equality between Lite cases and Full cases for CWE-89/CWE-78.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd bench && bun test security-analysis-benchmark.test.ts`

Expected: FAIL with missing `tests/security-analysis-test.json`.

- [ ] **Step 3: Extend the optional metadata types**

Add:

```ts
export type SecurityAnalysisAxis =
  | "detection"
  | "safe-twin"
  | "exploit-trace"
  | "remediation";

export type TestProvenance = {
  source: string;
  basis: string;
};
```

Extend `TestCase` with optional `id`, `axis`, `cwe`, `rationale`, and `provenance` fields so existing suites remain compatible.

- [ ] **Step 4: Run the typechecker**

Run: `cd bench && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit contract and failing test**

```bash
git add bench/index.ts bench/security-analysis-benchmark.test.ts
git commit -m "test: define security benchmark dataset contract"
```

### Task 2: Add the canonical Full dataset

**Files:**
- Create: `bench/tests/security-analysis-test.json`

**Interfaces:**
- Consumes: optional metadata fields from Task 1.
- Produces: 16 runnable `TestCase` objects with IDs and canonical answers listed in `expectedFullAnswers`.

- [ ] **Step 1: Create all SQL injection cases**

Use an Express-style handler with `req.query.email` flowing into `db.query`. Vulnerable case uses template-string SQL. Safe twin uses `$1` binding. Exploit answer traces request source through interpolation to query sink. Correct patch uses constant SQL plus bound parameter; distractors use quote replacement and post-query validation.

- [ ] **Step 2: Create all command injection cases**

Use `req.body.archive` flowing into `exec` with a shell command. Safe twin validates archive name and uses `execFile` with separated arguments. Exploit answer traces the body value through shell interpolation. Correct patch uses allowlist validation plus `execFile`; distractors escape one metacharacter or validate after execution.

- [ ] **Step 3: Create all path traversal cases**

Use `req.params.name` flowing into `path.join` and `readFile`. State that no symlinks exist below the fixed root. Safe twin uses `path.resolve`, a separator-aware root prefix, and rejection before file access. Correct patch performs the same canonical containment check; distractors remove only `..` once or check after reading.

- [ ] **Step 4: Create all reflected XSS cases**

Use `req.query.term` interpolated into HTML text. Safe twin applies explicit HTML-text encoding for `&`, `<`, `>`, `"`, and `'`. Correct patch uses context-aware encoding before interpolation; distractors remove `<script>` only or apply URL encoding.

- [ ] **Step 5: Run dataset validation**

Run: `cd bench && bun test security-analysis-benchmark.test.ts`

Expected: FAIL only for missing Lite dataset after all Full assertions pass.

- [ ] **Step 6: Commit Full dataset**

```bash
git add bench/tests/security-analysis-test.json
git commit -m "feat: add security analysis benchmark v1"
```

### Task 3: Add the exact Lite subset and verify everything

**Files:**
- Create: `bench/tests/security-analysis-lite-test.json`

**Interfaces:**
- Consumes: Full dataset task objects.
- Produces: eight byte-equivalent JSON task objects for CWE-89 and CWE-78.

- [ ] **Step 1: Create Lite suite metadata and subset**

Set suite ID to `security-analysis-lite-v1`, use the Lite name, and copy the eight SQL injection and command injection test objects without modifying any nested field. Suite-level name, ID, and description may differ; `system_prompt` must match Full.

- [ ] **Step 2: Run focused tests**

Run: `cd bench && bun test security-analysis-benchmark.test.ts negative-answers.test.ts`

Expected: all tests PASS.

- [ ] **Step 3: Run typecheck and full test suite**

Run: `cd bench && bun run typecheck && bun test`

Expected: typecheck PASS and all Bun tests PASS.

- [ ] **Step 4: Check repository diff**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; only planned dataset, test, and type-contract files remain uncommitted.

- [ ] **Step 5: Commit Lite dataset**

```bash
git add bench/tests/security-analysis-lite-test.json
git commit -m "feat: add lite security analysis benchmark v1"
```
