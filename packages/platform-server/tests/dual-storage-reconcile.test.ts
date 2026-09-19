import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  DualStorageReconcileService,
  type ReconciliationStatus,
} from '../src/storage/dual-storage-reconcile.js';
import {
  parseDshSessionJsonl,
  readAndParseDshSessionFile,
  projectCanonicalWebMessages,
  type DshSessionEvent,
  type DshSessionHeader,
} from '../src/storage/session-event-parser.js';
import { PlatformServerMigrationRunner, ALL_PLATFORM_MIGRATIONS } from '../src/storage/migrations.js';

describe('Dual Storage Reconciliation & Typed DSH Parser (P0 Direct Tests)', () => {
  let tempDir: string;
  let db: DatabaseSync;
  let service: DualStorageReconcileService;

  const aliceId = 'usr_alice_001';
  const bobId = 'usr_bob_002';
  const spaceId = 'spc_alice_001';
  const routeId = 'sr_alice_session_01';
  const dshSessionId = 'ses_alice_dsh_01';

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-reconcile-test-'));
    db = new DatabaseSync(':memory:');

    // Run core schema migrations
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    // Seed test users, space, and route
    db.exec(`
      INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
      VALUES 
        ('${aliceId}', 'alice', 'hash', 'user', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('${bobId}', 'bob', 'hash', 'user', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

      INSERT INTO spaces (id, user_id, name, folder, status, created_at, updated_at)
      VALUES ('${spaceId}', '${aliceId}', 'Main Space', 'main-folder', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

      INSERT INTO session_routes (id, space_id, user_id, channel, dsh_session_id, status, created_at, updated_at)
      VALUES ('${routeId}', '${spaceId}', '${aliceId}', 'web', '${dshSessionId}', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    `);

    service = new DualStorageReconcileService({ db });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  /**
   * Helper to write a genuine DSH session JSONL log with all event types.
   */
  function createFullDshSessionLog(sessionId: string): { jsonlContent: string; expectedMessages: Array<{ role: string; content: string }> } {
    const header: DshSessionHeader = {
      type: 'session',
      version: 0,
      id: sessionId,
      createdAt: 1700000000000,
      delegationDepth: 0,
    };

    const events: DshSessionEvent[] = [
      // Turn 1: Standard User -> Assistant interaction with streaming chunks and tool calls
      { type: 'turn/start', seq: 0, time: 1700000001000, data: { turn: 1 } },
      {
        type: 'user/message',
        seq: 1,
        time: 1700000002000,
        surfaceOp: 'append',
        data: {
          id: 'msg_u1',
          role: 'user',
          content: [{ type: 'text', text: 'Please list files and summarize them.' }],
          source: { kind: 'user' },
        },
      },
      { type: 'step/start', seq: 2, time: 1700000003000, data: { turn: 1, step: 1 } },
      {
        type: 'assistant/chunk',
        seq: 3,
        time: 1700000003100,
        data: {
          turn: 1,
          step: 1,
          chunk: { type: 'reasoning-delta', index: 0, text: 'Thinking about listing directory...' },
        },
      },
      {
        type: 'assistant/chunk',
        seq: 4,
        time: 1700000003200,
        data: {
          turn: 1,
          step: 1,
          chunk: { type: 'tool-call-delta', index: 1, id: 'call_ls_1', name: 'ls', argumentsDelta: '{"dir":"."}' },
        },
      },
      {
        type: 'tool/call',
        seq: 5,
        time: 1700000003300,
        data: {
          turn: 1,
          step: 1,
          callId: 'call_ls_1',
          name: 'ls',
          arguments: '{"dir":"."}',
        },
      },
      // Assistant message with purely tool calls (no text) -> NOT projected to web_messages
      {
        type: 'assistant/message',
        seq: 6,
        time: 1700000003400,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'msg_call_1',
            role: 'assistant',
            content: [
              { type: 'reasoning', text: 'Thinking about listing directory...' },
              { type: 'tool-call', id: 'call_ls_1', name: 'ls', arguments: '{"dir":"."}' },
            ],
            source: { kind: 'model', provider: 'pi-ai', model: 'deepseek-chat' },
          },
        },
      },
      { type: 'step/end', seq: 7, time: 1700000003500, data: { turn: 1, step: 1 } },
      // Tool result -> NOT projected to web_messages
      {
        type: 'tool/result',
        seq: 8,
        time: 1700000004000,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'msg_res_1',
            role: 'user',
            content: [{ type: 'tool-result', toolCallId: 'call_ls_1', content: [{ type: 'text', text: '["package.json", "README.md"]' }] }],
            source: { kind: 'tool', callId: 'call_ls_1' },
          },
        },
      },
      // Step 2: Assistant final response with visible text
      { type: 'step/start', seq: 9, time: 1700000005000, data: { turn: 1, step: 2 } },
      {
        type: 'assistant/chunk',
        seq: 10,
        time: 1700000005100,
        data: {
          turn: 1,
          step: 2,
          chunk: { type: 'text-delta', index: 0, text: 'Found package.json and README.md.' },
        },
      },
      {
        type: 'assistant/message',
        seq: 11,
        time: 1700000005200,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 2,
          message: {
            id: 'msg_a1',
            role: 'assistant',
            content: [
              { type: 'reasoning', text: 'Done listing, synthesizing output...' },
              { type: 'text', text: 'Found package.json and README.md.' },
            ],
            source: { kind: 'model', provider: 'pi-ai', model: 'deepseek-chat' },
          },
          usage: { inputTokens: 120, outputTokens: 25 },
        },
      },
      { type: 'step/end', seq: 12, time: 1700000005300, data: { turn: 1, step: 2 } },
      { type: 'turn/end', seq: 13, time: 1700000005400, data: { turn: 1, reason: { kind: 'completed' } } },

      // Turn 2: Interrupted / cancelled turn with partial assistant text
      { type: 'turn/start', seq: 14, time: 1700000006000, data: { turn: 2 } },
      {
        type: 'user/message',
        seq: 15,
        time: 1700000006100,
        surfaceOp: 'append',
        data: {
          id: 'msg_u2',
          role: 'user',
          content: [{ type: 'text', text: 'Start a long-running search.' }],
          source: { kind: 'user' },
        },
      },
      { type: 'step/start', seq: 16, time: 1700000006200, data: { turn: 2, step: 1 } },
      {
        type: 'assistant/message',
        seq: 17,
        time: 1700000006300,
        surfaceOp: 'append',
        data: {
          turn: 2,
          step: 1,
          message: {
            id: 'msg_a2_interrupted',
            role: 'assistant',
            content: [{ type: 'text', text: 'Searching repository before interruption...' }],
            source: { kind: 'model', provider: 'pi-ai', model: 'deepseek-chat' },
          },
          interrupted: true,
        },
      },
      { type: 'step/end', seq: 18, time: 1700000006400, data: { turn: 2, step: 1 } },
      {
        type: 'turn/end',
        seq: 19,
        time: 1700000006500,
        data: {
          turn: 2,
          reason: { kind: 'aborted', reason: { kind: 'user' } },
        },
      },
    ];

    const lines = [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))];
    const jsonlContent = lines.join('\n') + '\n';

    const expectedMessages = [
      { role: 'user', content: 'Please list files and summarize them.' },
      { role: 'assistant', content: 'Found package.json and README.md.' },
      { role: 'user', content: 'Start a long-running search.' },
      { role: 'assistant', content: 'Searching repository before interruption...' },
    ];

    return { jsonlContent, expectedMessages };
  }

  describe('1. Typed SessionEvent Parser & Canonical Projection', () => {
    it('accurately parses genuine DSH session header and envelopes, strictly projecting visible final messages', () => {
      const { jsonlContent, expectedMessages } = createFullDshSessionLog(dshSessionId);
      const parsed = parseDshSessionJsonl(jsonlContent, { sessionId: routeId });

      expect(parsed.header.type).toBe('session');
      expect(parsed.header.id).toBe(dshSessionId);
      expect(parsed.header.version).toBe(0);
      expect(parsed.events.length).toBe(20);

      // Verify that intermediate chunks, tool/calls, tool/results, and empty assistant messages are excluded
      expect(parsed.projectedMessages.length).toBe(4);
      expect(parsed.projectedMessages.map((m) => ({ role: m.role, content: m.content }))).toEqual(expectedMessages);

      // Verify IDs and roles
      expect(parsed.projectedMessages[0].id).toBe('msg_u1');
      expect(parsed.projectedMessages[0].role).toBe('user');
      expect(parsed.projectedMessages[1].id).toBe('msg_a1');
      expect(parsed.projectedMessages[1].role).toBe('assistant');
      expect(parsed.projectedMessages[3].id).toBe('msg_a2_interrupted');
      expect(parsed.projectedMessages[3].role).toBe('assistant');
    });

    it('fails closed loudly on malformed JSON or broken sequence envelopes', () => {
      // Missing header
      expect(() =>
        parseDshSessionJsonl(JSON.stringify({ type: 'turn/start', seq: 0, time: 1000, data: {} }), { sessionId: routeId })
      ).toThrow(/First line of DSH JSONL must be a session header/);

      // Broken sequence numbering
      const brokenSeq =
        JSON.stringify({ type: 'session', version: 0, id: 's1', createdAt: 1000, delegationDepth: 0 }) +
        '\n' +
        JSON.stringify({ type: 'turn/start', seq: 0, time: 1001, data: { turn: 1 } }) +
        '\n' +
        JSON.stringify({ type: 'user/message', seq: 5, time: 1002, surfaceOp: 'append', data: { role: 'user', content: 'test' } });

      expect(() => parseDshSessionJsonl(brokenSeq, { sessionId: routeId })).toThrow(/Sequence break in session log: expected seq 1, found 5/);

      // Malformed JSON line
      const malformed =
        JSON.stringify({ type: 'session', version: 0, id: 's1', createdAt: 1000, delegationDepth: 0 }) +
        '\n' +
        'NOT_VALID_JSON';
      expect(() => parseDshSessionJsonl(malformed, { sessionId: routeId })).toThrow(/Malformed JSON on line 2/);
    });

    it('correctly parses seed transcript produced by importer and compaction lifecycle events', () => {
      const seedHeader: DshSessionHeader = {
        type: 'session',
        version: 0,
        id: 'import-00000000000000000000000000000001',
        createdAt: 1700000000000,
        delegationDepth: 0,
      };

      const seedEvents: DshSessionEvent[] = [
        { type: 'turn/start', seq: 0, time: 1700000001000, data: { turn: 1 } },
        {
          type: 'user/message',
          seq: 1,
          time: 1700000002000,
          surfaceOp: 'append',
          data: {
            id: 'msg_seed_1',
            role: 'user',
            content: [{ type: 'text', text: 'Historical imported question' }],
            source: { kind: 'user' },
          },
        },
        { type: 'step/start', seq: 2, time: 1700000003000, data: { turn: 1, step: 1 } },
        {
          type: 'assistant/message',
          seq: 3,
          time: 1700000004000,
          surfaceOp: 'append',
          data: {
            turn: 1,
            step: 1,
            message: {
              id: 'msg_seed_2',
              role: 'assistant',
              content: [{ type: 'text', text: 'Historical imported answer' }],
              source: { kind: 'model', provider: 'import', model: 'happyclaw' },
            },
          },
        },
        { type: 'step/end', seq: 4, time: 1700000005000, data: { turn: 1, step: 1 } },
        { type: 'turn/end', seq: 5, time: 1700000006000, data: { turn: 1, reason: { kind: 'completed' } } },
        { type: 'session/end-seed', seq: 6, time: 1700000006001, data: {} },
        // Compaction lifecycle events (prune / summary)
        { type: 'compaction/start', seq: 7, time: 1700000007000, data: { turn: 2 } },
        { type: 'compaction/summary', seq: 8, time: 1700000008000, data: { summary: 'Compact transcript' } },
        { type: 'compaction/end', seq: 9, time: 1700000009000, data: { turn: 2 } },
      ];

      const jsonl = [JSON.stringify(seedHeader), ...seedEvents.map((e) => JSON.stringify(e))].join('\n') + '\n';
      const parsed = parseDshSessionJsonl(jsonl, { sessionId: routeId });

      expect(parsed.projectedMessages.length).toBe(2);
      expect(parsed.projectedMessages[0].content).toBe('Historical imported question');
      expect(parsed.projectedMessages[1].content).toBe('Historical imported answer');
    });
  });

  describe('2. Dual Storage Reconciliation & Discrepancy Detection', () => {
    it('detects matched state when SQLite and DSH JSONL match exactly', async () => {
      const { jsonlContent, expectedMessages } = createFullDshSessionLog(dshSessionId);
      const jsonlPath = path.join(tempDir, 'session.jsonl');
      fs.writeFileSync(jsonlPath, jsonlContent);

      // Seed matching web_messages into SQLite
      for (let i = 0; i < expectedMessages.length; i++) {
        db.prepare(`
          INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, created_at)
          VALUES (?, ?, ?, ?, ?, 'delivered', ?, datetime('2023-11-14 22:13:20', '+' || ? || ' minutes'))
        `).run(
          `msg_${i}`,
          routeId,
          aliceId,
          expectedMessages[i].role,
          expectedMessages[i].content,
          routeId,
          i
        );
      }

      const report = await service.reconcileSession(aliceId, routeId, jsonlPath);
      expect(report.status).toBe('matched');
      expect(report.platformMessageCount).toBe(4);
      expect(report.dshMessageCount).toBe(4);
      expect(report.discrepancies).toBeUndefined();
    });

    it('detects missingInSqlite discrepancy when a row was deleted from SQLite, repairs it, and settles to matched', async () => {
      const { jsonlContent, expectedMessages } = createFullDshSessionLog(dshSessionId);
      const jsonlPath = path.join(tempDir, 'session.jsonl');
      fs.writeFileSync(jsonlPath, jsonlContent);

      // Seed only 3 out of 4 messages (delete 4th message)
      for (let i = 0; i < 3; i++) {
        db.prepare(`
          INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, created_at)
          VALUES (?, ?, ?, ?, ?, 'delivered', ?, datetime('2023-11-14 22:13:20', '+' || ? || ' minutes'))
        `).run(
          `msg_${i}`,
          routeId,
          aliceId,
          expectedMessages[i].role,
          expectedMessages[i].content,
          routeId,
          i
        );
      }

      // Step 1: Detect drift
      const driftReport = await service.reconcileSession(aliceId, routeId, jsonlPath);
      expect(driftReport.status).toBe('drift');
      expect(driftReport.platformMessageCount).toBe(3);
      expect(driftReport.dshMessageCount).toBe(4);
      expect(driftReport.discrepancies).toBeDefined();
      expect(driftReport.discrepancies?.length).toBe(1);
      expect(driftReport.discrepancies?.[0].type).toBe('missingInSqlite');
      expect(driftReport.discrepancies?.[0].position).toBe(3);

      // Step 2: Repair
      const repairResult = await service.repairSession(aliceId, routeId, jsonlPath);
      expect(repairResult.status).toBe('repaired');
      expect(repairResult.repairedCount).toBe(1);

      // Step 3: Re-reconcile -> matched
      const matchedReport = await service.reconcileSession(aliceId, routeId, jsonlPath);
      expect(matchedReport.status).toBe('matched');
      expect(matchedReport.platformMessageCount).toBe(4);
      expect(matchedReport.dshMessageCount).toBe(4);
    });

    it('detects contentMismatch when SQLite content is mutated, leaves existing row untouched during repair, and surfaces unresolved drift', async () => {
      const { jsonlContent, expectedMessages } = createFullDshSessionLog(dshSessionId);
      const jsonlPath = path.join(tempDir, 'session.jsonl');
      fs.writeFileSync(jsonlPath, jsonlContent);

      // Seed messages into SQLite with one tampered message
      for (let i = 0; i < expectedMessages.length; i++) {
        const content = i === 1 ? 'Tampered Assistant Content!' : expectedMessages[i].content;
        db.prepare(`
          INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, created_at)
          VALUES (?, ?, ?, ?, ?, 'delivered', ?, datetime('2023-11-14 22:13:20', '+' || ? || ' minutes'))
        `).run(
          `msg_${i}`,
          routeId,
          aliceId,
          expectedMessages[i].role,
          content,
          routeId,
          i
        );
      }

      // Detect content mismatch
      const report = await service.reconcileSession(aliceId, routeId, jsonlPath);
      expect(report.status).toBe('drift');
      expect(report.discrepancies).toBeDefined();
      expect(report.discrepancies?.[0].type).toBe('contentMismatch');
      expect(report.discrepancies?.[0].dshContent).toBe('Found package.json and README.md.');
      expect(report.discrepancies?.[0].sqliteContent).toBe('Tampered Assistant Content!');

      // Default repair is strictly additive: does NOT mutate existing rows
      const repairRes = await service.repairSession(aliceId, routeId, jsonlPath);
      expect(repairRes.status).toBe('unchanged');
      expect(repairRes.repairedCount).toBe(0);
      expect(repairRes.unresolvedCount).toBe(1);
      expect(repairRes.unresolvedDiscrepancies?.[0].type).toBe('contentMismatch');

      // Verify content in SQLite is strictly preserved (untouched)
      const preservedRow = db.prepare(`SELECT content, status FROM web_messages WHERE id = 'msg_1'`).get() as any;
      expect(preservedRow.content).toBe('Tampered Assistant Content!');
      expect(preservedRow.status).toBe('delivered');

      // Reconcile still surfaces drift (honest reporting, no fake matched)
      const afterReport = await service.reconcileSession(aliceId, routeId, jsonlPath);
      expect(afterReport.status).toBe('drift');
    });

    it('detects roleMismatch when SQLite role differs from DSH authority, leaves existing row untouched during repair, and surfaces unresolved drift', async () => {
      const { jsonlContent, expectedMessages } = createFullDshSessionLog(dshSessionId);
      const jsonlPath = path.join(tempDir, 'session.jsonl');
      fs.writeFileSync(jsonlPath, jsonlContent);

      // Seed messages into SQLite with one mismatched role ('user' instead of 'assistant')
      for (let i = 0; i < expectedMessages.length; i++) {
        const role = i === 1 ? 'user' : expectedMessages[i].role;
        db.prepare(`
          INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, created_at)
          VALUES (?, ?, ?, ?, ?, 'delivered', ?, datetime('2023-11-14 22:13:20', '+' || ? || ' minutes'))
        `).run(
          `msg_${i}`,
          routeId,
          aliceId,
          role,
          expectedMessages[i].content,
          routeId,
          i
        );
      }

      // Detect role mismatch
      const report = await service.reconcileSession(aliceId, routeId, jsonlPath);
      expect(report.status).toBe('drift');
      expect(report.discrepancies).toBeDefined();
      expect(report.discrepancies?.[0].type).toBe('roleMismatch');
      expect(report.discrepancies?.[0].dshRole).toBe('assistant');
      expect(report.discrepancies?.[0].sqliteRole).toBe('user');

      // Repair preserves existing row
      const repairRes = await service.repairSession(aliceId, routeId, jsonlPath);
      expect(repairRes.status).toBe('unchanged');
      expect(repairRes.repairedCount).toBe(0);
      expect(repairRes.unresolvedCount).toBe(1);

      // Verify role in SQLite is strictly preserved
      const preservedRow = db.prepare(`SELECT role FROM web_messages WHERE id = 'msg_1'`).get() as any;
      expect(preservedRow.role).toBe('user');

      // Reconcile still surfaces drift
      const afterReport = await service.reconcileSession(aliceId, routeId, jsonlPath);
      expect(afterReport.status).toBe('drift');
    });

    it('preserves orphan messages by default during repair, and hard refuses destructive deleteOrphans', async () => {
      const { jsonlContent, expectedMessages } = createFullDshSessionLog(dshSessionId);
      const jsonlPath = path.join(tempDir, 'session.jsonl');
      fs.writeFileSync(jsonlPath, jsonlContent);

      // Seed all 4 messages + 1 orphan message in SQLite
      for (let i = 0; i < expectedMessages.length; i++) {
        db.prepare(`
          INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, created_at)
          VALUES (?, ?, ?, ?, ?, 'delivered', ?, datetime('2023-11-14 22:13:20', '+' || ? || ' minutes'))
        `).run(
          `msg_${i}`,
          routeId,
          aliceId,
          expectedMessages[i].role,
          expectedMessages[i].content,
          routeId,
          i
        );
      }
      db.prepare(`
        INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, created_at)
        VALUES ('msg_orphan', ?, ?, 'user', 'Orphan message', 'delivered', ?, datetime('2023-11-14 22:30:00'))
      `).run(routeId, aliceId, routeId);

      // Detect orphan
      const drift = await service.reconcileSession(aliceId, routeId, jsonlPath);
      expect(drift.status).toBe('drift');
      expect(drift.platformMessageCount).toBe(5);
      expect(drift.dshMessageCount).toBe(4);
      expect(drift.discrepancies?.[0].type).toBe('orphanInSqlite');

      // Repair with default (deleteOrphans=false): preserves orphan and is additive only
      const repairDefault = await service.repairSession(aliceId, routeId, jsonlPath, { deleteOrphans: false });
      expect(repairDefault.deletedOrphansCount).toBeUndefined();
      const countPreserved = (db.prepare(`SELECT COUNT(*) as c FROM web_messages WHERE session_id = ?`).get(routeId) as any).c;
      expect(countPreserved).toBe(5);

      // Explicit deleteOrphans=true: hard refused to prevent destructive deletion
      await expect(
        service.repairSession(aliceId, routeId, jsonlPath, { deleteOrphans: true })
      ).rejects.toThrow(/Destructive orphan deletion is disabled/);

      // Ensure SQLite rows were untouched
      const countAfter = (db.prepare(`SELECT COUNT(*) as c FROM web_messages WHERE session_id = ?`).get(routeId) as any).c;
      expect(countAfter).toBe(5);
    });

    it('detects concurrent JSONL file growth during repair and aborts with 409 CONFLICT', async () => {
      const { jsonlContent } = createFullDshSessionLog(dshSessionId);
      const jsonlPath = path.join(tempDir, 'session.jsonl');
      fs.writeFileSync(jsonlPath, jsonlContent);

      // Stale expected hash triggers conflict
      await expect(
        service.repairSession(aliceId, routeId, jsonlPath, {
          expectedSnapshotHash: 'stale_hash_value',
        })
      ).rejects.toThrow(/File snapshot hash mismatch/);
    });

    it('strictly isolates tenant boundaries across reconcileAllSessions', async () => {
      const { jsonlContent } = createFullDshSessionLog(dshSessionId);
      const sessionsDir = path.join(tempDir, 'sessions');
      const aliceDir = path.join(sessionsDir, dshSessionId);
      fs.mkdirSync(aliceDir, { recursive: true });
      fs.writeFileSync(path.join(aliceDir, 'session.jsonl'), jsonlContent);

      // Reconcile Alice
      const aliceAll = await service.reconcileAllSessions(aliceId, sessionsDir);
      expect(aliceAll.totalSessions).toBe(1);
      expect(aliceAll.reports[0].sessionId).toBe(routeId);

      // Reconcile Bob (no sessions)
      const bobAll = await service.reconcileAllSessions(bobId, sessionsDir);
      expect(bobAll.totalSessions).toBe(0);
      expect(bobAll.reports.length).toBe(0);
    });

    it('genuine proven merged_archive does not count in active missing and rejects repair to prevent history duplication', async () => {
      // 1. Set canonical pointer on space
      db.prepare(`UPDATE spaces SET canonical_session_id = ? WHERE id = ?`).run(routeId, spaceId);

      // 2. Create an archived route in the same space with unique native_context_id
      const archivedRouteId = 'sr_alice_archived_01';
      const archivedDshId = 'ses_alice_archived_dsh_01';
      db.prepare(`
        INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, status, created_at, updated_at)
        VALUES (?, ?, ?, 'web', 'acc_old', 'ctx_old', 'web:old_peer', ?, 'archived', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(archivedRouteId, spaceId, aliceId, archivedDshId);

      // 3. Proven merge evidence: canonical session_sources contains retained source relation
      db.prepare(`
        INSERT INTO session_sources (id, route_id, source_type, source_id, user_id, metadata, created_at)
        VALUES ('src_001', ?, 'happyclaw', 'web:old_peer', ?, '{"migrated":true}', CURRENT_TIMESTAMP)
      `).run(routeId, aliceId);

      // 4. Reconcile single archived session
      const rep = await service.reconcileSession(aliceId, archivedRouteId);
      expect(rep.status).toBe('merged_archive');
      expect(rep.canonicalSessionId).toBe(routeId);
      expect(rep.details?.mergedArchive).toBe(true);
      expect(rep.details?.reason).toBe('superseded_by_canonical_merge');
      expect(rep.details?.retentionInfo).toBeDefined();

      // 5. Reconcile all sessions: merged archive is NOT counted in active missing
      const allRep = await service.reconcileAllSessions(aliceId);
      expect(allRep.totalSessions).toBe(2);
      expect(allRep.activeCount).toBe(1);
      expect(allRep.archivedCount).toBe(1);
      expect(allRep.mergedArchiveCount).toBe(1);
      expect(allRep.missingCount).toBe(0); // NOT counted in active missing!

      // 6. Direct repair on merged archive is strictly refused
      await expect(
        service.repairSession(aliceId, archivedRouteId)
      ).rejects.toThrow(/Repair refused: Session .* is an archived session that has been merged into canonical session/);
    });

    it('ordinary unmerged archived session retains genuine diagnostic without false merged_archive proof', async () => {
      // Archived route in the same space with same import source / workspace, but unmerged
      const unmergedRouteId = 'sr_unmerged_01';
      db.prepare(`
        INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, status)
        VALUES (?, ?, ?, 'web', 'acc_unmerged', 'ctx_unmerged', 'web:old_peer', 'dsh_unmerged', 'archived')
      `).run(unmergedRouteId, spaceId, aliceId);

      // Has its own original import session_sources on this unmerged route
      db.prepare(`
        INSERT INTO session_sources (id, route_id, source_type, source_id, user_id, metadata, created_at)
        VALUES ('src_unmerged_01', ?, 'happyclaw', 'web:old_peer', ?, '{"migrated":true}', CURRENT_TIMESTAMP)
      `).run(unmergedRouteId, aliceId);

      // Reconcile: since messages = 0 and dsh = MISSING, retains uninitialized placeholder diagnostic without false merged_archive
      const rep = await service.reconcileSession(aliceId, unmergedRouteId);
      expect(rep.status).toBe('uninitialized');
      expect(rep.status).not.toBe('merged_archive');
      expect(rep.details?.mergedArchive).toBeUndefined();
    });

    it('rejects cross-tenant or cross-space false canonical pointer from claiming merged_archive', async () => {
      // Archived route in Alice space, but canonical_session_id points to Bob's route (cross-tenant)
      const fakeSpaceId = 'spc_fake_01';
      const fakeArchivedRoute = 'sr_fake_arch_01';
      const bobRouteId = 'sr_bob_session_01';

      // Seed Bob space and route
      const bobSpaceId = 'spc_bob_01';
      db.prepare(`
        INSERT INTO spaces (id, user_id, name, folder, status)
        VALUES (?, ?, 'Bob Space', 'bob-folder', 'active')
      `).run(bobSpaceId, bobId);
      db.prepare(`
        INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id, dsh_session_id, status)
        VALUES (?, ?, ?, 'web', 'acc_bob', 'ctx_bob', 'dsh_bob_01', 'active')
      `).run(bobRouteId, bobSpaceId, bobId);
      db.prepare(`UPDATE spaces SET canonical_session_id = ? WHERE id = ?`).run(bobRouteId, bobSpaceId);

      // Alice space maliciously points to Bob's route
      db.prepare(`
        INSERT INTO spaces (id, user_id, name, folder, status, canonical_session_id)
        VALUES (?, ?, 'Alice Fake Space', 'alice-fake', 'active', ?)
      `).run(fakeSpaceId, aliceId, bobRouteId);

      db.prepare(`
        INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id, dsh_session_id, status)
        VALUES (?, ?, ?, 'web', 'acc_fake', 'ctx_fake', 'dsh_fake_arch', 'archived')
      `).run(fakeArchivedRoute, fakeSpaceId, aliceId);

      const rep = await service.reconcileSession(aliceId, fakeArchivedRoute);
      expect(rep.status).not.toBe('merged_archive');
      expect(rep.details?.mergedArchive).toBeUndefined();
    });

    it('active genuine missing session remains counted in active missingCount', async () => {
      // Active route with messages in SQLite but missing runtime JSONL file
      const activeMissingRoute = 'sr_active_missing_01';
      db.prepare(`
        INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id, dsh_session_id, status)
        VALUES (?, ?, ?, 'web', 'acc_missing', 'ctx_missing', 'dsh_active_missing', 'active')
      `).run(activeMissingRoute, spaceId, aliceId);

      db.prepare(`
        INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, created_at)
        VALUES ('msg_missing_01', ?, ?, 'user', 'Hello missing', 'delivered', ?, CURRENT_TIMESTAMP)
      `).run(activeMissingRoute, aliceId, activeMissingRoute);

      const rep = await service.reconcileSession(aliceId, activeMissingRoute);
      expect(rep.status).toBe('missing');
      expect(rep.details?.reason).toBe('dsh_jsonl_missing');

      const allRep = await service.reconcileAllSessions(aliceId);
      expect(allRep.missingCount).toBeGreaterThanOrEqual(1);
    });

    it('verifies i18n CHEN labels and API scope keys for merged archive features', () => {
      // Read static i18n file to assert contract
      const i18nPath = path.resolve(__dirname, '../../web-ui/src/static/i18n.js');
      const content = fs.readFileSync(i18nPath, 'utf8');

      // Assert English keys
      expect(content).toContain('"reconcile.kpiArchived": "Archived Sessions"');
      expect(content).toContain('"reconcile.statusMergedArchive": "Merged Archive"');
      expect(content).toContain('"reconcile.discMergedArchive": "Merged into Canonical"');
      expect(content).toContain('"reconcile.btnGoToCanonical": "Go to Canonical"');

      // Assert Chinese keys
      expect(content).toContain('"reconcile.kpiArchived": "已归档会话"');
      expect(content).toContain('"reconcile.statusMergedArchive": "已合并归档"');
      expect(content).toContain('"reconcile.discMergedArchive": "已合并至主会话"');
      expect(content).toContain('"reconcile.btnGoToCanonical": "跳转主会话"');
    });

    it('negative fixture: SAME tenant/space canonical + fabricated title + generic import markers => NOT merged_archive; positive moved messages => still merged', async () => {
      // Setup canonical pointer on space
      db.prepare(`UPDATE spaces SET canonical_session_id = ? WHERE id = ?`).run(routeId, spaceId);

      // Create an archived session with SAME tenant and SAME space, with fabricated title and generic import markers
      const fakeArchivedRoute = 'sr_alice_arch_fabricated_title';
      const fakeDshId = 'ses_alice_arch_dsh_fake';
      db.prepare(`
        INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id, dsh_session_id, status, title, created_at, updated_at)
        VALUES (?, ?, ?, 'web', 'acc_fake', 'ctx_fake', ?, 'archived', '[Merged into Canonical Session]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(fakeArchivedRoute, spaceId, aliceId, fakeDshId);

      // Generic import markers in session_sources (NOT specific to canonical route relation)
      db.prepare(`
        INSERT INTO session_sources (id, route_id, source_type, source_id, user_id, metadata, created_at)
        VALUES ('src_generic_01', ?, 'import', 'generic_import_marker', ?, '{"imported":true,"generic":true}', CURRENT_TIMESTAMP)
      `).run(fakeArchivedRoute, aliceId);

      // 1. Negative fixture: without provable moved messages or duplicate provenance, title alone MUST NOT trigger merged_archive
      const repNeg = await service.reconcileSession(aliceId, fakeArchivedRoute);
      expect(repNeg.status).not.toBe('merged_archive');
      expect(repNeg.details?.mergedArchive).toBeUndefined();
      expect(repNeg.status).toBe('uninitialized'); // Ordinary archive diagnostic (0 msgs, missing dsh)

      // 2. Positive fixture: add actual moved message evidence on canonical session pointing to this route
      db.prepare(`
        INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, created_at)
        VALUES ('msg_moved_01', ?, ?, 'user', '#include <iostream>\nint main() { return 0; }', 'delivered', ?, CURRENT_TIMESTAMP)
      `).run(routeId, aliceId, `happyclaw:${fakeArchivedRoute}`);

      const repPos = await service.reconcileSession(aliceId, fakeArchivedRoute);
      expect(repPos.status).toBe('merged_archive');
      expect(repPos.canonicalSessionId).toBe(routeId);
      expect(repPos.details?.mergedArchive).toBe(true);
      expect(repPos.details?.mergeEvidence).toContain('web_messages');

      // 3. Preserve actual cxx content diff / no business normalization
      const cxxJsonl = [
        JSON.stringify({ type: 'session', version: 0, id: fakeDshId, createdAt: 1700000000000, delegationDepth: 0 }),
        JSON.stringify({ type: 'turn/start', seq: 0, time: 1700000001000, data: { turn: 1 } }),
        JSON.stringify({
          type: 'user/message',
          seq: 1,
          time: 1700000002000,
          surfaceOp: 'append',
          data: {
            id: 'msg_u1',
            role: 'user',
            content: [{ type: 'text', text: '#include <cstdio>\nint main() { printf("diff"); return 0; }' }],
            source: { kind: 'user' },
          },
        }),
      ].join('\n') + '\n';
      const fakeJsonlPath = path.join(tempDir, 'fake_archived.jsonl');
      fs.writeFileSync(fakeJsonlPath, cxxJsonl);

      // Reconcile with actual cxx content diff
      const repDiff = await service.reconcileSession(aliceId, fakeArchivedRoute, fakeJsonlPath);
      expect(repDiff.status).toBe('merged_archive');
      expect(repDiff.details?.expectedProjectionDifference).toBe(true);
      expect(repDiff.discrepancies).toBeDefined();
      expect(repDiff.discrepancies?.some((d) => d.type === 'orphanInSqlite' || d.type === 'contentMismatch' || d.type === 'missingInSqlite')).toBe(true);
    });

    it('strictly isolates volumes across tenants with overlapping session IDs and space folders (no foreign read; invalid/missing mapping fails closed)', async () => {
      // Alice and Bob share identical dshSessionId and identical spaceFolder name
      const overlappingDshSessionId = 'ses_shared_overlap_123';
      const overlappingSpaceFolder = 'common-space-folder';

      // 1. Create a space for Alice with space_folder = overlappingSpaceFolder
      const aliceSpace2 = 'spc_alice_overlap';
      const aliceRoute2 = 'sr_alice_overlap_route';
      db.prepare(`
        INSERT INTO spaces (id, user_id, name, folder, execution_mode, status, created_at, updated_at)
        VALUES (?, ?, 'Alice Overlap Space', ?, 'container', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(aliceSpace2, aliceId, overlappingSpaceFolder);

      db.prepare(`
        INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id, dsh_session_id, status, created_at, updated_at)
        VALUES (?, ?, ?, 'web', 'acc_alice_overlap', 'ctx_alice_overlap', ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(aliceRoute2, aliceSpace2, aliceId, overlappingDshSessionId);

      // 2. Create a space for Bob with the exact same space_folder
      const bobSpace2 = 'spc_bob_overlap';
      const bobRoute2 = 'sr_bob_overlap_route';
      db.prepare(`
        INSERT INTO spaces (id, user_id, name, folder, execution_mode, status, created_at, updated_at)
        VALUES (?, ?, 'Bob Overlap Space', ?, 'container', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(bobSpace2, bobId, overlappingSpaceFolder);

      db.prepare(`
        INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id, dsh_session_id, status, created_at, updated_at)
        VALUES (?, ?, ?, 'web', 'acc_bob_overlap', 'ctx_bob_overlap', ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(bobRoute2, bobSpace2, bobId, overlappingDshSessionId);

      // 3. Setup mock filesystem under tempDir mimicking dshHome:
      // Create Bob's volume containing Bob's private session log
      const volumesDir = path.join(tempDir, 'volumes');
      const containersDir = path.join(tempDir, 'containers');
      fs.mkdirSync(volumesDir, { recursive: true });
      fs.mkdirSync(containersDir, { recursive: true });

      const bobVolName = 'enkeep-demo-dsh-bob';
      const bobVolDir = path.join(volumesDir, bobVolName, 'sessions', overlappingDshSessionId);
      fs.mkdirSync(bobVolDir, { recursive: true });
      const { jsonlContent: bobLogContent } = createFullDshSessionLog(overlappingDshSessionId);
      fs.writeFileSync(path.join(bobVolDir, 'session.jsonl'), bobLogContent);

      // Write Bob's valid volume metadata
      fs.writeFileSync(
        path.join(volumesDir, `${bobVolName}.json`),
        JSON.stringify({
          schemaVersion: 1,
          userId: bobId,
          volumeName: bobVolName,
          labels: { 'enkeep.user': bobId },
        })
      );

      // Service instance configured with dshHome pointing to tempDir
      const isolatedService = new DualStorageReconcileService({ db, dshHome: tempDir });

      // 4. Test A: Alice has NO volume mapping -> MUST FAIL CLOSED with UNAVAILABLE
      // Alice MUST NOT read Bob's volume session.jsonl despite overlapping dshSessionId and space folder!
      const aliceRepMissingMapping = await isolatedService.reconcileSession(aliceId, aliceRoute2);
      expect(aliceRepMissingMapping.status).toBe('unavailable');
      expect(aliceRepMissingMapping.dshReadStatus).toBe('UNAVAILABLE');
      expect(aliceRepMissingMapping.dshMessageCount).toBe(0);

      // 5. Test B: Alice has INVALID / spoofed volume mapping pointing to Bob's volume -> FAIL CLOSED
      fs.writeFileSync(
        path.join(containersDir, 'enkeep-demo-alice.json'),
        JSON.stringify({
          userId: aliceId,
          volumeName: bobVolName, // Maliciously points to Bob's volume
          labels: { 'enkeep.user': aliceId },
        })
      );

      const aliceRepSpoofed = await isolatedService.reconcileSession(aliceId, aliceRoute2);
      expect(aliceRepSpoofed.status).toBe('unavailable');
      expect(aliceRepSpoofed.dshReadStatus).toBe('UNAVAILABLE');
      expect(aliceRepSpoofed.dshMessageCount).toBe(0);

      // 6. Test C: Bob reconciles his own session -> Succeeds because mapping is authentic and matching
      // Seed matching sqlite message for Bob so it matches
      db.prepare(`
        INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, created_at)
        VALUES ('msg_bob_01', ?, ?, 'user', 'Please list files and summarize them.', 'delivered', ?, CURRENT_TIMESTAMP)
      `).run(bobRoute2, bobId, bobRoute2);

      const bobRep = await isolatedService.reconcileSession(bobId, bobRoute2);
      expect(bobRep.dshReadStatus).toBe('FOUND');
      expect(bobRep.dshMessageCount).toBeGreaterThan(0);
    });
  });
});
