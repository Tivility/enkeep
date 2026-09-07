/**
 * Host Mount Boundary Validation & Security Policy for Enkeep DSH Runtime
 *
 * Implements strict host source path boundary verification, TOCTOU protection (dev/ino),
 * world-writable / ownership checks, protected root traversal defense, and slug validation.
 *
 * @module @enkeep/runtime-runner/spec/mount-security
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { HostOwnershipError } from './provider.js';
import type { RuntimeMountSpec, ResolvedRuntimeMount } from './types.js';

export const MOUNT_NAME_SLUG_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const MOUNT_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

export const RESERVED_MOUNT_NAMES = new Set([
  '.',
  '..',
  'mnt',
  'home',
  'root',
  'dsh',
  'proc',
  'sys',
  'dev',
  'etc',
  'var',
  'tmp',
  'bin',
  'usr',
  'lib',
]);

export const DEFAULT_SYSTEM_PROTECTED_ROOTS: readonly string[] = Object.freeze([
  '/',
  '/etc',
  '/private/etc',
  '/proc',
  '/sys',
  '/dev',
  '/var/run',
  '/run',
  '/private/var/run',
  '/var/run/docker.sock',
  '/run/docker.sock',
  '/private/var/run/docker.sock',
  '/bin',
  '/sbin',
  '/usr',
  '/usr/bin',
  '/usr/sbin',
  '/usr/local/bin',
  '/System',
  '/Library',
  '/root',
]);

export const SENSITIVE_USER_DIRECTORIES: readonly string[] = Object.freeze([
  '.ssh',
  '.gnupg',
  '.aws',
  '.config',
  '.docker',
  '.kube',
  '.gitconfig',
  '.npmrc',
  '.bash_history',
  '.zsh_history',
]);

/**
 * Checks whether a mount name is a valid strict slug.
 */
export function isValidMountSlug(name: unknown): name is string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 64) {
    return false;
  }
  if (!MOUNT_NAME_SLUG_REGEX.test(name)) {
    return false;
  }
  if (RESERVED_MOUNT_NAMES.has(name)) {
    return false;
  }
  return true;
}

/**
 * Checks whether a mount ID is valid.
 */
export function isValidMountId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 64 && MOUNT_ID_REGEX.test(id);
}

/**
 * Checks whether childPath is strictly contained inside or equals rootPath.
 */
export function isPathContained(childPath: string, rootPath: string): boolean {
  if (!childPath || !rootPath) return false;
  const normChild = path.normalize(path.resolve(childPath));
  const normRoot = path.normalize(path.resolve(rootPath));
  if (normChild === normRoot) {
    return true;
  }
  const rootWithSep = normRoot.endsWith(path.sep) ? normRoot : normRoot + path.sep;
  return normChild.startsWith(rootWithSep);
}

/**
 * Checks symmetric containment: pathA contains pathB OR pathB contains pathA.
 */
export function isAncestorOrDescendant(pathA: string, pathB: string): boolean {
  return isPathContained(pathA, pathB) || isPathContained(pathB, pathA);
}

export interface MountSourceValidationOptions {
  readonly dataRoot?: string;
  readonly dshHome?: string;
  readonly spacesDir?: string;
  readonly runDir?: string;
  readonly protectedRoots?: readonly string[];
  readonly allowRootUid?: boolean;
}

export interface ValidatedMountSource {
  readonly realPath: string;
  readonly dev: number;
  readonly ino: number;
}

/**
 * Validates a host directory source path against all security boundaries.
 * Enforces: absolute, exists, directory, no symlink terminal, not world-writable,
 * owner current uid (or root/admin), not inside/ancestor of any protected root.
 */
