/**
 * User-Level Assets: Single Authoritative Copy on the Host
 *
 * User-level assets (global memory, user skills, user AGENTS.md) live only in the host DSH home
 * (`<data-dir>/host-runtimes/<username>/.dsh`). Container runtimes see them through read-only
 * bind mounts at fixed paths under `/home/dsh/.dsh/`; container writes to global memory are
 * forwarded to the platform over the tunnel (see `tunnel/platform-proxy.ts`).
 *
 * @module @enkeep/runtime-runner/spec/user-assets
 */

import fs from 'node:fs';
import path from 'node:path';
import type { RuntimeUserAssetMount, UserAssetKind } from './types.js';
import { DEFAULT_SYSTEM_PROTECTED_ROOTS } from './mount-security.js';

export const USER_ASSET_KINDS: readonly UserAssetKind[] = Object.freeze(['memory', 'skills', 'agents_md'] as const);

/** Fixed in-container target path per asset kind. */
export const USER_ASSET_CONTAINER_TARGETS: Readonly<Record<UserAssetKind, string>> = Object.freeze({
  memory: '/home/dsh/.dsh/memory',
  skills: '/home/dsh/.dsh/skills',
  agents_md: '/home/dsh/.dsh/AGENTS.md',
});

/** Entry name inside the host DSH home per asset kind. */
export const USER_ASSET_HOST_NAMES: Readonly<Record<UserAssetKind, string>> = Object.freeze({
  memory: 'memory',
  skills: 'skills',
  agents_md: 'AGENTS.md',
});

/** Expected filesystem entry type per asset kind. */
export const USER_ASSET_ENTRY_TYPES: Readonly<Record<UserAssetKind, 'directory' | 'file'>> = Object.freeze({
  memory: 'directory',
  skills: 'directory',
  agents_md: 'file',
});

/** Container runtime user (`--user 1000:1000`). */
export const CONTAINER_RUNTIME_UID = 1000;
export const CONTAINER_RUNTIME_GID = 1000;

/**
 * Container environment flag set when global memory is host-backed (read-only mount).
 * The in-container memory_write tool then forwards global-scope writes to the platform.
 */
export const USER_MEMORY_WRITE_ENV_KEY = 'ENKEEP_USER_MEMORY_WRITE';
export const USER_MEMORY_WRITE_ENV_PLATFORM = 'platform';

/** Global kill switch: `ENKEEP_USER_ASSET_MOUNTS=0` disables user asset mounts. */
export const USER_ASSET_MOUNTS_ENV_KEY = 'ENKEEP_USER_ASSET_MOUNTS';

const FORBIDDEN_SOURCE_CHARS = /[,"'\n\r\0]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isUserAssetKind(value: unknown): value is UserAssetKind {
  return value === 'memory' || value === 'skills' || value === 'agents_md';
}

/**
 * Whether user asset mounts are enabled by environment (default: enabled).
 */
export function userAssetMountsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[USER_ASSET_MOUNTS_ENV_KEY];
  return !(raw === '0' || raw === 'false' || raw === 'off');
}

function isProtectedSource(sourcePath: string): boolean {
  for (const root of DEFAULT_SYSTEM_PROTECTED_ROOTS) {
    if (root === '/') {
      if (sourcePath === '/') return true;
      continue;
    }
    if (sourcePath === root || sourcePath.startsWith(root + '/')) {
      return true;
    }
  }
  return false;
}

/**
 * Validates a userAssetMounts array in a container spec. Returns a list of violations.
 */
