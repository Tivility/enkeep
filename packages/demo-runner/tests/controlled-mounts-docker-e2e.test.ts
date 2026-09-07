/**
 * Real Docker Acceptance Test for Controlled Mounts E2E Lifecycle, Isolation, RO/RW Enforcement, & Container Reconcile
 *
 * Runs under `pnpm --filter @enkeep/demo-runner run test:docker` or root `test:docker` / `test:controlled-mounts`.
 * Never runs under normal unit `pnpm test`.
 *
 * Verifies:
 * 1) Temp demo launch Alice container space & session, Turn 1 creates JSONL & records containerID / volumeID.
 * 2) Admin POST RO mount tempdir, reconciler drain/recreate; new containerID different, volumeID same;
 *    Turn prompt deterministic mount directive & direct agent prove /mnt/ro/file visible;
 *    Docker inspect verifies actual container bind inspect :ro.
 * 3) Attempt write/edit/bash redirection to RO denied and host filesystem unchanged.
 * 4) Admin POST RW mount, recreate; write through agent/tool persists to host filesystem;
 *    Session prior history continues sequentially without corruption.
 * 5) Admin DELETE RO, container recreate same volume, next turn /mnt/ro missing; RW mount still accessible.
 * 6) Space B cannot access /mnt/rw even though physical container has union bind; same slug distinct spaces isolation.
 * 7) Docker inspect proves no unauthorized binds, root readonly, network none unchanged;
 *    Zero plaintext source path leaks in audit logs; hermetic cleanup.
 *
 * @module @enkeep/demo-runner/tests/controlled-mounts-docker-e2e.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
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
  maxWaitSeconds = 40
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
      if (lastMsg && lastMsg.role === 'assistant' && (lastMsg.status === 'delivered' || lastMsg.status === 'error')) {
        return lastMsg;
      }
    }
  }
  throw new Error(`Timed out waiting for assistant message. Last messages: ${JSON.stringify(lastMsgs)}`);
}

describe('Controlled Mounts Real Docker Acceptance Lifecycle (Zero-Network Isolation & Reconcile)', () => {
  let tempRepo: TempRepo | null = null;
  let activeResourceSuffix: string | null = null;
  let runGeneratedMetadata = false;
  let probeBefore: ProtectedPortsSnapshot | null = null;
  let runningSystem: RunningDemoSystem | null = null;

  let origLlmEnabled: string | undefined;

  beforeEach(() => {
    origLlmEnabled = process.env.ENKEEP_LLM_ENABLED;
    process.env.ENKEEP_LLM_ENABLED = '0';
  });

  afterEach(async () => {
    if (origLlmEnabled !== undefined) {
      process.env.ENKEEP_LLM_ENABLED = origLlmEnabled;
    } else {
      delete process.env.ENKEEP_LLM_ENABLED;
    }

    const teardownErrors: Error[] = [];

    // Step 1: Close running platform server & release resources
    if (runningSystem) {
      try {
        await runningSystem.close({ removeVolumes: true });
      } catch (err: unknown) {
        teardownErrors.push(err instanceof Error ? err : new Error(String(err)));
      }
      runningSystem = null;
    }

    // Step 2: Call downDemo to clean up containers and volumes
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

          if (cA !== null) teardownErrors.push(new Error(`LEAK DETECTED: Container "${aliceContainer}" still exists`));
          if (cB !== null) teardownErrors.push(new Error(`LEAK DETECTED: Container "${bobContainer}" still exists`));
          if (vA !== null) teardownErrors.push(new Error(`LEAK DETECTED: Volume "${aliceVol}" still exists`));
          if (vB !== null) teardownErrors.push(new Error(`LEAK DETECTED: Volume "${bobVol}" still exists`));
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

  it('verifies complete Controlled Mounts vertical closed loop in real Docker runtime (RO/RW, Reconcile, Volume Continuity, Space Isolation, Zero Leaks)', async () => {
    const runtimeImage = process.env.ENKEEP_RUNTIME_IMAGE?.trim() || 'enkeep-demo-runtime:acceptance';
    const dockerClient = new SafeDockerClient();

    const isDockerAvailable = await dockerClient.isDockerAvailable();
    if (!isDockerAvailable) {
      throw new Error('FAIL-CLOSED: Docker daemon is unavailable. Real Docker acceptance test requires running Docker daemon.');
    }

    probeBefore = await probeProtectedPorts();

    const resourceSuffix = generateSuffix12();
    activeResourceSuffix = resourceSuffix;
    tempRepo = createTempRepo();
    runGeneratedMetadata = true;

    // -----------------------------------------------------------------------------------
    // 1. Temp Demo Launch Alice Container Space, Session, & Initial Turn (Record Container & Volume ID)
    // -----------------------------------------------------------------------------------
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

    // Retrieve Alice's spaces
    const spacesRes = await fetch(`${serverUrl}/api/spaces`, {
      headers: { Cookie: aliceCookie },
    });
    expect(spacesRes.status).toBe(200);
    const spacesData = ((await spacesRes.json()) as any).data;
    const spaceA = spacesData.find((s: any) => s.id.startsWith('spc_')) || spacesData[0];
    const spaceAId = spaceA.id;

    // Create session in Space A
    const sessionRes = await fetch(`${serverUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ spaceId: spaceAId, title: 'Alice Controlled Mounts Session' }),
    });
    expect(sessionRes.status).toBe(201);
    const sessionIdA = ((await sessionRes.json()) as any).data.id;

    // Record initial Container ID & Volume ID
    const aliceContainerName = `enkeep-demo-alice-${resourceSuffix}`;
    const initialContainerInspect = await dockerClient.inspectContainer(aliceContainerName);
    expect(initialContainerInspect).not.toBeNull();
    const containerId_1 = initialContainerInspect!.id;
    const volumeName_1 = initialContainerInspect!.mounts?.find((m) => m.type === 'volume')?.name;
    expect(volumeName_1).toBe(`enkeep-demo-dsh-alice-${resourceSuffix}`);

    // Turn 1: Write initial state file to establish JSONL session persistence in volume
    const turn1Secret = `INIT_STATE_${randomUUID().slice(0, 8)}`;
    const turn1Prompt = `[enkeep-test-tool-call=write:{"file_path":"init_state.txt","content":"${turn1Secret}"}] Initialize turn 1 with ${turn1Secret}`;
    const t1Res = await fetch(`${serverUrl}/api/sessions/${sessionIdA}/messages`, {
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
    const assistant1 = await waitForDeliveredAssistant(serverUrl, sessionIdA, aliceCookie);
    expect(assistant1).toBeDefined();
    expect(assistant1.status).toBe('delivered');

    // -----------------------------------------------------------------------------------
    // 2. Admin POST RO Mount Tempdir, Reconciler Drain/Recreate (new containerID != old, volume same)
    //    Turn prompt deterministic mount directive & direct agent prove /mnt/ro/file visible
    //    Container inspect verifies :ro bind mode
    // -----------------------------------------------------------------------------------
    const hostDirRO = join(tempRepo.repoRoot, 'host-mount-ro');
    mkdirSync(hostDirRO, { recursive: true, mode: 0o755 });
    const roSecretToken = `RO_TOKEN_${randomUUID().slice(0, 8)}`;
    writeFileSync(join(hostDirRO, 'spec.md'), `# Immutable RO Spec\nSecretToken: ${roSecretToken}\n`, 'utf8');

    // Admin creates RO Mount via POST /api/admin/spaces/:spaceId/mounts
    const postRoRes = await fetch(`${serverUrl}/api/admin/spaces/${spaceAId}/mounts`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'ro_mount',
        sourcePath: hostDirRO,
        mode: 'ro',
      }),
    });
    expect(postRoRes.status).toBe(201);
    const roMountDto = ((await postRoRes.json()) as any).data;
    expect(roMountDto.id).toBeDefined();
    expect(roMountDto.name).toBe('ro_mount');
    expect(roMountDto.mode).toBe('ro');
    expect(roMountDto.sourcePath).toBe(hostDirRO);
    const roMountId = roMountDto.id;

    // Inspect Docker container after RO mount reconcile
    const postRoContainerInspect = await dockerClient.inspectContainer(aliceContainerName);
    expect(postRoContainerInspect).not.toBeNull();
    const containerId_2 = postRoContainerInspect!.id;
    const volumeName_2 = postRoContainerInspect!.mounts?.find((m) => m.type === 'volume')?.name;

    // Verify container recreated with DIFFERENT containerId but SAME volumeName
    expect(containerId_2).not.toBe(containerId_1);
    expect(volumeName_2).toBe(volumeName_1);

    // Verify Docker inspect container mounts has bind mount to /home/dsh/mounts/<id> with rw: false (:ro)
    const roBindMount = postRoContainerInspect!.mounts?.find((m) => m.type === 'bind' && m.destination === `/home/dsh/mounts/${roMountId}`);
    expect(roBindMount).toBeDefined();
    expect(roBindMount!.rw).toBe(false); // Verified :ro on real container bind!

    // Turn 2: Agent reads /mnt/ro_mount/spec.md via official read tool
    const turn2Prompt = `[enkeep-test-tool-call=read:{"file_path":"/mnt/ro_mount/spec.md"}] Read RO file`;
    const t2Res = await fetch(`${serverUrl}/api/sessions/${sessionIdA}/messages`, {
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
    const assistant2 = await waitForDeliveredAssistant(serverUrl, sessionIdA, aliceCookie);
    expect(assistant2).toBeDefined();
    expect(assistant2.content).toContain(roSecretToken);

    // Direct Bash tool reading /mnt/ro_mount/spec.md
    const turn2BashPrompt = `[enkeep-test-tool-call=bash:{"command":"cat /mnt/ro_mount/spec.md","description":"read ro file"}] Cat RO file via bash`;
    const t2BashRes = await fetch(`${serverUrl}/api/sessions/${sessionIdA}/messages`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: turn2BashPrompt }),
    });
    expect([200, 202]).toContain(t2BashRes.status);
    const assistant2Bash = await waitForDeliveredAssistant(serverUrl, sessionIdA, aliceCookie);
    expect(assistant2Bash).toBeDefined();
    expect(assistant2Bash.content).toContain(roSecretToken);

    // -----------------------------------------------------------------------------------
    // 3. Attempt Write / Edit / Bash Redirection to RO Denied & Host Unchanged
    // -----------------------------------------------------------------------------------
    // 3a. Attempt file write tool in RO mount
    const illegalWritePrompt = `[enkeep-test-tool-call=write:{"file_path":"/mnt/ro_mount/hacked.txt","content":"illegal mutation"}] Attempt write in RO`;
    const t3WriteRes = await fetch(`${serverUrl}/api/sessions/${sessionIdA}/messages`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: illegalWritePrompt }),
    });
    expect([200, 202]).toContain(t3WriteRes.status);
    const assistant3Write = await waitForDeliveredAssistant(serverUrl, sessionIdA, aliceCookie);
    expect(assistant3Write).toBeDefined();
    // Assistant content or status reflects denial / error
    expect(assistant3Write.content?.toLowerCase()).toMatch(/read-only|access denied|prohibited|error|forbidden/i);

    // 3b. Attempt file edit tool in RO mount
    const illegalEditPrompt = `[enkeep-test-tool-call=edit:{"file_path":"/mnt/ro_mount/spec.md","old_string":"Immutable","new_string":"Mutated"}] Attempt edit in RO`;
    const t3EditRes = await fetch(`${serverUrl}/api/sessions/${sessionIdA}/messages`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: illegalEditPrompt }),
    });
    expect([200, 202]).toContain(t3EditRes.status);
    const assistant3Edit = await waitForDeliveredAssistant(serverUrl, sessionIdA, aliceCookie);
    expect(assistant3Edit).toBeDefined();
    expect(assistant3Edit.content?.toLowerCase()).toMatch(/read-only|access denied|prohibited|error|forbidden/i);

    // 3c. Attempt bash redirection to RO mount
    const illegalBashPrompt = `[enkeep-test-tool-call=bash:{"command":"echo 'illegal' > /mnt/ro_mount/attack.txt","description":"attack"}] Attempt bash redirection in RO`;
    const t3BashRes = await fetch(`${serverUrl}/api/sessions/${sessionIdA}/messages`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: illegalBashPrompt }),
    });
    expect([200, 202]).toContain(t3BashRes.status);
    const assistant3Bash = await waitForDeliveredAssistant(serverUrl, sessionIdA, aliceCookie);
    expect(assistant3Bash).toBeDefined();
    expect(assistant3Bash.content?.toLowerCase()).toMatch(/read-only|cannot write|access denied|error|failed/i);

    // Assert host filesystem is completely untouched
    expect(existsSync(join(hostDirRO, 'hacked.txt'))).toBe(false);
    expect(existsSync(join(hostDirRO, 'attack.txt'))).toBe(false);
    expect(readFileSync(join(hostDirRO, 'spec.md'), 'utf8')).toContain(roSecretToken);
    expect(readFileSync(join(hostDirRO, 'spec.md'), 'utf8')).not.toContain('Mutated');

    // -----------------------------------------------------------------------------------
    // 4. POST RW Mount, Recreate; Write Through Agent/Tool Persists Host; Session History Continues Seq
    // -----------------------------------------------------------------------------------
    const hostDirRW = join(tempRepo.repoRoot, 'host-mount-rw');
    mkdirSync(hostDirRW, { recursive: true, mode: 0o755 });
    chmodSync(hostDirRW, 0o755);
    writeFileSync(join(hostDirRW, 'seed.txt'), 'Initial RW host file\n', 'utf8');

    // Admin creates RW Mount via POST /api/admin/spaces/:spaceId/mounts
    const postRwRes = await fetch(`${serverUrl}/api/admin/spaces/${spaceAId}/mounts`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'rw_mount',
        sourcePath: hostDirRW,
        mode: 'rw',
      }),
    });
    expect(postRwRes.status).toBe(201);
    const rwMountDto = ((await postRwRes.json()) as any).data;
    expect(rwMountDto.name).toBe('rw_mount');
    expect(rwMountDto.mode).toBe('rw');
    const rwMountId = rwMountDto.id;

    // Inspect Docker container after RW mount reconcile
    const postRwContainerInspect = await dockerClient.inspectContainer(aliceContainerName);
    expect(postRwContainerInspect).not.toBeNull();
    const containerId_3 = postRwContainerInspect!.id;
    const volumeName_3 = postRwContainerInspect!.mounts?.find((m) => m.type === 'volume')?.name;

    expect(containerId_3).not.toBe(containerId_2);
    expect(volumeName_3).toBe(volumeName_1);

    // Verify Docker inspect container mounts has bind mount with rw: true (:rw)
    const rwBindMount = postRwContainerInspect!.mounts?.find((m) => m.type === 'bind' && m.destination === `/home/dsh/mounts/${rwMountId}`);
    expect(rwBindMount).toBeDefined();
    expect(rwBindMount!.rw).toBe(true); // Verified :rw on real container bind!

    // Turn 4: Write file to RW mount through agent write tool
    const rwPersistSecret = `RW_PERSISTED_${randomUUID().slice(0, 8)}`;
    const turn4Prompt = `[enkeep-test-tool-call=write:{"file_path":"/mnt/rw_mount/agent_created.txt","content":"${rwPersistSecret}"}] Write persistent notes to RW mount`;
    const t4Res = await fetch(`${serverUrl}/api/sessions/${sessionIdA}/messages`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: turn4Prompt }),
    });
    expect([200, 202]).toContain(t4Res.status);
    const assistant4 = await waitForDeliveredAssistant(serverUrl, sessionIdA, aliceCookie);
    expect(assistant4).toBeDefined();
    expect(assistant4.status).toBe('delivered');

    // Verify host filesystem received persisted file
    const hostAgentCreatedFile = join(hostDirRW, 'agent_created.txt');
    expect(existsSync(hostAgentCreatedFile)).toBe(true);
    expect(readFileSync(hostAgentCreatedFile, 'utf8')).toBe(rwPersistSecret);

    // Bash tool write in RW mount
    const bashRwSecret = `BASH_PERSISTED_${randomUUID().slice(0, 8)}`;
    const turn4BashPrompt = `[enkeep-test-tool-call=bash:{"command":"echo '${bashRwSecret}' > /mnt/rw_mount/bash_created.txt","description":"bash write"}] Write via bash in RW mount`;
    const t4BashRes = await fetch(`${serverUrl}/api/sessions/${sessionIdA}/messages`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: turn4BashPrompt }),
    });
    expect([200, 202]).toContain(t4BashRes.status);
    const assistant4Bash = await waitForDeliveredAssistant(serverUrl, sessionIdA, aliceCookie);
    expect(assistant4Bash).toBeDefined();

    // Verify host filesystem received bash created file
    const hostBashCreatedFile = join(hostDirRW, 'bash_created.txt');
    expect(existsSync(hostBashCreatedFile)).toBe(true);
    expect(readFileSync(hostBashCreatedFile, 'utf8')).toContain(bashRwSecret);

    // Verify session prior history continues sequentially with no corruption
    const historyRes = await fetch(`${serverUrl}/api/sessions/${sessionIdA}/messages`, {
      headers: { Cookie: aliceCookie },
    });
    expect(historyRes.status).toBe(200);
    const historyData = ((await historyRes.json()) as any).data;
    const messages = historyData.messages || [];
    expect(messages.length).toBeGreaterThanOrEqual(8);
    // Verify messages timestamps are monotonic
    for (let i = 1; i < messages.length; i++) {
      expect(new Date(messages[i].createdAt).getTime()).toBeGreaterThanOrEqual(new Date(messages[i - 1].createdAt).getTime());
    }
    // Verify Turn 1 message exists in history
    expect(messages.some((m: any) => m.content?.includes(turn1Secret))).toBe(true);

    // -----------------------------------------------------------------------------------
    // 5. DELETE RO, Container Recreate Same Volume, Next Turn /mnt/ro Missing; RW Still Accessible
    // -----------------------------------------------------------------------------------
    const delRoRes = await fetch(`${serverUrl}/api/admin/spaces/${spaceAId}/mounts/${roMountId}`, {
      method: 'DELETE',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
      },
    });
    expect(delRoRes.status).toBe(200);
    const delRoData = ((await delRoRes.json()) as any).data;
    expect(delRoData.deleted).toBe(true);

    // Inspect Docker container after RO mount deletion reconcile
    const postDelContainerInspect = await dockerClient.inspectContainer(aliceContainerName);
    expect(postDelContainerInspect).not.toBeNull();
    const containerId_4 = postDelContainerInspect!.id;
    const volumeName_4 = postDelContainerInspect!.mounts?.find((m) => m.type === 'volume')?.name;

    expect(containerId_4).not.toBe(containerId_3);
    expect(volumeName_4).toBe(volumeName_1);

    // Verify RO mount is absent in container bind mounts, while RW mount remains
    const postDelRoBind = postDelContainerInspect!.mounts?.find((m) => m.type === 'bind' && m.destination === `/home/dsh/mounts/${roMountId}`);
    const postDelRwBind = postDelContainerInspect!.mounts?.find((m) => m.type === 'bind' && m.destination === `/home/dsh/mounts/${rwMountId}`);
    expect(postDelRoBind).toBeUndefined();
    expect(postDelRwBind).toBeDefined();

    // Turn 5a: Attempt to read deleted RO mount -> fails / reported missing
    const turn5Prompt = `[enkeep-test-tool-call=read:{"file_path":"/mnt/ro_mount/spec.md"}] Read deleted RO mount`;
    const t5Res = await fetch(`${serverUrl}/api/sessions/${sessionIdA}/messages`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: turn5Prompt }),
    });
    expect([200, 202]).toContain(t5Res.status);
    const assistant5 = await waitForDeliveredAssistant(serverUrl, sessionIdA, aliceCookie);
    expect(assistant5).toBeDefined();
    expect(assistant5.content?.toLowerCase()).toMatch(/not found|does not exist|access denied|error/i);

    // Turn 5b: Read surviving RW mount -> succeeds
    const turn5RwPrompt = `[enkeep-test-tool-call=read:{"file_path":"/mnt/rw_mount/agent_created.txt"}] Read surviving RW mount`;
    const t5RwRes = await fetch(`${serverUrl}/api/sessions/${sessionIdA}/messages`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: turn5RwPrompt }),
    });
    expect([200, 202]).toContain(t5RwRes.status);
    const assistant5Rw = await waitForDeliveredAssistant(serverUrl, sessionIdA, aliceCookie);
    expect(assistant5Rw).toBeDefined();
    expect(assistant5Rw.content).toContain(rwPersistSecret);

    // -----------------------------------------------------------------------------------
    // 6. Space B Cannot Access /mnt/rw Even Though Container Has Union Bind; Same Slug Distinct Spaces
    // -----------------------------------------------------------------------------------
    // Alice creates Space B
    const createSpaceBRes = await fetch(`${serverUrl}/api/spaces`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Alice Container Space B',
        folder: 'alice-space-b',
        executionMode: 'container',
      }),
    });
    expect(createSpaceBRes.status).toBe(201);
    const spaceBId = ((await createSpaceBRes.json()) as any).data.id;

    // Create session in Space B
    const sessionBRes = await fetch(`${serverUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ spaceId: spaceBId, title: 'Space B Session' }),
    });
    expect(sessionBRes.status).toBe(201);
    const sessionIdB = ((await sessionBRes.json()) as any).data.id;

    // Turn in Space B attempting to access Space A's RW mount -> FAILS / ACCESS DENIED
    const crossSpacePrompt = `[enkeep-test-tool-call=read:{"file_path":"/mnt/rw_mount/agent_created.txt"}] Cross-space read attempt`;
    const tBRes = await fetch(`${serverUrl}/api/sessions/${sessionIdB}/messages`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: crossSpacePrompt }),
    });
    expect([200, 202]).toContain(tBRes.status);
    const assistantB = await waitForDeliveredAssistant(serverUrl, sessionIdB, aliceCookie);
    expect(assistantB).toBeDefined();
    expect(assistantB.content?.toLowerCase()).toMatch(/not found|does not exist|access denied|error/i);

    // Distinct mount in Space B with same slug name 'rw_mount' pointing to hostDirSpaceB
    const hostDirSpaceB = join(tempRepo.repoRoot, 'host-mount-space-b');
    mkdirSync(hostDirSpaceB, { recursive: true, mode: 0o755 });
    chmodSync(hostDirSpaceB, 0o755);
    const spaceBSecret = `SPACE_B_SECRET_${randomUUID().slice(0, 8)}`;
    writeFileSync(join(hostDirSpaceB, 'b_doc.txt'), spaceBSecret, 'utf8');

    const postSpaceBMountRes = await fetch(`${serverUrl}/api/admin/spaces/${spaceBId}/mounts`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'rw_mount',
        sourcePath: hostDirSpaceB,
        mode: 'rw',
      }),
    });
    expect(postSpaceBMountRes.status).toBe(201);

    // In Space B: read /mnt/rw_mount/b_doc.txt -> SUCCEEDS and returns spaceBSecret
    const spaceBReadPrompt = `[enkeep-test-tool-call=read:{"file_path":"/mnt/rw_mount/b_doc.txt"}] Read Space B own mount`;
    const tB2Res = await fetch(`${serverUrl}/api/sessions/${sessionIdB}/messages`, {
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
    expect([200, 202]).toContain(tB2Res.status);
    const assistantB2 = await waitForDeliveredAssistant(serverUrl, sessionIdB, aliceCookie);
    expect(assistantB2).toBeDefined();
    expect(assistantB2.content).toContain(spaceBSecret);

    // In Space A: read /mnt/rw_mount/b_doc.txt -> FAILS because Space A's rw_mount points to hostDirRW (not hostDirSpaceB)
    const spaceAReadBFilePrompt = `[enkeep-test-tool-call=read:{"file_path":"/mnt/rw_mount/b_doc.txt"}] Read Space B file from Space A`;
    const tA3Res = await fetch(`${serverUrl}/api/sessions/${sessionIdA}/messages`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: spaceAReadBFilePrompt }),
    });
    expect([200, 202]).toContain(tA3Res.status);
    const assistantA3 = await waitForDeliveredAssistant(serverUrl, sessionIdA, aliceCookie);
    expect(assistantA3).toBeDefined();
    expect(assistantA3.content?.toLowerCase()).toMatch(/not found|does not exist|access denied|error/i);

    // -----------------------------------------------------------------------------------
    // 7. Docker Inspect No Unauthorized Binds, Root Readonly / Network None Unchanged;
    //    Strict Zero Plaintext Source Path Leaks in Database Audit
    // -----------------------------------------------------------------------------------
    const finalContainerInspect = await dockerClient.inspectContainer(aliceContainerName);
    expect(finalContainerInspect).not.toBeNull();
    expect(finalContainerInspect!.networkMode).toBe('none');
    expect(finalContainerInspect!.portBindings).toBeNull();
    expect(finalContainerInspect!.readonlyRootfs).toBe(true);

    // Verify all bind mounts strictly target /home/dsh/mounts/<id>
    const allBinds = finalContainerInspect!.mounts?.filter((m) => m.type === 'bind') || [];
    for (const bind of allBinds) {
      expect(bind.destination.startsWith('/home/dsh/mounts/')).toBe(true);
    }
    // Verify tmpfs only /tmp
    const tmpfsMounts = finalContainerInspect!.mounts?.filter((m) => m.type === 'tmpfs') || [];
    for (const tmpfs of tmpfsMounts) {
      expect(tmpfs.destination).toBe('/tmp');
    }

    // Zero-Leakage Audit Check: Database space_mounts contains NO plaintext host paths
    const db = new DatabaseSync(paths.dbPath, { readOnly: true });
    try {
      const mountRows = db.prepare('SELECT * FROM space_mounts').all() as any[];
      expect(mountRows.length).toBeGreaterThan(0);
      for (const row of mountRows) {
        expect(row.source_path_encrypted).toBeDefined();
        expect(row.source_fingerprint).toBeDefined();
        // Check that raw source paths are not leaked in plaintext columns
        expect(row.source_path_encrypted).not.toBe(hostDirRO);
        expect(row.source_path_encrypted).not.toBe(hostDirRW);
        expect(row.source_path_encrypted).not.toBe(hostDirSpaceB);
        expect(row.source_fingerprint).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
      }

      // Check auth_audit_log for zero path leakage
      const auditRows = db.prepare("SELECT * FROM auth_audit_log WHERE action LIKE '%mount%'").all() as any[];
      for (const row of auditRows) {
        const detailsStr = typeof row.details === 'string' ? row.details : JSON.stringify(row.details);
        expect(detailsStr).not.toContain(hostDirRO);
        expect(detailsStr).not.toContain(hostDirRW);
        expect(detailsStr).not.toContain(hostDirSpaceB);
      }
    } finally {
      db.close();
    }
  }, 180000);
});
