/**
 * Authoritative Runtime Instructions Artifact Port
 *
 * Implements container volume-aware file operations for global and space instructions
 * without guessing host paths or bypassing container security boundaries.
 *
 * Targets:
 * - 'global': strictly '$DSH_HOME/AGENTS.md' (max 20 KiB)
 * - 'space':  '<spaceFolder>/AGENTS.md' or '<spaceFolder>/CLAUDE.md' (max 64 KiB)
 *
 * @module @enkeep/platform-server/instructions/runtime-instructions-port
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  PlatformError,
  NotFoundError,
  ValidationError,
  ForbiddenError,
  ConflictError,
} from '@enkeep/platform-core';
import type { TenantRuntimeFileProvider } from '../files/runtime-file-api.js';

export const MAX_GLOBAL_INSTRUCTIONS_BYTES = 20 * 1024; // 20 KiB strict limit (20,480 bytes)
export const MAX_SPACE_INSTRUCTIONS_BYTES = 64 * 1024; // 64 KiB strict limit (65,536 bytes)
export const ETAG_REGEX = /^"[0-9a-f]{64}"$/;

export class PreconditionRequiredError extends PlatformError {
  constructor(message = 'Header "If-Match" is required when modifying existing instructions') {
    super(message, 'PRECONDITION_REQUIRED', 428);
  }
}

export type InstructionsTarget = 'global' | 'space';
export type InstructionsFilename = 'AGENTS.md' | 'CLAUDE.md';

export function computeContentEtag(content: string): string {
  const hash = createHash('sha256').update(content, 'utf8').digest('hex').toLowerCase();
  return `"${hash}"`;
}

export function computeContentSha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').toLowerCase();
}

/**
 * Validates and normalizes instruction filename.
 * Global only allows 'AGENTS.md'.
 * Space allows 'AGENTS.md' or 'CLAUDE.md'.
 */
export function validateInstructionsFilename(
  target: InstructionsTarget,
  rawFilename?: unknown
): InstructionsFilename {
  if (target === 'global') {
    if (rawFilename !== undefined && rawFilename !== null && rawFilename !== '' && rawFilename !== 'AGENTS.md') {
      throw new ValidationError('Global instructions only support "AGENTS.md"');
    }
    return 'AGENTS.md';
  }

  // target === 'space'
  if (rawFilename === undefined || rawFilename === null || rawFilename === '') {
    return 'AGENTS.md'; // Default space filename
  }

  if (typeof rawFilename !== 'string') {
    throw new ValidationError('Instructions filename must be a string');
  }

  const trimmed = rawFilename.trim().normalize('NFC');
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0') || trimmed.includes('..')) {
    throw new ValidationError('Invalid characters or path traversal in instructions filename');
  }

  if (trimmed !== 'AGENTS.md' && trimmed !== 'CLAUDE.md') {
    throw new ValidationError(`Unsupported space instructions filename "${trimmed}". Allowed: AGENTS.md, CLAUDE.md`);
  }

  return trimmed as InstructionsFilename;
}

export interface ReadInstructionsRequest {
  userId: string;
  target: InstructionsTarget;
  spaceId?: string;
  spaceFolder?: string;
  filename?: InstructionsFilename | string;
}

export interface ReadInstructionsResult {
  content: string;
  etag: string | null;
  size: number;
  mtimeMs: number;
  exists: boolean;
  filename: InstructionsFilename;
  target: InstructionsTarget;
}

export interface WriteInstructionsRequest {
  userId: string;
  target: InstructionsTarget;
  content: string;
  spaceId?: string;
  spaceFolder?: string;
  filename?: InstructionsFilename | string;
  expectedEtag?: string;
  requireAbsent?: boolean;
}

export interface WriteInstructionsResult {
  etag: string;
  size: number;
  mtimeMs: number;
  filename: InstructionsFilename;
  target: InstructionsTarget;
}

export interface RuntimeInstructionsPortOptions {
  fileProvider?: TenantRuntimeFileProvider;
  db: DatabaseSync;
}

export class RuntimeInstructionsPort {
  private readonly fileProvider?: TenantRuntimeFileProvider;
  private readonly db: DatabaseSync;

