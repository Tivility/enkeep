import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { ALL_PLATFORM_MIGRATIONS, PlatformServerMigrationRunner } from '../src/storage/migrations.js';
import { SqliteWebMessageStore } from '../src/storage/web-messages.js';
import { DeliveryRuntimeGateway, type DeliveryExecutionRequest } from '../src/runtime/delivery-gateway.js';
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

describe('DeliveryRuntimeGateway sender name prefix rewriting', () => {
  it('rewrites executionRequest.content to [发送者: 名字] 原文 for group chat with senderName while web_messages keeps original text', async () => {
    const db = setupDb();
    const messageStore = new SqliteWebMessageStore(db);

    let capturedRequest: DeliveryExecutionRequest | null = null;
    const executor = {
      execute: async (req: DeliveryExecutionRequest) => {
        capturedRequest = req;
        return {
          replyText: 'Echo response',
          usage: { totalTokens: 10 },
        };
      },
      cancel: async () => true,
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
      content: '请问明天的会议几点开始？',
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

    const dispatchResult = await gateway.dispatchInbound(envelope);
    expect(dispatchResult.accepted).toBe(true);

    await gateway.drain(1000);

    // 1. Verify executor received prefixed content and forwarded metadata
    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.content).toBe('[发送者: Alice] 请问明天的会议几点开始？');
    expect(capturedRequest!.senderName).toBe('Alice');
    expect(capturedRequest!.chatType).toBe('group');

    // 2. Verify web_messages keeps original text without prefix
    const messages = await messageStore.listMessages('u_test_1', 'ses_test_1');
    const userMsg = messages.messages.find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toBe('请问明天的会议几点开始？');

    // 3. Verify delivery_inbox stored senderName and chatType
    const inboxRow = db.prepare('SELECT payload FROM delivery_inbox WHERE turn_id = ?').get(dispatchResult.turnId!) as { payload: string };
    expect(inboxRow).toBeDefined();
    const parsedPayload = JSON.parse(inboxRow.payload);
    expect(parsedPayload.senderName).toBe('Alice');
    expect(parsedPayload.chatType).toBe('group');
  });

  it('does NOT rewrite content for p2p chat or when senderName is missing', async () => {
    const db = setupDb();
    const messageStore = new SqliteWebMessageStore(db);

    let capturedRequest: DeliveryExecutionRequest | null = null;
    const executor = {
      execute: async (req: DeliveryExecutionRequest) => {
        capturedRequest = req;
        return {
          replyText: 'Echo response',
          usage: { totalTokens: 10 },
        };
      },
      cancel: async () => true,
    };

    const gateway = new DeliveryRuntimeGateway({
      database: db,
      storage: null as any,
      messageStore,
      executor,
      quotaMode: 'disabled',
      profileResolver: { resolve: async () => null },
    });

    // P2P chat with senderName
    const envelopeP2P: InboundEnvelope = {
      id: 'deliv_test_000000000000000000000002',
      userId: 'u_test_1',
      sessionId: 'ses_test_1',
      content: '私聊测试内容',
      timestamp: new Date().toISOString(),
      channelContext: {
        channel: 'lark',
        accountId: 'acc_lark_1',
        chatId: 'oc_test_chat_002',
        nativeContextId: 'oc_test_chat_002',
        nativeEventId: 'om_test_event_002',
        senderId: 'ou_user_beta',
        senderName: 'Bob',
        chatType: 'p2p',
      },
    };

    await gateway.dispatchInbound(envelopeP2P);
    await gateway.drain(1000);

    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.content).toBe('私聊测试内容');
  });
});
