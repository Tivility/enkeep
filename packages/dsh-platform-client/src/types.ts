import type { RequestId } from '@enkeep/protocol';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/**
 * Configuration options for the DSH Platform HTTP-over-UDS Client.
 */
export interface DshPlatformClientConfig {
  /**
   * Base URL for the platform service HTTP endpoint (e.g. 'http://127.0.0.1:8787/platform').
   */
  readonly baseURL?: string;
  readonly baseUrl?: string;

  /**
   * Path to the Unix Domain Socket where the platform service is listening (for backwards compatibility).
   */
  readonly socketPath?: string;

  /**
   * Static bearer token or a synchronous/asynchronous token provider function.
   */
  readonly bearerToken?: string | (() => string | Promise<string>);

  /**
   * Default timeout in milliseconds for each request (default: 10,000ms).
   */
  readonly timeoutMs?: number;

  /**
   * Maximum retry attempts for idempotent requests on retryable failures (default: 3).
   * Non-idempotent requests (e.g. POST) are not retried unless explicitly configured in RequestOptions.
   */
  readonly maxRetries?: number;

  /**
   * Initial backoff delay in milliseconds for retries (default: 100ms).
   */
  readonly retryInitialDelayMs?: number;

  /**
   * Maximum backoff delay in milliseconds for retries (default: 2,000ms).
   */
  readonly retryMaxDelayMs?: number;

  /**
   * Maximum allowed response body size in bytes (default: 4 MB).
   */
  readonly maxResponseBodyBytes?: number;

  /**
   * Default HTTP headers sent with every request.
   */
  readonly defaultHeaders?: Record<string, string>;
}

/**
 * Options for a single client request.
 */
export interface RequestOptions {
  /**
   * HTTP method (e.g. 'GET', 'POST', 'PUT', 'DELETE'). Defaults to 'GET'.
   */
  readonly method?: HttpMethod | string;

  /**
   * Query parameters to append to the request path.
   */
  readonly query?: Record<string, string | number | boolean | undefined | null>;

  /**
   * Request headers.
   */
  readonly headers?: Record<string, string | undefined>;

  /**
   * JSON payload to serialize and send as the request body.
   */
  readonly body?: unknown;

  /**
   * Raw string or Buffer payload (takes precedence over body if provided).
   */
  readonly rawBody?: string | Buffer;

  /**
   * Request timeout in milliseconds (overrides client default).
   */
  readonly timeoutMs?: number;

  /**
   * Maximum retries for this request (overrides client default).
   */
  readonly maxRetries?: number;

  /**
   * Explicitly declare this request as idempotent (or non-idempotent).
   * By default, GET, HEAD, PUT, DELETE, and OPTIONS are considered idempotent.
   */
  readonly idempotent?: boolean;

  /**
   * Custom request ID. If omitted, a random UUID is generated.
   */
  readonly requestId?: RequestId | string;

  /**
   * External AbortSignal to cancel the request.
   */
  readonly signal?: AbortSignal;

  /**
   * Maximum allowed response body size in bytes (overrides client default).
   */
  readonly maxResponseBodyBytes?: number;
}

/**
 * Standard client response wrapper.
 */
export interface ClientResponse<T = unknown> {
  /**
   * HTTP status code (e.g. 200, 201, 204).
   */
  readonly status: number;

  /**
   * Response HTTP headers.
   */
  readonly headers: Record<string, string | string[] | undefined>;

  /**
   * Parsed response data (parsed via strictJsonParse if response is JSON, otherwise string or buffer).
   */
  readonly data: T;

  /**
   * Raw response buffer.
   */
  readonly rawBody: Buffer;

  /**
   * Request ID associated with this operation.
   */
  readonly requestId: string;
}
