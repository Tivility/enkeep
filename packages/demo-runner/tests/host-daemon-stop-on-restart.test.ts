/**
 * A platform restart retains runtime containers but must stop host daemons: their LLM and
 * platform proxy servers live in the platform process and die with it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { resetDemo } from '../src/reset/index.js';
import { launchDemoSystem, type RunningDemoSystem } from '../src/up/index.js';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';
import { FakeUnitRuntimeContainerAdapter } from './support/fake-runtime.js';

class RecordingAdapter extends FakeUnitRuntimeContainerAdapter {
  readonly teardowns: Array<{ userId: string; removeVolume: boolean }> = [];
  override async startUserRuntime(options: Parameters<FakeUnitRuntimeContainerAdapter['startUserRuntime']>[0]) {
    const handle = await super.startUserRuntime(options);
    const original = handle.teardown.bind(handle);
    handle.teardown = async (removeVolume = false) => {
      this.teardowns.push({ userId: String(options.userId), removeVolume });
      await original(removeVolume);
    };
    return handle;
  }
}

describe('platform restart and host daemons', () => {
  let tempRepo: TempRepo | null = null;
  let system: RunningDemoSystem | null = null;

  afterEach(async () => {
    if (system) {
      try {
        await system.close({ removeVolumes: true });
      } catch {}
      system = null;
    }
    tempRepo?.cleanup();
  });

  it('close({ retainContainers: true }) keeps containers but stops host daemons without removing their storage', async () => {
    tempRepo = createTempRepo();
    expect((await resetDemo({ repoRoot: tempRepo.repoRoot, forceClean: true })).ok).toBe(true);

    const containerAdapter = new RecordingAdapter();
    const hostAdapter = new RecordingAdapter();
    system = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      runtimeAdapter: containerAdapter,
      hostRuntimeAdapter: hostAdapter,
      allowHostRuntime: true,
      llmEnabled: false,
    });

    const alice = await system.storage.users.findByUsername('alice');
    const aliceId = alice!.id;
    const hostSpace = await system.createHostSpace(aliceId, { name: 'Host Space', folder: 'alice-restart-host' });
    const hostSession = await system.createHostSession(aliceId, { spaceId: hostSpace.id, title: 'Host Session' });

    await system.platformServer.runtimeGateway.dispatchInbound({
      id: `deliv_${randomBytes(16).toString('hex')}`,
      userId: aliceId,
      sessionId: hostSession.id,
      channel: 'web',
      nativeContextId: hostSession.id,
      content: 'start the host runtime',
      role: 'user',
    } as any);
    const start = Date.now();
    while (Date.now() - start < 15000) {
      const row = system.database
        .prepare("SELECT COUNT(*) AS c FROM web_messages WHERE session_id = ? AND role = 'assistant' AND status = 'delivered'")
        .get(hostSession.id) as { c: number };
      if (row.c > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const running = system;
    system = null;
    await running.close({ removeVolumes: false, retainContainers: true });

    expect(containerAdapter.teardowns).toEqual([]);
    expect(hostAdapter.teardowns.length).toBe(1);
    expect(hostAdapter.teardowns[0].removeVolume).toBe(false);
  });
});
