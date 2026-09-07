import { describe, it, expect, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import * as InboundPlugin from '../src/index.js';

describe('InboundPlugin Cordis Composition & HMR / Disposal', () => {
  it('registers on Cordis Context and provides inbound service', async () => {
    const ctx = new Context();

    // Plugin named exports verification (must not have default export)
    expect(InboundPlugin.name).toBe('dsh-inbound');
    expect(InboundPlugin.inject).toEqual(['agents']);
    expect(typeof InboundPlugin.apply).toBe('function');
    expect((InboundPlugin as any).default).toBeUndefined();

    // Provide mock agents service
    const mockAgent = {
      id: SessionId('cordis-s1'),
      followup: vi.fn(),
      cancel: vi.fn(),
    };
    ctx.provide('agents', {
      get: (id: SessionId) => (id === 'cordis-s1' ? mockAgent : undefined),
    } as any);

    // Mount InboundPlugin
    const fiber = await ctx.plugin(InboundPlugin, {
      defaultTarget: 'followup',
    });

    // Inbound service should be available on ctx
    expect(ctx.inbound).toBeDefined();

    // Perform followup
    const result = await ctx.inbound.handleFollowup({
      deliveryId: 'del-comp-1',
      sessionId: 'cordis-s1',
      message: 'Cordis followup message',
    });

    expect(result.success).toBe(true);
    expect(mockAgent.followup).toHaveBeenCalled();

    // HMR / Dispose cleanup test
    await fiber.dispose();

    // After fiber disposal, service should be cleared
    expect(ctx.inbound).toBeUndefined();
  });
});
