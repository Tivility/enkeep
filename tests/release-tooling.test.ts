// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
  classifyChanges,
  extractAssetsFromIndexHtml,
  extractWorktreePathFromPlist,
  setRuntimeTargetVersionInDb,
  executeRuntimeDeploy,
  executePlatformDeploy,
  formatUtcTimestamp,
  findLatestPlistBackup,
  verifyContainers,
  buildRestartPlatformCommands,
  findPlistEntry,
  extractProgramArguments,
  convertPlistToEnkeepServer,
  DEFAULT_PREFLIGHT_TIMEOUT_SECONDS,
  DEFAULT_PREFLIGHT_INTERVAL_SECONDS,
  fetchSelfCheck,
  printSelfCheckSummary,
  readSelfCheckToken,
  selfCheckProblems,
  SelfCheckError,
} from '../scripts/deploy-release.mjs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
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

    const legacyPlist = samplePlist.replace(
      '<string>up</string>',
      '<string>up</string>\n    <string>--port</string>\n    <string>39001</string>\n    <string>--allow-host</string>\n    <string>--repo-root</string>\n    <string>/tmp/checkout</string>'
    );

    it('finds the legacy demo-runner entry and the enkeep-server entry', () => {
      expect(findPlistEntry(legacyPlist)).toEqual({
        kind: 'demo-runner',
        rel: 'packages/demo-runner/dist/demo-runner.js',
        path: '/tmp/worktrees/release-worktree-batch54/packages/demo-runner/dist/demo-runner.js',
      });
      const converted = convertPlistToEnkeepServer(legacyPlist, '/tmp/worktrees/release-worktree-batch60', '/tmp/enkeep-data');
      expect(findPlistEntry(converted)?.kind).toBe('enkeep-server');
      expect(extractWorktreePathFromPlist(converted)).toBe('/tmp/worktrees/release-worktree-batch60');
    });

    it('converts ProgramArguments to enkeep-server serve, keeping options and the environment', () => {
      const converted = convertPlistToEnkeepServer(legacyPlist, '/tmp/worktrees/release-worktree-batch60', '/tmp/enkeep-data');
      expect(extractProgramArguments(converted)).toEqual([
        '/opt/homebrew/bin/node',
        '/tmp/worktrees/release-worktree-batch60/packages/enkeep-server/dist/enkeep-server.js',
        'serve',
        '--data-dir', '/tmp/enkeep-data',
        '--port', '39001',
        '--allow-host',
        '--repo-root', '/tmp/worktrees/release-worktree-batch60',
      ]);
      expect(converted).toContain('<string>super-secret-token</string>');
      expect(converted).not.toContain('demo-runner');
    });

    it('keeps the entry kind when a later release updates an enkeep-server plist', () => {
      const converted = convertPlistToEnkeepServer(legacyPlist, '/tmp/worktrees/release-worktree-batch60', '/tmp/enkeep-data');
      const next = updatePlistContent(converted, '/tmp/worktrees/release-worktree-batch61', 'enkeep-runtime:gap-batch61-sha');
      expect(extractProgramArguments(next).slice(0, 5)).toEqual([
        '/opt/homebrew/bin/node',
        '/tmp/worktrees/release-worktree-batch61/packages/enkeep-server/dist/enkeep-server.js',
        'serve',
        '--data-dir', '/tmp/enkeep-data',
      ]);
      expect(next).toContain('enkeep-runtime:gap-batch61-sha');
    });

    const serverPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>ENKEEP_RUNTIME_IMAGE</key>
