import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { downDemo } from '../src/down/index.js';
import {
  writeSignedProcessMeta,
  writeSignedContainerMeta,
  writeSignedVolumeMeta,
  listSignedProcesses,
  listSignedContainers,
  resetSessionMetaSecret,
} from '../src/utils/crypto-meta.js';
import { getDemoPathConfig } from '../src/config.js';
import type { ProcessInspector, ProcessKiller } from '../src/types.js';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';

describe('Negative Security Tests: Safe Teardown (`demo:down`)', () => {
  let tempRepo: TempRepo;
  let paths: ReturnType<typeof getDemoPathConfig>;

  beforeEach(() => {
    tempRepo = createTempRepo();
    paths = getDemoPathConfig(tempRepo.repoRoot);
    resetSessionMetaSecret(tempRepo.repoRoot);
    mkdirSync(paths.pidsDir, { recursive: true });
    mkdirSync(paths.containersDir, { recursive: true });
  });

  afterEach(() => {
    resetSessionMetaSecret(tempRepo.repoRoot);
    tempRepo.cleanup();
  });

  it('never terminates caller CLI process even if present in metadata (self PID protection)', async () => {
    // Register current process PID
    writeSignedProcessMeta(
      {
        service: 'platform-server',
        pid: process.pid,
        port: 3150,
      },
      tempRepo.repoRoot
    );

    const killedPids: number[] = [];
    const mockKiller: ProcessKiller = {
      kill: (pid, signal) => {
        killedPids.push(pid);
      },
    };

    const mockInspector: ProcessInspector = {
      getProcessInfo: async (pid) => ({
        exists: true,
        pid,
        startTime: 'Tue Aug 25 00:00:00 2026',
        command: 'node /path/to/cli.js',
      }),
    };

    const result = await downDemo({
      repoRoot: tempRepo.repoRoot,
      processInspector: mockInspector,
      processKiller: mockKiller,
    });

    expect(result.ok).toBe(false);
    expect(killedPids).not.toContain(process.pid);
    expect(result.terminatedProcesses).toHaveLength(1);
    expect(result.terminatedProcesses[0]?.name).toBe('platform-server');
    expect(result.terminatedProcesses[0]?.status).toBe('failed');
    expect(result.terminatedProcesses[0]?.error).toMatch(/Cannot terminate self process/);
    // Metadata is NOT cleaned, retained as evidence
    expect(listSignedProcesses(tempRepo.repoRoot)).toHaveLength(1);
  });

  it('refuses to kill PID <= 1 (system / init process protection)', async () => {
    // Manually write validly-signed metadata for PID 1
    writeSignedProcessMeta(
      {
        service: 'system-init',
        pid: 1,
      },
      tempRepo.repoRoot
    );

    const killedPids: number[] = [];
    const mockKiller: ProcessKiller = {
      kill: (pid) => killedPids.push(pid),
    };

    const mockInspector: ProcessInspector = {
      getProcessInfo: async (pid) => ({ exists: true, pid }),
    };

    const result = await downDemo({
      repoRoot: tempRepo.repoRoot,
      processInspector: mockInspector,
      processKiller: mockKiller,
    });

    expect(result.ok).toBe(false); // Fail closed on error!
    expect(killedPids).not.toContain(1);
    const procRes = result.terminatedProcesses.find((p) => p.name === 'system-init');
    expect(procRes?.status).toBe('failed');
    expect(procRes?.error).toMatch(/invalid or system process/);
    // Metadata is KEPT on failure (fail closed)
    expect(listSignedProcesses(tempRepo.repoRoot)).toHaveLength(1);
  });

  it('detects and blocks PID reuse when process start time has changed', async () => {
    writeSignedProcessMeta(
      {
        service: 'reused-proc',
        pid: 88888,
        startTime: 'Tue Aug 25 01:00:00 2026',
      },
      tempRepo.repoRoot
    );

    const killedPids: number[] = [];
    const mockKiller: ProcessKiller = {
      kill: (pid) => killedPids.push(pid),
    };

    // Live process query reports startTime B (PID was reused by another unrelated process!)
    const mockInspector: ProcessInspector = {
      getProcessInfo: async (pid) => ({
        exists: true,
        pid,
        startTime: 'Tue Aug 25 04:30:00 2026', // Different start time!
        command: 'unrelated-app',
      }),
    };

    const result = await downDemo({
      repoRoot: tempRepo.repoRoot,
      processInspector: mockInspector,
      processKiller: mockKiller,
    });

    expect(result.ok).toBe(false);
    expect(killedPids).not.toContain(88888);
    const procRes = result.terminatedProcesses.find((p) => p.name === 'reused-proc');
    expect(procRes?.status).toBe('failed');
    expect(procRes?.error).toMatch(/PID REUSE DETECTED/);
    expect(listSignedProcesses(tempRepo.repoRoot)).toHaveLength(1);
  });

  it('detects and blocks PID reuse when command does not match demo service', async () => {
    const fixedStartTime = 'Tue Aug 25 02:53:37 2026';
    writeSignedProcessMeta(
      {
        service: 'mismatched-cmd',
        pid: 77777,
        command: 'node packages/demo-runner/dist/cli.js up',
        startTime: fixedStartTime,
      },
      tempRepo.repoRoot
    );

    const killedPids: number[] = [];
    const mockKiller: ProcessKiller = {
      kill: (pid) => killedPids.push(pid),
    };

    const mockInspector: ProcessInspector = {
      getProcessInfo: async (pid) => ({
        exists: true,
        pid,
        startTime: fixedStartTime,
        command: '/usr/bin/python3 /malicious/script.py',
      }),
    };

    const result = await downDemo({
      repoRoot: tempRepo.repoRoot,
      processInspector: mockInspector,
      processKiller: mockKiller,
    });

    expect(result.ok).toBe(false);
    expect(killedPids).not.toContain(77777);
    const procRes = result.terminatedProcesses.find((p) => p.name === 'mismatched-cmd');
    expect(procRes?.status).toBe('failed');
    expect(procRes?.error).toMatch(/PID REUSE \/ UNVERIFIED COMMAND DETECTED/);
    expect(listSignedProcesses(tempRepo.repoRoot)).toHaveLength(1);
  });

  it('rejects container teardown on container name prefix spoofing', async () => {
    const filePath = join(paths.containersDir, 'spoofed.json');
    const fake = {
      userId: 'attacker',
      containerName: 'production-postgres',
      containerId: randomBytes(32).toString('hex'),
      image: 'postgres',
      volumeName: 'prod-vol',
      labels: { app: 'enkeep-demo' },
      startedAt: new Date().toISOString(),
      owner: 'enkeep-demo',
      commandToken: 'tok',
      signature: 'sig',
      status: 'running',
    };
    writeFileSync(filePath, JSON.stringify(fake), 'utf-8');

    const fakeDockerClient = {
      isDockerAvailable: async () => true,
      inspectContainer: vi.fn(),
      stopContainer: vi.fn(),
      removeContainer: vi.fn(),
      removeVolume: vi.fn(),
    };

    const result = await downDemo({
      repoRoot: tempRepo.repoRoot,
      dockerClient: fakeDockerClient as any,
    });

    expect(result.ok).toBe(false);
    expect(fakeDockerClient.stopContainer).not.toHaveBeenCalled();
    expect(fakeDockerClient.removeContainer).not.toHaveBeenCalled();
  });

  it('performs verified volume removal when valid signed volume metadata exists', async () => {
    const hex64 = randomBytes(32).toString('hex');
    writeSignedVolumeMeta(
      {
        userId: 'alice',
        volumeName: 'enkeep-demo-dsh-alice',
        volumeId: 'vol_alice_001',
        runId: 'run_alice_001',
      },
      tempRepo.repoRoot
    );

    writeSignedContainerMeta(
      {
        userId: 'alice',
        containerName: 'enkeep-demo-alice',
        containerId: hex64,
        image: 'img',
        volumeName: 'enkeep-demo-dsh-alice',
        volumeId: 'vol_alice_001',
        runId: 'run_alice_001',
      },
      tempRepo.repoRoot
    );

    const fakeDockerClient = {
      isDockerAvailable: async () => true,
      inspectContainer: async () => ({
        id: hex64,
        name: 'enkeep-demo-alice',
        image: 'img',
        status: 'running',
        state: 'running',
        labels: { app: 'enkeep-demo', 'enkeep.user': 'alice', 'enkeep.run-id': 'run_alice_001' },
      }),
      stopContainer: vi.fn(),
      removeContainer: vi.fn(),
      removeVolume: vi.fn(),
    };

    const result = await downDemo({
      repoRoot: tempRepo.repoRoot,
      removeVolumes: true,
      dockerClient: fakeDockerClient as any,
    });

    expect(result.ok).toBe(true);
    expect(fakeDockerClient.removeVolume).toHaveBeenCalledWith(
      expect.objectContaining({ volumeName: 'enkeep-demo-dsh-alice', userId: 'alice', volumeId: 'vol_alice_001' })
    );
  });

  it('skips process killing gracefully if process is already stopped', async () => {
    writeSignedProcessMeta(
      {
        service: 'stopped-service',
        pid: 65432,
      },
      tempRepo.repoRoot
    );

    const killedPids: number[] = [];
    const mockKiller: ProcessKiller = {
      kill: (pid) => killedPids.push(pid),
    };

    const mockInspector: ProcessInspector = {
      getProcessInfo: async (pid) => ({ exists: false, pid }),
    };

    const result = await downDemo({
      repoRoot: tempRepo.repoRoot,
      processInspector: mockInspector,
      processKiller: mockKiller,
    });

    expect(result.ok).toBe(true);
    expect(killedPids).toHaveLength(0);
    const procRes = result.terminatedProcesses.find((p) => p.name === 'stopped-service');
    expect(procRes?.status).toBe('already_stopped');
  });

  it('refuses to kill parent process PID (parent PID protection) and retains metadata', async () => {
    const parentPid = process.ppid || 99999;
    writeSignedProcessMeta(
      {
        service: 'parent-process',
        pid: parentPid,
      },
      tempRepo.repoRoot
    );

    const killedPids: number[] = [];
    const mockKiller: ProcessKiller = {
      kill: (pid) => killedPids.push(pid),
    };

    const mockInspector: ProcessInspector = {
      getProcessInfo: async (pid) => ({
        exists: true,
        pid,
        startTime: 'Tue Aug 25 00:00:00 2026',
        command: 'node /path/to/parent.js',
      }),
    };

    const result = await downDemo({
      repoRoot: tempRepo.repoRoot,
      processInspector: mockInspector,
      processKiller: mockKiller,
    });

    expect(result.ok).toBe(false);
    expect(killedPids).not.toContain(parentPid);
    const procRes = result.terminatedProcesses.find((p) => p.name === 'parent-process');
    expect(procRes?.status).toBe('failed');
    if (process.ppid) {
      expect(procRes?.error).toMatch(/Cannot terminate parent process/);
    }
    expect(listSignedProcesses(tempRepo.repoRoot)).toHaveLength(1);
  });
});
