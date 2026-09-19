import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
} from '../src/storage/migrations.js';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { SqliteWebMessageStore } from '../src/storage/web-messages.js';
import {
  DeliveryRuntimeGateway,
  type DeliveryExecutionRequest,
} from '../src/runtime/delivery-gateway.js';
import { ValidationError, NotFoundError } from '@enkeep/platform-core';

describe('Atomic Channel Turn Origin Acceptance (M037)', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let messageStore: SqliteWebMessageStore;
  let gateway: DeliveryRuntimeGateway;
  const userId = 'usr_alice_001';
  const spaceId = 'spc_00000000000000000000000000000001';
  const sessionId = 'ses_00000000000000000000000000000001';
  const accountId = 'acc_lark_000000000000000000000001';

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    storage = new SqlitePlatformStorage({ database: db });
    messageStore = new SqliteWebMessageStore(db);

    // Seed test user, space, session route, channel account
    db.prepare("INSERT INTO users (id, username, password_hash, role, status) VALUES (?, 'alice', 'hash', 'user', 'active')")
      .run(userId);

    db.prepare("INSERT INTO spaces (id, user_id, name, folder, execution_mode, status) VALUES (?, ?, 'Alice Space', '/tmp/alice', 'container', 'active')")
      .run(spaceId, userId);

    db.prepare(`
      INSERT INTO session_routes (
        id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, status
      ) VALUES (?, ?, ?, 'lark', ?, 'oc_chat_1', 'peer_1', 'dsh_ses_1', 'container', 'active')
    `).run(sessionId, spaceId, userId, accountId);

    db.prepare(`
      INSERT INTO channel_accounts (
        id, user_id, type, status, credential_ref
      ) VALUES (?, ?, 'lark', 'active', '{}')
    `).run(accountId, userId);

    const executor = {
      execute: async (req: DeliveryExecutionRequest) => ({
        replyText: `Processed: ${req.content}`,
        usage: { totalTokens: 10 },
      }),
      cancel: async () => true,
    };

    const profileResolver = {
      resolve: async () => ({
        id: 'prof_default',
        version: 1,
        promptMode: 'append' as const,
        promptHash: '0'.repeat(64),
        identity: 'test identity',
        soul: '',
        agents: '',
        tools: '',
      }),
    };

    gateway = new DeliveryRuntimeGateway({
      database: db,
      storage,
      messageStore,
      executor,
      quotaMode: 'disabled',
      profileResolver: profileResolver as any,
    });
  });

  afterEach(async () => {
    await gateway.drain(1000);
    await gateway.close();
  });

  it('atomically persists channel_turn_origins in the same transaction as turn acceptance before execution', async () => {
    const envelopeId = '44444444-5555-4666-8777-888888888801';
    const envelope = {
      id: envelopeId,
      userId,
      sessionId,
      content: 'Test inbound Lark message',
      timestamp: new Date().toISOString(),
      channelContext: {
        channel: 'lark',
        accountId,
        chatId: 'oc_chat_1',
        nativeContextId: 'oc_chat_1',
        nativeEventId: 'evt_lark_test_999',
        replyToMessageId: 'om_lark_msg_888',
        rootId: 'om_lark_root_777',
        threadId: 'om_lark_thread_666',
        originTurnId: null,
      },
    };

    const res = await gateway.dispatchInbound(envelope);
    expect(res.accepted).toBe(true);
    expect(res.turnId).toBeDefined();

    // Verify channel_turn_origins is already present in DB BEFORE execution completes
    const originRow = db.prepare('SELECT * FROM channel_turn_origins WHERE turn_id = ?').get(res.turnId) as any;
    expect(originRow).toBeDefined();
    expect(originRow.turn_id).toBe(res.turnId);
    expect(originRow.user_id).toBe(userId);
    expect(originRow.session_id).toBe(sessionId);
    expect(originRow.account_id).toBe(accountId);
    expect(originRow.channel).toBe('lark');
    expect(originRow.chat_id).toBe('oc_chat_1');
    expect(originRow.native_context_id).toBe('oc_chat_1');
    expect(originRow.native_event_id).toBe('evt_lark_test_999');
    expect(originRow.reply_to_message_id).toBe('om_lark_msg_888');
    expect(originRow.root_id).toBe('om_lark_root_777');
    expect(originRow.thread_id).toBe('om_lark_thread_666');

    // Also query via repository
    const origin = await storage.forTenant(userId).turnOrigins.findByTurnId(res.turnId);
    expect(origin).not.toBeNull();
    expect(origin!.turnId).toBe(res.turnId);
    expect(origin!.nativeEventId).toBe('evt_lark_test_999');
  });

  it('rejects Lark channel inbound missing nativeEventId', async () => {
    const envelopeId = '44444444-5555-4666-8777-888888888802';
    const envelope = {
      id: envelopeId,
      userId,
      sessionId,
      content: 'Invalid Lark message without nativeEventId',
      timestamp: new Date().toISOString(),
      channelContext: {
        channel: 'lark',
        accountId,
        chatId: 'oc_chat_1',
        nativeContextId: 'oc_chat_1',
        nativeEventId: null,
      },
    };

    await expect(gateway.dispatchInbound(envelope as any)).rejects.toThrow(ValidationError);
  });

  it('rejects fake web account in turn origin channelContext', async () => {
    const envelopeId = '44444444-5555-4666-8777-888888888803';
    const envelope = {
      id: envelopeId,
      userId,
      sessionId,
      content: 'Web fake origin message',
      timestamp: new Date().toISOString(),
      channelContext: {
        channel: 'web',
        accountId: 'fake_web_account',
        chatId: 'chat_1',
        nativeContextId: 'chat_1',
      },
    };

    await expect(gateway.dispatchInbound(envelope as any)).rejects.toThrow(ValidationError);
  });

  it('rejects channelContext with non-existent account for tenant', async () => {
    const envelopeId = '44444444-5555-4666-8777-888888888804';
    const envelope = {
      id: envelopeId,
      userId,
      sessionId,
      content: 'Lark message with non-existent account',
      timestamp: new Date().toISOString(),
      channelContext: {
        channel: 'lark',
        accountId: 'acc_does_not_exist',
        chatId: 'oc_chat_1',
        nativeContextId: 'oc_chat_1',
        nativeEventId: 'evt_test_acc',
      },
    };

    await expect(gateway.dispatchInbound(envelope as any)).rejects.toThrow(NotFoundError);
  });
});
