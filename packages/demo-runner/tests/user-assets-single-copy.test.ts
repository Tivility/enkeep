/**
 * User-level assets: desired mounts per container user and the one-time convergence.
 *
 * - startUserRuntime only mounts the host copy for new volumes or migrated volumes.
 * - `user-assets-migrate` (runUserAssetMigration) in the consistent, divergent, dry-run,
 *   idempotent, busy and legacy cases. The in-container script runs locally against a
 *   synthetic "container home" directory.
 *
 * Synthetic fixtures only.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SafeDockerClient, HostRuntimeAdapter } from '@enkeep/runtime-runner';
import * as runtimeRunner from '@enkeep/runtime-runner';
import { DockerRuntimeContainerAdapter } from '../src/ports/index.js';
import { getDemoPathConfig } from '../src/config.js';
import { writeSignedVolumeMeta } from '../src/utils/crypto-meta.js';
import {
  CONTAINER_MIGRATION_SCRIPT,
  DEFAULT_GLOBAL_MEMORY_SKELETON,
  formatMigrationReport,
  hostDshHomeForUsername,
  hostUserAssetsForHandle,
  migrationMarkerPath,
  readMigrationMarker,
  resolveDesiredUserAssets,
  runUserAssetMigration,
  writeMigrationMarker,
  type MigrationUser,
  type UserAssetMigrationDeps,
} from '../src/user-assets/index.js';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';

const VOLUME_ID = 'vol_' + 'b'.repeat(32);
const OTHER_VOLUME_ID = 'vol_' + 'c'.repeat(32);
const CONTAINER_ID = 'd'.repeat(64);

describe('user assets: desired mounts for container runtimes', () => {
  let tempRepo: TempRepo;
  let dataRoot: string;

  beforeEach(() => {
    tempRepo = createTempRepo();
    dataRoot = getDemoPathConfig({ repoRoot: tempRepo.repoRoot }).dataRoot;
    mkdirSync(dataRoot, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ENKEEP_USER_ASSET_MOUNTS;
    tempRepo.cleanup();
  });

  function adapterCapturingSpec() {
    // Hermetic: never read the operator's DSH deployment config
    vi.spyOn(runtimeRunner, 'loadDshDeploymentConfig').mockReturnValue(null as any);
    const client = new SafeDockerClient();
    vi.spyOn(client, 'isDockerAvailable').mockResolvedValue(true);
    vi.spyOn(client, 'inspectContainer').mockResolvedValue(null);
    const adapter = new DockerRuntimeContainerAdapter(client);
    const internal = (adapter as any).adapter;
    const orig = internal.createDefaultUserSpec.bind(internal);
    const captured: any[] = [];
    vi.spyOn(internal, 'createDefaultUserSpec').mockImplementation((opts: any) => {
      const spec = orig(opts);
      captured.push(spec);
      return spec;
    });
    const fakeHandle = (spec: any) => ({
      userId: spec.userId,
      runId: spec.runId,
      containerId: CONTAINER_ID,
      userAssetMounts: spec.userAssetMounts ?? [],
      teardown: vi.fn(),
    });
    vi.spyOn(internal, 'startRuntime').mockImplementation(async (spec: any) => fakeHandle(spec));
    vi.spyOn(internal, 'startRuntimeWithOwnedVolume').mockImplementation(async (spec: any) => fakeHandle(spec));
    return { adapter, captured };
  }

  it('host DSH home naming matches the host runtime layout', () => {
    const host = new HostRuntimeAdapter();
    const spec = host.createDefaultUserSpec({ userId: 'alice', dataRoot });
    expect(hostDshHomeForUsername(dataRoot, 'alice')).toBe(spec.dshHome);
    expect(hostDshHomeForUsername(dataRoot, '../bob')).toBeUndefined();
    expect(hostDshHomeForUsername(dataRoot, 'Alice')).toBeUndefined();
    expect(hostDshHomeForUsername('relative', 'alice')).toBeUndefined();
  });

  it('new volume: mounts memory/ and skills/ read-only from the host copy and enables platform writes', async () => {
    const { adapter, captured } = adapterCapturingSpec();
    const handle = await adapter.startUserRuntime({ userId: 'alice_1a2b3c4d', username: 'alice', repoRoot: tempRepo.repoRoot });
    const spec = captured[captured.length - 1];
    const home = join(dataRoot, 'host-runtimes', 'alice', '.dsh');
    expect(spec.userAssetMounts).toEqual([
      { kind: 'memory', sourcePath: join(home, 'memory'), targetPath: '/home/dsh/.dsh/memory', readOnly: true },
      { kind: 'skills', sourcePath: join(home, 'skills'), targetPath: '/home/dsh/.dsh/skills', readOnly: true },
    ]);
    expect(spec.environment.ENKEEP_USER_MEMORY_WRITE).toBe('platform');
    expect(existsSync(join(home, 'memory'))).toBe(true);
    expect(handle.userAssets).toEqual({ hostDshHome: home, reason: 'new_volume', desiredKinds: ['memory', 'skills'] });
    expect(hostUserAssetsForHandle(handle)?.hostDshHome).toBe(home);
  });

  it('without a platform username nothing changes (no mounts, no flag)', async () => {
    const { adapter, captured } = adapterCapturingSpec();
    const handle = await adapter.startUserRuntime({ userId: 'alice_1a2b3c4d', repoRoot: tempRepo.repoRoot });
    const spec = captured[captured.length - 1];
    expect(spec.userAssetMounts).toBeUndefined();
    expect(spec.environment.ENKEEP_USER_MEMORY_WRITE).toBeUndefined();
    expect(handle.userAssets).toBeUndefined();
    expect(hostUserAssetsForHandle(handle)).toBeUndefined();
  });

  it('existing volume: no mounts until the convergence marker matches the volume id', async () => {
    const identity = 'alice_1a2b3c4d';
    const volumeName = `enkeep-demo-dsh-${identity}`;
    writeSignedVolumeMeta({ userId: identity, volumeName, volumeId: VOLUME_ID, runId: 'run_old_1' }, { repoRoot: tempRepo.repoRoot });

    let { adapter, captured } = adapterCapturingSpec();
    let handle = await adapter.startUserRuntime({ userId: identity, username: 'alice', repoRoot: tempRepo.repoRoot });
    expect(captured[captured.length - 1].userAssetMounts).toBeUndefined();
    expect(handle.userAssets?.reason).toBe('migration_pending');
    expect(hostUserAssetsForHandle(handle)).toBeUndefined();

    writeMigrationMarker(dataRoot, {
      version: 1, status: 'converged', volumeName, volumeId: OTHER_VOLUME_ID, runtimeIdentity: identity,
      migratedAt: new Date(0).toISOString(), archiveDir: null, assets: {}, divergentArchived: [],
    });
    vi.restoreAllMocks();
    ({ adapter, captured } = adapterCapturingSpec());
    handle = await adapter.startUserRuntime({ userId: identity, username: 'alice', repoRoot: tempRepo.repoRoot });
    expect(captured[captured.length - 1].userAssetMounts).toBeUndefined();

    writeMigrationMarker(dataRoot, {
      version: 1, status: 'converged', volumeName, volumeId: VOLUME_ID, runtimeIdentity: identity,
      migratedAt: new Date(0).toISOString(), archiveDir: null, assets: {}, divergentArchived: [],
    });
    vi.restoreAllMocks();
    ({ adapter, captured } = adapterCapturingSpec());
    handle = await adapter.startUserRuntime({ userId: identity, username: 'alice', repoRoot: tempRepo.repoRoot });
    expect(captured[captured.length - 1].userAssetMounts.map((m: any) => m.kind)).toEqual(['memory', 'skills']);
    expect(handle.userAssets?.reason).toBe('migrated');
  });

  /**
   * Fake Docker state for one user: start/rebuild create a container whose inspect output carries
   * the spec's mounts; a later start with that container running reconnects to it.
   */
  function adapterWithFakeDocker() {
    vi.spyOn(runtimeRunner, 'loadDshDeploymentConfig').mockReturnValue(null as any);
    const client = new SafeDockerClient();
    vi.spyOn(client, 'isDockerAvailable').mockResolvedValue(true);
    const state: { running: any; calls: string[]; markerAtCreate: any[] } = { running: null, calls: [], markerAtCreate: [] };
    vi.spyOn(client, 'inspectContainer').mockImplementation(async () => state.running);
    const adapter = new DockerRuntimeContainerAdapter(client);
    const internal = (adapter as any).adapter;
    const orig = internal.createDefaultUserSpec.bind(internal);
    const specs: any[] = [];
    vi.spyOn(internal, 'createDefaultUserSpec').mockImplementation((opts: any) => {
      const spec = orig(opts);
      specs.push(spec);
      return spec;
    });
    const handleFor = (spec: any, actual: any[], pending: boolean) => ({
      userId: spec.userId,
      runId: spec.runId,
      containerId: CONTAINER_ID,
      userAssetMounts: actual,
      userAssetMountsPending: pending,
      teardown: vi.fn(async () => {
        state.running = null;
      }),
    });
    const create = (kind: string) => async (spec: any) => {
      state.calls.push(kind);
      state.markerAtCreate.push(readMigrationMarker(dataRoot, spec.volume.volumeName));
      state.running = {
        id: CONTAINER_ID,
        state: 'running',
        image: spec.image,
        networkMode: spec.networkMode,
        labels: spec.labels,
        mounts: [
          { type: 'volume', name: spec.volume.volumeName, source: '', destination: '/home/dsh', rw: true },
          ...(spec.userAssetMounts ?? []).map((m: any) => ({ type: 'bind', source: m.sourcePath, destination: m.targetPath, rw: false })),
        ],
      };
      return handleFor(spec, spec.userAssetMounts ?? [], false);
    };
    vi.spyOn(internal, 'startRuntime').mockImplementation(create('create'));
    vi.spyOn(internal, 'startRuntimeWithOwnedVolume').mockImplementation(create('rebuild'));
    vi.spyOn(internal, 'connectRuntime').mockImplementation(async (spec: any) => {
      state.calls.push('reconnect');
      const actual = runtimeRunner.readContainerUserAssetMounts(state.running);
      return handleFor(spec, actual, !runtimeRunner.userAssetMountKindsEqual(actual, spec.userAssetMounts));
    });
    return { adapter, specs, state };
  }

  it('new volume: mounts survive a restart (reconnect) and a rebuild; the marker is written before the container is created', async () => {
    const identity = 'alice_1a2b3c4d';
    const volumeName = `enkeep-demo-dsh-${identity}`;
    const { adapter, specs, state } = adapterWithFakeDocker();
    const start = () => adapter.startUserRuntime({ userId: identity, username: 'alice', repoRoot: tempRepo.repoRoot });
    const kinds = (spec: any) => (spec.userAssetMounts ?? []).map((m: any) => m.kind);

    // 1st start: brand-new volume
    const first = await start();
    const firstSpec = specs[specs.length - 1];
    expect(kinds(firstSpec)).toEqual(['memory', 'skills']);
    expect(first.userAssets?.reason).toBe('new_volume');
    expect(state.markerAtCreate[0]).toMatchObject({ status: 'converged', origin: 'new_volume', volumeId: firstSpec.volume.volumeId });
    const volumeId = firstSpec.volume.volumeId;

    // 2nd start of the same user (platform restart): reconnects to the running container
    const second = await start();
    expect(state.calls).toEqual(['create', 'reconnect']);
    expect(kinds(specs[specs.length - 1])).toEqual(['memory', 'skills']);
    expect(second.userAssets?.reason).toBe('migrated');
    expect(second.rawHandle?.userAssetMounts?.map((m) => m.kind)).toEqual(['memory', 'skills']);
    expect(second.rawHandle?.userAssetMountsPending).toBe(false);
    expect(specs[specs.length - 1].environment.ENKEEP_USER_MEMORY_WRITE).toBe('platform');

    // Rebuild (AutoUpgrader: container removed, volume kept), then the next request starts it again
    await second.rawHandle!.teardown(false);
    const third = await start();
    expect(state.calls).toEqual(['create', 'reconnect', 'rebuild']);
    const thirdSpec = specs[specs.length - 1];
    expect(thirdSpec.volume.volumeId).toBe(volumeId);
    expect(kinds(thirdSpec)).toEqual(['memory', 'skills']);
    expect(thirdSpec.environment.ENKEEP_USER_MEMORY_WRITE).toBe('platform');
    expect(third.userAssets?.reason).toBe('migrated');
    expect(readMigrationMarker(dataRoot, volumeName)).toMatchObject({ status: 'converged', volumeId });
  });

  it('a running container that already has the mounts but no marker gets one, and keeps its mounts', async () => {
    const identity = 'alice_1a2b3c4d';
    const volumeName = `enkeep-demo-dsh-${identity}`;
    const { adapter, specs, state } = adapterWithFakeDocker();
    const start = () => adapter.startUserRuntime({ userId: identity, username: 'alice', repoRoot: tempRepo.repoRoot });
    await start();
    // Simulate a container created before markers were written for new volumes
    rmSync(migrationMarkerPath(dataRoot, volumeName));
    const again = await start();
    expect(state.calls).toEqual(['create', 'reconnect']);
    expect(readMigrationMarker(dataRoot, volumeName)).toMatchObject({ status: 'converged', origin: 'observed_mounted' });
    expect(specs[specs.length - 1].userAssetMounts.map((m: any) => m.kind)).toEqual(['memory', 'skills']);
    expect(again.rawHandle?.userAssetMountsPending).toBe(false);
  });

  it('kill switch ENKEEP_USER_ASSET_MOUNTS=0 disables mounts', () => {
    const d = resolveDesiredUserAssets({
      dataRoot,
      hostDshHome: hostDshHomeForUsername(dataRoot, 'alice'),
      volumeName: 'enkeep-demo-dsh-alice_1a2b3c4d',
      volumeId: VOLUME_ID,
      isNewVolume: true,
      env: { ENKEEP_USER_ASSET_MOUNTS: '0' },
    });
    expect(d).toMatchObject({ enabled: false, reason: 'disabled_by_env', mounts: [] });
  });

  it('host copy for admin AGENTS.md: only once the container is served from the host copy', () => {
    const hostDshHome = '/srv/data/host-runtimes/alice/.dsh';
    expect(hostUserAssetsForHandle({})).toBeUndefined();
    expect(hostUserAssetsForHandle({ userAssets: { hostDshHome, reason: 'migration_pending' } })).toBeUndefined();
    expect(hostUserAssetsForHandle({ userAssets: { hostDshHome, reason: 'migration_pending' }, rawHandle: { userAssetMounts: [{ kind: 'memory' }] } })?.hostDshHome).toBe(hostDshHome);
    expect(hostUserAssetsForHandle({ userAssets: { hostDshHome, reason: 'migrated' } })?.spacesDir).toBe('/srv/data/host-runtimes/alice/spaces');
  });
});

