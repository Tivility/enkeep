import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  DeliveryRuntimeGateway,
  SqliteWebMessageStore,
  ChannelRuntimeManager,
  ModelSelectionService,
  SqliteStreamEventSource,
  type DeliveryExecutionRequest,
} from '../src/index.js';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { FakeLarkTransport, type LarkRawEvent } from '@enkeep/channel-lark';
import type { RawDshModelConfig } from '../src/config/dsh-model-config.js';

describe('Lark Inbound Command Continuation Replay Regression', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let messageStore: SqliteWebMessageStore;
  let deliveryGateway: DeliveryRuntimeGateway;
  let transport: FakeLarkTransport;
  let runtimeManager: ChannelRuntimeManager;
  let streamEventSource: SqliteStreamEventSource;
  const executorFn = vi.fn(async (_req: DeliveryExecutionRequest) => {
    return { replyText: 'Runtime reply', usage: { totalTokens: 10 } };
  });

  const userId = 'usr_lark_reg_test';
  const spaceId = 'spc_lark_reg_test';
  const accountId = 'ca_lark_reg_acc';
  const botAppId = 'cli_mock_reg_bot';
  const botOpenId = 'ou_mock_reg_bot';
  const chatId = 'oc_chat_reg_001';

  const createEvent = (eventId: string, msgId: string, text: string): LarkRawEvent => ({
    header: { event_id: eventId, event_type: 'im.message.receive_v1', create_time: `${Date.now()}` },
    event: {
      sender: { sender_id: { open_id: 'ou_sender_reg' }, sender_type: 'user' },
      message: {
        message_id: msgId,
        chat_id: chatId,
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text }),
        create_time: `${Date.now()}`,
      },
    },
  });

  beforeEach(async () => {
    executorFn.mockClear();

    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'tester', 'hash')`).run(userId);
    db.prepare(`INSERT INTO spaces (id, user_id, name, folder, execution_mode, status) VALUES (?, ?, 'Space Reg', 'spc_reg', 'container', 'active')`).run(spaceId, userId);

    storage = new SqlitePlatformStorage(db);
    messageStore = new SqliteWebMessageStore(db);

    const modelSelectionService = new ModelSelectionService({ db });
    const stubCatalog: RawDshModelConfig = {
      providers: {
        openai: {
          id: 'openai',
          api: 'openai',
          configured: true,
          models: [{ id: 'gpt-4o', reasoningEfforts: { low: null, medium: null, high: null } }],
        },
      },
      defaultModel: { provider: 'openai', model: 'gpt-4o', reasoningEffort: 'low' },
    };
    vi.spyOn(modelSelectionService, 'getDshCatalog').mockReturnValue(stubCatalog);

    deliveryGateway = new DeliveryRuntimeGateway({
      storage,
      database: db,
      messageStore,
      quotaMode: 'disabled',
      modelSelectionService,
      profileResolver: { resolve: async () => null },
      executor: { execute: executorFn, cancel: async () => true },
    });

    transport = new FakeLarkTransport();
    transport.botOpenId = botOpenId;

    const tenant = storage.forTenant(userId);
    await tenant.channels.createAccount({
      id: accountId,
      type: 'lark',
      status: 'active',
      appId: botAppId,
      botOpenId,
      defaultSpaceId: spaceId,
    });

    await tenant.channels.createBinding({
      accountId,
      spaceId,
      nativeContextId: chatId,
      activationMode: 'always',
    });

    streamEventSource = new SqliteStreamEventSource(db);

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
    await runtimeManager.stop();
  });

  it('regression: /effort list does not replay historical runtime turns or spawn active continuation watcher at cursor 0', async () => {
    const gateway = runtimeManager.getActiveGateway(userId, accountId)!;
    expect(gateway).toBeDefined();

    // Resolve / pre-create canonical session route
    const tenant = storage.forTenant(userId);
    const route = await tenant.sessionRoutes.getOrCreateCanonicalSession(spaceId, {
      channel: 'lark',
      accountId,
      nativeContextId: chatId,
      peerId: 'ou_sender_reg',
      title: `Lark Direct ${chatId}`,
    });

    const oldTurn1Text = 'Historical assistant reply turn 1';
    const oldTurn2Text = 'Historical assistant reply turn 2';
    const oldTurn3Text = 'Historical assistant reply turn 3';

    // Seed session stream event source with 3 old completed turns (assistant text events with rowIds)
    db.prepare(`
      INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
      VALUES ('evt_seed_1_start', ?, ?, 'turn_status', ?, '2026-09-18T00:00:01Z')
    `).run(route.id, userId, JSON.stringify({ turnId: 'turn_seed_1', status: 'running' }));
    db.prepare(`
      INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
      VALUES ('evt_seed_1_delta', ?, ?, 'assistant_delta', ?, '2026-09-18T00:00:02Z')
    `).run(route.id, userId, JSON.stringify({ turnId: 'turn_seed_1', streamId: 'stm_1', delta: oldTurn1Text }));
    db.prepare(`
      INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
      VALUES ('evt_seed_1_end', ?, ?, 'turn_status', ?, '2026-09-18T00:00:03Z')
    `).run(route.id, userId, JSON.stringify({ turnId: 'turn_seed_1', status: 'completed' }));

    db.prepare(`
      INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
      VALUES ('evt_seed_2_start', ?, ?, 'turn_status', ?, '2026-09-18T00:01:01Z')
    `).run(route.id, userId, JSON.stringify({ turnId: 'turn_seed_2', status: 'running' }));
    db.prepare(`
      INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
      VALUES ('evt_seed_2_delta', ?, ?, 'assistant_delta', ?, '2026-09-18T00:01:02Z')
    `).run(route.id, userId, JSON.stringify({ turnId: 'turn_seed_2', streamId: 'stm_2', delta: oldTurn2Text }));
    db.prepare(`
      INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
      VALUES ('evt_seed_2_end', ?, ?, 'turn_status', ?, '2026-09-18T00:01:03Z')
    `).run(route.id, userId, JSON.stringify({ turnId: 'turn_seed_2', status: 'completed' }));

    db.prepare(`
      INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
      VALUES ('evt_seed_3_start', ?, ?, 'turn_status', ?, '2026-09-18T00:02:01Z')
    `).run(route.id, userId, JSON.stringify({ turnId: 'turn_seed_3', status: 'running' }));
    db.prepare(`
      INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
      VALUES ('evt_seed_3_delta', ?, ?, 'assistant_delta', ?, '2026-09-18T00:02:02Z')
    `).run(route.id, userId, JSON.stringify({ turnId: 'turn_seed_3', streamId: 'stm_3', delta: oldTurn3Text }));
    db.prepare(`
      INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
      VALUES ('evt_seed_3_end', ?, ?, 'turn_status', ?, '2026-09-18T00:02:03Z')
    `).run(route.id, userId, JSON.stringify({ turnId: 'turn_seed_3', status: 'completed' }));

    const latestRowId = await streamEventSource.getLatestRowId(route.id);
    expect(latestRowId).toBeGreaterThanOrEqual(9);

    // Send Lark "/effort list" event
    const cmdEvent = createEvent('evt_cmd_reg_1', 'om_cmd_reg_1', '/effort list');
    const res = await gateway.handleInboundEvent(cmdEvent);
    expect(res.handled).toBe(true);

    await vi.waitFor(() => {
      expect(transport.sentReplies).toHaveLength(1);
    });

    // 1. Assert exactly ONE outbound reply (the command reply)
    expect(transport.sentReplies).toHaveLength(1);
    expect(transport.sentReplies[0].chatId).toBe(chatId);
    expect(transport.sentReplies[0].replyToMessageId).toBe('om_cmd_reg_1');
    expect(transport.sentReplies[0].content.toLowerCase()).toContain('effort');

    // 2. Assert transport.sentReplies does not contain any of the old assistant texts
    for (const reply of transport.sentReplies) {
      expect(reply.content).not.toContain(oldTurn1Text);
      expect(reply.content).not.toContain(oldTurn2Text);
      expect(reply.content).not.toContain(oldTurn3Text);
    }

    // 3. Assert no continuation watcher is active for the route (gateway.getContinuationWatcher(routeId) undefined)
    // or, if present, its cursor >= latest rowId
    const watcher = gateway.getContinuationWatcher(route.id);
    if (watcher) {
      expect(watcher.getCursor()).toBeGreaterThanOrEqual(latestRowId);
    } else {
      expect(watcher).toBeUndefined();
    }

    // Runtime executor was NOT invoked for the command
    expect(executorFn).toHaveBeenCalledTimes(0);
  });
});