  constructor(options: RuntimeInstructionsPortOptions) {
    if (!options || !options.db) {
      throw new ValidationError('RuntimeInstructionsPort requires db option');
    }
    this.fileProvider = options.fileProvider;
    this.db = options.db;
  }

  /**
   * Resolves space metadata from database.
   */
  resolveSpace(userId: string, spaceId: string): { id: string; folder: string; name: string; status: string } {
    if (!userId || typeof userId !== 'string') {
      throw new ValidationError('Invalid userId');
    }
    if (!spaceId || typeof spaceId !== 'string') {
      throw new ValidationError('Invalid spaceId');
    }

    const row = this.db.prepare(`
      SELECT id, folder, name, status
      FROM spaces
      WHERE id = ? AND user_id = ?
    `).get(spaceId, userId) as { id: string; folder: string; name: string; status: string } | undefined;

    if (!row) {
      throw new NotFoundError(`Space "${spaceId}" not found for user "${userId}"`);
    }
    if (row.status !== 'active') {
      throw new PlatformError(`Space "${spaceId}" is not active (status: ${row.status})`, 'SPACE_INACTIVE', 400);
    }

    return row;
  }

  /**
   * Reads an instructions file from the user container volume.
   */
  async readInstructions(req: ReadInstructionsRequest): Promise<ReadInstructionsResult> {
    const { userId, target } = req;
    if (!userId || typeof userId !== 'string') {
      throw new ValidationError('User ID is required');
    }

    const filename = validateInstructionsFilename(target, req.filename);

    if (target === 'global') {
      if (!this.fileProvider) {
        throw new PlatformError('TenantRuntimeFileProvider is not configured on platform server', 'RUNTIME_UNAVAILABLE', 503);
      }

      if (typeof this.fileProvider.readGlobalInstructions === 'function') {
        const readRes = await this.fileProvider.readGlobalInstructions(userId);
        if (!readRes.exists) {
          return {
            content: '',
            etag: null,
            size: 0,
            mtimeMs: 0,
            exists: false,
            filename: 'AGENTS.md',
            target: 'global',
          };
        }
        const normalized = (readRes.content || '').normalize('NFC');
        const etag = readRes.etag || computeContentEtag(normalized);
        return {
          content: normalized,
          etag,
          size: readRes.size ?? Buffer.byteLength(normalized, 'utf8'),
          mtimeMs: readRes.mtimeMs ?? Date.now(),
          exists: true,
          filename: 'AGENTS.md',
          target: 'global',
        };
      }

      // Default fallback if not available
      return {
        content: '',
        etag: null,
        size: 0,
        mtimeMs: 0,
        exists: false,
        filename: 'AGENTS.md',
        target: 'global',
      };
    }

    // target === 'space'
    if (!req.spaceId) {
      throw new ValidationError('Space ID is required for space instructions');
    }

    const space = this.resolveSpace(userId, req.spaceId);

    if (!this.fileProvider) {
      throw new PlatformError('TenantRuntimeFileProvider is not configured on platform server', 'RUNTIME_UNAVAILABLE', 503);
    }

    try {
      const readRes = await this.fileProvider.execute(userId, space.id, {
        op: 'read',
        path: filename,
        encoding: 'utf8',
      });

      if (readRes.op === 'read' && typeof readRes.content === 'string') {
        const normalized = readRes.content.normalize('NFC');
        const etag = readRes.etag || computeContentEtag(normalized);
        return {
          content: normalized,
          etag,
          size: readRes.size ?? Buffer.byteLength(normalized, 'utf8'),
          mtimeMs: readRes.mtimeMs ?? Date.now(),
          exists: true,
          filename,
          target: 'space',
        };
      }

      return {
        content: '',
        etag: null,
        size: 0,
        mtimeMs: 0,
        exists: false,
        filename,
        target: 'space',
      };
    } catch (err: any) {
      if (err instanceof NotFoundError || err?.code === 'NOT_FOUND' || err?.status === 404) {
        return {
          content: '',
          etag: null,
          size: 0,
          mtimeMs: 0,
          exists: false,
          filename,
          target: 'space',
        };
      }
      throw err;
    }
  }

