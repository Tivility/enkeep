/**
 * Safe In-Container Per-Session OS File Lock for Single-Writer Guarantee
 *
 * Prevents concurrent processes inside the container from simultaneously reading/writing/modifying
 * the same DSH JSONL session persistence transcript.
 *
 * @module @enkeep/runtime-runner/runtime/session-lock
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const SAFE_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const MAX_LOCK_BYTES = 4096; // 4 KiB maximum lock file size

export interface SessionLockPayload {
  readonly sessionId: string;
  readonly pid: number;
  readonly processStartTime: string;
  readonly nonce: string;
  readonly action?: string;
  readonly turnId?: string;
  readonly acquiredAt: string;
}

export interface SessionLockHandle {
  readonly sessionId: string;
  release(): void;
}

export class SessionBusyError extends Error {
  readonly code = 'SESSION_BUSY';
  readonly statusCode = 409;
  constructor(_sessionId?: string, _holderPid?: number) {
    super('Session is busy');
    this.name = 'SessionBusyError';
  }
}

export type SessionLockErrorCode =
  | 'SESSION_LOCK_ERROR'
  | 'INVALID_PID'
  | 'PROCESS_NOT_ALIVE'
  | 'STAT_READ_FAILED'
  | 'STAT_PARSE_FAILED'
  | 'INVALID_LOCK_DIR'
  | 'SESSION_LOCK_DIR_FAILED'
  | 'INVALID_SESSION_ID'
  | 'PATH_TRAVERSAL_PREVENTED'
  | 'SESSION_LOCK_ACQUIRE_FAILED'
  | 'SESSION_LOCK_INSPECT_FAILED'
  | 'SESSION_LOCK_STALE_CLEANUP_FAILED'
  | 'SESSION_LOCK_RELEASE_FAILED'
  | 'SESSION_LOCK_CORRUPTED';

export const SESSION_LOCK_ERROR_MESSAGES: Record<SessionLockErrorCode, string> = {
  SESSION_LOCK_ERROR: 'Session lock operation failed',
  INVALID_PID: 'Invalid PID for process start time check',
  PROCESS_NOT_ALIVE: 'Target process is not alive',
  STAT_READ_FAILED: 'Failed to read process start time',
  STAT_PARSE_FAILED: 'Failed to parse process start time',
  INVALID_LOCK_DIR: 'Invalid locks directory path',
  SESSION_LOCK_DIR_FAILED: 'Failed to initialize locks directory',
  INVALID_SESSION_ID: 'Invalid session ID for lockfile',
  PATH_TRAVERSAL_PREVENTED: 'Invalid session ID for lockfile: path traversal detected',
  SESSION_LOCK_ACQUIRE_FAILED: 'Failed to acquire session lock',
  SESSION_LOCK_INSPECT_FAILED: 'Failed to inspect existing session lock file',
  SESSION_LOCK_STALE_CLEANUP_FAILED: 'Failed to clean up stale session lock',
  SESSION_LOCK_RELEASE_FAILED: 'Failed to release session lock',
  SESSION_LOCK_CORRUPTED: 'Session lock file is corrupted or malformed',
};

export class SessionLockError extends Error {
  readonly code: string;
  readonly statusCode = 500;
  constructor(message?: string, code: SessionLockErrorCode | string = 'SESSION_LOCK_ERROR') {
    const finalMsg =
      message ||
      (SESSION_LOCK_ERROR_MESSAGES as Record<string, string>)[code] ||
      'Session lock operation failed';
    super(finalMsg);
    this.name = 'SessionLockError';
    this.code = code;
  }
}

/**
 * Checks whether /proc filesystem is available for process inspection.
 */
export function isProcAvailable(): boolean {
  try {
    return fs.existsSync('/proc') && fs.statSync('/proc').isDirectory();
  } catch {
    return false;
  }
}

/**
 * Checks whether a PID is currently alive in the local OS.
 */
export function isProcessAlive(pid: number): boolean {
  if (pid <= 0 || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    return code === 'EPERM'; // Process exists but lacks permission to signal
  }
}

/**
 * Reads process start time from /proc/<pid>/stat on Linux, or returns a fallback mock string.
 * Never leaks raw PID or path in thrown error messages.
 */
