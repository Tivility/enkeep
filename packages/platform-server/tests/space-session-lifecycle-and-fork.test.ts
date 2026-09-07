import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { provisionFixtures } from '@enkeep/platform-auth';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import {
  PlatformServer,
  SqliteWebMessageStore,
  type RuntimeArtifactPort,
  type AttachmentCopyPort,
} from '../src/index.js';
import { TestOnlyRuntimeGateway } from './test-runtime-gateway.js';

describe('Space & Session Lifecycle: Archive, Restore & Online Fork', () => {
  let server: PlatformServer;
  let baseUrl: string;
  let aliceCookie: string;
  let bobCookie: string;
  let aliceId: string;
  let bobId: string;
  let aliceSpaceId: string;
  let db: DatabaseSync;
  let tempDir: string;
  let runtimeGateway: TestOnlyRuntimeGateway;
  let testRuntimeArtifactPort: RuntimeArtifactPort;
  let testAttachmentCopyPort: AttachmentCopyPort;
  const testCsrfToken = 'lifecycle-csrf-token-32-chars-long-secure!';

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-lifecycle-test-'));
    process.env.DSH_HOME = path.join(tempDir, '.dsh');
    fs.mkdirSync(path.join(process.env.DSH_HOME, 'sessions'), { recursive: true });

    db = new DatabaseSync(':memory:');
    const storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);
    runtimeGateway = new TestOnlyRuntimeGateway({
      storage,
      messageStore,
      autoReply: true,
      autoReplyDelayMs: 0,
    });

    testRuntimeArtifactPort = {
      async checkSessionArtifact({ dshSessionId }) {
        const dshDir = path.join(process.env.DSH_HOME!, 'sessions', dshSessionId);
        const p = path.join(dshDir, 'session.jsonl');
        if (fs.existsSync(p)) {
          try {
            const raw = fs.readFileSync(p, 'utf8');
            if (raw.trim().length > 0) {
              return { exists: true, valid: true, checksum: 'test-chk', eventCount: 1 };
            }
          } catch {
            return { exists: true, valid: false };
          }
        }
        return { exists: false, valid: false };
      },
      async exportForkSeed({ boundary }) {
        const events: any[] = [
          {
            type: 'user/message',
            seq: 0,
            time: Date.now(),
            surfaceOp: 'append',
            data: { id: boundary?.fromMessageId ?? 'msg_1', role: 'user', content: [{ type: 'text', text: 'Step 1: Planning architecture' }], source: { kind: 'user' } },
          },
          {
            type: 'turn/start',
            seq: 1,
            time: Date.now(),
            data: { turn: 1 },
          },
          {
            type: 'step/start',
            seq: 2,
            time: Date.now(),
            data: { turn: 1, step: 1 },
          },
          {
            type: 'assistant/message',
            seq: 3,
            time: Date.now(),
            surfaceOp: 'append',
            data: { turn: 1, step: 1, message: { id: 'msg_2', role: 'assistant', content: [{ type: 'text', text: 'Step 2: Implementing database schema' }], source: { kind: 'model', provider: 'fork', model: 'forked' } } },
          },
          {
            type: 'step/end',
            seq: 4,
            time: Date.now(),
            data: { turn: 1, step: 1 },
          },
          {
            type: 'turn/end',
            seq: 5,
            time: Date.now(),
            data: { turn: 1, reason: { kind: 'completed' } },
          },
          {
            type: 'session/end-seed',
            seq: 6,
            time: Date.now(),
            data: {},
          },
        ];
        return {
          events,
          receipt: {
            algorithm: 'sha256-session-events-v1' as const,
            checksum: '0000000000000000000000000000000000000000000000000000000000000000',
            canonicalBytes: 100,
            eventCount: events.length,
          },
        };
      },
      async importSeed({ events, receipt }) {
        return {
          status: 'ok',
          persisted: true,
          eventsCount: events.length,
          receipt,
          duplicate: false,
        };
      },
    };

    testAttachmentCopyPort = {
      async copyAttachment(opts) {
        return {
          status: 'copied',
          size: 100,
          etag: opts.etag ?? '"etag123"',
          contentSha256: 'sha123',
        };
      },
    };

    server = new PlatformServer({
      database: db,
      host: '127.0.0.1',
      port: 0,
      cookieSecret: 'lifecycle-secret-key-32-chars-long!',
      csrfToken: testCsrfToken,
      runtimeGateway,
      runtimeArtifactPort: testRuntimeArtifactPort,
      attachmentCopyPort: testAttachmentCopyPort,
    });

    const addr = await server.start();
    baseUrl = addr.url;

    // Provision fixtures
    const fixtures = await provisionFixtures(server.storage, server.authService, {
      adminUsername: 'alice',
      adminPassword: 'AlicePassword123!',
      userUsername: 'bob',
      userPassword: 'BobPassword123!',
      disabledPassword: 'CharlieDisabledPassword123!',
    });
    aliceId = fixtures.admin.id;
    bobId = fixtures.user.id;
    aliceSpaceId = fixtures.adminContainerSpace.id;

    // Explicitly guarantee mustChangePassword is false for test users
    await server.storage.users.update(aliceId, { mustChangePassword: false });
    await server.storage.users.update(bobId, { mustChangePassword: false });

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
    expect(loginRes.status).toBe(200);
    const loginJson = await loginRes.json();
    expect(loginJson.success).toBe(true);
    aliceCookie = loginRes.headers.get('set-cookie')!;

    // Login as Bob
    const bobLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ username: 'bob', password: 'BobPassword123!' }),
    });
    expect(bobLoginRes.status).toBe(200);
    const bobLoginJson = await bobLoginRes.json();
    expect(bobLoginJson.success).toBe(true);
    bobCookie = bobLoginRes.headers.get('set-cookie')!;
  });

  afterAll(async () => {
    await server.stop();
    delete process.env.DSH_HOME;
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ==========================================================================
  // 1. Space Archive & Restore Lifecycle
  // ==========================================================================
  describe('1. Space Archive & Restore Lifecycle', () => {
    let testSpaceId: string;

    it('creates a new space and verifies initial active status', async () => {
      const res = await fetch(`${baseUrl}/api/spaces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({ name: 'Alpha Space', folder: 'alpha-folder' }),
      });
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.status).toBe('active');
      testSpaceId = json.data.id;
    });

    it('allows non-unique space names across spaces for the same user', async () => {
      const res = await fetch(`${baseUrl}/api/spaces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({ name: 'Alpha Space', folder: 'alpha-folder-2' }),
      });
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.name).toBe('Alpha Space');
    });

    it('archives space via POST /api/spaces/:id/archive and enforces soft status', async () => {
      const res = await fetch(`${baseUrl}/api/spaces/${testSpaceId}/archive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.status).toBe('archived');

      // Default GET /api/spaces does NOT list archived spaces
      const listRes = await fetch(`${baseUrl}/api/spaces`, {
        headers: { Cookie: aliceCookie },
      });
      const listJson = await listRes.json();
      const foundInDefault = listJson.data.some((s: any) => s.id === testSpaceId);
      expect(foundInDefault).toBe(false);

      // GET /api/spaces?includeArchived=true lists archived spaces
      const incRes = await fetch(`${baseUrl}/api/spaces?includeArchived=true`, {
        headers: { Cookie: aliceCookie },
      });
      const incJson = await incRes.json();
      const foundInInc = incJson.data.some((s: any) => s.id === testSpaceId);
      expect(foundInInc).toBe(true);
    });

    it('restores archived space via POST /api/spaces/:id/restore with CSRF and Idempotency', async () => {
      // Missing CSRF rejected with 403
      const noCsrfRes = await fetch(`${baseUrl}/api/spaces/${testSpaceId}/restore`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          Origin: baseUrl,
        },
        body: JSON.stringify({}),
      });
      expect(noCsrfRes.status).toBe(403);

      // Valid restore
      const restoreRes = await fetch(`${baseUrl}/api/spaces/${testSpaceId}/restore`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({}),
      });
      expect(restoreRes.status).toBe(200);
      const restoreJson = await restoreRes.json();
      expect(restoreJson.success).toBe(true);
      expect(restoreJson.data.status).toBe('active');

      // Idempotent repeat restore returns 200 active
      const repeatRes = await fetch(`${baseUrl}/api/spaces/${testSpaceId}/restore`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({}),
      });
      expect(repeatRes.status).toBe(200);
      const repeatJson = await repeatRes.json();
      expect(repeatJson.data.status).toBe('active');
    });

    it('rejects archiving a space when an active turn is running/queued with 409 CONFLICT', async () => {
      // Create session in space
      const sessRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({ spaceId: testSpaceId, title: 'Active Turn Session' }),
      });
      const sessJson = await sessRes.json();
      const activeSessId = sessJson.data.id;

      // Insert running turn into turn_runs
      db.prepare(`
        INSERT INTO turn_runs (id, user_id, space_id, route_id, turn_id, status)
        VALUES ('turn_run_active_1', '${aliceId}', '${testSpaceId}', '${activeSessId}', 'turn_active_1', 'running')
      `).run();

      const archRes = await fetch(`${baseUrl}/api/spaces/${testSpaceId}/archive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({}),
      });
      expect(archRes.status).toBe(409);

      // Clean up running turn
      db.prepare("UPDATE turn_runs SET status = 'completed' WHERE id = 'turn_run_active_1'").run();
    });
  });

  // ==========================================================================
  // 2. Session Archive & Restore Lifecycle & DSH Transcript Integrity
  // ==========================================================================
  describe('2. Session Archive & Restore Lifecycle', () => {
    let sessId: string;
    let sessDshId: string;

    beforeAll(async () => {
      const res = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({ spaceId: aliceSpaceId, title: 'Restore Test Session' }),
      });
      const json = await res.json();
      sessId = json.data.id;

      const routeRow = db.prepare('SELECT dsh_session_id FROM session_routes WHERE id = ?').get(sessId) as { dsh_session_id: string };
      sessDshId = routeRow.dsh_session_id;

      // Send a message so session has messages
      await fetch(`${baseUrl}/api/sessions/${sessId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          'Idempotency-Key': '00000000-0000-4000-8000-000000000001',
          Origin: baseUrl,
        },
        body: JSON.stringify({ content: 'Hello DSH' }),
      });
      await new Promise((r) => setTimeout(r, 50));
    });

    it('rejects archiving session while a turn is active with 409 CONFLICT', async () => {
      db.prepare(`
        INSERT INTO turn_runs (id, user_id, space_id, route_id, turn_id, status)
        VALUES ('turn_run_sess_1', '${aliceId}', '${aliceSpaceId}', '${sessId}', 'turn_s_1', 'running')
      `).run();

      const res = await fetch(`${baseUrl}/api/sessions/${sessId}/archive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(409);

      db.prepare("UPDATE turn_runs SET status = 'completed' WHERE id = 'turn_run_sess_1'").run();
    });

    it('archives session successfully and preserves JSONL transcript', async () => {
      // Write mock JSONL transcript to sessions directory
      const dshDir = path.join(process.env.DSH_HOME!, 'sessions', sessDshId);
      fs.mkdirSync(dshDir, { recursive: true });
      const jsonlHeader = { type: 'session', version: 0, id: sessDshId, createdAt: Date.now(), delegationDepth: 0 };
      const jsonlEvent = {
        type: 'user/message',
        seq: 0,
        time: Date.now(),
        surfaceOp: 'append',
        data: { role: 'user', content: [{ type: 'text', text: 'Hello DSH' }] },
      };
      fs.writeFileSync(
        path.join(dshDir, 'session.jsonl'),
        `${JSON.stringify(jsonlHeader)}\n${JSON.stringify(jsonlEvent)}\n`
      );

      const res = await fetch(`${baseUrl}/api/sessions/${sessId}/archive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.status).toBe('archived');

      // Transcript file is preserved
      expect(fs.existsSync(path.join(dshDir, 'session.jsonl'))).toBe(true);
    });

    it('fails restore with SPACE_ARCHIVED if parent space is archived', async () => {
      // Create a dedicated space and session to test archived space rejection
      const tempSpaceRes = await fetch(`${baseUrl}/api/spaces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({ name: 'Temp Space for Archival', folder: 'temp-space-arch-test' }),
      });
      const tempSpaceJson = await tempSpaceRes.json();
      const tempSpaceId = tempSpaceJson.data.id;

      const tempSessRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({ spaceId: tempSpaceId, title: 'Session in Arch Space' }),
      });
      const tempSessJson = await tempSessRes.json();
      const tempSessId = tempSessJson.data.id;

      // Archive session first
      await fetch(`${baseUrl}/api/sessions/${tempSessId}/archive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({}),
      });

      // Archive parent space
      const archSpaceRes = await fetch(`${baseUrl}/api/spaces/${tempSpaceId}/archive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({}),
      });
      expect(archSpaceRes.status).toBe(200);

      const res = await fetch(`${baseUrl}/api/sessions/${tempSessId}/restore`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('SPACE_ARCHIVED');
    });

    it('fails restore with RECOVERY_REQUIRED if DSH JSONL file is missing', async () => {
      const dshFile = path.join(process.env.DSH_HOME!, 'sessions', sessDshId, 'session.jsonl');
      const backupContent = fs.readFileSync(dshFile, 'utf8');
      fs.unlinkSync(dshFile);

      const res = await fetch(`${baseUrl}/api/sessions/${sessId}/restore`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('RECOVERY_REQUIRED');

      // Restore the file for next test
      fs.writeFileSync(dshFile, backupContent);
    });

    it('restores session successfully when parent space is active and JSONL exists', async () => {
      const res = await fetch(`${baseUrl}/api/sessions/${sessId}/restore`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.status).toBe('active');
    });
  });

  // ==========================================================================
  // 3. Online Fork API & Dual-Store Idempotency
  // ==========================================================================
  describe('3. Online Fork API (POST /api/sessions/:id/fork)', () => {
    let sourceSessId: string;
    let msg1Id: string;
    let msg2Id: string;

    beforeAll(async () => {
      const res = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({ spaceId: aliceSpaceId, title: 'Original Conversation' }),
      });
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.success).toBe(true);
      sourceSessId = json.data.id;

      // Send 2 messages
      const m1 = await fetch(`${baseUrl}/api/sessions/${sourceSessId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          'Idempotency-Key': '00000000-0000-4000-8000-000000000002',
          Origin: baseUrl,
        },
        body: JSON.stringify({ content: 'Step 1: Planning architecture' }),
      });
      expect(m1.status).toBe(200);
      const m1Json = await m1.json();
      expect(m1Json.success).toBe(true);
      msg1Id = m1Json.data.message.id;
      await new Promise((r) => setTimeout(r, 50));

      const m2 = await fetch(`${baseUrl}/api/sessions/${sourceSessId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          'Idempotency-Key': '00000000-0000-4000-8000-000000000003',
          Origin: baseUrl,
        },
        body: JSON.stringify({ content: 'Step 2: Implementing database schema' }),
      });
      expect(m2.status).toBe(200);
      const m2Json = await m2.json();
      expect(m2Json.success).toBe(true);
      msg2Id = m2Json.data.message.id;
      await new Promise((r) => setTimeout(r, 50));
    });

    it('forks full session history when no fromMessageId / fromTurnId is specified', async () => {
      const res = await fetch(`${baseUrl}/api/sessions/${sourceSessId}/fork`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({ title: 'Full Forked Session' }),
      });
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.title).toBe('Full Forked Session');
      expect(json.data.status).toBe('active');
      expect(json.data.currentGeneration).toBe(1);

      const forkedSessId = json.data.id;
      expect(forkedSessId).not.toBe(sourceSessId);

      // Verify copied messages in forked session
      const msgsRes = await fetch(`${baseUrl}/api/sessions/${forkedSessId}/messages`, {
        headers: { Cookie: aliceCookie },
      });
      const msgsJson = await msgsRes.json();
      expect(msgsJson.data.messages.length).toBeGreaterThanOrEqual(2);
      expect(msgsJson.data.messages.some((m: any) => m.content === 'Step 1: Planning architecture')).toBe(true);
      expect(msgsJson.data.messages.some((m: any) => m.content === 'Step 2: Implementing database schema')).toBe(true);

      // Verify generation 1 row created for forked session
      const genRows = db.prepare('SELECT generation_number, reset_reason FROM session_generations WHERE route_id = ?').all(forkedSessId) as any[];
      expect(genRows.length).toBe(1);
      expect(genRows[0].generation_number).toBe(1);
      expect(genRows[0].reset_reason).toBe('fork');
    });

    it('forks prefix history at exact message boundary using fromMessageId', async () => {
      const res = await fetch(`${baseUrl}/api/sessions/${sourceSessId}/fork`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({
          fromMessageId: msg1Id,
          title: 'Prefix Step 1 Fork',
        }),
      });
      expect(res.status).toBe(201);
      const json = await res.json();
      const forkedSessId = json.data.id;

      // Verify only message 1 is copied
      const msgsRes = await fetch(`${baseUrl}/api/sessions/${forkedSessId}/messages`, {
        headers: { Cookie: aliceCookie },
      });
      const msgsJson = await msgsRes.json();
      expect(msgsJson.data.messages.length).toBeGreaterThanOrEqual(1);
      expect(msgsJson.data.messages[0].content).toBe('Step 1: Planning architecture');

      // Verify original source session remains completely unchanged
      const srcMsgsRes = await fetch(`${baseUrl}/api/sessions/${sourceSessId}/messages`, {
        headers: { Cookie: aliceCookie },
      });
      const srcMsgsJson = await srcMsgsRes.json();
      expect(srcMsgsJson.data.messages.length).toBeGreaterThanOrEqual(2);
    });

    it('enforces idempotency via Idempotency-Key header on fork', async () => {
      const idempKey = '11111111-2222-4333-8444-555555555555';
      const res1 = await fetch(`${baseUrl}/api/sessions/${sourceSessId}/fork`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          'Idempotency-Key': idempKey,
          Origin: baseUrl,
        },
        body: JSON.stringify({ title: 'Idempotent Fork' }),
      });
      expect(res1.status).toBe(201);
      const json1 = await res1.json();

      const res2 = await fetch(`${baseUrl}/api/sessions/${sourceSessId}/fork`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          'Idempotency-Key': idempKey,
          Origin: baseUrl,
        },
        body: JSON.stringify({ title: 'Idempotent Fork' }),
      });
      expect(res2.status).toBe(201);
      const json2 = await res2.json();
      expect(json2.data.id).toBe(json1.data.id);
    });

    it('rejects cross-tenant fork with 404 NOT_FOUND', async () => {
      // Bob tries to fork Alice's session
      const res = await fetch(`${baseUrl}/api/sessions/${sourceSessId}/fork`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: bobCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({ title: 'Bob Attempting Cross-Tenant Fork' }),
      });
      expect(res.status).toBe(404);
    });

    it('rejects fork while source session has an active turn with 409 TURN_ACTIVE', async () => {
      db.prepare(`
        INSERT INTO turn_runs (id, user_id, space_id, route_id, turn_id, status)
        VALUES ('turn_run_fork_active', '${aliceId}', '${aliceSpaceId}', '${sourceSessId}', 'turn_fork_act', 'running')
      `).run();

      const res = await fetch(`${baseUrl}/api/sessions/${sourceSessId}/fork`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({ title: 'Rejected Fork' }),
      });
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error.code).toBe('TURN_ACTIVE');

      db.prepare("UPDATE turn_runs SET status = 'completed' WHERE id = 'turn_run_fork_active'").run();
    });

    it('allows independent continuation of both source and forked sessions', async () => {
      const forkRes = await fetch(`${baseUrl}/api/sessions/${sourceSessId}/fork`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({ title: 'Independent Branch' }),
      });
      const forkJson = await forkRes.json();
      const branchId = forkJson.data.id;

      // Send message to branch
      const branchMsgRes = await fetch(`${baseUrl}/api/sessions/${branchId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          'Idempotency-Key': '00000000-0000-4000-8000-000000000010',
          Origin: baseUrl,
        },
        body: JSON.stringify({ content: 'Branch-specific exploration' }),
      });
      expect(branchMsgRes.status).toBe(200);
      await new Promise((r) => setTimeout(r, 50));

      // Send message to original source
      const srcMsgRes = await fetch(`${baseUrl}/api/sessions/${sourceSessId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          'Idempotency-Key': '00000000-0000-4000-8000-000000000011',
          Origin: baseUrl,
        },
        body: JSON.stringify({ content: 'Mainline continuation' }),
      });
      expect(srcMsgRes.status).toBe(200);
      await new Promise((r) => setTimeout(r, 50));

      // Check branch does NOT contain mainline continuation
      const branchMsgs = await (await fetch(`${baseUrl}/api/sessions/${branchId}/messages`, { headers: { Cookie: aliceCookie } })).json();
      expect(branchMsgs.data.messages.some((m: any) => m.content === 'Mainline continuation')).toBe(false);
      expect(branchMsgs.data.messages.some((m: any) => m.content === 'Branch-specific exploration')).toBe(true);

      // Check source does NOT contain branch-specific exploration
      const srcMsgs = await (await fetch(`${baseUrl}/api/sessions/${sourceSessId}/messages`, { headers: { Cookie: aliceCookie } })).json();
      expect(srcMsgs.data.messages.some((m: any) => m.content === 'Branch-specific exploration')).toBe(false);
      expect(srcMsgs.data.messages.some((m: any) => m.content === 'Mainline continuation')).toBe(true);
    });

    it('rejects reusing the same Idempotency-Key with a differing request payload with 409 IDEMPOTENCY_CONFLICT', async () => {
      const conflictIdempKey = '22222222-3333-4444-8555-666666666666';
      const res1 = await fetch(`${baseUrl}/api/sessions/${sourceSessId}/fork`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          'Idempotency-Key': conflictIdempKey,
          Origin: baseUrl,
        },
        body: JSON.stringify({ title: 'First Payload' }),
      });
      expect(res1.status).toBe(201);

      const res2 = await fetch(`${baseUrl}/api/sessions/${sourceSessId}/fork`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          'Idempotency-Key': conflictIdempKey,
          Origin: baseUrl,
        },
        body: JSON.stringify({ title: 'Differing Second Payload' }),
      });
      expect(res2.status).toBe(409);
      const json2 = await res2.json();
      expect(json2.error.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('proves startup reconciliation of seeded fork operations recovers unfinalized transactions', async () => {
      const { ForkService } = await import('../src/sessions/fork-service.js');
      const forkService = new ForkService({
        db,
        storage: server.storage,
        runtimeArtifactPort: testRuntimeArtifactPort,
        attachmentCopyPort: testAttachmentCopyPort,
      });

      // Insert an unfinalized seeded operation in fork_operations
      const unfinalizedRouteId = 'ses_unfinalized_test_001';
      const unfinalizedDshId = 'ses_unfinalized_dsh_001';
      const testPlan = {
        userId: aliceId,
        sourceSessionId: sourceSessId,
        sourceDshSessionId: 'dsh_src_001',
        targetSpaceId: aliceSpaceId,
        forkedRouteId: unfinalizedRouteId,
        forkedDshSessionId: unfinalizedDshId,
        forkedTitle: 'Recovered Forked Session',
        agentProfileId: null,
        agentProfileSnapshotId: null,
        includedMessageIds: [msg1Id],
        seedEvents: [],
        receipt: {
          algorithm: 'sha256-session-events-v1' as const,
          checksum: '0000000000000000000000000000000000000000000000000000000000000000',
          canonicalBytes: 2,
          eventCount: 0,
        },
      };

      db.prepare(`
        INSERT INTO fork_operations (
          id, user_id, source_session_id, target_space_id, forked_route_id, forked_dsh_session_id,
          request_hash, idempotency_key, status, fork_plan_json, created_at, updated_at
        ) VALUES (
          'forkop_seeded_test_1', '${aliceId}', '${sourceSessId}', '${aliceSpaceId}',
          '${unfinalizedRouteId}', '${unfinalizedDshId}', 'hash123', '33333333-4444-4555-8666-777777777777',
          'seeded', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `).run(JSON.stringify(testPlan));

      // Execute reconcile
      const reconciledCount = await forkService.reconcilePendingOperations();
      expect(reconciledCount).toBeGreaterThanOrEqual(1);

      // Verify the session now exists in session_routes
      const recoveredRoute = db.prepare('SELECT id, title, status FROM session_routes WHERE id = ?').get(unfinalizedRouteId) as any;
      expect(recoveredRoute).toBeDefined();
      expect(recoveredRoute.title).toBe('Recovered Forked Session');
      expect(recoveredRoute.status).toBe('active');

      // Verify fork_operations status is now finalized
      const opStatus = db.prepare('SELECT status FROM fork_operations WHERE id = ?').get('forkop_seeded_test_1') as any;
      expect(opStatus.status).toBe('finalized');
    });

    it('guarantees ZERO leakage of sensitive error substrings across export, import, attachment copy, and recovery failures', async () => {
      const { ForkService } = await import('../src/sessions/fork-service.js');
      const sensitiveLeak = 'secretTOKEN /Users/x SQL SELECT';
      const sensitiveSubstrings = ['secretTOKEN', '/Users/x', 'SQL SELECT'];

      // 1. Export Generic Failure: throws sensitiveLeak
      const failingExportPort: RuntimeArtifactPort = {
        ...testRuntimeArtifactPort,
        async exportForkSeed() {
          throw new Error(sensitiveLeak);
        },
      };
      const exportForkService = new ForkService({
        db,
        storage: server.storage,
        runtimeArtifactPort: failingExportPort,
        attachmentCopyPort: testAttachmentCopyPort,
      });

      let caughtExportErr: any = null;
      try {
        await exportForkService.forkSession(aliceId, sourceSessId, { title: 'Leak Test Export' });
      } catch (err: any) {
        caughtExportErr = err;
      }
      expect(caughtExportErr).toBeDefined();
      expect(caughtExportErr.code).toBe('RUNTIME_EXPORT_FAILED');
      expect(caughtExportErr.status).toBe(502);
      expect(caughtExportErr.message).toBe('Runtime fork export failed');
      for (const sub of sensitiveSubstrings) {
        expect(caughtExportErr.message).not.toContain(sub);
      }

      // Check DB fork_operations
      const exportOp = db.prepare(`
        SELECT error_code, error_message FROM fork_operations
        WHERE user_id = ? AND error_code = 'RUNTIME_EXPORT_FAILED'
        ORDER BY created_at DESC LIMIT 1
      `).get(aliceId) as any;
      expect(exportOp).toBeDefined();
      expect(exportOp.error_code).toBe('RUNTIME_EXPORT_FAILED');
      expect(exportOp.error_message).toBe('Runtime fork export failed');
      for (const sub of sensitiveSubstrings) {
        expect(exportOp.error_message).not.toContain(sub);
      }

      // 2. Export Boundary Typed Code Failure: throws error with code BOUNDARY_UNAVAILABLE and sensitive message
      const boundaryError = Object.assign(new Error(sensitiveLeak), { code: 'BOUNDARY_UNAVAILABLE' });
      const failingBoundaryPort: RuntimeArtifactPort = {
        ...testRuntimeArtifactPort,
        async exportForkSeed() {
          throw boundaryError;
        },
      };
      const boundaryForkService = new ForkService({
        db,
        storage: server.storage,
        runtimeArtifactPort: failingBoundaryPort,
        attachmentCopyPort: testAttachmentCopyPort,
      });

      let caughtBoundaryErr: any = null;
      try {
        await boundaryForkService.forkSession(aliceId, sourceSessId, { title: 'Leak Test Boundary' });
      } catch (err: any) {
        caughtBoundaryErr = err;
      }
      expect(caughtBoundaryErr).toBeDefined();
      expect(caughtBoundaryErr.code).toBe('BOUNDARY_UNAVAILABLE');
      expect(caughtBoundaryErr.status).toBe(409);
      expect(caughtBoundaryErr.message).toBe('Fork boundary unavailable');
      for (const sub of sensitiveSubstrings) {
        expect(caughtBoundaryErr.message).not.toContain(sub);
      }

      const boundaryOp = db.prepare(`
        SELECT error_code, error_message FROM fork_operations
        WHERE user_id = ? AND error_code = 'BOUNDARY_UNAVAILABLE'
        ORDER BY created_at DESC LIMIT 1
      `).get(aliceId) as any;
      expect(boundaryOp).toBeDefined();
      expect(boundaryOp.error_code).toBe('BOUNDARY_UNAVAILABLE');
      expect(boundaryOp.error_message).toBe('Fork boundary unavailable');
      for (const sub of sensitiveSubstrings) {
        expect(boundaryOp.error_message).not.toContain(sub);
      }

      // 3. Import Failure: throws sensitiveLeak
      const failingImportPort: RuntimeArtifactPort = {
        ...testRuntimeArtifactPort,
        async importSeed() {
          throw new Error(sensitiveLeak);
        },
      };
      const importForkService = new ForkService({
        db,
        storage: server.storage,
        runtimeArtifactPort: failingImportPort,
        attachmentCopyPort: testAttachmentCopyPort,
      });

      let caughtImportErr: any = null;
      try {
        await importForkService.forkSession(aliceId, sourceSessId, { title: 'Leak Test Import' });
      } catch (err: any) {
        caughtImportErr = err;
      }
      expect(caughtImportErr).toBeDefined();
      expect(caughtImportErr.code).toBe('RUNTIME_SEED_FAILED');
      expect(caughtImportErr.status).toBe(502);
      expect(caughtImportErr.message).toBe('Runtime fork seed failed');
      for (const sub of sensitiveSubstrings) {
        expect(caughtImportErr.message).not.toContain(sub);
      }

      const importOp = db.prepare(`
        SELECT error_code, error_message FROM fork_operations
        WHERE user_id = ? AND error_code = 'RUNTIME_SEED_FAILED'
        ORDER BY created_at DESC LIMIT 1
      `).get(aliceId) as any;
      expect(importOp).toBeDefined();
      expect(importOp.error_code).toBe('RUNTIME_SEED_FAILED');
      expect(importOp.error_message).toBe('Runtime fork seed failed');
      for (const sub of sensitiveSubstrings) {
        expect(importOp.error_message).not.toContain(sub);
      }

      // 4. Attachment Copy Failure: targetSpaceId differs and message has attachment, throws sensitiveLeak
      // Create a second active space for alice
      const secondSpace = await server.storage.forTenant(aliceId).spaces.create({
        name: 'Second Space for Attachment Leak Test',
        folder: 'second-space-folder',
      });

      // Insert an attachment for msg1Id
      db.prepare(`
        INSERT INTO message_attachments (
          id, message_id, user_id, space_id, relative_path, snapshot_path, etag, size, media_type, display_name, created_at
        ) VALUES (
          'att_leak_test_1', '${msg1Id}', '${aliceId}', '${aliceSpaceId}',
          'data/file.txt', 'snapshots/data/file.txt', 'etag123', 100, 'text/plain', 'file.txt', CURRENT_TIMESTAMP
        )
      `).run();

      const failingAttPort: AttachmentCopyPort = {
        async copyAttachment() {
          throw new Error(sensitiveLeak);
        },
      };
      const attForkService = new ForkService({
        db,
        storage: server.storage,
        runtimeArtifactPort: testRuntimeArtifactPort,
        attachmentCopyPort: failingAttPort,
      });

      let caughtAttErr: any = null;
      try {
        await attForkService.forkSession(aliceId, sourceSessId, {
          title: 'Leak Test Attachment',
          targetSpaceId: secondSpace.id,
        });
      } catch (err: any) {
        caughtAttErr = err;
      }
      expect(caughtAttErr).toBeDefined();
      expect(caughtAttErr.code).toBe('ATTACHMENT_COPY_FAILED');
      expect(caughtAttErr.status).toBe(502);
      expect(caughtAttErr.message).toBe('Fork attachment copy failed');
      for (const sub of sensitiveSubstrings) {
        expect(caughtAttErr.message).not.toContain(sub);
      }

      const attOp = db.prepare(`
        SELECT error_code, error_message FROM fork_operations
        WHERE user_id = ? AND error_code = 'ATTACHMENT_COPY_FAILED'
        ORDER BY created_at DESC LIMIT 1
      `).get(aliceId) as any;
      expect(attOp).toBeDefined();
      expect(attOp.error_code).toBe('ATTACHMENT_COPY_FAILED');
      expect(attOp.error_message).toBe('Fork attachment copy failed');
      for (const sub of sensitiveSubstrings) {
        expect(attOp.error_message).not.toContain(sub);
      }

      // 5. Recovery Failure: reconcilePendingOperations catches error when copyCrossSpaceAttachments throws sensitiveLeak
      const failingRecovForkService = new ForkService({
        db,
        storage: server.storage,
        runtimeArtifactPort: testRuntimeArtifactPort,
        attachmentCopyPort: failingAttPort,
      });

      const recovPlan = {
        userId: aliceId,
        sourceSessionId: sourceSessId,
        sourceDshSessionId: 'dsh_src_recov_001',
        sourceSpaceId: aliceSpaceId,
        targetSpaceId: secondSpace.id,
        forkedRouteId: 'ses_unfinalized_recov_001',
        forkedDshSessionId: 'ses_unfinalized_dsh_recov_001',
        forkedTitle: 'Recovered Leaking Session',
        agentProfileId: null,
        agentProfileSnapshotId: null,
        includedMessageIds: [msg1Id],
        seedEvents: [],
      };

      db.prepare(`
        INSERT INTO fork_operations (
          id, user_id, source_session_id, target_space_id, forked_route_id, forked_dsh_session_id,
          request_hash, idempotency_key, status, fork_plan_json, created_at, updated_at
        ) VALUES (
          'forkop_recov_leak_1', '${aliceId}', '${sourceSessId}', '${secondSpace.id}',
          'ses_unfinalized_recov_001', 'ses_unfinalized_dsh_recov_001', 'hash_recov_leak', '44444444-5555-4666-8777-888888888888',
          'seeded', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `).run(JSON.stringify(recovPlan));

      await failingRecovForkService.reconcilePendingOperations();

      const recovOp = db.prepare(`
        SELECT status, error_code, error_message FROM fork_operations
        WHERE id = 'forkop_recov_leak_1'
      `).get() as any;
      expect(recovOp).toBeDefined();
      expect(recovOp.status).toBe('failed');
      expect(recovOp.error_code).toBe('FORK_RECOVERY_FAILED');
      expect(recovOp.error_message).toBe('Fork recovery failed');
      for (const sub of sensitiveSubstrings) {
        expect(recovOp.error_message).not.toContain(sub);
      }

      // 6. Global check on the entire fork_operations table: ZERO occurrences of sensitive strings anywhere
      const allForkOps = db.prepare('SELECT * FROM fork_operations').all() as any[];
      const serializedForkOps = JSON.stringify(allForkOps);
      for (const sub of sensitiveSubstrings) {
        expect(serializedForkOps).not.toContain(sub);
      }
    });
  });
});
