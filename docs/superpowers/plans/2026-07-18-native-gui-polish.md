# Lavalamp Native GUI Polish and Feature-Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a polished premium-lava native desktop workspace in which every visible control works and every current Lavalamp user workflow has a native GUI path.

**Architecture:** Extend the authenticated loopback GUI host with typed runtime actions and structured feature-panel data, then consume those contracts in a deterministic Zig state model and declarative Native SDK view. Keep the TUI unchanged, reuse shared stores/readers below the rendering layer, and drive the finished app against a deterministic fixture host through Native SDK automation.

**Tech Stack:** Bun 1.3+, TypeScript, Zig 0.16 through Native SDK, Native markup, Bun test, Native SDK check/test/automation.

## Global Constraints

- Existing `lavalamp` TUI behavior and default command stay unchanged.
- GUI uses native-rendered `.native` markup, no WebView.
- Host binds only `127.0.0.1` and authenticates every non-health request.
- Permission requests default to pending or denied, never automatic allow.
- The canonical polished appearance is deep charcoal with warm lava-orange emphasis, crisp neutral typography, subtle depth, and restrained motion.
- Every visible control must have tested behavior; no GUI surface may return a `TUI-only` placeholder.
- The app must remain usable at the manifest minimum width of 920 px.
- Use Bun rather than npm for dependency, script, test, and CLI execution.
- Do not add agent attribution or co-author metadata to commits.

## File map

- `src/gui-host/contracts.ts`: serialized snapshot, question, prompt, panel, inspector, and action contracts.
- `src/gui-host/event-store.ts`: deterministic current snapshot, queued prompts, tasks, file changes, subagents, notices, and sudo state.
- `src/gui-host/runtime.ts`: runtime lifecycle, prompt queue, controls, permissions, questions, auth, and sudo recreation.
- `src/gui-host/feature-data.ts`: structured readers for sessions, models, analytics, benchmarks, memory, workspace, skills, MCP, tools, gateway, permissions, usage, and help.
- `src/gui-host/server.ts`: validated authenticated HTTP routes over the runtime and feature reader.
- `src/gui-host/main.ts`: production dependency wiring and text-command compatibility adapter.
- `src/gui-host/fixture.ts`: deterministic host state used only when `LAVALAMP_GUI_FIXTURE=1`.
- `gui/src/protocol.zig`: bounded JSON payload declarations and decoder helpers.
- `gui/src/ui_state.zig`: panel, question, attachment, notice, and responsive state types.
- `gui/src/main.zig`: app model/update/effects orchestration and view bindings.
- `gui/src/app.native`: premium-lava workspace layout and all conditional states.
- `gui/src/tests.zig`: state, typed-markup, and interaction contract tests.
- `tests/gui-host-feature-data.test.ts`: feature reader unit tests.
- `tests/gui-host-runtime.test.ts`: runtime queue/control/lifecycle tests.
- `tests/gui-host-server.test.ts`: HTTP contract tests.
- `tests/gui-host-event-store.test.ts`: inspector and queue reduction tests.
- `tests/gui-automation.sh`: launch, interaction, resize, screenshot, and dispatch-error assertions.
- `README.md` and `gui/README.md`: complete GUI usage and verification documentation.

---

### Task 1: Make Every Existing Markup Branch Runtime-Safe

**Files:**
- Modify: `gui/src/app.native:67-71`
- Modify: `gui/src/tests.zig`

**Interfaces:**
- Consumes: `main.AppMarkup`, `main.applySnapshotJson(Model*, []const u8)`.
- Produces: a typed-markup test that builds the error, empty, populated, processing, terminal, permission, and command-result branches without `MarkupBuild` diagnostics.

- [ ] **Step 1: Add a failing all-branches markup test**

Add a `buildMarkup` helper and a test that injects all currently supported conditional data:

```zig
fn buildMarkup(arena: std.mem.Allocator, model: *main.Model) !native_sdk.canvas.WidgetTree {
    var view = try main.AppMarkup.init(arena, main.app_markup);
    var ui = main.AppUi.init(arena);
    const root = view.build(&ui, model) catch |err| {
        std.debug.print("app.native:{d}:{d}: {s}\n", .{
            view.diagnostic.line,
            view.diagnostic.column,
            view.diagnostic.message,
        });
        return err;
    };
    return ui.finalize(root);
}

test "every current conditional markup branch builds" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    var model = main.initialModel();
    model.connected = true;
    try testing.expect(main.applySnapshotJson(&model,
        \\{"ok":true,"data":{"snapshot":{"processing":true,"assistantText":"Streaming","thinkingText":"Reasoning","terminalOutput":"bun test","error":"Network unavailable","messages":[{"role":"user","content":"Fix UI"}],"tools":[{"id":"t1","name":"bash","summary":"bun test","status":"running"}],"pendingPermission":{"requestId":"p1","toolName":"edit"}},"sessions":[{"sessionId":"s1","prompt":"Fix UI"}]}}
    ));
    try testing.expect(main.applyCommandJson(&model,
        \\{"ok":true,"data":{"title":"/usage","rows":["12 tokens"]}}
    ));
    const tree = try buildMarkup(arena_state.allocator(), &model);
    try testing.expect(findByKind(tree.root, .alert) != null);
    try testing.expect(findByKind(tree.root, .timeline) != null);
}
```

- [ ] **Step 2: Run the native test and verify the runtime markup failure**

Run: `bunx --bun @native-sdk/cli test gui --yes`

Expected: FAIL with `text content is only allowed inside text-bearing elements` at the destructive alert.

- [ ] **Step 3: Make the alert content explicitly text-bearing**

Replace the invalid alert body with:

```xml
<alert variant="destructive">
  <text wrap="true">{errorText}</text>
</alert>
```

- [ ] **Step 4: Run typed markup and live-render checks**

Run:

```bash
bunx --bun @native-sdk/cli check gui --strict
bunx --bun @native-sdk/cli test gui --yes
```

Expected: zero diagnostics and all native tests pass.

- [ ] **Step 5: Commit the runtime-safe baseline**

```bash
git add gui/src/app.native gui/src/tests.zig
git commit -m "fix: make native gui states render safely"
```

---

### Task 2: Define Structured GUI Feature and Inspector Contracts

**Files:**
- Modify: `src/gui-host/contracts.ts`
- Modify: `src/gui-host/event-store.ts`
- Modify: `tests/gui-host-event-store.test.ts`

**Interfaces:**
- Produces: `GuiPanelId`, `GuiPanelData`, `GuiQuestion`, `GuiPromptRequest`, `GuiAttachment`, `GuiTaskSnapshot`, `GuiFileChange`, `GuiSubagentSnapshot`, `GuiNotice`, and snapshot queue/inspector fields.
- Consumes: `RuntimeEvent` values already emitted through `GuiEventInput.runtime.event`.

