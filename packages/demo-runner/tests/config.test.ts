import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findRepoRoot,
  getDemoPathConfig,
  assertPathInDemoData,
  validateResourceSuffix,
  getDefaultUsers,
  RESERVED_PROTECTED_PORTS,
  ALLOWED_HOSTS,
  FORBIDDEN_HOSTS,
} from '../src/config.js';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';

describe('Demo Runner Configuration & Paths', () => {
  let tempRepo: TempRepo;

  beforeEach(() => {
    tempRepo = createTempRepo();
  });

  afterEach(() => {
    tempRepo.cleanup();
  });

  it('finds valid enkeep repository root', () => {
    const realRoot = findRepoRoot();
    expect(realRoot).toBeDefined();
    expect(realRoot.endsWith('enkeep')).toBe(true);
  });

  it('returns canonical demo data layout paths strictly inside repo', () => {
    const paths = getDemoPathConfig(tempRepo.repoRoot);
    expect(paths.demoDataDir).toBe(join(tempRepo.repoRoot, '.demo-data'));
    expect(paths.pidsDir).toBe(join(tempRepo.repoRoot, '.demo-data', 'pids'));
    expect(paths.containersDir).toBe(join(tempRepo.repoRoot, '.demo-data', 'containers'));
    expect(paths.dbPath).toBe(join(tempRepo.repoRoot, '.demo-data', 'platform.db'));
    expect(paths.spacesDir).toBe(join(tempRepo.repoRoot, '.demo-data', 'spaces'));
    expect(paths.sessionsDir).toBe(join(tempRepo.repoRoot, '.demo-data', 'sessions'));
    expect(paths.importDir).toBe(join(tempRepo.repoRoot, '.demo-data', 'import'));
  });

  it('supports mode: test with absolute temporary dataRoot', () => {
    const tempDir = join(tmpdir(), 'custom-demo-test-data');
    const paths = getDemoPathConfig({
      repoRoot: tempRepo.repoRoot,
      dataRoot: tempDir,
      mode: 'test',
    });
    expect(paths.dataRoot).toBe(tempDir);
    expect(paths.dbPath).toBe(join(tempDir, 'platform.db'));
  });

  it('rejects external dataRoot in production mode', () => {
    expect(() =>
      getDemoPathConfig({
        repoRoot: tempRepo.repoRoot,
        dataRoot: '/tmp/forbidden-outside',
        mode: 'production',
      })
    ).toThrow(/Safety Violation: In production mode, dataRoot must resolve inside/);
  });

  it('assertPathInDemoData accepts paths inside .demo-data', () => {
    const valid = join(tempRepo.repoRoot, '.demo-data', 'pids', 'platform-server.json');
    expect(() => assertPathInDemoData(valid, tempRepo.repoRoot)).not.toThrow();
  });

  it('assertPathInDemoData rejects paths outside .demo-data', () => {
    expect(() => assertPathInDemoData('/etc/passwd', tempRepo.repoRoot)).toThrow(/Safety Boundary Violation/);
    expect(() => assertPathInDemoData('package.json', tempRepo.repoRoot)).toThrow(/Safety Boundary Violation/);
    expect(() => assertPathInDemoData('../outside', tempRepo.repoRoot)).toThrow(/Safety Boundary Violation/);
  });

  it('assertPathInDemoData rejects forbidden production directories', () => {
    expect(() => assertPathInDemoData('/Users/<user>/happyclaw/data', tempRepo.repoRoot)).toThrow();
  });

  it('validates resourceSuffix regex strictly', () => {
    expect(() => validateResourceSuffix('safe_suffix-123')).not.toThrow();
    expect(() => validateResourceSuffix('uuid-1234-5678-abcd')).not.toThrow();
    expect(() => validateResourceSuffix('bad suffix with space')).toThrow(/Safety Violation/);
    expect(() => validateResourceSuffix('../traversal')).toThrow(/Safety Violation/);
    expect(() => validateResourceSuffix('bad$char*')).toThrow(/Safety Violation/);
  });

  it('getDefaultUsers generates suffixed container and volume names', () => {
    const users = getDefaultUsers('rand123');
    const alice = users.find((u) => u.userId === 'alice');
    const bob = users.find((u) => u.userId === 'bob');

    expect(alice?.containerName).toBe('enkeep-demo-alice-rand123');
    expect(alice?.volumeName).toBe('enkeep-demo-dsh-alice-rand123');
    expect(bob?.containerName).toBe('enkeep-demo-bob-rand123');
    expect(bob?.volumeName).toBe('enkeep-demo-dsh-bob-rand123');
  });

  it('declares mandatory safety constants', () => {
    expect(RESERVED_PROTECTED_PORTS).toContain(3000);
    expect(RESERVED_PROTECTED_PORTS).toContain(3080);
    expect(ALLOWED_HOSTS).toEqual(['127.0.0.1']);
    expect(FORBIDDEN_HOSTS).toContain('0.0.0.0');
  });
});
