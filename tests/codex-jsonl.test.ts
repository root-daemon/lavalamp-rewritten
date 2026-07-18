import { describe, expect, test } from 'bun:test';
import { CodexJsonlPeer } from '../src/runtime/codex/jsonl.ts';

describe('Codex JSONL peer', () => {
  test('correlates fragmented and out-of-order responses', async () => {
    const writes: string[] = [];
    const peer = new CodexJsonlPeer((line) => writes.push(line), {
      retryDelaysMs: [],
    });

    const first = peer.request('first', { value: 1 });
    const second = peer.request('second', { value: 2 });
    const [firstRequest, secondRequest] = writes.map((line) => JSON.parse(line));

    const response = `${JSON.stringify({ id: secondRequest.id, result: 'two' })}\n${JSON.stringify({ id: firstRequest.id, result: 'one' })}\n`;
    peer.feed(response.slice(0, 11));
    peer.feed(response.slice(11));

    expect(await first).toBe('one');
    expect(await second).toBe('two');
  });

  test('retries only server-overloaded errors', async () => {
    const writes: string[] = [];
    const peer = new CodexJsonlPeer((line) => writes.push(line), {
      retryDelaysMs: [0],
    });

    const result = peer.request('model/list', {});
    const first = JSON.parse(writes[0] ?? '{}');
    peer.feed(
      `${JSON.stringify({ error: { code: -32001, message: 'Server overloaded; retry later.' }, id: first.id })}\n`,
    );
    await Bun.sleep(1);
    const retry = JSON.parse(writes[1] ?? '{}');
    expect(retry.method).toBe('model/list');
    expect(retry.id).not.toBe(first.id);
    peer.feed(`${JSON.stringify({ id: retry.id, result: { data: [] } })}\n`);

    expect(await result).toEqual({ data: [] });
  });

  test('surfaces server requests and writes their responses', () => {
    const writes: string[] = [];
    const peer = new CodexJsonlPeer((line) => writes.push(line));
    peer.onRequest = (request) => {
      peer.respond(request.id, { decision: 'decline' });
    };

    peer.feed(
      `${JSON.stringify({ id: 91, method: 'item/fileChange/requestApproval', params: { itemId: 'item-1' } })}\n`,
    );

    expect(JSON.parse(writes[0] ?? '{}')).toEqual({
      id: 91,
      result: { decision: 'decline' },
    });
  });

  test('rejects pending requests when the transport closes', async () => {
    const peer = new CodexJsonlPeer(() => {});
    const pending = peer.request('thread/start', {});
    peer.close(new Error('app-server exited'));
    expect(pending).rejects.toThrow('app-server exited');
  });

  test('times out requests that never receive a response', async () => {
    const peer = new CodexJsonlPeer(() => {}, { requestTimeoutMs: 1 });
    await expect(peer.request('model/list', {})).rejects.toThrow('Codex request timed out: model/list');
  });
});
