import { describe, it, expect, beforeEach } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import { SqliteReceiptStore } from '@enkeep/dsh-receipt-store-sqlite';
import { EventRelayService } from '../src/index.js';

describe('Event Relay 2-Session Isolation with Same Sequence Numbers', () => {
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
      maxBufferSize: 100,
      consumer: 'test-consumer',
    });
  });

  it('handles two concurrent sessions having identical event seq numbers with zero crosstalk or cursor collision', async () => {
    const sessionA = { id: SessionId('session-AAA') } as any;
    const sessionB = { id: SessionId('session-BBB') } as any;

    // Ingest identical seqs for both sessions
    const envA1 = relay.ingest(sessionA, { type: 'turn/start', seq: 1, time: 100, data: { turn: 1 } });
    const envB1 = relay.ingest(sessionB, { type: 'turn/start', seq: 1, time: 105, data: { turn: 1 } });

    const envA2 = relay.ingest(sessionA, { type: 'agent/message', seq: 2, time: 200, data: { text: 'reply A' } });
    const envB2 = relay.ingest(sessionB, { type: 'agent/message', seq: 2, time: 205, data: { text: 'reply B' } });

    // Verify distinct cursor namespaces
    expect(envA1.cursor).toBe('session-AAA:1');
    expect(envB1.cursor).toBe('session-BBB:1');
    expect(envA2.cursor).toBe('session-AAA:2');
    expect(envB2.cursor).toBe('session-BBB:2');

    // Poll session A
    const pollA = await relay.poll({ sessionId: 'session-AAA' });
    expect(pollA.envelopes).toHaveLength(2);
    expect(pollA.envelopes.map((e) => e.cursor)).toEqual(['session-AAA:1', 'session-AAA:2']);
    expect(pollA.envelopes[1].event.data).toEqual({ text: 'reply A' });

    // Poll session B
    const pollB = await relay.poll({ sessionId: 'session-BBB' });
    expect(pollB.envelopes).toHaveLength(2);
    expect(pollB.envelopes.map((e) => e.cursor)).toEqual(['session-BBB:1', 'session-BBB:2']);
    expect(pollB.envelopes[1].event.data).toEqual({ text: 'reply B' });

    // Ack session A up to seq 2
    await relay.ack('session-AAA', 'session-AAA:2');

    // Verify session A is acknowledged and buffer trimmed
    const ackedA = await relay.getAcknowledgedCursor('session-AAA');
    expect(ackedA).toBe('session-AAA:2');
    expect(relay.getBufferSize('session-AAA')).toBe(0);

    // Verify session B is untouched and retains its own buffer and unacknowledged status
    const ackedB = await relay.getAcknowledgedCursor('session-BBB');
    expect(ackedB).toBeNull();
    expect(relay.getBufferSize('session-BBB')).toBe(2);

    const pollBAfter = await relay.poll({ sessionId: 'session-BBB' });
    expect(pollBAfter.envelopes).toHaveLength(2);
    expect(pollBAfter.envelopes.map((e) => e.cursor)).toEqual(['session-BBB:1', 'session-BBB:2']);

    // Check distinct persistence in receipt store
    const storedA = await receiptStore.getEventCursor('session-AAA', 'test-consumer');
    const storedB = await receiptStore.getEventCursor('session-BBB', 'test-consumer');
    expect(storedA?.cursorValue).toBe('session-AAA:2');
    expect(storedB).toBeNull();
  });
});