- [ ] **Step 1: Write failing event-store tests for queue and inspector state**

Add focused tests using real store events:

```ts
test('reduces queued prompts and inspector events into the snapshot', () => {
  const store = new GuiEventStore();
  store.append({ id: 'q1', prompt: 'Run tests', type: 'prompt.queued' });
  store.append({ id: 'task-1', status: 'running', title: 'Fix UI', type: 'task.changed' });
  store.append({ changeType: 'modified', path: 'gui/src/app.native', type: 'file.changed' });
  store.append({ id: 'agent-1', name: 'review', status: 'running', summary: 'Review UI', type: 'subagent.changed' });

  expect(store.snapshot()).toMatchObject({
    fileChanges: [{ changeType: 'modified', path: 'gui/src/app.native' }],
    queuedPrompts: [{ id: 'q1', prompt: 'Run tests' }],
    subagents: [{ id: 'agent-1', status: 'running' }],
    tasks: [{ id: 'task-1', status: 'running' }],
  });
});

test('normalizes a structured question request', () => {
  const store = new GuiEventStore();
  store.append({
    questions: [{ id: 'choice', label: 'Choose mode', options: ['Build', 'Ask'], required: true, type: 'single_choice' }],
    requestId: 'question-1',
    type: 'question.requested',
  });
  expect(store.snapshot().pendingQuestion?.questions[0]).toEqual({
    id: 'choice', label: 'Choose mode', options: ['Build', 'Ask'], required: true, type: 'single_choice',
  });
});
```

- [ ] **Step 2: Verify the new event types fail to compile**

Run: `bun test tests/gui-host-event-store.test.ts`

Expected: FAIL with TypeScript errors for `prompt.queued`, `task.changed`, `file.changed`, and `subagent.changed`.

- [ ] **Step 3: Add exact serialized contracts**

Add these public types and snapshot fields:

```ts
export type GuiPanelId =
  | 'help' | 'sessions' | 'models' | 'backend' | 'login' | 'memory'
  | 'benchmarks' | 'gateway' | 'usage' | 'analytics' | 'rate'
  | 'workspace' | 'skills' | 'mcp' | 'tools' | 'subagents'
  | 'sudo' | 'permissions';

export type GuiQuestion =
  | { id: string; label: string; required: boolean; type: 'text'; placeholder?: string }
  | { id: string; label: string; required: boolean; type: 'confirm' }
  | { id: string; label: string; required: boolean; type: 'single_choice'; options: string[] }
  | { id: string; label: string; required: boolean; type: 'multi_choice'; options: string[] };

export interface GuiAttachment { id: string; name: string; path: string; mimeType: 'image/png' }
export interface GuiQueuedPrompt { id: string; prompt: string }
export interface GuiTaskSnapshot { id: string; title: string; status: 'pending' | 'running' | 'completed' | 'failed' }
export interface GuiFileChange { path: string; changeType: 'added' | 'modified' | 'deleted' }
export interface GuiSubagentSnapshot { id: string; name: string; summary: string; status: 'queued' | 'running' | 'completed' | 'failed' }
export interface GuiNotice { id: number; message: string; tone: 'info' | 'success' | 'warning' | 'error' }
export interface GuiPromptRequest {
  prompt: string;
  sessionId?: string;
  delivery: 'send' | 'steer' | 'queue';
  attachments: GuiAttachment[];
}

export type GuiPanelData =
  | { id: 'help'; commands: Array<{ name: string; description: string }>; keys: Array<{ keys: string; description: string }> }
  | { id: 'sessions'; sessions: Array<{ sessionId: string; title: string; savedAt: number; messageCount: number; backend: AgentBackend }> }
  | { id: 'models'; models: RuntimeModel[]; selected?: string }
  | { id: 'usage'; usage: GuiUsage }
  | { id: 'analytics'; rows: string[] }
  | { id: 'benchmarks'; catalog: unknown[]; runs: unknown[] }
  | { id: Exclude<GuiPanelId, 'help' | 'sessions' | 'models' | 'usage' | 'analytics' | 'benchmarks'>; rows: Array<{ label: string; value?: string; status?: string }> };
```

Add `queuedPrompts`, `tasks`, `fileChanges`, `subagents`, `notices`, `sudoEnabled`, and normalized `pendingQuestion` to `GuiSnapshot`.

- [ ] **Step 4: Reduce the new events deterministically**

Add `GuiEventInput` variants and reducers that upsert by stable ID/path, cap each inspector list at 40 entries, remove a prompt on `prompt.dequeued`, clear queue/inspector transient data on `resetConversation`, and preserve tasks/file changes across individual tool deltas.

```ts
case 'prompt.queued':
  this.current = {
    ...this.current,
    queuedPrompts: [...this.current.queuedPrompts, { id: event.id, prompt: event.prompt }].slice(-20),
  };
  break;
case 'file.changed':
  this.current = {
    ...this.current,
    fileChanges: upsertBy(this.current.fileChanges, event, (item) => item.path).slice(-40),
  };
  break;
```

- [ ] **Step 5: Run store tests and typecheck**

Run:

```bash
bun test tests/gui-host-event-store.test.ts
bun run typecheck
```

Expected: focused tests pass and TypeScript exits 0.

- [ ] **Step 6: Commit structured state contracts**

```bash
git add src/gui-host/contracts.ts src/gui-host/event-store.ts tests/gui-host-event-store.test.ts
git commit -m "feat: add structured gui workspace state"
```

---

### Task 3: Add a Structured Feature Reader for Every Lavalamp Panel

**Files:**
- Create: `src/gui-host/feature-data.ts`
- Create: `tests/gui-host-feature-data.test.ts`
- Modify: `src/gui-host/main.ts`

**Interfaces:**
- Consumes: `GuiPanelId`, `GuiPanelData`, `HELP_COMMANDS`, `HELP_KEYS`, session/model/analytics/benchmark/permission/clipboard helpers.
- Produces: `GuiFeatureReader.read(id: GuiPanelId): Promise<GuiPanelData>` and production `createGuiFeatureReader(options)` wiring.

- [ ] **Step 1: Write failing dependency-injected reader tests**