// ---------------------------------------------------------------------------
// One-time convergence
// ---------------------------------------------------------------------------

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

describe('user assets: user-assets-migrate', () => {
  let tmp: string;
  let dataRoot: string;
  let containerHome: string;
  let hostHome: string;
  let user: MigrationUser;
  let idle: boolean | null;
  let mountedKinds: string[];
  let scriptCalls: string[];

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'enkeep-user-assets-migrate-')));
    dataRoot = join(tmp, 'data');
    containerHome = join(tmp, 'container-home');
    hostHome = join(dataRoot, 'host-runtimes', 'alice', '.dsh');
    mkdirSync(join(hostHome, 'memory'), { recursive: true });
    mkdirSync(join(containerHome, '.dsh'), { recursive: true });
    user = {
      platformUserId: '11111111-1111-4111-8111-111111111111',
      username: 'alice',
      runtimeIdentity: 'alice_1a2b3c4d',
      containerName: 'enkeep-demo-alice_1a2b3c4d',
      volumeName: 'enkeep-demo-dsh-alice_1a2b3c4d',
    };
    idle = true;
    mountedKinds = [];
    scriptCalls = [];
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function deps(): UserAssetMigrationDeps {
    return {
      async inspectContainer() {
        return { containerId: CONTAINER_ID, running: true, volumeId: VOLUME_ID, userAssetMountKinds: mountedKinds };
      },
      async isRuntimeIdle() {
        return idle;
      },
      async runContainerScript(_id, op, args) {
        scriptCalls.push(op);
        // Same script the CLI runs inside the container, here against a synthetic home.
        const out = execFileSync(process.execPath, ['-e', CONTAINER_MIGRATION_SCRIPT, op, containerHome, JSON.stringify(args)], { encoding: 'utf8' });
        return JSON.parse(out);
      },
      now: () => new Date('2026-01-02T03:04:05.000Z'),
    };
  }

  function seedSame() {
    for (const root of [join(hostHome, 'memory'), join(containerHome, '.dsh', 'memory')]) {
      mkdirSync(join(root, 'topics'), { recursive: true });
      writeFileSync(join(root, 'global.md'), '# Global\nsame\n');
      writeFileSync(join(root, 'topics', 'a.md'), 'topic');
    }
    // legacy mirror at /home/dsh/memory
    mkdirSync(join(containerHome, 'memory'), { recursive: true });
    writeFileSync(join(containerHome, 'memory', 'global.md'), '# Global\nsame\n');
  }

  const run = (dryRun: boolean, extra: { archiveDivergent?: boolean } = {}) =>
    runUserAssetMigration({ dataRoot, users: [user], dryRun, deps: deps(), ...extra });

  it('consistent copies: archives container copies (and legacy /home/dsh/memory) and writes the marker', async () => {
    seedSame();
    const [r] = await run(false);
    expect(r.outcome).toBe('converged');
    expect(r.comparisons.map((c) => [c.asset, c.status])).toEqual([
      ['memory', 'identical'],
      ['skills', 'absent'],
      ['agents_md', 'absent'],
      ['legacy_memory', 'legacy'],
    ]);
    expect(r.archived).toEqual(['.dsh/memory', 'memory']);
    expect(existsSync(join(containerHome, '.dsh', 'memory'))).toBe(false);
    expect(existsSync(join(containerHome, 'memory'))).toBe(false);
    const archiveDir = join(containerHome, '.enkeep-archive', 'user-assets-single-copy', '20260102T030405Z');
    expect(readdirSync(archiveDir).sort()).toEqual(['dsh-memory', 'memory']);
    expect(readFileSync(join(archiveDir, 'dsh-memory', 'topics', 'a.md'), 'utf8')).toBe('topic');
    // Host copy untouched
    expect(readFileSync(join(hostHome, 'memory', 'global.md'), 'utf8')).toBe('# Global\nsame\n');
    const marker = readMigrationMarker(dataRoot, user.volumeName);
    expect(marker).toMatchObject({ status: 'converged', volumeId: VOLUME_ID, archiveDir: '.enkeep-archive/user-assets-single-copy/20260102T030405Z' });
  });

  it('treats a container copy that is a subset of the host copy, or only the default skeleton, as converged', async () => {
    writeFileSync(join(hostHome, 'memory', 'global.md'), 'host has more');
    writeFileSync(join(hostHome, 'memory', 'extra.md'), 'host only');
    mkdirSync(join(containerHome, '.dsh', 'memory'));
    writeFileSync(join(containerHome, '.dsh', 'memory', 'global.md'), DEFAULT_GLOBAL_MEMORY_SKELETON);
    const [r] = await run(false);
    expect(r.outcome).toBe('converged');
    expect(r.comparisons[0].status).toBe('skeleton_only');
  });

  it('divergent copies: reports relative paths and sizes, changes nothing, writes no marker', async () => {
    seedSame();
    writeFileSync(join(containerHome, '.dsh', 'memory', 'global.md'), '# Global\ncontainer edit\n');
    writeFileSync(join(containerHome, '.dsh', 'memory', 'INDEX.md'), 'index');
    mkdirSync(join(containerHome, '.dsh', 'skills', 'demo-skill'), { recursive: true });
    writeFileSync(join(containerHome, '.dsh', 'skills', 'demo-skill', 'SKILL.md'), 'skill');
    const [r] = await run(false);
    expect(r.outcome).toBe('divergent');
    const mem = r.comparisons.find((c) => c.asset === 'memory')!;
    expect(mem.status).toBe('divergent');
    expect(mem.onlyInContainer).toEqual([{ path: 'INDEX.md', size: 5 }]);
    expect(mem.differing).toEqual([{ path: 'global.md', containerSize: 24, hostSize: 14 }]);
    expect(r.comparisons.find((c) => c.asset === 'skills')!.status).toBe('divergent');
    expect(r.archived).toEqual([]);
    expect(scriptCalls).toEqual(['manifest']);
    expect(existsSync(join(containerHome, '.dsh', 'memory', 'INDEX.md'))).toBe(true);
    expect(existsSync(join(containerHome, 'memory'))).toBe(true);
    expect(readMigrationMarker(dataRoot, user.volumeName)).toBeNull();
    const text = formatMigrationReport([r], false);
    expect(text).toContain('only in container: INDEX.md (5 B)');
    expect(text).toContain('differs: global.md (container 24 B, host 14 B)');
    expect(text).not.toContain('container edit');
  });

  it('divergent copies with --archive-divergent: archives the container copy, never overwrites the host', async () => {
    seedSame();
    writeFileSync(join(containerHome, '.dsh', 'memory', 'global.md'), 'container edit');
    const [r] = await run(false, { archiveDivergent: true });
    expect(r.outcome).toBe('converged');
    expect(readFileSync(join(hostHome, 'memory', 'global.md'), 'utf8')).toBe('# Global\nsame\n');
    expect(readMigrationMarker(dataRoot, user.volumeName)?.divergentArchived).toEqual(['memory']);
    expect(existsSync(join(containerHome, '.dsh', 'memory'))).toBe(false);
  });

  it('dry-run changes nothing and does not require idleness', async () => {
    seedSame();
    idle = false;
    const [r] = await run(true);
    expect(r.outcome).toBe('would_converge');
    expect(r.archived).toEqual(['.dsh/memory', 'memory']);
    expect(scriptCalls).toEqual(['manifest']);
    expect(existsSync(join(containerHome, '.dsh', 'memory', 'global.md'))).toBe(true);
    expect(existsSync(migrationMarkerPath(dataRoot, user.volumeName))).toBe(false);
  });

  it('is idempotent: a second run is a no-op once converged', async () => {
    seedSame();
    expect((await run(false))[0].outcome).toBe('converged');
    scriptCalls = [];
    const [again] = await run(false);
    expect(again.outcome).toBe('already_converged');
    expect(scriptCalls).toEqual([]);
    const [dry] = await run(true);
    expect(dry.outcome).toBe('already_converged');
  });

  it('a marker for an older volume id does not count', async () => {
    seedSame();
    writeMigrationMarker(dataRoot, {
      version: 1, status: 'converged', volumeName: user.volumeName, volumeId: OTHER_VOLUME_ID, runtimeIdentity: user.runtimeIdentity,
      migratedAt: new Date(0).toISOString(), archiveDir: null, assets: {}, divergentArchived: [],
    });
    expect((await run(false))[0].outcome).toBe('converged');
    expect(readMigrationMarker(dataRoot, user.volumeName)?.volumeId).toBe(VOLUME_ID);
  });

  it('refuses to touch a busy runtime or a container that already has the mounts', async () => {
    seedSame();
    idle = false;
    expect((await run(false))[0].outcome).toBe('busy');
    idle = null;
    expect((await run(false))[0].outcome).toBe('busy');
    idle = true;
    mountedKinds = ['memory'];
    // dry-run reports it and writes nothing
    expect((await run(true))[0].outcome).toBe('already_mounted');
    expect(readMigrationMarker(dataRoot, user.volumeName)).toBeNull();
    const [mounted] = await run(false);
    expect(mounted.outcome).toBe('already_mounted');
    expect(scriptCalls).toEqual([]);
    expect(existsSync(join(containerHome, '.dsh', 'memory'))).toBe(true);
    // The volume is served from the host copy: the marker is backfilled so no rebuild drops the mounts
    expect(mounted.markerPath).toBe(migrationMarkerPath(dataRoot, user.volumeName));
    expect(readMigrationMarker(dataRoot, user.volumeName)).toMatchObject({ status: 'converged', origin: 'already_mounted', volumeId: VOLUME_ID });
    expect((await run(false))[0].outcome).toBe('already_converged');
  });

  it('treats symlinks in the container copy as divergent and the script refuses unsafe moves', async () => {
    mkdirSync(join(containerHome, '.dsh', 'memory'));
    symlinkSync('/etc/hostname', join(containerHome, '.dsh', 'memory', 'global.md'));
    const [r] = await run(false);
    expect(r.outcome).toBe('divergent');

    const tryScript = (op: string, args: unknown) => {
      try {
        execFileSync(process.execPath, ['-e', CONTAINER_MIGRATION_SCRIPT, op, containerHome, JSON.stringify(args)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        return 'ok';
      } catch (e: any) {
        return JSON.parse(e.stdout).error;
      }
    };
    expect(tryScript('manifest', ['../etc'])).toBe('path not allowed');
    expect(tryScript('archive', [{ from: '.dsh/memory', to: '../outside' }])).toBe('archive target not allowed');
    expect(tryScript('archive', [{ from: '.ssh', to: '.enkeep-archive/x' }])).toBe('move not allowed');
    expect(tryScript('rm', [])).toBe('unknown op');
  });

  it('reports users without a container or host home without failing others', async () => {
    const d = deps();
    const r = await runUserAssetMigration({
      dataRoot,
      dryRun: false,
      users: [{ ...user, username: 'Not Valid' }, user],
      deps: { ...d, inspectContainer: async () => null },
    });
    expect(r.map((x) => x.outcome)).toEqual(['no_host_home', 'no_container']);
  });
});
