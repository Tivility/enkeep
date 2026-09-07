/**
 * Cryptographic Metadata Signing and Secrets Management
 *
 * Ensures all demo secrets (metaSecret, cookieSecret, csrfToken) are generated
 * with cryptographically secure random bytes, persisted exclusively in `<dataRoot>/secrets.json`
 * with strict POSIX mode 0o600 and parent directory 0o700, schemaVersion=1,
 * 3 distinct lowercase 64-hex strings, atomic file creation (O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW),
 * regular file owner verification, authoritative FD containment, and dataRoot-keyed in-memory caching.
 *
 * @module @enkeep/demo-runner/utils/crypto-meta
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  unlinkSync,
  readdirSync,
  lstatSync,
  fstatSync,
  chmodSync,
  fchmodSync,
  constants,
  openSync,
  readSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
} from 'node:fs';
import { join, normalize, resolve, dirname, relative, isAbsolute } from 'node:path';
import {
  DEMO_OWNERSHIP_TAG,
  DEMO_CONTAINER_PREFIX,
  DEMO_VOLUME_PREFIX,
  DEMO_LABEL_KEY,
  DEMO_LABEL_VALUE,
  USER_LABEL_KEY,
  RUN_ID_LABEL_KEY,
  VOLUME_ID_LABEL_KEY,
  getDemoPathConfig,
  assertPathInDemoData,
} from '../config.js';
import type {
  SignedProcessMetadata,
  SignedContainerMetadata,
  SignedVolumeMetadata,
  DemoPathOptions,
} from '../types.js';

export interface DemoSecrets {
  schemaVersion: 1;
  metaSecret: string;
  cookieSecret: string;
  csrfToken: string;
  createdAt: string;
}

export const HEX_64_REGEX = /^[0-9a-f]{64}$/;
export const CONTAINER_ID_64_REGEX = /^[0-9a-f]{64}$/;
export const RUN_ID_REGEX = /^run_[a-zA-Z0-9_-]{1,64}$/;
export const VOLUME_ID_REGEX = /^vol_[a-zA-Z0-9_-]{1,64}$/;

const secretsCache = new Map<string, DemoSecrets>();

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function getErrnoCode(err: unknown): string | undefined {
  if (isRecord(err) && 'code' in err) {
    const code = err['code'];
    if (typeof code === 'string') return code;
    if (typeof code === 'number') return String(code);
  }
  return undefined;
}

/**
 * Verified cleanup of a temporary file by exact expected device and inode.
 * Returns Error if verification or unlinking fails with a non-ENOENT error; returns null on clean removal or absent file.
 */
