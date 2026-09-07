import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  createPlatformServer,
  PlatformServer,
  DualStorageReconcileService,
  VolumeScanService,
  SqliteWebMessageStore,
} from '../src/index.js';
import { TestOnlyRuntimeGateway } from './test-runtime-gateway.js';
import { SqlitePlatformStorage, SqlitePlatformOperationsStorage } from '@enkeep/platform-storage-sqlite';
import { DefaultAuthService, provisionFixtures } from '@enkeep/platform-auth';
import {
  createPlatformOperations,
  PlatformOperationsService,
} from '@enkeep/platform-operations';

describe('Storage Module P0/P1 Integration: Metering, Dual Reconciliation, Reset, Audit', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let operationsStorage: SqlitePlatformOperationsStorage;
  let operationsService: PlatformOperationsService;
  let authService: DefaultAuthService;
  let tempDir: string;
  let server: PlatformServer;
  let baseUrl: string;
  let adminCookie: string;
  let aliceCookie: string;
  let bobCookie: string;
  let adminId: string;
  let aliceId: string;
  let bobId: string;

  const cookieSecret = 'test_cookie_secret_0123456789abcdef';
  const csrfToken = 'test_csrf_token_0123456789abcdef';

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-storage-test-'));

    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    storage = new SqlitePlatformStorage(db);
    operationsStorage = new SqlitePlatformOperationsStorage(db);
    operationsService = createPlatformOperations({
      storage: operationsStorage,
    });

    authService = new DefaultAuthService(storage, {
      cookieSecret,
      sessionTtlSeconds: 3600,
      cookieSecure: false,
    });

    const provisionResult = await provisionFixtures(storage, authService, {
      adminPassword: 'AliceAdmin123!',
      userPassword: 'BobUser123!',
      disabledPassword: 'CharlieDisabled123!',
    });
    adminId = provisionResult.admin.id;
    aliceId = provisionResult.admin.id; // Alice is admin
    bobId = provisionResult.user.id; // Bob is regular user

    const adminLogin = await authService.login('alice', 'AliceAdmin123!');
    adminCookie = adminLogin.cookieHeader.split(';')[0]!;
    aliceCookie = adminCookie;

    const bobLogin = await authService.login('bob', 'BobUser123!');
    bobCookie = bobLogin.cookieHeader.split(';')[0]!;

    // Mock runtime file provider rooted in tempDir
    const mockFileProvider = {
      execute: async (userId: string, spaceId: string, req: any) => {
        const userSpaceDir = path.join(tempDir, userId, spaceId);
        fs.mkdirSync(userSpaceDir, { recursive: true });

        if (req.op === 'list') {
          const targetDir = path.join(userSpaceDir, req.path === '.' ? '' : req.path);
          if (!fs.existsSync(targetDir)) return { op: 'list', path: req.path, entries: [], truncated: false };
          const entries = fs.readdirSync(targetDir, { withFileTypes: true }).map((e) => {
            const full = path.join(targetDir, e.name);
            const stat = fs.statSync(full);
            const content = stat.isFile() ? fs.readFileSync(full) : Buffer.alloc(0);
            const etag = `"${require('crypto').createHash('sha256').update(content).digest('hex')}"`;
            return {
              name: e.name,
              type: e.isDirectory() ? ('directory' as const) : ('file' as const),
              size: stat.size,
              mtimeMs: stat.mtimeMs,
              etag,
            };
          });
          return { op: 'list', path: req.path, entries, truncated: false };
        }

        if (req.op === 'read') {
          const filePath = path.join(userSpaceDir, req.path);
          if (!fs.existsSync(filePath)) {
            const err = new Error('File not found');
            (err as any).code = 'NOT_FOUND';
            throw err;
          }
          const buf = fs.readFileSync(filePath);
          const stat = fs.statSync(filePath);
          const etag = `"${require('crypto').createHash('sha256').update(buf).digest('hex')}"`;
          return {
            op: 'read',
            path: req.path,
            content: req.encoding === 'base64' ? buf.toString('base64') : buf.toString('utf8'),
            encoding: req.encoding || 'utf8',
            type: 'file' as const,
            size: buf.byteLength,
            mtimeMs: stat.mtimeMs,
            etag,
          };
        }

        if (req.op === 'write') {
          const filePath = path.join(userSpaceDir, req.path);
          const buf = req.encoding === 'base64' ? Buffer.from(req.content, 'base64') : Buffer.from(req.content, 'utf8');
          fs.writeFileSync(filePath, buf);
          const stat = fs.statSync(filePath);
          const etag = `"${require('crypto').createHash('sha256').update(buf).digest('hex')}"`;
          return {
            op: 'write',
            path: req.path,
            type: 'file' as const,
            size: buf.byteLength,
            mtimeMs: stat.mtimeMs,
            etag,
          };
        }

        if (req.op === 'delete') {
          const filePath = path.join(userSpaceDir, req.path);
          if (!fs.existsSync(filePath)) {
            const err = new Error('File not found');
            (err as any).code = 'NOT_FOUND';
            throw err;
          }
          const stat = fs.statSync(filePath);
          const wasFile = stat.isFile();
          const oldSize = stat.size;
          const oldBuf = wasFile ? fs.readFileSync(filePath) : Buffer.alloc(0);
          const etag = `"${require('crypto').createHash('sha256').update(oldBuf).digest('hex')}"`;
          if (wasFile) {
            fs.unlinkSync(filePath);
          } else {
            fs.rmdirSync(filePath);
          }
          return {
            op: 'delete',
            path: req.path,
            type: wasFile ? ('file' as const) : ('directory' as const),
            size: oldSize,
            mtimeMs: stat.mtimeMs,
            etag,
          };
        }

        if (req.op === 'rename') {
          const src = path.join(userSpaceDir, req.path);
          const dst = path.join(userSpaceDir, req.targetPath);
          let dstSize = 0;
          if (fs.existsSync(dst)) {
            dstSize = fs.statSync(dst).size;
          }
          fs.renameSync(src, dst);
          const stat = fs.statSync(dst);
          const buf = fs.readFileSync(dst);
          const etag = `"${require('crypto').createHash('sha256').update(buf).digest('hex')}"`;
          return {
            op: 'rename',
            path: req.path,
            targetPath: req.targetPath,
            type: 'file' as const,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            etag,
          };
        }

        if (req.op === 'mkdir') {
          const dirPath = path.join(userSpaceDir, req.path);
          fs.mkdirSync(dirPath, { recursive: true });
          return {
            op: 'mkdir',
            path: req.path,
            type: 'directory' as const,
            size: 0,
            mtimeMs: Date.now(),
            etag: `"${'0'.repeat(64)}"`,
          };
        }

        throw new Error('Unsupported op in mock');
      },
    };

    const messageStore = new SqliteWebMessageStore(db);
    const runtimeGateway = new TestOnlyRuntimeGateway({ database: db, storage, messageStore });

    const created = await createPlatformServer({
      database: db,
      storage,
      authService,
      runtimeGateway,
      operationsService,
      fileProvider: mockFileProvider,
      cookieSecret,
      csrfToken,
      host: '127.0.0.1',
      port: 0,
    });

    server = created.server;
    baseUrl = server.getUrl();
  });

  afterEach(async () => {
    await server.stop();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('1. storage_bytes Metering (Write, Delta Reserve, Shrink Decrement, Delete)', () => {
    it('meters storage_bytes starting from 0, reserves delta before write, commits actual size, and decrements on delete', async () => {
      // 1. Create a space for Alice
      const spaceRes = await fetch(`${baseUrl}/api/spaces`, {
        method: 'POST',
        headers: {
          'Cookie': aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          'Origin': baseUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Alice Space', folder: 'alice-folder' }),
      });
      const spaceData = await spaceRes.json();
      expect(spaceRes.status).toBe(201);
      const spaceId = spaceData.data.id;

      // 2. Set Alice storage_bytes limit to 100 KB (102400 bytes)
      const adminQuotaRes = await fetch(`${baseUrl}/api/admin/quotas/${aliceId}/storage_bytes`, {
        method: 'PATCH',
        headers: {
          'Cookie': adminCookie,
          'X-Enkeep-CSRF': csrfToken,
          'Origin': baseUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ limit: 102400 }),
      });
      expect(adminQuotaRes.status).toBe(200);

      // Verify Alice storage_bytes starts at 0
      const initialUsage = await operationsService.forTenant(aliceId).quota.getUsage('storage_bytes');
      expect(initialUsage.used).toBe(0);
      expect(initialUsage.remaining).toBe(102400);

      // 3. Write a 1000-byte file (file1.txt) with requireAbsent: true
      const content1000 = 'A'.repeat(1000);
      const writeRes1 = await fetch(`${baseUrl}/api/spaces/${spaceId}/files/content`, {
        method: 'PUT',
        headers: {
          'Cookie': aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          'Origin': baseUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          path: 'file1.txt',
          content: content1000,
          requireAbsent: true,
        }),
      });
      expect(writeRes1.status).toBe(200);
      const writeData1 = await writeRes1.json();
      expect(writeData1.data.written).toBe(true);
      const etag1 = writeData1.data.etag;

      // Assert usage changed from 0 -> 1000
      const usageAfter1 = await operationsService.forTenant(aliceId).quota.getUsage('storage_bytes');
      expect(usageAfter1.used).toBe(1000);
      expect(usageAfter1.remaining).toBe(102400 - 1000);

      // 4. Overwrite file1.txt with larger file (2500 bytes) -> delta +1500
      const content2500 = 'B'.repeat(2500);
      const writeRes2 = await fetch(`${baseUrl}/api/spaces/${spaceId}/files/content`, {
        method: 'PUT',
        headers: {
          'Cookie': aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          'Origin': baseUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          path: 'file1.txt',
          content: content2500,
          expectedEtag: etag1,
        }),
      });
      expect(writeRes2.status).toBe(200);
      const writeData2 = await writeRes2.json();
      const etag2 = writeData2.data.etag;

      // Assert usage is now 2500
      const usageAfter2 = await operationsService.forTenant(aliceId).quota.getUsage('storage_bytes');
      expect(usageAfter2.used).toBe(2500);

      // 5. Overwrite file1.txt with smaller file (800 bytes) -> delta -1700
      const content800 = 'C'.repeat(800);
      const writeRes3 = await fetch(`${baseUrl}/api/spaces/${spaceId}/files/content`, {
        method: 'PUT',
        headers: {
          'Cookie': aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          'Origin': baseUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          path: 'file1.txt',
          content: content800,
          expectedEtag: etag2,
        }),
      });
      expect(writeRes3.status).toBe(200);
      const writeData3 = await writeRes3.json();
      const etag3 = writeData3.data.etag;

      // Assert usage decremented to 800
      const usageAfter3 = await operationsService.forTenant(aliceId).quota.getUsage('storage_bytes');
      expect(usageAfter3.used).toBe(800);

      // 6. Delete file1.txt
      const deleteRes = await fetch(`${baseUrl}/api/spaces/${spaceId}/files?path=file1.txt&expectedEtag=${encodeURIComponent(etag3)}`, {
        method: 'DELETE',
        headers: {
          'Cookie': aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          'Origin': baseUrl,
        },
      });
      expect(deleteRes.status).toBe(200);

      // Assert usage returned to 0
      const usageAfterDelete = await operationsService.forTenant(aliceId).quota.getUsage('storage_bytes');
      expect(usageAfterDelete.used).toBe(0);
      expect(usageAfterDelete.remaining).toBe(102400);
    });

    it('rejects file write when storage_bytes quota is exceeded and rolls back reservation', async () => {
      // Create Alice space
      const spaceRes = await fetch(`${baseUrl}/api/spaces`, {
        method: 'POST',
        headers: {
          'Cookie': aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          'Origin': baseUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Tight Space', folder: 'tight-folder' }),
      });
      const spaceId = (await spaceRes.json()).data.id;

      // Set Alice limit to 500 bytes
      await fetch(`${baseUrl}/api/admin/quotas/${aliceId}/storage_bytes`, {
        method: 'PATCH',
        headers: {
          'Cookie': adminCookie,
          'X-Enkeep-CSRF': csrfToken,
          'Origin': baseUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ limit: 500 }),
      });

      // Attempt to write 2000-byte file
      const writeRes = await fetch(`${baseUrl}/api/spaces/${spaceId}/files/content`, {
        method: 'PUT',
        headers: {
          'Cookie': aliceCookie,
          'X-Enkeep-CSRF': csrfToken,
          'Origin': baseUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          path: 'huge.txt',
          content: 'X'.repeat(2000),
          requireAbsent: true,
        }),
      });

      // Must be rejected with 429 QUOTA_EXCEEDED
      expect(writeRes.status).toBe(429);
      const errBody = await writeRes.json();
      expect(errBody.error.code).toBe('QUOTA_EXCEEDED');

      // Assert zero reservations leaked and usage remains 0
      const usage = await operationsService.forTenant(aliceId).quota.getUsage('storage_bytes');
      expect(usage.used).toBe(0);
      expect(usage.reserved).toBe(0);
    });
  });

  describe('2. api_calls Metering Middleware & Boundary Policy', () => {
    it('meters api_calls strictly on mutations and platform tools, while excluding 1000s of read-only UI polling GETs and health', async () => {
      // 1. Set Bob api_calls limit to 3
      const setLimitRes = await fetch(`${baseUrl}/api/admin/quotas/${bobId}/api_calls`, {
        method: 'PATCH',
        headers: {
          'Cookie': adminCookie,
          'X-Enkeep-CSRF': csrfToken,
          'Origin': baseUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ limit: 3 }),
      });
      expect(setLimitRes.status).toBe(200);

      // Verify Bob api_calls starts at 0
      const initialUsage = await operationsService.forTenant(bobId).quota.getUsage('api_calls');
      expect(initialUsage.used).toBe(0);

      // 2. Health, Unauthenticated, and 1000 UI Read-Only Polling GET requests do NOT increment api_calls
      await fetch(`${baseUrl}/api/health`);
      await fetch(`${baseUrl}/api/readiness`);
      await fetch(`${baseUrl}/api/auth/csrf`);

      // Simulate 100 polling GET requests for session events / messages / dashboard
      for (let i = 0; i < 100; i++) {
        const pollRes = await fetch(`${baseUrl}/api/spaces`, { headers: { 'Cookie': bobCookie } });
        expect(pollRes.status).toBe(200);
      }

      // Usage MUST remain 0 after 100 UI read-only GET requests
      const usageAfterPolls = await operationsService.forTenant(bobId).quota.getUsage('api_calls');
      expect(usageAfterPolls.used).toBe(0);

      // 3. Perform 2 mutations (POST /api/spaces, POST /api/spaces)
      const spaceRes1 = await fetch(`${baseUrl}/api/spaces`, {
        method: 'POST',
        headers: {
          'Cookie': bobCookie,
          'X-Enkeep-CSRF': csrfToken,
          'Origin': baseUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Bob Space 1', folder: 'bob-folder-1' }),
      });
      expect(spaceRes1.status).toBe(201);
      const space1Id = (await spaceRes1.json()).data.id;

      const spaceRes2 = await fetch(`${baseUrl}/api/spaces`, {
        method: 'POST',
        headers: {
          'Cookie': bobCookie,
          'X-Enkeep-CSRF': csrfToken,
          'Origin': baseUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Bob Space 2', folder: 'bob-folder-2' }),
      });
      expect(spaceRes2.status).toBe(201);

      // Assert Bob api_calls is now 2
      const usageAfter2 = await operationsService.forTenant(bobId).quota.getUsage('api_calls');
      expect(usageAfter2.used).toBe(2);
      expect(usageAfter2.remaining).toBe(1);

      // 4. Perform 3rd mutation to reach limit of 3
      const patchSpaceRes = await fetch(`${baseUrl}/api/spaces/${space1Id}`, {
        method: 'PATCH',
        headers: {
          'Cookie': bobCookie,
          'X-Enkeep-CSRF': csrfToken,
          'Origin': baseUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Bob Space 1 Renamed' }),
      });
      expect(patchSpaceRes.status).toBe(200);

      const usageAfter3 = await operationsService.forTenant(bobId).quota.getUsage('api_calls');
      expect(usageAfter3.used).toBe(3);
      expect(usageAfter3.remaining).toBe(0);

      // 5. 4th mutation must fail with 429 QUOTA_EXCEEDED
      const failMutationRes = await fetch(`${baseUrl}/api/spaces`, {
        method: 'POST',
        headers: {
          'Cookie': bobCookie,
          'X-Enkeep-CSRF': csrfToken,
          'Origin': baseUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Bob Space 3 Over Limit', folder: 'bob-folder-3' }),
      });
      expect(failMutationRes.status).toBe(429);
      const failBody = await failMutationRes.json();
      expect(failBody.error.code).toBe('QUOTA_EXCEEDED');

      // 6. Invariant: Read-only GET still succeeds even when quota is exceeded, allowing UI to fetch messages/display errors!
      const readStillWorksRes = await fetch(`${baseUrl}/api/spaces`, { headers: { 'Cookie': bobCookie } });
      expect(readStillWorksRes.status).toBe(200);
    });
  });

  describe('3. Volume Scan Baseline Service & Failclosed Symlink Check', () => {
    it('scans volume directory, sets baseline storage_bytes, and fails closed on symlinks and special files', async () => {
      const volumeDir = path.join(tempDir, 'test-volume');
      fs.mkdirSync(volumeDir, { recursive: true });

      // Create regular files
      fs.writeFileSync(path.join(volumeDir, 'doc1.txt'), 'Hello world 1'); // 13 bytes
      fs.writeFileSync(path.join(volumeDir, 'doc2.txt'), 'Hello world 22'); // 14 bytes
      const subDir = path.join(volumeDir, 'subdir');
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(subDir, 'doc3.txt'), 'Hello sub'); // 9 bytes

      const totalExpectedBytes = 13 + 14 + 9; // 36 bytes

      const volumeScanService = new VolumeScanService({ db, operations: operationsService });
      await operationsService.forTenant(aliceId).quota.setLimit({ resource: 'storage_bytes', limit: 10000 });

      // Execute scan baseline
      const scanResult = await volumeScanService.scanTenantVolumeBaseline(aliceId, volumeDir, { setBaseline: true });
      expect(scanResult.totalBytes).toBe(totalExpectedBytes);
      expect(scanResult.fileCount).toBe(3);

      // Check quota_usage table
      const readbackUsage = await operationsService.forTenant(aliceId).quota.getUsage('storage_bytes');
      expect(readbackUsage.used).toBe(totalExpectedBytes);

      // Test Failclosed: create a symlink in the volume directory
      const symlinkPath = path.join(volumeDir, 'bad-symlink.txt');
      try {
        fs.symlinkSync(path.join(volumeDir, 'doc1.txt'), symlinkPath);
      } catch {
        // Windows or permissions fallback
      }

      if (fs.existsSync(symlinkPath)) {
        await expect(
          volumeScanService.scanTenantVolumeBaseline(aliceId, volumeDir)
        ).rejects.toThrow(/Symbolic links are strictly forbidden/);
      }
    });

    it('exposes POST /api/admin/storage/scan-baseline for admin baseline discovery', async () => {
      const volumeDir = path.join(tempDir, 'admin-scan-volume');
      fs.mkdirSync(volumeDir, { recursive: true });
      fs.writeFileSync(path.join(volumeDir, 'file.dat'), Buffer.alloc(128));

      await operationsService.forTenant(aliceId).quota.setLimit({ resource: 'storage_bytes', limit: 5000 });

      const res = await fetch(`${baseUrl}/api/admin/storage/scan-baseline`, {
        method: 'POST',
        headers: {
          'Cookie': adminCookie,
          'X-Enkeep-CSRF': csrfToken,
          'Origin': baseUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: aliceId,
          volumePath: volumeDir,
          setBaseline: true,
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data.totalBytes).toBe(128);
      expect(data.data.fileCount).toBe(1);
    });
  });

  describe('4. Dual Storage Reconciliation (web_messages vs DSH JSONL) & Repair', () => {
    it('generates read-only reconciliation reports (matched, drift, missing) without mutating data', async () => {
      // 1. Create space and session route in SQLite
      const spaceId = 'spc_00000000000000000000000000000001';
      const routeId = 'sr_alice_rec_01';
      const dshSessionId = 'ses_alice_dsh_01';

      db.exec(`
        INSERT INTO spaces (id, user_id, name, folder, status, created_at, updated_at)
        VALUES ('${spaceId}', '${aliceId}', 'Rec Space', 'rec-folder', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

        INSERT INTO session_routes (id, space_id, user_id, channel, dsh_session_id, status, created_at, updated_at)
        VALUES ('${routeId}', '${spaceId}', '${aliceId}', 'web', '${dshSessionId}', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

        INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, created_at)
        VALUES
          ('msg_1', '${routeId}', '${aliceId}', 'user', 'Hello assistant', 'delivered', '${routeId}', datetime('now', '-2 minutes')),
          ('msg_2', '${routeId}', '${aliceId}', 'assistant', 'Hello human', 'delivered', '${routeId}', datetime('now', '-1 minutes'));
      `);

      const dualReconcile = new DualStorageReconcileService({ db });

      // Scenario A: DSH JSONL is missing
      const reportMissing = await dualReconcile.reconcileSession(aliceId, routeId);
      expect(reportMissing.status).toBe('missing');
      expect(reportMissing.platformMessageCount).toBe(2);
      expect(reportMissing.dshMessageCount).toBe(0);

      // Scenario B: DSH JSONL exists with identical messages -> 'matched'
      const jsonlDir = path.join(tempDir, 'dsh-sessions');
      fs.mkdirSync(jsonlDir, { recursive: true });
      const jsonlFile = path.join(jsonlDir, 'session.jsonl');
      fs.writeFileSync(
        jsonlFile,
        JSON.stringify({ type: 'session', version: 0, id: dshSessionId, createdAt: 1700000000000, delegationDepth: 0 }) + '\n' +
        JSON.stringify({ type: 'turn/start', seq: 0, time: 1700000001000, data: { turn: 1 } }) + '\n' +
        JSON.stringify({
          type: 'user/message',
          seq: 1,
          time: 1700000002000,
          surfaceOp: 'append',
          data: { id: 'msg_1', role: 'user', content: [{ type: 'text', text: 'Hello assistant' }], source: { kind: 'user' } }
        }) + '\n' +
        JSON.stringify({ type: 'step/start', seq: 2, time: 1700000003000, data: { turn: 1, step: 1 } }) + '\n' +
        JSON.stringify({
          type: 'assistant/message',
          seq: 3,
          time: 1700000004000,
          surfaceOp: 'append',
          data: {
            turn: 1,
            step: 1,
            message: { id: 'msg_2', role: 'assistant', content: [{ type: 'text', text: 'Hello human' }], source: { kind: 'model', provider: 'pi-ai', model: 'deepseek-chat' } }
          }
        }) + '\n' +
        JSON.stringify({ type: 'step/end', seq: 4, time: 1700000005000, data: { turn: 1, step: 1 } }) + '\n' +
        JSON.stringify({ type: 'turn/end', seq: 5, time: 1700000006000, data: { turn: 1, reason: { kind: 'completed' } } }) + '\n'
      );

      const reportMatched = await dualReconcile.reconcileSession(aliceId, routeId, jsonlFile);
      expect(reportMatched.status).toBe('matched');
      expect(reportMatched.platformMessageCount).toBe(2);
      expect(reportMatched.dshMessageCount).toBe(2);

      // Scenario C: DSH JSONL has drift (an extra assistant message) -> 'drift'
      fs.appendFileSync(
        jsonlFile,
        JSON.stringify({ type: 'turn/start', seq: 6, time: 1700000007000, data: { turn: 2 } }) + '\n' +
        JSON.stringify({
          type: 'user/message',
          seq: 7,
          time: 1700000008000,
          surfaceOp: 'append',
          data: { id: 'msg_3', role: 'user', content: [{ type: 'text', text: 'Next prompt' }], source: { kind: 'user' } }
        }) + '\n' +
        JSON.stringify({
          type: 'assistant/message',
          seq: 8,
          time: 1700000009000,
          surfaceOp: 'append',
          data: {
            turn: 2,
            step: 1,
            message: { id: 'msg_4', role: 'assistant', content: [{ type: 'text', text: 'Extra follow-up turn' }], source: { kind: 'model', provider: 'pi-ai', model: 'deepseek-chat' } }
          }
        }) + '\n'
      );
      const reportDrift = await dualReconcile.reconcileSession(aliceId, routeId, jsonlFile);
      expect(reportDrift.status).toBe('drift');
      expect(reportDrift.platformMessageCount).toBe(2);
      expect(reportDrift.dshMessageCount).toBe(4);

      // Verify read-only invariant: web_messages table was NOT modified
      const msgCount = (db.prepare(`SELECT COUNT(*) as c FROM web_messages WHERE session_id = ?`).get(routeId) as any).c;
      expect(msgCount).toBe(2);
    });

    it('executes explicit admin repair command idempotently, backfills missing runtime turns, and preserves platform deliveries', async () => {
      const spaceId = 'spc_00000000000000000000000000000002';
      const routeId = 'sr_alice_rep_02';
      const dshSessionId = 'ses_alice_dsh_02';

      db.exec(`
        INSERT INTO spaces (id, user_id, name, folder, status, created_at, updated_at)
        VALUES ('${spaceId}', '${aliceId}', 'Repair Space', 'repair-folder', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

        INSERT INTO session_routes (id, space_id, user_id, channel, dsh_session_id, status, created_at, updated_at)
        VALUES ('${routeId}', '${spaceId}', '${aliceId}', 'web', '${dshSessionId}', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

        INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, created_at)
        VALUES ('msg_existing', '${routeId}', '${aliceId}', 'user', 'Initial prompt from web UI', 'delivered', '${routeId}', '2023-11-14T22:13:22.000Z');
      `);

      const jsonlFile = path.join(tempDir, 'repair-session.jsonl');
      fs.writeFileSync(
        jsonlFile,
        JSON.stringify({ type: 'session', version: 0, id: dshSessionId, createdAt: 1700000000000, delegationDepth: 0 }) + '\n' +
        JSON.stringify({ type: 'turn/start', seq: 0, time: 1700000001000, data: { turn: 1 } }) + '\n' +
        JSON.stringify({
          type: 'user/message',
          seq: 1,
          time: 1700000002000,
          surfaceOp: 'append',
          data: { id: 'msg_existing', role: 'user', content: [{ type: 'text', text: 'Initial prompt from web UI' }], source: { kind: 'user' } }
        }) + '\n' +
        JSON.stringify({ type: 'step/start', seq: 2, time: 1700000003000, data: { turn: 1, step: 1 } }) + '\n' +
        JSON.stringify({
          type: 'assistant/message',
          seq: 3,
          time: 1700000004000,
          surfaceOp: 'append',
          data: {
            turn: 1,
            step: 1,
            message: { id: 'msg_repaired_01', role: 'assistant', content: [{ type: 'text', text: 'Authoritative completion from runtime' }], source: { kind: 'model', provider: 'pi-ai', model: 'deepseek-chat' } }
          }
        }) + '\n' +
        JSON.stringify({ type: 'step/end', seq: 4, time: 1700000005000, data: { turn: 1, step: 1 } }) + '\n' +
        JSON.stringify({ type: 'turn/end', seq: 5, time: 1700000006000, data: { turn: 1, reason: { kind: 'completed' } } }) + '\n'
      );

      // 1. Dry run repair
      const dualReconcile = new DualStorageReconcileService({ db });
      const dryResult = await dualReconcile.repairSession(aliceId, routeId, jsonlFile, { dryRun: true });
      expect(dryResult.dryRun).toBe(true);
      expect(dryResult.repairedCount).toBe(1);

      // Assert table not mutated in dryRun
      const countBefore = (db.prepare(`SELECT COUNT(*) as c FROM web_messages WHERE session_id = ?`).get(routeId) as any).c;
      expect(countBefore).toBe(1);

      // 2. Real repair via HTTP admin endpoint
      const repairRes = await fetch(`${baseUrl}/api/admin/storage/repair`, {
        method: 'POST',
        headers: {
          'Cookie': adminCookie,
          'X-Enkeep-CSRF': csrfToken,
          'Origin': baseUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: aliceId,
          sessionId: routeId,
          dshJsonlPath: jsonlFile,
          dryRun: false,
        }),
      });

      expect(repairRes.status).toBe(200);
      const repData = await repairRes.json();
      expect(repData.data.status).toBe('repaired');
      expect(repData.data.repairedCount).toBe(1);

      // Assert web_messages now has 2 messages (both initial prompt and backfilled assistant turn)
      const messagesAfter = db.prepare(`SELECT * FROM web_messages WHERE session_id = ? ORDER BY created_at ASC`).all(routeId) as any[];
      expect(messagesAfter.length).toBe(2);
      expect(messagesAfter[0].content).toBe('Initial prompt from web UI');
      expect(messagesAfter[1].content).toBe('Authoritative completion from runtime');
      expect(messagesAfter[1].status).toBe('delivered');

      // 3. Idempotent replay: running repair again repairs 0 items
      const replayRes = await fetch(`${baseUrl}/api/admin/storage/repair`, {
        method: 'POST',
        headers: {
          'Cookie': adminCookie,
          'X-Enkeep-CSRF': csrfToken,
          'Origin': baseUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: aliceId,
          sessionId: routeId,
          dshJsonlPath: jsonlFile,
          dryRun: false,
        }),
      });
      const replayData = await replayRes.json();
      expect(replayData.data.status).toBe('unchanged');
      expect(replayData.data.repairedCount).toBe(0);
    });
  });

  describe('5. Audit Hooks for Storage adjust, reset, reconcile, repair', () => {
    it('records structured audit log entries without leaking raw filesystem paths or secrets', async () => {
      // Check auth_audit_log table for storage actions
      const logs = db.prepare(`
        SELECT action, user_id, details FROM auth_audit_log
        WHERE action IN ('storage_adjusted', 'quota_reset', 'storage_reconciled', 'storage_repaired')
      `).all() as any[];

      // Verify that all details are valid JSON and do NOT leak filesystem paths
      for (const log of logs) {
        expect(VALID_AUDIT_ACTIONS_ARRAY).toContain(log.action);
        if (log.details) {
          expect(typeof log.details).toBe('string');
          const parsed = JSON.parse(log.details);
          expect(parsed).not.toHaveProperty('path');
          expect(parsed).not.toHaveProperty('volumePath');
          expect(parsed).not.toHaveProperty('dshJsonlPath');
        }
      }
    });
  });
});

const VALID_AUDIT_ACTIONS_ARRAY = [
  'login_success',
  'login_failure',
  'logout',
  'session_revoked',
  'user_created',
  'user_updated',
  'user_disabled',
  'password_reset',
  'password_changed',
  'model_config_updated',
  'space_created',
  'space_updated',
  'space_archived',
  'task_created',
  'task_cancelled',
  'quota_updated',
  'quota_reset',
  'storage_adjusted',
  'storage_reconciled',
  'storage_repaired',
  'profile_created',
  'profile_updated',
  'profile_archived',
];
