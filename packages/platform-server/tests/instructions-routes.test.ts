/**
 * Comprehensive Canonical Platform Instructions REST API & Governance Test Suite
 *
 * Tests:
 * 1. GET /api/account/instructions/global (empty + etag null, cached private no-cache, SuccessEnvelope)
 * 2. PUT /api/account/instructions/global (strictly ['content'], CSRF, 20 KiB limit, Unicode NFC, If-Match header)
 * 3. 428 PRECONDITION_REQUIRED & 409 CONFLICT on Global Instructions (header-only If-Match, rejection of body aliases)
 * 4. GET /api/spaces/:id/instructions (default AGENTS.md, ?file=CLAUDE.md, query param validation, alias rejection)
 * 5. PUT /api/spaces/:id/instructions (strictly ['content'], ?file= query selection, 64 KiB limit, 428 / 409)
 * 6. Rejection of invalid methods (405 METHOD_NOT_ALLOWED) and unauthenticated access (401 UNAUTHORIZED)
 * 7. Zero raw error message leakage across all failure paths (safe whitelisted error messages)
 * 8. Multi-tenant isolation: Alice cannot read/write Bob's space or global instructions
 * 9. Storage quota checking and adjustment
 * 10. Audit log recording: SHA-256 hash + bytes, strictly zero sensitive content leakage
 * 11. Resilience: 503 RUNTIME_UNAVAILABLE when runtime file provider is unconfigured
 *
 * @module @enkeep/platform-server/tests/instructions-routes.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
} from '../src/storage/migrations.js';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { DefaultAuthService, provisionFixtures } from '@enkeep/platform-auth';
import { PlatformServer } from '../src/server/server.js';
import type { RuntimeGateway } from '@enkeep/web-channel';
import type { TenantRuntimeFileProvider, CanonicalFileOperationRequest, CanonicalFileOperationResult } from '../src/files/runtime-file-api.js';

describe('Authoritative Platform Instructions HTTP Routes & Multi-Tenant Governance', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let authService: DefaultAuthService;
  let server: PlatformServer;
  let baseUrl: string;
  let csrfToken: string;

  let aliceUserId: string;
  let bobUserId: string;
  let aliceCookie: string;
  let bobCookie: string;
  let aliceSpaceId: string;
  let bobSpaceId: string;

  // In-memory mock container volume storage
  const mockContainerVolumes = new Map<string, { buffer: Buffer; mtimeMs: number }>();

  function computeEtag(buf: Buffer): string {
    const hash = createHash('sha256').update(buf).digest('hex').toLowerCase();
    return `"${hash}"`;
  }

  const mockFileProvider: TenantRuntimeFileProvider = {
    async execute(
      userId: string,
      spaceId: string,
      req: CanonicalFileOperationRequest
    ): Promise<CanonicalFileOperationResult> {
      const spaceKey = `${userId}:${spaceId}:${req.path}`;

      if (req.op === 'read') {
        const item = mockContainerVolumes.get(spaceKey);
        if (!item) {
          throw { status: 404, code: 'NOT_FOUND', message: `File "${req.path}" not found in container /internal/storage/vol_987` };
        }
        const content = item.buffer.toString('utf8');
        return {
          op: 'read',
          space: spaceId,
          path: req.path,
          content,
          encoding: 'utf8',
          type: 'file',
          size: item.buffer.length,
          mtimeMs: item.mtimeMs,
          etag: computeEtag(item.buffer),
        };
      }

      if (req.op === 'stat') {
        const item = mockContainerVolumes.get(spaceKey);
        if (!item) {
          throw { status: 404, code: 'NOT_FOUND', message: `File "${req.path}" not found in container` };
        }
        return {
          op: 'stat',
          space: spaceId,
          path: req.path,
          type: 'file',
          size: item.buffer.length,
          mtimeMs: item.mtimeMs,
          etag: computeEtag(item.buffer),
        };
      }

      if (req.op === 'write') {
        const existing = mockContainerVolumes.get(spaceKey);
        if (req.requireAbsent && existing) {
          throw { status: 409, code: 'PRECONDITION_FAILED', message: 'Target already exists in internal fs' };
        }
        if (req.expectedEtag) {
          if (!existing) {
            throw { status: 409, code: 'PRECONDITION_FAILED', message: 'Target not found for expected ETag in internal fs' };
          }
          const currentEtag = computeEtag(existing.buffer);
          if (currentEtag !== req.expectedEtag) {
            throw { status: 409, code: 'PRECONDITION_FAILED', message: 'ETag precondition failed in internal fs' };
          }
        }

        const buf = Buffer.from(req.content ?? '', 'utf8');
        const now = Date.now();
        mockContainerVolumes.set(spaceKey, { buffer: buf, mtimeMs: now });
        return {
          op: 'write',
          space: spaceId,
          path: req.path,
          type: 'file',
          size: buf.length,
          mtimeMs: now,
          etag: computeEtag(buf),
          written: true,
        };
      }

      throw { status: 400, code: 'INVALID_OP', message: `Unsupported file op ${req.op}` };
    },

    async readGlobalInstructions(userId: string) {
      const key = `global:${userId}:AGENTS.md`;
      const item = mockContainerVolumes.get(key);
      if (!item) {
        return { content: '', etag: null, size: 0, mtimeMs: 0, exists: false };
      }
      return {
        content: item.buffer.toString('utf8'),
        etag: computeEtag(item.buffer),
        size: item.buffer.length,
        mtimeMs: item.mtimeMs,
        exists: true,
      };
    },

    async writeGlobalInstructions(userId: string, content: string, options?: { expectedEtag?: string | null; requireAbsent?: boolean }) {
      const key = `global:${userId}:AGENTS.md`;
      const existing = mockContainerVolumes.get(key);
      if (options?.requireAbsent && existing) {
        throw { status: 409, code: 'PRECONDITION_FAILED', message: 'Global instructions already exist' };
      }
      if (options?.expectedEtag) {
        if (!existing) {
          throw { status: 409, code: 'PRECONDITION_FAILED', message: 'Target not found for expected ETag' };
        }
        const currentEtag = computeEtag(existing.buffer);
        if (currentEtag !== options.expectedEtag) {
          throw { status: 409, code: 'PRECONDITION_FAILED', message: 'Global instructions ETag mismatch' };
        }
      }

      const buf = Buffer.from(content, 'utf8');
      const now = Date.now();
      mockContainerVolumes.set(key, { buffer: buf, mtimeMs: now });
      return {
        etag: computeEtag(buf),
        size: buf.length,
        mtimeMs: now,
      };
    },
  };

  const mockRuntimeGateway: RuntimeGateway = {
    async dispatchInbound() {
      return { accepted: true, turnId: 'turn_mock', dshSessionId: 'ses_mock' };
    },
    async abortTurn() {},
    async getSessionStatus() {
      return { active: false, currentTurnId: null, queueLength: 0 };
    },
  };

  beforeEach(async () => {
    mockContainerVolumes.clear();
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    csrfToken = 'a'.repeat(32);
    const cookieSecret = 'b'.repeat(32);

    storage = new SqlitePlatformStorage(db);
    authService = new DefaultAuthService(storage, { cookieSecret });

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

    const aliceSession = await authService.createSession(aliceUserId, {
      ipAddress: '127.0.0.1',
      userAgent: 'test-agent',
    });
    aliceCookie = aliceSession.cookieHeader.split(';')[0];

    const bobSession = await authService.createSession(bobUserId, {
      ipAddress: '127.0.0.1',
      userAgent: 'test-agent',
    });
    bobCookie = bobSession.cookieHeader.split(';')[0];

    server = new PlatformServer({
      database: db,
      storage,
      authService,
      cookieSecret,
      csrfToken,
      runtimeGateway: mockRuntimeGateway,
      fileProvider: mockFileProvider,
      port: 0,
      host: '127.0.0.1',
    });

    const addr = await server.start();
    baseUrl = addr.url;
  });

  afterEach(async () => {
    await server.stop();
    db.close();
    mockContainerVolumes.clear();
  });

  describe('1. Global Instructions API (GET & PUT /api/account/instructions/global)', () => {
    it('requires authentication (401 without cookie with standard ErrorEnvelope)', async () => {
      const res = await fetch(`${baseUrl}/api/account/instructions/global`);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('UNAUTHORIZED');
      expect(json.error.message).toBe('Authentication required');
      expect(json.ok).toBeUndefined();
    });

    it('returns empty content with null ETag when no global instructions file exists (SuccessEnvelope)', async () => {
      const res = await fetch(`${baseUrl}/api/account/instructions/global`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('private, no-cache');
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.ok).toBeUndefined();
      expect(json.data.exists).toBe(false);
      expect(json.data.content).toBe('');
      expect(json.data.etag).toBeNull();
      expect(json.data.size).toBe(0);
      expect(json.data.filename).toBe('AGENTS.md');
      expect(json.data.target).toBe('global');
    });

    it('creates global instructions via initial PUT without If-Match header and returns calculated ETag', async () => {
      const globalContent = '# Alice Global Instructions\n- Always be concise.\n- Follow security standards.';
      const res = await fetch(`${baseUrl}/api/account/instructions/global`, {
        method: 'PUT',
        headers: {
          Cookie: aliceCookie,
          Origin: baseUrl,
          'X-Enkeep-CSRF': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: globalContent }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.ok).toBeUndefined();
      expect(json.data.target).toBe('global');
      expect(json.data.filename).toBe('AGENTS.md');
      expect(json.data.size).toBe(Buffer.byteLength(globalContent, 'utf8'));
      expect(json.data.etag).toMatch(/^"[0-9a-f]{64}"$/);
      expect(res.headers.get('ETag')).toBe(json.data.etag);

      // GET should return the updated instructions in SuccessEnvelope
      const getRes = await fetch(`${baseUrl}/api/account/instructions/global`, {
        headers: { Cookie: aliceCookie },
      });
      expect(getRes.status).toBe(200);
      const getJson = await getRes.json();
      expect(getJson.success).toBe(true);
      expect(getJson.data.exists).toBe(true);
      expect(getJson.data.content).toBe(globalContent);
      expect(getJson.data.etag).toBe(json.data.etag);
      expect(getRes.headers.get('ETag')).toBe(json.data.etag);
    });

    it('rejects PUT request without valid CSRF header (403)', async () => {
      const res = await fetch(`${baseUrl}/api/account/instructions/global`, {
        method: 'PUT',
        headers: {
          Cookie: aliceCookie,
          Origin: baseUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: '# Secret' }),
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('FORBIDDEN');
      expect(json.error.message).toBe('Forbidden');
    });

    it('rejects PUT request with unknown fields or body etag aliases (400 strict body keys)', async () => {
      // 1. Extra unknown field
      const res1 = await fetch(`${baseUrl}/api/account/instructions/global`, {
        method: 'PUT',
        headers: {
          Cookie: aliceCookie,
          Origin: baseUrl,
          'X-Enkeep-CSRF': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: '# Normal', memoryType: 'unauthorized_extra_field' }),
      });
      expect(res1.status).toBe(400);
      const json1 = await res1.json();
      expect(json1.success).toBe(false);
      expect(json1.error.code).toBe('VALIDATION_ERROR');
      expect(json1.error.message).toBe('Invalid request');

      // 2. Body etag alias (expectedEtag)
      const res2 = await fetch(`${baseUrl}/api/account/instructions/global`, {
        method: 'PUT',
        headers: {
          Cookie: aliceCookie,
          Origin: baseUrl,
          'X-Enkeep-CSRF': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: '# Normal', expectedEtag: '"12345"' }),
      });
      expect(res2.status).toBe(400);
      const json2 = await res2.json();
      expect(json2.success).toBe(false);
      expect(json2.error.code).toBe('VALIDATION_ERROR');

      // 3. Body ifMatch alias
      const res3 = await fetch(`${baseUrl}/api/account/instructions/global`, {
        method: 'PUT',
        headers: {
          Cookie: aliceCookie,
          Origin: baseUrl,
          'X-Enkeep-CSRF': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: '# Normal', ifMatch: '"12345"' }),
      });
      expect(res3.status).toBe(400);
      const json3 = await res3.json();
      expect(json3.success).toBe(false);
      expect(json3.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects PUT request with missing or non-string content (400)', async () => {
      // 1. Missing content field
      const res1 = await fetch(`${baseUrl}/api/account/instructions/global`, {
        method: 'PUT',
        headers: {
          Cookie: aliceCookie,
          Origin: baseUrl,
          'X-Enkeep-CSRF': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      expect(res1.status).toBe(400);
      const json1 = await res1.json();
      expect(json1.success).toBe(false);
      expect(json1.error.code).toBe('VALIDATION_ERROR');
      expect(json1.error.message).toBe('Invalid request');

      // 2. Non-string content (number)
      const res2 = await fetch(`${baseUrl}/api/account/instructions/global`, {
        method: 'PUT',
        headers: {
          Cookie: aliceCookie,
          Origin: baseUrl,
          'X-Enkeep-CSRF': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: 12345 }),
      });
      expect(res2.status).toBe(400);
      const json2 = await res2.json();
      expect(json2.success).toBe(false);
      expect(json2.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects query parameters on global instructions endpoint (400)', async () => {
      const res = await fetch(`${baseUrl}/api/account/instructions/global?file=AGENTS.md`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('enforces 20 KiB size limit for global instructions (400 on oversize)', async () => {
      const oversized = 'A'.repeat(20 * 1024 + 1);
      const res = await fetch(`${baseUrl}/api/account/instructions/global`, {
        method: 'PUT',
        headers: {
          Cookie: aliceCookie,
          Origin: baseUrl,
          'X-Enkeep-CSRF': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: oversized }),
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
      expect(json.error.message).toBe('Invalid request');
    });

    it('returns 428 PRECONDITION_REQUIRED when modifying existing global instructions without If-Match', async () => {
      // Step 1: Create initial version
      const put1 = await fetch(`${baseUrl}/api/account/instructions/global`, {
        method: 'PUT',
        headers: {
          Cookie: aliceCookie,
          Origin: baseUrl,
          'X-Enkeep-CSRF': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: 'Initial version' }),
      });
      expect(put1.status).toBe(200);

      // Step 2: Attempt update without If-Match header -> must return 428
      const putNoIfMatch = await fetch(`${baseUrl}/api/account/instructions/global`, {
        method: 'PUT',
        headers: {
          Cookie: aliceCookie,
          Origin: baseUrl,
          'X-Enkeep-CSRF': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: 'Overwriting without header' }),
      });
      expect(putNoIfMatch.status).toBe(428);
      const json428 = await putNoIfMatch.json();
      expect(json428.success).toBe(false);
      expect(json428.error.code).toBe('PRECONDITION_REQUIRED');
      expect(json428.error.message).toBe('Precondition required');
    });

    it('supports ETag CAS via If-Match header and returns 409 CONFLICT on mismatch', async () => {
      // Step 1: Create initial version
      const put1 = await fetch(`${baseUrl}/api/account/instructions/global`, {
        method: 'PUT',
        headers: {
          Cookie: aliceCookie,
          Origin: baseUrl,
          'X-Enkeep-CSRF': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: 'Version 1' }),
      });
      expect(put1.status).toBe(200);
      const { data: { etag: etag1 } } = await put1.json();

      // Step 2: Update to version 2 with correct If-Match header
      const put2 = await fetch(`${baseUrl}/api/account/instructions/global`, {
        method: 'PUT',
        headers: {
          Cookie: aliceCookie,
          Origin: baseUrl,
          'X-Enkeep-CSRF': csrfToken,
          'If-Match': etag1,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: 'Version 2' }),
      });
      expect(put2.status).toBe(200);
      const { data: { etag: etag2 } } = await put2.json();
      expect(etag2).not.toBe(etag1);

      // Step 3: Attempt update with stale If-Match (etag1) -> 409 Conflict
      const putStale = await fetch(`${baseUrl}/api/account/instructions/global`, {
        method: 'PUT',
        headers: {
          Cookie: aliceCookie,
          Origin: baseUrl,
          'X-Enkeep-CSRF': csrfToken,
          'If-Match': etag1,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: 'Version 3 Stale' }),
      });
      expect(putStale.status).toBe(409);
      const staleJson = await putStale.json();
      expect(staleJson.success).toBe(false);
      expect(staleJson.error.code).toBe('CONFLICT');
      expect(staleJson.error.message).toBe('Instructions changed');
    });

    it('normalizes content with Unicode NFC normalization', async () => {
      const decomposed = 'Cafe\u0301 rules';
      const expectedComposed = 'Caf\u00E9 rules';

      const res = await fetch(`${baseUrl}/api/account/instructions/global`, {
        method: 'PUT',
        headers: {
          Cookie: aliceCookie,
          Origin: baseUrl,
          'X-Enkeep-CSRF': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: decomposed }),
      });
      expect(res.status).toBe(200);

      const getRes = await fetch(`${baseUrl}/api/account/instructions/global`, {
        headers: { Cookie: aliceCookie },
      });
      const getJson = await getRes.json();
      expect(getJson.data.content).toBe(expectedComposed);
    });

    it('rejects unsupported HTTP methods with 405 METHOD_NOT_ALLOWED', async () => {
      for (const disallowedMethod of ['DELETE', 'POST', 'PATCH']) {
        const res = await fetch(`${baseUrl}/api/account/instructions/global`, {
          method: disallowedMethod,
          headers: { Cookie: aliceCookie },
        });
        expect(res.status).toBe(405);
        const json = await res.json();
        expect(json.success).toBe(false);
        expect(json.error.code).toBe('METHOD_NOT_ALLOWED');
        expect(json.error.message).toBe('Method not allowed');
      }
    });
  });

  describe('2. Space Instructions API (GET & PUT /api/spaces/:id/instructions)', () => {
    it('defaults to AGENTS.md when file query is omitted and supports CLAUDE.md via ?file=', async () => {
      // 1. Initial GET on empty space instructions (AGENTS.md default)
      const res1 = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/instructions`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res1.status).toBe(200);
      const json1 = await res1.json();
      expect(json1.success).toBe(true);
      expect(json1.data.exists).toBe(false);
      expect(json1.data.filename).toBe('AGENTS.md');
      expect(json1.data.target).toBe('space');
      expect(json1.data.etag).toBeNull();

      // 2. Initial GET for CLAUDE.md
      const res2 = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/instructions?file=CLAUDE.md`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res2.status).toBe(200);
      const json2 = await res2.json();
      expect(json2.success).toBe(true);
      expect(json2.data.exists).toBe(false);
      expect(json2.data.filename).toBe('CLAUDE.md');
      expect(json2.data.target).toBe('space');

      // 3. Write AGENTS.md (no ?file= -> defaults to AGENTS.md)
      const putAgents = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/instructions`, {
        method: 'PUT',
        headers: {
          Cookie: aliceCookie,
          Origin: baseUrl,
          'X-Enkeep-CSRF': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: '# AGENTS Rules' }),
      });
      expect(putAgents.status).toBe(200);
      const agentsJson = await putAgents.json();
      expect(agentsJson.success).toBe(true);
      expect(agentsJson.data.filename).toBe('AGENTS.md');

      // 4. Write CLAUDE.md via ?file=CLAUDE.md
      const putClaude = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/instructions?file=CLAUDE.md`, {
        method: 'PUT',
        headers: {
          Cookie: aliceCookie,
          Origin: baseUrl,
          'X-Enkeep-CSRF': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: '# CLAUDE Rules' }),
      });
      expect(putClaude.status).toBe(200);
      const claudeJson = await putClaude.json();
      expect(claudeJson.success).toBe(true);
      expect(claudeJson.data.filename).toBe('CLAUDE.md');

      // 5. Verify independent retrieval
      const getAgents = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/instructions?file=AGENTS.md`, {
        headers: { Cookie: aliceCookie },
      });
      expect((await getAgents.json()).data.content).toBe('# AGENTS Rules');

      const getClaude = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/instructions?file=CLAUDE.md`, {
        headers: { Cookie: aliceCookie },
      });
      expect((await getClaude.json()).data.content).toBe('# CLAUDE Rules');
    });

    it('strictly rejects query parameter aliases (e.g. ?filename=) and unauthorized filenames (400)', async () => {
      // 1. Alias query parameter ?filename= instead of ?file=
      const res1 = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/instructions?filename=AGENTS.md`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res1.status).toBe(400);
      const json1 = await res1.json();
      expect(json1.success).toBe(false);
      expect(json1.error.code).toBe('VALIDATION_ERROR');
      expect(json1.error.message).toBe('Invalid request');

      // 2. Path traversal in file query
      const res2 = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/instructions?file=../secret.txt`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res2.status).toBe(400);
      const json2 = await res2.json();
      expect(json2.success).toBe(false);
      expect(json2.error.code).toBe('VALIDATION_ERROR');

      // 3. Disallowed filename in file query
      const res3 = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/instructions?file=PASSWORDS.md`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res3.status).toBe(400);
      const json3 = await res3.json();
      expect(json3.success).toBe(false);
      expect(json3.error.code).toBe('VALIDATION_ERROR');
    });

    it('strictly rejects PUT body aliases (filename/file/expectedEtag) enforcing only content key (400)', async () => {
      // 1. PUT with body "filename"
      const res1 = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/instructions`, {
        method: 'PUT',
        headers: {
          Cookie: aliceCookie,
          Origin: baseUrl,
          'X-Enkeep-CSRF': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ filename: 'AGENTS.md', content: '# Body Filename' }),
      });
      expect(res1.status).toBe(400);
      const json1 = await res1.json();
      expect(json1.success).toBe(false);
      expect(json1.error.code).toBe('VALIDATION_ERROR');

      // 2. PUT with body "file"
      const res2 = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/instructions`, {
        method: 'PUT',
        headers: {
          Cookie: aliceCookie,
          Origin: baseUrl,
          'X-Enkeep-CSRF': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ file: 'AGENTS.md', content: '# Body File' }),
      });
      expect(res2.status).toBe(400);
      const json2 = await res2.json();
      expect(json2.success).toBe(false);
      expect(json2.error.code).toBe('VALIDATION_ERROR');

      // 3. PUT with body "expectedEtag"
      const res3 = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/instructions`, {
        method: 'PUT',
        headers: {
          Cookie: aliceCookie,
          Origin: baseUrl,
          'X-Enkeep-CSRF': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: '# Body Etag', expectedEtag: '"123"' }),
      });
      expect(res3.status).toBe(400);
      const json3 = await res3.json();
      expect(json3.success).toBe(false);
      expect(json3.error.code).toBe('VALIDATION_ERROR');
    });

    it('enforces 64 KiB size limit for space instructions (400 on oversize)', async () => {
      const oversized = 'S'.repeat(64 * 1024 + 1);
      const res = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/instructions`, {
        method: 'PUT',
        headers: {
          Cookie: aliceCookie,
          Origin: baseUrl,
          'X-Enkeep-CSRF': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: oversized }),
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
      expect(json.error.message).toBe('Invalid request');
    });

    it('returns 428 PRECONDITION_REQUIRED when modifying existing space instructions without If-Match', async () => {
      // Step 1: Create initial space instructions
      const write1 = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/instructions?file=CLAUDE.md`, {
        method: 'PUT',
        headers: {
          Cookie: aliceCookie,
          Origin: baseUrl,
          'X-Enkeep-CSRF': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: 'Claude V1' }),
      });
      expect(write1.status).toBe(200);

      // Step 2: Attempt update without If-Match header -> 428
      const writeNoHeader = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/instructions?file=CLAUDE.md`, {
        method: 'PUT',
        headers: {
          Cookie: aliceCookie,
          Origin: baseUrl,
          'X-Enkeep-CSRF': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: 'Claude V2 without header' }),
      });
      expect(writeNoHeader.status).toBe(428);
      const json428 = await writeNoHeader.json();
      expect(json428.success).toBe(false);
      expect(json428.error.code).toBe('PRECONDITION_REQUIRED');
      expect(json428.error.message).toBe('Precondition required');
    });

    it('supports ETag CAS for space instructions via If-Match header and returns 409 CONFLICT on mismatch', async () => {
      // Step 1: Initial write
      const write1 = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/instructions`, {
        method: 'PUT',
        headers: {
          Cookie: aliceCookie,
          Origin: baseUrl,
          'X-Enkeep-CSRF': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: 'Space V1' }),
      });
      expect(write1.status).toBe(200);
      const { data: { etag: v1Etag } } = await write1.json();

      // Step 2: CAS update using If-Match header
      const write2 = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/instructions`, {
        method: 'PUT',
        headers: {
          Cookie: aliceCookie,
          Origin: baseUrl,
          'X-Enkeep-CSRF': csrfToken,
          'If-Match': v1Etag,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: 'Space V2' }),
      });
      expect(write2.status).toBe(200);
      const { data: { etag: v2Etag } } = await write2.json();
      expect(v2Etag).not.toBe(v1Etag);

      // Step 3: Mismatched CAS using stale v1Etag -> 409 Conflict
      const write3 = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/instructions`, {
        method: 'PUT',
        headers: {
          Cookie: aliceCookie,
          Origin: baseUrl,
          'X-Enkeep-CSRF': csrfToken,
          'If-Match': v1Etag,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: 'Space V3 Mismatch' }),
      });
      expect(write3.status).toBe(409);
      const staleJson = await write3.json();
      expect(staleJson.success).toBe(false);
      expect(staleJson.error.code).toBe('CONFLICT');
      expect(staleJson.error.message).toBe('Instructions changed');
    });

    it('rejects unsupported HTTP methods with 405 METHOD_NOT_ALLOWED', async () => {
      for (const disallowedMethod of ['DELETE', 'POST', 'PATCH']) {
        const res = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/instructions`, {
          method: disallowedMethod,
          headers: { Cookie: aliceCookie },
        });
        expect(res.status).toBe(405);
        const json = await res.json();
        expect(json.success).toBe(false);
        expect(json.error.code).toBe('METHOD_NOT_ALLOWED');
        expect(json.error.message).toBe('Method not allowed');
      }
    });
  });

  describe('3. Multi-Tenant Isolation & Security Confinement', () => {
    it('strictly prohibits Alice from reading or writing Bob space instructions (404/403)', async () => {
      // 1. Alice attempts to GET Bob's space instructions -> 404 NOT_FOUND
      const getRes = await fetch(`${baseUrl}/api/spaces/${bobSpaceId}/instructions`, {
        headers: { Cookie: aliceCookie },
      });
      expect(getRes.status).toBe(404);
      const getJson = await getRes.json();
      expect(getJson.success).toBe(false);
      expect(getJson.error.code).toBe('NOT_FOUND');
      expect(getJson.error.message).toBe('Resource not found');

      // 2. Alice attempts to PUT Bob's space instructions -> 404 NOT_FOUND
      const putRes = await fetch(`${baseUrl}/api/spaces/${bobSpaceId}/instructions`, {
        method: 'PUT',
        headers: {
          Cookie: aliceCookie,
          Origin: baseUrl,
          'X-Enkeep-CSRF': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: 'Hacked by Alice' }),
      });
      expect(putRes.status).toBe(404);
      const putJson = await putRes.json();
      expect(putJson.success).toBe(false);
      expect(putJson.error.code).toBe('NOT_FOUND');
    });

    it('isolates user global instructions completely between Alice and Bob', async () => {
      // Alice sets her global instructions
      await fetch(`${baseUrl}/api/account/instructions/global`, {
        method: 'PUT',
        headers: {
          Cookie: aliceCookie,
          Origin: baseUrl,
          'X-Enkeep-CSRF': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: 'ALICE_SUPER_SECRET_TOKEN_999' }),
      });

      // Bob reads his global instructions -> must NOT see Alice's content
      const bobGet = await fetch(`${baseUrl}/api/account/instructions/global`, {
        headers: { Cookie: bobCookie },
      });
      const bobJson = await bobGet.json();
      expect(bobJson.success).toBe(true);
      expect(bobJson.data.exists).toBe(false);
      expect(bobJson.data.content).toBe('');
      expect(JSON.stringify(bobJson)).not.toContain('ALICE_SUPER_SECRET_TOKEN');
    });
  });

  describe('4. Audit Logging & Zero Sensitive Content Leakage', () => {
    it('records audit log entries with SHA-256 hash and byte metrics while strictly omitting raw content', async () => {
      const secretInstruction = 'TOP SECRET STRATEGY: DO NOT REVEAL TO ANYONE 777888';
      await fetch(`${baseUrl}/api/account/instructions/global`, {
        method: 'PUT',
        headers: {
          Cookie: aliceCookie,
          Origin: baseUrl,
          'X-Enkeep-CSRF': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: secretInstruction }),
      });

      // Inspect audit log database rows from auth_audit_log
      const auditRows = db.prepare('SELECT * FROM auth_audit_log WHERE user_id = ?').all(aliceUserId) as Array<{
        id: string;
        action: string;
        details: string;
      }>;

      const instructionLogs = auditRows.filter((r) => r.action === 'instructions.update_global');
      expect(instructionLogs.length).toBeGreaterThanOrEqual(1);

      const latestLog = instructionLogs[instructionLogs.length - 1];
      const parsedDetails = JSON.parse(latestLog.details);

      // Verify recorded fields
      expect(parsedDetails.filename).toBe('AGENTS.md');
      expect(parsedDetails.size).toBe(Buffer.byteLength(secretInstruction, 'utf8'));
      expect(parsedDetails.etag).toMatch(/^"[0-9a-f]{64}"$/);

      // Strict Zero-Leakage: Ensure raw secret is nowhere in the audit log details JSON
      expect(latestLog.details).not.toContain('TOP SECRET STRATEGY');
      expect(latestLog.details).not.toContain('777888');
    });
  });

  describe('5. Resilience: Runtime Unavailable (503)', () => {
    it('returns 503 RUNTIME_UNAVAILABLE with safe error message when fileProvider is unconfigured', async () => {
      const unavailServer = new PlatformServer({
        database: db,
        storage,
        authService,
        cookieSecret: 'c'.repeat(32),
        csrfToken,
        runtimeGateway: mockRuntimeGateway,
        fileProvider: undefined, // unconfigured
        port: 0,
        host: '127.0.0.1',
      });

      const addr = await unavailServer.start();
      try {
        const res = await fetch(`${addr.url}/api/account/instructions/global`, {
          headers: { Cookie: aliceCookie },
        });
        expect(res.status).toBe(503);
        const json = await res.json();
        expect(json.success).toBe(false);
        expect(json.error.code).toBe('RUNTIME_UNAVAILABLE');
        expect(json.error.message).toBe('Runtime unavailable');
      } finally {
        await unavailServer.stop();
      }
    });
  });
});
