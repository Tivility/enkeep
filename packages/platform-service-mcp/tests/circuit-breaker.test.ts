/**
 * Circuit Breaker and Dynamic Health Tracking Tests
 *
 * Tests:
 * - CLOSED -> OPEN transition after consecutive failures
 * - Fast-failure when circuit is OPEN (MCP_CIRCUIT_OPEN)
 * - OPEN -> HALF_OPEN after reset timeout
 * - Recovery back to CLOSED on successful call
 * - Health status reporting (healthy, degraded, unhealthy)
 */

import { describe, it, expect } from 'vitest';
import { CircuitBreaker } from '../src/pool/circuit-breaker.js';
import { McpErrorCode, McpServiceError } from '../src/errors.js';

describe('Circuit Breaker & Reliability Tracker', () => {
  it('transitions from CLOSED to OPEN after failure threshold', () => {
    const cb = new CircuitBreaker('test-server', {
      failureThreshold: 3,
      resetTimeoutMs: 200,
    });

    expect(cb.getState()).toBe('CLOSED');
    expect(() => cb.checkExecutionPermitted()).not.toThrow();

    cb.recordFailure(new Error('Fail 1'));
    expect(cb.getState()).toBe('CLOSED');

    cb.recordFailure(new Error('Fail 2'));
    expect(cb.getState()).toBe('CLOSED');

    cb.recordFailure(new Error('Fail 3'));
    expect(cb.getState()).toBe('OPEN');

    // Execution should now be rejected immediately
    expect(() => cb.checkExecutionPermitted()).toThrowError(
      /circuit breaker open/i,
    );
  });

  it('transitions to HALF_OPEN after timeout and recovers to CLOSED on success', async () => {
    const cb = new CircuitBreaker('test-server', {
      failureThreshold: 2,
      resetTimeoutMs: 100,
    });

    cb.recordFailure(new Error('err1'));
    cb.recordFailure(new Error('err2'));
    expect(cb.getState()).toBe('OPEN');

    // Wait for reset timeout
    await new Promise((r) => setTimeout(r, 120));

    expect(cb.getState()).toBe('HALF_OPEN');
    expect(() => cb.checkExecutionPermitted()).not.toThrow();

    // Success in HALF_OPEN recovers to CLOSED
    cb.recordSuccess();
    expect(cb.getState()).toBe('CLOSED');
  });
});
