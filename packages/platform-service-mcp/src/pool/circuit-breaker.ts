/**
 * Circuit Breaker and Failure Tracker for Downstream MCP Servers
 *
 * States:
 * - CLOSED: Normal operational state.
 * - OPEN: Downstream server is failing consecutively; fail immediately with MCP_CIRCUIT_OPEN.
 * - HALF_OPEN: Probe state after reset timeout; allows one trial call.
 *
 * @module @enkeep/platform-service-mcp/pool/circuit-breaker
 */

import { McpErrorCode, McpServiceError } from '../errors.js';
import {
  DEFAULT_CIRCUIT_FAILURE_THRESHOLD,
  DEFAULT_CIRCUIT_RESET_TIMEOUT_MS,
} from '../types.js';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  readonly failureThreshold?: number; // default: 3 (3 failures/60s)
  readonly resetTimeoutMs?: number; // default: 60,000 ms
  readonly onStateChange?: (serverId: string, state: CircuitState) => void;
}

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly onStateChange?: (serverId: string, state: CircuitState) => void;

  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private lastFailureTime = 0;
  private lastError?: string;

  constructor(readonly serverId: string, options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? DEFAULT_CIRCUIT_FAILURE_THRESHOLD;
    this.resetTimeoutMs = options.resetTimeoutMs ?? DEFAULT_CIRCUIT_RESET_TIMEOUT_MS;
    this.onStateChange = options.onStateChange;
  }

  getState(): CircuitState {
    if (this.state === 'OPEN') {
      const now = Date.now();
      if (now - this.lastFailureTime >= this.resetTimeoutMs) {
        this.transition('HALF_OPEN');
      }
    }
    return this.state;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  getLastError(): string | undefined {
    return this.lastError;
  }

  checkExecutionPermitted(): void {
    const currentState = this.getState();
    if (currentState === 'OPEN') {
      throw new McpServiceError(
        `MCP server "${this.serverId}" is temporarily unavailable (circuit breaker open)`,
        {
          code: McpErrorCode.MCP_CIRCUIT_OPEN,
          details: {
            serverId: this.serverId,
            consecutiveFailures: this.consecutiveFailures,
            lastError: this.lastError,
          },
        },
      );
    }
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.lastError = undefined;
    if (this.state !== 'CLOSED') {
      this.transition('CLOSED');
    }
  }

  recordFailure(error: unknown): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();
    this.lastError = error instanceof Error ? error.message : String(error);

    if (this.state === 'HALF_OPEN' || this.consecutiveFailures >= this.failureThreshold) {
      this.transition('OPEN');
    }
  }

  reset(): void {
    this.consecutiveFailures = 0;
    this.lastError = undefined;
    this.transition('CLOSED');
  }

  private transition(newState: CircuitState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.onStateChange?.(this.serverId, newState);
    }
  }
}
