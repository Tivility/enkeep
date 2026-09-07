import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { request as httpRequest } from 'node:http';
import { provisionFixtures } from '@enkeep/platform-auth';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import {
  PlatformServer,
  SqliteWebMessageStore,
  validateMessageContent,
} from '../src/index.js';
import { TestOnlyRuntimeGateway } from './test-runtime-gateway.js';

describe('Comprehensive Platform Routes, Events, Limits & Strict CSRF Integration', () => {
  let server: PlatformServer;
  let baseUrl: string;
  let aliceCookie: string;
  let bobCookie: string;
  let aliceSpaceId: string;
  let sessionId: string;
  const testCsrfToken = 'routes-api-csrf-token-32-chars-long-secure!';

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
      cookieSecret: 'routes-api-secret-key-32-chars-long!',
      csrfToken: testCsrfToken,
      runtimeGateway,
      limits: {
        maxBodySizeBytes: 10 * 1024, // 10 KB for testing limit
      },
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

    // Login as Alice
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ username: 'alice', password: 'AlicePassword123!' }),
    });
    const loginJson = await loginRes.json();
    if (!loginJson.data) {
      throw new Error(`Login failed in beforeAll: status=${loginRes.status}, body=${JSON.stringify(loginJson)}`);
    }
    aliceCookie = loginRes.headers.get('set-cookie')!;

    // Login as Bob (regular user)
    const bobLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ username: 'bob', password: 'BobPassword123!' }),
    });
    const bobLoginJson = await bobLoginRes.json();
    if (!bobLoginJson.data) {
      throw new Error(`Bob login failed in beforeAll: status=${bobLoginRes.status}, body=${JSON.stringify(bobLoginJson)}`);
    }
    bobCookie = bobLoginRes.headers.get('set-cookie')!;

    // Create session
    const sessRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ spaceId: aliceSpaceId, peerId: 'peer-main' }),
    });
    const sessJson = await sessRes.json();
    if (!sessJson.data) {
      throw new Error(`Create session failed in beforeAll: status=${sessRes.status}, body=${JSON.stringify(sessJson)}`);
    }
    sessionId = sessJson.data.id;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('GET /api/spaces/:spaceId/sessions should list sessions for space', async () => {
    const res = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/sessions`, {
      headers: { Cookie: aliceCookie },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.length).toBeGreaterThanOrEqual(1);
    expect(json.data[0].spaceId).toBe(aliceSpaceId);
  });

  it('POST /api/sessions/:sessionId/import-history is removed and returns 404 to prevent history fabrication', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/import-history`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        messages: [
          { role: 'assistant', content: 'Fabricated assistant response' },
        ],
      }),
    });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('NOT_FOUND');
  });

  it('POST /api/sessions/:sessionId/messages should trigger a message turn', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'a0000000-0000-4000-8000-000000000001',
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ content: 'Followup instruction' }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.accepted).toBe(true);
    expect(json.data.message).toBeDefined();
    expect(json.data.message.content).toBe('Followup instruction');
    expect(json.data.isDuplicate).toBe(false);

    // Check session-scoped turn status endpoint
    const statusRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn/current`, {
      headers: { Cookie: aliceCookie },
    });
    expect(statusRes.status).toBe(200);
    const statusJson = await statusRes.json();
    expect(['queued', 'running', 'completed']).toContain(statusJson.data.status);
  });

  it('GET /api/sessions/:sessionId/events should support incremental event polling with cursor', async () => {
    const poll1 = await fetch(`${baseUrl}/api/sessions/${sessionId}/events`, {
      headers: { Cookie: aliceCookie },
    });
    expect(poll1.status).toBe(200);
    const json1 = await poll1.json();
    expect(json1.success).toBe(true);
    expect(json1.data.events).toBeInstanceOf(Array);
    const cursor = json1.data.nextCursor;

    // Send a new message
    await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'a0000000-0000-4000-8000-000000000002',
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ content: 'Message for polling test' }),
    });

    // Poll again using cursor
    const poll2 = await fetch(`${baseUrl}/api/sessions/${sessionId}/events?cursor=${encodeURIComponent(cursor)}`, {
      headers: { Cookie: aliceCookie },
    });
    const json2 = await poll2.json();
    expect(json2.success).toBe(true);
    expect(json2.data.events.length).toBeGreaterThanOrEqual(1);
  });

  it('POST /api/sessions/:sessionId/turn/cancel-current should cancel a turn', async () => {
    // Dispatch a turn
    const msgRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'a0000000-0000-4000-8000-000000000003',
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ content: 'Long running task to cancel' }),
    });
    expect(msgRes.status).toBe(200);

    // Cancel turn via session-scoped endpoint
    const cancelRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn/cancel-current`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
    });
    expect(cancelRes.status).toBe(200);
    const cancelJson = await cancelRes.json();
    expect(cancelJson.success).toBe(true);
  });

  it('Payload exceeding maxBodySizeBytes should return 413 Payload Too Large', async () => {
    const hugeContent = 'x'.repeat(15 * 1024); // 15 KB > 10 KB limit
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'a0000000-0000-4000-8000-000000000004',
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ content: hugeContent }),
    });

    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('Malformed JSON body should return 400 Bad Request', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'a0000000-0000-4000-8000-000000000005',
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: '{"invalidJson',
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it('CSRF rejection when missing Origin, Referer, and X-Enkeep-CSRF header', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: aliceCookie,
        // No Origin, no Referer, no X-Enkeep-CSRF
      },
      body: JSON.stringify({ content: 'CSRF attack without origin or token' }),
    });

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('CSRF_VIOLATION');
  });

  it('CSRF rejection for forged / invalid X-Enkeep-CSRF header (constant-time check mismatch)', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': 'forged-invalid-csrf-token-32-chars-long!',
        Origin: baseUrl,
        Cookie: aliceCookie,
      },
      body: JSON.stringify({ content: 'Forged token attempt' }),
    });

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('CSRF_VIOLATION');
  });

  it('CSRF rejection for forbidden foreign Origin', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: 'http://malicious-site.com',
        Cookie: aliceCookie,
      },
      body: JSON.stringify({ content: 'CSRF attack payload' }),
    });

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('CSRF_VIOLATION');
  });

  it('CSRF rejection for spoofed subdomain Origin (http://127.0.0.1.evil.com)', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: 'http://127.0.0.1.evil.com',
        Cookie: aliceCookie,
      },
      body: JSON.stringify({ content: 'Subdomain spoof attempt' }),
    });

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('CSRF_VIOLATION');
  });

  it('GET / or /index.html should serve SPA HTML fallback', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('rejects missing or invalid Idempotency-Key format with 400 Validation Error', async () => {
    // 1. Missing header
    const missingRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
        Cookie: aliceCookie,
      },
      body: JSON.stringify({ content: 'Missing key test' }),
    });
    expect(missingRes.status).toBe(400);
    const missingJson = await missingRes.json();
    expect(missingJson.success).toBe(false);
    expect(missingJson.error.message).toContain('Missing required Idempotency-Key');

    // 2. Invalid non-UUID format
    const invalidRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        'Idempotency-Key': 'not-a-valid-uuid-v4',
        Origin: baseUrl,
        Cookie: aliceCookie,
      },
      body: JSON.stringify({ content: 'Invalid key test' }),
    });
    expect(invalidRes.status).toBe(400);
    const invalidJson = await invalidRes.json();
    expect(invalidJson.success).toBe(false);
    expect(invalidJson.error.code).toBe('VALIDATION_ERROR');
    expect(invalidJson.error.message).toContain('Expected exact canonical lowercase UUID v4');

    // 3. Comma / duplicate header
    const dupRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        'Idempotency-Key': 'd8f7b57b-7df1-4a11-b0db-6e6912345678, d8f7b57b-7df1-4a11-b0db-6e6912345678',
        Origin: baseUrl,
        Cookie: aliceCookie,
      },
      body: JSON.stringify({ content: 'Dup key test' }),
    });
    expect(dupRes.status).toBe(400);
    const dupJson = await dupRes.json();
    expect(dupJson.success).toBe(false);
    expect(dupJson.error.message).toContain('Duplicate or comma-separated Idempotency-Key');
  });

  it('deduplicates retried requests with same Idempotency-Key and returns identical dispatch payload', async () => {
    const key = 'd8f7b57b-7df1-4a11-b0db-6e6912345678';

    // First request
    const firstRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        'Idempotency-Key': key,
        Origin: baseUrl,
        Cookie: aliceCookie,
      },
      body: JSON.stringify({ content: 'Message with idempotency key' }),
    });

    expect(firstRes.status).toBe(200);
    const firstJson = await firstRes.json();
    expect(firstJson.success).toBe(true);
    const firstMessageId = firstJson.data.message.id;

    // Retry request with same key
    const retryRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        'Idempotency-Key': key,
        Origin: baseUrl,
        Cookie: aliceCookie,
      },
      body: JSON.stringify({ content: 'Message with idempotency key' }),
    });

    expect(retryRes.status).toBe(200);
    const retryJson = await retryRes.json();
    expect(retryJson.success).toBe(true);
    expect(retryJson.data.message.id).toBe(firstMessageId);
    expect(retryJson.data.isDuplicate).toBe(true);
  });

  it('verifies Centralized Security Headers & Cache-Control on API responses', async () => {
    const res = await fetch(`${baseUrl}/api/v1/auth/csrf`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    );
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('verifies Security Headers & Cache-Control on Static and SPA HTML responses', async () => {
    // SPA Index HTML
    const spaRes = await fetch(`${baseUrl}/`);
    expect(spaRes.status).toBe(200);
    expect(spaRes.headers.get('content-security-policy')).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    );
    expect(spaRes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(spaRes.headers.get('x-frame-options')).toBe('DENY');
    expect(spaRes.headers.get('cache-control')).toContain('no-cache');

    // Static Asset
    const staticRes = await fetch(`${baseUrl}/static/style.css`);
    if (staticRes.status === 200) {
      expect(staticRes.headers.get('content-security-policy')).toBe(
        "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
      );
      expect(staticRes.headers.get('x-content-type-options')).toBe('nosniff');
      expect(staticRes.headers.get('cache-control')).toContain('public');
    }
  });

  it('rejects foreign Host header before URL routing with 403', async () => {
    const port = new URL(baseUrl).port;
    const res = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: Number(port),
          path: '/api/health',
          method: 'GET',
          headers: {
            Host: 'evil.com',
          },
        },
        (response) => {
          let data = '';
          response.on('data', (chunk) => (data += chunk));
          response.on('end', () => resolve({ statusCode: response.statusCode || 0, body: data }));
        }
      );
      req.on('error', reject);
      req.end();
    });

    expect(res.statusCode).toBe(403);
    const json = JSON.parse(res.body);
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('CSRF_VIOLATION');
    expect(json.error.message).toContain('Forbidden or untrusted Host header');
  });

  it('rejects malformed, path traversal, control character, and oversized resource IDs with 400', async () => {
    // 1. Path traversal / encoded slashes
    const res1 = await fetch(`${baseUrl}/api/sessions/%2E%2E%2Fevil/messages`, {
      method: 'GET',
      headers: { Cookie: aliceCookie },
    });
    expect(res1.status).toBe(400);
    const json1 = await res1.json();
    expect(json1.error.code).toBe('VALIDATION_ERROR');

    // 2. Control characters (%00 null byte)
    const res2 = await fetch(`${baseUrl}/api/sessions/ses_alice%00null/messages`, {
      method: 'GET',
      headers: { Cookie: aliceCookie },
    });
    expect(res2.status).toBe(400);
    const json2 = await res2.json();
    expect(json2.error.code).toBe('VALIDATION_ERROR');

    // 3. Oversized ID (> 128 chars)
    const longId = 'a'.repeat(129);
    const res3 = await fetch(`${baseUrl}/api/sessions/${longId}/messages`, {
      method: 'GET',
      headers: { Cookie: aliceCookie },
    });
    expect(res3.status).toBe(400);
    const json3 = await res3.json();
    expect(json3.error.code).toBe('VALIDATION_ERROR');
    expect(json3.error.message).toContain('Expected 1 to 128 characters');
  });

  it('rejects oversized message content (> 64 KiB) and invalid attachments with 400', async () => {
    // 1. Validator directly rejects content exceeding 64 KiB
    expect(() => validateMessageContent('x'.repeat(65537))).toThrow(/exceeds maximum allowed length/);

    // 2. Too many attachments (> 10)
    const tooManyAttachments = Array.from({ length: 11 }, (_, i) => ({ name: `file_${i}.txt` }));
    const res2 = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'a0000000-0000-4000-8000-000000000006',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
        Cookie: aliceCookie,
      },
      body: JSON.stringify({ content: 'Hello with too many files', attachments: tooManyAttachments }),
    });
    expect(res2.status).toBe(400);
    const json2 = await res2.json();
    expect(json2.error.code).toBe('VALIDATION_ERROR');
    expect(json2.error.message).toContain('exceeds limit of 10 attachments');
  });

  it('strictly validates limit query parameter on GET /messages (/^[1-9]\\d{0,2}$/ 1..100)', async () => {
    const invalidLimits = ['0', '101', '05', 'abc', '-1', '1.5', 'NaN'];
    for (const lim of invalidLimits) {
      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages?limit=${encodeURIComponent(lim)}`, {
        method: 'GET',
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('VALIDATION_ERROR');
      expect(json.error.message).toContain('Invalid limit query parameter');
    }

    const validRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages?limit=50`, {
      method: 'GET',
      headers: { Cookie: aliceCookie },
    });
    expect(validRes.status).toBe(200);
  });

  it('strictly validates create session payload (strict JSON object, exact keys, executionMode enum)', async () => {
    // 1. Extra unexpected field
    const res1 = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
        Cookie: aliceCookie,
      },
      body: JSON.stringify({ spaceId: aliceSpaceId, unexpectedField: true }),
    });
    expect(res1.status).toBe(400);
    const json1 = await res1.json();
    expect(json1.error.code).toBe('VALIDATION_ERROR');
    expect(json1.error.message).toContain('Unexpected field');

    // 2. Invalid executionMode enum
    const res2 = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
        Cookie: aliceCookie,
      },
      body: JSON.stringify({ spaceId: aliceSpaceId, executionMode: 'invalid_mode' }),
    });
    expect(res2.status).toBe(400);
    const json2 = await res2.json();
    expect(json2.error.code).toBe('VALIDATION_ERROR');
    expect(json2.error.message).toContain('Invalid executionMode');

    // 3. Valid executionMode
    const res3 = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
        Cookie: aliceCookie,
      },
      body: JSON.stringify({ spaceId: aliceSpaceId, executionMode: 'container' }),
    });
    expect(res3.status).toBe(201);
    const json3 = await res3.json();
    expect(json3.success).toBe(true);
  });

  it('strictly validates create space payload (exact own keys {name,folder,executionMode}, rejects userId, tenantId, mode, unknown)', async () => {
    // 1. Rejected with userId
    const resUserId = await fetch(`${baseUrl}/api/spaces`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
        Cookie: aliceCookie,
      },
      body: JSON.stringify({ name: 'Space 1', folder: 'space-1', userId: 'user-123' }),
    });
    expect(resUserId.status).toBe(400);
    const jsonUserId = await resUserId.json();
    expect(jsonUserId.error.code).toBe('VALIDATION_ERROR');
    expect(jsonUserId.error.message).toContain('Unexpected field "userId"');

    // 2. Rejected with tenantId
    const resTenantId = await fetch(`${baseUrl}/api/spaces`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
        Cookie: aliceCookie,
      },
      body: JSON.stringify({ name: 'Space 2', folder: 'space-2', tenantId: 'tenant-123' }),
    });
    expect(resTenantId.status).toBe(400);
    const jsonTenantId = await resTenantId.json();
    expect(jsonTenantId.error.code).toBe('VALIDATION_ERROR');
    expect(jsonTenantId.error.message).toContain('Unexpected field "tenantId"');

    // 3. Rejected with mode (legacy key)
    const resMode = await fetch(`${baseUrl}/api/spaces`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
        Cookie: aliceCookie,
      },
      body: JSON.stringify({ name: 'Space 3', folder: 'space-3', mode: 'container' }),
    });
    expect(resMode.status).toBe(400);
    const jsonMode = await resMode.json();
    expect(jsonMode.error.code).toBe('VALIDATION_ERROR');
    expect(jsonMode.error.message).toContain('Unexpected field "mode"');

    // 4. Rejected with empty name
    const resEmptyName = await fetch(`${baseUrl}/api/spaces`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
        Cookie: aliceCookie,
      },
      body: JSON.stringify({ name: '', folder: 'space-4' }),
    });
    expect(resEmptyName.status).toBe(400);

    // 5. Rejected with missing folder
    const resMissingFolder = await fetch(`${baseUrl}/api/spaces`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
        Cookie: aliceCookie,
      },
      body: JSON.stringify({ name: 'Valid Name' }),
    });
    expect(resMissingFolder.status).toBe(400);

    // 6. Valid creation succeeds
    const resValid = await fetch(`${baseUrl}/api/spaces`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
        Cookie: aliceCookie,
      },
      body: JSON.stringify({ name: 'Valid Space', folder: 'valid-folder', executionMode: 'container' }),
    });
    expect(resValid.status).toBe(201);
    const jsonValid = await resValid.json();
    expect(jsonValid.success).toBe(true);
    expect(jsonValid.data.name).toBe('Valid Space');
    expect(jsonValid.data.folder).toBe('valid-folder');
  });

  it('strictly validates send message payload (exact own keys {content,attachments,metadata})', async () => {
    const resUnknown = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'a0000000-0000-4000-8000-000000000099',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
        Cookie: aliceCookie,
      },
      body: JSON.stringify({ content: 'Hello', extraMsgKey: 'forbidden' }),
    });
    expect(resUnknown.status).toBe(400);
    const jsonUnknown = await resUnknown.json();
    expect(jsonUnknown.error.code).toBe('VALIDATION_ERROR');
    expect(jsonUnknown.error.message).toContain('Unexpected field "extraMsgKey"');
  });

  it('exact /api/admin guard returns 401 unauth, 403 non-admin, and 404 admin', async () => {
    // 1. Unauthenticated request -> 401
    const unauthRes = await fetch(`${baseUrl}/api/admin`);
    expect(unauthRes.status).toBe(401);
    const unauthJson = await unauthRes.json();
    expect(unauthJson.success).toBe(false);
    expect(unauthJson.error.code).toBe('UNAUTHORIZED');

    // 2. Non-admin (Bob) request -> 403
    const bobRes = await fetch(`${baseUrl}/api/admin`, {
      headers: { Cookie: bobCookie },
    });
    expect(bobRes.status).toBe(403);
    const bobJson = await bobRes.json();
    expect(bobJson.success).toBe(false);
    expect(bobJson.error.code).toBe('FORBIDDEN');

    // 3. Admin (Alice) request -> 404 (Admin endpoint not found)
    const aliceRes = await fetch(`${baseUrl}/api/admin`, {
      headers: { Cookie: aliceCookie },
    });
    expect(aliceRes.status).toBe(404);
    const aliceJson = await aliceRes.json();
    expect(aliceJson.success).toBe(false);
    expect(aliceJson.error.code).toBe('NOT_FOUND');
  });

  it('GET /api/dshadow returns 404 and is not caught by DSH prefix guard', async () => {
    // Unauthenticated request to /api/dshadow should return 404 NOT_FOUND, not 401 UNAUTHORIZED from /api/dsh guard
    const unauthRes = await fetch(`${baseUrl}/api/dshadow`);
    expect(unauthRes.status).toBe(404);
    const unauthJson = await unauthRes.json();
    expect(unauthJson.success).toBe(false);
    expect(unauthJson.error.code).toBe('NOT_FOUND');

    // Admin request to /api/dshadow should also return 404 NOT_FOUND, not 200 from DSH privileged handler
    const aliceRes = await fetch(`${baseUrl}/api/dshadow`, {
      headers: { Cookie: aliceCookie },
    });
    expect(aliceRes.status).toBe(404);
    const aliceJson = await aliceRes.json();
    expect(aliceJson.success).toBe(false);
    expect(aliceJson.error.code).toBe('NOT_FOUND');
  });

  it('allows admin to create host mode space, forbids regular user, and enforces session mode inheritance', async () => {
    // 1. POST /api/spaces with executionMode: 'host' as Alice (Admin) succeeds
    const spaceRes = await fetch(`${baseUrl}/api/spaces`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
        Cookie: aliceCookie,
      },
      body: JSON.stringify({ name: 'Host Mode Space', folder: 'host-folder', executionMode: 'host' }),
    });
    expect(spaceRes.status).toBe(201);
    const spaceJson = await spaceRes.json();
    expect(spaceJson.success).toBe(true);
    expect(spaceJson.data.executionMode).toBe('host');
    const hostSpaceId = spaceJson.data.id;

    // 2. POST /api/spaces with executionMode: 'host' as Bob (User) returns 403 Forbidden
    const bobSpaceRes = await fetch(`${baseUrl}/api/spaces`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
        Cookie: bobCookie,
      },
      body: JSON.stringify({ name: 'Bob Host Space', folder: 'bob-host-folder', executionMode: 'host' }),
    });
    expect(bobSpaceRes.status).toBe(403);
    const bobSpaceJson = await bobSpaceRes.json();
    expect(bobSpaceJson.success).toBe(false);
    expect(bobSpaceJson.error.code).toBe('FORBIDDEN');

    // 3. POST /api/sessions for host space inherits host executionMode
    const hostSessRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
        Cookie: aliceCookie,
      },
      body: JSON.stringify({ spaceId: hostSpaceId, title: 'Host Session' }),
    });
    expect(hostSessRes.status).toBe(201);
    const hostSessJson = await hostSessRes.json();
    expect(hostSessJson.success).toBe(true);

    // 4. POST /api/sessions on container space with mismatched executionMode: 'host' returns 400
    const mismatchRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
        Cookie: aliceCookie,
      },
      body: JSON.stringify({ spaceId: aliceSpaceId, executionMode: 'host' }),
    });
    expect(mismatchRes.status).toBe(400);
    const mismatchJson = await mismatchRes.json();
    expect(mismatchJson.success).toBe(false);
    expect(mismatchJson.error.code).toBe('VALIDATION_ERROR');
    expect(mismatchJson.error.message).toContain('Session executionMode cannot override or mismatch space executionMode');
  });
});
