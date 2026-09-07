/**
 * In-Container Structured File Operations for Zero-Network Runtime
 *
 * Implements hardened, isolated file operations (list, read, write, mkdir, delete, rename)
 * strictly constrained to `/home/dsh/spaces/<validated space>`.
 *
 * @module @enkeep/runtime-runner/runtime/file-ops
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const SPACE_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
export const ETAG_REGEX = /^"[0-9a-f]{64}"$/;
export const MAX_FILE_OP_BYTES = 1024 * 1024; // 1 MiB (1,048,576 bytes)
export const MAX_STREAMING_FILE_BYTES = 50 * 1024 * 1024; // 50 MiB (52,428,800 bytes)
export const MAX_GLOBAL_INSTRUCTIONS_BYTES = 20 * 1024; // 20 KiB (20,480 bytes)
export const MAX_SPACE_INSTRUCTIONS_BYTES = 64 * 1024; // 64 KiB (65,536 bytes)
export const MAX_DIR_ENTRIES = 500; // Maximum directory listing entries
export const MAX_LOCK_OWNER_BYTES = 4096; // Maximum lock owner metadata payload size

/**
 * Strict canonical request keys permitted at container runtime.
 */
const ALLOWED_REQUEST_KEYS = new Set([
  'op',
  'space',
  'targetSpace',
  'path',
  'targetPath',
  'content',
  'encoding',
  'expectedEtag',
  'expectedTargetEtag',
  'requireAbsent',
  'requireTargetAbsent',
  'maxBytes',
]);

export type FileOpType = 'list' | 'read' | 'write' | 'mkdir' | 'delete' | 'rename' | 'stat' | 'sniff' | 'copy';

export interface FileStatRequest {
  readonly op: 'stat';
  readonly space: string;
  readonly path: string;
}

export interface FileSniffRequest {
  readonly op: 'sniff';
  readonly space: string;
  readonly path: string;
  readonly maxBytes?: number;
}

export interface FileCopyRequest {
  readonly op: 'copy';
  readonly space: string;
  readonly path: string;
  readonly targetPath: string;
  readonly expectedEtag?: string;
  readonly requireAbsent?: boolean;
}

export interface CanonicalStatResult {
  readonly op: 'stat';
  readonly space: string;
  readonly path: string;
  readonly type: 'file' | 'directory';
  readonly size: number;
  readonly mtimeMs: number;
  readonly etag: string;
}

export interface CanonicalSniffResult {
  readonly op: 'sniff';
  readonly space: string;
  readonly path: string;
  readonly type: 'file';
  readonly size: number;
  readonly mtimeMs: number;
  readonly etag: string;
  readonly headerBytesBase64: string;
}

export interface CanonicalCopyResult {
  readonly op: 'copy';
  readonly space: string;
  readonly path: string;
  readonly targetPath: string;
  readonly type: 'file';
  readonly size: number;
  readonly mtimeMs: number;
  readonly etag: string;
}

export interface FileListEntry {
  readonly name: string;
  readonly type: 'file' | 'directory' | 'symlink' | 'other';
  readonly size: number;
  readonly mtimeMs: number;
  readonly etag?: string;
}

export interface CanonicalDirectoryEntryRecord {
  readonly name: string;
  readonly type: 'file' | 'directory' | 'symlink' | 'other';
  readonly size: number;
  readonly mtimeMs: number;
}

export interface FileListRequest {
  readonly op: 'list';
  readonly space: string;
  readonly path?: string;
  readonly targetPath?: never;
  readonly content?: never;
  readonly encoding?: never;
  readonly expectedEtag?: never;
  readonly expectedTargetEtag?: never;
  readonly requireAbsent?: never;
  readonly requireTargetAbsent?: never;
}

export interface FileReadRequest {
  readonly op: 'read';
  readonly space: string;
  readonly path?: string;
  readonly encoding?: 'utf8' | 'base64';
  readonly targetPath?: never;
  readonly content?: never;
  readonly expectedEtag?: never;
  readonly expectedTargetEtag?: never;
  readonly requireAbsent?: never;
  readonly requireTargetAbsent?: never;
}

export interface FileWriteExpectedEtagRequest {
  readonly op: 'write';
  readonly space: string;
  readonly path: string;
  readonly content?: string;
  readonly encoding?: 'utf8' | 'base64';
  readonly expectedEtag: string;
  readonly requireAbsent?: never;
  readonly targetPath?: never;
  readonly expectedTargetEtag?: never;
  readonly requireTargetAbsent?: never;
}

export interface FileWriteRequireAbsentRequest {
  readonly op: 'write';
  readonly space: string;
  readonly path: string;
  readonly content?: string;
  readonly encoding?: 'utf8' | 'base64';
  readonly requireAbsent: true;
  readonly expectedEtag?: never;
  readonly targetPath?: never;
  readonly expectedTargetEtag?: never;
  readonly requireTargetAbsent?: never;
}

export type FileWriteRequest = FileWriteExpectedEtagRequest | FileWriteRequireAbsentRequest;

export interface FileMkdirRequest {
  readonly op: 'mkdir';
  readonly space: string;
  readonly path: string;
  readonly requireAbsent: true;
  readonly targetPath?: never;
  readonly content?: never;
  readonly encoding?: never;
  readonly expectedEtag?: never;
  readonly expectedTargetEtag?: never;
  readonly requireTargetAbsent?: never;
}

export interface FileDeleteRequest {
  readonly op: 'delete';
  readonly space: string;
  readonly path: string;
  readonly expectedEtag: string;
  readonly targetPath?: never;
  readonly content?: never;
  readonly encoding?: never;
  readonly expectedTargetEtag?: never;
  readonly requireAbsent?: never;
  readonly requireTargetAbsent?: never;
}

export interface FileRenameExpectedTargetEtagRequest {
  readonly op: 'rename';
  readonly space: string;
  readonly path: string;
  readonly targetPath: string;
  readonly expectedEtag: string;
  readonly expectedTargetEtag: string;
  readonly requireTargetAbsent?: never;
  readonly content?: never;
  readonly encoding?: never;
  readonly requireAbsent?: never;
}

export interface FileRenameRequireTargetAbsentRequest {
  readonly op: 'rename';
  readonly space: string;
  readonly path: string;
  readonly targetPath: string;
  readonly expectedEtag: string;
  readonly requireTargetAbsent: true;
  readonly expectedTargetEtag?: never;
  readonly content?: never;
  readonly encoding?: never;
  readonly requireAbsent?: never;
}

export type FileRenameRequest = FileRenameExpectedTargetEtagRequest | FileRenameRequireTargetAbsentRequest;

export interface FileCopyRequest {
  readonly op: 'copy';
  readonly space: string;
  readonly path: string;
  readonly targetPath: string;
  readonly targetSpace?: string;
  readonly expectedEtag?: string;
  readonly requireAbsent?: boolean;
}

export type FileOperationRequest =
  | FileListRequest
  | FileReadRequest
  | FileWriteRequest
  | FileMkdirRequest
  | FileDeleteRequest
  | FileRenameRequest
  | FileCopyRequest;

export interface FileOperationResult {
  readonly op: FileOpType;
  readonly space: string;
  readonly path: string;
  readonly targetPath?: string;
  readonly type?: 'file' | 'directory';
  readonly entries?: readonly FileListEntry[];
  readonly truncated?: boolean;
  readonly content?: string;
  readonly encoding?: 'utf8' | 'base64';
  readonly size?: number;
  readonly mtimeMs?: number;
  readonly etag?: string;
  readonly written?: boolean;
  readonly created?: boolean;
  readonly deleted?: boolean;
  readonly renamed?: boolean;
  readonly headerBytesBase64?: string;
  readonly stageToken?: string;
  readonly sha256?: string;
}

export const FILE_OP_ERROR_MESSAGES: Record<string, string> = {
  INVALID_SPACE: 'Invalid space identifier',
  INVALID_PATH: 'Invalid relative path',
  PATH_TRAVERSAL: 'Path traversal forbidden',
  SECURITY_VIOLATION: 'Ownership security violation',
  NOT_FOUND: 'Target not found',
  SYMLINK_FORBIDDEN: 'Symbolic link forbidden',
  INVALID_TARGET: 'Invalid target type',
  INVALID_REQUEST: 'Invalid request parameter',
  INVALID_OP: 'Unsupported file operation',
  INVALID_PAYLOAD: 'Invalid payload content',
  FILE_TOO_LARGE: 'File size exceeds maximum limit',
  PAYLOAD_TOO_LARGE: 'Payload size exceeds maximum limit',
  READ_FAILED: 'Failed to read file',
  WRITE_FAILED: 'Failed to write file',
  RENAME_FAILED: 'Failed to rename target',
  PRECONDITION_FAILED: 'Precondition failed',
  TARGET_EXISTS: 'Target already exists',
  TOCTOU_MISMATCH: 'File identity mismatch during operation',
  FORBIDDEN: 'Operation strictly prohibited',
  BUSY: 'Resource is busy or lock contention encountered',
  LOCK_UNAVAILABLE: 'Lock base directory unavailable',
  STORAGE_METADATA_INVALID: 'Invalid or inaccessible storage metadata',
};

export class FileOpError extends Error {
  readonly code: string;
  constructor(code: string, _customMessage?: string) {
    const fixedMessage = FILE_OP_ERROR_MESSAGES[code] ?? 'File operation failed';
    super(fixedMessage);
    this.code = code;
    this.name = 'FileOpError';
  }
}

/**
 * Validates if an ETag is a strictly compliant raw quoted 64-char lowercase hex string.
 */
export function isValidETag(etag: unknown): etag is string {
  return typeof etag === 'string' && ETAG_REGEX.test(etag);
}

/**
 * Returns O_NOFOLLOW constant guaranteed to be a non-zero positive number.
 */
export function getNoFollowFlag(): number {
  const flag = fs.constants.O_NOFOLLOW;
  if (typeof flag !== 'number' || flag === 0) {
    throw new FileOpError('BUSY');
  }
  return flag;
}

/**
 * Authoritatively computes a strong content ETag from byte contents.
 * Formatted as HTTP quoted lowercase hex SHA-256 hash.
 */
export function computeFileETag(buf: Buffer): string {
  const hash = crypto.createHash('sha256').update(buf).digest('hex').toLowerCase();
  return `"${hash}"`;
}

/**
 * Computes an authoritative directory ETag from canonical sorted entry metadata.
 * Formatted as HTTP quoted lowercase hex SHA-256 hash.
 */
export function computeDirectoryETag(
  entries: readonly CanonicalDirectoryEntryRecord[]
): string {
  const sorted = [...entries]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({
      name: e.name,
      type: e.type,
      size: e.size,
      mtimeMs: e.mtimeMs,
    }));
  const canonicalJson = JSON.stringify(sorted);
  const hash = crypto.createHash('sha256').update(canonicalJson).digest('hex').toLowerCase();
  return `"${hash}"`;
}

/**
 * Compares current ETag against expected ETag precondition using constant-time comparison.
 * Requires exact raw quoted SHA-256 string (no trim/weak/unquote).
 */
export function matchETag(currentEtag: string, expectedEtag: string): boolean {
  if (!isValidETag(currentEtag) || !isValidETag(expectedEtag)) {
    return false;
  }
  const currentBuf = Buffer.from(currentEtag, 'utf8');
  const expectedBuf = Buffer.from(expectedEtag, 'utf8');
  if (currentBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(currentBuf, expectedBuf);
}

export interface FileOpExecutionOptions {
  readonly spacesDir?: string;
  readonly lockDir?: string;
  readonly expectedUid?: number;
  readonly fsImpl?: typeof fs;
  readonly procStatReader?: (pid: number) => { starttime: string | number } | null;
}

export interface ProcessStatResult {
  readonly starttime: string;
}

/**
 * Reads process start time (clock ticks) from /proc/<pid>/stat on Linux.
 * Returns starttime if process exists, or null only if PID is absent (ENOENT/ESRCH/custom null).
 * Any malformed /proc or EPERM/EACCES/EIO error throws fixed BUSY.
 */
export function getProcessStartTicks(
  pid: number,
  filesystem: typeof fs = fs,
  customReader?: (pid: number) => { starttime: string | number } | null
): ProcessStatResult | null {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    throw new FileOpError('BUSY');
  }

  if (customReader) {
    try {
      const res = customReader(pid);
      if (res === null) {
        return null;
      }
      if (res && (typeof res.starttime === 'string' || typeof res.starttime === 'number')) {
        const strTicks = String(res.starttime).trim();
        if (/^\d+$/.test(strTicks)) {
          return { starttime: strTicks };
        }
      }
      throw new FileOpError('BUSY');
    } catch (err: unknown) {
      if (err instanceof FileOpError) throw err;
      throw new FileOpError('BUSY');
    }
  }

  const statPath = `/proc/${pid}/stat`;
  try {
    const statContent = filesystem.readFileSync(statPath, 'utf8');
    const lastParen = statContent.lastIndexOf(')');
    if (lastParen === -1) {
      throw new FileOpError('BUSY');
    }
    const rest = statContent.slice(lastParen + 1).trim().split(/\s+/);
    if (rest.length <= 19) {
      throw new FileOpError('BUSY');
    }
    const starttimeStr = rest[19];
    if (!/^\d+$/.test(starttimeStr)) {
      throw new FileOpError('BUSY');
    }
    return { starttime: starttimeStr };
  } catch (err: unknown) {
    if (err instanceof FileOpError) throw err;
    const errCode = (err as { code?: string })?.code;
    if (errCode === 'ENOENT' || errCode === 'ESRCH') {
      return null;
    }
    throw new FileOpError('BUSY');
  }
}

export interface LockOwnerMetadata {
  readonly pid: number;
  readonly procStartTicks: string;
  readonly nonce: string;
}

/**
 * Safely inspects and parses owner.json using O_RDONLY | O_NOFOLLOW and bounded read.
 * Strict exact keys: { pid, procStartTicks, nonce }.
 */
function readAndValidateOwnerFile(
  filesystem: typeof fs,
  ownerFilePath: string,
  expectedUid: number,
  nofollow: number
): LockOwnerMetadata {
  let fd: number | undefined;
  try {
    fd = filesystem.openSync(ownerFilePath, fs.constants.O_RDONLY | nofollow);
    const fstat = filesystem.fstatSync(fd);
    if (fstat.isSymbolicLink()) {
      throw new FileOpError('SYMLINK_FORBIDDEN');
    }
    if (!fstat.isFile()) {
      throw new FileOpError('BUSY');
    }
    if (fstat.size <= 0 || fstat.size > MAX_LOCK_OWNER_BYTES) {
      throw new FileOpError('BUSY');
    }
    verifyOwnership(fstat, expectedUid);

    const buf = Buffer.alloc(fstat.size);
    let bytesRead = 0;
    while (bytesRead < fstat.size) {
      const n = filesystem.readSync(fd, buf, bytesRead, fstat.size - bytesRead, bytesRead);
      if (n === 0) break;
      bytesRead += n;
    }
    if (bytesRead !== fstat.size) {
      throw new FileOpError('BUSY');
    }

    filesystem.closeSync(fd);
    fd = undefined;

    let parsed: unknown;
    try {
      parsed = JSON.parse(buf.toString('utf8'));
    } catch (parseErr: unknown) {
      throw new FileOpError('BUSY');
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new FileOpError('BUSY');
    }

    const obj = parsed as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length !== 3) {
      throw new FileOpError('BUSY');
    }
    if (!('pid' in obj) || !('procStartTicks' in obj) || !('nonce' in obj)) {
      throw new FileOpError('BUSY');
    }
    if (typeof obj.pid !== 'number' || !Number.isInteger(obj.pid) || obj.pid <= 0) {
      throw new FileOpError('BUSY');
    }
    if (typeof obj.procStartTicks !== 'string' || !/^\d+$/.test(obj.procStartTicks)) {
      throw new FileOpError('BUSY');
    }
    if (typeof obj.nonce !== 'string' || !/^[0-9a-fA-F]{32,}$/.test(obj.nonce)) {
      throw new FileOpError('BUSY');
    }

    return {
      pid: obj.pid,
      procStartTicks: obj.procStartTicks,
      nonce: obj.nonce,
    };
  } catch (err: unknown) {
    if (fd !== undefined) {
      try {
        filesystem.closeSync(fd);
      } catch (closeErr: unknown) {
        const primary = err instanceof Error ? err : new FileOpError('BUSY');
        const cleanup = closeErr instanceof Error ? closeErr : new FileOpError('BUSY');
        throw new AggregateError([primary, cleanup], 'Failed to close fd during owner file read');
      }
      fd = undefined;
    }
    if (err instanceof FileOpError) throw err;
    const code = (err as { code?: string })?.code;
    if (code === 'ELOOP') {
      throw new FileOpError('SYMLINK_FORBIDDEN');
    }
    throw new FileOpError('BUSY');
  }
}

/**
 * Validates and extracts exact finite nonnegative metadata from fs.Stats.
 */
export function extractValidMetadata(stat: fs.Stats): { size: number; mtimeMs: number } {
  const size = stat.size;
  const mtimeMs = stat.mtimeMs;

  if (
    typeof size !== 'number' ||
    !Number.isFinite(size) ||
    Number.isNaN(size) ||
    size < 0 ||
    !Number.isInteger(size)
  ) {
    throw new FileOpError('STORAGE_METADATA_INVALID');
  }

  if (
    typeof mtimeMs !== 'number' ||
    !Number.isFinite(mtimeMs) ||
    Number.isNaN(mtimeMs) ||
    mtimeMs < 0
  ) {
    throw new FileOpError('STORAGE_METADATA_INVALID');
  }

  return { size, mtimeMs };
}

/**
 * Recursively inspects a directory and computes its canonical entries and directory ETag,
 * verifying ownership and rejecting symlinks and special files.
 */
