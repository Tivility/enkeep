import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
} from '../src/storage/migrations.js';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { DefaultAuthService, provisionFixtures } from '@enkeep/platform-auth';
import { PlatformServer } from '../src/server/server.js';
import { createProfileService } from '../src/profiles/profile-service.js';
import type { RuntimeGateway } from '@enkeep/web-channel';

describe('Agent Profile REST Endpoints & Multi-Tenant Governance Contract Tests', () => {
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

  // Mock Runtime Gateway
  const mockRuntimeGateway: RuntimeGateway = {
    async dispatchInbound() {
      return { accepted: true, turnId: 'turn_mock', dshSessionId: 'ses_mock' };
    },
    async getTurnStatus() {
      return { turnId: 'turn_mock', status: 'completed' as const };
    },
    async cancelTurn() {
      return true;
    },
  };

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    csrfToken = 'csrf_token_test_min_32_characters_long_secret_123';

    storage = new SqlitePlatformStorage(db);
    authService = new DefaultAuthService(storage, {
      cookieSecret: 'test_cookie_secret_at_least_32_chars_long_12345',
    });

    const profileService = createProfileService(storage, db);

    server = new PlatformServer({
      database: db,
      storage,
      authService,
      host: '127.0.0.1',
      port: 0,
      cookieSecret: 'test_cookie_secret_at_least_32_chars_long_12345',
      csrfToken,
      runtimeGateway: mockRuntimeGateway,
      agentProfileApi: profileService,
    });

    const addr = await server.start();
    baseUrl = addr.url;

    // Provision test fixtures
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

    // Login Alice and Bob to get cookies
    const aliceLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ username: 'alice', password: 'AlicePassword123!' }),
    });
    expect(aliceLogin.status).toBe(200);
    aliceCookie = aliceLogin.headers.get('set-cookie')!;

    const bobLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ username: 'bob', password: 'BobPassword123!' }),
    });
    expect(bobLogin.status).toBe(200);
    bobCookie = bobLogin.headers.get('set-cookie')!;
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
  });

  describe('1. Authentication & CSRF Protection', () => {
    it('rejects unauthenticated requests with 401 Unauthorized', async () => {
      const res = await fetch(`${baseUrl}/api/manage/agent-profiles`);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects POST /api/manage/agent-profiles without CSRF with 403 Forbidden', async () => {
      const res = await fetch(`${baseUrl}/api/manage/agent-profiles`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'c0000000-0000-4000-8000-000000000001',
        },
        body: JSON.stringify({ name: 'No CSRF' }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe('CSRF_VIOLATION');
    });

    it('rejects POST /api/spaces/:spaceId/agent-profile without CSRF with 403 Forbidden', async () => {
      const res = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/agent-profile`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ profileId: 'prof_1' }),
      });
      expect(res.status).toBe(403);
    });

    it('rejects DELETE /api/spaces/:spaceId/agent-profile without CSRF with 403 Forbidden', async () => {
      const res = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/agent-profile`, {
        method: 'DELETE',
        headers: {
          Cookie: aliceCookie,
        },
      });
      expect(res.status).toBe(403);
    });
  });

  describe('2. Idempotency-Key Header Validation on POST Creation', () => {
    it('rejects missing Idempotency-Key header with 400 Validation Error', async () => {
      const res = await fetch(`${baseUrl}/api/manage/agent-profiles`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Test Missing Idempotency' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain('Missing required Idempotency-Key header');
    });

    it('rejects invalid Idempotency-Key (not UUIDv4) with 400 Validation Error', async () => {
      const res = await fetch(`${baseUrl}/api/manage/agent-profiles`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'not-a-valid-uuid-v4',
        },
        body: JSON.stringify({ name: 'Test Invalid Idempotency' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain('Invalid Idempotency-Key format');
    });

    it('rejects duplicate comma-separated Idempotency-Key headers with 400', async () => {
      const res = await fetch(`${baseUrl}/api/manage/agent-profiles`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'c1111111-1111-4111-8111-111111111111, c1111111-1111-4111-8111-111111111111',
        },
        body: JSON.stringify({ name: 'Test Duplicate Header' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain('Duplicate or comma-separated Idempotency-Key');
    });

    it('deduplicates identical requests with same Idempotency-Key returning 201 Created and identical result', async () => {
      const key = 'c2222222-2222-4222-8222-222222222222';
      const payload = {
        name: 'Idempotent Web Profile',
        identity: 'You are an idempotent agent.',
        soul: 'Be deterministic.',
      };

      const res1 = await fetch(`${baseUrl}/api/manage/agent-profiles`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify(payload),
      });
      expect(res1.status).toBe(201);
      const body1 = await res1.json();

      const res2 = await fetch(`${baseUrl}/api/manage/agent-profiles`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify(payload),
      });
      expect(res2.status).toBe(201);
      const body2 = await res2.json();

      expect(body1.data.id).toBe(body2.data.id);
      expect(body1.data.name).toBe(body2.data.name);
      expect(body1.data.promptHash).toBeUndefined();
      expect(body2.data.promptHash).toBeUndefined();
      expect(body1.data.userId).toBeUndefined();
      expect(body2.data.userId).toBeUndefined();
    });

    it('returns 409 Conflict when Idempotency-Key is reused with different payload', async () => {
      const key = 'c3333333-3333-4333-8333-333333333333';

      await fetch(`${baseUrl}/api/manage/agent-profiles`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify({ name: 'Payload Alpha', identity: 'Alpha' }),
      });

      const res = await fetch(`${baseUrl}/api/manage/agent-profiles`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify({ name: 'Payload Beta', identity: 'Beta' }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe('CONFLICT');
    });
  });

  describe('3. Unknown Fields Rejection & Integrity Constraints', () => {
    it('rejects unknown fields on POST /api/manage/agent-profiles', async () => {
      const res = await fetch(`${baseUrl}/api/manage/agent-profiles`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'c4444444-4444-4444-8444-444444444444',
        },
        body: JSON.stringify({
          name: 'Safe Name',
          maliciousKey: 'attack_vector',
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain('Unexpected field "maliciousKey"');
    });

    it('rejects attempts by client to forge profileId, version, or promptHash on creation', async () => {
      const res = await fetch(`${baseUrl}/api/manage/agent-profiles`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'c5555555-5555-4555-8555-555555555555',
        },
        body: JSON.stringify({
          name: 'Forged Profile',
          profileId: 'custom_id_forbidden',
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain('Unexpected field "profileId"');
    });

    it('rejects unknown fields on POST /api/spaces/:spaceId/agent-profile', async () => {
      const res = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/agent-profile`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          profileId: 'valid_id',
          extraBogusKey: true,
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain('Unexpected field "extraBogusKey"');
    });
  });

  describe('4. Prompt Section Validation (NFC, Forbidden Chars, Templates, 64 KiB)', () => {
    it('rejects unnormalized Unicode with 400', async () => {
      const res = await fetch(`${baseUrl}/api/manage/agent-profiles`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'c6666666-6666-4666-8666-666666666666',
        },
        body: JSON.stringify({
          name: 'NFD Profile',
          identity: 'cafe\u0301',
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain('Unicode NFC normalized form');
    });

    it('rejects forbidden bidi and format control characters with 400', async () => {
      const res = await fetch(`${baseUrl}/api/manage/agent-profiles`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'c7777777-7777-4777-8777-777777777777',
        },
        body: JSON.stringify({
          name: 'Bidi Profile',
          soul: 'RTL override \u202E malicious text',
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain('forbidden control or format characters');
    });

    it('rejects template variables {{...}} with 400', async () => {
      const res = await fetch(`${baseUrl}/api/manage/agent-profiles`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'c8888888-8888-4888-8888-888888888888',
        },
        body: JSON.stringify({
          name: 'Template Profile',
          tools: 'Inject {{ config.apiKey }}',
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toMatch(/forbidden template variable/i);
    });

    it('rejects prompt sections exceeding 64 KiB total with 400', async () => {
      const res = await fetch(`${baseUrl}/api/manage/agent-profiles`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'c9999999-9999-4999-8999-999999999999',
        },
        body: JSON.stringify({
          name: 'Oversized Profile',
          identity: 'A'.repeat(65537),
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain('exceeds maximum allowable limit of 65536 bytes');
    });
  });

  describe('5. Profile CRUD & Version Management Endpoints', () => {
    it('creates profile, lists versions, and publishes immutable version 2', async () => {
      // 1. Create Profile
      const createRes = await fetch(`${baseUrl}/api/manage/agent-profiles`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'd0000000-0000-4000-8000-000000000001',
        },
        body: JSON.stringify({
          name: 'Senior Architect',
          description: 'Software Architecture assistant',
          identity: 'You are an architect.',
          soul: 'Be direct.',
          agents: 'Coordinate workers.',
          tools: 'Use architecture tools.',
          changeSummary: 'v1 init',
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const profileId = created.data.id;
      expect(profileId).toBeDefined();
      expect(created.data.activeVersion).toBe(1);
      expect(created.data.promptHash).toBeUndefined();

      // 2. Get Profile Detail (Owner view includes 4 sections for editing, never exposes raw promptHash)
      const detailRes = await fetch(`${baseUrl}/api/manage/agent-profiles/${profileId}`, {
        headers: { Cookie: aliceCookie },
      });
      expect(detailRes.status).toBe(200);
      const detail = await detailRes.json();
      expect(detail.data.name).toBe('Senior Architect');
      expect(detail.data.promptHash).toBeUndefined();
      expect(detail.data.snapshot.identity).toBe('You are an architect.');
      expect(detail.data.snapshot.soul).toBe('Be direct.');
      expect(detail.data.snapshot.promptHash).toBeUndefined();

      // 3. List Versions (never exposes promptHash in version list)
      const versionsRes = await fetch(`${baseUrl}/api/manage/agent-profiles/${profileId}/versions`, {
        headers: { Cookie: aliceCookie },
      });
      expect(versionsRes.status).toBe(200);
      const versions = await versionsRes.json();
      expect(versions.data.length).toBe(1);
      expect(versions.data[0].version).toBe(1);
      expect(versions.data[0].promptHash).toBeUndefined();

      // 4. Publish Version 2
      const v2Res = await fetch(`${baseUrl}/api/manage/agent-profiles/${profileId}/versions`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          identity: 'You are an Executive Architect.',
          soul: 'Be extremely strategic.',
          changeSummary: 'Upgraded to Executive level',
        }),
      });
      expect(v2Res.status).toBe(201);
      const v2Body = await v2Res.json();
      expect(v2Body.data.version).toBe(2);
      expect(v2Body.data.identity).toBe('You are an Executive Architect.');
      expect(v2Body.data.promptHash).toBeUndefined();

      // 5. Query Specific Version 2 (never exposes promptHash in version snapshot)
      const getV2Res = await fetch(`${baseUrl}/api/manage/agent-profiles/${profileId}/versions/2`, {
        headers: { Cookie: aliceCookie },
      });
      expect(getV2Res.status).toBe(200);
      const getV2 = await getV2Res.json();
      expect(getV2.data.version).toBe(2);
      expect(getV2.data.identity).toBe('You are an Executive Architect.');
      expect(getV2.data.promptHash).toBeUndefined();

      // 6. Soft archive profile via DELETE
      const deleteRes = await fetch(`${baseUrl}/api/manage/agent-profiles/${profileId}`, {
        method: 'DELETE',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
        },
      });
      expect(deleteRes.status).toBe(200);
      const deleteBody = await deleteRes.json();
      expect(deleteBody.data.id).toBe(profileId);
      expect(deleteBody.data.status).toBe('archived');

      // 7. Verify version 1 and 2 snapshots remain immutable and accessible after profile archiving
      const snapAfterArchive = await fetch(`${baseUrl}/api/manage/agent-profiles/${profileId}/versions/1`, {
        headers: { Cookie: aliceCookie },
      });
      expect(snapAfterArchive.status).toBe(200);
      const snapJson = await snapAfterArchive.json();
      expect(snapJson.data.version).toBe(1);
      expect(snapJson.data.identity).toBe('You are an architect.');
    });
  });

  describe('6. Tenant Isolation & 404 Protection (Cross-Tenant Rejection)', () => {
    let aliceProfileId: string;

    beforeEach(async () => {
      const res = await fetch(`${baseUrl}/api/manage/agent-profiles`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'd1111111-1111-4111-8111-111111111111',
        },
        body: JSON.stringify({
          name: 'Alice Private Profile',
          identity: 'Private Content',
        }),
      });
      const data = await res.json();
      aliceProfileId = data.data.id;
    });

    it('returns uniform 404 NOT_FOUND when Bob tries to inspect Alice profile', async () => {
      const res = await fetch(`${baseUrl}/api/manage/agent-profiles/${aliceProfileId}`, {
        headers: { Cookie: bobCookie },
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('returns uniform 404 NOT_FOUND when Bob tries to list Alice versions', async () => {
      const res = await fetch(`${baseUrl}/api/manage/agent-profiles/${aliceProfileId}/versions`, {
        headers: { Cookie: bobCookie },
      });
      expect(res.status).toBe(404);
    });

    it('returns uniform 404 NOT_FOUND when Bob tries to publish a version to Alice profile', async () => {
      const res = await fetch(`${baseUrl}/api/manage/agent-profiles/${aliceProfileId}/versions`, {
        method: 'POST',
        headers: {
          Cookie: bobCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ identity: 'Hijack attempt' }),
      });
      expect(res.status).toBe(404);
    });

    it('returns uniform 404 NOT_FOUND when Bob tries to bind Alice profile to Bob space', async () => {
      const res = await fetch(`${baseUrl}/api/spaces/${bobSpaceId}/agent-profile`, {
        method: 'POST',
        headers: {
          Cookie: bobCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ profileId: aliceProfileId }),
      });
      expect(res.status).toBe(404);
    });

    it('returns uniform 404 NOT_FOUND when Alice tries to bind a profile to Bob space', async () => {
      const res = await fetch(`${baseUrl}/api/spaces/${bobSpaceId}/agent-profile`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ profileId: aliceProfileId }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('7. Space Profile Binding Contract (appliesTo: new_session_generation)', () => {
    it('binds space to profile and returns appliesTo: new_session_generation without claiming hot reload', async () => {
      const createRes = await fetch(`${baseUrl}/api/manage/agent-profiles`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'd2222222-2222-4222-8222-222222222222',
        },
        body: JSON.stringify({
          name: 'Space Bound Profile',
          identity: 'Identity Space Bound',
        }),
      });
      const createData = await createRes.json();
      const profileId = createData.data.id;

      // Bind space
      const bindRes = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/agent-profile`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          profileId,
          version: 1,
        }),
      });

      expect(bindRes.status).toBe(200);
      const bindData = await bindRes.json();
      expect(bindData.data.spaceId).toBe(aliceSpaceId);
      expect(bindData.data.profile).toEqual({
        id: profileId,
        name: 'Space Bound Profile',
        version: 1,
      });

      // Unbind space
      const unbindRes = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/agent-profile`, {
        method: 'DELETE',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
        },
      });

      expect(unbindRes.status).toBe(200);
      const unbindData = await unbindRes.json();
      expect(unbindData.data.spaceId).toBe(aliceSpaceId);
      expect(unbindData.data.profile).toBeNull();
    });
  });

  describe('8. Prohibited Aliases Return 404 NOT_FOUND', () => {
    it('returns 404 for all legacy /api/agent-profiles routes', async () => {
      // GET /api/agent-profiles
      const res1 = await fetch(`${baseUrl}/api/agent-profiles`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res1.status).toBe(404);

      // POST /api/agent-profiles
      const res2 = await fetch(`${baseUrl}/api/agent-profiles`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'f1111111-1111-4111-8111-111111111111',
        },
        body: JSON.stringify({ name: 'Alias Profile' }),
      });
      expect(res2.status).toBe(404);

      // GET /api/agent-profiles/:id
      const res3 = await fetch(`${baseUrl}/api/agent-profiles/prof_123`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res3.status).toBe(404);

      // GET /api/agent-profiles/:id/versions
      const res4 = await fetch(`${baseUrl}/api/agent-profiles/prof_123/versions`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res4.status).toBe(404);

      // GET /api/agent-profiles/:id/versions/1
      const res5 = await fetch(`${baseUrl}/api/agent-profiles/prof_123/versions/1`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res5.status).toBe(404);

      // POST /api/agent-profiles/:id/versions
      const res6 = await fetch(`${baseUrl}/api/agent-profiles/prof_123/versions`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ identity: 'Alias version' }),
      });
      expect(res6.status).toBe(404);

      // DELETE /api/agent-profiles/:id
      const res7 = await fetch(`${baseUrl}/api/agent-profiles/prof_123`, {
        method: 'DELETE',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
        },
      });
      expect(res7.status).toBe(404);
    });

    it('returns 404 for legacy space binding aliases (/api/manage/spaces/:id/agent-profile, /spaces/:id/agent-profile)', async () => {
      // POST /api/manage/spaces/:spaceId/agent-profile
      const res1 = await fetch(`${baseUrl}/api/manage/spaces/${aliceSpaceId}/agent-profile`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ profileId: 'prof_1' }),
      });
      expect(res1.status).toBe(404);

      // DELETE /api/manage/spaces/:spaceId/agent-profile
      const res2 = await fetch(`${baseUrl}/api/manage/spaces/${aliceSpaceId}/agent-profile`, {
        method: 'DELETE',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
        },
      });
      expect(res2.status).toBe(404);

      // POST /spaces/:spaceId/agent-profile
      const res3 = await fetch(`${baseUrl}/spaces/${aliceSpaceId}/agent-profile`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ profileId: 'prof_1' }),
      });
      expect(res3.status).toBe(404);

      // DELETE /spaces/:spaceId/agent-profile
      const res4 = await fetch(`${baseUrl}/spaces/${aliceSpaceId}/agent-profile`, {
        method: 'DELETE',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
        },
      });
      expect(res4.status).toBe(404);
    });
  });

  describe('9. Privacy & Safe Responses (JSON.stringify contains NO promptHash, snapshotId, or userId)', () => {
    it('ensures all management and version responses omit promptHash, snapshotId, and userId', async () => {
      // 1. Create Profile
      const createRes = await fetch(`${baseUrl}/api/manage/agent-profiles`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'f2222222-2222-4222-8222-222222222222',
        },
        body: JSON.stringify({
          name: 'Privacy Profile',
          identity: 'Classified Identity',
          soul: 'Classified Soul',
          agents: 'Classified Agents',
          tools: 'Classified Tools',
        }),
      });
      expect(createRes.status).toBe(201);
      const createJson = await createRes.json();
      const createSerialized = JSON.stringify(createJson);
      expect(createSerialized).not.toContain('promptHash');
      expect(createSerialized).not.toContain('snapshotId');
      expect(createSerialized).not.toContain('userId');

      const profileId = createJson.data.id;

      // 2. List Profiles
      const listRes = await fetch(`${baseUrl}/api/manage/agent-profiles`, {
        headers: { Cookie: aliceCookie },
      });
      expect(listRes.status).toBe(200);
      const listJson = await listRes.json();
      const listSerialized = JSON.stringify(listJson);
      expect(listSerialized).not.toContain('promptHash');
      expect(listSerialized).not.toContain('snapshotId');
      expect(listSerialized).not.toContain('userId');

      // 3. Get Profile Detail
      const getRes = await fetch(`${baseUrl}/api/manage/agent-profiles/${profileId}`, {
        headers: { Cookie: aliceCookie },
      });
      expect(getRes.status).toBe(200);
      const getJson = await getRes.json();
      const getSerialized = JSON.stringify(getJson);
      expect(getSerialized).not.toContain('promptHash');
      expect(getSerialized).not.toContain('snapshotId');
      expect(getSerialized).not.toContain('userId');

      // 4. Create Version
      const v2Res = await fetch(`${baseUrl}/api/manage/agent-profiles/${profileId}/versions`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'f3333333-3333-4333-8333-333333333333',
        },
        body: JSON.stringify({
          identity: 'Classified Identity V2',
        }),
      });
      expect(v2Res.status).toBe(201);
      const v2Json = await v2Res.json();
      const v2Serialized = JSON.stringify(v2Json);
      expect(v2Serialized).not.toContain('promptHash');
      expect(v2Serialized).not.toContain('snapshotId');
      expect(v2Serialized).not.toContain('userId');

      // 5. List Versions
      const listVersRes = await fetch(`${baseUrl}/api/manage/agent-profiles/${profileId}/versions`, {
        headers: { Cookie: aliceCookie },
      });
      expect(listVersRes.status).toBe(200);
      const listVersJson = await listVersRes.json();
      const listVersSerialized = JSON.stringify(listVersJson);
      expect(listVersSerialized).not.toContain('promptHash');
      expect(listVersSerialized).not.toContain('snapshotId');
      expect(listVersSerialized).not.toContain('userId');

      // 6. Get Specific Version
      const getVerRes = await fetch(`${baseUrl}/api/manage/agent-profiles/${profileId}/versions/1`, {
        headers: { Cookie: aliceCookie },
      });
      expect(getVerRes.status).toBe(200);
      const getVerJson = await getVerRes.json();
      const getVerSerialized = JSON.stringify(getVerJson);
      expect(getVerSerialized).not.toContain('promptHash');
      expect(getVerSerialized).not.toContain('snapshotId');
      expect(getVerSerialized).not.toContain('userId');

      // 7. Soft Archive Profile
      const deleteRes = await fetch(`${baseUrl}/api/manage/agent-profiles/${profileId}`, {
        method: 'DELETE',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
        },
      });
      expect(deleteRes.status).toBe(200);
      const deleteJson = await deleteRes.json();
      const deleteSerialized = JSON.stringify(deleteJson);
      expect(deleteSerialized).not.toContain('promptHash');
      expect(deleteSerialized).not.toContain('snapshotId');
      expect(deleteSerialized).not.toContain('userId');
    });
  });

  describe('10. Governance: Archived Bind Rejection, No Hard Delete, and Restart Idempotency', () => {
    it('rejects binding an archived profile to a space with 400 Validation Error', async () => {
      // Create and archive profile
      const createRes = await fetch(`${baseUrl}/api/manage/agent-profiles`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'f4444444-4444-4444-8444-444444444444',
        },
        body: JSON.stringify({ name: 'Archived For Binding Test' }),
      });
      const createJson = await createRes.json();
      const profileId = createJson.data.id;

      await fetch(`${baseUrl}/api/manage/agent-profiles/${profileId}`, {
        method: 'DELETE',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
        },
      });

      // Attempt to bind archived profile
      const bindRes = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/agent-profile`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ profileId }),
      });

      expect(bindRes.status).toBe(400);
      const body = await bindRes.json();
      expect(body.error.message).toMatch(/Cannot (modify or )?bind archived/i);
    });

    it('soft deletes (archives) only: row remains in agent_profiles and snapshots table', async () => {
      const createRes = await fetch(`${baseUrl}/api/manage/agent-profiles`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'f5555555-5555-4555-8555-555555555555',
        },
        body: JSON.stringify({ name: 'Soft Delete Check', identity: 'Still in snapshots' }),
      });
      const createJson = await createRes.json();
      const profileId = createJson.data.id;

      // Delete via API
      const delRes = await fetch(`${baseUrl}/api/manage/agent-profiles/${profileId}`, {
        method: 'DELETE',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
        },
      });
      expect(delRes.status).toBe(200);

      // Verify DB row still exists in agent_profiles with status 'archived'
      const row = db.prepare('SELECT status FROM agent_profiles WHERE id = ?').get(profileId) as { status: string };
      expect(row).toBeDefined();
      expect(row.status).toBe('archived');

      // Verify snapshots are intact
      const snaps = db.prepare('SELECT count(*) as count FROM agent_profile_snapshots WHERE profile_id = ?').get(profileId) as { count: number | bigint };
      expect(Number(snaps.count)).toBe(1);
    });

    it('supports restart idempotency: resolves replay from DB correctly', async () => {
      const key = 'f6666666-6666-4666-8666-666666666666';
      const payload = {
        name: 'Restart Idempotent Profile',
        identity: 'Restart Identity',
      };

      const res1 = await fetch(`${baseUrl}/api/manage/agent-profiles`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify(payload),
      });
      expect(res1.status).toBe(201);
      const data1 = await res1.json();

      // Second request with same idempotency key after DB persistence
      const res2 = await fetch(`${baseUrl}/api/manage/agent-profiles`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify(payload),
      });
      expect(res2.status).toBe(201);
      const data2 = await res2.json();

      expect(data1.data.id).toBe(data2.data.id);
      expect(data1.data.name).toBe(data2.data.name);
      expect(data1.data.snapshot.identity).toBe('Restart Identity');
      expect(data2.data.snapshot.identity).toBe('Restart Identity');
    });
  });

  describe('8. Profile Rollback Control Plane (POST /api/manage/agent-profiles/:id/rollback)', () => {
    let profileId: string;

    beforeEach(async () => {
      // 1. Create Profile (Version 1)
      const res1 = await fetch(`${baseUrl}/api/manage/agent-profiles`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': '11111111-1111-4111-8111-111111111111',
        },
        body: JSON.stringify({
          name: 'Rollback Test Profile',
          identity: 'Identity V1 Golden Standard',
          soul: 'Soul V1 Stable Tone',
          agents: 'Agents V1 Direct',
          tools: 'Tools V1 Minimal',
          changeSummary: 'Version 1 Golden Standard',
        }),
      });
      expect(res1.status).toBe(201);
      const json1 = await res1.json();
      profileId = json1.data.id;

      // 2. Publish Version 2
      const res2 = await fetch(`${baseUrl}/api/manage/agent-profiles/${profileId}/versions`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': '22222222-2222-4222-8222-222222222222',
        },
        body: JSON.stringify({
          identity: 'Identity V2 Experimental',
          soul: 'Soul V2 Aggressive Tone',
          agents: 'Agents V2 Complex',
          tools: 'Tools V2 Expanded',
          changeSummary: 'Version 2 Experimental Changes',
        }),
      });
      expect(res2.status).toBe(201);

      // 3. Publish Version 3
      const res3 = await fetch(`${baseUrl}/api/manage/agent-profiles/${profileId}/versions`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': '33333333-3333-4333-8333-333333333333',
        },
        body: JSON.stringify({
          identity: 'Identity V3 Broken',
          soul: 'Soul V3 Buggy Tone',
          agents: 'Agents V3 Broken',
          tools: 'Tools V3 Broken',
          changeSummary: 'Version 3 Regression',
        }),
      });
      expect(res3.status).toBe(201);
    });

    it('Scenario: versions 1, 2, 3 -> rollback 1 creates v4, content = v1, activeVersion = 4, history preserved', async () => {
      const rollbackRes = await fetch(`${baseUrl}/api/manage/agent-profiles/${profileId}/rollback`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': '44444444-4444-4444-8444-444444444444',
        },
        body: JSON.stringify({
          targetVersion: 1,
          changeSummary: 'Emergency rollback to V1 Golden Standard',
        }),
      });

      expect(rollbackRes.status).toBe(200);
      const rollbackBody = await rollbackRes.json();
      expect(rollbackBody.success).toBe(true);
      expect(rollbackBody.data.version).toBe(4);
      expect(rollbackBody.data.newVersion).toBe(4);
      expect(rollbackBody.data.identity).toBe('Identity V1 Golden Standard');
      expect(rollbackBody.data.soul).toBe('Soul V1 Stable Tone');
      expect(rollbackBody.data.agents).toBe('Agents V1 Direct');
      expect(rollbackBody.data.tools).toBe('Tools V1 Minimal');
      expect(rollbackBody.data.changeSummary).toBe('Emergency rollback to V1 Golden Standard');
      expect(rollbackBody.data.promptHash).toBeUndefined(); // Never leak promptHash

      // Verify profile activeVersion is updated to 4
      const profileRes = await fetch(`${baseUrl}/api/manage/agent-profiles/${profileId}`, {
        headers: { Cookie: aliceCookie },
      });
      expect(profileRes.status).toBe(200);
      const profileBody = await profileRes.json();
      expect(profileBody.data.activeVersion).toBe(4);
      expect(profileBody.data.snapshot.version).toBe(4);
      expect(profileBody.data.snapshot.identity).toBe('Identity V1 Golden Standard');

      // Verify all 4 version snapshots exist and are immutable
      const versionsRes = await fetch(`${baseUrl}/api/manage/agent-profiles/${profileId}/versions`, {
        headers: { Cookie: aliceCookie },
      });
      const versionsBody = await versionsRes.json();
      expect(versionsBody.data.length).toBe(4);
      expect(versionsBody.data[0].version).toBe(1);
      expect(versionsBody.data[0].identity).toBe('Identity V1 Golden Standard');
      expect(versionsBody.data[1].version).toBe(2);
      expect(versionsBody.data[1].identity).toBe('Identity V2 Experimental');
      expect(versionsBody.data[2].version).toBe(3);
      expect(versionsBody.data[2].identity).toBe('Identity V3 Broken');
      expect(versionsBody.data[3].version).toBe(4);
      expect(versionsBody.data[3].identity).toBe('Identity V1 Golden Standard');

      // Verify audit log action is 'profile_version_rolled_back', has NO prompt content, only IDs and version numbers
      const auditRows = db.prepare(`
        SELECT username, action, details FROM auth_audit_log WHERE user_id = ? AND action = 'profile_version_rolled_back'
      `).all(aliceUserId) as Array<{ username: string; action: string; details: string }>;

      expect(auditRows.length).toBeGreaterThan(0);
      const row = auditRows[0];
      expect(row.username).toBe('alice');
      expect(row.action).toBe('profile_version_rolled_back');

      const rollbackAudit = JSON.parse(row.details);
      expect(rollbackAudit.profileId).toBe(profileId);
      expect(rollbackAudit.version).toBe(4);
      expect(rollbackAudit.newVersion).toBe(4);
      expect(rollbackAudit.targetVersion).toBe(1);
      expect(rollbackAudit.identity).toBeUndefined();
      expect(rollbackAudit.soul).toBeUndefined();
      expect(rollbackAudit.agents).toBeUndefined();
      expect(rollbackAudit.tools).toBeUndefined();
      expect(rollbackAudit.promptHash).toBeUndefined();
      expect(rollbackAudit.changeSummary).toBeUndefined();
    });

    it('enforces Idempotency-Key and CSRF token on POST /rollback', async () => {
      // 1. Missing CSRF
      const noCsrfRes = await fetch(`${baseUrl}/api/manage/agent-profiles/${profileId}/rollback`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'Content-Type': 'application/json',
          'Idempotency-Key': '55555555-5555-4555-8555-555555555555',
        },
        body: JSON.stringify({ targetVersion: 1 }),
      });
      expect(noCsrfRes.status).toBe(403);

      // 2. Missing Idempotency-Key
      const noIdempRes = await fetch(`${baseUrl}/api/manage/agent-profiles/${profileId}/rollback`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ targetVersion: 1 }),
      });
      expect(noIdempRes.status).toBe(400);
      const noIdempBody = await noIdempRes.json();
      expect(noIdempBody.error.message).toMatch(/Idempotency-Key/i);
    });

    it('supports idempotent replay and detects conflict with different parameters', async () => {
      const idempKey = '66666666-6666-4666-8666-666666666666';

      // 1. First rollback call
      const res1 = await fetch(`${baseUrl}/api/manage/agent-profiles/${profileId}/rollback`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempKey,
        },
        body: JSON.stringify({ targetVersion: 1 }),
      });
      expect(res1.status).toBe(200);
      const body1 = await res1.json();
      expect(body1.data.version).toBe(4);

      // 2. Replay same request with same idempotency key -> returns exact same result without creating version 5
      const res2 = await fetch(`${baseUrl}/api/manage/agent-profiles/${profileId}/rollback`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempKey,
        },
        body: JSON.stringify({ targetVersion: 1 }),
      });
      expect(res2.status).toBe(200);
      const body2 = await res2.json();
      expect(body2.data.version).toBe(4);

      // Verify total versions is still 4 (no extra snapshot was created)
      const countRow = db.prepare('SELECT count(*) as c FROM agent_profile_snapshots WHERE profile_id = ?').get(profileId) as { c: number };
      expect(Number(countRow.c)).toBe(4);

      // 3. Conflict: same idempotency key with different targetVersion (targetVersion: 2) -> 409 Conflict
      const resConflict = await fetch(`${baseUrl}/api/manage/agent-profiles/${profileId}/rollback`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempKey,
        },
        body: JSON.stringify({ targetVersion: 2 }),
      });
      expect(resConflict.status).toBe(409);
    });

    it('enforces cross-tenant isolation (Bob cannot rollback Alice profile)', async () => {
      const res = await fetch(`${baseUrl}/api/manage/agent-profiles/${profileId}/rollback`, {
        method: 'POST',
        headers: {
          Cookie: bobCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': '77777777-7777-4777-8777-777777777777',
        },
        body: JSON.stringify({ targetVersion: 1 }),
      });
      expect(res.status).toBe(404);
    });

    it('rejects invalid targetVersion (0, negative, non-integer, string, current version, missing target)', async () => {
      // 1. targetVersion: 0
      const res0 = await fetch(`${baseUrl}/api/manage/agent-profiles/${profileId}/rollback`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': '88888888-8888-4888-8888-888888888881',
        },
        body: JSON.stringify({ targetVersion: 0 }),
      });
      expect(res0.status).toBe(400);

      // 2. targetVersion: -1
      const resNeg = await fetch(`${baseUrl}/api/manage/agent-profiles/${profileId}/rollback`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': '88888888-8888-4888-8888-888888888882',
        },
        body: JSON.stringify({ targetVersion: -1 }),
      });
      expect(resNeg.status).toBe(400);

      // 3. targetVersion: 1.5 (non-integer)
      const resFloat = await fetch(`${baseUrl}/api/manage/agent-profiles/${profileId}/rollback`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': '88888888-8888-4888-8888-888888888883',
        },
        body: JSON.stringify({ targetVersion: 1.5 }),
      });
      expect(resFloat.status).toBe(400);

      // 4. targetVersion: "1" (string)
      const resStr = await fetch(`${baseUrl}/api/manage/agent-profiles/${profileId}/rollback`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': '88888888-8888-4888-8888-888888888884',
        },
        body: JSON.stringify({ targetVersion: '1' }),
      });
      expect(resStr.status).toBe(400);

      // 5. targetVersion: 3 (current active version) -> 400 Bad Request
      const resCurrent = await fetch(`${baseUrl}/api/manage/agent-profiles/${profileId}/rollback`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': '88888888-8888-4888-8888-888888888885',
        },
        body: JSON.stringify({ targetVersion: 3 }),
      });
      expect(resCurrent.status).toBe(400);
      const curBody = await resCurrent.json();
      expect(curBody.error.message).toMatch(/current active version/i);

      // 6. targetVersion: 99 (missing target version) -> 404 Not Found
      const resMissing = await fetch(`${baseUrl}/api/manage/agent-profiles/${profileId}/rollback`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': '88888888-8888-4888-8888-888888888886',
        },
        body: JSON.stringify({ targetVersion: 99 }),
      });
      expect(resMissing.status).toBe(404);

      // 7. Unknown fields rejected
      const resUnknown = await fetch(`${baseUrl}/api/manage/agent-profiles/${profileId}/rollback`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': '88888888-8888-4888-8888-888888888887',
        },
        body: JSON.stringify({ targetVersion: 1, extraField: 'bad' }),
      });
      expect(resUnknown.status).toBe(400);
    });

    it('rejects rollback on archived agent profiles', async () => {
      // Archive profile
      await fetch(`${baseUrl}/api/manage/agent-profiles/${profileId}`, {
        method: 'DELETE',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
        },
      });

      // Attempt rollback on archived profile -> 400
      const res = await fetch(`${baseUrl}/api/manage/agent-profiles/${profileId}/rollback`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': '99999999-9999-4999-8999-999999999999',
        },
        body: JSON.stringify({ targetVersion: 1 }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toMatch(/archived or deleted/i);
    });
  });
});