export function getProcessStartTime(pid: number): string {
  if (pid <= 0 || !Number.isInteger(pid)) {
    throw new SessionLockError(
      SESSION_LOCK_ERROR_MESSAGES.INVALID_PID,
      'INVALID_PID'
    );
  }

  const statPath = `/proc/${pid}/stat`;
  let fd: number;
  try {
    fd = fs.openSync(statPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    if (!isProcAvailable()) {
      if (isProcessAlive(pid)) {
        return `proc_mock_starttime_${pid}`;
      }
      throw new SessionLockError(
        SESSION_LOCK_ERROR_MESSAGES.PROCESS_NOT_ALIVE,
        'PROCESS_NOT_ALIVE'
      );
    }
    throw new SessionLockError(
      SESSION_LOCK_ERROR_MESSAGES.STAT_READ_FAILED,
      'STAT_READ_FAILED'
    );
  }

  try {
    const statBuf = Buffer.alloc(1024);
    let bytesRead = 0;
    while (bytesRead < 1024) {
      const chunk = fs.readSync(fd, statBuf, bytesRead, 1024 - bytesRead, bytesRead);
      if (chunk === 0) break;
      bytesRead += chunk;
    }
    const content = statBuf.toString('utf8', 0, bytesRead);
    const lastParen = content.lastIndexOf(')');
    if (lastParen !== -1) {
      const rest = content.slice(lastParen + 1).trim().split(/\s+/);
      const starttime = rest[19];
      if (starttime && starttime.length > 0) {
        return starttime;
      }
    }
    throw new SessionLockError(
      SESSION_LOCK_ERROR_MESSAGES.STAT_PARSE_FAILED,
      'STAT_PARSE_FAILED'
    );
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Ensures the locks directory exists under dshHome with mode 0o700.
 * Never leaks raw paths in thrown error messages.
 */
export function ensureLocksDirectory(dshHome: string): string {
  if (!dshHome || typeof dshHome !== 'string' || !path.isAbsolute(dshHome) || dshHome.includes('\0')) {
    throw new SessionLockError(
      SESSION_LOCK_ERROR_MESSAGES.INVALID_LOCK_DIR,
      'INVALID_LOCK_DIR'
    );
  }
  const locksDir = path.join(dshHome, 'locks');
  try {
    fs.mkdirSync(locksDir, { recursive: true, mode: 0o700 });
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code !== 'EEXIST') {
      throw new SessionLockError(
        SESSION_LOCK_ERROR_MESSAGES.SESSION_LOCK_DIR_FAILED,
        'SESSION_LOCK_DIR_FAILED'
      );
    }
  }

  try {
    const stat = fs.lstatSync(locksDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new SessionLockError(
        SESSION_LOCK_ERROR_MESSAGES.SESSION_LOCK_DIR_FAILED,
        'SESSION_LOCK_DIR_FAILED'
      );
    }
    fs.chmodSync(locksDir, 0o700);
  } catch (err: unknown) {
    if (err instanceof SessionLockError) throw err;
    throw new SessionLockError(
      SESSION_LOCK_ERROR_MESSAGES.SESSION_LOCK_DIR_FAILED,
      'SESSION_LOCK_DIR_FAILED'
    );
  }
  return locksDir;
}

/**
 * Checks whether a session ID string strictly complies with safe naming rules.
 */
export function isValidSessionIdForLock(sessionId: unknown): sessionId is string {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  if (sessionId.length > 128) return false;
  if (sessionId !== sessionId.trim()) return false;
  if (sessionId !== sessionId.normalize('NFC')) return false;
  if (
    sessionId.includes('/') ||
    sessionId.includes('\\') ||
    sessionId.includes('..') ||
    sessionId.includes('\0')
  ) {
    return false;
  }
  return SAFE_SESSION_ID_PATTERN.test(sessionId);
}

/**
 * Computes a sanitized, traversal-proof lockfile path for a session ID.
 * Never leaks raw session IDs or paths in thrown error messages.
 */
export function deriveSafeLockPath(locksDir: string, sessionId: string): string {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new SessionLockError(
      SESSION_LOCK_ERROR_MESSAGES.INVALID_SESSION_ID,
      'INVALID_SESSION_ID'
    );
  }
  if (!isValidSessionIdForLock(sessionId)) {
    throw new SessionLockError(
      SESSION_LOCK_ERROR_MESSAGES.PATH_TRAVERSAL_PREVENTED,
      'PATH_TRAVERSAL_PREVENTED'
    );
  }
  const hash = crypto.createHash('sha256').update(sessionId).digest('hex');
  const lockFilename = `ses_${hash}.lock`;
  const resolved = path.join(locksDir, lockFilename);
  if (path.dirname(resolved) !== path.normalize(locksDir)) {
    throw new SessionLockError(
      SESSION_LOCK_ERROR_MESSAGES.PATH_TRAVERSAL_PREVENTED,
      'PATH_TRAVERSAL_PREVENTED'
    );
  }
  return resolved;
}

/**
 * Validates the schema of an existing session lock payload parsed from disk.
 */
function validateLockPayloadSchema(data: unknown): data is SessionLockPayload {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return false;
  }
  const p = data as Record<string, unknown>;
  if (typeof p['sessionId'] !== 'string' || !isValidSessionIdForLock(p['sessionId'])) {
    return false;
  }
  if (typeof p['pid'] !== 'number' || !Number.isInteger(p['pid']) || p['pid'] <= 0) {
    return false;
  }
  if (typeof p['processStartTime'] !== 'string' || !p['processStartTime']) {
    return false;
  }
  if (typeof p['nonce'] !== 'string' || !p['nonce']) {
    return false;
  }
  if (typeof p['acquiredAt'] !== 'string' || !p['acquiredAt']) {
    return false;
  }
  if (p['action'] !== undefined && typeof p['action'] !== 'string') {
    return false;
  }
  if (p['turnId'] !== undefined && typeof p['turnId'] !== 'string') {
    return false;
  }
  return true;
}

