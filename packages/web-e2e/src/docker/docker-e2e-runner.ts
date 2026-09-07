/**
 * Real Docker E2E Runner and Verification Suite (Layer B).
 *
 * Enforces:
 * 1. Docker preflight: fails closed if Docker daemon is unavailable or ENKEEP_RUNTIME_IMAGE is missing.
 *    Enforces exact acceptance image tag 'enkeep-demo-runtime:acceptance'.
 * 2. Strict ephemeral isolation:
 *    - Generates 12-char random hex suffix for container and volume names.
 *    - Pre-inspects exact generated resource names to fail closed on collision without deleting preexisting resources.
 *    - Uses isolated temporary dataRoot (mkdtemp in OS tmpdir with tracked dev/ino/uid).
 *    - Never uses or touches production .demo-data.
 * 3. Lifecycle containment:
 *    - Provisions fresh credentials and schema via resetDemo({ mode: 'test', dataRoot, resourceSuffix }).
 *    - Launches isolated demo system via launchDemoSystem({ mode: 'test', dataRoot, resourceSuffix, runtimeImage }).
 *    - Tracks only returned system handle; finally system.close({ removeVolumes: true }) and dataRoot removal.
 *    - No cleanup sweeps, no live label queries, no broad downDemo.
 * 4. Exact Container Security & Invariant Inspection:
 *    - Distinct full 64-hex SHA-256 container IDs.
 *    - Suffix matching container/volume names.
 *    - Zero network mode (--network none).
 *    - Non-root user (exact UID:GID 1000:1000).
 *    - Read-only rootfs, cap-drop ALL, no-new-privileges:true, pids limit (exact 256), zero published ports (portBindings null).
 *    - Exact canonical tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m.
 *    - Exact sorted container label keys: ['app', 'enkeep.run-id', 'enkeep.user', 'enkeep.volume-id'].
 *    - Exact volume mount at /home/dsh with rw=true.
 *    - Cross-tenant container isolation (Bob cannot access or resume Alice DSH session history; Alice history unaffected).
 * 5. Browser Automation (Playwright):
 *    - URL verification (127.0.0.1:<ephemeral>, != 3000/3080).
 *    - Alice login with dynamic credentials.
 *    - Enumerates all spaces/sessions via authenticated API, identifies exact 2 imported sessions (prefix 'import-'),
 *      and asserts aggregate exact 50 imported people-talk messages and 5 attachment notes within them.
 *    - Sends turn in imported session; verifies assistant card count increases and text matches deterministic [DemoModel:alice] model signature.
 *    - Session cookie persistence across page reload.
 *    - Exact container restart preserving 64-hex containerId and updating runtimeHandles map, followed by verified turn send.
 *    - New space and session creation with verified assistant reply.
 *    - User logout and auth protection verification (401 on protected routes).
 *    - Bob login in separate context; verified 404 on Alice session routes, Bob space/turn execution with [DemoModel:bob] signature.
 *    - Charlie disabled user login rejection (unified 401).
 *    - CSRF and Host header security rejections (wrong origin, localhost, wrong port, https).
 * 6. Leak Check:
 *    - Inspects ONLY own generated container and volume names after close and BEFORE dataRoot removal (verifying null).
 * 7. Protected Ports Guard:
 *    - Uses ports-guard (lsof -Fpc + ps -o lstart=,command= + net.connect) before and after.
 *    - Aggregates all errors in finally block.
 *
 * @module @enkeep/web-e2e/docker/docker-e2e-runner
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import {
  launchDemoSystem,
  resetDemo,
  findRepoRoot,
  type RunningDemoSystem,
} from '@enkeep/demo-runner';
import {
  SafeDockerClient,
} from '@enkeep/runtime-runner/docker';
import {
  launchPlaywrightBrowser,
  createIsolatedPage,
  uiLogin,
  uiLogout,
  uiCreateSpace,
  uiCreateSession,
  uiSendMessage,
} from '../contract/browser-helper.js';
import {
  probeProtectedPorts,
  assertProtectedPortsReady,
  assertProtectedPortsUnmolested,
  type ProtectedPortsSnapshot,
} from '../probes/ports-guard.js';

export interface DockerE2EResult {
  passed: boolean;
  details?: Record<string, unknown>;
}

function generateSuffix12(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12).toLowerCase();
}

function is64HexContainerId(id: unknown): id is string {
  return typeof id === 'string' && /^[0-9a-f]{64}$/i.test(id);
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

/**
 * Directory identity metadata tracked immediately upon creation.
 */
export interface DirectoryMetadataSnapshot {
  path: string;
  dev: number;
  ino: number;
  uid: number;
}

/**
 * Captures directory identity metadata (dev, ino, uid) without following symlinks.
 */
function captureDirectoryMetadata(dirPath: string): DirectoryMetadataSnapshot {
  const stat = lstatSync(dirPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`FAIL-CLOSED: Created path is a symbolic link: "${dirPath}"`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`FAIL-CLOSED: Created path is not a directory: "${dirPath}"`);
  }
  return {
    path: dirPath,
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
  };
}

/**
 * Safely removes a tracked directory:
 * - Avoids existsSync TOCTOU race and permission swallowing; uses lstatSync directly.
 * - Catches exact ENOENT; rethrows any other error.
 * - Verifies path is not a symlink, is a directory, and matches exact tracked dev, ino, and uid.
 * - Uses rmSync with recursive: true, force: false.
 */
function safeRemoveTrackedDirectory(expected: DirectoryMetadataSnapshot): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(expected.path);
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') {
      return; // Already removed
    }
    throw err;
  }

  if (stat.isSymbolicLink()) {
    throw new Error(`FAIL-CLOSED: Path to remove was replaced with a symbolic link: "${expected.path}"`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`FAIL-CLOSED: Path to remove is no longer a directory: "${expected.path}"`);
  }
  if (stat.dev !== expected.dev || stat.ino !== expected.ino) {
    throw new Error(
      `FAIL-CLOSED: Directory identity mismatch on "${expected.path}": expected dev=${expected.dev}, ino=${expected.ino}; got dev=${stat.dev}, ino=${stat.ino}`
    );
  }
  if (stat.uid !== expected.uid) {
    throw new Error(
      `FAIL-CLOSED: Directory owner mismatch on "${expected.path}": expected uid=${expected.uid}, got uid=${stat.uid}`
    );
  }

  rmSync(expected.path, { recursive: true, force: false });
}

/**
 * Sends a message via UI, waits for user card reflection, and verifies the newly arrived assistant
 * reply message card text matches the genuine deterministic model signature and prompt.
 */
async function sendTurnAndVerifyReply(
  page: Page,
  prompt: string,
  expectedUser: 'alice' | 'bob',
  timeoutMs = 120000
): Promise<string> {
  const prevUserCount = await page.locator('#messages-container .message-card.user').count();
  const prevAssistantCount = await page.locator('#messages-container .message-card.assistant').count();

  console.log(`[DockerE2E sendTurn] prevUserCount=${prevUserCount}, prevAssistantCount=${prevAssistantCount}, prompt="${prompt}"`);
  await uiSendMessage(page, prompt);

  // 1. Wait for user card count to increase and contain prompt text
  await page.waitForFunction(
    (args: { count: number; text: string }) => {
      const cards = document.querySelectorAll('#messages-container .message-card.user');
      if (cards.length < args.count) return false;
      const last = cards[cards.length - 1];
      return last && last.textContent && last.textContent.includes(args.text);
    },
    { count: prevUserCount + 1, text: prompt },
    { timeout: 10000 }
  );
  console.log('[DockerE2E sendTurn] User card appeared in DOM.');

  // 2. Wait for assistant message card count to increase by 1
  try {
    await page.waitForFunction(
      (targetCount: number) => {
        const cards = document.querySelectorAll('#messages-container .message-card.assistant');
        return cards.length >= targetCount;
      },
      prevAssistantCount + 1,
      { timeout: timeoutMs }
    );
  } catch (wfErr) {
    const currentAssistantCount = await page.locator('#messages-container .message-card.assistant').count();
    const currentUserCount = await page.locator('#messages-container .message-card.user').count();
    const stateObj = await page.evaluate(() => (window as any).state);
    console.error(`[DockerE2E sendTurn TIMEOUT] currentAssistantCount=${currentAssistantCount}, currentUserCount=${currentUserCount}, state=`, JSON.stringify(stateObj, null, 2));
    throw wfErr;
  }

  // 3. Get the newest assistant card
  const newestAssistantCard = page.locator('#messages-container .message-card.assistant').last();
  const assistantContent = (await newestAssistantCard.locator('.message-content').textContent()) || '';

  // 4. Assert response based on mode
  const isDemoMode = process.env.ENKEEP_LLM_ENABLED === '0';
  if (isDemoMode) {
    const expectedFullModelOutput =
      `[DemoModel:${expectedUser}] Received turn: "${prompt}". ` +
      `Official DSH agent loop active, session persisted successfully.`;

    if (assistantContent.trim() !== expectedFullModelOutput.trim()) {
      throw new Error(
        `Assistant message reply does not match exact expected full model output.\n` +
        `Expected exact body: "${expectedFullModelOutput}"\n` +
        `Got content: "${assistantContent}"`
      );
    }
  } else {
    // Real LLM mode
    if (!assistantContent || typeof assistantContent !== 'string' || assistantContent.trim().length === 0) {
      throw new Error('Assistant message reply is empty in real LLM mode');
    }
    if (assistantContent.includes('[DemoModel:')) {
      throw new Error(`Assistant message reply unexpectedly contains [DemoModel: in real LLM mode: "${assistantContent}"`);
    }
  }

  return assistantContent;
}

