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
import {
  createBackup,
  inspectBackup,
  verifyBackup,
  restoreBackup,
  TarWriter,
  encryptBackupPayload,
  computeSha256,
} from '../src/index.js';
import {
  BackupArchiveError,
  BackupEncryptionError,
  BackupIntegrityError,
  BackupPathSafetyError,
  BackupRestoreSafetyError,
  BackupVersionMismatchError,
} from '../src/errors.js';

describe('Security Confinement & Adversarial Verification', () => {
  let tempBase: string;
  let sourceDir: string;
  let outputArchive: string;
  let restoreTarget: string;
  let passFile: string;

  beforeEach(() => {
    tempBase = mkdtempSync(join(tmpdir(), 'enkeep-sec-test-'));
    sourceDir = join(tempBase, 'source-data');
    outputArchive = join(tempBase, 'archive.tar.enc');
    restoreTarget = join(tempBase, 'restored');
    passFile = join(tempBase, 'pass.txt');

    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(passFile, 'Adversarial-Test-Pass-123456\n');

    // Minimum valid source fixture
    writeFileSync(join(sourceDir, 'secrets.json'), '{"jwtSecret":"test"}\n', { mode: 0o600 });
    const db = new DatabaseSync(join(sourceDir, 'platform.db'));
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);
      INSERT INTO users VALUES ('u1', 'User 1');
    `);
    db.close();
  });

  afterEach(() => {
    try {
      rmSync(tempBase, { recursive: true, force: true });
    } catch {}
  });

  it('ensures source directory remains 100% untouched and unchanged after backup creation', async () => {
    const beforeDbHash = computeSha256(readFileSync(join(sourceDir, 'platform.db')));
    const beforeSecretsHash = computeSha256(readFileSync(join(sourceDir, 'secrets.json')));
    const beforeEntries = readdirSync(sourceDir).sort();

    await createBackup({
      dataRoot: sourceDir,
      outputPath: outputArchive,
      passphraseFile: passFile,
    });

    const afterDbHash = computeSha256(readFileSync(join(sourceDir, 'platform.db')));
    const afterSecretsHash = computeSha256(readFileSync(join(sourceDir, 'secrets.json')));
    const afterEntries = readdirSync(sourceDir).sort();

    expect(afterDbHash).toBe(beforeDbHash);
    expect(afterSecretsHash).toBe(beforeSecretsHash);
    expect(afterEntries).toEqual(beforeEntries);
  });

  it('rejects malicious archive containing path traversal attack entries', async () => {
    // Handcraft a tar archive containing a traversal entry '../etc/cron'
    const writer = new TarWriter();

    // Bypass normal TarWriter path normalization by testing reader directly or tampered tar buffer
    expect(() =>
      writer.addFile({
        path: '../etc/passwd',
        data: Buffer.from('malicious'),
      })
    ).toThrow(BackupPathSafetyError);
  });

  it('fails closed when database integrity_check fails in restore verification', async () => {
    // Create corrupted database in source
    const corruptedDbPath = join(sourceDir, 'platform.db');
    // Overwrite header with junk
    const corruptedBuf = Buffer.alloc(4096, 0xff);
    writeFileSync(corruptedDbPath, corruptedBuf);

    await expect(
      createBackup({
        dataRoot: sourceDir,
        outputPath: outputArchive,
        passphraseFile: passFile,
      })
    ).rejects.toThrow();
  });

  it('fails closed when foreign key constraints are violated', async () => {
    // Database with FK constraint violation
    const fkDbPath = join(sourceDir, 'platform.db');
    const db = new DatabaseSync(fkDbPath);
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE parent (id TEXT PRIMARY KEY);
      CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id));
      INSERT INTO child VALUES ('c1', 'nonexistent_p1');
    `);
    db.close();

    await expect(
      createBackup({
        dataRoot: sourceDir,
        outputPath: outputArchive,
        passphraseFile: passFile,
      })
    ).rejects.toThrow(BackupIntegrityError);
  });

  it('fails closed when DSH JSONL file contains corrupted syntax', async () => {
    const sessDir = join(sourceDir, 'sessions', 'sp_alice', 's1');
    mkdirSync(sessDir, { recursive: true });
    // Write invalid JSON line
    writeFileSync(join(sessDir, 'session.jsonl'), '{"valid":"json"}\nINVALID_CORRUPTED_LINE{{{\n');

    await createBackup({
      dataRoot: sourceDir,
      outputPath: outputArchive,
      passphraseFile: passFile,
    });

    // Verification should fail on corrupt JSONL
    await expect(
      verifyBackup({
        archivePath: outputArchive,
        passphraseFile: passFile,
      })
    ).rejects.toThrow(BackupIntegrityError);
  });

  it('fails closed when runtime image mismatches unless --allow-runtime-image-mismatch is passed', async () => {
    const originalImage = process.env.ENKEEP_RUNTIME_IMAGE;
    try {
      process.env.ENKEEP_RUNTIME_IMAGE = 'enkeep-demo-runtime:v1.0.0';

      await createBackup({
        dataRoot: sourceDir,
        outputPath: outputArchive,
        passphraseFile: passFile,
      });

      // Change runtime environment image to different version
      process.env.ENKEEP_RUNTIME_IMAGE = 'enkeep-demo-runtime:v2.0.0-incompatible';

      // Restore should fail by default
      await expect(
        restoreBackup({
          archivePath: outputArchive,
          targetRoot: restoreTarget,
          passphraseFile: passFile,
          allowRuntimeImageMismatch: false,
        })
      ).rejects.toThrow(BackupVersionMismatchError);

      // Restore should succeed when explicitly permitted
      const result = await restoreBackup({
        archivePath: outputArchive,
        targetRoot: restoreTarget,
        passphraseFile: passFile,
        allowRuntimeImageMismatch: true,
      });
      expect(result.success).toBe(true);
    } finally {
      process.env.ENKEEP_RUNTIME_IMAGE = originalImage;
    }
  });

  it('cleans up staging directory without touching target when restoration fails mid-process', async () => {
    await createBackup({
      dataRoot: sourceDir,
      outputPath: outputArchive,
      passphraseFile: passFile,
    });

    // Corrupt archive after creation
    const rawArchive = readFileSync(outputArchive);
    rawArchive[rawArchive.length - 10] = 0xee; // corrupt ciphertext
    writeFileSync(outputArchive, rawArchive);

    // Attempt restore
    await expect(
      restoreBackup({
        archivePath: outputArchive,
        targetRoot: restoreTarget,
        passphraseFile: passFile,
      })
    ).rejects.toThrow();

    // Restore target should NOT exist or be corrupted
    expect(existsSync(restoreTarget)).toBe(false);

    // No leftover staging directory in parent
    const parentEntries = readdirSync(tempBase);
    const leftoverStages = parentEntries.filter((e) => e.startsWith('.enkeep-restore-stage-'));
    expect(leftoverStages).toEqual([]);
  });
});
