import type {
  DeliveryReceipt,
  CreateDeliveryReceiptInput,
  UpdateDeliveryReceiptStatusInput,
  TenantScopedDeliveryReceiptRepository,
} from '@enkeep/platform-core';

export type {
  DeliveryReceipt,
  CreateDeliveryReceiptInput,
  UpdateDeliveryReceiptStatusInput,
  TenantScopedDeliveryReceiptRepository,
};

/**
 * Adapter interface for delivery receipt repository if customized or wrapped.
 */
export interface DeliveryReceiptPort extends TenantScopedDeliveryReceiptRepository {}
