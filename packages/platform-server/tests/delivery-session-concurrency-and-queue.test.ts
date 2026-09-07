import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import {
  DeliveryRuntimeGateway,
  SqliteWebMessageStore,
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  type DeliveryExecutionRequest,
  type TurnExecutionResult,
} from '../src/index.js';
import type { InboundEnvelope } from '@enkeep/web-channel';

function createValidDeliveryId(): string {
  return `deliv_${randomUUID().replace(/-/g, '')}`;
}

async function setupTestEnv() {
  const db = new DatabaseSync(':memory:');
  const runner = new PlatformServerMigrationRunner(db);
  await runner.migrate(ALL_PLATFORM_MIGRATIONS);

  // Create users, spaces, and session routes
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES ('u1', 'alice', 'hash', 'admin')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES ('u2', 'bob', 'hash', 'user')").run();
  db.prepare("INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES ('sp1', 'u1', 'Space 1', 'space-1', 'container')").run();
  db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode) VALUES ('ses1', 'u1', 'sp1', 'web', 'web-demo', 'ses1', 'p1', 'dsh1', 'container')").run();
  db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode) VALUES ('ses2', 'u1', 'sp1', 'web', 'web-demo', 'ses2', 'p2', 'dsh2', 'container')").run();

  const storage = new SqlitePlatformStorage(db);
  const messageStore = new SqliteWebMessageStore(db);
  const profileResolver = { resolve: async () => null };

  return {
    db,
    storage,
    messageStore,
    profileResolver,
  };
}

