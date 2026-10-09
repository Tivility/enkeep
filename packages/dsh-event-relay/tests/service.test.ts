import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import { SqliteReceiptStore } from '@enkeep/dsh-receipt-store-sqlite';
import { EventRelayService } from '../src/index.js';

describe('EventRelayService Unit Tests', () => {
  let ctx: Context;
  let receiptStore: SqliteReceiptStore;
  let relay: EventRelayService;

  beforeEach(() => {
    ctx = new Context();
    receiptStore = new SqliteReceiptStore({
      path: ':memory:',
      userId: 'test-user',
    });
    receiptStore.init();
    ctx.provide('receiptStore', receiptStore);

    relay = new EventRelayService(ctx, {
      maxBufferSize: 5,
      consumer: 'test-consumer',
    });
  });

  it('ingests events with deterministic session-scoped cursors', async () => {
    const mockSession = { id: SessionId('sess-1') } as any;

    const env1 = relay.ingest(mockSession, { type: 'user/message', seq: 1, time: 100, data: {} as any });
    const env2 = relay.ingest(mockSession, { type: 'turn/start', seq: 2, time: 200, data: { turn: 1 } });

    expect(env1.cursor).toBe('sess-1:1');
    expect(env2.cursor).toBe('sess-1:2');
    expect(relay.getBufferSize('sess-1')).toBe(2);

    const polled = await relay.poll({ sessionId: 'sess-1' });
    expect(polled.envelopes).toHaveLength(2);
    expect(polled.latestCursor).toBe('sess-1:2');
    expect(polled.oldestCursor).toBe('sess-1:1');
  });

  it('notifies subscribers on ingested event', () => {
    const mockSession = { id: SessionId('sess-sub') } as any;
    const subscriber = vi.fn();

    const unsubscribe = relay.subscribe(subscriber);

    relay.ingest(mockSession, { type: 'test/event', seq: 1, time: 1, data: {} as any });
    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(subscriber).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: 'sess-sub:1',
        sessionId: 'sess-sub',
      })
    );

    unsubscribe();
    relay.ingest(mockSession, { type: 'test/event', seq: 2, time: 2, data: {} as any });
    expect(subscriber).toHaveBeenCalledTimes(1);
  });

  it('acknowledges cursor and persists to receiptStore while trimming buffer', async () => {
    const mockSession = { id: SessionId('sess-ack') } as any;
    for (let i = 1; i <= 4; i++) {
      relay.ingest(mockSession, { type: `event-${i}`, seq: i, time: i, data: {} as any });
    }

    expect(relay.getBufferSize('sess-ack')).toBe(4);

    // Ack up to cursor 'sess-ack:2'
    await relay.ack('sess-ack', 'sess-ack:2');

    // Acknowledged cursor should be 'sess-ack:2'
    const acked = await relay.getAcknowledgedCursor('sess-ack');
    expect(acked).toBe('sess-ack:2');

    // receiptStore should hold the persisted cursor for this session and consumer
    const storedCursor = await receiptStore.getEventCursor('sess-ack', 'test-consumer');
    expect(storedCursor?.cursorValue).toBe('sess-ack:2');

    // Buffer should be trimmed (seqs 1 and 2 removed)
    expect(relay.getBufferSize('sess-ack')).toBe(2);
    const polled = await relay.poll({ sessionId: 'sess-ack' });
    expect(polled.envelopes.map((e) => e.cursor)).toEqual(['sess-ack:3', 'sess-ack:4']);
  });

  it('fails loud when receiptStore setEventCursor encounters error on ack and DOES NOT trim buffer', async () => {
    const mockSession = { id: SessionId('sess-err') } as any;
    relay.ingest(mockSession, { type: 'e1', seq: 1, time: 1, data: {} as any });
    relay.ingest(mockSession, { type: 'e2', seq: 2, time: 2, data: {} as any });

    expect(relay.getBufferSize('sess-err')).toBe(2);

    // Mock store to throw
    vi.spyOn(receiptStore, 'setEventCursor').mockRejectedValueOnce(
      new Error('Disk write error')
    );

    await expect(
      relay.ack('sess-err', 'sess-err:1')
    ).rejects.toThrow('Disk write error');

    // Buffer was NOT trimmed due to persistence failure
    expect(relay.getBufferSize('sess-err')).toBe(2);
  });

  describe('resolvePlatformTurnForSession', () => {
    it('resolves direct platform turn context by sessionId:intTurn and active turn', () => {
      const sessionId = 'sess-direct-001';
      relay.bindTurnContext(sessionId, { turnId: 'turn_direct_1', dshIntTurn: 1 });

      // 1. With exact turn number
      const res1 = relay.resolvePlatformTurnForSession(sessionId, 1);
      expect(res1).toEqual({ turnId: 'turn_direct_1', kind: 'direct' });

      // 2. Fallback to active turn context when intTurn omitted or unmatched
      const resActive = relay.resolvePlatformTurnForSession(sessionId);
      expect(resActive).toEqual({ turnId: 'turn_direct_1', kind: 'direct' });
    });

    it('resolves autonomous turn originTurnId', () => {
      const sessionId = 'sess-auto-001';
      const mockSession = { id: SessionId(sessionId) } as any;

      // 1. First platform turn creates a child subagent
      relay.bindTurnContext(sessionId, { turnId: 'turn_plat_origin', dshIntTurn: 1 });
      relay.ingest(mockSession, { type: 'turn/start', seq: 1, time: 100, data: { turn: 1 } });
      relay.ingest(mockSession, { type: 'subagent/catalog', seq: 2, time: 101, data: { childId: 'child-1' } });
      relay.ingest(mockSession, { type: 'turn/end', seq: 3, time: 102, data: { turn: 1, reason: { kind: 'completed' } } });

      // 2. Child completes -> autonomous continuation turn starts
      relay.ingest(mockSession, {
        type: 'agent/inbox/spliced',
        seq: 4,
        time: 103,
        data: {
          inserted: [
            {
              source: {
                kind: 'agent-message',
                form: 'relay',
                senderSessionId: 'child-1',
              },
              message: { content: 'Synthetic subagent completed task.' },
            },
          ],
        },
      });
      relay.ingest(mockSession, { type: 'turn/start', seq: 5, time: 104, data: { turn: 2 } });

      const res = relay.resolvePlatformTurnForSession(sessionId, 2);
      expect(res).toEqual({ turnId: 'turn_plat_origin', kind: 'autonomous-origin' });
    });

    it('resolves child session provenance recursively via parentSession', () => {
      const rootSessionId = 'sess-root-100';
      const childSessionId = 'sess-child-101';
      const grandChildSessionId = 'sess-grandchild-102';

      // Set up mock agents service in Cordis context
      const agentsMap = new Map<string, any>();
      agentsMap.set(rootSessionId, {
        id: rootSessionId,
        session: { header: { id: rootSessionId } },
      });
      agentsMap.set(childSessionId, {
        id: childSessionId,
        session: {
          header: {
            id: childSessionId,
            origin: 'subagent',
            parentSession: rootSessionId,
          },
        },
      });
      agentsMap.set(grandChildSessionId, {
        id: grandChildSessionId,
        session: {
          header: {
            id: grandChildSessionId,
            origin: 'subagent',
            parentSession: childSessionId,
          },
        },
      });

      ctx.provide('agents', {
        get: (id: string) => agentsMap.get(id),
      } as any);

      // Root session has an active turn
      relay.bindTurnContext(rootSessionId, { turnId: 'turn_root_active' });

      // Grandchild session should resolve to root turn with kind 'child-origin'
      const resGrandChild = relay.resolvePlatformTurnForSession(grandChildSessionId);
      expect(resGrandChild).toEqual({ turnId: 'turn_root_active', kind: 'child-origin' });

      // Child session should also resolve to root turn
      const resChild = relay.resolvePlatformTurnForSession(childSessionId);
      expect(resChild).toEqual({ turnId: 'turn_root_active', kind: 'child-origin' });
    });

    it('returns undefined for unknown session', () => {
      const res = relay.resolvePlatformTurnForSession('sess-unknown-999');
      expect(res).toBeUndefined();
    });
  });
});
