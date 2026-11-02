/**
 * Jarvis channel end to end over a real platform-server on 127.0.0.1:0 (synthetic, offline):
 * admin-only account creation with a one-time token, token rotation and revocation, the
 * `/api/jarvis/runtime` upgrade (Host validation, Origin refusal, unknown paths) and a node that
 * receives `runtime.hello` and a `runtime.sessions` push, then sends a message.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { provisionFixtures } from '@enkeep/platform-auth';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { PlatformServer, SqliteWebMessageStore } from '../src/index.js';
import { ApprovalBridge } from '../src/interactions/approval-bridge.js';
import { RuntimeSessionEventHub } from '../src/runtime/session-event-hub.js';
import { JarvisRuntimeManager } from '../src/channels/jarvis/manager.js';
import { JarvisAccountLifecycle } from '../src/channels/jarvis/accounts.js';
import { ChannelManagementService } from '../src/channels/channel-routes.js';
import { JarvisTokenStore, JarvisTokenOwnerConflictError, hashJarvisToken } from '../src/channels/jarvis/token-store.js';
import { TestOnlyRuntimeGateway } from './test-runtime-gateway.js';

const CSRF = 'test-csrf-token-32-chars-long-secure-12345678!';
const SUBPROTOCOL = 'jarvis-runtime.v1';
const ROUTE = 'ses_00000000000000000000000000000021';
const DSH_ROUTE = 'ses_00000000000000000000000000000121';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('Jarvis channel on platform-server', () => {
  let db: DatabaseSync;
  let server: PlatformServer;
  let manager: JarvisRuntimeManager;
  let bridge: ApprovalBridge;
  let hub: RuntimeSessionEventHub;
  let baseUrl: string;
  let port: number;
  let adminId: string;
  let userId: string;
  let disabledUserId: string;
  let adminCookie: string;
  let userCookie: string;
  const clients: WebSocket[] = [];

  async function login(username: string, password: string): Promise<string> {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Enkeep-CSRF': CSRF, Origin: baseUrl },
      body: JSON.stringify({ username, password }),
    });
    expect(res.status).toBe(200);
    return res.headers.get('set-cookie')!.split(';')[0]!;
  }

  function manage(cookie: string, method: string, path: string, body?: unknown) {
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Enkeep-CSRF': CSRF, Origin: baseUrl },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  async function createJarvis(cookie = adminCookie): Promise<{ id: string; token: string }> {
    const res = await manage(cookie, 'POST', '/api/manage/channels/accounts', { type: 'jarvis' });
    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    return { id: json.data.id, token: json.data.token };
  }

  /** A raw upgrade attempt; resolves with the HTTP status (101 when upgraded). */
  function upgradeStatus(headers: Record<string, string>, path = '/api/jarvis/runtime'): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port,
        path,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
          ...headers,
        },
      });
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('upgrade', (res, socket) => {
        socket.destroy();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
  }

  function connect(token: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/jarvis/runtime`, {
      protocols: [SUBPROTOCOL],
      headers: { Authorization: `Bearer ${token}` },
    } as unknown as string[]);
    clients.push(ws);
    const frames: Array<Record<string, any>> = [];
    ws.addEventListener('message', (e) => {
      const frame = JSON.parse(String(e.data)) as Record<string, any>;
      frames.push(frame);
      if (frame.method === 'runtime.hello') {
        ws.send(JSON.stringify({ id: frame.id, result: { protocol: 1, node_version: '0.0.0-test', hub: true, features: [] } }));
      }
    });
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason }))
    );
    return { ws, frames, closed };
  }

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);
    const gateway = new TestOnlyRuntimeGateway({ storage, messageStore, database: db, autoReply: true, autoReplyDelayMs: 5 });
    bridge = new ApprovalBridge({ db, env: {}, logger: { warn: () => {} } });
    hub = new RuntimeSessionEventHub({ logger: { warn: () => {} } });
    manager = new JarvisRuntimeManager({
      db,
      storage,
      gateway,
      sessionApi: () => server?.platformApi,
      approvalBridge: bridge,
      sessionEvents: hub,
      version: '0.0.0-test',
      approvalTimeoutSeconds: 600,
      runtimeTiming: { sessionsDebounceMs: 10, itemsCoalesceMs: 5, deltaThrottleMs: 10 },
    });
    server = new PlatformServer({
      database: db,
      storage,
      host: '127.0.0.1',
      port: 0,
      cookieSecret: 'jarvis-channel-secret-key-32-chars!!',
      csrfToken: CSRF,
      runtimeGateway: gateway,
      approvalBridge: bridge,
      channelManagers: { jarvis: manager },
    });
    const address = await server.start();
    baseUrl = address.url;
    port = address.port;
    const fixtures = await provisionFixtures(server.storage, server.authService, {
      adminUsername: 'alice',
      adminPassword: 'AlicePassword123!',
      userPassword: 'BobPassword123!',
      disabledPassword: 'CharlieDisabledPassword123!',
    });
    adminId = fixtures.admin.id;
    userId = fixtures.user.id;
    disabledUserId = fixtures.disabledUser.id;
    await server.storage.forTenant(adminId).sessionRoutes.create({
      id: ROUTE,
      spaceId: fixtures.adminContainerSpace.id,
      channel: 'web',
      nativeContextId: ROUTE,
      dshSessionId: DSH_ROUTE,
      title: 'Synthetic Jarvis session',
    });
    adminCookie = await login('alice', 'AlicePassword123!');
    userCookie = await login('bob', 'BobPassword123!');
  });

  afterEach(async () => {
    for (const ws of clients.splice(0)) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
    await server.stop();
    bridge.dispose();
    hub.dispose();
  });

  it('creates a Jarvis account for admins only, once per user, with a token shown once', async () => {
    const denied = await manage(userCookie, 'POST', '/api/manage/channels/accounts', { type: 'jarvis' });
    expect(denied.status).toBe(403);
    expect(await server.storage.forTenant(userId).channels.listAccounts('jarvis')).toHaveLength(0);

    const { id, token } = await createJarvis();
    expect(token).toMatch(/^ejv_[A-Za-z0-9_-]{43}$/);
    const again = await manage(adminCookie, 'POST', '/api/manage/channels/accounts', { type: 'jarvis' });
    expect(again.status).toBe(409);

    const listed = (await (await manage(adminCookie, 'GET', '/api/manage/channels/accounts')).json()) as any;
    const account = listed.data.accounts.find((a: any) => a.id === id);
    expect(account).toMatchObject({ type: 'jarvis', status: 'active' });
    expect(JSON.stringify(listed)).not.toContain(token);

    const stored = db.prepare('SELECT * FROM channel_account_tokens').all() as any[];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ account_id: id, user_id: adminId, token_hash: createHash('sha256').update(token).digest('hex') });
    expect(JSON.stringify(stored)).not.toContain(token);
    const audit = db.prepare("SELECT action, details FROM auth_audit_log WHERE action LIKE 'jarvis.%'").all() as any[];
    expect(audit.map((a) => a.action)).toEqual(['jarvis.token_issued']);
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it('keeps one Jarvis account per user when creations race: the token row decides, the loser gets 409', async () => {
    // Concurrent requests: whatever the interleaving, exactly one wins.
    const results = await Promise.all([
      manage(adminCookie, 'POST', '/api/manage/channels/accounts', { type: 'jarvis' }),
      manage(adminCookie, 'POST', '/api/manage/channels/accounts', { type: 'jarvis' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await server.storage.forTenant(adminId).channels.listAccounts('jarvis')).toHaveLength(1);

    // Both passed the pre-check (the race): the UNIQUE(user_id) token row refuses the second one,
    // which answers 409 and leaves no second account behind.
    const precheck = vi.spyOn(manager, 'beforeCreateAccount').mockResolvedValue(undefined);
    const raced = await manage(adminCookie, 'POST', '/api/manage/channels/accounts', { type: 'jarvis' });
    expect(raced.status).toBe(409);
    expect(((await raced.json()) as any).error.code).toBe('JARVIS_ACCOUNT_EXISTS');
    precheck.mockRestore();
    expect(await server.storage.forTenant(adminId).channels.listAccounts('jarvis')).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM channel_account_tokens WHERE user_id = ?').get(adminId)).toEqual({ n: 1 });

    // The store itself refuses a second token for the same user.
    const extra = await server.storage.forTenant(adminId).channels.createAccount({ type: 'jarvis', status: 'active' });
    expect(() => new JarvisTokenStore(db).issue(extra.id, adminId)).toThrow(JarvisTokenOwnerConflictError);
  });

  it('authenticates tokens: valid, unknown, rotated, revoked, disabled account, disabled user', async () => {
    const store = new JarvisTokenStore(db);
    const { id, token } = await createJarvis();
    expect(store.authenticate(token)).toEqual({ accountId: id, userId: adminId });
    expect(store.authenticate(`ejv_${'A'.repeat(43)}`)).toBeNull();
    expect(store.authenticate('not-a-token')).toBeNull();
    expect(store.authenticate(`${token}x`)).toBeNull();
    expect((db.prepare('SELECT last_used_at FROM channel_account_tokens WHERE account_id = ?').get(id) as any).last_used_at).toEqual(expect.any(String));

    // Rotation: the old token stops working at once.
    const rotated = (await (await manage(adminCookie, 'POST', `/api/manage/channels/accounts/${id}/token`)).json()) as any;
    expect(rotated.data).toEqual({ accountId: id, token: expect.stringMatching(/^ejv_/) });
    expect(store.authenticate(token)).toBeNull();
    const fresh = rotated.data.token as string;
    expect(store.authenticate(fresh)).toEqual({ accountId: id, userId: adminId });

    // Owner + admin only for rotation.
    expect((await manage(userCookie, 'POST', `/api/manage/channels/accounts/${id}/token`)).status).toBe(404);

    // A disabled owner cannot connect (the row is still there).
    db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(adminId);
    expect(store.authenticate(fresh)).toBeNull();
    db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(adminId);
    expect(store.authenticate(fresh)).not.toBeNull();

    // Disabling the account revokes the token.
    expect((await manage(adminCookie, 'PATCH', `/api/manage/channels/accounts/${id}`, { status: 'disabled' })).status).toBe(200);
    expect(store.has(id)).toBe(false);
    expect(store.authenticate(fresh)).toBeNull();
    await manage(adminCookie, 'PATCH', `/api/manage/channels/accounts/${id}`, { status: 'active' });
    expect(store.authenticate(fresh)).toBeNull();

    // A token of a disabled user's account never authenticates.
    const charlieAccount = await server.storage.forTenant(disabledUserId).channels.createAccount({ type: 'jarvis', status: 'active' });
    const charlieToken = store.issue(charlieAccount.id, disabledUserId);
    expect(store.authenticate(charlieToken)).toBeNull();

    const actions = (db.prepare("SELECT action FROM auth_audit_log WHERE action LIKE 'jarvis.%' ORDER BY rowid").all() as any[]).map((a) => a.action);
    expect(actions).toEqual(['jarvis.token_issued', 'jarvis.token_rotated', 'jarvis.token_revoked']);
  });

  it('refuses upgrades with a bad Host, an Origin, a bad token, no subprotocol, or another path', async () => {
    const { token } = await createJarvis();
    const good = { Authorization: `Bearer ${token}`, 'Sec-WebSocket-Protocol': SUBPROTOCOL };
    expect(await upgradeStatus({ ...good, Origin: baseUrl })).toBe(403);
    expect(await upgradeStatus({ ...good, Host: `localhost:${port}` })).toBe(403);
    expect(await upgradeStatus({ ...good, Authorization: `Bearer ejv_${'B'.repeat(43)}` })).toBe(401);
    expect(await upgradeStatus({ Authorization: `Bearer ${token}` })).toBe(400);
    expect(await upgradeStatus(good, '/api/other/socket')).toBe(404);
    expect(await upgradeStatus(good, '/')).toBe(404);
    expect(await upgradeStatus(good)).toBe(101);
  });

  it('serves a node: hello, session list, a message from the phone, and closes on rotation and deletion', async () => {
    const { id, token } = await createJarvis();
    const client = connect(token);
    const sessions = await waitFor(() => client.frames.find((f) => f.event === 'runtime.sessions'));
    expect(client.ws.protocol).toBe(SUBPROTOCOL);
    expect(client.frames[0]).toMatchObject({
      method: 'runtime.hello',
      params: { runtime: 'enkeep', name: 'Enkeep', agent: 'dsh', version: '0.0.0-test', launcher: 'enkeep', launcher_model: 'DeepSeek Harness' },
    });
    expect(sessions.params.sessions).toEqual([
      expect.objectContaining({ session_id: ROUTE, title: 'Synthetic Jarvis session', status: 'idle', cwd: '/home/dsh/spaces/space-00000000000000000000000000000001' }),
    ]);
    expect(manager.connectionCount).toBe(1);

    client.ws.send(JSON.stringify({ id: 'n1', method: 'session.send', params: { session_id: ROUTE, text: 'synthetic hello from the phone', client_msg_id: 'phone-msg-0001' } }));
    const answer = await waitFor(() => client.frames.find((f) => f.id === 'n1'));
    expect(answer).toEqual({ id: 'n1', result: { ok: true } });
    const origin = db.prepare("SELECT channel, account_id, session_id FROM channel_turn_origins WHERE channel = 'jarvis'").get() as any;
    expect(origin).toEqual({ channel: 'jarvis', account_id: id, session_id: ROUTE });

    client.ws.send(JSON.stringify({ id: 'n2', method: 'session.send', params: { session_id: ROUTE, text: '/new', client_msg_id: 'phone-msg-0002' } }));
    expect((await waitFor(() => client.frames.find((f) => f.id === 'n2'))).error).toMatchObject({ code: 'unsupported' });

    // Rotation closes the live connection; the new token connects.
    const rotated = (await (await manage(adminCookie, 'POST', `/api/manage/channels/accounts/${id}/token`)).json()) as any;
    expect((await client.closed).code).toBe(4001);
    const second = connect(rotated.data.token);
    await waitFor(() => second.frames.find((f) => f.event === 'runtime.sessions'));

    // Deleting the account revokes the token and closes the connection.
    expect((await manage(adminCookie, 'DELETE', `/api/manage/channels/accounts/${id}`)).status).toBe(200);
    expect((await second.closed).code).toBe(4001);
    expect(db.prepare('SELECT COUNT(*) AS c FROM channel_account_tokens').get()).toEqual({ c: 0 });
    expect(await upgradeStatus({ Authorization: `Bearer ${rotated.data.token}`, 'Sec-WebSocket-Protocol': SUBPROTOCOL })).toBe(401);
    await waitFor(() => manager.connectionCount === 0);

    const actions = (db.prepare("SELECT action, details FROM auth_audit_log WHERE action LIKE 'jarvis.%' ORDER BY rowid").all() as any[]);
    expect(actions.map((a) => a.action)).toEqual([
      'jarvis.token_issued',
      'jarvis.connection_opened',
      'jarvis.connection_closed',
      'jarvis.token_rotated',
      'jarvis.connection_opened',
      'jarvis.connection_closed',
      'jarvis.token_revoked',
    ]);
    const blob = JSON.stringify(actions);
    expect(blob).not.toContain(token);
    expect(blob).not.toContain(rotated.data.token);
    expect(blob).not.toContain(hashJarvisToken(token));
  });

  it('reports the connection status of a Jarvis account to its owner only, without secrets', async () => {
    const { id, token } = await createJarvis();
    const responses: unknown[] = [];
    const getJson = async (cookie: string, path: string) => {
      const json = (await (await manage(cookie, 'GET', path)).json()) as any;
      responses.push(json);
      return json;
    };

    const before = (await getJson(adminCookie, '/api/manage/channels/accounts')).data.accounts.find((a: any) => a.id === id);
    expect(before.jarvis).toEqual({ connected: false, tokenCreatedAt: expect.stringMatching(ISO) });

    const client = connect(token);
    await waitFor(() => client.frames.find((f) => f.event === 'runtime.sessions'));
    const live = (await getJson(adminCookie, `/api/manage/channels/accounts/${id}`)).data;
    expect(live).toMatchObject({ id, type: 'jarvis', status: 'active' });
    expect(live.jarvis).toEqual({
      connected: true,
      connectedAt: expect.stringMatching(ISO),
      lastConnectedAt: expect.stringMatching(ISO),
      lastUsedAt: expect.stringMatching(ISO),
      tokenCreatedAt: before.jarvis.tokenCreatedAt,
    });
    expect(live.jarvis.connectedAt).toBe(live.jarvis.lastConnectedAt);
    const filtered = (await getJson(adminCookie, '/api/manage/channels/accounts?type=jarvis')).data.accounts;
    expect(filtered).toHaveLength(1);
    expect(filtered[0].jarvis.connected).toBe(true);

    client.ws.close();
    await client.closed;
    await waitFor(() => manager.connectionCount === 0);
    const after = (await getJson(adminCookie, `/api/manage/channels/accounts/${id}`)).data.jarvis;
    expect(after).toEqual({
      connected: false,
      lastConnectedAt: live.jarvis.lastConnectedAt,
      lastDisconnectedAt: expect.stringMatching(ISO),
      lastUsedAt: live.jarvis.lastUsedAt,
      tokenCreatedAt: before.jarvis.tokenCreatedAt,
    });
    expect(after.lastDisconnectedAt >= after.lastConnectedAt).toBe(true);

    // Other channel types carry no status; other users never see the account or its status.
    const lark = await server.storage.forTenant(adminId).channels.createAccount({ type: 'lark', status: 'disabled' });
    const all = (await getJson(adminCookie, '/api/manage/channels/accounts')).data.accounts;
    const larkListed = all.find((a: any) => a.id === lark.id);
    expect(larkListed).toBeDefined();
    expect(larkListed).not.toHaveProperty('jarvis');
    expect(larkListed).not.toHaveProperty('lark');
    expect((await manage(userCookie, 'GET', `/api/manage/channels/accounts/${id}`)).status).toBe(404);
    expect((await getJson(userCookie, '/api/manage/channels/accounts')).data.accounts).toEqual([]);

    const blob = JSON.stringify(responses);
    expect(blob).not.toContain(token);
    expect(blob).not.toContain(hashJarvisToken(token));
    expect(blob).not.toMatch(/token_?hash/i);
  });

  it('drops a live connection whose token another process rotated or revoked (the admin CLI path)', async () => {
    const { id, token } = await createJarvis();
    const client = connect(token);
    await waitFor(() => client.frames.find((f) => f.event === 'runtime.sessions'));

    // Another process (the admin CLI) goes through its own account lifecycle on the same database:
    // it has no way to reach this platform's connections.
    const offline = new ChannelManagementService(server.storage, undefined, undefined, {
      jarvis: new JarvisAccountLifecycle({ db, storage: server.storage, auditDetails: { via: 'cli' } }),
    });
    const rotated = await offline.rotateAccountToken(adminId, id);
    expect(rotated.token).toMatch(/^ejv_/);
    expect(manager.connectionCount).toBe(1);

    // The old token is refused at once; the live connection counts as disconnected and is dropped
    // at its next check (here: the status read).
    expect(await upgradeStatus({ Authorization: `Bearer ${token}`, 'Sec-WebSocket-Protocol': SUBPROTOCOL })).toBe(401);
    const status = ((await (await manage(adminCookie, 'GET', `/api/manage/channels/accounts/${id}`)).json()) as any).data.jarvis;
    expect(status.connected).toBe(false);
    expect((await client.closed).code).toBe(4001);

    // The new token connects; revoking it elsewhere (deleting the account) drops the connection at
    // its next request, which is refused.
    const second = connect(rotated.token);
    await waitFor(() => second.frames.find((f) => f.event === 'runtime.sessions'));
    expect(await offline.deleteAccount(adminId, id)).toBe(true);
    expect(manager.connectionCount).toBe(1);
    second.ws.send(JSON.stringify({ id: 'n1', method: 'session.send', params: { session_id: ROUTE, text: 'synthetic stale send', client_msg_id: 'phone-msg-stale-0001' } }));
    expect((await second.closed).code).toBe(4001);
    await waitFor(() => manager.connectionCount === 0);
    expect(db.prepare("SELECT COUNT(*) AS c FROM channel_turn_origins WHERE channel = 'jarvis'").get()).toEqual({ c: 0 });
    expect(await upgradeStatus({ Authorization: `Bearer ${rotated.token}`, 'Sec-WebSocket-Protocol': SUBPROTOCOL })).toBe(401);

    const audit = db.prepare("SELECT action, details FROM auth_audit_log WHERE action IN ('jarvis.token_rotated', 'jarvis.token_revoked') ORDER BY rowid").all() as any[];
    expect(audit.map((a) => [a.action, JSON.parse(a.details)])).toEqual([
      ['jarvis.token_rotated', { accountId: id, closedConnections: 0, via: 'cli' }],
      ['jarvis.token_revoked', { accountId: id, reason: 'account_deleted', closedConnections: 0, via: 'cli' }],
    ]);
  });

  it('closes Jarvis connections when the server stops', async () => {
    const { token } = await createJarvis();
    const client = connect(token);
    await waitFor(() => client.frames.find((f) => f.event === 'runtime.sessions'));
    await server.stop();
    expect((await client.closed).code).toBe(1001);
    expect(manager.connectionCount).toBe(0);
  });
});
