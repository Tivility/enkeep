import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
} from '../src/index.js';
import { ModelSelectionService } from '../src/models/model-selection-service.js';
import { parseChatCommand, ChatCommandService } from '../src/chat/chat-command-service.js';
import type { RawDshModelConfig } from '../src/config/dsh-model-config.js';

describe('D5 Chat Slash Commands & Telemetry Metrics', () => {
  describe('1. parseChatCommand Whitelist & Path Pass-Through', () => {
    it('parses /where command', () => {
      const parsed = parseChatCommand('/where');
      expect(parsed).not.toBeNull();
      expect(parsed?.command).toBe('where');
      expect(parsed?.type).toBe('where');
      expect(parsed?.subcommand).toBe('show');
    });

    it('parses /bind command with space argument', () => {
      const parsed = parseChatCommand('/bind flow-test0008-b0b2');
      expect(parsed).not.toBeNull();
      expect(parsed?.command).toBe('bind');
      expect(parsed?.type).toBe('bind');
      expect(parsed?.subcommand).toBe('bind');
      expect(parsed?.target).toBe('flow-test0008-b0b2');
    });

    it('parses /bind without argument as show/help', () => {
      const parsed = parseChatCommand('/bind');
      expect(parsed).not.toBeNull();
      expect(parsed?.command).toBe('bind');
      expect(parsed?.subcommand).toBe('show');
    });

    it('parses /unbind command', () => {
      const parsed = parseChatCommand('/unbind');
      expect(parsed).not.toBeNull();
      expect(parsed?.command).toBe('unbind');
      expect(parsed?.type).toBe('unbind');
      expect(parsed?.subcommand).toBe('unbind');
    });

    it('passes normal file paths through as null (not slash commands)', () => {
      expect(parseChatCommand('/var/log')).toBeNull();
      expect(parseChatCommand('/var/log/syslog')).toBeNull();
      expect(parseChatCommand('/etc/nginx/nginx.conf')).toBeNull();
      expect(parseChatCommand('/tmp/test.txt')).toBeNull();
      expect(parseChatCommand('/usr/local/bin')).toBeNull();
      expect(parseChatCommand('/home/alice/project')).toBeNull();
    });

    it('strictly respects word boundary (rejects /whereabouts, /binding, /unbinding, /statuses)', () => {
      expect(parseChatCommand('/whereabouts')).toBeNull();
      expect(parseChatCommand('/binding')).toBeNull();
      expect(parseChatCommand('/unbindall')).toBeNull();
      expect(parseChatCommand('/statuses')).toBeNull();
      expect(parseChatCommand('/models')).toBeNull();
    });

    it('parses /model use <id> alias as set command', () => {
      const parsed = parseChatCommand('/model use gpt-4o');
      expect(parsed).not.toBeNull();
      expect(parsed?.command).toBe('model');
      expect(parsed?.subcommand).toBe('set');
      expect(parsed?.target).toBe('gpt-4o');

      const fullParsed = parseChatCommand('/model use openai/gpt-4o');
      expect(fullParsed).not.toBeNull();
      expect(fullParsed?.command).toBe('model');
      expect(fullParsed?.subcommand).toBe('set');
      expect(fullParsed?.target).toBe('openai/gpt-4o');
    });

    it('parses invalid /model use syntax as unknown (triggering usage)', () => {
      const emptyUse = parseChatCommand('/model use');
      expect(emptyUse).not.toBeNull();
      expect(emptyUse?.subcommand).toBe('unknown');

      const multiUse = parseChatCommand('/model use foo bar');
      expect(multiUse).not.toBeNull();
      expect(multiUse?.subcommand).toBe('unknown');
    });
  });

  describe('2. ChatCommandService Execution Unit Tests', () => {
    let db: DatabaseSync;
    let modelSelectionService: ModelSelectionService;
    let chatCommandService: ChatCommandService;

    const userId = 'u_alice_d5';
    const spaceId = 'spc_default_d5';
    const targetSpaceId = 'spc_target_d5';
    const webSessionId = 'ses_web_d5';
    const larkSessionId = 'ses_lark_d5';
    const accountId = 'acc_lark_d5';
    const nativeContextId = 'chat_feishu_d5';

    const stubCatalog: RawDshModelConfig = {
      providers: {
        openai: {
          id: 'openai',
          api: 'openai',
          configured: true,
          models: [
            {
              id: 'gpt-4o',
              reasoningEfforts: { low: null, medium: null, high: null },
            },
            {
              id: 'gpt-4o-mini',
            },
          ],
        },
        anthropic: {
          id: 'anthropic',
          api: 'anthropic',
          configured: true,
          models: [
            {
              id: 'claude-opus-5',
              reasoningEfforts: { high: null },
            },
          ],
        },
      },
      defaultModel: {
        provider: 'openai',
        model: 'gpt-4o',
        reasoningEffort: 'low',
      },
    };

    beforeEach(async () => {
      db = new DatabaseSync(':memory:');
      const runner = new PlatformServerMigrationRunner(db);
      await runner.migrate(ALL_PLATFORM_MIGRATIONS);

      db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, 'alice_d5', 'hash', 'user')").run(userId);

      // Create spaces
      db.prepare("INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES (?, ?, 'Default Space', 'spc-default-folder', 'container')").run(spaceId, userId);
      db.prepare("INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES (?, ?, 'Target Space', 'spc-target-folder', 'host')").run(targetSpaceId, userId);

      // Create channel account
      db.prepare("INSERT INTO channel_accounts (id, user_id, type, default_space_id, status) VALUES (?, ?, 'lark', ?, 'active')").run(accountId, userId, spaceId);

      // Create web session route
      db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, peer_id, dsh_session_id, execution_mode, current_generation) VALUES (?, ?, ?, 'web', 'p_web', 'dsh_web', 'container', 1)").run(webSessionId, userId, spaceId);

      // Create lark session route
      db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, current_generation) VALUES (?, ?, ?, 'lark', ?, ?, 'p_lark', 'dsh_lark', 'container', 1)").run(larkSessionId, userId, spaceId, accountId, nativeContextId);

      modelSelectionService = new ModelSelectionService({ db });
      vi.spyOn(modelSelectionService, 'getDshCatalog').mockReturnValue(stubCatalog);

      chatCommandService = new ChatCommandService({
        modelSelectionService,
        db,
      });
    });

    describe('/where command', () => {
      it('returns immutable notice for web session', async () => {
        const result = await chatCommandService.execute({
          userId,
          sessionId: webSessionId,
          spaceId,
          content: '/where',
        });

        expect(result.replyText).toContain('space: Default Space');
        expect(result.replyText).toContain('folder: spc-default-folder');
        expect(result.replyText).toContain('mode: container');
        expect(result.replyText).toContain('channel: web (workspace binding is immutable)');
      });

      it('returns channel context and activation mode for lark session', async () => {
        // Create an explicit channel binding
        db.prepare("INSERT INTO channel_bindings (id, user_id, account_id, space_id, native_context_id, activation_mode) VALUES ('cb_1', ?, ?, ?, ?, 'always')").run(userId, accountId, spaceId, nativeContextId);

        const result = await chatCommandService.execute({
          userId,
          sessionId: larkSessionId,
          spaceId,
          content: '/where',
        });

        expect(result.replyText).toContain('space: Default Space');
        expect(result.replyText).toContain(`channel: lark (context: ${nativeContextId}, mode: always)`);
      });
    });

    describe('/bind and /unbind commands', () => {
      it('rejects /bind in web session with immutable notice', async () => {
        const result = await chatCommandService.execute({
          userId,
          sessionId: webSessionId,
          spaceId,
          content: `/bind ${targetSpaceId}`,
        });

        expect(result.replyText).toContain('Web 会话工作区绑定固定，请在目标工作区新建会话。');
      });

      it('rejects /unbind in web session with immutable notice', async () => {
        const result = await chatCommandService.execute({
          userId,
          sessionId: webSessionId,
          spaceId,
          content: '/unbind',
        });

        expect(result.replyText).toContain('Web 会话工作区绑定固定，无需解除绑定。');
      });

      it('executes /bind by space folder in lark session and updates session route and binding', async () => {
        const result = await chatCommandService.execute({
          userId,
          sessionId: larkSessionId,
          spaceId,
          content: '/bind spc-target-folder',
        });

        expect(result.replyText).toContain('已成功绑定到工作区: Target Space');

        // Check session_routes updated
        const routeRow = db.prepare('SELECT space_id, execution_mode FROM session_routes WHERE id = ?').get(larkSessionId) as { space_id: string; execution_mode: string };
        expect(routeRow.space_id).toBe(targetSpaceId);
        expect(routeRow.execution_mode).toBe('host');

        // Check channel_bindings updated
        const bindRow = db.prepare('SELECT space_id FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?').get(userId, accountId, nativeContextId) as { space_id: string };
        expect(bindRow.space_id).toBe(targetSpaceId);

        // Verify next /where reflects the new target space
        const whereResult = await chatCommandService.execute({
          userId,
          sessionId: larkSessionId,
          spaceId: targetSpaceId,
          content: '/where',
        });
        expect(whereResult.replyText).toContain('space: Target Space');
      });

      it('executes /unbind in lark session, clearing binding and reverting to default space', async () => {
        // First bind to target space
        await chatCommandService.execute({
          userId,
          sessionId: larkSessionId,
          spaceId,
          content: '/bind spc-target-folder',
        });

        // Now unbind
        const unbindResult = await chatCommandService.execute({
          userId,
          sessionId: larkSessionId,
          spaceId: targetSpaceId,
          content: '/unbind',
        });

        expect(unbindResult.replyText).toContain('已恢复渠道默认工作区: Default Space');

        // Check session_routes reverted
        const routeRow = db.prepare('SELECT space_id FROM session_routes WHERE id = ?').get(larkSessionId) as { space_id: string };
        expect(routeRow.space_id).toBe(spaceId);

        // Check channel_bindings deleted
        const bindRow = db.prepare('SELECT count(*) as count FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?').get(userId, accountId, nativeContextId) as { count: number };
        expect(bindRow.count).toBe(0);
      });

      it('rejects /bind with unknown workspace', async () => {
        const result = await chatCommandService.execute({
          userId,
          sessionId: larkSessionId,
          spaceId,
          content: '/bind non-existent-space',
        });

        expect(result.replyText).toContain('未找到工作区 "non-existent-space"。');
      });
    });

    describe('/model use <id> alias', () => {
      it('switches model via /model use <id>', async () => {
        const result = await chatCommandService.execute({
          userId,
          sessionId: webSessionId,
          spaceId,
          content: '/model use anthropic/claude-opus-5',
        });

        expect(result.replyText).toContain('Session model set to anthropic/claude-opus-5.');

        const override = await modelSelectionService.getOverride('session', webSessionId);
        expect(override?.provider).toBe('anthropic');
        expect(override?.model).toBe('claude-opus-5');
      });
    });

    describe('/status telemetry and queue formatting', () => {
      it('outputs queue depths and idle resources when no telemetry samples exist', async () => {
        const result = await chatCommandService.execute({
          userId,
          sessionId: webSessionId,
          spaceId,
          content: '/status',
        });

        expect(result.replyText).toContain('turn: idle');
        expect(result.replyText).toContain('queue: idle (user queue: 0 running, 0 queued)');
        expect(result.replyText).toContain('resources: n/a (idle)');
      });

      it('outputs live queue depth and position when user turns are running and queued', async () => {
        // Insert active and queued turn runs
        db.prepare("INSERT INTO turn_runs (id, turn_id, user_id, space_id, route_id, status, execution_mode, created_at) VALUES ('tr_1', 'turn_1', ?, ?, ?, 'running', 'container', '2026-09-24 00:01:00')").run(userId, spaceId, webSessionId);
        db.prepare("INSERT INTO turn_runs (id, turn_id, user_id, space_id, route_id, status, execution_mode, created_at) VALUES ('tr_2', 'turn_2', ?, ?, ?, 'queued', 'container', '2026-09-24 00:02:00')").run(userId, spaceId, larkSessionId);
        db.prepare("INSERT INTO turn_runs (id, turn_id, user_id, space_id, route_id, status, execution_mode, created_at) VALUES ('tr_3', 'turn_3', ?, ?, ?, 'queued', 'container', '2026-09-24 00:03:00')").run(userId, spaceId, webSessionId);

        const result = await chatCommandService.execute({
          userId,
          sessionId: webSessionId,
          spaceId,
          content: '/status',
        });

        expect(result.replyText).toContain('turn: running');
        expect(result.replyText).toContain('(user queue: 1 running, 2 queued)');
      });

      it('extracts and formats memory, cpu, and pids metrics from runtime_diagnostics', async () => {
        db.prepare(`
          INSERT INTO runtime_diagnostics (id, user_id, event_type, level, code, message, cpu_percent, memory_usage_bytes, memory_limit_bytes, pids_count, created_at)
          VALUES ('rd_1', ?, 'resource_sample', 'info', 'CONTAINER_RESOURCE_SAMPLE', 'Sample', 12.5, 134217728, 536870912, 18, '2026-09-24 00:10:00')
        `).run(userId);

        const result = await chatCommandService.execute({
          userId,
          sessionId: webSessionId,
          spaceId,
          content: '/status',
        });

        // 134217728 bytes = 128 MB, 536870912 bytes = 512 MB
        expect(result.replyText).toContain('resources: mem 128.0MB / 512MB, cpu 12.5%, pids 18');
      });
    });

    describe('/help updated commands', () => {
      it('lists /where, /bind, and /unbind in /help output', async () => {
        const result = await chatCommandService.execute({
          userId,
          sessionId: webSessionId,
          spaceId,
          content: '/help',
        });

        expect(result.replyText).toContain('/where - Show current workspace binding and context');
        expect(result.replyText).toContain('/bind - Bind channel context to workspace');
        expect(result.replyText).toContain('/unbind - Revert channel context to default workspace');
      });
    });
  });
});
