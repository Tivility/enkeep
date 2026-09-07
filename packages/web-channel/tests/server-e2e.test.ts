import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebChannelServer, validateBinding } from '../src/server.js';
import { InMemoryPlatformWebApi } from './test-platform-api.js';
import { InMemoryRuntimeGateway } from './test-gateway.js';

describe('WebChannelServer E2E HTTP & Multi-Tenancy Integration', () => {
  let server: WebChannelServer;
  let serverUrl: string;
  let serverCsrfToken: string;
  let platformApi: InMemoryPlatformWebApi;
  let runtimeGateway: InMemoryRuntimeGateway;

  beforeAll(async () => {
    // Instantiate test harness explicitly and generate explicit test CSRF token
    platformApi = new InMemoryPlatformWebApi();
    runtimeGateway = new InMemoryRuntimeGateway({ platformApi });
    serverCsrfToken = 'test-suite-explicit-csrf-token-at-least-32-chars-long';

    server = new WebChannelServer({
      platformApi,
      runtimeGateway,
      csrfToken: serverCsrfToken,
      host: '127.0.0.1',
      port: 0, // ephemeral port assigned by OS
      maxBodyBytes: 64 * 1024,
    });

    const info = await server.start();
    serverUrl = info.url;
    expect(info.host).toBe('127.0.0.1');
    expect(info.port).toBeGreaterThan(0);
    expect(info.port).not.toBe(3000);
    expect(info.port).not.toBe(3080);
    expect(info.csrfToken).toBe(serverCsrfToken);
  });

  afterAll(async () => {
    await server.stop();
  });

  describe('Port & Host Safety Safeguards (Strict Allowlist)', () => {
    it('rejects external/LAN IPs and domain bindings (192.168.1.1, localhost.evil)', () => {
      expect(() => validateBinding('192.168.1.1', 3150)).toThrow(/Forbidden host binding/);
      expect(() => validateBinding('localhost.evil', 3150)).toThrow(/Forbidden host binding/);
      expect(() => validateBinding('example.com', 3150)).toThrow(/Forbidden host binding/);
    });

    it('rejects localhost, ::1, 0.0.0.0, and wildcard bindings (allowlist is strictly 127.0.0.1)', () => {
      expect(() => validateBinding('localhost', 3150)).toThrow(/Forbidden host binding/);
      expect(() => validateBinding('::1', 3150)).toThrow(/Forbidden host binding/);
      expect(() => validateBinding('0.0.0.0', 3150)).toThrow(/Forbidden host binding/);
      expect(() => validateBinding('::', 3150)).toThrow(/Forbidden host binding/);
      expect(() => validateBinding('*', 3150)).toThrow(/Forbidden host binding/);
    });

    it('rejects protected reserved ports 3000 and 3080', () => {
      expect(() => validateBinding('127.0.0.1', 3000)).toThrow(/reserved/);
      expect(() => validateBinding('127.0.0.1', 3080)).toThrow(/reserved/);
    });

    it('accepts loopback 127.0.0.1 on safe / ephemeral port', () => {
      expect(() => validateBinding('127.0.0.1', 0)).not.toThrow();
      expect(() => validateBinding('127.0.0.1', 3150)).not.toThrow();
    });
  });

  describe('Server Constructor Safety (Prevent Accidental Test Mock Misuse & Enforce Explicit CSRF Token)', () => {
    it('throws when constructing server without explicit platformApi or runtimeGateway', () => {
      expect(() => new WebChannelServer({ csrfToken: serverCsrfToken } as any)).toThrow(
        /WebChannelServer requires explicit platformApi and runtimeGateway/
      );
      expect(() => new WebChannelServer({ platformApi, csrfToken: serverCsrfToken } as any)).toThrow(
        /WebChannelServer requires explicit platformApi and runtimeGateway/
      );
      expect(() => new WebChannelServer({ runtimeGateway, csrfToken: serverCsrfToken } as any)).toThrow(
        /WebChannelServer requires explicit platformApi and runtimeGateway/
      );
    });

    it('throws when constructing server without explicit csrfToken or with token under 32 characters', () => {
      expect(() => new WebChannelServer({
        platformApi,
        runtimeGateway,
      } as any)).toThrow(/requires an explicit csrfToken with at least 32 characters/);

      expect(() => new WebChannelServer({
        platformApi,
        runtimeGateway,
        csrfToken: 'too-short',
      })).toThrow(/requires an explicit csrfToken with at least 32 characters/);
    });

    it('allows construction when explicit platformApi, runtimeGateway, and valid csrfToken are provided', () => {
      expect(() => new WebChannelServer({
        platformApi,
        runtimeGateway,
        csrfToken: serverCsrfToken,
      })).not.toThrow();
    });
  });

  describe('Security Headers, Cache Control & Static Delivery', () => {
    it('serves SPA index.html with strict security headers (CSP, nosniff, DENY, referrer)', async () => {
      const res = await fetch(`${serverUrl}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');

      // Verify security headers
      expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
      expect(res.headers.get('content-security-policy')).toContain("form-action 'self'");
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');

      const html = await res.text();
      expect(html).toContain('Enkeep Web');
      expect(html).toContain('id="login-form"');
    });

    it('serves static CSS and JS assets with security headers', async () => {
      const cssRes = await fetch(`${serverUrl}/static/style.css`);
      expect(cssRes.status).toBe(200);
      expect(cssRes.headers.get('content-type')).toContain('text/css');
      expect(cssRes.headers.get('x-content-type-options')).toBe('nosniff');

      const jsRes = await fetch(`${serverUrl}/static/app.js`);
      expect(jsRes.status).toBe(200);
      expect(jsRes.headers.get('content-type')).toContain('application/javascript');
    });

    it('serves API endpoints with security headers AND anti-caching headers (no-store, private)', async () => {
      const res = await fetch(`${serverUrl}/api/spaces`);
      expect(res.status).toBe(401);

      expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('cache-control')).toContain('no-store');
      expect(res.headers.get('cache-control')).toContain('no-cache');
      expect(res.headers.get('pragma')).toBe('no-cache');
    });
  });

  describe('CSRF Token Bootstrap & Strict Verification', () => {
    it('returns CSRF token on GET /api/auth/csrf for frontend bootstrapping', async () => {
      const res = await fetch(`${serverUrl}/api/auth/csrf`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.csrfToken).toBe(serverCsrfToken);
    });

    it('rejects state-changing request lacking Origin/Referer/Sec-Fetch-Site and x-enkeep-csrf with 403', async () => {
      const res = await fetch(`${serverUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: 'password123' }),
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('rejects state-changing request with bad CSRF token but valid Origin (bad token + good origin) with 403', async () => {
      const res = await fetch(`${serverUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': 'forged_invalid_csrf_token_wrong_value!',
          'Origin': serverUrl,
        },
        body: JSON.stringify({ username: 'alice', password: 'password123' }),
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('rejects state-changing request with valid CSRF token but bad Origin (good token + bad origin) with 403', async () => {
      const res = await fetch(`${serverUrl}/api/spaces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          'Origin': 'http://evil-attacker-site.com',
        },
        body: JSON.stringify({ name: 'Hacked Space' }),
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('rejects state-changing request with valid CSRF token but spoofed subdomain Origin (127.0.0.1.evil.com) with 403', async () => {
      const res = await fetch(`${serverUrl}/api/spaces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          'Origin': 'http://127.0.0.1.evil.com',
        },
        body: JSON.stringify({ name: 'Hacked Space' }),
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('rejects state-changing request with valid CSRF token but missing Origin/Referer with 403', async () => {
      const res = await fetch(`${serverUrl}/api/spaces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
        },
        body: JSON.stringify({ name: 'Missing Origin Space' }),
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('rejects state-changing request carrying x-csrf-token alias header with 403', async () => {
      const res = await fetch(`${serverUrl}/api/spaces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Csrf-Token': serverCsrfToken,
          'Origin': serverUrl,
        },
        body: JSON.stringify({ name: 'Alias CSRF Space' }),
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('rejects state-changing DELETE/PATCH requests missing CSRF token with 403', async () => {
      const res = await fetch(`${serverUrl}/api/spaces`, {
        method: 'DELETE',
        headers: {
          'Origin': serverUrl,
        },
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('Authentication, Cookie Signing & Multi-Tenancy Isolation', () => {
    let aliceCookie: string;
    let bobCookie: string;
    let aliceSpaceId: string;
    let aliceSessionId: string;

    it('rejects unauthenticated access to /api/spaces with 401', async () => {
      const res = await fetch(`${serverUrl}/api/spaces`);
      expect(res.status).toBe(401);

      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects forged unsigned cookie containing user ID', async () => {
      const res = await fetch(`${serverUrl}/api/spaces`, {
        headers: { 'Cookie': 'enkeep_session=usr_alice123' },
      });
      expect(res.status).toBe(401);

      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects duplicate cookie headers containing the session cookie name', async () => {
      const res = await fetch(`${serverUrl}/api/spaces`, {
        headers: { 'Cookie': `${aliceCookie}; ${aliceCookie}` },
      });
      expect(res.status).toBe(401);

      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('authenticates Alice and returns signed session cookie with SameSite=Strict when carrying valid x-enkeep-csrf and loopback origin', async () => {
      const res = await fetch(`${serverUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          'Origin': serverUrl,
        },
        body: JSON.stringify({ username: 'alice', password: 'password123' }),
      });

      expect(res.status).toBe(200);
      const setCookie = res.headers.get('set-cookie');
      expect(setCookie).toBeDefined();
      expect(setCookie).toContain('enkeep_session=');
      expect(setCookie).toContain('SameSite=Strict');
      expect(setCookie).toContain('HttpOnly');

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.user.username).toBe('alice');
      expect(body.data.session).toBeUndefined(); // Scrubbed UserSession
      aliceCookie = setCookie!.split(';')[0];
    });

    it('authenticates Bob when carrying valid x-enkeep-csrf token and loopback origin', async () => {
      const res = await fetch(`${serverUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          'Origin': serverUrl,
        },
        body: JSON.stringify({ username: 'bob', password: 'password123' }),
      });

      expect(res.status).toBe(200);
      const setCookie = res.headers.get('set-cookie');
      bobCookie = setCookie!.split(';')[0];
    });

    it('rejects payloads exceeding configured body size limits (413 Payload Too Large & OOM defense)', async () => {
      const hugeData = 'A'.repeat(80 * 1024); // 80 KB > 64 KB limit
      const res = await fetch(`${serverUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-Csrf': serverCsrfToken,
          'Origin': serverUrl,
        },
        body: JSON.stringify({ username: 'alice', password: hugeData }),
      });

      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('allows Alice to create space and session', async () => {
      // 1. Create space
      const spaceRes = await fetch(`${serverUrl}/api/spaces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': aliceCookie,
          'X-Enkeep-Csrf': serverCsrfToken,
          'Origin': serverUrl,
        },
        body: JSON.stringify({
          name: 'Alice Research Space',
        }),
      });

      expect(spaceRes.status).toBe(201);
      const spaceBody = await spaceRes.json();
      expect(spaceBody.success).toBe(true);
      aliceSpaceId = spaceBody.data.id;
      expect(aliceSpaceId).toBeDefined();

      // 2. Create session in that space
      const sessRes = await fetch(`${serverUrl}/api/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': aliceCookie,
          'X-Enkeep-Csrf': serverCsrfToken,
          'Origin': serverUrl,
        },
        body: JSON.stringify({
          spaceId: aliceSpaceId,
          title: 'Alice Research Session',
        }),
      });

      expect(sessRes.status).toBe(201);
      const sessBody = await sessRes.json();
      expect(sessBody.success).toBe(true);
      aliceSessionId = sessBody.data.id;
      expect(aliceSessionId).toBeDefined();
    });

    it('allows Alice to send messages and dispatches sanitized response', async () => {
      const msgRes = await fetch(`${serverUrl}/api/sessions/${aliceSessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'a0000000-0000-4000-8000-000000000001',
          'Cookie': aliceCookie,
          'X-Enkeep-Csrf': serverCsrfToken,
          'Origin': serverUrl,
        },
        body: JSON.stringify({
          content: 'Alice: Please generate project report',
        }),
      });

      expect(msgRes.status).toBe(200);
      const body = await msgRes.json();
      expect(body.success).toBe(true);
      expect(body.data.message.content).toBe('Alice: Please generate project report');
      expect(body.data.message.role).toBe('user');
      expect(body.data.message.routeKey).toBeUndefined(); // stripped from public contract
      expect(body.data.accepted).toBe(true);
      expect(body.data.turn).toBeUndefined(); // stripped from public contract
    });

    it('rejects message sending without required Idempotency-Key header', async () => {
      const msgRes = await fetch(`${serverUrl}/api/sessions/${aliceSessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': aliceCookie,
          'X-Enkeep-Csrf': serverCsrfToken,
          'Origin': serverUrl,
        },
        body: JSON.stringify({
          content: 'No idempotency key',
        }),
      });

      expect(msgRes.status).toBe(400);
      const body = await msgRes.json();
      expect(body.success).toBe(false);
      expect(body.error.message).toContain('Idempotency-Key');
    });

    it('rejects message sending with non-UUIDv4 Idempotency-Key', async () => {
      const msgRes = await fetch(`${serverUrl}/api/sessions/${aliceSessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'random-string-not-uuid-v4',
          'Cookie': aliceCookie,
          'X-Enkeep-Csrf': serverCsrfToken,
          'Origin': serverUrl,
        },
        body: JSON.stringify({
          content: 'Bad idempotency key',
        }),
      });

      expect(msgRes.status).toBe(400);
      const body = await msgRes.json();
      expect(body.success).toBe(false);
      expect(body.error.message).toContain('UUID v4');
    });

    it('rejects message sending with unexpected fields or non-object body', async () => {
      const msgRes = await fetch(`${serverUrl}/api/sessions/${aliceSessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'b0000000-0000-4000-8000-000000000001',
          'Cookie': aliceCookie,
          'X-Enkeep-Csrf': serverCsrfToken,
          'Origin': serverUrl,
        },
        body: JSON.stringify({
          content: 'Valid content',
          injectedField: 'malicious',
        }),
      });

      expect(msgRes.status).toBe(400);
      const body = await msgRes.json();
      expect(body.success).toBe(false);
      expect(body.error.message).toContain('Unexpected field');
    });

    it('allows Alice to poll events and view message history', async () => {
      // Fetch messages
      const msgsRes = await fetch(`${serverUrl}/api/sessions/${aliceSessionId}/messages`, {
        headers: { 'Cookie': aliceCookie },
      });
      expect(msgsRes.status).toBe(200);
      const msgsBody = await msgsRes.json();
      expect(msgsBody.data.messages.length).toBeGreaterThanOrEqual(1);

      // Poll events
      const pollRes = await fetch(`${serverUrl}/api/sessions/${aliceSessionId}/events`, {
        headers: { 'Cookie': aliceCookie },
      });
      expect(pollRes.status).toBe(200);
      const pollBody = await pollRes.json();
      expect(pollBody.data.events.length).toBeGreaterThan(0);

      // Verify removed import-history endpoint returns 404 (strictly removed, not supported)
      const importRes = await fetch(`${serverUrl}/api/sessions/${aliceSessionId}/import-history`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': aliceCookie,
          'X-Enkeep-Csrf': serverCsrfToken,
          'Origin': serverUrl,
        },
        body: JSON.stringify({
          messages: [
            { role: 'user', content: 'Prior question 1' },
          ],
        }),
      });
      expect(importRes.status).toBe(404);
    });

    it('returns 404/403 when Bob attempts to access Alice space, session, or messages', async () => {
      // 1. Bob attempts to get Alice session detail
      const getSessionRes = await fetch(`${serverUrl}/api/sessions/${aliceSessionId}`, {
        headers: { 'Cookie': bobCookie },
      });
      expect([403, 404]).toContain(getSessionRes.status);
      const getSessionBody = await getSessionRes.json();
      expect(getSessionBody.success).toBe(false);

      // 2. Bob attempts to read Alice messages
      const getMsgsRes = await fetch(`${serverUrl}/api/sessions/${aliceSessionId}/messages`, {
        headers: { 'Cookie': bobCookie },
      });
      expect([403, 404]).toContain(getMsgsRes.status);

      // 3. Bob attempts to send message to Alice session
      const postMsgRes = await fetch(`${serverUrl}/api/sessions/${aliceSessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'a0000000-0000-4000-8000-000000000002',
          'Cookie': bobCookie,
          'X-Enkeep-Csrf': serverCsrfToken,
          'Origin': serverUrl,
        },
        body: JSON.stringify({ content: 'Bob unauthorized message' }),
      });
      expect([403, 404]).toContain(postMsgRes.status);

      // 4. Bob attempts to import history into Alice session (strictly 404 endpoint not found)
      const postImportRes = await fetch(`${serverUrl}/api/sessions/${aliceSessionId}/import-history`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': bobCookie,
          'X-Enkeep-Csrf': serverCsrfToken,
          'Origin': serverUrl,
        },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Injected' }] }),
      });
      expect(postImportRes.status).toBe(404);

      // 5. Bob attempts to poll Alice session events
      const pollRes = await fetch(`${serverUrl}/api/sessions/${aliceSessionId}/events`, {
        headers: { 'Cookie': bobCookie },
      });
      expect([403, 404]).toContain(pollRes.status);
    });

    it('handles logout and invalidates subsequent authenticated requests with SameSite=Strict header', async () => {
      // Alice logs out
      const logoutRes = await fetch(`${serverUrl}/api/auth/logout`, {
        method: 'POST',
        headers: {
          'Cookie': aliceCookie,
          'X-Enkeep-Csrf': serverCsrfToken,
          'Origin': serverUrl,
        },
      });
      expect(logoutRes.status).toBe(200);

      const logoutSetCookie = logoutRes.headers.get('set-cookie');
      expect(logoutSetCookie).toContain('SameSite=Strict');
      expect(logoutSetCookie).toContain('Max-Age=0');

      // Alice tries to access /api/spaces with the same cookie -> gets 401
      const retryRes = await fetch(`${serverUrl}/api/spaces`, {
        headers: { 'Cookie': aliceCookie },
      });
      expect(retryRes.status).toBe(401);
    });

    it('rejects malformed path parameters, control chars, oversized identifiers and content', async () => {
      // 1. Path traversal / %2F in sessionId
      const res1 = await fetch(`${serverUrl}/api/sessions/%2E%2E%2Fattack/messages`, {
        headers: { 'Cookie': bobCookie },
      });
      expect([400, 404]).toContain(res1.status);

      // 2. Control characters (%00)
      const res2 = await fetch(`${serverUrl}/api/sessions/ses_bob%00null/messages`, {
        headers: { 'Cookie': bobCookie },
      });
      expect([400, 404]).toContain(res2.status);

      // 3. Oversized identifier (> 128 chars)
      const longId = 'b'.repeat(129);
      const res3 = await fetch(`${serverUrl}/api/sessions/${longId}/messages`, {
        headers: { 'Cookie': bobCookie },
      });
      expect([400, 404]).toContain(res3.status);

      // Create Bob space & session for valid auth context
      const spaceRes = await fetch(`${serverUrl}/api/spaces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': bobCookie,
          'X-Enkeep-Csrf': serverCsrfToken,
          'Origin': serverUrl,
        },
        body: JSON.stringify({ name: 'Bob Validation Space' }),
      });
      const spaceBody = await spaceRes.json();
      const bobSpaceId = spaceBody.data.id;

      const sessRes = await fetch(`${serverUrl}/api/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': bobCookie,
          'X-Enkeep-Csrf': serverCsrfToken,
          'Origin': serverUrl,
        },
        body: JSON.stringify({ spaceId: bobSpaceId, title: 'bob_tab' }),
      });
      const sessBody = await sessRes.json();
      const bobSessionId = sessBody.data.id;

      // 4. Oversized content (> 64 KiB)
      const res4 = await fetch(`${serverUrl}/api/sessions/${bobSessionId}/messages`, {
        method: 'POST',
        headers: {
          'Cookie': bobCookie,
          'X-Enkeep-Csrf': serverCsrfToken,
          'Origin': serverUrl,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'a0000000-0000-4000-8000-000000000004',
        },
        body: JSON.stringify({ content: 'x'.repeat(65537) }),
      });
      expect([400, 413]).toContain(res4.status);
    });

    it('attaches full security headers and cache control headers even on 500 internal server error fallback', async () => {
      // Create a web channel server with a mock platformApi that throws an unexpected unhandled error
      const brokenPlatformApi = {
        ...platformApi,
        authenticateCookie: async () => {
          throw new Error('Unexpected database failure in auth');
        },
      };

      const brokenServer = new WebChannelServer({
        platformApi: brokenPlatformApi,
        runtimeGateway,
        csrfToken: serverCsrfToken,
        port: 0,
      });

      const brokenInfo = await brokenServer.start();
      try {
        const res = await fetch(`${brokenInfo.url}/api/spaces`, {
          headers: {
            'Cookie': aliceCookie,
          },
        });

        expect(res.status).toBe(500);
        expect(res.headers.get('content-security-policy')).toBeDefined();
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('x-frame-options')).toBe('DENY');
        expect(['strict-origin-when-cross-origin', 'no-referrer']).toContain(res.headers.get('referrer-policy'));
        expect(res.headers.get('cache-control')).toContain('no-store');
      } finally {
        await brokenServer.stop();
      }
    });
  });
});
