import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { provisionFixtures } from '@enkeep/platform-auth';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import {
  PlatformServer,
  SqliteWebMessageStore,
} from '../src/index.js';
import { TestOnlyRuntimeGateway } from './test-runtime-gateway.js';

describe('Auth & Session API Integration', () => {
  let server: PlatformServer;
  let baseUrl: string;
  let db: DatabaseSync;
  let aliceId: string;
  let bobId: string;
  const testCsrfToken = 'test-suite-auth-csrf-token-32-chars-long!';

  beforeAll(async () => {
    db = new DatabaseSync(':memory:');
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
      cookieSecret: 'test-secret-key-32-chars-long-super-safe!',
      csrfToken: testCsrfToken,
      runtimeGateway,
    });

    const addr = await server.start();
    baseUrl = addr.url;

    // Provision fixtures: Alice (admin), Bob (user), Charlie (disabled)
    const fixtures = await provisionFixtures(server.storage, server.authService, {
      adminUsername: 'alice',
      adminPassword: 'AliceSecurePassword123!',
      userUsername: 'bob',
      userPassword: 'BobSecurePassword123!',
      disabledUsername: 'charlie_disabled',
      disabledPassword: 'CharlieDisabledPassword123!',
    });
    aliceId = fixtures.admin.id;
    bobId = fixtures.user.id;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('GET /api/health should return ok without authentication', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.status).toBe('ok');
    expect(json.data.service).toBe('enkeep-platform-server');
  });

  it('GET /api/v1/auth/csrf and /api/auth/csrf should return CSRF token for frontend bootstrap', async () => {
    const res1 = await fetch(`${baseUrl}/api/v1/auth/csrf`);
    expect(res1.status).toBe(200);
    const json1 = await res1.json();
    expect(json1.success).toBe(true);
    expect(json1.data.csrfToken).toBe(testCsrfToken);

    const res2 = await fetch(`${baseUrl}/api/auth/csrf`);
    expect(res2.status).toBe(200);
    const json2 = await res2.json();
    expect(json2.success).toBe(true);
    expect(json2.data.csrfToken).toBe(testCsrfToken);
  });

  it('POST /api/auth/login should authenticate Alice and return signed cookie with SameSite=Strict', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        username: 'alice',
        password: 'AliceSecurePassword123!',
      }),
    });

    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain('enkeep_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(typeof json.data.user.id).toBe('string');
    expect(json.data.user.id.length).toBeGreaterThan(0);
    expect(json.data.user.username).toBe('alice');
    expect(json.data.user.role).toBe('admin');
    expect(json.data.user.status).toBe('active');
    expect(json.data.user.passwordHash).toBeUndefined();
    expect(json.data.user.password_hash).toBeUndefined();
    expect(json.data.session).toBeUndefined();
    expect(json.data.token).toBeUndefined();
  });

  it('POST /api/auth/login should authenticate Bob and set SameSite=Strict', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        username: 'bob',
        password: 'BobSecurePassword123!',
      }),
    });

    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('SameSite=Strict');

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(typeof json.data.user.id).toBe('string');
    expect(json.data.user.id.length).toBeGreaterThan(0);
    expect(json.data.user.username).toBe('bob');
    expect(json.data.user.role).toBe('user');
    expect(json.data.user.status).toBe('active');
    expect(json.data.user.passwordHash).toBeUndefined();
    expect(json.data.session).toBeUndefined();
  });

  it('POST /api/auth/login should reject disabled user Charlie with unified 401 Unauthorized', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        username: 'charlie_disabled',
        password: 'CharlieDisabledPass123!',
      }),
    });

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('UNAUTHORIZED');
    expect(json.error.message).toBe('Invalid username or password');
  });

  it('POST /api/auth/login should reject invalid credentials', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        username: 'alice',
        password: 'WrongPassword!',
      }),
    });

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('UNAUTHORIZED');
  });

  it('POST /api/auth/login should reject username with whitespace', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        username: ' alice ',
        password: 'AliceSecurePassword123!',
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(json.error.message).toContain('Invalid username');
  });

  it('POST /api/auth/login should reject unknown extra body fields', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        username: 'alice',
        password: 'AliceSecurePassword123!',
        extraField: true,
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(json.error.message).toContain('Unexpected field');
  });

  it('POST /api/auth/login should reject legacy alias x-csrf-token header', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        username: 'alice',
        password: 'AliceSecurePassword123!',
      }),
    });

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('CSRF_VIOLATION');
  });

  it('GET /api/auth/me should return current user when authenticated with cookie', async () => {
    // Login as Bob
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        username: 'bob',
        password: 'BobSecurePassword123!',
      }),
    });
    const cookie = loginRes.headers.get('set-cookie')!;

    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: cookie },
    });
    expect(meRes.status).toBe(200);
    const meJson = await meRes.json();
    expect(meJson.success).toBe(true);
    expect(typeof meJson.data.user.id).toBe('string');
    expect(meJson.data.user.id.length).toBeGreaterThan(0);
    expect(meJson.data.user.username).toBe('bob');
    expect(meJson.data.user.role).toBe('user');
    expect(meJson.data.user.status).toBe('active');
    expect(meJson.data.user.passwordHash).toBeUndefined();
    expect(meJson.data.session).toBeUndefined();
  });

  it('GET /api/auth/me should return 401 when unauthenticated', async () => {
    const res = await fetch(`${baseUrl}/api/auth/me`);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('UNAUTHORIZED');
  });

  it('GET /api/auth/me should reject tampered signed cookie', async () => {
    // Login as Alice
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        username: 'alice',
        password: 'AliceSecurePassword123!',
      }),
    });
    const cookie = loginRes.headers.get('set-cookie')!;
    // Tamper with cookie signature
    const rawCookieVal = cookie.split(';')[0];
    const tamperedCookie = rawCookieVal + 'tampered';

    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: tamperedCookie },
    });
    expect(meRes.status).toBe(401);
  });

  it('POST /api/auth/logout should revoke session and clear cookie with SameSite=Strict', async () => {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        username: 'bob',
        password: 'BobSecurePassword123!',
      }),
    });
    const cookie = loginRes.headers.get('set-cookie')!;

    const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
    });
    expect(logoutRes.status).toBe(200);
    const logoutCookie = logoutRes.headers.get('set-cookie')!;
    expect(logoutCookie).toContain('Max-Age=0');
    expect(logoutCookie).toContain('SameSite=Strict');

    // Subsequent call with same cookie should be unauthorized
    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: cookie },
    });
    expect(meRes.status).toBe(401);
  });

  describe('Cookie Security & Duplicate Cookie Injection Rejection', () => {
    it('rejects request when Cookie header contains duplicate enkeep_session names', async () => {
      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({
          username: 'bob',
          password: 'BobSecurePassword123!',
        }),
      });
      const validCookie = loginRes.headers.get('set-cookie')!.split(';')[0];
      const duplicateCookie = `${validCookie}; enkeep_session=attacker_injected_cookie`;

      const meRes = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Cookie: duplicateCookie },
      });
      expect(meRes.status).toBe(401);
      const json = await meRes.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('UNAUTHORIZED');
    });
  });

  describe('Failed Login Rate Limiter (Brute-force protection)', () => {
    it('rate limits after excessive failed login attempts with HTTP 429 RATE_LIMITED', async () => {
      // Create dedicated test server to avoid IP rate limit interference
      const isolatedDb = new DatabaseSync(':memory:');
      const isolatedStorage = new SqlitePlatformStorage(isolatedDb);
      const isolatedMessageStore = new SqliteWebMessageStore(isolatedDb);
      const isolatedRuntimeGateway = new TestOnlyRuntimeGateway({
        storage: isolatedStorage,
        messageStore: isolatedMessageStore,
        autoReply: true,
      });

      const isolatedServer = new PlatformServer({
        database: isolatedDb,
        host: '127.0.0.1',
        port: 0,
        cookieSecret: 'test-secret-key-32-chars-long-super-safe!',
        csrfToken: testCsrfToken,
        runtimeGateway: isolatedRuntimeGateway,
      });

      const isolatedAddr = await isolatedServer.start();
      const isolatedUrl = isolatedAddr.url;

      try {
        const randomUser = `attacker_${Date.now()}`;

        // Perform 5 failed login attempts
        for (let i = 0; i < 5; i++) {
          const res = await fetch(`${isolatedUrl}/api/auth/login`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Enkeep-CSRF': testCsrfToken,
              Origin: isolatedUrl,
            },
            body: JSON.stringify({
              username: randomUser,
              password: 'WrongPassword!',
            }),
          });
          expect(res.status).toBe(401);
        }

        // 6th attempt should be rate limited (429)
        const rateLimitedRes = await fetch(`${isolatedUrl}/api/auth/login`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Enkeep-CSRF': testCsrfToken,
            Origin: isolatedUrl,
          },
          body: JSON.stringify({
            username: randomUser,
            password: 'WrongPassword!',
          }),
        });

        expect(rateLimitedRes.status).toBe(429);
        const json = await rateLimitedRes.json();
        expect(json.success).toBe(false);
        expect(json.error.code).toBe('RATE_LIMITED');
        expect(json.error.message).toContain('Too many failed login attempts');
      } finally {
        await isolatedServer.stop();
      }
    });
  });

  describe('CSRF & Origin AND Semantics Enforcement Matrix', () => {
    it('rejects POST when CSRF token is bad but Origin is good (bad token + good origin)', async () => {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': 'wrong-token-value-with-32-chars-long!',
          Origin: baseUrl,
        },
        body: JSON.stringify({ username: 'alice', password: 'AliceSecurePassword123!' }),
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('CSRF_VIOLATION');
    });

    it('rejects POST when CSRF token is good but Origin is foreign (good token + bad origin)', async () => {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: 'http://malicious-attacker.com',
        },
        body: JSON.stringify({ username: 'alice', password: 'AliceSecurePassword123!' }),
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('CSRF_VIOLATION');
    });

    it('rejects POST when CSRF token is good but Origin is spoofed subdomain (127.0.0.1.evil.com)', async () => {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: 'http://127.0.0.1.evil.com',
        },
        body: JSON.stringify({ username: 'alice', password: 'AliceSecurePassword123!' }),
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('CSRF_VIOLATION');
    });

    it('rejects POST when CSRF token is missing even if Origin is valid (missing token + good origin)', async () => {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: baseUrl,
        },
        body: JSON.stringify({ username: 'alice', password: 'AliceSecurePassword123!' }),
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('CSRF_VIOLATION');
    });

    it('rejects POST when Origin is missing even if CSRF token is valid (good token + missing origin)', async () => {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
        },
        body: JSON.stringify({ username: 'alice', password: 'AliceSecurePassword123!' }),
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('CSRF_VIOLATION');
    });

    it('allows POST when BOTH CSRF token AND Origin are valid (good token + good origin)', async () => {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({ username: 'alice', password: 'AliceSecurePassword123!' }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.user.username).toBe('alice');
    });

    it('fails closed with 503 SERVICE_UNAVAILABLE when storage auditLogs countRecentFailures throws', async () => {
      const originalCountFn = server.storage.auditLogs?.countRecentFailures;
      if (server.storage.auditLogs) {
        server.storage.auditLogs.countRecentFailures = async () => {
          throw new Error('Database disk I/O failure during audit log query');
        };
      }

      try {
        const res = await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Enkeep-CSRF': testCsrfToken,
            Origin: baseUrl,
          },
          body: JSON.stringify({ username: 'alice', password: 'AliceSecurePassword123!' }),
        });

        expect(res.status).toBe(503);
        const json = await res.json();
        expect(json.success).toBe(false);
        expect(json.error.code).toBe('SERVICE_UNAVAILABLE');
      } finally {
        if (server.storage.auditLogs && originalCountFn) {
          server.storage.auditLogs.countRecentFailures = originalCountFn;
        }
      }
    });
  });
});
