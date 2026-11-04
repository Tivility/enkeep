/**
 * Moving a deployment's data directory out of a repository checkout and renaming its runtimes from
 * the demo namespace (`enkeep-demo-*`, `enkeep-demo-dsh-*`) to the production namespace
 * (`enkeep-runtime-*`, `enkeep-home-*`).
 *
 * Runs with the platform stopped. Docker volumes cannot be renamed, so each home volume is copied
 * into a new production volume and verified (file list and sizes); the old volume is kept untouched
 * as a backup. Nothing is switched until every copy verified: on any failure before the switch the
 * data directory and metadata are exactly as before.
 *
 * Switch, in order: mark the directory as production, remove the old runtime containers (their data
 * lives in the volumes), sign production volume metadata and retire the demo metadata, rename the
 * directory (same filesystem, atomic), and optionally leave a symlink at the old path so absolute
 * paths recorded in old sessions keep resolving.
 *
 * @module @enkeep/server/migrate
 */

import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  PRODUCTION_RESOURCE_NAMESPACE,
  TEST_RESOURCE_NAMESPACE,
  DEMO_LABEL_KEY,
  ENV_LABEL_KEY,
  USER_LABEL_KEY,
  VOLUME_ID_LABEL_KEY,
  namespaceOfContainerName,
  namespaceOfVolumeName,
  writeProductionMarker,
  isProductionDataDir,
  listSignedProcesses,
  listSignedContainers,
  listSignedVolumes,
  writeSignedVolumeMeta,
  type DemoPathOptions,
} from '@enkeep/demo-runner';
import { isProcessAlive } from '@enkeep/runtime-runner';

/** Runs `docker <args>` and resolves stdout. */
export type DockerExec = (args: readonly string[]) => Promise<string>;

export interface MigrateDataDirOptions {
  /** Current data directory (a real directory, typically `<repo>/.demo-data`). */
  from: string;
  /** New data directory; must not exist; its parent must be on the same filesystem as `from`. */
  to: string;
  /** Image providing `sh`, `cp`, `find`, `sort`, `stat` and `md5sum`, used for volume copies. */
  copyImage: string;
  /** Leave a symlink at `from` pointing to `to` (keeps absolute paths in old sessions valid). */
  linkOld?: boolean;
  /** Only report the plan. */
  dryRun?: boolean;
  /**
   * Independent backup taken with the platform stopped and before any change: a SQLite online
   * backup of platform.db (`<backupDir>/platform.db.backup`) and a clone of the whole data
   * directory (`<backupDir>/data`, APFS clone where supported). Must not exist; same filesystem.
   */
  backupDir?: string;
  docker?: DockerExec;
  /** Copies a directory tree (default: `cp -cR`, falling back to `cp -a`). */
  cloneDir?: (from: string, to: string) => Promise<void>;
  log?: (line: string) => void;
}

const defaultCloneDir = (from: string, to: string): Promise<void> =>
  new Promise((resolvePromise, reject) => {
    execFile('cp', ['-cR', from, to], { timeout: 6 * 60 * 60 * 1000 }, (error) => {
      if (!error) return resolvePromise();
      execFile('cp', ['-a', from, to], { timeout: 6 * 60 * 60 * 1000 }, (fallbackError, _stdout, stderr) => {
        if (fallbackError) reject(new Error(`copying ${from} failed: ${String(stderr || fallbackError.message).trim()}`));
        else resolvePromise();
      });
    });
  });

/** Online-backup `dbPath` into `dest` and check the copy. */
async function backupDatabase(dbPath: string, dest: string): Promise<void> {
  const sqlite = (await import('node:sqlite')) as typeof import('node:sqlite') & {
    backup?: (db: import('node:sqlite').DatabaseSync, path: string) => Promise<number>;
  };
  const source = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    if (typeof sqlite.backup === 'function') await sqlite.backup(source, dest);
    else source.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }
  const copy = new sqlite.DatabaseSync(dest, { readOnly: true });
  try {
    const row = copy.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
    const verdict = row ? String(Object.values(row)[0]) : 'no result';
    if (verdict !== 'ok') throw new Error(`database backup failed its check: ${verdict}`);
  } finally {
    copy.close();
  }
}

