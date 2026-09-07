import type { DatabaseSync } from 'node:sqlite';
import type {
  PlatformOperationsStorage,
  TenantScopedOperationsStorage,
  OperationsAuditPort,
  PathPolicyPort,
  QuotaOptions,
} from '@enkeep/platform-operations';
import {
  CoreAuthAuditLogAdapter,
  StandardPathPolicyValidator,
} from '@enkeep/platform-operations';
import { SqliteAuthAuditLogRepository } from './repos/audit-repo.js';
import { SqliteTenantScopedDeliveryReceiptRepository } from './repos/delivery-receipt-repo.js';
import { SqliteTenantScopedFileMetadataRepository } from './repos/file-metadata-repo.js';
import { SqliteTenantScopedTaskRepository } from './repos/task-repo.js';
import { SqliteTenantScopedQuotaLedgerRepository } from './repos/quota-ledger-repo.js';
import { withImmediateTransaction } from './utils/db.js';

export interface SqlitePlatformOperationsStorageOptions {
  quotaOptions?: QuotaOptions;
}

export class SqlitePlatformOperationsStorage implements PlatformOperationsStorage {
  readonly db: DatabaseSync;
  readonly auditLogs: OperationsAuditPort;
  readonly pathPolicy: PathPolicyPort;
  private readonly quotaOptions?: QuotaOptions;
  private readonly tenantCache = new Map<string, TenantScopedOperationsStorage>();

  constructor(db: DatabaseSync, options?: SqlitePlatformOperationsStorageOptions) {
    this.db = db;
    this.quotaOptions = options?.quotaOptions;
    const authAuditRepo = new SqliteAuthAuditLogRepository(db);
    this.auditLogs = new CoreAuthAuditLogAdapter(authAuditRepo);
    this.pathPolicy = new StandardPathPolicyValidator();
  }

  forTenant(userId: string): TenantScopedOperationsStorage {
    if (!userId || typeof userId !== 'string' || userId.trim() === '' || userId !== userId.trim()) {
      throw new Error('Tenant user ID must be a non-empty string without leading or trailing whitespace');
    }

    const cached = this.tenantCache.get(userId);
    if (cached) {
      return cached;
    }

    const tenantStorage: TenantScopedOperationsStorage = {
      userId,
      deliveryReceipts: new SqliteTenantScopedDeliveryReceiptRepository(this.db, userId),
      files: new SqliteTenantScopedFileMetadataRepository(this.db, userId),
      tasks: new SqliteTenantScopedTaskRepository(this.db, userId),
      quota: new SqliteTenantScopedQuotaLedgerRepository(this.db, userId, this.quotaOptions),
    };

    this.tenantCache.set(userId, tenantStorage);
    return tenantStorage;
  }

  async recoverAfterRestart(options?: { nowIso?: string } | string): Promise<{
    recoveredTasks: number;
    expiredReservations: number;
  }> {
    const currentTime = typeof options === 'string'
      ? options
      : (options?.nowIso ?? new Date().toISOString());

    return withImmediateTransaction(this.db, async () => {
      let recoveredTasksCount = 0;
      let expiredReservationsCount = 0;

      // 1. Recover expired tasks across all tenants with atomic CAS
      const taskStmt = this.db.prepare(`
        SELECT id, user_id, claim_count, max_retries
        FROM platform_tasks
        WHERE (status = 'claimed' OR status = 'running')
          AND lease_expires_at <= ?
      `);
      const expiredTasks = taskStmt.all(currentTime) as { id: string; user_id: string; claim_count: number; max_retries: number }[];

      for (const t of expiredTasks) {
        if (t.claim_count >= t.max_retries) {
          const res = this.db.prepare(`
            UPDATE platform_tasks
            SET status = 'failed',
                error = ?,
                lease_expires_at = NULL,
                updated_at = ?,
                completed_at = ?
            WHERE id = ?
              AND user_id = ?
              AND (status = 'claimed' OR status = 'running')
              AND lease_expires_at <= ?
          `).run(
            `Task lease expired and max retries exhausted (${t.max_retries})`,
            currentTime,
            currentTime,
            t.id,
            t.user_id,
            currentTime
          );
          if (res.changes > 0) {
            recoveredTasksCount += Number(res.changes);
          }
        } else {
          const res = this.db.prepare(`
            UPDATE platform_tasks
            SET status = 'pending',
                claimant_id = NULL,
                lease_expires_at = NULL,
                updated_at = ?
            WHERE id = ?
              AND user_id = ?
              AND (status = 'claimed' OR status = 'running')
              AND lease_expires_at <= ?
          `).run(currentTime, t.id, t.user_id, currentTime);
          if (res.changes > 0) {
            recoveredTasksCount += Number(res.changes);
          }
        }
      }

      // 2. Expire stale uncommitted reservations across all tenants atomically
      const resStmt = this.db.prepare(`
        UPDATE quota_reservations
        SET status = 'expired',
            settled_at = ?
        WHERE status = 'reserved'
          AND expires_at <= ?
      `);
      const resResult = resStmt.run(currentTime, currentTime);
      expiredReservationsCount = Number(resResult.changes);

      // 3. Mark active task_runs with expired leases as failed
      try {
        this.db.prepare(`
          UPDATE task_runs
          SET status = 'failed',
              error_code = 'TASK_LEASE_EXPIRED',
              error = 'Execution lease expired',
              completed_at = ?,
              updated_at = ?
          WHERE status IN ('claimed', 'running')
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at <= ?
        `).run(currentTime, currentTime, currentTime);
      } catch {
        // In case task_runs table does not exist in very early schema versions
      }

      return {
        recoveredTasks: recoveredTasksCount,
        expiredReservations: expiredReservationsCount,
      };
    });
  }

  /**
   * Closes operations storage tenant cache.
   *
   * Database lifecycle ownership:
   * The underlying `DatabaseSync` connection is injected from the caller / host environment,
   * so `close()` clears internal tenant cache and releases adapter handles without closing
   * the shared database instance, allowing caller-managed lifecycle control.
   */
  async close(): Promise<void> {
    this.tenantCache.clear();
  }
}

export function createSqliteOperationsStorage(
  db: DatabaseSync,
  options?: SqlitePlatformOperationsStorageOptions
): SqlitePlatformOperationsStorage {
  return new SqlitePlatformOperationsStorage(db, options);
}
