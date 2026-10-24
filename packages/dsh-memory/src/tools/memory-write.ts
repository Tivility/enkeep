/**
 * memory_write Tool Implementation
 *
 * Implements safe, atomic writing and appending to global or space-specific memory files.
 * Supports optimistic concurrency control via `expectedEtag`.
 * Uses PlatformClient if available for audit and quota, with fallback to atomic local filesystem write.
 *
 * @module @enkeep/dsh-memory/tools/memory-write
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type {
  MemoryWriteResult,
  MemoryWriteMode,
  MemoryScope,
  MemoryPlatformClientService,
  GlobalMemoryWriteTarget,
} from '../types.js';
import { computeContentHash } from '../prompt.js';
import { resolveSafeMemoryPath, resolveSafeMemoryPathInRoot } from './memory-read.js';

export const MAX_WRITE_BYTES = 5 * 1024 * 1024; // 5MB max payload per write

export interface MemoryWriteArgs {
  path?: string;
  content: string;
  scope?: MemoryScope;
  mode?: MemoryWriteMode;
  expectedEtag?: string;
}

export interface MemoryWriteToolOptions {
  dshHome: string;
  spacePath?: string;
  spaceId?: string;
  userId?: string;
  getClient?: () => MemoryPlatformClientService | undefined;
  /** 'platform': global-scope writes go to the platform (container runtimes). Default 'local'. */
  globalMemoryWrite?: GlobalMemoryWriteTarget;
}

/**
 * Performs an atomic file write using temp file and rename.
 */
