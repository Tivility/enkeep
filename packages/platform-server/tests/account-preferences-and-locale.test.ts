import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
} from '../src/storage/migrations.js';
import { createServer, type Server } from 'node:http';
import { createPlatformServerHandler } from '../src/server/handler.js';
import { ConsoleDataSource } from '../src/management/console-data-source.js';
import { SqlitePlatformWebApiAdapter } from '../src/storage/sqlite-platform-api.js';
import { SqliteWebMessageStore } from '../src/storage/web-messages.js';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { DefaultAuthService, provisionFixtures } from '@enkeep/platform-auth';
import type { RuntimeGateway } from '@enkeep/web-channel';

describe('Account Preferences & User Locale API', () => {
  let db: DatabaseSync;
  let server: Server;
  let serverUrl: string;
  let aliceCookie: string;
  let bobCookie: string;
  let storage: SqlitePlatformStorage;
  const csrfToken = 'test-csrf-token-32-chars-long-abc';

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const migrationRunner = new PlatformServerMigrationRunner(db);
    await migrationRunner.migrate(ALL_PLATFORM_MIGRATIONS);

    storage = new SqlitePlatformStorage(db);
    const authService = new DefaultAuthService(storage, {
      cookieSecret: 'test-cookie-secret-at-least-32-chars-long',
    });

    const fixtures = await provisionFixtures(storage, authService, {
      adminPassword: 'alice_admin_password_123',
      userPassword: 'bob_user_password_123',
      disabledPassword: 'charlie_disabled_password_123',
    });

    const aliceLogin = await authService.login('alice', 'alice_admin_password_123');
    aliceCookie = aliceLogin.cookieHeader.split(';')[0];

    const bobLogin = await authService.login('bob', 'bob_user_password_123');
    bobCookie = bobLogin.cookieHeader.split(';')[0];

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

    const dummyGateway: RuntimeGateway = {
      dispatchInbound: async () => ({ status: 'held', deliveryId: 'd1', routeKey: 'rk' }),
      resolveProfileBinding: async () => null,
      fetchAgentProfileOverride: async () => null,
    };

    const handler = createPlatformServerHandler({
      database: db,
      storage,
      authService,
      runtimeGateway: dummyGateway,
      platformApi,
      csrfToken,
      consoleDataSource,
    });

    server = createServer((req, res) => {
      handler(req, res).catch((err) => {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(JSON.stringify({ success: false, error: { message: err.message } }));
        }
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (typeof addr === 'object' && addr !== null) {
          serverUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });

  // 1. GET /api/account/preferences
  it('GET /api/account/preferences returns user current default locale "en"', async () => {
    const res = await fetch(`${serverUrl}/api/account/preferences`, {
      method: 'GET',
      headers: {
        Cookie: aliceCookie,
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      data: {
        locale: 'en',
        theme: 'dark',
      },
    });
  });

  it('GET /api/v1/account/preferences returns 404 NOT_FOUND (aliases strictly forbidden)', async () => {
    const res = await fetch(`${serverUrl}/api/v1/account/preferences`, {
      method: 'GET',
      headers: {
        Cookie: bobCookie,
      },
    });

    expect(res.status).toBe(404);
  });

  it('GET /api/account/preferences rejects unauthenticated request with 401', async () => {
    const res = await fetch(`${serverUrl}/api/account/preferences`, {
      method: 'GET',
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  // 2. PATCH /api/account/preferences
  it('PATCH /api/account/preferences updates locale to "zh-CN" and creates audit log "locale_changed"', async () => {
    const origin = serverUrl;
    const idempKey = randomUUID();
    const res = await fetch(`${serverUrl}/api/account/preferences`, {
      method: 'PATCH',
      headers: {
        Cookie: bobCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': csrfToken,
        Origin: origin,
        'Idempotency-Key': idempKey,
      },
      body: JSON.stringify({ locale: 'zh-CN' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      data: {
        locale: 'zh-CN',
        theme: 'dark',
      },
    });

    // Verify GET now returns 'zh-CN'
    const getRes = await fetch(`${serverUrl}/api/account/preferences`, {
      method: 'GET',
      headers: { Cookie: bobCookie },
    });
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.data.locale).toBe('zh-CN');

    // Verify audit log has 'locale_changed' with only safe metadata { oldLocale, newLocale }
    const auditLogs = db.prepare(
      "SELECT * FROM auth_audit_log WHERE action = 'locale_changed' ORDER BY created_at DESC"
    ).all() as Array<{ action: string; username: string; details: string }>;

    expect(auditLogs.length).toBeGreaterThanOrEqual(1);
    const latest = auditLogs[0];
    expect(latest.action).toBe('locale_changed');
    expect(latest.username).toBe('bob');
    const parsedDetails = JSON.parse(latest.details);
    expect(parsedDetails).toEqual({
      oldLocale: 'en',
      newLocale: 'zh-CN',
    });
    expect(parsedDetails).not.toHaveProperty('password');
    expect(parsedDetails).not.toHaveProperty('passwordHash');
    expect(parsedDetails).not.toHaveProperty('token');
  });

  // 3. HTTP Methods Enforcement: Only GET and PATCH allowed; PUT/POST/DELETE return 405
  it('PUT /api/account/preferences returns 405 Method Not Allowed', async () => {
    const res = await fetch(`${serverUrl}/api/account/preferences`, {
      method: 'PUT',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': csrfToken,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({ locale: 'zh-CN' }),
    });

    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('METHOD_NOT_ALLOWED');
  });

  it('POST /api/account/preferences returns 405 Method Not Allowed', async () => {
    const res = await fetch(`${serverUrl}/api/account/preferences`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': csrfToken,
        Origin: serverUrl,
      },
      body: JSON.stringify({ locale: 'zh-CN' }),
    });

    expect(res.status).toBe(405);
  });

  it('DELETE /api/account/preferences returns 405 Method Not Allowed', async () => {
    const res = await fetch(`${serverUrl}/api/account/preferences`, {
      method: 'DELETE',
      headers: {
        Cookie: aliceCookie,
        'x-enkeep-csrf': csrfToken,
        Origin: serverUrl,
      },
    });

    expect(res.status).toBe(405);
  });

  // 4. Strict Validation Tests
  it('rejects invalid lowercase "zh-cn" with 400 ValidationError', async () => {
    const res = await fetch(`${serverUrl}/api/account/preferences`, {
      method: 'PATCH',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': csrfToken,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({ locale: 'zh-cn' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain("Invalid locale value: must be 'en' or 'zh-CN'");
  });

  it('rejects invalid uppercase "EN" or "ZH-CN" with 400', async () => {
    const res = await fetch(`${serverUrl}/api/account/preferences`, {
      method: 'PATCH',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': csrfToken,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({ locale: 'EN' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("Invalid locale value: must be 'en' or 'zh-CN'");
  });

  it('rejects whitespace " en " with 400', async () => {
    const res = await fetch(`${serverUrl}/api/account/preferences`, {
      method: 'PATCH',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': csrfToken,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({ locale: ' en ' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("Invalid locale value: must be 'en' or 'zh-CN'");
  });

  it('rejects unsupported locales e.g. "fr", "ja", "de" with 400', async () => {
    const res = await fetch(`${serverUrl}/api/account/preferences`, {
      method: 'PATCH',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': csrfToken,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({ locale: 'fr' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("Invalid locale value: must be 'en' or 'zh-CN'");
  });

  it('rejects unknown fields in body (e.g. userId or extra) with 400', async () => {
    const res = await fetch(`${serverUrl}/api/account/preferences`, {
      method: 'PATCH',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': csrfToken,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({ locale: 'zh-CN', userId: 'other_user' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain('Unexpected field "userId"');
  });

  it('rejects missing locale and theme fields with 400', async () => {
    const res = await fetch(`${serverUrl}/api/account/preferences`, {
      method: 'PATCH',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': csrfToken,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain('Field "locale" or "theme" is required');
  });

  // 5. CSRF and Origin Protection
  it('rejects PATCH /api/account/preferences without CSRF token with 403', async () => {
    const res = await fetch(`${serverUrl}/api/account/preferences`, {
      method: 'PATCH',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        Origin: serverUrl,
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({ locale: 'zh-CN' }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('CSRF_VIOLATION');
  });

  it('rejects PATCH /api/account/preferences with invalid Origin with 403', async () => {
    const res = await fetch(`${serverUrl}/api/account/preferences`, {
      method: 'PATCH',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': csrfToken,
        Origin: 'http://malicious.evil.com',
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({ locale: 'zh-CN' }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('CSRF_VIOLATION');
  });

  // 6. Mandatory Idempotency-Key Policy
  it('rejects PATCH /api/account/preferences without Idempotency-Key header with 400', async () => {
    const res = await fetch(`${serverUrl}/api/account/preferences`, {
      method: 'PATCH',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': csrfToken,
        Origin: serverUrl,
      },
      body: JSON.stringify({ locale: 'zh-CN' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('Missing required Idempotency-Key header');
  });

  it('rejects malformed or uppercase Idempotency-Key header with 400', async () => {
    const res = await fetch(`${serverUrl}/api/account/preferences`, {
      method: 'PATCH',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': csrfToken,
        Origin: serverUrl,
        'Idempotency-Key': 'NOT-A-UUID',
      },
      body: JSON.stringify({ locale: 'zh-CN' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain('Invalid Idempotency-Key format');
  });

  it('supports Idempotency-Key header on PATCH /api/account/preferences and replays same response', async () => {
    const idempKey = randomUUID();

    const res1 = await fetch(`${serverUrl}/api/account/preferences`, {
      method: 'PATCH',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': csrfToken,
        Origin: serverUrl,
        'Idempotency-Key': idempKey,
      },
      body: JSON.stringify({ locale: 'zh-CN' }),
    });

    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.data.locale).toBe('zh-CN');

    // Replay same request with same idempotency key
    const res2 = await fetch(`${serverUrl}/api/account/preferences`, {
      method: 'PATCH',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': csrfToken,
        Origin: serverUrl,
        'Idempotency-Key': idempKey,
      },
      body: JSON.stringify({ locale: 'zh-CN' }),
    });

    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.data.locale).toBe('zh-CN');

    // Reusing same Idempotency-Key with different payload throws 409 Conflict
    const res3 = await fetch(`${serverUrl}/api/account/preferences`, {
      method: 'PATCH',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': csrfToken,
        Origin: serverUrl,
        'Idempotency-Key': idempKey,
      },
      body: JSON.stringify({ locale: 'en' }),
    });

    expect(res3.status).toBe(409);
    const body3 = await res3.json();
    expect(body3.error.code).toBe('CONFLICT');
  });

  it('rejects forbidden alternate header "x-idempotency-key" with 400', async () => {
    const res = await fetch(`${serverUrl}/api/account/preferences`, {
      method: 'PATCH',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': csrfToken,
        Origin: serverUrl,
        'x-idempotency-key': randomUUID(),
      },
      body: JSON.stringify({ locale: 'zh-CN' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain('Alternate header "x-idempotency-key" is not permitted');
  });

  // 7. Tenant Isolation
  it('modifying user Alice preferences does not alter user Bob preferences', async () => {
    // Alice changes to zh-CN
    await fetch(`${serverUrl}/api/account/preferences`, {
      method: 'PATCH',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': csrfToken,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({ locale: 'zh-CN' }),
    });

    // Bob still has 'en'
    const bobRes = await fetch(`${serverUrl}/api/account/preferences`, {
      method: 'GET',
      headers: { Cookie: bobCookie },
    });
    const bobData = await bobRes.json();
    expect(bobData.data.locale).toBe('en');

    // Alice has 'zh-CN'
    const aliceRes = await fetch(`${serverUrl}/api/account/preferences`, {
      method: 'GET',
      headers: { Cookie: aliceCookie },
    });
    const aliceData = await aliceRes.json();
    expect(aliceData.data.locale).toBe('zh-CN');
  });

  // 8. Auth / Me and Login return flat user with locale
  it('/api/auth/me returns flat user object containing {id, username, role, status, displayName, locale}', async () => {
    // Update Bob to zh-CN
    await fetch(`${serverUrl}/api/account/preferences`, {
      method: 'PATCH',
      headers: {
        Cookie: bobCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': csrfToken,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({ locale: 'zh-CN' }),
    });

    const meRes = await fetch(`${serverUrl}/api/auth/me`, {
      method: 'GET',
      headers: { Cookie: bobCookie },
    });
    expect(meRes.status).toBe(200);
    const meBody = await meRes.json();
    expect(meBody.data.user).toEqual({
      id: expect.any(String),
      username: 'bob',
      role: 'user',
      status: 'active',
      displayName: 'Bob (User)',
      locale: 'zh-CN',
      theme: 'dark',
      mustChangePassword: false,
    });
    expect(meBody.data.user).not.toHaveProperty('preferences');
    expect(meBody.data.user).not.toHaveProperty('language');
  });

  it('/api/auth/login returns flat user object containing {id, username, role, status, displayName, locale}', async () => {
    // Bob has zh-CN
    await fetch(`${serverUrl}/api/account/preferences`, {
      method: 'PATCH',
      headers: {
        Cookie: bobCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': csrfToken,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({ locale: 'zh-CN' }),
    });

    const loginRes = await fetch(`${serverUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-enkeep-csrf': csrfToken,
        Origin: serverUrl,
      },
      body: JSON.stringify({
        username: 'bob',
        password: 'bob_user_password_123',
      }),
    });

    expect(loginRes.status).toBe(200);
    const loginBody = await loginRes.json();
    expect(loginBody.data.user).toEqual({
      id: expect.any(String),
      username: 'bob',
      role: 'user',
      status: 'active',
      displayName: 'Bob (User)',
      locale: 'zh-CN',
      theme: 'dark',
      mustChangePassword: false,
    });
    expect(loginBody.data.user).not.toHaveProperty('preferences');
    expect(loginBody.data.user).not.toHaveProperty('language');
  });

  // 9. Admin User Management with Locale
  it('POST /api/admin/users allows optional locale parameter (defaults to "en")', async () => {
    // Create user without specifying locale -> defaults to 'en'
    const res1 = await fetch(`${serverUrl}/api/admin/users`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': csrfToken,
        Origin: serverUrl,
      },
      body: JSON.stringify({
        username: 'new_user_default',
        displayName: 'Default User',
      }),
    });

    expect(res1.status).toBe(201);
    const body1 = await res1.json();
    expect(body1.data.user.locale).toBe('en');

    // Create user with explicit locale 'zh-CN'
    const res2 = await fetch(`${serverUrl}/api/admin/users`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': csrfToken,
        Origin: serverUrl,
      },
      body: JSON.stringify({
        username: 'new_user_zh',
        displayName: 'Chinese User',
        locale: 'zh-CN',
      }),
    });

    expect(res2.status).toBe(201);
    const body2 = await res2.json();
    expect(body2.data.user.locale).toBe('zh-CN');
  });

  it('GET /api/admin/users includes locale in safe user items', async () => {
    const res = await fetch(`${serverUrl}/api/admin/users`, {
      method: 'GET',
      headers: { Cookie: aliceCookie },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.items)).toBe(true);
    const aliceUser = body.data.items.find((u: any) => u.username === 'alice');
    expect(aliceUser).toBeDefined();
    expect(aliceUser.locale).toBe('en');
  });

  it('PATCH /api/admin/users/:id allows admin to update target user locale', async () => {
    const userRes = await fetch(`${serverUrl}/api/admin/users`, {
      headers: { Cookie: aliceCookie },
    });
    const users = await userRes.json();
    const bob = users.data.items.find((u: any) => u.username === 'bob');

    const patchRes = await fetch(`${serverUrl}/api/admin/users/${bob.id}`, {
      method: 'PATCH',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': csrfToken,
        Origin: serverUrl,
      },
      body: JSON.stringify({ locale: 'zh-CN' }),
    });

    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json();
    expect(patchBody.data.locale).toBe('zh-CN');
  });
});