export function computeDirectoryETagRecursive(
  filesystem: typeof fs,
  dirPath: string,
  expectedUid?: number,
  nofollow?: number
): string {
  let stat: fs.Stats;
  try {
    stat = filesystem.lstatSync(dirPath);
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === 'ENOENT') {
      throw new FileOpError('NOT_FOUND');
    }
    throw new FileOpError('STORAGE_METADATA_INVALID');
  }

  if (stat.isSymbolicLink()) {
    throw new FileOpError('SYMLINK_FORBIDDEN');
  }
  if (!stat.isDirectory()) {
    throw new FileOpError('INVALID_TARGET');
  }
  verifyOwnership(stat, expectedUid);

  let rawEntries: fs.Dirent[];
  try {
    rawEntries = filesystem.readdirSync(dirPath, { withFileTypes: true });
  } catch (readDirErr: unknown) {
    throw new FileOpError('STORAGE_METADATA_INVALID');
  }
  rawEntries.sort((a, b) => a.name.localeCompare(b.name));

  const canonicalRecords: CanonicalDirectoryEntryRecord[] = [];
  for (const entry of rawEntries) {
    const entryPath = path.join(dirPath, entry.name);
    let entryStat: fs.Stats;
    try {
      entryStat = filesystem.lstatSync(entryPath);
    } catch (statErr: unknown) {
      throw new FileOpError('STORAGE_METADATA_INVALID');
    }

    if (entryStat.isSymbolicLink()) {
      throw new FileOpError('SYMLINK_FORBIDDEN');
    }
    verifyOwnership(entryStat, expectedUid);

    let type: CanonicalDirectoryEntryRecord['type'];
    if (entryStat.isFile()) {
      type = 'file';
    } else if (entryStat.isDirectory()) {
      type = 'directory';
    } else {
      throw new FileOpError('STORAGE_METADATA_INVALID');
    }

    const { size, mtimeMs } = extractValidMetadata(entryStat);
    canonicalRecords.push({
      name: entry.name,
      type,
      size,
      mtimeMs,
    });
  }

  return computeDirectoryETag(canonicalRecords);
}

/**
 * Safely inspects a directory and computes its canonical entries and directory ETag.
 */
export function inspectDirectory(
  filesystem: typeof fs,
  dirPath: string,
  expectedUid?: number,
  nofollow?: number
): {
  stat: fs.Stats;
  entries: FileListEntry[];
  canonicalRecords: CanonicalDirectoryEntryRecord[];
  etag: string;
  truncated: boolean;
  size: number;
  mtimeMs: number;
} {
  let stat: fs.Stats;
  try {
    stat = filesystem.lstatSync(dirPath);
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === 'ENOENT') {
      throw new FileOpError('NOT_FOUND');
    }
    throw new FileOpError('STORAGE_METADATA_INVALID');
  }

  if (stat.isSymbolicLink()) {
    throw new FileOpError('SYMLINK_FORBIDDEN');
  }
  if (!stat.isDirectory()) {
    throw new FileOpError('INVALID_TARGET');
  }
  verifyOwnership(stat, expectedUid);

  const { size: dirSize, mtimeMs: dirMtimeMs } = extractValidMetadata(stat);

  let rawEntries: fs.Dirent[];
  try {
    rawEntries = filesystem.readdirSync(dirPath, { withFileTypes: true });
  } catch (readDirErr: unknown) {
    throw new FileOpError('STORAGE_METADATA_INVALID');
  }
  rawEntries.sort((a, b) => a.name.localeCompare(b.name));

  const truncated = rawEntries.length > MAX_DIR_ENTRIES;
  const selected = rawEntries.slice(0, MAX_DIR_ENTRIES);

  const entries: FileListEntry[] = [];
  const canonicalRecords: CanonicalDirectoryEntryRecord[] = [];

  for (const entry of selected) {
    const entryPath = path.join(dirPath, entry.name);
    let entryStat: fs.Stats;
    try {
      entryStat = filesystem.lstatSync(entryPath);
    } catch (statErr: unknown) {
      throw new FileOpError('STORAGE_METADATA_INVALID');
    }

    let type: FileListEntry['type'] = 'other';
    if (entryStat.isSymbolicLink()) {
      type = 'symlink';
    } else if (entryStat.isDirectory()) {
      type = 'directory';
    } else if (entryStat.isFile()) {
      type = 'file';
    }

    const { size, mtimeMs } = extractValidMetadata(entryStat);

    let entryEtag: string | undefined;
    if (type === 'file') {
      const flag = nofollow ?? getNoFollowFlag();
      let fd: number | undefined;
      try {
        fd = filesystem.openSync(entryPath, fs.constants.O_RDONLY | flag);
        const fstat = filesystem.fstatSync(fd);
        if (fstat.isFile() && fstat.size <= MAX_FILE_OP_BYTES) {
          const buf = Buffer.alloc(fstat.size);
          let bytesRead = 0;
          while (bytesRead < fstat.size) {
            const n = filesystem.readSync(fd, buf, bytesRead, fstat.size - bytesRead, bytesRead);
            if (n === 0) break;
            bytesRead += n;
          }
          entryEtag = computeFileETag(bytesRead === fstat.size ? buf : buf.subarray(0, bytesRead));
        }
        filesystem.closeSync(fd);
        fd = undefined;
      } catch (err: unknown) {
        if (fd !== undefined) {
          try {
            filesystem.closeSync(fd);
          } catch (closeErr: unknown) {
            const primary = err instanceof Error ? err : new FileOpError('STORAGE_METADATA_INVALID');
            const cleanup = closeErr instanceof Error ? closeErr : new FileOpError('STORAGE_METADATA_INVALID');
            throw new AggregateError([primary, cleanup], 'Failed to close entry file');
          }
          fd = undefined;
        }
        if (err instanceof FileOpError) throw err;
        throw new FileOpError('STORAGE_METADATA_INVALID');
      }
    } else if (type === 'directory') {
      try {
        entryEtag = computeDirectoryETagRecursive(filesystem, entryPath, expectedUid, nofollow);
      } catch (err: unknown) {
        if (err instanceof FileOpError) throw err;
        throw new FileOpError('STORAGE_METADATA_INVALID');
      }
    }

    entries.push({
      name: entry.name,
      type,
      size,
      mtimeMs,
      etag: entryEtag,
    });

    canonicalRecords.push({
      name: entry.name,
      type,
      size,
      mtimeMs,
    });
  }

  const dirEtag = computeDirectoryETag(canonicalRecords);

  return {
    stat,
    entries,
    canonicalRecords,
    etag: dirEtag,
    truncated,
    size: dirSize,
    mtimeMs: dirMtimeMs,
  };
}

/**
 * Executes a mutation action within cross-process deterministic sorted path locks.
 */
export function withPathLocks<T>(
  paths: { space: string; path: string }[],
  options: FileOpExecutionOptions,
  action: () => T
): T {
  const filesystem = options.fsImpl ?? fs;
  const expectedUid =
    options.expectedUid ??
    (process.env.NODE_ENV === 'test' && typeof process.getuid === 'function' ? process.getuid() : 1000);
  const lockBaseDir =
    options.lockDir ??
    (process.env.DSH_HOME
      ? path.join(process.env.DSH_HOME, '.enkeep-file-locks')
      : path.join(options.spacesDir ?? '/home/dsh/spaces', '..', '.enkeep-file-locks'));

  const nofollow = getNoFollowFlag();

  try {
    filesystem.mkdirSync(lockBaseDir, { recursive: true, mode: 0o700 });
    const baseStat = filesystem.lstatSync(lockBaseDir);
    if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) {
      throw new FileOpError('LOCK_UNAVAILABLE');
    }
    verifyOwnership(baseStat, expectedUid);
  } catch (err: unknown) {
    if (err instanceof FileOpError && err.code === 'LOCK_UNAVAILABLE') {
      throw err;
    }
    throw new FileOpError('LOCK_UNAVAILABLE');
  }

  const sortedEntries = Array.from(
    new Map(
      paths.map((p) => {
        const canonical = `${p.space}/${p.path}`;
        const hash = crypto.createHash('sha256').update(canonical).digest('hex');
        return [hash, { hash, canonical }];
      })
    ).values()
  ).sort((a, b) => a.hash.localeCompare(b.hash));

  const acquiredLocks: { lockPath: string; ownerFilePath: string; nonce: string }[] = [];
  let actionError: unknown;
  let actionSuccess = false;

  try {
    for (const entry of sortedEntries) {
      const lockPath = path.join(lockBaseDir, entry.hash);
      const ownerFilePath = path.join(lockPath, 'owner.json');
      let acquired = false;

      for (let attempt = 0; attempt < 3; attempt++) {
        let dirCreated = false;
        try {
          filesystem.mkdirSync(lockPath, { mode: 0o700 });
          dirCreated = true;
        } catch (dirErr: unknown) {
          const code = (dirErr as { code?: string })?.code;
          if (code !== 'EEXIST') {
            throw new FileOpError('BUSY');
          }
          const dirStat = filesystem.lstatSync(lockPath);
          if (dirStat.isSymbolicLink()) {
            throw new FileOpError('SYMLINK_FORBIDDEN');
          }
          if (!dirStat.isDirectory()) {
            throw new FileOpError('BUSY');
          }
          verifyOwnership(dirStat, expectedUid);
        }

        const currentProc = getProcessStartTicks(process.pid, filesystem, options.procStatReader);
        if (!currentProc || !currentProc.starttime) {
          if (dirCreated) {
            try {
              filesystem.rmdirSync(lockPath);
            } catch (rErr: unknown) {
              const code = (rErr as { code?: string })?.code;
              if (code !== 'ENOENT') {
                throw rErr instanceof Error ? rErr : new FileOpError('BUSY');
              }
            }
          }
          throw new FileOpError('BUSY');
        }

        const currentTicks = currentProc.starttime;
        const currentNonce = crypto.randomBytes(16).toString('hex');
        const ownerMeta: LockOwnerMetadata = {
          pid: process.pid,
          procStartTicks: currentTicks,
          nonce: currentNonce,
        };

        let ownerFileCreated = false;
        let fd: number | undefined;
        let dirFd: number | undefined;

        try {
          try {
            fd = filesystem.openSync(
              ownerFilePath,
              fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | nofollow,
              0o600
            );
            ownerFileCreated = true;
          } catch (openErr: unknown) {
            const openCode = (openErr as { code?: string })?.code;
            if (openCode === 'EEXIST') {
              if (dirCreated) {
                try {
                  filesystem.rmdirSync(lockPath);
                } catch (rErr: unknown) {
                  const code = (rErr as { code?: string })?.code;
                  if (code !== 'ENOENT') {
                    throw rErr instanceof Error ? rErr : new FileOpError('BUSY');
                  }
                }
              }

              // Existing owner from another process: inspect for stale recovery
              let inspectedOwner: LockOwnerMetadata;
              try {
                const dirStat = filesystem.lstatSync(lockPath);
                if (dirStat.isSymbolicLink()) {
                  throw new FileOpError('SYMLINK_FORBIDDEN');
                }
                if (!dirStat.isDirectory()) {
                  throw new FileOpError('BUSY');
                }
                verifyOwnership(dirStat, expectedUid);

                inspectedOwner = readAndValidateOwnerFile(filesystem, ownerFilePath, expectedUid, nofollow);
              } catch (inspectErr: unknown) {
                if (inspectErr instanceof FileOpError) throw inspectErr;
                throw new FileOpError('BUSY');
              }

              const liveProc = getProcessStartTicks(inspectedOwner.pid, filesystem, options.procStatReader);
              let isStale = false;
              if (liveProc === null) {
                isStale = true;
              } else if (liveProc.starttime !== inspectedOwner.procStartTicks) {
                isStale = true;
              } else {
                isStale = false;
              }

              if (isStale) {
                try {
                  const recheckOwner = readAndValidateOwnerFile(filesystem, ownerFilePath, expectedUid, nofollow);
                  if (
                    recheckOwner.nonce !== inspectedOwner.nonce ||
                    recheckOwner.pid !== inspectedOwner.pid ||
                    recheckOwner.procStartTicks !== inspectedOwner.procStartTicks
                  ) {
                    throw new FileOpError('BUSY');
                  }
                } catch (recheckErr: unknown) {
                  if (recheckErr instanceof FileOpError) throw recheckErr;
                  throw new FileOpError('BUSY');
                }

                try {
                  filesystem.unlinkSync(ownerFilePath);
                } catch (uErr: unknown) {
                  const code = (uErr as { code?: string })?.code;
                  if (code !== 'ENOENT') {
                    throw uErr instanceof Error ? uErr : new FileOpError('BUSY');
                  }
                }
                try {
                  filesystem.rmdirSync(lockPath);
                } catch (rErr: unknown) {
                  const code = (rErr as { code?: string })?.code;
                  if (code !== 'ENOENT') {
                    throw rErr instanceof Error ? rErr : new FileOpError('BUSY');
                  }
                }
                continue;
              }

              throw new FileOpError('BUSY');
            } else {
              if (dirCreated) {
                try {
                  filesystem.rmdirSync(lockPath);
                } catch (rErr: unknown) {
                  const code = (rErr as { code?: string })?.code;
                  if (code !== 'ENOENT') {
                    throw rErr instanceof Error ? rErr : new FileOpError('BUSY');
                  }
                }
              }
              if (openCode === 'ELOOP') {
                throw new FileOpError('SYMLINK_FORBIDDEN');
              }
              throw new FileOpError('BUSY');
            }
          }

          // Owner file created by us: write, sync, close owner file
          const metaPayload = Buffer.from(JSON.stringify(ownerMeta));
          filesystem.writeSync(fd, metaPayload, 0, metaPayload.length, 0);
          filesystem.fsyncSync(fd);
          filesystem.closeSync(fd);
          fd = undefined;

          // Directory fsync to persist directory entry (fail-closed)
          dirFd = filesystem.openSync(lockPath, fs.constants.O_RDONLY | nofollow);
          filesystem.fsyncSync(dirFd);
          filesystem.closeSync(dirFd);
          dirFd = undefined;

          acquired = true;
          acquiredLocks.push({ lockPath, ownerFilePath, nonce: currentNonce });
          break;
        } catch (ownerErr: unknown) {
          const cleanupErrors: Error[] = [];
          if (fd !== undefined) {
            try {
              filesystem.closeSync(fd);
            } catch (cErr: unknown) {
              cleanupErrors.push(cErr instanceof Error ? cErr : new FileOpError('BUSY'));
            }
            fd = undefined;
          }
          if (dirFd !== undefined) {
            try {
              filesystem.closeSync(dirFd);
            } catch (cErr: unknown) {
              cleanupErrors.push(cErr instanceof Error ? cErr : new FileOpError('BUSY'));
            }
            dirFd = undefined;
          }

          if (ownerFileCreated) {
            // Write, sync, close, or dirFsync failed after we created the owner file
            try {
              filesystem.unlinkSync(ownerFilePath);
            } catch (uErr: unknown) {
              const code = (uErr as { code?: string })?.code;
              if (code !== 'ENOENT') {
                cleanupErrors.push(uErr instanceof Error ? uErr : new FileOpError('BUSY'));
              }
            }
            try {
              filesystem.rmdirSync(lockPath);
            } catch (rErr: unknown) {
              const code = (rErr as { code?: string })?.code;
              if (code !== 'ENOENT') {
                cleanupErrors.push(rErr instanceof Error ? rErr : new FileOpError('BUSY'));
              }
            }
            if (cleanupErrors.length > 0) {
              const primary = ownerErr instanceof Error ? ownerErr : new FileOpError('BUSY');
              throw new AggregateError([primary, ...cleanupErrors], 'Lock acquisition failed with cleanup errors');
            }
            if (ownerErr instanceof FileOpError) throw ownerErr;
            throw new FileOpError('BUSY');
          }

          if (cleanupErrors.length > 0) {
            const primary = ownerErr instanceof Error ? ownerErr : new FileOpError('BUSY');
            throw new AggregateError([primary, ...cleanupErrors], 'Lock acquisition failed with cleanup errors');
          }

          if (ownerErr instanceof FileOpError) throw ownerErr;
          throw new FileOpError('BUSY');
        }
      }

      if (!acquired) {
        throw new FileOpError('BUSY');
      }
    }

    const actionResult = action();
    actionSuccess = true;
    return actionResult;
  } catch (err: unknown) {
    actionError = err;
    throw err;
  } finally {
    const cleanupErrors: Error[] = [];
    for (let i = acquiredLocks.length - 1; i >= 0; i--) {
      const lock = acquiredLocks[i];
      try {
        let shouldRemove = false;
        try {
          const currentMeta = readAndValidateOwnerFile(filesystem, lock.ownerFilePath, expectedUid, nofollow);
          if (currentMeta.nonce === lock.nonce) {
            shouldRemove = true;
          } else {
            // Successor acquired lock with new nonce; safe no-remove
            shouldRemove = false;
          }
        } catch (readErr: unknown) {
          // Read/parse failure during release must NOT be silently skipped
          throw readErr instanceof Error ? readErr : new FileOpError('BUSY');
        }

        if (shouldRemove) {
          try {
            filesystem.unlinkSync(lock.ownerFilePath);
          } catch (uErr: unknown) {
            const code = (uErr as { code?: string })?.code;
            if (code !== 'ENOENT') {
              throw uErr instanceof Error ? uErr : new FileOpError('BUSY');
            }
          }
          try {
            filesystem.rmdirSync(lock.lockPath);
          } catch (rErr: unknown) {
            const code = (rErr as { code?: string })?.code;
            if (code !== 'ENOENT') {
              throw rErr instanceof Error ? rErr : new FileOpError('BUSY');
            }
          }
        }
      } catch (cleanupErr: unknown) {
        cleanupErrors.push(
          cleanupErr instanceof Error ? cleanupErr : new FileOpError('BUSY')
        );
      }
    }

    if (cleanupErrors.length > 0) {
      if (actionSuccess) {
        if (cleanupErrors.length === 1) {
          throw cleanupErrors[0];
        }
        throw new AggregateError(cleanupErrors, 'Failed to release all acquired file locks');
      } else {
        const primaryError = actionError instanceof Error ? actionError : new FileOpError('BUSY');
        const allErrors = [primaryError, ...cleanupErrors];
        throw new AggregateError(allErrors, 'File operation failed and lock cleanup encountered errors');
      }
    }
  }
}

