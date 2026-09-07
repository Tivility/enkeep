/**
 * Inbound Service implementation.
 *
 * Dispatches platform requests to DSH AgentRegistry with idempotency and fail-loud semantics.
 *
 * Delivery Receipt Semantics:
 * In `handleFollowup`, receipt status is updated to 'delivered' once the message has been
 * validated, recorded in persistent storage, and accepted/enqueued onto the target Agent boundary
 * (agent.followup / steer / inject). Subsequent turn evaluation executes asynchronously on the agent fiber.
 *
 * @module @enkeep/dsh-inbound
 */

import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import type {
  IInboundService,
  InboundCancelRequest,
  InboundCancelResult,
  InboundConfig,
  InboundFollowupRequest,
  InboundFollowupResult,
  InboundWireParser,
} from './types.js';
import {
  AgentNotFoundError,
  InboundError,
  InboundValidationError,
  PreviousDeliveryFailedError,
} from './errors.js';
import { DefaultInboundWireParser } from './wire-parser.js';

export class InboundService implements IInboundService {
  private readonly ctx: Context;
  private readonly defaultTarget: InboundFollowupRequest['target'];
  private readonly wireParser: InboundWireParser;

  constructor(ctx: Context, config?: InboundConfig) {
    this.ctx = ctx;
    this.defaultTarget = config?.defaultTarget ?? 'followup';
    this.wireParser = config?.wireParser ?? new DefaultInboundWireParser();
  }

  private get receiptStore() {
    return this.ctx.get('receiptStore');
  }

