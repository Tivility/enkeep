import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { PlatformServerMigrationRunner, ALL_PLATFORM_MIGRATIONS } from '../src/storage/migrations.js';
import { RuntimeTargetVersionRepo, SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { createPlatformServerHandler } from '../src/server/handler.js';
import { RuntimeAutoUpgrader } from '../src/runtime/auto-upgrader.js';
import { DeliveryRuntimeGateway } from '../src/runtime/delivery-gateway.js';
import { SqlitePlatformWebApiAdapter } from '../src/storage/sqlite-platform-api.js';
import { SqliteWebMessageStore } from '../src/storage/web-messages.js';
import { DefaultAuthService, provisionFixtures } from '@enkeep/platform-auth';
import { PlatformError } from '@enkeep/platform-core';

describe('Runtime Idle Auto-Upgrade & Target Version Governance', () => {
  let db: DatabaseSync;
  let runner: PlatformServerMigrationRunner;
  let repo: RuntimeTargetVersionRepo;
  let storage: SqlitePlatformStorage;
  let authService: DefaultAuthService;
  let platformApi: SqlitePlatformWebApiAdapter;
  let adminCookie: string;
  let adminUser: any;

  const cookieSecret = 'test-secret-key-32-chars-minimum-length!';
  const csrfToken = 'test-csrf-token-32-chars-long-valid!';

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);
    repo = new RuntimeTargetVersionRepo(db);
    storage = new SqlitePlatformStorage(db);
    authService = new DefaultAuthService(storage, {
      cookieSecret,
      sessionTtlSeconds: 3600,
      cookieSecure: false,
    });
    const fixtures = await provisionFixtures(storage, authService, {
      adminPassword: 'AdminPassword123!',
      userPassword: 'UserPassword123!',
      disabledPassword: 'DisabledPassword123!',
    });
    adminUser = fixtures.admin;
    db.exec(`
      UPDATE users SET must_change_password = 0 WHERE id = '${fixtures.admin.id}';
    `);
    const loginRes = await authService.login('alice', 'AdminPassword123!');
    adminCookie = loginRes.cookieHeader.split(';')[0]!;

    const messageStore = new SqliteWebMessageStore(db);
    platformApi = new SqlitePlatformWebApiAdapter({
      storage,
      messageStore,
      authService,
      db,
    });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  describe('1. Target Version Persistence & Fallback', () => {
    it('returns null when no target version record exists', () => {
      expect(repo.getTargetVersion()).toBeNull();
    });

    it('persists and updates target runtime version image and daemonCliPath with updatedBy', () => {
      // Insert user for foreign key
      db.exec(`INSERT INTO users (id, username, password_hash, role, status) VALUES ('user-admin-01', 'admin1', 'h', 'admin', 'active');`);
      db.exec(`INSERT INTO users (id, username, password_hash, role, status) VALUES ('user-admin-02', 'admin2', 'h', 'admin', 'active');`);

      const v1 = repo.setTargetVersion({
        image: 'enkeep-runtime:v2.0.0',
        daemonCliPath: '/custom/path/daemon-cli.js',
        updatedBy: 'user-admin-01',
      });
      expect(v1.image).toBe('enkeep-runtime:v2.0.0');
      expect(v1.daemonCliPath).toBe('/custom/path/daemon-cli.js');
      expect(v1.updatedBy).toBe('user-admin-01');

      const queried = repo.getTargetVersion();
      expect(queried?.image).toBe('enkeep-runtime:v2.0.0');
      expect(queried?.daemonCliPath).toBe('/custom/path/daemon-cli.js');
      expect(queried?.updatedBy).toBe('user-admin-01');

      // Update only image
      const v2 = repo.setTargetVersion({
        image: 'enkeep-runtime:v2.1.0',
        updatedBy: 'user-admin-02',
      });
      expect(v2.image).toBe('enkeep-runtime:v2.1.0');
      expect(v2.daemonCliPath).toBe('/custom/path/daemon-cli.js'); // preserved
      expect(v2.updatedBy).toBe('user-admin-02');
    });
  });

  describe('2. Admin HTTP API: GET/PUT /api/admin/runtime/target-version & GET upgrade-status', () => {
    it('GET /api/admin/runtime/target-version returns target version or fallback', async () => {
      const mockManagement: any = {
        getTargetVersion: vi.fn().mockResolvedValue(null),
        listRuntimes: vi.fn().mockResolvedValue([]),
      };

      const handler = createPlatformServerHandler({
        database: db,
        storage,
        authService,
        platformApi,
        cookieSecret,
        csrfToken,
        runtimeGateway: {} as any,
        managementProvider: mockManagement,
      });

      const req: any = {
        method: 'GET',
        url: '/api/admin/runtime/target-version',
        socket: { localAddress: '127.0.0.1', localPort: 3456, remoteAddress: '127.0.0.1' },
        headers: {
          host: '127.0.0.1:3456',
          cookie: adminCookie,
        },
      };

      let responseBody = '';
      const res: any = {
        statusCode: 0,
        setHeader: vi.fn(),
        writeHead: function(code: number) { this.statusCode = code; },
        end: (chunk: string) => { responseBody = chunk; },
      };

      await handler(req, res);
      if (res.statusCode !== 200) {
        console.error('Response error payload:', responseBody);
      }
      expect(res.statusCode).toBe(200);
      const json = JSON.parse(responseBody);
      expect(json.success).toBe(true);
      expect(json.data.id).toBe('default');
    });

    it('PUT /api/admin/runtime/target-version sets target version with CSRF validation', async () => {
      let currentTarget: any = null;
      const mockManagement: any = {
        getTargetVersion: vi.fn().mockImplementation(async () => currentTarget),
        setTargetVersion: vi.fn().mockImplementation(async (input) => {
          currentTarget = {
            id: 'default',
            image: input.image,
            daemonCliPath: input.daemonCliPath,
            updatedBy: input.updatedBy,
            updatedAt: new Date().toISOString(),
          };
          return currentTarget;
        }),
        listRuntimes: vi.fn().mockResolvedValue([]),
      };

      const handler = createPlatformServerHandler({
        database: db,
        storage,
        authService,
        platformApi,
        cookieSecret,
        csrfToken,
        runtimeGateway: {} as any,
        managementProvider: mockManagement,
      });

      const bodyObj = { image: 'enkeep-runtime:v3.0.0', daemonCliPath: '/path/to/daemon.js' };
      const stream = Readable.from([Buffer.from(JSON.stringify(bodyObj))]);
      const req: any = Object.assign(stream, {
        method: 'PUT',
        url: '/api/admin/runtime/target-version',
        socket: { localAddress: '127.0.0.1', localPort: 3456, remoteAddress: '127.0.0.1' },
        headers: {
          host: '127.0.0.1:3456',
          origin: 'http://127.0.0.1:3456',
          cookie: adminCookie,
          'x-enkeep-csrf': csrfToken,
          'content-type': 'application/json',
        },
      });

      let responseBody = '';
      const res: any = {
        statusCode: 0,
        setHeader: vi.fn(),
        writeHead: function(code: number) { this.statusCode = code; },
        end: (chunk: string) => { responseBody = chunk; },
      };

      await handler(req, res);
      if (res.statusCode !== 200) {
        console.error('Response error payload:', responseBody);
      }
      expect(res.statusCode).toBe(200);
      const json = JSON.parse(responseBody);
      expect(json.success).toBe(true);
      expect(json.data.image).toBe('enkeep-runtime:v3.0.0');
      expect(json.data.daemonCliPath).toBe('/path/to/daemon.js');
      expect(mockManagement.setTargetVersion).toHaveBeenCalledWith({
        image: 'enkeep-runtime:v3.0.0',
        daemonCliPath: '/path/to/daemon.js',
        updatedBy: adminUser.id,
      });
    });

    it('GET /api/admin/runtime/upgrade-status returns per-user upgrade status', async () => {
      const mockManagement: any = {
        getUpgradeStatus: vi.fn().mockResolvedValue([
          {
            userId: 'user-alice',
            mode: 'container',
            currentImage: 'enkeep-runtime:v1.0.0',
            targetImage: 'enkeep-runtime:v2.0.0',
            isOutdated: true,
            isIdle: true,
            idleDurationSeconds: 400,
            pendingReason: 'idle',
          },
        ]),
        listRuntimes: vi.fn().mockResolvedValue([]),
      };

      const handler = createPlatformServerHandler({
        database: db,
        storage,
        authService,
        platformApi,
        cookieSecret,
        csrfToken,
        runtimeGateway: {} as any,
        managementProvider: mockManagement,
      });

      const req: any = {
        method: 'GET',
        url: '/api/admin/runtime/upgrade-status',
        socket: { localAddress: '127.0.0.1', localPort: 3456, remoteAddress: '127.0.0.1' },
        headers: {
          host: '127.0.0.1:3456',
          cookie: adminCookie,
        },
      };

      let responseBody = '';
      const res: any = {
        statusCode: 0,
        setHeader: vi.fn(),
        writeHead: function(code: number) { this.statusCode = code; },
        end: (chunk: string) => { responseBody = chunk; },
      };

      await handler(req, res);
      if (res.statusCode !== 200) {
        console.error('Response error payload:', responseBody);
      }
      expect(res.statusCode).toBe(200);
      const json = JSON.parse(responseBody);
      expect(json.success).toBe(true);
      expect(json.data.length).toBe(1);
      expect(json.data[0].userId).toBe('user-alice');
      expect(json.data[0].isOutdated).toBe(true);
    });
  });

  describe('3. RuntimeAutoUpgrader Lifecycle & Safety', () => {
    it('outdated and idle meeting threshold -> pauses dispatch, stops runtime, resumes dispatch, and redrives', async () => {
      const paused: string[] = [];
      const resumed: string[] = [];
      let redriveCalled = 0;

      const mockGateway: any = {
        getUserActiveRoundsCount: vi.fn().mockReturnValue({ queued: 0, running: 0 }),
        pauseUserDispatch: vi.fn((uid) => paused.push(uid)),
        resumeUserDispatch: vi.fn((uid) => resumed.push(uid)),
        redriveHeld: vi.fn(async () => { redriveCalled++; return 0; }),
      };

      let stoppedUser: string | null = null;
      let upgradeStatus = [
        {
          userId: 'user-bob',
          mode: 'container',
          currentImage: 'enkeep-runtime:v1.0.0',
          targetImage: 'enkeep-runtime:v2.0.0',
          isOutdated: true,
          isIdle: true,
          idleDurationSeconds: 350,
          pendingReason: 'idle',
        },
      ];

      const mockManagement: any = {
        getUpgradeStatus: vi.fn(async () => upgradeStatus),
        stopRuntime: vi.fn(async (uid) => { stoppedUser = uid; return { stopped: true, userId: uid }; }),
      };

      const upgrader = new RuntimeAutoUpgrader({
        db,
        managementProvider: mockManagement,
        deliveryGateway: mockGateway,
        idleThresholdSeconds: 0, // Instant threshold for testing
      });

      const res = await upgrader.checkAndUpgrade();
      expect(res.status).toBe('upgraded');
      expect(res.upgradedUserId).toBe('user-bob');
      expect(paused).toContain('user-bob');
      expect(stoppedUser).toBe('user-bob');
      expect(resumed).toContain('user-bob');
      expect(redriveCalled).toBe(1);
    });

    it('idle below threshold does not perform upgrade', async () => {
      const mockGateway: any = {
        getUserActiveRoundsCount: vi.fn().mockReturnValue({ queued: 0, running: 0 }),
        pauseUserDispatch: vi.fn(),
        resumeUserDispatch: vi.fn(),
        redriveHeld: vi.fn(),
      };

      const mockManagement: any = {
        getUpgradeStatus: vi.fn(async () => [
          {
            userId: 'user-bob',
            mode: 'container',
            isOutdated: true,
            isIdle: true,
          },
        ]),
        stopRuntime: vi.fn(),
      };

      const upgrader = new RuntimeAutoUpgrader({
        db,
        managementProvider: mockManagement,
        deliveryGateway: mockGateway,
        idleThresholdSeconds: 300, // 300 seconds
      });

      const res = await upgrader.checkAndUpgrade();
      expect(res.status).toBe('no_idle_candidate_meeting_threshold');
      expect(mockManagement.stopRuntime).not.toHaveBeenCalled();
    });

    it('re-check busy -> aborts upgrade and resumes dispatch safely', async () => {
      let checkCount = 0;
      const paused: string[] = [];
      const resumed: string[] = [];

      const mockGateway: any = {
        getUserActiveRoundsCount: vi.fn().mockReturnValue({ queued: 0, running: 0 }),
        pauseUserDispatch: vi.fn((uid) => paused.push(uid)),
        resumeUserDispatch: vi.fn((uid) => resumed.push(uid)),
        redriveHeld: vi.fn(),
      };

      const mockManagement: any = {
        getUpgradeStatus: vi.fn(async () => {
          checkCount++;
          if (checkCount === 1) {
            // First check: idle
            return [{ userId: 'user-charlie', mode: 'container', isOutdated: true, isIdle: true }];
          }
          // Re-check after pause: becomes busy!
          return [{ userId: 'user-charlie', mode: 'container', isOutdated: true, isIdle: false }];
        }),
        stopRuntime: vi.fn(),
      };

      const upgrader = new RuntimeAutoUpgrader({
        db,
        managementProvider: mockManagement,
        deliveryGateway: mockGateway,
        idleThresholdSeconds: 0,
      });

      const res = await upgrader.checkAndUpgrade();
      expect(res.status).toBe('aborted_became_busy');
      expect(mockManagement.stopRuntime).not.toHaveBeenCalled();
      expect(paused).toContain('user-charlie');
      expect(resumed).toContain('user-charlie');
    });
  });

  describe('4. Steer Compatibility on Unsupported / Old Runtimes', () => {
    it('steer on older runtime returning UNKNOWN_OP translates to RUNTIME_UPGRADE_REQUIRED', async () => {
      const gateway = new DeliveryRuntimeGateway({
        db,
        messageStore: {
          ingestWebDelivery: vi.fn(),
          db,
        } as any,
        executor: {
          execute: vi.fn(),
          cancel: vi.fn(),
          steerTurn: vi.fn().mockResolvedValue({
            ok: false,
            error: {
              code: 'UNKNOWN_OP',
              message: 'Unknown op steer',
            },
          }),
        },
        quotaMode: 'disabled',
        profileResolver: { resolve: vi.fn() } as any,
      });

      // Insert dummy user, space, session, and running turn
      db.exec(`
        INSERT INTO spaces (id, user_id, name, folder, status) VALUES ('spc_steer_1', '${adminUser.id}', 'space1', 'folder1', 'active');
        INSERT INTO session_routes (id, user_id, space_id, channel, dsh_session_id, status) VALUES ('ses_steer_1', '${adminUser.id}', 'spc_steer_1', 'web', 'dsh_ses_steer_1', 'active');
        INSERT INTO turn_runs (turn_id, user_id, route_id, space_id, status) VALUES ('turn_run_steer_1', '${adminUser.id}', 'ses_steer_1', 'spc_steer_1', 'running');
      `);

      await expect(gateway.steerTurn(adminUser.id, 'ses_steer_1', {
        clientRequestId: 'req-1',
        expectedTurnId: 'turn_run_steer_1',
        content: 'Steer instructions',
      })).rejects.toMatchObject({
        code: 'RUNTIME_UPGRADE_REQUIRED',
        message: expect.stringContaining('该会话运行时升级后可用'),
      });
    });
  });
});
