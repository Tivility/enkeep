import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakePlatformOperationsStorage } from './support/index.js';
import { PlatformOperationsService } from '../src/services/platform-operations-service.js';
import type { OutboundChannelAdapter } from '../src/types/message.js';

describe('Message Operations & Outbound Receipt Idempotency', () => {
  let storage: FakePlatformOperationsStorage;
  let mockAdapter: OutboundChannelAdapter;
  let service: PlatformOperationsService;

  beforeEach(() => {
    storage = new FakePlatformOperationsStorage();
    mockAdapter = {
      deliver: vi.fn().mockResolvedValue({ outboundMessageId: 'ext_msg_999' }),
    };
    service = new PlatformOperationsService({
      storage,
      messageChannelAdapter: mockAdapter,
    });
  });

  it('delivers message and persists receipt with delivered status', async () => {
    const ops = service.forTenant('user_1');

    const result = await ops.messages.sendMessage({
      recipient: 'user_bob',
      content: 'Hello Bob',
      deliveryId: 'deliv_unique_1',
    });

    expect(result.success).toBe(true);
    expect(result.isIdempotentHit).toBe(false);
    expect(result.status).toBe('delivered');
    expect(result.receipt.deliveryId).toBe('deliv_unique_1');
    expect(result.receipt.userId).toBe('user_1');

    expect(mockAdapter.deliver).toHaveBeenCalledTimes(1);

    // Verify stored receipt
    const stored = await ops.messages.getReceipt('deliv_unique_1');
    expect(stored).not.toBeNull();
    expect(stored?.status).toBe('delivered');
  });

  it('guarantees outbound idempotency: duplicate deliveryId returns existing receipt without redelivering', async () => {
    const ops = service.forTenant('user_1');

    // First send
    const firstResult = await ops.messages.sendMessage({
      recipient: 'channel_dev',
      content: 'Important notification',
      deliveryId: 'deliv_shared_key',
    });

    expect(firstResult.success).toBe(true);
    expect(firstResult.isIdempotentHit).toBe(false);
    expect(mockAdapter.deliver).toHaveBeenCalledTimes(1);

    // Second send with IDENTICAL deliveryId
    const secondResult = await ops.messages.sendMessage({
      recipient: 'channel_dev',
      content: 'Important notification (retry)',
      deliveryId: 'deliv_shared_key',
    });

    expect(secondResult.success).toBe(true);
    expect(secondResult.isIdempotentHit).toBe(true);
    expect(secondResult.messageId).toBe(firstResult.messageId);
    expect(secondResult.receipt.id).toBe(firstResult.receipt.id);

    // Channel adapter MUST NOT have been called a second time
    expect(mockAdapter.deliver).toHaveBeenCalledTimes(1);
  });

  it('handles concurrent identical send requests idempotently without double dispatch', async () => {
    const ops = service.forTenant('user_concurrent');

    // 5 concurrent sends with the same deliveryId
    const sends = await Promise.all(
      Array.from({ length: 5 }).map((_, i) =>
        ops.messages.sendMessage({
          recipient: 'channel_ops',
          content: `Rapid retry batch payload ${i}`,
          deliveryId: 'deliv_concurrent_key_42',
        })
      )
    );

    // All sends return success
    for (const s of sends) {
      expect(s.success).toBe(true);
      expect(s.deliveryId).toBe('deliv_concurrent_key_42');
    }

    // Exactly 1 first-time send and 4 idempotent hits
    const firstSends = sends.filter((s) => !s.isIdempotentHit);
    const hitSends = sends.filter((s) => s.isIdempotentHit);

    expect(firstSends).toHaveLength(1);
    expect(hitSends).toHaveLength(4);

    // Outbound adapter called exactly once
    expect(mockAdapter.deliver).toHaveBeenCalledTimes(1);
  });

  it('records delivery failure accurately when outbound channel throws', async () => {
    const failingAdapter: OutboundChannelAdapter = {
      deliver: vi.fn().mockRejectedValue(new Error('Network connection timeout')),
    };

    const failingService = new PlatformOperationsService({
      storage,
      messageChannelAdapter: failingAdapter,
    });

    const ops = failingService.forTenant('user_1');

    const result = await ops.messages.sendMessage({
      recipient: 'unreachable_peer',
      content: 'Should fail',
      deliveryId: 'deliv_fail_1',
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.receipt.error).toBe('Network connection timeout');

    const stored = await ops.messages.getReceipt('deliv_fail_1');
    expect(stored?.status).toBe('failed');
    expect(stored?.error).toBe('Network connection timeout');

    // Idempotent retry on a failed receipt returns the failed receipt status
    const retryResult = await ops.messages.sendMessage({
      recipient: 'unreachable_peer',
      content: 'Should fail retry',
      deliveryId: 'deliv_fail_1',
    });

    expect(retryResult.isIdempotentHit).toBe(true);
    expect(retryResult.status).toBe('failed');
    expect(retryResult.receipt.error).toBe('Network connection timeout');
  });
});
