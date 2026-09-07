import type { DatabaseSync } from 'node:sqlite';
import type {
  QuotaMetric,
  TenantQuotaLimit,
  SetQuotaLimitInput,
  QuotaReservation,
  ReserveQuotaInput,
  CommitQuotaInput,
  ReleaseQuotaInput,
  ConsumeQuotaInput,
  QuotaUsageSummary,
  QuotaUsageDetail,
  CheckQuotaQuery,
  CheckQuotaResult,
  QuotaBundle,
  ReserveQuotaBundleInput,
  CommitQuotaBundleInput,
  ReleaseQuotaBundleInput,
  RenewQuotaBundleInput,
} from '../types/quota.js';
import {
  CORE_QUOTA_METRICS,
  assertPositiveInteger,
  assertNonNegativeInteger,
  assertQuotaLimit,
  validateQuotaMetric,
} from '../types/quota.js';
import type { TenantScopedQuotaLedgerRepository } from '../ports/quota-ledger-port.js';
import type { OperationsAuditPort } from '../ports/audit-port.js';
import {
  ValidationError,
  QuotaExceededError,
} from '../errors/index.js';

export interface QuotaOperationServiceOptions {
  quota: TenantScopedQuotaLedgerRepository;
  auditLogs?: OperationsAuditPort;
}

export class QuotaOperationService {
  private readonly quota: TenantScopedQuotaLedgerRepository;
  private readonly auditLogs?: OperationsAuditPort;

  constructor(options: QuotaOperationServiceOptions) {
    this.quota = options.quota;
    this.auditLogs = options.auditLogs;
  }

  get userId(): string {
    return this.quota.userId;
  }

  /**
   * Check quota limits and remaining balance for a specific resource or across all resources.
   */
  async checkQuota(query?: CheckQuotaQuery): Promise<CheckQuotaResult> {
    const usage = {} as Record<QuotaMetric, number>;
    const activeReservations = {} as Record<QuotaMetric, number>;
    const limit = {} as Record<QuotaMetric, number>;
    const remaining = {} as Record<QuotaMetric, number>;

    let overallAllowed = true;
    let singleAllowed: boolean | undefined;
    let resetAt: string | null = null;

    const targetMetric = query?.resource ? validateQuotaMetric(query.resource) : undefined;

    for (const metric of CORE_QUOTA_METRICS) {
      const summary = await this.quota.getUsage(metric);
      usage[metric] = summary.used;
      activeReservations[metric] = summary.reserved;
      limit[metric] = summary.limit;
      remaining[metric] = summary.remaining;

      if (!summary.allowed) {
        overallAllowed = false;
      }
      if (targetMetric && metric === targetMetric) {
        singleAllowed = summary.allowed;
        if (summary.resetAt) {
          resetAt = summary.resetAt;
        }
      } else if (!resetAt && summary.resetAt) {
        resetAt = summary.resetAt;
      }
    }

    return {
      allowed: targetMetric !== undefined ? (singleAllowed ?? false) : overallAllowed,
      usage,
      activeReservations,
      limit,
      remaining,
      resetAt,
    };
  }

  /**
   * Get configured limit for a specific quota metric.
   */
  async getLimit(resource: QuotaMetric): Promise<TenantQuotaLimit | null> {
    const metric = validateQuotaMetric(resource);
    return this.quota.getLimit(metric);
  }

  /**
   * List all configured quota limits for this tenant.
   */
  async listLimits(): Promise<TenantQuotaLimit[]> {
    return this.quota.listLimits();
  }

  /**
   * Get usage for a specific quota metric.
   */
  async getUsage(resource: QuotaMetric): Promise<QuotaUsageSummary> {
    const metric = validateQuotaMetric(resource);
    return this.quota.getUsage(metric);
  }

  /**
   * Atomically reserve quota (tokens / calls / storage) for 2-phase execution.
   * Throws QuotaExceededError if amount > remaining quota.
   */
  async reserveQuota(input: ReserveQuotaInput): Promise<QuotaReservation> {
    const resource = validateQuotaMetric(input.resource);
    const amount = assertPositiveInteger(input.amount, 'Reserve amount');

    if (input.ttlSeconds !== undefined) {
      assertPositiveInteger(input.ttlSeconds, 'ttlSeconds');
    }

    try {
      const reservation = await this.quota.reserve({
        ...input,
        resource,
        amount,
      });

      if (this.auditLogs) {
        await this.auditLogs.record({
          userId: this.userId,
          action: 'quota_reserved',
          resourceType: 'quota',
          resourceId: reservation.id,
          details: {
            resource,
            amount,
            expiresAt: reservation.expiresAt,
          },
        });
      }

      return reservation;
    } catch (err: any) {
      if (err instanceof QuotaExceededError && this.auditLogs) {
        await this.auditLogs.record({
          userId: this.userId,
          action: 'quota_exceeded',
          resourceType: 'quota',
          details: {
            resource,
            requested: amount,
            available: err.available,
          },
        });
      }
      throw err;
    }
  }

