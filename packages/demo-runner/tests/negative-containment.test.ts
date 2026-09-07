import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  getDemoPathConfig,
  assertPathInDemoData,
} from '../src/config.js';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';

describe('Negative Security Tests: Symlink & Path Containment', () => {
  let tempRepo: TempRepo;
  let paths: ReturnType<typeof getDemoPathConfig>;

  beforeEach(() => {
    tempRepo = createTempRepo();
    paths = getDemoPathConfig(tempRepo.repoRoot);
    mkdirSync(paths.demoDataDir, { recursive: true });
  });

  afterEach(() => {
    tempRepo.cleanup();
  });

  it('rejects forbidden system directories (/etc, /var, /usr, /root)', () => {
    expect(() => assertPathInDemoData('/etc/shadow', tempRepo.repoRoot)).toThrow(/Safety Boundary Violation|Safety Violation/);
    expect(() => assertPathInDemoData('/var/log', tempRepo.repoRoot)).toThrow(/Safety Boundary Violation|Safety Violation/);
    expect(() => assertPathInDemoData('/usr/bin', tempRepo.repoRoot)).toThrow(/Safety Boundary Violation|Safety Violation/);
    expect(() => assertPathInDemoData('/root/.ssh', tempRepo.repoRoot)).toThrow(/Safety Boundary Violation|Safety Violation/);
  });

  it('rejects user production paths (~/happyclaw, ~/.dsh, ~/.ssh, ~/.aws)', () => {
    const userHome = homedir();
    expect(() => assertPathInDemoData(join(userHome, 'happyclaw', 'data'), tempRepo.repoRoot)).toThrow();
    expect(() => assertPathInDemoData(join(userHome, '.dsh', 'config'), tempRepo.repoRoot)).toThrow();
    expect(() => assertPathInDemoData(join(userHome, '.ssh', 'id_rsa'), tempRepo.repoRoot)).toThrow();
    expect(() => assertPathInDemoData(join(userHome, '.aws', 'credentials'), tempRepo.repoRoot)).toThrow();
  });

  it('rejects relative traversal outside demo data (../../etc/passwd)', () => {
    expect(() => assertPathInDemoData(join(paths.demoDataDir, '..', 'package.json'), tempRepo.repoRoot)).toThrow(
      /Safety Boundary Violation/
    );
    expect(() => assertPathInDemoData(join(paths.demoDataDir, '..', '..', '..', 'etc', 'passwd'), tempRepo.repoRoot)).toThrow(
      /Safety Boundary Violation/
    );
  });

  it('detects and blocks symlink breakout inside .demo-data', () => {
    const symlinkPath = join(paths.demoDataDir, 'breakout-symlink');
    const externalTarget = '/tmp';

    try {
      if (existsSync(symlinkPath)) rmSync(symlinkPath, { force: true });
      symlinkSync(externalTarget, symlinkPath, 'dir');

      expect(() => assertPathInDemoData(join(symlinkPath, 'test.txt'), tempRepo.repoRoot)).toThrow(
        /Symlink breakout detected/
      );
    } finally {
      if (existsSync(symlinkPath)) {
        rmSync(symlinkPath, { force: true });
      }
    }
  });
});
