/**
 * `enkeep-server stop` (demo-runner `down --production`) must tear down runtimes that run with
 * `--network-mode bridge`. The ownership check used to compare a bridge container against the
 * default 'none' and refuse every one of them, while the summary still reported them as terminated.
 *
 * Uses the real SafeDockerClient ownership and stop/remove logic; only `docker inspect` is served
 * from memory and the docker binary is a stub script that records its arguments.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SafeDockerClient, type DockerContainerInfo } from '@enkeep/runtime-runner/docker';
import { downDemo, formatDownSummary } from '../src/down/index.js';
import { writeProductionMarker } from '../src/config.js';
import { writeSignedContainerMeta, readSignedContainerMeta, resetCachedSecrets } from '../src/utils/crypto-meta.js';
import type { DemoDownResult } from '../src/types.js';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';

const CONTAINER_ID = 'a'.repeat(64);
const VOLUME_ID = 'vol_0123456789abcdef0123456789abcdef';

/** Real SafeDockerClient whose inspect reads in-memory state updated from the stub's command log. */
class StubbedDockerClient extends SafeDockerClient {
  constructor(private readonly logPath: string, private readonly base: DockerContainerInfo) {
    super(writeStubDocker(logPath));
  }

  commands(): string[] {
    return existsSync(this.logPath) ? readFileSync(this.logPath, 'utf8').split('\n').filter(Boolean) : [];
  }

  override async inspectContainer(identifier: string): Promise<DockerContainerInfo | null> {
    if (identifier !== this.base.id && identifier !== this.base.name) return null;
    const cmds = this.commands();
    if (cmds.some((c) => c.startsWith('rm ') && c.includes(this.base.id))) return null;
    const stopped = cmds.some((c) => c.startsWith('stop ') && c.includes(this.base.id));
    return { ...this.base, state: stopped ? 'exited' : 'running', status: stopped ? 'exited' : 'running' };
  }
}

