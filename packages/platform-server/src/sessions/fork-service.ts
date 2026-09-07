/**
 * Dedicated Online Session Fork Service
 *
 * Implements authoritative DSH event boundary forking, dual-store saga,
 * crash recovery via fork_operations journal, cross-space attachment copying,
 * and strict idempotency verification.
 *
 * @module @enkeep/platform-server/sessions/fork-service
 */

import { randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  PlatformStorage,
  SessionRoute,
} from '@enkeep/platform-core';
import {
  NotFoundError,
  ValidationError,
  PlatformError,
} from '@enkeep/platform-core';
import type {
  PublicSession,
  ForkSessionOptions,
} from '@enkeep/web-channel';
import { generate32HexId } from '../storage/web-messages.js';
import type {
  RuntimeArtifactPort,
  AttachmentCopyPort,
  SessionSeedReceipt,
} from './runtime-artifact-port.js';

export interface ForkServiceOptions {
  db: DatabaseSync;
  storage: PlatformStorage;
  runtimeArtifactPort: RuntimeArtifactPort;
  attachmentCopyPort: AttachmentCopyPort;
}

export interface ForkPlan {
  userId: string;
  sourceSessionId: string;
  sourceDshSessionId: string;
  sourceSpaceId: string;
  targetSpaceId: string;
  forkedRouteId: string;
  forkedDshSessionId: string;
  forkedTitle: string;
  agentProfileId: string | null;
  agentProfileSnapshotId: string | null;
  boundary?: {
    fromMessageId?: string;
    fromTurnId?: string;
  };
  includedMessageIds: string[];
  receipt?: SessionSeedReceipt;
}

function isBoundaryErrorCode(err: unknown): boolean {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code;
    return code === 'BOUNDARY_UNAVAILABLE' || code === 'INVALID_BOUNDARY';
  }
  return false;
}

export class ForkService {
  private readonly db: DatabaseSync;
  private readonly storage: PlatformStorage;
  private readonly runtimeArtifactPort: RuntimeArtifactPort;
  private readonly attachmentCopyPort: AttachmentCopyPort;

  constructor(options: ForkServiceOptions) {
    if (!options || typeof options !== 'object') {
      throw new ValidationError('ForkService requires options object');
    }
    if (!options.db) {
      throw new ValidationError('ForkService requires db instance');
    }
    if (!options.storage) {
      throw new ValidationError('ForkService requires storage instance');
    }
    if (!options.runtimeArtifactPort) {
      throw new ValidationError('ForkService requires runtimeArtifactPort instance');
    }
    if (!options.attachmentCopyPort) {
      throw new ValidationError('ForkService requires attachmentCopyPort instance');
    }
    this.db = options.db;
    this.storage = options.storage;
    this.runtimeArtifactPort = options.runtimeArtifactPort;
    this.attachmentCopyPort = options.attachmentCopyPort;
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

  async forkSession(
    userId: string,
    sessionId: string,
    options?: ForkSessionOptions
  ): Promise<PublicSession> {
    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      throw new ValidationError('userId is required');
    }
    if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new ValidationError('sessionId is required');
    }

    const tenant = this.storage.forTenant(userId);
    const sourceSession = await tenant.sessionRoutes.findById(sessionId);
    if (!sourceSession) {
      throw new NotFoundError(`Session "${sessionId}" not found`);
    }

    const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const idempotencyKey = options?.idempotencyKey;
    const canonicalReq = JSON.stringify({
      action: 'fork_session',
      userId,
      sessionId,
      fromMessageId: options?.fromMessageId ?? null,
      fromTurnId: options?.fromTurnId ?? null,
      title: options?.title ?? null,
      targetSpaceId: options?.targetSpaceId ?? null,
    });
    const currentRequestHash = createHash('sha256').update(canonicalReq).digest('hex');

