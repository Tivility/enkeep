import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  createBackup,
  inspectBackup,
  verifyBackup,
  restoreBackup,
  computeSha256,
} from '../src/index.js';
import {
  BackupEncryptionError,
  BackupIntegrityError,
  BackupPathSafetyError,
  BackupRestoreSafetyError,
} from '../src/errors.js';

describe('Backup & Restore Full Production End-to-End Suite', () => {
  let tempBase: string;
  let sourceDir: string;
  let outputArchive: string;
  let restoreTarget: string;
  let passFile: string;

  beforeEach(() => {
    tempBase = mkdtempSync(join(tmpdir(), 'enkeep-bkp-e2e-'));
    sourceDir = join(tempBase, 'source-data');
    outputArchive = join(tempBase, 'archives', 'enkeep-backup.tar.enc');
    restoreTarget = join(tempBase, 'restored-data');
    passFile = join(tempBase, 'passphrase.txt');

    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(passFile, 'Strong-Production-Passphrase-98765\n');

    // Populate realistic source fixture
    // 1. Secrets file
    writeFileSync(
      join(sourceDir, 'secrets.json'),
      JSON.stringify({
        sessionSecret: 'secret_hmac_key_1234567890abcdef',
        metaSecret: 'secret_meta_token_9876543210fedcba',
        createdAt: '2026-08-28T00:00:00.000Z',
      }, null, 2),
      { mode: 0o600 }
    );

    // 2. Real SQLite database with schema migrations, users, spaces, session_routes, web_messages
    const dbPath = join(sourceDir, 'platform.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE _schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      INSERT INTO _schema_migrations VALUES (1, '001_initial', 'chk001', '2026-08-28T00:00:00.000Z');
      INSERT INTO _schema_migrations VALUES (2, '002_routes', 'chk002', '2026-08-28T00:00:00.000Z');

      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL,
        password_hash TEXT NOT NULL
      );
      INSERT INTO users VALUES ('alice', 'alice', 'admin', 'scrypt_hash_alice');
      INSERT INTO users VALUES ('bob', 'bob', 'user', 'scrypt_hash_bob');

      CREATE TABLE spaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_user_id TEXT NOT NULL REFERENCES users(id)
      );
      INSERT INTO spaces VALUES ('sp_alice', 'Alice Space', 'alice');
      INSERT INTO spaces VALUES ('sp_bob', 'Bob Space', 'bob');

      CREATE TABLE session_routes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        dsh_session_id TEXT
      );
      INSERT INTO session_routes VALUES ('sess_alice_1', 'alice', 'dsh_sess_alice_1');

      CREATE TABLE web_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session_routes(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        role TEXT NOT NULL,
        content TEXT NOT NULL
      );
      INSERT INTO web_messages VALUES ('msg_1', 'sess_alice_1', 'alice', 'user', 'Hello world');
      INSERT INTO web_messages VALUES ('msg_2', 'sess_alice_1', 'alice', 'assistant', 'Hello Alice');
    `);
    db.close();

    // 3. DSH session JSONL files
    const sessionsDir = join(sourceDir, 'sessions', 'sp_alice', 'sess_alice_1');
    mkdirSync(sessionsDir, { recursive: true });
    const jsonlContent = [
      JSON.stringify({ type: 'user/message', seq: 0, time: 1785585600000, data: { id: 'msg_1', role: 'user', content: [{ type: 'text', text: 'Hello world' }] } }),
      JSON.stringify({ type: 'assistant/message', seq: 1, time: 1785585660000, data: { id: 'msg_2', role: 'assistant', content: [{ type: 'text', text: 'Hello Alice' }] } }),
    ].join('\n') + '\n';
    writeFileSync(join(sessionsDir, 'session.jsonl'), jsonlContent);
  });

  afterEach(() => {
    try {
      rmSync(tempBase, { recursive: true, force: true });
    } catch {}
  });

  it('executes full lifecycle: create -> inspect -> verify -> restore -> data consistency', async () => {
    // 1. CREATE BACKUP
    const createResult = await createBackup({
      dataRoot: sourceDir,
      outputPath: outputArchive,
      passphraseFile: passFile,
      description: 'Production E2E snapshot',
    });

    expect(createResult.success).toBe(true);
    expect(createResult.encrypted).toBe(true);
    expect(existsSync(outputArchive)).toBe(true);
    expect(createResult.manifest.sqliteIntegrity.status).toBe('ok');
    expect(createResult.manifest.sqliteIntegrity.userCount).toBe(2);
    expect(createResult.manifest.sqliteIntegrity.messageCount).toBe(2);
    expect(createResult.manifest.dshInventory.length).toBe(1);

    // 2. INSPECT BACKUP
    const inspectResult = await inspectBackup({
      archivePath: outputArchive,
      passphraseFile: passFile,
    });

    expect(inspectResult.encrypted).toBe(true);
    expect(inspectResult.manifest.description).toBe('Production E2E snapshot');
    expect(inspectResult.manifest.summary.hasSecrets).toBe(true);
    expect(inspectResult.manifest.platformSchemaVersion).toBe(2);

    // 3. VERIFY BACKUP
    const verifyResult = await verifyBackup({
      archivePath: outputArchive,
      passphraseFile: passFile,
    });

    expect(verifyResult.verified).toBe(true);
    expect(verifyResult.checks.every((c) => c.status === 'passed')).toBe(true);

    // 4. RESTORE DRY-RUN
    const dryRunResult = await restoreBackup({
      archivePath: outputArchive,
      targetRoot: restoreTarget,
      passphraseFile: passFile,
      dryRun: true,
    });

    expect(dryRunResult.success).toBe(true);
    expect(dryRunResult.dryRun).toBe(true);
    expect(existsSync(restoreTarget)).toBe(false); // Zero disk writes on dry-run!

    // 5. RESTORE TO TARGET
    const restoreResult = await restoreBackup({
      archivePath: outputArchive,
      targetRoot: restoreTarget,
      passphraseFile: passFile,
    });

    expect(restoreResult.success).toBe(true);
    expect(restoreResult.dryRun).toBe(false);
    expect(existsSync(restoreTarget)).toBe(true);

    // 6. VALIDATE RESTORED FILES & DATA INTEGRITY
    // Validate secrets.json byte-identical
    const srcSecrets = readFileSync(join(sourceDir, 'secrets.json'), 'utf8');
    const dstSecrets = readFileSync(join(restoreTarget, 'secrets.json'), 'utf8');
    expect(dstSecrets).toBe(srcSecrets);

    // Validate SQLite queries
    const restoredDb = new DatabaseSync(join(restoreTarget, 'platform.db'), { readOnly: true });
    const users = restoredDb.prepare('SELECT * FROM users ORDER BY username ASC').all() as Array<{ username: string }>;
    expect(users.map((u) => u.username)).toEqual(['alice', 'bob']);

    const messages = restoredDb.prepare('SELECT * FROM web_messages ORDER BY id ASC').all() as Array<{ content: string }>;
    expect(messages.map((m) => m.content)).toEqual(['Hello world', 'Hello Alice']);
    restoredDb.close();

    // Validate JSONL content
    const restoredJsonl = readFileSync(
      join(restoreTarget, 'sessions', 'sp_alice', 'sess_alice_1', 'session.jsonl'),
      'utf8'
    );
    expect(computeSha256(restoredJsonl)).toBe(
      computeSha256(readFileSync(join(sourceDir, 'sessions', 'sp_alice', 'sess_alice_1', 'session.jsonl'), 'utf8'))
    );
  });

  it('rejects unencrypted create when passphrase is not provided', async () => {
    await expect(
      createBackup({
        dataRoot: sourceDir,
        outputPath: outputArchive,
      })
    ).rejects.toThrow(BackupEncryptionError);
  });

  it('rejects backup creation when output is inside source dataRoot', async () => {
    const insideOutput = join(sourceDir, 'nested-backup.tar.enc');
    await expect(
      createBackup({
        dataRoot: sourceDir,
        outputPath: insideOutput,
        passphraseFile: passFile,
      })
    ).rejects.toThrow(BackupPathSafetyError);
  });

  it('rejects inspection and restore with incorrect passphrase', async () => {
    await createBackup({
      dataRoot: sourceDir,
      outputPath: outputArchive,
      passphraseFile: passFile,
    });

    const wrongPassFile = join(tempBase, 'wrong-pass.txt');
    writeFileSync(wrongPassFile, 'Incorrect-Passphrase-12345\n');

    await expect(
      inspectBackup({
        archivePath: outputArchive,
        passphraseFile: wrongPassFile,
      })
    ).rejects.toThrow(BackupEncryptionError);

    await expect(
      verifyBackup({
        archivePath: outputArchive,
        passphraseFile: wrongPassFile,
      })
    ).rejects.toThrow(BackupEncryptionError);

    await expect(
      restoreBackup({
        archivePath: outputArchive,
        targetRoot: restoreTarget,
        passphraseFile: wrongPassFile,
      })
    ).rejects.toThrow(BackupEncryptionError);
  });

  it('refuses restore into non-empty target directory without --force', async () => {
    await createBackup({
      dataRoot: sourceDir,
      outputPath: outputArchive,
      passphraseFile: passFile,
    });

    mkdirSync(restoreTarget, { recursive: true });
    writeFileSync(join(restoreTarget, 'pre-existing.txt'), 'pre-existing data');

    await expect(
      restoreBackup({
        archivePath: outputArchive,
        targetRoot: restoreTarget,
        passphraseFile: passFile,
        force: false,
      })
    ).rejects.toThrow(BackupRestoreSafetyError);

    // Should succeed with force: true
    const forced = await restoreBackup({
      archivePath: outputArchive,
      targetRoot: restoreTarget,
      passphraseFile: passFile,
      force: true,
    });
    expect(forced.success).toBe(true);
  });
});
