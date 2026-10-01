import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { PlatformServerMigrationRunner, ALL_PLATFORM_MIGRATIONS } from '../src/storage/migrations.js';
import { DeliveryRuntimeGateway } from '../src/runtime/delivery-gateway.js';
import { SqliteWebMessageStore } from '../src/storage/web-messages.js';
import { ChannelRuntimeManager } from '../src/channels/channel-runtime-manager.js';
import { FakeLarkTransport, ContinuationWatcher } from '@enkeep/channel-lark';
import { SqliteStreamEventSource } from '../src/channels/sqlite-stream-event-source.js';

describe('Item D: Task Continuation Origin & Watcher Registration', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let deliveryGateway: DeliveryRuntimeGateway;
  let messageStore: SqliteWebMessageStore;
  let runtimeManager: ChannelRuntimeManager;
  let transport: FakeLarkTransport;
  let streamEventSource: SqliteStreamEventSource;

  const userId = 'usr_synth_task_001';
  const spaceId = 'spc_synth_task_001';
  const accountId = 'ca_synth_lark_001';
  const chatId = 'oc_synth_chat_001';

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'synth_tester', 'hash')`).run(userId);
    db.prepare(`INSERT INTO spaces (id, user_id, name, folder, execution_mode, status) VALUES (?, ?, 'Synth Space', 'synth-space', 'container', 'active')`).run(spaceId, userId);

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
    streamEventSource = new SqliteStreamEventSource(db);

    const tenant = storage.forTenant(userId);
    await tenant.channels.createAccount({
      id: accountId,
      type: 'lark',
      status: 'active',
      appId: 'cli_synth_mock_app',
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
      streamEventSource,
      autoStart: false,
    });

    await runtimeManager.start();
  });

  afterEach(async () => {
    if (runtimeManager) {
      await runtimeManager.stop();
    }
  });

  it('writes channel_turn_origins and starts continuation watcher after proactive scheduled delivery succeeds', async () => {
    const tenant = storage.forTenant(userId);
    const sessionRoute = await tenant.sessionRoutes.create({
      id: 'ses_synth_task_route_001',
      spaceId,
      channel: 'web',
      accountId: 'default',
      nativeContextId: 'ses_synth_task_route_001',
      peerId: 'web:ses_synth_task_route_001',
      dshSessionId: 'dsh_synth_task_001',
    });

    const taskId = 'task_synth_sched_001';
    const turnId = 'turn_synth_task_001';
    const payload = {
      type: 'agent_prompt',
      prompt: 'Execute scheduled analysis',
      silent: false,
      delivery: {
        channel: 'lark',
        accountId,
        nativeContextId: chatId,
      },
    };

    db.prepare(`
      INSERT INTO platform_tasks (id, user_id, title, status, payload)
      VALUES (?, ?, 'Scheduled Analysis', 'running', ?)
    `).run(taskId, userId, JSON.stringify(payload));

    db.prepare(`
      INSERT INTO task_runs (id, task_id, user_id, status, turn_id, session_id)
      VALUES ('run_synth_001', ?, ?, 'running', ?, ?)
    `).run(taskId, userId, turnId, sessionRoute.id);

    await runtimeManager.handleTurnCompleted({
      userId,
      sessionId: sessionRoute.id,
      spaceId,
      turnId,
      deliveryId: 'deliv_synth_001',
      idempotencyKey: 'deliv_synth_001',
      executionResult: { replyText: 'Scheduled analysis complete: 3 items flagged.' },
      tokenUsage: { tokens: 100 },
      taskId,
      scheduled: true,
    });

    // 1. Verify channel_outbox has proactive message delivered
    const outboxRows = db.prepare('SELECT * FROM channel_outbox WHERE account_id = ?').all(accountId) as any[];
    expect(outboxRows.length).toBe(1);
    expect(outboxRows[0].status).toBe('delivered');

    // 2. Verify channel_turn_origins was populated with matching inbound shape
    const originRow = db.prepare('SELECT * FROM channel_turn_origins WHERE turn_id = ?').get(turnId) as any;
    expect(originRow).toBeDefined();
    expect(originRow.turn_id).toBe(turnId);
    expect(originRow.user_id).toBe(userId);
    expect(originRow.session_id).toBe(sessionRoute.id);
    expect(originRow.account_id).toBe(accountId);
    expect(originRow.channel).toBe('lark');
    expect(originRow.chat_id).toBe(chatId);
    expect(originRow.native_context_id).toBe(chatId);
    expect(originRow.origin_turn_id).toBeNull();

    // 3. Verify resolveTurnOrigin can resolve this turn for future continuation events
    const resolvedOrigin = await streamEventSource.resolveTurnOrigin(turnId);
    expect(resolvedOrigin).toBeDefined();
    expect(resolvedOrigin?.chatId).toBe(chatId);
    expect(resolvedOrigin?.accountId).toBe(accountId);

    // 4. Verify continuation watcher is registered and active on proactiveGateway
    const gateway = runtimeManager.getActiveGateway(userId, accountId);
    expect(gateway).toBeDefined();
    const watcher = gateway?.getContinuationWatcher(sessionRoute.id);
    expect(watcher).toBeDefined();
    expect(watcher instanceof ContinuationWatcher).toBe(true);
  });

  it('does NOT write channel_turn_origins or start continuation watcher for silent tasks', async () => {
    const tenant = storage.forTenant(userId);
    const sessionRoute = await tenant.sessionRoutes.create({
      id: 'ses_synth_silent_route_002',
      spaceId,
      channel: 'web',
      accountId: 'default',
      nativeContextId: 'ses_synth_silent_route_002',
      peerId: 'web:ses_synth_silent_route_002',
      dshSessionId: 'dsh_synth_silent_002',
    });

    const taskId = 'task_synth_silent_002';
    const turnId = 'turn_synth_silent_002';
    const payload = {
      type: 'agent_prompt',
      prompt: 'Execute silent housekeeping',
      silent: true,
      delivery: {
        channel: 'lark',
        accountId,
        nativeContextId: chatId,
      },
    };

    db.prepare(`
      INSERT INTO platform_tasks (id, user_id, title, status, payload)
      VALUES (?, ?, 'Silent Housekeeping', 'running', ?)
    `).run(taskId, userId, JSON.stringify(payload));

    db.prepare(`
      INSERT INTO task_runs (id, task_id, user_id, status, turn_id, session_id)
      VALUES ('run_synth_002', ?, ?, 'running', ?, ?)
    `).run(taskId, userId, turnId, sessionRoute.id);

    await runtimeManager.handleTurnCompleted({
      userId,
      sessionId: sessionRoute.id,
      spaceId,
      turnId,
      deliveryId: 'deliv_synth_002',
      idempotencyKey: 'deliv_synth_002',
      executionResult: { replyText: 'Silent results.' },
      tokenUsage: { tokens: 10 },
      taskId,
      scheduled: true,
    });

    // Verify channel_turn_origins was NOT populated
    const originRow = db.prepare('SELECT * FROM channel_turn_origins WHERE turn_id = ?').get(turnId) as any;
    expect(originRow).toBeUndefined();

    // Verify no watcher was created
    const gateway = runtimeManager.getActiveGateway(userId, accountId);
    const watcher = gateway?.getContinuationWatcher(sessionRoute.id);
    expect(watcher).toBeUndefined();
  });

  it('does NOT write channel_turn_origins or start continuation watcher for tasks without channel target', async () => {
    const unboundSpaceId = 'spc_synth_unbound_003';
    db.prepare(`INSERT INTO spaces (id, user_id, name, folder, execution_mode, status) VALUES (?, ?, 'Unbound Space', 'unbound-space', 'container', 'active')`).run(unboundSpaceId, userId);

    const tenant = storage.forTenant(userId);
    const sessionRoute = await tenant.sessionRoutes.create({
      id: 'ses_synth_no_channel_003',
      spaceId: unboundSpaceId,
      channel: 'web',
      accountId: 'default',
      nativeContextId: 'ses_synth_no_channel_003',
      peerId: 'web:ses_synth_no_channel_003',
      dshSessionId: 'dsh_synth_no_channel_003',
    });

    const taskId = 'task_synth_no_channel_003';
    const turnId = 'turn_synth_no_channel_003';
    const payload = {
      type: 'agent_prompt',
      prompt: 'Web only task',
      silent: false,
      // No delivery block
    };

    db.prepare(`
      INSERT INTO platform_tasks (id, user_id, title, status, payload)
      VALUES (?, ?, 'Web Only Task', 'running', ?)
    `).run(taskId, userId, JSON.stringify(payload));

    db.prepare(`
      INSERT INTO task_runs (id, task_id, user_id, status, turn_id, session_id)
      VALUES ('run_synth_003', ?, ?, 'running', ?, ?)
    `).run(taskId, userId, turnId, sessionRoute.id);

    await runtimeManager.handleTurnCompleted({
      userId,
      sessionId: sessionRoute.id,
      spaceId: unboundSpaceId,
      turnId,
      deliveryId: 'deliv_synth_003',
      idempotencyKey: 'deliv_synth_003',
      executionResult: { replyText: 'Web only response.' },
      tokenUsage: { tokens: 10 },
      taskId,
      scheduled: true,
    });

    const originRow = db.prepare('SELECT * FROM channel_turn_origins WHERE turn_id = ?').get(turnId) as any;
    expect(originRow).toBeUndefined();

    const gateway = runtimeManager.getActiveGateway(userId, accountId);
    const watcher = gateway?.getContinuationWatcher(sessionRoute.id);
    expect(watcher).toBeUndefined();
  });
});
