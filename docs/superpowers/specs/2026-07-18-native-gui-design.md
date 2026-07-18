# Lavalamp Native GUI Design

## Goal

Add a first-class desktop GUI for Lavalamp without changing or replacing the existing OpenTUI interface. The GUI must expose the same agent runtime, streaming responses, tools, permissions, questions, sessions, workspace selection, model state, and usage data.

## Product shape

The app uses a Vercel-like visual language: near-black navigation, neutral white/gray content surfaces, Geist typography, one-pixel borders, restrained radius, compact controls, and minimal animation. The initial window has three regions:

- A 248 px sidebar with product identity, new-chat action, recent sessions, workspace, and settings.
- A flexible conversation canvas with session header, streaming message timeline, tool activity cards, permission/question cards, and composer.
- A 300 px contextual activity rail with current plan/tasks, changed files, running subagents, token usage, cost, model route, and connection state.

The activity rail may collapse on narrow windows. Empty state presents workspace identity and focused starter actions. Existing TUI remains reachable through the current `lavalamp` command and keeps its behavior unchanged.

## Architecture

### Native app

`gui/` is a standalone Native SDK application. `src/app.native` owns layout and bindings. `src/core.ts` owns deterministic UI state and messages. The shipped app uses Native SDK rendering and built-in components; no WebView or bundled browser.

### Lavalamp GUI host

`src/gui-host/` is a Bun process inside the existing TypeScript project. It owns one persistent `FlueProcess`, converts Flue IPC events into serializable GUI events, and exposes a loopback-only HTTP API. The host binds `127.0.0.1`, rejects non-loopback traffic, uses a per-launch bearer token, and never exposes provider credentials to the native view.

The native app starts the host as a keyed subprocess and talks to it using Native SDK `Cmd.fetch`. Polling is acceptable for v1: a short poll while a turn runs and slower poll while idle. Event IDs make polling incremental and deterministic.

### API contract

- `POST /v1/session` starts or restores a GUI session and returns current snapshot.
- `POST /v1/prompts` submits prompt for active session.
- `GET /v1/events?after=<id>` returns ordered events after cursor.
- `POST /v1/permissions/<requestId>` sends allow, always-allow, or deny.
- `POST /v1/questions/<requestId>` sends structured answers.
- `POST /v1/cancel` cancels active turn when runtime supports cancellation.
- `GET /v1/sessions` returns recent sessions.
- `GET /v1/models` returns configured model registry.
- `GET /v1/health` reports readiness and runtime metadata.

Every response uses `{ ok: true, data }` or `{ ok: false, error: { code, message } }`. Request bodies have a 1 MiB limit. Event history has bounded retention while preserving current session snapshot.

## Data flow

Composer submit dispatches a native message. The core marks turn running and sends `POST /v1/prompts`. Host forwards prompt to persistent `FlueProcess`. Flue callbacks append normalized events. Native core polls events, folds them into immutable UI state, and renders assistant text, thinking status, tool calls, terminal streams, usage, questions, and permission gates. Permission/question actions call host endpoints; host sends existing IPC responses to Flue.

Session switching shuts down current Flue child cleanly, restores selected transcript where available, and starts a new child with session ID. The host is source of truth for runtime state; native core is source of truth for transient UI state.

## Failure behavior

Host startup failure produces retryable disconnected state. HTTP and decode errors render inline with retry. Child-process exit ends active turn with explicit failure event. Permission requests never auto-allow. If GUI disconnects while permission pending, request stays pending until timeout or reconnection. Host shutdown terminates Flue child.

## Testing

- Bun unit tests cover event normalization, API validation, auth, event cursors, and permission routing.
- Host integration tests use injected fake runtime; no provider network calls.
- Native core tests cover state transitions for prompt streaming, tools, permissions, sessions, and failures.
- `native check`, `native test`, and built-in automation verify markup, interactions, snapshots, and nonblank rendering.
- Existing `bun test` and `bun run typecheck` guard TUI/runtime regressions.

## Initial delivery boundary

V1 includes chat, streaming, tools, permissions, questions, workspace/model display, sessions, tasks/activity, usage, and error states. File-diff and code details open as readable panels. Drag-drop attachments, updater UI, analytics charts, and multi-window viewers stay outside initial delivery unless already cheap through existing APIs.
