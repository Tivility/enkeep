import { describe, it, expect } from 'vitest';
import { BoundedEventBuffer, RelayBackpressureError } from '../src/index.js';

describe('BoundedEventBuffer Unit Tests', () => {
  it('assigns deterministic per-session cursors (${sessionId}:${seq})', () => {
    const buffer = new BoundedEventBuffer(10);
    const env1 = buffer.push('sess-1', { type: 't1', seq: 1, time: 100, data: {} as any });
    const env2 = buffer.push('sess-1', { type: 't2', seq: 2, time: 200, data: {} as any });

    expect(env1.cursor).toBe('sess-1:1');
    expect(env1.seq).toBe(1);
    expect(env2.cursor).toBe('sess-1:2');
    expect(env2.seq).toBe(2);
  });

  it('isolates buffers and sequences across distinct sessions', () => {
    const buffer = new BoundedEventBuffer(10);
    buffer.push('session-A', { type: 'a1', seq: 1, time: 1, data: {} as any });
    buffer.push('session-B', { type: 'b1', seq: 1, time: 2, data: {} as any });
    buffer.push('session-A', { type: 'a2', seq: 2, time: 3, data: {} as any });

    const pollA = buffer.poll({ sessionId: 'session-A' });
    const pollB = buffer.poll({ sessionId: 'session-B' });

    expect(pollA.envelopes).toHaveLength(2);
    expect(pollA.envelopes.map((e) => e.cursor)).toEqual(['session-A:1', 'session-A:2']);

    expect(pollB.envelopes).toHaveLength(1);
    expect(pollB.envelopes.map((e) => e.cursor)).toEqual(['session-B:1']);
  });

  it('throws RelayBackpressureError when capacity is reached with unacknowledged events (no silent eviction)', () => {
    const buffer = new BoundedEventBuffer(2);

    buffer.push('s-overflow', { type: 'e1', seq: 1, time: 1, data: {} as any });
    buffer.push('s-overflow', { type: 'e2', seq: 2, time: 2, data: {} as any });

    expect(buffer.getBufferSize('s-overflow')).toBe(2);

    // Third unacknowledged event throws RelayBackpressureError
    expect(() => {
      buffer.push('s-overflow', { type: 'e3', seq: 3, time: 3, data: {} as any });
    }).toThrow(RelayBackpressureError);

    // Oldest unacknowledged events (1 and 2) are STILL in buffer (not silently evicted)
    const pollBeforeAck = buffer.poll({ sessionId: 's-overflow' });
    expect(pollBeforeAck.envelopes.map((e) => e.seq)).toEqual([1, 2]);

    // After acking seq 1, capacity is freed
    buffer.ack('s-overflow', 's-overflow:1');
    expect(buffer.getBufferSize('s-overflow')).toBe(1);

    // Now pushing seq 3 succeeds
    expect(() => {
      buffer.push('s-overflow', { type: 'e3', seq: 3, time: 3, data: {} as any });
    }).not.toThrow();

    expect(buffer.getBufferSize('s-overflow')).toBe(2);
  });

  it('polls events with afterCursor and limit', () => {
    const buffer = new BoundedEventBuffer(10);
    for (let i = 1; i <= 5; i++) {
      buffer.push('sess-poll', { type: `event-${i}`, seq: i, time: i, data: {} as any });
    }

    const pollAfter2 = buffer.poll({ sessionId: 'sess-poll', afterCursor: 'sess-poll:2' });
    expect(pollAfter2.envelopes).toHaveLength(3);
    expect(pollAfter2.envelopes.map((e) => e.seq)).toEqual([3, 4, 5]);

    const pollLimit = buffer.poll({ sessionId: 'sess-poll', afterCursor: 'sess-poll:1', limit: 2 });
    expect(pollLimit.envelopes).toHaveLength(2);
    expect(pollLimit.envelopes.map((e) => e.seq)).toEqual([2, 3]);
    expect(pollLimit.remainingCount).toBe(2);
  });

  it('feeds historical events with session+seq idempotency', () => {
    const buffer = new BoundedEventBuffer(10);
    const events = [
      { type: 'e1', seq: 1, time: 1, data: {} as any },
      { type: 'e2', seq: 2, time: 2, data: {} as any },
      { type: 'e3', seq: 3, time: 3, data: {} as any },
    ];

    const fed = buffer.feedHistoricalEvents('sess-feed', events);
    expect(fed).toBe(3);
    expect(buffer.getBufferSize('sess-feed')).toBe(3);

    // Replaying same events deduplicates by seq
    const fedAgain = buffer.feedHistoricalEvents('sess-feed', events);
    expect(fedAgain).toBe(3);
    expect(buffer.getBufferSize('sess-feed')).toBe(3);
  });
});
