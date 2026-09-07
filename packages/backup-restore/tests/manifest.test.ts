import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  generateBackupManifest,
  validateBackupManifest,
  formatManifestSummary,
  inspectSqliteDatabase,
  buildSnapshotInventory,
} from '../src/index.js';
import { BackupManifestError } from '../src/errors.js';

describe('Manifest Generator & Inspector Tests', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'enkeep-manifest-test-'));
    dbPath = join(tempDir, 'platform.db');

    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE _schema_migrations (version INTEGER PRIMARY KEY, name TEXT, checksum TEXT);
      INSERT INTO _schema_migrations VALUES (1, '001_init', 'hash_001');

      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT);
      INSERT INTO users VALUES ('alice', 'alice');

      CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT, owner_user_id TEXT);
      INSERT INTO spaces VALUES ('sp1', 'Space 1', 'alice');

      CREATE TABLE web_messages (id TEXT PRIMARY KEY, content TEXT);
      INSERT INTO web_messages VALUES ('m1', 'hello');
    `);
    db.close();

    writeFileSync(join(tempDir, 'secrets.json'), '{"key":"value"}\n');

    mkdirSync(join(tempDir, 'sessions', 'sp_alice', 's1'), { recursive: true });
    writeFileSync(
      join(tempDir, 'sessions', 'sp_alice', 's1', 'session.jsonl'),
      '{"type":"user/message","data":{"text":"hi"}}\n'
    );
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('inspects SQLite database and extracts tables, counts, and migration checksums', () => {
    const info = inspectSqliteDatabase(dbPath);
    expect(info.integrity.status).toBe('ok');
    expect(info.integrity.userCount).toBe(1);
    expect(info.integrity.spaceCount).toBe(1);
    expect(info.integrity.messageCount).toBe(1);
    expect(info.latestVersion).toBe(1);
    expect(info.migrations['001']).toBe('hash_001');
  });

  it('builds snapshot inventory with file entries and DSH JSONL metadata', () => {
    const limits = { maxFileSize: 1000000, maxTotalSize: 10000000, maxFileCount: 100 };
    const inv = buildSnapshotInventory(tempDir, limits);

    expect(inv.files.length).toBe(3); // platform.db, secrets.json, session.jsonl
    expect(inv.dshInventory.length).toBe(1);
    expect(inv.dshInventory[0]!.validJsonl).toBe(true);
    expect(inv.dshInventory[0]!.lineCount).toBe(1);
  });

  it('generates, validates, and formats complete BackupManifest', () => {
    const manifest = generateBackupManifest({
      snapshotDir: tempDir,
      dbSnapshotPath: dbPath,
      encrypted: true,
      description: 'Test Manifest Description',
    });

    expect(manifest.formatVersion).toBe(1);
    expect(manifest.summary.hasSecrets).toBe(true);
    expect(manifest.summary.encrypted).toBe(true);

    const validated = validateBackupManifest(manifest);
    expect(validated.formatVersion).toBe(1);

    const summary = formatManifestSummary(manifest, 10240);
    expect(summary).toContain('Enkeep Backup Archive Information');
    expect(summary).toContain('Test Manifest Description');
    expect(summary).toContain('SQLite Database Summary:');
  });

  it('validator rejects malformed or invalid schema objects', () => {
    expect(() => validateBackupManifest(null)).toThrow(BackupManifestError);
    expect(() => validateBackupManifest({})).toThrow(BackupManifestError);
    expect(() => validateBackupManifest({ formatVersion: 999 })).toThrow(BackupManifestError);
  });
});
