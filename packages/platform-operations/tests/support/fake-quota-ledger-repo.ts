import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  TenantScopedQuotaLedgerRepository,
  TenantQuotaLimit,
  QuotaUsageSummary,
  QuotaReservation,
  SetQuotaLimitInput,
  ReserveQuotaInput,
  CommitQuotaInput,
  ReleaseQuotaInput,
  ConsumeQuotaInput,
  QuotaMetric,
  QuotaBundle,
  ReserveQuotaBundleInput,
  CommitQuotaBundleInput,
  ReleaseQuotaBundleInput,
  RenewQuotaBundleInput,
} from '../../src/types/quota.js';
import {
  CORE_QUOTA_METRICS,
  assertPositiveInteger,
  assertNonNegativeInteger,
  assertQuotaLimit,
  validateQuotaMetric,
  computeCanonicalQuotaRequestHash,
} from '../../src/types/quota.js';
import {
  QuotaExceededError,
  InvalidReservationError,
  ReservationSettledError,
  IdempotencyConflictError,
} from '../../src/errors/index.js';

export class FakeTenantScopedQuotaLedgerRepository implements TenantScopedQuotaLedgerRepository {
  readonly userId: string;
  private readonly limits: Map<QuotaMetric, TenantQuotaLimit> = new Map();
  private readonly usage: Map<QuotaMetric, number> = new Map();
  private readonly reservations: Map<string, QuotaReservation> = new Map();
  private readonly bundles: Map<string, QuotaBundle> = new Map();

  constructor(userId: string) {
    this.userId = userId;
  }

  async setLimit(input: SetQuotaLimitInput): Promise<TenantQuotaLimit> {
    const resource = validateQuotaMetric(input.resource);
    const limit = assertQuotaLimit(input.limit, 'Quota limit');
    const windowSeconds = input.windowSeconds !== undefined ? assertPositiveInteger(input.windowSeconds, 'windowSeconds') : null;
    const nowIso = new Date().toISOString();

    const record: TenantQuotaLimit = {
      userId: this.userId,
      resource,
      limit,
      windowSeconds,
      resetAt: input.resetAt ?? null,
      resetInterval: input.resetInterval ?? 'none',
      updatedAt: nowIso,
    };
    this.limits.set(resource, record);
    return record;
  }

  async getLimit(resource: QuotaMetric): Promise<TenantQuotaLimit | null> {
    const metric = validateQuotaMetric(resource);
    return this.limits.get(metric) ?? null;
  }

  async listLimits(): Promise<TenantQuotaLimit[]> {
    return Array.from(this.limits.values());
  }

  private advanceResetAt(currentResetAtIso: string, limitRecord: TenantQuotaLimit, nowIso: string): string | null {
    const interval = limitRecord.resetInterval;
    const windowSeconds = limitRecord.windowSeconds;

    let d = new Date(currentResetAtIso);
    if (isNaN(d.getTime())) {
      d = new Date(nowIso);
    }

    if (interval === 'daily') {
      while (d.toISOString() <= nowIso) {
        d = new Date(d.getTime() + 86400 * 1000);
      }
      return d.toISOString();
    }
    if (interval === 'monthly') {
      while (d.toISOString() <= nowIso) {
        d.setMonth(d.getMonth() + 1);
      }
      return d.toISOString();
    }
    if (windowSeconds && windowSeconds > 0) {
      while (d.toISOString() <= nowIso) {
        d = new Date(d.getTime() + windowSeconds * 1000);
      }
      return d.toISOString();
    }
    return null;
  }

  private getUsageInternal(metric: QuotaMetric, nowIso: string): QuotaUsageSummary {
    const limitRecord = this.limits.get(metric);

    let limit: number;
    let resetAt: string | null = null;
    if (limitRecord) {
      limit = limitRecord.limit;
      resetAt = limitRecord.resetAt ?? null;

      // Lazy window reset
      if (resetAt && resetAt <= nowIso) {
        this.usage.set(metric, 0);
        for (const [id, res] of this.reservations.entries()) {
          if (res.userId === this.userId && res.resource === metric && res.status === 'reserved') {
            if (res.createdAt <= resetAt || res.expiresAt <= nowIso) {
              this.reservations.set(id, { ...res, status: 'expired' });
            }
          }
        }
        const nextReset = this.advanceResetAt(resetAt, limitRecord, nowIso);
        limitRecord.resetAt = nextReset;
        limitRecord.updatedAt = nowIso;
        resetAt = nextReset;
      }
    } else {
      // Pure fail-closed: unconfigured resource limit is 0
      limit = 0;
    }

    const used = this.usage.get(metric) ?? 0;

    let reserved = 0;
    for (const res of this.reservations.values()) {
      if (res.userId === this.userId && res.resource === metric && res.status === 'reserved') {
        if (res.expiresAt > nowIso) {
          reserved += res.amount;
        }
      }
    }

    const isUnlimited = limit < 0;
    const remaining = isUnlimited ? -1 : Math.max(0, limit - used - reserved);
    const allowed = isUnlimited ? true : (limit > 0 && remaining > 0);

    return {
      userId: this.userId,
      resource: metric,
      limit,
      used,
      reserved,
      remaining,
      allowed,
      resetAt,
    };
  }

