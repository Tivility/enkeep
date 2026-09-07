import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createBackup, computeSha256 } from '../src/index.js';
import { BackupRestoreSafetyError } from '../src/errors.js';

describe('SQLite VACUUM INTO Strict Atomic Snapshot & Fault Injection Tests', () => {
  let tempBase: string;
  let sourceDir: string;
  let outputArchive: string;
  let passFile: string;

  beforeEach(() => {
    tempBase = mkdtempSync(join(tmpdir(), 'enkeep-vacuum-fault-'));
    sourceDir = join(tempBase, 'source-data');
    outputArchive = join(tempBase, 'output.tar.enc');
    passFile = join(tempBase, 'pass.txt');

    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(passFile, 'TestPassphrase12345!\n');

    // Create source DB in rollback journal mode
    const dbPath = join(sourceDir, 'platform.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT);
      INSERT INTO users VALUES ('u1', 'Alice');
    `);
    db.close();

    writeFileSync(join(sourceDir, 'secrets.json'), '{"key":"val"}\n', { mode: 0o600 });
  });

  afterEach(() => {
    try {
      rmSync(tempBase, { recursive: true, force: true });
    } catch {}
  });

  it('proves zero-copy fallback: if VACUUM INTO fails due to locked database, createBackup fails and never creates dirty copy', async () => {
    const dbPath = join(sourceDir, 'platform.db');

    // Lock the SQLite database with an exclusive active transaction in a separate connection
    const lockingDb = new DatabaseSync(dbPath);
    lockingDb.exec("BEGIN EXCLUSIVE TRANSACTION; INSERT INTO users VALUES ('u_lock', 'Locked');");

    const beforeDbHash = computeSha256(readFileSync(dbPath));

    try {
      await expect(
        createBackup({
          dataRoot: sourceDir,
          outputPath: outputArchive,
          passphraseFile: passFile,
          demoStopConfirmed: true,
        })
      ).rejects.toThrow(BackupRestoreSafetyError);

      // Verify that NO output archive was created
      expect(existsSync(outputArchive)).toBe(false);

      // Verify source database was completely untouched
      const afterDbHash = computeSha256(readFileSync(dbPath));
      expect(afterDbHash).toBe(beforeDbHash);
    } finally {
      try {
        lockingDb.exec('ROLLBACK');
        lockingDb.close();
      } catch {}
    }
  });

  it('ensures clean snapshot without depending on -wal or -shm files', async () => {
    const dbPath = join(sourceDir, 'platform.db');

    // Convert to WAL mode and write active data
    const db = new DatabaseSync(dbPath);
    db.exec(`
      PRAGMA journal_mode = WAL;
      INSERT INTO users VALUES ('u2', 'Bob');
    `);
    db.close();

    const result = await createBackup({
      dataRoot: sourceDir,
      outputPath: outputArchive,
      passphraseFile: passFile,
      demoStopConfirmed: true,
    });

    expect(result.success).toBe(true);
    expect(result.manifest.sqliteIntegrity.status).toBe('ok');
    expect(result.manifest.sqliteIntegrity.userCount).toBe(2);

    // Verify manifest only contains platform.db, never transient platform.db-wal or -shm
    const filePaths = result.manifest.files.map((f) => f.path);
    expect(filePaths).toContain('platform.db');
    expect(filePaths).not.toContain('platform.db-wal');
    expect(filePaths).not.toContain('platform.db-shm');
  });
});
