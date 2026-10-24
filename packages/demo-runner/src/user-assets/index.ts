/**
 * User-Level Assets: Single Host Copy for Container Runtimes
 *
 * - Desired mounts: which read-only user asset mounts a user's container should get.
 * - Migration markers: per-volume record that the one-time convergence ran.
 * - One-time convergence (`user-assets-migrate`): compare the container volume's old copies
 *   with the host copy, archive identical ones inside the volume, report divergent ones.
 *
 * @module @enkeep/demo-runner/user-assets
 */

import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, isAbsolute, normalize, relative, sep } from 'node:path';
import {
  resolveUserAssetMounts,
  userAssetMountsEnabled,
  type RuntimeUserAssetMount,
  type UserAssetMountResolution,
} from '@enkeep/runtime-runner';

export const HOST_USERNAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const USER_ASSET_MIGRATIONS_DIR = 'user-assets-migrations';
export const USER_ASSET_MIGRATION_MARKER_VERSION = 1;
const VOLUME_NAME_REGEX = /^enkeep-demo-dsh-[a-z0-9][a-z0-9_-]{0,60}$/;
const VOLUME_ID_REGEX = /^vol_[0-9a-f]{32}$/;

/** Default global.md skeleton written by dsh-memory when no memory exists yet. */
export const DEFAULT_GLOBAL_MEMORY_SKELETON =
  '# Global Memory\n\nThis is your long-term memory across all spaces and sessions.\n';

/**
 * Host DSH home for a platform username: `<dataRoot>/host-runtimes/<username>/.dsh`.
 * Returns undefined when the username cannot name a host runtime directory.
 */
export function hostDshHomeForUsername(dataRoot: string, username: string | null | undefined): string | undefined {
  if (!dataRoot || !isAbsolute(dataRoot)) return undefined;
  if (typeof username !== 'string' || !HOST_USERNAME_REGEX.test(username)) return undefined;
  return join(normalize(dataRoot), 'host-runtimes', username, '.dsh');
}

/**
 * How a volume came to be served from the host copy:
 * - `migration`: `user-assets-migrate` converged the volume's own copies;
 * - `new_volume`: the volume was created with the mounts (it never had its own copy);
 * - `observed_mounted`: the platform found a running container of this volume already mounted;
 * - `already_mounted`: `user-assets-migrate` found the container already mounted.
 */
export type UserAssetMarkerOrigin = 'migration' | 'new_volume' | 'observed_mounted' | 'already_mounted';

export interface UserAssetMigrationMarker {
  readonly version: number;
  /**
   * `converged`: mounts are enabled for this volume (every start, restart, upgrade and rebuild).
   * `suspended`: the kill switch rebuilt the container without mounts; the volume keeps local
   * copies again, so re-enabling requires running `user-assets-migrate` first.
   */
  readonly status: 'converged' | 'suspended';
  readonly origin?: UserAssetMarkerOrigin;
  readonly volumeName: string;
  readonly volumeId: string;
  readonly runtimeIdentity: string;
  readonly migratedAt: string;
  readonly suspendedAt?: string;
  readonly archiveDir: string | null;
  readonly assets: Readonly<Record<string, AssetComparisonStatus>>;
  readonly divergentArchived: readonly string[];
}

export function migrationMarkerPath(dataRoot: string, volumeName: string): string {
  if (!VOLUME_NAME_REGEX.test(volumeName)) {
    throw new Error('Invalid volume name for user asset migration marker');
  }
  return join(dataRoot, USER_ASSET_MIGRATIONS_DIR, `${volumeName}.json`);
}

/**
 * Reads the converged marker for a volume. Returns null when absent, malformed, or suspended.
 */
