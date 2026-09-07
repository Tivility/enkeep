/**
 * Attachment Snapshot Journal Crash Recovery & GC Service
 *
 * Scans `attachment_snapshot_journal` on startup:
 * 1. Resolves `staging` rows:
 *    - Snapshot missing -> marks journal status `aborted`.
 *    - Snapshot exists with expected hash -> effectively copied:
 *      * If referenced by `message_attachments` with matching etag/size -> marks `linked`.
 *      * If unreferenced and no active journals -> deletes snapshot with expected ETag and marks `cleaned`.
 *      * If unreferenced but shared with active journal -> preserves snapshot and marks `cleaned`.
 *    - Snapshot exists with wrong hash -> logs safe structured error `SNAPSHOT_HASH_MISMATCH` and keeps `staging`.
 * 2. Resolves `copied` rows:
 *    - If referenced by `message_attachments`:
 *      * Snapshot exists + expected hash + ref etag/size matches -> marks `linked`.
 *      * Snapshot missing / hash mismatch / ref mismatch -> logs safe error and keeps `copied` (failclosed).
 *    - If unreferenced by `message_attachments`:
 *      * Snapshot missing -> marks `cleaned`.
 *      * Snapshot exists with wrong hash -> logs safe error `SNAPSHOT_HASH_MISMATCH` and keeps `copied`.
 *      * Snapshot exists + expected hash -> deletes snapshot if refcount is 0 & no active journals, marks `cleaned`.
 *      * If deletion fails (e.g. permission error) -> keeps `copied` and logs `DELETE_FAILED`.
 * 3. Resolves `cleanup_pending` rows:
 *    - If referenced or active journal exists -> preserves snapshot and marks `cleaned`.
 *    - If unreferenced -> deletes snapshot; on success/NotFound marks `cleaned`. On error keeps `cleanup_pending`.
 *
 * Invariants:
 * - Deterministic, idempotent crash recovery.
 * - Zero whole-file memory buffering.
 * - Refcount-aware & Dedup-aware: Never deletes a content-addressed snapshot if ANY message ref or active journal exists.
 * - Race-safe SQLite BEGIN IMMEDIATE claims.
 * - Strict row parsing and safe structured error reporting ({ journalId, code, stage }) without raw messages or paths.
 *
 * @module @enkeep/platform-server/storage/attachment-snapshot-recovery
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  PlatformError,
  NotFoundError,
  ValidationError,
} from '@enkeep/platform-core';
import {
  SPACE_ID_REGEX,
  USER_ID_REGEX,
  type CanonicalFileOperationRequest,
  type CanonicalFileOperationResult,
  type RuntimeFileApiService,
  type TenantRuntimeFileProvider,
} from '../files/runtime-file-api.js';

export const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;
export const ATTACHMENT_JOURNAL_STATUSES = ['staging', 'copied', 'linked', 'cleanup_pending', 'cleaned', 'aborted'] as const;
export type JournalStatus = (typeof ATTACHMENT_JOURNAL_STATUSES)[number];

export interface AttachmentSnapshotJournalEntry {
  readonly id: string;
  readonly deliveryId: string;
  readonly userId: string;
  readonly spaceId: string;
  readonly sourcePath: string;
  readonly snapshotPath: string;
  readonly contentSha256: string;
  readonly size: number;
  readonly status: JournalStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AttachmentSnapshotRecoveryError {
  readonly journalId: string;
  readonly code: string;
  readonly stage: string;
}

export interface AttachmentSnapshotRecoveryReport {
  readonly totalScanned: number;
  readonly abortedStaging: number;
  readonly linkedCopied: number;
  readonly cleanedOrphans: number;
  readonly errors: ReadonlyArray<AttachmentSnapshotRecoveryError>;
}

export interface SnapshotInspection {
  readonly snapshotExists: boolean;
  readonly snapshotEtag: string | null;
  readonly snapshotSize: number | null;
  readonly snapshotMatchesExpected: boolean;
  readonly sourceExists: boolean;
  readonly sourceEtag: string | null;
  readonly sourceSize: number | null;
}

function isStrictString(val: unknown): val is string {
  return typeof val === 'string' && val.length > 0 && val.normalize('NFC') === val;
}

/**
 * Strictly parses and validates a raw database row into a AttachmentSnapshotJournalEntry.
 */
