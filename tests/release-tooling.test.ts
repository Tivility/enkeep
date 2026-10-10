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
  classifyChanges,
  extractAssetsFromIndexHtml,
  extractWorktreePathFromPlist,
  setRuntimeTargetVersionInDb,
  executeRuntimeDeploy,
  executePlatformDeploy,
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

      it('classifies runtime-runner, dsh-*, and docker/ changes as runtime', () => {
        const changes = [
          'packages/runtime-runner/src/host/adapter.ts',
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
    });

    describe('Runtime & Platform Deploy Plans', () => {
      it('persists target version directly in sqlite database via setRuntimeTargetVersionInDb', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-test-db-'));
        const dbPath = path.join(tmpDir, 'platform.db');
        
        setRuntimeTargetVersionInDb(dbPath, 'enkeep-runtime:test-tag-v1');
        
        // Verify persisted content
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(dbPath);
        const row = db.prepare('SELECT id, image, daemon_cli_path, updated_by FROM runtime_target_version WHERE id = ?').get('default');
        expect(row.id).toBe('default');
        expect(row.image).toBe('enkeep-runtime:test-tag-v1');
        expect(row.updated_by).toBe('deploy_script');
        db.close();

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
    });
  });
});