export function cleanupExactTemp(tmpPath: string, tmpDev?: number, tmpIno?: number): Error | null {
  if (tmpDev === undefined || tmpIno === undefined) {
    return null;
  }
  try {
    const tmpCheck = lstatSync(tmpPath);
    if (tmpCheck.isSymbolicLink()) {
      return new Error(`Safety Violation: Temporary file "${tmpPath}" is a symlink! Refusing to unlink.`);
    }
    if (!tmpCheck.isFile()) {
      return new Error(`Safety Violation: Temporary path "${tmpPath}" is not a regular file!`);
    }
    if (tmpCheck.dev !== tmpDev || tmpCheck.ino !== tmpIno) {
      return new Error(
        `Safety Violation: Temporary file "${tmpPath}" inode/device mismatch (expected ${tmpDev}:${tmpIno}, got ${tmpCheck.dev}:${tmpCheck.ino}). Refusing to unlink.`
      );
    }
    unlinkSync(tmpPath);
    return null;
  } catch (err: unknown) {
    const code = getErrnoCode(err);
    if (code === 'ENOENT') {
      return null;
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Validates ISO 8601 date string format strictly and canonically.
 * Requires exact canonical equality: new Date(str).toISOString() === str.
 */
export function isValidIsoDate(str: string): boolean {
  if (typeof str !== 'string' || !str) return false;
  try {
    const d = new Date(str);
    return !isNaN(d.getTime()) && d.toISOString() === str;
  } catch {
    return false;
  }
}

/**
 * Verifies that no parent ancestor directory between filePath and dataRoot is a symlink.
 * Uses exact relative containment segment validation.
 */
export function assertNoSymlinkAncestors(targetPath: string, dataRoot: string): void {
  const normTarget = normalize(resolve(targetPath));
  const normDataRoot = normalize(resolve(dataRoot));
  const rel = relative(normDataRoot, normTarget);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Safety Violation: Target path "${targetPath}" is outside data root "${dataRoot}"!`);
  }

  try {
    const rootStat = lstatSync(normDataRoot);
    if (rootStat.isSymbolicLink()) {
      throw new Error(`Safety Violation: Data root directory "${normDataRoot}" is a symlink!`);
    }
    if (!rootStat.isDirectory()) {
      throw new Error(`Safety Violation: Data root path "${normDataRoot}" is not a directory!`);
    }
  } catch (err: unknown) {
    const code = getErrnoCode(err);
    if (code !== 'ENOENT') {
      throw err;
    }
  }

  let current = dirname(normTarget);
  while (current && current !== normDataRoot) {
    const curRel = relative(normDataRoot, current);
    if (curRel.startsWith('..') || isAbsolute(curRel)) break;
    try {
      const lstat = lstatSync(current);
      if (lstat.isSymbolicLink()) {
        throw new Error(`Safety Violation: Symlink ancestor detected at "${current}"!`);
      }
      if (!lstat.isDirectory()) {
        throw new Error(`Safety Violation: Ancestor path "${current}" is not a directory!`);
      }
    } catch (err: unknown) {
      const code = getErrnoCode(err);
      if (code !== 'ENOENT') {
        throw err;
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export interface ReadSecureJsonOptions {
  options?: DemoPathOptions | string;
  expectedMode?: number;
  maxSizeBytes?: number;
}

export class FileNotFoundError extends Error {
  readonly code = 'ENOENT';
  constructor(message: string) {
    super(message);
    this.name = 'FileNotFoundError';
  }
}

/**
 * Securely reads and parses a JSON file via authoritative file descriptor (O_RDONLY | O_NOFOLLOW),
 * performing fstat checks (regular file, owner UID, mode, size bound) and post-open lstat containment.
 */
export function readSecureJsonFile<T>(filePath: string, opts?: ReadSecureJsonOptions): T {
  const paths = getDemoPathConfig(opts?.options);
  assertPathInDemoData(filePath, opts?.options);
  assertNoSymlinkAncestors(filePath, paths.dataRoot);

  let initialLstat;
  try {
    initialLstat = lstatSync(filePath);
  } catch (err: unknown) {
    const code = getErrnoCode(err);
    if (code === 'ENOENT') {
      throw new FileNotFoundError(`FAIL-CLOSED: File does not exist at "${filePath}".`);
    }
    throw new Error(
      `FAIL-CLOSED: Failed to inspect file at "${filePath}": ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  if (initialLstat.isSymbolicLink()) {
    throw new Error(`Safety Violation: File at "${filePath}" is a symlink! Refusing to read.`);
  }

  if (!initialLstat.isFile()) {
    throw new Error(`Safety Violation: Target at "${filePath}" is not a regular file!`);
  }

  let fd: number | null = null;
  let rawContent = '';
  let openedStat;

  try {
    const openFlags = constants.O_RDONLY | constants.O_NOFOLLOW;
    fd = openSync(filePath, openFlags);
    openedStat = fstatSync(fd);

    if (!openedStat.isFile()) {
      throw new Error(`Safety Violation: Opened descriptor for "${filePath}" is not a regular file.`);
    }

    if (typeof process.getuid === 'function' && openedStat.uid !== process.getuid()) {
      throw new Error(
        `Safety Violation: File owner UID ${openedStat.uid} does not match current process UID ${process.getuid()}`
      );
    }

    const mode = openedStat.mode & 0o777;
    if (opts?.expectedMode !== undefined) {
      if (mode !== opts.expectedMode) {
        throw new Error(
          `Safety Violation: File permissions are ${mode.toString(8)}. Expected exact ${opts.expectedMode.toString(8)}.`
        );
      }
    } else {
      if ((mode & 0o077) !== 0) {
        throw new Error(
          `Safety Violation: File permissions are too permissive (${mode.toString(8)}). Expected owner-only access.`
        );
      }
    }

    const maxSize = opts?.maxSizeBytes ?? 1024 * 1024;
    if (openedStat.size > maxSize) {
      throw new Error(
        `Safety Violation: File size ${openedStat.size} bytes exceeds maximum allowed limit of ${maxSize} bytes.`
      );
    }
    if (openedStat.size < 2) {
      throw new Error(`FAIL-CLOSED: File at "${filePath}" is too small or empty (${openedStat.size} bytes).`);
    }

    // Post-open containment / TOCTOU check: lstat-after exact check
    const postLstat = lstatSync(filePath);
    if (postLstat.isSymbolicLink()) {
      throw new Error(`Safety Violation: File swapped to a symlink after open at "${filePath}".`);
    }
    if (postLstat.ino !== openedStat.ino || postLstat.dev !== openedStat.dev) {
      throw new Error(`Safety Violation: Inode/dev mismatch after open at "${filePath}" (possible TOCTOU attack).`);
    }

    const buf = Buffer.alloc(openedStat.size);
    let bytesRead = 0;
    while (bytesRead < openedStat.size) {
      const readCount = readSync(fd, buf, bytesRead, openedStat.size - bytesRead, bytesRead);
      if (readCount === 0) break;
      bytesRead += readCount;
    }
    rawContent = buf.toString('utf-8', 0, bytesRead);
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch (closeErr: unknown) {
        const msg = closeErr instanceof Error ? closeErr.message : String(closeErr);
        throw new Error(`FAIL-CLOSED: Failed to close file descriptor for "${filePath}": ${msg}`);
      }
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch (parseErr: unknown) {
    const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
    throw new Error(`FAIL-CLOSED: Corrupted JSON in "${filePath}": ${msg}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`FAIL-CLOSED: Invalid JSON root structure in "${filePath}". Must be non-null object.`);
  }

  return parsed as T;
}

/**
 * Securely writes JSON data to a file using an atomic temporary file with
 * O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, strict 0o600 permissions, fsync,
 * UID ownership verification, parent directory non-symlink checks, parent/target
 * inode snapshot validation against TOCTOU swaps, and atomic rename with parent dir fsync.
 */
export interface WriteSecureJsonOptions {
  options?: DemoPathOptions | string;
  expectedMode?: number;
  allowExistingTarget?: boolean;
  maxSizeBytes?: number;
}

/**
 * Securely writes JSON metadata to a file using atomic write + verified rename.
 * Creates a unique temp file with openSync (O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW),
 * enforces fchmod on descriptor, fstat verifies regular file / UID / dev/ino, writes buffer loop,
 * fsyncs temp file, aggregates close error, wraps all pre-commit validation in try-catch with cleanupExactTemp on error,
 * atomically renames, validates post-rename inode / UID / mode, and fsyncs parent directory descriptor.
 */
export function writeSecureJsonFile(
  filePath: string,
  data: unknown,
  opts?: WriteSecureJsonOptions | DemoPathOptions | string,
  legacyExpectedMode = 0o600
): void {
  const optionsObj: WriteSecureJsonOptions =
    opts && typeof opts === 'object' && ('options' in opts || 'expectedMode' in opts || 'allowExistingTarget' in opts || 'maxSizeBytes' in opts)
      ? (opts as WriteSecureJsonOptions)
      : { options: opts as (DemoPathOptions | string | undefined), expectedMode: legacyExpectedMode };

  const pathOpts = optionsObj.options;
  const expectedMode = optionsObj.expectedMode ?? legacyExpectedMode ?? 0o600;
  const allowExistingTarget = optionsObj.allowExistingTarget ?? true;
  const maxSizeBytes = optionsObj.maxSizeBytes ?? 1024 * 1024; // 1 MiB limit

  const paths = getDemoPathConfig(pathOpts);
  assertPathInDemoData(filePath, pathOpts);
  assertNoSymlinkAncestors(filePath, paths.dataRoot);

  const parentDir = dirname(filePath);
  try {
    mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  } catch (err: unknown) {
    const code = getErrnoCode(err);
    if (code !== 'EEXIST') {
      throw err;
    }
  }

  // Authoritative directory verification via file descriptor (no path chmod TOCTOU)
  const pOpenFlags = constants.O_RDONLY | constants.O_NOFOLLOW;
  let pFd: number | null = null;
  let parentDev: number;
  let parentIno: number;
  try {
    pFd = openSync(parentDir, pOpenFlags);
    fchmodSync(pFd, 0o700);
    const pStat = fstatSync(pFd);
    if (pStat.isSymbolicLink() || !pStat.isDirectory()) {
      throw new Error(`Safety Violation: Parent directory "${parentDir}" is not a regular directory!`);
    }
    if (typeof process.getuid === 'function' && pStat.uid !== process.getuid()) {
      throw new Error(`Safety Violation: Parent directory "${parentDir}" owner UID mismatch.`);
    }
    parentDev = pStat.dev;
    parentIno = pStat.ino;
  } finally {
    if (pFd !== null) {
      try {
        closeSync(pFd);
      } catch (closeErr: unknown) {
        throw new Error(
          `FAIL-CLOSED: Failed to close parent directory descriptor for "${parentDir}": ${
            closeErr instanceof Error ? closeErr.message : String(closeErr)
          }`
        );
      }
    }
  }

  // Snapshot target state if it already exists
  let targetExisted = false;
  let targetDev: number | undefined;
  let targetIno: number | undefined;

  try {
    const targetLstat = lstatSync(filePath);
    if (targetLstat.isSymbolicLink()) {
      throw new Error(`Safety Violation: Target file "${filePath}" is a symlink! Refusing to overwrite.`);
    }
    if (!targetLstat.isFile()) {
      throw new Error(`Safety Violation: Target file "${filePath}" is not a regular file!`);
    }
    if (typeof process.getuid === 'function' && targetLstat.uid !== process.getuid()) {
      throw new Error(
        `Safety Violation: Target file "${filePath}" owner UID ${targetLstat.uid} does not match process UID ${process.getuid()}.`
      );
    }
    if (!allowExistingTarget) {
      throw new Error(
        `FAIL-CLOSED: Target file "${filePath}" already exists and allowExistingTarget is false (refusing overwrite/collision).`
      );
    }
    targetExisted = true;
    targetDev = targetLstat.dev;
    targetIno = targetLstat.ino;
  } catch (err: unknown) {
    const code = getErrnoCode(err);
    if (code !== 'ENOENT') {
      throw err;
    }
  }

  // Serialize and validate JSON bounds
  const serialized = JSON.stringify(data, null, 2);
  if (typeof serialized !== 'string') {
    throw new Error(`FAIL-CLOSED: Data serialization for "${filePath}" failed or returned non-string.`);
  }

  const buf = Buffer.from(serialized, 'utf-8');
  if (buf.length > maxSizeBytes) {
    throw new Error(
      `FAIL-CLOSED: Serialized data size ${buf.length} bytes exceeds maximum limit of ${maxSizeBytes} bytes for "${filePath}".`
    );
  }

  const tmpPath = `${filePath}.tmp.${randomBytes(8).toString('hex')}`;
  const openFlags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;
  let fd: number | null = null;
  let tmpDev: number | undefined;
  let tmpIno: number | undefined;
  let writeError: Error | null = null;

  try {
    fd = openSync(tmpPath, openFlags, expectedMode);
    fchmodSync(fd, expectedMode);
    const fdStat = fstatSync(fd);
    if (!fdStat.isFile() || fdStat.isSymbolicLink()) {
      throw new Error(`Safety Violation: Temporary file "${tmpPath}" is not a regular file.`);
    }
    if (typeof process.getuid === 'function' && fdStat.uid !== process.getuid()) {
      throw new Error(
        `Safety Violation: Temporary file "${tmpPath}" owner UID ${fdStat.uid} does not match process UID ${process.getuid()}.`
      );
    }
    const mode = fdStat.mode & 0o777;
    if (mode !== expectedMode) {
      throw new Error(
        `Safety Violation: Temporary file "${tmpPath}" mode is ${mode.toString(8)}, expected ${expectedMode.toString(8)}.`
      );
    }
    tmpDev = fdStat.dev;
    tmpIno = fdStat.ino;

    let bytesWritten = 0;
    while (bytesWritten < buf.length) {
      const written = writeSync(fd, buf, bytesWritten, buf.length - bytesWritten, null);
      if (written <= 0) {
        throw new Error(`FAIL-CLOSED: writeSync returned 0 bytes while writing "${tmpPath}".`);
      }
      bytesWritten += written;
    }
    fsyncSync(fd);
  } catch (err: unknown) {
    writeError = err instanceof Error ? err : new Error(String(err));
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch (closeErr: unknown) {
        const closeError = closeErr instanceof Error ? closeErr : new Error(String(closeErr));
        if (writeError) {
          writeError = new AggregateError(
            [writeError, closeError],
            `FAIL-CLOSED: Failed writing and closing temporary metadata file "${tmpPath}"`
          );
        } else {
          writeError = closeError;
        }
      }
    }
  }

  if (writeError) {
    const cleanupErr = cleanupExactTemp(tmpPath, tmpDev, tmpIno);
    if (cleanupErr) {
      writeError = new AggregateError(
        [writeError, cleanupErr],
        `FAIL-CLOSED: Failed to write temporary metadata file "${tmpPath}" and failed temp cleanup: ${cleanupErr.message}`
      );
    }
    throw writeError;
  }

  // Pre-commit validation: Recheck parent directory, target file, and temp file
  // Wrapped in try-catch to ensure temp file cleanup on ANY validation failure
  try {
    const parentRecheck = lstatSync(parentDir);
    if (
      parentRecheck.isSymbolicLink() ||
      !parentRecheck.isDirectory() ||
      parentRecheck.dev !== parentDev ||
      parentRecheck.ino !== parentIno
    ) {
      throw new Error(`Safety Violation: Parent directory "${parentDir}" was modified or swapped before commit!`);
    }
    if (typeof process.getuid === 'function' && parentRecheck.uid !== process.getuid()) {
      throw new Error(`Safety Violation: Parent directory "${parentDir}" UID mismatch before commit.`);
    }

    let targetRecheck = null;
    try {
      targetRecheck = lstatSync(filePath);
    } catch (err: unknown) {
      const code = getErrnoCode(err);
      if (code !== 'ENOENT') {
        throw err;
      }
    }

    if (targetExisted) {
      if (!targetRecheck || targetRecheck.dev !== targetDev || targetRecheck.ino !== targetIno) {
        throw new Error(`Safety Violation: Target file "${filePath}" was modified or swapped before commit!`);
      }
      if (targetRecheck.isSymbolicLink() || !targetRecheck.isFile()) {
        throw new Error(`Safety Violation: Target file "${filePath}" is no longer a regular file before commit!`);
      }
    } else {
      if (targetRecheck !== null) {
        throw new Error(`Safety Violation: Target file "${filePath}" appeared unexpectedly before commit!`);
      }
    }

    const tmpRecheck = lstatSync(tmpPath);
    if (
      tmpRecheck.isSymbolicLink() ||
      !tmpRecheck.isFile() ||
      tmpRecheck.dev !== tmpDev ||
      tmpRecheck.ino !== tmpIno
    ) {
      throw new Error(`Safety Violation: Temporary file "${tmpPath}" was modified or swapped before commit!`);
    }

    // Commit atomic rename
    renameSync(tmpPath, filePath);
  } catch (precommitErr: unknown) {
    const primary = precommitErr instanceof Error ? precommitErr : new Error(String(precommitErr));
    const cleanupErr = cleanupExactTemp(tmpPath, tmpDev, tmpIno);
    if (cleanupErr) {
      throw new AggregateError(
        [primary, cleanupErr],
        `FAIL-CLOSED: Pre-commit/rename validation failed for "${filePath}" and temp cleanup failed: ${primary.message}`
      );
    }
    throw primary;
  }

  // Post-rename target verification: exact dev/ino, regular file, no symlink, UID match, expected mode
  let postStat: ReturnType<typeof lstatSync>;
  try {
    postStat = lstatSync(filePath);
  } catch (err: unknown) {
    throw new Error(
      `FAIL-CLOSED: Target file "${filePath}" disappeared immediately after atomic commit: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  if (postStat.isSymbolicLink() || !postStat.isFile() || postStat.dev !== tmpDev || postStat.ino !== tmpIno) {
    throw new Error(`Safety Violation: Target file "${filePath}" was modified or swapped immediately after atomic commit!`);
  }
  if (typeof process.getuid === 'function' && postStat.uid !== process.getuid()) {
    throw new Error(`Safety Violation: Target file "${filePath}" owner UID mismatch immediately after atomic commit.`);
  }
  const postMode = postStat.mode & 0o777;
  if (postMode !== expectedMode) {
    throw new Error(
      `Safety Violation: Target file "${filePath}" mode is ${postMode.toString(8)}, expected ${expectedMode.toString(8)}.`
    );
  }

  // Fsync parent directory to ensure directory entry persistence (fails loud on error)
  let parentFd: number | null = null;
  let fsyncError: Error | null = null;
  try {
    parentFd = openSync(parentDir, pOpenFlags);
    const pstat = fstatSync(parentFd);
    if (pstat.isSymbolicLink() || !pstat.isDirectory() || pstat.dev !== parentDev || pstat.ino !== parentIno) {
      throw new Error(`Safety Violation: Parent directory descriptor "${parentDir}" was swapped before fsync!`);
    }
    fsyncSync(parentFd);
  } catch (err: unknown) {
    fsyncError = err instanceof Error ? err : new Error(String(err));
  } finally {
    if (parentFd !== null) {
      try {
        closeSync(parentFd);
      } catch (closeErr: unknown) {
        const closeError = closeErr instanceof Error ? closeErr : new Error(String(closeErr));
        if (fsyncError) {
          fsyncError = new AggregateError([fsyncError, closeError], `Failed to fsync and close parent directory "${parentDir}"`);
        } else {
          fsyncError = closeError;
        }
      }
    }
  }

  if (fsyncError) {
    throw new Error(
      `FAIL-CLOSED: Failed to fsync parent directory "${parentDir}" after committing metadata file: ${fsyncError.message}`
    );
  }
}

/**
 * Resets cached in-memory secrets for a specific dataRoot or all roots.
 */
export function resetCachedSecrets(options?: DemoPathOptions | string): void {
  if (options) {
    const paths = getDemoPathConfig(options);
    secretsCache.delete(paths.dataRoot);
  } else {
    secretsCache.clear();
  }
}

/**
 * Alias for resetCachedSecrets for test compatibility.
 */
export function resetSessionMetaSecret(options?: DemoPathOptions | string): void {
  resetCachedSecrets(options);
}

/**
 * Validates an existing secrets.json file on disk with strict checks.
 */
export function validateSecretsFile(secretsPath: string, options?: DemoPathOptions | string): DemoSecrets {
  const paths = getDemoPathConfig(options);
  assertPathInDemoData(secretsPath, options);

  const record = readSecureJsonFile<Record<string, unknown>>(secretsPath, {
    options,
    expectedMode: 0o600,
  });

  if (record['schemaVersion'] !== 1) {
    throw new Error(`FAIL-CLOSED: Invalid secrets.json schemaVersion: expected exact 1, got ${record['schemaVersion']}`);
  }

  const metaSecret = record['metaSecret'];
  const cookieSecret = record['cookieSecret'];
  const csrfToken = record['csrfToken'];
  const createdAt = record['createdAt'];

  if (
    typeof metaSecret !== 'string' ||
    typeof cookieSecret !== 'string' ||
    typeof csrfToken !== 'string' ||
    !HEX_64_REGEX.test(metaSecret) ||
    !HEX_64_REGEX.test(cookieSecret) ||
    !HEX_64_REGEX.test(csrfToken)
  ) {
    throw new Error(
      'FAIL-CLOSED: secrets.json must contain metaSecret, cookieSecret, and csrfToken as 64 lowercase hex characters.'
    );
  }

  if (
    metaSecret === cookieSecret ||
    metaSecret === csrfToken ||
    cookieSecret === csrfToken
  ) {
    throw new Error('FAIL-CLOSED: secrets.json secrets must be distinct and non-colliding.');
  }

  if (typeof createdAt !== 'string' || !isValidIsoDate(createdAt)) {
    throw new Error(`FAIL-CLOSED: secrets.json createdAt must be a valid ISO 8601 timestamp.`);
  }

  const validated: DemoSecrets = {
    schemaVersion: 1,
    metaSecret,
    cookieSecret,
    csrfToken,
    createdAt,
  };

  secretsCache.set(paths.dataRoot, validated);
  return validated;
}

/**
 * Generates fresh cryptographic secrets and safely writes them to `<dataRoot>/secrets.json`
 * with mode 0o600, parent 0o700, using atomic writeSecureJsonFile.
 * Refuses to overwrite existing secrets unless overwrite=true is explicitly passed.
 */
export function generateAndSaveSecrets(options?: DemoPathOptions | string, overwrite = false): DemoSecrets {
  const paths = getDemoPathConfig(options);
  assertPathInDemoData(paths.dataRoot, options);

  const secretsPath = join(paths.dataRoot, 'secrets.json');
  assertPathInDemoData(secretsPath, options);
  assertNoSymlinkAncestors(secretsPath, paths.dataRoot);

  // Generate 3 independent, distinct lowercase 64-hex secrets (32 bytes each)
  let metaSecret = randomBytes(32).toString('hex').toLowerCase();
  let cookieSecret = randomBytes(32).toString('hex').toLowerCase();
  let csrfToken = randomBytes(32).toString('hex').toLowerCase();

  while (metaSecret === cookieSecret || metaSecret === csrfToken || cookieSecret === csrfToken) {
    cookieSecret = randomBytes(32).toString('hex').toLowerCase();
    csrfToken = randomBytes(32).toString('hex').toLowerCase();
  }

  const secrets: DemoSecrets = {
    schemaVersion: 1,
    metaSecret,
    cookieSecret,
    csrfToken,
    createdAt: new Date().toISOString(),
  };

  // Atomically write secrets using descriptor-verified writeSecureJsonFile
  writeSecureJsonFile(secretsPath, secrets, {
    options,
    expectedMode: 0o600,
    allowExistingTarget: overwrite,
    maxSizeBytes: 1024 * 1024,
  });

  // Post-write verification: read back and strictly validate exact equality
  const verified = validateSecretsFile(secretsPath, options);
  if (
    verified.schemaVersion !== secrets.schemaVersion ||
    verified.metaSecret !== secrets.metaSecret ||
    verified.cookieSecret !== secrets.cookieSecret ||
    verified.csrfToken !== secrets.csrfToken ||
    verified.createdAt !== secrets.createdAt
  ) {
    throw new Error(`FAIL-CLOSED: secrets.json verification failed after atomic write.`);
  }

  secretsCache.set(paths.dataRoot, verified);
  return verified;
}

/**
 * Loads existing secrets from `<dataRoot>/secrets.json` or generates new random secrets with mode 0o600.
 * Fails closed if secrets.json exists but is invalid, corrupted, or has bad permissions/symlinks.
 */
export function getDemoSecrets(options?: DemoPathOptions | string): DemoSecrets {
  const paths = getDemoPathConfig(options);
  const cached = secretsCache.get(paths.dataRoot);
  if (cached) return cached;

  assertPathInDemoData(paths.dataRoot, options);
  const secretsPath = join(paths.dataRoot, 'secrets.json');
  assertPathInDemoData(secretsPath, options);

  try {
    return validateSecretsFile(secretsPath, options);
  } catch (err: unknown) {
    if (err instanceof FileNotFoundError || (isRecord(err) && err['code'] === 'ENOENT')) {
      return generateAndSaveSecrets(options, false);
    }
    throw err;
  }
}

/**
 * Retrieves the session metadata signing secret from secrets.json.
 */
export function getSessionMetaSecret(options?: DemoPathOptions | string): string {
  return getDemoSecrets(options).metaSecret;
}

/**
 * Rotates the metadata signing secret on disk and in memory.
 */
export function rotateSessionMetaSecret(options?: DemoPathOptions | string): string {
  return generateAndSaveSecrets(options, true).metaSecret;
}

/**
 * Derives a specific cryptographic secret for sub-services from the root session secret.
 */
export function deriveSecret(purpose: string, options?: DemoPathOptions | string): string {
  const secrets = getDemoSecrets(options);
  if (purpose === 'cookie' || purpose === 'auth-cookie') return secrets.cookieSecret;
  if (purpose === 'csrf' || purpose === 'csrf-token') return secrets.csrfToken;
  return createHmac('sha256', secrets.metaSecret).update(`enkeep-derived:${purpose}`, 'utf-8').digest('hex').toLowerCase();
}

/**
 * Computes SHA-256 HMAC signature for a given string payload.
 */
export function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload, 'utf-8').digest('hex').toLowerCase();
}

/**
 * Verifies SHA-256 HMAC signature using constant-time comparison.
 */
export function verifySignature(payload: string, signature: string, secret: string): boolean {
  if (!signature || typeof signature !== 'string') return false;
  const expected = signPayload(payload, secret);
  if (expected.length !== signature.length) return false;

  const expectedBuf = Buffer.from(expected, 'hex');
  const sigBuf = Buffer.from(signature, 'hex');
  if (expectedBuf.length !== sigBuf.length) return false;

  return timingSafeEqual(expectedBuf, sigBuf);
}

/**
 * Generates an unpredictable command token.
 */
export function generateCommandToken(service: string): string {
  return `cmd_${service.replace(/[^a-zA-Z0-9_-]/g, '_')}_${randomBytes(16).toString('hex').toLowerCase()}`;
}

/**
 * Generates an unpredictable runId.
 */
export function generateRunId(): string {
  return `run_${randomBytes(12).toString('hex').toLowerCase()}`;
}

/**
 * Writes cryptographically signed process metadata to `<dataRoot>/pids/<service>.json`
 * with strict file permissions 0o600 and exact schemaVersion=1.
 */
export function writeSignedProcessMeta(
  meta: Partial<SignedProcessMetadata> & {
    service: string;
    pid: number;
  },
  options?: DemoPathOptions | string
): SignedProcessMetadata {
  const paths = getDemoPathConfig(options);
  assertPathInDemoData(paths.pidsDir, options);

  const secret = getSessionMetaSecret(options);
  const commandToken = meta.commandToken ?? generateCommandToken(meta.service);
  const runId = meta.runId ?? generateRunId();
  const startedAt = meta.startedAt ?? new Date().toISOString();
  const startTime = meta.startTime ?? startedAt;
  const command = meta.command ?? (process.argv.length > 0 ? process.argv.join(' ') : `node ${meta.service}`);

  if (!isValidIsoDate(startedAt)) {
    throw new Error(`Safety Violation: startedAt must be a valid ISO 8601 string. Received "${startedAt}".`);
  }

  const payloadToSign = [
    DEMO_OWNERSHIP_TAG,
    meta.service,
    String(meta.pid),
    meta.port !== undefined ? String(meta.port) : 'none',
    commandToken,
    runId,
    startTime,
    command,
  ].join('|');

  const signature = signPayload(payloadToSign, secret);

  const signedMetadata: SignedProcessMetadata = {
    schemaVersion: 1,
    owner: DEMO_OWNERSHIP_TAG,
    appTag: DEMO_OWNERSHIP_TAG,
    service: meta.service,
    pid: meta.pid,
    port: meta.port,
    url: meta.url,
    startedAt,
    startTime,
    command,
    commandToken,
    runId,
    signature,
    details: meta.details,
  };

  const filePath = join(paths.pidsDir, `${meta.service}.json`);
  writeSecureJsonFile(filePath, signedMetadata, options, 0o600);

  return signedMetadata;
}

/**
 * Reads and verifies signed process metadata from `<dataRoot>/pids/<service>.json`.
 */
export function readSignedProcessMeta(service: string, options?: DemoPathOptions | string): SignedProcessMetadata | null {
  const paths = getDemoPathConfig(options);
  const filePath = join(paths.pidsDir, `${service}.json`);

  let raw: Record<string, unknown>;
  try {
    raw = readSecureJsonFile<Record<string, unknown>>(filePath, { options });
  } catch (err: unknown) {
    const code = getErrnoCode(err);
    if (code === 'ENOENT') {
      return null;
    }
    throw err;
  }
  const secret = getSessionMetaSecret(options);

  if (typeof raw['pid'] !== 'number' || raw['pid'] <= 0 || !Number.isInteger(raw['pid'])) {
    throw new Error(`Invalid PID in process metadata "${service}": must be positive integer`);
  }

  if (raw['owner'] !== DEMO_OWNERSHIP_TAG && raw['appTag'] !== DEMO_OWNERSHIP_TAG) {
    throw new Error(`Invalid owner tag in process metadata "${service}"`);
  }

  if (raw['schemaVersion'] !== 1) {
    throw new Error(`Invalid schemaVersion in process metadata "${service}": expected exact 1, got ${raw['schemaVersion']}`);
  }

  if (
    typeof raw['service'] !== 'string' ||
    !raw['service'] ||
    typeof raw['signature'] !== 'string' ||
    !raw['signature'] ||
    typeof raw['runId'] !== 'string' ||
    !raw['runId']
  ) {
    throw new Error(`Cryptographic signature verification failed for process metadata "${service}": invalid fields`);
  }

  if (typeof raw['startTime'] !== 'string' || !raw['startTime'].trim()) {
    throw new Error(`Invalid or missing startTime in process metadata "${service}": must be non-empty string`);
  }

  if (typeof raw['command'] !== 'string' || !raw['command'].trim()) {
    throw new Error(`Invalid or missing command in process metadata "${service}": must be non-empty string`);
  }

  if (typeof raw['startedAt'] !== 'string' || !isValidIsoDate(raw['startedAt'])) {
    throw new Error(`Invalid startedAt in process metadata "${service}": must be a valid ISO 8601 string`);
  }

  const payloadToVerify = [
    DEMO_OWNERSHIP_TAG,
    raw['service'],
    String(raw['pid']),
    raw['port'] !== undefined ? String(raw['port']) : 'none',
    String(raw['commandToken'] ?? ''),
    raw['runId'],
    raw['startTime'],
    raw['command'],
  ].join('|');

  if (!verifySignature(payloadToVerify, raw['signature'], secret)) {
    throw new Error(`Cryptographic signature verification failed for process metadata "${service}"`);
  }

  return {
    schemaVersion: 1,
    service: raw['service'],
    pid: raw['pid'],
    port: typeof raw['port'] === 'number' ? raw['port'] : undefined,
    url: typeof raw['url'] === 'string' ? raw['url'] : undefined,
    startedAt: raw['startedAt'],
    owner: DEMO_OWNERSHIP_TAG,
    appTag: DEMO_OWNERSHIP_TAG,
    commandToken: String(raw['commandToken'] ?? ''),
    signature: raw['signature'],
    runId: raw['runId'],
    startTime: raw['startTime'],
    command: raw['command'],
    details:
      typeof raw['details'] === 'object' && raw['details'] !== null && !Array.isArray(raw['details'])
        ? (raw['details'] as Record<string, unknown>)
        : undefined,
  };
}

/**
 * Lists and verifies all signed process metadata in `<dataRoot>/pids`.
 */
export function listSignedProcesses(options?: DemoPathOptions | string, errorsCollector?: Error[]): SignedProcessMetadata[] {
  const paths = getDemoPathConfig(options);
  let files: string[];
  try {
    files = readdirSync(paths.pidsDir);
  } catch (err: unknown) {
    const code = getErrnoCode(err);
    if (code === 'ENOENT') return [];
    throw err;
  }
  const result: SignedProcessMetadata[] = [];

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const service = file.replace(/\.json$/, '');
    try {
      const meta = readSignedProcessMeta(service, options);
      if (meta) {
        result.push(meta);
      }
    } catch (err: unknown) {
      if (errorsCollector && err instanceof Error) {
        errorsCollector.push(err);
      }
    }
  }

  return result;
}

/**
 * Safely removes process metadata file.
 */
export function removeSignedProcessMeta(service: string, options?: DemoPathOptions | string): boolean {
  const paths = getDemoPathConfig(options);
  const filePath = join(paths.pidsDir, `${service}.json`);
  try {
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Safety Violation: Metadata file "${filePath}" is a symlink! Refusing to unlink.`);
    }
    unlinkSync(filePath);
    return true;
  } catch (err: unknown) {
    const code = getErrnoCode(err);
    if (code === 'ENOENT') {
      return false;
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to remove metadata file "${filePath}": ${msg}`);
  }
}

/**
 * Writes cryptographically signed container metadata to `<dataRoot>/containers/<containerName>.json`
 * with strict file permissions 0o600, exact schemaVersion=1, and mandatory 64-hex containerId / runId / volumeId.
 */
export function writeSignedContainerMeta(
  meta: Partial<SignedContainerMetadata> & {
    userId: string;
    containerName: string;
    containerId: string;
    volumeName: string;
    volumeId: string;
    runId: string;
    image?: string;
  },
  options?: DemoPathOptions | string
): SignedContainerMetadata {
  const paths = getDemoPathConfig(options);
  assertPathInDemoData(paths.containersDir, options);

  const secret = getSessionMetaSecret(options);
  const runId = meta.runId;
  const volumeId = meta.volumeId;
  const containerId = meta.containerId;
  const startedAt = meta.startedAt ?? new Date().toISOString();

  if (!isValidIsoDate(startedAt)) {
    throw new Error(`Safety Violation: startedAt must be a valid ISO 8601 string. Received "${startedAt}".`);
  }

  if (!CONTAINER_ID_64_REGEX.test(containerId)) {
    throw new Error(`Safety Violation: containerId "${containerId}" must be a 64-hex SHA-256 lowercase string.`);
  }

  if (!RUN_ID_REGEX.test(runId)) {
    throw new Error(`Safety Violation: runId "${runId}" must match pattern ${RUN_ID_REGEX.source}`);
  }

  if (!VOLUME_ID_REGEX.test(volumeId)) {
    throw new Error(`Safety Violation: volumeId "${volumeId}" must match pattern ${VOLUME_ID_REGEX.source}`);
  }

  if (!meta.containerName.startsWith(DEMO_CONTAINER_PREFIX)) {
    throw new Error(
      `Safety Violation: Container name "${meta.containerName}" must start with prefix "${DEMO_CONTAINER_PREFIX}"`
    );
  }

  if (!meta.volumeName.startsWith(DEMO_VOLUME_PREFIX)) {
    throw new Error(
      `Safety Violation: Volume name "${meta.volumeName}" does not start with mandatory prefix "${DEMO_VOLUME_PREFIX}"`
    );
  }

  const payloadToSign = [
    DEMO_OWNERSHIP_TAG,
    meta.userId,
    meta.containerName,
    containerId,
    meta.volumeName,
    volumeId,
    runId,
  ].join('|');

  const signature = signPayload(payloadToSign, secret);

  const signedMetadata: SignedContainerMetadata = {
    schemaVersion: 1,
    owner: DEMO_OWNERSHIP_TAG,
    appTag: DEMO_OWNERSHIP_TAG,
    userId: meta.userId,
    containerName: meta.containerName,
    containerId,
    image: meta.image ?? 'enkeep-demo-runtime:latest',
    volumeName: meta.volumeName,
    volumeId,
    labels: {
      ...meta.labels,
      [DEMO_LABEL_KEY]: DEMO_LABEL_VALUE,
      [USER_LABEL_KEY]: meta.userId,
      [VOLUME_ID_LABEL_KEY]: volumeId,
      [RUN_ID_LABEL_KEY]: runId,
    },
    startedAt,
    runId,
    signature,
    status: meta.status ?? 'running',
  };

  const filePath = join(paths.containersDir, `${meta.containerName}.json`);
  writeSecureJsonFile(filePath, signedMetadata, options, 0o600);

  return signedMetadata;
}

/**
 * Reads and verifies signed container metadata from `<dataRoot>/containers/<containerName>.json`.
 */
export function readSignedContainerMeta(containerName: string, options?: DemoPathOptions | string): SignedContainerMetadata | null {
  const paths = getDemoPathConfig(options);
  const filePath = join(paths.containersDir, `${containerName}.json`);

  let raw: Record<string, unknown>;
  try {
    raw = readSecureJsonFile<Record<string, unknown>>(filePath, { options });
  } catch (err: unknown) {
    const code = getErrnoCode(err);
    if (code === 'ENOENT') {
      return null;
    }
    throw err;
  }
  const secret = getSessionMetaSecret(options);

  if (raw['schemaVersion'] !== 1) {
    throw new Error(`Invalid schemaVersion in container metadata "${containerName}": expected exact 1, got ${raw['schemaVersion']}`);
  }

  const labels = raw['labels'] as Record<string, string> | undefined;
  if (!labels || typeof labels !== 'object' || labels[DEMO_LABEL_KEY] !== DEMO_LABEL_VALUE) {
    throw new Error(`Missing mandatory ownership label: app=${DEMO_LABEL_VALUE}`);
  }

  const userId = raw['userId'];
  const cName = raw['containerName'];
  const containerId = raw['containerId'];
  const volumeName = raw['volumeName'];
  const volumeId = raw['volumeId'];
  const runId = raw['runId'];
  const signature = raw['signature'];
  const startedAt = raw['startedAt'];
  const owner = raw['owner'];
  const appTag = raw['appTag'];

  if (
    (owner !== DEMO_OWNERSHIP_TAG && appTag !== DEMO_OWNERSHIP_TAG) ||
    typeof cName !== 'string' ||
    typeof containerId !== 'string' ||
    typeof userId !== 'string' ||
    typeof volumeName !== 'string' ||
    typeof volumeId !== 'string' ||
    typeof runId !== 'string' ||
    typeof signature !== 'string'
  ) {
    throw new Error(`Cryptographic signature verification failed for container metadata "${containerName}": invalid fields`);
  }

  if (!CONTAINER_ID_64_REGEX.test(containerId)) {
    throw new Error(`Invalid containerId in container metadata "${containerName}": must be 64 lowercase hex characters`);
  }

  if (!RUN_ID_REGEX.test(runId)) {
    throw new Error(`Invalid runId in container metadata "${containerName}": must match pattern ${RUN_ID_REGEX.source}`);
  }

  if (!VOLUME_ID_REGEX.test(volumeId)) {
    throw new Error(`Invalid volumeId in container metadata "${containerName}": must match pattern ${VOLUME_ID_REGEX.source}`);
  }

  if (!cName.startsWith(DEMO_CONTAINER_PREFIX) || !volumeName.startsWith(DEMO_VOLUME_PREFIX)) {
    throw new Error(`Cryptographic signature verification failed for container metadata "${containerName}": prefix mismatch`);
  }

  if (typeof startedAt !== 'string' || !isValidIsoDate(startedAt)) {
    throw new Error(`Invalid startedAt in container metadata "${containerName}": must be valid ISO 8601 string`);
  }

  const payloadToVerify = [
    DEMO_OWNERSHIP_TAG,
    userId,
    cName,
    containerId,
    volumeName,
    volumeId,
    runId,
  ].join('|');

  if (!verifySignature(payloadToVerify, signature, secret)) {
    throw new Error(`Cryptographic signature verification failed for container metadata "${containerName}"`);
  }

  return {
    schemaVersion: 1,
    owner: DEMO_OWNERSHIP_TAG,
    appTag: DEMO_OWNERSHIP_TAG,
    userId,
    containerName: cName,
    containerId,
    image: typeof raw['image'] === 'string' ? raw['image'] : 'enkeep-demo-runtime:latest',
    volumeName,
    volumeId,
    labels,
    startedAt,
    runId,
    signature,
    status: raw['status'] === 'running' || raw['status'] === 'stopped' || raw['status'] === 'unknown' ? raw['status'] : 'running',
  };
}

/**
 * Lists and verifies all signed container metadata in `<dataRoot>/containers`.
 */
export function listSignedContainers(options?: DemoPathOptions | string, errorsCollector?: Error[]): SignedContainerMetadata[] {
  const paths = getDemoPathConfig(options);
  let files: string[];
  try {
    files = readdirSync(paths.containersDir);
  } catch (err: unknown) {
    const code = getErrnoCode(err);
    if (code === 'ENOENT') return [];
    throw err;
  }
  const result: SignedContainerMetadata[] = [];

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const cname = file.replace(/\.json$/, '');
    try {
      const meta = readSignedContainerMeta(cname, options);
      if (meta) {
        result.push(meta);
      }
    } catch (err: unknown) {
      if (errorsCollector && err instanceof Error) {
        errorsCollector.push(err);
      }
    }
  }

  return result;
}

/**
 * Safely removes container metadata file.
 */
export function removeSignedContainerMeta(containerName: string, options?: DemoPathOptions | string): boolean {
  const paths = getDemoPathConfig(options);
  const filePath = join(paths.containersDir, `${containerName}.json`);
  try {
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Safety Violation: Metadata file "${filePath}" is a symlink! Refusing to unlink.`);
    }
    unlinkSync(filePath);
    return true;
  } catch (err: unknown) {
    const code = getErrnoCode(err);
    if (code === 'ENOENT') {
      return false;
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to remove metadata file "${filePath}": ${msg}`);
  }
}

