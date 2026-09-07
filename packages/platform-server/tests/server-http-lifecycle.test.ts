import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { provisionFixtures } from '@enkeep/platform-auth';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import {
  PlatformServer,
  SqliteWebMessageStore,
} from '../src/index.js';
import { TestOnlyRuntimeGateway } from './test-runtime-gateway.js';

describe('PlatformServer HTTP Lifecycle Routes, Generations & Strict Idempotency Integration', () => {
  let server: PlatformServer;
  let baseUrl: string;
  let aliceCookie: string;
  let bobCookie: string;
  let aliceSpaceId: string;
  let bobSpaceId: string;
  const testCsrfToken = 'lifecycle-http-csrf-token-32-chars-long!';

  beforeAll(async () => {
    const db = new DatabaseSync(':memory:');
    const storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);
    const runtimeGateway = new TestOnlyRuntimeGateway({
      storage,
      messageStore,
      autoReply: true,
      autoReplyDelayMs: 10,
    });

    server = new PlatformServer({
      database: db,
      host: '127.0.0.1',
      port: 0,
      cookieSecret: 'lifecycle-http-secret-key-32-chars!',
      csrfToken: testCsrfToken,
      runtimeGateway,
    });

    const addr = await server.start();
    baseUrl = addr.url;

    // Provision fixtures
    const fixtures = await provisionFixtures(server.storage, server.authService, {
      adminUsername: 'alice',
      adminPassword: 'AlicePassword123!',
      userPassword: 'BobPassword123!',
      disabledPassword: 'CharlieDisabledPassword123!',
    });
    aliceSpaceId = fixtures.adminContainerSpace.id;
    bobSpaceId = fixtures.userContainerSpace.id;

    // Login as Alice
    const aliceLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        username: 'alice',
        password: 'AlicePassword123!',
      }),
    });
    expect(aliceLogin.status).toBe(200);
    aliceCookie = aliceLogin.headers.get('set-cookie')?.split(';')[0] ?? '';

    // Login as Bob
    const bobLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        username: 'bob',
        password: 'BobPassword123!',
      }),
    });
    expect(bobLogin.status).toBe(200);
    bobCookie = bobLogin.headers.get('set-cookie')?.split(';')[0] ?? '';
  });

  afterAll(async () => {
    await server.stop();
  });

  describe('Space Lifecycle Routes', () => {
    let testSpaceId: string;

    it('POST /api/spaces creates a space with name, folder, and container executionMode', async () => {
      const res = await fetch(`${baseUrl}/api/spaces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          name: 'Original Space Name',
          folder: 'test-folder-alpha',
          executionMode: 'container',
        }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.name).toBe('Original Space Name');
      expect(json.data.status).toBe('active');
      testSpaceId = json.data.id;
    });

    it('PATCH /api/spaces/:id updates name and rejects unknown keys', async () => {
      // 1. Rejects unknown keys
      const rejectRes = await fetch(`${baseUrl}/api/spaces/${testSpaceId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          name: 'New Space Name',
          folder: 'cannot-change-folder',
        }),
      });
      expect(rejectRes.status).toBe(400);
      const rejectJson = await rejectRes.json();
      expect(rejectJson.error.message).toContain('Unexpected field "folder"');

      // 2. Rejects empty name
      const emptyRes = await fetch(`${baseUrl}/api/spaces/${testSpaceId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          name: '   ',
        }),
      });
      expect(emptyRes.status).toBe(400);

      // 3. Successful update
      const successRes = await fetch(`${baseUrl}/api/spaces/${testSpaceId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          name: 'Renamed Space Alpha',
        }),
      });
      expect(successRes.status).toBe(200);
      const successJson = await successRes.json();
      expect(successJson.data.name).toBe('Renamed Space Alpha');
    });

    it('POST /api/spaces/:id/archive archives space and cascades to sessions', async () => {
      // Create a session in test space
      const createSessRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          spaceId: testSpaceId,
          title: 'Session before space archive',
        }),
      });
      expect(createSessRes.status).toBe(201);
      const sessJson = await createSessRes.json();
      const sessId = sessJson.data.id;

      // Rejects non-empty body on archive
      const rejectArchive = await fetch(`${baseUrl}/api/spaces/${testSpaceId}/archive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          forbiddenPayload: true,
        }),
      });
      expect(rejectArchive.status).toBe(400);

      // Successfully archive space
      const archiveRes = await fetch(`${baseUrl}/api/spaces/${testSpaceId}/archive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
      });
      expect(archiveRes.status).toBe(200);
      const archiveJson = await archiveRes.json();
      expect(archiveJson.data.status).toBe('archived');

      // GET /api/spaces excludes archived by default
      const listActive = await fetch(`${baseUrl}/api/spaces`, {
        headers: { Cookie: aliceCookie },
      });
      const listActiveJson = await listActive.json();
      expect(listActiveJson.data.some((s: any) => s.id === testSpaceId)).toBe(false);

      // GET /api/spaces?includeArchived=true includes archived space
      const listAll = await fetch(`${baseUrl}/api/spaces?includeArchived=true`, {
        headers: { Cookie: aliceCookie },
      });
      const listAllJson = await listAll.json();
      expect(listAllJson.data.some((s: any) => s.id === testSpaceId)).toBe(true);

      // GET /api/spaces?includeArchived=invalid returns 400
      const listInvalid = await fetch(`${baseUrl}/api/spaces?includeArchived=not_a_bool`, {
        headers: { Cookie: aliceCookie },
      });
      expect(listInvalid.status).toBe(400);

      // Child session should be cascaded to archived
      const sessCheck = await fetch(`${baseUrl}/api/sessions?includeArchived=true&spaceId=${testSpaceId}`, {
        headers: { Cookie: aliceCookie },
      });
      const sessCheckJson = await sessCheck.json();
      const archivedSess = sessCheckJson.data.find((s: any) => s.id === sessId);
      expect(archivedSess).toBeDefined();
      expect(archivedSess.status).toBe('archived');
    });

    it('Cross-tenant space access returns 404', async () => {
      // Bob tries to update Alice's space -> 404
      const res = await fetch(`${baseUrl}/api/spaces/${testSpaceId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: bobCookie,
        },
        body: JSON.stringify({
          name: 'Bob Hacked Space',
        }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('Session Lifecycle, Reset, Generations & Strict Lowercase UUIDv4 Idempotency', () => {
    let sessionId: string;

    it('POST /api/sessions creates session with title and container mode', async () => {
      const res = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          spaceId: aliceSpaceId,
          title: 'Initial Session Title',
        }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.title).toBe('Initial Session Title');
      expect(json.data.status).toBe('active');
      expect(json.data.currentGeneration).toBe(1);
      sessionId = json.data.id;
    });

    it('PATCH /api/sessions/:id updates title and rejects immutable spaceId/executionMode with 400', async () => {
      // Rejects spaceId mutation
      const rejectSpace = await fetch(`${baseUrl}/api/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          title: 'New Title',
          spaceId: 'different-space-id',
        }),
      });
      expect(rejectSpace.status).toBe(400);

      // Rejects executionMode mutation
      const rejectMode = await fetch(`${baseUrl}/api/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          title: 'New Title',
          executionMode: 'host',
        }),
      });
      expect(rejectMode.status).toBe(400);

      // Successfully updates title
      const successRes = await fetch(`${baseUrl}/api/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          title: 'Updated Session Title',
        }),
      });
      expect(successRes.status).toBe(200);
      const successJson = await successRes.json();
      expect(successJson.data.title).toBe('Updated Session Title');
    });

    it('POST /api/sessions/:id/reset rejects missing or invalid Idempotency-Key header', async () => {
      // 1. Missing header entirely
      const missingRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/reset`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({ reason: 'test' }),
      });
      expect(missingRes.status).toBe(400);
      const missingJson = await missingRes.json();
      expect(missingJson.error.message).toContain('Missing required Idempotency-Key header');

      // 2. Non-canonical alternate header x-idempotency-key
      const altRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/reset`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          'x-idempotency-key': 'd8f7b57b-7df1-4a11-b0db-6e6912345678',
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({ reason: 'test' }),
      });
      expect(altRes.status).toBe(400);
      const altJson = await altRes.json();
      expect(altJson.error.message).toContain('Use canonical "Idempotency-Key" header');

      // 3. Body idempotencyKey (forbidden)
      const bodyKeyRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/reset`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          'Idempotency-Key': 'd8f7b57b-7df1-4a11-b0db-6e6912345678',
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          reason: 'test',
          idempotencyKey: 'd8f7b57b-7df1-4a11-b0db-6e6912345678',
        }),
      });
      expect(bodyKeyRes.status).toBe(400);
      const bodyKeyJson = await bodyKeyRes.json();
      expect(bodyKeyJson.error.message).toContain('Unexpected field "idempotencyKey"');

      // 4. Uppercase UUIDv4 (forbidden per canonical lowercase specification)
      const upperRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/reset`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          'Idempotency-Key': 'D8F7B57B-7DF1-4A11-B0DB-6E6912345678',
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({ reason: 'test' }),
      });
      expect(upperRes.status).toBe(400);
      const upperJson = await upperRes.json();
      expect(upperJson.error.message).toContain('Expected exact canonical lowercase UUID v4');

      // 5. Non-v4 UUID (UUIDv1)
      const v1Res = await fetch(`${baseUrl}/api/sessions/${sessionId}/reset`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          'Idempotency-Key': '9b1deb4d-3b7d-1bad-9bdd-2b0d7b3dcb6d',
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({ reason: 'test' }),
      });
      expect(v1Res.status).toBe(400);
    });

    it('POST /api/sessions/:id/reset performs generational reset and supports idempotency replay', async () => {
      const idempKey = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e';

      // 1. Initial reset to Gen 2
      const res1 = await fetch(`${baseUrl}/api/sessions/${sessionId}/reset`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          'Idempotency-Key': idempKey,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          reason: 'context_overflow_reset',
        }),
      });

      expect(res1.status).toBe(200);
      const json1 = await res1.json();
      expect(json1.success).toBe(true);
      expect(json1.data.generation).toBe(2);
      expect(json1.data.currentGeneration).toBe(2);
      expect(json1.data.resetReason).toBe('context_overflow_reset');

      // 2. Idempotent replay with same key and payload
      const res2 = await fetch(`${baseUrl}/api/sessions/${sessionId}/reset`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          'Idempotency-Key': idempKey,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          reason: 'context_overflow_reset',
        }),
      });

      expect(res2.status).toBe(200);
      const json2 = await res2.json();
      expect(json2.data.generation).toBe(2);
      expect(json2.data.currentGeneration).toBe(2);

      // 3. Replay with same key but DIFFERENT payload returns 409 Conflict
      const resConflict = await fetch(`${baseUrl}/api/sessions/${sessionId}/reset`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          'Idempotency-Key': idempKey,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          reason: 'different_reason',
        }),
      });
      expect(resConflict.status).toBe(409);
    });

    it('GET /api/sessions/:id/generations returns clean sanitized generation records without leaking internal IDs', async () => {
      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/generations`, {
        headers: {
          Cookie: aliceCookie,
        },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.currentGeneration).toBe(2);
      expect(json.data.generations.length).toBe(2);

      // Verify Gen 1
      const gen1 = json.data.generations[0];
      expect(gen1.generationNumber).toBe(1);
      expect(gen1.resetReason).toBe('initial');
      expect(gen1.current).toBe(false);
      // Ensure internal fields are NOT exposed
      expect((gen1 as any).id).toBeUndefined();
      expect((gen1 as any).userId).toBeUndefined();
      expect((gen1 as any).routeId).toBeUndefined();
      expect((gen1 as any).dshCheckpoint).toBeUndefined();
      expect((gen1 as any).metadata).toBeUndefined();

      // Verify Gen 2
      const gen2 = json.data.generations[1];
      expect(gen2.generationNumber).toBe(2);
      expect(gen2.resetReason).toBe('context_overflow_reset');
      expect(gen2.current).toBe(true);
      expect((gen2 as any).id).toBeUndefined();
      expect((gen2 as any).userId).toBeUndefined();
      expect((gen2 as any).routeId).toBeUndefined();
      expect((gen2 as any).dshCheckpoint).toBeUndefined();
    });

    it('POST /api/sessions/:id/archive soft archives session', async () => {
      const archiveRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/archive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
      });

      expect(archiveRes.status).toBe(200);
      const json = await archiveRes.json();
      expect(json.data.status).toBe('archived');

      // GET /api/sessions excludes archived by default
      const listActive = await fetch(`${baseUrl}/api/sessions?spaceId=${aliceSpaceId}`, {
        headers: { Cookie: aliceCookie },
      });
      const listActiveJson = await listActive.json();
      expect(listActiveJson.data.some((s: any) => s.id === sessionId)).toBe(false);

      // GET /api/sessions?includeArchived=true includes archived session
      const listAll = await fetch(`${baseUrl}/api/sessions?includeArchived=true&spaceId=${aliceSpaceId}`, {
        headers: { Cookie: aliceCookie },
      });
      const listAllJson = await listAll.json();
      expect(listAllJson.data.some((s: any) => s.id === sessionId)).toBe(true);
    });

    it('Cross-tenant session routes return 404 for Bob', async () => {
      // Bob attempts to reset Alice's session -> 404
      const resReset = await fetch(`${baseUrl}/api/sessions/${sessionId}/reset`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          'Idempotency-Key': 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b',
          Origin: baseUrl,
          Cookie: bobCookie,
        },
        body: JSON.stringify({ reason: 'bob_attack' }),
      });
      expect(resReset.status).toBe(404);

      // Bob attempts to get Alice's session generations -> 404
      const resGens = await fetch(`${baseUrl}/api/sessions/${sessionId}/generations`, {
        headers: { Cookie: bobCookie },
      });
      expect(resGens.status).toBe(404);

      // Bob attempts to archive Alice's session -> 404
      const resArchive = await fetch(`${baseUrl}/api/sessions/${sessionId}/archive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: bobCookie,
        },
      });
      expect(resArchive.status).toBe(404);
    });
  });

  describe('Integrated Platform Operations & Quota Endpoints (Active not 503)', () => {
    let createdTaskId: string;

    it('GET /api/readiness reports operations available and ready', async () => {
      const res = await fetch(`${baseUrl}/api/readiness`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.operations.producer.available).toBe(true);
    });

    it('PATCH /api/admin/quotas/:userId/tokens sets quota limit and succeeds (200, not 503)', async () => {
      // Find Alice user ID via /api/auth/me
      const userRes = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Cookie: aliceCookie },
      });
      expect(userRes.status).toBe(200);
      const userJson = await userRes.json();
      const aliceUserId = userJson.data.user.id;

      const patchRes = await fetch(`${baseUrl}/api/admin/quotas/${aliceUserId}/tokens`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          limit: 100000,
        }),
      });

      expect(patchRes.status).toBe(200);
      const patchJson = await patchRes.json();
      expect(patchJson.success).toBe(true);
      expect(patchJson.data.resource).toBe('tokens');
      expect(patchJson.data.limit).toBe(100000);
    });

    it('POST /api/manage/tasks creates task without 503 and returns authoritative task', async () => {
      // First create active session for Alice
      const sessRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          spaceId: aliceSpaceId,
          title: 'Ops Task Test Session',
        }),
      });
      expect(sessRes.status).toBe(201);
      const sessJson = await sessRes.json();
      const aliceSessionId = sessJson.data.id;

      const taskRes = await fetch(`${baseUrl}/api/manage/tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          'Idempotency-Key': '11111111-2222-4333-8444-555555555555',
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          title: 'Analyze Performance Logs',
          priority: 'high',
          prompt: 'Run security log analysis',
          sessionId: aliceSessionId,
        }),
      });

      expect(taskRes.status).toBe(201);
      const taskJson = await taskRes.json();
      expect(taskJson.success).toBe(true);
      expect(taskJson.data.task).toBeDefined();
      expect(taskJson.data.task.title).toBe('Analyze Performance Logs');
      expect(taskJson.data.task.status).toBe('pending');
      expect(taskJson.data.isIdempotentHit).toBe(false);

      createdTaskId = taskJson.data.task.id;
    });

    it('POST /api/manage/tasks/:id/cancel cancels the created task', async () => {
      expect(createdTaskId).toBeDefined();

      const cancelRes = await fetch(`${baseUrl}/api/manage/tasks/${createdTaskId}/cancel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          reason: 'User cancelled task via HTTP API',
        }),
      });

      expect(cancelRes.status).toBe(200);
      const cancelJson = await cancelRes.json();
      expect(cancelJson.success).toBe(true);
      expect(cancelJson.data.task.status).toBe('cancelled');
    });
  });
});
