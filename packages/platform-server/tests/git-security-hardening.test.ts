import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execSync } from 'node:child_process';
import {
  runGitCommand,
  cleanupStaleGitTempDirs,
  createSecureTempDir,
  stageGitSkill,
  GitExecutionError,
} from '../src/skills/git-installer.js';
import {
  validateGitUrlAgainstPolicy,
  DEFAULT_GIT_SOURCE_POLICY,
} from '../src/skills/git-source-policy.js';
import {
  validateSkillDirectory,
  validateSkillName,
} from '../src/skills/security-validator.js';
import { stageArchiveSkill } from '../src/skills/archive-installer.js';
import { TarWriter } from '@enkeep/backup-restore';

import {
  PlatformServer,
  PlatformConfigurationError,
} from '../src/server/server.js';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { DefaultAuthService } from '@enkeep/platform-auth';

describe('Git Security Hardening & Isolation Unit Tests', () => {
  let tempDir: string;
  let testRepoDir: string;

  beforeEach(() => {
    tempDir = createSecureTempDir('enkeep-git-test-hardening-');
    testRepoDir = path.join(tempDir, 'repo');
    fs.mkdirSync(testRepoDir, { recursive: true });

    execSync('git init -b main', { cwd: testRepoDir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: testRepoDir, stdio: 'ignore' });
    execSync('git config user.email "test@test.local"', { cwd: testRepoDir, stdio: 'ignore' });

    fs.writeFileSync(path.join(testRepoDir, 'README.md'), '# Test\n', 'utf8');
    execSync('git add README.md', { cwd: testRepoDir, stdio: 'ignore' });
    execSync('git commit -m "initial commit"', { cwd: testRepoDir, stdio: 'ignore' });
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('proves authToken is passed via GIT_ASKPASS and never in process argv', async () => {
    const fakeToken = 'secret_token_12345_never_in_argv';

    const result = await runGitCommand(['status'], {
      cwd: testRepoDir,
      authToken: fakeToken,
      policy: {
        allowFileScheme: true,
        allowedFileRoots: [tempDir],
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('On branch main');

    // Verify token was not in command output
    expect(result.stdout).not.toContain(fakeToken);
    expect(result.stderr).not.toContain(fakeToken);
  });

  it('kills process and fails when output exceeds 1 MiB limit', async () => {
    // Generate a file > 1.5 MB in git history
    const largeFile = path.join(testRepoDir, 'large.txt');
    const largeBuf = Buffer.alloc(1.5 * 1024 * 1024, 'A');
    fs.writeFileSync(largeFile, largeBuf);
    execSync('git add large.txt', { cwd: testRepoDir, stdio: 'ignore' });
    execSync('git commit -m "large commit"', { cwd: testRepoDir, stdio: 'ignore' });

    // Output all contents which exceeds 1 MiB limit
    await expect(
      runGitCommand(['cat-file', '-p', 'HEAD:large.txt'], {
        cwd: testRepoDir,
        policy: { allowFileScheme: true, allowedFileRoots: [tempDir] },
      })
    ).rejects.toThrow(/limit exceeded/i);
  });

  it('rejects embedded credentials in Git URLs', async () => {
    await expect(
      validateGitUrlAgainstPolicy('https://user:password@github.com/repo.git')
    ).rejects.toThrow(/Embedded credentials/i);

    await expect(
      validateGitUrlAgainstPolicy('https://x-access-token:ghp_12345@github.com/repo.git')
    ).rejects.toThrow(/Embedded credentials/i);

    await expect(
      validateGitUrlAgainstPolicy('ssh://user:secret@github.com/repo.git')
    ).rejects.toThrow(/Embedded credentials/i);

    await expect(
      validateGitUrlAgainstPolicy('baduser@github.com:org/repo.git')
    ).rejects.toThrow(/Embedded credentials/i);
  });

  it('rejects SSRF domains and private IPs by default', async () => {
    await expect(
      validateGitUrlAgainstPolicy('https://169.254.169.254/latest/meta-data')
    ).rejects.toThrow(/SSRF protection/i);

    await expect(
      validateGitUrlAgainstPolicy('https://127.0.0.1/evil.git')
    ).rejects.toThrow(/SSRF protection/i);

    await expect(
      validateGitUrlAgainstPolicy('https://10.20.30.40/evil.git')
    ).rejects.toThrow(/SSRF protection/i);

    await expect(
      validateGitUrlAgainstPolicy('https://metadata.google.internal/computeMetadata/v1')
    ).rejects.toThrow(/SSRF protection/i);
  });

  it('enforces default GitSourcePolicy: blocks file://, http://, git:// unless explicitly configured', async () => {
    await expect(
      validateGitUrlAgainstPolicy('file:///etc/passwd', DEFAULT_GIT_SOURCE_POLICY)
    ).rejects.toThrow(/file:\/\/ scheme is strictly disabled/i);

    await expect(
      validateGitUrlAgainstPolicy('http://github.com/repo.git', DEFAULT_GIT_SOURCE_POLICY)
    ).rejects.toThrow(/Insecure http:\/\/ scheme is prohibited/i);

    await expect(
      validateGitUrlAgainstPolicy('git://github.com/repo.git', DEFAULT_GIT_SOURCE_POLICY)
    ).rejects.toThrow(/Insecure unauthenticated git:\/\/ scheme is prohibited/i);
  });

  it('rejects dash flags in Git repository URL (argument injection defense)', async () => {
    await expect(
      validateGitUrlAgainstPolicy('--upload-pack=touch /tmp/pwned')
    ).rejects.toThrow(/argument injection/i);

    await expect(
      validateGitUrlAgainstPolicy('-u')
    ).rejects.toThrow(/argument injection/i);
  });

  it('cleans up stale temp staging directories older than TTL', () => {
    const staleDir = createSecureTempDir('enkeep-git-stale-');
    expect(fs.existsSync(staleDir)).toBe(true);

    // Call cleanup with maxAgeMs = 0 to trigger cleanup
    const result = cleanupStaleGitTempDirs(0);
    expect(result.cleaned).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(staleDir)).toBe(false);
  });

  it('throws AggregateError and does not claim success when secret cleanup fails', async () => {
    const fakeToken = 'secret_token_cleanup_fail_test';

    const originalRmSync = fs.rmSync;
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation((targetPath: fs.PathLike, options?: fs.RmOptions) => {
      if (typeof targetPath === 'string' && targetPath.includes('token.txt')) {
        throw new Error('Simulated EPERM: permission denied deleting secret token');
      }
      return originalRmSync(targetPath, options);
    });

    try {
      await expect(
        runGitCommand(['status'], {
          cwd: testRepoDir,
          authToken: fakeToken,
          policy: {
            allowFileScheme: true,
            allowedFileRoots: [tempDir],
          },
        })
      ).rejects.toThrow(/Security Critical: Failed to clean up ephemeral git credentials/i);
    } finally {
      rmSpy.mockRestore();
    }
  });

  it('strictly rejects .gitmodules files in skill directories (including subdirectories and uppercase)', () => {
    const skillStageDir = createSecureTempDir('enkeep-test-gitmodules-');
    try {
      fs.writeFileSync(
        path.join(skillStageDir, 'SKILL.md'),
        '---\nname: safe-skill\ndescription: safe\n---\nBody'
      );
      fs.writeFileSync(path.join(skillStageDir, '.gitmodules'), '[submodule "bad"]\npath = bad\n');

      expect(() => validateSkillDirectory(skillStageDir)).toThrow(/Submodule definition file \(\.gitmodules\) is strictly prohibited/i);
    } finally {
      fs.rmSync(skillStageDir, { recursive: true, force: true });
    }
  });

  it('verifies secure directory and file permissions on staging and credentials', () => {
    if (process.platform === 'win32') return;

    const secureDir = createSecureTempDir('enkeep-perm-test-');
    try {
      const stat = fs.statSync(secureDir);
      // Mode on POSIX should be 0700
      expect((stat.mode & 0o777).toString(8)).toBe('700');
    } finally {
      fs.rmSync(secureDir, { recursive: true, force: true });
    }
  });

  it('extracts and stages archives safely with bounds checking and rejects traversal', async () => {
    const writer = new TarWriter();
    writer.addFile({
      path: 'SKILL.md',
      data: Buffer.from('---\nname: tar-skill\ndescription: Valid tar skill\n---\nHello from tar'),
    });
    const tarBuf = writer.finalize();

    const staged = await stageArchiveSkill(tarBuf, 'skill.tar');
    try {
      expect(staged.payload.name).toBe('tar-skill');
      expect(fs.existsSync(path.join(staged.targetDir, 'SKILL.md'))).toBe(true);
    } finally {
      staged.cleanup();
      expect(fs.existsSync(staged.stageDir)).toBe(false);
    }
  });

  it('fails server startup and does not bind listener when stale cleanup encounters EPERM', async () => {
    const memDb = new DatabaseSync(':memory:');
    const memStorage = new SqlitePlatformStorage(memDb);
    const memAuth = new DefaultAuthService(memStorage, {
      cookieSecret: 'test_cookie_secret_at_least_32_chars_long_12345',
    });

    const mockRuntimeGateway: any = {
      async dispatchInbound() {
        return { accepted: true, turnId: 'turn_mock', dshSessionId: 'ses_mock' };
      },
      async getTurnStatus() {
        return { turnId: 'turn_mock', status: 'completed' as const };
      },
      async cancelTurn() {
        return true;
      },
    };

    const testServer = new PlatformServer({
      database: memDb,
      storage: memStorage,
      authService: memAuth,
      host: '127.0.0.1',
      port: 0,
      cookieSecret: 'test_cookie_secret_at_least_32_chars_long_12345',
      csrfToken: 'test_csrf_token_min_32_chars_long_12345',
      runtimeGateway: mockRuntimeGateway,
    });

    // Create a stale directory in tmp and backdate mtime to 2 hours ago
    const staleDir = createSecureTempDir('enkeep-git-test-eperm-');
    const twoHoursAgo = (Date.now() - 7200000) / 1000;
    fs.utimesSync(staleDir, twoHoursAgo, twoHoursAgo);

    const originalRmSync = fs.rmSync;
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation((targetPath: fs.PathLike, options?: fs.RmOptions) => {
      if (typeof targetPath === 'string' && targetPath.includes('enkeep-git-test-eperm-')) {
        const err: NodeJS.ErrnoException = new Error('Operation not permitted');
        err.code = 'EPERM';
        throw err;
      }
      return originalRmSync(targetPath, options);
    });

    try {
      await expect(testServer.start()).rejects.toThrow(PlatformConfigurationError);
      await expect(testServer.start()).rejects.toThrow(/TEMP_PERMISSION_FAILED/i);
    } finally {
      rmSpy.mockRestore();
      if (fs.existsSync(staleDir)) {
        fs.rmSync(staleDir, { recursive: true, force: true });
      }
      await testServer.stop();
    }
  });
});