export function atomicWriteFileSync(
  targetPath: string,
  content: string,
  options: { readonly preservePermissions?: boolean } = {}
): void {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    if (options.preservePermissions) {
      mkdirInheritingPermissions(dir);
    } else {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  const tempPath = path.join(dir, `.tmp_mem_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
  try {
    fs.writeFileSync(tempPath, content, { encoding: 'utf-8', mode: 0o600 });
    if (options.preservePermissions) {
      applyPermissionsForReplacement(tempPath, targetPath, dir);
    }
    fs.renameSync(tempPath, targetPath);
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {}
    throw err;
  }
}

/**
 * Gives a temp file the permissions its replacement target should have, so an atomic replace
 * does not change who can read the file:
 * - existing target: same mode bits, and (best effort) same owner/group;
 * - new file: 0600 plus the read bits the parent directory grants to group/others, and
 *   (best effort) the parent directory's owner/group.
 * Ownership changes need privileges; when the platform runs as the owner they are no-ops.
 */
function applyPermissionsForReplacement(tempPath: string, targetPath: string, dir: string): void {
  let ref: fs.Stats;
  let mode: number;
  try {
    ref = fs.statSync(targetPath);
    mode = ref.mode & 0o777;
  } catch (err: unknown) {
    if ((err as { code?: string })?.code !== 'ENOENT') throw err;
    ref = fs.statSync(dir);
    mode = 0o600 | (ref.mode & 0o044);
  }
  fs.chmodSync(tempPath, mode);
  const own = fs.statSync(tempPath);
  if (own.uid !== ref.uid || own.gid !== ref.gid) {
    try {
      fs.chownSync(tempPath, ref.uid, ref.gid);
    } catch {
      // Not privileged: keep the writer's ownership; mode bits above still apply.
    }
  }
}

/** Creates missing directories with the parent's group/other access bits (and owner, best effort). */
function mkdirInheritingPermissions(dir: string): void {
  const parent = path.dirname(dir);
  if (!fs.existsSync(parent)) mkdirInheritingPermissions(parent);
  const pst = fs.statSync(parent);
  const mode = 0o700 | (pst.mode & 0o055);
  fs.mkdirSync(dir, { mode });
  fs.chmodSync(dir, mode); // not reduced by umask
  try {
    const st = fs.statSync(dir);
    if (st.uid !== pst.uid || st.gid !== pst.gid) fs.chownSync(dir, pst.uid, pst.gid);
  } catch {
    // best effort
  }
}

/**
 * Error raised when `expectedEtag` does not match the current file (optimistic concurrency).
 */
export class MemoryWriteConflictError extends Error {
  readonly code = 'MEMORY_WRITE_CONFLICT';
  constructor(message: string) {
    super(message);
    this.name = 'MemoryWriteConflictError';
  }
}

/**
 * Error raised when a memory path is unsafe (traversal, symlink, non-regular file).
 */
export class MemoryPathError extends Error {
  readonly code = 'MEMORY_PATH_REJECTED';
  constructor(message: string) {
    super(message);
    this.name = 'MemoryPathError';
  }
}

export interface ApplyMemoryWriteInput {
  /** Path relative to the memory root (defaults to global.md / space.md by scope) */
  readonly path?: string;
  readonly content: string;
  readonly mode?: MemoryWriteMode;
  readonly expectedEtag?: string;
}

export interface ApplyMemoryWriteOptions {
  /**
   * Refuse symlinks anywhere between the memory root and the target, and refuse non-regular
   * targets. Used by the platform when it writes the host copy on behalf of a container.
   */
  readonly rejectSymlinks?: boolean;
  /**
   * Keep the replaced file's mode bits and (best effort) owner, and give new files/directories
   * the read access their parent directory grants. Used by the platform so that a write to the
   * host copy never makes it unreadable for the container user.
   */
  readonly preservePermissions?: boolean;
}

/**
 * Checks `expectedEtag` against the current content. Throws MemoryWriteConflictError on mismatch.
 */
export function assertMemoryEtag(
  expectedEtag: string | undefined,
  existing: { content: string } | null
): string | undefined {
  if (!existing) {
    if (expectedEtag) {
      throw new MemoryWriteConflictError('Memory write conflict: expectedEtag provided but file does not exist');
    }
    return undefined;
  }
  const prevHash = computeContentHash(existing.content);
  const prevShortHash = prevHash.slice(0, 16);
  const previousEtag = `"${prevShortHash}"`;
  if (expectedEtag) {
    const raw = expectedEtag.trim();
    const cleanExpected = raw.replace(/^W\//, '').trim();
    const unquotedExpected =
      cleanExpected.startsWith('"') && cleanExpected.endsWith('"') && cleanExpected.length >= 2
        ? cleanExpected.slice(1, -1)
        : cleanExpected;

    const matches =
      raw === previousEtag ||
      cleanExpected === previousEtag ||
      unquotedExpected === prevShortHash ||
      unquotedExpected === prevHash ||
      cleanExpected === `"${prevHash}"`;

    if (!matches) {
      throw new MemoryWriteConflictError(
        `Memory write conflict: expectedEtag "${expectedEtag}" does not match current etag ${previousEtag}`
      );
    }
  }
  return previousEtag;
}

function assertNoSymlinkBetween(memoryRoot: string, targetPath: string): void {
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(memoryRoot);
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === 'ENOENT') return;
    throw err;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new MemoryPathError('Memory root must be a real directory');
  }
  const rel = path.relative(memoryRoot, targetPath);
  const parts = rel.split(path.sep).filter(Boolean);
  let cur = memoryRoot;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === 'ENOENT') return;
      throw err;
    }
    if (st.isSymbolicLink()) {
      throw new MemoryPathError('Memory path must not traverse symbolic links');
    }
    const isLast = i === parts.length - 1;
    if (!isLast && !st.isDirectory()) {
      throw new MemoryPathError('Memory path parent is not a directory');
    }
    if (isLast && !st.isFile()) {
      throw new MemoryPathError('Memory path target is not a regular file');
    }
  }
}

/**
 * Applies a memory write (overwrite/append with etag CAS) to a file inside `memoryRoot`.
 * Shared by the in-runtime memory_write tool and the platform-side writer of the host copy,
 * so both keep identical etag and append semantics.
 */
export function applyMemoryWriteAtRoot(
  memoryRoot: string,
  scope: MemoryScope,
  input: ApplyMemoryWriteInput,
  options: ApplyMemoryWriteOptions = {}
): MemoryWriteResult & { targetPath: string } {
  if (typeof input.content !== 'string') {
    throw new TypeError('memory_write requires a content string');
  }
  const contentBytes = Buffer.byteLength(input.content, 'utf-8');
  if (contentBytes > MAX_WRITE_BYTES) {
    throw new TypeError(`Memory write content exceeds maximum limit of ${MAX_WRITE_BYTES} bytes`);
  }
  const mode: MemoryWriteMode = input.mode ?? 'overwrite';
  if (mode !== 'overwrite' && mode !== 'append') {
    throw new TypeError('memory_write mode must be "overwrite" or "append"');
  }

  const { targetPath, relPath } = resolveSafeMemoryPathInRoot(input.path, scope, memoryRoot);
  if (options.rejectSymlinks) {
    assertNoSymlinkBetween(memoryRoot, targetPath);
  }

  const isNewFile = !fs.existsSync(targetPath);
  const existingContent = isNewFile ? '' : fs.readFileSync(targetPath, 'utf-8');
  const previousEtag = assertMemoryEtag(input.expectedEtag, isNewFile ? null : { content: existingContent });

  let finalContent = input.content;
  if (mode === 'append' && !isNewFile) {
    finalContent = existingContent.endsWith('\n')
      ? `${existingContent}${input.content}`
      : `${existingContent}\n${input.content}`;
  }

  atomicWriteFileSync(targetPath, finalContent, { preservePermissions: options.preservePermissions === true });

  const newHash = computeContentHash(finalContent);
  return {
    success: true,
    path: relPath,
    scope,
    bytesWritten: Buffer.byteLength(finalContent, 'utf-8'),
    etag: `"${newHash.slice(0, 16)}"`,
    mode,
    isNewFile,
    ...(previousEtag !== undefined ? { previousEtag } : {}),
    targetPath,
  };
}

/** Container-side route that forwards global memory writes to the platform. */
export const PLATFORM_MEMORY_WRITE_ROUTE = '/api/user-assets/memory/write';

function errorStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'status' in err && typeof (err as { status: unknown }).status === 'number') {
    return (err as { status: number }).status;
  }
  return undefined;
}

function errorMessageFromResponse(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const data = (err as { responseData?: unknown }).responseData;
  if (data && typeof data === 'object') {
    const e = (data as { error?: unknown }).error;
    if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') {
      return (e as { message: string }).message;
    }
  }
  return undefined;
}

/**
 * Creates the memory_write tool definition.
 */
export function createMemoryWriteTool(options: MemoryWriteToolOptions): ToolDefinition {
  const { dshHome, spacePath, spaceId, userId, getClient } = options;
  const globalWriteTarget = options.globalMemoryWrite ?? 'local';

  return {
    name: 'memory_write',
    description:
      'Write or append knowledge, user preferences, or facts into persistent global memory or current space memory. Supports optimistic concurrency via expectedEtag.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'Text or Markdown content to write or append to the memory file.',
        },
        path: {
          type: 'string',
          description: 'Relative file path inside the memory root (e.g. "global.md", "space.md", "2026-08-30.md", "topics/ideas.md"). Defaults to "global.md" or "space.md".',
        },
        scope: {
          type: 'string',
          enum: ['global', 'space'],
          description: 'Target memory scope: "global" (accessible across all sessions) or "space" (confined to current space). Defaults to "global".',
        },
        mode: {
          type: 'string',
          enum: ['overwrite', 'append'],
          description: 'Write mode: "overwrite" (replace entire file) or "append" (add to end of file). Defaults to "overwrite".',
        },
        expectedEtag: {
          type: 'string',
          description: 'Optional expected etag/hash of existing file for optimistic concurrency control. Throws error if file was modified by another session.',
        },
      },
      required: ['content'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          path: { type: 'string' },
          scope: { type: 'string', enum: ['global', 'space'] },
          bytesWritten: { type: 'integer' },
          etag: { type: 'string' },
          mode: { type: 'string', enum: ['overwrite', 'append'] },
          isNewFile: { type: 'boolean' },
          previousEtag: { type: 'string' },
        },
        required: ['success', 'path', 'scope', 'bytesWritten', 'etag', 'mode', 'isNewFile'],
        additionalProperties: false,
      },
      render: (_args: unknown, val: unknown) => {
        const value = val as MemoryWriteResult;
        return [
          {
            type: 'text',
            text: `Memory updated: [${value.scope}] ${value.path} (${value.bytesWritten} bytes ${value.mode}ed, new etag: ${value.etag})`,
          },
        ];
      },
    },
    async execute(rawArgs: unknown): Promise<MemoryWriteResult> {
      const args = (rawArgs ?? {}) as MemoryWriteArgs;
      if (typeof args.content !== 'string') {
        throw new TypeError('memory_write requires a content string');
      }

      const content = args.content;
      const contentBytes = Buffer.byteLength(content, 'utf-8');
      if (contentBytes > MAX_WRITE_BYTES) {
        throw new TypeError(`Memory write content exceeds maximum limit of ${MAX_WRITE_BYTES} bytes`);
      }

      const scope: MemoryScope = args.scope ?? 'global';
      const mode: MemoryWriteMode = args.mode ?? 'overwrite';

      // 1. Resolve safe target path
      const { targetPath, relPath } = resolveSafeMemoryPath(args.path, scope, dshHome, spacePath);

      // 1b. Container runtimes: global memory is the host copy (read-only mount here).
      //     The platform writes it; identity comes from the tunnel, never from this request.
      if (scope === 'global' && globalWriteTarget === 'platform') {
        const client = getClient ? getClient() : undefined;
        if (!client || typeof client.request !== 'function') {
          throw new Error('Global memory write unavailable: platform connection is not ready');
        }
        let res: { data?: unknown; body?: unknown };
        try {
          res = await client.request(PLATFORM_MEMORY_WRITE_ROUTE, {
            method: 'POST',
            body: {
              scope: 'global',
              path: relPath,
              content,
              mode,
              ...(args.expectedEtag !== undefined ? { expectedEtag: args.expectedEtag } : {}),
            },
            timeoutMs: 15_000,
            maxRetries: 0,
          });
        } catch (err: unknown) {
          const status = errorStatus(err);
          const detail = errorMessageFromResponse(err);
          if (status === 409) {
            throw new MemoryWriteConflictError(detail ?? 'Memory write conflict: expectedEtag does not match current etag');
          }
          if (status === 404) {
            // The platform no longer serves this runtime's host memory (user asset mounts were
            // turned off, or the mount does not match the user's host copy). The runtime is
            // rebuilt when idle; until then global memory is read-only here.
            throw new Error(
              'Global memory write unavailable (HTTP 404): the platform no longer accepts host memory writes for this runtime. ' +
              'Global memory is read-only until the runtime is rebuilt (automatic when idle); nothing was written.'
            );
          }
          throw new Error(`Global memory write rejected by platform${status ? ` (HTTP ${status})` : ''}${detail ? `: ${detail}` : ''}`);
        }
        const payload = (res.data ?? res.body) as Partial<MemoryWriteResult> | undefined;
        if (!payload || payload.success !== true || typeof payload.etag !== 'string') {
          throw new Error('Global memory write failed: invalid platform response');
        }
        return {
          success: true,
          path: typeof payload.path === 'string' ? payload.path : relPath,
          scope: 'global',
          bytesWritten: typeof payload.bytesWritten === 'number' ? payload.bytesWritten : contentBytes,
          etag: payload.etag,
          mode,
          isNewFile: payload.isNewFile === true,
          ...(typeof payload.previousEtag === 'string' ? { previousEtag: payload.previousEtag } : {}),
        };
      }

      // 2. Check existing file state & optimistic concurrency
      const isNewFile = !fs.existsSync(targetPath);
      const existingContent = isNewFile ? '' : fs.readFileSync(targetPath, 'utf-8');
      const previousEtag = assertMemoryEtag(args.expectedEtag, isNewFile ? null : { content: existingContent });
      // 3. Compute final content
      let finalContent = content;
      if (mode === 'append' && !isNewFile) {
        finalContent = existingContent.endsWith('\n')
          ? `${existingContent}${content}`
          : `${existingContent}\n${content}`;
      }

      // 4. Try Platform Client for audit & quota if available
      const client = getClient ? getClient() : undefined;
      if (client && typeof client.request === 'function') {
        try {
          await client.request('/api/memory/write', {
            method: 'POST',
            body: {
              path: relPath,
              scope,
              mode,
              content: finalContent,
              userId,
              spaceId,
              ...(previousEtag !== undefined ? { previousEtag } : {}),
            },
            timeoutMs: 15_000,
          });
        } catch {
          // Fall back to direct atomic local write if platform server offline or endpoint missing
        }
      }

      // 5. Write atomically to disk
      atomicWriteFileSync(targetPath, finalContent);

      const newHash = computeContentHash(finalContent);
      const newEtag = `"${newHash.slice(0, 16)}"`;
      const writtenBytes = Buffer.byteLength(finalContent, 'utf-8');

      return {
        success: true,
        path: relPath,
        scope,
        bytesWritten: writtenBytes,
        etag: newEtag,
        mode,
        isNewFile,
        ...(previousEtag !== undefined ? { previousEtag } : {}),
      };
    },
  };
}
