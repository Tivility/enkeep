import { describe, expect, it } from 'vitest';
import { Peer, RpcError } from '../src/rpc.js';
import { delay, memorySocketPair, waitFor } from './helpers.js';

function pair(): { a: Peer; b: Peer; rawA: ReturnType<typeof memorySocketPair>[0]; rawB: ReturnType<typeof memorySocketPair>[1] } {
  const [rawA, rawB] = memorySocketPair();
  return { a: new Peer(rawA, { idPrefix: 'e' }), b: new Peer(rawB, { idPrefix: 'n' }), rawA, rawB };
}

describe('Peer', () => {
  it('sends requests with e-prefixed ids and resolves with the result', async () => {
    const { a, b, rawA } = pair();
    b.setRequestHandler(async (method, params) => ({ echo: method, params }));
    const result = await a.call('session.ping', { n: 1 });
    expect(result).toEqual({ echo: 'session.ping', params: { n: 1 } });
    const frame = JSON.parse(rawA.sent[0]!);
    expect(frame).toEqual({ id: 'e1', method: 'session.ping', params: { n: 1 } });
  });

  it('works in both directions', async () => {
    const { a, b } = pair();
    a.setRequestHandler(() => ({ from: 'a' }));
    b.setRequestHandler(() => ({ from: 'b' }));
    expect(await a.call('x')).toEqual({ from: 'b' });
    expect(await b.call('y')).toEqual({ from: 'a' });
  });

  it('answers handler errors with their string code', async () => {
    const { a, b, rawB } = pair();
    b.setRequestHandler(() => {
      throw Object.assign(new Error('no such session'), { code: 'not_found' });
    });
    const err = await a.call('session.items').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toBe('not_found');
    expect((err as RpcError).message).toBe('no such session');
    expect(JSON.parse(rawB.sent[0]!)).toEqual({ id: 'e1', error: { message: 'no such session', code: 'not_found' } });
  });

  it('answers without a handler with code unsupported', async () => {
    const { a } = pair();
    const err = (await a.call('anything').catch((e: unknown) => e)) as RpcError;
    expect(err.code).toBe('unsupported');
  });

  it('times out, aborts, and rejects pending calls on close with code closed', async () => {
    const { a, b } = pair();
    b.setRequestHandler(() => new Promise(() => undefined));

    const timedOut = (await a.call('slow', {}, { timeoutMs: 20 }).catch((e: unknown) => e)) as RpcError;
    expect(timedOut.code).toBe('timeout');

    const controller = new AbortController();
    const aborted = a.call('slow', {}, { signal: controller.signal, timeoutMs: 0 }).catch((e: unknown) => e);
    controller.abort();
    expect(((await aborted) as RpcError).code).toBe('aborted');

    const pending = a.call('slow', {}, { timeoutMs: 0 }).catch((e: unknown) => e);
    a.close();
    expect(((await pending) as RpcError).code).toBe('closed');
    expect(((await a.call('later').catch((e: unknown) => e)) as RpcError).code).toBe('closed');
  });

  it('rejects pending calls when the socket closes', async () => {
    const { a, b, rawB } = pair();
    b.setRequestHandler(() => new Promise(() => undefined));
    const pending = a.call('slow', {}, { timeoutMs: 0 }).catch((e: unknown) => e);
    await delay(5);
    rawB.close(1001, 'bye');
    expect(((await pending) as RpcError).code).toBe('closed');
    expect(a.closed).toBe(true);
  });

  it('delivers events, accepts a trailing newline and ignores malformed frames', async () => {
    const seen: Array<[string, unknown]> = [];
    const [x, y] = memorySocketPair();
    const receiver = new Peer(y);
    receiver.setEventHandler((event, params) => seen.push([event, params]));
    x.send('not json');
    x.send('[1,2]');
    x.send('{"event":"runtime.hub","params":{"connected":true}}\n');
    await waitFor(() => seen.length === 1);
    expect(seen[0]).toEqual(['runtime.hub', { connected: true }]);

    const sender = new Peer(x);
    expect(sender.notify('session.delta', { session_id: 'ses_x', text: '' })).toBe(true);
    await waitFor(() => seen.length === 2);
    expect(seen[1]).toEqual(['session.delta', { session_id: 'ses_x', text: '' }]);
  });

  it('ignores responses to unknown ids', async () => {
    const [x, y] = memorySocketPair();
    const peer = new Peer(y);
    x.send(JSON.stringify({ id: 'e999', result: { ok: true } }));
    await delay(5);
    expect(peer.closed).toBe(false);
  });
});
