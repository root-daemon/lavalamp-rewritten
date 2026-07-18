# Login and Model Pickers Design

## Goal

Make provider authentication explicit and make every available model discoverable from the TUI, regardless of the active backend.

## Login Picker

Running `/login` without arguments opens a keyboard-driven picker with two entries:

- Cloudflare
- Codex

The picker uses Up/Down to navigate, Enter to authenticate the selected provider, and Escape to cancel. Choosing a provider only runs its authentication flow; it does not change the active backend or session.

Authentication remains unavailable while a prompt is running. Cloudflare uses the existing Cloudflare browser login, and Codex uses the existing app-server login flow. Progress, success, URLs that could not be opened automatically, and errors continue to appear in the `/login` result panel.

## Unified Model Picker

Running `/models` without arguments loads both model catalogs and presents them in one keyboard-driven picker. Each entry carries its owning backend and is visibly labeled as Cloudflare or Codex. Cloudflare models come from the configured Lavalamp catalog; Codex models come from the Codex runtime.

The picker uses Up/Down to navigate, Enter to select, and Escape to cancel. The current model is indicated when it appears in the list.

Selecting a model owned by the active backend changes the model through the existing runtime path. Selecting a model owned by the other backend performs the existing safe backend transition, starts a clean session, persists both the backend and model selection, and activates the chosen model.

## Boundaries and Reuse

Provider-aware picker state and catalog-combination logic live in small testable TUI modules. Rendering and key handling remain in `src/tui/app.ts`, following the current model and session picker patterns. Existing login functions remain responsible for provider-specific authentication.

The backend transition used by `/backend` and cross-provider model selection should share one implementation so shutdown, rollback, session reset, persistence, and error behavior cannot drift.

## Error Handling

- `/login` and cross-backend model selection are rejected while a prompt is running.
- A failed provider login reports the existing error without changing backend state.
- A failed backend transition restores the prior runtime and reports the failure.
- If one provider's model catalog cannot be loaded, `/models` reports the loading error instead of presenting an incomplete list as though it were complete.
- Empty catalogs render an explanatory result rather than an unusable picker.

## Tests

Automated tests cover:

- Login picker entries, navigation bounds, selection, and cancellation state.
- Cloudflare and Codex authentication dispatch independent of the active backend.
- Combined model loading with provider ownership retained.
- Same-backend model selection.
- Cross-backend model selection, including persisted backend/model state and clean-session behavior.
- Prompt-running guards and failure rollback behavior.

The focused tests, complete Bun test suite, and TypeScript typecheck are run before completion is reported.
