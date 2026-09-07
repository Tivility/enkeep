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
  const rel = path.relative(parentPath, childPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export interface ResolvedVirtualTarget {
  readonly isMount: boolean;
  readonly isVirtualRoot: boolean;
  readonly mount?: ResolvedRuntimeMount;
  readonly subpath?: string;
  readonly physicalPath?: string;
  readonly displayPath: string;
}

/**
 * Single Authoritative Virtual Mount Resolver.
 */
export class VirtualMountResolver {
  private readonly mounts: readonly ResolvedRuntimeMount[];
  private readonly spacePath: string;

  constructor(spacePath: string, mounts?: readonly ResolvedRuntimeMount[]) {
    this.spacePath = path.resolve(spacePath);
    this.mounts = mounts ?? [];
  }

  getMounts(): readonly ResolvedRuntimeMount[] {
    return this.mounts;
  }

  getSpacePath(): string {
    return this.spacePath;
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
                throw new FsError(
                  `Access denied: symlink "${inputPath}" points outside space boundary "${this.spacePath}"`,
                  'FS_SANDBOX_DENIED'
                );
              }
            }
          } catch (symErr) {
            if (symErr instanceof FsError) throw symErr;
          }
          if (fs.existsSync(cur)) {
            const realCur = fs.realpathSync(cur);
            if (!isPathInside(realCur, realSpaceRoot)) {
              throw new FsError(
                `Access denied: path "${inputPath}" resolves outside space boundary "${this.spacePath}"`,
                'FS_SANDBOX_DENIED'
              );
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
      throw new FsError(
        `Access denied: path "${inputPath}" resolves outside space boundary "${this.spacePath}"`,
        'FS_SANDBOX_DENIED'
      );
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