/**
 * Writes cryptographically signed volume metadata to `<dataRoot>/volumes/<volumeName>.json`
 * with strict file permissions 0o600, exact schemaVersion=1, and mandatory volumeId / runId.
 */
export function writeSignedVolumeMeta(
  meta: Partial<SignedVolumeMetadata> & {
    userId: string;
    volumeName: string;
    volumeId: string;
    runId: string;
  },
  options?: DemoPathOptions | string
): SignedVolumeMetadata {
  const paths = getDemoPathConfig(options);
  assertPathInDemoData(paths.volumesDir, options);

  const secret = getSessionMetaSecret(options);
  const runId = meta.runId;
  const volumeId = meta.volumeId;
  const createdAt = meta.createdAt ?? new Date().toISOString();

  if (!isValidIsoDate(createdAt)) {
    throw new Error(`Safety Violation: createdAt must be a valid ISO 8601 string. Received "${createdAt}".`);
  }

  if (!RUN_ID_REGEX.test(runId)) {
    throw new Error(`Safety Violation: runId "${runId}" must match pattern ${RUN_ID_REGEX.source}`);
  }

  if (!VOLUME_ID_REGEX.test(volumeId)) {
    throw new Error(`Safety Violation: volumeId "${volumeId}" must match pattern ${VOLUME_ID_REGEX.source}`);
  }

  if (!meta.volumeName.startsWith(DEMO_VOLUME_PREFIX)) {
    throw new Error(
      `Safety Violation: Volume name "${meta.volumeName}" does not start with mandatory prefix "${DEMO_VOLUME_PREFIX}"`
    );
  }

  const payloadToSign = [
    DEMO_OWNERSHIP_TAG,
    meta.userId,
    meta.volumeName,
    volumeId,
    runId,
  ].join('|');

  const signature = signPayload(payloadToSign, secret);

  const signedMetadata: SignedVolumeMetadata = {
    schemaVersion: 1,
    owner: DEMO_OWNERSHIP_TAG,
    appTag: DEMO_OWNERSHIP_TAG,
    userId: meta.userId,
    volumeName: meta.volumeName,
    volumeId,
    labels: {
      ...meta.labels,
      [DEMO_LABEL_KEY]: DEMO_LABEL_VALUE,
      [USER_LABEL_KEY]: meta.userId,
      [VOLUME_ID_LABEL_KEY]: volumeId,
      [RUN_ID_LABEL_KEY]: runId,
    },
    createdAt,
    runId,
    signature,
  };

  const filePath = join(paths.volumesDir, `${meta.volumeName}.json`);
  writeSecureJsonFile(filePath, signedMetadata, options, 0o600);

  return signedMetadata;
}