```ts
import { createGuiFeatureReader } from '../src/gui-host/feature-data';

test('returns structured data for every panel id', async () => {
  const reader = createGuiFeatureReader({
    analyticsRows: () => ['2 completed', '120 tokens'],
    benchmarkCatalog: async () => [{ id: 'terminal-bench-2', name: 'Terminal-Bench' }],
    benchmarkRuns: () => [{ id: 'run-1', status: 'completed' }],
    helpCommands: [['/help', 'Show help']],
    helpKeys: [['Command-K', 'Open command palette']],
    listModels: () => [{ description: '', displayName: 'Model A', id: 'model-a', inputModalities: ['text'], isDefault: true, supportedReasoningEfforts: [] }],
    listSessions: () => [{ backend: 'flue', id: 's1', messageCount: 2, name: 'Fix UI', savedAt: 10 }],
    permissionRules: () => [{ action: 'ask', tool: 'edit' }],
    readMemory: () => 'Use bun.',
    rows: (id) => [{ label: id, value: 'available' }],
    workspace: '/repo',
  });

  const ids = ['help', 'sessions', 'models', 'backend', 'login', 'memory', 'benchmarks', 'gateway', 'usage', 'analytics', 'rate', 'workspace', 'skills', 'mcp', 'tools', 'subagents', 'sudo', 'permissions'] as const;
  const panels = await Promise.all(ids.map((id) => reader.read(id)));
  expect(panels.map((panel) => panel.id)).toEqual(ids);
  expect(panels.find((panel) => panel.id === 'analytics')).toEqual({ id: 'analytics', rows: ['2 completed', '120 tokens'] });
});
```

- [ ] **Step 2: Verify the missing reader fails**

Run: `bun test tests/gui-host-feature-data.test.ts`

Expected: FAIL because `src/gui-host/feature-data.ts` does not exist.

- [ ] **Step 3: Implement the reader with explicit dependencies**

Create:

```ts
export interface GuiFeatureReader { read(id: GuiPanelId): Promise<GuiPanelData> }

export function createGuiFeatureReader(deps: GuiFeatureDependencies): GuiFeatureReader {
  return {
    async read(id) {
      switch (id) {
        case 'help':
          return {
            id,
            commands: deps.helpCommands.map(([name, description]) => ({ name, description })),
            keys: deps.helpKeys.map(([keys, description]) => ({ keys, description })),
          };
        case 'sessions':
          return { id, sessions: deps.listSessions().map((session) => ({
            backend: session.backend, messageCount: session.messageCount,
            savedAt: session.savedAt, sessionId: session.id, title: session.name,
          })) };
        case 'models':
          return { id, models: await deps.listModels() };
        case 'analytics':
          return { id, rows: deps.analyticsRows() };
        case 'benchmarks':
          return { id, catalog: await deps.benchmarkCatalog(), runs: deps.benchmarkRuns() };
        default:
          return { id, rows: deps.rows(id) };
      }
    },
  };
}
```

Define `GuiFeatureDependencies` with the exact functions exercised by the test. Production wiring in `main.ts` must use `AnalyticsStore`, `formatAnalyticsRows`, `BenchmarkCatalog`, `BenchmarkRunStore`, `discoverSkills`, `loadRules`, `listSessions`, `listModels`, and the existing memory/MCP/tool readers. Close `AnalyticsStore` after each report read.

- [ ] **Step 4: Replace TUI-only command placeholders with structured summaries**

Keep `runGuiCommand` for slash-command compatibility, but have `/analytics`, `/benchmarks`, `/gateway`, `/subagents`, and `/rate` call `featureReader.read(...)` and format the returned data. No result row may contain `TUI-only`.

- [ ] **Step 5: Run reader, command, and type tests**

Run:

```bash
bun test tests/gui-host-feature-data.test.ts tests/gui-host-server.test.ts
bun run typecheck
rg -n "TUI-only" src/gui-host
```

Expected: tests pass, typecheck exits 0, and `rg` prints no matches.

- [ ] **Step 6: Commit structured feature data**

```bash
git add src/gui-host/feature-data.ts src/gui-host/main.ts tests/gui-host-feature-data.test.ts
git commit -m "feat: expose gui feature panels"
```

---

### Task 4: Implement Host-Backed Sessions, Queueing, Attachments, Auth, and Sudo

**Files:**
- Modify: `src/gui-host/runtime.ts`
- Modify: `src/gui-host/event-store.ts`
- Modify: `tests/gui-host-runtime.test.ts`

**Interfaces:**
- Consumes: `GuiPromptRequest`, `GuiAttachment`, `GuiProcess.prompt(..., images)` and optional process auth/control methods.
- Produces: `GuiRuntime.newSession()`, `submitPrompt(request)`, `setSudo(enabled)`, `login()`, `rate(rating)`, and automatic queue draining.

- [ ] **Step 1: Write failing runtime lifecycle tests**

Extend the existing fake process with captured prompt calls, `clearThread`, `login`, and callback completion. Add:

```ts
test('queues a prompt while busy and drains it after completion', async () => {
  const { process, runtime, store } = fixture();
  runtime.submitPrompt({ attachments: [], delivery: 'send', prompt: 'First' });
  process.callbacks.onStarted?.();
  runtime.submitPrompt({ attachments: [], delivery: 'queue', prompt: 'Second' });
  expect(store.snapshot().queuedPrompts.map((item) => item.prompt)).toEqual(['Second']);
  process.callbacks.onResult?.(fakeResult('First answer'));
  await Promise.resolve();
  expect(process.prompts.map((item) => item.message)).toEqual(['First', 'Second']);
});

test('new session cancels work, clears runtime thread, queue, and transcript', async () => {
  const { process, runtime, store } = fixture();
  runtime.submitPrompt({ attachments: [], delivery: 'send', prompt: 'First' });
  process.callbacks.onStarted?.();
  await runtime.newSession();
  expect(process.cancelled).toBe(1);
  expect(process.cleared).toBe(1);
  expect(store.snapshot()).toMatchObject({ messages: [], processing: false, queuedPrompts: [] });
});

test('passes pasted image paths to the active backend', () => {
  const { process, runtime } = fixture();
  runtime.submitPrompt({
    attachments: [{ id: 'a1', mimeType: 'image/png', name: 'shot.png', path: '/repo/shot.png' }],
    delivery: 'send', prompt: 'Inspect image',
  });
  expect(process.prompts[0]?.images).toEqual([{ data: '/repo/shot.png', mimeType: 'image/png' }]);
});
```

- [ ] **Step 2: Run focused tests and verify missing APIs**

Run: `bun test tests/gui-host-runtime.test.ts`

Expected: FAIL for the object prompt signature and missing `newSession`.

- [ ] **Step 3: Implement queue and session lifecycle**

Use this public surface:

```ts
submitPrompt(request: GuiPromptRequest): string {
  const prompt = request.prompt.trim();
  if (prompt.length === 0) throw new Error('Prompt is required');
  if (this.store.snapshot().processing) {
    if (request.delivery === 'send') throw new Error('Choose steer or queue while a turn is running');
    const id = randomUUID();
    this.pendingPrompts.push({ ...request, id });
    this.store.append({ id, prompt, type: 'prompt.queued' });
    return id;
  }
  return this.startPrompt({ ...request, prompt });
}

async newSession(): Promise<void> {
  if (this.store.snapshot().processing) this.process.cancel();
  this.pendingPrompts = [];
  this.process.clearThread?.();
  await this.process.restart?.();
  this.sessionId = undefined;
  this.store.resetConversation();
}
```

