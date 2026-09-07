import { describe, it, expect } from 'vitest';
import {
  PlatformError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  AccountDisabledError,
  TenantAccessDeniedError,
  MigrationError,
  MigrationDowngradeError,
  MigrationChecksumMismatchError,
  InvalidSessionError,
  SessionExpiredError,
  SessionRevokedError,
  ValidationError,
} from '../src/index.js';

describe('platform-core errors', () => {
  it('instantiates PlatformError with defaults and inheritance', () => {
    const err = new PlatformError('Something failed');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.name).toBe('PlatformError');
    expect(err.message).toBe('Something failed');
    expect(err.code).toBe('PLATFORM_ERROR');
    expect(err.status).toBe(500);
  });

  it('instantiates NotFoundError with 404', () => {
    const err = new NotFoundError('Item not found');
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.status).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
  });

  it('instantiates UnauthorizedError and session errors with 401', () => {
    const unauth = new UnauthorizedError('Unauthorized');
    expect(unauth.status).toBe(401);

    const invalidSession = new InvalidSessionError();
    expect(invalidSession).toBeInstanceOf(UnauthorizedError);
    expect(invalidSession.status).toBe(401);
    expect(invalidSession.code).toBe('INVALID_SESSION');

    const expiredSession = new SessionExpiredError();
    expect(expiredSession).toBeInstanceOf(UnauthorizedError);
    expect(expiredSession.status).toBe(401);
    expect(expiredSession.code).toBe('SESSION_EXPIRED');

    const revokedSession = new SessionRevokedError();
    expect(revokedSession).toBeInstanceOf(UnauthorizedError);
    expect(revokedSession.status).toBe(401);
    expect(revokedSession.code).toBe('SESSION_REVOKED');
  });

  it('instantiates ForbiddenError, AccountDisabledError, TenantAccessDeniedError with 403', () => {
    const forbidden = new ForbiddenError('Forbidden');
    expect(forbidden.status).toBe(403);

    const disabled = new AccountDisabledError();
    expect(disabled).toBeInstanceOf(ForbiddenError);
    expect(disabled.status).toBe(403);
    expect(disabled.code).toBe('ACCOUNT_DISABLED');

    const tenantDenied = new TenantAccessDeniedError();
    expect(tenantDenied).toBeInstanceOf(ForbiddenError);
    expect(tenantDenied.status).toBe(403);
    expect(tenantDenied.code).toBe('TENANT_ACCESS_DENIED');
  });

  it('instantiates ValidationError with errors map', () => {
    const valErr = new ValidationError('Invalid input', { username: ['Required'] });
    expect(valErr.status).toBe(400);
    expect(valErr.errors).toEqual({ username: ['Required'] });
  });

  it('instantiates MigrationDowngradeError with version metadata', () => {
    const err = new MigrationDowngradeError(5, 3);
    expect(err).toBeInstanceOf(MigrationError);
    expect(err.code).toBe('MIGRATION_DOWNGRADE_REJECTED');
    expect(err.databaseVersion).toBe(5);
    expect(err.targetVersion).toBe(3);
    expect(err.message).toContain('version (5) is newer than code schema version (3)');
  });

  it('instantiates MigrationChecksumMismatchError with checksum metadata', () => {
    const err = new MigrationChecksumMismatchError(1, 'stored-sha', 'actual-sha');
    expect(err).toBeInstanceOf(MigrationError);
    expect(err.code).toBe('MIGRATION_CHECKSUM_MISMATCH');
    expect(err.version).toBe(1);
    expect(err.expectedChecksum).toBe('stored-sha');
    expect(err.actualChecksum).toBe('actual-sha');
    expect(err.message).toContain('checksum mismatch');
  });
});
