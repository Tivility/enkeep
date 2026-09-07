import type { DatabaseSync } from 'node:sqlite';
import type {
  TenantQuotaProvider,
  QuotaReservationBundle,
  QuotaReservationRequest,
} from '../runtime/delivery-gateway.js';
import {
  type PlatformOperationsService,
  type PlatformOperationsStorage,
  type QuotaBundle,
  type ReserveQuotaBundleInput,
  type CommitQuotaBundleInput,
  type ReleaseQuotaBundleInput,
  type RenewQuotaBundleInput,
  ReservationSettledError,
  computeCanonicalQuotaRequestHash,
  validateDeliveryId,
  validateSessionId,
  validateUserId,
  assertPositiveInteger,
  assertNonNegativeInteger,
  ValidationError,
} from '@enkeep/platform-operations';

/**
 * Authoritative interface for tenant quota operations required by TenantQuotaProvider.
 * All bundle methods and synchronous transaction hooks are mandatory.
 */
export interface TenantScopedQuotaOperations {
  reserveBundle(input: ReserveQuotaBundleInput): Promise<QuotaBundle>;
  commitBundle(input: CommitQuotaBundleInput): Promise<QuotaBundle>;
  releaseBundle(input: ReleaseQuotaBundleInput): Promise<QuotaBundle>;
  commitBundleInTransactionSync(db: DatabaseSync, input: CommitQuotaBundleInput): QuotaBundle;
  releaseBundleInTransactionSync(db: DatabaseSync, input: ReleaseQuotaBundleInput): QuotaBundle;
  renewBundle(input: RenewQuotaBundleInput): Promise<QuotaBundle>;
  findBundleByDeliveryId?(deliveryId: string): Promise<QuotaBundle | null>;
  getBundleByDeliveryId?(deliveryId: string): Promise<QuotaBundle | null>;
  getLastCommittedTokens?(sessionId: string): Promise<number>;
}

export interface TenantOperationsSource {
  forTenant(userId: string): {
    readonly quota: TenantScopedQuotaOperations;
  };
}

export type PlatformOperationsQuotaSource =
  | PlatformOperationsService
  | PlatformOperationsStorage
  | TenantOperationsSource;

/**
 * Authoritative Quota Reservation Bundle representing the multi-metric reservation
 * (turns, messages, tokens) for an agent turn.
 */
export class OperationsQuotaReservationBundle implements QuotaReservationBundle {
  readonly reservationId: string;
  readonly userId: string;
  readonly turns: number;
  readonly messages: number;
  readonly tokens: number;
  readonly isEstimateTokens: boolean;

  private readonly operationsSource: PlatformOperationsQuotaSource;
  private isSettled = false;
  private settledStatus?: 'committed' | 'released' | 'expired';

  constructor(options: {
    reservationId: string;
    userId: string;
    turns: number;
    messages: number;
    tokens: number;
    isEstimateTokens: boolean;
    operationsSource: PlatformOperationsQuotaSource;
  }) {
    this.reservationId = options.reservationId;
    this.userId = options.userId;
    this.turns = options.turns;
    this.messages = options.messages;
    this.tokens = options.tokens;
    this.isEstimateTokens = options.isEstimateTokens;
    this.operationsSource = options.operationsSource;
  }

  private getTenantQuota(): TenantScopedQuotaOperations {
    const tenantOps = this.operationsSource.forTenant(this.userId);
    return tenantOps.quota as TenantScopedQuotaOperations;
  }

  /**
   * Commits all reserved metrics atomically with idempotency.
   * If already committed, returns cleanly. If released or expired, throws ReservationSettledError.
   */
  async commit(actualUsage: { turns: number; messages: number; tokens: number }): Promise<void> {
    if (this.isSettled && this.settledStatus === 'committed') {
      return;
    }
    if (this.isSettled && this.settledStatus && this.settledStatus !== 'committed') {
      throw new ReservationSettledError(this.reservationId, this.settledStatus);
    }

    assertPositiveInteger(actualUsage.turns, 'actualUsage.turns');
    assertPositiveInteger(actualUsage.messages, 'actualUsage.messages');
    assertNonNegativeInteger(actualUsage.tokens, 'actualUsage.tokens');

    const tenantQuota = this.getTenantQuota();
    try {
      const result = await tenantQuota.commitBundle({
        bundleId: this.reservationId,
        actualUsage,
      });
      this.isSettled = true;
      this.settledStatus = result.status as 'committed' | 'released' | 'expired';
    } catch (err: unknown) {
      if (err instanceof ReservationSettledError) {
        this.isSettled = true;
        this.settledStatus = err.currentStatus as 'committed' | 'released' | 'expired';
        if (err.currentStatus === 'committed') {
          return;
        }
      }
      throw err;
    }
  }

