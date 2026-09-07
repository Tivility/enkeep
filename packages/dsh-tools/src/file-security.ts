import * as fs from 'node:fs';
import * as path from 'node:path';

export class FileSecurityError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'FileSecurityError';
    this.code = code;
    this.status = status;
  }
}

/** @internal */
export interface FileSecurityHooks {
  beforeOpen?: (targetPath: string) => void;
  afterOpen?: (fd: number, targetPath: string) => void;
  beforeRead?: (fd: number, targetPath: string) => void;
  closeOverride?: (fd: number) => void;
  resolveFdPath?: (fd: number, targetPath?: string) => string | null;
}

let defaultFileSecurityHooks: FileSecurityHooks | undefined;

/** @internal */
export function setDefaultFileSecurityHooks(hooks?: FileSecurityHooks | undefined): void {
  defaultFileSecurityHooks = hooks;
}

/** @internal */
export function getDefaultFileSecurityHooks(): FileSecurityHooks | undefined {
  return defaultFileSecurityHooks;
}

/**
 * Test helper to create a simulated FD resolver for unit tests on non-Linux platforms (e.g. macOS).
 * @internal
 */
export function createSimulatedFdResolver(
  overrideMap?: Map<number, string> | Record<number, string>
): (fd: number, targetPath?: string) => string | null {
  return (fd: number, targetPath?: string): string | null => {
    if (overrideMap) {
      if (overrideMap instanceof Map && overrideMap.has(fd)) {
        return overrideMap.get(fd)!;
      }
      if (typeof overrideMap === 'object' && fd in overrideMap) {
        return (overrideMap as Record<number, string>)[fd];
      }
    }
    return targetPath ?? null;
  };
}

export interface ValidateFileOptions {
  workspaceRoot: string;
  filePath: string;
  maxSizeBytes?: number;
  /**
   * Optional concurrency / TOCTOU simulation test hooks
   * @internal
   */
  hooks?: FileSecurityHooks;
}

export interface ValidatedFile {
  canonicalPath: string;
  relativePath: string;
  filename: string;
  size: number;
}

export interface ValidatedFileWithContent extends ValidatedFile {
  content: Buffer;
}

export const DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_PATH_LENGTH = 4096;
export const MAX_FILENAME_LENGTH = 255;

interface AncestorSnapshot {
  path: string;
  dev: number;
  ino: number;
}

function mapNodeErrorToSecurityError(
  err: unknown,
  fallbackMessage: string,
  fallbackCode: string,
  fallbackStatus = 400
): FileSecurityError {
  if (err instanceof FileSecurityError) {
    return err;
  }
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (code === 'ENOENT') {
      return new FileSecurityError('File or directory not found', 'FILE_NOT_FOUND', 404);
    }
    if (code === 'ELOOP' || code === 'EMLINK') {
      return new FileSecurityError('Symbolic link detected', 'SYMLINK_DISALLOWED', 403);
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return new FileSecurityError('Permission denied', 'ACCESS_DENIED', 403);
    }
    if (code === 'ENOTDIR') {
      return new FileSecurityError('Path component is not a directory', 'NOT_A_DIRECTORY', 400);
    }
    if (code === 'EISDIR') {
      return new FileSecurityError('Target is a directory, not a regular file', 'NOT_A_REGULAR_FILE', 400);
    }
    if (code === 'EINVAL') {
      return new FileSecurityError('Invalid path argument', 'INVALID_PATH', 400);
    }
  }
  return new FileSecurityError(fallbackMessage, fallbackCode, fallbackStatus);
}

/**
 * Resolves the actual filesystem path pointed to by an open file descriptor.
 * On Linux, /proc/self/fd/${fd} is mandatory and authoritative.
 * On non-Linux platforms (e.g. macOS /dev/fd), if kernel resolution is unsupported or cannot
 * resolve the real underlying target path, the system fails closed by throwing FD_RESOLUTION_UNSUPPORTED.
 * Test hooks can provide resolveFdPath to simulate kernel resolution.
 */