export function hasNullOrControlChars(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

export function validateSpaceName(space: unknown): string {
  if (typeof space !== 'string' || !space.trim()) {
    throw new FileOpError('INVALID_SPACE');
  }
  const trimmed = space.trim();
  if (!SPACE_NAME_REGEX.test(trimmed)) {
    throw new FileOpError('INVALID_SPACE');
  }
  return trimmed;
}

export function validateRelativePath(userPath: unknown): { normalizedPath: string; segments: string[] } {
  if (userPath === undefined || userPath === null || userPath === '') {
    return { normalizedPath: '.', segments: [] };
  }

  if (typeof userPath !== 'string') {
    throw new FileOpError('INVALID_PATH');
  }

  if (hasNullOrControlChars(userPath)) {
    throw new FileOpError('INVALID_PATH');
  }

  if (/^[a-zA-Z]:/.test(userPath)) {
    throw new FileOpError('INVALID_PATH');
  }

  if (userPath.startsWith('/') || userPath.startsWith('\\')) {
    throw new FileOpError('INVALID_PATH');
  }

  const rawSegments = userPath.split(/[/\\]+/);
  const segments: string[] = [];

  for (const seg of rawSegments) {
    if (!seg || seg === '.') {
      continue;
    }
    if (seg === '..') {
      throw new FileOpError('PATH_TRAVERSAL');
    }
    if (hasNullOrControlChars(seg)) {
      throw new FileOpError('INVALID_PATH');
    }
    segments.push(seg);
  }

  const normalizedPath = segments.length === 0 ? '.' : segments.join('/');
  return { normalizedPath, segments };
}

function verifyOwnership(stat: fs.Stats, expectedUid?: number): void {
  if (expectedUid !== undefined && stat.uid !== expectedUid) {
    throw new FileOpError('SECURITY_VIOLATION');
  }
}

export function verifyNoSymlinksInPath(
  spacesDir: string,
  space: string,
  segments: readonly string[],
  expectedUid?: number,
  allowCreate = false,
  fsImpl?: typeof fs
): { spaceRoot: string; targetPath: string } {
  const filesystem = fsImpl ?? fs;

  let spacesStat: fs.Stats;
  try {
    spacesStat = filesystem.lstatSync(spacesDir);
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === 'ENOENT' && allowCreate) {
      filesystem.mkdirSync(spacesDir, { recursive: true, mode: 0o700 });
      spacesStat = filesystem.lstatSync(spacesDir);
    } else {
      throw new FileOpError('NOT_FOUND');
    }
  }

  if (spacesStat.isSymbolicLink()) {
    throw new FileOpError('SYMLINK_FORBIDDEN');
  }
  if (!spacesStat.isDirectory()) {
    throw new FileOpError('INVALID_TARGET');
  }
  verifyOwnership(spacesStat, expectedUid);

  const spaceRoot = path.join(spacesDir, space);
  let spaceStat: fs.Stats;
  try {
    spaceStat = filesystem.lstatSync(spaceRoot);
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === 'ENOENT') {
      if (segments.length === 0) {
        return { spaceRoot, targetPath: spaceRoot };
      }
      if (allowCreate) {
        filesystem.mkdirSync(spaceRoot, { recursive: true, mode: 0o700 });
        const targetPath = segments.length === 0 ? spaceRoot : path.join(spaceRoot, ...segments);
        return { spaceRoot, targetPath };
      }
      throw new FileOpError('NOT_FOUND');
    }
    throw new FileOpError('NOT_FOUND');
  }

  if (spaceStat.isSymbolicLink()) {
    throw new FileOpError('SYMLINK_FORBIDDEN');
  }
  if (!spaceStat.isDirectory()) {
    throw new FileOpError('INVALID_TARGET');
  }
  verifyOwnership(spaceStat, expectedUid);

  let currentPath = spaceRoot;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    currentPath = path.join(currentPath, seg);
    let stat: fs.Stats;
    try {
      stat = filesystem.lstatSync(currentPath);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'ENOENT') {
        break;
      }
      throw new FileOpError('NOT_FOUND');
    }

    if (stat.isSymbolicLink()) {
      throw new FileOpError('SYMLINK_FORBIDDEN');
    }
    if (!stat.isDirectory()) {
      throw new FileOpError('INVALID_TARGET');
    }
    verifyOwnership(stat, expectedUid);
  }

  const targetPath = segments.length === 0 ? spaceRoot : path.join(spaceRoot, ...segments);
  return { spaceRoot, targetPath };
}

export function sanitizeErrorMessage(message: string): string {
  if (!message) return 'File operation failed';
  const firstLine = message.split('\n')[0].trim();
  return firstLine
    .replace(/(?:\/[a-zA-Z0-9_.-]+)+/g, (match) => {
      const base = path.basename(match);
      return base ? `[path:${base}]` : '[path]';
    })
    .replace(/[a-zA-Z]:\\[a-zA-Z0-9_.\-\\]+/g, '[path]');
}

