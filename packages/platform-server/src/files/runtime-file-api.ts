/**
 * Safe Container Files Workbench API Service & Interfaces
 *
 * Implements strict, tenant-isolated, container file operations.
 *
 * Invariants:
 * - Public service inputs only userId, spaceId, relative path, and canonical operation fields.
 * - Provider interface: execute(userId: string, spaceId: string, request: CanonicalFileOperationRequest): Promise<CanonicalFileOperationResult>.
 * - Class only public execute(userId, spaceId, request); no convenience methods or overloads.
 * - Exact request union: list, read, write, mkdir, rename, delete (no recursive).
 * - mkdir requires `{ op: 'mkdir', path, requireAbsent: true }`.
 * - delete requires `{ op: 'delete', path, expectedEtag }`.
 * - ETags exact raw quoted lowercase SHA-256: `"[0-9a-f]{64}"`; reject weak, unquoted, uppercase, or whitespace.
 * - IDs: raw === trim/NFC/pattern; return raw.
 * - Error mapping: only if error is PlatformError or has exact allowlisted code; unknown fails with fixed 502. Never inspect err.message or String(err).
 * - Provider response exact discriminated required metadata (path, type, size, mtimeMs, etag). No fallbacks to 0 or Date.now().
 *
 * @module @enkeep/platform-server/files/runtime-file-api
 */

import {
  PlatformError,
  NotFoundError,
  ValidationError,
  ForbiddenError,
} from '@enkeep/platform-core';
import type { PlatformWebApi } from '@enkeep/web-channel';

export const MAX_FILE_SIZE_BYTES = 1024 * 1024; // 1 MiB
export const MAX_LIST_ENTRIES = 500;
export const MAX_PATH_LENGTH = 1024;
export const MAX_SEGMENT_LENGTH = 255;
export const SPACE_ID_REGEX = /^(spc_[0-9a-f]{32}|impsp_[0-9a-f]{64})$/;
export const USER_ID_REGEX = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|user_[a-z0-9_-]{1,64}|usr_[a-z0-9_-]{1,64})$/;
export const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const ETAG_LOWERCASE_SHA256_REGEX = /^"[0-9a-f]{64}"$/;

export type FileEntryType = 'file' | 'directory';
export type FileOpType = 'list' | 'read' | 'write' | 'mkdir' | 'rename' | 'delete' | 'stat' | 'sniff' | 'copy';
export type FileEncoding = 'utf8' | 'base64';

export interface FileListEntry {
  readonly name: string;
  readonly type: FileEntryType;
  readonly size: number;
  readonly mtimeMs: number;
  readonly etag: string;
}

export interface CanonicalListRequest {
  readonly op: 'list';
  readonly path?: string;
}

export interface CanonicalReadRequest {
  readonly op: 'read';
  readonly path: string;
  readonly encoding?: FileEncoding;
}

export interface CanonicalStatRequest {
  readonly op: 'stat';
  readonly path: string;
}

export interface CanonicalSniffRequest {
  readonly op: 'sniff';
  readonly path: string;
  readonly maxBytes?: number;
}

export interface CanonicalCopyRequest {
  readonly op: 'copy';
  readonly path: string;
  readonly targetPath: string;
  readonly targetSpace?: string;
  readonly expectedEtag?: string;
  readonly requireAbsent?: boolean;
}

export type CanonicalWriteRequest =
  | {
      readonly op: 'write';
      readonly path: string;
      readonly content: string;
      readonly encoding?: FileEncoding;
      readonly expectedEtag: string;
      readonly requireAbsent?: never;
    }
  | {
      readonly op: 'write';
      readonly path: string;
      readonly content: string;
      readonly encoding?: FileEncoding;
      readonly requireAbsent: true;
      readonly expectedEtag?: never;
    };

export type CanonicalRenameRequest =
  | {
      readonly op: 'rename';
      readonly path: string;
      readonly targetPath: string;
      readonly expectedEtag: string;
      readonly expectedTargetEtag: string;
      readonly requireTargetAbsent?: never;
    }
  | {
      readonly op: 'rename';
      readonly path: string;
      readonly targetPath: string;
      readonly expectedEtag: string;
      readonly requireTargetAbsent: true;
      readonly expectedTargetEtag?: never;
    };

export interface CanonicalMkdirRequest {
  readonly op: 'mkdir';
  readonly path: string;
  readonly requireAbsent: true;
}

export interface CanonicalDeleteRequest {
  readonly op: 'delete';
  readonly path: string;
  readonly expectedEtag: string;
}

export type CanonicalFileOperationRequest =
  | CanonicalListRequest
  | CanonicalReadRequest
  | CanonicalWriteRequest
  | CanonicalRenameRequest
  | CanonicalMkdirRequest
  | CanonicalDeleteRequest
  | CanonicalStatRequest
  | CanonicalSniffRequest
  | CanonicalCopyRequest;

export interface CanonicalListResult {
  readonly op: 'list';
  readonly path: string;
  readonly entries: readonly FileListEntry[];
  readonly truncated: boolean;
}

export interface CanonicalReadResult {
  readonly op: 'read';
  readonly path: string;
  readonly content: string;
  readonly encoding: FileEncoding;
  readonly type: 'file';
  readonly size: number;
  readonly mtimeMs: number;
  readonly etag: string;
}

export interface CanonicalStatResult {
  readonly op: 'stat';
  readonly path: string;
  readonly type: FileEntryType;
  readonly size: number;
  readonly mtimeMs: number;
  readonly etag: string;
}

export interface CanonicalSniffResult {
  readonly op: 'sniff';
  readonly path: string;
  readonly type: 'file';
  readonly size: number;
  readonly mtimeMs: number;
  readonly etag: string;
  readonly headerBytesBase64: string;
}

export interface CanonicalCopyResult {
  readonly op: 'copy';
  readonly path: string;
  readonly targetPath: string;
  readonly type: 'file';
  readonly size: number;
  readonly mtimeMs: number;
  readonly etag: string;
}

export interface CanonicalWriteResult {
  readonly op: 'write';
  readonly path: string;
  readonly type: 'file';
  readonly size: number;
  readonly mtimeMs: number;
  readonly etag: string;
}

export interface CanonicalRenameResult {
  readonly op: 'rename';
  readonly path: string;
  readonly targetPath: string;
  readonly type: FileEntryType;
  readonly size: number;
  readonly mtimeMs: number;
  readonly etag: string;
}

export interface CanonicalMkdirResult {
  readonly op: 'mkdir';
  readonly path: string;
  readonly type: 'directory';
  readonly size: number;
  readonly mtimeMs: number;
  readonly etag: string;
}

export interface CanonicalDeleteResult {
  readonly op: 'delete';
  readonly path: string;
  readonly type: FileEntryType;
  readonly size: number;
  readonly mtimeMs: number;
  readonly etag: string;
}

export type CanonicalFileOperationResult =
  | CanonicalListResult
  | CanonicalReadResult
  | CanonicalWriteResult
  | CanonicalRenameResult
  | CanonicalMkdirResult
  | CanonicalDeleteResult
  | CanonicalStatResult
  | CanonicalSniffResult
  | CanonicalCopyResult;

export interface CanonicalStreamingWriteRequest {
  readonly op: 'write';
  readonly path: string;
  readonly expectedEtag?: string;
  readonly requireAbsent?: boolean;
  readonly maxSizeBytes?: number;
  readonly expectedSizeBytes?: number;
}

export interface CanonicalStreamingReadRequest {
  readonly op: 'read';
  readonly path: string;
  readonly range?: {
    readonly start: number;
    readonly end: number;
  };
}

export interface CanonicalStreamingReadResult {
  readonly op: 'read';
  readonly path: string;
  readonly type: 'file';
  readonly size: number;
  readonly totalSize: number;
  readonly mtimeMs: number;
  readonly etag: string;
  readonly range?: {
    readonly start: number;
    readonly end: number;
  };
  readonly stream: NodeJS.ReadableStream;
}

export interface CanonicalStageRequest {
  readonly op: 'stage';
  readonly path: string;
  readonly maxSizeBytes?: number;
}

export interface CanonicalStageResult {
  readonly op: 'stage';
  readonly path: string;
  readonly stageToken: string;
  readonly size: number;
  readonly sha256: string;
  readonly etag: string;
}

export interface CanonicalCommitStageRequest {
  readonly op: 'commit_stage';
  readonly path: string;
  readonly stageToken: string;
  readonly rollbackToken?: string;
  readonly expectedEtag?: string;
  readonly requireAbsent?: boolean;
}

export interface CanonicalFinalizeStageRequest {
  readonly op: 'finalize_stage';
  readonly path: string;
  readonly rollbackToken?: string;
}

export interface CanonicalRollbackCommitRequest {
  readonly op: 'rollback_commit';
  readonly path: string;
  readonly rollbackToken?: string;
  readonly stageToken?: string;
  readonly expectedEtag?: string;
}

export interface CanonicalAbortStageRequest {
  readonly op: 'abort_stage';
  readonly path: string;
  readonly stageToken: string;
}

export interface CanonicalInspectTransferStateRequest {
  readonly op: 'inspect_transfer_state';
  readonly path: string;
  readonly stageToken?: string;
  readonly rollbackToken?: string;
  readonly expectedContentSha256: string;
  readonly overwrite?: boolean;
}