function getActualFdPath(fd: number, hooks?: FileSecurityHooks, targetPath?: string): string {
  if (hooks?.resolveFdPath) {
    const resolved = hooks.resolveFdPath(fd, targetPath);
    if (!resolved || typeof resolved !== 'string' || resolved.trim() === '' || resolved.startsWith('/dev/fd/')) {
      throw new FileSecurityError(
        'Kernel file descriptor path resolution is unsupported or failed on this platform (fail-closed policy)',
        'FD_RESOLUTION_UNSUPPORTED',
        500
      );
    }
    return resolved;
  }

  if (process.platform === 'linux') {
    const procPath = `/proc/self/fd/${fd}`;
    let resolved: string;
    try {
      resolved = fs.realpathSync(procPath);
    } catch {
      try {
        resolved = fs.readlinkSync(procPath);
      } catch (err: unknown) {
        throw mapNodeErrorToSecurityError(
          err,
          'Unable to resolve opened file descriptor target on Linux',
          'FD_RESOLUTION_FAILED',
          403
        );
      }
    }

    if (!resolved || resolved.startsWith('/dev/fd/')) {
      throw new FileSecurityError(
        'Kernel file descriptor path resolution is unsupported or failed on this platform (fail-closed policy)',
        'FD_RESOLUTION_UNSUPPORTED',
        500
      );
    }

    return resolved;
  }

  // Non-Linux platforms (e.g. macOS /dev/fd)
  try {
    const devFdPath = `/dev/fd/${fd}`;
    const resolved = fs.realpathSync(devFdPath);
    if (resolved && !resolved.startsWith('/dev/fd/')) {
      return resolved;
    }
  } catch {
    // Ignore fallback resolution failure and fail closed below
  }

  throw new FileSecurityError(
    'Kernel file descriptor path resolution is unsupported or failed on this platform (fail-closed policy)',
    'FD_RESOLUTION_UNSUPPORTED',
    500
  );
}

/**
 * Validates file path containment strictly, snapshots all ancestor directories,
 * opens file with O_RDONLY and O_NOFOLLOW, re-verifies all ancestor directories and target file
 * to prevent parent-component and target TOCTOU race conditions, checks opened file descriptor
 * containment via kernel fd target, and reads the content atomically into a Buffer.
 */
