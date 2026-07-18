# Login and Model Pickers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit Cloudflare/Codex `/login` picker and a unified `/models` picker that automatically switches backends when a model from the other provider is selected.

**Architecture:** Keep provider-aware picker state and catalog merging in focused TUI modules, while `src/tui/app.ts` owns rendering, keyboard routing, transient Codex runtimes, and the existing runtime/session lifecycle. Extract the current backend transition into one local function so `/backend` and cross-provider model selection share shutdown, rollback, persistence, and clean-session behavior.

**Tech Stack:** TypeScript, Bun test runner, OpenTUI, existing Lavalamp runtime abstractions.

## Global Constraints

- Use Bun rather than npm.
- Do not create commits unless the user explicitly requests one.
- `/login` selection authenticates a provider without changing the active backend.
- `/models` lists Cloudflare and Codex models together and switches backend on cross-provider selection.
- Up/Down navigate, Enter selects, and Escape cancels.

---

### Task 1: Login provider picker state

**Files:**
- Create: `src/tui/login-picker.ts`
- Create: `tests/login-picker.test.ts`

**Interfaces:**
- Produces: `LoginPickerEntry`, `LoginPickerState`, `createLoginPickerState()`, `moveLoginPickerSelection(state, delta)`, and `selectedLoginBackend(state)`.
- Consumes: `AgentBackend` from `src/runtime/backend.ts`.

- [ ] **Step 1: Write the failing picker tests**

```ts
import { describe, expect, test } from 'bun:test';
import {
  createLoginPickerState,
  moveLoginPickerSelection,
  selectedLoginBackend,
} from '../src/tui/login-picker.ts';

describe('login picker', () => {
  test('offers Cloudflare and Codex', () => {
    expect(createLoginPickerState().entries).toEqual([
      { backend: 'flue', label: 'Cloudflare' },
      { backend: 'codex', label: 'Codex' },
    ]);
  });

  test('moves within bounds', () => {
    const state = createLoginPickerState();
    moveLoginPickerSelection(state, 1);
    moveLoginPickerSelection(state, 1);
    expect(selectedLoginBackend(state)).toBe('codex');
    moveLoginPickerSelection(state, -2);
    expect(selectedLoginBackend(state)).toBe('flue');
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `bun test tests/login-picker.test.ts`

Expected: FAIL because `src/tui/login-picker.ts` does not exist.

- [ ] **Step 3: Implement minimal picker state**

```ts
import type { AgentBackend } from '../runtime/backend';

export interface LoginPickerEntry {
  backend: AgentBackend;
  label: string;
}

export interface LoginPickerState {
  entries: LoginPickerEntry[];
  selectedIndex: number;
}

export function createLoginPickerState(): LoginPickerState {
  return {
    entries: [
      { backend: 'flue', label: 'Cloudflare' },
      { backend: 'codex', label: 'Codex' },
    ],
    selectedIndex: 0,
  };
}

export function moveLoginPickerSelection(state: LoginPickerState, delta: number): void {
  state.selectedIndex = Math.max(0, Math.min(state.entries.length - 1, state.selectedIndex + delta));
}