export function readMigrationMarker(dataRoot: string, volumeName: string): UserAssetMigrationMarker | null {
  const p = migrationMarkerPath(dataRoot, volumeName);
  try {
    const st = lstatSync(p);
    if (!st.isFile()) return null;
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    if (
      parsed &&
      parsed.version === USER_ASSET_MIGRATION_MARKER_VERSION &&
      parsed.status === 'converged' &&
      parsed.volumeName === volumeName &&
      typeof parsed.volumeId === 'string' &&
      VOLUME_ID_REGEX.test(parsed.volumeId)
    ) {
      return parsed as UserAssetMigrationMarker;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeMigrationMarker(dataRoot: string, marker: UserAssetMigrationMarker): string {
  const dir = join(dataRoot, USER_ASSET_MIGRATIONS_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = migrationMarkerPath(dataRoot, marker.volumeName);
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(marker, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, p);
  return p;
}

/**
 * Persists the decision that a volume is served from the host copy. Must run as soon as mounts
 * are decided for a volume (before the container is created) so that no later restart,
 * upgrade or rebuild drops the mounts. No-op when a converged marker for the same volume id
 * already exists. Returns the marker path.
 */
export function recordUserAssetMountsEnabled(
  dataRoot: string,
  input: {
    readonly volumeName: string;
    readonly volumeId: string;
    readonly runtimeIdentity: string;
    readonly origin: UserAssetMarkerOrigin;
    readonly now?: Date;
  }
): string {
  const existing = readMigrationMarker(dataRoot, input.volumeName);
  if (existing && existing.volumeId === input.volumeId) {
    return migrationMarkerPath(dataRoot, input.volumeName);
  }
  if (!VOLUME_ID_REGEX.test(input.volumeId)) {
    throw new Error('Invalid volume id for user asset migration marker');
  }
  return writeMigrationMarker(dataRoot, {
    version: USER_ASSET_MIGRATION_MARKER_VERSION,
    status: 'converged',
    origin: input.origin,
    volumeName: input.volumeName,
    volumeId: input.volumeId,
    runtimeIdentity: input.runtimeIdentity,
    migratedAt: (input.now ?? new Date()).toISOString(),
    archiveDir: null,
    assets: {},
    divergentArchived: [],
  });
}

/**
 * Kill switch: the container of this volume is being rebuilt without mounts, so the volume
 * gets local copies again. Marks the converged marker as suspended (kept for audit) so that
 * turning mounts back on goes through `user-assets-migrate` instead of silently hiding what
 * was written locally meanwhile. Returns true when a marker was suspended.
 */
export function suspendMigrationMarker(dataRoot: string, volumeName: string, volumeId: string, now: Date = new Date()): boolean {
  const existing = readMigrationMarker(dataRoot, volumeName);
  if (!existing || existing.volumeId !== volumeId) return false;
  writeMigrationMarker(dataRoot, { ...existing, status: 'suspended', suspendedAt: now.toISOString() });
  return true;
}

export type DesiredUserAssetReason =
  | 'disabled_by_env'
  | 'no_host_home'
  | 'new_volume'
  | 'migrated'
  | 'migration_pending';

export interface DesiredUserAssets {
  readonly enabled: boolean;
  readonly reason: DesiredUserAssetReason;
  readonly hostDshHome?: string;
  readonly mounts: RuntimeUserAssetMount[];
  readonly resolution?: UserAssetMountResolution;
}

/**
 * Decides the read-only user asset mounts for a container runtime.
 *
 * Mounts are enabled for a brand-new volume, or for an existing volume whose one-time
 * convergence marker matches its volume id. Otherwise the container keeps its old behavior
 * until `user-assets-migrate` has run.
 */
export function resolveDesiredUserAssets(input: {
  readonly dataRoot: string;
  readonly hostDshHome: string | undefined;
  readonly volumeName: string;
  readonly volumeId: string;
  readonly isNewVolume: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly hostPlatform?: NodeJS.Platform;
}): DesiredUserAssets {
  if (!userAssetMountsEnabled(input.env ?? process.env)) {
    // Kill switch: no mounts for containers created from now on. The host DSH home is still
    // reported so that a container that still runs with the mounts keeps its platform write
    // route (bound from its ACTUAL mounts) until it is rebuilt without them.
    return { enabled: false, reason: 'disabled_by_env', hostDshHome: input.hostDshHome, mounts: [] };
  }
  if (!input.hostDshHome) {
    return { enabled: false, reason: 'no_host_home', mounts: [] };
  }
  let reason: DesiredUserAssetReason;
  if (input.isNewVolume) {
    reason = 'new_volume';
  } else {
    const marker = readMigrationMarker(input.dataRoot, input.volumeName);
    if (!marker || marker.volumeId !== input.volumeId) {
      return { enabled: false, reason: 'migration_pending', hostDshHome: input.hostDshHome, mounts: [] };
    }
    reason = 'migrated';
  }
  const resolution = resolveUserAssetMounts(input.hostDshHome, { hostPlatform: input.hostPlatform });
  return {
    enabled: resolution.mounts.length > 0,
    reason,
    hostDshHome: resolution.hostDshHome,
    mounts: resolution.mounts,
    resolution,
  };
}

// ---------------------------------------------------------------------------
// One-time convergence
// ---------------------------------------------------------------------------

export interface ManifestEntry {
  readonly path: string;
  readonly type: 'file' | 'dir' | 'symlink' | 'other';
  readonly size: number;
  readonly sha256?: string;
}

export interface PathManifest {
  readonly exists: boolean;
  readonly type?: 'file' | 'dir' | 'symlink' | 'other';
  readonly entries: ManifestEntry[];
  readonly truncated: boolean;
}

export const MANIFEST_MAX_ENTRIES = 20000;

/**
 * Builds a manifest (relative paths, types, sizes, sha256) of a host file or directory tree.
 * Never follows symlinks. Kept byte-for-byte equivalent to the in-container script below.
 */
export function computeHostManifest(target: string): PathManifest {
  let st;
  try {
    st = lstatSync(target);
  } catch {
    return { exists: false, entries: [], truncated: false };
  }
  const typeOf = (s: import('node:fs').Stats): ManifestEntry['type'] =>
    s.isSymbolicLink() ? 'symlink' : s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other';
  const rootType = typeOf(st);
  const entries: ManifestEntry[] = [];
  let truncated = false;
  const visit = (abs: string, rel: string) => {
    if (entries.length >= MANIFEST_MAX_ENTRIES) {
      truncated = true;
      return;
    }
    const s = lstatSync(abs);
    const t = typeOf(s);
    if (t === 'file') {
      entries.push({ path: rel, type: t, size: s.size, sha256: createHash('sha256').update(readFileSync(abs)).digest('hex') });
    } else if (t === 'dir') {
      if (rel !== '') entries.push({ path: rel, type: t, size: 0 });
      for (const name of readdirSync(abs).sort()) {
        visit(join(abs, name), rel === '' ? name : `${rel}/${name}`);
      }
    } else {
      entries.push({ path: rel, type: t, size: s.size });
    }
  };
  visit(target, '');
  return { exists: true, type: rootType, entries, truncated };
}

/**
 * Self-contained Node script run inside the runtime container (as uid 1000) for the migration.
 * argv: <op> <root> <json-args>
 *   op=manifest: json-args = [relPath, ...]  -> prints { [relPath]: PathManifest }
 *   op=archive:  json-args = [{from, to}, ...] -> renames inside <root>; prints { moved: [...] }
 * Only fixed source paths and targets under <root>/.enkeep-archive/ are accepted.
 */
export const CONTAINER_MIGRATION_SCRIPT = String.raw`
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const [op, root, rawArgs] = process.argv.slice(1);
const MAX = ${MANIFEST_MAX_ENTRIES};
const SOURCES = new Set(['.dsh/memory', '.dsh/skills', '.dsh/AGENTS.md', 'memory']);
function fail(msg) { process.stdout.write(JSON.stringify({ ok: false, error: msg })); process.exit(2); }
if (!root || !path.isAbsolute(root)) fail('invalid root');
let args;
try { args = JSON.parse(rawArgs || '[]'); } catch (e) { fail('invalid args'); }
if (!Array.isArray(args)) fail('invalid args');
function typeOf(s) { return s.isSymbolicLink() ? 'symlink' : s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other'; }
function manifest(target) {
  let st;
  try { st = fs.lstatSync(target); } catch (e) { return { exists: false, entries: [], truncated: false }; }
  const entries = [];
  let truncated = false;
  const visit = (abs, rel) => {
    if (entries.length >= MAX) { truncated = true; return; }
    const s = fs.lstatSync(abs);
    const t = typeOf(s);
    if (t === 'file') {
      entries.push({ path: rel, type: t, size: s.size, sha256: crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex') });
    } else if (t === 'dir') {
      if (rel !== '') entries.push({ path: rel, type: t, size: 0 });
      for (const name of fs.readdirSync(abs).sort()) visit(path.join(abs, name), rel === '' ? name : rel + '/' + name);
    } else {
      entries.push({ path: rel, type: t, size: s.size });
    }
  };
  visit(target, '');
  return { exists: true, type: typeOf(st), entries, truncated };
}
if (op === 'manifest') {
  const out = {};
  for (const rel of args) {
    if (typeof rel !== 'string' || !SOURCES.has(rel)) fail('path not allowed');
    out[rel] = manifest(path.join(root, rel));
  }
  process.stdout.write(JSON.stringify({ ok: true, manifests: out }));
} else if (op === 'archive') {
  const archiveRoot = path.join(root, '.enkeep-archive') + path.sep;
  const moved = [];
  for (const m of args) {
    if (!m || typeof m.from !== 'string' || typeof m.to !== 'string' || !SOURCES.has(m.from)) fail('move not allowed');
    const from = path.join(root, m.from);
    const to = path.normalize(path.join(root, m.to));
    if (!to.startsWith(archiveRoot)) fail('archive target not allowed');
    let st;
    try { st = fs.lstatSync(from); } catch (e) { continue; }
    if (st.isSymbolicLink()) fail('refusing to archive a symlink');
    if (fs.existsSync(to)) fail('archive target exists');
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.renameSync(from, to);
    moved.push(m.from);
  }
  process.stdout.write(JSON.stringify({ ok: true, moved }));
} else {
  fail('unknown op');
}
`;

export type AssetComparisonStatus =
  | 'absent'
  | 'identical'
  | 'skeleton_only'
  | 'divergent'
  | 'legacy';

export interface AssetComparison {
  readonly asset: 'memory' | 'skills' | 'agents_md' | 'legacy_memory';
  readonly containerPath: string;
  readonly status: AssetComparisonStatus;
  readonly onlyInContainer: Array<{ path: string; size: number }>;
  readonly onlyOnHost: Array<{ path: string; size: number }>;
  readonly differing: Array<{ path: string; containerSize: number; hostSize: number }>;
}

/** Container-relative (to /home/dsh) source paths per asset. */
export const CONTAINER_ASSET_SOURCES = Object.freeze({
  memory: '.dsh/memory',
  skills: '.dsh/skills',
  agents_md: '.dsh/AGENTS.md',
  legacy_memory: 'memory',
} as const);

const HOST_ASSET_NAMES = Object.freeze({ memory: 'memory', skills: 'skills', agents_md: 'AGENTS.md' } as const);

function fileMap(m: PathManifest): Map<string, ManifestEntry> {
  const map = new Map<string, ManifestEntry>();
  if (!m.exists) return map;
  if (m.type === 'file') {
    const e = m.entries[0];
    if (e) map.set('', e);
    return map;
  }
  for (const e of m.entries) {
    if (e.type !== 'dir') map.set(e.path, e);
  }
  return map;
}

/**
 * Compares the container's copy of one asset with the host copy. Directories are compared by
 * their non-directory entries (empty directories are not data). Symlinks or special files on
 * the container side always count as divergent.
 */
export function compareAsset(
  asset: 'memory' | 'skills' | 'agents_md',
  container: PathManifest,
  host: PathManifest
): AssetComparison {
  const base = { asset, containerPath: CONTAINER_ASSET_SOURCES[asset] };
  const empty = { onlyInContainer: [], onlyOnHost: [], differing: [] };
  if (!container.exists) {
    return { ...base, status: 'absent', ...empty };
  }
  if (container.truncated || host.truncated) {
    return { ...base, status: 'divergent', onlyInContainer: [{ path: '(manifest truncated)', size: 0 }], onlyOnHost: [], differing: [] };
  }
  if (asset === 'agents_md' && container.type === 'file' && container.entries.length === 1 && container.entries[0].size === 0) {
    // An empty AGENTS.md carries no instructions (and is what Docker leaves behind as the
    // mountpoint of a single-file bind): nothing to preserve.
    return { ...base, status: 'absent', ...empty };
  }
  const c = fileMap(container);
  const h = fileMap(host);
  const typeMismatch = host.exists && container.type !== host.type;
  const onlyInContainer: Array<{ path: string; size: number }> = [];
  const onlyOnHost: Array<{ path: string; size: number }> = [];
  const differing: Array<{ path: string; containerSize: number; hostSize: number }> = [];
  for (const [p, e] of c) {
    const he = h.get(p);
    if (!he) {
      onlyInContainer.push({ path: p || '.', size: e.size });
    } else if (e.type !== 'file' || he.type !== 'file' || e.sha256 !== he.sha256) {
      differing.push({ path: p || '.', containerSize: e.size, hostSize: he.size });
    }
  }
  for (const [p, e] of h) {
    if (!c.has(p)) onlyOnHost.push({ path: p || '.', size: e.size });
  }
  const containerHasData = c.size > 0;
  if (!typeMismatch && onlyInContainer.length === 0 && differing.length === 0) {
    // Everything in the container is also on the host, byte for byte.
    return { ...base, status: containerHasData ? 'identical' : 'absent', onlyInContainer, onlyOnHost, differing };
  }
  if (asset === 'memory' && !typeMismatch && c.size === 1) {
    const only = c.get('global.md');
    const skeletonSha = createHash('sha256').update(DEFAULT_GLOBAL_MEMORY_SKELETON).digest('hex');
    if (only && only.type === 'file' && only.sha256 === skeletonSha) {
      return { ...base, status: 'skeleton_only', onlyInContainer, onlyOnHost, differing };
    }
  }
  return { ...base, status: 'divergent', onlyInContainer, onlyOnHost, differing };
}

export interface MigrationUser {
  readonly platformUserId: string;
  readonly username: string;
  readonly runtimeIdentity: string;
  readonly containerName: string;
  readonly volumeName: string;
}

export interface MigrationContainerInfo {
  readonly containerId: string;
  readonly running: boolean;
  readonly volumeId: string;
  /** Kinds of user asset mounts the container already has */
  readonly userAssetMountKinds: readonly string[];
}

/**
 * Side-effecting operations the migration needs; injected so tests run without Docker.
 */
export interface UserAssetMigrationDeps {
  /** Inspects and verifies ownership of the user's container; null if it does not exist. */
  inspectContainer(user: MigrationUser): Promise<MigrationContainerInfo | null>;
  /** Whether the runtime is idle (no turns, jobs, subagents, inbox). null if unknown. */
  isRuntimeIdle(containerId: string): Promise<boolean | null>;
  /** Runs CONTAINER_MIGRATION_SCRIPT inside the container. */
  runContainerScript(containerId: string, op: 'manifest' | 'archive', args: unknown[]): Promise<unknown>;
  now?(): Date;
}

export type UserMigrationOutcome =
  | 'already_converged'
  | 'converged'
  | 'would_converge'
  | 'divergent'
  | 'busy'
  | 'no_container'
  | 'container_not_running'
  | 'no_host_home'
  | 'already_mounted'
  | 'error';

export interface UserMigrationReport {
  readonly runtimeIdentity: string;
  readonly volumeName: string;
  readonly outcome: UserMigrationOutcome;
  readonly comparisons: AssetComparison[];
  readonly archived: string[];
  readonly archiveDir?: string;
  readonly markerPath?: string;
  readonly error?: string;
}

export interface UserAssetMigrationOptions {
  readonly dataRoot: string;
  readonly users: readonly MigrationUser[];
  readonly dryRun: boolean;
  /** Operator decision: archive divergent container copies too (host copy is never changed). */
  readonly archiveDivergent?: boolean;
  readonly deps: UserAssetMigrationDeps;
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function parseScriptResult(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || (raw as { ok?: unknown }).ok !== true) {
    const msg = raw && typeof raw === 'object' && typeof (raw as { error?: unknown }).error === 'string'
      ? (raw as { error: string }).error
      : 'container script failed';
    throw new Error(msg);
  }
  return raw as Record<string, unknown>;
}

/**
 * One-time, idempotent convergence of user-level assets for container runtimes.
 *
 * Per user: verify container ownership, require an idle runtime (unless dry-run), compare the
 * volume's `.dsh/memory`, `.dsh/skills`, `.dsh/AGENTS.md` with the host copy, then
 * - all identical/absent/skeleton -> archive them (and the legacy `/home/dsh/memory`) inside
 *   the volume under `.enkeep-archive/user-assets-single-copy/<stamp>/` and write the marker;
 * - any divergent -> report the differences and change nothing (unless archiveDivergent).
 * The host copy is never modified. Re-running after convergence is a no-op.
 */
export async function runUserAssetMigration(options: UserAssetMigrationOptions): Promise<UserMigrationReport[]> {
  const reports: UserMigrationReport[] = [];
  const now = options.deps.now ?? (() => new Date());
  for (const user of options.users) {
    const base = { runtimeIdentity: user.runtimeIdentity, volumeName: user.volumeName };
    try {
      const hostDshHome = hostDshHomeForUsername(options.dataRoot, user.username);
      if (!hostDshHome) {
        reports.push({ ...base, outcome: 'no_host_home', comparisons: [], archived: [] });
        continue;
      }
      const info = await options.deps.inspectContainer(user);
      if (!info) {
        reports.push({ ...base, outcome: 'no_container', comparisons: [], archived: [] });
        continue;
      }
      const marker = readMigrationMarker(options.dataRoot, user.volumeName);
      if (marker && marker.volumeId === info.volumeId) {
        reports.push({
          ...base,
          outcome: 'already_converged',
          comparisons: [],
          archived: [],
          markerPath: migrationMarkerPath(options.dataRoot, user.volumeName),
        });
        continue;
      }
      if (info.userAssetMountKinds.length > 0) {
        // Assets are already mounted over the volume paths, so the volume is served from the
        // host copy (and the old copies are not reachable). Record that, so no later rebuild
        // drops the mounts.
        if (options.dryRun) {
          reports.push({ ...base, outcome: 'already_mounted', comparisons: [], archived: [] });
          continue;
        }
        const markerPath = recordUserAssetMountsEnabled(options.dataRoot, {
          volumeName: user.volumeName,
          volumeId: info.volumeId,
          runtimeIdentity: user.runtimeIdentity,
          origin: 'already_mounted',
          now: now(),
        });
        reports.push({ ...base, outcome: 'already_mounted', comparisons: [], archived: [], markerPath });
        continue;
      }
      if (!info.running) {
        reports.push({ ...base, outcome: 'container_not_running', comparisons: [], archived: [] });
        continue;
      }
      if (!options.dryRun) {
        const idle = await options.deps.isRuntimeIdle(info.containerId);
        if (idle !== true) {
          reports.push({ ...base, outcome: 'busy', comparisons: [], archived: [] });
          continue;
        }
      }

      const sources = Object.values(CONTAINER_ASSET_SOURCES);
      const result = parseScriptResult(await options.deps.runContainerScript(info.containerId, 'manifest', sources));
      const manifests = result.manifests as Record<string, PathManifest>;
      const comparisons: AssetComparison[] = [];
      for (const asset of ['memory', 'skills', 'agents_md'] as const) {
        const containerManifest = manifests[CONTAINER_ASSET_SOURCES[asset]] ?? { exists: false, entries: [], truncated: false };
        const hostManifest = computeHostManifest(join(hostDshHome, HOST_ASSET_NAMES[asset]));
        comparisons.push(compareAsset(asset, containerManifest, hostManifest));
      }
      const legacy = manifests[CONTAINER_ASSET_SOURCES.legacy_memory];
      comparisons.push({
        asset: 'legacy_memory',
        containerPath: CONTAINER_ASSET_SOURCES.legacy_memory,
        status: legacy && legacy.exists ? 'legacy' : 'absent',
        onlyInContainer: [],
        onlyOnHost: [],
        differing: [],
      });

      const divergent = comparisons.filter((c) => c.status === 'divergent');
      if (divergent.length > 0 && !options.archiveDivergent) {
        reports.push({ ...base, outcome: 'divergent', comparisons, archived: [] });
        continue;
      }

      const toArchive = comparisons.filter((c) => c.status !== 'absent');
      const archiveRel = `.enkeep-archive/user-assets-single-copy/${stamp(now())}`;
      if (options.dryRun) {
        reports.push({
          ...base,
          outcome: 'would_converge',
          comparisons,
          archived: toArchive.map((c) => c.containerPath),
          archiveDir: toArchive.length > 0 ? archiveRel : undefined,
        });
        continue;
      }

      let archived: string[] = [];
      if (toArchive.length > 0) {
        const moves = toArchive.map((c) => ({
          from: c.containerPath,
          to: `${archiveRel}/${c.containerPath.replace(/^\./, '').replace(/\//g, '-')}`,
        }));
        const moved = parseScriptResult(await options.deps.runContainerScript(info.containerId, 'archive', moves));
        archived = Array.isArray(moved.moved) ? (moved.moved as string[]) : [];
      }
      const assets: Record<string, AssetComparisonStatus> = {};
      for (const c of comparisons) assets[c.asset] = c.status;
      const markerPath = writeMigrationMarker(options.dataRoot, {
        version: USER_ASSET_MIGRATION_MARKER_VERSION,
        status: 'converged',
        origin: 'migration',
        volumeName: user.volumeName,
        volumeId: info.volumeId,
        runtimeIdentity: user.runtimeIdentity,
        migratedAt: now().toISOString(),
        archiveDir: archived.length > 0 ? archiveRel : null,
        assets,
        divergentArchived: divergent.map((c) => c.asset),
      });
      reports.push({
        ...base,
        outcome: 'converged',
        comparisons,
        archived,
        archiveDir: archived.length > 0 ? archiveRel : undefined,
        markerPath,
      });
    } catch (err: unknown) {
      reports.push({
        ...base,
        outcome: 'error',
        comparisons: [],
        archived: [],
        error: err instanceof Error ? err.message : 'unknown error',
      });
    }
  }
  return reports;
}

/**
 * Renders a migration report for operators: ids, statuses, relative paths and sizes only
 * (never file contents).
 */
export function formatMigrationReport(reports: readonly UserMigrationReport[], dryRun: boolean): string {
  const lines: string[] = [];
  lines.push(`user-assets-migrate${dryRun ? ' (dry-run)' : ''}: ${reports.length} container user(s)`);
  for (const r of reports) {
    lines.push(`- ${r.runtimeIdentity} [${r.volumeName}]: ${r.outcome}${r.error ? ` (${r.error})` : ''}`);
    for (const c of r.comparisons) {
      lines.push(`    ${c.asset} (${c.containerPath}): ${c.status}`);
      if (c.status === 'divergent') {
        for (const e of c.onlyInContainer.slice(0, 50)) lines.push(`      only in container: ${e.path} (${e.size} B)`);
        for (const e of c.differing.slice(0, 50)) lines.push(`      differs: ${e.path} (container ${e.containerSize} B, host ${e.hostSize} B)`);
        if (c.onlyOnHost.length > 0) lines.push(`      only on host: ${c.onlyOnHost.length} file(s)`);
      }
    }
    if (r.archived.length > 0) {
      lines.push(`    ${dryRun ? 'would archive' : 'archived'}: ${r.archived.join(', ')} -> /home/dsh/${r.archiveDir}`);
    }
  }
  return lines.join('\n');
}

/**
 * For a container runtime handle whose user-level assets are served from the host copy, returns
 * the host DSH home. Undefined for host runtimes and for containers that still keep their own
 * copy (migration pending or mounts disabled with no mounts in place).
 */
export function hostUserAssetsForHandle(handle: {
  readonly userAssets?: { readonly hostDshHome: string; readonly reason: DesiredUserAssetReason };
  readonly rawHandle?: { readonly userAssetMounts?: readonly { kind: string }[] };
}): { hostDshHome: string; spacesDir: string } | undefined {
  const assets = handle.userAssets;
  if (!assets) return undefined;
  const mountedNow = (handle.rawHandle?.userAssetMounts?.length ?? 0) > 0;
  const enabled = assets.reason === 'new_volume' || assets.reason === 'migrated';
  if (!mountedNow && !enabled) return undefined;
  return { hostDshHome: assets.hostDshHome, spacesDir: join(assets.hostDshHome, '..', 'spaces') };
}

/**
 * Host memory root the platform binds to a container runtime's write route
 * (`POST /api/user-assets/memory/write`). Decided from the mounts the container ACTUALLY has,
 * not from the desired ones: a container that still runs with the memory mount keeps a working
 * write route even after the kill switch, until it is rebuilt without the mount.
 */
export function hostMemoryRootForBinding(handle: {
  readonly userAssets?: { readonly hostDshHome: string };
  readonly rawHandle?: { readonly userAssetMounts?: readonly { kind: string; sourcePath?: string }[] };
}): string | undefined {
  if (!handle.userAssets) return undefined;
  const mounted = handle.rawHandle?.userAssetMounts ?? [];
  if (!mounted.some((m) => m.kind === 'memory')) return undefined;
  return join(handle.userAssets.hostDshHome, 'memory');
}

export function isPathInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(sep));
}

