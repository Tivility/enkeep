import { describe, it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { ALL_PLATFORM_MIGRATIONS, PlatformServerMigrationRunner } from '../src/storage/migrations.js';
import { SqliteWebMessageStore } from '../src/storage/web-messages.js';
import { DeliveryRuntimeGateway, type DeliveryExecutionRequest } from '../src/runtime/delivery-gateway.js';
import { ChatCommandService, HELP_USAGE, parseChatCommand } from '../src/chat/chat-command-service.js';
import type { InboundEnvelope } from '@enkeep/web-channel';

function setupDb() {
  const db = new DatabaseSync(':memory:');
  const runner = new PlatformServerMigrationRunner(db);
  for (const mig of ALL_PLATFORM_MIGRATIONS) {
    db.exec(mig.upSql);
  }

  // Seed user, space, channel_account, session_route
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES ('u_test_1', 'user_test', 'hash', 'user')").run();
  db.prepare("INSERT INTO spaces (id, user_id, name, folder, status, execution_mode) VALUES ('spc_test_1', 'u_test_1', 'Space A', 'space-a', 'active', 'container')").run();
  db.prepare("INSERT INTO channel_accounts (id, user_id, type, status) VALUES ('acc_lark_1', 'u_test_1', 'lark', 'active')").run();
  db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, dsh_session_id, status) VALUES ('ses_test_1', 'u_test_1', 'spc_test_1', 'lark', 'dsh_ses_1', 'active')").run();

  return db;
}