  /**
   * Atomically commit a quota reservation with actual usage.
   */
  async commitQuota(input: CommitQuotaInput): Promise<{ reservation: QuotaReservation; usage: QuotaUsageSummary }> {
    if (!input.reservationId || !input.reservationId.trim()) {
      throw new ValidationError('reservationId is required');
    }
    let actualAmount: number | undefined;
    if (input.actualAmount !== undefined) {
      actualAmount = assertNonNegativeInteger(input.actualAmount, 'actualAmount');
    }

    const result = await this.quota.commit({
      ...input,
      actualAmount,
    });

    if (this.auditLogs) {
      await this.auditLogs.record({
        userId: this.userId,
        action: 'quota_committed',
        resourceType: 'quota',
        resourceId: result.reservation.id,
        details: {
          resource: result.reservation.resource,
          reservedAmount: result.reservation.amount,
          committedAmount: result.reservation.committedAmount,
          newRemaining: result.usage.remaining,
        },
      });
    }

    return result;
  }

  /**
   * Atomically release a quota reservation back to the available pool.
   */
  async releaseQuota(input: ReleaseQuotaInput): Promise<QuotaReservation> {
    if (!input.reservationId || !input.reservationId.trim()) {
      throw new ValidationError('reservationId is required');
    }

    const reservation = await this.quota.release(input);

    if (this.auditLogs) {
      await this.auditLogs.record({
        userId: this.userId,
        action: 'quota_released',
        resourceType: 'quota',
        resourceId: reservation.id,
        details: {
          resource: reservation.resource,
          amount: reservation.amount,
          reason: input.reason,
        },
      });
    }

    return reservation;
  }

  /**
   * Atomically consume quota directly in one phase.
   */
  async consumeQuota(input: ConsumeQuotaInput): Promise<QuotaUsageSummary> {
    const resource = validateQuotaMetric(input.resource);
    const amount = assertPositiveInteger(input.amount, 'Consume amount');

    try {
      const summary = await this.quota.directConsume({
        ...input,
        resource,
        amount,
      });

      if (this.auditLogs) {
        await this.auditLogs.record({
          userId: this.userId,
          action: 'quota_committed',
          resourceType: 'quota',
          details: {
            resource,
            amount,
            remaining: summary.remaining,
          },
        });
      }

      return summary;
    } catch (err: any) {
      if (err instanceof QuotaExceededError && this.auditLogs) {
        await this.auditLogs.record({
          userId: this.userId,
          action: 'quota_exceeded',
          resourceType: 'quota',
          details: {
            resource,
            requested: amount,
            available: err.available,
          },
        });
      }
      throw err;
    }
  }

  /**
   * Adjust quota usage by delta (positive or negative).
   */
  async adjustUsage(input: { resource: QuotaMetric; delta: number }): Promise<QuotaUsageSummary> {
    const resource = validateQuotaMetric(input.resource);
    const delta = input.delta;
    if (typeof delta !== 'number' || !Number.isSafeInteger(delta)) {
      throw new ValidationError('delta must be a safe integer');
    }

    if (this.quota.adjustUsage) {
      const summary = await this.quota.adjustUsage({ resource, delta });
      if (this.auditLogs) {
        await this.auditLogs.record({
          userId: this.userId,
          action: 'storage_adjusted',
          resourceType: 'quota',
          details: {
            resource,
            delta,
            used: summary.used,
            remaining: summary.remaining,
          },
        });
      }
      return summary;
    }

    // Fallback if adjustUsage is not implemented on repo
    if (delta > 0) {
      return this.consumeQuota({ resource, amount: delta });
    }
    if (delta < 0 && this.quota.decrementUsage) {
      return this.quota.decrementUsage(resource, Math.abs(delta));
    }
    return this.quota.getUsage(resource);
  }

  /**
   * Decrement quota usage atomically (clamped at 0).
   */
  async decrementUsage(resource: QuotaMetric, amount: number): Promise<QuotaUsageSummary> {
    const metric = validateQuotaMetric(resource);
    const nonNeg = assertNonNegativeInteger(amount, 'amount');
    return this.adjustUsage({ resource: metric, delta: -nonNeg });
  }