/**
 * Reads and verifies signed volume metadata from `<dataRoot>/volumes/<volumeName>.json`.
 */
export function readSignedVolumeMeta(volumeName: string, options?: DemoPathOptions | string): SignedVolumeMetadata | null {
  const paths = getDemoPathConfig(options);
  const filePath = join(paths.volumesDir, `${volumeName}.json`);

  let raw: Record<string, unknown>;
  try {
    raw = readSecureJsonFile<Record<string, unknown>>(filePath, { options });
  } catch (err: unknown) {
    const code = getErrnoCode(err);
    if (code === 'ENOENT') {
      return null;
    }
    throw err;
  }
  const secret = getSessionMetaSecret(options);

  if (raw['schemaVersion'] !== 1) {
    throw new Error(`Invalid schemaVersion in volume metadata "${volumeName}": expected exact 1, got ${raw['schemaVersion']}`);
  }

  const labels = raw['labels'] as Record<string, string> | undefined;
  if (!labels || typeof labels !== 'object' || labels[DEMO_LABEL_KEY] !== DEMO_LABEL_VALUE) {
    throw new Error(`Missing mandatory ownership label: app=${DEMO_LABEL_VALUE}`);
  }

  const userId = raw['userId'];
  const vName = raw['volumeName'];
  const volumeId = raw['volumeId'];
  const runId = raw['runId'];
  const signature = raw['signature'];
  const createdAt = raw['createdAt'];
  const owner = raw['owner'];
  const appTag = raw['appTag'];

  if (
    (owner !== DEMO_OWNERSHIP_TAG && appTag !== DEMO_OWNERSHIP_TAG) ||
    typeof vName !== 'string' ||
    typeof volumeId !== 'string' ||
    typeof userId !== 'string' ||
    typeof runId !== 'string' ||
    typeof signature !== 'string'
  ) {
    throw new Error(`Cryptographic signature verification failed for volume metadata "${volumeName}": invalid fields`);
  }

  if (!RUN_ID_REGEX.test(runId)) {
    throw new Error(`Invalid runId in volume metadata "${volumeName}": must match pattern ${RUN_ID_REGEX.source}`);
  }

  if (!VOLUME_ID_REGEX.test(volumeId)) {
    throw new Error(`Invalid volumeId in volume metadata "${volumeName}": must match pattern ${VOLUME_ID_REGEX.source}`);
  }

  if (!vName.startsWith(DEMO_VOLUME_PREFIX)) {
    throw new Error(`Cryptographic signature verification failed for volume metadata "${volumeName}": prefix mismatch`);
  }

  if (typeof createdAt !== 'string' || !isValidIsoDate(createdAt)) {
    throw new Error(`Invalid createdAt in volume metadata "${volumeName}": must be valid ISO 8601 string`);
  }

  const payloadToVerify = [
    DEMO_OWNERSHIP_TAG,
    userId,
    vName,
    volumeId,
    runId,
  ].join('|');

  if (!verifySignature(payloadToVerify, signature, secret)) {
    throw new Error(`Cryptographic signature verification failed for volume metadata "${volumeName}"`);
  }

  return {
    schemaVersion: 1,
    owner: DEMO_OWNERSHIP_TAG,
    appTag: DEMO_OWNERSHIP_TAG,
    userId,
    volumeName: vName,
    volumeId,
    labels,
    createdAt,
    runId,
    signature,
  };
}

