/**
 * Safety Error Definitions for Enkeep Guardrails
 */

export type SafetyErrorCode =
  | 'UNSAFE_HOST_BINDING'
  | 'UNSAFE_PORT_ALLOCATION'
  | 'PORT_IN_USE'
  | 'PORT_RANGE_EXHAUSTED'
  | 'UNSAFE_PATH_TARGET'
  | 'PATH_OUTSIDE_DEMO_BOUNDARY'
  | 'FORBIDDEN_DATA_ACCESS'
  | 'UNVERIFIED_PROCESS_OWNERSHIP'
  | 'INVALID_PID_METADATA'
  | 'UNVERIFIED_CONTAINER_OWNERSHIP'
  | 'PREFLIGHT_VALIDATION_FAILED';

export class SafetyViolationError extends Error {
  public readonly code: SafetyErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(code: SafetyErrorCode, message: string, details?: Record<string, unknown>) {
    super(`[SAFETY VIOLATION] ${code}: ${message}`);
    this.name = 'SafetyViolationError';
    this.code = code;
    this.details = details;

    // Restore prototype chain
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
