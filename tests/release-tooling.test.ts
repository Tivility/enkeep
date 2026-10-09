// @ts-nocheck
import { describe, it, expect } from 'vitest';
import {
  parseEnvFile,
  resolveDeployConfig,
  validateConfig,
  checkTreeMatch,
  updatePlistContent,
  computeNextReleaseId,
  sanitizePlistForLog,
  executeDeploy,
  executeRollback,
  executeVerify,
  parseEstablishedExternalConnections,
} from '../scripts/deploy-release.mjs';
import { planPruneWorktrees, executePrune } from '../scripts/prune-release-worktrees.mjs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('Deploy Tooling Enhancements', () => {
  describe('Parameterization & Validation', () => {
    it('fails validation when required parameters (PORT, PROXY_PORT, RUNTIME_IMAGE_PREFIX, CONTAINER_NAME_PREFIX) are missing', () => {
      expect(() => validateConfig({})).toThrow(/Missing required configuration/);
      expect(() => validateConfig({
        releaseId: 'batch1',
        repoRoot: '/tmp/repo',
        releaseRoot: '/tmp/releases',
        dataDir: '/tmp/data',
        configDir: '/tmp/config',
        plistPath: '/tmp/agent.plist',
        launchdLabel: 'com.example.app',
      })).toThrow(/PORT/);

      expect(() => validateConfig({
        releaseId: 'batch1',
        repoRoot: '/tmp/repo',
        releaseRoot: '/tmp/releases',
        dataDir: '/tmp/data',
        configDir: '/tmp/config',
        plistPath: '/tmp/agent.plist',
        launchdLabel: 'com.example.app',
        port: 3900,
        proxyPort: 3901,
        runtimeImagePrefix: 'enkeep-runtime:test-',
      })).toThrow(/CONTAINER_NAME_PREFIX/);
    });

    it('rejects forbidden system roots', () => {
      expect(() => validateConfig({
        releaseId: 'batch1',
        repoRoot: '/etc',
        releaseRoot: '/tmp/releases',
        dataDir: '/tmp/data',
        configDir: '/tmp/config',
        plistPath: '/tmp/agent.plist',
        launchdLabel: 'com.example.app',
        port: 3900,
        proxyPort: 3901,
        runtimeImagePrefix: 'enkeep-runtime:test-',
        containerNamePrefix: 'enkeep-test-',
      })).toThrow(/Safety violation/);
    });

    it('parses env files and splits TEST_CMDS', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-test-env-'));
      const envPath = path.join(tmpDir, 'test.env');
      fs.writeFileSync(envPath, [
        'RELEASE_ID=batch55',
        'PORT=3900',
        'PROXY_PORT=3901',
        'RUNTIME_IMAGE_PREFIX=enkeep-runtime:gap-',
        'CONTAINER_NAME_PREFIX=enkeep-',
        'REPO_ROOT="/tmp/test/repo"',
        'TEST_CMDS="pnpm --filter @enkeep/pkg1 test tests/a.test.ts; pnpm --filter @enkeep/pkg2 test tests/b.test.ts"',
      ].join('\n'));

      const parsed = parseEnvFile(envPath);
      expect(parsed.RELEASE_ID).toBe('batch55');
      expect(parsed.PORT).toBe('3900');
      expect(parsed.PROXY_PORT).toBe('3901');

      const config = resolveDeployConfig(['--env-file', envPath]);
      expect(config.testCmds).toEqual([
        'pnpm --filter @enkeep/pkg1 test tests/a.test.ts',
        'pnpm --filter @enkeep/pkg2 test tests/b.test.ts',
      ]);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('Batch ID Calculation', () => {
    it('computes next release batch number from git branch output', () => {
      const branchOutput = `
  origin/release/batch01
  origin/release/batch2
  origin/release/batch48
  origin/release/batch55
  release/batch12
`;
      const nextId = computeNextReleaseId('/dummy/repo', branchOutput);
      expect(nextId).toBe('batch56');
    });

    it('defaults to batch1 when no release/batch branches exist', () => {
      const nextId = computeNextReleaseId('/dummy/repo', '');
      expect(nextId).toBe('batch1');
    });
  });

  describe('Plist updates and redaction', () => {
    const samplePlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ENKEEP_RUNTIME_IMAGE</key>
    <string>enkeep-runtime:gap-batch54-oldsha</string>
    <key>SECRET_KEY</key>
    <string>super-secret-token</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/tmp/worktrees/release-worktree-batch54/packages/demo-runner/dist/demo-runner.js</string>
    <string>up</string>
  </array>
</dict>
</plist>`;

    it('only changes worktree path and runtime image tag in plist', () => {
      const updated = updatePlistContent(samplePlist, '/tmp/worktrees/release-worktree-batch55', 'enkeep-runtime:gap-batch55-newsha');
      expect(updated).toContain('/tmp/worktrees/release-worktree-batch55/packages/demo-runner/dist/demo-runner.js');
      expect(updated).toContain('enkeep-runtime:gap-batch55-newsha');
      expect(updated).toContain('<key>SECRET_KEY</key>');
      expect(updated).toContain('<string>super-secret-token</string>');
      expect(updated).not.toContain('batch54');
    });

    it('sanitizes EnvironmentVariables when preparing logs', () => {
      const sanitized = sanitizePlistForLog(samplePlist);
      expect(sanitized).not.toContain('super-secret-token');
      expect(sanitized).toContain('<!-- [REDACTED EnvironmentVariables] -->');
    });
  });

  describe('Dry-run & Plan Executions', () => {
    it('errors when no test-cmd given and skip-tests not set', async () => {
      const config = {
        releaseId: 'batch1',
        targetRef: 'origin/main',
        repoRoot: '/tmp/repo',
        releaseRoot: '/tmp/releases',
        dataDir: '/tmp/data',
        configDir: '/tmp/config',
        plistPath: '/tmp/agent.plist',
        launchdLabel: 'com.example.app',
        port: 3900,
        proxyPort: 3901,
        runtimeImagePrefix: 'enkeep-runtime:test-',
        containerNamePrefix: 'enkeep-test-',
        testCmds: [],
        skipTests: false,
        testedCommit: '',
        dryRun: true,
      };

      await expect(executeDeploy(config)).rejects.toThrow(/No test commands specified/);
    });

    it('executes dry-run deploy successfully when testCmds are provided', async () => {
      const config = {
        releaseId: 'batch99',
        targetRef: 'origin/main',
        repoRoot: '/tmp/repo',
        releaseRoot: '/tmp/releases',
        dataDir: '/tmp/data',
        configDir: '/tmp/config',
        plistPath: '/tmp/agent.plist',
        launchdLabel: 'com.example.app',
        port: 3900,
        proxyPort: 3901,
        runtimeImagePrefix: 'enkeep-runtime:test-',
        containerNamePrefix: 'enkeep-test-',
        testCmds: ['pnpm --filter @enkeep/test-pkg test'],
        skipTests: false,
        testedCommit: '',
        dryRun: true,
      };

      await expect(executeDeploy(config)).resolves.not.toThrow();
    });

    it('executes dry-run rollback and verify plans', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-test-rb-'));
      const snapshotsDir = path.join(tmpDir, 'snapshots');
      fs.mkdirSync(snapshotsDir);
      const fakeBackup = path.join(snapshotsDir, 'com.example.app.plist.pre-batch98-backup');
      fs.writeFileSync(fakeBackup, '<plist></plist>');

      const rollbackConfig = {
        configDir: tmpDir,
        plistPath: path.join(tmpDir, 'com.example.app.plist'),
        launchdLabel: 'com.example.app',
        dryRun: true,
      };

      await expect(executeRollback(rollbackConfig)).resolves.not.toThrow();

      const verifyConfig = {
        port: 3900,
        proxyPort: 3901,
        containerNamePrefix: 'enkeep-test-',
        plistPath: path.join(tmpDir, 'com.example.app.plist'),
        dataDir: tmpDir,
        dryRun: true,
      };

      await expect(executeVerify(verifyConfig)).resolves.not.toThrow();

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('P-03: Worktree Pruning & Protection', () => {
    it('prunes older worktrees while protecting the top N and active worktree', () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-test-prune-'));
      const repoDir = path.join(tmpRoot, 'repo');
      const releaseDir = path.join(tmpRoot, 'releases');
      fs.mkdirSync(repoDir);
      fs.mkdirSync(releaseDir);

      const wt1 = path.join(releaseDir, 'release-worktree-batch1');
      const wt2 = path.join(releaseDir, 'release-worktree-batch2');
      const wt3 = path.join(releaseDir, 'release-worktree-batch3');
      const wt4 = path.join(releaseDir, 'release-worktree-batch4');
      const wt5 = path.join(releaseDir, 'release-worktree-batch5');

      fs.mkdirSync(wt1);
      fs.mkdirSync(wt2);
      fs.mkdirSync(wt3);
      fs.mkdirSync(wt4);
      fs.mkdirSync(wt5);

      const now = Date.now() / 1000;
      fs.utimesSync(wt1, now - 500, now - 500);
      fs.utimesSync(wt2, now - 400, now - 400);
      fs.utimesSync(wt3, now - 300, now - 300);
      fs.utimesSync(wt4, now - 200, now - 200);
      fs.utimesSync(wt5, now - 100, now - 100);

      const plan = planPruneWorktrees({
        releaseRoot: releaseDir,
        repoRoot: repoDir,
        keep: 2,
        activeWorktree: wt1,
      });

      expect(plan.totalFound).toBe(5);
      expect(plan.kept.map(k => k.name).sort()).toEqual(['release-worktree-batch1', 'release-worktree-batch4', 'release-worktree-batch5']);
      expect(plan.pruned.map(p => p.name).sort()).toEqual(['release-worktree-batch2', 'release-worktree-batch3']);

      const dryResult = executePrune(plan, true);
      expect(dryResult.prunedCount).toBe(2);
      expect(dryResult.actions.length).toBe(2);
      expect(fs.existsSync(wt2)).toBe(true);

      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });
  });

  describe('P-04: Tree Comparison Optimization', () => {
    it('returns false when testedCommit is empty', () => {
      expect(checkTreeMatch('/tmp', 'origin/main', '')).toBe(false);
    });
  });

  describe('External Connection Parsing', () => {
    it('accurately parses established external connections and ignores loopback connections', () => {
      const syntheticLsofOutput = [
        'COMMAND   PID     USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
        'node    12345 user   57u  IPv4 0x3e700e357ba9f1ef      0t0  TCP 192.168.1.50:55771->43.163.179.90:443 (ESTABLISHED)',
        'node    12345 user   58u  IPv4 0xebfb7dbdf6d9a0f1      0t0  TCP 192.168.1.50:55777->43.163.165.187:443 (ESTABLISHED)',
        'node    12345 user   59u  IPv4 0x7eb87656604c7712      0t0  TCP 127.0.0.1:55000->127.0.0.1:3900 (ESTABLISHED)',
        'node    12345 user   60u  IPv6 0x7eb87656604c7713      0t0  TCP [::1]:55000->[::1]:3900 (ESTABLISHED)',
        'node    12345 user   61u  IPv4 0x5459ba42fe07f073      0t0  TCP 127.0.0.1:55001->localhost:3900 (ESTABLISHED)',
        'node    12345 user   67u  IPv4 0xec0076c9c3fa477c      0t0  TCP 192.168.1.50:55010->34.120.84.45:443 (ESTABLISHED)',
        'node    12345 user   71u  IPv4 0xec0076c9c3fa477d      0t0  TCP 192.168.1.50:55011->34.120.84.45:443 (CLOSE_WAIT)',
      ].join('\n');

      const count = parseEstablishedExternalConnections(syntheticLsofOutput);
      expect(count).toBe(3); // 2 to 43.* + 1 to 34.*, ignoring loopbacks and non-ESTABLISHED
    });

    it('returns 0 for empty or invalid output', () => {
      expect(parseEstablishedExternalConnections('')).toBe(0);
      expect(parseEstablishedExternalConnections(null as any)).toBe(0);
    });
  });
});
