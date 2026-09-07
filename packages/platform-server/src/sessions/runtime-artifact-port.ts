/**
 * Runtime Artifact & Attachment Copy Ports for Online Fork and Session Restore
 *
 * Provides backend-agnostic contracts for inspecting, exporting, and importing
 * official DSH runtime transcripts and copying snapshot attachments cross-space.
 *
 * @module @enkeep/platform-server/sessions/runtime-artifact-port
 */

import type { DatabaseSync } from 'node:sqlite';
import { ValidationError, PlatformError } from '@enkeep/platform-core';
import type { TenantRuntimeFileProvider } from '../files/runtime-file-api.js';
import { generate32HexId } from '../storage/web-messages.js';

export interface SessionArtifactCheckResult {
  exists: boolean;
  valid: boolean;
  checksum?: string;
  eventCount?: number;
}

export interface SessionCorruptionInspectResult {
  exists: boolean;
  valid: boolean;
  corrupted: boolean;
  code: 'VALID' | 'CORRUPTED' | 'SEQ_GAP' | 'SYNTAX_ERROR' | 'NOT_FOUND';
  lastValidSeq: number;
  lineCount: number;
  validEventsCount: number;
  errorDetail?: string;
}

export interface SessionPrefixRecoveryResult {
  recovered: boolean;
  targetDshId: string;
  validEventsCount: number;
  backupPath: string;
  backupChecksum: string;
}

export interface SessionSeedReceipt {
  algorithm: 'sha256-session-events-v1';
  checksum: string;
  canonicalBytes: number;
  eventCount: number;
  importedAt?: string;
}

export interface ForkBoundaryOptions {
  fromMessageId?: string;
  fromTurnId?: string;
}

export interface ExportForkSeedResult {
  events: readonly unknown[];
  receipt: SessionSeedReceipt;
  boundaryMapping?: Record<string, unknown>;
}

export interface ImportSeedResult {
  status: string;
  persisted: boolean;
  eventsCount?: number;
  receipt?: SessionSeedReceipt;
  duplicate?: boolean;
}

export interface RuntimeArtifactPort {
  checkSessionArtifact(options: {
    userId: string;
    dshSessionId: string;
    workspaceFolder?: string;
  }): Promise<SessionArtifactCheckResult>;

  exportForkSeed(options: {
    userId: string;
    sourceDshSessionId: string;
    boundary?: ForkBoundaryOptions;
    workspaceFolder?: string;
  }): Promise<ExportForkSeedResult>;

  importSeed(options: {
    userId: string;
    targetDshId: string;
    events: readonly unknown[];
    receipt: SessionSeedReceipt;
    profile?: unknown;
    workspaceFolder?: string;
  }): Promise<ImportSeedResult>;

  inspectSessionCorruption?(options: {
    userId: string;
    dshSessionId: string;
    workspaceFolder?: string;
  }): Promise<SessionCorruptionInspectResult>;

  recoverValidPrefix?(options: {
    userId: string;
    dshSessionId: string;
    targetDshId: string;
    workspaceFolder?: string;
    maxValidSeq?: number;
  }): Promise<SessionPrefixRecoveryResult>;

  corruptSessionArtifact?(options: {
    userId: string;
    dshSessionId: string;
    workspaceFolder?: string;
    type?: 'seq_gap' | 'syntax_error';
  }): Promise<{ corrupted: boolean }>;

  resolveArtifactHandle?(options: {
    userId: string;
    dshSessionId?: string;
    workspaceFolder?: string;
  }): Promise<any>;
}

export interface CopyAttachmentOptions {
  userId: string;
  sourceSpaceId: string;
  targetSpaceId: string;
  sourceSnapshotPath: string;
  targetSnapshotPath: string;
  etag?: string;
  contentSha256?: string;
}

export interface AttachmentCopyResult {
  status: 'copied' | 'already_exists';
  size: number;
  etag: string;
  contentSha256: string;
}

export interface AttachmentCopyPort {
  copyAttachment(options: CopyAttachmentOptions): Promise<AttachmentCopyResult>;
}