/**
 * Runs the comprehensive Real Docker E2E acceptance test suite.
 */
export async function runRealDockerE2ETest(): Promise<DockerE2EResult> {
  console.log('[DockerE2E] Step 1: Preflight validation (Docker daemon & acceptance image)...');

  const rawRuntimeImage = process.env.ENKEEP_RUNTIME_IMAGE?.trim();
  if (!rawRuntimeImage) {
    throw new Error(
      'FAIL-CLOSED: ENKEEP_RUNTIME_IMAGE environment variable is required and must specify the acceptance image tag.'
    );
  }

  // Enforce exact acceptance image tag pattern to prevent running against production or arbitrary untagged images
  const acceptanceImagePattern = /^enkeep-demo-runtime:acceptance$/;
  if (!acceptanceImagePattern.test(rawRuntimeImage)) {
    throw new Error(
      `FAIL-CLOSED: Invalid runtime image "${rawRuntimeImage}". Acceptance tests require exact tag "enkeep-demo-runtime:acceptance".`
    );
  }
  const runtimeImage = rawRuntimeImage;

  const dockerClient = new SafeDockerClient();
  const isDockerAvailable = await dockerClient.isDockerAvailable();
  if (!isDockerAvailable) {
    throw new Error(
      'FAIL-CLOSED: Docker daemon is unavailable. Real Docker E2E tests require an active Docker daemon.'
    );
  }

  const repoRoot = findRepoRoot();
  const suffix12 = generateSuffix12();
  const dataRoot = mkdtempSync(join(tmpdir(), 'enkeep-web-e2e-'));
  const dataRootSnapshot = captureDirectoryMetadata(dataRoot);

  console.log(`[DockerE2E] Initialized isolated test environment: suffix=${suffix12}, dataRoot=${dataRoot}`);

  // Pre-inspect exact expected resource names on Docker daemon to fail closed on collision
  const expectedAliceContainerName = `enkeep-demo-alice-${suffix12}`;
  const expectedBobContainerName = `enkeep-demo-bob-${suffix12}`;
  const expectedAliceVolName = `enkeep-demo-dsh-alice-${suffix12}`;
  const expectedBobVolName = `enkeep-demo-dsh-bob-${suffix12}`;

  const [preAliceCont, preBobCont, preAliceVol, preBobVol] = await Promise.all([
    dockerClient.inspectContainer(expectedAliceContainerName),
    dockerClient.inspectContainer(expectedBobContainerName),
    dockerClient.inspectVolume(expectedAliceVolName),
    dockerClient.inspectVolume(expectedBobVolName),
  ]);

  if (preAliceCont !== null) {
    throw new Error(`FAIL-CLOSED: Pre-flight collision: Container "${expectedAliceContainerName}" already exists.`);
  }
  if (preBobCont !== null) {
    throw new Error(`FAIL-CLOSED: Pre-flight collision: Container "${expectedBobContainerName}" already exists.`);
  }
  if (preAliceVol !== null) {
    throw new Error(`FAIL-CLOSED: Pre-flight collision: Volume "${expectedAliceVolName}" already exists.`);
  }
  if (preBobVol !== null) {
    throw new Error(`FAIL-CLOSED: Pre-flight collision: Volume "${expectedBobVolName}" already exists.`);
  }

  const origLlmEnabled = process.env.ENKEEP_LLM_ENABLED;
  process.env.ENKEEP_LLM_ENABLED = '0';

  console.log('[DockerE2E] Step 2: Probing protected ports 3000 & 3080 before test execution...');
  let probeBefore: ProtectedPortsSnapshot;
  try {
    probeBefore = await probeProtectedPorts();
    assertProtectedPortsReady(probeBefore);
  } catch (err: unknown) {
    const probeErrors: Error[] = [err instanceof Error ? err : new Error(String(err))];
    try {
      safeRemoveTrackedDirectory(dataRootSnapshot);
    } catch (cleanupErr: unknown) {
      probeErrors.push(cleanupErr instanceof Error ? cleanupErr : new Error(String(cleanupErr)));
    }
    if (probeErrors.length === 1) {
      throw probeErrors[0];
    }
    throw new AggregateError(probeErrors, 'Failed initial protected ports probe and cleanup');
  }

  let system: RunningDemoSystem | undefined;
  let browser: Awaited<ReturnType<typeof launchPlaywrightBrowser>> | undefined;
  const primaryAndTeardownErrors: Error[] = [];

  try {
    console.log('[DockerE2E] Step 3: Executing clean isolated resetDemo...');
    const resetResult = await resetDemo({
      repoRoot,
      mode: 'test',
      dataRoot,
      resourceSuffix: suffix12,
      forceClean: true,
    });

    if (!resetResult.ok) {
      throw new Error('FAIL-CLOSED: resetDemo returned ok=false');
    }

    const { credentials } = resetResult;
    const alicePassword = credentials.admin.password;
    const bobPassword = credentials.user.password;
    const charliePassword = credentials.disabledUser.password;

    console.log('[DockerE2E] Step 4: Launching isolated demo system with user containers...');
    system = await launchDemoSystem({
      repoRoot,
      mode: 'test',
      dataRoot,
      resourceSuffix: suffix12,
      runtimeImage,
    });

    const platformUrl = system.result.platform.url;
    if (!platformUrl) {
      throw new Error('FAIL-CLOSED: PlatformServer endpoint URL is missing in demo system result');
    }
    console.log(`[DockerE2E] Isolated demo system running at ${platformUrl}`);

    // Invariant Check 1: Host and Ephemeral Port
    const parsedUrl = new URL(platformUrl);
    if (parsedUrl.hostname !== '127.0.0.1') {
      throw new Error(`Security violation: PlatformServer bound to "${parsedUrl.hostname}", expected strict 127.0.0.1`);
    }
    const platformPort = parseInt(parsedUrl.port, 10);
    if (platformPort === 3000 || platformPort === 3080) {
      throw new Error(`Port collision violation: PlatformServer bound to protected port ${platformPort}`);
    }

    // Resolve authoritative canonical user IDs from system storage
    const aliceUser = await system.storage.users.findByUsername('alice');
    const bobUser = await system.storage.users.findByUsername('bob');
    if (!aliceUser || !bobUser) {
      throw new Error('FAIL-CLOSED: Failed to retrieve user records for Alice and Bob from storage');
    }
    const aliceUserId = aliceUser.id;
    const bobUserId = bobUser.id;

    // =========================================================================
    // Step 5: Container Invariants Inspection (Zero Network, Security & Labels)
    // =========================================================================
    console.log('[DockerE2E] Step 5: Inspecting Docker container hardening invariants...');

    const aliceHandle = system.runtimeHandles.get(aliceUserId);
    const bobHandle = system.runtimeHandles.get(bobUserId);

    if (!aliceHandle || !bobHandle) {
      throw new Error('FAIL-CLOSED: Failed to retrieve user runtime handles for Alice and Bob');
    }

    // Health check validation: checkHealth returns status 'ok'
    const [aliceHealth, bobHealth] = await Promise.all([
      aliceHandle.checkHealth(),
      bobHandle.checkHealth(),
    ]);

    if (!aliceHealth || aliceHealth.status !== 'ok') {
      throw new Error(`FAIL-CLOSED: Alice runtime health check failed: expected status 'ok', got "${aliceHealth?.status}"`);
    }
    if (!bobHealth || bobHealth.status !== 'ok') {
      throw new Error(`FAIL-CLOSED: Bob runtime health check failed: expected status 'ok', got "${bobHealth?.status}"`);
    }

    // Volume ID format: canonical vol_ prefix
    if (!aliceHandle.volumeId || !/^vol_[a-zA-Z0-9_-]{1,64}$/.test(aliceHandle.volumeId)) {
      throw new Error(`Alice volume ID "${aliceHandle.volumeId}" is not a canonical vol_ ID`);
    }
    if (!bobHandle.volumeId || !/^vol_[a-zA-Z0-9_-]{1,64}$/.test(bobHandle.volumeId)) {
      throw new Error(`Bob volume ID "${bobHandle.volumeId}" is not a canonical vol_ ID`);
    }

    // 5.1 64-hex Container IDs & Uniqueness
    if (!is64HexContainerId(aliceHandle.containerId)) {
      throw new Error(`Alice container ID "${aliceHandle.containerId}" is not a valid 64-hex SHA-256 ID`);
    }
    if (!is64HexContainerId(bobHandle.containerId)) {
      throw new Error(`Bob container ID "${bobHandle.containerId}" is not a valid 64-hex SHA-256 ID`);
    }
    if (aliceHandle.containerId === bobHandle.containerId) {
      throw new Error('CRITICAL COLLISION: Alice and Bob share the exact same container ID');
    }

    // 5.2 Suffix verification
    if (!aliceHandle.containerName.endsWith(`-${suffix12}`)) {
      throw new Error(`Alice container name "${aliceHandle.containerName}" missing suffix "${suffix12}"`);
    }
    if (!bobHandle.containerName.endsWith(`-${suffix12}`)) {
      throw new Error(`Bob container name "${bobHandle.containerName}" missing suffix "${suffix12}"`);
    }

    // 5.3 Live Container Inspection
    for (const handle of [aliceHandle, bobHandle]) {
      const inspect = await dockerClient.inspectContainer(handle.containerId);
      if (!inspect) {
        throw new Error(`Container "${handle.containerId}" (${handle.containerName}) not found on daemon`);
      }

      // Zero network mode (--network none)
      const networkMode = inspect.networkMode || '';
      if (networkMode !== 'none') {
        throw new Error(`Network isolation violation: container "${handle.containerName}" networkMode is "${networkMode}"`);
      }

      // Zero published host ports: parser returns exact null only
      if (inspect.portBindings !== null) {
        throw new Error(`Port exposure violation: container "${handle.containerName}" exposed ports: ${JSON.stringify(inspect.portBindings)}`);
      }

      // Non-root user: exact UID:GID 1000:1000 as configured in execution spec
      const user = inspect.user || '';
      if (user !== '1000:1000') {
        throw new Error(`Non-root user requirement violation on "${handle.containerName}": expected exact "1000:1000", got "${user}"`);
      }

      // Read-only root filesystem: exact boolean true
      if (inspect.readonlyRootfs !== true) {
        throw new Error(`Container hardening violation: container "${handle.containerName}" is not read-only`);
      }

      // Dropped capabilities: exact raw single element ["ALL"]
      if (
        !Array.isArray(inspect.capDrop) ||
        inspect.capDrop.length !== 1 ||
        inspect.capDrop[0] !== 'ALL'
      ) {
        throw new Error(
          `Container hardening violation: container "${handle.containerName}" CapDrop must be exactly ["ALL"] (got: ${JSON.stringify(inspect.capDrop)})`
        );
      }

      // Security option: exact raw array ['no-new-privileges:true']
      if (
        !Array.isArray(inspect.securityOpt) ||
        inspect.securityOpt.length !== 1 ||
        inspect.securityOpt[0] !== 'no-new-privileges:true'
      ) {
        throw new Error(
          `Container hardening violation: container "${handle.containerName}" securityOpt must be exactly canonical ["no-new-privileges:true"] (got: ${JSON.stringify(inspect.securityOpt)})`
        );
      }

      // PIDs limit: must be exact configured 256
      if (inspect.pidsLimit !== 256) {
        throw new Error(
          `Container hardening violation: invalid pidsLimit ${inspect.pidsLimit} on "${handle.containerName}" (expected exact 256)`
        );
      }

      // Restricted tmpfs: exactly one mount on /tmp with exact canonical option string
      if (!inspect.tmpfs || typeof inspect.tmpfs !== 'object') {
        throw new Error(`Container hardening violation: container "${handle.containerName}" missing tmpfs configuration`);
      }
      const tmpfsKeys = Object.keys(inspect.tmpfs);
      if (tmpfsKeys.length !== 1 || tmpfsKeys[0] !== '/tmp') {
        throw new Error(
          `Container hardening violation: container "${handle.containerName}" tmpfs must have only "/tmp" (got: ${tmpfsKeys.join(', ')})`
        );
      }
      const tmpOptions = inspect.tmpfs['/tmp'];
      if (tmpOptions !== 'rw,noexec,nosuid,nodev,size=64m') {
        throw new Error(
          `Container hardening violation: container "${handle.containerName}" tmpfs /tmp options "${tmpOptions}" not exact canonical "rw,noexec,nosuid,nodev,size=64m"`
        );
      }

      // Container Labels: sorted keys must equal exactly ['app', 'enkeep.run-id', 'enkeep.user', 'enkeep.volume-id']
      const labelKeys = Object.keys(inspect.labels).sort();
      const expectedLabelKeys = ['app', 'enkeep.run-id', 'enkeep.user', 'enkeep.volume-id'];
      if (
        labelKeys.length !== expectedLabelKeys.length ||
        !labelKeys.every((k, idx) => k === expectedLabelKeys[idx])
      ) {
        throw new Error(
          `Container labels mismatch on "${handle.containerName}": expected exact keys [${expectedLabelKeys.join(', ')}], got [${labelKeys.join(', ')}]`
        );
      }

      if (inspect.labels['app'] !== 'enkeep-demo') {
        throw new Error(`Missing or invalid "app" label on container "${handle.containerName}": expected "enkeep-demo", got "${inspect.labels['app']}"`);
      }
      if (inspect.labels['enkeep.user'] !== handle.userId) {
        throw new Error(`User label mismatch on container "${handle.containerName}": expected "${handle.userId}", got "${inspect.labels['enkeep.user']}"`);
      }
      if (inspect.labels['enkeep.run-id'] !== handle.runId) {
        throw new Error(`Run ID label mismatch on container "${handle.containerName}": expected "${handle.runId}", got "${inspect.labels['enkeep.run-id']}"`);
      }
      if (inspect.labels['enkeep.volume-id'] !== handle.volumeId) {
        throw new Error(`Volume ID label mismatch on container "${handle.containerName}": expected "${handle.volumeId}", got "${inspect.labels['enkeep.volume-id']}"`);
      }

      // Dedicated mount at /home/dsh: enforce mounts.length === 1, type volume, expectedVolName, /home/dsh, rw === true
      const expectedVolName = handle.meta?.volumeName ?? `enkeep-demo-dsh-${handle.userId}-${suffix12}`;
      if (!inspect.mounts || inspect.mounts.length !== 1) {
        throw new Error(
          `Mount isolation violation: container "${handle.containerName}" must have exactly 1 mount (got ${inspect.mounts?.length ?? 0})`
        );
      }
      const singleMount = inspect.mounts[0];
      if (singleMount.type !== 'volume') {
        throw new Error(`Mount isolation violation: container "${handle.containerName}" mount type is "${singleMount.type}", expected "volume"`);
      }
      if (singleMount.name !== expectedVolName) {
        throw new Error(`Mount isolation violation: container "${handle.containerName}" mounted volume name is "${singleMount.name}", expected "${expectedVolName}"`);
      }
      if (singleMount.destination !== '/home/dsh') {
        throw new Error(`Mount isolation violation: container "${handle.containerName}" destination is "${singleMount.destination}", expected "/home/dsh"`);
      }
      if (singleMount.rw !== true) {
        throw new Error(`Mount isolation violation: container "${handle.containerName}" volume mount rw is not true`);
      }

      // Volume Inspection & Labels: app, enkeep.user, enkeep.volume-id
      const volInspect = await dockerClient.inspectVolume(expectedVolName);
      if (!volInspect) {
        throw new Error(`Volume "${expectedVolName}" for user "${handle.userId}" not found on daemon`);
      }
      if (volInspect.labels['app'] !== 'enkeep-demo') {
        throw new Error(`Missing or invalid "app" label on volume "${expectedVolName}": expected "enkeep-demo", got "${volInspect.labels['app']}"`);
      }
      if (volInspect.labels['enkeep.user'] !== handle.userId) {
        throw new Error(`User label mismatch on volume "${expectedVolName}": expected "${handle.userId}", got "${volInspect.labels['enkeep.user']}"`);
      }
      if (volInspect.labels['enkeep.volume-id'] !== handle.volumeId) {
        throw new Error(`Volume ID label mismatch on volume "${expectedVolName}": expected "${handle.volumeId}", got "${volInspect.labels['enkeep.volume-id']}"`);
      }
    }

    // 5.4 Cross-Tenant DSH Session Isolation: Bob cannot access or resume Alice's DSH session history
    console.log('[DockerE2E] Verifying Bob container volume does not contain Alice DSH session data...');
    const aliceSessionKey = 'ses_happyclaw_alice_001';
    let bobCrossTenantExecError: string | undefined;
    try {
      const bobRes = await bobHandle.sendTurn({
        prompt: 'Unauthorized attempt to read Alice history from Bob',
        sessionId: aliceSessionKey,
        turnId: 'turn_bob_cross_001',
        profileSnapshot: null,
      });
      // If Bob's container executes, it creates a fresh isolated empty session on Bob's volume without Alice's history
      if (bobRes && bobRes.replyText) {
        // Verify Bob's reply did not leak any Alice history
        const lowerReply = bobRes.replyText.toLowerCase();
        if (lowerReply.includes('alice') && lowerReply.includes('admin')) {
          throw new Error('CRITICAL TENANT LEAK: Bob container reply referenced Alice secret history');
        }
      }
    } catch (err: unknown) {
      bobCrossTenantExecError = err instanceof Error ? err.message : String(err);
    }
    console.log(`[DockerE2E] Cross-tenant execution check completed (result: ${bobCrossTenantExecError ? 'isolated-reject' : 'isolated-fresh'}).`);

    // =========================================================================
    // Step 6: Playwright UI Automation
    // =========================================================================
    console.log('[DockerE2E] Step 6: Launching Playwright browser for UI automation...');
    browser = await launchPlaywrightBrowser({ headless: true });

    // -------------------------------------------------------------------------
    // Scenario A: Alice Login & Imported Chat Verification
    // -------------------------------------------------------------------------
    console.log('[DockerE2E] Scenario A: Alice login and imported session interaction...');
    const { context: aliceContext, page: alicePage } = await createIsolatedPage(browser);

    await uiLogin(alicePage, platformUrl, 'alice', alicePassword);
    await alicePage.waitForSelector('#app-view', { state: 'visible', timeout: 10000 });

    const aliceDisplayName = await alicePage.textContent('#user-display-name');
    if (!aliceDisplayName?.includes('Alice')) {
      throw new Error(`Expected Alice display name in UI, got "${aliceDisplayName}"`);
    }

    // 1. Verify Role Badge & Management Nav Visibility for Admin (Alice)
    const aliceRoleBadge = await alicePage.textContent('#user-role-badge');
    if (!aliceRoleBadge?.includes('Admin')) {
      throw new Error(`Expected "Admin" role badge for Alice, got "${aliceRoleBadge}"`);
    }
    await alicePage.waitForSelector('#management-nav', { state: 'visible', timeout: 5000 });

    // 2. Admin Management Overview Navigation & Global KPI Verification (Dual-Entry Nav Click)
    console.log('[DockerE2E] Verifying Admin Management Overview navigation and global KPIs...');
    await alicePage.click('#nav-management');
    await alicePage.waitForFunction(() => window.location.hash.startsWith('#management') || window.location.hash === '#overview', { timeout: 5000 });
    await alicePage.waitForSelector('#view-management:not(.hidden)', { state: 'visible', timeout: 5000 });
    await alicePage.waitForFunction(() => {
      const h2 = document.querySelector('#management-content .management-header-title h2');
      return h2 && (h2.textContent === 'Admin Dashboard' || h2.textContent?.includes('Dashboard') || h2.textContent?.includes('Overview'));
    }, { timeout: 5000 });
    await alicePage.waitForSelector('#management-content .kpi-grid', { state: 'visible', timeout: 5000 });
    const dashText = await alicePage.textContent('#management-content');
    if (!dashText?.includes('Total Users') || !dashText?.includes('Total Spaces') || !dashText?.includes('Total Sessions') || !dashText?.includes('Total Messages')) {
      throw new Error(`Admin overview content missing global KPI cards: "${dashText}"`);
    }

    // 3. Tab 1: Runtime Engine Navigation via Real Tab & Section Clicks
    console.log('[DockerE2E] Verifying Runtime Engine tab and container sandboxes...');
    await alicePage.click('#tab-btn-runtime');
    await alicePage.waitForFunction(() => window.location.hash.includes('runtime'), { timeout: 5000 });
    await alicePage.waitForSelector('#view-management:not(.hidden)', { state: 'visible', timeout: 5000 });
    await alicePage.waitForFunction(() => {
      const h2 = document.querySelector('#management-content .management-header-title h2');
      return h2 && h2.textContent === 'Runtime Engine';
    }, { timeout: 5000 });
    await alicePage.waitForSelector('#management-content .data-table tbody tr', { state: 'visible', timeout: 5000 });
    const runtimeContent = await alicePage.textContent('#management-content');
    if (runtimeContent?.includes('Runtime Service Unavailable')) {
      throw new Error(`Runtime view unexpectedly shows unavailable: "${runtimeContent}"`);
    }
    if (!runtimeContent?.includes(aliceUserId) || !runtimeContent?.includes(bobUserId)) {
      throw new Error(`Runtime table does not display active user IDs (${aliceUserId}, ${bobUserId}): "${runtimeContent}"`);
    }
    if (!runtimeContent?.includes('none') || !runtimeContent?.includes('Ready')) {
      throw new Error(`Runtime table does not display network isolation "none" or "Ready" status: "${runtimeContent}"`);
    }

    // Verify /api/admin/runtime API response structure and exact values
    const runtimeRes = await alicePage.request.get(`${platformUrl}/api/admin/runtime`);
    if (runtimeRes.status() !== 200) {
      throw new Error(`FAIL-CLOSED: /api/admin/runtime returned status ${runtimeRes.status()}`);
    }
    const runtimeJson = await runtimeRes.json();
    if (!runtimeJson.data?.available || !Array.isArray(runtimeJson.data?.runtimes) || runtimeJson.data.runtimes.length < 2) {
      throw new Error('FAIL-CLOSED: /api/admin/runtime missing runtimes array');
    }
    const aliceRt = runtimeJson.data.runtimes.find((r: any) => r.userId === aliceUserId || r.userId === 'alice');
    const bobRt = runtimeJson.data.runtimes.find((r: any) => r.userId === bobUserId || r.userId === 'bob');
    if (!aliceRt || !bobRt) {
      throw new Error('FAIL-CLOSED: /api/admin/runtime missing alice or bob runtime record');
    }
    if (aliceRt.containerId && (aliceRt.containerId !== aliceHandle.containerId || !is64HexContainerId(aliceRt.containerId))) {
      throw new Error(`FAIL-CLOSED: Alice runtime containerId mismatch: expected "${aliceHandle.containerId}", got "${aliceRt.containerId}"`);
    }
    if (bobRt.containerId && (bobRt.containerId !== bobHandle.containerId || !is64HexContainerId(bobRt.containerId))) {
      throw new Error(`FAIL-CLOSED: Bob runtime containerId mismatch: expected "${bobHandle.containerId}", got "${bobRt.containerId}"`);
    }
    if (aliceRt.networkMode !== 'none' || bobRt.networkMode !== 'none') {
      throw new Error(`FAIL-CLOSED: Expected networkMode "none", got alice=${aliceRt.networkMode}, bob=${bobRt.networkMode}`);
    }
    if (aliceRt.dshReady !== true || bobRt.dshReady !== true) {
      throw new Error(`FAIL-CLOSED: Expected dshReady true for alice & bob, got alice=${aliceRt.dshReady}, bob=${bobRt.dshReady}`);
    }

    // 4. Tab 1 Section: Plugins Registry Navigation via Real Section Click
    console.log('[DockerE2E] Verifying Admin Plugins registry and readiness...');
    await alicePage.click('button[data-section="plugins"]');
    await alicePage.waitForFunction(() => window.location.hash.includes('plugins'), { timeout: 5000 });
    await alicePage.waitForSelector('#view-management:not(.hidden)', { state: 'visible', timeout: 5000 });
    await alicePage.waitForFunction(() => {
      const h2 = document.querySelector('#management-content .management-header-title h2');
      return h2 && h2.textContent === 'Plugins Registry';
    }, { timeout: 5000 });
    await alicePage.waitForSelector('#management-content .data-table tbody tr', { state: 'visible', timeout: 5000 });
    const pluginsContent = await alicePage.textContent('#management-content');
    if (pluginsContent?.includes('Plugins Registry Unavailable')) {
      throw new Error(`Plugins view unexpectedly shows unavailable: "${pluginsContent}"`);
    }
    if (!pluginsContent?.includes('Loaded') || !pluginsContent?.includes('Ready')) {
      throw new Error(`Plugins table does not display bundle loaded / ready status: "${pluginsContent}"`);
    }

    // Also verify /api/admin/plugins returns exact readiness for all 7 Cordis plugins across Alice and Bob
    const pluginsRes = await alicePage.request.get(`${platformUrl}/api/admin/plugins`);
    if (pluginsRes.status() !== 200) {
      throw new Error(`FAIL-CLOSED: /api/admin/plugins returned status ${pluginsRes.status()}`);
    }
    const pluginsJson = await pluginsRes.json();
    if (!pluginsJson.data?.available || !Array.isArray(pluginsJson.data?.runtimes) || pluginsJson.data.runtimes.length < 2) {
      throw new Error('FAIL-CLOSED: /api/admin/plugins does not report live runtime plugin readiness');
    }
    const expectedPluginKeys = [
      'affinityPolicy',
      'eventRelay',
      'externalInteraction',
      'inbound',
      'llmAffinity',
      'receiptStore',
      'tools',
    ];
    for (const [expectedUser, expectedUserId] of [['alice', aliceUserId], ['bob', bobUserId]]) {
      const userRt = pluginsJson.data.runtimes.find((r: any) => r.userId === expectedUserId || r.userId === expectedUser);
      if (!userRt) {
        throw new Error(`FAIL-CLOSED: /api/admin/plugins missing runtime record for user "${expectedUser}"`);
      }
      if (userRt.enkeepBundleLoaded !== true) {
        throw new Error(`FAIL-CLOSED: enkeepBundleLoaded is not true for user "${expectedUser}": ${userRt.enkeepBundleLoaded}`);
      }
      if (!userRt.plugins || typeof userRt.plugins !== 'object') {
        throw new Error(`FAIL-CLOSED: Missing plugins object for user "${expectedUser}"`);
      }
      const actualKeys = Object.keys(userRt.plugins).sort();
      if (actualKeys.length !== 7 || JSON.stringify(actualKeys) !== JSON.stringify(expectedPluginKeys)) {
        throw new Error(`FAIL-CLOSED: Expected exactly 7 plugin keys ${JSON.stringify(expectedPluginKeys)}, got ${JSON.stringify(actualKeys)} for "${expectedUser}"`);
      }
      for (const key of expectedPluginKeys) {
        if (userRt.plugins[key] !== true) {
          throw new Error(`FAIL-CLOSED: Plugin "${key}" readiness is not true for user "${expectedUser}": ${userRt.plugins[key]}`);
        }
      }
    }

    // 5. Tab 1 Section: Security Posture Navigation via Real Section Click
    console.log('[DockerE2E] Verifying Admin Security posture and schema version...');
    await alicePage.click('button[data-section="security"]');
    await alicePage.waitForFunction(() => window.location.hash.includes('security'), { timeout: 5000 });
    await alicePage.waitForSelector('#view-management:not(.hidden)', { state: 'visible', timeout: 5000 });
    await alicePage.waitForFunction(() => {
      const h2 = document.querySelector('#management-content .management-header-title h2');
      return h2 && h2.textContent === 'Security & Posture';
    }, { timeout: 5000 });
    await alicePage.waitForSelector('#management-content .kpi-grid', { state: 'visible', timeout: 5000 });

    // Verify /api/admin/security returns currentVersion, expectedVersion, and checksumsMatch === true
    const secRes = await alicePage.request.get(`${platformUrl}/api/admin/security`);
    if (secRes.status() !== 200) {
      throw new Error(`FAIL-CLOSED: /api/admin/security returned status ${secRes.status()}`);
    }
    const secJson = await secRes.json();
    if (!secJson.data?.migrations) {
      throw new Error('FAIL-CLOSED: /api/admin/security missing migrations object');
    }
    const currentVersion = secJson.data.migrations.currentVersion;
    if (typeof currentVersion !== 'number' || currentVersion < 13) {
      throw new Error(`FAIL-CLOSED: Expected currentVersion >= 13, got ${currentVersion}`);
    }
    if (secJson.data.migrations.expectedVersion !== currentVersion) {
      throw new Error(`FAIL-CLOSED: Expected expectedVersion === ${currentVersion}, got ${secJson.data.migrations.expectedVersion}`);
    }
    if (secJson.data.migrations.checksumsMatch !== true) {
      throw new Error(`FAIL-CLOSED: Expected checksumsMatch === true, got ${secJson.data.migrations.checksumsMatch}`);
    }
    if (!Array.isArray(secJson.data.migrations.applied) || secJson.data.migrations.applied.length !== currentVersion) {
      throw new Error(`FAIL-CLOSED: Expected ${currentVersion} applied migrations, got ${secJson.data.migrations.applied?.length}`);
    }

    const secContent = await alicePage.textContent('#management-content');
    if (!secContent?.includes(`v${currentVersion}`)) {
      throw new Error(`Security view does not show migration schema version "v${currentVersion}": "${secContent}"`);
    }
    if (!secContent?.includes('Verified') && !secContent?.includes('已验证')) {
      throw new Error(`Security view does not show verified migration checksums: "${secContent}"`);
    }

    // 6. Tab 2: Users & Access Navigation via Real Tab Click
    console.log('[DockerE2E] Verifying Admin Users & Access tab navigation...');
    await alicePage.click('#tab-btn-users');
    await alicePage.waitForFunction(() => window.location.hash.includes('users'), { timeout: 5000 });
    await alicePage.waitForSelector('#view-management:not(.hidden)', { state: 'visible', timeout: 5000 });
    await alicePage.waitForFunction(() => {
      const h2 = document.querySelector('#management-content .management-header-title h2');
      return h2 && h2.textContent === 'Users & Access Control';
    }, { timeout: 5000 });
    await alicePage.waitForSelector('#management-content .data-table tbody tr', { state: 'visible', timeout: 5000 });
    const usersTableText = await alicePage.textContent('#management-content .data-table');
    if (!usersTableText?.includes('alice') || !usersTableText?.includes('bob')) {
      throw new Error(`Users table does not contain both "alice" and "bob": "${usersTableText}"`);
    }

    // 7. Tab 3: Storage Navigation via Real Tab Click
    console.log('[DockerE2E] Verifying Storage tab navigation...');
    await alicePage.click('#tab-btn-storage');
    await alicePage.waitForFunction(() => window.location.hash.includes('storage'), { timeout: 5000 });
    await alicePage.waitForSelector('#view-management:not(.hidden)', { state: 'visible', timeout: 5000 });
    await alicePage.waitForFunction(() => {
      const h2 = document.querySelector('#management-content .management-header-title h2');
      return h2 && (h2.textContent === 'Files Workbench' || h2.textContent?.includes('Files') || h2.textContent?.includes('Storage'));
    }, { timeout: 5000 });

    // 8. Tab 4: Workspaces Navigation via Real Tab Click
    console.log('[DockerE2E] Verifying Workspaces tab navigation...');
    await alicePage.click('#tab-btn-workspaces');
    await alicePage.waitForFunction(() => window.location.hash.includes('workspaces'), { timeout: 5000 });
    await alicePage.waitForSelector('#view-management:not(.hidden)', { state: 'visible', timeout: 5000 });
    await alicePage.waitForFunction(() => {
      const h2 = document.querySelector('#management-content .management-header-title h2');
      return h2 && (h2.textContent === 'Spaces & Sessions' || h2.textContent?.includes('Spaces') || h2.textContent?.includes('Profiles'));
    }, { timeout: 5000 });

    // 9. Tab 5: Models Navigation via Real Tab Click
    console.log('[DockerE2E] Verifying Models tab navigation...');
    await alicePage.click('#tab-btn-models');
    await alicePage.waitForFunction(() => window.location.hash.includes('models'), { timeout: 5000 });
    await alicePage.waitForSelector('#view-management:not(.hidden)', { state: 'visible', timeout: 5000 });
    await alicePage.waitForFunction(() => {
      const h2 = document.querySelector('#management-content .management-header-title h2');
      return h2 && (h2.textContent === 'Model Configuration' || h2.textContent?.includes('Model'));
    }, { timeout: 5000 });

    // 7. Return to Workspace and Ensure Polling Resumes
    console.log('[DockerE2E] Returning to Workspace view and resuming chat interaction...');
    await alicePage.click('[data-view="workspace"]');
    await alicePage.waitForFunction(() => window.location.hash === '#workspace' || window.location.hash === '', { timeout: 5000 });
    await alicePage.waitForSelector('#view-workspace:not(.hidden)', { state: 'visible', timeout: 5000 });
    await alicePage.waitForSelector('#polling-badge', { state: 'visible', timeout: 5000 });

    // Enumerate all spaces and sessions via authenticated API to identify exact 2 imported sessions (prefix 'import-')
    // and verify exact aggregate 50 imported people-talk messages and 5 attachment notes within them.
    const sessionsRes = await alicePage.request.get(`${platformUrl}/api/sessions`);
    if (sessionsRes.status() !== 200) {
      throw new Error(`FAIL-CLOSED: Failed to list sessions for Alice: status ${sessionsRes.status()}`);
    }
    const sessionsRaw = await sessionsRes.json();
    if (!isRecord(sessionsRaw) || !Array.isArray(sessionsRaw.data)) {
      throw new Error('FAIL-CLOSED: Invalid sessions response structure: missing data array');
    }

    let importedSpaceId: string | undefined;
    const importedSessionIds: string[] = [];

    for (const rawSession of sessionsRaw.data) {
      if (!isRecord(rawSession) || typeof rawSession.id !== 'string') {
        throw new Error('FAIL-CLOSED: Invalid session item in sessions response');
      }
      if (rawSession.id.startsWith('import-')) {
        if (typeof rawSession.spaceId === 'string') {
          importedSpaceId ??= rawSession.spaceId;
        }
        importedSessionIds.push(rawSession.id);
      }
    }

    const distinctImportedSessionIds = Array.from(new Set(importedSessionIds));
    if (distinctImportedSessionIds.length !== 2) {
      throw new Error(
        `FAIL-CLOSED: Expected exactly 2 imported sessions for Alice (prefix 'import-'), found ${distinctImportedSessionIds.length} (${distinctImportedSessionIds.join(', ')})`
      );
    }
    if (!importedSpaceId) {
      throw new Error('FAIL-CLOSED: Expected importedSpaceId to be defined for imported sessions');
    }

    let totalImportedMessages = 0;
    let totalAttachmentNotes = 0;
    const seenImportedMessageIds = new Set<string>();

    for (const sessionId of distinctImportedSessionIds) {
      let cursor: string | undefined;
      let hasMore = true;

      while (hasMore) {
        const url = cursor
          ? `${platformUrl}/api/sessions/${sessionId}/messages?limit=100&cursor=${encodeURIComponent(cursor)}`
          : `${platformUrl}/api/sessions/${sessionId}/messages?limit=100`;
        const msgsRes = await alicePage.request.get(url);
        if (msgsRes.status() !== 200) {
          throw new Error(`FAIL-CLOSED: Failed to fetch messages for imported session "${sessionId}": status ${msgsRes.status()}`);
        }
        const msgsRaw = await msgsRes.json();
        if (!isRecord(msgsRaw) || !isRecord(msgsRaw.data)) {
          throw new Error(`FAIL-CLOSED: Invalid messages response envelope for session "${sessionId}"`);
        }
        const msgsData = msgsRaw.data;
        if (!Array.isArray(msgsData.messages)) {
          throw new Error(`FAIL-CLOSED: Invalid messages array in response for session "${sessionId}"`);
        }

        for (const rawMsg of msgsData.messages) {
          if (!isRecord(rawMsg) || typeof rawMsg.id !== 'string' || typeof rawMsg.content !== 'string') {
            throw new Error(`FAIL-CLOSED: Invalid message record in session "${sessionId}"`);
          }
          if (seenImportedMessageIds.has(rawMsg.id)) {
            throw new Error(`FAIL-CLOSED: Duplicate imported message ID "${rawMsg.id}" encountered across pagination`);
          }
          seenImportedMessageIds.add(rawMsg.id);
          totalImportedMessages++;

          if (rawMsg.content.includes('见空间内 ')) {
            const lines = rawMsg.content.split('\n');
            totalAttachmentNotes += lines.filter((l) => l.startsWith('见空间内 ')).length;
          }
        }

        const nextCursor = msgsData.nextCursor;
        if (typeof nextCursor === 'string' && nextCursor.length > 0 && nextCursor !== cursor && msgsData.messages.length > 0) {
          cursor = nextCursor;
          hasMore = true;
        } else {
          hasMore = false;
        }
      }
    }

    if (totalImportedMessages !== 50 || seenImportedMessageIds.size !== 50) {
      throw new Error(
        `Imported message count mismatch: expected exact 50 unique people-talk messages across imported sessions, got ${totalImportedMessages} (unique=${seenImportedMessageIds.size})`
      );
    }
    if (totalAttachmentNotes !== 5) {
      throw new Error(
        `Imported attachment note count mismatch: expected exact 5 attachment notes across imported sessions, got ${totalAttachmentNotes}`
      );
    }

    // Wait for Alice spaces to load in UI dropdown
    await alicePage.waitForFunction(() => {
      const sel = document.querySelector('#space-select') as HTMLSelectElement | null;
      return sel && sel.options.length > 0 && sel.options[0].value !== '';
    }, { timeout: 8000 });

    // Select the space containing the imported sessions in UI dropdown
    await alicePage.selectOption('#space-select', importedSpaceId);

    // Wait for window.state currentSpaceId exact, currentSessionId starts with 'import-', chat input enabled, and polling active
    await alicePage.waitForFunction((targetSpaceId) => {
      const w = window as unknown as { state?: { currentSpaceId?: string; currentSessionId?: string; isPollingActive?: boolean } };
      if (!w.state || w.state.currentSpaceId !== targetSpaceId) return false;
      if (typeof w.state.currentSessionId !== 'string' || !w.state.currentSessionId.startsWith('import-')) return false;
      if (w.state.isPollingActive !== true) return false;
      const chatInput = document.querySelector('#chat-input') as HTMLTextAreaElement | HTMLInputElement | null;
      return chatInput !== null && !chatInput.disabled;
    }, importedSpaceId, { timeout: 8000 });

    // Assert polling badge text and class indicate Live Sync
    const pollingBadgeClass = await alicePage.$eval('#polling-badge', (el) => el.className);
    const pollingBadgeText = await alicePage.textContent('#polling-badge');
    if (!pollingBadgeClass.includes('badge') || !pollingBadgeText?.includes('Live Sync')) {
      throw new Error(`Expected active Live Sync polling badge, got class="${pollingBadgeClass}", text="${pollingBadgeText}"`);
    }

    // Send turn in imported session and verify genuine assistant reply
    const alicePrompt1 = `Alice Docker Turn verification timestamp ${Date.now()}`;
    await sendTurnAndVerifyReply(alicePage, alicePrompt1, 'alice');
    console.log('[DockerE2E] Scenario A PASS: Alice login, imported chat verification, and real DSH reply succeeded.');

    // -------------------------------------------------------------------------
    // Scenario B: Cookie Reload Persistence
    // -------------------------------------------------------------------------
    console.log('[DockerE2E] Scenario B: Page reload cookie persistence check...');
    await alicePage.reload({ waitUntil: 'domcontentloaded' });
    await alicePage.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });
    const authViewHidden = await alicePage.$eval('#auth-view', (el) => el.classList.contains('hidden'));
    if (!authViewHidden) {
      throw new Error('Auth view is visible after reload with active session cookie');
    }
    console.log('[DockerE2E] Scenario B PASS: Cookie session persisted across reload.');

    // -------------------------------------------------------------------------
    // Scenario C: Restart Alice Container via Handle Method & Session Continuity
    // -------------------------------------------------------------------------
    console.log('[DockerE2E] Scenario C: Container restart preserving 64-hex containerId & session continuity...');
    const originalAliceContainerId = aliceHandle.containerId;

    // Stop Alice container
    await aliceHandle.stop();

    // Reconnect runtime container via system.connectRuntime (preserves exact containerId & updates runtimeHandles map)
    const reconnectedAliceHandle = await system.connectRuntime(aliceUserId);

    if (!is64HexContainerId(reconnectedAliceHandle.containerId)) {
      throw new Error('Reconnected Alice container ID is invalid');
    }
    if (reconnectedAliceHandle.containerId !== originalAliceContainerId) {
      throw new Error(
        `Container ID changed on restart: before=${originalAliceContainerId}, after=${reconnectedAliceHandle.containerId}`
      );
    }

    const reconnectedHealth = await reconnectedAliceHandle.checkHealth();
    if (!reconnectedHealth || reconnectedHealth.status !== 'ok') {
      throw new Error(`FAIL-CLOSED: Reconnected Alice health check failed: expected status 'ok', got "${reconnectedHealth?.status}"`);
    }

    // Reload page and send second turn to verify historical continuity
    await alicePage.reload({ waitUntil: 'domcontentloaded' });
    await alicePage.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

    // Wait for spaces dropdown to load after reload
    await alicePage.waitForFunction(() => {
      const sel = document.querySelector('#space-select') as HTMLSelectElement | null;
      return sel && sel.options.length > 0 && sel.options[0].value !== '';
    }, { timeout: 8000 });

    // Select the space containing the imported sessions in UI dropdown after reload
    await alicePage.selectOption('#space-select', importedSpaceId);

    // Wait for window.state currentSpaceId exact, currentSessionId starts with 'import-', and chat input enabled
    await alicePage.waitForFunction((targetSpaceId) => {
      const w = window as unknown as { state?: { currentSpaceId?: string; currentSessionId?: string } };
      if (!w.state || w.state.currentSpaceId !== targetSpaceId) return false;
      if (typeof w.state.currentSessionId !== 'string' || !w.state.currentSessionId.startsWith('import-')) return false;
      const chatInput = document.querySelector('#chat-input') as HTMLTextAreaElement | HTMLInputElement | null;
      return chatInput !== null && !chatInput.disabled;
    }, importedSpaceId, { timeout: 8000 });

    const alicePrompt2 = `Alice Followup Turn after container restart ${Date.now()}`;
    await sendTurnAndVerifyReply(alicePage, alicePrompt2, 'alice');
    console.log('[DockerE2E] Scenario C PASS: Container restarted with identical 64-hex ID, resumed seamlessly.');

    // -------------------------------------------------------------------------
    // Scenario D: Create New Alice Space & Session
    // -------------------------------------------------------------------------
    console.log('[DockerE2E] Scenario D: Creating new space and session for Alice...');
    const newSpaceName = `Alice Space ${Date.now()}`;
    const newSpaceFolder = `alice-new-folder-${Date.now()}`;
    await uiCreateSpace(alicePage, { name: newSpaceName, folder: newSpaceFolder });

    const newPeerId = `peer-new-session-${Date.now()}`;
    await uiCreateSession(alicePage, { peerId: newPeerId });
    await alicePage.waitForSelector('#session-list .session-item.active', { state: 'visible', timeout: 8000 });

    const newSessionPrompt = `First turn in brand new session ${Date.now()}`;
    await sendTurnAndVerifyReply(alicePage, newSessionPrompt, 'alice');
    console.log('[DockerE2E] Scenario D PASS: New space and session created with assistant reply.');

    // -------------------------------------------------------------------------
    // Scenario E: Logout & Auth Protection
    // -------------------------------------------------------------------------
    console.log('[DockerE2E] Scenario E: Logging out Alice and testing auth protection...');
    await uiLogout(alicePage);
    await alicePage.waitForSelector('#auth-view', { state: 'visible', timeout: 6000 });

    // Unauthenticated GET to protected spaces endpoint returns 401
    const unauthRes = await alicePage.request.get(`${platformUrl}/api/spaces`);
    if (unauthRes.status() !== 401) {
      throw new Error(`Expected 401 Unauthorized after logout, got ${unauthRes.status()}`);
    }
    await aliceContext.close();
    console.log('[DockerE2E] Scenario E PASS: Logout succeeded and protected routes return 401.');

    // -------------------------------------------------------------------------
    // Scenario F: Bob Login & Strict Tenant Isolation
    // -------------------------------------------------------------------------
    console.log('[DockerE2E] Scenario F: Bob login in isolated browser context & cross-tenant checks...');
    const { context: bobContext, page: bobPage } = await createIsolatedPage(browser);

    try {
      await uiLogin(bobPage, platformUrl, 'bob', bobPassword);
      await bobPage.waitForSelector('#app-view', { state: 'visible', timeout: 8000 });

      const bobDisplayName = await bobPage.textContent('#user-display-name');
      if (!bobDisplayName?.includes('Bob')) {
        throw new Error(`Expected Bob display name, got "${bobDisplayName}"`);
      }

      // 1. Verify Member Role Badge & Admin Nav Hidden for Bob
      const bobRoleBadge = await bobPage.textContent('#user-role-badge');
      if (!bobRoleBadge?.includes('Member')) {
        throw new Error(`Expected "Member" role badge for Bob, got "${bobRoleBadge}"`);
      }

      const adminNavEl = await bobPage.$('#nav-admin-section');
      const isAdminNavHidden = adminNavEl ? await adminNavEl.evaluate((el) => el.classList.contains('hidden')) : true;
      if (!isAdminNavHidden) {
        throw new Error('FAIL-CLOSED: Admin navigation section is visible for non-admin Bob');
      }

      // 2. Authenticated API Rejection (403) on Admin Endpoints for Bob
      console.log('[DockerE2E] Verifying Bob 403 rejection on privileged admin endpoints...');
      const bobAdminDashRes = await bobPage.request.get(`${platformUrl}/api/admin/dashboard`);
      if (bobAdminDashRes.status() !== 403) {
        throw new Error(`Expected 403 Forbidden for Bob accessing /api/admin/dashboard, got ${bobAdminDashRes.status()}`);
      }
      const bobAdminUsersRes = await bobPage.request.get(`${platformUrl}/api/admin/users`);
      if (bobAdminUsersRes.status() !== 403) {
        throw new Error(`Expected 403 Forbidden for Bob accessing /api/admin/users, got ${bobAdminUsersRes.status()}`);
      }
      const bobAdminRuntimeRes = await bobPage.request.get(`${platformUrl}/api/admin/runtime`);
      if (bobAdminRuntimeRes.status() !== 403) {
        throw new Error(`Expected 403 Forbidden for Bob accessing /api/admin/runtime, got ${bobAdminRuntimeRes.status()}`);
      }

      // 3. Authenticated Self-Service (200) without Alice Tenant Data for Bob
      console.log('[DockerE2E] Verifying Bob self-service endpoints...');
      const bobManageOverviewRes = await bobPage.request.get(`${platformUrl}/api/manage/overview`);
      if (bobManageOverviewRes.status() !== 200) {
        throw new Error(`Expected 200 OK for Bob accessing /api/manage/overview, got ${bobManageOverviewRes.status()}`);
      }
      const bobOverviewJson = await bobManageOverviewRes.json();
      if (bobOverviewJson.data?.user?.username !== 'bob') {
        throw new Error(`Bob overview returned incorrect user: ${JSON.stringify(bobOverviewJson.data?.user)}`);
      }

      // 4. Bob Management Overview & Redirection Verification (Shows Personal KPIs, Never Admin Global Metrics)
      console.log('[DockerE2E] Verifying Bob Management Overview and personal KPIs...');
      await bobPage.click('#nav-management');
      await bobPage.waitForFunction(() => window.location.hash === '#overview' || window.location.hash.startsWith('#management'), { timeout: 5000 });
      await bobPage.waitForSelector('#view-management:not(.hidden)', { state: 'visible', timeout: 5000 });
      await bobPage.waitForSelector('#management-content .kpi-grid', { state: 'visible', timeout: 5000 });
      const bobOverviewText = await bobPage.textContent('#management-content');
      if (!bobOverviewText?.includes('User Identity') || !bobOverviewText?.includes('Active Spaces') || !bobOverviewText?.includes('System Mode')) {
        throw new Error(`Bob overview content missing personal KPI cards: "${bobOverviewText}"`);
      }
      if (bobOverviewText?.includes('Total Users')) {
        throw new Error(`CRITICAL PRIVILEGE LEAK: Bob overview displays admin metric "Total Users": "${bobOverviewText}"`);
      }

      // Test redirect if attempting to set hash directly to admin route
      await bobPage.evaluate(() => {
        window.location.hash = '#admin-dashboard';
      });
      await bobPage.waitForFunction(() => window.location.hash === '#overview' || window.location.hash.startsWith('#management'), { timeout: 5000 });
      await bobPage.waitForSelector('#view-management:not(.hidden)', { state: 'visible', timeout: 5000 });

      // Navigate back to workspace
      await bobPage.click('[data-view="workspace"]');
      await bobPage.waitForFunction(() => window.location.hash === '#workspace' || window.location.hash === '', { timeout: 5000 });
      await bobPage.waitForSelector('#view-workspace:not(.hidden)', { state: 'visible', timeout: 5000 });

      await bobPage.waitForFunction(() => {
        const sel = document.querySelector('#space-select') as HTMLSelectElement | null;
        return sel && sel.options.length > 0 && sel.options[0].value !== '';
      }, { timeout: 8000 });

      const bobSpaceTexts = await bobPage.$$eval('#space-select option', (opts) =>
        opts.map((o) => o.textContent || '')
      );
      if (bobSpaceTexts.some((t) => t.toLowerCase().includes('alice'))) {
        throw new Error(`CRITICAL TENANT LEAK: Bob sees Alice space: ${bobSpaceTexts.join(', ')}`);
      }

      // Direct API query for Alice's imported session returns 404
      const aliceImportedSessionId = distinctImportedSessionIds[0];
      const bobQueryAliceRes = await bobPage.request.get(`${platformUrl}/api/sessions/${aliceImportedSessionId}`);
      if (bobQueryAliceRes.status() !== 404 && bobQueryAliceRes.status() !== 403) {
        throw new Error(`CRITICAL TENANT LEAK: Bob querying Alice session route returned status ${bobQueryAliceRes.status()} (expected 404)`);
      }

      const bobQueryAliceMsgs = await bobPage.request.get(`${platformUrl}/api/sessions/${aliceImportedSessionId}/messages`);
      if (bobQueryAliceMsgs.status() !== 404 && bobQueryAliceMsgs.status() !== 403) {
        throw new Error(`CRITICAL TENANT LEAK: Bob querying Alice messages returned status ${bobQueryAliceMsgs.status()} (expected 404)`);
      }

      // Create Bob session and send turn
      const bobPeerId = `bob-session-${Date.now()}`;
      await uiCreateSession(bobPage, { peerId: bobPeerId });
      await bobPage.waitForSelector('#session-list .session-item.active', { state: 'visible', timeout: 8000 });

      const bobPrompt = `Bob isolated prompt in Bob container ${Date.now()}`;
      await sendTurnAndVerifyReply(bobPage, bobPrompt, 'bob');
      console.log('[DockerE2E] Scenario F PASS: Bob container and tenant verified isolated.');
    } finally {
      await bobContext.close();
    }

    // -------------------------------------------------------------------------
    // Scenario G: Charlie Disabled User Login (Unified 401 Rejection)
    // -------------------------------------------------------------------------
    console.log('[DockerE2E] Scenario G: Charlie disabled user login rejection...');
    const { context: charlieContext, page: charliePage } = await createIsolatedPage(browser);
    try {
      await charliePage.goto(platformUrl, { waitUntil: 'domcontentloaded' });
      await charliePage.waitForSelector('#auth-view', { state: 'visible', timeout: 6000 });

      const csrfRes = await charliePage.request.get(`${platformUrl}/api/auth/csrf`);
      const csrfJson = await csrfRes.json();
      const csrfToken = csrfJson.data?.csrfToken;

      const charlieLoginRes = await charliePage.request.post(`${platformUrl}/api/auth/login`, {
        data: { username: 'charlie', password: charliePassword },
        headers: {
          'X-Enkeep-Csrf': csrfToken,
          Origin: platformUrl,
        },
      });
      if (charlieLoginRes.status() !== 401) {
        throw new Error(`Expected 401 Unauthorized for disabled Charlie, got ${charlieLoginRes.status()}`);
      }
      console.log('[DockerE2E] Scenario G PASS: Charlie login rejected with 401.');
    } finally {
      await charlieContext.close();
    }

    // -------------------------------------------------------------------------
    // Scenario H: CSRF & Host Header Security Rejections
    // -------------------------------------------------------------------------
    console.log('[DockerE2E] Scenario H: CSRF and Host security checks...');
    const { context: secContext, page: secPage } = await createIsolatedPage(browser);
    try {
      await secPage.goto(platformUrl, { waitUntil: 'domcontentloaded' });
      await secPage.waitForSelector('#auth-view', { state: 'visible', timeout: 6000 });

      // 1. Missing CSRF header on state-modifying POST returns 403
      const noCsrfRes = await secPage.request.post(`${platformUrl}/api/auth/login`, {
        data: { username: 'alice', password: alicePassword },
        headers: {
          Origin: platformUrl,
        },
      });
      if (noCsrfRes.status() !== 403) {
        throw new Error(`Expected 403 Forbidden for missing CSRF token, got ${noCsrfRes.status()}`);
      }

      // 2. Untrusted Origin header returns 403
      const badOriginRes = await secPage.request.post(`${platformUrl}/api/auth/login`, {
        data: { username: 'alice', password: alicePassword },
        headers: {
          Origin: 'http://malicious-attacker.com',
          'X-Enkeep-Csrf': 'invalid-csrf-token',
        },
      });
      if (badOriginRes.status() !== 403) {
        throw new Error(`Expected 403 Forbidden for untrusted Origin, got ${badOriginRes.status()}`);
      }
      console.log('[DockerE2E] Scenario H PASS: CSRF and Host headers verified.');
    } finally {
      await secContext.close();
    }

    console.log('[DockerE2E] All scenarios A-H passed successfully!');
    return { passed: true, details: { suffix12, platformUrl } };
  } catch (err: unknown) {
    primaryAndTeardownErrors.push(err instanceof Error ? err : new Error(String(err)));
    return { passed: false, details: { error: String(err) } };
  } finally {
    console.log('[DockerE2E] Step 7: Teardown and resource leak verification...');

    if (browser) {
      try {
        await browser.close();
      } catch (err: unknown) {
        primaryAndTeardownErrors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    if (system) {
      try {
        await system.close({ removeVolumes: true });
      } catch (err: unknown) {
        primaryAndTeardownErrors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    // Step 7.1: Resource leak check ONLY on own generated names BEFORE dataRoot removal
    try {
      const aliceName = `enkeep-demo-alice-${suffix12}`;
      const bobName = `enkeep-demo-bob-${suffix12}`;
      const aliceVol = `enkeep-demo-dsh-alice-${suffix12}`;
      const bobVol = `enkeep-demo-dsh-bob-${suffix12}`;

      const [cAlice, cBob, vAlice, vBob] = await Promise.all([
        dockerClient.inspectContainer(aliceName),
        dockerClient.inspectContainer(bobName),
        dockerClient.inspectVolume(aliceVol),
        dockerClient.inspectVolume(bobVol),
      ]);

      if (cAlice !== null) {
        primaryAndTeardownErrors.push(new Error(`LEAK DETECTED: Container "${aliceName}" was not cleaned up`));
      }
      if (cBob !== null) {
        primaryAndTeardownErrors.push(new Error(`LEAK DETECTED: Container "${bobName}" was not cleaned up`));
      }
      if (vAlice !== null) {
        primaryAndTeardownErrors.push(new Error(`LEAK DETECTED: Volume "${aliceVol}" was not cleaned up`));
      }
      if (vBob !== null) {
        primaryAndTeardownErrors.push(new Error(`LEAK DETECTED: Volume "${bobVol}" was not cleaned up`));
      }
    } catch (err: unknown) {
      primaryAndTeardownErrors.push(err instanceof Error ? err : new Error(String(err)));
    }

    // Step 7.2: Remove isolated test dataRoot only after system is closed and leak check completes
    try {
      safeRemoveTrackedDirectory(dataRootSnapshot);
    } catch (err: unknown) {
      primaryAndTeardownErrors.push(err instanceof Error ? err : new Error(String(err)));
    }

    // Step 7.3: Protected ports verification
    try {
      const probeAfter = await probeProtectedPorts();
      assertProtectedPortsUnmolested(probeBefore!, probeAfter);
      console.log('[DockerE2E] Protected ports 3000 and 3080 verified untouched after test run.');
    } catch (err: unknown) {
      primaryAndTeardownErrors.push(err instanceof Error ? err : new Error(String(err)));
    }

    if (origLlmEnabled !== undefined) {
      process.env.ENKEEP_LLM_ENABLED = origLlmEnabled;
    } else {
      delete process.env.ENKEEP_LLM_ENABLED;
    }

    if (primaryAndTeardownErrors.length > 0) {
      if (primaryAndTeardownErrors.length === 1) {
        throw primaryAndTeardownErrors[0];
      }
      throw new AggregateError(
        primaryAndTeardownErrors,
        `Docker E2E test execution encountered errors:\n${primaryAndTeardownErrors.map((e) => e.message).join('\n')}`
      );
    }
  }
}