export function validateMountSourcePath(
  sourcePath: string,
  options: MountSourceValidationOptions = {}
): ValidatedMountSource {
  if (!sourcePath || typeof sourcePath !== 'string') {
    throw new HostOwnershipError('Mount sourcePath must be a non-empty string');
  }

  if (!path.isAbsolute(sourcePath)) {
    throw new HostOwnershipError(`Mount sourcePath must be an absolute path: "${sourcePath}"`);
  }

  const normalized = path.normalize(sourcePath);

  // 1. Terminal path existence and symlink terminal rejection
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(normalized);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HostOwnershipError(`Mount source directory does not exist: "${normalized}"`);
    }
    throw new HostOwnershipError(`Failed to inspect mount source: ${(err as Error).message}`);
  }

  if (lstat.isSymbolicLink()) {
    throw new HostOwnershipError(
      `Mount source path must not be a symbolic link at the terminal path: "${normalized}"`
    );
  }

  if (!lstat.isDirectory()) {
    throw new HostOwnershipError(`Mount source path must be a directory: "${normalized}"`);
  }

  // 2. Realpath resolution
  let realSource: string;
  try {
    realSource = fs.realpathSync(normalized);
  } catch (err: unknown) {
    throw new HostOwnershipError(`Failed to resolve realpath for mount source: ${(err as Error).message}`);
  }

  const stat = fs.statSync(realSource);
  if (!stat.isDirectory()) {
    throw new HostOwnershipError(`Resolved mount source path is not a directory: "${realSource}"`);
  }

  // 3. World-writable check
  if ((stat.mode & 0o002) !== 0) {
    throw new HostOwnershipError(
      `Mount source directory is world-writable (mode ${(stat.mode & 0o777).toString(8)}): "${normalized}"`
    );
  }

  // 4. Ownership check: current UID or root
  if (typeof process.getuid === 'function') {
    const currentUid = process.getuid();
    if (stat.uid !== currentUid && stat.uid !== 0 && currentUid !== 0) {
      throw new HostOwnershipError(
        `Mount source directory UID (${stat.uid}) does not match current process UID (${currentUid})`
      );
    }
  }

  // 5. Root and User home directory rejection
  if (realSource === '/' || normalized === '/') {
    throw new HostOwnershipError('Mount source path conflicts with protected root "/"');
  }

  try {
    const userHome = os.homedir();
    if (userHome) {
      const realHome = fs.existsSync(userHome) ? fs.realpathSync(userHome) : path.resolve(userHome);
      if (realSource === realHome || realSource === '/home' || realSource === '/Users') {
        throw new HostOwnershipError(
          'Mounting user home directory root as a mount source is forbidden'
        );
      }

      // Check sensitive dotfiles/directories under user home
      for (const dotDir of SENSITIVE_USER_DIRECTORIES) {
        const sensitiveCandidate = path.join(realHome, dotDir);
        let realSensitive: string;
        try {
          realSensitive = fs.existsSync(sensitiveCandidate)
            ? fs.realpathSync(sensitiveCandidate)
            : path.resolve(sensitiveCandidate);
        } catch {
          realSensitive = path.resolve(sensitiveCandidate);
        }
        if (isAncestorOrDescendant(realSource, realSensitive)) {
          throw new HostOwnershipError(
            `Mount source path conflicts with sensitive user directory "${dotDir}"`
          );
        }
      }
    }
  } catch (err: unknown) {
    if (err instanceof HostOwnershipError) throw err;
  }

  // 6. Explicit protected root set verification
  const protectedList: string[] = [
    ...DEFAULT_SYSTEM_PROTECTED_ROOTS,
    ...(options.protectedRoots ?? []),
  ];

  if (options.dataRoot) protectedList.push(options.dataRoot);
  if (options.dshHome) protectedList.push(options.dshHome);
  if (options.spacesDir) protectedList.push(options.spacesDir);
  if (options.runDir) protectedList.push(options.runDir);

  for (const root of protectedList) {
    if (!root || root === '/') continue;
    let realRoot: string;
    try {
      realRoot = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
    } catch {
      realRoot = path.resolve(root);
    }

    if (isAncestorOrDescendant(realSource, realRoot)) {
      throw new HostOwnershipError(
        `Mount source path conflicts with protected root "${root}"`
      );
    }
  }

  return {
    realPath: realSource,
    dev: stat.dev,
    ino: stat.ino,
  };
}