function nearestExistingDev(path: string): number {
  let cur = path;
  while (!existsSync(cur) && dirname(cur) !== cur) cur = dirname(cur);
  return statSync(cur).dev;
}

export interface VolumeMove {
  userId: string;
  from: string;
  to: string;
  volumeId: string;
  runId: string;
  status: 'planned' | 'copied' | 'already-copied' | 'retired-missing';
}

export interface MigrateDataDirResult {
  dryRun: boolean;
  from: string;
  to: string;
  volumes: VolumeMove[];
  removedContainers: string[];
  linkedOld: boolean;
}

const defaultDocker: DockerExec = (args) =>
  new Promise((resolvePromise, reject) => {
    execFile('docker', [...args], { timeout: 6 * 60 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`docker ${args[0]} failed: ${String(stderr || error.message).trim()}`));
      else resolvePromise(String(stdout));
    });
  });

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function inspectVolumeLabels(docker: DockerExec, name: string): Promise<Record<string, string> | null> {
  try {
    const raw = JSON.parse(await docker(['volume', 'inspect', name])) as Array<{ Labels?: Record<string, string> | null }>;
    return raw[0]?.Labels ?? {};
  } catch {
    return null;
  }
}

/**
 * Digest of a volume's whole tree: every entry's path, type and mode, owner and size, every symlink
 * target, and the md5 of every regular file's content (reads all data).
 */
export const VOLUME_DIGEST_SCRIPT =
  'cd /v && { ' +
  'find . -exec stat -c "%n|%f|%u|%g|%s" {} + | LC_ALL=C sort; ' +
  'find . -type l -exec sh -c \'for l; do printf "%s -> %s\\n" "$l" "$(readlink "$l")"; done\' sh {} + | LC_ALL=C sort; ' +
  'find . -type f -exec md5sum {} + | LC_ALL=C sort -k2; ' +
  '} | md5sum && find . -type f | wc -l && du -sk . | cut -f1';

async function volumeDigest(docker: DockerExec, image: string, volume: string): Promise<string> {
  const script = VOLUME_DIGEST_SCRIPT;
  return (
    await docker(['run', '--rm', '--network', 'none', '--user', '0:0', '--entrypoint', 'sh', '-v', `${volume}:/v:ro`, image, '-c', script])
  ).trim();
}

/**
 * Plans and, unless `dryRun`, performs the move. Throws before the switch on any problem, leaving
 * the deployment as it was (new volumes that were created stay, unattached, for inspection).
 */