export function executeFileOperation(
  rawRequest: FileOperationRequest | unknown,
  options: FileOpExecutionOptions = {}
): FileOperationResult {
  if (!rawRequest || typeof rawRequest !== 'object' || Array.isArray(rawRequest)) {
    throw new FileOpError('INVALID_REQUEST');
  }

  const reqObj = rawRequest as Record<string, unknown>;

  for (const key of Object.keys(reqObj)) {
    if (!ALLOWED_REQUEST_KEYS.has(key)) {
      throw new FileOpError('INVALID_REQUEST');
    }
  }

  const filesystem = options.fsImpl ?? fs;
  const op = reqObj.op;
  if (
    op !== 'list' &&
    op !== 'read' &&
    op !== 'write' &&
    op !== 'mkdir' &&
    op !== 'delete' &&
    op !== 'rename' &&
    op !== 'stat' &&
    op !== 'sniff' &&
    op !== 'copy'
  ) {
    throw new FileOpError('INVALID_OP');
  }

  const space = validateSpaceName(reqObj.space);
  const { normalizedPath, segments } = validateRelativePath(reqObj.path);

  const spacesDir = options.spacesDir ?? process.env.DSH_SPACES ?? '/home/dsh/spaces';
  const expectedUid =
    options.expectedUid ??
    (process.env.NODE_ENV === 'test' && typeof process.getuid === 'function' ? process.getuid() : 1000);

  const allowCreate = op === 'mkdir' || op === 'write' || op === 'rename';
  const { spaceRoot, targetPath } = verifyNoSymlinksInPath(
    spacesDir,
    space,
    segments,
    expectedUid,
    allowCreate,
    filesystem
  );

  switch (op) {
    case 'list': {
      if (
        reqObj.targetPath !== undefined ||
        reqObj.content !== undefined ||
        reqObj.encoding !== undefined ||
        reqObj.expectedEtag !== undefined ||
        reqObj.expectedTargetEtag !== undefined ||
        reqObj.requireAbsent !== undefined ||
        reqObj.requireTargetAbsent !== undefined
      ) {
        throw new FileOpError('INVALID_REQUEST');
      }

      const dirInfo = inspectDirectory(filesystem, targetPath, expectedUid);

      return {
        op: 'list',
        space,
        path: normalizedPath,
        entries: dirInfo.entries,
        truncated: dirInfo.truncated,
        etag: dirInfo.etag,
        size: dirInfo.size,
        mtimeMs: dirInfo.mtimeMs,
      };
    }

    case 'read': {
      if (
        reqObj.targetPath !== undefined ||
        reqObj.content !== undefined ||
        reqObj.expectedEtag !== undefined ||
        reqObj.expectedTargetEtag !== undefined ||
        reqObj.requireAbsent !== undefined ||
        reqObj.requireTargetAbsent !== undefined
      ) {
        throw new FileOpError('INVALID_REQUEST');
      }

      if (segments.length === 0 || normalizedPath === '.') {
        throw new FileOpError('INVALID_TARGET');
      }

      let stat: fs.Stats;
      try {
        stat = filesystem.lstatSync(targetPath);
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code === 'ENOENT') {
          throw new FileOpError('NOT_FOUND');
        }
        throw new FileOpError('READ_FAILED');
      }

      if (stat.isSymbolicLink()) {
        throw new FileOpError('SYMLINK_FORBIDDEN');
      }
      if (!stat.isFile()) {
        throw new FileOpError('INVALID_TARGET');
      }
      verifyOwnership(stat, expectedUid);

      if (stat.size > MAX_FILE_OP_BYTES) {
        throw new FileOpError('FILE_TOO_LARGE');
      }

      const nofollow = getNoFollowFlag();
      let fd: number | undefined;
      try {
        fd = filesystem.openSync(targetPath, fs.constants.O_RDONLY | nofollow);
        const fstat = filesystem.fstatSync(fd);
        if (!fstat.isFile()) {
          throw new FileOpError('INVALID_TARGET');
        }
        verifyOwnership(fstat, expectedUid);

        if (fstat.dev !== stat.dev || fstat.ino !== stat.ino) {
          throw new FileOpError('TOCTOU_MISMATCH');
        }

        if (fstat.size > MAX_FILE_OP_BYTES) {
          throw new FileOpError('FILE_TOO_LARGE');
        }

        const { mtimeMs } = extractValidMetadata(fstat);

        const buf = Buffer.alloc(fstat.size);
        let bytesRead = 0;
        while (bytesRead < fstat.size) {
          const chunk = filesystem.readSync(fd, buf, bytesRead, fstat.size - bytesRead, bytesRead);
          if (chunk === 0) break;
          bytesRead += chunk;
        }

        filesystem.closeSync(fd);
        fd = undefined;

        const finalBuf = bytesRead === fstat.size ? buf : buf.subarray(0, bytesRead);
        const encoding = reqObj.encoding === 'base64' ? 'base64' : 'utf8';
        const content = encoding === 'base64' ? finalBuf.toString('base64') : finalBuf.toString('utf8');
        const etag = computeFileETag(finalBuf);

        return {
          op: 'read',
          space,
          path: normalizedPath,
          content,
          encoding,
          size: finalBuf.length,
          mtimeMs,
          etag,
        };
      } catch (err: unknown) {
        if (fd !== undefined) {
          try {
            filesystem.closeSync(fd);
          } catch (closeErr: unknown) {
            const primary = err instanceof Error ? err : new FileOpError('READ_FAILED');
            const cleanup = closeErr instanceof Error ? closeErr : new FileOpError('READ_FAILED');
            throw new AggregateError([primary, cleanup], 'Failed to close file during read');
          }
          fd = undefined;
        }
        if (err instanceof FileOpError) throw err;
        const code = (err as { code?: string })?.code;
        if (code === 'ELOOP') {
          throw new FileOpError('SYMLINK_FORBIDDEN');
        }
        throw new FileOpError('READ_FAILED');
      }
    }

    case 'write': {
      if (
        reqObj.targetPath !== undefined ||
        reqObj.expectedTargetEtag !== undefined ||
        reqObj.requireTargetAbsent !== undefined
      ) {
        throw new FileOpError('INVALID_REQUEST');
      }

      if (segments.length === 0 || normalizedPath === '.') {
        throw new FileOpError('INVALID_TARGET');
      }

      const hasExpectedEtag = reqObj.expectedEtag !== undefined;
      const hasRequireAbsent = reqObj.requireAbsent !== undefined;

      if (hasExpectedEtag && hasRequireAbsent) {
        throw new FileOpError('INVALID_REQUEST');
      }
      if (!hasExpectedEtag && !hasRequireAbsent) {
        throw new FileOpError('INVALID_REQUEST');
      }
      if (hasExpectedEtag && !isValidETag(reqObj.expectedEtag)) {
        throw new FileOpError('INVALID_REQUEST');
      }
      if (hasRequireAbsent && reqObj.requireAbsent !== true) {
        throw new FileOpError('INVALID_REQUEST');
      }

      const expectedEtag = reqObj.expectedEtag as string | undefined;
      const requireAbsent = reqObj.requireAbsent === true;

      return withPathLocks([{ space, path: normalizedPath }], options, () => {
        const encoding = reqObj.encoding === 'base64' ? 'base64' : 'utf8';
        let payloadBuffer: Buffer;

        if (reqObj.content === undefined || reqObj.content === null) {
          payloadBuffer = Buffer.alloc(0);
        } else if (typeof reqObj.content !== 'string') {
          throw new FileOpError('INVALID_PAYLOAD');
        } else if (encoding === 'base64') {
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(reqObj.content)) {
            throw new FileOpError('INVALID_PAYLOAD');
          }
          try {
            payloadBuffer = Buffer.from(reqObj.content, 'base64');
          } catch (parseErr: unknown) {
            throw new FileOpError('INVALID_PAYLOAD');
          }
        } else {
          payloadBuffer = Buffer.from(reqObj.content, 'utf8');
        }

        if (payloadBuffer.length > MAX_FILE_OP_BYTES) {
          throw new FileOpError('PAYLOAD_TOO_LARGE');
        }

        filesystem.mkdirSync(spaceRoot, { recursive: true, mode: 0o700 });
        const parentDir = path.dirname(targetPath);
        filesystem.mkdirSync(parentDir, { recursive: true, mode: 0o700 });

        verifyNoSymlinksInPath(spacesDir, space, segments.slice(0, -1), expectedUid, true, filesystem);

        const parentStat = filesystem.lstatSync(parentDir);
        if (parentStat.isSymbolicLink()) {
          throw new FileOpError('SYMLINK_FORBIDDEN');
        }
        if (!parentStat.isDirectory()) {
          throw new FileOpError('INVALID_TARGET');
        }
        verifyOwnership(parentStat, expectedUid);

        if (requireAbsent) {
          let existing = false;
          try {
            filesystem.lstatSync(targetPath);
            existing = true;
          } catch (err: unknown) {
            const code = (err as { code?: string })?.code;
            if (code === 'ENOENT') {
              existing = false;
            } else {
              throw new FileOpError('WRITE_FAILED');
            }
          }
          if (existing) {
            throw new FileOpError('PRECONDITION_FAILED');
          }
        }

        let initialTargetStat: fs.Stats | undefined;
        let initialTargetDev: number | undefined;
        let initialTargetIno: number | undefined;
        let targetExists = false;

        try {
          initialTargetStat = filesystem.lstatSync(targetPath);
          targetExists = true;
          if (initialTargetStat.isSymbolicLink()) {
            throw new FileOpError('SYMLINK_FORBIDDEN');
          }
          if (initialTargetStat.isDirectory() || !initialTargetStat.isFile()) {
            throw new FileOpError('INVALID_TARGET');
          }
          verifyOwnership(initialTargetStat, expectedUid);
          initialTargetDev = initialTargetStat.dev;
          initialTargetIno = initialTargetStat.ino;
        } catch (err: unknown) {
          if (err instanceof FileOpError) throw err;
          const code = (err as { code?: string })?.code;
          if (code === 'ENOENT') {
            targetExists = false;
          } else {
            throw new FileOpError('WRITE_FAILED');
          }
        }

        if (expectedEtag !== undefined) {
          if (!targetExists || !initialTargetStat) {
            throw new FileOpError('PRECONDITION_FAILED');
          }

          const nofollow = getNoFollowFlag();
          let checkFd: number | undefined;
          try {
            checkFd = filesystem.openSync(targetPath, fs.constants.O_RDONLY | nofollow);
            const fstat = filesystem.fstatSync(checkFd);
            if (!fstat.isFile() || fstat.dev !== initialTargetStat.dev || fstat.ino !== initialTargetStat.ino) {
              throw new FileOpError('TOCTOU_MISMATCH');
            }
            verifyOwnership(fstat, expectedUid);
            const existingBuf = Buffer.alloc(fstat.size);
            let readBytes = 0;
            while (readBytes < fstat.size) {
              const chunk = filesystem.readSync(checkFd, existingBuf, readBytes, fstat.size - readBytes, readBytes);
              if (chunk === 0) break;
              readBytes += chunk;
            }
            filesystem.closeSync(checkFd);
            checkFd = undefined;

            const actualExistingBuf = readBytes === fstat.size ? existingBuf : existingBuf.subarray(0, readBytes);
            const currentEtag = computeFileETag(actualExistingBuf);

            if (!matchETag(currentEtag, expectedEtag)) {
              throw new FileOpError('PRECONDITION_FAILED');
            }
          } catch (openErr: unknown) {
            if (checkFd !== undefined) {
              try {
                filesystem.closeSync(checkFd);
              } catch (closeErr: unknown) {
                const primary = openErr instanceof Error ? openErr : new FileOpError('PRECONDITION_FAILED');
                const cleanup = closeErr instanceof Error ? closeErr : new FileOpError('WRITE_FAILED');
                throw new AggregateError([primary, cleanup], 'Failed to close checkFd during write verification');
              }
              checkFd = undefined;
            }
            if (openErr instanceof FileOpError) throw openErr;
            const code = (openErr as { code?: string })?.code;
            if (code === 'ELOOP') {
              throw new FileOpError('SYMLINK_FORBIDDEN');
            }
            throw new FileOpError('PRECONDITION_FAILED');
          }
        }

        const tempFileName = `.${path.basename(targetPath)}.${crypto.randomBytes(8).toString('hex')}.tmp`;
        const tempPath = path.join(parentDir, tempFileName);
        const nofollow = getNoFollowFlag();

        let fd: number | undefined;
        try {
          fd = filesystem.openSync(
            tempPath,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | nofollow,
            0o600
          );

          let bytesWritten = 0;
          while (bytesWritten < payloadBuffer.length) {
            const chunk = filesystem.writeSync(
              fd,
              payloadBuffer,
              bytesWritten,
              payloadBuffer.length - bytesWritten,
              bytesWritten
            );
            if (chunk === 0) break;
            bytesWritten += chunk;
          }

          filesystem.fsyncSync(fd);
          filesystem.closeSync(fd);
          fd = undefined;
        } catch (wErr: unknown) {
          const cleanupErrors: Error[] = [];
          if (fd !== undefined) {
            try {
              filesystem.closeSync(fd);
            } catch (cErr: unknown) {
              cleanupErrors.push(cErr instanceof Error ? cErr : new FileOpError('WRITE_FAILED'));
            }
            fd = undefined;
          }
          try {
            filesystem.unlinkSync(tempPath);
          } catch (uErr: unknown) {
            const code = (uErr as { code?: string })?.code;
            if (code !== 'ENOENT') {
              cleanupErrors.push(uErr instanceof Error ? uErr : new FileOpError('WRITE_FAILED'));
            }
          }
          if (cleanupErrors.length > 0) {
            const primary = wErr instanceof Error ? wErr : new FileOpError('WRITE_FAILED');
            throw new AggregateError([primary, ...cleanupErrors], 'Write operation failed with cleanup errors');
          }
          if (wErr instanceof FileOpError) throw wErr;
          throw new FileOpError('WRITE_FAILED');
        }

        if (requireAbsent) {
          try {
            filesystem.linkSync(tempPath, targetPath);
          } catch (linkErr: unknown) {
            const cleanupErrors: Error[] = [];
            try {
              filesystem.unlinkSync(tempPath);
            } catch (uErr: unknown) {
              const code = (uErr as { code?: string })?.code;
              if (code !== 'ENOENT') {
                cleanupErrors.push(uErr instanceof Error ? uErr : new FileOpError('WRITE_FAILED'));
              }
            }
            const linkCode = (linkErr as { code?: string })?.code;
            if (cleanupErrors.length > 0) {
              const primary = linkCode === 'EEXIST' ? new FileOpError('PRECONDITION_FAILED') : new FileOpError('WRITE_FAILED');
              throw new AggregateError([primary, ...cleanupErrors], 'Write link failed with cleanup errors');
            }
            if (linkCode === 'EEXIST') {
              throw new FileOpError('PRECONDITION_FAILED');
            }
            throw new FileOpError('WRITE_FAILED');
          }

          try {
            filesystem.unlinkSync(tempPath);
          } catch (uErr: unknown) {
            const code = (uErr as { code?: string })?.code;
            if (code !== 'ENOENT') {
              throw new FileOpError('WRITE_FAILED');
            }
          }
        } else {
          if (targetExists && initialTargetDev !== undefined && initialTargetIno !== undefined) {
            let preRenameStat: fs.Stats;
            try {
              preRenameStat = filesystem.lstatSync(targetPath);
            } catch (err: unknown) {
              const cleanupErrors: Error[] = [];
              try {
                filesystem.unlinkSync(tempPath);
              } catch (uErr: unknown) {
                const code = (uErr as { code?: string })?.code;
                if (code !== 'ENOENT') {
                  cleanupErrors.push(uErr instanceof Error ? uErr : new FileOpError('WRITE_FAILED'));
                }
              }
              if (cleanupErrors.length > 0) {
                throw new AggregateError([new FileOpError('TOCTOU_MISMATCH'), ...cleanupErrors], 'Write pre-rename check failed');
              }
              throw new FileOpError('TOCTOU_MISMATCH');
            }

            if (preRenameStat.dev !== initialTargetDev || preRenameStat.ino !== initialTargetIno) {
              const cleanupErrors: Error[] = [];
              try {
                filesystem.unlinkSync(tempPath);
              } catch (uErr: unknown) {
                const code = (uErr as { code?: string })?.code;
                if (code !== 'ENOENT') {
                  cleanupErrors.push(uErr instanceof Error ? uErr : new FileOpError('WRITE_FAILED'));
                }
              }
              if (cleanupErrors.length > 0) {
                throw new AggregateError([new FileOpError('TOCTOU_MISMATCH'), ...cleanupErrors], 'Write TOCTOU mismatch');
              }
              throw new FileOpError('TOCTOU_MISMATCH');
            }
          }

          try {
            filesystem.renameSync(tempPath, targetPath);
          } catch (renameErr: unknown) {
            const cleanupErrors: Error[] = [];
            try {
              filesystem.unlinkSync(tempPath);
            } catch (uErr: unknown) {
              const code = (uErr as { code?: string })?.code;
              if (code !== 'ENOENT') {
                cleanupErrors.push(uErr instanceof Error ? uErr : new FileOpError('WRITE_FAILED'));
              }
            }
            if (cleanupErrors.length > 0) {
              throw new AggregateError([new FileOpError('WRITE_FAILED'), ...cleanupErrors], 'Write rename failed');
            }
            throw new FileOpError('WRITE_FAILED');
          }
        }

        let writtenStat: fs.Stats;
        try {
          writtenStat = filesystem.lstatSync(targetPath);
          if (writtenStat.isSymbolicLink()) {
            throw new FileOpError('SYMLINK_FORBIDDEN');
          }
          verifyOwnership(writtenStat, expectedUid);
        } catch (statErr: unknown) {
          if (statErr instanceof FileOpError) throw statErr;
          throw new FileOpError('WRITE_FAILED');
        }

        const newEtag = computeFileETag(payloadBuffer);
        const { mtimeMs } = extractValidMetadata(writtenStat);

        return {
          op: 'write',
          space,
          path: normalizedPath,
          type: 'file',
          size: payloadBuffer.length,
          written: true,
          encoding,
          mtimeMs,
          etag: newEtag,
        };
      });
    }

    case 'rename': {
      if (reqObj.content !== undefined || reqObj.encoding !== undefined || reqObj.requireAbsent !== undefined) {
        throw new FileOpError('INVALID_REQUEST');
      }

      if (segments.length === 0 || normalizedPath === '.') {
        throw new FileOpError('FORBIDDEN');
      }

      const destRelativePath = reqObj.targetPath;
      if (!destRelativePath || typeof destRelativePath !== 'string') {
        throw new FileOpError('INVALID_REQUEST');
      }

      const { normalizedPath: destNormalizedPath, segments: destSegments } = validateRelativePath(destRelativePath);

      if (destSegments.length === 0 || destNormalizedPath === '.') {
        throw new FileOpError('FORBIDDEN');
      }

      if (typeof reqObj.expectedEtag !== 'string' || !isValidETag(reqObj.expectedEtag)) {
        throw new FileOpError('INVALID_REQUEST');
      }
      const expectedEtag = reqObj.expectedEtag;

      const hasExpectedTargetEtag = reqObj.expectedTargetEtag !== undefined;
      const hasRequireTargetAbsent = reqObj.requireTargetAbsent !== undefined;

      if (hasExpectedTargetEtag && hasRequireTargetAbsent) {
        throw new FileOpError('INVALID_REQUEST');
      }
      if (!hasExpectedTargetEtag && !hasRequireTargetAbsent) {
        throw new FileOpError('INVALID_REQUEST');
      }
      if (hasExpectedTargetEtag && !isValidETag(reqObj.expectedTargetEtag)) {
        throw new FileOpError('INVALID_REQUEST');
      }
      if (hasRequireTargetAbsent && reqObj.requireTargetAbsent !== true) {
        throw new FileOpError('INVALID_REQUEST');
      }

      const expectedTargetEtag = reqObj.expectedTargetEtag as string | undefined;
      const requireTargetAbsent = reqObj.requireTargetAbsent === true;

      if (normalizedPath === destNormalizedPath) {
        let stat: fs.Stats;
        try {
          stat = filesystem.lstatSync(targetPath);
        } catch (err: unknown) {
          const code = (err as { code?: string })?.code;
          if (code === 'ENOENT') {
            throw new FileOpError('NOT_FOUND');
          }
          throw new FileOpError('BUSY');
        }
        if (stat.isSymbolicLink()) {
          throw new FileOpError('SYMLINK_FORBIDDEN');
        }
        verifyOwnership(stat, expectedUid);

        let finalEtag: string;
        let finalSize: number;
        let finalMtimeMs: number;

        if (stat.isFile()) {
          const nofollow = getNoFollowFlag();
          let fd: number | undefined;
          try {
            fd = filesystem.openSync(targetPath, fs.constants.O_RDONLY | nofollow);
            const fstat = filesystem.fstatSync(fd);
            const buf = Buffer.alloc(fstat.size);
            let readBytes = 0;
            while (readBytes < fstat.size) {
              const chunk = filesystem.readSync(fd, buf, readBytes, fstat.size - readBytes, readBytes);
              if (chunk === 0) break;
              readBytes += chunk;
            }
            filesystem.closeSync(fd);
            fd = undefined;

            const currentEtag = computeFileETag(readBytes === fstat.size ? buf : buf.subarray(0, readBytes));
            if (!matchETag(currentEtag, expectedEtag)) {
              throw new FileOpError('PRECONDITION_FAILED');
            }
            finalEtag = currentEtag;
            const meta = extractValidMetadata(fstat);
            finalSize = meta.size;
            finalMtimeMs = meta.mtimeMs;
          } catch (err: unknown) {
            if (fd !== undefined) {
              try {
                filesystem.closeSync(fd);
              } catch (closeErr: unknown) {
                const primary = err instanceof Error ? err : new FileOpError('PRECONDITION_FAILED');
                const cleanup = closeErr instanceof Error ? closeErr : new FileOpError('BUSY');
                throw new AggregateError([primary, cleanup], 'Failed to close fd during rename verification');
              }
              fd = undefined;
            }
            if (err instanceof FileOpError) throw err;
            throw new FileOpError('PRECONDITION_FAILED');
          }
        } else if (stat.isDirectory()) {
          const dirInfo = inspectDirectory(filesystem, targetPath, expectedUid);
          if (!matchETag(dirInfo.etag, expectedEtag)) {
            throw new FileOpError('PRECONDITION_FAILED');
          }
          finalEtag = dirInfo.etag;
          finalSize = dirInfo.size;
          finalMtimeMs = dirInfo.mtimeMs;
        } else {
          throw new FileOpError('INVALID_TARGET');
        }

        if (requireTargetAbsent) {
          throw new FileOpError('PRECONDITION_FAILED');
        }

        return {
          op: 'rename',
          space,
          path: normalizedPath,
          targetPath: destNormalizedPath,
          renamed: true,
          etag: finalEtag,
          size: finalSize,
          mtimeMs: finalMtimeMs,
        };
      }

      return withPathLocks(
        [
          { space, path: normalizedPath },
          { space, path: destNormalizedPath },
        ],
        options,
        () => {
          let sourceStat: fs.Stats;
          try {
            sourceStat = filesystem.lstatSync(targetPath);
          } catch (err: unknown) {
            const code = (err as { code?: string })?.code;
            if (code === 'ENOENT') {
              throw new FileOpError('NOT_FOUND');
            }
            throw new FileOpError('BUSY');
          }

          if (sourceStat.isSymbolicLink()) {
            throw new FileOpError('SYMLINK_FORBIDDEN');
          }
          verifyOwnership(sourceStat, expectedUid);
          const sourceDev = sourceStat.dev;
          const sourceIno = sourceStat.ino;

          if (sourceStat.isFile()) {
            const nofollow = getNoFollowFlag();
            let srcFd: number | undefined;
            try {
              srcFd = filesystem.openSync(targetPath, fs.constants.O_RDONLY | nofollow);
              const fstat = filesystem.fstatSync(srcFd);
              if (!fstat.isFile() || fstat.dev !== sourceStat.dev || fstat.ino !== sourceStat.ino) {
                throw new FileOpError('TOCTOU_MISMATCH');
              }
              const buf = Buffer.alloc(fstat.size);
              let readBytes = 0;
              while (readBytes < fstat.size) {
                const chunk = filesystem.readSync(srcFd, buf, readBytes, fstat.size - readBytes, readBytes);
                if (chunk === 0) break;
                readBytes += chunk;
              }
              filesystem.closeSync(srcFd);
              srcFd = undefined;

              const actualBuf = readBytes === fstat.size ? buf : buf.subarray(0, readBytes);
              const currentSourceEtag = computeFileETag(actualBuf);
              if (!matchETag(currentSourceEtag, expectedEtag)) {
                throw new FileOpError('PRECONDITION_FAILED');
              }
            } catch (err: unknown) {
              if (srcFd !== undefined) {
                try {
                  filesystem.closeSync(srcFd);
                } catch (closeErr: unknown) {
                  const primary = err instanceof Error ? err : new FileOpError('PRECONDITION_FAILED');
                  const cleanup = closeErr instanceof Error ? closeErr : new FileOpError('BUSY');
                  throw new AggregateError([primary, cleanup], 'Failed to close srcFd during rename');
                }
                srcFd = undefined;
              }
              if (err instanceof FileOpError) throw err;
              throw new FileOpError('PRECONDITION_FAILED');
            }
          } else if (sourceStat.isDirectory()) {
            const dirInfo = inspectDirectory(filesystem, targetPath, expectedUid);
            if (!matchETag(dirInfo.etag, expectedEtag)) {
              throw new FileOpError('PRECONDITION_FAILED');
            }
          } else {
            throw new FileOpError('INVALID_TARGET');
          }

          const destTargetInfo = verifyNoSymlinksInPath(
            spacesDir,
            space,
            destSegments,
            expectedUid,
            true,
            filesystem
          );
          const destPath = destTargetInfo.targetPath;
          const destParentDir = path.dirname(destPath);
          filesystem.mkdirSync(destParentDir, { recursive: true, mode: 0o700 });

          verifyNoSymlinksInPath(spacesDir, space, destSegments, expectedUid, true, filesystem);

          let destExists = false;
          let destStat: fs.Stats | undefined;
          try {
            destStat = filesystem.lstatSync(destPath);
            destExists = true;
          } catch (err: unknown) {
            const code = (err as { code?: string })?.code;
            if (code === 'ENOENT') {
              destExists = false;
            } else {
              throw new FileOpError('BUSY');
            }
          }

          if (requireTargetAbsent) {
            if (destExists) {
              throw new FileOpError('PRECONDITION_FAILED');
            }
          } else if (expectedTargetEtag !== undefined) {
            if (!destExists || !destStat) {
              throw new FileOpError('PRECONDITION_FAILED');
            }
            if (destStat.isSymbolicLink()) {
              throw new FileOpError('SYMLINK_FORBIDDEN');
            }
            if (destStat.isFile() !== sourceStat.isFile()) {
              throw new FileOpError('INVALID_TARGET');
            }
            verifyOwnership(destStat, expectedUid);

            if (destStat.isFile()) {
              const nofollow = getNoFollowFlag();
              let targetFd: number | undefined;
              try {
                targetFd = filesystem.openSync(destPath, fs.constants.O_RDONLY | nofollow);
                const fstat = filesystem.fstatSync(targetFd);
                if (!fstat.isFile() || fstat.dev !== destStat.dev || fstat.ino !== destStat.ino) {
                  throw new FileOpError('TOCTOU_MISMATCH');
                }
                const buf = Buffer.alloc(fstat.size);
                let readBytes = 0;
                while (readBytes < fstat.size) {
                  const chunk = filesystem.readSync(targetFd, buf, readBytes, fstat.size - readBytes, readBytes);
                  if (chunk === 0) break;
                  readBytes += chunk;
                }
                filesystem.closeSync(targetFd);
                targetFd = undefined;

                const actualBuf = readBytes === fstat.size ? buf : buf.subarray(0, readBytes);
                const currentTargetEtag = computeFileETag(actualBuf);
                if (!matchETag(currentTargetEtag, expectedTargetEtag)) {
                  throw new FileOpError('PRECONDITION_FAILED');
                }
              } catch (err: unknown) {
                if (targetFd !== undefined) {
                  try {
                    filesystem.closeSync(targetFd);
                  } catch (closeErr: unknown) {
                    const primary = err instanceof Error ? err : new FileOpError('PRECONDITION_FAILED');
                    const cleanup = closeErr instanceof Error ? closeErr : new FileOpError('BUSY');
                    throw new AggregateError([primary, cleanup], 'Failed to close targetFd during rename');
                  }
                  targetFd = undefined;
                }
                if (err instanceof FileOpError) throw err;
                throw new FileOpError('PRECONDITION_FAILED');
              }
            } else if (destStat.isDirectory()) {
              const targetDirInfo = inspectDirectory(filesystem, destPath, expectedUid);
              if (!matchETag(targetDirInfo.etag, expectedTargetEtag)) {
                throw new FileOpError('PRECONDITION_FAILED');
              }
            }
          }

          try {
            const recheckSource = filesystem.lstatSync(targetPath);
            if (recheckSource.dev !== sourceDev || recheckSource.ino !== sourceIno) {
              throw new FileOpError('TOCTOU_MISMATCH');
            }
          } catch (err: unknown) {
            if (err instanceof FileOpError) throw err;
            throw new FileOpError('NOT_FOUND');
          }

          try {
            filesystem.renameSync(targetPath, destPath);
          } catch (renameErr: unknown) {
            throw new FileOpError('RENAME_FAILED');
          }

          const finalStat = filesystem.lstatSync(destPath);
          verifyOwnership(finalStat, expectedUid);
          let finalEtag: string;
          let finalSize: number;
          let finalMtimeMs: number;

          if (finalStat.isDirectory()) {
            const finalDirInfo = inspectDirectory(filesystem, destPath, expectedUid);
            finalEtag = finalDirInfo.etag;
            finalSize = finalDirInfo.size;
            finalMtimeMs = finalDirInfo.mtimeMs;
          } else {
            const nofollow = getNoFollowFlag();
            let finalFd: number | undefined;
            try {
              finalFd = filesystem.openSync(destPath, fs.constants.O_RDONLY | nofollow);
              const fstat = filesystem.fstatSync(finalFd);
              const buf = Buffer.alloc(fstat.size);
              let readBytes = 0;
              while (readBytes < fstat.size) {
                const chunk = filesystem.readSync(finalFd, buf, readBytes, fstat.size - readBytes, readBytes);
                if (chunk === 0) break;
                readBytes += chunk;
              }
              filesystem.closeSync(finalFd);
              finalFd = undefined;
              finalEtag = computeFileETag(readBytes === fstat.size ? buf : buf.subarray(0, readBytes));
              const meta = extractValidMetadata(fstat);
              finalSize = meta.size;
              finalMtimeMs = meta.mtimeMs;
            } catch (err: unknown) {
              if (finalFd !== undefined) {
                try {
                  filesystem.closeSync(finalFd);
                } catch (closeErr: unknown) {
                  const primary = err instanceof Error ? err : new FileOpError('RENAME_FAILED');
                  const cleanup = closeErr instanceof Error ? closeErr : new FileOpError('BUSY');
                  throw new AggregateError([primary, cleanup], 'Failed to close finalFd during rename verification');
                }
                finalFd = undefined;
              }
              if (err instanceof FileOpError) throw err;
              throw new FileOpError('RENAME_FAILED');
            }
          }

          return {
            op: 'rename',
            space,
            path: normalizedPath,
            targetPath: destNormalizedPath,
            renamed: true,
            etag: finalEtag,
            size: finalSize,
            mtimeMs: finalMtimeMs,
          };
        }
      );
    }

    case 'mkdir': {
      if (
        reqObj.targetPath !== undefined ||
        reqObj.content !== undefined ||
        reqObj.encoding !== undefined ||
        reqObj.expectedEtag !== undefined ||
        reqObj.expectedTargetEtag !== undefined ||
        reqObj.requireTargetAbsent !== undefined
      ) {
        throw new FileOpError('INVALID_REQUEST');
      }

      if (reqObj.requireAbsent !== true) {
        throw new FileOpError('INVALID_REQUEST');
      }

      if (segments.length === 0 || normalizedPath === '.') {
        return withPathLocks([{ space, path: '.' }], options, () => {
          let existing = false;
          let existingStat: fs.Stats | null = null;
          try {
            existingStat = filesystem.lstatSync(spaceRoot);
            existing = true;
          } catch (err: unknown) {
            const code = (err as { code?: string })?.code;
            if (code === 'ENOENT') {
              existing = false;
            } else {
              throw new FileOpError('BUSY');
            }
          }
          if (existing) {
            throw new FileOpError('PRECONDITION_FAILED');
          }

          filesystem.mkdirSync(spaceRoot, { mode: 0o700 });
          const stat = filesystem.lstatSync(spaceRoot);
          if (stat.isSymbolicLink()) {
            throw new FileOpError('SYMLINK_FORBIDDEN');
          }
          verifyOwnership(stat, expectedUid);
          const { size, mtimeMs } = extractValidMetadata(stat);
          const emptyDirEtag = computeDirectoryETag([]);
          return {
            op: 'mkdir',
            space,
            path: '.',
            created: true,
            etag: emptyDirEtag,
            size,
            mtimeMs,
          };
        });
      }

      return withPathLocks([{ space, path: normalizedPath }], options, () => {
        const parentDir = path.dirname(targetPath);
        let parentStat: fs.Stats;
        try {
          parentStat = filesystem.lstatSync(parentDir);
        } catch (err: unknown) {
          const code = (err as { code?: string })?.code;
          if (code === 'ENOENT') {
            throw new FileOpError('NOT_FOUND');
          }
          throw new FileOpError('BUSY');
        }
        if (parentStat.isSymbolicLink()) {
          throw new FileOpError('SYMLINK_FORBIDDEN');
        }
        if (!parentStat.isDirectory()) {
          throw new FileOpError('INVALID_TARGET');
        }
        verifyOwnership(parentStat, expectedUid);

        let existing = false;
        let existingStat: fs.Stats | null = null;
        try {
          existingStat = filesystem.lstatSync(targetPath);
          existing = true;
        } catch (err: unknown) {
          const code = (err as { code?: string })?.code;
          if (code === 'ENOENT') {
            existing = false;
          } else {
            throw new FileOpError('BUSY');
          }
        }
        if (existing) {
          throw new FileOpError('PRECONDITION_FAILED');
        }

        try {
          filesystem.mkdirSync(targetPath, { mode: 0o700 });
        } catch (mkdirErr: unknown) {
          const code = (mkdirErr as { code?: string })?.code;
          if (code === 'EEXIST') {
            throw new FileOpError('PRECONDITION_FAILED');
          }
          if (code === 'ENOENT') {
            throw new FileOpError('NOT_FOUND');
          }
          throw new FileOpError('BUSY');
        }

        verifyNoSymlinksInPath(spacesDir, space, segments, expectedUid, false, filesystem);

        const stat = filesystem.lstatSync(targetPath);
        if (stat.isSymbolicLink()) {
          throw new FileOpError('SYMLINK_FORBIDDEN');
        }
        if (!stat.isDirectory()) {
          throw new FileOpError('INVALID_TARGET');
        }
        verifyOwnership(stat, expectedUid);
        const { size, mtimeMs } = extractValidMetadata(stat);
        const emptyDirEtag = computeDirectoryETag([]);

        return {
          op: 'mkdir',
          space,
          path: normalizedPath,
          created: true,
          etag: emptyDirEtag,
          size,
          mtimeMs,
        };
      });
    }

    case 'delete': {
      if (
        reqObj.targetPath !== undefined ||
        reqObj.content !== undefined ||
        reqObj.encoding !== undefined ||
        reqObj.expectedTargetEtag !== undefined ||
        reqObj.requireAbsent !== undefined ||
        reqObj.requireTargetAbsent !== undefined
      ) {
        throw new FileOpError('INVALID_REQUEST');
      }

      if (segments.length === 0 || normalizedPath === '.') {
        throw new FileOpError('FORBIDDEN');
      }

      if (typeof reqObj.expectedEtag !== 'string' || !isValidETag(reqObj.expectedEtag)) {
        throw new FileOpError('INVALID_REQUEST');
      }
      const expectedEtag = reqObj.expectedEtag;

      return withPathLocks([{ space, path: normalizedPath }], options, () => {
        let stat: fs.Stats;
        try {
          stat = filesystem.lstatSync(targetPath);
        } catch (err: unknown) {
          const code = (err as { code?: string })?.code;
          if (code === 'ENOENT') {
            throw new FileOpError('NOT_FOUND');
          }
          throw new FileOpError('BUSY');
        }

        if (stat.isSymbolicLink()) {
          throw new FileOpError('SYMLINK_FORBIDDEN');
        }
        verifyOwnership(stat, expectedUid);

        if (stat.isFile()) {
          const nofollow = getNoFollowFlag();
          let fd: number | undefined;
          try {
            fd = filesystem.openSync(targetPath, fs.constants.O_RDONLY | nofollow);
            const fstat = filesystem.fstatSync(fd);
            if (!fstat.isFile() || fstat.dev !== stat.dev || fstat.ino !== stat.ino) {
              throw new FileOpError('TOCTOU_MISMATCH');
            }
            const buf = Buffer.alloc(fstat.size);
            let readBytes = 0;
            while (readBytes < fstat.size) {
              const chunk = filesystem.readSync(fd, buf, readBytes, fstat.size - readBytes, readBytes);
              if (chunk === 0) break;
              readBytes += chunk;
            }
            filesystem.closeSync(fd);
            fd = undefined;

            const actualBuf = readBytes === fstat.size ? buf : buf.subarray(0, readBytes);
            const currentEtag = computeFileETag(actualBuf);
            if (!matchETag(currentEtag, expectedEtag)) {
              throw new FileOpError('PRECONDITION_FAILED');
            }
          } catch (err: unknown) {
            if (fd !== undefined) {
              try {
                filesystem.closeSync(fd);
              } catch (closeErr: unknown) {
                const primary = err instanceof Error ? err : new FileOpError('PRECONDITION_FAILED');
                const cleanup = closeErr instanceof Error ? closeErr : new FileOpError('BUSY');
                throw new AggregateError([primary, cleanup], 'Failed to close fd during delete verification');
              }
              fd = undefined;
            }
            if (err instanceof FileOpError) throw err;
            throw new FileOpError('PRECONDITION_FAILED');
          }

          try {
            filesystem.unlinkSync(targetPath);
          } catch (unlinkErr: unknown) {
            const code = (unlinkErr as { code?: string })?.code;
            if (code === 'ENOENT') {
              throw new FileOpError('NOT_FOUND');
            }
            throw new FileOpError('BUSY');
          }
        } else if (stat.isDirectory()) {
          const dirInfo = inspectDirectory(filesystem, targetPath, expectedUid);
          if (!matchETag(dirInfo.etag, expectedEtag)) {
            throw new FileOpError('PRECONDITION_FAILED');
          }

          try {
            filesystem.rmdirSync(targetPath);
          } catch (rmErr: unknown) {
            const code = (rmErr as { code?: string })?.code;
            if (code === 'ENOTEMPTY' || code === 'EEXIST') {
              throw new FileOpError('PRECONDITION_FAILED');
            }
            throw new FileOpError('BUSY');
          }
        } else {
          throw new FileOpError('INVALID_TARGET');
        }

        return {
          op: 'delete',
          space,
          path: normalizedPath,
          deleted: true,
        };
      });
    }

    case 'stat': {
      if (
        reqObj.targetPath !== undefined ||
        reqObj.content !== undefined ||
        reqObj.encoding !== undefined ||
        reqObj.expectedEtag !== undefined ||
        reqObj.expectedTargetEtag !== undefined ||
        reqObj.requireAbsent !== undefined ||
        reqObj.requireTargetAbsent !== undefined
      ) {
        throw new FileOpError('INVALID_REQUEST');
      }

      let stat: fs.Stats;
      try {
        stat = filesystem.lstatSync(targetPath);
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code === 'ENOENT') {
          throw new FileOpError('NOT_FOUND');
        }
        throw new FileOpError('READ_FAILED');
      }

      if (stat.isSymbolicLink()) {
        throw new FileOpError('SYMLINK_FORBIDDEN');
      }
      verifyOwnership(stat, expectedUid);

      if (stat.isDirectory()) {
        const dirInfo = inspectDirectory(filesystem, targetPath, expectedUid);
        return {
          op: 'stat',
          space,
          path: normalizedPath,
          type: 'directory',
          size: dirInfo.size,
          mtimeMs: dirInfo.mtimeMs,
          etag: dirInfo.etag,
        };
      }

      if (!stat.isFile()) {
        throw new FileOpError('INVALID_TARGET');
      }

      const nofollow = getNoFollowFlag();
      let fd: number | undefined;
      try {
        fd = filesystem.openSync(targetPath, fs.constants.O_RDONLY | nofollow);
        const fstat = filesystem.fstatSync(fd);
        if (!fstat.isFile()) {
          throw new FileOpError('INVALID_TARGET');
        }
        verifyOwnership(fstat, expectedUid);
        if (fstat.dev !== stat.dev || fstat.ino !== stat.ino) {
          throw new FileOpError('TOCTOU_MISMATCH');
        }

        const { mtimeMs } = extractValidMetadata(fstat);

        // Streaming ETag calculation in 64 KiB chunks (NO large buffer in memory)
        const hasher = crypto.createHash('sha256');
        const chunkBuf = Buffer.alloc(64 * 1024);
        let totalRead = 0;
        while (totalRead < fstat.size) {
          const toRead = Math.min(chunkBuf.length, fstat.size - totalRead);
          const bytesRead = filesystem.readSync(fd, chunkBuf, 0, toRead, totalRead);
          if (bytesRead === 0) break;
          hasher.update(bytesRead === chunkBuf.length ? chunkBuf : chunkBuf.subarray(0, bytesRead));
          totalRead += bytesRead;
        }

        filesystem.closeSync(fd);
        fd = undefined;

        const etag = `"${hasher.digest('hex').toLowerCase()}"`;

        return {
          op: 'stat',
          space,
          path: normalizedPath,
          type: 'file',
          size: fstat.size,
          mtimeMs,
          etag,
        };
      } finally {
        if (fd !== undefined) {
          try {
            filesystem.closeSync(fd);
          } catch {}
        }
      }
    }

    case 'sniff': {
      if (
        reqObj.targetPath !== undefined ||
        reqObj.content !== undefined ||
        reqObj.encoding !== undefined ||
        reqObj.expectedEtag !== undefined ||
        reqObj.expectedTargetEtag !== undefined ||
        reqObj.requireAbsent !== undefined ||
        reqObj.requireTargetAbsent !== undefined
      ) {
        throw new FileOpError('INVALID_REQUEST');
      }

      const maxBytes = typeof reqObj.maxBytes === 'number' && Number.isSafeInteger(reqObj.maxBytes) && reqObj.maxBytes > 0
        ? Math.min(reqObj.maxBytes, 4096)
        : 512;

      let stat: fs.Stats;
      try {
        stat = filesystem.lstatSync(targetPath);
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code === 'ENOENT') {
          throw new FileOpError('NOT_FOUND');
        }
        throw new FileOpError('READ_FAILED');
      }

      if (stat.isSymbolicLink()) {
        throw new FileOpError('SYMLINK_FORBIDDEN');
      }
      if (!stat.isFile()) {
        throw new FileOpError('INVALID_TARGET');
      }
      verifyOwnership(stat, expectedUid);

      const nofollow = getNoFollowFlag();
      let fd: number | undefined;
      try {
        fd = filesystem.openSync(targetPath, fs.constants.O_RDONLY | nofollow);
        const fstat = filesystem.fstatSync(fd);
        if (!fstat.isFile()) {
          throw new FileOpError('INVALID_TARGET');
        }
        verifyOwnership(fstat, expectedUid);
        if (fstat.dev !== stat.dev || fstat.ino !== stat.ino) {
          throw new FileOpError('TOCTOU_MISMATCH');
        }

        const { mtimeMs } = extractValidMetadata(fstat);

        // Read initial header bytes
        const headerSize = Math.min(maxBytes, fstat.size);
        const headerBuf = Buffer.alloc(headerSize);
        let headerRead = 0;
        if (headerSize > 0) {
          headerRead = filesystem.readSync(fd, headerBuf, 0, headerSize, 0);
        }

        // Streaming ETag calculation (starting from header bytes)
        const hasher = crypto.createHash('sha256');
        if (headerRead > 0) {
          hasher.update(headerRead === headerBuf.length ? headerBuf : headerBuf.subarray(0, headerRead));
        }

        const chunkBuf = Buffer.alloc(64 * 1024);
        let totalRead = headerRead;
        while (totalRead < fstat.size) {
          const toRead = Math.min(chunkBuf.length, fstat.size - totalRead);
          const bytesRead = filesystem.readSync(fd, chunkBuf, 0, toRead, totalRead);
          if (bytesRead === 0) break;
          hasher.update(bytesRead === chunkBuf.length ? chunkBuf : chunkBuf.subarray(0, bytesRead));
          totalRead += bytesRead;
        }

        filesystem.closeSync(fd);
        fd = undefined;

        const etag = `"${hasher.digest('hex').toLowerCase()}"`;
        const headerBytesBase64 = (headerRead === headerBuf.length ? headerBuf : headerBuf.subarray(0, headerRead)).toString('base64');

        return {
          op: 'sniff',
          space,
          path: normalizedPath,
          type: 'file',
          size: fstat.size,
          mtimeMs,
          etag,
          headerBytesBase64,
        };
      } finally {
        if (fd !== undefined) {
          try {
            filesystem.closeSync(fd);
          } catch {}
        }
      }
    }

    case 'copy': {
      if (
        reqObj.content !== undefined ||
        reqObj.encoding !== undefined ||
        reqObj.expectedTargetEtag !== undefined ||
        reqObj.requireTargetAbsent !== undefined
      ) {
        throw new FileOpError('INVALID_REQUEST');
      }

      if (typeof reqObj.targetPath !== 'string') {
        throw new FileOpError('INVALID_REQUEST');
      }

      const { normalizedPath: targetRelPath, segments: targetSegments } = validateRelativePath(reqObj.targetPath);
      if (targetSegments.length === 0 || targetRelPath === '.') {
        throw new FileOpError('INVALID_TARGET');
      }

      const expectedEtag = typeof reqObj.expectedEtag === 'string' ? reqObj.expectedEtag : undefined;
      const requireAbsent = reqObj.requireAbsent === true;

      const destSpace = typeof reqObj.targetSpace === 'string' && reqObj.targetSpace.trim()
        ? validateSpaceName(reqObj.targetSpace)
        : space;

      // Validate target path containment and verify no symlinks
      const { targetPath: finalDestPath } = verifyNoSymlinksInPath(
        spacesDir,
        destSpace,
        targetSegments,
        expectedUid,
        true,
        filesystem
      );

      // Verify source file exists and is regular file
      let srcStat: fs.Stats;
      try {
        srcStat = filesystem.lstatSync(targetPath);
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code === 'ENOENT') {
          throw new FileOpError('NOT_FOUND');
        }
        throw new FileOpError('READ_FAILED');
      }

      if (srcStat.isSymbolicLink()) {
        throw new FileOpError('SYMLINK_FORBIDDEN');
      }
      if (!srcStat.isFile()) {
        throw new FileOpError('INVALID_TARGET');
      }
      verifyOwnership(srcStat, expectedUid);

      const nofollow = getNoFollowFlag();
      let srcFd: number | undefined;
      let dstFd: number | undefined;
      const tempDestPath = `${finalDestPath}.tmp_copy_${process.pid}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;

      try {
        srcFd = filesystem.openSync(targetPath, fs.constants.O_RDONLY | nofollow);
        const fstat = filesystem.fstatSync(srcFd);
        if (!fstat.isFile()) {
          throw new FileOpError('INVALID_TARGET');
        }
        verifyOwnership(fstat, expectedUid);
        if (fstat.dev !== srcStat.dev || fstat.ino !== srcStat.ino) {
          throw new FileOpError('TOCTOU_MISMATCH');
        }

        // Ensure parent directory of destination exists
        const destParentDir = path.dirname(finalDestPath);
        if (!filesystem.existsSync(destParentDir)) {
          filesystem.mkdirSync(destParentDir, { recursive: true, mode: 0o700 });
        }

        // Open temp destination file
        dstFd = filesystem.openSync(
          tempDestPath,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | nofollow,
          0o600
        );

        // Streaming copy + hashing in 64 KiB chunks
        const hasher = crypto.createHash('sha256');
        const chunkBuf = Buffer.alloc(64 * 1024);
        let totalCopied = 0;

        while (totalCopied < fstat.size) {
          const toRead = Math.min(chunkBuf.length, fstat.size - totalCopied);
          const bytesRead = filesystem.readSync(srcFd, chunkBuf, 0, toRead, totalCopied);
          if (bytesRead === 0) break;
          const writeSlice = bytesRead === chunkBuf.length ? chunkBuf : chunkBuf.subarray(0, bytesRead);
          hasher.update(writeSlice);
          let bytesWritten = 0;
          while (bytesWritten < bytesRead) {
            const written = filesystem.writeSync(dstFd, writeSlice, bytesWritten, bytesRead - bytesWritten);
            if (written === 0) throw new FileOpError('WRITE_FAILED');
            bytesWritten += written;
          }
          totalCopied += bytesRead;
        }

        filesystem.fsyncSync(dstFd);
        filesystem.closeSync(dstFd);
        dstFd = undefined;

        filesystem.closeSync(srcFd);
        srcFd = undefined;

        const calculatedEtag = `"${hasher.digest('hex').toLowerCase()}"`;

        if (expectedEtag && calculatedEtag !== expectedEtag) {
          try {
            filesystem.unlinkSync(tempDestPath);
          } catch {}
          throw new FileOpError('PRECONDITION_FAILED');
        }

        // Check if destination exists if requireAbsent
        if (requireAbsent && filesystem.existsSync(finalDestPath)) {
          try {
            filesystem.unlinkSync(tempDestPath);
          } catch {}
          throw new FileOpError('TARGET_EXISTS');
        }

        // Atomic rename from temp to final destination
        filesystem.renameSync(tempDestPath, finalDestPath);

        const destStat = filesystem.statSync(finalDestPath);
        const { mtimeMs } = extractValidMetadata(destStat);

        return {
          op: 'copy',
          space,
          path: normalizedPath,
          targetPath: targetRelPath,
          type: 'file',
          size: totalCopied,
          mtimeMs,
          etag: calculatedEtag,
        };
      } catch (err) {
        if (tempDestPath) {
          try {
            if (filesystem.existsSync(tempDestPath)) {
              filesystem.unlinkSync(tempDestPath);
            }
          } catch {}
        }
        if (err instanceof FileOpError) throw err;
        throw new FileOpError('WRITE_FAILED');
      } finally {
        if (srcFd !== undefined) {
          try {
            filesystem.closeSync(srcFd);
          } catch {}
        }
        if (dstFd !== undefined) {
          try {
            filesystem.closeSync(dstFd);
          } catch {}
        }
      }
    }
  }
}

export interface StreamingWriteOptions {
  readonly space: string;
  readonly path: string;
  readonly expectedEtag?: string;
  readonly requireAbsent?: boolean;
  readonly maxSizeBytes?: number;
}

export interface FileStageOptions {
  readonly space: string;
  readonly path: string;
  readonly maxSizeBytes?: number;
}

export interface FileStageResult {
  readonly op: 'stage';
  readonly space: string;
  readonly path: string;
  readonly stageToken: string;
  readonly size: number;
  readonly sha256: string;
  readonly etag: string;
}

export interface FileCommitStageOptions {
  readonly space: string;
  readonly path: string;
  readonly stageToken: string;
  readonly rollbackToken?: string;
  readonly expectedEtag?: string;
  readonly requireAbsent?: boolean;
}

export interface FileAbortStageOptions {
  readonly space: string;
  readonly path: string;
  readonly stageToken: string;
}

const STAGE_TOKEN_REGEX = /^\.[a-zA-Z0-9_.-]+\.[0-9a-f]{16}\.stage\.tmp$/;
const ROLLBACK_TOKEN_REGEX = /^\.[a-zA-Z0-9_.-]+\.[0-9a-f]{16}\.rollback\.tmp$/;

export function validateStageToken(token: unknown): string {
  if (typeof token !== 'string' || !STAGE_TOKEN_REGEX.test(token)) {
    throw new FileOpError('INVALID_REQUEST');
  }
  return token;
}

export function validateRollbackToken(token: unknown): string {
  if (typeof token !== 'string' || !ROLLBACK_TOKEN_REGEX.test(token)) {
    throw new FileOpError('INVALID_REQUEST');
  }
  return token;
}

/**
 * Phase 1: Streams incoming file payload to an exclusive stage temporary file in the destination directory.
 * Returns an opaque stageToken, total size, sha256, and computed ETag.
 */
export async function executeFileStageStream(
  options: FileStageOptions,
  inStream: NodeJS.ReadableStream,
  execOptions: FileOpExecutionOptions = {}
): Promise<FileStageResult> {
  const space = validateSpaceName(options.space);
  const { normalizedPath, segments } = validateRelativePath(options.path);

  if (segments.length === 0 || normalizedPath === '.') {
    throw new FileOpError('INVALID_TARGET');
  }

  const maxBytes = options.maxSizeBytes ?? MAX_STREAMING_FILE_BYTES;
  const spacesDir = execOptions.spacesDir || path.join(process.env.DSH_HOME || '/home/dsh', 'spaces');
  const expectedUid = execOptions.expectedUid;
  const filesystem = execOptions.fsImpl || fs;

  filesystem.mkdirSync(spacesDir, { recursive: true, mode: 0o700 });
  const spaceRoot = path.join(spacesDir, space);
  filesystem.mkdirSync(spaceRoot, { recursive: true, mode: 0o700 });

  verifyNoSymlinksInPath(spacesDir, space, segments.slice(0, -1), expectedUid, true, filesystem);

  const targetPath = path.join(spaceRoot, ...segments);
  const parentDir = path.dirname(targetPath);
  filesystem.mkdirSync(parentDir, { recursive: true, mode: 0o700 });

  const parentStat = filesystem.lstatSync(parentDir);
  if (parentStat.isSymbolicLink()) {
    throw new FileOpError('SYMLINK_FORBIDDEN');
  }
  if (!parentStat.isDirectory()) {
    throw new FileOpError('INVALID_TARGET');
  }
  verifyOwnership(parentStat, expectedUid);

  const tempFileName = `.${path.basename(targetPath)}.${crypto.randomBytes(8).toString('hex')}.stage.tmp`;
  const tempPath = path.join(parentDir, tempFileName);
  const nofollow = getNoFollowFlag();

  let fd: number | undefined;
  let totalBytesWritten = 0;
  const hasher = crypto.createHash('sha256');

  try {
    fd = filesystem.openSync(
      tempPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | nofollow,
      0o600
    );

    await new Promise<void>((resolve, reject) => {
      let streamError: Error | null = null;

      inStream.on('data', (chunk: Buffer | string) => {
        if (streamError) return;
        try {
          const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
          totalBytesWritten += buf.length;
          if (totalBytesWritten > maxBytes) {
            streamError = new FileOpError('PAYLOAD_TOO_LARGE');
            if (typeof (inStream as any).destroy === 'function') {
              (inStream as any).destroy(streamError);
            }
            reject(streamError);
            return;
          }
          hasher.update(buf);
          let written = 0;
          while (written < buf.length) {
            const bytes = filesystem.writeSync(fd!, buf, written, buf.length - written, null);
            if (bytes === 0) break;
            written += bytes;
          }
        } catch (writeErr) {
          streamError = writeErr instanceof Error ? writeErr : new FileOpError('WRITE_FAILED');
          if (typeof (inStream as any).destroy === 'function') {
            (inStream as any).destroy(streamError);
          }
          reject(streamError);
        }
      });

      inStream.on('error', (err) => {
        if (!streamError) {
          streamError = err;
          reject(err);
        }
      });

      inStream.on('end', () => {
        if (!streamError) {
          resolve();
        }
      });
    });

    filesystem.fsyncSync(fd);
    filesystem.closeSync(fd);
    fd = undefined;
  } catch (writeErr: unknown) {
    if (fd !== undefined) {
      try {
        filesystem.closeSync(fd);
      } catch {
        // Ignore
      }
      fd = undefined;
    }
    try {
      filesystem.unlinkSync(tempPath);
    } catch {
      // Ignore
    }
    if (writeErr instanceof FileOpError) throw writeErr;
    throw new FileOpError('WRITE_FAILED');
  }

  const sha256Hex = hasher.digest('hex').toLowerCase();
  const etag = `"${sha256Hex}"`;

  return {
    op: 'stage',
    space,
    path: normalizedPath,
    stageToken: tempFileName,
    size: totalBytesWritten,
    sha256: sha256Hex,
    etag,
  };
}

/**
 * Phase 2: Atomically commits a previously staged temporary file to its target path while holding locks.
 */
export async function executeFileCommitStage(
  options: FileCommitStageOptions,
  execOptions: FileOpExecutionOptions = {}
): Promise<FileOperationResult> {
  const space = validateSpaceName(options.space);
  const { normalizedPath, segments } = validateRelativePath(options.path);
  const stageToken = validateStageToken(options.stageToken);

  if (segments.length === 0 || normalizedPath === '.') {
    throw new FileOpError('INVALID_TARGET');
  }

  const hasExpectedEtag = options.expectedEtag !== undefined;
  const hasRequireAbsent = options.requireAbsent !== undefined;

  if (hasExpectedEtag && hasRequireAbsent) {
    throw new FileOpError('INVALID_REQUEST');
  }
  if (!hasExpectedEtag && !hasRequireAbsent) {
    throw new FileOpError('INVALID_REQUEST');
  }
  if (hasExpectedEtag && !isValidETag(options.expectedEtag)) {
    throw new FileOpError('INVALID_REQUEST');
  }
  if (hasRequireAbsent && options.requireAbsent !== true) {
    throw new FileOpError('INVALID_REQUEST');
  }

  const expectedEtag = options.expectedEtag;
  const requireAbsent = options.requireAbsent === true;

  return withPathLocks([{ space, path: normalizedPath }], execOptions, async () => {
    const spacesDir = execOptions.spacesDir || path.join(process.env.DSH_HOME || '/home/dsh', 'spaces');
    const expectedUid = execOptions.expectedUid;
    const filesystem = execOptions.fsImpl || fs;

    verifyNoSymlinksInPath(spacesDir, space, segments.slice(0, -1), expectedUid, true, filesystem);

    const spaceRoot = path.join(spacesDir, space);
    const targetPath = path.join(spaceRoot, ...segments);
    const parentDir = path.dirname(targetPath);
    const tempPath = path.join(parentDir, stageToken);

    let tempStat: fs.Stats;
    try {
      tempStat = filesystem.lstatSync(tempPath);
      if (tempStat.isSymbolicLink() || !tempStat.isFile()) {
        throw new FileOpError('INVALID_REQUEST');
      }
      verifyOwnership(tempStat, expectedUid);
    } catch {
      throw new FileOpError('INVALID_REQUEST');
    }

    let initialTargetStat: fs.Stats | undefined;
    let initialTargetDev: number | undefined;
    let initialTargetIno: number | undefined;
    let targetExists = false;

    try {
      initialTargetStat = filesystem.lstatSync(targetPath);
      targetExists = true;
      if (initialTargetStat.isSymbolicLink() || initialTargetStat.isDirectory() || !initialTargetStat.isFile()) {
        throw new FileOpError('INVALID_TARGET');
      }
      verifyOwnership(initialTargetStat, expectedUid);
      initialTargetDev = initialTargetStat.dev;
      initialTargetIno = initialTargetStat.ino;
    } catch (err: unknown) {
      if (err instanceof FileOpError) throw err;
      const code = (err as { code?: string })?.code;
      if (code === 'ENOENT') {
        targetExists = false;
      } else {
        throw new FileOpError('WRITE_FAILED');
      }
    }

    if (requireAbsent && targetExists) {
      // Clean up staged temp file on precondition conflict
      try {
        filesystem.unlinkSync(tempPath);
      } catch {
        // Ignore
      }
      throw new FileOpError('PRECONDITION_FAILED');
    }

    if (expectedEtag !== undefined) {
      if (!targetExists || !initialTargetStat) {
        try {
          filesystem.unlinkSync(tempPath);
        } catch {
          // Ignore
        }
        throw new FileOpError('PRECONDITION_FAILED');
      }

      const nofollow = getNoFollowFlag();
      let checkFd: number | undefined;
      try {
        checkFd = filesystem.openSync(targetPath, fs.constants.O_RDONLY | nofollow);
        const fstat = filesystem.fstatSync(checkFd);
        if (!fstat.isFile() || fstat.dev !== initialTargetStat.dev || fstat.ino !== initialTargetStat.ino) {
          throw new FileOpError('TOCTOU_MISMATCH');
        }
        verifyOwnership(fstat, expectedUid);

        const hasher = crypto.createHash('sha256');
        const chunkBuf = Buffer.alloc(64 * 1024);
        let readTotal = 0;
        while (readTotal < fstat.size) {
          const bytesRead = filesystem.readSync(checkFd, chunkBuf, 0, Math.min(chunkBuf.length, fstat.size - readTotal), readTotal);
          if (bytesRead === 0) break;
          hasher.update(chunkBuf.subarray(0, bytesRead));
          readTotal += bytesRead;
        }
        filesystem.closeSync(checkFd);
        checkFd = undefined;

        const currentEtag = `"${hasher.digest('hex').toLowerCase()}"`;
        if (!matchETag(currentEtag, expectedEtag)) {
          throw new FileOpError('PRECONDITION_FAILED');
        }
      } catch (openErr: unknown) {
        if (checkFd !== undefined) {
          try {
            filesystem.closeSync(checkFd);
          } catch {
            // Ignore
          }
          checkFd = undefined;
        }
        try {
          filesystem.unlinkSync(tempPath);
        } catch {
          // Ignore
        }
        if (openErr instanceof FileOpError) throw openErr;
        throw new FileOpError('PRECONDITION_FAILED');
      }
    }

    let rollbackToken: string | undefined;

    if (requireAbsent) {
      try {
        filesystem.linkSync(tempPath, targetPath);
      } catch (linkErr: unknown) {
        try {
          filesystem.unlinkSync(tempPath);
        } catch {
          // Ignore
        }
        const linkCode = (linkErr as { code?: string })?.code;
        if (linkCode === 'EEXIST') {
          throw new FileOpError('PRECONDITION_FAILED');
        }
        throw new FileOpError('WRITE_FAILED');
      }
      try {
        filesystem.unlinkSync(tempPath);
      } catch {
        // Ignore
      }
    } else {
      if (targetExists && initialTargetDev !== undefined && initialTargetIno !== undefined) {
        let preRenameStat: fs.Stats;
        try {
          preRenameStat = filesystem.lstatSync(targetPath);
        } catch {
          try {
            filesystem.unlinkSync(tempPath);
          } catch {
            // Ignore
          }
          throw new FileOpError('TOCTOU_MISMATCH');
        }
        if (preRenameStat.dev !== initialTargetDev || preRenameStat.ino !== initialTargetIno) {
          try {
            filesystem.unlinkSync(tempPath);
          } catch {
            // Ignore
          }
          throw new FileOpError('TOCTOU_MISMATCH');
        }

        // Overwrite: preserve target as backup rollbackToken
        const backupToken = options.rollbackToken ? validateRollbackToken(options.rollbackToken) : `.${path.basename(targetPath)}.${crypto.randomBytes(8).toString('hex')}.rollback.tmp`;
        const backupPath = path.join(parentDir, backupToken);
        try {
          filesystem.renameSync(targetPath, backupPath);
          rollbackToken = backupToken;
        } catch {
          try {
            filesystem.unlinkSync(tempPath);
          } catch {
            // Ignore
          }
          throw new FileOpError('WRITE_FAILED');
        }
      }

      try {
        filesystem.renameSync(tempPath, targetPath);
      } catch (renameErr) {
        if (rollbackToken) {
          try {
            const backupPath = path.join(parentDir, rollbackToken);
            filesystem.renameSync(backupPath, targetPath);
          } catch {
            // Ignore
          }
        }
        try {
          filesystem.unlinkSync(tempPath);
        } catch {
          // Ignore
        }
        throw new FileOpError('WRITE_FAILED');
      }
    }

    let writtenStat: fs.Stats;
    try {
      writtenStat = filesystem.lstatSync(targetPath);
      if (writtenStat.isSymbolicLink()) {
        throw new FileOpError('SYMLINK_FORBIDDEN');
      }
      verifyOwnership(writtenStat, expectedUid);
    } catch (statErr: unknown) {
      if (statErr instanceof FileOpError) throw statErr;
      throw new FileOpError('WRITE_FAILED');
    }

    // Recompute ETag from committed file
    const nofollow = getNoFollowFlag();
    let committedFd: number | undefined;
    let finalEtag: string;
    try {
      committedFd = filesystem.openSync(targetPath, fs.constants.O_RDONLY | nofollow);
      const fstat = filesystem.fstatSync(committedFd);
      const hasher = crypto.createHash('sha256');
      const chunkBuf = Buffer.alloc(64 * 1024);
      let readTotal = 0;
      while (readTotal < fstat.size) {
        const bytesRead = filesystem.readSync(committedFd, chunkBuf, 0, Math.min(chunkBuf.length, fstat.size - readTotal), readTotal);
        if (bytesRead === 0) break;
        hasher.update(chunkBuf.subarray(0, bytesRead));
        readTotal += bytesRead;
      }
      filesystem.closeSync(committedFd);
      committedFd = undefined;
      finalEtag = `"${hasher.digest('hex').toLowerCase()}"`;
    } catch {
      if (committedFd !== undefined) {
        try {
          filesystem.closeSync(committedFd);
        } catch {
          // Ignore
        }
      }
      throw new FileOpError('WRITE_FAILED');
    }

    const { mtimeMs } = extractValidMetadata(writtenStat);

    // Fsync parent directory to ensure directory entry changes are durable
    let dirFd: number | undefined;
    try {
      dirFd = filesystem.openSync(parentDir, fs.constants.O_RDONLY | nofollow);
      filesystem.fsyncSync(dirFd);
      filesystem.closeSync(dirFd);
      dirFd = undefined;
    } catch {
      if (dirFd !== undefined) {
        try { filesystem.closeSync(dirFd); } catch {}
        dirFd = undefined;
      }
    }

    return {
      op: 'write',
      space,
      path: normalizedPath,
      type: 'file',
      size: writtenStat.size,
      written: true,
      encoding: 'utf8',
      mtimeMs,
      etag: finalEtag,
      ...(rollbackToken ? { rollbackToken } : {}),
    } as any;
  });
}

export interface FileFinalizeStageOptions {
  readonly space: string;
  readonly path: string;
  readonly rollbackToken?: string;
}

export interface FileRollbackCommitOptions {
  readonly space: string;
  readonly path: string;
  readonly rollbackToken?: string;
  readonly stageToken?: string;
  readonly expectedEtag?: string;
}

export interface FileInspectTransferStateOptions {
  readonly space: string;
  readonly path: string;
  readonly stageToken?: string;
  readonly rollbackToken?: string;
  readonly expectedContentSha256: string;
  readonly overwrite?: boolean;
}

export interface FileInspectTransferStateResult {
  readonly op: 'inspect_transfer_state';
  readonly space: string;
  readonly path: string;
  readonly staged_present: boolean;
  readonly target_matches: boolean;
  readonly rollback_present: boolean;
  readonly stageExists: boolean;
  readonly rollbackExists: boolean;
  readonly targetExists: boolean;
  readonly targetEtag: string | null;
  readonly etag: string | null;
  readonly targetMtimeMs: number | null;
  readonly mtimeMs: number | null;
  readonly targetSize: number | null;
  readonly size: number | null;
  readonly targetMatchesContent: boolean;
  readonly consistentWithCommitted: boolean;
  readonly consistentWithStagedPreCommit: boolean;
}

/**
 * Inspects the exact on-disk state of a transfer (target, stageToken, rollbackToken)
 * without buffering file content in memory.
 */
export async function executeFileInspectTransferState(
  options: FileInspectTransferStateOptions,
  execOptions: FileOpExecutionOptions = {}
): Promise<FileInspectTransferStateResult> {
  const space = validateSpaceName(options.space);
  const { normalizedPath, segments } = validateRelativePath(options.path);

  if (segments.length === 0 || normalizedPath === '.') {
    throw new FileOpError('INVALID_TARGET');
  }

  const spacesDir = execOptions.spacesDir || path.join(process.env.DSH_HOME || '/home/dsh', 'spaces');
  const expectedUid = execOptions.expectedUid;
  const filesystem = execOptions.fsImpl || fs;

  verifyNoSymlinksInPath(spacesDir, space, segments.slice(0, -1), expectedUid, false, filesystem);

  const spaceRoot = path.join(spacesDir, space);
  const targetPath = path.join(spaceRoot, ...segments);
  const parentDir = path.dirname(targetPath);
  const nofollow = getNoFollowFlag();

  let stageExists = false;
  if (options.stageToken) {
    try {
      const stageToken = validateStageToken(options.stageToken);
      const stagePath = path.join(parentDir, stageToken);
      const st = filesystem.lstatSync(stagePath);
      stageExists = !st.isSymbolicLink() && st.isFile();
      if (stageExists && expectedUid !== undefined && st.uid !== expectedUid) {
        stageExists = false;
      }
    } catch {
      stageExists = false;
    }
  }

  let rollbackExists = false;
  if (options.rollbackToken) {
    try {
      const rollbackToken = validateRollbackToken(options.rollbackToken);
      const rbPath = path.join(parentDir, rollbackToken);
      const st = filesystem.lstatSync(rbPath);
      rollbackExists = !st.isSymbolicLink() && st.isFile();
      if (rollbackExists && expectedUid !== undefined && st.uid !== expectedUid) {
        rollbackExists = false;
      }
    } catch {
      rollbackExists = false;
    }
  }

  let targetExists = false;
  let targetEtag: string | null = null;
  let targetMtimeMs: number | null = null;
  let targetSize: number | null = null;
  let targetMatchesContent = false;

  try {
    const tStat = filesystem.lstatSync(targetPath);
    if (!tStat.isSymbolicLink() && tStat.isFile()) {
      if (expectedUid === undefined || tStat.uid === expectedUid) {
        targetExists = true;
        targetSize = tStat.size;
        const { mtimeMs } = extractValidMetadata(tStat);
        targetMtimeMs = mtimeMs;

        // Stream calculate ETag
        let fd: number | undefined;
        try {
          fd = filesystem.openSync(targetPath, fs.constants.O_RDONLY | nofollow);
          const fstat = filesystem.fstatSync(fd);
          if (fstat.isFile() && (expectedUid === undefined || fstat.uid === expectedUid)) {
            const hasher = crypto.createHash('sha256');
            const chunkBuf = Buffer.alloc(64 * 1024);
            let readTotal = 0;
            while (readTotal < fstat.size) {
              const bytesRead = filesystem.readSync(fd, chunkBuf, 0, Math.min(chunkBuf.length, fstat.size - readTotal), readTotal);
              if (bytesRead === 0) break;
              hasher.update(chunkBuf.subarray(0, bytesRead));
              readTotal += bytesRead;
            }
            const hashHex = hasher.digest('hex').toLowerCase();
            targetEtag = `"${hashHex}"`;
            targetMatchesContent = hashHex === options.expectedContentSha256.toLowerCase();
          }
          filesystem.closeSync(fd);
          fd = undefined;
        } catch {
          if (fd !== undefined) {
            try { filesystem.closeSync(fd); } catch {}
            fd = undefined;
          }
        }
      }
    }
  } catch {
    targetExists = false;
  }

  // Assessment
  // Staged Pre-Commit: stage exists, rollback does NOT exist, target is unchanged / does NOT match new content
  const consistentWithStagedPreCommit = stageExists && !rollbackExists && !targetMatchesContent;

  // Committed: target exists and matches new content, stage is gone, rollback presence matches overwrite expectation
  const consistentWithCommitted = targetExists && targetMatchesContent && !stageExists && (!options.overwrite || rollbackExists || options.rollbackToken === undefined);

  return {
    op: 'inspect_transfer_state',
    space,
    path: normalizedPath,
    staged_present: stageExists,
    target_matches: targetMatchesContent,
    rollback_present: rollbackExists,
    stageExists,
    rollbackExists,
    targetExists,
    targetEtag,
    etag: targetEtag,
    targetMtimeMs,
    mtimeMs: targetMtimeMs,
    targetSize,
    size: targetSize,
    targetMatchesContent,
    consistentWithCommitted,
    consistentWithStagedPreCommit,
  };
}

/**
 * Finalizes stage commit by safely deleting the backup file after DB transaction commit.
 */
export async function executeFileFinalizeStage(
  options: FileFinalizeStageOptions,
  execOptions: FileOpExecutionOptions = {}
): Promise<{ op: 'finalize_stage'; finalized: true }> {
  if (!options.rollbackToken) {
    return { op: 'finalize_stage', finalized: true };
  }

  const space = validateSpaceName(options.space);
  const { segments } = validateRelativePath(options.path);
  const spacesDir = execOptions.spacesDir || path.join(process.env.DSH_HOME || '/home/dsh', 'spaces');
  const filesystem = execOptions.fsImpl || fs;

  const spaceRoot = path.join(spacesDir, space);
  const targetPath = path.join(spaceRoot, ...segments);
  const parentDir = path.dirname(targetPath);
  const backupPath = path.join(parentDir, options.rollbackToken);
  const nofollow = getNoFollowFlag();

  try {
    filesystem.unlinkSync(backupPath);
    let dirFd: number | undefined;
    try {
      dirFd = filesystem.openSync(parentDir, fs.constants.O_RDONLY | nofollow);
      filesystem.fsyncSync(dirFd);
      filesystem.closeSync(dirFd);
      dirFd = undefined;
    } catch {
      if (dirFd !== undefined) {
        try { filesystem.closeSync(dirFd); } catch {}
        dirFd = undefined;
      }
    }
  } catch {
    // Ignore if already deleted
  }

  return { op: 'finalize_stage', finalized: true };
}

/**
 * Rolls back a physical commit: restores backup if overwritten, or deletes target if new.
 */
export async function executeFileRollbackCommit(
  options: FileRollbackCommitOptions,
  execOptions: FileOpExecutionOptions = {}
): Promise<{ op: 'rollback_commit'; rolledBack: true }> {
  const space = validateSpaceName(options.space);
  const { normalizedPath, segments } = validateRelativePath(options.path);

  return withPathLocks([{ space, path: normalizedPath }], execOptions, async () => {
    const spacesDir = execOptions.spacesDir || path.join(process.env.DSH_HOME || '/home/dsh', 'spaces');
    const filesystem = execOptions.fsImpl || fs;
    const nofollow = getNoFollowFlag();

    const spaceRoot = path.join(spacesDir, space);
    const targetPath = path.join(spaceRoot, ...segments);
    const parentDir = path.dirname(targetPath);

    if (options.rollbackToken) {
      const backupPath = path.join(parentDir, options.rollbackToken);
      try {
        if (filesystem.existsSync(backupPath)) {
          filesystem.renameSync(backupPath, targetPath);
        }
      } catch {
        // Ignore
      }
    } else {
      try {
        filesystem.unlinkSync(targetPath);
      } catch {
        // Ignore
      }
    }

    if (options.stageToken) {
      try {
        const tempPath = path.join(parentDir, options.stageToken);
        filesystem.unlinkSync(tempPath);
      } catch {
        // Ignore
      }
    }

    let dirFd: number | undefined;
    try {
      dirFd = filesystem.openSync(parentDir, fs.constants.O_RDONLY | nofollow);
      filesystem.fsyncSync(dirFd);
      filesystem.closeSync(dirFd);
      dirFd = undefined;
    } catch {
      if (dirFd !== undefined) {
        try { filesystem.closeSync(dirFd); } catch {}
        dirFd = undefined;
      }
    }

    return { op: 'rollback_commit', rolledBack: true };
  });
}

/**
 * Aborts a staged temporary file and cleans it up.
 */
export async function executeFileAbortStage(
  options: FileAbortStageOptions,
  execOptions: FileOpExecutionOptions = {}
): Promise<{ op: 'abort_stage'; aborted: true }> {
  const space = validateSpaceName(options.space);
  const { segments } = validateRelativePath(options.path);
  const stageToken = validateStageToken(options.stageToken);

  const spacesDir = execOptions.spacesDir || path.join(process.env.DSH_HOME || '/home/dsh', 'spaces');
  const filesystem = execOptions.fsImpl || fs;

  const spaceRoot = path.join(spacesDir, space);
  const targetPath = path.join(spaceRoot, ...segments);
  const parentDir = path.dirname(targetPath);
  const tempPath = path.join(parentDir, stageToken);

  try {
    filesystem.unlinkSync(tempPath);
  } catch {
    // Ignore if already deleted
  }

  return { op: 'abort_stage', aborted: true };
}

export interface StreamingReadOptions {
  readonly space: string;
  readonly path: string;
  readonly range?: {
    readonly start: number;
    readonly end: number;
  };
}

export interface StreamingReadResult {
  readonly op: 'read';
  readonly space: string;
  readonly path: string;
  readonly type?: 'file';
  readonly size: number;
  readonly mtimeMs: number;
  readonly etag: string;
  readonly totalSize: number;
  readonly range?: {
    readonly start: number;
    readonly end: number;
  };
  readonly stream: NodeJS.ReadableStream;
}

/**
 * Executes a streaming file write operation directly into the container workspace.
 * Writes to an exclusive temporary file with O_NOFOLLOW | O_EXCL, fsyncs, enforces size limits,
 * and atomically renames the file while holding path locks.
 */
export async function executeFileWriteStream(
  options: StreamingWriteOptions,
  inStream: NodeJS.ReadableStream,
  execOptions: FileOpExecutionOptions = {}
): Promise<FileOperationResult> {
  const space = validateSpaceName(options.space);
  const { normalizedPath, segments } = validateRelativePath(options.path);

  if (segments.length === 0 || normalizedPath === '.') {
    throw new FileOpError('INVALID_TARGET');
  }

  const hasExpectedEtag = options.expectedEtag !== undefined;
  const hasRequireAbsent = options.requireAbsent !== undefined;

  if (hasExpectedEtag && hasRequireAbsent) {
    throw new FileOpError('INVALID_REQUEST');
  }
  if (!hasExpectedEtag && !hasRequireAbsent) {
    throw new FileOpError('INVALID_REQUEST');
  }
  if (hasExpectedEtag && !isValidETag(options.expectedEtag)) {
    throw new FileOpError('INVALID_REQUEST');
  }
  if (hasRequireAbsent && options.requireAbsent !== true) {
    throw new FileOpError('INVALID_REQUEST');
  }

  const expectedEtag = options.expectedEtag;
  const requireAbsent = options.requireAbsent === true;
  const maxBytes = options.maxSizeBytes ?? MAX_STREAMING_FILE_BYTES;

  return withPathLocks([{ space, path: normalizedPath }], execOptions, async () => {
    const spacesDir = execOptions.spacesDir || path.join(process.env.DSH_HOME || '/home/dsh', 'spaces');
    const expectedUid = execOptions.expectedUid;
    const filesystem = execOptions.fsImpl || fs;

    filesystem.mkdirSync(spacesDir, { recursive: true, mode: 0o700 });
    const spaceRoot = path.join(spacesDir, space);
    filesystem.mkdirSync(spaceRoot, { recursive: true, mode: 0o700 });

    verifyNoSymlinksInPath(spacesDir, space, segments.slice(0, -1), expectedUid, true, filesystem);

    const targetPath = path.join(spaceRoot, ...segments);
    const parentDir = path.dirname(targetPath);
    filesystem.mkdirSync(parentDir, { recursive: true, mode: 0o700 });

    const parentStat = filesystem.lstatSync(parentDir);
    if (parentStat.isSymbolicLink()) {
      throw new FileOpError('SYMLINK_FORBIDDEN');
    }
    if (!parentStat.isDirectory()) {
      throw new FileOpError('INVALID_TARGET');
    }
    verifyOwnership(parentStat, expectedUid);

    let initialTargetStat: fs.Stats | undefined;
    let initialTargetDev: number | undefined;
    let initialTargetIno: number | undefined;
    let targetExists = false;

    try {
      initialTargetStat = filesystem.lstatSync(targetPath);
      targetExists = true;
      if (initialTargetStat.isSymbolicLink()) {
        throw new FileOpError('SYMLINK_FORBIDDEN');
      }
      if (initialTargetStat.isDirectory() || !initialTargetStat.isFile()) {
        throw new FileOpError('INVALID_TARGET');
      }
      verifyOwnership(initialTargetStat, expectedUid);
      initialTargetDev = initialTargetStat.dev;
      initialTargetIno = initialTargetStat.ino;
    } catch (err: unknown) {
      if (err instanceof FileOpError) throw err;
      const code = (err as { code?: string })?.code;
      if (code === 'ENOENT') {
        targetExists = false;
      } else {
        throw new FileOpError('WRITE_FAILED');
      }
    }

    if (requireAbsent && targetExists) {
      throw new FileOpError('PRECONDITION_FAILED');
    }

    if (expectedEtag !== undefined) {
      if (!targetExists || !initialTargetStat) {
        throw new FileOpError('PRECONDITION_FAILED');
      }

      const nofollow = getNoFollowFlag();
      let checkFd: number | undefined;
      try {
        checkFd = filesystem.openSync(targetPath, fs.constants.O_RDONLY | nofollow);
        const fstat = filesystem.fstatSync(checkFd);
        if (!fstat.isFile() || fstat.dev !== initialTargetStat.dev || fstat.ino !== initialTargetStat.ino) {
          throw new FileOpError('TOCTOU_MISMATCH');
        }
        verifyOwnership(fstat, expectedUid);

        // Stream compute existing hash
        const hasher = crypto.createHash('sha256');
        const chunkBuf = Buffer.alloc(64 * 1024);
        let readTotal = 0;
        while (readTotal < fstat.size) {
          const bytesRead = filesystem.readSync(checkFd, chunkBuf, 0, Math.min(chunkBuf.length, fstat.size - readTotal), readTotal);
          if (bytesRead === 0) break;
          hasher.update(chunkBuf.subarray(0, bytesRead));
          readTotal += bytesRead;
        }
        filesystem.closeSync(checkFd);
        checkFd = undefined;

        const currentEtag = `"${hasher.digest('hex').toLowerCase()}"`;
        if (!matchETag(currentEtag, expectedEtag)) {
          throw new FileOpError('PRECONDITION_FAILED');
        }
      } catch (openErr: unknown) {
        if (checkFd !== undefined) {
          try {
            filesystem.closeSync(checkFd);
          } catch {
            // Ignore close error on failure
          }
          checkFd = undefined;
        }
        if (openErr instanceof FileOpError) throw openErr;
        const code = (openErr as { code?: string })?.code;
        if (code === 'ELOOP') {
          throw new FileOpError('SYMLINK_FORBIDDEN');
        }
        throw new FileOpError('PRECONDITION_FAILED');
      }
    }

    const tempFileName = `.${path.basename(targetPath)}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    const tempPath = path.join(parentDir, tempFileName);
    const nofollow = getNoFollowFlag();

    let fd: number | undefined;
    let totalBytesWritten = 0;
    const hasher = crypto.createHash('sha256');

    try {
      fd = filesystem.openSync(
        tempPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | nofollow,
        0o600
      );

      await new Promise<void>((resolve, reject) => {
        let streamError: Error | null = null;

        inStream.on('data', (chunk: Buffer | string) => {
          if (streamError) return;
          try {
            const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
            totalBytesWritten += buf.length;
            if (totalBytesWritten > maxBytes) {
              streamError = new FileOpError('PAYLOAD_TOO_LARGE');
              if (typeof (inStream as any).destroy === 'function') {
                (inStream as any).destroy(streamError);
              }
              reject(streamError);
              return;
            }
            hasher.update(buf);
            let written = 0;
            while (written < buf.length) {
              const bytes = filesystem.writeSync(fd!, buf, written, buf.length - written, null);
              if (bytes === 0) break;
              written += bytes;
            }
          } catch (writeErr) {
            streamError = writeErr instanceof Error ? writeErr : new FileOpError('WRITE_FAILED');
            if (typeof (inStream as any).destroy === 'function') {
              (inStream as any).destroy(streamError);
            }
            reject(streamError);
          }
        });

        inStream.on('error', (err) => {
          if (!streamError) {
            streamError = err;
            reject(err);
          }
        });

        inStream.on('end', () => {
          if (!streamError) {
            resolve();
          }
        });
      });

      filesystem.fsyncSync(fd);
      filesystem.closeSync(fd);
      fd = undefined;
    } catch (writeErr: unknown) {
      if (fd !== undefined) {
        try {
          filesystem.closeSync(fd);
        } catch {
          // Ignore
        }
        fd = undefined;
      }
      try {
        filesystem.unlinkSync(tempPath);
      } catch {
        // Ignore
      }
      if (writeErr instanceof FileOpError) throw writeErr;
      throw new FileOpError('WRITE_FAILED');
    }

    if (requireAbsent) {
      try {
        filesystem.linkSync(tempPath, targetPath);
      } catch (linkErr: unknown) {
        try {
          filesystem.unlinkSync(tempPath);
        } catch {
          // Ignore
        }
        const linkCode = (linkErr as { code?: string })?.code;
        if (linkCode === 'EEXIST') {
          throw new FileOpError('PRECONDITION_FAILED');
        }
        throw new FileOpError('WRITE_FAILED');
      }

      try {
        filesystem.unlinkSync(tempPath);
      } catch {
        // Ignore
      }
    } else {
      if (targetExists && initialTargetDev !== undefined && initialTargetIno !== undefined) {
        let preRenameStat: fs.Stats;
        try {
          preRenameStat = filesystem.lstatSync(targetPath);
        } catch {
          try {
            filesystem.unlinkSync(tempPath);
          } catch {
            // Ignore
          }
          throw new FileOpError('TOCTOU_MISMATCH');
        }

        if (preRenameStat.dev !== initialTargetDev || preRenameStat.ino !== initialTargetIno) {
          try {
            filesystem.unlinkSync(tempPath);
          } catch {
            // Ignore
          }
          throw new FileOpError('TOCTOU_MISMATCH');
        }
      }

      try {
        filesystem.renameSync(tempPath, targetPath);
      } catch {
        try {
          filesystem.unlinkSync(tempPath);
        } catch {
          // Ignore
        }
        throw new FileOpError('WRITE_FAILED');
      }
    }

    let writtenStat: fs.Stats;
    try {
      writtenStat = filesystem.lstatSync(targetPath);
      if (writtenStat.isSymbolicLink()) {
        throw new FileOpError('SYMLINK_FORBIDDEN');
      }
      verifyOwnership(writtenStat, expectedUid);
    } catch (statErr: unknown) {
      if (statErr instanceof FileOpError) throw statErr;
      throw new FileOpError('WRITE_FAILED');
    }

    const newEtag = `"${hasher.digest('hex').toLowerCase()}"`;
    const { mtimeMs } = extractValidMetadata(writtenStat);

    return {
      op: 'write',
      space,
      path: normalizedPath,
      type: 'file',
      size: totalBytesWritten,
      written: true,
      encoding: 'utf8',
      mtimeMs,
      etag: newEtag,
    };
  });
}

