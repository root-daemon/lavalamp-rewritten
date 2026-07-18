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

  test('moves down and stops at the last provider', () => {
    const state = createLoginPickerState();
    moveLoginPickerSelection(state, 1);
    moveLoginPickerSelection(state, 1);
    expect(selectedLoginBackend(state)).toBe('codex');
  });

  test('moves up and stops at the first provider', () => {
    const state = createLoginPickerState();
    moveLoginPickerSelection(state, 1);
    moveLoginPickerSelection(state, -2);
    expect(selectedLoginBackend(state)).toBe('flue');
  });
});
