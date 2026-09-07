export type DeliveryStatus = 'pending' | 'delivered' | 'failed';

export interface DeliveryReceipt {
  id: string;
  userId: string; // Tenant/Owner ID
  routeId: string;
  messageId: string;
  deliveryId: string;
  status: DeliveryStatus;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDeliveryReceiptInput {
  id?: string;
  userId?: string;
  routeId: string;
  messageId: string;
  deliveryId: string;
  status?: DeliveryStatus;
  error?: string | null;
}

export interface UpdateDeliveryReceiptStatusInput {
  status: DeliveryStatus;
  error?: string | null;
}

/**
 * Platform Delivery Inbox Statuses:
 * - 'held': Message has arrived at platform inbox and is persisted waiting for dispatch/claim
 * - 'processing': Claimed by dispatcher/worker via CAS (held -> processing)
 * - 'delivered': Successfully processed/dispatched to runtime/session
 * - 'duplicate': Inbound deliveryId already existed, skipped processing
 * - 'cancelled': Ingestion or processing cancelled before delivery
 */
export type DeliveryInboxStatus = 'held' | 'processing' | 'delivered' | 'duplicate' | 'cancelled';

export interface DeliveryInboxEntry {
  id: string;
  userId: string; // Tenant/Owner ID
  routeId: string;
  messageId: string;
  deliveryId: string;
  status: DeliveryInboxStatus;
  payload?: Record<string, unknown> | null;
  error?: string | null;
  receivedAt: string;
  processedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IngestDeliveryInboxInput {
  id?: string;
  userId: string;
  routeId: string;
  messageId: string;
  deliveryId: string;
  payload?: Record<string, unknown> | null;
  receivedAt?: string;
}

export interface IngestDeliveryResult {
  entry: DeliveryInboxEntry;
  isDuplicate: boolean;
}

export interface UpdateDeliveryInboxStatusInput {
  status: DeliveryInboxStatus;
  processedAt?: string | null;
  error?: string | null;
}