/**
 * Executes a streaming file read operation with authoritative ETag calculation and optional HTTP Range streaming.
 */
export async function executeFileReadStream(
  options: StreamingReadOptions,
  execOptions: FileOpExecutionOptions = {}
): Promise<StreamingReadResult> {
  const space = validateSpaceName(options.space);
  const { normalizedPath, segments } = validateRelativePath(options.path);

  if (segments.length === 0 || normalizedPath === '.') {
    throw new FileOpError('INVALID_TARGET');
  }

  const spacesDir = execOptions.spacesDir || path.join(process.env.DSH_HOME || '/home/dsh', 'spaces');
  const expectedUid = execOptions.expectedUid;
  const filesystem = execOptions.fsImpl || fs;

  verifyNoSymlinksInPath(spacesDir, space, segments, expectedUid, false, filesystem);

  const targetPath = path.join(spacesDir, space, ...segments);

  let stat: fs.Stats;
  try {
    stat = filesystem.lstatSync(targetPath);
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === 'ENOENT') {
      throw new FileOpError('NOT_FOUND');
    }
    throw new FileOpError('READ_FAILED');
  }

  if (stat.isSymbolicLink()) {
    throw new FileOpError('SYMLINK_FORBIDDEN');
  }
  if (stat.isDirectory()) {
    throw new FileOpError('INVALID_TARGET');
  }
  if (!stat.isFile()) {
    throw new FileOpError('INVALID_TARGET');
  }
  verifyOwnership(stat, expectedUid);

  const nofollow = getNoFollowFlag();
  let fd: number | undefined;
  let etag: string;
  const totalSize = stat.size;

  try {
    fd = filesystem.openSync(targetPath, fs.constants.O_RDONLY | nofollow);
    const fstat = filesystem.fstatSync(fd);
    if (!fstat.isFile() || fstat.dev !== stat.dev || fstat.ino !== stat.ino) {
      throw new FileOpError('TOCTOU_MISMATCH');
    }
    verifyOwnership(fstat, expectedUid);

    // Compute whole file ETag
    const hasher = crypto.createHash('sha256');
    const chunkBuf = Buffer.alloc(64 * 1024);
    let readTotal = 0;
    while (readTotal < fstat.size) {
      const bytesRead = filesystem.readSync(fd, chunkBuf, 0, Math.min(chunkBuf.length, fstat.size - readTotal), readTotal);
      if (bytesRead === 0) break;
      hasher.update(chunkBuf.subarray(0, bytesRead));
      readTotal += bytesRead;
    }
    filesystem.closeSync(fd);
    fd = undefined;

    etag = `"${hasher.digest('hex').toLowerCase()}"`;
  } catch (err: unknown) {
    if (fd !== undefined) {
      try {
        filesystem.closeSync(fd);
      } catch {
        // Ignore
      }
      fd = undefined;
    }
    if (err instanceof FileOpError) throw err;
    throw new FileOpError('READ_FAILED');
  }

  let range = options.range;
  let streamStart = 0;
  let streamEnd = totalSize > 0 ? totalSize - 1 : 0;

  if (range) {
    if (
      typeof range.start !== 'number' ||
      typeof range.end !== 'number' ||
      range.start < 0 ||
      range.end < range.start ||
      range.start >= totalSize ||
      range.end >= totalSize
    ) {
      throw new FileOpError('INVALID_REQUEST');
    }
    streamStart = range.start;
    streamEnd = range.end;
  }

  const readStream = totalSize === 0
    ? fs.createReadStream(targetPath, { start: 0, end: 0 })
    : (fs as any).createReadStream(targetPath, range ? { start: streamStart, end: streamEnd } : undefined);

  const streamSize = totalSize === 0 ? 0 : (range ? streamEnd - streamStart + 1 : totalSize);
  const { mtimeMs } = extractValidMetadata(stat);

  return {
    op: 'read',
    space,
    path: normalizedPath,
    type: 'file',
    size: streamSize,
    totalSize,
    mtimeMs,
    etag,
    range: range ? { start: streamStart, end: streamEnd } : undefined,
    stream: readStream,
  };
}

