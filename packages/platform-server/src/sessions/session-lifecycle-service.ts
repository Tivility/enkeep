/**
 * Session Lifecycle Service for Archive, Restore, and Status Management
 *
 * Implements strict runtime artifact verification through RuntimeArtifactPort
 * without touching host filesystem directly.
 *
 * @module @enkeep/platform-server/sessions/session-lifecycle-service
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { PlatformStorage, SessionRoute, BrowserService } from '@enkeep/platform-core';
import {
  NotFoundError,
  ValidationError,
  PlatformError,
} from '@enkeep/platform-core';
import type { PublicSession } from '@enkeep/web-channel';
import type {
  RuntimeArtifactPort,
  SessionCorruptionInspectResult,
  SessionPrefixRecoveryResult,
} from './runtime-artifact-port.js';

export interface SessionLifecycleServiceOptions {
  db: DatabaseSync;
  storage: PlatformStorage;
  runtimeArtifactPort: RuntimeArtifactPort;
  browserService?: BrowserService;
}

export class SessionLifecycleService {
  private readonly db: DatabaseSync;
  private readonly storage: PlatformStorage;
  private readonly runtimeArtifactPort: RuntimeArtifactPort;
  private browserService?: BrowserService;

  constructor(options: SessionLifecycleServiceOptions) {
    if (!options || typeof options !== 'object') {
      throw new ValidationError('SessionLifecycleService requires options object');
    }
    if (!options.db) {
      throw new ValidationError('SessionLifecycleService requires db instance');
    }
    if (!options.storage) {
      throw new ValidationError('SessionLifecycleService requires storage instance');
    }
    if (!options.runtimeArtifactPort) {
      throw new ValidationError('SessionLifecycleService requires runtimeArtifactPort instance');
    }
    this.db = options.db;
    this.storage = options.storage;
    this.runtimeArtifactPort = options.runtimeArtifactPort;
    this.browserService = options.browserService;
  }

  public setBrowserService(browserService?: BrowserService): void {
    this.browserService = browserService;
  }

  private toPublicSession(route: SessionRoute): PublicSession {
    return {
      id: route.id,
      spaceId: route.spaceId,
      title: route.title ?? null,
      status: route.status,
      currentGeneration: route.currentGeneration,
      createdAt: route.createdAt,
      updatedAt: route.updatedAt,
    };
  }

  async restoreSession(userId: string, sessionId: string): Promise<PublicSession> {
    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      throw new ValidationError('userId is required');
    }
    if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new ValidationError('sessionId is required');
    }

    const tenant = this.storage.forTenant(userId);
    const existing = await tenant.sessionRoutes.findById(sessionId);
    if (!existing) {
      throw new NotFoundError(`Session "${sessionId}" not found`);
    }
    if (existing.status === 'deleted') {
      throw new ValidationError('Cannot restore deleted session');
    }

    // 1. Verify parent Space is active
    const parentSpace = await tenant.spaces.findById(existing.spaceId);
    if (!parentSpace || parentSpace.status !== 'active') {
      throw new PlatformError(
        'Cannot restore session in archived or inactive space. Restore the space first.',
        'SPACE_ARCHIVED',
        400
      );
    }

    // 2. Idempotent short-circuit if already active
    if (existing.status === 'active') {
      return this.toPublicSession(existing);
    }

    // 3. Verify DSH session artifact through RuntimeArtifactPort (no direct fs touching)
    let artifact;
    try {
      artifact = await this.runtimeArtifactPort.checkSessionArtifact({
        userId,
        dshSessionId: existing.dshSessionId,
        workspaceFolder: parentSpace.folder,
      });
    } catch (portErr: unknown) {
      const errMsg = portErr instanceof Error ? portErr.message : String(portErr);
      throw new PlatformError(
        `Runtime artifact provider is unavailable to verify session: ${errMsg}`,
        'SERVICE_UNAVAILABLE',
        503
      );
    }

    if (!artifact || !artifact.exists || !artifact.valid) {
      throw new PlatformError(
        `DSH session transcript is missing or corrupted for session "${sessionId}". Manual recovery required before restoring.`,
        'RECOVERY_REQUIRED',
        400
      );
    }

    // 4. Update status in DB transaction
    let inTx = false;
    this.db.exec('BEGIN IMMEDIATE');
    inTx = true;
    try {
      const sessionRow = this.db
        .prepare('SELECT id, status FROM session_routes WHERE id = ? AND user_id = ? LIMIT 1')
        .get(sessionId, userId) as { id: string; status: string } | undefined;

      if (!sessionRow) {
        throw new NotFoundError('Session not found');
      }

      this.db
        .prepare('UPDATE session_routes SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
        .run('active', sessionId, userId);

      this.db.exec('COMMIT');
      inTx = false;

      const updated = await tenant.sessionRoutes.findById(sessionId);
      if (!updated) {
        throw new PlatformError('Failed to retrieve session after restore', 'INTERNAL_ERROR', 500);
      }
      return this.toPublicSession(updated);
    } catch (err) {
      if (inTx) {
        try {
          this.db.exec('ROLLBACK');
        } catch (rbErr) {
          const primary = err instanceof Error ? err : new Error('Database transaction failed');
          const rollback = rbErr instanceof Error ? rbErr : new Error('Database rollback failed');
          throw new AggregateError([primary, rollback], 'Database transaction and rollback failed');
        }
      }
      throw err;
    }
  }

  async archiveSession(userId: string, sessionId: string): Promise<PublicSession> {
    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      throw new ValidationError('userId is required');
    }
    if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new ValidationError('sessionId is required');
    }

    const tenant = this.storage.forTenant(userId);
    const existing = await tenant.sessionRoutes.findById(sessionId);
    if (!existing) {
      throw new NotFoundError(`Session "${sessionId}" not found`);
    }

    let inTx = false;
    this.db.exec('BEGIN IMMEDIATE');
    inTx = true;
    try {
      const sessionRow = this.db
        .prepare('SELECT id, status FROM session_routes WHERE id = ? AND user_id = ? LIMIT 1')
        .get(sessionId, userId) as { id: string; status: string } | undefined;

      if (!sessionRow) {
        throw new NotFoundError('Session not found');
      }

      // Check for active turns
      const activeTurns = this.db
        .prepare(`
          SELECT id FROM turn_runs
          WHERE route_id = ? AND user_id = ? AND status IN ('running', 'queued')
          LIMIT 1
        `)
        .get(sessionId, userId);

      if (activeTurns) {
        throw new PlatformError('Cannot archive session with active turns', 'CONFLICT', 409);
      }

      this.db
        .prepare('UPDATE session_routes SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
        .run('archived', sessionId, userId);

      this.db.exec('COMMIT');
      inTx = false;

      // Close associated browser session/contexts upon archive
      if (this.browserService) {
        try {
          await this.browserService.close({
            sessionKey: {
              userId,
              spaceId: existing.spaceId,
              sessionId,
            },
          });
        } catch (_bErr: unknown) {
          // Non-blocking browser cleanup
        }
      }

      const updated = await tenant.sessionRoutes.findById(sessionId);
      if (!updated) {
        throw new PlatformError('Failed to retrieve session after archive', 'INTERNAL_ERROR', 500);
      }
      return this.toPublicSession(updated);
    } catch (err) {
      if (inTx) {
        try {
          this.db.exec('ROLLBACK');
        } catch (rbErr) {
          const primary = err instanceof Error ? err : new Error('Database transaction failed');
          const rollback = rbErr instanceof Error ? rbErr : new Error('Database rollback failed');
          throw new AggregateError([primary, rollback], 'Database transaction and rollback failed');
        }
      }
      throw err;
    }
  }

  async inspectSessionRecovery(userId: string, sessionId: string): Promise<{
    sessionId: string;
    dshSessionId: string;
    generation: number;
    recoveryRequired: boolean;
    status: 'ok';
    code: 'VALID' | 'CORRUPTED' | 'SEQ_GAP' | 'SYNTAX_ERROR' | 'NOT_FOUND';
    corrupted: boolean;
    lastValidSeq: number;
    lineCount: number;
    validEventsCount: number;
    errorDetail?: string;
  }> {
    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      throw new ValidationError('userId is required');
    }
    if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new ValidationError('sessionId is required');
    }

    const routeRow = this.db.prepare(`
      SELECT id, user_id, space_id, dsh_session_id, current_generation, status
      FROM session_routes
      WHERE id = ? AND user_id = ?
      LIMIT 1
    `).get(sessionId, userId) as {
      id: string;
      user_id: string;
      space_id: string;
      dsh_session_id: string;
      current_generation: number;
      status: string;
    } | undefined;

    if (!routeRow) {
      throw new NotFoundError(`Session "${sessionId}" not found`);
    }

    const spaceRow = this.db.prepare(`
      SELECT folder, status FROM spaces WHERE id = ? AND user_id = ? LIMIT 1
    `).get(routeRow.space_id, userId) as { folder: string; status: string } | undefined;

    const workspaceFolder = spaceRow?.folder;

    let recoveryStateRow: { status: string; failure_code: string; failure_detail?: string } | undefined;
    try {
      recoveryStateRow = this.db.prepare(`
        SELECT status, failure_code, failure_detail FROM session_recovery_state
        WHERE user_id = ? AND route_id = ? AND generation = ? AND status = 'recovery_required'
        LIMIT 1
      `).get(userId, sessionId, routeRow.current_generation ?? 1) as any;
    } catch {}

    let inspectRes: SessionCorruptionInspectResult = {
      exists: true,
      valid: true,
      corrupted: false,
      code: 'VALID',
      lastValidSeq: 0,
      lineCount: 0,
      validEventsCount: 0,
    };

    if (typeof this.runtimeArtifactPort.inspectSessionCorruption === 'function') {
      inspectRes = await this.runtimeArtifactPort.inspectSessionCorruption({
        userId,
        dshSessionId: routeRow.dsh_session_id,
        workspaceFolder,
      });
    } else {
      const checkRes = await this.runtimeArtifactPort.checkSessionArtifact({
        userId,
        dshSessionId: routeRow.dsh_session_id,
        workspaceFolder,
      });
      inspectRes = {
        exists: checkRes.exists,
        valid: checkRes.valid,
        corrupted: checkRes.exists && !checkRes.valid,
        code: checkRes.valid ? 'VALID' : (checkRes.exists ? 'CORRUPTED' : 'NOT_FOUND'),
        lastValidSeq: checkRes.eventCount ? checkRes.eventCount - 1 : 0,
        lineCount: checkRes.eventCount ?? 0,
        validEventsCount: checkRes.eventCount ?? 0,
      };
    }

    const isCorrupted = Boolean(
      inspectRes.corrupted ||
      inspectRes.code === 'SEQ_GAP' ||
      inspectRes.code === 'SYNTAX_ERROR' ||
      inspectRes.code === 'CORRUPTED'
    );

    const recoveryRequired = Boolean(
      isCorrupted ||
      (recoveryStateRow && recoveryStateRow.status === 'recovery_required')
    );

    return {
      sessionId,
      dshSessionId: routeRow.dsh_session_id,
      generation: routeRow.current_generation ?? 1,
      recoveryRequired,
      status: 'ok',
      code: inspectRes.code,
      corrupted: isCorrupted,
      lastValidSeq: inspectRes.lastValidSeq,
      lineCount: inspectRes.lineCount,
      validEventsCount: inspectRes.validEventsCount,
      errorDetail: inspectRes.errorDetail || recoveryStateRow?.failure_detail,
    };
  }

  async recoverValidPrefix(
    userId: string,
    sessionId: string,
    options?: { replayQueued?: boolean }
  ): Promise<{
    recovered: boolean;
    newGeneration: number;
    dshSessionId: string;
    validEventsCount: number;
    backupChecksum: string;
  }> {
    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      throw new ValidationError('userId is required');
    }
    if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new ValidationError('sessionId is required');
    }

    const routeRow = this.db.prepare(`
      SELECT id, user_id, space_id, dsh_session_id, current_generation, reset_count, status
      FROM session_routes
      WHERE id = ? AND user_id = ?
      LIMIT 1
    `).get(sessionId, userId) as {
      id: string;
      user_id: string;
      space_id: string;
      dsh_session_id: string;
      current_generation: number;
      reset_count: number;
      status: string;
    } | undefined;

    if (!routeRow) {
      throw new NotFoundError(`Session "${sessionId}" not found`);
    }

    const spaceRow = this.db.prepare(`
      SELECT folder, status FROM spaces WHERE id = ? AND user_id = ? LIMIT 1
    `).get(routeRow.space_id, userId) as { folder: string; status: string } | undefined;

    const workspaceFolder = spaceRow?.folder;
    const oldDshSessionId = routeRow.dsh_session_id;
    const nextGeneration = (routeRow.current_generation ?? 1) + 1;
    const nextResetCount = (routeRow.reset_count ?? 0) + 1;
    const newDshSessionId = `ses_${randomUUID().replace(/-/g, '')}`;
    const nowIso = new Date().toISOString();

    let recoverRes: SessionPrefixRecoveryResult;
    if (typeof this.runtimeArtifactPort.recoverValidPrefix === 'function') {
      recoverRes = await this.runtimeArtifactPort.recoverValidPrefix({
        userId,
        dshSessionId: oldDshSessionId,
        targetDshId: newDshSessionId,
        workspaceFolder,
      });
    } else {
      // Fallback: export fork seed and import into target session
      const exported = await this.runtimeArtifactPort.exportForkSeed({
        userId,
        sourceDshSessionId: oldDshSessionId,
        workspaceFolder,
      });
      await this.runtimeArtifactPort.importSeed({
        userId,
        targetDshId: newDshSessionId,
        events: exported.events,
        receipt: exported.receipt,
        workspaceFolder,
      });
      recoverRes = {
        recovered: true,
        targetDshId: newDshSessionId,
        validEventsCount: exported.events.length,
        backupPath: '',
        backupChecksum: exported.receipt.checksum,
      };
    }

    let inTx = false;
    this.db.exec('BEGIN IMMEDIATE');
    inTx = true;
    try {
      // 1. Record session_generations entry
      const generationId = `gen_${randomUUID().replace(/-/g, '')}`;
      this.db.prepare(`
        INSERT INTO session_generations (
          id, user_id, route_id, generation_number, dsh_session_id, reset_reason, created_at
        ) VALUES (?, ?, ?, ?, ?, 'recovery', ?)
      `).run(
        generationId,
        userId,
        sessionId,
        nextGeneration,
        newDshSessionId,
        nowIso
      );

      // 2. Update session_routes
      this.db.prepare(`
        UPDATE session_routes
        SET dsh_session_id = ?,
            current_generation = ?,
            reset_count = ?,
            last_reset_at = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?
      `).run(
        newDshSessionId,
        nextGeneration,
        nextResetCount,
        nowIso,
        sessionId,
        userId
      );

      // 3. Mark session_recovery_state as resolved across all generations for this route
      this.db.prepare(`
        UPDATE session_recovery_state
        SET status = 'resolved', updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND route_id = ?
      `).run(userId, sessionId);

      const sanitizedBackupName = recoverRes.backupPath ? (recoverRes.backupPath.includes('/') || recoverRes.backupPath.includes('\\') ? recoverRes.backupPath.split(/[/\\]/).pop() || '' : recoverRes.backupPath) : '';
      const recStateId = `rec_${randomUUID().replace(/-/g, '')}`;
      this.db.prepare(`
        INSERT INTO session_recovery_state (
          id, user_id, route_id, generation, status, failure_code, raw_backup_path, raw_backup_checksum, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'resolved', 'RECOVERED_VALID_PREFIX', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, route_id, generation) DO UPDATE SET
          status = 'resolved',
          raw_backup_path = excluded.raw_backup_path,
          raw_backup_checksum = excluded.raw_backup_checksum,
          updated_at = CURRENT_TIMESTAMP
      `).run(
        recStateId,
        userId,
        sessionId,
        nextGeneration,
        sanitizedBackupName || null,
        recoverRes.backupChecksum || null
      );

      // 4. Release blocked lease if any
      this.db.prepare(`
        UPDATE session_execution_leases
        SET status = 'released', released_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND route_id = ? AND status IN ('active', 'blocked')
      `).run(userId, sessionId);

      // 5. Handle queued turns
      if (options?.replayQueued !== true) {
        this.db.prepare(`
          UPDATE turn_runs
          SET status = 'interrupted', error = 'Cancelled during session recovery', finished_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE route_id = ? AND user_id = ? AND status = 'queued'
        `).run(nowIso, sessionId, userId);

        this.db.prepare(`
          UPDATE delivery_inbox
          SET status = 'cancelled', error = 'Cancelled during session recovery', updated_at = CURRENT_TIMESTAMP
          WHERE route_id = ? AND user_id = ? AND status = 'held'
        `).run(sessionId, userId);
      }

      this.db.exec('COMMIT');
      inTx = false;

      // Close old generation browser session/contexts upon recovery reset
      if (this.browserService) {
        try {
          await this.browserService.close({
            sessionKey: {
              userId,
              spaceId: routeRow.space_id,
              sessionId,
            },
          });
        } catch (_bErr: unknown) {
          // Non-blocking browser cleanup
        }
      }

      return {
        recovered: true,
        newGeneration: nextGeneration,
        dshSessionId: newDshSessionId,
        validEventsCount: recoverRes.validEventsCount,
        backupChecksum: recoverRes.backupChecksum,
      };
    } catch (txErr) {
      if (inTx) {
        try {
          this.db.exec('ROLLBACK');
        } catch (rbErr) {
          throw new AggregateError([txErr, rbErr], 'Recovery transaction and rollback failed');
        }
      }
      throw txErr;
    }
  }

  async startNewGeneration(userId: string, sessionId: string): Promise<{
    started: boolean;
    newGeneration: number;
    dshSessionId: string;
  }> {
    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      throw new ValidationError('userId is required');
    }
    if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new ValidationError('sessionId is required');
    }

    const routeRow = this.db.prepare(`
      SELECT id, user_id, space_id, dsh_session_id, current_generation, reset_count, status
      FROM session_routes
      WHERE id = ? AND user_id = ?
      LIMIT 1
    `).get(sessionId, userId) as {
      id: string;
      user_id: string;
      space_id: string;
      dsh_session_id: string;
      current_generation: number;
      reset_count: number;
      status: string;
    } | undefined;

    if (!routeRow) {
      throw new NotFoundError(`Session "${sessionId}" not found`);
    }

    const nextGeneration = (routeRow.current_generation ?? 1) + 1;
    const nextResetCount = (routeRow.reset_count ?? 0) + 1;
    const newDshSessionId = `ses_${randomUUID().replace(/-/g, '')}`;
    const nowIso = new Date().toISOString();

    let inTx = false;
    this.db.exec('BEGIN IMMEDIATE');
    inTx = true;
    try {
      const generationId = `gen_${randomUUID().replace(/-/g, '')}`;
      this.db.prepare(`
        INSERT INTO session_generations (
          id, user_id, route_id, generation_number, dsh_session_id, reset_reason, created_at
        ) VALUES (?, ?, ?, ?, ?, 'recovery_fresh', ?)
      `).run(
        generationId,
        userId,
        sessionId,
        nextGeneration,
        newDshSessionId,
        nowIso
      );

      this.db.prepare(`
        UPDATE session_routes
        SET dsh_session_id = ?,
            current_generation = ?,
            reset_count = ?,
            last_reset_at = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?
      `).run(
        newDshSessionId,
        nextGeneration,
        nextResetCount,
        nowIso,
        sessionId,
        userId
      );

      this.db.prepare(`
        UPDATE session_recovery_state
        SET status = 'resolved', updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND route_id = ?
      `).run(userId, sessionId);

      const recStateId = `rec_${randomUUID().replace(/-/g, '')}`;
      this.db.prepare(`
        INSERT INTO session_recovery_state (
          id, user_id, route_id, generation, status, failure_code, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'resolved', 'FRESH_GENERATION_STARTED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, route_id, generation) DO UPDATE SET
          status = 'resolved',
          updated_at = CURRENT_TIMESTAMP
      `).run(
        recStateId,
        userId,
        sessionId,
        nextGeneration
      );

      this.db.prepare(`
        UPDATE session_execution_leases
        SET status = 'released', released_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND route_id = ? AND status IN ('active', 'blocked')
      `).run(userId, sessionId);

      this.db.prepare(`
        UPDATE turn_runs
        SET status = 'interrupted', error = 'Cancelled on fresh generation restart', finished_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE route_id = ? AND user_id = ? AND status = 'queued'
      `).run(nowIso, sessionId, userId);

      this.db.prepare(`
        UPDATE delivery_inbox
        SET status = 'cancelled', error = 'Cancelled on fresh generation restart', updated_at = CURRENT_TIMESTAMP
        WHERE route_id = ? AND user_id = ? AND status = 'held'
      `).run(sessionId, userId);

      this.db.exec('COMMIT');
      inTx = false;

      // Close old generation browser session/contexts upon start fresh generation
      if (this.browserService) {
        try {
          await this.browserService.close({
            sessionKey: {
              userId,
              spaceId: routeRow.space_id,
              sessionId,
            },
          });
        } catch (_bErr: unknown) {
          // Non-blocking browser cleanup
        }
      }

      return {
        started: true,
        newGeneration: nextGeneration,
        dshSessionId: newDshSessionId,
      };
    } catch (txErr) {
      if (inTx) {
        try {
          this.db.exec('ROLLBACK');
        } catch (rbErr) {
          throw new AggregateError([txErr, rbErr], 'Start fresh generation transaction failed');
        }
      }
      throw txErr;
    }
  }
}