describe('06-A4 /busy default steer mode', () => {
  it('1. /busy command viewing and setting persists busy_mode on channel_bindings and HELP includes description', async () => {
    const db = setupDb();
    const chatCommandService = new ChatCommandService({
      modelSelectionService: {} as any,
      db,
    });

    expect(HELP_USAGE).toContain('/busy [steer|queue]');

    const parsed = parseChatCommand('/busy steer');
    expect(parsed?.command).toBe('busy');
    expect(parsed?.subcommand).toBe('set');
    expect(parsed?.target).toBe('steer');

    const channelContext = {
      channel: 'lark',
      accountId: 'acc_lark_1',
      chatId: 'oc_test_chat_001',
      nativeContextId: 'oc_test_chat_001',
      senderId: 'ou_user_alpha',
      chatType: 'group',
    };

    // Initial show -> defaults to queue
    const showRes1 = await chatCommandService.execute({
      userId: 'u_test_1',
      sessionId: 'ses_test_1',
      spaceId: 'spc_test_1',
      content: '/busy',
      channelContext,
    });
    expect(showRes1.replyText).toBe('当前设置: 默认排队 (queue)');

    // Provide checkChatAdmin to authorize admin setting
    (chatCommandService as any).setCheckChatAdmin(async () => true);

    // Set to steer
    const setSteerRes = await chatCommandService.execute({
      userId: 'u_test_1',
      sessionId: 'ses_test_1',
      spaceId: 'spc_test_1',
      content: '/busy steer',
      channelContext,
    });
    expect(setSteerRes.replyText).toContain('已开启默认插队模式');

    // Verify DB
    const row = db.prepare('SELECT busy_mode FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?')
      .get('u_test_1', 'acc_lark_1', 'oc_test_chat_001') as { busy_mode: string };
    expect(row.busy_mode).toBe('steer');

    // Show after setting
    const showRes2 = await chatCommandService.execute({
      userId: 'u_test_1',
      sessionId: 'ses_test_1',
      spaceId: 'spc_test_1',
      content: '/busy',
      channelContext,
    });
    expect(showRes2.replyText).toBe('当前设置: 默认插队 (steer)');

    // Set back to queue
    const setQueueRes = await chatCommandService.execute({
      userId: 'u_test_1',
      sessionId: 'ses_test_1',
      spaceId: 'spc_test_1',
      content: '/busy queue',
      channelContext,
    });
    expect(setQueueRes.replyText).toContain('已开启默认排队模式');

    const rowQueue = db.prepare('SELECT busy_mode FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?')
      .get('u_test_1', 'acc_lark_1', 'oc_test_chat_001') as { busy_mode: string };
    expect(rowQueue.busy_mode).toBe('queue');
  });

  it('2. dispatchInbound with busy_mode=steer injects running turn with senderName prefix in group chat without creating new turn', async () => {
    const db = setupDb();
    const messageStore = new SqliteWebMessageStore(db);

    // Set busy_mode = 'steer'
    db.prepare(`
      INSERT INTO channel_bindings (id, user_id, account_id, space_id, native_context_id, activation_mode, busy_mode)
      VALUES ('cb_test_01', 'u_test_1', 'acc_lark_1', 'spc_test_1', 'oc_test_chat_001', 'mention', 'steer')
    `).run();

    // Create a running turn
    db.prepare(`
      INSERT INTO turn_runs (id, turn_id, space_id, route_id, user_id, execution_mode, status, created_at, updated_at)
      VALUES ('run_r1', 'turn_r1', 'spc_test_1', 'ses_test_1', 'u_test_1', 'container', 'running', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run();

    const steerMock = vi.fn().mockResolvedValue({ ok: true });
    const executor = {
      execute: vi.fn(),
      cancel: vi.fn().mockResolvedValue(true),
      steerTurn: steerMock,
    };

    const gateway = new DeliveryRuntimeGateway({
      database: db,
      storage: null as any,
      messageStore,
      executor,
      quotaMode: 'disabled',
      profileResolver: { resolve: async () => null },
    });

    const envelope: InboundEnvelope = {
      id: 'deliv_test_000000000000000000000001',
      userId: 'u_test_1',
      sessionId: 'ses_test_1',
      content: '请问最新的进度如何？',
      timestamp: new Date().toISOString(),
      channelContext: {
        channel: 'lark',
        accountId: 'acc_lark_1',
        chatId: 'oc_test_chat_001',
        nativeContextId: 'oc_test_chat_001',
        nativeEventId: 'om_test_event_001',
        senderId: 'ou_user_alpha',
        senderName: 'Alice',
        chatType: 'group',
      },
    };

    const result = await gateway.dispatchInbound(envelope);
    expect(result.accepted).toBe(true);
    expect(result.executionMode).toBe('runtime');
    expect(result.turnId).toBe('turn_r1'); // Did not create a new turn, attached to running turn_r1

    // Verify steerTurn was called with [发送者: Alice] prefix
    expect(steerMock).toHaveBeenCalledTimes(1);
    expect(steerMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u_test_1',
      expectedTurnId: 'turn_r1',
      message: '[发送者: Alice] 请问最新的进度如何？',
    }));

    // Verify executor.execute was NOT called
    expect(executor.execute).not.toHaveBeenCalled();

    // Verify web_messages recorded the steer message
    const msgs = await messageStore.listMessages('u_test_1', 'ses_test_1');
    const userMsg = msgs.messages.find((m) => m.content === '[发送者: Alice] 请问最新的进度如何？');
    expect(userMsg).toBeDefined();
    expect(userMsg?.id).toBe(result.message.id);
  });

  it('3. dispatchInbound falls back to normal queueing when steerTurn fails or when busy_mode=queue', async () => {
    const db = setupDb();
    const messageStore = new SqliteWebMessageStore(db);

    // Initial binding with busy_mode = 'queue'
    db.prepare(`
      INSERT INTO channel_bindings (id, user_id, account_id, space_id, native_context_id, activation_mode, busy_mode)
      VALUES ('cb_test_02', 'u_test_1', 'acc_lark_1', 'spc_test_1', 'oc_test_chat_002', 'mention', 'queue')
    `).run();

    // Running turn exists
    db.prepare(`
      INSERT INTO turn_runs (id, turn_id, space_id, route_id, user_id, execution_mode, status, created_at, updated_at)
      VALUES ('run_r2', 'turn_r2', 'spc_test_1', 'ses_test_1', 'u_test_1', 'container', 'running', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run();

    const steerMock = vi.fn().mockResolvedValue({ ok: true });
    let executedRequest: DeliveryExecutionRequest | null = null;
    const executor = {
      execute: async (req: DeliveryExecutionRequest) => {
        executedRequest = req;
        return { replyText: 'Done', usage: { totalTokens: 5 } };
      },
      cancel: vi.fn().mockResolvedValue(true),
      steerTurn: steerMock,
    };

    const gateway = new DeliveryRuntimeGateway({
      database: db,
      storage: null as any,
      messageStore,
      executor,
      quotaMode: 'disabled',
      profileResolver: { resolve: async () => null },
    });

    const envelopeQueue: InboundEnvelope = {
      id: 'deliv_test_000000000000000000000002',
      userId: 'u_test_1',
      sessionId: 'ses_test_1',
      content: '排队消息内容',
      timestamp: new Date().toISOString(),
      channelContext: {
        channel: 'lark',
        accountId: 'acc_lark_1',
        chatId: 'oc_test_chat_002',
        nativeContextId: 'oc_test_chat_002',
        nativeEventId: 'om_test_event_002',
        senderId: 'ou_user_beta',
        senderName: 'Bob',
        chatType: 'group',
      },
    };

    // When busy_mode = 'queue', it should enqueue normally (executionMode: 'runtime', creates new turn)
    const resultQueue = await gateway.dispatchInbound(envelopeQueue);
    expect(resultQueue.accepted).toBe(true);
    expect(resultQueue.executionMode).toBe('runtime');
    expect(resultQueue.turnId).not.toBe('turn_r2');
    expect(steerMock).not.toHaveBeenCalled();

    // Now update busy_mode to 'steer' but have steerTurn reject
    db.prepare("UPDATE channel_bindings SET busy_mode = 'steer' WHERE id = 'cb_test_02'").run();
    steerMock.mockResolvedValueOnce({ ok: false, error: { code: 'TURN_NOT_RUNNING' } });

    const envelopeSteerFail: InboundEnvelope = {
      id: 'deliv_test_000000000000000000000003',
      userId: 'u_test_1',
      sessionId: 'ses_test_1',
      content: '插队失败回退排队内容',
      timestamp: new Date().toISOString(),
      channelContext: {
        channel: 'lark',
        accountId: 'acc_lark_1',
        chatId: 'oc_test_chat_002',
        nativeContextId: 'oc_test_chat_002',
        nativeEventId: 'om_test_event_003',
        senderId: 'ou_user_beta',
        senderName: 'Bob',
        chatType: 'group',
      },
    };

    const resultFallback = await gateway.dispatchInbound(envelopeSteerFail);
    expect(resultFallback.accepted).toBe(true);
    expect(resultFallback.executionMode).toBe('runtime'); // Fell back to normal queueing!
    expect(resultFallback.turnId).not.toBe('turn_r2');
  });
});