// ---------------------------------------------------------------------------
// Authoritative Instructions File Operations (Global $DSH_HOME & Space AGENTS/CLAUDE)
// ---------------------------------------------------------------------------

export interface InstructionsExecutionOptions {
  readonly spacesDir: string;
  readonly dshHome: string;
  readonly expectedUid?: number;
}

export function validateInstructionsTargetAndFilename(
  target: string,
  spaceFolder?: string,
  rawFilename?: string
): { target: 'global' | 'space'; filename: 'AGENTS.md' | 'CLAUDE.md'; spaceFolder?: string } {
  if (target !== 'global' && target !== 'space') {
    throw new FileOpError('INVALID_REQUEST');
  }

  if (target === 'global') {
    if (rawFilename !== undefined && rawFilename !== null && rawFilename !== '' && rawFilename !== 'AGENTS.md') {
      throw new FileOpError('INVALID_REQUEST');
    }
    return { target: 'global', filename: 'AGENTS.md' };
  }

  // target === 'space'
  if (!spaceFolder || typeof spaceFolder !== 'string' || !SPACE_NAME_REGEX.test(spaceFolder)) {
    throw new FileOpError('INVALID_SPACE');
  }

  let filename: 'AGENTS.md' | 'CLAUDE.md' = 'AGENTS.md';
  if (rawFilename !== undefined && rawFilename !== null && rawFilename !== '') {
    if (typeof rawFilename !== 'string') {
      throw new FileOpError('INVALID_REQUEST');
    }
    const trimmed = rawFilename.trim().normalize('NFC');
    if (trimmed !== 'AGENTS.md' && trimmed !== 'CLAUDE.md') {
      throw new FileOpError('INVALID_REQUEST');
    }
    filename = trimmed;
  }

  return { target: 'space', filename, spaceFolder };
}

