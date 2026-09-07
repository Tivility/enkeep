import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { SqliteReceiptStore } from '@enkeep/dsh-receipt-store-sqlite';
import {
  InboundService,
  InboundError,
  AgentNotFoundError,
  InboundValidationError,
  PreviousDeliveryFailedError,
} from '../src/index.js';

function createMockAgent(id: string): Agent {
  return {
    id: SessionId(id),
    options: {},
    session: {} as any,
    inbox: {} as any,
    status: 'idle',
    ctx: new Context(),
    cancel: vi.fn(),
    whenIdle: vi.fn().mockResolvedValue(undefined),
    runMaintenance: vi.fn(),
    send: vi.fn(),
    followup: vi.fn(),
    steer: vi.fn(),
    inject: vi.fn(),
  };
}

describe('InboundService Unit Tests', () => {
  let ctx: Context;
  let receiptStore: SqliteReceiptStore;
  let inbound: InboundService;
  let mockAgent: Agent;

  beforeEach(() => {
    ctx = new Context();

    // Setup ReceiptStore
    receiptStore = new SqliteReceiptStore({
      path: ':memory:',
      userId: 'test-user',
    });
    receiptStore.init();
    ctx.provide('receiptStore', receiptStore);

    // Mock Agents registry
    mockAgent = createMockAgent('session-test-1');
    const agentsMap = new Map<string, Agent>();
    agentsMap.set('session-test-1', mockAgent);

    ctx.provide('agents', {
      get: (id: SessionId) => agentsMap.get(id as string),
    } as any);

    inbound = new InboundService(ctx);
  });

  describe('handleFollowup', () => {
    it('dispatches followup to agent and records delivered receipt', async () => {
      const result = await inbound.handleFollowup({
        deliveryId: 'del-101',
        sessionId: 'session-test-1',
        message: 'Hello agent',
        source: {
          routeId: 'route-1',
          sourceType: 'feishu',
          sourceId: 'msg-raw-1',
        },
      });

      expect(result.success).toBe(true);
      expect(result.deliveryId).toBe('del-101');
      expect(result.status).toBe('delivered');
      expect(result.duplicate).toBe(false);
      expect(result.messageId).toBeDefined();

      // Check agent.followup was called with UserMessage
      expect(mockAgent.followup).toHaveBeenCalledTimes(1);
      const passedMsg = (mockAgent.followup as any).mock.calls[0][0];
      expect(passedMsg.role).toBe('user');
      expect(passedMsg.content[0].text).toBe('Hello agent');

      // Check receipt was stored as delivered
      const receipt = await receiptStore.getReceiptByDeliveryId('del-101');
      expect(receipt?.status).toBe('delivered');
      expect(receipt?.messageId).toBe(result.messageId);

      // Check session source was stored
      const source = await receiptStore.getSessionSource('feishu', 'msg-raw-1');
      expect(source?.routeId).toBe('route-1');
    });

    it('is idempotent: returns duplicate result when same deliveryId is resubmitted', async () => {
      const res1 = await inbound.handleFollowup({
        deliveryId: 'del-idempotent-1',
        sessionId: 'session-test-1',
        message: 'First call',
      });

      expect(res1.duplicate).toBe(false);
      expect(mockAgent.followup).toHaveBeenCalledTimes(1);

      // Second call with same deliveryId
      const res2 = await inbound.handleFollowup({
        deliveryId: 'del-idempotent-1',
        sessionId: 'session-test-1',
        message: 'Duplicate call',
      });

      expect(res2.success).toBe(true);
      expect(res2.deliveryId).toBe('del-idempotent-1');
      expect(res2.messageId).toBe(res1.messageId);
      expect(res2.status).toBe('delivered');
      expect(res2.duplicate).toBe(true);

      // Agent was NOT called a second time
      expect(mockAgent.followup).toHaveBeenCalledTimes(1);
    });

    it('fails loud with AgentNotFoundError when session does not exist', async () => {
      await expect(
        inbound.handleFollowup({
          deliveryId: 'del-no-agent',
          sessionId: 'non-existent-session',
          message: 'Hello',
        })
      ).rejects.toThrow(AgentNotFoundError);
    });

    it('fails loud with InboundValidationError on empty deliveryId or sessionId', async () => {
      await expect(
        inbound.handleFollowup({
          deliveryId: '',
          sessionId: 'session-test-1',
          message: 'Hello',
        })
      ).rejects.toThrow(InboundValidationError);

      await expect(
        inbound.handleFollowup({
          deliveryId: 'del-1',
          sessionId: '',
          message: 'Hello',
        })
      ).rejects.toThrow(InboundValidationError);
    });

    it('fails loud with PreviousDeliveryFailedError if receipt was previously recorded as failed', async () => {
      await receiptStore.recordReceipt({
        deliveryId: 'del-already-failed',
        messageId: 'msg-f',
        status: 'failed',
        error: 'Execution panic',
      });

      await expect(
        inbound.handleFollowup({
          deliveryId: 'del-already-failed',
          sessionId: 'session-test-1',
          message: 'Retry',
        })
      ).rejects.toThrow(PreviousDeliveryFailedError);
    });

    it('fails loud and marks receipt failed when session source recording fails', async () => {
      // Mock recordSessionSource to throw
      vi.spyOn(receiptStore, 'recordSessionSource').mockRejectedValueOnce(
        new Error('Disk I/O error during source indexing')
      );

      await expect(
        inbound.handleFollowup({
          deliveryId: 'del-source-fail',
          sessionId: 'session-test-1',
          message: 'Hello with failing source',
          source: {
            routeId: 'r-fail',
            sourceType: 'slack',
            sourceId: 'msg-fail',
          },
        })
      ).rejects.toThrow(InboundError);

      // Verify receipt was marked as failed
      const receipt = await receiptStore.getReceiptByDeliveryId('del-source-fail');
      expect(receipt?.status).toBe('failed');
      expect(receipt?.error).toContain('Disk I/O error during source indexing');

      // Verify agent followup was NOT executed
      expect(mockAgent.followup).not.toHaveBeenCalled();
    });

    it('dispatches to steer and inject when target is specified', async () => {
      await inbound.handleFollowup({
        deliveryId: 'del-steer',
        sessionId: 'session-test-1',
        message: 'Steering instruction',
        target: 'steer',
      });
      expect(mockAgent.steer).toHaveBeenCalledTimes(1);

      await inbound.handleFollowup({
        deliveryId: 'del-inject',
        sessionId: 'session-test-1',
        message: 'Injected context',
        target: 'inject',
      });
      expect(mockAgent.inject).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleCancel', () => {
    it('dispatches cancel to agent with specified cause and options', async () => {
      const res = await inbound.handleCancel({
        sessionId: 'session-test-1',
        deliveryId: 'del-cancel-1',
        cause: { kind: 'user' },
        options: { keepInbox: true },
      });

      expect(res.success).toBe(true);
      expect(res.sessionId).toBe('session-test-1');
      expect(res.status).toBe('cancelled');
      expect(mockAgent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true });
    });

    it('is idempotent on cancellation with deliveryId', async () => {
      const res1 = await inbound.handleCancel({
        sessionId: 'session-test-1',
        deliveryId: 'del-cancel-dup',
      });
      expect(res1.duplicate).toBe(false);

      const res2 = await inbound.handleCancel({
        sessionId: 'session-test-1',
        deliveryId: 'del-cancel-dup',
      });
      expect(res2.duplicate).toBe(true);
    });

    it('fails loud when agent is not found on cancel', async () => {
      await expect(
        inbound.handleCancel({
          sessionId: 'unknown-session',
        })
      ).rejects.toThrow(AgentNotFoundError);
    });

    it('fails loud on handleCancel when receiptStore encounters real persistence failure', async () => {
      vi.spyOn(receiptStore, 'recordReceipt').mockRejectedValueOnce(
        new Error('Disk write error on cancel receipt')
      );

      await expect(
        inbound.handleCancel({
          sessionId: 'session-test-1',
          deliveryId: 'del-cancel-store-fail',
        })
      ).rejects.toThrow('Disk write error on cancel receipt');
    });
  });

  describe('Wire Parser Integration', () => {
    it('parses raw JSON envelope and handles followup', async () => {
      const rawPayload = {
        data: {
          deliveryId: 'del-wire-1',
          sessionId: 'session-test-1',
          content: 'Wire text',
          target: 'followup',
        },
      };

      const result = await inbound.parseAndFollowup(rawPayload);
      expect(result.success).toBe(true);
      expect(result.deliveryId).toBe('del-wire-1');
      expect(mockAgent.followup).toHaveBeenCalled();
    });

    it('parses raw JSON envelope and handles cancel', async () => {
      const rawPayload = {
        sessionId: 'session-test-1',
        deliveryId: 'del-wire-cancel',
        cause: { kind: 'parent' },
      };

      const result = await inbound.parseAndCancel(rawPayload);
      expect(result.success).toBe(true);
      expect(mockAgent.cancel).toHaveBeenCalledWith({ kind: 'parent' }, undefined);
    });
  });
});
