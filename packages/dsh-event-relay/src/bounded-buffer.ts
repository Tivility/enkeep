/**
 * Bounded Event Buffer with Session Isolation & Backpressure.
 *
 * Enforces per-session bounded capacity. Does NOT silently discard
 * unacknowledged events on overflow — throws RelayBackpressureError for backpressure.
 *
 * @module @enkeep/dsh-event-relay
 */

import type { PollEventsOptions, PollEventsResult, RelayEnvelope } from './types.js';
import { RelayBackpressureError } from './errors.js';
import type { SessionEvent } from '@deepseek-ai/dsh-session';

export function parseCursorSeq(cursor: string): number {
  if (cursor.includes(':')) {
    const parts = cursor.split(':');
    const last = parts[parts.length - 1];
    const seq = parseInt(last, 10);
    return Number.isNaN(seq) ? 0 : seq;
  }
  const seq = parseInt(cursor, 10);
  return Number.isNaN(seq) ? 0 : seq;
}

export class BoundedEventBuffer {
  readonly capacity: number;
  private readonly buffers = new Map<string, RelayEnvelope[]>();
  private readonly monotonicSeqs = new Map<string, number>();
  private readonly acknowledgedSeqs = new Map<string, number>();

  constructor(capacity = 1000) {
    if (capacity <= 0 || !Number.isSafeInteger(capacity)) {
      throw new RangeError(`Buffer capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
  }

  getBufferSize(sessionId?: string): number {
    if (sessionId) {
      return this.buffers.get(sessionId)?.length ?? 0;
    }
    let total = 0;
    for (const buf of this.buffers.values()) {
      total += buf.length;
    }
    return total;
  }

  getAcknowledgedSeq(sessionId: string): number {
    return this.acknowledgedSeqs.get(sessionId) ?? 0;
  }

  setAcknowledgedSeq(sessionId: string, seq: number): void {
    this.acknowledgedSeqs.set(sessionId, seq);
    this.trimSession(sessionId);
  }

  getLatestCursor(sessionId: string): string | null {
    const buf = this.buffers.get(sessionId);
    if (!buf || buf.length === 0) return null;
    return buf[buf.length - 1].cursor;
  }

  getOldestCursor(sessionId: string): string | null {
    const buf = this.buffers.get(sessionId);
    if (!buf || buf.length === 0) return null;
    return buf[0].cursor;
  }

  private trimSession(sessionId: string): void {
    const buf = this.buffers.get(sessionId);
    if (!buf || buf.length === 0) return;

    const acked = this.acknowledgedSeqs.get(sessionId) ?? 0;
    if (acked <= 0) return;

    const remaining = buf.filter((e) => e.seq > acked);
    if (remaining.length === 0) {
      this.buffers.delete(sessionId);
    } else {
      this.buffers.set(sessionId, remaining);
    }
  }

  push(sessionId: string, event: SessionEvent): RelayEnvelope {
    let buf = this.buffers.get(sessionId);
    if (!buf) {
      buf = [];
      this.buffers.set(sessionId, buf);
    }

    // Determine deterministic per-session seq
    let seq = typeof event.seq === 'number' ? event.seq : (this.monotonicSeqs.get(sessionId) ?? 0) + 1;
    const lastSeq = this.monotonicSeqs.get(sessionId) ?? 0;
    if (seq <= lastSeq && typeof event.seq !== 'number') {
      seq = lastSeq + 1;
    }
    this.monotonicSeqs.set(sessionId, Math.max(lastSeq, seq));

    const cursor = `${sessionId}:${seq}`;
    const envelope: RelayEnvelope = {
      cursor,
      seq,
      sessionId,
      event,
      timestamp: Date.now(),
    };

    // Check if envelope with this seq already exists in buffer (deduplicate)
    const existingIndex = buf.findIndex((e) => e.seq === seq);
    if (existingIndex >= 0) {
      buf[existingIndex] = envelope;
      return envelope;
    }

    // Attempt to trim acknowledged events before capacity check
    this.trimSession(sessionId);
    buf = this.buffers.get(sessionId)!;

    // Check capacity: fail loud with RelayBackpressureError if unacknowledged events exceed capacity
    if (buf.length >= this.capacity) {
      throw new RelayBackpressureError(sessionId, this.capacity, buf.length);
    }

    buf.push(envelope);
    buf.sort((a, b) => a.seq - b.seq);
    return envelope;
  }

  poll(options: PollEventsOptions): PollEventsResult {
    const { sessionId, afterCursor, limit } = options;
    const buf = this.buffers.get(sessionId) ?? [];

    const ackedSeq = this.acknowledgedSeqs.get(sessionId) ?? 0;
    const ackedCursor = ackedSeq > 0 ? `${sessionId}:${ackedSeq}` : null;

    let targetSeq = 0;
    if (afterCursor !== undefined) {
      targetSeq = parseCursorSeq(afterCursor);
    }

    const filtered = buf.filter((e) => e.seq > targetSeq);
    const maxLimit = (limit !== undefined && limit > 0) ? limit : this.capacity;
    const sliced = filtered.slice(0, maxLimit);
    const remainingCount = Math.max(0, filtered.length - sliced.length);

    return {
      sessionId,
      envelopes: sliced,
      latestCursor: this.getLatestCursor(sessionId),
      oldestCursor: this.getOldestCursor(sessionId),
      acknowledgedCursor: ackedCursor,
      remainingCount,
    };
  }

  ack(sessionId: string, cursor: string): number {
    const seq = parseCursorSeq(cursor);
    const prevAck = this.acknowledgedSeqs.get(sessionId) ?? 0;
    if (seq > prevAck) {
      this.acknowledgedSeqs.set(sessionId, seq);
    }
    this.trimSession(sessionId);
    return this.getBufferSize(sessionId);
  }

  feedHistoricalEvents(sessionId: string, events: readonly SessionEvent[]): number {
    let count = 0;
    for (const evt of events) {
      try {
        this.push(sessionId, evt);
        count++;
      } catch (err) {
        if (err instanceof RelayBackpressureError) {
          break;
        }
        throw err;
      }
    }
    return count;
  }

  clear(): void {
    this.buffers.clear();
    this.monotonicSeqs.clear();
    this.acknowledgedSeqs.clear();
  }
}
