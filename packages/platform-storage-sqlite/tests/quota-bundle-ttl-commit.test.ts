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
  ReservationSettledError,
} from '@enkeep/platform-operations';

describe('D1 Quota Bundle TTL & Safe Commit Persistence Tests', () => {
  let db: DatabaseSync;
  let operationsStorage: SqlitePlatformOperationsStorage;
  let operationsService: PlatformOperationsService;

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    const runner = new SqliteMigrationRunner(db);
    await runner.migrate(BUILTIN_MIGRATIONS);

    // Apply forward v10 schema for quota bundle operations
    db.exec(`
      CREATE TABLE IF NOT EXISTS quota_bundles (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        delivery_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved', 'committed', 'released', 'expired')),
        turns_amount INTEGER NOT NULL DEFAULT 1,
        messages_amount INTEGER NOT NULL DEFAULT 1,
        tokens_amount INTEGER NOT NULL DEFAULT 0,
        is_estimate_tokens INTEGER NOT NULL DEFAULT 1,
        turns_committed INTEGER,
        messages_committed INTEGER,
        tokens_committed INTEGER,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        settled_at TEXT,
        metadata TEXT,
        UNIQUE(user_id, delivery_id)
      );
      CREATE INDEX IF NOT EXISTS idx_quota_bundles_user_status ON quota_bundles(user_id, status);
      CREATE INDEX IF NOT EXISTS idx_quota_bundles_delivery ON quota_bundles(user_id, delivery_id);
      CREATE INDEX IF NOT EXISTS idx_quota_bundles_expires_at ON quota_bundles(expires_at);

      ALTER TABLE quota_reservations ADD COLUMN bundle_id TEXT REFERENCES quota_bundles(id) ON DELETE SET NULL;
      ALTER TABLE quota_reservations ADD COLUMN delivery_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_quota_reservations_bundle_id ON quota_reservations(user_id, bundle_id);
      CREATE INDEX IF NOT EXISTS idx_quota_reservations_delivery_id ON quota_reservations(user_id, delivery_id);

      ALTER TABLE quota_limits ADD COLUMN reset_interval TEXT DEFAULT 'none';
    `);

    // Create test user fixtures
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
      VALUES
        ('user_alice', 'alice', 'hash_a', 'user', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
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

  it('defaults reserveBundle TTL to 2100 seconds when ttlSeconds is omitted', async () => {
    const quotaRepo = operationsStorage.forTenant('user_alice').quota;
    await quotaRepo.setLimit({ resource: 'turns', limit: 10 });
    await quotaRepo.setLimit({ resource: 'messages', limit: 10 });
    await quotaRepo.setLimit({ resource: 'tokens', limit: 5000 });

    const beforeIso = new Date().toISOString();
    const bundle = await quotaRepo.reserveBundle({
      sessionId: 'ses_00000000000000000000000000000001',
      deliveryId: 'deliv_00000000000000000000000000000001',
      turns: 1,
      messages: 1,
      tokens: 150,
      isEstimateTokens: true,
    });

    const expiresAtMs = new Date(bundle.expiresAt).getTime();
    const nowMs = Date.now();
    // Delta should be approximately 2100s (with a small 5s tolerance)
    const deltaSeconds = Math.round((expiresAtMs - nowMs) / 1000);
    expect(deltaSeconds).toBeGreaterThanOrEqual(2095);
    expect(deltaSeconds).toBeLessThanOrEqual(2105);
  });

  it('allows commit on a reserved bundle whose expiresAt is in the past, without lazy expiration', async () => {
    const quotaRepo = operationsStorage.forTenant('user_alice').quota;
    await quotaRepo.setLimit({ resource: 'turns', limit: 10 });
    await quotaRepo.setLimit({ resource: 'messages', limit: 10 });
    await quotaRepo.setLimit({ resource: 'tokens', limit: 5000 });

    const bundle = await quotaRepo.reserveBundle({
      sessionId: 'ses_00000000000000000000000000000002',
      deliveryId: 'deliv_00000000000000000000000000000002',
      turns: 1,
      messages: 1,
      tokens: 200,
      isEstimateTokens: true,
      ttlSeconds: 60,
    });

    // Artificially age the bundle to simulate a 26-minute task where expiresAt passed
    const pastIso = new Date(Date.now() - 100000).toISOString();
    db.prepare('UPDATE quota_bundles SET expires_at = ? WHERE id = ?').run(pastIso, bundle.id);
    db.prepare('UPDATE quota_reservations SET expires_at = ? WHERE bundle_id = ?').run(pastIso, bundle.id);

    // Commit should SUCCEED and commit actual usage even though expiresAt <= now
    const committed = await quotaRepo.commitBundle({
      bundleId: bundle.id,
      actualUsage: {
        turns: 1,
        messages: 1,
        tokens: 350,
      },
    });

    expect(committed.status).toBe('committed');
    expect(committed.tokensCommitted).toBe(350);

    // Verify DB row status is committed
    const row = db.prepare('SELECT status, tokens_committed FROM quota_bundles WHERE id = ?').get(bundle.id) as any;
    expect(row.status).toBe('committed');
    expect(row.tokens_committed).toBe(350);

    // Verify quota_usage accumulated actual tokens
    const usageRow = db.prepare("SELECT used_amount FROM quota_usage WHERE user_id = 'user_alice' AND resource = 'tokens'").get() as any;
    expect(usageRow.used_amount).toBe(350);
  });

  it('still rejects commit with ReservationSettledError if background cleaner explicitly set status to expired', async () => {
    const quotaRepo = operationsStorage.forTenant('user_alice').quota;
    await quotaRepo.setLimit({ resource: 'turns', limit: 10 });
    await quotaRepo.setLimit({ resource: 'messages', limit: 10 });
    await quotaRepo.setLimit({ resource: 'tokens', limit: 5000 });

    const bundle = await quotaRepo.reserveBundle({
      sessionId: 'ses_00000000000000000000000000000003',
      deliveryId: 'deliv_00000000000000000000000000000003',
      turns: 1,
      messages: 1,
      tokens: 100,
      isEstimateTokens: true,
    });

    // Simulate background scavenger having marked it expired
    db.prepare("UPDATE quota_bundles SET status = 'expired' WHERE id = ?").run(bundle.id);
    db.prepare("UPDATE quota_reservations SET status = 'expired' WHERE bundle_id = ?").run(bundle.id);

    await expect(
      quotaRepo.commitBundle({
        bundleId: bundle.id,
        actualUsage: { turns: 1, messages: 1, tokens: 100 },
      })
    ).rejects.toThrow(ReservationSettledError);
  });
});
