export const PlatformToolErrorCode = {
  PLATFORM_TOOL_UNAVAILABLE: 'PLATFORM_TOOL_UNAVAILABLE',
  INVALID_PLATFORM_RESPONSE: 'INVALID_PLATFORM_RESPONSE',
  TOOL_CONTEXT_UNAVAILABLE: 'TOOL_CONTEXT_UNAVAILABLE',
} as const;

export type PlatformToolErrorCode = (typeof PlatformToolErrorCode)[keyof typeof PlatformToolErrorCode];

export class PlatformToolError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: PlatformToolErrorCode | string,
    status = 500,
    details?: Record<string, unknown>,
    cause?: unknown
  ) {
    super(message, { cause });
    this.name = 'PlatformToolError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function createPlatformToolUnavailableError(
  message: string,
  details?: Record<string, unknown>,
  cause?: unknown
): PlatformToolError {
  return new PlatformToolError(
    message,
    PlatformToolErrorCode.PLATFORM_TOOL_UNAVAILABLE,
    503,
    details,
    cause
  );
}

export function createInvalidPlatformResponseError(
  message: string,
  details?: Record<string, unknown>,
  cause?: unknown
): PlatformToolError {
  return new PlatformToolError(
    message,
    PlatformToolErrorCode.INVALID_PLATFORM_RESPONSE,
    502,
    details,
    cause
  );
}

export function createToolContextUnavailableError(
  message: string,
  details?: Record<string, unknown>,
  cause?: unknown
): PlatformToolError {
  return new PlatformToolError(
    message,
    PlatformToolErrorCode.TOOL_CONTEXT_UNAVAILABLE,
    503,
    details,
    cause
  );
}
