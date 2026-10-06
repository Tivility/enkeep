import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import type { InboundEnvelope } from '@enkeep/web-channel';
import {
  DeliveryRuntimeGateway,
  SqliteWebMessageStore,
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
} from '../src/index.js';
import { ModelSelectionService } from '../src/models/model-selection-service.js';
import { ChatCommandService } from '../src/chat/chat-command-service.js';

describe('ChatCommandService /bind, /unbind, /newws Channel Context Resolution (Synthetic)', () => {
  let db: DatabaseSync;
  let chatCommandService: ChatCommandService;

  const userId = 'usr_synth_alice_01';
  const defaultSpaceId = 'spc_synth_default_01';
  const targetSpaceId = 'spc_synth_target_02';
  const otherSpaceId = 'spc_synth_other_03';

  const account1Id = 'acc_synth_lark_01';
  const account2Id = 'acc_synth_lark_02';

  const oldChatContextId = 'oc_synth_old_chat_01';
  const inboundChatContextId = 'oc_synth_new_chat_02';

  const canonicalSessionId = 'ses_synth_canonical_01';
  const webSessionId = 'ses_synth_web_01';

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, 'alice_synth', 'hash', 'user')").run(userId);

    // Create spaces
    db.prepare("INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES (?, ?, 'Default Space', 'space-default-folder', 'container')").run(defaultSpaceId, userId);
    db.prepare("INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES (?, ?, 'Target Workspace', 'space-Target-Folder', 'host')").run(targetSpaceId, userId);
    db.prepare("INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES (?, ?, 'Other Workspace', 'space-other-folder', 'container')").run(otherSpaceId, userId);

    // Create channel accounts with default space
    db.prepare("INSERT INTO channel_accounts (id, user_id, type, default_space_id, status) VALUES (?, ?, 'lark', ?, 'active')").run(account1Id, userId, defaultSpaceId);
    db.prepare("INSERT INTO channel_accounts (id, user_id, type, default_space_id, status) VALUES (?, ?, 'lark', ?, 'active')").run(account2Id, userId, defaultSpaceId);

    // Shared canonical session route initially created by Account 1 / Old Chat
    db.prepare(`
      INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, current_generation)
      VALUES (?, ?, ?, 'lark', ?, ?, 'p_lark_old', 'dsh_canonical', 'container', 1)
    `).run(canonicalSessionId, userId, defaultSpaceId, account1Id, oldChatContextId);

    // Binding for old chat
    db.prepare(`
      INSERT INTO channel_bindings (id, user_id, account_id, space_id, native_context_id, activation_mode)
      VALUES ('cb_synth_old', ?, ?, ?, ?, 'mention')
    `).run(userId, account1Id, defaultSpaceId, oldChatContextId);

    // Web session route
    db.prepare(`
      INSERT INTO session_routes (id, user_id, space_id, channel, peer_id, dsh_session_id, execution_mode, current_generation)
      VALUES (?, ?, ?, 'web', 'p_web', 'dsh_web', 'container', 1)
    `).run(webSessionId, userId, defaultSpaceId);

    const modelSelectionService = new ModelSelectionService({ db });
    chatCommandService = new ChatCommandService({
      modelSelectionService,
      db,
    });
  });

  describe('1. Chat whose current session route was created by different account/context', () => {
    it('/bind updates binding for INBOUND chat context only, leaves session_routes unchanged, leaves other accounts untouched', async () => {
      // Chat 2 (account2Id, inboundChatContextId) arrives on canonical session created by Chat 1
      const result = await chatCommandService.execute({
        userId,
        sessionId: canonicalSessionId,
        spaceId: defaultSpaceId,
        content: `/bind ${targetSpaceId}`,
        channelContext: {
          channel: 'lark',
          accountId: account2Id,
          nativeContextId: inboundChatContextId,
          chatId: inboundChatContextId,
        },
      });

      expect(result.replyText).toBe('已绑定到工作区: Target Workspace。之后本聊天的消息会进入该工作区的会话。');

      // 1. Inbound chat binding created/updated to target space
      const inboundBinding = db
        .prepare('SELECT space_id FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?')
        .get(userId, account2Id, inboundChatContextId) as { space_id: string } | undefined;
      expect(inboundBinding).toBeDefined();
      expect(inboundBinding?.space_id).toBe(targetSpaceId);

      // 2. Canonical session route space_id is UNCHANGED (still default space, not moved)
      const routeRow = db
        .prepare('SELECT space_id, execution_mode FROM session_routes WHERE id = ?')
        .get(canonicalSessionId) as { space_id: string; execution_mode: string };
      expect(routeRow.space_id).toBe(defaultSpaceId);
      expect(routeRow.execution_mode).toBe('container');

      // 3. Other account's binding is UNTOUCHED
      const oldBinding = db
        .prepare('SELECT space_id FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?')
        .get(userId, account1Id, oldChatContextId) as { space_id: string };
      expect(oldBinding.space_id).toBe(defaultSpaceId);
    });

    it('prefers nativeContextId and falls back to chatId when nativeContextId is omitted', async () => {
      const fallbackChatId = 'oc_synth_fallback_chat_03';
      const result = await chatCommandService.execute({
        userId,
        sessionId: canonicalSessionId,
        spaceId: defaultSpaceId,
        content: `/bind ${targetSpaceId}`,
        channelContext: {
          channel: 'lark',
          accountId: account2Id,
          chatId: fallbackChatId,
        },
      });

      expect(result.replyText).toBe('已绑定到工作区: Target Workspace。之后本聊天的消息会进入该工作区的会话。');

      const binding = db
        .prepare('SELECT space_id FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?')
        .get(userId, account2Id, fallbackChatId) as { space_id: string } | undefined;
      expect(binding).toBeDefined();
      expect(binding?.space_id).toBe(targetSpaceId);
    });
  });

  describe('2. /unbind restores inbound chat binding to account default without touching routes', () => {
    it('restores default space and leaves session routes unchanged', async () => {
      // First bind inbound chat to targetSpaceId
      await chatCommandService.execute({
        userId,
        sessionId: canonicalSessionId,
        spaceId: defaultSpaceId,
        content: `/bind ${targetSpaceId}`,
        channelContext: {
          channel: 'lark',
          accountId: account2Id,
          nativeContextId: inboundChatContextId,
        },
      });

      // Verify bound
      const boundCheck = db
        .prepare('SELECT space_id FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?')
        .get(userId, account2Id, inboundChatContextId) as { space_id: string };
      expect(boundCheck.space_id).toBe(targetSpaceId);

      // Execute /unbind with inbound channelContext
      const unbindRes = await chatCommandService.execute({
        userId,
        sessionId: canonicalSessionId,
        spaceId: defaultSpaceId,
        content: '/unbind',
        channelContext: {
          channel: 'lark',
          accountId: account2Id,
          nativeContextId: inboundChatContextId,
        },
      });

      expect(unbindRes.replyText).toContain('已恢复渠道默认工作区: Default Space');

      // Specific binding is removed
      const bindingAfter = db
        .prepare('SELECT count(*) as count FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?')
        .get(userId, account2Id, inboundChatContextId) as { count: number };
      expect(bindingAfter.count).toBe(0);

      // Canonical session route row is UNCHANGED
      const routeRow = db
        .prepare('SELECT space_id FROM session_routes WHERE id = ?')
        .get(canonicalSessionId) as { space_id: string };
      expect(routeRow.space_id).toBe(defaultSpaceId);
    });
  });

  describe('3. Special targets "main" / "home" resolve to channel account default space', () => {
    it('/bind main resolves to account default space', async () => {
      const result = await chatCommandService.execute({
        userId,
        sessionId: canonicalSessionId,
        spaceId: targetSpaceId,
        content: '/bind main',
        channelContext: {
          channel: 'lark',
          accountId: account2Id,
          nativeContextId: inboundChatContextId,
        },
      });

      expect(result.replyText).toBe('已绑定到工作区: Default Space。之后本聊天的消息会进入该工作区的会话。');

      const binding = db
        .prepare('SELECT space_id FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?')
        .get(userId, account2Id, inboundChatContextId) as { space_id: string };
      expect(binding.space_id).toBe(defaultSpaceId);
    });

    it('/bind home resolves to account default space', async () => {
      const result = await chatCommandService.execute({
        userId,
        sessionId: canonicalSessionId,
        spaceId: targetSpaceId,
        content: '/bind home',
        channelContext: {
          channel: 'lark',
          accountId: account2Id,
          nativeContextId: inboundChatContextId,
        },
      });

      expect(result.replyText).toBe('已绑定到工作区: Default Space。之后本聊天的消息会进入该工作区的会话。');
    });
  });

  describe('4. Case-insensitive folder & name resolution and /list hint on not found', () => {
    it('resolves folder case-insensitively', async () => {
      // folder is "space-Target-Folder"
      const result = await chatCommandService.execute({
        userId,
        sessionId: canonicalSessionId,
        spaceId: defaultSpaceId,
        content: '/bind space-target-folder',
        channelContext: {
          channel: 'lark',
          accountId: account2Id,
          nativeContextId: inboundChatContextId,
        },
      });

      expect(result.replyText).toBe('已绑定到工作区: Target Workspace。之后本聊天的消息会进入该工作区的会话。');

      const binding = db
        .prepare('SELECT space_id FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?')
        .get(userId, account2Id, inboundChatContextId) as { space_id: string };
      expect(binding.space_id).toBe(targetSpaceId);
    });

    it('resolves name case-insensitively', async () => {
      // name is "Target Workspace"
      const result = await chatCommandService.execute({
        userId,
        sessionId: canonicalSessionId,
        spaceId: defaultSpaceId,
        content: '/bind target workspace',
        channelContext: {
          channel: 'lark',
          accountId: account2Id,
          nativeContextId: inboundChatContextId,
        },
      });

      expect(result.replyText).toBe('已绑定到工作区: Target Workspace。之后本聊天的消息会进入该工作区的会话。');
    });

    it('replies with hint to use /list when workspace is not found', async () => {
      const result = await chatCommandService.execute({
        userId,
        sessionId: canonicalSessionId,
        spaceId: defaultSpaceId,
        content: '/bind non-existent-space',
        channelContext: {
          channel: 'lark',
          accountId: account2Id,
          nativeContextId: inboundChatContextId,
        },
      });

      expect(result.replyText).toBe('未找到工作区 "non-existent-space"。请使用 /list 查看可用工作区。');
    });
  });

  describe('5. /newws in channel binds inbound chat context', () => {
    it('creates space and binds inbound chat context without touching session routes', async () => {
      const result = await chatCommandService.execute({
        userId,
        sessionId: canonicalSessionId,
        spaceId: defaultSpaceId,
        content: '/newws Synthetic Dynamic Space',
        channelContext: {
          channel: 'lark',
          accountId: account2Id,
          nativeContextId: inboundChatContextId,
        },
      });

      expect(result.replyText).toContain('工作区 "Synthetic Dynamic Space" 已创建。');
      expect(result.replyText).toContain('已绑定到工作区: Synthetic Dynamic Space。之后本聊天的消息会进入该工作区的会话。');

      const newSpace = db
        .prepare('SELECT id FROM spaces WHERE name = ?')
        .get('Synthetic Dynamic Space') as { id: string } | undefined;
      expect(newSpace).toBeDefined();

      // Channel binding updated to new space
      const binding = db
        .prepare('SELECT space_id FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?')
        .get(userId, account2Id, inboundChatContextId) as { space_id: string };
      expect(binding.space_id).toBe(newSpace!.id);

      // Canonical session route row unchanged
      const routeRow = db
        .prepare('SELECT space_id FROM session_routes WHERE id = ?')
        .get(canonicalSessionId) as { space_id: string };
      expect(routeRow.space_id).toBe(defaultSpaceId);
    });
  });

  describe('6. Web context remains unchanged', () => {
    it('/bind in web session rejects with immutable notice', async () => {
      const result = await chatCommandService.execute({
        userId,
        sessionId: webSessionId,
        spaceId: defaultSpaceId,
        content: `/bind ${targetSpaceId}`,
      });

      expect(result.replyText).toBe('Web 会话工作区绑定固定，请在目标工作区新建会话。');

      const routeRow = db
        .prepare('SELECT space_id FROM session_routes WHERE id = ?')
        .get(webSessionId) as { space_id: string };
      expect(routeRow.space_id).toBe(defaultSpaceId);
    });

    it('/unbind in web session rejects with immutable notice', async () => {
      const result = await chatCommandService.execute({
        userId,
        sessionId: webSessionId,
        spaceId: defaultSpaceId,
        content: '/unbind',
      });

      expect(result.replyText).toBe('Web 会话工作区绑定固定，无需解除绑定。');
    });

    it('/newws in web session creates space without changing binding', async () => {
      const result = await chatCommandService.execute({
        userId,
        sessionId: webSessionId,
        spaceId: defaultSpaceId,
        content: '/newws Synthetic Web Created Space',
      });

      expect(result.replyText).toBe('工作区 "Synthetic Web Created Space" 已创建。Web 会话工作区绑定固定，请从工作区列表切换打开。');

      const routeRow = db
        .prepare('SELECT space_id FROM session_routes WHERE id = ?')
        .get(webSessionId) as { space_id: string };
      expect(routeRow.space_id).toBe(defaultSpaceId);
    });
  });

  describe('7. DeliveryRuntimeGateway passes envelope.channelContext into chatCommandService.execute', () => {
    it('passes channelContext to chatCommandService when dispatching inbound chat command', async () => {
      const storage = new SqlitePlatformStorage(db);
      const messageStore = new SqliteWebMessageStore(db);
      const executeSpy = vi.spyOn(chatCommandService, 'execute');

      const gateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor: {
          execute: async () => ({ replyText: 'ok', usage: { totalTokens: 10 } }),
          cancel: async () => true,
        },
        quotaMode: 'disabled',
        profileResolver: {
          resolve: async () => ({
            profileId: 'default',
            version: 1,
            effectivePrompt: 'prompt',
            manifestSnapshot: {},
            checksum: 'chk',
          }),
        },
        chatCommandService,
      });

      const envelope: InboundEnvelope = {
        id: `deliv_${randomUUID().replace(/-/g, '')}`,
        userId,
        sessionId: canonicalSessionId,
        content: `/bind ${targetSpaceId}`,
        timestamp: new Date().toISOString(),
        channelContext: {
          channel: 'lark',
          accountId: account2Id,
          nativeContextId: inboundChatContextId,
          chatId: inboundChatContextId,
        },
      };

      const result = await gateway.dispatchInbound(envelope);
      expect(result.accepted).toBe(true);
      expect(result.executionMode).toBe('command');

      expect(executeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          userId,
          sessionId: canonicalSessionId,
          spaceId: defaultSpaceId,
          content: `/bind ${targetSpaceId}`,
          channelContext: {
            channel: 'lark',
            accountId: account2Id,
            nativeContextId: inboundChatContextId,
            chatId: inboundChatContextId,
          },
        })
      );

      // Verify the binding was updated for the inbound chat context
      const inboundBinding = db
        .prepare('SELECT space_id FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?')
        .get(userId, account2Id, inboundChatContextId) as { space_id: string } | undefined;
      expect(inboundBinding?.space_id).toBe(targetSpaceId);

      // Canonical session route remains unchanged
      const routeRow = db
        .prepare('SELECT space_id FROM session_routes WHERE id = ?')
        .get(canonicalSessionId) as { space_id: string };
      expect(routeRow.space_id).toBe(defaultSpaceId);
    });
  });
});
