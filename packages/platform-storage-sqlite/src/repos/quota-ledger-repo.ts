import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { PlatformError } from '@enkeep/platform-core';
import type {
  TenantScopedQuotaLedgerRepository,
  TenantQuotaLimit,
  QuotaUsageSummary,
  QuotaReservation,
  SetQuotaLimitInput,
  ReserveQuotaInput,
  CommitQuotaInput,
  ReleaseQuotaInput,
  DirectConsumeQuotaInput,
  QuotaMetric,
  QuotaOptions,
  QuotaBundle,
  ReserveQuotaBundleInput,
  CommitQuotaBundleInput,
  ReleaseQuotaBundleInput,
  RenewQuotaBundleInput,
} from '@enkeep/platform-operations';
import {
  CORE_QUOTA_METRICS,
  assertPositiveInteger,
  assertNonNegativeInteger,
  assertQuotaLimit,
  validateQuotaMetric,
  computeCanonicalQuotaRequestHash,
  QuotaExceededError,
  InvalidReservationError,
  ReservationSettledError,
  IdempotencyConflictError,
  ValidationError,
} from '@enkeep/platform-operations';
import {
  type DbRow,
  parseQuotaLimitRow,
  parseQuotaReservationRow,
  parseQuotaBundleRow,
  queryOne,
  queryAll,
  getNumber,
  getNullableNumber,
  getNullableString,
  withImmediateTransactionSync,
} from '../utils/db.js';

export const BUNDLE_ID_REGEX = /^qbd_[0-9a-f]{32}$/;
export const RESERVATION_ID_REGEX = /^qrs_[0-9a-f]{32}$/;

function validateBundleId(bundleId: unknown): string {
  if (typeof bundleId !== 'string' || !BUNDLE_ID_REGEX.test(bundleId)) {
    throw new InvalidReservationError('', 'Invalid bundle ID');
  }
  return bundleId;
}

function validateReservationId(reservationId: unknown): string {
  if (typeof reservationId !== 'string' || !RESERVATION_ID_REGEX.test(reservationId)) {
    throw new InvalidReservationError('', 'Invalid reservation ID');
  }
  return reservationId;
}

/**
 * Deterministically advances a UTC Date by exactly one calendar month,
 * clamping the day-of-month to the maximum valid days in the target month
 * (e.g. Jan 31 -> Feb 28 in non-leap year, avoiding rollover jump into March).
 */
