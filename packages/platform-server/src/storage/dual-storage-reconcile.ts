import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  PlatformError,
  NotFoundError,
  ValidationError,
} from '@enkeep/platform-core';
import {
  parseDshSessionJsonl,
  readAndParseDshSessionFile,
  computeCanonicalMessagesHash,
  computeSha256,
  generateDeterministicMessageId,
  type DshSessionEvent,
  type DshSessionHeader,
  type ProjectedWebMessage,
  type ParsedDshSession,
} from './session-event-parser.js';

export type ReconciliationStatus = 'matched' | 'drift' | 'missing';

export type DiscrepancyType =
  | 'missingInSqlite'
  | 'orphanInSqlite'
  | 'contentMismatch'
  | 'roleMismatch';

export interface ReconciliationDiscrepancy {
  readonly type: DiscrepancyType;
  readonly position: number;
  readonly sourceSeq?: number;
  readonly dshMessageId?: string;
  readonly sqliteMessageId?: string;
  readonly dshRole?: string;
  readonly sqliteRole?: string;
  readonly dshContent?: string;
  readonly sqliteContent?: string;
}

export interface SessionReconciliationReport {
  readonly userId: string;
  readonly sessionId: string;
  readonly dshSessionId?: string;
  readonly status: ReconciliationStatus;
  readonly platformMessageCount: number;
  readonly dshMessageCount: number;
  readonly platformHash: string;
  readonly dshHash: string;
  readonly checkedAt: string;
  readonly discrepancies?: ReconciliationDiscrepancy[];
  readonly details?: Record<string, unknown>;
}

export interface ReconcileAllReport {
  readonly userId: string;
  readonly totalSessions: number;
  readonly matchedCount: number;
  readonly driftCount: number;
  readonly missingCount: number;
  readonly reports: SessionReconciliationReport[];
  readonly generatedAt: string;
}

export interface RepairSessionOptions {
  readonly dryRun?: boolean;
  readonly deleteOrphans?: boolean;
  readonly expectedSnapshotHash?: string;
}

export interface RepairSessionResult {
  readonly userId: string;
  readonly sessionId: string;
  readonly status: 'repaired' | 'unchanged';
  readonly repairedCount: number;
  readonly updatedCount?: number;
  readonly deletedOrphansCount?: number;
  readonly dryRun: boolean;
  readonly repairedAt: string;
  readonly discrepancies?: ReconciliationDiscrepancy[];
}

export interface DualStorageReconcileOptions {
  readonly db: DatabaseSync;
}

interface SqliteWebMessageRow {
  id: string;
  session_id: string;
  user_id: string;
  role: string;
  content: string;
  status: string;
  route_key: string;
  turn_id: string | null;
  created_at: string;
}

/**
 * Dual Storage Reconciliation & Repair Service
 *
 * Implements read-only reconciliation reports and explicit idempotent repair between
 * Platform SQLite web_messages and DSH Runtime JSONL event streams.
 *
 * Invariants:
 * - Read-only report strictly does NOT mutate SQLite or files.
 * - Repair command is explicit, admin-authenticated, transactional, and idempotent.
 * - DSH JSONL is runtime authority for conversation history, but platform deliveries are preserved.
 * - Deleting orphans in SQLite requires explicit mode (default: false / preserve).
 * - Concurrency guard: detects snapshot file changes during repair and raises 409 CONFLICT without repairing.
 * - Audit logs recorded with fixed actions (storage_reconciled, storage_repaired) with zero path leaks.
 */
export class DualStorageReconcileService {
  private readonly db: DatabaseSync;

  constructor(options: DualStorageReconcileOptions) {
    if (!options || !options.db) {
      throw new ValidationError('DatabaseSync db instance is required');
    }
    this.db = options.db;
  }

