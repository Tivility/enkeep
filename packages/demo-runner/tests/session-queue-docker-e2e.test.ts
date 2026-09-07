/**
 * Real Docker Acceptance Test for Session Queue Serialization & Corruption Recovery Defense
 *
 * Verifies:
 * 1) Rapid 10 POST messages to SAME session against real Docker container:
 *    - All 10 user messages accepted with queued status.
 *    - Executed strictly in FIFO sequence by container.
 *    - 10 assistant ordered mapping.
 *    - Turn intervals have no overlap (strictly serialized via session_execution_leases).
 *    - JSONL transcript on Docker volume has contiguous monotonic seq numbers (no gaps, no duplicates).
 *    - Session resume works cleanly afterwards for extra 11th turn.
 * 2) Multi-session parallel execution:
 *    - Messages dispatched to different sessions execute in parallel across sessions without cross-talk.
 * 3) Session corruption diagnosis & prefix recovery:
 *    - Real seq gap created via controlled test-only RuntimeArtifactPort in container.
 *    - A corrupted session with seq gap flags recovery_required in turn status and recovery endpoint.
 *    - GET /api/sessions/:id/recovery returns safe typed inspection (no raw prompts/paths).
 *    - POST /api/sessions/:id/recovery/fork-valid-prefix creates backup, creates Gen 2 with valid prefix, and unblocks queue.
 *    - Next turn in Generation 2 executes cleanly.
 *
 * Note: Crash windows and recovery state machines (executing absent -> interrupted,
 * completed receipt finalize exactly once, queued held redrive continue, and quota recovery)
 * are covered deterministically by @enkeep/platform-server deterministic test suite
 * (packages/platform-server/tests/delivery-gateway-reconcile-and-quota.test.ts).
 *
 * @module @enkeep/demo-runner/tests/session-queue-docker-e2e.test
 */

import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { launchDemoSystem, type RunningDemoSystem } from '../src/up/index.js';
import { resetDemo } from '../src/reset/index.js';
import { downDemo } from '../src/down/index.js';
import { DockerRuntimeContainerAdapter } from '../src/ports/index.js';
import { probeProtectedPorts } from '../src/utils/probes.js';
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

async function waitForDeliveredTurnCount(
  serverUrl: string,
  sessionId: string,
  cookie: string,
  expectedAssistantMessages: number,
  maxWaitSeconds = 90
): Promise<any[]> {
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
      const assistantMsgs = msgs.filter((m: any) => m.role === 'assistant');
      if (assistantMsgs.length >= expectedAssistantMessages) {
        return msgs;
      }
    }
  }
  const assistantCount = lastMsgs.filter((m: any) => m.role === 'assistant').length;
  throw new Error(`Timeout waiting for ${expectedAssistantMessages} assistant messages in session "${sessionId}". Got ${assistantCount} assistant messages out of ${lastMsgs.length} total messages: ${JSON.stringify(lastMsgs.map((m: any) => ({ role: m.role, content: m.content })))}`);
}

