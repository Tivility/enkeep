/**
 * Shared Virtual Mount Resolver for Enkeep DSH Runtime
 *
 * Implements unified path resolution, traversal protection, symlink breakout defense,
 * read-only mutation enforcement, shell command rewriting, and output sanitization
 * across SpaceIsolatedFileSystem, SpaceIsolatedBashExecutor, and file operations.
 *
 * @module @enkeep/runtime-runner/runtime/virtual-mount-resolver
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FsError,
  FsTargetKey,
  FsVersion,
  type FsTarget,
  type FsPathInfo,
  type FsDirEntry,
} from '@deepseek-ai/dsh-fs';
import type { ResolvedRuntimeMount, RuntimeMountSpec } from '../spec/types.js';
import { verifyMountTOCTOU } from '../spec/mount-security.js';

export function isPathInside(childPath: string, parentPath: string): boolean {
  const normChild = path.resolve(childPath);
  const normParent = path.resolve(parentPath);
  const rel = path.relative(normParent, normChild);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export interface ResolvedVirtualTarget {
  readonly isMount: boolean;
  readonly isVirtualRoot: boolean;
  readonly mount?: ResolvedRuntimeMount;
  readonly subpath?: string;
  readonly physicalPath?: string;
  readonly displayPath: string;
  readonly isExtraRoot?: boolean;
  readonly isWritableExtraRoot?: boolean;
}

export interface VirtualMountResolverOptions {
  extraReadableRoots?: string[];
  extraWritableRoots?: string[];
  /**
   * Roots that are blocked by default (e.g. the DSH home with sessions/DB, and the parent
   * spaces directory holding sibling spaces). An explicit grant in extraReadableRoots
   * or extraWritableRoots overrides an ancestor deniedRoot (e.g. a sibling space under
   * the parent spaces directory), while descendant deniedRoots (e.g. sensitive subtrees
   * inside a grant) remain strictly denied.
   */
  deniedRoots?: string[];
}

/**
 * Single Authoritative Virtual Mount Resolver.
 */
export class VirtualMountResolver {
  private readonly mounts: readonly ResolvedRuntimeMount[];
  private readonly spacePath: string;
  private readonly extraReadableRoots: readonly string[];
  private readonly extraWritableRoots: readonly string[];
  private readonly deniedRoots: readonly string[];

  constructor(
    spacePath: string | { get?: () => unknown },
    mounts?: readonly ResolvedRuntimeMount[],
    options?: VirtualMountResolverOptions
  ) {
    const rawSpacePath =
      typeof spacePath === 'object' && spacePath !== null && 'get' in spacePath && typeof (spacePath as any).get === 'function'
        ? (spacePath as any).get()
        : spacePath;
    this.spacePath = path.resolve(String(rawSpacePath ?? process.cwd()));
    this.mounts = mounts ?? [];

    const resolveRoots = (roots: readonly string[]): string[] => {
      const resolved: string[] = [];
      for (const r of roots) {
        if (!r) continue;
        const norm = path.resolve(r);
        resolved.push(norm);
        try {
          const real = fs.realpathSync(norm);
          if (real !== norm) {
            resolved.push(real);
          }
        } catch {
          // Retain normalized path if path does not exist on disk yet
        }
      }
      return Array.from(new Set(resolved));
    };

    // Default writable roots: [os.tmpdir(), '/tmp', '/private/tmp']
    const defaultWritable = [os.tmpdir(), '/tmp', '/private/tmp'];
    const rawWritable = options?.extraWritableRoots ?? defaultWritable;
    this.extraWritableRoots = resolveRoots(rawWritable);

    // Default readable roots: [os.homedir()]
    const defaultReadable = [os.homedir()];
    const rawReadable = options?.extraReadableRoots ?? defaultReadable;
    this.extraReadableRoots = resolveRoots(rawReadable);

    // Denied roots: broad parent spaces directory and explicitly configured deniedRoots.
    const parentDir = path.dirname(this.spacePath);
    let realParentDir: string | undefined;
    try {
      realParentDir = path.dirname(fs.realpathSync(this.spacePath));
    } catch {}
    const rawDenied = [
      parentDir,
      ...(realParentDir && realParentDir !== parentDir ? [realParentDir] : []),
      ...(options?.deniedRoots ?? []),
    ];
    this.deniedRoots = resolveRoots(rawDenied);
  }

