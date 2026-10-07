import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  SqlitePlatformStorage,
  SqlitePlatformOperationsStorage,
} from '@enkeep/platform-storage-sqlite';
import {
  PlatformOperationsService,
  validateTaskPriority,
} from '@enkeep/platform-operations';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  SqliteWebMessageStore,
} from '../src/index.js';
import { DeliveryRuntimeGateway } from '../src/runtime/delivery-gateway.js';
import { ModelSelectionService } from '../src/models/model-selection-service.js';
import { parseChatCommand, ChatCommandService } from '../src/chat/chat-command-service.js';
import type { RawDshModelConfig } from '../src/config/dsh-model-config.js';

describe('Chat Slash Commands (/model and /effort)', () => {
  // =========================================================================
  // 1. Parser Unit Tests
  // =========================================================================
  describe('1. parseChatCommand Parser Unit Tests', () => {
    it('parses /model (no arg) as show command', () => {
      const parsed = parseChatCommand('/model');
      expect(parsed).not.toBeNull();
      expect(parsed?.command).toBe('model');
      expect(parsed?.subcommand).toBe('show');
    });

    it('parses /model with leading and trailing whitespace', () => {
      const parsed = parseChatCommand('   /model   ');
      expect(parsed).not.toBeNull();
      expect(parsed?.command).toBe('model');
      expect(parsed?.subcommand).toBe('show');
    });

    it('parses /model list', () => {
      const parsed = parseChatCommand('/model list');
      expect(parsed).not.toBeNull();
      expect(parsed?.command).toBe('model');
      expect(parsed?.subcommand).toBe('list');
    });

    it('parses /model reset', () => {
      const parsed = parseChatCommand('/model reset');
      expect(parsed).not.toBeNull();
      expect(parsed?.command).toBe('model');
      expect(parsed?.subcommand).toBe('reset');
    });

    it('parses /model with provider/model target', () => {
      const parsed = parseChatCommand('/model openai/gpt-4o');
      expect(parsed).not.toBeNull();
      expect(parsed?.command).toBe('model');
      expect(parsed?.subcommand).toBe('set');
      expect(parsed?.target).toBe('openai/gpt-4o');
    });

    it('parses /model with bare modelId target', () => {
      const parsed = parseChatCommand('/model gpt-4o');
      expect(parsed).not.toBeNull();
      expect(parsed?.command).toBe('model');
      expect(parsed?.subcommand).toBe('set');
      expect(parsed?.target).toBe('gpt-4o');
    });

    it('parses /model with unknown/help arguments', () => {
      const helpParsed = parseChatCommand('/model help');
      expect(helpParsed).not.toBeNull();
      expect(helpParsed?.subcommand).toBe('unknown');

      const multiArgParsed = parseChatCommand('/model foo bar baz');
      expect(multiArgParsed).not.toBeNull();
      expect(multiArgParsed?.subcommand).toBe('unknown');
    });

    it('parses /effort (no arg) as unknown/usage', () => {
      const parsed = parseChatCommand('/effort');
      expect(parsed).not.toBeNull();
      expect(parsed?.command).toBe('effort');
      expect(parsed?.subcommand).toBe('unknown');
    });

    it('parses /effort list', () => {
      const parsed = parseChatCommand('/effort list');
      expect(parsed).not.toBeNull();
      expect(parsed?.command).toBe('effort');
      expect(parsed?.subcommand).toBe('list');
    });

    it('parses /effort reset', () => {
      const parsed = parseChatCommand('/effort reset');
      expect(parsed).not.toBeNull();
      expect(parsed?.command).toBe('effort');
      expect(parsed?.subcommand).toBe('reset');
    });

    it('parses /effort <name>', () => {
      const parsed = parseChatCommand('/effort high');
      expect(parsed).not.toBeNull();
      expect(parsed?.command).toBe('effort');
      expect(parsed?.subcommand).toBe('set');
      expect(parsed?.effort).toBe('high');
    });

    it('parses /effort with unknown/help arguments', () => {
      const helpParsed = parseChatCommand('/effort help');
      expect(helpParsed).not.toBeNull();
      expect(helpParsed?.subcommand).toBe('unknown');

      const multiArgParsed = parseChatCommand('/effort high extra');
      expect(multiArgParsed).not.toBeNull();
      expect(multiArgParsed?.subcommand).toBe('unknown');
    });

    it('parses /help command', () => {
      const parsed = parseChatCommand('/help');
      expect(parsed).not.toBeNull();
      expect(parsed?.command).toBe('help');
      expect(parsed?.type).toBe('help');
      expect(parsed?.subcommand).toBe('show');

      const wsParsed = parseChatCommand('   /help   ');
      expect(wsParsed).not.toBeNull();
      expect(wsParsed?.command).toBe('help');
    });

    it('parses /status command', () => {
      const parsed = parseChatCommand('/status');
      expect(parsed).not.toBeNull();
      expect(parsed?.command).toBe('status');
      expect(parsed?.type).toBe('status');
      expect(parsed?.subcommand).toBe('show');

      const wsParsed = parseChatCommand('   /status   ');
      expect(wsParsed).not.toBeNull();
      expect(wsParsed?.command).toBe('status');
    });

    it('parses /stop command', () => {
      const parsed = parseChatCommand('/stop');
      expect(parsed).not.toBeNull();
      expect(parsed?.command).toBe('stop');
      expect(parsed?.type).toBe('stop');
      expect(parsed?.subcommand).toBe('stop');

      const wsParsed = parseChatCommand('   /stop   ');
      expect(wsParsed).not.toBeNull();
      expect(wsParsed?.command).toBe('stop');
    });

    it('parses /new and aliases /reset and /clear', () => {
      const newParsed = parseChatCommand('/new');
      expect(newParsed).not.toBeNull();
      expect(newParsed?.command).toBe('new');
      expect(newParsed?.type).toBe('new');

      const resetParsed = parseChatCommand('/reset');
      expect(resetParsed).not.toBeNull();
      expect(resetParsed?.command).toBe('session');
      expect(resetParsed?.subcommand).toBe('clear');

      const clearParsed = parseChatCommand('/clear');
      expect(clearParsed).not.toBeNull();
      expect(clearParsed?.command).toBe('session');
      expect(clearParsed?.subcommand).toBe('clear');

      const wsParsed = parseChatCommand('   /new   ');
      expect(wsParsed).not.toBeNull();
      expect(wsParsed?.command).toBe('new');
    });

    it('parses /sw and /spawn commands with aliases, case-insensitivity, and arguments', () => {
      const emptySw = parseChatCommand('/sw');
      expect(emptySw).not.toBeNull();
      expect(emptySw?.command).toBe('spawn');
      expect(emptySw?.subcommand).toBe('show');

      const emptySpawn = parseChatCommand('/spawn');
      expect(emptySpawn).not.toBeNull();
      expect(emptySpawn?.command).toBe('spawn');
      expect(emptySpawn?.subcommand).toBe('show');

      const swWithArg = parseChatCommand('/sw run parallel analysis on dataset');
      expect(swWithArg).not.toBeNull();
      expect(swWithArg?.command).toBe('spawn');
      expect(swWithArg?.subcommand).toBe('spawn');
      expect(swWithArg?.arg).toBe('run parallel analysis on dataset');

      const spawnWithArg = parseChatCommand('/spawn perform background audit');
      expect(spawnWithArg).not.toBeNull();
      expect(spawnWithArg?.command).toBe('spawn');
      expect(spawnWithArg?.subcommand).toBe('spawn');
      expect(spawnWithArg?.arg).toBe('perform background audit');

      const caseInsensitiveSw = parseChatCommand('/SW test uppercase SW');
      expect(caseInsensitiveSw).not.toBeNull();
      expect(caseInsensitiveSw?.command).toBe('spawn');
      expect(caseInsensitiveSw?.arg).toBe('test uppercase SW');

      const caseInsensitiveSpawn = parseChatCommand('/SPAWN test uppercase SPAWN');
      expect(caseInsensitiveSpawn).not.toBeNull();
      expect(caseInsensitiveSpawn?.command).toBe('spawn');
      expect(caseInsensitiveSpawn?.arg).toBe('test uppercase SPAWN');
    });

    it('returns null for regular messages and non-matching commands', () => {
      expect(parseChatCommand('hello world')).toBeNull();
      expect(parseChatCommand('/unknown_cmd')).toBeNull();
      expect(parseChatCommand('/other command')).toBeNull();
      expect(parseChatCommand('')).toBeNull();
      expect(parseChatCommand(null)).toBeNull();
      expect(parseChatCommand(undefined)).toBeNull();
      expect(parseChatCommand(123)).toBeNull();
    });

    it('respects word boundary: rejects /modeling, /effortless, /models, /helpful, /statuses, /stopping, /newbie, /swift, /spawning', () => {
      expect(parseChatCommand('/modeling')).toBeNull();
      expect(parseChatCommand('/effortless')).toBeNull();
      expect(parseChatCommand('/models')).toBeNull();
      expect(parseChatCommand('/model_test')).toBeNull();
      expect(parseChatCommand('/helpful')).toBeNull();
      expect(parseChatCommand('/statuses')).toBeNull();
      expect(parseChatCommand('/stopping')).toBeNull();
      expect(parseChatCommand('/newbie')).toBeNull();
      expect(parseChatCommand('/resetting')).toBeNull();
      expect(parseChatCommand('/cleared')).toBeNull();
      expect(parseChatCommand('/swift')).toBeNull();
      expect(parseChatCommand('/spawning')).toBeNull();
    });
  });

  // =========================================================================
  // 2. ChatCommandService Unit Tests with Real ModelSelectionService & DB
  // =========================================================================
  describe('2. ChatCommandService with real ModelSelectionService and stubbed catalog', () => {
    let db: DatabaseSync;
    let modelSelectionService: ModelSelectionService;
    let chatCommandService: ChatCommandService;

    const userId = 'u_alice';
    const spaceId = 'spc_001';
    const sessionId = 'ses_001';

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
            {
              id: 'ambiguous-model',
            },
          ],
        },
        anthropic: {
          id: 'anthropic',
          api: 'anthropic',
          configured: true,
          models: [
            {
              id: 'claude-3-5-sonnet',
              reasoningEfforts: { low: null, high: null },
            },
            {
              id: 'ambiguous-model',
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

      db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, 'alice', 'hash', 'user')").run(userId);
      db.prepare("INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES (?, ?, 'Space 1', 'spc-1', 'container')").run(spaceId, userId);
      db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, current_generation) VALUES (?, ?, ?, 'web', 'acc-1', 'ses1', 'p1', 'dsh1', 'container', 1)").run(sessionId, userId, spaceId);

      modelSelectionService = new ModelSelectionService({ db });
      vi.spyOn(modelSelectionService, 'getDshCatalog').mockReturnValue(stubCatalog);
      chatCommandService = new ChatCommandService(modelSelectionService);
    });

    it('shows current effective model with /model (no arg)', async () => {
      const result = await chatCommandService.execute({
        userId,
        sessionId,
        spaceId,
        content: '/model',
      });
      expect(result.replyText).toContain('openai/gpt-4o');
      expect(result.replyText).toContain('effort: low');
    });

    it('lists catalog models and marks effective model with /model list', async () => {
      const result = await chatCommandService.execute({
        userId,
        sessionId,
        spaceId,
        content: '/model list',
      });
      const lines = result.replyText.split('\n');
      expect(lines).toContain('* openai/gpt-4o (dsh_default, effort: low)');
      expect(lines).toContain('openai/gpt-4o-mini');
      expect(lines).toContain('anthropic/claude-3-5-sonnet');
    });

    it('sets session override with /model <provider/model> and keeps compatible effort', async () => {
      // Effective effort is 'low', which is supported by anthropic/claude-3-5-sonnet
      const result = await chatCommandService.execute({
        userId,
        sessionId,
        spaceId,
        content: '/model anthropic/claude-3-5-sonnet',
      });
      expect(result.replyText).toContain('Session model set to anthropic/claude-3-5-sonnet');
      expect(result.replyText).toContain('effort: low');

      const override = await modelSelectionService.getOverride('session', sessionId);
      expect(override).not.toBeNull();
      expect(override?.provider).toBe('anthropic');
      expect(override?.model).toBe('claude-3-5-sonnet');
      expect(override?.reasoningEffort).toBe('low');
    });

    it('sets session override with bare modelId and resets incompatible effort to null with notice', async () => {
      // First set effort to medium on openai/gpt-4o
      await modelSelectionService.setOverride(userId, 'session', sessionId, {
        provider: 'openai',
        model: 'gpt-4o',
        reasoningEffort: 'medium',
        fallbackChain: null,
      });

      // Now switch to claude-3-5-sonnet (which only supports low, high - not medium)
      const result = await chatCommandService.execute({
        userId,
        sessionId,
        spaceId,
        content: '/model claude-3-5-sonnet',
      });

      expect(result.replyText).toContain('Session model set to anthropic/claude-3-5-sonnet');
      expect(result.replyText).toContain('Reasoning effort "medium" is not supported');

      const override = await modelSelectionService.getOverride('session', sessionId);
      expect(override?.reasoningEffort).toBeNull();
    });

    it('resets session override with /model reset', async () => {
      await modelSelectionService.setOverride(userId, 'session', sessionId, {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        reasoningEffort: 'high',
        fallbackChain: null,
      });

      const result = await chatCommandService.execute({
        userId,
        sessionId,
        spaceId,
        content: '/model reset',
      });
      expect(result.replyText).toContain('Session model override reset');

      const override = await modelSelectionService.getOverride('session', sessionId);
      expect(override).toBeNull();
    });

    it('handles ambiguous bare modelId with candidate reply', async () => {
      const result = await chatCommandService.execute({
        userId,
        sessionId,
        spaceId,
        content: '/model ambiguous-model',
      });
      expect(result.replyText).toContain('ambiguous across providers');
      expect(result.replyText).toContain('openai/ambiguous-model');
      expect(result.replyText).toContain('anthropic/ambiguous-model');
    });

    it('handles unknown subcommand with short usage text', async () => {
      const modelUnknown = await chatCommandService.execute({
        userId,
        sessionId,
        spaceId,
        content: '/model invalid subcommand',
      });
      expect(modelUnknown.replyText).toContain('Usage:');
      expect(modelUnknown.replyText).toContain('/model list');

      const effortUnknown = await chatCommandService.execute({
        userId,
        sessionId,
        spaceId,
        content: '/effort',
      });
      expect(effortUnknown.replyText).toContain('Usage:');
      expect(effortUnknown.replyText).toContain('/effort list');
    });

    it('handles /effort list with supported efforts and current effort', async () => {
      const result = await chatCommandService.execute({
        userId,
        sessionId,
        spaceId,
        content: '/effort list',
      });
      expect(result.replyText).toContain('Supported efforts for openai/gpt-4o: low, medium, high');
      expect(result.replyText).toContain('Current effort: low');
    });

    it('handles /effort list on model with no effort options', async () => {
      await modelSelectionService.setOverride(userId, 'session', sessionId, {
        provider: 'openai',
        model: 'gpt-4o-mini',
        reasoningEffort: null,
        fallbackChain: null,
      });

      const result = await chatCommandService.execute({
        userId,
        sessionId,
        spaceId,
        content: '/effort list',
      });
      expect(result.replyText).toContain('has no effort options');
    });

    it('sets reasoning effort with /effort <name>', async () => {
      const result = await chatCommandService.execute({
        userId,
        sessionId,
        spaceId,
        content: '/effort high',
      });
      expect(result.replyText).toContain('Reasoning effort set to "high"');

      const override = await modelSelectionService.getOverride('session', sessionId);
      expect(override?.reasoningEffort).toBe('high');
    });

    it('turns ValidationError into user-facing reply without throwing', async () => {
      const result = await chatCommandService.execute({
        userId,
        sessionId,
        spaceId,
        content: '/effort invalid_effort',
      });
      expect(result.replyText).toContain('is not supported for model');
    });

    it('resets reasoning effort with /effort reset', async () => {
      // Set override first
      await modelSelectionService.setOverride(userId, 'session', sessionId, {
        provider: 'openai',
        model: 'gpt-4o',
        reasoningEffort: 'high',
        fallbackChain: null,
      });

      const result = await chatCommandService.execute({
        userId,
        sessionId,
        spaceId,
        content: '/effort reset',
      });
      expect(result.replyText).toContain('Reasoning effort reset');

      const override = await modelSelectionService.getOverride('session', sessionId);
      expect(override?.reasoningEffort).toBeNull();
      expect(override?.model).toBe('gpt-4o');
    });

    it('handles /effort reset when no session override exists (no-op)', async () => {
      const result = await chatCommandService.execute({
        userId,
        sessionId,
        spaceId,
        content: '/effort reset',
      });
      expect(result.replyText).toContain('No session override active');
    });

    it('handles /help command with full command list', async () => {
      const result = await chatCommandService.execute({
        userId,
        sessionId,
        spaceId,
        content: '/help',
      });
      expect(result.replyText).toContain('Available commands:');
      expect(result.replyText).toContain('/help');
      expect(result.replyText).toContain('/status');
      expect(result.replyText).toContain('/new');
      expect(result.replyText).toContain('/stop');
      expect(result.replyText).toContain('/model');
      expect(result.replyText).toContain('/effort');
    });

    it('handles /status command with space, session, generation, model, turn, last activity', async () => {
      const result = await chatCommandService.execute({
        userId,
        sessionId,
        spaceId,
        content: '/status',
      });
      const lines = result.replyText.split('\n');
      expect(lines.some((l) => l.startsWith('space:'))).toBe(true);
      expect(lines.some((l) => l.startsWith('session:'))).toBe(true);
      expect(lines.some((l) => l.startsWith('generation:'))).toBe(true);
      expect(lines.some((l) => l.startsWith('model:'))).toBe(true);
      expect(lines.some((l) => l.startsWith('turn:'))).toBe(true);
      expect(lines.some((l) => l.startsWith('last activity:'))).toBe(true);
      expect(result.replyText).toContain('openai/gpt-4o');
      expect(result.replyText).toContain('turn: idle');
    });

    it('handles /stop command when a turn is running vs idle', async () => {
      let turnRunning = false;
      const stubGateway = {
        cancelCurrentTurn: vi.fn(async () => turnRunning),
        getCurrentTurnStatus: vi.fn(async () => (turnRunning ? { status: 'running' } : null)),
      };
      chatCommandService.setGateway(stubGateway);

      // Nothing running
      const idleRes = await chatCommandService.execute({
        userId,
        sessionId,
        spaceId,
        content: '/stop',
      });
      expect(idleRes.replyText).toBe('nothing running');
      expect(stubGateway.cancelCurrentTurn).toHaveBeenCalledWith(userId, sessionId);

      // Turn running
      turnRunning = true;
      const runningRes = await chatCommandService.execute({
        userId,
        sessionId,
        spaceId,
        content: '/stop',
      });
      expect(runningRes.replyText).toBe('cancelled');
    });

    it('handles /new (and aliases /reset, /clear) when turn is active vs idle', async () => {
      let turnActive = true;
      const stubGateway = {
        cancelCurrentTurn: vi.fn(async () => true),
        getCurrentTurnStatus: vi.fn(async () => (turnActive ? { status: 'running' } : null)),
      };
      let currentGen = 1;
      const stubPlatformApi = {
        resetSession: vi.fn(async (_uId: string, _sId: string, opts: any) => {
          currentGen += 1;
          return {
            session: {},
            generation: { generation: currentGen, resetReason: opts.reason },
          };
        }),
      };

      chatCommandService.setGateway(stubGateway);
      chatCommandService.setPlatformApi(stubPlatformApi);

      // 1. When turn is active
      const activeRes = await chatCommandService.execute({
        userId,
        sessionId,
        spaceId,
        content: '/reset',
      });
      expect(activeRes.replyText).toBe('a turn is active, use /stop first');
      expect(stubPlatformApi.resetSession).not.toHaveBeenCalled();

      // Same rejection on /clear alias
      const clearAliasRes = await chatCommandService.execute({
        userId,
        sessionId,
        spaceId,
        content: '/clear',
      });
      expect(clearAliasRes.replyText).toBe('a turn is active, use /stop first');

      // /new returns hint and changes nothing
      const newRes = await chatCommandService.execute({
        userId,
        sessionId,
        spaceId,
        content: '/new',
      });
      expect(newRes.replyText).toBe('新会话请使用 /session new，新建工作区请使用 /ws new');

      // 2. When idle
      turnActive = false;
      const idleRes = await chatCommandService.execute({
        userId,
        sessionId,
        spaceId,
        content: '/reset',
        idempotencyKey: '00000000-0000-4000-8000-000000000001',
      });
      expect(idleRes.replyText).toBe('Started generation 2 (was 1)');
      expect(stubPlatformApi.resetSession).toHaveBeenCalledWith(
        userId,
        sessionId,
        expect.objectContaining({
          idempotencyKey: '00000000-0000-4000-8000-000000000001',
          reason: 'chat_command',
        })
      );

      // Test /reset alias when idle
      const resetRes = await chatCommandService.execute({
        userId,
        sessionId,
        spaceId,
        content: '/reset',
      });
      expect(resetRes.replyText).toBe('Started generation 3 (was 2)');

      // Test /clear alias when idle
      const clearRes = await chatCommandService.execute({
        userId,
        sessionId,
        spaceId,
        content: '/clear',
      });
      expect(clearRes.replyText).toBe('Started generation 4 (was 3)');
    });

    it('handles /sw and /spawn commands: empty usage, task creation, and receipt formatting', async () => {
      // 1. Empty args returns usage
      const emptySwRes = await chatCommandService.execute({
        userId,
        sessionId,
        spaceId,
        content: '/sw',
      });
      expect(emptySwRes.replyText).toBe('用法: /sw <任务描述>\n在当前工作区创建并行任务');

      const emptySpawnRes = await chatCommandService.execute({
        userId,
        sessionId,
        spaceId,
        content: '/spawn',
      });
      expect(emptySpawnRes.replyText).toBe('用法: /sw <任务描述>\n在当前工作区创建并行任务');

      // 2. Task creation with mock taskOperations
      let capturedInput: any = null;
      const stubTaskOperations = vi.fn((_uId: string) => ({
        createTask: vi.fn(async (input: any) => {
          capturedInput = input;
          return {
            task: {
              id: 'task_abcd1234ef567890',
              title: input.title,
              status: 'pending',
            },
            isIdempotentHit: false,
          };
        }),
      }));

      chatCommandService.setTaskOperations(stubTaskOperations);

      const spawnRes = await chatCommandService.execute({
        userId,
        sessionId,
        spaceId,
        content: '/sw parallel benchmark',
      });

      expect(spawnRes.replyText).toBe('⚡ 并行任务已启动 [abcd]: parallel benchmark');
      expect(stubTaskOperations).toHaveBeenCalledWith(userId);
      expect(capturedInput).toEqual({
        title: '⚡ parallel benchmark',
        payload: {
          type: 'agent_prompt',
          prompt: 'parallel benchmark',
          sessionId,
          spaceId,
          sessionPolicy: 'isolated',
          contextMode: 'isolated',
        },
        scheduleType: 'once',
      });
      // Verify validator accepts default medium priority when priority is omitted
      expect(validateTaskPriority(capturedInput.priority ?? 'medium')).toBe('medium');

      // 3. Truncation of task description > 30 chars
      const longPrompt = 'this is a very long prompt description exceeding thirty characters threshold';
      const longSpawnRes = await chatCommandService.execute({
        userId,
        sessionId,
        spaceId,
        content: `/spawn ${longPrompt}`,
      });

      const expectedTruncated = longPrompt.slice(0, 30) + '…';
      expect(longSpawnRes.replyText).toBe(`⚡ 并行任务已启动 [abcd]: ${expectedTruncated}`);
      expect(capturedInput.title).toBe(`⚡ ${expectedTruncated}`);
    });

    it('proves /sw creates and persists task through real TaskOperationService with valid default priority', async () => {
      const db = new DatabaseSync(':memory:');
      const runner = new PlatformServerMigrationRunner(db);
      await runner.migrate(ALL_PLATFORM_MIGRATIONS);

      const userId = 'u_test_real_ops';
      const spaceId = 'spc_11112222333344445555666677778888';
      const sessionId = 'ses_aaaabbbbccccddddeeeeffff00001111';

      db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, 'tester', 'hash', 'user')").run(userId);
      db.prepare("INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES (?, ?, 'Space Test', 'spc-t', 'container')").run(spaceId, userId);
      db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, current_generation) VALUES (?, ?, ?, 'web', 'acc-1', 'ses1', 'p1', 'dsh1', 'container', 1)").run(sessionId, userId, spaceId);

      const opsStorage = new SqlitePlatformOperationsStorage(db);
      const opsService = new PlatformOperationsService({ storage: opsStorage });

      const modelSelectionService = new ModelSelectionService({ db });
      const chatCommandService = new ChatCommandService({
        modelSelectionService,
        taskOperations: (uId: string) => opsService.forTenant(uId).tasks,
      });

      const cmdRes = await chatCommandService.execute({
        userId,
        sessionId,
        spaceId,
        content: '/sw benchmark task',
      });

      expect(cmdRes.replyText).toMatch(/^⚡ 并行任务已启动 \[([0-9a-f]{4})\]: benchmark task$/);
      const match = cmdRes.replyText.match(/^⚡ 并行任务已启动 \[([0-9a-f]{4})\]/);
      expect(match).not.toBeNull();
      const shortId = match![1];

      // Verify task actually persisted in SQLite platform_tasks table with valid default medium priority
      const rows = db.prepare('SELECT * FROM platform_tasks WHERE user_id = ?').all(userId) as any[];
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.id).toBeDefined();
      expect(row.id.startsWith('task_')).toBe(true);
      expect(row.id.slice(5, 9)).toBe(shortId);
      expect(row.title).toBe('⚡ benchmark task');
      expect(row.priority).toBe('medium');
      expect(row.status).toBe('pending');
      expect(row.schedule_type).toBe('once');

      // Verify task retrieval via real TaskOperationService
      const fetchedTask = await opsService.forTenant(userId).tasks.getTask(row.id);
      expect(fetchedTask).toBeDefined();
      expect(fetchedTask?.priority).toBe('medium');
      expect(fetchedTask?.payload.prompt).toBe('benchmark task');
      expect(fetchedTask?.payload.sessionPolicy).toBe('isolated');
      expect(fetchedTask?.payload.contextMode).toBe('isolated');
    });

    it('rejects invalid priority "normal" in validator and ensures omission defaults to medium', () => {
      expect(() => validateTaskPriority('normal')).toThrow('Invalid task priority');
      expect(validateTaskPriority('medium')).toBe('medium');
      expect(validateTaskPriority('low')).toBe('low');
      expect(validateTaskPriority('high')).toBe('high');
      expect(validateTaskPriority('urgent')).toBe('urgent');
    });
  });

  // =========================================================================
  // 3. Gateway-Level Integration Test
  // =========================================================================
  describe('3. Gateway-level test: dispatchInbound with /effort high', () => {
    it('does NOT call runtime executor and persists reply visible in web history', async () => {
      const db = new DatabaseSync(':memory:');
      const runner = new PlatformServerMigrationRunner(db);
      await runner.migrate(ALL_PLATFORM_MIGRATIONS);

      const userId = 'u_test';
      const spaceId = 'spc_test';
      const sessionId = 'ses_test';

      db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, 'tester', 'hash', 'user')").run(userId);
      db.prepare("INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES (?, ?, 'Space Test', 'spc-t', 'container')").run(spaceId, userId);
      db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, current_generation) VALUES (?, ?, ?, 'web', 'acc-1', 'ses1', 'p1', 'dsh1', 'container', 1)").run(sessionId, userId, spaceId);

      const storage = new SqlitePlatformStorage(db);
      const messageStore = new SqliteWebMessageStore(db);
      const profileResolver = { resolve: async () => null };

      const modelSelectionService = new ModelSelectionService({ db });
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
      vi.spyOn(modelSelectionService, 'getDshCatalog').mockReturnValue(stubCatalog);

      let executorCalled = false;
      const executor = {
        execute: async () => {
          executorCalled = true;
          return { replyText: 'runtime reply', usage: { totalTokens: 50 } };
        },
        cancel: async () => true,
      };

      const gateway = new DeliveryRuntimeGateway({
        storage,
        messageStore,
        database: db,
        quotaMode: 'disabled',
        executor,
        profileResolver,
        modelSelectionService,
      });

      let turnCompletedEvent: any = null;
      gateway.onTurnCompleted((event) => {
        turnCompletedEvent = event;
      });

      const deliveryId = 'deliv_cmd_test_001';
      const dispatchResult = await gateway.dispatchInbound({
        id: deliveryId,
        channel: 'web',
        userId,
        sessionId,
        content: '/effort high',
        timestamp: new Date().toISOString(),
      });

      // 1. Assert dispatch result was accepted as completed turn
      expect(dispatchResult.accepted).toBe(true);
      expect(dispatchResult.isDuplicate).toBe(false);
      expect(dispatchResult.turnId).toBeDefined();

      // 2. Assert runtime executor was NOT called
      expect(executorCalled).toBe(false);

      // 3. Assert turn completed listeners were notified (for Lark)
      expect(turnCompletedEvent).not.toBeNull();
      expect(turnCompletedEvent.turnId).toBe(dispatchResult.turnId);
      expect(turnCompletedEvent.executionResult.replyText).toContain('Reasoning effort set to "high"');

      // 4. Assert reply is persisted and visible via Web message history
      const history = await messageStore.listMessages(userId, sessionId);
      expect(history.messages.length).toBe(2);

      const userMsg = history.messages.find((m) => m.role === 'user');
      const assistantMsg = history.messages.find((m) => m.role === 'assistant');

      expect(userMsg).toBeDefined();
      expect(userMsg?.content).toBe('/effort high');
      expect(userMsg?.status).toBe('delivered');

      expect(assistantMsg).toBeDefined();
      expect(assistantMsg?.content).toContain('Reasoning effort set to "high"');
      expect(assistantMsg?.status).toBe('delivered');

      // 5. Assert idempotency key is consumed (retry returns duplicate without execution)
      const retryResult = await gateway.dispatchInbound({
        id: deliveryId,
        channel: 'web',
        userId,
        sessionId,
        content: '/effort high',
        timestamp: new Date().toISOString(),
      });

      expect(retryResult.isDuplicate).toBe(true);
      expect(retryResult.turnId).toBe(dispatchResult.turnId);
      expect(executorCalled).toBe(false);
    });

    it('handles gateway-level /stop while turn is active: cancel called and reply persisted', async () => {
      const db = new DatabaseSync(':memory:');
      const runner = new PlatformServerMigrationRunner(db);
      await runner.migrate(ALL_PLATFORM_MIGRATIONS);

      const userId = 'u_test_stop';
      const spaceId = 'spc_test_stop';
      const sessionId = 'ses_test_stop';

      db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, 'tester', 'hash', 'user')").run(userId);
      db.prepare("INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES (?, ?, 'Space Test', 'spc-t', 'container')").run(spaceId, userId);
      db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, current_generation) VALUES (?, ?, ?, 'web', 'acc-1', 'ses1', 'p1', 'dsh1', 'container', 1)").run(sessionId, userId, spaceId);

      const storage = new SqlitePlatformStorage(db);
      const messageStore = new SqliteWebMessageStore(db);
      const profileResolver = { resolve: async () => null };
      const modelSelectionService = new ModelSelectionService({ db });

      let cancelCalled = false;
      const executor = {
        execute: async () => ({ replyText: 'runtime reply', usage: { totalTokens: 50 } }),
        cancel: async () => {
          cancelCalled = true;
          return true;
        },
      };

      const gateway = new DeliveryRuntimeGateway({
        storage,
        messageStore,
        database: db,
        quotaMode: 'disabled',
        executor,
        profileResolver,
        modelSelectionService,
      });

      // Insert an active running turn into turn_runs and delivery_inbox
      const activeTurnId = 'turn_fake_active_001';
      db.prepare(`
        INSERT INTO delivery_inbox (id, user_id, route_id, message_id, delivery_id, payload, status, turn_id, created_at, updated_at)
        VALUES ('inbox_fake_1', ?, ?, 'msg_fake_1', 'deliv_fake_1', '{}', 'processing', ?, datetime('now'), datetime('now'))
      `).run(userId, sessionId, activeTurnId);

      db.prepare(`
        INSERT INTO turn_runs (id, turn_id, space_id, route_id, user_id, execution_mode, status, created_at, updated_at)
        VALUES ('run_fake_1', ?, ?, ?, ?, 'runtime', 'running', datetime('now'), datetime('now'))
      `).run(activeTurnId, spaceId, sessionId, userId);

      const dispatchResult = await gateway.dispatchInbound({
        id: 'deliv_stop_001',
        channel: 'web',
        userId,
        sessionId,
        content: '/stop',
        timestamp: new Date().toISOString(),
      });

      expect(dispatchResult.accepted).toBe(true);
      expect(cancelCalled).toBe(true);

      const history = await messageStore.listMessages(userId, sessionId);
      const assistantMsg = history.messages.find((m) => m.role === 'assistant');
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg?.content).toBe('cancelled');
    });

    it('handles gateway-level /new: reset called with reason chat_command and generation increments', async () => {
      const db = new DatabaseSync(':memory:');
      const runner = new PlatformServerMigrationRunner(db);
      await runner.migrate(ALL_PLATFORM_MIGRATIONS);

      const userId = 'u_test_new';
      const spaceId = 'spc_test_new';
      const sessionId = 'ses_test_new';

      db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, 'tester', 'hash', 'user')").run(userId);
      db.prepare("INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES (?, ?, 'Space Test', 'spc-t', 'container')").run(spaceId, userId);
      db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, current_generation, reset_count) VALUES (?, ?, ?, 'web', 'acc-1', 'ses1', 'p1', 'dsh1', 'container', 1, 0)").run(sessionId, userId, spaceId);

      const storage = new SqlitePlatformStorage(db);
      const messageStore = new SqliteWebMessageStore(db);
      const profileResolver = { resolve: async () => null };
      const modelSelectionService = new ModelSelectionService({ db });

      const executor = {
        execute: async () => ({ replyText: 'runtime reply', usage: { totalTokens: 50 } }),
        cancel: async () => true,
      };

      let resetOptsCaptured: any = null;
      const resetSessionSpy = vi.fn(async (_uId: string, _sId: string, opts: any) => {
        resetOptsCaptured = opts;
        // Bump current_generation in db
        db.prepare('UPDATE session_routes SET current_generation = 2 WHERE id = ?').run(sessionId);
        return {
          session: {},
          generation: { generation: 2, resetReason: opts.reason },
        };
      });

      const gateway = new DeliveryRuntimeGateway({
        storage,
        messageStore,
        database: db,
        quotaMode: 'disabled',
        executor,
        profileResolver,
        modelSelectionService,
        chatCommandDeps: {
          resetSession: resetSessionSpy,
        },
      });

      const dispatchResult = await gateway.dispatchInbound({
        id: 'deliv_new_001',
        channel: 'web',
        userId,
        sessionId,
        content: '/session clear',
        timestamp: new Date().toISOString(),
      });

      expect(dispatchResult.accepted).toBe(true);
      expect(resetSessionSpy).toHaveBeenCalledTimes(1);
      expect(resetOptsCaptured.reason).toBe('chat_command');

      // Assert generation in db is now 2
      const routeRow = db.prepare('SELECT current_generation FROM session_routes WHERE id = ?').get(sessionId) as any;
      expect(routeRow.current_generation).toBe(2);

      // Assert reply in messageStore is "Started generation 2 (was 1)"
      const history = await messageStore.listMessages(userId, sessionId);
      const assistantMsg = history.messages.find((m) => m.role === 'assistant');
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg?.content).toBe('Started generation 2 (was 1)');

      // Verify the synthetic turn was recorded
      const turnRun = db.prepare('SELECT * FROM turn_runs WHERE turn_id = ?').get(dispatchResult.turnId) as any;
      expect(turnRun).toBeDefined();
      expect(turnRun.execution_mode).toBe('command');
      expect(turnRun.status).toBe('completed');
    });

    it('handles gateway-level /sw: creates task and persists receipt without invoking turn executor', async () => {
      const db = new DatabaseSync(':memory:');
      const runner = new PlatformServerMigrationRunner(db);
      await runner.migrate(ALL_PLATFORM_MIGRATIONS);

      const userId = 'u_test_sw';
      const spaceId = 'spc_test_sw';
      const sessionId = 'ses_test_sw';

      db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, 'tester', 'hash', 'user')").run(userId);
      db.prepare("INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES (?, ?, 'Space Test', 'spc-t', 'container')").run(spaceId, userId);
      db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, current_generation) VALUES (?, ?, ?, 'web', 'acc-1', 'ses1', 'p1', 'dsh1', 'container', 1)").run(sessionId, userId, spaceId);

      const storage = new SqlitePlatformStorage(db);
      const messageStore = new SqliteWebMessageStore(db);
      const profileResolver = { resolve: async () => null };
      const modelSelectionService = new ModelSelectionService({ db });

      const executor = {
        execute: vi.fn(async () => ({ replyText: 'runtime reply', usage: { totalTokens: 50 } })),
        cancel: async () => true,
      };

      let taskCreatedPayload: any = null;
      const stubCreateTask = vi.fn(async (_uId: string, input: any) => {
        taskCreatedPayload = input;
        return {
          task: {
            id: 'task_e3f211009988aabb',
            title: input.title,
            status: 'pending',
          },
          isIdempotentHit: false,
        };
      });

      const gateway = new DeliveryRuntimeGateway({
        storage,
        messageStore,
        database: db,
        quotaMode: 'disabled',
        executor,
        profileResolver,
        modelSelectionService,
        chatCommandDeps: {
          createTask: stubCreateTask,
        },
      });

      const dispatchResult = await gateway.dispatchInbound({
        id: 'deliv_sw_001',
        channel: 'web',
        userId,
        sessionId,
        content: '/sw analyze database performance in background',
        timestamp: new Date().toISOString(),
      });

      expect(dispatchResult.accepted).toBe(true);
      expect(dispatchResult.executionMode).toBe('command');
      expect(executor.execute).not.toHaveBeenCalled();
      expect(stubCreateTask).toHaveBeenCalledTimes(1);
      expect(taskCreatedPayload.payload.sessionPolicy).toBe('isolated');
      expect(taskCreatedPayload.payload.prompt).toBe('analyze database performance in background');

      // Assert receipt message persisted
      const history = await messageStore.listMessages(userId, sessionId);
      const assistantMsg = history.messages.find((m) => m.role === 'assistant');
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg?.content).toBe('⚡ 并行任务已启动 [e3f2]: analyze database performance i…');

      // Verify turn_runs record
      const turnRun = db.prepare('SELECT * FROM turn_runs WHERE turn_id = ?').get(dispatchResult.turnId) as any;
      expect(turnRun).toBeDefined();
      expect(turnRun.execution_mode).toBe('command');
      expect(turnRun.status).toBe('completed');
    });

    it('handles gateway-level /sw with real TaskOperationService: creates and persists task in database', async () => {
      const db = new DatabaseSync(':memory:');
      const runner = new PlatformServerMigrationRunner(db);
      await runner.migrate(ALL_PLATFORM_MIGRATIONS);

      const userId = 'u_test_gw_real';
      const spaceId = 'spc_22223333444455556666777788889999';
      const sessionId = 'ses_bbbbccccddddeeeeffff000011112222';

      db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, 'tester', 'hash', 'user')").run(userId);
      db.prepare("INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES (?, ?, 'Space Test', 'spc-t', 'container')").run(spaceId, userId);
      db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, current_generation) VALUES (?, ?, ?, 'web', 'acc-1', 'ses1', 'p1', 'dsh1', 'container', 1)").run(sessionId, userId, spaceId);

      const storage = new SqlitePlatformStorage(db);
      const messageStore = new SqliteWebMessageStore(db);
      const profileResolver = { resolve: async () => null };
      const modelSelectionService = new ModelSelectionService({ db });
      const opsStorage = new SqlitePlatformOperationsStorage(db);
      const opsService = new PlatformOperationsService({ storage: opsStorage });

      const executor = {
        execute: vi.fn(async () => ({ replyText: 'runtime reply', usage: { totalTokens: 50 } })),
        cancel: async () => true,
      };

      const gateway = new DeliveryRuntimeGateway({
        storage,
        messageStore,
        database: db,
        quotaMode: 'disabled',
        executor,
        profileResolver,
        modelSelectionService,
        chatCommandDeps: {
          taskOperations: (uId: string) => opsService.forTenant(uId).tasks,
        },
      });

      const dispatchResult = await gateway.dispatchInbound({
        id: 'deliv_sw_real_001',
        channel: 'web',
        userId,
        sessionId,
        content: '/sw gateway task',
        timestamp: new Date().toISOString(),
      });

      expect(dispatchResult.accepted).toBe(true);
      expect(dispatchResult.executionMode).toBe('command');
      expect(executor.execute).not.toHaveBeenCalled();

      // Verify task row persisted in platform_tasks via real TaskOperationService
      const tasks = await opsService.forTenant(userId).tasks.listTasks();
      expect(tasks).toHaveLength(1);
      const persistedTask = tasks[0];
      expect(persistedTask.title).toBe('⚡ gateway task');
      expect(persistedTask.priority).toBe('medium');
      expect(persistedTask.status).toBe('pending');

      // Verify receipt message persisted in messageStore
      const history = await messageStore.listMessages(userId, sessionId);
      const assistantMsg = history.messages.find((m) => m.role === 'assistant');
      expect(assistantMsg).toBeDefined();
      const shortId = persistedTask.id.slice(5, 9);
      expect(assistantMsg?.content).toBe(`⚡ 并行任务已启动 [${shortId}]: gateway task`);
    });
  });
});
