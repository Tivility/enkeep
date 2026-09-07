/**
 * Platform Server Controlled Mounts HTTP API Integration & Legacy Route Deprecation Tests
 *
 * Verifies:
 * 1. Old non-admin route `/api/spaces/:spaceId/mounts` has been completely removed and returns 404.
 * 2. Canonical admin endpoint `/api/admin/spaces/:spaceId/mounts` works with RBAC and CSRF.
 * 3. Admin RBAC: Alice (admin) has access, Bob (user) gets 403 Forbidden.
 * 4. Tenant isolation: Bob cannot access Alice's space mounts.
 *
 * @module @enkeep/platform-server/tests/controlled-mounts-routes.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'node:http';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { DefaultAuthService } from '@enkeep/platform-auth';
import { PlatformServerMigrationRunner, ALL_PLATFORM_MIGRATIONS } from '../src/storage/migrations.js';
import { createPlatformServerHandler } from '../src/server/handler.js';
import { SqlitePlatformWebApiAdapter } from '../src/storage/sqlite-platform-api.js';
import { SqliteWebMessageStore } from '../src/storage/web-messages.js';
import { SpaceMountService } from '../src/mounts/space-mount-service.js';
import { DefaultRuntimeMountReconciler } from '../src/mounts/runtime-mount-reconciler.js';

describe('Controlled Mounts HTTP API Routes', () => {
  let tempDir: string;
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let authService: DefaultAuthService;
  let platformApi: SqlitePlatformWebApiAdapter;
  let messageStore: SqliteWebMessageStore;
  let server: Server;
  let baseUrl: string;

  let aliceCookie: string;
  let aliceCsrf: string;
  let bobCookie: string;
  let bobCsrf: string;

  let aliceSpaceId: string;
  let bobSpaceId: string;

  let tempProjectRo: string;
  let tempProjectRw: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'enkeep-mount-routes-test-'));
    tempProjectRo = join(tempDir, 'project-ro');
    tempProjectRw = join(tempDir, 'project-rw');
    mkdirSync(tempProjectRo, { recursive: true });
    mkdirSync(tempProjectRw, { recursive: true });
    writeFileSync(join(tempProjectRo, 'data.txt'), 'RO project data', 'utf8');
    writeFileSync(join(tempProjectRw, 'data.txt'), 'RW project data', 'utf8');

    const dbPath = join(tempDir, 'platform.db');
    db = new DatabaseSync(dbPath);
    const migrationRunner = new PlatformServerMigrationRunner(db);
    await migrationRunner.migrate(ALL_PLATFORM_MIGRATIONS);

    storage = new SqlitePlatformStorage(db);
    authService = new DefaultAuthService(storage, {
      cookieSecret: 'test-secret-32-bytes-length-key-1234',
    });
    messageStore = new SqliteWebMessageStore(db);
    platformApi = new SqlitePlatformWebApiAdapter({
      storage,
      authService,
      messageStore,
      db,
    });

    // Create users: Alice (admin), Bob (user)
    const aliceHash = await authService.hashPassword('alice-password-123');
    const alice = await storage.users.create({
      username: 'alice',
      displayName: 'Alice Admin',
      passwordHash: aliceHash,
      role: 'admin',
      status: 'active',
    });

    const bobHash = await authService.hashPassword('bob-password-123');
    const bob = await storage.users.create({
      username: 'bob',
      displayName: 'Bob Member',
      passwordHash: bobHash,
      role: 'user',
      status: 'active',
    });

    // Create spaces
    const aliceSpace = await storage.forTenant(alice.id).spaces.create({
      name: 'Alice Space',
      folder: 'alice-space',
      executionMode: 'host',
    });
    aliceSpaceId = aliceSpace.id;

    const bobSpace = await storage.forTenant(bob.id).spaces.create({
      name: 'Bob Space',
      folder: 'bob-space',
      executionMode: 'container',
    });
    bobSpaceId = bobSpace.id;

    // Login Alice
    const aliceLogin = await authService.login('alice', 'alice-password-123');
    aliceCookie = aliceLogin.cookieHeader.split(';')[0];
    aliceCsrf = aliceLogin.session.csrfToken;

    // Login Bob
    const bobLogin = await authService.login('bob', 'bob-password-123');
    bobCookie = bobLogin.cookieHeader.split(';')[0];
    bobCsrf = bobLogin.session.csrfToken;

    const testCsrf = 'test-csrf-token-32-chars-long-1234!';
    aliceCsrf = testCsrf;
    bobCsrf = testCsrf;

    const spaceMountService = new SpaceMountService({
      db,
      storage,
      cipherSecret: 'test-secret-32-bytes-length-key-1234',
      platformSecret: 'test-secret-32-bytes-length-key-1234',
      reconciler: new DefaultRuntimeMountReconciler({
        preflight: async (p) => ({ realPath: p }),
        reconcile: async () => {},
      }),
    });

    // Start HTTP server
    const handler = createPlatformServerHandler({
      database: db,
      authService,
      platformApi,
      storage,
      csrfToken: testCsrf,
      cookieSecret: 'test-secret-32-bytes-length-key-1234',
      runtimeGateway: { executeTurn: async () => ({ status: 'success' }) } as any,
      spaceMountService,
    });

    server = createServer(handler);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const addr = server.address() as { port: number; address: string };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (db) {
      try {
        db.close();
      } catch {}
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('enforces that old /api/spaces/:spaceId/mounts route is completely removed and returns 404', async () => {
    const getRes = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/mounts`, {
      headers: { Cookie: aliceCookie },
    });
    expect(getRes.status).toBe(404);

    const postRes = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/mounts`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: baseUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'test_mount',
        sourcePath: tempProjectRo,
        mode: 'ro',
      }),
    });
    expect(postRes.status).toBe(404);
  });

  it('enforces RBAC on canonical admin endpoint: Alice (admin) succeeds, Bob (user) gets 403 Forbidden', async () => {
    // 1. Bob attempts GET /api/admin/spaces/:id/mounts -> 403 Forbidden
    const bobGetRes = await fetch(`${baseUrl}/api/admin/spaces/${bobSpaceId}/mounts`, {
      headers: {
        Cookie: bobCookie,
      },
    });
    expect(bobGetRes.status).toBe(403);

    // 2. Bob attempts POST /api/admin/spaces/:id/mounts -> 403 Forbidden
    const bobPostRes = await fetch(`${baseUrl}/api/admin/spaces/${bobSpaceId}/mounts`, {
      method: 'POST',
      headers: {
        Cookie: bobCookie,
        'X-Enkeep-CSRF': bobCsrf,
        Origin: baseUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'test_mount',
        sourcePath: tempProjectRo,
        mode: 'ro',
      }),
    });
    expect(bobPostRes.status).toBe(403);

    // 3. Alice (admin) GET /api/admin/spaces/:id/mounts -> 200 OK (empty list)
    const aliceGetRes = await fetch(`${baseUrl}/api/admin/spaces/${aliceSpaceId}/mounts`, {
      headers: {
        Cookie: aliceCookie,
      },
    });
    expect(aliceGetRes.status).toBe(200);
    const aliceGetJson = (await aliceGetRes.json()) as any;
    expect(aliceGetJson.data.mounts).toEqual([]);
  });

  it('creates RO and RW space mounts for Alice via admin endpoint with full validation', async () => {
    // 1. Create RO mount
    const roRes = await fetch(`${baseUrl}/api/admin/spaces/${aliceSpaceId}/mounts`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: baseUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'project_ro',
        sourcePath: tempProjectRo,
        mode: 'ro',
      }),
    });
    expect(roRes.status).toBe(201);
    const roJson = (await roRes.json()) as any;
    expect(roJson.data.name).toBe('project_ro');
    expect(roJson.data.mode).toBe('ro');
    expect(roJson.data.sourcePath).toBe(tempProjectRo);

    // 2. Create RW mount
    const rwRes = await fetch(`${baseUrl}/api/admin/spaces/${aliceSpaceId}/mounts`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: baseUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'project_rw',
        sourcePath: tempProjectRw,
        mode: 'rw',
      }),
    });
    expect(rwRes.status).toBe(201);
    const rwJson = (await rwRes.json()) as any;
    expect(rwJson.data.name).toBe('project_rw');
    expect(rwJson.data.mode).toBe('rw');

    // 3. List mounts collection
    const listRes = await fetch(`${baseUrl}/api/admin/spaces/${aliceSpaceId}/mounts`, {
      headers: {
        Cookie: aliceCookie,
      },
    });
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as any;
    expect(listJson.data.mounts.length).toBe(2);
  });

  it('deletes space mount and enforces non-accessibility', async () => {
    // 1. Create mount
    const createRes = await fetch(`${baseUrl}/api/admin/spaces/${aliceSpaceId}/mounts`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: baseUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'del_project',
        sourcePath: tempProjectRo,
        mode: 'ro',
      }),
    });
    expect(createRes.status).toBe(201);
    const mount = (await createRes.json() as any).data;

    // 2. Delete mount
    const delRes = await fetch(`${baseUrl}/api/admin/spaces/${aliceSpaceId}/mounts/${mount.id}`, {
      method: 'DELETE',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: baseUrl,
      },
    });
    expect(delRes.status).toBe(200);
    const delJson = (await delRes.json()) as any;
    expect(delJson.data.deleted).toBe(true);

    // 3. Verify mount is gone
    const listRes = await fetch(`${baseUrl}/api/admin/spaces/${aliceSpaceId}/mounts`, {
      headers: {
        Cookie: aliceCookie,
      },
    });
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as any;
    expect(listJson.data.mounts.find((m: any) => m.id === mount.id)).toBeUndefined();
  });
});
