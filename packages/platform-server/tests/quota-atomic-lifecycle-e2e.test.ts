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
  InvalidReservationError,
} from '@enkeep/platform-operations';
import {
  OperationsTenantQuotaProvider,
  createOperationsTenantQuotaProvider,
} from '../src/operations/tenant-quota-provider.js';
import {
  DeliveryRuntimeGateway,
  SqliteWebMessageStore,
  estimateInboundTokens,
  type TurnExecutionResult,
} from '../src/index.js';
import type { InboundEnvelope } from '@enkeep/web-channel';

function createValidDeliveryId(): string {
  return `deliv_${randomUUID().replace(/-/g, '')}`;
}

describe('Quota Atomic Lifecycle & Single-Transaction Gateway Finalize E2E', () => {
  let db: DatabaseSync;
  let platformStorage: SqlitePlatformStorage;
  let operationsStorage: SqlitePlatformOperationsStorage;
  let operationsService: PlatformOperationsService;
  let quotaProvider: OperationsTenantQuotaProvider;
  let messageStore: SqliteWebMessageStore;

  const testUserId = 'user_quota_e2e_1111';
  const testSpaceId = 'spc_0123456789abcdef0123456789abcdef';
  const testSessionId = 'ses_0123456789abcdef0123456789abcdef';

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    platformStorage = new SqlitePlatformStorage(db);
    messageStore = new SqliteWebMessageStore(db);

    // Create active user
    await platformStorage.users.create({
      id: testUserId,
      username: 'e2e_user',
      passwordHash: 'hash',
      role: 'user',
      status: 'active',
    });

    // Create active space
    await platformStorage.forTenant(testUserId).spaces.create({
      id: testSpaceId,
      name: 'Quota Space',
      folder: 'quota-space',
      executionMode: 'container',
    });

    // Create active session route
    await platformStorage.forTenant(testUserId).sessionRoutes.create({
      id: testSessionId,
      spaceId: testSpaceId,
      userId: testUserId,
      channel: 'web',
      accountId: 'default',
      nativeContextId: testSessionId,
      peerId: testSessionId,
      dshSessionId: 'dsh_sess_e2e_authoritative',
      executionMode: 'container',
      status: 'active',
    });

    operationsStorage = new SqlitePlatformOperationsStorage(db, {
      quotaOptions: { unconfiguredPolicy: 'fail_closed' },
    });
    operationsService = createPlatformOperations({
      storage: operationsStorage,
    });
    quotaProvider = createOperationsTenantQuotaProvider(operationsService);
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {
      // ignore
    }
  });

  function createEnvelope(overrides: Partial<InboundEnvelope> = {}): InboundEnvelope {
    const id = overrides.id ?? createValidDeliveryId();
    return {
      id,
      userId: overrides.userId ?? testUserId,
      sessionId: overrides.sessionId ?? testSessionId,
      content: overrides.content ?? 'Test user message prompt for quota lifecycle',
      timestamp: overrides.timestamp ?? new Date().toISOString(),
      ...overrides,
    };
  }

  it('atomically completes turn, writes assistant message, and commits multi-metric quota in a single transaction', async () => {
    const quotaRepo = operationsStorage.forTenant(testUserId).quota;
    await quotaRepo.setLimit({ resource: 'turns', limit: 10 });
    await quotaRepo.setLimit({ resource: 'messages', limit: 10 });
    await quotaRepo.setLimit({ resource: 'tokens', limit: 50000 });

    const executor = {
      execute: async (req: any): Promise<TurnExecutionResult> => {
        expect(req.dshSessionId).toBe('dsh_sess_e2e_authoritative');
        return {
          replyText: 'Authoritative completed response from AI executor',
          usage: {
            totalTokens: 125,
          },
        };
      },
      cancel: async () => true,
    };

    const gateway = new DeliveryRuntimeGateway({
      database: db,
      storage: platformStorage,
      messageStore,
      executor,
      quotaMode: 'enforced',
      quotaProvider,
        profileResolver: { resolve: async () => null }
      });

    const envelope = createEnvelope();
    const dispatchRes = await gateway.dispatchInbound(envelope);
    expect(dispatchRes.accepted).toBe(true);
    expect(dispatchRes.turnId).toBeDefined();

    // Drain to allow asynchronous lifecycle to complete
    await gateway.drain(2000);

    // Verify turn state is completed
    const turnStatus = await gateway.getTurnStatus(testUserId, dispatchRes.turnId!);
    expect(turnStatus.status).toBe('completed');

    // Verify web_messages contains assistant message with msg_32 id and null metadata
    const msgHistory = await messageStore.listMessages(testUserId, testSessionId, { limit: 10 });
    const assistantMsg = msgHistory.messages.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg?.id).toMatch(/^msg_[0-9a-f]{32}$/);
    expect(assistantMsg?.content).toBe('Authoritative completed response from AI executor');

    // Verify quota bundle is atomically committed with exact actual tokens (125 tokens)
    const bundleRow = db.prepare(`
      SELECT status, turns_committed, messages_committed, tokens_committed
      FROM quota_bundles
      WHERE user_id = ? AND delivery_id = ?
    `).get(testUserId, envelope.id) as any;

    expect(bundleRow).toBeDefined();
    expect(bundleRow.status).toBe('committed');
    expect(bundleRow.turns_committed).toBe(1);
    expect(bundleRow.messages_committed).toBe(1);
    expect(bundleRow.tokens_committed).toBe(125);

    // Verify quota usage is committed in quota_usage table
    const turnsUsage = await quotaRepo.getUsage('turns');
    const msgsUsage = await quotaRepo.getUsage('messages');
    const tokensUsage = await quotaRepo.getUsage('tokens');

    expect(turnsUsage.used).toBe(1);
    expect(msgsUsage.used).toBe(1);
    expect(tokensUsage.used).toBe(125);
    expect(turnsUsage.reserved).toBe(0);
    expect(msgsUsage.reserved).toBe(0);
    expect(tokensUsage.reserved).toBe(0);
  });

  it('guarantees assistant message is NEVER exposed if quota commit fails (all rolled back together)', async () => {
    const quotaRepo = operationsStorage.forTenant(testUserId).quota;
    await quotaRepo.setLimit({ resource: 'turns', limit: 10 });
    await quotaRepo.setLimit({ resource: 'messages', limit: 10 });
    await quotaRepo.setLimit({ resource: 'tokens', limit: 50000 });

    // Mock executor that succeeds
    const executor = {
      execute: async () => ({
        replyText: 'This assistant message must NOT be saved if quota commit fails',
        usage: { totalTokens: 100 },
      }),
      cancel: async () => true,
    };

    const gateway = new DeliveryRuntimeGateway({
      database: db,
      storage: platformStorage,
      messageStore,
      executor,
      quotaMode: 'enforced',
      quotaProvider,
        profileResolver: { resolve: async () => null }
      });

    const envelope = createEnvelope({ id: createValidDeliveryId() });

    // Hook: simulate an infrastructure commit failure inside transaction
    const origReserve = quotaProvider.reserve.bind(quotaProvider);
    quotaProvider.reserve = async (req) => {
      const bundle = await origReserve(req);
      bundle.commitInTransaction = () => {
        throw new Error('Database disk I/O error during quota bundle commit');
      };
      return bundle;
    };

    const dispatchRes = await gateway.dispatchInbound(envelope);
    expect(dispatchRes.accepted).toBe(true);

    // Drain should throw AggregateError because completion failed
    await expect(gateway.drain(1000)).rejects.toThrow();

    // Verify web_messages has ZERO assistant messages (no partial leak!)
    const messages = db.prepare("SELECT * FROM web_messages WHERE user_id = ? AND role = 'assistant'").all(testUserId);
    expect(messages.length).toBe(0);

    // Verify turn_runs is marked failed in honest failure path
    const turnRow = db.prepare("SELECT status, error FROM turn_runs WHERE turn_id = ?").get(dispatchRes.turnId!) as any;
    expect(turnRow.status).toBe('failed');

    // Verify delivery_inbox is marked failed
    const inboxRow = db.prepare("SELECT status FROM delivery_inbox WHERE turn_id = ?").get(dispatchRes.turnId!) as any;
    expect(inboxRow.status).toBe('failed');
  });

  it('handles cancellation vs finalize CAS race mutually exclusively and releases quota on cancel', async () => {
    const quotaRepo = operationsStorage.forTenant(testUserId).quota;
    await quotaRepo.setLimit({ resource: 'turns', limit: 10 });
    await quotaRepo.setLimit({ resource: 'messages', limit: 10 });
    await quotaRepo.setLimit({ resource: 'tokens', limit: 50000 });

    let finishExecution: () => void;
    const executionGate = new Promise<void>((resolve) => {
      finishExecution = resolve;
    });
    let notifyExecutionStarted: () => void;
    const executionStarted = new Promise<void>((resolve) => {
      notifyExecutionStarted = resolve;
    });

    const executor = {
      execute: async () => {
        notifyExecutionStarted();
        await executionGate;
        return { replyText: 'Late completed reply after cancel' };
      },
      cancel: async () => true,
    };

    const gateway = new DeliveryRuntimeGateway({
      database: db,
      storage: platformStorage,
      messageStore,
      executor,
      quotaMode: 'enforced',
      quotaProvider,
        profileResolver: { resolve: async () => null }
      });

    const envelope = createEnvelope({ id: createValidDeliveryId() });
    const dispatchRes = await gateway.dispatchInbound(envelope);
    expect(dispatchRes.accepted).toBe(true);

    // Wait until executor is actively executing with claimed quota bundle
    await executionStarted;

    // Cancel while running
    const cancelRes = await gateway.cancelTurn(testUserId, dispatchRes.turnId!);
    expect(cancelRes).toBe(true);

    // Now release execution
    finishExecution!();
    await gateway.drain(1000);

    // Verify turn status is interrupted
    const turnStatus = await gateway.getTurnStatus(testUserId, dispatchRes.turnId!);
    expect(turnStatus.status).toBe('interrupted');

    // Verify quota bundle was released and NOT committed
    const bundleRow = db.prepare("SELECT status FROM quota_bundles WHERE delivery_id = ?").get(envelope.id) as any;
    expect(bundleRow.status).toBe('released');

    // Verify zero quota used
    const turnsUsage = await quotaRepo.getUsage('turns');
    expect(turnsUsage.used).toBe(0);
    expect(turnsUsage.reserved).toBe(0);
  });

  it('authoritatively commits actual tokens exceeding estimate within cap, and treats missing usage as turn failure with quota release', async () => {
    const quotaRepo = operationsStorage.forTenant(testUserId).quota;
    await quotaRepo.setLimit({ resource: 'turns', limit: 10 });
    await quotaRepo.setLimit({ resource: 'messages', limit: 10 });
    await quotaRepo.setLimit({ resource: 'tokens', limit: 1_000_000 });

    // Turn 1: Returns actual tokens exceeding reserved
    const executor1 = {
      execute: async () => ({
        replyText: 'Large LLM response',
        usage: { totalTokens: 8540 },
      }),
      cancel: async () => true,
    };

    const gateway1 = new DeliveryRuntimeGateway({
      database: db,
      storage: platformStorage,
      messageStore,
      executor: executor1,
      quotaMode: 'enforced',
      quotaProvider,
        profileResolver: { resolve: async () => null }
      });

    const env1 = createEnvelope({ id: createValidDeliveryId(), content: 'Short prompt' });
    await gateway1.dispatchInbound(env1);
    await gateway1.drain(1000);

    const bundle1 = db.prepare("SELECT status, tokens_amount as tokens, tokens_committed FROM quota_bundles WHERE delivery_id = ?").get(env1.id) as any;
    expect(bundle1.status).toBe('committed');
    expect(bundle1.tokens).toBe(5120); // ceil(max(3, 4096 floor, 0 lastActual) * 1.25 growth) = 5120
    expect(bundle1.tokens_committed).toBe(8540); // exact actual tokens committed!

    // Turn 2: Returns NO usage metadata -> treated as failure, releases quota reservation bundle
    const executor2 = {
      execute: async () => ({
        replyText: 'Plain response without metadata',
      }),
      cancel: async () => true,
    };

    const gateway2 = new DeliveryRuntimeGateway({
      database: db,
      storage: platformStorage,
      messageStore,
      executor: executor2,
      quotaMode: 'enforced',
      quotaProvider,
      profileResolver: { resolve: async () => null }
    });

    const env2 = createEnvelope({ id: createValidDeliveryId(), content: '1234567890123456' }); // 16 bytes -> 4 tokens
    await gateway2.dispatchInbound(env2);
    await gateway2.drain(1000);

    const bundle2 = db.prepare("SELECT status, tokens_amount as tokens, tokens_committed FROM quota_bundles WHERE delivery_id = ?").get(env2.id) as any;
    expect(bundle2.status).toBe('released');
    expect(bundle2.tokens).toBe(10675); // ceil(max(4, 4096 floor, 8540 lastActual) * 1.25 growth) = 10675
  });

  it('redrive reuses existing bundle by delivery_id without allocating duplicate quota', async () => {
    const quotaRepo = operationsStorage.forTenant(testUserId).quota;
    await quotaRepo.setLimit({ resource: 'turns', limit: 2 });
    await quotaRepo.setLimit({ resource: 'messages', limit: 2 });
    await quotaRepo.setLimit({ resource: 'tokens', limit: 50000 });

    const executor = {
      execute: async () => ({
        replyText: 'Redriven reply',
        usage: { totalTokens: 50 },
      }),
      cancel: async () => true,
    };

    const gateway = new DeliveryRuntimeGateway({
      database: db,
      storage: platformStorage,
      messageStore,
      executor,
      quotaMode: 'enforced',
      quotaProvider,
        profileResolver: { resolve: async () => null }
      });

    const envelope = createEnvelope({ id: createValidDeliveryId() });

    // Step 1: Pre-reserve bundle and ingest turn into held state (simulating crash before processing)
    const tokenEst = estimateInboundTokens(envelope.content);
    const reservationTokens = Math.ceil(Math.max(tokenEst.estimatedTokens, 4096) * 1.25);
    await quotaProvider.reserve({
      userId: testUserId,
      sessionId: testSessionId,
      deliveryId: envelope.id,
      turns: 1,
      messages: 1,
      tokens: reservationTokens,
      isEstimateTokens: true,
      metadata: {
        estimatedTokens: reservationTokens,
        tokenCalculation: 'deterministic_char_estimate_bounded_4chars',
      },
    });

    const ingestRes = await messageStore.ingestWebDelivery({
      userId: testUserId,
      sessionId: testSessionId,
      spaceId: testSpaceId,
      dshSessionId: 'dsh_sess_e2e_authoritative',
      idempotencyKey: envelope.id,
      content: envelope.content,
      timestamp: envelope.timestamp,
    });

    // Step 2: Run startup redrive
    const redriveCount = await gateway.redriveHeld();
    expect(redriveCount).toBe(1);

    await gateway.drain(2000);

    // Step 3: Verify quota was only consumed once (turns: 1 used out of 2, remaining 1)
    const turnsUsage = await quotaRepo.getUsage('turns');
    expect(turnsUsage.used).toBe(1);
    expect(turnsUsage.remaining).toBe(1);

    const bundleRow = db.prepare("SELECT status FROM quota_bundles WHERE delivery_id = ?").get(envelope.id) as any;
    expect(bundleRow.status).toBe('committed');
  });

  it('releases quota immediately when ingest fails (e.g. space archived race)', async () => {
    const quotaRepo = operationsStorage.forTenant(testUserId).quota;
    await quotaRepo.setLimit({ resource: 'turns', limit: 5 });
    await quotaRepo.setLimit({ resource: 'messages', limit: 5 });
    await quotaRepo.setLimit({ resource: 'tokens', limit: 1000 });

    const executor = {
      execute: async () => ({ replyText: 'Never executed' }),
      cancel: async () => true,
    };

    const gateway = new DeliveryRuntimeGateway({
      database: db,
      storage: platformStorage,
      messageStore,
      executor,
      quotaMode: 'enforced',
      quotaProvider,
        profileResolver: { resolve: async () => null }
      });

    // Archive space before dispatch
    await platformStorage.forTenant(testUserId).spaces.update(testSpaceId, { status: 'archived' });

    const envelope = createEnvelope();
    await expect(gateway.dispatchInbound(envelope)).rejects.toThrow();

    // Verify zero quota reserved or used
    const usage = await quotaRepo.getUsage('turns');
    expect(usage.used).toBe(0);
    expect(usage.reserved).toBe(0);
    expect(usage.remaining).toBe(5);
  });

  it('enforces exact status handling: commit on committed is idempotent, release on committed leaves committed, commit on released throws', async () => {
    const quotaRepo = operationsStorage.forTenant(testUserId).quota;
    await quotaRepo.setLimit({ resource: 'turns', limit: 10 });
    await quotaRepo.setLimit({ resource: 'messages', limit: 10 });
    await quotaRepo.setLimit({ resource: 'tokens', limit: 1000 });

    const bundle = await quotaProvider.reserve({
      userId: testUserId,
      sessionId: testSessionId,
      deliveryId: createValidDeliveryId(),
      turns: 1,
      messages: 1,
      tokens: 100,
      isEstimateTokens: true,
    });

    // First commit -> commits cleanly
    await bundle.commit({ turns: 1, messages: 1, tokens: 100 });

    // Second commit on committed -> idempotent no-op
    await expect(bundle.commit({ turns: 1, messages: 1, tokens: 100 })).resolves.not.toThrow();

    // Release on committed -> leaves committed (safe no-op)
    await bundle.release();
    const rowCommitted = db.prepare("SELECT status FROM quota_bundles WHERE id = ?").get(bundle.reservationId) as any;
    expect(rowCommitted.status).toBe('committed');

    // Create a new bundle and release it
    const bundle2 = await quotaProvider.reserve({
      userId: testUserId,
      sessionId: testSessionId,
      deliveryId: createValidDeliveryId(),
      turns: 1,
      messages: 1,
      tokens: 100,
      isEstimateTokens: true,
    });

    await bundle2.release();
    const rowReleased = db.prepare("SELECT status FROM quota_bundles WHERE id = ?").get(bundle2.reservationId) as any;
    expect(rowReleased.status).toBe('released');

    // Commit on released bundle -> throws InvalidReservationError or PlatformError
    await expect(bundle2.commit({ turns: 1, messages: 1, tokens: 100 })).rejects.toThrow();
  });
});
