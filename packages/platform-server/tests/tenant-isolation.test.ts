import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { provisionFixtures } from '@enkeep/platform-auth';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import {
  PlatformServer,
  SqliteWebMessageStore,
} from '../src/index.js';
import { TestOnlyRuntimeGateway } from './test-runtime-gateway.js';

describe('Multi-Tenant Isolation & Privileged Access Guardrails', () => {
  let server: PlatformServer;
  let baseUrl: string;
  let aliceCookie: string;
  let bobCookie: string;
  let aliceSpaceId: string;
  let bobSpaceId: string;
  let aliceSessionId: string;
  let bobSessionId: string;
  const testCsrfToken = 'tenant-isolation-csrf-token-32-chars-ok!';

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
      cookieSecret: 'tenant-isolation-secret-key-32-chars!',
      csrfToken: testCsrfToken,
      runtimeGateway,
    });

    const addr = await server.start();
    baseUrl = addr.url;

    // Provision fixtures
    const fixtures = await provisionFixtures(server.storage, server.authService, {
      adminUsername: 'alice',
      adminPassword: 'AliceSecurePassword123!',
      userUsername: 'bob',
      userPassword: 'BobSecurePassword123!',
      disabledUsername: 'charlie_disabled',
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
      body: JSON.stringify({ username: 'alice', password: 'AliceSecurePassword123!' }),
    });
    aliceCookie = aliceLogin.headers.get('set-cookie')!;

    // Login as Bob
    const bobLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ username: 'bob', password: 'BobSecurePassword123!' }),
    });
    bobCookie = bobLogin.headers.get('set-cookie')!;

    // Create session for Alice in Alice's space
    const aliceSessRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ spaceId: aliceSpaceId, peerId: 'alice-peer' }),
    });
    const aliceSessJson = await aliceSessRes.json();
    aliceSessionId = aliceSessJson.data.id;

    // Create session for Bob in Bob's space
    const bobSessRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: bobCookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ spaceId: bobSpaceId, peerId: 'bob-peer' }),
    });
    const bobSessJson = await bobSessRes.json();
    bobSessionId = bobSessJson.data.id;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('Alice should see only Alice spaces, Bob should see only Bob spaces', async () => {
    const aliceSpacesRes = await fetch(`${baseUrl}/api/spaces`, {
      headers: { Cookie: aliceCookie },
    });
    const aliceSpaces = (await aliceSpacesRes.json()).data;
    expect(aliceSpaces.some((s: any) => s.id === aliceSpaceId)).toBe(true);
    expect(aliceSpaces.some((s: any) => s.id === bobSpaceId)).toBe(false);

    const bobSpacesRes = await fetch(`${baseUrl}/api/spaces`, {
      headers: { Cookie: bobCookie },
    });
    const bobSpaces = (await bobSpacesRes.json()).data;
    expect(bobSpaces.some((s: any) => s.id === bobSpaceId)).toBe(true);
    expect(bobSpaces.some((s: any) => s.id === aliceSpaceId)).toBe(false);
  });

  it('Bob attempting to access Alice space directly returns 404', async () => {
    const res = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}`, {
      headers: { Cookie: bobCookie },
    });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('NOT_FOUND');
  });

  it('Alice attempting to access Bob space directly returns 404', async () => {
    const res = await fetch(`${baseUrl}/api/spaces/${bobSpaceId}`, {
      headers: { Cookie: aliceCookie },
    });
    expect(res.status).toBe(404);
  });

  it('Bob attempting to create session in Alice space returns 404', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: bobCookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ spaceId: aliceSpaceId }),
    });
    expect(res.status).toBe(404);
  });

  it('Bob attempting to view or message Alice session returns 404', async () => {
    // View detail
    const getRes = await fetch(`${baseUrl}/api/sessions/${aliceSessionId}`, {
      headers: { Cookie: bobCookie },
    });
    expect(getRes.status).toBe(404);

    // List messages
    const msgListRes = await fetch(`${baseUrl}/api/sessions/${aliceSessionId}/messages`, {
      headers: { Cookie: bobCookie },
    });
    expect(msgListRes.status).toBe(404);

    // Send message
    const sendRes = await fetch(`${baseUrl}/api/sessions/${aliceSessionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'b0000000-0000-4000-8000-000000000001',
        Cookie: bobCookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ content: 'Malicious cross-tenant attempt' }),
    });
    expect(sendRes.status).toBe(404);

    // Poll events
    const pollRes = await fetch(`${baseUrl}/api/sessions/${aliceSessionId}/events`, {
      headers: { Cookie: bobCookie },
    });
    expect(pollRes.status).toBe(404);
  });

  it('Bob attempting to view or cancel Alice turn returns 404', async () => {
    // Alice creates a turn
    const sendRes = await fetch(`${baseUrl}/api/sessions/${aliceSessionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'b0000000-0000-4000-8000-000000000002',
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ content: 'Turn for tenant test' }),
    });
    expect(sendRes.status).toBe(200);

    // Bob tries to query Alice's session turn status -> 404
    const bobQuery = await fetch(`${baseUrl}/api/sessions/${aliceSessionId}/turn/current`, {
      headers: { Cookie: bobCookie },
    });
    expect(bobQuery.status).toBe(404);

    // Bob tries to cancel Alice's session turn -> 404
    const bobCancel = await fetch(`${baseUrl}/api/sessions/${aliceSessionId}/turn/cancel-current`, {
      method: 'POST',
      headers: {
        Cookie: bobCookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
    });
    expect(bobCancel.status).toBe(404);
  });

  it('Privileged DSH APIs deny-by-default for regular user (Bob)', async () => {
    const res = await fetch(`${baseUrl}/api/dsh/status`, {
      headers: { Cookie: bobCookie },
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('FORBIDDEN');
  });

  it('Privileged DSH APIs deny-by-default for unauthenticated requests', async () => {
    const res = await fetch(`${baseUrl}/api/dsh/status`);
    expect(res.status).toBe(401);
  });

  it('Privileged DSH APIs permitted for active admin (Alice)', async () => {
    const res = await fetch(`${baseUrl}/api/dsh/status`, {
      headers: { Cookie: aliceCookie },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.mode).toBe('privileged');
  });
});