  /**
   * Writes an instructions file into the user container volume with atomic ETag verification and NFC normalization.
   */
  async writeInstructions(req: WriteInstructionsRequest): Promise<WriteInstructionsResult> {
    const { userId, target } = req;
    if (!userId || typeof userId !== 'string') {
      throw new ValidationError('User ID is required');
    }

    const filename = validateInstructionsFilename(target, req.filename);
    const rawContent = typeof req.content === 'string' ? req.content : '';
    const normalized = rawContent.normalize('NFC');
    const contentBytes = Buffer.byteLength(normalized, 'utf8');

    const maxSize = target === 'global' ? MAX_GLOBAL_INSTRUCTIONS_BYTES : MAX_SPACE_INSTRUCTIONS_BYTES;
    if (contentBytes > maxSize) {
      throw new ValidationError(
        `${target === 'global' ? 'Global' : 'Space'} instructions content size (${contentBytes} bytes) exceeds limit of ${maxSize} bytes`
      );
    }

    if (!this.fileProvider) {
      throw new PlatformError('TenantRuntimeFileProvider is not configured on platform server', 'RUNTIME_UNAVAILABLE', 503);
    }

    if (target === 'global') {
      if (typeof this.fileProvider.writeGlobalInstructions === 'function') {
        try {
          const writeRes = await this.fileProvider.writeGlobalInstructions(userId, normalized, {
            expectedEtag: req.expectedEtag,
            requireAbsent: req.requireAbsent,
          });
          return {
            etag: writeRes.etag || computeContentEtag(normalized),
            size: writeRes.size ?? contentBytes,
            mtimeMs: writeRes.mtimeMs ?? Date.now(),
            filename: 'AGENTS.md',
            target: 'global',
          };
        } catch (err: any) {
          if (err?.code === 'PRECONDITION_FAILED' || err?.code === 'CONFLICT' || err?.status === 409 || err?.status === 412) {
            throw new ConflictError(err.message || 'Global instructions precondition failed (ETag mismatch)');
          }
          throw err;
        }
      }

      throw new PlatformError('writeGlobalInstructions is not supported by configured file provider', 'NOT_SUPPORTED', 500);
    }

    // target === 'space'
    if (!req.spaceId) {
      throw new ValidationError('Space ID is required for space instructions');
    }

    const space = this.resolveSpace(userId, req.spaceId);

    // Build write request with expectedEtag or requireAbsent
    let writeReq: any;
    if (req.expectedEtag) {
      writeReq = {
        op: 'write',
        path: filename,
        content: normalized,
        encoding: 'utf8',
        expectedEtag: req.expectedEtag,
      };
    } else if (req.requireAbsent === true) {
      writeReq = {
        op: 'write',
        path: filename,
        content: normalized,
        encoding: 'utf8',
        requireAbsent: true,
      };
    } else {
      // Check if file exists to fetch current etag for safe CAS
      try {
        const statRes = await this.fileProvider.execute(userId, space.id, {
          op: 'stat',
          path: filename,
        });
        if (statRes.op === 'stat' && statRes.type === 'file') {
          writeReq = {
            op: 'write',
            path: filename,
            content: normalized,
            encoding: 'utf8',
            expectedEtag: statRes.etag,
          };
        } else {
          writeReq = {
            op: 'write',
            path: filename,
            content: normalized,
            encoding: 'utf8',
            requireAbsent: true,
          };
        }
      } catch {
        writeReq = {
          op: 'write',
          path: filename,
          content: normalized,
          encoding: 'utf8',
          requireAbsent: true,
        };
      }
    }

    try {
      const writeRes: any = await this.fileProvider.execute(userId, space.id, writeReq);
      const resultEtag = writeRes.etag || computeContentEtag(normalized);

      return {
        etag: resultEtag,
        size: writeRes.size ?? contentBytes,
        mtimeMs: writeRes.mtimeMs ?? Date.now(),
        filename,
        target: 'space',
      };
    } catch (err: any) {
      if (err?.code === 'PRECONDITION_FAILED' || err?.code === 'CONFLICT' || err?.status === 409 || err?.status === 412) {
        throw new ConflictError(err.message || 'Space instructions precondition failed (ETag mismatch)');
      }
      throw err;
    }
  }
}
