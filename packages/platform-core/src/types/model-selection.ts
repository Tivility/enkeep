/**
 * Model Selection, Override Governance, Health Telemetry, and Circuit Breaker Types
 *
 * Defines the canonical types for Enkeep's 5-tier model resolution hierarchy:
 * 1. Session Override
 * 2. Space Override
 * 3. User Preference Override
 * 4. Platform Override
 * 5. Local DSH Default
 *
 * @module @enkeep/platform-core/types/model-selection
 */

export type ModelOwnerType = 'session' | 'space' | 'user' | 'platform';

export type ModelResolutionSource = 'session' | 'space' | 'user' | 'platform' | 'dsh_default';

export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

export interface FallbackTarget {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string | null;
}

export interface ModelSelectionOverride {
  readonly id: string;
  readonly userId?: string | null;
  readonly ownerType: ModelOwnerType;
  readonly ownerId: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string | null;
  readonly fallbackChain?: readonly FallbackTarget[] | null;
  readonly revision: string;
  readonly updatedBy?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SetModelSelectionOverrideInput {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string | null;
  readonly fallbackChain?: readonly FallbackTarget[] | null;
  readonly ifMatch?: string | null;
}

export interface EffectiveModelSelection {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string | null;
  readonly fallbackChain: readonly FallbackTarget[];
  readonly source: ModelResolutionSource;
  readonly sourceOwnerId?: string | null;
  readonly revision: string;
}

export interface ModelHealthRecord {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly latencyMs: number;
  readonly statusCode: number;
  readonly success: boolean;
  readonly errorType?: string | null;
  readonly circuitState: CircuitBreakerState;
  readonly apiCalls: number;
  readonly tokens: number;
  readonly createdAt: string;
}

export interface RecordModelHealthInput {
  readonly provider: string;
  readonly model: string;
  readonly latencyMs: number;
  readonly statusCode: number;
  readonly success: boolean;
  readonly errorType?: string | null;
  readonly apiCalls?: number;
  readonly tokens?: number;
}

export interface ModelHealthSummary {
  readonly provider: string;
  readonly model: string;
  readonly circuitState: CircuitBreakerState;
  readonly totalCalls: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly consecutiveFailures: number;
  readonly errorRate: number;
  readonly avgLatencyMs: number;
  readonly lastLatencyMs?: number;
  readonly lastSuccessAt?: string | null;
  readonly lastFailureAt?: string | null;
  readonly lastErrorType?: string | null;
}

export interface ModelProbeRequest {
  readonly provider: string;
  readonly model: string;
  readonly mode?: 'list_models' | 'minimal_completion';
}

export interface ModelProbeResult {
  readonly provider: string;
  readonly model: string;
  readonly success: boolean;
  readonly latencyMs: number;
  readonly statusCode: number;
  readonly tokensUsed: number;
  readonly error?: string | null;
  readonly probedAt: string;
}

export interface CircuitBreakerResetResult {
  readonly resetCount: number;
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly message: string;
}