export function validateUserAssetMounts(raw: unknown): string[] {
  const errors: string[] = [];
  if (raw === undefined) return errors;
  if (!Array.isArray(raw)) {
    return ['userAssetMounts must be an array'];
  }
  const seen = new Set<string>();
  let sharedParent: string | undefined;
  for (const entry of raw) {
    if (!isRecord(entry)) {
      errors.push('userAssetMounts entries must be objects');
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (key !== 'kind' && key !== 'sourcePath' && key !== 'targetPath' && key !== 'readOnly') {
        errors.push(`userAssetMounts entry has forbidden key "${key}"`);
      }
    }
    const kind = entry.kind;
    if (!isUserAssetKind(kind)) {
      errors.push('userAssetMounts entry has invalid kind');
      continue;
    }
    if (seen.has(kind)) {
      errors.push(`Duplicate user asset mount kind "${kind}"`);
    }
    seen.add(kind);
    if (entry.readOnly !== true) {
      errors.push(`User asset mount "${kind}" must be read-only`);
    }
    if (entry.targetPath !== USER_ASSET_CONTAINER_TARGETS[kind]) {
      errors.push(`User asset mount "${kind}" must target ${USER_ASSET_CONTAINER_TARGETS[kind]}`);
    }
    const src = entry.sourcePath;
    if (typeof src !== 'string' || src.length === 0) {
      errors.push(`User asset mount "${kind}" sourcePath must be a non-empty string`);
      continue;
    }
    if (!path.isAbsolute(src) || path.normalize(src) !== src || src.endsWith('/')) {
      errors.push(`User asset mount "${kind}" sourcePath must be an absolute normalized path`);
      continue;
    }
    if (src.split('/').includes('..')) {
      errors.push(`User asset mount "${kind}" sourcePath must not contain ".."`);
      continue;
    }
    if (FORBIDDEN_SOURCE_CHARS.test(src)) {
      errors.push(`User asset mount "${kind}" sourcePath contains forbidden characters`);
      continue;
    }
    if (path.basename(src) !== USER_ASSET_HOST_NAMES[kind]) {
      errors.push(`User asset mount "${kind}" sourcePath must end with "${USER_ASSET_HOST_NAMES[kind]}"`);
      continue;
    }
    if (isProtectedSource(src)) {
      errors.push(`User asset mount "${kind}" sourcePath is inside a protected system root`);
      continue;
    }
    const parent = path.dirname(src);
    if (sharedParent === undefined) {
      sharedParent = parent;
    } else if (sharedParent !== parent) {
      errors.push('All user asset mounts must come from the same host DSH home');
    }
  }
  return errors;
}

export type UserAssetSkipReason =
  | 'missing'
  | 'not_a_directory'
  | 'not_a_file'
  | 'symlink'
  | 'unreadable_by_container_user'
  | 'stat_failed';

export interface UserAssetMountResolution {
  readonly hostDshHome: string;
  readonly mounts: RuntimeUserAssetMount[];
  readonly skipped: ReadonlyArray<{ kind: UserAssetKind; reason: UserAssetSkipReason }>;
  readonly created: readonly UserAssetKind[];
}

export interface ResolveUserAssetMountsOptions {
  /** Create missing memory/ and skills/ directories on the host (default true). */
  readonly createMissingDirectories?: boolean;
  /** Host platform; ownership checks apply on Linux only (default process.platform). */
  readonly hostPlatform?: NodeJS.Platform;
  readonly containerUid?: number;
  readonly containerGid?: number;
}

/**
 * Whether the container runtime user can read a host entry with the given stat.
 * Directories need read+execute, files need read. Only meaningful for Linux hosts:
 * Docker Desktop / OrbStack on macOS present host files through VM file sharing with
 * their own ownership mapping.
 */
export function isReadableByContainerUser(
  stat: Pick<fs.Stats, 'uid' | 'gid' | 'mode'>,
  type: 'directory' | 'file',
  uid = CONTAINER_RUNTIME_UID,
  gid = CONTAINER_RUNTIME_GID
): boolean {
  const need = type === 'directory' ? 0o5 : 0o4;
  let bits: number;
  if (stat.uid === uid) {
    bits = (stat.mode >> 6) & 0o7;
  } else if (stat.gid === gid) {
    bits = (stat.mode >> 3) & 0o7;
  } else {
    bits = stat.mode & 0o7;
  }
  return (bits & need) === need;
}

/**
 * Resolves the read-only user asset mounts for a host DSH home.
 *
 * - The host DSH home must be an absolute path; it is created (0700) when missing.
 * - memory/ and skills/ are created (0700) when missing so later host writes are visible
 *   to the container without a rebuild.
 * - AGENTS.md is mounted only if it exists (a single-file mount needs an existing file).
 * - Symlinks or wrong entry types are skipped, never followed.
 * - On Linux hosts, entries the container user cannot read are skipped.
 */
