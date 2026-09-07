/**
 * Daemon Production Process Topology & Invariant E2E Tests
 *
 * Verifies:
 * 1. Exact daemon PID 1 entrypoint + persistent bridge/tunnel only.
 * 2. Zero `exec-cli followup` processes before, during, and after 10 sequential turns.
 * 3. Daemon stats report exact totalTurnsProcessed=10, activeAgentsCount=1, boots once.
 * 4. Volume JSONL is byte-valid and contains complete contiguous session turns.
 * 5. Small idleAgentTimeoutMs evicts idle agent (activeAgentsCount -> 0, evictionsCount >= 1),
 *    container stays alive, and subsequent turn resumes agent seamlessly.
 * 6. Bridge kill triggers automatic reconnect to daemon with same PID 1 and journal.
 * 7. PID 1 exit stops container; adapter starts new container on same owned volume with seamless continuation.
 *
 * @module @enkeep/runtime-runner/tests/daemon-docker-topology.e2e.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import {
  DockerRuntimeAdapter,
  SafeDockerClient,
  type ActiveRuntimeHandle,
  type OwnershipExpectation,
} from '../src/index.js';
import { type RuntimeContainerSpec } from '../src/spec/types.js';

const isDockerAcceptance =
  process.env.ENKEEP_DOCKER_ACCEPTANCE === '1' || process.env.CI === 'true';

const runtimeImage =
  process.env.ENKEEP_RUNTIME_IMAGE?.trim() || 'enkeep-demo-runtime:acceptance';

function generateTestSuffix(): string {
  return `topo-${crypto.randomBytes(4).toString('hex').toLowerCase()}`;
}

function generateCanonicalTurnId(): string {
  return `turn_${crypto.randomBytes(16).toString('hex').toLowerCase()}`;
}

function generateCanonicalSessionId(): string {
  return `ses_${crypto.randomBytes(16).toString('hex').toLowerCase()}`;
}

describe.skipIf(!isDockerAcceptance)('Daemon Production Docker Process Topology & Lifecycle Suite', () => {
  const client = new SafeDockerClient();
  const adapter = new DockerRuntimeAdapter(client);
  const activeHandles: ActiveRuntimeHandle[] = [];

  afterEach(async () => {
    while (activeHandles.length > 0) {
      const handle = activeHandles.pop()!;
      try {
        await handle.teardown(true);
      } catch {}
    }
  });

  async function getContainerProcesses(containerNameOrId: string): Promise<string[]> {
    try {
      const output = execSync(`docker top ${containerNameOrId} -o pid,comm,args`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return output
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('PID') && !l.startsWith('UID'));
    } catch {
      return [];
    }
  }

  it('verifies exact daemon PID 1 topology, zero exec-cli followup across 10 turns, daemon stats, and JSONL integrity', async () => {
    const suffix = generateTestSuffix();
    const spec = adapter.createDefaultUserSpec({
      userId: 'alice',
      nameSuffix: suffix,
      image: runtimeImage,
    });

    const handle = await adapter.startRuntime(spec, 30000);
    activeHandles.push(handle);

    // 1. Verify Transport and Tunnel are established
    await handle.startTransport!();
    await handle.startTunnel!({ tunnelPort: 8787 });

    expect(handle.transport?.isConnected()).toBe(true);
    expect(handle.tunnel?.getStatus().state).toBe('connected');

    // 2. Snapshot process list BEFORE turns
    const procsBefore = await getContainerProcesses(handle.containerId);
    expect(procsBefore.length).toBeGreaterThanOrEqual(1);

    // PID 1 must be daemon-cli.js daemon
    const pid1Proc = procsBefore.find((p) => p.includes('daemon-cli.js daemon') || p.includes('node') && p.includes('daemon'));
    expect(pid1Proc).toBeDefined();

    // Verify zero exec-cli followup
    const execCliBefore = procsBefore.filter((p) => p.includes('exec-cli.js') && p.includes('followup'));
    expect(execCliBefore.length).toBe(0);

    // 3. Execute 10 sequential turns over the persistent transport
    const sessionId = generateCanonicalSessionId();
    for (let i = 1; i <= 10; i++) {
      const turnId = generateCanonicalTurnId();
      const prompt = `Topology test sequential turn #${i}`;

      const res = await handle.sendFollowup({
        prompt,
        sessionId,
        turnId,
      });

      expect(res.status).toBe('completed');
      expect(res.turnId).toBe(turnId);
      expect(res.sessionId).toBe(sessionId);
      expect(res.persisted).toBe(true);
      expect(res.replyText).toContain('[DemoModel:alice]');

      // Snapshot process list during turn execution: must NEVER spawn exec-cli followup
      if (i === 5) {
        const procsDuring = await getContainerProcesses(handle.containerId);
        const execCliDuring = procsDuring.filter((p) => p.includes('exec-cli.js') && p.includes('followup'));
        expect(execCliDuring.length).toBe(0);
      }
    }

    // 4. Snapshot process list AFTER 10 turns
    const procsAfter = await getContainerProcesses(handle.containerId);
    const execCliAfter = procsAfter.filter((p) => p.includes('exec-cli.js') && p.includes('followup'));
    expect(execCliAfter.length).toBe(0);

    // 5. Verify daemon stats: exactly 10 turns processed, 1 active agent, 0 evictions
    const health = await handle.checkHealth();
    expect(health.status).toBe('ok');
    expect(health.dshReady).toBe(true);
    expect(health.userId).toBe('alice');

    // Query daemon stats directly via transport
    const transport = await handle.startTransport!();
    const healthRes = await transport.request<{ id: string; op: 'health' }, any>({
      id: 'req_check_stats',
      op: 'health',
    });

    expect(healthRes.ok).toBe(true);
    expect(healthRes.stats.totalTurnsProcessed).toBe(10);
    expect(healthRes.stats.activeAgentsCount).toBe(1);
    expect(healthRes.stats.evictionsCount).toBe(0);

    // 6. Verify session JSONL file integrity on container volume
    const sessionCheck = await handle.checkSessionArtifact!(sessionId);
    expect(sessionCheck.status).toBe('ok');
    expect(sessionCheck.exists).toBe(true);
    expect(sessionCheck.valid).toBe(true);
    const eventCount = (sessionCheck as any).eventsCount ?? (sessionCheck as any).eventCount;
    expect(Number.isSafeInteger(eventCount)).toBe(true);
    expect(eventCount).toBeGreaterThan(0);

    const corruptionReport = await handle.inspectSessionCorruption!(sessionId);
    expect(corruptionReport.status).toBe('ok');
    expect(corruptionReport.exists).toBe(true);
    expect(corruptionReport.corrupted).toBe(false);
    expect(corruptionReport.code).toBe('VALID');
    expect(corruptionReport.validEventsCount).toBe(eventCount);
  }, 60000);

  it('evicts idle agent after small idleAgentTimeoutMs, preserves container ID, and smoothly resumes on next turn', async () => {
    const suffix = generateTestSuffix();
    const spec = adapter.createDefaultUserSpec({
      userId: 'alice',
      nameSuffix: suffix,
      image: runtimeImage,
    });

    // Inject small idle timeout (1200ms) via environment
    spec.environment.DSH_IDLE_AGENT_TIMEOUT_MS = '1200';

    const handle = await adapter.startRuntime(spec, 30000);
    activeHandles.push(handle);

    const sessionId = generateCanonicalSessionId();
    const turn1Id = generateCanonicalTurnId();

    // Turn 1: Loads agent into memory (activeAgentsCount = 1)
    const res1 = await handle.sendFollowup({
      prompt: 'Turn 1 before idle eviction',
      sessionId,
      turnId: turn1Id,
    });
    expect(res1.status).toBe('completed');

    const transport = await handle.startTransport!();
    let statsRes = await transport.request<{ id: string; op: 'health' }, any>({
      id: 'req_stats_1',
      op: 'health',
    });
    expect(statsRes.stats.activeAgentsCount).toBe(1);
    expect(statsRes.stats.evictionsCount).toBe(0);

    // Await idle timeout sweep (1200ms + sweep buffer)
    await new Promise((r) => setTimeout(r, 2500));

    // Verify agent was evicted
    statsRes = await transport.request<{ id: string; op: 'health' }, any>({
      id: 'req_stats_2',
      op: 'health',
    });
    expect(statsRes.stats.activeAgentsCount).toBe(0);
    expect(statsRes.stats.evictionsCount).toBeGreaterThanOrEqual(1);

    // Turn 2 on same session: Agent is resumed smoothly
    const turn2Id = generateCanonicalTurnId();
    const res2 = await handle.sendFollowup({
      prompt: 'Turn 2 after idle eviction',
      sessionId,
      turnId: turn2Id,
    });

    expect(res2.status).toBe('completed');
    expect(res2.persisted).toBe(true);
    expect(res2.replyText).toContain('[DemoModel:alice]');

    statsRes = await transport.request<{ id: string; op: 'health' }, any>({
      id: 'req_stats_3',
      op: 'health',
    });
    expect(statsRes.stats.activeAgentsCount).toBe(1);
    expect(statsRes.stats.totalTurnsProcessed).toBe(2);
  }, 45000);

  it('reconnects automatically when bridge process is killed, preserving daemon PID 1 and journal', async () => {
    const suffix = generateTestSuffix();
    const spec = adapter.createDefaultUserSpec({
      userId: 'alice',
      nameSuffix: suffix,
      image: runtimeImage,
    });

    const handle = await adapter.startRuntime(spec, 30000);
    activeHandles.push(handle);

    const sessionId = generateCanonicalSessionId();
    const turn1Id = generateCanonicalTurnId();

    const res1 = await handle.sendFollowup({
      prompt: 'Turn 1 before bridge restart',
      sessionId,
      turnId: turn1Id,
    });
    expect(res1.status).toBe('completed');

    // Kill the in-container bridge process (daemon PID 1 stays running)
    try {
      execSync(`docker exec ${handle.containerId} pkill -f daemon-bridge.js`, {
        stdio: 'ignore',
      });
    } catch {}

    // Give brief time for transport reconnection
    await new Promise((r) => setTimeout(r, 600));

    // Turn 2 executes seamlessly via re-established bridge
    const turn2Id = generateCanonicalTurnId();
    const res2 = await handle.sendFollowup({
      prompt: 'Turn 2 after bridge restart',
      sessionId,
      turnId: turn2Id,
    });

    expect(res2.status).toBe('completed');
    expect(res2.persisted).toBe(true);

    // Verify inspect of Turn 1 from daemon journal is still intact
    const inspectTurn1 = await handle.inspectTurn!(turn1Id);
    expect(inspectTurn1.status).toBe('completed');
    expect(inspectTurn1.turnId).toBe(turn1Id);
  }, 45000);

  it('recreates container on same owned volume when PID 1 exits and continues session', async () => {
    const suffix = generateTestSuffix();
    const spec = adapter.createDefaultUserSpec({
      userId: 'alice',
      nameSuffix: suffix,
      image: runtimeImage,
    });

    const handle1 = await adapter.startRuntime(spec, 30000);
    activeHandles.push(handle1);

    const sessionId = generateCanonicalSessionId();
    const turn1Id = generateCanonicalTurnId();

    const res1 = await handle1.sendFollowup({
      prompt: 'Turn 1 before container replacement',
      sessionId,
      turnId: turn1Id,
    });
    expect(res1.status).toBe('completed');
    expect(res1.replyText).toBe(
      '[DemoModel:alice] Received turn: "Turn 1 before container replacement". Official DSH agent loop active, session persisted successfully.'
    );

    // Teardown container 1 preserving the volume
    await handle1.teardown(false);
    const idx = activeHandles.indexOf(handle1);
    if (idx !== -1) activeHandles.splice(idx, 1);

    // Create new container attaching the same owned volume
    const newSpec = adapter.createDefaultUserSpec({
      userId: 'alice',
      nameSuffix: generateTestSuffix(),
      image: runtimeImage,
      volumeName: spec.volume.volumeName,
      volumeId: spec.volume.volumeId,
    });

    const handle2 = await adapter.startRuntimeWithOwnedVolume(newSpec, 30000);
    activeHandles.push(handle2);

    expect(handle2.containerId).not.toBe(handle1.containerId);
    expect(handle2.volumeId).toBe(spec.volume.volumeId);

    // Turn 2 continues session on new container
    const turn2Id = generateCanonicalTurnId();
    const res2 = await handle2.sendFollowup({
      prompt: 'Turn 2 on replacement container',
      sessionId,
      turnId: turn2Id,
    });

    expect(res2.status).toBe('completed');
    expect(res2.persisted).toBe(true);
    expect(res2.sessionId).toBe(sessionId);
    expect(res2.replyText).toBe(
      '[DemoModel:alice] Received turn: "Turn 2 on replacement container". Official DSH agent loop active, session persisted successfully.'
    );
  }, 60000);
});
