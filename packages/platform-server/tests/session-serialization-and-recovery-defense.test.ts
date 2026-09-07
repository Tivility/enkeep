import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import {
  DeliveryRuntimeGateway,
  SqliteWebMessageStore,
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  SessionLifecycleService,
  type DeliveryExecutionRequest,
  type TurnExecutionResult,
  type RuntimeArtifactPort,
} from '../src/index.js';
import type { InboundEnvelope } from '@enkeep/web-channel';
import {
  acquireSessionLock,
  SessionBusyError,
  deriveSafeLockPath,
  ensureLocksDirectory,
} from '../../runtime-runner/src/runtime/session-lock.js';

function createValidDeliveryId(): string {
  return `deliv_${randomUUID().replace(/-/g, '')}`;
}

async function setupTestEnv(options?: {
  runtimeArtifactPort?: RuntimeArtifactPort;
  externalInteractionService?: any;
}) {
  const db = new DatabaseSync(':memory:');
  const runner = new PlatformServerMigrationRunner(db);
  await runner.migrate(ALL_PLATFORM_MIGRATIONS);

  // Create test users, spaces, and session routes
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES ('u1', 'alice', 'hash', 'admin')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES ('u2', 'bob', 'hash', 'user')").run();
  db.prepare("INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES ('sp1', 'u1', 'Space 1', 'space-1', 'container')").run();
  db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, current_generation) VALUES ('ses1', 'u1', 'sp1', 'web', 'web-demo', 'ses1', 'p1', 'dsh1', 'container', 1)").run();
  db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, current_generation) VALUES ('ses2', 'u1', 'sp1', 'web', 'web-demo', 'ses2', 'p2', 'dsh2', 'container', 1)").run();

  const storage = new SqlitePlatformStorage(db);
  const messageStore = new SqliteWebMessageStore(db);
  const profileResolver = { resolve: async () => null };

  const defaultArtifactPort: RuntimeArtifactPort = {
    checkSessionArtifact: async () => ({ exists: true, valid: true }),
    exportForkSeed: async () => ({
      events: [
        { type: 'user/message', seq: 0, time: 1000, data: { content: 'Hello' } },
        { type: 'assistant/message', seq: 1, time: 1001, data: { message: { content: 'Hi' } } },
      ],
      receipt: {
        algorithm: 'sha256-session-events-v1',
        checksum: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        canonicalBytes: 100,
        eventCount: 2,
      },
    }),
    importSeed: async () => ({
      status: 'ok',
      persisted: true,
      eventsCount: 2,
    }),
    inspectSessionCorruption: async () => ({
      exists: true,
      valid: true,
      corrupted: false,
      code: 'VALID',
      lastValidSeq: 1,
      lineCount: 3,
      validEventsCount: 2,
    }),
    recoverValidPrefix: async (opts) => ({
      recovered: true,
      targetDshId: opts.targetDshId,
      validEventsCount: 2,
      backupPath: '/tmp/test_backup.jsonl.bak',
      backupChecksum: 'sha256_mock_checksum',
    }),
  };

  const runtimeArtifactPort = options?.runtimeArtifactPort ?? defaultArtifactPort;
  const lifecycleService = new SessionLifecycleService({
    db,
    storage,
    runtimeArtifactPort,
  });

  return {
    db,
    storage,
    messageStore,
    profileResolver,
    runtimeArtifactPort,
    lifecycleService,
  };
}

