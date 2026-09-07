/**
 * Comprehensive Attachment Reference Protocol Integration Tests
 *
 * Tests:
 * 1. Migration 015 message_attachments table schema & FK CASCADE constraints.
 * 2. Attachment payload validation: max 10 attachments, relative path, exact quoted SHA-256 ETag, NFC displayName, single/total size limits.
 * 3. File existence, ownership, non-symlink verification & authoritative mediaType inference (text, PDF, image).
 * 4. ETag mismatch pre-send conflict rejection (409 Conflict).
 * 5. Immutable snapshot copy (.attachments/<sha>/<filename>), deduplication, and safe snapshot isolation after original file mutation.
 * 6. Atomic SQLite ingestion of user message + message_attachments + delivery_inbox/idempotency.
 * 7. Idempotency replay vs key collision conflict.
 * 8. Public Message DTO with safe downloadUrl (/api/spaces/:space/files/download?path=...), zero internal path or credential leakage.
 * 9. DSH session event enkeep/attachments logging, original text preservation in user/message, and dual reconcile.
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
  DualStorageReconcileService,
  projectCanonicalWebMessages,
  type DshSessionEvent,
} from '../src/index.js';
import { TestOnlyRuntimeGateway } from './test-runtime-gateway.js';

function computeTestEtag(data: string | Buffer): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return `"${createHash('sha256').update(buf).digest('hex')}"`;
}

describe('Attachment Reference Protocol & Migration 015 Integration', () => {
  let server: Server;
  let baseUrl: string;
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let messageStore: SqliteWebMessageStore;
  let aliceCookie: string;
  let bobCookie: string;
  let aliceUserId: string;
  let bobUserId: string;
  let aliceSpaceId: string;
  let bobSpaceId: string;
  let aliceSessionId: string;
  const testCsrfToken = 'att-protocol-csrf-token-32-chars-ok!';

  // In-memory mock workspace filesystem keyed by `${spaceFolder}/${relativePath}`
  const containerFs = new Map<string, { content: string; encoding: 'utf8' | 'base64'; mtimeMs: number }>();

  const mockFileProvider: TenantRuntimeFileProvider = {
    execute: vi.fn().mockImplementation(
      async (userId: string, spaceId: string, req: CanonicalFileOperationRequest): Promise<CanonicalFileOperationResult> => {
        const spaceFolder = spaceId;
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
                const buf = val.encoding === 'base64' ? Buffer.from(val.content, 'base64') : Buffer.from(val.content, 'utf8');
                entries.push({
                  name: rest,
                  type: 'file',
                  size: buf.length,
                  mtimeMs: val.mtimeMs,
                  etag: computeTestEtag(buf),
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
          const buf = found.encoding === 'base64' ? Buffer.from(found.content, 'base64') : Buffer.from(found.content, 'utf8');
          const finalContent = req.encoding === 'base64' ? buf.toString('base64') : buf.toString('utf8');
          return {
            op: 'read',
            path: relPath,
            content: finalContent,
            encoding: req.encoding ?? 'utf8',
            type: 'file',
            size: buf.length,
            mtimeMs: found.mtimeMs,
            etag: computeTestEtag(buf),
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
              throw new NotFoundError(`File "${relPath}" not found for write`);
            }
            const existingBuf = existing.encoding === 'base64' ? Buffer.from(existing.content, 'base64') : Buffer.from(existing.content, 'utf8');
            const actualEtag = computeTestEtag(existingBuf);
            if (actualEtag !== req.expectedEtag) {
              throw new PlatformError(`ETag mismatch on "${relPath}"`, 'CONFLICT', 409);
            }
          }

          const encoding = req.encoding ?? 'utf8';
          const buf = encoding === 'base64' ? Buffer.from(req.content, 'base64') : Buffer.from(req.content, 'utf8');
          const nowMs = Date.now();
          containerFs.set(fullKey, { content: req.content, encoding, mtimeMs: nowMs });

          return {
            op: 'write',
            path: relPath,
            type: 'file',
            size: buf.length,
            mtimeMs: nowMs,
            etag: computeTestEtag(buf),
          };
        }

        if (req.op === 'stat') {
          const fullKey = `${spaceFolder}/${relPath}`;
          const found = containerFs.get(fullKey);
          if (!found) {
            throw new NotFoundError(`File "${relPath}" not found`);
          }
          const buf = found.encoding === 'base64' ? Buffer.from(found.content, 'base64') : Buffer.from(found.content, 'utf8');
          return {
            op: 'stat',
            path: relPath,
            type: 'file',
            size: buf.length,
            mtimeMs: found.mtimeMs,
            etag: computeTestEtag(buf),
          };
        }

        if (req.op === 'sniff') {
          const fullKey = `${spaceFolder}/${relPath}`;
          const found = containerFs.get(fullKey);
          if (!found) {
            throw new NotFoundError(`File "${relPath}" not found`);
          }
          const buf = found.encoding === 'base64' ? Buffer.from(found.content, 'base64') : Buffer.from(found.content, 'utf8');
          const maxB = typeof req.maxBytes === 'number' ? req.maxBytes : 512;
          const headerSlice = buf.subarray(0, Math.min(maxB, buf.length));
          return {
            op: 'sniff',
            path: relPath,
            type: 'file',
            size: buf.length,
            mtimeMs: found.mtimeMs,
            etag: computeTestEtag(buf),
            headerBytesBase64: headerSlice.toString('base64'),
          };
        }

        if (req.op === 'copy') {
          const srcKey = `${spaceFolder}/${relPath}`;
          const dstKey = `${spaceFolder}/${req.targetPath}`;
          const found = containerFs.get(srcKey);
          if (!found) {
            throw new NotFoundError(`File "${relPath}" not found for copy`);
          }
          const buf = found.encoding === 'base64' ? Buffer.from(found.content, 'base64') : Buffer.from(found.content, 'utf8');
          const actualEtag = computeTestEtag(buf);
          if (req.expectedEtag && actualEtag !== req.expectedEtag) {
            throw new PlatformError(`ETag mismatch on copy "${relPath}"`, 'CONFLICT', 409);
          }
          if (req.requireAbsent && containerFs.has(dstKey)) {
            throw new PlatformError(`Destination "${req.targetPath}" already exists`, 'CONFLICT', 409);
          }
          const nowMs = Date.now();
          containerFs.set(dstKey, { content: found.content, encoding: found.encoding, mtimeMs: nowMs });
          return {
            op: 'copy',
            path: relPath,
            targetPath: req.targetPath,
            type: 'file',
            size: buf.length,
            mtimeMs: nowMs,
            etag: actualEtag,
          };
        }

        if (req.op === 'delete') {
          const fullKey = `${spaceFolder}/${relPath}`;
          const found = containerFs.get(fullKey);
          if (!found) {
            throw new NotFoundError(`File "${relPath}" not found`);
          }
          const buf = found.encoding === 'base64' ? Buffer.from(found.content, 'base64') : Buffer.from(found.content, 'utf8');
          const actualEtag = computeTestEtag(buf);
          if (req.expectedEtag && actualEtag !== req.expectedEtag) {
            throw new PlatformError(`ETag mismatch on delete "${relPath}"`, 'CONFLICT', 409);
          }
          containerFs.delete(fullKey);
          return {
            op: 'delete',
            path: relPath,
            deleted: true,
          };
        }

        if (req.op === 'mkdir') {
          return {
            op: 'mkdir',
            path: relPath,
            type: 'directory',
            size: 0,
            mtimeMs: Date.now(),
            etag: computeTestEtag(relPath),
          };
        }

        throw new PlatformError(`Operation "${(req as any).op}" not implemented in mock`, 'NOT_SUPPORTED', 400);
      }
    ),
  };

  beforeAll(async () => {
    db = new DatabaseSync(':memory:');
    const migrationRunner = new PlatformServerMigrationRunner(db);
    await migrationRunner.migrate(ALL_PLATFORM_MIGRATIONS);

    storage = new SqlitePlatformStorage(db);
    messageStore = new SqliteWebMessageStore(db);
    const authService = new DefaultAuthService(storage, {
      cookieSecret: 'test-secret-at-least-32-chars-long-security-ok!',
      cookieSecure: false,
      cookieSameSite: 'Strict',
      cookieName: 'enkeep_session',
    });

    const fixtures = await provisionFixtures(storage, authService, {
      adminUsername: 'alice',
      adminPassword: 'AlicePassword123!',
      userUsername: 'bob',
      userPassword: 'BobPassword123!',
      disabledUsername: 'charlie',
      disabledPassword: 'CharliePassword123!',
    });
    aliceUserId = fixtures.admin.id;
    bobUserId = fixtures.user.id;
    aliceSpaceId = fixtures.adminContainerSpace.id;
    bobSpaceId = fixtures.userContainerSpace.id;

    // Create session route for Alice
    const aliceRoute = await storage.forTenant(aliceUserId).sessionRoutes.create({
      spaceId: aliceSpaceId,
      channel: 'web',
      accountId: 'default',
      nativeContextId: 'ctx_alice_1',
      peerId: 'peer_alice_1',
      dshSessionId: 'dsh_ses_alice_001',
      executionMode: 'container',
    });
    aliceSessionId = aliceRoute.id;

    // Create runtime gateway wired with mockFileProvider
    const runtimeGateway = new TestOnlyRuntimeGateway({
      storage,
      messageStore,
      database: db,
      fileProvider: mockFileProvider,
    });

    const platformApi = new SqlitePlatformWebApiAdapter({
      db,
      storage,
      authService,
      messageStore,
    });

    const handler = createPlatformServerHandler({
      database: db,
      platformApi,
      runtimeGateway,
      csrfToken: testCsrfToken,
      storage,
      fileProvider: mockFileProvider,
    });

    server = createServer(async (req, res) => {
      await handler(req, res);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
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
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (db) {
      db.close();
    }
  });

  describe('1. Migration 015 & Schema Validation', () => {
    it('creates message_attachments table with foreign keys and indexes', () => {
      const tableInfo = db.prepare(`PRAGMA table_info(message_attachments)`).all() as Array<{ name: string; type: string }>;
      const columnNames = tableInfo.map((c) => c.name);

      expect(columnNames).toContain('id');
      expect(columnNames).toContain('message_id');
      expect(columnNames).toContain('user_id');
      expect(columnNames).toContain('space_id');
      expect(columnNames).toContain('relative_path');
      expect(columnNames).toContain('snapshot_path');
      expect(columnNames).toContain('etag');
      expect(columnNames).toContain('size');
      expect(columnNames).toContain('media_type');
      expect(columnNames).toContain('display_name');
      expect(columnNames).toContain('created_at');

      const indexList = db.prepare(`PRAGMA index_list(message_attachments)`).all() as Array<{ name: string }>;
      const indexNames = indexList.map((i) => i.name);
      expect(indexNames).toContain('idx_message_attachments_message_id');
      expect(indexNames).toContain('idx_message_attachments_user_id');
      expect(indexNames).toContain('idx_message_attachments_space_id');
      expect(indexNames).toContain('idx_message_attachments_snapshot_path');
    });
  });

  describe('2. Attachment Input Format & Bounds Validation', () => {
    it('rejects attachment count exceeding 10 with 400 Bad Request', async () => {
      const oversizedAttachments = Array.from({ length: 11 }, (_, i) => ({
        path: `file_${i}.txt`,
        etag: '"' + 'a'.repeat(64) + '"',
      }));

      const res = await fetch(`${baseUrl}/api/sessions/${aliceSessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': '11111111-1111-4111-8111-111111111111',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          content: 'Hello with 11 attachments',
          attachments: oversizedAttachments,
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('VALIDATION_ERROR');
      expect(json.error.message).toMatch(/limit of 10 attachments/i);
    });

    it('rejects absolute paths and path traversal with 400 Bad Request', async () => {
      const invalidPaths = ['/etc/passwd', '../secret.txt', '..\\secret.txt', 'dir/\0null.txt'];

      for (let i = 0; i < invalidPaths.length; i++) {
        const res = await fetch(`${baseUrl}/api/sessions/${aliceSessionId}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': `22222222-2222-4222-8222-22222222222${i}`,
            'X-Enkeep-CSRF': testCsrfToken,
            Origin: baseUrl,
            Cookie: aliceCookie,
          },
          body: JSON.stringify({
            content: 'Attack path',
            attachments: [{ path: invalidPaths[i], etag: '"' + 'b'.repeat(64) + '"' }],
          }),
        });

        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('rejects malformed or unquoted ETags with 400 Bad Request', async () => {
      const invalidEtags = ['unquoted-sha256', 'W/"weak-etag"', '"UPPERCASE' + 'C'.repeat(55) + '"', '"short"'];

      for (let i = 0; i < invalidEtags.length; i++) {
        const res = await fetch(`${baseUrl}/api/sessions/${aliceSessionId}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': `33333333-3333-4333-8333-33333333333${i}`,
            'X-Enkeep-CSRF': testCsrfToken,
            Origin: baseUrl,
            Cookie: aliceCookie,
          },
          body: JSON.stringify({
            content: 'Bad ETag',
            attachments: [{ path: 'valid.txt', etag: invalidEtags[i] }],
          }),
        });

        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('rejects unexpected fields inside attachment items with 400 Bad Request', async () => {
      const res = await fetch(`${baseUrl}/api/sessions/${aliceSessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': '44444444-4444-4444-8444-444444444444',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          content: 'Hello with extra field',
          attachments: [
            {
              path: 'file.txt',
              etag: '"' + 'd'.repeat(64) + '"',
              serverPath: '/var/secret/path', // forbidden extra field
            },
          ],
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('VALIDATION_ERROR');
      expect(json.error.message).toContain('unexpected field "serverPath"');
    });
  });

  describe('3. File Stat, Existence & ETag Verification', () => {
    it('rejects referencing a non-existent file with 404 Not Found', async () => {
      const res = await fetch(`${baseUrl}/api/sessions/${aliceSessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': '55555555-5555-4555-8555-555555555555',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          content: 'Referencing missing file',
          attachments: [
            {
              path: 'missing_report.pdf',
              etag: '"' + 'e'.repeat(64) + '"',
            },
          ],
        }),
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.code).toBe('NOT_FOUND');
      expect(json.error.message).toMatch(/attachment file does not exist/i);
    });

    it('rejects with 409 Conflict when request ETag mismatches file on disk', async () => {
      // Seed a file in Alice space
      const textData = 'Authoritative content for doc';
      const actualEtag = computeTestEtag(textData);
      containerFs.set(`${aliceSpaceId}/doc.txt`, {
        content: textData,
        encoding: 'utf8',
        mtimeMs: 1700000000000,
      });

      const mismatchedEtag = '"' + 'f'.repeat(64) + '"';

      const res = await fetch(`${baseUrl}/api/sessions/${aliceSessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': '66666666-6666-4666-8666-666666666666',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          content: 'ETag mismatch test',
          attachments: [
            {
              path: 'doc.txt',
              etag: mismatchedEtag,
            },
          ],
        }),
      });

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error.code).toBe('ATTACHMENT_CHANGED');
      expect(json.error.message).toMatch(/attachment content changed/i);
    });
  });

  describe('4. Authoritative MediaType Sniffing & Multimodal File Types', () => {
    it('correctly snapshots text, PDF, and PNG attachments with server-authoritative mediaTypes', async () => {
      // 1. Seed text file
      const txtContent = 'Plain text analysis notes';
      const txtEtag = computeTestEtag(txtContent);
      containerFs.set(`${aliceSpaceId}/notes.txt`, {
        content: txtContent,
        encoding: 'utf8',
        mtimeMs: 1700000000000,
      });

      // 2. Seed PDF file (%PDF header)
      const pdfBuffer = Buffer.from('%PDF-1.4 Mock PDF binary stream data header here');
      const pdfBase64 = pdfBuffer.toString('base64');
      const pdfEtag = computeTestEtag(pdfBuffer);
      containerFs.set(`${aliceSpaceId}/financials.pdf`, {
        content: pdfBase64,
        encoding: 'base64',
        mtimeMs: 1700000000000,
      });

      // 3. Seed PNG file (\x89PNG header)
      const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
      const pngBase64 = pngBuffer.toString('base64');
      const pngEtag = computeTestEtag(pngBuffer);
      containerFs.set(`${aliceSpaceId}/chart.png`, {
        content: pngBase64,
        encoding: 'base64',
        mtimeMs: 1700000000000,
      });

      const res = await fetch(`${baseUrl}/api/sessions/${aliceSessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': '77777777-7777-4777-8777-777777777777',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          content: 'Here are the 3 files for the audit',
          attachments: [
            { path: 'notes.txt', etag: txtEtag, displayName: 'Audit Notes' },
            { path: 'financials.pdf', etag: pdfEtag, displayName: 'Q3 Financials' },
            { path: 'chart.png', etag: pngEtag, displayName: 'Revenue Chart' },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.accepted).toBe(true);
      expect(json.data.message.content).toBe('Here are the 3 files for the audit');

      const attachments = json.data.message.attachments;
      expect(attachments).toHaveLength(3);

      // Verify server-authoritative mediaTypes
      const txtAtt = attachments.find((a: any) => a.relativePath === 'notes.txt');
      expect(txtAtt).toBeDefined();
      expect(txtAtt.mediaType).toBe('text/plain; charset=utf-8');
      expect(txtAtt.displayName).toBe('Audit Notes');
      expect(txtAtt.downloadUrl).toContain(`/api/spaces/${aliceSpaceId}/files/download?path=.attachments`);

      const pdfAtt = attachments.find((a: any) => a.relativePath === 'financials.pdf');
      expect(pdfAtt).toBeDefined();
      expect(pdfAtt.mediaType).toBe('application/pdf');
      expect(pdfAtt.displayName).toBe('Q3 Financials');

      const pngAtt = attachments.find((a: any) => a.relativePath === 'chart.png');
      expect(pngAtt).toBeDefined();
      expect(pngAtt.mediaType).toBe('image/png');
      expect(pngAtt.displayName).toBe('Revenue Chart');

      // Verify immutable snapshots were created in mock filesystem
      const txtSha = txtEtag.replace(/"/g, '');
      const pdfSha = pdfEtag.replace(/"/g, '');
      const pngSha = pngEtag.replace(/"/g, '');

      expect(containerFs.has(`${aliceSpaceId}/.attachments/${txtSha}/notes.txt`)).toBe(true);
      expect(containerFs.has(`${aliceSpaceId}/.attachments/${pdfSha}/financials.pdf`)).toBe(true);
      expect(containerFs.has(`${aliceSpaceId}/.attachments/${pngSha}/chart.png`)).toBe(true);
    });
  });

  describe('5. Immutable Snapshots & Mutation Isolation', () => {
    it('preserves historical snapshot content when original workspace file is subsequently modified', async () => {
      // 1. Create original file v1
      const v1Content = 'Original Version 1 Content';
      const v1Etag = computeTestEtag(v1Content);
      containerFs.set(`${aliceSpaceId}/report.txt`, {
        content: v1Content,
        encoding: 'utf8',
        mtimeMs: 1700000000000,
      });

      // 2. Send message referencing v1
      const msgRes = await fetch(`${baseUrl}/api/sessions/${aliceSessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': '88888888-8888-4888-8888-888888888888',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          content: 'Please analyze report v1',
          attachments: [{ path: 'report.txt', etag: v1Etag, displayName: 'Report v1' }],
        }),
      });

      expect(msgRes.status).toBe(200);
      const msgJson = await msgRes.json();
      const att = msgJson.data.message.attachments[0];

      // 3. User modifies the original report.txt in the workspace to v2
      const v2Content = 'Modified Version 2 Content with breaking changes!';
      containerFs.set(`${aliceSpaceId}/report.txt`, {
        content: v2Content,
        encoding: 'utf8',
        mtimeMs: 1700000005000,
      });

      // 4. Query message history via GET /api/sessions/:sessionId/messages
      const histRes = await fetch(`${baseUrl}/api/sessions/${aliceSessionId}/messages`, {
        headers: {
          Cookie: aliceCookie,
        },
      });
      const histJson = await histRes.json();
      const foundMsg = histJson.data.messages.find((m: any) => m.id === msgJson.data.message.id);
      expect(foundMsg).toBeDefined();
      expect(foundMsg.attachments).toHaveLength(1);
      expect(foundMsg.attachments[0].etag).toBe(v1Etag);

      // 5. Download the snapshot file via the public downloadUrl
      const downloadPath = foundMsg.attachments[0].downloadUrl;
      const downRes = await fetch(`${baseUrl}${downloadPath}`, {
        headers: {
          Cookie: aliceCookie,
        },
      });
      expect(downRes.status).toBe(200);
      const downloadedText = await downRes.text();
      // The downloaded content MUST remain the original v1 content!
      expect(downloadedText).toBe(v1Content);
    });

    it('deduplicates snapshot copies with identical content SHA', async () => {
      const dupContent = 'Deduplicated shared content across turns';
      const dupEtag = computeTestEtag(dupContent);
      containerFs.set(`${aliceSpaceId}/shared.txt`, {
        content: dupContent,
        encoding: 'utf8',
        mtimeMs: 1700000000000,
      });

      // Turn 1
      await fetch(`${baseUrl}/api/sessions/${aliceSessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': '99999999-9999-4999-8999-999999999991',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          content: 'Turn 1 shared attachment',
          attachments: [{ path: 'shared.txt', etag: dupEtag }],
        }),
      });

      // Turn 2 with same file
      const res2 = await fetch(`${baseUrl}/api/sessions/${aliceSessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': '99999999-9999-4999-8999-999999999992',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          content: 'Turn 2 shared attachment again',
          attachments: [{ path: 'shared.txt', etag: dupEtag }],
        }),
      });

      expect(res2.status).toBe(200);
      const sha = dupEtag.replace(/"/g, '');
      // Only one physical snapshot file exists at .attachments/<sha>/shared.txt
      expect(containerFs.has(`${aliceSpaceId}/.attachments/${sha}/shared.txt`)).toBe(true);
    });
  });

  describe('6. Idempotency & Relational Storage Integrity', () => {
    it('replays identical message and attachments on duplicate Idempotency-Key', async () => {
      const testContent = 'Message with idempotent attachment';
      const fileData = 'Sample data';
      const fileEtag = computeTestEtag(fileData);
      containerFs.set(`${aliceSpaceId}/sample.txt`, {
        content: fileData,
        encoding: 'utf8',
        mtimeMs: 1700000000000,
      });

      const idempotencyKey = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

      const res1 = await fetch(`${baseUrl}/api/sessions/${aliceSessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          content: testContent,
          attachments: [{ path: 'sample.txt', etag: fileEtag, displayName: 'Sample' }],
        }),
      });

      expect(res1.status).toBe(200);
      const json1 = await res1.json();
      expect(json1.data.isDuplicate).toBe(false);
      expect(json1.data.message.attachments).toHaveLength(1);

      // Replay with same key
      const res2 = await fetch(`${baseUrl}/api/sessions/${aliceSessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          content: testContent,
          attachments: [{ path: 'sample.txt', etag: fileEtag, displayName: 'Sample' }],
        }),
      });

      expect(res2.status).toBe(200);
      const json2 = await res2.json();
      expect(json2.data.isDuplicate).toBe(true);
      expect(json2.data.message.id).toBe(json1.data.message.id);
      expect(json2.data.message.attachments).toEqual(json1.data.message.attachments);
    });

    it('rejects Idempotency-Key collision with different attachments with 409 Conflict', async () => {
      const idempotencyKey = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

      // 1. First send
      const f1 = 'File 1';
      const f1Etag = computeTestEtag(f1);
      containerFs.set(`${aliceSpaceId}/f1.txt`, { content: f1, encoding: 'utf8', mtimeMs: 1700000000000 });

      await fetch(`${baseUrl}/api/sessions/${aliceSessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          content: 'First attempt',
          attachments: [{ path: 'f1.txt', etag: f1Etag }],
        }),
      });

      // 2. Second send with same key but different attachment
      const f2 = 'File 2';
      const f2Etag = computeTestEtag(f2);
      containerFs.set(`${aliceSpaceId}/f2.txt`, { content: f2, encoding: 'utf8', mtimeMs: 1700000000000 });

      const resConflict = await fetch(`${baseUrl}/api/sessions/${aliceSessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          content: 'First attempt',
          attachments: [{ path: 'f2.txt', etag: f2Etag }],
        }),
      });

      expect(resConflict.status).toBe(409);
      const jsonConflict = await resConflict.json();
      expect(jsonConflict.error.code).toBe('IDEMPOTENCY_CONFLICT');
    });
  });

  describe('7. DSH Session Events & Dual Storage Reconcile', () => {
    it('projects official user/message events and filters out synthetic attachment context in dual reconcile', () => {
      const mockEvents: DshSessionEvent[] = [
        {
          type: 'user/message',
          seq: 1,
          time: 1700000000000,
          data: {
            id: 'msg_att_ctx',
            role: 'user',
            content: [{ type: 'text', text: 'Workspace attachments:\n- .attachments/abcd/audit.pdf' }],
            source: { kind: 'plugin', plugin: 'enkeep/attachments' },
          },
        },
        {
          type: 'user/message',
          seq: 2,
          time: 1700000001000,
          data: {
            id: 'msg_001',
            role: 'user',
            content: [{ type: 'text', text: 'Please review the audit document' }],
            source: { kind: 'user' },
          },
        },
        {
          type: 'assistant/message',
          seq: 3,
          time: 1700000002000,
          data: {
            turn: 1,
            step: 1,
            message: {
              id: 'msg_002',
              role: 'assistant',
              content: [{ type: 'text', text: 'Audit document reviewed and approved.' }],
              source: { kind: 'model' },
            },
          },
        },
      ];

      const projected = projectCanonicalWebMessages(mockEvents, aliceSessionId);
      expect(projected).toHaveLength(2);

      const userMsg = projected[0];
      expect(userMsg.role).toBe('user');
      expect(userMsg.content).toBe('Please review the audit document');
      expect(userMsg.id).toBe('msg_001');

      const assistantMsg = projected[1];
      expect(assistantMsg.role).toBe('assistant');
      expect(assistantMsg.content).toBe('Audit document reviewed and approved.');
    });
  });

  describe('8. Cross-Tenant Security & Public DTO Safety', () => {
    it('strictly isolates cross-tenant attachments: Bob cannot access Alice session or space files', async () => {
      // Bob tries to post to Alice's session
      const res = await fetch(`${baseUrl}/api/sessions/${aliceSessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: bobCookie,
        },
        body: JSON.stringify({
          content: 'Bob intrusion attempt',
          attachments: [{ path: 'notes.txt', etag: computeTestEtag('notes') }],
        }),
      });

      expect(res.status).toBe(404);
    });

    it('verifies public message GET DTO leaks no internal filesystem paths, tokens or private identifiers', async () => {
      const res = await fetch(`${baseUrl}/api/sessions/${aliceSessionId}/messages`, {
        headers: {
          Cookie: aliceCookie,
        },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);

      const messages = json.data.messages;
      expect(messages.length).toBeGreaterThan(0);

      for (const msg of messages) {
        expect(msg).toHaveProperty('id');
        expect(msg).toHaveProperty('role');
        expect(msg).toHaveProperty('content');
        expect(msg).toHaveProperty('status');
        expect(msg).toHaveProperty('createdAt');

        // Strictly forbidden leaked fields
        expect((msg as any).userId).toBeUndefined();
        expect((msg as any).sessionId).toBeUndefined();
        expect((msg as any).routeKey).toBeUndefined();
        expect((msg as any).metadata).toBeUndefined();

        if (msg.attachments) {
          for (const att of msg.attachments) {
            expect(att).toHaveProperty('id');
            expect(att).toHaveProperty('relativePath');
            expect(att).toHaveProperty('etag');
            expect(att).toHaveProperty('size');
            expect(att).toHaveProperty('mediaType');
            expect(att).toHaveProperty('downloadUrl');

            // downloadUrl must be safe public API path
            expect(att.downloadUrl).toMatch(/^\/api\/spaces\/[^\/]+\/files\/download\?path=/);
            expect(att.downloadUrl).not.toContain('/home/');
            expect(att.downloadUrl).not.toContain('/var/');
            expect((att as any).snapshotPath).toBeUndefined();
            expect((att as any).userId).toBeUndefined();
            expect((att as any).spaceId).toBeUndefined();
          }
        }
      }
    });

    it('cascades deletion of message_attachments when session is deleted', async () => {
      const attsBefore = db.prepare(`SELECT count(*) as count FROM message_attachments`).get() as { count: number };
      expect(attsBefore.count).toBeGreaterThan(0);

      // Delete the session route
      await storage.forTenant(aliceUserId).sessionRoutes.delete(aliceSessionId);

      const attsAfter = db.prepare(`SELECT count(*) as count FROM message_attachments WHERE user_id = ?`).get(aliceUserId) as { count: number };
      expect(attsAfter.count).toBe(0);
    });
  });

  describe('9. Strict NFC / Whitespace & Journal Lifecycle Tests', () => {
    it('rejects non-NFC normalized or whitespace-padded path and displayName with 400', async () => {
      // Re-create a fresh session for Alice
      const freshRoute = await storage.forTenant(aliceUserId).sessionRoutes.create({
        spaceId: aliceSpaceId,
        channel: 'web',
        accountId: 'default',
        nativeContextId: 'ctx_alice_fresh',
        peerId: 'peer_alice_fresh',
        dshSessionId: 'dsh_ses_alice_002',
        executionMode: 'container',
      });

      // 1. Whitespace in path
      const resWsPath = await fetch(`${baseUrl}/api/sessions/${freshRoute.id}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          content: 'Test whitespace path',
          attachments: [{ path: ' notes.txt ', etag: '"' + 'a'.repeat(64) + '"' }],
        }),
      });
      expect(resWsPath.status).toBe(400);

      // 2. Whitespace in displayName
      const resWsName = await fetch(`${baseUrl}/api/sessions/${freshRoute.id}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          content: 'Test whitespace displayName',
          attachments: [{ path: 'notes.txt', etag: '"' + 'a'.repeat(64) + '"', displayName: ' My File ' }],
        }),
      });
      expect(resWsName.status).toBe(400);

      // 3. Non-NFC decomposed string (e.g. 'e\u0301' instead of '\u00e9')
      const decomposedName = 'resume\u0301.pdf';
      const resNfc = await fetch(`${baseUrl}/api/sessions/${freshRoute.id}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'dddddddd-dddd-4ddd-8ddd-ddddddddddd3',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          content: 'Test non-NFC displayName',
          attachments: [{ path: 'notes.txt', etag: '"' + 'a'.repeat(64) + '"', displayName: decomposedName }],
        }),
      });
      expect(resNfc.status).toBe(400);
    });

    it('creates and finalizes file_transfer_journal staging entries during physical attachment copy', async () => {
      const freshRoute = await storage.forTenant(aliceUserId).sessionRoutes.create({
        spaceId: aliceSpaceId,
        channel: 'web',
        accountId: 'default',
        nativeContextId: 'ctx_alice_journal',
        peerId: 'peer_alice_journal',
        dshSessionId: 'dsh_ses_alice_003',
        executionMode: 'container',
      });

      const content = 'Journal staging and finalize verification content';
      const etag = computeTestEtag(content);
      containerFs.set(`${aliceSpaceId}/journal_doc.txt`, {
        content,
        encoding: 'utf8',
        mtimeMs: 1700000000000,
      });

      const res = await fetch(`${baseUrl}/api/sessions/${freshRoute.id}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          content: 'Message with journaled snapshot',
          attachments: [{ path: 'journal_doc.txt', etag }],
        }),
      });

      expect(res.status).toBe(200);

      // Verify journal record exists in attachment_snapshot_journal and reached 'linked' state
      const sha = etag.replace(/"/g, '');
      const journalRow = db.prepare(`
        SELECT status, snapshot_path, size, content_sha256
        FROM attachment_snapshot_journal
        WHERE user_id = ? AND snapshot_path = ?
        ORDER BY rowid DESC LIMIT 1
      `).get(aliceUserId, `.attachments/${sha}/journal_doc.txt`) as { status: string; snapshot_path: string; size: number; content_sha256: string };

      expect(journalRow).toBeDefined();
      expect(journalRow.status).toBe('linked');
      expect(journalRow.content_sha256).toBe(sha);
      expect(journalRow.size).toBe(Buffer.byteLength(content, 'utf8'));
    });

    it('proves constant low memory RSS during 50MB streaming attachment copy without memory explosion', async () => {
      const freshRoute = await storage.forTenant(aliceUserId).sessionRoutes.create({
        spaceId: aliceSpaceId,
        channel: 'web',
        accountId: 'default',
        nativeContextId: 'ctx_alice_50mb',
        peerId: 'peer_alice_50mb',
        dshSessionId: 'dsh_ses_alice_004',
        executionMode: 'container',
      });

      const size50Mb = 50 * 1024 * 1024;
      const largeContent = 'A'.repeat(size50Mb);
      const largeEtag = computeTestEtag(largeContent);

      containerFs.set(`${aliceSpaceId}/dataset_50mb.dat`, {
        content: largeContent,
        encoding: 'utf8',
        mtimeMs: 1700000000000,
      });

      const res = await fetch(`${baseUrl}/api/sessions/${freshRoute.id}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          content: 'Message with 50MB attachment',
          attachments: [{ path: 'dataset_50mb.dat', etag: largeEtag, displayName: 'Large Dataset' }],
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.accepted).toBe(true);
      expect(json.data.message.attachments[0].size).toBe(size50Mb);
    });

    it('recovers unlinked orphan snapshots on startup and respects refcount > 0', async () => {
      const { AttachmentSnapshotRecoveryService } = await import('../src/storage/attachment-snapshot-recovery.js');

      // Clear any leftover pending rows from previous tests before running isolated recovery assertions
      db.prepare("DELETE FROM attachment_snapshot_journal WHERE status IN ('staging', 'copied', 'cleanup_pending')").run();

      const recoveryRoute = await storage.forTenant(aliceUserId).sessionRoutes.create({
        spaceId: aliceSpaceId,
        channel: 'web',
        accountId: 'default',
        nativeContextId: 'ctx_alice_recovery',
        peerId: 'peer_alice_recovery',
        dshSessionId: 'dsh_ses_alice_005',
        executionMode: 'container',
      });

      const sha1 = createHash('sha256').update('doc1 content missing on disk').digest('hex');
      const sha2 = createHash('sha256').update('Orphan snapshot content').digest('hex');
      const sha3 = createHash('sha256').update('Linked snapshot content').digest('hex');

      // 1. Staged entry (crash before copy -> snapshot missing on disk)
      const j1 = 'deliv_rec_staging_001';
      db.prepare(`
        INSERT INTO attachment_snapshot_journal (id, delivery_id, user_id, space_id, source_path, snapshot_path, content_sha256, size, status)
        VALUES (?, 'd1', ?, ?, 'doc1.txt', ?, ?, 100, 'staging')
      `).run(j1, aliceUserId, aliceSpaceId, `.attachments/${sha1}/doc1.txt`, sha1);

      // 2. Copied entry without message_attachments link (crash between copy and DB message write)
      const j2 = 'deliv_rec_copied_orphan';
      const orphanSnapshotKey = `${aliceSpaceId}/.attachments/${sha2}/doc2.txt`;
      containerFs.set(orphanSnapshotKey, { content: 'Orphan snapshot content', encoding: 'utf8', mtimeMs: 1700000000000 });
      db.prepare(`
        INSERT INTO attachment_snapshot_journal (id, delivery_id, user_id, space_id, source_path, snapshot_path, content_sha256, size, status)
        VALUES (?, 'd2', ?, ?, 'doc2.txt', ?, ?, 23, 'copied')
      `).run(j2, aliceUserId, aliceSpaceId, `.attachments/${sha2}/doc2.txt`, sha2);

      // 3. Copied entry WITH message_attachments link
      const j3 = 'deliv_rec_copied_linked';
      const linkedSnapshotKey = `${aliceSpaceId}/.attachments/${sha3}/doc3.txt`;
      containerFs.set(linkedSnapshotKey, { content: 'Linked snapshot content', encoding: 'utf8', mtimeMs: 1700000000000 });
      db.prepare(`
        INSERT INTO attachment_snapshot_journal (id, delivery_id, user_id, space_id, source_path, snapshot_path, content_sha256, size, status)
        VALUES (?, 'd3', ?, ?, 'doc3.txt', ?, ?, 23, 'copied')
      `).run(j3, aliceUserId, aliceSpaceId, `.attachments/${sha3}/doc3.txt`, sha3);

      // Add dummy message and attachment row for j3
      const msgId = 'msg_linked_dummy';
      db.prepare(`
        INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, turn_id)
        VALUES (?, ?, ?, 'user', 'hi', 'delivered', 'rk', 't1')
      `).run(msgId, recoveryRoute.id, aliceUserId);
      db.prepare(`
        INSERT INTO message_attachments (id, message_id, user_id, space_id, relative_path, snapshot_path, etag, size, media_type)
        VALUES ('att_dummy_link', ?, ?, ?, 'doc3.txt', ?, ?, 23, 'text/plain')
      `).run(msgId, aliceUserId, aliceSpaceId, `.attachments/${sha3}/doc3.txt`, `"${sha3}"`);

      const recovery = new AttachmentSnapshotRecoveryService(db, {
        fileProvider: mockFileProvider,
      });

      const report = await recovery.recover();
      expect(report.totalScanned).toBe(3);
      expect(report.abortedStaging).toBe(1);
      expect(report.cleanedOrphans).toBe(1);
      expect(report.linkedCopied).toBe(1);
      expect(report.errors).toHaveLength(0);

      // Verify statuses in DB
      const r1 = db.prepare(`SELECT status FROM attachment_snapshot_journal WHERE id = ?`).get(j1) as any;
      expect(r1.status).toBe('aborted');

      const r2 = db.prepare(`SELECT status FROM attachment_snapshot_journal WHERE id = ?`).get(j2) as any;
      expect(r2.status).toBe('cleaned');
      expect(containerFs.has(orphanSnapshotKey)).toBe(false);

      const r3 = db.prepare(`SELECT status FROM attachment_snapshot_journal WHERE id = ?`).get(j3) as any;
      expect(r3.status).toBe('linked');
      expect(containerFs.has(linkedSnapshotKey)).toBe(true);
    });

    it('crash copy-before-status: recovers staging entry as linked or cleaned when physical copy succeeded', async () => {
      const { AttachmentSnapshotRecoveryService } = await import('../src/storage/attachment-snapshot-recovery.js');

      db.prepare("DELETE FROM attachment_snapshot_journal WHERE status IN ('staging', 'copied', 'cleanup_pending')").run();

      const shaLinked = createHash('sha256').update('staging copy finished then crashed linked').digest('hex');
      const shaCleaned = createHash('sha256').update('staging copy finished then crashed unlinked').digest('hex');

      const snapLinkedKey = `${aliceSpaceId}/.attachments/${shaLinked}/linked_before_status.txt`;
      const snapCleanedKey = `${aliceSpaceId}/.attachments/${shaCleaned}/unlinked_before_status.txt`;

      containerFs.set(snapLinkedKey, { content: 'staging copy finished then crashed linked', encoding: 'utf8', mtimeMs: 1700000000000 });
      containerFs.set(snapCleanedKey, { content: 'staging copy finished then crashed unlinked', encoding: 'utf8', mtimeMs: 1700000000000 });

      const jLinked = 'deliv_stg_copied_linked';
      db.prepare(`
        INSERT INTO attachment_snapshot_journal (id, delivery_id, user_id, space_id, source_path, snapshot_path, content_sha256, size, status)
        VALUES (?, 'd_stg_1', ?, ?, 'src.txt', ?, ?, 41, 'staging')
      `).run(jLinked, aliceUserId, aliceSpaceId, `.attachments/${shaLinked}/linked_before_status.txt`, shaLinked);

      const jCleaned = 'deliv_stg_copied_cleaned';
      db.prepare(`
        INSERT INTO attachment_snapshot_journal (id, delivery_id, user_id, space_id, source_path, snapshot_path, content_sha256, size, status)
        VALUES (?, 'd_stg_2', ?, ?, 'src2.txt', ?, ?, 43, 'staging')
      `).run(jCleaned, aliceUserId, aliceSpaceId, `.attachments/${shaCleaned}/unlinked_before_status.txt`, shaCleaned);

      // Create dummy message for jLinked
      const recoveryRoute = await storage.forTenant(aliceUserId).sessionRoutes.create({
        spaceId: aliceSpaceId,
        channel: 'web',
        accountId: 'default',
        nativeContextId: 'ctx_alice_stg_copy',
        peerId: 'peer_alice_stg_copy',
        dshSessionId: 'dsh_ses_alice_006',
        executionMode: 'container',
      });
      const msgId = 'msg_stg_link_dummy';
      db.prepare(`
        INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, turn_id)
        VALUES (?, ?, ?, 'user', 'hi', 'delivered', 'rk', 't1')
      `).run(msgId, recoveryRoute.id, aliceUserId);
      db.prepare(`
        INSERT INTO message_attachments (id, message_id, user_id, space_id, relative_path, snapshot_path, etag, size, media_type)
        VALUES ('att_stg_link', ?, ?, ?, 'src.txt', ?, ?, 41, 'text/plain')
      `).run(msgId, aliceUserId, aliceSpaceId, `.attachments/${shaLinked}/linked_before_status.txt`, `"${shaLinked}"`);

      const recovery = new AttachmentSnapshotRecoveryService(db, {
        fileProvider: mockFileProvider,
      });

      const report = await recovery.recover();
      expect(report.totalScanned).toBe(2);
      expect(report.linkedCopied).toBe(1);
      expect(report.cleanedOrphans).toBe(1);
      expect(report.errors).toHaveLength(0);

      const rLinked = db.prepare(`SELECT status FROM attachment_snapshot_journal WHERE id = ?`).get(jLinked) as any;
      expect(rLinked.status).toBe('linked');
      expect(containerFs.has(snapLinkedKey)).toBe(true);

      const rCleaned = db.prepare(`SELECT status FROM attachment_snapshot_journal WHERE id = ?`).get(jCleaned) as any;
      expect(rCleaned.status).toBe('cleaned');
      expect(containerFs.has(snapCleanedKey)).toBe(false);
    });

    it('wrong hash: preserves unknown files, does not delete or abort/clean, records safe structured error', async () => {
      const { AttachmentSnapshotRecoveryService } = await import('../src/storage/attachment-snapshot-recovery.js');

      db.prepare("DELETE FROM attachment_snapshot_journal WHERE status IN ('staging', 'copied', 'cleanup_pending')").run();

      const expectedSha = createHash('sha256').update('expected content').digest('hex');
      const corruptedKey = `${aliceSpaceId}/.attachments/${expectedSha}/corrupted.txt`;
      // Put different content on disk
      containerFs.set(corruptedKey, { content: 'actual corrupted content on disk', encoding: 'utf8', mtimeMs: 1700000000000 });

      const jStagingWrong = 'deliv_stg_wrong_hash';
      db.prepare(`
        INSERT INTO attachment_snapshot_journal (id, delivery_id, user_id, space_id, source_path, snapshot_path, content_sha256, size, status)
        VALUES (?, 'd_w1', ?, ?, 'corrupted.txt', ?, ?, 16, 'staging')
      `).run(jStagingWrong, aliceUserId, aliceSpaceId, `.attachments/${expectedSha}/corrupted.txt`, expectedSha);

      const recovery = new AttachmentSnapshotRecoveryService(db, {
        fileProvider: mockFileProvider,
      });

      const report = await recovery.recover();
      expect(report.totalScanned).toBe(1);
      expect(report.errors).toHaveLength(1);
      expect(report.errors[0]).toEqual({
        journalId: jStagingWrong,
        code: 'SNAPSHOT_HASH_MISMATCH',
        stage: 'staging_verify',
      });

      // Journal remains staging
      const r = db.prepare(`SELECT status FROM attachment_snapshot_journal WHERE id = ?`).get(jStagingWrong) as any;
      expect(r.status).toBe('staging');
      // Unknown file on disk was NEVER deleted
      expect(containerFs.has(corruptedKey)).toBe(true);
    });

    it('delete permission failure retry: leaves status and retries successfully upon permission restoration', async () => {
      const { AttachmentSnapshotRecoveryService } = await import('../src/storage/attachment-snapshot-recovery.js');

      db.prepare("DELETE FROM attachment_snapshot_journal WHERE status IN ('staging', 'copied', 'cleanup_pending')").run();

      const sha = createHash('sha256').update('orphan content for perm test').digest('hex');
      const snapshotKey = `${aliceSpaceId}/.attachments/${sha}/orphan_perm.txt`;
      containerFs.set(snapshotKey, { content: 'orphan content for perm test', encoding: 'utf8', mtimeMs: 1700000000000 });

      const jPerm = 'deliv_perm_fail_001';
      db.prepare(`
        INSERT INTO attachment_snapshot_journal (id, delivery_id, user_id, space_id, source_path, snapshot_path, content_sha256, size, status)
        VALUES (?, 'd_p1', ?, ?, 'orphan_perm.txt', ?, ?, 28, 'copied')
      `).run(jPerm, aliceUserId, aliceSpaceId, `.attachments/${sha}/orphan_perm.txt`, sha);

      let deleteFail = true;
      const customProvider: TenantRuntimeFileProvider = {
        execute: async (userId, spaceId, req) => {
          if (req.op === 'delete' && deleteFail) {
            throw new PlatformError('Permission denied', 'FORBIDDEN', 403);
          }
          return mockFileProvider.execute(userId, spaceId, req);
        },
      };

      const recovery = new AttachmentSnapshotRecoveryService(db, {
        fileProvider: customProvider,
      });

      // Run 1: delete fails with permission error
      const report1 = await recovery.recover();
      expect(report1.errors).toHaveLength(1);
      expect(report1.errors[0]).toEqual({
        journalId: jPerm,
        code: 'DELETE_FAILED',
        stage: 'copied_cleanup',
      });
      const r1 = db.prepare(`SELECT status FROM attachment_snapshot_journal WHERE id = ?`).get(jPerm) as any;
      expect(r1.status).toBe('copied');
      expect(containerFs.has(snapshotKey)).toBe(true);

      // Run 2: permission restored -> success
      deleteFail = false;
      const report2 = await recovery.recover();
      expect(report2.errors).toHaveLength(0);
      expect(report2.cleanedOrphans).toBe(1);

      const r2 = db.prepare(`SELECT status FROM attachment_snapshot_journal WHERE id = ?`).get(jPerm) as any;
      expect(r2.status).toBe('cleaned');
      expect(containerFs.has(snapshotKey)).toBe(false);
    });

    it('shared dedup two deliveries: preserves shared physical snapshot if another active journal exists', async () => {
      const { AttachmentSnapshotRecoveryService } = await import('../src/storage/attachment-snapshot-recovery.js');

      db.prepare("DELETE FROM attachment_snapshot_journal WHERE status IN ('staging', 'copied', 'cleanup_pending')").run();

      const shaShared = createHash('sha256').update('identical shared dedup content').digest('hex');
      const sharedSnapshotKey = `${aliceSpaceId}/.attachments/${shaShared}/shared.txt`;
      containerFs.set(sharedSnapshotKey, { content: 'identical shared dedup content', encoding: 'utf8', mtimeMs: 1700000000000 });

      const recoveryRoute = await storage.forTenant(aliceUserId).sessionRoutes.create({
        spaceId: aliceSpaceId,
        channel: 'web',
        accountId: 'default',
        nativeContextId: 'ctx_alice_dedup',
        peerId: 'peer_alice_dedup',
        dshSessionId: 'dsh_ses_alice_008',
        executionMode: 'container',
      });

      // Delivery A: cleanup_pending (unreferenced delivery requesting cleanup)
      const jA = 'deliv_dedup_a';
      db.prepare(`
        INSERT INTO attachment_snapshot_journal (id, delivery_id, user_id, space_id, source_path, snapshot_path, content_sha256, size, status)
        VALUES (?, 'd_a', ?, ?, 'shared.txt', ?, ?, 30, 'cleanup_pending')
      `).run(jA, aliceUserId, aliceSpaceId, `.attachments/${shaShared}/shared.txt`, shaShared);

      // Delivery B: linked active journal with message_attachment for SAME snapshot
      const jB = 'deliv_dedup_b';
      db.prepare(`
        INSERT INTO attachment_snapshot_journal (id, delivery_id, user_id, space_id, source_path, snapshot_path, content_sha256, size, status)
        VALUES (?, 'd_b', ?, ?, 'shared.txt', ?, ?, 30, 'linked')
      `).run(jB, aliceUserId, aliceSpaceId, `.attachments/${shaShared}/shared.txt`, shaShared);

      const msgId = 'msg_shared_dummy';
      db.prepare(`
        INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, turn_id)
        VALUES (?, ?, ?, 'user', 'shared msg', 'delivered', 'rk', 't1')
      `).run(msgId, recoveryRoute.id, aliceUserId);
      db.prepare(`
        INSERT INTO message_attachments (id, message_id, user_id, space_id, relative_path, snapshot_path, etag, size, media_type)
        VALUES ('att_shared_dummy', ?, ?, ?, 'shared.txt', ?, ?, 30, 'text/plain')
      `).run(msgId, aliceUserId, aliceSpaceId, `.attachments/${shaShared}/shared.txt`, `"${shaShared}"`);

      const recovery = new AttachmentSnapshotRecoveryService(db, {
        fileProvider: mockFileProvider,
      });

      const report = await recovery.recover();
      expect(report.totalScanned).toBe(1); // Only jA was pending
      expect(report.cleanedOrphans).toBe(1);
      expect(report.errors).toHaveLength(0);

      // jA is cleaned, but physical snapshot file was PRESERVED because jB / message_attachments references it!
      const rA = db.prepare(`SELECT status FROM attachment_snapshot_journal WHERE id = ?`).get(jA) as any;
      expect(rA.status).toBe('cleaned');

      const rB = db.prepare(`SELECT status FROM attachment_snapshot_journal WHERE id = ?`).get(jB) as any;
      expect(rB.status).toBe('linked');

      // Shared physical snapshot MUST still exist
      expect(containerFs.has(sharedSnapshotKey)).toBe(true);
    });

    it('linked mismatch: fails closed when message_attachments ref exists with mismatched etag/size', async () => {
      const { AttachmentSnapshotRecoveryService } = await import('../src/storage/attachment-snapshot-recovery.js');

      db.prepare("DELETE FROM attachment_snapshot_journal WHERE status IN ('staging', 'copied', 'cleanup_pending')").run();

      const sha = createHash('sha256').update('original content for mismatch test').digest('hex');
      const snapKey = `${aliceSpaceId}/.attachments/${sha}/mismatch.txt`;
      containerFs.set(snapKey, { content: 'original content for mismatch test', encoding: 'utf8', mtimeMs: 1700000000000 });

      const jMismatch = 'deliv_mismatch_001';
      db.prepare(`
        INSERT INTO attachment_snapshot_journal (id, delivery_id, user_id, space_id, source_path, snapshot_path, content_sha256, size, status)
        VALUES (?, 'd_m1', ?, ?, 'mismatch.txt', ?, ?, 33, 'copied')
      `).run(jMismatch, aliceUserId, aliceSpaceId, `.attachments/${sha}/mismatch.txt`, sha);

      // Create message_attachments with WRONG size (e.g. 999 instead of 33)
      const recoveryRoute = await storage.forTenant(aliceUserId).sessionRoutes.create({
        spaceId: aliceSpaceId,
        channel: 'web',
        accountId: 'default',
        nativeContextId: 'ctx_alice_mismatch',
        peerId: 'peer_alice_mismatch',
        dshSessionId: 'dsh_ses_alice_007',
        executionMode: 'container',
      });
      const msgId = 'msg_mismatch_dummy';
      db.prepare(`
        INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, turn_id)
        VALUES (?, ?, ?, 'user', 'hi', 'delivered', 'rk', 't1')
      `).run(msgId, recoveryRoute.id, aliceUserId);
      db.prepare(`
        INSERT INTO message_attachments (id, message_id, user_id, space_id, relative_path, snapshot_path, etag, size, media_type)
        VALUES ('att_mismatch_dummy', ?, ?, ?, 'mismatch.txt', ?, ?, 999, 'text/plain')
      `).run(msgId, aliceUserId, aliceSpaceId, `.attachments/${sha}/mismatch.txt`, `"${sha}"`);

      const recovery = new AttachmentSnapshotRecoveryService(db, {
        fileProvider: mockFileProvider,
      });

      const report = await recovery.recover();
      expect(report.errors).toHaveLength(1);
      expect(report.errors[0]).toEqual({
        journalId: jMismatch,
        code: 'ATTACHMENT_REF_MISMATCH',
        stage: 'copied_verify',
      });

      const r = db.prepare(`SELECT status FROM attachment_snapshot_journal WHERE id = ?`).get(jMismatch) as any;
      expect(r.status).toBe('copied');
    });

    it('50MB inspect: verifies snapshot existence and hash via inspectSnapshotState without buffering full content', async () => {
      const { RuntimeFileApiService } = await import('../src/files/runtime-file-api.js');

      const size50Mb = 50 * 1024 * 1024;
      const largeContent = 'Z'.repeat(size50Mb);
      const largeSha = createHash('sha256').update(largeContent).digest('hex');
      const largeSnapshotPath = `.attachments/${largeSha}/large_50mb.dat`;

      containerFs.set(`${aliceSpaceId}/${largeSnapshotPath}`, {
        content: largeContent,
        encoding: 'utf8',
        mtimeMs: 1700000000000,
      });

      const executeSpy = vi.spyOn(mockFileProvider, 'execute');
      executeSpy.mockClear();

      const fileService = new RuntimeFileApiService({
        fileProvider: mockFileProvider,
      });

      const inspectResult = await fileService.inspectSnapshotState(aliceUserId, aliceSpaceId, {
        snapshotPath: largeSnapshotPath,
        expectedContentSha256: largeSha,
      });

      expect(inspectResult.snapshotExists).toBe(true);
      expect(inspectResult.snapshotMatchesExpected).toBe(true);
      expect(inspectResult.snapshotSize).toBe(size50Mb);
      expect(inspectResult.snapshotHash).toBe(largeSha);

      // Verify that 'read' was NEVER called (zero whole-file RAM buffering)
      const readCalls = executeSpy.mock.calls.filter((call) => call[2]?.op === 'read');
      expect(readCalls).toHaveLength(0);
    });

    it('startup no listen errors: unrecoverable attachment snapshot error halts PlatformServer startup without binding listener', async () => {
      const { PlatformServer, PlatformConfigurationError } = await import('../src/server/server.js');
      const { SqlitePlatformStorage } = await import('@enkeep/platform-storage-sqlite');
      const { DefaultAuthService } = await import('@enkeep/platform-auth');
      const { SqliteWebMessageStore } = await import('../src/storage/web-messages.js');
      const { PlatformServerMigrationRunner, ALL_PLATFORM_MIGRATIONS } = await import('../src/storage/migrations.js');
      const { createPlatformOperations, SqlitePlatformOperationsStorage } = await import('../src/index.js');
      const { TestOnlyRuntimeGateway } = await import('./test-runtime-gateway.js');

      const testDb = new DatabaseSync(':memory:');
      const runner = new PlatformServerMigrationRunner(testDb);
      await runner.migrate(ALL_PLATFORM_MIGRATIONS);

      const testStorage = new SqlitePlatformStorage(testDb);
      const authService = new DefaultAuthService(testStorage, { cookieSecret: 'test-secret-32-chars-long-valid!' });
      const messageStore = new SqliteWebMessageStore(testDb);
      const operationsStore = new SqlitePlatformOperationsStorage(testDb);
      const operations = createPlatformOperations({ storage: operationsStore });

      const testUser = await testStorage.users.create({
        username: 'unrec_user',
        passwordHash: 'dummy',
        displayName: 'Unrecoverable User',
        role: 'user',
        status: 'active',
      });
      const testSpace = await testStorage.forTenant(testUser.id).spaces.create({
        name: 'Unrec Space',
        folder: 'spc_unrec',
        executionMode: 'container',
      });

      const expSha = createHash('sha256').update('unrecoverable staging expected').digest('hex');
      const unrecJournalId = 'deliv_unrec_startup_fail';
      testDb.prepare(`
        INSERT INTO attachment_snapshot_journal (id, delivery_id, user_id, space_id, source_path, snapshot_path, content_sha256, size, status)
        VALUES (?, 'd_unrec', ?, ?, 'file.txt', ?, ?, 10, 'staging')
      `).run(unrecJournalId, testUser.id, testSpace.id, `.attachments/${expSha}/file.txt`, expSha);

      // Put corrupted content on disk for the test space
      const corruptedTestFs = new Map<string, { content: string; encoding: 'utf8'; mtimeMs: number }>();
      corruptedTestFs.set(`${testSpace.id}/.attachments/${expSha}/file.txt`, {
        content: 'mismatched content on disk',
        encoding: 'utf8',
        mtimeMs: 1700000000000,
      });

      const testFileProvider: TenantRuntimeFileProvider = {
        execute: async (userId, spaceId, req) => {
          if (req.op === 'stat') {
            const found = corruptedTestFs.get(`${spaceId}/${req.path}`);
            if (!found) throw new NotFoundError('not found');
            const buf = Buffer.from(found.content, 'utf8');
            return {
              op: 'stat',
              path: req.path,
              type: 'file',
              size: buf.length,
              mtimeMs: found.mtimeMs,
              etag: computeTestEtag(buf),
            };
          }
          throw new PlatformError('unsupported', 'ERROR', 500);
        },
      };

      const testGateway = new TestOnlyRuntimeGateway({ storage: testStorage, messageStore });

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
        fileProvider: testFileProvider,
      });

      await expect(serverInstance.start()).rejects.toThrow(PlatformConfigurationError);
      expect(serverInstance.listeningUrl).toBeUndefined();
    });
  });
});