  private buildUserMessage(request: InboundFollowupRequest): UserMessage {
    const rawMsg = request.message;

    if (typeof rawMsg === 'string') {
      const text = rawMsg.trim();
      if (text.length === 0) {
        throw new InboundValidationError('Message text cannot be empty', 'message');
      }
      return createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      });
    }

    if (Array.isArray(rawMsg)) {
      if (rawMsg.length === 0) {
        throw new InboundValidationError('Message content blocks array cannot be empty', 'message');
      }
      return createUserMessage({
        content: rawMsg,
        source: { kind: 'user' },
      });
    }

    if (rawMsg && typeof rawMsg === 'object' && 'role' in rawMsg && rawMsg.role === 'user') {
      return rawMsg as UserMessage;
    }

    throw new InboundValidationError('Unsupported message payload format', 'message');
  }

  async handleFollowup(request: InboundFollowupRequest): Promise<InboundFollowupResult> {
    if (!request.deliveryId || request.deliveryId.trim().length === 0) {
      throw new InboundValidationError('deliveryId is required', 'deliveryId');
    }
    if (!request.sessionId || request.sessionId.trim().length === 0) {
      throw new InboundValidationError('sessionId is required', 'sessionId');
    }

    const deliveryId = request.deliveryId.trim();
    const sessionId = request.sessionId.trim();
    const store = this.receiptStore;

    // 1. Idempotency Check
    if (store) {
      const existing = await store.getReceiptByDeliveryId(deliveryId);
      if (existing) {
        if (existing.status === 'delivered') {
          return {
            success: true,
            deliveryId,
            messageId: existing.messageId,
            status: 'delivered',
            duplicate: true,
          };
        }
        if (existing.status === 'failed') {
          throw new PreviousDeliveryFailedError(deliveryId, existing.error);
        }
      }
    }

    // 2. Resolve Agent (Fail-Loud)
    const agent = this.ctx.agents?.get(SessionId(sessionId));
    if (!agent) {
      throw new AgentNotFoundError(sessionId);
    }

    // 3. Construct message
    const userMessage = this.buildUserMessage(request);

    // 4. Record Initial Receipt
    if (store) {
      try {
        await store.recordReceipt({
          deliveryId,
          messageId: userMessage.id,
          routeId: request.source?.routeId ?? '',
          status: 'pending',
        });
      } catch (err) {
        // If duplicate was inserted concurrently, re-check
        const existing = await store.getReceiptByDeliveryId(deliveryId);
        if (existing && existing.status === 'delivered') {
          return {
            success: true,
            deliveryId,
            messageId: existing.messageId,
            status: 'delivered',
            duplicate: true,
          };
        }
        // If concurrent insert is still pending or failed, rethrow
        throw err;
      }
    }

    // 5. Record Session Source if provided (Fail-Loud, update receipt to failed if it throws)
    if (store && request.source?.routeId && request.source.sourceType && request.source.sourceId) {
      try {
        await store.recordSessionSource({
          routeId: request.source.routeId,
          sourceType: request.source.sourceType,
          sourceId: request.source.sourceId,
          metadata: request.source.metadata ?? null,
        });
      } catch (sourceErr) {
        const errorMsg = `Failed recording session source: ${sourceErr instanceof Error ? sourceErr.message : String(sourceErr)}`;
        await store.updateReceiptStatus(deliveryId, 'failed', errorMsg);
        throw new InboundError(errorMsg, 'SESSION_SOURCE_RECORD_FAILED', sourceErr);
      }
    }

    // 6. Dispatch to Agent Boundary
    const target = request.target ?? this.defaultTarget ?? 'followup';
    try {
      if (target === 'steer') {
        agent.steer(userMessage);
      } else if (target === 'inject') {
        agent.inject(userMessage);
      } else {
        agent.followup(userMessage);
      }
    } catch (dispatchErr) {
      if (store) {
        await store.updateReceiptStatus(
          deliveryId,
          'failed',
          dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr)
        );
      }
      throw dispatchErr;
    }

    // 7. Update Receipt to Delivered (message accepted and enqueued on Agent boundary)
    if (store) {
      await store.updateReceiptStatus(deliveryId, 'delivered');
    }

    return {
      success: true,
      deliveryId,
      messageId: userMessage.id,
      status: 'delivered',
      duplicate: false,
    };
  }

  async handleCancel(request: InboundCancelRequest): Promise<InboundCancelResult> {
    if (!request.sessionId || request.sessionId.trim().length === 0) {
      throw new InboundValidationError('sessionId is required', 'sessionId');
    }

    const sessionId = request.sessionId.trim();
    const deliveryId = request.deliveryId?.trim();
    const store = this.receiptStore;

    // Idempotency check if deliveryId provided
    if (deliveryId && store) {
      const existing = await store.getReceiptByDeliveryId(deliveryId);
      if (existing && existing.status === 'delivered') {
        return {
          success: true,
          sessionId,
          status: 'cancelled',
          duplicate: true,
        };
      }
    }

    // Resolve Agent (Fail-Loud)
    const agent = this.ctx.agents?.get(SessionId(sessionId));
    if (!agent) {
      throw new AgentNotFoundError(sessionId);
    }

    // Dispatch Cancellation directly to Agent
    const cause = request.cause ?? { kind: 'user' };
    agent.cancel(cause, request.options);

    // Record receipt if deliveryId was supplied (Fail-Loud on real persistence failure)
    if (deliveryId && store) {
      try {
        await store.recordReceipt({
          deliveryId,
          messageId: 'cancel',
          status: 'delivered',
        });
      } catch (err) {
        // Re-read exact deliveryId: only if an existing delivered record exists, treat as duplicate
        const existing = await store.getReceiptByDeliveryId(deliveryId);
        if (existing && existing.status === 'delivered') {
          return {
            success: true,
            sessionId,
            status: 'cancelled',
            duplicate: true,
          };
        }
        // Fail loud on actual persistence failure
        throw err;
      }
    }

    return {
      success: true,
      sessionId,
      status: 'cancelled',
      duplicate: false,
    };
  }

  async parseAndFollowup(rawWirePayload: unknown): Promise<InboundFollowupResult> {
    const parsed = this.wireParser.parseFollowup(rawWirePayload);
    return this.handleFollowup(parsed);
  }

  async parseAndCancel(rawWirePayload: unknown): Promise<InboundCancelResult> {
    const parsed = this.wireParser.parseCancel(rawWirePayload);
    return this.handleCancel(parsed);
  }
}