function writeStubDocker(logPath: string): string {
  const bin = join(logPath, '..', 'docker');
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> "${logPath}"\nif [ "$1" = version ]; then echo 27.0.0; fi\nexit 0\n`);
  chmodSync(bin, 0o700);
  return bin;
}

describe('down --production with bridge-networked runtimes', () => {
  let tempRepo: TempRepo;
  let dataRoot: string;
  let stubDir: string;
  let options: { repoRoot: string; dataRoot: string; mode: 'production' };

  beforeEach(() => {
    tempRepo = createTempRepo();
    dataRoot = mkdtempSync(join(tmpdir(), 'enkeep-test-prod-data-'));
    stubDir = mkdtempSync(join(tmpdir(), 'enkeep-test-docker-stub-'));
    writeProductionMarker(dataRoot);
    options = { repoRoot: tempRepo.repoRoot, dataRoot, mode: 'production' };
  });

  afterEach(() => {
    resetCachedSecrets(options);
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(stubDir, { recursive: true, force: true });
    tempRepo.cleanup();
  });

  function registerRuntime(networkMode: string) {
    const meta = writeSignedContainerMeta(
      {
        userId: 'alice',
        containerName: 'enkeep-runtime-alice',
        containerId: CONTAINER_ID,
        image: 'enkeep-runtime:test',
        volumeName: 'enkeep-home-alice',
        volumeId: VOLUME_ID,
        runId: 'run_test_001',
      },
      options
    );
    const live: DockerContainerInfo = {
      id: CONTAINER_ID,
      name: 'enkeep-runtime-alice',
      image: 'enkeep-runtime:test',
      status: 'running',
      state: 'running',
      user: '1000:1000',
      networkMode,
      readonlyRootfs: true,
      capDrop: ['ALL'],
      securityOpt: ['no-new-privileges:true'],
      pidsLimit: 256,
      portBindings: null,
      mounts: [{ type: 'volume', name: 'enkeep-home-alice', source: '/tmp/enkeep-test/volume', destination: '/home/dsh', rw: true }],
      tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=64m' },
      labels: meta.labels,
    } as DockerContainerInfo;
    return new StubbedDockerClient(join(stubDir, 'docker.log'), live);
  }

  for (const networkMode of ['bridge', 'none']) {
    it(`stops and removes a runtime running with network mode "${networkMode}"`, async () => {
      const client = registerRuntime(networkMode);
      const result = await downDemo({ ...options, production: true, dockerClient: client });

      expect(result.ok).toBe(true);
      expect(result.terminatedContainers).toEqual([
        { type: 'container', name: 'enkeep-runtime-alice', id: CONTAINER_ID, status: 'terminated' },
      ]);
      const cmds = client.commands();
      expect(cmds.some((c) => c.startsWith('stop ') && c.endsWith(CONTAINER_ID))).toBe(true);
      expect(cmds.some((c) => c.startsWith('rm ') && c.endsWith(CONTAINER_ID))).toBe(true);
      expect(cmds.some((c) => c.startsWith('volume'))).toBe(false);
      expect(readSignedContainerMeta('enkeep-runtime-alice', options)).toBeNull();
    });
  }

  it('refuses a runtime with any other network mode and reports why, without stopping it', async () => {
    const client = registerRuntime('host');
    const result = await downDemo({ ...options, production: true, dockerClient: client });

    expect(result.ok).toBe(false);
    expect(result.terminatedContainers).toHaveLength(1);
    expect(result.terminatedContainers[0].status).toBe('failed');
    expect(result.terminatedContainers[0].error).toMatch(/NetworkMode "host" is not one of none, bridge/);
    expect(client.commands().some((c) => c.startsWith('stop ') || c.startsWith('rm '))).toBe(false);
    expect(readSignedContainerMeta('enkeep-runtime-alice', options)?.containerId).toBe(CONTAINER_ID);
  });

  it('fails closed when the inspect result carries no network mode', async () => {
    const client = registerRuntime('');
    const result = await downDemo({ ...options, production: true, dockerClient: client });

    expect(result.ok).toBe(false);
    expect(result.terminatedContainers[0].status).toBe('failed');
    expect(result.terminatedContainers[0].error).toMatch(/NetworkMode/);
    expect(client.commands().some((c) => c.startsWith('stop ') || c.startsWith('rm '))).toBe(false);
  });
});

describe('formatDownSummary', () => {
  const base: DemoDownResult = {
    ok: false,
    timestamp: '2026-01-01T00:00:00.000Z',
    terminatedProcesses: [{ type: 'process', name: 'platform-server', id: 4242, status: 'already_stopped' }],
    terminatedContainers: [
      { type: 'container', name: 'enkeep-runtime-alice', id: 'c1', status: 'terminated' },
      { type: 'container', name: 'enkeep-runtime-bob', id: 'c2', status: 'failed', error: 'Container NetworkMode must be "none"' },
      { type: 'container', name: 'enkeep-runtime-carol', id: 'c3', status: 'failed', error: 'Live inspect error: boom' },
    ],
    removedVolumes: [],
    cleanedMetadataCount: 2,
  };

  it('counts only stopped containers as terminated and lists each failure with its reason', () => {
    const text = formatDownSummary(base);
    expect(text).toContain('Teardown Failed');
    expect(text).toContain('Terminated Containers: 1 (already stopped: 0, failed: 2)');
    expect(text).toContain('Terminated Processes:  0 (already stopped: 1, failed: 0)');
    expect(text).toContain('✖ container enkeep-runtime-bob (c2): Container NetworkMode must be "none"');
    expect(text).toContain('✖ container enkeep-runtime-carol (c3): Live inspect error: boom');
  });

  it('reports a clean teardown without a failure section', () => {
    const text = formatDownSummary({ ...base, ok: true, terminatedContainers: [base.terminatedContainers[0]] });
    expect(text).toContain('Teardown Complete');
    expect(text).toContain('Terminated Containers: 1 (already stopped: 0, failed: 0)');
    expect(text).not.toContain('Failures:');
  });
});
