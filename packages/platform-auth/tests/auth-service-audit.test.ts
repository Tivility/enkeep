import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSqliteStorage, SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import {
  DefaultAuthService,
  hashPassword,
  hashToken,
} from '../src/index.js';
import {
  UnauthorizedError,
} from '@enkeep/platform-core';

describe('AuthService and Audit Logging', () => {
  let storage: SqlitePlatformStorage;
  let authService: DefaultAuthService;
  const cookieSecret = 'test-secret-key-that-is-at-least-32-chars-long';

  beforeEach(async () => {
    storage = await createSqliteStorage({ dbPath: ':memory:' });
    authService = new DefaultAuthService(storage, {
      cookieSecret,
      sessionTtlSeconds: 3600,
      cookieSecure: false,
    });
  });

  afterEach(async () => {
    await storage.close();
  });

  it('records audit log without session ID and succeeds on valid login', async () => {
    const passwordHash = await hashPassword('ValidPass123!');
    const user = await storage.users.create({
      username: 'alice',
      passwordHash,
      role: 'admin',
    });

    const result = await authService.login('alice', 'ValidPass123!', {
      ipAddress: '192.168.1.100',
      userAgent: 'Mozilla/5.0 TestBrowser',
    });

    expect(result.user.id).toBe(user.id);
    expect(result.session.id).toBeDefined();
    expect(result.cookieHeader).toContain('enkeep_session=');

    // Verify audit log entry: details must NOT contain sessionId
    const auditLogs = await storage.auditLogs.listByUserId(user.id);
    expect(auditLogs.length).toBe(1);
    expect(auditLogs[0].action).toBe('login_success');
    expect(auditLogs[0].ipAddress).toBe('192.168.1.100');
    expect(auditLogs[0].userAgent).toBe('Mozilla/5.0 TestBrowser');
    expect(auditLogs[0].details).toBeNull();
  });

  it('records audit log and rejects wrong password with unified UnauthorizedError', async () => {
    const passwordHash = await hashPassword('ValidPass123!');
    const user = await storage.users.create({
      username: 'alice',
      passwordHash,
      role: 'admin',
    });

    let thrownError: unknown;
    try {
      await authService.login('alice', 'WrongPassword!', { ipAddress: '10.0.0.1' });
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(UnauthorizedError);
    expect((thrownError as UnauthorizedError).message).toBe('Invalid username or password');

    // Verify failure audit log: known user records userId and username
    const auditLogs = await storage.auditLogs.listByUserId(user.id);
    expect(auditLogs.length).toBe(1);
    expect(auditLogs[0].action).toBe('login_failure');
    expect(auditLogs[0].details).toEqual({ reason: 'invalid_password' });
  });

  it('records audit log with null username/userId and NEVER stores attempted unknown username to prevent PII/credential leakage', async () => {
    const sensitiveAttemptedUsername = 'SecretPasswordMistypedIntoUsernameField!';
    let thrownError: unknown;
    try {
      await authService.login(sensitiveAttemptedUsername, 'SomePass123!', { ipAddress: '10.0.0.2' });
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(UnauthorizedError);
    expect((thrownError as UnauthorizedError).message).toBe('Invalid username or password');

    const auditLogs = await storage.auditLogs.listRecent({ action: 'login_failure' });
    expect(auditLogs.length).toBe(1);
    // Explicitly verify attempted unknown username is NEVER stored in username column or details
    expect(auditLogs[0].username).toBeNull();
    expect(auditLogs[0].userId).toBeNull();
    expect(auditLogs[0].details).toEqual({ reason: 'user_not_found' });

    // Verify raw secret string is nowhere in the audit log JSON
    const auditJson = JSON.stringify(auditLogs[0]);
    expect(auditJson).not.toContain(sensitiveAttemptedUsername);
  });

  it('strictly validates input bounds and executes dummy timing verification on invalid inputs', async () => {
    const verifySpy = vi.spyOn(authService, 'verifyPassword');

    // Control characters in username
    await expect(authService.login('bad\x00user', 'Pass123!')).rejects.toThrow(UnauthorizedError);
    expect(verifySpy).toHaveBeenCalled();

    // Oversized username (>128 chars)
    const longUser = 'u'.repeat(129);
    await expect(authService.login(longUser, 'Pass123!')).rejects.toThrow(UnauthorizedError);

    // Empty username
    await expect(authService.login('', 'Pass123!')).rejects.toThrow(UnauthorizedError);

    // Empty password
    await expect(authService.login('valid_user', '')).rejects.toThrow(UnauthorizedError);

    // Oversized password (>1024 bytes)
    const hugePassword = 'p'.repeat(1025);
    await expect(authService.login('valid_user', hugePassword)).rejects.toThrow(UnauthorizedError);

    // Verify all invalid input failure audit logs set username to null
    const recentLogs = await storage.auditLogs.listRecent({ action: 'login_failure' });
    for (const log of recentLogs) {
      expect(log.username).toBeNull();
      expect(log.userId).toBeNull();
    }
  });

  it('preserves spaces in password without trimming', async () => {
    const passwordWithSpaces = '  my secret password with spaces  ';
    const passwordHash = await hashPassword(passwordWithSpaces);
    const user = await storage.users.create({
      username: 'spaces_user',
      passwordHash,
      role: 'user',
    });

    const result = await authService.login('spaces_user', passwordWithSpaces);
    expect(result.user.id).toBe(user.id);
    expect(result.session.id).toBeDefined();

    // Trying without spaces fails
    await expect(authService.login('spaces_user', passwordWithSpaces.trim())).rejects.toThrow(
      UnauthorizedError
    );
  });

  it('sanitizes unbounded IP and userAgent headers in audit log context', async () => {
    const passwordHash = await hashPassword('ValidPass123!');
    const user = await storage.users.create({
      username: 'alice_context',
      passwordHash,
      role: 'admin',
    });

    // Valid bounds
    await authService.login('alice_context', 'ValidPass123!', {
      ipAddress: '127.0.0.1',
      userAgent: 'ValidUserAgent/1.0',
    });

    let logs = await storage.auditLogs.listByUserId(user.id);
    expect(logs[0].ipAddress).toBe('127.0.0.1');
    expect(logs[0].userAgent).toBe('ValidUserAgent/1.0');

    // Malicious / control chars / overlong context
    await authService.login('alice_context', 'ValidPass123!', {
      ipAddress: '127.0.0.1\x00malicious_crlf',
      userAgent: 'a'.repeat(600), // exceeds 512 max length
    });

    logs = await storage.auditLogs.listByUserId(user.id);
    expect(logs[0].ipAddress).toBeNull();
    expect(logs[0].userAgent).toBeNull();
  });

  it('records audit log and rejects disabled account login with unified UnauthorizedError', async () => {
    const passwordHash = await hashPassword('DisabledPass123!');
    const user = await storage.users.create({
      username: 'charlie',
      passwordHash,
      role: 'user',
      status: 'disabled',
    });

    let thrownError: unknown;
    try {
      await authService.login('charlie', 'DisabledPass123!', { ipAddress: '10.0.0.3' });
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(UnauthorizedError);
    expect((thrownError as UnauthorizedError).message).toBe('Invalid username or password');

    const auditLogs = await storage.auditLogs.listByUserId(user.id);
    expect(auditLogs.length).toBe(1);
    expect(auditLogs[0].action).toBe('account_disabled');
    expect(auditLogs[0].details).toEqual({ reason: 'account_disabled_at_login' });
  });

  it('ensures unknown, wrong password, and disabled login errors are deeply identical outward', async () => {
    const passwordHash = await hashPassword('KnownPass123!');
    await storage.users.create({
      username: 'active_user',
      passwordHash,
      role: 'user',
      status: 'active',
    });
    await storage.users.create({
      username: 'disabled_user',
      passwordHash,
      role: 'user',
      status: 'disabled',
    });

    let errUnknown: any;
    let errWrongPass: any;
    let errDisabled: any;

    try {
      await authService.login('unknown_user', 'KnownPass123!');
    } catch (e) {
      errUnknown = e;
    }

    try {
      await authService.login('active_user', 'WrongPass123!');
    } catch (e) {
      errWrongPass = e;
    }

    try {
      await authService.login('disabled_user', 'KnownPass123!');
    } catch (e) {
      errDisabled = e;
    }

    expect(errUnknown).toBeInstanceOf(UnauthorizedError);
    expect(errWrongPass).toBeInstanceOf(UnauthorizedError);
    expect(errDisabled).toBeInstanceOf(UnauthorizedError);

    expect(errUnknown.message).toBe('Invalid username or password');
    expect(errWrongPass.message).toBe('Invalid username or password');
    expect(errDisabled.message).toBe('Invalid username or password');

    expect(errUnknown.statusCode).toEqual(errWrongPass.statusCode);
    expect(errUnknown.statusCode).toEqual(errDisabled.statusCode);
  });

  it('returns unified {authenticated:false, error:"Invalid session"} across all cookie/token failure paths', async () => {
    const expectedErrorResult = { authenticated: false, error: 'Invalid session' };

    // 1. Missing cookie header
    expect(await authService.authenticateCookie('')).toEqual(expectedErrorResult);

    // 2. Tampered cookie
    expect(await authService.authenticateCookie('enkeep_session=invalid.tampered.cookie')).toEqual(
      expectedErrorResult
    );

    // 3. Non-existent session
    expect(await authService.authenticateToken('non-existent-session-id', 'some-token')).toEqual(
      expectedErrorResult
    );

    // 4. Revoked session
    const passwordHash = await hashPassword('UserPass123!');
    const user = await storage.users.create({
      username: 'test_user',
      passwordHash,
      role: 'user',
      status: 'active',
    });

    const token1 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const tokenHash1 = hashToken(token1);
    const revokedSession = await storage.sessions.create({
      userId: user.id,
      tokenHash: tokenHash1,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });

    await storage.sessions.revoke(revokedSession.id);
    expect(await authService.authenticateToken(revokedSession.id, token1)).toEqual(expectedErrorResult);

    // 5. Expired session
    const token2 = '1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const tokenHash2 = hashToken(token2);
    const expiredSession = await storage.sessions.create({
      userId: user.id,
      tokenHash: tokenHash2,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(await authService.authenticateToken(expiredSession.id, token2)).toEqual(expectedErrorResult);

    // 6. Invalid token
    const token3 = '2123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const tokenHash3 = hashToken(token3);
    const freshSession = await storage.sessions.create({
      userId: user.id,
      tokenHash: tokenHash3,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    expect(await authService.authenticateToken(freshSession.id, 'wrong-token-value')).toEqual(
      expectedErrorResult
    );

    // 7. Malformed token / non-hex or odd length
    expect(await authService.authenticateToken(freshSession.id, '')).toEqual(expectedErrorResult);
    // @ts-expect-error test non-string
    expect(await authService.authenticateToken(freshSession.id, null)).toEqual(expectedErrorResult);
    // @ts-expect-error test non-string
    expect(await authService.authenticateToken(null, token3)).toEqual(expectedErrorResult);

    // 8. User deleted / missing in storage (simulated by mocking user lookup)
    const findUserSpy = vi.spyOn(storage.users, 'findById').mockResolvedValueOnce(null as any);
    expect(await authService.authenticateToken(freshSession.id, token3)).toEqual(expectedErrorResult);
    findUserSpy.mockRestore();

    // 9. Disabled user: must NOT return user or session object
    await storage.users.update(user.id, { status: 'disabled' });
    const disabledAuthResult = await authService.authenticateToken(freshSession.id, token3);
    expect(disabledAuthResult).toEqual(expectedErrorResult);
    expect((disabledAuthResult as any).user).toBeUndefined();
    expect((disabledAuthResult as any).session).toBeUndefined();

    // Audit log should still record account_disabled without sessionId
    const auditLogs = await storage.auditLogs.listByUserId(user.id);
    const disabledLogs = auditLogs.filter((l) => l.action === 'account_disabled');
    expect(disabledLogs.length).toBe(1);
    expect(disabledLogs[0].details).toEqual({
      reason: 'account_disabled_during_session_auth',
    });
  });

  it('revokes session on logout and logs audit record without sessionId in details', async () => {
    const passwordHash = await hashPassword('UserPass123!');
    const user = await storage.users.create({
      username: 'eve',
      passwordHash,
      role: 'user',
    });

    const loginResult = await authService.login('eve', 'UserPass123!');

    await authService.logout(loginResult.session.id, { ipAddress: '192.168.1.50' });

    const sessionInDb = await storage.sessions.findById(loginResult.session.id);
    expect(sessionInDb?.revokedAt).not.toBeNull();

    // Authenticating after logout returns unified { authenticated: false, error: 'Invalid session' }
    const authAfterLogout = await authService.authenticateCookie(loginResult.cookieHeader);
    expect(authAfterLogout).toEqual({ authenticated: false, error: 'Invalid session' });

    const auditLogs = await storage.auditLogs.listByUserId(user.id);
    const logoutLogs = auditLogs.filter((l) => l.action === 'session_revoked');
    expect(logoutLogs.length).toBe(1);
    expect(logoutLogs[0].details).toBeNull();
  });
});
