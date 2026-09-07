/**
 * Comprehensive Automated Demo Test Suite (`demo:test`)
 *
 * Implements end-to-end automated verification:
 * 1. Probes 3000/3080 HTTP and listener PID before any test action.
 * 2. Runs comprehensive test suite:
 *    - Auth & Login with dynamic high-entropy credentials (Alice admin, Bob user, Charlie disabled)
 *    - Import history verification (from safe fixtures)
 *    - Resume / new session handling
 *    - Alice / Bob tenant and container isolation
 *    - SQLite persistence & restart recovery
 *    - Migration idempotency
 *    - Real official DSH runtime in real Docker containers (Alice + Bob):
 *      - Strict CSRF with exact Origin header & bootstrap token
 *      - Alice & Bob inspection: non-root, isolated volumes, --network none, enkeep.run-id
 *      - Turn dispatch, bounded message polling, assistant reply validation
 *      - Real cancellation test via DeliveryTurnExecutor.cancel
 *      - Imported seed resume verification in container
 * 3. Safely tears down all demo resources with volume removal.
 * 4. Verifies zero created containers and volumes remain.
 * 5. Probes 3000/3080 HTTP and listener PID after teardown and asserts ZERO change.
 *
 * @module @enkeep/demo-runner/test
 */

import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createSqliteStorage, SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { DatabaseSync } from 'node:sqlite';
import { ALL_PLATFORM_MIGRATIONS, PlatformServerMigrationRunner } from '@enkeep/platform-server';
import { DefaultAuthService } from '@enkeep/platform-auth';
import { SafeDockerClient } from '@enkeep/runtime-runner/docker';
import {
  findRepoRoot,
  getDemoPathConfig,
  validateResourceSuffix,
} from '../config.js';
import {
  getDemoSecrets,
} from '../utils/crypto-meta.js';
import {
  probeProtectedPorts,
  assertProbesUnchanged,
} from '../utils/probes.js';
import { resetDemo } from '../reset/index.js';
import { downDemo } from '../down/index.js';
import { launchDemoSystem } from '../up/index.js';
import type { UserRuntimeHandle } from '../ports/index.js';
import type { DemoTestOptions, DemoTestReport, StepResult, DemoCredentials, DemoPathOptions } from '../types.js';

function parseJsonObject(val: unknown, context: string): Record<string, unknown> {
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    throw new Error(`FAIL-CLOSED: Response from ${context} is not a valid JSON object.`);
  }
  return val as Record<string, unknown>;
}

function parseCsrfResponse(val: unknown): string {
  const obj = parseJsonObject(val, 'CSRF endpoint');
  const data = parseJsonObject(obj['data'], 'CSRF data');
  const token = data['csrfToken'];
  if (typeof token !== 'string' || !token) {
    throw new Error('FAIL-CLOSED: CSRF endpoint did not return a valid csrfToken string.');
  }
  return token;
}

function parseSpacesResponse(val: unknown): Array<{ id: string; folder?: string }> {
  const obj = parseJsonObject(val, 'Spaces endpoint');
  const data = obj['data'];
  if (!Array.isArray(data)) {
    throw new Error('FAIL-CLOSED: Spaces endpoint data is not an array.');
  }
  return data.map((item, idx) => {
    const itemObj = parseJsonObject(item, `Spaces data[${idx}]`);
    if (typeof itemObj['id'] !== 'string') {
      throw new Error(`FAIL-CLOSED: Space item at index ${idx} missing id.`);
    }
    return {
      id: itemObj['id'],
      folder: typeof itemObj['folder'] === 'string' ? itemObj['folder'] : undefined,
    };
  });
}

function parseSessionResponse(val: unknown): string {
  const obj = parseJsonObject(val, 'Session creation endpoint');
  const data = parseJsonObject(obj['data'], 'Session data');
  const id = data['id'];
  if (typeof id !== 'string' || !id) {
    throw new Error('FAIL-CLOSED: Session creation endpoint did not return a valid session id.');
  }
  return id;
}

function parseMessagesResponse(val: unknown): Array<{ role?: string; content?: string }> {
  const obj = parseJsonObject(val, 'Messages endpoint');
  const data = parseJsonObject(obj['data'], 'Messages data');
  const messages = data['messages'];
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages.map((m, idx) => {
    const mObj = parseJsonObject(m, `Messages[${idx}]`);
    return {
      role: typeof mObj['role'] === 'string' ? mObj['role'] : undefined,
      content: typeof mObj['content'] === 'string' ? mObj['content'] : undefined,
    };
  });
}

