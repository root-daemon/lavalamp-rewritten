import { listModels } from '../config/models';
import type { AgentBackend } from '../runtime/backend';

export interface ModelPickerEntry {
  backend: AgentBackend;
  description?: string;
  displayName?: string;
  id: string;
  inputModalities?: string[];
  isDefault?: boolean;
  supportedReasoningEfforts?: string[];
}

export interface ModelPickerState {
  models: ModelPickerEntry[];
  selectedIndex: number;
}

export interface ModelSelection {
  backend: AgentBackend;
  modelId: string;
  requiresBackendSwitch: boolean;
}

export function createModelPickerState(
  currentModel: string,
  currentBackend: AgentBackend,
  models: ModelPickerEntry[] = listModels().map((model) => ({
    ...model,
    backend: 'flue',
  })),
): ModelPickerState {
  const currentIndex = models.findIndex(
    (model) =>
      model.backend === currentBackend && model.id === currentModel,
  );
  const defaultIndex = models.findIndex(
    (model) =>
      model.backend === currentBackend && model.isDefault === true,
  );
  const selectedIndex = currentIndex >= 0
    ? currentIndex
    : Math.max(0, defaultIndex);
  return { models, selectedIndex };
}

export async function loadModelPickerModels(
  listCodexModels: () => Promise<Omit<ModelPickerEntry, 'backend'>[]>,
): Promise<ModelPickerEntry[]> {
  const codexModels = await listCodexModels();
  return [
    ...listModels().map((model) => ({
      ...model,
      backend: 'flue' as const,
    })),
    ...codexModels.map((model) => ({
      ...model,
      backend: 'codex' as const,
    })),
  ];
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
  return selectedModel(state)?.id;
}

export function selectedModel(
  state: ModelPickerState,
): ModelPickerEntry | undefined {
  return state.models[state.selectedIndex];
}

export function modelSelection(
  activeBackend: AgentBackend,
  entry: ModelPickerEntry,
): ModelSelection {
  return {
    backend: entry.backend,
    modelId: entry.id,
    requiresBackendSwitch: entry.backend !== activeBackend,
  };
}