    // 1. Idempotency Check with strict hash verification
    if (idempotencyKey) {
      if (!UUID_V4_REGEX.test(idempotencyKey)) {
        throw new ValidationError('Invalid Idempotency-Key format. Expected canonical lowercase UUID v4');
      }

      const existingIdemp = this.db
        .prepare(`
          SELECT target_id, request_hash, response_payload
          FROM operation_idempotency
          WHERE user_id = ? AND scope = 'fork_session' AND idempotency_key = ?
          LIMIT 1
        `)
        .get(userId, idempotencyKey) as { target_id: string; request_hash: string; response_payload: string } | undefined;

      if (existingIdemp) {
        if (existingIdemp.request_hash !== currentRequestHash) {
          throw new PlatformError(
            'Idempotency key reused with differing request payload',
            'IDEMPOTENCY_CONFLICT',
            409
          );
        }

        try {
          const parsed = JSON.parse(existingIdemp.response_payload);
          return parsed as PublicSession;
        } catch {
          throw new PlatformError(
            'Corrupted idempotency record payload in database',
            'DATABASE_CORRUPTED',
            500
          );
        }
      }
    }

    // 2. Active turn check on source session: reject 409 TURN_ACTIVE
    const activeTurns = this.db
      .prepare(`
        SELECT id FROM turn_runs
        WHERE route_id = ? AND user_id = ? AND status IN ('running', 'queued')
        LIMIT 1
      `)
      .get(sessionId, userId);

    if (activeTurns) {
      throw new PlatformError('Cannot fork session while a turn is active', 'TURN_ACTIVE', 409);
    }

    // 3. Target space validation
    const targetSpaceId = options?.targetSpaceId || sourceSession.spaceId;
    const targetSpace = await tenant.spaces.findById(targetSpaceId);
    if (!targetSpace) {
      throw new NotFoundError(`Target space "${targetSpaceId}" not found`);
    }
    if (targetSpace.status !== 'active') {
      throw new ValidationError('Target space is archived or inactive');
    }

    const sourceSpace = await tenant.spaces.findById(sourceSession.spaceId);

    // 4. Resolve profile snapshot pinned at source generation / boundary
    const sourceGenRow = this.db
      .prepare(`
        SELECT agent_profile_snapshot_id
        FROM session_generations
        WHERE route_id = ? AND user_id = ?
        ORDER BY generation_number DESC
        LIMIT 1
      `)
      .get(sessionId, userId) as { agent_profile_snapshot_id: string | null } | undefined;

    const pinnedProfileSnapshotId = sourceGenRow?.agent_profile_snapshot_id ?? sourceSession.agentProfileSnapshotId ?? null;
    const pinnedProfileId = sourceSession.agentProfileId ?? null;

    let profileSnapshotObj: unknown = null;
    if (pinnedProfileSnapshotId) {
      const snapRow = this.db
        .prepare('SELECT id, profile_id, version, identity, soul, agents, tools, prompt_hash FROM agent_profile_snapshots WHERE id = ?')
        .get(pinnedProfileSnapshotId);
      if (snapRow) {
        profileSnapshotObj = snapRow;
      }
    }

    // 5. Determine fork boundary from source messages
    const allMsgs = this.db
      .prepare(`
        SELECT id, role, content, turn_id, created_at
        FROM web_messages
        WHERE session_id = ? AND user_id = ?
        ORDER BY created_at ASC, id ASC
      `)
      .all(sessionId, userId) as Array<{
        id: string;
        role: string;
        content: string;
        turn_id: string | null;
        created_at: string;
      }>;

    let includedMsgs = allMsgs;
    if (options?.fromMessageId) {
      const idx = allMsgs.findIndex((m) => m.id === options.fromMessageId);
      if (idx === -1) {
        throw new ValidationError(`Message "${options.fromMessageId}" not found in source session`);
      }
      includedMsgs = allMsgs.slice(0, idx + 1);
    } else if (options?.fromTurnId) {
      let lastTurnIdx = -1;
      for (let i = 0; i < allMsgs.length; i++) {
        if (allMsgs[i]?.turn_id === options.fromTurnId) {
          lastTurnIdx = i;
        }
      }
      if (lastTurnIdx === -1) {
        throw new ValidationError(`Turn "${options.fromTurnId}" not found in source session`);
      }
      includedMsgs = allMsgs.slice(0, lastTurnIdx + 1);
    }

