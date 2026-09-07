import { describe, it, expect } from 'vitest';
import { FakePlatformOperationsStorage } from './support/index.js';
import { PlatformOperationsService } from '../src/services/platform-operations-service.js';
import {
  ValidationError,
  QuotaExceededError,
} from '../src/errors/index.js';
import {
  CORE_QUOTA_METRICS,
  assertPositiveInteger,
  assertNonNegativeInteger,
  validateQuotaMetric,
} from '../src/types/quota.js';

describe('Quota Core Metrics, Integer Validation & Strict Fail-Closed Policy', () => {
  describe('5 Core Metrics Definitions & Helper Validations', () => {
    it('defines the 5 fixed core quota metrics correctly', () => {
      expect(CORE_QUOTA_METRICS).toEqual([
        'tokens',
        'messages',
        'turns',
        'storage_bytes',
        'api_calls',
      ]);
    });

    it('enforces positive integer validation strictly', () => {
      expect(assertPositiveInteger(100, 'tokens')).toBe(100);
      expect(assertPositiveInteger(1, 'messages')).toBe(1);

      // Rejects zero
      expect(() => assertPositiveInteger(0, 'amount')).toThrow(ValidationError);
      // Rejects negative
      expect(() => assertPositiveInteger(-10, 'amount')).toThrow(ValidationError);
      // Rejects float / fractional numbers
      expect(() => assertPositiveInteger(10.5, 'amount')).toThrow(ValidationError);
      // Rejects NaN / Infinity / strings
      expect(() => assertPositiveInteger(NaN, 'amount')).toThrow(ValidationError);
      expect(() => assertPositiveInteger(Infinity, 'amount')).toThrow(ValidationError);
      expect(() => assertPositiveInteger('100' as any, 'amount')).toThrow(ValidationError);
    });

    it('enforces non-negative integer validation strictly', () => {
      expect(assertNonNegativeInteger(0, 'limit')).toBe(0);
      expect(assertNonNegativeInteger(500, 'limit')).toBe(500);

      expect(() => assertNonNegativeInteger(-1, 'limit')).toThrow(ValidationError);
      expect(() => assertNonNegativeInteger(3.14, 'limit')).toThrow(ValidationError);
      expect(() => assertNonNegativeInteger(NaN, 'limit')).toThrow(ValidationError);
    });

    it('validates quota metric resource strings strictly against CORE_QUOTA_METRICS', () => {
      expect(validateQuotaMetric('tokens')).toBe('tokens');
      expect(validateQuotaMetric('messages')).toBe('messages');
      expect(validateQuotaMetric('turns')).toBe('turns');
      expect(validateQuotaMetric('storage_bytes')).toBe('storage_bytes');
      expect(validateQuotaMetric('api_calls')).toBe('api_calls');

      // Rejects arbitrary strings
      expect(() => validateQuotaMetric('arbitrary_metric')).toThrow(ValidationError);
      expect(() => validateQuotaMetric('calls')).toThrow(ValidationError);
      expect(() => validateQuotaMetric('compute_units')).toThrow(ValidationError);
      expect(() => validateQuotaMetric('')).toThrow(ValidationError);
      expect(() => validateQuotaMetric('   ')).toThrow(ValidationError);
      expect(() => validateQuotaMetric(null as any)).toThrow(ValidationError);
    });
  });

  describe('Unconfigured Quota Policy (Strict Fail-Closed)', () => {
    it('strictly fails closed when no limit is configured for a metric', async () => {
      const storage = new FakePlatformOperationsStorage();
      const service = new PlatformOperationsService({ storage });
      const ops = service.forTenant('user_default_policy');

      // Check usage for unconfigured core metric
      for (const metric of CORE_QUOTA_METRICS) {
        const usage = await ops.quota.checkQuota({ resource: metric });
        expect(usage.allowed).toBe(false);
        expect(usage.limit[metric]).toBe(0);
        expect(usage.usage[metric]).toBe(0);
        expect(usage.activeReservations[metric]).toBe(0);
        expect(usage.remaining[metric]).toBe(0);
      }

      // Any reservation attempt on unconfigured resource MUST fail with QuotaExceededError
      await expect(
        ops.quota.reserveQuota({ resource: 'tokens', amount: 10 })
      ).rejects.toThrow(QuotaExceededError);

      await expect(
        ops.quota.consumeQuota({ resource: 'api_calls', amount: 1 })
      ).rejects.toThrow(QuotaExceededError);
    });

    it('allows explicit configuration via setLimit and enables metered quota consumption', async () => {
      const storage = new FakePlatformOperationsStorage();
      const service = new PlatformOperationsService({ storage });
      const ops = service.forTenant('user_explicit_limit');

      // Unconfigured is blocked
      await expect(
        ops.quota.reserveQuota({ resource: 'tokens', amount: 50 })
      ).rejects.toThrow(QuotaExceededError);

      // Explicitly configure limit for tokens
      await ops.quota.setLimit({ resource: 'tokens', limit: 500 });

      const check = await ops.quota.checkQuota({ resource: 'tokens' });
      expect(check.allowed).toBe(true);
      expect(check.limit['tokens']).toBe(500);
      expect(check.remaining['tokens']).toBe(500);

      // Now reserve works
      const reservation = await ops.quota.reserveQuota({ resource: 'tokens', amount: 200 });
      expect(reservation.status).toBe('reserved');

      // Other metrics remain blocked under fail-closed
      await expect(
        ops.quota.reserveQuota({ resource: 'messages', amount: 1 })
      ).rejects.toThrow(QuotaExceededError);
    });

    it('rejects setting limits or reservations on non-core metrics', async () => {
      const storage = new FakePlatformOperationsStorage();
      const service = new PlatformOperationsService({ storage });
      const ops = service.forTenant('user_arbitrary_test');

      await expect(
        ops.quota.setLimit({ resource: 'custom_ai_metric' as any, limit: 100 })
      ).rejects.toThrow(ValidationError);

      await expect(
        ops.quota.reserveQuota({ resource: 'gpu_hours' as any, amount: 1 })
      ).rejects.toThrow(ValidationError);
    });
  });
});
