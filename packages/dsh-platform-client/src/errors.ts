import {
  ProtocolError,
  ProtocolErrorCode,
  isErrorEnvelope,
  type ErrorDetail,
  type ErrorEnvelope,
} from '@enkeep/protocol';

/**
 * Maps standard HTTP status codes to ProtocolErrorCode.
 */
export function httpStatusToErrorCode(status: number): ProtocolErrorCode {
  switch (status) {
    case 400:
      return ProtocolErrorCode.BAD_REQUEST;
    case 401:
      return ProtocolErrorCode.UNAUTHORIZED;
    case 403:
      return ProtocolErrorCode.FORBIDDEN;
    case 404:
      return ProtocolErrorCode.NOT_FOUND;
    case 405:
      return ProtocolErrorCode.METHOD_NOT_ALLOWED;
    case 409:
      return ProtocolErrorCode.CONFLICT;
    case 413:
      return ProtocolErrorCode.PAYLOAD_TOO_LARGE;
    case 422:
      return ProtocolErrorCode.UNPROCESSABLE_ENTITY;
    case 429:
      return ProtocolErrorCode.RATE_LIMITED;
    case 408:
      return ProtocolErrorCode.REQUEST_TIMEOUT;
    case 500:
      return ProtocolErrorCode.INTERNAL_ERROR;
    case 501:
      return ProtocolErrorCode.NOT_IMPLEMENTED;
    case 502:
      return ProtocolErrorCode.SERVICE_UNAVAILABLE;
    case 503:
      return ProtocolErrorCode.SERVICE_UNAVAILABLE;
    case 504:
      return ProtocolErrorCode.GATEWAY_TIMEOUT;
    default:
      return status >= 500 ? ProtocolErrorCode.INTERNAL_ERROR : ProtocolErrorCode.BAD_REQUEST;
  }
}

/**
 * Base client error class.
 */
export class ClientError extends ProtocolError {
  constructor(params: {
    code: ProtocolErrorCode | string;
    message: string;
    status?: number;
    details?: readonly ErrorDetail[];
    retryable?: boolean;
    requestId?: string;
    cause?: unknown;
  }) {
    super(params);
    this.name = 'ClientError';
  }
}

/**
 * Thrown when a request times out.
 */
export class ClientTimeoutError extends ClientError {
  constructor(timeoutMs: number, requestId?: string) {
    super({
      code: ProtocolErrorCode.REQUEST_TIMEOUT,
      message: `Request timed out after ${timeoutMs}ms`,
      status: 408,
      retryable: true,
      requestId,
    });
    this.name = 'ClientTimeoutError';
  }
}

/**
 * Thrown when the client fails to connect to the Unix domain socket.
 */
export class ClientConnectionError extends ClientError {
  readonly socketPath: string;

  constructor(socketPath: string, message: string, cause?: unknown, requestId?: string) {
    super({
      code: ProtocolErrorCode.CONNECTION_REFUSED,
      message: `Failed to connect to UDS socket at "${socketPath}": ${message}`,
      status: 503,
      retryable: true,
      requestId,
      cause,
    });
    this.name = 'ClientConnectionError';
    this.socketPath = socketPath;
  }
}

/**
 * Thrown when response body exceeds maximum allowed bytes.
 */
export class ClientResponseTooLargeError extends ClientError {
  readonly sizeBytes: number;
  readonly maxBytes: number;

  constructor(sizeBytes: number, maxBytes: number, requestId?: string) {
    super({
      code: ProtocolErrorCode.PAYLOAD_TOO_LARGE,
      message: `Response size (${sizeBytes} bytes) exceeded maximum allowed limit of ${maxBytes} bytes`,
      status: 413,
      retryable: false,
      requestId,
    });
    this.name = 'ClientResponseTooLargeError';
    this.sizeBytes = sizeBytes;
    this.maxBytes = maxBytes;
  }
}

/**
 * Thrown when the server responds with a non-2xx HTTP status.
 */
export class ClientHttpError extends ClientError {
  readonly responseData?: unknown;
  readonly headers?: Record<string, string | string[] | undefined>;

  constructor(params: {
    status: number;
    message: string;
    code?: ProtocolErrorCode | string;
    details?: readonly ErrorDetail[];
    retryable?: boolean;
    requestId?: string;
    responseData?: unknown;
    headers?: Record<string, string | string[] | undefined>;
    cause?: unknown;
  }) {
    super({
      code: params.code ?? httpStatusToErrorCode(params.status),
      message: params.message,
      status: params.status,
      details: params.details,
      retryable: params.retryable ?? (params.status >= 500 || params.status === 429),
      requestId: params.requestId,
      cause: params.cause,
    });
    this.name = 'ClientHttpError';
    this.responseData = params.responseData;
    this.headers = params.headers;
  }

  /**
   * Helper to parse and create ClientHttpError from raw HTTP response.
   */
  static fromResponse(
    status: number,
    parsedBody: unknown,
    requestId?: string,
    headers?: Record<string, string | string[] | undefined>
  ): ClientHttpError {
    if (isErrorEnvelope(parsedBody)) {
      const err = parsedBody.error;
      return new ClientHttpError({
        status: err.status ?? status,
        code: err.code,
        message: err.message,
        details: err.details,
        retryable: err.retryable,
        requestId: err.requestId ?? requestId,
        responseData: parsedBody,
        headers,
      });
    }

    const message =
      typeof parsedBody === 'object' && parsedBody !== null && 'message' in parsedBody
        ? String((parsedBody as any).message)
        : `HTTP request failed with status ${status}`;

    return new ClientHttpError({
      status,
      message,
      requestId,
      responseData: parsedBody,
      headers,
    });
  }
}
