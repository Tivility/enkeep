/**
 * Standard protocol error codes across Enkeep container-platform boundary.
 */
export const ProtocolErrorCode = {
  // Client errors (4xx equivalent)
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNPROCESSABLE_ENTITY: 'UNPROCESSABLE_ENTITY',
  RATE_LIMITED: 'RATE_LIMITED',
  REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',

  // Server errors (5xx equivalent)
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  GATEWAY_TIMEOUT: 'GATEWAY_TIMEOUT',

  // Transport / Wire errors
  TRANSPORT_ERROR: 'TRANSPORT_ERROR',
  CONNECTION_REFUSED: 'CONNECTION_REFUSED',
  PROTOCOL_VIOLATION: 'PROTOCOL_VIOLATION',
  PARSE_ERROR: 'PARSE_ERROR',
} as const;

export type ProtocolErrorCode = (typeof ProtocolErrorCode)[keyof typeof ProtocolErrorCode];

/**
 * Structured details object for standard errors.
 */
export interface ErrorDetail {
  readonly path?: string;
  readonly message: string;
  readonly code?: string;
  readonly [key: string]: unknown;
}

/**
 * Standard Error Payload embedded in the wire error envelope.
 */
export interface ErrorPayload {
  readonly code: ProtocolErrorCode | string;
  readonly message: string;
  readonly status?: number;
  readonly details?: readonly ErrorDetail[];
  readonly retryable?: boolean;
  readonly timestamp?: string;
  readonly requestId?: string;
}

/**
 * Standard Error Envelope for wire responses.
 */
export interface ErrorEnvelope {
  readonly success: false;
  readonly error: ErrorPayload;
}

/**
 * Standard Success Envelope for wire responses.
 */
export interface SuccessEnvelope<T = unknown> {
  readonly success: true;
  readonly data: T;
  readonly meta?: {
    readonly requestId?: string;
    readonly timestamp?: string;
    readonly [key: string]: unknown;
  };
}

/**
 * Standard API Result envelope (either success or error).
 */
export type ApiEnvelope<T = unknown> = SuccessEnvelope<T> | ErrorEnvelope;

/**
 * Type guard to check if an envelope is an ErrorEnvelope.
 */
export function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return candidate['success'] === false && typeof candidate['error'] === 'object' && candidate['error'] !== null;
}

/**
 * Type guard to check if an envelope is a SuccessEnvelope.
 */
export function isSuccessEnvelope<T = unknown>(value: unknown): value is SuccessEnvelope<T> {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return candidate['success'] === true && 'data' in candidate;
}

/**
 * Factory to create a standard success envelope.
 */
export function createSuccessEnvelope<T>(data: T, meta?: SuccessEnvelope<T>['meta']): SuccessEnvelope<T> {
  return {
    success: true,
    data,
    ...(meta ? { meta } : {}),
  };
}

/**
 * Factory to create a standard error envelope.
 */
export function createErrorEnvelope(
  paramsOrCode:
    | {
        code: ProtocolErrorCode | string;
        message: string;
        status?: number;
        details?: readonly ErrorDetail[];
        retryable?: boolean;
        requestId?: string;
      }
    | (ProtocolErrorCode | string),
  message?: string,
  details?: readonly ErrorDetail[]
): ErrorEnvelope {
  if (typeof paramsOrCode === 'object' && paramsOrCode !== null) {
    return {
      success: false,
      error: {
        code: paramsOrCode.code,
        message: paramsOrCode.message,
        status: paramsOrCode.status,
        details: paramsOrCode.details,
        retryable: paramsOrCode.retryable,
        requestId: paramsOrCode.requestId,
        timestamp: new Date().toISOString(),
      },
    };
  }
  return {
    success: false,
    error: {
      code: paramsOrCode,
      message: message || '',
      details,
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Standard Protocol Exception class.
 */
export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode | string;
  readonly status: number;
  readonly details?: readonly ErrorDetail[];
  readonly retryable: boolean;
  readonly requestId?: string;

  constructor(params: {
    code: ProtocolErrorCode | string;
    message: string;
    status?: number;
    details?: readonly ErrorDetail[];
    retryable?: boolean;
    requestId?: string;
    cause?: unknown;
  }) {
    super(params.message, { cause: params.cause });
    this.name = 'ProtocolError';
    this.code = params.code;
    this.status = params.status ?? 500;
    this.details = params.details;
    this.retryable = params.retryable ?? (this.status >= 500 || this.status === 429);
    this.requestId = params.requestId;
  }

  toEnvelope(): ErrorEnvelope {
    return createErrorEnvelope({
      code: this.code,
      message: this.message,
      status: this.status,
      details: this.details,
      retryable: this.retryable,
      requestId: this.requestId,
    });
  }

  static fromEnvelope(envelope: ErrorEnvelope): ProtocolError {
    const err = envelope.error;
    return new ProtocolError({
      code: err.code,
      message: err.message,
      status: err.status,
      details: err.details,
      retryable: err.retryable,
      requestId: err.requestId,
    });
  }
}
