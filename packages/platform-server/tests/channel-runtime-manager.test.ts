import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  DeliveryRuntimeGateway,
  SqliteWebMessageStore,
  ChannelRuntimeManager,
  SqliteStreamEventSource,
} from '../src/index.js';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { FakeLarkTransport, type LarkRawEvent } from '@enkeep/channel-lark';

describe('ChannelRuntimeManager - Proactive Scheduled Deliveries & Web Isolation', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let messageStore: SqliteWebMessageStore;
  let deliveryGateway: DeliveryRuntimeGateway;
  let transport: FakeLarkTransport;
  let runtimeManager: ChannelRuntimeManager;

  const userId = 'usr_crm_test_001';
  const spaceId = 'spc_crm_test_001';
  const accountId = 'ca_crm_lark_acc';
  const chatId = 'oc_crm_chat_001';

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'tester', 'hash')`).run(userId);
    db.prepare(`INSERT INTO spaces (id, user_id, name, folder, execution_mode, status) VALUES (?, ?, 'CRM Space', 'crm-space', 'container', 'active')`).run(spaceId, userId);

    storage = new SqlitePlatformStorage(db);
    messageStore = new SqliteWebMessageStore(db);

    deliveryGateway = new DeliveryRuntimeGateway({
      storage,
      database: db,
      messageStore,
      quotaMode: 'disabled',
      profileResolver: { resolve: async () => null },
      executor: {
        execute: async () => ({ replyText: 'Executed successfully', usage: { totalTokens: 10 } }),
        cancel: async () => true,
      },
    });

    transport = new FakeLarkTransport();

    const tenant = storage.forTenant(userId);
    await tenant.channels.createAccount({
      id: accountId,
      type: 'lark',
      status: 'active',
      appId: 'cli_crm_mock_app',
    });

    await tenant.channels.createBinding({
      accountId,
      spaceId,
      nativeContextId: chatId,
      activationMode: 'always',
    });

    runtimeManager = new ChannelRuntimeManager({
      storage,
      db,
      deliveryGateway,
      transportFactory: () => transport,
      streamEventSource: new SqliteStreamEventSource(db),
      autoStart: false,
    });

    await runtimeManager.start();
  });

  afterEach(async () => {
    if (runtimeManager) {
      await runtimeManager.stop();
    }
  });

  it('1. delivers proactive scheduled delivery with payload.delivery (no inbound nativeEventId)', async () => {
    const tenant = storage.forTenant(userId);
    const sessionRoute = await tenant.sessionRoutes.create({
      id: 'ses_sched_deliv_001',
      spaceId,
      channel: 'web',
      accountId: 'default',
      nativeContextId: 'ses_sched_deliv_001',
      peerId: 'web:ses_sched_deliv_001',
      dshSessionId: 'dsh_sched_001',
    });

    const taskId = 'task_sched_proactive_001';
    const turnId = 'turn_sched_proactive_001';
    const payload = {
      type: 'agent_prompt',
      prompt: 'Execute daily cognitive check',
      silent: false,
      delivery: {
        channel: 'lark',
        accountId,
        nativeContextId: chatId,
      },
    };

    db.prepare(`
      INSERT INTO platform_tasks (id, user_id, title, status, payload)
      VALUES (?, ?, 'Daily Check', 'running', ?)
    `).run(taskId, userId, JSON.stringify(payload));

    db.prepare(`
      INSERT INTO task_runs (id, task_id, user_id, status, turn_id, session_id)
      VALUES ('run_001', ?, ?, 'running', ?, ?)
    `).run(taskId, userId, turnId, sessionRoute.id);

    // Trigger turn completion notification with NO nativeEventId
    await runtimeManager.handleTurnCompleted({
      userId,
      sessionId: sessionRoute.id,
      spaceId,
      turnId,
      deliveryId: 'deliv_task_001',
      idempotencyKey: 'deliv_task_001',
      executionResult: { replyText: 'Daily cognitive check summary: all systems nominal.' },
      tokenUsage: { tokens: 42 },
    });

    // Verify outbox record created and delivered
    const outboxRows = db.prepare('SELECT * FROM channel_outbox WHERE account_id = ?').all(accountId) as any[];
    expect(outboxRows.length).toBe(1);
    expect(outboxRows[0].status).toBe('delivered');
    expect(outboxRows[0].native_context_id).toBe(chatId);
    expect(outboxRows[0].reply_to_native_id).toBeNull();

    const parsedOutboxPayload = JSON.parse(outboxRows[0].payload_json);
    expect(parsedOutboxPayload.text).toBe('Daily cognitive check summary: all systems nominal.');
  });

  it('2. delivers task-originated outbound via route fallback when payload.delivery is missing', async () => {
    const tenant = storage.forTenant(userId);
    const sessionRoute = await tenant.sessionRoutes.create({
      id: 'ses_route_lark_002',
      spaceId,
      channel: 'lark',
      accountId,
      nativeContextId: chatId,
      peerId: chatId,
      dshSessionId: 'dsh_route_002',
    });

    const taskId = 'task_route_fallback_002';
    const turnId = 'turn_route_fallback_002';
    const payload = {
      type: 'agent_prompt',
      prompt: 'Execute weekly reflection prompt',
      silent: false,
      // No delivery block in payload
    };

    db.prepare(`
      INSERT INTO platform_tasks (id, user_id, title, status, payload)
      VALUES (?, ?, 'Weekly Reflection', 'running', ?)
    `).run(taskId, userId, JSON.stringify(payload));

    db.prepare(`
      INSERT INTO task_runs (id, task_id, user_id, status, turn_id, session_id)
      VALUES ('run_002', ?, ?, 'running', ?, ?)
    `).run(taskId, userId, turnId, sessionRoute.id);

    await runtimeManager.handleTurnCompleted({
      userId,
      sessionId: sessionRoute.id,
      spaceId,
      turnId,
      deliveryId: 'deliv_task_002',
      idempotencyKey: 'deliv_task_002',
      executionResult: { replyText: 'Weekly reflection insights generated.' },
      tokenUsage: { tokens: 50 },
      taskId,
    });

    const outboxRows = db.prepare('SELECT * FROM channel_outbox WHERE account_id = ?').all(accountId) as any[];
    expect(outboxRows.length).toBe(1);
    expect(outboxRows[0].status).toBe('delivered');
    expect(outboxRows[0].native_context_id).toBe(chatId);
  });

  it('3. filters out manual Web turns in Lark-bound sessions (keeps web-origin sessions non-forwarding)', async () => {
    const tenant = storage.forTenant(userId);
    const sessionRoute = await tenant.sessionRoutes.create({
      id: 'ses_web_manual_003',
      spaceId,
      channel: 'lark',
      accountId,
      nativeContextId: chatId,
      peerId: chatId,
      dshSessionId: 'dsh_manual_003',
    });

    const turnId = 'turn_web_manual_003';

    // Manual Web turn: NO nativeEventId, NO task_runs entry, NO taskId
    await runtimeManager.handleTurnCompleted({
      userId,
      sessionId: sessionRoute.id,
      spaceId,
      turnId,
      deliveryId: 'del_web_manual_turn_123',
      idempotencyKey: 'del_web_manual_turn_123',
      executionResult: { replyText: 'Manual web test reply' },
      tokenUsage: { tokens: 15 },
    });

    // Zero outbox items created (strictly non-forwarding)
    const outboxRows = db.prepare('SELECT * FROM channel_outbox WHERE account_id = ?').all(accountId) as any[];
    expect(outboxRows.length).toBe(0);
  });

  it('4. suppresses outbound delivery for silent scheduled tasks (payload.silent === true)', async () => {
    const tenant = storage.forTenant(userId);
    const sessionRoute = await tenant.sessionRoutes.create({
      id: 'ses_silent_004',
      spaceId,
      channel: 'lark',
      accountId,
      nativeContextId: chatId,
      peerId: chatId,
      dshSessionId: 'dsh_silent_004',
    });

    const taskId = 'task_silent_004';
    const turnId = 'turn_silent_004';
    const payload = {
      type: 'agent_prompt',
      prompt: 'Daily extraction',
      silent: true,
      delivery: {
        channel: 'lark',
        accountId,
        nativeContextId: chatId,
      },
    };

    db.prepare(`
      INSERT INTO platform_tasks (id, user_id, title, status, payload)
      VALUES (?, ?, 'Daily Extraction', 'running', ?)
    `).run(taskId, userId, JSON.stringify(payload));

    db.prepare(`
      INSERT INTO task_runs (id, task_id, user_id, status, turn_id, session_id)
      VALUES ('run_004', ?, ?, 'running', ?, ?)
    `).run(taskId, userId, turnId, sessionRoute.id);

    await runtimeManager.handleTurnCompleted({
      userId,
      sessionId: sessionRoute.id,
      spaceId,
      turnId,
      deliveryId: 'deliv_task_004',
      idempotencyKey: 'deliv_task_004',
      executionResult: { replyText: 'Extracted 15 items silently.' },
      tokenUsage: { tokens: 30 },
      taskId,
    });

    const outboxRows = db.prepare('SELECT * FROM channel_outbox WHERE account_id = ?').all(accountId) as any[];
    expect(outboxRows.length).toBe(0);
  });

  it('5. deduplicates duplicate handleTurnCompleted calls for scheduled delivery', async () => {
    const tenant = storage.forTenant(userId);
    const sessionRoute = await tenant.sessionRoutes.create({
      id: 'ses_dedup_005',
      spaceId,
      channel: 'lark',
      accountId,
      nativeContextId: chatId,
      peerId: chatId,
      dshSessionId: 'dsh_dedup_005',
    });

    const taskId = 'task_dedup_005';
    const turnId = 'turn_dedup_005';
    const payload = {
      type: 'agent_prompt',
      prompt: 'Biweekly review',
      silent: false,
    };

    db.prepare(`
      INSERT INTO platform_tasks (id, user_id, title, status, payload)
      VALUES (?, ?, 'Biweekly Review', 'running', ?)
    `).run(taskId, userId, JSON.stringify(payload));

    db.prepare(`
      INSERT INTO task_runs (id, task_id, user_id, status, turn_id, session_id)
      VALUES ('run_005', ?, ?, 'running', ?, ?)
    `).run(taskId, userId, turnId, sessionRoute.id);

    const event = {
      userId,
      sessionId: sessionRoute.id,
      spaceId,
      turnId,
      deliveryId: 'deliv_task_005',
      idempotencyKey: 'deliv_task_005',
      executionResult: { replyText: 'Biweekly review summary text.' },
      tokenUsage: { tokens: 35 },
      taskId,
    };

    // Concurrent double-call
    await Promise.all([
      runtimeManager.handleTurnCompleted(event),
      runtimeManager.handleTurnCompleted(event),
    ]);

    const outboxRows = db.prepare('SELECT * FROM channel_outbox WHERE account_id = ?').all(accountId) as any[];
    expect(outboxRows.length).toBe(1);
  });

  it('6. exposes sendProactiveMessage method directly on ChannelRuntimeManager', async () => {
    const res = await runtimeManager.sendProactiveMessage({
      userId,
      accountId,
      chatId,
      text: 'Direct proactive message via manager',
      title: 'Direct Notification',
    });

    expect(res.success).toBe(true);
    const outboxRows = db.prepare('SELECT * FROM channel_outbox WHERE account_id = ?').all(accountId) as any[];
    expect(outboxRows.length).toBe(1);
    expect(outboxRows[0].status).toBe('delivered');
  });
});