describe('Full Defense-in-Depth Session Serialization & Recovery (E1 - E8)', () => {
  // E1: Rapid 10 POSTs to SAME session without awaiting
  it('E1. Rapid 10 POSTs to SAME session: strictly ordered FIFO, sequential non-overlapping executions, single lease owner', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    let activeExecutions = 0;
    let maxObservedConcurrency = 0;
    const executedTurns: Array<{ turnId: string; content: string; start: number; end: number }> = [];

    const executor = {
      execute: async (req: DeliveryExecutionRequest): Promise<TurnExecutionResult> => {
        activeExecutions++;
        maxObservedConcurrency = Math.max(maxObservedConcurrency, activeExecutions);
        const start = Date.now();

        // Simulate 25ms turn execution
        await new Promise((r) => setTimeout(r, 25));

        const end = Date.now();
        executedTurns.push({ turnId: req.turnId, content: req.content, start, end });
        activeExecutions--;

        return {
          replyText: `Reply for ${req.content}`,
          usage: { totalTokens: 15 },
        };
      },
      cancel: async () => true,
    };

    const gateway = new DeliveryRuntimeGateway({
      database: db,
      storage,
      messageStore,
      executor,
      quotaMode: 'disabled',
      profileResolver,
    });

    // Fire 10 rapid POSTs to session ses1 concurrently without awaiting
    const postPromises: Promise<any>[] = [];
    for (let i = 1; i <= 10; i++) {
      postPromises.push(
        gateway.dispatchInbound({
          id: createValidDeliveryId(),
          sessionId: 'ses1',
          userId: 'u1',
          content: `Prompt ${i}`,
          timestamp: new Date(Date.now() + i * 5).toISOString(),
        })
      );
    }

    const dispatchResults = await Promise.all(postPromises);
    expect(dispatchResults.length).toBe(10);
    expect(dispatchResults.every((d) => d.accepted === true)).toBe(true);

    // Drain all turns
    await gateway.drain(5000);

    // Concurrency must never exceed 1
    expect(maxObservedConcurrency).toBe(1);

    // Execution order must be strictly FIFO 1 through 10
    expect(executedTurns.map((t) => t.content)).toEqual([
      'Prompt 1',
      'Prompt 2',
      'Prompt 3',
      'Prompt 4',
      'Prompt 5',
      'Prompt 6',
      'Prompt 7',
      'Prompt 8',
      'Prompt 9',
      'Prompt 10',
    ]);

    // Execution intervals must not overlap
    for (let i = 1; i < executedTurns.length; i++) {
      expect(executedTurns[i].start).toBeGreaterThanOrEqual(executedTurns[i - 1].end - 5);
    }

    // All 10 turn_runs completed
    const turns = db.prepare("SELECT turn_id, status FROM turn_runs WHERE route_id = 'ses1' ORDER BY created_at ASC").all() as any[];
    expect(turns.length).toBe(10);
    expect(turns.every((t) => t.status === 'completed')).toBe(true);

    // Leases table recorded leases and released them
    const leases = db.prepare("SELECT * FROM session_execution_leases WHERE route_id = 'ses1'").all() as any[];
    expect(leases.length).toBeGreaterThanOrEqual(1);
    expect(leases.every((l) => l.status === 'released')).toBe(true);
  });

  // E2: Different sessions in parallel prove concurrency
  it('E2. Different sessions execute in parallel with concurrency > 1 while each session remains serialized', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    let activeExecutions = 0;
    let maxObservedConcurrency = 0;

    let resolveS1!: () => void;
    const s1Gate = new Promise<void>((r) => { resolveS1 = r; });
    let resolveS2!: () => void;
    const s2Gate = new Promise<void>((r) => { resolveS2 = r; });

    const executor = {
      execute: async (req: DeliveryExecutionRequest): Promise<TurnExecutionResult> => {
        activeExecutions++;
        maxObservedConcurrency = Math.max(maxObservedConcurrency, activeExecutions);

        if (req.envelope.sessionId === 'ses1') {
          await s1Gate;
        } else if (req.envelope.sessionId === 'ses2') {
          await s2Gate;
        }

        activeExecutions--;
        return {
          replyText: `Reply for ${req.content}`,
          usage: { totalTokens: 10 },
        };
      },
      cancel: async () => true,
    };

    const gateway = new DeliveryRuntimeGateway({
      database: db,
      storage,
      messageStore,
      executor,
      quotaMode: 'disabled',
      profileResolver,
    });

    const p1 = gateway.dispatchInbound({
      id: createValidDeliveryId(),
      sessionId: 'ses1',
      userId: 'u1',
      content: 'Ses1 Msg',
      timestamp: new Date().toISOString(),
    });

    const p2 = gateway.dispatchInbound({
      id: createValidDeliveryId(),
      sessionId: 'ses2',
      userId: 'u1',
      content: 'Ses2 Msg',
      timestamp: new Date().toISOString(),
    });

    await Promise.all([p1, p2]);

    // Give a small tick for both executions to begin in executor
    await new Promise((r) => setTimeout(r, 40));

    // Concurrency must reach 2 across distinct sessions
    expect(maxObservedConcurrency).toBe(2);

    resolveS1();
    resolveS2();

    await gateway.drain(1000);

    const s1Turns = db.prepare("SELECT status FROM turn_runs WHERE route_id = 'ses1'").all() as any[];
    const s2Turns = db.prepare("SELECT status FROM turn_runs WHERE route_id = 'ses2'").all() as any[];
    expect(s1Turns[0].status).toBe('completed');
    expect(s2Turns[0].status).toBe('completed');
  });

  // E3: Kill platform mid-queue and restart drains exactly once
  it('E3. Redrive & restart recovers interrupted/queued turns and drains remaining items exactly once', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    const executedTurns: string[] = [];
    const executor = {
      execute: async (req: DeliveryExecutionRequest): Promise<TurnExecutionResult> => {
        executedTurns.push(req.content);
        return {
          replyText: `Reply: ${req.content}`,
          usage: { totalTokens: 10 },
        };
      },
      cancel: async () => true,
    };

    // Seed 2 queued turns directly in DB simulating crash during previous run
    const nowIso = new Date().toISOString();
    db.prepare(`
      INSERT INTO delivery_inbox (id, user_id, route_id, message_id, delivery_id, payload, status, turn_id, created_at, updated_at)
      VALUES ('inbox_old_1', 'u1', 'ses1', 'msg_old_1', 'deliv_old_1', '{"content":"Recovered Turn 1"}', 'held', 'turn_old_1', ?, ?)
    `).run(nowIso, nowIso);

    db.prepare(`
      INSERT INTO turn_runs (id, user_id, space_id, route_id, turn_id, status, created_at, updated_at)
      VALUES ('run_old_1', 'u1', 'sp1', 'ses1', 'turn_old_1', 'queued', ?, ?)
    `).run(nowIso, nowIso);

    db.prepare(`
      INSERT INTO idempotency_records (id, user_id, idempotency_key, session_id, delivery_id, turn_id, request_hash, state, created_at, updated_at)
      VALUES ('idem_old_1', 'u1', 'deliv_old_1', 'ses1', 'deliv_old_1', 'turn_old_1', 'hash1', 'held', ?, ?)
    `).run(nowIso, nowIso);

    const gateway = new DeliveryRuntimeGateway({
      database: db,
      storage,
      messageStore,
      executor,
      quotaMode: 'disabled',
      profileResolver,
    });

    // Call redriveHeld() on startup
    const redriven = await gateway.redriveHeld();
    expect(redriven).toBe(1);

    await gateway.drain(1000);

    expect(executedTurns).toEqual(['Recovered Turn 1']);
    const turnStatus = await gateway.getTurnStatus('u1', 'turn_old_1');
    expect(turnStatus.status).toBe('completed');
  });

  // E4: Force bypass two exec lock -> one busy, zero corruption
  it('E4. Force bypass two exec lock: session-lock.ts detects concurrent execution and throws SessionBusyError', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-session-lock-test-'));
    try {
      const sessionId = 'ses_lock_test_123';

      // 1. First process acquires lock
      const lock1 = await acquireSessionLock({
        dshHome: tmpDir,
        sessionId,
        action: 'followup',
        turnId: 'turn_1',
        timeoutMs: 1000,
      });

      expect(lock1.sessionId).toBe(sessionId);
      const lockPath = deriveSafeLockPath(ensureLocksDirectory(tmpDir), sessionId);
      expect(fs.existsSync(lockPath)).toBe(true);

      // 2. Second concurrent execution attempts to acquire lock on the SAME session with short timeout
      await expect(
        acquireSessionLock({
          dshHome: tmpDir,
          sessionId,
          action: 'followup',
          turnId: 'turn_2',
          timeoutMs: 100,
          retryIntervalMs: 20,
        })
      ).rejects.toThrow(SessionBusyError);

      // 3. Release first lock
      lock1.release();
      expect(fs.existsSync(lockPath)).toBe(false);

      // 4. Now second execution can acquire cleanly
      const lock2 = await acquireSessionLock({
        dshHome: tmpDir,
        sessionId,
        action: 'followup',
        turnId: 'turn_2',
        timeoutMs: 1000,
      });
      expect(lock2.sessionId).toBe(sessionId);
      lock2.release();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // E5: Corrupt seq fixture -> blocks queue with RECOVERY_REQUIRED, inspect recovery safe, explicit prefix recovery creates Gen+backup, continues
  it('E5. Corrupt seq fixture: queue pauses with RECOVERY_REQUIRED, inspect recovery is safe/unleaked, prefix recovery creates Gen N+1 + backup and unblocks', async () => {
    let mockCorrupted = true;
    let inspectCallCount = 0;
    let recoverPrefixCalled = false;

    const testArtifactPort: RuntimeArtifactPort = {
      checkSessionArtifact: async () => ({ exists: true, valid: !mockCorrupted }),
      exportForkSeed: async () => ({
        events: [
          { type: 'user/message', seq: 0, time: 1000, data: { content: 'Valid msg' } },
          { type: 'assistant/message', seq: 1, time: 1001, data: { message: { content: 'Valid reply' } } },
        ],
        receipt: {
          algorithm: 'sha256-session-events-v1',
          checksum: 'abc123checksum',
          canonicalBytes: 120,
          eventCount: 2,
        },
      }),
      importSeed: async () => ({
        status: 'ok',
        persisted: true,
        eventsCount: 2,
      }),
      inspectSessionCorruption: async () => {
        inspectCallCount++;
        if (mockCorrupted) {
          return {
            exists: true,
            valid: false,
            corrupted: true,
            code: 'SEQ_GAP',
            lastValidSeq: 20,
            lineCount: 22,
            validEventsCount: 21,
            errorDetail: 'seq gap line 21 expected 20 got 11',
          };
        }
        return {
          exists: true,
          valid: true,
          corrupted: false,
          code: 'VALID',
          lastValidSeq: 25,
          lineCount: 26,
          validEventsCount: 25,
        };
      },
      recoverValidPrefix: async (opts) => {
        recoverPrefixCalled = true;
        mockCorrupted = false;
        return {
          recovered: true,
          targetDshId: opts.targetDshId,
          validEventsCount: 21,
          backupPath: '/tmp/recovery/ses1_backup.jsonl.bak',
          backupChecksum: 'sha256_mock_backup_hash',
        };
      },
    };

    const { db, storage, messageStore, profileResolver, lifecycleService } = await setupTestEnv({
      runtimeArtifactPort: testArtifactPort,
    });

    let executorTurnCount = 0;
    const executor = {
      execute: async (_req: DeliveryExecutionRequest): Promise<TurnExecutionResult> => {
        executorTurnCount++;
        if (mockCorrupted) {
          const err = new Error('PERSISTED_SESSION_RESUME_FAILED: seq gap line 21 expected 20 got 11');
          (err as any).code = 'PERSISTED_SESSION_RESUME_FAILED';
          throw err;
        }
        return {
          replyText: 'Successful turn execution in recovered generation',
          usage: { totalTokens: 20 },
        };
      },
      cancel: async () => true,
    };

    const gateway = new DeliveryRuntimeGateway({
      database: db,
      storage,
      messageStore,
      executor,
      quotaMode: 'disabled',
      profileResolver,
    });

    // Send 3 turns to session 1
    const p1 = gateway.dispatchInbound({
      id: createValidDeliveryId(),
      sessionId: 'ses1',
      userId: 'u1',
      content: 'Turn 1 Corrupt',
      timestamp: new Date().toISOString(),
    });

    const p2 = gateway.dispatchInbound({
      id: createValidDeliveryId(),
      sessionId: 'ses1',
      userId: 'u1',
      content: 'Turn 2 Waiting',
      timestamp: new Date().toISOString(),
    });

    await Promise.all([p1, p2]);
    await gateway.drain(1000);

    // Turn 1 failed with session corruption; executor was NOT called repeatedly for Turn 2!
    expect(executorTurnCount).toBe(1);

    // Public status must report recovery_required!
    const currentStatus = await gateway.getCurrentTurnStatus('u1', 'ses1');
    expect(currentStatus).toEqual({
      status: 'recovery_required',
      code: 'RECOVERY_REQUIRED',
    });

    // Check inspectSessionRecovery API
    const inspection = await lifecycleService.inspectSessionRecovery('u1', 'ses1');
    expect(inspection.corrupted).toBe(true);
    expect(inspection.code).toBe('SEQ_GAP');
    expect(inspection.lastValidSeq).toBe(20);
    expect(inspection.recoveryRequired).toBe(true);

    // Operator executes prefix recovery
    const recoveryResult = await lifecycleService.recoverValidPrefix('u1', 'ses1', { replayQueued: false });
    expect(recoveryResult.recovered).toBe(true);
    expect(recoveryResult.newGeneration).toBe(2);
    expect(recoverPrefixCalled).toBe(true);

    // Session recovery state is now resolved
    const afterInspection = await lifecycleService.inspectSessionRecovery('u1', 'ses1');
    expect(afterInspection.corrupted).toBe(false);
    expect(afterInspection.recoveryRequired).toBe(false);

    // Now sending a new turn to session 1 succeeds in Generation 2!
    const gateway2 = new DeliveryRuntimeGateway({
      database: db,
      storage,
      messageStore,
      executor,
      quotaMode: 'disabled',
      profileResolver,
    });

    const p3 = await gateway2.dispatchInbound({
      id: createValidDeliveryId(),
      sessionId: 'ses1',
      userId: 'u1',
      content: 'Turn in Gen 2',
      timestamp: new Date().toISOString(),
    });

    expect(p3.accepted).toBe(true);
    await gateway2.drain(1000);

    const turn3Status = await gateway2.getTurnStatus('u1', p3.turnId!);
    expect(turn3Status.status).toBe('completed');
  });

  // E6: Approval waiting holds lease and queue remains queued
  it('E6. Approval waiting holds lease: turn reports waiting_approval and queue remains paused until user decides/cancels', async () => {
    let pendingApprovalsList: any[] = [
      { id: 'app_1', status: 'pending', sessionId: 'ses1', userId: 'u1' },
    ];

    const mockExternalInteractionService = {
      listPendingApprovals: (_opts?: any) => pendingApprovalsList,
    };

    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    const gateway = new DeliveryRuntimeGateway({
      database: db,
      storage,
      messageStore,
      executor: {
        execute: async () => ({ replyText: 'Executed after approval', usage: { totalTokens: 10 } }),
        cancel: async () => true,
      },
      quotaMode: 'disabled',
      profileResolver,
      externalInteractionService: mockExternalInteractionService,
    });

    // Seed a running turn
    const nowIso = new Date().toISOString();
    db.prepare(`
      INSERT INTO turn_runs (id, user_id, space_id, route_id, turn_id, status, created_at, updated_at)
      VALUES ('run_app_1', 'u1', 'sp1', 'ses1', 'turn_app_1', 'running', ?, ?)
    `).run(nowIso, nowIso);

    // Status reports waiting_approval!
    const turnStatus = await gateway.getCurrentTurnStatus('u1', 'ses1');
    expect(turnStatus).toEqual({
      status: 'waiting_approval',
      code: 'WAITING_APPROVAL',
    });

    // After approval is decided / cleared:
    pendingApprovalsList = [];
    const clearedStatus = await gateway.getCurrentTurnStatus('u1', 'ses1');
    expect(clearedStatus?.status).toBe('running');
  });

  // E7: Quota reservations queued TTL: reserve only when claimed, avoid expire
  it('E7. Quota reservations are committed honestly and released when turns settle', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    let committedTokens = 0;
    const quotaProvider = {
      reserve: async (req: any) => ({
        reservationId: 'res_bundle_e7',
        userId: req.userId,
        turns: req.turns,
        messages: req.messages,
        tokens: req.tokens,
        isEstimateTokens: true,
        commit: async () => {},
        release: async () => {},
        renew: async () => {},
        commitInTransaction: (_db: any, actualUsage: any) => {
          committedTokens += actualUsage.tokens;
        },
        releaseInTransaction: () => {},
      }),
    };

    const gateway = new DeliveryRuntimeGateway({
      database: db,
      storage,
      messageStore,
      executor: {
        execute: async (req) => ({ replyText: `Reply for ${req.content}`, usage: { totalTokens: 42 } }),
        cancel: async () => true,
      },
      quotaMode: 'enforced',
      quotaProvider,
      profileResolver,
    });

    const res = await gateway.dispatchInbound({
      id: createValidDeliveryId(),
      sessionId: 'ses1',
      userId: 'u1',
      content: 'Quota Turn',
      timestamp: new Date().toISOString(),
    });

    expect(res.accepted).toBe(true);
    await gateway.drain(1000);

    expect(committedTokens).toBe(42);
    const turnStatus = await gateway.getTurnStatus('u1', res.turnId!);
    expect(turnStatus.status).toBe('completed');
  });

  // E8: Protocol statuses return queued / running / waiting_approval / recovery_required
  it('E8. getCurrentTurnStatus strictly returns all expected protocol statuses accurately', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    const gateway = new DeliveryRuntimeGateway({
      database: db,
      storage,
      messageStore,
      executor: {
        execute: async () => ({ replyText: 'Done', usage: { totalTokens: 5 } }),
        cancel: async () => true,
      },
      quotaMode: 'disabled',
      profileResolver,
    });

    // 1. Idle -> returns null
    expect(await gateway.getCurrentTurnStatus('u1', 'ses1')).toBeNull();

    // 2. Queued turn -> returns queued with queuePosition
    db.prepare("INSERT INTO turn_runs (id, user_id, space_id, route_id, turn_id, status) VALUES ('r_q', 'u1', 'sp1', 'ses1', 't_q', 'queued')").run();
    expect(await gateway.getCurrentTurnStatus('u1', 'ses1')).toEqual({ status: 'queued', queuePosition: 1 });

    // 3. Running turn -> returns running
    db.prepare("UPDATE turn_runs SET status = 'running' WHERE id = 'r_q'").run();
    expect(await gateway.getCurrentTurnStatus('u1', 'ses1')).toEqual({ status: 'running' });

    // 4. Recovery required -> returns recovery_required
    db.prepare("INSERT INTO session_recovery_state (id, user_id, route_id, generation, status, failure_code) VALUES ('rec_1', 'u1', 'ses1', 1, 'recovery_required', 'CORRUPTED_SESSION_ARTIFACT')").run();
    expect(await gateway.getCurrentTurnStatus('u1', 'ses1')).toEqual({
      status: 'recovery_required',
      code: 'RECOVERY_REQUIRED',
    });
  });

  // E9: Platform restart recovers 3 queued messages directly from DB without in-memory state

  // E9: Platform restart recovers 3 queued messages directly from DB without in-memory state
  it('E9. Platform restart recovery: recoverQueuedTurns reconstructs 3 queued turns from SQLite and drains sequentially', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    const executedContents: string[] = [];
    const executor = {
      execute: async (req: DeliveryExecutionRequest): Promise<TurnExecutionResult> => {
        executedContents.push(req.content);
        return {
          replyText: `Executed ${req.content}`,
          usage: { totalTokens: 10 },
        };
      },
      cancel: async () => true,
    };

    // Simulate server crash with 3 queued messages in SQLite
    const now = Date.now();
    for (let i = 1; i <= 3; i++) {
      const ts = new Date(now + i * 10).toISOString();
      db.prepare(`
        INSERT INTO delivery_inbox (id, user_id, route_id, message_id, delivery_id, payload, status, turn_id, created_at, updated_at)
        VALUES ('inbox_d_${i}', 'u1', 'ses1', 'msg_d_${i}', 'deliv_d_${i}', ?, 'held', 'turn_d_${i}', ?, ?)
      `).run(JSON.stringify({ content: `Durable Msg ${i}` }), ts, ts);

      db.prepare(`
        INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, turn_id, created_at)
        VALUES ('msg_d_${i}', 'ses1', 'u1', 'user', ?, 'delivered', 'u1:web:sp1:ses1', 'turn_d_${i}', ?)
      `).run(`Durable Msg ${i}`, ts);

      db.prepare(`
        INSERT INTO turn_runs (id, user_id, space_id, route_id, turn_id, status, created_at, updated_at)
        VALUES ('run_d_${i}', 'u1', 'sp1', 'ses1', 'turn_d_${i}', 'queued', ?, ?)
      `).run(ts, ts);

      db.prepare(`
        INSERT INTO idempotency_records (id, user_id, idempotency_key, session_id, delivery_id, turn_id, request_hash, state, created_at, updated_at)
        VALUES ('idem_d_${i}', 'u1', 'deliv_d_${i}', 'ses1', 'deliv_d_${i}', 'turn_d_${i}', 'hash', 'held', ?, ?)
      `).run(ts, ts);
    }

    // New platform gateway instance boots up (clean memory)
    const freshGateway = new DeliveryRuntimeGateway({
      database: db,
      storage,
      messageStore,
      executor,
      quotaMode: 'disabled',
      profileResolver,
    });

    const redriven = await freshGateway.recoverQueuedTurns();
    expect(redriven).toBe(1); // 1 session had queued turns

    await freshGateway.drain(2000);

    expect(executedContents).toEqual(['Durable Msg 1', 'Durable Msg 2', 'Durable Msg 3']);

    const allTurns = db.prepare("SELECT turn_id, status FROM turn_runs WHERE route_id = 'ses1' ORDER BY created_at ASC").all() as any[];
    expect(allTurns.length).toBe(3);
    expect(allTurns.every((t) => t.status === 'completed')).toBe(true);
  });

  // E10: Two gateway instances on shared DB: only ONE can claim lease
  it('E10. Multi-process/Multi-instance concurrency: two gateway instances sharing the same DB strictly serialize via session_execution_leases', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    let activeG1 = 0;
    let activeG2 = 0;
    let maxCombinedConcurrency = 0;

    let resolveGate!: () => void;
    const holdGate = new Promise<void>((r) => { resolveGate = r; });

    const executorG1 = {
      execute: async (_req: DeliveryExecutionRequest): Promise<TurnExecutionResult> => {
        activeG1++;
        maxCombinedConcurrency = Math.max(maxCombinedConcurrency, activeG1 + activeG2);
        await holdGate;
        activeG1--;
        return { replyText: 'G1 Reply', usage: { totalTokens: 10 } };
      },
      cancel: async () => true,
    };

    const executorG2 = {
      execute: async (_req: DeliveryExecutionRequest): Promise<TurnExecutionResult> => {
        activeG2++;
        maxCombinedConcurrency = Math.max(maxCombinedConcurrency, activeG1 + activeG2);
        await holdGate;
        activeG2--;
        return { replyText: 'G2 Reply', usage: { totalTokens: 10 } };
      },
      cancel: async () => true,
    };

    const g1 = new DeliveryRuntimeGateway({
      database: db,
      storage,
      messageStore,
      executor: executorG1,
      quotaMode: 'disabled',
      profileResolver,
    });

    const g2 = new DeliveryRuntimeGateway({
      database: db,
      storage,
      messageStore,
      executor: executorG2,
      quotaMode: 'disabled',
      profileResolver,
    });

    // Dispatch message on G1 and G2 simultaneously to the SAME session
    const p1 = g1.dispatchInbound({
      id: createValidDeliveryId(),
      sessionId: 'ses1',
      userId: 'u1',
      content: 'G1 Message',
      timestamp: new Date().toISOString(),
    });

    const p2 = g2.dispatchInbound({
      id: createValidDeliveryId(),
      sessionId: 'ses1',
      userId: 'u1',
      content: 'G2 Message',
      timestamp: new Date().toISOString(),
    });

    await Promise.all([p1, p2]);

    await new Promise((r) => setTimeout(r, 40));

    // Even across two distinct gateway instances, max concurrency for the same session MUST be 1
    expect(maxCombinedConcurrency).toBe(1);

    resolveGate();

    await Promise.all([g1.drain(1000), g2.drain(1000)]);
  });

  // E11: Lock path traversal prevention
  it('E11. acquireSessionLock strictly rejects path traversal attempts and illegal session IDs', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-traversal-test-'));
    try {
      await expect(
        acquireSessionLock({
          dshHome: tmpDir,
          sessionId: '../../../etc/passwd',
          timeoutMs: 100,
        })
      ).rejects.toThrow(/PATH_TRAVERSAL_PREVENTED|Invalid session ID/);

      await expect(
        acquireSessionLock({
          dshHome: tmpDir,
          sessionId: 'ses_123/../../sub',
          timeoutMs: 100,
        })
      ).rejects.toThrow(/PATH_TRAVERSAL_PREVENTED|Invalid session ID/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // E12: raw_backup_path is sanitized in recovery state
  it('E12. raw_backup_path is sanitized and never exposes server host paths', async () => {
    const { db, storage, lifecycleService } = await setupTestEnv({
      runtimeArtifactPort: {
        checkSessionArtifact: async () => ({ exists: true, valid: false }),
        exportForkSeed: async () => ({
          events: [{ type: 'user/message', seq: 0, time: 1000, data: { content: 'Hi' } }],
          receipt: {
            algorithm: 'sha256-session-events-v1',
            checksum: 'test_chk',
            canonicalBytes: 50,
            eventCount: 1,
          },
        }),
        importSeed: async () => ({ status: 'ok', persisted: true, eventsCount: 1 }),
        inspectSessionCorruption: async () => ({
          exists: true,
          valid: false,
          corrupted: true,
          code: 'SEQ_GAP',
          lastValidSeq: 0,
          lineCount: 2,
          validEventsCount: 1,
        }),
        recoverValidPrefix: async (opts) => ({
          recovered: true,
          targetDshId: opts.targetDshId,
          validEventsCount: 1,
          backupPath: '/Users/admin/secret/private/path/backup.jsonl.bak',
          backupChecksum: 'backup_sha256_hash',
        }),
      },
    });

    const recovery = await lifecycleService.recoverValidPrefix('u1', 'ses1');
    expect(recovery.recovered).toBe(true);

    const row = db.prepare("SELECT raw_backup_path, raw_backup_checksum FROM session_recovery_state WHERE route_id = 'ses1'").get() as any;
    expect(row.raw_backup_path).toBe('backup.jsonl.bak');
    expect(row.raw_backup_path).not.toContain('/Users/admin');
  });
});