  /**
   * Set baseline quota usage (e.g. from volume storage scan).
   */
  async setBaselineUsage(resource: QuotaMetric, amount: number): Promise<QuotaUsageSummary> {
    const metric = validateQuotaMetric(resource);
    const nonNeg = assertNonNegativeInteger(amount, 'amount');
    if (this.quota.setBaselineUsage) {
      const summary = await this.quota.setBaselineUsage(metric, nonNeg);
      if (this.auditLogs) {
        await this.auditLogs.record({
          userId: this.userId,
          action: 'storage_reconciled',
          resourceType: 'quota',
          details: {
            resource: metric,
            baselineAmount: nonNeg,
          },
        });
      }
      return summary;
    }
    return this.quota.getUsage(metric);
  }

  /**
   * Set or update tenant quota limit.
   */
  async setLimit(input: SetQuotaLimitInput): Promise<TenantQuotaLimit> {
    const resource = validateQuotaMetric(input.resource);
    const limitAmount = assertQuotaLimit(input.limit, 'Quota limit');

    if (input.windowSeconds !== undefined) {
      assertPositiveInteger(input.windowSeconds, 'windowSeconds');
    }

    const limit = await this.quota.setLimit({
      ...input,
      resource,
      limit: limitAmount,
    });

    if (this.auditLogs) {
      await this.auditLogs.record({
        userId: this.userId,
        action: 'quota_limit_updated',
        resourceType: 'quota',
        details: {
          resource: limit.resource,
          limit: limit.limit,
          windowSeconds: limit.windowSeconds,
        },
      });
    }

    return limit;
  }

  /**
   * Expire stale uncommitted reservations.
   */
  async expireStaleReservations(nowIso?: string): Promise<{ expiredCount: number; reservationIds: string[] }> {
    const result = await this.quota.expireStaleReservations(nowIso);

    if (result.expiredCount > 0 && this.auditLogs) {
      await this.auditLogs.record({
        userId: this.userId,
        action: 'quota_reservations_expired',
        resourceType: 'quota',
        details: {
          expiredCount: result.expiredCount,
          reservationIds: result.reservationIds,
        },
      });
    }

    return result;
  }

  /**
   * Atomically reserve multi-metric quota bundle (turns, messages, tokens) for 2-phase turn execution.
   */
  async reserveBundle(input: ReserveQuotaBundleInput): Promise<QuotaBundle> {
    if (!input.deliveryId || typeof input.deliveryId !== 'string' || !input.deliveryId.trim()) {
      throw new ValidationError('deliveryId is required for quota bundle reservation');
    }
    if (!input.sessionId || typeof input.sessionId !== 'string' || !input.sessionId.trim()) {
      throw new ValidationError('sessionId is required for quota bundle reservation');
    }
    assertPositiveInteger(input.turns, 'turns');
    assertPositiveInteger(input.messages, 'messages');
    if (input.tokens !== undefined && input.tokens > 0) {
      assertPositiveInteger(input.tokens, 'tokens');
    }
    if (input.ttlSeconds !== undefined) {
      assertPositiveInteger(input.ttlSeconds, 'ttlSeconds');
    }

    if (!this.quota.reserveBundle) {
      throw new Error('Tenant quota storage does not support bundle reservations');
    }
    try {
      const bundle = await this.quota.reserveBundle(input);

      if (this.auditLogs) {
        await this.auditLogs.record({
          userId: this.userId,
          action: 'quota_bundle_reserved',
          resourceType: 'quota_bundle',
          resourceId: bundle.id,
          details: {
            deliveryId: bundle.deliveryId,
            sessionId: bundle.sessionId,
            turns: bundle.turns,
            messages: bundle.messages,
            tokens: bundle.tokens,
            expiresAt: bundle.expiresAt,
          },
        });
      }

      return bundle;
    } catch (err: unknown) {
      if (err instanceof QuotaExceededError && this.auditLogs) {
        await this.auditLogs.record({
          userId: this.userId,
          action: 'quota_exceeded',
          resourceType: 'quota_bundle',
          details: {
            resource: err.resource,
            requested: err.requested,
            available: err.available,
            deliveryId: input.deliveryId,
          },
        });
      }
      throw err;
    }
  }

  /**
   * Atomically commit a quota bundle with actual usage.
   */
  async commitBundle(input: CommitQuotaBundleInput): Promise<QuotaBundle> {
    if (!input.bundleId || typeof input.bundleId !== 'string' || !input.bundleId.trim()) {
      throw new ValidationError('bundleId is required');
    }
    if (!this.quota.commitBundle) {
      throw new Error('Tenant quota storage does not support bundle commits');
    }

    const bundle = await this.quota.commitBundle(input);

    if (this.auditLogs) {
      const isOverage = bundle.isEstimateTokens && (bundle.tokensCommitted ?? 0) > bundle.tokens;
      await this.auditLogs.record({
        userId: this.userId,
        action: isOverage ? 'quota_overage_committed' : 'quota_bundle_committed',
        resourceType: 'quota_bundle',
        resourceId: bundle.id,
        details: {
          deliveryId: bundle.deliveryId,
          turnsCommitted: bundle.turnsCommitted,
          messagesCommitted: bundle.messagesCommitted,
          tokensCommitted: bundle.tokensCommitted,
          tokensReserved: bundle.tokens,
          isOverage,
        },
      });
    }

    return bundle;
  }