/**
 * Verifies device and inode consistency (TOCTOU re-verification).
 */
export function verifyMountTOCTOU(
  sourcePath: string,
  expectedDev?: number,
  expectedIno?: number
): ValidatedMountSource {
  const realPath = fs.realpathSync(sourcePath);
  const stat = fs.statSync(realPath);

  if (expectedDev !== undefined && stat.dev !== expectedDev) {
    throw new HostOwnershipError(
      'TOCTOU safety violation: filesystem device changed for mount source'
    );
  }

  if (expectedIno !== undefined && stat.ino !== expectedIno) {
    throw new HostOwnershipError(
      'TOCTOU safety violation: inode changed for mount source (symlink swap detected)'
    );
  }

  return {
    realPath,
    dev: stat.dev,
    ino: stat.ino,
  };
}

/**
 * Validates a single RuntimeMountSpec object against safety invariants.
 */
export function validateMountSpec(
  rawMount: unknown,
  options?: MountSourceValidationOptions
): { valid: boolean; errors: string[]; spec?: RuntimeMountSpec } {
  const errors: string[] = [];

  if (typeof rawMount !== 'object' || rawMount === null || Array.isArray(rawMount)) {
    return { valid: false, errors: ['Mount specification must be a valid JSON object'] };
  }

  const record = rawMount as Record<string, unknown>;
  const allowedKeys = new Set(['id', 'name', 'sourcePath', 'mode']);

  for (const k of Object.keys(record)) {
    if (!allowedKeys.has(k)) {
      errors.push(`Unknown or forbidden property "${k}" in RuntimeMountSpec`);
    }
  }

  const { id, name, sourcePath, mode } = record;

  if (!isValidMountId(id)) {
    errors.push('mount.id must match pattern ^[a-zA-Z0-9_-]{1,64}$');
  }

  if (!isValidMountSlug(name)) {
    errors.push(
      'mount.name must be a strict slug matching pattern ^[a-z0-9][a-z0-9_-]{0,63}$ (no uppercase, no special chars)'
    );
  }

  if (mode !== 'ro' && mode !== 'rw') {
    errors.push('mount.mode must be strictly "ro" or "rw"');
  }

  let validatedSource: ValidatedMountSource | undefined;
  if (typeof sourcePath !== 'string' || sourcePath.length === 0 || !path.isAbsolute(sourcePath)) {
    errors.push('mount.sourcePath must be a non-empty absolute path');
  } else {
    try {
      validatedSource = validateMountSourcePath(sourcePath, options);
    } catch (err: unknown) {
      errors.push((err as Error).message);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    spec: {
      id: id as string,
      name: name as string,
      sourcePath: validatedSource?.realPath ?? path.resolve(sourcePath as string),
      mode: mode as 'ro' | 'rw',
    },
  };
}

/**
 * Computes a deterministic SHA-256 hash of active mount specifications without leaking paths.
 */
export function computeMountHash(mounts?: readonly (RuntimeMountSpec | ResolvedRuntimeMount)[]): string {
  if (!mounts || mounts.length === 0) {
    return crypto.createHash('sha256').update('[]').digest('hex');
  }

  const safeDescriptors = mounts
    .map((m) => ({ id: m.id, name: m.name, mode: m.mode }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return crypto.createHash('sha256').update(JSON.stringify(safeDescriptors)).digest('hex');
}

/**
 * Sanitizes an error message by replacing any physical host or target paths with virtual /mnt/<name>.
 */
export function sanitizePathInError(
  message: string,
  mounts?: readonly { name: string; sourcePath?: string; targetPath?: string }[]
): string {
  if (!mounts || mounts.length === 0 || !message) return message;
  let sanitized = message;
  for (const m of mounts) {
    if (m.sourcePath) {
      sanitized = sanitized.split(m.sourcePath).join(`/mnt/${m.name}`);
    }
    if (m.targetPath && m.targetPath !== m.sourcePath) {
      sanitized = sanitized.split(m.targetPath).join(`/mnt/${m.name}`);
    }
  }
  return sanitized;
}