describe('DeliveryRuntimeGateway Per-Session Concurrency & FIFO Queueing', () => {
  it('1. Serializes concurrent turns to the SAME session strictly in FIFO order with max concurrency = 1', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    let activeExecutions = 0;
    let maxObservedConcurrency = 0;
    const executionOrder: string[] = [];
    const executionTimes: Array<{ turnId: string; start: number; end: number }> = [];

    const executor = {
      execute: async (req: DeliveryExecutionRequest): Promise<TurnExecutionResult> => {
        activeExecutions++;
        maxObservedConcurrency = Math.max(maxObservedConcurrency, activeExecutions);
        const start = Date.now();
        executionOrder.push(req.content);

        // Simulate turn execution latency
        await new Promise((r) => setTimeout(r, 50));

        const end = Date.now();
        executionTimes.push({ turnId: req.turnId, start, end });
        activeExecutions--;

        return {
          replyText: `Echo: ${req.content}`,
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

    // Send 3 concurrent messages to the SAME session with sequential request timestamps
    const t0 = Date.now();
    const p1 = gateway.dispatchInbound({
      id: createValidDeliveryId(),
      sessionId: 'ses1',
      userId: 'u1',
      content: 'Message 1',
      timestamp: new Date(t0).toISOString(),
    });

    const p2 = gateway.dispatchInbound({
      id: createValidDeliveryId(),
      sessionId: 'ses1',
      userId: 'u1',
      content: 'Message 2',
      timestamp: new Date(t0 + 10).toISOString(),
    });

    const p3 = gateway.dispatchInbound({
      id: createValidDeliveryId(),
      sessionId: 'ses1',
      userId: 'u1',
      content: 'Message 3',
      timestamp: new Date(t0 + 20).toISOString(),
    });

    const [res1, res2, res3] = await Promise.all([p1, p2, p3]);

    expect(res1.accepted).toBe(true);
    expect(res2.accepted).toBe(true);
    expect(res3.accepted).toBe(true);

    // Drain all queued and running turns
    await gateway.drain(3000);

    // Max concurrency for the same session MUST be strictly 1
    expect(maxObservedConcurrency).toBe(1);

    // Execution order MUST match arrival order (FIFO)
    expect(executionOrder).toEqual(['Message 1', 'Message 2', 'Message 3']);

    // Execution time intervals MUST not overlap
    expect(executionTimes.length).toBe(3);
    expect(executionTimes[1].start).toBeGreaterThanOrEqual(executionTimes[0].end - 5);
    expect(executionTimes[2].start).toBeGreaterThanOrEqual(executionTimes[1].end - 5);

    // All 3 turns in SQLite turn_runs should be completed
    const turns = db.prepare(
      "SELECT turn_id, status FROM turn_runs WHERE route_id = 'ses1' ORDER BY created_at ASC"
    ).all() as Array<{ turn_id: string; status: string }>;
    expect(turns.length).toBe(3);
    expect(turns.every((t) => t.status === 'completed')).toBe(true);

    // Web messages history has all 3 user messages and 3 assistant replies
    const history = await messageStore.listMessages('u1', 'ses1');
    expect(history.messages.length).toBe(6);
    const userMessages = history.messages.filter((m) => m.role === 'user').map((m) => m.content);
    const assistantMessages = history.messages.filter((m) => m.role === 'assistant').map((m) => m.content);
    expect(userMessages).toEqual(['Message 1', 'Message 2', 'Message 3']);
    expect(assistantMessages).toEqual(['Echo: Message 1', 'Echo: Message 2', 'Echo: Message 3']);
  });

  it('2. Allows parallel execution across DIFFERENT sessions simultaneously', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    let activeExecutions = 0;
    let maxObservedConcurrency = 0;

    let resolveSession1!: () => void;
    const session1Gate = new Promise<void>((r) => { resolveSession1 = r; });

    let resolveSession2!: () => void;
    const session2Gate = new Promise<void>((r) => { resolveSession2 = r; });

    const executor = {
      execute: async (req: DeliveryExecutionRequest): Promise<TurnExecutionResult> => {
        activeExecutions++;
        maxObservedConcurrency = Math.max(maxObservedConcurrency, activeExecutions);

        if (req.sessionId === 'ses1') {
          await session1Gate;
        } else {
          await session2Gate;
        }

        activeExecutions--;
        return {
          replyText: `Echo: ${req.content}`,
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

    // Send message to Session 1 and Session 2 concurrently
    const p1 = gateway.dispatchInbound({
      id: createValidDeliveryId(),
      sessionId: 'ses1',
      userId: 'u1',
      content: 'Session 1 Msg',
      timestamp: new Date().toISOString(),
    });

    const p2 = gateway.dispatchInbound({
      id: createValidDeliveryId(),
      sessionId: 'ses2',
      userId: 'u1',
      content: 'Session 2 Msg',
      timestamp: new Date().toISOString(),
    });

    await Promise.all([p1, p2]);

    // Wait for both to be in flight
    await new Promise((r) => setTimeout(r, 40));

    // Both sessions should be executing concurrently (concurrency = 2)
    expect(maxObservedConcurrency).toBe(2);

    // Release both gates
    resolveSession1();
    resolveSession2();

    await gateway.drain(1000);

    const s1Status = await gateway.getCurrentTurnStatus('u1', 'ses1');
    const s2Status = await gateway.getCurrentTurnStatus('u1', 'ses2');
    expect(s1Status).toBeNull();
    expect(s2Status).toBeNull();
  });

  it('3. Cancelling a queued turn prevents its execution and advances queue to subsequent turns', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    let resolveTurn1!: () => void;
    const turn1Gate = new Promise<void>((r) => { resolveTurn1 = r; });

    const executedTurns: string[] = [];

    const executor = {
      execute: async (req: DeliveryExecutionRequest): Promise<TurnExecutionResult> => {
        executedTurns.push(req.content);
        if (req.content === 'Turn 1') {
          await turn1Gate;
        }
        return {
          replyText: `Echo: ${req.content}`,
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

    const res1 = await gateway.dispatchInbound({
      id: createValidDeliveryId(),
      sessionId: 'ses1',
      userId: 'u1',
      content: 'Turn 1',
      timestamp: new Date().toISOString(),
    });

    const res2 = await gateway.dispatchInbound({
      id: createValidDeliveryId(),
      sessionId: 'ses1',
      userId: 'u1',
      content: 'Turn 2 (To Cancel)',
      timestamp: new Date().toISOString(),
    });

    const res3 = await gateway.dispatchInbound({
      id: createValidDeliveryId(),
      sessionId: 'ses1',
      userId: 'u1',
      content: 'Turn 3',
      timestamp: new Date().toISOString(),
    });

    // Wait a tick for Turn 1 to start running
    await new Promise((r) => setTimeout(r, 20));

    // Turn 2 is currently queued. Cancel Turn 2!
    const cancelRes2 = await gateway.cancelTurn('u1', res2.turnId!);
    expect(cancelRes2).toBe(true);

    const turn2Status = await gateway.getTurnStatus('u1', res2.turnId!);
    expect(turn2Status.status).toBe('interrupted');

    // Complete Turn 1
    resolveTurn1();

    await gateway.drain(1000);

    // Turn 1 and Turn 3 executed; Turn 2 was skipped because it was cancelled while queued
    expect(executedTurns).toEqual(['Turn 1', 'Turn 3']);

    const finalTurn1 = await gateway.getTurnStatus('u1', res1.turnId!);
    const finalTurn2 = await gateway.getTurnStatus('u1', res2.turnId!);
    const finalTurn3 = await gateway.getTurnStatus('u1', res3.turnId!);

    expect(finalTurn1.status).toBe('completed');
    expect(finalTurn2.status).toBe('interrupted');
    expect(finalTurn3.status).toBe('completed');
  });

  it('4. Cancelling a running turn aborts executor and dequeues next turn in line', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    let turn1Cancelled = false;
    let resolveTurn1Started!: () => void;
    const turn1Started = new Promise<void>((r) => { resolveTurn1Started = r; });
    let resolveTurn1Wait!: () => void;
    const turn1Wait = new Promise<void>((r) => { resolveTurn1Wait = r; });

    const executedTurns: string[] = [];

    const executor = {
      execute: async (req: DeliveryExecutionRequest): Promise<TurnExecutionResult> => {
        executedTurns.push(req.content);
        if (req.content === 'Turn 1 Slow') {
          resolveTurn1Started();
          await turn1Wait;
          if (turn1Cancelled) {
            throw new Error('Turn cancelled by user');
          }
        }
        return {
          replyText: `Echo: ${req.content}`,
          usage: { totalTokens: 10 },
        };
      },
      cancel: async (_userId: string, _turnId: string) => {
        turn1Cancelled = true;
        resolveTurn1Wait();
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

    const res1 = await gateway.dispatchInbound({
      id: createValidDeliveryId(),
      sessionId: 'ses1',
      userId: 'u1',
      content: 'Turn 1 Slow',
      timestamp: new Date().toISOString(),
    });

    const res2 = await gateway.dispatchInbound({
      id: createValidDeliveryId(),
      sessionId: 'ses1',
      userId: 'u1',
      content: 'Turn 2 Fast',
      timestamp: new Date().toISOString(),
    });

    // Wait until Turn 1 is genuinely executing in executor
    await turn1Started;

    // Turn 1 is currently running. Cancel it via cancelCurrentTurn!
    const cancelRes = await gateway.cancelCurrentTurn('u1', 'ses1');
    expect(cancelRes).toBe(true);

    await gateway.drain(1000);

    expect(executedTurns).toEqual(['Turn 1 Slow', 'Turn 2 Fast']);

    const finalTurn1 = await gateway.getTurnStatus('u1', res1.turnId!);
    const finalTurn2 = await gateway.getTurnStatus('u1', res2.turnId!);

    expect(finalTurn1.status).toBe('interrupted');
    expect(finalTurn2.status).toBe('completed');
  });

  it('5. Handles concurrent duplicate message submissions idempotently without duplicate turns or queue corruption', async () => {
    const { db, storage, messageStore, profileResolver } = await setupTestEnv();

    let executionCount = 0;
    const executor = {
      execute: async (req: DeliveryExecutionRequest): Promise<TurnExecutionResult> => {
        executionCount++;
        await new Promise((r) => setTimeout(r, 20));
        return {
          replyText: `Echo: ${req.content}`,
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

    const sameEnvelope: InboundEnvelope = {
      id: createValidDeliveryId(),
      sessionId: 'ses1',
      userId: 'u1',
      content: 'Exact same message concurrently',
      timestamp: new Date().toISOString(),
    };

    // Dispatch exact same envelope 3 times concurrently
    const [d1, d2, d3] = await Promise.all([
      gateway.dispatchInbound(sameEnvelope),
      gateway.dispatchInbound(sameEnvelope),
      gateway.dispatchInbound(sameEnvelope),
    ]);

    expect(d1.accepted).toBe(true);
    expect(d2.accepted).toBe(true);
    expect(d3.accepted).toBe(true);

    // Exactly one must be fresh claimant, others are duplicates
    const duplicateFlags = [d1.isDuplicate, d2.isDuplicate, d3.isDuplicate];
    expect(duplicateFlags.filter((d) => d === false).length).toBe(1);
    expect(duplicateFlags.filter((d) => d === true).length).toBe(2);

    // All must share the same turnId
    expect(d1.turnId).toBe(d2.turnId);
    expect(d2.turnId).toBe(d3.turnId);

    await gateway.drain(1000);

    // Executor was executed exactly once
    expect(executionCount).toBe(1);
  });
});
