# Lavalamp Native GUI Polish and Feature-Parity Design

## Goal

Turn the existing Lavalamp desktop window into a polished, complete native coding workspace. The GUI must render reliably, feel intentionally designed, and expose every user-facing Lavalamp workflow that makes sense in a desktop interface without sending users back to the TUI for ordinary operation.

## Current-state findings

The existing three-column shell establishes the correct product shape, but the live audit found issues that prevent it from meeting the goal:

- The runtime reports a markup build error for the bound destructive alert, even though static markup checks and unit tests pass.
- The visual hierarchy is flat and sparse. The conversation canvas lacks useful starter actions, the inspector reads as a grid of commands rather than contextual information, and selected mode/backend state is unclear.
- `New Task` clears only local model data instead of creating a clean host-backed session.
- Structured question requests exist in the host contract but have no native UI or response path.
- Models are listed as command output instead of being selectable native controls.
- Several advertised buttons return `TUI-only` placeholders, including analytics and benchmarks.
- The activity rail does not expose the planned task, changed-file, or subagent information.
- The desktop flow omits useful TUI behaviors such as prompt steering/queueing, image paste, searchable commands, ratings, skills, MCP status, gateway status, and explicit authentication guidance.
- Runtime automation is not part of the normal verification path, which allowed a live markup error to ship while checks stayed green.

## Product direction

The approved direction is a **premium lava workspace**: a serious developer tool with deep charcoal surfaces, warm lava-orange accents, crisp neutral typography, subtle depth, and restrained motion. It should feel more expressive than a monochrome admin console while remaining calm enough for long coding sessions.

The interface favors progressive disclosure. High-frequency controls stay visible; lower-frequency tools live in searchable panels or menus. Status should be readable at a glance through text, icons, and shape, never color alone.

## Experience principles

1. **Conversation first.** The task transcript and composer remain the visual center of gravity.
2. **Context, not command grids.** The inspector shows what is happening now. A command palette and native panels hold secondary tools.
3. **Every visible control works.** No button may return a placeholder or advertise a flow unavailable in the GUI.
4. **Safe by default.** Permission and sudo behavior remain explicit, scoped, and revocable. Questions never receive fabricated defaults.
5. **Recoverable state.** Failures offer retry or reconnection, drafts survive transient errors, and session changes are explicit.
6. **Native and accessible.** The app remains Native SDK-rendered, keyboard navigable, screen-reader labeled, and usable without a WebView.

## Information architecture

### Session sidebar

The 272 px sidebar contains:

- Product mark and current workspace.
- A prominent `New task` button that requests a fresh host-backed session.
- Session search and a scrollable recent-session list grouped by recency.
- Each session row shows a title, relative timestamp, and running/unread state where applicable.
- Workspace switcher and settings entry at the bottom.
- A compact collapsed form on medium-width windows.

Selecting a session loads its transcript and resets transient tool/question/permission state. Creating a task cancels an active turn only after confirmation, resets the host conversation, and focuses the composer.

### Conversation canvas

The center region contains:

- A compact header with session title, workspace breadcrumb, connection state, active model, and a contextual overflow menu.
- A readable transcript with distinct but restrained user messages, assistant markdown, reasoning disclosure, tool cards, terminal streams, notices, errors, question cards, and permission cards.
- A useful empty state with the workspace name and starter actions such as `Explain this repository`, `Find failing tests`, and `Review current changes`. Starter actions populate the composer rather than immediately spending tokens.
- A sticky composer with multiline text, image attachment preview, mode/model summary, and a context-sensitive `Send`, `Steer`, `Queue`, or `Stop` action.

During a turn, a new prompt can steer the active turn when the backend supports steering or be queued as the next turn. Unsupported steering must fall back to a clearly labeled queue; it must not silently discard input.

### Context inspector

The 304 px inspector is contextual rather than a permanent command launcher. It contains:

