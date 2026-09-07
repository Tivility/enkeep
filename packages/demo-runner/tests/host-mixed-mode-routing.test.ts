/**
 * Mixed User Mode Routing & Isolation Tests
 *
 * Verifies Requirement 4:
 * 1. Alice Docker existing session and Host session run in parallel with ZERO crosstalk.
 * 2. Management overview (`listRuntimes()`) reflects both container and host execution modes.
 * 3. Bob Docker session executes concurrently without interference.
 *
 * @module @enkeep/demo-runner/tests/host-mixed-mode-routing.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resetDemo } from '../src/reset/index.js';
import { launchDemoSystem, type RunningDemoSystem } from '../src/up/index.js';
import { HostRuntimePortAdapter } from '../src/ports/index.js';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';
import { FakeUnitRuntimeContainerAdapter } from './support/fake-runtime.js';

describe('Mixed Mode Execution & Parallel Routing (Container + Host)', () => {
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

  it('routes Alice Docker container turns and Host turns in parallel with zero crosstalk and management visibility', async () => {
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
    const bobUser = await system.storage.users.findByUsername('bob');
    expect(aliceUser).not.toBeNull();
    expect(bobUser).not.toBeNull();
    const aliceId = aliceUser!.id;
    const bobId = bobUser!.id;

    // 3. Get existing Alice Docker Container Session
    const aliceContainerRoutes = await system.storage.forTenant(aliceId).sessionRoutes.list();
    expect(aliceContainerRoutes.length).toBeGreaterThanOrEqual(1);
    const aliceDockerSession = aliceContainerRoutes[0]!;
    expect(aliceDockerSession.executionMode).toBe('container');

    // 4. Create Alice Host Space and Host Session
    const aliceHostSpace = await system.createHostSpace(aliceId, {
      name: 'Alice Mixed Mode Host Space',
      folder: 'alice-mixed-host-space',
    });
    expect(aliceHostSpace.executionMode).toBe('host');

    const aliceHostSession = await system.createHostSession(aliceId, {
      spaceId: aliceHostSpace.id,
      title: 'Alice Mixed Mode Host Session',
    });
    expect(aliceHostSession.executionMode).toBe('host');

    // 5. Create Bob Docker Session in Bob Container Space
    const bobSpaces = await system.storage.forTenant(bobId).spaces.list();
    expect(bobSpaces.length).toBeGreaterThanOrEqual(1);
    const bobContainerSpace = bobSpaces[0]!;

    const bobDockerSession = await system.storage.forTenant(bobId).sessionRoutes.create({
      spaceId: bobContainerSpace.id,
      channel: 'web',
      nativeContextId: `bob-peer-${randomBytes(8).toString('hex')}`,
      peerId: `bob-peer-${randomBytes(8).toString('hex')}`,
      dshSessionId: `ses_${randomBytes(16).toString('hex').toLowerCase()}`,
      title: 'Bob Docker Session',
    });
    expect(bobDockerSession).toBeDefined();

    // Helper to dispatch inbound message with canonical deliveryId and await delivered assistant reply
    async function dispatchAndWait(sessionId: string, userId: string, content: string): Promise<string> {
      const beforeCount = (system!.database.prepare(
        "SELECT COUNT(*) as c FROM web_messages WHERE session_id = ? AND user_id = ? AND role = 'assistant' AND status = 'delivered'"
      ).get(sessionId, userId) as { c: number }).c;

      const deliveryId = `deliv_${randomBytes(16).toString('hex').toLowerCase()}`;

      const dispatchRes = await system!.platformServer.runtimeGateway.dispatchInbound({
        id: deliveryId,
        userId,
        sessionId,
        channel: 'web',
        nativeContextId: sessionId,
        content,
        role: 'user',
        timestamp: new Date().toISOString(),
      });
      expect(dispatchRes.accepted).toBe(true);

      const start = Date.now();
      while (Date.now() - start < 15000) {
        const rows = system!.database.prepare(
          "SELECT content FROM web_messages WHERE session_id = ? AND user_id = ? AND role = 'assistant' AND status = 'delivered' ORDER BY created_at DESC"
        ).all(sessionId, userId) as Array<{ content: string }>;
        if (rows.length > beforeCount && rows[0]?.content) {
          return rows[0].content;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`Turn "${deliveryId}" for session "${sessionId}" timed out`);
    }

    // 6. Execute parallel turns across Alice Container, Alice Host, and Bob Container
    const [aliceDockerReply, aliceHostReply, bobDockerReply] = await Promise.all([
      dispatchAndWait(aliceDockerSession.id, aliceId, 'Alice Docker Turn: checking container environment'),
      dispatchAndWait(aliceHostSession.id, aliceId, 'Alice Host Turn: checking host environment'),
      dispatchAndWait(bobDockerSession.id, bobId, 'Bob Docker Turn: checking isolated user session'),
    ]);

    expect(aliceDockerReply).toBeDefined();
    expect(aliceDockerReply.length).toBeGreaterThan(0);

    expect(aliceHostReply).toBeDefined();
    expect(aliceHostReply.length).toBeGreaterThan(0);

    expect(bobDockerReply).toBeDefined();
    expect(bobDockerReply.length).toBeGreaterThan(0);

    // 7. Verify Zero Crosstalk:
    // - Alice Host messages belong exclusively to Alice Host session
    const aliceHostMsgs = system.database.prepare(
      'SELECT id, role, content FROM web_messages WHERE session_id = ? AND user_id = ?'
    ).all(aliceHostSession.id, aliceId) as Array<{ id: string; role: string; content: string }>;
    expect(aliceHostMsgs.some((m) => m.content.includes('Alice Host Turn'))).toBe(true);
    expect(aliceHostMsgs.some((m) => m.content.includes('Alice Docker Turn'))).toBe(false);
    expect(aliceHostMsgs.some((m) => m.content.includes('Bob Docker Turn'))).toBe(false);

    // - Alice Docker messages belong exclusively to Alice Docker session
    const aliceDockerMsgs = system.database.prepare(
      'SELECT id, role, content FROM web_messages WHERE session_id = ? AND user_id = ?'
    ).all(aliceDockerSession.id, aliceId) as Array<{ id: string; role: string; content: string }>;
    expect(aliceDockerMsgs.some((m) => m.content.includes('Alice Docker Turn'))).toBe(true);
    expect(aliceDockerMsgs.some((m) => m.content.includes('Alice Host Turn'))).toBe(false);

    // - Bob Docker messages belong exclusively to Bob Docker session
    const bobDockerMsgs = system.database.prepare(
      'SELECT id, role, content FROM web_messages WHERE session_id = ? AND user_id = ?'
    ).all(bobDockerSession.id, bobId) as Array<{ id: string; role: string; content: string }>;
    expect(bobDockerMsgs.some((m) => m.content.includes('Bob Docker Turn'))).toBe(true);
    expect(bobDockerMsgs.some((m) => m.content.includes('Alice'))).toBe(false);

    // 8. Verify Management Provider lists both Alice Container and Alice Host runtimes
    const mgmtProvider = system.managementProvider;
    expect(mgmtProvider).toBeDefined();

    const activeRuntimes = await mgmtProvider!.listRuntimes();
    expect(activeRuntimes.length).toBeGreaterThanOrEqual(2);

    const userIds = activeRuntimes.map((r) => r.userId);
    expect(userIds).toContain(aliceId); // Container runtime
    expect(userIds).toContain(`${aliceId}-host`); // Host runtime

    const aliceHostStatus = activeRuntimes.find((r) => r.userId === `${aliceId}-host`);
    expect(aliceHostStatus).toBeDefined();
    expect(aliceHostStatus!.status).toBe('ok');
    expect(aliceHostStatus!.dshReady).toBe(true);
  });
});
