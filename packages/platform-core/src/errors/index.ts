export class PlatformError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = 'PLATFORM_ERROR', status = 500) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NotFoundError extends PlatformError {
  constructor(message: string, code = 'NOT_FOUND') {
    super(message, code, 404);
  }
}

export class UnauthorizedError extends PlatformError {
  constructor(message: string, code = 'UNAUTHORIZED') {
    super(message, code, 401);
  }
}

export class ForbiddenError extends PlatformError {
  constructor(message: string, code = 'FORBIDDEN') {
    super(message, code, 403);
  }
}

export class ConflictError extends PlatformError {
  constructor(message: string, code = 'CONFLICT') {
    super(message, code, 409);
  }
}

export class PermissionPresetRevisionMismatchError extends ConflictError {
  readonly currentRevision?: number;
  readonly expectedRevision?: number;

  constructor(message = 'Permission preset revision mismatch (optimistic concurrency conflict)', currentRevision?: number, expectedRevision?: number) {
    super(message, 'PERMISSION_PRESET_REVISION_MISMATCH');
    this.currentRevision = currentRevision;
    this.expectedRevision = expectedRevision;
  }
}

export class AccountDisabledError extends ForbiddenError {
  constructor(message = 'Account is disabled', code = 'ACCOUNT_DISABLED') {
    super(message, code);
  }
}

export class InvalidSessionError extends UnauthorizedError {
  constructor(message = 'Invalid session', code = 'INVALID_SESSION') {
    super(message, code);
  }
}

export class SessionExpiredError extends UnauthorizedError {
  constructor(message = 'Session has expired', code = 'SESSION_EXPIRED') {
    super(message, code);
  }
}

export class SessionRevokedError extends UnauthorizedError {
  constructor(message = 'Session has been revoked', code = 'SESSION_REVOKED') {
    super(message, code);
  }
}

export class TenantAccessDeniedError extends ForbiddenError {
  constructor(message = 'Access denied to tenant resource', code = 'TENANT_ACCESS_DENIED') {
    super(message, code);
  }
}

export class ValidationError extends PlatformError {
  readonly errors?: Record<string, string[]>;

  constructor(message: string, errors?: Record<string, string[]>, code = 'VALIDATION_ERROR') {
    super(message, code, 400);
    this.errors = errors;
  }
}

export class TooManyRequestsError extends PlatformError {
  constructor(message = 'Too many requests', code = 'RATE_LIMITED') {
    super(message, code, 429);
  }
}

export class RateLimitedError extends TooManyRequestsError {}

export class InvalidStateTransitionError extends PlatformError {
  readonly currentStatus: string;
  readonly targetStatus: string;

  constructor(currentStatus: string, targetStatus: string, message?: string) {
    super(
      message ?? `Invalid state transition from '${currentStatus}' to '${targetStatus}'`,
      'INVALID_STATE_TRANSITION',
      409
    );
    this.currentStatus = currentStatus;
    this.targetStatus = targetStatus;
  }
}

export class MigrationError extends PlatformError {
  constructor(message: string, code = 'MIGRATION_ERROR') {
    super(message, code, 500);
  }
}

export class MigrationDowngradeError extends MigrationError {
  readonly databaseVersion: number;
  readonly targetVersion: number;

  constructor(databaseVersion: number, targetVersion: number) {
    super(
      `Database schema version (${databaseVersion}) is newer than code schema version (${targetVersion}). Downgrade is rejected.`,
      'MIGRATION_DOWNGRADE_REJECTED'
    );
    this.databaseVersion = databaseVersion;
    this.targetVersion = targetVersion;
  }
}

export class MigrationChecksumMismatchError extends MigrationError {
  readonly version: number;
  readonly expectedChecksum: string;
  readonly actualChecksum: string;

  constructor(version: number, expectedChecksum: string, actualChecksum: string) {
    super(
      `Migration version ${version} checksum mismatch! Stored: ${expectedChecksum}, Current: ${actualChecksum}. Database may be tampered.`,
      'MIGRATION_CHECKSUM_MISMATCH'
    );
    this.version = version;
    this.expectedChecksum = expectedChecksum;
    this.actualChecksum = actualChecksum;
  }
}
