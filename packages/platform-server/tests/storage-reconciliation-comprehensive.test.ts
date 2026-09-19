import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import {
  DualStorageReconcileService,
  computeDshProjectKey,
  encodeSessionSegment,
} from '../src/storage/dual-storage-reconcile.js';
import {
  parseDshSessionJsonl,
  computeCanonicalMessagesHash,
  type DshSessionHeader,
  type DshSessionEvent,
} from '../src/storage/session-event-parser.js';
import { PlatformServerMigrationRunner, ALL_PLATFORM_MIGRATIONS } from '../src/storage/migrations.js';
import { createPlatformServerHandler } from '../src/server/handler.js';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { DefaultAuthService, provisionFixtures } from '@enkeep/platform-auth';

describe('Storage Reconciliation Comprehensive Suite (Falsemissing + Dangerousrepair Fix)', () => {
  let tempDir: string;
  let dshHome: string;
  let db: DatabaseSync;
  let server: http.Server;
  let baseUrl: string;

  const testUserId = 'usr_alice_reconcile_01';
  const testSpaceId = 'spc_alice_reconcile_01';
  const testSpaceFolder = 'main-workspace';
  const csrfToken = 'test-csrf-token-must-be-at-least-32-characters-long';
  const cookieSecret = 'test-cookie-secret-must-be-at-least-32-characters-long';

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-comp-test-'));
    dshHome = path.join(tempDir, '.dsh');
    fs.mkdirSync(path.join(dshHome, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(dshHome, 'spaces', testSpaceFolder), { recursive: true });

    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    // Seed test user, space, active canonical route, archived route, and generations
    db.exec(`
      INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
      VALUES ('${testUserId}', 'alice', 'hash', 'admin', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

      INSERT INTO spaces (id, user_id, name, folder, execution_mode, status, created_at, updated_at)
      VALUES ('${testSpaceId}', '${testUserId}', 'Main Space', '${testSpaceFolder}', 'host', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

      -- Active canonical route (Host mode, 2 messages)
      INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, status, current_generation, created_at, updated_at)
      VALUES ('sr_active_host', '${testSpaceId}', '${testUserId}', 'web', 'web-demo', 'ctx_1', 'peer_1', 'ses_host_dsh_01', 'container', 'active', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

      -- Archived legacy route (merged/archived, 0 messages)
      INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, status, current_generation, created_at, updated_at)
      VALUES ('sr_archived_leg', '${testSpaceId}', '${testUserId}', 'web', 'web-demo', 'ctx_2', 'peer_2', 'ses_archived_dsh_02', 'host', 'archived', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

      -- Active uninitialized empty placeholder route (0 messages in SQLite, no JSONL file yet)
      INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, status, current_generation, created_at, updated_at)
      VALUES ('sr_uninit_place', '${testSpaceId}', '${testUserId}', 'web', 'web-demo', 'ctx_3', 'peer_3', 'ses_uninit_dsh_03', 'host', 'active', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

      -- Generation tracking row
      INSERT INTO session_generations (id, user_id, route_id, generation_number, dsh_session_id, created_at)
      VALUES ('gen_active_1', '${testUserId}', 'sr_active_host', 1, 'ses_host_dsh_01', CURRENT_TIMESTAMP);
    `);
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((res) => server.close(() => res()));
    }
    try {
      db.close();
    } catch {}
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  /**
   * Helper to write a genuine DSH session JSONL log.
   */
  function writeDshSessionLog(filePath: string, sessionId: string, messages: Array<{ role: 'user' | 'assistant'; text: string }>): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const header: DshSessionHeader = {
      type: 'session',
      version: 0,
      id: sessionId,
      createdAt: 1700000000000,
      delegationDepth: 0,
    };
    const events: DshSessionEvent[] = [];
    let seq = 0;
    events.push({ type: 'turn/start', seq: seq++, time: 1700000001000, data: { turn: 1 } });
    for (const m of messages) {
      if (m.role === 'user') {
        events.push({
          type: 'user/message',
          seq: seq++,
          time: 1700000002000,
          surfaceOp: 'append',
          data: { id: `msg_${seq}`, role: 'user', content: [{ type: 'text', text: m.text }], source: { kind: 'user' } },
        });
      } else {
        events.push({
          type: 'assistant/message',
          seq: seq++,
          time: 1700000003000,
          surfaceOp: 'append',
          data: {
            turn: 1,
            step: 1,
            message: { id: `msg_${seq}`, role: 'assistant', content: [{ type: 'text', text: m.text }] },
          },
        });
      }
    }
    events.push({ type: 'turn/end', seq: seq++, time: 1700000004000, data: { turn: 1, reason: { kind: 'completed' } } });
    const content = [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join('\n') + '\n';
    fs.writeFileSync(filePath, content, 'utf8');
  }

  it('1. Resolves active host session via official projectKey nested path and matches SQLite', async () => {
    const hostSpacePath = path.join(dshHome, 'spaces', testSpaceFolder);
    const pKey = computeDshProjectKey(hostSpacePath);
    const encId = encodeSessionSegment('ses_host_dsh_01');
    const nestedLogPath = path.join(dshHome, 'sessions', pKey, encId, 'session.jsonl');

    // Write session log to official nested path
    writeDshSessionLog(nestedLogPath, 'ses_host_dsh_01', [
      { role: 'user', text: 'Hello host DSH agent' },
      { role: 'assistant', text: 'Hello human from host' },
    ]);

    // Seed matching rows in SQLite web_messages
    db.prepare(`
      INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, created_at)
      VALUES 
        ('msg_u1', 'sr_active_host', '${testUserId}', 'user', 'Hello host DSH agent', 'delivered', 'sr_active_host', datetime('now', '-2 minutes')),
        ('msg_a1', 'sr_active_host', '${testUserId}', 'assistant', 'Hello human from host', 'delivered', 'sr_active_host', datetime('now', '-1 minutes'));
    `).run();

    // Notice route has execution_mode = 'container' in DB, but space has execution_mode = 'host'
    // Authoritative Space mode MUST override stale route.execution_mode!
    const service = new DualStorageReconcileService({ db, dshHome });
    const report = await service.reconcileSession(testUserId, 'sr_active_host');

    expect(report.status).toBe('matched');
    expect(report.dshReadStatus).toBe('FOUND');
    expect(report.platformMessageCount).toBe(2);
    expect(report.dshMessageCount).toBe(2);
    expect(report.executionMode).toBe('host');
    expect(report.discrepancies).toBeUndefined();
  });

  it('2. Uses container readonly provider fixture with streaming events, not returning empty []', async () => {
    // Setup a container session route in container space
    db.exec(`
      INSERT INTO spaces (id, user_id, name, folder, execution_mode, status, created_at, updated_at)
      VALUES ('spc_container_02', '${testUserId}', 'Container Space', 'cont-workspace', 'container', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

      INSERT INTO session_routes (id, space_id, user_id, channel, peer_id, dsh_session_id, execution_mode, status, current_generation, created_at, updated_at)
      VALUES ('sr_container_sess', 'spc_container_02', '${testUserId}', 'web', 'peer_c1', 'ses_cont_dsh_99', 'container', 'active', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

      INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, created_at)
      VALUES ('msg_c1', 'sr_container_sess', '${testUserId}', 'user', 'Ping container', 'delivered', 'sr_container_sess', datetime('now', '-1 minute'));
    `);

    // Injected session log reader returning valid non-empty container events
    const service = new DualStorageReconcileService({
      db,
      dshHome,
      sessionLogReader: async (ctx) => {
        if (ctx.dshSessionId === 'ses_cont_dsh_99') {
          const parsed = parseDshSessionJsonl(
            [
              JSON.stringify({ type: 'session', version: 0, id: 'ses_cont_dsh_99', createdAt: 1700000000000, delegationDepth: 0 }),
              JSON.stringify({ type: 'turn/start', seq: 0, time: 1700000001000, data: { turn: 1 } }),
              JSON.stringify({
                type: 'user/message',
                seq: 1,
                time: 1700000002000,
                surfaceOp: 'append',
                data: { id: 'msg_c1', role: 'user', content: [{ type: 'text', text: 'Ping container' }], source: { kind: 'user' } },
              }),
              JSON.stringify({ type: 'turn/end', seq: 2, time: 1700000003000, data: { turn: 1, reason: { kind: 'completed' } } }),
            ].join('\n') + '\n',
            { sessionId: 'sr_container_sess' }
          );

          return {
            status: 'FOUND',
            isEmpty: false,
            messageCount: 1,
            canonicalHash: parsed.canonicalHash,
            parsedSession: parsed,
            executionMode: 'container',
            rawSha256: parsed.fileSnapshot.rawSha256,
          };
        }
        return null;
      },
    });

    const report = await service.reconcileSession(testUserId, 'sr_container_sess');
    expect(report.status).toBe('matched');
    expect(report.dshReadStatus).toBe('FOUND');
    expect(report.platformMessageCount).toBe(1);
    expect(report.dshMessageCount).toBe(1);
    expect(report.executionMode).toBe('container');
  });

  it('3. Distinguishes uninitialized empty placeholder from matched and missing', async () => {
    const service = new DualStorageReconcileService({ db, dshHome });

    // sr_uninit_place has 0 messages in SQLite and no JSONL on disk
    // It must NOT be labeled as missing (which implies data loss) or matched (which is false green)
    const reportUninit = await service.reconcileSession(testUserId, 'sr_uninit_place');
    expect(reportUninit.status).toBe('uninitialized');
    expect(reportUninit.dshReadStatus).toBe('MISSING');
    expect(reportUninit.platformMessageCount).toBe(0);
    expect(reportUninit.dshMessageCount).toBe(0);
    expect(reportUninit.details?.reason).toBe('uninitialized_session_placeholder');

    // sr_archived_leg has status 'archived' in session_routes
    const reportArchived = await service.reconcileSession(testUserId, 'sr_archived_leg');
    expect(reportArchived.isArchived).toBe(true);
    expect(reportArchived.status).toBe('uninitialized');
  });

  it('4. Distinguishes MISSING, PARSE_ERROR, and UNAVAILABLE statuses', async () => {
    // A. MISSING: SQLite has messages, but DSH file is missing
    db.prepare(`
      INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, created_at)
      VALUES ('msg_orphan_sql', 'sr_active_host', '${testUserId}', 'user', 'Where is my runtime log?', 'delivered', 'sr_active_host', datetime('now'));
    `).run();

    const serviceMissing = new DualStorageReconcileService({ db, dshHome });
    const repMissing = await serviceMissing.reconcileSession(testUserId, 'sr_active_host');
    expect(repMissing.status).toBe('missing');
    expect(repMissing.dshReadStatus).toBe('MISSING');
    expect(repMissing.details?.reason).toBe('dsh_jsonl_missing');

    // B. PARSE_ERROR: JSONL file is corrupt (malformed JSON syntax)
    const corruptFile = path.join(dshHome, 'sessions', 'corrupt.jsonl');
    fs.writeFileSync(corruptFile, 'INVALID_NOT_A_JSON_OBJECT\n');
    const repParseErr = await serviceMissing.reconcileSession(testUserId, 'sr_active_host', corruptFile);
    expect(repParseErr.status).toBe('parse_error');
    expect(repParseErr.dshReadStatus).toBe('PARSE_ERROR');
    expect(repParseErr.details?.reason).toBe('dsh_jsonl_parse_error');

    // C. UNAVAILABLE: Provider throws network/daemon error
    const serviceUnavail = new DualStorageReconcileService({
      db,
      dshHome,
      sessionLogReader: async () => {
        return {
          status: 'UNAVAILABLE',
          isEmpty: true,
          messageCount: 0,
          canonicalHash: computeCanonicalMessagesHash([]),
          error: 'Docker daemon connection refused on /var/run/docker.sock',
        };
      },
    });
    const repUnavail = await serviceUnavail.reconcileSession(testUserId, 'sr_active_host');
    expect(repUnavail.status).toBe('unavailable');
    expect(repUnavail.dshReadStatus).toBe('UNAVAILABLE');
    expect(repUnavail.details?.reason).toBe('dsh_runtime_unavailable');
  });

  it('5. Safety Guard: Hard refuses repair mutations when source is unreadable, 0 messages, or active turn in progress', async () => {
    const service = new DualStorageReconcileService({ db, dshHome });

    // Seed messages in SQLite
    db.prepare(`
      INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, created_at)
      VALUES ('msg_safe_1', 'sr_active_host', '${testUserId}', 'user', 'Valuable message', 'delivered', 'sr_active_host', datetime('now'));
    `).run();

    const initialSqlHash = (db.prepare(`SELECT content FROM web_messages WHERE session_id = 'sr_active_host'`).get() as any).content;
    const initialSqlRows = (db.prepare(`SELECT COUNT(*) as c FROM web_messages WHERE session_id = 'sr_active_host'`).get() as any).c;

    // A. Source is missing -> Repair REFUSED with 412
    await expect(service.repairSession(testUserId, 'sr_active_host')).rejects.toThrow(/Runtime session source is MISSING/);

    // B. Source is empty (0 messages) while SQLite is positive -> Repair REFUSED with 412
    const emptyJsonl = path.join(dshHome, 'sessions', 'empty-header-only.jsonl');
    fs.writeFileSync(
      emptyJsonl,
      JSON.stringify({ type: 'session', version: 0, id: 'ses_host_dsh_01', createdAt: 1700000000000, delegationDepth: 0 }) + '\n'
    );
    await expect(service.repairSession(testUserId, 'sr_active_host', emptyJsonl)).rejects.toThrow(/aborting to prevent data loss/);

    // C. Destructive deleteOrphans requested -> Repair REFUSED with 403
    await expect(
      service.repairSession(testUserId, 'sr_active_host', emptyJsonl, { deleteOrphans: true })
    ).rejects.toThrow(/Destructive orphan deletion is disabled for storage safety/);

    // D. Active turn in progress -> Repair REFUSED with 409
    db.prepare(`
      INSERT INTO turn_runs (id, user_id, space_id, route_id, turn_id, status, created_at, updated_at)
      VALUES ('turn_run_active_test', '${testUserId}', '${testSpaceId}', 'sr_active_host', 'turn_active_1', 'running', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    `).run();
    await expect(service.repairSession(testUserId, 'sr_active_host', emptyJsonl)).rejects.toThrow(/active or queued turn run is currently in progress/);

    // Verify SQLite was completely untouched
    const afterSqlHash = (db.prepare(`SELECT content FROM web_messages WHERE session_id = 'sr_active_host'`).get() as any).content;
    const afterSqlRows = (db.prepare(`SELECT COUNT(*) as c FROM web_messages WHERE session_id = 'sr_active_host'`).get() as any).c;
    expect(afterSqlHash).toBe(initialSqlHash);
    expect(afterSqlRows).toBe(initialSqlRows);
  });

  it('6. Preserves real content differences (HomeHost 3 empty assistant & UTF-8 replacement glyph), never auto-normalizing to green', async () => {
    const service = new DualStorageReconcileService({ db, dshHome });

    // Seed SQLite message with UTF-8 replacement character \uFFFD from daemon decode bug
    db.prepare(`
      INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, created_at)
      VALUES ('msg_utf8_diff', 'sr_active_host', '${testUserId}', 'assistant', 'Response with \uFFFD character', 'delivered', 'sr_active_host', datetime('now'));
    `).run();

    // DSH JSONL has the clean UTF-8 string
    const cleanJsonl = path.join(dshHome, 'sessions', 'clean-utf8.jsonl');
    writeDshSessionLog(cleanJsonl, 'ses_host_dsh_01', [
      { role: 'assistant', text: 'Response with 🚀 character' },
    ]);

    const report = await service.reconcileSession(testUserId, 'sr_active_host', cleanJsonl);
    // Must report drift with contentMismatch, NOT auto-normalized to matched!
    expect(report.status).toBe('drift');
    expect(report.discrepancies).toBeDefined();
    expect(report.discrepancies?.[0].type).toBe('contentMismatch');
    expect(report.discrepancies?.[0].sqliteContent).toBe('Response with \uFFFD character');
    expect(report.discrepancies?.[0].dshContent).toBe('Response with 🚀 character');
  });

  it('7. Strict additive repair: contentMismatch preserves exact before hash/bytes, reports unresolved; absent row inserts; duplicate never overwrites', async () => {
    const service = new DualStorageReconcileService({ db, dshHome });

    // Seed SQLite with an existing message that has different content from runtime (contentMismatch)
    db.prepare(`
      INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, created_at)
      VALUES ('msg_exist_1', 'sr_active_host', '${testUserId}', 'user', 'Original SQLite Message Content', 'delivered', 'sr_active_host', '2023-11-14 20:00:00');
    `).run();

    const beforeRow = db.prepare(`SELECT * FROM web_messages WHERE id = 'msg_exist_1'`).get() as any;
    const beforeContent = beforeRow.content;
    const beforeStatus = beforeRow.status;
    const beforeCreatedAt = beforeRow.created_at;

    // Runtime has msg_exist_1 with different text + a brand new absent message msg_new_2
    const testJsonl = path.join(dshHome, 'sessions', 'strict-insert-test.jsonl');
    writeDshSessionLog(testJsonl, 'ses_host_dsh_01', [
      { role: 'user', text: 'Mutated In Runtime Log' },
      { role: 'assistant', text: 'Brand New Absent Row' },
    ]);

    // 1. Repair execution
    const repairResult = await service.repairSession(testUserId, 'sr_active_host', testJsonl);
    expect(repairResult.repairedCount).toBe(1); // Only the absent row msg_2 is inserted
    expect(repairResult.unresolvedCount).toBe(1); // The contentMismatch row is left unresolved
    expect(repairResult.unresolvedDiscrepancies?.[0].type).toBe('contentMismatch');

    // 2. Verify existing row msg_exist_1 is 100% UNTOUCHED (content, status, created_at unchanged)
    const afterRow = db.prepare(`SELECT * FROM web_messages WHERE id = 'msg_exist_1'`).get() as any;
    expect(afterRow.content).toBe(beforeContent);
    expect(afterRow.status).toBe(beforeStatus);
    expect(afterRow.created_at).toBe(beforeCreatedAt);

    // 3. Verify absent row was cleanly inserted
    const insertedRows = db.prepare(`SELECT * FROM web_messages WHERE session_id = 'sr_active_host'`).all() as any[];
    expect(insertedRows.length).toBe(2);

    // 4. Duplicate concurrent insert via ON CONFLICT DO NOTHING never overwrites
    const duplicateRun = await service.repairSession(testUserId, 'sr_active_host', testJsonl);
    expect(duplicateRun.status).toBe('unchanged');
    expect(duplicateRun.repairedCount).toBe(0);

    // 5. Destructive flag deleteOrphans is unconditionally 403
    await expect(
      service.repairSession(testUserId, 'sr_active_host', testJsonl, { deleteOrphans: true })
    ).rejects.toThrow(/Destructive orphan deletion is disabled/);
  });

  it('8. Tests actual HTTP wiring for /api/admin/storage/reconcile and /api/admin/storage/repair', async () => {
    const storage = new SqlitePlatformStorage(db);
    const mockPlatformApi = {
      authenticateCookie: async () => ({
        user: { id: testUserId, username: 'alice', role: 'admin', status: 'active' },
      }),
    };
    const handler = createPlatformServerHandler({
      database: db,
      storage,
      csrfToken,
      cookieSecret,
      runtimeGateway: {} as any,
      platformApi: mockPlatformApi as any,
    });

    server = http.createServer((req, res) => {
      handler(req, res).catch((err) => {
        res.statusCode = 500;
        res.end(err.message);
      });
    });

    await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
    const address = server.address() as any;
    baseUrl = `http://127.0.0.1:${address.port}`;

    const adminCookie = 'enkeep_session=mock_admin_cookie_session_value';

    // A. GET /api/admin/storage/reconcile across all sessions
    const getRes = await fetch(`${baseUrl}/api/admin/storage/reconcile`, {
      headers: {
        Cookie: adminCookie,
        Origin: baseUrl,
      },
    });
    expect(getRes.status).toBe(200);
    const bodyAll = await getRes.json();
    expect(bodyAll.data.totalSessions).toBe(3);
    expect(bodyAll.data.archivedCount).toBe(1);
    expect(bodyAll.data.activeCount).toBe(2);

    // B. GET /api/admin/storage/reconcile?filterStatus=active
    const getActiveRes = await fetch(`${baseUrl}/api/admin/storage/reconcile?filterStatus=active`, {
      headers: {
        Cookie: adminCookie,
        Origin: baseUrl,
      },
    });
    expect(getActiveRes.status).toBe(200);
    const bodyActive = await getActiveRes.json();
    expect(bodyActive.data.totalSessions).toBe(2);

    // C. POST /api/admin/storage/repair without valid source fails with 412 Precondition Failed
    const repairFailRes = await fetch(`${baseUrl}/api/admin/storage/repair`, {
      method: 'POST',
      headers: {
        'Cookie': adminCookie,
        'X-Enkeep-CSRF': csrfToken,
        'Origin': baseUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: testUserId,
        sessionId: 'sr_active_host',
        dryRun: false,
      }),
    });
    expect(repairFailRes.status).toBe(412);
    const failJson = await repairFailRes.json();
    expect(failJson.error.message).toContain('Repair refused');
  });

  it('9. Real server/runtime config HTTP GET wiring: resolves 2 synthetic tenant host roots without manual dshHome service injection, verifies tenant isolation and unknown root UNAVAILABLE', async () => {
    // Construct real multi-tenant dataRoot differing from default ~/.dsh
    const customDataRoot = path.join(tempDir, 'custom-real-dataroot');
    const tenantAUserId = 'usr_uuid_a_9999999999999999'; // Distinct user UUID
    const tenantAUsername = 'alice_host_user';               // Distinct username used by HostRuntimePortAdapter
    const tenantBUserId = 'usr_uuid_b_8888888888888888';
    const tenantBUsername = 'other_tenant';
    const spaceFolderA = 'space-tenant-a';
    const spaceFolderB = 'space-tenant-b';

    // Tenant A host runtime layout matches HostRuntimePortAdapter: <customDataRoot>/host-runtimes/<username>/.dsh
    // PROVES: Directory on disk uses username (alice_host_user), distinct from user UUID (usr_uuid_a_...)
    const tenantADshHome = path.join(customDataRoot, 'host-runtimes', tenantAUsername, '.dsh');
    const tenantASpacesDir = path.join(customDataRoot, 'host-runtimes', tenantAUsername, 'spaces');
    const tenantASpacePath = path.join(tenantASpacesDir, spaceFolderA);
    const pKeyA = computeDshProjectKey(tenantASpacePath);
    const encIdA = encodeSessionSegment('ses_tenant_a_dsh');
    const tenantASessionPath = path.join(tenantADshHome, 'sessions', pKeyA, encIdA, 'session.jsonl');

    // Write Tenant A session JSONL with 2 messages
    writeDshSessionLog(tenantASessionPath, 'ses_tenant_a_dsh', [
      { role: 'user', text: 'Prompt from Tenant A' },
      { role: 'assistant', text: 'Response from Tenant A' },
    ]);

    // Seed database for Tenant A and Tenant B
    db.exec(`
      INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
      VALUES 
        ('${tenantAUserId}', '${tenantAUsername}', 'hash', 'admin', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('${tenantBUserId}', '${tenantBUsername}', 'hash', 'admin', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

      -- Tenant A space & route (Host mode, keyed by tenantAUserId)
      INSERT INTO spaces (id, user_id, name, folder, execution_mode, status, created_at, updated_at)
      VALUES ('spc_a', '${tenantAUserId}', 'Space A', '${spaceFolderA}', 'host', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

      INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, status, current_generation, created_at, updated_at)
      VALUES ('sr_a', 'spc_a', '${tenantAUserId}', 'web', 'web-demo', 'ctx_a', 'peer_a', 'ses_tenant_a_dsh', 'container', 'active', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

      INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, created_at)
      VALUES 
        ('msg_ta_1', 'sr_a', '${tenantAUserId}', 'user', 'Prompt from Tenant A', 'delivered', 'sr_a', datetime('now', '-2 minutes')),
        ('msg_ta_2', 'sr_a', '${tenantAUserId}', 'assistant', 'Response from Tenant A', 'delivered', 'sr_a', datetime('now', '-1 minutes'));

      -- Tenant B space & route (Host mode, but host runtime root does NOT exist on disk -> empty/unknown root)
      INSERT INTO spaces (id, user_id, name, folder, execution_mode, status, created_at, updated_at)
      VALUES ('spc_b', '${tenantBUserId}', 'Space B', '${spaceFolderB}', 'host', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

      INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, status, current_generation, created_at, updated_at)
      VALUES ('sr_b', 'spc_b', '${tenantBUserId}', 'web', 'web-demo', 'ctx_b', 'peer_b', 'ses_tenant_b_dsh', 'container', 'active', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    `);

    // Real server construction wired with dshHome = customDataRoot (matching demo-runner production startup)
    // NO manual service injection or test-fake reader!
    const storage = new SqlitePlatformStorage(db);
    let authUser = { id: tenantAUserId, username: tenantAUsername, role: 'admin', status: 'active' };
    const mockPlatformApi = {
      authenticateCookie: async () => ({ user: authUser }),
    };

    const handler = createPlatformServerHandler({
      database: db,
      storage,
      dshHome: customDataRoot, // Passed through real server startup configuration
      csrfToken,
      cookieSecret,
      runtimeGateway: {} as any,
      platformApi: mockPlatformApi as any,
    });

    const realServer = http.createServer((req, res) => {
      handler(req, res).catch((err) => {
        res.statusCode = 500;
        res.end(err.message);
      });
    });

    await new Promise<void>((res) => realServer.listen(0, '127.0.0.1', () => res()));
    const realPort = (realServer.address() as any).port;
    const realUrl = `http://127.0.0.1:${realPort}`;

    try {
      // 1. Bare GET /api/admin/storage/reconcile for Tenant A (valid host runtime root resolved via username)
      authUser = { id: tenantAUserId, username: tenantAUsername, role: 'admin', status: 'active' };
      const resA = await fetch(`${realUrl}/api/admin/storage/reconcile`, {
        headers: { Cookie: 'enkeep_session=mock_cookie_a', Origin: realUrl },
      });
      expect(resA.status).toBe(200);
      const dataA = await resA.json();
      expect(dataA.data.totalSessions).toBe(1);
      expect(dataA.data.matchedCount).toBe(1);
      expect(dataA.data.reports[0].status).toBe('matched');
      expect(dataA.data.reports[0].platformMessageCount).toBe(2);
      expect(dataA.data.reports[0].dshMessageCount).toBe(2);
      expect(dataA.data.reports[0].executionMode).toBe('host');

      // 2. Bare GET /api/admin/storage/reconcile for Tenant B (empty/unknown root -> UNAVAILABLE, not false uninitialized)
      authUser = { id: tenantBUserId, username: tenantBUsername, role: 'admin', status: 'active' };
      const resB = await fetch(`${realUrl}/api/admin/storage/reconcile`, {
        headers: { Cookie: 'enkeep_session=mock_cookie_b', Origin: realUrl },
      });
      expect(resB.status).toBe(200);
      const dataB = await resB.json();
      expect(dataB.data.totalSessions).toBe(1);
      // Invariant: Empty/unknown root reports UNAVAILABLE (not false uninitialized), even though SQLite has 0 rows
      expect(dataB.data.unavailableCount).toBe(1);
      expect(dataB.data.reports[0].status).toBe('unavailable');
      expect(dataB.data.reports[0].dshReadStatus).toBe('UNAVAILABLE');
      expect(dataB.data.reports[0].details?.reason).toBe('dsh_runtime_unavailable');
    } finally {
      await new Promise<void>((res) => realServer.close(() => res()));
    }
  });
});