/**
 * Lists and verifies all signed volume metadata in `<dataRoot>/volumes`.
 */
export function listSignedVolumes(options?: DemoPathOptions | string, errorsCollector?: Error[]): SignedVolumeMetadata[] {
  const paths = getDemoPathConfig(options);
  let files: string[];
  try {
    files = readdirSync(paths.volumesDir);
  } catch (err: unknown) {
    const code = getErrnoCode(err);
    if (code === 'ENOENT') return [];
    throw err;
  }
  const result: SignedVolumeMetadata[] = [];

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const vname = file.replace(/\.json$/, '');
    try {
      const meta = readSignedVolumeMeta(vname, options);
      if (meta) {
        result.push(meta);
      }
    } catch (err: unknown) {
      if (errorsCollector && err instanceof Error) {
        errorsCollector.push(err);
      }
    }
  }

  return result;
}

/**
 * Safely removes volume metadata file.
 */
export function removeSignedVolumeMeta(volumeName: string, options?: DemoPathOptions | string): boolean {
  const paths = getDemoPathConfig(options);
  const filePath = join(paths.volumesDir, `${volumeName}.json`);
  try {
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Safety Violation: Metadata file "${filePath}" is a symlink! Refusing to unlink.`);
    }
    unlinkSync(filePath);
    return true;
  } catch (err: unknown) {
    const code = getErrnoCode(err);
    if (code === 'ENOENT') {
      return false;
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to remove metadata file "${filePath}": ${msg}`);
  }
}
