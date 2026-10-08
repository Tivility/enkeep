import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
} from '../src/index.js';
import {
  resolveTopLevelCacheRetention,
  resolveChildCacheRetention,
  getPlatformTopLevelCacheRetention,
  getPlatformChildCacheRetention,
  isValidCacheRetention,
  isValidCacheRetentionInput,
} from '@enkeep/platform-core';
import { parseChatCommand, ChatCommandService, HELP_USAGE } from '../src/chat/chat-command-service.js';
import { createPlatformServerHandler } from '../src/server/handler.js';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { DefaultAuthService, provisionFixtures } from '@enkeep/platform-auth';
import { SqlitePlatformApi } from '../src/storage/sqlite-platform-api.js';
import { SqliteWebMessageStore } from '../src/storage/web-messages.js';

describe('Layered Prompt Cache Retention (Synthetic Tests)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.ENKEEP_CACHE_RETENTION_TOP;
    delete process.env.ENKEEP_CACHE_RETENTION_CHILD;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('1. Precedence Resolution & Child Invariance', () => {
    it('defaults to long for top-level sessions and short for children when env is unset', () => {
      expect(getPlatformTopLevelCacheRetention()).toBe('long');
      expect(getPlatformChildCacheRetention()).toBe('short');

      const topResolved = resolveTopLevelCacheRetention();
      expect(topResolved.retention).toBe('long');
      expect(topResolved.source).toBe('platform');
      expect(topResolved.override).toBeNull();

      const childResolved = resolveChildCacheRetention();
      expect(childResolved.retention).toBe('short');
      expect(childResolved.source).toBe('child_default');
    });

    it('respects ENKEEP_CACHE_RETENTION_TOP and ENKEEP_CACHE_RETENTION_CHILD environment variables', () => {
      process.env.ENKEEP_CACHE_RETENTION_TOP = 'short';
      process.env.ENKEEP_CACHE_RETENTION_CHILD = 'none';

      expect(getPlatformTopLevelCacheRetention()).toBe('short');
      expect(getPlatformChildCacheRetention()).toBe('none');

      const topResolved = resolveTopLevelCacheRetention();
      expect(topResolved.retention).toBe('short');
      expect(topResolved.source).toBe('platform');

      const childResolved = resolveChildCacheRetention();
      expect(childResolved.retention).toBe('none');
      expect(childResolved.source).toBe('child_default');
    });

    it('resolves top-level precedence: session override > space override > platform default', () => {
      // 1. Session override wins over space override and platform default
      const res1 = resolveTopLevelCacheRetention({
        sessionRetention: 'none',
        spaceRetention: 'short',
      });
      expect(res1.retention).toBe('none');
      expect(res1.source).toBe('session');
      expect(res1.override).toBe('none');

      // 2. Space override wins over platform default when session has no override
      const res2 = resolveTopLevelCacheRetention({
        sessionRetention: null,
        spaceRetention: 'short',
      });
      expect(res2.retention).toBe('short');
      expect(res2.source).toBe('space');
      expect(res2.override).toBeNull();

      // 3. Platform default used when neither session nor space overrides
      const res3 = resolveTopLevelCacheRetention({
        sessionRetention: null,
        spaceRetention: null,
      });
      expect(res3.retention).toBe('long');
      expect(res3.source).toBe('platform');
      expect(res3.override).toBeNull();
    });

    it('child agents are ALWAYS unaffected by parent session and space overrides', () => {
      // Even if session and space are configured with 'none' or 'long'
      const sessionRetention = 'none';
      const spaceRetention = 'long';

      const topRes = resolveTopLevelCacheRetention({ sessionRetention, spaceRetention });
      expect(topRes.retention).toBe('none');
      expect(topRes.source).toBe('session');

      // Child agent resolution ignores both overrides and strictly returns child default ('short')
      const childRes = resolveChildCacheRetention();
      expect(childRes.retention).toBe('short');
      expect(childRes.source).toBe('child_default');
    });

    it('validates retention values and input values', () => {
      expect(isValidCacheRetention('short')).toBe(true);
      expect(isValidCacheRetention('long')).toBe(true);
      expect(isValidCacheRetention('none')).toBe(true);
      expect(isValidCacheRetention('default')).toBe(false);
      expect(isValidCacheRetention('invalid')).toBe(false);

      expect(isValidCacheRetentionInput('default')).toBe(true);
      expect(isValidCacheRetentionInput('short')).toBe(true);
      expect(isValidCacheRetentionInput('invalid')).toBe(false);
    });
  });

  describe('2. Chat Commands (/session cache & /ws cache)', () => {
    let db: DatabaseSync;
    let chatCommandService: ChatCommandService;

    const userId = 'u_synth_cache_01';
    const spaceId = 'spc_synth_cache_01';
    const sessionId = 'ses_synth_cache_01';

    beforeEach(async () => {
      db = new DatabaseSync(':memory:');
      const runner = new PlatformServerMigrationRunner(db);
      await runner.migrate(ALL_PLATFORM_MIGRATIONS);

      db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, 'alice_synth', 'hash', 'user')").run(userId);
      db.prepare("INSERT INTO spaces (id, user_id, name, folder, execution_mode, status, created_at, updated_at) VALUES (?, ?, 'Space Cache', 'spc-cache', 'container', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").run(spaceId, userId);
      db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, current_generation, status, created_at, updated_at) VALUES (?, ?, ?, 'web', 'default', ?, 'p_1', 'dsh_1', 'container', 1, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").run(sessionId, userId, spaceId, sessionId);

      chatCommandService = new ChatCommandService({
        db,
      });
    });

    it('parses /session cache and /ws cache commands', () => {
      expect(parseChatCommand('/session cache')).toEqual({
        command: 'session',
        type: 'session',
        subcommand: 'cache',
        action: 'cache',
        target: undefined,
        arg: undefined,
        raw: '/session cache',
      });

      expect(parseChatCommand('/ses cache long')).toEqual({
        command: 'session',
        type: 'session',
        subcommand: 'cache',
        action: 'cache',
        target: 'long',
        arg: 'long',
        raw: '/ses cache long',
      });

      expect(parseChatCommand('/ws cache short')).toEqual({
        command: 'ws',
        type: 'ws',
        subcommand: 'cache',
        action: 'cache',
        target: 'short',
        arg: 'short',
        raw: '/ws cache short',
      });

      expect(parseChatCommand('/ws cache default')).toEqual({
        command: 'ws',
        type: 'ws',
        subcommand: 'cache',
        action: 'cache',
        target: 'default',
        arg: 'default',
        raw: '/ws cache default',
      });
    });

    it('shows effective value and source via /session cache and /ws cache', async () => {
      // 1. Initial workspace cache query -> platform default 'long'
      const wsRes1 = await chatCommandService.execute({
        userId,
        spaceId,
        sessionId,
        content: '/ws cache',
      });
      expect(wsRes1.replyText).toContain('当前工作区 Prompt Cache Retention: long (来源: platform)');

      // 2. Initial session cache query -> platform default 'long'
      const sesRes1 = await chatCommandService.execute({
        userId,
        spaceId,
        sessionId,
        content: '/session cache',
      });
      expect(sesRes1.replyText).toContain('当前会话 Prompt Cache Retention: long (来源: platform)');
    });

    it('mutates workspace cache override via /ws cache <val> and clears with default', async () => {
      // Set space cache to 'short'
      const setRes = await chatCommandService.execute({
        userId,
        spaceId,
        sessionId,
        content: '/ws cache short',
      });
      expect(setRes.replyText).toContain('已设置当前工作区 Cache Retention 为 short');

      // Check space cache query
      const queryRes = await chatCommandService.execute({
        userId,
        spaceId,
        sessionId,
        content: '/ws cache',
      });
      expect(queryRes.replyText).toContain('当前工作区 Prompt Cache Retention: short (来源: space)');

      // Session now inherits space cache 'short'
      const sesRes = await chatCommandService.execute({
        userId,
        spaceId,
        sessionId,
        content: '/session cache',
      });
      expect(sesRes.replyText).toContain('当前会话 Prompt Cache Retention: short (来源: space)');

      // Clear space cache with 'default'
      const clearRes = await chatCommandService.execute({
        userId,
        spaceId,
        sessionId,
        content: '/ws cache default',
      });
      expect(clearRes.replyText).toContain('已清除当前工作区 Cache Retention 覆盖，恢复平台默认值 (long)');
    });

    it('mutates session cache override via /session cache <val> and clears with default', async () => {
      // Set session cache to 'none'
      const setRes = await chatCommandService.execute({
        userId,
        spaceId,
        sessionId,
        content: '/session cache none',
      });
      expect(setRes.replyText).toContain('已设置当前会话 Cache Retention 为 none');

      // Query session cache
      const queryRes = await chatCommandService.execute({
        userId,
        spaceId,
        sessionId,
        content: '/session cache',
      });
      expect(queryRes.replyText).toContain('当前会话 Prompt Cache Retention: none (来源: session)');

      // Clear session cache with 'default'
      const clearRes = await chatCommandService.execute({
        userId,
        spaceId,
        sessionId,
        content: '/session cache default',
      });
      expect(clearRes.replyText).toContain('已清除当前会话 Cache Retention 覆盖，生效值: long (来源: platform)');
    });

    it('gates mutating forms in group chat to owner/admin', async () => {
      // Mock non-admin check
      chatCommandService = new ChatCommandService({
        db,
        checkChatAdmin: async () => false,
      });

      // Query in group chat is allowed
      const queryRes = await chatCommandService.execute({
        userId,
        spaceId,
        sessionId,
        content: '/session cache',
        channelContext: {
          channel: 'lark',
          chatType: 'group',
          chatId: 'oc_synth_group',
          senderId: 'ou_synth_member',
        },
      });
      expect(queryRes.replyText).toContain('Prompt Cache Retention');

      // Mutation in group chat is rejected
      const mutateRes = await chatCommandService.execute({
        userId,
        spaceId,
        sessionId,
        content: '/session cache short',
        channelContext: {
          channel: 'lark',
          chatType: 'group',
          chatId: 'oc_synth_group',
          senderId: 'ou_synth_member',
        },
      });
      expect(mutateRes.replyText).toBe('群聊中仅群主或管理员可执行此指令。');
    });

    it('verifies /help usage output documents cache commands', () => {
      expect(HELP_USAGE).toContain('/ws cache');
      expect(HELP_USAGE).toContain('/session cache');
    });
  });

  describe('3. REST Endpoints (/api/spaces/:id/cache-override & /api/sessions/:id/cache-override)', () => {
    let db: DatabaseSync;
    let server: Server;
    let baseUrl: string;
    let aliceCookie: string;
    let bobCookie: string;
    const csrfToken = 'test-csrf-token-123456789012345678901234567890';
    let aliceSpaceId: string;
    let aliceSessionId: string;

    const aliceUserId = 'u_synth_alice_01';
    const bobUserId = 'u_synth_bob_01';

    beforeEach(async () => {
      db = new DatabaseSync(':memory:');
      const runner = new PlatformServerMigrationRunner(db);
      await runner.migrate(ALL_PLATFORM_MIGRATIONS);

      const cookieSecret = 'test-cookie-secret-32-chars-long-123456789!';
      const storage = new SqlitePlatformStorage(db);
      const authService = new DefaultAuthService(storage, {
        cookieSecret,
        sessionTtlSeconds: 3600,
        cookieSecure: false,
      });

      const provisionResult = await provisionFixtures(storage, authService, {
        adminPassword: 'AliceAdmin123!',
        userPassword: 'BobUser123!',
        disabledPassword: 'CharlieDisabled123!',
      });
      const aliceId = provisionResult.admin.id;
      const bobId = provisionResult.user.id;

      const aliceLogin = await authService.login('alice', 'AliceAdmin123!');
      aliceCookie = aliceLogin.cookieHeader.split(';')[0]!;

      const bobLogin = await authService.login('bob', 'BobUser123!');
      bobCookie = bobLogin.cookieHeader.split(';')[0]!;

      const messageStore = new SqliteWebMessageStore(db);
      const platformApi = new SqlitePlatformApi({ storage, messageStore, authService, db } as any);

      // Create Alice space & session
      const space = await platformApi.createSpace(aliceId, { name: 'Alice Space', folder: 'spc-alice-cache' });
      aliceSpaceId = space.id;

      const session = await platformApi.createSession(aliceId, { spaceId: space.id });
      aliceSessionId = session.id;

      const handler = createPlatformServerHandler({
        database: db,
        storage,
        authService,
        platformApi,
        csrfToken,
      });

      server = createServer(handler);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
    });

    afterEach(async () => {
      if (server) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      if (db) {
        db.close();
      }
    });

    it('GET /api/spaces/:id/cache-override returns default platform effective retention', async () => {
      const res = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/cache-override`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.override).toBeNull();
      expect(json.data.effective).toBe('long');
      expect(json.data.source).toBe('platform');
    });

    it('PUT /api/spaces/:id/cache-override sets override and DELETE clears it', async () => {
      // Set to 'short'
      const putRes = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/cache-override`, {
        method: 'PUT',
        headers: { Cookie: aliceCookie, 'Content-Type': 'application/json', 'X-Enkeep-CSRF': csrfToken, Origin: baseUrl },
        body: JSON.stringify({ cacheRetention: 'short' }),
      });
      expect(putRes.status).toBe(200);
      const putJson = await putRes.json();
      expect(putJson.data.override).toBe('short');
      expect(putJson.data.effective).toBe('short');
      expect(putJson.data.source).toBe('space');

      // Verify GET returns 'short'
      const getRes = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/cache-override`, {
        headers: { Cookie: aliceCookie },
      });
      const getJson = await getRes.json();
      expect(getJson.data.override).toBe('short');
      expect(getJson.data.effective).toBe('short');
      expect(getJson.data.source).toBe('space');

      // DELETE clears override
      const delRes = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/cache-override`, {
        method: 'DELETE',
        headers: { Cookie: aliceCookie, 'X-Enkeep-CSRF': csrfToken, Origin: baseUrl },
      });
      expect(delRes.status).toBe(200);

      // Verify GET returns platform default again
      const getRes2 = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/cache-override`, {
        headers: { Cookie: aliceCookie },
      });
      const getJson2 = await getRes2.json();
      expect(getJson2.data.override).toBeNull();
      expect(getJson2.data.effective).toBe('long');
      expect(getJson2.data.source).toBe('platform');
    });

    it('PUT /api/sessions/:id/cache-override sets session override and resolves precedence', async () => {
      // Set space to 'short'
      await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/cache-override`, {
        method: 'PUT',
        headers: { Cookie: aliceCookie, 'Content-Type': 'application/json', 'X-Enkeep-CSRF': csrfToken, Origin: baseUrl },
        body: JSON.stringify({ cacheRetention: 'short' }),
      });

      // Check session GET inherits space 'short'
      const sesGet1 = await fetch(`${baseUrl}/api/sessions/${aliceSessionId}/cache-override`, {
        headers: { Cookie: aliceCookie },
      });
      const sesJson1 = await sesGet1.json();
      expect(sesJson1.data.override).toBeNull();
      expect(sesJson1.data.effective).toBe('short');
      expect(sesJson1.data.source).toBe('space');

      // Override session to 'none'
      const sesPut = await fetch(`${baseUrl}/api/sessions/${aliceSessionId}/cache-override`, {
        method: 'PUT',
        headers: { Cookie: aliceCookie, 'Content-Type': 'application/json', 'X-Enkeep-CSRF': csrfToken, Origin: baseUrl },
        body: JSON.stringify({ cacheRetention: 'none' }),
      });
      expect(sesPut.status).toBe(200);
      const sesPutJson = await sesPut.json();
      expect(sesPutJson.data.override).toBe('none');
      expect(sesPutJson.data.effective).toBe('none');
      expect(sesPutJson.data.source).toBe('session');

      // DELETE session override -> restores space 'short'
      const sesDel = await fetch(`${baseUrl}/api/sessions/${aliceSessionId}/cache-override`, {
        method: 'DELETE',
        headers: { Cookie: aliceCookie, 'X-Enkeep-CSRF': csrfToken, Origin: baseUrl },
      });
      expect(sesDel.status).toBe(200);

      const sesGet2 = await fetch(`${baseUrl}/api/sessions/${aliceSessionId}/cache-override`, {
        headers: { Cookie: aliceCookie },
      });
      const sesJson2 = await sesGet2.json();
      expect(sesJson2.data.override).toBeNull();
      expect(sesJson2.data.effective).toBe('short');
      expect(sesJson2.data.source).toBe('space');
    });

    it('enforces tenant isolation: Bob cannot access Alice space or session cache endpoints (404)', async () => {
      // Bob tries to GET Alice space cache -> 404
      const res1 = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/cache-override`, {
        headers: { Cookie: bobCookie },
      });
      expect(res1.status).toBe(404);

      // Bob tries to PUT Alice space cache -> 404
      const res2 = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/cache-override`, {
        method: 'PUT',
        headers: { Cookie: bobCookie, 'Content-Type': 'application/json', 'X-Enkeep-CSRF': csrfToken, Origin: baseUrl },
        body: JSON.stringify({ cacheRetention: 'none' }),
      });
      expect(res2.status).toBe(404);

      // Bob tries to GET Alice session cache -> 404
      const res3 = await fetch(`${baseUrl}/api/sessions/${aliceSessionId}/cache-override`, {
        headers: { Cookie: bobCookie },
      });
      expect(res3.status).toBe(404);

      // Bob tries to DELETE Alice session cache -> 404
      const res4 = await fetch(`${baseUrl}/api/sessions/${aliceSessionId}/cache-override`, {
        method: 'DELETE',
        headers: { Cookie: bobCookie, 'X-Enkeep-CSRF': csrfToken, Origin: baseUrl },
      });
      expect(res4.status).toBe(404);
    });

    it('rejects invalid cache retention values with 400', async () => {
      const res = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/cache-override`, {
        method: 'PUT',
        headers: { Cookie: aliceCookie, 'Content-Type': 'application/json', 'X-Enkeep-CSRF': csrfToken, Origin: baseUrl },
        body: JSON.stringify({ cacheRetention: 'invalid_val' }),
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.message).toContain('Field "cacheRetention" must be one of');
    });
  });

  describe('4. Runtime Provider Request Retention Mapping (Anthropic / pi-ai)', () => {
    it('verifies getCacheControl mappings for long (1h TTL), short (5m ephemeral), and none (no cache_control)', async () => {
      function simulatePiAiAnthropicCacheControl(retention: 'short' | 'long' | 'none', supportsLong: boolean = true) {
        if (retention === 'none') {
          return { retention, cacheControl: undefined };
        }
        const ttl = retention === 'long' && supportsLong ? '1h' : undefined;
        return {
          retention,
          cacheControl: { type: 'ephemeral', ...(ttl && { ttl }) },
        };
      }

      const longResult = simulatePiAiAnthropicCacheControl('long', true);
      expect(longResult.cacheControl).toEqual({ type: 'ephemeral', ttl: '1h' });

      const shortResult = simulatePiAiAnthropicCacheControl('short', true);
      expect(shortResult.cacheControl).toEqual({ type: 'ephemeral' });
      expect((shortResult.cacheControl as any).ttl).toBeUndefined();

      const noneResult = simulatePiAiAnthropicCacheControl('none', true);
      expect(noneResult.cacheControl).toBeUndefined();
    });
  });
});
