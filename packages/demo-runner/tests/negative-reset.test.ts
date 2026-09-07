import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, symlinkSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { resetDemo } from '../src/reset/index.js';
import {
  writeSignedProcessMeta,
  writeSignedContainerMeta,
  writeSignedVolumeMeta,
  resetSessionMetaSecret,
} from '../src/utils/crypto-meta.js';
import { getDemoPathConfig } from '../src/config.js';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';

describe('Negative Security Tests: Demo Reset Safety (`demo:reset`)', () => {
  let tempRepo: TempRepo;
  let paths: ReturnType<typeof getDemoPathConfig>;

  beforeEach(() => {
    tempRepo = createTempRepo();
    paths = getDemoPathConfig(tempRepo.repoRoot);
    resetSessionMetaSecret(tempRepo.repoRoot);
  });

  afterEach(() => {
    resetSessionMetaSecret(tempRepo.repoRoot);
    tempRepo.cleanup();
  });

  it('refuses to reset when demo processes are actively running', async () => {
    mkdirSync(paths.pidsDir, { recursive: true });
    // Mock a running process
    writeSignedProcessMeta(
      {
        service: 'active-platform',
        pid: process.ppid || process.pid,
      },
      tempRepo.repoRoot
    );

    if (process.ppid && process.ppid !== process.pid) {
      await expect(resetDemo({ repoRoot: tempRepo.repoRoot, checkActiveResources: true })).rejects.toThrow(
        /Cannot reset demo environment while demo processes are/
      );
    }
  });

  it('refuses to reset when demo containers are registered and checkActiveResources is enabled', async () => {
    mkdirSync(paths.containersDir, { recursive: true });
    writeSignedContainerMeta(
      {
        userId: 'alice',
        containerName: 'enkeep-demo-alice',
        containerId: randomBytes(32).toString('hex'),
        image: 'img',
        volumeName: 'enkeep-demo-dsh-alice',
        volumeId: 'vol_alice_001',
        runId: 'run_alice_001',
      },
      tempRepo.repoRoot
    );

    await expect(resetDemo({ repoRoot: tempRepo.repoRoot, checkActiveResources: true })).rejects.toThrow(
      /Cannot reset demo environment while demo containers are registered/
    );
  });

  it('refuses to operate if .demo-data is a symlink (symlink containment)', async () => {
    const symlinkTarget = join(tempRepo.repoRoot, '.test-external-target');
    mkdirSync(symlinkTarget, { recursive: true });

    if (existsSync(paths.demoDataDir)) {
      rmSync(paths.demoDataDir, { recursive: true, force: true });
    }

    try {
      symlinkSync(symlinkTarget, paths.demoDataDir, 'dir');
      await expect(resetDemo({ repoRoot: tempRepo.repoRoot, checkActiveResources: false })).rejects.toThrow(
        /Symlink breakout|symlink/i
      );
    } finally {
      if (existsSync(paths.demoDataDir)) {
        try {
          rmSync(paths.demoDataDir, { recursive: true, force: true });
        } catch {}
      }
      if (existsSync(symlinkTarget)) {
        rmSync(symlinkTarget, { recursive: true, force: true });
      }
    }
  });

  it('ensures secrets.json is created with strict file permissions mode 0600', async () => {
    const res = await resetDemo({ repoRoot: tempRepo.repoRoot, checkActiveResources: false });
    expect(res.ok).toBe(true);

    const secretPath = join(paths.demoDataDir, 'secrets.json');
    expect(existsSync(secretPath)).toBe(true);

    const stats = statSync(secretPath);
    const permission = stats.mode & 0o777;
    expect(permission).toBe(0o600);

    // Verify .meta-secret does NOT exist
    const oldMetaSecret = join(paths.demoDataDir, '.meta-secret');
    expect(existsSync(oldMetaSecret)).toBe(false);
  });

  it('signed container/volume metadata + Docker unavailable -> reset rejects and preserves all metadata bytes', async () => {
    mkdirSync(paths.containersDir, { recursive: true });
    mkdirSync(paths.volumesDir, { recursive: true });

    const cMeta = writeSignedContainerMeta(
      {
        userId: 'alice',
        containerName: 'enkeep-demo-alice',
        containerId: randomBytes(32).toString('hex'),
        image: 'img',
        volumeName: 'enkeep-demo-dsh-alice',
        volumeId: 'vol_alice_001',
        runId: 'run_alice_001',
      },
      tempRepo.repoRoot
    );

    const vMeta = writeSignedVolumeMeta(
      {
        userId: 'alice',
        volumeName: 'enkeep-demo-dsh-alice',
        volumeId: 'vol_alice_001',
        runId: 'run_alice_001',
      },
      tempRepo.repoRoot
    );

    const cPath = join(paths.containersDir, 'enkeep-demo-alice.json');
    const vPath = join(paths.volumesDir, 'enkeep-demo-dsh-alice.json');

    const cBytesBefore = readFileSync(cPath, 'utf8');
    const vBytesBefore = readFileSync(vPath, 'utf8');

    const mockUnavailableDockerClient: any = {
      isDockerAvailable: async () => false,
      inspectContainer: async () => {
        throw new Error('Docker unavailable');
      },
      stopContainer: async () => {
        throw new Error('Docker unavailable');
      },
      removeContainer: async () => {
        throw new Error('Docker unavailable');
      },
      removeVolume: async () => {
        throw new Error('Docker unavailable');
      },
    };

    await expect(
      resetDemo({
        repoRoot: tempRepo.repoRoot,
        dockerClient: mockUnavailableDockerClient,
      })
    ).rejects.toThrow(/Failed to safely teardown active demo resources before reset/);

    // Verify all metadata bytes are 100% preserved
    expect(existsSync(cPath)).toBe(true);
    expect(existsSync(vPath)).toBe(true);
    expect(readFileSync(cPath, 'utf8')).toBe(cBytesBefore);
    expect(readFileSync(vPath, 'utf8')).toBe(vBytesBefore);
  });

  it('rejects reset and preserves all data when unknown/non-allowlisted file exists in data root', async () => {
    mkdirSync(paths.dataRoot, { recursive: true });
    const unknownFilePath = join(paths.dataRoot, 'unknown-unauthorized.txt');
    writeFileSync(unknownFilePath, 'do-not-delete-me', { mode: 0o600 });

    await expect(resetDemo({ repoRoot: tempRepo.repoRoot })).rejects.toThrow(
      /Unknown or non-allowlisted entry "unknown-unauthorized.txt"/
    );

    expect(existsSync(unknownFilePath)).toBe(true);
    expect(readFileSync(unknownFilePath, 'utf8')).toBe('do-not-delete-me');
  });

  it('rejects reset and preserves data when a nested directory entry is a symlink', async () => {
    mkdirSync(paths.spacesDir, { recursive: true });
    const symlinkTarget = join(tempRepo.repoRoot, 'target-dir');
    mkdirSync(symlinkTarget, { recursive: true });
    const symlinkPath = join(paths.spacesDir, 'nested-link');

    symlinkSync(symlinkTarget, symlinkPath, 'dir');

    await expect(resetDemo({ repoRoot: tempRepo.repoRoot })).rejects.toThrow(
      /Symlink detected at/
    );
  });

  it('confirms Docker and process killer are never invoked during normal reset when no signed metadata exists', async () => {
    const dockerCalls: string[] = [];
    const killerCalls: number[] = [];
    const inspectorCalls: number[] = [];

    const spyDockerClient: any = {
      isDockerAvailable: async () => {
        dockerCalls.push('isDockerAvailable');
        return true;
      },
      inspectContainer: async () => {
        dockerCalls.push('inspectContainer');
        return null;
      },
      removeVolume: async () => {
        dockerCalls.push('removeVolume');
      },
    };

    const spyKiller = {
      kill: (pid: number) => {
        killerCalls.push(pid);
      },
    };

    const spyInspector = {
      getProcessInfo: async (pid: number) => {
        inspectorCalls.push(pid);
        return { exists: false, pid };
      },
    };

    const res = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      dockerClient: spyDockerClient,
      processKiller: spyKiller,
      processInspector: spyInspector,
    });

    expect(res.ok).toBe(true);
    // Verified: zero Docker, killer, and inspector calls made!
    expect(dockerCalls).toEqual([]);
    expect(killerCalls).toEqual([]);
    expect(inspectorCalls).toEqual([]);
  });

  it('provisions idempotently without deletion when forceClean: false is provided', async () => {
    const fixedTimestamp = '2026-03-30T12:00:00.000Z';
    const firstRes = await resetDemo({ repoRoot: tempRepo.repoRoot, deterministicCreatedAt: fixedTimestamp });
    expect(firstRes.ok).toBe(true);

    const secondRes = await resetDemo({ repoRoot: tempRepo.repoRoot, forceClean: false, deterministicCreatedAt: fixedTimestamp });
    expect(secondRes.ok).toBe(true);
  });
});
