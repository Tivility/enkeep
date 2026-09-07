/**
 * Authoritative Platform Instructions Governance Service
 *
 * Implements:
 * - User global instructions management ($DSH_HOME/AGENTS.md)
 * - Space instructions management (<space>/AGENTS.md or <space>/CLAUDE.md)
 * - Volume-first storage authority inside user container volume without host path guessing
 * - ETag concurrency control (If-Match / CAS)
 * - Unicode NFC normalization on content
 * - Safe audit logging strictly omitting file contents
 * - Storage quota transaction integration
 *
 * @module @enkeep/platform-server/instructions/instructions-service
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  PlatformError,
  NotFoundError,
  ValidationError,
  ForbiddenError,
  ConflictError,
  type User,
  type PlatformStorage,
} from '@enkeep/platform-core';
import type { PlatformOperationsService } from '@enkeep/platform-operations';
import {
  RuntimeInstructionsPort,
  validateInstructionsFilename,
  computeContentEtag,
  computeContentSha256,
  MAX_GLOBAL_INSTRUCTIONS_BYTES,
  MAX_SPACE_INSTRUCTIONS_BYTES,
  PreconditionRequiredError,
  type InstructionsTarget,
  type InstructionsFilename,
  type ReadInstructionsResult,
  type WriteInstructionsResult,
} from './runtime-instructions-port.js';
import type { TenantRuntimeFileProvider } from '../files/runtime-file-api.js';

export interface InstructionsServiceOptions {
  storage: PlatformStorage;
  db: DatabaseSync;
  fileProvider?: TenantRuntimeFileProvider;
  operations?: PlatformOperationsService | any;
}

export interface InstructionsPayload {
  content: string;
  etag: string | null;
  size: number;
  mtimeMs: number;
  exists: boolean;
  filename: InstructionsFilename;
  target: InstructionsTarget;
  spaceId?: string;
}

export interface InstructionsWritePayload {
  etag: string;
  size: number;
  mtimeMs: number;
  filename: InstructionsFilename;
  target: InstructionsTarget;
  spaceId?: string;
}

export class InstructionsService {
  private readonly storage: PlatformStorage;
  private readonly db: DatabaseSync;
  private readonly instructionsPort: RuntimeInstructionsPort;
  private readonly operations?: PlatformOperationsService | any;

  constructor(options: InstructionsServiceOptions) {
    if (!options || !options.storage || !options.db) {
      throw new ValidationError('InstructionsService requires storage and db options');
    }
    this.storage = options.storage;
    this.db = options.db;
    this.operations = options.operations;
    this.instructionsPort = new RuntimeInstructionsPort({
      fileProvider: options.fileProvider,
      db: options.db,
    });
  }

  /**
   * Records an audit log entry strictly omitting raw file content.
   */
  private async recordAudit(
    userId: string,
    action: string,
    details: Record<string, unknown>
  ): Promise<void> {
    try {
      if (this.storage.auditLogs && typeof this.storage.auditLogs.create === 'function') {
        await this.storage.auditLogs.create({
          userId,
          action: action as any,
          details: details as any,
        });
      }
    } catch {
      // Non-blocking audit failure
    }
  }

  /**
   * Gets user global instructions ($DSH_HOME/AGENTS.md).
   */
  async getGlobalInstructions(user: User): Promise<InstructionsPayload> {
    if (!user || !user.id) {
      throw new ValidationError('User is required to read global instructions');
    }

    const readRes = await this.instructionsPort.readInstructions({
      userId: user.id,
      target: 'global',
      filename: 'AGENTS.md',
    });

    return {
      content: readRes.content,
      etag: readRes.etag,
      size: readRes.size,
      mtimeMs: readRes.mtimeMs,
      exists: readRes.exists,
      filename: 'AGENTS.md',
      target: 'global',
    };
  }

  /**
   * Puts user global instructions ($DSH_HOME/AGENTS.md) with ETag CAS and NFC normalization.
   */
  async putGlobalInstructions(
    user: User,
    content: string,
    options?: { expectedEtag?: string; ifMatch?: string }
  ): Promise<InstructionsWritePayload> {
    if (!user || !user.id) {
      throw new ValidationError('User is required to write global instructions');
    }

    const normalizedContent = (content || '').normalize('NFC');
    const contentBytes = Buffer.byteLength(normalizedContent, 'utf8');

    if (contentBytes > MAX_GLOBAL_INSTRUCTIONS_BYTES) {
      throw new ValidationError(
        `Global instructions content size (${contentBytes} bytes) exceeds limit of ${MAX_GLOBAL_INSTRUCTIONS_BYTES} bytes (20 KiB)`
      );
    }

    const effectiveExpectedEtag = options?.ifMatch || options?.expectedEtag;

    // Check quota before write
    let deltaBytes = contentBytes;
    try {
      const existing = await this.instructionsPort.readInstructions({
        userId: user.id,
        target: 'global',
        filename: 'AGENTS.md',
      });
      if (existing.exists) {
        deltaBytes = contentBytes - existing.size;
      }
    } catch {}

    if (deltaBytes > 0 && this.operations && typeof this.operations.checkUserQuota === 'function') {
      await this.operations.checkUserQuota(user.id, deltaBytes);
    }

    const writeRes = await this.instructionsPort.writeInstructions({
      userId: user.id,
      target: 'global',
      filename: 'AGENTS.md',
      content: normalizedContent,
      expectedEtag: effectiveExpectedEtag,
    });

    // Record storage difference in quota ledger
    if (this.operations && typeof this.operations.adjustStorageUsage === 'function') {
      try {
        await this.operations.adjustStorageUsage(user.id, deltaBytes);
      } catch {}
    }

    // Safe audit logging (content strictly omitted)
    await this.recordAudit(user.id, 'instructions.update_global', {
      filename: 'AGENTS.md',
      size: writeRes.size,
      etag: writeRes.etag,
      deltaBytes,
    });

    return {
      etag: writeRes.etag,
      size: writeRes.size,
      mtimeMs: writeRes.mtimeMs,
      filename: 'AGENTS.md',
      target: 'global',
    };
  }

  /**
   * Gets space instructions (<space>/AGENTS.md or <space>/CLAUDE.md).
   */
  async getSpaceInstructions(
    user: User,
    spaceId: string,
    rawFilename?: string
  ): Promise<InstructionsPayload> {
    if (!user || !user.id) {
      throw new ValidationError('User is required to read space instructions');
    }
    if (!spaceId || typeof spaceId !== 'string') {
      throw new ValidationError('Space ID is required');
    }

    const filename = validateInstructionsFilename('space', rawFilename);
    const space = this.instructionsPort.resolveSpace(user.id, spaceId);

    const readRes = await this.instructionsPort.readInstructions({
      userId: user.id,
      target: 'space',
      spaceId: space.id,
      spaceFolder: space.folder,
      filename,
    });

    return {
      content: readRes.content,
      etag: readRes.etag,
      size: readRes.size,
      mtimeMs: readRes.mtimeMs,
      exists: readRes.exists,
      filename,
      target: 'space',
      spaceId: space.id,
    };
  }

  /**
   * Puts space instructions (<space>/AGENTS.md or <space>/CLAUDE.md) with ETag CAS and NFC normalization.
   */
  async putSpaceInstructions(
    user: User,
    spaceId: string,
    content: string,
    options?: { filename?: string; expectedEtag?: string; ifMatch?: string }
  ): Promise<InstructionsWritePayload> {
    if (!user || !user.id) {
      throw new ValidationError('User is required to write space instructions');
    }
    if (!spaceId || typeof spaceId !== 'string') {
      throw new ValidationError('Space ID is required');
    }

    const filename = validateInstructionsFilename('space', options?.filename);
    const space = this.instructionsPort.resolveSpace(user.id, spaceId);

    const normalizedContent = (content || '').normalize('NFC');
    const contentBytes = Buffer.byteLength(normalizedContent, 'utf8');

    if (contentBytes > MAX_SPACE_INSTRUCTIONS_BYTES) {
      throw new ValidationError(
        `Space instructions content size (${contentBytes} bytes) exceeds limit of ${MAX_SPACE_INSTRUCTIONS_BYTES} bytes (64 KiB)`
      );
    }

    const effectiveExpectedEtag = options?.ifMatch || options?.expectedEtag;

    // Check quota before write
    let deltaBytes = contentBytes;
    try {
      const existing = await this.instructionsPort.readInstructions({
        userId: user.id,
        target: 'space',
        spaceId: space.id,
        spaceFolder: space.folder,
        filename,
      });
      if (existing.exists) {
        deltaBytes = contentBytes - existing.size;
      }
    } catch {}

    if (deltaBytes > 0 && this.operations && typeof this.operations.checkUserQuota === 'function') {
      await this.operations.checkUserQuota(user.id, deltaBytes);
    }

    const writeRes = await this.instructionsPort.writeInstructions({
      userId: user.id,
      target: 'space',
      spaceId: space.id,
      spaceFolder: space.folder,
      filename,
      content: normalizedContent,
      expectedEtag: effectiveExpectedEtag,
    });

    // Record storage difference in quota ledger
    if (this.operations && typeof this.operations.adjustStorageUsage === 'function') {
      try {
        await this.operations.adjustStorageUsage(user.id, deltaBytes);
      } catch {}
    }

    // Safe audit logging (content strictly omitted)
    await this.recordAudit(user.id, 'instructions.update_space', {
      spaceId: space.id,
      spaceFolder: space.folder,
      filename,
      size: writeRes.size,
      etag: writeRes.etag,
      deltaBytes,
    });

    return {
      etag: writeRes.etag,
      size: writeRes.size,
      mtimeMs: writeRes.mtimeMs,
      filename,
      target: 'space',
      spaceId: space.id,
    };
  }
}
