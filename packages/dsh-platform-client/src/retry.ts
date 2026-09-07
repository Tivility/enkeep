import { ProtocolError } from '@enkeep/protocol';
import { ClientConnectionError, ClientHttpError, ClientTimeoutError } from './errors.js';
import type { HttpMethod, RequestOptions } from './types.js';

/**
 * Standard idempotent HTTP methods according to RFC 9110.
 */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);

/**
 * Check if an HTTP method is considered idempotent by default.
 */
export function isDefaultIdempotentMethod(method: HttpMethod | string): boolean {
  return IDEMPOTENT_METHODS.has(method.toUpperCase());
}

/**
 * Determine if a specific request is allowed to be retried based on idempotency rules.
 */
export function isRequestRetryable(method: string, options?: RequestOptions): boolean {
  if (options?.idempotent !== undefined) {
    return options.idempotent;
  }
  return isDefaultIdempotentMethod(method);
}

/**
 * Transient status codes that warrant retry on idempotent requests.
 */
const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);

/**
 * System error codes that represent transient network/socket connection issues.
 */
const RETRYABLE_SYSTEM_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOENT', // socket file might briefly not exist during server restart
  'EADDRINUSE',
]);

/**
 * Check if a thrown error or failed response is transient and retryable.
 */
export function isTransientError(error: unknown): boolean {
  if (!error) return false;

  // If error has explicit retryable flag from ProtocolError
  if (error instanceof ProtocolError) {
    if (error instanceof ClientTimeoutError || error instanceof ClientConnectionError) {
      return true;
    }
    if (error instanceof ClientHttpError) {
      return RETRYABLE_HTTP_STATUSES.has(error.status) || error.retryable === true;
    }
    return error.retryable;
  }

  // System error codes on Node.js Error objects
  const nodeErr = error as NodeJS.ErrnoException;
  if (nodeErr.code && RETRYABLE_SYSTEM_CODES.has(nodeErr.code)) {
    return true;
  }

  // Message inspections for common socket errors
  const message = (error as Error).message || '';
  if (
    message.includes('socket hang up') ||
    message.includes('ECONNREFUSED') ||
    message.includes('ECONNRESET') ||
    message.includes('ETIMEDOUT')
  ) {
    return true;
  }

  return false;
}

/**
 * Calculate exponential backoff delay with jitter.
 */
export function calculateBackoff(
  attempt: number,
  initialDelayMs: number = 100,
  maxDelayMs: number = 2000
): number {
  const base = initialDelayMs * Math.pow(2, attempt);
  const capped = Math.min(base, maxDelayMs);
  // Full jitter: between 50% and 100% of the calculated interval
  const jitterFactor = 0.5 + Math.random() * 0.5;
  return Math.floor(capped * jitterFactor);
}

/**
 * Extract retry delay from 'retry-after' header if present (in ms), or null.
 */
export function parseRetryAfterHeader(headers?: Record<string, string | string[] | undefined>): number | null {
  if (!headers) return null;
  const raw = headers['retry-after'] ?? headers['Retry-After'];
  if (!raw) return null;

  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;

  const seconds = Number(value);
  if (!isNaN(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 30_000); // capped at 30s
  }

  const dateMs = Date.parse(value);
  if (!isNaN(dateMs)) {
    const delay = dateMs - Date.now();
    return delay > 0 ? Math.min(delay, 30_000) : 0;
  }

  return null;
}

/**
 * Sleep promise supporting cancellation via AbortSignal.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new Error('Operation aborted during backoff delay'));
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    function onAbort() {
      cleanup();
      reject(new Error('Operation aborted during backoff delay'));
    }

    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
