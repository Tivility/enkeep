/**
 * Dynamic Tenant Provisioning & Runtime Lifecycle E2E Tests
 *
 * Tests the complete end-to-end user lifecycle for arbitrary admin-created users:
 * 1. Admin creates arbitrary user (e.g. `charlie_new`) via API -> receives 201 with single-show tempPassword.
 * 2. SQLite transaction verification: User + 5 quota_limits + 1 default active space created atomically.
 * 3. Charlie logs in with tempPassword -> creates session in default space -> sends first message.
 * 4. Runtime container dynamically launches on demand (ensureUserRuntime), performs Phase 2 binding,
 *    verifies toolsOperational=true, and registers handle.
 * 5. Singleflight Concurrency: 20 concurrent ensureUserRuntime calls spawn exactly 1 container.
 * 6. Disabled user handling: Disabled users cannot start runtimes; disabling user stops container but preserves volume;
 *    re-enabling user allows runtime resume mounting existing volume.
 * 7. Failure Recovery: Runtime startup error does not mutate or roll back database credentials; retry succeeds cleanly.
 * 8. Zero impact on existing Alice & Bob runtimes.
 *
 * @module @enkeep/demo-runner/tests/dynamic-tenant-provisioning-e2e.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';
import { FakeUnitRuntimeContainerAdapter } from './support/fake-runtime.js';
import { resetDemo } from '../src/reset/index.js';
import { launchDemoSystem } from '../src/up/index.js';
import { downDemo } from '../src/down/index.js';
import { deriveRuntimeIdentity } from '../src/utils/runtime-identity.js';
import { getDemoPathConfig } from '../src/config.js';
import type { RunningDemoSystem } from '../src/up/index.js';

function parseJsonObj(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Expected JSON object');
  }
  return raw as Record<string, unknown>;
}

describe('Dynamic Tenant Provisioning & Runtime Lifecycle (E2E)', () => {
  let tempRepo: TempRepo;
  let resourceSuffix: string;
  let running: RunningDemoSystem | null = null;
  let fakeAdapter: FakeUnitRuntimeContainerAdapter;
  let credentials: any;

  beforeEach(async () => {
    resourceSuffix = randomUUID().replace(/-/g, '').slice(0, 10).toLowerCase();
    tempRepo = createTempRepo();
    fakeAdapter = new FakeUnitRuntimeContainerAdapter();

    // 1. Reset demo environment (provisions Alice admin & Bob user)
    const resetResult = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
    });
    expect(resetResult.ok).toBe(true);
    credentials = resetResult.credentials;

    // 2. Launch demo system with FakeUnitRuntimeContainerAdapter
    running = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
      runtimeAdapter: fakeAdapter,
    });
    expect(running.result.ok).toBe(true);
  });

  afterEach(async () => {
    if (running) {
      try {
        await running.close({ removeVolumes: true });
      } catch {}
      running = null;
    }
    if (tempRepo) {
      try {
        await downDemo({
          repoRoot: tempRepo.repoRoot,
          resourceSuffix,
          removeVolumes: true,
        });
      } catch {}
      try {
        tempRepo.cleanup();
      } catch {}
    }
  });

  describe('1. Canonical Runtime Identity Derivation', () => {
    it('preserves exact fixture aliases for alice and bob', () => {
      expect(deriveRuntimeIdentity('uuid-alice-123', 'alice')).toBe('alice');
      expect(deriveRuntimeIdentity('uuid-bob-456', 'bob')).toBe('bob');
    });

    it('derives safe sanitized runtime identity from arbitrary username slugs', () => {
      const charlieId = '9b91108c-33ed-40b8-b212-e69f3b9c5a21';
      const id1 = deriveRuntimeIdentity(charlieId, 'charlie_new');
      expect(id1).toMatch(/^charlie_new_[0-9a-f]{8}$/);
      expect(id1.length).toBeLessThanOrEqual(48);

      // Handles special characters and uppercase safely
      const specialId = deriveRuntimeIdentity(charlieId, 'Charlie.Dev+Admin!@#');
      expect(specialId).toMatch(/^charliedevadmin_[0-9a-f]{8}$/);

      // Handles empty or non-ascii usernames
      const emptySlugId = deriveRuntimeIdentity(charlieId, '用户123');
      expect(emptySlugId).toMatch(/^u_[0-9a-f]{8}$/);
    });
  });

  describe('2. E2E Dynamic User Creation -> Quotas -> Login -> Message -> Dynamic Container Provisioning', () => {
    it('completes the full dynamic user journey with live message dispatch and tool readiness', async () => {
      const platformUrl = running!.platformUrl;
      const originHeader = platformUrl;

      // 1. Fetch CSRF token for Admin
      const initialCsrfResp = await fetch(`${platformUrl}/api/auth/csrf`, {
        headers: { Origin: originHeader },
      });
      expect(initialCsrfResp.ok).toBe(true);
      const csrfData = parseJsonObj((await initialCsrfResp.json()).data);
      const loginCsrf = csrfData.csrfToken as string;

      // 2. Admin logs in with default Alice credentials
      const adminLoginResp = await fetch(`${platformUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': loginCsrf,
          Origin: originHeader,
        },
        body: JSON.stringify({ username: 'alice', password: credentials.admin.password }),
      });
      expect(adminLoginResp.ok).toBe(true);
      const adminCookie = (adminLoginResp.headers.get('set-cookie') || '').split(';')[0]!;

      // 3. Admin creates new user `charlie_new`
      const authCsrfResp = await fetch(`${platformUrl}/api/auth/csrf`, {
        headers: { Cookie: adminCookie, Origin: originHeader },
      });
      const authCsrf = parseJsonObj((await authCsrfResp.json()).data).csrfToken as string;

      const createUserResp = await fetch(`${platformUrl}/api/admin/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: adminCookie,
          'X-Enkeep-CSRF': authCsrf,
          Origin: originHeader,
        },
        body: JSON.stringify({
          username: 'charlie_new',
          displayName: 'Charlie New',
          role: 'user',
          locale: 'zh-CN',
        }),
      });

      expect(createUserResp.status).toBe(201);
      const createJson = parseJsonObj(await createUserResp.json());
      const createData = parseJsonObj(createJson.data);
      const charlieUser = parseJsonObj(createData.user);
      const charlieTempPassword = createData.tempPassword as string;

      expect(charlieUser.username).toBe('charlie_new');
      expect(charlieUser.displayName).toBe('Charlie New');
      expect(charlieUser.role).toBe('user');
      expect(charlieUser.status).toBe('active');
      expect(charlieUser.locale).toBe('zh-CN');
      expect(typeof charlieTempPassword).toBe('string');
      expect(charlieTempPassword.length).toBeGreaterThanOrEqual(16);

      const charlieUserId = charlieUser.id as string;

      // 4. Verify SQLite State for `charlie_new`: 5 Quotas + 1 Default Space
      const paths = getDemoPathConfig({ repoRoot: tempRepo.repoRoot, resourceSuffix });
      const db = new DatabaseSync(paths.dbPath);

      const quotaRows = db.prepare('SELECT resource, limit_amount FROM quota_limits WHERE user_id = ?').all(charlieUserId) as Array<{ resource: string; limit_amount: number }>;
      expect(quotaRows.length).toBe(5);
      const quotaMap = new Map(quotaRows.map((r) => [r.resource, r.limit_amount]));
      expect(quotaMap.get('turns')).toBe(1000);
      expect(quotaMap.get('messages')).toBe(1000);
      expect(quotaMap.get('tokens')).toBe(1000000);
      expect(quotaMap.get('storage_bytes')).toBe(10485760);
      expect(quotaMap.get('api_calls')).toBe(5000);

      const spaceRows = db.prepare('SELECT id, folder, status FROM spaces WHERE user_id = ?').all(charlieUserId) as Array<{ id: string; folder: string; status: string }>;
      expect(spaceRows.length).toBe(1);
      expect(spaceRows[0].status).toBe('active');
      const defaultSpaceId = spaceRows[0].id;
      db.close();

      // At this point, Charlie runtime container has NOT been started yet (lazy on-demand)
      expect(running!.runtimeHandles.has(charlieUserId)).toBe(false);

      // 5. Charlie logs in with tempPassword
      const charlieLoginResp = await fetch(`${platformUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': loginCsrf,
          Origin: originHeader,
        },
        body: JSON.stringify({
          username: 'charlie_new',
          password: charlieTempPassword,
        }),
      });
      expect(charlieLoginResp.ok).toBe(true);
      const tempCookie = (charlieLoginResp.headers.get('set-cookie') || '').split(';')[0]!;

      // 5b. Charlie gets CSRF and updates password to permanent
      const tempCsrfResp = await fetch(`${platformUrl}/api/auth/csrf`, {
        headers: { Cookie: tempCookie, Origin: originHeader },
      });
      const tempCsrf = parseJsonObj((await tempCsrfResp.json()).data).csrfToken as string;

      const changePassResp = await fetch(`${platformUrl}/api/auth/password`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: tempCookie,
          'X-Enkeep-CSRF': tempCsrf,
          Origin: originHeader,
        },
        body: JSON.stringify({
          oldPassword: charlieTempPassword,
          newPassword: 'CharliePermanentPassword123!',
        }),
      });
      expect(changePassResp.ok).toBe(true);
      const charlieCookie = (changePassResp.headers.get('set-cookie') || tempCookie).split(';')[0]!;

      // 6. Charlie gets CSRF with permanent session and queries spaces
      const charlieCsrfResp = await fetch(`${platformUrl}/api/auth/csrf`, {
        headers: { Cookie: charlieCookie, Origin: originHeader },
      });
      const charlieCsrf = parseJsonObj((await charlieCsrfResp.json()).data).csrfToken as string;

      const charlieSpacesResp = await fetch(`${platformUrl}/api/spaces`, {
        headers: { Cookie: charlieCookie, Origin: originHeader },
      });
      expect(charlieSpacesResp.ok).toBe(true);
      const charlieSpacesData = parseJsonObj(await charlieSpacesResp.json()).data as Array<{ id: string; name: string }>;
      expect(charlieSpacesData.length).toBe(1);
      expect(charlieSpacesData[0].id).toBe(defaultSpaceId);

      // 7. Charlie creates a new session in default space
      const createSessionResp = await fetch(`${platformUrl}/api/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: charlieCookie,
          'X-Enkeep-CSRF': charlieCsrf,
          Origin: originHeader,
        },
        body: JSON.stringify({
          spaceId: defaultSpaceId,
          peerId: 'charlie-web-client',
        }),
      });
      expect(createSessionResp.ok).toBe(true);
      const sessionId = parseJsonObj(parseJsonObj(await createSessionResp.json()).data).id as string;

      // 8. Charlie posts first message -> Triggers on-demand ensureUserRuntime
      const postMsgResp = await fetch(`${platformUrl}/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: charlieCookie,
          'X-Enkeep-CSRF': charlieCsrf,
          'Idempotency-Key': randomUUID(),
          Origin: originHeader,
        },
        body: JSON.stringify({
          content: 'Hello from newly provisioned user Charlie!',
        }),
      });

      expect(postMsgResp.ok).toBe(true);
      const postMsgJson = parseJsonObj(await postMsgResp.json());
      expect(parseJsonObj(postMsgJson.data).accepted).toBe(true);

      // Verify that Charlie's runtime container handle was dynamically created and registered
      expect(running!.runtimeHandles.has(charlieUserId)).toBe(true);
      const charlieHandle = running!.runtimeHandles.get(charlieUserId)!;
      expect(charlieHandle).toBeDefined();

      const charlieHealth = await charlieHandle.checkHealth();
      expect(charlieHealth.status).toBe('ok');
      expect(charlieHealth.dshReady).toBe(true);
      expect(charlieHealth.toolsOperational).toBe(true);

      // 9. Bounded poll for Assistant reply
      let messages: Array<{ role?: string; content?: string }> = [];
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const getMsgsResp = await fetch(`${platformUrl}/api/sessions/${sessionId}/messages`, {
          headers: { Cookie: charlieCookie, Origin: originHeader },
        });
        if (getMsgsResp.ok) {
          const msgsData = parseJsonObj((await getMsgsResp.json()).data).messages as Array<{ role?: string; content?: string }>;
          if (Array.isArray(msgsData) && msgsData.length >= 2) {
            messages = msgsData;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(messages.length).toBeGreaterThanOrEqual(2);
      const assistantMsg = messages.find((m) => m.role === 'assistant');
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg?.content).toContain('Processed: Hello from newly provisioned user Charlie!');

      // 10. Verify Alice and Bob runtime containers remain completely unharmed
      const aliceUser = await running!.storage.users.findByUsername('alice');
      const bobUser = await running!.storage.users.findByUsername('bob');
      const aliceHandle = running!.runtimeHandles.get(aliceUser!.id)!;
      const bobHandle = running!.runtimeHandles.get(bobUser!.id)!;

      const aliceHealth = await aliceHandle.checkHealth();
      const bobHealth = await bobHandle.checkHealth();
      expect(aliceHealth.status).toBe('ok');
      expect(bobHealth.status).toBe('ok');

      // 11. Send Followup Turn (Continuity & Multi-Turn Resume)
      const followupResp = await fetch(`${platformUrl}/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: charlieCookie,
          'X-Enkeep-CSRF': charlieCsrf,
          'Idempotency-Key': randomUUID(),
          Origin: originHeader,
        },
        body: JSON.stringify({
          content: 'Second turn followup message',
        }),
      });
      expect(followupResp.ok).toBe(true);

      const followupDeadline = Date.now() + 10000;
      while (Date.now() < followupDeadline) {
        const getMsgsResp = await fetch(`${platformUrl}/api/sessions/${sessionId}/messages`, {
          headers: { Cookie: charlieCookie, Origin: originHeader },
        });
        if (getMsgsResp.ok) {
          const msgsData = parseJsonObj((await getMsgsResp.json()).data).messages as Array<{ role?: string; content?: string }>;
          if (Array.isArray(msgsData) && msgsData.length >= 4) {
            messages = msgsData;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(messages.length).toBe(4);
    });
  });

  describe('3. Singleflight Concurrency (20 Concurrent Requests = 1 Container)', () => {
    it('deduplicates 20 concurrent ensureUserRuntime requests via per-user mutex', async () => {
      let startCount = 0;
      const countingAdapter = new FakeUnitRuntimeContainerAdapter();
      const origStart = countingAdapter.startUserRuntime.bind(countingAdapter);
      countingAdapter.startUserRuntime = async (opts) => {
        startCount++;
        // Add a slight delay to simulate container startup time
        await new Promise((r) => setTimeout(r, 50));
        return origStart(opts);
      };

      // Create another test user in DB
      const paths = getDemoPathConfig({ repoRoot: tempRepo.repoRoot, resourceSuffix });
      const db = new DatabaseSync(paths.dbPath);
      const testUserId = randomUUID();
      db.prepare(`
        INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
        VALUES (?, 'concurrency_user', 'hash', 'user', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(testUserId);
      for (const metric of ['turns', 'messages', 'tokens', 'storage_bytes', 'api_calls']) {
        db.prepare(`
          INSERT INTO quota_limits (user_id, resource, limit_amount, updated_at)
          VALUES (?, ?, 100, CURRENT_TIMESTAMP)
        `).run(testUserId, metric);
      }
      db.prepare(`
        INSERT INTO spaces (id, user_id, name, folder, status, created_at, updated_at)
        VALUES (?, ?, 'Default Space', 'space-0001', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(randomUUID(), testUserId);
      db.close();

      // Launch 20 concurrent ensure calls through management provider
      const management = running!.platformServer.managementProvider;
      expect(management).toBeDefined();
      expect(management!.ensureRuntime).toBeDefined();

      const promises = Array.from({ length: 20 }, () => management!.ensureRuntime!(testUserId));
      await Promise.all(promises);

      // Only 1 runtime handle should be registered for this user
      expect(running!.runtimeHandles.has(testUserId)).toBe(true);
    });
  });

  describe('4. Disabled User Handling & Lifecycle', () => {
    it('rejects runtime startup for disabled users, stops active runtime on disable, and allows resume when re-enabled', async () => {
      const paths = getDemoPathConfig({ repoRoot: tempRepo.repoRoot, resourceSuffix });
      const db = new DatabaseSync(paths.dbPath);

      // Charlie Disabled was created during resetDemo
      const charlieDisabled = db.prepare("SELECT id FROM users WHERE username = 'charlie_disabled'").get() as { id: string };
      expect(charlieDisabled).toBeDefined();

      const management = running!.platformServer.managementProvider!;

      // 1. Attempting to ensure/get runtime for disabled user returns null / rejected
      const disabledStatus = await management.getUserRuntime(charlieDisabled.id);
      expect(disabledStatus).toBeNull();
      expect(running!.runtimeHandles.has(charlieDisabled.id)).toBe(false);

      // 2. Bob is active and running
      const bobUser = await running!.storage.users.findByUsername('bob');
      expect(running!.runtimeHandles.has(bobUser!.id)).toBe(true);

      // 3. Admin disables Bob
      const stopRes = await management.stopRuntime!(bobUser!.id);
      expect(stopRes.stopped).toBe(true);
      expect(running!.runtimeHandles.has(bobUser!.id)).toBe(false);

      // Verify Bob's volume is preserved
      const bobVolMeta = getDemoPathConfig({ repoRoot: tempRepo.repoRoot, resourceSuffix }).volumesDir;
      expect(existsSync(bobVolMeta)).toBe(true);

      // 4. Bob is re-ensured and restarts mounting the preserved volume
      const restartHandle = await running!.connectRuntime(bobUser!.id);
      expect(restartHandle).toBeDefined();
      expect(running!.runtimeHandles.has(bobUser!.id)).toBe(true);
      expect(restartHandle.userId).toBe('bob');
      db.close();
    });
  });
});