export function resolveUserAssetMounts(
  hostDshHome: string,
  options: ResolveUserAssetMountsOptions = {}
): UserAssetMountResolution {
  if (typeof hostDshHome !== 'string' || !path.isAbsolute(hostDshHome)) {
    throw new Error('User asset host DSH home must be an absolute path');
  }
  const home = path.normalize(hostDshHome).replace(/\/+$/, '') || '/';
  if (home.split('/').includes('..') || FORBIDDEN_SOURCE_CHARS.test(home) || isProtectedSource(home)) {
    throw new Error('User asset host DSH home is not an allowed path');
  }
  const createDirs = options.createMissingDirectories !== false;
  const platform = options.hostPlatform ?? process.platform;
  const uid = options.containerUid ?? CONTAINER_RUNTIME_UID;
  const gid = options.containerGid ?? CONTAINER_RUNTIME_GID;

  const mounts: RuntimeUserAssetMount[] = [];
  const skipped: Array<{ kind: UserAssetKind; reason: UserAssetSkipReason }> = [];
  const created: UserAssetKind[] = [];

  let homeStat: fs.Stats | undefined;
  try {
    homeStat = fs.lstatSync(home);
  } catch (err: unknown) {
    if ((err as { code?: string })?.code !== 'ENOENT') {
      throw new Error('User asset host DSH home could not be inspected', { cause: err });
    }
  }
  if (!homeStat) {
    if (!createDirs) {
      return {
        hostDshHome: home,
        mounts,
        skipped: USER_ASSET_KINDS.map((kind) => ({ kind, reason: 'missing' as const })),
        created,
      };
    }
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    homeStat = fs.lstatSync(home);
  }
  if (homeStat.isSymbolicLink() || !homeStat.isDirectory()) {
    throw new Error('User asset host DSH home must be a real directory');
  }

  for (const kind of USER_ASSET_KINDS) {
    const sourcePath = path.join(home, USER_ASSET_HOST_NAMES[kind]);
    const type = USER_ASSET_ENTRY_TYPES[kind];
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(sourcePath);
    } catch (err: unknown) {
      if ((err as { code?: string })?.code !== 'ENOENT') {
        skipped.push({ kind, reason: 'stat_failed' });
        continue;
      }
    }
    if (!st) {
      if (type === 'directory' && createDirs) {
        fs.mkdirSync(sourcePath, { mode: 0o700 });
        created.push(kind);
        st = fs.lstatSync(sourcePath);
      } else {
        skipped.push({ kind, reason: 'missing' });
        continue;
      }
    }
    if (st.isSymbolicLink()) {
      skipped.push({ kind, reason: 'symlink' });
      continue;
    }
    if (type === 'directory' && !st.isDirectory()) {
      skipped.push({ kind, reason: 'not_a_directory' });
      continue;
    }
    if (type === 'file' && !st.isFile()) {
      skipped.push({ kind, reason: 'not_a_file' });
      continue;
    }
    if (platform === 'linux') {
      let readable = isReadableByContainerUser(st, type, uid, gid);
      if (readable && kind === 'memory') {
        try {
          const g = fs.lstatSync(path.join(sourcePath, 'global.md'));
          if (g.isFile() && !isReadableByContainerUser(g, 'file', uid, gid)) {
            readable = false;
          }
        } catch {
          // global.md absent: directory readability is what matters
        }
      }
      if (!readable) {
        skipped.push({ kind, reason: 'unreadable_by_container_user' });
        continue;
      }
    }
    mounts.push({ kind, sourcePath, targetPath: USER_ASSET_CONTAINER_TARGETS[kind], readOnly: true });
  }

  return { hostDshHome: home, mounts, skipped, created };
}

/**
 * Compares two user asset mount lists by kind and source path (order-insensitive).
 */
export function userAssetMountsEqual(
  a: readonly RuntimeUserAssetMount[] | undefined,
  b: readonly RuntimeUserAssetMount[] | undefined
): boolean {
  const left = [...(a ?? [])].map((m) => `${m.kind}\0${m.sourcePath}`).sort();
  const right = [...(b ?? [])].map((m) => `${m.kind}\0${m.sourcePath}`).sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

/**
 * Compares two user asset mount lists by kind only (order-insensitive). Used against
 * `docker inspect` output, whose bind sources may be rewritten by VM file sharing.
 */
export function userAssetMountKindsEqual(
  a: readonly { kind: UserAssetKind }[] | undefined,
  b: readonly { kind: UserAssetKind }[] | undefined
): boolean {
  const left = [...(a ?? [])].map((m) => m.kind).sort();
  const right = [...(b ?? [])].map((m) => m.kind).sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

/**
 * Maps a container destination path back to the user asset kind, if it is one.
 */
export function userAssetKindForTarget(destination: string): UserAssetKind | undefined {
  for (const kind of USER_ASSET_KINDS) {
    if (USER_ASSET_CONTAINER_TARGETS[kind] === destination) return kind;
  }
  return undefined;
}

/**
 * Host directory of global memory for a set of mounts (undefined if memory is not mounted).
 */
export function hostMemoryRootFromMounts(mounts: readonly RuntimeUserAssetMount[] | undefined): string | undefined {
  return mounts?.find((m) => m.kind === 'memory')?.sourcePath;
}
