import { listModels } from '../config/models';
import type { AgentBackend } from '../runtime/backend';

export interface ModelPickerEntry {
  id: string;
  isDefault?: boolean;
  supportedReasoningEfforts?: string[];
}

export interface ModelPickerState {
  models: ModelPickerEntry[];
  selectedIndex: number;
}

export function createModelPickerState(
  currentModel: string,
  models: ModelPickerEntry[] = listModels(),
): ModelPickerState {
  const currentIndex = models.findIndex((model) => model.id === currentModel);
  const defaultIndex = models.findIndex((model) => model.isDefault === true);
  const selectedIndex = currentIndex >= 0
    ? currentIndex
    : Math.max(0, defaultIndex);
  return { models, selectedIndex };
}

export async function loadModelPickerModels(
  backend: AgentBackend,
  listCodexModels: () => Promise<ModelPickerEntry[]>,
): Promise<ModelPickerEntry[]> {
  return backend === 'codex' ? listCodexModels() : listModels();
}

export function moveModelPickerSelection(
  state: ModelPickerState,
  delta: number,
): void {
  state.selectedIndex = Math.max(
    0,
    Math.min(state.models.length - 1, state.selectedIndex + delta),
  );
}

export function selectedModelId(state: ModelPickerState): string | undefined {
  return state.models[state.selectedIndex]?.id;
}