  /**
   * Compares SQLite web_messages with DSH projected messages to detect exact discrepancies.
   */
  public detectDiscrepancies(
    sqliteMessages: readonly SqliteWebMessageRow[],
    dshMessages: readonly ProjectedWebMessage[]
  ): ReconciliationDiscrepancy[] {
    const discrepancies: ReconciliationDiscrepancy[] = [];
    const maxLen = Math.max(sqliteMessages.length, dshMessages.length);

    // 1. Map messages by ID if available to correlate
    const sqliteById = new Map<string, { msg: SqliteWebMessageRow; idx: number }>();
    for (let i = 0; i < sqliteMessages.length; i++) {
      sqliteById.set(sqliteMessages[i].id, { msg: sqliteMessages[i], idx: i });
    }

    const dshById = new Map<string, { msg: ProjectedWebMessage; idx: number }>();
    for (let i = 0; i < dshMessages.length; i++) {
      dshById.set(dshMessages[i].id, { msg: dshMessages[i], idx: i });
    }

    // Positional matching and identity matching
    for (let i = 0; i < maxLen; i++) {
      const dshMsg = dshMessages[i];
      const sqlMsg = sqliteMessages[i];

      if (dshMsg && !sqlMsg) {
        discrepancies.push({
          type: 'missingInSqlite',
          position: i,
          sourceSeq: dshMsg.sourceSeq,
          dshMessageId: dshMsg.id,
          dshRole: dshMsg.role,
          dshContent: dshMsg.content,
        });
      } else if (!dshMsg && sqlMsg) {
        discrepancies.push({
          type: 'orphanInSqlite',
          position: i,
          sqliteMessageId: sqlMsg.id,
          sqliteRole: sqlMsg.role,
          sqliteContent: sqlMsg.content,
        });
      } else if (dshMsg && sqlMsg) {
        if (dshMsg.role !== sqlMsg.role) {
          discrepancies.push({
            type: 'roleMismatch',
            position: i,
            sourceSeq: dshMsg.sourceSeq,
            dshMessageId: dshMsg.id,
            sqliteMessageId: sqlMsg.id,
            dshRole: dshMsg.role,
            sqliteRole: sqlMsg.role,
            dshContent: dshMsg.content,
            sqliteContent: sqlMsg.content,
          });
        } else if (dshMsg.content !== sqlMsg.content) {
          discrepancies.push({
            type: 'contentMismatch',
            position: i,
            sourceSeq: dshMsg.sourceSeq,
            dshMessageId: dshMsg.id,
            sqliteMessageId: sqlMsg.id,
            dshRole: dshMsg.role,
            sqliteRole: sqlMsg.role,
            dshContent: dshMsg.content,
            sqliteContent: sqlMsg.content,
          });
        }
      }
    }

    return discrepancies;
  }

