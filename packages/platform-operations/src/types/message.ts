import type { DeliveryStatus, DeliveryReceipt } from '@enkeep/platform-core';

export type { DeliveryStatus, DeliveryReceipt };

export interface SendMessageInput {
  recipient: string;
  content: string;
  routeId?: string;
  deliveryId?: string; // Idempotency key for delivery
  channel?: string;
  metadata?: Record<string, unknown>;
}

export interface SendMessageResult {
  success: boolean;
  messageId: string;
  deliveryId: string;
  recipient: string;
  status: DeliveryStatus;
  isIdempotentHit: boolean;
  timestamp: string;
  receipt: DeliveryReceipt;
}

export interface OutboundChannelAdapter {
  deliver(params: {
    userId: string;
    recipient: string;
    content: string;
    metadata?: Record<string, unknown>;
    routeId?: string;
    deliveryId: string;
  }): Promise<{ outboundMessageId?: string; metadata?: Record<string, unknown> }>;
}