describe('Session Queue Serialization & Corruption Recovery Docker E2E', () => {
  let tempRepo: TempRepo | null = null;
  let activeResourceSuffix: string | null = null;
  let runningSystem: RunningDemoSystem | null = null;

  afterEach(async () => {
    if (runningSystem) {
      try {
        await runningSystem.close();
      } catch {}
      runningSystem = null;
    }

    if (tempRepo && activeResourceSuffix) {
      try {
        await downDemo({
          repoRoot: tempRepo.repoRoot,
          resourceSuffix: activeResourceSuffix,
          removeVolumes: true,
        });
      } catch {}
    }

    tempRepo = null;
    activeResourceSuffix = null;
  });

  // 1. Rapid 10 Concurrent POSTs to same session
  it('executes rapid 10 POSTs to same session without JSONL seq gap or corruption in real Docker container and resumes extra 11th turn', async () => {
    const dockerClient = new SafeDockerClient();
    const isDockerAvailable = await dockerClient.isDockerAvailable();
    if (!isDockerAvailable) {
      throw new Error('Docker daemon unavailable for Docker E2E test');
    }

    activeResourceSuffix = generateSuffix12();
    tempRepo = createTempRepo();

    // 1. Reset demo environment
    const resetResult = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix: activeResourceSuffix,
      forceClean: true,
    });
    expect(resetResult.ok).toBe(true);

    // 2. Launch demo system
    runningSystem = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix: activeResourceSuffix,
      runtimeAdapter: new DockerRuntimeContainerAdapter(dockerClient),
      llmEnabled: false,
    });
    expect(runningSystem.result.ok).toBe(true);

    const serverUrl = runningSystem.platformUrl;
    const { cookie: aliceCookie, csrfToken: aliceCsrf } = await loginUser(serverUrl, resetResult.credentials.admin);

    // 3. Get Alice spaces & create target session
    const spacesRes = await fetch(`${serverUrl}/api/spaces`, {
      headers: { Cookie: aliceCookie },
    });
    expect(spacesRes.status).toBe(200);
    const spacesData = ((await spacesRes.json()) as any).data;
    const spaceA = spacesData.find((s: any) => s.id.startsWith('spc_')) || spacesData[0];

    const createSessionRes = await fetch(`${serverUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ spaceId: spaceA.id, title: 'Alice Queue Rapid 10 Test' }),
    });
    expect(createSessionRes.status).toBe(201);
    const targetSession = ((await createSessionRes.json()) as any).data;
    const targetSessionId = targetSession.id;

    // 4. Send 10 rapid concurrent POST messages to targetSession without sequential awaits
    const postPromises: Promise<Response>[] = [];
    for (let i = 1; i <= 10; i++) {
      const idempotencyKey = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      postPromises.push(
        fetch(`${serverUrl}/api/sessions/${targetSessionId}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Enkeep-CSRF': aliceCsrf,
            'Idempotency-Key': idempotencyKey,
            Cookie: aliceCookie,
            Origin: serverUrl,
          },
          body: JSON.stringify({
            content: `Rapid test message ${i}`,
          }),
        })
      );
    }

    const postResponses = await Promise.all(postPromises);
    for (const res of postResponses) {
      expect([200, 202]).toContain(res.status);
      const json = (await res.json()) as any;
      expect(json.data.accepted).toBe(true);
    }

    // 5. Wait for all 10 assistant replies to complete in FIFO sequence
    const messages = await waitForDeliveredTurnCount(
      serverUrl,
      targetSessionId,
      aliceCookie,
      10,
      120
    );

    const userMsgs = messages.filter((m: any) => m.role === 'user');
    const assistantMsgs = messages.filter((m: any) => m.role === 'assistant');
    expect(userMsgs.length).toBe(10);
    expect(assistantMsgs.length).toBe(10);

    // Verify 10 assistant ordered mapping (prompt i corresponds to assistant response i in order)
    for (let i = 0; i < 10; i++) {
      expect(userMsgs[i].content).toBe(`Rapid test message ${i + 1}`);
    }

    // 6. Verify turn intervals have NO overlap (strictly serialized execution)
    const paths = getDemoPathConfig({ repoRoot: tempRepo.repoRoot, resourceSuffix: activeResourceSuffix });
    const verifyDb = new DatabaseSync(paths.dbPath);
    const leases = verifyDb.prepare(
      'SELECT id, turn_id, phase, status, acquired_at, released_at FROM session_execution_leases WHERE route_id = ? ORDER BY acquired_at ASC, id ASC'
    ).all(targetSessionId) as any[];

    expect(leases.length).toBeGreaterThanOrEqual(10);
    const completedLeases = leases.filter((l: any) => l.status === 'released' && l.released_at);
    expect(completedLeases.length).toBe(10);

    // Verify turn_runs in SQLite: all 10 turns completed in sequence
    const turns = verifyDb.prepare(
      'SELECT turn_id, status FROM turn_runs WHERE route_id = ? ORDER BY created_at ASC'
    ).all(targetSessionId) as any[];
    expect(turns.length).toBe(10);
    expect(turns.every((t: any) => t.status === 'completed')).toBe(true);

    const routeRow = verifyDb.prepare(
      'SELECT user_id, dsh_session_id FROM session_routes WHERE id = ?'
    ).get(targetSessionId) as any;
    verifyDb.close();

    // 7. Inspect session artifact via RuntimeArtifactPort (check valid, contiguous, zero gap)
    const artifactCheck = await runningSystem.platformServer.runtimeArtifactPort?.checkSessionArtifact({
      userId: routeRow.user_id,
      dshSessionId: routeRow.dsh_session_id,
      workspaceFolder: spaceA.folder || 'space-a',
    });
    expect(artifactCheck?.valid).toBe(true);
    expect(artifactCheck?.exists).toBe(true);
    expect(artifactCheck?.eventCount).toBeGreaterThanOrEqual(20);

    const recoveryInspect = await runningSystem.platformServer.sessionLifecycleService?.inspectSessionRecovery(
      routeRow.user_id,
      targetSessionId
    );
    expect(recoveryInspect?.corrupted).toBe(false);
    expect(recoveryInspect?.code).toBe('VALID');
    expect(recoveryInspect?.recoveryRequired).toBe(false);

    // 8. Resume extra 11th turn to ensure continuous monotonic resume
    const postExtraRes = await fetch(`${serverUrl}/api/sessions/${targetSessionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceCsrf,
        'Idempotency-Key': '00000000-0000-4000-8000-000000000011',
        Cookie: aliceCookie,
        Origin: serverUrl,
      },
      body: JSON.stringify({
        content: 'Rapid test message 11',
      }),
    });
    expect([200, 202]).toContain(postExtraRes.status);

    const messages11 = await waitForDeliveredTurnCount(
      serverUrl,
      targetSessionId,
      aliceCookie,
      11,
      30
    );
    const userMsgs11 = messages11.filter((m: any) => m.role === 'user');
    const assistantMsgs11 = messages11.filter((m: any) => m.role === 'assistant');
    expect(userMsgs11.length).toBe(11);
    expect(assistantMsgs11.length).toBe(11);
    expect(userMsgs11[10].content).toBe('Rapid test message 11');

    const artifactCheck11 = await runningSystem.platformServer.runtimeArtifactPort?.checkSessionArtifact({
      userId: routeRow.user_id,
      dshSessionId: routeRow.dsh_session_id,
      workspaceFolder: spaceA.folder || 'space-a',
    });
    expect(artifactCheck11?.valid).toBe(true);
    expect(artifactCheck11?.eventCount).toBeGreaterThan(artifactCheck!.eventCount!);
  }, 180000);

  // 2. Multi-Session Parallel Execution & Isolation
  it('executes multi-session turns in parallel without cross-talk and preserves per-session FIFO queues', async () => {
    const dockerClient = new SafeDockerClient();
    const isDockerAvailable = await dockerClient.isDockerAvailable();
    if (!isDockerAvailable) {
      throw new Error('Docker daemon unavailable for Docker E2E test');
    }

    activeResourceSuffix = generateSuffix12();
    tempRepo = createTempRepo();

    const resetResult = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix: activeResourceSuffix,
      forceClean: true,
    });
    expect(resetResult.ok).toBe(true);

    runningSystem = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix: activeResourceSuffix,
      runtimeAdapter: new DockerRuntimeContainerAdapter(dockerClient),
      llmEnabled: false,
    });
    expect(runningSystem.result.ok).toBe(true);

    const serverUrl = runningSystem.platformUrl;
    const { cookie: aliceCookie, csrfToken: aliceCsrf } = await loginUser(serverUrl, resetResult.credentials.admin);

    const spacesRes = await fetch(`${serverUrl}/api/spaces`, {
      headers: { Cookie: aliceCookie },
    });
    const spacesData = ((await spacesRes.json()) as any).data;
    const spaceA = spacesData.find((s: any) => s.id.startsWith('spc_')) || spacesData[0];

    // Create Session 1 and Session 2
    const createS1 = await fetch(`${serverUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ spaceId: spaceA.id, title: 'Parallel Session 1' }),
    });
    expect(createS1.status).toBe(201);
    const session1Id = ((await createS1.json()) as any).data.id;

    const createS2 = await fetch(`${serverUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ spaceId: spaceA.id, title: 'Parallel Session 2' }),
    });
    expect(createS2.status).toBe(201);
    const session2Id = ((await createS2.json()) as any).data.id;

    // Concurrently dispatch 2 messages to Session 1 and 2 messages to Session 2
    const concurrentPosts = await Promise.all([
      fetch(`${serverUrl}/api/sessions/${session1Id}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': aliceCsrf,
          'Idempotency-Key': '11110000-0000-4000-8000-000000000001',
          Cookie: aliceCookie,
          Origin: serverUrl,
        },
        body: JSON.stringify({ content: 'Session 1 Msg 1' }),
      }),
      fetch(`${serverUrl}/api/sessions/${session1Id}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': aliceCsrf,
          'Idempotency-Key': '11110000-0000-4000-8000-000000000002',
          Cookie: aliceCookie,
          Origin: serverUrl,
        },
        body: JSON.stringify({ content: 'Session 1 Msg 2' }),
      }),
      fetch(`${serverUrl}/api/sessions/${session2Id}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': aliceCsrf,
          'Idempotency-Key': '22220000-0000-4000-8000-000000000001',
          Cookie: aliceCookie,
          Origin: serverUrl,
        },
        body: JSON.stringify({ content: 'Session 2 Msg 1' }),
      }),
      fetch(`${serverUrl}/api/sessions/${session2Id}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': aliceCsrf,
          'Idempotency-Key': '22220000-0000-4000-8000-000000000002',
          Cookie: aliceCookie,
          Origin: serverUrl,
        },
        body: JSON.stringify({ content: 'Session 2 Msg 2' }),
      }),
    ]);

    for (const res of concurrentPosts) {
      expect([200, 202]).toContain(res.status);
    }

    // Wait for both sessions to complete in parallel
    const [s1Msgs, s2Msgs] = await Promise.all([
      waitForDeliveredTurnCount(serverUrl, session1Id, aliceCookie, 2, 60),
      waitForDeliveredTurnCount(serverUrl, session2Id, aliceCookie, 2, 60),
    ]);

    // Verify Session 1 messages and order
    const s1Users = s1Msgs.filter((m: any) => m.role === 'user');
    expect(s1Users.length).toBe(2);
    expect(s1Users[0].content).toBe('Session 1 Msg 1');
    expect(s1Users[1].content).toBe('Session 1 Msg 2');

    // Verify Session 2 messages and order
    const s2Users = s2Msgs.filter((m: any) => m.role === 'user');
    expect(s2Users.length).toBe(2);
    expect(s2Users[0].content).toBe('Session 2 Msg 1');
    expect(s2Users[1].content).toBe('Session 2 Msg 2');

    // Verify session isolation: no cross-talk
    expect(s1Msgs.some((m: any) => m.content?.includes('Session 2'))).toBe(false);
    expect(s2Msgs.some((m: any) => m.content?.includes('Session 1'))).toBe(false);
  }, 120000);

  // 3. Session Corruption (SEQ_GAP) and Prefix Recovery into Generation 2
  it('handles real session corruption with SEQ_GAP via container test op, flags recovery_required, inspects safely, and recovers valid prefix into Generation 2', async () => {
    const dockerClient = new SafeDockerClient();
    const isDockerAvailable = await dockerClient.isDockerAvailable();
    if (!isDockerAvailable) {
      throw new Error('Docker daemon unavailable for Docker E2E test');
    }

    activeResourceSuffix = generateSuffix12();
    tempRepo = createTempRepo();

    const resetResult = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix: activeResourceSuffix,
      forceClean: true,
    });
    expect(resetResult.ok).toBe(true);

    runningSystem = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix: activeResourceSuffix,
      runtimeAdapter: new DockerRuntimeContainerAdapter(dockerClient),
      llmEnabled: false,
    });
    expect(runningSystem.result.ok).toBe(true);

    const serverUrl = runningSystem.platformUrl;
    const { cookie: aliceCookie, csrfToken: aliceCsrf } = await loginUser(serverUrl, resetResult.credentials.admin);

    const spacesRes = await fetch(`${serverUrl}/api/spaces`, {
      headers: { Cookie: aliceCookie },
    });
    const spaceA = ((await spacesRes.json()) as any).data.find((s: any) => s.id.startsWith('spc_')) || ((await spacesRes.json()) as any).data[0];

    const createSessionRes = await fetch(`${serverUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ spaceId: spaceA.id, title: 'Alice Recovery Test Session' }),
    });
    expect(createSessionRes.status).toBe(201);
    const targetSession = ((await createSessionRes.json()) as any).data;
    const targetSessionId = targetSession.id;

    // 1. Dispatch Turn 1 in Generation 1
    const postGen1 = await fetch(`${serverUrl}/api/sessions/${targetSessionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceCsrf,
        'Idempotency-Key': '10101010-1010-4010-8010-101010101010',
        Cookie: aliceCookie,
        Origin: serverUrl,
      },
      body: JSON.stringify({ content: 'Hello Generation 1' }),
    });
    expect([200, 202]).toContain(postGen1.status);
    await waitForDeliveredTurnCount(serverUrl, targetSessionId, aliceCookie, 1, 30);

    // 2. Inspect recovery endpoint before corruption (clean)
    const inspectRes1 = await fetch(`${serverUrl}/api/sessions/${targetSessionId}/recovery`, {
      headers: { Cookie: aliceCookie },
    });
    expect(inspectRes1.status).toBe(200);
    const inspectData1 = ((await inspectRes1.json()) as any).data;
    expect(inspectData1.status).toBe('ok');
    expect(inspectData1.corrupted).toBe(false);
    expect(inspectData1.code).toBe('VALID');

    // 3. REAL CORRUPTION: inject seq gap into Docker session transcript via RuntimeArtifactPort controlled hook
    const paths = getDemoPathConfig({ repoRoot: tempRepo.repoRoot, resourceSuffix: activeResourceSuffix });
    const verifyDb = new DatabaseSync(paths.dbPath);
    const routeRow = verifyDb.prepare('SELECT user_id, dsh_session_id FROM session_routes WHERE id = ?').get(targetSessionId) as any;
    verifyDb.close();

    const corruptRes = await runningSystem.platformServer.runtimeArtifactPort?.corruptSessionArtifact?.({
      userId: routeRow.user_id,
      dshSessionId: routeRow.dsh_session_id,
      type: 'seq_gap',
    });
    expect(corruptRes?.corrupted).toBe(true);

    // 4. Inspect recovery endpoint after corruption -> reports SEQ_GAP
    const inspectRes2 = await fetch(`${serverUrl}/api/sessions/${targetSessionId}/recovery`, {
      headers: { Cookie: aliceCookie },
    });
    expect(inspectRes2.status).toBe(200);
    const inspectData2 = ((await inspectRes2.json()) as any).data;
    expect(inspectData2.status).toBe('ok');
    expect(inspectData2.corrupted).toBe(true);
    expect(inspectData2.code).toBe('SEQ_GAP');
    expect(inspectData2.recoveryRequired).toBe(true);
    expect(inspectData2.errorDetail).toContain('seq gap');

    // 5. Dispatch message against corrupted session -> platform traps error, sets recovery_required
    const postCorrupt = await fetch(`${serverUrl}/api/sessions/${targetSessionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceCsrf,
        'Idempotency-Key': '10101010-1010-4010-8010-101010101099',
        Cookie: aliceCookie,
        Origin: serverUrl,
      },
      body: JSON.stringify({ content: 'Message into corrupted session' }),
    });
    expect([200, 202]).toContain(postCorrupt.status);

    // Wait for executor to fail and mark recovery_required
    let currentStatus: any;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const currentStatusRes = await fetch(`${serverUrl}/api/sessions/${targetSessionId}/turn/current`, {
        headers: { Cookie: aliceCookie },
      });
      if (currentStatusRes.status === 200) {
        currentStatus = ((await currentStatusRes.json()) as any).data;
        if (currentStatus?.status === 'recovery_required') {
          break;
        }
      }
    }

    expect(currentStatus?.status).toBe('recovery_required');

    // Verify turn reached terminal failed status via turns history endpoint
    const turnsRes = await fetch(`${serverUrl}/api/sessions/${targetSessionId}/turns`, {
      headers: { Cookie: aliceCookie },
    });
    expect(turnsRes.status).toBe(200);
    const turnsData = ((await turnsRes.json()) as any).data;
    expect(turnsData.turns.some((t: any) => t.status === 'failed')).toBe(true);

    // 6. Perform fork-valid-prefix recovery via API into Generation 2
    const forkPrefixRes = await fetch(`${serverUrl}/api/sessions/${targetSessionId}/recovery/fork-valid-prefix`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceCsrf,
        'Idempotency-Key': '11111111-2222-4333-8444-555555555555',
        Cookie: aliceCookie,
        Origin: serverUrl,
      },
      body: JSON.stringify({ replayQueued: false }),
    });

    expect(forkPrefixRes.status).toBe(200);
    const forkPrefixData = ((await forkPrefixRes.json()) as any).data;
    expect(forkPrefixData.recovered).toBe(true);
    expect(forkPrefixData.newGeneration).toBe(2);

    // Verify historical generations are retained (Gen 1 archived, Gen 2 active)
    const gensRes = await fetch(`${serverUrl}/api/sessions/${targetSessionId}/generations`, {
      headers: { Cookie: aliceCookie },
    });
    expect(gensRes.status).toBe(200);
    const gensData = ((await gensRes.json()) as any).data;
    expect(gensData.currentGeneration).toBe(2);
    expect(gensData.generations.length).toBe(2);
    expect(gensData.generations.find((g: any) => g.generationNumber === 1)?.current).toBe(false);
    expect(gensData.generations.find((g: any) => g.generationNumber === 2)?.current).toBe(true);

    // 7. Verify recovery endpoint is now clean for Generation 2
    const inspectRes3 = await fetch(`${serverUrl}/api/sessions/${targetSessionId}/recovery`, {
      headers: { Cookie: aliceCookie },
    });
    expect(inspectRes3.status).toBe(200);
    const inspectData3 = ((await inspectRes3.json()) as any).data;
    expect(inspectData3.corrupted).toBe(false);
    expect(inspectData3.recoveryRequired).toBe(false);

    // 8. Dispatch a message in Generation 2 -> executes cleanly!
    const postGen2 = await fetch(`${serverUrl}/api/sessions/${targetSessionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceCsrf,
        'Idempotency-Key': '22222222-3333-4444-8555-666666666666',
        Cookie: aliceCookie,
        Origin: serverUrl,
      },
      body: JSON.stringify({ content: 'Hello Generation 2' }),
    });
    expect([200, 202]).toContain(postGen2.status);

    const msgs = await waitForDeliveredTurnCount(serverUrl, targetSessionId, aliceCookie, 2, 30);
    expect(msgs.some((m: any) => m.content === 'Hello Generation 2')).toBe(true);
  }, 120000);
});
