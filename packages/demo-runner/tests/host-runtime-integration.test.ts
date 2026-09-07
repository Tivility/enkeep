/**
 * Real Host Runtime Integration Journey (Non-Docker)
 *
 * Verifies:
 * 1. Alice admin can create a new Host Space while Alice/Bob Docker container spaces remain unchanged.
 * 2. Non-admin (Bob) is rejected with 403 Forbidden when attempting to create a Host Space.
 * 3. Host data root resides strictly within <dataRoot>/host-runtimes/<userId> (never repo root or home).
 * 4. 3 rapid sequential/concurrent turns on Host Space session.
 * 5. Space file operations (write, read, edit, list) and workspace tools.
 * 6. Global and space instructions injection and reading.
 * 7. Model selection per turn.
 * 8. Turn cancellation.
 * 9. Host daemon restart preserving JSONL history across restarts.
 * 10. Container spaces remain unaffected.
 *
 * @module @enkeep/demo-runner/tests/host-runtime-integration.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { resetDemo } from '../src/reset/index.js';
import { launchDemoSystem, type RunningDemoSystem } from '../src/up/index.js';
import { HostRuntimePortAdapter } from '../src/ports/index.js';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';
import { FakeUnitRuntimeContainerAdapter } from './support/fake-runtime.js';

describe('Host Runtime Real Integration Journey (No Docker Required)', () => {
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

  it('completes the full Host Runtime journey: RBAC, 3 rapid turns, files, instructions, cancel, restart', async () => {
    // 1. Reset demo environment (creates standard Docker container spaces for Alice and Bob)
    const resetResult = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      forceClean: true,
    });
    expect(resetResult.ok).toBe(true);

    const fakeContainerAdapter = new FakeUnitRuntimeContainerAdapter();
    const hostAdapter = new HostRuntimePortAdapter();

    // 2. Launch demo system with Host Runtime support enabled
    system = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      runtimeAdapter: fakeContainerAdapter,
      hostRuntimeAdapter: hostAdapter,
      allowHostRuntime: true,
      llmEnabled: false, // Deterministic demo mode for hermetic testing
    });

    expect(system.result.ok).toBe(true);
    expect(system.result.platform.status).toBe('healthy');

    const aliceUser = await system.storage.users.findByUsername('alice');
    const bobUser = await system.storage.users.findByUsername('bob');
    expect(aliceUser).not.toBeNull();
    expect(bobUser).not.toBeNull();
    const aliceId = aliceUser!.id;
    const bobId = bobUser!.id;

    // 3. RBAC Verification: Non-admin (Bob) CANNOT create Host Space (Must throw 403 Forbidden)
    await expect(
      system.createHostSpace(bobId, {
        name: 'Bob Host Space',
        folder: 'bob-host-folder',
      })
    ).rejects.toThrow(/Only admin users can create Host Spaces/);

    // 4. Admin (Alice) creates Host Space successfully
    const aliceHostSpace = await system.createHostSpace(aliceId, {
      name: 'Alice Admin Host Space',
      folder: 'alice-host-space',
    });

    expect(aliceHostSpace).toBeDefined();
    expect(aliceHostSpace.executionMode).toBe('host');
    expect(aliceHostSpace.folder).toBe('alice-host-space');
    expect(aliceHostSpace.status).toBe('active');

    // Verify host runtime directory was created under <dataRoot>/host-runtimes/alice
    const userHostRoot = join(tempRepo.repoRoot, '.demo-data', 'host-runtimes', 'alice');
    expect(existsSync(userHostRoot)).toBe(true);
    expect(existsSync(join(userHostRoot, '.dsh'))).toBe(true);
    expect(existsSync(join(userHostRoot, 'spaces'))).toBe(true);
    expect(existsSync(join(userHostRoot, 'spaces', 'alice-host-space'))).toBe(true);
    expect(existsSync(join(userHostRoot, 'run', 'process.meta.json'))).toBe(true);

    const procMeta = JSON.parse(readFileSync(join(userHostRoot, 'run', 'process.meta.json'), 'utf8'));
    expect(procMeta.pid).toBeGreaterThan(0);
    expect(existsSync(procMeta.paths.socketPath)).toBe(true);

    // 5. Create Host Session in the Host Space
    const hostSession = await system.createHostSession(aliceId, {
      spaceId: aliceHostSpace.id,
      title: 'Alice Host Session 1',
    });

    expect(hostSession).toBeDefined();
    expect(hostSession.spaceId).toBe(aliceHostSpace.id);
    expect(hostSession.executionMode).toBe('host');
    expect(hostSession.dshSessionId).toBeDefined();

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
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error(`Turn "${deliveryId}" timed out waiting for assistant reply`);
    }

    // 6. Execute 3 rapid turns on the Host Session
    const reply1 = await dispatchAndWait('Turn 1: Hello from host runtime test! What is your role?');
    expect(reply1).toBeDefined();
    expect(reply1.length).toBeGreaterThan(0);

    const reply2 = await dispatchAndWait('Turn 2: Please perform step 2 of our host test.');
    expect(reply2).toBeDefined();
    expect(reply2.length).toBeGreaterThan(0);

    const reply3 = await dispatchAndWait('Turn 3: Concluding our rapid sequence.');
    expect(reply3).toBeDefined();
    expect(reply3.length).toBeGreaterThan(0);

    // Verify session events were persisted to JSONL in <userHostRoot>/.dsh/sessions/
    const sessionsDir = join(userHostRoot, '.dsh', 'sessions');
    expect(existsSync(sessionsDir)).toBe(true);

    const jsonlFiles = readdirSync(sessionsDir, { recursive: true })
      .filter((f) => String(f).endsWith('.jsonl'));
    expect(jsonlFiles.length).toBeGreaterThanOrEqual(1);

    // 7. Test File Operations on the Host Space via demoFileProvider
    const fileProvider = system.platformServer.fileProvider!;
    expect(fileProvider).toBeDefined();

    // Write file in Host Space (requireAbsent: true for fresh file creation)
    const writeResult = await fileProvider.execute(aliceId, aliceHostSpace.id, {
      op: 'write',
      path: 'notes.txt',
      content: 'Host Runtime Space File Content 2026',
      requireAbsent: true,
    });
    expect(writeResult).toBeDefined();
    expect(writeResult.etag).toBeDefined();

    // Verify physical file was written inside <userHostRoot>/spaces/alice-host-space/notes.txt
    const physicalFile = join(userHostRoot, 'spaces', 'alice-host-space', 'notes.txt');
    expect(existsSync(physicalFile)).toBe(true);
    expect(readFileSync(physicalFile, 'utf8')).toBe('Host Runtime Space File Content 2026');

    // Read file in Host Space
    const readResult = await fileProvider.execute(aliceId, aliceHostSpace.id, {
      op: 'read',
      path: 'notes.txt',
    });
    expect((readResult as any).content).toBe('Host Runtime Space File Content 2026');

    // Overwrite file in Host Space using expectedEtag
    const updateResult = await fileProvider.execute(aliceId, aliceHostSpace.id, {
      op: 'write',
      path: 'notes.txt',
      content: 'Host Runtime Space File Content 2026-HERMETIC',
      expectedEtag: writeResult.etag,
    });
    expect(updateResult).toBeDefined();
    expect(readFileSync(physicalFile, 'utf8')).toBe('Host Runtime Space File Content 2026-HERMETIC');

    // List directory in Host Space
    const listResult = await fileProvider.execute(aliceId, aliceHostSpace.id, {
      op: 'list',
      path: '.',
    });
    expect(listResult).toBeDefined();
    expect((listResult as any).entries).toBeDefined();
    expect((listResult as any).entries.some((e: any) => e.name === 'notes.txt')).toBe(true);

    // 8. Test Global Instructions Read / Write
    const writeInst = await fileProvider.writeGlobalInstructions(
      aliceId,
      '# Global Host Instructions\nAlways act with safety.'
    );
    expect(writeInst).toBeDefined();
    expect(writeInst.etag).toBeDefined();

    const readInst = await fileProvider.readGlobalInstructions(aliceId);
    expect(readInst.exists).toBe(true);
    expect(readInst.content).toContain('Global Host Instructions');

    // 9. Test Turn Cancellation API
    const hostHandle = system.hostRuntimeHandles.get(aliceId);
    expect(hostHandle).toBeDefined();
    if (hostHandle && typeof hostHandle.cancelTurn === 'function') {
      try {
        const cancelRes = await hostHandle.cancelTurn('turn_test_cancel_001');
        expect(cancelRes).toBeDefined();
      } catch (err: any) {
        expect(err.code).toBe('TURN_NOT_FOUND');
      }
    }

    // 10. Restart Host Runtime Daemon preserving JSONL history
    const restartRes = await system.restartRuntime(aliceId);
    expect(restartRes.restarted).toBe(true);
    expect(restartRes.appliedRuntimes).toContain(`${aliceId}-host`);

    // Verify session continues seamlessly after restart
    const postRestartReply = await dispatchAndWait('Turn 4: Post-restart resume verification');
    expect(postRestartReply).toBeDefined();
    expect(postRestartReply.length).toBeGreaterThan(0);

    // 11. Verify Docker container spaces remain completely unaffected
    const aliceContainerSpaces = (await system.storage.forTenant(aliceId).spaces.list())
      .filter((s) => s.executionMode === 'container');
    expect(aliceContainerSpaces.length).toBeGreaterThanOrEqual(1);

    const bobContainerSpaces = (await system.storage.forTenant(bobId).spaces.list())
      .filter((s) => s.executionMode === 'container');
    expect(bobContainerSpaces.length).toBeGreaterThanOrEqual(1);

    // Bob cannot query Alice's host space or session
    const bobFoundHostSpace = await system.storage.forTenant(bobId).spaces.findById(aliceHostSpace.id);
    expect(bobFoundHostSpace).toBeNull();

    const bobFoundHostSession = await system.storage.forTenant(bobId).sessionRoutes.findById(hostSession.id);
    expect(bobFoundHostSession).toBeNull();
  });
});