`startPrompt` converts each `GuiAttachment` to the existing `PromptImage` shape, appends the user message, and drains one queued prompt after `onResult` or `onError`. Treat `steer` as the front of the local queue and `queue` as the back because the shared runtime has no mid-turn steering API.

- [ ] **Step 4: Add auth, rating, and sudo runtime methods**

Add optional `login`, `readAccount`, and `clearThread` to `GuiProcess`. Implement `login()` by returning the process auth URL/login ID when supported, `rate()` through an injected rating callback, and `setSudo(enabled)` by safely recreating the process with the same backend/model/mode/workspace and `sudo: enabled`. Reject sudo changes during a running turn and append a persistent `sudo.changed` event.

- [ ] **Step 5: Run runtime/store tests and typecheck**

Run:

```bash
bun test tests/gui-host-runtime.test.ts tests/gui-host-event-store.test.ts
bun run typecheck
```

Expected: all focused tests pass and typecheck exits 0.

- [ ] **Step 6: Commit complete runtime actions**

```bash
git add src/gui-host/runtime.ts src/gui-host/event-store.ts tests/gui-host-runtime.test.ts
git commit -m "feat: complete gui runtime lifecycle"
```

---

### Task 5: Expose Validated Structured HTTP Endpoints

**Files:**
- Modify: `src/gui-host/server.ts`
- Modify: `src/gui-host/main.ts`
- Modify: `tests/gui-host-server.test.ts`

**Interfaces:**
- Consumes: `GuiFeatureReader`, complete `GuiHostRuntime`, `pasteImageFromClipboard`, existing auth/body-limit envelope helpers.
- Produces: typed routes for session reset, prompt delivery, panels, controls, clipboard image, rating, auth, permissions, and questions.

- [ ] **Step 1: Add failing endpoint tests**

Add requests covering all new routes:

```ts
test('serves native panels and actions without text-command placeholders', async () => {
  const models = await request('/v1/native/panels/models');
  expect(await models.json()).toMatchObject({ ok: true, data: { id: 'models' } });

  const fresh = await request('/v1/native/session', { method: 'POST' });
  expect(fresh.status).toBe(200);
  expect(runtime.newSessions).toBe(1);

  const queued = await request('/v1/native/prompts', {
    body: JSON.stringify({ attachments: [], delivery: 'queue', prompt: 'Next' }),
    headers: { 'content-type': 'application/json' }, method: 'POST',
  });
  expect(queued.status).toBe(202);
  expect(runtime.prompts.at(-1)).toMatchObject({ delivery: 'queue', prompt: 'Next' });

  const pasted = await request('/v1/native/clipboard-image', { method: 'POST' });
  expect(await pasted.json()).toMatchObject({ ok: true, data: { mimeType: 'image/png' } });
});
```

Also assert 400 for unknown panels, invalid delivery, missing prompt, invalid question answers, invalid rating, and enabling sudo without `{ confirmed: true }`.

- [ ] **Step 2: Verify server tests fail on missing routes**

Run: `bun test tests/gui-host-server.test.ts`

Expected: FAIL with 404 responses for the new routes.

- [ ] **Step 3: Extend server dependencies and runtime interface**

Add:

```ts
export interface GuiHostServerOptions {
  featureReader: GuiFeatureReader;
  pasteClipboardImage: () => Promise<GuiAttachment | null>;
}

export interface GuiHostRuntime {
  newSession(): Promise<void>;
  submitPrompt(request: GuiPromptRequest): string;
  setSudo(enabled: boolean): Promise<void>;
  login(): Promise<{ authUrl: string; loginId: string } | null>;
  rate(rating: 'helpful' | 'unhelpful'): void;
}
```

- [ ] **Step 4: Implement exact structured routes**

Add authenticated routes:

```ts
GET  /v1/native/panels/:id
POST /v1/native/session
POST /v1/native/prompts
POST /v1/native/clipboard-image
POST /v1/native/rating
POST /v1/native/login
POST /v1/native/control
POST /v1/questions/:requestId
POST /v1/permissions/:requestId
```

Parse `/v1/native/prompts` as JSON `{ prompt, delivery, attachments }`; keep legacy `text/plain` support for one release. For sudo control, require `action === 'sudo'`, boolean `enabled`, and `confirmed === true` when enabling. Use `GuiPanelId` validation rather than casting arbitrary paths.

- [ ] **Step 5: Wire production readers and clipboard image extraction**

In `runGuiHost`, construct the feature reader once, pass `pasteClipboardImage: async () =>` wrap `pasteImageFromClipboard(workspace)` into a `GuiAttachment`, and pass runtime rating/auth/sudo actions. Do not expose filesystem paths outside the active workspace data directory.

- [ ] **Step 6: Run server/runtime/security tests**

Run:

```bash
bun test tests/gui-host-server.test.ts tests/gui-host-runtime.test.ts tests/paths-and-backups.test.ts
bun run typecheck
```

Expected: all tests pass; unauthenticated and non-loopback protections remain covered.

- [ ] **Step 7: Commit the complete host API**

```bash
git add src/gui-host/server.ts src/gui-host/main.ts tests/gui-host-server.test.ts
git commit -m "feat: expose complete native gui api"
```

---

### Task 6: Split Native Protocol and UI State from the App Orchestrator

**Files:**
- Create: `gui/src/protocol.zig`
- Create: `gui/src/ui_state.zig`
- Modify: `gui/src/main.zig`
- Modify: `gui/src/tests.zig`

**Interfaces:**
- Produces: `protocol.NativeEnvelope`, `protocol.PanelEnvelope`, `protocol.SessionEnvelope`, `protocol.ActionEnvelope`, `ui_state.PanelId`, `PanelState`, `QuestionField`, `Attachment`, `Notice`, and responsive flags.
- Consumes: JSON contracts created in Tasks 2–5.

- [ ] **Step 1: Add failing protocol and state tests**

