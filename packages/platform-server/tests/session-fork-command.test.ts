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
  HELP_USAGE,
  SESSION_USAGE,
  parseChatCommand,
} from '../src/chat/chat-command-service.js';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { resolveInboundRoute } from '@enkeep/platform-core';
import type { RawDshModelConfig } from '../src/config/dsh-model-config.js';

describe('/session fork chat command', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let modelSelectionService: ModelSelectionService;
  let chatCommandService: ChatCommandService;
  let forkCalls: Array<{ userId: string; sessionId: string; options: any }>;
  let forkImpl: (userId: string, sessionId: string, options?: any) => Promise<{ id: string; title?: string | null }>;
  let forkCounter: number;

  const userId = 'usr_synth_fork_owner_01';
  const space1Id = 'spc_00000000000000000000000000000001';
  const space2Id = 'spc_00000000000000000000000000000002';
  const mainSession1Id = 'ses_00010000000000000000000000000001';
  const mainSession2Id = 'ses_00020000000000000000000000000001';
  const auxSessionId = 'ses_aaaa0000000000000000000000000001';
  const accountId = 'ca_test_lark_acc_01';
  const groupChatId = 'oc_test_group_synth_001';
  const topicAContext = `${groupChatId}:omt_test_topic_a`;
  const topicBContext = `${groupChatId}:omt_test_topic_b`;
  const adminSenderId = 'ou_admin_member_01';
  const regularSenderId = 'ou_regular_member_02';
  const validIdempotencyKey = '11111111-2222-4333-8444-555555555555';

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

  function insertRoute(id: string, spaceId: string, channel: string, nativeContextId: string, title: string): void {
    db.prepare(
      "INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, current_generation, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'container', 1, ?, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')"
    ).run(id, userId, spaceId, channel, channel === 'web' ? 'default' : accountId, nativeContextId, `peer_${id}`, `dsh_${id}`, title);
  }

  function bindingFor(nativeContextId: string): { session_route_id: string | null; space_id: string; activation_mode: string } | undefined {
    return db.prepare(
      'SELECT session_route_id, space_id, activation_mode FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?'
    ).get(userId, accountId, nativeContextId) as any;
  }

  function larkContext(nativeContextId: string, senderId = adminSenderId) {
    return {
      channel: 'lark',
      accountId,
      chatId: groupChatId,
      nativeContextId,
      senderId,
      chatType: 'group',
    };
  }

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, 'user_alice', 'hash', 'admin')").run(userId);
    db.prepare(
      "INSERT INTO spaces (id, user_id, name, folder, execution_mode, canonical_session_id, status, created_at, updated_at) VALUES (?, ?, 'Alpha Space', 'folder-alpha', 'container', NULL, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')"
    ).run(space1Id, userId);
    db.prepare(
      "INSERT INTO spaces (id, user_id, name, folder, execution_mode, canonical_session_id, status, created_at, updated_at) VALUES (?, ?, 'Beta Space', 'folder-beta', 'container', NULL, 'active', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')"
    ).run(space2Id, userId);

    insertRoute(mainSession1Id, space1Id, 'lark', 'other_group_ctx', 'Main Session Alpha');
    insertRoute(mainSession2Id, space2Id, 'lark', 'beta_ctx', 'Main Session Beta');
    insertRoute(auxSessionId, space1Id, 'lark', 'aux_ctx', 'Aux Session');
    db.prepare('UPDATE spaces SET canonical_session_id = ? WHERE id = ?').run(mainSession1Id, space1Id);
    db.prepare('UPDATE spaces SET canonical_session_id = ? WHERE id = ?').run(mainSession2Id, space2Id);

    db.prepare(
      "INSERT INTO channel_accounts (id, user_id, type, default_space_id, status) VALUES (?, ?, 'lark', ?, 'active')"
    ).run(accountId, userId, space1Id);
    db.prepare(
      "INSERT INTO channel_bindings (id, user_id, account_id, space_id, native_context_id, activation_mode, chat_type, session_route_id) VALUES ('cb_test_grp', ?, ?, ?, ?, 'always', 'group', NULL)"
    ).run(userId, accountId, space1Id, groupChatId);

    storage = new SqlitePlatformStorage(db);
    modelSelectionService = new ModelSelectionService({ db });
    vi.spyOn(modelSelectionService, 'getDshCatalog').mockReturnValue(stubCatalog);

    forkCalls = [];
    forkCounter = 0;
    forkImpl = async (_userId, sessionId, options) => {
      forkCounter += 1;
      const id = `ses_f0${String(forkCounter).padStart(2, '0')}0000000000000000000000000001`;
      const source = db.prepare('SELECT space_id, title FROM session_routes WHERE id = ?').get(sessionId) as { space_id: string; title: string | null };
      const title = options?.title ?? `${source.title || 'Session'} (Fork)`;
      insertRoute(id, options?.targetSpaceId ?? source.space_id, 'web', id, title);
      return { id, title };
    };

    chatCommandService = new ChatCommandService({
      modelSelectionService,
      db,
      isDockerAvailable: () => true,
      checkChatAdmin: async ({ senderId }) => senderId === adminSenderId,
      platformApi: {
        resetSession: async () => ({ generation: { generation: 2 } }),
        forkSession: async (uid, sid, options) => {
          forkCalls.push({ userId: uid, sessionId: sid, options });
          return forkImpl(uid, sid, options);
        },
      },
    });
  });

  describe('parser', () => {
    it('parses source and multi-word title', () => {
      const parsed = parseChatCommand('/session fork aaaa New Topic Title');
      expect(parsed?.command).toBe('session');
      expect(parsed?.subcommand).toBe('fork');
      expect(parsed?.target).toBe('aaaa');
      expect(parsed?.title).toBe('New Topic Title');
    });

    it('parses bare fork with no source and the /ses alias', () => {
      const bare = parseChatCommand('/session fork');
      expect(bare?.subcommand).toBe('fork');
      expect(bare?.target).toBeUndefined();
      expect(bare?.title).toBeUndefined();

      const alias = parseChatCommand('/ses fork main');
      expect(alias?.subcommand).toBe('fork');
      expect(alias?.target).toBe('main');
    });

    it('is documented in help and session usage', () => {
      expect(HELP_USAGE).toContain('/session fork');
      expect(SESSION_USAGE).toContain('/session fork');
    });
  });

  it('forks an explicit source from a topic and pins only that topic', async () => {
    const result = await chatCommandService.execute({
      userId,
      sessionId: mainSession1Id,
      spaceId: space1Id,
      content: `/session fork ${auxSessionId} Topic A Draft`,
      idempotencyKey: validIdempotencyKey,
      channelContext: larkContext(topicAContext),
    });

    expect(result.replyText).toContain('已分叉并固定:');
    expect(result.replyText).toContain('Topic A Draft');
    expect(forkCalls).toHaveLength(1);
    expect(forkCalls[0].sessionId).toBe(auxSessionId);
    expect(forkCalls[0].options).toEqual({ title: 'Topic A Draft', targetSpaceId: space1Id, idempotencyKey: validIdempotencyKey });

    const forkedId = 'ses_f0010000000000000000000000000001';
    const topicA = bindingFor(topicAContext);
    expect(topicA?.session_route_id).toBe(forkedId);
    expect(topicA?.space_id).toBe(space1Id);
    expect(topicA?.activation_mode).toBe('always');

    expect(bindingFor(groupChatId)?.session_route_id).toBeNull();
    expect(bindingFor(topicBContext)).toBeUndefined();

    const channelRepo = storage.forTenant(userId).channels;
    const sessionRepo = storage.forTenant(userId).sessionRoutes;
    const resolveFor = async (ctx: string) => resolveInboundRoute({
      userId,
      binding: (await channelRepo.findBindingByContext(accountId, groupChatId))!,
      topicBinding: await channelRepo.findBindingByContext(accountId, ctx),
      sessionRouteRepo: sessionRepo,
      channelRepo,
      canonicalOptions: {
        channel: 'lark',
        accountId,
        nativeContextId: ctx,
        fallbackNativeContextId: groupChatId,
      },
    });
    const resA = await resolveFor(topicAContext);
    expect(resA.pinned).toBe(true);
    expect((resA.route as any).id).toBe(forkedId);
    const resB = await resolveFor(topicBContext);
    expect((resB.route as any).id).toBe(mainSession1Id);

    // Source session untouched
    const source = db.prepare('SELECT status, title FROM session_routes WHERE id = ?').get(auxSessionId) as { status: string; title: string };
    expect(source).toEqual({ status: 'active', title: 'Aux Session' });
  });

  it('resolves "main" to the workspace canonical session', async () => {
    const result = await chatCommandService.execute({
      userId,
      sessionId: auxSessionId,
      spaceId: space1Id,
      content: '/session fork main',
      channelContext: larkContext(topicAContext),
    });
    expect(result.replyText).toContain('已分叉并固定:');
    expect(forkCalls[0].sessionId).toBe(mainSession1Id);
    expect(forkCalls[0].options.title).toBeUndefined();
    expect(result.replyText).toContain('Main Session Alpha (Fork)');
  });

  it('defaults to the current session and pins at chat level outside a topic', async () => {
    const result = await chatCommandService.execute({
      userId,
      sessionId: mainSession1Id,
      spaceId: space1Id,
      content: '/session fork',
      channelContext: larkContext(groupChatId),
    });
    expect(result.replyText).toContain('已分叉并固定:');
    expect(forkCalls[0].sessionId).toBe(mainSession1Id);
    expect(bindingFor(groupChatId)?.session_route_id).toBe('ses_f0010000000000000000000000000001');
  });

  it('only searches the bound workspace for the source', async () => {
    const result = await chatCommandService.execute({
      userId,
      sessionId: mainSession1Id,
      spaceId: space1Id,
      content: `/session fork ${mainSession2Id}`,
      channelContext: larkContext(topicAContext),
    });
    expect(result.replyText).toContain('未找到会话');
    expect(forkCalls).toHaveLength(0);
    expect(bindingFor(topicAContext)).toBeUndefined();
  });

  it('rejects non-admin members in group chats without forking', async () => {
    const result = await chatCommandService.execute({
      userId,
      sessionId: mainSession1Id,
      spaceId: space1Id,
      content: '/session fork main',
      channelContext: larkContext(topicAContext, regularSenderId),
    });
    expect(result.replyText).toBe('群聊中仅群主或管理员可执行此指令。');
    expect(forkCalls).toHaveLength(0);
    expect(bindingFor(topicAContext)).toBeUndefined();
  });

  it('reports an active source turn and writes no binding', async () => {
    forkImpl = async () => {
      throw Object.assign(new Error('Cannot fork session while a turn is active'), { code: 'TURN_ACTIVE' });
    };
    const result = await chatCommandService.execute({
      userId,
      sessionId: mainSession1Id,
      spaceId: space1Id,
      content: '/session fork main',
      channelContext: larkContext(topicAContext),
    });
    expect(result.replyText).toBe('源会话正在执行，结束后再 fork。');
    expect(bindingFor(topicAContext)).toBeUndefined();
  });

  it('reports other fork failures and writes no binding', async () => {
    forkImpl = async () => {
      throw Object.assign(new Error('Runtime fork export failed'), { code: 'RUNTIME_EXPORT_FAILED' });
    };
    const result = await chatCommandService.execute({
      userId,
      sessionId: mainSession1Id,
      spaceId: space1Id,
      content: '/session fork main',
      channelContext: larkContext(topicAContext),
    });
    expect(result.replyText).toContain('分叉会话失败: Runtime fork export failed');
    expect(bindingFor(topicAContext)).toBeUndefined();
  });

  it('replaces a non-UUID idempotency key with a fresh UUID v4', async () => {
    await chatCommandService.execute({
      userId,
      sessionId: mainSession1Id,
      spaceId: space1Id,
      content: '/session fork main',
      idempotencyKey: 'lark:not-a-uuid',
      channelContext: larkContext(topicAContext),
    });
    expect(forkCalls[0].options.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('explains when the platform fork service is not wired', async () => {
    const bare = new ChatCommandService({
      modelSelectionService,
      db,
      isDockerAvailable: () => true,
      checkChatAdmin: async () => true,
    });
    const result = await bare.execute({
      userId,
      sessionId: mainSession1Id,
      spaceId: space1Id,
      content: '/session fork main',
      channelContext: larkContext(topicAContext),
    });
    expect(result.replyText).toBe('平台服务未连接，无法分叉会话。');
  });

  it('receives forkSession through DeliveryRuntimeGateway.setChatCommandDeps', async () => {
    const gateway = new DeliveryRuntimeGateway({
      storage,
      database: db,
      messageStore: new SqliteWebMessageStore(db),
      quotaMode: 'disabled',
      modelSelectionService,
      profileResolver: { resolve: async () => null },
      executor: { execute: async () => ({ replyText: 'runtime', usage: { totalTokens: 10 } }), cancel: async () => true },
      checkChatAdmin: async () => true,
    } as any);
    const forkSpy = vi.fn(forkImpl);
    gateway.setChatCommandDeps({ forkSession: forkSpy });
    const service = (gateway as any).chatCommandService as ChatCommandService;
    const result = await service.execute({
      userId,
      sessionId: mainSession1Id,
      spaceId: space1Id,
      content: '/session fork main',
      channelContext: larkContext(topicAContext),
    });
    expect(forkSpy).toHaveBeenCalledTimes(1);
    expect(result.replyText).toContain('已分叉并固定:');
  });
});
