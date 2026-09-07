import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteStorage, SqlitePlatformStorage, MIGRATION_017_USER_MUST_CHANGE_PASSWORD_SQL } from '@enkeep/platform-storage-sqlite';
import { DefaultAuthService } from '../src/service/auth-service.js';

describe('AuthService Session Creation & Rotation', () => {
  let storage: SqlitePlatformStorage;
  let authService: DefaultAuthService;
  const cookieSecret = 'test_cookie_secret_at_least_16_chars!';

  beforeEach(async () => {
    storage = await createSqliteStorage({ dbPath: ':memory:' });
    storage.db.exec(MIGRATION_017_USER_MUST_CHANGE_PASSWORD_SQL);
    authService = new DefaultAuthService(storage, {
      cookieSecret,
      sessionTtlSeconds: 3600,
      cookieSecure: false,
    });
  });

  afterEach(async () => {
    await storage.close();
  });

  it('rotates user session: revokes previous sessions, returns fresh active session with valid cookie', async () => {
    const passwordHash = await authService.hashPassword('InitialPass123!');
    const user = await storage.users.create({
      username: 'rotatetest',
      passwordHash,
      mustChangePassword: true,
    });

    // 1. Initial login -> Session 1
    const loginRes = await authService.login('rotatetest', 'InitialPass123!');
    const cookie1 = loginRes.cookieHeader;
    const auth1 = await authService.authenticateCookie(cookie1);
    expect(auth1.authenticated).toBe(true);
    expect(auth1.user?.mustChangePassword).toBe(true);

    // 2. Rotate session
    const rotateRes = await authService.rotateSession(user.id);
    const cookie2 = rotateRes.cookieHeader;
    expect(cookie2).toBeTruthy();

    // 3. Old cookie is revoked
    const authOld = await authService.authenticateCookie(cookie1);
    expect(authOld.authenticated).toBe(false);

    // 4. New cookie is valid
    const authNew = await authService.authenticateCookie(cookie2);
    expect(authNew.authenticated).toBe(true);
    expect(authNew.user?.username).toBe('rotatetest');

    // 5. Audit log includes session_revoked
    const logs = await storage.auditLogs.listByUserId(user.id);
    expect(logs.some((l) => l.action === 'session_revoked')).toBe(true);
  });
});