- Current run: backend, provider, model, mode, connection, elapsed state, tokens, and cost.
- Plan/tasks: current task items and statuses when emitted by the runtime.
- Activity: ordered tool calls with running/success/failure state, duration, and a readable detail disclosure.
- Changed files: file paths and change type when available from change tracking.
- Subagents: agent name, purpose, status, and latest activity when available.
- Terminal output in a collapsible, selectable panel.

The inspector collapses first on narrower windows and can always be reopened from the header. Missing data produces a small, intentional empty state rather than an unused block.

### Command palette and native panels

`Command-K` opens a searchable command palette. Commands that need more than a one-line result open a native sheet/panel. The following current Lavalamp commands must have GUI behavior:

- Help and keyboard shortcuts.
- New/clear task and session browsing/switching.
- Backend, model, mode, and gateway status/selection.
- Login/authentication status and actionable login guidance.
- Compact, undo, copy transcript, and quit.
- Project memory, workspace, skills, MCP servers, and registered tools.
- Token usage and developer analytics.
- Benchmark catalog and saved benchmark runs.
- Run rating.
- Subagent status.
- Permission rules and explicit sudo-mode control.
- Clipboard image paste and attachment removal.

If a capability is genuinely unavailable for the active backend, the native control remains informative but disabled with a specific reason. It must not claim the whole capability is TUI-only.

## Visual system

### Color and surfaces

- Base canvas: near-black charcoal.
- Sidebar and inspector: slightly elevated charcoal panels.
- Primary accent: warm lava orange used for the active state, primary actions, focus accents, and progress.
- Success, warning, and destructive colors use accessible semantic tokens with accompanying icons/text.
- Borders are one physical pixel where possible; elevated overlays use a subtle shadow and tonal separation.

The app supports the operating-system light/dark appearance only if the Native SDK can preserve the premium hierarchy in both. Dark is the canonical design and the required fully polished path.

### Typography and density

- Geist remains the UI typeface.
- Transcript content uses a comfortable reading width and line height.
- Labels and metadata use a clear size/contrast hierarchy rather than repeated muted gray.
- Controls use compact desktop density with at least 32 px primary targets and larger hit areas for icon-only buttons.

### Shape and motion

- Corners are restrained: small radii for controls, medium radii for cards and overlays.
- Status pills, icons, and selection fills communicate state consistently.
- Motion is limited to short opacity/position transitions, streaming pulses, and progress changes. Reduced-motion preferences disable nonessential animation.

## Functional design

### Typed host contract

The GUI host remains a loopback-only authenticated Bun process. Extend the typed API rather than returning formatted command strings for interactive features. The native app receives structured data for sessions, models, gateway, authentication, usage, analytics, benchmarks, skills, MCP, tools, permission rules, tasks, changed files, subagents, questions, and attachments.

Text command results remain available for the command palette and compatibility, but primary GUI flows use structured endpoints and explicit action payloads.

### Native state model

The Zig model owns:

- Connection and retry state.
- Active session and draft.
- Transcript and streaming assistant content.
- Composer attachment and queued/steering state.
- Pending permission and question forms.
- Current control selections.
- Inspector collections.
- Active overlay/panel and its loading/error/data state.
- Toast/notice feedback for copy, compact, undo, rating, and saved settings.

Messages are exhaustive and route each visible control to a state transition and, where required, an authenticated host effect. Fixed-size buffers remain bounded, but truncation must be indicated for user-visible content rather than silently corrupting it.

### Structured questions

Question metadata is normalized by the host into text, single-choice, multi-choice, and confirm fields. The GUI renders the corresponding controls, validates required answers, and sends an answer object to `/v1/questions/<requestId>`. Cancel/skip is shown only when the runtime declares it legal.

### Permissions and sudo

Permission cards show the tool name and a readable summary of its arguments. `Allow once`, `Always allow`, and `Deny` retain their current semantics. Always-allow explains the persisted scope before confirmation. Sudo mode requires a separate destructive confirmation and displays a persistent warning while active.

### Errors and reconnection

