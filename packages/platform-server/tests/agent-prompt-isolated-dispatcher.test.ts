import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
} from '../src/storage/migrations.js';
import {
  SqlitePlatformStorage,
  SqlitePlatformOperationsStorage,
} from '@enkeep/platform-storage-sqlite';
import {
  SqliteWebMessageStore,
} from '../src/storage/web-messages.js';
import {
  DeliveryRuntimeGateway,
  type DeliveryTurnExecutor,
} from '../src/runtime/delivery-gateway.js';
import {
  createAgentPromptDeliveryDispatcher,
  type AgentPromptDeliveryDispatcher,
} from '../src/operations/agent-prompt-dispatcher.js';
import type { AgentPromptDispatchContext } from '@enkeep/platform-operations';

describe('G11-P2 Scoped Isolated Dispatcher', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let messageStore: SqliteWebMessageStore;
  let operationsStorage: SqlitePlatformOperationsStorage;
  let deliveryGateway: DeliveryRuntimeGateway;
  let dispatcher: AgentPromptDeliveryDispatcher;

  const tenantAlice = 'user_alice_g11';
  const validTaskId = 'task_0123456789abcdef0123456789abcdef';
  const validAliceSpaceId = 'spc_0123456789abcdef0123456789abcdef';
  const validAliceSessionId = 'ses_0123456789abcdef0123456789abcdef';
  const validAliceSpaceFolder = 'space-0123456789abcdef0123456789abcdef';
  const validAliceDshSessionId = 'ses_11111111111111111111111111111111';

  let mockExecutor: DeliveryTurnExecutor;
  let executedTurns: Array<{ turnId: string; envelope: any }> = [];
  let shouldFailTurn = false;

  beforeEach(async () => {
    executedTurns = [];
    shouldFailTurn = false;

    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    storage = new SqlitePlatformStorage(db);
    messageStore = new SqliteWebMessageStore(db);
    operationsStorage = new SqlitePlatformOperationsStorage(db);

    await storage.users.create({
      id: tenantAlice,
      username: 'alice_g11',
      passwordHash: 'hash_alice',
      role: 'admin',
      status: 'active',
    });

    await storage.forTenant(tenantAlice).spaces.create({
      id: validAliceSpaceId,
      name: 'Alice Space',
      folder: validAliceSpaceFolder,
      executionMode: 'container',
    });

    await storage.forTenant(tenantAlice).sessionRoutes.create({
      id: validAliceSessionId,
      spaceId: validAliceSpaceId,
      channel: 'web',
      accountId: 'default',
      nativeContextId: validAliceSessionId,
      peerId: `web:${validAliceSessionId}`,
      dshSessionId: validAliceDshSessionId,
      executionMode: 'container',
    });

    // Set as canonical session for space
    db.prepare('UPDATE spaces SET canonical_session_id = ? WHERE id = ?').run(
      validAliceSessionId,
      validAliceSpaceId
    );

    mockExecutor = {
      async execute(request) {
        executedTurns.push({ turnId: request.turnId, envelope: request.envelope });
        if (shouldFailTurn) {
          throw new Error('Deterministic simulated executor failure');
        }
        await new Promise((r) => setTimeout(r, 15));
        return {
          replyText: `Deterministic assistant response for ${request.turnId}`,
          metadata: { eventsCount: 1, persisted: true },
          usage: { totalTokens: 12 },
        };
      },
      async cancel() {
        return true;
      },
    };

    deliveryGateway = new DeliveryRuntimeGateway({
      storage,
      messageStore,
      database: db,
      executor: mockExecutor,
      quotaMode: 'disabled',
      profileResolver: { resolve: async () => null },
    });

    dispatcher = createAgentPromptDeliveryDispatcher({
      gateway: deliveryGateway,
      storage,
      database: db,
      maxWaitMs: 3000,
      pollIntervalMs: 10,
    });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
  });

  function createDispatchContext(
    sessionPolicy: 'existing_session' | 'isolated'
  ): AgentPromptDispatchContext {
    const abortController = new AbortController();
    return {
      task: {
        id: validTaskId,
        userId: tenantAlice,
        title: 'Isolated Test Prompt Task',
        priority: 'high',
        status: 'running',
        payload: {
          type: 'agent_prompt',
          prompt: 'Execute isolated background task',
          sessionId: validAliceSessionId,
          sessionPolicy,
        },
        leaseDurationMs: 30000,
        claimCount: 1,
        maxRetries: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      payload: {
        type: 'agent_prompt',
        prompt: 'Execute isolated background task',
        sessionId: validAliceSessionId,
        sessionPolicy,
      },
      signal: abortController.signal,
      workerId: 'worker_g11_isolated',
      tenantId: tenantAlice,
    };
  }

  function getMessageCountForSession(sessionId: string): number {
    const row = db
      .prepare('SELECT COUNT(*) as cnt FROM web_messages WHERE user_id = ? AND session_id = ?')
      .get(tenantAlice, sessionId) as { cnt: number };
    return Number(row.cnt);
  }

  // 1. Isolated run: fresh same-space session without mutating canonical session, primary message count unchanged
  it('isolated run creates fresh same-space session, keeps primary session messages unchanged, and preserves canonical pointer', async () => {
    const primaryMsgCountBefore = getMessageCountForSession(validAliceSessionId);
    expect(primaryMsgCountBefore).toBe(0);

    // Create platform_tasks and task_runs record to verify session_id link
    db.prepare(`
      INSERT INTO platform_tasks (id, user_id, title, priority, status, created_at, updated_at)
      VALUES (?, ?, 'Isolated Test Task', 'high', 'running', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(validTaskId, tenantAlice);

    const runId = 'run_0123456789abcdef0123456789abcdef';
    db.prepare(`
      INSERT INTO task_runs (id, task_id, user_id, status, scheduled_for, started_at, created_at, updated_at)
      VALUES (?, ?, ?, 'running', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(runId, validTaskId, tenantAlice);

    const ctx = createDispatchContext('isolated');
    ctx.task.currentRun = { id: runId } as any;

    const result = await dispatcher.dispatch(ctx);

    expect(result.status).toBe('completed');
    expect(typeof result.completedAt).toBe('string');

    // Executed turn ran on a new isolated session
    expect(executedTurns.length).toBe(1);
    const isolatedSessionId = executedTurns[0].envelope.sessionId;
    expect(isolatedSessionId).not.toBe(validAliceSessionId);
    expect(isolatedSessionId).toMatch(/^ses_[0-9a-f]{32}$/);

    // Primary session messages count is completely unchanged (0 before, 0 after)
    const primaryMsgCountAfter = getMessageCountForSession(validAliceSessionId);
    expect(primaryMsgCountAfter).toBe(0);

    // Canonical session on spaces table remains the primary session (not mutated!)
    const spaceRow = db
      .prepare('SELECT canonical_session_id FROM spaces WHERE id = ?')
      .get(validAliceSpaceId) as { canonical_session_id: string };
    expect(spaceRow.canonical_session_id).toBe(validAliceSessionId);

    // Isolated session route was created in the same space
    const isolatedRoute = await storage.forTenant(tenantAlice).sessionRoutes.findById(isolatedSessionId);
    expect(isolatedRoute).not.toBeNull();
    expect(isolatedRoute?.spaceId).toBe(validAliceSpaceId);

    // task_runs record was linked with isolated session_id
    const taskRunRow = db
      .prepare('SELECT session_id, turn_id FROM task_runs WHERE id = ?')
      .get(runId) as { session_id: string; turn_id: string };
    expect(taskRunRow.session_id).toBe(isolatedSessionId);
    expect(taskRunRow.turn_id).toBe(executedTurns[0].turnId);
  });

  // 2. Cleanup on success: ephemeral session is archived after terminal completion while preserving transcript and turn_runs
  it('cleanup on success archives ephemeral session while preserving transcript and turn_runs', async () => {
    const ctx = createDispatchContext('isolated');
    const result = await dispatcher.dispatch(ctx);

    expect(result.status).toBe('completed');
    const isolatedSessionId = executedTurns[0].envelope.sessionId;

    // Ephemeral session is marked archived
    const isolatedRoute = await storage.forTenant(tenantAlice).sessionRoutes.findById(isolatedSessionId);
    expect(isolatedRoute?.status).toBe('archived');

    // Transcript is preserved (user prompt + assistant response)
    const isolatedMsgs = db
      .prepare('SELECT role, content, status FROM web_messages WHERE session_id = ? ORDER BY created_at ASC')
      .all(isolatedSessionId) as Array<{ role: string; content: string; status: string }>;
    expect(isolatedMsgs.length).toBe(2);
    expect(isolatedMsgs[0].role).toBe('user');
    expect(isolatedMsgs[0].content).toBe('Execute isolated background task');
    expect(isolatedMsgs[1].role).toBe('assistant');
    expect(isolatedMsgs[1].status).toBe('delivered');

    // turn_runs is preserved with completed status
    const turnRun = db
      .prepare('SELECT status, finished_at FROM turn_runs WHERE route_id = ? AND turn_id = ?')
      .get(isolatedSessionId, executedTurns[0].turnId) as { status: string; finished_at: string };
    expect(turnRun.status).toBe('completed');
    expect(turnRun.finished_at).toBe(result.completedAt);
  });

  // 3. Cleanup on failure: ephemeral session is archived after terminal failure while preserving error and debuggable outcome
  it('cleanup on failure archives ephemeral session while preserving error and debuggable outcome', async () => {
    shouldFailTurn = true;
    const ctx = createDispatchContext('isolated');

    await expect(dispatcher.dispatch(ctx)).rejects.toThrow(/Turn execution failed/);

    const isolatedSessionId = executedTurns[0].envelope.sessionId;

    // Ephemeral session is marked archived
    const isolatedRoute = await storage.forTenant(tenantAlice).sessionRoutes.findById(isolatedSessionId);
    expect(isolatedRoute?.status).toBe('archived');

    // turn_runs records failed status with error details preserved
    const turnRun = db
      .prepare('SELECT status, error FROM turn_runs WHERE route_id = ? AND turn_id = ?')
      .get(isolatedSessionId, executedTurns[0].turnId) as { status: string; error: string | null };
    expect(turnRun.status).toBe('failed');
    expect(turnRun.error).toBeTruthy();

    // Primary session is still 0 messages (no contamination on failure)
    expect(getMessageCountForSession(validAliceSessionId)).toBe(0);
  });

  // 4. Legacy existing_session compatibility: existing_session executes directly on primary session
  it('legacy existing_session compatibility executes directly on primary session without creating ephemeral session', async () => {
    const primaryMsgCountBefore = getMessageCountForSession(validAliceSessionId);
    expect(primaryMsgCountBefore).toBe(0);

    const ctx = createDispatchContext('existing_session');
    const result = await dispatcher.dispatch(ctx);

    expect(result.status).toBe('completed');
    expect(executedTurns.length).toBe(1);

    // Executed directly on primary session
    expect(executedTurns[0].envelope.sessionId).toBe(validAliceSessionId);

    // Primary session message count increased (user + assistant)
    const primaryMsgCountAfter = getMessageCountForSession(validAliceSessionId);
    expect(primaryMsgCountAfter).toBe(2);

    // Primary session remains active
    const primaryRoute = await storage.forTenant(tenantAlice).sessionRoutes.findById(validAliceSessionId);
    expect(primaryRoute?.status).toBe('active');
  });
});