  /**
   * Atomically release a quota bundle back to the available pool.
   */
  async releaseBundle(input: ReleaseQuotaBundleInput): Promise<QuotaBundle> {
    if (!input.bundleId || typeof input.bundleId !== 'string' || !input.bundleId.trim()) {
      throw new ValidationError('bundleId is required');
    }
    if (!this.quota.releaseBundle) {
      throw new Error('Tenant quota storage does not support bundle releases');
    }

    const bundle = await this.quota.releaseBundle(input);

    if (this.auditLogs) {
      await this.auditLogs.record({
        userId: this.userId,
        action: 'quota_bundle_released',
        resourceType: 'quota_bundle',
        resourceId: bundle.id,
        details: {
          deliveryId: bundle.deliveryId,
          reason: input.reason,
        },
      });
    }

    return bundle;
  }

  /**
   * Commit a quota bundle synchronously inside an existing caller-owned SQLite transaction.
   */
  commitBundleInTransactionSync(db: DatabaseSync, input: CommitQuotaBundleInput): QuotaBundle {
    if (!input.bundleId || typeof input.bundleId !== 'string' || !input.bundleId.trim()) {
      throw new ValidationError('bundleId is required');
    }
    if (!this.quota.commitBundleInTransactionSync) {
      throw new Error('Tenant quota storage does not support in-transaction bundle commit');
    }
    return this.quota.commitBundleInTransactionSync(db, input);
  }

  /**
   * Release a quota bundle synchronously inside an existing caller-owned SQLite transaction.
   */
  releaseBundleInTransactionSync(db: DatabaseSync, input: ReleaseQuotaBundleInput): QuotaBundle {
    if (!input.bundleId || typeof input.bundleId !== 'string' || !input.bundleId.trim()) {
      throw new ValidationError('bundleId is required');
    }
    if (!this.quota.releaseBundleInTransactionSync) {
      throw new Error('Tenant quota storage does not support in-transaction bundle release');
    }
    return this.quota.releaseBundleInTransactionSync(db, input);
  }

  /**
   * Renew / extend quota bundle TTL.
   */
  async renewBundle(input: RenewQuotaBundleInput): Promise<QuotaBundle> {
    if (!input.bundleId || typeof input.bundleId !== 'string' || !input.bundleId.trim()) {
      throw new ValidationError('bundleId is required');
    }
    if (input.extendSeconds !== undefined) {
      assertPositiveInteger(input.extendSeconds, 'extendSeconds');
    }
    if (!this.quota.renewBundle) {
      throw new Error('Tenant quota storage does not support bundle renewal');
    }

    const bundle = await this.quota.renewBundle(input);

    if (this.auditLogs) {
      await this.auditLogs.record({
        userId: this.userId,
        action: 'quota_bundle_renewed',
        resourceType: 'quota_bundle',
        resourceId: bundle.id,
        details: {
          expiresAt: bundle.expiresAt,
        },
      });
    }

    return bundle;
  }

  /**
   * Find a quota bundle by bundle ID.
   */
  async getBundle(bundleId: string): Promise<QuotaBundle | null> {
    if (!bundleId || typeof bundleId !== 'string' || !bundleId.trim()) {
      throw new ValidationError('bundleId is required');
    }
    if (!this.quota.findBundleById) {
      return null;
    }
    return this.quota.findBundleById(bundleId.trim());
  }

  /**
   * Find a quota bundle by delivery ID.
   */
  async getBundleByDeliveryId(deliveryId: string): Promise<QuotaBundle | null> {
    if (!deliveryId || typeof deliveryId !== 'string' || !deliveryId.trim()) {
      throw new ValidationError('deliveryId is required');
    }
    if (!this.quota.findBundleByDeliveryId) {
      return null;
    }
    return this.quota.findBundleByDeliveryId(deliveryId.trim());
  }

  /**
   * Retrieve the last factual committed token usage for a session.
   * Returns 0 if no prior committed turn bundle exists.
   */
  async getLastCommittedTokens(sessionId: string): Promise<number> {
    if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new ValidationError('sessionId is required');
    }
    if (!this.quota.getLastCommittedTokens) {
      return 0;
    }
    return this.quota.getLastCommittedTokens(sessionId.trim());
  }
}
