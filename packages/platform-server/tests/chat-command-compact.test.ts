import { describe, it, expect, vi } from 'vitest';
import { parseChatCommand, ChatCommandService } from '../src/chat/chat-command-service.js';
import type { ModelSelectionService } from '../src/models/model-selection-service.js';

describe('Piece 2(b): Chat Command /compact', () => {
  const mockModelSelectionService = {
    resolveEffectiveModel: vi.fn(),
    getDshCatalog: vi.fn(),
    listAvailableModels: vi.fn(),
  } as unknown as ModelSelectionService;

  describe('1. Parser & Help', () => {
    it('parses /compact as compact command', () => {
      const parsed = parseChatCommand('/compact');
      expect(parsed).not.toBeNull();
      expect(parsed?.command).toBe('compact');
      expect(parsed?.type).toBe('compact');
    });

    it('includes /compact in /help output', async () => {
      const service = new ChatCommandService(mockModelSelectionService);
      const res = await service.execute({
        userId: 'alice',
        sessionId: 'ses_test',
        spaceId: 'sp_test',
        content: '/help',
      });
      expect(res.replyText).toContain('/compact');
    });
  });

  describe('2. Execution with stub compactSession', () => {
    it('calls stub compactSession and replies with the numbers', async () => {
      const stubCompactSession = vi.fn(async (userId: string, sessionId: string) => {
        return {
          status: 'ok',
          sessionId,
          beforeTokens: 250000,
          afterTokens: 45000,
          eventsBefore: 42,
          eventsAfter: 14,
          summaryChars: 512,
        };
      });

      const service = new ChatCommandService({
        modelSelectionService: mockModelSelectionService,
        platformApi: {
          resetSession: vi.fn() as any,
          compactSession: stubCompactSession,
        },
      });

      const res = await service.execute({
        userId: 'alice',
        sessionId: 'ses_test',
        spaceId: 'sp_test',
        content: '/compact',
      });

      expect(stubCompactSession).toHaveBeenCalledWith('alice', 'ses_test');
      expect(res.replyText).toContain('250000');
      expect(res.replyText).toContain('45000');
      expect(res.replyText).toContain('42');
      expect(res.replyText).toContain('14');
      expect(res.replyText).toContain('512');
    });

    it('rejects if a turn is currently active', async () => {
      const stubCompactSession = vi.fn();
      const stubGateway = {
        getCurrentTurnStatus: vi.fn(async () => ({ status: 'running' })),
        cancelCurrentTurn: vi.fn(async () => true),
      };

      const service = new ChatCommandService({
        modelSelectionService: mockModelSelectionService,
        platformApi: {
          resetSession: vi.fn() as any,
          compactSession: stubCompactSession,
        },
        gateway: stubGateway,
      });

      const res = await service.execute({
        userId: 'alice',
        sessionId: 'ses_test',
        spaceId: 'sp_test',
        content: '/compact',
      });

      expect(res.replyText).toBe('a turn is active, use /stop first');
      expect(stubCompactSession).not.toHaveBeenCalled();
    });

    it('returns error message if compactSession throws', async () => {
      const stubCompactSession = vi.fn(async () => {
        throw new Error('manual compaction requires an idle agent');
      });

      const service = new ChatCommandService({
        modelSelectionService: mockModelSelectionService,
        platformApi: {
          resetSession: vi.fn() as any,
          compactSession: stubCompactSession,
        },
      });

      const res = await service.execute({
        userId: 'alice',
        sessionId: 'ses_test',
        spaceId: 'sp_test',
        content: '/compact',
      });

      expect(res.replyText).toContain('Compaction failed: manual compaction requires an idle agent');
    });

    it('reports unavailable if platformApi compactSession is not provided', async () => {
      const service = new ChatCommandService({
        modelSelectionService: mockModelSelectionService,
      });

      const res = await service.execute({
        userId: 'alice',
        sessionId: 'ses_test',
        spaceId: 'sp_test',
        content: '/compact',
      });

      expect(res.replyText).toContain('Platform API compactSession unavailable.');
    });
  });
});
