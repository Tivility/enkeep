import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, existsSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import {
  SqliteReceiptStore,
  SeedImportMismatchError,
  ReceiptStoreError,
} from '../src/index.js';

describe('Seed Import Receipts Unit & Lifecycle Tests', () => {
  let dbPath: string;
  let store: SqliteReceiptStore;
  const testUserId = 'user-alice';
  const testChecksum = createHash('sha256').update('test-events-payload').digest('hex');

  beforeEach(() => {
    dbPath = join(tmpdir(), `receipt-store-seed-test-${randomUUID()}.db`);
    store = new SqliteReceiptStore({
      path: dbPath,
      userId: testUserId,
    });
    store.init();
  });

  afterEach(async () => {
    await store.close();
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

  describe('CRUD and Idempotency', () => {
    it('records a new seed import receipt and retrieves it by sessionId', async () => {
      const receipt = await store.recordSeedImportReceipt({
        sessionId: 'session-seed-001',
        checksum: testChecksum,
        canonicalBytes: 1024,
        eventCount: 42,
      });

      expect(receipt.userId).toBe(testUserId);
      expect(receipt.sessionId).toBe('session-seed-001');
      expect(receipt.algorithm).toBe('sha256-session-events-v1');
      expect(receipt.checksum).toBe(testChecksum);
      expect(receipt.canonicalBytes).toBe(1024);
      expect(receipt.eventCount).toBe(42);
      expect(receipt.importedAt).toBeDefined();

      const fetched = await store.getSeedImportReceipt('session-seed-001');
      expect(fetched).toEqual(receipt);
    });

    it('returns existing receipt idempotently when recording identical seed receipt', async () => {
      const first = await store.recordSeedImportReceipt({
        sessionId: 'session-seed-002',
        checksum: testChecksum,
        canonicalBytes: 2048,
        eventCount: 15,
      });

      // Second call with exact same parameters
      const second = await store.recordSeedImportReceipt({
        sessionId: 'session-seed-002',
        checksum: testChecksum,
        canonicalBytes: 2048,
        eventCount: 15,
      });

      expect(second).toEqual(first);
    });

    it('throws SeedImportMismatchError when checksum mismatches existing receipt', async () => {
      await store.recordSeedImportReceipt({
        sessionId: 'session-seed-003',
        checksum: testChecksum,
        canonicalBytes: 1000,
        eventCount: 10,
      });

      const differentChecksum = createHash('sha256').update('different-payload').digest('hex');

      await expect(
        store.recordSeedImportReceipt({
          sessionId: 'session-seed-003',
          checksum: differentChecksum,
          canonicalBytes: 1000,
          eventCount: 10,
        })
      ).rejects.toThrow(SeedImportMismatchError);
    });

    it('throws SeedImportMismatchError when canonicalBytes or eventCount mismatches existing receipt', async () => {
      await store.recordSeedImportReceipt({
        sessionId: 'session-seed-004',
        checksum: testChecksum,
        canonicalBytes: 1000,
        eventCount: 10,
      });

      // Mismatched canonicalBytes
      await expect(
        store.recordSeedImportReceipt({
          sessionId: 'session-seed-004',
          checksum: testChecksum,
          canonicalBytes: 2000,
          eventCount: 10,
        })
      ).rejects.toThrow(SeedImportMismatchError);

      // Mismatched eventCount
      await expect(
        store.recordSeedImportReceipt({
          sessionId: 'session-seed-004',
          checksum: testChecksum,
          canonicalBytes: 1000,
          eventCount: 99,
        })
      ).rejects.toThrow(SeedImportMismatchError);
    });
  });

  describe('Validation & Schema Constraints', () => {
    it('rejects empty or missing sessionId', async () => {
      await expect(
        store.recordSeedImportReceipt({
          sessionId: '',
          checksum: testChecksum,
          canonicalBytes: 10,
          eventCount: 1,
        })
      ).rejects.toThrow(ReceiptStoreError);
    });

    it('rejects invalid checksum format (not 64 lowercase hex)', async () => {
      // Too short
      await expect(
        store.recordSeedImportReceipt({
          sessionId: 'sess-invalid-cs',
          checksum: 'abc123',
          canonicalBytes: 10,
          eventCount: 1,
        })
      ).rejects.toThrow(ReceiptStoreError);

      // Non-hex characters
      await expect(
        store.recordSeedImportReceipt({
          sessionId: 'sess-invalid-cs',
          checksum: 'g'.repeat(64),
          canonicalBytes: 10,
          eventCount: 1,
        })
      ).rejects.toThrow(ReceiptStoreError);
    });

    it('rejects negative canonicalBytes or negative eventCount', async () => {
      await expect(
        store.recordSeedImportReceipt({
          sessionId: 'sess-neg-len',
          checksum: testChecksum,
          canonicalBytes: -1,
          eventCount: 1,
        })
      ).rejects.toThrow(ReceiptStoreError);

      await expect(
        store.recordSeedImportReceipt({
          sessionId: 'sess-neg-cnt',
          checksum: testChecksum,
          canonicalBytes: 10,
          eventCount: -5,
        })
      ).rejects.toThrow(ReceiptStoreError);
    });

    it('returns null for non-existent session receipt', async () => {
      const receipt = await store.getSeedImportReceipt('non-existent-session');
      expect(receipt).toBeNull();
    });
  });

  describe('Tenant & User Isolation', () => {
    it('isolates seed import receipts strictly between different userIds', async () => {
      await store.recordSeedImportReceipt({
        sessionId: 'shared-session-id',
        checksum: testChecksum,
        canonicalBytes: 500,
        eventCount: 5,
      });

      // Create store for Bob on same database
      const bobStore = new SqliteReceiptStore({
        path: dbPath,
        userId: 'user-bob',
      });
      bobStore.init();

      // Bob cannot see Alice's seed receipt
      const bobReceipt = await bobStore.getSeedImportReceipt('shared-session-id');
      expect(bobReceipt).toBeNull();

      // Bob can record his own seed receipt for the same sessionId
      const bobCreated = await bobStore.recordSeedImportReceipt({
        sessionId: 'shared-session-id',
        checksum: testChecksum,
        canonicalBytes: 500,
        eventCount: 5,
      });
      expect(bobCreated.userId).toBe('user-bob');

      // Alice's receipt remains bound to Alice
      const aliceReceipt = await store.getSeedImportReceipt('shared-session-id');
      expect(aliceReceipt?.userId).toBe('user-alice');

      await bobStore.close();
    });
  });

  describe('Persistence across Store Restart', () => {
    it('persists seed import receipts across store close and re-open', async () => {
      await store.recordSeedImportReceipt({
        sessionId: 'session-persist-01',
        checksum: testChecksum,
        canonicalBytes: 1234,
        eventCount: 20,
      });

      await store.close();

      const restartedStore = new SqliteReceiptStore({
        path: dbPath,
        userId: testUserId,
      });
      restartedStore.init();

      const refetched = await restartedStore.getSeedImportReceipt('session-persist-01');
      expect(refetched).not.toBeNull();
      expect(refetched?.sessionId).toBe('session-persist-01');
      expect(refetched?.checksum).toBe(testChecksum);
      expect(refetched?.canonicalBytes).toBe(1234);
      expect(refetched?.eventCount).toBe(20);

      await restartedStore.close();
    });
  });
});
