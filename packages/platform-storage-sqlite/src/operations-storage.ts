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
  computeNextRun,
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
      let hasTaskSchedules = false;
      try {
        this.db.prepare('SELECT schedule_type FROM platform_tasks LIMIT 0').all();
        hasTaskSchedules = true;
      } catch {
        hasTaskSchedules = false;
      }

      const taskQuery = hasTaskSchedules
        ? `
          SELECT t.id, t.user_id, t.claim_count, t.max_retries,
                 t.schedule_type, t.cron_expression, t.interval_seconds, t.next_run_at, t.timezone,
                 s.schedule_type as s_schedule_type, s.cron_expression as s_cron_expression,
                 s.interval_seconds as s_interval_seconds, s.next_run_at as s_next_run_at,
                 s.timezone as s_timezone, s.enabled as s_enabled, s.paused_at as s_paused_at
          FROM platform_tasks t
          LEFT JOIN task_schedules s ON t.id = s.task_id
          WHERE (t.status = 'claimed' OR t.status = 'running')
            AND t.lease_expires_at <= ?
        `
        : `
          SELECT t.id, t.user_id, t.claim_count, t.max_retries,
                 NULL as schedule_type, NULL as cron_expression, NULL as interval_seconds, NULL as next_run_at, NULL as timezone,
                 NULL as s_schedule_type, NULL as s_cron_expression,
                 NULL as s_interval_seconds, NULL as s_next_run_at,
                 NULL as s_timezone, NULL as s_enabled, NULL as s_paused_at
          FROM platform_tasks t
          WHERE (t.status = 'claimed' OR t.status = 'running')
            AND t.lease_expires_at <= ?
        `;

      const taskStmt = this.db.prepare(taskQuery);
      const expiredTasks = taskStmt.all(currentTime) as any[];

      for (const t of expiredTasks) {
        const schedType = (t.s_schedule_type as string) || (t.schedule_type as string) || 'once';
        const cronExpr = t.s_cron_expression || t.cron_expression;
        const intervalSec = t.s_interval_seconds ?? t.interval_seconds;
        const isRecurring =
          schedType === 'cron' ||
          schedType === 'interval' ||
          Boolean(cronExpr) ||
          (intervalSec !== null && intervalSec !== undefined && intervalSec > 0);

        if (isRecurring) {
          // Recurring tasks must NEVER end in terminal 'failed' status after lease expiry/restart!
          // Keep task schedulable: reset claim_count to 0, compute next_run, return to pending
          let nextRun = t.s_next_run_at || t.next_run_at;
          if (!nextRun || new Date(nextRun).getTime() <= new Date(currentTime).getTime()) {
            nextRun = computeNextRun(
              {
                scheduleType: (schedType === 'cron' || schedType === 'interval') ? schedType : (cronExpr ? 'cron' : 'interval'),
                cronExpression: cronExpr,
                intervalSeconds: intervalSec,
                enabled: t.s_enabled !== null && t.s_enabled !== undefined ? t.s_enabled !== 0 : true,
                pausedAt: t.s_paused_at,
                timezone: t.s_timezone || t.timezone || 'UTC',
              },
              new Date(currentTime)
            );
          }

          if (hasTaskSchedules) {
            const res = this.db.prepare(`
              UPDATE platform_tasks
              SET status = 'pending',
                  claimant_id = NULL,
                  lease_expires_at = NULL,
                  claim_count = 0,
                  completed_at = NULL,
                  error = 'Task lease expired during restart recovery',
                  next_run_at = ?,
                  updated_at = ?
              WHERE id = ?
                AND user_id = ?
                AND (status = 'claimed' OR status = 'running')
                AND lease_expires_at <= ?
            `).run(nextRun, currentTime, t.id, t.user_id, currentTime);

            if (res.changes > 0) {
              recoveredTasksCount += Number(res.changes);
              try {
                this.db.prepare(`
                  UPDATE task_schedules
                  SET next_run_at = ?,
                      updated_at = ?
                  WHERE task_id = ? AND user_id = ?
                `).run(nextRun, currentTime, t.id, t.user_id);
              } catch {
                // Ignore if error updating schedule
              }
            }
          } else {
            const res = this.db.prepare(`
              UPDATE platform_tasks
              SET status = 'pending',
                  claimant_id = NULL,
                  lease_expires_at = NULL,
                  claim_count = 0,
                  completed_at = NULL,
                  error = 'Task lease expired during restart recovery',
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
        } else if (t.claim_count >= t.max_retries) {
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
