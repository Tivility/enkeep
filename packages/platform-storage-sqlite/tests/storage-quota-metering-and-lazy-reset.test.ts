import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  SqlitePlatformOperationsStorage,
  SqliteMigrationRunner,
  createSqliteOperationsStorage,
  BUILTIN_MIGRATIONS,
} from '../src/index.js';
import {
  createPlatformOperations,
  PlatformOperationsService,
  QuotaExceededError,
} from '@enkeep/platform-operations';

describe('Storage Quota Metering & Lazy Window Reset (SQLite)', () => {
  let db: DatabaseSync;
  let operationsStorage: SqlitePlatformOperationsStorage;
  let operationsService: PlatformOperationsService;

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    const runner = new SqliteMigrationRunner(db);
    await runner.migrate(BUILTIN_MIGRATIONS);

    // Apply migration 012 column reset_interval if not present
    try {
      db.exec("ALTER TABLE quota_limits ADD COLUMN reset_interval TEXT DEFAULT 'none';");
    } catch {
      // ignore
    }

    // Seed test users
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
      VALUES
        ('user_alice', 'alice', 'hash_a', 'user', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('user_bob', 'bob', 'hash_b', 'user', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run();

    operationsStorage = createSqliteOperationsStorage(db);
    operationsService = createPlatformOperations({
      storage: operationsStorage,
    });
  });

  afterEach(async () => {
    await operationsStorage.close();
    try {
      db.close();
    } catch {
      // ignore
    }
  });

  describe('1. storage_bytes Adjust & Decrement API', () => {
    it('adjusts usage positively and decrements usage atomically under transaction', async () => {
      const aliceQuota = operationsStorage.forTenant('user_alice').quota;

      // Set storage_bytes limit to 10 MB (10485760 bytes)
      await aliceQuota.setLimit({ resource: 'storage_bytes', limit: 10485760 });

      // Initial usage is 0
      const initial = await aliceQuota.getUsage('storage_bytes');
      expect(initial.used).toBe(0);
      expect(initial.remaining).toBe(10485760);

      // Adjust positive: +5000 bytes
      const afterAdd = await aliceQuota.adjustUsage!({ resource: 'storage_bytes', delta: 5000 });
      expect(afterAdd.used).toBe(5000);
      expect(afterAdd.remaining).toBe(10485760 - 5000);

      // Adjust positive: +3000 bytes
      const afterAdd2 = await aliceQuota.adjustUsage!({ resource: 'storage_bytes', delta: 3000 });
      expect(afterAdd2.used).toBe(8000);
      expect(afterAdd2.remaining).toBe(10485760 - 8000);

      // Decrement usage: -2000 bytes
      const afterDec = await aliceQuota.decrementUsage!('storage_bytes', 2000);
      expect(afterDec.used).toBe(6000);
      expect(afterDec.remaining).toBe(10485760 - 6000);

      // Decrement more than current usage: clamps to 0
      const afterClamp = await aliceQuota.decrementUsage!('storage_bytes', 10000);
      expect(afterClamp.used).toBe(0);
      expect(afterClamp.remaining).toBe(10485760);
    });

    it('rejects positive adjustment when quota is exceeded', async () => {
      const aliceQuota = operationsStorage.forTenant('user_alice').quota;
      await aliceQuota.setLimit({ resource: 'storage_bytes', limit: 1000 });

      await expect(
        aliceQuota.adjustUsage!({ resource: 'storage_bytes', delta: 1500 })
      ).rejects.toThrow(QuotaExceededError);

      const usage = await aliceQuota.getUsage('storage_bytes');
      expect(usage.used).toBe(0);
    });

    it('sets baseline usage from volume scan accurately', async () => {
      const aliceQuota = operationsStorage.forTenant('user_alice').quota;
      await aliceQuota.setLimit({ resource: 'storage_bytes', limit: 100000 });

      const baseline = await aliceQuota.setBaselineUsage!('storage_bytes', 42000);
      expect(baseline.used).toBe(42000);
      expect(baseline.remaining).toBe(100000 - 42000);

      const readback = await aliceQuota.getUsage('storage_bytes');
      expect(readback.used).toBe(42000);
    });

    it('guarantees tenant isolation for storage_bytes adjustments', async () => {
      const aliceQuota = operationsStorage.forTenant('user_alice').quota;
      const bobQuota = operationsStorage.forTenant('user_bob').quota;

      await aliceQuota.setLimit({ resource: 'storage_bytes', limit: 10000 });
      await bobQuota.setLimit({ resource: 'storage_bytes', limit: 5000 });

      await aliceQuota.adjustUsage!({ resource: 'storage_bytes', delta: 7000 });
      await bobQuota.adjustUsage!({ resource: 'storage_bytes', delta: 2000 });

      const aliceUsage = await aliceQuota.getUsage('storage_bytes');
      const bobUsage = await bobQuota.getUsage('storage_bytes');

      expect(aliceUsage.used).toBe(7000);
      expect(bobUsage.used).toBe(2000);
    });
  });

  describe('2. Lazy Window Reset (resetAt <= now under BEGIN IMMEDIATE)', () => {
    it('lazily resets usage to 0 and advances next resetAt for daily interval', async () => {
      const aliceQuota = operationsStorage.forTenant('user_alice').quota;

      const pastResetAt = new Date(Date.now() - 3600 * 1000).toISOString(); // 1 hour ago
      await aliceQuota.setLimit({
        resource: 'tokens',
        limit: 10000,
        resetAt: pastResetAt,
        resetInterval: 'daily',
      });

      // Simulate some existing usage prior to reset check
      db.prepare(`
        INSERT INTO quota_usage (user_id, resource, used_amount, updated_at)
        VALUES ('user_alice', 'tokens', 5000, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id, resource) DO UPDATE SET used_amount = 5000
      `).run();

      // Query usage: triggers lazy reset
      const usage = await aliceQuota.getUsage('tokens');

      // Usage must be reset to 0
      expect(usage.used).toBe(0);
      expect(usage.remaining).toBe(10000);

      // resetAt must be advanced into the future
      expect(usage.resetAt).toBeDefined();
      expect(new Date(usage.resetAt!).getTime()).toBeGreaterThan(Date.now());

      // Limit in DB must also have new reset_at
      const updatedLimit = await aliceQuota.getLimit('tokens');
      expect(updatedLimit?.resetAt).toBe(usage.resetAt);
    });

    it('lazily resets usage and expires uncommitted reservations created before resetAt', async () => {
      const aliceQuota = operationsStorage.forTenant('user_alice').quota;

      const pastResetAt = new Date(Date.now() - 10000).toISOString(); // 10s ago

      // Create a reservation prior to reset
      const res = await aliceQuota.setLimit({
        resource: 'messages',
        limit: 100,
        resetAt: new Date(Date.now() + 3600000).toISOString(),
      });

      const reservation = await aliceQuota.reserve({
        resource: 'messages',
        amount: 20,
        ttlSeconds: 600,
      });

      expect(reservation.status).toBe('reserved');

      // Now set resetAt to past
      await aliceQuota.setLimit({
        resource: 'messages',
        limit: 100,
        resetAt: pastResetAt,
        resetInterval: 'none',
      });

      // Query usage: triggers lazy reset
      const usage = await aliceQuota.getUsage('messages');
      expect(usage.used).toBe(0);
      expect(usage.reserved).toBe(0);

      // Reservation must be expired
      const readRes = await aliceQuota.findReservationById(reservation.id);
      expect(readRes?.status).toBe('expired');
    });

    it('advances monthly reset interval accurately across month boundary', async () => {
      const aliceQuota = operationsStorage.forTenant('user_alice').quota;

      const pastResetAt = new Date(Date.now() - 86400 * 1000).toISOString(); // 1 day ago
      await aliceQuota.setLimit({
        resource: 'turns',
        limit: 50,
        resetAt: pastResetAt,
        resetInterval: 'monthly',
      });

      // Set initial usage
      db.prepare(`
        INSERT INTO quota_usage (user_id, resource, used_amount, updated_at)
        VALUES ('user_alice', 'turns', 30, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id, resource) DO UPDATE SET used_amount = 30
      `).run();

      const usage = await aliceQuota.getUsage('turns');
      expect(usage.used).toBe(0);
      expect(usage.remaining).toBe(50);
      expect(new Date(usage.resetAt!).getTime()).toBeGreaterThan(Date.now());
    });

    it('supports custom windowSeconds / resetPeriodSeconds lazy advance', async () => {
      const aliceQuota = operationsStorage.forTenant('user_alice').quota;

      const pastResetAt = new Date(Date.now() - 5000).toISOString(); // 5s ago
      await aliceQuota.setLimit({
        resource: 'api_calls',
        limit: 500,
        windowSeconds: 300, // 5 minute window
        resetAt: pastResetAt,
      });

      // Set initial usage
      db.prepare(`
        INSERT INTO quota_usage (user_id, resource, used_amount, updated_at)
        VALUES ('user_alice', 'api_calls', 150, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id, resource) DO UPDATE SET used_amount = 150
      `).run();

      const usage = await aliceQuota.getUsage('api_calls');
      expect(usage.used).toBe(0);
      expect(usage.remaining).toBe(500);
      expect(new Date(usage.resetAt!).getTime()).toBeGreaterThan(Date.now());
    });

    it('fails closed with DATABASE_CORRUPTED when stored reset_at is invalid or corrupted (never falls back to now silently)', async () => {
      const aliceQuota = operationsStorage.forTenant('user_alice').quota;

      // Manually inject a corrupted invalid date string directly into the database
      db.prepare(`
        INSERT INTO quota_limits (user_id, resource, limit_amount, window_seconds, reset_at, reset_interval, updated_at)
        VALUES ('user_alice', 'tokens', 1000, 3600, 'NOT_A_VALID_ISO_TIMESTAMP', 'daily', CURRENT_TIMESTAMP)
        ON CONFLICT (user_id, resource) DO UPDATE SET reset_at = 'NOT_A_VALID_ISO_TIMESTAMP'
      `).run();

      // Querying usage MUST fail closed with DATABASE_CORRUPTED (500)
      await expect(aliceQuota.getUsage('tokens')).rejects.toThrow(/DATABASE_CORRUPTED|Corrupted reset_at timestamp/);
    });

    it('deterministically advances month boundaries without skipping months (e.g. Jan 31 -> Feb 28)', async () => {
      const { advanceUtcMonth } = await import('../src/repos/quota-ledger-repo.js');

      // Non-leap year: Jan 31 -> Feb 28
      const jan31 = new Date(Date.UTC(2025, 0, 31, 12, 0, 0));
      const febResult = advanceUtcMonth(jan31);
      expect(febResult.toISOString()).toBe(new Date(Date.UTC(2025, 1, 28, 12, 0, 0)).toISOString());

      // Leap year: Jan 31 2024 -> Feb 29 2024
      const jan31Leap = new Date(Date.UTC(2024, 0, 31, 12, 0, 0));
      const febLeapResult = advanceUtcMonth(jan31Leap);
      expect(febLeapResult.toISOString()).toBe(new Date(Date.UTC(2024, 1, 29, 12, 0, 0)).toISOString());

      // March 31 -> April 30
      const mar31 = new Date(Date.UTC(2025, 2, 31, 0, 0, 0));
      const aprResult = advanceUtcMonth(mar31);
      expect(aprResult.toISOString()).toBe(new Date(Date.UTC(2025, 3, 30, 0, 0, 0)).toISOString());

      // Dec 31 -> Jan 31 next year
      const dec31 = new Date(Date.UTC(2025, 11, 31, 23, 59, 59));
      const janNextResult = advanceUtcMonth(dec31);
      expect(janNextResult.toISOString()).toBe(new Date(Date.UTC(2026, 0, 31, 23, 59, 59)).toISOString());
    });
  });

  describe('3. Concurrency Safety', () => {
    it('handles high concurrency adjustments without over-allocating quota limit', async () => {
      const aliceQuota = operationsStorage.forTenant('user_alice').quota;
      const limitAmount = 100;
      await aliceQuota.setLimit({ resource: 'storage_bytes', limit: limitAmount });

      // Run 30 concurrent attempts to adjust by 10 bytes (total 300 > 100)
      const tasks = Array.from({ length: 30 }, () =>
        aliceQuota.adjustUsage!({ resource: 'storage_bytes', delta: 10 })
          .then(() => true)
          .catch(() => false)
      );

      const results = await Promise.all(tasks);
      const successCount = results.filter((r) => r === true).length;
      const failCount = results.filter((r) => r === false).length;

      expect(successCount).toBe(10); // Exactly 10 * 10 = 100
      expect(failCount).toBe(20);

      const finalUsage = await aliceQuota.getUsage('storage_bytes');
      expect(finalUsage.used).toBe(100);
      expect(finalUsage.remaining).toBe(0);
    });
  });

  describe('4. Unlimited Quota (-1) & Migration M35', () => {
    it('reserve and commit with limit -1 never throws and reports unlimited remaining (-1)', async () => {
      const aliceQuota = operationsStorage.forTenant('user_alice').quota;
      await aliceQuota.setLimit({ resource: 'tokens', limit: -1 });
      await aliceQuota.setLimit({ resource: 'turns', limit: -1 });
      await aliceQuota.setLimit({ resource: 'messages', limit: -1 });

      const usage = await aliceQuota.getUsage('tokens');
      expect(usage.limit).toBe(-1);
      expect(usage.remaining).toBe(-1);
      expect(usage.allowed).toBe(true);

      // Reserve large amount on unlimited
      const res = await aliceQuota.reserve({ resource: 'tokens', amount: 9999999 });
      expect(res.amount).toBe(9999999);

      // Commit large amount
      const committed = await aliceQuota.commit({ reservationId: res.id, actualAmount: 9999999 });
      expect(committed.usage.used).toBe(9999999);
      expect(committed.usage.limit).toBe(-1);
      expect(committed.usage.remaining).toBe(-1);
      expect(committed.usage.allowed).toBe(true);
    });

    it('migration M35 converts all existing quota_limits rows to limit_amount = -1', async () => {
      // Seed positive quota limits
      db.prepare("INSERT OR REPLACE INTO quota_limits (user_id, resource, limit_amount) VALUES ('user_bob', 'tokens', 50000)").run();
      db.prepare("INSERT OR REPLACE INTO quota_limits (user_id, resource, limit_amount) VALUES ('user_bob', 'messages', 200)").run();

      const before = db.prepare("SELECT limit_amount FROM quota_limits WHERE user_id = 'user_bob'").all() as Array<{ limit_amount: number }>;
      expect(before.some((r) => r.limit_amount > 0)).toBe(true);

      const { MIGRATION_035_QUOTA_DEFAULT_UNLIMITED_SQL } = await import('../src/schema/migrations.js');
      db.exec(MIGRATION_035_QUOTA_DEFAULT_UNLIMITED_SQL);

      const after = db.prepare("SELECT limit_amount FROM quota_limits").all() as Array<{ limit_amount: number }>;
      expect(after.length).toBeGreaterThan(0);
      for (const row of after) {
        expect(row.limit_amount).toBe(-1);
      }
    });
  });
});