export async function migrateDataDir(options: MigrateDataDirOptions): Promise<MigrateDataDirResult> {
  const docker = options.docker ?? defaultDocker;
  const log = options.log ?? ((line: string) => console.log(line));
  if (!isAbsolute(options.from) || !isAbsolute(options.to)) throw new Error('--from and --to must be absolute paths');
  const from = resolve(options.from);
  const to = resolve(options.to);
  if (!options.copyImage) throw new Error('--copy-image is required');

  // 0. Paths.
  if (!existsSync(from)) throw new Error(`Data directory not found: ${from}`);
  const fromStat = lstatSync(from);
  if (fromStat.isSymbolicLink() || !fromStat.isDirectory()) throw new Error(`${from} must be a real directory (not a symlink)`);
  if (existsSync(to)) throw new Error(`Target already exists: ${to}`);
  if (isInside(to, from) || isInside(from, to)) throw new Error('--from and --to must not contain each other');
  if (!existsSync(join(from, 'platform.db'))) throw new Error(`${from} has no platform.db; not a platform data directory`);
  const parent = dirname(to);
  if (!options.dryRun) mkdirSync(parent, { recursive: true, mode: 0o700 });
  // The nearest existing ancestor of the target decides the filesystem (a dry run creates nothing).
  let existingAncestor = parent;
  while (!existsSync(existingAncestor) && dirname(existingAncestor) !== existingAncestor) existingAncestor = dirname(existingAncestor);
  const parentDev = statSync(existingAncestor).dev;
  if (parentDev !== fromStat.dev) throw new Error(`${to} is on a different filesystem than ${from}; only an atomic rename is supported`);

  // 1. The platform must be stopped.
  const pathOptions: DemoPathOptions = { repoRoot: dirname(from), dataRoot: from, mode: 'production' };
  const wasMarked = isProductionDataDir(from);
  if (!wasMarked && resolve(dirname(from), '.demo-data') !== from) {
    throw new Error(`${from} must be marked as production or be <repo>/.demo-data`);
  }
  const readOptions: DemoPathOptions = wasMarked ? pathOptions : { repoRoot: dirname(from) };
  const live = listSignedProcesses(readOptions).filter((p) => isProcessAlive(p.pid));
  if (live.length > 0) {
    throw new Error(`Platform processes are still running (${live.map((p) => `${p.service}:${p.pid}`).join(', ')}); stop the platform first`);
  }

  // 1b. Independent backup before anything changes.
  if (options.backupDir) {
    const backupDir = resolve(options.backupDir);
    if (!isAbsolute(options.backupDir)) throw new Error('--backup-dir must be an absolute path');
    if (existsSync(backupDir)) throw new Error(`Backup directory already exists: ${backupDir}`);
    if (isInside(backupDir, from) || isInside(backupDir, to)) throw new Error('--backup-dir must be outside --from and --to');
    if (nearestExistingDev(backupDir) !== fromStat.dev) throw new Error(`${backupDir} is on a different filesystem than ${from}`);
    if (options.dryRun) {
      log(`  backup: platform.db -> ${join(backupDir, 'platform.db.backup')}, ${from} -> ${join(backupDir, 'data')}`);
    } else {
      mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      await backupDatabase(join(from, 'platform.db'), join(backupDir, 'platform.db.backup'));
      log(`  backup: ${join(backupDir, 'platform.db.backup')} written and checked`);
      await (options.cloneDir ?? defaultCloneDir)(from, join(backupDir, 'data'));
      if (!existsSync(join(backupDir, 'data', 'platform.db'))) throw new Error('data directory backup is incomplete');
      log(`  backup: ${join(backupDir, 'data')} cloned`);
    }
  }

  if (!options.dryRun && !wasMarked) writeProductionMarker(from);

  // 2. Plan: every demo-named home volume referenced by signed metadata.
  const containers = listSignedContainers(readOptions).filter((c) => namespaceOfContainerName(c.containerName) === TEST_RESOURCE_NAMESPACE);
  const byVolume = new Map<string, VolumeMove>();
  for (const v of listSignedVolumes(readOptions)) {
    if (namespaceOfVolumeName(v.volumeName) !== TEST_RESOURCE_NAMESPACE) continue;
    byVolume.set(v.volumeName, {
      userId: v.userId,
      from: v.volumeName,
      to: PRODUCTION_RESOURCE_NAMESPACE.volumePrefix + v.volumeName.slice(TEST_RESOURCE_NAMESPACE.volumePrefix.length),
      volumeId: v.volumeId,
      runId: v.runId,
      status: 'planned',
    });
  }
  for (const c of containers) {
    if (!byVolume.has(c.volumeName) && namespaceOfVolumeName(c.volumeName) === TEST_RESOURCE_NAMESPACE) {
      byVolume.set(c.volumeName, {
        userId: c.userId,
        from: c.volumeName,
        to: PRODUCTION_RESOURCE_NAMESPACE.volumePrefix + c.volumeName.slice(TEST_RESOURCE_NAMESPACE.volumePrefix.length),
        volumeId: c.volumeId,
        runId: c.runId,
        status: 'planned',
      });
    }
  }
  const volumes = [...byVolume.values()];

  for (const v of volumes) {
    const labels = await inspectVolumeLabels(docker, v.from);
    if (labels === null) {
      v.status = 'retired-missing';
      log(`  volume ${v.from}: no Docker volume; its metadata will be retired`);
      continue;
    }
    if (labels[USER_LABEL_KEY] !== v.userId || labels[VOLUME_ID_LABEL_KEY] !== v.volumeId) {
      throw new Error(`Volume ${v.from} does not carry the owner and volume-id of its signed metadata; refusing`);
    }
    log(`  volume ${v.from} -> ${v.to}`);
  }
  for (const c of containers) log(`  container ${c.containerName}: removed at the switch (its data is in ${c.volumeName})`);

  if (options.dryRun) {
    log(`  directory ${from} -> ${to}${options.linkOld ? ' (symlink left at the old path)' : ''}`);
    return { dryRun: true, from, to, volumes, removedContainers: [], linkedOld: false };
  }

  // 3. Copy and verify every volume before changing anything.
  for (const v of volumes) {
    if (v.status === 'retired-missing') continue;
    const existing = await inspectVolumeLabels(docker, v.to);
    if (existing !== null) {
      const ownedByUs =
        existing[DEMO_LABEL_KEY] === PRODUCTION_RESOURCE_NAMESPACE.appLabel &&
        existing[ENV_LABEL_KEY] === PRODUCTION_RESOURCE_NAMESPACE.env &&
        existing[USER_LABEL_KEY] === v.userId &&
        existing[VOLUME_ID_LABEL_KEY] === v.volumeId;
      if (!ownedByUs) throw new Error(`Volume ${v.to} already exists and is not this deployment's copy; refusing`);
      if ((await volumeDigest(docker, options.copyImage, v.from)) === (await volumeDigest(docker, options.copyImage, v.to))) {
        v.status = 'already-copied';
        log(`  volume ${v.to}: already copied and verified`);
        continue;
      }
      throw new Error(`Volume ${v.to} exists but differs from ${v.from}; inspect it before retrying`);
    }
    await docker([
      'volume', 'create',
      '--label', `${DEMO_LABEL_KEY}=${PRODUCTION_RESOURCE_NAMESPACE.appLabel}`,
      '--label', `${ENV_LABEL_KEY}=${PRODUCTION_RESOURCE_NAMESPACE.env}`,
      '--label', `${USER_LABEL_KEY}=${v.userId}`,
      '--label', `${VOLUME_ID_LABEL_KEY}=${v.volumeId}`,
      v.to,
    ]);
    await docker([
      'run', '--rm', '--network', 'none', '--user', '0:0', '--entrypoint', 'sh',
      '-v', `${v.from}:/from:ro`, '-v', `${v.to}:/to`, options.copyImage,
      '-c', 'cp -a /from/. /to/ && sync',
    ]);
    const a = await volumeDigest(docker, options.copyImage, v.from);
    const b = await volumeDigest(docker, options.copyImage, v.to);
    if (a !== b) throw new Error(`Copy of ${v.from} to ${v.to} does not verify; nothing was switched`);
    v.status = 'copied';
    const [, files, kib] = a.split('\n').map((line) => line.trim());
    log(`  volume ${v.to}: copied and verified (content hash; ${files ?? '?'} files, ${kib ?? '?'} KiB)`);
  }

  // 4. Switch.
  const removedContainers: string[] = [];
  for (const c of containers) {
    let id: string | undefined;
    try {
      const raw = JSON.parse(await docker(['inspect', '--type', 'container', c.containerName])) as Array<{ Id?: string }>;
      id = raw[0]?.Id;
    } catch {
      id = undefined;
    }
    if (id && id !== c.containerId) throw new Error(`Container ${c.containerName} is not the one in its signed metadata; refusing`);
    if (id) {
      await docker(['rm', '-f', id]);
      removedContainers.push(c.containerName);
      log(`  container ${c.containerName}: removed`);
    }
  }

  const retire = (dir: string, name: string) => {
    const src = join(from, dir, `${name}.json`);
    if (!existsSync(src)) return;
    const dest = join(from, `${dir}-retired`);
    mkdirSync(dest, { recursive: true, mode: 0o700 });
    renameSync(src, join(dest, `${name}.json`));
  };
  for (const c of containers) retire('containers', c.containerName);
  for (const v of volumes) {
    if (v.status !== 'retired-missing') {
      writeSignedVolumeMeta({ userId: v.userId, volumeName: v.to, volumeId: v.volumeId, runId: v.runId }, pathOptions);
    }
    retire('volumes', v.from);
  }

  renameSync(from, to);
  let linkedOld = false;
  if (options.linkOld) {
    symlinkSync(to, from);
    linkedOld = true;
  }
  log(`  directory ${from} -> ${to}${linkedOld ? ' (symlink left at the old path)' : ''}`);
  return { dryRun: false, from, to, volumes, removedContainers, linkedOld };
}