  getDeniedRoots(): readonly string[] {
    return this.deniedRoots;
  }

  getMounts(): readonly ResolvedRuntimeMount[] {
    return this.mounts;
  }

  getSpacePath(): string {
    return this.spacePath;
  }

  getExtraReadableRoots(): readonly string[] {
    return this.extraReadableRoots;
  }

  getExtraWritableRoots(): readonly string[] {
    return this.extraWritableRoots;
  }

  findMountByName(name: string): ResolvedRuntimeMount | undefined {
    return this.mounts.find((m) => m.name === name);
  }

  /**
   * Resolves an input path against virtual /mnt mounts and space boundary.
   */
  resolvePath(inputPath: string, customCwd?: string): ResolvedVirtualTarget {
    if (typeof inputPath !== 'string' || inputPath.length === 0) {
      throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND');
    }

    const rawInput = inputPath;
    const normInput = inputPath.startsWith('/') ? path.normalize(inputPath) : inputPath;

    // 1. Virtual /mnt root
    if (normInput === '/mnt' || normInput === '/mnt/' || normInput === 'mnt' || normInput === 'mnt/') {
      return {
        isMount: false,
        isVirtualRoot: true,
        displayPath: '/mnt',
      };
    }

    // 2. Direct mount path: /mnt/<name> or /mnt/<name>/... or mnt/<name>
    let mntRelative: string | undefined;
    if (rawInput.startsWith('/mnt/')) {
      mntRelative = rawInput.slice(5);
    } else if (rawInput.startsWith('mnt/')) {
      mntRelative = rawInput.slice(4);
    } else if (normInput.startsWith('/mnt/')) {
      mntRelative = normInput.slice(5);
    } else if (normInput.startsWith('mnt/')) {
      mntRelative = normInput.slice(4);
    }

    if (mntRelative !== undefined) {
      const slashIdx = mntRelative.indexOf('/');
      const mountName = slashIdx === -1 ? mntRelative : mntRelative.slice(0, slashIdx);
      const subpath = slashIdx === -1 ? '' : mntRelative.slice(slashIdx + 1);
      const mount = this.findMountByName(mountName);

      if (mount) {
        return this.resolveMountSubpath(mount, subpath, inputPath);
      }
    }

    // 3. Check if cwd is inside a mount
    const effectiveCwd = customCwd ? path.resolve(customCwd) : this.spacePath;
    for (const mount of this.mounts) {
      let realTarget: string;
      try {
        realTarget = fs.existsSync(mount.targetPath)
          ? fs.realpathSync(mount.targetPath)
          : path.resolve(mount.targetPath);
      } catch {
        realTarget = path.resolve(mount.targetPath);
      }

      if (isPathInside(effectiveCwd, realTarget)) {
        const resolvedTarget = path.resolve(effectiveCwd, inputPath);
        if (!isPathInside(resolvedTarget, realTarget)) {
          throw new FsError(
            `Access denied: path "${inputPath}" traverses outside mount boundary "/mnt/${mount.name}"`,
            'FS_SANDBOX_DENIED'
          );
        }
        const sub = path.relative(realTarget, resolvedTarget);
        const displaySub = sub ? `/${sub}` : '';
        return {
          isMount: true,
          isVirtualRoot: false,
          mount,
          subpath: sub,
          physicalPath: resolvedTarget,
          displayPath: `/mnt/${mount.name}${displaySub}`,
        };
      }
    }

    // 4. Normal space workspace resolution
    let realSpaceRoot: string;
    try {
      realSpaceRoot = fs.realpathSync(this.spacePath);
    } catch {
      realSpaceRoot = this.spacePath;
    }

    const candidate = path.isAbsolute(inputPath)
      ? path.resolve(inputPath)
      : path.resolve(effectiveCwd, inputPath);

    let realCandidate: string;
    try {
      realCandidate = fs.realpathSync(candidate);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Ancestor check for broken symlinks or missing files
        let cur = candidate;
        let foundExisting = false;
        while (cur && cur !== path.dirname(cur)) {
          try {
            const lstat = fs.lstatSync(cur);
            if (lstat.isSymbolicLink()) {
              const target = fs.readlinkSync(cur);
              const resolved = path.isAbsolute(target) ? path.resolve(target) : path.resolve(path.dirname(cur), target);
              if (!isPathInside(resolved, realSpaceRoot)) {
                const extraMatch = path.isAbsolute(inputPath) ? this.matchExtraRoots(resolved) : null;
                if (!extraMatch) {
                  throw new FsError(
                    `Access denied: symlink "${inputPath}" points outside space boundary "${this.spacePath}"`,
                    'FS_SANDBOX_DENIED'
                  );
                }
              }
            }
          } catch (symErr) {
            if (symErr instanceof FsError) throw symErr;
          }
          if (fs.existsSync(cur)) {
            const realCur = fs.realpathSync(cur);
            if (!isPathInside(realCur, realSpaceRoot)) {
              const extraMatch = path.isAbsolute(inputPath) ? this.matchExtraRoots(realCur) : null;
              if (!extraMatch) {
                throw new FsError(
                  `Access denied: path "${inputPath}" resolves outside space boundary "${this.spacePath}"`,
                  'FS_SANDBOX_DENIED'
                );
              }
            }
            realCandidate = path.join(realCur, path.relative(cur, candidate));
            foundExisting = true;
            break;
          }
          cur = path.dirname(cur);
        }
        if (!foundExisting) {
          realCandidate = path.resolve(realSpaceRoot, path.relative(this.spacePath, candidate));
        }
      } else {
        throw err;
      }
    }

