/**
 * Error classes and factory functions for @enkeep/dsh-tool-browser
 *
 * @module @enkeep/dsh-tool-browser/errors
 */

export const BrowserToolErrorCode = {
  BROWSER_TOOL_UNAVAILABLE: 'BROWSER_TOOL_UNAVAILABLE',
  INVALID_BROWSER_RESPONSE: 'INVALID_BROWSER_RESPONSE',
  BROWSER_CONTEXT_UNAVAILABLE: 'BROWSER_CONTEXT_UNAVAILABLE',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  UNSAFE_URL: 'UNSAFE_URL',
  APPROVAL_REJECTED: 'APPROVAL_REJECTED',
  APPROVAL_CANCELLED: 'APPROVAL_CANCELLED',
  APPROVAL_UNAVAILABLE: 'APPROVAL_UNAVAILABLE',
  PAGE_NOT_FOUND: 'PAGE_NOT_FOUND',
  ELEMENT_NOT_FOUND: 'ELEMENT_NOT_FOUND',
  OPERATION_FAILED: 'OPERATION_FAILED',
} as const;

export type BrowserToolErrorCode = (typeof BrowserToolErrorCode)[keyof typeof BrowserToolErrorCode];

export class BrowserToolError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: BrowserToolErrorCode | string,
    status = 500,
    details?: Record<string, unknown>,
    cause?: unknown
  ) {
    super(message, { cause });
    this.name = 'BrowserToolError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function createBrowserToolUnavailableError(
  message = 'Browser platform service is not available (platformClient missing or browser capability unready)',
  details?: Record<string, unknown>,
  cause?: unknown
): BrowserToolError {
  return new BrowserToolError(
    message,
    BrowserToolErrorCode.BROWSER_TOOL_UNAVAILABLE,
    503,
    details,
    cause
  );
}

export function createInvalidBrowserResponseError(
  message = 'Received invalid response payload from platform browser service',
  details?: Record<string, unknown>,
  cause?: unknown
): BrowserToolError {
  return new BrowserToolError(
    message,
    BrowserToolErrorCode.INVALID_BROWSER_RESPONSE,
    502,
    details,
    cause
  );
}

export function createBrowserContextUnavailableError(
  message = 'No active agent session context found to derive initiator scope',
  details?: Record<string, unknown>,
  cause?: unknown
): BrowserToolError {
  return new BrowserToolError(
    message,
    BrowserToolErrorCode.BROWSER_CONTEXT_UNAVAILABLE,
    500,
    details,
    cause
  );
}

export function createUnsafeUrlError(
  message: string,
  details?: Record<string, unknown>
): BrowserToolError {
  return new BrowserToolError(
    message,
    BrowserToolErrorCode.UNSAFE_URL,
    400,
    details
  );
}

export function createInvalidArgumentError(
  message: string,
  details?: Record<string, unknown>
): BrowserToolError {
  return new BrowserToolError(
    message,
    BrowserToolErrorCode.INVALID_ARGUMENT,
    400,
    details
  );
}
