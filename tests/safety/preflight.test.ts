import { describe, it, expect } from 'vitest';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import {
  findRepoRoot,
  getCanonicalDemoDataDir,
  isForbiddenPath,
  validateDemoDataPath,
  validateSafePath,
  runPreflightChecks,
  assertPreflight,
} from '../../scripts/safety/preflight.js';
import { SafetyViolationError } from '../../scripts/safety/errors.js';

describe('Preflight Safety Module', () => {
  const repoRoot = findRepoRoot();

  describe('findRepoRoot & getCanonicalDemoDataDir', () => {
    it('locates the enkeep repository root containing package.json with name enkeep-root', () => {
      expect(repoRoot).toBeDefined();
      expect(repoRoot.endsWith('enkeep')).toBe(true);
    });

    it('returns the canonical .demo-data path inside repo root', () => {
      const demoDir = getCanonicalDemoDataDir(repoRoot);
      expect(demoDir).toBe(join(repoRoot, '.demo-data'));
    });
  });

  describe('isForbiddenPath & Repository Boundary Isolation', () => {
    it('detects external happyclaw production data paths as forbidden', () => {
      const externalPaths = [
        '/Users/<user>/happyclaw/data',
        '/Users/<user>/happyclaw/data/messages.db',
        join(homedir(), 'happyclaw', 'data'),
        join(homedir(), 'happyclaw', 'data', 'messages.db'),
        join(homedir(), 'happyclaw', 'session.db'),
      ];

      for (const p of externalPaths) {
        const result = isForbiddenPath(p, repoRoot);
        expect(result.forbidden).toBe(true);
        expect(result.reason).toBeDefined();
      }
    });

    it('detects external DSH_HOME and .dsh data paths as forbidden', () => {
      const origDshHome = process.env.DSH_HOME;
      try {
        process.env.DSH_HOME = '/mock/dsh/home';
        expect(isForbiddenPath('/mock/dsh/home', repoRoot).forbidden).toBe(true);
        expect(isForbiddenPath('/mock/dsh/home/subfile.json', repoRoot).forbidden).toBe(true);
      } finally {
        if (origDshHome !== undefined) {
          process.env.DSH_HOME = origDshHome;
        } else {
          delete process.env.DSH_HOME;
        }
      }
    });

    it('detects external system paths (/etc/passwd, /var/run) as forbidden', () => {
      expect(isForbiddenPath('/etc/passwd', repoRoot).forbidden).toBe(true);
      expect(isForbiddenPath('/var/log', repoRoot).forbidden).toBe(true);
      expect(isForbiddenPath('/usr/local/bin', repoRoot).forbidden).toBe(true);
    });

    it('allows repository-internal fixtures named messages.db (e.g. packages/import/fixtures/messages.db)', () => {
      const fixturePath = join(repoRoot, 'packages', 'import', 'fixtures', 'messages.db');
      const result = isForbiddenPath(fixturePath, repoRoot);
      expect(result.forbidden).toBe(false);
    });

    it('allows documentation mentioning protected paths (docs/safety.md)', () => {
      const docPath = join(repoRoot, 'docs', 'safety.md');
      const result = isForbiddenPath(docPath, repoRoot);
      expect(result.forbidden).toBe(false);
    });

    it('allows demo data synthetic fixtures inside .demo-data (e.g. .demo-data/messages.db)', () => {
      const demoDbPath = join(repoRoot, '.demo-data', 'fixtures', 'messages.db');
      const result = isForbiddenPath(demoDbPath, repoRoot);
      expect(result.forbidden).toBe(false);
    });
  });

  describe('validateDemoDataPath', () => {
    it('accepts paths within .demo-data directory including fixture databases', () => {
      const validPath = join(repoRoot, '.demo-data', 'sessions', 'session-1.json');
      const validated = validateDemoDataPath(validPath, repoRoot);
      expect(validated).toBe(resolve(validPath));

      const validFixture = join(repoRoot, '.demo-data', 'fixtures', 'messages.db');
      const validatedFixture = validateDemoDataPath(validFixture, repoRoot);
      expect(validatedFixture).toBe(resolve(validFixture));
    });

    it('accepts relative paths that resolve into .demo-data', () => {
      const validRel = '.demo-data/pids/platform.json';
      const validated = validateDemoDataPath(validRel, repoRoot);
      expect(validated).toBe(resolve(repoRoot, validRel));
    });

    it('rejects paths outside .demo-data (e.g. system dirs, repo root files, parent dirs)', () => {
      expect(() => validateDemoDataPath('/etc/passwd', repoRoot)).toThrow(SafetyViolationError);
      expect(() => validateDemoDataPath('../outside-repo', repoRoot)).toThrow(SafetyViolationError);
      expect(() => validateDemoDataPath('package.json', repoRoot)).toThrow(SafetyViolationError);
      expect(() => validateDemoDataPath('/tmp/malicious.db', repoRoot)).toThrow(SafetyViolationError);
    });

    it('rejects external happyclaw production paths even if requested as demo data', () => {
      expect(() =>
        validateDemoDataPath('/Users/<user>/happyclaw/data/messages.db', repoRoot)
      ).toThrow(SafetyViolationError);
    });
  });

  describe('validateSafePath', () => {
    it('rejects forbidden external production paths', () => {
      expect(() => validateSafePath('/Users/<user>/happyclaw/data', repoRoot)).toThrow(
        SafetyViolationError
      );
      expect(() => validateSafePath(join(homedir(), 'happyclaw', 'data'), repoRoot)).toThrow(
        SafetyViolationError
      );
    });

    it('allows safe repository files, fixtures, and documentation', () => {
      expect(() => validateSafePath('scripts/safety/constants.ts', repoRoot)).not.toThrow();
      expect(() => validateSafePath('docs/safety.md', repoRoot)).not.toThrow();
      expect(() => validateSafePath('packages/import/fixtures/messages.db', repoRoot)).not.toThrow();
      expect(() => validateSafePath('.demo-data/test.db', repoRoot)).not.toThrow();
    });
  });

  describe('runPreflightChecks & assertPreflight', () => {
    it('passes standard clean repository preflight check', () => {
      const report = runPreflightChecks({ repoRoot });
      expect(report.ok).toBe(true);
      expect(report.errors).toHaveLength(0);
      expect(report.checks.length).toBeGreaterThanOrEqual(4);

      const checkNames = report.checks.map(c => c.name);
      expect(checkNames).toContain('repo_root_identification');
      expect(checkNames).toContain('demo_data_gitignored');
      expect(checkNames).toContain('host_binding_safety');
      expect(checkNames).toContain('reserved_ports_guard');
      expect(checkNames).toContain('demo_data_path_containment');
    });

    it('assertPreflight succeeds on clean configuration', () => {
      expect(() => assertPreflight({ repoRoot })).not.toThrow();
    });

    it('fails preflight if unsafe or non-exact-127 host is passed (e.g. 0.0.0.0, localhost, ::1)', () => {
      const reportZero = runPreflightChecks({ repoRoot, host: '0.0.0.0' });
      expect(reportZero.ok).toBe(false);
      expect(reportZero.errors.length).toBeGreaterThan(0);
      expect(reportZero.errors[0]).toContain('0.0.0.0');

      const reportLocalhost = runPreflightChecks({ repoRoot, host: 'localhost' });
      expect(reportLocalhost.ok).toBe(false);
      expect(reportLocalhost.errors.length).toBeGreaterThan(0);

      const reportIpv6 = runPreflightChecks({ repoRoot, host: '::1' });
      expect(reportIpv6.ok).toBe(false);
      expect(reportIpv6.errors.length).toBeGreaterThan(0);

      expect(() => assertPreflight({ repoRoot, host: '0.0.0.0' })).toThrow(
        SafetyViolationError
      );
      expect(() => assertPreflight({ repoRoot, host: 'localhost' })).toThrow(
        SafetyViolationError
      );
    });

    it('fails preflight if reserved port 3000 or 3080 is provided in ports list', () => {
      const report = runPreflightChecks({ repoRoot, ports: [3000, 3100] });
      expect(report.ok).toBe(false);
      expect(report.errors.some(e => e.includes('3000'))).toBe(true);
    });

    it('fails preflight if demoDataPath points outside boundary', () => {
      const report = runPreflightChecks({ repoRoot, demoDataPath: '/tmp/dangerous-data' });
      expect(report.ok).toBe(false);
      expect(report.errors.some(e => e.includes('contained inside') || e.includes('outside') || e.includes('forbidden'))).toBe(true);
    });

    it('fails preflight if targetPaths includes forbidden external happyclaw path', () => {
      const report = runPreflightChecks({
        repoRoot,
        targetPaths: ['/Users/<user>/happyclaw/data/messages.db'],
      });
      expect(report.ok).toBe(false);
      expect(report.errors.some(e => e.includes('forbidden') || e.includes('outside'))).toBe(true);
    });

    it('passes preflight when targetPaths includes safe repository fixture paths', () => {
      const report = runPreflightChecks({
        repoRoot,
        targetPaths: [
          'docs/safety.md',
          'packages/import/fixtures/messages.db',
          '.demo-data/fixtures/messages.db',
        ],
      });
      expect(report.ok).toBe(true);
      expect(report.errors).toHaveLength(0);
    });
  });
});
