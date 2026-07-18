# Native Subagents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface Codex native subagent threads and existing Flue research agents through one inspectable, stoppable subagent experience in the TUI and native GUI.

**Architecture:** Runtime processes expose a backend-neutral subagent contract. Codex derives it from app-server thread and collaboration notifications and lazily reads child history; Flue adapts `SubAgentManager`. The TUI and GUI host consume only the shared process interface, while the native GUI renders snapshot data and requests inspection on demand.

**Tech Stack:** TypeScript, Bun tests, Codex app-server JSON-RPC v2, OpenTUI, Zig, Native SDK markup.

## Global Constraints

- Use Bun instead of npm.
- Preserve Flue's existing maximum of three parallel research subprocesses and result merge behavior.
- Codex remains the owner of native subagent orchestration.
- Child inspection is read-only; do not add direct steering.
- Keep subagent notifications out of the main conversation transcript.
- Do not add dependencies.
- Do not add agent attribution to commits.

---

### Task 1: Define the shared subagent contract

**Files:**
- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/process.ts`
- Test: `tests/backend.test.ts`

**Interfaces:**
- Produces: `RuntimeSubagent`, `RuntimeSubagentStatus`, `RuntimeSubagentMessage`, and `RuntimeSubagentInspection`.
- Produces on `RuntimeProcess`: `onSubagentsChanged`, `onSubagentsComplete`, `listSubagents()`, `inspectSubagent(id)`, `stopSubagent(id)`, and `deploySubagents(queries)`.

- [ ] **Step 1: Write the failing interface test**

Add a compile-time/runtime factory assertion that Flue and Codex processes expose `listSubagents`, `inspectSubagent`, and `stopSubagent`.

```ts
expect(typeof process.listSubagents).toBe('function');
expect(typeof process.inspectSubagent).toBe('function');
expect(typeof process.stopSubagent).toBe('function');
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `bun test tests/backend.test.ts`

Expected: FAIL because the shared subagent methods do not exist.

- [ ] **Step 3: Add the contract and process surface**

Define:

```ts
export type RuntimeSubagentStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'stopped';

export interface RuntimeSubagent {
  id: string;
  parentId?: string;
  name: string;
  role?: string;
  task: string;
  status: RuntimeSubagentStatus;
  result?: string;
  error?: string;
  startedAt: number;
  model?: string;
}

export interface RuntimeSubagentMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface RuntimeSubagentInspection {
  subagent: RuntimeSubagent;
  messages: RuntimeSubagentMessage[];
}
```

Extend `RuntimeProcess` with concrete methods and optional update callbacks. Give both runtime implementations safe empty/no-op behavior before backend-specific wiring.

- [ ] **Step 4: Run the focused test**

Run: `bun test tests/backend.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/types.ts src/runtime/process.ts tests/backend.test.ts
git commit -m "feat: define runtime subagent contract"
```

### Task 2: Track Codex native child threads

**Files:**
- Create: `src/runtime/codex/subagents.ts`
- Modify: `src/runtime/codex/runtime.ts`
- Modify: `src/runtime/codex/history.ts`
- Test: `tests/codex-subagents.test.ts`
- Test: `tests/codex-process.integration.test.ts`

**Interfaces:**
- Consumes: shared runtime subagent types from Task 1.
- Produces: `CodexSubagentTracker` with `observeThreadStarted`, `observeThreadStatus`, `observeCollabItem`, `list`, `clear`, and `get`.
- Produces: Codex process implementations of list, inspect, and stop.

- [ ] **Step 1: Write tracker lifecycle tests**

Cover child introduction, out-of-order collaboration items, active-to-completed transitions, malformed payloads, and nested child relationships:

```ts
tracker.observeThreadStarted({
  id: 'child-1',
  parentThreadId: 'root-1',
  agentNickname: 'Atlas',
  agentRole: 'explorer',
  status: { type: 'active', activeFlags: [] },
});
expect(tracker.list()).toEqual([
  expect.objectContaining({ id: 'child-1', name: 'Atlas', status: 'running' }),
]);
```

