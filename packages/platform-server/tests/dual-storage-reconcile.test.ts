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

    it('detects contentMismatch when SQLite content is mutated, and repairs it', async () => {
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

      // Repair
      const repairRes = await service.repairSession(aliceId, routeId, jsonlPath);
      expect(repairRes.status).toBe('repaired');
      expect(repairRes.updatedCount).toBe(1);

      // Verify updated content in SQLite
      const updatedRow = db.prepare(`SELECT content FROM web_messages WHERE id = 'msg_1'`).get() as any;
      expect(updatedRow.content).toBe('Found package.json and README.md.');

      // Reconcile is now matched
      const afterReport = await service.reconcileSession(aliceId, routeId, jsonlPath);
      expect(afterReport.status).toBe('matched');
    });

    it('detects roleMismatch when SQLite role differs from DSH authority, and repairs it', async () => {
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

      // Repair
      const repairRes = await service.repairSession(aliceId, routeId, jsonlPath);
      expect(repairRes.status).toBe('repaired');
      expect(repairRes.updatedCount).toBe(1);

      // Reconcile is now matched
      const afterReport = await service.reconcileSession(aliceId, routeId, jsonlPath);
      expect(afterReport.status).toBe('matched');
    });

    it('preserves orphan messages by default during repair, and deletes them only when deleteOrphans=true', async () => {
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

      // Repair with default (deleteOrphans=false): preserves orphan
      const repairDefault = await service.repairSession(aliceId, routeId, jsonlPath, { deleteOrphans: false });
      expect(repairDefault.deletedOrphansCount).toBeUndefined();
      const countPreserved = (db.prepare(`SELECT COUNT(*) as c FROM web_messages WHERE session_id = ?`).get(routeId) as any).c;
      expect(countPreserved).toBe(5);

      // Explicit deleteOrphans=true: removes orphan
      const repairDelete = await service.repairSession(aliceId, routeId, jsonlPath, { deleteOrphans: true });
      expect(repairDelete.deletedOrphansCount).toBe(1);
      const countAfter = (db.prepare(`SELECT COUNT(*) as c FROM web_messages WHERE session_id = ?`).get(routeId) as any).c;
      expect(countAfter).toBe(4);

      // Reconcile is now matched
      const finalReport = await service.reconcileSession(aliceId, routeId, jsonlPath);
      expect(finalReport.status).toBe('matched');
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
  });
});
