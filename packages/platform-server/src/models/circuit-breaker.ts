/**
 * Circuit Breaker for LLM Providers & Models
 *
 * Re-exports canonical circuit breaker and classification logic from @enkeep/platform-core.
 *
 * @module @enkeep/platform-server/models/circuit-breaker
 */

export {
  type CircuitBreakerConfig,
  type BreakerStateEntry,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  classifyError,
  ModelCircuitBreakerRegistry,
} from '@enkeep/platform-core';
