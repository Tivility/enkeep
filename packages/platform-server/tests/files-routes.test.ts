/**
 * Files Workbench HTTP API Route Integration Tests (Canonical /api/spaces/:spaceId/files*)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { provisionFixtures, DefaultAuthService } from '@enkeep/platform-auth';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { PlatformError, NotFoundError } from '@enkeep/platform-core';
import {
  createPlatformServerHandler,
  SqlitePlatformWebApiAdapter,
  SqliteWebMessageStore,
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  type TenantRuntimeFileProvider,
  type CanonicalFileOperationRequest,
  type CanonicalFileOperationResult,
} from '../src/index.js';
import { TestOnlyRuntimeGateway } from './test-runtime-gateway.js';

function computeTestEtag(data: string | Buffer): string {
  return `"${createHash('sha256').update(data).digest('hex')}"`;
}

describe('Files Workbench HTTP REST Routes Integration', () => {
  let server: Server;
  let serverWithoutProvider: Server;
  let baseUrl: string;
  let baseUrlWithoutProvider: string;
  let aliceCookie: string;
  let bobCookie: string;
  let aliceSpaceId: string;
  let aliceArchivedSpaceId: string;
  let bobSpaceId: string;
  let aliceSpaceFolder: string;
  const testCsrfToken = 'files-workbench-csrf-token-32-chars-ok!';

  // In-memory mock filesystem for active container
  const containerFs = new Map<string, { content: string; mtimeMs: number }>();

  const mockFileProvider: TenantRuntimeFileProvider = {
    execute: vi.fn().mockImplementation(async (userId: string, spaceId: string, req: CanonicalFileOperationRequest): Promise<CanonicalFileOperationResult> => {
      const spaceFolder = spaceId === aliceSpaceId ? aliceSpaceFolder : spaceId;
      const relPath = req.path || '.';

      if (req.op === 'list') {
        const prefix = relPath === '.' ? `${spaceFolder}/` : `${spaceFolder}/${relPath}/`;
        const entries: Array<{ name: string; type: 'file' | 'directory'; size: number; mtimeMs: number; etag: string }> = [];
        const seenDirs = new Set<string>();

        for (const [key, val] of containerFs.entries()) {
          if (key.startsWith(prefix)) {
            const rest = key.slice(prefix.length);
            const slashIdx = rest.indexOf('/');
            if (slashIdx === -1) {
              entries.push({
                name: rest,
                type: 'file',
                size: Buffer.byteLength(val.content, 'utf8'),
                mtimeMs: val.mtimeMs,
                etag: computeTestEtag(val.content),
              });
            } else {
              const dirName = rest.slice(0, slashIdx);
              if (!seenDirs.has(dirName)) {
                seenDirs.add(dirName);
                entries.push({
                  name: dirName,
                  type: 'directory',
                  size: 0,
                  mtimeMs: 1600000000000,
                  etag: computeTestEtag(dirName),
                });
              }
            }
          }
        }

        return {
          op: 'list',
          path: relPath,
          entries,
          truncated: false,
        };
      }

      if (req.op === 'read') {
        const fullKey = `${spaceFolder}/${relPath}`;
        const found = containerFs.get(fullKey);
        if (!found) {
          throw new NotFoundError(`File "${relPath}" not found`);
        }
        return {
          op: 'read',
          path: relPath,
          content: found.content,
          encoding: req.encoding ?? 'utf8',
          type: 'file',
          size: Buffer.byteLength(found.content, 'utf8'),
          mtimeMs: found.mtimeMs,
          etag: computeTestEtag(found.content),
        };
      }

      if (req.op === 'write') {
        const fullKey = `${spaceFolder}/${relPath}`;
        const existing = containerFs.get(fullKey);

        if (req.requireAbsent && existing) {
          throw new PlatformError(`File "${relPath}" already exists`, 'CONFLICT', 409);
        }

        if (req.expectedEtag) {
          if (!existing) {
            throw new NotFoundError(`File "${relPath}" not found for update`);
          }
          const currentEtag = computeTestEtag(existing.content);
          const reqEtag = req.expectedEtag.startsWith('"') ? req.expectedEtag : `"${req.expectedEtag}"`;
          if (currentEtag !== reqEtag) {
            throw new PlatformError(`ETag mismatch for "${relPath}"`, 'CONFLICT', 409);
          }
        }

        const now = Date.now();
        containerFs.set(fullKey, { content: req.content, mtimeMs: now });
        return {
          op: 'write',
          path: relPath,
          type: 'file',
          size: Buffer.byteLength(req.content, 'utf8'),
          mtimeMs: now,
          etag: computeTestEtag(req.content),
        };
      }

      if (req.op === 'mkdir') {
        const fullKey = `${spaceFolder}/${relPath}`;
        return {
          op: 'mkdir',
          path: relPath,
          type: 'directory',
          size: 0,
          mtimeMs: 1600000000000,
          etag: computeTestEtag('dir'),
        };
      }

      if (req.op === 'delete') {
        const fullKey = `${spaceFolder}/${relPath}`;
        const existing = containerFs.get(fullKey);

        if (req.expectedEtag) {
          if (!existing) {
            throw new NotFoundError(`File "${relPath}" not found for deletion`);
          }
          const currentEtag = computeTestEtag(existing.content);
          const reqEtag = req.expectedEtag.startsWith('"') ? req.expectedEtag : `"${req.expectedEtag}"`;
          if (currentEtag !== reqEtag) {
            throw new PlatformError(`ETag mismatch for deletion of "${relPath}"`, 'CONFLICT', 409);
          }
        }

        containerFs.delete(fullKey);
        return {
          op: 'delete',
          path: relPath,
          type: 'file',
          size: 0,
          mtimeMs: 1600000000000,
          etag: computeTestEtag('del'),
        };
      }

      throw new PlatformError(`Unsupported file operation`, 'BAD_REQUEST', 400);
    }),
  };

  beforeAll(async () => {
    const db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    const storage = new SqlitePlatformStorage(db);
    const authService = new DefaultAuthService(storage, {
      cookieSecret: 'files-cookie-secret-32-chars-long!',
    });
    const messageStore = new SqliteWebMessageStore(db);
    const platformApi = new SqlitePlatformWebApiAdapter({
      storage,
      authService,
      messageStore,
      db,
    });
    const runtimeGateway = new TestOnlyRuntimeGateway({ storage, messageStore });

    const handler = createPlatformServerHandler({
      database: db,
      authService,
      platformApi,
      fileProvider: mockFileProvider,
      runtimeGateway,
      csrfToken: testCsrfToken,
      cookieSecret: 'files-cookie-secret-32-chars-long!',
    });

    server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as any;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const handlerWithoutProvider = createPlatformServerHandler({
      database: db,
      authService,
      platformApi,
      fileProvider: undefined,
      runtimeGateway,
      csrfToken: testCsrfToken,
      cookieSecret: 'files-cookie-secret-32-chars-long!',
    });
    serverWithoutProvider = createServer(handlerWithoutProvider);
    await new Promise<void>((resolve) => serverWithoutProvider.listen(0, '127.0.0.1', () => resolve()));
    const addrNoProv = serverWithoutProvider.address() as any;
    baseUrlWithoutProvider = `http://127.0.0.1:${addrNoProv.port}`;

    const fixtures = await provisionFixtures(storage, authService, {
      adminUsername: 'alice',
      adminPassword: 'AlicePassword123!',
      userUsername: 'bob',
      userPassword: 'BobPassword123!',
      disabledUsername: 'charlie',
      disabledPassword: 'CharliePassword123!',
    });
    aliceSpaceId = fixtures.adminContainerSpace.id;
    aliceSpaceFolder = fixtures.adminContainerSpace.folder || fixtures.adminContainerSpace.name;
    bobSpaceId = fixtures.userContainerSpace.id;

    const aliceTenant = storage.forTenant(fixtures.admin.id);
    const archivedSpace = await aliceTenant.spaces.create({
      name: 'Archived Project',
      folder: 'space-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      executionMode: 'container',
      status: 'archived',
    });
    aliceArchivedSpaceId = archivedSpace.id;

    containerFs.set(`${aliceSpaceFolder}/README.md`, {
      content: '# Safe Container Volume\nWelcome to Enkeep sandbox.\n',
      mtimeMs: 1600000000000,
    });
    containerFs.set(`${aliceSpaceFolder}/src/index.ts`, {
      content: 'console.log("Hello sandbox");\n',
      mtimeMs: 1600000001000,
    });

    const aliceRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ username: 'alice', password: 'AlicePassword123!' }),
    });
    aliceCookie = aliceRes.headers.get('set-cookie')?.split(';')[0] || '';

    const bobRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ username: 'bob', password: 'BobPassword123!' }),
    });
    bobCookie = bobRes.headers.get('set-cookie')?.split(';')[0] || '';
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => serverWithoutProvider.close(() => resolve()));
  });

  describe('1. Unauthenticated & Authorization Controls', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const res = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files`);
      expect(res.status).toBe(401);

      const contentRes = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/content?path=README.md`);
      expect(contentRes.status).toBe(401);
    });

    it('rejects CSRF missing on mutating requests with 403', async () => {
      const putRes = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/content`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
        },
        body: JSON.stringify({ path: 'test.txt', content: 'hello', requireAbsent: true }),
      });
      expect(putRes.status).toBe(403);
    });
  });

  describe('2. GET /api/spaces/:spaceId/files (Listing)', () => {
    it('lists directory files successfully and never reveals host paths', async () => {
      const res = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files?path=.`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.path).toBe('.');
      expect(json.data.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'README.md', type: 'file' }),
          expect.objectContaining({ name: 'src', type: 'directory' }),
        ])
      );
      const rawText = JSON.stringify(json);
      expect(rawText).not.toContain('/Users/');
      expect(rawText).not.toContain('/home/dsh/');
    });

    it('strictly rejects space or folder query parameter with 400', async () => {
      const res = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files?folder=arbitrary&path=.`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.message).toMatch(/strictly forbidden/i);
    });

    it('strictly rejects path traversal in listing query', async () => {
      const res = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files?path=../outside`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.message).toMatch(/Path traversal/);
    });
  });

  describe('3. GET /api/spaces/:spaceId/files/content (Reading)', () => {
    it('reads UTF-8 file content and sets authoritative ETag header', async () => {
      const res = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/content?path=README.md`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{64}"$/);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.path).toBe('README.md');
      expect(json.data.content).toContain('Safe Container Volume');
      expect(json.data.etag).toBe(res.headers.get('etag'));
    });

    it('rejects read when path parameter is missing', async () => {
      const res = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/content`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(400);
    });

    it('rejects read with path traversal with 400', async () => {
      const res = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/content?path=../../etc/passwd`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(400);
    });
  });

  describe('4. PUT /api/spaces/:spaceId/files/content (Writing)', () => {
    it('rejects write without body precondition with 400', async () => {
      const res = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/content`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({
          path: 'notes.txt',
          content: 'Important notes',
        }),
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.message).toMatch(/requires exactly one of "expectedEtag"/);
    });

    it('writes file with valid requireAbsent in body', async () => {
      const res = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/content`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({
          path: 'notes.txt',
          content: 'Important notes created securely.',
          requireAbsent: true,
        }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.written).toBe(true);
      expect(json.data.path).toBe('notes.txt');
      expect(res.headers.get('etag')).toBe(json.data.etag);
    });

    it('enforces optimistic concurrency (body expectedEtag) and returns 409 Conflict on mismatch', async () => {
      const getRes = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/content?path=README.md`, {
        headers: { Cookie: aliceCookie },
      });
      const currentEtag = getRes.headers.get('etag')!;

      const staleRes = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/content`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({
          path: 'README.md',
          content: 'Stale update',
          expectedEtag: computeTestEtag('stale_hash_value_12345'),
        }),
      });
      expect(staleRes.status).toBe(409);
      const staleJson = await staleRes.json();
      expect(staleJson.error.code).toBe('CONFLICT');

      const okRes = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/content`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({
          path: 'README.md',
          content: '# Updated Sandbox Content\n',
          expectedEtag: currentEtag,
        }),
      });
      expect(okRes.status).toBe(200);
      const okJson = await okRes.json();
      expect(okJson.success).toBe(true);
      expect(okJson.data.written).toBe(true);
    });
  });

  describe('5. POST /api/spaces/:spaceId/files/mkdir (Create Directory)', () => {
    it('creates directory and requires CSRF', async () => {
      const res = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/mkdir`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({ path: 'docs/architecture' }),
      });
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.created).toBe(true);
      expect(json.data.path).toBe('docs/architecture');
    });

    it('rejects traversal path in mkdir with 400', async () => {
      const res = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/mkdir`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({ path: '../outside' }),
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.message).toMatch(/Path traversal/);
    });
  });

  describe('6. DELETE /api/spaces/:spaceId/files (Delete File)', () => {
    it('deletes file with expectedEtag in JSON body', async () => {
      const getRes = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/content?path=notes.txt`, {
        headers: { Cookie: aliceCookie },
      });
      const currentEtag = getRes.headers.get('etag')!;

      const res = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({
          path: 'notes.txt',
          expectedEtag: currentEtag,
        }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.deleted).toBe(true);
    });

    it('strictly forbids deleting space root directory with 403', async () => {
      const res = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({
          path: '.',
          expectedEtag: computeTestEtag('any'),
        }),
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.message).toMatch(/strictly prohibited/);
    });
  });

  describe('7. Isolation & Negative Cases', () => {
    it('strictly isolates cross-tenant access: Bob cannot access Alice space (returns 404)', async () => {
      const listRes = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files`, {
        headers: { Cookie: bobCookie },
      });
      expect(listRes.status).toBe(404);

      const readRes = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/content?path=README.md`, {
        headers: { Cookie: bobCookie },
      });
      expect(readRes.status).toBe(404);

      const writeRes = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/content`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: bobCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({
          path: 'hack.txt',
          content: 'unauthorized',
          requireAbsent: true,
        }),
      });
      expect(writeRes.status).toBe(404);
    });

    it('rejects operations on archived space with 409 SPACE_ARCHIVED', async () => {
      const listRes = await fetch(`${baseUrl}/api/spaces/${aliceArchivedSpaceId}/files`, {
        headers: { Cookie: aliceCookie },
      });
      expect(listRes.status).toBe(409);
      const listJson = await listRes.json();
      expect(listJson.error.code).toBe('SPACE_ARCHIVED');

      const writeRes = await fetch(`${baseUrl}/api/spaces/${aliceArchivedSpaceId}/files/content`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({
          path: 'test.txt',
          content: 'blocked',
          requireAbsent: true,
        }),
      });
      expect(writeRes.status).toBe(409);
      const writeJson = await writeRes.json();
      expect(writeJson.error.code).toBe('SPACE_ARCHIVED');
    });

    it('returns 503 SERVICE_UNAVAILABLE when container runtime provider is offline / missing', async () => {
      const offlineRes = await fetch(`${baseUrlWithoutProvider}/api/spaces/${aliceSpaceId}/files`, {
        headers: { Cookie: aliceCookie },
      });
      expect(offlineRes.status).toBe(503);
      const offlineJson = await offlineRes.json();
      expect(offlineJson.error.code).toBe('SERVICE_UNAVAILABLE');
    });

    it('returns 404 for removed /api/manage/files and rename endpoints', async () => {
      const manageRes = await fetch(`${baseUrl}/api/manage/files`, {
        headers: { Cookie: aliceCookie },
      });
      expect(manageRes.status).toBe(404);

      const renameRes = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/rename`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({ oldPath: 'a', newPath: 'b' }),
      });
      expect(renameRes.status).toBe(404);
    });
  });
});
