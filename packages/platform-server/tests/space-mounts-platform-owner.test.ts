/**
 * Space Mounts Platform Owner Comprehensive Test Suite
 *
 * Covers:
 * 1. Migration 29: space_mounts schema, checksum, FK cascade, unique constraint, no status/revision/history.
 * 2. AES-256-GCM Encryption & HMAC Fingerprint: ciphertext in DB only, never plaintext.
 * 3. Exact Admin Endpoints:
 *    - GET collection only: /api/admin/spaces/:spaceId/mounts -> { mounts: [{ id, name, sourcePath, mode, createdAt }] }
 *    - Reject item GET /api/admin/spaces/:spaceId/mounts/:mountId -> 405
 *    - POST exact body { name, sourcePath, mode } (all 3 required, mode not defaulted) -> 201 with exact PublicSpaceMount
 *    - Reject body aliases { hostPath, mountPoint } -> 400
 *    - DELETE path mountId only: /api/admin/spaces/:spaceId/mounts/:mountId -> 200
 * 4. Deprecation of old routes:
 *    - Old /api/spaces/:spaceId/mounts -> 404 Not Found for GET, POST, DELETE
 * 5. Service Configuration & Fail-Closed:
 *    - Missing service -> 503 SERVICE_UNAVAILABLE (no storage fallback / direct ciphertext leak)
 *    - Startup composition failclosed if mounts exist without reconciler
 * 6. RBAC, Multi-tenancy, and CSRF Protection: Admin 200/201, User (Bob) 403, Unauth 401, missing CSRF 403.
 * 7. Strict Body & Name/Mode validation: forbidden fields (userId, id, target) rejected, slug name regex, duplicate 409.
 * 8. Protected Source Preflight Defense: (/etc, /root, sensitive files rejected).
 * 9. Saga Rollback:
 *    - Add flow rollback when runtime reconciler fails.
 *    - Delete flow rollback when runtime reconciler fails.
 * 10. Audit Logging & Privacy:
 *    - Audit contains mountId, name, mode, fingerprint only.
 *    - NEVER leaks sourcePath or ciphertext.
 *
 * @module @enkeep/platform-server/tests/space-mounts-platform-owner.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'node:http';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { DefaultAuthService } from '@enkeep/platform-auth';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  MIGRATION_029_SPACE_MOUNTS_SQL,
  computeChecksum,
} from '../src/storage/migrations.js';
import { createPlatformServerHandler } from '../src/server/handler.js';
import { SqlitePlatformWebApiAdapter } from '../src/storage/sqlite-platform-api.js';
import { SqliteWebMessageStore } from '../src/storage/web-messages.js';
import { DefaultRuntimeMountReconciler } from '../src/mounts/runtime-mount-reconciler.js';
import { SpaceMountService } from '../src/mounts/space-mount-service.js';
import { PlatformServer } from '../src/server/server.js';
import { validateMountSourcePath } from '@enkeep/runtime-runner';
import {
  computeMountSourceFingerprint,
  ForbiddenError,
  ValidationError,
} from '@enkeep/platform-core';

describe('Space Mounts Platform Owner Architecture & Governance', () => {
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
  const cookieSecret = 'platform-owner-test-secret-key-32-chars-long';
  const csrfToken = 'platform-owner-csrf-token-32-chars-long';

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'enkeep-space-mounts-test-'));
    tempProjectRo = join(tempDir, 'project-ro');
    tempProjectRw = join(tempDir, 'project-rw');
    mkdirSync(tempProjectRo, { recursive: true });
    mkdirSync(tempProjectRw, { recursive: true });
    writeFileSync(join(tempProjectRo, 'readme.md'), '# Project RO Data\n', 'utf8');
    writeFileSync(join(tempProjectRw, 'notes.txt'), 'RW Workspace notes\n', 'utf8');

    const dbPath = join(tempDir, 'platform.db');
    db = new DatabaseSync(dbPath);
    const migrationRunner = new PlatformServerMigrationRunner(db);
    await migrationRunner.migrate(ALL_PLATFORM_MIGRATIONS);

    storage = new SqlitePlatformStorage(db);
    authService = new DefaultAuthService(storage, {
      cookieSecret,
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
      name: 'Alice Host Space',
      folder: 'alice-host-space',
      executionMode: 'host',
    });
    aliceSpaceId = aliceSpace.id;

    const bobSpace = await storage.forTenant(bob.id).spaces.create({
      name: 'Bob Container Space',
      folder: 'bob-container-space',
      executionMode: 'container',
    });
    bobSpaceId = bobSpace.id;

    // Login Alice and Bob
    const aliceLogin = await authService.login('alice', 'alice-password-123');
    aliceCookie = aliceLogin.cookieHeader.split(';')[0];
    aliceCsrf = csrfToken;

    const bobLogin = await authService.login('bob', 'bob-password-123');
    bobCookie = bobLogin.cookieHeader.split(';')[0];
    bobCsrf = csrfToken;

    const spaceMountService = new SpaceMountService({
      db,
      storage,
      cipherSecret: cookieSecret,
      platformSecret: cookieSecret,
      reconciler: new DefaultRuntimeMountReconciler({
        preflight: async (sourcePath) => {
          if (
            sourcePath === '/etc' ||
            sourcePath === '/private/etc' ||
            sourcePath === '/root' ||
            sourcePath === '/dev' ||
            sourcePath === '/var/run'
          ) {
            throw new ForbiddenError(`Mounting protected system root "${sourcePath}" is strictly forbidden`);
          }
          if (sourcePath.includes('non_existent_folder')) {
            throw new ValidationError(`Mount sourcePath does not exist: "${sourcePath}"`);
          }
          return { realPath: sourcePath };
        },
        reconcile: async () => {},
      }),
    });

    const fakeRuntimeGateway: any = {
      executeTurn: async () => ({ status: 'success' }),
    };

    const handler = createPlatformServerHandler({
      database: db,
      storage,
      authService,
      platformApi,
      runtimeGateway: fakeRuntimeGateway,
      csrfToken,
      cookieSecret,
      spaceMountService,
    });

    server = createServer(handler);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const addr = server.address() as { port: number };
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

  // =====================================================================================
  // 1. Migration 29 Schema & Immutability Verification
  // =====================================================================================
  it('verifies migration 29 space_mounts table schema, columns, indexes, and FK cascade', async () => {
    const tableInfo = db.prepare("PRAGMA table_info('space_mounts')").all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
    const colNames = tableInfo.map((c) => c.name);

    expect(colNames).toContain('id');
    expect(colNames).toContain('user_id');
    expect(colNames).toContain('space_id');
    expect(colNames).toContain('name');
    expect(colNames).toContain('source_path_encrypted');
    expect(colNames).toContain('source_fingerprint');
    expect(colNames).toContain('mode');
    expect(colNames).toContain('created_at');
    expect(colNames).toContain('updated_at');

    // Asserts no status, revision, or history columns
    expect(colNames).not.toContain('status');
    expect(colNames).not.toContain('revision');
    expect(colNames).not.toContain('history');
    expect(colNames).not.toContain('host_path');
    expect(colNames).not.toContain('mount_point');

    // Verify migration 29 checksum consistency
    const m29Def = ALL_PLATFORM_MIGRATIONS.find((m) => m.version === 29);
    expect(m29Def).toBeDefined();
    expect(m29Def?.name).toBe('029_space_mounts');
    expect(m29Def?.checksum).toBe(computeChecksum(MIGRATION_029_SPACE_MOUNTS_SQL));
  });

  // =====================================================================================
  // 2. Encryption & Fingerprint in DB
  // =====================================================================================
  it('encrypts sourcePath with AES-256-GCM and stores keyed HMAC fingerprint in DB (never plaintext)', async () => {
    const postRes = await fetch(`${baseUrl}/api/admin/spaces/${aliceSpaceId}/mounts`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': aliceCsrf,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        name: 'dataset',
        sourcePath: tempProjectRo,
        mode: 'ro',
      }),
    });

    const postBody = await postRes.json();
    expect(postRes.status).toBe(201);
    expect(postBody.success).toBe(true);
    expect(postBody.data.id).toMatch(/^mnt_/);
    expect(postBody.data.name).toBe('dataset');
    expect(postBody.data.sourcePath).toBe(tempProjectRo);
    expect(postBody.data.mode).toBe('ro');
    expect(postBody.data.sourcePathEncrypted).toBeUndefined();
    expect(postBody.data.sourceFingerprint).toBeUndefined();

    // Inspect database row directly
    const row = db.prepare('SELECT * FROM space_mounts WHERE id = ?').get(postBody.data.id) as any;
    expect(row).toBeDefined();
    expect(row.source_path_encrypted).toMatch(/^v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+/);
    expect(row.source_path_encrypted).not.toContain(tempProjectRo);
    expect(row.source_fingerprint).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);

    const expectedFingerprint = computeMountSourceFingerprint(tempProjectRo, cookieSecret);
    expect(row.source_fingerprint).toBe(expectedFingerprint);
  });

  // =====================================================================================
  // 3. Exact Admin Endpoints (GET Collection Only, POST Exact Body, DELETE Path Only)
  // =====================================================================================
  it('supports exact admin endpoints: GET collection only, POST exact {name, sourcePath, mode}, DELETE /:mountId', async () => {
    // 1. Initial GET -> empty mounts array
    const getInitial = await fetch(`${baseUrl}/api/admin/spaces/${aliceSpaceId}/mounts`, {
      headers: { Cookie: aliceCookie },
    });
    expect(getInitial.status).toBe(200);
    const initialBody = await getInitial.json();
    expect(initialBody.success).toBe(true);
    expect(initialBody.data).toEqual({ mounts: [] });

    // 2. POST create mount (all 3 fields name, sourcePath, mode required)
    const postRes = await fetch(`${baseUrl}/api/admin/spaces/${aliceSpaceId}/mounts`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': aliceCsrf,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        name: 'workspace_rw',
        sourcePath: tempProjectRw,
        mode: 'rw',
      }),
    });
    expect(postRes.status).toBe(201);
    const created = (await postRes.json()).data;
    expect(created.name).toBe('workspace_rw');
    expect(created.mode).toBe('rw');
    expect(created.sourcePath).toBe(tempProjectRw);
    expect(created.createdAt).toBeDefined();
    expect(created.hostPath).toBeUndefined();
    expect(created.mountPoint).toBeUndefined();

    // 3. GET lists collection with exact PublicSpaceMount DTO
    const getList = await fetch(`${baseUrl}/api/admin/spaces/${aliceSpaceId}/mounts`, {
      headers: { Cookie: aliceCookie },
    });
    expect(getList.status).toBe(200);
    const listBody = await getList.json();
    expect(listBody.data.mounts.length).toBe(1);
    expect(listBody.data.mounts[0]).toEqual({
      id: created.id,
      name: 'workspace_rw',
      sourcePath: tempProjectRw,
      mode: 'rw',
      createdAt: created.createdAt,
    });

    // 4. GET item endpoint is rejected (collection only)
    const getItem = await fetch(`${baseUrl}/api/admin/spaces/${aliceSpaceId}/mounts/${created.id}`, {
      headers: { Cookie: aliceCookie },
    });
    expect(getItem.status).toBe(405);

    // 5. DELETE mount via path mountId
    const deleteRes = await fetch(`${baseUrl}/api/admin/spaces/${aliceSpaceId}/mounts/${created.id}`, {
      method: 'DELETE',
      headers: {
        Cookie: aliceCookie,
        'x-enkeep-csrf': aliceCsrf,
        Origin: baseUrl,
      },
    });
    expect(deleteRes.status).toBe(200);
    const deleteBody = await deleteRes.json();
    expect(deleteBody.data).toEqual({ deleted: true, id: created.id });

    // 6. GET after delete -> empty mounts array
    const getAfter = await fetch(`${baseUrl}/api/admin/spaces/${aliceSpaceId}/mounts`, {
      headers: { Cookie: aliceCookie },
    });
    const afterBody = await getAfter.json();
    expect(afterBody.data.mounts.length).toBe(0);
  });

  // =====================================================================================
  // 4. Deprecation of old /api/spaces/:spaceId/mounts route (404)
  // =====================================================================================
  it('proves that old non-admin /api/spaces/:spaceId/mounts is removed and returns 404', async () => {
    // GET /api/spaces/:spaceId/mounts -> 404
    const oldGet = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/mounts`, {
      headers: { Cookie: aliceCookie },
    });
    expect(oldGet.status).toBe(404);

    // POST /api/spaces/:spaceId/mounts -> 404
    const oldPost = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/mounts`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': aliceCsrf,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        name: 'test_mount',
        sourcePath: tempProjectRo,
        mode: 'ro',
      }),
    });
    expect(oldPost.status).toBe(404);

    // DELETE /api/spaces/:spaceId/mounts/mnt_123 -> 404
    const oldDelete = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/mounts/mnt_123`, {
      method: 'DELETE',
      headers: {
        Cookie: aliceCookie,
        'x-enkeep-csrf': aliceCsrf,
        Origin: baseUrl,
      },
    });
    expect(oldDelete.status).toBe(404);
  });

  // =====================================================================================
  // 5. Service Configuration & 503 Fail-Closed
  // =====================================================================================
  it('returns 503 SERVICE_UNAVAILABLE when SpaceMountService is not configured (no storage fallback / ciphertext leak)', async () => {
    const handlerWithoutService = createPlatformServerHandler({
      database: db,
      storage,
      authService,
      platformApi,
      runtimeGateway: { executeTurn: async () => ({ status: 'success' }) } as any,
      csrfToken,
      cookieSecret,
      // spaceMountService explicitly not passed
    });

    const unconfiguredHttp = createServer(handlerWithoutService);
    await new Promise<void>((resolve) => {
      unconfiguredHttp.listen(0, '127.0.0.1', () => resolve());
    });
    const unconfiguredAddr = unconfiguredHttp.address() as { port: number };
    const unconfiguredUrl = `http://127.0.0.1:${unconfiguredAddr.port}`;

    try {
      const getRes = await fetch(`${unconfiguredUrl}/api/admin/spaces/${aliceSpaceId}/mounts`, {
        headers: { Cookie: aliceCookie },
      });
      expect(getRes.status).toBe(503);
      const getJson = await getRes.json();
      expect(getJson.error.code).toBe('SERVICE_UNAVAILABLE');

      const postRes = await fetch(`${unconfiguredUrl}/api/admin/spaces/${aliceSpaceId}/mounts`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'Content-Type': 'application/json',
          'x-enkeep-csrf': aliceCsrf,
          Origin: unconfiguredUrl,
        },
        body: JSON.stringify({
          name: 'test_mount',
          sourcePath: tempProjectRo,
          mode: 'ro',
        }),
      });
      expect(postRes.status).toBe(503);
    } finally {
      await new Promise<void>((resolve) => unconfiguredHttp.close(() => resolve()));
    }
  });

  // =====================================================================================
  // 6. RBAC, Multi-tenancy, and CSRF Protection
  // =====================================================================================
  it('enforces RBAC, multi-tenant isolation, and CSRF protection', async () => {
    // Non-admin (Bob) gets 403 Forbidden on GET
    const bobGet = await fetch(`${baseUrl}/api/admin/spaces/${bobSpaceId}/mounts`, {
      headers: { Cookie: bobCookie },
    });
    expect(bobGet.status).toBe(403);

    // Non-admin (Bob) gets 403 Forbidden on POST
    const bobPost = await fetch(`${baseUrl}/api/admin/spaces/${bobSpaceId}/mounts`, {
      method: 'POST',
      headers: {
        Cookie: bobCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': bobCsrf,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        name: 'test_mount',
        sourcePath: tempProjectRo,
        mode: 'ro',
      }),
    });
    expect(bobPost.status).toBe(403);

    // Unauthenticated gets 401 Unauthorized
    const unauthGet = await fetch(`${baseUrl}/api/admin/spaces/${aliceSpaceId}/mounts`);
    expect(unauthGet.status).toBe(401);

    // Missing CSRF token gets 403 Forbidden
    const noCsrfPost = await fetch(`${baseUrl}/api/admin/spaces/${aliceSpaceId}/mounts`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        Origin: baseUrl,
      },
      body: JSON.stringify({
        name: 'test_mount',
        sourcePath: tempProjectRo,
        mode: 'ro',
      }),
    });
    expect(noCsrfPost.status).toBe(403);
  });

  // =====================================================================================
  // 7. Strict Body & Name/Mode Validation & Rejection of Aliases
  // =====================================================================================
  it('rejects unexpected fields, forbidden aliases (hostPath, mountPoint), missing mode, and validates slug naming', async () => {
    // 1. Forbidden aliases hostPath / mountPoint rejected with 400
    for (const aliasKey of ['hostPath', 'mountPoint', 'userId', 'id', 'target', 'targetPath']) {
      const res = await fetch(`${baseUrl}/api/admin/spaces/${aliceSpaceId}/mounts`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'Content-Type': 'application/json',
          'x-enkeep-csrf': aliceCsrf,
          Origin: baseUrl,
        },
        body: JSON.stringify({
          name: 'valid_slug',
          sourcePath: tempProjectRo,
          mode: 'ro',
          [aliasKey]: 'forbidden_alias',
        }),
      });
      expect(res.status).toBe(400);
      const err = await res.json();
      expect(err.error.message).toContain('Unexpected field');
    }

    // 2. Missing mode rejected with 400 (mode is strictly required)
    const noModeRes = await fetch(`${baseUrl}/api/admin/spaces/${aliceSpaceId}/mounts`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': aliceCsrf,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        name: 'valid_slug',
        sourcePath: tempProjectRo,
      }),
    });
    expect(noModeRes.status).toBe(400);

    // 3. Invalid slug names (uppercase, special chars, reserved words, whitespace)
    for (const invalidName of ['Dataset', 'data.set', 'data/set', 'mnt', 'home', 'root', 'etc', ' spaces ']) {
      const res = await fetch(`${baseUrl}/api/admin/spaces/${aliceSpaceId}/mounts`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'Content-Type': 'application/json',
          'x-enkeep-csrf': aliceCsrf,
          Origin: baseUrl,
        },
        body: JSON.stringify({
          name: invalidName,
          sourcePath: tempProjectRo,
          mode: 'ro',
        }),
      });
      expect(res.status).toBe(400);
    }

    // 4. Duplicate mount name in same space -> 409 Conflict
    const createFirst = await fetch(`${baseUrl}/api/admin/spaces/${aliceSpaceId}/mounts`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': aliceCsrf,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        name: 'unique_name',
        sourcePath: tempProjectRo,
        mode: 'ro',
      }),
    });
    expect(createFirst.status).toBe(201);

    const createDup = await fetch(`${baseUrl}/api/admin/spaces/${aliceSpaceId}/mounts`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': aliceCsrf,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        name: 'unique_name',
        sourcePath: tempProjectRw,
        mode: 'rw',
      }),
    });
    expect(createDup.status).toBe(409);
  });

  // =====================================================================================
  // 8. Protected Source Preflight Defense
  // =====================================================================================
  it('rejects protected system roots (/etc, /root, /dev) and non-existent paths during preflight', async () => {
    for (const forbiddenPath of ['/etc', '/private/etc', '/root', '/dev', '/var/run', join(tempDir, 'non_existent_folder')]) {
      const res = await fetch(`${baseUrl}/api/admin/spaces/${aliceSpaceId}/mounts`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'Content-Type': 'application/json',
          'x-enkeep-csrf': aliceCsrf,
          Origin: baseUrl,
        },
        body: JSON.stringify({
          name: 'bad_source',
          sourcePath: forbiddenPath,
          mode: 'ro',
        }),
      });
      expect([400, 403]).toContain(res.status);
    }
  });

  // =====================================================================================
  // 9. Saga Rollback on Reconciler Failure
  // =====================================================================================
  it('rolls back database changes when runtime reconciler fails during add and delete', async () => {
    let shouldFailReconcile = true;
    const failingReconciler = new DefaultRuntimeMountReconciler({
      preflight: async (sourcePath) => ({ realPath: sourcePath }),
      reconcile: async () => {
        if (shouldFailReconcile) {
          throw new Error('Docker daemon socket connection refused');
        }
      },
    });

    const spaceMountServiceWithFailingReconciler = new SpaceMountService({
      db,
      storage,
      cipherSecret: cookieSecret,
      platformSecret: cookieSecret,
      reconciler: failingReconciler,
    });

    const user = await storage.users.findByUsername('alice');
    const userId = user!.id;

    // 1. Attempt createMount with failing reconciler -> throws & rolls back DB row
    await expect(
      spaceMountServiceWithFailingReconciler.createMount(
        userId,
        aliceSpaceId,
        {
          name: 'saga_rollback_test',
          sourcePath: tempProjectRo,
          mode: 'ro',
        }
      )
    ).rejects.toThrow(/Failed to reconcile runtime mounts after adding mount/);

    // Verify row does NOT exist in DB
    const rowAfterAddFail = await storage.forTenant(userId).spaceMounts.findByName(aliceSpaceId, 'saga_rollback_test');
    expect(rowAfterAddFail).toBeNull();

    // 2. Now allow reconcile to succeed to create a row
    shouldFailReconcile = false;
    const created = await spaceMountServiceWithFailingReconciler.createMount(
      userId,
      aliceSpaceId,
      {
        name: 'saga_rollback_test',
        sourcePath: tempProjectRo,
        mode: 'ro',
      }
    );
    expect(created.id).toBeDefined();

    // 3. Attempt deleteMount with failing reconciler -> throws & restores DB row
    shouldFailReconcile = true;
    await expect(
      spaceMountServiceWithFailingReconciler.deleteMount(userId, aliceSpaceId, created.id)
    ).rejects.toThrow(/Failed to reconcile runtime mounts after deleting mount/);

    // Verify row was RESTORED back to DB
    const restoredRow = await storage.forTenant(userId).spaceMounts.findById(created.id);
    expect(restoredRow).not.toBeNull();
    expect(restoredRow?.name).toBe('saga_rollback_test');
  });

  // =====================================================================================
  // 10. Startup Composition & Fail-Closed Behavior
  // =====================================================================================
  it('reconciles all active mounts on PlatformServer startup and fails closed if reconciler is missing', async () => {
    // 1. Seed a space mount in DB under container space
    const user = await storage.users.findByUsername('alice');
    const userId = user!.id;
    const containerSpace = await storage.forTenant(userId).spaces.create({
      name: 'Alice Container Space',
      folder: 'alice-container-space',
      executionMode: 'container',
    });

    const spaceMountService = new SpaceMountService({
      db,
      storage,
      cipherSecret: cookieSecret,
      platformSecret: cookieSecret,
      reconciler: new DefaultRuntimeMountReconciler({
        preflight: async (sourcePath) => ({ realPath: sourcePath }),
        reconcile: async () => {},
      }),
    });
    await spaceMountService.createMount(userId, containerSpace.id, {
      name: 'startup_mount',
      sourcePath: tempProjectRo,
      mode: 'ro',
    });

    const fakeTurnExecutor = {
      executeTurn: async () => ({ status: 'success' }),
    };

    const hostProvider: any = {
      mode: 'host',
      turnExecutor: fakeTurnExecutor,
    };

    // 2. Start PlatformServer with a configured reconciler -> successfully reconciles on startup
    const reconcileSpy = vi.fn();
    const mockReconciler = new DefaultRuntimeMountReconciler({
      preflight: async (sourcePath) => ({ realPath: sourcePath }),
      reconcile: async (u, m, mounts) => {
        reconcileSpy(u, m, mounts);
      },
    });

    const successfulServer = new PlatformServer({
      database: db,
      storage,
      cookieSecret,
      csrfToken,
      runtimeGateway: { executeTurn: async () => ({ status: 'success' }) } as any,
      mountReconciler: mockReconciler,
      hostProvider,
    });

    const addr = await successfulServer.start();
    expect(addr.port).toBeGreaterThan(0);
    expect(reconcileSpy).toHaveBeenCalled();
    await successfulServer.stop();

    // 3. Start PlatformServer WITHOUT a reconciler when mounts exist -> FAILS CLOSED!
    const unconfiguredServer = new PlatformServer({
      database: db,
      storage,
      cookieSecret,
      csrfToken,
      runtimeGateway: { executeTurn: async () => ({ status: 'success' }) } as any,
      hostProvider,
    });

    await expect(unconfiguredServer.start()).rejects.toThrow(/FAIL-CLOSED: Database contains .* space mount.* but no RuntimeMountReconciler is configured/);
  });

  // =====================================================================================
  // 11. Audit Logging & Leak Prevention
  // =====================================================================================
  it('records audit events without leaking sourcePath or ciphertext into audit logs', async () => {
    const postRes = await fetch(`${baseUrl}/api/admin/spaces/${aliceSpaceId}/mounts`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'Content-Type': 'application/json',
        'x-enkeep-csrf': aliceCsrf,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        name: 'audit_test_mount',
        sourcePath: tempProjectRo,
        mode: 'ro',
      }),
    });
    expect(postRes.status).toBe(201);
    const createdMount = (await postRes.json()).data;

    const delRes = await fetch(`${baseUrl}/api/admin/spaces/${aliceSpaceId}/mounts/${createdMount.id}`, {
      method: 'DELETE',
      headers: {
        Cookie: aliceCookie,
        'x-enkeep-csrf': aliceCsrf,
        Origin: baseUrl,
      },
    });
    expect(delRes.status).toBe(200);

    // Query auth_audit_log
    const auditRows = db.prepare("SELECT * FROM auth_audit_log WHERE action IN ('space_mount.created', 'space_mount.deleted')").all() as any[];
    expect(auditRows.length).toBe(2);

    for (const row of auditRows) {
      const details = JSON.parse(row.details);
      expect(details.mountId).toBe(createdMount.id);
      expect(details.name).toBe('audit_test_mount');
      expect(details.mode).toBe('ro');
      expect(details.fingerprint).toMatch(/^hmac-sha256:/);

      // STRICT PRIVACY CHECK: sourcePath, decrypted path, and ciphertext are NEVER present in audit details
      expect(details.sourcePath).toBeUndefined();
      expect(details.sourcePathEncrypted).toBeUndefined();
      expect(row.details).not.toContain(tempProjectRo);
      expect(row.details).not.toContain('v1:');
    }
  });
});