export interface FileProviderAttachmentCopyPortOptions {
  fileProvider: TenantRuntimeFileProvider;
  db: DatabaseSync;
}

export class FileProviderAttachmentCopyPort implements AttachmentCopyPort {
  private readonly fileProvider: TenantRuntimeFileProvider;
  private readonly db: DatabaseSync;

  constructor(options: FileProviderAttachmentCopyPortOptions) {
    if (!options || typeof options !== 'object') {
      throw new ValidationError('FileProviderAttachmentCopyPort requires options object');
    }
    if (!options.fileProvider) {
      throw new ValidationError('FileProviderAttachmentCopyPort requires fileProvider instance');
    }
    if (!options.db) {
      throw new ValidationError('FileProviderAttachmentCopyPort requires db instance');
    }
    this.fileProvider = options.fileProvider;
    this.db = options.db;
  }

  async copyAttachment(options: CopyAttachmentOptions): Promise<AttachmentCopyResult> {
    const {
      userId,
      sourceSpaceId,
      targetSpaceId,
      sourceSnapshotPath,
      targetSnapshotPath,
      etag,
      contentSha256,
    } = options;

    if (!userId || !sourceSpaceId || !targetSpaceId || !sourceSnapshotPath || !targetSnapshotPath) {
      throw new ValidationError('All fields are required for copyAttachment');
    }

    // 1. Check if snapshot already exists in target space
    try {
      const statRes = await this.fileProvider.execute(userId, targetSpaceId, {
        op: 'stat',
        path: targetSnapshotPath,
      });
      if (statRes && statRes.op === 'stat' && statRes.type === 'file') {
        return {
          status: 'already_exists',
          size: statRes.size ?? 0,
          etag: statRes.etag ?? etag ?? '',
          contentSha256: contentSha256 ?? (etag ? etag.replace(/"/g, '') : ''),
        };
      }
    } catch {
      // Snapshot does not exist in target space, proceed to copy
    }

    // 2. Stage entry in attachment_snapshot_journal
    const journalId = generate32HexId('attc');
    const deliveryId = `fork_${journalId}`;
    const sha = contentSha256 ?? (etag ? etag.replace(/"/g, '') : '0000000000000000000000000000000000000000000000000000000000000000');

    this.db.prepare(`
      INSERT INTO attachment_snapshot_journal (
        id, delivery_id, user_id, space_id, source_path, snapshot_path, content_sha256, size, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'staging', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(
      journalId,
      deliveryId,
      userId,
      targetSpaceId,
      sourceSnapshotPath,
      targetSnapshotPath,
      sha
    );

    try {
      const targetSpaceRow = this.db.prepare(
        'SELECT folder FROM spaces WHERE id = ? AND user_id = ?'
      ).get(targetSpaceId, userId) as { folder: string } | undefined;
      const targetFolder = targetSpaceRow?.folder;

      const copyRes = await this.fileProvider.execute(userId, sourceSpaceId, {
        op: 'copy',
        path: sourceSnapshotPath,
        targetPath: targetSnapshotPath,
        targetSpace: targetFolder || targetSpaceId,
        expectedEtag: etag,
      } as any);

      const finalSize = (copyRes as any).size ?? 0;
      const finalEtag = (copyRes as any).etag ?? etag ?? '';
      const finalSha = (copyRes as any).sha256 ?? sha;

      this.db.prepare(`
        UPDATE attachment_snapshot_journal
        SET status = 'copied', size = ?, content_sha256 = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(finalSize, finalSha, journalId);

      return {
        status: 'copied',
        size: finalSize,
        etag: finalEtag,
        contentSha256: finalSha,
      };
    } catch (copyErr) {
      this.db.prepare(`
        UPDATE attachment_snapshot_journal
        SET status = 'aborted', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(journalId);
      const errMsg = copyErr instanceof Error ? copyErr.message : String(copyErr);
      throw new PlatformError(
        `Failed to copy attachment cross-space: ${errMsg}`,
        'ATTACHMENT_COPY_FAILED',
        502
      );
    }
  }
}
