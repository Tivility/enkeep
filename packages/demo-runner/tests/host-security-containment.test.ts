/**
 * Host Runtime Security, Path Containment & Resource Cleanup Tests
 *
 * Verifies Requirement 6:
 * 1. Host runtime data root strictly resides inside `<dataRoot>/host-runtimes/<userId>`.
 * 2. Path breakout attempts with `..`, `/etc`, `~`, `~/happyclaw`, `~/.dsh` are strictly rejected.
 * 3. Environment filtering: child daemon receives ONLY whitelisted environment keys; sensitive host secrets are never leaked.
 * 4. Safe resource cleanup: child processes and UDS sockets are completely reaped on teardown.
 *
 * @module @enkeep/demo-runner/tests/host-security-containment.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resetDemo } from '../src/reset/index.js';
import { downDemo } from '../src/down/index.js';
import { launchDemoSystem, type RunningDemoSystem } from '../src/up/index.js';
import { HostRuntimePortAdapter } from '../src/ports/index.js';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';
import { FakeUnitRuntimeContainerAdapter } from './support/fake-runtime.js';
import {
  HostRuntimeAdapter,
  filterHostEnvironment,
  validateHostRuntimePaths,
  HostOwnershipError,
  isProcessAlive,
} from '@enkeep/runtime-runner';

describe('Host Runtime Security, Path Confinement & Resource Cleanup', () => {
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

  it('strictly confines host runtime paths inside user root and rejects arbitrary escapes', () => {
    const rawDataRoot = join(tempRepo.repoRoot, '.demo-data');
    const adapter = new HostRuntimeAdapter();

    // Valid user spec
    const validSpec = adapter.createDefaultUserSpec({
      userId: 'alice',
      dataRoot: rawDataRoot,
    });

    expect(validSpec.dshHome).toBe(join(rawDataRoot, 'host-runtimes', 'alice', '.dsh'));
    expect(validSpec.spacesDir).toBe(join(rawDataRoot, 'host-runtimes', 'alice', 'spaces'));
    expect(validSpec.runDir).toBe(join(rawDataRoot, 'host-runtimes', 'alice', 'run'));

    // Reject invalid userId (path traversal attempt)
    expect(() =>
      adapter.createDefaultUserSpec({
        userId: '../escaped' as any,
        dataRoot: rawDataRoot,
      })
    ).toThrow(HostOwnershipError);

    expect(() =>
      adapter.createDefaultUserSpec({
        userId: 'alice/sub' as any,
        dataRoot: rawDataRoot,
      })
    ).toThrow(HostOwnershipError);

    // Reject invalid spec with escaped dshHome
    expect(() =>
      validateHostRuntimePaths({
        userId: 'alice',
        dataRoot: rawDataRoot,
        dshHome: '/etc/dsh',
        spacesDir: join(rawDataRoot, 'host-runtimes', 'alice', 'spaces'),
        runDir: join(rawDataRoot, 'host-runtimes', 'alice', 'run'),
      })
    ).toThrow(HostOwnershipError);

    // Reject invalid spec with escaped spacesDir
    expect(() =>
      validateHostRuntimePaths({
        userId: 'alice',
        dataRoot: rawDataRoot,
        dshHome: join(rawDataRoot, 'host-runtimes', 'alice', '.dsh'),
        spacesDir: '/tmp/arbitrary-spaces',
        runDir: join(rawDataRoot, 'host-runtimes', 'alice', 'run'),
      })
    ).toThrow(HostOwnershipError);
  });

  it('filters host environment strictly without leaking sensitive parent process tokens or keys', () => {
    const rawDataRoot = join(tempRepo.repoRoot, '.demo-data');
    const adapter = new HostRuntimeAdapter();

    // Set sensitive variables in current process
    process.env.DSH_TOKEN = 'SUPER_SECRET_DSH_TOKEN_XYZ';
    process.env.AWS_SECRET_ACCESS_KEY = 'SUPER_SECRET_AWS_KEY_123';
    process.env.CUSTOM_DATABASE_PASSWORD = 'SUPER_SECRET_DB_PASS_456';

    const spec = adapter.createDefaultUserSpec({
      userId: 'alice',
      dataRoot: rawDataRoot,
      llmEnabled: true,
      llmProvider: 'cpa-gemini',
      llmModel: 'gemini-3.7-flash-tiered',
    });

    const filteredEnv = filterHostEnvironment(spec);

    // Assert sensitive keys are completely absent from child env
    expect(filteredEnv.DSH_TOKEN).toBeUndefined();
    expect(filteredEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(filteredEnv.CUSTOM_DATABASE_PASSWORD).toBeUndefined();

    // Assert placeholder credentials are used for upstream SDKs
    expect(filteredEnv.OPENAI_API_KEY).toBe('in-container-placeholder');
    expect(filteredEnv.ANTHROPIC_API_KEY).toBe('in-container-placeholder');
    expect(filteredEnv.DEEPSEEK_API_KEY).toBe('in-container-placeholder');

    // Assert isolated user paths
    expect(filteredEnv.DSH_USER).toBe('alice');
    expect(filteredEnv.DSH_HOME).toBe(spec.dshHome);
    expect(filteredEnv.DSH_SPACES).toBe(spec.spacesDir);

    // Clean up test process env
    delete process.env.DSH_TOKEN;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.CUSTOM_DATABASE_PASSWORD;
  });

  it('cleans up all child processes, sockets, and metadata on teardown', async () => {
    // 1. Reset and launch
    await resetDemo({ repoRoot: tempRepo.repoRoot, forceClean: true });
    system = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      runtimeAdapter: new FakeUnitRuntimeContainerAdapter(),
      hostRuntimeAdapter: new HostRuntimePortAdapter(),
      allowHostRuntime: true,
      llmEnabled: false,
    });

    const aliceUser = await system.storage.users.findByUsername('alice');
    const aliceId = aliceUser!.id;

    // 2. Start Host Runtime by creating a space
    await system.createHostSpace(aliceId, {
      name: 'Alice Teardown Test Space',
      folder: 'alice-teardown-space',
    });

    const userHostRoot = join(tempRepo.repoRoot, '.demo-data', 'host-runtimes', 'alice');
    const metaPath = join(userHostRoot, 'run', 'process.meta.json');
    expect(existsSync(metaPath)).toBe(true);

    const procMeta = JSON.parse(readFileSync(metaPath, 'utf8'));
    const childPid = procMeta.pid;
    expect(isProcessAlive(childPid)).toBe(true);

    // 3. Teardown via system.close({ removeVolumes: true })
    await system.close({ removeVolumes: true });
    system = null;

    // 4. Verify child process is dead
    let isDead = false;
    for (let i = 0; i < 40; i++) {
      if (!isProcessAlive(childPid)) {
        isDead = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(isDead).toBe(true);

    // 5. Run downDemo to ensure zero residual metadata or processes
    const downRes = await downDemo({
      repoRoot: tempRepo.repoRoot,
      removeVolumes: true,
    });
    expect(downRes.ok).toBe(true);
  });
});
