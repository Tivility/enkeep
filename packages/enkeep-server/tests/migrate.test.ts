/**
 * migrateDataDir: copies demo-named home volumes into production volumes, verifies them, and only
 * then switches metadata, removes the old containers and renames the data directory.
 * Synthetic data only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  writeSignedContainerMeta,
  writeSignedVolumeMeta,
  readSignedVolumeMeta,
  isProductionDataDir,
  resetCachedSecrets,
} from '@enkeep/demo-runner';
import { migrateDataDir, revertDataDirMigration, type DockerExec } from '../src/migrate.js';

interface FakeVolume {
  labels: Record<string, string>;
  files: string;
}

function fakeDocker(volumes: Map<string, FakeVolume>, containers: Map<string, string>, options: { corruptCopy?: boolean } = {}) {
  const calls: string[][] = [];
  const docker: DockerExec = async (args) => {
    calls.push([...args]);
    const [cmd, sub] = args;
    if (cmd === 'volume' && sub === 'inspect') {
      const v = volumes.get(args[2]!);
      if (!v) throw new Error('no such volume');
      return JSON.stringify([{ Name: args[2], Labels: v.labels }]);
    }
    if (cmd === 'volume' && sub === 'create') {
      const name = args[args.length - 1]!;
      const labels: Record<string, string> = {};
      for (let i = 2; i < args.length - 1; i += 2) {
        const [k, v] = args[i + 1]!.split('=');
        labels[k!] = v!;
      }
      volumes.set(name, { labels, files: '' });
      return name;
    }
    if (cmd === 'run') {
      const mounts = args.filter((a, i) => args[i - 1] === '-v');
      const script = args[args.length - 1]!;
      if (script.startsWith('cp -a')) {
        const src = mounts[0]!.split(':')[0]!;
        const dst = mounts[1]!.split(':')[0]!;
        volumes.get(dst)!.files = options.corruptCopy ? 'truncated' : volumes.get(src)!.files;
        return '';
      }
      return `digest:${volumes.get(mounts[0]!.split(':')[0]!)!.files}`;
    }
    if (cmd === 'inspect') {
      const id = containers.get(args[args.length - 1]!);
      if (!id) throw new Error('no such container');
      return JSON.stringify([{ Id: id }]);
    }
    if (cmd === 'rm') {
      for (const [name, id] of containers) if (id === args[2]) containers.delete(name);
      return '';
    }
    throw new Error(`unexpected docker ${args.join(' ')}`);
  };
  return { docker, calls };
}

describe('migrateDataDir', () => {
  let root: string;
  let from: string;
  let to: string;
  let containerId: string;
  const volumeId = 'vol_0123456789abcdef0123456789abcdef';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'enkeep-migrate-'));
    from = join(root, 'checkout', '.demo-data');
    to = join(root, 'share', 'enkeep', 'data');
    mkdirSync(from, { recursive: true, mode: 0o700 });
    writeFileSync(join(from, 'platform.db'), 'synthetic-db');
    mkdirSync(join(from, 'host-runtimes', 'alice'), { recursive: true });
    writeFileSync(join(from, 'host-runtimes', 'alice', 'note.txt'), 'hello');
    const opts = { repoRoot: join(root, 'checkout') };
    containerId = randomBytes(32).toString('hex');
    writeSignedVolumeMeta({ userId: 'alice', volumeName: 'enkeep-demo-dsh-alice', volumeId, runId: 'run_test_001' }, opts);
    writeSignedVolumeMeta({ userId: 'bob', volumeName: 'enkeep-demo-dsh-bob-old', volumeId: 'vol_fedcba9876543210fedcba9876543210', runId: 'run_test_002' }, opts);
    writeSignedContainerMeta(
      { userId: 'alice', containerName: 'enkeep-demo-alice', containerId, volumeName: 'enkeep-demo-dsh-alice', volumeId, runId: 'run_test_001' },
      opts
    );
  });

  afterEach(() => {
    resetCachedSecrets({ repoRoot: join(root, 'checkout') });
    rmSync(root, { recursive: true, force: true });
  });

  function liveDocker(options?: { corruptCopy?: boolean }) {
    const volumes = new Map<string, FakeVolume>([
      ['enkeep-demo-dsh-alice', { labels: { app: 'enkeep-demo', 'enkeep.user': 'alice', 'enkeep.volume-id': volumeId }, files: 'alice-home' }],
    ]);
    const containers = new Map<string, string>([['enkeep-demo-alice', containerId]]);
    return { volumes, containers, ...fakeDocker(volumes, containers, options) };
  }

  it('plans without changing anything in dry-run mode', async () => {
    const { docker, calls } = liveDocker();
    const result = await migrateDataDir({ from, to, copyImage: 'enkeep-runtime:test', dryRun: true, docker, log: () => {} });
    expect(result.volumes.map((v) => [v.from, v.to, v.status])).toEqual([
      ['enkeep-demo-dsh-alice', 'enkeep-home-alice', 'planned'],
      ['enkeep-demo-dsh-bob-old', 'enkeep-home-bob-old', 'retired-missing'],
    ]);
    expect(existsSync(from)).toBe(true);
    expect(existsSync(to)).toBe(false);
    expect(isProductionDataDir(from)).toBe(false);
    expect(calls.every((c) => c[0] === 'volume' && c[1] === 'inspect')).toBe(true);
  });

  it('copies, verifies, switches metadata, removes the old container and moves the directory', async () => {
    const { docker, volumes, containers } = liveDocker();
    const result = await migrateDataDir({ from, to, copyImage: 'enkeep-runtime:test', linkOld: true, docker, log: () => {} });

    expect(result.volumes.find((v) => v.from === 'enkeep-demo-dsh-alice')?.status).toBe('copied');
    expect(volumes.get('enkeep-home-alice')).toEqual({
      labels: { app: 'enkeep', 'enkeep.env': 'production', 'enkeep.user': 'alice', 'enkeep.volume-id': volumeId },
      files: 'alice-home',
    });
    // The old volume is kept as a backup.
    expect(volumes.has('enkeep-demo-dsh-alice')).toBe(true);
    expect(containers.has('enkeep-demo-alice')).toBe(false);
    expect(result.removedContainers).toEqual(['enkeep-demo-alice']);

    expect(lstatSync(from).isSymbolicLink()).toBe(true);
    expect(readlinkSync(from)).toBe(to);
    expect(isProductionDataDir(to)).toBe(true);
    expect(existsSync(join(to, 'host-runtimes', 'alice', 'note.txt'))).toBe(true);
    expect(readdirSync(join(to, 'containers'))).toEqual([]);
    expect(readdirSync(join(to, 'containers-retired'))).toEqual(['enkeep-demo-alice.json']);
    expect(readdirSync(join(to, 'volumes')).sort()).toEqual(['enkeep-home-alice.json']);
    expect(readdirSync(join(to, 'volumes-retired')).sort()).toEqual(['enkeep-demo-dsh-alice.json', 'enkeep-demo-dsh-bob-old.json']);
    const meta = readSignedVolumeMeta('enkeep-home-alice', { repoRoot: root, dataRoot: to, mode: 'production' });
    expect(meta?.volumeId).toBe(volumeId);
    expect(meta?.labels.app).toBe('enkeep');
  });

  it('switches nothing when a copy does not verify', async () => {
    const { docker, containers } = liveDocker({ corruptCopy: true });
    await expect(migrateDataDir({ from, to, copyImage: 'enkeep-runtime:test', docker, log: () => {} })).rejects.toThrow(/does not verify/);
    expect(lstatSync(from).isDirectory()).toBe(true);
    expect(existsSync(to)).toBe(false);
    expect(containers.has('enkeep-demo-alice')).toBe(true);
    expect(existsSync(join(from, 'containers', 'enkeep-demo-alice.json'))).toBe(true);
    expect(existsSync(join(from, 'volumes', 'enkeep-demo-dsh-alice.json'))).toBe(true);
  });

  it('refuses while the platform process is alive', async () => {
    const { docker } = liveDocker();
    const { writeSignedProcessMeta } = await import('@enkeep/demo-runner');
    writeSignedProcessMeta({ service: 'platform-server', pid: process.pid }, { repoRoot: join(root, 'checkout') });
    await expect(migrateDataDir({ from, to, copyImage: 'enkeep-runtime:test', docker, log: () => {} })).rejects.toThrow(/still running/);
    expect(existsSync(to)).toBe(false);
  });

  it('refuses a volume whose labels do not match its signed metadata', async () => {
    const { docker, volumes } = liveDocker();
    volumes.get('enkeep-demo-dsh-alice')!.labels['enkeep.user'] = 'mallory';
    await expect(migrateDataDir({ from, to, copyImage: 'enkeep-runtime:test', docker, log: () => {} })).rejects.toThrow(/owner and volume-id/);
  });

  it('reverts a migration: directory and demo metadata back, production metadata retired', async () => {
    const { docker } = liveDocker();
    await migrateDataDir({ from, to, copyImage: 'enkeep-runtime:test', linkOld: true, docker, log: () => {} });
    revertDataDirMigration({ original: from, migrated: to, log: () => {} });
    expect(lstatSync(from).isDirectory()).toBe(true);
    expect(existsSync(to)).toBe(false);
    expect(readdirSync(join(from, 'containers'))).toEqual(['enkeep-demo-alice.json']);
    expect(readdirSync(join(from, 'volumes')).sort()).toEqual(['enkeep-demo-dsh-alice.json', 'enkeep-demo-dsh-bob-old.json']);
    expect(readdirSync(join(from, 'volumes-retired-production'))).toEqual(['enkeep-home-alice.json']);
  });
});