export interface CanonicalInspectTransferStateResult {
  readonly op: 'inspect_transfer_state';
  readonly path: string;
  readonly staged_present: boolean;
  readonly target_matches: boolean;
  readonly rollback_present: boolean;
  readonly stageExists: boolean;
  readonly rollbackExists: boolean;
  readonly targetExists: boolean;
  readonly targetEtag: string | null;
  readonly etag: string | null;
  readonly targetMtimeMs: number | null;
  readonly mtimeMs: number | null;
  readonly targetSize: number | null;
  readonly size: number | null;
  readonly targetMatchesContent: boolean;
  readonly consistentWithCommitted?: boolean;
  readonly consistentWithStagedPreCommit?: boolean;
}

export interface CanonicalInspectSnapshotStateRequest {
  readonly op: 'inspect_snapshot_state';
  readonly sourcePath?: string;
  readonly snapshotPath: string;
  readonly expectedContentSha256?: string;
}

export interface CanonicalInspectSnapshotStateResult {
  readonly op: 'inspect_snapshot_state';
  readonly sourcePath?: string;
  readonly snapshotPath: string;
  readonly sourceExists: boolean;
  readonly sourceEtag?: string | null;
  readonly sourceSize?: number | null;
  readonly sourceMatchesExpected?: boolean;
  readonly snapshotExists: boolean;
  readonly snapshotEtag?: string | null;
  readonly snapshotSize?: number | null;
  readonly snapshotHash?: string | null;
  readonly snapshotMatchesExpected: boolean;
}

/**
 * Tenant runtime file provider interface.
 * Solely responsible for tenant-authenticated resolution and native execution.
 */
export interface TenantRuntimeFileProvider {
  execute(
    userId: string,
    spaceId: string,
    request: CanonicalFileOperationRequest
  ): Promise<CanonicalFileOperationResult>;
  writeBinaryStream?(
    userId: string,
    spaceId: string,
    request: CanonicalStreamingWriteRequest,
    inStream: NodeJS.ReadableStream
  ): Promise<CanonicalWriteResult>;
  readBinaryStream?(
    userId: string,
    spaceId: string,
    request: CanonicalStreamingReadRequest
  ): Promise<CanonicalStreamingReadResult>;
  stageBinaryStream?(
    userId: string,
    spaceId: string,
    request: CanonicalStageRequest,
    inStream: NodeJS.ReadableStream
  ): Promise<CanonicalStageResult>;
  commitStage?(
    userId: string,
    spaceId: string,
    request: CanonicalCommitStageRequest
  ): Promise<CanonicalWriteResult & { rollbackToken?: string }>;
  finalizeStage?(
    userId: string,
    spaceId: string,
    request: CanonicalFinalizeStageRequest
  ): Promise<void>;
  rollbackCommit?(
    userId: string,
    spaceId: string,
    request: CanonicalRollbackCommitRequest
  ): Promise<void>;
  readGlobalInstructions?(
    userId: string
  ): Promise<{ content: string; etag: string | null; size: number; mtimeMs: number; exists: boolean }>;
  writeGlobalInstructions?(
    userId: string,
    content: string,
    options?: { expectedEtag?: string | null; requireAbsent?: boolean }
  ): Promise<{ etag: string; size: number; mtimeMs: number }>;
  inspectTransferState?(
    userId: string,
    spaceId: string,
    request: CanonicalInspectTransferStateRequest
  ): Promise<CanonicalInspectTransferStateResult>;
  inspectSnapshotState?(
    userId: string,
    spaceId: string,
    request: CanonicalInspectSnapshotStateRequest
  ): Promise<CanonicalInspectSnapshotStateResult>;
  abortStage?(
    userId: string,
    spaceId: string,
    request: CanonicalAbortStageRequest
  ): Promise<void>;
  importSeed?(
    userId: string,
    sessionId: string,
    events: readonly unknown[],
    receipt?: any,
    profile?: any,
    workspaceFolder?: string
  ): Promise<any>;
}

export interface RuntimeFileApiOptions {
  readonly fileProvider: TenantRuntimeFileProvider;
  readonly platformApi?: PlatformWebApi;
  readonly operations?: any;
  readonly maxFileSize?: number;
  readonly maxListEntries?: number;
}

/**
 * Validates that an ETag is an exact raw quoted lowercase SHA-256 hex string.
 * Strictly rejects weak, unquoted, uppercase, or whitespace-containing ETags.
 * Performs zero normalization or coercion.
 */
export function validateEtag(rawEtag: unknown): string {
  if (typeof rawEtag !== 'string' || !ETAG_LOWERCASE_SHA256_REGEX.test(rawEtag)) {
    throw new ValidationError(
      'Invalid ETag format: must be exact quoted lowercase 64-hex SHA-256 string (e.g. \\"[0-9a-f]{64}\\")'
    );
  }
  return rawEtag;
}

/**
 * Validates spaceId strictly: raw === trim, NFC normalized, non-empty, matching SPACE_ID_REGEX.
 * Returns raw input directly.
 */
export function validateSpaceId(rawSpaceId: unknown): string {
  if (typeof rawSpaceId !== 'string' || rawSpaceId.length === 0) {
    throw new ValidationError('spaceId is required and must be a non-empty string');
  }
  if (rawSpaceId !== rawSpaceId.trim()) {
    throw new ValidationError('spaceId must not contain leading or trailing whitespace');
  }
  if (rawSpaceId.normalize('NFC') !== rawSpaceId) {
    throw new ValidationError('spaceId must be in Unicode NFC normalized form');
  }
  if (!SPACE_ID_REGEX.test(rawSpaceId)) {
    throw new ValidationError(
      'Invalid spaceId format'
    );
  }
  return rawSpaceId;
}

/**
 * Validates userId strictly: raw === trim, NFC normalized, non-empty, max 128 chars, no control chars.
 * Returns raw input directly.
 */
export function validateUserId(rawUserId: unknown): string {
  if (typeof rawUserId !== 'string' || rawUserId.length === 0) {
    throw new ValidationError('userId is required and must be a non-empty string');
  }
  if (rawUserId.length > 128) {
    throw new ValidationError('userId exceeds maximum allowed length of 128 characters');
  }
  if (rawUserId !== rawUserId.trim()) {
    throw new ValidationError('userId must not contain leading or trailing whitespace');
  }
  if (rawUserId.normalize('NFC') !== rawUserId) {
    throw new ValidationError('userId must be in Unicode NFC normalized form');
  }
  for (let i = 0; i < rawUserId.length; i++) {
    const code = rawUserId.charCodeAt(i);
    if (code <= 31 || code === 127) {
      throw new ValidationError('userId contains forbidden control characters');
    }
  }
  if (!USER_ID_REGEX.test(rawUserId)) {
    throw new ValidationError('Invalid userId format');
  }
  return rawUserId;
}

/**
 * Validates that an object contains only allowed keys.
 */
export function validateUnknownKeys(
  raw: unknown,
  allowedKeys: readonly string[]
): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationError('Request payload must be a JSON object');
  }
  const allowedSet = new Set(allowedKeys);
  const keys = Object.keys(raw);
  for (const key of keys) {
    if (!allowedSet.has(key)) {
      throw new ValidationError('Unexpected field in request payload');
    }
  }
}

/**
 * Validates and normalizes user-provided relative POSIX path.
 */
export function validateRelativeFilePath(
  rawPath: unknown,
  options: { allowRoot?: boolean } = {}
): { normalizedPath: string; segments: string[] } {
  if (rawPath === undefined || rawPath === null || rawPath === '') {
    if (options.allowRoot) {
      return { normalizedPath: '.', segments: [] };
    }
    throw new ValidationError('Path is required and cannot be empty');
  }

  if (typeof rawPath !== 'string') {
    throw new ValidationError('Path must be a string');
  }

  // 1. NFC normalization check
  if (rawPath.normalize('NFC') !== rawPath) {
    throw new ValidationError('Path must be in Unicode NFC normalized form');
  }

  // 2. Length limits
  if (rawPath.length > MAX_PATH_LENGTH) {
    throw new ValidationError('Path exceeds maximum allowed length of 1024 characters');
  }

  // 3. Single-pass percent decoding
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    throw new ValidationError('Invalid URL-encoded path: malformed percent sequence');
  }

  // Double encoding check
  if (/%25|%2e|%2f|%5c|%00/i.test(decoded)) {
    throw new ValidationError('Double URL-encoding detected in path');
  }

  // 4. Null bytes & control characters
  for (let i = 0; i < decoded.length; i++) {
    const code = decoded.charCodeAt(i);
    if (code <= 31 || code === 127) {
      throw new ValidationError('Path contains forbidden control characters or null bytes');
    }
  }

  // 5. Windows drive letters
  if (/^[a-zA-Z]:/.test(decoded)) {
    throw new ValidationError('Path must be relative and cannot contain Windows drive letters');
  }

  // 6. Absolute paths (permit virtual mount paths starting with /mnt/)
  let pathStr = decoded;
  if (pathStr.startsWith('/mnt/') || pathStr === '/mnt') {
    pathStr = pathStr.slice(1);
  } else if (pathStr.startsWith('/') || pathStr.startsWith('\\')) {
    throw new ValidationError('Absolute paths are forbidden; path must be relative');
  }

  // 7. Reject backslashes
  if (pathStr.includes('\\')) {
    throw new ValidationError('Backslashes are forbidden in relative paths; use POSIX forward slashes');
  }

  // 8. Segments check
  if (options.allowRoot && (pathStr === '.' || pathStr === '')) {
    return { normalizedPath: '.', segments: [] };
  }

  const rawSegments = pathStr.split('/');
  const segments: string[] = [];

  for (const seg of rawSegments) {
    if (seg === '') {
      throw new ValidationError('Empty path segments are forbidden in path');
    }
    if (seg === '.') {
      throw new ValidationError('Dot path segments are forbidden in path');
    }
    if (seg === '..') {
      throw new ValidationError('Path traversal using ".." is strictly forbidden in path');
    }
    if (seg.length > MAX_SEGMENT_LENGTH) {
      throw new ValidationError('Path segment exceeds maximum length of 255 characters');
    }
    if (/[\0<>:"|?*]/.test(seg)) {
      throw new ValidationError('Path segment contains forbidden special characters');
    }
    segments.push(seg);
  }

  if (segments.length === 0) {
    if (options.allowRoot) {
      return { normalizedPath: '.', segments: [] };
    }
    throw new ValidationError('Path cannot resolve to root directory');
  }

  const normalizedPath = segments.join('/');
  return { normalizedPath, segments };
}

