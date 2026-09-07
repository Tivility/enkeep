// Client implementation
export {
  DshPlatformClient,
  DEFAULT_CLIENT_CONFIG,
} from './client.js';

// Configuration and Request/Response Types
export type {
  HttpMethod,
  DshPlatformClientConfig,
  RequestOptions,
  ClientResponse,
} from './types.js';

// Specific Client Error Classes & Utilities
export {
  httpStatusToErrorCode,
  ClientError,
  ClientTimeoutError,
  ClientConnectionError,
  ClientResponseTooLargeError,
  ClientHttpError,
} from './errors.js';

// Retry and Idempotency Utilities
export {
  isDefaultIdempotentMethod,
  isRequestRetryable,
  isTransientError,
  calculateBackoff,
  parseRetryAfterHeader,
} from './retry.js';