  async adjustUsage(input: { resource: QuotaMetric; delta: number }): Promise<QuotaUsageSummary> {
    const metric = validateQuotaMetric(input.resource);
    const nowIso = new Date().toISOString();
    const current = this.getUsageInternal(metric, nowIso);

    if (input.delta > 0) {
      if (current.limit >= 0 && current.remaining < input.delta) {
        throw new QuotaExceededError(metric, input.delta, current.remaining, 'Quota exceeded');
      }
      const newUsed = current.used + input.delta;
      this.usage.set(metric, newUsed);
    } else if (input.delta < 0) {
      const newUsed = Math.max(0, current.used + input.delta);
      this.usage.set(metric, newUsed);
    }

    return this.getUsageInternal(metric, nowIso);
  }

  async decrementUsage(resource: QuotaMetric, amount: number): Promise<QuotaUsageSummary> {
    const metric = validateQuotaMetric(resource);
    const nonNeg = assertNonNegativeInteger(amount, 'amount');
    return this.adjustUsage({ resource: metric, delta: -nonNeg });
  }

  async setBaselineUsage(resource: QuotaMetric, amount: number): Promise<QuotaUsageSummary> {
    const metric = validateQuotaMetric(resource);
    const nonNeg = assertNonNegativeInteger(amount, 'amount');
    this.usage.set(metric, nonNeg);
    const nowIso = new Date().toISOString();
    return this.getUsageInternal(metric, nowIso);
  }

  async getUsage(resource: QuotaMetric): Promise<QuotaUsageSummary> {
    const metric = validateQuotaMetric(resource);
    const nowIso = new Date().toISOString();
    return this.getUsageInternal(metric, nowIso);
  }

  async getAllUsages(): Promise<Record<string, QuotaUsageSummary>> {
    const nowIso = new Date().toISOString();
    const result: Record<string, QuotaUsageSummary> = {};
    for (const metric of CORE_QUOTA_METRICS) {
      result[metric] = this.getUsageInternal(metric, nowIso);
    }
    return result;
  }

  async findReservationById(reservationId: string): Promise<QuotaReservation | null> {
    const res = this.reservations.get(reservationId);
    if (!res || res.userId !== this.userId) {
      return null;
    }
    return res;
  }

  async listReservations(options?: { status?: string; resource?: string; limit?: number; offset?: number }): Promise<QuotaReservation[]> {
    let list = Array.from(this.reservations.values()).filter((r) => r.userId === this.userId);
    if (options?.status) {
      list = list.filter((r) => r.status === options.status);
    }
    if (options?.resource) {
      list = list.filter((r) => r.resource === options.resource);
    }
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (options?.offset) {
      list = list.slice(options.offset);
    }
    if (options?.limit) {
      list = list.slice(0, options.limit);
    }
    return list;
  }

