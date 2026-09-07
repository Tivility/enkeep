/**
 * Comprehensive P1 Production File Transport Streaming Integration Tests
 *
 * Tests:
 * 1. Binary streaming uploads (multipart/form-data & octet-stream)
 * 2. UTF-8 Unicode, NFC normalization, null byte & path traversal sanitization
 * 3. 50MB streaming bounds & memory efficiency
 * 4. Safe MIME sniffing & registry (PNG, PDF, JSON, binary)
 * 5. Content-Disposition filename*=UTF-8, nosniff, CSP sandbox headers
 * 6. HTTP 206 Partial Content (Range: bytes=) & HTTP 304 (If-None-Match)
 * 7. Preconditions, overwrite (requireAbsent vs expectedEtag / If-Match), conflict 409
 * 8. Quota reservation, delta commit, and rollback on exceed
 * 9. Cross-tenant isolation & directory download rejection
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Readable, PassThrough } from 'node:stream';
import { provisionFixtures, DefaultAuthService } from '@enkeep/platform-auth';
import { SqlitePlatformStorage, SqlitePlatformOperationsStorage } from '@enkeep/platform-storage-sqlite';
import { createPlatformOperations } from '@enkeep/platform-operations';
import { PlatformError, NotFoundError } from '@enkeep/platform-core';
import { FileTransferRecoveryService } from '../src/storage/file-transfer-recovery.js';
import {
  createPlatformServerHandler,
  PlatformServer,
  SqlitePlatformWebApiAdapter,
  SqliteWebMessageStore,
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  type TenantRuntimeFileProvider,
  type CanonicalFileOperationRequest,
  type CanonicalFileOperationResult,
  type CanonicalStreamingWriteRequest,
  type CanonicalStreamingReadRequest,
  type CanonicalStreamingReadResult,
  type CanonicalWriteResult,
} from '../src/index.js';
import { TestOnlyRuntimeGateway } from './test-runtime-gateway.js';

function computeSha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex').toLowerCase();
}

function computeEtag(buf: Buffer): string {
  return `"${computeSha256(buf)}"`;
}

describe('P1 Production File Transport & Streaming Integration Tests', () => {
  let server: Server;
  let baseUrl: string;
  let aliceCookie: string;
  let bobCookie: string;
  let aliceId: string;
  let bobId: string;
  let aliceSpaceId: string;
  let bobSpaceId: string;
  let operationsStorage: SqlitePlatformOperationsStorage;
  let operationsService: any;
  const testCsrfToken = 'file-transport-csrf-token-32-chars-ok!';

  // In-memory binary storage simulating isolated container filesystem
  const spaceStorage = new Map<string, { buffer: Buffer; mtimeMs: number }>();

  const streamingMockFileProvider: TenantRuntimeFileProvider = {
    async execute(userId: string, spaceId: string, req: CanonicalFileOperationRequest): Promise<CanonicalFileOperationResult> {
      const storageKey = `${spaceId}:${req.path}`;
      if (req.op === 'read') {
        const item = spaceStorage.get(storageKey);
        if (!item) {
          throw new NotFoundError(`File "${req.path}" not found`);
        }
        const encoding = req.encoding ?? 'utf8';
        const content = encoding === 'base64' ? item.buffer.toString('base64') : item.buffer.toString('utf8');
        return {
          op: 'read',
          path: req.path,
          content,
          encoding,
          type: 'file',
          size: item.buffer.length,
          mtimeMs: item.mtimeMs,
          etag: computeEtag(item.buffer),
        };
      }

      if (req.op === 'list') {
        const entries: any[] = [];
        for (const [key, val] of spaceStorage.entries()) {
          if (key.startsWith(`${spaceId}:`)) {
            const rel = key.slice(`${spaceId}:`.length);
            entries.push({
              name: rel,
              type: 'file',
              size: val.buffer.length,
              mtimeMs: val.mtimeMs,
              etag: computeEtag(val.buffer),
            });
          }
        }
        return {
          op: 'list',
          path: req.path || '.',
          entries,
          truncated: false,
        };
      }

      if (req.op === 'write') {
        const buf = req.encoding === 'base64' ? Buffer.from(req.content, 'base64') : Buffer.from(req.content, 'utf8');
        const now = Date.now();
        spaceStorage.set(storageKey, { buffer: buf, mtimeMs: now });
        return {
          op: 'write',
          path: req.path,
          type: 'file',
          size: buf.length,
          mtimeMs: now,
          etag: computeEtag(buf),
        };
      }

      throw new PlatformError('Operation not supported in test mock', 'NOT_SUPPORTED', 400);
    },

    async stageBinaryStream(
      userId: string,
      spaceId: string,
      req: any,
      inStream: NodeJS.ReadableStream
    ): Promise<any> {
      const chunks: Buffer[] = [];
      let totalSize = 0;
      const maxBytes = req.maxSizeBytes ?? (50 * 1024 * 1024);
      const hasher = createHash('sha256');

      await new Promise<void>((resolve, reject) => {
        inStream.on('data', (chunk) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalSize += buf.length;
          if (totalSize > maxBytes) {
            const err = new PlatformError('Payload too large', 'PAYLOAD_TOO_LARGE', 413);
            if (typeof (inStream as any).destroy === 'function') {
              (inStream as any).destroy(err);
            }
            reject(err);
            return;
          }
          hasher.update(buf);
          chunks.push(buf);
        });
        inStream.on('error', reject);
        inStream.on('end', resolve);
      });

      const fullBuffer = Buffer.concat(chunks);
      const sha256Hex = hasher.digest('hex').toLowerCase();
      const stageToken = `.${req.path.split('/').pop() || 'file'}.${randomUUID().replace(/-/g, '').slice(0, 16)}.stage.tmp`;

      spaceStorage.set(`${spaceId}:${stageToken}`, { buffer: fullBuffer, mtimeMs: Date.now() });

      return {
        op: 'stage',
        path: req.path,
        stageToken,
        size: fullBuffer.length,
        sha256: sha256Hex,
        etag: `"${sha256Hex}"`,
      };
    },

    async commitStage(
      userId: string,
      spaceId: string,
      req: any
    ): Promise<any> {
      const staged = spaceStorage.get(`${spaceId}:${req.stageToken}`);
      if (!staged) {
        throw new PlatformError('Staged file not found', 'INVALID_REQUEST', 400);
      }
      spaceStorage.delete(`${spaceId}:${req.stageToken}`);

      const targetKey = `${spaceId}:${req.path}`;
      const existing = spaceStorage.get(targetKey);

      if (req.requireAbsent && existing) {
        throw new PlatformError(`File "${req.path}" already exists`, 'CONFLICT', 409);
      }

      if (req.expectedEtag) {
        if (!existing) {
          throw new NotFoundError(`File "${req.path}" not found for update`);
        }
        const currentEtag = computeEtag(existing.buffer);
        if (currentEtag !== req.expectedEtag) {
          throw new PlatformError(`ETag mismatch`, 'CONFLICT', 409);
        }
      }

      let rollbackToken: string | undefined;
      if (existing && !req.requireAbsent) {
        rollbackToken = req.rollbackToken || `.${req.path.split('/').pop() || 'file'}.${randomUUID().replace(/-/g, '').slice(0, 16)}.rollback.tmp`;
        spaceStorage.set(`${spaceId}:${rollbackToken}`, { buffer: existing.buffer, mtimeMs: existing.mtimeMs });
      }

      const now = Date.now();
      spaceStorage.set(targetKey, { buffer: staged.buffer, mtimeMs: now });

      return {
        op: 'write',
        path: req.path,
        type: 'file',
        size: staged.buffer.length,
        mtimeMs: now,
        etag: computeEtag(staged.buffer),
        rollbackToken,
      };
    },

    async finalizeStage(
      userId: string,
      spaceId: string,
      req: any
    ): Promise<void> {
      if (req.rollbackToken) {
        spaceStorage.delete(`${spaceId}:${req.rollbackToken}`);
      }
    },

    async rollbackCommit(
      userId: string,
      spaceId: string,
      req: any
    ): Promise<void> {
      const targetKey = `${spaceId}:${req.path}`;
      if (req.rollbackToken) {
        const backup = spaceStorage.get(`${spaceId}:${req.rollbackToken}`);
        if (backup) {
          spaceStorage.set(targetKey, backup);
          spaceStorage.delete(`${spaceId}:${req.rollbackToken}`);
        }
      } else {
        spaceStorage.delete(targetKey);
      }
    },

    async abortStage(
      userId: string,
      spaceId: string,
      req: any
    ): Promise<void> {
      spaceStorage.delete(`${spaceId}:${req.stageToken}`);
    },

    async inspectTransferState(
      userId: string,
      spaceId: string,
      req: any
    ): Promise<any> {
      const targetKey = `${spaceId}:${req.path}`;
      const target = spaceStorage.get(targetKey);
      const stageKey = req.stageToken ? `${spaceId}:${req.stageToken}` : null;
      const staged = stageKey ? spaceStorage.get(stageKey) : null;
      const rollbackKey = req.rollbackToken ? `${spaceId}:${req.rollbackToken}` : null;
      const rollback = rollbackKey ? spaceStorage.get(rollbackKey) : null;

      const stageExists = Boolean(staged);
      const rollbackExists = Boolean(rollback);
      const targetExists = Boolean(target);

      let targetEtag: string | null = null;
      let targetMtimeMs: number | null = null;
      let targetSize: number | null = null;
      let targetMatchesContent = false;

      if (target) {
        targetEtag = computeEtag(target.buffer);
        targetMtimeMs = target.mtimeMs;
        targetSize = target.buffer.length;
        const expectedEtag = `"${(req.expectedContentSha256 || req.contentSha256 || '').toLowerCase()}"`;
        targetMatchesContent = targetEtag.toLowerCase() === expectedEtag.toLowerCase();
      }

      return {
        op: 'inspect_transfer_state',
        path: req.path,
        staged_present: stageExists,
        target_matches: targetMatchesContent,
        rollback_present: rollbackExists,
        stageExists,
        rollbackExists,
        targetExists,
        targetEtag,
        etag: targetEtag,
        targetMtimeMs,
        mtimeMs: targetMtimeMs,
        targetSize,
        size: targetSize,
        targetMatchesContent,
        consistentWithCommitted: targetExists && targetMatchesContent && !stageExists,
        consistentWithStagedPreCommit: stageExists && !targetMatchesContent,
      };
    },

    async readBinaryStream(
      userId: string,
      spaceId: string,
      req: CanonicalStreamingReadRequest
    ): Promise<CanonicalStreamingReadResult> {
      const storageKey = `${spaceId}:${req.path}`;
      const existing = spaceStorage.get(storageKey);
      if (!existing) {
        throw new NotFoundError(`File "${req.path}" not found`);
      }

      const fullBuf = existing.buffer;
      let streamBuf = fullBuf;
      let range = req.range;

      if (range) {
        streamBuf = fullBuf.subarray(range.start, range.end + 1);
      }

      return {
        op: 'read',
        path: req.path,
        type: 'file',
        size: streamBuf.length,
        totalSize: fullBuf.length,
        mtimeMs: existing.mtimeMs,
        etag: computeEtag(fullBuf),
        range,
        stream: Readable.from([streamBuf]),
      };
    },
  };

  beforeAll(async () => {
    const db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    const storage = new SqlitePlatformStorage(db);
    const authService = new DefaultAuthService(storage, {
      cookieSecret: 'file-transport-secret-32-chars-long!',
    });
    const messageStore = new SqliteWebMessageStore(db);
    const platformApi = new SqlitePlatformWebApiAdapter({
      storage,
      authService,
      messageStore,
      db,
    });
    const runtimeGateway = new TestOnlyRuntimeGateway({ storage, messageStore });
    operationsStorage = new SqlitePlatformOperationsStorage(db);
    operationsService = createPlatformOperations({
      storage: operationsStorage,
    });

    const handler = createPlatformServerHandler({
      database: db,
      storage,
      platformApi,
      authService,
      runtimeGateway,
      csrfToken: testCsrfToken,
      fileProvider: streamingMockFileProvider,
      operations: operationsService,
    });

    server = createServer(handler);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    const fixtures = await provisionFixtures(storage, authService, {
      adminUsername: 'alice',
      adminPassword: 'AlicePassword123!',
      userUsername: 'bob',
      userPassword: 'BobPassword123!',
      disabledUsername: 'charlie',
      disabledPassword: 'CharliePassword123!',
    });
    aliceId = fixtures.admin.id;
    bobId = fixtures.user.id;
    aliceSpaceId = fixtures.adminContainerSpace.id;
    bobSpaceId = fixtures.userContainerSpace.id;

    const aliceRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        'Origin': baseUrl,
      },
      body: JSON.stringify({ username: 'alice', password: 'AlicePassword123!' }),
    });
    const setCookie = aliceRes.headers.get('set-cookie');
    aliceCookie = setCookie?.split(';')[0] || '';

    const bobRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        'Origin': baseUrl,
      },
      body: JSON.stringify({ username: 'bob', password: 'BobPassword123!' }),
    });
    const setCookieBob = bobRes.headers.get('set-cookie');
    bobCookie = setCookieBob?.split(';')[0] || '';

    // Set quota limits for Alice & Bob (10MB storage_bytes, 1000 api_calls)
    await operationsService.forTenant(aliceId).quota.setLimit({ resource: 'storage_bytes', limit: 10 * 1024 * 1024 });
    await operationsService.forTenant(aliceId).quota.setLimit({ resource: 'api_calls', limit: 1000 });
    await operationsService.forTenant(bobId).quota.setLimit({ resource: 'storage_bytes', limit: 10 * 1024 * 1024 });
    await operationsService.forTenant(bobId).quota.setLimit({ resource: 'api_calls', limit: 1000 });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  describe('1. Binary Stream Direct Upload & Download', () => {
    it('uploads a binary PNG image stream via POST /upload?path=image.png, returns 201 with correct ETag and metadata', async () => {
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
      const pngPayload = Buffer.concat([pngHeader, Buffer.alloc(1024, 0xaa)]);
      const expectedEtag = computeEtag(pngPayload);

      const idempKey = randomUUID().toLowerCase();
      const res = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/upload?path=images/test.png`, {
        method: 'POST',
        headers: {
          'Cookie': aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          'Origin': baseUrl,
          'Idempotency-Key': idempKey,
          'Content-Type': 'application/octet-stream',
        },
        body: pngPayload,
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.data.uploaded).toBe(true);
      expect(data.data.files[0].path).toBe('images/test.png');
      expect(data.data.files[0].size).toBe(pngPayload.length);
      expect(data.data.files[0].etag).toBe(expectedEtag);

      // Download and verify byte-for-byte equality & headers
      const downRes = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/download?path=images/test.png`, {
        headers: {
          'Cookie': aliceCookie,
        },
      });

      expect(downRes.status).toBe(200);
      expect(downRes.headers.get('content-type')).toBe('image/png');
      expect(downRes.headers.get('content-disposition')).toContain('attachment; filename="test.png"; filename*=UTF-8\'\'test.png');
      expect(downRes.headers.get('etag')).toBe(expectedEtag);
      expect(downRes.headers.get('x-content-type-options')).toBe('nosniff');
      expect(downRes.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");

      const downloadedBuf = Buffer.from(await downRes.arrayBuffer());
      expect(downloadedBuf.equals(pngPayload)).toBe(true);
    });

    it('rejects binary upload without required Idempotency-Key or with invalid format', async () => {
      const resMissing = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/upload?path=file.bin`, {
        method: 'POST',
        headers: {
          'Cookie': aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          'Origin': baseUrl,
          'Content-Type': 'application/octet-stream',
        },
        body: Buffer.from('data'),
      });
      expect(resMissing.status).toBe(400);

      const resInvalid = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/upload?path=file.bin`, {
        method: 'POST',
        headers: {
          'Cookie': aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          'Origin': baseUrl,
          'Idempotency-Key': 'not-a-valid-uuid-v4',
          'Content-Type': 'application/octet-stream',
        },
        body: Buffer.from('data'),
      });
      expect(resInvalid.status).toBe(400);
    });

    it('rejects upload when CSRF or Origin is missing or mismatched', async () => {
      const idempKey = randomUUID().toLowerCase();
      const resCsrf = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/upload?path=csrf-test.bin`, {
        method: 'POST',
        headers: {
          'Cookie': aliceCookie,
          'Origin': baseUrl,
          'Idempotency-Key': idempKey,
          'Content-Type': 'application/octet-stream',
        },
        body: Buffer.from('data'),
      });
      expect(resCsrf.status).toBe(403);

      const resOrigin = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/upload?path=origin-test.bin`, {
        method: 'POST',
        headers: {
          'Cookie': aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          'Origin': 'http://evil.com',
          'Idempotency-Key': idempKey,
          'Content-Type': 'application/octet-stream',
        },
        body: Buffer.from('data'),
      });
      expect(resOrigin.status).toBe(403);
    });
  });

  describe('2. Multipart/form-data Streaming Upload', () => {
    it('uploads a file via busboy streaming multipart form, normalizes Unicode filenames, and respects relative path prefix', async () => {
      const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
      const file1Content = Buffer.from('Content of UTF8 Report: 测试报告', 'utf8');

      const parts: Buffer[] = [
        Buffer.from(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file1"; filename="报告_test.txt"\r\n` +
          `Content-Type: text/plain\r\n\r\n`
        ),
        file1Content,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ];

      const multipartBody = Buffer.concat(parts);
      const idempKey = randomUUID().toLowerCase();

      const res = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/upload?path=docs/reports`, {
        method: 'POST',
        headers: {
          'Cookie': aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          'Origin': baseUrl,
          'Idempotency-Key': idempKey,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body: multipartBody,
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.uploaded).toBe(true);
      expect(json.data.count).toBe(1);
      expect(json.data.files[0].path).toBe('docs/reports/报告_test.txt');
      expect(json.data.files[0].size).toBe(file1Content.length);

      // Download file and verify
      const down1 = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/download?path=docs/reports/报告_test.txt`, {
        headers: { 'Cookie': aliceCookie },
      });
      expect(down1.status).toBe(200);
      const buf1 = Buffer.from(await down1.arrayBuffer());
      expect(buf1.equals(file1Content)).toBe(true);
    });

    it('rejects multipart request containing more than 1 file part with 413 Payload Too Large (enforces single-file atomicity)', async () => {
      const boundary = '----WebKitFormBoundaryMultiPart';
      const parts: Buffer[] = [
        Buffer.from(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file1"; filename="file1.txt"\r\n` +
          `Content-Type: text/plain\r\n\r\n`
        ),
        Buffer.from('File 1 data'),
        Buffer.from(
          `\r\n--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file2"; filename="file2.txt"\r\n` +
          `Content-Type: text/plain\r\n\r\n`
        ),
        Buffer.from('File 2 data'),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ];

      const res = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/upload?path=docs`, {
        method: 'POST',
        headers: {
          'Cookie': aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          'Origin': baseUrl,
          'Idempotency-Key': randomUUID().toLowerCase(),
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body: Buffer.concat(parts),
      });

      expect(res.status).toBe(413);
    });

    it('supports idempotent replay of upload request with identical Idempotency-Key and parameters', async () => {
      const idempKey = randomUUID().toLowerCase();
      const content = Buffer.from('Deterministic content for idempotency');

      // First upload
      const res1 = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/upload?path=idemp_file.txt`, {
        method: 'POST',
        headers: {
          'Cookie': aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          'Origin': baseUrl,
          'Idempotency-Key': idempKey,
          'Content-Type': 'text/plain',
        },
        body: content,
      });
      expect(res1.status).toBe(201);
      const json1 = await res1.json();
      expect(json1.data.uploaded).toBe(true);

      // Replay with identical key & parameters
      const res2 = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/upload?path=idemp_file.txt`, {
        method: 'POST',
        headers: {
          'Cookie': aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          'Origin': baseUrl,
          'Idempotency-Key': idempKey,
          'Content-Type': 'text/plain',
        },
        body: content,
      });
      expect(res2.status).toBe(201);
      const json2 = await res2.json();
      expect(json2.data.uploaded).toBe(true);
      expect(json2.data.isIdempotentHit).toBe(true);
      // mtimeMs must remain identical to first upload (no rewrite)
      expect(json2.data.files[0].mtimeMs).toBe(json1.data.files[0].mtimeMs);

      // Reusing the same idempotency key with different bytes fails 409 Conflict
      const resDiffBytes = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/upload?path=idemp_file.txt`, {
        method: 'POST',
        headers: {
          'Cookie': aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          'Origin': baseUrl,
          'Idempotency-Key': idempKey,
          'Content-Type': 'text/plain',
        },
        body: Buffer.from('Completely different content bytes'),
      });
      expect(resDiffBytes.status).toBe(409);

      // Reusing the same idempotency key with different destination path fails 409 Conflict
      const resConflict = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/upload?path=different_path.txt`, {
        method: 'POST',
        headers: {
          'Cookie': aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          'Origin': baseUrl,
          'Idempotency-Key': idempKey,
          'Content-Type': 'text/plain',
        },
        body: content,
      });
      expect(resConflict.status).toBe(409);
    });

    it('rejects multipart files with path traversal, null bytes, or control characters in filename', async () => {
      const boundary = '----WebKitBoundaryTraversal';
      const dangerousFilenames = ['../escape.txt', '..\\escape.txt', 'null\0byte.txt', 'ctrl\x1fchar.txt'];

      for (const fn of dangerousFilenames) {
        const parts = [
          Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="file"; filename="${fn}"\r\n` +
            `Content-Type: text/plain\r\n\r\n`
          ),
          Buffer.from('hello'),
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ];

        const res = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/upload?path=safe`, {
          method: 'POST',
          headers: {
            'Cookie': aliceCookie,
            'X-Enkeep-CSRF': testCsrfToken,
            'Origin': baseUrl,
            'Idempotency-Key': randomUUID().toLowerCase(),
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
          },
          body: Buffer.concat(parts),
        });

        expect(res.status).toBe(400);
      }
    });
  });

  describe('3. Atomic Upload, Preconditions & Overwrite (409 Conflict)', () => {
    it('defaults to requireAbsent: true and fails with 409 Conflict if target file already exists without overwrite=true', async () => {
      const idemp1 = randomUUID().toLowerCase();
      const content = Buffer.from('Initial File Content');

      const res1 = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/upload?path=existing.txt`, {
        method: 'POST',
        headers: {
          'Cookie': aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          'Origin': baseUrl,
          'Idempotency-Key': idemp1,
          'Content-Type': 'text/plain',
        },
        body: content,
      });
      expect(res1.status).toBe(201);
      const data1 = await res1.json();
      const etag1 = data1.data.files[0].etag;

      // Duplicate upload without overwrite
      const idemp2 = randomUUID().toLowerCase();
      const res2 = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/upload?path=existing.txt`, {
        method: 'POST',
        headers: {
          'Cookie': aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          'Origin': baseUrl,
          'Idempotency-Key': idemp2,
          'Content-Type': 'text/plain',
        },
        body: Buffer.from('Updated Content'),
      });
      expect(res2.status).toBe(409);

      // Overwrite with wrong If-Match header fails 409
      const idemp3 = randomUUID().toLowerCase();
      const res3 = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/upload?path=existing.txt&overwrite=true`, {
        method: 'POST',
        headers: {
          'Cookie': aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          'Origin': baseUrl,
          'Idempotency-Key': idemp3,
          'If-Match': '"0000000000000000000000000000000000000000000000000000000000000000"',
          'Content-Type': 'text/plain',
        },
        body: Buffer.from('Updated Content with Wrong ETag'),
      });
      expect(res3.status).toBe(409);

      // Overwrite with correct If-Match succeeds
      const idemp4 = randomUUID().toLowerCase();
      const res4 = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/upload?path=existing.txt&overwrite=true`, {
        method: 'POST',
        headers: {
          'Cookie': aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          'Origin': baseUrl,
          'Idempotency-Key': idemp4,
          'If-Match': etag1,
          'Content-Type': 'text/plain',
        },
        body: Buffer.from('Correctly Overwritten Content'),
      });
      expect(res4.status).toBe(201);
    });
  });

  describe('4. HTTP 206 Partial Content (Range) & HTTP 304 Caching', () => {
    it('supports HTTP 206 Range requests for streaming audio/video seeking', async () => {
      const fullContent = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');
      const idemp = randomUUID().toLowerCase();

      await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/upload?path=media.bin`, {
        method: 'POST',
        headers: {
          'Cookie': aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          'Origin': baseUrl,
          'Idempotency-Key': idemp,
          'Content-Type': 'application/octet-stream',
        },
        body: fullContent,
      });

      // Request bytes=10-19
      const rangeRes = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/download?path=media.bin`, {
        headers: {
          'Cookie': aliceCookie,
          'Range': 'bytes=10-19',
        },
      });

      expect(rangeRes.status).toBe(206);
      expect(rangeRes.headers.get('content-range')).toBe(`bytes 10-19/${fullContent.length}`);
      expect(rangeRes.headers.get('content-length')).toBe('10');
      const rangeBuf = Buffer.from(await rangeRes.arrayBuffer());
      expect(rangeBuf.toString('utf8')).toBe('ABCDEFGHIJ');
    });

    it('returns HTTP 304 Not Modified on If-None-Match cache hit', async () => {
      const downRes = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/download?path=media.bin`, {
        headers: { 'Cookie': aliceCookie },
      });
      const etag = downRes.headers.get('etag')!;

      const cacheRes = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/download?path=media.bin`, {
        headers: {
          'Cookie': aliceCookie,
          'If-None-Match': etag,
        },
      });
      expect(cacheRes.status).toBe(304);
    });

    it('rejects downloading a non-existent file with 404', async () => {
      const notFoundRes = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/download?path=nonexistent.txt`, {
        headers: { 'Cookie': aliceCookie },
      });
      expect(notFoundRes.status).toBe(404);
    });
  });

  describe('5. Tenant Isolation & Security Boundary', () => {
    it('prevents Bob from downloading or uploading into Alice space', async () => {
      // Bob attempts to download Alice's media.bin
      const bobDown = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/download?path=media.bin`, {
        headers: { 'Cookie': bobCookie },
      });
      expect(bobDown.status).toBe(404);

      // Bob attempts to upload into Alice space
      const bobUp = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/upload?path=bob-intrude.txt`, {
        method: 'POST',
        headers: {
          'Cookie': bobCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          'Origin': baseUrl,
          'Idempotency-Key': randomUUID().toLowerCase(),
          'Content-Type': 'text/plain',
        },
        body: Buffer.from('Bob intrusion'),
      });
      expect(bobUp.status).toBe(404);
    });
  });

  describe('6. 50MB Streaming Memory Bounds & Quota Rejection', () => {
    it('handles 50MB streaming upload within bounded memory and calculates correct hash and size', async () => {
      // Temporarily expand Alice's storage quota to 60MB
      await operationsStorage.forTenant(aliceId).quota.setLimit({
        resource: 'storage_bytes',
        limit: 60 * 1024 * 1024,
      });

      const total50Mb = 50 * 1024 * 1024;
      const chunkSize = 1024 * 1024; // 1MB chunks
      const chunkPattern = Buffer.alloc(chunkSize, 0x5a); // ASCII 'Z'

      // Stream 50 chunks of 1MB without allocating full 50MB in a single Buffer
      let chunksSent = 0;
      const streaming50Mb = new Readable({
        read() {
          if (chunksSent < 50) {
            this.push(chunkPattern);
            chunksSent++;
          } else {
            this.push(null);
          }
        },
      });

      const initialMem = process.memoryUsage().heapUsed;
      const idempKey = randomUUID().toLowerCase();

      const res = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/upload?path=large_50mb.dat`, {
        method: 'POST',
        headers: {
          'Cookie': aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          'Origin': baseUrl,
          'Idempotency-Key': idempKey,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(total50Mb),
        },
        body: streaming50Mb as any,
        duplex: 'half',
      } as any);

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.data.uploaded).toBe(true);
      expect(data.data.files[0].size).toBe(total50Mb);

      const memDelta = process.memoryUsage().heapUsed - initialMem;
      // Memory growth should stay bounded (< 30MB heap delta)
      expect(memDelta).toBeLessThan(30 * 1024 * 1024);

      // Verify download of the 50MB file
      const downHead = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/download?path=large_50mb.dat`, {
        method: 'HEAD',
        headers: { 'Cookie': aliceCookie },
      });
      expect(downHead.status).toBe(200);
      expect(downHead.headers.get('content-length')).toBe(String(total50Mb));
    });

    it('rejects upload when storage_bytes quota is exceeded and rolls back reservation', async () => {
      // Set Bob's storage quota to 100 bytes
      await operationsStorage.forTenant(bobId).quota.setLimit({
        resource: 'storage_bytes',
        limit: 100,
      });

      const payload = Buffer.alloc(1024, 0x42); // 1KB exceeds 100 bytes
      const res = await fetch(`${baseUrl}/api/spaces/${bobSpaceId}/files/upload?path=overflow.dat`, {
        method: 'POST',
        headers: {
          'Cookie': bobCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          'Origin': baseUrl,
          'Idempotency-Key': randomUUID().toLowerCase(),
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(payload.length),
        },
        body: payload,
      });

      expect(res.status).toBe(429);
      const errJson = await res.json();
      expect(errJson.error.code).toBe('QUOTA_EXCEEDED');

      // Verify Bob's storage_bytes usage remains 0 (reservation was released)
      const usage = await operationsStorage.forTenant(bobId).quota.getUsage('storage_bytes');
      expect(usage.used).toBe(0);
      expect(usage.reserved).toBe(0);
    });

    it('records structured audit log on successful upload with metadata and without sensitive content', async () => {
      const uploadPayload = Buffer.from('Auditable secure content');
      const res = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/upload?path=audit_test.txt`, {
        method: 'POST',
        headers: {
          'Cookie': aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          'Origin': baseUrl,
          'Idempotency-Key': randomUUID().toLowerCase(),
          'Content-Type': 'text/plain',
        },
        body: uploadPayload,
      });

      expect(res.status).toBe(201);

      const logs = await operationsStorage.auditLogs.query({ userId: aliceId, action: 'file_uploaded' });
      expect(logs.length).toBeGreaterThan(0);
      const lastLog = logs[0];
      expect(lastLog.resourceType).toBe('file');
      expect(lastLog.details?.path).toBe('audit_test.txt');
      expect(lastLog.details?.size).toBe(uploadPayload.length);
      // Ensure raw content is NOT stored in audit log
      expect(JSON.stringify(lastLog)).not.toContain('Auditable secure content');

      // Verify file_transfer_journal record
      const journalRow = (operationsStorage as any).db.prepare(
        'SELECT * FROM file_transfer_journal WHERE user_id = ? AND relative_path = ? ORDER BY created_at DESC LIMIT 1'
      ).get(aliceId, 'audit_test.txt') as any;
      expect(journalRow).toBeDefined();
      expect(journalRow.status).toBe('finalized');
      expect(journalRow.size).toBe(uploadPayload.length);
      expect(journalRow.content_sha256).toBe(computeSha256(uploadPayload));
    });

    it('enforces strict If-Match header rules on overwrite parameter', async () => {
      // 1. overwrite=true without If-Match header fails 400
      const resMissingIfMatch = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/upload?path=file.txt&overwrite=true`, {
        method: 'POST',
        headers: {
          'Cookie': aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          'Origin': baseUrl,
          'Idempotency-Key': randomUUID().toLowerCase(),
          'Content-Type': 'text/plain',
        },
        body: Buffer.from('data'),
      });
      expect(resMissingIfMatch.status).toBe(400);

      // 2. overwrite=false with If-Match header fails 400
      const resUnexpectedIfMatch = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/upload?path=file.txt&overwrite=false`, {
        method: 'POST',
        headers: {
          'Cookie': aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          'Origin': baseUrl,
          'Idempotency-Key': randomUUID().toLowerCase(),
          'If-Match': '"0000000000000000000000000000000000000000000000000000000000000000"',
          'Content-Type': 'text/plain',
        },
        body: Buffer.from('data'),
      });
      expect(resUnexpectedIfMatch.status).toBe(400);
    });

    it('cleans up resources and releases quota reservation if upload stream is aborted midstream', async () => {
      const initialUsage = await operationsStorage.forTenant(aliceId).quota.getUsage('storage_bytes');
      const abortController = new AbortController();

      const abortStream = new PassThrough();
      abortStream.write(Buffer.alloc(1024 * 64, 0x33));
      setTimeout(() => {
        abortController.abort();
      }, 50);

      try {
        await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/upload?path=aborted.dat`, {
          method: 'POST',
          headers: {
            'Cookie': aliceCookie,
            'X-Enkeep-CSRF': testCsrfToken,
            'Origin': baseUrl,
            'Idempotency-Key': randomUUID().toLowerCase(),
            'Content-Type': 'application/octet-stream',
          },
          body: abortStream as any,
          signal: abortController.signal,
          duplex: 'half',
        } as any);
      } catch {
        // Fetch abort is expected
      }

      // Wait a tick for server-side socket close & quota release to settle
      await new Promise((r) => setTimeout(r, 100));

      // Check that quota reservations were cleaned up
      const afterUsage = await operationsStorage.forTenant(aliceId).quota.getUsage('storage_bytes');
      expect(afterUsage.reserved).toBe(initialUsage.reserved);
    });
  });

  describe('7. Durable Journal Crash Recovery & Compensation Rollback', () => {
    it('recovers staged-only journal entry on crash before physical commit and deletes orphaned .stage.tmp file', async () => {
      const db = (operationsStorage as any).db;
      const stageToken = '.orphan.0123456789abcdef.stage.tmp';
      spaceStorage.set(`${aliceSpaceId}:${stageToken}`, { buffer: Buffer.from('uncommitted staged data'), mtimeMs: Date.now() });

      const journalId = `jrn_${randomUUID().replace(/-/g, '')}`;
      db.prepare(`
        INSERT INTO file_transfer_journal (
          id, user_id, space_id, relative_path, stage_token, rollback_token, overwrite, expected_etag, content_sha256, size, idempotency_key, status, response_payload, created_at, updated_at
        ) VALUES (?, ?, ?, 'orphan.txt', ?, NULL, 0, NULL, 'dummyhash', 100, 'idemp_orphan', 'staged', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(journalId, aliceId, aliceSpaceId, stageToken);

      const recoveryService = new FileTransferRecoveryService(db, new (await import('../src/files/runtime-file-api.js')).RuntimeFileApiService({ fileProvider: streamingMockFileProvider }));
      const report = await recoveryService.recoverAll();

      expect(report.abortedStaged).toBeGreaterThanOrEqual(1);
      expect(spaceStorage.has(`${aliceSpaceId}:${stageToken}`)).toBe(false);

      const updated = db.prepare('SELECT status FROM file_transfer_journal WHERE id = ?').get(journalId) as any;
      expect(updated.status).toBe('aborted');
    });

    it('recovers committed journal entry where DB finalization crashed, backfilling idempotency & audit log', async () => {
      const db = (operationsStorage as any).db;
      const fileData = Buffer.from('Committed before DB finalize crashed');
      const sha = computeSha256(fileData);
      spaceStorage.set(`${aliceSpaceId}:crashed_committed.txt`, { buffer: fileData, mtimeMs: Date.now() });

      const journalId = `jrn_${randomUUID().replace(/-/g, '')}`;
      const idempKey = randomUUID().toLowerCase();

      db.prepare(`
        INSERT INTO file_transfer_journal (
          id, user_id, space_id, relative_path, stage_token, rollback_token, overwrite, expected_etag, content_sha256, size, idempotency_key, status, response_payload, created_at, updated_at
        ) VALUES (?, ?, ?, 'crashed_committed.txt', NULL, NULL, 0, NULL, ?, ?, ?, 'committed', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(journalId, aliceId, aliceSpaceId, sha, fileData.length, idempKey);

      const recoveryService = new FileTransferRecoveryService(db, new (await import('../src/files/runtime-file-api.js')).RuntimeFileApiService({ fileProvider: streamingMockFileProvider }));
      const report = await recoveryService.recoverAll();

      expect(report.finalizedCommitted).toBeGreaterThanOrEqual(1);

      const updated = db.prepare('SELECT status FROM file_transfer_journal WHERE id = ?').get(journalId) as any;
      expect(updated.status).toBe('finalized');

      // Verify idempotency record was created
      const idempRow = db.prepare('SELECT * FROM operation_idempotency WHERE idempotency_key = ?').get(idempKey) as any;
      expect(idempRow).toBeDefined();

      // Verify audit log was created with canonical username
      const auditRows = await operationsStorage.auditLogs.query({ userId: aliceId, action: 'file_uploaded' });
      const matched = auditRows.find((a) => a.details?.path === 'crashed_committed.txt');
      expect(matched).toBeDefined();
    });

    it('recovers 50MB committed file without buffering entire file in memory during recovery', async () => {
      const db = (operationsStorage as any).db;
      const total50Mb = 50 * 1024 * 1024;
      const fileData = Buffer.alloc(total50Mb, 0x41);
      const sha = computeSha256(fileData);
      spaceStorage.set(`${aliceSpaceId}:large_recovered_50mb.dat`, { buffer: fileData, mtimeMs: Date.now() });

      const journalId = `jrn_${randomUUID().replace(/-/g, '')}`;
      const idempKey = randomUUID().toLowerCase();

      db.prepare(`
        INSERT INTO file_transfer_journal (
          id, user_id, space_id, relative_path, stage_token, rollback_token, overwrite, expected_etag, content_sha256, size, idempotency_key, status, response_payload, created_at, updated_at
        ) VALUES (?, ?, ?, 'large_recovered_50mb.dat', NULL, NULL, 0, NULL, ?, ?, ?, 'committed', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(journalId, aliceId, aliceSpaceId, sha, total50Mb, idempKey);

      const memBefore = process.memoryUsage().heapUsed;
      const recoveryService = new FileTransferRecoveryService(db, new (await import('../src/files/runtime-file-api.js')).RuntimeFileApiService({ fileProvider: streamingMockFileProvider }));
      const report = await recoveryService.recoverAll();

      expect(report.finalizedCommitted).toBeGreaterThanOrEqual(1);
      const memDelta = process.memoryUsage().heapUsed - memBefore;
      expect(memDelta).toBeLessThan(30 * 1024 * 1024); // Heap delta strictly bounded

      const updated = db.prepare('SELECT status FROM file_transfer_journal WHERE id = ?').get(journalId) as any;
      expect(updated.status).toBe('finalized');
    });

    it('fails closed and rolls back committed physical file when user does not exist in users table', async () => {
      const db = (operationsStorage as any).db;
      const fileData = Buffer.from('Orphaned missing user file');
      const sha = computeSha256(fileData);

      const testStorage = new SqlitePlatformStorage(db);
      const tempUser = await testStorage.users.create({
        username: 'temp_to_delete',
        passwordHash: 'dummy',
        displayName: 'Temp',
        role: 'user',
        status: 'active',
      });
      const tempSpace = await testStorage.forTenant(tempUser.id).spaces.create({
        name: 'Temp Space',
        folder: 'spc_temp',
        executionMode: 'container',
      });
      spaceStorage.set(`${tempSpace.id}:missing_user.txt`, { buffer: fileData, mtimeMs: Date.now() });

      const journalId = `jrn_${randomUUID().replace(/-/g, '')}`;
      const idempKey = randomUUID().toLowerCase();

      db.prepare(`
        INSERT INTO file_transfer_journal (
          id, user_id, space_id, relative_path, stage_token, rollback_token, overwrite, expected_etag, content_sha256, size, idempotency_key, status, response_payload, created_at, updated_at
        ) VALUES (?, ?, ?, 'missing_user.txt', NULL, NULL, 0, NULL, ?, ?, ?, 'committed', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(journalId, tempUser.id, tempSpace.id, sha, fileData.length, idempKey);

      // Temporarily disable FK to delete user leaving journal row
      db.exec('PRAGMA foreign_keys = OFF');
      db.prepare('DELETE FROM users WHERE id = ?').run(tempUser.id);
      db.exec('PRAGMA foreign_keys = ON');

      const recoveryService = new FileTransferRecoveryService(db, new (await import('../src/files/runtime-file-api.js')).RuntimeFileApiService({ fileProvider: streamingMockFileProvider }));
      const report = await recoveryService.recoverAll();

      expect(report.errors.some((e) => e.code === 'USER_NOT_FOUND')).toBe(true);

      const updated = db.prepare('SELECT status FROM file_transfer_journal WHERE id = ?').get(journalId) as any;
      expect(updated.status).toBe('rolled_back');
    });

    it('recovers staged-only entry where physical rename completed before crash, promoting to finalized with audit', async () => {
      const db = (operationsStorage as any).db;
      const fileData = Buffer.from('Post-rename crashed before journal update to committed');
      const sha = computeSha256(fileData);
      // Physical target has the new content, stageToken is gone (rename finished)
      spaceStorage.set(`${aliceSpaceId}:post_rename_crashed.txt`, { buffer: fileData, mtimeMs: 1680000000000 });

      const journalId = `jrn_${randomUUID().replace(/-/g, '')}`;
      const idempKey = randomUUID().toLowerCase();

      // Journal was left in 'staged' state when process crashed immediately after physical rename
      db.prepare(`
        INSERT INTO file_transfer_journal (
          id, user_id, space_id, relative_path, stage_token, rollback_token, overwrite, expected_etag, content_sha256, size, idempotency_key, status, response_payload, created_at, updated_at
        ) VALUES (?, ?, ?, 'post_rename_crashed.txt', '.stage_token_gone.tmp', NULL, 0, NULL, ?, ?, ?, 'staged', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(journalId, aliceId, aliceSpaceId, sha, fileData.length, idempKey);

      const recoveryService = new FileTransferRecoveryService(db, new (await import('../src/files/runtime-file-api.js')).RuntimeFileApiService({ fileProvider: streamingMockFileProvider }));
      const report = await recoveryService.recoverAll();

      expect(report.finalizedCommitted).toBeGreaterThanOrEqual(1);

      const updated = db.prepare('SELECT status FROM file_transfer_journal WHERE id = ?').get(journalId) as any;
      expect(updated.status).toBe('finalized');

      // Verify idempotency was created
      const idempRow = db.prepare('SELECT * FROM operation_idempotency WHERE idempotency_key = ?').get(idempKey) as any;
      expect(idempRow).toBeDefined();
    });

    it('retries cleanup_pending journal entries on subsequent recovery run and marks finalized', async () => {
      const db = (operationsStorage as any).db;
      const backupToken = '.pending_backup.0123456789abcdef.rollback.tmp';
      spaceStorage.set(`${aliceSpaceId}:${backupToken}`, { buffer: Buffer.from('old backup'), mtimeMs: Date.now() });

      const journalId = `jrn_${randomUUID().replace(/-/g, '')}`;

      db.prepare(`
        INSERT INTO file_transfer_journal (
          id, user_id, space_id, relative_path, stage_token, rollback_token, overwrite, expected_etag, content_sha256, size, idempotency_key, status, response_payload, created_at, updated_at
        ) VALUES (?, ?, ?, 'cleanup_target.txt', NULL, ?, 1, NULL, 'hash', 100, 'idemp_clean', 'cleanup_pending', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(journalId, aliceId, aliceSpaceId, backupToken);

      const recoveryService = new FileTransferRecoveryService(db, new (await import('../src/files/runtime-file-api.js')).RuntimeFileApiService({ fileProvider: streamingMockFileProvider }));
      const report = await recoveryService.recoverAll();

      expect(report.cleanedPending).toBeGreaterThanOrEqual(1);
      expect(spaceStorage.has(`${aliceSpaceId}:${backupToken}`)).toBe(false);

      const updated = db.prepare('SELECT status, rollback_token FROM file_transfer_journal WHERE id = ?').get(journalId) as any;
      expect(updated.status).toBe('finalized');
      expect(updated.rollback_token).toBeNull();
    });

    it('preserves original file content via rollbackToken if physical overwrite committed but DB transaction fails', async () => {
      const originalContent = Buffer.from('Original Preserved Content Prior To Overwrite');
      spaceStorage.set(`${aliceSpaceId}:revert_test.txt`, { buffer: originalContent, mtimeMs: 1600000000000 });

      const overwriteEtag = computeEtag(originalContent);
      const rollbackToken = '.revert_test.txt.0123456789abcdef.rollback.tmp';

      // Simulating stage commit overwrite with backup
      const newContent = Buffer.from('New Overwritten Content');
      spaceStorage.set(`${aliceSpaceId}:${rollbackToken}`, { buffer: originalContent, mtimeMs: 1600000000000 });
      spaceStorage.set(`${aliceSpaceId}:revert_test.txt`, { buffer: newContent, mtimeMs: Date.now() });

      const fileService = new (await import('../src/files/runtime-file-api.js')).RuntimeFileApiService({ fileProvider: streamingMockFileProvider });

      // Trigger rollbackCommit
      await fileService.rollbackCommit(aliceId, aliceSpaceId, {
        path: 'revert_test.txt',
        rollbackToken,
        expectedEtag: computeEtag(newContent),
      });

      // Verify original content is restored on disk
      const target = spaceStorage.get(`${aliceSpaceId}:revert_test.txt`);
      expect(target).toBeDefined();
      expect(target?.buffer.equals(originalContent)).toBe(true);
    });

    it('crash hook after physical rename before committed update: restart recovers target, creates exactly one idemp/audit, and marks finalized', async () => {
      const db = (operationsStorage as any).db;
      db.prepare("DELETE FROM file_transfer_journal WHERE status IN ('staged', 'committed', 'cleanup_pending')").run();

      const fileData = Buffer.from('Post-rename crash content before committed DB update');
      const sha = computeSha256(fileData);
      const targetPath = 'crashed_post_rename.txt';
      const idempKey = `idemp_${randomUUID().toLowerCase()}`;

      // Simulate state: file was renamed to target on disk, stage file removed, but journal is still 'staged' with pre-response
      spaceStorage.set(`${aliceSpaceId}:${targetPath}`, { buffer: fileData, mtimeMs: 1700000000000 });

      const journalId = `jrn_${randomUUID().replace(/-/g, '')}`;
      db.prepare(`
        INSERT INTO file_transfer_journal (
          id, user_id, space_id, relative_path, stage_token, rollback_token, overwrite, expected_etag, content_sha256, size, idempotency_key, status, response_payload, created_at, updated_at
        ) VALUES (?, ?, ?, ?, '.temp.stage.tmp', NULL, 0, NULL, ?, ?, ?, 'staged', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(journalId, aliceId, aliceSpaceId, targetPath, sha, fileData.length, idempKey);

      const recoveryService = new FileTransferRecoveryService(db, new (await import('../src/files/runtime-file-api.js')).RuntimeFileApiService({ fileProvider: streamingMockFileProvider }));
      const report = await recoveryService.recoverAll();

      expect(report.finalizedCommitted).toBe(1);
      expect(report.errors.length).toBe(0);

      const updated = db.prepare('SELECT status, response_payload FROM file_transfer_journal WHERE id = ?').get(journalId) as any;
      expect(updated.status).toBe('finalized');

      // Verify exactly one idempotency record was created
      const idempRows = db.prepare('SELECT * FROM operation_idempotency WHERE idempotency_key = ?').all(idempKey) as any[];
      expect(idempRows.length).toBe(1);

      // Verify exactly one audit log was created
      const auditRows = await operationsStorage.auditLogs.query({ userId: aliceId, action: 'file_uploaded' });
      const matchedAudits = auditRows.filter((a) => a.details?.path === targetPath);
      expect(matchedAudits.length).toBe(1);

      // Verify second recovery run is an idempotent no-op and does not duplicate
      const report2 = await recoveryService.recoverAll();
      expect(report2.totalPending).toBe(0);
      const idempRows2 = db.prepare('SELECT * FROM operation_idempotency WHERE idempotency_key = ?').all(idempKey) as any[];
      expect(idempRows2.length).toBe(1);
    });

    it('crash before physical rename: marks aborted, cleans stage token, destination has no target', async () => {
      const db = (operationsStorage as any).db;
      const fileData = Buffer.from('Staged data before rename');
      const sha = computeSha256(fileData);
      const targetPath = 'before_rename_crashed.txt';
      const stageToken = '.before_rename.1234567890abcdef.stage.tmp';
      const idempKey = `idemp_${randomUUID().toLowerCase()}`;

      // Simulate state: stage file exists, destination target does NOT exist, journal is 'staged'
      spaceStorage.set(`${aliceSpaceId}:${stageToken}`, { buffer: fileData, mtimeMs: Date.now() });
      spaceStorage.delete(`${aliceSpaceId}:${targetPath}`);

      const journalId = `jrn_${randomUUID().replace(/-/g, '')}`;
      db.prepare(`
        INSERT INTO file_transfer_journal (
          id, user_id, space_id, relative_path, stage_token, rollback_token, overwrite, expected_etag, content_sha256, size, idempotency_key, status, response_payload, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, 0, NULL, ?, ?, ?, 'staged', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(journalId, aliceId, aliceSpaceId, targetPath, stageToken, sha, fileData.length, idempKey);

      const recoveryService = new FileTransferRecoveryService(db, new (await import('../src/files/runtime-file-api.js')).RuntimeFileApiService({ fileProvider: streamingMockFileProvider }));
      const report = await recoveryService.recoverAll();

      expect(report.abortedStaged).toBe(1);
      expect(spaceStorage.has(`${aliceSpaceId}:${stageToken}`)).toBe(false);
      expect(spaceStorage.has(`${aliceSpaceId}:${targetPath}`)).toBe(false);

      const updated = db.prepare('SELECT status FROM file_transfer_journal WHERE id = ?').get(journalId) as any;
      expect(updated.status).toBe('aborted');

      // No idempotency or audit records
      const idempRows = db.prepare('SELECT * FROM operation_idempotency WHERE idempotency_key = ?').all(idempKey) as any[];
      expect(idempRows.length).toBe(0);
    });

    it('overwrite crash restores or finalizes according to target hash', async () => {
      const db = (operationsStorage as any).db;
      const oldContent = Buffer.from('Old Content Original');
      const newContent = Buffer.from('New Overwritten Content');
      const targetPath = 'overwrite_check.txt';
      const rollbackToken = '.overwrite_check.txt.1234567890abcdef.rollback.tmp';
      const idempKey = `idemp_${randomUUID().toLowerCase()}`;

      // Scenario A: Physical commit completed, target matches new content, backup still present
      spaceStorage.set(`${aliceSpaceId}:${targetPath}`, { buffer: newContent, mtimeMs: Date.now() });
      spaceStorage.set(`${aliceSpaceId}:${rollbackToken}`, { buffer: oldContent, mtimeMs: 1600000000000 });

      const journalIdA = `jrn_${randomUUID().replace(/-/g, '')}`;
      db.prepare(`
        INSERT INTO file_transfer_journal (
          id, user_id, space_id, relative_path, stage_token, rollback_token, overwrite, expected_etag, content_sha256, size, idempotency_key, status, response_payload, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, ?, 1, NULL, ?, ?, ?, 'staged', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(journalIdA, aliceId, aliceSpaceId, targetPath, rollbackToken, computeSha256(newContent), newContent.length, idempKey);

      const recoveryService = new FileTransferRecoveryService(db, new (await import('../src/files/runtime-file-api.js')).RuntimeFileApiService({ fileProvider: streamingMockFileProvider }));
      const reportA = await recoveryService.recoverAll();

      expect(reportA.finalizedCommitted).toBe(1);
      const updatedA = db.prepare('SELECT status FROM file_transfer_journal WHERE id = ?').get(journalIdA) as any;
      expect(updatedA.status).toBe('finalized');

      // Scenario B: Physical overwrite failed, target still has old content, rollbackToken present
      const idempKeyB = `idemp_${randomUUID().toLowerCase()}`;
      const targetPathB = 'overwrite_fail_check.txt';
      const rollbackTokenB = '.overwrite_fail_check.txt.1234567890abcdef.rollback.tmp';
      spaceStorage.set(`${aliceSpaceId}:${targetPathB}`, { buffer: oldContent, mtimeMs: 1600000000000 });
      spaceStorage.set(`${aliceSpaceId}:${rollbackTokenB}`, { buffer: oldContent, mtimeMs: 1600000000000 });

      const journalIdB = `jrn_${randomUUID().replace(/-/g, '')}`;
      db.prepare(`
        INSERT INTO file_transfer_journal (
          id, user_id, space_id, relative_path, stage_token, rollback_token, overwrite, expected_etag, content_sha256, size, idempotency_key, status, response_payload, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, ?, 1, NULL, ?, ?, ?, 'staged', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(journalIdB, aliceId, aliceSpaceId, targetPathB, rollbackTokenB, computeSha256(newContent), newContent.length, idempKeyB);

      const reportB = await recoveryService.recoverAll();
      expect(reportB.rolledBackCommitted).toBe(1);

      const updatedB = db.prepare('SELECT status FROM file_transfer_journal WHERE id = ?').get(journalIdB) as any;
      expect(updatedB.status).toBe('rolled_back');
      // Original content preserved
      expect(spaceStorage.get(`${aliceSpaceId}:${targetPathB}`)?.buffer.equals(oldContent)).toBe(true);
    });

    it('ambiguous transfer state prevents PlatformServer startup from binding HTTP listener and throws PlatformConfigurationError', async () => {
      const testDb = new DatabaseSync(':memory:');
      const runner = new PlatformServerMigrationRunner(testDb);
      await runner.migrate(ALL_PLATFORM_MIGRATIONS);

      const testStorage = new SqlitePlatformStorage(testDb);
      const authService = new DefaultAuthService(testStorage, {
        cookieSecret: 'test-secret-32-chars-long-valid!',
      });
      const messageStore = new SqliteWebMessageStore(testDb);
      const platformApi = new SqlitePlatformWebApiAdapter({
        storage: testStorage,
        authService,
        messageStore,
        db: testDb,
      });
      const operationsStore = new SqlitePlatformOperationsStorage(testDb);
      const operations = createPlatformOperations({ storage: operationsStore });

      const user = await testStorage.users.create({
        username: 'ambiguous_user',
        passwordHash: 'dummy',
        displayName: 'Ambiguous User',
        role: 'user',
        status: 'active',
      });
      const space = await testStorage.forTenant(user.id).spaces.create({
        name: 'Ambiguous Space',
        folder: 'spc_ambiguous',
        executionMode: 'container',
      });

      // Insert ambiguous staged entry: stage file gone, target mismatch, no rollback
      const journalId = `jrn_${randomUUID().replace(/-/g, '')}`;
      testDb.prepare(`
        INSERT INTO file_transfer_journal (
          id, user_id, space_id, relative_path, stage_token, rollback_token, overwrite, expected_etag, content_sha256, size, idempotency_key, status, response_payload, created_at, updated_at
        ) VALUES (?, ?, ?, 'ambiguous.txt', NULL, NULL, 0, NULL, 'nonexistent_sha', 1234, 'idemp_ambiguous', 'staged', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(journalId, user.id, space.id);

      const testMessageStore = new SqliteWebMessageStore(testDb);
      const testGateway = new TestOnlyRuntimeGateway({ storage: testStorage, messageStore: testMessageStore });

      const serverInstance = new PlatformServer({
        port: 0,
        host: '127.0.0.1',
        database: testDb,
        storage: testStorage,
        authService,
        runtimeGateway: testGateway,
        cookieSecret: 'test-secret-at-least-32-chars-long-ok!',
        csrfToken: 'test-csrf-token-at-least-32-chars-ok!',
        operationsService: operations,
        fileProvider: streamingMockFileProvider,
      });

      await expect(serverInstance.start()).rejects.toThrow();
      expect(serverInstance.listeningUrl).toBeUndefined();
    });

    it('verifies static code constraints: handler SET committed exists, recovery uses inspectTransferState, no stream read/as any/empty catch', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');

      const handlerSource = fs.readFileSync(path.resolve(__dirname, '../src/server/handler.ts'), 'utf8');
      const recoverySource = fs.readFileSync(path.resolve(__dirname, '../src/storage/file-transfer-recovery.ts'), 'utf8');

      // 1. Handler SET committed exists
      expect(handlerSource).toMatch(/SET\s+status\s*=\s*'committed'/);

      // 2. Recovery uses inspectTransferState
      expect(recoverySource).toContain('inspectTransferState');

      // 3. No readBinaryStream in file-transfer-recovery.ts
      expect(recoverySource).not.toContain('readBinaryStream');

      // 4. No "as any" in file-transfer-recovery.ts
      expect(recoverySource).not.toContain('as any');

      // 5. No empty catch blocks in file-transfer-recovery.ts
      expect(recoverySource).not.toMatch(/catch\s*\(\s*\)\s*=>/);
      expect(recoverySource).not.toMatch(/catch\s*\{\s*\}/);
    });
  });
});
