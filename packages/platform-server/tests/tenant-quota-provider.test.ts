import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
} from '../src/storage/migrations.js';
import {
  SqlitePlatformStorage,
  SqlitePlatformOperationsStorage,
} from '@enkeep/platform-storage-sqlite';
import {
  createPlatformOperations,
  PlatformOperationsService,
  QuotaExceededError,
  ReservationSettledError,
  ValidationError,
  DELIVERY_ID_REGEX,
  SESSION_ID_REGEX,
} from '@enkeep/platform-operations';
import {
  OperationsTenantQuotaProvider,
  createOperationsTenantQuotaProvider,
} from '../src/operations/tenant-quota-provider.js';

function createValidDeliveryId(): string {
  return `deliv_${randomUUID().replace(/-/g, '').toLowerCase()}`;
}

function createValidSessionId(isImport = false): string {
  const hex = randomUUID().replace(/-/g, '').toLowerCase();
  return isImport ? `import-${hex}` : `ses_${hex}`;
}

describe('OperationsTenantQuotaProvider Multi-Metric Turn Bundle Adapter', () => {
  let db: DatabaseSync;
  let operationsStorage: SqlitePlatformOperationsStorage;
  let operationsService: PlatformOperationsService;
  let quotaProvider: OperationsTenantQuotaProvider;

  const tenantAlice = 'user_alice_1111';
  const tenantBob = 'user_bob_2222';

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    const storage = new SqlitePlatformStorage(db);
    await storage.users.create({
      id: tenantAlice,
      username: 'alice',
      passwordHash: 'hash_alice',
      role: 'admin',
      status: 'active',
    });
    await storage.users.create({
      id: tenantBob,
      username: 'bob',
      passwordHash: 'hash_bob',
      role: 'user',
      status: 'active',
    });
    await storage.users.create({
      id: 'user_charlie_unconfigured',
      username: 'charlie',
      passwordHash: 'hash_charlie',
      role: 'user',
      status: 'active',
    });

    operationsStorage = new SqlitePlatformOperationsStorage(db, {
      quotaOptions: { unconfiguredPolicy: 'fail_closed' },
    });
    operationsService = createPlatformOperations({
      storage: operationsStorage,
    });
    quotaProvider = createOperationsTenantQuotaProvider(operationsService);

    // Setup Alice quota limits
    const aliceQuota = operationsStorage.forTenant(tenantAlice).quota;
    await aliceQuota.setLimit({ resource: 'turns', limit: 10 });
    await aliceQuota.setLimit({ resource: 'messages', limit: 10 });
    await aliceQuota.setLimit({ resource: 'tokens', limit: 1000 });

    // Setup Bob quota limits
    const bobQuota = operationsStorage.forTenant(tenantBob).quota;
    await bobQuota.setLimit({ resource: 'turns', limit: 2 });
    await bobQuota.setLimit({ resource: 'messages', limit: 2 });
    await bobQuota.setLimit({ resource: 'tokens', limit: 50 });
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {
      // ignore
    }
  });

  it('successfully reserves 3-metric quota bundle and creates canonical bundleId', async () => {
    const deliveryId = createValidDeliveryId();
    const sessionId = createValidSessionId();
    const bundle = await quotaProvider.reserve({
      userId: tenantAlice,
      turns: 1,
      messages: 1,
      tokens: 250,
      isEstimateTokens: true,
      sessionId,
      deliveryId,
    });

    expect(bundle).toBeDefined();
    expect(bundle.userId).toBe(tenantAlice);
    expect(bundle.turns).toBe(1);
    expect(bundle.messages).toBe(1);
    expect(bundle.tokens).toBe(250);
    expect(bundle.isEstimateTokens).toBe(true);
    expect(bundle.reservationId).toMatch(/^(?:bundle_|qbd_)/);

    // Commit
    await quotaProvider.commit(bundle, { turns: 1, messages: 1, tokens: 200 });

    const turnsUsage = await operationsStorage.forTenant(tenantAlice).quota.getUsage('turns');
    const msgUsage = await operationsStorage.forTenant(tenantAlice).quota.getUsage('messages');
    const tokenUsage = await operationsStorage.forTenant(tenantAlice).quota.getUsage('tokens');

    expect(turnsUsage.used).toBe(1);
    expect(turnsUsage.reserved).toBe(0);
    expect(msgUsage.used).toBe(1);
    expect(msgUsage.reserved).toBe(0);
    expect(tokenUsage.used).toBe(200);
    expect(tokenUsage.reserved).toBe(0);
  });

  it('successfully reserves and commits with tokens=0', async () => {
    const deliveryId = createValidDeliveryId();
    const sessionId = createValidSessionId();
    const bundle = await quotaProvider.reserve({
      userId: tenantAlice,
      turns: 1,
      messages: 1,
      tokens: 0,
      isEstimateTokens: false,
      sessionId,
      deliveryId,
    });

    expect(bundle.tokens).toBe(0);
    expect(bundle.isEstimateTokens).toBe(false);

    await bundle.commit({ turns: 1, messages: 1, tokens: 0 });

    const tokenUsage = await operationsStorage.forTenant(tenantAlice).quota.getUsage('tokens');
    expect(tokenUsage.used).toBe(0);
    expect(tokenUsage.reserved).toBe(0);
  });

  it('synchronously commits inside an active SQLite transaction via commitInTransaction', async () => {
    const deliveryId = createValidDeliveryId();
    const sessionId = createValidSessionId();
    const bundle = await quotaProvider.reserve({
      userId: tenantAlice,
      turns: 1,
      messages: 1,
      tokens: 300,
      isEstimateTokens: true,
      sessionId,
      deliveryId,
    });

    db.exec('BEGIN IMMEDIATE');
    quotaProvider.commitInTransaction(db, bundle, {
      turns: 1,
      messages: 1,
      tokens: 280,
    });
    db.exec('COMMIT');

    const turnsUsage = await operationsStorage.forTenant(tenantAlice).quota.getUsage('turns');
    const tokenUsage = await operationsStorage.forTenant(tenantAlice).quota.getUsage('tokens');
    expect(turnsUsage.used).toBe(1);
    expect(tokenUsage.used).toBe(280);
  });

  it('synchronously releases inside an active SQLite transaction via releaseInTransaction', async () => {
    const deliveryId = createValidDeliveryId();
    const sessionId = createValidSessionId();
    const bundle = await quotaProvider.reserve({
      userId: tenantAlice,
      turns: 1,
      messages: 1,
      tokens: 300,
      isEstimateTokens: true,
      sessionId,
      deliveryId,
    });

    db.exec('BEGIN IMMEDIATE');
    quotaProvider.releaseInTransaction(db, bundle);
    db.exec('COMMIT');

    const turnsUsage = await operationsStorage.forTenant(tenantAlice).quota.getUsage('turns');
    const tokenUsage = await operationsStorage.forTenant(tenantAlice).quota.getUsage('tokens');
    expect(turnsUsage.used).toBe(0);
    expect(turnsUsage.reserved).toBe(0);
    expect(tokenUsage.used).toBe(0);
    expect(tokenUsage.reserved).toBe(0);
  });

  it('fails closed and rolls back prior metric reservations when 3rd metric (tokens) exceeds quota', async () => {
    const deliveryId = createValidDeliveryId();
    const sessionId = createValidSessionId();

    await expect(
      quotaProvider.reserve({
        userId: tenantBob,
        turns: 1,
        messages: 1,
        tokens: 9999, // Bob only has 50 tokens
        isEstimateTokens: true,
        sessionId,
        deliveryId,
      })
    ).rejects.toThrow(QuotaExceededError);

    // Verify Bob has zero reserved turns and zero reserved messages
    const bobTurns = await operationsStorage.forTenant(tenantBob).quota.getUsage('turns');
    const bobMessages = await operationsStorage.forTenant(tenantBob).quota.getUsage('messages');
    const bobTokens = await operationsStorage.forTenant(tenantBob).quota.getUsage('tokens');

    expect(bobTurns.reserved).toBe(0);
    expect(bobMessages.reserved).toBe(0);
    expect(bobTokens.reserved).toBe(0);
  });

  it('fails closed and rolls back turns reservation when messages metric exceeds quota', async () => {
    const deliveryId = createValidDeliveryId();
    const sessionId = createValidSessionId();

    await expect(
      quotaProvider.reserve({
        userId: tenantBob,
        turns: 1,
        messages: 5, // Bob limit is 2
        tokens: 10,
        isEstimateTokens: true,
        sessionId,
        deliveryId,
      })
    ).rejects.toThrow(QuotaExceededError);

    const bobTurns = await operationsStorage.forTenant(tenantBob).quota.getUsage('turns');
    expect(bobTurns.reserved).toBe(0);
  });

  it('fails closed with 0 limit when tenant quota is unconfigured', async () => {
    const deliveryId = createValidDeliveryId();
    const sessionId = createValidSessionId();

    await expect(
      quotaProvider.reserve({
        userId: 'user_charlie_unconfigured',
        turns: 1,
        messages: 1,
        tokens: 100,
        isEstimateTokens: true,
        sessionId,
        deliveryId,
      })
    ).rejects.toThrow(QuotaExceededError);
  });

  it('supports idempotent and retryable commit() without throwing', async () => {
    const deliveryId = createValidDeliveryId();
    const sessionId = createValidSessionId();
    const bundle = await quotaProvider.reserve({
      userId: tenantAlice,
      turns: 1,
      messages: 1,
      tokens: 100,
      isEstimateTokens: true,
      sessionId,
      deliveryId,
    });

    await quotaProvider.commit(bundle, { turns: 1, messages: 1, tokens: 90 });
    // Second commit should be a clean no-op
    await expect(
      quotaProvider.commit(bundle, { turns: 1, messages: 1, tokens: 90 })
    ).resolves.toBeUndefined();

    // Directly on bundle
    await expect(
      bundle.commit({ turns: 1, messages: 1, tokens: 90 })
    ).resolves.toBeUndefined();
  });

  it('supports idempotent and retryable release() without throwing', async () => {
    const deliveryId = createValidDeliveryId();
    const sessionId = createValidSessionId();
    const bundle = await quotaProvider.reserve({
      userId: tenantAlice,
      turns: 1,
      messages: 1,
      tokens: 100,
      isEstimateTokens: true,
      sessionId,
      deliveryId,
    });

    await quotaProvider.release(bundle);
    // Second release should be a clean no-op
    await expect(quotaProvider.release(bundle)).resolves.toBeUndefined();
    await expect(bundle.release()).resolves.toBeUndefined();
  });

  it('maintains strict cross-tenant quota isolation', async () => {
    // Alice consumes 5 turns
    for (let i = 0; i < 5; i++) {
      const deliveryId = createValidDeliveryId();
      const sessionId = createValidSessionId();
      const b = await quotaProvider.reserve({
        userId: tenantAlice,
        turns: 1,
        messages: 1,
        tokens: 50,
        isEstimateTokens: true,
        sessionId,
        deliveryId,
      });
      await quotaProvider.commit(b, { turns: 1, messages: 1, tokens: 50 });
    }

    // Bob still has full 2 turns available
    const bobDeliveryId = createValidDeliveryId();
    const bobSessionId = createValidSessionId();
    const bobBundle = await quotaProvider.reserve({
      userId: tenantBob,
      turns: 1,
      messages: 1,
      tokens: 20,
      isEstimateTokens: true,
      sessionId: bobSessionId,
      deliveryId: bobDeliveryId,
    });
    await quotaProvider.commit(bobBundle, { turns: 1, messages: 1, tokens: 20 });

    const aliceTurns = await operationsStorage.forTenant(tenantAlice).quota.getUsage('turns');
    const bobTurns = await operationsStorage.forTenant(tenantBob).quota.getUsage('turns');

    expect(aliceTurns.used).toBe(5);
    expect(bobTurns.used).toBe(1);
  });

  describe('Strict ID & Input Validation (no mutate/default/raw values errors)', () => {
    it('strictly validates delivery ID format /^deliv_[0-9a-f]{32}$/', async () => {
      const validDeliveryId = createValidDeliveryId();
      expect(DELIVERY_ID_REGEX.test(validDeliveryId)).toBe(true);

      const validSessionId = createValidSessionId();

      // Non-matching deliveryId formats must throw ValidationError
      const invalidDeliveryIds = [
        'deliv_short',
        'del_0123456789abcdef0123456789abcdef',
        'deliv_0123456789ABCDEF0123456789ABCDEF', // uppercase hex
        'deliv_0123456789abcdef0123456789abcdeg', // non-hex 'g'
        ` ${validDeliveryId} `, // untrimmed
        '',
        123 as any,
        null as any,
      ];

      for (const badDelivId of invalidDeliveryIds) {
        await expect(
          quotaProvider.reserve({
            userId: tenantAlice,
            turns: 1,
            messages: 1,
            tokens: 10,
            isEstimateTokens: true,
            sessionId: validSessionId,
            deliveryId: badDelivId,
          })
        ).rejects.toThrow(ValidationError);
      }
    });

    it('strictly validates session ID union format (/^ses_[0-9a-f]{32}$/ | /^import-[0-9a-f]{32}$/)', async () => {
      const validDeliveryId = createValidDeliveryId();
      const validSesId = createValidSessionId(false);
      const validImportId = createValidSessionId(true);

      expect(SESSION_ID_REGEX.test(validSesId)).toBe(true);
      expect(SESSION_ID_REGEX.test(validImportId)).toBe(true);

      // Both ses_ and import- unions should be accepted
      const bundle1 = await quotaProvider.reserve({
        userId: tenantAlice,
        turns: 1,
        messages: 1,
        tokens: 10,
        isEstimateTokens: true,
        sessionId: validSesId,
        deliveryId: validDeliveryId,
      });
      expect(bundle1.reservationId).toBeDefined();

      const deliveryId2 = createValidDeliveryId();
      const bundle2 = await quotaProvider.reserve({
        userId: tenantAlice,
        turns: 1,
        messages: 1,
        tokens: 10,
        isEstimateTokens: true,
        sessionId: validImportId,
        deliveryId: deliveryId2,
      });
      expect(bundle2.reservationId).toBeDefined();

      // Invalid session ID formats
      const invalidSessionIds = [
        'session_test_1',
        'ses_short',
        'import_wrong_separator',
        'ses_0123456789abcdef0123456789abcdeg',
        ` ${validSesId} `,
        '',
        null as any,
      ];

      for (const badSesId of invalidSessionIds) {
        const delivId = createValidDeliveryId();
        await expect(
          quotaProvider.reserve({
            userId: tenantAlice,
            turns: 1,
            messages: 1,
            tokens: 10,
            isEstimateTokens: true,
            sessionId: badSesId,
            deliveryId: delivId,
          })
        ).rejects.toThrow(ValidationError);
      }
    });

    it('strictly validates user ID: raw === trim, NFC normalization, bounds 1..128, no control chars', async () => {
      const validDeliveryId = createValidDeliveryId();
      const validSessionId = createValidSessionId();

      const invalidUserIds = [
        ' user_alice_1111 ', // raw !== trim
        'user\x00alice',     // null byte
        'user\x1falice',     // control char
        'user\nname',        // newline
        '',                  // empty
        'a'.repeat(129),     // exceeds 128 bounds
        null as any,
        undefined as any,
        12345 as any,
      ];

      for (const badUserId of invalidUserIds) {
        const delivId = createValidDeliveryId();
        await expect(
          quotaProvider.reserve({
            userId: badUserId,
            turns: 1,
            messages: 1,
            tokens: 10,
            isEstimateTokens: true,
            sessionId: validSessionId,
            deliveryId: delivId,
          })
        ).rejects.toThrow(ValidationError);
      }
    });

    it('strictly validates turns and messages as positive safe integers and tokens as non-negative safe integer', async () => {
      const validDeliveryId = createValidDeliveryId();
      const validSessionId = createValidSessionId();

      // Invalid turns
      await expect(
        quotaProvider.reserve({
          userId: tenantAlice,
          turns: 0, // turns must be > 0
          messages: 1,
          tokens: 10,
          isEstimateTokens: true,
          sessionId: validSessionId,
          deliveryId: validDeliveryId,
        })
      ).rejects.toThrow(ValidationError);

      await expect(
        quotaProvider.reserve({
          userId: tenantAlice,
          turns: -1,
          messages: 1,
          tokens: 10,
          isEstimateTokens: true,
          sessionId: validSessionId,
          deliveryId: validDeliveryId,
        })
      ).rejects.toThrow(ValidationError);

      // Invalid messages
      await expect(
        quotaProvider.reserve({
          userId: tenantAlice,
          turns: 1,
          messages: 0,
          tokens: 10,
          isEstimateTokens: true,
          sessionId: validSessionId,
          deliveryId: validDeliveryId,
        })
      ).rejects.toThrow(ValidationError);

      // Invalid tokens (negative)
      await expect(
        quotaProvider.reserve({
          userId: tenantAlice,
          turns: 1,
          messages: 1,
          tokens: -5,
          isEstimateTokens: true,
          sessionId: validSessionId,
          deliveryId: validDeliveryId,
        })
      ).rejects.toThrow(ValidationError);

      // Non-boolean isEstimateTokens
      await expect(
        quotaProvider.reserve({
          userId: tenantAlice,
          turns: 1,
          messages: 1,
          tokens: 10,
          isEstimateTokens: 'yes' as any,
          sessionId: validSessionId,
          deliveryId: validDeliveryId,
        })
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('Default TTL and Constructor Configuration', () => {
    it('defaults to 900 seconds when options are omitted', () => {
      const provider = createOperationsTenantQuotaProvider(operationsService);
      expect(provider.getDefaultTtlSeconds()).toBe(900);
    });

    it('accepts valid finite positive safe integer for defaultTtlSeconds', () => {
      const provider = createOperationsTenantQuotaProvider(operationsService, {
        defaultTtlSeconds: 1800,
      });
      expect(provider.getDefaultTtlSeconds()).toBe(1800);
    });

    it('rejects invalid defaultTtlSeconds in constructor', () => {
      expect(() =>
        createOperationsTenantQuotaProvider(operationsService, { defaultTtlSeconds: 0 })
      ).toThrow(ValidationError);

      expect(() =>
        createOperationsTenantQuotaProvider(operationsService, { defaultTtlSeconds: -100 })
      ).toThrow(ValidationError);

      expect(() =>
        createOperationsTenantQuotaProvider(operationsService, { defaultTtlSeconds: NaN })
      ).toThrow(ValidationError);

      expect(() =>
        createOperationsTenantQuotaProvider(operationsService, { defaultTtlSeconds: Infinity })
      ).toThrow(ValidationError);
    });

    it('uses request ttlSeconds when provided, otherwise falls back to configured default TTL', async () => {
      const customProvider = createOperationsTenantQuotaProvider(operationsService, {
        defaultTtlSeconds: 600,
      });

      const deliveryId1 = createValidDeliveryId();
      const sessionId1 = createValidSessionId();
      const bundle1 = await customProvider.reserve({
        userId: tenantAlice,
        turns: 1,
        messages: 1,
        tokens: 50,
        isEstimateTokens: true,
        sessionId: sessionId1,
        deliveryId: deliveryId1,
      });
      expect(bundle1.reservationId).toBeDefined();

      const deliveryId2 = createValidDeliveryId();
      const sessionId2 = createValidSessionId();
      const bundle2 = await customProvider.reserve({
        userId: tenantAlice,
        turns: 1,
        messages: 1,
        tokens: 50,
        isEstimateTokens: true,
        sessionId: sessionId2,
        deliveryId: deliveryId2,
        ttlSeconds: 1200,
      });
      expect(bundle2.reservationId).toBeDefined();
    });
  });

  describe('Direct Storage Injection and Bundle Methods', () => {
    it('operates identically when constructed directly with PlatformOperationsStorage', async () => {
      const directStorageProvider = createOperationsTenantQuotaProvider(operationsStorage);
      const deliveryId = createValidDeliveryId();
      const sessionId = createValidSessionId();

      const bundle = await directStorageProvider.reserve({
        userId: tenantAlice,
        turns: 1,
        messages: 1,
        tokens: 100,
        isEstimateTokens: true,
        sessionId,
        deliveryId,
      });

      expect(bundle).toBeDefined();
      expect(bundle.reservationId).toMatch(/^(?:bundle_|qbd_)/);

      await directStorageProvider.commit(bundle, {
        turns: 1,
        messages: 1,
        tokens: 80,
      });

      const tokenUsage = await operationsStorage.forTenant(tenantAlice).quota.getUsage('tokens');
      expect(tokenUsage.used).toBe(80);
    });

    it('renews reservation TTL successfully via bundle.renew and quotaProvider.renew', async () => {
      const deliveryId = createValidDeliveryId();
      const sessionId = createValidSessionId();

      const bundle = await quotaProvider.reserve({
        userId: tenantAlice,
        turns: 1,
        messages: 1,
        tokens: 100,
        isEstimateTokens: true,
        sessionId,
        deliveryId,
      });

      await expect(bundle.renew(1200)).resolves.toBeUndefined();
      await expect(quotaProvider.renew(bundle, 1800)).resolves.toBeUndefined();

      // Once committed, renew should throw ReservationSettledError
      await bundle.commit({ turns: 1, messages: 1, tokens: 50 });
      await expect(bundle.renew(600)).rejects.toThrow(ReservationSettledError);
    });
  });
});
