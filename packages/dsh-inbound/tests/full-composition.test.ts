import { describe, it, expect, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Agent } from '@deepseek-ai/dsh-agent';
import * as ReceiptStorePlugin from '@enkeep/dsh-receipt-store-sqlite';
import * as InboundPlugin from '../src/index.js';
import * as EventRelayPlugin from '@enkeep/dsh-event-relay';

describe('Atomic DSH Plugins Full Composition & Integration Test', () => {
  it('composes receipt-store, inbound, and event-relay plugins in a single Cordis application', async () => {
    const ctx = new Context();

    // 1. Mock Agents Service
    const mockFollowup = vi.fn();
    const mockCancel = vi.fn();
    const mockAgent: Agent = {
      id: SessionId('sess-full-1'),
      options: {},
      session: { id: SessionId('sess-full-1') } as any,
      inbox: {} as any,
      status: 'idle',
      ctx: new Context(),
      followup: mockFollowup,
      cancel: mockCancel,
      whenIdle: vi.fn().mockResolvedValue(undefined),
      runMaintenance: vi.fn(),
      send: vi.fn(),
      steer: vi.fn(),
      inject: vi.fn(),
    };

    ctx.provide('agents', {
      get: (id: SessionId) => (id === 'sess-full-1' ? mockAgent : undefined),
    } as any);

    // 2. Mount Receipt Store Plugin
    const receiptFiber = await ctx.plugin(ReceiptStorePlugin, {
      path: ':memory:',
      userId: 'tenant-composite',
    });

    // 3. Mount Inbound Plugin
    const inboundFiber = await ctx.plugin(InboundPlugin, {
      defaultTarget: 'followup',
    });

    // 4. Mount Event Relay Plugin
    const relayFiber = await ctx.plugin(EventRelayPlugin, {
      maxBufferSize: 100,
      consumer: 'composite-worker',
    });

    // Verify all three services are registered and available
    expect(ctx.receiptStore).toBeDefined();
    expect(ctx.inbound).toBeDefined();
    expect(ctx.eventRelay).toBeDefined();

    // 5. Inbound handles followup from authenticated transport
    const followupResult = await ctx.inbound.handleFollowup({
      deliveryId: 'del-composite-1',
      sessionId: 'sess-full-1',
      message: 'Composite execution prompt',
      source: {
        routeId: 'route-composite-1',
        sourceType: 'slack',
        sourceId: 'msg-composite-99',
      },
    });

    expect(followupResult.success).toBe(true);
    expect(followupResult.duplicate).toBe(false);
    expect(mockFollowup).toHaveBeenCalledTimes(1);

    // Check receipt persisted in receipt store
    const storedReceipt = await ctx.receiptStore.getReceiptByDeliveryId('del-composite-1');
    expect(storedReceipt).not.toBeNull();
    expect(storedReceipt?.status).toBe('delivered');
    expect(storedReceipt?.messageId).toBe(followupResult.messageId);

    // Check session source persisted in receipt store
    const storedSource = await ctx.receiptStore.getSessionSource('slack', 'msg-composite-99');
    expect(storedSource).not.toBeNull();
    expect(storedSource?.routeId).toBe('route-composite-1');

    // 6. Simulate agent producing session events on Cordis event bus
    const unbindAgent = ctx.eventRelay.attachAgent(ctx);
    const event1 = { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } } as any;
    const event2 = {
      type: 'user/message',
      seq: 2,
      time: 1001,
      data: { id: followupResult.messageId, role: 'user', content: [{ type: 'text', text: 'Composite execution prompt' }] },
    } as any;

    ctx.emit('session/event', mockAgent.session, event1);
    ctx.emit('session/event', mockAgent.session, event2);

    // Verify EventRelay buffered the events with session-scoped cursors
    expect(ctx.eventRelay.getBufferSize('sess-full-1')).toBe(2);
    const polled = await ctx.eventRelay.poll({ sessionId: 'sess-full-1' });
    expect(polled.envelopes).toHaveLength(2);
    expect(polled.envelopes[0].cursor).toBe('sess-full-1:1');
    expect(polled.envelopes[1].cursor).toBe('sess-full-1:2');

    // 7. Client acknowledges events for sess-full-1 up to cursor 'sess-full-1:2'
    await ctx.eventRelay.ack('sess-full-1', 'sess-full-1:2');

    // Verify per-session cursor persisted to receiptStore
    const cursorRecord = await ctx.receiptStore.getEventCursor('sess-full-1', 'composite-worker');
    expect(cursorRecord?.cursorValue).toBe('sess-full-1:2');

    // Verify EventRelay buffer was trimmed
    expect(ctx.eventRelay.getBufferSize('sess-full-1')).toBe(0);

    unbindAgent();

    // 8. Test Idempotency: resubmitting 'del-composite-1'
    const duplicateResult = await ctx.inbound.handleFollowup({
      deliveryId: 'del-composite-1',
      sessionId: 'sess-full-1',
      message: 'Duplicate prompt',
    });

    expect(duplicateResult.success).toBe(true);
    expect(duplicateResult.duplicate).toBe(true);
    expect(duplicateResult.messageId).toBe(followupResult.messageId);
    // Agent was not called again
    expect(mockFollowup).toHaveBeenCalledTimes(1);

    // 9. Dispose all plugins (HMR cleanup)
    await relayFiber.dispose();
    await inboundFiber.dispose();
    await receiptFiber.dispose();

    expect(ctx.eventRelay).toBeUndefined();
    expect(ctx.inbound).toBeUndefined();
    expect(ctx.receiptStore).toBeUndefined();
  });
});
