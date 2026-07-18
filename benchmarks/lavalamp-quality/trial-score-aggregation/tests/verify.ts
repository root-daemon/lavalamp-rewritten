import { describe, expect, test } from 'bun:test';
import { scoreTrials } from '/app/src/score.ts';

describe('scoreTrials', () => {
  test('averages rewards across every trial outcome', () => {
    expect(
      scoreTrials([
        { reward: 1, status: 'completed' },
        { reward: 0.5, status: 'completed' },
        { reward: 0, status: 'failed' },
        { reward: 0, status: 'timed_out' },
      ]),
    ).toBe(0.375);
  });

  test('does not discard a nonzero failed-trial reward', () => {
    expect(
      scoreTrials([
        { reward: 1, status: 'completed' },
        { reward: 0.25, status: 'failed' },
      ]),
    ).toBe(0.625);
  });

  test('returns zero for an empty run', () => {
    expect(scoreTrials([])).toBe(0);
  });
});
