import { describe, expect, test } from 'bun:test';
import { resolveModel } from '/app/src/config.ts';

describe('resolveModel', () => {
  test('prefers an explicit model over every other source', () => {
    expect(
      resolveModel({
        explicit: ' openai/gpt-5 ',
        environment: 'anthropic/claude-sonnet-4.6',
        configured: 'cloudflare-workers-ai/default',
        fallback: 'fallback/model',
      }),
    ).toBe('openai/gpt-5');
  });

  test('uses environment, configuration, then fallback in order', () => {
    expect(
      resolveModel({
        environment: 'anthropic/claude-sonnet-4.6',
        configured: 'cloudflare-workers-ai/default',
        fallback: 'fallback/model',
      }),
    ).toBe('anthropic/claude-sonnet-4.6');
    expect(
      resolveModel({
        configured: 'cloudflare-workers-ai/default',
        fallback: 'fallback/model',
      }),
    ).toBe('cloudflare-workers-ai/default');
    expect(resolveModel({ fallback: 'fallback/model' })).toBe(
      'fallback/model',
    );
  });

  test('ignores empty and whitespace-only values', () => {
    expect(
      resolveModel({
        explicit: ' ',
        environment: '',
        configured: '  configured/model  ',
        fallback: 'fallback/model',
      }),
    ).toBe('configured/model');
  });
});
