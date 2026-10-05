import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  parseDshSessionJsonl,
  readAndParseDshSessionFile,
  normalizeSessionEventsToV4,
  type DshSessionHeader,
} from '../src/storage/session-event-parser.js';
import { DualStorageReconcileService } from '../src/storage/dual-storage-reconcile.js';
import { PlatformServerMigrationRunner, ALL_PLATFORM_MIGRATIONS } from '../src/storage/migrations.js';

describe('WP-platform: V4 and Legacy V0 Session Log Compatibility', () => {
  let tempDir: string;
  let db: DatabaseSync;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-wp-platform-test-'));
    db = new DatabaseSync(':memory:');

    // Run core schema migrations
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('1. Session Event Parser: V4 and V0 Dual Parsing', () => {
    it('parses genuine V4 session header and events including system/message, role: tool, and stream', () => {
      const v4Header = {
        type: 'session',
        version: 4,
        id: 'ses_synth_v4_00000001',
        createdAt: 1700000000000,
        cwd: '/home/dsh/spaces/default',
        delegationDepth: 0,
        isSeeded: false,
      };

      const events = [
        {
          type: 'turn/start',
          seq: 0,
          time: 1700000001000,
          data: { turn: 1 },
        },
        {
          type: 'step/start',
          seq: 1,
          time: 1700000001100,
          data: { turn: 1, step: 1 },
        },
        {
          type: 'system/message',
          seq: 2,
          time: 1700000001200,
          surfaceOp: 'append',
          data: {
            turn: 1,
            step: 1,
            message: {
              id: 'sys_001',
              role: 'system',
              content: [{ type: 'text', text: 'You are a test assistant' }],
              source: { kind: 'system-prompt' },
            },
          },
        },
        {
          type: 'user/message',
          seq: 3,
          time: 1700000002000,
          surfaceOp: 'append',
          data: {
            id: 'msg_user_001',
            role: 'user',
            content: [{ type: 'text', text: 'List files please' }],
            source: { kind: 'user' },
          },
        },
        {
          type: 'tool/call',
          seq: 4,
          time: 1700000002500,
          data: {
            turn: 1,
            step: 1,
            callId: 'call_synth_01',
            name: 'bash',
            arguments: '{"command":"ls"}',
          },
        },
        {
          type: 'step/end',
          seq: 5,
          time: 1700000002600,
          data: { turn: 1, step: 1 },
        },
        {
          type: 'step/start',
          seq: 6,
          time: 1700000003000,
          data: { turn: 1, step: 2 },
        },
        {
          type: 'tool/result',
          seq: 7,
          time: 1700000003100,
          surfaceOp: 'append',
          data: {
            turn: 1,
            step: 2,
            message: {
              id: 'res_synth_01',
              role: 'tool',
              content: [{ type: 'tool-result', toolCallId: 'call_synth_01', content: [{ type: 'text', text: 'report.txt' }] }],
              source: { kind: 'tool', callId: 'call_synth_01' },
            },
          },
        },
        {
          type: 'assistant/message',
          seq: 8,
          time: 1700000004000,
          surfaceOp: 'append',
          data: {
            turn: 1,
            step: 2,
            stream: [],
            message: {
              id: 'msg_asst_001',
              role: 'assistant',
              content: [{ type: 'text', text: 'Here is the file list: report.txt' }],
              source: { kind: 'model', provider: 'synth', model: 'test-model' },
            },
          },
        },
        {
          type: 'step/end',
          seq: 9,
          time: 1700000004100,
          data: { turn: 1, step: 2 },
        },
        {
          type: 'turn/end',
          seq: 10,
          time: 1700000004200,
          data: { turn: 1, reason: { kind: 'completed' } },
        },
      ];

      const jsonl = [JSON.stringify(v4Header), ...events.map((e) => JSON.stringify(e))].join('\n') + '\n';
      const parsed = parseDshSessionJsonl(jsonl, { sessionId: v4Header.id });

      expect(parsed.header.version).toBe(4);
      expect(parsed.header.isSeeded).toBe(false);
      expect(parsed.events.length).toBe(11);

      // Verify canonical web_messages projection strictly includes user and assistant, excluding system and tool
      expect(parsed.projectedMessages.length).toBe(2);
      expect(parsed.projectedMessages[0].id).toBe('msg_user_001');
      expect(parsed.projectedMessages[0].role).toBe('user');
      expect(parsed.projectedMessages[0].content).toBe('List files please');

      expect(parsed.projectedMessages[1].id).toBe('msg_asst_001');
      expect(parsed.projectedMessages[1].role).toBe('assistant');
      expect(parsed.projectedMessages[1].content).toBe('Here is the file list: report.txt');
    });

    it('parses legacy V0 session header and events accurately', () => {
      const v0Header = {
        type: 'session',
        version: 0,
        id: 'ses_synth_v0_00000001',
        createdAt: 1700000000000,
        cwd: '/home/dsh/spaces/default',
        delegationDepth: 0,
        seedLength: 2,
      };

      const events = [
        {
          type: 'user/message',
          seq: 0,
          time: 1700000001000,
          surfaceOp: 'append',
          data: {
            id: 'msg_v0_user',
            role: 'user',
            content: 'Hello legacy DSH',
            source: { kind: 'user' },
          },
        },
        {
          type: 'session/end-seed',
          seq: 1,
          time: 1700000002000,
          data: {},
        },
      ];

      const jsonl = [JSON.stringify(v0Header), ...events.map((e) => JSON.stringify(e))].join('\n') + '\n';
      const parsed = parseDshSessionJsonl(jsonl, { sessionId: v0Header.id });

      expect(parsed.header.version).toBe(0);
      expect(parsed.header.seedLength).toBe(2);
      expect(parsed.projectedMessages.length).toBe(1);
      expect(parsed.projectedMessages[0].content).toBe('Hello legacy DSH');
    });

    it('normalizes legacy V0 session events to V4 via normalizeSessionEventsToV4', () => {
      const header: DshSessionHeader = {
        type: 'session',
        version: 0,
        id: 'ses_norm_001',
        createdAt: 1700000000000,
        delegationDepth: 0,
      };

      const events = [
        {
          type: 'turn/start',
          seq: 0,
          time: 1700000001000,
          data: { turn: 1 },
        },
        {
          type: 'step/start',
          seq: 1,
          time: 1700000001100,
          data: { turn: 1, step: 1 },
        },
        {
          type: 'user/message',
          seq: 2,
          time: 1700000001200,
          surfaceOp: 'append',
          data: {
            id: 'msg_norm_1',
            role: 'user',
            content: [{ type: 'text', text: 'Hi' }],
            source: { kind: 'user' },
          },
        },
        {
          type: 'step/end',
          seq: 3,
          time: 1700000001300,
          data: { turn: 1, step: 1 },
        },
        {
          type: 'turn/end',
          seq: 4,
          time: 1700000001400,
          data: { turn: 1, reason: { kind: 'completed' } },
        },
      ];

      const normalized = normalizeSessionEventsToV4(header, events as any);
      expect(normalized.header.version).toBe(4);
      expect(normalized.events.length).toBeGreaterThanOrEqual(events.length);
    });
  });

  describe('2. Dual Storage Reconciliation: Preferential V4 File Discovery', () => {
    it('discovers and reconciles session.v4.jsonl preferentially over session.jsonl when both exist', async () => {
      const userId = 'user-alice';
      const spaceId = 'spc_synth_00000000000000000000000000000001';
      const routeId = 'ses_synth_route_0000000000000001';
      const dshSessionId = 'ses_synth_dsh_00000000000000001';

      // Seed database
      db.prepare(`
        INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
        VALUES (?, 'alice', 'hash', 'user', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(userId);

      db.prepare(`
        INSERT INTO spaces (id, user_id, name, folder, status, created_at, updated_at)
        VALUES (?, ?, 'Alice Space', 'default', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(spaceId, userId);

      db.prepare(`
        INSERT INTO session_routes (id, space_id, user_id, channel, dsh_session_id, status, created_at, updated_at)
        VALUES (?, ?, ?, 'web', ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(routeId, spaceId, userId, dshSessionId);

      // Create session directory on disk with BOTH session.v4.jsonl and legacy session.jsonl
      const dshHome = path.join(tempDir, 'dsh');
      const sessionsDir = path.join(dshHome, 'sessions');
      const sessionDir = path.join(sessionsDir, dshSessionId);
      fs.mkdirSync(sessionDir, { recursive: true });

      // session.v4.jsonl: updated message
      const v4Header = { type: 'session', version: 4, id: dshSessionId, createdAt: 1000, delegationDepth: 0, isSeeded: false };
      const v4Events = [
        { type: 'user/message', seq: 0, time: 1000, surfaceOp: 'append', data: { id: 'm_v4', role: 'user', content: 'Message from V4 file', source: { kind: 'user' } } },
      ];
      fs.writeFileSync(
        path.join(sessionDir, 'session.v4.jsonl'),
        [JSON.stringify(v4Header), ...v4Events.map((e) => JSON.stringify(e))].join('\n') + '\n',
        'utf8'
      );

      // session.jsonl: older message
      const v0Header = { type: 'session', version: 0, id: dshSessionId, createdAt: 1000, delegationDepth: 0 };
      const v0Events = [
        { type: 'user/message', seq: 0, time: 1000, surfaceOp: 'append', data: { id: 'm_v0', role: 'user', content: 'Message from legacy V0 file', source: { kind: 'user' } } },
      ];
      fs.writeFileSync(
        path.join(sessionDir, 'session.jsonl'),
        [JSON.stringify(v0Header), ...v0Events.map((e) => JSON.stringify(e))].join('\n') + '\n',
        'utf8'
      );

      // Insert matching SQLite row for V4 content
      db.prepare(`
        INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, created_at)
        VALUES ('m_v4', ?, ?, 'user', 'Message from V4 file', 'delivered', 'web:default:user-alice', '2026-08-01T12:00:00.000Z')
      `).run(routeId, userId);

      const reconciler = new DualStorageReconcileService({
        db,
        dshHome,
      });

      const report = await reconciler.reconcileSession(userId, routeId);

      expect(report.status).toBe('matched');
      expect(report.details?.resolvedPath).toBe('session.v4.jsonl');
      expect(report.dshMessageCount).toBe(1);
    });

    it('falls back seamlessly to legacy session.jsonl when session.v4.jsonl does not exist', async () => {
      const userId = 'user-alice';
      const spaceId = 'spc_synth_00000000000000000000000000000002';
      const routeId = 'ses_synth_route_0000000000000002';
      const dshSessionId = 'ses_synth_dsh_00000000000000002';

      db.prepare(`
        INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
        VALUES (?, 'alice', 'hash', 'user', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(userId);

      db.prepare(`
        INSERT INTO spaces (id, user_id, name, folder, status, created_at, updated_at)
        VALUES (?, ?, 'Alice Space 2', 'default', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(spaceId, userId);

      db.prepare(`
        INSERT INTO session_routes (id, space_id, user_id, channel, dsh_session_id, status, created_at, updated_at)
        VALUES (?, ?, ?, 'web', ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(routeId, spaceId, userId, dshSessionId);

      const dshHome = path.join(tempDir, 'dsh');
      const sessionsDir = path.join(dshHome, 'sessions');
      const sessionDir = path.join(sessionsDir, dshSessionId);
      fs.mkdirSync(sessionDir, { recursive: true });

      // ONLY legacy session.jsonl exists
      const v0Header = { type: 'session', version: 0, id: dshSessionId, createdAt: 1000, delegationDepth: 0 };
      const v0Events = [
        { type: 'user/message', seq: 0, time: 1000, surfaceOp: 'append', data: { id: 'm_legacy', role: 'user', content: 'Message from legacy V0 file', source: { kind: 'user' } } },
      ];
      fs.writeFileSync(
        path.join(sessionDir, 'session.jsonl'),
        [JSON.stringify(v0Header), ...v0Events.map((e) => JSON.stringify(e))].join('\n') + '\n',
        'utf8'
      );

      db.prepare(`
        INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, created_at)
        VALUES ('m_legacy', ?, ?, 'user', 'Message from legacy V0 file', 'delivered', 'web:default:user-alice', '2026-08-01T12:00:00.000Z')
      `).run(routeId, userId);

      const reconciler = new DualStorageReconcileService({
        db,
        dshHome,
      });

      const report = await reconciler.reconcileSession(userId, routeId);

      expect(report.status).toBe('matched');
      expect(report.details?.resolvedPath).toBe('session.jsonl');
      expect(report.dshMessageCount).toBe(1);
    });
  });
});
