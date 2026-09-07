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
} from '@enkeep/platform-operations';
import {
  OperationsTenantQuotaProvider,
  createOperationsTenantQuotaProvider,
} from '../src/operations/tenant-quota-provider.js';
import {
  DeliveryRuntimeGateway,
  SqliteWebMessageStore,
  computeTurnReservationTokens,
  estimateInboundTokens,
  type TurnExecutionResult,
} from '../src/index.js';
import type { InboundEnvelope } from '@enkeep/web-channel';

function createValidDeliveryId(): string {
  return `deliv_${randomUUID().replace(/-/g, '')}`;
}

describe('Quota Preflight Token Estimation & Underestimate Overage Safe Delivery', () => {
  let db: DatabaseSync;
  let platformStorage: SqlitePlatformStorage;
  let operationsStorage: SqlitePlatformOperationsStorage;
  let operationsService: PlatformOperationsService;
  let quotaProvider: OperationsTenantQuotaProvider;
  let messageStore: SqliteWebMessageStore;

  const testUserId = 'user_quota_preflight_01';
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
      username: 'preflight_user',
      passwordHash: 'hash',
      role: 'user',
      status: 'active',
    });

    // Create active space
    await platformStorage.forTenant(testUserId).spaces.create({
      id: testSpaceId,
      name: 'Preflight Space',
      folder: 'preflight-space',
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
      dshSessionId: 'dsh_sess_preflight_authoritative',
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
    } catch {}
  });

  function createEnvelope(overrides: Partial<InboundEnvelope> = {}): InboundEnvelope {
    const id = overrides.id ?? createValidDeliveryId();
    return {
      id,
      userId: overrides.userId ?? testUserId,
      sessionId: overrides.sessionId ?? testSessionId,
      content: overrides.content ?? 'Hello assistant, please assist with quota verification.',
      timestamp: overrides.timestamp ?? new Date().toISOString(),
      ...overrides,
    };
  }

  describe('1. Pure Preflight Calculation Unit Tests', () => {
    it('computes conservative reservation using floor, inbound, lastActual, growth factor, and ceiling', () => {
      // First turn: inbound=10, lastActual=0 -> base=max(10, 4096, 0)=4096 -> ceil(4096 * 1.25) = 5120
      expect(computeTurnReservationTokens({ inboundTokens: 10 })).toBe(5120);

      // Large inbound: inbound=10000 -> base=max(10000, 4096, 0)=10000 -> ceil(10000 * 1.25) = 12500
      expect(computeTurnReservationTokens({ inboundTokens: 10000 })).toBe(12500);

      // Subsequent turn with lastActual=14584: base=max(6, 4096, 14584)=14584 -> ceil(14584 * 1.25) = 18230
      expect(computeTurnReservationTokens({ inboundTokens: 6, lastCommittedTokens: 14584 })).toBe(18230);

      // Custom floor and growth factor
      expect(computeTurnReservationTokens({
        inboundTokens: 10,
        floor: 1000,
        growthFactor: 1.5,
      })).toBe(1500);

      // Ceiling clamping
      expect(computeTurnReservationTokens({
        inboundTokens: 100000,
        ceiling: 64000,
      })).toBe(64000);
    });
  });

  describe('2. Real Preflight Rejection BEFORE Executor Call (Zero Provider Cost Lost)', () => {
    it('fails turn at claim preflight before executor when remaining tokens < estimated reservation', async () => {
      const quotaRepo = operationsStorage.forTenant(testUserId).quota;
      await quotaRepo.setLimit({ resource: 'turns', limit: 10 });
      await quotaRepo.setLimit({ resource: 'messages', limit: 10 });
      // Set remaining tokens limit to 3000 (which is less than initial estimate 5120)
      await quotaRepo.setLimit({ resource: 'tokens', limit: 3000 });

      let executorCalled = false;
      const executor = {
        execute: async (): Promise<TurnExecutionResult> => {
          executorCalled = true;
          return {
            replyText: 'This should NEVER be generated',
            usage: { totalTokens: 100 },
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
        profileResolver: { resolve: async () => null },
      });

      const envelope = createEnvelope({ content: 'Short prompt' });
      const dispatchRes = await gateway.dispatchInbound(envelope);
      expect(dispatchRes.accepted).toBe(true);

      await gateway.drain(1000);

      // CRITICAL GUARANTEE: Executor was NEVER called!
      expect(executorCalled).toBe(false);

      // Verify turn status is 'failed'
      const turnStatus = await gateway.getTurnStatus(testUserId, dispatchRes.turnId!);
      expect(turnStatus.status).toBe('failed');

      // Verify turn_runs recorded 'Quota exceeded'
      const turnRow = db.prepare('SELECT status, error FROM turn_runs WHERE turn_id = ?').get(dispatchRes.turnId!) as any;
      expect(turnRow.status).toBe('failed');
      expect(turnRow.error).toBe('Quota exceeded');

      // Verify delivery_inbox recorded 'failed'
      const inboxRow = db.prepare('SELECT status FROM delivery_inbox WHERE turn_id = ?').get(dispatchRes.turnId!) as any;
      expect(inboxRow.status).toBe('failed');

      // Verify ZERO assistant messages written
      const assistantCount = (db.prepare("SELECT COUNT(*) as c FROM web_messages WHERE user_id = ? AND role = 'assistant'").get(testUserId) as any).c;
      expect(assistantCount).toBe(0);

      // Verify web_events emitted 'turn_failed' with QUOTA_EXCEEDED code
      const failEventRow = db.prepare("SELECT payload FROM web_events WHERE user_id = ? AND type = 'turn_failed' ORDER BY created_at DESC LIMIT 1").get(testUserId) as any;
      expect(failEventRow).toBeDefined();
      const failPayload = JSON.parse(failEventRow.payload);
      expect(failPayload.code).toBe('QUOTA_EXCEEDED');
    });

    it('rejects subsequent turn when previous turn token history causes estimate to exceed remaining quota', async () => {
      const quotaRepo = operationsStorage.forTenant(testUserId).quota;
      await quotaRepo.setLimit({ resource: 'turns', limit: 10 });
      await quotaRepo.setLimit({ resource: 'messages', limit: 10 });
      // User has 20,000 token limit
      await quotaRepo.setLimit({ resource: 'tokens', limit: 20000 });

      let turnCount = 0;
      const executor = {
        execute: async (): Promise<TurnExecutionResult> => {
          turnCount++;
          return {
            replyText: `Turn ${turnCount} completed reply`,
            usage: { totalTokens: 14000 },
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
        profileResolver: { resolve: async () => null },
      });

      // Turn 1: estimate is 5120 tokens. Remaining is 20000 -> succeeds!
      const env1 = createEnvelope({ content: 'Turn 1 prompt' });
      await gateway.dispatchInbound(env1);
      await gateway.drain(1000);

      expect(turnCount).toBe(1);
      const usage1 = await quotaRepo.getUsage('tokens');
      expect(usage1.used).toBe(14000);
      expect(usage1.remaining).toBe(6000); // 20000 - 14000 = 6000 remaining

      // Turn 2: Preflight queries lastActual = 14000 -> estimate is ceil(14000 * 1.25) = 17500!
      // Remaining is 6000 < 17500 -> preflight reservation MUST fail immediately before executor!
      const env2 = createEnvelope({ content: 'Turn 2 prompt' });
      const disp2 = await gateway.dispatchInbound(env2);
      await gateway.drain(1000);

      // Executor was NOT called for Turn 2!
      expect(turnCount).toBe(1);

      const turn2Status = await gateway.getTurnStatus(testUserId, disp2.turnId!);
      expect(turn2Status.status).toBe('failed');

      // Turn 1 assistant message is intact, Turn 2 assistant message does not exist
      const messages = await messageStore.listMessages(testUserId, testSessionId, { limit: 10 });
      const assistantMsgs = messages.messages.filter((m) => m.role === 'assistant');
      expect(assistantMsgs.length).toBe(1);
      expect(assistantMsgs[0].content).toBe('Turn 1 completed reply');
    });
  });

  describe('3. Underestimate Overage Safe Delivery & Subsequent Turn Blocking', () => {
    it('when actual tokens exceed remaining quota due to estimation delta, delivers assistant reply, records overage, and blocks subsequent turn', async () => {
      const quotaRepo = operationsStorage.forTenant(testUserId).quota;
      await quotaRepo.setLimit({ resource: 'turns', limit: 10 });
      await quotaRepo.setLimit({ resource: 'messages', limit: 10 });
      // Set token limit to 8,000 tokens
      await quotaRepo.setLimit({ resource: 'tokens', limit: 8000 });

      let executorRunCount = 0;
      const executor = {
        execute: async (): Promise<TurnExecutionResult> => {
          executorRunCount++;
          // LLM executes and uses 9,500 tokens (more than the 8,000 tenant limit!)
          return {
            replyText: 'Successfully generated high-value assistant response',
            usage: { totalTokens: 9500 },
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
        profileResolver: { resolve: async () => null },
      });

      // Turn 1: preflight estimated 5,120 tokens (<= 8,000 limit) -> starts execution!
      const env1 = createEnvelope({ content: 'Inbound prompt' });
      const disp1 = await gateway.dispatchInbound(env1);
      await gateway.drain(1000);

      expect(executorRunCount).toBe(1);

      // Turn 1 state must be 'completed' (NOT failed, zero reply loss!)
      const turn1Status = await gateway.getTurnStatus(testUserId, disp1.turnId!);
      expect(turn1Status.status).toBe('completed');

      // Assistant message is delivered
      const history1 = await messageStore.listMessages(testUserId, testSessionId, { limit: 10 });
      const assistant1 = history1.messages.find((m) => m.role === 'assistant');
      expect(assistant1).toBeDefined();
      expect(assistant1?.content).toBe('Successfully generated high-value assistant response');
      expect(assistant1?.status).toBe('delivered');

      // Quota usage reflects 9,500 used (exceeds 8,000 limit, remaining = 0, allowed = false)
      const tokenUsageAfter = await quotaRepo.getUsage('tokens');
      expect(tokenUsageAfter.used).toBe(9500);
      expect(tokenUsageAfter.limit).toBe(8000);
      expect(tokenUsageAfter.remaining).toBe(0);
      expect(tokenUsageAfter.allowed).toBe(false);

      // Verify quota bundle recorded 9500 tokens committed
      const bundle1 = db.prepare('SELECT status, tokens_amount, tokens_committed FROM quota_bundles WHERE delivery_id = ?').get(env1.id) as any;
      expect(bundle1.status).toBe('committed');
      expect(bundle1.tokens_amount).toBe(5120);
      expect(bundle1.tokens_committed).toBe(9500);

      // Turn 2: Attempt another turn on the exhausted tenant
      const env2 = createEnvelope({ content: 'Follow-up prompt' });
      const disp2 = await gateway.dispatchInbound(env2);
      await gateway.drain(1000);

      // Turn 2 executor was NOT called!
      expect(executorRunCount).toBe(1);

      // Turn 2 is failed with QUOTA_EXCEEDED
      const turn2Status = await gateway.getTurnStatus(testUserId, disp2.turnId!);
      expect(turn2Status.status).toBe('failed');
    });
  });

  describe('4. Strict Fail for Non-Estimate Reservations', () => {
    it('strict non-estimate token reservation fails closed when actual usage exceeds limit', async () => {
      const quotaRepo = operationsStorage.forTenant(testUserId).quota;
      await quotaRepo.setLimit({ resource: 'turns', limit: 10 });
      await quotaRepo.setLimit({ resource: 'messages', limit: 10 });
      await quotaRepo.setLimit({ resource: 'tokens', limit: 1000 });

      const bundle = await quotaRepo.reserveBundle({
        sessionId: testSessionId,
        deliveryId: createValidDeliveryId(),
        turns: 1,
        messages: 1,
        tokens: 500,
        isEstimateTokens: false, // Strict non-estimate!
      });

      // Commit exceeding limit (1500 > 1000) -> throws QuotaExceededError
      await expect(
        quotaRepo.commitBundle({
          bundleId: bundle.id,
          actualUsage: { turns: 1, messages: 1, tokens: 1500 },
        })
      ).rejects.toThrow(QuotaExceededError);

      // Bundle remains in reserved status
      const bundleRow = await quotaRepo.findBundleById(bundle.id);
      expect(bundleRow?.status).toBe('reserved');
    });
  });

  describe('5. Multi-Turn Sequential Historical Tracking', () => {
    it('tracks lastCommittedTokens across multiple sequential turns in a session', async () => {
      const quotaRepo = operationsStorage.forTenant(testUserId).quota;
      await quotaRepo.setLimit({ resource: 'turns', limit: 10 });
      await quotaRepo.setLimit({ resource: 'messages', limit: 10 });
      await quotaRepo.setLimit({ resource: 'tokens', limit: 1000000 });

      const turnActuals = [2000, 5000, 12000];
      let currentTurnIndex = 0;

      const executor = {
        execute: async (): Promise<TurnExecutionResult> => {
          const usageTokens = turnActuals[currentTurnIndex] || 1000;
          currentTurnIndex++;
          return {
            replyText: `Reply for turn ${currentTurnIndex}`,
            usage: { totalTokens: usageTokens },
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
        profileResolver: { resolve: async () => null },
      });

      // Turn 1: estimate = 5120, actual = 2000
      const env1 = createEnvelope({ content: 'T1' });
      await gateway.dispatchInbound(env1);
      await gateway.drain(1000);

      const b1 = db.prepare('SELECT tokens_amount, tokens_committed FROM quota_bundles WHERE delivery_id = ?').get(env1.id) as any;
      expect(b1.tokens_amount).toBe(5120);
      expect(b1.tokens_committed).toBe(2000);

      // Turn 2: lastActual = 2000 -> base = max(1, 4096, 2000) = 4096 -> estimate = 5120, actual = 5000
      const env2 = createEnvelope({ content: 'T2' });
      await gateway.dispatchInbound(env2);
      await gateway.drain(1000);

      const b2 = db.prepare('SELECT tokens_amount, tokens_committed FROM quota_bundles WHERE delivery_id = ?').get(env2.id) as any;
      expect(b2.tokens_amount).toBe(5120);
      expect(b2.tokens_committed).toBe(5000);

      // Turn 3: lastActual = 5000 -> base = max(1, 4096, 5000) = 5000 -> estimate = ceil(5000 * 1.25) = 6250, actual = 12000
      const env3 = createEnvelope({ content: 'T3' });
      await gateway.dispatchInbound(env3);
      await gateway.drain(1000);

      const b3 = db.prepare('SELECT tokens_amount, tokens_committed FROM quota_bundles WHERE delivery_id = ?').get(env3.id) as any;
      expect(b3.tokens_amount).toBe(6250);
      expect(b3.tokens_committed).toBe(12000);

      // Verify total usage = 2000 + 5000 + 12000 = 19000
      const totalTokens = await quotaRepo.getUsage('tokens');
      expect(totalTokens.used).toBe(19000);
    });
  });
});
