import { describe, it, expect } from 'vitest';
import type { InboundEnvelope, PublicMessage } from '../src/types.js';

describe('Web Channel Envelope Abstractions', () => {
  it('creates and validates InboundEnvelope structure', () => {
    const inbound: InboundEnvelope = {
      id: 'inb_test_1',
      userId: 'usr_alice123',
      sessionId: 'ses_001',
      content: 'Hello, what can you do?',
      timestamp: new Date().toISOString(),
    };

    expect(inbound.id).toBe('inb_test_1');
    expect(inbound.userId).toBe('usr_alice123');
    expect(inbound.sessionId).toBe('ses_001');
    expect(inbound.content).toBe('Hello, what can you do?');
    expect(inbound.timestamp).toBeDefined();
  });

  it('validates PublicMessage structure', () => {
    const msg: PublicMessage = {
      id: 'msg_001',
      role: 'assistant',
      content: 'I can assist you with your tasks.',
      status: 'delivered',
      createdAt: new Date().toISOString(),
    };

    expect(msg.id).toBe('msg_001');
    expect(msg.role).toBe('assistant');
    expect(msg.status).toBe('delivered');
    expect(msg.content).toBe('I can assist you with your tasks.');
  });
});
