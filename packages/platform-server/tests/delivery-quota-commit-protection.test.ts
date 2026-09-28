import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import {
  DeliveryRuntimeGateway,
  SqliteWebMessageStore,
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  type TenantQuotaProvider,
  type QuotaReservationRequest,
} from '../src/index.js';
import type { InboundEnvelope } from '@enkeep/web-channel';

function createValidDeliveryId(): string {
  return `deliv_${randomUUID().replace(/-/g, '')}`;
}

describe('D1 Quota Commit Protection & Dynamic TTL in DeliveryRuntimeGateway', () => {
  const setupTestEnv = async () => {
    const db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    // Create user, space, and session route
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES ('u1', 'alice', 'hash', 'admin')").run();
    db.prepare("INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES ('sp1', 'u1', 'Space 1', 'space-1', 'container')").run();
    db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode) VALUES ('ses1', 'u1', 'sp1', 'web', 'web-demo', 'ses1', 'p1', 'dsh1', 'container')").run();

    const storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);
    const profileResolver = { resolve: async () => null };

    return { db, storage, messageStore, profileResolver };
  };

  const createSampleEnvelope = (overrides: Partial<InboundEnvelope> = {}): InboundEnvelope => {
    return {
      id: overrides.id ?? createValidDeliveryId(),
      userId: overrides.userId ?? 'u1',
      sessionId: overrides.sessionId ?? 'ses1',
      content: overrides.content ?? 'Analyze financial report for 25 minutes',
      timestamp: overrides.timestamp ?? new Date().toISOString(),
      ...overrides,
    };
  };

  it('dynamically computes and passes ttlSeconds based on turn timeout (default 1800s + 300s = 2100s)', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    let capturedRequest: QuotaReservationRequest | undefined;
    const quotaProvider: TenantQuotaProvider = {
      reserve: async (req) => {
        capturedRequest = req;
        return {
          reservationId: 'res-ttl-check',
          userId: req.userId,
          turns: req.turns,
          messages: req.messages,
          tokens: req.tokens,
          isEstimateTokens: req.isEstimateTokens,
          commit: async () => {},
          release: async () => {},
          renew: async () => {},
          commitInTransaction: () => {},
          releaseInTransaction: () => {},
        };
      },
    };

    const executor = {
      execute: async () => ({
        replyText: 'Analysis complete after long processing',
        usage: { totalTokens: 100 },
      }),
      cancel: async () => true,
    };

    const gateway = new DeliveryRuntimeGateway({
      database: db,
      storage,
      messageStore,
      executor,
      quotaMode: 'enforced',
      quotaProvider,
      profileResolver,
    });

    const envelope = createSampleEnvelope();
    const result = await gateway.dispatchInbound(envelope);
    expect(result.accepted).toBe(true);

    await gateway.drain(1000);

    expect(capturedRequest).toBeDefined();
    // Default interactive turn timeout is 1800000ms (1800s). TTL = 1800 + 300 = 2100s.
    expect(capturedRequest!.ttlSeconds).toBe(2100);
  });

  it('dynamically computes ttlSeconds for custom turn timeout (e.g. 600s + 300s = 900s)', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    let capturedRequest: QuotaReservationRequest | undefined;
    const quotaProvider: TenantQuotaProvider = {
      reserve: async (req) => {
        capturedRequest = req;
        return {
          reservationId: 'res-custom-ttl',
          userId: req.userId,
          turns: req.turns,
          messages: req.messages,
          tokens: req.tokens,
          isEstimateTokens: req.isEstimateTokens,
          commit: async () => {},
          release: async () => {},
          renew: async () => {},
          commitInTransaction: () => {},
          releaseInTransaction: () => {},
        };
      },
    };

    const executor = {
      execute: async () => ({
        replyText: 'Analysis complete',
        usage: { totalTokens: 50 },
      }),
      cancel: async () => true,
    };

    const gateway = new DeliveryRuntimeGateway({
      database: db,
      storage,
      messageStore,
      executor,
      quotaMode: 'enforced',
      quotaProvider,
      profileResolver,
    });

    const envelope = createSampleEnvelope();
    // Dispatch with explicit timeoutMs = 600000ms (10 minutes)
    const result = await gateway.dispatchInbound(envelope, { timeoutMs: 600000 });
    expect(result.accepted).toBe(true);

    await gateway.drain(1000);

    expect(capturedRequest).toBeDefined();
    // 600000ms / 1000 = 600s. TTL = 600 + 300 = 900s.
    expect(capturedRequest!.ttlSeconds).toBe(900);
  });

  it('guarantees assistant reply is preserved in web_messages and turn status is completed when quota commit fails', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    let commitCalled = false;
    let releaseCalled = false;

    const quotaProvider: TenantQuotaProvider = {
      reserve: async (req) => ({
        reservationId: 'res-expired-commit',
        userId: req.userId,
        turns: req.turns,
        messages: req.messages,
        tokens: req.tokens,
        isEstimateTokens: req.isEstimateTokens,
        commit: async () => {},
        release: async () => {},
        renew: async () => {},
        commitInTransaction: () => {
          commitCalled = true;
          // Simulate ReservationSettledError or ledger timeout
          throw new Error('ReservationSettledError: expired');
        },
        releaseInTransaction: () => {
          releaseCalled = true;
        },
      }),
    };

    const expectedReply = 'Here is the comprehensive 26-minute freight dispatch report for Bozhou transport.';
    const executor = {
      execute: async () => ({
        replyText: expectedReply,
        usage: { totalTokens: 4500 },
      }),
      cancel: async () => true,
    };

    const gateway = new DeliveryRuntimeGateway({
      database: db,
      storage,
      messageStore,
      executor,
      quotaMode: 'enforced',
      quotaProvider,
      profileResolver,
    });

    const envelope = createSampleEnvelope({ id: createValidDeliveryId() });
    const result = await gateway.dispatchInbound(envelope);
    const turnId = result.turnId!;

    // Drain captures the recorded settled error (warning) and may throw AggregateError
    try {
      await gateway.drain(1000);
    } catch {
      // Settled error is expected to be recorded for auditing
    }

    expect(commitCalled).toBe(true);
    // Quota reservation was released in transaction so quota is not leaked
    expect(releaseCalled).toBe(true);

    // CRITICAL D1 INVARIANT: Turn status MUST be 'completed', NOT 'failed'
    const turnRow = db.prepare('SELECT status, error FROM turn_runs WHERE turn_id = ?').get(turnId) as { status: string; error?: string };
    expect(turnRow.status).toBe('completed');

    // CRITICAL D1 INVARIANT: Assistant reply was NOT rolled back and is safely persisted
    const messages = await messageStore.listMessages('u1', 'ses1');
    const assistantMsg = messages.messages.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toBe(expectedReply);

    // Verify session execution lease was released
    const leaseRow = db.prepare('SELECT status FROM session_execution_leases WHERE turn_id = ?').get(turnId) as { status: string } | undefined;
    if (leaseRow) {
      expect(leaseRow.status).toBe('released');
    }
  });
});
