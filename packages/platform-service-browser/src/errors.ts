/**
 * Browser Service Error Hierarchy
 *
 * Provides structured error types with machine-readable error codes and safe sanitization.
 * Invariant: Never leaks secret tokens, credentials, or absolute system file paths in messages or details.
 *
 * @module @enkeep/platform-service-browser/errors
 */

export enum BrowserErrorCode {
  BROWSER_SSRF_BLOCKED = 'BROWSER_SSRF_BLOCKED',
  BROWSER_TIMEOUT = 'BROWSER_TIMEOUT',
  BROWSER_RESOURCE_LIMIT = 'BROWSER_RESOURCE_LIMIT',
  BROWSER_PAGE_NOT_FOUND = 'BROWSER_PAGE_NOT_FOUND',
  BROWSER_CONTEXT_NOT_FOUND = 'BROWSER_CONTEXT_NOT_FOUND',
  BROWSER_INVALID_REF = 'BROWSER_INVALID_REF',
  BROWSER_ACTION_FAILED = 'BROWSER_ACTION_FAILED',
  BROWSER_WORKER_CRASHED = 'BROWSER_WORKER_CRASHED',
  BROWSER_UNAVAILABLE = 'BROWSER_UNAVAILABLE',
  BROWSER_BAD_REQUEST = 'BROWSER_BAD_REQUEST',
  BROWSER_SECURITY_VIOLATION = 'BROWSER_SECURITY_VIOLATION',
  BROWSER_INTERNAL_ERROR = 'BROWSER_INTERNAL_ERROR',
}

export interface BrowserErrorOptions {
  code?: BrowserErrorCode;
  details?: Record<string, unknown>;
  cause?: unknown;
  retryable?: boolean;
}

export class BrowserServiceError extends Error {
  readonly code: BrowserErrorCode;
  readonly details: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(message: string, options: BrowserErrorOptions = {}) {
    const sanitized = sanitizeErrorMessage(message);
    super(sanitized);
    this.name = 'BrowserServiceError';
    this.code = options.code ?? BrowserErrorCode.BROWSER_INTERNAL_ERROR;
    this.details = options.details ? sanitizeErrorDetails(options.details) : {};
    this.retryable = options.retryable ?? false;

    if (options.cause) {
      this.cause = options.cause;
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      details: this.details,
      retryable: this.retryable,
    };
  }
}

export function isBrowserServiceError(err: unknown): err is BrowserServiceError {
  return err instanceof BrowserServiceError;
}

/**
 * Redacts secret credentials, query tokens, authorization headers, and absolute file paths from error text.
 */
export function sanitizeErrorMessage(rawMessage: string): string {
  if (!rawMessage || typeof rawMessage !== 'string') {
    return '';
  }

  return rawMessage
    // Redact basic auth in URLs (http://user:pass@host)
    .replace(/(https?:\/\/)[^:@\s/]+:[^@\s/]+@/gi, '$1***:***@')
    // Redact bearer tokens
    .replace(/(Bearer\s+)[a-zA-Z0-9._~+/-]+=*/gi, '$1***')
    // Redact sensitive query parameters
    .replace(/([?&](?:token|password|passwd|pwd|secret|key|api_key|apikey|auth|session|sessionId|session_token)=)[^&#\s]+/gi, '$1***')
    // Redact Unix/macOS absolute file paths (/Users/..., /home/..., /var/..., /tmp/..., /private/...)
    .replace(/(?:\/(?:Users|home|root|private|var|tmp|etc|opt|usr)\/[^\s"':;,]+)/g, '[PATH]')
    // Redact Windows file paths (C:\Users\..., D:\...)
    .replace(/(?:[a-zA-Z]:\\[^\s"':;,]+)/g, '[PATH]');
}

/**
 * Recursively sanitizes error details objects to eliminate sensitive keys, values, and file paths.
 */
export function sanitizeErrorDetails(details: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(details)) {
    const lowerKey = k.toLowerCase();
    if (
      lowerKey.includes('token') ||
      lowerKey.includes('secret') ||
      lowerKey.includes('password') ||
      lowerKey.includes('key') ||
      lowerKey.includes('auth') ||
      lowerKey.includes('credential')
    ) {
      sanitized[k] = '***';
    } else if (typeof v === 'string') {
      sanitized[k] = sanitizeErrorMessage(v);
    } else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      sanitized[k] = sanitizeErrorDetails(v as Record<string, unknown>);
    } else {
      sanitized[k] = v;
    }
  }

  return sanitized;
}

/**
 * Sanitizes any error to ensure safe message and error code without leaking host system internals or credentials.
 */
export function sanitizeBrowserError(err: unknown): {
  message: string;
  code: BrowserErrorCode;
  details?: Record<string, unknown>;
} {
  if (isBrowserServiceError(err)) {
    return {
      message: sanitizeErrorMessage(err.message),
      code: err.code,
      details: sanitizeErrorDetails(err.details),
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  return {
    message: sanitizeErrorMessage(message),
    code: BrowserErrorCode.BROWSER_INTERNAL_ERROR,
  };
}
