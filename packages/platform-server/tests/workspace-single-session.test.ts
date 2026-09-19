import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
} from '../src/storage/migrations.js';
import { SqliteWebMessageStore } from '../src/storage/web-messages.js';
import {
  SqlitePlatformStorage,
  SqliteTenantScopedChannelRepository,
  SqliteTenantScopedSessionRouteRepository,
  SqliteTenantScopedSpaceRepository,
} from '@enkeep/platform-storage-sqlite';
import { SqlitePlatformApi } from '../src/storage/sqlite-platform-api.js';
import { DeliveryRuntimeGateway } from '../src/runtime/delivery-gateway.js';
import { LarkChannelGateway, FakeLarkTransport } from '@enkeep/channel-lark';
import type { LarkRawEvent, LarkSendReplyResult } from '@enkeep/channel-lark';
import type { DeliveryTurnExecutor } from '../src/runtime/delivery-gateway.js';
import { PlatformError, ValidationError } from '@enkeep/platform-core';

describe('Workspace Single-Session Production Convergence: Web + Lark + SQLite Gateway', () => {
  let db: DatabaseSync;
  let store: SqliteWebMessageStore;
  let storage: SqlitePlatformStorage;
  let platformApi: SqlitePlatformApi;
  let runtimeGateway: DeliveryRuntimeGateway;
  let channelRepo: SqliteTenantScopedChannelRepository;
  let sessionRouteRepo: SqliteTenantScopedSessionRouteRepository;
  let spaceRepo: SqliteTenantScopedSpaceRepository;
  let transport: FakeLarkTransport;
  let gateway: LarkChannelGateway;

  let tempDir: string;
  let dbPath: string;

  const testUser = 'usr_prod_conv_001';
  const spaceA = 'spc_alpha_conv_001';
  const spaceB = 'spc_beta_conv_002'; // host execution mode space
  const accountId = 'acc_lark_test_001';
  const botAppId = 'cli_mock_bot_app_id';
  const botOpenId = 'ou_mock_bot_open_id';

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'enkeep-prod-staging-'));
    dbPath = join(tempDir, 'platform.db');

    db = new DatabaseSync(dbPath);
    const runner = new PlatformServerMigrationRunner(db);
    // Applies full current migration suite including M036 and M037
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    store = new SqliteWebMessageStore(db);
    storage = new SqlitePlatformStorage(db);
    platformApi = new SqlitePlatformApi({ storage, messageStore: store, db });

    channelRepo = new SqliteTenantScopedChannelRepository(db, testUser);
    sessionRouteRepo = new SqliteTenantScopedSessionRouteRepository(db, testUser);
    spaceRepo = new SqliteTenantScopedSpaceRepository(db, testUser);

    // Seed test tenant, spaceA (container), spaceB (host)
    db.exec(`
      INSERT INTO users (id, username, password_hash)
      VALUES ('${testUser}', 'convuser', 'hash_test_123');

      INSERT INTO spaces (id, user_id, name, folder, execution_mode, status)
      VALUES ('${spaceA}', '${testUser}', 'Space Alpha', 'alpha-folder', 'container', 'active'),
             ('${spaceB}', '${testUser}', 'Space Beta', 'beta-host-folder', 'host', 'active');

      INSERT INTO channel_accounts (id, user_id, type, status, credential_ref)
      VALUES ('${accountId}', '${testUser}', 'lark', 'active', 'cred_test_ref');
    `);

    // Deterministic delivery executor
    const deterministicExecutor: DeliveryTurnExecutor = {
      execute: async (req) => ({
        replyText: `Reply to: ${req.content}`,
        usage: { totalTokens: 30 },
      }),
      cancel: async () => true,
    };

    runtimeGateway = new DeliveryRuntimeGateway({
      database: db,
      storage,
      messageStore: store,
      executor: deterministicExecutor,
      quotaMode: 'disabled',
      profileResolver: { resolve: async () => null },
    });

    transport = new FakeLarkTransport();
    await transport.start();

    gateway = new LarkChannelGateway({
      account: {
        id: accountId,
        userId: testUser,
        type: 'lark',
        status: 'active',
        appId: botAppId,
        botOpenId,
      } as any,
      channelRepo,
      sessionRouteRepo,
      spaceRepo,
      runtimeGateway,
      transport,
      userId: testUser,
    });
  });

  afterEach(() => {
    try {
      gateway.dispose();
    } catch {}
    try {
      db.close();
    } catch {}
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('1. real Lark gateway inbound event + Web API on same workspace resolve to the EXACT SAME canonical session', async () => {
    const chatId = 'oc_group_chat_alpha';

    // 1a. Bind chat to spaceA
    await channelRepo.createBinding({
      accountId,
      spaceId: spaceA,
      nativeContextId: chatId,
      activationMode: 'always',
    });

    // 1b. Dispatch genuine inbound Lark event through real LarkChannelGateway
    const rawEvent: LarkRawEvent = {
      schema: '2.0',
      header: {
        event_id: 'evt_lark_001',
        event_type: 'im.message.receive_v1',
        create_time: `${Date.now()}`,
        token: 'tok_test',
        app_id: botAppId,
      },
      event: {
        sender: {
          sender_id: { open_id: 'ou_user_alpha', user_id: 'usr_alpha' },
          sender_type: 'user',
        },
        message: {
          message_id: 'om_lark_msg_001',
          chat_id: chatId,
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: 'Hello Enkeep from Lark group' }),
          create_time: `${Date.now()}`,
        },
      },
    };

    const handleResult = await gateway.handleInboundEvent(rawEvent);
    expect(handleResult.handled).toBe(true);
    expect(handleResult.sessionRouteId).toBeDefined();

    const larkSessionId = handleResult.sessionRouteId!;

    // 1c. Verify spaceA canonical_session_id in SQLite matches the Lark session
    const spaceARow = db.prepare('SELECT canonical_session_id FROM spaces WHERE id = ?').get(spaceA) as { canonical_session_id: string };
    expect(spaceARow.canonical_session_id).toBe(larkSessionId);

    // 1d. Now Web client calls createSession for the same spaceA
    const webSession = await platformApi.createSession(testUser, { spaceId: spaceA });
    // MUST resolve to the exact same canonical session id (no duplicate route spawned)
    expect(webSession.id).toBe(larkSessionId);

    // 1e. Second Lark message in same or different group bound to spaceA resolves to the exact same canonical route
    const secondRawEvent: LarkRawEvent = {
      ...rawEvent,
      header: { ...rawEvent.header, event_id: 'evt_lark_002' },
      event: {
        ...rawEvent.event,
        message: { ...rawEvent.event.message, message_id: 'om_lark_msg_002', content: JSON.stringify({ text: 'Second Lark turn' }) },
      },
    };

    const secondResult = await gateway.handleInboundEvent(secondRawEvent);
    expect(secondResult.handled).toBe(true);
    expect(secondResult.sessionRouteId).toBe(larkSessionId);

    // 1f. Verify exactly 1 session route exists in database for spaceA
    const spaceARoutes = db.prepare('SELECT id, status FROM session_routes WHERE space_id = ? AND user_id = ?').all(spaceA, testUser);
    expect(spaceARoutes.length).toBe(1);
    expect((spaceARoutes[0] as any).id).toBe(larkSessionId);
  });

  it('2. two distinct workspaces maintain strict isolation across Web + Lark entrypoints', async () => {
    const chatAlpha = 'oc_chat_alpha';
    const chatBeta = 'oc_chat_beta';

    // Bind chatAlpha -> spaceA, chatBeta -> spaceB
    await channelRepo.createBinding({
      accountId,
      spaceId: spaceA,
      nativeContextId: chatAlpha,
      activationMode: 'always',
    });
    await channelRepo.createBinding({
      accountId,
      spaceId: spaceB,
      nativeContextId: chatBeta,
      activationMode: 'always',
    });

    // Inbound on Space A
    const resA = await gateway.handleInboundEvent({
      schema: '2.0',
      header: { event_id: 'evt_a_1', event_type: 'im.message.receive_v1', create_time: `${Date.now()}` },
      event: {
        sender: { sender_id: { open_id: 'ou_1' } },
        message: { message_id: 'om_a_1', chat_id: chatAlpha, chat_type: 'group', message_type: 'text', content: JSON.stringify({ text: 'Alpha msg' }), create_time: `${Date.now()}` },
      },
    });

    // Inbound on Space B
    const resB = await gateway.handleInboundEvent({
      schema: '2.0',
      header: { event_id: 'evt_b_1', event_type: 'im.message.receive_v1', create_time: `${Date.now()}` },
      event: {
        sender: { sender_id: { open_id: 'ou_2' } },
        message: { message_id: 'om_b_1', chat_id: chatBeta, chat_type: 'group', message_type: 'text', content: JSON.stringify({ text: 'Beta msg' }), create_time: `${Date.now()}` },
      },
    });

    expect(resA.handled).toBe(true);
    expect(resB.handled).toBe(true);
    expect(resA.sessionRouteId).not.toBe(resB.sessionRouteId);

    // Web queries for Space A and Space B return mutually exclusive canonical sessions
    const webA = await platformApi.createSession(testUser, { spaceId: spaceA });
    const webB = await platformApi.createSession(testUser, { spaceId: spaceB });

    expect(webA.id).toBe(resA.sessionRouteId);
    expect(webB.id).toBe(resB.sessionRouteId);
    expect(webA.id).not.toBe(webB.id);

    // Verify spaces table pointers
    const rowA = db.prepare('SELECT canonical_session_id FROM spaces WHERE id = ?').get(spaceA) as any;
    const rowB = db.prepare('SELECT canonical_session_id FROM spaces WHERE id = ?').get(spaceB) as any;
    expect(rowA.canonical_session_id).toBe(resA.sessionRouteId);
    expect(rowB.canonical_session_id).toBe(resB.sessionRouteId);
  });

  it('3. Lark gateway and Web entrypoints authoritatively derive host execution mode on host space', async () => {
    const chatBeta = 'oc_chat_beta_host';

    // spaceB has execution_mode = 'host'
    await channelRepo.createBinding({
      accountId,
      spaceId: spaceB,
      nativeContextId: chatBeta,
      activationMode: 'always',
    });

    // Handle inbound event on host space
    const res = await gateway.handleInboundEvent({
      schema: '2.0',
      header: { event_id: 'evt_host_1', event_type: 'im.message.receive_v1', create_time: `${Date.now()}` },
      event: {
        sender: { sender_id: { open_id: 'ou_host_user' } },
        message: { message_id: 'om_host_1', chat_id: chatBeta, chat_type: 'group', message_type: 'text', content: JSON.stringify({ text: 'Run host command' }), create_time: `${Date.now()}` },
      },
    });

    expect(res.handled).toBe(true);
    const hostSessionId = res.sessionRouteId!;

    // Verify session_routes execution_mode is strictly 'host'
    const routeRow = db.prepare('SELECT execution_mode FROM session_routes WHERE id = ?').get(hostSessionId) as { execution_mode: string };
    expect(routeRow.execution_mode).toBe('host');

    // Verify turn_runs execution_mode is strictly 'host'
    const turnRow = db.prepare('SELECT execution_mode FROM turn_runs WHERE route_id = ?').get(hostSessionId) as { execution_mode: string };
    expect(turnRow.execution_mode).toBe('host');

    // Verify Web POST /api/sessions without executionMode also preserves host mode
    const webHostSession = await platformApi.createSession(testUser, { spaceId: spaceB });
    expect(webHostSession.id).toBe(hostSessionId);
  });

  it('4. immutable TurnOrigin is persisted in channel_turn_origins with actual reply targets', async () => {
    const chatId = 'oc_chat_origin_test';
    const messageId = 'om_origin_source_001';

    await channelRepo.createBinding({
      accountId,
      spaceId: spaceA,
      nativeContextId: chatId,
      activationMode: 'always',
    });

    const res = await gateway.handleInboundEvent({
      schema: '2.0',
      header: { event_id: 'evt_origin_001', event_type: 'im.message.receive_v1', create_time: `${Date.now()}` },
      event: {
        sender: { sender_id: { open_id: 'ou_origin_sender' } },
        message: {
          message_id: messageId,
          chat_id: chatId,
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: 'Check origin metadata' }),
          create_time: `${Date.now()}`,
          root_id: 'om_root_999',
          thread_id: 'om_thread_888',
        },
      },
    });

    expect(res.handled).toBe(true);

    // Verify channel_turn_origins table contains exact origin metadata
    const originRow = db.prepare(`
      SELECT * FROM channel_turn_origins WHERE session_id = ?
    `).get(res.sessionRouteId!) as any;

    expect(originRow).toBeDefined();
    expect(originRow.channel).toBe('lark');
    expect(originRow.account_id).toBe(accountId);
    expect(originRow.chat_id).toBe(chatId);
    expect(originRow.reply_to_message_id).toBe(messageId);
    expect(originRow.root_id).toBe('om_root_999');
    expect(originRow.thread_id).toBe('om_thread_888');
  });

  it('5. GET /api/sessions remains strictly read-only and does not hide unmerged active sessions', async () => {
    // Seed 2 active sessions in spaceA manually (representing pre-merge state)
    const s1 = 'ses_unmerged_1';
    const s2 = 'ses_unmerged_2';

    db.exec(`
      INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id, dsh_session_id, execution_mode, status, created_at)
      VALUES ('${s1}', '${spaceA}', '${testUser}', 'web', 'default', '${s1}', 'dsh_1', 'container', 'active', '2026-05-01 10:00:00'),
             ('${s2}', '${spaceA}', '${testUser}', 'lark', '${accountId}', 'ctx2', 'dsh_2', 'container', 'active', '2026-05-01 11:00:00');
    `);

    // GET /api/sessions without includeArchived
    const activeList = await platformApi.listSessions(testUser, { spaceId: spaceA });
    // Prior to explicit merge, both active sessions are truthfully visible (not concealed)
    expect(activeList.length).toBe(2);
    expect(activeList.map((s) => s.id)).toContain(s1);
    expect(activeList.map((s) => s.id)).toContain(s2);

    // Querying listSessions did NOT mutate canonical_session_id or archive anything
    const spaceRow = db.prepare('SELECT canonical_session_id FROM spaces WHERE id = ?').get(spaceA) as any;
    expect(spaceRow.canonical_session_id).toBeNull();
  });

  it('6. proactive dispatch via Lark gateway resolves space canonical session', async () => {
    // Ensure spaceA has a canonical session created via Web
    const webSession = await platformApi.createSession(testUser, { spaceId: spaceA });

    // Proactive dispatch without explicit sessionId targeting spaceA default
    gateway.defaultSpaceId = spaceA;
    const proactiveResult = await gateway.sendProactiveMessage({
      chatId: 'oc_proactive_chat_1',
      text: 'Proactive notification',
      title: 'Task Result',
    });

    expect(proactiveResult.success).toBe(true);

    // Verify outbox item was stored under the canonical sessionId
    const outboxRow = db.prepare('SELECT session_id, native_context_id, status FROM channel_outbox WHERE account_id = ?').get(accountId) as any;
    expect(outboxRow.session_id).toBe(webSession.id);
    expect(outboxRow.native_context_id).toBe('oc_proactive_chat_1');
    expect(outboxRow.status).toBe('delivered');
  });

  it('7. stale route access does not resurrect route or spawn duplicate active session', async () => {
    // Seed canonical route and archived route
    const canonId = 'ses_canon_prod_1';
    const staleId = 'ses_stale_prod_2';

    db.exec(`
      INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id, dsh_session_id, execution_mode, status, created_at)
      VALUES ('${canonId}', '${spaceA}', '${testUser}', 'web', 'default', '${canonId}', 'dsh_c', 'container', 'active', '2026-05-01 10:00:00'),
             ('${staleId}', '${spaceA}', '${testUser}', 'web', 'default', '${staleId}', 'dsh_s', 'container', 'archived', '2026-05-01 09:00:00');

      UPDATE spaces SET canonical_session_id = '${canonId}' WHERE id = '${spaceA}';
    `);

    // Fetching stale route
    const stale = await platformApi.getSession(testUser, staleId);
    expect(stale?.status).toBe('archived');

    // Listing active routes only returns canonical
    const active = await platformApi.listSessions(testUser, { spaceId: spaceA });
    expect(active.length).toBe(1);
    expect(active[0].id).toBe(canonId);

    // Resolving canonical session via createSession returns canonId
    const resolved = await platformApi.createSession(testUser, { spaceId: spaceA });
    expect(resolved.id).toBe(canonId);
  });

  it('8. missing M036 fails closed on canonical session operations without PRAGMA scan fallback', async () => {
    const rawDb = new DatabaseSync(':memory:');
    rawDb.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, password_hash TEXT);
      CREATE TABLE spaces (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, folder TEXT, execution_mode TEXT, status TEXT);
      CREATE TABLE session_routes (id TEXT PRIMARY KEY, space_id TEXT, user_id TEXT, channel TEXT, account_id TEXT, native_context_id TEXT, peer_id TEXT, dsh_session_id TEXT, execution_mode TEXT, status TEXT);
      CREATE TABLE session_generations (id TEXT PRIMARY KEY, user_id TEXT, route_id TEXT, generation_number INTEGER, dsh_session_id TEXT, agent_profile_snapshot_id TEXT, reset_reason TEXT, created_at TEXT);

      INSERT INTO users VALUES ('u1', 'test', 'pass');
      INSERT INTO spaces VALUES ('sp1', 'u1', 'Space 1', 'f1', 'container', 'active');
    `);

    const rawStorage = new SqlitePlatformStorage(rawDb);
    const tenantRoutes = rawStorage.forTenant('u1').sessionRoutes;

    await expect(tenantRoutes.getOrCreateCanonicalSession('sp1')).rejects.toThrow(
      /Migration 036 required: table spaces is missing canonical_session_id/
    );
  });

  it('9. authoritative space.canonicalSessionId is exposed in PublicSpace API', async () => {
    const session = await platformApi.createSession(testUser, { spaceId: spaceA });

    const spaceRecord = await platformApi.getSpace(testUser, spaceA);
    expect(spaceRecord?.canonicalSessionId).toBe(session.id);

    const spaceList = await platformApi.listSpaces(testUser);
    const item = spaceList.find((s) => s.id === spaceA);
    expect(item?.canonicalSessionId).toBe(session.id);
  });

  it('10. POST /api/sessions correctly derives host execution mode when omitted', async () => {
    const session = await platformApi.createSession(testUser, { spaceId: spaceB });
    expect(session.id).toBeDefined();

    const routeRow = db.prepare('SELECT execution_mode FROM session_routes WHERE id = ?').get(session.id) as { execution_mode: string };
    expect(routeRow.execution_mode).toBe('host');

    const spaceRow = await platformApi.getSpace(testUser, spaceB);
    expect(spaceRow?.canonicalSessionId).toBe(session.id);
  });
});
