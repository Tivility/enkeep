import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
} from '../src/storage/migrations.js';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { DefaultAuthService, provisionFixtures } from '@enkeep/platform-auth';
import { createPlatformServerHandler } from '../src/server/handler.js';
import { SqlitePlatformWebApiAdapter } from '../src/storage/sqlite-platform-api.js';
import { SqliteWebMessageStore } from '../src/storage/web-messages.js';
import { ConsoleDataSource } from '../src/management/console-data-source.js';

describe('Admin Users Management & User Password Change (/api/admin/users, /api/auth/password)', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let authService: DefaultAuthService;
  let server: Server;
  let baseUrl: string;
  const cookieSecret = 'test_cookie_secret_at_least_16_chars_long!';
  const csrfToken = 'test-valid-csrf-token-1234567890abcdef';

  let aliceCookie: string;
  let bobCookie: string;
  let aliceId: string;
  let bobId: string;

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    storage = new SqlitePlatformStorage(db);
    authService = new DefaultAuthService(storage, {
      cookieSecret,
      sessionTtlSeconds: 3600,
      cookieSecure: false,
    });

    const provisionResult = await provisionFixtures(storage, authService, {
      adminPassword: 'AliceAdmin123!',
      userPassword: 'BobUser123!',
      disabledPassword: 'CharlieDisabled123!',
    });
    aliceId = provisionResult.admin.id;
    bobId = provisionResult.user.id;

    // Login alice and bob
    const aliceLogin = await authService.login('alice', 'AliceAdmin123!');
    aliceCookie = aliceLogin.cookieHeader.split(';')[0]!;

    const bobLogin = await authService.login('bob', 'BobUser123!');
    bobCookie = bobLogin.cookieHeader.split(';')[0]!;

    const messageStore = new SqliteWebMessageStore(db);
    const platformApi = new SqlitePlatformWebApiAdapter({
      storage,
      messageStore,
      authService,
      db,
    });

    const consoleDataSource = new ConsoleDataSource({
      database: db,
      storage,
      quotaDefaults: {
        turns: 100,
        messages: 100,
        tokens: 65536,
        storage_bytes: 10485760,
        api_calls: 500,
        resetInterval: 'none',
      },
    });

    const fakeGateway: any = {
      dispatchInbound: async () => ({ status: 'held', deliveryId: 'd1' }),
      handleTurnFinished: async () => {},
    };

    const handler = createPlatformServerHandler({
      database: db,
      storage,
      authService,
      runtimeGateway: fakeGateway,
      platformApi,
      csrfToken,
      consoleDataSource,
    });

    server = createServer(handler);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (db) {
      db.close();
    }
  });

  describe('1. POST /api/admin/users (User Creation)', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const res = await fetch(`${baseUrl}/api/admin/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({ username: 'newuser1' }),
      });
      expect(res.status).toBe(401);
    });

    it('rejects non-admin requests (Bob) with 403 Forbidden', async () => {
      const res = await fetch(`${baseUrl}/api/admin/users`, {
        method: 'POST',
        headers: {
          Cookie: bobCookie,
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({ username: 'newuser2' }),
      });
      expect(res.status).toBe(403);
    });

    it('rejects requests missing valid CSRF token with 403', async () => {
      const res = await fetch(`${baseUrl}/api/admin/users`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': 'wrong-csrf-token',
          Origin: baseUrl,
        },
        body: JSON.stringify({ username: 'newuser3' }),
      });
      expect(res.status).toBe(403);
    });

    it('creates user with auto-generated secure temporary password and returns it once', async () => {
      const res = await fetch(`${baseUrl}/api/admin/users`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({
          username: 'developer_dan',
          displayName: 'Dan Developer',
          role: 'user',
        }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.user.username).toBe('developer_dan');
      expect(json.data.user.displayName).toBe('Dan Developer');
      expect(json.data.user.role).toBe('user');
      expect(json.data.user.status).toBe('active');
      expect(json.data.user.password_hash).toBeUndefined(); // NEVER leaks hash
      expect(json.data.user.passwordHash).toBeUndefined();

      // Temporary password is provided in top-level data
      expect(typeof json.data.tempPassword).toBe('string');
      expect(json.data.tempPassword.length).toBeGreaterThanOrEqual(12);

      // Verify that user can immediately log in with returned temporary password
      const newLogin = await authService.login('developer_dan', json.data.tempPassword);
      expect(newLogin.user.username).toBe('developer_dan');

      // Verify audit log entry was created
      const auditRows = db.prepare("SELECT * FROM auth_audit_log WHERE action = 'user_created' AND username = 'developer_dan'").all();
      expect(auditRows.length).toBe(1);
    });

    it('creates user with custom temporary password and rejects duplicate usernames with 409 Conflict', async () => {
      const res1 = await fetch(`${baseUrl}/api/admin/users`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({
          username: 'custom_user',
          tempPassword: 'CustomTempPassword123!',
          role: 'admin',
        }),
      });

      expect(res1.status).toBe(201);
      const json1 = await res1.json();
      expect(json1.data.user.role).toBe('admin');
      expect(json1.data.tempPassword).toBe('CustomTempPassword123!');

      // Attempt duplicate username
      const resDup = await fetch(`${baseUrl}/api/admin/users`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({
          username: 'custom_user',
          tempPassword: 'AnotherPassword123!',
        }),
      });

      expect(resDup.status).toBe(409);
      const dupJson = await resDup.json();
      expect(dupJson.error.code).toBe('USER_ALREADY_EXISTS');
    });

    it('rejects invalid inputs (empty username, invalid role, unknown properties)', async () => {
      const resEmpty = await fetch(`${baseUrl}/api/admin/users`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({ username: '' }),
      });
      expect(resEmpty.status).toBe(400);

      const resBadRole = await fetch(`${baseUrl}/api/admin/users`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({ username: 'badroleuser', role: 'superadmin' }),
      });
      expect(resBadRole.status).toBe(400);

      const resUnknown = await fetch(`${baseUrl}/api/admin/users`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({ username: 'validuser', malicious: true }),
      });
      expect(resUnknown.status).toBe(400);
    });
  });

  describe('2. POST /api/admin/users/:id/reset-password (Password Reset & Session Revocation)', () => {
    it('rejects non-admin (Bob) with 403 Forbidden', async () => {
      const res = await fetch(`${baseUrl}/api/admin/users/${aliceId}/reset-password`, {
        method: 'POST',
        headers: {
          Cookie: bobCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
        },
      });
      expect(res.status).toBe(403);
    });

    it('returns 404 for non-existent target user', async () => {
      const res = await fetch(`${baseUrl}/api/admin/users/00000000-0000-0000-0000-000000000000/reset-password`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
        },
      });
      expect(res.status).toBe(404);
    });

    it('resets Bob password, revokes all active sessions for Bob, and returns one-time temporary password', async () => {
      // Bob currently has an active session
      const authBefore = await authService.authenticateCookie(`enkeep_session=${bobCookie.split('=')[1]}`);
      expect(authBefore.authenticated).toBe(true);

      const res = await fetch(`${baseUrl}/api/admin/users/${bobId}/reset-password`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
        },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.targetUserId).toBe(bobId);
      expect(json.data.username).toBe('bob');
      expect(typeof json.data.tempPassword).toBe('string');
      expect(json.data.tempPassword.length).toBeGreaterThanOrEqual(12);

      // Verify Bob old session is revoked immediately
      const authAfter = await authService.authenticateCookie(`enkeep_session=${bobCookie.split('=')[1]}`);
      expect(authAfter.authenticated).toBe(false);

      // Verify old password no longer works
      await expect(authService.login('bob', 'BobUser123!')).rejects.toThrow();

      // Verify new temporary password works
      const bobNewLogin = await authService.login('bob', json.data.tempPassword);
      expect(bobNewLogin.user.username).toBe('bob');

      // Verify audit log
      const auditRows = db.prepare("SELECT * FROM auth_audit_log WHERE action = 'password_reset' AND user_id = ?").all(bobId);
      expect(auditRows.length).toBe(1);
    });
  });

  describe('3. PUT /api/auth/password (User Self Password Change)', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const res = await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({
          oldPassword: 'BobUser123!',
          newPassword: 'BrandNewPassword123!',
        }),
      });
      expect(res.status).toBe(401);
    });

    it('rejects incorrect old password with 400 validation error', async () => {
      const res = await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PUT',
        headers: {
          Cookie: bobCookie,
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({
          oldPassword: 'IncorrectOldPassword!',
          newPassword: 'BrandNewPassword123!',
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.message).toContain('Current password does not match');
    });

    it('rejects short new password (< 8 chars)', async () => {
      const res = await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PUT',
        headers: {
          Cookie: bobCookie,
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({
          oldPassword: 'BobUser123!',
          newPassword: 'short',
        }),
      });
      expect(res.status).toBe(400);
    });

    it('successfully changes password and records audit log', async () => {
      const res = await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PUT',
        headers: {
          Cookie: bobCookie,
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({
          oldPassword: 'BobUser123!',
          newPassword: 'BrandNewBobPassword123!',
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);

      // Old password fails
      await expect(authService.login('bob', 'BobUser123!')).rejects.toThrow();

      // New password succeeds
      const newLogin = await authService.login('bob', 'BrandNewBobPassword123!');
      expect(newLogin.user.username).toBe('bob');

      // Audit log entry exists
      const auditRows = db.prepare("SELECT * FROM auth_audit_log WHERE action = 'password_changed' AND user_id = ?").all(bobId);
      expect(auditRows.length).toBe(1);
    });
  });
});
