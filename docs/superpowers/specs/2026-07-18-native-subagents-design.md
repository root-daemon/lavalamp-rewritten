# Native Subagents Design

## Goal

Expose Codex native subagents as first-class Lavalamp activity in both the TUI
and native GUI while preserving the existing Flue parallel-research behavior.
Users can see subagent identity, task, status, and result, open a read-only view
of a child thread, and stop a running subagent.

## Architecture

Add a backend-neutral subagent contract at the runtime boundary. The contract
contains stable identity, parent relationship, display metadata, task prompt,
runtime status, and an optional final result. Runtime implementations expose
operations to list subagents, inspect a child transcript, and stop a running
child.

Codex remains responsible for orchestration. Lavalamp observes native
app-server thread and collaboration events instead of spawning replacement
processes. Flue keeps its current `SubAgentManager`; an adapter projects that
state into the shared contract.

## Codex Data Flow

1. Start app-server with native multi-agent support enabled.
2. Record child relationships from `thread/started` notifications whose
   `parentThreadId` belongs to the active session tree.
3. Enrich child state from parent `collabAgentToolCall` items, including the
   requested prompt, model, role, nickname, receiver thread IDs, and terminal
   agent state.
4. Apply `thread/status/changed` notifications to known child threads instead
   of discarding every notification whose thread ID differs from the main
   thread.
5. Emit backend-neutral subagent events for the presentation layers.
6. On inspection, call `thread/read` with `includeTurns: true` and reconstruct a
   read-only transcript. Child item streams are not mixed into the main chat.
7. Stop a running child through the app-server's thread interruption API. The
   main Codex agent remains responsible for collecting completed results.

## Flue Data Flow

The current deployment marker and `SubAgentManager` remain unchanged at the
orchestration layer. Its running, done, failed, timed-out, and killed states are
mapped to the shared subagent status values. Existing result aggregation back
into the main Flue prompt continues unchanged. Inspection uses the result and
captured activity available from the subprocess; stopping delegates to the
manager's current kill operation.

## Presentation

The TUI keeps the existing subagent panel and `/subagents` command, but sources
them from the active runtime rather than assuming Flue subprocesses. Selecting
a subagent opens a read-only transcript viewer. The existing stop shortcut acts
on the selected or first running subagent.

The GUI host snapshot and event stream gain subagent lifecycle data. The native
activity rail lists active and completed children, and selecting one opens a
read-only detail view populated through the host inspection endpoint. No
composer or steering controls appear inside that view.

## Error Handling

- Unknown or out-of-order child notifications create or merge placeholder
  state rather than failing the main turn.
- A failed history read shows an inspection error without affecting the parent
  session.
- Stop is idempotent for terminal or unknown children.
- App-server protocol fields are parsed defensively so a newer optional field
  cannot crash the runtime.
- Runtime shutdown clears tracked children and does not leak child state into a
  newly opened session.

## Testing

- Unit-test Codex translation for child-thread creation, collaboration calls,
  status transitions, completion, and malformed payloads.
- Unit-test lazy child transcript reads and interruption requests with JSONL
  protocol fixtures.
- Unit-test the shared status mapping for Flue.
- Test TUI state/view behavior for listing, selection, inspection, and stop.
- Test GUI host snapshots, events, inspection responses, and error behavior.
- Run the full Bun test suite, typecheck, build, and native GUI checks relevant
  to changed Zig code.

## Non-goals

- Sending follow-up instructions directly to a child thread.
- Replacing Codex orchestration with Lavalamp subprocesses.
- Recursive subagent visualization beyond relationships reported by Codex.
- Changing Flue's maximum of three parallel research subprocesses.
