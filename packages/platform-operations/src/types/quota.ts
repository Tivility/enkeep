import { createHash } from 'node:crypto';
import { ValidationError } from '../errors/index.js';
import { SESSION_ID_REGEX, validateSessionId } from './task.js';

/**
 * The 5 fixed core quota metrics supported by the platform.
 * Arbitrary metrics are strictly forbidden.
 */
export const CORE_QUOTA_METRICS = [
  'tokens',
  'messages',
  'turns',
  'storage_bytes',
  'api_calls',
] as const;

export type QuotaMetric = (typeof CORE_QUOTA_METRICS)[number];
export type CoreQuotaMetric = QuotaMetric;

export const CORE_QUOTA_METRIC_SET: ReadonlySet<string> = new Set(CORE_QUOTA_METRICS);

export type QuotaReservationStatus =
  | 'reserved'
  | 'committed'
  | 'released'
  | 'expired';

export interface QuotaLimit {
  resource: QuotaMetric;
  limit: number;
}

export interface TenantQuotaLimit {
  userId: string;
  resource: QuotaMetric;
  limit: number;
  windowSeconds?: number | null;
  resetAt: string | null;
  resetInterval?: 'none' | 'daily' | 'monthly' | string | null;
  updatedAt: string;
}

export interface QuotaUsageDetail {
  limit: number;
  used: number;
  reserved: number;
  remaining: number;
}

export interface QuotaUsageSummary {
  userId: string;
  resource: QuotaMetric;
  limit: number;
  used: number;
  reserved: number;
  remaining: number;
  allowed: boolean;
  resetAt: string | null;
}

export interface TenantQuotaSummary {
  userId: string;
  allowed: boolean;
  resources: Record<QuotaMetric, QuotaUsageDetail>;
}

export interface CheckQuotaQuery {
  resource?: QuotaMetric;
}

export interface CheckQuotaResult {
  allowed: boolean;
  usage: Record<QuotaMetric, number>;
  activeReservations: Record<QuotaMetric, number>;
  limit: Record<QuotaMetric, number>;
  remaining: Record<QuotaMetric, number>;
  resetAt: string | null;
}

export interface QuotaReservation {
  id: string;
  userId: string;
  bundleId?: string | null;
  deliveryId?: string | null;
  resource: QuotaMetric;
  amount: number;
  status: QuotaReservationStatus;
  expiresAt: string;
  createdAt: string;
  committedAmount?: number | null;
  settledAt?: string | null;
  committedAt?: string | null;
  releasedAt?: string | null;
}

export interface QuotaBundle {
  id: string;
  userId: string;
  deliveryId: string;
  sessionId: string;
  requestHash: string;
  status: QuotaReservationStatus;
  turns: number;
  messages: number;
  tokens: number;
  isEstimateTokens: boolean;
  turnsCommitted?: number | null;
  messagesCommitted?: number | null;
  tokensCommitted?: number | null;
  expiresAt: string;
  createdAt: string;
  settledAt?: string | null;
}

export interface ReserveQuotaBundleInput {
  deliveryId: string;
  sessionId: string;
  turns: number;
  messages: number;
  tokens: number;
  isEstimateTokens: boolean;
  ttlSeconds?: number;
  requestHash?: string;
}

export interface ActualQuotaUsage {
  turns: number;
  messages: number;
  tokens: number;
}

export interface CommitQuotaBundleInput {
  bundleId: string;
  actualUsage?: ActualQuotaUsage;
}

export interface ReleaseQuotaBundleInput {
  bundleId: string;
  reason?: string;
}

export interface RenewQuotaBundleInput {
  bundleId: string;
  extendSeconds?: number;
}

export interface SetQuotaLimitInput {
  resource: QuotaMetric;
  limit: number;
  windowSeconds?: number | null;
  resetAt?: string | null;
  resetInterval?: 'none' | 'daily' | 'monthly' | string | null;
}

export interface AdjustQuotaUsageInput {
  resource: QuotaMetric;
  delta: number;
}

export interface ReserveQuotaInput {
  resource: QuotaMetric;
  amount: number;
  ttlSeconds?: number;
  reservationId?: string;
}

export interface CommitQuotaInput {
  reservationId: string;
  actualAmount?: number;
}

export interface ReleaseQuotaInput {
  reservationId: string;
  reason?: string;
}

export interface ConsumeQuotaInput {
  resource: QuotaMetric;
  amount: number;
}

