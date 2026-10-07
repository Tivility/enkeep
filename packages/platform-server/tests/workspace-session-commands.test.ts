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
  computeSessionShortId,
  matchSessionInSpace,
} from '../src/chat/chat-command-service.js';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { resolveInboundRoute } from '@enkeep/platform-core';
import type { RawDshModelConfig } from '../src/config/dsh-model-config.js';

describe('Workspace and Session Commands & Pinning Lifecycle (Batch 1)', () => {
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
  const chatContextId = 'oc_test_chat_synth_001';
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

    // Seed Space 1 and Space 2 (initially NULL canonical_session_id to satisfy FK)
    db.prepare(
      "INSERT INTO spaces (id, user_id, name, folder, execution_mode, canonical_session_id, status, created_at, updated_at) VALUES (?, ?, 'Alpha Space', 'folder-alpha', 'container', NULL, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')"
    ).run(space1Id, userId);

    db.prepare(
      "INSERT INTO spaces (id, user_id, name, folder, execution_mode, canonical_session_id, status, created_at, updated_at) VALUES (?, ?, 'Beta Space', 'folder-beta', 'container', NULL, 'active', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')"
    ).run(space2Id, userId);

    // Seed Main Sessions
    db.prepare(
      "INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, current_generation, title, status, created_at, updated_at) VALUES (?, ?, ?, 'lark', ?, ?, 'p1', 'dsh1', 'container', 1, 'Main Session Alpha', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')"
    ).run(mainSession1Id, userId, space1Id, accountId, chatContextId);

    db.prepare(
      "INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, current_generation, title, status, created_at, updated_at) VALUES (?, ?, ?, 'lark', ?, 'other_ctx', 'p2', 'dsh2', 'container', 1, 'Main Session Beta', 'active', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')"
    ).run(mainSession2Id, userId, space2Id, accountId);

    // Seed Aux Pinned Session
    db.prepare(
      "INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, current_generation, title, status, created_at, updated_at) VALUES (?, ?, ?, 'lark', ?, 'aux_ctx', 'p_aux', 'dsh_aux', 'container', 1, 'Aux Session', 'active', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z')"
    ).run(auxPinnedId, userId, space1Id, accountId);

    // Update canonical_session_id on spaces
    db.prepare('UPDATE spaces SET canonical_session_id = ? WHERE id = ?').run(mainSession1Id, space1Id);
    db.prepare('UPDATE spaces SET canonical_session_id = ? WHERE id = ?').run(mainSession2Id, space2Id);

    // Seed generations for main sessions
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

    // Seed channel binding for chatContextId pointing to space1, session_route_id = null (following canonical)
    db.prepare(
      "INSERT INTO channel_bindings (id, user_id, account_id, space_id, native_context_id, activation_mode, chat_type, session_route_id) VALUES ('cb_test_01', ?, ?, ?, ?, 'always', 'group', NULL)"
    ).run(userId, accountId, space1Id, chatContextId);

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
      executor: { execute: async () => ({ replyText: 'runtime' }), cancel: async () => true },
      chatCommandService,
    });
  });

  describe('1. Command Execution in Web and Channel Contexts', () => {
    it('/ws shows workspace information with binding origin', async () => {
      // Channel context (default origin because spaceId === account default_space_id)
      const chanRes = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/ws',
        channelContext: { channel: 'lark', accountId, chatId: chatContextId, chatType: 'p2p' },
      });
      expect(chanRes.replyText).toContain('工作区: Alpha Space');
      expect(chanRes.replyText).toContain('目录: folder-alpha');
      expect(chanRes.replyText).toContain('执行模式: 容器隔离 (container)');
      expect(chanRes.replyText).toContain('绑定来源: 默认');

      // Web context
      const webRes = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/ws',
        channelContext: { channel: 'web', accountId: 'default', chatId: 'web', chatType: 'p2p' },
      });
      expect(webRes.replyText).toContain('工作区: Alpha Space');
      expect(webRes.replyText).toContain('绑定来源: 默认');
    });

    it('/ws list lists active workspaces with total count in p2p context', async () => {
      const res = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/ws list',
        channelContext: { channel: 'lark', accountId, chatId: chatContextId, chatType: 'p2p' },
      });
      expect(res.replyText).toContain('工作区列表 (共 2 个):');
      expect(res.replyText).toContain('* Alpha Space (container)');
      expect(res.replyText).toContain('Beta Space (container)');

      // Alias /ws ls
      const lsRes = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/ws ls',
        channelContext: { channel: 'lark', accountId, chatId: chatContextId, chatType: 'p2p' },
      });
      expect(lsRes.replyText).toBe(res.replyText);
    });

    it('/ws use: web instructs sidebar, channel switches workspace and clears pin', async () => {
      // Pin current chat to an auxiliary session first
      db.prepare("UPDATE channel_bindings SET session_route_id = ? WHERE id = 'cb_test_01'").run(auxPinnedId);

      // Web context -> directs to sidebar
      const webRes = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/ws use Beta Space',
        channelContext: { channel: 'web' },
      });
      expect(webRes.replyText).toBe('请在侧栏切换工作区。');

      // Channel context -> switches workspace and unpins
      const chanRes = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/ws use Beta Space',
        channelContext: { channel: 'lark', accountId, chatId: chatContextId, chatType: 'p2p' },
      });
      expect(chanRes.replyText).toContain('已切换到工作区: Beta Space (主会话)');

      const binding = db.prepare('SELECT space_id, session_route_id FROM channel_bindings WHERE id = ?').get('cb_test_01') as any;
      expect(binding.space_id).toBe(space2Id);
      expect(binding.session_route_id).toBeNull();
    });

    it('/ws new: web instructs sidebar, channel creates and switches', async () => {
      // Web context
      const webRes = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/ws new Gamma Space',
        channelContext: { channel: 'web' },
      });
      expect(webRes.replyText).toBe('工作区 "Gamma Space" 已创建。请在侧栏切换打开。');

      // Channel context
      const chanRes = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/ws new Delta Space',
        channelContext: { channel: 'lark', accountId, chatId: chatContextId, chatType: 'p2p' },
      });
      expect(chanRes.replyText).toBe('工作区 "Delta Space" 已创建并切换。');

      const createdSpace = db.prepare("SELECT id, name FROM spaces WHERE name = 'Delta Space'").get() as any;
      expect(createdSpace).toBeDefined();

      const binding = db.prepare('SELECT space_id, session_route_id FROM channel_bindings WHERE id = ?').get('cb_test_01') as any;
      expect(binding.space_id).toBe(createdSpace.id);
      expect(binding.session_route_id).toBeNull();
    });

    it('/ws home: reverts to account default workspace in channel, directs to sidebar in web', async () => {
      // Explicitly bind to space 2 first
      db.prepare("UPDATE channel_bindings SET space_id = ? WHERE id = 'cb_test_01'").run(space2Id);

      // Web
      const webRes = await chatCommandService.execute({
        userId,
        sessionId: mainSession2Id,
        spaceId: space2Id,
        content: '/ws home',
        channelContext: { channel: 'web' },
      });
      expect(webRes.replyText).toBe('请在侧栏切换工作区。');

      // Channel
      const chanRes = await chatCommandService.execute({
        userId,
        sessionId: mainSession2Id,
        spaceId: space2Id,
        content: '/ws home',
        channelContext: { channel: 'lark', accountId, chatId: chatContextId, chatType: 'p2p' },
      });
      expect(chanRes.replyText).toContain('已回到账号默认工作区: Alpha Space');

      // Explicit binding deleted
      const binding = db.prepare('SELECT * FROM channel_bindings WHERE id = ?').get('cb_test_01');
      expect(binding).toBeUndefined();
    });

    it('/session (and alias /ses) displays session info', async () => {
      const res = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/session',
        channelContext: { channel: 'lark', accountId, chatId: chatContextId, chatType: 'p2p' },
      });
      expect(res.replyText).toContain('会话: 0001');
      expect(res.replyText).toContain('标题: Main Session Alpha');
      expect(res.replyText).toContain('主会话: 是');
      expect(res.replyText).toContain('代际: 第 1 代');

      // Alias /ses
      const aliasRes = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/ses',
        channelContext: { channel: 'lark', accountId, chatId: chatContextId, chatType: 'p2p' },
      });
      expect(aliasRes.replyText).toBe(res.replyText);
    });

    it('/session list (and alias /ses list, /session ls) lists workspace sessions with markers', async () => {
      // Create a second session in Space 1
      const auxId = 'ses_00019999000000000000000000000002';
      db.prepare(
        "INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, current_generation, title, status, created_at, updated_at) VALUES (?, ?, ?, 'lark', ?, 'aux', 'p', 'dsh', 'container', 1, 'Auxiliary Session', 'active', '2026-01-05T00:00:00.000Z', '2026-01-05T00:00:00.000Z')"
      ).run(auxId, userId, space1Id, accountId);

      const res = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/session list',
        channelContext: { channel: 'lark', accountId, chatId: chatContextId, chatType: 'p2p' },
      });
      expect(res.replyText).toContain('当前工作区会话 (共 3 个):');
      expect(res.replyText).toContain('* 00010 - Main Session Alpha [主会话] (第 1 代)');
      expect(res.replyText).toContain('00019 - Auxiliary Session (第 1 代)');

      // Alias /ses list
      const sesListRes = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/ses list',
        channelContext: { channel: 'lark', accountId, chatId: chatContextId, chatType: 'p2p' },
      });
      expect(sesListRes.replyText).toBe(res.replyText);
    });
  });

  describe('2. Session Pinning Lifecycle (/session new, /session use, /ws use)', () => {
    it('/session new pins current chat and leaves canonical session pointer unchanged', async () => {
      const result = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/session new Feature Work',
        channelContext: { channel: 'lark', accountId, chatId: chatContextId, chatType: 'p2p' },
      });

      expect(result.replyText).toContain('已新建会话并固定:');
      expect(result.replyText).toContain('(Feature Work)');

      // 1. Verify new session route was created
      const newSession = db.prepare("SELECT id, title, space_id FROM session_routes WHERE title = 'Feature Work'").get() as any;
      expect(newSession).toBeDefined();
      expect(newSession.space_id).toBe(space1Id);

      // 2. Verify channel_bindings is pinned to new session
      const binding = db.prepare('SELECT session_route_id FROM channel_bindings WHERE id = ?').get('cb_test_01') as any;
      expect(binding.session_route_id).toBe(newSession.id);

      // 3. Verify spaces.canonical_session_id remains UNCHANGED (pointing to mainSession1Id)
      const space = db.prepare('SELECT canonical_session_id FROM spaces WHERE id = ?').get(space1Id) as any;
      expect(space.canonical_session_id).toBe(mainSession1Id);
    });

    it('/session use main unpins the chat back to canonical main session', async () => {
      // Pin to aux session first
      db.prepare("UPDATE channel_bindings SET session_route_id = ? WHERE id = 'cb_test_01'").run(auxPinnedId);

      const result = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/session use main',
        channelContext: { channel: 'lark', accountId, chatId: chatContextId, chatType: 'p2p' },
      });

      expect(result.replyText).toBe('已切换为跟随主会话。');
      const binding = db.prepare('SELECT session_route_id FROM channel_bindings WHERE id = ?').get('cb_test_01') as any;
      expect(binding.session_route_id).toBeNull();
    });

    it('/ws use clears any existing session pin', async () => {
      // Pin to aux session first
      db.prepare("UPDATE channel_bindings SET session_route_id = ? WHERE id = 'cb_test_01'").run(auxPinnedId);

      await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/ws use Beta Space',
        channelContext: { channel: 'lark', accountId, chatId: chatContextId, chatType: 'p2p' },
      });

      const binding = db.prepare('SELECT space_id, session_route_id FROM channel_bindings WHERE id = ?').get('cb_test_01') as any;
      expect(binding.space_id).toBe(space2Id);
      expect(binding.session_route_id).toBeNull();
    });
  });

  describe('3. Inbound Routing Resolver & Invalid Pin Fallback Notice', () => {
    it('honors valid pinned session route', async () => {
      // Create pinned active session in space1
      const pinnedSessionId = 'ses_pinned_active_01';
      db.prepare(
        "INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, current_generation, title, status) VALUES (?, ?, ?, 'lark', ?, 'pinned', 'p', 'dsh', 'container', 1, 'Pinned Active', 'active')"
      ).run(pinnedSessionId, userId, space1Id, accountId);

      const binding = { id: 'cb_test_01', spaceId: space1Id, sessionRouteId: pinnedSessionId };
      const tenant = storage.forTenant(userId);

      const resolution = await resolveInboundRoute({
        userId,
        binding,
        sessionRouteRepo: tenant.sessionRoutes,
        channelRepo: tenant.channels,
        canonicalOptions: {
          channel: 'lark',
          accountId,
          nativeContextId: chatContextId,
        },
      });

      expect(resolution.pinned).toBe(true);
      expect(resolution.route.id).toBe(pinnedSessionId);
      expect(resolution.fallbackNotice).toBeUndefined();
    });

    it('falls back to canonical session when pinned route is archived, clears pin, and sets fallbackNotice', async () => {
      // Create archived session
      const archivedSessionId = 'ses_archived_pinned_01';
      db.prepare(
        "INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, current_generation, title, status) VALUES (?, ?, ?, 'lark', ?, 'archived', 'p', 'dsh', 'container', 1, 'Archived Pin', 'archived')"
      ).run(archivedSessionId, userId, space1Id, accountId);

      // Pin binding in database
      db.prepare('UPDATE channel_bindings SET session_route_id = ? WHERE id = ?').run(archivedSessionId, 'cb_test_01');

      const bindingRow = (await storage.forTenant(userId).channels.findBindingById('cb_test_01'))!;
      expect(bindingRow.sessionRouteId).toBe(archivedSessionId);

      const tenant = storage.forTenant(userId);
      const resolution = await resolveInboundRoute({
        userId,
        binding: bindingRow,
        sessionRouteRepo: tenant.sessionRoutes,
        channelRepo: tenant.channels,
        canonicalOptions: {
          channel: 'lark',
          accountId,
          nativeContextId: chatContextId,
        },
      });

      // 1. Resolved route is the canonical main session
      expect(resolution.pinned).toBe(false);
      expect(resolution.route.id).toBe(mainSession1Id);

      // 2. Notice is provided
      expect(resolution.fallbackNotice).toBe('提示：此前固定的会话已失效，已自动切回主会话。');

      // 3. Database session_route_id is cleared
      const updatedBinding = (await storage.forTenant(userId).channels.findBindingById('cb_test_01'))!;
      expect(updatedBinding.sessionRouteId).toBeNull();
    });

    it('gateway prepends fallbackNotice to command execution reply', async () => {
      const dispatchResult = await deliveryGateway.dispatchInbound({
        id: 'deliv_fallback_notice_001',
        userId,
        sessionId: mainSession1Id,
        content: '/status',
        timestamp: new Date().toISOString(),
        channelContext: {
          channel: 'lark',
          accountId,
          chatId: chatContextId,
          nativeContextId: chatContextId,
          fallbackNotice: '提示：此前固定的会话已失效，已自动切回主会话。',
        },
      });

      expect(dispatchResult.accepted).toBe(true);

      const history = await messageStore.listMessages(userId, mainSession1Id);
      const assistantMsg = history.messages.find((m) => m.role === 'assistant');
      expect(assistantMsg?.content).toContain('提示：此前固定的会话已失效，已自动切回主会话。');
      expect(assistantMsg?.content).toContain('space: Alpha Space');
    });
  });

  describe('4. Session Clear Confirmation Rules & Dependency Count', () => {
    it('non-main session clear does not require confirmation', async () => {
      // Create non-canonical auxiliary session
      const auxId = 'ses_non_canonical_01';
      db.prepare(
        "INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, current_generation, title, status) VALUES (?, ?, ?, 'lark', ?, 'aux', 'p', 'dsh_aux', 'container', 1, 'Aux Session', 'active')"
      ).run(auxId, userId, space1Id, accountId);
      db.prepare(
        "INSERT INTO session_generations (id, user_id, route_id, generation_number, dsh_session_id, reset_reason) VALUES ('gen_aux_1', ?, ?, 1, 'dsh_aux', 'initial')"
      ).run(userId, auxId);

      const res = await chatCommandService.execute({
        userId,
        sessionId: auxId,
        spaceId: space1Id,
        content: '/session clear',
        channelContext: { channel: 'lark', accountId, chatId: chatContextId, chatType: 'p2p' },
      });

      expect(res.replyText).toBe('Started generation 2 (was 1)');

      const routeRow = db.prepare('SELECT current_generation FROM session_routes WHERE id = ?').get(auxId) as any;
      expect(routeRow.current_generation).toBe(2);
    });

    it('shared main session clear with dependencies prompts confirmation and dependency count', async () => {
      // 1. Add another channel binding pointing to Space 1 (no pinned session -> depends on main)
      db.prepare(
        "INSERT INTO channel_bindings (id, user_id, account_id, space_id, native_context_id, activation_mode, session_route_id) VALUES ('cb_other_share', ?, ?, ?, 'oc_chat_2', 'always', NULL)"
      ).run(userId, accountId, space1Id);

      // 2. Add an active scheduled task using existing_session on mainSession1Id
      const taskPayload = JSON.stringify({
        type: 'agent_prompt',
        prompt: 'Daily digest',
        sessionId: mainSession1Id,
        sessionPolicy: 'existing_session',
      });
      db.prepare(
        "INSERT INTO platform_tasks (id, user_id, title, status, payload) VALUES ('task_cron_01', ?, 'Daily Task', 'pending', ?)"
      ).run(userId, taskPayload);

      // Run /session clear without confirm
      const clearRes = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/session clear',
        channelContext: { channel: 'lark', accountId, chatId: chatContextId, chatType: 'p2p' },
      });

      expect(clearRes.replyText).toContain('当前主会话正被 1 个其他绑定及 1 个定时任务（共 2 处依赖）共享使用。');
      expect(clearRes.replyText).toContain('/session clear confirm');

      // Verify generation was NOT incremented
      let routeRow = db.prepare('SELECT current_generation FROM session_routes WHERE id = ?').get(mainSession1Id) as any;
      expect(routeRow.current_generation).toBe(1);

      // Send confirmation
      const confirmRes = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/session clear confirm',
        channelContext: { channel: 'lark', accountId, chatId: chatContextId, chatType: 'p2p' },
      });

      expect(confirmRes.replyText).toBe('Started generation 2 (was 1)');
      routeRow = db.prepare('SELECT current_generation FROM session_routes WHERE id = ?').get(mainSession1Id) as any;
      expect(routeRow.current_generation).toBe(2);
    });

    it('main session clear without other dependencies resets immediately', async () => {
      // Only cb_test_01 points to space1 (no other bindings, no tasks)
      const res = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/session clear',
        channelContext: { channel: 'lark', accountId, chatId: chatContextId, chatType: 'p2p' },
      });
      expect(res.replyText).toBe('Started generation 2 (was 1)');
    });
  });

  describe('5. Group Chat Permission Gating & p2p Unrestricted', () => {
    it('blocks non-owner/admin in group chat for mutating commands', async () => {
      const mutatingCommands = [
        '/ws use Beta Space',
        '/ws new New Group Space',
        '/ws home',
        '/session use main',
        '/session new Group Session',
        '/session clear',
        '/sw run background job',
        '/bind Beta Space',
        '/unbind',
      ];

      for (const cmd of mutatingCommands) {
        const res = await chatCommandService.execute({
          userId,
          sessionId: mainSession1Id,
          spaceId: space1Id,
          content: cmd,
          channelContext: {
            channel: 'lark',
            accountId,
            chatId: chatContextId,
            senderId: regularSenderId, // Not admin
            chatType: 'group',
          },
        });
        expect(res.replyText).toBe('群聊中仅群主或管理员可执行此指令。');
      }
    });

    it('allows admin/owner in group chat to execute mutating commands', async () => {
      const res = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/ws use Beta Space',
        channelContext: {
          channel: 'lark',
          accountId,
          chatId: chatContextId,
          senderId: adminSenderId, // Authorized admin
          chatType: 'group',
        },
      });
      expect(res.replyText).toContain('已切换到工作区: Beta Space');
    });

    it('allows regular users in p2p chat to execute mutating commands unrestricted', async () => {
      const res = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/ws use Beta Space',
        channelContext: {
          channel: 'lark',
          accountId,
          chatId: chatContextId,
          senderId: regularSenderId, // Regular user in p2p
          chatType: 'p2p',
        },
      });
      expect(res.replyText).toContain('已切换到工作区: Beta Space');
    });

    it('/ws list in group chat displays current workspace only', async () => {
      const groupRes = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/ws list',
        channelContext: {
          channel: 'lark',
          accountId,
          chatId: chatContextId,
          senderId: regularSenderId,
          chatType: 'group',
        },
      });

      expect(groupRes.replyText).toContain('工作区列表 (群聊仅展示当前工作区，共 1 个):');
      expect(groupRes.replyText).toContain('* Alpha Space (container)');
      expect(groupRes.replyText).not.toContain('Beta Space');
    });
  });

  describe('6. Legacy Command Handling & Compatibility', () => {
    it('legacy /new returns hint and changes nothing', async () => {
      const resNoArgs = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/new',
      });
      expect(resNoArgs.replyText).toBe('新会话请使用 /session new，新建工作区请使用 /ws new');

      const resWithArgs = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/new some-workspace',
      });
      expect(resWithArgs.replyText).toBe('新会话请使用 /session new，新建工作区请使用 /ws new');

      // Invariant: generation has not changed
      const routeRow = db.prepare('SELECT current_generation FROM session_routes WHERE id = ?').get(mainSession1Id) as any;
      expect(routeRow.current_generation).toBe(1);
    });

    it('/bind executes workspace switch, unpins, and appends hint', async () => {
      db.prepare("UPDATE channel_bindings SET session_route_id = ? WHERE id = 'cb_test_01'").run(auxPinnedId);

      const res = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/bind Beta Space',
        channelContext: { channel: 'lark', accountId, chatId: chatContextId, chatType: 'p2p' },
      });

      expect(res.replyText).toContain('已绑定到工作区: Beta Space。之后本聊天的消息会进入该工作区的会话。');
      expect(res.replyText).toContain('提示: 建议使用新指令 /ws use <目标>');

      const binding = db.prepare('SELECT space_id, session_route_id FROM channel_bindings WHERE id = ?').get('cb_test_01') as any;
      expect(binding.space_id).toBe(space2Id);
      expect(binding.session_route_id).toBeNull();
    });
  });

  describe('7. Short IDs with Automatic Collision Extension', () => {
    it('computes 4-character short ID when unique, extends when colliding in same workspace', () => {
      const idA = 'ses_abcd1111000000000000000000000001';
      const idB = 'ses_abcd2222000000000000000000000002';
      const idC = 'ses_wxyz0000000000000000000000000003';

      const allIds = [idA, idB, idC];

      // idC has unique prefix 'wxyz'
      expect(computeSessionShortId(idC, allIds)).toBe('wxyz');

      // idA and idB collide on 4 characters 'abcd', so length extends to 5
      expect(computeSessionShortId(idA, allIds)).toBe('abcd1');
      expect(computeSessionShortId(idB, allIds)).toBe('abcd2');
    });

    it('matches session by extended short ID or title in /session use', async () => {
      const idA = 'ses_abcd1111000000000000000000000001';
      const idB = 'ses_abcd2222000000000000000000000002';
      db.prepare(
        "INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, current_generation, title, status) VALUES (?, ?, ?, 'lark', ?, 'a', 'p', 'dsh_a', 'container', 1, 'Doc Analysis', 'active')"
      ).run(idA, userId, space1Id, accountId);
      db.prepare(
        "INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, current_generation, title, status) VALUES (?, ?, ?, 'lark', ?, 'b', 'p', 'dsh_b', 'container', 1, 'Code Review', 'active')"
      ).run(idB, userId, space1Id, accountId);

      // Using colliding prefix 'abcd' returns ambiguous error
      const ambigRes = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/session use abcd',
        channelContext: { channel: 'lark', accountId, chatId: chatContextId, chatType: 'p2p' },
      });
      expect(ambigRes.replyText).toContain('存在歧义');

      // Using unique extended short ID 'abcd1' succeeds
      const useShortRes = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/session use abcd1',
        channelContext: { channel: 'lark', accountId, chatId: chatContextId, chatType: 'p2p' },
      });
      expect(useShortRes.replyText).toContain('已固定到会话: abcd1 (Doc Analysis)');

      let binding = db.prepare('SELECT session_route_id FROM channel_bindings WHERE id = ?').get('cb_test_01') as any;
      expect(binding.session_route_id).toBe(idA);

      // Using title 'Code Review' succeeds
      const useTitleRes = await chatCommandService.execute({
        userId,
        sessionId: mainSession1Id,
        spaceId: space1Id,
        content: '/session use Code Review',
        channelContext: { channel: 'lark', accountId, chatId: chatContextId, chatType: 'p2p' },
      });
      expect(useTitleRes.replyText).toContain('已固定到会话: abcd2 (Code Review)');

      binding = db.prepare('SELECT session_route_id FROM channel_bindings WHERE id = ?').get('cb_test_01') as any;
      expect(binding.session_route_id).toBe(idB);
    });
  });
});