```zig
test "protocol decodes question queue inspector and panel payloads" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const payload = try protocol.parseNativeEnvelope(arena_state.allocator(),
        \\{"ok":true,"data":{"snapshot":{"queuedPrompts":[{"id":"q1","prompt":"Next"}],"tasks":[{"id":"t1","title":"Fix UI","status":"running"}],"fileChanges":[{"path":"gui/src/app.native","changeType":"modified"}],"subagents":[],"pendingQuestion":{"requestId":"r1","questions":[{"id":"choice","label":"Mode","required":true,"type":"single_choice","options":["Build","Ask"]}]}}}}
    );
    try testing.expectEqual(@as(usize, 1), payload.data.?.snapshot.queuedPrompts.len);
    try testing.expectEqualStrings("choice", payload.data.?.snapshot.pendingQuestion.?.questions[0].id);
}

test "panel state opens loads succeeds and closes" {
    var state = ui_state.PanelState{};
    state.open(.models);
    try testing.expect(state.loading);
    state.succeed("Models");
    try testing.expectEqualStrings("Models", state.title());
    state.close();
    try testing.expect(state.active == null);
}
```

- [ ] **Step 2: Verify missing modules fail**

Run: `bunx --bun @native-sdk/cli test gui --yes`

Expected: compile failure for missing `protocol.zig` and `ui_state.zig`.

- [ ] **Step 3: Move JSON declarations into `protocol.zig`**

Define JSON payload types matching TypeScript field names exactly and expose:

```zig
pub fn parseNativeEnvelope(allocator: std.mem.Allocator, body: []const u8) !std.json.Parsed(NativeEnvelope) {
    return std.json.parseFromSlice(NativeEnvelope, allocator, body, .{ .ignore_unknown_fields = true });
}

pub fn parsePanelEnvelope(allocator: std.mem.Allocator, body: []const u8) !std.json.Parsed(PanelEnvelope) {
    return std.json.parseFromSlice(PanelEnvelope, allocator, body, .{ .ignore_unknown_fields = true });
}
```

Keep public enum strings aligned with TypeScript by using quoted Zig fields for `error` and string-to-enum conversion functions for panel/question/status values.

- [ ] **Step 4: Implement bounded UI state types**

`ui_state.zig` owns fixed-capacity buffers and methods:

```zig
pub const PanelId = enum { help, sessions, models, backend, login, memory, benchmarks, gateway, usage, analytics, rate, workspace, skills, mcp, tools, subagents, sudo, permissions };

pub const PanelState = struct {
    active: ?PanelId = null,
    loading: bool = false,
    error_storage: [512]u8 = undefined,
    error_len: usize = 0,
    title_storage: [96]u8 = undefined,
    title_len: usize = 0,
    pub fn open(self: *PanelState, id: PanelId) void { self.active = id; self.loading = true; self.error_len = 0; }
    pub fn close(self: *PanelState) void { self.* = .{}; }
};
```

Add bounded `QuestionField`, `Attachment`, and `Notice` structs with explicit `truncated` flags when source content exceeds storage.

- [ ] **Step 5: Refactor `main.zig` to consume modules without behavior changes**

Replace inline payload declarations with `const protocol = @import("protocol.zig");` and add `panel`, attachment, question, queue, task, file-change, subagent, notice, and viewport fields to `Model`. Keep existing public bindings stable until Task 7.

- [ ] **Step 6: Run native tests and strict checks**

Run:

```bash
bunx --bun @native-sdk/cli test gui --yes
bunx --bun @native-sdk/cli check gui --strict
```

Expected: all native tests pass and strict check reports zero diagnostics.

- [ ] **Step 7: Commit focused native state modules**

```bash
git add gui/src/protocol.zig gui/src/ui_state.zig gui/src/main.zig gui/src/tests.zig
git commit -m "refactor: separate native gui state and protocol"
```

---

### Task 7: Implement Every Native Interaction Test-First

**Files:**
- Modify: `gui/src/main.zig`
- Modify: `gui/src/tests.zig`

**Interfaces:**
- Consumes: structured endpoints from Task 5 and state modules from Task 6.
- Produces: exhaustive `Msg` variants and effects for sessions, prompt delivery, attachments, questions, panels, controls, retry, rating, login, sudo, and responsive layout.

- [ ] **Step 1: Add failing state/effect tests for every interaction family**

Add independent tests asserting exact method, URL, headers, and body. Use the following test bodies as the interaction contract:

```zig
test "new task calls host before clearing local state" {
    var model = connectedModel();
    model.messages[0].set(1, .user, "keep until acknowledged");
    model.message_count = 1;
    var fx = fakeEffects();
    defer fx.deinit();
    main.update(&model, .new_chat_confirmed, &fx);
    const request = fx.pendingFetchAt(0).?;
    try testing.expectEqual(std.http.Method.POST, request.method);
    try testing.expect(std.mem.endsWith(u8, request.url, "/v1/native/session"));
    try testing.expectEqual(@as(usize, 1), model.message_count);
}

test "running composer queues rather than discarding draft" {
    var model = connectedModel();
    model.processing = true;
    model.draft.set("Run focused tests");
    model.delivery = .queue;
    var fx = fakeEffects();
    defer fx.deinit();
    main.update(&model, .send, &fx);
    const request = fx.pendingFetchAt(0).?;
    try testing.expect(std.mem.endsWith(u8, request.url, "/v1/native/prompts"));
    try testing.expect(std.mem.indexOf(u8, request.body, "\"delivery\":\"queue\"") != null);
    try testing.expect(std.mem.indexOf(u8, request.body, "Run focused tests") != null);
}

test "paste image and panel open use structured endpoints" {
    var model = connectedModel();
    var fx = fakeEffects();
    defer fx.deinit();
    main.update(&model, .paste_image, &fx);
    try testing.expect(std.mem.endsWith(u8, fx.pendingFetchAt(0).?.url, "/v1/native/clipboard-image"));
    fx.clearPending();
    main.update(&model, .{ .open_panel = .models }, &fx);
    try testing.expectEqual(std.http.Method.GET, fx.pendingFetchAt(0).?.method);
    try testing.expect(std.mem.endsWith(u8, fx.pendingFetchAt(0).?.url, "/v1/native/panels/models"));
}

test "required question blocks empty answer and posts a completed answer" {
    var model = connectedModel();
    model.setQuestionFixture("r1", "choice", "Choose mode", true);
    var fx = fakeEffects();
    defer fx.deinit();
    main.update(&model, .submit_question, &fx);
    try testing.expectEqual(@as(usize, 0), fx.pendingFetchCount());
    try testing.expect(model.hasQuestionError());
    model.setQuestionAnswer("choice", "Build");
    main.update(&model, .submit_question, &fx);
    try testing.expect(std.mem.endsWith(u8, fx.pendingFetchAt(0).?.url, "/v1/questions/r1"));
    try testing.expect(std.mem.indexOf(u8, fx.pendingFetchAt(0).?.body, "\"choice\":\"Build\"") != null);
}

test "sudo opens confirmation before sending a control request" {
    var model = connectedModel();
    var fx = fakeEffects();
    defer fx.deinit();
    main.update(&model, .open_sudo_confirm, &fx);
    try testing.expect(model.sudo_confirm_open);
    try testing.expectEqual(@as(usize, 0), fx.pendingFetchCount());
    main.update(&model, .confirm_sudo, &fx);
    try testing.expect(std.mem.indexOf(u8, fx.pendingFetchAt(0).?.body, "\"confirmed\":true") != null);
}
```

