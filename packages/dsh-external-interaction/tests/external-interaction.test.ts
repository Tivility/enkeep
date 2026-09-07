import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import * as externalInteractionPlugin from '../src/index.js';
import { resolveSessionSource } from '../src/service.js';
import type { ApprovalRequest, ApprovalOutcome } from '../src/types.js';

describe('dsh-external-interaction', () => {
  let ctx: Context;

  beforeEach(() => {
    ctx = new Context();
  });

  describe('resolveSessionSource', () => {
    it('detects source from session.meta.source', () => {
      const agent = { session: { meta: { source: 'external' } } };
      expect(resolveSessionSource(agent)).toBe('external');
    });

    it('detects source from session.source', () => {
      const agent = { session: { source: 'im' } };
      expect(resolveSessionSource(agent)).toBe('im');
    });

    it('detects source from session.metadata.source', () => {
      const agent = { session: { metadata: { source: 'im' } } };
      expect(resolveSessionSource(agent)).toBe('im');
    });

    it('defaults to web when no external source is present', () => {
      expect(resolveSessionSource(undefined)).toBe('web');
      expect(resolveSessionSource({})).toBe('web');
      expect(resolveSessionSource({ session: {} })).toBe('web');
      expect(resolveSessionSource({ session: { meta: { source: 'web' } } })).toBe('web');
    });
  });

  describe('approval/request interception', () => {
    it('suspends and answers approval for web sessions via externalInteraction service', async () => {
      await ctx.plugin(externalInteractionPlugin);

      const service = ctx.get('externalInteraction')!;
      expect(service).toBeDefined();

      const webReq: ApprovalRequest = {
        agent: { session: { meta: { source: 'web' }, id: 'session-web-1', snapshotEvents: () => [] } } as any,
        toolName: 'bash',
        callId: 'call-1',
        reason: 'Execute dangerous command',
      };

      const promise = ctx.waterfall('approval/request', webReq, async () => {
        return 'unavailable' as ApprovalOutcome;
      });

      await new Promise((r) => setTimeout(r, 5));

      const pendingList = service.listPendingApprovals();
      expect(pendingList.length).toBe(1);
      expect(pendingList[0].toolName).toBe('bash');
      expect(pendingList[0].risk).toBe('high');
      expect(pendingList[0].safeSummary).toBe('Execute dangerous command');

      const answered = service.answerApproval(pendingList[0].id, 'allowed-once');
      expect(answered).toBe(true);

      const result = await promise;
      expect(result).toBe('allowed-once');
    });

    it('suspends approval for external session and resolves on answerApproval(allowed-once)', async () => {
      await ctx.plugin(externalInteractionPlugin);
      const service = ctx.get('externalInteraction')!;
      expect(service).toBeDefined();

      let nextCalled = false;
      const externalReq: ApprovalRequest = {
        agent: { session: { meta: { source: 'external' }, id: 'session-ext-1', snapshotEvents: () => [] } } as any,
        toolName: 'send_file',
        callId: 'call-ext-1',
        reason: 'Send sensitive file',
      };

      const promise = ctx.waterfall('approval/request', externalReq, async () => {
        nextCalled = true;
        return 'allowed-once' as ApprovalOutcome;
      });

      // Give event loop a tick to register pending approval
      await new Promise((r) => setTimeout(r, 5));

      expect(nextCalled).toBe(false);
      const pendingList = service.listPendingApprovals();
      expect(pendingList.length).toBe(1);
      expect(pendingList[0].toolName).toBe('send_file');
      expect(pendingList[0].sessionSource).toBe('external');

      // Programmatically answer the approval
      const answered = service.answerApproval(pendingList[0].id, 'allowed-once');
      expect(answered).toBe(true);

      const outcome = await promise;
      expect(outcome).toBe('allowed-once');
      expect(service.listPendingApprovals().length).toBe(0);
    });

    it('suspends approval for im session and resolves on answerApproval(rejected)', async () => {
      await ctx.plugin(externalInteractionPlugin);
      const service = ctx.get('externalInteraction')!;

      const imReq: ApprovalRequest = {
        agent: { session: { meta: { source: 'im' }, id: 'session-im-1', snapshotEvents: () => [] } } as any,
        toolName: 'bash',
        callId: 'call-im-1',
      };

      const promise = ctx.waterfall('approval/request', imReq, async () => {
        return 'allowed-once' as ApprovalOutcome;
      });

      await new Promise((r) => setTimeout(r, 5));
      const pendingList = service.listPendingApprovals();
      expect(pendingList.length).toBe(1);

      service.answerApproval(pendingList[0].id, 'rejected');

      const outcome = await promise;
      expect(outcome).toBe('rejected');
    });

    it('cancels approval when req.signal is aborted', async () => {
      await ctx.plugin(externalInteractionPlugin);
      const service = ctx.get('externalInteraction')!;

      const controller = new AbortController();
      const extReq: ApprovalRequest = {
        agent: { session: { meta: { source: 'external' }, id: 'session-ext-abort', snapshotEvents: () => [] } } as any,
        toolName: 'write',
        signal: controller.signal,
      };

      const promise = ctx.waterfall('approval/request', extReq, async () => {
        return 'allowed-once' as ApprovalOutcome;
      });

      await new Promise((r) => setTimeout(r, 5));
      expect(service.listPendingApprovals().length).toBe(1);

      controller.abort();

      const outcome = await promise;
      expect(outcome).toBe('cancelled');
      expect(service.listPendingApprovals().length).toBe(0);
    });

    it('cancels approval programmatically via cancelApproval', async () => {
      await ctx.plugin(externalInteractionPlugin);
      const service = ctx.get('externalInteraction')!;

      const extReq: ApprovalRequest = {
        agent: { session: { meta: { source: 'external' }, id: 'session-ext-cancel', snapshotEvents: () => [] } } as any,
        toolName: 'write',
      };

      const promise = ctx.waterfall('approval/request', extReq, async () => {
        return 'allowed-once' as ApprovalOutcome;
      });

      await new Promise((r) => setTimeout(r, 5));
      const id = service.listPendingApprovals()[0].id;
      service.cancelApproval(id, 'User cancelled');

      const outcome = await promise;
      expect(outcome).toBe('cancelled');
    });

    it('resolves with unavailable on timeout', async () => {
      await ctx.plugin(externalInteractionPlugin, { defaultTimeoutMs: 20 });
      const service = ctx.get('externalInteraction')!;

      const extReq: ApprovalRequest = {
        agent: { session: { meta: { source: 'external' }, id: 'session-ext-timeout', snapshotEvents: () => [] } } as any,
        toolName: 'bash',
      };

      const promise = ctx.waterfall('approval/request', extReq, async () => {
        return 'allowed-once' as ApprovalOutcome;
      });

      const outcome = await promise;
      expect(outcome).toBe('unavailable');
      expect(service.listPendingApprovals().length).toBe(0);
    });
  });

  describe('user questions suspension & answering', () => {
    it('suspends and answers questions for external sessions', async () => {
      await ctx.plugin(externalInteractionPlugin);
      const service = ctx.get('externalInteraction')!;

      const questionReq = {
        agent: { session: { meta: { source: 'external' }, id: 'session-q-1' } },
        questions: [
          {
            id: 'q1',
            question: 'Which deployment mode do you prefer?',
            options: [{ label: 'Docker' }, { label: 'Host' }],
          },
        ],
      };

      const promise = service.suspendQuestion(questionReq, 'external');

      const pending = service.listPendingQuestions();
      expect(pending.length).toBe(1);
      expect(pending[0].questions[0].id).toBe('q1');

      service.answerQuestion(pending[0].id, { q1: 'Docker' });

      const res = await promise;
      expect(res.answers).toEqual([{ id: 'q1', answer: 'Docker' }]);
      expect(service.listPendingQuestions().length).toBe(0);
    });

    it('cancels question on cancelQuestion call', async () => {
      await ctx.plugin(externalInteractionPlugin);
      const service = ctx.get('externalInteraction')!;

      const questionReq = {
        agent: { session: { meta: { source: 'external' }, id: 'session-q-cancel' } },
        questions: [{ id: 'q2', question: 'Confirm?' }],
      };

      const promise = service.suspendQuestion(questionReq, 'external');
      const pending = service.listPendingQuestions();

      service.cancelQuestion(pending[0].id, 'Aborted by operator');

      await expect(promise).rejects.toThrow('Aborted by operator');
    });
  });

  describe('HTTP server absence verification', () => {
    it('does NOT start any HTTP server or network listener', async () => {
      const fork = await ctx.plugin(externalInteractionPlugin);
      const service = ctx.get('externalInteraction');
      expect(service).toBeDefined();

      // Ensure no server instances exist on service or context
      expect((service as any).server).toBeUndefined();
      expect((service as any).httpServer).toBeUndefined();
      expect((ctx as any).httpServer).toBeUndefined();

      await fork.dispose();
    });
  });
});
