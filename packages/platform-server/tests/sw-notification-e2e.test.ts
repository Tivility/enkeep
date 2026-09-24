import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
} from '../src/operations/agent-prompt-dispatcher.js';
import type { AgentPromptDispatchContext } from '@enkeep/platform-operations';

describe('D4: /sw background isolated task completion notifications (F-31 / GAP-07)', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let messageStore: SqliteWebMessageStore;
  let operationsStorage: SqlitePlatformOperationsStorage;

  const tenantAlice = 'user_alice_sw';
  const taskId = 'task_0123456789abcdef0123456789abcdef';
  const spaceId = 'spc_0123456789abcdef0123456789abcdef';
  const sourceSessionId = 'ses_0123456789abcdef0123456789abcdef';

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    storage = new SqlitePlatformStorage(db);
    messageStore = new SqliteWebMessageStore(db);
    operationsStorage = new SqlitePlatformOperationsStorage(db);

    // Create user
    await storage.users.create({
      id: tenantAlice,
      username: 'alice',
      passwordHash: 'hash_alice',
      role: 'admin',
      status: 'active',
    });

    // Create space
    await storage.forTenant(tenantAlice).spaces.create({
      id: spaceId,
      name: 'Alice Space',
      folder: 'space-alice-sw',
      executionMode: 'container',
    });

    // Create source session route
    await storage.forTenant(tenantAlice).sessionRoutes.create({
      id: sourceSessionId,
      spaceId,
      channel: 'web',
      accountId: 'default',
      nativeContextId: sourceSessionId,
      peerId: `web:${sourceSessionId}`,
      dshSessionId: 'ses_dsh_alice_001',
      executionMode: 'container',
      title: 'Main Chat Session',
    });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  it('delivers <= 2000 char completion notification to source session on isolated turn completion', async () => {
    // Generate a long response text (3000 chars) to verify truncation
    const longReply = 'A'.repeat(3000);

    const mockExecutor: DeliveryTurnExecutor = {
      async execute(req: any) {
        const nowIso = new Date().toISOString();
        const sessionId = req.envelope?.sessionId || req.sessionId;
        // Insert message for ephemeral session before completing
        db.prepare(`
          INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, turn_id, created_at)
          VALUES (?, ?, ?, 'assistant', ?, 'delivered', ?, ?, ?)
        `).run('out_ephemeral_msg_001', sessionId, tenantAlice, longReply, `${tenantAlice}:web:${spaceId}:${sessionId}`, req.turnId, nowIso);

        db.prepare(`
          UPDATE turn_runs
          SET status = 'completed', finished_at = ?
          WHERE turn_id = ?
        `).run(nowIso, req.turnId);

        return { replyText: longReply, usage: { totalTokens: 10 } };
      },
      async cancel() { return true; },
    };

    const gateway = new DeliveryRuntimeGateway({
      storage,
      messageStore,
      database: db,
      executor: mockExecutor,
      quotaMode: 'disabled',
      profileResolver: { resolve: async () => null },
    });

    const dispatcher = createAgentPromptDeliveryDispatcher({
      gateway,
      storage,
      database: db,
      maxWaitMs: 2000,
      pollIntervalMs: 10,
    });

    const taskPayload = {
      type: 'agent_prompt' as const,
      prompt: 'Analyze data in background',
      sessionId: sourceSessionId,
      sessionPolicy: 'isolated' as const,
      contextMode: 'isolated' as const,
    };

    const ctx: AgentPromptDispatchContext = {
      tenantId: tenantAlice,
      task: {
        id: taskId,
        userId: tenantAlice,
        title: '⚡ Analyze benchmark data',
        status: 'running',
        priority: 'medium',
        payload: taskPayload,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      payload: taskPayload,
      signal: new AbortController().signal,
    };

    const result = await dispatcher.dispatch(ctx);
    expect(result.status).toBe('completed');

    // Query messages in sourceSessionId
    const sourceMessages = db.prepare(`
      SELECT * FROM web_messages WHERE session_id = ? AND user_id = ?
    `).all(sourceSessionId, tenantAlice) as any[];

    expect(sourceMessages).toHaveLength(1);
    const notifyMsg = sourceMessages[0];
    expect(notifyMsg.role).toBe('assistant');
    expect(notifyMsg.status).toBe('delivered');

    // Short ID for taskId (task_0123... -> 0123)
    expect(notifyMsg.content).toContain('⚡ 并行任务已完成 [0123] Analyze benchmark data');
    // Notification must be <= 2000 chars
    expect(notifyMsg.content.length).toBeLessThanOrEqual(2000);

    // Verify web_events notification
    const sourceEvents = db.prepare(`
      SELECT * FROM web_events WHERE session_id = ? AND user_id = ?
    `).all(sourceSessionId, tenantAlice) as any[];

    expect(sourceEvents).toHaveLength(1);
    expect(sourceEvents[0].type).toBe('message');
    const eventPayload = JSON.parse(sourceEvents[0].payload);
    expect(eventPayload.message.content).toBe(notifyMsg.content);
  });

  it('delivers <= 2000 char failure notification to source session on isolated turn failure', async () => {
    const mockExecutor: DeliveryTurnExecutor = {
      async execute(req: any) {
        const nowIso = new Date().toISOString();
        db.prepare(`
          UPDATE turn_runs
          SET status = 'failed', error = 'Execution timed out or crashed', finished_at = ?
          WHERE turn_id = ?
        `).run(nowIso, req.turnId);

        return { replyText: 'Error' };
      },
      async cancel() { return true; },
    };

    const gateway = new DeliveryRuntimeGateway({
      storage,
      messageStore,
      database: db,
      executor: mockExecutor,
      quotaMode: 'disabled',
      profileResolver: { resolve: async () => null },
    });

    const dispatcher = createAgentPromptDeliveryDispatcher({
      gateway,
      storage,
      database: db,
      maxWaitMs: 2000,
      pollIntervalMs: 10,
    });

    const taskPayload = {
      type: 'agent_prompt' as const,
      prompt: 'Doomed background task',
      sessionId: sourceSessionId,
      sessionPolicy: 'isolated' as const,
    };

    const ctx: AgentPromptDispatchContext = {
      tenantId: tenantAlice,
      task: {
        id: taskId,
        userId: tenantAlice,
        title: '⚡ Failing task',
        status: 'running',
        priority: 'medium',
        payload: taskPayload,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      payload: taskPayload,
      signal: new AbortController().signal,
    };

    await expect(dispatcher.dispatch(ctx)).rejects.toThrow();

    // Query messages in sourceSessionId
    const sourceMessages = db.prepare(`
      SELECT * FROM web_messages WHERE session_id = ? AND user_id = ?
    `).all(sourceSessionId, tenantAlice) as any[];

    expect(sourceMessages).toHaveLength(1);
    const notifyMsg = sourceMessages[0];
    expect(notifyMsg.content).toContain('⚡ 并行任务失败 [0123] Failing task');
    expect(notifyMsg.content.length).toBeLessThanOrEqual(2000);
  });

  it('skips notification cleanly when source session becomes inactive during execution', async () => {
    const mockExecutor: DeliveryTurnExecutor = {
      async execute(req: any) {
        // Source session archived during background execution
        await storage.forTenant(tenantAlice).sessionRoutes.archive(sourceSessionId);

        const nowIso = new Date().toISOString();
        const sessionId = req.envelope?.sessionId || req.sessionId;
        db.prepare(`
          INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, turn_id, created_at)
          VALUES (?, ?, ?, 'assistant', 'Done', 'delivered', ?, ?, ?)
        `).run('out_ephemeral_msg_002', sessionId, tenantAlice, `${tenantAlice}:web:${spaceId}:${sessionId}`, req.turnId, nowIso);

        db.prepare(`
          UPDATE turn_runs
          SET status = 'completed', finished_at = ?
          WHERE turn_id = ?
        `).run(nowIso, req.turnId);

        return { replyText: 'Done', usage: { totalTokens: 5 } };
      },
      async cancel() { return true; },
    };

    const gateway = new DeliveryRuntimeGateway({
      storage,
      messageStore,
      database: db,
      executor: mockExecutor,
      quotaMode: 'disabled',
      profileResolver: { resolve: async () => null },
    });

    const dispatcher = createAgentPromptDeliveryDispatcher({
      gateway,
      storage,
      database: db,
      maxWaitMs: 2000,
      pollIntervalMs: 10,
    });

    const taskPayload = {
      type: 'agent_prompt' as const,
      prompt: 'Task when source is archived',
      sessionId: sourceSessionId,
      sessionPolicy: 'isolated' as const,
    };

    const ctx: AgentPromptDispatchContext = {
      tenantId: tenantAlice,
      task: {
        id: taskId,
        userId: tenantAlice,
        title: 'Background task with dead source',
        status: 'running',
        priority: 'medium',
        payload: taskPayload,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      payload: taskPayload,
      signal: new AbortController().signal,
    };

    const result = await dispatcher.dispatch(ctx);
    expect(result.status).toBe('completed');

    // Source session should have 0 messages
    const sourceMessages = db.prepare(`
      SELECT * FROM web_messages WHERE session_id = ? AND user_id = ?
    `).all(sourceSessionId, tenantAlice) as any[];
    expect(sourceMessages).toHaveLength(0);
  });
});
