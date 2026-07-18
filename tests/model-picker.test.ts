import { describe, expect, test } from 'bun:test';
import {
  createModelPickerState,
  moveModelPickerSelection,
  selectedModelId,
} from '../src/tui/model-picker.ts';
import { BUILD_MODEL, listModels } from '../src/config/models.ts';

describe('model picker', () => {
  test('selects the current model initially', () => {
    const state = createModelPickerState(BUILD_MODEL);
    expect(selectedModelId(state)).toBe(BUILD_MODEL);
  });

  test('moves down and selects the next model', () => {
    const models = listModels();
    const first = models[0]?.id;
    const second = models[1]?.id;
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    const state = createModelPickerState(first ?? BUILD_MODEL);
    moveModelPickerSelection(state, 1);
    expect(selectedModelId(state)).toBe(second);
  });

  test('moves up and selects the previous model', () => {
    const models = listModels();
    const second = models[1]?.id;
    const first = models[0]?.id;
    expect(second).toBeDefined();
    expect(first).toBeDefined();

    const state = createModelPickerState(second ?? BUILD_MODEL);
    moveModelPickerSelection(state, -1);
    expect(selectedModelId(state)).toBe(first);
  });

  test('does not move before the first model', () => {
    const first = listModels()[0]?.id ?? BUILD_MODEL;
    const state = createModelPickerState(first);
    moveModelPickerSelection(state, -1);
    expect(selectedModelId(state)).toBe(first);
  });

  test('does not move after the last model', () => {
    const models = listModels();
    const last = models.at(-1)?.id ?? BUILD_MODEL;
    const state = createModelPickerState(last);
    moveModelPickerSelection(state, 1);
    expect(selectedModelId(state)).toBe(last);
  });

  test('selects the server default from a Codex model catalog', () => {
    const models = [
      { id: 'gpt-first', isDefault: false },
      { id: 'gpt-default', isDefault: true },
    ];

    const state = createModelPickerState('server default', models);

    expect(selectedModelId(state)).toBe('gpt-default');
  });

  test('loads Codex models for the interactive picker', async () => {
    const module = await import('../src/tui/model-picker.ts');
    const loadModels = Reflect.get(module, 'loadModelPickerModels');
    const models = [
      {
        description: 'Default Codex model',
        displayName: 'GPT Default',
        id: 'gpt-default',
        inputModalities: ['text'],
        isDefault: true,
        supportedReasoningEfforts: ['medium', 'high'],
      },
    ];

    expect(typeof loadModels).toBe('function');
    if (typeof loadModels !== 'function') return;

    expect(await loadModels('codex', async () => models)).toEqual(models);
  });
});
