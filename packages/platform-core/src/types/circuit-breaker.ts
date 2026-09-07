/**
 * Circuit Breaker and Error Classification for LLM Providers & Models
 *
 * Implements a stateful circuit breaker per (provider, model) tuple:
 * - States: 'closed' (normal), 'open' (tripped), 'half-open' (probing)
 * - Configurable failure threshold (default: 3 consecutive transient failures)
 * - Configurable cooldown timeout (default: 30,000 ms)
 * - Distinguishes transient errors (5xx, 429, timeout, network) from permanent/auth errors (400, 401, 403)
 *
 * @module @enkeep/platform-core/types/circuit-breaker
 */

import type { CircuitBreakerState, ModelHealthSummary } from './model-selection.js';

export interface CircuitBreakerConfig {
  /** Number of consecutive transient failures before opening the circuit (default: 3) */
  consecutiveFailuresThreshold: number;
  /** Cooldown duration in milliseconds before moving from open to half-open (default: 30000) */
  cooldownDurationMs: number;
  /** Maximum trial requests allowed in half-open state (default: 1) */
  halfOpenMaxTrials: number;
  /** Custom clock function for deterministic testing */
  now?: () => number;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  consecutiveFailuresThreshold: 3,
  cooldownDurationMs: 30000,
  halfOpenMaxTrials: 1,
};

export interface BreakerStateEntry {
  provider: string;
  model: string;
  state: CircuitBreakerState;
  consecutiveFailures: number;
  failureCount: number;
  successCount: number;
  totalCalls: number;
  totalLatencyMs: number;
  lastLatencyMs?: number;
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
  lastErrorType?: string | null;
  trippedAt?: number | null;
  halfOpenTrials: number;
}

/**
 * Classifies an error into transient vs. permanent/auth.
 */
export function classifyError(errOrStatus: unknown): {
  isTransient: boolean;
  isAuthOrPermanent: boolean;
  errorType: string;
  statusCode?: number;
} {
  let statusCode: number | undefined;
  let message = '';

  if (typeof errOrStatus === 'number') {
    statusCode = errOrStatus;
  } else if (errOrStatus && typeof errOrStatus === 'object') {
    const obj = errOrStatus as Record<string, unknown>;
    if (typeof obj.status === 'number') statusCode = obj.status;
    else if (typeof obj.statusCode === 'number') statusCode = obj.statusCode;
    if (typeof obj.message === 'string') message = obj.message;
    if (!message && obj.failure && typeof obj.failure === 'object') {
      const f = obj.failure as Record<string, unknown>;
      if (typeof f.message === 'string') message = f.message;
      if (typeof f.status === 'number') statusCode = f.status;
      if (typeof f.statusCode === 'number') statusCode = f.statusCode;
    }
  } else if (typeof errOrStatus === 'string') {
    message = errOrStatus;
  }

  const msgLower = message.toLowerCase();

  // Explicit status codes
  if (statusCode !== undefined) {
    if (statusCode === 401 || statusCode === 403) {
      return { isTransient: false, isAuthOrPermanent: true, errorType: 'AUTH_FAILURE', statusCode };
    }
    if (statusCode === 400 || statusCode === 404 || statusCode === 422) {
      return { isTransient: false, isAuthOrPermanent: true, errorType: 'INVALID_REQUEST', statusCode };
    }
    if (statusCode === 429) {
      return { isTransient: true, isAuthOrPermanent: false, errorType: 'RATE_LIMIT', statusCode };
    }
    if (statusCode >= 500 && statusCode < 600) {
      return { isTransient: true, isAuthOrPermanent: false, errorType: 'SERVER_ERROR', statusCode };
    }
  }

  // String message heuristics
  if (
    msgLower.includes('auth') ||
    msgLower.includes('unauthorized') ||
    msgLower.includes('forbidden') ||
    msgLower.includes('api key') ||
    msgLower.includes('invalid_api_key') ||
    msgLower.includes('token expired')
  ) {
    return { isTransient: false, isAuthOrPermanent: true, errorType: 'AUTH_FAILURE', statusCode: 401 };
  }

  if (
    msgLower.includes('rate limit') ||
    msgLower.includes('quota exceeded') ||
    msgLower.includes('too many requests') ||
    msgLower.includes('429')
  ) {
    return { isTransient: true, isAuthOrPermanent: false, errorType: 'RATE_LIMIT', statusCode: 429 };
  }

  if (
    msgLower.includes('timeout') ||
    msgLower.includes('etimedout') ||
    msgLower.includes('econnreset') ||
    msgLower.includes('econnrefused') ||
    msgLower.includes('fetch failed') ||
    msgLower.includes('network') ||
    msgLower.includes('503') ||
    msgLower.includes('502') ||
    msgLower.includes('504') ||
    msgLower.includes('500')
  ) {
    return { isTransient: true, isAuthOrPermanent: false, errorType: 'TRANSIENT_NETWORK', statusCode: 503 };
  }

  // Default to transient for unknown runtime network/server errors
  return { isTransient: true, isAuthOrPermanent: false, errorType: 'UNKNOWN_TRANSIENT', statusCode: 500 };
}

