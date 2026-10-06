import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  PlatformServer,
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  SqliteWebMessageStore,
} from '../src/index.js';
import {
  SqlitePlatformStorage,
  SqlitePlatformOperationsStorage,
} from '@enkeep/platform-storage-sqlite';
import { PlatformOperationsService } from '@enkeep/platform-operations';
import { hashPassword } from '@enkeep/platform-auth';
import { TestOnlyRuntimeGateway } from './test-runtime-gateway.js';

describe('Synthetic Task Silent/Notify Toggle & Validation APIs', () => {
  let db: DatabaseSync;
  let server: PlatformServer;
  let baseUrl: string;
  let opsStorage: SqlitePlatformOperationsStorage;
  let opsService: PlatformOperationsService;

  const cookieSecret = 'explicit-valid-cookie-secret-32-chars-long!';
  const csrfToken = 'explicit-valid-csrf-token-32-chars-long-ok!';

  const tenantId = 'usr_synth_tenant_01';
  let tenantCookie: string;

  const webSessionRouteId = 'ses_00000000000000000000000000000001';
  const larkSessionRouteId = 'ses_00000000000000000000000000000002';
  const spaceId = 'spc_00000000000000000000000000000001';

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const migrationRunner = new PlatformServerMigrationRunner(db);
    await migrationRunner.migrate(ALL_PLATFORM_MIGRATIONS);

    opsStorage = new SqlitePlatformOperationsStorage(db);
    opsService = new PlatformOperationsService({ storage: opsStorage });

    const platformStorage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);
    const runtimeGateway = new TestOnlyRuntimeGateway({ storage: platformStorage, messageStore });

    server = new PlatformServer({
      database: db,
      host: '127.0.0.1',
      port: 0,
      runtimeGateway,
      cookieSecret,
      csrfToken,
      operationsService: opsService,
      enableWorker: true,
      tenantQuotaDefaults: {
        turns: 100,
        messages: 100,
        tokens: 65536,
        storage_bytes: 10485760,
        api_calls: 500,
        resetInterval: 'none',
      },
    });

    const addr = await server.start();
    baseUrl = addr.url;

    const pwdHash = await hashPassword('Password123!');

    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, status)
      VALUES (?, 'synth_user', ?, 'user', 'active')
    `).run(tenantId, pwdHash);

    db.prepare(`
      INSERT INTO spaces (id, user_id, name, folder, execution_mode, status)
      VALUES (?, ?, 'Synthetic Space', 'synth-folder', 'container', 'active')
    `).run(spaceId, tenantId);

    // 1. Web session route (no channel target)
    db.prepare(`
      INSERT INTO session_routes (
        id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, status
      ) VALUES (?, ?, ?, 'web', 'web-demo', ?, 'peer1', 'dsh_ses_1', 'active')
    `).run(webSessionRouteId, spaceId, tenantId, webSessionRouteId);

    // 2. Lark session route (has derivable origin)
    db.prepare(`
      INSERT INTO session_routes (
        id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, status
      ) VALUES (?, ?, ?, 'lark', 'acc_lark_synth_01', 'oc_chat_synth_01', 'peer2', 'dsh_ses_2', 'active')
    `).run(larkSessionRouteId, spaceId, tenantId);

    // Login
    tenantCookie = await loginUser('synth_user', 'Password123!');
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
    if (opsStorage) {
      await opsStorage.close();
    }
    db.close();
  });

  async function loginUser(username: string, password: string): Promise<string> {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ username, password }),
    });
    return res.headers.get('set-cookie')?.split(';')[0] || '';
  }

  function getHeaders() {
    return {
      'Cookie': tenantCookie,
      'X-Enkeep-CSRF': csrfToken,
      'Content-Type': 'application/json',
      Origin: baseUrl,
    };
  }

  it('toggles silent both ways (silent: false <-> silent: true) and persists across GET calls for task with derivable origin', async () => {
    // Create task bound to lark session route (derivable origin)
    const createRes = await fetch(`${baseUrl}/api/manage/tasks`, {
      method: 'POST',
      headers: {
        ...getHeaders(),
        'Idempotency-Key': '11111111-2222-4333-8444-555555555551',
      },
      body: JSON.stringify({
        title: 'Lark Route Task',
        prompt: 'Run maintenance check',
        sessionId: larkSessionRouteId,
      }),
    });
    expect(createRes.status).toBe(201);
    const createJson = await createRes.json();
    const taskId = createJson.data.task.id;

    // Toggle 1: switch to silent = true
    const putSilentRes = await fetch(`${baseUrl}/api/manage/tasks/${taskId}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify({ silent: true }),
    });
    expect(putSilentRes.status).toBe(200);
    const putSilentJson = await putSilentRes.json();
    expect(putSilentJson.data.task.payload.silent).toBe(true);

    // Verify GET persists silent = true
    const getSilentRes = await fetch(`${baseUrl}/api/manage/tasks/${taskId}`, {
      method: 'GET',
      headers: getHeaders(),
    });
    expect(getSilentRes.status).toBe(200);
    const getSilentJson = await getSilentRes.json();
    expect(getSilentJson.data.payload.silent).toBe(true);

    // Toggle 2: switch to silent = false (notify mode)
    const putNotifyRes = await fetch(`${baseUrl}/api/manage/tasks/${taskId}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify({ silent: false }),
    });
    expect(putNotifyRes.status).toBe(200);
    const putNotifyJson = await putNotifyRes.json();
    expect(putNotifyJson.data.task.payload.silent).toBe(false);

    // Verify GET persists silent = false
    const getNotifyRes = await fetch(`${baseUrl}/api/manage/tasks/${taskId}`, {
      method: 'GET',
      headers: getHeaders(),
    });
    expect(getNotifyRes.status).toBe(200);
    const getNotifyJson = await getNotifyRes.json();
    expect(getNotifyJson.data.payload.silent).toBe(false);

    // Toggle 3: switch via payload: { silent: true }
    const putPayloadSilentRes = await fetch(`${baseUrl}/api/manage/tasks/${taskId}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify({ payload: { silent: true } }),
    });
    expect(putPayloadSilentRes.status).toBe(200);
    const putPayloadSilentJson = await putPayloadSilentRes.json();
    expect(putPayloadSilentJson.data.task.payload.silent).toBe(true);
  });

  it('rejects switching silent=false on a task that has no channel delivery target and no derivable origin', async () => {
    // Create task bound to web session route (no delivery, web-only)
    const createRes = await fetch(`${baseUrl}/api/manage/tasks`, {
      method: 'POST',
      headers: {
        ...getHeaders(),
        'Idempotency-Key': '11111111-2222-4333-8444-555555555552',
      },
      body: JSON.stringify({
        title: 'Web Only Task',
        prompt: 'Run internal calculation',
        sessionId: webSessionRouteId,
      }),
    });
    expect(createRes.status).toBe(201);
    const createJson = await createRes.json();
    const taskId = createJson.data.task.id;

    // First ensure silent=true works
    const putSilentRes = await fetch(`${baseUrl}/api/manage/tasks/${taskId}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify({ silent: true }),
    });
    expect(putSilentRes.status).toBe(200);

    // Now attempt switching silent=false: must reject with 400 validation error
    const putNotifyRes = await fetch(`${baseUrl}/api/manage/tasks/${taskId}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify({ silent: false }),
    });
    expect(putNotifyRes.status).toBe(400);
    const putNotifyJson = await putNotifyRes.json();
    expect(putNotifyJson.error).toBeDefined();
    expect(putNotifyJson.error.code).toBe('VALIDATION_ERROR');
    expect(putNotifyJson.error.message).toMatch(/no channel delivery target and no derivable origin/i);

    // Also via payload: { silent: false }
    const putPayloadNotifyRes = await fetch(`${baseUrl}/api/manage/tasks/${taskId}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify({ payload: { silent: false } }),
    });
    expect(putPayloadNotifyRes.status).toBe(400);
    const putPayloadNotifyJson = await putPayloadNotifyRes.json();
    expect(putPayloadNotifyJson.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects forbidden immutable keys (userId, spaceId, sessionId, delivery) during update', async () => {
    const createRes = await fetch(`${baseUrl}/api/manage/tasks`, {
      method: 'POST',
      headers: {
        ...getHeaders(),
        'Idempotency-Key': '11111111-2222-4333-8444-555555555553',
      },
      body: JSON.stringify({
        title: 'Immutability Check Task',
        prompt: 'Task for testing forbidden keys',
        sessionId: larkSessionRouteId,
      }),
    });
    const createJson = await createRes.json();
    const taskId = createJson.data.task.id;

    // 1. Root ownership spoofing
    const res1 = await fetch(`${baseUrl}/api/manage/tasks/${taskId}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify({ userId: 'other_user' }),
    });
    expect(res1.status).toBe(400);

    // 2. Root spaceId
    const res2 = await fetch(`${baseUrl}/api/manage/tasks/${taskId}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify({ spaceId: 'spc_tamper' }),
    });
    expect(res2.status).toBe(400);

    // 3. Root sessionId
    const res3 = await fetch(`${baseUrl}/api/manage/tasks/${taskId}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify({ sessionId: 'ses_tamper' }),
    });
    expect(res3.status).toBe(400);

    // 4. Payload immutable keys (sessionId, spaceId, delivery)
    const res4 = await fetch(`${baseUrl}/api/manage/tasks/${taskId}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify({ payload: { sessionId: 'ses_tamper' } }),
    });
    expect(res4.status).toBe(400);

    const res5 = await fetch(`${baseUrl}/api/manage/tasks/${taskId}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify({ payload: { delivery: { channel: 'lark', accountId: 'a', nativeContextId: 'c' } } }),
    });
    expect(res5.status).toBe(400);
  });
});
