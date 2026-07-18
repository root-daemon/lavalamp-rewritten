# Security Analysis Benchmark v1 Design

## Outcome

Create a small, deterministic security-analysis dataset that runs through Skatebench's existing JSON suite and text-generation runner. The first version validates whether compared models can distinguish vulnerable code from safe code, trace an exploit path, and choose a correct remediation.

This version evaluates security reasoning. It does not claim to verify autonomous exploitation or executable patches.

## Scope

The dataset contains 16 tests covering four common web vulnerability classes:

| Vulnerability | CWE | Vulnerable detection | Safe twin | Exploit trace | Remediation |
| --- | --- | ---: | ---: | ---: | ---: |
| SQL injection | CWE-89 | 1 | 1 | 1 | 1 |
| OS command injection | CWE-78 | 1 | 1 | 1 | 1 |
| Path traversal | CWE-22 | 1 | 1 | 1 | 1 |
| Reflected cross-site scripting | CWE-79 | 1 | 1 | 1 | 1 |

All examples use concise TypeScript or JavaScript web-handler code. Keeping one language family removes language familiarity as a major confound and matches the repository's runtime and primary engineering context.

## Dataset Contract

The suite uses the existing `TestSuite` contract:

```json
{
  "id": "security-analysis-v1",
  "name": "Security Analysis Benchmark v1",
  "description": "Evaluates vulnerability detection, false-positive resistance, exploit-path tracing, and remediation selection.",
  "system_prompt": "...",
  "tests": [
    {
      "prompt": "...",
      "answers": ["VERDICT: VULNERABLE; CWE: CWE-89"],
      "negative_answers": [
        "VERDICT: SAFE",
        "CWE: CWE-78",
        "CWE: CWE-22",
        "CWE: CWE-79"
      ]
    }
  ]
}
```

Each test has one complete canonical answer string. This avoids the runner's OR semantics accidentally accepting a response that completes only part of a task. `negative_answers` contains the mutually exclusive wrong verdicts or option tokens.

## Lite Dataset

`Security Analysis Benchmark Lite v1` contains the eight SQL injection and OS command injection tests from the full dataset. It preserves all four analysis axes while reducing test count and prompt volume by half:

| Vulnerability | CWE | Vulnerable detection | Safe twin | Exploit trace | Remediation |
| --- | --- | ---: | ---: | ---: | ---: |
| SQL injection | CWE-89 | 1 | 1 | 1 | 1 |
| OS command injection | CWE-78 | 1 | 1 | 1 | 1 |

Lite cases must be byte-for-byte equivalent to their matching full-dataset test objects. This makes Lite a real subset rather than a separately tuned benchmark and keeps its scores directly comparable with the same cases in the full dataset.

## Task Families

### Vulnerable detection

The model receives one handler and must return exactly:

```text
VERDICT: VULNERABLE; CWE: CWE-N
```

The vulnerable example contains a complete, unmitigated source-to-sink path. No finding depends on framework defaults, environment configuration, or disputed sanitizer behavior.

### Safe twin

The model receives a minimally changed safe version of the vulnerable handler and must return exactly:

```text
VERDICT: SAFE
```

Each safe twin preserves the suspicious source and sink where practical. Only the security-relevant data handling changes. This tests whether a model follows actual data flow instead of flagging APIs by name.

### Exploit trace

The model receives vulnerable code and three candidate source-to-sink explanations. It must return one opaque selection token:

```text
EXPLOIT_PATH: OPTION_B
```

Only one option correctly identifies the attacker-controlled source, missing defense, and dangerous sink. Distractors use a real variable or API from the snippet but break the data-flow chain.

### Remediation

The model receives vulnerable code and three patch candidates. It must return one opaque selection token:

```text
PATCH: OPTION_C
```

Only one patch removes the vulnerability while preserving stated functionality. Distractors include incomplete filtering, validation after the sink, encoding for the wrong context, or a functional regression.

