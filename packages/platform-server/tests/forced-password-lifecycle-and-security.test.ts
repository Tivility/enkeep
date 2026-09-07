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

describe('Forced Password Change Lifecycle & Security Enforcement', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let authService: DefaultAuthService;
  let server: Server;
  let baseUrl: string;
  let runtimeStoppedUserIds: string[] = [];
  const cookieSecret = 'test_cookie_secret_at_least_16_chars_long!';
  const csrfToken = 'test-valid-csrf-token-1234567890abcdef';

  let aliceCookie: string;
  let bobCookie: string;
  let aliceId: string;
  let bobId: string;

  beforeEach(async () => {
    runtimeStoppedUserIds = [];
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

    const mockManagementProvider: any = {
      listRuntimes: async () => [],
      getUserRuntime: async () => null,
      stopRuntime: async (uid: string) => {
        runtimeStoppedUserIds.push(uid);
        return { stopped: true, userId: uid };
      },
    };

    const handler = createPlatformServerHandler({
      database: db,
      storage,
      authService,
      runtimeGateway: fakeGateway,
      platformApi,
      csrfToken,
      consoleDataSource,
      managementProvider: mockManagementProvider,
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

  it('1. Admin creates a new user: mustChangePassword is true, temp password is returned once', async () => {
    const res = await fetch(`${baseUrl}/api/admin/users`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        username: 'charlie_temp',
        displayName: 'Charlie Temporary',
        role: 'user',
      }),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.user.username).toBe('charlie_temp');
    expect(json.data.user.mustChangePassword).toBe(true);
    expect(typeof json.data.tempPassword).toBe('string');
    expect(json.data.tempPassword.length).toBeGreaterThanOrEqual(12);

    const tempPassword = json.data.tempPassword;

    // Login with temp password
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        username: 'charlie_temp',
        password: tempPassword,
      }),
    });

    expect(loginRes.status).toBe(200);
    const loginJson = await loginRes.json();
    expect(loginJson.data.user.mustChangePassword).toBe(true);

    const setCookie = loginRes.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();
    const charlieCookie = setCookie!.split(';')[0]!;

    // 2. Access Allowed APIs while mustChangePassword is true:
    // a. GET /api/auth/csrf
    const csrfRes = await fetch(`${baseUrl}/api/auth/csrf`);
    expect(csrfRes.status).toBe(200);

    // b. GET /api/auth/me
    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: charlieCookie },
    });
    expect(meRes.status).toBe(200);
    const meJson = await meRes.json();
    expect(meJson.data.user.username).toBe('charlie_temp');
    expect(meJson.data.user.mustChangePassword).toBe(true);

    // c. GET /api/account/preferences
    const prefRes = await fetch(`${baseUrl}/api/account/preferences`, {
      headers: { Cookie: charlieCookie },
    });
    expect(prefRes.status).toBe(200);

    // d. PATCH /api/account/preferences
    const patchPrefRes = await fetch(`${baseUrl}/api/account/preferences`, {
      method: 'PATCH',
      headers: {
        Cookie: charlieCookie,
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        'Idempotency-Key': '11111111-1111-4111-8111-111111111111',
        Origin: baseUrl,
      },
      body: JSON.stringify({ locale: 'zh-CN' }),
    });
    expect(patchPrefRes.status).toBe(200);

    // 3. Denied APIs: Verify strict 403 PASSWORD_CHANGE_REQUIRED on all other resources
    const deniedEndpoints: Array<{ method: string; path: string; body?: any }> = [
      { method: 'GET', path: '/api/spaces' },
      { method: 'POST', path: '/api/spaces', body: { name: 'Forbidden Space' } },
      { method: 'GET', path: '/api/sessions' },
      { method: 'POST', path: '/api/sessions', body: { spaceId: 'dummy', title: 'Forbidden' } },
      { method: 'GET', path: '/api/manage/overview' },
      { method: 'GET', path: '/api/manage/tasks' },
      { method: 'GET', path: '/api/manage/quotas' },
      { method: 'GET', path: '/api/manage/deliveries' },
      { method: 'GET', path: '/api/manage/audit' },
      { method: 'GET', path: '/api/admin/dashboard' },
      { method: 'GET', path: '/api/admin/users' },
      { method: 'GET', path: '/api/dsh' },
    ];

    for (const ep of deniedEndpoints) {
      const headers: Record<string, string> = {
        Cookie: charlieCookie,
        Origin: baseUrl,
      };
      if (ep.method !== 'GET') {
        headers['Content-Type'] = 'application/json';
        headers['X-Enkeep-CSRF'] = csrfToken;
      }
      const deniedRes = await fetch(`${baseUrl}${ep.path}`, {
        method: ep.method,
        headers,
        body: ep.body ? JSON.stringify(ep.body) : undefined,
      });

      expect(deniedRes.status).toBe(403);
      const deniedJson = await deniedRes.json();
      expect(deniedJson.success).toBe(false);
      expect(deniedJson.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    }

    // 4. User performs forced password change via PUT /api/auth/password
    const changeRes = await fetch(`${baseUrl}/api/auth/password`, {
      method: 'PUT',
      headers: {
        Cookie: charlieCookie,
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        oldPassword: tempPassword,
        newPassword: 'PermanentCharliePass123!',
      }),
    });

    expect(changeRes.status).toBe(200);
    const changeJson = await changeRes.json();
    expect(changeJson.success).toBe(true);

    // Verify Set-Cookie header is returned with NEW rotated session
    const rotatedSetCookie = changeRes.headers.get('set-cookie');
    expect(rotatedSetCookie).toBeTruthy();
    const charlieNewCookie = rotatedSetCookie!.split(';')[0]!;
    expect(charlieNewCookie).not.toBe(charlieCookie); // Cookie was rotated

    // 5. Old session cookie is now invalid (401 Unauthorized)
    const oldSessionRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: charlieCookie },
    });
    expect(oldSessionRes.status).toBe(401);

    // 6. New session cookie works and mustChangePassword is now false
    const newMeRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: charlieNewCookie },
    });
    expect(newMeRes.status).toBe(200);
    const newMeJson = await newMeRes.json();
    expect(newMeJson.data.user.mustChangePassword).toBe(false);

    // 7. Previously denied APIs are now accessible
    const spacesRes = await fetch(`${baseUrl}/api/spaces`, {
      headers: { Cookie: charlieNewCookie },
    });
    expect(spacesRes.status).toBe(200);
  });

  it('2. Admin resets user password: revokes existing sessions, flags must_change_password = true', async () => {
    // Bob is active with bobCookie
    const beforeMeRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: bobCookie },
    });
    expect(beforeMeRes.status).toBe(200);
    expect((await beforeMeRes.json()).data.user.mustChangePassword).toBe(false);

    // Admin resets Bob's password
    const resetRes = await fetch(`${baseUrl}/api/admin/users/${bobId}/reset-password`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
      },
    });

    expect(resetRes.status).toBe(200);
    const resetJson = await resetRes.json();
    expect(resetJson.success).toBe(true);
    expect(typeof resetJson.data.tempPassword).toBe('string');
    const bobTempPassword = resetJson.data.tempPassword;

    // Bob's old session is immediately revoked (401)
    const oldBobRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: bobCookie },
    });
    expect(oldBobRes.status).toBe(401);

    // Bob logs in with temporary password
    const bobLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        username: 'bob',
        password: bobTempPassword,
      }),
    });

    expect(bobLoginRes.status).toBe(200);
    const bobLoginJson = await bobLoginRes.json();
    expect(bobLoginJson.data.user.mustChangePassword).toBe(true);

    const bobNewTempCookie = bobLoginRes.headers.get('set-cookie')!.split(';')[0]!;

    // Protected APIs return 403 PASSWORD_CHANGE_REQUIRED
    const spacesDenied = await fetch(`${baseUrl}/api/spaces`, {
      headers: { Cookie: bobNewTempCookie },
    });
    expect(spacesDenied.status).toBe(403);
    const deniedJson = await spacesDenied.json();
    expect(deniedJson.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    // Bob changes password
    const changeRes = await fetch(`${baseUrl}/api/auth/password`, {
      method: 'PUT',
      headers: {
        Cookie: bobNewTempCookie,
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        oldPassword: bobTempPassword,
        newPassword: 'BrandNewBobPermanentPassword123!',
      }),
    });

    expect(changeRes.status).toBe(200);
    const bobPermanentCookie = changeRes.headers.get('set-cookie')!.split(';')[0]!;

    // Bob can now access spaces
    const spacesAllowed = await fetch(`${baseUrl}/api/spaces`, {
      headers: { Cookie: bobPermanentCookie },
    });
    expect(spacesAllowed.status).toBe(200);
  });

  it('3. Admin user deactivation: POST /api/admin/users/:id/deactivate stops runtime and disables user', async () => {
    const deactivateRes = await fetch(`${baseUrl}/api/admin/users/${bobId}/deactivate`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
      },
    });

    expect(deactivateRes.status).toBe(200);
    const deactivateJson = await deactivateRes.json();
    expect(deactivateJson.success).toBe(true);
    expect(deactivateJson.data.status).toBe('disabled');

    // Runtime was stopped for bob
    expect(runtimeStoppedUserIds).toContain(bobId);

    // Bob's session is revoked
    const bobRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: bobCookie },
    });
    expect(bobRes.status).toBe(401);
  });

  it('4. Admin session revocation: POST /api/admin/users/:id/revoke-sessions revokes auth sessions without stopping runtime', async () => {
    runtimeStoppedUserIds = [];

    const revokeRes = await fetch(`${baseUrl}/api/admin/users/${bobId}/revoke-sessions`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
      },
    });

    expect(revokeRes.status).toBe(200);
    const revokeJson = await revokeRes.json();
    expect(revokeJson.success).toBe(true);

    // Session is revoked
    const bobRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: bobCookie },
    });
    expect(bobRes.status).toBe(401);

    // Runtime was NOT stopped (session revoke is decoupled from runtime)
    expect(runtimeStoppedUserIds).not.toContain(bobId);
  });

  it('5. Last active admin protection: cannot deactivate or disable the last active administrator', async () => {
    // Alice tries to deactivate herself (she is the only active admin)
    const selfDeactivateRes = await fetch(`${baseUrl}/api/admin/users/${aliceId}/deactivate`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
      },
    });

    expect(selfDeactivateRes.status).toBe(403);
    const json = await selfDeactivateRes.json();
    expect(json.error.message).toContain('last active administrator');
  });
});