  /**
   * Releases reserved metrics back to available quota.
   * If already committed or released, returns cleanly (no-op).
   */
  async release(): Promise<void> {
    if (this.isSettled && (this.settledStatus === 'committed' || this.settledStatus === 'released')) {
      return;
    }

    const tenantQuota = this.getTenantQuota();
    try {
      const result = await tenantQuota.releaseBundle({
        bundleId: this.reservationId,
        reason: 'TURN_RELEASED',
      });
      this.isSettled = true;
      this.settledStatus = result.status as 'committed' | 'released' | 'expired';
    } catch (err: unknown) {
      if (err instanceof ReservationSettledError) {
        this.isSettled = true;
        this.settledStatus = err.currentStatus as 'committed' | 'released' | 'expired';
        if (err.currentStatus === 'committed' || err.currentStatus === 'released') {
          return;
        }
      }
      throw err;
    }
  }

  /**
   * Extends the reservation TTL.
   */
  async renew(extendSeconds = 900): Promise<void> {
    if (this.isSettled && this.settledStatus) {
      throw new ReservationSettledError(this.reservationId, this.settledStatus);
    }
    assertPositiveInteger(extendSeconds, 'extendSeconds');
    const tenantQuota = this.getTenantQuota();
    await tenantQuota.renewBundle({
      bundleId: this.reservationId,
      extendSeconds,
    });
  }

  /**
   * Synchronously commits bundle inside an active SQLite transaction owned by caller.
   */
  commitInTransaction(
    db: DatabaseSync,
    actualUsage: { turns: number; messages: number; tokens: number }
  ): void {
    if (this.isSettled && this.settledStatus === 'committed') {
      return;
    }
    if (this.isSettled && this.settledStatus && this.settledStatus !== 'committed') {
      throw new ReservationSettledError(this.reservationId, this.settledStatus);
    }

    assertPositiveInteger(actualUsage.turns, 'actualUsage.turns');
    assertPositiveInteger(actualUsage.messages, 'actualUsage.messages');
    assertNonNegativeInteger(actualUsage.tokens, 'actualUsage.tokens');

    const tenantQuota = this.getTenantQuota();
    const result = tenantQuota.commitBundleInTransactionSync(db, {
      bundleId: this.reservationId,
      actualUsage,
    });
    this.isSettled = true;
    this.settledStatus = result.status as 'committed' | 'released' | 'expired';
  }

  /**
   * Synchronously releases bundle inside an active SQLite transaction owned by caller.
   */
  releaseInTransaction(db: DatabaseSync): void {
    if (this.isSettled && (this.settledStatus === 'committed' || this.settledStatus === 'released')) {
      return;
    }

    const tenantQuota = this.getTenantQuota();
    const result = tenantQuota.releaseBundleInTransactionSync(db, {
      bundleId: this.reservationId,
      reason: 'TURN_RELEASED',
    });
    this.isSettled = true;
    this.settledStatus = result.status as 'committed' | 'released' | 'expired';
  }
}

/**
 * Production TenantQuotaProvider implementation integrating PlatformOperationsStorage / PlatformOperationsService
 * with DeliveryRuntimeGateway.
 *
 * Enforces:
 * 1. Multi-metric atomic reservation: turns, messages, and tokens in a single DB transaction.
 * 2. Authoritative DB bundle UUID receipt.
 * 3. Delivery-level idempotency matching canonical SHA-256 request hash.
 * 4. Synchronous commit & release in caller transaction for zero unbilled leaks.
 * 5. Strict ID validation without mutation, default substitution, or raw leakage.
 */
export class OperationsTenantQuotaProvider implements TenantQuotaProvider {
  private readonly defaultTtlSeconds: number;

  constructor(
    private readonly operationsSource: PlatformOperationsQuotaSource,
    options?: { defaultTtlSeconds?: number }
  ) {
    if (!operationsSource) {
      throw new ValidationError('OperationsTenantQuotaProvider requires an operations source');
    }
    if (options?.defaultTtlSeconds !== undefined) {
      if (
        typeof options.defaultTtlSeconds !== 'number' ||
        !Number.isFinite(options.defaultTtlSeconds) ||
        !Number.isSafeInteger(options.defaultTtlSeconds) ||
        options.defaultTtlSeconds <= 0
      ) {
        throw new ValidationError('Invalid defaultTtlSeconds: must be a positive safe integer');
      }
      this.defaultTtlSeconds = options.defaultTtlSeconds;
    } else {
      this.defaultTtlSeconds = 900;
    }
  }

  getDefaultTtlSeconds(): number {
    return this.defaultTtlSeconds;
  }

