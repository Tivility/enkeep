import { randomUUID } from 'node:crypto';
import type {
  TenantScopedDeliveryReceiptRepository,
  DeliveryReceipt,
} from '@enkeep/platform-core';
import type {
  SendMessageInput,
  SendMessageResult,
  OutboundChannelAdapter,
} from '../types/message.js';
import type { OperationsAuditPort } from '../ports/audit-port.js';
import { ValidationError } from '../errors/index.js';

export interface MessageOperationServiceOptions {
  deliveryReceipts: TenantScopedDeliveryReceiptRepository;
  auditLogs?: OperationsAuditPort;
  channelAdapter?: OutboundChannelAdapter;
}

export class MessageOperationService {
  private readonly receipts: TenantScopedDeliveryReceiptRepository;
  private readonly auditLogs?: OperationsAuditPort;
  private readonly channelAdapter?: OutboundChannelAdapter;
  private readonly inFlightSends = new Map<string, Promise<SendMessageResult>>();

  constructor(options: MessageOperationServiceOptions) {
    this.receipts = options.deliveryReceipts;
    this.auditLogs = options.auditLogs;
    this.channelAdapter = options.channelAdapter;
  }

  get userId(): string {
    return this.receipts.userId;
  }

  /**
   * Send outbound message with strict idempotency based on deliveryId.
   * If deliveryId was already processed or is currently in flight for this tenant:
   * - Winner executes outbound dispatch and returns initial result.
   * - Losers await the same in-flight Promise and return with isIdempotentHit: true.
   * - On failure, in-flight state is cleared allowing explicit retries.
   */
  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    if (!input.recipient || typeof input.recipient !== 'string' || !input.recipient.trim()) {
      throw new ValidationError('Recipient must be a non-empty string');
    }
    if (!input.content || typeof input.content !== 'string') {
      throw new ValidationError('Message content must be a string');
    }

    const deliveryId = input.deliveryId?.trim() || `deliv_${randomUUID().replace(/-/g, '')}`;
    const inFlightKey = `${this.userId}:${deliveryId}`;

    // 1. In-flight coalescing: if already in-flight, await existing execution
    const existingInFlight = this.inFlightSends.get(inFlightKey);
    if (existingInFlight) {
      const winnerResult = await existingInFlight;
      return {
        ...winnerResult,
        isIdempotentHit: true,
      };
    }

    // 2. Winner: create in-flight promise and execute
    const sendPromise = this.doSendMessage(input, deliveryId);
    this.inFlightSends.set(inFlightKey, sendPromise);

    try {
      return await sendPromise;
    } finally {
      // Clear in-flight state to allow subsequent independent retries/reads
      this.inFlightSends.delete(inFlightKey);
    }
  }

  private async doSendMessage(input: SendMessageInput, deliveryId: string): Promise<SendMessageResult> {
    const routeId = input.routeId || `route_${input.channel || 'default'}_${input.recipient}`;
    const messageId = `msg_${randomUUID().replace(/-/g, '')}`;

    // Check storage for previously settled / recorded delivery receipt
    const existingReceipt = await this.receipts.findByDeliveryId(deliveryId);
    if (existingReceipt) {
      if (this.auditLogs) {
        await this.auditLogs.record({
          userId: this.userId,
          action: 'message_idempotent_hit',
          resourceType: 'message',
          resourceId: existingReceipt.id,
          details: {
            deliveryId,
            status: existingReceipt.status,
            recipient: input.recipient,
          },
        });
      }

      return {
        success: existingReceipt.status === 'delivered',
        messageId: existingReceipt.messageId,
        deliveryId: existingReceipt.deliveryId,
        recipient: input.recipient,
        status: existingReceipt.status,
        isIdempotentHit: true,
        timestamp: existingReceipt.updatedAt || existingReceipt.createdAt,
        receipt: existingReceipt,
      };
    }

    // Atomic storage claim: create receipt in 'pending' status
    let receipt: DeliveryReceipt;
    try {
      receipt = await this.receipts.create({
        routeId,
        messageId,
        deliveryId,
        status: 'pending',
      });
    } catch (err: any) {
      // If concurrent insert raced and committed, recover existing receipt
      const racedReceipt = await this.receipts.findByDeliveryId(deliveryId);
      if (racedReceipt) {
        return {
          success: racedReceipt.status === 'delivered',
          messageId: racedReceipt.messageId,
          deliveryId: racedReceipt.deliveryId,
          recipient: input.recipient,
          status: racedReceipt.status,
          isIdempotentHit: true,
          timestamp: racedReceipt.updatedAt || racedReceipt.createdAt,
          receipt: racedReceipt,
        };
      }
      throw err;
    }

    if (this.auditLogs) {
      await this.auditLogs.record({
        userId: this.userId,
        action: 'message_sent',
        resourceType: 'message',
        resourceId: receipt.id,
        details: {
          deliveryId,
          recipient: input.recipient,
          routeId,
          contentLength: input.content.length,
          metadata: input.metadata,
        },
      });
    }

    // Outbound channel dispatch (winner only)
    if (this.channelAdapter) {
      try {
        const deliverResult = await this.channelAdapter.deliver({
          userId: this.userId,
          recipient: input.recipient,
          content: input.content,
          metadata: input.metadata,
          routeId,
          deliveryId,
        });

        receipt = await this.receipts.updateStatus(receipt.id, {
          status: 'delivered',
        });

        if (this.auditLogs) {
          await this.auditLogs.record({
            userId: this.userId,
            action: 'message_delivered',
            resourceType: 'message',
            resourceId: receipt.id,
            details: {
              deliveryId,
              outboundMessageId: deliverResult?.outboundMessageId,
            },
          });
        }
      } catch (err: any) {
        const errorMessage = err?.message || 'Failed to deliver message';
        receipt = await this.receipts.updateStatus(receipt.id, {
          status: 'failed',
          error: errorMessage,
        });

        if (this.auditLogs) {
          await this.auditLogs.record({
            userId: this.userId,
            action: 'message_failed',
            resourceType: 'message',
            resourceId: receipt.id,
            details: {
              deliveryId,
              error: errorMessage,
            },
          });
        }

        return {
          success: false,
          messageId: receipt.messageId,
          deliveryId: receipt.deliveryId,
          recipient: input.recipient,
          status: 'failed',
          isIdempotentHit: false,
          timestamp: receipt.updatedAt,
          receipt,
        };
      }
    } else {
      receipt = await this.receipts.updateStatus(receipt.id, {
        status: 'delivered',
      });

      if (this.auditLogs) {
        await this.auditLogs.record({
          userId: this.userId,
          action: 'message_delivered',
          resourceType: 'message',
          resourceId: receipt.id,
          details: {
            deliveryId,
            recipient: input.recipient,
          },
        });
      }
    }

    return {
      success: receipt.status === 'delivered',
      messageId: receipt.messageId,
      deliveryId: receipt.deliveryId,
      recipient: input.recipient,
      status: receipt.status,
      isIdempotentHit: false,
      timestamp: receipt.updatedAt,
      receipt,
    };
  }

  /**
   * Look up delivery receipt by deliveryId or id.
   */
  async getReceipt(deliveryIdOrId: string): Promise<DeliveryReceipt | null> {
    const byDelivery = await this.receipts.findByDeliveryId(deliveryIdOrId);
    if (byDelivery) return byDelivery;
    return this.receipts.findById(deliveryIdOrId);
  }

  /**
   * List delivery receipts for this tenant.
   */
  async listPendingReceipts(limit?: number): Promise<DeliveryReceipt[]> {
    return this.receipts.listPending({ limit });
  }
}
