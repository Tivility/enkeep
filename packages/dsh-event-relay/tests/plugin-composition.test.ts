import { describe, it, expect, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import * as EventRelayPlugin from '../src/index.js';

describe('EventRelayPlugin Scoped Composition, Agent Scope Attachment & HMR / Disposal', () => {
  it('registers service on Cordis Context, attaches to agent scoped context, listens to session/event, and unbinds on disposer/disposal', async () => {
    const ctx = new Context();

    // Plugin named exports verification (must not have default export)
    expect(EventRelayPlugin.name).toBe('dsh-event-relay');
    expect(EventRelayPlugin.inject).toEqual([]);
    expect(typeof EventRelayPlugin.apply).toBe('function');
    expect((EventRelayPlugin as any).default).toBeUndefined();

    // Mount EventRelayPlugin
    const fiber = await ctx.plugin(EventRelayPlugin, {
      maxBufferSize: 50,
      consumer: 'test-consumer',
    });

    // Service should be available on ctx
    expect(ctx.eventRelay).toBeDefined();

    // Subscribe to test real-time notification
    const subscriber = vi.fn();
    ctx.eventRelay.subscribe(subscriber);

    // Create child agent-scoped context and attach via attachAgent
    const agentCtx = new Context();
    const disposer = ctx.eventRelay.attachAgent(agentCtx);

    // Emit session/event on the agent-scoped event bus
    const mockSession = { id: SessionId('cordis-session-1') } as any;
    const mockEvent1: SessionEvent = {
      type: 'turn/start',
      seq: 1,
      time: Date.now(),
      data: { turn: 1 },
    };

    agentCtx.emit('session/event', mockSession, mockEvent1);

    // EventRelay should have ingested the event
    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(subscriber).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: 'cordis-session-1:1',
      })
    );

    // Disposer unbinds the agent scoped listener
    disposer();

    // Emit another event after disposer: should NOT trigger the subscriber again
    const mockEvent2: SessionEvent = {
      type: 'turn/end',
      seq: 2,
      time: Date.now(),
      data: { turn: 1, reason: { kind: 'completed' } },
    };
    agentCtx.emit('session/event', mockSession, mockEvent2);

    expect(subscriber).toHaveBeenCalledTimes(1); // was NOT called again

    // HMR / Fiber disposal cleanup test
    await fiber.dispose();

    // After fiber disposal, service should be cleared
    expect(ctx.eventRelay).toBeUndefined();
  });
});