\t\t<string>enkeep-runtime:gap-batch70-oldsha</string>
\t\t<key>SECRET_KEY</key>
\t\t<string>super-secret-token</string>
\t</dict>
\t<key>Label</key>
\t<string>test.enkeep.label</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/opt/homebrew/bin/node</string>
\t\t<string>/tmp/enkeep-test/research/release-worktree-batch70/packages/enkeep-server/dist/enkeep-server.js</string>
\t\t<string>serve</string>
\t\t<string>--data-dir</string>
\t\t<string>/tmp/enkeep-test/data</string>
\t\t<string>--port</string>
\t\t<string>39001</string>
\t\t<string>--repo-root</string>
\t\t<string>/tmp/enkeep-test/research/release-worktree-batch70</string>
\t</array>
\t<key>WorkingDirectory</key>
\t<string>/tmp/enkeep-test/dev-checkout</string>
</dict>
</plist>`;

    it('moves --repo-root and WorkingDirectory of an enkeep-server plist to the new release worktree', () => {
      const next = updatePlistContent(serverPlist, '/tmp/enkeep-test/releases/release-worktree-batch71', 'enkeep-runtime:gap-batch71-newsha');
      expect(extractProgramArguments(next)).toEqual([
        '/opt/homebrew/bin/node',
        '/tmp/enkeep-test/releases/release-worktree-batch71/packages/enkeep-server/dist/enkeep-server.js',
        'serve',
        '--data-dir', '/tmp/enkeep-test/data',
        '--port', '39001',
        '--repo-root', '/tmp/enkeep-test/releases/release-worktree-batch71',
      ]);
      expect(next).toContain('<key>WorkingDirectory</key>\n\t<string>/tmp/enkeep-test/releases/release-worktree-batch71</string>');
      expect(next).not.toContain('/tmp/enkeep-test/research');
      expect(next).not.toContain('/tmp/enkeep-test/dev-checkout');
      expect(next).toContain('enkeep-runtime:gap-batch71-newsha');
      expect(next).toContain('<string>super-secret-token</string>');
      expect(next).toContain('<string>test.enkeep.label</string>');
      expect(next.match(/<key>WorkingDirectory<\/key>/g)).toHaveLength(1);
    });

    it('adds a WorkingDirectory to an enkeep-server plist that has none', () => {
      const withoutCwd = serverPlist.replace('\t<key>WorkingDirectory</key>\n\t<string>/tmp/enkeep-test/dev-checkout</string>\n', '');
      expect(withoutCwd).not.toContain('WorkingDirectory');
      const next = updatePlistContent(withoutCwd, '/tmp/enkeep-test/releases/release-worktree-batch71', 'enkeep-runtime:gap-batch71-newsha');
      expect(next).toContain('\t<key>WorkingDirectory</key>\n\t<string>/tmp/enkeep-test/releases/release-worktree-batch71</string>\n\t<key>ProgramArguments</key>');
      expect(extractProgramArguments(next)).toContain('/tmp/enkeep-test/releases/release-worktree-batch71');
    });

    it('leaves the plist alone when an enkeep-server plist has no --repo-root', () => {
      const withoutRepoRoot = serverPlist.replace('\t\t<string>--repo-root</string>\n\t\t<string>/tmp/enkeep-test/research/release-worktree-batch70</string>\n', '');
      const next = updatePlistContent(withoutRepoRoot, '/tmp/enkeep-test/releases/release-worktree-batch71', 'enkeep-runtime:gap-batch71-newsha');
      expect(extractProgramArguments(next)).not.toContain('--repo-root');
      expect(extractProgramArguments(next)).toHaveLength(7);
    });

    it('keeps --repo-root and WorkingDirectory of a legacy demo-runner plist', () => {
      const legacyWithCwd = legacyPlist.replace('</dict>\n</plist>', '  <key>WorkingDirectory</key>\n  <string>/tmp/checkout</string>\n</dict>\n</plist>');
      const next = updatePlistContent(legacyWithCwd, '/tmp/worktrees/release-worktree-batch55', 'enkeep-runtime:gap-batch55-newsha');
      expect(extractProgramArguments(next)).toContain('/tmp/checkout');
      expect(next).toContain('<key>WorkingDirectory</key>\n  <string>/tmp/checkout</string>');
      expect(next).toContain('/tmp/worktrees/release-worktree-batch55/packages/demo-runner/dist/demo-runner.js');
    });

    it('requires a distinct new data directory for --only migrate-data-dir', () => {
      const base = {
        releaseId: 'batch60', repoRoot: '/tmp/r', releaseRoot: '/tmp/rel', dataDir: '/tmp/d', configDir: '/tmp/c',
        plistPath: '/tmp/p.plist', launchdLabel: 'test.label', port: 39001, proxyPort: 39002,
        runtimeImagePrefix: 'enkeep-runtime:gap-', containerNamePrefix: 'enkeep-', only: 'migrate-data-dir',
      };
      expect(() => validateConfig(base)).toThrow(/newDataDir/);
      expect(() => validateConfig({ ...base, newDataDir: '/tmp/d' })).toThrow(/must differ/);
      expect(() => validateConfig({ ...base, newDataDir: '/etc/enkeep' })).toThrow(/forbidden/);
      expect(() => validateConfig({ ...base, newDataDir: '/tmp/new-data' })).not.toThrow();
      expect(() => validateConfig({ ...base, newDataDir: '/tmp/new-data', backupDir: '/usr/backup' })).toThrow(/backupDir/);
    });

    it('reads the backup directory and before-start hook for a migration', () => {
      const config = resolveDeployConfig(['--only', 'migrate-data-dir', '--new-data-dir', '/tmp/n', '--backup-dir', '/tmp/b', '--before-start', 'echo hook']);
      expect(config.newDataDir).toBe('/tmp/n');
      expect(config.backupDir).toBe('/tmp/b');
      expect(config.beforeStart).toBe('echo hook');
    });

    it('sanitizes EnvironmentVariables when preparing logs', () => {
      const sanitized = sanitizePlistForLog(samplePlist);
      expect(sanitized).not.toContain('super-secret-token');
      expect(sanitized).toContain('<!-- [REDACTED EnvironmentVariables] -->');
    });
  });

  describe('Dry-run & Plan Executions', () => {
    it('errors when no test-cmd given and skip-tests not set in platform/full deploy', async () => {
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
        mode: 'full',
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

    describe('Snapshot & Backup Timestamps and Rollback Selection', () => {
      it('formats UTC timestamp in YYYYMMDDTHHMMSSZ format', () => {
        const fixedDate = new Date('2026-10-09T14:30:45.000Z');
        expect(formatUtcTimestamp(fixedDate)).toBe('20261009T143045Z');
        expect(formatUtcTimestamp()).toMatch(/^\d{8}T\d{6}Z$/);
      });

      it('correctly selects the latest plist backup among mixed legacy and timestamp-suffixed backups', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-test-plist-bk-'));
        const snapshotsDir = path.join(tmpDir, 'snapshots');
        fs.mkdirSync(snapshotsDir);
        const label = 'com.example.app';

        // 1. Legacy backup from older batch
        const legacyOld = path.join(snapshotsDir, `${label}.plist.pre-batch1-backup`);
        fs.writeFileSync(legacyOld, '<plist>batch1</plist>');

        // 2. Timestamped backup 1 (e.g. 2026-10-09 10:00:00 UTC)
        const ts1 = path.join(snapshotsDir, `${label}.plist.pre-batch2-20261009T100000Z-backup`);
        fs.writeFileSync(ts1, '<plist>batch2-ts1</plist>');

        // 3. Timestamped backup 2 (e.g. 2026-10-09 12:00:00 UTC - later)
        const ts2 = path.join(snapshotsDir, `${label}.plist.pre-batch2-20261009T120000Z-backup`);
        fs.writeFileSync(ts2, '<plist>batch2-ts2</plist>');

        // 4. Timestamped backup 3 (e.g. 2026-10-09 11:00:00 UTC - between ts1 and ts2)
        const ts3 = path.join(snapshotsDir, `${label}.plist.pre-batch2-20261009T110000Z-backup`);
        fs.writeFileSync(ts3, '<plist>batch2-ts3</plist>');

        // Set mtime explicitly to simulate file modifications
        const legacyTimeSec = Date.parse('2026-10-08T00:00:00Z') / 1000;
        fs.utimesSync(legacyOld, legacyTimeSec, legacyTimeSec);
        const ts1Sec = Date.parse('2026-10-09T10:00:00Z') / 1000;
        fs.utimesSync(ts1, ts1Sec, ts1Sec);
        const ts2Sec = Date.parse('2026-10-09T12:00:00Z') / 1000;
        fs.utimesSync(ts2, ts2Sec, ts2Sec);
        const ts3Sec = Date.parse('2026-10-09T11:00:00Z') / 1000;
        fs.utimesSync(ts3, ts3Sec, ts3Sec);

        const latest = findLatestPlistBackup(tmpDir, label);
        expect(latest).toBe(ts2);

        // If a new legacy backup is created with newer mtime (e.g. 2026-10-09 15:00:00 UTC)
        const legacyNew = path.join(snapshotsDir, `${label}.plist.pre-batch3-backup`);
        fs.writeFileSync(legacyNew, '<plist>batch3-legacy</plist>');
        const legacyNewSec = Date.parse('2026-10-09T15:00:00Z') / 1000;
        fs.utimesSync(legacyNew, legacyNewSec, legacyNewSec);

        const latestAfterLegacy = findLatestPlistBackup(tmpDir, label);
        expect(latestAfterLegacy).toBe(legacyNew);

        fs.rmSync(tmpDir, { recursive: true, force: true });
      });
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

  describe('Split Upgrade Classification & Frontend Deploy', () => {
    describe('classifyChanges', () => {
      it('classifies packages/web-ui changes as frontend only', () => {
        const changes = [
          'packages/web-ui/src/static/app.js',
          'packages/web-ui/src/static/style.css',
          'packages/web-ui/src/static/index.html',
        ];
        const res = classifyChanges(changes);
        expect(res).toEqual({
          frontend: true,
          runtime: false,
          platform: false,
        });
      });

      it('classifies in-runtime-only dsh-* and docker/ changes as runtime', () => {
        const changes = [
          'packages/dsh-settings/src/index.ts',
          'docker/Dockerfile.runtime',
        ];
        const res = classifyChanges(changes);
        expect(res).toEqual({
          frontend: false,
          runtime: true,
          platform: false,
        });
      });

      it('also restarts the platform for runtime packages the platform process loads', () => {
        for (const p of [
          'packages/runtime-runner/src/host/security.ts',
          'packages/runtime-runner/src/runtime/daemon-cli.ts',
          'packages/dsh-tool-cli/src/index.ts',
        ]) {
          expect(classifyChanges([p])).toEqual({ frontend: false, runtime: true, platform: true });
        }
      });

      it('classifies server, channel, and demo-runner changes as platform', () => {
        const changes = [
          'packages/platform-server/src/server/handler.ts',
          'packages/channel-feishu/src/index.ts',
          'packages/web-channel/src/handler.ts',
          'packages/demo-runner/src/up/index.ts',
        ];
        const res = classifyChanges(changes);
        expect(res).toEqual({
          frontend: false,
          runtime: false,
          platform: true,
        });
      });

      it('conservatively classifies unclassified/unmatched paths as platform', () => {
        const changes = [
          'docs/readme.md',
          'scripts/custom-script.sh',
          'random-unmatched-file.txt',
        ];
        const res = classifyChanges(changes);
        expect(res).toEqual({
          frontend: false,
          runtime: false,
          platform: true,
        });
      });

      it('classifies lockfile changes touching @deepseek-ai/@tivility as runtime, else platform', () => {
        // Lockfile with @deepseek-ai change
        const diffWithDeepseek = `