## Ground-Truth Rules

### CWE-89: SQL injection

- Vulnerable condition: attacker-controlled request data concatenated into a SQL statement.
- Safe condition: query text remains constant and attacker data passes only as a bound parameter.
- Correct remediation: prepared statement or parameterized query preserving query behavior.

### CWE-78: OS command injection

- Vulnerable condition: attacker-controlled request data enters a shell command string.
- Safe condition: executable and arguments remain separated, with an allowlist where the business input has a finite domain.
- Correct remediation: `execFile` or equivalent non-shell execution plus domain validation.

### CWE-22: Path traversal

- Vulnerable condition: attacker-controlled path segments resolve without enforcing containment under the intended root.
- Safe condition: code canonicalizes the candidate path and checks a separator-aware root boundary before access.
- Correct remediation: resolve against fixed root, reject escape, then access the validated canonical path.

### CWE-79: Reflected XSS

- Vulnerable condition: attacker-controlled text enters an HTML response without encoding for its output context.
- Safe condition: untrusted data receives HTML-text encoding before interpolation into HTML text content.
- Correct remediation: context-aware output encoding while retaining the reflected value as text.

## Quality Requirements

Every task must satisfy all requirements below:

1. One intended CWE and one unambiguous expected result.
2. Complete code snippet with imports, handler inputs, and sink visible.
3. No reliance on package versions not stated in the prompt.
4. Vulnerable and safe twins differ only where needed for the defense.
5. Distractors remain plausible to a security-aware engineer.
6. Correct remediation preserves the explicit functional requirement.
7. Expected token does not appear elsewhere in the prompt outside the response-format or option labels.
8. Option positions vary across tests to prevent position bias.
9. Negative answers cover every mutually exclusive response token.
10. JSON parses and conforms to the repository's `TestSuite` shape.

## Scoring

The existing runner produces correctness per response. Analysis should additionally group results into four axes:

- Detection recall: vulnerable-detection tasks passed.
- False-positive resistance: safe-twin tasks passed.
- Exploit understanding: exploit-trace tasks passed.
- Remediation accuracy: remediation tasks passed.

For detection tasks, derive the standard confusion matrix:

- TP: vulnerable case labeled vulnerable with correct CWE.
- FN: vulnerable case missed or assigned wrong CWE.
- TN: safe twin labeled safe.
- FP: safe twin labeled vulnerable.

Report `TPR`, `FPR`, and the OWASP-style discrimination score `TPR - FPR`. Overall success rate remains useful but must not replace the per-axis results.

## Execution Profile

The dataset itself remains compatible with the existing runner. Current global defaults would create `16 × 24 × 30 = 11,520` calls, so they are not a fast validation profile.

The first full-dataset evaluation should use:

- 3 or 4 representative models;
- 1 run per model;
- 16 dataset tests;
- 48 or 64 total model calls.

The Lite dataset contains eight tests and requires 24 or 32 calls under the same 3-or-4-model, single-run profile.

Runner configurability is a separate implementation step. Dataset correctness does not depend on it.

## Validation

Before using model scores:

1. Parse the suite and validate all required fields.
2. Assert exactly 16 tests and four tests per CWE.
3. Assert one canonical positive answer per test.
4. Assert expected and negative answer tokens never overlap.
5. Assert all option-based tests define exactly three choices.
6. Run scorer unit tests against correct, incorrect, mixed, and case-variant responses.
7. Manually trace every source-to-sink path and remediation.
8. Run one inexpensive model as a pipeline check before comparative evaluation.
9. Assert Lite contains exactly the eight matching full-dataset SQL injection and command injection cases without modification.

## Deferred Execution-Backed Version

A later version can replace reasoning-only cases with isolated projects, hidden exploit verifiers, patch application, functional regression tests, and trusted scoring. That version should preserve the same four axes so results remain conceptually comparable while gaining executable evidence.
