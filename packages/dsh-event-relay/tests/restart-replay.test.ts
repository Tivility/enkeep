import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import { SqliteReceiptStore } from '@enkeep/dsh-receipt-store-sqlite';
import { EventRelayService } from '../src/index.js';

describe('Event Relay Restart Recovery & Replay Idempotency', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `relay-restart-test-${randomUUID()}.db`);
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
        rmSync(`${dbPath}-wal`, { force: true });
        rmSync(`${dbPath}-shm`, { force: true });
      } catch {
        // ignore
      }
    }
  });

  it('restores acknowledged cursor across restart, deduplicates replay by session+seq, and skips acknowledged events', async () => {
    const session = { id: SessionId('sess-restart-1') } as any;

    // --- Phase 1: Before restart ---
    const ctx1 = new Context();
    const store1 = new SqliteReceiptStore({ path: dbPath, userId: 'tenant-1' });
    store1.init();
    ctx1.provide('receiptStore', store1);

    const relay1 = new EventRelayService(ctx1, { maxBufferSize: 100, consumer: 'stream-consumer' });

    // Ingest events 1 to 5
    for (let i = 1; i <= 5; i++) {
      relay1.ingest(session, { type: `event-${i}`, seq: i, time: i * 100, data: {} as any });
    }

    // Ack up to event 2
    await relay1.ack('sess-restart-1', 'sess-restart-1:2');

    await store1.close();

    // --- Phase 2: Process Restart ---
    const ctx2 = new Context();
    const store2 = new SqliteReceiptStore({ path: dbPath, userId: 'tenant-1' });
    store2.init();
    ctx2.provide('receiptStore', store2);

    const relay2 = new EventRelayService(ctx2, { maxBufferSize: 100, consumer: 'stream-consumer' });

    // Replay historical session events (including duplicate entries to test idempotency)
    const historicalSessionEvents = [
      { type: 'event-1', seq: 1, time: 100, data: {} as any },
      { type: 'event-2', seq: 2, time: 200, data: {} as any },
      { type: 'event-3', seq: 3, time: 300, data: {} as any },
      { type: 'event-3', seq: 3, time: 300, data: {} as any }, // duplicate seq 3
      { type: 'event-4', seq: 4, time: 400, data: {} as any },
      { type: 'event-5', seq: 5, time: 500, data: {} as any },
    ];

    // Feed historical events into restarted relay
    const fedCount = relay2.feedHistoricalEvents(session, historicalSessionEvents);
    expect(fedCount).toBe(6);

    // Query unacknowledged events after restart
    const pollResult = await relay2.poll({ sessionId: 'sess-restart-1' });

    // Acknowledged cursor was restored from receiptStore
    expect(pollResult.acknowledgedCursor).toBe('sess-restart-1:2');

    // Only unacknowledged events (3, 4, 5) remain; events 1 & 2 skipped; duplicate seq 3 deduplicated!
    expect(pollResult.envelopes.map((e) => e.cursor)).toEqual([
      'sess-restart-1:3',
      'sess-restart-1:4',
      'sess-restart-1:5',
    ]);

    await store2.close();
  });
});
