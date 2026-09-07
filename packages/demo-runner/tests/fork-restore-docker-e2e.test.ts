/**
 * Real Docker Acceptance Test for Online Fork & Restore Lifecycle
 *
 * Runs under `pnpm --filter @enkeep/demo-runner run test:docker` or root `test:docker`.
 * Never runs under normal unit `pnpm test`.
 *
 * Verifies:
 * 1) Alice SpaceA session 2-turn deterministic AgentLoop; Full fork API -> new session;
 *    ForkService runtime importSeed persisted receipt, DB fork_operations finalized,
 *    new container volume JSONL exists inspected via runtime / docker exec / inspect API.
 * 2) Source and fork independent contexts; source does not contain fork messages;
 *    Container remove / reconnect / restart continuity.
 * 3) Prefix fork from first assistant public message; runtime export boundary mapping succeeds,
 *    forked history contains only prefix turns.
 * 4) SpaceB cross-space fork with attachments; snapshot bytes copied to spaceB,
 *    new attachment download URL; agent reads attachment in spaceB; Bob blocked.
 * 5) Session archive then restore: valid artifact -> active; missing artifact -> RECOVERY_REQUIRED;
 *    archive with active turn -> 409.
 * 6) Idempotent fork: same key -> same result; diff options -> 409.
 *    Crash recovery: seeded fork operation reconciled on server restart -> exactly one route, no duplicates.
 * 7) No raw error leaks across all failure responses.
 *
 * @module @enkeep/demo-runner/tests/fork-restore-docker-e2e.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { launchDemoSystem, type RunningDemoSystem } from '../src/up/index.js';
import { resetDemo } from '../src/reset/index.js';
import { downDemo } from '../src/down/index.js';
import { DockerRuntimeContainerAdapter } from '../src/ports/index.js';
import { probeProtectedPorts, assertProbesUnchanged } from '../src/utils/probes.js';
import { getDemoPathConfig } from '../src/config.js';
import { SafeDockerClient } from '@enkeep/runtime-runner/docker';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';

type ProtectedPortsSnapshot = Awaited<ReturnType<typeof probeProtectedPorts>>;

function generateSuffix12(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12).toLowerCase();
}

function computeEtag(data: string | Buffer): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return `"${createHash('sha256').update(buf).digest('hex')}"`;
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

function assertNoRawErrorLeak(responseBody: string | Record<string, unknown>): void {
  const text = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody);
  const sensitivePatterns = [
    /\/app\/runtime-runner/i,
    /\/Users\//i,
    /\/var\/folders\//i,
    /\/tmp\//i,
    /node_modules/i,
    /at\s+[\w$.]+\s+\(/i, // Stack trace lines
    /DatabaseSync/i,
    /sqlite3/i,
  ];
  for (const pattern of sensitivePatterns) {
    expect(text).not.toMatch(pattern);
  }
}

describe('Online Session Fork & Restore in Real Docker Containers', () => {
  let origLlmEnabled: string | undefined;
  let tempRepo: TempRepo | null = null;
  let activeResourceSuffix: string | null = null;
  let runGeneratedMetadata = false;
  let probeBefore: ProtectedPortsSnapshot | null = null;
  let runningSystem: RunningDemoSystem | null = null;

  beforeEach(async () => {
    // Scoped deterministic adapter mode for reproducible Docker E2E acceptance
    origLlmEnabled = process.env.ENKEEP_LLM_ENABLED;
    process.env.ENKEEP_LLM_ENABLED = '0';

    // 1. Mandatory runtime image check
    const rawRuntimeImage = process.env.ENKEEP_RUNTIME_IMAGE?.trim() || 'enkeep-demo-runtime:acceptance';
    const acceptanceImagePattern = /^(enkeep-demo-runtime:(acceptance|latest)|enkeep-dsh-0\.1\.2-rc\.1-canary(:latest)?)$/;
    if (!acceptanceImagePattern.test(rawRuntimeImage)) {
      throw new Error(
        `FAIL-CLOSED: Invalid runtime image "${rawRuntimeImage}". Acceptance tests require "enkeep-demo-runtime:acceptance", "enkeep-demo-runtime:latest", or "enkeep-dsh-0.1.2-rc.1-canary".`
      );
    }

    // 2. Mandatory Docker availability check
    const dockerClient = new SafeDockerClient();
    const isDockerAvailable = await dockerClient.isDockerAvailable();
    if (!isDockerAvailable) {
      throw new Error('FAIL-CLOSED: Docker daemon is unavailable. Real Docker acceptance tests require an active daemon.');
    }

    // 3. Port probe snapshot before test
    probeBefore = await probeProtectedPorts();
  });

  afterEach(async () => {
    if (origLlmEnabled !== undefined) {
      process.env.ENKEEP_LLM_ENABLED = origLlmEnabled;
    } else {
      delete process.env.ENKEEP_LLM_ENABLED;
    }

    const teardownErrors: Error[] = [];

    // Step 1: Close running system if still open
    if (runningSystem) {
      try {
        await runningSystem.close({ removeVolumes: true });
      } catch (err: unknown) {
        teardownErrors.push(err instanceof Error ? err : new Error(String(err)));
      }
      runningSystem = null;
    }

    // Step 2: Call downDemo to ensure all containers & volumes are removed
    if (tempRepo && activeResourceSuffix) {
      const paths = getDemoPathConfig({ repoRoot: tempRepo.repoRoot, resourceSuffix: activeResourceSuffix });
      const metadataExists = existsSync(paths.demoDataDir);

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

    // Step 3: Assert no leaked containers or volumes remain
    if (activeResourceSuffix) {
      try {
        const dockerClient = new SafeDockerClient();
        const isDockerAvailable = await dockerClient.isDockerAvailable();
        if (isDockerAvailable) {
          const aliceContainer = `enkeep-demo-alice-${activeResourceSuffix}`;
          const bobContainer = `enkeep-demo-bob-${activeResourceSuffix}`;
          const aliceVol = `enkeep-demo-dsh-alice-${activeResourceSuffix}`;
          const bobVol = `enkeep-demo-dsh-bob-${activeResourceSuffix}`;

          const [cA, cB, vA, vB] = await Promise.all([
            dockerClient.inspectContainer(aliceContainer),
            dockerClient.inspectContainer(bobContainer),
            dockerClient.inspectVolume(aliceVol),
            dockerClient.inspectVolume(bobVol),
          ]);

          if (cA !== null) teardownErrors.push(new Error(`LEAK: Container "${aliceContainer}" still exists`));
          if (cB !== null) teardownErrors.push(new Error(`LEAK: Container "${bobContainer}" still exists`));
          if (vA !== null) teardownErrors.push(new Error(`LEAK: Volume "${aliceVol}" still exists`));
          if (vB !== null) teardownErrors.push(new Error(`LEAK: Volume "${bobVol}" still exists`));
        }
      } catch (err: unknown) {
        teardownErrors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    // Step 4: Verify protected ports untouched
    if (probeBefore) {
      try {
        const probeAfter = await probeProtectedPorts();
        const probeComparison = assertProbesUnchanged(probeBefore, probeAfter);
        if (!probeComparison.unchanged) {
          teardownErrors.push(
            new Error(`Safety Violation: Protected services disrupted:\n${probeComparison.discrepancies.join('\n')}`)
          );
        }
      } catch (err: unknown) {
        teardownErrors.push(err instanceof Error ? err : new Error(String(err)));
      } finally {
        probeBefore = null;
      }
    }

    // Step 5: Clean up temp root repo
    if (tempRepo) {
      if (teardownErrors.length === 0) {
        try {
          tempRepo.cleanup();
        } catch (err: unknown) {
          teardownErrors.push(err instanceof Error ? err : new Error(String(err)));
        }
      }
      tempRepo = null;
    }

    if (teardownErrors.length > 0) {
      throw new AggregateError(teardownErrors, `Teardown errors occurred: ${teardownErrors.map((e) => e.message).join('; ')}`);
    }
  });

  it('Scenario 1 & 2: Full Fork API, importSeed receipt, DB finalized, Docker volume inspect, and independent context restart continuity', async () => {
    const runtimeImage = process.env.ENKEEP_RUNTIME_IMAGE?.trim() || 'enkeep-demo-runtime:acceptance';
    const dockerClient = new SafeDockerClient();

    const resourceSuffix = generateSuffix12();
    activeResourceSuffix = resourceSuffix;
    tempRepo = createTempRepo();
    runGeneratedMetadata = true;

    const resetRes = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
      deterministicCreatedAt: '2026-03-30T12:00:00.000Z',
    });
    expect(resetRes.ok).toBe(true);
    const credentials = resetRes.credentials;

    const paths = getDemoPathConfig({ repoRoot: tempRepo.repoRoot, resourceSuffix });
    const adapter = new DockerRuntimeContainerAdapter(dockerClient);

    runningSystem = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
      runtimeImage,
      runtimeAdapter: adapter,
    });
    expect(runningSystem.result.ok).toBe(true);

    const serverUrl = runningSystem.platformUrl;

    const { cookie: aliceCookie, csrfToken: aliceCsrf } = await loginUser(serverUrl, credentials.admin);

    // Retrieve Alice's spaceA
    const spacesRes = await fetch(`${serverUrl}/api/spaces`, {
      headers: { Cookie: aliceCookie },
    });
    expect(spacesRes.status).toBe(200);
    const spacesData = ((await spacesRes.json()) as any).data;
    const spaceA = spacesData.find((s: any) => s.id.startsWith('spc_')) || spacesData[0];
    const spaceAId = spaceA.id;

    // Create session in SpaceA
    const sessionRes = await fetch(`${serverUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ spaceId: spaceAId, title: 'Alice Source Session' }),
    });
    expect(sessionRes.status).toBe(201);
    const sourceSessionId = ((await sessionRes.json()) as any).data.id;

    // Turn 1: Write file1.txt
    const turn1Secret = `SECRET_T1_${randomUUID().slice(0, 8)}`;
    const turn1Prompt = `[enkeep-test-tool-call=write:{"file_path":"file1.txt","content":"${turn1Secret}"}] Turn 1 message with ${turn1Secret}`;
    const t1Res = await fetch(`${serverUrl}/api/sessions/${sourceSessionId}/messages`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: turn1Prompt }),
    });
    expect([200, 202]).toContain(t1Res.status);
    const assistant1 = await waitForDeliveredAssistant(serverUrl, sourceSessionId, aliceCookie);
    expect(assistant1).toBeDefined();
    expect(assistant1.content).toBeDefined();

    // Turn 2: Write file2.txt
    const turn2Secret = `SECRET_T2_${randomUUID().slice(0, 8)}`;
    const turn2Prompt = `[enkeep-test-tool-call=write:{"file_path":"file2.txt","content":"${turn2Secret}"}] Turn 2 message with ${turn2Secret}`;
    const t2Res = await fetch(`${serverUrl}/api/sessions/${sourceSessionId}/messages`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: turn2Prompt }),
    });
    expect([200, 202]).toContain(t2Res.status);
    const assistant2 = await waitForDeliveredAssistant(serverUrl, sourceSessionId, aliceCookie);
    expect(assistant2).toBeDefined();

    // 1) Full Fork API -> new session
    const forkRes = await fetch(`${serverUrl}/api/sessions/${sourceSessionId}/fork`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'Alice Forked Full Session' }),
    });
    expect(forkRes.status).toBe(201);
    const forkedSession = ((await forkRes.json()) as any).data;
    expect(forkedSession.id).toBeDefined();
    expect(forkedSession.id).not.toBe(sourceSessionId);

    const db = new DatabaseSync(paths.dbPath);

    // Verify DB fork_operations finalized
    const forkOp = db.prepare('SELECT * FROM fork_operations WHERE forked_route_id = ?').get(forkedSession.id) as any;
    expect(forkOp).toBeDefined();
    expect(forkOp.status).toBe('finalized');
    expect(forkOp.receipt_json).toBeDefined();
    const receipt = JSON.parse(forkOp.receipt_json);
    expect(receipt.algorithm).toBe('sha256-session-events-v1');
    expect(receipt.eventCount).toBeGreaterThan(0);
    expect(receipt.canonicalBytes).toBeGreaterThan(0);

    // Verify new container volume JSONL exists by runtime inspect API (not host direct path)
    const sourceRouteRow = db.prepare('SELECT dsh_session_id FROM session_routes WHERE id = ?').get(sourceSessionId) as any;
    const forkedRouteRow = db.prepare('SELECT dsh_session_id FROM session_routes WHERE id = ?').get(forkedSession.id) as any;

    const inspectRes = await runningSystem.platformServer.runtimeArtifactPort?.checkSessionArtifact({
      userId: forkOp.user_id,
      dshSessionId: forkedRouteRow.dsh_session_id,
      workspaceFolder: spaceA.folder,
    });
    expect(inspectRes?.exists).toBe(true);
    expect(inspectRes?.valid).toBe(true);
    expect(inspectRes?.eventCount).toBeGreaterThan(0);

    // 2) Source and fork send different messages, independent contexts
    const srcUnique = `SRC_DATA_${randomUUID().slice(0, 8)}`;
    const forkUnique = `FORK_DATA_${randomUUID().slice(0, 8)}`;

    const srcTurn3Prompt = `[enkeep-test-tool-call=write:{"file_path":"src_unique.txt","content":"${srcUnique}"}] Source turn 3`;
    await fetch(`${serverUrl}/api/sessions/${sourceSessionId}/messages`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: srcTurn3Prompt }),
    });
    await waitForDeliveredAssistant(serverUrl, sourceSessionId, aliceCookie);

    const forkTurn3Prompt = `[enkeep-test-tool-call=write:{"file_path":"fork_unique.txt","content":"${forkUnique}"}] Fork turn 3`;
    await fetch(`${serverUrl}/api/sessions/${forkedSession.id}/messages`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: forkTurn3Prompt }),
    });
    await waitForDeliveredAssistant(serverUrl, forkedSession.id, aliceCookie);

    // Verify message isolation
    const srcMsgsRes = await fetch(`${serverUrl}/api/sessions/${sourceSessionId}/messages`, {
      headers: { Cookie: aliceCookie },
    });
    const srcMsgs = ((await srcMsgsRes.json()) as any).data.messages;
    const srcText = JSON.stringify(srcMsgs);
    expect(srcText).toContain(srcUnique);
    expect(srcText).not.toContain(forkUnique);

    const forkMsgsRes = await fetch(`${serverUrl}/api/sessions/${forkedSession.id}/messages`, {
      headers: { Cookie: aliceCookie },
    });
    const forkMsgs = ((await forkMsgsRes.json()) as any).data.messages;
    const forkText = JSON.stringify(forkMsgs);
    expect(forkText).toContain(forkUnique);
    expect(forkText).not.toContain(srcUnique);

    // Container remove/reconnect/restart continuity
    await runningSystem.close({ removeVolumes: false });
    runningSystem = null;

    runningSystem = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
      runtimeImage,
      runtimeAdapter: adapter,
    });
    expect(runningSystem.result.ok).toBe(true);
    const newServerUrl = runningSystem.platformUrl;

    const { cookie: reCookie, csrfToken: reCsrf } = await loginUser(newServerUrl, credentials.admin);

    // Both continue after restart
    const srcTurn4Prompt = '[enkeep-test-tool-call=read:{"file_path":"src_unique.txt"}] Verify source after restart';
    await fetch(`${newServerUrl}/api/sessions/${sourceSessionId}/messages`, {
      method: 'POST',
      headers: {
        Cookie: reCookie,
        'X-Enkeep-CSRF': reCsrf,
        Origin: newServerUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: srcTurn4Prompt }),
    });
    const srcAss4 = await waitForDeliveredAssistant(newServerUrl, sourceSessionId, reCookie);
    expect(srcAss4).toBeDefined();

    const forkTurn4Prompt = '[enkeep-test-tool-call=read:{"file_path":"fork_unique.txt"}] Verify fork after restart';
    await fetch(`${newServerUrl}/api/sessions/${forkedSession.id}/messages`, {
      method: 'POST',
      headers: {
        Cookie: reCookie,
        'X-Enkeep-CSRF': reCsrf,
        Origin: newServerUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: forkTurn4Prompt }),
    });
    const forkAss4 = await waitForDeliveredAssistant(newServerUrl, forkedSession.id, reCookie);
    expect(forkAss4).toBeDefined();
  }, 180000);

  it('Scenario 3: Prefix fork from first assistant public message', async () => {
    const runtimeImage = process.env.ENKEEP_RUNTIME_IMAGE?.trim() || 'enkeep-demo-runtime:acceptance';
    const dockerClient = new SafeDockerClient();

    const resourceSuffix = generateSuffix12();
    activeResourceSuffix = resourceSuffix;
    tempRepo = createTempRepo();
    runGeneratedMetadata = true;

    const resetRes = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
      deterministicCreatedAt: '2026-03-30T12:00:00.000Z',
    });
    expect(resetRes.ok).toBe(true);
    const credentials = resetRes.credentials;

    const paths = getDemoPathConfig({ repoRoot: tempRepo.repoRoot, resourceSuffix });
    const adapter = new DockerRuntimeContainerAdapter(dockerClient);

    runningSystem = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
      runtimeImage,
      runtimeAdapter: adapter,
    });
    expect(runningSystem.result.ok).toBe(true);

    const serverUrl = runningSystem.platformUrl;
    const { cookie: aliceCookie, csrfToken: aliceCsrf } = await loginUser(serverUrl, credentials.admin);

    const spacesRes = await fetch(`${serverUrl}/api/spaces`, {
      headers: { Cookie: aliceCookie },
    });
    const spaceA = ((await spacesRes.json()) as any).data[0];

    // Create session
    const sessionRes = await fetch(`${serverUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ spaceId: spaceA.id, title: 'Prefix Source Session' }),
    });
    const sourceSessionId = ((await sessionRes.json()) as any).data.id;

    // Turn 1
    const p1 = 'Step 1 prompt';
    await fetch(`${serverUrl}/api/sessions/${sourceSessionId}/messages`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: p1 }),
    });
    const assistant1 = await waitForDeliveredAssistant(serverUrl, sourceSessionId, aliceCookie);
    expect(assistant1.id).toBeDefined();

    // Turn 2
    const p2 = 'Step 2 prompt';
    await fetch(`${serverUrl}/api/sessions/${sourceSessionId}/messages`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: p2 }),
    });
    await waitForDeliveredAssistant(serverUrl, sourceSessionId, aliceCookie);

    // Prefix fork from first assistant public message
    const forkRes = await fetch(`${serverUrl}/api/sessions/${sourceSessionId}/fork`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fromMessageId: assistant1.id,
        title: 'Prefix Step 1 Fork',
      }),
    });
    expect(forkRes.status).toBe(201);
    const prefixFork = ((await forkRes.json()) as any).data;

    // Verify messages in prefixFork session only contains Turn 1 (user msg 1 & assistant msg 1)
    const msgsRes = await fetch(`${serverUrl}/api/sessions/${prefixFork.id}/messages`, {
      headers: { Cookie: aliceCookie },
    });
    const prefixMsgs = ((await msgsRes.json()) as any).data.messages;
    expect(prefixMsgs.length).toBe(2);
    expect(prefixMsgs[0].content).toBe(p1);
    expect(prefixMsgs[1].role).toBe('assistant');

    // DB verify fork_operations finalized
    const db = new DatabaseSync(paths.dbPath);
    const forkOp = db.prepare('SELECT * FROM fork_operations WHERE forked_route_id = ?').get(prefixFork.id) as any;
    expect(forkOp).toBeDefined();
    expect(forkOp.status).toBe('finalized');
  }, 120000);

  it('Scenario 4: SpaceB cross-space fork with attachments, download URL bytes, agent read, and Bob blocked', async () => {
    const runtimeImage = process.env.ENKEEP_RUNTIME_IMAGE?.trim() || 'enkeep-demo-runtime:acceptance';
    const dockerClient = new SafeDockerClient();

    const resourceSuffix = generateSuffix12();
    activeResourceSuffix = resourceSuffix;
    tempRepo = createTempRepo();
    runGeneratedMetadata = true;

    const resetRes = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
      deterministicCreatedAt: '2026-03-30T12:00:00.000Z',
    });
    expect(resetRes.ok).toBe(true);
    const credentials = resetRes.credentials;

    const paths = getDemoPathConfig({ repoRoot: tempRepo.repoRoot, resourceSuffix });
    const adapter = new DockerRuntimeContainerAdapter(dockerClient);

    runningSystem = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
      runtimeImage,
      runtimeAdapter: adapter,
    });
    expect(runningSystem.result.ok).toBe(true);

    const serverUrl = runningSystem.platformUrl;
    const { cookie: aliceCookie, csrfToken: aliceCsrf } = await loginUser(serverUrl, credentials.admin);
    const { cookie: bobCookie, csrfToken: bobCsrf } = await loginUser(serverUrl, credentials.user);

    // Retrieve SpaceA
    const spacesRes = await fetch(`${serverUrl}/api/spaces`, {
      headers: { Cookie: aliceCookie },
    });
    const spacesData = ((await spacesRes.json()) as any).data;
    const spaceA = spacesData[0];

    // Create SpaceB for Alice
    const createSpaceBRes = await fetch(`${serverUrl}/api/spaces`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Space Beta', folder: 'space-beta' }),
    });
    expect(createSpaceBRes.status).toBe(201);
    const spaceB = ((await createSpaceBRes.json()) as any).data;

    // Upload attachment in SpaceA
    const uniqueAttachmentSecret = `SPEC_SECRET_${randomUUID().slice(0, 12)}_TOKEN`;
    const attachmentContent = `TECHNICAL SPECIFICATION:\n${uniqueAttachmentSecret}\nEND SPEC`;
    const attBuffer = Buffer.from(attachmentContent, 'utf8');
    const attEtag = computeEtag(attBuffer);
    const attSha = attEtag.replace(/"/g, '');

    const uploadRes = await fetch(`${serverUrl}/api/spaces/${spaceA.id}/files/upload?path=specs/spec.txt`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'text/plain; charset=utf-8',
      },
      body: attBuffer,
    });
    expect(uploadRes.status).toBe(201);

    // Create session in SpaceA
    const sessionRes = await fetch(`${serverUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ spaceId: spaceA.id, title: 'SpaceA Attachment Session' }),
    });
    const spaceASessionId = ((await sessionRes.json()) as any).data.id;

    // Message with attachment in SpaceA
    const p1 = `[enkeep-test-tool-call=read:{"file_path":".attachments/${attSha}/spec.txt"}] Please read .attachments/${attSha}/spec.txt and confirm`;
    await fetch(`${serverUrl}/api/sessions/${spaceASessionId}/messages`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: p1,
        attachments: [
          {
            path: 'specs/spec.txt',
            etag: attEtag,
            displayName: 'Technical Spec',
          },
        ],
      }),
    });
    await waitForDeliveredAssistant(serverUrl, spaceASessionId, aliceCookie);

    // Cross-Space Fork to SpaceB
    const forkRes = await fetch(`${serverUrl}/api/sessions/${spaceASessionId}/fork`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        targetSpaceId: spaceB.id,
        title: 'SpaceB Forked Session',
      }),
    });
    expect(forkRes.status).toBe(201);
    const spaceBFork = ((await forkRes.json()) as any).data;
    expect(spaceBFork.spaceId).toBe(spaceB.id);

    // Verify snapshot bytes copied to spaceB: Download endpoint in SpaceB
    const downloadRes = await fetch(
      `${serverUrl}/api/spaces/${spaceB.id}/files/download?path=${encodeURIComponent(`.attachments/${attSha}/spec.txt`)}`,
      {
        headers: { Cookie: aliceCookie },
      }
    );
    expect(downloadRes.status).toBe(200);
    const downloadedText = await downloadRes.text();
    expect(downloadedText).toBe(attachmentContent);

    // Agent read works in SpaceB
    const spaceBReadPrompt = `[enkeep-test-tool-call=read:{"file_path":".attachments/${attSha}/spec.txt"}] Read attachment in SpaceB and verify ${uniqueAttachmentSecret}`;
    await fetch(`${serverUrl}/api/sessions/${spaceBFork.id}/messages`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: spaceBReadPrompt }),
    });
    const spaceBAssistant = await waitForDeliveredAssistant(serverUrl, spaceBFork.id, aliceCookie);
    expect(spaceBAssistant.content).toContain(uniqueAttachmentSecret);

    // Source SpaceA unchanged
    const srcDownloadRes = await fetch(
      `${serverUrl}/api/spaces/${spaceA.id}/files/download?path=${encodeURIComponent(`.attachments/${attSha}/spec.txt`)}`,
      {
        headers: { Cookie: aliceCookie },
      }
    );
    expect(srcDownloadRes.status).toBe(200);

    // Bob blocked from Alice's SpaceB attachment download (403/404)
    const bobDownloadRes = await fetch(
      `${serverUrl}/api/spaces/${spaceB.id}/files/download?path=${encodeURIComponent(`.attachments/${attSha}/spec.txt`)}`,
      {
        headers: { Cookie: bobCookie },
      }
    );
    expect([403, 404]).toContain(bobDownloadRes.status);
    const bobDownloadErr = await bobDownloadRes.json();
    assertNoRawErrorLeak(bobDownloadErr);

    // Bob blocked from forking Alice's session (404)
    const bobForkRes = await fetch(`${serverUrl}/api/sessions/${spaceBFork.id}/fork`, {
      method: 'POST',
      headers: {
        Cookie: bobCookie,
        'X-Enkeep-CSRF': bobCsrf,
        Origin: serverUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'Bob Unauthorized Fork' }),
    });
    expect(bobForkRes.status).toBe(404);
    const bobForkErr = await bobForkRes.json();
    assertNoRawErrorLeak(bobForkErr);
  }, 120000);

  it('Scenario 5: Session archive then restore, artifact validation & active turn 409', async () => {
    const runtimeImage = process.env.ENKEEP_RUNTIME_IMAGE?.trim() || 'enkeep-demo-runtime:acceptance';
    const dockerClient = new SafeDockerClient();

    const resourceSuffix = generateSuffix12();
    activeResourceSuffix = resourceSuffix;
    tempRepo = createTempRepo();
    runGeneratedMetadata = true;

    const resetRes = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
      deterministicCreatedAt: '2026-03-30T12:00:00.000Z',
    });
    expect(resetRes.ok).toBe(true);
    const credentials = resetRes.credentials;

    const paths = getDemoPathConfig({ repoRoot: tempRepo.repoRoot, resourceSuffix });
    const adapter = new DockerRuntimeContainerAdapter(dockerClient);

    runningSystem = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
      runtimeImage,
      runtimeAdapter: adapter,
    });
    expect(runningSystem.result.ok).toBe(true);

    const serverUrl = runningSystem.platformUrl;
    const { cookie: aliceCookie, csrfToken: aliceCsrf } = await loginUser(serverUrl, credentials.admin);

    const spacesRes = await fetch(`${serverUrl}/api/spaces`, {
      headers: { Cookie: aliceCookie },
    });
    const spaceA = ((await spacesRes.json()) as any).data[0];

    // Create session & send turn
    const sessionRes = await fetch(`${serverUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ spaceId: spaceA.id, title: 'Archive/Restore Session' }),
    });
    const sessionId = ((await sessionRes.json()) as any).data.id;

    await fetch(`${serverUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'Hello for archive test' }),
    });
    await waitForDeliveredAssistant(serverUrl, sessionId, aliceCookie);

    // Archive session
    const archRes = await fetch(`${serverUrl}/api/sessions/${sessionId}/archive`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
      },
    });
    expect(archRes.status).toBe(200);
    const archJson = ((await archRes.json()) as any).data;
    expect(archJson.status).toBe('archived');

    // Restore session (runtime checks artifact valid -> active)
    const restoreRes = await fetch(`${serverUrl}/api/sessions/${sessionId}/restore`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
      },
    });
    expect(restoreRes.status).toBe(200);
    const restoreJson = ((await restoreRes.json()) as any).data;
    expect(restoreJson.status).toBe('active');

    const db = new DatabaseSync(paths.dbPath);

    // Missing artifact simulation: create test session route with missing DSH session id
    const missingRouteId = `ses_${randomUUID().replace(/-/g, '')}`;
    const missingDshId = `ses_${randomUUID().replace(/-/g, '')}`;
    const aliceUserRow = db.prepare("SELECT id FROM users WHERE username = 'alice'").get() as any;
    const nowIso = new Date().toISOString();

    db.prepare(`
      INSERT INTO session_routes (
        id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id,
        execution_mode, status, title, reset_count, current_generation, created_at, updated_at
      ) VALUES (?, ?, ?, 'web', 'default', ?, ?, ?, 'container', 'archived', 'Missing Artifact Session', 0, 1, ?, ?)
    `).run(missingRouteId, spaceA.id, aliceUserRow.id, missingRouteId, missingRouteId, missingDshId, nowIso, nowIso);

    const restoreMissingRes = await fetch(`${serverUrl}/api/sessions/${missingRouteId}/restore`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
      },
    });
    expect(restoreMissingRes.status).toBe(400);
    const restoreMissingErr = await restoreMissingRes.json();
    expect(restoreMissingErr.error.code).toBe('RECOVERY_REQUIRED');
    assertNoRawErrorLeak(restoreMissingErr);

    // Archive active turn -> 409
    const activeTurnSessionRes = await fetch(`${serverUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ spaceId: spaceA.id, title: 'Active Turn Session' }),
    });
    const activeTurnSessionId = ((await activeTurnSessionRes.json()) as any).data.id;

    db.prepare(`
      INSERT INTO turn_runs (id, user_id, space_id, route_id, turn_id, status)
      VALUES ('turn_run_arch_active', '${aliceUserRow.id}', '${spaceA.id}', '${activeTurnSessionId}', 'turn_arch_act', 'running')
    `).run();

    const archConflictRes = await fetch(`${serverUrl}/api/sessions/${activeTurnSessionId}/archive`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
      },
    });
    expect(archConflictRes.status).toBe(409);
    const archConflictErr = await archConflictRes.json();
    assertNoRawErrorLeak(archConflictErr);
  }, 120000);

  it('Scenario 6: Idempotent fork, diff options 409, and server crash recovery reconciliation', async () => {
    const runtimeImage = process.env.ENKEEP_RUNTIME_IMAGE?.trim() || 'enkeep-demo-runtime:acceptance';
    const dockerClient = new SafeDockerClient();

    const resourceSuffix = generateSuffix12();
    activeResourceSuffix = resourceSuffix;
    tempRepo = createTempRepo();
    runGeneratedMetadata = true;

    const resetRes = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
      deterministicCreatedAt: '2026-03-30T12:00:00.000Z',
    });
    expect(resetRes.ok).toBe(true);
    const credentials = resetRes.credentials;

    const paths = getDemoPathConfig({ repoRoot: tempRepo.repoRoot, resourceSuffix });
    const adapter = new DockerRuntimeContainerAdapter(dockerClient);

    runningSystem = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
      runtimeImage,
      runtimeAdapter: adapter,
    });
    expect(runningSystem.result.ok).toBe(true);

    const serverUrl = runningSystem.platformUrl;
    const { cookie: aliceCookie, csrfToken: aliceCsrf } = await loginUser(serverUrl, credentials.admin);

    const spacesRes = await fetch(`${serverUrl}/api/spaces`, {
      headers: { Cookie: aliceCookie },
    });
    const spaceA = ((await spacesRes.json()) as any).data[0];

    // Create session & send turn
    const sessionRes = await fetch(`${serverUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ spaceId: spaceA.id, title: 'Idempotency Source Session' }),
    });
    const sourceSessionId = ((await sessionRes.json()) as any).data.id;

    await fetch(`${serverUrl}/api/sessions/${sourceSessionId}/messages`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'Initial message for idempotent fork' }),
    });
    await waitForDeliveredAssistant(serverUrl, sourceSessionId, aliceCookie);

    // 1) Idempotent fork same key same session
    const idempKey = '11111111-2222-4333-8444-555555555555';
    const fork1Res = await fetch(`${serverUrl}/api/sessions/${sourceSessionId}/fork`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': idempKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'Idempotent Fork Target' }),
    });
    expect(fork1Res.status).toBe(201);
    const fork1Json = ((await fork1Res.json()) as any).data;

    const fork2Res = await fetch(`${serverUrl}/api/sessions/${sourceSessionId}/fork`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': idempKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'Idempotent Fork Target' }),
    });
    expect(fork2Res.status).toBe(201);
    const fork2Json = ((await fork2Res.json()) as any).data;
    expect(fork2Json.id).toBe(fork1Json.id);

    // Diff options with same idempotency key -> 409
    const forkDiffRes = await fetch(`${serverUrl}/api/sessions/${sourceSessionId}/fork`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': idempKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'Different Title Conflict' }),
    });
    expect(forkDiffRes.status).toBe(409);
    const forkDiffErr = await forkDiffRes.json();
    expect(forkDiffErr.error.code).toBe('IDEMPOTENCY_CONFLICT');
    assertNoRawErrorLeak(forkDiffErr);

    // 2) Crash recovery: simulate crash where ForkService seeded runtime before DB finalize
    const db = new DatabaseSync(paths.dbPath);
    const aliceUserRow = db.prepare("SELECT id FROM users WHERE username = 'alice'").get() as any;
    const aliceId = aliceUserRow.id;
    const sourceRouteRow = db.prepare('SELECT dsh_session_id FROM session_routes WHERE id = ?').get(sourceSessionId) as any;

    const crashForkRouteId = `ses_${randomUUID().replace(/-/g, '')}`;
    const crashForkDshId = `ses_${randomUUID().replace(/-/g, '')}`;
    const crashIdempKey = '22222222-3333-4444-8555-666666666666';

    // Export seed from source DSH and import into crashForkDshId
    const exportRes = await runningSystem.platformServer.runtimeArtifactPort!.exportForkSeed({
      userId: aliceId,
      sourceDshSessionId: sourceRouteRow.dsh_session_id,
      workspaceFolder: spaceA.folder,
    });

    const importRes = await runningSystem.platformServer.runtimeArtifactPort!.importSeed({
      userId: aliceId,
      targetDshId: crashForkDshId,
      events: exportRes.events,
      receipt: exportRes.receipt,
      workspaceFolder: spaceA.folder,
    });
    expect(importRes.persisted).toBe(true);

    const crashPlan = {
      userId: aliceId,
      sourceSessionId,
      sourceDshSessionId: sourceRouteRow.dsh_session_id,
      sourceSpaceId: spaceA.id,
      targetSpaceId: spaceA.id,
      forkedRouteId: crashForkRouteId,
      forkedDshSessionId: crashForkDshId,
      forkedTitle: 'Crash Recovered Fork',
      agentProfileId: null,
      agentProfileSnapshotId: null,
      includedMessageIds: [],
      receipt: exportRes.receipt,
    };

    const canonicalReq = JSON.stringify({
      action: 'fork_session',
      userId: aliceId,
      sessionId: sourceSessionId,
      fromMessageId: null,
      fromTurnId: null,
      title: 'Crash Recovered Fork',
      targetSpaceId: null,
    });
    const crashReqHash = createHash('sha256').update(canonicalReq).digest('hex');

    db.prepare(`
      INSERT INTO fork_operations (
        id, user_id, source_session_id, target_space_id, forked_route_id, forked_dsh_session_id,
        request_hash, idempotency_key, status, fork_plan_json, receipt_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'seeded', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(
      `forkop_${randomUUID().replace(/-/g, '')}`,
      aliceId,
      sourceSessionId,
      spaceA.id,
      crashForkRouteId,
      crashForkDshId,
      crashReqHash,
      crashIdempKey,
      JSON.stringify(crashPlan),
      JSON.stringify(exportRes.receipt)
    );

    // Close and relaunch platform server (triggering server startup reconciliation)
    await runningSystem.close({ removeVolumes: false });
    runningSystem = null;

    runningSystem = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
      runtimeImage,
      runtimeAdapter: adapter,
    });
    expect(runningSystem.result.ok).toBe(true);

    // Verify exactly one route was created by reconciliation
    const postDb = new DatabaseSync(paths.dbPath);
    const reconciledRoutes = postDb.prepare('SELECT * FROM session_routes WHERE id = ?').all(crashForkRouteId) as any[];
    expect(reconciledRoutes.length).toBe(1);
    expect(reconciledRoutes[0].status).toBe('active');
    expect(reconciledRoutes[0].dsh_session_id).toBe(crashForkDshId);

    const reconciledOp = postDb.prepare('SELECT status FROM fork_operations WHERE forked_route_id = ?').get(crashForkRouteId) as any;
    expect(reconciledOp.status).toBe('finalized');

    // Verify sending same idempotency key returns the reconciled session without duplicate routes
    const newServerUrl = runningSystem.platformUrl;
    const { cookie: reCookie, csrfToken: reCsrf } = await loginUser(newServerUrl, credentials.admin);

    const idempHitRes = await fetch(`${newServerUrl}/api/sessions/${sourceSessionId}/fork`, {
      method: 'POST',
      headers: {
        Cookie: reCookie,
        'X-Enkeep-CSRF': reCsrf,
        Origin: newServerUrl,
        'Idempotency-Key': crashIdempKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'Crash Recovered Fork' }),
    });
    expect(idempHitRes.status).toBe(201);
    const idempHitJson = ((await idempHitRes.json()) as any).data;
    expect(idempHitJson.id).toBe(crashForkRouteId);

    const routesAfterIdemp = postDb.prepare('SELECT * FROM session_routes WHERE id = ?').all(crashForkRouteId) as any[];
    expect(routesAfterIdemp.length).toBe(1);
  }, 180000);
});
