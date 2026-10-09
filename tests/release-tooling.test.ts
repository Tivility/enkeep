import { describe, it, expect, vi } from 'vitest';
import { parseEnvFile, resolveDeployConfig, validateConfig, checkTreeMatch, updatePlistContent } from '../scripts/deploy-release.mjs';
import { planPruneWorktrees, executePrune, parseArgs } from '../scripts/prune-release-worktrees.mjs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('Deploy & Prune Tooling (P-01, P-03, P-04)', () => {
  describe('P-01: Parameterization & Validation', () => {
    it('fails validation when required parameters are missing', () => {
      expect(() => validateConfig({})).toThrow(/Missing required configuration/);
      expect(() => validateConfig({ releaseId: 'batch1' })).toThrow(/Missing required configuration/);
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
      })).toThrow(/Safety violation/);
    });

    it('parses env files correctly without hardcoded defaults', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-test-env-'));
      const envPath = path.join(tmpDir, 'test.env');
      fs.writeFileSync(envPath, 'RELEASE_ID=batch-synth\nPORT=3900\nREPO_ROOT="/tmp/test/repo"\n# Comment line\n');

      const parsed = parseEnvFile(envPath);
      expect(parsed.RELEASE_ID).toBe('batch-synth');
      expect(parsed.PORT).toBe('3900');
      expect(parsed.REPO_ROOT).toBe('/tmp/test/repo');

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('correctly updates plist demo-runner path and image tag', () => {
      const samplePlist = `
<plist>
<dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ENKEEP_RUNTIME_IMAGE</key>
    <string>enkeep-runtime:gap-batch54-oldsha</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/tmp/worktrees/release-worktree-batch54/packages/demo-runner/dist/demo-runner.js</string>
    <string>up</string>
  </array>
</dict>
</plist>`;

      const updated = updatePlistContent(samplePlist, '/tmp/worktrees/release-worktree-batch55', 'enkeep-runtime:gap-batch55-newsha');
      expect(updated).toContain('/tmp/worktrees/release-worktree-batch55/packages/demo-runner/dist/demo-runner.js');
      expect(updated).toContain('enkeep-runtime:gap-batch55-newsha');
      expect(updated).not.toContain('batch54');
    });
  });

  describe('P-03: Worktree Pruning & Protection', () => {
    it('prunes older worktrees while protecting the top N and active worktree', () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-test-prune-'));
      const repoDir = path.join(tmpRoot, 'repo');
      const releaseDir = path.join(tmpRoot, 'releases');
      fs.mkdirSync(repoDir);
      fs.mkdirSync(releaseDir);

      // Create synthetic release worktrees with synthetic mtimes
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

      // We ask to keep 2, and active is wt1 (oldest)
      const plan = planPruneWorktrees({
        releaseRoot: releaseDir,
        repoRoot: repoDir,
        keep: 2,
        activeWorktree: wt1,
      });

      expect(plan.totalFound).toBe(5);
      // wt5, wt4 kept due to most recent 2. wt1 kept because it is active.
      expect(plan.kept.map(k => k.name).sort()).toEqual(['release-worktree-batch1', 'release-worktree-batch4', 'release-worktree-batch5']);
      // wt2, wt3 should be pruned
      expect(plan.pruned.map(p => p.name).sort()).toEqual(['release-worktree-batch2', 'release-worktree-batch3']);

      // Dry run execution
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
});
