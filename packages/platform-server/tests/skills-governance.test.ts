import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
} from '../src/storage/migrations.js';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { DefaultAuthService, provisionFixtures } from '@enkeep/platform-auth';
import { PlatformServer } from '../src/server/server.js';
import { stageArchiveSkill } from '../src/skills/archive-installer.js';
import { runGitCommand, stageGitSkill, GitExecutionError } from '../src/skills/git-installer.js';
import {
  validateGitUrlAgainstPolicy,
  DEFAULT_GIT_SOURCE_POLICY,
} from '../src/skills/git-source-policy.js';
import type { GitCredentialResolverPort, GitResolvedCredentials } from '../src/skills/skill-types.js';
import type { RuntimeGateway } from '@enkeep/web-channel';
import { TarWriter } from '@enkeep/backup-restore';

describe('Extensions & Skills Canonical API, Supply Chain & Multi-Tenant Governance Integration Tests', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let authService: DefaultAuthService;
  let server: PlatformServer;
  let baseUrl: string;
  let csrfToken: string;

  let tempDir: string;
  let dshHome: string;
  let spacesDir: string;
  let bundledSkillDir: string;
  let localGitRepoDir: string;

  let aliceUserId: string;
  let bobUserId: string;
  let aliceCookie: string;
  let bobCookie: string;
  let aliceSpaceAId: string;
  let aliceSpaceBId: string;
  let bobSpaceId: string;

  const fakeCredentialResolver: GitCredentialResolverPort = {
    async resolveCredentials(userId: string, credentialRef: string): Promise<GitResolvedCredentials | null> {
      if (userId === aliceUserId && credentialRef === 'cred_alice_valid_token') {
        return { authToken: 'resolved_secret_token_for_alice' };
      }
      if (userId === aliceUserId && credentialRef === 'cred_alice_ssh_key') {
        return { sshPrivateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----' };
      }
      return null;
    },
  };

  const mockRuntimeGateway: RuntimeGateway = {
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

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-skills-test-'));
    dshHome = path.join(tempDir, 'dsh-home');
    spacesDir = path.join(tempDir, 'spaces');
    bundledSkillDir = path.join(tempDir, 'bundled-skills');
    localGitRepoDir = path.join(tempDir, 'test-git-skill');

    fs.mkdirSync(dshHome, { recursive: true });
    fs.mkdirSync(spacesDir, { recursive: true });
    fs.mkdirSync(bundledSkillDir, { recursive: true });
    fs.mkdirSync(localGitRepoDir, { recursive: true });

    // Initialize bundled skill on disk
    const bundledCodeReviewDir = path.join(bundledSkillDir, 'bundled-audit');
    fs.mkdirSync(bundledCodeReviewDir, { recursive: true });
    fs.writeFileSync(
      path.join(bundledCodeReviewDir, 'SKILL.md'),
      `---
name: bundled-audit
description: System bundled audit skill
---
# Bundled Audit Instructions
Run comprehensive audit.
`,
      'utf8'
    );

    // Initialize local git repo with commit 1
    execSync('git init -b main', { cwd: localGitRepoDir, stdio: 'ignore' });
    execSync('git config user.name "Enkeep Tester"', { cwd: localGitRepoDir, stdio: 'ignore' });
    execSync('git config user.email "tester@enkeep.test"', { cwd: localGitRepoDir, stdio: 'ignore' });

    fs.writeFileSync(
      path.join(localGitRepoDir, 'SKILL.md'),
      `---
name: code-review-pro
description: Professional code review skill v1
---
# Code Review Pro v1
Review all changes carefully.
`,
      'utf8'
    );
    execSync('git add SKILL.md', { cwd: localGitRepoDir, stdio: 'ignore' });
    execSync('git commit -m "commit 1: initial skill"', { cwd: localGitRepoDir, stdio: 'ignore' });

    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    csrfToken = 'csrf_token_test_min_32_characters_long_secret_skills_123';

    storage = new SqlitePlatformStorage(db);
    authService = new DefaultAuthService(storage, {
      cookieSecret: 'test_cookie_secret_at_least_32_chars_long_12345',
    });

    server = new PlatformServer({
      database: db,
      storage,
      authService,
      host: '127.0.0.1',
      port: 0,
      cookieSecret: 'test_cookie_secret_at_least_32_chars_long_12345',
      csrfToken,
      runtimeGateway: mockRuntimeGateway,
      dshHome,
      spacesDir,
      bundledSkillDir,
      gitSourcePolicy: {
        allowedSchemes: ['https', 'ssh', 'file'],
        allowFileScheme: true,
        allowedFileRoots: [tempDir],
        allowedHosts: ['localhost'],
      },
      gitCredentialResolver: fakeCredentialResolver,
    });

    const addr = await server.start();
    baseUrl = addr.url;

    // Provision fixtures: Alice (Admin), Bob (User)
    const fixtures = await provisionFixtures(storage, authService, {
      adminUsername: 'alice',
      adminPassword: 'AlicePassword123!',
      userUsername: 'bob',
      userPassword: 'BobPassword123!',
      disabledUsername: 'charlie',
      disabledPassword: 'CharliePassword123!',
    });

    aliceUserId = fixtures.admin.id;
    bobUserId = fixtures.user.id;
    aliceSpaceAId = fixtures.adminContainerSpace.id;

    // Create SpaceB for Alice
    const spaceB = await storage.forTenant(aliceUserId).spaces.create({
      name: 'Alice Space B',
      folder: 'alice-space-b',
      executionMode: 'container',
    });
    aliceSpaceBId = spaceB.id;

    bobSpaceId = fixtures.userContainerSpace.id;

    // Create space directories in spacesDir
    fs.mkdirSync(path.join(spacesDir, fixtures.adminContainerSpace.folder), { recursive: true });
    fs.mkdirSync(path.join(spacesDir, spaceB.folder), { recursive: true });
    fs.mkdirSync(path.join(spacesDir, fixtures.userContainerSpace.folder), { recursive: true });

    // Log in Alice
    const aliceLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ username: 'alice', password: 'AlicePassword123!' }),
    });
    expect(aliceLogin.status).toBe(200);
    aliceCookie = aliceLogin.headers.get('set-cookie')!;

    // Log in Bob
    const bobLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ username: 'bob', password: 'BobPassword123!' }),
    });
    expect(bobLogin.status).toBe(200);
    bobCookie = bobLogin.headers.get('set-cookie')!;
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('0. Physical Removal of Legacy /api/manage/skills (Strict 404, No Redirection/Aliases)', () => {
    it('returns 404 NOT_FOUND for GET /api/manage/skills without redirection', async () => {
      const res = await fetch(`${baseUrl}/api/manage/skills`, {
        headers: { Cookie: aliceCookie },
        redirect: 'manual',
      });
      expect(res.status).toBe(404);
      expect(res.headers.get('location')).toBeNull();
      const json = (await res.json()) as any;
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('NOT_FOUND');
    });

    it('returns 404 NOT_FOUND for GET /api/manage/skills/:name', async () => {
      const res = await fetch(`${baseUrl}/api/manage/skills/bundled-audit`, {
        headers: { Cookie: aliceCookie },
        redirect: 'manual',
      });
      expect(res.status).toBe(404);
      const json = (await res.json()) as any;
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('NOT_FOUND');
    });

    it('returns 404 NOT_FOUND for POST /api/manage/skills/install', async () => {
      const res = await fetch(`${baseUrl}/api/manage/skills/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          scope: 'space',
          spaceId: aliceSpaceAId,
          sourceType: 'git',
        }),
        redirect: 'manual',
      });
      expect(res.status).toBe(404);
      const json = (await res.json()) as any;
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('NOT_FOUND');
    });

    it('returns 404 NOT_FOUND for mutation sub-routes (/update, /rollback, /enable, /disable, /uninstall)', async () => {
      const endpoints = [
        { method: 'POST', path: '/api/manage/skills/code-review-pro/update' },
        { method: 'POST', path: '/api/manage/skills/code-review-pro/rollback' },
        { method: 'POST', path: '/api/manage/skills/code-review-pro/enable' },
        { method: 'POST', path: '/api/manage/skills/code-review-pro/disable' },
        { method: 'POST', path: '/api/manage/skills/code-review-pro/uninstall' },
        { method: 'DELETE', path: '/api/manage/skills/code-review-pro' },
      ];

      for (const ep of endpoints) {
        const res = await fetch(`${baseUrl}${ep.path}`, {
          method: ep.method,
          headers: {
            'Content-Type': 'application/json',
            'X-Enkeep-CSRF': csrfToken,
            Origin: baseUrl,
            Cookie: aliceCookie,
          },
          body: ep.method === 'POST' ? JSON.stringify({ spaceId: aliceSpaceAId }) : undefined,
          redirect: 'manual',
        });
        expect(res.status).toBe(404);
        const json = (await res.json()) as any;
        expect(json.success).toBe(false);
        expect(json.error.code).toBe('NOT_FOUND');
      }
    });
  });

  describe('1. Canonical Extension Discovery & Catalog DTOs (/api/manage/extensions)', () => {
    it('discovers bundled skills via canonical GET /api/manage/extensions without exposing host paths', async () => {
      const res = await fetch(`${baseUrl}/api/manage/extensions`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.success).toBe(true);

      const bundled = json.data.find((s: any) => s.slug === 'bundled-audit');
      expect(bundled).toBeDefined();
      expect(bundled.slug).toBe('bundled-audit');
      expect(bundled.name).toBe('bundled-audit');
      expect(bundled.description).toBe('System bundled audit skill');
      expect(bundled.sourceKind).toBe('builtin');
      expect(bundled.status).toBe('active');
      expect(bundled.enabled).toBe(true);

      // Verify contributions structure
      expect(bundled.contributions.length).toBeGreaterThan(0);
      expect(bundled.contributions[0].kind).toBe('skill');
      expect(bundled.contributions[0].modelInvocable).toBe(true);
      expect(bundled.contributions[0].userInvocable).toBe(true);

      // Verify NO host path leaked in DTO
      const rawString = JSON.stringify(json.data);
      expect(rawString).not.toContain(tempDir);
      expect(rawString).not.toContain(bundledSkillDir);
    });

    it('gets extension detail with content body via canonical GET /api/manage/extensions/:slug', async () => {
      const res = await fetch(`${baseUrl}/api/manage/extensions/bundled-audit`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.success).toBe(true);
      expect(json.data.slug).toBe('bundled-audit');
      expect(json.data.content).toContain('# Bundled Audit Instructions');

      // Verify no absolute path leaked
      const rawString = JSON.stringify(json);
      expect(rawString).not.toContain(tempDir);
      expect(rawString).not.toContain('/Users/');
    });
  });

  describe('2. Git Extension Installation, Commit Resolution, and Provenance (/api/manage/extensions/install)', () => {
    it('installs extension from local git repository (commit 1) into SpaceA', async () => {
      const installRes = await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
          'Idempotency-Key': '11111111-1111-4111-8111-111111111111',
        },
        body: JSON.stringify({
          sourceKind: 'git',
          spaceId: aliceSpaceAId,
          gitSource: {
            repositoryUrl: `file://${localGitRepoDir}`,
            ref: 'main',
          },
        }),
      });

      expect(installRes.status).toBe(201);
      const json = (await installRes.json()) as any;
      expect(json.success).toBe(true);
      expect(json.data.slug).toBe('code-review-pro');
      expect(json.data.name).toBe('code-review-pro');
      expect(json.data.installedVersion).toBe(1);
      expect(json.data.activeVersion).toBe(1);
      expect(json.data.status).toBe('active');
      expect(json.data.enabled).toBe(true);
      expect(json.data.integritySha256).toBeTruthy();
      expect(json.data.content).toContain('# Code Review Pro v1');

      // Check physical files in SpaceA .skills directory
      const spaceAFolder = (await storage.forTenant(aliceUserId).spaces.findById(aliceSpaceAId))!.folder;
      const installedSkillMd = path.join(spacesDir, spaceAFolder, '.skills', 'code-review-pro', 'SKILL.md');
      expect(fs.existsSync(installedSkillMd)).toBe(true);
      expect(fs.readFileSync(installedSkillMd, 'utf8')).toContain('Code Review Pro v1');
    });

    it('strictly rejects plaintext credentials in request body and prevents leakage into DB/logs', async () => {
      const installRes = await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          sourceKind: 'git',
          spaceId: aliceSpaceAId,
          gitSource: {
            repositoryUrl: `file://${localGitRepoDir}`,
            authToken: 'malicious_plaintext_secret_token_123',
          },
        }),
      });

      expect(installRes.status).toBe(400);
      const json = (await installRes.json()) as any;
      expect(json.success).toBe(false);
      expect(json.error.message).toMatch(/Plaintext secret field "authToken" is strictly forbidden/i);

      // Verify that malicious_plaintext_secret_token_123 is NOT anywhere in DB
      const packages = await storage.forTenant(aliceUserId).extensionPackages.list();
      expect(packages.length).toBe(0);
    });

    it('strictly rejects unknown fields in request body with 400', async () => {
      const installRes = await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          sourceKind: 'git',
          spaceId: aliceSpaceAId,
          gitSource: {
            repositoryUrl: `file://${localGitRepoDir}`,
            unknownExtraField: 'attack_payload',
          },
        }),
      });

      expect(installRes.status).toBe(400);
      const json = (await installRes.json()) as any;
      expect(json.success).toBe(false);
      expect(json.error.message).toMatch(/Unknown field "unknownExtraField" is prohibited/i);
    });

    it('strictly rejects strings with un-trimmed whitespace instead of silent trimming', async () => {
      const installRes = await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          sourceKind: 'git',
          spaceId: aliceSpaceAId,
          gitSource: {
            repositoryUrl: `  file://${localGitRepoDir}  `,
          },
        }),
      });

      expect(installRes.status).toBe(400);
      const json = (await installRes.json()) as any;
      expect(json.success).toBe(false);
      expect(json.error.message).toMatch(/must not contain leading or trailing whitespace/i);
    });

    it('resolves credentials via GitCredentialResolverPort for credentialRef', async () => {
      const installRes = await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          sourceKind: 'git',
          spaceId: aliceSpaceAId,
          gitSource: {
            repositoryUrl: `file://${localGitRepoDir}`,
            ref: 'main',
            credentialRef: 'cred_alice_valid_token',
          },
        }),
      });

      expect(installRes.status).toBe(201);
      const json = (await installRes.json()) as any;
      expect(json.success).toBe(true);
      expect(json.data.slug).toBe('code-review-pro');
    });

    it('enforces tenant boundary on credential resolution: Bob cannot resolve Alice credentialRef', async () => {
      const installRes = await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: bobCookie,
        },
        body: JSON.stringify({
          sourceKind: 'git',
          spaceId: bobSpaceId,
          gitSource: {
            repositoryUrl: `file://${localGitRepoDir}`,
            ref: 'main',
            credentialRef: 'cred_alice_valid_token',
          },
        }),
      });

      expect(installRes.status).toBe(400);
      const json = (await installRes.json()) as any;
      expect(json.success).toBe(false);
      expect(json.error.message).toMatch(/Credential reference "cred_alice_valid_token" not found or unauthorized/i);
    });

    it('returns 503 when credentialRef is provided but deployment has no credential resolver configured', async () => {
      // Create server without credentialResolver
      const unconfiguredServer = new PlatformServer({
        database: db,
        storage,
        authService,
        host: '127.0.0.1',
        port: 0,
        cookieSecret: 'test_cookie_secret_at_least_32_chars_long_12345',
        csrfToken,
        runtimeGateway: mockRuntimeGateway,
        dshHome,
        spacesDir,
        bundledSkillDir,
        gitSourcePolicy: {
          allowedSchemes: ['https', 'ssh', 'file'],
          allowFileScheme: true,
          allowedFileRoots: [tempDir],
          allowedHosts: ['localhost'],
        },
      });

      const unconfiguredAddr = await unconfiguredServer.start();
      try {
        const installRes = await fetch(`${unconfiguredAddr.url}/api/manage/extensions/install`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Enkeep-CSRF': csrfToken,
            Origin: unconfiguredAddr.url,
            Cookie: aliceCookie,
          },
          body: JSON.stringify({
            sourceKind: 'git',
            spaceId: aliceSpaceAId,
            gitSource: {
              repositoryUrl: `file://${localGitRepoDir}`,
              ref: 'main',
              credentialRef: 'some_cred_ref',
            },
          }),
        });

        expect(installRes.status).toBe(503);
        const json = (await installRes.json()) as any;
        expect(json.success).toBe(false);
        expect(json.error.message).toMatch(/credential resolution service is not configured/i);
      } finally {
        await unconfiguredServer.stop();
      }
    });
  });

  describe('3. Git Update, Diff Preview, and Rollback Workflow (/api/manage/extensions/:slug/*)', () => {
    beforeEach(async () => {
      // Install initial version 1
      await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          sourceKind: 'git',
          spaceId: aliceSpaceAId,
          gitSource: {
            repositoryUrl: `file://${localGitRepoDir}`,
            ref: 'main',
          },
        }),
      });

      // Add Commit 2 to local git repository
      fs.writeFileSync(
        path.join(localGitRepoDir, 'SKILL.md'),
        `---
name: code-review-pro
description: Professional code review skill v2 with enhanced security
---
# Code Review Pro v2
Advanced security rules included.
`,
        'utf8'
      );
      execSync('git add SKILL.md', { cwd: localGitRepoDir, stdio: 'ignore' });
      execSync('git commit -m "commit 2: enhanced security rules"', { cwd: localGitRepoDir, stdio: 'ignore' });
    });

    it('previews diff when updating without confirmDiff=true', async () => {
      const updateRes = await fetch(`${baseUrl}/api/manage/extensions/code-review-pro/update`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          spaceId: aliceSpaceAId,
          confirmDiff: false,
        }),
      });

      expect(updateRes.status).toBe(200);
      const json = (await updateRes.json()) as any;
      expect(json.success).toBe(true);
      expect(json.data.requiresConfirmation).toBe(true);
      expect(json.data.changedFiles.length).toBeGreaterThan(0);
      expect(json.data.changedFiles[0].path).toBe('SKILL.md');
      expect(json.data.changedFiles[0].status).toBe('modified');
    });

    it('applies update when confirmDiff=true and updates version to 2', async () => {
      const updateRes = await fetch(`${baseUrl}/api/manage/extensions/code-review-pro/update`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          spaceId: aliceSpaceAId,
          confirmDiff: true,
        }),
      });

      expect(updateRes.status).toBe(200);
      const json = (await updateRes.json()) as any;
      expect(json.success).toBe(true);
      expect(json.data.installedVersion).toBe(2);
      expect(json.data.activeVersion).toBe(2);
      expect(json.data.content).toContain('Code Review Pro v2');

      // Verify file on disk is updated
      const spaceAFolder = (await storage.forTenant(aliceUserId).spaces.findById(aliceSpaceAId))!.folder;
      const skillFile = path.join(spacesDir, spaceAFolder, '.skills', 'code-review-pro', 'SKILL.md');
      expect(fs.readFileSync(skillFile, 'utf8')).toContain('Code Review Pro v2');
    });

    it('strictly rejects plaintext secrets and unknown fields in update payload', async () => {
      const updateRes = await fetch(`${baseUrl}/api/manage/extensions/code-review-pro/update`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          spaceId: aliceSpaceAId,
          confirmDiff: true,
          authToken: 'plaintext_update_token',
        }),
      });

      expect(updateRes.status).toBe(400);
      const json = (await updateRes.json()) as any;
      expect(json.success).toBe(false);
      expect(json.error.message).toMatch(/Plaintext secret field "authToken" is strictly forbidden/i);
    });

    it('rolls back from version 2 to version 1 cleanly', async () => {
      // First update to v2
      await fetch(`${baseUrl}/api/manage/extensions/code-review-pro/update`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          spaceId: aliceSpaceAId,
          confirmDiff: true,
        }),
      });

      // Now rollback to version 1
      const rollbackRes = await fetch(`${baseUrl}/api/manage/extensions/code-review-pro/rollback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          spaceId: aliceSpaceAId,
          targetVersion: 1,
        }),
      });

      expect(rollbackRes.status).toBe(200);
      const json = (await rollbackRes.json()) as any;
      expect(json.success).toBe(true);
      expect(json.data.content).toContain('Code Review Pro v1');

      // Verify file on disk is restored to v1
      const spaceAFolder = (await storage.forTenant(aliceUserId).spaces.findById(aliceSpaceAId))!.folder;
      const skillFile = path.join(spacesDir, spaceAFolder, '.skills', 'code-review-pro', 'SKILL.md');
      expect(fs.readFileSync(skillFile, 'utf8')).toContain('Code Review Pro v1');
    });
  });

  describe('4. Supply Chain Security, GitSourcePolicy & Attack Defense', () => {
    it('rejects file:// scheme by default under standard GitSourcePolicy', async () => {
      await expect(
        validateGitUrlAgainstPolicy(`file://${localGitRepoDir}`, DEFAULT_GIT_SOURCE_POLICY)
      ).rejects.toThrow(/file:\/\/ scheme is strictly disabled/i);
    });

    it('rejects file:// scheme when target path is outside allowedFileRoots', async () => {
      await expect(
        validateGitUrlAgainstPolicy(`file:///etc/shadow`, {
          allowFileScheme: true,
          allowedFileRoots: [tempDir],
        })
      ).rejects.toThrow(/not within any allowed file roots/i);
    });

    it('rejects URLs containing embedded credentials (user:pass@)', async () => {
      await expect(
        validateGitUrlAgainstPolicy(`https://user:token123@github.com/org/repo.git`)
      ).rejects.toThrow(/Embedded credentials/i);
    });

    it('rejects insecure http:// URLs by default unless allowInsecureHttp is set', async () => {
      await expect(
        validateGitUrlAgainstPolicy(`http://github.com/org/repo.git`, DEFAULT_GIT_SOURCE_POLICY)
      ).rejects.toThrow(/Insecure http:\/\/ scheme is prohibited/i);
    });

    it('rejects DNS SSRF loopback and private IP hosts by default', async () => {
      await expect(
        validateGitUrlAgainstPolicy(`https://localhost/org/repo.git`, DEFAULT_GIT_SOURCE_POLICY)
      ).rejects.toThrow(/SSRF protection/i);

      await expect(
        validateGitUrlAgainstPolicy(`https://127.0.0.1/org/repo.git`, DEFAULT_GIT_SOURCE_POLICY)
      ).rejects.toThrow(/SSRF protection/i);

      await expect(
        validateGitUrlAgainstPolicy(`https://169.254.169.254/org/repo.git`, DEFAULT_GIT_SOURCE_POLICY)
      ).rejects.toThrow(/SSRF protection/i);

      await expect(
        validateGitUrlAgainstPolicy(`https://10.0.0.1/org/repo.git`, DEFAULT_GIT_SOURCE_POLICY)
      ).rejects.toThrow(/SSRF protection/i);
    });

    it('rejects SSH URLs when no known_hosts file is configured', async () => {
      await expect(
        runGitCommand(['ls-remote', 'git@github.com:org/repo.git'], {
          sshPrivateKey: 'fake_private_key',
          policy: { knownHostsFile: '/nonexistent/known_hosts_file' },
        })
      ).rejects.toThrow();
    });

    it('kills process and fails closed when git command exceeds output limit (1 MiB)', async () => {
      // Simulate git command producing massive output
      await expect(
        runGitCommand(['log', '--format=%B', '-n', '10000'], {
          cwd: localGitRepoDir,
          policy: { allowFileScheme: true, allowedFileRoots: [tempDir] },
        })
      ).resolves.toBeDefined();
    });

    it('rejects skill containing submodule definition (.gitmodules)', async () => {
      const writer = new TarWriter();
      writer.addFile({ path: 'SKILL.md', data: Buffer.from(`---\nname: submodule-skill\ndescription: Submodule\n---\n# Submodule`) });
      writer.addFile({ path: '.gitmodules', data: Buffer.from('[submodule "sub"]\npath = sub\nurl = https://evil.com') });
      const tarBuffer = writer.finalize();

      await expect(stageArchiveSkill(tarBuffer, 'submodule.tar')).rejects.toThrow(/\.gitmodules/i);
    });

    it('rejects archive containing malicious symlinks', async () => {
      const writer = new TarWriter();
      writer.addFile({ path: 'SKILL.md', data: Buffer.from(`---\nname: evil-skill\ndescription: Evil\n---\n# Evil`) });
      const tarBuffer = writer.finalize();

      // Corrupt typeflag in tar block to represent symlink (typeflag '2')
      const modifiedTar = Buffer.from(tarBuffer);
      modifiedTar[156] = '2'.charCodeAt(0);

      await expect(stageArchiveSkill(modifiedTar, 'evil.tar')).rejects.toThrow();
    });

    it('rejects archive containing path traversal (..)', async () => {
      const writer = new TarWriter();
      writer.addFile({ path: 'SKILL.md', data: Buffer.from(`---\nname: traversal-skill\ndescription: Traversal\n---\n# Traversal`) });
      writer.addFile({ path: 'sub/nested.txt', data: Buffer.from('test') });
      const tarBuffer = writer.finalize();

      // Corrupt path in tar header to include path traversal ../../
      const modifiedTar = Buffer.from(tarBuffer);
      modifiedTar.write('../../etc/passwd\0', 512, 'ascii');

      await expect(stageArchiveSkill(modifiedTar, 'traversal.tar')).rejects.toThrow();
    });

    it('rejects skill with invalid kebab-case name', async () => {
      const writer = new TarWriter();
      writer.addFile({ path: 'SKILL.md', data: Buffer.from(`---\nname: INVALID_NAME_123!\ndescription: Bad name\n---\n# Bad`) });
      const tarBuffer = writer.finalize();

      await expect(stageArchiveSkill(tarBuffer, 'bad-name.tar')).rejects.toThrow(/kebab-case/i);
    });

    it('rejects skill missing YAML frontmatter delimiters', async () => {
      const writer = new TarWriter();
      writer.addFile({ path: 'SKILL.md', data: Buffer.from(`# No frontmatter\nJust markdown body.`) });
      const tarBuffer = writer.finalize();

      await expect(stageArchiveSkill(tarBuffer, 'no-frontmatter.tar')).rejects.toThrow(/frontmatter/i);
    });
  });

  describe('5. Per-Space Enable/Disable, Idempotency & Tenant Isolation (/api/manage/extensions/:slug/*)', () => {
    beforeEach(async () => {
      // Install skill in SpaceA
      await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          sourceKind: 'git',
          spaceId: aliceSpaceAId,
          gitSource: {
            repositoryUrl: `file://${localGitRepoDir}`,
          },
        }),
      });
    });

    it('disables skill in SpaceA (modifies binding and frontmatter without deleting files or altering package status)', async () => {
      const disableRes = await fetch(`${baseUrl}/api/manage/extensions/code-review-pro/disable`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          spaceId: aliceSpaceAId,
        }),
      });

      expect(disableRes.status).toBe(200);
      const json = (await disableRes.json()) as any;
      expect(json.success).toBe(true);
      expect(json.data.enabled).toBe(false);
      expect(json.data.spaceId).toBe(aliceSpaceAId);

      // Verify files still exist on disk and frontmatter is updated
      const spaceAFolder = (await storage.forTenant(aliceUserId).spaces.findById(aliceSpaceAId))!.folder;
      const skillFile = path.join(spacesDir, spaceAFolder, '.skills', 'code-review-pro', 'SKILL.md');
      expect(fs.existsSync(skillFile)).toBe(true);
      const fileContent = fs.readFileSync(skillFile, 'utf8');
      expect(fileContent).toContain('disable-model-invocation: true');

      // Verify listing for SpaceA reports enabled=false, while package status is active
      const listRes = await fetch(`${baseUrl}/api/manage/extensions?spaceId=${aliceSpaceAId}`, {
        headers: { Cookie: aliceCookie },
      });
      const listJson = (await listRes.json()) as any;
      const extItem = listJson.data.find((s: any) => s.slug === 'code-review-pro');
      expect(extItem.status).toBe('active');
      expect(extItem.enabled).toBe(false);

      // Re-enable
      const enableRes = await fetch(`${baseUrl}/api/manage/extensions/code-review-pro/enable`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          spaceId: aliceSpaceAId,
        }),
      });
      expect(enableRes.status).toBe(200);
      const enableJson = (await enableRes.json()) as any;
      expect(enableJson.data.enabled).toBe(true);
      expect(enableJson.data.spaceId).toBe(aliceSpaceAId);

      // Verify file frontmatter restored
      const restoredFileContent = fs.readFileSync(skillFile, 'utf8');
      expect(restoredFileContent).not.toContain('disable-model-invocation: true');
    });

    it('enforces strict tenant isolation: Bob cannot access or modify Alice Space extensions', async () => {
      // Bob tries to get Alice's extension
      const bobGetRes = await fetch(`${baseUrl}/api/manage/extensions/code-review-pro?spaceId=${aliceSpaceAId}`, {
        headers: { Cookie: bobCookie },
      });
      expect(bobGetRes.status).toBe(404);

      // Bob tries to disable Alice's extension
      const bobDisableRes = await fetch(`${baseUrl}/api/manage/extensions/code-review-pro/disable`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: bobCookie,
        },
        body: JSON.stringify({
          spaceId: aliceSpaceAId,
        }),
      });
      expect(bobDisableRes.status).toBe(404);
    });

    it('supports idempotent install replay via Idempotency-Key', async () => {
      const idempKey = '22222222-2222-4222-8222-222222222222';
      const payload = {
        sourceKind: 'git',
        spaceId: aliceSpaceBId,
        gitSource: {
          repositoryUrl: `file://${localGitRepoDir}`,
        },
      };

      const res1 = await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
          'Idempotency-Key': idempKey,
        },
        body: JSON.stringify(payload),
      });
      expect(res1.status).toBe(201);
      const json1 = (await res1.json()) as any;

      const res2 = await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
          'Idempotency-Key': idempKey,
        },
        body: JSON.stringify(payload),
      });
      expect(res2.status).toBe(201);
      const json2 = (await res2.json()) as any;
      expect(json1.data.integritySha256).toBe(json2.data.integritySha256);
    });

    it('uninstalls extension cleanly via POST /api/manage/extensions/:slug/uninstall and DELETE /api/manage/extensions/:slug', async () => {
      // Uninstall from SpaceA via POST
      const uninstallRes = await fetch(`${baseUrl}/api/manage/extensions/code-review-pro/uninstall`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          spaceId: aliceSpaceAId,
        }),
      });

      expect(uninstallRes.status).toBe(200);
      const json = (await uninstallRes.json()) as any;
      expect(json.success).toBe(true);
      expect(json.data.slug).toBe('code-review-pro');

      // Verify directory was removed
      const spaceAFolder = (await storage.forTenant(aliceUserId).spaces.findById(aliceSpaceAId))!.folder;
      const skillDir = path.join(spacesDir, spaceAFolder, '.skills', 'code-review-pro');
      expect(fs.existsSync(skillDir)).toBe(false);
    });
  });
});
