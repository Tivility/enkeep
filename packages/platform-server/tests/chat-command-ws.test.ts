import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
} from '../src/index.js';
import { ModelSelectionService } from '../src/models/model-selection-service.js';
import { parseChatCommand, ChatCommandService } from '../src/chat/chat-command-service.js';
import type { RawDshModelConfig } from '../src/config/dsh-model-config.js';

describe('Chat Commands /new, /newws, /list & /ls (Synthetic Data)', () => {
  let db: DatabaseSync;
  let modelSelectionService: ModelSelectionService;
  let chatCommandService: ChatCommandService;

  const userId = 'u_synth_cmd_user_01';
  const space1Id = 'spc_synth_01';
  const space2Id = 'spc_synth_02';
  const space3Id = 'spc_synth_03';
  const webSessionId = 'ses_synth_web_01';
  const channelSessionId = 'ses_synth_channel_01';
  const accountId = 'acc_synth_channel_01';
  const nativeContextId = 'chat_synth_native_01';

  let resetSessionMock: any;
  let createSpaceMock: any;
  let listSpacesMock: any;

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

    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, 'alice_synth', 'hash', 'admin')").run(userId);

    // Create 3 synthetic initial spaces
    db.prepare("INSERT INTO spaces (id, user_id, name, folder, execution_mode, status, created_at, updated_at) VALUES (?, ?, 'Synthetic Alpha', 'spc-synth-alpha', 'container', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run(space1Id, userId);
    db.prepare("INSERT INTO spaces (id, user_id, name, folder, execution_mode, status, created_at, updated_at) VALUES (?, ?, 'Synthetic Beta', 'spc-synth-beta', 'host', 'active', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')").run(space2Id, userId);
    db.prepare("INSERT INTO spaces (id, user_id, name, folder, execution_mode, status, created_at, updated_at) VALUES (?, ?, 'Synthetic Gamma', 'spc-synth-gamma', 'container', 'active', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z')").run(space3Id, userId);

    // Create channel account
    db.prepare("INSERT INTO channel_accounts (id, user_id, type, default_space_id, status) VALUES (?, ?, 'lark', ?, 'active')").run(accountId, userId, space1Id);

    // Create web session route (bound to space1)
    db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, current_generation, status, created_at, updated_at) VALUES (?, ?, ?, 'web', 'default', ?, 'p_web', 'dsh_web', 'container', 1, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run(webSessionId, userId, space1Id, webSessionId);

    // Create channel session route (bound to space1)
    db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, current_generation, status, created_at, updated_at) VALUES (?, ?, ?, 'lark', ?, ?, 'p_chan', 'dsh_chan', 'container', 1, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run(channelSessionId, userId, space1Id, accountId, nativeContextId);

    // Create channel binding
    db.prepare("INSERT INTO channel_bindings (id, user_id, account_id, space_id, native_context_id, activation_mode) VALUES ('cb_synth_01', ?, ?, ?, ?, 'mention')").run(userId, accountId, space1Id, nativeContextId);

    modelSelectionService = new ModelSelectionService({ db });
    vi.spyOn(modelSelectionService, 'getDshCatalog').mockReturnValue(stubCatalog);

    resetSessionMock = vi.fn().mockResolvedValue({
      generation: { generation: 2 },
    });

    createSpaceMock = vi.fn().mockImplementation(async (uid: string, input: any) => {
      const newId = `spc_mock_${Date.now()}`;
      const folder = `space-mock-${Date.now()}`;
      db.prepare(`
        INSERT INTO spaces (id, user_id, name, folder, execution_mode, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(newId, uid, input.name, folder, input.executionMode || 'container');
      return {
        id: newId,
        name: input.name,
        folder,
        executionMode: input.executionMode || 'container',
      };
    });

    listSpacesMock = vi.fn();

    chatCommandService = new ChatCommandService({
      modelSelectionService,
      db,
      platformApi: {
        resetSession: resetSessionMock,
        createSpace: createSpaceMock,
      },
    });
  });

  describe('1. Parser Unit Tests for /new, /newws, /list and aliases', () => {
    it('parses /new with arguments, preserving the argument', () => {
      const parsed = parseChatCommand('/new my-new-workspace');
      expect(parsed).not.toBeNull();
      expect(parsed?.command).toBe('new');
      expect(parsed?.arg).toBe('my-new-workspace');
    });

    it('parses /reset and /clear with arguments, preserving the argument', () => {
      const resetParsed = parseChatCommand('/reset my-workspace');
      expect(resetParsed).not.toBeNull();
      expect(resetParsed?.command).toBe('new');
      expect(resetParsed?.arg).toBe('my-workspace');

      const clearParsed = parseChatCommand('/clear my-workspace');
      expect(clearParsed).not.toBeNull();
      expect(clearParsed?.command).toBe('new');
      expect(clearParsed?.arg).toBe('my-workspace');
    });

    it('parses /newws and alias /new-workspace', () => {
      const wsParsed = parseChatCommand('/newws Team Project');
      expect(wsParsed).not.toBeNull();
      expect(wsParsed?.command).toBe('newws');
      expect(wsParsed?.arg).toBe('Team Project');

      const aliasParsed = parseChatCommand('/new-workspace Team Project');
      expect(aliasParsed).not.toBeNull();
      expect(aliasParsed?.command).toBe('newws');
      expect(aliasParsed?.arg).toBe('Team Project');
    });

    it('parses /list and alias /ls', () => {
      const listParsed = parseChatCommand('/list');
      expect(listParsed).not.toBeNull();
      expect(listParsed?.command).toBe('list');

      const lsParsed = parseChatCommand('/ls');
      expect(lsParsed).not.toBeNull();
      expect(lsParsed?.command).toBe('list');

      const lsWithSpace = parseChatCommand('   /ls   ');
      expect(lsWithSpace).not.toBeNull();
      expect(lsWithSpace?.command).toBe('list');
    });

    it('strictly respects word boundary (rejects /newws_test, /new-workspaces, /listing, /lss)', () => {
      expect(parseChatCommand('/newws_test')).toBeNull();
      expect(parseChatCommand('/new-workspaces')).toBeNull();
      expect(parseChatCommand('/listing')).toBeNull();
      expect(parseChatCommand('/lss')).toBeNull();
    });
  });

  describe('2. /new with arguments -> Chinese hint & NO new session', () => {
    it('returns hint and does NOT call resetSession when /new has arguments', async () => {
      const result = await chatCommandService.execute({
        userId,
        sessionId: webSessionId,
        spaceId: space1Id,
        content: '/new my-test-space',
      });

      expect(result.replyText).toBe('新会话请直接发送 /new；新建工作区请用 /newws <名称>.');
      expect(resetSessionMock).not.toHaveBeenCalled();
    });

    it('returns hint and does NOT call resetSession when /reset has arguments', async () => {
      const result = await chatCommandService.execute({
        userId,
        sessionId: webSessionId,
        spaceId: space1Id,
        content: '/reset my-test-space',
      });

      expect(result.replyText).toBe('新会话请直接发送 /new；新建工作区请用 /newws <名称>.');
      expect(resetSessionMock).not.toHaveBeenCalled();
    });

    it('returns hint and does NOT call resetSession when /clear has arguments', async () => {
      const result = await chatCommandService.execute({
        userId,
        sessionId: webSessionId,
        spaceId: space1Id,
        content: '/clear my-test-space',
      });

      expect(result.replyText).toBe('新会话请直接发送 /new；新建工作区请用 /newws <名称>.');
      expect(resetSessionMock).not.toHaveBeenCalled();
    });

    it('executes normal session reset when /new has NO arguments', async () => {
      const result = await chatCommandService.execute({
        userId,
        sessionId: webSessionId,
        spaceId: space1Id,
        content: '/new',
      });

      expect(resetSessionMock).toHaveBeenCalledTimes(1);
      expect(result.replyText).toContain('Started generation 2');
    });
  });

  describe('3. /newws name validation (1-50 chars, trimmed)', () => {
    it('rejects empty space name', async () => {
      const result = await chatCommandService.execute({
        userId,
        sessionId: webSessionId,
        spaceId: space1Id,
        content: '/newws',
      });
      expect(result.replyText).toBe('工作区名称长度必须在 1 到 50 个字符之间。');
      expect(createSpaceMock).not.toHaveBeenCalled();
    });

    it('rejects whitespace-only space name', async () => {
      const result = await chatCommandService.execute({
        userId,
        sessionId: webSessionId,
        spaceId: space1Id,
        content: '/newws    ',
      });
      expect(result.replyText).toBe('工作区名称长度必须在 1 到 50 个字符之间。');
      expect(createSpaceMock).not.toHaveBeenCalled();
    });

    it('accepts valid 1-character trimmed name', async () => {
      chatCommandService.setDockerAvailableCheck(() => true);
      const result = await chatCommandService.execute({
        userId,
        sessionId: webSessionId,
        spaceId: space1Id,
        content: '/newws x',
      });
      expect(result.replyText).toContain('工作区 "x" 已创建');
      expect(createSpaceMock).toHaveBeenCalledWith(userId, {
        name: 'x',
        executionMode: 'container',
      });
    });

    it('accepts valid 50-character trimmed name', async () => {
      chatCommandService.setDockerAvailableCheck(() => true);
      const name50 = 'A'.repeat(50);
      const result = await chatCommandService.execute({
        userId,
        sessionId: webSessionId,
        spaceId: space1Id,
        content: `/newws   ${name50}   `,
      });
      expect(result.replyText).toContain(`工作区 "${name50}" 已创建`);
      expect(createSpaceMock).toHaveBeenCalledWith(userId, {
        name: name50,
        executionMode: 'container',
      });
    });

    it('rejects name exceeding 50 characters', async () => {
      const name51 = 'A'.repeat(51);
      const result = await chatCommandService.execute({
        userId,
        sessionId: webSessionId,
        spaceId: space1Id,
        content: `/newws ${name51}`,
      });
      expect(result.replyText).toBe('工作区名称长度必须在 1 到 50 个字符之间。');
      expect(createSpaceMock).not.toHaveBeenCalled();
    });
  });

  describe('4. /newws in channel context (creates + binds) & execution mode', () => {
    it('creates space with container mode when docker is available and binds channel', async () => {
      chatCommandService.setDockerAvailableCheck(() => true);

      const result = await chatCommandService.execute({
        userId,
        sessionId: channelSessionId,
        spaceId: space1Id,
        content: '/newws Synthetic Channel Workspace',
      });

      // Reply includes space name and bind confirmation
      expect(result.replyText).toContain('Synthetic Channel Workspace');
      expect(result.replyText).toContain('已绑定到工作区');

      // Verify createSpace called with executionMode 'container'
      expect(createSpaceMock).toHaveBeenCalledWith(userId, {
        name: 'Synthetic Channel Workspace',
        executionMode: 'container',
      });

      // Verify space created in database with container mode
      const createdSpaceRow = db.prepare("SELECT id, execution_mode FROM spaces WHERE name = 'Synthetic Channel Workspace'").get() as { id: string; execution_mode: string };
      expect(createdSpaceRow).toBeDefined();
      expect(createdSpaceRow.execution_mode).toBe('container');

      // Verify channel binding updated to new space
      const bindRow = db.prepare('SELECT space_id FROM channel_bindings WHERE user_id = ? AND account_id = ? AND native_context_id = ?').get(userId, accountId, nativeContextId) as { space_id: string };
      expect(bindRow.space_id).toBe(createdSpaceRow.id);

      // Verify session route space_id is unchanged (not modified by /bind)
      const routeRow = db.prepare('SELECT space_id, execution_mode FROM session_routes WHERE id = ?').get(channelSessionId) as { space_id: string; execution_mode: string };
      expect(routeRow.space_id).toBe(space1Id);
      expect(routeRow.execution_mode).toBe('container');
    });

    it('creates space with host mode when docker is unavailable (mirrors HappyClaw)', async () => {
      chatCommandService.setDockerAvailableCheck(() => false);

      const result = await chatCommandService.execute({
        userId,
        sessionId: channelSessionId,
        spaceId: space1Id,
        content: '/new-workspace Synthetic Host Mode Space',
      });

      expect(result.replyText).toContain('Synthetic Host Mode Space');
      expect(result.replyText).toContain('已绑定到工作区');

      // Verify createSpace called with executionMode 'host'
      expect(createSpaceMock).toHaveBeenCalledWith(userId, {
        name: 'Synthetic Host Mode Space',
        executionMode: 'host',
      });

      const createdSpaceRow = db.prepare("SELECT id, execution_mode FROM spaces WHERE name = 'Synthetic Host Mode Space'").get() as { id: string; execution_mode: string };
      expect(createdSpaceRow).toBeDefined();
      expect(createdSpaceRow.execution_mode).toBe('host');

      const routeRow = db.prepare('SELECT space_id, execution_mode FROM session_routes WHERE id = ?').get(channelSessionId) as { space_id: string; execution_mode: string };
      expect(routeRow.space_id).toBe(space1Id);
      expect(routeRow.execution_mode).toBe('container');
    });
  });

  describe('5. /newws in web context (creates only, immutable message)', () => {
    it('creates space but does NOT change web session route binding', async () => {
      chatCommandService.setDockerAvailableCheck(() => true);

      const result = await chatCommandService.execute({
        userId,
        sessionId: webSessionId,
        spaceId: space1Id,
        content: '/newws Web Exclusive Space',
      });

      // Reply includes space name and instructions to open from space list
      expect(result.replyText).toContain('Web Exclusive Space');
      expect(result.replyText).toContain('已创建');
      expect(result.replyText).toContain('Web 会话工作区绑定固定，请从工作区列表切换打开。');

      // Verify space created
      const createdSpaceRow = db.prepare("SELECT id FROM spaces WHERE name = 'Web Exclusive Space'").get() as { id: string };
      expect(createdSpaceRow).toBeDefined();

      // Verify web session route remains bound to space1Id
      const routeRow = db.prepare('SELECT space_id FROM session_routes WHERE id = ?').get(webSessionId) as { space_id: string };
      expect(routeRow.space_id).toBe(space1Id);
    });
  });

  describe('6. /list & /ls ordering by recent activity and current marker', () => {
    it('orders active spaces by recent activity DESC, marking the current space', async () => {
      // Setup web_messages with varying timestamps:
      // Space 2 (Beta) has newest activity (2026-06-01)
      // Space 1 (Alpha) has middle activity (2026-03-01)
      // Space 3 (Gamma) has fallback createdAt (2026-01-03)
      const sessionBetaId = 'ses_synth_beta_msg';
      db.prepare(`
        INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, current_generation, status, created_at, updated_at)
        VALUES (?, ?, ?, 'web', 'default', ?, 'p_beta', 'dsh_beta', 'host', 1, 'active', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')
      `).run(sessionBetaId, userId, space2Id, sessionBetaId);

      db.prepare(`
        INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, created_at)
        VALUES ('msg_synth_01', ?, ?, 'user', 'Msg for Alpha', 'delivered', 'r1', '2026-03-01T10:00:00.000Z')
      `).run(webSessionId, userId);

      db.prepare(`
        INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, created_at)
        VALUES ('msg_synth_02', ?, ?, 'user', 'Msg for Beta newest', 'delivered', 'r2', '2026-06-01T10:00:00.000Z')
      `).run(sessionBetaId, userId);

      // Execute /list while current session is webSessionId (bound to Space 1: Synthetic Alpha)
      const result = await chatCommandService.execute({
        userId,
        sessionId: webSessionId,
        spaceId: space1Id,
        content: '/list',
      });

      const lines = result.replyText.split('\n');
      expect(lines.length).toBe(3);

      // Order must be:
      // 1. Synthetic Beta (host) - newest
      // 2. Synthetic Alpha (container) - middle, marked as CURRENT (*)
      // 3. Synthetic Gamma (container) - oldest
      expect(lines[0]).toBe('  Synthetic Beta (host)');
      expect(lines[1]).toBe('* Synthetic Alpha (container)');
      expect(lines[2]).toBe('  Synthetic Gamma (container)');

      // Verify alias /ls produces identical result
      const lsResult = await chatCommandService.execute({
        userId,
        sessionId: webSessionId,
        spaceId: space1Id,
        content: '/ls',
      });
      expect(lsResult.replyText).toBe(result.replyText);
    });

    it('marks the current space when current space is the first in order', async () => {
      // If current space is Space 2 (Synthetic Beta)
      const sessionBetaId = 'ses_synth_beta_first';
      db.prepare(`
        INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, current_generation, status, created_at, updated_at)
        VALUES (?, ?, ?, 'web', 'default', ?, 'p_beta_1', 'dsh_beta_1', 'host', 1, 'active', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')
      `).run(sessionBetaId, userId, space2Id, sessionBetaId);

      db.prepare(`
        INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, created_at)
        VALUES ('msg_synth_10', ?, ?, 'user', 'Msg for Beta newest', 'delivered', 'r10', '2026-09-01T10:00:00.000Z')
      `).run(sessionBetaId, userId);

      const result = await chatCommandService.execute({
        userId,
        sessionId: sessionBetaId,
        spaceId: space2Id,
        content: '/list',
      });

      const lines = result.replyText.split('\n');
      expect(lines[0]).toBe('* Synthetic Beta (host)');
      expect(lines[1]).toBe('  Synthetic Gamma (container)');
      expect(lines[2]).toBe('  Synthetic Alpha (container)');
    });
  });

  describe('7. Unknown commands and existing commands unaffected', () => {
    it('returns Unrecognized command for unknown slash command', async () => {
      const result = await chatCommandService.execute({
        userId,
        sessionId: webSessionId,
        spaceId: space1Id,
        content: '/unknown_synth_cmd',
      });
      expect(result.replyText).toBe('Unrecognized command.');
    });

    it('HELP_USAGE includes /newws and /list', async () => {
      const result = await chatCommandService.execute({
        userId,
        sessionId: webSessionId,
        spaceId: space1Id,
        content: '/help',
      });
      expect(result.replyText).toContain('/newws - Create a new workspace (alias: /new-workspace <name>)');
      expect(result.replyText).toContain('/list - List active spaces ordered by recent activity (alias: /ls)');
    });

    it('/where continues to function properly', async () => {
      const result = await chatCommandService.execute({
        userId,
        sessionId: webSessionId,
        spaceId: space1Id,
        content: '/where',
      });
      expect(result.replyText).toContain('space: Synthetic Alpha');
      expect(result.replyText).toContain('channel: web (workspace binding is immutable)');
    });
  });
});
