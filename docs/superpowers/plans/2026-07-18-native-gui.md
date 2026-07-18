# Lavalamp Native GUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an additive Native SDK desktop GUI with full persistent Lavalamp agent interaction while leaving the OpenTUI path unchanged.

**Architecture:** A loopback Bun host adapts the existing `FlueProcess` to typed JSON endpoints and normalized events. A native-rendered Native SDK app owns presentation and deterministic state, starts the host, submits actions over HTTP, and incrementally polls events.

**Tech Stack:** Bun, TypeScript, Native SDK TypeScript core, Native markup, Zig 0.16 toolchain managed by Native SDK.

## Global Constraints

- Existing `lavalamp` TUI behavior and default command stay unchanged.
- GUI uses native-rendered `.native` markup, no WebView.
- Host binds only `127.0.0.1` and authenticates every non-health request.
- Permission requests default to pending or denied, never automatic allow.
- GUI visual language uses neutral Vercel-like surfaces and Native SDK Geist typography.

---

### Task 1: GUI Host Contracts and Event Store

**Files:**
- Create: `src/gui-host/contracts.ts`
- Create: `src/gui-host/event-store.ts`
- Test: `tests/gui-host-event-store.test.ts`

**Interfaces:**
- Produces: `GuiEvent`, `GuiSnapshot`, `GuiEventStore.append()`, `GuiEventStore.after()`, `GuiEventStore.snapshot()`.

- [ ] Write tests proving monotonically increasing event IDs, cursor reads, bounded retention, and snapshot preservation.
- [ ] Run `bun test tests/gui-host-event-store.test.ts`; verify failure from missing modules.
- [ ] Implement immutable serializable contracts and bounded store.
- [ ] Re-run focused test; expect all pass.

### Task 2: Flue Runtime Adapter

**Files:**
- Create: `src/gui-host/runtime.ts`
- Test: `tests/gui-host-runtime.test.ts`
- Reuse: `src/tui/ipc.ts`

**Interfaces:**
- Consumes: `FlueProcess`, `GuiEventStore`.
- Produces: `GuiRuntime.start()`, `submitPrompt()`, `respondPermission()`, `respondQuestion()`, `shutdown()`.

- [ ] Write injected-fake tests for streamed text, tool lifecycle, bash stream, result usage, runtime errors, permission requests, and question requests.
- [ ] Run focused test; verify missing adapter failure.
- [ ] Implement adapter over existing callbacks without changing TUI code.
- [ ] Re-run focused tests; expect all pass.

### Task 3: Loopback HTTP Server

**Files:**
- Create: `src/gui-host/server.ts`
- Create: `src/gui-host/main.ts`
- Test: `tests/gui-host-server.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `GuiRuntime`, `GuiEventStore`.
- Produces: `createGuiHostServer(options)`, executable `gui:host` script, `/v1/*` API from design.

- [ ] Write API tests for bearer auth, loopback guard, body limit, prompt validation, cursor reads, permission decisions, questions, sessions, models, health, and JSON error envelope.
- [ ] Run focused test; verify server imports fail.
- [ ] Implement Bun server with injected runtime and exact routes.
- [ ] Re-run focused tests; expect all pass.

### Task 4: Scaffold Native SDK App and Core State

**Files:**
- Create: `gui/app.zon`
- Create: `gui/src/core.ts`
- Create: `gui/src/protocol.ts`
- Create: `gui/package.json`
- Create: `gui/tsconfig.json`
- Create: `gui/.gitignore`

**Interfaces:**
- Consumes: host HTTP contract.
- Produces: `Model`, exhaustive `Msg`, `initialModel()`, `update()`, polling subscriptions, derived view bindings.

- [ ] Scaffold `gui/` with `npx --yes @native-sdk/cli init gui --template ts-core`.
- [ ] Add core tests/scenario for connection, prompt submission, event folding, permission actions, session switching, and errors.
- [ ] Run `npx --yes @native-sdk/cli dev gui --core --script gui/tests/core.ndjson`; verify desired transitions fail before implementation.
- [ ] Implement minimal state machine using `Cmd.spawn`, `Cmd.fetch`, text reducer, and keyed polling.
- [ ] Re-run core scenario; expect correct model transcript.

### Task 5: Vercel-Style Native Markup

**Files:**
- Replace: `gui/src/app.native`
- Create: `gui/assets/icon.png`

**Interfaces:**
- Consumes: core bindings and message tags.
- Produces: sidebar, conversation canvas, composer, tool/permission/question cards, activity rail, empty/loading/error states.

- [ ] Run `npx --yes @native-sdk/cli check gui --strict` against initial binding additions; verify missing bindings fail.
- [ ] Implement responsive three-region native layout using neutral tokens, compact controls, one-pixel borders, and Geist typography.
- [ ] Re-run `check`; expect zero diagnostics.

### Task 6: Launch Integration and Documentation

**Files:**
- Modify: `src/run.ts`
- Modify: `package.json`
- Modify: `README.md`
- Test: `tests/lavalamp-launcher.test.ts`

**Interfaces:**
- Produces: explicit `lavalamp gui` launch path and `gui:dev`, `gui:check`, `gui:test`, `gui:build` scripts; default TUI unchanged.

- [ ] Add failing launcher test proving `gui` routes separately while empty command still starts TUI.
- [ ] Run focused launcher test; verify failure.
- [ ] Add GUI launcher and scripts, then document setup and commands.
- [ ] Re-run launcher tests; expect pass.

### Task 7: Full Verification and Native Automation

**Files:**
- Modify only files needed for defects found during verification.

- [ ] Run `bun test` and record zero failures.
- [ ] Run `bun run typecheck` and record exit 0.
- [ ] Run `npx --yes @native-sdk/cli check gui --strict` and record zero diagnostics.
- [ ] Run `npx --yes @native-sdk/cli test gui` and record pass.
- [ ] Launch GUI through `native dev gui`, use automation snapshot, click composer/send/permission controls with fake host, and capture screenshot.
- [ ] Run `npx --yes @native-sdk/cli build gui` and record produced release binary.