  async reserve(input: ReserveQuotaInput): Promise<QuotaReservation> {
    const resource = validateQuotaMetric(input.resource);
    const amount = assertPositiveInteger(input.amount, 'Reservation amount');
    const ttlSeconds = input.ttlSeconds !== undefined ? assertPositiveInteger(input.ttlSeconds, 'ttlSeconds') : 300;

    const nowIso = new Date().toISOString();
    const usage = this.getUsageInternal(resource, nowIso);

    if (usage.limit >= 0 && usage.remaining < amount) {
      throw new QuotaExceededError(
        resource,
        amount,
        usage.remaining,
        `Quota exceeded for resource "${resource}". Requested: ${amount}, Remaining: ${usage.remaining}, Limit: ${usage.limit}`
      );
    }

    const id = `res_${randomUUID()}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

    const reservation: QuotaReservation = {
      id,
      userId: this.userId,
      resource,
      amount,
      status: 'reserved',
      expiresAt,
      createdAt: nowIso,
    };

    this.reservations.set(id, reservation);
    return reservation;
  }

  async commit(input: CommitQuotaInput): Promise<{ reservation: QuotaReservation; usage: QuotaUsageSummary }> {
    const reservationId = input.reservationId;
    const reservation = this.reservations.get(reservationId);
    if (!reservation || reservation.userId !== this.userId) {
      throw new InvalidReservationError(reservationId, `Reservation "${reservationId}" not found for user`);
    }

    if (reservation.status !== 'reserved') {
      throw new ReservationSettledError(
        reservationId,
        reservation.status
      );
    }

    const nowIso = new Date().toISOString();
    if (reservation.expiresAt <= nowIso) {
      reservation.status = 'expired';
      throw new ReservationSettledError(reservationId, 'expired');
    }

    const actualAmount = input.actualAmount !== undefined ? assertNonNegativeInteger(input.actualAmount, 'actualAmount') : reservation.amount;

    reservation.status = 'committed';
    reservation.committedAmount = actualAmount;
    reservation.committedAt = nowIso;
    reservation.settledAt = nowIso;

    const currentUsed = this.usage.get(reservation.resource) ?? 0;
    this.usage.set(reservation.resource, currentUsed + actualAmount);

    const usage = this.getUsageInternal(reservation.resource, nowIso);
    return { reservation, usage };
  }

  async release(input: ReleaseQuotaInput): Promise<QuotaReservation> {
    const reservationId = input.reservationId;
    const reservation = this.reservations.get(reservationId);
    if (!reservation || reservation.userId !== this.userId) {
      throw new InvalidReservationError(reservationId, `Reservation "${reservationId}" not found for user`);
    }

    if (reservation.status !== 'reserved') {
      throw new ReservationSettledError(
        reservationId,
        reservation.status
      );
    }

    const nowIso = new Date().toISOString();
    reservation.status = 'released';
    reservation.releasedAt = nowIso;
    reservation.settledAt = nowIso;

    return reservation;
  }

  async directConsume(input: ConsumeQuotaInput): Promise<QuotaUsageSummary> {
    const resource = validateQuotaMetric(input.resource);
    const amount = assertPositiveInteger(input.amount, 'Direct consume amount');
    const nowIso = new Date().toISOString();

    const usage = this.getUsageInternal(resource, nowIso);
    if (usage.limit >= 0 && usage.remaining < amount) {
      throw new QuotaExceededError(
        resource,
        amount,
        usage.remaining,
        `Quota exceeded for direct consumption of resource "${resource}". Requested: ${amount}, Remaining: ${usage.remaining}, Limit: ${usage.limit}`
      );
    }

    const currentUsed = this.usage.get(resource) ?? 0;
    this.usage.set(resource, currentUsed + amount);

    return this.getUsageInternal(resource, nowIso);
  }

  async expireStaleReservations(now?: string): Promise<{ expiredCount: number; reservationIds: string[] }> {
    const nowIso = now ?? new Date().toISOString();
    const expiredIds: string[] = [];

    for (const [id, res] of this.reservations.entries()) {
      if (res.userId === this.userId && res.status === 'reserved' && res.expiresAt <= nowIso) {
        res.status = 'expired';
        expiredIds.push(id);
      }
    }

    for (const [, bundle] of this.bundles.entries()) {
      if (bundle.userId === this.userId && bundle.status === 'reserved' && bundle.expiresAt <= nowIso) {
        bundle.status = 'expired';
      }
    }

    return {
      expiredCount: expiredIds.length,
      reservationIds: expiredIds,
    };
  }

  // --- Bundle Operations ---

  async reserveBundle(input: ReserveQuotaBundleInput): Promise<QuotaBundle> {
    const nowIso = new Date().toISOString();
    const turns = assertPositiveInteger(input.turns, 'turns');
    const messages = assertPositiveInteger(input.messages, 'messages');
    const tokens = input.tokens !== undefined && input.tokens > 0 ? assertPositiveInteger(input.tokens, 'tokens') : 0;
    const ttlSeconds = input.ttlSeconds !== undefined ? assertPositiveInteger(input.ttlSeconds, 'ttlSeconds') : 900;
    const requestHash = input.requestHash ?? `${input.sessionId}:${turns}:${messages}:${tokens}`;

    // 1. Check existing bundle for this (userId, deliveryId)
    for (const b of this.bundles.values()) {
      if (b.userId === this.userId && b.deliveryId === input.deliveryId) {
        if (b.requestHash !== requestHash) {
          throw new IdempotencyConflictError(
            input.deliveryId,
            `Quota bundle for delivery "${input.deliveryId}" already exists with different parameters`
          );
        }
        if (b.status === 'committed') {
          return b;
        }
        if (b.status === 'reserved' && b.expiresAt > nowIso) {
          return b;
        }
        if (b.status === 'released') {
          throw new ReservationSettledError(b.id, 'released');
        }
        if (b.status === 'expired' || (b.status === 'reserved' && b.expiresAt <= nowIso)) {
          throw new ReservationSettledError(b.id, 'expired');
        }
      }
    }

    // 2. Validate balance for turns, messages, tokens
    const turnsUsage = this.getUsageInternal('turns', nowIso);
    if (turnsUsage.limit >= 0 && turnsUsage.remaining < turns) {
      throw new QuotaExceededError('turns', turns, turnsUsage.remaining, `Quota exceeded for "turns"`);
    }

    const messagesUsage = this.getUsageInternal('messages', nowIso);
    if (messagesUsage.limit >= 0 && messagesUsage.remaining < messages) {
      throw new QuotaExceededError('messages', messages, messagesUsage.remaining, `Quota exceeded for "messages"`);
    }

    if (tokens > 0) {
      const tokensUsage = this.getUsageInternal('tokens', nowIso);
      if (tokensUsage.limit >= 0 && tokensUsage.remaining < tokens) {
        throw new QuotaExceededError('tokens', tokens, tokensUsage.remaining, `Quota exceeded for "tokens"`);
      }
    }

    const bundleId = `bundle_${randomUUID()}`;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    const bundle: QuotaBundle = {
      id: bundleId,
      userId: this.userId,
      deliveryId: input.deliveryId,
      sessionId: input.sessionId,
      requestHash,
      status: 'reserved',
      turns,
      messages,
      tokens,
      isEstimateTokens: input.isEstimateTokens ?? true,
      expiresAt,
      createdAt: nowIso,
    };

    this.bundles.set(bundleId, bundle);

    // Insert reservations
    const resTurns: QuotaReservation = {
      id: `res_${randomUUID()}`,
      userId: this.userId,
      bundleId,
      deliveryId: input.deliveryId,
      resource: 'turns',
      amount: turns,
      status: 'reserved',
      expiresAt,
      createdAt: nowIso,
    };
    this.reservations.set(resTurns.id, resTurns);

    const resMessages: QuotaReservation = {
      id: `res_${randomUUID()}`,
      userId: this.userId,
      bundleId,
      deliveryId: input.deliveryId,
      resource: 'messages',
      amount: messages,
      status: 'reserved',
      expiresAt,
      createdAt: nowIso,
    };
    this.reservations.set(resMessages.id, resMessages);

    if (tokens > 0) {
      const resTokens: QuotaReservation = {
        id: `res_${randomUUID()}`,
        userId: this.userId,
        bundleId,
        deliveryId: input.deliveryId,
        resource: 'tokens',
        amount: tokens,
        status: 'reserved',
        expiresAt,
        createdAt: nowIso,
      };
      this.reservations.set(resTokens.id, resTokens);
    }

    return bundle;
  }

  commitBundleInTransactionSync(_db: DatabaseSync, input: CommitQuotaBundleInput): QuotaBundle {
    const bundle = this.bundles.get(input.bundleId);
    if (!bundle || bundle.userId !== this.userId) {
      throw new InvalidReservationError(input.bundleId, `Quota bundle "${input.bundleId}" not found for user`);
    }

    if (bundle.status === 'committed') {
      return bundle;
    }

    if (bundle.status !== 'reserved') {
      throw new ReservationSettledError(input.bundleId, bundle.status);
    }

    const nowIso = new Date().toISOString();
    if (bundle.expiresAt <= nowIso) {
      bundle.status = 'expired';
      throw new ReservationSettledError(input.bundleId, 'expired');
    }

    if (input.actualUsage?.turns !== undefined && input.actualUsage.turns !== bundle.turns) {
      throw new Error(`Actual turns (${input.actualUsage.turns}) must match reserved bundle amount (${bundle.turns})`);
    }
    if (input.actualUsage?.messages !== undefined && input.actualUsage.messages !== bundle.messages) {
      throw new Error(`Actual messages (${input.actualUsage.messages}) must match reserved bundle amount (${bundle.messages})`);
    }

    const actualTurns = bundle.turns;
    const actualMessages = bundle.messages;
    const actualTokens = input.actualUsage?.tokens !== undefined ? assertNonNegativeInteger(input.actualUsage.tokens, 'tokens') : bundle.tokens;

    bundle.status = 'committed';
    bundle.turnsCommitted = actualTurns;
    bundle.messagesCommitted = actualMessages;
    bundle.tokensCommitted = actualTokens;
    bundle.settledAt = nowIso;

    // Settle reservations
    for (const res of this.reservations.values()) {
      if (res.bundleId === bundle.id && res.status === 'reserved') {
        res.status = 'committed';
        res.settledAt = nowIso;
        if (res.resource === 'turns') res.committedAmount = actualTurns;
        if (res.resource === 'messages') res.committedAmount = actualMessages;
        if (res.resource === 'tokens') res.committedAmount = actualTokens;
      }
    }

    // Increment usage
    this.usage.set('turns', (this.usage.get('turns') ?? 0) + actualTurns);
    this.usage.set('messages', (this.usage.get('messages') ?? 0) + actualMessages);
    if (actualTokens > 0) {
      this.usage.set('tokens', (this.usage.get('tokens') ?? 0) + actualTokens);
    }

    return bundle;
  }

  async commitBundle(input: CommitQuotaBundleInput): Promise<QuotaBundle> {
    return this.commitBundleInTransactionSync(null as any, input);
  }

  releaseBundleInTransactionSync(_db: DatabaseSync, input: ReleaseQuotaBundleInput): QuotaBundle {
    const bundle = this.bundles.get(input.bundleId);
    if (!bundle || bundle.userId !== this.userId) {
      throw new InvalidReservationError(input.bundleId, `Quota bundle "${input.bundleId}" not found for user`);
    }

    if (bundle.status === 'committed') {
      return bundle;
    }
    if (bundle.status === 'released' || bundle.status === 'expired') {
      return bundle;
    }

    const nowIso = new Date().toISOString();
    bundle.status = 'released';
    bundle.settledAt = nowIso;

    for (const res of this.reservations.values()) {
      if (res.bundleId === bundle.id && res.status === 'reserved') {
        res.status = 'released';
        res.settledAt = nowIso;
      }
    }

    return bundle;
  }

  async releaseBundle(input: ReleaseQuotaBundleInput): Promise<QuotaBundle> {
    return this.releaseBundleInTransactionSync(null as any, input);
  }

  async renewBundle(input: RenewQuotaBundleInput): Promise<QuotaBundle> {
    const bundle = this.bundles.get(input.bundleId);
    if (!bundle || bundle.userId !== this.userId) {
      throw new InvalidReservationError(input.bundleId, `Quota bundle "${input.bundleId}" not found for user`);
    }

    if (bundle.status !== 'reserved') {
      throw new ReservationSettledError(input.bundleId, bundle.status);
    }

    const extendSeconds = input.extendSeconds ?? 900;
    const expiresAt = new Date(Date.now() + extendSeconds * 1000).toISOString();
    bundle.expiresAt = expiresAt;

    for (const res of this.reservations.values()) {
      if (res.bundleId === bundle.id && res.status === 'reserved') {
        res.expiresAt = expiresAt;
      }
    }

    return bundle;
  }

  async findBundleById(bundleId: string): Promise<QuotaBundle | null> {
    const bundle = this.bundles.get(bundleId);
    if (!bundle || bundle.userId !== this.userId) {
      return null;
    }
    return bundle;
  }

  async findBundleByDeliveryId(deliveryId: string): Promise<QuotaBundle | null> {
    for (const b of this.bundles.values()) {
      if (b.userId === this.userId && b.deliveryId === deliveryId) {
        return b;
      }
    }
    return null;
  }

  async getLastCommittedTokens(sessionId: string): Promise<number> {
    const matching: QuotaBundle[] = [];
    for (const b of this.bundles.values()) {
      if (
        b.userId === this.userId &&
        b.sessionId === sessionId &&
        b.status === 'committed' &&
        typeof b.tokensCommitted === 'number' &&
        b.tokensCommitted > 0
      ) {
        matching.push(b);
      }
    }
    if (matching.length === 0) {
      return 0;
    }
    matching.sort((a, b) => {
      const timeA = a.settledAt || a.createdAt;
      const timeB = b.settledAt || b.createdAt;
      return timeB.localeCompare(timeA);
    });
    return matching[0].tokensCommitted ?? 0;
  }
}
