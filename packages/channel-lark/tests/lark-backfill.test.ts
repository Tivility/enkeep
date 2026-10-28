import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SqliteTenantScopedChannelRepository } from '@enkeep/platform-storage-sqlite';
import {
  FakeLarkTransport,
  LarkChannelGateway,
  normalizeRestMessageToParsed,
  parseDbTimestampMs,
  isLarkChatId,
  type LarkRestMessageItem,
} from '../src/index.js';

describe('Lark Offline Backfill', () => {
  const userId = 'usr_synth_backfill_01';
  const spaceId = 'spc_synth_backfill_01';
  const accountId = 'ca_synth_backfill_01';
  const botOpenId = 'ou_bot_synth_01';
  const botAppId = 'cli_synth_bot_01';

  let db: DatabaseSync;
  let channelRepo: SqliteTenantScopedChannelRepository;
  let transport: FakeLarkTransport;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT, password_hash TEXT);
      CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, status TEXT);
      CREATE TABLE IF NOT EXISTS channel_accounts (
        id TEXT PRIMARY KEY, user_id TEXT, type TEXT, default_space_id TEXT, status TEXT, credential_ref TEXT, brand TEXT, app_id TEXT, bot_open_id TEXT, config_json TEXT, created_at TEXT, updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS channel_bindings (
        id TEXT PRIMARY KEY, user_id TEXT, account_id TEXT, space_id TEXT, native_context_id TEXT, activation_mode TEXT, busy_mode TEXT DEFAULT 'queue', chat_type TEXT, session_route_id TEXT, created_at TEXT, updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS session_routes (
        id TEXT PRIMARY KEY, user_id TEXT, space_id TEXT, channel TEXT, account_id TEXT, native_context_id TEXT, peer_id TEXT, dsh_session_id TEXT, execution_mode TEXT, current_generation INTEGER DEFAULT 1, title TEXT, status TEXT DEFAULT 'active', created_at TEXT, updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS channel_inbox (
        id TEXT PRIMARY KEY, user_id TEXT, account_id TEXT, native_event_id TEXT, native_context_id TEXT, payload_json TEXT, status TEXT DEFAULT 'held', created_at TEXT DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT DEFAULT (CURRENT_TIMESTAMP),
        UNIQUE(account_id, native_event_id)
      );
      CREATE TABLE IF NOT EXISTS channel_outbox (
        id TEXT PRIMARY KEY, user_id TEXT, account_id TEXT, session_id TEXT, native_context_id TEXT, reply_to_native_id TEXT, payload_json TEXT, status TEXT DEFAULT 'pending', attempts INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT
      );
    `);

    db.prepare('INSERT INTO users VALUES (?, ?, ?)').run(userId, 'synth_user', 'hash');
    db.prepare('INSERT INTO spaces VALUES (?, ?, ?, ?)').run(spaceId, userId, 'Default Space', 'active');
    db.prepare('INSERT INTO channel_accounts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)').run(
      accountId,
      userId,
      'lark',
      spaceId,
      'active',
      'ref_1',
      'feishu',
      botAppId,
      botOpenId,
      '{}'
    );

    channelRepo = new SqliteTenantScopedChannelRepository(db, userId);
    transport = new FakeLarkTransport();
  });

  // Test 1: REST message normalization and mention gating
  it('1. normalizes OpenAPI REST message and correctly extracts content, mentions, and sender', () => {
    const rawRestItem: LarkRestMessageItem = {
      message_id: 'om_synth_rest_001',
      chat_id: 'oc_synth_group_001',
      msg_type: 'text',
      create_time: '1700000000000',
      sender: {
        id: 'ou_synth_sender_01',
        id_type: 'open_id',
        sender_type: 'user',
      },
      body: {
        content: JSON.stringify({ text: '@_user_1 hello' }),
      },
      mentions: [
        {
          key: '@_user_1',
          id: botOpenId,
          id_type: 'open_id',
          name: 'BotName',
        },
      ],
    };

    const parsed = normalizeRestMessageToParsed(rawRestItem, { chatType: 'group' });
    expect(parsed).not.toBeNull();
    expect(parsed!.messageId).toBe('om_synth_rest_001');
    expect(parsed!.chatId).toBe('oc_synth_group_001');
    expect(parsed!.senderId).toBe('ou_synth_sender_01');
    expect(parsed!.text).toBe('@BotName hello');
    expect(parsed!.mentions?.length).toBe(1);
    expect(parsed!.mentions![0].openId).toBe(botOpenId);

    // Bot's own messages return null (by sender_type: app or by botOpenId)
    const botMsg: LarkRestMessageItem = {
      ...rawRestItem,
      message_id: 'om_synth_bot_001',
      sender: { id: botOpenId, id_type: 'open_id', sender_type: 'app' },
    };
    expect(normalizeRestMessageToParsed(botMsg, { chatType: 'group', botOpenId })).toBeNull();

    const botUserMsg: LarkRestMessageItem = {
      ...rawRestItem,
      message_id: 'om_synth_bot_user_001',
      sender: { id: botOpenId, id_type: 'open_id', sender_type: 'user' },
    };
    expect(normalizeRestMessageToParsed(botUserMsg, { chatType: 'group', botOpenId })).toBeNull();

    // System notices (member joins, group changes) never replay as user turns
    const systemMsg: LarkRestMessageItem = {
      ...rawRestItem,
      message_id: 'om_synth_system_001',
      msg_type: 'system',
      sender: { id: '', id_type: '', sender_type: '' },
    };
    expect(normalizeRestMessageToParsed(systemMsg, { chatType: 'group' })).toBeNull();
  });

  // Test 2: Realtime WS event vs Backfill deduplication alignment
  it('2. aligns deduplication between realtime WS event and backfill message via messageId', async () => {
    const chatId = 'oc_synth_chat_idemp';
    await channelRepo.createBinding({
      accountId,
      spaceId,
      nativeContextId: chatId,
      activationMode: 'always',
    });

    const dispatchedEnvelopes: any[] = [];
    const mockRuntimeGateway: any = {
      dispatchInbound: vi.fn(async (env) => {
        dispatchedEnvelopes.push(env);
        return { turnId: `trn_${env.id}`, status: 'dispatched' };
      }),
    };

    const sessionRouteRepo: any = {
      findByRouteIdentity: vi.fn(async () => null),
      findById: vi.fn(async () => null),
      create: vi.fn(async (data) => ({ id: `rt_${Date.now()}`, ...data })),
    };

    const gateway = new LarkChannelGateway({
      account: { id: accountId, userId, appId: botAppId, botOpenId },
      transport,
      channelRepo,
      sessionRouteRepo,
      runtimeGateway: mockRuntimeGateway,
    });

    // Step A: Ingest via WS realtime event
    const realtimeMsgId = 'om_synth_msg_align_001';
    await gateway.handleInboundEvent({
      header: {
        event_id: 'evt_synth_ws_001',
        event_type: 'im.message.receive_v1',
        create_time: '1700000000000',
      },
      event: {
        sender: { sender_id: { open_id: 'ou_synth_sender_01' }, sender_type: 'user' },
        message: {
          message_id: realtimeMsgId,
          chat_id: chatId,
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: 'Ping from WS' }),
          create_time: '1700000000000',
        },
      },
    });

    expect(dispatchedEnvelopes.length).toBe(1);

    // Step B: Backfill returns the same message_id
    transport.mockChatMessages = [
      {
        message_id: realtimeMsgId,
        chat_id: chatId,
        msg_type: 'text',
        create_time: String(Date.now() - 60000),
        sender: { id: 'ou_synth_sender_01', id_type: 'open_id', sender_type: 'user' },
        body: { content: JSON.stringify({ text: 'Ping from WS' }) },
      },
    ];

    // Trigger backfill
    await gateway.startBackfill('reconnected', 1);

    // Verification: Not dispatched again, channel_inbox has only 1 row
    expect(dispatchedEnvelopes.length).toBe(1);
    const inboxRows = db.prepare('SELECT * FROM channel_inbox WHERE account_id = ?').all(accountId);
    expect(inboxRows.length).toBe(1);
  });

  // Test 3: Connection generation guard cancels obsolete backfill
  it('3. cancels backfill execution when connection generation flips', async () => {
    const chatId = 'oc_synth_chat_generation';
    await channelRepo.createBinding({
      accountId,
      spaceId,
      nativeContextId: chatId,
      activationMode: 'always',
    });

    let listChatMessagesCallCount = 0;
    transport.listChatMessagesHandler = async (params) => {
      listChatMessagesCallCount++;
      // Simulate reconnect/flip to new generation in the middle
      transport.simulateReconnect();
      return {
        items: [
          {
            message_id: `om_synth_gen_${listChatMessagesCallCount}`,
            chat_id: chatId,
            msg_type: 'text',
            create_time: String(Date.now() - 30000),
            sender: { id: 'ou_synth_sender_01', id_type: 'open_id', sender_type: 'user' },
            body: { content: JSON.stringify({ text: 'Gen test' }) },
          },
        ],
        hasMore: true,
        pageToken: 'page_2',
      };
    };

    const mockRuntimeGateway: any = {
      dispatchInbound: vi.fn(async (env) => ({ turnId: `trn_${env.id}`, status: 'dispatched' })),
    };

    const sessionRouteRepo: any = {
      findByRouteIdentity: vi.fn(async () => null),
      findById: vi.fn(async () => null),
      create: vi.fn(async (data) => ({ id: `rt_${Date.now()}`, ...data })),
    };

    const gateway = new LarkChannelGateway({
      account: { id: accountId, userId, appId: botAppId, botOpenId },
      transport,
      channelRepo,
      sessionRouteRepo,
      runtimeGateway: mockRuntimeGateway,
    });

    // Trigger reconnect to initialize generation = 1 in gateway
    transport.simulateReconnect();

    // Start backfill with generation 1
    await gateway.startBackfill('reconnected', 1);

    // Generation was flipped during first page, so it should abort and not fetch page 2
    expect(listChatMessagesCallCount).toBe(1);
  });

  it('4. queries only Lark chat ids, with a start time read as UTC from SQLite and not after the end time', async () => {
    const chatId = 'oc_synth_chat_utc';
    for (const nativeContextId of [chatId, 'web:home-synth-01', 'wechat:synth-peer-01']) {
      await channelRepo.createBinding({ accountId, spaceId, nativeContextId, activationMode: 'always' });
    }
    // Last inbox row 10 minutes ago, in SQLite CURRENT_TIMESTAMP form (UTC, no zone suffix)
    const lastInboxMs = Date.now() - 10 * 60 * 1000;
    const sqliteUtc = new Date(lastInboxMs).toISOString().slice(0, 19).replace('T', ' ');
    db.prepare(
      'INSERT INTO channel_inbox (id, user_id, account_id, native_event_id, native_context_id, payload_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('inb_synth_utc_01', userId, accountId, 'evt_synth_utc_01', chatId, '{}', 'delivered', sqliteUtc);

    const calls: Array<{ containerId: string; startTimeSec: number; endTimeSec: number }> = [];
    transport.listChatMessagesHandler = async (params: any) => {
      calls.push({ containerId: params.containerId, startTimeSec: params.startTimeSec, endTimeSec: params.endTimeSec });
      return { items: [], hasMore: false };
    };
    const gateway = new LarkChannelGateway({
      account: { id: accountId, userId, appId: botAppId, botOpenId },
      transport,
      channelRepo,
      sessionRouteRepo: { findByRouteIdentity: vi.fn(async () => null), findById: vi.fn(async () => null), create: vi.fn() } as any,
      runtimeGateway: { dispatchInbound: vi.fn() } as any,
    });
    transport.simulateReconnect();
    await gateway.startBackfill('cold-start', 1);

    expect(calls.map((c) => c.containerId)).toEqual([chatId]);
    expect(calls[0].startTimeSec).toBeLessThanOrEqual(calls[0].endTimeSec);
    // since = last inbox - 5 min buffer
    expect(Math.abs(calls[0].startTimeSec - Math.floor((lastInboxMs - 5 * 60 * 1000) / 1000))).toBeLessThanOrEqual(1);
  });

  it('5. parses SQLite timestamps as UTC and recognises Lark chat ids', () => {
    expect(parseDbTimestampMs('2026-01-02 03:04:05')).toBe(Date.parse('2026-01-02T03:04:05Z'));
    expect(parseDbTimestampMs('2026-01-02T03:04:05.123Z')).toBe(Date.parse('2026-01-02T03:04:05.123Z'));
    expect(isLarkChatId('oc_0123abcd')).toBe(true);
    expect(isLarkChatId('feishu')).toBe(false);
    expect(isLarkChatId('web')).toBe(false);
  });
});
