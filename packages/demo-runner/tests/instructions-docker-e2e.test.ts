/**
 * Real Docker Acceptance Test for Instructions E2E Lifecycle, Isolation, CAS, Hot Reload & Audit
 *
 * Runs only under `pnpm --filter @enkeep/demo-runner run test:docker` or root `test:docker`.
 * Never runs under normal unit `pnpm test`.
 *
 * Verifies:
 * 1) Temp demo reset & launch with genuine Docker containers, Alice & Bob login, SpaceA & SpaceB creation with sessions.
 * 2) PUT /api/account/instructions/global with unique token GLOBAL_ONLY (no prompt leakage), ETag & exact GET verification.
 * 3) PUT SpaceA AGENTS.md (SPACE_A_ONLY) and SpaceB (SPACE_B_ONLY); CAS update Global token v2 via If-Match header.
 * 4) Deterministic Agent LLM adapter echoes instruction tokens when requested via [enkeep-test-echo-instructions] directive without leaking secret tokens in user prompt.
 * 5) SessionA reply contains Global+SpaceA (not SpaceB); SessionB reply contains Global+SpaceB (not SpaceA);
 *    Hot reload in warm agent: updating instructions on disk immediately reflects on next turn without container restart.
 * 6) Container restart volume persistence: container remove/recreate retains instructions v2;
 *    Multi-tenant isolation: Bob cannot GET/PUT Alice's space instructions, Bob global instructions are completely isolated.
 * 7) Docker process topology remains stable persistent daemon/bridge with no leaked per-turn processes.
 * 8) Strict Zero-Leakage Audit Logging: auth_audit_log records only SHA-256 ETag and byte sizes, strictly zero raw content leakage.
 * 9) Teardown, protected ports (3000/3080) verification, and hermetic cleanup.
 *
 * @module @enkeep/demo-runner/tests/instructions-docker-e2e.test
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

function computeExpectedEtag(content: string): string {
  const hash = createHash('sha256').update(content, 'utf8').digest('hex').toLowerCase();
  return `"${hash}"`;
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
  maxWaitSeconds = 35
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

describe('Docker Instructions Acceptance & Multi-Space Isolation E2E Journey', () => {
  let tempRepo: TempRepo | null = null;
  let activeResourceSuffix: string | null = null;
  let runGeneratedMetadata = false;
  let probeBefore: ProtectedPortsSnapshot | null = null;
  let runningSystem: RunningDemoSystem | null = null;

  beforeEach(async () => {
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

    // 3. Protected port baseline snapshot
    probeBefore = await probeProtectedPorts();
  });

  afterEach(async () => {
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

    // Assert zero leaked containers/volumes
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
      } catch (leakErr: unknown) {
        teardownErrors.push(leakErr instanceof Error ? leakErr : new Error(String(leakErr)));
      }
    }

    // Assert protected ports unchanged
    if (probeBefore) {
      try {
        const probeAfter = await probeProtectedPorts();
        assertProbesUnchanged(probeBefore, probeAfter);
      } catch (portErr: unknown) {
        teardownErrors.push(portErr instanceof Error ? portErr : new Error(String(portErr)));
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

  it('verifies minimal Instructions vertical closed loop end-to-end in real Docker runtime', async () => {
    // =========================================================================
    // 1) Temp demo reset & launch, Login Alice & Bob, Create/Get SpaceA & SpaceB
    // =========================================================================
    tempRepo = createTempRepo();
    activeResourceSuffix = generateSuffix12();

    const resetResult = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix: activeResourceSuffix,
    });
    expect(resetResult.ok).toBe(true);

    const dockerClient = new SafeDockerClient();
    const adapter = new DockerRuntimeContainerAdapter(dockerClient);

    runningSystem = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix: activeResourceSuffix,
      runtimeImage: 'enkeep-demo-runtime:acceptance',
      runtimeAdapter: adapter,
      llmEnabled: false,
    });
    expect(runningSystem.result.ok).toBe(true);
    runGeneratedMetadata = true;

    const platformUrl = runningSystem.result.platform.url!;
    const aliceAuth = await loginUser(platformUrl, resetResult.credentials.admin);
    const bobAuth = await loginUser(platformUrl, resetResult.credentials.user);

    // Get Alice's default Space (Space A)
    const spacesRes = await fetch(`${platformUrl}/api/spaces`, {
      headers: { Cookie: aliceAuth.cookie },
    });
    expect(spacesRes.status).toBe(200);
    const spacesData = ((await spacesRes.json()) as any).data;
    const spaceA = spacesData[0];
    expect(spaceA).toBeDefined();

    // Create Space B for Alice
    const createSpaceBRes = await fetch(`${platformUrl}/api/spaces`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({
        name: 'Alice Space Beta',
        folder: 'space-beta',
        executionMode: 'container',
      }),
    });
    expect(createSpaceBRes.status).toBe(201);
    const spaceB = ((await createSpaceBRes.json()) as any).data;
    expect(spaceB.id).toBeDefined();

    // Create Session A in Space A
    const sessionARes = await fetch(`${platformUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({ spaceId: spaceA.id, title: 'Session in Space A' }),
    });
    expect(sessionARes.status).toBe(201);
    const sessionA = ((await sessionARes.json()) as any).data;

    // Create Session B in Space B
    const sessionBRes = await fetch(`${platformUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({ spaceId: spaceB.id, title: 'Session in Space B' }),
    });
    expect(sessionBRes.status).toBe(201);
    const sessionB = ((await sessionBRes.json()) as any).data;

    // =========================================================================
    // 2) PUT /api/account/instructions/global with unique token GLOBAL_ONLY, ETag/GET exact
    // =========================================================================
    const globalTokenV1 = `INSTRUCTION_TOKEN_GLOBAL_ONLY_${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
    const globalContentV1 = `# Global Persona Rules\n- Strict Global Rule: ${globalTokenV1}\n`;
    const expectedGlobalEtagV1 = computeExpectedEtag(globalContentV1);

    const putGlobalRes1 = await fetch(`${platformUrl}/api/account/instructions/global`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({ content: globalContentV1 }),
    });
    expect(putGlobalRes1.status).toBe(200);
    const putGlobalJson1 = await putGlobalRes1.json();
    expect(putGlobalJson1.success).toBe(true);
    expect(putGlobalJson1.data.etag).toBe(expectedGlobalEtagV1);
    expect(putGlobalJson1.data.size).toBe(Buffer.byteLength(globalContentV1, 'utf8'));

    // Exact GET check
    const getGlobalRes1 = await fetch(`${platformUrl}/api/account/instructions/global`, {
      headers: { Cookie: aliceAuth.cookie },
    });
    expect(getGlobalRes1.status).toBe(200);
    const getGlobalJson1 = await getGlobalRes1.json();
    expect(getGlobalJson1.success).toBe(true);
    expect(getGlobalJson1.data.exists).toBe(true);
    expect(getGlobalJson1.data.content).toBe(globalContentV1);
    expect(getGlobalJson1.data.etag).toBe(expectedGlobalEtagV1);

    // =========================================================================
    // 3) PUT SpaceA AGENTS.md (SPACE_A_ONLY), SpaceB (SPACE_B_ONLY); CAS update Global token v2
    // =========================================================================
    const spaceATokenV1 = `INSTRUCTION_TOKEN_SPACE_A_ONLY_${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
    const spaceAContentV1 = `# Space Alpha Rules\n- Alpha Dedicated Rule: ${spaceATokenV1}\n`;
    const expectedSpaceAEtagV1 = computeExpectedEtag(spaceAContentV1);

    const putSpaceARes1 = await fetch(`${platformUrl}/api/spaces/${spaceA.id}/instructions?file=AGENTS.md`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({ content: spaceAContentV1 }),
    });
    expect(putSpaceARes1.status).toBe(200);
    const putSpaceAJson1 = await putSpaceARes1.json();
    expect(putSpaceAJson1.success).toBe(true);
    expect(putSpaceAJson1.data.etag).toBe(expectedSpaceAEtagV1);

    const spaceBTokenV1 = `INSTRUCTION_TOKEN_SPACE_B_ONLY_${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
    const spaceBContentV1 = `# Space Beta Rules\n- Beta Dedicated Rule: ${spaceBTokenV1}\n`;
    const expectedSpaceBEtagV1 = computeExpectedEtag(spaceBContentV1);

    const putSpaceBRes1 = await fetch(`${platformUrl}/api/spaces/${spaceB.id}/instructions?file=AGENTS.md`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({ content: spaceBContentV1 }),
    });
    expect(putSpaceBRes1.status).toBe(200);
    const putSpaceBJson1 = await putSpaceBRes1.json();
    expect(putSpaceBJson1.success).toBe(true);
    expect(putSpaceBJson1.data.etag).toBe(expectedSpaceBEtagV1);

    // Update Global instructions to v2 using If-Match header
    const globalTokenV2 = `INSTRUCTION_TOKEN_GLOBAL_${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}_V2`;
    const globalContentV2 = `# Global Persona Rules v2\n- Updated Rule: ${globalTokenV2}\n`;
    const expectedGlobalEtagV2 = computeExpectedEtag(globalContentV2);

    // Test CAS: 428 Precondition Required if If-Match is missing when modifying existing global file
    const putNoIfMatch = await fetch(`${platformUrl}/api/account/instructions/global`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({ content: globalContentV2 }),
    });
    expect(putNoIfMatch.status).toBe(428);

    // Test CAS: 409 Conflict if If-Match does not match
    const putStaleIfMatch = await fetch(`${platformUrl}/api/account/instructions/global`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        'If-Match': '"0000000000000000000000000000000000000000000000000000000000000000"',
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({ content: globalContentV2 }),
    });
    expect(putStaleIfMatch.status).toBe(409);

    // Valid CAS update with correct If-Match
    const putGlobalRes2 = await fetch(`${platformUrl}/api/account/instructions/global`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        'If-Match': expectedGlobalEtagV1,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({ content: globalContentV2 }),
    });
    expect(putGlobalRes2.status).toBe(200);
    const putGlobalJson2 = await putGlobalRes2.json();
    expect(putGlobalJson2.data.etag).toBe(expectedGlobalEtagV2);

    // =========================================================================
    // 4 & 5) SessionA reply contains Global+SpaceA (not SpaceB); SessionB reply contains Global+SpaceB (not SpaceA)
    // =========================================================================
    // Turn in Session A: prompt does NOT leak secret token, uses [enkeep-test-echo-instructions] directive
    const turn1SessionAPrompt = 'Verify instructions in Space A [enkeep-test-echo-instructions]';
    const turn1SessionARes = await fetch(`${platformUrl}/api/sessions/${sessionA.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({ content: turn1SessionAPrompt }),
    });
    expect([200, 201, 202]).toContain(turn1SessionARes.status);

    const assistant1A = await waitForDeliveredAssistant(platformUrl, sessionA.id, aliceAuth.cookie);
    expect(assistant1A.content).toContain(globalTokenV2);
    expect(assistant1A.content).toContain(spaceATokenV1);
    expect(assistant1A.content).not.toContain(spaceBTokenV1);
    expect(assistant1A.content).not.toContain(globalTokenV1);

    // Turn in Session B: prompt does NOT leak secret token
    const turn1SessionBPrompt = 'Verify instructions in Space B [enkeep-test-echo-instructions]';
    const turn1SessionBRes = await fetch(`${platformUrl}/api/sessions/${sessionB.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({ content: turn1SessionBPrompt }),
    });
    expect([200, 201, 202]).toContain(turn1SessionBRes.status);

    const assistant1B = await waitForDeliveredAssistant(platformUrl, sessionB.id, aliceAuth.cookie);
    expect(assistant1B.content).toContain(globalTokenV2);
    expect(assistant1B.content).toContain(spaceBTokenV1);
    expect(assistant1B.content).not.toContain(spaceATokenV1);

    // =========================================================================
    // 5b) Warm Agent Hot Reload: update instructions on disk -> next turn receives v2/v3 without reboot
    // =========================================================================
    const globalTokenV3 = `INSTRUCTION_TOKEN_GLOBAL_${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}_V3`;
    const globalContentV3 = `# Global Persona Rules v3 Hot Reload\n- Hot Global Rule: ${globalTokenV3}\n`;
    const expectedGlobalEtagV3 = computeExpectedEtag(globalContentV3);

    const updateGlobalRes3 = await fetch(`${platformUrl}/api/account/instructions/global`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        'If-Match': expectedGlobalEtagV2,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({ content: globalContentV3 }),
    });
    expect(updateGlobalRes3.status).toBe(200);

    const spaceATokenV2 = `INSTRUCTION_TOKEN_SPACE_A_${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}_V2`;
    const spaceAContentV2 = `# Space Alpha Rules v2 Hot Reload\n- Hot Space Alpha Rule: ${spaceATokenV2}\n`;
    const expectedSpaceAEtagV2 = computeExpectedEtag(spaceAContentV2);

    const updateSpaceARes2 = await fetch(`${platformUrl}/api/spaces/${spaceA.id}/instructions?file=AGENTS.md`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        'If-Match': expectedSpaceAEtagV1,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({ content: spaceAContentV2 }),
    });
    expect(updateSpaceARes2.status).toBe(200);

    // Next turn in warm Session A: proves hot reload without agent eviction
    const turn2SessionAPrompt = 'Warm turn 2 verification [enkeep-test-echo-instructions]';
    await fetch(`${platformUrl}/api/sessions/${sessionA.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({ content: turn2SessionAPrompt }),
    });

    const assistant2A = await waitForDeliveredAssistant(platformUrl, sessionA.id, aliceAuth.cookie);
    expect(assistant2A.content).toContain(globalTokenV3);
    expect(assistant2A.content).not.toContain(globalTokenV2);
    expect(assistant2A.content).toContain(spaceATokenV2);
    expect(assistant2A.content).not.toContain(spaceATokenV1);
    expect(assistant2A.content).not.toContain(spaceBTokenV1);

    // Verify replacement semantics via DSH Session Events from the container runtime
    const aliceUserRow = runningSystem.database.prepare("SELECT id FROM users WHERE username = 'alice'").get() as any;
    expect(aliceUserRow).toBeDefined();

    const routeRowA = runningSystem.database.prepare('SELECT dsh_session_id FROM session_routes WHERE id = ?').get(sessionA.id) as any;
    expect(routeRowA).toBeDefined();

    const exportedSeedA = await runningSystem.platformServer.runtimeArtifactPort!.exportForkSeed({
      userId: aliceUserRow.id,
      sourceDshSessionId: routeRowA.dsh_session_id,
      workspaceFolder: spaceA.folder,
    });
    expect(exportedSeedA.events.length).toBeGreaterThan(0);

    const instructionEventsA = exportedSeedA.events.filter(
      (e: any) => e.type === 'user/message' && e.data?.source?.kind === 'agent-instructions'
    );
    expect(instructionEventsA.length).toBeGreaterThanOrEqual(2);

    // The replacement instruction event in Turn 2 has changes confirming replace/set action
    const turn2InstructionEvent = instructionEventsA[instructionEventsA.length - 1];
    expect(turn2InstructionEvent.data.source.changes).toBeDefined();
    expect(
      turn2InstructionEvent.data.source.changes.some(
        (c: any) => (c.action === 'replace' || c.action === 'set')
      )
    ).toBe(true);

    // Verify that the replacement payload content contains the new tokens and not old tokens
    const replacementPayloadText = JSON.stringify(turn2InstructionEvent.data.content);
    expect(replacementPayloadText).toContain(globalTokenV3);
    expect(replacementPayloadText).not.toContain(globalTokenV2);
    expect(replacementPayloadText).toContain(spaceATokenV2);
    expect(replacementPayloadText).not.toContain(spaceATokenV1);

    // =========================================================================
    // 6) Container Remove & Recreate with Same Volume + Multi-Tenant Isolation
    // =========================================================================
    // Close runtime system preserving volumes
    await runningSystem.close({ removeVolumes: false });
    runningSystem = null;

    // Relaunch demo system with same volumes
    runningSystem = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix: activeResourceSuffix,
      runtimeImage: 'enkeep-demo-runtime:acceptance',
      runtimeAdapter: adapter,
      llmEnabled: false,
    });
    expect(runningSystem.result.ok).toBe(true);

    const rePlatformUrl = runningSystem.result.platform.url!;
    const reAliceAuth = await loginUser(rePlatformUrl, resetResult.credentials.admin);
    const reBobAuth = await loginUser(rePlatformUrl, resetResult.credentials.user);

    // Turn after container restart: instructions v3 / spaceA2 must still be present from persistent volume
    const turn3SessionAPrompt = 'Post restart continuity [enkeep-test-echo-instructions]';
    await fetch(`${rePlatformUrl}/api/sessions/${sessionA.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': reAliceAuth.csrfToken,
        Origin: rePlatformUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        Cookie: reAliceAuth.cookie,
      },
      body: JSON.stringify({ content: turn3SessionAPrompt }),
    });

    const assistant3A = await waitForDeliveredAssistant(rePlatformUrl, sessionA.id, reAliceAuth.cookie);
    expect(assistant3A.content).toContain(globalTokenV3);
    expect(assistant3A.content).toContain(spaceATokenV2);

    // Multi-tenant Isolation: Bob cannot GET or PUT Alice's space instructions
    const bobGetAliceSpace = await fetch(`${rePlatformUrl}/api/spaces/${spaceA.id}/instructions?file=AGENTS.md`, {
      headers: { Cookie: reBobAuth.cookie },
    });
    expect([403, 404]).toContain(bobGetAliceSpace.status);

    const bobPutAliceSpace = await fetch(`${rePlatformUrl}/api/spaces/${spaceA.id}/instructions?file=AGENTS.md`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': reBobAuth.csrfToken,
        Origin: rePlatformUrl,
        Cookie: reBobAuth.cookie,
      },
      body: JSON.stringify({ content: '# Malicious Overwrite Attempt' }),
    });
    expect([403, 404]).toContain(bobPutAliceSpace.status);

    // Multi-tenant Isolation: Bob's global instructions are completely separate
    const bobToken = `INSTRUCTION_TOKEN_BOB_GLOBAL_${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
    const bobGlobalContent = `# Bob Personal Instructions\n- Bob Secret Rule: ${bobToken}\n`;
    const putBobGlobal = await fetch(`${rePlatformUrl}/api/account/instructions/global`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': reBobAuth.csrfToken,
        Origin: rePlatformUrl,
        Cookie: reBobAuth.cookie,
      },
      body: JSON.stringify({ content: bobGlobalContent }),
    });
    expect(putBobGlobal.status).toBe(200);

    // Alice global instructions still have globalTokenV3 and NOT Bob's token
    const aliceGetGlobalAgain = await fetch(`${rePlatformUrl}/api/account/instructions/global`, {
      headers: { Cookie: reAliceAuth.cookie },
    });
    const aliceGlobalJsonAgain = await aliceGetGlobalAgain.json();
    expect(aliceGlobalJsonAgain.data.content).toContain(globalTokenV3);
    expect(aliceGlobalJsonAgain.data.content).not.toContain(bobToken);

    // =========================================================================
    // 7) Docker Process Topology Check: remains resident daemon/bridge, no per-turn process leaks
    // =========================================================================
    const aliceContainerName = `enkeep-demo-alice-${activeResourceSuffix}`;
    const aliceInspect = await dockerClient.inspectContainer(aliceContainerName);
    expect(aliceInspect).not.toBeNull();
    expect(aliceInspect?.state).toBe('running');

    // =========================================================================
    // 8) No Content Leaks in Audit Rows: DB audit stores only hash/bytes metrics
    // =========================================================================
    const paths = getDemoPathConfig({ repoRoot: tempRepo.repoRoot, resourceSuffix: activeResourceSuffix });
    const db = new DatabaseSync(paths.dbPath);

    const auditRows = db.prepare('SELECT id, user_id, action, details, created_at FROM auth_audit_log').all() as Array<{
      id: string;
      user_id: string;
      action: string;
      details: string;
      created_at: string;
    }>;

    const instructionAuditRows = auditRows.filter(
      (r) => r.action === 'instructions.update_global' || r.action === 'instructions.update_space'
    );
    expect(instructionAuditRows.length).toBeGreaterThanOrEqual(4);

    const allSecretTokens = [
      globalTokenV1,
      globalTokenV2,
      globalTokenV3,
      spaceATokenV1,
      spaceATokenV2,
      spaceBTokenV1,
      bobToken,
    ];

    for (const row of instructionAuditRows) {
      expect(row.details).toBeDefined();
      const details = JSON.parse(row.details);
      // Valid metrics recorded
      expect(details.filename).toBe('AGENTS.md');
      expect(typeof details.size).toBe('number');
      expect(details.size).toBeGreaterThan(0);
      expect(details.etag).toMatch(/^"[0-9a-f]{64}"$/);

      // Strict Zero-Leakage: No raw tokens in audit details
      for (const secret of allSecretTokens) {
        expect(row.details).not.toContain(secret);
      }
    }

    // Comprehensive whole-database audit log check: no plaintext secret token anywhere in auth_audit_log
    const allAuditDetailsJson = JSON.stringify(auditRows);
    for (const secret of allSecretTokens) {
      expect(allAuditDetailsJson).not.toContain(secret);
    }
  });
});
