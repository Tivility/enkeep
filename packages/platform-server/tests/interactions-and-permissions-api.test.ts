import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { provisionFixtures } from '@enkeep/platform-auth';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { Context } from '@deepseek-ai/cordis';
import { ExternalInteractionService } from '@enkeep/dsh-external-interaction';
import {
  PlatformServer,
  SqliteWebMessageStore,
} from '../src/index.js';
import { TestOnlyRuntimeGateway } from './test-runtime-gateway.js';

describe('Interactions (Approvals) & Permission Presets HTTP Endpoints', () => {
  let server: PlatformServer;
  let baseUrl: string;
  let aliceCookie: string;
  let bobCookie: string;
  let aliceId: string;
  let bobId: string;
  let aliceSpaceId: string;
  let externalInteraction: ExternalInteractionService;
  const testCsrfToken = 'test-csrf-token-32-chars-long-secure-12345678!';

  function createTestAgent(options: {
    sessionId: string;
    userId: string;
    spaceId: string;
    source?: string;
    turnId?: string;
  }) {
    const events: Array<{ type: string; seq: number; time: number; data?: any; timestamp?: number }> = [
      {
        type: 'turn/start',
        seq: 0,
        time: Date.now(),
        data: { turnId: options.turnId ?? `turn_${options.sessionId}` },
        timestamp: Date.now(),
      },
    ];

    const session = {
      id: options.sessionId,
      meta: { userId: options.userId, spaceId: options.spaceId, source: options.source ?? 'web' },
      header: { id: options.sessionId, userId: options.userId, spaceId: options.spaceId },
      get seq() {
        return events.length;
      },
      eventAt(seq: number) {
        return events[seq];
      },
      snapshotEvents() {
        return [...events];
      },
      append(type: string, data?: Record<string, unknown>) {
        const seq = events.length;
        events.push({ type, seq, time: Date.now(), data, timestamp: Date.now() });
      },
    };

    return {
      id: `agent_${options.sessionId}`,
      session,
    };
  }

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

    const ctx = new Context();
    externalInteraction = new ExternalInteractionService(ctx, { defaultTimeoutMs: 10000 });

    server = new PlatformServer({
      database: db,
      host: '127.0.0.1',
      port: 0,
      cookieSecret: 'routes-api-secret-key-32-chars-long!',
      csrfToken: testCsrfToken,
      runtimeGateway,
      externalInteractionService: externalInteraction,
    });

    const addr = await server.start();
    baseUrl = addr.url;

    // Provision fixtures: Alice (admin), Bob (user)
    const fixtures = await provisionFixtures(server.storage, server.authService, {
      adminUsername: 'alice',
      adminPassword: 'AlicePassword123!',
      userPassword: 'BobPassword123!',
      disabledPassword: 'CharlieDisabledPassword123!',
    });
    aliceId = fixtures.admin.id;
    bobId = fixtures.user.id;
    aliceSpaceId = fixtures.adminContainerSpace.id;

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
    aliceCookie = aliceLogin.headers.get('set-cookie')!.split(';')[0];

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
    bobCookie = bobLogin.headers.get('set-cookie')!.split(';')[0];
  });

  afterAll(async () => {
    externalInteraction.disposeAll();
    await server.stop();
  });

  describe('1. Approvals API (/api/interactions/approvals)', () => {
    it('lists pending approvals and allows decision via POST /api/interactions/approvals/:id/decide', async () => {
      // 1. Initially empty
      const listRes1 = await fetch(`${baseUrl}/api/interactions/approvals`, {
        headers: { Cookie: aliceCookie },
      });
      expect(listRes1.status).toBe(200);
      const listData1 = (await listRes1.json()) as any;
      expect(listData1.success).toBe(true);
      expect(listData1.data.length).toBe(0);

      // 2. Suspend an approval request for Alice using active agent session with open turn
      const agentAlice1 = createTestAgent({
        sessionId: 'ses_alice_test_1',
        userId: aliceId,
        spaceId: aliceSpaceId,
      });

      const suspendPromise = externalInteraction.suspendApproval(
        {
          agent: agentAlice1,
          toolName: 'bash',
          callId: 'call_bash_1',
          reason: 'Execute npm test in workspace',
        },
        'web'
      );

      // Wait a tick for registration
      await new Promise((r) => setTimeout(r, 10));

      // 3. List approvals as Alice -> sees pending approval with safe summary and risk
      const listRes2 = await fetch(`${baseUrl}/api/interactions/approvals`, {
        headers: { Cookie: aliceCookie },
      });
      expect(listRes2.status).toBe(200);
      const listData2 = (await listRes2.json()) as any;
      expect(listData2.data.length).toBe(1);
      const app = listData2.data[0];
      expect(app.toolName).toBe('bash');
      expect(app.risk).toBe('high');
      expect(app.safeSummary).toBe('Execute npm test in workspace');
      expect(app.status).toBe('pending');
      expect(app.sessionId).toBe('ses_alice_test_1');

      // 4. Decide approval: POST /decide with outcome 'allowed-once'
      const decideRes = await fetch(`${baseUrl}/api/interactions/approvals/${app.id}/decide`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({ outcome: 'allowed-once' }),
      });
      expect(decideRes.status).toBe(200);
      const decideData = (await decideRes.json()) as any;
      expect(decideData.success).toBe(true);
      expect(decideData.data.decided).toBe(true);
      expect(decideData.data.status).toBe('allowed-once');

      // Suspended promise resolves to 'allowed-once'
      const resolvedOutcome = await suspendPromise;
      expect(resolvedOutcome).toBe('allowed-once');

      // 5. Idempotent decision call
      const decideResAgain = await fetch(`${baseUrl}/api/interactions/approvals/${app.id}/decide`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({ outcome: 'allowed-once' }),
      });
      expect(decideResAgain.status).toBe(200);
    });

    it('cancels pending approval via POST /api/interactions/approvals/:id/cancel', async () => {
      const agentAlice2 = createTestAgent({
        sessionId: 'ses_alice_test_2',
        userId: aliceId,
        spaceId: aliceSpaceId,
      });

      const suspendPromise = externalInteraction.suspendApproval(
        {
          agent: agentAlice2,
          toolName: 'write',
          callId: 'call_write_1',
          reason: 'Overwrite sensitive file',
        },
        'web'
      );

      await new Promise((r) => setTimeout(r, 10));

      const listRes = await fetch(`${baseUrl}/api/interactions/approvals`, {
        headers: { Cookie: aliceCookie },
      });
      const listData = (await listRes.json()) as any;
      const app = listData.data.find((a: any) => a.sessionId === 'ses_alice_test_2');
      expect(app).toBeDefined();

      const cancelRes = await fetch(`${baseUrl}/api/interactions/approvals/${app.id}/cancel`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({ reason: 'User cancelled turn' }),
      });
      expect(cancelRes.status).toBe(200);
      const cancelData = (await cancelRes.json()) as any;
      expect(cancelData.data.cancelled).toBe(true);

      const resolvedOutcome = await suspendPromise;
      expect(resolvedOutcome).toBe('cancelled');
    });

    it('enforces tenant isolation: user Bob cannot see or decide Alice approvals', async () => {
      const agentAlicePrivate = createTestAgent({
        sessionId: 'ses_alice_private_1',
        userId: aliceId,
        spaceId: aliceSpaceId,
      });

      const suspendPromise = externalInteraction.suspendApproval(
        {
          agent: agentAlicePrivate,
          toolName: 'bash',
          callId: 'call_priv_1',
          reason: 'Alice secret command',
        },
        'web'
      );

      await new Promise((r) => setTimeout(r, 10));

      // Bob lists approvals -> cannot see Alice's approval (Bob is regular user)
      const bobListRes = await fetch(`${baseUrl}/api/interactions/approvals`, {
        headers: { Cookie: bobCookie },
      });
      expect(bobListRes.status).toBe(200);
      const bobListData = (await bobListRes.json()) as any;
      expect(bobListData.data.find((a: any) => a.sessionId === 'ses_alice_private_1')).toBeUndefined();

      // Clean up Alice's approval
      const aliceListRes = await fetch(`${baseUrl}/api/interactions/approvals`, {
        headers: { Cookie: aliceCookie },
      });
      const aliceListData = (await aliceListRes.json()) as any;
      const app = aliceListData.data.find((a: any) => a.sessionId === 'ses_alice_private_1');
      expect(app).toBeDefined();

      // Bob tries to decide Alice's approval -> 404
      const bobDecideRes = await fetch(`${baseUrl}/api/interactions/approvals/${app.id}/decide`, {
        method: 'POST',
        headers: {
          Cookie: bobCookie,
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({ outcome: 'allowed-once' }),
      });
      expect(bobDecideRes.status).toBe(404);

      // Alice decides her approval
      await fetch(`${baseUrl}/api/interactions/approvals/${app.id}/decide`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({ outcome: 'allowed-once' }),
      });

      await suspendPromise;
    });
  });

  describe('2. Permission Presets API (/api/manage/permission-presets)', () => {
    it('verifies removed top-level /api/permission-presets returns 404', async () => {
      const res = await fetch(`${baseUrl}/api/permission-presets/effective?spaceId=${aliceSpaceId}`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(404);
    });

    it('gets effective preset with default fallback and creates new space preset with optimistic revision under /api/manage/permission-presets', async () => {
      // 1. Effective preset before explicit DB record returns default workspace-write
      const effRes1 = await fetch(`${baseUrl}/api/manage/permission-presets/effective?spaceId=${aliceSpaceId}`, {
        headers: { Cookie: aliceCookie },
      });
      expect(effRes1.status).toBe(200);
      const effData1 = (await effRes1.json()) as any;
      expect(effData1.success).toBe(true);
      expect(effData1.data.preset).toBe('workspace-write');
      expect(effData1.data.sandboxMode).toBe('workspace-write');
      expect(effData1.data.approvalPolicy).toBe('ask');

      // 2. Set space preset: read-only
      const saveRes1 = await fetch(`${baseUrl}/api/manage/permission-presets`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({
          spaceId: aliceSpaceId,
          preset: 'read-only',
        }),
      });
      expect(saveRes1.status).toBe(200);
      const saveData1 = (await saveRes1.json()) as any;
      expect(saveData1.success).toBe(true);
      expect(saveData1.data.preset).toBe('read-only');
      expect(saveData1.data.sandboxMode).toBe('read-only');
      expect(saveData1.data.approvalPolicy).toBe('ask');
      expect(saveData1.data.revision).toBe(1);

      // 3. Effective preset for alice space is now read-only
      const effRes2 = await fetch(`${baseUrl}/api/manage/permission-presets/effective?spaceId=${aliceSpaceId}`, {
        headers: { Cookie: aliceCookie },
      });
      const effData2 = (await effRes2.json()) as any;
      expect(effData2.data.preset).toBe('read-only');

      // 4. Update with revision 1 -> revision becomes 2
      const updateRes = await fetch(`${baseUrl}/api/manage/permission-presets`, {
        method: 'PUT',
        headers: {
          Cookie: aliceCookie,
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({
          id: saveData1.data.id,
          spaceId: aliceSpaceId,
          preset: 'danger-full-access',
          revision: 1,
        }),
      });
      expect(updateRes.status).toBe(200);
      const updateData = (await updateRes.json()) as any;
      expect(updateData.data.preset).toBe('danger-full-access');
      expect(updateData.data.revision).toBe(2);

      // 5. Stale revision update rejected with 409 Conflict
      const staleRes = await fetch(`${baseUrl}/api/manage/permission-presets`, {
        method: 'PUT',
        headers: {
          Cookie: aliceCookie,
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({
          id: saveData1.data.id,
          spaceId: aliceSpaceId,
          preset: 'read-only',
          revision: 1, // Stale!
        }),
      });
      expect(staleRes.status).toBe(409);

      // 6. Delete preset
      const delRes = await fetch(`${baseUrl}/api/manage/permission-presets/${saveData1.data.id}`, {
        method: 'DELETE',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
      });
      expect(delRes.status).toBe(200);
      const delData = (await delRes.json()) as any;
      expect(delData.data.deleted).toBe(true);
    });
  });
});
