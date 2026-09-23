/**
 * Error classes and codes for CLI Tool Subsystem
 *
 * @module @enkeep/dsh-tool-cli/errors
 */

export class CliToolError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly details?: unknown;

  constructor(message: string, code = 'CLI_TOOL_ERROR', status = 500, details?: unknown) {
    super(message);
    this.name = 'CliToolError';
    this.code = code;
    this.status = status;
    this.details = details;
    Object.setPrototypeOf(this, CliToolError.prototype);
  }
}

/**
 * Thrown when a caller/model attempts to pass user-supplied `--config` arguments
 * to a bound Feishu CLI tool, which would override the tenant's bound identity.
 */
export class ConfigOverrideProhibitedError extends CliToolError {
  constructor(
    message = 'User-supplied --config argument is forbidden on bound Feishu CLI tool to protect tenant binding identity'
  ) {
    super(message, 'CONFIG_OVERRIDE_PROHIBITED', 400);
    this.name = 'ConfigOverrideProhibitedError';
  }
}

/**
 * Thrown when Feishu CLI scoped binding is requested in container mode.
 * The host-private config file is on host FS and not shared into container FS.
 */
export class ContainerSupportPendingError extends CliToolError {
  constructor(
    message = 'Feishu CLI scoped binding in container mode is pending: host-private config file is not shared across container boundary. Host mode required.'
  ) {
    super(message, 'CONTAINER_SUPPORT_PENDING', 501);
    this.name = 'ContainerSupportPendingError';
  }
}

/**
 * Thrown when tenant userId cannot be derived from context for bound execution.
 */
export class TenantContextMissingError extends CliToolError {
  constructor(
    message = 'Tenant userId could not be derived from context for bound Feishu CLI tool execution'
  ) {
    super(message, 'TENANT_CONTEXT_MISSING', 401);
    this.name = 'TenantContextMissingError';
  }
}

/**
 * Thrown when Feishu CLI tool execution is requested but no scoped configuration provider
 * is mounted or registered on the host platform service.
 */
export class ScopedConfigProviderUnavailableError extends CliToolError {
  constructor(
    message = 'No Lark/Feishu scoped configuration provider registered on host platform service'
  ) {
    super(message, 'SCOPED_CONFIG_PROVIDER_UNAVAILABLE', 503);
    this.name = 'ScopedConfigProviderUnavailableError';
  }
}

/**
 * Thrown when multiple active Feishu accounts are bound to the target space
 * without an explicit account selection (channelAccountId).
 */
export class LarkAmbiguousBoundAppError extends CliToolError {
  public readonly spaceId: string;
  public readonly userId: string;
  public readonly candidateAccountIds: readonly string[];

  constructor(
    message: string,
    spaceId: string,
    userId: string,
    candidateAccountIds: readonly string[] = []
  ) {
    super(message, 'LARK_AMBIGUOUS_BOUND_APP', 409, { spaceId, userId, candidateAccountIds });
    this.name = 'LarkAmbiguousBoundAppError';
    this.spaceId = spaceId;
    this.userId = userId;
    this.candidateAccountIds = candidateAccountIds;
  }
}

/**
 * Thrown when no active Feishu account is bound to the space/tenant.
 * Fail-closed: Never falls back to host ~/.feishu-cli.
 */
export class LarkBoundAppNotFoundError extends CliToolError {
  public readonly spaceId: string;
  public readonly userId: string;

  constructor(message: string, spaceId: string, userId: string) {
    super(message, 'LARK_BOUND_APP_NOT_FOUND', 404, { spaceId, userId });
    this.name = 'LarkBoundAppNotFoundError';
    this.spaceId = spaceId;
    this.userId = userId;
  }
}