    // 6. Generate new session IDs
    const newRouteId = `ses_${randomUUID().replace(/-/g, '')}`;
    const newDshSessionId = `ses_${randomUUID().replace(/-/g, '')}`;
    const forkedTitle = options?.title !== undefined && options.title.trim()
      ? options.title.trim().normalize('NFC')
      : `${sourceSession.title || 'Session'} (Fork)`.normalize('NFC');

    let targetTurnNum: number | undefined = undefined;
    if (options?.fromMessageId) {
      const distinctTurnIds = Array.from(new Set(allMsgs.map((m) => m.turn_id).filter((t): t is string => typeof t === 'string' && Boolean(t))));
      const targetMsg = allMsgs.find((m) => m.id === options.fromMessageId);
      if (targetMsg && targetMsg.turn_id) {
        const tIdx = distinctTurnIds.indexOf(targetMsg.turn_id);
        if (tIdx !== -1) {
          targetTurnNum = tIdx + 1;
        }
      }
    } else if (options?.fromTurnId) {
      const distinctTurnIds = Array.from(new Set(allMsgs.map((m) => m.turn_id).filter((t): t is string => typeof t === 'string' && Boolean(t))));
      const tIdx = distinctTurnIds.indexOf(options.fromTurnId);
      if (tIdx !== -1) {
        targetTurnNum = tIdx + 1;
      }
    }

    const plan: ForkPlan = {
      userId,
      sourceSessionId: sessionId,
      sourceDshSessionId: sourceSession.dshSessionId,
      sourceSpaceId: sourceSession.spaceId,
      targetSpaceId,
      forkedRouteId: newRouteId,
      forkedDshSessionId: newDshSessionId,
      forkedTitle,
      agentProfileId: pinnedProfileId,
      agentProfileSnapshotId: pinnedProfileSnapshotId,
      boundary: {
        fromMessageId: options?.fromMessageId,
        fromTurnId: options?.fromTurnId ?? (options?.fromMessageId ? allMsgs.find((m) => m.id === options.fromMessageId)?.turn_id ?? undefined : undefined),
        ...(targetTurnNum !== undefined ? { fromTurn: targetTurnNum } as any : {}),
      },
      includedMessageIds: includedMsgs.map((m) => m.id),
    };

    const forkOpId = generate32HexId('forkop');

    // Step 1: Log prepared operation into fork_operations table
    this.db
      .prepare(`
        INSERT INTO fork_operations (
          id, user_id, source_session_id, target_space_id, forked_route_id, forked_dsh_session_id,
          request_hash, idempotency_key, status, fork_plan_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `)
      .run(
        forkOpId,
        userId,
        sessionId,
        targetSpaceId,
        newRouteId,
        newDshSessionId,
        currentRequestHash,
        idempotencyKey ?? null,
        JSON.stringify(plan)
      );

    // Step 2: Export fork seed from authoritative runtime + Import into target DSH runtime
    let exportResult;
    try {
      exportResult = await this.runtimeArtifactPort.exportForkSeed({
        userId,
        sourceDshSessionId: sourceSession.dshSessionId,
        boundary: plan.boundary,
        workspaceFolder: sourceSpace?.folder,
      });
    } catch (exportErr: unknown) {
      console.error('[FORK EXPORT ERROR]', exportErr);
      const isBoundary = isBoundaryErrorCode(exportErr);
      const code = isBoundary ? 'BOUNDARY_UNAVAILABLE' : 'RUNTIME_EXPORT_FAILED';
      const message = isBoundary ? 'Fork boundary unavailable' : 'Runtime fork export failed';
      const status = isBoundary ? 409 : 502;
      this.db
        .prepare(`
          UPDATE fork_operations
          SET status = 'failed', error_code = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `)
        .run(code, message, forkOpId);
      throw new PlatformError(
        message,
        code,
        status
      );
    }

    const { events, receipt } = exportResult;
    plan.receipt = receipt;