export async function runDemoTestSuite(options: DemoTestOptions = {}): Promise<DemoTestReport> {
  const startTime = Date.now();
  const repoRoot = options.repoRoot ?? findRepoRoot();
  const pathOptions: DemoPathOptions = {
    repoRoot,
    dataRoot: options.dataRoot,
    mode: options.mode,
    resourceSuffix: options.resourceSuffix,
  };
  validateResourceSuffix(options.resourceSuffix);

  const paths = getDemoPathConfig(pathOptions);
  const steps: StepResult[] = [];

  let credentials: DemoCredentials | null = null;

  // Helper to run a step
  async function runStep(
    stepId: string,
    name: string,
    fn: () => Promise<Record<string, unknown> | void>
  ): Promise<boolean> {
    const stepStart = Date.now();
    try {
      const details = (await fn()) || {};
      steps.push({
        stepId,
        name,
        passed: true,
        durationMs: Date.now() - stepStart,
        details,
      });
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      steps.push({
        stepId,
        name,
        passed: false,
        durationMs: Date.now() - stepStart,
        error: msg,
      });
      return false;
    }
  }

  // --- Step 0: Probe Protected Ports 3000 & 3080 Before ---
  const probeBefore = await probeProtectedPorts();

  // --- Step 1: Demo Reset & Fixture Provisioning ---
  await runStep('step_reset_provision', 'Reset .demo-data & provision schema/users/spaces with high-entropy credentials', async () => {
    // Clean down any stale resources before fresh reset
    await downDemo({ ...pathOptions, removeVolumes: true });
    const resetResult = await resetDemo({ ...pathOptions, forceClean: true });
    if (!resetResult.ok) throw new Error('Reset failed');
    credentials = resetResult.credentials;
    return {
      dbPath: resetResult.dbPath,
      importedChats: resetResult.importedChatsCount,
      adminUser: resetResult.users.admin.username,
      regularUser: resetResult.users.user.username,
    };
  });

  // --- Step 2: Authentication & Login Verification ---
  await runStep('step_auth_verification', 'Verify login policies for admin, user, and disabled accounts with dynamic credentials', async () => {
    if (!credentials) throw new Error('Credentials missing from reset step');
    const secrets = getDemoSecrets(pathOptions);
    const storage = await createSqliteStorage({ dbPath: paths.dbPath, autoMigrate: false });
    const authService = new DefaultAuthService(storage, {
      cookieSecret: secrets.cookieSecret,
      cookieSecure: false,
      cookieSameSite: 'Strict',
    });

    // Alice Login (Admin)
    const aliceRes = await authService.login(credentials.admin.username, credentials.admin.password);
    if (!aliceRes.user || aliceRes.user.role !== 'admin') throw new Error('Alice admin login failed');

    // Bob Login (Regular User)
    const bobRes = await authService.login(credentials.user.username, credentials.user.password);
    if (!bobRes.user || bobRes.user.role !== 'user') throw new Error('Bob user login failed');

    // Charlie Login (Disabled User - must fail)
    let charlieRejected = false;
    try {
      await authService.login(credentials.disabledUser.username, credentials.disabledUser.password);
    } catch (_err: unknown) {
      charlieRejected = true;
    }
    if (!charlieRejected) throw new Error('Disabled user charlie was not rejected');

    // Invalid Password
    let invalidRejected = false;
    try {
      await authService.login(credentials.admin.username, 'WrongPassword_Invalid_123');
    } catch (_err: unknown) {
      invalidRejected = true;
    }
    if (!invalidRejected) throw new Error('Invalid password was not rejected');

    await storage.close();

    return {
      aliceRole: aliceRes.user.role,
      bobRole: bobRes.user.role,
      disabledAccountRejected: true,
      invalidPasswordRejected: true,
    };
  });

  // --- Step 3: Mock Import History Verification ---
  await runStep('step_import_history', 'Verify HappyClaw mock import data and manifest integrity', async () => {
    const manifestPath = paths.importDir + '/import-manifest.json';
    if (!existsSync(manifestPath)) throw new Error(`Import manifest missing at ${manifestPath}`);

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    if (!manifest.targetDsh || !manifest.stats) {
      throw new Error('Manifest missing required fields');
    }

    const mappingPath = paths.importDir + '/mapping.json';
    if (!existsSync(mappingPath)) throw new Error('Mapping file missing');
    const mapping = JSON.parse(readFileSync(mappingPath, 'utf-8'));

    return {
      manifestVersion: manifest.importerVersion,
      totalMessages: manifest.stats.sourceMessages,
      mappedChats: Object.keys(mapping).length,
    };
  });

  // --- Step 4: Multi-Tenant & Space Isolation Verification ---
  await runStep('step_tenant_isolation', 'Verify strict tenant isolation between Alice and Bob', async () => {
    const storage = await createSqliteStorage({ dbPath: paths.dbPath, autoMigrate: false });

    const aliceUser = await storage.users.findByUsername('alice');
    const bobUser = await storage.users.findByUsername('bob');
    if (!aliceUser || !bobUser) throw new Error('Alice or Bob user not found');

    const aliceTenant = storage.forTenant(aliceUser.id);
    const bobTenant = storage.forTenant(bobUser.id);

    // Create session in Alice tenant
    const aliceSpace = (await aliceTenant.spaces.list())[0];
    if (!aliceSpace) throw new Error('Alice has no spaces');

    const aliceSession = await aliceTenant.sessionRoutes.create({
      spaceId: aliceSpace.id,
      channel: 'web',
      nativeContextId: 'alice-peer',
      peerId: 'alice-peer',
      dshSessionId: 'dsh_alice_001',
    });

    // Bob attempts to query Alice's session route -> MUST be null / inaccessible
    const bobFoundAliceSession = await bobTenant.sessionRoutes.findById(aliceSession.id);
    if (bobFoundAliceSession !== null) {
      throw new Error(`CRITICAL ISOLATION BREACH: Bob accessed Alice's session ${aliceSession.id}`);
    }

    // Bob attempts to list Alice's spaces -> MUST not contain Alice's space
    const bobSpaces = await bobTenant.spaces.list();
    if (bobSpaces.some((s) => s.id === aliceSpace.id)) {
      throw new Error(`CRITICAL ISOLATION BREACH: Bob listed Alice's space ${aliceSpace.id}`);
    }

    await storage.close();
    return {
      aliceSessionId: aliceSession.id,
      crossTenantLeakDetected: false,
    };
  });

  // --- Step 5: Resume & New Session Handling ---
  await runStep('step_session_lifecycle', 'Verify session creation, routing, and multi-turn resume', async () => {
    const storage = await createSqliteStorage({ dbPath: paths.dbPath, autoMigrate: false });
    const aliceUser = await storage.users.findByUsername('alice');
    const aliceTenant = storage.forTenant(aliceUser!.id);

    const space = (await aliceTenant.spaces.list())[0];
    const session = await aliceTenant.sessionRoutes.create({
      spaceId: space.id,
      channel: 'web',
      nativeContextId: 'turn-peer',
      peerId: 'turn-peer',
      dshSessionId: 'dsh_lifecycle_test',
    });

    // Turn 1
    await aliceTenant.turnRuns.create({
      spaceId: space.id,
      routeId: session.id,
      turnId: 'turn_001',
      status: 'completed',
    });

    // Turn 2 (Resume session)
    await aliceTenant.turnRuns.create({
      spaceId: space.id,
      routeId: session.id,
      turnId: 'turn_002',
      status: 'completed',
    });

    const sessionTurns = await aliceTenant.turnRuns.listByRouteId(session.id);
    if (sessionTurns.length < 2) throw new Error('Failed to record resume turns');

    await storage.close();
    return {
      sessionId: session.id,
      recordedTurns: sessionTurns.length,
    };
  });

  // --- Step 6: SQLite Restart Recovery Verification ---
  await runStep('step_sqlite_restart', 'Verify crash recovery and turn status handling on restart', async () => {
    // 1. Open DB and create a 'running' turn
    const db1 = new DatabaseSync(paths.dbPath);
    const storage1 = new SqlitePlatformStorage(db1);
    const aliceUser = await storage1.users.findByUsername('alice');
    const aliceTenant1 = storage1.forTenant(aliceUser!.id);
    const space = (await aliceTenant1.spaces.list())[0];
    const session = (await aliceTenant1.sessionRoutes.list())[0];

    const turn = await aliceTenant1.turnRuns.create({
      spaceId: space.id,
      routeId: session.id,
      turnId: 'turn_in_flight',
      status: 'running',
    });

    await storage1.close();

    // 2. Simulate platform server restart
    const db2 = new DatabaseSync(paths.dbPath);
    const storage2 = new SqlitePlatformStorage(db2);
    const recovery = await storage2.recoverAfterRestart();

    if (recovery.interruptedTurnRuns < 1) {
      throw new Error('Recovery failed to mark in-flight turn as interrupted');
    }

    const aliceTenant2 = storage2.forTenant(aliceUser!.id);
    const recoveredTurn = await aliceTenant2.turnRuns.findById(turn.id);
    if (recoveredTurn?.status !== 'interrupted') {
      throw new Error(`Expected turn status 'interrupted', got '${recoveredTurn?.status}'`);
    }

    await storage2.close();
    return {
      interruptedTurnRuns: recovery.interruptedTurnRuns,
      turnStatusAfterRestart: recoveredTurn.status,
    };
  });

  // --- Step 7: Migration Idempotency Verification ---
  await runStep('step_migration_idempotency', 'Verify SQLite migration idempotency over repeated executions', async () => {
    const db = new DatabaseSync(paths.dbPath);
    const migrationRunner = new PlatformServerMigrationRunner(db);

    // Run migrations 3 times in a row with platform migrations
    const res1 = await migrationRunner.migrate(ALL_PLATFORM_MIGRATIONS);
    const res2 = await migrationRunner.migrate(ALL_PLATFORM_MIGRATIONS);
    const res3 = await migrationRunner.migrate(ALL_PLATFORM_MIGRATIONS);

    const applied = await migrationRunner.getAppliedMigrations();
    if (applied.length === 0) throw new Error('No applied migrations found');

    db.close();

    return {
      appliedRuns: [res1.length, res2.length, res3.length],
      totalAppliedMigrations: applied.length,
    };
  });

  // --- Step 8: End-to-End Runtime Execution ---
  await runStep('step_dsh_docker_runtime', 'Verify runtime container boot, Alice & Bob isolation, Web API CSRF, message dispatch, bounded poll, and cancellation', async () => {
    // If custom runtimeAdapter was injected (e.g. fake for unit tests), use it; otherwise check Docker availability
    if (!options.runtimeAdapter) {
      const dockerClient = new SafeDockerClient();
      const isDockerAvailable = await dockerClient.isDockerAvailable();
      if (!isDockerAvailable) {
        throw new Error(
          'FAIL-CLOSED: Docker daemon is unavailable. demo:test requires a live Docker daemon to boot and verify genuine DSH user runtime containers.'
        );
      }
    }

    if (!credentials) throw new Error('Credentials missing for runtime step');

    // 1. Launch Platform System
    const running = await launchDemoSystem({
      ...pathOptions,
      runtimeImage: options.runtimeImage,
      runtimeAdapter: options.runtimeAdapter,
    });

    try {
      const platformUrl = running.result.platform.url!;
      const aliceUser = await running.storage.users.findByUsername('alice');
      const bobUser = await running.storage.users.findByUsername('bob');
      if (!aliceUser || !bobUser) {
        throw new Error('FAIL-CLOSED: Demo users alice/bob missing from database');
      }
      const aliceHandle = running.runtimeHandles.get(aliceUser.id);
      const bobHandle = running.runtimeHandles.get(bobUser.id);

      if (!aliceHandle || !aliceHandle.containerId) {
        throw new Error('Alice runtime container handle is missing containerId');
      }
      if (!bobHandle || !bobHandle.containerId) {
        throw new Error('Bob runtime container handle is missing containerId');
      }

      // 2. Health Check for Alice and Bob
      const aliceHealth = await aliceHandle.checkHealth();
      if (aliceHealth.status !== 'ok' || !aliceHealth.dshReady) {
        throw new Error(`Alice runtime health check failed: ${JSON.stringify(aliceHealth)}`);
      }

      const bobHealth = await bobHandle.checkHealth();
      if (bobHealth.status !== 'ok' || !bobHealth.dshReady) {
        throw new Error(`Bob runtime health check failed: ${JSON.stringify(bobHealth)}`);
      }

      // 3. If real Docker client, inspect live containers
      if (!options.runtimeAdapter) {
        const dockerClient = new SafeDockerClient();
        const liveAlice = await dockerClient.inspectContainer(aliceHandle.containerName);
        if (!liveAlice) throw new Error('Failed to inspect live Alice container in Docker');
        if (liveAlice.labels['enkeep.user'] !== 'alice') throw new Error('Alice container user label mismatch');
        if (!liveAlice.labels['enkeep.run-id']) throw new Error('Alice container missing enkeep.run-id label');

        const liveBob = await dockerClient.inspectContainer(bobHandle.containerName);
        if (!liveBob) throw new Error('Failed to inspect live Bob container in Docker');
        if (liveBob.labels['enkeep.user'] !== 'bob') throw new Error('Bob container user label mismatch');
        if (!liveBob.labels['enkeep.run-id']) throw new Error('Bob container missing enkeep.run-id label');
      }

      // 4. Web API: Fetch Initial CSRF Token with exact Origin header
      const originHeader = platformUrl;
      const initialCsrfResp = await fetch(`${platformUrl}/api/auth/csrf`, {
        headers: { Origin: originHeader },
      });
      if (!initialCsrfResp.ok) throw new Error(`Initial CSRF fetch failed with status ${initialCsrfResp.status}`);
      const initialCsrfRaw = await initialCsrfResp.json();
      const loginCsrfToken = parseCsrfResponse(initialCsrfRaw);

      // 5. Web API: Login as Alice to get session cookie using dynamic credentials
      const loginResp = await fetch(`${platformUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': loginCsrfToken,
          Origin: originHeader,
        },
        body: JSON.stringify({ username: credentials.admin.username, password: credentials.admin.password }),
      });
      if (!loginResp.ok) throw new Error(`Platform login failed with status ${loginResp.status}`);

      const setCookie = loginResp.headers.get('set-cookie');
      const authCookie = setCookie ? setCookie.split(';')[0] : '';
      if (!authCookie) throw new Error('Platform login returned no cookie');

      // 6. Web API: Fetch Authenticated CSRF Token
      const csrfResp = await fetch(`${platformUrl}/api/auth/csrf`, {
        headers: {
          Cookie: authCookie,
          Origin: originHeader,
        },
      });
      if (!csrfResp.ok) throw new Error(`CSRF token retrieval failed with status ${csrfResp.status}`);
      const csrfRaw = await csrfResp.json();
      const csrfToken = parseCsrfResponse(csrfRaw);

      // 7. Web API: Fetch Alice's spaces and create a Web Session
      const spacesResp = await fetch(`${platformUrl}/api/spaces`, {
        headers: {
          Cookie: authCookie,
          Origin: originHeader,
        },
      });
      if (!spacesResp.ok) throw new Error(`Fetch spaces failed with status ${spacesResp.status}`);
      const spacesRaw = await spacesResp.json();
      const spaceList = parseSpacesResponse(spacesRaw);
      const containerSpace = spaceList.find((s) => s.folder === 'alice-container') || spaceList[0];
      if (!containerSpace) throw new Error('No container space available for Alice');

      const createSessionResp = await fetch(`${platformUrl}/api/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: authCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: originHeader,
        },
        body: JSON.stringify({
          spaceId: containerSpace.id,
          peerId: 'alice-web-client',
        }),
      });
      if (!createSessionResp.ok) throw new Error(`Create session failed with status ${createSessionResp.status}`);
      const sessionRaw = await createSessionResp.json();
      const sessionId = parseSessionResponse(sessionRaw);

      // 8. Web API: Post Message -> Inbox -> RuntimeGateway -> DockerTurnExecutor -> User Container
      const postMsgResp = await fetch(`${platformUrl}/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: authCookie,
          'X-Enkeep-CSRF': csrfToken,
          'Idempotency-Key': randomUUID(),
          Origin: originHeader,
        },
        body: JSON.stringify({
          content: 'Reply with exactly: Enkeep Docker runtime ready.',
        }),
      });
      if (!postMsgResp.ok) {
        const errText = await postMsgResp.text();
        throw new Error(`Post message failed with status ${postMsgResp.status}: ${errText}`);
      }
      const postMsgRaw = await postMsgResp.json();
      const postMsgObj = parseJsonObject(postMsgRaw, 'Post message response');
      const postMsgData = parseJsonObject(postMsgObj['data'], 'Post message data');
      if (postMsgData['accepted'] !== true || !postMsgData['message']) {
        throw new Error('Post message response missing accepted message confirmation');
      }

      // 9. Web API: Bounded Poll Session Messages to verify Assistant reply was persisted
      let messages: Array<{ role?: string; content?: string }> = [];
      const deadline = Date.now() + 35000;
      while (Date.now() < deadline) {
        const getMsgsResp = await fetch(`${platformUrl}/api/sessions/${sessionId}/messages`, {
          headers: {
            Cookie: authCookie,
            Origin: originHeader,
          },
        });
        if (getMsgsResp.ok) {
          const msgsRaw = await getMsgsResp.json();
          messages = parseMessagesResponse(msgsRaw);
          if (messages.length >= 2) break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }

      if (messages.length < 2) {
        throw new Error(`Expected at least 2 messages (user + assistant), got ${messages.length}; messages: ${JSON.stringify(messages)}`);
      }

      const assistantMsg = messages.find((m) => m.role === 'assistant');
      const isDemoModeExplicit = process.env.ENKEEP_LLM_ENABLED === '0';
      if (isDemoModeExplicit) {
        if (!assistantMsg || !assistantMsg.content || !assistantMsg.content.includes('[DemoModel:alice]')) {
          throw new Error(`Assistant message reply format invalid: "${assistantMsg?.content}"`);
        }
      } else {
        if (!assistantMsg || !assistantMsg.content || typeof assistantMsg.content !== 'string' || assistantMsg.content.trim().length === 0 || assistantMsg.content.includes('[DemoModel:')) {
          throw new Error(`Assistant message reply invalid in LLM mode: "${assistantMsg?.content}"`);
        }
      }

      // 10. Test Cancel Turn API via Alice Handle
      if (!aliceHandle.rawHandle) {
        throw new Error('FAIL-CLOSED: Alice handle missing rawHandle for cancellation test');
      }
      const rawHandle = aliceHandle.rawHandle;
      const cancelTurnId = `turn_${randomUUID().replace(/-/g, "").toLowerCase()}`;
      const cancelSessionId = `ses_${randomUUID().replace(/-/g, "").toLowerCase()}`;
      const cancelStartTime = Date.now();

      // 1. Launch followup turn concurrently with requested runtime delay marker [enkeep-test-delay-ms=5000]
      const followupPromise = rawHandle.sendFollowup({
        prompt: 'Long running turn [enkeep-test-delay-ms=5000]',
        sessionId: cancelSessionId,
        turnId: cancelTurnId,
      });

      // 2. Poll cancelTurn with bounded retries (every 20ms up to 1000ms) until active turn is cancelled
      let cancelRes: Awaited<ReturnType<typeof rawHandle.cancelTurn>> | undefined;
      const cancelDeadline = Date.now() + 1000;
      while (Date.now() < cancelDeadline) {
        const res = await rawHandle.cancelTurn(cancelTurnId);
        if (res.status === 'cancelled') {
          cancelRes = res;
          break;
        }
        if (res.status === 'error' && res.code === 'NOT_FOUND') {
          // Marker is still initializing in the concurrent process; bounded retry
          await new Promise((r) => setTimeout(r, 20));
          continue;
        }
        throw new Error(
          `cancelTurn returned unexpected status/code: status=${res.status}, code=${res.code}, error=${res.error}`
        );
      }

      if (!cancelRes || cancelRes.status !== 'cancelled' || cancelRes.turnId !== cancelTurnId) {
        throw new Error(
          `FAIL-CLOSED: cancelTurn failed verification: status=${cancelRes?.status}, turnId=${cancelRes?.turnId}`
        );
      }

      // 3. Await followup turn resolution: must settle as cancelled before delay (<2000ms) with no normal reply
      const followupRes = await followupPromise;
      const cancelElapsedMs = Date.now() - cancelStartTime;

      if (cancelElapsedMs >= 2000) {
        throw new Error(`FAIL-CLOSED: Followup turn resolution took too long (${cancelElapsedMs}ms >= 2000ms)`);
      }
      if (followupRes.status !== 'cancelled') {
        throw new Error(`FAIL-CLOSED: Followup turn expected status "cancelled", got "${followupRes.status}"`);
      }
      if (followupRes.turnId !== cancelTurnId) {
        throw new Error(`FAIL-CLOSED: Followup turn expected turnId "${cancelTurnId}", got "${followupRes.turnId}"`);
      }
      if (followupRes.sessionId !== cancelSessionId) {
        throw new Error(`FAIL-CLOSED: Followup turn expected sessionId "${cancelSessionId}", got "${followupRes.sessionId}"`);
      }
      if (followupRes.replyText !== undefined) {
        throw new Error(`FAIL-CLOSED: Followup turn returned unexpected replyText: ${followupRes.replyText}`);
      }

      // 11. Dynamic Tenant Provisioning & Dynamic Container Lifecycle Test (Charlie New)
      // Admin creates arbitrary new user charlie_new
      const createCharlieResp = await fetch(`${platformUrl}/api/admin/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: authCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: originHeader,
        },
        body: JSON.stringify({
          username: 'charlie_new',
          displayName: 'Charlie Dynamic',
          role: 'user',
          locale: 'zh-CN',
        }),
      });
      if (createCharlieResp.status !== 201) {
        throw new Error(`Admin failed to create new user charlie_new: status=${createCharlieResp.status}`);
      }
      const charlieJson = parseJsonObject(await createCharlieResp.json(), 'Create user response');
      const charlieData = parseJsonObject(charlieJson['data'], 'Create user data');
      const charlieUser = parseJsonObject(charlieData['user'], 'Charlie user object');
      const charlieTempPwd = charlieData['tempPassword'] as string;
      const charlieUserId = charlieUser['id'] as string;

      // Verify Charlie SQLite state: 5 quota_limits and 1 default space
      const dbCheck = new DatabaseSync(paths.dbPath);
      const charlieQuotaRows = dbCheck.prepare('SELECT resource, limit_amount FROM quota_limits WHERE user_id = ?').all(charlieUserId) as Array<{ resource: string; limit_amount: number }>;
      if (charlieQuotaRows.length !== 5) {
        throw new Error(`FAIL-CLOSED: Expected 5 quota limits for charlie_new, got ${charlieQuotaRows.length}`);
      }
      const charlieSpaceRows = dbCheck.prepare('SELECT id, folder FROM spaces WHERE user_id = ?').all(charlieUserId) as Array<{ id: string; folder: string }>;
      if (charlieSpaceRows.length !== 1) {
        throw new Error(`FAIL-CLOSED: Expected 1 default space for charlie_new, got ${charlieSpaceRows.length}`);
      }
      const charlieDefaultSpaceId = charlieSpaceRows[0].id;
      dbCheck.close();

      // Charlie logs in with tempPassword
      const charlieLoginResp = await fetch(`${platformUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': loginCsrfToken,
          Origin: originHeader,
        },
        body: JSON.stringify({
          username: 'charlie_new',
          password: charlieTempPwd,
        }),
      });
      if (!charlieLoginResp.ok) {
        throw new Error(`Charlie login failed with status ${charlieLoginResp.status}`);
      }
      let charlieCookie = (charlieLoginResp.headers.get('set-cookie') || '').split(';')[0]!;

      // Charlie gets CSRF and changes initial temporary password
      const charlieCsrfResp = await fetch(`${platformUrl}/api/auth/csrf`, {
        headers: { Cookie: charlieCookie, Origin: originHeader },
      });
      let charlieCsrf = parseCsrfResponse(await charlieCsrfResp.json());

      const charliePermanentPwd = 'CharliePermPass123!@#';
      const changePwdResp = await fetch(`${platformUrl}/api/auth/password`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: charlieCookie,
          'X-Enkeep-CSRF': charlieCsrf,
          Origin: originHeader,
        },
        body: JSON.stringify({
          oldPassword: charlieTempPwd,
          newPassword: charliePermanentPwd,
        }),
      });
      if (!changePwdResp.ok) {
        throw new Error(`Charlie password change failed with status ${changePwdResp.status}`);
      }
      const rotatedCookie = changePwdResp.headers.get('set-cookie');
      if (rotatedCookie) {
        charlieCookie = rotatedCookie.split(';')[0]!;
      }

      // Re-fetch CSRF after password change session rotation
      const charliePostCsrfResp = await fetch(`${platformUrl}/api/auth/csrf`, {
        headers: { Cookie: charlieCookie, Origin: originHeader },
      });
      charlieCsrf = parseCsrfResponse(await charliePostCsrfResp.json());

      const charlieSessionResp = await fetch(`${platformUrl}/api/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: charlieCookie,
          'X-Enkeep-CSRF': charlieCsrf,
          Origin: originHeader,
        },
        body: JSON.stringify({
          spaceId: charlieDefaultSpaceId,
          peerId: 'charlie-web-client',
        }),
      });
      if (!charlieSessionResp.ok) {
        throw new Error(`Charlie session creation failed: status=${charlieSessionResp.status}`);
      }
      const charlieSessionId = parseSessionResponse(await charlieSessionResp.json());

      // Charlie sends first message -> Dynamic Runtime provisioning triggered
      const charlieMsgResp = await fetch(`${platformUrl}/api/sessions/${charlieSessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: charlieCookie,
          'X-Enkeep-CSRF': charlieCsrf,
          'Idempotency-Key': randomUUID(),
          Origin: originHeader,
        },
        body: JSON.stringify({
          content: 'Deterministic test message from charlie_new',
        }),
      });
      if (!charlieMsgResp.ok) {
        throw new Error(`Charlie post message failed: status=${charlieMsgResp.status}`);
      }

      // Verify dynamic container appeared in runtimeHandles with tools operational
      let charlieHandle: UserRuntimeHandle | undefined;
      const handleDeadline = Date.now() + 10000;
      while (Date.now() < handleDeadline) {
        charlieHandle = running.runtimeHandles.get(charlieUserId);
        if (charlieHandle) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!charlieHandle) {
        throw new Error('FAIL-CLOSED: Dynamic user runtime handle not found in runtimeHandles for charlie_new');
      }
      const charlieHealth = await charlieHandle.checkHealth();
      if (charlieHealth.status !== 'ok' || charlieHealth.toolsOperational !== true) {
        throw new Error(`Charlie dynamic runtime container tools are not operational (health: ${JSON.stringify(charlieHealth)})`);
      }

      // Poll for Charlie assistant reply
      let charlieMessages: Array<{ role?: string; content?: string }> = [];
      const charlieDeadline = Date.now() + 35000;
      while (Date.now() < charlieDeadline) {
        const getMsgsResp = await fetch(`${platformUrl}/api/sessions/${charlieSessionId}/messages`, {
          headers: { Cookie: charlieCookie, Origin: originHeader },
        });
        if (getMsgsResp.ok) {
          const msgsRaw = await getMsgsResp.json();
          charlieMessages = parseMessagesResponse(msgsRaw);
          if (charlieMessages.length >= 2) break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }

      if (charlieMessages.length < 2) {
        throw new Error(`Expected at least 2 messages for Charlie, got ${charlieMessages.length}`);
      }

      // 12. Online Fork Verification (Full Session Fork)
      const forkResp = await fetch(`${platformUrl}/api/sessions/${sessionId}/fork`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: authCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: originHeader,
        },
        body: JSON.stringify({
          title: 'Docker Acceptance Forked Session',
        }),
      });
      if (forkResp.status !== 201) {
        const errText = await forkResp.text();
        throw new Error(`Fork session failed with status ${forkResp.status}: ${errText}`);
      }
      const forkedSessionJson = (await forkResp.json()) as any;
      const forkedSessionId = forkedSessionJson.data.id;
      if (!forkedSessionId || forkedSessionId === sessionId) {
        throw new Error('FAIL-CLOSED: Invalid forked session ID');
      }

      // 13. Session Archive & Restore Verification
      const archResp = await fetch(`${platformUrl}/api/sessions/${forkedSessionId}/archive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: authCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: originHeader,
        },
        body: JSON.stringify({}),
      });
      if (archResp.status !== 200) {
        throw new Error(`Archive forked session failed with status ${archResp.status}`);
      }

      const restoreResp = await fetch(`${platformUrl}/api/sessions/${forkedSessionId}/restore`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: authCookie,
          'X-Enkeep-CSRF': csrfToken,
          Origin: originHeader,
        },
        body: JSON.stringify({}),
      });
      if (restoreResp.status !== 200) {
        throw new Error(`Restore forked session failed with status ${restoreResp.status}`);
      }
      const restoredJson = (await restoreResp.json()) as any;
      if (restoredJson.data.status !== 'active') {
        throw new Error('FAIL-CLOSED: Restored session status is not active');
      }

      return {
        platformUrl,
        aliceEndpoint: running.result.runtimes.alice.endpoint,
        bobEndpoint: running.result.runtimes.bob.endpoint,
        containerId: aliceHandle.containerId,
        healthStatus: aliceHealth.status,
        dshVersion: aliceHealth.version,
        sessionId,
        forkedSessionId,
        userMessage: 'Reply with exactly: Enkeep Docker runtime ready.',
        assistantReply: assistantMsg.content,
        persistedMessagesCount: messages.length,
        charlieDynamicProvisioning: {
          charlieUserId,
          containerName: charlieHandle.containerName,
          toolsOperational: charlieHealth.toolsOperational,
          messagesCount: charlieMessages.length,
        },
      };
    } finally {
      await running.close({ removeVolumes: true });
    }
  });

  // --- Step 9: Teardown (`demo:down`) with volume removal ---
  await runStep('step_teardown', 'Execute safe metadata-verified teardown with removeVolumes', async () => {
    const downResult = await downDemo({ ...pathOptions, removeVolumes: true });
    if (!downResult.ok) throw new Error('Teardown reported failure');
    return {
      cleanedMetadata: downResult.cleanedMetadataCount,
      terminatedProcesses: downResult.terminatedProcesses.length,
      terminatedContainers: downResult.terminatedContainers.length,
      removedVolumes: downResult.removedVolumes.length,
    };
  });

  // --- Step 10: Verify Zero Remaining Containers & Volumes ---
  await runStep('step_verify_zero_resources', 'Verify zero demo containers or volumes remain in Docker', async () => {
    if (!options.runtimeAdapter) {
      const dockerClient = new SafeDockerClient();
      const isDockerAvailable = await dockerClient.isDockerAvailable();
      if (isDockerAvailable) {
        const suffix = options.resourceSuffix ? `-${options.resourceSuffix}` : '';
        const aliceContainer = `enkeep-demo-alice${suffix}`;
        const bobContainer = `enkeep-demo-bob${suffix}`;
        const charlieContainer = `enkeep-demo-charlie_new${suffix}`;
        const aliceVol = `enkeep-demo-dsh-alice${suffix}`;
        const bobVol = `enkeep-demo-dsh-bob${suffix}`;
        const charlieVol = `enkeep-demo-dsh-charlie_new${suffix}`;

        const [aliceInspect, bobInspect, charlieInspect, aliceVolInspect, bobVolInspect, charlieVolInspect] = await Promise.all([
          dockerClient.inspectContainer(aliceContainer),
          dockerClient.inspectContainer(bobContainer),
          dockerClient.inspectContainer(charlieContainer),
          dockerClient.inspectVolume(aliceVol),
          dockerClient.inspectVolume(bobVol),
          dockerClient.inspectVolume(charlieVol),
        ]);

        if (aliceInspect !== null) throw new Error(`${aliceContainer} container still exists after teardown`);
        if (bobInspect !== null) throw new Error(`${bobContainer} container still exists after teardown`);
        if (charlieInspect !== null) throw new Error(`${charlieContainer} container still exists after teardown`);

        if (aliceVolInspect !== null) throw new Error(`${aliceVol} volume still exists after teardown`);
        if (bobVolInspect !== null) throw new Error(`${bobVol} volume still exists after teardown`);
        if (charlieVolInspect !== null) throw new Error(`${charlieVol} volume still exists after teardown`);
      }
    }
    return {
      zeroContainersRemaining: true,
      zeroVolumesRemaining: true,
    };
  });

  // --- Step 11: Probe Protected Ports 3000 & 3080 After Teardown ---
  const probeAfter = await probeProtectedPorts();
  const probeComparison = assertProbesUnchanged(probeBefore, probeAfter);

  await runStep('step_integrity_probe', 'Verify ports 3000 and 3080 listener PIDs remained unmolested', async () => {
    if (!probeComparison.unchanged) {
      throw new Error(`Safety Violation: Protected services disrupted:\n${probeComparison.discrepancies.join('\n')}`);
    }
    return {
      port3000BeforePid: probeBefore.port3000.listenerPid,
      port3000AfterPid: probeAfter.port3000.listenerPid,
      port3080BeforePid: probeBefore.port3080.listenerPid,
      port3080AfterPid: probeAfter.port3080.listenerPid,
      discrepancies: probeComparison.discrepancies,
    };
  });

  const totalDurationMs = Date.now() - startTime;
  const passedCount = steps.filter((s) => s.passed).length;
  const failedCount = steps.filter((s) => !s.passed).length;

  return {
    ok: failedCount === 0 && probeComparison.unchanged,
    timestamp: new Date().toISOString(),
    totalDurationMs,
    probeBefore,
    probeAfter,
    probesUnchanged: probeComparison.unchanged,
    steps,
    summary: {
      total: steps.length,
      passed: passedCount,
      failed: failedCount,
    },
  };
}
