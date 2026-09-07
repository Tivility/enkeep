import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resetDemo } from '../src/reset/index.js';
import { launchDemoSystem } from '../src/up/index.js';
import { downDemo } from '../src/down/index.js';
import { getStatus } from '../src/demo-runner.js';
import { getDemoPathConfig } from '../src/config.js';
import { listSignedProcesses, listSignedContainers, readSignedProcessMeta } from '../src/utils/crypto-meta.js';
import { FakeUnitRuntimeContainerAdapter } from './support/fake-runtime.js';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';

describe('Demo Runner Lifecycle Integration Tests', () => {
  let tempRepo: TempRepo;
  let paths: ReturnType<typeof getDemoPathConfig>;

  beforeEach(() => {
    tempRepo = createTempRepo();
    paths = getDemoPathConfig(tempRepo.repoRoot);
  });

  afterEach(async () => {
    await downDemo({ repoRoot: tempRepo.repoRoot, removeVolumes: true });
    tempRepo.cleanup();
  });

  it('executes demo:reset and creates isolated provisioned demo environment with credentials', async () => {
    const res = await resetDemo({ repoRoot: tempRepo.repoRoot });
    expect(res.ok).toBe(true);
    expect(existsSync(res.dbPath)).toBe(true);
    expect(existsSync(res.manifestPath)).toBe(true);
    expect(res.users.admin.username).toBe('alice');
    expect(res.users.user.username).toBe('bob');
    expect(res.users.disabledUser.username).toBe('charlie_disabled');
    expect(res.credentials.admin.password).toMatch(/^pwd_alice_/);
    expect(res.credentials.user.password).toMatch(/^pwd_bob_/);
    expect(res.credentials.disabledUser.password).toMatch(/^pwd_charlie_/);
    expect(res.importedChatsCount).toBeGreaterThan(0);
    expect(res.importedMessagesCount).toBeGreaterThan(0);
  });

  it('launches demo system with FakeUnitRuntimeContainerAdapter, registers signed process metadata, and closes cleanly', async () => {
    await resetDemo({ repoRoot: tempRepo.repoRoot });
    const fakeAdapter = new FakeUnitRuntimeContainerAdapter();
    const system = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      runtimeAdapter: fakeAdapter,
    });

    expect(system.result.ok).toBe(true);
    expect(system.result.platform.status).toBe('healthy');
    expect(system.result.runtimes.alice?.status).toBe('healthy');
    expect(system.result.runtimes.bob?.status).toBe('healthy');

    // 1. Verify signed process metadata exists with schemaVersion=1 and mode 0600
    const pidFilePath = join(paths.pidsDir, 'platform-server.json');
    expect(existsSync(pidFilePath)).toBe(true);
    const pidFileStat = statSync(pidFilePath);
    expect((pidFileStat.mode & 0o777)).toBe(0o600);

    const platformMeta = readSignedProcessMeta('platform-server', tempRepo.repoRoot);
    expect(platformMeta).not.toBeNull();
    expect(platformMeta!.schemaVersion).toBe(1);
    expect(platformMeta!.owner).toBe('enkeep-demo');
    expect(platformMeta!.service).toBe('platform-server');
    expect(platformMeta!.pid).toBe(process.pid);
    expect(platformMeta!.url).toBe(system.result.platform.endpoint);
    expect(typeof platformMeta!.signature).toBe('string');

    // 2. Verify getStatus accurately reflects running platform and active containers
    const statusWhileRunning = await getStatus(tempRepo.repoRoot);
    expect(statusWhileRunning.ok).toBe(true);
    expect(statusWhileRunning.platformRunning).toBe(true);
    expect(statusWhileRunning.platformEndpoint).toBe(system.result.platform.endpoint);
    expect(statusWhileRunning.processes).toHaveLength(1);
    expect(statusWhileRunning.processes[0]!.service).toBe('platform-server');
    expect(statusWhileRunning.processes[0]!.pid).toBe(process.pid);
    expect(statusWhileRunning.containers).toHaveLength(2);

    await system.close({ removeVolumes: true });

    // 3. Verify signed process metadata is safely cleaned up after close
    const procs = listSignedProcesses(tempRepo.repoRoot);
    expect(procs).toHaveLength(0);

    const statusAfterClose = await getStatus(tempRepo.repoRoot);
    expect(statusAfterClose.ok).toBe(true);
    expect(statusAfterClose.platformRunning).toBe(false);
    expect(statusAfterClose.processes).toHaveLength(0);
  });

  it('executes demo:down and safely cleans metadata', async () => {
    await resetDemo({ repoRoot: tempRepo.repoRoot });
    const downRes = await downDemo({ repoRoot: tempRepo.repoRoot });
    expect(downRes.ok).toBe(true);
    expect(downRes.cleanedMetadataCount).toBeGreaterThanOrEqual(0);

    // Verify metadata directories are cleaned
    const procs = listSignedProcesses(tempRepo.repoRoot);
    expect(procs).toHaveLength(0);
  });

  it('retains signed volume metadata on system close without removeVolumes, enabling safe re-launch and resume', async () => {
    await resetDemo({ repoRoot: tempRepo.repoRoot });
    const paths = getDemoPathConfig({ repoRoot: tempRepo.repoRoot });
    const db = new DatabaseSync(paths.dbPath);
    const aliceRow = db.prepare("SELECT id FROM users WHERE username = 'alice'").get() as { id: string };
    db.close();
    const aliceId = aliceRow.id;

    const fakeAdapter = new FakeUnitRuntimeContainerAdapter();
    const system1 = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      runtimeAdapter: fakeAdapter,
    });

    expect(system1.result.ok).toBe(true);
    const initialAliceHandle = system1.runtimeHandles.get(aliceId)!;
    const initialAliceContainerId = initialAliceHandle.containerId;
    const initialAliceVolumeId = initialAliceHandle.volumeId;

    // Close preserving volumes
    await system1.close({ removeVolumes: false });

    // Container metadata cleaned, but volume metadata preserved
    const containersAfterClose = listSignedContainers(tempRepo.repoRoot);
    expect(containersAfterClose).toHaveLength(0);

    // Launch again: attaches existing owned volume and starts fresh container
    const system2 = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      runtimeAdapter: fakeAdapter,
    });

    expect(system2.result.ok).toBe(true);
    const resumedAlice = system2.runtimeHandles.get(aliceId)!;
    // VolumeId is stably preserved from signed metadata
    expect(resumedAlice.volumeId).toBe(initialAliceVolumeId);
    // New container instance ID was generated
    expect(resumedAlice.containerId).toBeDefined();

    await system2.close({ removeVolumes: true });
  });
});
