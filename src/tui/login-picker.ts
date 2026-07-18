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

export function moveLoginPickerSelection(
  state: LoginPickerState,
  delta: number,
): void {
  state.selectedIndex = Math.max(
    0,
    Math.min(state.entries.length - 1, state.selectedIndex + delta),
  );
}

export function selectedLoginBackend(
  state: LoginPickerState,
): AgentBackend | undefined {
  return state.entries[state.selectedIndex]?.backend;
}