export class ModelCircuitBreakerRegistry {
  private readonly breakers = new Map<string, BreakerStateEntry>();
  private readonly config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = {
      ...DEFAULT_CIRCUIT_BREAKER_CONFIG,
      ...config,
    };
  }

  private getKey(provider: string, model: string): string {
    return `${provider}::${model}`;
  }

  private getNow(): number {
    return this.config.now ? this.config.now() : Date.now();
  }

  private getOrCreate(provider: string, model: string): BreakerStateEntry {
    const key = this.getKey(provider, model);
    let entry = this.breakers.get(key);
    if (!entry) {
      entry = {
        provider,
        model,
        state: 'closed',
        consecutiveFailures: 0,
        failureCount: 0,
        successCount: 0,
        totalCalls: 0,
        totalLatencyMs: 0,
        halfOpenTrials: 0,
      };
      this.breakers.set(key, entry);
    }
    return entry;
  }

  /**
   * Checks if an execution is allowed for the given (provider, model).
   * Automatically handles half-open transitions when cooldown expires.
   */
  canExecute(provider: string, model: string): {
    allowed: boolean;
    state: CircuitBreakerState;
    reason?: string;
  } {
    const entry = this.getOrCreate(provider, model);
    const now = this.getNow();

    if (entry.state === 'closed') {
      return { allowed: true, state: 'closed' };
    }

    if (entry.state === 'open') {
      const trippedAt = entry.trippedAt ?? 0;
      const elapsed = now - trippedAt;
      if (elapsed >= this.config.cooldownDurationMs) {
        // Transition to half-open for probing
        entry.state = 'half-open';
        entry.halfOpenTrials = 1;
        return { allowed: true, state: 'half-open' };
      }
      return {
        allowed: false,
        state: 'open',
        reason: `Circuit breaker is open for ${provider}/${model}. Cooldown remaining: ${Math.max(0, this.config.cooldownDurationMs - elapsed)}ms`,
      };
    }

    if (entry.state === 'half-open') {
      if (entry.halfOpenTrials < this.config.halfOpenMaxTrials) {
        entry.halfOpenTrials++;
        return { allowed: true, state: 'half-open' };
      }
      return {
        allowed: false,
        state: 'half-open',
        reason: `Circuit breaker is half-open with trial in progress for ${provider}/${model}`,
      };
    }

    return { allowed: true, state: 'closed' };
  }

  /**
   * Records a successful execution. Resets breaker to closed.
   */
  recordSuccess(provider: string, model: string, latencyMs = 0): void {
    const entry = this.getOrCreate(provider, model);
    const nowIso = new Date(this.getNow()).toISOString();

    entry.totalCalls++;
    entry.successCount++;
    entry.consecutiveFailures = 0;
    entry.lastLatencyMs = latencyMs;
    entry.totalLatencyMs += latencyMs;
    entry.lastSuccessAt = nowIso;

    if (entry.state !== 'closed') {
      entry.state = 'closed';
      entry.trippedAt = null;
      entry.halfOpenTrials = 0;
    }
  }

  /**
   * Records a failed execution.
   * If transient and consecutive failures >= threshold, trips the breaker to 'open'.
   */
  recordFailure(
    provider: string,
    model: string,
    error: unknown,
    latencyMs = 0
  ): {
    state: CircuitBreakerState;
    isTransient: boolean;
    errorType: string;
    consecutiveFailures: number;
  } {
    const entry = this.getOrCreate(provider, model);
    const now = this.getNow();
    const nowIso = new Date(now).toISOString();
    const classification = classifyError(error);

    entry.totalCalls++;
    entry.failureCount++;
    entry.lastLatencyMs = latencyMs;
    entry.totalLatencyMs += latencyMs;
    entry.lastFailureAt = nowIso;
    entry.lastErrorType = classification.errorType;

    if (classification.isTransient) {
      entry.consecutiveFailures++;
      if (
        entry.state === 'half-open' ||
        entry.consecutiveFailures >= this.config.consecutiveFailuresThreshold
      ) {
        entry.state = 'open';
        entry.trippedAt = now;
        entry.halfOpenTrials = 0;
      }
    }

    return {
      state: entry.state,
      isTransient: classification.isTransient,
      errorType: classification.errorType,
      consecutiveFailures: entry.consecutiveFailures,
    };
  }

  /**
   * Resets circuit breaker for a specific provider/model or all.
   */
  reset(provider?: string | null, model?: string | null): number {
    let count = 0;
    if (provider && model) {
      const key = this.getKey(provider, model);
      const entry = this.breakers.get(key);
      if (entry) {
        entry.state = 'closed';
        entry.consecutiveFailures = 0;
        entry.trippedAt = null;
        entry.halfOpenTrials = 0;
        count = 1;
      }
    } else if (provider) {
      for (const [key, entry] of this.breakers.entries()) {
        if (key.startsWith(`${provider}::`)) {
          entry.state = 'closed';
          entry.consecutiveFailures = 0;
          entry.trippedAt = null;
          entry.halfOpenTrials = 0;
          count++;
        }
      }
    } else {
      for (const entry of this.breakers.values()) {
        entry.state = 'closed';
        entry.consecutiveFailures = 0;
        entry.trippedAt = null;
        entry.halfOpenTrials = 0;
        count++;
      }
    }
    return count;
  }

  /**
   * Returns current health summary for all tracked models.
   */
  getHealthSummaries(): ModelHealthSummary[] {
    const results: ModelHealthSummary[] = [];
    for (const entry of this.breakers.values()) {
      const total = entry.totalCalls;
      const errorRate = total > 0 ? entry.failureCount / total : 0;
      const avgLatencyMs = total > 0 ? Math.round(entry.totalLatencyMs / total) : 0;

      results.push({
        provider: entry.provider,
        model: entry.model,
        circuitState: entry.state,
        totalCalls: entry.totalCalls,
        successCount: entry.successCount,
        failureCount: entry.failureCount,
        consecutiveFailures: entry.consecutiveFailures,
        errorRate: Math.round(errorRate * 1000) / 1000,
        avgLatencyMs,
        lastLatencyMs: entry.lastLatencyMs,
        lastSuccessAt: entry.lastSuccessAt,
        lastFailureAt: entry.lastFailureAt,
        lastErrorType: entry.lastErrorType,
      });
    }
    return results;
  }

  /**
   * Returns breaker state for a specific model.
   */
  getCircuitStatus(provider: string, model: string): CircuitBreakerState {
    const key = this.getKey(provider, model);
    const entry = this.breakers.get(key);
    if (!entry) return 'closed';

    if (entry.state === 'open') {
      const now = this.getNow();
      const elapsed = now - (entry.trippedAt ?? 0);
      if (elapsed >= this.config.cooldownDurationMs) {
        return 'half-open';
      }
    }

    return entry.state;
  }
}
