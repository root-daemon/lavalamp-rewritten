# Lavalamp Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run SecurityBench's existing model matrix through local `bin/lavalamp` while retaining explicit AI SDK execution.

**Architecture:** Isolate Lavalamp subprocess behavior in `bench/lavalamp-runner.ts`, then select the backend in `bench/index.ts`. Keep scoring, result persistence, cache reuse, reports, and CLI progress code backend-agnostic.

**Tech Stack:** TypeScript, Bun, Bun test, Bash launcher, Lavalamp headless JSON CLI.

## Global Constraints

- Default backend: `lavalamp`.
- Legacy backend: `SECURITYBENCH_RUNNER=ai-sdk`.
- Executable override: `SECURITYBENCH_LAVALAMP_BIN`.
- Forward every model ID unchanged through `--model`.
- No new dependencies.
- No scoring, dataset, visualizer, or report-schema changes.

---

### Task 1: Define and test Lavalamp subprocess adapter

**Files:**
- Create: `bench/lavalamp-runner.ts`
- Create: `bench/lavalamp-runner.test.ts`

**Interfaces:**
- Produces: `runLavalamp(input: LavalampRunInput, options?: LavalampRunnerOptions): Promise<LavalampRunResult>`.
- `LavalampRunInput`: `modelId`, `systemPrompt`, `prompt`, `timeoutMs`.
- `LavalampRunResult`: `text`, `cost`, `completionTokens`, `raw`.

- [ ] Write failing tests for argument construction, prompt composition, response mapping, non-zero exit, invalid JSON, missing text, and timeout termination.
- [ ] Run `cd bench && bun test lavalamp-runner.test.ts`; expect missing-module failure.
- [ ] Implement an injected spawn boundary, stdout/stderr collection, timeout cleanup, strict JSON parsing, and usage normalization.
- [ ] Re-run focused tests; expect all adapter tests passing.

### Task 2: Route benchmark work through selected backend

**Files:**
- Modify: `bench/constants.ts`
- Modify: `bench/index.ts`
- Create: `bench/runner-backend.test.ts`

**Interfaces:**
- Add `modelId: string` to `RunnableModel` and populate it for every model.
- Export backend selection accepting only `lavalamp` and `ai-sdk`.
- Make `runTest` delegate to Lavalamp or the existing `generateText` path and return the existing result shape.

- [ ] Write failing tests proving default `lavalamp`, explicit `ai-sdk`, invalid-backend rejection, and model-ID completeness.
- [ ] Run `cd bench && bun test runner-backend.test.ts`; expect missing exports/type failures.
- [ ] Add stable model IDs and backend selection, then integrate `runLavalamp` without changing downstream result objects.
- [ ] Run focused adapter/backend tests; expect all passing.

### Task 3: Make launcher caller-port aware

**Files:**
- Modify: `bin/lavalamp`
- Create: `tests/lavalamp-launcher.test.ts`

**Interfaces:**
- Launcher uses `PORT="${PORT:-48392}"` for every Bun runtime execution.

- [ ] Write a source-level regression test covering all launcher execution branches.
- [ ] Run `bun test tests/lavalamp-launcher.test.ts`; expect hardcoded-port failure.
- [ ] Replace hardcoded environment assignments with caller-preserving fallback assignments.
- [ ] Re-run launcher test; expect pass.

### Task 4: Document and verify end-to-end compatibility

**Files:**
- Modify: `securitybench/README.md`

**Interfaces:**
- Document default Lavalamp execution, environment switches, executable override, authentication prerequisite, and exact run command.

- [ ] Add focused usage documentation.
- [ ] Run `cd securitybench/bench && bun run typecheck && bun test`.
- [ ] Run root `bun test tests/lavalamp-launcher.test.ts tests/e2e/cli.e2e.ts`.
- [ ] Run `git -C securitybench diff --check` and root `git diff --check`.