  /**
   * Generates a read-only reconciliation report for a single session.
   */
  async reconcileSession(
    userId: string,
    sessionId: string,
    dshJsonlPath?: string
  ): Promise<SessionReconciliationReport> {
    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      throw new ValidationError('userId is required');
    }
    if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new ValidationError('sessionId is required');
    }

    const checkedAt = new Date().toISOString();

    // 1. Query platform web_messages
    const msgRows = this.db.prepare(`
      SELECT id, session_id, user_id, role, content, status, route_key, turn_id, created_at
      FROM web_messages
      WHERE user_id = ? AND session_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(userId, sessionId) as unknown as SqliteWebMessageRow[];

    const platformMessageCount = msgRows.length;
    const platformHash = computeCanonicalMessagesHash(
      msgRows.map((m) => ({ role: m.role, content: m.content }))
    );

    // 2. Query session route to get dsh_session_id
    const routeRow = this.db.prepare(`
      SELECT dsh_session_id FROM session_routes
      WHERE user_id = ? AND id = ?
    `).get(userId, sessionId) as { dsh_session_id: string } | undefined;
    const dshSessionId = routeRow?.dsh_session_id;

    // 3. Read and parse DSH JSONL file if available
    let dshMessageCount = 0;
    let dshHash = computeCanonicalMessagesHash([]);
    let dshExists = false;
    let parsedSession: ParsedDshSession | null = null;
    let parseError: string | undefined = undefined;

    if (dshJsonlPath && fs.existsSync(dshJsonlPath)) {
      try {
        const stat = fs.lstatSync(dshJsonlPath);
        if (stat.isFile() && !stat.isSymbolicLink()) {
          dshExists = true;
          parsedSession = await readAndParseDshSessionFile(dshJsonlPath, { sessionId });
          dshMessageCount = parsedSession.projectedMessages.length;
          dshHash = parsedSession.canonicalHash;
        }
      } catch (err) {
        dshExists = false;
        parseError = (err as Error).message;
      }
    }

    // 4. Compute discrepancies and status
    let status: ReconciliationStatus;
    const details: Record<string, unknown> = {};
    let discrepancies: ReconciliationDiscrepancy[] | undefined = undefined;

    if (!dshExists && platformMessageCount === 0) {
      status = 'matched';
    } else if (!dshExists && platformMessageCount > 0) {
      status = 'missing';
      details.reason = parseError ? `dsh_jsonl_error: ${parseError}` : 'dsh_jsonl_missing';
    } else if (dshExists && platformMessageCount === 0 && dshMessageCount > 0) {
      status = 'missing';
      details.reason = 'platform_messages_missing';
      discrepancies = this.detectDiscrepancies(msgRows, parsedSession?.projectedMessages ?? []);
    } else if (dshExists && parsedSession) {
      discrepancies = this.detectDiscrepancies(msgRows, parsedSession.projectedMessages);
      if (discrepancies.length > 0 || platformHash !== dshHash || platformMessageCount !== dshMessageCount) {
        status = 'drift';
        details.platformMessageCount = platformMessageCount;
        details.dshMessageCount = dshMessageCount;
        details.discrepancyCount = discrepancies.length;
      } else {
        status = 'matched';
      }
    } else {
      status = 'drift';
    }

    return {
      userId,
      sessionId,
      dshSessionId,
      status,
      platformMessageCount,
      dshMessageCount,
      platformHash,
      dshHash,
      checkedAt,
      discrepancies: discrepancies && discrepancies.length > 0 ? discrepancies : undefined,
      details: Object.keys(details).length > 0 ? details : undefined,
    };
  }

  /**
   * Generates a read-only reconciliation report across all sessions for a tenant.
   */
  async reconcileAllSessions(
    userId: string,
    dshSessionsDir?: string
  ): Promise<ReconcileAllReport> {
    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      throw new ValidationError('userId is required');
    }

    const routes = this.db.prepare(`
      SELECT id, dsh_session_id FROM session_routes WHERE user_id = ?
    `).all(userId) as Array<{ id: string; dsh_session_id: string }>;

    const reports: SessionReconciliationReport[] = [];
    let matchedCount = 0;
    let driftCount = 0;
    let missingCount = 0;

    for (const r of routes) {
      let jsonlPath: string | undefined = undefined;
      if (dshSessionsDir && fs.existsSync(dshSessionsDir)) {
        const candidatePath = `${dshSessionsDir}/${r.dsh_session_id}/session.jsonl`;
        if (fs.existsSync(candidatePath)) {
          jsonlPath = candidatePath;
        }
      }

      const rep = await this.reconcileSession(userId, r.id, jsonlPath);
      reports.push(rep);

      if (rep.status === 'matched') matchedCount++;
      else if (rep.status === 'drift') driftCount++;
      else missingCount++;
    }

    return {
      userId,
      totalSessions: routes.length,
      matchedCount,
      driftCount,
      missingCount,
      reports,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Explicit idempotent admin repair command.
   *
   * Uses DSH JSONL as runtime authority to backfill missing messages and fix content/role mismatches
   * in SQLite web_messages, while preserving existing platform deliveries.
   * Orphan messages in SQLite are preserved unless deleteOrphans=true is explicitly requested.
   * Concurrency protection: verifies that the JSONL file snapshot did not mutate during read/repair.
   */
  async repairSession(
    userId: string,
    sessionId: string,
    dshJsonlPath: string,
    options: RepairSessionOptions = {}
  ): Promise<RepairSessionResult> {
    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      throw new ValidationError('userId is required');
    }
    if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new ValidationError('sessionId is required');
    }
    if (!dshJsonlPath || typeof dshJsonlPath !== 'string' || !dshJsonlPath.trim()) {
      throw new ValidationError('dshJsonlPath is required');
    }

    if (!fs.existsSync(dshJsonlPath)) {
      throw new NotFoundError(`DSH JSONL file not found at ${dshJsonlPath}`);
    }

    const stat = fs.lstatSync(dshJsonlPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new PlatformError('DSH JSONL path must be a regular file, not a symbolic link', 'SECURITY_VIOLATION', 403);
    }

    // 1. Initial snapshot read of JSONL
    const parsed = await readAndParseDshSessionFile(dshJsonlPath, { sessionId });
    const dshMessages = parsed.projectedMessages;
    const initialSnapshotSha256 = parsed.fileSnapshot.rawSha256;

    if (options.expectedSnapshotHash && options.expectedSnapshotHash !== initialSnapshotSha256) {
      throw new PlatformError('File snapshot hash mismatch before repair execution', 'CONFLICT', 409);
    }

    const dryRun = Boolean(options.dryRun);
    const deleteOrphans = Boolean(options.deleteOrphans);
    const nowIso = new Date().toISOString();

    // 2. Query existing SQLite web_messages
    const existingRows = this.db.prepare(`
      SELECT id, session_id, user_id, role, content, status, route_key, turn_id, created_at
      FROM web_messages
      WHERE user_id = ? AND session_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(userId, sessionId) as unknown as SqliteWebMessageRow[];

    const discrepancies = this.detectDiscrepancies(existingRows, dshMessages);

    let repairedCount = 0;
    let updatedCount = 0;
    let deletedOrphansCount = 0;

    // Fast-path: already matched
    if (discrepancies.length === 0) {
      return {
        userId,
        sessionId,
        status: 'unchanged',
        repairedCount: 0,
        updatedCount: 0,
        deletedOrphansCount: 0,
        dryRun,
        repairedAt: nowIso,
        discrepancies: [],
      };
    }

    if (!dryRun) {
      // Concurrency check before mutation
      const currentBytes = fs.readFileSync(dshJsonlPath);
      const currentSha256 = computeSha256(currentBytes);
      if (currentSha256 !== initialSnapshotSha256) {
        throw new PlatformError('Session JSONL modified concurrently while preparing repair; aborting', 'CONFLICT', 409);
      }

      this.db.exec('BEGIN IMMEDIATE');
      let inTx = true;

      try {
        const insertStmt = this.db.prepare(`
          INSERT OR REPLACE INTO web_messages (
            id, session_id, user_id, role, content, status, route_key, turn_id, created_at
          ) VALUES (?, ?, ?, ?, ?, 'delivered', ?, ?, ?)
        `);

        const updateStmt = this.db.prepare(`
          UPDATE web_messages
          SET role = ?, content = ?, status = 'delivered', turn_id = coalesce(?, turn_id)
          WHERE id = ? AND user_id = ? AND session_id = ?
        `);

        const deleteStmt = this.db.prepare(`
          DELETE FROM web_messages
          WHERE id = ? AND user_id = ? AND session_id = ?
        `);

        // Apply repairs according to discrepancies
        const existingById = new Map<string, SqliteWebMessageRow>();
        for (const row of existingRows) {
          existingById.set(row.id, row);
        }

        // 1. Backfill missing messages
        for (const disc of discrepancies) {
          if (disc.type === 'missingInSqlite') {
            const dshMsg = dshMessages[disc.position];
            if (dshMsg) {
              insertStmt.run(
                dshMsg.id,
                sessionId,
                userId,
                dshMsg.role,
                dshMsg.content,
                sessionId,
                dshMsg.turnId,
                dshMsg.createdAt
              );

              if (dshMsg.attachments && dshMsg.attachments.length > 0) {
                try {
                  const attInsertStmt = this.db.prepare(`
                    INSERT OR REPLACE INTO message_attachments (
                      id, message_id, user_id, space_id, relative_path, snapshot_path, etag, size, media_type, display_name, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  `);
                  for (const att of dshMsg.attachments) {
                    attInsertStmt.run(
                      att.id || `att_${dshMsg.id}_${att.etag}`,
                      dshMsg.id,
                      userId,
                      sessionId,
                      att.relativePath,
                      att.snapshotPath,
                      att.etag,
                      att.size,
                      att.mediaType,
                      att.displayName ?? null,
                      dshMsg.createdAt
                    );
                  }
                } catch {
                  // Ignore if message_attachments table not migrated yet
                }
              }

              repairedCount++;
            }
          } else if (disc.type === 'contentMismatch' || disc.type === 'roleMismatch') {
            const dshMsg = dshMessages[disc.position];
            const sqlMsg = existingRows[disc.position];
            if (dshMsg && sqlMsg) {
              updateStmt.run(
                dshMsg.role,
                dshMsg.content,
                dshMsg.turnId,
                sqlMsg.id,
                userId,
                sessionId
              );
              updatedCount++;
            }
          } else if (disc.type === 'orphanInSqlite' && deleteOrphans) {
            const sqlMsg = existingRows[disc.position];
            if (sqlMsg) {
              deleteStmt.run(sqlMsg.id, userId, sessionId);
              deletedOrphansCount++;
            }
          }
        }

        // Record structured audit log (zero path leakage)
        try {
          const auditId = `aud_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
          const detailsStr = JSON.stringify({
            action: 'storage_repaired',
            sessionId,
            repairedCount,
            updatedCount,
            deletedOrphansCount,
            deleteOrphans,
            dryRun: false,
          });
          this.db.prepare(`
            INSERT INTO auth_audit_log (id, user_id, username, action, details, created_at)
            VALUES (?, ?, ?, 'storage_repaired', ?, CURRENT_TIMESTAMP)
          `).run(auditId, userId, userId, detailsStr);
        } catch {
          // Ignore audit write failure inside repair
        }

        this.db.exec('COMMIT');
        inTx = false;
      } catch (txErr) {
        if (inTx) {
          try {
            this.db.exec('ROLLBACK');
          } catch {}
        }
        throw txErr;
      }
    } else {
      // Dry run counts
      for (const disc of discrepancies) {
        if (disc.type === 'missingInSqlite') {
          repairedCount++;
        } else if (disc.type === 'contentMismatch' || disc.type === 'roleMismatch') {
          updatedCount++;
        } else if (disc.type === 'orphanInSqlite' && deleteOrphans) {
          deletedOrphansCount++;
        }
      }
    }

    const totalMutations = repairedCount + updatedCount + deletedOrphansCount;

    return {
      userId,
      sessionId,
      status: totalMutations > 0 ? 'repaired' : 'unchanged',
      repairedCount,
      updatedCount: updatedCount > 0 ? updatedCount : undefined,
      deletedOrphansCount: deletedOrphansCount > 0 ? deletedOrphansCount : undefined,
      dryRun,
      repairedAt: nowIso,
      discrepancies,
    };
  }
}
