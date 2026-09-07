import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebChannelServer } from '../src/server.js';
import { InMemoryPlatformWebApi } from './test-platform-api.js';
import { InMemoryRuntimeGateway } from './test-gateway.js';

describe('Owner Lifecycle HTTP Routes (Multi-Tenancy, CSRF, Active Turn 409, Generational Reset)', () => {
  let server: WebChannelServer;
  let serverUrl: string;
  let serverCsrfToken: string;
  let platformApi: InMemoryPlatformWebApi;
  let runtimeGateway: InMemoryRuntimeGateway;

  let aliceCookie: string;
  let bobCookie: string;

  beforeAll(async () => {
    platformApi = new InMemoryPlatformWebApi();
    runtimeGateway = new InMemoryRuntimeGateway({ platformApi });
    serverCsrfToken = 'test-suite-explicit-csrf-token-at-least-32-chars-long';

    server = new WebChannelServer({
      platformApi,
      runtimeGateway,
      csrfToken: serverCsrfToken,
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 64 * 1024,
    });

    const info = await server.start();
    serverUrl = info.url;

    // Login Alice and Bob
    const aliceRes = await fetch(`${serverUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-Csrf': serverCsrfToken,
        Origin: serverUrl,
      },
      body: JSON.stringify({ username: 'alice', password: 'password123' }),
    });
    expect(aliceRes.status).toBe(200);
    const aliceSetCookie = aliceRes.headers.get('set-cookie') || '';
    expect(aliceSetCookie).toContain('enkeep_session=');
    aliceCookie = aliceSetCookie.split(';')[0];

    const bobRes = await fetch(`${serverUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-Csrf': serverCsrfToken,
        Origin: serverUrl,
      },
      body: JSON.stringify({ username: 'bob', password: 'password123' }),
    });
    expect(bobRes.status).toBe(200);
    const bobSetCookie = bobRes.headers.get('set-cookie') || '';
    bobCookie = bobSetCookie.split(';')[0];
  });

  afterAll(async () => {
    await server.stop();
  });

  describe('1. Space Lifecycle HTTP Endpoints', () => {
    let aliceSpaceId: string;

    it('creates space for Alice with name only', async () => {
      const res = await fetch(`${serverUrl}/api/spaces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          Origin: serverUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          name: 'Original Space Name',
        }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.name).toBe('Original Space Name');
      expect(json.data.status).toBe('active');
      expect(json.data.folder).toBeUndefined();
      expect(json.data.executionMode).toBeUndefined();
      aliceSpaceId = json.data.id;
    });

    it('POST /api/spaces rejects unexpected fields like folder or executionMode with 400', async () => {
      const res = await fetch(`${serverUrl}/api/spaces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          Origin: serverUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          name: 'Illegal Space',
          folder: 'spaces/custom',
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.message).toContain('Unexpected field');
    });

    it('PATCH /api/spaces/:id renames space with { name only }', async () => {
      const res = await fetch(`${serverUrl}/api/spaces/${aliceSpaceId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          Origin: serverUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          name: 'Renamed Space Name',
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.name).toBe('Renamed Space Name');
      expect(json.data.folder).toBeUndefined();
    });

    it('PATCH /api/spaces/:id rejects unknown fields like folder or executionMode with 400', async () => {
      const res = await fetch(`${serverUrl}/api/spaces/${aliceSpaceId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          Origin: serverUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          name: 'Illegal Update',
          folder: 'spaces/changed-folder',
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.message).toContain('Unexpected field');
    });

    it('PATCH /api/spaces/:id rejects missing or empty name with 400', async () => {
      const res = await fetch(`${serverUrl}/api/spaces/${aliceSpaceId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          Origin: serverUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          name: '   ',
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.message).toContain('Space name must be a non-empty string');
    });

    it('POST /api/spaces/:id/archive rejects non-empty body with 400', async () => {
      const res = await fetch(`${serverUrl}/api/spaces/${aliceSpaceId}/archive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          Origin: serverUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          illegalField: true,
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.message).toContain('empty body');
    });

    it('POST /api/spaces/:id/archive archives space with empty body', async () => {
      const res = await fetch(`${serverUrl}/api/spaces/${aliceSpaceId}/archive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          Origin: serverUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.id).toBe(aliceSpaceId);
      expect(json.data.status).toBe('archived');
    });

    it('GET /api/spaces handles includeArchived boolean query strictly', async () => {
      // Default (no query) excludes archived
      const resDefault = await fetch(`${serverUrl}/api/spaces`, {
        headers: {
          Cookie: aliceCookie,
        },
      });
      expect(resDefault.status).toBe(200);
      const jsonDefault = await resDefault.json();
      expect(jsonDefault.data.find((s: any) => s.id === aliceSpaceId)).toBeUndefined();

      // includeArchived=false excludes archived
      const resFalse = await fetch(`${serverUrl}/api/spaces?includeArchived=false`, {
        headers: {
          Cookie: aliceCookie,
        },
      });
      expect(resFalse.status).toBe(200);
      const jsonFalse = await resFalse.json();
      expect(jsonFalse.data.find((s: any) => s.id === aliceSpaceId)).toBeUndefined();

      // includeArchived=true includes archived
      const resTrue = await fetch(`${serverUrl}/api/spaces?includeArchived=true`, {
        headers: {
          Cookie: aliceCookie,
        },
      });
      expect(resTrue.status).toBe(200);
      const jsonTrue = await resTrue.json();
      expect(jsonTrue.data.find((s: any) => s.id === aliceSpaceId)).toBeDefined();

      // Invalid non-boolean value returns 400 Bad Request
      const resInvalid = await fetch(`${serverUrl}/api/spaces?includeArchived=yes`, {
        headers: {
          Cookie: aliceCookie,
        },
      });
      expect(resInvalid.status).toBe(400);
      const jsonInvalid = await resInvalid.json();
      expect(jsonInvalid.error.message).toContain('includeArchived');
    });
  });

  describe('2. Session Lifecycle HTTP Endpoints', () => {
    let spaceId: string;
    let sessionId: string;

    beforeAll(async () => {
      const spaceRes = await fetch(`${serverUrl}/api/spaces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          Origin: serverUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          name: 'Session Test Space',
        }),
      });
      const spaceJson = await spaceRes.json();
      spaceId = spaceJson.data.id;
    });

    it('creates session with spaceId and optional initial title', async () => {
      const res = await fetch(`${serverUrl}/api/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          Origin: serverUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          spaceId,
          title: 'Initial Session Title',
        }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.title).toBe('Initial Session Title');
      expect(json.data.status).toBe('active');
      expect(json.data.currentGeneration).toBe(1);
      expect(json.data.peerId).toBeUndefined();
      expect(json.data.dshSessionId).toBeUndefined();
      sessionId = json.data.id;
    });

    it('POST /api/sessions rejects illegal fields like peerId or dshSessionId with 400', async () => {
      const res = await fetch(`${serverUrl}/api/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          Origin: serverUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          spaceId,
          peerId: 'custom-peer',
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.message).toContain('Unexpected field');
    });

    it('PATCH /api/sessions/:id updates title only', async () => {
      const res = await fetch(`${serverUrl}/api/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          Origin: serverUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          title: 'Updated Session Title',
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.title).toBe('Updated Session Title');
    });

    it('PATCH /api/sessions/:id rejects attempts to mutate spaceId or executionMode with 400', async () => {
      const res = await fetch(`${serverUrl}/api/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          Origin: serverUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          spaceId: 'other-space',
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.message).toContain('Unexpected field');
    });

    it('POST /api/sessions/:id/archive archives session', async () => {
      const res = await fetch(`${serverUrl}/api/sessions/${sessionId}/archive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          Origin: serverUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.status).toBe('archived');
    });

    it('GET /api/sessions and /api/spaces/:id/sessions filter archived items strictly', async () => {
      const resActive = await fetch(`${serverUrl}/api/spaces/${spaceId}/sessions?includeArchived=false`, {
        headers: {
          Cookie: aliceCookie,
        },
      });
      const jsonActive = await resActive.json();
      expect(jsonActive.data.find((s: any) => s.id === sessionId)).toBeUndefined();

      const resAll = await fetch(`${serverUrl}/api/spaces/${spaceId}/sessions?includeArchived=true`, {
        headers: {
          Cookie: aliceCookie,
        },
      });
      const jsonAll = await resAll.json();
      expect(jsonAll.data.find((s: any) => s.id === sessionId)).toBeDefined();
    });
  });

  describe('3. Generational Reset & Generations Query HTTP Endpoints', () => {
    let spaceId: string;
    let sessionId: string;
    const testIdempKey = 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d';

    beforeAll(async () => {
      const spaceRes = await fetch(`${serverUrl}/api/spaces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          Origin: serverUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          name: 'Reset Generation Space',
        }),
      });
      const spaceJson = await spaceRes.json();
      spaceId = spaceJson.data.id;

      const sesRes = await fetch(`${serverUrl}/api/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          Origin: serverUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          spaceId,
          title: 'Gen 1 Session',
        }),
      });
      const sesJson = await sesRes.json();
      sessionId = sesJson.data.id;
    });

    it('GET /api/sessions/:id/generations returns initial generation 1', async () => {
      const res = await fetch(`${serverUrl}/api/sessions/${sessionId}/generations`, {
        headers: {
          Cookie: aliceCookie,
        },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.length).toBe(1);
      expect(json.data[0].generation).toBe(1);
      expect(json.data[0].resetReason).toBe('initial');
      expect(json.data[0].isCurrent).toBe(true);
    });

    it('POST /api/sessions/:id/reset rejects malformed, non-v4, or uppercase Idempotency-Key header with 400', async () => {
      // Malformed string
      const resMalformed = await fetch(`${serverUrl}/api/sessions/${sessionId}/reset`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          'Idempotency-Key': 'not-a-valid-uuid-here',
          Origin: serverUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          reason: 'user_request',
        }),
      });
      expect(resMalformed.status).toBe(400);
      const jsonMalformed = await resMalformed.json();
      expect(jsonMalformed.error.message).toContain('Idempotency-Key');

      // UUIDv1 (non-v4)
      const resV1 = await fetch(`${serverUrl}/api/sessions/${sessionId}/reset`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          'Idempotency-Key': 'a1b2c3d4-e5f6-1a1b-8c2d-3e4f5a6b7c8d',
          Origin: serverUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          reason: 'user_request',
        }),
      });
      expect(resV1.status).toBe(400);

      // Uppercase UUIDv4 (must be strictly lowercase per HTTP spec)
      const resUpper = await fetch(`${serverUrl}/api/sessions/${sessionId}/reset`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          'Idempotency-Key': 'A1B2C3D4-E5F6-4A1B-8C2D-3E4F5A6B7C8D',
          Origin: serverUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          reason: 'user_request',
        }),
      });
      expect(resUpper.status).toBe(400);
    });

    it('POST /api/sessions/:id/reset rejects unexpected raw metadata / hashes with 400', async () => {
      const res = await fetch(`${serverUrl}/api/sessions/${sessionId}/reset`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          'Idempotency-Key': testIdempKey,
          Origin: serverUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          reason: 'user_request',
          rawMetadata: { dshInternalState: true },
          hashes: ['abc', '123'],
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.message).toContain('Unexpected field');
    });

    it('POST /api/sessions/:id/reset performs generational reset and supports idempotency replay', async () => {
      // First call with Idempotency-Key
      const res1 = await fetch(`${serverUrl}/api/sessions/${sessionId}/reset`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          'Idempotency-Key': testIdempKey,
          Origin: serverUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          reason: 'user_request',
        }),
      });

      expect(res1.status).toBe(200);
      const json1 = await res1.json();
      expect(json1.success).toBe(true);
      expect(json1.data.generation.generation).toBe(2);
      expect(json1.data.generation.resetReason).toBe('user_request');
      expect(json1.data.session.currentGeneration).toBe(2);
      expect(json1.data.isIdempotentHit).toBe(false);
      expect(json1.data.previousDshSessionId).toBeUndefined();
      expect(json1.data.newDshSessionId).toBeUndefined();

      // Replay with exact same Idempotency-Key
      const res2 = await fetch(`${serverUrl}/api/sessions/${sessionId}/reset`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          'Idempotency-Key': testIdempKey,
          Origin: serverUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          reason: 'user_request',
        }),
      });

      expect(res2.status).toBe(200);
      const json2 = await res2.json();
      expect(json2.success).toBe(true);
      expect(json2.data.generation.generation).toBe(2);
      expect(json2.data.isIdempotentHit).toBe(true);

      // Verify generations list
      const gensRes = await fetch(`${serverUrl}/api/sessions/${sessionId}/generations`, {
        headers: {
          Cookie: aliceCookie,
        },
      });
      const gensJson = await gensRes.json();
      expect(gensJson.data.length).toBe(2);
      expect(gensJson.data[1].generation).toBe(2);
      expect(gensJson.data[1].resetReason).toBe('user_request');
    });
  });

  describe('4. Multi-Tenant Isolation, CSRF & Active Turn Conflicts', () => {
    let aliceSpaceId: string;
    let aliceSessionId: string;

    beforeAll(async () => {
      const spaceRes = await fetch(`${serverUrl}/api/spaces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          Origin: serverUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          name: 'Alice Private Space',
        }),
      });
      const spaceJson = await spaceRes.json();
      aliceSpaceId = spaceJson.data.id;

      const sesRes = await fetch(`${serverUrl}/api/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          Origin: serverUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          spaceId: aliceSpaceId,
          title: 'Alice Private Session',
        }),
      });
      const sesJson = await sesRes.json();
      aliceSessionId = sesJson.data.id;
    });

    it('returns 404 when Bob attempts to PATCH Alice space', async () => {
      const res = await fetch(`${serverUrl}/api/spaces/${aliceSpaceId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          Origin: serverUrl,
          Cookie: bobCookie,
        },
        body: JSON.stringify({
          name: 'Bob Hacked Space',
        }),
      });

      expect(res.status).toBe(404);
    });

    it('returns 404 when Bob attempts to archive Alice space', async () => {
      const res = await fetch(`${serverUrl}/api/spaces/${aliceSpaceId}/archive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          Origin: serverUrl,
          Cookie: bobCookie,
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(404);
    });

    it('returns 404 when Bob attempts to reset Alice session', async () => {
      const res = await fetch(`${serverUrl}/api/sessions/${aliceSessionId}/reset`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          'Idempotency-Key': '11111111-2222-4333-8444-555555555555',
          Origin: serverUrl,
          Cookie: bobCookie,
        },
        body: JSON.stringify({
          reason: 'user_request',
        }),
      });

      expect(res.status).toBe(404);
    });

    it('returns 404 when Bob attempts to list Alice session generations', async () => {
      const res = await fetch(`${serverUrl}/api/sessions/${aliceSessionId}/generations`, {
        headers: {
          Cookie: bobCookie,
        },
      });

      expect(res.status).toBe(404);
    });

    it('returns 409 Conflict when attempting to archive or reset while active turns are running', async () => {
      // Simulate active turn on Alice space and session
      platformApi.activeTurns.add(aliceSpaceId);
      platformApi.activeTurns.add(aliceSessionId);

      // Attempt to archive space -> 409
      const spaceArchiveRes = await fetch(`${serverUrl}/api/spaces/${aliceSpaceId}/archive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          Origin: serverUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({}),
      });
      expect(spaceArchiveRes.status).toBe(409);

      // Attempt to archive session -> 409
      const sesArchiveRes = await fetch(`${serverUrl}/api/sessions/${aliceSessionId}/archive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          Origin: serverUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({}),
      });
      expect(sesArchiveRes.status).toBe(409);

      // Attempt to reset session -> 409
      const sesResetRes = await fetch(`${serverUrl}/api/sessions/${aliceSessionId}/reset`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          'Idempotency-Key': '22222222-3333-4444-8555-666666666666',
          Origin: serverUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({ reason: 'user_request' }),
      });
      expect(sesResetRes.status).toBe(409);

      // Clear active turns
      platformApi.activeTurns.clear();

      // Reset now succeeds
      const sesResetOk = await fetch(`${serverUrl}/api/sessions/${aliceSessionId}/reset`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          'Idempotency-Key': '22222222-3333-4444-8555-666666666666',
          Origin: serverUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({ reason: 'user_request' }),
      });
      expect(sesResetOk.status).toBe(200);
    });

    it('returns 403 when CSRF token is missing on mutations', async () => {
      const res = await fetch(`${serverUrl}/api/spaces/${aliceSpaceId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Origin: serverUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          name: 'No CSRF Name',
        }),
      });

      expect(res.status).toBe(403);
    });

    it('returns 401 when auth session cookie is missing', async () => {
      const res = await fetch(`${serverUrl}/api/spaces/${aliceSpaceId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          Origin: serverUrl,
        },
        body: JSON.stringify({
          name: 'No Auth Name',
        }),
      });

      expect(res.status).toBe(401);
    });
  });
});
