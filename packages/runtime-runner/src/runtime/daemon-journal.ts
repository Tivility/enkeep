/**
 * Daemon Crash Journal & Turn Idempotency Store
 *
 * Persists atomic, crash-resilient turn execution state at:
 * `$DSH_HOME/daemon-turns/<turnId>.json` with mode 0o600, fsync, and atomic rename.
 *
 * States: `accepted` -> `executing` -> `completed` | `cancelled` | `failed`
 *
 * Security guarantees:
 * - Strict turnId canonical validation and path traversal prevention.
 * - Does NOT duplicate or persist raw prompt plaintext in the journal (session JSONL holds prompt).
 *   Stores only cryptographic SHA-256 promptHash and byte length.
 * - Caps completed result payload at 64 KiB to prevent disk DOS.
 * - Strict schema validation on reading existing records.
 * - Directory descriptor fsync guarantees durable directory metadata persistence.
 *
 * @module @enkeep/runtime-runner/runtime/daemon-journal
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AgentFollowupResponse } from '../transport/types.js';
import { isValidTurnId, isValidSessionId } from './dsh-boot.js';

export const MAX_JOURNAL_RESULT_SIZE = 64 * 1024; // 64 KiB result payload limit

export type JournalTurnStatus = 'accepted' | 'executing' | 'completed' | 'cancelled' | 'failed';

export const VALID_JOURNAL_STATUSES = new Set<string>([
  'accepted',
  'executing',
  'completed',
  'cancelled',
  'failed',
]);

export interface JournalTurnRecord {
  readonly turnId: string;
  readonly sessionId: string;
  readonly status: JournalTurnStatus;
  readonly promptHash?: string;
  readonly promptBytes?: number;
  readonly workspaceFolder?: string;
  readonly pid: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
  readonly result?: AgentFollowupResponse;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

/**
 * Validates the strict schema of a journal turn record parsed from disk.
 */
export function validateJournalRecordSchema(data: unknown): data is JournalTurnRecord {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return false;
  }
  const r = data as Record<string, unknown>;
  if (typeof r['turnId'] !== 'string' || !isValidTurnId(r['turnId'])) {
    return false;
  }
  if (typeof r['sessionId'] !== 'string' || !isValidSessionId(r['sessionId'])) {
    return false;
  }
  if (typeof r['status'] !== 'string' || !VALID_JOURNAL_STATUSES.has(r['status'])) {
    return false;
  }
  if (typeof r['pid'] !== 'number' || !Number.isInteger(r['pid']) || r['pid'] <= 0) {
    return false;
  }
  if (typeof r['createdAt'] !== 'string' || !r['createdAt']) {
    return false;
  }
  if (typeof r['updatedAt'] !== 'string' || !r['updatedAt']) {
    return false;
  }
  if (r['promptHash'] !== undefined && (typeof r['promptHash'] !== 'string' || !/^[0-9a-f]{64}$/.test(r['promptHash']))) {
    return false;
  }
  if (r['promptBytes'] !== undefined && (typeof r['promptBytes'] !== 'number' || !Number.isSafeInteger(r['promptBytes']) || r['promptBytes'] < 0)) {
    return false;
  }
  if (r['workspaceFolder'] !== undefined && typeof r['workspaceFolder'] !== 'string') {
    return false;
  }
  if (r['completedAt'] !== undefined && typeof r['completedAt'] !== 'string') {
    return false;
  }
  if (r['error'] !== undefined) {
    if (!r['error'] || typeof r['error'] !== 'object' || Array.isArray(r['error'])) {
      return false;
    }
    const err = r['error'] as Record<string, unknown>;
    if (typeof err['code'] !== 'string' || typeof err['message'] !== 'string') {
      return false;
    }
  }
  return true;
}

/**
 * Sanitizes an AgentFollowupResponse to ensure it does not exceed size limits or leak secrets.
 */