  private getTenantQuota(userId: string): TenantScopedQuotaOperations {
    const tenantOps = this.operationsSource.forTenant(userId);
    return tenantOps.quota as TenantScopedQuotaOperations;
  }

  async reserve(request: QuotaReservationRequest): Promise<QuotaReservationBundle> {
    if (!request || typeof request !== 'object') {
      throw new ValidationError('Tenant quota reservation request must be a valid object');
    }

    const userId = validateUserId(request.userId);
    const deliveryId = validateDeliveryId(request.deliveryId);
    const sessionId = validateSessionId(request.sessionId);
    const turns = assertPositiveInteger(request.turns, 'turns');
    const messages = assertPositiveInteger(request.messages, 'messages');
    const tokens = assertNonNegativeInteger(request.tokens, 'tokens');

    if (typeof request.isEstimateTokens !== 'boolean') {
      throw new ValidationError('Tenant quota reservation requires boolean isEstimateTokens');
    }
    const isEstimateTokens = request.isEstimateTokens;

    let ttlSeconds: number;
    if (request.ttlSeconds !== undefined) {
      ttlSeconds = assertPositiveInteger(request.ttlSeconds, 'ttlSeconds');
    } else {
      ttlSeconds = this.defaultTtlSeconds;
    }

    // Cryptographic canonical SHA-256 request hash
    const requestHash = computeCanonicalQuotaRequestHash({
      userId,
      sessionId,
      deliveryId,
      turns,
      messages,
      tokens,
      isEstimateTokens,
    });

    const tenantQuota = this.getTenantQuota(userId);

    const bundle: QuotaBundle = await tenantQuota.reserveBundle({
      deliveryId,
      sessionId,
      turns,
      messages,
      tokens,
      isEstimateTokens,
      ttlSeconds,
      requestHash,
    });

    return new OperationsQuotaReservationBundle({
      reservationId: bundle.id,
      userId,
      turns: bundle.turns,
      messages: bundle.messages,
      tokens: bundle.tokens,
      isEstimateTokens: bundle.isEstimateTokens,
      operationsSource: this.operationsSource,
    });
  }

  async recoverReservation(
    deliveryId: string,
    userId?: string
  ): Promise<QuotaReservationBundle | null> {
    const validDeliveryId = validateDeliveryId(deliveryId);

    if (userId) {
      const validUserId = validateUserId(userId);
      const tenantQuota = this.getTenantQuota(validUserId);
      let bundle: QuotaBundle | null = null;
      if (typeof tenantQuota.getBundleByDeliveryId === 'function') {
        bundle = await tenantQuota.getBundleByDeliveryId(validDeliveryId);
      } else if (typeof tenantQuota.findBundleByDeliveryId === 'function') {
        bundle = await tenantQuota.findBundleByDeliveryId(validDeliveryId);
      }
      if (!bundle) {
        return null;
      }
      return new OperationsQuotaReservationBundle({
        reservationId: bundle.id,
        userId: bundle.userId,
        turns: bundle.turns,
        messages: bundle.messages,
        tokens: bundle.tokens,
        isEstimateTokens: bundle.isEstimateTokens,
        operationsSource: this.operationsSource,
      });
    }

    return null;
  }

  async getLastCommittedTokens(userId: string, sessionId: string): Promise<number> {
    const validUserId = validateUserId(userId);
    const validSessionId = validateSessionId(sessionId);
    const tenantQuota = this.getTenantQuota(validUserId);
    if (typeof tenantQuota.getLastCommittedTokens === 'function') {
      return await tenantQuota.getLastCommittedTokens(validSessionId);
    }
    return 0;
  }

  commitInTransaction(
    db: DatabaseSync,
    bundle: QuotaReservationBundle,
    actualUsage: { turns: number; messages: number; tokens: number }
  ): void {
    bundle.commitInTransaction(db, actualUsage);
  }

  releaseInTransaction(
    db: DatabaseSync,
    bundle: QuotaReservationBundle
  ): void {
    bundle.releaseInTransaction(db);
  }

  async commit(
    bundle: QuotaReservationBundle,
    actualUsage: { turns: number; messages: number; tokens: number }
  ): Promise<void> {
    await bundle.commit(actualUsage);
  }

  async release(bundle: QuotaReservationBundle): Promise<void> {
    await bundle.release();
  }

  async renew(bundle: QuotaReservationBundle, extendSeconds = 900): Promise<void> {
    await bundle.renew(extendSeconds);
  }
}

export function createOperationsTenantQuotaProvider(
  operationsSource: PlatformOperationsQuotaSource,
  options?: { defaultTtlSeconds?: number }
): OperationsTenantQuotaProvider {
  return new OperationsTenantQuotaProvider(operationsSource, options);
}