@@ -10,3 +10,3 @@
-  '@deepseek-ai/dsh-settings': 0.2.0-rc.1
+  '@deepseek-ai/dsh-settings': 0.2.0-rc.2
`;
        const res1 = classifyChanges(['pnpm-lock.yaml'], { lockfileDiff: diffWithDeepseek });
        expect(res1).toEqual({
          frontend: false,
          runtime: true,
          platform: false,
        });

        // Lockfile without @deepseek-ai/@tivility (e.g. lodash upgrade)
        const diffOther = `
@@ -100,3 +100,3 @@
-  lodash: 4.17.20
+  lodash: 4.17.21
`;
        const res2 = classifyChanges(['pnpm-lock.yaml'], { lockfileDiff: diffOther });
        expect(res2).toEqual({
          frontend: false,
          runtime: false,
          platform: true,
        });

        // Lockfile without diff string provided -> conservative platform
        const res3 = classifyChanges(['pnpm-lock.yaml']);
        expect(res3).toEqual({
          frontend: false,
          runtime: false,
          platform: true,
        });
      });

      it('correctly flags multiple categories when mixed changes exist', () => {
        const changes = [
          'packages/web-ui/src/static/app.js',
          'packages/runtime-runner/src/host/adapter.ts',
          'packages/platform-server/src/server/handler.ts',
        ];
        const res = classifyChanges(changes);
        expect(res).toEqual({
          frontend: true,
          runtime: true,
          platform: true,
        });
      });
    });

    describe('Frontend Deploy & Dry-run Plan', () => {
      it('extracts script and stylesheet assets correctly from index.html', () => {
        const sampleHtml = `
