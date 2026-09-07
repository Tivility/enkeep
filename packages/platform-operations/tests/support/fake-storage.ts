import type {
  PlatformOperationsStorage,
  TenantScopedOperationsStorage,
} from '../../src/index.js';
import type { PathPolicyPort } from '../../src/ports/file-port.js';
import { StandardPathPolicyValidator } from '../../src/policies/path-policy.js';
import { FakeOperationsAuditPort } from './fake-audit-repo.js';
import { FakeTenantScopedDeliveryReceiptRepository } from './fake-delivery-receipt-repo.js';
import { FakeTenantScopedFileMetadataRepository } from './fake-file-metadata-repo.js';
import { FakeTenantScopedTaskRepository } from './fake-task-repo.js';
import { FakeTenantScopedQuotaLedgerRepository } from './fake-quota-ledger-repo.js';

export interface FakePlatformOperationsStorageOptions {}

export class FakePlatformOperationsStorage implements PlatformOperationsStorage {
  readonly auditLogs: FakeOperationsAuditPort = new FakeOperationsAuditPort();
  readonly pathPolicy: PathPolicyPort = new StandardPathPolicyValidator();
  private readonly tenants = new Map<
    string,
    {
      deliveryReceipts: FakeTenantScopedDeliveryReceiptRepository;
      files: FakeTenantScopedFileMetadataRepository;
      tasks: FakeTenantScopedTaskRepository;
      quota: FakeTenantScopedQuotaLedgerRepository;
    }
  >();

  constructor(_options?: FakePlatformOperationsStorageOptions) {}

  forTenant(userId: string): TenantScopedOperationsStorage {
    let tenant = this.tenants.get(userId);
    if (!tenant) {
      tenant = {
        deliveryReceipts: new FakeTenantScopedDeliveryReceiptRepository(userId),
        files: new FakeTenantScopedFileMetadataRepository(userId),
        tasks: new FakeTenantScopedTaskRepository(userId),
        quota: new FakeTenantScopedQuotaLedgerRepository(userId),
      };
      this.tenants.set(userId, tenant);
    }

    return {
      userId,
      deliveryReceipts: tenant.deliveryReceipts,
      files: tenant.files,
      tasks: tenant.tasks,
      quota: tenant.quota,
    };
  }

  async recoverAfterRestart(options?: { nowIso?: string }): Promise<{
    recoveredTasks: number;
    expiredReservations: number;
  }> {
    let recoveredTasks = 0;
    let expiredReservations = 0;

    for (const tenant of this.tenants.values()) {
      const taskRes = await tenant.tasks.recoverExpiredLeases(options?.nowIso);
      recoveredTasks += taskRes.recoveredCount;

      const quotaRes = await tenant.quota.expireStaleReservations(options?.nowIso);
      expiredReservations += quotaRes.expiredCount;
    }

    return {
      recoveredTasks,
      expiredReservations,
    };
  }

  async close(): Promise<void> {
    this.tenants.clear();
    this.auditLogs.clear();
  }
}
