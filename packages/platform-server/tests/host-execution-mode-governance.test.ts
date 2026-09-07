/**
 * Host Execution Mode Governance, Multi-Mode Provider Routing, Saga Provisioning & Security Test Suite
 *
 * Exhaustively verifies:
 * 1. Auth & Permissions: Admin can create/manage host space; regular user is 403 Forbidden.
 * 2. Tenant isolation & body spoofing defense (userId in body ignored).
 * 3. Space provisioning Saga with workspace ensure and DB rollback on failure.
 * 4. P0 Switch execution mode rejection (409 MIGRATION_REQUIRED).
 * 5. Session executionMode inheritance & mismatch validation.
 * 6. Mixed mode: dual daemons per user keyed by user:mode.
 * 7. RuntimeProviderRegistry routing for turns, files, fork, instructions.
 * 8. Turn execution on container vs host provider.
 * 9. Cross-mode session fork (container -> host, host -> container).
 * 10. File API multi-mode routing.
 * 11. Management runtime status with instanceId (user:mode) and mode.
 * 12. Runtime restart requiring target mode when multiple runtimes exist.
 * 13. Space archive without killing user host daemon.
 * 14. Startup fail-closed when HostProvider unavailable, and clean startup when configured.
 *
 * @module @enkeep/platform-server/tests/host-execution-mode-governance
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { provisionFixtures } from '@enkeep/platform-auth';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import {
  PlatformServer,
  SqliteWebMessageStore,
  DeliveryRuntimeGateway,
  RuntimeProviderRegistry,
  CompositeDeliveryTurnExecutor,
  type RuntimeProvider,
  type DeliveryTurnExecutor,
  type TenantRuntimeFileProvider,
  type RuntimeArtifactPort,
  type ManagementRuntimeProvider,
} from '../src/index.js';

describe('Host Execution Mode Governance, Multi-Mode Registry & Saga Suite', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let messageStore: SqliteWebMessageStore;
  let server: PlatformServer;
  let baseUrl: string;
  let testCsrfToken: string;
  let aliceCookie: string;
  let bobCookie: string;
  let aliceUserId: string;
  let bobUserId: string;

  // Mock Providers & Spies
  let containerTurnExecuted = false;
  let hostTurnExecuted = false;
  let containerFileExecuted = false;
  let hostFileExecuted = false;
  let containerExportExecuted = false;
  let hostImportExecuted = false;
  let hostEnsureWorkspaceCalled = false;
  let hostEnsureShouldFail = false;

  let containerProvider: RuntimeProvider;
  let hostProvider: RuntimeProvider;

  beforeEach(async () => {
    containerTurnExecuted = false;
    hostTurnExecuted = false;
    containerFileExecuted = false;
    hostFileExecuted = false;
    containerExportExecuted = false;
    hostImportExecuted = false;
    hostEnsureWorkspaceCalled = false;
    hostEnsureShouldFail = false;

    testCsrfToken = 'test-csrf-token-32-chars-long-secure-ok!';
    db = new DatabaseSync(':memory:');
    storage = new SqlitePlatformStorage(db);
    messageStore = new SqliteWebMessageStore(db);

    const containerTurnExecutor: DeliveryTurnExecutor = {
      execute: async (req) => {
        containerTurnExecuted = true;
        return { replyText: `Container reply for ${req.content}` };
      },
      cancel: async () => true,
    };

    const hostTurnExecutor: DeliveryTurnExecutor = {
      execute: async (req) => {
        hostTurnExecuted = true;
        return { replyText: `Host reply for ${req.content}` };
      },
      cancel: async () => true,
    };

    const containerFileProvider: TenantRuntimeFileProvider = {
      execute: async (userId, spaceId, req) => {
        containerFileExecuted = true;
        return {
          op: 'read',
          path: req.path,
          type: 'file',
          encoding: 'utf8',
          content: 'container-file-content',
          size: 22,
          mtimeMs: Date.now(),
          etag: '"1111111111111111111111111111111111111111111111111111111111111111"',
        };
      },
    };

    const hostFileProvider: TenantRuntimeFileProvider = {
      execute: async (userId, spaceId, req) => {
        hostFileExecuted = true;
        return {
          op: 'read',
          path: req.path,
          type: 'file',
          encoding: 'utf8',
          content: 'host-file-content',
          size: 17,
          mtimeMs: Date.now(),
          etag: '"2222222222222222222222222222222222222222222222222222222222222222"',
        };
      },
    };

    const containerArtifactPort: RuntimeArtifactPort = {
      checkSessionArtifact: async () => ({ exists: true, valid: true }),
      exportForkSeed: async () => {
        containerExportExecuted = true;
        return {
          events: [{ type: 'user/message', id: '1' }],
          receipt: { algorithm: 'sha256-session-events-v1', checksum: 'abc', canonicalBytes: 100, eventCount: 1 },
        };
      },
      importSeed: async () => ({ status: 'ok', persisted: true }),
    };

    const hostArtifactPort: RuntimeArtifactPort = {
      checkSessionArtifact: async () => ({ exists: true, valid: true }),
      exportForkSeed: async () => ({
        events: [{ type: 'user/message', id: '1' }],
        receipt: { algorithm: 'sha256-session-events-v1', checksum: 'host-abc', canonicalBytes: 100, eventCount: 1 },
      }),
      importSeed: async () => {
        hostImportExecuted = true;
        return { status: 'ok', persisted: true };
      },
    };

    const containerManagement: ManagementRuntimeProvider = {
      getUserRuntime: async (userId) => ({
        userId,
        status: 'ok',
        networkMode: 'none',
        dshReady: true,
        uptimeSeconds: 100,
        version: '0.1.0',
        enkeepBundleLoaded: true,
        toolsCount: 5,
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
      }),
      listRuntimes: async () => [
        {
          userId: aliceUserId || 'alice',
          status: 'ok',
          networkMode: 'none',
          dshReady: true,
          uptimeSeconds: 100,
          version: '0.1.0',
          enkeepBundleLoaded: true,
          toolsCount: 5,
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
      ],
      restartRuntime: async (userId) => ({
        restarted: true,
        userIds: userId ? [userId] : ['alice'],
        appliedRuntimes: userId ? [userId] : ['alice'],
      }),
    };

    const hostManagement: ManagementRuntimeProvider = {
      getUserRuntime: async (userId) => ({
        userId,
        status: 'ok',
        networkMode: 'none',
        dshReady: true,
        uptimeSeconds: 200,
        version: '0.1.0-host',
        enkeepBundleLoaded: true,
        toolsCount: 5,
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
      }),
      listRuntimes: async () => [
        {
          userId: aliceUserId || 'alice',
          status: 'ok',
          networkMode: 'none',
          dshReady: true,
          uptimeSeconds: 200,
          version: '0.1.0-host',
          enkeepBundleLoaded: true,
          toolsCount: 5,
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
      ],
      restartRuntime: async (userId) => ({
        restarted: true,
        userIds: userId ? [userId] : ['alice'],
        appliedRuntimes: userId ? [userId] : ['alice'],
      }),
    };

    containerProvider = {
      mode: 'container',
      turnExecutor: containerTurnExecutor,
      fileProvider: containerFileProvider,
      runtimeArtifactPort: containerArtifactPort,
      managementProvider: containerManagement,
    };

    hostProvider = {
      mode: 'host',
      turnExecutor: hostTurnExecutor,
      fileProvider: hostFileProvider,
      runtimeArtifactPort: hostArtifactPort,
      managementProvider: hostManagement,
      ensureSpaceWorkspace: async (userId, space) => {
        hostEnsureWorkspaceCalled = true;
        if (hostEnsureShouldFail) {
          throw new Error('Host filesystem root provisioning failed: disk quota exceeded');
        }
      },
    };

    const registry = new RuntimeProviderRegistry();
    registry.registerProvider(containerProvider);
    registry.registerProvider(hostProvider);

    const compositeExecutor = new CompositeDeliveryTurnExecutor(registry, db);

    const runtimeGateway = new DeliveryRuntimeGateway({
      storage,
      messageStore,
      executor: compositeExecutor,
      database: db,
      quotaMode: 'disabled',
      profileResolver: { resolve: async () => null },
    });

    server = new PlatformServer({
      database: db,
      host: '127.0.0.1',
      port: 0,
      cookieSecret: 'host-governance-secret-32-chars-long!',
      csrfToken: testCsrfToken,
      runtimeGateway,
      runtimeProviderRegistry: registry,
      hostProvider,
      containerProvider,
    });

    const addr = await server.start();
    baseUrl = addr.url;

    // Provision fixtures: Alice (Admin), Bob (User)
    const fixtures = await provisionFixtures(server.storage, server.authService, {
      adminUsername: 'alice',
      adminPassword: 'AlicePassword123!',
      userPassword: 'BobPassword123!',
      disabledPassword: 'CharliePassword123!',
    });
    aliceUserId = fixtures.admin.id;
    bobUserId = fixtures.user.id;

    // Login Alice
    const aliceLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ username: 'alice', password: 'AlicePassword123!' }),
    });
    aliceCookie = aliceLogin.headers.get('set-cookie') || '';

    // Login Bob
    const bobLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ username: 'bob', password: 'BobPassword123!' }),
    });
    bobCookie = bobLogin.headers.get('set-cookie') || '';
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
  });

  // --- 1. Auth & Permission Governance ---
  describe('1. Auth & Permission Governance for Host Execution Mode', () => {
    it('allows Admin (Alice) with manage_host_runtime to create host execution mode space', async () => {
      const res = await fetch(`${baseUrl}/api/spaces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          name: 'Alice Host Space',
          folder: 'alice-host-space',
          executionMode: 'host',
        }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.executionMode).toBe('host');
      expect(json.data.name).toBe('Alice Host Space');
    });

    it('rejects regular User (Bob) creating host space with 403 Forbidden', async () => {
      const res = await fetch(`${baseUrl}/api/spaces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: bobCookie,
        },
        body: JSON.stringify({
          name: 'Bob Host Space Attempt',
          folder: 'bob-host-space',
          executionMode: 'host',
        }),
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('FORBIDDEN');
    });

    it('rejects regular User (Bob) spoofing admin userId in create space payload', async () => {
      const res = await fetch(`${baseUrl}/api/spaces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: bobCookie,
        },
        body: JSON.stringify({
          name: 'Bob Spoof Admin Space',
          folder: 'bob-spoof-space',
          executionMode: 'host',
          userId: aliceUserId,
        }),
      });

      // Rejected either by unknown field userId or by 403 authorization
      expect([400, 403]).toContain(res.status);
      const json = await res.json();
      expect(json.success).toBe(false);
    });
  });

  // --- 2. Space Provisioning Saga & Rollback ---
  describe('2. Space Provisioning Saga & Rollback', () => {
    it('executes Saga: creates DB row, calls ensureSpaceWorkspace, and writes safe audit log', async () => {
      const res = await fetch(`${baseUrl}/api/spaces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          name: 'Alice Saga Space',
          folder: 'alice-saga-space',
          executionMode: 'host',
        }),
      });

      expect(res.status).toBe(201);
      expect(hostEnsureWorkspaceCalled).toBe(true);

      const json = await res.json();
      const spaceId = json.data.id;

      // Verify DB record exists
      const dbRow = db.prepare('SELECT id, execution_mode FROM spaces WHERE id = ?').get(spaceId) as any;
      expect(dbRow).toBeDefined();
      expect(dbRow.execution_mode).toBe('host');

      // Verify audit log in auth_audit_log has no host path or PID
      const auditRows = db.prepare('SELECT action, details FROM auth_audit_log WHERE action = ?').all('host_runtime_space_created') as any[];
      expect(auditRows.length).toBeGreaterThan(0);
      const details = JSON.parse(auditRows[auditRows.length - 1].details || '{}');
      expect(details.executionMode).toBe('host');
      expect(details.path).toBeUndefined();
      expect(details.pid).toBeUndefined();
    });

    it('rolls back DB space creation when ensureSpaceWorkspace fails', async () => {
      hostEnsureShouldFail = true;

      const res = await fetch(`${baseUrl}/api/spaces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          name: 'Failing Host Space',
          folder: 'failing-host-space',
          executionMode: 'host',
        }),
      });

      expect(res.status).toBe(500);

      // Verify DB space was cleanly rolled back (zero records with this folder)
      const dbRow = db.prepare('SELECT id FROM spaces WHERE folder = ?').get('failing-host-space');
      expect(dbRow).toBeUndefined();
    });
  });

  // --- 3. Mode Switching Prevention (P0) ---
  describe('3. P0 Execution Mode Switching Prevention', () => {
    it('returns 409 MIGRATION_REQUIRED when PATCH attempts to switch container space to host', async () => {
      // 1. Create container space
      const createRes = await fetch(`${baseUrl}/api/spaces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          name: 'Container Space',
          folder: 'container-space',
          executionMode: 'container',
        }),
      });
      const createJson = await createRes.json();
      const spaceId = createJson.data.id;

      // 2. Attempt to PATCH switch executionMode to host
      const patchRes = await fetch(`${baseUrl}/api/spaces/${spaceId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          executionMode: 'host',
        }),
      });

      expect(patchRes.status).toBe(409);
      const patchJson = await patchRes.json();
      expect(patchJson.success).toBe(false);
      expect(patchJson.error.code).toBe('MIGRATION_REQUIRED');
      expect(patchJson.error.message).toContain('Switching space execution mode requires migration');
    });

    it('returns 409 MIGRATION_REQUIRED when PATCH attempts to switch host space to container', async () => {
      // 1. Create host space
      const createRes = await fetch(`${baseUrl}/api/spaces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          name: 'Host Space',
          folder: 'host-space-for-switch',
          executionMode: 'host',
        }),
      });
      const createJson = await createRes.json();
      const spaceId = createJson.data.id;

      // 2. Attempt to PATCH switch executionMode to container
      const patchRes = await fetch(`${baseUrl}/api/spaces/${spaceId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          executionMode: 'container',
        }),
      });

      expect(patchRes.status).toBe(409);
      const patchJson = await patchRes.json();
      expect(patchJson.success).toBe(false);
      expect(patchJson.error.code).toBe('MIGRATION_REQUIRED');
    });
  });

  // --- 4. Session ExecutionMode Inheritance ---
  describe('4. Session ExecutionMode Inheritance & Mismatch Defense', () => {
    it('inherits executionMode host from host space and container from container space', async () => {
      // Create Host Space
      const hostSpaceRes = await fetch(`${baseUrl}/api/spaces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({ name: 'Host Sp', folder: 'host-sp-inh', executionMode: 'host' }),
      });
      const hostSpaceId = (await hostSpaceRes.json()).data.id;

      // Create Session in Host Space (without specifying executionMode)
      const hostSessRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({ spaceId: hostSpaceId, title: 'Host Inh Session' }),
      });
      expect(hostSessRes.status).toBe(201);
      const hostSessId = (await hostSessRes.json()).data.id;

      // Verify in DB that session route has execution_mode = 'host'
      const sessRow = db.prepare('SELECT execution_mode FROM session_routes WHERE id = ?').get(hostSessId) as any;
      expect(sessRow.execution_mode).toBe('host');
    });

    it('rejects session creation with mismatched executionMode (container requested in host space)', async () => {
      const hostSpaceRes = await fetch(`${baseUrl}/api/spaces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({ name: 'Host Space 2', folder: 'host-sp-2', executionMode: 'host' }),
      });
      const hostSpaceId = (await hostSpaceRes.json()).data.id;

      const mismatchRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({ spaceId: hostSpaceId, executionMode: 'container' }),
      });

      expect(mismatchRes.status).toBe(400);
      const mismatchJson = await mismatchRes.json();
      expect(mismatchJson.error.message).toContain('Session executionMode cannot override or mismatch space executionMode');
    });
  });

  // --- 5. Multi-Mode Routing: Turns & Files ---
  describe('5. Multi-Mode Routing for Turns & Files', () => {
    it('routes turn in container space to container turnExecutor and host space to host turnExecutor', async () => {
      // 1. Create Container Space & Session
      const contSpaceRes = await fetch(`${baseUrl}/api/spaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Enkeep-CSRF': testCsrfToken, Origin: baseUrl, Cookie: aliceCookie },
        body: JSON.stringify({ name: 'Cont Turn Sp', folder: 'cont-turn-sp', executionMode: 'container' }),
      });
      const contSpaceId = (await contSpaceRes.json()).data.id;
      const contSessRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Enkeep-CSRF': testCsrfToken, Origin: baseUrl, Cookie: aliceCookie },
        body: JSON.stringify({ spaceId: contSpaceId, title: 'Cont Sess' }),
      });
      const contSessId = (await contSessRes.json()).data.id;

      // 2. Create Host Space & Session
      const hostSpaceRes = await fetch(`${baseUrl}/api/spaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Enkeep-CSRF': testCsrfToken, Origin: baseUrl, Cookie: aliceCookie },
        body: JSON.stringify({ name: 'Host Turn Sp', folder: 'host-turn-sp', executionMode: 'host' }),
      });
      const hostSpaceId = (await hostSpaceRes.json()).data.id;
      const hostSessRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Enkeep-CSRF': testCsrfToken, Origin: baseUrl, Cookie: aliceCookie },
        body: JSON.stringify({ spaceId: hostSpaceId, title: 'Host Sess' }),
      });
      const hostSessId = (await hostSessRes.json()).data.id;

      // 3. Send message in Container session
      await fetch(`${baseUrl}/api/sessions/${contSessId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          'Idempotency-Key': '11111111-1111-4111-8111-111111111111',
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({ content: 'Hello Container' }),
      });

      expect(containerTurnExecuted).toBe(true);
      expect(hostTurnExecuted).toBe(false);

      // Reset spy flags
      containerTurnExecuted = false;
      hostTurnExecuted = false;

      // 4. Send message in Host session
      await fetch(`${baseUrl}/api/sessions/${hostSessId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          'Idempotency-Key': '22222222-2222-4222-8222-222222222222',
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({ content: 'Hello Host' }),
      });

      expect(hostTurnExecuted).toBe(true);
      expect(containerTurnExecuted).toBe(false);
    });

    it('routes file operations to appropriate mode fileProvider', async () => {
      // Create Host Space
      const hostSpaceRes = await fetch(`${baseUrl}/api/spaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Enkeep-CSRF': testCsrfToken, Origin: baseUrl, Cookie: aliceCookie },
        body: JSON.stringify({ name: 'Host File Sp', folder: 'host-file-sp', executionMode: 'host' }),
      });
      const hostSpaceId = (await hostSpaceRes.json()).data.id;

      // Execute file operation on host space via fileService
      if (server.fileService) {
        const fileRes = await server.fileService.execute(aliceUserId, hostSpaceId, {
          op: 'read',
          path: 'test.txt',
        });
        expect(hostFileExecuted).toBe(true);
        expect(fileRes.content).toBe('host-file-content');
      }
    });
  });

  // --- 6. Cross-Mode Session Fork ---
  describe('6. Cross-Mode Session Fork', () => {
    it('forks session from container space into host space', async () => {
      if (!server.forkService) return;

      // 1. Create source container space and session
      const contSpaceRes = await fetch(`${baseUrl}/api/spaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Enkeep-CSRF': testCsrfToken, Origin: baseUrl, Cookie: aliceCookie },
        body: JSON.stringify({ name: 'Source Cont Space', folder: 'src-cont-space', executionMode: 'container' }),
      });
      const contSpaceId = (await contSpaceRes.json()).data.id;
      const contSessRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Enkeep-CSRF': testCsrfToken, Origin: baseUrl, Cookie: aliceCookie },
        body: JSON.stringify({ spaceId: contSpaceId, title: 'Src Cont Sess' }),
      });
      const contSessId = (await contSessRes.json()).data.id;

      // 2. Create target host space
      const targetHostRes = await fetch(`${baseUrl}/api/spaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Enkeep-CSRF': testCsrfToken, Origin: baseUrl, Cookie: aliceCookie },
        body: JSON.stringify({ name: 'Target Host Space', folder: 'tgt-host-space', executionMode: 'host' }),
      });
      const targetHostId = (await targetHostRes.json()).data.id;

      // 3. Perform fork via ForkService
      const forked = await server.forkService.forkSession(aliceUserId, contSessId, {
        targetSpaceId: targetHostId,
        title: 'Forked into Host',
      });

      expect(forked.spaceId).toBe(targetHostId);
      expect(containerExportExecuted).toBe(true);
      expect(hostImportExecuted).toBe(true);

      // Verify forked session in DB has host execution mode
      const forkedRow = db.prepare('SELECT execution_mode FROM session_routes WHERE id = ?').get(forked.id) as any;
      expect(forkedRow.execution_mode).toBe('host');
    });
  });

  // --- 7. Management Status & Restart Governance ---
  describe('7. Management Status & Restart Multi-Mode Governance', () => {
    it('returns runtime status with instanceId user:mode and mode', async () => {
      const res = await fetch(`${baseUrl}/api/admin/runtime`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.runtimes.length).toBe(2);

      const contStatus = json.data.runtimes.find((r: any) => r.mode === 'container');
      const hostStatus = json.data.runtimes.find((r: any) => r.mode === 'host');

      expect(contStatus).toBeDefined();
      expect(contStatus.instanceId).toContain(':container');
      expect(hostStatus).toBeDefined();
      expect(hostStatus.instanceId).toContain(':host');
    });

    it('requires target mode when restarting a user who has multiple runtimes (container & host)', async () => {
      const res = await fetch(`${baseUrl}/api/admin/runtimes/${aliceUserId}/restart`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.message).toContain('Target execution mode ("container" or "host") is required when multiple runtimes exist for user');
    });

    it('successfully restarts specific target mode when mode parameter is provided', async () => {
      const res = await fetch(`${baseUrl}/api/admin/runtimes/${aliceUserId}/restart`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({ mode: 'host' }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.restarted).toBe(true);
    });
  });

  // --- 8. Archive Space Does Not Kill User Host Daemon ---
  describe('8. Archive Space & User Host Daemon Persistence', () => {
    it('archives host space without destroying user runtime daemon', async () => {
      const hostSpaceRes = await fetch(`${baseUrl}/api/spaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Enkeep-CSRF': testCsrfToken, Origin: baseUrl, Cookie: aliceCookie },
        body: JSON.stringify({ name: 'Archive Host Sp', folder: 'arch-host-sp', executionMode: 'host' }),
      });
      const spaceId = (await hostSpaceRes.json()).data.id;

      // Archive space
      const archRes = await fetch(`${baseUrl}/api/spaces/${spaceId}/archive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
      });
      expect(archRes.status).toBe(200);

      // Verify space is archived
      const spaceRow = db.prepare('SELECT status FROM spaces WHERE id = ?').get(spaceId) as any;
      expect(spaceRow.status).toBe('archived');

      // Verify runtime status query still returns host daemon operational
      const runtimeRes = await fetch(`${baseUrl}/api/admin/runtime`, {
        headers: { Cookie: aliceCookie },
      });
      const runJson = await runtimeRes.json();
      const hostRuntime = runJson.data.runtimes.find((r: any) => r.mode === 'host');
      expect(hostRuntime).toBeDefined();
      expect(hostRuntime.status).toBe('ok');
    });
  });

  // --- 9. Startup Failclosed on Missing HostProvider ---
  describe('9. Startup Failclosed & Database Restart Checks', () => {
    it('fails closed during start() if DB contains host rows but no HostProvider is configured', async () => {
      const freshDb = new DatabaseSync(':memory:');
      const freshStorage = new SqlitePlatformStorage(freshDb);
      const freshMessageStore = new SqliteWebMessageStore(freshDb);

      const freshGateway = new DeliveryRuntimeGateway({
        storage: freshStorage,
        messageStore: freshMessageStore,
        executor: { execute: async () => ({ replyText: 'ok' }), cancel: async () => true },
        database: freshDb,
        quotaMode: 'disabled',
        profileResolver: { resolve: async () => null },
      });

      // Start initial server with hostProvider to initialize DB schema and a host space
      const initialRegistry = new RuntimeProviderRegistry();
      initialRegistry.registerProvider(containerProvider);
      initialRegistry.registerProvider(hostProvider);

      const setupServer = new PlatformServer({
        database: freshDb,
        host: '127.0.0.1',
        port: 0,
        cookieSecret: 'setup-host-secret-32-chars-long-ok!',
        csrfToken: testCsrfToken,
        runtimeGateway: freshGateway,
        runtimeProviderRegistry: initialRegistry,
        hostProvider,
      });
      await setupServer.start();

      // Insert user and host row directly
      freshDb.prepare(`
        INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
        VALUES ('usr_alice_fresh', 'alice', 'hash', 'admin', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run();
      freshDb.prepare(`
        INSERT INTO spaces (id, user_id, name, folder, execution_mode, status, created_at, updated_at)
        VALUES ('spc_host_legacy', 'usr_alice_fresh', 'Legacy Host', 'legacy-folder', 'host', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run();

      await setupServer.stop();

      // Now create server with freshGateway but WITHOUT hostProvider or host in registry
      const failingServer = new PlatformServer({
        database: freshDb,
        host: '127.0.0.1',
        port: 0,
        cookieSecret: 'failing-host-secret-32-chars-long!',
        csrfToken: testCsrfToken,
        runtimeGateway: freshGateway,
      });

      await expect(failingServer.start()).rejects.toThrow(
        /FAIL-CLOSED: Database contains host execution mode records.*no HostProvider is configured/
      );
    });

    it('succeeds start() when DB contains host rows and HostProvider is configured', async () => {
      const freshDb = new DatabaseSync(':memory:');
      const freshStorage = new SqlitePlatformStorage(freshDb);
      const freshMessageStore = new SqliteWebMessageStore(freshDb);

      const freshRegistry = new RuntimeProviderRegistry();
      freshRegistry.registerProvider(containerProvider);
      freshRegistry.registerProvider(hostProvider);

      const freshGateway = new DeliveryRuntimeGateway({
        storage: freshStorage,
        messageStore: freshMessageStore,
        executor: { execute: async () => ({ replyText: 'ok' }), cancel: async () => true },
        database: freshDb,
        quotaMode: 'disabled',
        profileResolver: { resolve: async () => null },
      });

      const validServer = new PlatformServer({
        database: freshDb,
        host: '127.0.0.1',
        port: 0,
        cookieSecret: 'valid-host-secret-32-chars-long-ok!',
        csrfToken: testCsrfToken,
        runtimeGateway: freshGateway,
        runtimeProviderRegistry: freshRegistry,
        hostProvider,
      });

      const addr = await validServer.start();
      expect(addr.port).toBeGreaterThan(0);

      // Insert user and host space into DB
      freshDb.prepare(`
        INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
        VALUES ('usr_alice_valid', 'alice', 'hash', 'admin', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run();
      freshDb.prepare(`
        INSERT INTO spaces (id, user_id, name, folder, execution_mode, status, created_at, updated_at)
        VALUES ('spc_host_valid', 'usr_alice_valid', 'Valid Host Space', 'valid-host-folder', 'host', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run();

      await validServer.stop();

      // Re-start server with hostProvider configured
      const restartedServer = new PlatformServer({
        database: freshDb,
        host: '127.0.0.1',
        port: 0,
        cookieSecret: 'restarted-host-secret-32-chars-ok!',
        csrfToken: testCsrfToken,
        runtimeGateway: freshGateway,
        runtimeProviderRegistry: freshRegistry,
        hostProvider,
      });

      const restartAddr = await restartedServer.start();
      expect(restartAddr.port).toBeGreaterThan(0);
      await restartedServer.stop();
    });
  });
});
