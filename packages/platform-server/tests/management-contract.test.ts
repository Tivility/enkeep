/**
 * Management Console API Contract Tests
 *
 * Covers:
 * 1. Unauthenticated 401 on all admin and manage routes.
 * 2. Regular user (Bob) 403 on all admin routes.
 * 3. Administrator (Alice) success on all admin routes with valid envelopes.
 * 4. Normalized /api and /api/v1 URL alias compatibility.
 * 5. Recursive sensitive-field absence assertions across all responses.
 * 6. Strict PATCH user validation, last-active-admin demotion/disabling protection,
 *    and automatic session revocation upon disabling.
 * 7. POST revoke-sessions safe semantics and forceLogout on self-revocation.
 * 8. Strict cross-tenant isolation on self-service /api/manage/* and /api/sessions/:id/turns.
 * 9. Runtime provider contract: explicit unavailable vs labeled test provider.
 * 10. Dashboard counts aggregation and server restart persistence.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { provisionFixtures } from '@enkeep/platform-auth';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import {
  PlatformServer,
  SqliteWebMessageStore,
  DEMO_TENANT_QUOTA_DEFAULTS,
  type ManagementRuntimeProvider,
  type UserRuntimeStatus,
} from '../src/index.js';
import { TestOnlyRuntimeGateway } from './test-runtime-gateway.js';

function assertNoSensitiveFields(obj: unknown, path = '$'): void {
  if (obj === null || obj === undefined) return;
  if (typeof obj === 'string') {
    expect(obj, `Found raw password hash at ${path}`).not.toMatch(/^\$scrypt\$/);
    expect(obj, `Found potential private key at ${path}`).not.toContain('PRIVATE KEY');
    expect(obj, `Found unredacted /Users/ path at ${path}`).not.toContain('/Users/');
    expect(obj, `Found unredacted /home/ path at ${path}`).not.toContain('/home/');
    expect(obj, `Found unredacted /private/ path at ${path}`).not.toContain('/private/');
    expect(obj, `Found stack trace at ${path}`).not.toMatch(/at\s+[\w\d_$.<>]+\s+\(.*:\d+:\d+\)/);
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((item, index) => assertNoSensitiveFields(item, `${path}[${index}]`));
    return;
  }
  if (typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      expect(key, `Forbidden sensitive key '${key}' at ${path}`).not.toMatch(/^(?:password_hash|passwordHash|token_hash|tokenHash|cookieSecret|idempotencyKey|idempotency_key|tokenSecret)$/i);
      assertNoSensitiveFields(value, `${path}.${key}`);
    }
  }
}

describe('Management Console Backend Contract & Security Tests', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let serverWithoutProvider: PlatformServer;
  let serverWithProvider: PlatformServer;
  let serverWithLeakyProvider: PlatformServer;
  let urlNoProvider: string;
  let urlWithProvider: string;
  let urlLeakyProvider: string;

  let aliceCookie: string;
  let bobCookie: string;
  let aliceId: string;
  let bobId: string;
  let aliceSpaceId: string;
  let bobSpaceId: string;
  let aliceSessionId: string;
  let bobSessionId: string;

  const testCsrfToken = 'management-contract-csrf-32-chars-ok!';
  const cookieSecret = 'management-contract-secret-32-chars-long!';

  // Labeled fake test runtime provider that includes honest operational fields
  const fakeTestProvider: ManagementRuntimeProvider = {
    async getUserRuntime(userId: string): Promise<UserRuntimeStatus | null> {
      return {
        userId,
        status: 'ok',
        networkMode: 'none',
        dshReady: true,
        uptimeSeconds: 120,
        version: '0.1.0-test',
        enkeepBundleLoaded: true,
        toolsCount: 4,
        plugins: {
          receiptStore: true,
          inbound: true,
          eventRelay: true,
          tools: true,
          externalInteraction: true,
          affinityPolicy: true,
          llmAffinity: true,
        },
        toolsOperational: true,
        toolsUnavailableReason: null,
      };
    },
    async listRuntimes(): Promise<UserRuntimeStatus[]> {
      const aliceRt = await this.getUserRuntime('alice');
      const bobRt = await this.getUserRuntime('bob');
      return [aliceRt!, bobRt!];
    },
  };

  // Provider that throws an error containing secret credentials and absolute paths
  const leakyFailingProvider: ManagementRuntimeProvider = {
    async getUserRuntime(): Promise<UserRuntimeStatus | null> {
      throw new Error('Fatal: /Users/secret/deploy/node_modules/fail with private_key_token=secret_pass_123');
    },
    async listRuntimes(): Promise<UserRuntimeStatus[]> {
      throw new Error('Fatal list: /home/admin/.ssh/id_rsa at Object.<anonymous> (/private/var/server.ts:42:10)');
    },
  };

  beforeAll(async () => {
    db = new DatabaseSync(':memory:');
    storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);

    const runtimeGateway = new TestOnlyRuntimeGateway({
      storage,
      messageStore,
      autoReply: true,
      autoReplyDelayMs: 5,
    });

    serverWithoutProvider = new PlatformServer({
      database: db,
      host: '127.0.0.1',
      port: 0,
      cookieSecret,
      csrfToken: testCsrfToken,
      runtimeGateway,
      quotaDefaults: DEMO_TENANT_QUOTA_DEFAULTS,
    });

    const addrNoProvider = await serverWithoutProvider.start();
    urlNoProvider = addrNoProvider.url;

    // Provision fixtures: Alice (admin), Bob (user), Charlie (disabled)
    const fixtures = await provisionFixtures(storage, serverWithoutProvider.authService, {
      adminUsername: 'alice',
      adminPassword: 'AlicePassword123!',
      userUsername: 'bob',
      userPassword: 'BobPassword123!',
      disabledUsername: 'charlie',
      disabledPassword: 'CharliePassword123!',
    });

    aliceId = fixtures.admin.id;
    bobId = fixtures.user.id;
    aliceSpaceId = fixtures.adminContainerSpace.id;
    bobSpaceId = fixtures.userContainerSpace.id;

    // Login Alice
    const aliceLogin = await fetch(`${urlNoProvider}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Enkeep-CSRF': testCsrfToken, Origin: urlNoProvider },
      body: JSON.stringify({ username: 'alice', password: 'AlicePassword123!' }),
    });
    aliceCookie = aliceLogin.headers.get('set-cookie')!;

    // Login Bob
    const bobLogin = await fetch(`${urlNoProvider}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Enkeep-CSRF': testCsrfToken, Origin: urlNoProvider },
      body: JSON.stringify({ username: 'bob', password: 'BobPassword123!' }),
    });
    bobCookie = bobLogin.headers.get('set-cookie')!;

    // Create session for Alice
    const aliceSessRes = await fetch(`${urlNoProvider}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: aliceCookie, 'X-Enkeep-CSRF': testCsrfToken, Origin: urlNoProvider },
      body: JSON.stringify({ spaceId: aliceSpaceId, peerId: 'alice-test-peer', executionMode: 'container' }),
    });
    const aliceSessJson = await aliceSessRes.json();
    aliceSessionId = aliceSessJson.data.id;

    // Create session for Bob
    const bobSessRes = await fetch(`${urlNoProvider}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: bobCookie, 'X-Enkeep-CSRF': testCsrfToken, Origin: urlNoProvider },
      body: JSON.stringify({ spaceId: bobSpaceId, peerId: 'bob-test-peer', executionMode: 'container' }),
    });
    const bobSessJson = await bobSessRes.json();
    bobSessionId = bobSessJson.data.id;

    // Seed mock data for tasks, deliveries, quotas, turns, and imports
    db.prepare(`
      INSERT INTO platform_tasks (id, user_id, title, priority, status, created_at, updated_at, error, idempotency_key)
      VALUES
        ('task-alice-1', ?, 'Alice Admin Task', 'high', 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, 'idem-alice-1'),
        ('task-bob-1', ?, 'Bob User Task', 'medium', 'completed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, 'idem-bob-1'),
        ('task-malicious-1', ?, 'Malicious Task', 'high', 'failed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, '[TASK_INTERNAL_ERROR] /Users/victim/secret_token.txt failed with stack trace at /Users/victim/app.js:10:5', 'super-secret-task-idem-key')
    `).run(aliceId, bobId, aliceId);

    db.prepare(`
      INSERT INTO delivery_inbox (id, user_id, route_id, message_id, delivery_id, status, error, created_at, updated_at)
      VALUES
        ('deliv-alice-1', ?, ?, 'msg-1', 'deliv-id-1', 'delivered', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('deliv-bob-1', ?, ?, 'msg-2', 'deliv-id-2', 'delivered', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('deliv-malicious-1', ?, ?, 'msg-leak', 'deliv-leak', 'failed', '[DELIVERY_ERR] connection timeout at /home/user/passwords.json', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(aliceId, aliceSessionId, bobId, bobSessionId, aliceId, aliceSessionId);

    db.prepare(`
      INSERT INTO quota_limits (user_id, resource, limit_amount, updated_at)
      VALUES
        (?, 'turns_per_minute', 100, CURRENT_TIMESTAMP),
        (?, 'turns_per_minute', 20, CURRENT_TIMESTAMP)
    `).run(aliceId, bobId);

    db.prepare(`
      INSERT INTO turn_runs (id, user_id, space_id, route_id, turn_id, status, error, created_at, updated_at)
      VALUES
        ('turn-alice-1', ?, ?, ?, 't-101', 'completed', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('turn-bob-1', ?, ?, ?, 't-102', 'completed', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('turn-malicious-1', ?, ?, ?, 't-leak', 'failed', '[TURN_FATAL] /private/var/root/token error: Bearer secret_jwt_123 at run (/var/turn.ts:99:1)', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(aliceId, aliceSpaceId, aliceSessionId, bobId, bobSpaceId, bobSessionId, bobId, bobSpaceId, bobSessionId);

    db.prepare(`
      INSERT INTO auth_audit_log (id, user_id, username, action, ip_address, user_agent, details, created_at)
      VALUES
        ('audit-secret-1', ?, 'alice', 'login_failure', '127.0.0.1', 'test-agent', '{"token":"secret_jwt_token_here","stack":"Error: crash at /Users/<user>/index.ts:1:1","path":"/Users/alice/secrets.json","nested":{"credential":"super_secret_credential"}}', CURRENT_TIMESTAMP)
    `).run(aliceId);

    db.prepare(`
      INSERT INTO spaces (id, user_id, name, folder, execution_mode, created_at, updated_at)
      VALUES
        ('space-absolute-1', ?, 'Absolute Space', '/Users/<user>/ClaudeCodeWS/DSH-Claw/workspaces/alice-space', 'container', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(aliceId);

    db.prepare(`
      INSERT INTO fixed_import_receipts (
        user_id, source_fingerprint, importer_version, id_algorithm, target_dsh, session_format,
        source_chats_count, source_messages_count, imported_messages_count, dropped_messages_count, attachments_count, canonical_hash, created_at
      ) VALUES
        (?, 'fp-alice-1', '0.1.0', 'sha256-v1', 'dsh-0.1.1', 0, 2, 52, 50, 2, 5, 'hash-alice', CURRENT_TIMESTAMP),
        (?, 'fp-bob-1', '0.1.0', 'sha256-v1', 'dsh-0.1.1', 0, 1, 10, 10, 0, 1, 'hash-bob', CURRENT_TIMESTAMP)
    `).run(aliceId, bobId);

    // Also start a secondary server WITH the test runtime provider attached
    serverWithProvider = new PlatformServer({
      database: db,
      host: '127.0.0.1',
      port: 0,
      cookieSecret,
      csrfToken: testCsrfToken,
      runtimeGateway,
      managementProvider: fakeTestProvider,
      quotaDefaults: DEMO_TENANT_QUOTA_DEFAULTS,
    });
    const addrWithProvider = await serverWithProvider.start();
    urlWithProvider = addrWithProvider.url;

    // Start a third server WITH the leaky failing runtime provider attached
    serverWithLeakyProvider = new PlatformServer({
      database: db,
      host: '127.0.0.1',
      port: 0,
      cookieSecret,
      csrfToken: testCsrfToken,
      runtimeGateway,
      managementProvider: leakyFailingProvider,
      quotaDefaults: DEMO_TENANT_QUOTA_DEFAULTS,
    });
    const addrLeaky = await serverWithLeakyProvider.start();
    urlLeakyProvider = addrLeaky.url;
  });

  afterAll(async () => {
    if (serverWithoutProvider) {
      await serverWithoutProvider.stop();
    }
    if (serverWithProvider) {
      await serverWithProvider.stop();
    }
    if (serverWithLeakyProvider) {
      await serverWithLeakyProvider.stop();
    }
  });

  // 1. Unauthenticated 401 Suite
  describe('1. Unauthenticated Request Rejection (401)', () => {
    const adminEndpoints = [
      '/api/admin/dashboard',
      '/api/admin/users',
      '/api/admin/spaces',
      '/api/admin/runtime',
      '/api/admin/plugins',
      '/api/admin/tasks',
      '/api/admin/deliveries',
      '/api/admin/quotas',
      '/api/admin/audit',
      '/api/admin/imports',
      '/api/admin/security',
    ];

    for (const ep of adminEndpoints) {
      it(`Unauth GET ${ep} returns 401 UNAUTHORIZED`, async () => {
        const res = await fetch(`${urlNoProvider}${ep}`);
        expect(res.status).toBe(401);
        const json = await res.json();
        expect(json.success).toBe(false);
        expect(json.error.code).toBe('UNAUTHORIZED');
      });
    }

    it('Unauth PATCH /api/admin/users/:id returns 401', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/users/${bobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Enkeep-CSRF': testCsrfToken, Origin: urlNoProvider },
        body: JSON.stringify({ displayName: 'Hacker' }),
      });
      expect(res.status).toBe(401);
    });

    it('Unauth POST /api/admin/users/:id/revoke-sessions returns 401', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/users/${bobId}/revoke-sessions`, {
        method: 'POST',
        headers: { 'X-Enkeep-CSRF': testCsrfToken, Origin: urlNoProvider },
      });
      expect(res.status).toBe(401);
    });

    const manageEndpoints = [
      '/api/manage/overview',
      '/api/manage/tasks',
      '/api/manage/deliveries',
      '/api/manage/quotas',
      '/api/manage/audit',
      '/api/manage/imports',
    ];

    for (const ep of manageEndpoints) {
      it(`Unauth GET ${ep} returns 401 UNAUTHORIZED`, async () => {
        const res = await fetch(`${urlNoProvider}${ep}`);
        expect(res.status).toBe(401);
      });
    }

    it('Unauth GET /api/sessions/:id/turns returns 401', async () => {
      const res = await fetch(`${urlNoProvider}/api/sessions/${aliceSessionId}/turns`);
      expect(res.status).toBe(401);
    });
  });

  // 2. Non-Admin (Bob) 403 Suite
  describe('2. Non-Admin Role Restriction (Bob 403 Forbidden)', () => {
    const adminEndpoints = [
      '/api/admin/dashboard',
      '/api/admin/users',
      '/api/admin/spaces',
      '/api/admin/runtime',
      '/api/admin/plugins',
      '/api/admin/tasks',
      '/api/admin/deliveries',
      '/api/admin/quotas',
      '/api/admin/audit',
      '/api/admin/imports',
      '/api/admin/security',
    ];

    for (const ep of adminEndpoints) {
      it(`Bob GET ${ep} returns 403 FORBIDDEN`, async () => {
        const res = await fetch(`${urlNoProvider}${ep}`, {
          headers: { Cookie: bobCookie },
        });
        expect(res.status).toBe(403);
        const json = await res.json();
        expect(json.success).toBe(false);
        expect(json.error.code).toBe('FORBIDDEN');
      });
    }

    it('Bob PATCH /api/admin/users/:id returns 403 FORBIDDEN', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/users/${aliceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: bobCookie, 'X-Enkeep-CSRF': testCsrfToken, Origin: urlNoProvider },
        body: JSON.stringify({ role: 'user' }),
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe('FORBIDDEN');
    });

    it('Bob POST /api/admin/users/:id/revoke-sessions returns 403 FORBIDDEN', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/users/${aliceId}/revoke-sessions`, {
        method: 'POST',
        headers: { Cookie: bobCookie, 'X-Enkeep-CSRF': testCsrfToken, Origin: urlNoProvider },
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe('FORBIDDEN');
    });
  });

  // 3. Admin (Alice) Success and Structure Suite
  describe('3. Admin (Alice) Success, URL Aliases & Sensitive-Field Absence', () => {
    it('GET /api/admin/dashboard and /api/v1/admin/dashboard return real KPI contracts and aggregate counts', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/dashboard`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);

      // Backward compatible counts
      expect(json.data.counts.users.total).toBeGreaterThanOrEqual(3);
      expect(json.data.counts.users.admin).toBeGreaterThanOrEqual(1);
      expect(json.data.counts.spaces.total).toBeGreaterThanOrEqual(2);
      expect(json.data.counts.sessions.total).toBeGreaterThanOrEqual(2);
      expect(json.data.counts.tasks.total).toBeGreaterThanOrEqual(2);
      expect(json.data.counts.deliveries.total).toBeGreaterThanOrEqual(2);
      expect(json.data.counts.imports.totalReceipts).toBeGreaterThanOrEqual(2);

      // Real KPI Contract verification (docs/management-console.md)
      expect(json.data.kpis).toBeDefined();
      expect(json.data.kpis.users.total).toBeGreaterThanOrEqual(3);
      expect(json.data.kpis.users.active).toBeGreaterThanOrEqual(2);
      expect(json.data.kpis.users.disabled).toBeGreaterThanOrEqual(1);
      expect(json.data.kpis.spaces).toBeGreaterThanOrEqual(2);
      expect(json.data.kpis.sessions).toBeGreaterThanOrEqual(2);
      expect(json.data.kpis.heldDeliveries).toBe(0); // 0 held out of 3 delivered/failed deliveries
      expect(json.data.kpis.processingTasks).toBe(0); // all tasks pending, completed, or failed
      expect(json.data.kpis.runningTasks).toBe(0);
      expect(json.data.kpis.recentLoginFailures24h).toBeGreaterThanOrEqual(1);
      expect(json.data.kpis.currentSchemaVersion).toBe(31);

      // Runtime without provider: explicit unavailable contract (never synthetic 0)
      expect(json.data.kpis.containers.available).toBe(false);
      expect(json.data.kpis.containers.status).toBe('unavailable');
      expect(json.data.kpis.containers.active).toBeNull();
      expect(json.data.kpis.containers.healthy).toBeNull();
      expect(json.data.kpis.containers.total).toBeNull();

      expect(json.data.runtime.available).toBe(false);
      expect(json.data.runtime.providerAttached).toBe(false);
      expect(json.data.runtime.status).toBe('unavailable');
      expect(json.data.runtime.activeContainers).toBeNull();
      expect(json.data.runtime.healthyContainers).toBeNull();
      expect(json.data.runtime.totalContainers).toBeNull();

      expect(json.data.schema.currentVersion).toBe(31);

      assertNoSensitiveFields(json);

      // Verify v1 alias
      const resV1 = await fetch(`${urlNoProvider}/api/v1/admin/dashboard`, {
        headers: { Cookie: aliceCookie },
      });
      expect(resV1.status).toBe(200);
      const jsonV1 = await resV1.json();
      expect(jsonV1.data.counts.users.total).toBe(json.data.counts.users.total);
      expect(jsonV1.data.kpis.users.total).toBe(json.data.kpis.users.total);
    });

    it('GET /api/admin/users returns paginated list without password_hash and with counts', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/users?limit=10`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.items.length).toBeGreaterThanOrEqual(3);

      const aliceItem = json.data.items.find((u: any) => u.username === 'alice');
      expect(aliceItem).toBeDefined();
      expect(aliceItem.role).toBe('admin');
      expect(aliceItem.spaceCount).toBeGreaterThanOrEqual(1);
      expect(aliceItem.sessionCount).toBeGreaterThanOrEqual(1);
      expect(aliceItem.password_hash).toBeUndefined();
      expect(aliceItem.passwordHash).toBeUndefined();

      assertNoSensitiveFields(json);
    });

    it('GET /api/admin/spaces returns cross-tenant safe list with owner info', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/spaces`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.items.length).toBeGreaterThanOrEqual(2);
      expect(json.data.items.some((s: any) => s.username === 'alice')).toBe(true);
      expect(json.data.items.some((s: any) => s.username === 'bob')).toBe(true);
      assertNoSensitiveFields(json);
    });

    it('GET /api/admin/tasks returns cross-tenant task summaries', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/tasks`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.items.some((t: any) => t.id === 'task-alice-1')).toBe(true);
      expect(json.data.items.some((t: any) => t.id === 'task-bob-1')).toBe(true);
      for (const item of json.data.items) {
        expect(item.description).toBeUndefined();
      }
      assertNoSensitiveFields(json);
    });

    it('GET /api/admin/deliveries returns cross-tenant summaries without payload leaks', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/deliveries`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.items.length).toBeGreaterThanOrEqual(2);
      // Ensure payload column and internal IDs are omitted
      for (const item of json.data.items) {
        expect(item.payload).toBeUndefined();
        expect(item.id).toBeUndefined();
        expect(item.deliveryId).toBeUndefined();
        expect(item.turnId).toBeUndefined();
        expect(item.routeId).toBeUndefined();
        expect(item.userId).toBeUndefined();
        expect(item.username).toBeUndefined();
        expect(typeof item.status).toBe('string');
        expect(typeof item.createdAt).toBe('string');
        expect(typeof item.updatedAt).toBe('string');
      }
      assertNoSensitiveFields(json);
    });

    it('GET /api/admin/quotas returns quota aggregations', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/quotas`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.items.length).toBeGreaterThanOrEqual(2);
      assertNoSensitiveFields(json);
    });

    it('GET /api/admin/audit returns redacted audit logs', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/audit`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      assertNoSensitiveFields(json);
    });

    it('GET /api/admin/imports returns fixed receipt summaries', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/imports`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.items.length).toBeGreaterThanOrEqual(2);
      assertNoSensitiveFields(json);
    });

    it('GET /api/admin/security returns real migration records, checksum verification & security policy (no hashes leaked)', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/security`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.migrations.currentVersion).toBe(31);
      expect(json.data.migrations.expectedVersion).toBe(31);
      expect(json.data.migrations.checksumsMatch).toBe(true);
      expect(Array.isArray(json.data.migrations.applied)).toBe(true);
      expect(json.data.migrations.applied.length).toBe(31);

      // Verify applied items contain version, name, appliedAt and NEVER expose checksum hashes
      for (const item of json.data.migrations.applied) {
        expect(typeof item.version).toBe('number');
        expect(typeof item.name).toBe('string');
        expect(typeof item.appliedAt).toBe('string');
        expect((item as any).checksum).toBeUndefined();
      }

      expect(json.data.securityPolicy.hostBinding).toContain('127.0.0.1');
      expect(json.data.securityPolicy.csrfRequired).toBe(true);
      expect(json.data.securityPolicy.csrfHeader).toBe('X-Enkeep-CSRF');
      assertNoSensitiveFields(json);
    });
  });

  // 4. User Modification & Last Admin Protection Suite
  describe('4. User Management Rules & Last-Active-Admin Protection', () => {
    it('PATCH /api/admin/users/:id rejects unknown fields', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/users/${bobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: aliceCookie, 'X-Enkeep-CSRF': testCsrfToken, Origin: urlNoProvider },
        body: JSON.stringify({ displayName: 'Bob', hackField: true }),
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('VALIDATION_ERROR');
      expect(json.error.message).toContain('Unexpected field "hackField"');
    });

    it('PATCH /api/admin/users/:id rejects invalid role or status values', async () => {
      const resRole = await fetch(`${urlNoProvider}/api/admin/users/${bobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: aliceCookie, 'X-Enkeep-CSRF': testCsrfToken, Origin: urlNoProvider },
        body: JSON.stringify({ role: 'superadmin' }),
      });
      expect(resRole.status).toBe(400);

      const resStatus = await fetch(`${urlNoProvider}/api/admin/users/${bobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: aliceCookie, 'X-Enkeep-CSRF': testCsrfToken, Origin: urlNoProvider },
        body: JSON.stringify({ status: 'banned' }),
      });
      expect(resStatus.status).toBe(400);
    });

    it('Forbids demoting the last active administrator (Alice to user)', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/users/${aliceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: aliceCookie, 'X-Enkeep-CSRF': testCsrfToken, Origin: urlNoProvider },
        body: JSON.stringify({ role: 'user' }),
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.message).toContain('last active administrator');
    });

    it('Forbids disabling the last active administrator (Alice to disabled)', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/users/${aliceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: aliceCookie, 'X-Enkeep-CSRF': testCsrfToken, Origin: urlNoProvider },
        body: JSON.stringify({ status: 'disabled' }),
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.message).toContain('last active administrator');
    });

    it('Allows updating displayName for Bob', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/users/${bobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: aliceCookie, 'X-Enkeep-CSRF': testCsrfToken, Origin: urlNoProvider },
        body: JSON.stringify({ displayName: 'Bob Updated Name' }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.displayName).toBe('Bob Updated Name');
    });

    it('Disabling a user revokes all active sessions for that user', async () => {
      // 1. Verify Bob can access self overview right now
      const preCheck = await fetch(`${urlNoProvider}/api/manage/overview`, {
        headers: { Cookie: bobCookie },
      });
      expect(preCheck.status).toBe(200);

      // 2. Disable Bob via admin PATCH
      const patchRes = await fetch(`${urlNoProvider}/api/admin/users/${bobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: aliceCookie, 'X-Enkeep-CSRF': testCsrfToken, Origin: urlNoProvider },
        body: JSON.stringify({ status: 'disabled' }),
      });
      expect(patchRes.status).toBe(200);
      const patchJson = await patchRes.json();
      expect(patchJson.data.status).toBe('disabled');
      expect(patchJson.data.activeSessionCount).toBe(0);

      // 3. Verify Bob's existing session cookie is immediately rejected with 401
      const postCheck = await fetch(`${urlNoProvider}/api/manage/overview`, {
        headers: { Cookie: bobCookie },
      });
      expect(postCheck.status).toBe(401);

      // 4. Re-enable Bob and create a fresh session for remaining tests
      await fetch(`${urlNoProvider}/api/admin/users/${bobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: aliceCookie, 'X-Enkeep-CSRF': testCsrfToken, Origin: urlNoProvider },
        body: JSON.stringify({ status: 'active' }),
      });

      const freshBobLogin = await fetch(`${urlNoProvider}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Enkeep-CSRF': testCsrfToken, Origin: urlNoProvider },
        body: JSON.stringify({ username: 'bob', password: 'BobPassword123!' }),
      });
      bobCookie = freshBobLogin.headers.get('set-cookie')!;
    });

    it('correctly handles ISO 8601 timestamps for activeSessionCount calculation', async () => {
      // Create user with explicit expired ISO session and active ISO session
      const testIsoUserId = 'test-iso-user-id';
      db.prepare(`
        INSERT INTO users (id, username, role, status, password_hash, created_at, updated_at)
        VALUES (?, 'isouser', 'user', 'active', 'mockhash', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(testIsoUserId);

      // 1 expired ISO 8601 session in the past
      db.prepare(`
        INSERT INTO user_sessions (id, user_id, token_hash, expires_at, created_at)
        VALUES ('sess-iso-expired', ?, 'hash-exp', '2020-01-01T00:00:00.000Z', CURRENT_TIMESTAMP)
      `).run(testIsoUserId);

      // 1 active ISO 8601 session in the future
      db.prepare(`
        INSERT INTO user_sessions (id, user_id, token_hash, expires_at, created_at)
        VALUES ('sess-iso-active', ?, 'hash-act', '2099-01-01T00:00:00.000Z', CURRENT_TIMESTAMP)
      `).run(testIsoUserId);

      const res = await fetch(`${urlNoProvider}/api/admin/users?search=isouser`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      const userItem = json.data.items.find((u: any) => u.id === testIsoUserId);
      expect(userItem).toBeDefined();
      expect(userItem.sessionCount).toBe(2);
      expect(userItem.activeSessionCount).toBe(1);
    });

    it('PATCH /api/admin/users/:id safely updates users with wildcard characters in username without wildcard expansion collisions', async () => {
      const wildcardUserId1 = 'user-wildcard-id-1';
      const wildcardUserId2 = 'user-wildcard-id-2';

      db.prepare(`
        INSERT INTO users (id, username, role, status, password_hash, created_at, updated_at)
        VALUES
          (?, 'wild%user_1', 'user', 'active', 'mockhash1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
          (?, 'wild_user_2', 'user', 'active', 'mockhash2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(wildcardUserId1, wildcardUserId2);

      // PATCH the user whose username has literal '%' and '_'
      const patchRes = await fetch(`${urlNoProvider}/api/admin/users/${wildcardUserId1}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlNoProvider,
        },
        body: JSON.stringify({ displayName: 'Exact Wildcard Target' }),
      });

      expect(patchRes.status).toBe(200);
      const patchJson = await patchRes.json();
      expect(patchJson.success).toBe(true);
      expect(patchJson.data.id).toBe(wildcardUserId1);
      expect(patchJson.data.username).toBe('wild%user_1');
      expect(patchJson.data.displayName).toBe('Exact Wildcard Target');
    });

    it('accurately computes 24h login failures using SQLite UTC semantics across ISO and CURRENT_TIMESTAMP formats', async () => {
      // 1. Insert an old failure (>24 hours ago, e.g. 48h ago)
      db.prepare(`
        INSERT INTO auth_audit_log (id, user_id, username, action, ip_address, created_at)
        VALUES ('audit-old-fail-1', ?, 'test-user', 'login_failure', '127.0.0.1', datetime('now', '-48 hours'))
      `).run(bobId);

      // 2. Insert a recent failure in ISO 8601 format within 24h (e.g. 2 hours ago)
      const twoHoursAgoIso = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
      db.prepare(`
        INSERT INTO auth_audit_log (id, user_id, username, action, ip_address, created_at)
        VALUES ('audit-recent-iso-fail', ?, 'test-user', 'login_failure', '127.0.0.1', ?)
      `).run(bobId, twoHoursAgoIso);

      // 3. Insert a recent failure with 'login_failed' action name within 24h
      db.prepare(`
        INSERT INTO auth_audit_log (id, user_id, username, action, ip_address, created_at)
        VALUES ('audit-recent-alt-action', ?, 'test-user', 'login_failed', '127.0.0.1', datetime('now', '-30 minutes'))
      `).run(bobId);

      // 4. Insert a successful login within 24h (must NOT be counted)
      db.prepare(`
        INSERT INTO auth_audit_log (id, user_id, username, action, ip_address, created_at)
        VALUES ('audit-recent-success', ?, 'test-user', 'login', '127.0.0.1', datetime('now', '-10 minutes'))
      `).run(bobId);

      const res = await fetch(`${urlNoProvider}/api/admin/dashboard`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);

      // We had 1 initial fixture failure + 2 new recent failures = at least 3
      // The 48h old failure and the successful login must NOT be included.
      expect(json.data.kpis.recentLoginFailures24h).toBeGreaterThanOrEqual(3);
    });

    it('accurately computes held deliveries, processing tasks, and schema version', async () => {
      // 1. Insert a held delivery and matching message
      db.prepare(`
        INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, created_at)
        VALUES ('msg-held-1', ?, ?, 'user', 'Held test message', 'held', 'web', CURRENT_TIMESTAMP)
      `).run(aliceSessionId, aliceId);

      db.prepare(`
        INSERT INTO delivery_inbox (id, user_id, route_id, message_id, delivery_id, status, created_at, updated_at)
        VALUES ('deliv-held-test-1', ?, ?, 'msg-held-1', 'deliv-held-1', 'held', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(aliceId, aliceSessionId);

      // 2. Insert running and claimed tasks
      db.prepare(`
        INSERT INTO platform_tasks (id, user_id, title, priority, status, created_at, updated_at)
        VALUES
          ('task-running-test-1', ?, 'Running Task', 'high', 'running', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
          ('task-claimed-test-1', ?, 'Claimed Task', 'high', 'claimed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(aliceId, aliceId);

      try {
        const res = await fetch(`${urlNoProvider}/api/admin/dashboard`, {
          headers: { Cookie: aliceCookie },
        });
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.success).toBe(true);

        expect(json.data.kpis.heldDeliveries).toBeGreaterThanOrEqual(1);
        expect(json.data.kpis.runningTasks).toBeGreaterThanOrEqual(1);
        expect(json.data.kpis.processingTasks).toBeGreaterThanOrEqual(2); // running + claimed
        expect(json.data.counts.tasks.processing).toBeGreaterThanOrEqual(2);
        expect(json.data.kpis.currentSchemaVersion).toBe(31);
        expect(json.data.schema.currentVersion).toBe(31);
      } finally {
        db.prepare(`DELETE FROM delivery_inbox WHERE status = 'held' OR id = 'deliv-held-test-1'`).run();
        db.prepare(`DELETE FROM web_messages WHERE id = 'msg-held-1'`).run();
        db.prepare(`DELETE FROM platform_tasks WHERE id IN ('task-running-test-1', 'task-claimed-test-1')`).run();
      }
    });

    it('enforces atomic last-active-admin invariant under sequential demotion leaving exactly one active admin', async () => {
      const secondAdminId = 'invariant-second-admin';

      // Create a second active admin so that exactly two active admins exist (Alice and secondAdmin)
      db.prepare(`
        INSERT INTO users (id, username, role, status, password_hash, created_at, updated_at)
        VALUES (?, 'second_admin', 'admin', 'active', 'mockhash_second', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(secondAdminId);

      // 1. Demote the second admin -> succeeds with 200 because Alice is still an active admin
      const demote1Res = await fetch(`${urlNoProvider}/api/admin/users/${secondAdminId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlNoProvider,
        },
        body: JSON.stringify({ role: 'user' }),
      });
      expect(demote1Res.status).toBe(200);
      const demote1Json = await demote1Res.json();
      expect(demote1Json.success).toBe(true);
      expect(demote1Json.data.role).toBe('user');

      // 2. Attempt to demote the remaining admin (Alice) -> rejected with 403 Forbidden
      const demote2Res = await fetch(`${urlNoProvider}/api/admin/users/${aliceId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlNoProvider,
        },
        body: JSON.stringify({ role: 'user' }),
      });
      expect(demote2Res.status).toBe(403);
      const demote2Json = await demote2Res.json();
      expect(demote2Json.success).toBe(false);
      expect(demote2Json.error.code).toBe('FORBIDDEN');
      expect(demote2Json.error.message).toContain('last active administrator');

      // 3. Assert exactly one active admin remains in the system (Alice)
      const remainingAdmins = db.prepare(`
        SELECT id, username FROM users WHERE role = 'admin' AND status = 'active'
      `).all() as unknown as Array<{ id: string; username: string }>;
      expect(remainingAdmins.length).toBe(1);
      expect(remainingAdmins[0].id).toBe(aliceId);

      // 4. Cleanup temporary user
      db.prepare(`DELETE FROM users WHERE id = ?`).run(secondAdminId);
    });
  });

  // 5. Revoke Sessions Semantics Suite
  describe('5. Revoke Sessions Safe Semantics', () => {
    it('POST /api/admin/users/:id/revoke-sessions on another user revokes their sessions', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/users/${bobId}/revoke-sessions`, {
        method: 'POST',
        headers: { Cookie: aliceCookie, 'X-Enkeep-CSRF': testCsrfToken, Origin: urlNoProvider },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.revokedCount).toBeGreaterThanOrEqual(1);
      expect(json.data.forceLogout).toBe(false);

      // Bob's cookie should now be rejected
      const checkRes = await fetch(`${urlNoProvider}/api/manage/overview`, {
        headers: { Cookie: bobCookie },
      });
      expect(checkRes.status).toBe(401);

      // Re-login Bob
      const loginRes = await fetch(`${urlNoProvider}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Enkeep-CSRF': testCsrfToken, Origin: urlNoProvider },
        body: JSON.stringify({ username: 'bob', password: 'BobPassword123!' }),
      });
      bobCookie = loginRes.headers.get('set-cookie')!;
    });

    it('POST /api/admin/users/:id/revoke-sessions on self returns forceLogout: true with clearing Set-Cookie', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/users/${aliceId}/revoke-sessions`, {
        method: 'POST',
        headers: { Cookie: aliceCookie, 'X-Enkeep-CSRF': testCsrfToken, Origin: urlNoProvider },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.forceLogout).toBe(true);
      expect(res.headers.get('set-cookie')).toContain('enkeep_session=; Path=/; Expires=');

      // Re-login Alice for subsequent tests
      const loginRes = await fetch(`${urlNoProvider}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Enkeep-CSRF': testCsrfToken, Origin: urlNoProvider },
        body: JSON.stringify({ username: 'alice', password: 'AlicePassword123!' }),
      });
      aliceCookie = loginRes.headers.get('set-cookie')!;
    });
  });

  // 6. Cross-Tenant Self-Service Isolation Suite
  describe('6. Cross-Tenant Self-Service Isolation (/api/manage/* & /api/sessions/:id/turns)', () => {
    it('GET /api/manage/overview strictly returns own tenant counts and safe user identity', async () => {
      const res = await fetch(`${urlNoProvider}/api/manage/overview`, {
        headers: { Cookie: bobCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.user.id).toBe(bobId);
      expect(json.data.user.username).toBe('bob');
      expect(json.data.user.role).toBe('user');
      expect(json.data.user.status).toBe('active');
      expect(json.data.user.passwordHash).toBeUndefined();
      expect(json.data.counts.spaces).toBe(1);
      assertNoSensitiveFields(json);
    });

    it('GET /api/manage/tasks strictly returns own tenant tasks only', async () => {
      const res = await fetch(`${urlNoProvider}/api/manage/tasks`, {
        headers: { Cookie: bobCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.items.length).toBe(1);
      expect(json.data.items[0].id).toBe('task-bob-1');
      expect(json.data.items.some((t: any) => t.id === 'task-alice-1')).toBe(false);
      assertNoSensitiveFields(json);
    });

    it('GET /api/manage/deliveries strictly returns own tenant deliveries only', async () => {
      const res = await fetch(`${urlNoProvider}/api/manage/deliveries`, {
        headers: { Cookie: bobCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.items.length).toBe(1);
      const deliv = json.data.items[0];
      expect(deliv.id).toBeUndefined();
      expect(deliv.deliveryId).toBeUndefined();
      expect(deliv.turnId).toBeUndefined();
      expect(deliv.routeId).toBeUndefined();
      expect(deliv.userId).toBeUndefined();
      expect(typeof deliv.status).toBe('string');
      expect(typeof deliv.createdAt).toBe('string');
      expect(typeof deliv.updatedAt).toBe('string');
      assertNoSensitiveFields(json);
    });

    it('GET /api/manage/quotas strictly returns own tenant quotas only', async () => {
      const res = await fetch(`${urlNoProvider}/api/manage/quotas`, {
        headers: { Cookie: bobCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.items.length).toBe(1);
      expect(json.data.items[0].userId).toBe(bobId);
      assertNoSensitiveFields(json);
    });

    it('GET /api/manage/imports strictly returns own tenant imports only', async () => {
      const res = await fetch(`${urlNoProvider}/api/manage/imports`, {
        headers: { Cookie: bobCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.items.length).toBe(1);
      expect(json.data.items[0].userId).toBe(bobId);
      assertNoSensitiveFields(json);
    });

    it('GET /api/sessions/:id/turns rejects foreign session with 404 NOT_FOUND', async () => {
      // Bob attempts to query Alice's session turns
      const res = await fetch(`${urlNoProvider}/api/sessions/${aliceSessionId}/turns`, {
        headers: { Cookie: bobCookie },
      });
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.code).toBe('NOT_FOUND');
    });

    it('GET /api/sessions/:id/turns returns own session turns', async () => {
      const res = await fetch(`${urlNoProvider}/api/sessions/${bobSessionId}/turns`, {
        headers: { Cookie: bobCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.sessionId).toBe(bobSessionId);
      expect(json.data.turns.length).toBeGreaterThanOrEqual(1);
      const turn = json.data.turns[0];
      expect(typeof turn.status).toBe('string');
      expect(turn.turnId).toBeUndefined();
      expect(turn.id).toBeUndefined();
      expect(turn.deliveryId).toBeUndefined();
      expect(turn.routeId).toBeUndefined();
      expect(turn.userId).toBeUndefined();
      expect(turn.executionMode).toBeUndefined();
      expect(turn.spaceId).toBeUndefined();
      assertNoSensitiveFields(json);
    });
  });

  // 7. Runtime Provider Contract Suite (Explicit Unavailable vs Live Provider)
  describe('7. Runtime & Plugin Status Provider Contract', () => {
    it('Server WITHOUT provider returns explicit unavailable on /api/admin/runtime (never static fabricated)', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/runtime`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.available).toBe(false);
      expect(json.data.status).toBe('unavailable');
      expect(json.data.message).toContain('No runtime provider configured');
      assertNoSensitiveFields(json);
    });

    it('Server WITHOUT provider returns explicit unavailable on /api/admin/plugins', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/plugins`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.available).toBe(false);
      expect(json.data.status).toBe('unavailable');
      assertNoSensitiveFields(json);
    });

    it('Server WITH provider returns live provider data on /api/admin/runtime with validated honest fields', async () => {
      const res = await fetch(`${urlWithProvider}/api/admin/runtime`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.available).toBe(true);
      expect(json.data.status).toBe('available');
      expect(json.data.runtimes.length).toBe(2);

      const aliceRt = json.data.runtimes.find((r: any) => r.userId === 'alice');
      expect(aliceRt).toBeDefined();
      expect(aliceRt.networkMode).toBe('none');
      expect(aliceRt.dshReady).toBe(true);
      expect(aliceRt.uptimeSeconds).toBe(120);
      expect(aliceRt.version).toBe('0.1.0-test');
      expect(aliceRt.enkeepBundleLoaded).toBe(true);
      expect(aliceRt.toolsCount).toBe(4);
      expect(aliceRt.toolsOperational).toBe(true);
      expect(aliceRt.toolsUnavailableReason).toBeNull();
      expect(aliceRt.plugins).toEqual({
        receiptStore: true,
        inbound: true,
        eventRelay: true,
        tools: true,
        externalInteraction: true,
        affinityPolicy: true,
        llmAffinity: true,
      });
      assertNoSensitiveFields(json);
    });

    it('Server WITH provider returns schemasRegistered, executionOperational and reason on /api/admin/plugins', async () => {
      const res = await fetch(`${urlWithProvider}/api/admin/plugins`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.available).toBe(true);
      expect(json.data.status).toBe('available');
      expect(json.data.runtimes.length).toBe(2);
      expect(json.data.runtimes[0].toolsCount).toBe(4);
      expect(json.data.runtimes[0].enkeepBundleLoaded).toBe(true);
      expect(json.data.runtimes[0].schemasRegistered).toBe(true);
      expect(json.data.runtimes[0].executionOperational).toBe(true);
      expect(json.data.runtimes[0].reason).toBeNull();
      expect(json.data.runtimes[0].plugins.tools).toBe(true);
      assertNoSensitiveFields(json);
    });

    it('Server WITH provider returns live provider container KPIs on /api/admin/dashboard', async () => {
      const res = await fetch(`${urlWithProvider}/api/admin/dashboard`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);

      // KPI containers contract with attached provider
      expect(json.data.kpis.containers.available).toBe(true);
      expect(json.data.kpis.containers.status).toBe('available');
      expect(json.data.kpis.containers.total).toBe(2);
      expect(json.data.kpis.containers.active).toBe(2);
      expect(json.data.kpis.containers.healthy).toBe(2);

      // Runtime summary
      expect(json.data.runtime.available).toBe(true);
      expect(json.data.runtime.providerAttached).toBe(true);
      expect(json.data.runtime.status).toBe('available');
      expect(json.data.runtime.totalContainers).toBe(2);
      expect(json.data.runtime.activeContainers).toBe(2);
      expect(json.data.runtime.healthyContainers).toBe(2);
      expect(json.data.runtime.summary).toEqual({
        totalRuntimes: 2,
        healthyRuntimes: 2,
        activeRuntimes: 2,
        allDshReady: true,
        toolsOperationalCount: 2,
      });

      assertNoSensitiveFields(json);
    });

    it('Server with LEAKY/FAILING provider returns explicit error status and null container counts (never 0 or leaked error)', async () => {
      const res = await fetch(`${urlLeakyProvider}/api/admin/dashboard`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);

      expect(json.data.kpis.containers.available).toBe(false);
      expect(json.data.kpis.containers.status).toBe('error');
      expect(json.data.kpis.containers.active).toBeNull();
      expect(json.data.kpis.containers.healthy).toBeNull();
      expect(json.data.kpis.containers.total).toBeNull();

      expect(json.data.runtime.available).toBe(false);
      expect(json.data.runtime.providerAttached).toBe(true);
      expect(json.data.runtime.status).toBe('error');
      expect(json.data.runtime.activeContainers).toBeNull();
      expect(json.data.runtime.healthyContainers).toBeNull();
      expect(json.data.runtime.totalContainers).toBeNull();
      expect(json.data.runtime.summary).toBeNull();

      assertNoSensitiveFields(json);
    });

    it('Server WITH provider includes user runtime data in /api/manage/overview without exposing raw containerId', async () => {
      const res = await fetch(`${urlWithProvider}/api/manage/overview`, {
        headers: { Cookie: bobCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.runtime.userId).toBe(bobId);
      expect(json.data.runtime.networkMode).toBe('none');
      expect(json.data.runtime.toolsOperational).toBe(true);
      expect(json.data.runtime.toolsCount).toBe(4);
      expect(json.data.runtime.enkeepBundleLoaded).toBe(true);
      expect(json.data.runtime.containerId).toBeUndefined();
      assertNoSensitiveFields(json);
    });

    it('Server rejects malformed provider runtime items (missing mandatory fields) with status: protocol_error on /api/admin/runtime', async () => {
      const malformedProvider: ManagementRuntimeProvider = {
        async getUserRuntime(): Promise<UserRuntimeStatus | null> {
          return null;
        },
        async listRuntimes(): Promise<UserRuntimeStatus[]> {
          return [
            {
              userId: 'alice',
              available: true,
              status: 'healthy',
              dshReady: true,
              networkMode: 'none',
              // missing uptimeSeconds, version, toolsOperational, enkeepBundleLoaded, etc.
            } as any,
          ];
        },
      };

      const testDb = new DatabaseSync(':memory:');
      const testStorage = new SqlitePlatformStorage(testDb);
      const testMsgStore = new SqliteWebMessageStore(testDb);
      const testGateway = new TestOnlyRuntimeGateway({ storage: testStorage, messageStore: testMsgStore });

      const serverWithMalformed = new PlatformServer({
        database: testDb,
        host: '127.0.0.1',
        port: 0,
        cookieSecret,
        csrfToken: testCsrfToken,
        runtimeGateway: testGateway,
        managementProvider: malformedProvider,
        quotaDefaults: DEMO_TENANT_QUOTA_DEFAULTS,
      });

      const addr = await serverWithMalformed.start();
      await provisionFixtures(testStorage, serverWithMalformed.authService, {
        adminUsername: 'alice',
        adminPassword: 'AlicePassword123!',
        userUsername: 'bob',
        userPassword: 'BobPassword123!',
        disabledUsername: 'charlie',
        disabledPassword: 'CharliePassword123!',
      });
      const loginRes = await fetch(`${addr.url}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Enkeep-CSRF': testCsrfToken, Origin: addr.url },
        body: JSON.stringify({ username: 'alice', password: 'AlicePassword123!' }),
      });
      const authCookie = loginRes.headers.get('set-cookie')!;

      try {
        const res = await fetch(`${addr.url}/api/admin/runtime`, {
          headers: { Cookie: authCookie },
        });
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.success).toBe(true);
        expect(json.data.available).toBe(false);
        expect(json.data.status).toBe('protocol_error');
        expect(json.data.runtimes).toBeUndefined();
      } finally {
        await serverWithMalformed.stop();
      }
    });

    it('Server rejects short or non-64 hex containerId at provider boundary with status: protocol_error', async () => {
      const shortCidProvider: ManagementRuntimeProvider = {
        async getUserRuntime(): Promise<UserRuntimeStatus | null> {
          return null;
        },
        async listRuntimes(): Promise<UserRuntimeStatus[]> {
          return [
            {
              userId: 'alice',
              available: true,
              status: 'healthy',
              containerId: 'short_cid_12345', // Short container ID must be rejected
              networkMode: 'none',
              dshReady: true,
              uptimeSeconds: 10,
              version: '1.0.0',
              enkeepBundleLoaded: true,
              toolsCount: 4,
              plugins: {
                receiptStore: true,
                inbound: true,
                eventRelay: true,
                tools: true,
                externalInteraction: true,
                affinityPolicy: true,
                llmAffinity: true,
              },
              toolsOperational: true,
              toolsUnavailableReason: null,
            },
          ];
        },
      };

      const testDb = new DatabaseSync(':memory:');
      const testStorage = new SqlitePlatformStorage(testDb);
      const testMsgStore = new SqliteWebMessageStore(testDb);
      const testGateway = new TestOnlyRuntimeGateway({ storage: testStorage, messageStore: testMsgStore });

      const serverWithShortCid = new PlatformServer({
        database: testDb,
        host: '127.0.0.1',
        port: 0,
        cookieSecret,
        csrfToken: testCsrfToken,
        runtimeGateway: testGateway,
        managementProvider: shortCidProvider,
        quotaDefaults: DEMO_TENANT_QUOTA_DEFAULTS,
      });

      const addr = await serverWithShortCid.start();
      await provisionFixtures(testStorage, serverWithShortCid.authService, {
        adminUsername: 'alice',
        adminPassword: 'AlicePassword123!',
        userUsername: 'bob',
        userPassword: 'BobPassword123!',
        disabledUsername: 'charlie',
        disabledPassword: 'CharliePassword123!',
      });
      const loginRes = await fetch(`${addr.url}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Enkeep-CSRF': testCsrfToken, Origin: addr.url },
        body: JSON.stringify({ username: 'alice', password: 'AlicePassword123!' }),
      });
      const authCookie = loginRes.headers.get('set-cookie')!;

      try {
        const res = await fetch(`${addr.url}/api/admin/runtime`, {
          headers: { Cookie: authCookie },
        });
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.success).toBe(true);
        expect(json.data.available).toBe(false);
        expect(json.data.status).toBe('protocol_error');
        expect(json.data.runtimes).toBeUndefined();
      } finally {
        await serverWithShortCid.stop();
      }
    });

    it('Server supports core healthy runtime with toolsOperational: false and sanitized reason', async () => {
      const disabledToolsProvider: ManagementRuntimeProvider = {
        async getUserRuntime(): Promise<UserRuntimeStatus | null> {
          return null;
        },
        async listRuntimes(): Promise<UserRuntimeStatus[]> {
          return [
            {
              userId: 'alice',
              status: 'ok',
              networkMode: 'none',
              dshReady: true,
              uptimeSeconds: 42,
              version: '1.0.0',
              enkeepBundleLoaded: true,
              toolsCount: 4,
              plugins: {
                receiptStore: true,
                inbound: true,
                eventRelay: true,
                tools: true,
                externalInteraction: true,
                affinityPolicy: true,
                llmAffinity: true,
              },
              toolsOperational: false,
              toolsUnavailableReason: 'PLATFORM_CLIENT_UNAVAILABLE',
            },
          ];
        },
      };

      const testDb = new DatabaseSync(':memory:');
      const testStorage = new SqlitePlatformStorage(testDb);
      const testMsgStore = new SqliteWebMessageStore(testDb);
      const testGateway = new TestOnlyRuntimeGateway({ storage: testStorage, messageStore: testMsgStore });

      const serverWithDisabledTools = new PlatformServer({
        database: testDb,
        host: '127.0.0.1',
        port: 0,
        cookieSecret,
        csrfToken: testCsrfToken,
        runtimeGateway: testGateway,
        managementProvider: disabledToolsProvider,
        quotaDefaults: DEMO_TENANT_QUOTA_DEFAULTS,
      });

      const addr = await serverWithDisabledTools.start();
      await provisionFixtures(testStorage, serverWithDisabledTools.authService, {
        adminUsername: 'alice',
        adminPassword: 'AlicePassword123!',
        userUsername: 'bob',
        userPassword: 'BobPassword123!',
        disabledUsername: 'charlie',
        disabledPassword: 'CharliePassword123!',
      });
      const loginRes = await fetch(`${addr.url}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Enkeep-CSRF': testCsrfToken, Origin: addr.url },
        body: JSON.stringify({ username: 'alice', password: 'AlicePassword123!' }),
      });
      const authCookie = loginRes.headers.get('set-cookie')!;

      try {
        const res = await fetch(`${addr.url}/api/admin/runtime`, {
          headers: { Cookie: authCookie },
        });
        expect(res.status).toBe(200);
        const resData = await res.json();
        expect(resData.success).toBe(true);
        expect(resData.data.available).toBe(true);
        expect(resData.data.status).toBe('available');
        expect(resData.data.runtimes[0].status).toBe('ok');
        expect(resData.data.runtimes[0].toolsOperational).toBe(false);
        expect(resData.data.runtimes[0].toolsUnavailableReason).toBe('PLATFORM_CLIENT_UNAVAILABLE');
        assertNoSensitiveFields(resData);

        const pluginsRes = await fetch(`${addr.url}/api/admin/plugins`, {
          headers: { Cookie: authCookie },
        });
        expect(pluginsRes.status).toBe(200);
        const pluginsJson = await pluginsRes.json();
        expect(pluginsJson.data.runtimes[0].schemasRegistered).toBe(true); // plugins.tools === true && toolsCount >= 4
        expect(pluginsJson.data.runtimes[0].executionOperational).toBe(false);
        expect(pluginsJson.data.runtimes[0].reason).toBe('PLATFORM_CLIENT_UNAVAILABLE');
        assertNoSensitiveFields(pluginsJson);
      } finally {
        await serverWithDisabledTools.stop();
      }
    });

    it('GET /readiness splits operations.producer and operations.worker with authentic worker status', async () => {
      const res = await fetch(`${urlNoProvider}/readiness`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.operations).toBeDefined();
      expect(Object.keys(json.data.operations).sort()).toEqual(['producer', 'worker']);
      expect(json.data.operations.producer).toEqual({
        available: true,
        unavailableReason: null,
      });
      expect(json.data.operations.worker).toEqual({
        available: false,
        running: false,
        unavailableReason: 'WORKER_DISABLED',
      });
    });

    it('rejects malformed runtime records with extra plugin keys or missing uptimeSeconds', async () => {
      const corruptProvider = {
        getUserRuntime: async () => null,
        listRuntimes: async () => [
          {
            userId: 'alice',
            available: true,
            status: 'healthy',
            networkMode: 'none',
            dshReady: true,
            uptime: 100, // legacy alias instead of uptimeSeconds
            version: '1.0.0',
            enkeepBundleLoaded: true,
            toolsCount: 4,
            plugins: {
              receiptStore: true,
              inbound: true,
              eventRelay: true,
              tools: true,
              externalInteraction: true,
              affinityPolicy: true,
              llmAffinity: true,
            },
            toolsOperational: true,
            toolsUnavailableReason: null,
          } as any,
        ],
      };

      const testDb = new DatabaseSync(':memory:');
      const testStorage = new SqlitePlatformStorage(testDb);
      const testMsgStore = new SqliteWebMessageStore(testDb);
      const testGateway = new TestOnlyRuntimeGateway({ storage: testStorage, messageStore: testMsgStore });

      const serverWithCorrupt = new PlatformServer({
        database: testDb,
        host: '127.0.0.1',
        port: 0,
        cookieSecret,
        csrfToken: testCsrfToken,
        runtimeGateway: testGateway,
        managementProvider: corruptProvider,
        quotaDefaults: DEMO_TENANT_QUOTA_DEFAULTS,
      });

      const addr = await serverWithCorrupt.start();
      await provisionFixtures(testStorage, serverWithCorrupt.authService, {
        adminUsername: 'alice',
        adminPassword: 'AlicePassword123!',
        userUsername: 'bob',
        userPassword: 'BobPassword123!',
        disabledUsername: 'charlie',
        disabledPassword: 'CharliePassword123!',
      });
      const loginRes = await fetch(`${addr.url}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Enkeep-CSRF': testCsrfToken, Origin: addr.url },
        body: JSON.stringify({ username: 'alice', password: 'AlicePassword123!' }),
      });
      const authCookie = loginRes.headers.get('set-cookie')!;

      try {
        const res = await fetch(`${addr.url}/api/admin/runtime`, {
          headers: { Cookie: authCookie },
        });
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.data.available).toBe(false);
        expect(json.data.status).toBe('protocol_error');
      } finally {
        await serverWithCorrupt.stop();
      }
    });
  });

  // 8. CSRF Validation on State-Changing Admin Endpoints
  describe('8. CSRF Validation on State-Changing Admin Endpoints', () => {
    it('PATCH /api/admin/users/:id fails with 403 on missing or invalid CSRF token', async () => {
      const resNoCsrf = await fetch(`${urlNoProvider}/api/admin/users/${bobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: aliceCookie, Origin: urlNoProvider },
        body: JSON.stringify({ displayName: 'No CSRF Name' }),
      });
      expect(resNoCsrf.status).toBe(403);
      const jsonNoCsrf = await resNoCsrf.json();
      expect(jsonNoCsrf.error.code).toBe('CSRF_VIOLATION');

      const resBadCsrf = await fetch(`${urlNoProvider}/api/admin/users/${bobId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': 'invalid-csrf-token-that-is-wrong-length-or-value!',
          Origin: urlNoProvider,
        },
        body: JSON.stringify({ displayName: 'Bad CSRF Name' }),
      });
      expect(resBadCsrf.status).toBe(403);
    });

    it('POST /api/admin/users/:id/revoke-sessions fails with 403 on missing or invalid CSRF token', async () => {
      const resNoCsrf = await fetch(`${urlNoProvider}/api/admin/users/${bobId}/revoke-sessions`, {
        method: 'POST',
        headers: { Cookie: aliceCookie, Origin: urlNoProvider },
      });
      expect(resNoCsrf.status).toBe(403);

      const resBadCsrf = await fetch(`${urlNoProvider}/api/admin/users/${bobId}/revoke-sessions`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': 'invalid-csrf-token-that-is-wrong-length-or-value!',
          Origin: urlNoProvider,
        },
      });
      expect(resBadCsrf.status).toBe(403);
    });
  });

  // 9. Strict Pagination and Query Parameter Validation
  describe('9. Strict Pagination and Query Parameter Validation', () => {
    it('rejects malformed, negative, zero, and too-large pagination limits', async () => {
      const badLimits = ['-5', '0', '101', 'abc', '10.5', ''];
      for (const badLimit of badLimits) {
        const res = await fetch(`${urlNoProvider}/api/admin/users?limit=${badLimit}`, {
          headers: { Cookie: aliceCookie },
        });
        expect(res.status, `Expected limit="${badLimit}" to return 400`).toBe(400);
        const json = await res.json();
        expect(json.success).toBe(false);
        expect(json.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('rejects malformed, negative, and non-integer pagination offsets', async () => {
      const badOffsets = ['-1', 'abc', '5.5', ''];
      for (const badOffset of badOffsets) {
        const res = await fetch(`${urlNoProvider}/api/admin/users?offset=${badOffset}`, {
          headers: { Cookie: aliceCookie },
        });
        expect(res.status, `Expected offset="${badOffset}" to return 400`).toBe(400);
        const json = await res.json();
        expect(json.success).toBe(false);
        expect(json.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('accepts valid boundary limits and offsets (1..100, >=0)', async () => {
      const res1 = await fetch(`${urlNoProvider}/api/admin/users?limit=1&offset=0`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res1.status).toBe(200);
      const json1 = await res1.json();
      expect(json1.data.limit).toBe(1);
      expect(json1.data.offset).toBe(0);

      const res100 = await fetch(`${urlNoProvider}/api/admin/users?limit=100&offset=5`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res100.status).toBe(200);
      const json100 = await res100.json();
      expect(json100.data.limit).toBe(100);
      expect(json100.data.offset).toBe(5);
    });

    it('rejects invalid query enum filters on admin and manage routes', async () => {
      // Invalid user role
      const resRole = await fetch(`${urlNoProvider}/api/admin/users?role=superadmin`, {
        headers: { Cookie: aliceCookie },
      });
      expect(resRole.status).toBe(400);

      // Invalid user status
      const resStatus = await fetch(`${urlNoProvider}/api/admin/users?status=banned`, {
        headers: { Cookie: aliceCookie },
      });
      expect(resStatus.status).toBe(400);

      // Invalid task status
      const resTaskStatus = await fetch(`${urlNoProvider}/api/admin/tasks?status=exploding`, {
        headers: { Cookie: aliceCookie },
      });
      expect(resTaskStatus.status).toBe(400);

      // Invalid task priority
      const resTaskPriority = await fetch(`${urlNoProvider}/api/admin/tasks?priority=supreme`, {
        headers: { Cookie: aliceCookie },
      });
      expect(resTaskPriority.status).toBe(400);

      // Invalid delivery status
      const resDelivStatus = await fetch(`${urlNoProvider}/api/admin/deliveries?status=lost`, {
        headers: { Cookie: aliceCookie },
      });
      expect(resDelivStatus.status).toBe(400);

      // Invalid audit action
      const resAudit = await fetch(`${urlNoProvider}/api/admin/audit?action=hack_root`, {
        headers: { Cookie: aliceCookie },
      });
      expect(resAudit.status).toBe(400);
    });

    it('validates userId query parameters with path ID validator', async () => {
      const resBadUser = await fetch(`${urlNoProvider}/api/admin/spaces?userId=../invalid-path`, {
        headers: { Cookie: aliceCookie },
      });
      expect(resBadUser.status).toBe(400);
      const json = await resBadUser.json();
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });
  });

  // 10. Mutation Body Validation (Empty PATCH, Revoke Body Rejection)
  describe('10. Mutation Body Validation', () => {
    it('PATCH /api/admin/users/:id rejects empty request body with 400', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/users/${bobId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlNoProvider,
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('VALIDATION_ERROR');
      expect(json.error.message).toContain('empty');
    });

    it('POST /api/admin/users/:id/revoke-sessions rejects non-empty body and unknown fields safely', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/users/${bobId}/revoke-sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlNoProvider,
        },
        body: JSON.stringify({ unexpectedKey: 'malicious-data' }),
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('VALIDATION_ERROR');
      expect(json.error.message).toContain('body');
    });

    it('POST /api/admin/users/:id/revoke-sessions accepts empty body', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/users/${bobId}/revoke-sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlNoProvider,
        },
        body: '',
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);

      // Re-login Bob for subsequent tests
      const loginRes = await fetch(`${urlNoProvider}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Enkeep-CSRF': testCsrfToken, Origin: urlNoProvider },
        body: JSON.stringify({ username: 'bob', password: 'BobPassword123!' }),
      });
      bobCookie = loginRes.headers.get('set-cookie')!;
    });
  });

  // 11. Unknown Admin Route 404 & Privileged Integration
  describe('11. Unknown Admin Route 404 & Privileged Integration', () => {
    it('Unknown /api/admin/* route returns 401 for unauthenticated requests', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/unknown-endpoint-123`);
      expect(res.status).toBe(401);
    });

    it('Unknown /api/admin/* route returns 403 for non-admin users (Bob)', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/unknown-endpoint-123`, {
        headers: { Cookie: bobCookie },
      });
      expect(res.status).toBe(403);
    });

    it('Unknown /api/admin/* route returns 404 NOT_FOUND for admin users (Alice) — not fabricated 200', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/unknown-endpoint-123`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('NOT_FOUND');
    });

    it('Preserves privileged /api/dsh/* integration behavior and status for admin (Alice)', async () => {
      const res = await fetch(`${urlNoProvider}/api/dsh/status`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.mode).toBe('privileged');
      expect(json.data.capability).toBe('status_only');
      expect(json.data.directExecution).toBe(false);
      expect(json.data.adminUser).toBe('alice');
      expect(json.data.message).toContain('Direct execution API is not supported');
    });

    it('Rejects mutation requests (POST/PUT/DELETE) on /api/dsh/* with 405 Method Not Allowed (no fake execution proxy)', async () => {
      const res = await fetch(`${urlNoProvider}/api/dsh/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlNoProvider,
        },
        body: JSON.stringify({ command: 'whoami' }),
      });
      expect(res.status).toBe(405);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('METHOD_NOT_ALLOWED');
      expect(json.error.message).toContain('Direct execution mutation via /api/dsh/* is not supported');
    });
  });

  // 12. Provider Failure Exception Safety & No Path/Secret Leakage
  describe('12. Provider Failure Exception Safety & Redaction', () => {
    it('Leaky failing provider does not leak absolute paths, secrets, or stack traces on /api/admin/runtime', async () => {
      const res = await fetch(`${urlLeakyProvider}/api/admin/runtime`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.available).toBe(false);
      expect(json.data.status).toBe('error');
      expect(json.data.message).toBe('Runtime provider unavailable');
      assertNoSensitiveFields(json);
    });

    it('Leaky failing provider does not leak absolute paths, secrets, or stack traces on /api/admin/plugins', async () => {
      const res = await fetch(`${urlLeakyProvider}/api/admin/plugins`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.available).toBe(false);
      expect(json.data.status).toBe('error');
      expect(json.data.message).toBe('Plugins provider unavailable');
      assertNoSensitiveFields(json);
    });
  });

  // 13. Data Minimization, Redaction & Safe Presentation
  describe('13. Data Minimization, Redaction & Safe Presentation', () => {
    it('GET /api/admin/tasks omits idempotencyKey, description, and replaces raw error with errorPresent and safe errorCode', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/tasks`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);

      const maliciousTask = json.data.items.find((t: any) => t.id === 'task-malicious-1');
      expect(maliciousTask).toBeDefined();
      expect(maliciousTask.errorPresent).toBe(true);
      expect(maliciousTask.errorCode).toBe('TASK_INTERNAL_ERROR');
      expect(maliciousTask.idempotencyKey).toBeUndefined();
      expect(maliciousTask.description).toBeUndefined();
      expect(maliciousTask.error).toBeUndefined();

      for (const item of json.data.items) {
        expect(item.description).toBeUndefined();
        expect(item.idempotencyKey).toBeUndefined();
      }

      assertNoSensitiveFields(json);
    });

    it('GET /api/admin/deliveries returns safe {status, createdAt, updatedAt} without internal IDs', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/deliveries`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);

      for (const deliv of json.data.items) {
        expect(deliv.id).toBeUndefined();
        expect(deliv.deliveryId).toBeUndefined();
        expect(deliv.turnId).toBeUndefined();
        expect(deliv.routeId).toBeUndefined();
        expect(deliv.userId).toBeUndefined();
        expect(deliv.username).toBeUndefined();
        expect(deliv.error).toBeUndefined();
        expect(deliv.payload).toBeUndefined();
        expect(typeof deliv.status).toBe('string');
        expect(typeof deliv.createdAt).toBe('string');
        expect(typeof deliv.updatedAt).toBe('string');
      }

      assertNoSensitiveFields(json);
    });

    it('GET /api/sessions/:id/turns returns safe {status, startedAt, finishedAt} without internal IDs or executionMode', async () => {
      const res = await fetch(`${urlNoProvider}/api/sessions/${bobSessionId}/turns`, {
        headers: { Cookie: bobCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);

      for (const turn of json.data.turns) {
        expect(turn.turnId).toBeUndefined();
        expect(turn.id).toBeUndefined();
        expect(turn.deliveryId).toBeUndefined();
        expect(turn.routeId).toBeUndefined();
        expect(turn.userId).toBeUndefined();
        expect(turn.executionMode).toBeUndefined();
        expect(turn.spaceId).toBeUndefined();
        expect(turn.error).toBeUndefined();
        expect(typeof turn.status).toBe('string');
        expect(turn.startedAt === null || typeof turn.startedAt === 'string').toBe(true);
        expect(turn.finishedAt === null || typeof turn.finishedAt === 'string').toBe(true);
      }

      assertNoSensitiveFields(json);
    });

    it('GET /api/admin/spaces omits folderAvailable, folder, and executionMode safely', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/spaces`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);

      const absoluteSpace = json.data.items.find((s: any) => s.id === 'space-absolute-1');
      expect(absoluteSpace).toBeDefined();
      expect(absoluteSpace.folderAvailable).toBeUndefined();
      expect(absoluteSpace.folder).toBeUndefined();
      expect(absoluteSpace.executionMode).toBeUndefined();
      expect(typeof absoluteSpace.name).toBe('string');
      expect(typeof absoluteSpace.username).toBe('string');

      for (const s of json.data.items) {
        expect(s.folderAvailable).toBeUndefined();
        expect(s.folder).toBeUndefined();
        expect(s.executionMode).toBeUndefined();
      }

      assertNoSensitiveFields(json);
    });

    it('GET /api/admin/audit indicates metadataAvailable without leaking details or payload objects', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/audit`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);

      const secretAudit = json.data.items.find((a: any) => a.id === 'audit-secret-1');
      expect(secretAudit).toBeDefined();
      expect(secretAudit.metadataAvailable).toBe(true);
      expect(secretAudit.details).toBeUndefined();

      for (const a of json.data.items) {
        expect(a.details).toBeUndefined();
        expect(typeof a.metadataAvailable).toBe('boolean');
      }

      assertNoSensitiveFields(json);
    });
  });

  // 14. Strict Unknown Options Validation
  describe('14. Strict Unknown Options Validation', () => {
    it('PlatformServer rejects unknown options (deny unknown keys)', () => {
      expect(() => {
        new PlatformServer({
          database: db,
          host: '127.0.0.1',
          port: 0,
          cookieSecret,
          csrfToken: testCsrfToken,
          runtimeGateway: new TestOnlyRuntimeGateway({ storage, messageStore: new SqliteWebMessageStore(db) }),
          // @ts-expect-error invalid unknown property
          invalidUnknownOptionKey: 'unsafe-value',
        });
      }).toThrow(/Unknown configuration option "invalidUnknownOptionKey" passed to PlatformServer/);
    });
  });

  // 15. Rigorous Converter, Error Propagation & Anti-Leak Invariant Tests
  describe('15. Rigorous Converter, Error Propagation & Anti-Leak Invariants', () => {
    it('unbracketed raw error returns errorPresent: true, errorCode: null without faking EXECUTION_ERROR', async () => {
      db.prepare(`
        INSERT INTO platform_tasks (
          id, user_id, title, priority, status, created_at, updated_at, error
        ) VALUES (
          'task-unbracketed-err', ?, 'Unbracketed Error Task', 'medium', 'failed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'raw error without bracketed code at /Users/secret/file.ts'
        )
      `).run(aliceId);

      const res = await fetch(`${urlNoProvider}/api/admin/tasks`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);

      const task = json.data.items.find((t: any) => t.id === 'task-unbracketed-err');
      expect(task).toBeDefined();
      expect(task.errorPresent).toBe(true);
      expect(task.errorCode).toBeNull();
      // Ensure no raw error leak
      expect(task.error).toBeUndefined();
      assertNoSensitiveFields(json);
    });

    it('fixed import receipts return factual fields without fabricated IDs and never leak canonicalHash, sourceFingerprint, or targetDsh', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/imports`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.items.length).toBeGreaterThan(0);

      for (const item of json.data.items) {
        expect(item.id).toBeUndefined();
        expect(item.idAlgorithm).toBeUndefined();
        expect(item.userId).toBeDefined();
        expect(item.username).toBeDefined();
        expect(item.importerVersion).toBeDefined();
        expect(item.status).toBe('completed');
        expect(item.canonicalHash).toBeUndefined();
        expect(item.sourceFingerprint).toBeUndefined();
        expect(item.targetDsh).toBeUndefined();
        expect(typeof item.importedMessagesCount).toBe('number');
        expect(typeof item.sourceChatsCount).toBe('number');
        expect(typeof item.sessionFormat).toBe('number');
      }

      assertNoSensitiveFields(json);
    });

    it('quota management returns aggregated activeReservations without leaking raw reservation IDs or bundle IDs', async () => {
      db.prepare(`
        INSERT INTO quota_reservations (
          id, user_id, resource, amount, status, expires_at, created_at
        ) VALUES (
          'raw-res-secret-id-1234', ?, 'messages', 5, 'reserved', datetime('now', '+1 hour'), CURRENT_TIMESTAMP
        )
      `).run(bobId);

      const res = await fetch(`${urlNoProvider}/api/admin/quotas`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);

      const bobQuota = json.data.items.find((q: any) => q.userId === bobId);
      expect(bobQuota).toBeDefined();
      expect(bobQuota.activeReservations.length).toBeGreaterThan(0);

      for (const r of bobQuota.activeReservations) {
        expect(r.resource).toBeDefined();
        expect(r.status).toBe('reserved');
        expect(typeof r.count).toBe('number');
        expect(typeof r.amount).toBe('number');
        // Raw identifiers must never be exposed
        expect(r.id).toBeUndefined();
        expect(r.bundleId).toBeUndefined();
        expect(r.bundle_id).toBeUndefined();
        expect(r.expiresAt).toBeUndefined();
      }

      assertNoSensitiveFields(json);
    });

    it('admin space folder strictly omits folderAvailable, folder, and executionMode', async () => {
      db.prepare(`
        INSERT INTO spaces (id, user_id, name, folder, execution_mode, created_at, updated_at)
        VALUES
          ('space-canonical-slug-1', ?, 'Canonical Space', 'projects/sub-proj/app', 'container', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
          ('space-corrupt-folder-1', ?, 'Corrupt Space', '../traversal/evil', 'container', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
          ('space-empty-folder-1', ?, 'Empty Folder Space', '', 'container', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(aliceId, aliceId, aliceId);

      const res = await fetch(`${urlNoProvider}/api/admin/spaces`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);

      const canonicalSpace = json.data.items.find((s: any) => s.id === 'space-canonical-slug-1');
      expect(canonicalSpace).toBeDefined();
      expect(canonicalSpace.folderAvailable).toBeUndefined();
      expect(canonicalSpace.folder).toBeUndefined();
      expect(canonicalSpace.executionMode).toBeUndefined();

      const corruptSpace = json.data.items.find((s: any) => s.id === 'space-corrupt-folder-1');
      expect(corruptSpace).toBeDefined();
      expect(corruptSpace.folderAvailable).toBeUndefined();
      expect(corruptSpace.folder).toBeUndefined();
      expect(corruptSpace.executionMode).toBeUndefined();

      const emptySpace = json.data.items.find((s: any) => s.id === 'space-empty-folder-1');
      expect(emptySpace).toBeDefined();
      expect(emptySpace.folderAvailable).toBeUndefined();
      expect(emptySpace.folder).toBeUndefined();
      expect(emptySpace.executionMode).toBeUndefined();

      assertNoSensitiveFields(json);
    });

    it('corrupt database rows throw internal 500 error and propagate without faking defaults', async () => {
      const corruptDb = new DatabaseSync(':memory:');
      corruptDb.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY, username TEXT, role TEXT, status TEXT, display_name TEXT, locale TEXT NOT NULL DEFAULT 'en', theme TEXT NOT NULL DEFAULT 'dark', must_change_password INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT
        );
        CREATE TABLE spaces (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, folder TEXT, execution_mode TEXT, created_at TEXT, updated_at TEXT);
        CREATE TABLE session_routes (id TEXT PRIMARY KEY, space_id TEXT, user_id TEXT, channel TEXT, account_id TEXT, native_context_id TEXT, peer_id TEXT, dsh_session_id TEXT, execution_mode TEXT, created_at TEXT, updated_at TEXT);
        CREATE TABLE user_sessions (id TEXT PRIMARY KEY, user_id TEXT, expires_at TEXT, revoked_at TEXT, created_at TEXT);
        CREATE TABLE web_messages (id TEXT PRIMARY KEY, session_id TEXT, user_id TEXT, role TEXT, content TEXT, status TEXT, route_key TEXT, created_at TEXT);
        CREATE TABLE platform_tasks (id TEXT PRIMARY KEY, user_id TEXT, title TEXT, priority TEXT, status TEXT, due_date TEXT, schedule_type TEXT NOT NULL DEFAULT 'once', cron_expression TEXT, interval_seconds INT, next_run_at TEXT, created_at TEXT, updated_at TEXT, completed_at TEXT, error TEXT);
        CREATE TABLE task_schedules (id TEXT PRIMARY KEY, task_id TEXT, user_id TEXT, enabled INT, paused_at TEXT, created_at TEXT, updated_at TEXT);
        CREATE TABLE delivery_inbox (id TEXT PRIMARY KEY, user_id TEXT, route_id TEXT, message_id TEXT, delivery_id TEXT, status TEXT, error TEXT, received_at TEXT, processed_at TEXT, turn_id TEXT, created_at TEXT, updated_at TEXT);
        CREATE TABLE fixed_import_receipts (user_id TEXT, source_fingerprint TEXT, importer_version TEXT, id_algorithm TEXT, session_format INT, source_chats_count INT, source_messages_count INT, imported_messages_count INT, dropped_messages_count INT, attachments_count INT, created_at TEXT, PRIMARY KEY (user_id, source_fingerprint));
        CREATE TABLE auth_audit_log (id TEXT PRIMARY KEY, user_id TEXT, username TEXT, action TEXT, ip_address TEXT, user_agent TEXT, details TEXT, created_at TEXT);
        CREATE TABLE _schema_migrations (version INT PRIMARY KEY, name TEXT, checksum TEXT, applied_at TEXT);
      `);

      const corruptCds = new (await import('../src/management/console-data-source.js')).ConsoleDataSource({
        database: corruptDb,
        storage: storage,
        quotaDefaults: {
          turns: 100,
          messages: 100,
          tokens: 65536,
          storage_bytes: 10485760,
          api_calls: 500,
          resetInterval: 'none',
        },
      });

      // 1. Corrupt role enum in users table
      corruptDb.prepare(`
        INSERT INTO users (id, username, role, status, created_at, updated_at)
        VALUES ('u_bad', 'bad_user', 'super_admin_invalid', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run();

      await expect(corruptCds.listUsers()).rejects.toThrow(/Database storage corruption: invalid enum value/);

      // 2. Corrupt task priority in tasks table
      corruptDb.prepare(`
        INSERT INTO platform_tasks (id, user_id, title, priority, status, created_at, updated_at)
        VALUES ('t_bad', 'u_bad', 'Corrupt Task', 'nonexistent_priority', 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run();

      await expect(corruptCds.listTasks()).rejects.toThrow(/Database storage corruption: invalid enum value/);

      // 3. Corrupt delivery timestamp in delivery_inbox
      corruptDb.prepare(`
        INSERT INTO delivery_inbox (id, user_id, route_id, message_id, delivery_id, status, received_at, created_at, updated_at)
        VALUES ('d_bad', 'u_bad', 'r1', 'm1', 'deliv1', 'held', CURRENT_TIMESTAMP, 'not_a_valid_timestamp', CURRENT_TIMESTAMP)
      `).run();

      await expect(corruptCds.listDeliveries()).rejects.toThrow(/Database storage corruption: invalid timestamp format/);

      // 4. Missing _schema_migrations table propagates DB error on getDashboardCounts
      corruptDb.exec(`DROP TABLE _schema_migrations;`);
      await expect(corruptCds.getDashboardCounts()).rejects.toThrow(/no such table: _schema_migrations/i);
    });

    it('admin dashboard reports factual process uptime, response timestamp, and explicit container KPI unavailable', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/dashboard`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);

      expect(typeof json.data.uptime).toBe('number');
      expect(json.data.uptime).toBeGreaterThanOrEqual(0);

      expect(typeof json.data.timestamp).toBe('string');
      expect(Number.isNaN(new Date(json.data.timestamp).getTime())).toBe(false);

      expect(json.data.kpis.containers).toEqual({
        available: false,
        active: null,
        healthy: null,
        total: null,
        status: 'unavailable',
      });

      expect(json.data.runtime).toEqual({
        available: false,
        providerAttached: false,
        status: 'unavailable',
        totalContainers: null,
        activeContainers: null,
        healthyContainers: null,
        summary: null,
      });

      assertNoSensitiveFields(json);
    });
  });

  // 16. Negative DTO Keys, Malformed Audit Metadata & Transaction Commit Order Suite
  describe('16. Negative DTO Keys, Malformed Audit Metadata & Transaction Commit Order', () => {
    it('spaces DTO strictly excludes folderAvailable, folder, and executionMode across all items', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/spaces`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.items.length).toBeGreaterThan(0);

      for (const space of json.data.items) {
        expect(space).toHaveProperty('id');
        expect(space).toHaveProperty('userId');
        expect(space).toHaveProperty('username');
        expect(space).toHaveProperty('name');
        expect(space).toHaveProperty('createdAt');
        expect(space).toHaveProperty('updatedAt');
        expect(space).toHaveProperty('sessionCount');

        // Strictly forbidden negative keys
        expect(space).not.toHaveProperty('folderAvailable');
        expect(space).not.toHaveProperty('folder');
        expect(space).not.toHaveProperty('executionMode');
        expect(space).not.toHaveProperty('execution_mode');
        expect(space).not.toHaveProperty('folder_available');
      }
    });

    it('deliveries DTO strictly excludes internal IDs (deliveryId, inboxId, turnId, routeId, messageId, userId)', async () => {
      const res = await fetch(`${urlNoProvider}/api/admin/deliveries`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.items.length).toBeGreaterThan(0);

      for (const deliv of json.data.items) {
        expect(deliv).toHaveProperty('status');
        expect(deliv).toHaveProperty('createdAt');
        expect(deliv).toHaveProperty('updatedAt');

        // Strictly forbidden negative keys
        expect(deliv).not.toHaveProperty('id');
        expect(deliv).not.toHaveProperty('deliveryId');
        expect(deliv).not.toHaveProperty('delivery_id');
        expect(deliv).not.toHaveProperty('turnId');
        expect(deliv).not.toHaveProperty('turn_id');
        expect(deliv).not.toHaveProperty('routeId');
        expect(deliv).not.toHaveProperty('route_id');
        expect(deliv).not.toHaveProperty('messageId');
        expect(deliv).not.toHaveProperty('message_id');
        expect(deliv).not.toHaveProperty('userId');
        expect(deliv).not.toHaveProperty('user_id');
        expect(deliv).not.toHaveProperty('username');
        expect(deliv).not.toHaveProperty('payload');
      }
    });

    it('session turns DTO strictly excludes turnId, delivery, route, user, executionMode', async () => {
      const res = await fetch(`${urlNoProvider}/api/sessions/${bobSessionId}/turns`, {
        headers: { Cookie: bobCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.turns.length).toBeGreaterThan(0);

      for (const turn of json.data.turns) {
        expect(turn).toHaveProperty('status');
        expect(turn).toHaveProperty('startedAt');
        expect(turn).toHaveProperty('finishedAt');

        // Strictly forbidden negative keys
        expect(turn).not.toHaveProperty('id');
        expect(turn).not.toHaveProperty('turnId');
        expect(turn).not.toHaveProperty('turn_id');
        expect(turn).not.toHaveProperty('deliveryId');
        expect(turn).not.toHaveProperty('delivery_id');
        expect(turn).not.toHaveProperty('routeId');
        expect(turn).not.toHaveProperty('route_id');
        expect(turn).not.toHaveProperty('userId');
        expect(turn).not.toHaveProperty('user_id');
        expect(turn).not.toHaveProperty('executionMode');
        expect(turn).not.toHaveProperty('execution_mode');
        expect(turn).not.toHaveProperty('spaceId');
        expect(turn).not.toHaveProperty('space_id');
      }
    });

    it('audit metadata parsing: null/empty details => metadataAvailable: false', async () => {
      const auditDb = new DatabaseSync(':memory:');
      auditDb.exec(`
        CREATE TABLE auth_audit_log (
          id TEXT PRIMARY KEY, user_id TEXT, username TEXT, action TEXT,
          ip_address TEXT, user_agent TEXT, details TEXT, created_at TEXT
        );
        CREATE TABLE _schema_migrations (version INT PRIMARY KEY, name TEXT, checksum TEXT, applied_at TEXT);
      `);

      const auditCds = new (await import('../src/management/console-data-source.js')).ConsoleDataSource({
        database: auditDb,
        storage: storage,
        quotaDefaults: {
          turns: 100,
          messages: 100,
          tokens: 65536,
          storage_bytes: 10485760,
          api_calls: 500,
          resetInterval: 'none',
        },
      });

      auditDb.prepare(`
        INSERT INTO auth_audit_log (id, user_id, username, action, ip_address, details, created_at)
        VALUES
          ('audit_null', 'u1', 'alice', 'login', '127.0.0.1', NULL, CURRENT_TIMESTAMP),
          ('audit_empty', 'u1', 'alice', 'logout', '127.0.0.1', '', CURRENT_TIMESTAMP),
          ('audit_spaces', 'u1', 'alice', 'refresh', '127.0.0.1', '   ', CURRENT_TIMESTAMP)
      `).run();

      const result = await auditCds.listAuditLogs();
      expect(result.items.length).toBe(3);
      for (const item of result.items) {
        expect(item.metadataAvailable).toBe(false);
        expect(item).not.toHaveProperty('details');
      }
    });

    it('audit metadata parsing: valid JSON object => metadataAvailable: true without raw details', async () => {
      const auditDb = new DatabaseSync(':memory:');
      auditDb.exec(`
        CREATE TABLE auth_audit_log (
          id TEXT PRIMARY KEY, user_id TEXT, username TEXT, action TEXT,
          ip_address TEXT, user_agent TEXT, details TEXT, created_at TEXT
        );
        CREATE TABLE _schema_migrations (version INT PRIMARY KEY, name TEXT, checksum TEXT, applied_at TEXT);
      `);

      const auditCds = new (await import('../src/management/console-data-source.js')).ConsoleDataSource({
        database: auditDb,
        storage: storage,
        quotaDefaults: {
          turns: 100,
          messages: 100,
          tokens: 65536,
          storage_bytes: 10485760,
          api_calls: 500,
          resetInterval: 'none',
        },
      });

      auditDb.prepare(`
        INSERT INTO auth_audit_log (id, user_id, username, action, ip_address, details, created_at)
        VALUES
          ('audit_obj1', 'u1', 'alice', 'login', '127.0.0.1', '{"mfa":true,"method":"totp"}', CURRENT_TIMESTAMP),
          ('audit_obj2', 'u1', 'alice', 'update', '127.0.0.1', '{}', CURRENT_TIMESTAMP)
      `).run();

      const result = await auditCds.listAuditLogs();
      expect(result.items.length).toBe(2);
      for (const item of result.items) {
        expect(item.metadataAvailable).toBe(true);
        expect(item).not.toHaveProperty('details');
      }
    });

    it('audit metadata parsing: malformed JSON, scalar values, or arrays throw fixed 500 storage corruption error', async () => {
      const testCases = [
        '{ malformed json',
        '12345',
        '"string_literal"',
        'true',
        'false',
        'null',
        '[1, 2, 3]',
        '["item"]',
      ];

      for (const badDetails of testCases) {
        const auditDb = new DatabaseSync(':memory:');
        auditDb.exec(`
          CREATE TABLE auth_audit_log (
            id TEXT PRIMARY KEY, user_id TEXT, username TEXT, action TEXT,
            ip_address TEXT, user_agent TEXT, details TEXT, created_at TEXT
          );
          CREATE TABLE _schema_migrations (version INT PRIMARY KEY, name TEXT, checksum TEXT, applied_at TEXT);
        `);

        const auditCds = new (await import('../src/management/console-data-source.js')).ConsoleDataSource({
          database: auditDb,
          storage: storage,
          quotaDefaults: DEMO_TENANT_QUOTA_DEFAULTS,
        });

        auditDb.prepare(`
          INSERT INTO auth_audit_log (id, user_id, username, action, ip_address, details, created_at)
          VALUES ('audit_bad', 'u1', 'alice', 'login', '127.0.0.1', ?, CURRENT_TIMESTAMP)
        `).run(badDetails);

        await expect(auditCds.listAuditLogs()).rejects.toThrow(/Database storage corruption: malformed audit details metadata/);
      }
    });

    it('patchUser transaction: builds and validates response before commit and rolls back on validation failure', async () => {
      const txDb = new DatabaseSync(':memory:');
      txDb.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY, username TEXT, role TEXT, status TEXT, display_name TEXT, locale TEXT NOT NULL DEFAULT 'en', theme TEXT NOT NULL DEFAULT 'dark', must_change_password INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT
        );
        CREATE TABLE user_sessions (id TEXT PRIMARY KEY, user_id TEXT, expires_at TEXT, revoked_at TEXT, created_at TEXT);
        CREATE TABLE spaces (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, folder TEXT, execution_mode TEXT, created_at TEXT, updated_at TEXT);
      `);

      txDb.prepare(`
        INSERT INTO users (id, username, role, status, display_name, created_at, updated_at)
        VALUES
          ('u_admin', 'admin_user', 'admin', 'active', 'Admin', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
          ('u_target', 'target_user', 'user', 'active', 'Target', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run();

      const txCds = new (await import('../src/management/console-data-source.js')).ConsoleDataSource({
        database: txDb,
        storage: storage,
        quotaDefaults: {
          turns: 100,
          messages: 100,
          tokens: 65536,
          storage_bytes: 10485760,
          api_calls: 500,
          resetInterval: 'none',
        },
      });

      // Normal valid patch succeeds
      const patched = await txCds.patchUser('u_target', { displayName: 'Updated Name' });
      expect(patched.displayName).toBe('Updated Name');

      // Now introduce database corruption into u_target's username right before next update to trigger postselect validation failure
      // (Triggering corrupt validation inside transaction)
      // When validation fails before commit, the update is rolled back
      const corruptDb = new DatabaseSync(':memory:');
      corruptDb.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY, username TEXT, role TEXT, status TEXT, display_name TEXT, locale TEXT NOT NULL DEFAULT 'en', theme TEXT NOT NULL DEFAULT 'dark', must_change_password INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT
        );
        CREATE TABLE user_sessions (id TEXT PRIMARY KEY, user_id TEXT, expires_at TEXT, revoked_at TEXT, created_at TEXT);
        CREATE TABLE spaces (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, folder TEXT, execution_mode TEXT, created_at TEXT, updated_at TEXT);
      `);

      corruptDb.prepare(`
        INSERT INTO users (id, username, role, status, display_name, created_at, updated_at)
        VALUES
          ('u_admin', 'admin_user', 'admin', 'active', 'Admin', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
          ('u_corrupt', '', 'user', 'active', 'Corrupt Name', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run();

      const corruptTxCds = new (await import('../src/management/console-data-source.js')).ConsoleDataSource({
        database: corruptDb,
        storage: storage,
        quotaDefaults: {
          turns: 100,
          messages: 100,
          tokens: 65536,
          storage_bytes: 10485760,
          api_calls: 500,
          resetInterval: 'none',
        },
      });

      // Empty username in DB fails requireNonEmptyString validation before COMMIT and rolls back
      await expect(corruptTxCds.patchUser('u_corrupt', { displayName: 'Should Rollback' })).rejects.toThrow(/Database storage corruption: expected non-empty string/);

      // Verify DB value remained unchanged (rolled back)
      const afterRow = corruptDb.prepare('SELECT display_name FROM users WHERE id = ?').get('u_corrupt') as { display_name: string };
      expect(afterRow.display_name).toBe('Corrupt Name');
    });

    it('patchUser transaction: rollback failure throws AggregateError with fixed message and no raw IDs', async () => {
      const mockDb = {
        exec(sql: string) {
          if (sql === 'BEGIN IMMEDIATE') return;
          if (sql === 'ROLLBACK') {
            throw new Error('Disk I/O error during rollback');
          }
          if (sql === 'COMMIT') return;
        },
        prepare(_sql: string) {
          return {
            get() {
              return {
                id: 'u_test',
                username: 'test_user',
                role: 'invalid_role_causing_failure',
                status: 'active',
                display_name: 'Test',
                created_at: '2025-01-01T00:00:00.000Z',
                updated_at: '2025-01-01T00:00:00.000Z',
              };
            },
            run() {
              return { changes: 1 };
            },
          };
        },
      } as unknown as DatabaseSync;

      const mockCds = new (await import('../src/management/console-data-source.js')).ConsoleDataSource({
        database: mockDb,
        storage: storage,
        quotaDefaults: {
          turns: 100,
          messages: 100,
          tokens: 65536,
          storage_bytes: 10485760,
          api_calls: 500,
          resetInterval: 'none',
        },
      });

      try {
        await mockCds.patchUser('u_test', { displayName: 'New Name' });
        expect.unreachable('Should have thrown AggregateError');
      } catch (err: any) {
        expect(err).toBeInstanceOf(AggregateError);
        expect(err.message).toBe('Database transaction rollback failed');
        // No raw IDs in error message
        expect(err.message).not.toContain('u_test');
        expect(err.message).not.toContain('test_user');
      }
    });

    it('extractSafeErrorCode: enforces strict allowlist, returns null for unknown tokens or unbracketed errors', async () => {
      const { extractSafeErrorCode, ALLOWED_TASK_ERROR_CODES } = await import('../src/management/console-data-source.js');

      // 1. Allowlisted codes with bracketed prefixes
      expect(extractSafeErrorCode('[TASK_INTERNAL_ERROR] Failed at /private/var/log')).toBe('TASK_INTERNAL_ERROR');
      expect(extractSafeErrorCode('[TASK_ABORTED] Turn timed out')).toBe('TASK_ABORTED');
      expect(extractSafeErrorCode('[TASK_CANCELLED] Cancelled by user')).toBe('TASK_CANCELLED');
      expect(extractSafeErrorCode('[TASK_LEASE_EXPIRED] Lease expired')).toBe('TASK_LEASE_EXPIRED');
      expect(extractSafeErrorCode('[TASK_PAYLOAD_INVALID] Malformed payload')).toBe('TASK_PAYLOAD_INVALID');
      expect(extractSafeErrorCode('[LEASE_LOST] Lease lost during execution')).toBe('LEASE_LOST');
      expect(extractSafeErrorCode('[QUOTA_EXCEEDED] Tenant quota exceeded')).toBe('QUOTA_EXCEEDED');
      expect(extractSafeErrorCode('[DISPATCH_FAILED] Inbound dispatch failed')).toBe('DISPATCH_FAILED');
      expect(extractSafeErrorCode('[PROTOCOL_VIOLATION] Protocol violation')).toBe('PROTOCOL_VIOLATION');

      // 2. Direct allowlisted tokens
      expect(extractSafeErrorCode('TASK_EXECUTION_FAILED')).toBe('TASK_EXECUTION_FAILED');
      expect(extractSafeErrorCode('TASK_FAILED')).toBe('TASK_FAILED');
      expect(extractSafeErrorCode('TASK_ABORTED')).toBe('TASK_ABORTED');
      expect(extractSafeErrorCode('TASK_CANCELLED')).toBe('TASK_CANCELLED');
      expect(extractSafeErrorCode('LEASE_LOST')).toBe('LEASE_LOST');
      expect(extractSafeErrorCode('QUOTA_EXCEEDED')).toBe('QUOTA_EXCEEDED');
      expect(extractSafeErrorCode('DISPATCH_FAILED')).toBe('DISPATCH_FAILED');
      expect(extractSafeErrorCode('PROTOCOL_VIOLATION')).toBe('PROTOCOL_VIOLATION');

      // 3. Arbitrary/unknown bracketed tokens must NEVER leak arbitrary strings — returns null
      expect(extractSafeErrorCode('[SECRET_API_TOKEN_LEAK_XYZ] stack trace')).toBeNull();
      expect(extractSafeErrorCode('[CUSTOM_INTERNAL_UNRECOGNIZED_CODE] err')).toBeNull();
      expect(extractSafeErrorCode('[DATABASE_ROW_LEAK_42] err')).toBeNull();
      expect(extractSafeErrorCode('[ATTACKER_INJECTED_BRACKET] payload')).toBeNull();

      // 4. Unbracketed non-allowlisted raw strings must return null (no fake codes)
      expect(extractSafeErrorCode('raw error message without bracketed code')).toBeNull();
      expect(extractSafeErrorCode('Connection refused at 127.0.0.1:5432')).toBeNull();

      // 5. Null, empty, or whitespace-only
      expect(extractSafeErrorCode(null)).toBeNull();
      expect(extractSafeErrorCode(undefined)).toBeNull();
      expect(extractSafeErrorCode('')).toBeNull();
      expect(extractSafeErrorCode('   ')).toBeNull();

      // Verify all items in ALLOWED_TASK_ERROR_CODES are non-empty strings
      for (const code of ALLOWED_TASK_ERROR_CODES) {
        expect(typeof code).toBe('string');
        expect(code.length).toBeGreaterThan(0);
        expect(/^[A-Z0-9_]+$/.test(code)).toBe(true);
      }
    });
  });
});
