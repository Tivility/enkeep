/**
 * Host Runtime Crash & Restart Recovery Tests
 *
 * Verifies Requirement 5:
 * 1. Crash child daemon PID via SIGKILL during/after turns.
 * 2. Platform restart reconnects to the host runtime and recovers turn journal.
 * 3. Subsequent turns continue seamlessly with contiguous sequence numbers and NO duplicate turns.
 *
 * @module @enkeep/demo-runner/tests/host-crash-recovery.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resetDemo } from '../src/reset/index.js';
import { launchDemoSystem, type RunningDemoSystem } from '../src/up/index.js';
import { HostRuntimePortAdapter } from '../src/ports/index.js';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';
import { FakeUnitRuntimeContainerAdapter } from './support/fake-runtime.js';
import { isProcessAlive } from '@enkeep/runtime-runner';

describe('Host Runtime Crash & Restart Journal Recovery', () => {
  let tempRepo: TempRepo;
  let system: RunningDemoSystem | null = null;

  beforeEach(() => {
    tempRepo = createTempRepo();
  });

  afterEach(async () => {
    if (system) {
      try {
        await system.close({ removeVolumes: true });
      } catch {}
      system = null;
    }
    tempRepo.cleanup();
  });

  it('recovers cleanly after child PID SIGKILL crash with zero duplicate turns and intact JSONL history', async () => {
    // 1. Reset demo environment
    const resetResult = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      forceClean: true,
    });
    expect(resetResult.ok).toBe(true);

    const fakeContainerAdapter = new FakeUnitRuntimeContainerAdapter();
    const hostAdapter = new HostRuntimePortAdapter();

    // 2. Launch demo system
    system = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      runtimeAdapter: fakeContainerAdapter,
      hostRuntimeAdapter: hostAdapter,
      allowHostRuntime: true,
      llmEnabled: false,
    });

    const aliceUser = await system.storage.users.findByUsername('alice');
    expect(aliceUser).not.toBeNull();
    const aliceId = aliceUser!.id;

    // 3. Create Host Space & Session
    const aliceHostSpace = await system.createHostSpace(aliceId, {
      name: 'Alice Crash Test Space',
      folder: 'alice-crash-space',
    });

    const hostSession = await system.createHostSession(aliceId, {
      spaceId: aliceHostSpace.id,
      title: 'Alice Crash Test Session',
    });

    // Helper to dispatch inbound message with canonical deliveryId and await delivered assistant reply
    async function dispatchAndWait(content: string): Promise<string> {
      const beforeCount = (system!.database.prepare(
        "SELECT COUNT(*) as c FROM web_messages WHERE session_id = ? AND user_id = ? AND role = 'assistant' AND status = 'delivered'"
      ).get(hostSession.id, aliceId) as { c: number }).c;

      const deliveryId = `deliv_${randomBytes(16).toString('hex').toLowerCase()}`;

      const dispatchRes = await system!.platformServer.runtimeGateway.dispatchInbound({
        id: deliveryId,
        userId: aliceId,
        sessionId: hostSession.id,
        channel: 'web',
        nativeContextId: hostSession.id,
        content,
        role: 'user',
        timestamp: new Date().toISOString(),
      });
      expect(dispatchRes.accepted).toBe(true);

      const start = Date.now();
      while (Date.now() - start < 15000) {
        const rows = system!.database.prepare(
          "SELECT content FROM web_messages WHERE session_id = ? AND user_id = ? AND role = 'assistant' AND status = 'delivered' ORDER BY created_at DESC"
        ).all(hostSession.id, aliceId) as Array<{ content: string }>;
        if (rows.length > beforeCount && rows[0]?.content) {
          return rows[0].content;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`Turn "${deliveryId}" timed out waiting for assistant reply`);
    }

    // 4. Execute Turn 1 before crash
    const reply1 = await dispatchAndWait('Pre-crash Turn 1: Initialization');
    expect(reply1).toBeDefined();

    // 5. Inspect the running host daemon child PID from process.meta.json
    const userHostRoot = join(tempRepo.repoRoot, '.demo-data', 'host-runtimes', 'alice');
    const metaPath = join(userHostRoot, 'run', 'process.meta.json');
    expect(existsSync(metaPath)).toBe(true);

    const procMeta = JSON.parse(readFileSync(metaPath, 'utf8'));
    const childPid = procMeta.pid;
    expect(childPid).toBeGreaterThan(0);
    expect(isProcessAlive(childPid)).toBe(true);

    // 6. Hard Crash: kill child process with SIGKILL
    process.kill(childPid, 'SIGKILL');

    // Wait briefly for process to terminate
    let dead = false;
    for (let i = 0; i < 50; i++) {
      if (!isProcessAlive(childPid)) {
        dead = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(dead).toBe(true);

    // 7. Restart runtime through system management provider
    const restartRes = await system.restartRuntime(aliceId);
    expect(restartRes.restarted).toBe(true);
    expect(restartRes.appliedRuntimes).toContain(`${aliceId}-host`);

    // Verify fresh child PID was spawned and recorded
    const newProcMeta = JSON.parse(readFileSync(metaPath, 'utf8'));
    expect(newProcMeta.pid).toBeGreaterThan(0);
    expect(newProcMeta.pid).not.toBe(childPid);
    expect(isProcessAlive(newProcMeta.pid)).toBe(true);

    // 8. Execute Turn 2 after crash and restart
    const reply2 = await dispatchAndWait('Post-crash Turn 2: Recovery confirmation');
    expect(reply2).toBeDefined();

    // 9. Verify Session History and Event Integrity:
    // - Exactly 2 assistant replies and 2 user messages
    const allMsgs = system.database.prepare(
      'SELECT role, content, status FROM web_messages WHERE session_id = ? AND user_id = ? ORDER BY created_at ASC'
    ).all(hostSession.id, aliceId) as Array<{ role: string; content: string; status: string }>;

    expect(allMsgs).toHaveLength(4);
    expect(allMsgs[0].role).toBe('user');
    expect(allMsgs[0].content).toBe('Pre-crash Turn 1: Initialization');
    expect(allMsgs[1].role).toBe('assistant');
    expect(allMsgs[2].role).toBe('user');
    expect(allMsgs[2].content).toBe('Post-crash Turn 2: Recovery confirmation');
    expect(allMsgs[3].role).toBe('assistant');

    // - Turn runs table has exactly 2 completed turn records, ZERO duplicates
    const turnRuns = system.database.prepare(
      "SELECT turn_id, status, execution_mode FROM turn_runs WHERE route_id = ? AND status = 'completed'"
    ).all(hostSession.id) as Array<{ turn_id: string; status: string; execution_mode: string }>;

    expect(turnRuns).toHaveLength(2);
    expect(turnRuns[0].execution_mode).toBe('host');
    expect(turnRuns[1].execution_mode).toBe('host');

    // - Check JSONL session log file
    const sessionsDir = join(userHostRoot, '.dsh', 'sessions');
    const jsonlFiles = readdirSync(sessionsDir, { recursive: true })
      .filter((f) => String(f).endsWith('.jsonl'));
    expect(jsonlFiles.length).toBeGreaterThanOrEqual(1);

    const logPath = join(sessionsDir, String(jsonlFiles[0]));
    const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    const parsedEvents = lines.map((l) => JSON.parse(l));

    // Contiguous event sequence numbers (monotonic seq)
    const seqEvents = parsedEvents.filter((e) => typeof e.seq === 'number' || typeof e.seq0 === 'number');
    expect(seqEvents.length).toBeGreaterThanOrEqual(10);
    for (let i = 1; i < seqEvents.length; i++) {
      const prev = typeof seqEvents[i - 1].seq === 'number' ? seqEvents[i - 1].seq : seqEvents[i - 1].seq0;
      const curr = typeof seqEvents[i].seq === 'number' ? seqEvents[i].seq : seqEvents[i].seq0;
      expect(curr).toBeGreaterThan(prev);
    }
  });

  it('kills resident PID during in-flight turn: settles promise bounded, marks failed, and next turn recreates daemon', async () => {
    // 1. Reset demo environment
    const resetResult = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      forceClean: true,
    });
    expect(resetResult.ok).toBe(true);

    const fakeContainerAdapter = new FakeUnitRuntimeContainerAdapter();
    const hostAdapter = new HostRuntimePortAdapter();

    // 2. Launch demo system
    system = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      runtimeAdapter: fakeContainerAdapter,
      hostRuntimeAdapter: hostAdapter,
      allowHostRuntime: true,
      llmEnabled: false,
    });

    const aliceUser = await system.storage.users.findByUsername('alice');
    expect(aliceUser).not.toBeNull();
    const aliceId = aliceUser!.id;

    // 3. Create Host Space & Session
    const aliceHostSpace = await system.createHostSpace(aliceId, {
      name: 'Alice Inflight Crash Space',
      folder: 'alice-inflight-crash-space',
    });

    const hostSession = await system.createHostSession(aliceId, {
      spaceId: aliceHostSpace.id,
      title: 'Alice Inflight Crash Session',
    });

    // Helper to dispatch inbound message with canonical deliveryId and await delivered assistant reply
    async function dispatchAndWait(content: string): Promise<string> {
      const beforeCount = (system!.database.prepare(
        "SELECT COUNT(*) as c FROM web_messages WHERE session_id = ? AND user_id = ? AND role = 'assistant' AND status = 'delivered'"
      ).get(hostSession.id, aliceId) as { c: number }).c;

      const deliveryId = `deliv_${randomBytes(16).toString('hex').toLowerCase()}`;

      const dispatchRes = await system!.platformServer.runtimeGateway.dispatchInbound({
        id: deliveryId,
        userId: aliceId,
        sessionId: hostSession.id,
        channel: 'web',
        nativeContextId: hostSession.id,
        content,
        role: 'user',
        timestamp: new Date().toISOString(),
      });
      expect(dispatchRes.accepted).toBe(true);

      const start = Date.now();
      while (Date.now() - start < 15000) {
        const rows = system!.database.prepare(
          "SELECT content FROM web_messages WHERE session_id = ? AND user_id = ? AND role = 'assistant' AND status = 'delivered' ORDER BY created_at DESC"
        ).all(hostSession.id, aliceId) as Array<{ content: string }>;
        if (rows.length > beforeCount && rows[0]?.content) {
          return rows[0].content;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`Turn "${deliveryId}" timed out waiting for assistant reply`);
    }

    // 4. Execute Turn 1 to initialize host daemon
    const reply1 = await dispatchAndWait('Turn 1: Warmup host daemon');
    expect(reply1).toBeDefined();

    // 5. Inspect resident host daemon child PID
    const userHostRoot = join(tempRepo.repoRoot, '.demo-data', 'host-runtimes', 'alice');
    const metaPath = join(userHostRoot, 'run', 'process.meta.json');
    expect(existsSync(metaPath)).toBe(true);

    const procMeta = JSON.parse(readFileSync(metaPath, 'utf8'));
    const initialPid = procMeta.pid;
    expect(initialPid).toBeGreaterThan(0);
    expect(isProcessAlive(initialPid)).toBe(true);

    // 6. Dispatch Turn 2 and immediately kill daemon PID while turn is in-flight
    const turn2DeliveryId = `deliv_${randomBytes(16).toString('hex').toLowerCase()}`;
    const dispatch2Res = await system.platformServer.runtimeGateway.dispatchInbound({
      id: turn2DeliveryId,
      userId: aliceId,
      sessionId: hostSession.id,
      channel: 'web',
      nativeContextId: hostSession.id,
      content: 'Turn 2: In-flight turn doomed by SIGKILL',
      role: 'user',
      timestamp: new Date().toISOString(),
    });
    expect(dispatch2Res.accepted).toBe(true);

    // Kill the daemon PID immediately during turn execution
    process.kill(initialPid, 'SIGKILL');

    // 7. Verify the in-flight turn settles boundedly (not stuck in running)
    const settleStart = Date.now();
    let turn2Settled = false;
    while (Date.now() - settleStart < 8000) {
      const runningCount = (system.database.prepare(
        "SELECT COUNT(*) as c FROM turn_runs WHERE route_id = ? AND status = 'running'"
      ).get(hostSession.id) as { c: number }).c;

      const userMsg = system.database.prepare(
        "SELECT status FROM web_messages WHERE session_id = ? AND user_id = ? AND content LIKE 'Turn 2:%'"
      ).get(hostSession.id, aliceId) as { status: string } | undefined;

      if (runningCount === 0 && userMsg?.status === 'failed') {
        turn2Settled = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(turn2Settled).toBe(true);

    // Verify no active leases remain
    const activeLeaseCount = (system.database.prepare(
      "SELECT COUNT(*) as c FROM session_execution_leases WHERE route_id = ? AND status = 'active'"
    ).get(hostSession.id) as { c: number }).c;
    expect(activeLeaseCount).toBe(0);

    // 8. Send Turn 3: should auto-recreate fresh host daemon without manual restart and complete
    const reply3 = await dispatchAndWait('Turn 3: Post-kill automatic daemon recreate');
    expect(reply3).toBeDefined();

    // Verify a fresh host daemon process was created with a new PID
    const newProcMeta = JSON.parse(readFileSync(metaPath, 'utf8'));
    expect(newProcMeta.pid).toBeGreaterThan(0);
    expect(newProcMeta.pid).not.toBe(initialPid);
    expect(isProcessAlive(newProcMeta.pid)).toBe(true);

    // Verify turn_runs status history
    const completedTurns = system.database.prepare(
      "SELECT turn_id, status FROM turn_runs WHERE route_id = ? AND status = 'completed'"
    ).all(hostSession.id) as Array<{ turn_id: string; status: string }>;
    expect(completedTurns).toHaveLength(2); // Turn 1 and Turn 3

    const failedTurns = system.database.prepare(
      "SELECT turn_id, status FROM turn_runs WHERE route_id = ? AND status = 'failed'"
    ).all(hostSession.id) as Array<{ turn_id: string; status: string }>;
    expect(failedTurns).toHaveLength(1); // Turn 2
  });
});