/**
 * Authoritative Read for global or space instructions with O_NOFOLLOW, UID check,
 * UTF-8 NFC normalization, size bounds, and null ETag on non-existent file.
 */
export function executeInstructionsRead(
  request: {
    readonly target: 'global' | 'space';
    readonly spaceFolder?: string;
    readonly filename?: string;
  },
  options: InstructionsExecutionOptions
): {
  content: string;
  etag: string | null;
  exists: boolean;
  size: number;
  mtimeMs: number;
  target: 'global' | 'space';
  filename: 'AGENTS.md' | 'CLAUDE.md';
} {
  const { target, filename, spaceFolder } = validateInstructionsTargetAndFilename(
    request.target,
    request.spaceFolder,
    request.filename
  );

  const maxSize = target === 'global' ? MAX_GLOBAL_INSTRUCTIONS_BYTES : MAX_SPACE_INSTRUCTIONS_BYTES;
  const targetPath = target === 'global'
    ? path.join(options.dshHome, 'AGENTS.md')
    : path.join(options.spacesDir, spaceFolder!, filename);

  const expectedUid = options.expectedUid ?? (typeof process.getuid === 'function' ? process.getuid() : 1000);

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(targetPath);
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === 'ENOENT') {
      return {
        content: '',
        etag: null,
        exists: false,
        size: 0,
        mtimeMs: 0,
        target,
        filename,
      };
    }
    throw new FileOpError('READ_FAILED');
  }

  if (stat.isSymbolicLink()) {
    throw new FileOpError('SYMLINK_FORBIDDEN');
  }
  if (!stat.isFile()) {
    throw new FileOpError('INVALID_TARGET');
  }
  verifyOwnership(stat, expectedUid);

  if (stat.size > maxSize) {
    throw new FileOpError('FILE_TOO_LARGE');
  }

  const nofollow = getNoFollowFlag();
  let fd: number | undefined;
  try {
    fd = fs.openSync(targetPath, fs.constants.O_RDONLY | nofollow);
    const fstat = fs.fstatSync(fd);
    if (!fstat.isFile()) {
      throw new FileOpError('INVALID_TARGET');
    }
    verifyOwnership(fstat, expectedUid);

    if (fstat.dev !== stat.dev || fstat.ino !== stat.ino) {
      throw new FileOpError('TOCTOU_MISMATCH');
    }

    if (fstat.size > maxSize) {
      throw new FileOpError('FILE_TOO_LARGE');
    }

    const { mtimeMs } = extractValidMetadata(fstat);

    const buf = Buffer.alloc(fstat.size);
    let bytesRead = 0;
    while (bytesRead < fstat.size) {
      const chunk = fs.readSync(fd, buf, bytesRead, fstat.size - bytesRead, bytesRead);
      if (chunk === 0) break;
      bytesRead += chunk;
    }

    fs.closeSync(fd);
    fd = undefined;

    const finalBuf = bytesRead === fstat.size ? buf : buf.subarray(0, bytesRead);
    const rawContent = finalBuf.toString('utf8');
    const normalizedContent = rawContent.normalize('NFC');
    const normalizedBuf = Buffer.from(normalizedContent, 'utf8');
    const etag = computeFileETag(normalizedBuf);

    return {
      content: normalizedContent,
      etag,
      exists: true,
      size: normalizedBuf.length,
      mtimeMs,
      target,
      filename,
    };
  } catch (err: unknown) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
      fd = undefined;
    }
    if (err instanceof FileOpError) throw err;
    const code = (err as { code?: string })?.code;
    if (code === 'ELOOP') {
      throw new FileOpError('SYMLINK_FORBIDDEN');
    }
    throw new FileOpError('READ_FAILED');
  }
}