Define `connectedModel()` and `fakeEffects()` in `gui/src/tests.zig`. Add matching focused tests for model/backend/mode action bodies, retry preserving the draft while spawning a fresh host, rating values, attachment removal, and panel failure clearing its loading flag. Use real `Effects` with `.fake` executor as in the existing prompt test. Decode each JSON body with `std.json.parseFromSlice` in the final tests so field names and value types are verified.

- [ ] **Step 2: Run native tests and confirm the new message variants are absent**

Run: `bunx --bun @native-sdk/cli test gui --yes`

Expected: compile/test failures for the newly referenced messages and bindings.

- [ ] **Step 3: Add exhaustive message variants**

Add:

```zig
new_chat_confirmed,
session_search_edit: canvas.TextInputEvent,
open_command_palette,
delivery_steer,
delivery_queue,
paste_image,
remove_attachment,
submit_question,
question_edit: canvas.TextInputEvent,
select_question_option: u64,
open_panel: ui_state.PanelId,
close_panel,
select_panel_row: u64,
select_model: u64,
retry_connection,
rate_helpful,
rate_unhelpful,
toggle_inspector,
toggle_sidebar,
open_sudo_confirm,
confirm_sudo,
cancel_sudo,
panel_response: native_sdk.EffectResponse,
attachment_response: native_sdk.EffectResponse,
```

Mark only effect-only variants as `view_unbound`. Every `on-press` name in markup must map to a bindable variant.

- [ ] **Step 4: Implement shared authenticated request builders**

Replace duplicated buffers with focused helpers that still copy URLs/headers into effect-owned storage:

```zig
fn postJson(model: *const Model, fx: *Effects, key: u64, path: []const u8, body: []const u8, on_response: fn (native_sdk.EffectResponse) Msg) void;
fn getJson(model: *const Model, fx: *Effects, key: u64, path: []const u8, on_response: fn (native_sdk.EffectResponse) Msg) void;
```

Keep the bearer token out of view bindings and error strings.

- [ ] **Step 5: Fold complete snapshot and panel data into bounded model state**

Populate questions, queue, tasks, file changes, subagents, notices, sudo, model list, and panel rows. Clear loading flags on both success and failure. Validate required question fields before posting; show a local error without clearing answers when invalid.

- [ ] **Step 6: Implement responsive state**

Handle the Native SDK viewport/window-size message available in the current runtime. Derive:

```zig
pub fn showInspector(self: *const Model) bool { return self.viewport_width >= 1180 and !self.inspector_hidden; }
pub fn compactSidebar(self: *const Model) bool { return self.viewport_width < 1040 or self.sidebar_compact; }
```

If window-size messages are not exposed to markup state, bind the same thresholds through Native SDK responsive layout attributes and test the built widget bounds at 1280 and 920 widths.

- [ ] **Step 7: Run all native state tests**

Run: `bunx --bun @native-sdk/cli test gui --yes`

Expected: all interaction tests pass with no leaked allocator state.

- [ ] **Step 8: Commit complete native behavior**

```bash
git add gui/src/main.zig gui/src/tests.zig
git commit -m "feat: implement native gui interactions"
```

---

### Task 8: Build the Premium-Lava Workspace UI

**Files:**
- Replace: `gui/src/app.native`
- Modify: `gui/src/tests.zig`
- Modify: `gui/app.zon`

**Interfaces:**
- Consumes: all public model bindings and `Msg` variants from Task 7.
- Produces: sidebar, conversation, composer, contextual inspector, permission/question cards, command palette/panels, overlays, and responsive layouts with no inert controls.

- [ ] **Step 1: Add failing semantic-tree assertions for the approved design**

Build populated and empty models and assert accessible roles/names:

```zig
test "premium workspace exposes complete accessible regions" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    var model = populatedModel();
    const tree = try buildMarkup(arena_state.allocator(), &model);
    try testing.expect(findByName(tree.root, "New task") != null);
    try testing.expect(findByName(tree.root, "Search sessions") != null);
    try testing.expect(findByName(tree.root, "Conversation") != null);
    try testing.expect(findByName(tree.root, "Run inspector") != null);
    try testing.expect(findByName(tree.root, "Send message") != null);
    try testing.expect(findByName(tree.root, "Answer required question") != null);
}
```

Add a binding audit that walks pressable widgets and asserts `tree.msgForPress(widget.id) != null` for every enabled button/list item.

- [ ] **Step 2: Verify semantic tests fail against the old shell**

Run: `bunx --bun @native-sdk/cli test gui --yes`

Expected: FAIL for missing search, question, inspector, and panel semantics.

- [ ] **Step 3: Replace the top-level shell**

Use this region hierarchy and Native SDK-supported `stack`, `panel`, `scroll`, `input`, `textarea`, `button`, `list-item`, `accordion`, `alert`, and `status-bar` controls:

