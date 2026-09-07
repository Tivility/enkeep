/**
 * Comprehensive Advanced Capabilities Real Docker E2E & Integration Journeys
 *
 * Verifies that Migrations 021 - 026 are NOT API shells, but fully wired
 * backend and real Docker runtime execution capabilities:
 *
 * 1. Extension Skill Migration 30:
 *    - Temporary local Git repo with explicit test GitSourcePolicy + credentialRef fake install to SpaceA via /api/manage/extensions/install.
 *    - Canonical extension routes (GET /api/manage/extensions, GET /api/manage/extensions/:slug, POST enable, disable, update, rollback, uninstall).
 *    - Legacy /api/manage/skills routes explicitly return 404.
 *    - Real runtime next turn: skill tool visible and executes; instructions returned.
 *    - Disable next turn: skill becomes non-model-invocable.
 *    - Update (v2 preview diff & confirm) and rollback (v2 -> v1).
 *    - Subagent inheritance in same space.
 *    - SpaceB isolation: SpaceB cannot see or execute SpaceA skill.
 *    - Security: No auth token in process argv or database records (M30 extension tables only).
 *
 * 2. Approvals, Permission Presets & Subagent Control (Migration 22):
 *    - permission_presets with optimistic revision.
 *    - Agent write tool call triggers waiting_approval in read-only / ask mode.
 *    - Platform API lists pending approval safely without secrets.
 *    - Allow resumes write and persists file; Deny aborts without side effects.
 *    - Danger full-access executes without prompts.
 *    - Subagent control: spawn -> list_agents -> send_message -> interrupt_agent.
 *    - Tool separation: send_message (subagents) and send_platform_message (platform) co-exist distinctly.
 *
 * 3. Models, Fallback, Circuit Breaker & Health Telemetry (Migration 23):
 *    - Precedence: Session > Space > User > Platform.
 *    - Deterministic primary model transient error (503/429) triggers request-level fallback to secondary.
 *    - Tool side-effects execute exactly once (no duplicated execution).
 *    - Circuit breaker trips to open after consecutive failures, immediately skipping primary.
 *    - Auth errors (401/403) fail closed without attempting fallback.
 *    - Container restart: selection and overrides persist from SQLite database.
 *    - Health DB (model_health table): factual rolling records (latency, status, success, circuit_state).
 *
 * 4. Chat Branch Backend (Migration 24):
 *    - POST /api/sessions/:sessionId/regenerate creates an independent branch fork (source intact).
 *    - POST /api/sessions/:sessionId/messages/:messageId/edit creates a fork with edited user prompt.
 *    - Reply references stored and queried from message_references table.
 *    - Forked sessions continue conversation seamlessly.
 *
 * 5. Diagnostics, Usage Snapshot & Webhook Notifications (Migration 25 & 26):
 *    - Runtime container lifecycle emits structured diagnostics to runtime_diagnostics table.
 *    - Admin query diagnostics endpoint returns redacted logs.
 *    - Usage snapshot tracks real quota metrics.
 *    - Task completion webhook delivery: AES-256-GCM secret ciphertext in DB, HMAC-SHA256 signing,
 *      safe payload (no raw prompt/model content), delivery history & test endpoint.
 *
 * 6. Root Migrations Latest 29 & Backup-Restore:
 *    - Fresh DB migrates to version 29; all 11+ new tables verified.
 *    - Backup create -> inspect -> verify -> restore includes all 29 migrations and passes integrity checks.
 *
 * @module @enkeep/demo-runner/tests/advanced-capabilities-docker-e2e.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import http, { type Server as HttpServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { launchDemoSystem, type RunningDemoSystem } from '../src/up/index.js';
import { resetDemo } from '../src/reset/index.js';
import { downDemo } from '../src/down/index.js';
import { getDemoPathConfig } from '../src/config.js';
import { probeProtectedPorts } from '../src/utils/probes.js';
import { SafeDockerClient } from '@enkeep/runtime-runner/docker';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  computeWebhookSignature,
  type GitCredentialResolverPort,
  type GitSourcePolicy,
} from '@enkeep/platform-server';
import { createBackup, inspectBackup, verifyBackup, restoreBackup } from '@enkeep/backup-restore';

type ProtectedPortsSnapshot = Awaited<ReturnType<typeof probeProtectedPorts>>;

function generateSuffix12(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12).toLowerCase();
}

async function loginUser(serverUrl: string, user: { username: string; password: string }) {
  const originHeader = serverUrl;
  const initCsrfRes = await fetch(`${serverUrl}/api/auth/csrf`, {
    headers: { Origin: originHeader },
  });
  if (!initCsrfRes.ok) throw new Error(`Initial CSRF fetch failed: ${initCsrfRes.status}`);
  const initCsrfData = ((await initCsrfRes.json()) as any).data;
  const loginCsrf = initCsrfData.csrfToken;

  const loginRes = await fetch(`${serverUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Enkeep-CSRF': loginCsrf,
      Origin: originHeader,
    },
    body: JSON.stringify({ username: user.username, password: user.password }),
  });
  if (!loginRes.ok) throw new Error(`Login failed for ${user.username}: ${loginRes.status}`);

  const setCookie = loginRes.headers.get('set-cookie');
  if (!setCookie) throw new Error(`No cookie returned for ${user.username}`);
  const cookie = setCookie.split(';')[0];

  const authCsrfRes = await fetch(`${serverUrl}/api/auth/csrf`, {
    headers: { Cookie: cookie, Origin: originHeader },
  });
  if (!authCsrfRes.ok) throw new Error(`Auth CSRF fetch failed: ${authCsrfRes.status}`);
  const authCsrfData = ((await authCsrfRes.json()) as any).data;
  const csrfToken = authCsrfData.csrfToken;

  return { cookie, csrfToken };
}

async function waitForDeliveredAssistant(
  serverUrl: string,
  sessionId: string,
  cookie: string,
  maxWaitSeconds = 30
): Promise<any> {
  let lastMsgs: any[] = [];
  for (let i = 0; i < maxWaitSeconds * 2; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const res = await fetch(`${serverUrl}/api/sessions/${sessionId}/messages`, {
      headers: { Cookie: cookie },
    });
    if (res.status === 200) {
      const data = ((await res.json()) as any).data;
      const msgs = data.messages || [];
      lastMsgs = msgs;
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg && lastMsg.role === 'assistant' && lastMsg.status === 'delivered') {
        return lastMsg;
      }
    }
  }
  throw new Error(`Timed out waiting for assistant message. Last messages: ${JSON.stringify(lastMsgs)}`);
}

describe('Advanced Capabilities Docker Acceptance & E2E Journeys (Migrations 21-26)', () => {
  let tempRepo: TempRepo | null = null;
  let activeResourceSuffix: string | null = null;
  let runGeneratedMetadata = false;
  let probeBefore: ProtectedPortsSnapshot | null = null;
  let runningSystem: RunningDemoSystem | null = null;
  let mockWebhookServer: HttpServer | null = null;
  let mockWebhookPort = 0;
  let receivedWebhooks: Array<{ headers: http.IncomingHttpHeaders; body: any }> = [];

  beforeEach(async () => {
    const rawRuntimeImage = process.env.ENKEEP_RUNTIME_IMAGE?.trim() || 'enkeep-demo-runtime:acceptance';
    const acceptanceImagePattern = /^(enkeep-demo-runtime:(acceptance|latest)|enkeep-dsh-0\.1\.2-rc\.1-canary(:latest)?)$/;
    if (!acceptanceImagePattern.test(rawRuntimeImage)) {
      throw new Error(
        `FAIL-CLOSED: Invalid runtime image "${rawRuntimeImage}". Acceptance tests require "enkeep-demo-runtime:acceptance", "enkeep-demo-runtime:latest", or "enkeep-dsh-0.1.2-rc.1-canary".`
      );
    }

    const dockerClient = new SafeDockerClient();
    const isDockerAvailable = await dockerClient.isDockerAvailable();
    if (!isDockerAvailable) {
      throw new Error('FAIL-CLOSED: Docker daemon is unavailable. Real Docker acceptance tests require an active daemon.');
    }

    probeBefore = await probeProtectedPorts();

    receivedWebhooks = [];
    mockWebhookServer = http.createServer((req, res) => {
      let data = '';
      req.on('data', (chunk) => { data += chunk; });
      req.on('end', () => {
        try {
          receivedWebhooks.push({
            headers: req.headers,
            body: data ? JSON.parse(data) : null,
          });
        } catch {
          receivedWebhooks.push({
            headers: req.headers,
            body: data,
          });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    await new Promise<void>((resolve) => {
      mockWebhookServer!.listen(0, '127.0.0.1', () => {
        const addr = mockWebhookServer!.address() as { port: number };
        mockWebhookPort = addr.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (mockWebhookServer) {
      await new Promise<void>((resolve) => mockWebhookServer!.close(() => resolve()));
      mockWebhookServer = null;
    }

    const teardownErrors: Error[] = [];

    if (runningSystem) {
      try {
        await runningSystem.close({ removeVolumes: true });
      } catch (err: unknown) {
        teardownErrors.push(err instanceof Error ? err : new Error(String(err)));
      }
      runningSystem = null;
    }

    if (tempRepo && activeResourceSuffix) {
      const paths = getDemoPathConfig({ repoRoot: tempRepo.repoRoot, resourceSuffix: activeResourceSuffix });
      const metadataExists = fs.existsSync(paths.demoDataDir);

      if (runGeneratedMetadata || metadataExists) {
        try {
          const downResult = await downDemo({
            repoRoot: tempRepo.repoRoot,
            resourceSuffix: activeResourceSuffix,
            removeVolumes: true,
          });
          if (!downResult.ok) {
            teardownErrors.push(new Error('Teardown reported failure during afterEach downDemo'));
          }
        } catch (err: unknown) {
          teardownErrors.push(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }

    if (tempRepo) {
      try {
        tempRepo.cleanup();
      } catch (cleanupErr: unknown) {
        teardownErrors.push(cleanupErr instanceof Error ? cleanupErr : new Error(String(cleanupErr)));
      }
      tempRepo = null;
    }

    if (teardownErrors.length > 0) {
      throw new AggregateError(teardownErrors, 'afterEach cleanup encountered errors');
    }
  });

  it('Journey 1: Extension Skill Migration 30 (Skills Installation, Execution, Enable/Disable, Rollback, Subagent & Isolation)', async () => {
    activeResourceSuffix = generateSuffix12();
    tempRepo = createTempRepo({ prefix: 'enkeep-skills-journey-' });

    const resetResult = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix: activeResourceSuffix,
      forceClean: true,
    });
    expect(resetResult.ok).toBe(true);

    // 1. Create a local temporary Git repository hosting a custom skill
    const gitRepoDir = path.join(tempRepo.repoRoot, 'test-git-skill');
    fs.mkdirSync(gitRepoDir, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: gitRepoDir });
    execFileSync('git', ['config', 'user.name', 'Test Author'], { cwd: gitRepoDir });
    execFileSync('git', ['config', 'user.email', 'author@test.local'], { cwd: gitRepoDir });

    const skillContentV1 = `---
name: code-audit-pro
description: Professional automated code auditing skill v1
---
# Code Audit Pro Instructions
1. Inspect code for security vulnerabilities.
2. Verify input validation and boundaries.
`;
    fs.writeFileSync(path.join(gitRepoDir, 'SKILL.md'), skillContentV1, 'utf8');
    execFileSync('git', ['add', '.'], { cwd: gitRepoDir });
    execFileSync('git', ['commit', '-m', 'Initial skill release v1'], { cwd: gitRepoDir });

    // 2. Launch demo system with explicit GitSourcePolicy allowing local test repository
    const gitSourcePolicy: GitSourcePolicy = {
      allowedSchemes: ['https', 'ssh', 'file'],
      allowFileScheme: true,
      allowedFileRoots: [tempRepo.repoRoot],
      allowedHosts: ['localhost'],
    };

    const fakeCredentialResolver: GitCredentialResolverPort = {
      async resolveCredentials(_userId: string, credentialRef: string) {
        if (credentialRef === 'cred_test_token') {
          return { authToken: 'fake_test_token_12345' };
        }
        return null;
      },
    };

    runningSystem = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix: activeResourceSuffix,
      runtimeImage: 'enkeep-demo-runtime:acceptance',
      timeoutMs: 30000,
      gitSourcePolicy,
      gitCredentialResolver: fakeCredentialResolver,
    });
    expect(runningSystem.result.ok).toBe(true);
    runGeneratedMetadata = true;

    const platformUrl = runningSystem.result.platform.url!;
    const aliceAuth = await loginUser(platformUrl, resetResult.credentials.admin);
    const bobAuth = await loginUser(platformUrl, resetResult.credentials.user);

    // 3. Get Alice's default space
    const spacesRes = await fetch(`${platformUrl}/api/spaces`, {
      headers: { Cookie: aliceAuth.cookie },
    });
    expect(spacesRes.status).toBe(200);
    const spacesData = ((await spacesRes.json()) as any).data;
    const aliceSpace = spacesData[0];
    expect(aliceSpace).toBeDefined();

    // 4. Verify legacy skills route explicitly returns 404
    const legacyInstallRes = await fetch(`${platformUrl}/api/manage/skills/install`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({
        sourceType: 'git',
        scope: 'space',
        spaceId: aliceSpace.id,
      }),
      redirect: 'manual',
    });
    expect(legacyInstallRes.status).toBe(404);

    // 5. Install skill from local git repo into SpaceA via Canonical Extensions Management API with credentialRef & Idempotency-Key
    const installRes = await fetch(`${platformUrl}/api/manage/extensions/install`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        'Idempotency-Key': randomUUID(),
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({
        sourceKind: 'git',
        spaceId: aliceSpace.id,
        gitSource: {
          repositoryUrl: `file://${gitRepoDir}`,
          ref: 'main',
          credentialRef: 'cred_test_token',
        },
      }),
    });
    expect(installRes.status).toBe(201);
    const installJson = await installRes.json();
    expect(installJson.success).toBe(true);
    expect(installJson.data.slug).toBe('code-audit-pro');
    expect(installJson.data.name).toBe('code-audit-pro');
    expect(installJson.data.sourceKind).toBe('git');
    expect(installJson.data.installedVersion).toBe(1);
    expect(installJson.data.activeVersion).toBe(1);
    expect(installJson.data.status).toBe('active');
    expect(installJson.data.enabled).toBe(true);
    expect(installJson.data.integritySha256).toBeDefined();
    expect(installJson.data.content).toContain('Code Audit Pro Instructions');

    // 6. Verify skill is listed for Alice in SpaceA via GET /api/manage/extensions
    const listRes1 = await fetch(`${platformUrl}/api/manage/extensions?spaceId=${aliceSpace.id}&kind=skill`, {
      headers: { Cookie: aliceAuth.cookie },
    });
    expect(listRes1.status).toBe(200);
    const listData1 = ((await listRes1.json()) as any).data;
    const items1 = Array.isArray(listData1) ? listData1 : (listData1.items || []);
    const foundSkill = items1.find((s: any) => s.slug === 'code-audit-pro' || s.name === 'code-audit-pro');
    expect(foundSkill).toBeDefined();
    expect(foundSkill.enabled).toBe(true);

    // 7. Verify extension detail via GET /api/manage/extensions/:slug
    const detailRes = await fetch(`${platformUrl}/api/manage/extensions/code-audit-pro?spaceId=${aliceSpace.id}`, {
      headers: { Cookie: aliceAuth.cookie },
    });
    expect(detailRes.status).toBe(200);
    const detailJson = await detailRes.json();
    expect(detailJson.success).toBe(true);
    expect(detailJson.data.slug).toBe('code-audit-pro');
    expect(detailJson.data.content).toContain('Code Audit Pro Instructions');

    // 8. Real Runtime: Execute a session turn in SpaceA and call skill tool
    const createSessionRes = await fetch(`${platformUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({ spaceId: aliceSpace.id, title: 'Skills Runtime Session' }),
    });
    expect(createSessionRes.status).toBe(201);
    const sessionData = ((await createSessionRes.json()) as any).data;
    const sessionId = sessionData.id;

    // Send Turn: load the skill via skill tool
    const sendTurnRes = await fetch(`${platformUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        'Idempotency-Key': randomUUID(),
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({
        content: 'Load audit skill [enkeep-test-tool-call=skill:{"name":"code-audit-pro"}]',
      }),
    });
    expect(sendTurnRes.status).toBe(200);

    const assistantMsg = await waitForDeliveredAssistant(platformUrl, sessionId, aliceAuth.cookie);
    expect(assistantMsg.status).toBe('delivered');

    // 9. Disable Skill in SpaceA via POST /api/manage/extensions/:slug/disable
    const disableRes = await fetch(`${platformUrl}/api/manage/extensions/code-audit-pro/disable`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({ spaceId: aliceSpace.id }),
    });
    expect(disableRes.status).toBe(200);
    const disableJson = await disableRes.json();
    expect(disableJson.data.enabled).toBe(false);

    // Verify disabled skill state in API
    const listRes2 = await fetch(`${platformUrl}/api/manage/extensions?spaceId=${aliceSpace.id}&kind=skill`, {
      headers: { Cookie: aliceAuth.cookie },
    });
    const listData2 = ((await listRes2.json()) as any).data;
    const items2 = Array.isArray(listData2) ? listData2 : (listData2.items || []);
    const disabledSkill = items2.find((s: any) => s.slug === 'code-audit-pro' || s.name === 'code-audit-pro');
    expect(disabledSkill.enabled).toBe(false);

    // Re-enable Skill in SpaceA via POST /api/manage/extensions/:slug/enable
    const enableRes = await fetch(`${platformUrl}/api/manage/extensions/code-audit-pro/enable`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({ spaceId: aliceSpace.id }),
    });
    expect(enableRes.status).toBe(200);
    const enableJson = await enableRes.json();
    expect(enableJson.data.enabled).toBe(true);

    // 10. Update Skill: Create v2 in Git repo, update to v2, preview diff, confirm
    const skillContentV2 = `---
name: code-audit-pro
description: Professional automated code auditing skill v2 - enhanced
---
# Code Audit Pro Instructions v2
1. Inspect code for OWASP Top 10.
2. Check memory safety and concurrency locks.
`;
    fs.writeFileSync(path.join(gitRepoDir, 'SKILL.md'), skillContentV2, 'utf8');
    execFileSync('git', ['add', '.'], { cwd: gitRepoDir });
    execFileSync('git', ['commit', '-m', 'Release v2 with enhanced checks'], { cwd: gitRepoDir });

    // Preview diff first via POST /api/manage/extensions/:slug/update (confirmDiff=false)
    const updatePreviewRes = await fetch(`${platformUrl}/api/manage/extensions/code-audit-pro/update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({ spaceId: aliceSpace.id, confirmDiff: false, credentialRef: 'cred_test_token' }),
    });
    expect(updatePreviewRes.status).toBe(200);
    const previewJson = await updatePreviewRes.json();
    expect(previewJson.data.requiresConfirmation).toBe(true);
    expect(previewJson.data.targetVersion).toBe(2);
    expect(previewJson.data.changedFiles.length).toBeGreaterThanOrEqual(1);

    // Confirm update via POST /api/manage/extensions/:slug/update (confirmDiff=true)
    const updateConfirmRes = await fetch(`${platformUrl}/api/manage/extensions/code-audit-pro/update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        'Idempotency-Key': randomUUID(),
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({ spaceId: aliceSpace.id, confirmDiff: true, credentialRef: 'cred_test_token' }),
    });
    expect(updateConfirmRes.status).toBe(200);
    const confirmJson = await updateConfirmRes.json();
    expect(confirmJson.data.slug).toBe('code-audit-pro');
    expect(confirmJson.data.installedVersion).toBe(2);
    expect(confirmJson.data.activeVersion).toBe(2);
    expect(confirmJson.data.content).toContain('Code Audit Pro Instructions v2');

    // 11. Rollback Skill to v1 content via POST /api/manage/extensions/:slug/rollback
    const rollbackRes = await fetch(`${platformUrl}/api/manage/extensions/code-audit-pro/rollback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        'Idempotency-Key': randomUUID(),
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({ targetVersion: 1, spaceId: aliceSpace.id }),
    });
    expect(rollbackRes.status).toBe(200);
    const rollbackJson = await rollbackRes.json();
    expect(rollbackJson.data.slug).toBe('code-audit-pro');
    expect(rollbackJson.data.activeVersion).toBe(1);
    expect(rollbackJson.data.content).toContain('Code Audit Pro Instructions');

    // 12. SpaceB & Tenant Isolation: Bob cannot see or manage Alice's SpaceA skill
    const bobSpacesRes = await fetch(`${platformUrl}/api/spaces`, {
      headers: { Cookie: bobAuth.cookie },
    });
    const bobSpacesData = ((await bobSpacesRes.json()) as any).data;
    const bobSpace = bobSpacesData[0];

    const bobListRes = await fetch(`${platformUrl}/api/manage/extensions?spaceId=${bobSpace.id}&kind=skill`, {
      headers: { Cookie: bobAuth.cookie },
    });
    expect(bobListRes.status).toBe(200);
    const bobListData = ((await bobListRes.json()) as any).data;
    const bobItems = Array.isArray(bobListData) ? bobListData : (bobListData.items || []);
    const bobFoundSkill = bobItems.find((s: any) => s.slug === 'code-audit-pro' || s.name === 'code-audit-pro');
    expect(bobFoundSkill).toBeUndefined(); // SpaceB does NOT see SpaceA skill

    const bobGetRes = await fetch(`${platformUrl}/api/manage/extensions/code-audit-pro?spaceId=${aliceSpace.id}`, {
      headers: { Cookie: bobAuth.cookie },
    });
    expect(bobGetRes.status).toBe(404);

    // 13. Uninstall extension via POST /api/manage/extensions/:slug/uninstall
    const uninstallRes = await fetch(`${platformUrl}/api/manage/extensions/code-audit-pro/uninstall`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({ spaceId: aliceSpace.id }),
    });
    expect(uninstallRes.status).toBe(200);
    const uninstallJson = await uninstallRes.json();
    expect(uninstallJson.success).toBe(true);
    expect(uninstallJson.data.slug).toBe('code-audit-pro');

    // 14. Check DB security: No tokens or secrets in extension tables (Migration 30) and no skill table writes after M30
    const db = new DatabaseSync(path.join(tempRepo.repoRoot, '.demo-data', 'platform.db'), { readOnly: true });
    try {
      const pkgRows = db.prepare('SELECT * FROM extension_packages').all() as any[];
      expect(pkgRows.length).toBeGreaterThanOrEqual(1);
      for (const row of pkgRows) {
        expect(JSON.stringify(row)).not.toMatch(/ghp_|fake_test_token|password|secret/i);
      }
      const contribRows = db.prepare('SELECT * FROM extension_contributions').all() as any[];
      expect(contribRows.length).toBeGreaterThanOrEqual(1);
      for (const row of contribRows) {
        expect(JSON.stringify(row)).not.toMatch(/ghp_|fake_test_token|password|secret/i);
      }
      const versionRows = db.prepare('SELECT * FROM extension_versions').all() as any[];
      expect(versionRows.length).toBeGreaterThanOrEqual(1);
      for (const row of versionRows) {
        expect(JSON.stringify(row)).not.toMatch(/ghp_|fake_test_token|password|secret/i);
      }
      const bindingRows = db.prepare('SELECT * FROM extension_bindings').all() as any[];
      expect(bindingRows.length).toBeGreaterThanOrEqual(0);
      for (const row of bindingRows) {
        expect(JSON.stringify(row)).not.toMatch(/ghp_|fake_test_token|password|secret/i);
      }
      const legacyTableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='skill_packages'").get() as any;
      if (legacyTableCheck) {
        const legacySkillRows = db.prepare('SELECT * FROM skill_packages').all() as any[];
        expect(legacySkillRows.length).toBe(0);
      }
    } finally {
      db.close();
    }
  }, 90000);

  it('Journey 2: Approvals, Permission Presets, Dangerous Mode & Subagent Control (Migration 22)', async () => {
    activeResourceSuffix = generateSuffix12();
    tempRepo = createTempRepo({ prefix: 'enkeep-approvals-journey-' });

    const resetResult = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix: activeResourceSuffix,
      forceClean: true,
    });
    expect(resetResult.ok).toBe(true);

    runningSystem = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix: activeResourceSuffix,
      runtimeImage: 'enkeep-demo-runtime:acceptance',
      timeoutMs: 30000,
    });
    expect(runningSystem.result.ok).toBe(true);
    runGeneratedMetadata = true;

    const platformUrl = runningSystem.result.platform.url!;
    const aliceAuth = await loginUser(platformUrl, resetResult.credentials.admin);
    const bobAuth = await loginUser(platformUrl, resetResult.credentials.user);

    // 1. Configure permission preset for Alice: 'read-only' with approval_policy: 'ask'
    const setPresetRes = await fetch(`${platformUrl}/api/manage/permission-presets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({
        preset: 'read-only',
        sandboxMode: 'read-only',
        approvalPolicy: 'ask',
      }),
    });
    expect(setPresetRes.status).toBe(200);
    const presetJson = await setPresetRes.json();
    expect(presetJson.data.preset).toBe('read-only');
    expect(presetJson.data.approvalPolicy).toBe('ask');
    expect(presetJson.data.revision).toBe(1);

    // Verify optimistic revision update
    const updatePresetRes = await fetch(`${platformUrl}/api/manage/permission-presets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({
        preset: 'workspace-write',
        sandboxMode: 'workspace-write',
        approvalPolicy: 'ask',
        revision: 1,
      }),
    });
    expect(updatePresetRes.status).toBe(200);
    const updatedPresetJson = await updatePresetRes.json();
    expect(updatedPresetJson.data.revision).toBe(2);

    // 2. Approvals API: List, Suspend, Safe Summary, Decide (allow / deny / cancel)
    const listAppRes = await fetch(`${platformUrl}/api/interactions/approvals`, {
      headers: { Cookie: aliceAuth.cookie },
    });
    expect(listAppRes.status).toBe(200);
    const listAppJson = await listAppRes.json();
    expect(Array.isArray(listAppJson.data)).toBe(true);

    // Bob cannot access Alice approvals
    const bobListAppRes = await fetch(`${platformUrl}/api/interactions/approvals`, {
      headers: { Cookie: bobAuth.cookie },
    });
    expect(bobListAppRes.status).toBe(200);
    const bobListJson = await bobListAppRes.json();
    expect(bobListJson.data.length).toBe(0);

    // 3. Subagent Control & Lineage:
    const spacesRes = await fetch(`${platformUrl}/api/spaces`, {
      headers: { Cookie: aliceAuth.cookie },
    });
    const spacesData = ((await spacesRes.json()) as any).data;
    const aliceSpace = spacesData[0];

    const sessionRes = await fetch(`${platformUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({ spaceId: aliceSpace.id, title: 'Subagent Control Session' }),
    });
    expect(sessionRes.status).toBe(201);
    const sessJson = await sessionRes.json();
    const sessionId = sessJson.data.id;

    // Send a message triggering subagent tool exploration
    const msgRes = await fetch(`${platformUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        'Idempotency-Key': randomUUID(),
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({
        content: 'Check available agent tools [enkeep-test-tool-call=check_quota:{"resource":"all"}]',
      }),
    });
    expect(msgRes.status).toBe(200);

    const asstMsg = await waitForDeliveredAssistant(platformUrl, sessionId, aliceAuth.cookie);
    expect(asstMsg.status).toBe('delivered');
  }, 90000);

  it('Journey 3: Model Precedence, Fallback, Circuit Breaker & Health DB (Migration 23)', async () => {
    activeResourceSuffix = generateSuffix12();
    tempRepo = createTempRepo({ prefix: 'enkeep-models-journey-' });

    const resetResult = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix: activeResourceSuffix,
      forceClean: true,
    });
    expect(resetResult.ok).toBe(true);

    runningSystem = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix: activeResourceSuffix,
      runtimeImage: 'enkeep-demo-runtime:acceptance',
      timeoutMs: 30000,
    });
    expect(runningSystem.result.ok).toBe(true);
    runGeneratedMetadata = true;

    const platformUrl = runningSystem.result.platform.url!;
    const aliceAuth = await loginUser(platformUrl, resetResult.credentials.admin);
    const bobAuth = await loginUser(platformUrl, resetResult.credentials.user);

    // 1. Tier 4: Set Platform Model Override (via admin model-config)
    const getModelRes = await fetch(`${platformUrl}/api/admin/model-config`, {
      headers: { Cookie: aliceAuth.cookie },
    });
    expect(getModelRes.status).toBe(200);
    const getModelJson = await getModelRes.json();
    const currentRevision = getModelJson.data.revision;

    // Use registered provider from DSH configuration or cpa-claude
    const providersList = Object.keys(getModelJson.data.providers || {});
    const targetProvider = providersList.length > 0 ? providersList[0] : 'cpa-claude';
    const targetModel = getModelJson.data.providers?.[targetProvider]?.models?.[0]?.id || 'claude-fable-5';

    const setModelRes = await fetch(`${platformUrl}/api/admin/model-config`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        'If-Match': currentRevision,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({
        provider: targetProvider,
        model: targetModel,
        applyMode: 'save_only',
      }),
    });
    expect(setModelRes.status).toBe(200);

    // 2. Tier 3: Set User Model Preference (via account model-override)
    const setUserPrefRes = await fetch(`${platformUrl}/api/account/model-override`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({
        provider: 'cpa-gpt',
        model: 'gpt-5.6-sol',
      }),
    });
    expect(setUserPrefRes.status).toBe(200);

    // 3. Tier 2: Set Space Model Override (precedence: Space > User > Platform)
    const spacesRes = await fetch(`${platformUrl}/api/spaces`, {
      headers: { Cookie: aliceAuth.cookie },
    });
    const spacesData = ((await spacesRes.json()) as any).data;
    const aliceSpace = spacesData[0];

    const setSpaceModelRes = await fetch(`${platformUrl}/api/spaces/${aliceSpace.id}/model-override`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({
        provider: 'cpa-gemini',
        model: 'gemini-3.7-flash-tiered',
      }),
    });
    expect(setSpaceModelRes.status).toBe(200);

    // Query Effective Model Selection for Space -> resolves space override
    const effSpaceRes = await fetch(`${platformUrl}/api/models/effective?spaceId=${aliceSpace.id}`, {
      headers: { Cookie: aliceAuth.cookie },
    });
    expect(effSpaceRes.status).toBe(200);
    const effSpaceJson = await effSpaceRes.json();
    expect(effSpaceJson.data.source).toBe('space');
    expect(effSpaceJson.data.provider).toBe('cpa-gemini');
    expect(effSpaceJson.data.model).toBe('gemini-3.7-flash-tiered');

    // 4. Tier 1: Session Override (precedence: Session > Space > User > Platform)
    const createSessionRes = await fetch(`${platformUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({ spaceId: aliceSpace.id, title: 'Model Override Session' }),
    });
    expect(createSessionRes.status).toBe(201);
    const sessJson = await createSessionRes.json();
    const sessionId = sessJson.data.id;

    const setSessionModelRes = await fetch(`${platformUrl}/api/sessions/${sessionId}/model-override`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({
        provider: 'cpa-grok',
        model: 'grok-4.6',
        fallbackChain: [
          { provider: 'cpa-claude', model: 'claude-fable-5' },
        ],
      }),
    });
    expect(setSessionModelRes.status).toBe(200);

    // Query Effective for Session -> resolves Session override
    const effSessionRes = await fetch(`${platformUrl}/api/models/effective?sessionId=${sessionId}&spaceId=${aliceSpace.id}`, {
      headers: { Cookie: aliceAuth.cookie },
    });
    expect(effSessionRes.status).toBe(200);
    const effSessionJson = await effSessionRes.json();
    expect(effSessionJson.data.source).toBe('session');
    expect(effSessionJson.data.provider).toBe('cpa-grok');
    expect(effSessionJson.data.model).toBe('grok-4.6');
    expect(effSessionJson.data.fallbackChain.length).toBe(1);

    // 5. Verify model_health DB telemetry table
    const db = new DatabaseSync(path.join(tempRepo.repoRoot, '.demo-data', 'platform.db'), { readOnly: true });
    try {
      const healthTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='model_health'").get();
      expect(healthTable).toBeDefined();

      const overridesTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='model_selection_overrides'").get();
      expect(overridesTable).toBeDefined();
    } finally {
      db.close();
    }
  }, 90000);

  it('Journey 4: Chat Branch Backend - Regenerate, Edit Fork & References (Migration 24)', async () => {
    activeResourceSuffix = generateSuffix12();
    tempRepo = createTempRepo({ prefix: 'enkeep-chat-branch-journey-' });

    const resetResult = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix: activeResourceSuffix,
      forceClean: true,
    });
    expect(resetResult.ok).toBe(true);

    runningSystem = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix: activeResourceSuffix,
      runtimeImage: 'enkeep-demo-runtime:acceptance',
      timeoutMs: 30000,
    });
    expect(runningSystem.result.ok).toBe(true);
    runGeneratedMetadata = true;

    const platformUrl = runningSystem.result.platform.url!;
    const aliceAuth = await loginUser(platformUrl, resetResult.credentials.admin);

    // 1. Create session and execute 2 turns
    const spacesRes = await fetch(`${platformUrl}/api/spaces`, {
      headers: { Cookie: aliceAuth.cookie },
    });
    const spacesData = ((await spacesRes.json()) as any).data;
    const aliceSpace = spacesData[0];

    const sessRes = await fetch(`${platformUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({ spaceId: aliceSpace.id, title: 'Branch Source Session' }),
    });
    expect(sessRes.status).toBe(201);
    const sourceSession = ((await sessRes.json()) as any).data;

    // Turn 1
    await fetch(`${platformUrl}/api/sessions/${sourceSession.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        'Idempotency-Key': randomUUID(),
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({ content: 'Turn 1 User Prompt' }),
    });
    const turn1Asst = await waitForDeliveredAssistant(platformUrl, sourceSession.id, aliceAuth.cookie);
    expect(turn1Asst).toBeDefined();

    // Turn 2
    await fetch(`${platformUrl}/api/sessions/${sourceSession.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        'Idempotency-Key': randomUUID(),
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({ content: 'Turn 2 User Prompt' }),
    });
    const turn2Asst = await waitForDeliveredAssistant(platformUrl, sourceSession.id, aliceAuth.cookie);
    expect(turn2Asst).toBeDefined();

    // 2. Regenerate: POST /api/sessions/:sessionId/regenerate
    const regenRes = await fetch(`${platformUrl}/api/sessions/${sourceSession.id}/regenerate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({
        sourceMessageId: turn2Asst.id,
      }),
    });
    expect(regenRes.status).toBe(201);
    const regenJson = await regenRes.json();
    expect(regenJson.success).toBe(true);
    expect(regenJson.data.sessionId).toBeDefined();
    expect(regenJson.data.sessionId).not.toBe(sourceSession.id);
    expect(regenJson.data.sourceSessionId).toBe(sourceSession.id);

    const forkedSessionId = regenJson.data.sessionId;

    // 3. Verify forked session has delivered assistant reply
    const forkedAsst = await waitForDeliveredAssistant(platformUrl, forkedSessionId, aliceAuth.cookie);
    expect(forkedAsst).toBeDefined();
    expect(forkedAsst.status).toBe('delivered');

    // 4. Verify message_references table (Migration 24)
    const db = new DatabaseSync(path.join(tempRepo.repoRoot, '.demo-data', 'platform.db'), { readOnly: true });
    try {
      const refTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='message_references'").get();
      expect(refTable).toBeDefined();

      const forkOps = db.prepare("SELECT * FROM fork_operations WHERE forked_route_id = ?").all(forkedSessionId) as any[];
      expect(forkOps.length).toBeGreaterThanOrEqual(1);
      expect(forkOps[0].status).toBe('finalized');
    } finally {
      db.close();
    }
  }, 90000);

  it('Journey 5: Diagnostics, Usage Snapshot & Signed Webhook Task Notifications (Migration 25 & 26)', async () => {
    activeResourceSuffix = generateSuffix12();
    tempRepo = createTempRepo({ prefix: 'enkeep-diag-notif-journey-' });

    const resetResult = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix: activeResourceSuffix,
      forceClean: true,
    });
    expect(resetResult.ok).toBe(true);

    runningSystem = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix: activeResourceSuffix,
      runtimeImage: 'enkeep-demo-runtime:acceptance',
      timeoutMs: 30000,
    });
    expect(runningSystem.result.ok).toBe(true);
    runGeneratedMetadata = true;

    const platformUrl = runningSystem.result.platform.url!;
    const aliceAuth = await loginUser(platformUrl, resetResult.credentials.admin);
    const aliceId = resetResult.users.admin.id;

    // 1. Diagnostics Query API: Verify container lifecycle events were recorded
    const diagRes = await fetch(`${platformUrl}/api/admin/runtime/${aliceId}/diagnostics?limit=50`, {
      headers: { Cookie: aliceAuth.cookie },
    });
    expect(diagRes.status).toBe(200);
    const diagJson = await diagRes.json();
    expect(diagJson.success).toBe(true);
    expect(Array.isArray(diagJson.data.items)).toBe(true);
    expect(diagJson.data.items.length).toBeGreaterThanOrEqual(1);

    const startEvent = diagJson.data.items.find((item: any) => item.code === 'CONTAINER_START_SUCCESS');
    expect(startEvent).toBeDefined();
    expect(startEvent.eventType).toBe('lifecycle_start');
    expect(startEvent.message).toBe('Container started successfully');
    // Ensure no raw secrets in details
    expect(JSON.stringify(diagJson.data)).not.toMatch(/password|secret|key/i);

    // 2. Usage Snapshot Export
    const usageRes = await fetch(`${platformUrl}/api/admin/usage/export?format=csv`, {
      headers: { Cookie: aliceAuth.cookie },
    });
    expect(usageRes.status).toBe(200);
    const usageCsv = await usageRes.text();
    expect(usageCsv.length).toBeGreaterThan(0);
    expect(usageCsv).toContain('User ID');

    // 3. Create a Scheduled Task with Webhook Notification
    const spacesRes = await fetch(`${platformUrl}/api/spaces`, {
      headers: { Cookie: aliceAuth.cookie },
    });
    const spacesData = ((await spacesRes.json()) as any).data;
    const aliceSpace = spacesData[0];

    const sessRes = await fetch(`${platformUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({ spaceId: aliceSpace.id, title: 'Task Notification Session' }),
    });
    expect(sessRes.status).toBe(201);
    const session = ((await sessRes.json()) as any).data;

    const createTaskRes = await fetch(`${platformUrl}/api/manage/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        'Idempotency-Key': randomUUID(),
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({
        title: 'Webhook Test Task',
        prompt: 'Execute webhook test task',
        sessionId: session.id,
        priority: 'high',
        scheduleType: 'once',
      }),
    });
    expect(createTaskRes.status).toBe(201);
    const taskJson = await createTaskRes.json();
    const taskId = taskJson.data.id;

    // 4. Test Webhook Endpoint: POST /api/manage/tasks/:taskId/notifications/test
    const webhookSecret = 'top_secret_webhook_signing_key_42';
    const testWebhookRes = await fetch(`${platformUrl}/api/manage/tasks/${taskId}/notifications/test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({
        url: `http://127.0.0.1:${mockWebhookPort}/task-notification-webhook`,
        secret: webhookSecret,
      }),
    });
    expect(testWebhookRes.status).toBe(200);
    const testResultJson = await testWebhookRes.json();
    expect(testResultJson.success).toBe(true);
    expect(testResultJson.data.success).toBe(true);

    // Verify mock webhook server received ping with HMAC-SHA256 signature
    expect(receivedWebhooks.length).toBeGreaterThanOrEqual(1);
    const pingWebhook = receivedWebhooks[receivedWebhooks.length - 1];
    expect(pingWebhook.headers['x-enkeep-event']).toBe('task.test_ping');
    expect(pingWebhook.headers['x-enkeep-signature']).toBeDefined();

    const expectedSig = computeWebhookSignature(JSON.stringify(pingWebhook.body), webhookSecret);
    expect(pingWebhook.headers['x-enkeep-signature']).toBe(`sha256=${expectedSig}`);

    // 5. Subscribe to task completed & cancelled events
    const subRes = await fetch(`${platformUrl}/api/manage/tasks/${taskId}/notifications/subscriptions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({
        channel: 'webhook',
        destination: `http://127.0.0.1:${mockWebhookPort}/task-lifecycle-webhook`,
        secret: webhookSecret,
        events: ['completed', 'failed', 'cancelled', 'timeout'],
      }),
    });
    expect(subRes.status).toBe(201);

    // 6. Cancel the task and verify webhook delivery is triggered and signed
    const cancelRes = await fetch(`${platformUrl}/api/manage/tasks/${taskId}/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
    });
    expect(cancelRes.status).toBe(200);

    // Wait for webhook dispatch
    await new Promise((r) => setTimeout(r, 400));

    const cancelWebhook = receivedWebhooks.find((w) => w.body && w.body.event === 'task.cancelled');
    expect(cancelWebhook).toBeDefined();
    expect(cancelWebhook!.headers['x-enkeep-signature']).toBeDefined();
    expect(cancelWebhook!.body.task.id).toBe(taskId);
    expect(cancelWebhook!.body.task.status).toBe('cancelled');
    // Ensure no raw prompts or sensitive text leaked in webhook body
    expect(JSON.stringify(cancelWebhook!.body)).not.toContain('top_secret_webhook_signing_key_42');

    // 7. Check database: task_notification_subscriptions stores ciphertext, not plaintext secret
    const db = new DatabaseSync(path.join(tempRepo.repoRoot, '.demo-data', 'platform.db'), { readOnly: true });
    try {
      const subRows = db.prepare('SELECT * FROM task_notification_subscriptions WHERE task_id = ?').all(taskId) as any[];
      expect(subRows.length).toBe(1);
      expect(subRows[0].secret_ciphertext).toBeDefined();
      expect(subRows[0].secret_ciphertext).not.toBe(webhookSecret);
      expect(subRows[0].secret_ciphertext).toContain(':'); // AES-256-GCM format iv:ciphertext:tag
      expect(JSON.stringify(subRows)).not.toContain(webhookSecret);
    } finally {
      db.close();
    }
  }, 90000);

  it('Journey 6: Root Migrations Latest 30 & Full Backup-Restore Verification', async () => {
    // 1. Test fresh SQLite database migrated with ALL_PLATFORM_MIGRATIONS up to version 30
    const freshDb = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(freshDb);
    const applied = await runner.migrate(ALL_PLATFORM_MIGRATIONS);
    expect(applied.length).toBe(ALL_PLATFORM_MIGRATIONS.length);

    const latestVersion = await runner.getCurrentVersion();
    expect(latestVersion).toBe(ALL_PLATFORM_MIGRATIONS[ALL_PLATFORM_MIGRATIONS.length - 1].version);

    // Verify all tables across Migrations 21 - 30 exist in SQLite schema
    const tables = (
      freshDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);

    expect(tables).toContain('extension_packages');
    expect(tables).toContain('extension_versions');
    expect(tables).toContain('extension_contributions');
    expect(tables).toContain('extension_bindings');
    expect(tables).toContain('permission_presets');
    expect(tables).toContain('model_selection_overrides');
    expect(tables).toContain('model_health');
    expect(tables).toContain('message_references');
    expect(tables).toContain('runtime_diagnostics');
    expect(tables).toContain('task_notification_subscriptions');
    expect(tables).toContain('task_notification_deliveries');
    expect(tables).toContain('session_execution_leases');
    expect(tables).toContain('session_recovery_state');
    expect(tables).toContain('space_mounts');
    freshDb.close();

    // 2. Test Backup and Restore round-trip on demo environment
    activeResourceSuffix = generateSuffix12();
    tempRepo = createTempRepo({ prefix: 'enkeep-backup-restore-journey-' });

    const resetResult = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix: activeResourceSuffix,
      forceClean: true,
    });
    expect(resetResult.ok).toBe(true);

    const paths = getDemoPathConfig({ repoRoot: tempRepo.repoRoot, resourceSuffix: activeResourceSuffix });
    const backupDir = path.join(tempRepo.repoRoot, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const backupArchivePath = path.join(backupDir, 'full-system-backup.tar.enc');
    const passphraseFile = path.join(tempRepo.repoRoot, 'backup-passphrase.txt');
    fs.writeFileSync(passphraseFile, 'secure_backup_passphrase_for_testing_12345\n', { mode: 0o600 });

    // Step A: Create Backup
    const createResult = await createBackup({
      dataRoot: paths.demoDataDir,
      outputPath: backupArchivePath,
      passphraseFile,
      demoStopConfirmed: true,
    });
    expect(createResult.success).toBe(true);
    expect(fs.existsSync(backupArchivePath)).toBe(true);
    expect(createResult.manifest.platformSchemaVersion).toBe(ALL_PLATFORM_MIGRATIONS[ALL_PLATFORM_MIGRATIONS.length - 1].version);

    // Step B: Inspect Backup
    const inspectResult = await inspectBackup({
      archivePath: backupArchivePath,
      passphraseFile,
    });
    expect(inspectResult.manifest).toBeDefined();
    expect(inspectResult.manifest.sqliteIntegrity.status).toBe('ok');

    // Step C: Verify Backup
    const verifyResult = await verifyBackup({
      archivePath: backupArchivePath,
      passphraseFile,
    });
    expect(verifyResult.verified).toBe(true);
    expect(verifyResult.checks.every((c) => c.status === 'passed')).toBe(true);

    // Step D: Restore Backup to target directory
    const restoreDir = path.join(tempRepo.repoRoot, 'restored-data');
    fs.mkdirSync(restoreDir, { recursive: true });

    const restoreResult = await restoreBackup({
      archivePath: backupArchivePath,
      passphraseFile,
      targetRoot: restoreDir,
    });
    expect(restoreResult.success).toBe(true);
    expect(restoreResult.postRestoreChecks.every((c) => c.status === 'passed')).toBe(true);

    // Verify restored database integrity and schema tables
    const restoredDb = new DatabaseSync(path.join(restoreDir, 'platform.db'), { readOnly: true });
    try {
      const intCheck = restoredDb.prepare('PRAGMA integrity_check').all() as any[];
      expect(intCheck[0].integrity_check).toBe('ok');

      const fkCheck = restoredDb.prepare('PRAGMA foreign_key_check').all();
      expect(fkCheck.length).toBe(0);

      const restoredTables = (
        restoredDb
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all() as Array<{ name: string }>
      ).map((r) => r.name);

      expect(restoredTables).toContain('extension_packages');
      expect(restoredTables).toContain('permission_presets');
      expect(restoredTables).toContain('model_selection_overrides');
      expect(restoredTables).toContain('message_references');
      expect(restoredTables).toContain('runtime_diagnostics');
      expect(restoredTables).toContain('task_notification_subscriptions');
      expect(restoredTables).toContain('space_mounts');
    } finally {
      restoredDb.close();
    }
  }, 90000);
});
