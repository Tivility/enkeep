import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  writeSignedProcessMeta,
  readSignedProcessMeta,
  writeSignedContainerMeta,
  readSignedContainerMeta,
  getSessionMetaSecret,
  rotateSessionMetaSecret,
  resetSessionMetaSecret,
  deriveSecret,
  signPayload,
  verifySignature,
  getDemoSecrets,
} from '../src/utils/crypto-meta.js';
import { getDemoPathConfig } from '../src/config.js';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';

describe('Negative Security Tests: Metadata & Cryptographic Integrity', () => {
  let tempRepo: TempRepo;
  let paths: ReturnType<typeof getDemoPathConfig>;

  beforeEach(() => {
    tempRepo = createTempRepo();
    paths = getDemoPathConfig(tempRepo.repoRoot);
    resetSessionMetaSecret(tempRepo.repoRoot);
    mkdirSync(paths.pidsDir, { recursive: true });
    mkdirSync(paths.containersDir, { recursive: true });
  });

  afterEach(() => {
    resetSessionMetaSecret(tempRepo.repoRoot);
    tempRepo.cleanup();
  });

  it('fails closed when metadata PID is tampered', () => {
    writeSignedProcessMeta(
      {
        service: 'tamper-pid-test',
        pid: 12345,
        port: 4100,
      },
      tempRepo.repoRoot
    );

    const filePath = join(paths.pidsDir, 'tamper-pid-test.json');
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    raw.pid = 54321; // Tampered PID
    writeFileSync(filePath, JSON.stringify(raw, null, 2), 'utf-8');

    expect(() => readSignedProcessMeta('tamper-pid-test', tempRepo.repoRoot)).toThrow(
      /Cryptographic signature verification failed/
    );
  });

  it('fails closed when metadata port is tampered', () => {
    writeSignedProcessMeta(
      {
        service: 'tamper-port-test',
        pid: 12345,
        port: 4100,
      },
      tempRepo.repoRoot
    );

    const filePath = join(paths.pidsDir, 'tamper-port-test.json');
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    raw.port = 3080; // Tamper to protected port
    writeFileSync(filePath, JSON.stringify(raw, null, 2), 'utf-8');

    expect(() => readSignedProcessMeta('tamper-port-test', tempRepo.repoRoot)).toThrow(
      /Cryptographic signature verification failed/
    );
  });

  it('fails closed when metadata commandToken is tampered', () => {
    writeSignedProcessMeta(
      {
        service: 'tamper-token-test',
        pid: 12345,
      },
      tempRepo.repoRoot
    );

    const filePath = join(paths.pidsDir, 'tamper-token-test.json');
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    raw.commandToken = 'cmd_tamper-token-test_forged';
    writeFileSync(filePath, JSON.stringify(raw, null, 2), 'utf-8');

    expect(() => readSignedProcessMeta('tamper-token-test', tempRepo.repoRoot)).toThrow(
      /Cryptographic signature verification failed/
    );
  });

  it('fails closed when metadata signature is forged or invalid', () => {
    writeSignedProcessMeta(
      {
        service: 'forged-sig-test',
        pid: 12345,
      },
      tempRepo.repoRoot
    );

    const filePath = join(paths.pidsDir, 'forged-sig-test.json');
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    raw.signature = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    writeFileSync(filePath, JSON.stringify(raw, null, 2), 'utf-8');

    expect(() => readSignedProcessMeta('forged-sig-test', tempRepo.repoRoot)).toThrow(
      /Cryptographic signature verification failed/
    );
  });

  it('fails closed on non-integer or negative PID in metadata', () => {
    const filePath = join(paths.pidsDir, 'invalid-pid.json');
    const fake = {
      schemaVersion: 1,
      service: 'invalid-pid',
      pid: -10,
      startedAt: new Date().toISOString(),
      owner: 'enkeep-demo',
      commandToken: 'tok',
      runId: 'run_inv_001',
      signature: 'sig',
    };
    writeFileSync(filePath, JSON.stringify(fake), { mode: 0o600, encoding: 'utf-8' });

    expect(() => readSignedProcessMeta('invalid-pid', tempRepo.repoRoot)).toThrow(/Invalid PID/);
  });

  it('fails closed on invalid ownership tag', () => {
    const filePath = join(paths.pidsDir, 'foreign-owner.json');
    const fake = {
      schemaVersion: 1,
      service: 'foreign-owner',
      pid: 1234,
      startedAt: new Date().toISOString(),
      owner: 'attacker-system',
      commandToken: 'tok',
      runId: 'run_for_001',
      signature: 'sig',
    };
    writeFileSync(filePath, JSON.stringify(fake), { mode: 0o600, encoding: 'utf-8' });

    expect(() => readSignedProcessMeta('foreign-owner', tempRepo.repoRoot)).toThrow(/Invalid owner tag/);
  });

  it('fails closed when container metadata containerId is tampered', () => {
    const hex64 = randomBytes(32).toString('hex');
    writeSignedContainerMeta(
      {
        userId: 'alice',
        containerName: 'enkeep-demo-alice',
        containerId: hex64,
        image: 'enkeep-demo-runtime:latest',
        volumeName: 'enkeep-demo-dsh-alice',
        volumeId: 'vol_alice_001',
        runId: 'run_alice_001',
      },
      tempRepo.repoRoot
    );

    const filePath = join(paths.containersDir, 'enkeep-demo-alice.json');
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    raw.containerId = randomBytes(32).toString('hex');
    writeFileSync(filePath, JSON.stringify(raw, null, 2), 'utf-8');

    expect(() => readSignedContainerMeta('enkeep-demo-alice', tempRepo.repoRoot)).toThrow(
      /Cryptographic signature verification failed/
    );
  });

  it('fails closed when container labels are tampered to remove app=enkeep-demo', () => {
    const hex64 = randomBytes(32).toString('hex');
    writeSignedContainerMeta(
      {
        userId: 'alice',
        containerName: 'enkeep-demo-alice',
        containerId: hex64,
        image: 'img',
        volumeName: 'enkeep-demo-dsh-alice',
        volumeId: 'vol_alice_001',
        runId: 'run_alice_001',
      },
      tempRepo.repoRoot
    );

    const filePath = join(paths.containersDir, 'enkeep-demo-alice.json');
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    raw.labels = { app: 'attacker-app' };
    writeFileSync(filePath, JSON.stringify(raw, null, 2), 'utf-8');

    expect(() => readSignedContainerMeta('enkeep-demo-alice', tempRepo.repoRoot)).toThrow(
      /Missing mandatory ownership label/
    );
  });

  it('fails closed when secrets.json is corrupted or invalid', () => {
    const secretsPath = join(paths.demoDataDir, 'secrets.json');
    writeFileSync(secretsPath, '{"invalid": true}', { mode: 0o600, encoding: 'utf-8' });
    resetSessionMetaSecret(tempRepo.repoRoot);

    expect(() => getDemoSecrets(tempRepo.repoRoot)).toThrow(/FAIL-CLOSED: Invalid secrets\.json/);
  });

  it('derives cryptographically distinct secrets for different subsystems from root secret', () => {
    const secret1 = deriveSecret('auth-cookie', tempRepo.repoRoot);
    const secret2 = deriveSecret('csrf-token', tempRepo.repoRoot);
    const secret3 = deriveSecret('auth-cookie', tempRepo.repoRoot);

    expect(secret1).toBeTruthy();
    expect(secret2).toBeTruthy();
    expect(secret1.length).toBe(64);
    expect(secret2.length).toBe(64);
    expect(secret1).not.toBe(secret2);
    expect(secret1).toBe(secret3); // Deterministic for same purpose
  });
});
