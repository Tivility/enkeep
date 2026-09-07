/**
 * MCP Protocol and Service Error Definitions
 *
 * Strict error taxonomy for Host MCP Manager and PlatformProxy MCP bridge.
 * Invariant: Never expose raw downstream MCP crash strings, internal paths,
 * or decrypted credential values to the public agent interface.
 *
 * @module @enkeep/platform-service-mcp/errors
 */

export const McpErrorCode = {
  // Client/Argument errors (4xx)
  MCP_BAD_REQUEST: 'MCP_BAD_REQUEST',
  MCP_UNAUTHORIZED: 'MCP_UNAUTHORIZED',
  MCP_FORBIDDEN: 'MCP_FORBIDDEN',
  MCP_APPROVAL_REQUIRED: 'MCP_APPROVAL_REQUIRED',
  MCP_SERVER_NOT_FOUND: 'MCP_SERVER_NOT_FOUND',
  MCP_TOOL_NOT_FOUND: 'MCP_TOOL_NOT_FOUND',
  MCP_INVALID_ARGUMENTS: 'MCP_INVALID_ARGUMENTS',
  MCP_PAYLOAD_TOO_LARGE: 'MCP_PAYLOAD_TOO_LARGE',
  MCP_OUTPUT_TOO_LARGE: 'MCP_OUTPUT_TOO_LARGE',

  // Policy & Security violations (403)
  MCP_SPAWN_FORBIDDEN: 'MCP_SPAWN_FORBIDDEN',
  MCP_SSRF_BLOCKED: 'MCP_SSRF_BLOCKED',
  MCP_ENV_VIOLATION: 'MCP_ENV_VIOLATION',

  // Server & Lifecycle errors (5xx)
  MCP_INITIALIZE_FAILED: 'MCP_INITIALIZE_FAILED',
  MCP_SERVER_UNAVAILABLE: 'MCP_SERVER_UNAVAILABLE',
  MCP_TOOL_EXECUTION_FAILED: 'MCP_TOOL_EXECUTION_FAILED',
  MCP_TOOL_TIMEOUT: 'MCP_TOOL_TIMEOUT',
  MCP_TOOL_CANCELLED: 'MCP_TOOL_CANCELLED',
  MCP_CIRCUIT_OPEN: 'MCP_CIRCUIT_OPEN',
  MCP_RATE_LIMITED: 'MCP_RATE_LIMITED',
  MCP_PROCESS_LIMIT_EXCEEDED: 'MCP_PROCESS_LIMIT_EXCEEDED',
  MCP_INTERNAL_ERROR: 'MCP_INTERNAL_ERROR',
} as const;

export type McpErrorCode = (typeof McpErrorCode)[keyof typeof McpErrorCode];

export interface McpErrorOptions {
  code: McpErrorCode;
  httpStatus?: number;
  retryable?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}

/**
 * Standard sanitized error thrown across MCP boundaries.
 */
export class McpServiceError extends Error {
  readonly code: McpErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  readonly isMcpServiceError = true;

  constructor(message: string, options: McpErrorOptions) {
    super(message, { cause: options.cause });
    this.name = 'McpServiceError';
    this.code = options.code;
    this.httpStatus = options.httpStatus ?? defaultHttpStatus(options.code);
    this.retryable = options.retryable ?? defaultRetryable(options.code);
    this.details = options.details;
  }

  toJSON(): {
    code: McpErrorCode;
    message: string;
    status: number;
    retryable: boolean;
    details?: Record<string, unknown>;
  } {
    return {
      code: this.code,
      message: this.message,
      status: this.httpStatus,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

export function isMcpServiceError(value: unknown): value is McpServiceError {
  return typeof value === 'object' && value !== null && (value as any).isMcpServiceError === true;
}

function defaultHttpStatus(code: McpErrorCode): number {
  switch (code) {
    case McpErrorCode.MCP_BAD_REQUEST:
    case McpErrorCode.MCP_INVALID_ARGUMENTS:
      return 400;
    case McpErrorCode.MCP_UNAUTHORIZED:
      return 401;
    case McpErrorCode.MCP_FORBIDDEN:
    case McpErrorCode.MCP_APPROVAL_REQUIRED:
    case McpErrorCode.MCP_SPAWN_FORBIDDEN:
    case McpErrorCode.MCP_SSRF_BLOCKED:
    case McpErrorCode.MCP_ENV_VIOLATION:
      return 403;
    case McpErrorCode.MCP_SERVER_NOT_FOUND:
    case McpErrorCode.MCP_TOOL_NOT_FOUND:
      return 404;
    case McpErrorCode.MCP_PAYLOAD_TOO_LARGE:
    case McpErrorCode.MCP_OUTPUT_TOO_LARGE:
      return 413;
    case McpErrorCode.MCP_RATE_LIMITED:
    case McpErrorCode.MCP_PROCESS_LIMIT_EXCEEDED:
      return 429;
    case McpErrorCode.MCP_TOOL_CANCELLED:
      return 499;
    case McpErrorCode.MCP_TOOL_TIMEOUT:
      return 504;
    case McpErrorCode.MCP_CIRCUIT_OPEN:
    case McpErrorCode.MCP_SERVER_UNAVAILABLE:
    case McpErrorCode.MCP_INITIALIZE_FAILED:
      return 503;
    case McpErrorCode.MCP_TOOL_EXECUTION_FAILED:
    case McpErrorCode.MCP_INTERNAL_ERROR:
    default:
      return 500;
  }
}

function defaultRetryable(code: McpErrorCode): boolean {
  switch (code) {
    case McpErrorCode.MCP_TOOL_TIMEOUT:
    case McpErrorCode.MCP_SERVER_UNAVAILABLE:
    case McpErrorCode.MCP_RATE_LIMITED:
      return true;
    default:
      return false;
  }
}

/**
 * Sanitizes any raw exception into a clean McpServiceError without exposing internal stack/tokens.
 */
export function sanitizeMcpError(err: unknown, fallbackMessage = 'MCP operation failed'): McpServiceError {
  if (isMcpServiceError(err)) {
    return err;
  }

  const rawMessage = err instanceof Error ? err.message : String(err);

  // Match known patterns
  if (/timeout|timed out/i.test(rawMessage)) {
    return new McpServiceError('MCP operation timed out', {
      code: McpErrorCode.MCP_TOOL_TIMEOUT,
      cause: err,
    });
  }

  if (/abort|cancel/i.test(rawMessage)) {
    return new McpServiceError('MCP operation cancelled', {
      code: McpErrorCode.MCP_TOOL_CANCELLED,
      cause: err,
    });
  }

  if (/ssrf|private ip|forbidden host|loopback/i.test(rawMessage)) {
    return new McpServiceError('MCP network access denied by SSRF security policy', {
      code: McpErrorCode.MCP_SSRF_BLOCKED,
      cause: err,
    });
  }

  if (/spawn|executable|not allowlisted/i.test(rawMessage)) {
    return new McpServiceError('MCP process spawn rejected by security policy', {
      code: McpErrorCode.MCP_SPAWN_FORBIDDEN,
      cause: err,
    });
  }

  if (/circuit/i.test(rawMessage)) {
    return new McpServiceError('MCP server circuit breaker open', {
      code: McpErrorCode.MCP_CIRCUIT_OPEN,
      cause: err,
    });
  }

  return new McpServiceError(fallbackMessage, {
    code: McpErrorCode.MCP_INTERNAL_ERROR,
    cause: err,
  });
}