```xml
<stack>
  <column background="background">
    <row grow="1">
      <if test="{showSidebar}">
        <panel width="272" label="Task sidebar">
          <column grow="1" padding="12" gap="10">
            <text>Lavalamp</text>
            <text foreground="text_muted">{workspaceLabel}</text>
            <button icon="plus" variant="primary" on-press="new_chat" label="New task">New task</button>
            <input text="{sessionSearchText}" on-input="session_search_edit" placeholder="Search sessions" label="Search sessions" />
            <scroll grow="1" label="Recent sessions">
              <column gap="4">
                <for each="filteredSessionItems" key="key" as="session">
                  <list-item selected="{session.selected}" on-press="select_session:{session.key}" label="Open session">
                    <column gap="2"><text>{session.prompt}</text><text foreground="text_muted">{session.meta}</text></column>
                  </list-item>
                </for>
              </column>
            </scroll>
            <button icon="settings" variant="ghost" on-press="open_panel:workspace" label="Workspace settings">Workspace</button>
          </column>
        </panel>
        <separator />
      </if>
      <column grow="1" label="Conversation workspace">
        <row height="56" padding="16" cross="center" gap="8">
          <column grow="1"><text>{sessionTitle}</text><text foreground="text_muted">{modelRouteLabel}</text></column>
          <button icon="search" size="icon" variant="ghost" on-press="open_command_palette" label="Open command palette"></button>
          <button icon="panel-right" size="icon" variant="ghost" on-press="toggle_inspector" label="Toggle run inspector"></button>
        </row>
        <separator />
        <scroll grow="1" label="Conversation">
          <column padding="24" gap="18">
            <if test="{hasError}"><alert variant="destructive"><text wrap="true">{errorText}</text><button on-press="retry_connection">Retry</button></alert></if>
            <if test="{emptyState}"><column grow="1" main="center" cross="center" gap="12"><avatar>LL</avatar><text>What should we build?</text><text foreground="text_muted">{workspaceLabel}</text></column></if>
            <for each="messageItems" key="id" as="message">
              <if test="{message.isUser}"><row main="end"><bubble variant="primary" width="560" padding="12"><text wrap="true">{message.content}</text></bubble></row></if>
              <else><row gap="10" cross="start"><avatar size="sm">LL</avatar><column grow="1" gap="6"><text foreground="text_muted">Lavalamp</text><markdown source="{message.content}" /></column></row></else>
            </for>
            <if test="{permission_pending}"><panel padding="14" label="Permission required"><column gap="10"><text>Permission required</text><text wrap="true" foreground="text_muted">{permissionSummary}</text><button-group><button variant="primary" on-press="allow_permission">Allow once</button><button variant="secondary" on-press="always_allow_permission">Always allow</button><button variant="ghost" on-press="deny_permission">Deny</button></button-group></column></panel></if>
            <if test="{questionPending}"><panel padding="14" label="Answer required question"><column gap="10"><text>Answer required question</text><for each="questionItems" key="key" as="question"><column gap="6"><text>{question.label}</text><if test="{question.isText}"><input text="{question.answer}" on-input="question_edit:{question.key}" label="Question answer" /></if><else><button-group><for each="question.options" key="key" as="option"><button selected="{option.selected}" on-press="select_question_option:{option.key}">{option.label}</button></for></button-group></else></column></for><if test="{hasQuestionError}"><alert variant="destructive"><text>{questionErrorText}</text></alert></if><button variant="primary" on-press="submit_question">Submit answers</button></column></panel></if>
          </column>
        </scroll>
        <column padding="16" gap="8">
          <if test="{hasAttachment}"><row gap="6" cross="center"><icon name="image" size="sm" /><text grow="1">{attachmentName}</text><button icon="x" size="icon" variant="ghost" on-press="remove_attachment" label="Remove attachment"></button></row></if>
          <input-group label="Message composer" height="124">
            <textarea text="{draftText}" placeholder="Describe the task" on-input="draft_edit" on-submit="send" label="Message" />
            <input-group-actions><button icon="paperclip" variant="ghost" on-press="paste_image" label="Paste image"></button><spacer grow="1" /><button icon="send" variant="primary" on-press="send" disabled="{sendDisabled}" label="Send message">{sendActionLabel}</button></input-group-actions>
          </input-group>
        </column>
      </column>
      <if test="{showInspector}">
        <separator />
        <panel width="304" label="Run inspector">
          <scroll grow="1" label="Run activity"><column padding="16" gap="16"><column gap="6"><text foreground="text_muted">Current run</text><text>{modelLabel}</text><text foreground="text_muted">{providerLabel} · {backendLabel} · {modeLabel}</text></column><separator /><column gap="6"><text foreground="text_muted">Tasks</text><for each="taskItems" key="key" as="task"><row gap="6"><icon name="circle-dot" size="sm" /><text grow="1">{task.title}</text><badge>{task.status}</badge></row></for></column><column gap="6"><text foreground="text_muted">Activity</text><timeline><for each="toolItems" key="id" as="tool"><timeline-item title="{tool.name}" description="{tool.summary}" meta="{tool.status}" /></for></timeline></column><column gap="6"><text foreground="text_muted">Changed files</text><for each="fileChangeItems" key="key" as="file"><row><text grow="1">{file.path}</text><badge>{file.changeType}</badge></row></for></column><column gap="6"><text foreground="text_muted">Subagents</text><for each="subagentItems" key="key" as="agent"><row><text grow="1">{agent.name}</text><badge>{agent.status}</badge></row></for></column><column gap="6"><text foreground="text_muted">Queue</text><for each="queuedPromptItems" key="key" as="queued"><text wrap="true">{queued.prompt}</text></for></column></column></scroll>
        </panel>
      </if>
    </row>
    <status-bar>{connectionLabel} · {queueLabel} · {usageLabel}</status-bar>
  </column>
  <if test="{panelOpen}">
    <row grow="1" main="center" cross="center"><panel width="640" padding="20" label="Feature panel"><column gap="12"><row><text grow="1">{panelTitle}</text><button icon="x" on-press="close_panel" label="Close panel"></button></row><separator /><if test="{panelLoading}"><row main="center" gap="8"><spinner size="sm" /><text>Loading…</text></row></if><else><scroll height="520"><column gap="6"><for each="panelRows" key="key" as="row"><list-item selected="{row.selected}" on-press="select_panel_row:{row.key}" label="Panel item"><text grow="1">{row.label}</text><text foreground="text_muted">{row.value}</text></list-item></for></column></scroll></else></column></panel></row>
  </if>
  <if test="{sudoConfirmOpen}">
    <row grow="1" main="center" cross="center"><panel width="480" padding="20" label="Enable sudo mode"><column gap="12"><alert variant="destructive"><text wrap="true">Every tool call will be approved until sudo mode is disabled.</text></alert><button-group><button variant="destructive" on-press="confirm_sudo">Enable sudo</button><button variant="secondary" on-press="cancel_sudo">Cancel</button></button-group></column></panel></row>
  </if>
</stack>
```

Keep these regions inline in `app.native`; this avoids adding a component-registration layer solely for presentation.

- [ ] **Step 4: Implement session sidebar and conversation hierarchy**

The sidebar includes product/workspace identity, `New task`, search input, recency-labeled sessions, and workspace/settings footer. The conversation includes compact header, specific connection/error retry, starter actions, transcript, tool/terminal/reasoning disclosures, questions, permissions, and sticky composer.

Use `variant="primary"` for lava-emphasis actions and active controls, `variant="secondary"` for selected context, and `variant="ghost"` only for low-priority actions. Use icon plus text for destructive/safety actions.

- [ ] **Step 5: Implement contextual inspector and panels**

Render current run, tasks, activity, changed files, subagents, queue, and terminal data. Panels render structured data with loading, empty, failure, and loaded branches. The command palette lists all `HELP_COMMANDS` actions and filters through the native search input state.

- [ ] **Step 6: Implement responsive markup at 920 px**

Collapse inspector at 1,179 px and below, use compact sidebar below 1,040 px, retain a minimum 480 px conversation region, and expose header buttons to reopen hidden regions. Update `app.zon` only if the current min-width contract must be expressed in an additional Native SDK responsive declaration; keep `.min_width = 920`.

- [ ] **Step 7: Run markup checks and semantic tests**

Run:

```bash
bunx --bun @native-sdk/cli markup check gui/src/app.native --strict
bunx --bun @native-sdk/cli test gui --yes
bunx --bun @native-sdk/cli check gui --strict
```

Expected: no markup diagnostics, all enabled pressables dispatch, and all native tests pass.

- [ ] **Step 8: Commit the polished workspace**

```bash
git add gui/src/app.native gui/src/tests.zig gui/app.zon
git commit -m "feat: redesign native gui workspace"
```

---

### Task 9: Add Deterministic Runtime Automation

**Files:**
- Create: `src/gui-host/fixture.ts`
- Create: `tests/gui-automation.sh`
- Modify: `src/gui-host/main.ts`
- Modify: `src/run.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `runGuiFixtureHost()`, `LAVALAMP_GUI_FIXTURE=1` host selection, and `bun run gui:automation`.
- Consumes: production server contracts and Native SDK automation commands.

- [ ] **Step 1: Add a failing fixture-host launcher test**

In `tests/gui-launcher.test.ts`, assert that `gui-host` chooses the fixture only when the explicit environment flag is present and production remains the default:

```ts
test('gui host fixture is opt-in', () => {
  expect(resolveGuiHostMode({})).toBe('production');
  expect(resolveGuiHostMode({ LAVALAMP_GUI_FIXTURE: '1' })).toBe('fixture');
});
```

- [ ] **Step 2: Verify the resolver is missing**

Run: `bun test tests/gui-launcher.test.ts`

Expected: FAIL because `resolveGuiHostMode` is not exported.

- [ ] **Step 3: Implement a deterministic fixture host**

The fixture uses the real `GuiEventStore` and `createGuiHostServer`, emits `host.ready`, exposes two sessions/models, and returns deterministic panel payloads. Prompt `Show all states` emits user message, turn start, thinking, one running/completed tool, terminal output, assistant text, usage, a permission request, and then a question request after permission resolution.

```ts
export async function runGuiFixtureHost(options: { port?: number; token: string; workspace: string }): Promise<void> {
  const store = new GuiEventStore();
  const runtime = new FixtureRuntime(store);
  const server = createGuiHostServer({
    featureReader: createFixtureFeatureReader(),
    pasteClipboardImage: async () => ({ id: 'fixture-image', mimeType: 'image/png', name: 'fixture.png', path: `${options.workspace}/.context/fixture.png` }),
    runtime, token: options.token, workspace: options.workspace, port: options.port,
  });
  process.stdout.write(`LAVALAMP_GUI_READY ${server.port} ${options.token}\n`);
  await waitForTermination(server, runtime);
}
```

- [ ] **Step 4: Add the Bun automation script**

`tests/gui-automation.sh` must:

1. Export repository `bin` on `PATH` and `LAVALAMP_GUI_FIXTURE=1`.
2. Launch `bunx --bun @native-sdk/cli dev gui --yes -Dautomation=true` in the background.
3. Wait for `native automate assert "Ready" "New task" "Run inspector"`.
4. Snapshot and assert `dispatch_errors=0` and no `MarkupBuild` error.
5. Enter `Show all states`, click send, resolve permission, answer the question, and open Models/Analytics/Benchmarks panels.
6. Resize to `920x700`, assert the inspector is absent and its reopen button is present.
7. Capture default and minimum-width screenshots into `.context/gui-automation/`.
8. Terminate the launched process in a shell trap.

Add `"gui:automation": "bash tests/gui-automation.sh"` to root scripts.

- [ ] **Step 5: Run automation and inspect screenshots**

Run: `bun run gui:automation`

Expected: exit 0, no dispatch/markup errors, all interaction assertions pass, and two nonblank PNGs exist under `.context/gui-automation/`.

- [ ] **Step 6: Commit deterministic automation**

```bash
git add src/gui-host/fixture.ts src/gui-host/main.ts src/run.ts tests/gui-automation.sh tests/gui-launcher.test.ts package.json
git commit -m "test: automate complete native gui flow"
```

---

### Task 10: Document, Audit, and Release-Verify the Complete GUI

**Files:**
- Modify: `README.md`
- Modify: `gui/README.md`
- Modify only defect files identified by the verification commands.

**Interfaces:**
- Produces: user-facing GUI documentation and requirement-by-requirement completion evidence.

- [ ] **Step 1: Document complete GUI operation**

Add exact Bun commands, launch behavior, keyboard shortcuts, command palette, sessions, models/backends/modes, attachments, permissions/questions, sudo warning, panels, responsive behavior, and troubleshooting. Replace stale `core.ts` references in `gui/README.md` with the actual Zig files.

- [ ] **Step 2: Run the full repository verification suite**

Run:

```bash
bun test
bun run typecheck
bun run build
bunx --bun @native-sdk/cli check gui --strict
bunx --bun @native-sdk/cli test gui --yes
bun run gui:automation
bunx --bun @native-sdk/cli build gui --yes
```

Expected: every command exits 0; Bun reports zero failed tests; Native SDK reports zero diagnostics and all tests passed; automation reports no dispatch/markup errors; release binary exists at `gui/zig-out/bin/lavalamp-gui`.

- [ ] **Step 3: Audit every advertised command and visible control**

Run:

```bash
rg -n "TUI-only|not implemented|placeholder|TODO|FIXME" src/gui-host gui/src README.md gui/README.md
rg -n "on-press=" gui/src/app.native
rg -n "pub const Msg|command_|open_panel|new_chat|submit_question|paste_image|rate_" gui/src/main.zig
```

Expected: the first search prints no incomplete-product markers. For every `on-press` binding, a matching `Msg` path exists and the Task 8 dispatch audit covers it.

- [ ] **Step 4: Compare acceptance criteria to direct evidence**

Record in the commit message body or final handoff:

- Live initial and populated render: automation screenshots and `dispatch_errors=0`.
- All controls functional: semantic dispatch audit plus automation flow.
- All `HELP_COMMANDS` represented: feature reader ID test and command palette snapshot.
- Sessions/prompts/queue/cancel/tools/questions/permissions/config/panels/attachments: host and Zig focused tests.
- Default/minimum layouts: automation resize assertions and screenshots.
- Regression/release safety: full Bun, typecheck, build, Native check/test/build commands.

- [ ] **Step 5: Review the final diff against `origin/main`**

Run:

```bash
git diff --check origin/main...
git diff --stat origin/main...
git status --short
```

Expected: no whitespace errors, only intended GUI/host/test/docs files changed, and no untracked generated build or screenshot artifacts.

- [ ] **Step 6: Commit documentation and verification fixes**

```bash
git add README.md gui/README.md
git commit -m "docs: document complete native gui"
```

If verification required code fixes, stage those exact files with their corresponding regression tests and use a separate `fix:` commit before the documentation commit.