    if (!isPathInside(realCandidate!, realSpaceRoot)) {
      // Check allowlist roots if candidate path was absolute
      if (path.isAbsolute(inputPath)) {
        const extraMatch = this.matchExtraRoots(realCandidate!);
        if (extraMatch) {
          return {
            isMount: false,
            isVirtualRoot: false,
            isExtraRoot: true,
            isWritableExtraRoot: extraMatch.isWritableExtraRoot,
            physicalPath: realCandidate!,
            displayPath: realCandidate!,
          };
        }
      }

      throw new FsError(
        `Access denied: path "${inputPath}" resolves outside space boundary "${this.spacePath}"`,
        'FS_SANDBOX_DENIED'
      );
    }

    // Check descendant denies inside space boundary
    for (const denied of this.deniedRoots) {
      if (isPathInside(denied, realSpaceRoot) && isPathInside(realCandidate!, denied)) {
        throw new FsError(
          `Access denied: path "${inputPath}" matches denied root "${denied}"`,
          'FS_SANDBOX_DENIED'
        );
      }
    }

    const relFromSpace = path.relative(realSpaceRoot, realCandidate!);
    return {
      isMount: false,
      isVirtualRoot: false,
      physicalPath: realCandidate!,
      displayPath: relFromSpace === '' ? '.' : relFromSpace,
    };
  }

  private resolveMountSubpath(
    mount: ResolvedRuntimeMount,
    subpath: string,
    originalInput: string
  ): ResolvedVirtualTarget {
    if (mount.dev !== undefined && mount.ino !== undefined) {
      try {
        verifyMountTOCTOU(mount.targetPath, mount.dev, mount.ino);
      } catch (err: unknown) {
        throw new FsError(`Access denied: mount security validation failed: ${(err as Error).message}`, 'FS_SANDBOX_DENIED');
      }
    }

    let realTarget: string;
    try {
      realTarget = fs.realpathSync(mount.targetPath);
    } catch {
      realTarget = path.resolve(mount.targetPath);
    }

    const candidate = path.resolve(mount.targetPath, subpath);
    if (!isPathInside(candidate, mount.targetPath)) {
      throw new FsError(
        `Access denied: path "${originalInput}" traverses outside mount boundary "/mnt/${mount.name}"`,
        'FS_SANDBOX_DENIED'
      );
    }

    // Check existing components for symlink breakout
    let cur = candidate;
    while (cur && cur !== path.dirname(cur) && cur.length >= mount.targetPath.length) {
      try {
        const lstatRes = fs.lstatSync(cur);
        if (lstatRes.isSymbolicLink()) {
          const linkTarget = fs.readlinkSync(cur);
          const resolvedLink = path.isAbsolute(linkTarget)
            ? path.resolve(linkTarget)
            : path.resolve(path.dirname(cur), linkTarget);
          if (!isPathInside(resolvedLink, realTarget)) {
            throw new FsError(
              `Access denied: symlink in "/mnt/${mount.name}" resolves outside mount boundary`,
              'FS_SANDBOX_DENIED'
            );
          }
        }
      } catch (linkErr: unknown) {
        if (linkErr instanceof FsError) throw linkErr;
      }

      if (fs.existsSync(cur)) {
        try {
          const realCur = fs.realpathSync(cur);
          if (!isPathInside(realCur, realTarget)) {
            throw new FsError(
              `Access denied: symlink in "/mnt/${mount.name}" resolves outside mount boundary`,
              'FS_SANDBOX_DENIED'
            );
          }
        } catch (symErr: unknown) {
          if (symErr instanceof FsError) throw symErr;
        }
        break;
      }
      cur = path.dirname(cur);
    }

    const displaySub = subpath ? `/${subpath}` : '';
    return {
      isMount: true,
      isVirtualRoot: false,
      mount,
      subpath,
      physicalPath: candidate,
      displayPath: `/mnt/${mount.name}${displaySub}`,
    };
  }

  /**
   * Matches candidate path against extra roots using most-specific grant ordering:
   * 1. If candidate is not inside any grant root (readable or writable), returns null.
   * 2. Selects the most-specific matching grant root (deepest descendant).
   * 3. Evaluates all matching denied roots against the most-specific grant:
   *    - Descendant deny (denied root inside or equal to grant, e.g. explicit sensitive subtree):
   *      Denial is preserved; returns null.
   *    - Ancestor deny (denied root is a strict ancestor of grant, e.g. broad spacesDir parent):
   *      Overridden by the more-specific grant.
   *    - Unrelated deny: returns null.
   */
  private matchExtraRoots(
    candidatePhysicalPath: string
  ): { isExtraRoot: boolean; isWritableExtraRoot: boolean } | null {
    const normCandidate = path.resolve(candidatePhysicalPath);

    const matchingWritable = this.extraWritableRoots.filter((r) => isPathInside(normCandidate, r));
    const matchingReadable = this.extraReadableRoots.filter((r) => isPathInside(normCandidate, r));

    if (matchingWritable.length === 0 && matchingReadable.length === 0) {
      return null;
    }

    type GrantEntry = { root: string; writable: boolean };
    const allMatchingGrants: GrantEntry[] = [
      ...matchingWritable.map((root) => ({ root, writable: true })),
      ...matchingReadable.map((root) => ({ root, writable: false })),
    ];

    // Find the most-specific grant: the deepest descendant among all matching grants.
    let bestGrant = allMatchingGrants[0];
    for (let i = 1; i < allMatchingGrants.length; i++) {
      const g = allMatchingGrants[i];
      if (isPathInside(g.root, bestGrant.root) && g.root !== bestGrant.root) {
        bestGrant = g;
      } else if (g.root === bestGrant.root && g.writable && !bestGrant.writable) {
        bestGrant = g;
      }
    }

    // Check all matching denied roots against bestGrant
    const matchingDenied = this.deniedRoots.filter((d) => isPathInside(normCandidate, d));
    for (const denied of matchingDenied) {
      // Descendant deny: denied root is equal to or inside the grant root.
      // E.g. configured explicit secret deny within the grant root.
      if (isPathInside(denied, bestGrant.root)) {
        return null;
      }
      // Ancestor deny: denied root is a strict ancestor of the grant root.
      // E.g. broad spacesDir ancestor enclosing the sibling space grant.
      // If it is NOT an ancestor, fail-safe reject.
      if (!isPathInside(bestGrant.root, denied)) {
        return null;
      }
    }

    return {
      isExtraRoot: true,
      isWritableExtraRoot: bestGrant.writable,
    };
  }

  assertMutationAllowed(target: ResolvedVirtualTarget, op: 'write' | 'edit' = 'write'): void {
    if (target.isMount && target.mount) {
      if (target.mount.mode === 'ro') {
        const action = op === 'edit' ? 'edit file in' : 'write to';
        throw new FsError(
          `Access denied: cannot ${action} read-only mount "/mnt/${target.mount.name}"`,
          'FS_SANDBOX_DENIED'
        );
      }
    }
    if (target.isExtraRoot && !target.isWritableExtraRoot) {
      const action = op === 'edit' ? 'edit file in' : 'write to';
      throw new FsError(
        `Access denied: cannot ${action} read-only root "${target.physicalPath}"`,
        'FS_SANDBOX_DENIED'
      );
    }
  }

  rewriteBashCommand(command: string): string {
    let rewritten = command;
    for (const mount of this.mounts) {
      if (rewritten.includes(`/mnt/${mount.name}`)) {
        const regex = new RegExp(`/mnt/${mount.name}(/[^\\s"';&|]*)?`, 'g');
        let m: RegExpExecArray | null;
        while ((m = regex.exec(rewritten)) !== null) {
          const sub = (m[1] || '').replace(/^\/+/, '');
          const candidate = path.resolve(mount.targetPath, sub);
          if (!isPathInside(candidate, mount.targetPath)) {
            throw new Error(`Access denied: path in command traverses outside mount boundary "/mnt/${mount.name}"`);
          }
        }

        if (mount.mode === 'ro') {
          const writePattern = new RegExp(`(?:>|>>|\\brm\\b|\\btouch\\b|\\bmkdir\\b|\\bcp\\b.*|\\bmv\\b.*|\\bchmod\\b|\\bchown\\b).*?/mnt/${mount.name}`);
          if (writePattern.test(rewritten)) {
            throw new Error(`Access denied: cannot write to read-only mount "/mnt/${mount.name}"`);
          }
        }

        rewritten = rewritten.split(`/mnt/${mount.name}`).join(mount.targetPath);
      }
    }
    return rewritten;
  }

  sanitizeText(text: string): string {
    if (!text || this.mounts.length === 0) return text;
    let out = text;
    for (const mount of this.mounts) {
      if (mount.targetPath) {
        out = out.split(mount.targetPath).join(`/mnt/${mount.name}`);
      }
      if (mount.sourcePath && mount.sourcePath !== mount.targetPath) {
        out = out.split(mount.sourcePath).join(`/mnt/${mount.name}`);
      }
    }
    return out;
  }

  listVirtualMnt(): FsDirEntry[] {
    return this.mounts.map((m) => ({
      name: m.name,
      type: 'directory' as const,
      target: {
        displayPath: `/mnt/${m.name}`,
        targetKey: FsTargetKey(m.targetPath),
      },
      version: FsVersion('0'),
      size: 0,
    }));
  }
}

export const VirtualMountPathResolver = VirtualMountResolver;
export type VirtualMountPathResolver = VirtualMountResolver;