export type DirectConsumeQuotaInput = ConsumeQuotaInput;

export type UnconfiguredQuotaPolicy = 'fail_closed' | 'permissive';

export interface QuotaOptions {
  readonly unconfiguredPolicy?: UnconfiguredQuotaPolicy;
}

export interface QuotaExpirationResult {
  expiredCount: number;
  reservationIds: string[];
}

/**
 * Validates that a value is a strictly positive integer (> 0).
 */
export function assertPositiveInteger(value: unknown, _fieldName?: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new ValidationError('Value must be a positive safe integer');
  }
  return value;
}

/**
 * Validates that a value is a non-negative integer (>= 0).
 * Rejects negative numbers (e.g. -1).
 */
export function assertNonNegativeInteger(value: unknown, _fieldName?: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new ValidationError('Value must be a non-negative safe integer');
  }
  return value;
}

/**
 * Validates that a quota limit is either a non-negative safe integer or -1 (unlimited).
 */
export function assertQuotaLimit(value: unknown, _fieldName?: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    (value < 0 && value !== -1)
  ) {
    throw new ValidationError('Quota limit must be a non-negative safe integer or -1 (unlimited)');
  }
  return value;
}

/**
 * Validates that a string is one of the 5 fixed core quota metrics.
 * Rejects arbitrary metric names without trimming.
 */
export function validateQuotaMetric(resource: unknown): QuotaMetric {
  if (typeof resource !== 'string' || !CORE_QUOTA_METRIC_SET.has(resource)) {
    throw new ValidationError('Invalid quota resource metric');
  }
  return resource as QuotaMetric;
}

export const DELIVERY_ID_REGEX = /^deliv_[0-9a-f]{32}$/;
export const USER_ID_REGEX = /^[A-Za-z0-9_\-:.]{1,128}$/;

/**
 * Validates canonical delivery ID format (`deliv_` + 32 lowercase hex).
 * Does not mutate or apply defaults; rejects non-matching values.
 */
export function validateDeliveryId(deliveryId: unknown): string {
  if (typeof deliveryId !== 'string' || !DELIVERY_ID_REGEX.test(deliveryId)) {
    throw new ValidationError('Invalid delivery ID format');
  }
  return deliveryId;
}

/**
 * Validates user ID format:
 * - non-empty string between 1 and 128 characters
 * - raw === trim (no leading or trailing whitespace)
 * - Unicode NFC normalized
 * - no ASCII or Unicode control characters
 * - matches canonical character bounds
 * Rejects invalid raw values without mutative auto-correction.
 */
export function validateUserId(userId: unknown): string {
  if (
    typeof userId !== 'string' ||
    userId.length === 0 ||
    userId.length > 128 ||
    userId !== userId.trim() ||
    userId !== userId.normalize('NFC') ||
    /[\x00-\x1F\x7F\u0080-\u009F]/.test(userId) ||
    !USER_ID_REGEX.test(userId)
  ) {
    throw new ValidationError('Invalid user ID format');
  }
  return userId;
}

export interface CanonicalQuotaRequestHashInput {
  userId: string;
  sessionId: string;
  deliveryId: string;
  turns: number;
  messages: number;
  tokens: number;
  isEstimateTokens: boolean;
}

/**
 * Computes a canonical cryptographic SHA-256 hex hash of the quota reservation request parameters.
 * Canonical sorted JSON serialization guarantees determinism across all runtimes.
 */
export function computeCanonicalQuotaRequestHash(input: CanonicalQuotaRequestHashInput): string {
  if (!input || typeof input !== 'object') {
    throw new ValidationError('Invalid quota request');
  }

  const userId = validateUserId(input.userId);
  const sessionId = validateSessionId(input.sessionId);
  const deliveryId = validateDeliveryId(input.deliveryId);
  const turns = assertPositiveInteger(input.turns, 'turns');
  const messages = assertPositiveInteger(input.messages, 'messages');
  const tokens = assertNonNegativeInteger(input.tokens, 'tokens');

  if (typeof input.isEstimateTokens !== 'boolean') {
    throw new ValidationError('Invalid token estimation flag');
  }
  const isEstimateTokens = input.isEstimateTokens;

  const canonicalObj = {
    deliveryId,
    isEstimateTokens,
    messages,
    sessionId,
    tokens,
    turns,
    userId,
  };

  return createHash('sha256').update(JSON.stringify(canonicalObj)).digest('hex');
}