export function advanceUtcMonth(d: Date): Date {
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();
  const hours = d.getUTCHours();
  const minutes = d.getUTCMinutes();
  const seconds = d.getUTCSeconds();
  const ms = d.getUTCMilliseconds();

  const nextMonth = (month + 1) % 12;
  const nextYear = month === 11 ? year + 1 : year;

  // Day 0 of nextMonth + 1 gives the last day of nextMonth
  const maxDaysInNextMonth = new Date(Date.UTC(nextYear, nextMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(day, maxDaysInNextMonth);

  return new Date(Date.UTC(nextYear, nextMonth, targetDay, hours, minutes, seconds, ms));
}

export class SqliteTenantScopedQuotaLedgerRepository implements TenantScopedQuotaLedgerRepository {
  readonly userId: string;
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync, userId: string, _options?: QuotaOptions) {
    this.db = db;
    this.userId = userId;
  }

  async setLimit(input: SetQuotaLimitInput): Promise<TenantQuotaLimit> {
    const resource = validateQuotaMetric(input.resource);
    const limit = assertQuotaLimit(input.limit, 'Quota limit');
    const windowSeconds = input.windowSeconds !== undefined ? assertPositiveInteger(input.windowSeconds, 'windowSeconds') : null;
    const resetAt = input.resetAt ?? null;
    const resetInterval = input.resetInterval ?? 'none';
    const nowIso = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO quota_limits (user_id, resource, limit_amount, window_seconds, reset_at, reset_interval, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, resource) DO UPDATE SET
        limit_amount = excluded.limit_amount,
        window_seconds = excluded.window_seconds,
        reset_at = excluded.reset_at,
        reset_interval = excluded.reset_interval,
        updated_at = excluded.updated_at
    `).run(this.userId, resource, limit, windowSeconds, resetAt, resetInterval, nowIso);

    const lim = await this.getLimit(resource);
    if (!lim) {
      throw new Error('Failed to retrieve set quota limit for resource');
    }
    return lim;
  }

  async getLimit(resource: QuotaMetric): Promise<TenantQuotaLimit | null> {
    const metric = validateQuotaMetric(resource);
    const stmt = this.db.prepare('SELECT * FROM quota_limits WHERE user_id = ? AND resource = ?');
    return queryOne(stmt, parseQuotaLimitRow, this.userId, metric);
  }

  async listLimits(): Promise<TenantQuotaLimit[]> {
    const stmt = this.db.prepare('SELECT * FROM quota_limits WHERE user_id = ?');
    return queryAll(stmt, parseQuotaLimitRow, this.userId);
  }

  private advanceResetAt(currentResetAtIso: string, limitRow: DbRow, nowIso: string): string | null {
    if (typeof currentResetAtIso !== 'string' || currentResetAtIso.trim().length === 0) {
      throw new PlatformError(
        `Corrupted reset_at timestamp in database: expected non-empty ISO string, got "${String(currentResetAtIso)}"`,
        'DATABASE_CORRUPTED',
        500
      );
    }

    const d = new Date(currentResetAtIso);
    if (isNaN(d.getTime()) || d.toISOString() !== currentResetAtIso) {
      throw new PlatformError(
        `Corrupted reset_at timestamp in database: invalid date string "${currentResetAtIso}"`,
        'DATABASE_CORRUPTED',
        500
      );
    }

    const resetInterval = getNullableString(limitRow, 'reset_interval');
    const windowSeconds = getNullableNumber(limitRow, 'window_seconds');

    if (resetInterval === 'daily') {
      let next = d;
      while (next.toISOString() <= nowIso) {
        next = new Date(next.getTime() + 86400 * 1000);
      }
      return next.toISOString();
    }

    if (resetInterval === 'monthly') {
      let next = d;
      while (next.toISOString() <= nowIso) {
        next = advanceUtcMonth(next);
      }
      return next.toISOString();
    }

    if (windowSeconds && windowSeconds > 0) {
      let next = d;
      while (next.toISOString() <= nowIso) {
        next = new Date(next.getTime() + windowSeconds * 1000);
      }
      return next.toISOString();
    }

    return null;
  }

  /**
   * Internal helper to compute usage synchronously inside an active transaction.
   * Strictly fail-closed: unconfigured resource limit is 0, remaining is 0, allowed is false.
   * Performs lazy window reset when resetAt <= nowIso.
   */
  private getUsageInternal(resource: QuotaMetric, nowIso: string): QuotaUsageSummary {
    const limitRow = this.db.prepare('SELECT * FROM quota_limits WHERE user_id = ? AND resource = ?').get(this.userId, resource) as DbRow | undefined;

    let limit: number;
    let resetAt: string | null = null;
    if (limitRow) {
      limit = getNumber(limitRow, 'limit_amount');
      resetAt = getNullableString(limitRow, 'reset_at');

      if (resetAt !== null) {
        const d = new Date(resetAt);
        if (isNaN(d.getTime()) || d.toISOString() !== resetAt) {
          throw new PlatformError(
            `Corrupted reset_at timestamp in database: invalid date string "${resetAt}"`,
            'DATABASE_CORRUPTED',
            500
          );
        }
      }

      // Lazy Window Reset (under write transaction or active query)
      if (resetAt && resetAt <= nowIso) {
        // 1. Reset usage for this resource to 0
        this.db.prepare(`
          INSERT INTO quota_usage (user_id, resource, used_amount, updated_at)
          VALUES (?, ?, 0, ?)
          ON CONFLICT (user_id, resource) DO UPDATE SET
            used_amount = 0,
            updated_at = excluded.updated_at
        `).run(this.userId, resource, nowIso);

        // 2. Expire active uncommitted reservations for this resource
        this.db.prepare(`
          UPDATE quota_reservations
          SET status = 'expired'
          WHERE user_id = ? AND resource = ? AND status = 'reserved'
        `).run(this.userId, resource);

        // Expire linked quota bundles if table exists
        try {
          this.db.prepare(`
            UPDATE quota_bundles
            SET status = 'expired'
            WHERE user_id = ? AND status = 'reserved'
          `).run(this.userId);
        } catch {
          // Table quota_bundles might not exist in early migrations (v1-v9)
        }

        // 3. Advance to next reset cycle
        const nextReset = this.advanceResetAt(resetAt, limitRow, nowIso);
        this.db.prepare(`
          UPDATE quota_limits
          SET reset_at = ?, updated_at = ?
          WHERE user_id = ? AND resource = ?
        `).run(nextReset, nowIso, this.userId, resource);

        resetAt = nextReset;
      }
    } else {
      // Pure fail-closed: unconfigured resource limit is 0
      limit = 0;
    }

    // Read usage
    const usageRow = this.db.prepare('SELECT used_amount FROM quota_usage WHERE user_id = ? AND resource = ?').get(this.userId, resource) as DbRow | undefined;
    const used = usageRow ? getNumber(usageRow, 'used_amount') : 0;

    // Read active reservations
    const resRow = this.db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS reserved_sum
      FROM quota_reservations
      WHERE user_id = ? AND resource = ? AND status = 'reserved' AND expires_at > ?
    `).get(this.userId, resource, nowIso) as DbRow | undefined;
    const reserved = resRow ? getNumber(resRow, 'reserved_sum') : 0;

    const isUnlimited = limit < 0;
    const remaining = isUnlimited ? -1 : Math.max(0, limit - used - reserved);
    const allowed = isUnlimited ? true : (limit > 0 && remaining > 0);

    return {
      userId: this.userId,
      resource,
      limit,
      used,
      reserved,
      remaining,
      allowed,
      resetAt,
    };
  }

  async adjustUsage(input: { resource: QuotaMetric; delta: number }): Promise<QuotaUsageSummary> {
    const resource = validateQuotaMetric(input.resource);
    const delta = input.delta;
    if (typeof delta !== 'number' || !Number.isSafeInteger(delta)) {
      throw new ValidationError('delta must be a safe integer');
    }
    const nowIso = new Date().toISOString();

    return withImmediateTransactionSync(this.db, () => {
      const usage = this.getUsageInternal(resource, nowIso);

      if (delta > 0) {
        if (usage.limit >= 0 && usage.remaining < delta) {
          throw new QuotaExceededError(resource, delta, usage.remaining, 'Quota exceeded for resource adjustment');
        }
        this.db.prepare(`
          INSERT INTO quota_usage (user_id, resource, used_amount, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (user_id, resource) DO UPDATE SET
            used_amount = quota_usage.used_amount + excluded.used_amount,
            updated_at = excluded.updated_at
        `).run(this.userId, resource, delta, nowIso);
      } else if (delta < 0) {
        const decrement = Math.abs(delta);
        const newUsed = Math.max(0, usage.used - decrement);
        this.db.prepare(`
          INSERT INTO quota_usage (user_id, resource, used_amount, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (user_id, resource) DO UPDATE SET
            used_amount = excluded.used_amount,
            updated_at = excluded.updated_at
        `).run(this.userId, resource, newUsed, nowIso);
      }

      return this.getUsageInternal(resource, nowIso);
    });
  }

  async decrementUsage(resource: QuotaMetric, amount: number): Promise<QuotaUsageSummary> {
    const metric = validateQuotaMetric(resource);
    const nonNeg = assertNonNegativeInteger(amount, 'amount');
    return this.adjustUsage({ resource: metric, delta: -nonNeg });
  }

  async setBaselineUsage(resource: QuotaMetric, amount: number): Promise<QuotaUsageSummary> {
    const metric = validateQuotaMetric(resource);
    const nonNeg = assertNonNegativeInteger(amount, 'amount');
    const nowIso = new Date().toISOString();

    return withImmediateTransactionSync(this.db, () => {
      this.db.prepare(`
        INSERT INTO quota_usage (user_id, resource, used_amount, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (user_id, resource) DO UPDATE SET
          used_amount = excluded.used_amount,
          updated_at = excluded.updated_at
      `).run(this.userId, metric, nonNeg, nowIso);

      return this.getUsageInternal(metric, nowIso);
    });
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
    const stmt = this.db.prepare('SELECT * FROM quota_reservations WHERE id = ? AND user_id = ?');
    return queryOne(stmt, parseQuotaReservationRow, reservationId, this.userId);
  }

  async listReservations(options?: { status?: string; resource?: string; limit?: number; offset?: number }): Promise<QuotaReservation[]> {
    const clauses: string[] = ['user_id = ?'];
    const params: (string | number)[] = [this.userId];

    if (options?.status) {
      clauses.push('status = ?');
      params.push(options.status);
    }
    if (options?.resource) {
      clauses.push('resource = ?');
      params.push(options.resource);
    }

    let sql = `SELECT * FROM quota_reservations WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`;
    if (options?.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
      if (options?.offset) {
        sql += ' OFFSET ?';
        params.push(options.offset);
      }
    }

    const stmt = this.db.prepare(sql);
    return queryAll(stmt, parseQuotaReservationRow, ...params);
  }

  async reserve(input: ReserveQuotaInput): Promise<QuotaReservation> {
    const resource = validateQuotaMetric(input.resource);
    const amount = assertPositiveInteger(input.amount, 'Reservation amount');
    const ttlSeconds = input.ttlSeconds !== undefined ? assertPositiveInteger(input.ttlSeconds, 'ttlSeconds') : 300;

    const reservationId = `qrs_${randomUUID().replace(/-/g, '').toLowerCase()}`;
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

    return withImmediateTransactionSync(this.db, () => {
      const usage = this.getUsageInternal(resource, nowIso);

      if (usage.limit >= 0 && usage.remaining < amount) {
        throw new QuotaExceededError(
          resource,
          amount,
          usage.remaining,
          'Quota exceeded for resource'
        );
      }

      this.db.prepare(`
        INSERT INTO quota_reservations (id, user_id, resource, amount, status, expires_at, metadata, created_at)
        VALUES (?, ?, ?, ?, 'reserved', ?, NULL, ?)
      `).run(reservationId, this.userId, resource, amount, expiresAt, nowIso);

      const created = this.db.prepare('SELECT * FROM quota_reservations WHERE id = ? AND user_id = ?').get(reservationId, this.userId);
      if (!created) {
        throw new Error('Failed to retrieve newly created reservation');
      }
      return parseQuotaReservationRow(created as DbRow);
    });
  }

  async commit(input: CommitQuotaInput): Promise<{ reservation: QuotaReservation; usage: QuotaUsageSummary }> {
    const reservationId = validateReservationId(input.reservationId);
    const nowIso = new Date().toISOString();

    return withImmediateTransactionSync(this.db, () => {
      const reservationRow = this.db.prepare('SELECT * FROM quota_reservations WHERE id = ? AND user_id = ?').get(reservationId, this.userId) as DbRow | undefined;
      if (!reservationRow) {
        throw new InvalidReservationError('', 'Reservation not found');
      }

      const reservation = parseQuotaReservationRow(reservationRow);

      if (reservation.status !== 'reserved') {
        throw new ReservationSettledError('', reservation.status);
      }

      if (reservation.expiresAt <= nowIso) {
        this.db.prepare(`
          UPDATE quota_reservations
          SET status = 'expired'
          WHERE id = ? AND user_id = ? AND status = 'reserved'
        `).run(reservationId, this.userId);
        throw new ReservationSettledError('', 'expired');
      }

      const actualAmount = input.actualAmount !== undefined ? assertNonNegativeInteger(input.actualAmount, 'actualAmount') : reservation.amount;

      // Update reservation status to committed
      this.db.prepare(`
        UPDATE quota_reservations
        SET status = 'committed', committed_amount = ?, settled_at = ?
        WHERE id = ? AND user_id = ? AND status = 'reserved'
      `).run(actualAmount, nowIso, reservationId, this.userId);

      // Increment usage
      this.db.prepare(`
        INSERT INTO quota_usage (user_id, resource, used_amount, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (user_id, resource) DO UPDATE SET
          used_amount = quota_usage.used_amount + excluded.used_amount,
          updated_at = excluded.updated_at
      `).run(this.userId, reservation.resource, actualAmount, nowIso);

      const updated = this.db.prepare('SELECT * FROM quota_reservations WHERE id = ? AND user_id = ?').get(reservationId, this.userId);
      if (!updated) {
        throw new Error('Failed to retrieve updated reservation');
      }
      const updatedReservation = parseQuotaReservationRow(updated as DbRow);
      const usage = this.getUsageInternal(reservation.resource, nowIso);
      return { reservation: updatedReservation, usage };
    });
  }

  async release(input: ReleaseQuotaInput): Promise<QuotaReservation> {
    const reservationId = validateReservationId(input.reservationId);
    const nowIso = new Date().toISOString();

    return withImmediateTransactionSync(this.db, () => {
      const reservationRow = this.db.prepare('SELECT * FROM quota_reservations WHERE id = ? AND user_id = ?').get(reservationId, this.userId) as DbRow | undefined;
      if (!reservationRow) {
        throw new InvalidReservationError('', 'Reservation not found');
      }

      const reservation = parseQuotaReservationRow(reservationRow);

      if (reservation.status !== 'reserved') {
        throw new ReservationSettledError('', reservation.status);
      }

      this.db.prepare(`
        UPDATE quota_reservations
        SET status = 'released', settled_at = ?
        WHERE id = ? AND user_id = ? AND status = 'reserved'
      `).run(nowIso, reservationId, this.userId);

      const updated = this.db.prepare('SELECT * FROM quota_reservations WHERE id = ? AND user_id = ?').get(reservationId, this.userId);
      if (!updated) {
        throw new Error('Failed to retrieve released reservation');
      }
      return parseQuotaReservationRow(updated as DbRow);
    });
  }

  async directConsume(input: DirectConsumeQuotaInput): Promise<QuotaUsageSummary> {
    const resource = validateQuotaMetric(input.resource);
    const amount = assertPositiveInteger(input.amount, 'Direct consume amount');
    const nowIso = new Date().toISOString();

    return withImmediateTransactionSync(this.db, () => {
      const usage = this.getUsageInternal(resource, nowIso);

      if (usage.limit >= 0 && usage.remaining < amount) {
        throw new QuotaExceededError(
          resource,
          amount,
          usage.remaining,
          'Quota exceeded for direct consumption of resource'
        );
      }

      this.db.prepare(`
        INSERT INTO quota_usage (user_id, resource, used_amount, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (user_id, resource) DO UPDATE SET
          used_amount = quota_usage.used_amount + excluded.used_amount,
          updated_at = excluded.updated_at
      `).run(this.userId, resource, amount, nowIso);

      return this.getUsageInternal(resource, nowIso);
    });
  }

  async expireStaleReservations(now?: string): Promise<{ expiredCount: number; reservationIds: string[] }> {
    const nowIso = now ?? new Date().toISOString();

    return withImmediateTransactionSync(this.db, () => {
      const staleRows = this.db.prepare(`
        SELECT id FROM quota_reservations
        WHERE user_id = ? AND status = 'reserved' AND expires_at <= ?
      `).all(this.userId, nowIso) as Array<{ id: string }>;

      if (staleRows.length === 0) {
        return { expiredCount: 0, reservationIds: [] };
      }

      const ids = staleRows.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(', ');

      this.db.prepare(`
        UPDATE quota_reservations
        SET status = 'expired'
        WHERE id IN (${placeholders}) AND user_id = ? AND status = 'reserved'
      `).run(...ids, this.userId);

      this.db.prepare(`
        UPDATE quota_bundles
        SET status = 'expired'
        WHERE user_id = ? AND status = 'reserved' AND expires_at <= ?
      `).run(this.userId, nowIso);

      return {
        expiredCount: ids.length,
        reservationIds: ids,
      };
    });
  }

  // --- Authoritative Quota Bundles Multi-Metric Atomic Lifecycle ---

  async findBundleById(bundleId: string): Promise<QuotaBundle | null> {
    const stmt = this.db.prepare('SELECT * FROM quota_bundles WHERE id = ? AND user_id = ?');
    return queryOne(stmt, parseQuotaBundleRow, bundleId, this.userId);
  }

  async findBundleByDeliveryId(deliveryId: string): Promise<QuotaBundle | null> {
    const stmt = this.db.prepare('SELECT * FROM quota_bundles WHERE delivery_id = ? AND user_id = ?');
    return queryOne(stmt, parseQuotaBundleRow, deliveryId, this.userId);
  }

  async getLastCommittedTokens(sessionId: string): Promise<number> {
    if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) {
      return 0;
    }
    try {
      const row = this.db.prepare(`
        SELECT tokens_committed
        FROM quota_bundles
        WHERE user_id = ? AND session_id = ? AND status = 'committed' AND tokens_committed > 0
        ORDER BY COALESCE(settled_at, created_at) DESC, created_at DESC
        LIMIT 1
      `).get(this.userId, sessionId.trim()) as DbRow | undefined;
      if (!row) {
        return 0;
      }
      return getNumber(row, 'tokens_committed');
    } catch {
      return 0;
    }
  }

  async reserveBundle(input: ReserveQuotaBundleInput): Promise<QuotaBundle> {
    const turns = assertPositiveInteger(input.turns, 'turns');
    const messages = assertPositiveInteger(input.messages, 'messages');
    const tokens = assertNonNegativeInteger(input.tokens, 'tokens');
    const isEstimateTokens = Boolean(input.isEstimateTokens);
    const ttlSeconds = input.ttlSeconds !== undefined ? assertPositiveInteger(input.ttlSeconds, 'ttlSeconds') : 900;

    const requestHash = input.requestHash ?? computeCanonicalQuotaRequestHash({
      userId: this.userId,
      sessionId: input.sessionId,
      deliveryId: input.deliveryId,
      turns,
      messages,
      tokens,
      isEstimateTokens,
    });

    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

    return withImmediateTransactionSync(this.db, () => {
      // 1. Check idempotency by (user_id, delivery_id)
      const existingRow = this.db.prepare(`
        SELECT * FROM quota_bundles
        WHERE user_id = ? AND delivery_id = ?
        LIMIT 1
      `).get(this.userId, input.deliveryId) as DbRow | undefined;

      if (existingRow) {
        const existingBundle = parseQuotaBundleRow(existingRow);

        // Check hash equality
        if (existingBundle.requestHash !== requestHash) {
          throw new IdempotencyConflictError(
            input.deliveryId,
            'Delivery ID already exists with conflicting quota reservation parameters'
          );
        }

        // Idempotency replay on active bundle
        if (existingBundle.status === 'committed') {
          return existingBundle;
        }

        if (existingBundle.status === 'reserved' && existingBundle.expiresAt > nowIso) {
          return existingBundle;
        }

        // Strictly immutable terminal states: no reactivation of released or expired bundles
        if (existingBundle.status === 'released') {
          throw new ReservationSettledError('', 'released');
        }

        if (existingBundle.status === 'expired' || (existingBundle.status === 'reserved' && existingBundle.expiresAt <= nowIso)) {
          throw new ReservationSettledError('', 'expired');
        }
      }

      // 2. Fresh reservation: check all 3 metrics in single transaction
      const turnsUsage = this.getUsageInternal('turns', nowIso);
      if (turnsUsage.limit >= 0 && turnsUsage.remaining < turns) {
        throw new QuotaExceededError(
          'turns',
          turns,
          turnsUsage.remaining,
          'Quota exceeded for resource'
        );
      }

      const messagesUsage = this.getUsageInternal('messages', nowIso);
      if (messagesUsage.limit >= 0 && messagesUsage.remaining < messages) {
        throw new QuotaExceededError(
          'messages',
          messages,
          messagesUsage.remaining,
          'Quota exceeded for resource'
        );
      }

      // Fail-closed token policy: quota limit for tokens must exist even when tokens=0
      const tokensLimitRow = this.db.prepare(
        'SELECT limit_amount FROM quota_limits WHERE user_id = ? AND resource = ?'
      ).get(this.userId, 'tokens') as DbRow | undefined;

      if (!tokensLimitRow) {
        throw new QuotaExceededError(
          'tokens',
          tokens,
          0,
          'Quota limit not configured for resource'
        );
      }

      const tokensUsage = this.getUsageInternal('tokens', nowIso);
      if (tokensUsage.limit >= 0 && tokensUsage.remaining < tokens) {
        throw new QuotaExceededError(
          'tokens',
          tokens,
          tokensUsage.remaining,
          'Quota exceeded for resource'
        );
      }

      // 3. Insert authoritative quota_bundles receipt (canonical qbd_ prefix, null metadata)
      const bundleId = `qbd_${randomUUID().replace(/-/g, '').toLowerCase()}`;
      this.db.prepare(`
        INSERT INTO quota_bundles (
          id, user_id, delivery_id, session_id, request_hash, status,
          turns_amount, messages_amount, tokens_amount, is_estimate_tokens,
          expires_at, created_at, metadata
        )
        VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?, NULL)
      `).run(
        bundleId,
        this.userId,
        input.deliveryId,
        input.sessionId,
        requestHash,
        turns,
        messages,
        tokens,
        isEstimateTokens ? 1 : 0,
        expiresAt,
        nowIso
      );

      // 4. Insert linked quota_reservations items: always exactly 3 (turns, messages, tokens) with qrs_ prefix and null metadata
      const resTurnsId = `qrs_${randomUUID().replace(/-/g, '').toLowerCase()}`;
      this.db.prepare(`
        INSERT INTO quota_reservations (id, user_id, bundle_id, delivery_id, resource, amount, status, expires_at, metadata, created_at)
        VALUES (?, ?, ?, ?, 'turns', ?, 'reserved', ?, NULL, ?)
      `).run(resTurnsId, this.userId, bundleId, input.deliveryId, turns, expiresAt, nowIso);

      const resMessagesId = `qrs_${randomUUID().replace(/-/g, '').toLowerCase()}`;
      this.db.prepare(`
        INSERT INTO quota_reservations (id, user_id, bundle_id, delivery_id, resource, amount, status, expires_at, metadata, created_at)
        VALUES (?, ?, ?, ?, 'messages', ?, 'reserved', ?, NULL, ?)
      `).run(resMessagesId, this.userId, bundleId, input.deliveryId, messages, expiresAt, nowIso);

      const resTokensId = `qrs_${randomUUID().replace(/-/g, '').toLowerCase()}`;
      this.db.prepare(`
        INSERT INTO quota_reservations (id, user_id, bundle_id, delivery_id, resource, amount, status, expires_at, metadata, created_at)
        VALUES (?, ?, ?, ?, 'tokens', ?, 'reserved', ?, NULL, ?)
      `).run(resTokensId, this.userId, bundleId, input.deliveryId, tokens, expiresAt, nowIso);

      const created = this.db.prepare('SELECT * FROM quota_bundles WHERE id = ? AND user_id = ?').get(bundleId, this.userId);
      if (!created) {
        throw new Error('Failed to retrieve newly created quota bundle');
      }
      return parseQuotaBundleRow(created as DbRow);
    });
  }

  /**
   * Synchronous commit inside an active SQLite transaction owned by caller (e.g. Gateway finalize turn).
   * Does NOT begin or commit transaction itself.
   */
  commitBundleInTransactionSync(db: DatabaseSync, input: CommitQuotaBundleInput): QuotaBundle {
    if (!db) {
      throw new ValidationError('Database connection is required');
    }

    const bundleId = validateBundleId(input.bundleId);
    const nowIso = new Date().toISOString();

    const row = db.prepare('SELECT * FROM quota_bundles WHERE id = ? AND user_id = ?').get(bundleId, this.userId) as DbRow | undefined;
    if (!row) {
      throw new InvalidReservationError('', 'Quota bundle not found');
    }

    const bundle = parseQuotaBundleRow(row);

    if (bundle.status === 'committed') {
      return bundle;
    }

    if (bundle.status !== 'reserved') {
      throw new ReservationSettledError('', bundle.status);
    }

    if (bundle.expiresAt <= nowIso) {
      db.prepare(`
        UPDATE quota_bundles SET status = 'expired' WHERE id = ? AND user_id = ? AND status = 'reserved'
      `).run(bundleId, this.userId);
      db.prepare(`
        UPDATE quota_reservations SET status = 'expired' WHERE bundle_id = ? AND user_id = ? AND status = 'reserved'
      `).run(bundleId, this.userId);
      throw new ReservationSettledError('', 'expired');
    }

    // actualUsage is strictly REQUIRED: no fallback to reserved amounts
    if (!input.actualUsage || typeof input.actualUsage !== 'object' || Array.isArray(input.actualUsage)) {
      throw new ValidationError('actualUsage object with turns, messages, tokens is required');
    }

    const usageKeys = Object.keys(input.actualUsage);
    const requiredKeys = ['turns', 'messages', 'tokens'];
    for (const reqKey of requiredKeys) {
      if (!(reqKey in input.actualUsage)) {
        throw new ValidationError(`actualUsage.${reqKey} is required`);
      }
    }
    for (const key of usageKeys) {
      if (!requiredKeys.includes(key)) {
        throw new ValidationError(`Unexpected key ${key} in actualUsage`);
      }
    }

    const actualTurns = assertPositiveInteger(input.actualUsage.turns, 'turns');
    const actualMessages = assertPositiveInteger(input.actualUsage.messages, 'messages');
    const actualTokens = assertNonNegativeInteger(input.actualUsage.tokens, 'tokens');

    if (actualTurns !== bundle.turns) {
      throw new ValidationError('Actual turns must match reserved bundle amount');
    }
    if (actualMessages !== bundle.messages) {
      throw new ValidationError('Actual messages must match reserved bundle amount');
    }

    // Atomic pre-check: verify limits and capacity for all three actual metrics considering own reservation replacement
    const metricsToCheck: Array<{ resource: QuotaMetric; actualAmount: number }> = [
      { resource: 'turns', actualAmount: actualTurns },
      { resource: 'messages', actualAmount: actualMessages },
      { resource: 'tokens', actualAmount: actualTokens },
    ];

    for (const { resource, actualAmount } of metricsToCheck) {
      const limitRow = db.prepare(
        'SELECT limit_amount FROM quota_limits WHERE user_id = ? AND resource = ?'
      ).get(this.userId, resource) as DbRow | undefined;

      if (!limitRow) {
        throw new QuotaExceededError(resource, actualAmount, 0, 'Quota limit not configured for resource');
      }

      const limit = getNumber(limitRow, 'limit_amount');

      const usageRow = db.prepare(
        'SELECT used_amount FROM quota_usage WHERE user_id = ? AND resource = ?'
      ).get(this.userId, resource) as DbRow | undefined;
      const used = usageRow ? getNumber(usageRow, 'used_amount') : 0;

      // Other active reservations (excluding this bundle's reservation)
      const resRow = db.prepare(`
        SELECT COALESCE(SUM(amount), 0) AS reserved_sum
        FROM quota_reservations
        WHERE user_id = ? AND resource = ? AND status = 'reserved' AND expires_at > ? AND bundle_id != ?
      `).get(this.userId, resource, nowIso, bundleId) as DbRow | undefined;
      const otherReserved = resRow ? getNumber(resRow, 'reserved_sum') : 0;

      if (limit >= 0) {
        const availableForCommit = Math.max(0, limit - used - otherReserved);
        if (actualAmount > availableForCommit) {
          // If this reservation was an estimated token reservation (isEstimateTokens = true) and the metric is tokens:
          // The LLM turn has ALREADY executed and provider costs have been incurred.
          // We MUST NOT drop the completed assistant reply or fail the turn after incurring provider cost!
          // Instead, we allow the commit to proceed with actual tokens (recording quota debt/overage in quota_usage),
          // and future turns will be blocked at preflight claim time because remaining will be 0.
          // For non-estimate reservations (isEstimateTokens = false) or other resources (turns/messages),
          // we strictly fail-closed with QuotaExceededError.
          if (resource === 'tokens' && bundle.isEstimateTokens) {
            // Allow estimated token overage commit: do not throw
          } else {
            throw new QuotaExceededError(
              resource,
              actualAmount,
              availableForCommit,
              'Quota exceeded for resource'
            );
          }
        }
      }
    }

    // Update quota_bundles row
    const bundleRes = db.prepare(`
      UPDATE quota_bundles
      SET status = 'committed',
          turns_committed = ?,
          messages_committed = ?,
          tokens_committed = ?,
          settled_at = ?
      WHERE id = ? AND user_id = ? AND status = 'reserved'
    `).run(actualTurns, actualMessages, actualTokens, nowIso, bundleId, this.userId);

    if (bundleRes.changes === 0) {
      throw new ReservationSettledError('', 'already settled or concurrent conflict');
    }

    // Update linked quota_reservations rows and verify expected count (always exactly 3)
    const expectedReservationsCount = 3;
    const resReservations = db.prepare(`
      UPDATE quota_reservations
      SET status = 'committed',
          committed_amount = CASE
            WHEN resource = 'turns' THEN ?
            WHEN resource = 'messages' THEN ?
            WHEN resource = 'tokens' THEN ?
            ELSE amount
          END,
          settled_at = ?
      WHERE bundle_id = ? AND user_id = ? AND status = 'reserved'
    `).run(actualTurns, actualMessages, actualTokens, nowIso, bundleId, this.userId);

    if (resReservations.changes !== expectedReservationsCount) {
      throw new Error('Database corruption: expected quota_reservations count mismatch');
    }

    // Atomically increment quota_usage counters for all 3 metrics with authoritative nowIso
    db.prepare(`
      INSERT INTO quota_usage (user_id, resource, used_amount, updated_at)
      VALUES (?, 'turns', ?, ?)
      ON CONFLICT (user_id, resource) DO UPDATE SET
        used_amount = quota_usage.used_amount + excluded.used_amount,
        updated_at = excluded.updated_at
    `).run(this.userId, actualTurns, nowIso);

    db.prepare(`
      INSERT INTO quota_usage (user_id, resource, used_amount, updated_at)
      VALUES (?, 'messages', ?, ?)
      ON CONFLICT (user_id, resource) DO UPDATE SET
        used_amount = quota_usage.used_amount + excluded.used_amount,
        updated_at = excluded.updated_at
    `).run(this.userId, actualMessages, nowIso);

    db.prepare(`
      INSERT INTO quota_usage (user_id, resource, used_amount, updated_at)
      VALUES (?, 'tokens', ?, ?)
      ON CONFLICT (user_id, resource) DO UPDATE SET
        used_amount = quota_usage.used_amount + excluded.used_amount,
        updated_at = excluded.updated_at
    `).run(this.userId, actualTokens, nowIso);

    const updatedRow = db.prepare('SELECT * FROM quota_bundles WHERE id = ? AND user_id = ?').get(bundleId, this.userId);
    if (!updatedRow) {
      throw new Error('Failed to retrieve updated quota bundle');
    }
    return parseQuotaBundleRow(updatedRow as DbRow);
  }

  async commitBundle(input: CommitQuotaBundleInput): Promise<QuotaBundle> {
    return withImmediateTransactionSync(this.db, () => {
      return this.commitBundleInTransactionSync(this.db, input);
    });
  }

  /**
   * Synchronous release inside an active SQLite transaction owned by caller.
   * Does NOT begin or commit transaction itself.
   */
  releaseBundleInTransactionSync(db: DatabaseSync, input: ReleaseQuotaBundleInput): QuotaBundle {
    if (!db) {
      throw new ValidationError('Database connection is required');
    }

    const bundleId = validateBundleId(input.bundleId);
    const nowIso = new Date().toISOString();

    const row = db.prepare('SELECT * FROM quota_bundles WHERE id = ? AND user_id = ?').get(bundleId, this.userId) as DbRow | undefined;
    if (!row) {
      throw new InvalidReservationError('', 'Quota bundle not found');
    }

    const bundle = parseQuotaBundleRow(row);

    // Release committed leaves committed, does not report released
    if (bundle.status === 'committed') {
      return bundle;
    }

    if (bundle.status === 'released' || bundle.status === 'expired') {
      return bundle;
    }

    db.prepare(`
      UPDATE quota_bundles
      SET status = 'released', settled_at = ?
      WHERE id = ? AND user_id = ? AND status = 'reserved'
    `).run(nowIso, bundleId, this.userId);

    db.prepare(`
      UPDATE quota_reservations
      SET status = 'released', settled_at = ?
      WHERE bundle_id = ? AND user_id = ? AND status = 'reserved'
    `).run(nowIso, bundleId, this.userId);

    const updatedRow = db.prepare('SELECT * FROM quota_bundles WHERE id = ? AND user_id = ?').get(bundleId, this.userId);
    if (!updatedRow) {
      throw new Error('Failed to retrieve released quota bundle');
    }
    return parseQuotaBundleRow(updatedRow as DbRow);
  }

  async releaseBundle(input: ReleaseQuotaBundleInput): Promise<QuotaBundle> {
    return withImmediateTransactionSync(this.db, () => {
      return this.releaseBundleInTransactionSync(this.db, input);
    });
  }

  async renewBundle(input: RenewQuotaBundleInput): Promise<QuotaBundle> {
    const bundleId = validateBundleId(input.bundleId);
    const extendSeconds = input.extendSeconds !== undefined ? assertPositiveInteger(input.extendSeconds, 'extendSeconds') : 900;

    return withImmediateTransactionSync(this.db, () => {
      const row = this.db.prepare('SELECT * FROM quota_bundles WHERE id = ? AND user_id = ?').get(bundleId, this.userId) as DbRow | undefined;
      if (!row) {
        throw new InvalidReservationError('', 'Quota bundle not found');
      }

      const bundle = parseQuotaBundleRow(row);
      if (bundle.status !== 'reserved') {
        throw new ReservationSettledError('', bundle.status);
      }

      const now = new Date();
      const expiresAt = new Date(now.getTime() + extendSeconds * 1000).toISOString();

      this.db.prepare(`
        UPDATE quota_bundles
        SET expires_at = ?
        WHERE id = ? AND user_id = ? AND status = 'reserved'
      `).run(expiresAt, bundleId, this.userId);

      this.db.prepare(`
        UPDATE quota_reservations
        SET expires_at = ?
        WHERE bundle_id = ? AND user_id = ? AND status = 'reserved'
      `).run(expiresAt, bundleId, this.userId);

      const updatedRow = this.db.prepare('SELECT * FROM quota_bundles WHERE id = ? AND user_id = ?').get(bundleId, this.userId);
      if (!updatedRow) {
        throw new Error('Failed to retrieve renewed quota bundle');
      }
      return parseQuotaBundleRow(updatedRow as DbRow);
    });
  }
}
