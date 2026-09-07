import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, statSync, symlinkSync, unlinkSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  writeSignedProcessMeta,
  readSignedProcessMeta,
  listSignedProcesses,
  removeSignedProcessMeta,
  writeSignedContainerMeta,
  readSignedContainerMeta,
  listSignedContainers,
  removeSignedContainerMeta,
  writeSignedVolumeMeta,
  readSignedVolumeMeta,
  listSignedVolumes,
  removeSignedVolumeMeta,
  getDemoSecrets,
  generateAndSaveSecrets,
  validateSecretsFile,
  resetCachedSecrets,
  rotateSessionMetaSecret,
} from '../src/utils/crypto-meta.js';
import { getDemoPathConfig } from '../src/config.js';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';

describe('Signed Process & Container Metadata & secrets.json Security', () => {
  let tempRepo: TempRepo;
  let paths: ReturnType<typeof getDemoPathConfig>;

  beforeEach(() => {
    tempRepo = createTempRepo();
    paths = getDemoPathConfig(tempRepo.repoRoot);
    resetCachedSecrets(tempRepo.repoRoot);
  });

  afterEach(() => {
    resetCachedSecrets(tempRepo.repoRoot);
    tempRepo.cleanup();
  });

  it('generates secrets.json with schemaVersion, 3 distinct hex = 64 chars, and mode 0600', () => {
    const secrets = getDemoSecrets(tempRepo.repoRoot);
    expect(secrets.schemaVersion).toBe(1);
    expect(secrets.metaSecret).toHaveLength(64);
    expect(secrets.cookieSecret).toHaveLength(64);
    expect(secrets.csrfToken).toHaveLength(64);
    expect(secrets.metaSecret).not.toBe(secrets.cookieSecret);
    expect(secrets.metaSecret).not.toBe(secrets.csrfToken);
    expect(secrets.cookieSecret).not.toBe(secrets.csrfToken);

    const secretsPath = join(paths.demoDataDir, 'secrets.json');
    expect(existsSync(secretsPath)).toBe(true);

    const stats = statSync(secretsPath);
    expect(stats.isFile()).toBe(true);
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o600);

    // Verify .meta-secret does NOT exist
    const metaSecretPath = join(paths.demoDataDir, '.meta-secret');
    expect(existsSync(metaSecretPath)).toBe(false);
  });

  it('rotates secrets.json safely when overwrite=true', () => {
    const initial = generateAndSaveSecrets(tempRepo.repoRoot, false);
    resetCachedSecrets(tempRepo.repoRoot);

    const rotated = generateAndSaveSecrets(tempRepo.repoRoot, true);
    expect(rotated.metaSecret).not.toBe(initial.metaSecret);
    expect(rotated.cookieSecret).not.toBe(initial.cookieSecret);
    expect(rotated.csrfToken).not.toBe(initial.csrfToken);

    const secretsPath = join(paths.demoDataDir, 'secrets.json');
    const stats = statSync(secretsPath);
    expect(stats.mode & 0o777).toBe(0o600);

    const reloaded = getDemoSecrets(tempRepo.repoRoot);
    expect(reloaded.metaSecret).toBe(rotated.metaSecret);
  });

  it('refuses to overwrite or load secrets.json if it is a symlink', () => {
    mkdirSync(paths.demoDataDir, { recursive: true, mode: 0o700 });
    const secretsPath = join(paths.demoDataDir, 'secrets.json');
    const targetPath = join(paths.demoDataDir, 'real-secrets.json');
    writeFileSync(targetPath, '{}', { mode: 0o600 });

    symlinkSync(targetPath, secretsPath);

    expect(() => validateSecretsFile(secretsPath, tempRepo.repoRoot)).toThrow(
      /Safety Violation/
    );

    expect(() => generateAndSaveSecrets(tempRepo.repoRoot, true)).toThrow(
      /Safety Violation/
    );

    unlinkSync(secretsPath);
    unlinkSync(targetPath);
  });

  it('writes and verifies cryptographically signed process metadata', () => {
    const meta = writeSignedProcessMeta(
      {
        service: 'test-service',
        pid: 12345,
        port: 4321,
        url: 'http://127.0.0.1:4321',
        command: 'node test.js',
      },
      tempRepo.repoRoot
    );

    expect(meta.owner).toBe('enkeep-demo');
    expect(meta.commandToken).toMatch(/^cmd_test-service_/);
    expect(meta.signature).toHaveLength(64); // SHA-256 hex length

    const read = readSignedProcessMeta('test-service', tempRepo.repoRoot);
    expect(read).not.toBeNull();
    expect(read?.pid).toBe(12345);
    expect(read?.port).toBe(4321);
    expect(read?.signature).toBe(meta.signature);

    const list = listSignedProcesses(tempRepo.repoRoot);
    expect(list.some((p) => p.service === 'test-service')).toBe(true);

    const removed = removeSignedProcessMeta('test-service', tempRepo.repoRoot);
    expect(removed).toBe(true);
    expect(readSignedProcessMeta('test-service', tempRepo.repoRoot)).toBeNull();
  });

  it('detects and rejects tampered process metadata files', () => {
    writeSignedProcessMeta(
      {
        service: 'tamper-test',
        pid: 9999,
        port: 5555,
      },
      tempRepo.repoRoot
    );

    const filePath = join(paths.pidsDir, 'tamper-test.json');
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    // Tamper PID to another process
    raw.pid = 1;
    writeFileSync(filePath, JSON.stringify(raw, null, 2), 'utf-8');

    expect(() => readSignedProcessMeta('tamper-test', tempRepo.repoRoot)).toThrow(
      /Cryptographic signature verification failed/
    );

    removeSignedProcessMeta('tamper-test', tempRepo.repoRoot);
  });

  it('writes and verifies cryptographically signed container metadata with exact 64-hex containerId and enkeep.run-id', () => {
    const hex64 = randomBytes(32).toString('hex');
    const meta = writeSignedContainerMeta(
      {
        userId: 'alice',
        containerName: 'enkeep-demo-alice',
        containerId: hex64,
        image: 'enkeep-demo-runtime:latest',
        volumeName: 'enkeep-demo-dsh-alice',
        volumeId: 'vol_alice_001',
        runId: 'run_test_001',
      },
      tempRepo.repoRoot
    );

    expect(meta.owner).toBe('enkeep-demo');
    expect(meta.containerName).toBe('enkeep-demo-alice');
    expect(meta.labels.app).toBe('enkeep-demo');
    expect(meta.labels['enkeep.user']).toBe('alice');
    expect(meta.labels['enkeep.run-id']).toBe('run_test_001');

    const read = readSignedContainerMeta('enkeep-demo-alice', tempRepo.repoRoot);
    expect(read).not.toBeNull();
    expect(read?.containerId).toBe(hex64);

    const list = listSignedContainers(tempRepo.repoRoot);
    expect(list.some((c) => c.containerName === 'enkeep-demo-alice')).toBe(true);

    const removed = removeSignedContainerMeta('enkeep-demo-alice', tempRepo.repoRoot);
    expect(removed).toBe(true);
    expect(readSignedContainerMeta('enkeep-demo-alice', tempRepo.repoRoot)).toBeNull();
  });

  it('writes and verifies cryptographically signed volume metadata', () => {
    const meta = writeSignedVolumeMeta(
      {
        userId: 'alice',
        volumeName: 'enkeep-demo-dsh-alice',
        volumeId: 'vol_alice_001',
        runId: 'run_vol_001',
      },
      tempRepo.repoRoot
    );

    expect(meta.owner).toBe('enkeep-demo');
    expect(meta.volumeName).toBe('enkeep-demo-dsh-alice');
    expect(meta.volumeId).toBe('vol_alice_001');

    const read = readSignedVolumeMeta('enkeep-demo-dsh-alice', tempRepo.repoRoot);
    expect(read).not.toBeNull();
    expect(read?.volumeId).toBe('vol_alice_001');

    const list = listSignedVolumes(tempRepo.repoRoot);
    expect(list.some((v) => v.volumeName === 'enkeep-demo-dsh-alice')).toBe(true);

    const removed = removeSignedVolumeMeta('enkeep-demo-dsh-alice', tempRepo.repoRoot);
    expect(removed).toBe(true);
    expect(readSignedVolumeMeta('enkeep-demo-dsh-alice', tempRepo.repoRoot)).toBeNull();
  });

  it('rejects container metadata without mandatory enkeep-demo- prefix', () => {
    const hex64 = randomBytes(32).toString('hex');
    expect(() =>
      writeSignedContainerMeta(
        {
          userId: 'alice',
          containerName: 'unauthorized-container',
          containerId: hex64,
          image: 'alpine',
          volumeName: 'enkeep-demo-dsh-vol',
          volumeId: 'vol_alice_001',
          runId: 'run_bad_001',
        },
        tempRepo.repoRoot
      )
    ).toThrow(/must start with prefix "enkeep-demo-"/);
  });

  it('rejects container metadata with uppercase hex or non-64 length containerId', () => {
    const upperHex64 = randomBytes(32).toString('hex').toUpperCase();
    expect(() =>
      writeSignedContainerMeta(
        {
          userId: 'alice',
          containerName: 'enkeep-demo-alice',
          containerId: upperHex64,
          image: 'alpine',
          volumeName: 'enkeep-demo-dsh-alice',
          volumeId: 'vol_alice_001',
          runId: 'run_alice_001',
        },
        tempRepo.repoRoot
      )
    ).toThrow(/must be a 64-hex SHA-256 lowercase string/);

    const shortId = '0123456789ab';
    expect(() =>
      writeSignedContainerMeta(
        {
          userId: 'alice',
          containerName: 'enkeep-demo-alice',
          containerId: shortId,
          image: 'alpine',
          volumeName: 'enkeep-demo-dsh-alice',
          volumeId: 'vol_alice_001',
          runId: 'run_alice_001',
        },
        tempRepo.repoRoot
      )
    ).toThrow(/must be a 64-hex SHA-256 lowercase string/);
  });

  it('refuses to validate secrets file with overly permissive mode (e.g. 0644)', () => {
    getDemoSecrets(tempRepo.repoRoot);
    const secretsPath = join(paths.demoDataDir, 'secrets.json');
    resetCachedSecrets(tempRepo.repoRoot);

    chmodSync(secretsPath, 0o644);
    expect(() => validateSecretsFile(secretsPath, tempRepo.repoRoot)).toThrow(
      /Safety Violation: File permissions are 644\. Expected exact 600\./
    );
  });

  it('safely commits secure JSON file with verified descriptor and mode', () => {
    const filePath = join(paths.pidsDir, 'atomic-test.json');
    writeSignedProcessMeta(
      {
        service: 'atomic-test',
        pid: 3333,
        port: 4444,
      },
      tempRepo.repoRoot
    );

    const stat = statSync(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
    const read = readSignedProcessMeta('atomic-test', tempRepo.repoRoot);
    expect(read?.pid).toBe(3333);
    removeSignedProcessMeta('atomic-test', tempRepo.repoRoot);
  });
});
