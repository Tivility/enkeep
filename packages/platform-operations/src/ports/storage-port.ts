import type { TenantScopedDeliveryReceiptRepository } from '@enkeep/platform-core';
import type { TenantScopedFileMetadataRepository, PathPolicyPort } from './file-port.js';
import type { TenantScopedTaskRepository } from './task-port.js';
import type { TenantScopedQuotaLedgerRepository } from './quota-ledger-port.js';
import type { OperationsAuditPort } from './audit-port.js';

export interface TenantScopedOperationsStorage {
  readonly userId: string;
  readonly deliveryReceipts: TenantScopedDeliveryReceiptRepository;
  readonly files: TenantScopedFileMetadataRepository;
  readonly tasks: TenantScopedTaskRepository;
  readonly quota: TenantScopedQuotaLedgerRepository;
}

export interface PlatformOperationsStorage {
  readonly auditLogs: OperationsAuditPort;
  readonly pathPolicy: PathPolicyPort;

  forTenant(userId: string): TenantScopedOperationsStorage;

  /**
   * System-wide restart recovery sweep across all tenants:
   * 1. Recovers expired task leases.
   * 2. Recovers / expires stale quota reservations.
   */
  recoverAfterRestart(options?: { nowIso?: string }): Promise<{
    recoveredTasks: number;
    expiredReservations: number;
  }>;

  close?(): Promise<void>;
}
