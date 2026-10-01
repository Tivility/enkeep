import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_INTERACTIVE_TURN_TIMEOUT_MS,
  DeliveryRuntimeGateway,
  DEFAULT_QUOTA_RESERVATION_GRACE_SECONDS,
  SqliteWebMessageStore,
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
} from '../src/index.js';
import {
  DEFAULT_TASK_EXECUTION_BUDGET_MS,
  MAX_TASK_TIMEOUT_MS,
  validateScriptTaskPayload,
  AgentPromptTaskWorker,
} from '@enkeep/platform-operations';
import {
  DEFAULT_STREAMING_MAX_DURATION_MS,
  DEFAULT_CONTINUATION_INACTIVITY_TIMEOUT_MS,
} from '@enkeep/channel-lark';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';

describe('60-Minute Duration Cap Alignment across Subsystems (Issue I1 / Developer F1)', () => {
  it('1. verifies core duration cap constants default consistently to 3,600,000 ms (60 minutes)', () => {
    expect(DEFAULT_INTERACTIVE_TURN_TIMEOUT_MS).toBe(3_600_000);
    expect(DEFAULT_TASK_EXECUTION_BUDGET_MS).toBe(3_600_000);
    expect(MAX_TASK_TIMEOUT_MS).toBe(3_600_000);
    expect(DEFAULT_STREAMING_MAX_DURATION_MS).toBe(3_600_000);
    expect(DEFAULT_CONTINUATION_INACTIVITY_TIMEOUT_MS).toBe(3_600_000);
  });

  it('2. verifies quota reservation TTL is derived = budget (3600s) + grace (300s) = 3900s', async () => {
    const db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES ('u_synth_1', 'alice', 'hash', 'admin')").run();
    db.prepare("INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES ('spc_synth_1', 'u_synth_1', 'Space 1', 'space-1', 'container')").run();
    db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode) VALUES ('ses_synth_1', 'u_synth_1', 'spc_synth_1', 'web', 'web-demo', 'ses_synth_1', 'p1', 'dsh1', 'container')").run();

    const storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);
    let capturedTtlSeconds: number | undefined;

    const quotaProvider = {
      reserve: async (req: any) => {
        capturedTtlSeconds = req.ttlSeconds;
        return {
          reservationId: 'qrs_test_000000000000000000000001',
          userId: req.userId,
          turns: 1,
          messages: 1,
          tokens: req.tokens,
          isEstimateTokens: true,
          commit: async () => {},
          release: async () => {},
          renew: async () => {},
          commitInTransaction: () => {},
          releaseInTransaction: () => {},
        };
      },
    };

    const gateway = new DeliveryRuntimeGateway({
      database: db,
      storage,
      messageStore,
      executor: {
        execute: async () => ({ replyText: 'response text', usage: { totalTokens: 10 } }),
        cancel: async () => true,
      },
      quotaMode: 'enforced',
      quotaProvider,
      profileResolver: { resolve: async () => null },
    });

    const result = await gateway.dispatchInbound({
      id: 'deliv_synth_0000000000000000000001',
      userId: 'u_synth_1',
      sessionId: 'ses_synth_1',
      content: 'Hello, please run test',
      timestamp: new Date().toISOString(),
    });

    expect(result.accepted).toBe(true);
    await gateway.drain(1000);

    expect(DEFAULT_QUOTA_RESERVATION_GRACE_SECONDS).toBe(300);
    // 3600 seconds (60 min) + 300 seconds grace = 3900 seconds
    expect(capturedTtlSeconds).toBe(3900);
  });

  it('3. verifies task validators allow 3,600,000 ms and reject 3,600,001 ms', () => {
    const validPayload = validateScriptTaskPayload({
      type: 'script',
      command: 'echo synthetic_test',
      spaceId: 'spc_00000000000000000000000000000001',
      timeoutMs: 3_600_000,
    });
    expect(validPayload.timeoutMs).toBe(3_600_000);

    expect(() =>
      validateScriptTaskPayload({
        type: 'script',
        command: 'echo synthetic_test',
        spaceId: 'spc_00000000000000000000000000000001',
        timeoutMs: 3_600_001,
      })
    ).toThrow(/Invalid timeoutMs: must be a positive integer <= 3600000/);
  });

  it('4. verifies TaskWorker defaults defaultExecutionBudgetMs to 3,600,000 ms', () => {
    const worker = new AgentPromptTaskWorker({
      workerId: 'worker_synth_budget_check',
      tenantEnumerator: () => ['user-synth-alice'],
      getTenantOperations: () => ({
        tasks: {
          claimPendingTask: async () => null,
          recoverInterruptedTasks: async () => [],
        } as any,
      }),
      dispatcher: { dispatch: async () => ({ status: 'completed' }) },
    });

    expect((worker as any).defaultExecutionBudgetMs).toBe(3_600_000);
  });
});
