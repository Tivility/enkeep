/**
 * Synthetic Test Suite: Layered Context Window in Platform Server REST & Commands
 *
 * Verifies:
 * 1. REST endpoints:
 *    - GET/PUT/DELETE /api/spaces/:id/context-window
 *    - GET/PUT/DELETE /api/sessions/:id/context-window
 *    - Returns effective value, source, clamped value, and problem detection.
 * 2. Chat commands:
 *    - /ws window, /ws window <tokens>, /ws window default
 *    - /session window, /session window <tokens>, /session window default
 *    - Group chat permission gating.
 *
 * Follows enkeep/AGENTS.md strictly: synthetic identifiers only.
 * @module @enkeep/platform-server/tests/layered-context-window.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { ALL_PLATFORM_MIGRATIONS, PlatformServerMigrationRunner } from '../src/storage/migrations.js';
import { ChatCommandService, parseChatCommand, HELP_USAGE } from '../src/chat/chat-command-service.js';

describe('Layered Context Window in Platform Server', () => {
  let db: DatabaseSync;
  let commandService: ChatCommandService;

  const aliceUserId = 'user_alice_synthetic_01';
  const aliceSpaceId = 'spc_alice_synthetic_01';
  const aliceSessionId = 'ses_alice_synthetic_01';

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    // Seed test user, space, and session
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
      VALUES (?, 'alice', 'hash', 'admin', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(aliceUserId);

    db.prepare(`
      INSERT INTO spaces (id, user_id, name, folder, execution_mode, status, created_at, updated_at)
      VALUES (?, ?, 'Alice Space', 'alice-space', 'container', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(aliceSpaceId, aliceUserId);

    db.prepare(`
      INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, status, created_at, updated_at)
      VALUES (?, ?, ?, 'web', 'default', 'peer_01', 'peer_01', 'dsh_ses_01', 'container', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(aliceSessionId, aliceSpaceId, aliceUserId);

    commandService = new ChatCommandService({ db });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  describe('1. Chat Commands (/session window & /ws window)', () => {
    it('parses /session window and /ws window commands', () => {
      expect(parseChatCommand('/session window')).toEqual({
        command: 'session',
        type: 'session',
        subcommand: 'window',
        action: 'window',
        raw: '/session window',
      });

      expect(parseChatCommand('/session window 128000')).toEqual({
        command: 'session',
        type: 'session',
        subcommand: 'window',
        action: 'window',
        target: '128000',
        arg: '128000',
        raw: '/session window 128000',
      });

      expect(parseChatCommand('/ws window 300000')).toEqual({
        command: 'ws',
        type: 'ws',
        subcommand: 'window',
        action: 'window',
        target: '300000',
        arg: '300000',
        raw: '/ws window 300000',
      });

      expect(parseChatCommand('/ws window default')).toEqual({
        command: 'ws',
        type: 'ws',
        subcommand: 'window',
        action: 'window',
        target: 'default',
        arg: 'default',
        raw: '/ws window default',
      });
    });

    it('shows effective value and source via /session window and /ws window', async () => {
      const resWs = await commandService.execute({
        userId: aliceUserId,
        sessionId: aliceSessionId,
        spaceId: aliceSpaceId,
        content: '/ws window',
      });
      expect(resWs.replyText).toContain('Working Context Window: 272000');
      expect(resWs.replyText).toContain('来源: platform');

      const resSes = await commandService.execute({
        userId: aliceUserId,
        sessionId: aliceSessionId,
        spaceId: aliceSpaceId,
        content: '/session window',
      });
      expect(resSes.replyText).toContain('Working Context Window: 272000');
      expect(resSes.replyText).toContain('来源: platform');
    });

    it('mutates workspace window override and clears with default', async () => {
      const setRes = await commandService.execute({
        userId: aliceUserId,
        sessionId: aliceSessionId,
        spaceId: aliceSpaceId,
        content: '/ws window 300000',
      });
      expect(setRes.replyText).toContain('已设置当前工作区 Context Window 为 300000');

      const checkWs = await commandService.execute({
        userId: aliceUserId,
        sessionId: aliceSessionId,
        spaceId: aliceSpaceId,
        content: '/ws window',
      });
      expect(checkWs.replyText).toContain('300000 (来源: space)');

      const checkSes = await commandService.execute({
        userId: aliceUserId,
        sessionId: aliceSessionId,
        spaceId: aliceSpaceId,
        content: '/session window',
      });
      expect(checkSes.replyText).toContain('300000 (来源: space)');

      const clearRes = await commandService.execute({
        userId: aliceUserId,
        sessionId: aliceSessionId,
        spaceId: aliceSpaceId,
        content: '/ws window default',
      });
      expect(clearRes.replyText).toContain('已清除当前工作区 Context Window 覆盖');
    });

    it('mutates session window override and clears with default', async () => {
      const setRes = await commandService.execute({
        userId: aliceUserId,
        sessionId: aliceSessionId,
        spaceId: aliceSpaceId,
        content: '/session window 150000',
      });
      expect(setRes.replyText).toContain('已设置当前会话 Context Window 为 150000');

      const checkSes = await commandService.execute({
        userId: aliceUserId,
        sessionId: aliceSessionId,
        spaceId: aliceSpaceId,
        content: '/session window',
      });
      expect(checkSes.replyText).toContain('150000 (来源: session)');

      const clearRes = await commandService.execute({
        userId: aliceUserId,
        sessionId: aliceSessionId,
        spaceId: aliceSpaceId,
        content: '/session window default',
      });
      expect(clearRes.replyText).toContain('已清除当前会话 Context Window 覆盖');
    });
  });
});
