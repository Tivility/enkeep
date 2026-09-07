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
  ReservationSettledError,
  IdempotencyConflictError,
} from '@enkeep/platform-operations';

describe('Quota Bundle Atomic Lifecycle SQLite Persistence & Invariants', () => {
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

  it('atomically reserves multi-metric bundle (turns, messages, tokens) with authoritative receipt', async () => {
    const quotaRepo = operationsStorage.forTenant('user_alice').quota;

    // Set limits
    await quotaRepo.setLimit({ resource: 'turns', limit: 10 });
    await quotaRepo.setLimit({ resource: 'messages', limit: 10 });
    await quotaRepo.setLimit({ resource: 'tokens', limit: 5000 });

    const bundle = await quotaRepo.reserveBundle({
      sessionId: 'ses_00000000000000000000000000000001',
      deliveryId: 'deliv_00000000000000000000000000000001',
      turns: 1,
      messages: 1,
      tokens: 150,
      isEstimateTokens: true,
      ttlSeconds: 900,
    });

    expect(bundle.id).toBeDefined();
    expect(bundle.id).toMatch(/^qbd_[0-9a-f]{32}$/);
    expect(bundle.userId).toBe('user_alice');
    expect(bundle.sessionId).toBe('ses_00000000000000000000000000000001');
    expect(bundle.deliveryId).toBe('deliv_00000000000000000000000000000001');
    expect(bundle.turns).toBe(1);
    expect(bundle.messages).toBe(1);
    expect(bundle.tokens).toBe(150);
    expect(bundle.isEstimateTokens).toBe(true);
    expect(bundle.status).toBe('reserved');

    // Verify all 3 reservation items are in DB and linked to bundle_id and delivery_id
    const dbReservations = db.prepare(`
      SELECT id, resource, amount, status, bundle_id, delivery_id
      FROM quota_reservations
      WHERE user_id = 'user_alice' AND bundle_id = ?
      ORDER BY resource ASC
    `).all(bundle.id) as Array<{
      id: string;
      resource: string;
      amount: number;
      status: string;
      bundle_id: string;
      delivery_id: string;
    }>;

    expect(dbReservations.length).toBe(3);
    expect(dbReservations.find((r) => r.resource === 'turns')).toMatchObject({
      amount: 1,
      status: 'reserved',
      bundle_id: bundle.id,
      delivery_id: 'deliv_00000000000000000000000000000001',
    });
    expect(dbReservations.find((r) => r.resource === 'messages')).toMatchObject({
      amount: 1,
      status: 'reserved',
      bundle_id: bundle.id,
      delivery_id: 'deliv_00000000000000000000000000000001',
    });
    expect(dbReservations.find((r) => r.resource === 'tokens')).toMatchObject({
      amount: 150,
      status: 'reserved',
      bundle_id: bundle.id,
      delivery_id: 'deliv_00000000000000000000000000000001',
    });
  });

  it('fails atomically with ZERO partial reservations when any one metric exceeds limit', async () => {
    const quotaRepo = operationsStorage.forTenant('user_alice').quota;

    // Set limits: turns & messages have capacity, but tokens does NOT
    await quotaRepo.setLimit({ resource: 'turns', limit: 10 });
    await quotaRepo.setLimit({ resource: 'messages', limit: 10 });
    await quotaRepo.setLimit({ resource: 'tokens', limit: 100 });

    await expect(
      quotaRepo.reserveBundle({
        sessionId: 'ses_00000000000000000000000000000001',
        deliveryId: 'deliv_00000000000000000000000000000002',
        turns: 1,
        messages: 1,
        tokens: 500, // exceeds 100 limit!
        isEstimateTokens: true,
      })
    ).rejects.toThrow(QuotaExceededError);

    // Verify ZERO bundles and ZERO reservations exist in DB
    const bundlesCount = (db.prepare("SELECT COUNT(*) as c FROM quota_bundles WHERE user_id = 'user_alice'").get() as { c: number }).c;
    const reservationsCount = (db.prepare("SELECT COUNT(*) as c FROM quota_reservations WHERE user_id = 'user_alice'").get() as { c: number }).c;

    expect(bundlesCount).toBe(0);
    expect(reservationsCount).toBe(0);
  });

  it('deduplicates identical deliveryId with same request hash returning exact authoritative bundle receipt', async () => {
    const quotaRepo = operationsStorage.forTenant('user_alice').quota;

    await quotaRepo.setLimit({ resource: 'turns', limit: 5 });
    await quotaRepo.setLimit({ resource: 'messages', limit: 5 });
    await quotaRepo.setLimit({ resource: 'tokens', limit: 1000 });

    const first = await quotaRepo.reserveBundle({
      sessionId: 'ses_00000000000000000000000000000001',
      deliveryId: 'deliv_00000000000000000000000000000003',
      turns: 1,
      messages: 1,
      tokens: 200,
      isEstimateTokens: true,
    });

    // Second call with same deliveryId and identical parameters
    const second = await quotaRepo.reserveBundle({
      sessionId: 'ses_00000000000000000000000000000001',
      deliveryId: 'deliv_00000000000000000000000000000003',
      turns: 1,
      messages: 1,
      tokens: 200,
      isEstimateTokens: true,
    });

    expect(second.id).toBe(first.id);
    expect(second.deliveryId).toBe('deliv_00000000000000000000000000000003');

    // Quota was only deducted ONCE (turns: 1 reserved, remaining: 4)
    const turnUsage = await quotaRepo.getUsage('turns');
    expect(turnUsage.reserved).toBe(1);
    expect(turnUsage.remaining).toBe(4);
  });

  it('rejects deliveryId reuse with conflicting parameters', async () => {
    const quotaRepo = operationsStorage.forTenant('user_alice').quota;

    await quotaRepo.setLimit({ resource: 'turns', limit: 5 });
    await quotaRepo.setLimit({ resource: 'messages', limit: 5 });
    await quotaRepo.setLimit({ resource: 'tokens', limit: 1000 });

    await quotaRepo.reserveBundle({
      sessionId: 'ses_00000000000000000000000000000001',
      deliveryId: 'deliv_00000000000000000000000000000004',
      turns: 1,
      messages: 1,
      tokens: 200,
      isEstimateTokens: true,
    });

    // Mismatched token amount on same deliveryId
    await expect(
      quotaRepo.reserveBundle({
        sessionId: 'ses_00000000000000000000000000000001',
        deliveryId: 'deliv_00000000000000000000000000000004',
        turns: 1,
        messages: 1,
        tokens: 800, // Conflict!
        isEstimateTokens: true,
      })
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it('synchronously commits bundle in a parent transaction via commitBundleInTransactionSync', async () => {
    const quotaRepo = operationsStorage.forTenant('user_alice').quota;

    // Set initial limits
    await quotaRepo.setLimit({ resource: 'turns', limit: 10 });
    await quotaRepo.setLimit({ resource: 'messages', limit: 10 });
    await quotaRepo.setLimit({ resource: 'tokens', limit: 5000 });

    const bundle = await quotaRepo.reserveBundle({
      sessionId: 'ses_00000000000000000000000000000001',
      deliveryId: 'deliv_00000000000000000000000000000005',
      turns: 1,
      messages: 1,
      tokens: 100,
      isEstimateTokens: true,
    });

    // Start single parent transaction
    db.exec('BEGIN IMMEDIATE');

    // Perform synchronized commit inside parent transaction
    quotaRepo.commitBundleInTransactionSync(db, {
      bundleId: bundle.id,
      actualUsage: {
        turns: 1,
        messages: 1,
        tokens: 342, // Actual tokens from container
      },
    });

    db.exec('COMMIT');

    // Verify bundle status is committed
    const bundleRow = db.prepare("SELECT status, turns_committed, messages_committed, tokens_committed FROM quota_bundles WHERE id = ?").get(bundle.id) as any;
    expect(bundleRow.status).toBe('committed');
    expect(bundleRow.turns_committed).toBe(1);
    expect(bundleRow.messages_committed).toBe(1);
    expect(bundleRow.tokens_committed).toBe(342);

    // Verify reservations are committed
    const resRows = db.prepare("SELECT resource, status, committed_amount FROM quota_reservations WHERE bundle_id = ?").all(bundle.id) as any[];
    expect(resRows.find((r) => r.resource === 'turns')).toMatchObject({ status: 'committed', committed_amount: 1 });
    expect(resRows.find((r) => r.resource === 'messages')).toMatchObject({ status: 'committed', committed_amount: 1 });
    expect(resRows.find((r) => r.resource === 'tokens')).toMatchObject({ status: 'committed', committed_amount: 342 });

    // Verify quota_usage recorded exact actual consumption
    const usageRows = db.prepare("SELECT resource, used_amount FROM quota_usage WHERE user_id = 'user_alice'").all() as any[];
    expect(usageRows.find((u) => u.resource === 'turns')?.used_amount).toBe(1);
    expect(usageRows.find((u) => u.resource === 'messages')?.used_amount).toBe(1);
    expect(usageRows.find((u) => u.resource === 'tokens')?.used_amount).toBe(342);
  });

  it('rejects commit on released or expired bundle with ReservationSettledError', async () => {
    const quotaRepo = operationsStorage.forTenant('user_alice').quota;

    await quotaRepo.setLimit({ resource: 'turns', limit: 10 });
    await quotaRepo.setLimit({ resource: 'messages', limit: 10 });
    await quotaRepo.setLimit({ resource: 'tokens', limit: 5000 });

    const bundle = await quotaRepo.reserveBundle({
      sessionId: 'ses_00000000000000000000000000000001',
      deliveryId: 'deliv_00000000000000000000000000000006',
      turns: 1,
      messages: 1,
      tokens: 100,
      isEstimateTokens: true,
    });

    // Release the bundle first
    await quotaRepo.releaseBundle({ bundleId: bundle.id });

    // Attempt to commit released bundle -> throws ReservationSettledError
    await expect(
      quotaRepo.commitBundle({
        bundleId: bundle.id,
        actualUsage: { turns: 1, messages: 1, tokens: 100 },
      })
    ).rejects.toThrow(ReservationSettledError);
  });

  it('release on already committed bundle is a safe no-op that leaves status committed', async () => {
    const quotaRepo = operationsStorage.forTenant('user_alice').quota;

    await quotaRepo.setLimit({ resource: 'turns', limit: 10 });
    await quotaRepo.setLimit({ resource: 'messages', limit: 10 });
    await quotaRepo.setLimit({ resource: 'tokens', limit: 5000 });

    const bundle = await quotaRepo.reserveBundle({
      sessionId: 'ses_00000000000000000000000000000001',
      deliveryId: 'deliv_00000000000000000000000000000007',
      turns: 1,
      messages: 1,
      tokens: 100,
      isEstimateTokens: true,
    });

    await quotaRepo.commitBundle({
      bundleId: bundle.id,
      actualUsage: { turns: 1, messages: 1, tokens: 100 },
    });

    // Releasing committed bundle must not corrupt committed state
    const resAfterRelease = await quotaRepo.releaseBundle({ bundleId: bundle.id });
    expect(resAfterRelease.status).toBe('committed');

    const bundleRow = await quotaRepo.findBundleById(bundle.id);
    expect(bundleRow?.status).toBe('committed');
  });

  it('renews lease via renewBundle and prevents premature expiration', async () => {
    const quotaRepo = operationsStorage.forTenant('user_alice').quota;

    await quotaRepo.setLimit({ resource: 'turns', limit: 10 });
    await quotaRepo.setLimit({ resource: 'messages', limit: 10 });
    await quotaRepo.setLimit({ resource: 'tokens', limit: 5000 });

    const bundle = await quotaRepo.reserveBundle({
      sessionId: 'ses_00000000000000000000000000000001',
      deliveryId: 'deliv_00000000000000000000000000000008',
      turns: 1,
      messages: 1,
      tokens: 100,
      isEstimateTokens: true,
      ttlSeconds: 60,
    });

    const initialExpiresAt = new Date(bundle.expiresAt).getTime();

    // Renew lease with 15 minutes (900s)
    const renewed = await quotaRepo.renewBundle({ bundleId: bundle.id, extendSeconds: 900 });
    const renewedExpiresAt = new Date(renewed.expiresAt).getTime();

    expect(renewedExpiresAt).toBeGreaterThan(initialExpiresAt);
    expect(renewed.status).toBe('reserved');
  });

  it('enforces multi-tenant isolation: Bob cannot commit or release Alice bundle', async () => {
    const aliceRepo = operationsStorage.forTenant('user_alice').quota;
    const bobRepo = operationsStorage.forTenant('user_bob').quota;

    await aliceRepo.setLimit({ resource: 'turns', limit: 10 });
    await aliceRepo.setLimit({ resource: 'messages', limit: 10 });
    await aliceRepo.setLimit({ resource: 'tokens', limit: 5000 });

    const aliceBundle = await aliceRepo.reserveBundle({
      sessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      deliveryId: 'deliv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      turns: 1,
      messages: 1,
      tokens: 200,
      isEstimateTokens: true,
    });

    // Bob cannot find Alice bundle
    const bobFind = await bobRepo.findBundleById(aliceBundle.id);
    expect(bobFind).toBeNull();

    // Bob cannot find Alice bundle by delivery ID
    const bobFindByDelivery = await bobRepo.findBundleByDeliveryId('deliv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(bobFindByDelivery).toBeNull();

    // Bob cannot commit Alice bundle
    await expect(
      bobRepo.commitBundle({
        bundleId: aliceBundle.id,
        actualUsage: { turns: 1, messages: 1, tokens: 200 },
      })
    ).rejects.toThrow();

    // Bob cannot release Alice bundle
    await expect(bobRepo.releaseBundle({ bundleId: aliceBundle.id })).rejects.toThrow();

    // Bob cannot renew Alice bundle
    await expect(bobRepo.renewBundle({ bundleId: aliceBundle.id, extendSeconds: 600 })).rejects.toThrow();
  });

  it('tokens=0 still requires token policy and stores reservation with amount 0 (exactly 3 reservations)', async () => {
    const quotaRepo = operationsStorage.forTenant('user_alice').quota;

    // Set limits for turns, messages, and tokens (even if limit is 1000)
    await quotaRepo.setLimit({ resource: 'turns', limit: 10 });
    await quotaRepo.setLimit({ resource: 'messages', limit: 10 });
    await quotaRepo.setLimit({ resource: 'tokens', limit: 1000 });

    const bundle = await quotaRepo.reserveBundle({
      sessionId: 'ses_00000000000000000000000000000000',
      deliveryId: 'deliv_00000000000000000000000000000000',
      turns: 1,
      messages: 1,
      tokens: 0,
      isEstimateTokens: false,
    });

    expect(bundle.id).toBeDefined();
    expect(bundle.tokens).toBe(0);
    expect(bundle.status).toBe('reserved');

    // Verify exactly 3 reservation rows were inserted, including tokens with amount 0
    const reservations = db.prepare(`
      SELECT resource, amount, status, bundle_id, delivery_id
      FROM quota_reservations
      WHERE user_id = 'user_alice' AND bundle_id = ?
      ORDER BY resource ASC
    `).all(bundle.id) as Array<{
      resource: string;
      amount: number;
      status: string;
      bundle_id: string;
      delivery_id: string;
    }>;

    expect(reservations.length).toBe(3);
    const turnsRes = reservations.find((r) => r.resource === 'turns');
    const messagesRes = reservations.find((r) => r.resource === 'messages');
    const tokensRes = reservations.find((r) => r.resource === 'tokens');

    expect(turnsRes).toMatchObject({ amount: 1, status: 'reserved', bundle_id: bundle.id, delivery_id: 'deliv_00000000000000000000000000000000' });
    expect(messagesRes).toMatchObject({ amount: 1, status: 'reserved', bundle_id: bundle.id, delivery_id: 'deliv_00000000000000000000000000000000' });
    expect(tokensRes).toMatchObject({ amount: 0, status: 'reserved', bundle_id: bundle.id, delivery_id: 'deliv_00000000000000000000000000000000' });

    // Commit the bundle with 0 tokens
    const committed = await quotaRepo.commitBundle({
      bundleId: bundle.id,
      actualUsage: { turns: 1, messages: 1, tokens: 0 },
    });
    expect(committed.status).toBe('committed');
    expect(committed.tokensCommitted).toBe(0);

    // Verify quota_usage has an explicit row for tokens with used_amount = 0
    const tokenUsageRow = db.prepare(
      "SELECT used_amount FROM quota_usage WHERE user_id = 'user_alice' AND resource = 'tokens'"
    ).get() as { used_amount: number } | undefined;
    expect(tokenUsageRow).toBeDefined();
    expect(tokenUsageRow?.used_amount).toBe(0);
  });

  it('unconfigured token limit fails closed even when tokens=0', async () => {
    const quotaRepo = operationsStorage.forTenant('user_alice').quota;

    // Set limits ONLY for turns and messages, leaving tokens unconfigured
    await quotaRepo.setLimit({ resource: 'turns', limit: 10 });
    await quotaRepo.setLimit({ resource: 'messages', limit: 10 });

    await expect(
      quotaRepo.reserveBundle({
        sessionId: 'ses_cccccccccccccccccccccccccccccccc',
        deliveryId: 'deliv_cccccccccccccccccccccccccccccccc',
        turns: 1,
        messages: 1,
        tokens: 0,
        isEstimateTokens: false,
      })
    ).rejects.toThrow(QuotaExceededError);

    // Verify ZERO bundles and ZERO reservations exist
    const bundlesCount = (db.prepare("SELECT COUNT(*) as c FROM quota_bundles WHERE user_id = 'user_alice'").get() as { c: number }).c;
    const reservationsCount = (db.prepare("SELECT COUNT(*) as c FROM quota_reservations WHERE user_id = 'user_alice'").get() as { c: number }).c;
    expect(bundlesCount).toBe(0);
    expect(reservationsCount).toBe(0);
  });

  it('cross-tenant cannot observe or modify reservations and bundles (indistinguishable not found)', async () => {
    const aliceRepo = operationsStorage.forTenant('user_alice').quota;
    const bobRepo = operationsStorage.forTenant('user_bob').quota;

    await aliceRepo.setLimit({ resource: 'turns', limit: 10 });
    await aliceRepo.setLimit({ resource: 'messages', limit: 10 });
    await aliceRepo.setLimit({ resource: 'tokens', limit: 1000 });

    const aliceRes = await aliceRepo.reserve({
      resource: 'turns',
      amount: 2,
    });

    const aliceBundle = await aliceRepo.reserveBundle({
      sessionId: 'ses_dddddddddddddddddddddddddddddddd',
      deliveryId: 'deliv_dddddddddddddddddddddddddddddddd',
      turns: 1,
      messages: 1,
      tokens: 50,
      isEstimateTokens: false,
    });

    // Bob cannot observe Alice individual reservation
    const bobResFind = await bobRepo.findReservationById(aliceRes.id);
    expect(bobResFind).toBeNull();

    // Bob attempting to commit or release Alice individual reservation fails with InvalidReservationError
    await expect(bobRepo.commit({ reservationId: aliceRes.id })).rejects.toThrow(/not found|invalid/i);
    await expect(bobRepo.release({ reservationId: aliceRes.id })).rejects.toThrow(/not found|invalid/i);

    // Bob cannot observe Alice bundle
    const bobBundleFind = await bobRepo.findBundleById(aliceBundle.id);
    expect(bobBundleFind).toBeNull();
    const bobBundleByDel = await bobRepo.findBundleByDeliveryId(aliceBundle.deliveryId);
    expect(bobBundleByDel).toBeNull();

    // Bob attempting to commit, release, or renew Alice bundle fails
    await expect(bobRepo.commitBundle({ bundleId: aliceBundle.id })).rejects.toThrow(/not found|invalid/i);
    await expect(bobRepo.releaseBundle({ bundleId: aliceBundle.id })).rejects.toThrow(/not found|invalid/i);
    await expect(bobRepo.renewBundle({ bundleId: aliceBundle.id })).rejects.toThrow(/not found|invalid/i);
  });

  it('commitBundle succeeds when actual tokens > reserved tokens if remaining tenant quota allows it', async () => {
    const quotaRepo = operationsStorage.forTenant('user_alice').quota;

    await quotaRepo.setLimit({ resource: 'turns', limit: 10 });
    await quotaRepo.setLimit({ resource: 'messages', limit: 10 });
    await quotaRepo.setLimit({ resource: 'tokens', limit: 1000 });

    const bundle = await quotaRepo.reserveBundle({
      sessionId: 'ses_00000000000000000000000000000001',
      deliveryId: 'deliv_11111111111111111111111111111111',
      turns: 1,
      messages: 1,
      tokens: 100, // Reserved 100
      isEstimateTokens: true,
    });

    // Commit with actual 450 tokens (> 100 reserved, but <= 1000 limit)
    const committed = await quotaRepo.commitBundle({
      bundleId: bundle.id,
      actualUsage: { turns: 1, messages: 1, tokens: 450 },
    });

    expect(committed.status).toBe('committed');
    expect(committed.tokensCommitted).toBe(450);

    const usage = await quotaRepo.getUsage('tokens');
    expect(usage.used).toBe(450);
    expect(usage.remaining).toBe(550);
  });

  it('commitBundle fails atomically with QuotaExceededError and rolls back when actual tokens exceeds remaining tenant quota for non-estimate bundles', async () => {
    const quotaRepo = operationsStorage.forTenant('user_alice').quota;

    await quotaRepo.setLimit({ resource: 'turns', limit: 10 });
    await quotaRepo.setLimit({ resource: 'messages', limit: 10 });
    await quotaRepo.setLimit({ resource: 'tokens', limit: 500 });

    const bundle = await quotaRepo.reserveBundle({
      sessionId: 'ses_00000000000000000000000000000001',
      deliveryId: 'deliv_22222222222222222222222222222222',
      turns: 1,
      messages: 1,
      tokens: 100, // Reserved 100
      isEstimateTokens: false,
    });

    // Commit with actual 750 tokens (> 500 total limit)
    await expect(
      quotaRepo.commitBundle({
        bundleId: bundle.id,
        actualUsage: { turns: 1, messages: 1, tokens: 750 },
      })
    ).rejects.toThrow(QuotaExceededError);

    // Verify rollback: bundle is still 'reserved', usage is 0, reservation is still 'reserved'
    const bundleAfter = await quotaRepo.findBundleById(bundle.id);
    expect(bundleAfter?.status).toBe('reserved');

    const usage = await quotaRepo.getUsage('tokens');
    expect(usage.used).toBe(0);
    expect(usage.reserved).toBe(100);
    expect(usage.remaining).toBe(400);
  });

  it('commitBundle allows overage for estimated token reservation when actual exceeds limit, committing actual and blocking future turns', async () => {
    const quotaRepo = operationsStorage.forTenant('user_alice').quota;

    await quotaRepo.setLimit({ resource: 'turns', limit: 10 });
    await quotaRepo.setLimit({ resource: 'messages', limit: 10 });
    await quotaRepo.setLimit({ resource: 'tokens', limit: 500 });

    const bundle = await quotaRepo.reserveBundle({
      sessionId: 'ses_00000000000000000000000000000001',
      deliveryId: 'deliv_33333333333333333333333333333333',
      turns: 1,
      messages: 1,
      tokens: 100,
      isEstimateTokens: true,
    });

    // Commit with actual 750 tokens (> 500 total limit)
    const committed = await quotaRepo.commitBundle({
      bundleId: bundle.id,
      actualUsage: { turns: 1, messages: 1, tokens: 750 },
    });

    expect(committed.status).toBe('committed');
    expect(committed.tokensCommitted).toBe(750);

    // Usage reflects actual consumed tokens (750 > 500 limit), remaining is 0, allowed is false
    const usage = await quotaRepo.getUsage('tokens');
    expect(usage.used).toBe(750);
    expect(usage.remaining).toBe(0);
    expect(usage.allowed).toBe(false);

    // Subsequent reservation is rejected at preflight
    await expect(
      quotaRepo.reserveBundle({
        sessionId: 'ses_00000000000000000000000000000001',
        deliveryId: 'deliv_44444444444444444444444444444444',
        turns: 1,
        messages: 1,
        tokens: 100,
        isEstimateTokens: true,
      })
    ).rejects.toThrow(QuotaExceededError);

    // getLastCommittedTokens returns 750
    const lastCommitted = await quotaRepo.getLastCommittedTokens('ses_00000000000000000000000000000001');
    expect(lastCommitted).toBe(750);
  });

  it('pre-v10 database fails query naturally without sqlite_master compatibility probe', async () => {
    const preV10Db = new DatabaseSync(':memory:');
    preV10Db.exec('PRAGMA foreign_keys = ON;');
    const runner = new SqliteMigrationRunner(preV10Db);
    await runner.migrate(BUILTIN_MIGRATIONS); // Migrations 1-4 only, no quota_bundles
    preV10Db.exec("ALTER TABLE quota_limits ADD COLUMN reset_interval TEXT DEFAULT 'none';");

    preV10Db.prepare(`
      INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
      VALUES ('user_prev10', 'prev10', 'hash_p', 'user', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run();

    const { SqliteTenantScopedQuotaLedgerRepository } = await import('../src/repos/quota-ledger-repo.js');
    const repo = new SqliteTenantScopedQuotaLedgerRepository(preV10Db, 'user_prev10');

    await repo.setLimit({ resource: 'turns', limit: 10 });
    await repo.setLimit({ resource: 'messages', limit: 10 });
    await repo.setLimit({ resource: 'tokens', limit: 1000 });

    // Valid inputs pass validation, then reserveBundle query fails naturally on SQLite missing table
    await expect(
      repo.reserveBundle({
        sessionId: 'ses_00000000000000000000000000000001',
        deliveryId: 'deliv_00000000000000000000000000000001',
        turns: 1,
        messages: 1,
        tokens: 100,
        isEstimateTokens: true,
      })
    ).rejects.toThrow(/no such table: quota_bundles/i);

    preV10Db.close();
  });
});