export function parseJournalRow(row: unknown): AttachmentSnapshotJournalEntry {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new ValidationError('Invalid attachment snapshot journal row: not an object');
  }
  const r = row as Record<string, unknown>;

  if (!isStrictString(r.id)) {
    throw new ValidationError('Invalid journal row: id must be a non-empty NFC string');
  }
  if (!isStrictString(r.delivery_id)) {
    throw new ValidationError('Invalid journal row: delivery_id must be a non-empty NFC string');
  }
  if (!isStrictString(r.user_id) || !USER_ID_REGEX.test(r.user_id)) {
    throw new ValidationError('Invalid journal row: user_id must match valid user format');
  }
  if (!isStrictString(r.space_id) || !SPACE_ID_REGEX.test(r.space_id)) {
    throw new ValidationError('Invalid journal row: space_id must match valid space format');
  }
  if (!isStrictString(r.source_path)) {
    throw new ValidationError('Invalid journal row: source_path must be a non-empty NFC string');
  }
  if (!isStrictString(r.snapshot_path)) {
    throw new ValidationError('Invalid journal row: snapshot_path must be a non-empty NFC string');
  }
  if (typeof r.content_sha256 !== 'string' || !SHA256_HEX_REGEX.test(r.content_sha256)) {
    throw new ValidationError('Invalid journal row: content_sha256 must be a 64-char lowercase hex string');
  }
  const size = typeof r.size === 'number' ? r.size : typeof r.size === 'bigint' ? Number(r.size) : NaN;
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new ValidationError('Invalid journal row: size must be a non-negative safe integer');
  }
  if (typeof r.status !== 'string' || !(ATTACHMENT_JOURNAL_STATUSES as readonly string[]).includes(r.status)) {
    throw new ValidationError('Invalid journal row: invalid status');
  }
  if (typeof r.created_at !== 'string' || typeof r.updated_at !== 'string') {
    throw new ValidationError('Invalid journal row: invalid timestamp');
  }

  return {
    id: r.id,
    deliveryId: r.delivery_id,
    userId: r.user_id,
    spaceId: r.space_id,
    sourcePath: r.source_path,
    snapshotPath: r.snapshot_path,
    contentSha256: r.content_sha256,
    size,
    status: r.status as JournalStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class AttachmentSnapshotRecoveryService {
  private readonly db: DatabaseSync;
  private readonly fileService?: RuntimeFileApiService;
  private readonly fileProvider?: TenantRuntimeFileProvider;

  constructor(
    db: DatabaseSync,
    options: { fileService?: RuntimeFileApiService; fileProvider?: TenantRuntimeFileProvider }
  ) {
    this.db = db;
    this.fileService = options.fileService;
    this.fileProvider = options.fileProvider;
  }

  private isNotFoundError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    if (err instanceof NotFoundError) return true;
    const code = (err as { code?: unknown }).code;
    return code === 'NOT_FOUND' || code === 'FS_NOT_FOUND' || code === 'ENOENT';
  }

  private async executeFileOp(
    userId: string,
    spaceId: string,
    req: CanonicalFileOperationRequest
  ): Promise<CanonicalFileOperationResult> {
    if (this.fileService) {
      return this.fileService.execute(userId, spaceId, req);
    }
    if (this.fileProvider) {
      return this.fileProvider.execute(userId, spaceId, req);
    }
    throw new PlatformError('No file provider configured for recovery', 'SERVICE_UNAVAILABLE', 503);
  }

  /**
   * Inspects snapshot state on the provider without buffering file content in memory.
   */
  private async inspectSnapshot(
    userId: string,
    spaceId: string,
    sourcePath: string,
    snapshotPath: string,
    expectedSha: string
  ): Promise<SnapshotInspection> {
    if (this.fileService) {
      const res = await this.fileService.inspectSnapshotState(userId, spaceId, {
        sourcePath,
        snapshotPath,
        expectedContentSha256: expectedSha,
      });
      return {
        snapshotExists: res.snapshotExists,
        snapshotEtag: res.snapshotEtag ?? null,
        snapshotSize: res.snapshotSize ?? null,
        snapshotMatchesExpected: res.snapshotMatchesExpected,
        sourceExists: res.sourceExists,
        sourceEtag: res.sourceEtag ?? null,
        sourceSize: res.sourceSize ?? null,
      };
    }

    if (this.fileProvider) {
      if (typeof this.fileProvider.inspectSnapshotState === 'function') {
        const res = await this.fileProvider.inspectSnapshotState(userId, spaceId, {
          op: 'inspect_snapshot_state',
          sourcePath,
          snapshotPath,
          expectedContentSha256: expectedSha,
        });
        const snapHash = res.snapshotHash ?? (res.snapshotEtag ? res.snapshotEtag.replace(/^"|"$/g, '').toLowerCase() : null);
        const matches = res.snapshotMatchesExpected ?? (snapHash === expectedSha.toLowerCase());
        return {
          snapshotExists: res.snapshotExists,
          snapshotEtag: res.snapshotEtag ?? null,
          snapshotSize: res.snapshotSize ?? null,
          snapshotMatchesExpected: matches,
          sourceExists: res.sourceExists ?? false,
          sourceEtag: res.sourceEtag ?? null,
          sourceSize: res.sourceSize ?? null,
        };
      }

      // Fallback inspect via stat without buffering file into memory
      let snapshotExists = false;
      let snapshotEtag: string | null = null;
      let snapshotSize: number | null = null;
      let snapshotMatchesExpected = false;

      try {
        const snapStat = await this.fileProvider.execute(userId, spaceId, {
          op: 'stat',
          path: snapshotPath,
        });
        if (snapStat && snapStat.op === 'stat') {
          snapshotExists = true;
          snapshotEtag = snapStat.etag;
          snapshotSize = snapStat.size;
          const snapHash = snapStat.etag ? snapStat.etag.replace(/^"|"$/g, '').toLowerCase() : null;
          snapshotMatchesExpected = snapHash === expectedSha.toLowerCase();
        }
      } catch (err: unknown) {
        if (this.isNotFoundError(err)) {
          snapshotExists = false;
        } else {
          throw err;
        }
      }

      let sourceExists = false;
      let sourceEtag: string | null = null;
      let sourceSize: number | null = null;

      try {
        const srcStat = await this.fileProvider.execute(userId, spaceId, {
          op: 'stat',
          path: sourcePath,
        });
        if (srcStat && srcStat.op === 'stat') {
          sourceExists = true;
          sourceEtag = srcStat.etag;
          sourceSize = srcStat.size;
        }
      } catch (err: unknown) {
        if (this.isNotFoundError(err)) {
          sourceExists = false;
        } else {
          sourceExists = false;
        }
      }

      return {
        snapshotExists,
        snapshotEtag,
        snapshotSize,
        snapshotMatchesExpected,
        sourceExists,
        sourceEtag,
        sourceSize,
      };
    }

    throw new PlatformError('No file provider configured for recovery', 'SERVICE_UNAVAILABLE', 503);
  }

  /**
   * Attempts physical deletion of a snapshot file. Returns success status.
   */
  private async tryDeleteSnapshot(
    userId: string,
    spaceId: string,
    snapshotPath: string,
    expectedEtag?: string | null
  ): Promise<{ success: boolean; deletedOrMissing: boolean }> {
    try {
      let etag = expectedEtag;
      if (!etag) {
        const statRes = await this.executeFileOp(userId, spaceId, {
          op: 'stat',
          path: snapshotPath,
        });
        if (statRes && (statRes as any).etag) {
          etag = (statRes as any).etag;
        }
      }

      if (etag) {
        const cleanEtag = etag.startsWith('"') ? etag : `"${etag}"`;
        await this.executeFileOp(userId, spaceId, {
          op: 'delete',
          path: snapshotPath,
          expectedEtag: cleanEtag,
        });
      }
      return { success: true, deletedOrMissing: true };
    } catch (delErr: unknown) {
      if (this.isNotFoundError(delErr)) {
        return { success: true, deletedOrMissing: true };
      }
      return { success: false, deletedOrMissing: false };
    }
  }

  /**
   * Checks if any message or any other active journal entry references the content-addressed snapshot.
   */
  private hasOtherActiveJournalOrMessageRef(
    spaceId: string,
    snapshotPath: string,
    currentJournalId: string
  ): { hasMessageRef: boolean; hasActiveJournal: boolean } {
    const msgCheck = this.db.prepare(`
      SELECT count(*) as count
      FROM message_attachments
      WHERE space_id = ? AND snapshot_path = ?
    `).get(spaceId, snapshotPath) as { count: number } | undefined;
    const hasMessageRef = Boolean(msgCheck && msgCheck.count > 0);

    const journalCheck = this.db.prepare(`
      SELECT count(*) as count
      FROM attachment_snapshot_journal
      WHERE space_id = ? AND snapshot_path = ? AND id != ? AND status IN ('staging', 'copied', 'linked')
    `).get(spaceId, snapshotPath, currentJournalId) as { count: number } | undefined;
    const hasActiveJournal = Boolean(journalCheck && journalCheck.count > 0);

    return { hasMessageRef, hasActiveJournal };
  }

  /**
   * Scans and recovers pending attachment snapshot journal entries on server startup.
   */
  async recover(): Promise<AttachmentSnapshotRecoveryReport> {
    const hasTable = this.db.prepare(`
      SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='attachment_snapshot_journal'
    `).get() as { count: number } | undefined;

    if (!hasTable || hasTable.count === 0) {
      return { totalScanned: 0, abortedStaging: 0, linkedCopied: 0, cleanedOrphans: 0, errors: [] };
    }

    const rawRows = this.db.prepare(`
      SELECT id, delivery_id, user_id, space_id, source_path, snapshot_path, content_sha256, size, status, created_at, updated_at
      FROM attachment_snapshot_journal
      WHERE status IN ('staging', 'copied', 'cleanup_pending')
      ORDER BY created_at ASC
    `).all();

    let abortedStaging = 0;
    let linkedCopied = 0;
    let cleanedOrphans = 0;
    const errors: Array<AttachmentSnapshotRecoveryError> = [];

    for (const rawRow of rawRows) {
      let entry: AttachmentSnapshotJournalEntry;
      try {
        entry = parseJournalRow(rawRow);
      } catch {
        const rawObj = (rawRow && typeof rawRow === 'object' && !Array.isArray(rawRow)) ? (rawRow as Record<string, unknown>) : {};
        const rowId = typeof rawObj.id === 'string' ? rawObj.id : 'unknown';
        errors.push({
          journalId: rowId,
          code: 'INVALID_JOURNAL_ROW',
          stage: 'row_parse',
        });
        continue;
      }

      try {
        if (entry.status === 'staging') {
          let inspection: SnapshotInspection;
          try {
            inspection = await this.inspectSnapshot(
              entry.userId,
              entry.spaceId,
              entry.sourcePath,
              entry.snapshotPath,
              entry.contentSha256
            );
          } catch {
            errors.push({
              journalId: entry.id,
              code: 'INSPECT_FAILED',
              stage: 'staging_inspect',
            });
            continue;
          }

          // Branch 2b: snapshot missing -> aborted
          if (!inspection.snapshotExists) {
            let startedTx = false;
            try {
              this.db.exec('BEGIN IMMEDIATE');
              startedTx = true;
              this.db.prepare(`
                UPDATE attachment_snapshot_journal
                SET status = 'aborted', updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
              `).run(entry.id);
              this.db.exec('COMMIT');
              startedTx = false;
              abortedStaging++;
            } catch {
              if (startedTx) {
                try { this.db.exec('ROLLBACK'); } catch {}
              }
              errors.push({
                journalId: entry.id,
                code: 'DB_UPDATE_FAILED',
                stage: 'staging_abort',
              });
            }
          } else if (!inspection.snapshotMatchesExpected) {
            // Branch 2c: snapshot exists wrong hash -> safe error keep staging,不可删未知
            errors.push({
              journalId: entry.id,
              code: 'SNAPSHOT_HASH_MISMATCH',
              stage: 'staging_verify',
            });
          } else {
            // Branch 2a: snapshot exists expected hash -> effectively copied
            const refRows = this.db.prepare(`
              SELECT id, etag, size
              FROM message_attachments
              WHERE space_id = ? AND snapshot_path = ?
            `).all(entry.spaceId, entry.snapshotPath) as unknown as Array<{ id: string; etag: string; size: number }>;

            if (refRows.length > 0) {
              const firstRef = refRows[0];
              const refEtagClean = firstRef.etag.replace(/^"|"$/g, '').toLowerCase();
              const shaClean = entry.contentSha256.toLowerCase();
              const refSize = Number(firstRef.size);

              if (refEtagClean === shaClean && refSize === entry.size) {
                let startedTx = false;
                try {
                  this.db.exec('BEGIN IMMEDIATE');
                  startedTx = true;
                  this.db.prepare(`
                    UPDATE attachment_snapshot_journal
                    SET status = 'linked', updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                  `).run(entry.id);
                  this.db.exec('COMMIT');
                  startedTx = false;
                  linkedCopied++;
                } catch {
                  if (startedTx) {
                    try { this.db.exec('ROLLBACK'); } catch {}
                  }
                  errors.push({
                    journalId: entry.id,
                    code: 'DB_UPDATE_FAILED',
                    stage: 'staging_link',
                  });
                }
              } else {
                // Ref mismatch failclosed
                errors.push({
                  journalId: entry.id,
                  code: 'ATTACHMENT_REF_MISMATCH',
                  stage: 'staging_link',
                });
              }
            } else {
              // Unreferenced
              const { hasActiveJournal } = this.hasOtherActiveJournalOrMessageRef(entry.spaceId, entry.snapshotPath, entry.id);
              if (hasActiveJournal) {
                let startedTx = false;
                try {
                  this.db.exec('BEGIN IMMEDIATE');
                  startedTx = true;
                  this.db.prepare(`
                    UPDATE attachment_snapshot_journal
                    SET status = 'cleaned', updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                  `).run(entry.id);
                  this.db.exec('COMMIT');
                  startedTx = false;
                  cleanedOrphans++;
                } catch {
                  if (startedTx) {
                    try { this.db.exec('ROLLBACK'); } catch {}
                  }
                  errors.push({
                    journalId: entry.id,
                    code: 'DB_UPDATE_FAILED',
                    stage: 'staging_cleanup',
                  });
                }
              } else {
                const delResult = await this.tryDeleteSnapshot(
                  entry.userId,
                  entry.spaceId,
                  entry.snapshotPath,
                  inspection.snapshotEtag
                );
                if (delResult.success) {
                  let startedTx = false;
                  try {
                    this.db.exec('BEGIN IMMEDIATE');
                    startedTx = true;
                    this.db.prepare(`
                      UPDATE attachment_snapshot_journal
                      SET status = 'cleaned', updated_at = CURRENT_TIMESTAMP
                      WHERE id = ?
                    `).run(entry.id);
                    this.db.exec('COMMIT');
                    startedTx = false;
                    cleanedOrphans++;
                  } catch {
                    if (startedTx) {
                      try { this.db.exec('ROLLBACK'); } catch {}
                    }
                    errors.push({
                      journalId: entry.id,
                      code: 'DB_UPDATE_FAILED',
                      stage: 'staging_cleanup',
                    });
                  }
                } else {
                  errors.push({
                    journalId: entry.id,
                    code: 'DELETE_FAILED',
                    stage: 'staging_cleanup',
                  });
                }
              }
            }
          }
        } else if (entry.status === 'copied') {
          let inspection: SnapshotInspection;
          try {
            inspection = await this.inspectSnapshot(
              entry.userId,
              entry.spaceId,
              entry.sourcePath,
              entry.snapshotPath,
              entry.contentSha256
            );
          } catch {
            errors.push({
              journalId: entry.id,
              code: 'INSPECT_FAILED',
              stage: 'copied_inspect',
            });
            continue;
          }

          const refRows = this.db.prepare(`
            SELECT id, etag, size
            FROM message_attachments
            WHERE space_id = ? AND snapshot_path = ?
          `).all(entry.spaceId, entry.snapshotPath) as unknown as Array<{ id: string; etag: string; size: number }>;

          if (refRows.length > 0) {
            if (!inspection.snapshotExists) {
              errors.push({
                journalId: entry.id,
                code: 'SNAPSHOT_MISSING',
                stage: 'copied_verify',
              });
            } else if (!inspection.snapshotMatchesExpected) {
              errors.push({
                journalId: entry.id,
                code: 'SNAPSHOT_HASH_MISMATCH',
                stage: 'copied_verify',
              });
            } else {
              const firstRef = refRows[0];
              const refEtagClean = firstRef.etag.replace(/^"|"$/g, '').toLowerCase();
              const shaClean = entry.contentSha256.toLowerCase();
              const refSize = Number(firstRef.size);

              if (refEtagClean === shaClean && refSize === entry.size) {
                let startedTx = false;
                try {
                  this.db.exec('BEGIN IMMEDIATE');
                  startedTx = true;
                  this.db.prepare(`
                    UPDATE attachment_snapshot_journal
                    SET status = 'linked', updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                  `).run(entry.id);
                  this.db.exec('COMMIT');
                  startedTx = false;
                  linkedCopied++;
                } catch {
                  if (startedTx) {
                    try { this.db.exec('ROLLBACK'); } catch {}
                  }
                  errors.push({
                    journalId: entry.id,
                    code: 'DB_UPDATE_FAILED',
                    stage: 'copied_link',
                  });
                }
              } else {
                errors.push({
                  journalId: entry.id,
                  code: 'ATTACHMENT_REF_MISMATCH',
                  stage: 'copied_verify',
                });
              }
            }
          } else {
            // Orphan
            if (inspection.snapshotExists && !inspection.snapshotMatchesExpected) {
              errors.push({
                journalId: entry.id,
                code: 'SNAPSHOT_HASH_MISMATCH',
                stage: 'copied_verify',
              });
            } else if (!inspection.snapshotExists) {
              let startedTx = false;
              try {
                this.db.exec('BEGIN IMMEDIATE');
                startedTx = true;
                this.db.prepare(`
                  UPDATE attachment_snapshot_journal
                  SET status = 'cleaned', updated_at = CURRENT_TIMESTAMP
                  WHERE id = ?
                `).run(entry.id);
                this.db.exec('COMMIT');
                startedTx = false;
                cleanedOrphans++;
              } catch {
                if (startedTx) {
                  try { this.db.exec('ROLLBACK'); } catch {}
                }
                errors.push({
                  journalId: entry.id,
                  code: 'DB_UPDATE_FAILED',
                  stage: 'copied_cleanup',
                });
              }
            } else {
              const { hasActiveJournal } = this.hasOtherActiveJournalOrMessageRef(entry.spaceId, entry.snapshotPath, entry.id);
              if (hasActiveJournal) {
                let startedTx = false;
                try {
                  this.db.exec('BEGIN IMMEDIATE');
                  startedTx = true;
                  this.db.prepare(`
                    UPDATE attachment_snapshot_journal
                    SET status = 'cleaned', updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                  `).run(entry.id);
                  this.db.exec('COMMIT');
                  startedTx = false;
                  cleanedOrphans++;
                } catch {
                  if (startedTx) {
                    try { this.db.exec('ROLLBACK'); } catch {}
                  }
                  errors.push({
                    journalId: entry.id,
                    code: 'DB_UPDATE_FAILED',
                    stage: 'copied_cleanup',
                  });
                }
              } else {
                const delResult = await this.tryDeleteSnapshot(
                  entry.userId,
                  entry.spaceId,
                  entry.snapshotPath,
                  inspection.snapshotEtag
                );
                if (delResult.success) {
                  let startedTx = false;
                  try {
                    this.db.exec('BEGIN IMMEDIATE');
                    startedTx = true;
                    this.db.prepare(`
                      UPDATE attachment_snapshot_journal
                      SET status = 'cleaned', updated_at = CURRENT_TIMESTAMP
                      WHERE id = ?
                    `).run(entry.id);
                    this.db.exec('COMMIT');
                    startedTx = false;
                    cleanedOrphans++;
                  } catch {
                    if (startedTx) {
                      try { this.db.exec('ROLLBACK'); } catch {}
                    }
                    errors.push({
                      journalId: entry.id,
                      code: 'DB_UPDATE_FAILED',
                      stage: 'copied_cleanup',
                    });
                  }
                } else {
                  errors.push({
                    journalId: entry.id,
                    code: 'DELETE_FAILED',
                    stage: 'copied_cleanup',
                  });
                }
              }
            }
          }
        } else if (entry.status === 'cleanup_pending') {
          const { hasMessageRef, hasActiveJournal } = this.hasOtherActiveJournalOrMessageRef(
            entry.spaceId,
            entry.snapshotPath,
            entry.id
          );

          if (hasMessageRef || hasActiveJournal) {
            let startedTx = false;
            try {
              this.db.exec('BEGIN IMMEDIATE');
              startedTx = true;
              this.db.prepare(`
                UPDATE attachment_snapshot_journal
                SET status = 'cleaned', updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
              `).run(entry.id);
              this.db.exec('COMMIT');
              startedTx = false;
              cleanedOrphans++;
            } catch {
              if (startedTx) {
                try { this.db.exec('ROLLBACK'); } catch {}
              }
              errors.push({
                journalId: entry.id,
                code: 'DB_UPDATE_FAILED',
                stage: 'cleanup_pending',
              });
            }
          } else {
            const delResult = await this.tryDeleteSnapshot(
              entry.userId,
              entry.spaceId,
              entry.snapshotPath
            );
            if (delResult.success) {
              let startedTx = false;
              try {
                this.db.exec('BEGIN IMMEDIATE');
                startedTx = true;
                this.db.prepare(`
                  UPDATE attachment_snapshot_journal
                  SET status = 'cleaned', updated_at = CURRENT_TIMESTAMP
                  WHERE id = ?
                `).run(entry.id);
                this.db.exec('COMMIT');
                startedTx = false;
                cleanedOrphans++;
              } catch {
                if (startedTx) {
                  try { this.db.exec('ROLLBACK'); } catch {}
                }
                errors.push({
                  journalId: entry.id,
                  code: 'DB_UPDATE_FAILED',
                  stage: 'cleanup_pending',
                });
              }
            } else {
              errors.push({
                journalId: entry.id,
                code: 'DELETE_FAILED',
                stage: 'cleanup_pending',
              });
            }
          }
        }
      } catch {
        errors.push({
          journalId: entry.id,
          code: 'UNEXPECTED_ERROR',
          stage: 'recovery_loop',
        });
      }
    }

    return {
      totalScanned: rawRows.length,
      abortedStaging,
      linkedCopied,
      cleanedOrphans,
      errors,
    };
  }
}