export interface RevertDataDirOptions {
  /** The original path, now a symlink to `migrated`. */
  original: string;
  /** The data directory the migration moved to. */
  migrated: string;
  docker?: DockerExec;
  log?: (line: string) => void;
}

/**
 * Undoes `migrateDataDir` with the platform stopped: moves the directory back, restores the retired
 * demo metadata and retires the production volume metadata. Volumes are not touched: the demo
 * volumes were never modified and the production copies stay for inspection. The old platform
 * recreates its runtime containers from the restored metadata.
 */
export async function revertDataDirMigration(options: RevertDataDirOptions): Promise<void> {
  const log = options.log ?? ((line: string) => console.log(line));
  const docker = options.docker ?? defaultDocker;
  const original = resolve(options.original);
  const migrated = resolve(options.migrated);
  if (!existsSync(original) || !lstatSync(original).isSymbolicLink()) throw new Error(`${original} is not the symlink left by the migration`);
  if (resolve(dirname(original), readlinkSync(original)) !== migrated) throw new Error(`${original} does not point to ${migrated}`);
  if (!lstatSync(migrated).isDirectory()) throw new Error(`${migrated} is not a directory`);
  const migratedOptions: DemoPathOptions = { repoRoot: dirname(migrated), dataRoot: migrated, mode: 'production' };
  const live = listSignedProcesses(migratedOptions).filter((p) => isProcessAlive(p.pid));
  if (live.length > 0) throw new Error('Platform processes are still running; stop the platform first');

  // Runtime containers the production platform created are stopped; their volumes stay.
  for (const c of listSignedContainers(migratedOptions)) {
    if (namespaceOfContainerName(c.containerName) !== PRODUCTION_RESOURCE_NAMESPACE) continue;
    let id: string | undefined;
    try {
      id = (JSON.parse(await docker(['inspect', '--type', 'container', c.containerName])) as Array<{ Id?: string }>)[0]?.Id;
    } catch {
      id = undefined;
    }
    if (id && id === c.containerId) {
      await docker(['rm', '-f', id]);
      log(`  container ${c.containerName}: removed`);
    }
  }

  unlinkSync(original);
  renameSync(migrated, original);
  const move = (fromDir: string, toDir: string, accept: (name: string) => boolean) => {
    const src = join(original, fromDir);
    if (!existsSync(src)) return;
    mkdirSync(join(original, toDir), { recursive: true, mode: 0o700 });
    for (const file of readdirSync(src)) {
      if (!file.endsWith('.json') || !accept(file.slice(0, -'.json'.length))) continue;
      renameSync(join(src, file), join(original, toDir, file));
    }
  };
  move('volumes', 'volumes-retired-production', (name) => namespaceOfVolumeName(name) === PRODUCTION_RESOURCE_NAMESPACE);
  move('containers', 'containers-retired-production', (name) => namespaceOfContainerName(name) === PRODUCTION_RESOURCE_NAMESPACE);
  move('volumes-retired', 'volumes', (name) => namespaceOfVolumeName(name) === TEST_RESOURCE_NAMESPACE);
  move('containers-retired', 'containers', (name) => namespaceOfContainerName(name) === TEST_RESOURCE_NAMESPACE);
  log(`  directory ${migrated} -> ${original}; demo runtime metadata restored`);
}