<!DOCTYPE html>
<html>
<head>
  <script src="/static/theme-bootstrap.js?v=9c6909a9c62f"></script>
  <link rel="stylesheet" href="/static/style.css?v=e9219aaa0f95">
  <link rel="icon" href="/favicon.ico">
  <script src="https://cdn.example.com/ext.js"></script>
</head>
<body>
  <script type="module" src="/static/app.js?v=a86127bf9a0b"></script>
</body>
</html>
`;
        const assets = extractAssetsFromIndexHtml(sampleHtml);
        expect(assets).toEqual([
          '/static/theme-bootstrap.js?v=9c6909a9c62f',
          '/static/app.js?v=a86127bf9a0b',
          '/static/style.css?v=e9219aaa0f95',
          '/favicon.ico',
        ]);
      });

      it('executes dry-run frontend deploy successfully without errors', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-test-fe-'));
        const fakeWorktree = path.join(tmpDir, 'release-worktree-batch57');
        fs.mkdirSync(path.join(fakeWorktree, 'packages/demo-runner/dist'), { recursive: true });
        fs.writeFileSync(path.join(fakeWorktree, 'packages/demo-runner/dist/demo-runner.js'), '// runner');

        const fakePlist = path.join(tmpDir, 'com.example.app.plist');
        fs.writeFileSync(fakePlist, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>ProgramArguments</key>
  <array>
    <string>${path.join(fakeWorktree, 'packages/demo-runner/dist/demo-runner.js')}</string>
  </array>
</dict>
</plist>`);

        const config = {
          only: 'frontend',
          plistPath: fakePlist,
          port: 3900,
          baseRef: 'HEAD',
          targetRef: 'HEAD',
          repoRoot: fakeWorktree,
          dryRun: true,
        };

        await expect(executeDeploy(config)).resolves.toBeDefined();

        fs.rmSync(tmpDir, { recursive: true, force: true });
      });

      it('writes .frontend-commit marker inside dist/static and fails verification if marker is absent', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-test-fe-marker-'));
        const staticDir = path.join(tmpDir, 'static');
        fs.mkdirSync(staticDir, { recursive: true });
        fs.writeFileSync(path.join(staticDir, 'index.html'), '<html><body>Hello</body></html>');

        // Without .frontend-commit, check that error is thrown when verifying
        const commitMarkerPath = path.join(staticDir, '.frontend-commit');
        expect(fs.existsSync(commitMarkerPath)).toBe(false);

        // When written into dist/static
        const fakeCommit = '0123456789abcdef0123456789abcdef01234567';
        fs.writeFileSync(commitMarkerPath, fakeCommit + '\n', 'utf8');
        expect(fs.existsSync(commitMarkerPath)).toBe(true);
        expect(fs.readFileSync(commitMarkerPath, 'utf8').trim()).toBe(fakeCommit);

        fs.rmSync(tmpDir, { recursive: true, force: true });
      });
    });

    describe('Runtime & Platform Deploy Plans', () => {
      it('persists target version directly in sqlite database via setRuntimeTargetVersionInDb', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-test-db-'));
        const dbPath = path.join(tmpDir, 'platform.db');
        const { DatabaseSync } = require('node:sqlite');
        const setupDb = new DatabaseSync(dbPath);
        setupDb.exec(`
          CREATE TABLE runtime_target_version (
            id TEXT PRIMARY KEY DEFAULT 'default',
            image TEXT,
            daemon_cli_path TEXT,
            updated_by TEXT,
            updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
          );
        `);
        setupDb.close();
        
        setRuntimeTargetVersionInDb(dbPath, 'enkeep-runtime:test-tag-v1', '/fake/worktree/packages/runtime-runner/dist/runtime/daemon-cli.js');
        
        // Verify persisted content
        const db = new DatabaseSync(dbPath);
        const row = db.prepare('SELECT id, image, daemon_cli_path, updated_by FROM runtime_target_version WHERE id = ?').get('default');
        expect(row.id).toBe('default');
        expect(row.image).toBe('enkeep-runtime:test-tag-v1');
        expect(row.daemon_cli_path).toBe('/fake/worktree/packages/runtime-runner/dist/runtime/daemon-cli.js');
        expect(row.updated_by).toBeNull();
        db.close();

        fs.rmSync(tmpDir, { recursive: true, force: true });
      });

      it('enforces foreign key constraints and persists target version with NULL or valid user updated_by', async () => {
        const { DatabaseSync } = require('node:sqlite');
        const { ALL_PLATFORM_MIGRATIONS, PlatformServerMigrationRunner } = await import('../packages/platform-server/src/storage/migrations.js');
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-test-fk-'));
        const dbPath = path.join(tmpDir, 'platform.db');

        // Migrate temporary database using platform server migrations with foreign keys enabled
        const initDb = new DatabaseSync(dbPath);
        initDb.exec('PRAGMA foreign_keys = ON;');
        const runner = new PlatformServerMigrationRunner(initDb);
        await runner.migrate(ALL_PLATFORM_MIGRATIONS);
        initDb.close();

        // 1. Calling setRuntimeTargetVersionInDb on migrated DB with FK enabled should succeed with null updated_by
        setRuntimeTargetVersionInDb(
          dbPath,
          'enkeep-runtime:test-tag-fk',
          '/fake/worktree/packages/runtime-runner/dist/runtime/daemon-cli.js'
        );

        const verifyDb = new DatabaseSync(dbPath);
        verifyDb.exec('PRAGMA foreign_keys = ON;');
        const rowNullUser = verifyDb.prepare('SELECT id, image, daemon_cli_path, updated_by FROM runtime_target_version WHERE id = ?').get('default');
        expect(rowNullUser.id).toBe('default');
        expect(rowNullUser.image).toBe('enkeep-runtime:test-tag-fk');
        expect(rowNullUser.daemon_cli_path).toBe('/fake/worktree/packages/runtime-runner/dist/runtime/daemon-cli.js');
        expect(rowNullUser.updated_by).toBeNull();

        // 2. Writing an invalid non-existent foreign key user id with FK enabled should fail
        expect(() => {
          setRuntimeTargetVersionInDb(
            dbPath,
            'enkeep-runtime:test-tag-fk-fail',
            null,
            'non-existent-user-id'
          );
        }).toThrow(/FOREIGN KEY/i);

        // 3. Insert a synthetic user and verify setRuntimeTargetVersionInDb succeeds with valid user id
        verifyDb.prepare(`
          INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
          VALUES ('user-test-admin', 'test-admin', 'hash', 'admin', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).run();
        verifyDb.close();

        setRuntimeTargetVersionInDb(
          dbPath,
          'enkeep-runtime:test-tag-fk-user',
          '/fake/worktree/packages/runtime-runner/dist/runtime/daemon-cli.js',
          'user-test-admin'
        );

        const verifyDb2 = new DatabaseSync(dbPath);
        verifyDb2.exec('PRAGMA foreign_keys = ON;');
        const rowWithUser = verifyDb2.prepare('SELECT id, image, daemon_cli_path, updated_by FROM runtime_target_version WHERE id = ?').get('default');
        expect(rowWithUser.image).toBe('enkeep-runtime:test-tag-fk-user');
        expect(rowWithUser.updated_by).toBe('user-test-admin');
        verifyDb2.close();

        fs.rmSync(tmpDir, { recursive: true, force: true });
      });

      it('executes dry-run runtime deploy plan successfully', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-test-rt-'));
        const fakeWorktree = path.join(tmpDir, 'release-worktree-batch57');
        fs.mkdirSync(path.join(fakeWorktree, 'packages/demo-runner/dist'), { recursive: true });
        fs.writeFileSync(path.join(fakeWorktree, 'packages/demo-runner/dist/demo-runner.js'), '// runner');

        const fakePlist = path.join(tmpDir, 'com.example.app.plist');
        fs.writeFileSync(fakePlist, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>ProgramArguments</key>
  <array>
    <string>${path.join(fakeWorktree, 'packages/demo-runner/dist/demo-runner.js')}</string>
  </array>
</dict>
</plist>`);

        const config = {
          only: 'runtime',
          releaseId: 'batch57',
          plistPath: fakePlist,
          dataDir: tmpDir,
          port: 3900,
          runtimeImagePrefix: 'enkeep-runtime:gap-',
          baseRef: 'HEAD',
          targetRef: 'HEAD',
          repoRoot: fakeWorktree,
          dryRun: true,
        };

        await expect(executeDeploy(config)).resolves.toBeDefined();
        await expect(executeRuntimeDeploy(config)).resolves.toBeDefined();

        fs.rmSync(tmpDir, { recursive: true, force: true });
      });

      it('executes platform deploy plan in split mode without invoking container down', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-test-platform-'));
        const config = {
          releaseId: 'batch57',
          targetRef: 'HEAD',
          repoRoot: tmpDir,
          releaseRoot: tmpDir,
          dataDir: tmpDir,
          configDir: tmpDir,
          plistPath: path.join(tmpDir, 'agent.plist'),
          launchdLabel: 'com.example.app',
          port: 3900,
          proxyPort: 3901,
          runtimeImagePrefix: 'enkeep-runtime:test-',
          containerNamePrefix: 'enkeep-test-',
          testCmds: ['true'],
          dryRun: true,
          mode: 'split',
        };

        await expect(executePlatformDeploy(config, { mode: 'platform' })).resolves.toBeDefined();
        await expect(executeDeploy(config)).resolves.toBeDefined();

        fs.rmSync(tmpDir, { recursive: true, force: true });
      });

      it('routes multi-category changes sequentially (frontend -> runtime -> platform)', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-test-multi-'));
        const config = {
          releaseId: 'batch58',
          targetRef: 'HEAD',
          baseRef: 'HEAD',
          repoRoot: tmpDir,
          releaseRoot: tmpDir,
          dataDir: tmpDir,
          configDir: tmpDir,
          plistPath: path.join(tmpDir, 'agent.plist'),
          launchdLabel: 'com.example.app',
          port: 3900,
          proxyPort: 3901,
          runtimeImagePrefix: 'enkeep-runtime:test-',
          containerNamePrefix: 'enkeep-test-',
          testCmds: ['true'],
          dryRun: true,
        };

        // When changes is empty / dryRun
        await expect(executeDeploy(config)).resolves.toBeDefined();

        fs.rmSync(tmpDir, { recursive: true, force: true });
      });

      it('reuses release branch and worktree across steps in combined runtime + platform deploy without failing or duplicating setup/build/test/docker steps', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-test-combined-reuse-'));
        const fakeWorktree = path.join(tmpDir, 'release-worktree-batch59');
        fs.mkdirSync(path.join(fakeWorktree, 'packages/demo-runner/dist'), { recursive: true });
        fs.writeFileSync(path.join(fakeWorktree, 'packages/demo-runner/dist/demo-runner.js'), '// runner');

        const fakePlist = path.join(tmpDir, 'com.example.app.plist');
        fs.writeFileSync(fakePlist, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>ProgramArguments</key>
  <array>
    <string>${path.join(fakeWorktree, 'packages/demo-runner/dist/demo-runner.js')}</string>
  </array>
</dict>
</plist>`);

        const config = {
          releaseId: 'batch59',
          targetRef: 'HEAD',
          baseRef: 'HEAD',
          repoRoot: fakeWorktree,
          releaseRoot: tmpDir,
          dataDir: tmpDir,
          configDir: tmpDir,
          plistPath: fakePlist,
          launchdLabel: 'com.example.app',
          port: 3900,
          proxyPort: 3901,
          runtimeImagePrefix: 'enkeep-runtime:test-',
          containerNamePrefix: 'enkeep-test-',
          testCmds: ['true'],
          dryRun: true,
        };

        const logs = [];
        const originalLog = console.log;
        console.log = (...args) => {
          logs.push(args.join(' '));
          originalLog(...args);
        };

        try {
          await expect(
            executeDeploy(config, {
              classificationOverride: { frontend: false, runtime: true, platform: true },
            })
          ).resolves.toBeDefined();
        } finally {
          console.log = originalLog;
        }

        // Setup Release Branch and Worktree step and Install & Build step should only appear once (in Runtime step)
        const setupStepCount = logs.filter(l => l.includes('Setup Release Branch and Worktree') || l.includes('Setup release branch')).length;
        const buildStepCount = logs.filter(l => l.includes('Install & Build Worktree') || l.includes('Install dependencies and build worktree')).length;
        expect(setupStepCount).toBe(1);
        expect(buildStepCount).toBe(1);

        fs.rmSync(tmpDir, { recursive: true, force: true });
      });

      describe('verifyContainers in split and full modes', () => {
        it('full mode requires all matching containers to run target image', () => {
          const psOut = [
            'enkeep-test-user1\tenkeep-runtime:target-img\tUp 2 hours',
            'enkeep-test-user2\tenkeep-runtime:target-img\tUp 10 minutes',
          ].join('\n');
          expect(() => verifyContainers(psOut, 'enkeep-test-', 'enkeep-runtime:target-img', false)).not.toThrow();

          const psOutOutdated = [
            'enkeep-test-user1\tenkeep-runtime:target-img\tUp 2 hours',
            'enkeep-test-user2\tenkeep-runtime:old-img\tUp 10 minutes',
          ].join('\n');
          expect(() => verifyContainers(psOutOutdated, 'enkeep-test-', 'enkeep-runtime:target-img', false))
            .toThrow(/running image enkeep-runtime:old-img, expected enkeep-runtime:target-img/);
        });

        it('split mode only requires containers to be running and ignores outdated image', () => {
          const psOutOutdated = [
            'enkeep-test-user1\tenkeep-runtime:target-img\tUp 2 hours',
            'enkeep-test-user2\tenkeep-runtime:old-img\tUp 10 minutes',
          ].join('\n');
          // In split mode, outdated image should NOT throw
          expect(() => verifyContainers(psOutOutdated, 'enkeep-test-', 'enkeep-runtime:target-img', true)).not.toThrow();
        });

        it('split mode fails if any matching container is not running', () => {
          const psOutStopped = [
            'enkeep-test-user1\tenkeep-runtime:old-img\tUp 2 hours',
            'enkeep-test-user2\tenkeep-runtime:old-img\tExited (0) 5 minutes ago',
          ].join('\n');
          expect(() => verifyContainers(psOutStopped, 'enkeep-test-', 'enkeep-runtime:target-img', true))
            .toThrow(/is not in running state/);
        });

        it('split mode container check makes no HTTP call (runtime status is checked by executeVerify via the self-check)', () => {
          const psOut = 'enkeep-test-user1\tenkeep-runtime:old-img\tUp 3 hours';
          expect(() => verifyContainers(psOut, 'enkeep-test-', 'enkeep-runtime:target-img', true)).not.toThrow();
        });
      });
    });
  });

  describe('Quiescence wait defaults and platform restart', () => {
    it('waits up to 24 hours for quiescence by default', () => {
      const config = resolveDeployConfig([]);
      expect(DEFAULT_PREFLIGHT_TIMEOUT_SECONDS).toBe(86400);
      expect(config.preflightTimeoutSeconds).toBe(DEFAULT_PREFLIGHT_TIMEOUT_SECONDS);
      expect(config.preflightIntervalSeconds).toBe(DEFAULT_PREFLIGHT_INTERVAL_SECONDS);
    });

    it('restart-platform waits for quiescence before an in-place LaunchAgent restart', () => {
      const { preflightCmd, restartCmd } = buildRestartPlatformCommands(
        {
          dataDir: '/tmp/enkeep-test/data',
          port: 3900,
          preflightDueMinutes: 10,
          preflightTimeoutSeconds: 86400,
          preflightIntervalSeconds: 120,
          launchdLabel: 'com.example.enkeep',
        },
        '/tmp/enkeep-test/release/packages/demo-runner/dist/demo-runner.js'
      );
      expect(preflightCmd).toContain(' preflight ');
      expect(preflightCmd).toContain('--wait');
      expect(preflightCmd).toContain('--timeout-seconds 86400');
      expect(restartCmd).toBe('launchctl kickstart -k gui/$(id -u)/com.example.enkeep');
    });
  });

  describe('Platform self-check (GET /api/selfcheck with the data-dir token)', () => {
    const TOKEN = 'selfcheck-test-token-000000000000000000001';
    const REPORT = {
      status: 'ok',
      startedAt: '2026-01-01T00:00:00.000Z',
      uptimeSeconds: 5,
      health: { runtime: { available: true, status: 'available' }, operations: { producerAvailable: true, workerRunning: true } },
      migrations: { currentVersion: 45, latestVersion: 45, pendingVersions: [], upToDate: true },
      runtimeTarget: { image: 'enkeep-runtime:test-new', daemonCliPath: '/tmp/enkeep-test/new/daemon-cli.js' },
      runtimes: {
        total: 1,
        outdated: 1,
        items: [{ mode: 'container', current: 'enkeep-runtime:test-old', target: 'enkeep-runtime:test-new', isOutdated: true, isIdle: false, pendingReason: 'busy' }],
      },
    };

    type FakeOptions = { status?: number; body?: unknown };
    type Seen = { path: string; method: string; token?: string; cookie?: string };

    async function startFakePlatform(opts: FakeOptions = {}) {
      const seen: Seen[] = [];
      const server = http.createServer((req, res) => {
        const p = (req.url || '').split('?')[0];
        seen.push({ path: p, method: req.method || 'GET', token: req.headers['x-enkeep-selfcheck-token'] as string | undefined, cookie: req.headers.cookie });
        const send = (code: number, payload: unknown) => {
          res.writeHead(code, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if (p !== '/api/selfcheck') return send(404, { success: false, error: { code: 'NOT_FOUND' } });
        if (opts.status && opts.status !== 200) {
          return send(opts.status, { success: false, error: { code: opts.status === 401 ? 'UNAUTHORIZED' : opts.status === 403 ? 'FORBIDDEN' : 'NOT_FOUND' } });
        }
        if (req.headers['x-enkeep-selfcheck-token'] !== TOKEN) return send(401, { success: false, error: { code: 'UNAUTHORIZED' } });
        send(200, opts.body ?? { success: true, data: REPORT });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      const port = (server.address() as AddressInfo).port;
      return { port, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
    }

    let dataDir: string;
    beforeEach(() => {
      dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-test-selfcheck-data-'));
    });
    afterEach(() => {
      fs.rmSync(dataDir, { recursive: true, force: true });
    });

    function writeToken(value = TOKEN, mode = 0o600) {
      const file = path.join(dataDir, 'selfcheck.token');
      fs.writeFileSync(file, `${value}\n`, { mode });
      fs.chmodSync(file, mode);
      return file;
    }

    async function expectSelfCheckError(promise: Promise<unknown>, kind: string) {
      const err = await promise.then(() => null, (e) => e);
      expect(err).toBeInstanceOf(SelfCheckError);
      expect(err.kind).toBe(kind);
      expect(String(err.message)).not.toContain(TOKEN);
      return err;
    }

    it('sends the token from <DATA_DIR>/selfcheck.token and no cookie or login', async () => {
      writeToken();
      const fake = await startFakePlatform();
      try {
        const report = await fetchSelfCheck({ port: fake.port, dataDir });
        expect(report).toEqual(REPORT);
        expect(fake.seen).toHaveLength(1);
        expect(fake.seen[0]).toMatchObject({ path: '/api/selfcheck', method: 'GET', token: TOKEN });
        expect(fake.seen[0].cookie).toBeUndefined();
      } finally {
        await fake.close();
      }
    });

    it('treats 401 as a failure, not as "no runtimes"', async () => {
      writeToken();
      const fake = await startFakePlatform({ status: 401 });
      try {
        const err = await expectSelfCheckError(fetchSelfCheck({ port: fake.port, dataDir }), 'unauthorized');
        expect(err.message).toContain('HTTP 401 UNAUTHORIZED');
      } finally {
        await fake.close();
      }
    });

    it('treats a stale token (token file from another start) as unauthorized', async () => {
      writeToken('selfcheck-test-token-000000000000000000002');
      const fake = await startFakePlatform();
      try {
        await expectSelfCheckError(fetchSelfCheck({ port: fake.port, dataDir }), 'unauthorized');
      } finally {
        await fake.close();
      }
    });

    it('treats 403 as a failure', async () => {
      writeToken();
      const fake = await startFakePlatform({ status: 403 });
      try {
        await expectSelfCheckError(fetchSelfCheck({ port: fake.port, dataDir }), 'unauthorized');
      } finally {
        await fake.close();
      }
    });

    it('reports a platform without the endpoint (404) as not-supported', async () => {
      writeToken();
      const fake = await startFakePlatform({ status: 404 });
      try {
        await expectSelfCheckError(fetchSelfCheck({ port: fake.port, dataDir }), 'not-supported');
      } finally {
        await fake.close();
      }
    });

    it('fails on an unexpected response format', async () => {
      writeToken();
      const fake = await startFakePlatform({ body: { success: true, data: { status: 'ok' } } });
      try {
        await expectSelfCheckError(fetchSelfCheck({ port: fake.port, dataDir }), 'bad-response');
      } finally {
        await fake.close();
      }
    });

    it('fails without a token file and sends no request', async () => {
      const fake = await startFakePlatform();
      try {
        await expectSelfCheckError(fetchSelfCheck({ port: fake.port, dataDir }), 'no-token');
        expect(fake.seen).toHaveLength(0);
      } finally {
        await fake.close();
      }
    });

    it('refuses a token file readable by group or others', () => {
      const file = writeToken(TOKEN, 0o644);
      expect(() => readSelfCheckToken(file)).toThrow(/must have mode 0600/);
    });

    it('refuses a symlinked token file', () => {
      const real = path.join(dataDir, 'real.token');
      fs.writeFileSync(real, TOKEN, { mode: 0o600 });
      const link = path.join(dataDir, 'selfcheck.token');
      fs.symlinkSync(real, link);
      expect(() => readSelfCheckToken(link)).toThrow(/not a regular file/);
    });

    it('reports a platform that does not answer in time as "timeout", not "unreachable"', async () => {
      writeToken();
      const fetchImpl = async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; };
      await expectSelfCheckError(fetchSelfCheck({ port: 1, dataDir, fetchImpl: fetchImpl as any }), 'timeout');
    });

    it('selfCheckProblems lists health errors reported by the platform', () => {
      const withErrors = { ...REPORT, status: 'degraded', health: { ...REPORT.health, errors: ['upgrade_status_unavailable'] } };
      expect(selfCheckProblems(withErrors)).toEqual(['upgrade_status_unavailable']);
    });

    it('reports an unreachable platform as "unreachable"', async () => {
      writeToken();
      const fake = await startFakePlatform();
      const port = fake.port;
      await fake.close();
      await expectSelfCheckError(fetchSelfCheck({ port, dataDir }), 'unreachable');
    });

    it('selfCheckProblems flags pending migrations, unavailable runtime and operations', () => {
      expect(selfCheckProblems(REPORT)).toEqual([]);
      const bad = {
        ...REPORT,
        status: 'degraded',
        migrations: { currentVersion: 44, latestVersion: 45, pendingVersions: [45], upToDate: false },
        health: { runtime: { available: false, status: 'error' }, operations: { producerAvailable: false, workerRunning: false } },
      };
      const problems = selfCheckProblems(bad);
      expect(problems).toContain('pending migrations [45]');
      expect(problems).toContain('runtime provider error');
      expect(problems).toContain('operations producer unavailable');
    });

    it('printSelfCheckSummary prints runtimes without user ids and throws on 401 instead of printing a summary', async () => {
      writeToken();
      const ok = await startFakePlatform();
      const denied = await startFakePlatform({ status: 401 });
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
      try {
        const { problems } = await printSelfCheckSummary({ port: ok.port, dataDir });
        expect(problems).toEqual([]);
        const out = logs.join('\n');
        expect(out).toContain('migrations 45/45 (up to date)');
        expect(out).toContain('- Runtime #1 (container): current=enkeep-runtime:test-old, target=enkeep-runtime:test-new, outdated=true');
        expect(out).not.toContain(TOKEN);
        logs.length = 0;
        await expect(printSelfCheckSummary({ port: denied.port, dataDir })).rejects.toThrow(/refused \(HTTP 401/);
        expect(logs.join('\n')).not.toMatch(/no active user runtimes/i);
      } finally {
        console.log = origLog;
        await ok.close();
        await denied.close();
      }
    });

    it('no longer reads admin credentials from the env file', () => {
      const envPath = path.join(dataDir, 'deploy.env');
      fs.writeFileSync(envPath, 'ADMIN_USERNAME=admin-test\nADMIN_PASSWORD=synthetic-password-0001\n');
      const config = resolveDeployConfig(['--env-file', envPath]) as Record<string, unknown>;
      expect(JSON.stringify(config)).not.toContain('synthetic-password-0001');
    });
  });
});
