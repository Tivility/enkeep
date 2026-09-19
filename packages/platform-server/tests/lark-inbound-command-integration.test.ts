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

describe('Lark Inbound Slash Command Integration', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let messageStore: SqliteWebMessageStore;
  let deliveryGateway: DeliveryRuntimeGateway;
  let transport: FakeLarkTransport;
  let runtimeManager: ChannelRuntimeManager;
  let streamEventSource: SqliteStreamEventSource;
  let capturedExecutionRequest: DeliveryExecutionRequest | null = null;
  const executorFn = vi.fn(async (req: DeliveryExecutionRequest) => {
    capturedExecutionRequest = req;
    return { replyText: 'Runtime reply', usage: { totalTokens: 10 } };
  });

  const userId = 'usr_lark_cmd_test';
  const spaceId = 'spc_lark_cmd_test';
  const accountId = 'ca_lark_cmd_acc';
  const botAppId = 'cli_mock_cmd_bot';
  const botOpenId = 'ou_mock_cmd_bot';
  const chatId = 'oc_chat_cmd_001';

  const createEvent = (eventId: string, msgId: string, text: string): LarkRawEvent => ({
    header: { event_id: eventId, event_type: 'im.message.receive_v1', create_time: `${Date.now()}` },
    event: {
      sender: { sender_id: { open_id: 'ou_sender_cmd' }, sender_type: 'user' },
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
    capturedExecutionRequest = null;
    executorFn.mockClear();

    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'tester', 'hash')`).run(userId);
    db.prepare(`INSERT INTO spaces (id, user_id, name, folder, execution_mode, status) VALUES (?, ?, 'Space Cmd', 'spc_cmd', 'container', 'active')`).run(spaceId, userId);

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

  it('handles /effort list command end-to-end, dedups identical event, and carries session override to normal message', async () => {
    const gateway = runtimeManager.getActiveGateway(userId, accountId)!;
    expect(gateway).toBeDefined();

    // 1. Inbound /effort list command
    const cmdEvent = createEvent('evt_cmd_list_1', 'om_cmd_list_1', '/effort list');
    const res1 = await gateway.handleInboundEvent(cmdEvent);
    expect(res1.handled).toBe(true);

    await vi.waitFor(() => {
      expect(transport.sentReplies).toHaveLength(1);
    });

    // Assertion 1: exactly one outbound reply captured, targeting original chat/message, text contains "effort"
    expect(transport.sentReplies).toHaveLength(1);
    expect(transport.sentReplies[0].chatId).toBe(chatId);
    expect(transport.sentReplies[0].replyToMessageId).toBe('om_cmd_list_1');
    expect(transport.sentReplies[0].content.toLowerCase()).toContain('effort');

    // Assertion 2: runtime executor NOT invoked (spy count 0)
    expect(executorFn).toHaveBeenCalledTimes(0);

    // Assertion 3: turn_runs row with execution_mode='command' status='completed' and channel_turn_origins row
    const turnRun = db.prepare('SELECT * FROM turn_runs WHERE turn_id = ?').get(res1.turnId) as any;
    expect(turnRun).toBeDefined();
    expect(turnRun.execution_mode).toBe('command');
    expect(turnRun.status).toBe('completed');

    const turnOrigin = db.prepare('SELECT * FROM channel_turn_origins WHERE turn_id = ?').get(res1.turnId) as any;
    expect(turnOrigin).toBeDefined();
    expect(turnOrigin.account_id).toBe(accountId);
    expect(turnOrigin.channel).toBe('lark');
    expect(turnOrigin.chat_id).toBe(chatId);
    expect(turnOrigin.reply_to_message_id).toBe('om_cmd_list_1');

    // Assertion 4: second identical event with same native message id (dedup path) does not produce second reply
    const resDup = await gateway.handleInboundEvent(cmdEvent);
    expect(resDup.handled).toBe(false);
    expect(transport.sentReplies).toHaveLength(1);
    expect(executorFn).toHaveBeenCalledTimes(0);

    // 2. /effort high then normal message
    const effortHighEvent = createEvent('evt_cmd_set_2', 'om_cmd_set_2', '/effort high');
    const resEffort = await gateway.handleInboundEvent(effortHighEvent);
    expect(resEffort.handled).toBe(true);

    await vi.waitFor(() => {
      expect(transport.sentReplies).toHaveLength(2);
    });
    expect(executorFn).toHaveBeenCalledTimes(0);

    // Send normal text message
    const normalEvent = createEvent('evt_norm_msg_3', 'om_norm_msg_3', 'Hello Lark agent');
    const resNormal = await gateway.handleInboundEvent(normalEvent);
    expect(resNormal.handled).toBe(true);

    await deliveryGateway.drain();

    // Normal message DOES reach runtime executor stub and modelSelection.reasoningEffort === 'high'
    expect(executorFn).toHaveBeenCalledTimes(1);
    expect(capturedExecutionRequest).toBeDefined();
    expect(capturedExecutionRequest!.modelSelection?.reasoningEffort).toBe('high');

    // Normal Lark message still creates a tracker and after completion the watcher cursor equals tracker cursor / latest
    const normRouteId = resNormal.sessionRouteId!;
    const normWatcher = gateway.getContinuationWatcher(normRouteId);
    expect(normWatcher).toBeDefined();
    const latestRowId = await streamEventSource.getLatestRowId(normRouteId);
    expect(normWatcher!.getCursor()).toBe(latestRowId);
  });
});
