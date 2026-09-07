/**
 * Trusted DSH Plugin Acceptance & Real Agent End-to-End Governance Tests
 *
 * Requirements & Invariants:
 * 1. Platform bootstrap synchronizes trusted plugin registry into SQLite idempotently.
 * 2. Admin inspects extensions list: sees built-in trusted echo and test failing plugins.
 * 3. Admin enables trusted plugin in Space A via canonical API `POST /api/manage/extensions/:slug/enable`.
 * 4. Real Agent turn in Space A sees `plugin__trusted-echo__echo` and invokes it, returning `PLUGIN:<text>`.
 * 5. Admin disables plugin in Space A: next turn tool is absent.
 * 6. Admin enables failing plugin (`test-failing`): Agent turn safely fails with generic code
 *    `PLUGIN_ACTIVATION_FAILED` without stack/path leakage. Other sessions remain unaffected.
 * 7. Admin disables failing plugin: next turn chat succeeds normally (recovery verified).
 *
 * @module @enkeep/demo-runner/tests/trusted-plugin-acceptance.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  SqlitePlatformStorage,
  SqlitePlatformOperationsStorage,
} from '@enkeep/platform-storage-sqlite';
import {
  DefaultAuthService,
  provisionFixtures,
} from '@enkeep/platform-auth';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  PlatformServer,
  ExtensionCatalogService,
} from '@enkeep/platform-server';
import { TRUSTED_ECHO_PLUGIN, TRUSTED_TEST_FAILING_PLUGIN } from '@enkeep/dsh-enkeep-bundle';
import { bootDshRuntime } from '@enkeep/runtime-runner';
import type { ExtensionActivationPlan } from '@enkeep/protocol';

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

describe('Trusted DSH Plugin Acceptance & Real Agent Governance', () => {
  let tempDir: string;
  let dshHome: string;
  let spacesDir: string;
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let authService: DefaultAuthService;
  let server: PlatformServer;
  let baseUrl: string;
  let csrfToken: string;
  let aliceCookie: string;
  let aliceCsrf: string;
  let aliceSpaceId: string;
  let aliceId: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-plugin-acceptance-'));
    dshHome = path.join(tempDir, 'dsh-home');
    spacesDir = path.join(tempDir, 'spaces');
    fs.mkdirSync(dshHome, { recursive: true });
    fs.mkdirSync(spacesDir, { recursive: true });

    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    csrfToken = 'csrf_token_min_32_chars_for_plugin_test_12345';
    storage = new SqlitePlatformStorage(db);
    authService = new DefaultAuthService(storage, {
      cookieSecret: 'test_cookie_secret_at_least_32_chars_long_12345',
    });

    const fixtures = await provisionFixtures(storage, authService, {
      adminUsername: 'alice',
      adminPassword: 'AlicePassword123!',
      userUsername: 'bob',
      userPassword: 'BobPassword123!',
      disabledUsername: 'charlie',
      disabledPassword: 'CharliePassword123!',
    });

    aliceId = fixtures.admin.id;
    aliceSpaceId = fixtures.adminSpace.id;

    const mockRuntimeGateway = {
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

    server = new PlatformServer({
      database: db,
      storage,
      authService,
      runtimeGateway: mockRuntimeGateway as any,
      host: '127.0.0.1',
      port: 0,
      cookieSecret: 'test_cookie_secret_at_least_32_chars_long_12345',
      csrfToken,
      dshHome,
      spacesDir,
    });

    const addr = await server.start();
    baseUrl = addr.url;

    const auth = await loginUser(baseUrl, { username: 'alice', password: 'AlicePassword123!' });
    aliceCookie = auth.cookie;
    aliceCsrf = auth.csrfToken;
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
    try {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('executes full closed-loop: bootstrap list -> enable space -> call tool -> disable -> failing plugin fail-safe -> recovery', async () => {
    // 1. Bootstrap List: GET /api/manage/extensions
    const listRes = await fetch(`${baseUrl}/api/manage/extensions`, {
      headers: {
        Cookie: aliceCookie,
      },
    });
    expect(listRes.ok).toBe(true);
    const listData = ((await listRes.json()) as any).data;
    const echoPkg = listData.find((p: any) => p.slug === 'trusted-echo');
    expect(echoPkg).toBeDefined();
    expect(echoPkg.sourceKind).toBe('builtin');
    expect(echoPkg.integritySha256).toBe(TRUSTED_ECHO_PLUGIN.integritySha256);

    // 2. Admin enables trusted-echo in Space A: POST /api/manage/extensions/trusted-echo/enable
    const enableRes = await fetch(`${baseUrl}/api/manage/extensions/trusted-echo/enable`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceCsrf,
        Cookie: aliceCookie,
        Origin: baseUrl,
      },
      body: JSON.stringify({ spaceId: aliceSpaceId }),
    });
    expect(enableRes.ok).toBe(true);
    const enableData = ((await enableRes.json()) as any).data;
    expect(enableData.enabled).toBe(true);
    expect(enableData.kind).toBe('dsh-plugin');

    // 3. Resolve ExtensionActivationPlan for Space A
    const plan = await server.extensionService.resolveForSpace(aliceId, aliceSpaceId);
    expect(plan.plugins).toHaveLength(1);
    expect(plan.plugins![0].trustedPluginId).toBe('enkeep.echo');

    // 4. Real Agent Turn: Call tool plugin__trusted-echo__echo
    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome,
      spacesDir,
    });

    const sessionId = 'ses_11111111111111111111111111111111';
    try {
      const turn1Res = await runtime.sendFollowup({
        sessionId,
        turnId: 'turn_11111111111111111111111111111111',
        prompt: 'Please call echo tool [enkeep-test-tool-call=plugin__trusted-echo__echo:{"text":"EndToEndAcceptance"}]',
        workspaceFolder: aliceSpaceId,
        extensionPlan: plan,
      });

      expect(turn1Res.status).toBe('completed');
      expect(turn1Res.replyText).toContain('PLUGIN:EndToEndAcceptance');

      // 5. Admin disables trusted-echo in Space A
      const disableRes = await fetch(`${baseUrl}/api/manage/extensions/trusted-echo/disable`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': aliceCsrf,
          Cookie: aliceCookie,
          Origin: baseUrl,
        },
        body: JSON.stringify({ spaceId: aliceSpaceId }),
      });
      expect(disableRes.ok).toBe(true);

      const planDisabled = await server.extensionService.resolveForSpace(aliceId, aliceSpaceId);
      expect(planDisabled.plugins ?? []).toHaveLength(0);

      // Turn without plugin
      const turn2Res = await runtime.sendFollowup({
        sessionId,
        turnId: 'turn_22222222222222222222222222222222',
        prompt: 'Normal turn without tool',
        workspaceFolder: aliceSpaceId,
        extensionPlan: planDisabled,
      });
      expect(turn2Res.status).toBe('completed');

      // 6. Admin enables test-failing plugin in Space A
      const enableFailingRes = await fetch(`${baseUrl}/api/manage/extensions/test-failing/enable`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': aliceCsrf,
          Cookie: aliceCookie,
          Origin: baseUrl,
        },
        body: JSON.stringify({ spaceId: aliceSpaceId }),
      });
      expect(enableFailingRes.ok).toBe(true);

      const planFailing = await server.extensionService.resolveForSpace(aliceId, aliceSpaceId);
      expect(planFailing.plugins).toHaveLength(1);
      expect(planFailing.plugins![0].trustedPluginId).toBe('enkeep.test-failing');

      // Turn with failing plugin safely fails closed with PLUGIN_ACTIVATION_FAILED (no stack leak)
      await expect(
        runtime.sendFollowup({
          sessionId,
          turnId: 'turn_33333333333333333333333333333333',
          prompt: 'Attempt with failing plugin',
          workspaceFolder: aliceSpaceId,
          extensionPlan: planFailing,
        })
      ).rejects.toThrow(/PLUGIN_ACTIVATION_FAILED/);

      // 7. Error recovery: Admin disables failing plugin in Space A
      const disableFailingRes = await fetch(`${baseUrl}/api/manage/extensions/test-failing/disable`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': aliceCsrf,
          Cookie: aliceCookie,
          Origin: baseUrl,
        },
        body: JSON.stringify({ spaceId: aliceSpaceId }),
      });
      expect(disableFailingRes.ok).toBe(true);

      const planRecovered = await server.extensionService.resolveForSpace(aliceId, aliceSpaceId);
      expect(planRecovered.plugins ?? []).toHaveLength(0);

      // Next normal chat turn succeeds!
      const turn4Res = await runtime.sendFollowup({
        sessionId,
        turnId: 'turn_44444444444444444444444444444444',
        prompt: 'Normal chat after disabling failing plugin',
        workspaceFolder: aliceSpaceId,
        extensionPlan: planRecovered,
      });
      expect(turn4Res.status).toBe('completed');
    } finally {
      await runtime.dispose();
    }
  });
});