export function selectedLoginBackend(state: LoginPickerState): AgentBackend | undefined {
  return state.entries[state.selectedIndex]?.backend;
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `bun test tests/login-picker.test.ts`

Expected: 2 passing tests.

### Task 2: Provider-aware unified model catalog

**Files:**
- Modify: `src/tui/model-picker.ts`
- Modify: `tests/model-picker.test.ts`

**Interfaces:**
- Produces: `ModelPickerEntry.backend: AgentBackend`, `loadModelPickerModels(listCodexModels)`, and `selectedModel(state): ModelPickerEntry | undefined`.
- Consumes: Cloudflare models from `listModels()` and Codex runtime models from the supplied callback.

- [ ] **Step 1: Replace the backend-specific loading test with failing unified-catalog tests**

```ts
test('loads Cloudflare and Codex models into one provider-aware catalog', async () => {
  const codexModels = [{ id: 'gpt-default', isDefault: true }];
  const models = await loadModelPickerModels(async () => codexModels);
  expect(models.some((model) => model.backend === 'flue')).toBe(true);
  expect(models).toContainEqual({ backend: 'codex', id: 'gpt-default', isDefault: true });
});

test('returns the complete selected model entry', () => {
  const models = [
    { backend: 'flue' as const, id: 'cf-model' },
    { backend: 'codex' as const, id: 'gpt-model' },
  ];
  const state = createModelPickerState('cf-model', 'flue', models);
  moveModelPickerSelection(state, 1);
  expect(selectedModel(state)).toEqual({ backend: 'codex', id: 'gpt-model' });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `bun test tests/model-picker.test.ts`

Expected: FAIL because entries do not carry a backend and the loader only returns one backend.

- [ ] **Step 3: Add backend ownership and catalog merging**

```ts
export interface ModelPickerEntry {
  backend: AgentBackend;
  id: string;
  isDefault?: boolean;
  supportedReasoningEfforts?: string[];
}

export function createModelPickerState(
  currentModel: string,
  currentBackend: AgentBackend,
  models: ModelPickerEntry[],
): ModelPickerState {
  const currentIndex = models.findIndex(
    (model) => model.backend === currentBackend && model.id === currentModel,
  );
  const defaultIndex = models.findIndex(
    (model) => model.backend === currentBackend && model.isDefault === true,
  );
  return { models, selectedIndex: currentIndex >= 0 ? currentIndex : Math.max(0, defaultIndex) };
}

export async function loadModelPickerModels(
  listCodexModels: () => Promise<Omit<ModelPickerEntry, 'backend'>[]>,
): Promise<ModelPickerEntry[]> {
  return [
    ...listModels().map((model) => ({ ...model, backend: 'flue' as const })),
    ...(await listCodexModels()).map((model) => ({ ...model, backend: 'codex' as const })),
  ];
}

export function selectedModel(state: ModelPickerState): ModelPickerEntry | undefined {
  return state.models[state.selectedIndex];
}
```

- [ ] **Step 4: Update existing tests for the provider-aware constructor and run GREEN**

Run: `bun test tests/model-picker.test.ts`

Expected: all model picker tests pass.

### Task 3: Wire `/login` to the provider picker

**Files:**
- Modify: `src/tui/app.ts`
- Modify: `tests/tui-login.test.ts`

**Interfaces:**
- Consumes: Task 1 picker state and the existing `loginFromTui({ backend, runtime, ... })` function.
- Produces: `/login` opens the picker; Enter runs the selected authentication flow; Escape closes it.

- [ ] **Step 1: Add a failing provider-dispatch regression test**

Extend `tests/tui-login.test.ts` to prove `loginFromTui` dispatches from its requested backend rather than ambient state; retain the existing Cloudflare and Codex cases and rename their descriptions to selected-provider language.

- [ ] **Step 2: Run the focused login tests and verify the regression assertions**

Run: `bun test tests/tui-login.test.ts tests/login-picker.test.ts`

Expected: picker tests pass and the dispatch contract remains green before UI wiring.

- [ ] **Step 3: Add login picker state, rendering, authentication, and key handling**

In `src/tui/app.ts`:

```ts
let loginPickerActive = false;
let loginPickerState: LoginPickerState | null = null;
```

`/login` first checks `state.processing`, then calls `showLoginPicker()`. Rendering labels the two entries and shows `↑/↓ select  Enter login  Esc cancel`. Enter calls `loginToBackend(selectedLoginBackend(...))`.

For Codex while the active backend is Cloudflare, `loginToBackend` creates a temporary Codex runtime with `createRuntimeProcess`, starts it, calls `loginFromTui`, and always shuts it down in `finally`. For the active Codex backend it reuses `flue`. Cloudflare always calls the existing Cloudflare login callback and does not replace `flue`.

- [ ] **Step 4: Run login and picker tests**

Run: `bun test tests/tui-login.test.ts tests/login-picker.test.ts`

Expected: all tests pass.

### Task 4: Wire unified `/models` and shared backend transitions

**Files:**
- Modify: `src/tui/app.ts`
- Modify: `tests/model-picker.test.ts`

**Interfaces:**
- Consumes: Task 2 provider-aware model entries.
- Produces: a unified provider-labeled picker and automatic backend switching when selected entry ownership differs from `activeBackend`.

- [ ] **Step 1: Add failing selection-policy tests**

Add a pure helper in `src/tui/model-picker.ts` and test it first:

```ts
export interface ModelSelection {
  backend: AgentBackend;
  modelId: string;
  requiresBackendSwitch: boolean;
}

export function modelSelection(
  activeBackend: AgentBackend,
  entry: ModelPickerEntry,
): ModelSelection;
```

Tests assert `requiresBackendSwitch` is false for matching backends and true for differing backends.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun test tests/model-picker.test.ts`

Expected: FAIL because `modelSelection` does not exist.

- [ ] **Step 3: Implement the helper and refactor backend switching**

Implement `modelSelection` as a direct mapping. In `src/tui/app.ts`, extract the current `/backend` transition into:

```ts
async function switchBackend(nextBackend: AgentBackend, nextModel?: string): Promise<boolean>
```

The function rejects processing state, saves the old session, shuts down the current runtime, creates and starts the requested runtime with `nextModel`, persists `backend` plus `codexModel` or `defaultModel`, clears messages into a new session, and returns `true`. Its catch path recreates and starts the previous runtime, rewires callbacks, reports the error, and returns `false`.

- [ ] **Step 4: Load both catalogs and activate provider-aware selections**

When active backend is Codex, call `flue.listModels()`. When active backend is Cloudflare, create a temporary Codex runtime, start it, read `listModels()`, and shut it down in `finally`. Pass the combined entries to `showModelPicker`.

Render each row with `[Cloudflare]` or `[Codex]`. On Enter, call `setModel` for same-backend entries; otherwise call `switchBackend(entry.backend, entry.id)`. Close the picker only after success.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `bun test tests/model-picker.test.ts tests/login-picker.test.ts tests/tui-login.test.ts && bun run typecheck`

Expected: all focused tests pass and TypeScript exits 0.

### Task 5: Full verification

**Files:**
- Review: all changed files

**Interfaces:**
- Consumes: completed Tasks 1–4.
- Produces: fresh evidence that the feature and repository remain healthy.

- [ ] **Step 1: Run the complete test suite**

Run: `bun test`

Expected: zero failures.

- [ ] **Step 2: Run the complete typecheck**

Run: `bun run typecheck`

Expected: exit code 0.

- [ ] **Step 3: Inspect the final diff and status**

Run: `git diff --check && git diff -- src/tui/login-picker.ts src/tui/model-picker.ts src/tui/app.ts tests/login-picker.test.ts tests/model-picker.test.ts tests/tui-login.test.ts && git status --short`

Expected: no whitespace errors, only intended source/test/docs changes, and no commit created.
