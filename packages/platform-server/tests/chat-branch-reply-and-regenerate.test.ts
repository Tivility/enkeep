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
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
} from '../src/storage/migrations.js';
import { TestOnlyRuntimeGateway } from './test-runtime-gateway.js';

describe('Chat Operations: Regenerate, Edit User Message, and Reply References (E2E & Contract)', () => {
  let server: PlatformServer;
  let baseUrl: string;
  let aliceCookie: string;
  let bobCookie: string;
  let aliceId: string;
  let bobId: string;
  let aliceSpaceId: string;
  let bobSpaceId: string;
  let db: DatabaseSync;
  let tempDir: string;
  let runtimeGateway: TestOnlyRuntimeGateway;
  let testRuntimeArtifactPort: RuntimeArtifactPort;
  let testAttachmentCopyPort: AttachmentCopyPort;
  const testCsrfToken = 'chat-ops-csrf-token-32-chars-long-secure!';

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-chat-ops-test-'));
    process.env.DSH_HOME = path.join(tempDir, '.dsh');
    fs.mkdirSync(path.join(process.env.DSH_HOME, 'sessions'), { recursive: true });

    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

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
        return { exists: true, valid: true, checksum: 'test-chk', eventCount: 1 };
      },
      async exportForkSeed({ boundary }) {
        return {
          events: [
            {
              type: 'user/message',
              seq: 0,
              time: Date.now(),
              surfaceOp: 'append',
              data: { id: boundary?.fromMessageId ?? 'msg_1', role: 'user', content: [{ type: 'text', text: 'Initial prompt' }], source: { kind: 'user' } },
            },
            {
              type: 'turn/start',
              seq: 1,
              time: Date.now(),
              data: { turn: 1 },
            },
            {
              type: 'assistant/message',
              seq: 2,
              time: Date.now(),
              surfaceOp: 'append',
              data: { turn: 1, message: { id: 'msg_2', role: 'assistant', content: [{ type: 'text', text: 'Assistant reply' }], source: { kind: 'model' } } },
            },
            {
              type: 'turn/end',
              seq: 3,
              time: Date.now(),
              data: { turn: 1, reason: { kind: 'completed' } },
            },
            {
              type: 'session/end-seed',
              seq: 4,
              time: Date.now(),
              data: {},
            },
          ],
          receipt: {
            sourceSessionId: 'ses_src',
            targetSessionId: 'ses_dst',
            eventsCount: 5,
            fingerprint: 'fp_123',
            exportedAt: new Date().toISOString(),
          },
        };
      },
      async importSeed({ targetDshId }) {
        return { status: 'ok', persisted: true };
      },
    };

    testAttachmentCopyPort = {
      async copyAttachment() {},
    };

    server = new PlatformServer({
      database: db,
      host: '127.0.0.1',
      port: 0,
      cookieSecret: 'cookie-secret-32-chars-minimum-required-secure!',
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
      disabledPassword: 'DisabledPassword123!',
    });
    aliceId = fixtures.admin.id;
    bobId = fixtures.user.id;
    aliceSpaceId = fixtures.adminContainerSpace.id;
    bobSpaceId = fixtures.userContainerSpace.id;

    await server.storage.users.update(aliceId, { mustChangePassword: false });
    await server.storage.users.update(bobId, { mustChangePassword: false });

    const aliceLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
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
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ username: 'bob', password: 'BobPassword123!' }),
    });
    expect(bobLogin.status).toBe(200);
    bobCookie = bobLogin.headers.get('set-cookie')!;
  });

  afterAll(async () => {
    await server?.stop();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('1. Regenerate creates a new branched session without mutating source history', async () => {
    // 1. Create a session for Alice
    const sessRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ spaceId: aliceSpaceId, title: 'Chat for Regenerate' }),
    });
    const sessJson = await sessRes.json();
    if (sessRes.status !== 201) {
      console.error('Session create failed:', sessRes.status, sessJson);
    }
    expect(sessRes.status).toBe(201);
    const session = sessJson.data;

    // 2. Send Turn 1: User prompt
    const msg1Res = await fetch(`${baseUrl}/api/sessions/${session.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
        'Idempotency-Key': 'a1111111-1111-4111-a111-111111111111',
      },
      body: JSON.stringify({ content: 'Explain quantum computing in 1 sentence' }),
    });
    expect(msg1Res.status).toBe(200);

    // Wait for auto-reply assistant message
    await new Promise((r) => setTimeout(r, 100));

    const listRes = await fetch(`${baseUrl}/api/sessions/${session.id}/messages`, {
      headers: { Cookie: aliceCookie },
    });
    const msgs = (await listRes.json()).data.messages;
    expect(msgs.length).toBe(2);
    const userMsg = msgs[0];
    const assistantMsg = msgs[1];
    expect(userMsg.role).toBe('user');
    expect(assistantMsg.role).toBe('assistant');

    // 3. Call POST /api/sessions/:id/regenerate on the assistant message
    const regenRes = await fetch(`${baseUrl}/api/sessions/${session.id}/regenerate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ sourceMessageId: assistantMsg.id }),
    });
    expect(regenRes.status).toBe(201);
    const regenJson = await regenRes.json();
    expect(regenJson.data.accepted).toBe(true);
    expect(regenJson.data.newSessionId).toBeDefined();
    expect(regenJson.data.newSessionId).not.toBe(session.id);

    // 4. Verify source session history is unchanged
    const sourceCheckRes = await fetch(`${baseUrl}/api/sessions/${session.id}/messages`, {
      headers: { Cookie: aliceCookie },
    });
    const sourceMsgs = (await sourceCheckRes.json()).data.messages;
    expect(sourceMsgs.length).toBe(2);
    expect(sourceMsgs[1].id).toBe(assistantMsg.id);

    // 5. Verify branched session received the dispatched prompt
    await new Promise((r) => setTimeout(r, 100));
    const branchCheckRes = await fetch(`${baseUrl}/api/sessions/${regenJson.data.newSessionId}/messages`, {
      headers: { Cookie: aliceCookie },
    });
    const branchMsgs = (await branchCheckRes.json()).data.messages;
    expect(branchMsgs.length).toBeGreaterThanOrEqual(1);
    expect(branchMsgs[0].content).toBe('Explain quantum computing in 1 sentence');
  });

  it('2. Edit user message forks from before the message and sends edited content into branched session', async () => {
    // 1. Create a session
    const sessRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ spaceId: aliceSpaceId, title: 'Chat for Edit' }),
    });
    const session = (await sessRes.json()).data;

    // Send user message
    await fetch(`${baseUrl}/api/sessions/${session.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
        'Idempotency-Key': 'b2222222-2222-4222-a222-222222222222',
      },
      body: JSON.stringify({ content: 'Original typo message' }),
    });

    await new Promise((r) => setTimeout(r, 100));

    const listRes = await fetch(`${baseUrl}/api/sessions/${session.id}/messages`, {
      headers: { Cookie: aliceCookie },
    });
    const userMsg = (await listRes.json()).data.messages[0];
    expect(userMsg.content).toBe('Original typo message');

    // 2. Edit message via POST /api/messages/:id/edit
    const editRes = await fetch(`${baseUrl}/api/messages/${userMsg.id}/edit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ content: 'Corrected edited message' }),
    });
    expect(editRes.status).toBe(201);
    const editJson = await editRes.json();
    expect(editJson.data.newSessionId).toBeDefined();
    expect(editJson.data.newSessionId).not.toBe(session.id);

    // 3. Verify original message in source session is untouched
    const origCheck = await fetch(`${baseUrl}/api/sessions/${session.id}/messages`, {
      headers: { Cookie: aliceCookie },
    });
    const origMsgs = (await origCheck.json()).data.messages;
    expect(origMsgs[0].content).toBe('Original typo message');

    // 4. Verify branched session has the edited message
    await new Promise((r) => setTimeout(r, 100));
    const branchCheck = await fetch(`${baseUrl}/api/sessions/${editJson.data.newSessionId}/messages`, {
      headers: { Cookie: aliceCookie },
    });
    const branchMsgs = (await branchCheck.json()).data.messages;
    expect(branchMsgs[0].content).toBe('Corrected edited message');
  });

  it('3. Reply references: replyToMessageId links message, persists reference in SQLite and exposes replyReference', async () => {
    // 1. Create a session
    const sessRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ spaceId: aliceSpaceId, title: 'Chat with Reply' }),
    });
    const session = (await sessRes.json()).data;

    // Send first message
    await fetch(`${baseUrl}/api/sessions/${session.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
        'Idempotency-Key': 'c3333333-3333-4333-a333-333333333333',
      },
      body: JSON.stringify({ content: 'Here is the key requirement specification' }),
    });

    await new Promise((r) => setTimeout(r, 100));

    const listRes = await fetch(`${baseUrl}/api/sessions/${session.id}/messages`, {
      headers: { Cookie: aliceCookie },
    });
    const firstMsg = (await listRes.json()).data.messages[0];

    // Send second message replying to first message
    const replyRes = await fetch(`${baseUrl}/api/sessions/${session.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
        'Idempotency-Key': 'c4444444-4444-4444-a444-444444444444',
      },
      body: JSON.stringify({
        content: 'I agree with this requirement',
        replyToMessageId: firstMsg.id,
      }),
    });
    expect(replyRes.status).toBe(200);

    // Verify DB insertion in message_references (Migration 24)
    const refRow = db.prepare(`
      SELECT * FROM message_references WHERE reply_to_message_id = ?
    `).get(firstMsg.id) as any;
    expect(refRow).toBeDefined();
    expect(refRow.quote_snippet).toBe('Here is the key requirement specification');
    expect(refRow.user_id).toBe(aliceId);

    // Verify message list returns replyReference
    const updatedList = await fetch(`${baseUrl}/api/sessions/${session.id}/messages`, {
      headers: { Cookie: aliceCookie },
    });
    const msgs = (await updatedList.json()).data.messages;
    const replyMsg = msgs.find((m: any) => m.content === 'I agree with this requirement');
    expect(replyMsg).toBeDefined();
    expect(replyMsg.replyReference).toBeDefined();
    expect(replyMsg.replyReference.messageId).toBe(firstMsg.id);
    expect(replyMsg.replyReference.snippet).toBe('Here is the key requirement specification');
  });

  it('4. Cross-tenant isolation: Bob cannot reply to, regenerate, or edit Alice messages', async () => {
    // 1. Create a message by Alice
    const sessRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ spaceId: aliceSpaceId, title: 'Alice Secret Chat' }),
    });
    const aliceSession = (await sessRes.json()).data;

    await fetch(`${baseUrl}/api/sessions/${aliceSession.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
        'Idempotency-Key': 'd5555555-5555-4555-a555-555555555555',
      },
      body: JSON.stringify({ content: 'Alice confidential financial report' }),
    });

    await new Promise((r) => setTimeout(r, 100));

    const listRes = await fetch(`${baseUrl}/api/sessions/${aliceSession.id}/messages`, {
      headers: { Cookie: aliceCookie },
    });
    const aliceMsg = (await listRes.json()).data.messages[0];

    // 2. Bob creates his own session
    const bobSessRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: bobCookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ spaceId: bobSpaceId, title: 'Bob Chat' }),
    });
    const bobSession = (await bobSessRes.json()).data;

    // Bob attempts to reply to Alice's message -> 404
    const crossReplyRes = await fetch(`${baseUrl}/api/sessions/${bobSession.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: bobCookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
        'Idempotency-Key': 'd6666666-6666-4666-a666-666666666666',
      },
      body: JSON.stringify({
        content: 'Trying to steal Alice reference',
        replyToMessageId: aliceMsg.id,
      }),
    });
    expect(crossReplyRes.status).toBe(404);

    // Bob attempts to edit Alice's message -> 404
    const crossEditRes = await fetch(`${baseUrl}/api/messages/${aliceMsg.id}/edit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: bobCookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ content: 'Bob hacking Alice message' }),
    });
    expect(crossEditRes.status).toBe(404);

    // Bob attempts to regenerate Alice's session -> 404
    const crossRegenRes = await fetch(`${baseUrl}/api/sessions/${aliceSession.id}/regenerate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: bobCookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ sourceMessageId: aliceMsg.id }),
    });
    expect(crossRegenRes.status).toBe(404);
  });

  it('5. Active turn rejection: cannot regenerate or edit while a turn is active (409 TURN_ACTIVE)', async () => {
    // 1. Create a session
    const sessRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ spaceId: aliceSpaceId, title: 'Active Turn Test' }),
    });
    const session = (await sessRes.json()).data;

    // Send a message
    await fetch(`${baseUrl}/api/sessions/${session.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
        'Idempotency-Key': 'e7777777-7777-4777-a777-777777777777',
      },
      body: JSON.stringify({ content: 'Test prompt' }),
    });

    await new Promise((r) => setTimeout(r, 100));

    const listRes = await fetch(`${baseUrl}/api/sessions/${session.id}/messages`, {
      headers: { Cookie: aliceCookie },
    });
    const userMsg = (await listRes.json()).data.messages[0];

    // Simulate an active turn in database
    db.prepare(`
      INSERT INTO turn_runs (id, user_id, space_id, route_id, turn_id, status)
      VALUES ('tr_active_mock', ?, ?, ?, 'turn_active_mock', 'running')
    `).run(aliceId, aliceSpaceId, session.id);

    // Attempt regenerate -> 409 TURN_ACTIVE
    const regenRes = await fetch(`${baseUrl}/api/sessions/${session.id}/regenerate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ sourceMessageId: userMsg.id }),
    });
    expect(regenRes.status).toBe(409);
    const regenErr = await regenRes.json();
    expect(regenErr.error.code).toBe('TURN_ACTIVE');

    // Attempt edit -> 409 TURN_ACTIVE
    const editRes = await fetch(`${baseUrl}/api/messages/${userMsg.id}/edit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ content: 'Edited during active turn' }),
    });
    expect(editRes.status).toBe(409);
    const editErr = await editRes.json();
    expect(editErr.error.code).toBe('TURN_ACTIVE');

    // Clean up mock active turn
    db.prepare(`DELETE FROM turn_runs WHERE id = 'tr_active_mock'`).run();
  });
});
