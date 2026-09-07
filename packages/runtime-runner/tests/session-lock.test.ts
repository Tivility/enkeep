import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  acquireSessionLock,
  deriveSafeLockPath,
  ensureLocksDirectory,
  getProcessStartTime,
  isProcessAlive,
  isProcAvailable,
  isValidSessionIdForLock,
  SAFE_SESSION_ID_PATTERN,
  MAX_LOCK_BYTES,
  SessionBusyError,
  SessionLockError,
  SESSION_LOCK_ERROR_MESSAGES,
  type SessionLockHandle,
  type SessionLockPayload,
} from '../src/runtime/session-lock.js';
import { runExecCli, TypedCliError } from '../src/runtime/exec-cli.js';

describe('Safe In-Container Per-Session OS File Lock & Error Sanitization', () => {
  let tmpDir: string;
  let dshHome: string;
  let locksDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-lock-test-'));
    dshHome = path.join(tmpDir, '.dsh');
    locksDir = path.join(dshHome, 'locks');
    fs.mkdirSync(dshHome, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('1. Public SessionLockHandle API & Encapsulation', () => {
    it('returns a handle with only sessionId and release(), encapsulating lockPath and payload', async () => {
      const sessionId = 'ses_0123456789abcdef0123456789abcdef';
      const handle = await acquireSessionLock({
        dshHome,
        sessionId,
        action: 'followup',
        turnId: 'turn_0123456789abcdef0123456789abcdef',
      });

      expect(handle.sessionId).toBe(sessionId);
      expect(typeof handle.release).toBe('function');

      // Ensure internal properties are not exposed on public handle
      const rawHandle = handle as Record<string, unknown>;
      expect(rawHandle['lockPath']).toBeUndefined();
      expect(rawHandle['payload']).toBeUndefined();

      // Verify lockfile was actually created on disk
      const expectedLockPath = deriveSafeLockPath(locksDir, sessionId);
      expect(fs.existsSync(expectedLockPath)).toBe(true);

      // Releasing removes lockfile
      handle.release();
      expect(fs.existsSync(expectedLockPath)).toBe(false);

      // Calling release() multiple times is idempotent
      expect(() => handle.release()).not.toThrow();
    });
  });

  describe('2. Fixed Error Messages & Information Leak Prevention', () => {
    it('SessionBusyError has fixed "Session is busy" message and never leaks session ID or PID', () => {
      const busyErr1 = new SessionBusyError();
      expect(busyErr1.message).toBe('Session is busy');
      expect(busyErr1.code).toBe('SESSION_BUSY');
      expect(busyErr1.statusCode).toBe(409);

      // Even if passed sessionId and PID, it never interpolates them into message
      const busyErr2 = new SessionBusyError('sensitive_session_id_xyz', 99999);
      expect(busyErr2.message).toBe('Session is busy');
      expect(busyErr2.message).not.toContain('sensitive_session_id_xyz');
      expect(busyErr2.message).not.toContain('99999');
    });

    it('SessionLockError provides standardized fixed messages by error code', () => {
      const codes: (keyof typeof SESSION_LOCK_ERROR_MESSAGES)[] = [
        'SESSION_LOCK_ERROR',
        'INVALID_PID',
        'PROCESS_NOT_ALIVE',
        'STAT_READ_FAILED',
        'STAT_PARSE_FAILED',
        'INVALID_LOCK_DIR',
        'SESSION_LOCK_DIR_FAILED',
        'INVALID_SESSION_ID',
        'PATH_TRAVERSAL_PREVENTED',
        'SESSION_LOCK_ACQUIRE_FAILED',
        'SESSION_LOCK_INSPECT_FAILED',
        'SESSION_LOCK_STALE_CLEANUP_FAILED',
        'SESSION_LOCK_RELEASE_FAILED',
        'SESSION_LOCK_CORRUPTED',
      ];

      for (const code of codes) {
        const err = new SessionLockError(undefined, code);
        expect(err.code).toBe(code);
        expect(err.statusCode).toBe(500);
        expect(err.message).toBe(SESSION_LOCK_ERROR_MESSAGES[code]);
        expect(err.message).not.toContain('/Users');
        expect(err.message).not.toContain('/home');
        expect(err.message).not.toContain('pid');
      }
    });

    it('getProcessStartTime throws fixed message on invalid PID without leaking input', () => {
      expect(() => getProcessStartTime(-5)).toThrow(SessionLockError);
      expect(() => getProcessStartTime(-5)).toThrow('Invalid PID for process start time check');
      expect(() => getProcessStartTime(0)).toThrow('Invalid PID for process start time check');
      expect(() => getProcessStartTime(1.5)).toThrow('Invalid PID for process start time check');
    });

    it('ensureLocksDirectory throws fixed message without leaking paths on failure', () => {
      expect(() => ensureLocksDirectory('')).toThrow(SessionLockError);
      expect(() => ensureLocksDirectory('')).toThrow('Invalid locks directory path');
      expect(() => ensureLocksDirectory('relative/path')).toThrow('Invalid locks directory path');
      expect(() => ensureLocksDirectory('/path/with\0null')).toThrow('Invalid locks directory path');

      // Create a file where locks directory should be to force mkdir/stat failure
      const blockedHome = path.join(tmpDir, 'blocked-home');
      fs.mkdirSync(blockedHome, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(blockedHome, 'locks'), 'blocking-file', { mode: 0o600 });

      expect(() => ensureLocksDirectory(blockedHome)).toThrow(SessionLockError);
      expect(() => ensureLocksDirectory(blockedHome)).toThrow('Failed to initialize locks directory');
    });
  });

  describe('3. Strict Session ID Validation & Traversal Prevention', () => {
    it('accepts canonical DSH session IDs and safe alphanumerics', () => {
      expect(isValidSessionIdForLock('ses_0123456789abcdef0123456789abcdef')).toBe(true);
      expect(isValidSessionIdForLock('import-0123456789abcdef0123456789abcdef')).toBe(true);
      expect(isValidSessionIdForLock('ses_test_123')).toBe(true);
      expect(isValidSessionIdForLock('alpha-beta_1.0')).toBe(true);
    });

    it('rejects path traversal, separators, whitespaces, and illegal characters', () => {
      expect(isValidSessionIdForLock('../../../etc/passwd')).toBe(false);
      expect(isValidSessionIdForLock('ses/../../sub')).toBe(false);
      expect(isValidSessionIdForLock('ses/sub')).toBe(false);
      expect(isValidSessionIdForLock('..\\windows')).toBe(false);
      expect(isValidSessionIdForLock(' ses_123 ')).toBe(false);
      expect(isValidSessionIdForLock('ses_123\n')).toBe(false);
      expect(isValidSessionIdForLock('ses_\0null')).toBe(false);
      expect(isValidSessionIdForLock('a'.repeat(129))).toBe(false);
      expect(isValidSessionIdForLock('')).toBe(false);
      expect(isValidSessionIdForLock(null)).toBe(false);
      expect(isValidSessionIdForLock(undefined)).toBe(false);
    });

    it('deriveSafeLockPath creates sha256 hashed filenames inside locks directory', () => {
      const sessionId = 'ses_0123456789abcdef0123456789abcdef';
      const lockPath = deriveSafeLockPath(locksDir, sessionId);
      const expectedHash = crypto.createHash('sha256').update(sessionId).digest('hex');

      expect(path.basename(lockPath)).toBe(`ses_${expectedHash}.lock`);
      expect(path.dirname(lockPath)).toBe(path.normalize(locksDir));
    });

    it('deriveSafeLockPath throws fixed PATH_TRAVERSAL_PREVENTED without leaking malicious string', () => {
      const malicious = '../../../etc/shadow';
      try {
        deriveSafeLockPath(locksDir, malicious);
        expect.unreachable('Should have thrown');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(SessionLockError);
        const lockErr = err as SessionLockError;
        expect(lockErr.code).toBe('PATH_TRAVERSAL_PREVENTED');
        expect(lockErr.message).toBe('Invalid session ID for lockfile: path traversal detected');
        expect(lockErr.message).not.toContain('shadow');
        expect(lockErr.message).not.toContain('etc');
      }
    });
  });

  describe('4. Process Contention & Single-Writer Guarantee', () => {
    it('detects concurrent acquisition contention and throws SessionBusyError after deadline', async () => {
      const sessionId = 'ses_contention_001';

      // 1. Holder 1 acquires lock
      const lock1 = await acquireSessionLock({
        dshHome,
        sessionId,
        timeoutMs: 1000,
      });
      expect(lock1.sessionId).toBe(sessionId);

      // 2. Holder 2 attempts acquisition on SAME session with short timeout
      const startTime = Date.now();
      await expect(
        acquireSessionLock({
          dshHome,
          sessionId,
          timeoutMs: 100,
          retryIntervalMs: 20,
        })
      ).rejects.toThrow(SessionBusyError);
      expect(Date.now() - startTime).toBeGreaterThanOrEqual(80);

      // 3. Holder 1 releases lock
      lock1.release();

      // 4. Holder 2 can now acquire lock cleanly
      const lock2 = await acquireSessionLock({
        dshHome,
        sessionId,
        timeoutMs: 1000,
      });
      expect(lock2.sessionId).toBe(sessionId);
      lock2.release();
    });

    it('allows concurrent acquisitions for different session IDs', async () => {
      const sessionA = 'ses_concurrent_aaa';
      const sessionB = 'ses_concurrent_bbb';

      const lockA = await acquireSessionLock({ dshHome, sessionId: sessionA, timeoutMs: 1000 });
      const lockB = await acquireSessionLock({ dshHome, sessionId: sessionB, timeoutMs: 1000 });

      expect(lockA.sessionId).toBe(sessionA);
      expect(lockB.sessionId).toBe(sessionB);

      lockA.release();
      lockB.release();
    });
  });

  describe('5. Stale Lock Detection and Auto-Recovery', () => {
    it('detects dead holder process and automatically cleans up stale lock', async () => {
      const sessionId = 'ses_stale_dead_pid';
      const lockPath = deriveSafeLockPath(ensureLocksDirectory(dshHome), sessionId);

      // Write a lockfile held by a dead process PID (9999999)
      const stalePayload: SessionLockPayload = {
        sessionId,
        pid: 9999999,
        processStartTime: 'mock_starttime_dead',
        nonce: crypto.randomBytes(16).toString('hex'),
        action: 'followup',
        acquiredAt: new Date(Date.now() - 60000).toISOString(),
      };
      fs.writeFileSync(lockPath, JSON.stringify(stalePayload, null, 2), { mode: 0o600 });

      // acquireSessionLock should detect dead PID, clean it up, and acquire successfully
      const lock = await acquireSessionLock({
        dshHome,
        sessionId,
        timeoutMs: 2000,
      });

      expect(lock.sessionId).toBe(sessionId);
      expect(fs.existsSync(lockPath)).toBe(true);

      // Verify lockfile now has current process PID
      const currentContent = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      expect(currentContent.pid).toBe(process.pid);

      lock.release();
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('detects recycled PID via mismatched process start time and cleans up stale lock', async () => {
      const sessionId = 'ses_stale_recycled_pid';
      const lockPath = deriveSafeLockPath(ensureLocksDirectory(dshHome), sessionId);

      // Write a lockfile held by current PID but with bogus historical start time
      const stalePayload: SessionLockPayload = {
        sessionId,
        pid: process.pid,
        processStartTime: 'historical_recycled_fake_starttime_0000',
        nonce: 'old_nonce_123',
        action: 'followup',
        acquiredAt: new Date(Date.now() - 60000).toISOString(),
      };
      fs.writeFileSync(lockPath, JSON.stringify(stalePayload, null, 2), { mode: 0o600 });

      // acquireSessionLock should detect recycled PID mismatch, clean it up, and acquire
      const lock = await acquireSessionLock({
        dshHome,
        sessionId,
        timeoutMs: 2000,
      });

      expect(lock.sessionId).toBe(sessionId);
      const newContent = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      expect(newContent.nonce).not.toBe('old_nonce_123');

      lock.release();
    });

    it('recovers from malformed / invalid JSON lockfile safely', async () => {
      const sessionId = 'ses_malformed_json';
      const lockPath = deriveSafeLockPath(ensureLocksDirectory(dshHome), sessionId);

      fs.writeFileSync(lockPath, '{{{not valid json corrupted file content', { mode: 0o600 });

      const lock = await acquireSessionLock({
        dshHome,
        sessionId,
        timeoutMs: 2000,
      });

      expect(lock.sessionId).toBe(sessionId);
      expect(fs.existsSync(lockPath)).toBe(true);
      lock.release();
    });

    it('recovers from oversized lockfile (> 4096 bytes) safely', async () => {
      const sessionId = 'ses_oversized_file';
      const lockPath = deriveSafeLockPath(ensureLocksDirectory(dshHome), sessionId);

      const hugeData = 'x'.repeat(MAX_LOCK_BYTES + 500);
      fs.writeFileSync(lockPath, hugeData, { mode: 0o600 });

      const lock = await acquireSessionLock({
        dshHome,
        sessionId,
        timeoutMs: 2000,
      });

      expect(lock.sessionId).toBe(sessionId);
      lock.release();
    });

    it('recovers from invalid schema lockfile safely', async () => {
      const sessionId = 'ses_invalid_schema';
      const lockPath = deriveSafeLockPath(ensureLocksDirectory(dshHome), sessionId);

      const invalidPayload = {
        sessionId: 12345, // invalid type
        pid: 'not-a-number',
      };
      fs.writeFileSync(lockPath, JSON.stringify(invalidPayload), { mode: 0o600 });

      const lock = await acquireSessionLock({
        dshHome,
        sessionId,
        timeoutMs: 2000,
      });

      expect(lock.sessionId).toBe(sessionId);
      lock.release();
    });

    it('cleans up symlink attack attempts with O_NOFOLLOW without following victim target', async () => {
      const sessionId = 'ses_symlink_attack';
      const lockPath = deriveSafeLockPath(ensureLocksDirectory(dshHome), sessionId);
      const victimFile = path.join(tmpDir, 'victim-file.txt');
      fs.writeFileSync(victimFile, 'CRITICAL_DATA_DO_NOT_DELETE', { mode: 0o600 });

      // Create symlink pointing lockPath to victimFile
      fs.symlinkSync(victimFile, lockPath);

      // acquireSessionLock should safely handle symlink and replace it with real lockfile
      const lock = await acquireSessionLock({
        dshHome,
        sessionId,
        timeoutMs: 2000,
      });

      expect(lock.sessionId).toBe(sessionId);
      // Victim file must remain intact
      expect(fs.existsSync(victimFile)).toBe(true);
      expect(fs.readFileSync(victimFile, 'utf8')).toBe('CRITICAL_DATA_DO_NOT_DELETE');

      // lockPath is now a regular file, not a symlink
      const lockStat = fs.lstatSync(lockPath);
      expect(lockStat.isSymbolicLink()).toBe(false);
      expect(lockStat.isFile()).toBe(true);

      lock.release();
      expect(fs.readFileSync(victimFile, 'utf8')).toBe('CRITICAL_DATA_DO_NOT_DELETE');
    });

    it('cleans up empty lockfile if older than 3 seconds (crashed creator)', async () => {
      const sessionId = 'ses_empty_stale';
      const lockPath = deriveSafeLockPath(ensureLocksDirectory(dshHome), sessionId);

      // Create empty lockfile and backdate mtime to 5 seconds ago
      fs.writeFileSync(lockPath, '', { mode: 0o600 });
      const oldTime = (Date.now() - 5000) / 1000;
      fs.utimesSync(lockPath, oldTime, oldTime);

      const lock = await acquireSessionLock({
        dshHome,
        sessionId,
        timeoutMs: 2000,
      });

      expect(lock.sessionId).toBe(sessionId);
      expect(fs.statSync(lockPath).size).toBeGreaterThan(0);
      lock.release();
    });
  });

  describe('6. Release Failure Handling & Inode Verification', () => {
    it('verifies inode on release so it does not delete successor lock if replaced', async () => {
      const sessionId = 'ses_inode_verification';
      const lockPath = deriveSafeLockPath(ensureLocksDirectory(dshHome), sessionId);

      const lock1 = await acquireSessionLock({
        dshHome,
        sessionId,
        timeoutMs: 1000,
      });

      // Simulate external deletion and creation of a new file with different inode
      fs.unlinkSync(lockPath);
      fs.writeFileSync(lockPath, 'new_successor_lock', { mode: 0o600 });

      // Calling lock1.release() should safely check inode and NOT unlink the new file
      expect(() => lock1.release()).not.toThrow();
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(fs.readFileSync(lockPath, 'utf8')).toBe('new_successor_lock');

      fs.unlinkSync(lockPath);
    });

    it('maps AggregateError with SESSION_LOCK_RELEASE_FAILED without leaking raw errors', () => {
      const releaseErr = new SessionLockError(
        SESSION_LOCK_ERROR_MESSAGES.SESSION_LOCK_RELEASE_FAILED,
        'SESSION_LOCK_RELEASE_FAILED'
      );
      const opErr = new Error('Database write failure at /internal/db.sqlite');

      const aggregate = new AggregateError([opErr, releaseErr], 'SESSION_LOCK_RELEASE_FAILED');

      expect(aggregate.message).toBe('SESSION_LOCK_RELEASE_FAILED');
      expect(releaseErr.message).toBe('Failed to release session lock');
      expect(releaseErr.message).not.toContain('/internal');
    });
  });
});
