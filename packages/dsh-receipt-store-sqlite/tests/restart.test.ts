import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  SqliteReceiptStore,
  DuplicateDeliveryIdError,
} from '../src/index.js';

describe('SqliteReceiptStore Restart & Idempotency Tests', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `receipt-store-test-${randomUUID()}.db`);
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
        rmSync(`${dbPath}-wal`, { force: true });
        rmSync(`${dbPath}-shm`, { force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  });

  it('persists data across restart and maintains per-session records', async () => {
    // Phase 1: First startup
    const store1 = new SqliteReceiptStore({
      path: dbPath,
      userId: 'tenant-1',
    });
    store1.init();

    await store1.recordReceipt({
      deliveryId: 'del-persistent-1',
      messageId: 'msg-1',
      routeId: 'route-1',
      status: 'pending',
    });

    await store1.recordSessionSource({
      routeId: 'route-1',
      sourceType: 'feishu',
      sourceId: 'chat-999',
      metadata: { key: 'value1' },
    });

    await store1.setEventCursor('session-alpha', 'session-alpha:15', 'consumer-main');

    await store1.close();

    // Phase 2: Restart (new instance against same file)
    const store2 = new SqliteReceiptStore({
      path: dbPath,
      userId: 'tenant-1',
    });
    store2.init();

    // Verify receipt was restored
    const receipt = await store2.getReceiptByDeliveryId('del-persistent-1');
    expect(receipt).not.toBeNull();
    expect(receipt?.deliveryId).toBe('del-persistent-1');
    expect(receipt?.messageId).toBe('msg-1');
    expect(receipt?.status).toBe('pending');

    // Verify session source was restored
    const source = await store2.getSessionSource('feishu', 'chat-999');
    expect(source).not.toBeNull();
    expect(source?.sourceId).toBe('chat-999');
    expect(source?.metadata).toEqual({ key: 'value1' });

    // Verify cursor was restored with per-session identity
    const cursor = await store2.getEventCursor('session-alpha', 'consumer-main');
    expect(cursor).not.toBeNull();
    expect(cursor?.sessionId).toBe('session-alpha');
    expect(cursor?.consumer).toBe('consumer-main');
    expect(cursor?.cursorValue).toBe('session-alpha:15');

    // Test recoverAfterRestart
    const recovery = await store2.recoverAfterRestart();
    expect(recovery.pendingReceiptsRecovered).toBe(1);

    // Test idempotency: inserting already-existing deliveryId throws DuplicateDeliveryIdError
    await expect(
      store2.recordReceipt({
        deliveryId: 'del-persistent-1',
        messageId: 'msg-different',
      })
    ).rejects.toThrow(DuplicateDeliveryIdError);

    await store2.close();
  });
});
