import { describe, it, expect } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import * as ReceiptStorePlugin from '../src/index.js';

describe('ReceiptStorePlugin Cordis Composition & HMR / Disposal', () => {
  it('registers on Cordis Context and provides receiptStore service', async () => {
    const ctx = new Context();

    // Plugin named exports verification (must not have default export)
    expect(ReceiptStorePlugin.name).toBe('dsh-receipt-store-sqlite');
    expect(ReceiptStorePlugin.inject).toEqual([]);
    expect(typeof ReceiptStorePlugin.apply).toBe('function');
    expect((ReceiptStorePlugin as any).default).toBeUndefined();

    // Mount plugin with config
    const fiber = await ctx.plugin(ReceiptStorePlugin, {
      path: ':memory:',
      userId: 'cordis-tenant',
      journalMode: 'memory',
      busyTimeoutMs: 10000,
    });

    // Service should be available on ctx
    expect(ctx.receiptStore).toBeDefined();
    expect(ctx.receiptStore.userId).toBe('cordis-tenant');
    expect(ctx.receiptStore.isClosed).toBe(false);

    // Verify operations work through ctx.receiptStore
    const receipt = await ctx.receiptStore.recordReceipt({
      deliveryId: 'cordis-del-1',
      messageId: 'cordis-msg-1',
      status: 'pending',
    });
    expect(receipt.deliveryId).toBe('cordis-del-1');

    // HMR / Dispose cleanup test
    await fiber.dispose();

    // After fiber disposal, service should be cleared and store closed
    expect(ctx.receiptStore).toBeUndefined();
  });

  it('rejects invalid configuration through Standard Schema validation', async () => {
    const ctx = new Context();

    // Missing/empty path
    await expect(
      ctx.plugin(ReceiptStorePlugin, {
        path: '',
        userId: 'some-user',
      } as any)
    ).rejects.toThrow();

    // Missing/empty userId
    await expect(
      ctx.plugin(ReceiptStorePlugin, {
        path: ':memory:',
        userId: '',
      } as any)
    ).rejects.toThrow();

    // Invalid userId characters
    await expect(
      ctx.plugin(ReceiptStorePlugin, {
        path: ':memory:',
        userId: 'invalid user with spaces',
      } as any)
    ).rejects.toThrow();

    // Unknown configuration key
    await expect(
      ctx.plugin(ReceiptStorePlugin, {
        path: ':memory:',
        userId: 'valid-user',
        unknownProp: 'not-allowed',
      } as any)
    ).rejects.toThrow();

    // Invalid journalMode
    await expect(
      ctx.plugin(ReceiptStorePlugin, {
        path: ':memory:',
        userId: 'valid-user',
        journalMode: 'super-fast' as any,
      })
    ).rejects.toThrow();

    // Invalid busyTimeoutMs (negative, 0, or exceeds 60000)
    await expect(
      ctx.plugin(ReceiptStorePlugin, {
        path: ':memory:',
        userId: 'valid-user',
        busyTimeoutMs: 0,
      })
    ).rejects.toThrow();

    await expect(
      ctx.plugin(ReceiptStorePlugin, {
        path: ':memory:',
        userId: 'valid-user',
        busyTimeoutMs: 70000,
      })
    ).rejects.toThrow();

    // Non-object config
    await expect(
      ctx.plugin(ReceiptStorePlugin, null as any)
    ).rejects.toThrow();
  });
});