/**
 * Authoritative Atomic Write for global or space instructions with O_NOFOLLOW, UID check,
 * UTF-8 NFC normalization, size bounds, atomic temp/fsync/rename, and ETag CAS.
 */
export function executeInstructionsWrite(
  request: {
    readonly target: 'global' | 'space';
    readonly content: string;
    readonly spaceFolder?: string;
    readonly filename?: string;
    readonly expectedEtag?: string | null;
    readonly requireAbsent?: boolean;
  },
  options: InstructionsExecutionOptions
): {
  etag: string;
  size: number;
  mtimeMs: number;
  target: 'global' | 'space';
  filename: 'AGENTS.md' | 'CLAUDE.md';
} {
  const { target, filename, spaceFolder } = validateInstructionsTargetAndFilename(
    request.target,
    request.spaceFolder,
    request.filename
  );

  const maxSize = target === 'global' ? MAX_GLOBAL_INSTRUCTIONS_BYTES : MAX_SPACE_INSTRUCTIONS_BYTES;
  const parentDir = target === 'global'
    ? options.dshHome
    : path.join(options.spacesDir, spaceFolder!);
  const targetPath = path.join(parentDir, filename);

  const expectedUid = options.expectedUid ?? (typeof process.getuid === 'function' ? process.getuid() : 1000);

  if (typeof request.content !== 'string') {
    throw new FileOpError('INVALID_PAYLOAD');
  }

  const normalizedContent = request.content.normalize('NFC');
  const payloadBuffer = Buffer.from(normalizedContent, 'utf8');

  if (payloadBuffer.length > maxSize) {
    throw new FileOpError('PAYLOAD_TOO_LARGE');
  }

  // Ensure parent directory exists
  fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  const parentStat = fs.lstatSync(parentDir);
  if (parentStat.isSymbolicLink()) {
    throw new FileOpError('SYMLINK_FORBIDDEN');
  }
  if (!parentStat.isDirectory()) {
    throw new FileOpError('INVALID_TARGET');
  }
  verifyOwnership(parentStat, expectedUid);

  const requireAbsent = request.requireAbsent === true || request.expectedEtag === null;
  const expectedEtag = typeof request.expectedEtag === 'string' ? request.expectedEtag : undefined;

  if (expectedEtag !== undefined && !isValidETag(expectedEtag)) {
    throw new FileOpError('INVALID_REQUEST');
  }

  // Check current target file
  let existing = false;
  let currentEtag: string | null = null;
  let initialTargetStat: fs.Stats | undefined;

  try {
    initialTargetStat = fs.lstatSync(targetPath);
    existing = true;
    if (initialTargetStat.isSymbolicLink()) {
      throw new FileOpError('SYMLINK_FORBIDDEN');
    }
    if (!initialTargetStat.isFile()) {
      throw new FileOpError('INVALID_TARGET');
    }
    verifyOwnership(initialTargetStat, expectedUid);

    const nofollow = getNoFollowFlag();
    let checkFd: number | undefined;
    try {
      checkFd = fs.openSync(targetPath, fs.constants.O_RDONLY | nofollow);
      const checkFstat = fs.fstatSync(checkFd);
      if (!checkFstat.isFile()) {
        throw new FileOpError('INVALID_TARGET');
      }
      verifyOwnership(checkFstat, expectedUid);
      if (checkFstat.dev !== initialTargetStat.dev || checkFstat.ino !== initialTargetStat.ino) {
        throw new FileOpError('TOCTOU_MISMATCH');
      }

      const existingBuf = Buffer.alloc(checkFstat.size);
      let r = 0;
      while (r < checkFstat.size) {
        const chunk = fs.readSync(checkFd, existingBuf, r, checkFstat.size - r, r);
        if (chunk === 0) break;
        r += chunk;
      }
      fs.closeSync(checkFd);
      checkFd = undefined;

      const normExisting = existingBuf.subarray(0, r).toString('utf8').normalize('NFC');
      currentEtag = computeFileETag(Buffer.from(normExisting, 'utf8'));
    } catch (readErr: unknown) {
      if (checkFd !== undefined) {
        try { fs.closeSync(checkFd); } catch {}
      }
      if (readErr instanceof FileOpError) throw readErr;
      throw new FileOpError('READ_FAILED');
    }
  } catch (err: unknown) {
    if (err instanceof FileOpError) throw err;
    const code = (err as { code?: string })?.code;
    if (code === 'ENOENT') {
      existing = false;
      currentEtag = null;
    } else {
      throw new FileOpError('WRITE_FAILED');
    }
  }

  // Precondition validations
  if (requireAbsent && existing) {
    throw new FileOpError('PRECONDITION_FAILED');
  }
  if (expectedEtag !== undefined) {
    if (!existing || currentEtag !== expectedEtag) {
      throw new FileOpError('PRECONDITION_FAILED');
    }
  }

  // Atomic write using temp file + fsync + rename
  const nofollow = getNoFollowFlag();
  const randomSuffix = crypto.randomBytes(6).toString('hex');
  const tempPath = path.join(parentDir, `.${filename}.${Date.now()}.${randomSuffix}.tmp`);
  let tempFd: number | undefined;

  try {
    tempFd = fs.openSync(
      tempPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | nofollow,
      0o600
    );
    const tempFstat = fs.fstatSync(tempFd);
    verifyOwnership(tempFstat, expectedUid);

    let bytesWritten = 0;
    while (bytesWritten < payloadBuffer.length) {
      const chunk = fs.writeSync(
        tempFd,
        payloadBuffer,
        bytesWritten,
        payloadBuffer.length - bytesWritten,
        bytesWritten
      );
      if (chunk === 0) break;
      bytesWritten += chunk;
    }

    if (bytesWritten !== payloadBuffer.length) {
      throw new FileOpError('WRITE_FAILED');
    }

    fs.fsyncSync(tempFd);
    fs.closeSync(tempFd);
    tempFd = undefined;

    fs.renameSync(tempPath, targetPath);

    const resultStat = fs.statSync(targetPath);
    const resultEtag = computeFileETag(payloadBuffer);

    return {
      etag: resultEtag,
      size: payloadBuffer.length,
      mtimeMs: resultStat.mtimeMs,
      target,
      filename,
    };
  } catch (err: unknown) {
    if (tempFd !== undefined) {
      try {
        fs.closeSync(tempFd);
      } catch {}
      tempFd = undefined;
    }
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {}

    if (err instanceof FileOpError) throw err;
    throw new FileOpError('WRITE_FAILED');
  }
}
