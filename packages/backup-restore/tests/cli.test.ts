import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runBackupCli } from '../src/cli/backup-cli.js';
import { runRestoreCli } from '../src/cli/restore-cli.js';

describe('Backup & Restore CLI Runner Suite', () => {
  let tempBase: string;
  let sourceDir: string;
  let outputArchive: string;
  let restoreTarget: string;
  let passFile: string;

  beforeEach(() => {
    tempBase = mkdtempSync(join(tmpdir(), 'enkeep-cli-test-'));
    sourceDir = join(tempBase, 'source-data');
    outputArchive = join(tempBase, 'cli-backup.tar.enc');
    restoreTarget = join(tempBase, 'cli-restore');
    passFile = join(tempBase, 'pass.txt');

    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(passFile, 'CLI-Test-Passphrase-123456\n');

    writeFileSync(join(sourceDir, 'secrets.json'), '{"jwt":"secret"}\n');
    const db = new DatabaseSync(join(sourceDir, 'platform.db'));
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT);
      INSERT INTO users VALUES ('alice', 'alice');
    `);
    db.close();
  });

  afterEach(() => {
    try {
      rmSync(tempBase, { recursive: true, force: true });
    } catch {}
  });

  it('prints usage with --help and returns exit code 0', async () => {
    const code = await runBackupCli(['node', 'enkeep-backup', '--help']);
    expect(code).toBe(0);
  });

  it('creates encrypted backup via CLI create command', async () => {
    const code = await runBackupCli([
      'node',
      'enkeep-backup',
      'create',
      '--data-root',
      sourceDir,
      '--output',
      outputArchive,
      '--passphrase-file',
      passFile,
      '--json',
    ]);
    expect(code).toBe(0);
    expect(existsSync(outputArchive)).toBe(true);
  });

  it('inspects encrypted backup via CLI inspect command', async () => {
    await runBackupCli([
      'node',
      'enkeep-backup',
      'create',
      '--data-root',
      sourceDir,
      '--output',
      outputArchive,
      '--passphrase-file',
      passFile,
    ]);

    const code = await runBackupCli([
      'node',
      'enkeep-backup',
      'inspect',
      '--archive',
      outputArchive,
      '--passphrase-file',
      passFile,
      '--json',
    ]);
    expect(code).toBe(0);
  });

  it('verifies encrypted backup via CLI verify command', async () => {
    await runBackupCli([
      'node',
      'enkeep-backup',
      'create',
      '--data-root',
      sourceDir,
      '--output',
      outputArchive,
      '--passphrase-file',
      passFile,
    ]);

    const code = await runBackupCli([
      'node',
      'enkeep-backup',
      'verify',
      '--archive',
      outputArchive,
      '--passphrase-file',
      passFile,
      '--json',
    ]);
    expect(code).toBe(0);
  });

  it('restores encrypted backup via enkeep-restore CLI binary', async () => {
    await runBackupCli([
      'node',
      'enkeep-backup',
      'create',
      '--data-root',
      sourceDir,
      '--output',
      outputArchive,
      '--passphrase-file',
      passFile,
    ]);

    const code = await runRestoreCli([
      'node',
      'enkeep-restore',
      '--archive',
      outputArchive,
      '--target-root',
      restoreTarget,
      '--passphrase-file',
      passFile,
      '--json',
    ]);
    expect(code).toBe(0);
    expect(existsSync(join(restoreTarget, 'platform.db'))).toBe(true);
  });
});
