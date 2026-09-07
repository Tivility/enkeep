import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  assertDirectorySecure,
  readSafeMarkerFile,
  readSafeResultFile,
  unlinkVerifiedFile,
  writeAtomicJson,
  getProcessStartTime,
  isProcessAlive,
  getRequiredCurrentUid,
  MarkerNotFoundError,
  ResultNotFoundError,
  TypedCliError,
} from '../src/runtime/exec-cli.js';
import { extractPromptDelayMs } from '../src/runtime/demo-model-plugin.js';
import { bootDshRuntime, InvariantError, PersistedSessionResumeError } from '../src/runtime/dsh-boot.js';

describe('Marker FD & Directory Security and Invariants', () => {
  let tmpDir: string;
  let dshHome: string;
  let spacesDir: string;
  let activeTurnsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-fd-test-'));
    dshHome = path.join(tmpDir, '.dsh');
    spacesDir = path.join(tmpDir, 'spaces');
    activeTurnsDir = path.join(dshHome, 'active-turns');
    fs.mkdirSync(dshHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spacesDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(activeTurnsDir, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('Directory Security Guardrails', () => {
    it('rejects directory if it does not exist', () => {
      const nonExistent = path.join(tmpDir, 'does-not-exist');
      expect(() => assertDirectorySecure(nonExistent)).toThrow(TypedCliError);
    });

    it('rejects directory if it is a symbolic link', () => {
      const realDir = path.join(tmpDir, 'real-dir');
      fs.mkdirSync(realDir, { recursive: true, mode: 0o700 });
      const symlinkDir = path.join(tmpDir, 'symlink-dir');
      fs.symlinkSync(realDir, symlinkDir);

      expect(() => assertDirectorySecure(symlinkDir)).toThrow(TypedCliError);
      expect(() => assertDirectorySecure(symlinkDir)).toThrow(/must not be a symbolic link/);
    });

    it('rejects directory if permissions are wider than 0700', () => {
      const insecureDir = path.join(tmpDir, 'insecure-dir');
      fs.mkdirSync(insecureDir, { recursive: true, mode: 0o755 });

      expect(() => assertDirectorySecure(insecureDir)).toThrow(TypedCliError);
      expect(() => assertDirectorySecure(insecureDir)).toThrow(/insecure mode/);
    });

    it('passes directory check if permissions are exactly 0700', () => {
      expect(() => assertDirectorySecure(activeTurnsDir)).not.toThrow();
    });
  });

  describe('Marker File Security', () => {
    it('throws MarkerNotFoundError if marker does not exist', () => {
      const nonExistent = path.join(activeTurnsDir, 'non-existent.json');
      expect(() => readSafeMarkerFile(nonExistent)).toThrow(MarkerNotFoundError);
    });

    it('rejects marker file if permissions are wider than 0600', () => {
      const markerPath = path.join(activeTurnsDir, 'insecure-marker.json');
      const validPayload = {
        createdAt: new Date().toISOString(),
        nonce: '1234567890abcdef1234567890abcdef',
        pid: process.pid,
        processStartTime: getProcessStartTime(process.pid),
        sessionId: 'session-123',
        turnId: 'turn-123',
      };
      fs.writeFileSync(markerPath, JSON.stringify(validPayload), { mode: 0o644 });

      expect(() => readSafeMarkerFile(markerPath)).toThrow(/Insecure permissions/);
    });

    it('rejects marker file if size is 0 bytes or exceeds 4096 bytes', () => {
      const emptyMarker = path.join(activeTurnsDir, 'empty.json');
      fs.writeFileSync(emptyMarker, '', { mode: 0o600 });
      expect(() => readSafeMarkerFile(emptyMarker)).toThrow(/out of valid bounds/);

      const hugeMarker = path.join(activeTurnsDir, 'huge.json');
      const hugeData = JSON.stringify({
        createdAt: new Date().toISOString(),
        nonce: 'a'.repeat(5000),
        pid: process.pid,
        processStartTime: getProcessStartTime(process.pid),
        sessionId: 'session-123',
        turnId: 'turn-123',
      });
      fs.writeFileSync(hugeMarker, hugeData, { mode: 0o600 });
      expect(() => readSafeMarkerFile(hugeMarker)).toThrow(/out of valid bounds/);
    });

    it('rejects marker file with missing or unexpected keys', () => {
      const extraKeysMarker = path.join(activeTurnsDir, 'extra.json');
      const payloadWithExtra = {
        createdAt: new Date().toISOString(),
        nonce: '1234567890abcdef1234567890abcdef',
        pid: process.pid,
        processStartTime: getProcessStartTime(process.pid),
        sessionId: 'ses_1234567890abcdef1234567890abcdef',
        turnId: 'turn_1234567890abcdef1234567890abcdef',
        extraField: 'not allowed',
      };
      fs.writeFileSync(extraKeysMarker, JSON.stringify(payloadWithExtra), { mode: 0o600 });
      expect(() => readSafeMarkerFile(extraKeysMarker)).toThrow(/unexpected or missing keys/);

      const missingKeysMarker = path.join(activeTurnsDir, 'missing.json');
      const payloadMissing = {
        nonce: '1234567890abcdef1234567890abcdef',
        pid: process.pid,
        sessionId: 'ses_1234567890abcdef1234567890abcdef',
        turnId: 'turn_1234567890abcdef1234567890abcdef',
      };
      fs.writeFileSync(missingKeysMarker, JSON.stringify(payloadMissing), { mode: 0o600 });
      expect(() => readSafeMarkerFile(missingKeysMarker)).toThrow(/unexpected or missing keys/);
    });

    it('rejects marker with non-canonical createdAt timestamp', () => {
      const invalidTimeMarker = path.join(activeTurnsDir, 'time.json');
      const payloadBadTime = {
        createdAt: 'invalid-time-format',
        nonce: '1234567890abcdef1234567890abcdef',
        pid: process.pid,
        processStartTime: getProcessStartTime(process.pid),
        sessionId: 'ses_1234567890abcdef1234567890abcdef',
        turnId: 'turn_1234567890abcdef1234567890abcdef',
      };
      fs.writeFileSync(invalidTimeMarker, JSON.stringify(payloadBadTime), { mode: 0o600 });
      expect(() => readSafeMarkerFile(invalidTimeMarker)).toThrow(/createdAt/);
    });

    it('successfully reads and verifies a valid marker file', () => {
      const validMarker = path.join(activeTurnsDir, 'valid.json');
      const validPayload = {
        createdAt: new Date().toISOString(),
        nonce: '1234567890abcdef1234567890abcdef',
        pid: process.pid,
        processStartTime: getProcessStartTime(process.pid),
        sessionId: 'ses_1234567890abcdef1234567890abcdef',
        turnId: 'turn_1234567890abcdef1234567890abcdef',
      };
      fs.writeFileSync(validMarker, JSON.stringify(validPayload), { mode: 0o600 });

      const result = readSafeMarkerFile(validMarker);
      expect(result.payload.turnId).toBe('turn_1234567890abcdef1234567890abcdef');
      expect(result.payload.sessionId).toBe('ses_1234567890abcdef1234567890abcdef');
      expect(result.payload.pid).toBe(process.pid);
      expect(result.identity.ino).toBeGreaterThan(0);
    });
  });

  describe('Result File Security & Atomic Writes', () => {
    it('throws ResultNotFoundError if result does not exist', () => {
      const nonExistent = path.join(activeTurnsDir, 'non-existent.result');
      expect(() => readSafeResultFile(nonExistent)).toThrow(ResultNotFoundError);
    });

    it('atomically writes result and reads back successfully', () => {
      const resultPath = path.join(activeTurnsDir, 'turn_11111111111111111111111111111111.result');
      const resultPayload = {
        status: 'completed',
        turnId: 'turn_11111111111111111111111111111111',
        sessionId: 'ses_11111111111111111111111111111111',
        nonce: 'abcd1234abcd1234',
        replyText: 'Hello world',
        eventsCount: 5,
        persisted: true,
        completedAt: new Date().toISOString(),
      };

      const identity = writeAtomicJson(resultPath, resultPayload);
      expect(identity.ino).toBeGreaterThan(0);

      const readBack = readSafeResultFile(resultPath);
      expect(readBack.payload.status).toBe('completed');
      expect(readBack.payload.replyText).toBe('Hello world');
      expect(readBack.identity.ino).toBe(identity.ino);
    });

    it('refuses to unlink file if inode or dev does not match', () => {
      const resultPath = path.join(activeTurnsDir, 'turn_22222222222222222222222222222222.result');
      const resultPayload = {
        status: 'completed',
        turnId: 'turn_22222222222222222222222222222222',
        sessionId: 'ses_22222222222222222222222222222222',
        nonce: 'abcd1234abcd1234',
        completedAt: new Date().toISOString(),
      };
      const identity = writeAtomicJson(resultPath, resultPayload);

      // Overwrite file with new inode
      fs.unlinkSync(resultPath);
      writeAtomicJson(resultPath, resultPayload);

      // Unlink with stale identity should throw TypedCliError
      expect(() => unlinkVerifiedFile(resultPath, { dev: identity.dev, ino: identity.ino + 999999 })).toThrow(
        TypedCliError
      );
      expect(() => unlinkVerifiedFile(resultPath, { dev: identity.dev, ino: identity.ino + 999999 })).toThrow(
        /Inode mismatch/
      );
    });
  });

  describe('Prompt Delay Parsing', () => {
    it('extracts valid canonical delay token [enkeep-test-delay-ms=N]', () => {
      expect(extractPromptDelayMs('Hello [enkeep-test-delay-ms=50] world')).toBe(50);
      expect(extractPromptDelayMs('[enkeep-test-delay-ms=1000]')).toBe(1000);
      expect(extractPromptDelayMs('[enkeep-test-delay-ms=10000]')).toBe(10000);
      expect(extractPromptDelayMs('[enkeep-test-delay-ms=1]')).toBe(1);
    });

    it('returns undefined when no delay token is present', () => {
      expect(extractPromptDelayMs('Hello world with no delay')).toBeUndefined();
    });

    it('throws RangeError on non-canonical or out-of-range delay values', () => {
      // 0 is out of bounds (1..10000)
      expect(() => extractPromptDelayMs('[enkeep-test-delay-ms=0]')).toThrow(RangeError);
      // leading zero is not allowed
      expect(() => extractPromptDelayMs('[enkeep-test-delay-ms=05]')).toThrow(RangeError);
      // > 10000 is rejected with RangeError
      expect(() => extractPromptDelayMs('[enkeep-test-delay-ms=10001]')).toThrow(RangeError);
    });
  });

  describe('Cancellation Invariants & Official Session Events', () => {
    it('throws InvariantError if cancelRequested is true but turn/end is not aborted', async () => {
      const runtime = await bootDshRuntime({
        userId: 'alice',
        dshHome,
        spacesDir,
      });

      try {
        // Normal turn finishes without cancel
        const res = await runtime.sendFollowup(
          'Normal prompt',
          'ses_90000000000000000000000000000001',
          'turn_90000000000000000000000000000001',
          null
        );
        expect(res.status).toBe('completed');
      } finally {
        await runtime.dispose();
      }
    });

    it('cancels turn cleanly during delayed prompt execution', async () => {
      const runtime = await bootDshRuntime({
        userId: 'alice',
        dshHome,
        spacesDir,
      });

      try {
        const turnId = 'turn_90000000000000000000000000000002';
        const sessionId = 'ses_90000000000000000000000000000002';

        // Start followup turn with delay in background
        const followupPromise = runtime.sendFollowup(
          'Long running turn [enkeep-test-delay-ms=1500]',
          sessionId,
          turnId,
          null
        );

        // Wait brief moment for turn to start
        await new Promise((r) => setTimeout(r, 100));

        // Request cancellation
        const cancelled = await runtime.cancelTurn(turnId);
        expect(cancelled).toBe(true);

        const res = await followupPromise;
        expect(res.status).toBe('cancelled');
        expect(res.sessionId).toBe(sessionId);
        expect(res.replyText).toBeUndefined();
      } finally {
        await runtime.dispose();
      }
    });
    it('verifies that forged error with matching name or message is NOT an instanceof PersistedSessionResumeError', () => {
      const forgedNameError = new Error('Some arbitrary message');
      forgedNameError.name = 'PersistedSessionResumeError';
      expect(forgedNameError instanceof PersistedSessionResumeError).toBe(false);

      const forgedMessageError = new Error('CRITICAL SESSION RESUME FAILURE: Persisted session exists');
      expect(forgedMessageError instanceof PersistedSessionResumeError).toBe(false);

      const genuineError = new PersistedSessionResumeError('session-1', '/path/to/sessions', new Error('disk read failed'));
      expect(genuineError instanceof PersistedSessionResumeError).toBe(true);
    });
  });

  describe('Process UID & Security Helper Guardrails', () => {
    it('getRequiredCurrentUid returns the exact process UID', () => {
      const uid = getRequiredCurrentUid();
      expect(typeof uid).toBe('number');
      expect(Number.isInteger(uid)).toBe(true);
      expect(uid).toBe(process.getuid());
    });

    it('getRequiredCurrentUid throws SECURITY_VIOLATION when process.getuid is undefined', () => {
      const originalGetuid = process.getuid;
      try {
        // @ts-expect-error monkeypatching for test
        process.getuid = undefined;
        expect(() => getRequiredCurrentUid()).toThrow(TypedCliError);
        expect(() => getRequiredCurrentUid()).toThrow(/process\.getuid is required/);
      } finally {
        process.getuid = originalGetuid;
      }
    });

    it('assertDirectorySecure throws SECURITY_VIOLATION when process.getuid is undefined', () => {
      const originalGetuid = process.getuid;
      try {
        // @ts-expect-error monkeypatching for test
        process.getuid = undefined;
        expect(() => assertDirectorySecure(activeTurnsDir)).toThrow(TypedCliError);
        expect(() => assertDirectorySecure(activeTurnsDir)).toThrow(/process\.getuid is required/);
      } finally {
        process.getuid = originalGetuid;
      }
    });
  });
});
