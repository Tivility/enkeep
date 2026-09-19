import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
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

    it('returns null for regular messages and non-matching commands', () => {
      expect(parseChatCommand('hello world')).toBeNull();
      expect(parseChatCommand('/help')).toBeNull();
      expect(parseChatCommand('/other command')).toBeNull();
      expect(parseChatCommand('')).toBeNull();
      expect(parseChatCommand(null)).toBeNull();
      expect(parseChatCommand(undefined)).toBeNull();
      expect(parseChatCommand(123)).toBeNull();
    });

    it('respects word boundary: rejects /modeling, /effortless, /models', () => {
      expect(parseChatCommand('/modeling')).toBeNull();
      expect(parseChatCommand('/effortless')).toBeNull();
      expect(parseChatCommand('/models')).toBeNull();
      expect(parseChatCommand('/model_test')).toBeNull();
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
  });
});
