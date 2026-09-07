import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import { SqliteReceiptStore } from '@enkeep/dsh-receipt-store-sqlite';
import { InboundService } from '../src/index.js';

describe('InboundService Persistent Restart & Idempotency', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `inbound-receipt-test-${randomUUID()}.db`);
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

  it('survives process restart and deduplicates previously processed deliveryId', async () => {
    const mockFollowup1 = vi.fn();
    const mockAgent1 = {
      id: SessionId('session-p1'),
      followup: mockFollowup1,
      cancel: vi.fn(),
    };

    // --- Phase 1: Before restart ---
    const ctx1 = new Context();
    const store1 = new SqliteReceiptStore({ path: dbPath, userId: 'user-1' });
    store1.init();
    ctx1.provide('receiptStore', store1);
    ctx1.provide('agents', {
      get: (id: SessionId) => (id === 'session-p1' ? mockAgent1 : undefined),
    } as any);

    const inbound1 = new InboundService(ctx1);

    const res1 = await inbound1.handleFollowup({
      deliveryId: 'del-cross-restart-1',
      sessionId: 'session-p1',
      message: 'Persisted message 1',
    });

    expect(res1.success).toBe(true);
    expect(res1.duplicate).toBe(false);
    expect(mockFollowup1).toHaveBeenCalledTimes(1);

    await store1.close();

    // --- Phase 2: After restart (new store instance, new context, new inbound service) ---
    const mockFollowup2 = vi.fn();
    const mockAgent2 = {
      id: SessionId('session-p1'),
      followup: mockFollowup2,
      cancel: vi.fn(),
    };

    const ctx2 = new Context();
    const store2 = new SqliteReceiptStore({ path: dbPath, userId: 'user-1' });
    store2.init();
    ctx2.provide('receiptStore', store2);
    ctx2.provide('agents', {
      get: (id: SessionId) => (id === 'session-p1' ? mockAgent2 : undefined),
    } as any);

    const inbound2 = new InboundService(ctx2);

    // Re-send same deliveryId
    const res2 = await inbound2.handleFollowup({
      deliveryId: 'del-cross-restart-1',
      sessionId: 'session-p1',
      message: 'Persisted message 1 (retry)',
    });

    expect(res2.success).toBe(true);
    expect(res2.deliveryId).toBe('del-cross-restart-1');
    expect(res2.messageId).toBe(res1.messageId);
    expect(res2.status).toBe('delivered');
    expect(res2.duplicate).toBe(true);

    // Verify agent in phase 2 was NOT invoked due to idempotency deduplication
    expect(mockFollowup2).not.toHaveBeenCalled();

    await store2.close();
  });
});
