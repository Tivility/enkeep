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

  it('7. aligns outboxId with runId and prevents duplicate outbound when outbox already exists', async () => {
    const tenant = storage.forTenant(userId);
    const sessionRoute = await tenant.sessionRoutes.create({
      id: 'ses_dedup_007',
      spaceId,
      channel: 'lark',
      accountId,
      nativeContextId: chatId,
      peerId: chatId,
      dshSessionId: 'dsh_dedup_007',
    });

    const taskId = 'task_dedup_007';
    const runId = 'run_dedup_007';
    const turnId = 'turn_dedup_007';
    const payload = {
      type: 'agent_prompt',
      prompt: 'Check metrics report',
      silent: false,
    };

    db.prepare(`
      INSERT INTO platform_tasks (id, user_id, title, status, payload)
      VALUES (?, ?, 'Metrics Report', 'running', ?)
    `).run(taskId, userId, JSON.stringify(payload));

    db.prepare(`
      INSERT INTO task_runs (id, task_id, user_id, status, turn_id, session_id)
      VALUES (?, ?, ?, 'running', ?, ?)
    `).run(runId, taskId, userId, turnId, sessionRoute.id);

    // First completion call creates outbox item with out_task_${runId}
    await runtimeManager.handleTurnCompleted({
      userId,
      sessionId: sessionRoute.id,
      spaceId,
      turnId,
      deliveryId: 'deliv_task_007',
      idempotencyKey: 'deliv_task_007',
      executionResult: { replyText: 'Metrics summary text.' },
      tokenUsage: { tokens: 20 },
      taskId,
    });

    const outboxRows = db.prepare('SELECT * FROM channel_outbox WHERE account_id = ?').all(accountId) as any[];
    expect(outboxRows.length).toBe(1);
    expect(outboxRows[0].id).toBe(`out_task_${runId}`);
    expect(outboxRows[0].status).toBe('delivered');

    // Second completion call (simulating race or TaskWorker replay) deduplicates via runId outboxId
    await runtimeManager.handleTurnCompleted({
      userId,
      sessionId: sessionRoute.id,
      spaceId,
      turnId,
      deliveryId: 'deliv_task_007_repeat',
      idempotencyKey: 'deliv_task_007_repeat',
      executionResult: { replyText: 'Metrics summary text.' },
      tokenUsage: { tokens: 20 },
      taskId,
    });

    const outboxRowsAfter = db.prepare('SELECT * FROM channel_outbox WHERE account_id = ?').all(accountId) as any[];
    expect(outboxRowsAfter.length).toBe(1);
  });

  describe('Orphan Streaming Cards Reconciliation (HC Delta 13)', () => {
    it('1. Completed turn: rewrites card with final web_messages text and no aborted banner', async () => {
      const turnId = 'turn_test_reconcile_completed';
      const sessionRouteId = 'ses_reconcile_001';

      db.prepare(`
        INSERT INTO session_routes (id, user_id, space_id, channel, native_context_id, dsh_session_id)
        VALUES (?, ?, ?, 'lark', ?, 'dsh_ses_rec_1')
      `).run(sessionRouteId, userId, spaceId, chatId);

      // Create orphan streaming card in db
      db.prepare(`
        INSERT INTO channel_streaming_cards (
          id, user_id, account_id, session_id, turn_id, native_context_id, chat_id,
          card_id, message_id, version, status, snapshot_text, created_at, updated_at
        ) VALUES (
          'strc_rec_001', ?, ?, ?, ?, ?, ?,
          'crd_orphan_1', 'om_orphan_1', 1, 'streaming', 'Partial text before restart...', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `).run(userId, accountId, sessionRouteId, turnId, chatId, chatId);

      // Turn finished and assistant message persisted in web_messages
      db.prepare(`
        INSERT INTO turn_runs (id, turn_id, user_id, route_id, space_id, status)
        VALUES ('run_rec_001', ?, ?, ?, ?, 'completed')
      `).run(turnId, userId, sessionRouteId, spaceId);

      db.prepare(`
        INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, turn_id)
        VALUES ('msg_asst_001', ?, ?, 'assistant', 'This is the complete assistant answer.', 'delivered', 'rt_rec_1', ?)
      `).run(sessionRouteId, userId, turnId);

      const res = await runtimeManager.reconcileOrphanStreamingCardsOnStartup();
      expect(res.reconciled).toBe(1);

      // Verify transport received reconcile call
      const recCall = transport.streamingCalls.find((c) => c.type === 'reconcile');
      expect(recCall).toBeDefined();
      expect(recCall?.status).toBe('completed');
      expect(recCall?.content).toBe('This is the complete assistant answer.');
      expect(recCall?.card.header.template).toBe('violet');
      expect(recCall?.card.body.elements[0].content).not.toContain('⚠️');

      // Verify card marked as completed in DB
      const cardRow = db.prepare('SELECT * FROM channel_streaming_cards WHERE id = ?').get('strc_rec_001') as any;
      expect(cardRow.status).toBe('completed');
      expect(cardRow.completed_at).toBeDefined();

      // Verify delivered outbox item created to prevent re-delivery
      const outboxRows = db.prepare('SELECT * FROM channel_outbox WHERE account_id = ?').all(accountId) as any[];
      expect(outboxRows.some((o) => o.status === 'delivered')).toBe(true);
    });

    it('1b. Completed autonomous continuation turn (no turn_runs, no web_messages): closes as completed with the streamed text', async () => {
      const turnId = 'turn_auto_test_reconcile_0001';
      const sessionRouteId = 'ses_reconcile_auto_001';

      db.prepare(`
        INSERT INTO session_routes (id, user_id, space_id, channel, native_context_id, dsh_session_id)
        VALUES (?, ?, ?, 'lark', ?, 'dsh_ses_rec_auto')
      `).run(sessionRouteId, userId, spaceId, chatId);

      db.prepare(`
        INSERT INTO channel_streaming_cards (
          id, user_id, account_id, session_id, turn_id, native_context_id, chat_id,
          card_id, message_id, version, status, snapshot_text, created_at, updated_at
        ) VALUES (
          'strc_rec_auto', ?, ?, ?, ?, ?, ?,
          'crd_orphan_auto', 'om_orphan_auto', 1, 'streaming', 'Step one', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `).run(userId, accountId, sessionRouteId, turnId, chatId, chatId);

      const insertEvent = db.prepare(`
        INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `);
      insertEvent.run('evt_auto_1', sessionRouteId, userId, 'turn_status', JSON.stringify({ status: 'running', turnId }));
      insertEvent.run('evt_auto_2', sessionRouteId, userId, 'assistant_delta', JSON.stringify({ turnId, streamId: 's1', delta: 'Step one ' }));
      insertEvent.run('evt_auto_3', sessionRouteId, userId, 'assistant_delta', JSON.stringify({ turnId, streamId: 's1', delta: 'done.' }));
      insertEvent.run('evt_auto_4', sessionRouteId, userId, 'assistant_delta', JSON.stringify({ turnId, streamId: 's2', delta: 'Final summary.' }));
      insertEvent.run('evt_auto_5', sessionRouteId, userId, 'turn_status', JSON.stringify({ status: 'completed', turnId }));

      const res = await runtimeManager.reconcileOrphanStreamingCardsOnStartup();
      expect(res.reconciled).toBe(1);

      const recCall = transport.streamingCalls.find((c) => c.type === 'reconcile');
      expect(recCall?.status).toBe('completed');
      expect(recCall?.content).toBe('Step one done.\n\nFinal summary.');
      expect(recCall?.card.header.template).toBe('violet');

      const cardRow = db.prepare('SELECT status FROM channel_streaming_cards WHERE id = ?').get('strc_rec_auto') as any;
      expect(cardRow.status).toBe('completed');
    });

    it('2. Aborted/failed turn: preserves snapshot text without misleading banner, empty text shows interrupted notice', async () => {
      const turnIdWithSnapshot = 'turn_test_reconcile_aborted_snap';
      const sessionRouteId1 = 'ses_reconcile_002';

      db.prepare(`
        INSERT INTO session_routes (id, user_id, space_id, channel, native_context_id, dsh_session_id)
        VALUES (?, ?, ?, 'lark', ?, 'dsh_ses_rec_2')
      `).run(sessionRouteId1, userId, spaceId, chatId);

      // Card with snapshot text
      db.prepare(`
        INSERT INTO channel_streaming_cards (
          id, user_id, account_id, session_id, turn_id, native_context_id, chat_id,
          card_id, message_id, version, status, snapshot_text, created_at, updated_at
        ) VALUES (
          'strc_rec_002', ?, ?, ?, ?, ?, ?,
          'crd_orphan_2', 'om_orphan_2', 1, 'streaming', 'Calculated halfway result...', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `).run(userId, accountId, sessionRouteId1, turnIdWithSnapshot, chatId, chatId);

      db.prepare(`
        INSERT INTO turn_runs (id, turn_id, user_id, route_id, space_id, status)
        VALUES ('run_rec_002', ?, ?, ?, ?, 'interrupted')
      `).run(turnIdWithSnapshot, userId, sessionRouteId1, spaceId);

      // Card with empty snapshot text
      const turnIdEmpty = 'turn_test_reconcile_aborted_empty';
      const sessionRouteId2 = 'ses_reconcile_003';
      const chatId2 = 'oc_crm_chat_002';

      db.prepare(`
        INSERT INTO session_routes (id, user_id, space_id, channel, native_context_id, dsh_session_id)
        VALUES (?, ?, ?, 'lark', ?, 'dsh_ses_rec_3')
      `).run(sessionRouteId2, userId, spaceId, chatId2);

      db.prepare(`
        INSERT INTO channel_streaming_cards (
          id, user_id, account_id, session_id, turn_id, native_context_id, chat_id,
          card_id, message_id, version, status, snapshot_text, created_at, updated_at
        ) VALUES (
          'strc_rec_003', ?, ?, ?, ?, ?, ?,
          'crd_orphan_3', 'om_orphan_3', 1, 'streaming', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `).run(userId, accountId, sessionRouteId2, turnIdEmpty, chatId2, chatId2);

      db.prepare(`
        INSERT INTO turn_runs (id, turn_id, user_id, route_id, space_id, status)
        VALUES ('run_rec_003', ?, ?, ?, ?, 'interrupted')
      `).run(turnIdEmpty, userId, sessionRouteId2, spaceId);

      const res = await runtimeManager.reconcileOrphanStreamingCardsOnStartup();
      expect(res.reconciled).toBe(2);

      const calls = transport.streamingCalls.filter((c) => c.type === 'reconcile');
      const snapCall = calls.find((c) => c.cardId === 'crd_orphan_2');
      const emptyCall = calls.find((c) => c.cardId === 'crd_orphan_3');

      // Card with content retains content and does NOT append misleading banner
      expect(snapCall).toBeDefined();
      expect(snapCall?.status).toBe('aborted');
      expect(snapCall?.content).toBe('Calculated halfway result...');
      expect(snapCall?.content).not.toContain('⚠️');

      // Card without content has interrupted banner
      expect(emptyCall).toBeDefined();
      expect(emptyCall?.status).toBe('aborted');
      expect(emptyCall?.content).toContain('⚠️ 上次服务中断，本次任务未完成');

      // Both marked aborted in DB
      const row2 = db.prepare('SELECT status FROM channel_streaming_cards WHERE id = ?').get('strc_rec_002') as any;
      const row3 = db.prepare('SELECT status FROM channel_streaming_cards WHERE id = ?').get('strc_rec_003') as any;
      expect(row2.status).toBe('aborted');
      expect(row3.status).toBe('aborted');
    });

    it('3. Queued turn for redrive: marks old card as being re-executed and closes streaming', async () => {
      const turnId = 'turn_test_reconcile_queued';
      const sessionRouteId = 'ses_reconcile_004';

      db.prepare(`
        INSERT INTO session_routes (id, user_id, space_id, channel, native_context_id, dsh_session_id)
        VALUES (?, ?, ?, 'lark', ?, 'dsh_ses_rec_4')
      `).run(sessionRouteId, userId, spaceId, chatId);

      db.prepare(`
        INSERT INTO channel_streaming_cards (
          id, user_id, account_id, session_id, turn_id, native_context_id, chat_id,
          card_id, message_id, version, status, snapshot_text, created_at, updated_at
        ) VALUES (
          'strc_rec_004', ?, ?, ?, ?, ?, ?,
          'crd_orphan_4', 'om_orphan_4', 1, 'streaming', 'Partial text before restart', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `).run(userId, accountId, sessionRouteId, turnId, chatId, chatId);

      db.prepare(`
        INSERT INTO turn_runs (id, turn_id, user_id, route_id, space_id, status)
        VALUES ('run_rec_004', ?, ?, ?, ?, 'queued')
      `).run(turnId, userId, sessionRouteId, spaceId);

      const res = await runtimeManager.reconcileOrphanStreamingCardsOnStartup();
      expect(res.reconciled).toBe(1);

      const recCall = transport.streamingCalls.find((c) => c.cardId === 'crd_orphan_4' && c.type === 'reconcile');
      expect(recCall).toBeDefined();
      expect(recCall?.status).toBe('aborted');
      expect(recCall?.content).toContain('⚠️ 服务重启，任务正在重新执行');

      const cardRow = db.prepare('SELECT status FROM channel_streaming_cards WHERE id = ?').get('strc_rec_004') as any;
      expect(cardRow.status).toBe('aborted');
    });
  });
});
