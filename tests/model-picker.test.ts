import { describe, expect, test } from 'bun:test';
import {
  createModelPickerState,
  loadModelPickerModels,
  modelSelection,
  moveModelPickerSelection,
  selectedModel,
  selectedModelId,
} from '../src/tui/model-picker.ts';
import { BUILD_MODEL, listModels } from '../src/config/models.ts';
import { HELP_COMMANDS } from '../src/tui/slash-data.ts';

describe('model picker', () => {
  test('advertises the unified model catalog', () => {
    expect(HELP_COMMANDS).toContainEqual([
      '/models',
      'Browse Cloudflare and Codex models',
    ]);
  });

  test('selects the current model initially', () => {
    const state = createModelPickerState(BUILD_MODEL, 'flue');
    expect(selectedModelId(state)).toBe(BUILD_MODEL);
  });

  test('moves down and selects the next model', () => {
    const models = listModels();
    const first = models[0]?.id;
    const second = models[1]?.id;
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    const state = createModelPickerState(first ?? BUILD_MODEL, 'flue');
    moveModelPickerSelection(state, 1);
    expect(selectedModelId(state)).toBe(second);
  });

  test('moves up and selects the previous model', () => {
    const models = listModels();
    const second = models[1]?.id;
    const first = models[0]?.id;
    expect(second).toBeDefined();
    expect(first).toBeDefined();

    const state = createModelPickerState(second ?? BUILD_MODEL, 'flue');
    moveModelPickerSelection(state, -1);
    expect(selectedModelId(state)).toBe(first);
  });

  test('does not move before the first model', () => {
    const first = listModels()[0]?.id ?? BUILD_MODEL;
    const state = createModelPickerState(first, 'flue');
    moveModelPickerSelection(state, -1);
    expect(selectedModelId(state)).toBe(first);
  });

  test('does not move after the last model', () => {
    const models = listModels();
    const last = models.at(-1)?.id ?? BUILD_MODEL;
    const state = createModelPickerState(last, 'flue');
    moveModelPickerSelection(state, 1);
    expect(selectedModelId(state)).toBe(last);
  });

  test('selects the server default from a Codex model catalog', () => {
    const models = [
      { backend: 'codex' as const, id: 'gpt-first', isDefault: false },
      { backend: 'codex' as const, id: 'gpt-default', isDefault: true },
    ];

    const state = createModelPickerState('server default', 'codex', models);

    expect(selectedModelId(state)).toBe('gpt-default');
  });

  test('loads Cloudflare and Codex models into one provider-aware catalog', async () => {
    const codexModels = [
      {
        description: 'Default Codex model',
        displayName: 'GPT Default',
        id: 'gpt-default',
        inputModalities: ['text'],
        isDefault: true,
        supportedReasoningEfforts: ['medium', 'high'],
      },
    ];

    const models = await loadModelPickerModels(async () => codexModels);

    expect(models.some((model) => model.backend === 'flue')).toBe(true);
    expect(models).toContainEqual({
      ...codexModels[0],
      backend: 'codex',
    });
  });

  test('returns the complete selected model entry', () => {
    const models = [
      { backend: 'flue' as const, id: 'cf-model' },
      { backend: 'codex' as const, id: 'gpt-model' },
    ];
    const state = createModelPickerState('cf-model', 'flue', models);

    moveModelPickerSelection(state, 1);

    expect(selectedModel(state)).toEqual({
      backend: 'codex',
      id: 'gpt-model',
    });
  });

  test('keeps same-backend model selection in the current runtime', () => {
    expect(modelSelection('flue', { backend: 'flue', id: 'cf-model' })).toEqual({
      backend: 'flue',
      modelId: 'cf-model',
      requiresBackendSwitch: false,
    });
  });

  test('requests a backend switch for a model owned by another provider', () => {
    expect(modelSelection('flue', { backend: 'codex', id: 'gpt-model' })).toEqual({
      backend: 'codex',
      modelId: 'gpt-model',
      requiresBackendSwitch: true,
    });
  });
});
