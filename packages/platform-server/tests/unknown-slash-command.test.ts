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
import {
  parseChatCommand,
  parseUnknownChatCommand,
  formatUnknownCommandReply,
  findClosestCommand,
  levenshteinDistance,
  ChatCommandService,
} from '../src/chat/chat-command-service.js';

describe('Item A: Unknown Slash Command Interception (Synthetic Tests)', () => {
  describe('1. Table-driven Pattern Interception & Suggestion Tests', () => {
    interface TestCase {
      input: string;
      intercepted: boolean;
      expectedWord?: string;
      expectedClosest?: string | null;
      expectedReply?: string;
    }

    const testCases: TestCase[] = [
      // Intercepted with suggestion (distance <= 2)
      {
        input: '/stopp',
        intercepted: true,
        expectedWord: 'stopp',
        expectedClosest: 'stop',
        expectedReply: '未知指令 /stopp。你是不是想用 /stop？发送 /help 查看全部指令。',
      },
      {
        input: '/models',
        intercepted: true,
        expectedWord: 'models',
        expectedClosest: 'model',
        expectedReply: '未知指令 /models。你是不是想用 /model？发送 /help 查看全部指令。',
      },
      {
        input: '/hlp',
        intercepted: true,
        expectedWord: 'hlp',
        expectedClosest: 'help',
        expectedReply: '未知指令 /hlp。你是不是想用 /help？发送 /help 查看全部指令。',
      },
      {
        input: '/stat',
        intercepted: true,
        expectedWord: 'stat',
        expectedClosest: 'status',
        expectedReply: '未知指令 /stat。你是不是想用 /status？发送 /help 查看全部指令。',
      },
      {
        input: '/clearr',
        intercepted: true,
        expectedWord: 'clearr',
        expectedClosest: 'clear',
        expectedReply: '未知指令 /clearr。你是不是想用 /clear？发送 /help 查看全部指令。',
      },
      {
        input: '/stopp extra arguments here',
        intercepted: true,
        expectedWord: 'stopp',
        expectedClosest: 'stop',
        expectedReply: '未知指令 /stopp。你是不是想用 /stop？发送 /help 查看全部指令。',
      },
      {
        input: '   /stopp   ',
        intercepted: true,
        expectedWord: 'stopp',
        expectedClosest: 'stop',
        expectedReply: '未知指令 /stopp。你是不是想用 /stop？发送 /help 查看全部指令。',
      },
      {
        input: '/neww',
        intercepted: true,
        expectedWord: 'neww',
        expectedClosest: 'new',
        expectedReply: '未知指令 /neww。你是不是想用 /new？发送 /help 查看全部指令。',
      },
      // Intercepted without suggestion (distance > 2)
      {
        input: '/unknown_cmd',
        intercepted: true,
        expectedWord: 'unknown_cmd',
        expectedClosest: null,
        expectedReply: '未知指令 /unknown_cmd。发送 /help 查看全部指令。',
      },
      {
        input: '/foobar_test',
        intercepted: true,
        expectedWord: 'foobar_test',
        expectedClosest: null,
        expectedReply: '未知指令 /foobar_test。发送 /help 查看全部指令。',
      },
      {
        input: '/xyz123',
        intercepted: true,
        expectedWord: 'xyz123',
        expectedClosest: null,
        expectedReply: '未知指令 /xyz123。发送 /help 查看全部指令。',
      },
      // NOT intercepted: slash followed by slash in path
      {
        input: '/Users/synth/file',
        intercepted: false,
      },
      {
        input: '/etc/nginx/nginx.conf',
        intercepted: false,
      },
      {
        input: '/var/log',
        intercepted: false,
      },
      // NOT intercepted: double slash
      {
        input: '//',
        intercepted: false,
      },
      // NOT intercepted: slash followed by space
      {
        input: '/ text',
        intercepted: false,
      },
      // NOT intercepted: slash followed by digit
      {
        input: '/123',
        intercepted: false,
      },
      // NOT intercepted: slash command in middle of text
      {
        input: 'hello /help',
        intercepted: false,
      },
      {
        input: 'please execute /stop immediately',
        intercepted: false,
      },
      {
        input: 'normal user message',
        intercepted: false,
      },
      // Known commands/aliases are NOT intercepted as unknown
      {
        input: '/help',
        intercepted: false,
      },
      {
        input: '/model',
        intercepted: false,
      },
      {
        input: '/stop',
        intercepted: false,
      },
      {
        input: '/status',
        intercepted: false,
      },
      {
        input: '/ws',
        intercepted: false,
      },
      {
        input: '/session',
        intercepted: false,
      },
    ];

    for (const tc of testCases) {
      it(`evaluates "${tc.input}" -> intercepted: ${tc.intercepted}`, () => {
        const unknownParsed = parseUnknownChatCommand(tc.input);
        if (tc.intercepted) {
          expect(unknownParsed).not.toBeNull();
          expect(unknownParsed?.word).toBe(tc.expectedWord);
          expect(unknownParsed?.closest).toBe(tc.expectedClosest);
          const reply = formatUnknownCommandReply(unknownParsed!.word, unknownParsed!.closest);
          expect(reply).toBe(tc.expectedReply);

          // With { allowUnknown: true }, parseChatCommand returns unknown
          const parsed = parseChatCommand(tc.input, { allowUnknown: true });
          expect(parsed).not.toBeNull();
          expect(parsed?.command).toBe('unknown');
          expect(parsed?.word).toBe(tc.expectedWord);
          expect(parsed?.closest).toBe(tc.expectedClosest ?? undefined);
        } else {
          expect(unknownParsed).toBeNull();
        }
      });
    }
  });

  describe('2. Levenshtein Distance & Closest Command Unit Tests', () => {
    it('computes exact Levenshtein distance', () => {
      expect(levenshteinDistance('stop', 'stopp')).toBe(1);
      expect(levenshteinDistance('model', 'models')).toBe(1);
      expect(levenshteinDistance('help', 'hlp')).toBe(1);
      expect(levenshteinDistance('status', 'stat')).toBe(2);
      expect(levenshteinDistance('status', 'unknown')).toBe(7);
      expect(levenshteinDistance('same', 'same')).toBe(0);
    });

    it('finds closest command when edit distance <= 2, otherwise null', () => {
      expect(findClosestCommand('stopp')).toBe('stop');
      expect(findClosestCommand('models')).toBe('model');
      expect(findClosestCommand('hlp')).toBe('help');
      expect(findClosestCommand('stat')).toBe('status');
      expect(findClosestCommand('clearr')).toBe('clear');
      expect(findClosestCommand('unknown_command')).toBeNull();
      expect(findClosestCommand('completely_unrelated')).toBeNull();
    });
  });

  describe('3. DeliveryRuntimeGateway Closed-Loop: No Token Use & Synthetic Reply', () => {
    let db: DatabaseSync;
    let gateway: DeliveryRuntimeGateway;
    let messageStore: SqliteWebMessageStore;
    let executorCalled: boolean;

    const userId = 'u_synth_cmd_user';
    const spaceId = 'spc_synth_cmd_space';
    const sessionId = 'ses_synth_cmd_session';

    beforeEach(async () => {
      db = new DatabaseSync(':memory:');
      const runner = new PlatformServerMigrationRunner(db);
      await runner.migrate(ALL_PLATFORM_MIGRATIONS);

      db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, 'alice_synth', 'hash', 'user')").run(userId);
      db.prepare("INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES (?, ?, 'Synthetic Space', 'spc-synth', 'container')").run(spaceId, userId);
      db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, current_generation) VALUES (?, ?, ?, 'web', 'default', 'ctx_1', 'p1', 'dsh1', 'container', 1)").run(sessionId, userId, spaceId);

      const storage = new SqlitePlatformStorage(db);
      messageStore = new SqliteWebMessageStore(db);
      const profileResolver = { resolve: async () => null };
      const modelSelectionService = new ModelSelectionService({ db });

      executorCalled = false;
      const executor = {
        execute: async () => {
          executorCalled = true;
          return { replyText: 'runtime reply from LLM', usage: { totalTokens: 100 } };
        },
        cancel: async () => true,
      };

      gateway = new DeliveryRuntimeGateway({
        storage,
        messageStore,
        database: db,
        quotaMode: 'disabled',
        executor,
        profileResolver,
        modelSelectionService,
      });
    });

    it('intercepts /stopp synthetically: executor NOT called (0 tokens), reply includes suggestion /stop', async () => {
      let turnCompletedEvent: any = null;
      gateway.onTurnCompleted((event) => {
        turnCompletedEvent = event;
      });

      const dispatchResult = await gateway.dispatchInbound({
        id: 'deliv_synth_001',
        channel: 'web',
        userId,
        sessionId,
        content: '/stopp',
        timestamp: new Date().toISOString(),
      });

      expect(dispatchResult.accepted).toBe(true);
      expect(dispatchResult.executionMode).toBe('command');
      // Model executor was NOT called -> 0 tokens used
      expect(executorCalled).toBe(false);

      // Event was emitted
      expect(turnCompletedEvent).not.toBeNull();
      expect(turnCompletedEvent.executionResult.replyText).toBe(
        '未知指令 /stopp。你是不是想用 /stop？发送 /help 查看全部指令。'
      );

      // Reply persisted in web messages
      const history = await messageStore.listMessages(userId, sessionId);
      const assistantMsg = history.messages.find((m) => m.role === 'assistant');
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg?.content).toBe(
        '未知指令 /stopp。你是不是想用 /stop？发送 /help 查看全部指令。'
      );
    });

    it('intercepts /unknown_cmd synthetically: executor NOT called, suggestion omitted', async () => {
      const dispatchResult = await gateway.dispatchInbound({
        id: 'deliv_synth_002',
        channel: 'web',
        userId,
        sessionId,
        content: '/unknown_cmd',
        timestamp: new Date().toISOString(),
      });

      expect(dispatchResult.accepted).toBe(true);
      expect(dispatchResult.executionMode).toBe('command');
      expect(executorCalled).toBe(false);

      const history = await messageStore.listMessages(userId, sessionId);
      const assistantMsg = history.messages.find((m) => m.role === 'assistant');
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg?.content).toBe(
        '未知指令 /unknown_cmd。发送 /help 查看全部指令。'
      );
    });

    it('does NOT intercept file path /Users/synth/file: passes through to runtime queue', async () => {
      const dispatchResult = await gateway.dispatchInbound({
        id: 'deliv_synth_003',
        channel: 'web',
        userId,
        sessionId,
        content: '/Users/synth/file',
        timestamp: new Date().toISOString(),
      });

      expect(dispatchResult.accepted).toBe(true);
      expect(dispatchResult.executionMode).toBe('runtime');
    });
  });
});