Markup/build failures are caught by tests before release. Host startup, polling, decode, session-load, and action failures render specific inline errors with retry where meaningful. The app uses bounded exponential reconnect attempts while preserving the draft. A host exit during a turn ends the running state and never leaves the composer permanently disabled.

## Responsive behavior

- At 1,180 px and above: sidebar, canvas, and inspector are visible.
- From 920–1,179 px: inspector is collapsed behind a header button.
- Below 920 px is not a supported window size; the manifest minimum remains 920 px.
- At the minimum width, the session sidebar uses its compact width and the composer retains usable text and action space.
- Long session names, workspace paths, model names, command rows, and tool arguments wrap or truncate with disclosure instead of forcing horizontal overflow.

## Architecture boundaries

### `src/gui-host/`

- Contracts define serialized GUI data and actions.
- Runtime adapts Flue/Codex callbacks to those contracts.
- Feature readers/adapters gather sessions, analytics, benchmarks, skills, MCP, permissions, and change tracking without importing TUI components.
- Server validates requests, enforces loopback/auth/body limits, and exposes structured endpoints.

### `gui/src/`

- `main.zig` owns the deterministic model/update/effects loop.
- Focused Zig modules may be introduced for protocol decoding, bounded collections, question forms, and panel state so `main.zig` does not become a monolith.
- `app.native` owns top-level layout; reusable markup components may be extracted for messages, cards, inspector sections, and overlays.

The existing OpenTUI entry path remains unchanged. Shared domain behavior belongs below both UIs instead of being copied from TUI rendering code.

## Testing strategy

### Host tests

Bun tests cover every structured endpoint, authentication, loopback binding, body limits, validation, session creation/switching, steering/queueing, questions, permissions, settings, panels, attachments, analytics, benchmarks, ratings, and error envelopes. Injected fake runtimes avoid provider network calls.

### Native state tests

Zig tests are written before implementation for each state transition: startup/reconnect, session lifecycle, prompt send/steer/queue, streaming, tool updates, questions, permissions, panel loading, model/backend/mode selection, compact/undo/copy feedback, attachment handling, failures, and bounded data behavior.

### Markup and automation tests

Typed markup tests build every conditional branch, including error, permission, question, command result, populated transcript, and empty states. Runtime automation launches the app against a deterministic fixture host and verifies:

- A nonblank, error-free initial render.
- Sidebar, composer, inspector, overlays, and responsive layouts.
- Keyboard traversal and labeled controls.
- Every visible button produces the expected state or host request.
- Session switching, prompt submission, steering/queueing, cancellation, permission resolution, question submission, model/backend/mode changes, command palette actions, and retry.
- Screenshots at the default and minimum window widths.

Final verification runs the full Bun test suite, TypeScript typecheck, strict Native SDK check, Native SDK tests, automation journal/replay or equivalent interaction checks, and a release build.

## Acceptance criteria

The work is complete only when:

1. The app launches without markup, dispatch, or host startup errors and renders nonblank content.
2. The approved premium lava visual hierarchy is visible across empty, active, error, permission, question, and populated states.
3. Every visible control has tested behavior and no GUI surface returns a `TUI-only` placeholder.
4. Every command in `HELP_COMMANDS` has a native GUI path, a working command-palette action, or a specifically disabled backend capability with an explanatory reason.
5. Sessions, prompts, streaming, steering/queueing, cancellation, tools, terminal output, questions, permissions, models, backends, modes, usage, analytics, benchmarks, skills, MCP, gateway, ratings, subagents, copy, undo, compact, authentication guidance, workspace information, and image paste are implemented.
6. The default and minimum-width layouts remain usable and accessible.
7. All repository, host, native, automation, typecheck, and release-build verification completes successfully.

## Non-goals

- Replacing the existing TUI or changing its default launch behavior.
- Embedding the TUI in a terminal/WebView as a shortcut to feature parity.
- Adding provider-specific features that are not already represented by Lavalamp's shared runtime.
- Adding collaboration, cloud sync, or multi-window editing unrelated to the current Lavalamp feature set.