- [ ] **Step 2: Run the tracker test and verify failure**

Run: `bun test tests/codex-subagents.test.ts`

Expected: FAIL because the tracker module does not exist.

- [ ] **Step 3: Implement the tracker**

Keep protocol parsing defensive. Map Codex statuses as follows: `pendingInit` to `pending`, `running`/thread `active` to `running`, `completed` to `completed`, `errored`/`systemError` to `failed`, `interrupted` to `interrupted`, and `shutdown`/`notFound` to `stopped`. Preserve terminal collab status when a later idle/not-loaded thread notification arrives.

- [ ] **Step 4: Run tracker tests**

Run: `bun test tests/codex-subagents.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing Codex process tests**

Assert that the app-server is spawned with native multi-agent enabled, child notifications reach `onSubagentsChanged`, `thread/read` is called only during inspection, and stop reads the child then sends `turn/interrupt` for its latest `inProgress` turn.

- [ ] **Step 6: Run process tests and verify failure**

Run: `bun test tests/codex-process.integration.test.ts`

Expected: FAIL on missing subagent callbacks and methods.

- [ ] **Step 7: Integrate the tracker into `CodexProcess`**

Start with:

```ts
spawn(this.executable, ['app-server', '--enable', 'multi_agent', '--stdio'], ...)
```

Handle `thread/started` and known-child `thread/status/changed` before the main-thread filter. Observe `collabAgentToolCall` items before normal event translation. Implement inspection through `thread/read({ threadId: id, includeTurns: true })`, map reconstructed user/assistant messages, and implement idempotent stop through the latest in-progress child turn.

- [ ] **Step 8: Run Codex tests**

Run: `bun test tests/codex-subagents.test.ts tests/codex-process.integration.test.ts tests/codex-events.test.ts tests/codex-runtime.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/runtime/codex/subagents.ts src/runtime/codex/runtime.ts src/runtime/codex/history.ts tests/codex-subagents.test.ts tests/codex-process.integration.test.ts
git commit -m "feat: track native Codex subagents"
```

### Task 3: Adapt Flue subagents to the runtime contract

**Files:**
- Modify: `src/tui/subs.ts`
- Modify: `src/runtime/process.ts`
- Test: `tests/subagents.test.ts`

**Interfaces:**
- Consumes: `RuntimeSubagent` and inspection types from Task 1.
- Produces: shared projection and inspection for `SubAgentManager`.
- Produces: `FlueRuntimeProcess.deploySubagents`, automatic update forwarding, completion forwarding, inspection, and stop.

- [ ] **Step 1: Write failing Flue adapter tests**

Use a fake `SubAgentManager` process factory so tests do not launch the Flue server. Verify state mapping:

```ts
expect(projectFlueSubagent({ id: 'sub-1', query: 'scan auth', status: 'done', result: 'ok', startTime: 1 }))
  .toMatchObject({ id: 'sub-1', task: 'scan auth', status: 'completed', result: 'ok' });
