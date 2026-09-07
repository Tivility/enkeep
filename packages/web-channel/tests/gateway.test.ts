import { describe, it, expect } from 'vitest';
import { InMemoryRuntimeGateway } from './test-gateway.js';
import type { InboundEnvelope } from '../src/types.js';

describe('InMemoryRuntimeGateway Module (Tenant-Scoped Session Turn Control)', () => {
  it('dispatches inbound envelope and reports current turn status', async () => {
    const gateway = new InMemoryRuntimeGateway({ autoReply: false });

    const envelope: InboundEnvelope = {
      id: 'deliv_00000000000000000000000000000001',
      userId: 'usr_alice123',
      sessionId: 'ses_1',
      content: 'Run diagnostic check',
      timestamp: new Date().toISOString(),
    };

    const res = await gateway.dispatchInbound(envelope);
    expect(res.accepted).toBe(true);
    expect(res.turnId).toBeDefined();
    expect(res.message.content).toBe('Run diagnostic check');

    const status = await gateway.getCurrentTurnStatus('usr_alice123', 'ses_1');
    expect(status?.status).toBe('queued');
  });

  it('handles completion and turn cancellation by authorized tenant', async () => {
    const gateway = new InMemoryRuntimeGateway({ autoReply: false });

    const envelope: InboundEnvelope = {
      id: 'deliv_00000000000000000000000000000002',
      userId: 'usr_alice123',
      sessionId: 'ses_2',
      content: 'Long running task',
      timestamp: new Date().toISOString(),
    };

    const res = await gateway.dispatchInbound(envelope);
    expect(res.accepted).toBe(true);

    // Cancel current turn by Alice
    const cancelled = await gateway.cancelCurrentTurn('usr_alice123', 'ses_2');
    expect(cancelled).toBe(true);

    const status = await gateway.getCurrentTurnStatus('usr_alice123', 'ses_2');
    expect(status?.status).toBe('interrupted');
    expect(status?.code).toBe('INTERRUPTED');
  });

  it('enforces multi-tenant isolation: Bob cannot query or cancel Alice turn', async () => {
    const gateway = new InMemoryRuntimeGateway({ autoReply: false });

    const envelope: InboundEnvelope = {
      id: 'deliv_00000000000000000000000000000003',
      userId: 'usr_alice123',
      sessionId: 'ses_3',
      content: 'Confidential computation',
      timestamp: new Date().toISOString(),
    };

    const res = await gateway.dispatchInbound(envelope);
    expect(res.accepted).toBe(true);

    // Bob attempts to query Alice current turn status
    const bobStatus = await gateway.getCurrentTurnStatus('usr_bob456', 'ses_3');
    expect(bobStatus).toBeNull();

    // Bob attempts to cancel Alice turn
    const bobCancel = await gateway.cancelCurrentTurn('usr_bob456', 'ses_3');
    expect(bobCancel).toBe(false);

    // Alice turn is still queued/untampered
    const aliceStatus = await gateway.getCurrentTurnStatus('usr_alice123', 'ses_3');
    expect(aliceStatus?.status).toBe('queued');
  });
});
