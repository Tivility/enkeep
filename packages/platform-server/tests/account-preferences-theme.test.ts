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

describe('Account Preferences Theme API & Migration 28', () => {
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
      dispatchInbound: async () => ({ accepted: true, turnId: 't1', message: {} as any, isDuplicate: false }),
      getCurrentTurnStatus: async () => null,
      cancelCurrentTurn: async () => false,
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

  // 1. GET /api/account/preferences/theme
  it('GET /api/account/preferences/theme returns default theme "dark"', async () => {
    const res = await fetch(`${serverUrl}/api/account/preferences/theme`, {
      method: 'GET',
      headers: { Cookie: aliceCookie },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      data: {
        theme: 'dark',
      },
    });
  });

  it('GET /api/account/preferences/theme rejects unauthenticated request with 401', async () => {
    const res = await fetch(`${serverUrl}/api/account/preferences/theme`, {
      method: 'GET',
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  // 2. PUT & PATCH /api/account/preferences/theme
  it('PUT /api/account/preferences/theme updates theme to "light" and records "theme_changed" audit log', async () => {
    const res = await fetch(`${serverUrl}/api/account/preferences/theme`, {
      method: 'PUT',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': csrfToken,
        Origin: serverUrl,
      },
      body: JSON.stringify({ theme: 'light' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      data: {
        theme: 'light',
      },
    });

    // Check GET returns updated theme
    const getRes = await fetch(`${serverUrl}/api/account/preferences/theme`, {
      method: 'GET',
      headers: { Cookie: aliceCookie },
    });
    const getBody = await getRes.json();
    expect(getBody.data.theme).toBe('light');

    // Verify audit log has 'theme_changed'
    const latestAudit = db.prepare(
      "SELECT * FROM auth_audit_log WHERE action = 'theme_changed' ORDER BY created_at DESC LIMIT 1"
    ).get() as { action: string; details: string };
    expect(latestAudit).toBeDefined();
    expect(latestAudit.action).toBe('theme_changed');
    const details = JSON.parse(latestAudit.details);
    expect(details.oldTheme).toBe('dark');
    expect(details.newTheme).toBe('light');
  });

  it('PUT /api/account/preferences/theme updates theme to "eye-care"', async () => {
    const res = await fetch(`${serverUrl}/api/account/preferences/theme`, {
      method: 'PUT',
      headers: {
        Cookie: bobCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': csrfToken,
        Origin: serverUrl,
      },
      body: JSON.stringify({ theme: 'eye-care' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.theme).toBe('eye-care');
  });

  it('rejects PUT /api/account/preferences/theme without CSRF token with 403', async () => {
    const res = await fetch(`${serverUrl}/api/account/preferences/theme`, {
      method: 'PUT',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        Origin: serverUrl,
      },
      body: JSON.stringify({ theme: 'light' }),
    });

    expect(res.status).toBe(403);
  });

  it('rejects invalid theme values like "sepia", "DARK", " eye-care " with 400', async () => {
    for (const invalid of ['sepia', 'DARK', ' eye-care ', 'solarized', '', 123]) {
      const res = await fetch(`${serverUrl}/api/account/preferences/theme`, {
        method: 'PUT',
        headers: {
          Cookie: aliceCookie,
          'Content-Type': 'application/json',
          'x-enkeep-csrf': csrfToken,
          Origin: serverUrl,
        },
        body: JSON.stringify({ theme: invalid }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain('Invalid theme value');
    }

    // null value rejected
    const resNull = await fetch(`${serverUrl}/api/account/preferences/theme`, {
      method: 'PUT',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': csrfToken,
        Origin: serverUrl,
      },
      body: JSON.stringify({ theme: null }),
    });
    expect(resNull.status).toBe(400);
  });

  it('rejects unknown fields in body with 400', async () => {
    const res = await fetch(`${serverUrl}/api/account/preferences/theme`, {
      method: 'PUT',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': csrfToken,
        Origin: serverUrl,
      },
      body: JSON.stringify({ theme: 'light', extra: 'bad' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain('Unexpected field "extra"');
  });

  it('PATCH /api/account/preferences supports updating theme independently from locale', async () => {
    // 1. Update theme only
    const res1 = await fetch(`${serverUrl}/api/account/preferences`, {
      method: 'PATCH',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': csrfToken,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({ theme: 'eye-care' }),
    });

    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.data).toEqual({
      locale: 'en',
      theme: 'eye-care',
    });

    // 2. Update locale only -> preserves theme
    const res2 = await fetch(`${serverUrl}/api/account/preferences`, {
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

    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.data).toEqual({
      locale: 'zh-CN',
      theme: 'eye-care',
    });

    // 3. Update both
    const res3 = await fetch(`${serverUrl}/api/account/preferences`, {
      method: 'PATCH',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': csrfToken,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({ locale: 'en', theme: 'light' }),
    });

    expect(res3.status).toBe(200);
    const body3 = await res3.json();
    expect(body3.data).toEqual({
      locale: 'en',
      theme: 'light',
    });
  });

  it('enforces multi-tenant isolation for theme preferences', async () => {
    // Alice sets theme to 'light'
    await fetch(`${serverUrl}/api/account/preferences/theme`, {
      method: 'PUT',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': csrfToken,
        Origin: serverUrl,
      },
      body: JSON.stringify({ theme: 'light' }),
    });

    // Bob sets theme to 'eye-care'
    await fetch(`${serverUrl}/api/account/preferences/theme`, {
      method: 'PUT',
      headers: {
        Cookie: bobCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': csrfToken,
        Origin: serverUrl,
      },
      body: JSON.stringify({ theme: 'eye-care' }),
    });

    // Check Alice's preferences
    const aliceRes = await fetch(`${serverUrl}/api/account/preferences/theme`, {
      method: 'GET',
      headers: { Cookie: aliceCookie },
    });
    const aliceBody = await aliceRes.json();
    expect(aliceBody.data.theme).toBe('light');

    // Check Bob's preferences
    const bobRes = await fetch(`${serverUrl}/api/account/preferences/theme`, {
      method: 'GET',
      headers: { Cookie: bobCookie },
    });
    const bobBody = await bobRes.json();
    expect(bobBody.data.theme).toBe('eye-care');
  });

  // 3. Migration 27 vs 28 Upgrade Verification
  it('verifies that migration 27 has NO theme column, and upgrading from 27 to 28 adds theme column with default "dark"', async () => {
    const freshDb = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(freshDb);

    // Apply migrations up to 27 (Queue only)
    const v27Migrations = ALL_PLATFORM_MIGRATIONS.filter((m) => m.version <= 27);
    await runner.migrate(v27Migrations);

    // Verify version is 27
    const ver27 = await runner.getCurrentVersion();
    expect(ver27).toBe(27);

    // Verify tableInfo on users table under v27 has NO theme column
    const tableInfo27 = freshDb.prepare("PRAGMA table_info(users)").all() as unknown as Array<{ name: string }>;
    expect(tableInfo27.some((col) => col.name === 'theme')).toBe(false);

    // Insert legacy user before v28 (valid under v27 schema)
    freshDb.prepare(`
      INSERT INTO users (id, username, password_hash, role, status, display_name, locale, created_at, updated_at)
      VALUES ('u_legacy_v27', 'legacy_user', 'scrypt$hash', 'user', 'active', 'Legacy User', 'en', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run();

    // Now apply migration 28 (Theme preference)
    const v28Migrations = ALL_PLATFORM_MIGRATIONS.filter((m) => m.version <= 28);
    const newlyApplied = await runner.migrate(v28Migrations);
    expect(newlyApplied.length).toBe(1);
    expect(newlyApplied[0].version).toBe(28);
    expect(newlyApplied[0].name).toBe('028_user_theme_preference');

    // Verify version is 28
    const ver28 = await runner.getCurrentVersion();
    expect(ver28).toBe(28);

    // Verify tableInfo on users table under v28 HAS theme column
    const tableInfo28 = freshDb.prepare("PRAGMA table_info(users)").all() as unknown as Array<{ name: string }>;
    expect(tableInfo28.some((col) => col.name === 'theme')).toBe(true);

    // Verify legacy user now has backfilled theme 'dark'
    const userRow = freshDb.prepare('SELECT id, username, theme FROM users WHERE id = ?').get('u_legacy_v27') as {
      id: string;
      username: string;
      theme: string;
    };
    expect(userRow.theme).toBe('dark');

    // Verify inserting and updating theme on v28 schema
    freshDb.prepare(`
      UPDATE users SET theme = 'eye-care' WHERE id = 'u_legacy_v27'
    `).run();
    const updatedRow = freshDb.prepare('SELECT theme FROM users WHERE id = ?').get('u_legacy_v27') as { theme: string };
    expect(updatedRow.theme).toBe('eye-care');

    freshDb.close();
  });
});