export function sanitizeJournalResult(result: AgentFollowupResponse): AgentFollowupResponse {
  const json = JSON.stringify(result);
  if (Buffer.byteLength(json, 'utf8') <= MAX_JOURNAL_RESULT_SIZE) {
    return result;
  }

  if (result.status === 'completed') {
    const truncatedReply = result.replyText.slice(0, MAX_JOURNAL_RESULT_SIZE - 2048) + '\n[TRUNCATED IN JOURNAL]';
    return {
      ...result,
      replyText: truncatedReply,
    };
  }

  return result;
}

export class DaemonTurnJournal {
  private readonly turnsDir: string;

  constructor(readonly dshHome: string) {
    this.turnsDir = path.join(dshHome, 'daemon-turns');
    this.ensureDirectory();
  }

  private ensureDirectory(): void {
    if (!fs.existsSync(this.turnsDir)) {
      fs.mkdirSync(this.turnsDir, { recursive: true, mode: 0o700 });
    }
    try {
      fs.chmodSync(this.turnsDir, 0o700);
    } catch {}
  }

  private getTurnPath(turnId: string): string {
    if (!isValidTurnId(turnId)) {
      throw new TypeError(`Invalid turn ID format: "${turnId}"`);
    }
    const resolved = path.join(this.turnsDir, `${turnId}.json`);
    if (path.dirname(resolved) !== path.normalize(this.turnsDir)) {
      throw new Error(`Security violation: path traversal detected for turnId "${turnId}"`);
    }
    return resolved;
  }

