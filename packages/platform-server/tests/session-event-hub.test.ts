/**
 * RuntimeSessionEventHub: per-user fan-out of the runtimes' live DSH session events and chunks
 * (synthetic, offline; in-memory transports).
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { RuntimeSessionEventHub, type HubSessionEvent, type HubTurnChunk, type HubRuntimeChange } from '../src/runtime/session-event-hub.js';

const ALICE = 'user-alice';
const BOB = 'user-bob';
const DSH_A = 'ses_dddd0000000000000000000000000001';

function collect(hub: RuntimeSessionEventHub, userId: string) {
  const events: HubSessionEvent[] = [];
  const chunks: HubTurnChunk[] = [];
  const changes: HubRuntimeChange[] = [];
  const off = hub.subscribe(userId, {
    sessionEvent: (e) => events.push(e),
    turnChunk: (c) => chunks.push(c),
    runtimeChanged: (c) => changes.push(c),
  });
  return { events, chunks, changes, off };
}

describe('RuntimeSessionEventHub', () => {
  it('reads daemon stream frames of a transport and fans them out to the owner only', () => {
    const hub = new RuntimeSessionEventHub();
    const transport = new EventEmitter();
    const alice = collect(hub, ALICE);
    const bob = collect(hub, BOB);
    hub.attachTransport(ALICE, transport, { slot: 'runtime:alice' });
    expect(alice.changes).toEqual([{ userId: ALICE, slot: 'runtime:alice', state: 'attached' }]);

    transport.emit('stream', { type: 'event', event: 'turn/event', sessionId: DSH_A, turnId: 'turn_test_0001', seq: 7, timestamp: 1000, sessionEvent: { seq: 7, type: 'user/message', time: 999, data: {} } });
    transport.emit('stream', { type: 'event', event: 'turn/chunk', sessionId: DSH_A, turnId: '', timestamp: 1001, chunk: { type: 'text-delta', index: 0, text: 'hi' } });
    transport.emit('stream', { type: 'event', event: 'approval/asked', sessionId: DSH_A });
    transport.emit('connected');

    expect(alice.events).toEqual([
      { userId: ALICE, dshSessionId: DSH_A, seq: 7, turnId: 'turn_test_0001', timestamp: 1000, event: { seq: 7, type: 'user/message', time: 999, data: {} } },
    ]);
    expect(alice.chunks).toEqual([{ userId: ALICE, dshSessionId: DSH_A, timestamp: 1001, chunk: { type: 'text-delta', index: 0, text: 'hi' } }]);
    expect(alice.changes.at(-1)).toEqual({ userId: ALICE, slot: 'runtime:alice', state: 'connected' });
    expect(bob.events).toEqual([]);
    expect(hub.lastSeq(ALICE, DSH_A)).toBe(7);
    expect(hub.lastActivityAt(ALICE, DSH_A)).toBe(1000);
    expect(hub.lastSeq(BOB, DSH_A)).toBeUndefined();

    hub.noteSeq(ALICE, DSH_A, 3);
    expect(hub.lastSeq(ALICE, DSH_A)).toBe(7);
    hub.noteSeq(ALICE, DSH_A, 12);
    expect(hub.lastSeq(ALICE, DSH_A)).toBe(12);

    alice.off();
    transport.emit('stream', { type: 'event', event: 'turn/event', sessionId: DSH_A, seq: 13, sessionEvent: { seq: 13, type: 'turn/end' } });
    expect(alice.events).toHaveLength(1);
    hub.dispose();
  });

  it('uses onSessionEvent / onTurnChunk when the transport has them, replaces a slot and detaches', () => {
    const hub = new RuntimeSessionEventHub();
    let sessionListener: ((e: any) => void) | undefined;
    const offSession = vi.fn();
    const offChunk = vi.fn();
    const first = Object.assign(new EventEmitter(), {
      onSessionEvent: (l: (e: any) => void) => {
        sessionListener = l;
        return offSession;
      },
      onTurnChunk: () => offChunk,
    });
    const alice = collect(hub, ALICE);
    hub.attachTransport(ALICE, first, { slot: 'runtime:alice' });
    sessionListener!({ sessionId: DSH_A, seq: 2, timestamp: 5, sessionEvent: { seq: 2, type: 'assistant/message', data: {} } });
    expect(alice.events.map((e) => e.seq)).toEqual([2]);
    // The stream fallback is not used for such transports.
    first.emit('stream', { event: 'turn/event', sessionId: DSH_A, seq: 3, sessionEvent: { seq: 3, type: 'turn/end' } });
    expect(alice.events).toHaveLength(1);

    const second = new EventEmitter();
    hub.attachTransport(ALICE, second, { slot: 'runtime:alice' });
    expect(offSession).toHaveBeenCalledTimes(1);
    expect(offChunk).toHaveBeenCalledTimes(1);
    sessionListener!({ sessionId: DSH_A, seq: 4, timestamp: 6, sessionEvent: { seq: 4, type: 'turn/end' } });
    expect(alice.events).toHaveLength(1);
    expect(hub.hasTransport(ALICE, 'runtime:alice')).toBe(true);

    hub.detachTransport(ALICE, { slot: 'runtime:alice' });
    expect(hub.hasTransport(ALICE)).toBe(false);
    expect(alice.changes.at(-1)).toEqual({ userId: ALICE, slot: 'runtime:alice', state: 'detached' });
    second.emit('stream', { event: 'turn/event', sessionId: DSH_A, seq: 5, sessionEvent: { seq: 5, type: 'turn/end' } });
    expect(alice.events).toHaveLength(1);
    expect(second.listenerCount('stream')).toBe(0);
    expect(second.listenerCount('connected')).toBe(0);
    hub.dispose();
  });
});
