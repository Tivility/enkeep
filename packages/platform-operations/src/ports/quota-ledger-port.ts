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
  QuotaBundle,
  ReserveQuotaBundleInput,
  CommitQuotaBundleInput,
  ReleaseQuotaBundleInput,
  RenewQuotaBundleInput,
} from '../types/quota.js';

export interface TenantScopedQuotaLedgerRepository {
  readonly userId: string;

  /**
   * Get configured quota limit for a resource.
   */
  getLimit(resource: QuotaMetric): Promise<TenantQuotaLimit | null>;

  /**
   * Set or update configured quota limit for a resource.
   */
  setLimit(input: SetQuotaLimitInput): Promise<TenantQuotaLimit>;

  /**
   * List all configured limits for this tenant.
   */
  listLimits(): Promise<TenantQuotaLimit[]>;

  /**
   * Get current usage summary (limit, used, reserved, remaining) for a resource.
   */
  getUsage(resource: QuotaMetric): Promise<QuotaUsageSummary>;

  /**
   * Get usage summary across all core resources.
   */
  getAllUsages?(): Promise<Record<string, QuotaUsageSummary>>;

  /**
   * Atomically reserve quota for a 2-phase operation.
   * Fails with QuotaExceededError if available balance (limit - used - reserved) < amount.
   */
  reserve(input: ReserveQuotaInput): Promise<QuotaReservation>;

  /**
   * Atomically commit a reserved quota, adding actualAmount to used counter and marking reservation committed.
   */
  commit(input: CommitQuotaInput): Promise<{ reservation: QuotaReservation; usage: QuotaUsageSummary }>;

  /**
   * Atomically release a reservation without consuming it.
   */
  release(input: ReleaseQuotaInput): Promise<QuotaReservation>;

  /**
   * Atomically consume quota directly (1-phase).
   */
  directConsume(input: ConsumeQuotaInput): Promise<QuotaUsageSummary>;

  /**
   * Expire stale reservations whose ttl has passed without commit.
   */
  expireStaleReservations(nowIso?: string): Promise<{ expiredCount: number; reservationIds: string[] }>;

  /**
   * Atomically adjust quota usage by delta (positive or negative).
   * Positive delta increases usage (fails if insufficient quota).
   * Negative delta decreases usage (clamped at 0).
   */
  adjustUsage?(input: { resource: QuotaMetric; delta: number }): Promise<QuotaUsageSummary>;

  /**
   * Atomically decrement quota usage by a non-negative amount (clamped at 0).
   */
  decrementUsage?(resource: QuotaMetric, amount: number): Promise<QuotaUsageSummary>;

  /**
   * Atomically set baseline quota usage (e.g. from volume scan).
   */
  setBaselineUsage?(resource: QuotaMetric, amount: number): Promise<QuotaUsageSummary>;

  /**
   * Multi-metric Atomic Bundle Reservation:
   * Atomically verifies balance for turns, messages, and tokens, then creates persistent quota bundle.
   * Returns existing bundle idempotently for the same deliveryId if requestHash matches.
   */
  reserveBundle?(input: ReserveQuotaBundleInput): Promise<QuotaBundle>;

  /**
   * Atomically commit a quota bundle (turns, messages, tokens) in standalone transaction.
   */
  commitBundle?(input: CommitQuotaBundleInput): Promise<QuotaBundle>;

  /**
   * Atomically commit a quota bundle inside an existing caller-owned SQLite transaction synchronously.
   */
  commitBundleInTransactionSync?(db: DatabaseSync, input: CommitQuotaBundleInput): QuotaBundle;

  /**
   * Atomically release a quota bundle back to the available quota pool.
   */
  releaseBundle?(input: ReleaseQuotaBundleInput): Promise<QuotaBundle>;

  /**
   * Atomically release a quota bundle inside an existing caller-owned SQLite transaction synchronously.
   */
  releaseBundleInTransactionSync?(db: DatabaseSync, input: ReleaseQuotaBundleInput): QuotaBundle;

  /**
   * Renew/extend a pending quota bundle's TTL.
   */
  renewBundle?(input: RenewQuotaBundleInput): Promise<QuotaBundle>;

  /**
   * Find a quota bundle by its authoritative bundleId.
   */
  findBundleById?(bundleId: string): Promise<QuotaBundle | null>;

  /**
   * Find a quota bundle by deliveryId.
   */
  findBundleByDeliveryId?(deliveryId: string): Promise<QuotaBundle | null>;

  /**
   * Retrieve the last factual committed token usage for a session.
   * Returns 0 if no prior committed turn bundle exists.
   */
  getLastCommittedTokens?(sessionId: string): Promise<number>;
}
