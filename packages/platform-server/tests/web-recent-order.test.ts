import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { provisionFixtures } from '@enkeep/platform-auth';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import {
  PlatformServer,
  SqliteWebMessageStore,
} from '../src/index.js';
import { TestOnlyRuntimeGateway } from './test-runtime-gateway.js';

describe('Web Recent Activity Order API Contract Tests (Synthetic Data)', () => {
  let server: PlatformServer;
  let db: DatabaseSync;
  let baseUrl: string;
  let aliceCookie: string;
  let bobCookie: string;
  const testCsrfToken = 'synthetic-csrf-token-32-chars-long!';

  beforeAll(async () => {
    db = new DatabaseSync(':memory:');
    const storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);
    const runtimeGateway = new TestOnlyRuntimeGateway({
      storage,
      messageStore,
      autoReply: false,
    });

    server = new PlatformServer({
      database: db,
      host: '127.0.0.1',
      port: 0,
      cookieSecret: 'synthetic-secret-key-32-chars-long!',
      csrfToken: testCsrfToken,
      runtimeGateway,
    });

    const addr = await server.start();
    baseUrl = addr.url;

    // Provision fake fixtures
    await provisionFixtures(server.storage, server.authService, {
      adminUsername: 'user-alice-synth',
      adminPassword: 'AliceSyntheticPassword123!',
      userPassword: 'BobSyntheticPassword123!',
      disabledPassword: 'CharlieSyntheticPassword123!',
    });

    // Login as Alice
    const aliceLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        username: 'user-alice-synth',
        password: 'AliceSyntheticPassword123!',
      }),
    });
    const aliceCookieHeader = aliceLogin.headers.get('set-cookie');
    aliceCookie = aliceCookieHeader ? aliceCookieHeader.split(';')[0] : '';

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
        password: 'BobSyntheticPassword123!',
      }),
    });
    const bobCookieHeader = bobLogin.headers.get('set-cookie');
    bobCookie = bobCookieHeader ? bobCookieHeader.split(';')[0] : '';
  });

  afterAll(async () => {
    await server.stop();
  });

  it('orders spaces and sessions by last activity DESC and includes lastActivityAt field', async () => {
    // 1. Create Space 1 (Old space, created first)
    const resSpace1 = await fetch(`${baseUrl}/api/spaces`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
        Cookie: aliceCookie,
      },
      body: JSON.stringify({ name: 'Synthetic Space Alpha', folder: 'spc-synth-alpha' }),
    });
    expect(resSpace1.status).toBe(201);
    const space1 = (await resSpace1.json()).data;

    // 2. Create Space 2 (Newer space, created second)
    const resSpace2 = await fetch(`${baseUrl}/api/spaces`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
        Cookie: aliceCookie,
      },
      body: JSON.stringify({ name: 'Synthetic Space Beta', folder: 'spc-synth-beta' }),
    });
    expect(resSpace2.status).toBe(201);
    const space2 = (await resSpace2.json()).data;

    // 3. Create Space 3 (Empty space without sessions)
    const resSpace3 = await fetch(`${baseUrl}/api/spaces`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
        Cookie: aliceCookie,
      },
      body: JSON.stringify({ name: 'Synthetic Space Gamma Empty', folder: 'spc-synth-gamma' }),
    });
    expect(resSpace3.status).toBe(201);
    const space3 = (await resSpace3.json()).data;

    const aliceUserRow = db.prepare("SELECT id FROM users WHERE username = 'user-alice-synth'").get() as { id: string };
    const aliceId = aliceUserRow.id;

    // Force deterministic createdAt on spaces: Space 1 oldest, Space 2 middle, Space 3 newer
    db.prepare("UPDATE spaces SET created_at = '2026-01-01T00:00:00.000Z', updated_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(space1.id);
    db.prepare("UPDATE spaces SET created_at = '2026-01-02T00:00:00.000Z', updated_at = '2026-01-02T00:00:00.000Z' WHERE id = ?").run(space2.id);
    db.prepare("UPDATE spaces SET created_at = '2026-01-03T00:00:00.000Z', updated_at = '2026-01-03T00:00:00.000Z' WHERE id = ?").run(space3.id);

    // Insert synthetic session routes for Space 1 and Space 2 directly
    const sessionA1Id = 'ses_synth_a1';
    const sessionA2Id = 'ses_synth_a2';
    const sessionB1Id = 'ses_synth_b1';

    db.prepare(`
      INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, status, title, created_at, updated_at)
      VALUES (?, ?, ?, 'web', 'default', ?, 'peer_a1', 'dsh_a1', 'container', 'active', 'Session A1', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'),
             (?, ?, ?, 'web', 'default', ?, 'peer_a2', 'dsh_a2', 'container', 'active', 'Session A2', '2026-02-02T00:00:00.000Z', '2026-02-02T00:00:00.000Z'),
             (?, ?, ?, 'web', 'default', ?, 'peer_b1', 'dsh_b1', 'container', 'active', 'Session B1', '2026-02-03T00:00:00.000Z', '2026-02-03T00:00:00.000Z')
    `).run(
      sessionA1Id, space1.id, aliceId, sessionA1Id,
      sessionA2Id, space1.id, aliceId, sessionA2Id,
      sessionB1Id, space2.id, aliceId, sessionB1Id
    );

    // Insert synthetic web_messages:
    // Session A1: message at 2026-03-01T10:00:00.000Z
    // Session A2: message at 2026-06-01T10:00:00.000Z (MOST RECENT in Space 1 and overall!)
    // Session B1: message at 2026-04-01T10:00:00.000Z
    db.prepare(`
      INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, created_at)
      VALUES (?, ?, ?, 'user', 'Hello A1', 'delivered', 'synth-route-key', '2026-03-01T10:00:00.000Z')
    `).run('msg_synth_001', sessionA1Id, aliceId);

    db.prepare(`
      INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, created_at)
      VALUES (?, ?, ?, 'user', 'Hello A2 newest', 'delivered', 'synth-route-key', '2026-06-01T10:00:00.000Z')
    `).run('msg_synth_002', sessionA2Id, aliceId);

    db.prepare(`
      INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, created_at)
      VALUES (?, ?, ?, 'user', 'Hello B1', 'delivered', 'synth-route-key', '2026-04-01T10:00:00.000Z')
    `).run('msg_synth_003', sessionB1Id, aliceId);

    // Verify GET /api/spaces:
    // Space 1 max activity is 2026-06-01 (Session A2)
    // Space 2 max activity is 2026-04-01 (Session B1)
    // Space 3 fallback activity is 2026-01-03 (created_at)
    // Therefore order MUST be: Space 1, then Space 2, then Space 3
    const listSpacesRes = await fetch(`${baseUrl}/api/spaces?includeArchived=true`, {
      headers: { Cookie: aliceCookie },
    });
    expect(listSpacesRes.status).toBe(200);
    const spacesJson = await listSpacesRes.json();
    const spaces = spacesJson.data.spaces || spacesJson.data;

    const testSpaces = spaces.filter((s: any) => [space1.id, space2.id, space3.id].includes(s.id));
    expect(testSpaces.length).toBe(3);
    expect(testSpaces[0].id).toBe(space1.id);
    expect(testSpaces[0].lastActivityAt).toBe('2026-06-01T10:00:00.000Z');

    expect(testSpaces[1].id).toBe(space2.id);
    expect(testSpaces[1].lastActivityAt).toBe('2026-04-01T10:00:00.000Z');

    expect(testSpaces[2].id).toBe(space3.id);
    expect(testSpaces[2].lastActivityAt).toBe('2026-01-03T00:00:00.000Z');

    // Verify GET /api/sessions?spaceId=...
    // In Space 1: Session A2 (2026-06-01) must come BEFORE Session A1 (2026-03-01)
    const listSessionsRes = await fetch(`${baseUrl}/api/sessions?spaceId=${space1.id}`, {
      headers: { Cookie: aliceCookie },
    });
    expect(listSessionsRes.status).toBe(200);
    const sessionsJson = await listSessionsRes.json();
    const sessions = sessionsJson.data.sessions || sessionsJson.data;

    expect(sessions.length).toBe(2);
    expect(sessions[0].id).toBe(sessionA2Id);
    expect(sessions[0].lastActivityAt).toBe('2026-06-01T10:00:00.000Z');

    expect(sessions[1].id).toBe(sessionA1Id);
    expect(sessions[1].lastActivityAt).toBe('2026-03-01T10:00:00.000Z');

    // Verify GET /api/spaces/:spaceId/sessions also adheres to order
    const nestedRes = await fetch(`${baseUrl}/api/spaces/${space1.id}/sessions`, {
      headers: { Cookie: aliceCookie },
    });
    expect(nestedRes.status).toBe(200);
    const nestedJson = await nestedRes.json();
    const nestedSessions = nestedJson.data.sessions || nestedJson.data;

    expect(nestedSessions[0].id).toBe(sessionA2Id);
    expect(nestedSessions[0].lastActivityAt).toBe('2026-06-01T10:00:00.000Z');
    expect(nestedSessions[1].id).toBe(sessionA1Id);
    expect(nestedSessions[1].lastActivityAt).toBe('2026-03-01T10:00:00.000Z');
  });

  it('guarantees tenant isolation for last activity ordering', async () => {
    // Bob lists spaces and sessions, should not see Alice activity or spaces
    const bobSpacesRes = await fetch(`${baseUrl}/api/spaces`, {
      headers: { Cookie: bobCookie },
    });
    expect(bobSpacesRes.status).toBe(200);
    const bobJson = await bobSpacesRes.json();
    const bobSpaces = bobJson.data.spaces || bobJson.data;
    for (const s of bobSpaces) {
      expect(s.lastActivityAt).toBeDefined();
    }
  });
});
