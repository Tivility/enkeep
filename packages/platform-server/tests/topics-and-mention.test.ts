import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  DeliveryRuntimeGateway,
  SqliteWebMessageStore,
  ModelSelectionService,
} from '../src/index.js';
import {
  ChatCommandService,
  parseChatCommand,
} from '../src/chat/chat-command-service.js';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { resolveInboundRoute } from '@enkeep/platform-core';
import { LarkChannelGateway, FakeLarkTransport } from '@enkeep/channel-lark';
import type { RawDshModelConfig } from '../src/config/dsh-model-config.js';

describe('Topics and Mention Gating Contract (Section 4A)', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let messageStore: SqliteWebMessageStore;
  let deliveryGateway: DeliveryRuntimeGateway;
  let modelSelectionService: ModelSelectionService;
  let chatCommandService: ChatCommandService;

  const userId = 'usr_synth_test_owner_01';
  const space1Id = 'spc_00000000000000000000000000000001';
  const space2Id = 'spc_00000000000000000000000000000002';
  const mainSession1Id = 'ses_00010000000000000000000000000001';
  const mainSession2Id = 'ses_00020000000000000000000000000001';
  const auxPinnedId = 'ses_aux_pinned_00000000000000001';
  const accountId = 'ca_test_lark_acc_01';
  const groupChatId = 'oc_test_group_synth_001';
  const p2pChatId = 'oc_test_p2p_synth_002';
  const adminSenderId = 'ou_admin_member_01';
  const regularSenderId = 'ou_regular_member_02';

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

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    // Seed test user
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, 'user_alice', 'hash', 'admin')").run(userId);

    // Seed Space 1 & 2
    db.prepare(
      "INSERT INTO spaces (id, user_id, name, folder, execution_mode, canonical_session_id, status, created_at, updated_at) VALUES (?, ?, 'Alpha Space', 'folder-alpha', 'container', NULL, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')"
    ).run(space1Id, userId);

    db.prepare(
      "INSERT INTO spaces (id, user_id, name, folder, execution_mode, canonical_session_id, status, created_at, updated_at) VALUES (?, ?, 'Beta Space', 'folder-beta', 'container', NULL, 'active', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')"
    ).run(space2Id, userId);

    // Seed Main Sessions
    db.prepare(
      "INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, current_generation, title, status, created_at, updated_at) VALUES (?, ?, ?, 'lark', ?, ?, 'p1', 'dsh1', 'container', 1, 'Main Session Alpha', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')"
    ).run(mainSession1Id, userId, space1Id, accountId, groupChatId);

    db.prepare(
      "INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, current_generation, title, status, created_at, updated_at) VALUES (?, ?, ?, 'lark', ?, 'other_ctx', 'p2', 'dsh2', 'container', 1, 'Main Session Beta', 'active', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')"
    ).run(mainSession2Id, userId, space2Id, accountId);

    // Seed Aux Pinned Session
    db.prepare(
      "INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, current_generation, title, status, created_at, updated_at) VALUES (?, ?, ?, 'lark', ?, 'aux_ctx', 'p_aux', 'dsh_aux', 'container', 1, 'Aux Session', 'active', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z')"
    ).run(auxPinnedId, userId, space1Id, accountId);

    db.prepare('UPDATE spaces SET canonical_session_id = ? WHERE id = ?').run(mainSession1Id, space1Id);
    db.prepare('UPDATE spaces SET canonical_session_id = ? WHERE id = ?').run(mainSession2Id, space2Id);

    // Seed generations
    db.prepare(
      "INSERT INTO session_generations (id, user_id, route_id, generation_number, dsh_session_id, reset_reason) VALUES ('gen_1', ?, ?, 1, 'dsh1', 'initial')"
    ).run(userId, mainSession1Id);
    db.prepare(
      "INSERT INTO session_generations (id, user_id, route_id, generation_number, dsh_session_id, reset_reason) VALUES ('gen_2', ?, ?, 1, 'dsh2', 'initial')"
    ).run(userId, mainSession2Id);

    // Seed channel account with default space = space1
    db.prepare(
      "INSERT INTO channel_accounts (id, user_id, type, default_space_id, status) VALUES (?, ?, 'lark', ?, 'active')"
    ).run(accountId, userId, space1Id);

    // Seed chat-level group binding
    db.prepare(
      "INSERT INTO channel_bindings (id, user_id, account_id, space_id, native_context_id, activation_mode, chat_type, session_route_id) VALUES ('cb_test_grp', ?, ?, ?, ?, 'mention', 'group', NULL)"
    ).run(userId, accountId, space1Id, groupChatId);

    storage = new SqlitePlatformStorage(db);
    messageStore = new SqliteWebMessageStore(db);
    modelSelectionService = new ModelSelectionService({ db });
    vi.spyOn(modelSelectionService, 'getDshCatalog').mockReturnValue(stubCatalog);

    chatCommandService = new ChatCommandService({
      modelSelectionService,
      db,
      isDockerAvailable: () => true,
      checkChatAdmin: async ({ senderId }) => senderId === adminSenderId,
    });

    deliveryGateway = new DeliveryRuntimeGateway({
      storage,
      database: db,
      messageStore,
      quotaMode: 'disabled',
      modelSelectionService,
      profileResolver: { resolve: async () => null },
      executor: { execute: async () => ({ replyText: 'runtime', usage: { totalTokens: 10 } }), cancel: async () => true },
      chatCommandService,
      checkChatAdmin: async ({ senderId }) => senderId === adminSenderId,
    });
  });

  describe('1. Topic group: /session new in topic A pins only A, topic B unaffected', () => {
    it('pins only topic A when /session new is executed from topic A', async () => {
      const topicAContext = `${groupChatId}:om_thread_topic_a`;
      const topicBContext = `${groupChatId}:om_thread_topic_b`;

      const result = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/session new Topic A Work',
        channelContext: {
          channel: 'lark',
          accountId,
          chatId: groupChatId,
          nativeContextId: topicAContext,
          senderId: adminSenderId,
          chatType: 'group',
        },
      });

      expect(result.replyText).toContain('已新建会话并固定:');
      expect(result.replyText).toContain('Topic A Work');

      // Chat-level binding remains unpinned (NULL session_route_id)
      const chatBinding = db.prepare(
        'SELECT session_route_id FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?'
      ).get(userId, accountId, groupChatId) as { session_route_id?: string | null };
      expect(chatBinding.session_route_id).toBeNull();

      // Topic A has a topic-level binding
      const topicABinding = db.prepare(
        'SELECT session_route_id, space_id FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?'
      ).get(userId, accountId, topicAContext) as { session_route_id?: string | null; space_id: string };
      expect(topicABinding).toBeDefined();
      expect(topicABinding.session_route_id).not.toBeNull();
      expect(topicABinding.space_id).toBe(space1Id);

      // Topic B has NO binding
      const topicBBinding = db.prepare(
        'SELECT * FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?'
      ).get(userId, accountId, topicBContext);
      expect(topicBBinding).toBeUndefined();

      // Resolver: Topic A enters its pinned session
      const channelRepo = storage.forTenant(userId).channels;
      const sessionRepo = storage.forTenant(userId).sessionRoutes;
      const resA = await resolveInboundRoute({
        userId,
        binding: (await channelRepo.findBindingByContext(accountId, groupChatId))!,
        topicBinding: await channelRepo.findBindingByContext(accountId, topicAContext),
        sessionRouteRepo: sessionRepo,
        channelRepo,
        canonicalOptions: {
          channel: 'lark',
          accountId,
          nativeContextId: topicAContext,
          fallbackNativeContextId: groupChatId,
        },
      });
      expect(resA.pinned).toBe(true);
      expect(resA.route.id).toBe(topicABinding.session_route_id);

      // Resolver: Topic B enters canonical main session (unaffected!)
      const resB = await resolveInboundRoute({
        userId,
        binding: (await channelRepo.findBindingByContext(accountId, groupChatId))!,
        topicBinding: await channelRepo.findBindingByContext(accountId, topicBContext),
        sessionRouteRepo: sessionRepo,
        channelRepo,
        canonicalOptions: {
          channel: 'lark',
          accountId,
          nativeContextId: topicBContext,
          fallbackNativeContextId: groupChatId,
        },
      });
      expect(resB.pinned).toBe(false);
      expect(resB.route.id).toBe(mainSession1Id);
    });
  });

  describe('2. /ws use from inside a topic changes chat level and resets topic pins with count', () => {
    it('updates chat-level workspace, deletes topic-level bindings, and reports count in reply', async () => {
      const topicA = `${groupChatId}:om_thread_a`;
      const topicB = `${groupChatId}:om_thread_b`;

      // Seed 2 topic bindings
      db.prepare(
        "INSERT INTO channel_bindings (id, user_id, account_id, space_id, native_context_id, activation_mode, session_route_id) VALUES ('cb_top_a', ?, ?, ?, ?, 'mention', ?)"
      ).run(userId, accountId, space1Id, topicA, auxPinnedId);

      db.prepare(
        "INSERT INTO channel_bindings (id, user_id, account_id, space_id, native_context_id, activation_mode, session_route_id) VALUES ('cb_top_b', ?, ?, ?, ?, 'mention', ?)"
      ).run(userId, accountId, space1Id, topicB, auxPinnedId);

      // Execute /ws use from inside topic A
      const res = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/ws use Beta Space',
        channelContext: {
          channel: 'lark',
          accountId,
          chatId: groupChatId,
          nativeContextId: topicA,
          senderId: adminSenderId,
          chatType: 'group',
        },
      });

      expect(res.replyText).toContain('已切换到工作区: Beta Space (主会话)');
      expect(res.replyText).toContain('已重置 2 个话题。');

      // Chat-level binding is switched to space2Id with cleared pin
      const chatBinding = db.prepare(
        'SELECT space_id, session_route_id FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?'
      ).get(userId, accountId, groupChatId) as { space_id: string; session_route_id?: string | null };
      expect(chatBinding.space_id).toBe(space2Id);
      expect(chatBinding.session_route_id).toBeNull();

      // Topic bindings are deleted
      const remainingTopicBindings = db.prepare(
        "SELECT COUNT(*) as count FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id LIKE ?"
      ).get(userId, accountId, `${groupChatId}:%`) as { count: number };
      expect(remainingTopicBindings.count).toBe(0);
    });
  });

  describe('3. P2P and normal group main stream vs thread replies', () => {
    it('dispatches P2P messages and rejects /mention in P2P', async () => {
      // In P2P: /mention is not applicable
      const mentionRes = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/mention on',
        channelContext: {
          channel: 'lark',
          accountId,
          chatId: p2pChatId,
          nativeContextId: p2pChatId,
          senderId: regularSenderId,
          chatType: 'p2p',
        },
      });
      expect(mentionRes.replyText).toBe('私聊不适用（总是回复）。');

      const mentionShowRes = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/mention',
        channelContext: {
          channel: 'lark',
          accountId,
          chatId: p2pChatId,
          nativeContextId: p2pChatId,
          senderId: regularSenderId,
          chatType: 'p2p',
        },
      });
      expect(mentionShowRes.replyText).toBe('私聊不适用（总是回复）。');
    });

    it('records nativeContextId accurately for main stream vs thread', async () => {
      // Main stream envelope
      const mainRes = await deliveryGateway.dispatchInbound({
        id: 'idem_main_stream_01',
        userId,
        sessionId: mainSession1Id,
        content: '/status',
        timestamp: new Date().toISOString(),
        channelContext: {
          channel: 'lark',
          accountId,
          chatId: groupChatId,
          nativeContextId: groupChatId,
          nativeEventId: 'evt_main_01',
          chatType: 'group',
        },
      });
      expect(mainRes.accepted).toBe(true);

      const mainTurnOrigin = db.prepare(
        'SELECT chat_id, native_context_id, root_id FROM channel_turn_origins WHERE native_event_id = ?'
      ).get('evt_main_01') as { chat_id: string; native_context_id: string; root_id?: string | null } | undefined;
      expect(mainTurnOrigin).toBeDefined();
      expect(mainTurnOrigin!.chat_id).toBe(groupChatId);
      expect(mainTurnOrigin!.native_context_id).toBe(groupChatId);
      expect(mainTurnOrigin!.root_id).toBeNull();

      // Thread envelope
      const threadContextId = `${groupChatId}:om_root_99`;
      const threadRes = await deliveryGateway.dispatchInbound({
        id: 'idem_thread_01',
        userId,
        sessionId: mainSession1Id,
        content: '/status',
        timestamp: new Date().toISOString(),
        channelContext: {
          channel: 'lark',
          accountId,
          chatId: groupChatId,
          nativeContextId: threadContextId,
          nativeEventId: 'evt_th_99',
          rootId: 'om_root_99',
          threadId: 'om_root_99',
          chatType: 'group',
        },
      });
      expect(threadRes.accepted).toBe(true);

      const threadTurnOrigin = db.prepare(
        'SELECT chat_id, native_context_id, root_id, thread_id FROM channel_turn_origins WHERE native_event_id = ?'
      ).get('evt_th_99') as { chat_id: string; native_context_id: string; root_id?: string | null; thread_id?: string | null } | undefined;
      expect(threadTurnOrigin).toBeDefined();
      expect(threadTurnOrigin!.chat_id).toBe(groupChatId);
      expect(threadTurnOrigin!.native_context_id).toBe(threadContextId);
      expect(threadTurnOrigin!.root_id).toBe('om_root_99');
    });
  });

  describe('4. /session use x all from a topic', () => {
    it('applies session pinning to chat level when "all" is appended', async () => {
      const topicA = `${groupChatId}:om_thread_a`;

      const res = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: `/session use ${auxPinnedId} all`,
        channelContext: {
          channel: 'lark',
          accountId,
          chatId: groupChatId,
          nativeContextId: topicA,
          senderId: adminSenderId,
          chatType: 'group',
        },
      });

      expect(res.replyText).toContain('已固定到会话:');
      expect(res.replyText).toContain('Aux Session');

      // Chat-level binding is pinned to auxPinnedId
      const chatBinding = db.prepare(
        'SELECT session_route_id FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?'
      ).get(userId, accountId, groupChatId) as { session_route_id?: string | null };
      expect(chatBinding.session_route_id).toBe(auxPinnedId);

      // Topic A does NOT have an individual topic binding
      const topicABinding = db.prepare(
        'SELECT * FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?'
      ).get(userId, accountId, topicA);
      expect(topicABinding).toBeUndefined();

      // Inbound in topic B falls back to chat-level pin (auxPinnedId)
      const channelRepo = storage.forTenant(userId).channels;
      const sessionRepo = storage.forTenant(userId).sessionRoutes;
      const resB = await resolveInboundRoute({
        userId,
        binding: (await channelRepo.findBindingByContext(accountId, groupChatId))!,
        topicBinding: null,
        sessionRouteRepo: sessionRepo,
        channelRepo,
        canonicalOptions: {
          channel: 'lark',
          accountId,
          nativeContextId: `${groupChatId}:om_thread_b`,
          fallbackNativeContextId: groupChatId,
        },
      });
      expect(resB.pinned).toBe(true);
      expect(resB.route.id).toBe(auxPinnedId);
    });
  });

  describe('5. Resolver fallbacks and topic binding invalidation', () => {
    it('deletes topic binding and gives fallback notice on space mismatch', async () => {
      const topicMismatch = `${groupChatId}:om_thread_mismatch`;
      // Create topic binding with space2Id while chat is on space1Id
      db.prepare(
        "INSERT INTO channel_bindings (id, user_id, account_id, space_id, native_context_id, activation_mode, session_route_id) VALUES ('cb_mis', ?, ?, ?, ?, 'mention', ?)"
      ).run(userId, accountId, space2Id, topicMismatch, mainSession2Id);

      const channelRepo = storage.forTenant(userId).channels;
      const sessionRepo = storage.forTenant(userId).sessionRoutes;

      const resolved = await resolveInboundRoute({
        userId,
        binding: (await channelRepo.findBindingByContext(accountId, groupChatId))!,
        topicBinding: (await channelRepo.findBindingByContext(accountId, topicMismatch))!,
        sessionRouteRepo: sessionRepo,
        channelRepo,
        canonicalOptions: {
          channel: 'lark',
          accountId,
          nativeContextId: topicMismatch,
          fallbackNativeContextId: groupChatId,
        },
      });

      // Topic binding deleted from DB
      const dbBinding = await channelRepo.findBindingByContext(accountId, topicMismatch);
      expect(dbBinding).toBeNull();

      // Resolved route belongs to chat workspace (space1Id)
      expect(resolved.route.spaceId).toBe(space1Id);
      expect(resolved.pinned).toBe(false);
      expect(resolved.fallbackNotice).toBe('提示：该话题此前固定的工作区已失效，已自动切回主会话。');
    });

    it('clears invalid topic pin and provides fallback notice when pinned session is archived', async () => {
      const topicArchived = `${groupChatId}:om_thread_arch`;
      const archivedSessionId = 'ses_archived_00000000001';
      db.prepare(
        "INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, current_generation, title, status, created_at, updated_at) VALUES (?, ?, ?, 'lark', ?, 'arch_ctx', 'p_arch', 'dsh_arch', 'container', 1, 'Archived Session', 'archived', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')"
      ).run(archivedSessionId, userId, space1Id, accountId);

      db.prepare(
        "INSERT INTO channel_bindings (id, user_id, account_id, space_id, native_context_id, activation_mode, session_route_id) VALUES ('cb_arch', ?, ?, ?, ?, 'mention', ?)"
      ).run(userId, accountId, space1Id, topicArchived, archivedSessionId);

      const channelRepo = storage.forTenant(userId).channels;
      const sessionRepo = storage.forTenant(userId).sessionRoutes;

      const resolved = await resolveInboundRoute({
        userId,
        binding: (await channelRepo.findBindingByContext(accountId, groupChatId))!,
        topicBinding: (await channelRepo.findBindingByContext(accountId, topicArchived))!,
        sessionRouteRepo: sessionRepo,
        channelRepo,
        canonicalOptions: {
          channel: 'lark',
          accountId,
          nativeContextId: topicArchived,
          fallbackNativeContextId: groupChatId,
        },
      });

      // Pin cleared on topic binding
      const updatedBinding = await channelRepo.findBindingByContext(accountId, topicArchived);
      expect(updatedBinding?.sessionRouteId).toBeNull();
      expect(resolved.pinned).toBe(false);
      expect(resolved.route.id).toBe(mainSession1Id);
      expect(resolved.fallbackNotice).toBe('提示：此前固定的会话已失效，已自动切回主会话。');
    });
  });

  describe('6. Activation inherits chat level & /mention persistence and gating', () => {
    it('gating: non-admin cannot change /mention, admin can change and persists', async () => {
      // Non-admin rejected
      const rejectRes = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/mention off',
        channelContext: {
          channel: 'lark',
          accountId,
          chatId: groupChatId,
          nativeContextId: groupChatId,
          senderId: regularSenderId,
          chatType: 'group',
        },
      });
      expect(rejectRes.replyText).toBe('群聊中仅群主或管理员可执行此指令。');

      // Admin turns /mention off
      const offRes = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/mention off',
        channelContext: {
          channel: 'lark',
          accountId,
          chatId: groupChatId,
          nativeContextId: groupChatId,
          senderId: adminSenderId,
          chatType: 'group',
        },
      });
      expect(offRes.replyText).toContain('已关闭 @ 模式：机器人将回复群内所有消息。');
      expect(offRes.replyText).toContain('提示：需要在飞书开放平台开通“获取群组中所有消息”权限。');

      // Verify DB persistence
      const bindingRow = db.prepare(
        'SELECT activation_mode FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?'
      ).get(userId, accountId, groupChatId) as { activation_mode: string };
      expect(bindingRow.activation_mode).toBe('always');

      // Check current setting
      const showRes = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/mention',
        channelContext: {
          channel: 'lark',
          accountId,
          chatId: groupChatId,
          nativeContextId: groupChatId,
          senderId: regularSenderId,
          chatType: 'group',
        },
      });
      expect(showRes.replyText).toBe('当前设置: 回复所有消息 (off)');

      // Admin turns /require_mention true
      const requireTrueRes = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/require_mention true',
        channelContext: {
          channel: 'lark',
          accountId,
          chatId: groupChatId,
          nativeContextId: groupChatId,
          senderId: adminSenderId,
          chatType: 'group',
        },
      });
      expect(requireTrueRes.replyText).toBe('已开启 @ 模式：仅在被 @ 机器人时回复。');

      const updatedRow = db.prepare(
        'SELECT activation_mode FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?'
      ).get(userId, accountId, groupChatId) as { activation_mode: string };
      expect(updatedRow.activation_mode).toBe('mention');
    });

    it('modifying /mention from inside a topic applies to chat level', async () => {
      const topicX = `${groupChatId}:om_thread_x`;

      const offRes = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/mention off',
        channelContext: {
          channel: 'lark',
          accountId,
          chatId: groupChatId,
          nativeContextId: topicX,
          senderId: adminSenderId,
          chatType: 'group',
        },
      });
      expect(offRes.replyText).toContain('已关闭 @ 模式');

      const chatBinding = db.prepare(
        'SELECT activation_mode FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?'
      ).get(userId, accountId, groupChatId) as { activation_mode: string };
      expect(chatBinding.activation_mode).toBe('always');
    });
  });

  describe('7. Mention waiver: in replied or pinned topics, not in fresh topics', () => {
    it('enforces mention in fresh topic, waives in pinned topic or topic with channel_turn_origins', async () => {
      const channelRepo = storage.forTenant(userId).channels;
      const sessionRepo = storage.forTenant(userId).sessionRoutes;

      // LarkChannelGateway with FakeTransport
      const transport = new FakeLarkTransport();
      await transport.start();

      const gateway = new LarkChannelGateway({
        account: {
          id: accountId,
          userId,
          botOpenId: 'ou_bot_synth_01',
          appId: 'cli_bot_synth_01',
        },
        transport,
        channelRepo,
        sessionRouteRepo: sessionRepo,
        runtimeGateway: deliveryGateway,
      });

      // Ensure group chat is in 'mention' mode
      await channelRepo.updateBinding('cb_test_grp', { activationMode: 'mention' });

      const freshTopicRoot = 'om_fresh_root_001';
      const freshTopicContext = `${groupChatId}:${freshTopicRoot}`;

      // 1. Fresh topic without mention -> NOT handled (ignored: not_mentioned)
      const freshNoMention = await gateway.handleInboundEvent({
        header: { event_id: 'evt_fresh_1', event_type: 'im.message.receive_v1', create_time: '1700000000000' },
        event: {
          sender: { sender_id: { open_id: 'ou_user_1' } },
          message: {
            message_id: 'om_fresh_msg_1',
            chat_id: groupChatId,
            chat_type: 'group',
            root_id: freshTopicRoot,
            message_type: 'text',
            content: JSON.stringify({ text: 'Hello bot in fresh thread without mention' }),
            create_time: '1700000000000',
          },
        },
      });
      expect(freshNoMention.handled).toBe(false);
      expect(freshNoMention.ignoredReason).toBe('not_mentioned');

      // 2. Mention bot in that fresh topic -> Handled!
      const freshWithMention = await gateway.handleInboundEvent({
        header: { event_id: 'evt_fresh_2', event_type: 'im.message.receive_v1', create_time: '1700000001000' },
        event: {
          sender: { sender_id: { open_id: 'ou_user_1' } },
          message: {
            message_id: 'om_fresh_msg_2',
            chat_id: groupChatId,
            chat_type: 'group',
            root_id: freshTopicRoot,
            message_type: 'text',
            content: JSON.stringify({ text: '@_user_1 hello bot' }),
            mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot_synth_01' }, name: 'Bot' }],
            create_time: '1700000001000',
          },
        },
      });
      expect(freshWithMention.handled).toBe(true);

      // Simulate turn completed: bot replies in this thread context, recording channel_turn_origins
      await gateway.handleTurnCompleted({
        sessionId: freshWithMention.sessionRouteId!,
        turnId: freshWithMention.turnId!,
        replyText: 'Hello from Bot!',
        chatId: groupChatId,
        nativeEventId: 'evt_fresh_2',
        replyToMessageId: 'om_fresh_msg_2',
        rootId: freshTopicRoot,
        threadId: freshTopicRoot,
      });

      // Insert channel_turn_origins to simulate delivery gateway recording the turn origin for this context
      await channelRepo.createTurnOrigin({
        turnId: 'trn_bot_reply_01',
        sessionId: freshWithMention.sessionRouteId!,
        accountId,
        channel: 'lark',
        chatId: groupChatId,
        nativeContextId: freshTopicContext,
        rootId: freshTopicRoot,
        threadId: freshTopicRoot,
      });

      // 3. Now send follow-up message in Topic 1 WITHOUT mention -> Handled due to reply waiver!
      const followupNoMention = await gateway.handleInboundEvent({
        header: { event_id: 'evt_fresh_3', event_type: 'im.message.receive_v1', create_time: '1700000002000' },
        event: {
          sender: { sender_id: { open_id: 'ou_user_1' } },
          message: {
            message_id: 'om_fresh_msg_3',
            chat_id: groupChatId,
            chat_type: 'group',
            root_id: freshTopicRoot,
            message_type: 'text',
            content: JSON.stringify({ text: 'Follow-up question without mention' }),
            create_time: '1700000002000',
          },
        },
      });
      expect(followupNoMention.handled).toBe(true);

      // 4. Topic 2 has a topic-level binding -> Handled without mention due to pinned topic waiver!
      const pinnedTopicRoot = 'om_pinned_root_002';
      const pinnedTopicContext = `${groupChatId}:${pinnedTopicRoot}`;
      await channelRepo.createBinding({
        accountId,
        spaceId: space1Id,
        nativeContextId: pinnedTopicContext,
        sessionRouteId: auxPinnedId,
      });

      const pinnedNoMention = await gateway.handleInboundEvent({
        header: { event_id: 'evt_pinned_1', event_type: 'im.message.receive_v1', create_time: '1700000003000' },
        event: {
          sender: { sender_id: { open_id: 'ou_user_1' } },
          message: {
            message_id: 'om_pinned_msg_1',
            chat_id: groupChatId,
            chat_type: 'group',
            root_id: pinnedTopicRoot,
            message_type: 'text',
            content: JSON.stringify({ text: 'Question in pinned topic without mention' }),
            create_time: '1700000003000',
          },
        },
      });
      expect(pinnedNoMention.handled).toBe(true);

      // 5. Fresh Topic 3 (no binding, no previous reply) WITHOUT mention -> NOT handled!
      const fresh3Root = 'om_fresh3_root_003';
      const fresh3NoMention = await gateway.handleInboundEvent({
        header: { event_id: 'evt_fresh3_1', event_type: 'im.message.receive_v1', create_time: '1700000004000' },
        event: {
          sender: { sender_id: { open_id: 'ou_user_1' } },
          message: {
            message_id: 'om_fresh3_msg_1',
            chat_id: groupChatId,
            chat_type: 'group',
            root_id: fresh3Root,
            message_type: 'text',
            content: JSON.stringify({ text: 'Another fresh thread without mention' }),
            create_time: '1700000004000',
          },
        },
      });
      expect(fresh3NoMention.handled).toBe(false);
      expect(fresh3NoMention.ignoredReason).toBe('not_mentioned');
    });
  });
});