```

Also verify inspection returns the query as a user message and the result/error as an assistant message.

- [ ] **Step 2: Run the test and verify failure**

Run: `bun test tests/subagents.test.ts`

Expected: FAIL because projection and runtime wiring are missing.

- [ ] **Step 3: Implement Flue projection and runtime ownership**

Move orchestration ownership into `FlueRuntimeProcess`, forwarding manager callbacks through the runtime interface. Keep analytics injection available through `setSubagentAnalytics(recorder, parentTurn)`. Preserve the three-query cap and existing merged-summary callback.

- [ ] **Step 4: Run focused tests**

Run: `bun test tests/subagents.test.ts tests/analytics.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/subs.ts src/runtime/process.ts tests/subagents.test.ts
git commit -m "feat: adapt Flue subagents to runtime"
```

### Task 4: Add TUI visibility, inspection, and stop

**Files:**
- Modify: `src/tui/state.ts`
- Modify: `src/tui/components/QueueSubPanel.ts`
- Modify: `src/tui/events/Keybindings.ts`
- Modify: `src/tui/viewers.ts`
- Modify: `src/tui/app.ts`
- Modify: `src/tui/slash-data.ts`
- Test: `tests/tui-layout.test.ts`
- Test: `tests/tui-lifecycle.test.ts`

**Interfaces:**
- Consumes: runtime callbacks and methods from Tasks 1–3.
- Produces: `/subagents [id]` read-only inspection and backend-neutral stop handling.

- [ ] **Step 1: Write failing TUI tests**

Assert the panel renders shared `completed`/`interrupted` statuses, `/subagents` advertises inspection, and the keybinding invokes a `stopSubagent(id)` callback instead of depending on `SubAgentManager`.

- [ ] **Step 2: Run TUI tests and verify failure**

Run: `bun test tests/tui-layout.test.ts tests/tui-lifecycle.test.ts`

Expected: FAIL on the old Flue-only status and manager types.

- [ ] **Step 3: Add a read-only text viewer**

Add:

```ts
export function openTextViewer(
  ctx: ViewerContext,
  title: string,
  content: string,
): void
```

Render Markdown in the existing overlay with the same Vim navigation and `[READ ONLY]` title treatment.

- [ ] **Step 4: Wire runtime state into the TUI**

Replace direct manager ownership with `RuntimeProcess` callbacks. Continue detecting Flue's `parallel_deploy` marker, but call `flue.deploySubagents(queries)`. On `/subagents <id>`, await `inspectSubagent`, format its messages, and open the text viewer. With no argument, list IDs and include the hint `Inspect with /subagents <id>`.

- [ ] **Step 5: Wire stop behavior**

Change keybinding context from `subManager` to:

```ts
stopSubagent: (id: string) => void;
```

The `q` shortcut stops the first running subagent through the active runtime. Clear and shutdown call runtime-owned subagent cleanup.

- [ ] **Step 6: Run TUI tests**

Run: `bun test tests/tui-layout.test.ts tests/tui-lifecycle.test.ts tests/model-picker.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tui/state.ts src/tui/components/QueueSubPanel.ts src/tui/events/Keybindings.ts src/tui/viewers.ts src/tui/app.ts src/tui/slash-data.ts tests/tui-layout.test.ts tests/tui-lifecycle.test.ts
git commit -m "feat: inspect subagents in TUI"
```

### Task 5: Expose subagents through the GUI host

**Files:**
- Modify: `src/gui-host/contracts.ts`
- Modify: `src/gui-host/event-store.ts`
- Modify: `src/gui-host/runtime.ts`
- Modify: `src/gui-host/server.ts`
- Modify: `src/gui-host/main.ts`
- Modify: `src/run.ts`
- Test: `tests/gui-host-event-store.test.ts`
- Test: `tests/gui-host-runtime.test.ts`
- Test: `tests/gui-host-server.test.ts`

**Interfaces:**
- Consumes: shared process contract.
- Produces: `subagents.updated` GUI event, `snapshot.subagents`, `GET /v1/subagents/:id`, and `POST /v1/subagents/:id/stop`.

- [ ] **Step 1: Write failing event store and runtime tests**

Feed `onSubagentsChanged` with running and completed children and assert the snapshot replaces the list atomically without modifying main turn state.

- [ ] **Step 2: Run tests and verify failure**

Run: `bun test tests/gui-host-event-store.test.ts tests/gui-host-runtime.test.ts`

Expected: FAIL because GUI contracts do not include subagents.

- [ ] **Step 3: Implement GUI host state normalization**

Add:

```ts
| { type: 'subagents.updated'; subagents: RuntimeSubagent[] }
```

Wire process callbacks during `GuiRuntime.start`, add `inspectSubagent` and `stopSubagent` pass-through methods, and use `createRuntimeProcess` so the GUI host honors the configured backend.

- [ ] **Step 4: Write failing server route tests**

Assert authenticated inspection returns a transcript, unknown IDs return a conflict/not-found error, and stop calls the runtime once and remains safe for terminal children.

- [ ] **Step 5: Implement host routes and backend selection**

Add authenticated routes:

```text
GET  /v1/subagents/:id
POST /v1/subagents/:id/stop
```

Resolve the configured backend before the early `gui-host` branch in `src/run.ts`, pass it through `runGuiHost`, and perform backend-appropriate auth preflight/model selection.

- [ ] **Step 6: Run GUI host tests**

Run: `bun test tests/gui-host-event-store.test.ts tests/gui-host-runtime.test.ts tests/gui-host-server.test.ts tests/backend.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/gui-host src/run.ts tests/gui-host-event-store.test.ts tests/gui-host-runtime.test.ts tests/gui-host-server.test.ts
git commit -m "feat: expose subagents through GUI host"
```

### Task 6: Render read-only subagent inspection in the native GUI

**Files:**
- Modify: `gui/src/main.zig`
- Modify: `gui/src/app.native`
- Modify: `gui/src/tests.zig`

**Interfaces:**
- Consumes: GUI host snapshot and routes from Task 5.
- Produces: activity-rail subagent list, selected read-only transcript, and stop button for a running selected child.

- [ ] **Step 1: Write failing native model tests**

Extend the snapshot fixture with subagents and assert name, task, status, and selected state parse correctly. Add an inspection-response fixture and assert its transcript becomes visible without changing the main conversation.

- [ ] **Step 2: Run native tests and verify failure**

Run: `bun run gui:test`

Expected: FAIL because the Zig model has no subagent fields or messages.

- [ ] **Step 3: Implement the native model and effects**

Add fixed-capacity `Subagent` storage, `select_subagent`, `stop_subagent`, and `subagent_response` messages. Selection performs authenticated `GET /v1/subagents/:id`; stop performs authenticated POST to the stop route. Store the read-only transcript separately from `messages`.

- [ ] **Step 4: Render the activity rail**

Add a `Subagents` section above tool activity. Render each child as a selectable list item with name, task, and status. When selected, show a read-only Markdown transcript and show `Stop` only while its status is `pending` or `running`. Do not render an input field in the inspection area.

- [ ] **Step 5: Run native checks**

Run: `bun run gui:check && bun run gui:test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add gui/src/main.zig gui/src/app.native gui/src/tests.zig
git commit -m "feat: inspect subagents in native GUI"
```

### Task 7: Documentation and full verification

**Files:**
- Modify: `README.md`
- Modify: `.agents/AGENTS.md`
- Test: all relevant suites

**Interfaces:**
- Consumes: completed feature from Tasks 1–6.
- Produces: accurate user and architecture documentation.

- [ ] **Step 1: Update documentation**

Document that Codex uses native app-server subagents, Flue retains parallel research agents, `/subagents <id>` opens read-only inspection, `q` stops a running child in the TUI, and the GUI activity rail supports selection and stop.

- [ ] **Step 2: Run formatting and static checks**

Run: `git diff --check && bun run typecheck`

Expected: no whitespace errors and successful typecheck.

- [ ] **Step 3: Run the complete TypeScript suite**

Run: `bun test`

Expected: all tests pass.

- [ ] **Step 4: Build the harness**

Run: `bun run build`

Expected: Flue build and server patch complete successfully.

- [ ] **Step 5: Verify the native GUI**

Run: `bun run gui:check && bun run gui:test && bun run gui:build`

Expected: strict check, native tests, and native build pass.

- [ ] **Step 6: Review the final diff**

Run: `git diff origin/main... --stat && git diff origin/main... --check`

Expected: only native subagent implementation, tests, and documentation are present.

- [ ] **Step 7: Commit documentation**

```bash
git add README.md .agents/AGENTS.md
git commit -m "docs: document native subagents"
```