export function readValidatedFile(options: ValidateFileOptions): ValidatedFileWithContent {
  const { workspaceRoot, filePath, maxSizeBytes = DEFAULT_MAX_FILE_SIZE_BYTES } = options;

  if (!filePath || typeof filePath !== 'string' || filePath.trim() === '') {
    throw new FileSecurityError('File path must be a non-empty string', 'INVALID_PATH', 400);
  }

  if (filePath.length > MAX_PATH_LENGTH) {
    throw new FileSecurityError(
      'File path exceeds maximum allowed length',
      'PATH_TOO_LONG',
      400
    );
  }

  // Null byte injection protection
  if (filePath.includes('\0')) {
    throw new FileSecurityError('Null byte injection detected in path', 'NULL_BYTE_INJECTION', 400);
  }

  // Strict relative path enforcement (reject absolute paths immediately)
  if (
    path.isAbsolute(filePath) ||
    filePath.startsWith('/') ||
    filePath.startsWith('\\') ||
    /^[a-zA-Z]:[\\\/]/.test(filePath)
  ) {
    throw new FileSecurityError(
      'Absolute paths are not allowed. Path must be relative to the workspace root.',
      'ABSOLUTE_PATH_DISALLOWED',
      400
    );
  }

  if (!workspaceRoot || typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {
    throw new FileSecurityError('Workspace root must be a valid directory path', 'INVALID_WORKSPACE_ROOT', 500);
  }

  if (workspaceRoot.length > MAX_PATH_LENGTH) {
    throw new FileSecurityError(
      'Workspace root path exceeds maximum allowed length',
      'PATH_TOO_LONG',
      500
    );
  }

  if (workspaceRoot.includes('\0')) {
    throw new FileSecurityError('Null byte injection detected in workspace root', 'NULL_BYTE_INJECTION', 500);
  }

  if (!path.isAbsolute(workspaceRoot)) {
    throw new FileSecurityError(
      'Workspace root must be an absolute path',
      'INVALID_WORKSPACE_ROOT',
      500
    );
  }

  // Workspace Root lstat validation: must exist, must not be a symlink, and must be a directory
  let wsLstat: fs.Stats;
  try {
    wsLstat = fs.lstatSync(workspaceRoot);
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'ENOENT') {
      throw new FileSecurityError('Workspace root not found', 'WORKSPACE_ROOT_NOT_FOUND', 500);
    }
    throw mapNodeErrorToSecurityError(err, 'Failed to inspect workspace root', 'WORKSPACE_ROOT_NOT_FOUND', 500);
  }

  if (wsLstat.isSymbolicLink()) {
    throw new FileSecurityError(
      'Workspace root cannot be a symbolic link',
      'WORKSPACE_ROOT_IS_SYMLINK',
      403
    );
  }

  if (!wsLstat.isDirectory()) {
    throw new FileSecurityError(
      'Workspace root is not a directory',
      'WORKSPACE_ROOT_NOT_DIRECTORY',
      400
    );
  }

  // Canonical workspace root
  let canonicalWorkspace: string;
  try {
    canonicalWorkspace = fs.realpathSync(workspaceRoot);
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'ENOENT') {
      throw new FileSecurityError('Workspace root not found', 'WORKSPACE_ROOT_NOT_FOUND', 500);
    }
    throw mapNodeErrorToSecurityError(err, 'Failed to resolve workspace root', 'WORKSPACE_ROOT_NOT_FOUND', 500);
  }

  // Snapshot canonical workspace root (ancestor 0)
  let canonicalWsLstat: fs.Stats;
  try {
    canonicalWsLstat = fs.lstatSync(canonicalWorkspace);
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'ENOENT') {
      throw new FileSecurityError('Workspace root not found', 'WORKSPACE_ROOT_NOT_FOUND', 500);
    }
    throw mapNodeErrorToSecurityError(err, 'Failed to inspect workspace root', 'WORKSPACE_ROOT_NOT_FOUND', 500);
  }

  if (canonicalWsLstat.isSymbolicLink()) {
    throw new FileSecurityError(
      'Workspace root cannot be a symbolic link',
      'WORKSPACE_ROOT_IS_SYMLINK',
      403
    );
  }

  if (!canonicalWsLstat.isDirectory()) {
    throw new FileSecurityError(
      'Workspace root is not a directory',
      'WORKSPACE_ROOT_NOT_DIRECTORY',
      400
    );
  }

  const ancestorSnapshots: AncestorSnapshot[] = [
    {
      path: canonicalWorkspace,
      dev: canonicalWsLstat.dev,
      ino: canonicalWsLstat.ino,
    },
  ];

  // Resolve target path strictly against canonical workspace root
  const resolvedTarget = path.resolve(canonicalWorkspace, filePath);

  // Exact relative containment check
  const rel = path.relative(canonicalWorkspace, resolvedTarget);
  if (!rel || rel === '' || rel === '.' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new FileSecurityError(
      'Access denied: path traverses outside workspace boundary',
      'PATH_TRAVERSAL_DETECTED',
      403
    );
  }

  // Bounded filename validation
  const filename = path.basename(resolvedTarget);
  if (!filename || filename === '.' || filename === '..' || filename.length > MAX_FILENAME_LENGTH) {
    throw new FileSecurityError(
      'Filename is invalid or exceeds maximum allowed length',
      'INVALID_FILENAME',
      400
    );
  }

  // Check all intermediate components and target file for symlinks and existence, snapshotting ancestors
  const segments = rel.split(/[\\\/]+/).filter(Boolean);
  let current = canonicalWorkspace;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    current = path.join(current, segment);
    let segmentLstat: fs.Stats;
    try {
      segmentLstat = fs.lstatSync(current);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'ENOENT') {
        throw new FileSecurityError('File not found', 'FILE_NOT_FOUND', 404);
      }
      throw mapNodeErrorToSecurityError(err, 'Failed to inspect path component', 'FILE_STAT_FAILED', 400);
    }

    if (segmentLstat.isSymbolicLink()) {
      throw new FileSecurityError(
        'Symbolic link detected in path. Symlinks are strictly disallowed.',
        'SYMLINK_DISALLOWED',
        403
      );
    }

    const isLast = i === segments.length - 1;
    if (!isLast) {
      if (!segmentLstat.isDirectory()) {
        throw new FileSecurityError(
          'Intermediate path component is not a directory',
          'NOT_A_DIRECTORY',
          400
        );
      }
      ancestorSnapshots.push({
        path: current,
        dev: segmentLstat.dev,
        ino: segmentLstat.ino,
      });
    }
  }

  // Effective hooks for testing and simulation
  const effectiveHooks: FileSecurityHooks | undefined = options.hooks || defaultFileSecurityHooks
    ? { ...defaultFileSecurityHooks, ...options.hooks }
    : undefined;

  // Optional test hook before opening file descriptor
  effectiveHooks?.beforeOpen?.(resolvedTarget);

  // Open file securely with O_RDONLY and O_NOFOLLOW (exact no fallback)
  const openFlags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
  let fd: number | undefined;
  let primaryError: unknown = null;

  try {
    try {
      fd = fs.openSync(resolvedTarget, openFlags);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err) {
        const code = (err as { code?: unknown }).code;
        if (code === 'ENOENT') {
          throw new FileSecurityError('File not found', 'FILE_NOT_FOUND', 404);
        }
        if (code === 'ELOOP' || code === 'EMLINK' || code === 'EINVAL') {
          throw new FileSecurityError(
            'Symbolic link detected when opening file. Symlinks are strictly disallowed.',
            'SYMLINK_DISALLOWED',
            403
          );
        }
      }
      throw mapNodeErrorToSecurityError(err, 'Failed to open file', 'FILE_OPEN_FAILED', 400);
    }

    // Optional test hook after opening descriptor
    effectiveHooks?.afterOpen?.(fd, resolvedTarget);

    // Immediately re-lstat canonicalWorkspace and every ancestor directory in the path
    for (const snap of ancestorSnapshots) {
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(snap.path);
      } catch {
        throw new FileSecurityError(
          'Parent directory component swapped or modified during open (TOCTOU detected)',
          'TOCTOU_SWAP_DETECTED',
          403
        );
      }

      if (
        stat.isSymbolicLink() ||
        !stat.isDirectory() ||
        stat.dev !== snap.dev ||
        stat.ino !== snap.ino
      ) {
        throw new FileSecurityError(
          'Parent directory component swapped or modified during open (TOCTOU detected)',
          'TOCTOU_SWAP_DETECTED',
          403
        );
      }
    }

    // Immediately inspect opened descriptor
    let fdStat: fs.Stats;
    try {
      fdStat = fs.fstatSync(fd);
    } catch (err: unknown) {
      throw mapNodeErrorToSecurityError(err, 'Failed to inspect opened file descriptor', 'FILE_STAT_FAILED', 400);
    }

    if (!fdStat.isFile()) {
      throw new FileSecurityError(
        'Target is not a regular file (e.g. is a directory, socket, or device)',
        'NOT_A_REGULAR_FILE',
        400
      );
    }

    if (fdStat.size > maxSizeBytes) {
      throw new FileSecurityError(
        'File size exceeds the maximum allowed limit',
        'FILE_TOO_LARGE',
        413
      );
    }

    // Verify opened descriptor canonical identity against lstat to prevent TOCTOU swap
    let targetLstat: fs.Stats;
    try {
      targetLstat = fs.lstatSync(resolvedTarget);
    } catch (err: unknown) {
      throw mapNodeErrorToSecurityError(err, 'Failed to verify file identity', 'FILE_STAT_FAILED', 400);
    }

    if (targetLstat.isSymbolicLink()) {
      throw new FileSecurityError(
        'Symbolic link detected for target file. Symlinks are strictly disallowed.',
        'SYMLINK_DISALLOWED',
        403
      );
    }

    if (fdStat.dev !== targetLstat.dev || fdStat.ino !== targetLstat.ino) {
      throw new FileSecurityError(
        'File identity mismatch (TOCTOU swap detected)',
        'TOCTOU_SWAP_DETECTED',
        403
      );
    }

    // Validate actual opened file descriptor target containment (fail-closed if unsupported or outside workspace)
    const actualFdPath = getActualFdPath(fd, effectiveHooks, resolvedTarget);
    const fdRel = path.relative(canonicalWorkspace, actualFdPath);
    if (!fdRel || fdRel === '' || fdRel === '.' || fdRel.startsWith('..') || path.isAbsolute(fdRel)) {
      throw new FileSecurityError(
        'Opened file descriptor resolves outside workspace boundary',
        'PATH_TRAVERSAL_DETECTED',
        403
      );
    }

    effectiveHooks?.beforeRead?.(fd, resolvedTarget);

    // Read content directly from file descriptor
    let content: Buffer;
    try {
      content = fs.readFileSync(fd);
    } catch (err: unknown) {
      throw mapNodeErrorToSecurityError(err, 'Failed to read file descriptor', 'FILE_READ_FAILED', 400);
    }

    if (content.length > maxSizeBytes) {
      throw new FileSecurityError(
        'File size exceeds the maximum allowed limit',
        'FILE_TOO_LARGE',
        413
      );
    }

    return {
      canonicalPath: resolvedTarget,
      relativePath: rel,
      filename,
      size: content.length,
      content,
    };
  } catch (err) {
    primaryError = err;
    throw err;
  } finally {
    if (fd !== undefined) {
      try {
        if (effectiveHooks?.closeOverride) {
          effectiveHooks.closeOverride(fd);
        } else {
          fs.closeSync(fd);
        }
      } catch (closeErr) {
        if (primaryError) {
          throw new AggregateError(
            [primaryError, closeErr],
            'File security validation failed, and closing descriptor also failed'
          );
        } else {
          throw closeErr;
        }
      }
    }
  }
}

/**
 * Executes a callback with atomically validated and read file data.
 */
export async function withValidatedFile<T>(
  options: ValidateFileOptions,
  fn: (file: ValidatedFileWithContent) => T | Promise<T>
): Promise<T> {
  const validated = readValidatedFile(options);
  return await fn(validated);
}

/**
 * Validates a file path strictly against workspace containment, relative path constraints,
 * symlink breakout, null-byte injection, file existence, and maximum file size.
 */
export function validateFileContainment(options: ValidateFileOptions): ValidatedFile {
  const result = readValidatedFile(options);
  return {
    canonicalPath: result.canonicalPath,
    relativePath: result.relativePath,
    filename: result.filename,
    size: result.size,
  };
}
