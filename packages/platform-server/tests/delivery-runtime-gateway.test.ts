import { describe, it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { ValidationError, PlatformError, NotFoundError } from '@enkeep/platform-core';
import {
  DeliveryRuntimeGateway,
  SqliteWebMessageStore,
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  PlatformServer,
  QuotaExceededError,
  estimateInboundTokens,
  extractActualUsage,
  type TenantQuotaProvider,
  type QuotaReservationBundle,
  type QuotaReservationRequest,
} from '../src/index.js';
import type { InboundEnvelope } from '@enkeep/web-channel';

function createValidDeliveryId(): string {
  return `deliv_${randomUUID().replace(/-/g, '')}`;
}

describe('Production DeliveryRuntimeGateway Lifecycle, CAS & Atomicity Testing', () => {
  const setupTestEnv = async () => {
    const db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    // Create user, space, and session route
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES ('u1', 'alice', 'hash', 'admin')").run();
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES ('u2', 'bob', 'hash', 'user')").run();
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
      sessionId: overrides.sessionId ?? (overrides as any).nativeContext?.nativeContextId ?? 'ses1',
      content: overrides.content ?? 'Hello Docker runtime',
      timestamp: overrides.timestamp ?? new Date().toISOString(),
      ...overrides,
    };
  };

  it('throws when executor is omitted or missing required methods', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    expect(() => {
      // @ts-expect-error missing executor
      new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        quotaMode: 'disabled',
        profileResolver,
    });
    }).toThrow('DeliveryRuntimeGateway requires an explicit "executor"');
  });

  it('runs turn lifecycle through queued -> running -> completed with single atomic transaction', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    let executedTurnId = '';
    let executedDshSessionId = '';
    const executor = {
      execute: async (req: DeliveryExecutionRequest) => {
        executedTurnId = req.turnId;
        executedDshSessionId = req.dshSessionId;
        return {
          replyText: `Executed reply to: ${req.content}`,
          metadata: { engine: 'docker' },
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

    const envelope = createSampleEnvelope();
    const result = await gateway.dispatchInbound(envelope);

    expect(result.accepted).toBe(true);
    expect(result.turnId).toBeDefined();
    const turnId = result.turnId!;

    // Wait microtask execution
    await gateway.drain(1000);

    expect(executedTurnId).toBe(turnId);
    expect(executedDshSessionId).toBe('dsh1');

    // Verify turn status in SQLite
    const status = await gateway.getTurnStatus('u1', turnId);
    expect(status.status).toBe('completed');

    // Verify user and assistant messages were persisted
    const history = await messageStore.listMessages('u1', 'ses1');
    expect(history.messages.length).toBe(2);
    expect(history.messages[0].role).toBe('user');
    expect(history.messages[1].role).toBe('assistant');
    expect(history.messages[1].content).toContain('Executed reply to: Hello Docker runtime');

    // Verify events were emitted
    const events = await messageStore.pollEvents('u1', 'ses1');
    expect(events.events.length).toBe(2);
    expect(events.events[0].type).toBe('message');
  });

  it('enforces multi-tenant isolation on turn querying and cancellation', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    const executor = {
      execute: async () => ({ replyText: 'Alice turn', usage: { totalTokens: 10 } }),
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

    const envelope = createSampleEnvelope();
    const result = await gateway.dispatchInbound(envelope);
    const turnId = result.turnId!;

    // Bob (u2) trying to query Alice's (u1) turn -> throws 404 NotFoundError
    await expect(gateway.getTurnStatus('u2', turnId)).rejects.toThrow();

    // Bob (u2) trying to cancel Alice's (u1) turn -> throws 404 NotFoundError
    await expect(gateway.cancelTurn('u2', turnId)).rejects.toThrow();
  });

  it('handles execution failure and records error status in SQLite across turn_runs, delivery_inbox, and idempotency_records, emitting turn_failed event', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    const executor = {
      execute: async () => {
        throw new Error('Docker container timeout');
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

    const envelope = createSampleEnvelope();
    const result = await gateway.dispatchInbound(envelope);
    const turnId = result.turnId!;

    // Wait microtask execution; drain does NOT throw because product failure is fully recorded and persisted
    await gateway.drain(1000);

    const status = await gateway.getTurnStatus('u1', turnId);
    expect(status.status).toBe('failed');
    expect(status.error).toBe('Turn execution failed');

    // Verify delivery_inbox status is 'failed' (from migration 007)
    const inboxRow = db.prepare('SELECT status, error FROM delivery_inbox WHERE turn_id = ?').get(turnId) as { status: string; error: string };
    expect(inboxRow.status).toBe('failed');
    expect(inboxRow.error).toBe('Turn execution failed');

    // Verify idempotency_records state is 'failed'
    const idemRow = db.prepare('SELECT state FROM idempotency_records WHERE turn_id = ?').get(turnId) as { state: string };
    expect(idemRow.state).toBe('failed');

    // Verify turn_failed event in web_events with generic code (no raw diagnostic leakage)
    const eventRow = db.prepare("SELECT type, payload FROM web_events WHERE session_id = 'ses1' AND type = 'turn_failed'").get() as { type: string; payload: string };
    expect(eventRow).toBeDefined();
    expect(eventRow.type).toBe('turn_failed');
    const parsedPayload = JSON.parse(eventRow.payload);
    expect(parsedPayload).toEqual({ code: 'EXECUTION_FAILED' });

    // Verify UI pollEvents sees the turn_failed event
    const events = await messageStore.pollEvents('u1', 'ses1');
    const failEvent = events.events.find((e) => e.type === 'turn_failed');
    expect(failEvent).toBeDefined();
  });

  it('sanitizes persisted execution errors: strips internal file paths and stack traces', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    const executor = {
      execute: async () => {
        const err = new Error('Execution failed while reading /Users/<user>/ClaudeCodeWS/DSH-Claw/secrets.key\n    at runInternal (/Users/<user>/ClaudeCodeWS/DSH-Claw/runner.ts:42:10)\n    at processTicksAndRejections (node:internal/process/task_queues:95:5)');
        throw err;
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

    const envelope = createSampleEnvelope({ id: 'path-leak-test-del' });
    const result = await gateway.dispatchInbound(envelope);
    const turnId = result.turnId!;

    await gateway.drain(1000);

    const status = await gateway.getTurnStatus('u1', turnId);
    expect(status.status).toBe('failed');
    // Ensure no filesystem paths or stack traces leaked into persisted error
    expect(status.error).not.toContain('/Users/<user>');
    expect(status.error).not.toContain('at runInternal');
    expect(status.error).toBe('Turn execution failed');

    const inboxRow = db.prepare('SELECT status, error FROM delivery_inbox WHERE turn_id = ?').get(turnId) as { status: string; error: string };
    expect(inboxRow.status).toBe('failed');
    expect(inboxRow.error).not.toContain('/Users/<user>');
    expect(inboxRow.error).not.toContain('at runInternal');
    expect(inboxRow.error).toBe('Turn execution failed');
  });

  it('cancels queued turn immediately via CAS', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    const executor = {
      execute: async () => ({ replyText: 'Done', usage: { totalTokens: 10 } }),
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

    const envelope = createSampleEnvelope();
    const result = await gateway.dispatchInbound(envelope);
    const turnId = result.turnId!;

    // Cancel while queued (synchronously right after dispatch)
    const cancelled = await gateway.cancelTurn('u1', turnId);
    expect(cancelled).toBe(true);

    const status = await gateway.getTurnStatus('u1', turnId);
    expect(status.status).toBe('interrupted');
    expect(status.error).toContain('Turn cancelled by user');
  });

  it('cancels running turn through executor first and transitions to interrupted', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    let cancelCalled = false;
    let finishExecution: () => void;
    const executionWait = new Promise<void>((resolve) => {
      finishExecution = resolve;
    });

    const executor = {
      execute: async () => {
        await executionWait;
        return { replyText: 'Done after cancel', usage: { totalTokens: 10 } };
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

    const envelope = createSampleEnvelope();
    const result = await gateway.dispatchInbound(envelope);
    const turnId = result.turnId!;

    // Wait a brief moment to enter 'running' state
    await new Promise((r) => setTimeout(r, 20));

    const statusBefore = await gateway.getTurnStatus('u1', turnId);
    expect(statusBefore.status).toBe('running');

    // Cancel while running
    const cancelled = await gateway.cancelTurn('u1', turnId);
    expect(cancelled).toBe(true);
    expect(cancelCalled).toBe(true);

    const statusAfter = await gateway.getTurnStatus('u1', turnId);
    expect(statusAfter.status).toBe('interrupted');
    expect(statusAfter.error).toContain('Turn cancelled by user');

    // Draining finishes without emitting outbound because turn was interrupted
    await gateway.drain(1000);
    const history = await messageStore.listMessages('u1', 'ses1');
    expect(history.messages.length).toBe(1);
    expect(history.messages[0].role).toBe('user');

    // Verify delivery_inbox was updated to 'cancelled' and idempotency_records to 'failed'
    const inboxRow = db.prepare('SELECT status, error FROM delivery_inbox WHERE turn_id = ?').get(turnId) as { status: string; error: string };
    expect(inboxRow.status).toBe('cancelled');
    expect(inboxRow.error).toContain('Turn cancelled by user');

    const idemRow = db.prepare('SELECT state FROM idempotency_records WHERE turn_id = ?').get(turnId) as { state: string };
    expect(idemRow.state).toBe('failed');

    // Verify turn_cancelled event in web_events
    const eventRow = db.prepare("SELECT type, payload FROM web_events WHERE session_id = 'ses1' AND type = 'turn_cancelled'").get() as { type: string; payload: string };
    expect(eventRow).toBeDefined();
    expect(eventRow.type).toBe('turn_cancelled');
    const parsedPayload = JSON.parse(eventRow.payload);
    expect(parsedPayload).toEqual({ code: 'USER_CANCELLED' });

    // Verify UI pollEvents sees the turn_cancelled event
    const events = await messageStore.pollEvents('u1', 'ses1');
    const cancelEvent = events.events.find((e) => e.type === 'turn_cancelled');
    expect(cancelEvent).toBeDefined();
  });

  it('cancelling queued turn atomically synchronizes turn_runs, delivery_inbox, and idempotency_records', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    const executor = {
      execute: async () => ({ replyText: 'Never runs' }),
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

    const envelope = createSampleEnvelope({ id: 'queued-cancel-test-del' });
    const result = await gateway.dispatchInbound(envelope);
    const turnId = result.turnId!;

    // Ingested record is in queued state for turn_runs
    const cancelled = await gateway.cancelTurn('u1', turnId);
    expect(cancelled).toBe(true);

    const turnRow = db.prepare('SELECT status, error FROM turn_runs WHERE turn_id = ?').get(turnId) as { status: string; error: string };
    expect(turnRow.status).toBe('interrupted');

    const inboxRow = db.prepare('SELECT status FROM delivery_inbox WHERE turn_id = ?').get(turnId) as { status: string };
    expect(inboxRow.status).toBe('cancelled');

    const idemRow = db.prepare('SELECT state FROM idempotency_records WHERE turn_id = ?').get(turnId) as { state: string };
    expect(idemRow.state).toBe('failed');
  });

  it('cancel failure propagates error and leaves database unchanged', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    let finishExecution: () => void;
    const executionWait = new Promise<void>((resolve) => {
      finishExecution = resolve;
    });

    const executor = {
      execute: async () => {
        await executionWait;
        return { replyText: 'Done' };
      },
      cancel: async () => {
        throw new Error('Kill container connection lost');
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

    const envelope = createSampleEnvelope();
    const result = await gateway.dispatchInbound(envelope);
    const turnId = result.turnId!;

    await new Promise((r) => setTimeout(r, 20));

    // Cancel throws error -> error propagates
    await expect(gateway.cancelTurn('u1', turnId)).rejects.toThrow('Kill container connection lost');

    // Turn is still running, DB was NOT modified to interrupted
    const status = await gateway.getTurnStatus('u1', turnId);
    expect(status.status).toBe('running');

    finishExecution!();
    await gateway.drain(1000);
  });

  it('drain throws AggregateError when in-flight turn cancellation fails on timeout', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    const executor = {
      execute: async () => {
        // Hang forever until timeout
        await new Promise(() => {});
        return { replyText: 'Never' };
      },
      cancel: async () => {
        throw new Error('Docker container kill failed: container unresponsive');
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

    const envelope = createSampleEnvelope({ id: 'drain-error-test-del' });
    await gateway.dispatchInbound(envelope);

    // Drain with very short timeout to trigger cancellation
    await expect(gateway.drain(50)).rejects.toThrowError(AggregateError);
  });

  it('preserves running status if executor cancel returns false', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    let finishExecution: () => void;
    const executionWait = new Promise<void>((resolve) => {
      finishExecution = resolve;
    });

    const executor = {
      execute: async () => {
        await executionWait;
        return { replyText: 'Completed despite cancel attempt', usage: { totalTokens: 10 } };
      },
      cancel: async () => {
        // Cannot cancel
        return false;
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

    const envelope = createSampleEnvelope();
    const result = await gateway.dispatchInbound(envelope);
    const turnId = result.turnId!;

    await new Promise((r) => setTimeout(r, 20));

    // Cancel returns false
    const cancelled = await gateway.cancelTurn('u1', turnId);
    expect(cancelled).toBe(false);

    // Let execution finish
    finishExecution!();
    await gateway.drain(1000);

    const finalStatus = await gateway.getTurnStatus('u1', turnId);
    expect(finalStatus.status).toBe('completed');

    const history = await messageStore.listMessages('u1', 'ses1');
    expect(history.messages.length).toBe(2);
    expect(history.messages[0].role).toBe('user');
    expect(history.messages[1].role).toBe('assistant');
    expect(history.messages[1].content).toBe('Completed despite cancel attempt');
  });

  it('drain timeout cancels slow executor and awaits full settlement without DB UAF', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    let cancelledOnTimeout = false;
    let finishExecution: () => void;
    const slowTask = new Promise<void>((resolve) => {
      finishExecution = resolve;
    });

    const executor = {
      execute: async () => {
        await slowTask;
        return { replyText: 'Slow reply' };
      },
      cancel: async () => {
        cancelledOnTimeout = true;
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

    const envelope = createSampleEnvelope();
    const result = await gateway.dispatchInbound(envelope);
    expect(result.turnId).toBeDefined();

    await new Promise((r) => setTimeout(r, 20));

    // Drain with short timeout (40ms) - triggers cancellation and returns true on clean settlement
    const cleanSettled = await gateway.drain(40);
    expect(cleanSettled).toBe(true);
    expect(cancelledOnTimeout).toBe(true);

    // After drain returns, all in-flight promises have settled, so db.close() can be called safely
    expect(() => db.close()).not.toThrow();
  });

  it('two concurrent requests with same idempotency key barrier: only one executes, both return same turn', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    let executeCalls = 0;
    const executor = {
      execute: async (env: InboundEnvelope) => {
        executeCalls++;
        await new Promise((r) => setTimeout(r, 30));
        return { replyText: `Handled: ${env.content}`, usage: { totalTokens: 10 } };
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

    const envelope = createSampleEnvelope({ id: 'concurrent-idem-key-12345' });

    // Fire 2 concurrent requests with identical envelope (same Idempotency-Key)
    const [res1, res2] = await Promise.all([
      gateway.dispatchInbound(envelope),
      gateway.dispatchInbound(envelope),
    ]);

    expect(res1.turnId).toBeDefined();
    expect(res2.turnId).toBeDefined();
    // Both receive the exact same turnId
    expect(res1.turnId).toBe(res2.turnId);

    // One is original claimant, the other is duplicate
    const isDup1 = !!res1.isDuplicate;
    const isDup2 = !!res2.isDuplicate;
    expect(isDup1 !== isDup2).toBe(true);

    await gateway.drain(1000);

    // Executor was only invoked once!
    expect(executeCalls).toBe(1);

    // Turn is completed
    const status = await gateway.getTurnStatus('u1', res1.turnId!);
    expect(status.status).toBe('completed');
  });

  it('rejects same idempotency key with different request payload with 409 Conflict', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    const executor = {
      execute: async () => ({ replyText: 'Done', usage: { totalTokens: 10 } }),
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

    const envelope1 = createSampleEnvelope({
      id: 'conflict-idem-key-12345',
      content: 'Original request payload',
    });

    const envelope2 = createSampleEnvelope({
      id: 'conflict-idem-key-12345',
      content: 'Different payload with same key!',
    });

    const res1 = await gateway.dispatchInbound(envelope1);
    expect(res1.accepted).toBe(true);

    // Dispatching envelope2 with same idempotency key but different content throws 409
    await expect(gateway.dispatchInbound(envelope2)).rejects.toThrowError(/already used with different request parameters/);

    await gateway.drain(1000);
  });

  it('rejects same idempotency key targeting different sessionId with 409 Conflict', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    // Create ses2 route in storage
    db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode) VALUES ('ses2', 'u1', 'sp1', 'web', 'web-demo', 'ses2', 'p1', 'dsh2', 'container')").run();

    const executor = {
      execute: async () => ({ replyText: 'Done', usage: { totalTokens: 10 } }),
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

    const envelope1 = createSampleEnvelope({
      id: 'session-conflict-idem-key',
      sessionId: 'ses1',
    });

    const envelope2 = createSampleEnvelope({
      id: 'session-conflict-idem-key',
      sessionId: 'ses2',
    });

    const res1 = await gateway.dispatchInbound(envelope1);
    expect(res1.accepted).toBe(true);

    await expect(gateway.dispatchInbound(envelope2)).rejects.toThrowError(/already used with different request parameters or session/);
    await gateway.drain(1000);
  });

  it('fails loud with 500 INVARIANT_VIOLATION when idempotency record exists without matching user message', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    const executor = {
      execute: async () => ({ replyText: 'Done', usage: { totalTokens: 10 } }),
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

    const envelope = createSampleEnvelope({ id: 'corrupted-db-idem-key' });
    const res1 = await gateway.dispatchInbound(envelope);
    expect(res1.accepted).toBe(true);

    // Simulate database corruption / inconsistency: delete user message while idempotency record remains
    db.prepare('DELETE FROM web_messages WHERE turn_id = ?').run(res1.turnId);

    // Duplicate request must fail loud with invariant violation, NEVER fabricate fake message
    await expect(gateway.dispatchInbound(envelope)).rejects.toThrowError(/Database invariant violation/);
    await gateway.drain(1000);
  });

  it('rejects dispatch with NotFoundError when session route does not exist', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    const executor = {
      execute: async () => ({ replyText: 'Done', usage: { totalTokens: 10 } }),
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

    const envelope = createSampleEnvelope({
      sessionId: 'non-existent-session',
    });

    await expect(gateway.dispatchInbound(envelope)).rejects.toThrow(NotFoundError);
  });

  it('flows route.dshSessionId directly to executor.execute and throws ValidationError if missing or empty', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    let passedDshSessionId = '';
    const executor = {
      execute: async (req: DeliveryExecutionRequest) => {
        passedDshSessionId = req.dshSessionId;
        return { replyText: `Handled for DSH session: ${req.dshSessionId}`, usage: { totalTokens: 10 } };
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

    // ses1 in setupTestEnv has dsh_session_id = 'dsh1'
    const envelope = createSampleEnvelope();
    const result = await gateway.dispatchInbound(envelope);
    expect(result.accepted).toBe(true);

    await gateway.drain(1000);
    expect(passedDshSessionId).toBe('dsh1');

    // Create session route with empty dsh_session_id
    db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode) VALUES ('ses_empty_dsh', 'u1', 'sp1', 'web', 'web-demo', 'ses_empty_dsh', 'p1', '', 'container')").run();

    const gateway2 = new DeliveryRuntimeGateway({
      database: db,
      storage,
      messageStore,
      executor,
      quotaMode: 'disabled',
      profileResolver,
    });

    const envelopeEmptyDsh = createSampleEnvelope({
      sessionId: 'ses_empty_dsh',
    });

    // Must fail loud with ValidationError, NEVER fallback to session id
    await expect(gateway2.dispatchInbound(envelopeEmptyDsh)).rejects.toThrow(ValidationError);
  });

  it('rejects turn execution if executor returns invalid or empty replyText', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    const executor = {
      execute: async () => ({ replyText: '   ' }),
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

    const envelope = createSampleEnvelope();
    const result = await gateway.dispatchInbound(envelope);
    const turnId = result.turnId!;

    await gateway.drain(1000);

    const status = await gateway.getTurnStatus('u1', turnId);
    expect(status.status).toBe('failed');
    expect(status.error).toBe('Turn execution failed');
  });

  it('handles cancellation and completion race using CAS on turn_runs (completion wins)', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    let finishExecution: () => void;
    const executionWait = new Promise<void>((resolve) => {
      finishExecution = resolve;
    });

    const executor = {
      execute: async () => {
        await executionWait;
        return { replyText: 'Completed turn reply', usage: { totalTokens: 10 } };
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

    const envelope = createSampleEnvelope();
    const result = await gateway.dispatchInbound(envelope);
    const turnId = result.turnId!;

    // Wait until running
    await new Promise((r) => setTimeout(r, 20));

    // Release executor to complete turn
    finishExecution!();
    await gateway.drain(1000);

    // Turn is now completed
    const finalStatus = await gateway.getTurnStatus('u1', turnId);
    expect(finalStatus.status).toBe('completed');

    // Cancelling an already completed turn returns false (CAS changes = 0)
    const cancelRes = await gateway.cancelTurn('u1', turnId);
    expect(cancelRes).toBe(false);
  });

  it('handles cancellation vs completion race when cancellation wins CAS', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    let finishExecution: () => void;
    const executionWait = new Promise<void>((resolve) => {
      finishExecution = resolve;
    });

    const executor = {
      execute: async () => {
        await executionWait;
        return { replyText: 'Too late reply', usage: { totalTokens: 10 } };
      },
      cancel: async () => {
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

    const envelope = createSampleEnvelope();
    const result = await gateway.dispatchInbound(envelope);
    const turnId = result.turnId!;

    await new Promise((r) => setTimeout(r, 20));

    // Cancel while running
    const cancelled = await gateway.cancelTurn('u1', turnId);
    expect(cancelled).toBe(true);

    // Now finish execution after cancellation already CAS'd to interrupted
    finishExecution!();
    await gateway.drain(1000);

    // Turn remains interrupted
    const finalStatus = await gateway.getTurnStatus('u1', turnId);
    expect(finalStatus.status).toBe('interrupted');

    // No assistant message was inserted because completion saw changes === 0 and rolled back
    const history = await messageStore.listMessages('u1', 'ses1');
    expect(history.messages.length).toBe(1);
    expect(history.messages[0].role).toBe('user');
  });

  it('fails loud with INVARIANT_VIOLATION when turn completes but associated delivery_inbox row was corrupted', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    let finishExecution: () => void;
    const executionWait = new Promise<void>((resolve) => {
      finishExecution = resolve;
    });

    const executor = {
      execute: async () => {
        await executionWait;
        return { replyText: 'Corrupted completion reply', usage: { totalTokens: 10 } };
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

    const envelope = createSampleEnvelope({ id: 'corrupt-inbox-del' });
    const result = await gateway.dispatchInbound(envelope);
    const turnId = result.turnId!;

    await new Promise((r) => setTimeout(r, 20));

    // Corrupt delivery_inbox state behind the scenes (e.g. set status to 'cancelled' while turn_runs is 'running')
    db.prepare("UPDATE delivery_inbox SET status = 'cancelled' WHERE turn_id = ?").run(turnId);

    // Let executor finish
    finishExecution!();

    // Drain captures the invariant error in settledErrors and throws AggregateError
    await expect(gateway.drain(1000)).rejects.toThrow(AggregateError);

    // No assistant message was persisted because completion transaction rolled back
    const history = await messageStore.listMessages('u1', 'ses1');
    expect(history.messages.length).toBe(1);
    expect(history.messages[0].role).toBe('user');

    // No turn_failed event was emitted because completion failure is an infrastructure corruption, not a product execution failure
    const events = await messageStore.pollEvents('u1', 'ses1');
    const failEvent = events.events.find((e) => e.type === 'turn_failed');
    expect(failEvent).toBeUndefined();
  });

  it('distinguishes product execution failures from infrastructure errors: product failure persists cleanly without failing drain', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    const executor = {
      execute: async () => {
        throw new Error('Agent execution timed out in sandbox');
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

    const envelope = createSampleEnvelope({ id: 'product-fail-test' });
    const result = await gateway.dispatchInbound(envelope);
    const turnId = result.turnId!;

    // Expected product failures do NOT throw on drain() because the failure transaction succeeded and emitted turn_failed
    const drainResult = await gateway.drain(1000);
    expect(drainResult).toBe(true);

    const status = await gateway.getTurnStatus('u1', turnId);
    expect(status.status).toBe('failed');
    expect(status.error).toBe('Turn execution failed');

    // UI event poll sees turn_failed
    const events = await messageStore.pollEvents('u1', 'ses1');
    const failEvent = events.events.find((e) => e.type === 'turn_failed');
    expect(failEvent).toBeDefined();
  });

  it('fails loud with INVARIANT_VIOLATION during cancel when turn_runs succeeds but delivery_inbox is corrupted', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    const executor = {
      execute: async () => ({ replyText: 'Done', usage: { totalTokens: 10 } }),
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

    const envelope = createSampleEnvelope({ id: 'cancel-corrupt-del' });
    const result = await gateway.dispatchInbound(envelope);
    const turnId = result.turnId!;

    // Corrupt delivery_inbox: delete the row so inbox update fails
    db.prepare('DELETE FROM delivery_inbox WHERE turn_id = ?').run(turnId);

    // Attempt cancel while queued -> should fail loud with INVARIANT_VIOLATION
    await expect(gateway.cancelTurn('u1', turnId)).rejects.toThrow('Database invariant violation: delivery_inbox state was inconsistent');
  });

  it('recovers stranded processing/running state on startup and redrives turns', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    let redriveRan = 0;
    const executor = {
      execute: async () => {
        redriveRan++;
        return { replyText: 'Redriven reply', usage: { totalTokens: 10 } };
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

    const envelope = createSampleEnvelope({ id: 'stranded-turn-key' });
    const result = await gateway.dispatchInbound(envelope);
    const turnId = result.turnId!;
    await gateway.drain(1000);

    // Simulate process killed while turn had active lease with phase 'claimed':
    db.prepare("INSERT OR REPLACE INTO session_execution_leases (id, user_id, route_id, turn_id, generation, phase, status, worker_id, acquired_at, heartbeat_at, expires_at) VALUES ('lease_crash', 'u1', 'ses1', ?, 1, 'claimed', 'active', 'dead_worker', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").run(turnId);
    db.prepare("UPDATE delivery_inbox SET status = 'processing' WHERE turn_id = ?").run(turnId);
    db.prepare("UPDATE idempotency_records SET state = 'processing' WHERE idempotency_key = ?").run('stranded-turn-key');
    db.prepare("UPDATE turn_runs SET status = 'running' WHERE turn_id = ?").run(turnId);

    // Call redriveHeld -> should recover stranded records to held/queued and redrive
    const redriven = await gateway.redriveHeld();
    expect(redriven).toBe(1);

    await gateway.drain(1000);
    expect(redriveRan).toBeGreaterThanOrEqual(1);

    const status = await gateway.getTurnStatus('u1', turnId);
    expect(status.status).toBe('completed');
  });

  it('throws AggregateError on corrupted JSON payload during startup redrive', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    const executor = {
      execute: async () => ({ replyText: 'Done', usage: { totalTokens: 10 } }),
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

    // Insert corrupt record into delivery_inbox
    db.prepare(`
      INSERT INTO delivery_inbox (id, user_id, route_id, message_id, delivery_id, payload, status, turn_id)
      VALUES ('inbox_corrupt', 'u1', 'ses1', 'msg_corrupt', 'del_corrupt', 'NOT_VALID_JSON{{{', 'held', 'turn_corrupt')
    `).run();

    await expect(gateway.redriveHeld()).rejects.toThrowError(AggregateError);
  });

  it('verifies startup recovery ownership: calls ONLY redriveHeld on Drainable gateway, ONLY recoverAfterRestart on non-Drainable', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    const recoverSpy = vi.spyOn(storage, 'recoverAfterRestart');

    let redriveCalled = 0;
    const drainableGateway = {
      dispatchInbound: async () => ({ accepted: true }),
      getTurnStatus: async () => ({ status: 'completed' as const }),
      cancelTurn: async () => true,
      drain: async () => true,
      redriveHeld: async () => {
        redriveCalled++;
        return 0;
      },
    };

    const server1 = new PlatformServer({
      database: db,
      cookieSecret: 'explicit-valid-cookie-secret-32-chars-long!',
      csrfToken: 'explicit-valid-csrf-token-32-chars-long-ok!',
      runtimeGateway: drainableGateway,
      storage,
      autoRecover: true,
    });

    await server1.start();
    await server1.stop();

    // On drainable gateway: redriveHeld called 1 time, recoverAfterRestart called 0 times
    expect(redriveCalled).toBe(1);
    expect(recoverSpy).toHaveBeenCalledTimes(0);

    // Non-drainable gateway
    const plainGateway = {
      dispatchInbound: async () => ({ accepted: true }),
      getTurnStatus: async () => ({ status: 'completed' as const }),
      cancelTurn: async () => true,
    };

    const server2 = new PlatformServer({
      database: db,
      cookieSecret: 'explicit-valid-cookie-secret-32-chars-long!',
      csrfToken: 'explicit-valid-csrf-token-32-chars-long-ok!',
      runtimeGateway: plainGateway,
      storage,
      autoRecover: true,
    });

    await server2.start();
    await server2.stop();

    // On non-drainable gateway: recoverAfterRestart called 1 time
    expect(recoverSpy).toHaveBeenCalledTimes(1);
  });

  describe('Tenant Quota Provider & Interceptor Closed-Loop Enforcement', () => {
    it('constructor fails closed when quotaMode is enforced without quotaProvider or without commitInTransaction/releaseInTransaction', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      expect(() => {
        new DeliveryRuntimeGateway({
          database: db,
          storage,
          messageStore,
          executor: {
            execute: async () => ({ replyText: 'Ok', usage: { totalTokens: 10 } }),
            cancel: async () => true,
          },
          quotaMode: 'enforced',
          profileResolver
        });
      }).toThrow('DeliveryRuntimeGateway quotaMode is "enforced" but quotaProvider is missing or lacks mandatory reserve() implementation.');

      // Fails when quotaProvider reserve is not a function
      expect(() => {
        new DeliveryRuntimeGateway({
          database: db,
          storage,
          messageStore,
          executor: {
            execute: async () => ({ replyText: 'Ok', usage: { totalTokens: 10 } }),
            cancel: async () => true,
          },
          quotaMode: 'enforced',
          quotaProvider: {} as any,
          profileResolver
        });
      }).toThrow('DeliveryRuntimeGateway quotaMode is "enforced" but quotaProvider is missing or lacks mandatory reserve() implementation.');
    });

    it('explicit quotaMode="disabled" does not require quotaProvider and allows turns to execute normally without reservations', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      let reserveCalled = false;
      const gateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor: {
          execute: async () => ({
            replyText: 'Executed without quota',
            usage: { totalTokens: 10 },
          }),
          cancel: async () => true,
        },
        quotaMode: 'disabled',
        quotaProvider: {
          reserve: async () => {
            reserveCalled = true;
            throw new Error('Should not be called in disabled mode');
          },
          commit: async () => {},
          release: async () => {},
          renew: async () => {},
          commitInTransaction: () => {},
          releaseInTransaction: () => {},
        },
          profileResolver
        });

      expect(gateway.getQuotaMode()).toBe('disabled');
      expect(gateway.getQuotaProvider()).toBeDefined();

      const envelope = createSampleEnvelope();
      const result = await gateway.dispatchInbound(envelope);
      expect(result.accepted).toBe(true);
      expect(result.turnId).toBeDefined();

      await gateway.drain(1000);

      expect(reserveCalled).toBe(false);
      const status = await gateway.getTurnStatus('u1', result.turnId!);
      expect(status.status).toBe('completed');
    });

    it('enforced marks turn and user message failed with QUOTA_EXCEEDED when quota is exceeded at claim time (zero assistant messages)', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      let executorCalled = false;
      const executor = {
        execute: async () => {
          executorCalled = true;
          return { replyText: 'Should not run' };
        },
        cancel: async () => true,
      };

      const quotaProvider: TenantQuotaProvider = {
        reserve: async (_req) => {
          // Reject with QuotaExceededError
          throw new QuotaExceededError('Quota exceeded for turns/messages', 'turns', 1, 0, 100);
        },
        commit: async () => {},
        release: async () => {},
        renew: async () => {},
        commitInTransaction: () => {},
        releaseInTransaction: () => {},
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

      const dispatchRes = await gateway.dispatchInbound(envelope);
      expect(dispatchRes.accepted).toBe(true);
      const turnId = dispatchRes.turnId!;

      await gateway.drain(1000);

      expect(executorCalled).toBe(false);

      // Verify turn is marked failed in SQLite
      const turnRow = db.prepare('SELECT status, error FROM turn_runs WHERE turn_id = ?').get(turnId) as { status: string; error?: string };
      expect(turnRow.status).toBe('failed');
      expect(turnRow.error).toBe('Quota exceeded');

      // Verify delivery inbox is marked failed
      const inboxRow = db.prepare('SELECT status, error FROM delivery_inbox WHERE turn_id = ?').get(turnId) as { status: string; error?: string };
      expect(inboxRow.status).toBe('failed');

      // Verify user message in web_messages is marked failed
      const userMsg = db.prepare('SELECT status FROM web_messages WHERE turn_id = ? AND role = \'user\'').get(turnId) as { status: string };
      expect(userMsg.status).toBe('failed');

      // Verify ZERO assistant messages were written into web_messages
      const assistantMsgCount = (db.prepare('SELECT COUNT(*) as count FROM web_messages WHERE role = \'assistant\'').get() as { count: number }).count;
      expect(assistantMsgCount).toBe(0);
    });

    it('successful turn lifecycle commits reservation bundle with actual token usage from executor metadata', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      let reservedReq: QuotaReservationRequest | undefined;
      let committedUsage: { turns?: number; messages?: number; tokens?: number } | undefined;
      let committedCount = 0;
      let releasedCount = 0;

      const quotaProvider: TenantQuotaProvider = {
        reserve: async (req) => {
          reservedReq = req;
          return {
            reservationId: 'res-bundle-123',
            userId: req.userId,
            turns: req.turns,
            messages: req.messages,
            tokens: req.tokens,
            isEstimateTokens: req.isEstimateTokens,
            commit: async () => {},
            release: async () => {
              releasedCount++;
            },
            renew: async () => {},
            commitInTransaction: (_db, actualUsage) => {
              committedCount++;
              committedUsage = actualUsage;
            },
            releaseInTransaction: () => {
              releasedCount++;
            },
          };
        },
      };

      const executor = {
        execute: async () => ({
          replyText: 'Valid reply from container',
          usage: {
            totalTokens: 35,
          },
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

      const envelope = createSampleEnvelope({ content: 'Explain quantum computing in 2 lines' });
      const result = await gateway.dispatchInbound(envelope);
      expect(result.accepted).toBe(true);

      await gateway.drain(1000);

      expect(reservedReq).toBeDefined();
      expect(reservedReq!.turns).toBe(1);
      expect(reservedReq!.messages).toBe(1);
      expect(reservedReq!.isEstimateTokens).toBe(true);
      expect(reservedReq!.tokens).toBeGreaterThan(0);

      await gateway.drain(1000);

      expect(committedCount).toBe(1);
      expect(releasedCount).toBe(0);
      expect(committedUsage).toEqual({
        turns: 1,
        messages: 1,
        tokens: 35,
      });

      const status = await gateway.getTurnStatus('u1', result.turnId!);
      expect(status.status).toBe('completed');
    });

    it('releases reservation bundle when executor fails and does not commit quota', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      let committedCount = 0;
      let releasedCount = 0;

      const quotaProvider: TenantQuotaProvider = {
        reserve: async (req) => ({
          reservationId: 'res-bundle-fail',
          userId: req.userId,
          turns: req.turns,
          messages: req.messages,
          tokens: req.tokens,
          isEstimateTokens: req.isEstimateTokens,
          commit: async () => {},
          release: async () => {
            releasedCount++;
          },
          renew: async () => {},
          commitInTransaction: () => {
            committedCount++;
          },
          releaseInTransaction: () => {
            releasedCount++;
          },
        }),
      };

      const executor = {
        execute: async () => {
          throw new Error('Sandbox crashed out of memory');
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

      const envelope = createSampleEnvelope();
      const result = await gateway.dispatchInbound(envelope);
      expect(result.accepted).toBe(true);

      await gateway.drain(1000);

      expect(committedCount).toBe(0);
      expect(releasedCount).toBe(1);

      const status = await gateway.getTurnStatus('u1', result.turnId!);
      expect(status.status).toBe('failed');
      expect(status.error).toBe('Turn execution failed');
    });

    it('never creates or releases reservation bundle when queued turn is cancelled via CAS before claim', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      let committedCount = 0;
      let releasedCount = 0;
      let reservedCount = 0;

      const quotaProvider: TenantQuotaProvider = {
        reserve: async (req) => {
          reservedCount++;
          return {
            reservationId: 'res-bundle-cancel-queued',
            userId: req.userId,
            turns: req.turns,
            messages: req.messages,
            tokens: req.tokens,
            isEstimateTokens: req.isEstimateTokens,
            commit: async () => {},
            release: async () => {
              releasedCount++;
            },
            renew: async () => {},
            commitInTransaction: () => {
              committedCount++;
            },
            releaseInTransaction: () => {
              releasedCount++;
            },
          };
        },
      };

      const executor = {
        execute: async () => ({ replyText: 'Never runs' }),
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

      // Cancel while queued
      const cancelled = await gateway.cancelTurn('u1', turnId);
      expect(cancelled).toBe(true);

      await gateway.drain(1000);

      expect(reservedCount).toBe(0);
      expect(committedCount).toBe(0);
      expect(releasedCount).toBe(0);

      const status = await gateway.getTurnStatus('u1', turnId);
      expect(status.status).toBe('interrupted');
    });

    it('releases reservation bundle when running turn is cancelled via executor', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      let committedCount = 0;
      let releasedCount = 0;
      let finishExecution: () => void;
      const executionWait = new Promise<void>((resolve) => {
        finishExecution = resolve;
      });

      const quotaProvider: TenantQuotaProvider = {
        reserve: async (req) => ({
          reservationId: 'res-bundle-cancel-running',
          userId: req.userId,
          turns: req.turns,
          messages: req.messages,
          tokens: req.tokens,
          isEstimateTokens: req.isEstimateTokens,
          commit: async () => {},
          release: async () => {
            releasedCount++;
          },
          renew: async () => {},
          commitInTransaction: () => {
            committedCount++;
          },
          releaseInTransaction: () => {
            releasedCount++;
          },
        }),
      };

      const executor = {
        execute: async () => {
          await executionWait;
          return { replyText: 'Done after cancel', usage: { totalTokens: 10 } };
        },
        cancel: async () => {
          finishExecution();
          return true;
        },
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
      const turnId = result.turnId!;

      await new Promise((r) => setTimeout(r, 20));

      const cancelled = await gateway.cancelTurn('u1', turnId);
      expect(cancelled).toBe(true);

      await gateway.drain(1000);

      expect(committedCount).toBe(0);
      expect(releasedCount).toBe(1);

      const status = await gateway.getTurnStatus('u1', turnId);
      expect(status.status).toBe('interrupted');
    });

    it('duplicate idempotency requests pre-occupy only once: duplicate release immediately and does not double-commit', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      let reserveCount = 0;
      let committedCount = 0;
      let releasedCount = 0;

      const quotaProvider: TenantQuotaProvider = {
        reserve: async (req) => {
          reserveCount++;
          return {
            reservationId: `res-bundle-dup-${reserveCount}`,
            userId: req.userId,
            turns: req.turns,
            messages: req.messages,
            tokens: req.tokens,
            isEstimateTokens: req.isEstimateTokens,
            commit: async () => {},
            release: async () => {
              releasedCount++;
            },
            renew: async () => {},
            commitInTransaction: () => {
              committedCount++;
            },
            releaseInTransaction: () => {
              releasedCount++;
            },
          };
        },
      };

      const executor = {
        execute: async (env: InboundEnvelope) => {
          await new Promise((r) => setTimeout(r, 30));
          return { replyText: `Handled: ${env.content}`, usage: { totalTokens: 10 } };
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

      const envelope = createSampleEnvelope({ id: createValidDeliveryId() });

      const [res1, res2] = await Promise.all([
        gateway.dispatchInbound(envelope),
        gateway.dispatchInbound(envelope),
      ]);

      expect(res1.turnId).toBe(res2.turnId);
      expect(res1.isDuplicate !== res2.isDuplicate).toBe(true);

      await gateway.drain(1000);

      // Exactly 1 commit for the winner, any concurrent duplicate reservations released cleanly
      expect(committedCount).toBe(1);
      expect(releasedCount).toBe(reserveCount - 1);
      expect(reserveCount).toBeGreaterThanOrEqual(1);
    });

    it('releases reservation bundle when SQLite completion transaction fails', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      let committedCount = 0;
      let releasedCount = 0;
      let finishExecution: () => void;
      const executionWait = new Promise<void>((resolve) => {
        finishExecution = resolve;
      });

      const quotaProvider: TenantQuotaProvider = {
        reserve: async (req) => ({
          reservationId: 'res-bundle-db-fail',
          userId: req.userId,
          turns: req.turns,
          messages: req.messages,
          tokens: req.tokens,
          isEstimateTokens: req.isEstimateTokens,
          commit: async () => {},
          release: async () => {
            releasedCount++;
          },
          renew: async () => {},
          commitInTransaction: () => {
            committedCount++;
            throw new Error('SQLite disk failure during quota bundle commit');
          },
          releaseInTransaction: () => {
            releasedCount++;
          },
        }),
      };

      const executor = {
        execute: async () => {
          await executionWait;
          return { replyText: 'Completed turn reply', usage: { totalTokens: 10 } };
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

      const envelope = createSampleEnvelope({ id: createValidDeliveryId() });
      const result = await gateway.dispatchInbound(envelope);
      const turnId = result.turnId!;

      await new Promise((r) => setTimeout(r, 20));

      finishExecution!();

      // Drain catches the error in settledErrors
      await expect(gateway.drain(1000)).rejects.toThrow(AggregateError);

      // Quota reservation was released in failure transaction, not committed or leaked
      expect(committedCount).toBe(1);
      expect(releasedCount).toBe(1);
    });

    it('constructor throws CONFIGURATION_ERROR if quotaMode is omitted or invalid', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      expect(() => {
        // @ts-expect-error missing quotaMode
        new DeliveryRuntimeGateway({
          database: db,
          storage,
          messageStore,
          executor: {
            execute: async () => ({ replyText: 'Ok', usage: { totalTokens: 10 } }),
            cancel: async () => true,
          },
          profileResolver
        });
      }).toThrow('DeliveryRuntimeGateway requires an explicit "quotaMode" ("disabled" or "enforced"). Implicit default quotaMode is forbidden.');

      expect(() => {
        // @ts-expect-error invalid quotaMode
        new DeliveryRuntimeGateway({
          database: db,
          storage,
          messageStore,
          executor: {
            execute: async () => ({ replyText: 'Ok', usage: { totalTokens: 10 } }),
            cancel: async () => true,
          },
          quotaMode: 'something-invalid',
          profileResolver
        });
      }).toThrow('DeliveryRuntimeGateway requires an explicit "quotaMode" ("disabled" or "enforced"). Implicit default quotaMode is forbidden.');
    });

    it('rejects with INVALID_QUOTA_PROVIDER_RESPONSE if quota provider returns missing/empty reservationId or invalid numbers (no fake IDs generated)', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      const quotaProviderMissingId: TenantQuotaProvider = {
        // @ts-expect-error missing reservationId
        reserve: async () => ({
          turns: 1,
          messages: 1,
          tokens: 10,
          isEstimateTokens: true,
          commit: async () => {},
          release: async () => {},
          renew: async () => {},
          commitInTransaction: () => {},
          releaseInTransaction: () => {},
        }),
        commit: async () => {},
        release: async () => {},
        renew: async () => {},
        commitInTransaction: () => {},
        releaseInTransaction: () => {},
      };

      const gateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor: {
          execute: async () => ({ replyText: 'Ok', usage: { totalTokens: 10 } }),
          cancel: async () => true,
        },
        quotaMode: 'enforced',
        quotaProvider: quotaProviderMissingId,
        profileResolver,
      });

      const envelope = createSampleEnvelope({ id: createValidDeliveryId() });
      const dispatchRes = await gateway.dispatchInbound(envelope);
      expect(dispatchRes.accepted).toBe(true);

      await gateway.drain(1000);

      const status = await gateway.getTurnStatus('u1', dispatchRes.turnId!);
      expect(status.status).toBe('failed');

      // Verify invalid numbers for turns/messages are also rejected
      const quotaProviderInvalidNumbers: TenantQuotaProvider = {
        reserve: async () => ({
          reservationId: 'authoritative-id-123',
          userId: 'u1',
          turns: 0,
          messages: 1,
          tokens: 10,
          isEstimateTokens: true,
          commit: async () => {},
          release: async () => {},
          renew: async () => {},
          commitInTransaction: () => {},
          releaseInTransaction: () => {},
        }),
        commit: async () => {},
        release: async () => {},
        renew: async () => {},
        commitInTransaction: () => {},
        releaseInTransaction: () => {},
      };

      const gateway2 = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor: {
          execute: async () => ({ replyText: 'Ok', usage: { totalTokens: 10 } }),
          cancel: async () => true,
        },
        quotaMode: 'enforced',
        quotaProvider: quotaProviderInvalidNumbers,
        profileResolver,
      });

      const dispatchRes2 = await gateway2.dispatchInbound(createSampleEnvelope({ id: createValidDeliveryId() }));
      expect(dispatchRes2.accepted).toBe(true);

      await gateway2.drain(1000);

      const status2 = await gateway2.getTurnStatus('u1', dispatchRes2.turnId!);
      expect(status2.status).toBe('failed');
    });

    it('adversarial validation: rejects cross-tenant userId, mismatched metrics, and missing commit/release methods', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();
      const envelope = createSampleEnvelope({ id: createValidDeliveryId() });

      // 1. Cross-tenant mismatch: requested 'u1', provider returns 'u2'
      const quotaProviderCrossTenant: TenantQuotaProvider = {
        reserve: async (req) => ({
          reservationId: 'auth-res-cross-tenant',
          userId: 'u2', // mismatched tenant!
          turns: req.turns,
          messages: req.messages,
          tokens: req.tokens,
          isEstimateTokens: req.isEstimateTokens,
          commit: async () => {},
          release: async () => {},
          renew: async () => {},
          commitInTransaction: () => {},
          releaseInTransaction: () => {},
        }),
        commit: async () => {},
        release: async () => {},
        renew: async () => {},
        commitInTransaction: () => {},
        releaseInTransaction: () => {},
      };

      const gatewayTenantMismatch = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor: { execute: async () => ({ replyText: 'Ok', usage: { totalTokens: 10 } }), cancel: async () => true },
        quotaMode: 'enforced',
        quotaProvider: quotaProviderCrossTenant,
        profileResolver,
      });

      const res1 = await gatewayTenantMismatch.dispatchInbound(createSampleEnvelope({ id: createValidDeliveryId() }));
      expect(res1.accepted).toBe(true);
      await gatewayTenantMismatch.drain(1000);
      const stat1 = await gatewayTenantMismatch.getTurnStatus('u1', res1.turnId!);
      expect(stat1.status).toBe('failed');

      // 2. Metric mismatch: requested 1 turn, provider claims 5 turns
      const quotaProviderMetricMismatch: TenantQuotaProvider = {
        reserve: async (req) => ({
          reservationId: 'auth-res-metric-mismatch',
          userId: req.userId,
          turns: 5, // mismatched!
          messages: req.messages,
          tokens: req.tokens,
          isEstimateTokens: req.isEstimateTokens,
          commit: async () => {},
          release: async () => {},
          renew: async () => {},
          commitInTransaction: () => {},
          releaseInTransaction: () => {},
        }),
        commit: async () => {},
        release: async () => {},
        renew: async () => {},
        commitInTransaction: () => {},
        releaseInTransaction: () => {},
      };

      const gatewayMetricMismatch = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor: { execute: async () => ({ replyText: 'Ok', usage: { totalTokens: 10 } }), cancel: async () => true },
        quotaMode: 'enforced',
        quotaProvider: quotaProviderMetricMismatch,
        profileResolver,
      });

      const res2 = await gatewayMetricMismatch.dispatchInbound(createSampleEnvelope({ id: createValidDeliveryId() }));
      expect(res2.accepted).toBe(true);
      await gatewayMetricMismatch.drain(1000);
      const stat2 = await gatewayMetricMismatch.getTurnStatus('u1', res2.turnId!);
      expect(stat2.status).toBe('failed');

      // 3. Tokens mismatch: provider claims different token amount
      const quotaProviderTokenMismatch: TenantQuotaProvider = {
        reserve: async (req) => ({
          reservationId: 'auth-res-token-mismatch',
          userId: req.userId,
          turns: req.turns,
          messages: req.messages,
          tokens: 99999, // mismatched tokens!
          isEstimateTokens: req.isEstimateTokens,
          commit: async () => {},
          release: async () => {},
          renew: async () => {},
          commitInTransaction: () => {},
          releaseInTransaction: () => {},
        }),
        commit: async () => {},
        release: async () => {},
        renew: async () => {},
        commitInTransaction: () => {},
        releaseInTransaction: () => {},
      };

      const gatewayTokenMismatch = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor: { execute: async () => ({ replyText: 'Ok', usage: { totalTokens: 10 } }), cancel: async () => true },
        quotaMode: 'enforced',
        quotaProvider: quotaProviderTokenMismatch,
        profileResolver,
      });

      const res3 = await gatewayTokenMismatch.dispatchInbound(createSampleEnvelope({ id: createValidDeliveryId() }));
      expect(res3.accepted).toBe(true);
      await gatewayTokenMismatch.drain(1000);
      const stat3 = await gatewayTokenMismatch.getTurnStatus('u1', res3.turnId!);
      expect(stat3.status).toBe('failed');

      // 4. Missing commit/release methods
      const quotaProviderMissingMethods = {
        reserve: async (req: QuotaReservationRequest) => ({
          reservationId: 'auth-res-no-methods',
          userId: req.userId,
          turns: req.turns,
          messages: req.messages,
          tokens: req.tokens,
          isEstimateTokens: req.isEstimateTokens,
        }),
        commitInTransaction: () => {},
        releaseInTransaction: () => {},
      } as unknown as TenantQuotaProvider;

      const gatewayMissingMethods = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor: { execute: async () => ({ replyText: 'Ok', usage: { totalTokens: 10 } }), cancel: async () => true },
        quotaMode: 'enforced',
        quotaProvider: quotaProviderMissingMethods,
        profileResolver,
      });

      const res4 = await gatewayMissingMethods.dispatchInbound(createSampleEnvelope({ id: createValidDeliveryId() }));
      expect(res4.accepted).toBe(true);
      await gatewayMissingMethods.drain(1000);
      const stat4 = await gatewayMissingMethods.getTurnStatus('u1', res4.turnId!);
      expect(stat4.status).toBe('failed');
    });

    it('generates full 128-bit hexadecimal identifiers without truncation for messages and web events in delivery gateway', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      const gateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor: {
          execute: async () => ({
            replyText: 'Testing 128-bit ID strength',
            usage: { totalTokens: 10 },
          }),
          cancel: async () => true,
        },
        quotaMode: 'disabled',
          profileResolver
        });

      const envelope = createSampleEnvelope({ id: createValidDeliveryId() });
      const result = await gateway.dispatchInbound(envelope);
      expect(result.accepted).toBe(true);

      await gateway.drain(1000);

      const history = await messageStore.listMessages('u1', 'ses1');
      const assistantMsg = history.messages.find((m) => m.role === 'assistant');
      expect(assistantMsg).toBeDefined();

      // Verify message ID is msg_ followed by 32 hex chars (128-bit, no 16-hex truncation)
      expect(assistantMsg!.id).toMatch(/^msg_[0-9a-f]{32}$/);
      const msgRow = db.prepare('SELECT metadata FROM web_messages WHERE id = ?').get(assistantMsg!.id) as { metadata: unknown };
      expect(msgRow.metadata).toBeNull();

      // Verify assistant message completion event emitted by gateway into web_events is evt_ followed by 32 hex chars
      const eventRows = db.prepare("SELECT id, type, payload FROM web_events WHERE user_id = 'u1' AND session_id = 'ses1'").all() as Array<{ id: string; type: string; payload: string }>;
      const assistantEvent = eventRows.find((e) => {
        try {
          const p = JSON.parse(e.payload);
          return p?.role === 'assistant' || p?.message?.role === 'assistant';
        } catch {
          return false;
        }
      });
      expect(assistantEvent).toBeDefined();
      expect(assistantEvent!.id).toMatch(/^evt_[0-9a-f]{32}$/);

      // Also test fail event generated by gateway on execution failure
      const failGateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor: {
          execute: async () => {
            throw new Error('Execution failed for full ID test');
          },
          cancel: async () => true,
        },
        quotaMode: 'disabled',
        profileResolver,
    });

      const failEnvelope = createSampleEnvelope({ id: createValidDeliveryId() });
      await failGateway.dispatchInbound(failEnvelope);
      await failGateway.drain(1000);

      const failEvents = await messageStore.pollEvents('u1', 'ses1');
      const failEvent = failEvents.events.find((e) => e.type === 'turn_failed');
      expect(failEvent).toBeDefined();
      expect(failEvent!.id).toMatch(/^evt_[0-9a-f]{32}$/);
    });

    it('strictly rejects dispatch when session route is archived with 409 SESSION_ARCHIVED and zero quota reservations or turn records', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      // Create an archived session route in SQLite
      db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, status) VALUES ('ses_archived', 'u1', 'sp1', 'web', 'web-demo', 'ses_archived', 'p1', 'dsh_archived', 'container', 'archived')").run();

      let reserveCalled = false;
      const quotaProvider: TenantQuotaProvider = {
        reserve: async () => {
          reserveCalled = true;
          return {
            reservationId: 'should-not-be-called',
            userId: 'u1',
            turns: 1,
            messages: 1,
            tokens: 10,
            isEstimateTokens: true,
            commit: async () => {},
            release: async () => {},
            renew: async () => {},
            commitInTransaction: () => {},
            releaseInTransaction: () => {},
          };
        },
        commit: async () => {},
        release: async () => {},
        renew: async () => {},
        commitInTransaction: () => {},
        releaseInTransaction: () => {},
      };

      const gateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor: { execute: async () => ({ replyText: 'Ok', usage: { totalTokens: 10 } }), cancel: async () => true },
        quotaMode: 'enforced',
        quotaProvider,
          profileResolver
        });

      const envelope = createSampleEnvelope({
        sessionId: 'ses_archived',
      });

      await expect(gateway.dispatchInbound(envelope)).rejects.toMatchObject({
        code: 'SESSION_ARCHIVED',
        status: 409,
      });

      // Assert ZERO quota reservations were requested
      expect(reserveCalled).toBe(false);

      // Assert ZERO turn runs, delivery inbox records, or messages were written
      const turns = (db.prepare("SELECT COUNT(*) as count FROM turn_runs").get() as { count: number }).count;
      const inbox = (db.prepare("SELECT COUNT(*) as count FROM delivery_inbox WHERE route_id = 'ses_archived'").get() as { count: number }).count;
      expect(turns).toBe(0);
      expect(inbox).toBe(0);
    });

    it('strictly rejects dispatch when parent space is archived with 409 SPACE_ARCHIVED and zero quota reservations or turn records', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      // Create an archived space and an active session route under that archived space
      db.prepare("INSERT INTO spaces (id, user_id, name, folder, status) VALUES ('sp_archived', 'u1', 'Archived Space', 'space-archived', 'archived')").run();
      db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, status) VALUES ('ses_in_archived_space', 'u1', 'sp_archived', 'web', 'web-demo', 'ses_in_archived_space', 'p1', 'dsh_sp_archived', 'container', 'active')").run();

      let reserveCalled = false;
      const quotaProvider: TenantQuotaProvider = {
        reserve: async () => {
          reserveCalled = true;
          return {
            reservationId: 'should-not-be-called',
            userId: 'u1',
            turns: 1,
            messages: 1,
            tokens: 10,
            isEstimateTokens: true,
            commit: async () => {},
            release: async () => {},
            renew: async () => {},
            commitInTransaction: () => {},
            releaseInTransaction: () => {},
          };
        },
        commit: async () => {},
        release: async () => {},
        renew: async () => {},
        commitInTransaction: () => {},
        releaseInTransaction: () => {},
      };

      const gateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor: { execute: async () => ({ replyText: 'Ok', usage: { totalTokens: 10 } }), cancel: async () => true },
        quotaMode: 'enforced',
        quotaProvider,
          profileResolver
        });

      const envelope = createSampleEnvelope({
        sessionId: 'ses_in_archived_space',
      });

      await expect(gateway.dispatchInbound(envelope)).rejects.toMatchObject({
        code: 'SPACE_ARCHIVED',
        status: 409,
      });

      // Assert ZERO quota reservations were requested
      expect(reserveCalled).toBe(false);

      // Assert ZERO turn runs or delivery inbox records were written
      const turns = (db.prepare("SELECT COUNT(*) as count FROM turn_runs").get() as { count: number }).count;
      const inbox = (db.prepare("SELECT COUNT(*) as count FROM delivery_inbox WHERE route_id = 'ses_in_archived_space'").get() as { count: number }).count;
      expect(turns).toBe(0);
      expect(inbox).toBe(0);
    });

    it('archive race condition safety: route or space archived immediately prior to dispatch pre-reservation fails closed with 409', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      let reserveCalled = false;
      const quotaProvider: TenantQuotaProvider = {
        reserve: async () => {
          reserveCalled = true;
          return {
            reservationId: 'race-auth-id',
            userId: 'u1',
            turns: 1,
            messages: 1,
            tokens: 10,
            isEstimateTokens: true,
            commit: async () => {},
            release: async () => {},
            renew: async () => {},
            commitInTransaction: () => {},
            releaseInTransaction: () => {},
          };
        },
        commit: async () => {},
        release: async () => {},
        renew: async () => {},
        commitInTransaction: () => {},
        releaseInTransaction: () => {},
      };

      const gateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor: { execute: async () => ({ replyText: 'Ok', usage: { totalTokens: 10 } }), cancel: async () => true },
        quotaMode: 'enforced',
        quotaProvider,
          profileResolver
        });

      // Transition session route 'ses1' status to 'archived'
      db.prepare("UPDATE session_routes SET status = 'archived' WHERE id = 'ses1'").run();

      const envelope = createSampleEnvelope();
      await expect(gateway.dispatchInbound(envelope)).rejects.toMatchObject({
        code: 'SESSION_ARCHIVED',
        status: 409,
      });

      expect(reserveCalled).toBe(false);
    });

    it('archive race condition during ingestion (space archived): space archived prior to dispatch rejects with 409 and zero quota reservations', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      let reserveCalled = false;
      const quotaProvider: TenantQuotaProvider = {
        reserve: async () => {
          reserveCalled = true;
          throw new Error('Should not be called');
        },
        commit: async () => {},
        release: async () => {},
        renew: async () => {},
        commitInTransaction: () => {},
        releaseInTransaction: () => {},
      };

      const gateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor: { execute: async () => ({ replyText: 'Ok', usage: { totalTokens: 10 } }), cancel: async () => true },
        quotaMode: 'enforced',
        quotaProvider,
        profileResolver,
      });

      // Archive space before dispatch
      db.prepare("UPDATE spaces SET status = 'archived' WHERE id = 'sp1'").run();

      const envelope = createSampleEnvelope({ id: createValidDeliveryId() });

      // Ingest should encounter SPACE_ARCHIVED inside BEGIN IMMEDIATE and fail loud with 409
      await expect(gateway.dispatchInbound(envelope)).rejects.toMatchObject({
        code: 'SPACE_ARCHIVED',
        status: 409,
      });

      // Verify quota was never reserved
      expect(reserveCalled).toBe(false);

      // Verify ZERO records written into any operational table
      const turns = (db.prepare("SELECT COUNT(*) as count FROM turn_runs").get() as { count: number }).count;
      const inbox = (db.prepare("SELECT COUNT(*) as count FROM delivery_inbox").get() as { count: number }).count;
      const msgs = (db.prepare("SELECT COUNT(*) as count FROM web_messages").get() as { count: number }).count;
      const idem = (db.prepare("SELECT COUNT(*) as count FROM idempotency_records").get() as { count: number }).count;

      expect(turns).toBe(0);
      expect(inbox).toBe(0);
      expect(msgs).toBe(0);
      expect(idem).toBe(0);
    });

    it('archive race condition during ingestion (session archived): session archived prior to dispatch rejects with 409 and zero quota reservations', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      let reserveCalled = false;
      const quotaProvider: TenantQuotaProvider = {
        reserve: async () => {
          reserveCalled = true;
          throw new Error('Should not be called');
        },
        commit: async () => {},
        release: async () => {},
        renew: async () => {},
        commitInTransaction: () => {},
        releaseInTransaction: () => {},
      };

      const gateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor: { execute: async () => ({ replyText: 'Ok', usage: { totalTokens: 10 } }), cancel: async () => true },
        quotaMode: 'enforced',
        quotaProvider,
        profileResolver,
      });

      // Archive session before dispatch
      db.prepare("UPDATE session_routes SET status = 'archived' WHERE id = 'ses1'").run();

      const envelope = createSampleEnvelope({ id: createValidDeliveryId() });

      // Ingest should encounter SESSION_ARCHIVED inside BEGIN IMMEDIATE and fail loud with 409
      await expect(gateway.dispatchInbound(envelope)).rejects.toMatchObject({
        code: 'SESSION_ARCHIVED',
        status: 409,
      });

      // Verify quota was never reserved
      expect(reserveCalled).toBe(false);

      // Verify ZERO records written into any operational table
      const turns = (db.prepare("SELECT COUNT(*) as count FROM turn_runs").get() as { count: number }).count;
      const inbox = (db.prepare("SELECT COUNT(*) as count FROM delivery_inbox").get() as { count: number }).count;
      const msgs = (db.prepare("SELECT COUNT(*) as count FROM web_messages").get() as { count: number }).count;
      const idem = (db.prepare("SELECT COUNT(*) as count FROM idempotency_records").get() as { count: number }).count;

      expect(turns).toBe(0);
      expect(inbox).toBe(0);
      expect(msgs).toBe(0);
      expect(idem).toBe(0);
    });

    it('state machine allows release when commit throws: release is genuinely called and quota is not leaked', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      let commitAttempts = 0;
      let releaseAttempts = 0;

      const quotaProvider: TenantQuotaProvider = {
        reserve: async (req) => ({
          reservationId: 'res-authoritative-commit-fail',
          userId: req.userId,
          turns: req.turns,
          messages: req.messages,
          tokens: req.tokens,
          isEstimateTokens: req.isEstimateTokens,
          commit: async () => {},
          release: async () => {
            releaseAttempts++;
          },
          renew: async () => {},
          commitInTransaction: () => {
            commitAttempts++;
            throw new Error('Ledger DB connection timeout during commit');
          },
          releaseInTransaction: () => {
            releaseAttempts++;
          },
        }),
      };

      const executor = {
        execute: async () => ({ replyText: 'Execution succeeded in container', usage: { totalTokens: 10 } }),
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
      const res = await gateway.dispatchInbound(envelope);
      expect(res.accepted).toBe(true);

      // Drain will throw because commit failed during lifecycle
      await expect(gateway.drain(1000)).rejects.toThrow(AggregateError);

      // Verify commit was attempted once, failed, and release was successfully and genuinely called on cleanup
      expect(commitAttempts).toBe(1);
      expect(releaseAttempts).toBe(1);
    });

    it('deterministic token estimation and honest metadata extraction work without fabrication', () => {
      // 1. Token estimation
      const estShort = estimateInboundTokens('Hi');
      expect(estShort.estimatedTokens).toBe(1);
      expect(estShort.isEstimateTokens).toBe(true);

      const estLong = estimateInboundTokens('a'.repeat(400));
      expect(estLong.estimatedTokens).toBe(100);
      expect(estLong.isEstimateTokens).toBe(true);

      expect(() => estimateInboundTokens('')).toThrow(ValidationError);

      // 2. Metadata / usage extraction:
      // Missing usage -> throws ValidationError
      expect(() => extractActualUsage(undefined, 50)).toThrow(ValidationError);
      expect(() => extractActualUsage(null, 50)).toThrow(ValidationError);
      expect(() => extractActualUsage({}, 50)).toThrow(ValidationError);

      // With exact usage.totalTokens
      expect(extractActualUsage({ totalTokens: 120 }, 50)).toEqual({ tokens: 120 });
      expect(extractActualUsage({ totalTokens: 0 }, 50)).toEqual({ tokens: 0 });

      // Malformed or unknown keys throw
      expect(() => extractActualUsage({ totalTokens: -1 }, 50)).toThrow(ValidationError);
      expect(() => extractActualUsage({ totalTokens: 1.5 }, 50)).toThrow(ValidationError);
      expect(() => extractActualUsage({ totalTokens: '100' }, 50)).toThrow(ValidationError);
      expect(() => extractActualUsage({ extraKey: 123 }, 50)).toThrow(ValidationError);
      expect(() => extractActualUsage({ totalTokens: 100, promptTokens: 50 }, 50)).toThrow(ValidationError);
    });

    it('treats missing usage from executor as turn failure (terminal failed + release quota)', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      const executor = {
        execute: async () => ({
          replyText: 'Reply without usage',
        } as any),
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

      const envelope = createSampleEnvelope();
      const result = await gateway.dispatchInbound(envelope);
      const turnId = result.turnId!;

      await gateway.drain(1000);

      const status = await gateway.getTurnStatus('u1', turnId);
      expect(status.status).toBe('failed');
    });

    it('getCurrentTurnStatus returns latest non-terminal status or null', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      let finishExecution: () => void;
      const executionWait = new Promise<void>((resolve) => {
        finishExecution = resolve;
      });

      const executor = {
        execute: async () => {
          await executionWait;
          return { replyText: 'Done', usage: { totalTokens: 10 } };
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

      // Initially no turn exists
      const initialStatus = await gateway.getCurrentTurnStatus('u1', 'ses1');
      expect(initialStatus).toBeNull();

      // Dispatch inbound turn
      const envelope = createSampleEnvelope({ id: 'turn-status-test-1' });
      await gateway.dispatchInbound(envelope);

      await new Promise((r) => setTimeout(r, 20));

      // In running state
      const runningStatus = await gateway.getCurrentTurnStatus('u1', 'ses1');
      expect(runningStatus).toEqual({ status: 'running' });

      // Finish execution
      finishExecution!();
      await gateway.drain(1000);

      // After completion, no active nonterminal turn exists -> returns null
      const completedStatus = await gateway.getCurrentTurnStatus('u1', 'ses1');
      expect(completedStatus).toBeNull();
    });

    it('cancelCurrentTurn finds latest non-terminal turn for session and cancels it', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      let finishExecution: () => void;
      const executionWait = new Promise<void>((resolve) => {
        finishExecution = resolve;
      });

      const executor = {
        execute: async () => {
          await executionWait;
          return { replyText: 'Done', usage: { totalTokens: 10 } };
        },
        cancel: async () => {
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

      // No turn to cancel -> returns false
      const cancelNonexistent = await gateway.cancelCurrentTurn('u1', 'ses1');
      expect(cancelNonexistent).toBe(false);

      // Dispatch turn
      const envelope = createSampleEnvelope({ id: 'turn-cancel-current-test' });
      const result = await gateway.dispatchInbound(envelope);
      const turnId = result.turnId!;

      await new Promise((r) => setTimeout(r, 20));

      // Cancel current active turn
      const cancelled = await gateway.cancelCurrentTurn('u1', 'ses1');
      expect(cancelled).toBe(true);

      const status = await gateway.getTurnStatus('u1', turnId);
      expect(status.status).toBe('interrupted');

      await gateway.drain(1000);
    });

    it('cancels corrupt turn record without route_id by failing loud with INVARIANT_VIOLATION', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      const gateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor: { execute: async () => ({ replyText: 'ok',
    }), cancel: async () => true },
        quotaMode: 'disabled',
          profileResolver
        });

      // Insert corrupt turn_runs row with empty route_id by temporarily disabling foreign keys
      db.prepare('PRAGMA foreign_keys = OFF').run();
      db.prepare(`
        INSERT INTO turn_runs (id, user_id, space_id, route_id, turn_id, status)
        VALUES ('tr_corrupt', 'u1', 'sp1', '', 'turn_corrupt_route', 'queued')
      `).run();
      db.prepare('PRAGMA foreign_keys = ON').run();

      await expect(gateway.cancelTurn('u1', 'turn_corrupt_route')).rejects.toThrowError(/INVARIANT_VIOLATION|missing route_id/);
    });
  });
});
