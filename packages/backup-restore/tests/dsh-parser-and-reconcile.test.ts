import { describe, it, expect } from 'vitest';
import {
  validateRestoredTarget,
  parseTranscriptWithCanonicalParser,
} from '../src/index.js';
import {
  extractVisibleTextFromContentBlocks,
  parseDshSessionJsonl,
  projectCanonicalWebMessages,
} from '@enkeep/platform-server';
import { BackupIntegrityError } from '../src/errors.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Authoritative DSH Parser & Dual-Storage Strict Projection Reconcile', () => {
  it('extracts visible text from strings, arrays, and structured chunks via authoritative parser', () => {
    expect(extractVisibleTextFromContentBlocks('simple string')).toBe('simple string');
    expect(
      extractVisibleTextFromContentBlocks([
        { type: 'text', text: 'chunk 1' },
        { type: 'text', text: 'chunk 2' },
      ])
    ).toBe('chunk 1chunk 2');
    expect(extractVisibleTextFromContentBlocks([{ type: 'reasoning', text: 'skip me' }, { type: 'text', text: 'visible text' }])).toBe('visible text');
  });

  it('strictly parses DSH transcript with official session header and turn events', () => {
    const jsonl = [
      JSON.stringify({ type: 'session', version: 0, id: 'sess_1', createdAt: 100, delegationDepth: 0 }),
      JSON.stringify({ type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } }),
      JSON.stringify({
        type: 'user/message',
        seq: 1,
        time: 101,
        data: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'What is Enkeep?' }] },
      }),
      JSON.stringify({
        type: 'assistant/message',
        seq: 2,
        time: 103,
        data: {
          turn: 1,
          step: 1,
          message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Enkeep is an enterprise DSH platform.' }] },
        },
      }),
      JSON.stringify({ type: 'turn/end', seq: 3, time: 104, data: {} }),
    ].join('\n');

    const result = parseTranscriptWithCanonicalParser(jsonl, 'sess_1', 'test.jsonl');
    expect(result.totalLines).toBe(5);
    expect(result.messages.length).toBe(2);
    expect(result.messages[0]!.role).toBe('user');
    expect(result.messages[0]!.content).toBe('What is Enkeep?');
    expect(result.messages[1]!.role).toBe('assistant');
    expect(result.messages[1]!.content).toBe('Enkeep is an enterprise DSH platform.');
  });

  it('rejects invalid JSON syntax in DSH JSONL with strict error', () => {
    const invalidJsonl = '{"type":"session","version":0,"id":"s","createdAt":0,"delegationDepth":0}\nNOT_VALID_JSON\n';
    expect(() => parseTranscriptWithCanonicalParser(invalidJsonl, 's', 'broken.jsonl')).toThrow(
      BackupIntegrityError
    );
  });

  it('reconciles 100% matched projection between SQLite web_messages and DSH JSONL', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'enkeep-reconcile-test-'));

    try {
      const dbPath = join(tempDir, 'platform.db');
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE web_messages (
          id TEXT PRIMARY KEY,
          session_id TEXT,
          role TEXT,
          content TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO web_messages (id, session_id, role, content) VALUES
          ('msg1', 'sess_1', 'user', 'Hello'),
          ('msg2', 'sess_1', 'assistant', 'World');
      `);
      db.close();

      const sessDir = join(tempDir, 'sessions', 'sp_alice', 'sess_1');
      mkdirSync(sessDir, { recursive: true });
      const jsonl = [
        JSON.stringify({ type: 'session', version: 0, id: 'sess_1', createdAt: 100, delegationDepth: 0 }),
        JSON.stringify({ type: 'user/message', seq: 0, time: 100, data: { id: 'msg1', role: 'user', content: [{ type: 'text', text: 'Hello' }] } }),
        JSON.stringify({ type: 'assistant/message', seq: 1, time: 101, data: { id: 'msg2', role: 'assistant', message: { id: 'msg2', role: 'assistant', content: [{ type: 'text', text: 'World' }] } } }),
      ].join('\n') + '\n';
      writeFileSync(join(sessDir, 'session.jsonl'), jsonl);

      const fakeManifest: any = {
        formatVersion: 1,
        migrationChecksums: {},
        dshInventory: [
          {
            userId: 'alice',
            sessionId: 'sess_1',
            relativePath: 'sessions/sp_alice/sess_1/session.jsonl',
          },
        ],
      };

      const checks = await validateRestoredTarget({
        targetRoot: tempDir,
        manifest: fakeManifest,
      });

      const reconcileCheck = checks.find((c) => c.name === 'dual_storage_reconcile');
      expect(reconcileCheck?.status).toBe('passed');
      expect(reconcileCheck?.message).toContain('100%');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails reconciliation on message content drift between SQLite and DSH', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'enkeep-drift-test-'));

    try {
      const dbPath = join(tempDir, 'platform.db');
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE web_messages (
          id TEXT PRIMARY KEY,
          session_id TEXT,
          role TEXT,
          content TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO web_messages (id, session_id, role, content) VALUES
          ('msg1', 'sess_1', 'user', 'Hello SQLite');
      `);
      db.close();

      const sessDir = join(tempDir, 'sessions', 'sp_alice', 'sess_1');
      mkdirSync(sessDir, { recursive: true });
      const jsonl = [
        JSON.stringify({ type: 'session', version: 0, id: 'sess_1', createdAt: 100, delegationDepth: 0 }),
        JSON.stringify({
          type: 'user/message',
          seq: 0,
          time: 100,
          data: { id: 'msg1', role: 'user', content: [{ type: 'text', text: 'Hello DSH Drifted' }] },
        }),
      ].join('\n') + '\n';
      writeFileSync(join(sessDir, 'session.jsonl'), jsonl);

      const fakeManifest: any = {
        formatVersion: 1,
        migrationChecksums: {},
        dshInventory: [
          {
            userId: 'alice',
            sessionId: 'sess_1',
            relativePath: 'sessions/sp_alice/sess_1/session.jsonl',
          },
        ],
      };

      await expect(
        validateRestoredTarget({
          targetRoot: tempDir,
          manifest: fakeManifest,
        })
      ).rejects.toThrow(/Dual-storage content mismatch/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails reconciliation on role drift between SQLite and DSH', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'enkeep-role-drift-test-'));

    try {
      const dbPath = join(tempDir, 'platform.db');
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE web_messages (
          id TEXT PRIMARY KEY,
          session_id TEXT,
          role TEXT,
          content TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO web_messages (id, session_id, role, content) VALUES
          ('msg1', 'sess_1', 'assistant', 'Same text');
      `);
      db.close();

      const sessDir = join(tempDir, 'sessions', 'sp_alice', 'sess_1');
      mkdirSync(sessDir, { recursive: true });
      const jsonl = [
        JSON.stringify({ type: 'session', version: 0, id: 'sess_1', createdAt: 100, delegationDepth: 0 }),
        JSON.stringify({
          type: 'user/message',
          seq: 0,
          time: 100,
          data: { id: 'msg1', role: 'user', content: [{ type: 'text', text: 'Same text' }] },
        }),
      ].join('\n') + '\n';
      writeFileSync(join(sessDir, 'session.jsonl'), jsonl);

      const fakeManifest: any = {
        formatVersion: 1,
        migrationChecksums: {},
        dshInventory: [
          {
            userId: 'alice',
            sessionId: 'sess_1',
            relativePath: 'sessions/sp_alice/sess_1/session.jsonl',
          },
        ],
      };

      await expect(
        validateRestoredTarget({
          targetRoot: tempDir,
          manifest: fakeManifest,
        })
      ).rejects.toThrow(/Dual-storage role mismatch/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