    try {
      const importRes = await this.runtimeArtifactPort.importSeed({
        userId,
        targetDshId: newDshSessionId,
        events,
        receipt,
        profile: profileSnapshotObj,
        workspaceFolder: targetSpace.folder,
      });
      if (importRes.status !== 'ok' && importRes.status !== 'completed') {
        throw new Error(`Import seed returned non-ok status: ${importRes.status}`);
      }
      if (importRes.persisted !== true) {
        throw new Error('Import seed was not persisted');
      }

      this.db
        .prepare(`
          UPDATE fork_operations
          SET status = 'seeded', receipt_json = ?, fork_plan_json = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `)
        .run(JSON.stringify(receipt), JSON.stringify(plan), forkOpId);
    } catch (importErr: unknown) {
      console.error('[FORK IMPORT ERROR]', importErr);
      this.db
        .prepare(`
          UPDATE fork_operations
          SET status = 'failed', error_code = 'RUNTIME_SEED_FAILED', error_message = 'Runtime fork seed failed', updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `)
        .run(forkOpId);
      throw new PlatformError(
        'Runtime fork seed failed',
        'RUNTIME_SEED_FAILED',
        502
      );
    }

    // Step 3: Cross-space attachment copying via AttachmentCopyPort
    await this.copyCrossSpaceAttachments(plan, forkOpId);