/**
 * Maps downstream file operation errors to PlatformError with fixed error messages.
 * Only maps if error is PlatformError or has an exact allowlisted code.
 * Unknown errors result in a fixed 502 Bad Gateway.
 * Never inspects err.message or String(err).
 */
export function mapFileOpError(err: unknown): PlatformError {
  if (err instanceof PlatformError) {
    return err;
  }

  const code = (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string')
    ? (err as { code: string }).code
    : undefined;

  switch (code) {
    case 'NOT_FOUND':
    case 'ENOENT':
    case 'DIRECTORY_NOT_FOUND':
      return new NotFoundError('File or directory not found');

    case 'SYMLINK_FORBIDDEN':
    case 'EACCES':
    case 'EPERM':
    case 'SECURITY_VIOLATION':
    case 'FORBIDDEN':
      return new ForbiddenError('Access denied');

    case 'INVALID_PATH':
    case 'PATH_TRAVERSAL':
    case 'INVALID_OP':
    case 'INVALID_REQUEST':
    case 'INVALID_TARGET':
    case 'VALIDATION_ERROR':
      return new ValidationError('Invalid request');

    case 'PAYLOAD_TOO_LARGE':
    case 'FILE_TOO_LARGE':
      return new PlatformError('Payload too large', 'PAYLOAD_TOO_LARGE', 413);

    case 'PRECONDITION_FAILED':
    case 'ETAG_MISMATCH':
      return new PlatformError('Precondition failed', 'PRECONDITION_FAILED', 409);

    case 'CONFLICT':
    case 'EEXIST':
    case 'BUSY':
    case 'WRITE_CONFLICT':
    case 'RACE_CONDITION':
    case 'SPACE_ARCHIVED':
      return new PlatformError('Resource conflict', 'CONFLICT', 409);

    case 'QUOTA_EXCEEDED':
      return new PlatformError('Quota exceeded for storage_bytes', 'QUOTA_EXCEEDED', 429);

    case 'SERVICE_UNAVAILABLE':
    case 'RUNTIME_UNAVAILABLE':
    case 'CONTAINER_OFFLINE':
      return new PlatformError('Service unavailable', 'SERVICE_UNAVAILABLE', 503);

    case 'PROVIDER_PROTOCOL_ERROR':
    case 'PROTOCOL_ERROR':
    case 'BAD_GATEWAY':
    default:
      return new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
  }
}

/**
 * Runtime File API Service
 * Exclusively provides the canonical execute(userId, spaceId, request) API.
 */
export class RuntimeFileApiService {
  private readonly fileProvider: TenantRuntimeFileProvider;
  private readonly platformApi?: PlatformWebApi;
  private readonly operations?: any;
  private readonly maxFileSize: number;
  private readonly maxListEntries: number;

  constructor(options: RuntimeFileApiOptions) {
    if (!options || !options.fileProvider || typeof options.fileProvider.execute !== 'function') {
      throw new PlatformError(
        'fileProvider with execute method is required',
        'SERVICE_UNAVAILABLE',
        503
      );
    }
    this.fileProvider = options.fileProvider;
    this.platformApi = options.platformApi;
    this.operations = options.operations;
    this.maxFileSize = options.maxFileSize ?? MAX_FILE_SIZE_BYTES;
    this.maxListEntries = options.maxListEntries ?? MAX_LIST_ENTRIES;
  }

  private async requireActiveSpace(userId: string, spaceId: string): Promise<void> {
    if (!this.platformApi) {
      return;
    }
    const activeSpaceRecord = await this.platformApi.getSpace(userId, spaceId);
    if (!activeSpaceRecord) {
      throw new NotFoundError('Space not found');
    }
    if (activeSpaceRecord.status !== 'active' || (activeSpaceRecord as { archivedAt?: string }).archivedAt) {
      throw new PlatformError('Space is archived', 'SPACE_ARCHIVED', 409);
    }
  }

  private async getExistingFileSize(userId: string, spaceId: string, path: string): Promise<number> {
    try {
      const readRes = await this.fileProvider.execute(userId, spaceId, { op: 'read', path, encoding: 'base64' });
      if (readRes.op === 'read' && typeof readRes.size === 'number' && Number.isSafeInteger(readRes.size) && readRes.size >= 0) {
        return readRes.size;
      }
    } catch {
      // Not found or not a regular file
    }
    return 0;
  }

  /**
   * Sole public entrypoint: Validates and executes a canonical file operation request.
   */
  async execute(
    userId: string,
    spaceId: string,
    request: CanonicalFileOperationRequest
  ): Promise<CanonicalFileOperationResult> {
    const cleanUserId = validateUserId(userId);
    const cleanSpaceId = validateSpaceId(spaceId);

    if (!request || typeof request !== 'object') {
      throw new ValidationError('Request must be a non-null object');
    }

    await this.requireActiveSpace(cleanUserId, cleanSpaceId);

    switch (request.op) {
      case 'list': {
        validateUnknownKeys(request, ['op', 'path']);
        const { normalizedPath } = validateRelativeFilePath(request.path, { allowRoot: true });
        const canonicalReq: CanonicalListRequest = {
          op: 'list',
          path: normalizedPath,
        };

        let result: CanonicalFileOperationResult;
        try {
          result = await this.fileProvider.execute(cleanUserId, cleanSpaceId, canonicalReq);
        } catch (err) {
          throw mapFileOpError(err);
        }

        return this.validateListResult(result, normalizedPath);
      }

      case 'read': {
        validateUnknownKeys(request, ['op', 'path', 'encoding']);
        const { normalizedPath } = validateRelativeFilePath(request.path, { allowRoot: false });
        const encoding: FileEncoding = request.encoding ?? 'utf8';
        if (encoding !== 'utf8' && encoding !== 'base64') {
          throw new ValidationError('Encoding must be either "utf8" or "base64"');
        }
        const canonicalReq: CanonicalReadRequest = {
          op: 'read',
          path: normalizedPath,
          encoding,
        };

        let result: CanonicalFileOperationResult;
        try {
          result = await this.fileProvider.execute(cleanUserId, cleanSpaceId, canonicalReq);
        } catch (err) {
          throw mapFileOpError(err);
        }

        return this.validateReadResult(result, normalizedPath, encoding);
      }

      case 'write': {
        validateUnknownKeys(
          request,
          ['op', 'path', 'content', 'encoding', 'expectedEtag', 'requireAbsent']
        );
        const { normalizedPath } = validateRelativeFilePath(request.path, { allowRoot: false });

        if (typeof request.content !== 'string') {
          throw new ValidationError('content must be a string');
        }

        const encoding: FileEncoding = request.encoding ?? 'utf8';
        if (encoding !== 'utf8' && encoding !== 'base64') {
          throw new ValidationError('Encoding must be either "utf8" or "base64"');
        }

        let byteLength: number;
        if (encoding === 'utf8') {
          byteLength = Buffer.byteLength(request.content, 'utf8');
        } else {
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(request.content)) {
            throw new ValidationError('Invalid base64 content');
          }
          byteLength = Buffer.from(request.content, 'base64').byteLength;
        }

        if (byteLength > this.maxFileSize) {
          throw new PlatformError('Payload too large', 'PAYLOAD_TOO_LARGE', 413);
        }

        // Exactly one precondition
        const hasExpectedEtag = typeof request.expectedEtag === 'string';
        const hasRequireAbsent = request.requireAbsent === true;

        if (hasExpectedEtag && hasRequireAbsent) {
          throw new ValidationError('Write request must specify exactly one precondition: either expectedEtag or requireAbsent: true, not both');
        }
        if (!hasExpectedEtag && !hasRequireAbsent) {
          throw new ValidationError('Write request must specify exactly one precondition: either expectedEtag or requireAbsent: true');
        }

        let canonicalReq: CanonicalWriteRequest;
        if (hasExpectedEtag) {
          const cleanEtag = validateEtag(request.expectedEtag);
          canonicalReq = {
            op: 'write',
            path: normalizedPath,
            content: request.content,
            encoding,
            expectedEtag: cleanEtag,
          };
        } else {
          canonicalReq = {
            op: 'write',
            path: normalizedPath,
            content: request.content,
            encoding,
            requireAbsent: true,
          };
        }

        // 1. Calculate delta and reserve storage_bytes if positive growth
        let oldSize = 0;
        if (this.operations) {
          if (hasExpectedEtag) {
            oldSize = await this.getExistingFileSize(cleanUserId, cleanSpaceId, normalizedPath);
          }
        }

        const upfrontDelta = byteLength - oldSize;
        let reservationId: string | null = null;
        const tenantQuota = this.operations?.forTenant ? this.operations.forTenant(cleanUserId).quota : null;

        if (tenantQuota && upfrontDelta > 0) {
          try {
            const res = await tenantQuota.reserveQuota({
              resource: 'storage_bytes',
              amount: upfrontDelta,
              ttlSeconds: 60,
            });
            reservationId = res.id;
          } catch (resErr: any) {
            if (resErr?.code === 'QUOTA_EXCEEDED' || resErr?.name === 'QuotaExceededError') {
              throw new PlatformError('Quota exceeded for storage_bytes', 'QUOTA_EXCEEDED', 429);
            }
            throw resErr;
          }
        }

        let result: CanonicalFileOperationResult;
        try {
          result = await this.fileProvider.execute(cleanUserId, cleanSpaceId, canonicalReq);
        } catch (err) {
          if (tenantQuota && reservationId) {
            try {
              await tenantQuota.releaseQuota({ reservationId });
            } catch {
              // Ignore release errors on rollback
            }
          }
          throw mapFileOpError(err);
        }

        const validatedResult = this.validateWriteResult(result, normalizedPath, byteLength);

        // 2. Commit actual authoritative result size delta or adjust decrement
        if (tenantQuota) {
          const actualNewSize = validatedResult.size;
          const actualDelta = actualNewSize - oldSize;

          if (reservationId) {
            if (actualDelta > 0) {
              await tenantQuota.commitQuota({
                reservationId,
                actualAmount: actualDelta,
              });
            } else {
              await tenantQuota.releaseQuota({ reservationId });
              if (actualDelta < 0) {
                await tenantQuota.adjustUsage({
                  resource: 'storage_bytes',
                  delta: actualDelta,
                });
              }
            }
          } else {
            if (actualDelta < 0) {
              await tenantQuota.adjustUsage({
                resource: 'storage_bytes',
                delta: actualDelta,
              });
            } else if (actualDelta > 0) {
              try {
                await tenantQuota.consumeQuota({
                  resource: 'storage_bytes',
                  amount: actualDelta,
                });
              } catch {
                // Ignore direct consume failure post-write
              }
            }
          }
        }

        return validatedResult;
      }

      case 'rename': {
        validateUnknownKeys(
          request,
          ['op', 'path', 'targetPath', 'expectedEtag', 'expectedTargetEtag', 'requireTargetAbsent']
        );
        const { normalizedPath } = validateRelativeFilePath(request.path, { allowRoot: false });
        const { normalizedPath: targetNormalized } = validateRelativeFilePath(request.targetPath, { allowRoot: false });

        if (typeof request.expectedEtag !== 'string') {
          throw new ValidationError('Rename request requires source expectedEtag');
        }
        const cleanSourceEtag = validateEtag(request.expectedEtag);

        const hasExpectedTargetEtag = typeof request.expectedTargetEtag === 'string';
        const hasRequireTargetAbsent = request.requireTargetAbsent === true;

        if (hasExpectedTargetEtag && hasRequireTargetAbsent) {
          throw new ValidationError('Rename request must specify exactly one target precondition: either expectedTargetEtag or requireTargetAbsent: true, not both');
        }
        if (!hasExpectedTargetEtag && !hasRequireTargetAbsent) {
          throw new ValidationError('Rename request must specify exactly one target precondition: either expectedTargetEtag or requireTargetAbsent: true');
        }

        let canonicalReq: CanonicalRenameRequest;
        if (hasExpectedTargetEtag) {
          const cleanTargetEtag = validateEtag(request.expectedTargetEtag);
          canonicalReq = {
            op: 'rename',
            path: normalizedPath,
            targetPath: targetNormalized,
            expectedEtag: cleanSourceEtag,
            expectedTargetEtag: cleanTargetEtag,
          };
        } else {
          canonicalReq = {
            op: 'rename',
            path: normalizedPath,
            targetPath: targetNormalized,
            expectedEtag: cleanSourceEtag,
            requireTargetAbsent: true,
          };
        }

        let oldTargetSize = 0;
        const tenantQuota = this.operations?.forTenant ? this.operations.forTenant(cleanUserId).quota : null;
        if (tenantQuota && hasExpectedTargetEtag) {
          oldTargetSize = await this.getExistingFileSize(cleanUserId, cleanSpaceId, targetNormalized);
        }

        let result: CanonicalFileOperationResult;
        try {
          result = await this.fileProvider.execute(cleanUserId, cleanSpaceId, canonicalReq);
        } catch (err) {
          throw mapFileOpError(err);
        }

        const validatedResult = this.validateRenameResult(result, normalizedPath, targetNormalized);

        if (tenantQuota && oldTargetSize > 0) {
          await tenantQuota.adjustUsage({
            resource: 'storage_bytes',
            delta: -oldTargetSize,
          });
        }

        return validatedResult;
      }

      case 'mkdir': {
        validateUnknownKeys(request, ['op', 'path', 'requireAbsent']);
        const { normalizedPath } = validateRelativeFilePath(request.path, { allowRoot: false });

        if (request.requireAbsent !== true) {
          throw new ValidationError('mkdir request requires requireAbsent: true');
        }

        const canonicalReq: CanonicalMkdirRequest = {
          op: 'mkdir',
          path: normalizedPath,
          requireAbsent: true,
        };

        let result: CanonicalFileOperationResult;
        try {
          result = await this.fileProvider.execute(cleanUserId, cleanSpaceId, canonicalReq);
        } catch (err) {
          throw mapFileOpError(err);
        }

        return this.validateMkdirResult(result, normalizedPath);
      }

      case 'delete': {
        validateUnknownKeys(request, ['op', 'path', 'expectedEtag']);
        const { normalizedPath } = validateRelativeFilePath(request.path, { allowRoot: true });

        if (normalizedPath === '.' || normalizedPath === '') {
          throw new ForbiddenError('Deleting root is strictly forbidden');
        }

        if (typeof request.expectedEtag !== 'string') {
          throw new ValidationError('delete request requires expectedEtag');
        }
        const cleanEtag = validateEtag(request.expectedEtag);

        const canonicalReq: CanonicalDeleteRequest = {
          op: 'delete',
          path: normalizedPath,
          expectedEtag: cleanEtag,
        };

        let oldSize = 0;
        const tenantQuota = this.operations?.forTenant ? this.operations.forTenant(cleanUserId).quota : null;
        if (tenantQuota) {
          oldSize = await this.getExistingFileSize(cleanUserId, cleanSpaceId, normalizedPath);
        }

        let result: CanonicalFileOperationResult;
        try {
          result = await this.fileProvider.execute(cleanUserId, cleanSpaceId, canonicalReq);
        } catch (err) {
          throw mapFileOpError(err);
        }

        const validatedResult = this.validateDeleteResult(result, normalizedPath);

        if (tenantQuota) {
          const freedSize = validatedResult.type === 'file' && validatedResult.size > 0 ? validatedResult.size : oldSize;
          if (freedSize > 0) {
            await tenantQuota.adjustUsage({
              resource: 'storage_bytes',
              delta: -freedSize,
            });
          }
        }

        return validatedResult;
      }

      case 'stat': {
        validateUnknownKeys(request, ['op', 'path']);
        const { normalizedPath } = validateRelativeFilePath(request.path, { allowRoot: true });
        const canonicalReq: CanonicalStatRequest = {
          op: 'stat',
          path: normalizedPath,
        };

        let result: CanonicalFileOperationResult;
        try {
          result = await this.fileProvider.execute(cleanUserId, cleanSpaceId, canonicalReq);
        } catch (err) {
          throw mapFileOpError(err);
        }

        return this.validateStatResult(result, normalizedPath);
      }

      case 'sniff': {
        validateUnknownKeys(request, ['op', 'path', 'maxBytes']);
        const { normalizedPath } = validateRelativeFilePath(request.path, { allowRoot: false });
        const maxBytes = typeof request.maxBytes === 'number' && Number.isSafeInteger(request.maxBytes) && request.maxBytes > 0
          ? Math.min(request.maxBytes, 4096)
          : 512;
        const canonicalReq: CanonicalSniffRequest = {
          op: 'sniff',
          path: normalizedPath,
          maxBytes,
        };

        let result: CanonicalFileOperationResult;
        try {
          result = await this.fileProvider.execute(cleanUserId, cleanSpaceId, canonicalReq);
        } catch (err) {
          throw mapFileOpError(err);
        }

        return this.validateSniffResult(result, normalizedPath);
      }

      case 'copy': {
        validateUnknownKeys(request, ['op', 'path', 'targetPath', 'expectedEtag', 'requireAbsent']);
        const { normalizedPath: srcNorm } = validateRelativeFilePath(request.path, { allowRoot: false });
        const { normalizedPath: dstNorm } = validateRelativeFilePath(request.targetPath, { allowRoot: false });

        if (srcNorm === dstNorm) {
          throw new ValidationError('Source and destination paths cannot be identical');
        }

        const expectedEtag = typeof request.expectedEtag === 'string' ? validateEtag(request.expectedEtag) : undefined;
        const requireAbsent = request.requireAbsent === true;

        const canonicalReq: CanonicalCopyRequest = {
          op: 'copy',
          path: srcNorm,
          targetPath: dstNorm,
          ...(expectedEtag ? { expectedEtag } : {}),
          ...(requireAbsent ? { requireAbsent: true } : {}),
        };

        let result: CanonicalFileOperationResult;
        try {
          result = await this.fileProvider.execute(cleanUserId, cleanSpaceId, canonicalReq);
        } catch (err) {
          throw mapFileOpError(err);
        }

        return this.validateCopyResult(result, srcNorm, dstNorm);
      }

      default: {
        throw new ValidationError('Invalid file operation requested');
      }
    }
  }

  // Result validators
  private validateListResult(
    result: CanonicalFileOperationResult,
    expectedPath: string
  ): CanonicalListResult {
    if (!result || typeof result !== 'object') {
      throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
    }
    if (result.op !== 'list' || result.path !== expectedPath) {
      throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
    }
    if (!Array.isArray(result.entries) || typeof result.truncated !== 'boolean') {
      throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
    }

    const sanitizedEntries: FileListEntry[] = [];
    for (const entry of result.entries.slice(0, this.maxListEntries)) {
      if (!entry || typeof entry !== 'object') {
        throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
      }
      if (
        !entry.name ||
        typeof entry.name !== 'string' ||
        entry.name.length > MAX_SEGMENT_LENGTH ||
        entry.name === '.' ||
        entry.name === '..' ||
        entry.name.includes('/') ||
        entry.name.includes('\\') ||
        entry.name.normalize('NFC') !== entry.name ||
        /[\0<>:"|?*]/.test(entry.name)
      ) {
        throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
      }
      if (entry.type !== 'file' && entry.type !== 'directory') {
        throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
      }
      if (
        typeof entry.size !== 'number' ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        typeof entry.mtimeMs !== 'number' ||
        !Number.isFinite(entry.mtimeMs) ||
        entry.mtimeMs < 0 ||
        typeof entry.etag !== 'string' ||
        !ETAG_LOWERCASE_SHA256_REGEX.test(entry.etag)
      ) {
        throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
      }

      sanitizedEntries.push({
        name: entry.name,
        type: entry.type,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        etag: entry.etag,
      });
    }

    return {
      op: 'list',
      path: expectedPath,
      entries: sanitizedEntries,
      truncated: Boolean(result.truncated || result.entries.length > this.maxListEntries),
    };
  }

  private validateReadResult(
    result: CanonicalFileOperationResult,
    expectedPath: string,
    expectedEncoding: FileEncoding
  ): CanonicalReadResult {
    if (!result || typeof result !== 'object') {
      throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
    }
    if (result.op !== 'read' || result.path !== expectedPath || result.type !== 'file') {
      throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
    }
    if (typeof (result as CanonicalReadResult).content !== 'string' || (result as CanonicalReadResult).encoding !== expectedEncoding) {
      throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
    }
    const content = (result as CanonicalReadResult).content;
    const byteLength = expectedEncoding === 'utf8'
      ? Buffer.byteLength(content, 'utf8')
      : Buffer.from(content, 'base64').byteLength;

    if (byteLength > this.maxFileSize) {
      throw new PlatformError('Payload too large', 'PAYLOAD_TOO_LARGE', 413);
    }

    if (
      typeof result.size !== 'number' ||
      !Number.isSafeInteger(result.size) ||
      result.size !== byteLength ||
      typeof result.mtimeMs !== 'number' ||
      !Number.isFinite(result.mtimeMs) ||
      result.mtimeMs < 0 ||
      typeof result.etag !== 'string' ||
      !ETAG_LOWERCASE_SHA256_REGEX.test(result.etag)
    ) {
      throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
    }

    return {
      op: 'read',
      path: expectedPath,
      content,
      encoding: expectedEncoding,
      type: 'file',
      size: byteLength,
      mtimeMs: result.mtimeMs,
      etag: result.etag,
    };
  }

  private validateWriteResult(
    result: CanonicalFileOperationResult,
    expectedPath: string,
    expectedByteLength: number
  ): CanonicalWriteResult {
    if (!result || typeof result !== 'object') {
      throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
    }
    if (result.op !== 'write' || result.path !== expectedPath || result.type !== 'file') {
      throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
    }
    if (
      typeof result.size !== 'number' ||
      !Number.isSafeInteger(result.size) ||
      result.size !== expectedByteLength ||
      typeof result.mtimeMs !== 'number' ||
      !Number.isFinite(result.mtimeMs) ||
      result.mtimeMs < 0 ||
      typeof result.etag !== 'string' ||
      !ETAG_LOWERCASE_SHA256_REGEX.test(result.etag)
    ) {
      throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
    }

    return {
      op: 'write',
      path: expectedPath,
      type: 'file',
      size: result.size,
      mtimeMs: result.mtimeMs,
      etag: result.etag,
    };
  }

  private validateRenameResult(
    result: CanonicalFileOperationResult,
    expectedPath: string,
    expectedTargetPath: string
  ): CanonicalRenameResult {
    if (!result || typeof result !== 'object') {
      throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
    }
    if (
      result.op !== 'rename' ||
      result.path !== expectedPath ||
      (result as CanonicalRenameResult).targetPath !== expectedTargetPath
    ) {
      throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
    }
    if (result.type !== 'file' && result.type !== 'directory') {
      throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
    }
    if (
      typeof result.size !== 'number' ||
      !Number.isSafeInteger(result.size) ||
      result.size < 0 ||
      typeof result.mtimeMs !== 'number' ||
      !Number.isFinite(result.mtimeMs) ||
      result.mtimeMs < 0 ||
      typeof result.etag !== 'string' ||
      !ETAG_LOWERCASE_SHA256_REGEX.test(result.etag)
    ) {
      throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
    }

    return {
      op: 'rename',
      path: expectedPath,
      targetPath: expectedTargetPath,
      type: result.type,
      size: result.size,
      mtimeMs: result.mtimeMs,
      etag: result.etag,
    };
  }

  private validateMkdirResult(
    result: CanonicalFileOperationResult,
    expectedPath: string
  ): CanonicalMkdirResult {
    if (!result || typeof result !== 'object') {
      throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
    }
    if (result.op !== 'mkdir' || result.path !== expectedPath || result.type !== 'directory') {
      throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
    }
    if (
      typeof result.size !== 'number' ||
      !Number.isSafeInteger(result.size) ||
      result.size < 0 ||
      typeof result.mtimeMs !== 'number' ||
      !Number.isFinite(result.mtimeMs) ||
      result.mtimeMs < 0 ||
      typeof result.etag !== 'string' ||
      !ETAG_LOWERCASE_SHA256_REGEX.test(result.etag)
    ) {
      throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
    }

    return {
      op: 'mkdir',
      path: expectedPath,
      type: 'directory',
      size: result.size,
      mtimeMs: result.mtimeMs,
      etag: result.etag,
    };
  }

  /**
   * Streams binary data into a space file with automatic quota reservation and atomic commit.
   */
  async writeBinaryStream(
    userId: string,
    spaceId: string,
    request: {
      path: string;
      expectedEtag?: string;
      requireAbsent?: boolean;
      maxSizeBytes?: number;
      expectedSizeBytes?: number;
    },
    inStream: NodeJS.ReadableStream
  ): Promise<CanonicalWriteResult> {
    const cleanUserId = validateUserId(userId);
    const cleanSpaceId = validateSpaceId(spaceId);

    if (!request || typeof request !== 'object') {
      throw new ValidationError('Request must be a non-null object');
    }

    await this.requireActiveSpace(cleanUserId, cleanSpaceId);

    const { normalizedPath } = validateRelativeFilePath(request.path, { allowRoot: false });

    const hasExpectedEtag = typeof request.expectedEtag === 'string';
    const hasRequireAbsent = request.requireAbsent === true;

    if (hasExpectedEtag && hasRequireAbsent) {
      throw new ValidationError('Write request must specify exactly one precondition: either expectedEtag or requireAbsent: true, not both');
    }
    if (!hasExpectedEtag && !hasRequireAbsent) {
      throw new ValidationError('Write request must specify exactly one precondition: either expectedEtag or requireAbsent: true');
    }

    let cleanEtag: string | undefined;
    if (hasExpectedEtag) {
      cleanEtag = validateEtag(request.expectedEtag);
    }

    let maxBytes = request.maxSizeBytes ?? (50 * 1024 * 1024); // 50 MiB

    // Storage quota management
    let oldSize = 0;
    const tenantQuota = this.operations?.forTenant ? this.operations.forTenant(cleanUserId).quota : null;
    if (tenantQuota && hasExpectedEtag) {
      oldSize = await this.getExistingFileSize(cleanUserId, cleanSpaceId, normalizedPath);
    }

    let reservationId: string | null = null;
    if (tenantQuota) {
      const summary = await tenantQuota.getUsage('storage_bytes');
      if (summary && summary.limit !== null) {
        const remaining = summary.remaining ?? 0;
        if (remaining <= 0 && (!hasExpectedEtag || oldSize <= 0)) {
          throw new PlatformError('Quota exceeded for storage_bytes', 'QUOTA_EXCEEDED', 429);
        }

        const effectiveAvailable = remaining + oldSize;
        if (effectiveAvailable <= 0) {
          throw new PlatformError('Quota exceeded for storage_bytes', 'QUOTA_EXCEEDED', 429);
        }

        // Cap stream maxBytes to remaining storage allowance
        if (maxBytes > effectiveAvailable) {
          maxBytes = effectiveAvailable;
        }

        const reserveAmount = request.expectedSizeBytes !== undefined
          ? Math.max(0, request.expectedSizeBytes - oldSize)
          : (request.requireAbsent || hasExpectedEtag ? Math.min(remaining, 1024) : 0);

        if (reserveAmount > 0) {
          try {
            const res = await tenantQuota.reserveQuota({
              resource: 'storage_bytes',
              amount: reserveAmount,
              ttlSeconds: 120,
            });
            reservationId = res.id;
          } catch (resErr: any) {
            if (resErr?.code === 'QUOTA_EXCEEDED' || resErr?.name === 'QuotaExceededError') {
              throw new PlatformError('Quota exceeded for storage_bytes', 'QUOTA_EXCEEDED', 429);
            }
            throw resErr;
          }
        }
      }
    }

    let writeResult: CanonicalWriteResult;
    try {
      if (typeof this.fileProvider.writeBinaryStream === 'function') {
        writeResult = await this.fileProvider.writeBinaryStream(
          cleanUserId,
          cleanSpaceId,
          {
            op: 'write',
            path: normalizedPath,
            expectedEtag: cleanEtag,
            requireAbsent: hasRequireAbsent ? true : undefined,
            maxSizeBytes: maxBytes,
          },
          inStream
        );
      } else {
        // Fallback: buffer stream up to maxBytes and execute canonical write
        const chunks: Buffer[] = [];
        let totalLen = 0;
        await new Promise<void>((resolve, reject) => {
          inStream.on('data', (chunk) => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            totalLen += buf.length;
            if (totalLen > maxBytes) {
              const err = new PlatformError('Payload too large', 'PAYLOAD_TOO_LARGE', 413);
              if (typeof (inStream as any).destroy === 'function') {
                (inStream as any).destroy(err);
              }
              reject(err);
              return;
            }
            chunks.push(buf);
          });
          inStream.on('error', reject);
          inStream.on('end', resolve);
        });

        const fullBuffer = Buffer.concat(chunks);
        const base64Content = fullBuffer.toString('base64');
        const execRes = await this.fileProvider.execute(cleanUserId, cleanSpaceId, {
          op: 'write',
          path: normalizedPath,
          content: base64Content,
          encoding: 'base64',
          ...(hasExpectedEtag ? { expectedEtag: cleanEtag! } : { requireAbsent: true }),
        } as any);

        if (execRes.op !== 'write' || execRes.type !== 'file') {
          throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
        }
        writeResult = execRes as CanonicalWriteResult;
      }
    } catch (err: unknown) {
      if (tenantQuota && reservationId) {
        try {
          await tenantQuota.releaseQuota({ reservationId });
        } catch {
          // Ignore rollback error
        }
      }
      throw mapFileOpError(err);
    }

    const validatedResult = this.validateWriteResult(writeResult, normalizedPath, writeResult.size);

    // Commit actual delta to quota
    if (tenantQuota) {
      const actualNewSize = validatedResult.size;
      const actualDelta = actualNewSize - oldSize;

      if (reservationId) {
        if (actualDelta > 0) {
          await tenantQuota.commitQuota({
            reservationId,
            actualAmount: actualDelta,
          });
        } else {
          await tenantQuota.releaseQuota({ reservationId });
          if (actualDelta < 0) {
            await tenantQuota.adjustUsage({
              resource: 'storage_bytes',
              delta: actualDelta,
            });
          }
        }
      } else {
        if (actualDelta < 0) {
          await tenantQuota.adjustUsage({
            resource: 'storage_bytes',
            delta: actualDelta,
          });
        } else if (actualDelta > 0) {
          try {
            await tenantQuota.consumeQuota({
              resource: 'storage_bytes',
              amount: actualDelta,
            });
          } catch {
            // Ignore
          }
        }
      }
    }

    return validatedResult;
  }

  /**
   * Phase 1: Streams incoming file to an isolated staging temporary file in the workspace.
   * Computes content SHA-256 and ETag without committing to final destination.
   */
  async stageBinaryStream(
    userId: string,
    spaceId: string,
    request: {
      path: string;
      maxSizeBytes?: number;
    },
    inStream: NodeJS.ReadableStream
  ): Promise<CanonicalStageResult> {
    const cleanUserId = validateUserId(userId);
    const cleanSpaceId = validateSpaceId(spaceId);

    if (!request || typeof request !== 'object') {
      throw new ValidationError('Request must be a non-null object');
    }

    await this.requireActiveSpace(cleanUserId, cleanSpaceId);

    const { normalizedPath } = validateRelativeFilePath(request.path, { allowRoot: false });
    const maxBytes = request.maxSizeBytes ?? (50 * 1024 * 1024);

    try {
      if (typeof this.fileProvider.stageBinaryStream === 'function') {
        const stageRes = await this.fileProvider.stageBinaryStream(
          cleanUserId,
          cleanSpaceId,
          {
            op: 'stage',
            path: normalizedPath,
            maxSizeBytes: maxBytes,
          },
          inStream
        );
        return stageRes;
      } else {
        // Fallback in-memory buffer
        const chunks: Buffer[] = [];
        let totalLen = 0;
        const hasher = (await import('node:crypto')).createHash('sha256');

        await new Promise<void>((resolve, reject) => {
          inStream.on('data', (chunk) => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            totalLen += buf.length;
            if (totalLen > maxBytes) {
              const err = new PlatformError('Payload too large', 'PAYLOAD_TOO_LARGE', 413);
              if (typeof (inStream as any).destroy === 'function') {
                (inStream as any).destroy(err);
              }
              reject(err);
              return;
            }
            hasher.update(buf);
            chunks.push(buf);
          });
          inStream.on('error', reject);
          inStream.on('end', resolve);
        });

        const fullBuffer = Buffer.concat(chunks);
        const sha256Hex = hasher.digest('hex').toLowerCase();
        const fakeToken = `.${normalizedPath.split('/').pop() || 'file'}.${(await import('node:crypto')).randomBytes(8).toString('hex')}.stage.tmp`;

        // Store in fallback staging map on provider if present, or return
        (this as any)._fallbackStageMap = (this as any)._fallbackStageMap || new Map();
        (this as any)._fallbackStageMap.set(`${cleanSpaceId}:${fakeToken}`, fullBuffer);

        return {
          op: 'stage',
          path: normalizedPath,
          stageToken: fakeToken,
          size: fullBuffer.length,
          sha256: sha256Hex,
          etag: `"${sha256Hex}"`,
        };
      }
    } catch (err: unknown) {
      throw mapFileOpError(err);
    }
  }

  /**
   * Phase 2: Commits a staged file to destination with quota settlement.
   */
  async commitStage(
    userId: string,
    spaceId: string,
    request: {
      path: string;
      stageToken: string;
      rollbackToken?: string;
      expectedEtag?: string;
      requireAbsent?: boolean;
    }
  ): Promise<CanonicalWriteResult & { rollbackToken?: string }> {
    const cleanUserId = validateUserId(userId);
    const cleanSpaceId = validateSpaceId(spaceId);

    if (!request || typeof request !== 'object') {
      throw new ValidationError('Request must be a non-null object');
    }

    await this.requireActiveSpace(cleanUserId, cleanSpaceId);

    const { normalizedPath } = validateRelativeFilePath(request.path, { allowRoot: false });

    const hasExpectedEtag = typeof request.expectedEtag === 'string';
    const hasRequireAbsent = request.requireAbsent === true;

    if (hasExpectedEtag && hasRequireAbsent) {
      throw new ValidationError('Write request must specify exactly one precondition: either expectedEtag or requireAbsent: true, not both');
    }
    if (!hasExpectedEtag && !hasRequireAbsent) {
      throw new ValidationError('Write request must specify exactly one precondition: either expectedEtag or requireAbsent: true');
    }

    let cleanEtag: string | undefined;
    if (hasExpectedEtag) {
      cleanEtag = validateEtag(request.expectedEtag);
    }

    // Storage quota management
    let oldSize = 0;
    const tenantQuota = this.operations?.forTenant ? this.operations.forTenant(cleanUserId).quota : null;
    if (tenantQuota && hasExpectedEtag) {
      oldSize = await this.getExistingFileSize(cleanUserId, cleanSpaceId, normalizedPath);
    }

    let writeResult: CanonicalWriteResult & { rollbackToken?: string };
    try {
      if (typeof this.fileProvider.commitStage === 'function') {
        writeResult = await this.fileProvider.commitStage(
          cleanUserId,
          cleanSpaceId,
          {
            op: 'commit_stage',
            path: normalizedPath,
            stageToken: request.stageToken,
            rollbackToken: request.rollbackToken,
            expectedEtag: cleanEtag,
            requireAbsent: hasRequireAbsent ? true : undefined,
          }
        );
      } else {
        const fullBuffer = (this as any)._fallbackStageMap?.get(`${cleanSpaceId}:${request.stageToken}`);
        if (!fullBuffer) {
          throw new PlatformError('Staged file token not found or expired', 'INVALID_REQUEST', 400);
        }
        (this as any)._fallbackStageMap.delete(`${cleanSpaceId}:${request.stageToken}`);

        const base64Content = fullBuffer.toString('base64');
        const execRes = await this.fileProvider.execute(cleanUserId, cleanSpaceId, {
          op: 'write',
          path: normalizedPath,
          content: base64Content,
          encoding: 'base64',
          ...(hasExpectedEtag ? { expectedEtag: cleanEtag! } : { requireAbsent: true }),
        } as any);

        if (execRes.op !== 'write' || execRes.type !== 'file') {
          throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
        }
        writeResult = execRes as CanonicalWriteResult;
      }
    } catch (err: unknown) {
      throw mapFileOpError(err);
    }

    const validatedResult = this.validateWriteResult(writeResult, normalizedPath, writeResult.size);

    // Commit actual delta to quota
    if (tenantQuota) {
      const actualNewSize = validatedResult.size;
      const actualDelta = actualNewSize - oldSize;

      if (actualDelta > 0) {
        const summary = await tenantQuota.getUsage('storage_bytes');
        if (summary && summary.limit !== null && summary.remaining !== null && summary.remaining < actualDelta) {
          try {
            if (writeResult.rollbackToken) {
              await this.rollbackCommit(cleanUserId, cleanSpaceId, {
                path: normalizedPath,
                rollbackToken: writeResult.rollbackToken,
              });
            } else {
              await this.fileProvider.execute(cleanUserId, cleanSpaceId, {
                op: 'delete',
                path: normalizedPath,
                expectedEtag: validatedResult.etag,
              });
            }
          } catch {
            // Ignore rollback deletion error
          }
          throw new PlatformError('Quota exceeded for storage_bytes', 'QUOTA_EXCEEDED', 429);
        }

        try {
          await tenantQuota.adjustUsage({
            resource: 'storage_bytes',
            delta: actualDelta,
          });
        } catch (adjErr: unknown) {
          try {
            if (writeResult.rollbackToken) {
              await this.rollbackCommit(cleanUserId, cleanSpaceId, {
                path: normalizedPath,
                rollbackToken: writeResult.rollbackToken,
              });
            } else {
              await this.fileProvider.execute(cleanUserId, cleanSpaceId, {
                op: 'delete',
                path: normalizedPath,
                expectedEtag: validatedResult.etag,
              });
            }
          } catch {
            // Ignore
          }
          throw mapFileOpError(adjErr);
        }
      } else if (actualDelta < 0) {
        await tenantQuota.adjustUsage({
          resource: 'storage_bytes',
          delta: actualDelta,
        });
      }
    }

    return {
      ...validatedResult,
      rollbackToken: writeResult.rollbackToken,
    };
  }

  /**
   * Finalizes stage commit by safely deleting the backup file after DB transaction commit.
   */
  async finalizeStage(
    userId: string,
    spaceId: string,
    request: {
      path: string;
      rollbackToken?: string;
    }
  ): Promise<void> {
    if (!request || !request.rollbackToken) return;
    const cleanUserId = validateUserId(userId);
    const cleanSpaceId = validateSpaceId(spaceId);
    try {
      if (typeof this.fileProvider.finalizeStage === 'function') {
        await this.fileProvider.finalizeStage(cleanUserId, cleanSpaceId, {
          op: 'finalize_stage',
          path: request.path,
          rollbackToken: request.rollbackToken,
        });
      }
    } catch {
      // Best-effort cleanup
    }
  }

  /**
   * Inspects transfer state (target, stageToken, rollbackToken) on the provider without buffering file in memory.
   */
  async inspectTransferState(
    userId: string,
    spaceId: string,
    request: {
      path: string;
      stageToken?: string;
      rollbackToken?: string;
      expectedContentSha256?: string;
      contentSha256?: string;
      overwrite?: boolean;
    }
  ): Promise<CanonicalInspectTransferStateResult> {
    const cleanUserId = validateUserId(userId);
    const cleanSpaceId = validateSpaceId(spaceId);

    if (!request || typeof request !== 'object') {
      throw new ValidationError('Request must be a non-null object');
    }

    await this.requireActiveSpace(cleanUserId, cleanSpaceId);

    const { normalizedPath } = validateRelativeFilePath(request.path, { allowRoot: false });
    const expectedContentSha256 = (request.expectedContentSha256 || request.contentSha256 || '').toLowerCase();

    try {
      if (typeof this.fileProvider.inspectTransferState === 'function') {
        const res = await this.fileProvider.inspectTransferState(cleanUserId, cleanSpaceId, {
          op: 'inspect_transfer_state',
          path: normalizedPath,
          stageToken: request.stageToken,
          rollbackToken: request.rollbackToken,
          expectedContentSha256,
          overwrite: request.overwrite,
        });

        const stageExists = res.staged_present ?? res.stageExists ?? false;
        const targetMatches = res.target_matches ?? res.targetMatchesContent ?? false;
        const rollbackExists = res.rollback_present ?? res.rollbackExists ?? false;
        const targetExists = res.targetExists ?? (res.targetSize !== null && res.targetSize !== undefined);
        const etag = res.targetEtag ?? res.etag ?? null;
        const mtimeMs = res.targetMtimeMs ?? res.mtimeMs ?? null;
        const size = res.targetSize ?? res.size ?? null;

        return {
          op: 'inspect_transfer_state',
          path: normalizedPath,
          staged_present: stageExists,
          target_matches: targetMatches,
          rollback_present: rollbackExists,
          stageExists,
          rollbackExists,
          targetExists,
          targetEtag: etag,
          etag,
          targetMtimeMs: mtimeMs,
          mtimeMs,
          targetSize: size,
          size,
          targetMatchesContent: targetMatches,
          consistentWithCommitted: res.consistentWithCommitted ?? (targetExists && targetMatches && !stageExists),
          consistentWithStagedPreCommit: res.consistentWithStagedPreCommit ?? (stageExists && !targetMatches),
        };
      } else {
        // Fallback check
        let targetExists = false;
        let targetEtag: string | null = null;
        let targetMtimeMs: number | null = null;
        let targetSize: number | null = null;
        let targetMatchesContent = false;

        try {
          const readRes = await this.fileProvider.execute(cleanUserId, cleanSpaceId, {
            op: 'read',
            path: normalizedPath,
            encoding: 'base64',
          });
          if (readRes.op === 'read') {
            targetExists = true;
            targetEtag = readRes.etag;
            targetMtimeMs = readRes.mtimeMs;
            targetSize = readRes.size;
            const expectedEtag = `"${expectedContentSha256}"`;
            targetMatchesContent = readRes.etag.toLowerCase() === expectedEtag.toLowerCase();
          }
        } catch {
          targetExists = false;
        }

        const stageExists = Boolean((this as any)._fallbackStageMap?.has(`${cleanSpaceId}:${request.stageToken}`));

        return {
          op: 'inspect_transfer_state',
          path: normalizedPath,
          staged_present: stageExists,
          target_matches: targetMatchesContent,
          rollback_present: false,
          stageExists,
          rollbackExists: false,
          targetExists,
          targetEtag,
          etag: targetEtag,
          targetMtimeMs,
          mtimeMs: targetMtimeMs,
          targetSize,
          size: targetSize,
          targetMatchesContent,
          consistentWithCommitted: targetExists && targetMatchesContent && !stageExists,
          consistentWithStagedPreCommit: stageExists && !targetMatchesContent,
        };
      }
    } catch (err: unknown) {
      throw mapFileOpError(err);
    }
  }

  /**
   * Inspects snapshot and source state on the provider without buffering file in memory.
   */
  async inspectSnapshotState(
    userId: string,
    spaceId: string,
    request: {
      sourcePath?: string;
      snapshotPath: string;
      expectedContentSha256?: string;
    }
  ): Promise<CanonicalInspectSnapshotStateResult> {
    const cleanUserId = validateUserId(userId);
    const cleanSpaceId = validateSpaceId(spaceId);

    if (!request || typeof request !== 'object') {
      throw new ValidationError('Request must be a non-null object');
    }

    await this.requireActiveSpace(cleanUserId, cleanSpaceId);

    const { normalizedPath: normSnapshotPath } = validateRelativeFilePath(request.snapshotPath, { allowRoot: false });
    const normSourcePath = request.sourcePath ? validateRelativeFilePath(request.sourcePath, { allowRoot: false }).normalizedPath : undefined;
    const expectedContentSha256 = (request.expectedContentSha256 || '').trim().toLowerCase();

    try {
      if (typeof this.fileProvider.inspectSnapshotState === 'function') {
        const res = await this.fileProvider.inspectSnapshotState(cleanUserId, cleanSpaceId, {
          op: 'inspect_snapshot_state',
          sourcePath: normSourcePath,
          snapshotPath: normSnapshotPath,
          expectedContentSha256,
        });

        const snapExists = res.snapshotExists;
        const snapEtag = res.snapshotEtag ?? null;
        const snapSize = res.snapshotSize ?? null;
        const snapHash = res.snapshotHash ?? (snapEtag ? snapEtag.replace(/^"|"$/g, '').toLowerCase() : null);
        const snapMatches = res.snapshotMatchesExpected ?? (expectedContentSha256.length > 0 && snapHash === expectedContentSha256);

        return {
          op: 'inspect_snapshot_state',
          sourcePath: normSourcePath,
          snapshotPath: normSnapshotPath,
          sourceExists: res.sourceExists ?? false,
          sourceEtag: res.sourceEtag ?? null,
          sourceSize: res.sourceSize ?? null,
          sourceMatchesExpected: res.sourceMatchesExpected ?? false,
          snapshotExists: snapExists,
          snapshotEtag: snapEtag,
          snapshotSize: snapSize,
          snapshotHash: snapHash,
          snapshotMatchesExpected: snapMatches,
        };
      }

      // Fallback inspect using stat (zero full memory buffer, only metadata / etag)
      let snapshotExists = false;
      let snapshotEtag: string | null = null;
      let snapshotSize: number | null = null;
      let snapshotHash: string | null = null;
      let snapshotMatchesExpected = false;

      try {
        const snapStat = await this.fileProvider.execute(cleanUserId, cleanSpaceId, {
          op: 'stat',
          path: normSnapshotPath,
        });
        if (snapStat && snapStat.op === 'stat') {
          snapshotExists = true;
          snapshotEtag = snapStat.etag;
          snapshotSize = snapStat.size;
          snapshotHash = snapStat.etag ? snapStat.etag.replace(/^"|"$/g, '').toLowerCase() : null;
          if (expectedContentSha256.length > 0 && snapshotHash) {
            snapshotMatchesExpected = snapshotHash === expectedContentSha256;
          }
        }
      } catch (err: unknown) {
        if (err instanceof NotFoundError || (err as { code?: string })?.code === 'NOT_FOUND' || (err as { code?: string })?.code === 'FS_NOT_FOUND') {
          snapshotExists = false;
        } else {
          throw mapFileOpError(err);
        }
      }

      let sourceExists = false;
      let sourceEtag: string | null = null;
      let sourceSize: number | null = null;
      let sourceMatchesExpected = false;

      if (normSourcePath) {
        try {
          const srcStat = await this.fileProvider.execute(cleanUserId, cleanSpaceId, {
            op: 'stat',
            path: normSourcePath,
          });
          if (srcStat && srcStat.op === 'stat') {
            sourceExists = true;
            sourceEtag = srcStat.etag;
            sourceSize = srcStat.size;
            const srcHash = srcStat.etag ? srcStat.etag.replace(/^"|"$/g, '').toLowerCase() : null;
            if (expectedContentSha256.length > 0 && srcHash) {
              sourceMatchesExpected = srcHash === expectedContentSha256;
            }
          }
        } catch (err: unknown) {
          if (err instanceof NotFoundError || (err as { code?: string })?.code === 'NOT_FOUND' || (err as { code?: string })?.code === 'FS_NOT_FOUND') {
            sourceExists = false;
          } else {
            throw mapFileOpError(err);
          }
        }
      }

      return {
        op: 'inspect_snapshot_state',
        sourcePath: normSourcePath,
        snapshotPath: normSnapshotPath,
        sourceExists,
        sourceEtag,
        sourceSize,
        sourceMatchesExpected,
        snapshotExists,
        snapshotEtag,
        snapshotSize,
        snapshotHash,
        snapshotMatchesExpected,
      };
    } catch (err: unknown) {
      throw mapFileOpError(err);
    }
  }

  /**
   * Rolls back a physical commit: restores backup if overwritten, or deletes target if new.
   */
  async rollbackCommit(
    userId: string,
    spaceId: string,
    request: {
      path: string;
      rollbackToken?: string;
      stageToken?: string;
      expectedEtag?: string;
    }
  ): Promise<void> {
    const cleanUserId = validateUserId(userId);
    const cleanSpaceId = validateSpaceId(spaceId);
    try {
      if (typeof this.fileProvider.rollbackCommit === 'function') {
        await this.fileProvider.rollbackCommit(cleanUserId, cleanSpaceId, {
          op: 'rollback_commit',
          path: request.path,
          rollbackToken: request.rollbackToken,
          stageToken: request.stageToken,
          expectedEtag: request.expectedEtag,
        });
      } else {
        if (request.rollbackToken) {
          // Fallback: delete target
          await this.fileProvider.execute(cleanUserId, cleanSpaceId, {
            op: 'delete',
            path: request.path,
            expectedEtag: request.expectedEtag || `"${'0'.repeat(64)}"`,
          }).catch(() => {});
        } else {
          await this.fileProvider.execute(cleanUserId, cleanSpaceId, {
            op: 'delete',
            path: request.path,
            expectedEtag: request.expectedEtag || `"${'0'.repeat(64)}"`,
          }).catch(() => {});
        }
      }
    } catch {
      // Best-effort rollback
    }
  }

  /**
   * Aborts and cleans up a staged temporary file.
   */
  async abortStage(
    userId: string,
    spaceId: string,
    request: {
      path: string;
      stageToken: string;
    }
  ): Promise<void> {
    const cleanUserId = validateUserId(userId);
    const cleanSpaceId = validateSpaceId(spaceId);

    if (!request || typeof request !== 'object') {
      return;
    }

    try {
      if (typeof this.fileProvider.abortStage === 'function') {
        await this.fileProvider.abortStage(cleanUserId, cleanSpaceId, {
          op: 'abort_stage',
          path: request.path,
          stageToken: request.stageToken,
        });
      } else {
        (this as any)._fallbackStageMap?.delete(`${cleanSpaceId}:${request.stageToken}`);
      }
    } catch {
      // Best-effort cleanup
    }
  }

  /**
   * Reads a space file as a binary stream with ETag and Range support.
   */
  async readBinaryStream(
    userId: string,
    spaceId: string,
    request: {
      path: string;
      range?: { start: number; end: number };
    }
  ): Promise<CanonicalStreamingReadResult> {
    const cleanUserId = validateUserId(userId);
    const cleanSpaceId = validateSpaceId(spaceId);

    if (!request || typeof request !== 'object') {
      throw new ValidationError('Request must be a non-null object');
    }

    await this.requireActiveSpace(cleanUserId, cleanSpaceId);

    const { normalizedPath } = validateRelativeFilePath(request.path, { allowRoot: false });

    try {
      if (typeof this.fileProvider.readBinaryStream === 'function') {
        const res = await this.fileProvider.readBinaryStream(cleanUserId, cleanSpaceId, {
          op: 'read',
          path: normalizedPath,
          range: request.range,
        });
        return res;
      } else {
        // Fallback: read via execute base64
        const execRes = await this.fileProvider.execute(cleanUserId, cleanSpaceId, {
          op: 'read',
          path: normalizedPath,
          encoding: 'base64',
        });

        if (execRes.op !== 'read' || execRes.type !== 'file') {
          throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
        }

        const buf = Buffer.from(execRes.content, 'base64');
        let streamBuf = buf;
        if (request.range) {
          streamBuf = buf.subarray(request.range.start, request.range.end + 1);
        }

        const { Readable } = await import('node:stream');
        const readableStream = Readable.from([streamBuf]);

        return {
          op: 'read',
          path: normalizedPath,
          type: 'file',
          size: streamBuf.length,
          totalSize: buf.length,
          mtimeMs: execRes.mtimeMs,
          etag: execRes.etag,
          range: request.range,
          stream: readableStream,
        };
      }
    } catch (err: unknown) {
      throw mapFileOpError(err);
    }
  }

  private validateDeleteResult(
    result: CanonicalFileOperationResult,
    expectedPath: string
  ): CanonicalDeleteResult {
    if (!result || typeof result !== 'object') {
      throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
    }
    if (result.op !== 'delete' || result.path !== expectedPath) {
      throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
    }
    if (result.type !== 'file' && result.type !== 'directory') {
      throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
    }
    if (
      typeof result.size !== 'number' ||
      !Number.isSafeInteger(result.size) ||
      result.size < 0 ||
      typeof result.mtimeMs !== 'number' ||
      !Number.isFinite(result.mtimeMs) ||
      result.mtimeMs < 0 ||
      typeof result.etag !== 'string' ||
      !ETAG_LOWERCASE_SHA256_REGEX.test(result.etag)
    ) {
      throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
    }

    return {
      op: 'delete',
      path: expectedPath,
      type: result.type,
      size: result.size,
      mtimeMs: result.mtimeMs,
      etag: result.etag,
    };
  }

  private validateStatResult(
    result: CanonicalFileOperationResult,
    expectedPath: string
  ): CanonicalStatResult {
    if (!result || typeof result !== 'object') {
      throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
    }
    if (result.op !== 'stat' || result.path !== expectedPath) {
      throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
    }
    if (result.type !== 'file' && result.type !== 'directory') {
      throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
    }
    if (
      typeof result.size !== 'number' ||
      !Number.isSafeInteger(result.size) ||
      result.size < 0 ||
      typeof result.mtimeMs !== 'number' ||
      !Number.isFinite(result.mtimeMs) ||
      result.mtimeMs < 0 ||
      typeof result.etag !== 'string' ||
      !ETAG_LOWERCASE_SHA256_REGEX.test(result.etag)
    ) {
      throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
    }

    return {
      op: 'stat',
      path: expectedPath,
      type: result.type,
      size: result.size,
      mtimeMs: result.mtimeMs,
      etag: result.etag,
    };
  }

  private validateSniffResult(
    result: CanonicalFileOperationResult,
    expectedPath: string
  ): CanonicalSniffResult {
    if (!result || typeof result !== 'object') {
      throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
    }
    if (result.op !== 'sniff' || result.path !== expectedPath || result.type !== 'file') {
      throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
    }
    if (
      typeof result.size !== 'number' ||
      !Number.isSafeInteger(result.size) ||
      result.size < 0 ||
      typeof result.mtimeMs !== 'number' ||
      !Number.isFinite(result.mtimeMs) ||
      result.mtimeMs < 0 ||
      typeof result.etag !== 'string' ||
      !ETAG_LOWERCASE_SHA256_REGEX.test(result.etag) ||
      typeof result.headerBytesBase64 !== 'string'
    ) {
      throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
    }

    return {
      op: 'sniff',
      path: expectedPath,
      type: 'file',
      size: result.size,
      mtimeMs: result.mtimeMs,
      etag: result.etag,
      headerBytesBase64: result.headerBytesBase64,
    };
  }

  private validateCopyResult(
    result: CanonicalFileOperationResult,
    expectedPath: string,
    expectedTargetPath: string
  ): CanonicalCopyResult {
    if (!result || typeof result !== 'object') {
      throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
    }
    if (result.op !== 'copy' || result.path !== expectedPath || result.targetPath !== expectedTargetPath || result.type !== 'file') {
      throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
    }
    if (
      typeof result.size !== 'number' ||
      !Number.isSafeInteger(result.size) ||
      result.size < 0 ||
      typeof result.mtimeMs !== 'number' ||
      !Number.isFinite(result.mtimeMs) ||
      result.mtimeMs < 0 ||
      typeof result.etag !== 'string' ||
      !ETAG_LOWERCASE_SHA256_REGEX.test(result.etag)
    ) {
      throw new PlatformError('Bad gateway: invalid provider response', 'PROVIDER_PROTOCOL_ERROR', 502);
    }

    return {
      op: 'copy',
      path: expectedPath,
      targetPath: expectedTargetPath,
      type: 'file',
      size: result.size,
      mtimeMs: result.mtimeMs,
      etag: result.etag,
    };
  }
}
