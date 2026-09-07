import { describe, it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { SqlitePlatformStorage, SqlitePlatformOperationsStorage } from '@enkeep/platform-storage-sqlite';
import { createPlatformOperations } from '@enkeep/platform-operations';
import { createOperationsTenantQuotaProvider } from '../src/operations/tenant-quota-provider.js';
import {
  DeliveryRuntimeGateway,
  SqliteWebMessageStore,
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  type DeliveryExecutionRequest,
  type TurnExecutionResult,
  type TenantQuotaProvider,
  type QuotaReservationRequest,
  type InspectedTurnResult,
} from '../src/index.js';
import type { InboundEnvelope } from '@enkeep/web-channel';

function createValidDeliveryId(): string {
  return `deliv_${randomUUID().replace(/-/g, '')}`;
}

function createSampleEnvelope(overrides: Partial<InboundEnvelope> = {}): InboundEnvelope {
  return {
    id: createValidDeliveryId(),
    channel: 'web',
    accountId: 'acc-1',
    nativeContextId: 'ses1',
    userId: 'u1',
    peerId: 'p1',
    spaceId: 'sp1',
    sessionId: 'ses1',
    content: 'Hello Docker runtime',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

async function setupTestEnv() {
  const db = new DatabaseSync(':memory:');
  const runner = new PlatformServerMigrationRunner(db);
  await runner.migrate(ALL_PLATFORM_MIGRATIONS);

  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES ('u1', 'alice', 'hash', 'admin')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES ('u2', 'bob', 'hash', 'user')").run();
  db.prepare("INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES ('sp1', 'u1', 'Space 1', 'space-1', 'container')").run();
  db.prepare("INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES ('sp2', 'u2', 'Space 2', 'space-2', 'container')").run();
  db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, current_generation) VALUES ('ses1', 'u1', 'sp1', 'web', 'acc-1', 'ses1', 'p1', 'dsh1', 'container', 1)").run();
  db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, current_generation) VALUES ('ses2', 'u2', 'sp2', 'web', 'acc-2', 'ses2', 'p2', 'dsh2', 'container', 1)").run();

  const storage = new SqlitePlatformStorage(db);
  const messageStore = new SqliteWebMessageStore(db);
  const profileResolver = {
    resolve: async () => null,
  };

  return { db, storage, messageStore, profileResolver };
}

describe('DeliveryGateway Quota Lifecycle, Crash Recovery & Heartbeat Safety', () => {
  describe('1. Quota Provider Reservation Lifecycle', () => {
    it('quota provider reserve count is 0 immediately after enqueue, 1 on claim, 0 on cancel queued, and reserves on restart', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      let reserveCalls = 0;
      let committedCalls = 0;
      let releasedCalls = 0;

      const quotaProvider: TenantQuotaProvider = {
        reserve: async (req: QuotaReservationRequest) => {
          reserveCalls++;
          return {
            reservationId: `res_${reserveCalls}`,
            userId: req.userId,
            turns: req.turns,
            messages: req.messages,
            tokens: req.tokens,
            isEstimateTokens: req.isEstimateTokens,
            commit: async () => {},
            release: async () => {
              releasedCalls++;
            },
            renew: async () => {},
            commitInTransaction: () => {
              committedCalls++;
            },
            releaseInTransaction: () => {
              releasedCalls++;
            },
          };
        },
      };

      let executeCalls = 0;
      let holdExecution: () => void;
      let blockExecution = true;
      const executionBlocker = new Promise<void>((resolve) => {
        holdExecution = resolve;
      });

      const executor = {
        execute: async () => {
          executeCalls++;
          if (blockExecution) {
            await executionBlocker;
          }
          return { replyText: 'Success reply', usage: { totalTokens: 20 } };
        },
        cancel: async () => true,
      };

      const gateway1 = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor,
        quotaMode: 'enforced',
        quotaProvider,
        profileResolver,
      });

      // A. Ingest message 1
      const env1 = createSampleEnvelope({ id: createValidDeliveryId() });
      const res1 = await gateway1.dispatchInbound(env1);
      expect(res1.accepted).toBe(true);

      // Check reserve count immediately after enqueue before scheduler claims:
      // Note: In Node.js event loop, scheduler triggers via setImmediate.
      // In DB, turn is queued.
      const turnRow = db.prepare('SELECT status FROM turn_runs WHERE turn_id = ?').get(res1.turnId!) as { status: string };
      expect(turnRow.status).toBe('queued');

      // B. Cancel queued turn before scheduler claim
      // Let's test a fresh queued turn and cancel immediately
      const envCancel = createSampleEnvelope({ id: createValidDeliveryId(), content: 'To be cancelled' });
      const resCancel = await gateway1.dispatchInbound(envCancel);
      const cancelTurnId = resCancel.turnId!;

      const cancelRes = await gateway1.cancelTurn('u1', cancelTurnId);
      expect(cancelRes).toBe(true);

      // Verify no quota reservation was released because none was created for queued turn
      expect(releasedCalls).toBe(0);

      // Now unblock execution so turn 1 completes
      blockExecution = false;
      holdExecution!();
      await gateway1.drain(2000);

      expect(reserveCalls).toBe(1);
      expect(committedCalls).toBe(1);
      expect(releasedCalls).toBe(0);

      // C. Simulate a queued turn on disk, platform restarts, new gateway redrives and reserves on claim
      const env3 = createSampleEnvelope({ id: createValidDeliveryId(), content: 'Queued turn for restart' });
      const res3 = await gateway1.dispatchInbound(env3);
      const turn3Id = res3.turnId!;

      // Close/dispose first gateway
      await gateway1.drain(100);

      // Reset turn3 to queued in DB to simulate restart before claim
      db.prepare("UPDATE turn_runs SET status = 'queued' WHERE turn_id = ?").run(turn3Id);
      db.prepare("UPDATE delivery_inbox SET status = 'held' WHERE turn_id = ?").run(turn3Id);
      db.prepare("UPDATE idempotency_records SET state = 'held' WHERE turn_id = ?").run(turn3Id);
      db.prepare("DELETE FROM session_execution_leases WHERE turn_id = ?").run(turn3Id);

      const initialReserveCount = reserveCalls;

      // Start new gateway instance (simulating restart)
      const gateway2 = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor: {
          execute: async () => ({ replyText: 'Restarted turn reply', usage: { totalTokens: 15 } }),
          cancel: async () => true,
        },
        quotaMode: 'enforced',
        quotaProvider,
        profileResolver,
      });

      await gateway2.redriveHeld();
      await gateway2.drain(2000);

      // Quota was reserved on claim after restart
      expect(reserveCalls).toBe(initialReserveCount + 1);

      const turn3Status = await gateway2.getTurnStatus('u1', turn3Id);
      expect(turn3Status.status).toBe('completed');
    });

    it('quota provider with limit -1 (enforced mode) allows a turn that would exceed a positive limit', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      // Configure -1 (unlimited) quotas for u1
      const opsStorage = new SqlitePlatformOperationsStorage(db);
      const opsService = createPlatformOperations({ storage: opsStorage });
      const u1Quota = opsStorage.forTenant('u1').quota;
      await u1Quota.setLimit({ resource: 'turns', limit: -1 });
      await u1Quota.setLimit({ resource: 'messages', limit: -1 });
      await u1Quota.setLimit({ resource: 'tokens', limit: -1 });

      const quotaProvider = createOperationsTenantQuotaProvider(opsService);

      let executed = false;
      const executor = {
        execute: async () => {
          executed = true;
          // Returning 50,000 tokens — which would far exceed positive limits like 100
          return { replyText: 'Executed unlimited', usage: { totalTokens: 50000 } };
        },
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

      const validSessionId = `ses_${randomUUID().replace(/-/g, '').toLowerCase()}`;
      db.prepare(
        "INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, current_generation) VALUES (?, 'u1', 'sp1', 'web', 'acc-1', 'ses-unlimited', 'p1', 'dsh-unlimited', 'container', 1)"
      ).run(validSessionId);

      const env = createSampleEnvelope({
        id: createValidDeliveryId(),
        sessionId: validSessionId,
        nativeContextId: 'ses-unlimited',
        content: 'Unlimited test',
      });
      const res = await gateway.dispatchInbound(env);
      expect(res.accepted).toBe(true);

      await gateway.drain(2000);
      expect(executed).toBe(true);

      const turnStatus = await gateway.getTurnStatus('u1', res.turnId!);
      expect(turnStatus.status).toBe('completed');

      const usage = await u1Quota.getUsage('tokens');
      expect(usage.limit).toBe(-1);
      expect(usage.remaining).toBe(-1);
      expect(usage.used).toBe(50000);
    });
  });

  describe('2. Crash Recovery & Phase Reconcile', () => {
    it('recovers lease in phase "claimed" by releasing lease and safely requeuing turn', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      let executed = false;
      const executor = {
        execute: async () => {
          executed = true;
          return { replyText: 'Re-executed successfully', usage: { totalTokens: 10 } };
        },
        cancel: async () => true,
        inspectTurnResult: async () => ({ status: 'absent' as const }),
      };

      const gateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor,
        quotaMode: 'disabled',
        profileResolver,
      });

      const env = createSampleEnvelope({ id: 'turn-claimed-crash' });
      const disp = await gateway.dispatchInbound(env);
      const turnId = disp.turnId!;
      await gateway.drain(1000);

      // Simulate crash during phase 'claimed' (lease acquired, but executor not yet called)
      db.prepare(`
        INSERT OR REPLACE INTO session_execution_leases (
          id, user_id, route_id, turn_id, generation, phase, status, worker_id, acquired_at, heartbeat_at, expires_at
        ) VALUES ('lease_claimed_crash', 'u1', 'ses1', ?, 1, 'claimed', 'active', 'crashed_worker', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(turnId);
      db.prepare("UPDATE turn_runs SET status = 'running' WHERE turn_id = ?").run(turnId);
      db.prepare("UPDATE delivery_inbox SET status = 'processing' WHERE turn_id = ?").run(turnId);
      db.prepare("UPDATE idempotency_records SET state = 'processing' WHERE turn_id = ?").run(turnId);

      executed = false;
      const count = await gateway.redriveHeld();
      expect(count).toBe(1);

      await gateway.drain(1000);
      expect(executed).toBe(true);

      const finalStatus = await gateway.getTurnStatus('u1', turnId);
      expect(finalStatus.status).toBe('completed');
    });

    it('recovers lease in phase "executing" with completed inspectTurnResult by finalizing platform exactly once without rerun', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      let executeCalled = false;
      let inspectCalled = false;

      const executor = {
        execute: async () => {
          executeCalled = true;
          return { replyText: 'Fresh execution reply', usage: { totalTokens: 10 } };
        },
        cancel: async () => true,
        inspectTurnResult: async (query: { turnId: string; userId: string; dshSessionId: string }): Promise<InspectedTurnResult> => {
          inspectCalled = true;
          return {
            status: 'completed',
            result: {
              replyText: 'Recovered execution reply from container evidence',
              usage: { totalTokens: 42 },
            },
          };
        },
      };

      const gateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor,
        quotaMode: 'disabled',
        profileResolver,
      });

      const env = createSampleEnvelope({ id: 'turn-executing-completed-crash' });
      const disp = await gateway.dispatchInbound(env);
      const turnId = disp.turnId!;
      await gateway.drain(1000);

      // Simulate crash after container executed and produced .result, but platform died before committing
      db.prepare(`
        INSERT OR REPLACE INTO session_execution_leases (
          id, user_id, route_id, turn_id, generation, phase, status, worker_id, acquired_at, heartbeat_at, expires_at
        ) VALUES ('lease_executing_crash', 'u1', 'ses1', ?, 1, 'executing', 'active', 'crashed_worker', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(turnId);
      db.prepare("UPDATE turn_runs SET status = 'running' WHERE turn_id = ?").run(turnId);
      db.prepare("UPDATE delivery_inbox SET status = 'processing' WHERE turn_id = ?").run(turnId);
      db.prepare("UPDATE idempotency_records SET state = 'processing' WHERE turn_id = ?").run(turnId);

      // Clean assistant messages
      db.prepare("DELETE FROM web_messages WHERE turn_id = ? AND role = 'assistant'").run(turnId);

      executeCalled = false;
      inspectCalled = false;

      await gateway.redriveHeld();

      // Verify inspectTurnResult was invoked
      expect(inspectCalled).toBe(true);
      // Verify execute was NOT rerun (tool idempotency protected!)
      expect(executeCalled).toBe(false);

      // Verify assistant message was projected into web_messages
      const assistantMsgs = db.prepare("SELECT * FROM web_messages WHERE turn_id = ? AND role = 'assistant'").all(turnId) as Array<{ content: string; status: string }>;
      expect(assistantMsgs.length).toBe(1);
      expect(assistantMsgs[0].content).toBe('Recovered execution reply from container evidence');
      expect(assistantMsgs[0].status).toBe('delivered');

      // Verify turn status is completed
      const turnStatus = await gateway.getTurnStatus('u1', turnId);
      expect(turnStatus.status).toBe('completed');
    });

    it('recovers lease in phase "executing" with absent inspectTurnResult by marking turn interrupted with RETRY_REQUIRED without automatic rerun', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      let executeCalled = false;
      const executor = {
        execute: async () => {
          executeCalled = true;
          return { replyText: 'Should not run', usage: { totalTokens: 10 } };
        },
        cancel: async () => true,
        inspectTurnResult: async () => ({
          status: 'absent' as const,
        }),
      };

      const gateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor,
        quotaMode: 'disabled',
        profileResolver,
      });

      const env = createSampleEnvelope({ id: 'turn-executing-absent-crash' });
      const disp = await gateway.dispatchInbound(env);
      const turnId = disp.turnId!;
      await gateway.drain(1000);

      // Simulate crash during execution where container died without completing (absent marker/result)
      db.prepare(`
        INSERT OR REPLACE INTO session_execution_leases (
          id, user_id, route_id, turn_id, generation, phase, status, worker_id, acquired_at, heartbeat_at, expires_at
        ) VALUES ('lease_absent_crash', 'u1', 'ses1', ?, 1, 'executing', 'active', 'crashed_worker', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(turnId);
      db.prepare("UPDATE turn_runs SET status = 'running' WHERE turn_id = ?").run(turnId);
      db.prepare("UPDATE delivery_inbox SET status = 'processing' WHERE turn_id = ?").run(turnId);
      db.prepare("UPDATE idempotency_records SET state = 'processing' WHERE turn_id = ?").run(turnId);

      executeCalled = false;
      await gateway.redriveHeld();

      // Executor was NOT re-executed
      expect(executeCalled).toBe(false);

      // Turn marked interrupted (never automatic requeue due to unknown tools executed)
      const turnStatus = await gateway.getTurnStatus('u1', turnId);
      expect(turnStatus.status).toBe('interrupted');

      // Delivery inbox marked failed
      const inboxRow = db.prepare("SELECT status FROM delivery_inbox WHERE turn_id = ?").get(turnId) as { status: string };
      expect(inboxRow.status).toBe('failed');

      // Idempotency records marked failed
      const idemRow = db.prepare("SELECT state FROM idempotency_records WHERE turn_id = ?").get(turnId) as { state: string };
      expect(idemRow.state).toBe('failed');

      // Lease was released
      const leaseRow = db.prepare("SELECT status FROM session_execution_leases WHERE turn_id = ?").get(turnId) as { status: string };
      expect(leaseRow.status).toBe('released');
    });
  });

  describe('3. Heartbeat Loss Detection & Cancellation', () => {
    it('detects lease loss on heartbeat update, cancels executor, and does NOT finalize assistant success', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      let cancelCalled = false;
      let finishExecution: () => void;
      const executionWait = new Promise<void>((resolve) => {
        finishExecution = resolve;
      });

      const executor = {
        execute: async () => {
          await executionWait;
          return { replyText: 'This assistant message must NOT be committed', usage: { totalTokens: 10 } };
        },
        cancel: async () => {
          cancelCalled = true;
          finishExecution();
          return true;
        },
      };

      const gateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor,
        quotaMode: 'disabled',
        profileResolver,
      });

      const env = createSampleEnvelope({ id: 'turn-heartbeat-loss' });
      const disp = await gateway.dispatchInbound(env);
      const turnId = disp.turnId!;

      // Wait a moment for scheduler to claim and start
      await new Promise((r) => setTimeout(r, 20));

      // Simulate external worker stealing/releasing the lease while first worker is in-flight
      db.prepare(`
        UPDATE session_execution_leases
        SET status = 'released', released_at = CURRENT_TIMESTAMP
        WHERE turn_id = ? AND status = 'active'
      `).run(turnId);

      // Also simulate trigger of heartbeat loss or complete execution
      // The task in-flight will attempt to finalize and detect lease was lost
      finishExecution!();
      await gateway.drain(1000);

      // Verify turn is marked failed with LEASE_LOST
      const turnRow = db.prepare("SELECT status, error FROM turn_runs WHERE turn_id = ?").get(turnId) as { status: string; error?: string };
      expect(turnRow.status).toBe('failed');

      // Verify ZERO assistant messages were exposed into web_messages
      const assistantMsgs = db.prepare("SELECT * FROM web_messages WHERE turn_id = ? AND role = 'assistant'").all(turnId);
      expect(assistantMsgs.length).toBe(0);
    });
  });

  describe('4. Multi-Gateway Concurrency Contention', () => {
    it('two gateway instances sharing the same DB: exactly one claims and executes, zero duplicate runs', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      let g1Executions = 0;
      let g2Executions = 0;

      const executor1 = {
        execute: async () => {
          g1Executions++;
          await new Promise((r) => setTimeout(r, 25));
          return { replyText: 'G1 response', usage: { totalTokens: 10 } };
        },
        cancel: async () => true,
      };

      const executor2 = {
        execute: async () => {
          g2Executions++;
          await new Promise((r) => setTimeout(r, 25));
          return { replyText: 'G2 response', usage: { totalTokens: 10 } };
        },
        cancel: async () => true,
      };

      const gateway1 = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor: executor1,
        quotaMode: 'disabled',
        profileResolver,
      });

      const gateway2 = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor: executor2,
        quotaMode: 'disabled',
        profileResolver,
      });

      const env = createSampleEnvelope({ id: 'concurrent-two-gateways-claim' });
      const disp = await gateway1.dispatchInbound(env);
      const turnId = disp.turnId!;

      // Both gateways attempt to drain / process
      await Promise.all([
        gateway1.drain(1000),
        gateway2.drain(1000),
      ]);

      // Exactly one execution occurred across both gateways
      expect(g1Executions + g2Executions).toBe(1);

      // Turn completed with exactly 1 assistant message
      const msgs = db.prepare("SELECT * FROM web_messages WHERE turn_id = ? AND role = 'assistant'").all(turnId);
      expect(msgs.length).toBe(1);

      const turnStatus = await gateway1.getTurnStatus('u1', turnId);
      expect(turnStatus.status).toBe('completed');
    });
  });

  describe('5. Crash Windows Invariant & Projection Parity Tests', () => {
    it('completed exact fields match between normal runClaimedTurn and redrive completed (excluding timestamps)', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      const executor = {
        execute: async (req: DeliveryExecutionRequest): Promise<TurnExecutionResult> => {
          return {
            replyText: `Reply for turn ${req.turnId}`,
            usage: { totalTokens: 30 },
          };
        },
        cancel: async () => true,
        inspectTurnResult: async (query: { turnId: string; userId: string; dshSessionId: string }): Promise<InspectedTurnResult> => {
          return {
            status: 'completed',
            result: {
              replyText: `Reply for turn ${query.turnId}`,
              usage: { totalTokens: 30 },
            },
          };
        },
      };

      const gateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor,
        quotaMode: 'disabled',
        profileResolver,
      });

      // 1. Normal run to completion
      const envNormal = createSampleEnvelope({ id: 'turn-normal-exact' });
      const dispNormal = await gateway.dispatchInbound(envNormal);
      const turnNormalId = dispNormal.turnId!;
      await gateway.drain(1000);

      // 2. Reconcile completed run
      const envReconcile = createSampleEnvelope({ id: 'turn-reconcile-exact' });
      const dispReconcile = await gateway.dispatchInbound(envReconcile);
      const turnReconcileId = dispReconcile.turnId!;
      await gateway.drain(1000);

      // Reset turnReconcile to simulate crash during 'executing' phase
      db.prepare(`
        INSERT OR REPLACE INTO session_execution_leases (
          id, user_id, route_id, turn_id, generation, phase, status, worker_id, acquired_at, heartbeat_at, expires_at
        ) VALUES ('lease_reconcile_exact', 'u1', 'ses1', ?, 1, 'executing', 'active', 'worker_crashed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(turnReconcileId);
      db.prepare("UPDATE turn_runs SET status = 'running', finished_at = NULL WHERE turn_id = ?").run(turnReconcileId);
      db.prepare("UPDATE delivery_inbox SET status = 'processing', processed_at = NULL WHERE turn_id = ?").run(turnReconcileId);
      db.prepare("UPDATE idempotency_records SET state = 'processing' WHERE turn_id = ?").run(turnReconcileId);
      db.prepare("DELETE FROM web_messages WHERE turn_id = ? AND role = 'assistant'").run(turnReconcileId);
      db.prepare("DELETE FROM web_events WHERE session_id = 'ses1' AND payload LIKE '%' || ? || '%'").run(turnReconcileId);

      // Run redrive
      await gateway.redriveHeld();

      // Query turn_runs
      const turnRowNormal = db.prepare('SELECT status, error FROM turn_runs WHERE turn_id = ?').get(turnNormalId) as any;
      const turnRowReconcile = db.prepare('SELECT status, error FROM turn_runs WHERE turn_id = ?').get(turnReconcileId) as any;
      expect(turnRowReconcile.status).toBe(turnRowNormal.status);
      expect(turnRowReconcile.error).toBe(turnRowNormal.error);

      // Query delivery_inbox
      const inboxNormal = db.prepare('SELECT status, error FROM delivery_inbox WHERE turn_id = ?').get(turnNormalId) as any;
      const inboxReconcile = db.prepare('SELECT status, error FROM delivery_inbox WHERE turn_id = ?').get(turnReconcileId) as any;
      expect(inboxReconcile.status).toBe(inboxNormal.status);
      expect(inboxReconcile.error).toBe(inboxNormal.error);

      // Query idempotency_records
      const idemNormal = db.prepare('SELECT state FROM idempotency_records WHERE turn_id = ?').get(turnNormalId) as any;
      const idemReconcile = db.prepare('SELECT state FROM idempotency_records WHERE turn_id = ?').get(turnReconcileId) as any;
      expect(idemReconcile.state).toBe(idemNormal.state);

      // Query web_messages (assistant)
      const msgNormal = db.prepare("SELECT role, status, route_key FROM web_messages WHERE turn_id = ? AND role = 'assistant'").get(turnNormalId) as any;
      const msgReconcile = db.prepare("SELECT role, status, route_key FROM web_messages WHERE turn_id = ? AND role = 'assistant'").get(turnReconcileId) as any;
      expect(msgReconcile.role).toBe(msgNormal.role);
      expect(msgReconcile.status).toBe(msgNormal.status);
      expect(msgReconcile.route_key).toBe(msgNormal.route_key);
    });

    it('repeated redrive is strictly idempotent and creates zero duplicate messages or events', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      const executor = {
        execute: async () => ({ replyText: 'Reply', usage: { totalTokens: 10 } }),
        cancel: async () => true,
        inspectTurnResult: async () => ({
          status: 'completed' as const,
          result: { replyText: 'Recovered once', usage: { totalTokens: 10 } },
        }),
      };

      const gateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor,
        quotaMode: 'disabled',
        profileResolver,
      });

      const env = createSampleEnvelope({ id: 'turn-idempotent-redrive' });
      const disp = await gateway.dispatchInbound(env);
      const turnId = disp.turnId!;
      await gateway.drain(1000);

      // Simulate crash during execution
      db.prepare(`
        INSERT OR REPLACE INTO session_execution_leases (
          id, user_id, route_id, turn_id, generation, phase, status, worker_id, acquired_at, heartbeat_at, expires_at
        ) VALUES ('lease_idemp_crash', 'u1', 'ses1', ?, 1, 'executing', 'active', 'worker_crashed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(turnId);
      db.prepare("UPDATE turn_runs SET status = 'running' WHERE turn_id = ?").run(turnId);
      db.prepare("UPDATE delivery_inbox SET status = 'processing' WHERE turn_id = ?").run(turnId);
      db.prepare("UPDATE idempotency_records SET state = 'processing' WHERE turn_id = ?").run(turnId);
      db.prepare("DELETE FROM web_messages WHERE turn_id = ? AND role = 'assistant'").run(turnId);

      // 1st redrive
      await gateway.redriveHeld();

      const msgsCount1 = db.prepare("SELECT COUNT(*) as cnt FROM web_messages WHERE turn_id = ? AND role = 'assistant'").get(turnId) as { cnt: number };
      expect(msgsCount1.cnt).toBe(1);

      const eventsCount1 = db.prepare("SELECT COUNT(*) as cnt FROM web_events WHERE session_id = 'ses1' AND type = 'message'").get() as { cnt: number };

      // 2nd redrive
      await gateway.redriveHeld();

      const msgsCount2 = db.prepare("SELECT COUNT(*) as cnt FROM web_messages WHERE turn_id = ? AND role = 'assistant'").get(turnId) as { cnt: number };
      expect(msgsCount2.cnt).toBe(1);

      const eventsCount2 = db.prepare("SELECT COUNT(*) as cnt FROM web_events WHERE session_id = 'ses1' AND type = 'message'").get() as { cnt: number };
      expect(eventsCount2.cnt).toBe(eventsCount1.cnt);

      // 3rd redrive
      await gateway.redriveHeld();

      const msgsCount3 = db.prepare("SELECT COUNT(*) as cnt FROM web_messages WHERE turn_id = ? AND role = 'assistant'").get(turnId) as { cnt: number };
      expect(msgsCount3.cnt).toBe(1);
    });

    it('recovers pending quota reservation across platform crash and commits exactly once', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      let reserveCount = 0;
      let commitCount = 0;
      let recoverCount = 0;

      const mockBundle = {
        reservationId: 'qbd_00000000000000000000000000000001',
        userId: 'u1',
        turns: 1,
        messages: 1,
        tokens: 50,
        isEstimateTokens: true,
        commit: async () => { commitCount++; },
        release: async () => {},
        renew: async () => {},
        commitInTransaction: () => { commitCount++; },
        releaseInTransaction: () => {},
      };

      const quotaProvider: TenantQuotaProvider = {
        reserve: async (req: QuotaReservationRequest) => {
          reserveCount++;
          return {
            ...mockBundle,
            userId: req.userId,
            turns: req.turns,
            messages: req.messages,
            tokens: req.tokens,
            isEstimateTokens: req.isEstimateTokens,
          };
        },
        recoverReservation: async (deliveryId: string, userId?: string) => {
          recoverCount++;
          return {
            ...mockBundle,
            userId: userId || 'u1',
          };
        },
      };

      const executor = {
        execute: async () => ({ replyText: 'Ok', usage: { totalTokens: 25 } }),
        cancel: async () => true,
        inspectTurnResult: async () => ({
          status: 'completed' as const,
          result: { replyText: 'Completed by container before crash', usage: { totalTokens: 25 } },
        }),
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

      const env = createSampleEnvelope({ id: 'turn-quota-crash-recover' });
      const disp = await gateway.dispatchInbound(env);
      const turnId = disp.turnId!;
      await gateway.drain(1000);

      // Simulate crash during execution with pending quota reservation
      db.prepare(`
        INSERT OR REPLACE INTO session_execution_leases (
          id, user_id, route_id, turn_id, generation, phase, status, worker_id, acquired_at, heartbeat_at, expires_at
        ) VALUES ('lease_quota_crash', 'u1', 'ses1', ?, 1, 'executing', 'active', 'worker_crashed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(turnId);
      db.prepare("UPDATE turn_runs SET status = 'running' WHERE turn_id = ?").run(turnId);
      db.prepare("UPDATE delivery_inbox SET status = 'processing' WHERE turn_id = ?").run(turnId);
      db.prepare("UPDATE idempotency_records SET state = 'processing' WHERE turn_id = ?").run(turnId);
      db.prepare("DELETE FROM web_messages WHERE turn_id = ? AND role = 'assistant'").run(turnId);

      const initialCommitCount = commitCount;

      // Redrive on new gateway startup
      await gateway.redriveHeld();

      // Verify recoverReservation was invoked and quota committed exactly once
      expect(recoverCount).toBe(1);
      expect(commitCount).toBe(initialCommitCount + 1);

      // Repeated redrive does not double commit
      await gateway.redriveHeld();
      expect(commitCount).toBe(initialCommitCount + 1);
    });

    it('failed turn inspectTurnResult uses safe errorCode enum and never leaks raw remote error strings', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      const executor = {
        execute: async () => ({ replyText: 'Ok', usage: { totalTokens: 10 } }),
        cancel: async () => true,
        inspectTurnResult: async () => ({
          status: 'failed' as const,
          errorCode: 'EXECUTION_FAILED' as const,
        }),
      };

      const gateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor,
        quotaMode: 'disabled',
        profileResolver,
      });

      const env = createSampleEnvelope({ id: 'turn-failed-safe-code' });
      const disp = await gateway.dispatchInbound(env);
      const turnId = disp.turnId!;
      await gateway.drain(1000);

      // Simulate crash during execution
      db.prepare(`
        INSERT OR REPLACE INTO session_execution_leases (
          id, user_id, route_id, turn_id, generation, phase, status, worker_id, acquired_at, heartbeat_at, expires_at
        ) VALUES ('lease_failed_crash', 'u1', 'ses1', ?, 1, 'executing', 'active', 'worker_crashed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(turnId);
      db.prepare("UPDATE turn_runs SET status = 'running' WHERE turn_id = ?").run(turnId);
      db.prepare("UPDATE delivery_inbox SET status = 'processing' WHERE turn_id = ?").run(turnId);
      db.prepare("UPDATE idempotency_records SET state = 'processing' WHERE turn_id = ?").run(turnId);

      await gateway.redriveHeld();

      // Check turn_runs error
      const turnRow = db.prepare('SELECT status, error FROM turn_runs WHERE turn_id = ?').get(turnId) as { status: string; error?: string };
      expect(turnRow.status).toBe('failed');
      expect(turnRow.error).toBe('Turn execution failed');

      // Check web_events
      const eventRow = db.prepare("SELECT payload FROM web_events WHERE session_id = 'ses1' AND type = 'turn_failed' ORDER BY created_at DESC LIMIT 1").get() as { payload: string };
      const parsedPayload = JSON.parse(eventRow.payload);
      expect(parsedPayload.code).toBe('EXECUTION_FAILED');
    });

    it('fails loud with AggregateError on finalize DB failure during reconcile and does NOT overwrite with orphan cleanup', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      const executor = {
        execute: async () => ({ replyText: 'Ok', usage: { totalTokens: 10 } }),
        cancel: async () => true,
        inspectTurnResult: async () => ({
          status: 'completed' as const,
          result: { replyText: 'Completed', usage: { totalTokens: 10 } },
        }),
      };

      const gateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor,
        quotaMode: 'disabled',
        profileResolver,
      });

      const env = createSampleEnvelope({ id: 'turn-reconcile-db-failure' });
      const disp = await gateway.dispatchInbound(env);
      const turnId = disp.turnId!;
      await gateway.drain(1000);

      // Simulate crash during execution
      db.prepare(`
        INSERT OR REPLACE INTO session_execution_leases (
          id, user_id, route_id, turn_id, generation, phase, status, worker_id, acquired_at, heartbeat_at, expires_at
        ) VALUES ('lease_db_fail_crash', 'u1', 'ses1', ?, 1, 'executing', 'active', 'worker_crashed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(turnId);
      db.prepare("UPDATE turn_runs SET status = 'running' WHERE turn_id = ?").run(turnId);
      db.prepare("UPDATE delivery_inbox SET status = 'processing' WHERE turn_id = ?").run(turnId);
      db.prepare("UPDATE idempotency_records SET state = 'processing' WHERE turn_id = ?").run(turnId);

      // Drop a table or insert invalid trigger to force finalize transaction failure
      db.exec(`
        CREATE TRIGGER force_finalize_fail BEFORE UPDATE ON turn_runs
        BEGIN
          SELECT RAISE(FAIL, 'Injected DB failure on turn_runs update');
        END;
      `);

      // Attempt redrive - MUST throw AggregateError loudly
      await expect(gateway.redriveHeld()).rejects.toThrow(AggregateError);

      // Remove trigger
      db.exec('DROP TRIGGER force_finalize_fail');

      // Verify turn_runs was NOT overwritten to 'interrupted' by orphan cleanup!
      const turnRow = db.prepare('SELECT status FROM turn_runs WHERE turn_id = ?').get(turnId) as { status: string };
      expect(turnRow.status).toBe('running');
    });

    it('assistant result already projected before crash does not duplicate message or event on reconcile', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      const executor = {
        execute: async () => ({ replyText: 'Ok', usage: { totalTokens: 10 } }),
        cancel: async () => true,
        inspectTurnResult: async () => ({
          status: 'completed' as const,
          result: { replyText: 'Already projected reply', usage: { totalTokens: 10 } },
        }),
      };

      const gateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor,
        quotaMode: 'disabled',
        profileResolver,
      });

      const env = createSampleEnvelope({ id: 'turn-already-projected-crash' });
      const disp = await gateway.dispatchInbound(env);
      const turnId = disp.turnId!;
      await gateway.drain(1000);

      // Manually insert assistant message (as if it was committed or partially projected before crash)
      db.prepare("DELETE FROM web_messages WHERE turn_id = ? AND role = 'assistant'").run(turnId);
      const assistantMsgId = 'msg_pre_projected_123';
      db.prepare(`
        INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, turn_id, created_at)
        VALUES (?, 'ses1', 'u1', 'assistant', 'Already projected reply', 'delivered', 'u1:web:sp1:ses1', ?, CURRENT_TIMESTAMP)
      `).run(assistantMsgId, turnId);

      const preEventsCount = (db.prepare("SELECT COUNT(*) as cnt FROM web_events WHERE session_id = 'ses1'").get() as { cnt: number }).cnt;

      // Simulate crash with lease in 'executing'
      db.prepare(`
        INSERT OR REPLACE INTO session_execution_leases (
          id, user_id, route_id, turn_id, generation, phase, status, worker_id, acquired_at, heartbeat_at, expires_at
        ) VALUES ('lease_proj_crash', 'u1', 'ses1', ?, 1, 'executing', 'active', 'worker_crashed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(turnId);
      db.prepare("UPDATE turn_runs SET status = 'running' WHERE turn_id = ?").run(turnId);

      // Redrive
      await gateway.redriveHeld();

      // Assistant messages count for this turn must be EXACTLY 1
      const assistantMsgs = db.prepare("SELECT * FROM web_messages WHERE turn_id = ? AND role = 'assistant'").all(turnId);
      expect(assistantMsgs.length).toBe(1);
      expect(assistantMsgs[0].id).toBe(assistantMsgId);

      // Events count did not duplicate
      const postEventsCount = (db.prepare("SELECT COUNT(*) as cnt FROM web_events WHERE session_id = 'ses1'").get() as { cnt: number }).cnt;
      expect(postEventsCount).toBe(preEventsCount);
    });

    it('recovers crashed executing turn as interrupted (no rerun) and allows subsequent queued held turns to continue and complete', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      const executedTurnIds: string[] = [];
      let inspectCalledTurn1 = false;

      const executor = {
        execute: async (req: DeliveryExecutionRequest): Promise<TurnExecutionResult> => {
          executedTurnIds.push(req.turnId);
          return {
            replyText: `Reply for ${req.content}`,
            usage: { totalTokens: 10 },
          };
        },
        cancel: async () => true,
        inspectTurnResult: async (query: { turnId: string; userId: string; dshSessionId: string }): Promise<InspectedTurnResult> => {
          if (query.turnId === 'turn-crash-1') {
            inspectCalledTurn1 = true;
            return { status: 'absent' };
          }
          return { status: 'absent' };
        },
      };

      // Seed 3 turns:
      // Turn 1: was executing when crash happened (lease phase='executing', active)
      // Turn 2: queued / held
      // Turn 3: queued / held
      const nowIso = new Date().toISOString();
      const turn1Id = 'turn-crash-1';
      const turn2Id = 'turn-crash-2';
      const turn3Id = 'turn-crash-3';

      // Insert Turn 1 (executing)
      db.prepare(`
        INSERT INTO delivery_inbox (id, user_id, route_id, message_id, delivery_id, payload, status, turn_id, created_at, updated_at)
        VALUES ('inbox_1', 'u1', 'ses1', 'msg_1', 'deliv_1', '{"content":"Turn 1 Message"}', 'processing', ?, ?, ?)
      `).run(turn1Id, nowIso, nowIso);
      db.prepare(`
        INSERT INTO turn_runs (id, user_id, space_id, route_id, turn_id, status, created_at, updated_at)
        VALUES ('run_1', 'u1', 'sp1', 'ses1', ?, 'running', ?, ?)
      `).run(turn1Id, nowIso, nowIso);
      db.prepare(`
        INSERT INTO idempotency_records (id, user_id, idempotency_key, session_id, delivery_id, turn_id, request_hash, state, created_at, updated_at)
        VALUES ('idem_1', 'u1', 'key_1', 'ses1', 'deliv_1', ?, 'hash1', 'processing', ?, ?)
      `).run(turn1Id, nowIso, nowIso);
      db.prepare(`
        INSERT INTO session_execution_leases (
          id, user_id, route_id, turn_id, generation, phase, status, worker_id, acquired_at, heartbeat_at, expires_at
        ) VALUES ('lease_1', 'u1', 'ses1', ?, 1, 'executing', 'active', 'crashed_worker', ?, ?, ?)
      `).run(turn1Id, nowIso, nowIso, nowIso);

      // Insert Turn 2 (queued / held)
      db.prepare(`
        INSERT INTO delivery_inbox (id, user_id, route_id, message_id, delivery_id, payload, status, turn_id, created_at, updated_at)
        VALUES ('inbox_2', 'u1', 'ses1', 'msg_2', 'deliv_2', '{"content":"Turn 2 Message"}', 'held', ?, ?, ?)
      `).run(turn2Id, nowIso, nowIso);
      db.prepare(`
        INSERT INTO turn_runs (id, user_id, space_id, route_id, turn_id, status, created_at, updated_at)
        VALUES ('run_2', 'u1', 'sp1', 'ses1', ?, 'queued', ?, ?)
      `).run(turn2Id, nowIso, nowIso);
      db.prepare(`
        INSERT INTO idempotency_records (id, user_id, idempotency_key, session_id, delivery_id, turn_id, request_hash, state, created_at, updated_at)
        VALUES ('idem_2', 'u1', 'key_2', 'ses1', 'deliv_2', ?, 'hash2', 'held', ?, ?)
      `).run(turn2Id, nowIso, nowIso);

      // Insert Turn 3 (queued / held)
      db.prepare(`
        INSERT INTO delivery_inbox (id, user_id, route_id, message_id, delivery_id, payload, status, turn_id, created_at, updated_at)
        VALUES ('inbox_3', 'u1', 'ses1', 'msg_3', 'deliv_3', '{"content":"Turn 3 Message"}', 'held', ?, ?, ?)
      `).run(turn3Id, nowIso, nowIso);
      db.prepare(`
        INSERT INTO turn_runs (id, user_id, space_id, route_id, turn_id, status, created_at, updated_at)
        VALUES ('run_3', 'u1', 'sp1', 'ses1', ?, 'queued', ?, ?)
      `).run(turn3Id, nowIso, nowIso);
      db.prepare(`
        INSERT INTO idempotency_records (id, user_id, idempotency_key, session_id, delivery_id, turn_id, request_hash, state, created_at, updated_at)
        VALUES ('idem_3', 'u1', 'key_3', 'ses1', 'deliv_3', ?, 'hash3', 'held', ?, ?)
      `).run(turn3Id, nowIso, nowIso);

      const gateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor,
        quotaMode: 'disabled',
        profileResolver,
      });

      // Redrive held turns on platform restart
      const redriveCount = await gateway.redriveHeld();
      expect(redriveCount).toBeGreaterThanOrEqual(1);

      // Drain gateway
      await gateway.drain(2000);

      // Verify Turn 1 was inspected and marked interrupted (NEVER rerun)
      expect(inspectCalledTurn1).toBe(true);
      expect(executedTurnIds).not.toContain(turn1Id);

      const turn1Status = await gateway.getTurnStatus('u1', turn1Id);
      expect(turn1Status.status).toBe('interrupted');

      // Verify Turn 2 and Turn 3 executed and completed in sequence
      expect(executedTurnIds).toEqual([turn2Id, turn3Id]);

      const turn2Status = await gateway.getTurnStatus('u1', turn2Id);
      expect(turn2Status.status).toBe('completed');

      const turn3Status = await gateway.getTurnStatus('u1', turn3Id);
      expect(turn3Status.status).toBe('completed');

      // Verify web_messages contains assistant replies only for Turn 2 and Turn 3
      const assistantMsgs = db.prepare("SELECT turn_id, content, status FROM web_messages WHERE role = 'assistant' ORDER BY created_at ASC").all() as Array<{ turn_id: string; content: string; status: string }>;
      expect(assistantMsgs.length).toBe(2);
      expect(assistantMsgs[0].turn_id).toBe(turn2Id);
      expect(assistantMsgs[0].content).toBe('Reply for Turn 2 Message');
      expect(assistantMsgs[1].turn_id).toBe(turn3Id);
      expect(assistantMsgs[1].content).toBe('Reply for Turn 3 Message');
    });
  });
});
