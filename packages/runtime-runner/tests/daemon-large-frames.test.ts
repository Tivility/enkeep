import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  DaemonRpcDecoder,
  DaemonRpcEncoder,
  DAEMON_ERROR_CODES,
  MAX_JSON_DEPTH,
  encodeDaemonMessage,
  unserializableResponseFallback,
  type DaemonMessage,
} from '../src/runtime/daemon-protocol.js';

function deepObject(depth: number): Record<string, unknown> {
  let obj: Record<string, unknown> = { leaf: true };
  for (let i = 0; i < depth; i++) obj = { nested: obj };
  return obj;
}

describe('daemon framing without a size cap', () => {
  it('round-trips a frame well above 10 MiB through encoder → chunked pipe → decoder', async () => {
    const events = Array.from({ length: 2000 }, (_, i) => ({ seq: i, type: 'user/message', data: { text: 'x'.repeat(10_000) } }));
    const response = { id: 'export_synth_1', op: 'exportForkSeed', ok: true, events } as unknown as DaemonMessage;
    const encoded = encodeDaemonMessage(response);
    expect(encoded.length).toBeGreaterThan(18 * 1024 * 1024);

    const encoder = new DaemonRpcEncoder();
    const decoder = new DaemonRpcDecoder();
    const received: any[] = [];
    decoder.on('data', (msg) => received.push(msg));
    const errors: Error[] = [];
    decoder.on('error', (err) => errors.push(err));

    // Re-chunk into 64 KiB pieces like a socket would
    const pipe = new PassThrough({ highWaterMark: 64 * 1024 });
    encoder.pipe(pipe);
    pipe.on('data', (chunk: Buffer) => {
      for (let off = 0; off < chunk.length; off += 64 * 1024) {
        decoder.write(chunk.subarray(off, off + 64 * 1024));
      }
    });

    encoder.write(response);
    encoder.write({ id: 'after_1', op: 'health', ok: true } as unknown as DaemonMessage);
    await new Promise((r) => setTimeout(r, 200));

    expect(errors).toHaveLength(0);
    expect(received).toHaveLength(2);
    expect(received[0].id).toBe('export_synth_1');
    expect(received[0].events).toHaveLength(2000);
    expect(received[0].events[1999].data.text.length).toBe(10_000);
    expect(received[1].id).toBe('after_1');
  });

  it('reports an unserializable message via encodeError and keeps the stream usable', async () => {
    const encoder = new DaemonRpcEncoder();
    const out: Buffer[] = [];
    encoder.on('data', (b: Buffer) => out.push(b));
    const streamErrors: Error[] = [];
    encoder.on('error', (err) => streamErrors.push(err));
    const encodeErrors: Array<{ err: any; msg: any }> = [];
    encoder.on('encodeError', (err, msg) => encodeErrors.push({ err, msg }));

    encoder.write({ id: 'deep_1', op: 'exportForkSeed', ok: true, events: [deepObject(MAX_JSON_DEPTH + 5)] } as unknown as DaemonMessage);
    encoder.write({ id: 'ok_1', op: 'health', ok: true } as unknown as DaemonMessage);
    await new Promise((r) => setTimeout(r, 20));

    expect(streamErrors).toHaveLength(0);
    expect(encodeErrors).toHaveLength(1);
    expect(encodeErrors[0].msg.id).toBe('deep_1');
    expect(encodeErrors[0].err.code).toBe(DAEMON_ERROR_CODES.MAX_DEPTH_EXCEEDED);
    const lines = Buffer.concat(out).toString('utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).id).toBe('ok_1');
  });

  it('does not throw an unhandled error when nobody listens for encodeError', async () => {
    const encoder = new DaemonRpcEncoder();
    const sink = new PassThrough();
    encoder.pipe(sink);
    encoder.write({ id: 'deep_2', op: 'health', ok: true, extra: deepObject(MAX_JSON_DEPTH + 5) } as unknown as DaemonMessage);
    await new Promise((r) => setTimeout(r, 20));
    expect(encoder.destroyed).toBe(false);
  });

  it('builds an error response only for responses, never for events or prior fallbacks', () => {
    const err = new Error('too deep');
    const fallback = unserializableResponseFallback({ id: 'r1', op: 'exportForkSeed', ok: true }, err) as any;
    expect(fallback).toEqual({
      id: 'r1',
      op: 'exportForkSeed',
      ok: false,
      error: { code: DAEMON_ERROR_CODES.INTERNAL_ERROR, message: 'Daemon response could not be serialized: too deep' },
    });
    expect(unserializableResponseFallback({ event: 'turn/event', turnId: 't1' }, err)).toBeNull();
    expect(unserializableResponseFallback({ id: 'q1', op: 'health' }, err)).toBeNull();
    expect(unserializableResponseFallback(fallback, err)).toBeNull();
  });
});