interface InspectLockResult {
  readonly isStale: boolean;
  readonly holderPid?: number;
  readonly dev?: number;
  readonly ino?: number;
}

/**
 * Inspects existing lockfile with O_NOFOLLOW, bounded read, and strict schema validation.
 */
function inspectExistingLock(
  lockPath: string,
  currentPid: number,
  currentNonce: string
): InspectLockResult {
  let fd: number | null = null;
  try {
    fd = fs.openSync(lockPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (openErr: unknown) {
    const oCode = (openErr as { code?: string })?.code;
    if (oCode === 'ENOENT') {
      return { isStale: false };
    }
    if (oCode === 'ELOOP' || oCode === 'EMLINK') {
      // Symlink detected: unsafe, treat as stale
      return { isStale: true };
    }
    throw new SessionLockError(
      SESSION_LOCK_ERROR_MESSAGES.SESSION_LOCK_INSPECT_FAILED,
      'SESSION_LOCK_INSPECT_FAILED'
    );
  }

  try {
    const stat = fs.fstatSync(fd);
    const dev = stat.dev;
    const ino = stat.ino;

    if (!stat.isFile()) {
      // Non-regular file (directory, symlink, fifo) -> stale
      return { isStale: true, dev, ino };
    }

    if (stat.size > MAX_LOCK_BYTES) {
      // Oversized lockfile -> stale/malformed
      return { isStale: true, dev, ino };
    }

    if (stat.size === 0) {
      // Empty lock file (e.g. process crashed mid-creation)
      if (Date.now() - stat.mtimeMs > 3000) {
        return { isStale: true, dev, ino };
      }
      return { isStale: false, dev, ino };
    }

    const buf = Buffer.alloc(stat.size);
    let bytesRead = 0;
    while (bytesRead < stat.size) {
      const chunk = fs.readSync(fd, buf, bytesRead, stat.size - bytesRead, bytesRead);
      if (chunk === 0) break;
      bytesRead += chunk;
    }
    const rawContent = buf.toString('utf8', 0, bytesRead);
    if (!rawContent.trim()) {
      if (Date.now() - stat.mtimeMs > 3000) {
        return { isStale: true, dev, ino };
      }
      return { isStale: false, dev, ino };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      // Malformed JSON -> stale
      return { isStale: true, dev, ino };
    }

    if (!validateLockPayloadSchema(parsed)) {
      // Invalid schema -> stale
      return { isStale: true, dev, ino };
    }

    const holderPid = parsed.pid;
    if (parsed.pid === currentPid && parsed.nonce === currentNonce) {
      return { isStale: false, holderPid, dev, ino };
    }

    if (!isProcessAlive(parsed.pid)) {
      // Process died -> stale
      return { isStale: true, holderPid, dev, ino };
    }

    // Process alive: verify process start time
    try {
      const holderStartTime = getProcessStartTime(parsed.pid);
      if (holderStartTime !== parsed.processStartTime) {
        // PID recycled by OS -> stale
        return { isStale: true, holderPid, dev, ino };
      }
    } catch {
      if (!isProcessAlive(parsed.pid)) {
        return { isStale: true, holderPid, dev, ino };
      }
    }

    return { isStale: false, holderPid, dev, ino };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/**
 * Safely unlinks a stale lockfile while verifying dev and ino to avoid TOCTOU races.
 */
function cleanupStaleLock(lockPath: string, expectedDev?: number, expectedIno?: number): void {
  try {
    if (expectedDev !== undefined && expectedIno !== undefined) {
      const currentStat = fs.lstatSync(lockPath);
      if (currentStat.dev !== expectedDev || currentStat.ino !== expectedIno) {
        // Inode changed concurrently; do not unlink
        return;
      }
    }
    fs.unlinkSync(lockPath);
  } catch (unlinkErr: unknown) {
    const uCode = (unlinkErr as { code?: string })?.code;
    if (uCode !== 'ENOENT') {
      throw new SessionLockError(
        SESSION_LOCK_ERROR_MESSAGES.SESSION_LOCK_STALE_CLEANUP_FAILED,
        'SESSION_LOCK_STALE_CLEANUP_FAILED'
      );
    }
  }
}

/**
 * Acquires a per-session OS file lock using O_CREAT | O_EXCL | O_NOFOLLOW.
 * Returns a SessionLockHandle exposing only sessionId and release().
 * Never leaks lockPath, payload, PID, or raw OS paths in errors or handles.
 */
export async function acquireSessionLock(options: {
  dshHome: string;
  sessionId: string;
  action?: string;
  turnId?: string;
  timeoutMs?: number;
  retryIntervalMs?: number;
}): Promise<SessionLockHandle> {
  const {
    dshHome,
    sessionId,
    action,
    turnId,
    timeoutMs = 5000,
    retryIntervalMs = 50,
  } = options;

  const locksDir = ensureLocksDirectory(dshHome);
  const lockPath = deriveSafeLockPath(locksDir, sessionId);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const currentPid = process.pid;
  const currentStartTime = getProcessStartTime(currentPid);
  const nonce = crypto.randomBytes(16).toString('hex');

  let lastHolderPid: number | undefined;

  while (true) {
    const payload: SessionLockPayload = {
      sessionId,
      pid: currentPid,
      processStartTime: currentStartTime,
      nonce,
      action,
      turnId,
      acquiredAt: new Date().toISOString(),
    };

    let fd: number | null = null;
    try {
      fd = fs.openSync(
        lockPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600
      );

      const buf = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
      let written = 0;
      while (written < buf.length) {
        const bytes = fs.writeSync(fd, buf, written, buf.length - written, written);
        if (bytes === 0) break;
        written += bytes;
      }
      fs.fsyncSync(fd);
      const stat = fs.fstatSync(fd);
      const expectedDev = stat.dev;
      const expectedIno = stat.ino;

      fs.closeSync(fd);
      fd = null;

      let released = false;
      const handle: SessionLockHandle = {
        sessionId,
        release: () => {
          if (released) return;
          released = true;
          try {
            const currentStat = fs.lstatSync(lockPath);
            if (currentStat.dev === expectedDev && currentStat.ino === expectedIno) {
              fs.unlinkSync(lockPath);
            }
          } catch (unlinkErr: unknown) {
            const uCode = (unlinkErr as { code?: string })?.code;
            if (uCode !== 'ENOENT') {
              throw new SessionLockError(
                SESSION_LOCK_ERROR_MESSAGES.SESSION_LOCK_RELEASE_FAILED,
                'SESSION_LOCK_RELEASE_FAILED'
              );
            }
          }
        },
      };

      return handle;
    } catch (err: unknown) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {}
        fd = null;
      }

      const code = (err as { code?: string })?.code;
      if (code === 'EEXIST') {
        const inspectRes = inspectExistingLock(lockPath, currentPid, nonce);
        if (inspectRes.holderPid) {
          lastHolderPid = inspectRes.holderPid;
        }

        if (inspectRes.isStale) {
          cleanupStaleLock(lockPath, inspectRes.dev, inspectRes.ino);
          continue;
        }

        if (Date.now() >= deadline) {
          throw new SessionBusyError(sessionId, lastHolderPid);
        }

        const waitTime = Math.min(retryIntervalMs, Math.max(10, deadline - Date.now()));
        await new Promise((r) => setTimeout(r, waitTime));
        continue;
      }

      if (err instanceof SessionLockError || err instanceof SessionBusyError) {
        throw err;
      }

      throw new SessionLockError(
        SESSION_LOCK_ERROR_MESSAGES.SESSION_LOCK_ACQUIRE_FAILED,
        'SESSION_LOCK_ACQUIRE_FAILED'
      );
    }
  }
}
