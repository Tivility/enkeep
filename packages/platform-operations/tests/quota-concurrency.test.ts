import { describe, it, expect, beforeEach } from 'vitest';
import { FakePlatformOperationsStorage } from './support/index.js';
import { PlatformOperationsService } from '../src/services/platform-operations-service.js';
import {
  QuotaExceededError,
  InvalidReservationError,
  ReservationSettledError,
} from '../src/errors/index.js';

describe('Quota & Budget Ledger Concurrency & Two-Phase Operations', () => {
  let storage: FakePlatformOperationsStorage;
  let service: PlatformOperationsService;

  beforeEach(() => {
    storage = new FakePlatformOperationsStorage();
    service = new PlatformOperationsService({ storage });
  });

  it('performs full 2-phase reserve -> commit lifecycle', async () => {
    const ops = service.forTenant('user_1');
    await ops.quota.setLimit({ resource: 'tokens', limit: 1000 });

    // Step 1: Reserve 400 tokens
    const reservation = await ops.quota.reserveQuota({
      resource: 'tokens',
      amount: 400,
    });

    expect(reservation.status).toBe('reserved');
    expect(reservation.amount).toBe(400);

    // Check usage mid-flight: 400 reserved, 0 committed, 600 remaining
    const midUsage = await ops.quota.checkQuota({ resource: 'tokens' });
    expect(midUsage.usage['tokens']).toBe(0);
    expect(midUsage.activeReservations['tokens']).toBe(400);
    expect(midUsage.remaining['tokens']).toBe(600);

    // Step 2: Commit with actual usage of 350 tokens
    const { reservation: committed, usage } = await ops.quota.commitQuota({
      reservationId: reservation.id,
      actualAmount: 350,
    });

    expect(committed.status).toBe('committed');
    expect(committed.committedAmount).toBe(350);
    expect(usage.used).toBe(350);
    expect(usage.reserved).toBe(0);
    expect(usage.remaining).toBe(650); // 1000 - 350 = 650
  });

  it('performs reserve -> release lifecycle and restores remaining quota', async () => {
    const ops = service.forTenant('user_1');
    await ops.quota.setLimit({ resource: 'api_calls', limit: 10 });

    // Reserve 4 calls
    const reservation = await ops.quota.reserveQuota({
      resource: 'api_calls',
      amount: 4,
    });

    let check = await ops.quota.checkQuota({ resource: 'api_calls' });
    expect(check.remaining['api_calls']).toBe(6);

    // Release reservation
    const released = await ops.quota.releaseQuota({
      reservationId: reservation.id,
      reason: 'aborted-turn',
    });

    expect(released.status).toBe('released');

    check = await ops.quota.checkQuota({ resource: 'api_calls' });
    expect(check.usage['api_calls']).toBe(0);
    expect(check.activeReservations['api_calls']).toBe(0);
    expect(check.remaining['api_calls']).toBe(10);
  });

  it('prevents over-allocation under concurrent reservation requests', async () => {
    const ops = service.forTenant('user_1');
    // Set total quota to exactly 100 units
    await ops.quota.setLimit({ resource: 'tokens', limit: 100 });

    // Try to launch 10 parallel reservation requests of 20 units each (total 200 units requested)
    const attempts = Array.from({ length: 10 }).map((_, i) =>
      ops.quota
        .reserveQuota({
          resource: 'tokens',
          amount: 20,
        })
        .then(() => ({ success: true }))
        .catch((err) => ({ success: false, error: err }))
    );

    const results = await Promise.all(attempts);

    const succeeded = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    // Exactly 5 reservations (5 * 20 = 100) must succeed, 5 must fail with QuotaExceededError
    expect(succeeded).toHaveLength(5);
    expect(failed).toHaveLength(5);

    for (const f of failed) {
      expect(f.error).toBeInstanceOf(QuotaExceededError);
    }

    const check = await ops.quota.checkQuota({ resource: 'tokens' });
    expect(check.activeReservations['tokens']).toBe(100);
    expect(check.remaining['tokens']).toBe(0);
  });

  it('rejects double settlement (double commit or release after commit)', async () => {
    const ops = service.forTenant('user_1');
    await ops.quota.setLimit({ resource: 'api_calls', limit: 5 });

    const reservation = await ops.quota.reserveQuota({
      resource: 'api_calls',
      amount: 2,
    });

    // First commit succeeds
    await ops.quota.commitQuota({ reservationId: reservation.id });

    // Second commit fails with ReservationSettledError
    await expect(
      ops.quota.commitQuota({ reservationId: reservation.id })
    ).rejects.toThrow(ReservationSettledError);

    // Release after commit fails
    await expect(
      ops.quota.releaseQuota({ reservationId: reservation.id })
    ).rejects.toThrow(ReservationSettledError);
  });

  it('automatically handles expired stale reservations during recovery', async () => {
    const ops = service.forTenant('user_1');
    await ops.quota.setLimit({ resource: 'tokens', limit: 500 });

    // Reserve 300 tokens with 1s TTL
    const reservation = await ops.quota.reserveQuota({
      resource: 'tokens',
      amount: 300,
      ttlSeconds: 1,
    });

    let check = await ops.quota.checkQuota({ resource: 'tokens' });
    expect(check.remaining['tokens']).toBe(200);

    // Simulate 2 seconds passing
    const futureTimeIso = new Date(Date.now() + 2000).toISOString();

    const sweepResult = await service.recoverAfterRestart({ nowIso: futureTimeIso });
    expect(sweepResult.expiredReservations).toBe(1);

    // After sweep, the 300 tokens are returned to the available balance
    check = await ops.quota.checkQuota({ resource: 'tokens' });
    expect(check.activeReservations['tokens']).toBe(0);
    expect(check.remaining['tokens']).toBe(500);

    // Attempting to commit the expired reservation fails
    await expect(
      ops.quota.commitQuota({ reservationId: reservation.id })
    ).rejects.toThrow();
  });
});