    // Step 4: DB transaction to finalize route, generation, messages, attachments, idempotency
    return this.finalizeForkInDb(plan, forkOpId, currentRequestHash, idempotencyKey);
  }

  private async copyCrossSpaceAttachments(plan: ForkPlan, forkOpId: string): Promise<void> {
    const { userId, sourceSpaceId, targetSpaceId, includedMessageIds } = plan;

    if (targetSpaceId !== sourceSpaceId && includedMessageIds.length > 0) {
      for (const msgId of includedMessageIds) {
        const attRows = this.db
          .prepare(`
            SELECT relative_path, snapshot_path, etag, size, media_type, display_name
            FROM message_attachments
            WHERE message_id = ? AND user_id = ?
          `)
          .all(msgId, userId) as Array<{
            relative_path: string;
            snapshot_path: string;
            etag: string;
            size: number;
            media_type: string;
            display_name: string | null;
          }>;

        for (const att of attRows) {
          try {
            await this.attachmentCopyPort.copyAttachment({
              userId,
              sourceSpaceId,
              targetSpaceId,
              sourceSnapshotPath: att.snapshot_path,
              targetSnapshotPath: att.snapshot_path,
              etag: att.etag,
            });
          } catch {
            this.db
              .prepare(`
                UPDATE fork_operations
                SET status = 'failed', error_code = 'ATTACHMENT_COPY_FAILED', error_message = 'Fork attachment copy failed', updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
              `)
              .run(forkOpId);
            throw new PlatformError(
              'Fork attachment copy failed',
              'ATTACHMENT_COPY_FAILED',
              502
            );
          }
        }
      }
    }

    this.db
      .prepare(`
        UPDATE fork_operations
        SET status = 'attachments_copied', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .run(forkOpId);
  }

  private finalizeForkInDb(
    plan: ForkPlan,
    forkOpId: string,
    requestHash: string,
    idempotencyKey?: string
  ): PublicSession {
    const {
      userId,
      targetSpaceId,
      forkedRouteId,
      forkedDshSessionId,
      forkedTitle,
      agentProfileId,
      agentProfileSnapshotId,
      includedMessageIds,
    } = plan;

    const nowIso = new Date().toISOString();
    let inTx = false;
    this.db.exec('BEGIN IMMEDIATE');
    inTx = true;
    try {
      // 1. Insert session_routes
      const spaceRow = this.db
        .prepare('SELECT execution_mode FROM spaces WHERE id = ? AND user_id = ?')
        .get(targetSpaceId, userId) as { execution_mode?: string } | undefined;
      const forkedExecutionMode = spaceRow?.execution_mode ?? 'container';
      this.db
        .prepare(`
          INSERT INTO session_routes (
            id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id,
            execution_mode, status, title, reset_count, current_generation,
            agent_profile_id, agent_profile_snapshot_id, created_at, updated_at
          ) VALUES (?, ?, ?, 'web', 'default', ?, ?, ?, ?, 'active', ?, 0, 1, ?, ?, ?, ?)
        `)
        .run(
          forkedRouteId,
          targetSpaceId,
          userId,
          forkedRouteId,
          forkedRouteId,
          forkedDshSessionId,
          forkedExecutionMode,
          forkedTitle,
          agentProfileId,
          agentProfileSnapshotId,
          nowIso,
          nowIso
        );

      // 2. Insert session_generations (gen 1)
      const genId = `gen_${randomUUID().replace(/-/g, '')}`;
      this.db
        .prepare(`
          INSERT INTO session_generations (
            id, user_id, route_id, generation_number, dsh_session_id,
            agent_profile_snapshot_id, reset_reason, created_at
          ) VALUES (?, ?, ?, 1, ?, ?, 'fork', ?)
        `)
        .run(
          genId,
          userId,
          forkedRouteId,
          forkedDshSessionId,
          agentProfileSnapshotId,
          nowIso
        );

      // 3. Copy web_messages, web_events, message_attachments
      const msgInsertStmt = this.db.prepare(`
        INSERT INTO web_messages (
          id, session_id, user_id, role, content, status, route_key, turn_id, metadata, created_at
        ) VALUES (?, ?, ?, ?, ?, 'delivered', ?, ?, NULL, ?)
      `);
      const eventInsertStmt = this.db.prepare(`
        INSERT INTO web_events (
          id, session_id, user_id, type, payload, created_at
        ) VALUES (?, ?, ?, 'message', ?, ?)
      `);
      const attInsertStmt = this.db.prepare(`
        INSERT INTO message_attachments (
          id, message_id, user_id, space_id, relative_path, snapshot_path, etag, size, media_type, display_name, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const routeKey = `web:default:${userId}:${forkedRouteId}`;

      for (const msgId of includedMessageIds) {
        const msg = this.db
          .prepare('SELECT role, content, turn_id, created_at FROM web_messages WHERE id = ? AND user_id = ?')
          .get(msgId, userId) as { role: string; content: string; turn_id: string | null; created_at: string } | undefined;

        if (!msg) continue;

        const newMsgId = generate32HexId('msg');
        msgInsertStmt.run(
          newMsgId,
          forkedRouteId,
          userId,
          msg.role,
          msg.content,
          routeKey,
          msg.turn_id,
          msg.created_at
        );

        const attRows = this.db
          .prepare(`
            SELECT relative_path, snapshot_path, etag, size, media_type, display_name, created_at
            FROM message_attachments
            WHERE message_id = ? AND user_id = ?
          `)
          .all(msgId, userId) as Array<{
            relative_path: string;
            snapshot_path: string;
            etag: string;
            size: number;
            media_type: string;
            display_name: string | null;
            created_at: string;
          }>;

        const publicAttachments = [];
        for (const att of attRows) {
          const newAttId = generate32HexId('att');
          attInsertStmt.run(
            newAttId,
            newMsgId,
            userId,
            targetSpaceId,
            att.relative_path,
            att.snapshot_path,
            att.etag,
            att.size,
            att.media_type,
            att.display_name,
            att.created_at
          );
          publicAttachments.push({
            id: newAttId,
            relativePath: att.relative_path,
            etag: att.etag,
            size: att.size,
            mediaType: att.media_type,
            ...(att.display_name ? { displayName: att.display_name } : {}),
            downloadUrl: `/api/spaces/${encodeURIComponent(targetSpaceId)}/files/download?path=${encodeURIComponent(att.snapshot_path)}`,
          });
        }

        const refRow = this.db
          .prepare('SELECT reply_to_message_id, quote_snippet, source_role FROM message_references WHERE message_id = ? AND user_id = ?')
          .get(msgId, userId) as { reply_to_message_id: string | null; quote_snippet: string; source_role: string | null } | undefined;

        let replyRefPayload: { messageId: string; role?: string; snippet: string } | undefined = undefined;
        if (refRow && refRow.reply_to_message_id) {
          this.db.prepare(`
            INSERT INTO message_references (
              id, message_id, user_id, reply_to_message_id, quote_snippet, source_role, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            generate32HexId('ref'),
            newMsgId,
            userId,
            refRow.reply_to_message_id,
            refRow.quote_snippet,
            refRow.source_role,
            msg.created_at
          );
          replyRefPayload = {
            messageId: refRow.reply_to_message_id,
            role: refRow.source_role || undefined,
            snippet: refRow.quote_snippet,
          };
        }

        const msgEventRecord = {
          id: newMsgId,
          role: msg.role,
          content: msg.content,
          status: 'delivered',
          createdAt: msg.created_at,
          ...(publicAttachments.length > 0 ? { attachments: publicAttachments } : {}),
          ...(replyRefPayload ? { replyReference: replyRefPayload } : {}),
        };
        eventInsertStmt.run(
          generate32HexId('evt'),
          forkedRouteId,
          userId,
          JSON.stringify({ message: msgEventRecord }),
          msg.created_at
        );
      }

      const createdRoute: SessionRoute = {
        id: forkedRouteId,
        spaceId: targetSpaceId,
        userId,
        channel: 'web',
        accountId: 'default',
        nativeContextId: forkedRouteId,
        peerId: forkedRouteId,
        dshSessionId: forkedDshSessionId,
        executionMode: 'container',
        status: 'active',
        title: forkedTitle,
        currentGeneration: 1,
        resetCount: 0,
        lastResetAt: null,
        agentProfileId,
        agentProfileSnapshotId,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      const publicSession = this.toPublicSession(createdRoute);

      // 4. Insert into operation_idempotency
      if (idempotencyKey) {
        this.db
          .prepare(`
            INSERT INTO operation_idempotency (
              id, user_id, scope, idempotency_key, target_id, request_hash, response_payload, created_at
            ) VALUES (?, ?, 'fork_session', ?, ?, ?, ?, CURRENT_TIMESTAMP)
          `)
          .run(
            `idemp_${randomUUID().replace(/-/g, '')}`,
            userId,
            idempotencyKey,
            forkedRouteId,
            requestHash,
            JSON.stringify(publicSession)
          );
      }

      // 5. Mark fork operation finalized
      this.db
        .prepare(`
          UPDATE fork_operations
          SET status = 'finalized', updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `)
        .run(forkOpId);

      this.db.exec('COMMIT');
      inTx = false;

      return publicSession;
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

  /**
   * Startup crash recovery: reconcile any fork operations stuck in 'seeded' or 'attachments_copied' status
   */
  async reconcilePendingOperations(): Promise<number> {
    const seededRows = this.db
      .prepare(`
        SELECT id, user_id, status, request_hash, idempotency_key, fork_plan_json
        FROM fork_operations
        WHERE status IN ('seeded', 'attachments_copied')
      `)
      .all() as Array<{
        id: string;
        user_id: string;
        status: string;
        request_hash: string;
        idempotency_key: string | null;
        fork_plan_json: string;
      }>;

    let reconciled = 0;
    for (const row of seededRows) {
      try {
        const plan = JSON.parse(row.fork_plan_json) as ForkPlan;
        const existingRoute = this.db
          .prepare('SELECT id FROM session_routes WHERE id = ?')
          .get(plan.forkedRouteId);

        if (row.status === 'seeded') {
          await this.copyCrossSpaceAttachments(plan, row.id);
        }

        if (!existingRoute) {
          this.finalizeForkInDb(plan, row.id, row.request_hash, row.idempotency_key ?? undefined);
          reconciled++;
        } else {
          this.db
            .prepare("UPDATE fork_operations SET status = 'finalized', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .run(row.id);
        }
      } catch {
        this.db
          .prepare("UPDATE fork_operations SET status = 'failed', error_code = 'FORK_RECOVERY_FAILED', error_message = 'Fork recovery failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(row.id);
      }
    }
    return reconciled;
  }
}