  /**
   * Atomically writes a journal record to disk with 0o600 permissions, file fsync, and directory fsync.
   */
  private writeAtomic(turnId: string, record: JournalTurnRecord): void {
    this.ensureDirectory();
    const finalPath = this.getTurnPath(turnId);
    const tmpPath = path.join(this.turnsDir, `${turnId}.${crypto.randomBytes(8).toString('hex')}.tmp`);

    const jsonContent = JSON.stringify(record, null, 2);
    let fd: number | null = null;
    try {
      fd = fs.openSync(
        tmpPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
        0o600
      );
      const buf = Buffer.from(jsonContent, 'utf8');
      let written = 0;
      while (written < buf.length) {
        written += fs.writeSync(fd, buf, written, buf.length - written, written);
      }
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;

      fs.chmodSync(tmpPath, 0o600);
      fs.renameSync(tmpPath, finalPath);

      // Fsync directory descriptor to guarantee durable directory metadata persistence
      try {
        const dirFd = fs.openSync(this.turnsDir, fs.constants.O_RDONLY);
        try {
          fs.fsyncSync(dirFd);
        } finally {
          fs.closeSync(dirFd);
        }
      } catch {}
    } catch (err: unknown) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
      try {
        if (fs.existsSync(tmpPath)) {
          fs.unlinkSync(tmpPath);
        }
      } catch {}
      throw err;
    }
  }

  /**
   * Reads and validates a turn record from disk if it exists.
   */
  public get(turnId: string): JournalTurnRecord | null {
    try {
      const turnPath = this.getTurnPath(turnId);
      if (!fs.existsSync(turnPath)) {
        return null;
      }
      const raw = fs.readFileSync(turnPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (validateJournalRecordSchema(parsed) && parsed.turnId === turnId) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Records initial acceptance of a turn request without duplicating prompt plaintext.
   */
  public recordAccepted(options: {
    turnId: string;
    sessionId: string;
    prompt?: string;
    workspaceFolder?: string;
  }): JournalTurnRecord {
    const { turnId, sessionId, prompt, workspaceFolder } = options;
    const now = new Date().toISOString();

    const promptHash = prompt
      ? crypto.createHash('sha256').update(prompt, 'utf8').digest('hex')
      : undefined;
    const promptBytes = prompt ? Buffer.byteLength(prompt, 'utf8') : undefined;

    const record: JournalTurnRecord = {
      turnId,
      sessionId,
      status: 'accepted',
      promptHash,
      promptBytes,
      workspaceFolder,
      pid: process.pid,
      createdAt: now,
      updatedAt: now,
    };

    this.writeAtomic(turnId, record);
    return record;
  }

  /**
   * Transitions turn status to executing.
   */
  public recordExecuting(turnId: string, sessionId: string): JournalTurnRecord {
    const existing = this.get(turnId);
    const now = new Date().toISOString();

    const record: JournalTurnRecord = {
      turnId,
      sessionId,
      status: 'executing',
      promptHash: existing?.promptHash,
      promptBytes: existing?.promptBytes,
      workspaceFolder: existing?.workspaceFolder,
      pid: process.pid,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.writeAtomic(turnId, record);
    return record;
  }

  /**
   * Transitions turn status to completed with the safe sanitized response.
   */
  public recordCompleted(turnId: string, sessionId: string, result: AgentFollowupResponse): JournalTurnRecord {
    const existing = this.get(turnId);
    const now = new Date().toISOString();
    const sanitizedResult = sanitizeJournalResult(result);

    const record: JournalTurnRecord = {
      turnId,
      sessionId,
      status: 'completed',
      promptHash: existing?.promptHash,
      promptBytes: existing?.promptBytes,
      workspaceFolder: existing?.workspaceFolder,
      pid: process.pid,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      completedAt: now,
      result: sanitizedResult,
    };

    this.writeAtomic(turnId, record);
    return record;
  }

  /**
   * Transitions turn status to cancelled.
   */
  public recordCancelled(turnId: string, sessionId: string, reason?: string): JournalTurnRecord {
    const existing = this.get(turnId);
    const now = new Date().toISOString();

    const record: JournalTurnRecord = {
      turnId,
      sessionId,
      status: 'cancelled',
      promptHash: existing?.promptHash,
      promptBytes: existing?.promptBytes,
      workspaceFolder: existing?.workspaceFolder,
      pid: process.pid,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      completedAt: now,
      error: reason ? { code: 'CANCELLED', message: reason } : undefined,
    };

    this.writeAtomic(turnId, record);
    return record;
  }

  /**
   * Transitions turn status to failed with error details.
   */
  public recordFailed(turnId: string, sessionId: string, code: string, message: string): JournalTurnRecord {
    const existing = this.get(turnId);
    const now = new Date().toISOString();

    const record: JournalTurnRecord = {
      turnId,
      sessionId,
      status: 'failed',
      promptHash: existing?.promptHash,
      promptBytes: existing?.promptBytes,
      workspaceFolder: existing?.workspaceFolder,
      pid: process.pid,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      completedAt: now,
      error: { code, message },
    };

    this.writeAtomic(turnId, record);
    return record;
  }

  /**
   * Sweeps existing journals on startup to repair any unclosed in-flight records from prior crashes.
   */
  public recoverOnStartup(): { recoveredCount: number; unclosedCount: number } {
    let recoveredCount = 0;
    let unclosedCount = 0;

    try {
      if (!fs.existsSync(this.turnsDir)) {
        return { recoveredCount: 0, unclosedCount: 0 };
      }

      const files = fs.readdirSync(this.turnsDir);
      for (const file of files) {
        if (file.endsWith('.tmp')) {
          try {
            fs.unlinkSync(path.join(this.turnsDir, file));
          } catch {}
          continue;
        }

        if (!file.endsWith('.json')) continue;
        const turnId = file.replace(/\.json$/, '');
        if (!isValidTurnId(turnId)) continue;

        const record = this.get(turnId);
        if (!record) continue;

        if (record.status === 'executing' || record.status === 'accepted') {
          unclosedCount++;
          // Mark crash failure for turns that were executing when prior daemon died
          this.recordFailed(
            turnId,
            record.sessionId,
            'DAEMON_CRASH_RECOVERED',
            'Turn was interrupted by daemon process termination'
          );
          recoveredCount++;
        }
      }
    } catch {}

    return { recoveredCount, unclosedCount };
  }
}
