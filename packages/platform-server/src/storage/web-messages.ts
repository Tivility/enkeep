import { randomBytes, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { PlatformError, ValidationError } from '@enkeep/platform-core';
import type { CanonicalAttachment, PublicMessageAttachment } from '@enkeep/protocol';

export interface WebMessageReplyReference {
  messageId: string;
  role?: string;
  snippet: string;
}

/**
 * Public safe web message record.
 * Contains only safe public properties: id, role, content, status, createdAt, optional attachments, optional replyReference.
 * Strictly NO metadata.
 */
export interface WebMessageRecord {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  status: 'pending' | 'delivered' | 'failed';
  createdAt: string;
  attachments?: readonly PublicMessageAttachment[];
  replyReference?: WebMessageReplyReference;
}

/**
 * Internal message record with routing and turn metadata for gateway operations.
 * NOT exported from the package root index.
 * Strictly NO metadata.
 */
export interface InternalStoredMessage {
  id: string;
  sessionId: string;
  userId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  status: 'pending' | 'delivered' | 'failed';
  routeKey: string;
  turnId: string | null;
  createdAt: string;
  attachments?: readonly PublicMessageAttachment[];
  replyReference?: WebMessageReplyReference;
}

/**
 * Safe message event payload. Contains only public safe message.
 */
export interface WebMessageEventPayload {
  message: WebMessageRecord;
}

/**
 * Safe assistant streaming delta event payload.
 * Public payload contains ONLY streamId, delta, accumulatedLength.
 */
export interface WebAssistantDeltaEventPayload {
  streamId: string;
  delta: string;
  accumulatedLength: number;
}

/**
 * Safe assistant stream end event payload.
 */
export interface WebAssistantStreamEndEventPayload {
  streamId: string;
}

/**
 * Safe thinking event payload.
 * Public payload contains ONLY status: 'thinking' without raw reasoning text.
 */
export interface WebThinkingEventPayload {
  streamId?: string;
  status: 'thinking';
}

/**
 * Safe tool status event payload.
 * Public payload contains ONLY safe toolName allowlist + status (no args, no result).
 */
export interface WebToolStatusEventPayload {
  toolName: string;
  status: 'started' | 'completed' | 'failed';
}

/**
 * Safe turn status event payload.
 */
export interface WebStatusEventPayload {
  status?: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';
  code?: string;
  [key: string]: unknown;
}

/**
 * Safe error event payload.
 */
export interface WebErrorEventPayload {
  code: string;
  [key: string]: unknown;
}

export interface WebMessageEventRecord {
  id: string;
  type: 'message';
  payload: WebMessageEventPayload;
  createdAt: string;
}

export interface WebAssistantDeltaEventRecord {
  id: string;
  type: 'assistant_delta';
  payload: WebAssistantDeltaEventPayload;
  createdAt: string;
}

export interface WebAssistantStreamEndEventRecord {
  id: string;
  type: 'assistant_stream_end';
  payload: WebAssistantStreamEndEventPayload;
  createdAt: string;
}

export interface WebThinkingEventRecord {
  id: string;
  type: 'thinking';
  payload: WebThinkingEventPayload;
  createdAt: string;
}

export interface WebToolStatusEventRecord {
  id: string;
  type: 'tool_status';
  payload: WebToolStatusEventPayload;
  createdAt: string;
}

export interface WebStatusEventRecord {
  id: string;
  type: 'turn_status' | 'turn_failed' | 'turn_cancelled' | 'status_update';
  payload: WebStatusEventPayload;
  createdAt: string;
}

export interface WebErrorEventRecord {
  id: string;
  type: 'error';
  payload: WebErrorEventPayload;
  createdAt: string;
}

/**
 * Public safe web event record discriminated union.
 * Event payload contains NO session/internal data.
 */
export type WebEventRecord =
  | WebMessageEventRecord
  | WebAssistantDeltaEventRecord
  | WebAssistantStreamEndEventRecord
  | WebThinkingEventRecord
  | WebToolStatusEventRecord
  | WebStatusEventRecord
  | WebErrorEventRecord;

export const SAFE_TOOL_NAMES = new Set([
  'send_platform_message',
  'send_message',
  'send_file',
  'create_task',
  'check_quota',
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'bash',
  'skill',
  'subagent',
  'subagent_fork',
  'interrupt_agent',
  'list_agents',
  'todo_write',
  'exit_plan_mode',
  'plan_mode',
  'ask_user_question',
  'report',
  'web_search',
  'workflow',
  'ralph',
  'create_goal',
  'get_goal',
  'update_goal',
  'read_image',
  'job_list',
  'job_output',
  'job_kill',
]);

export function sanitizeToolName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim()) {
    return 'custom_tool';
  }
  const clean = name.trim();
  if (SAFE_TOOL_NAMES.has(clean)) {
    return clean;
  }
  const sanitized = clean.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 64);
  return sanitized || 'custom_tool';
}

/**
 * Parameters for atomic ingestion of an inbound delivery.
 * Content and identifiers are strictly required; attachments are optional.
 */
export interface IngestWebDeliveryParams {
  userId: string;
  sessionId: string;
  spaceId: string;
  dshSessionId: string;
  idempotencyKey: string;
  deliveryId?: string;
  content: string;
  timestamp: string;
  attachments?: readonly CanonicalAttachment[];
  replyToMessageId?: string;
}

/**
 * Result returned upon atomic web delivery ingestion.
 * Exact safe return value: NO responsePayload.
 */
export interface IngestWebDeliveryResult {
  isClaimant: boolean;
  deliveryId: string;
  turnId: string;
  messageId: string;
  runId: string;
  state: 'held' | 'processing' | 'completed' | 'failed';
  message: WebMessageRecord;
}

/**
 * Record representing a delivery in the held state for startup redrive.
 */
export interface HeldDeliveryRecord {
  id: string;
  userId: string;
  routeId: string;
  messageId: string;
  deliveryId: string;
  turnId: string;
  payload: string;
  createdAt: string;
}

interface IdempotencyRow {
  id: unknown;
  idempotency_key: unknown;
  session_id: unknown;
  turn_id: unknown;
  delivery_id: unknown;
  request_hash: unknown;
  state: unknown;
  response_payload: unknown;
}

interface WebMessageRow {
  id: unknown;
  session_id: unknown;
  user_id: unknown;
  role: unknown;
  content: unknown;
  status: unknown;
  route_key: unknown;
  turn_id: unknown;
  created_at: unknown;
}

interface WebEventRow {
  id: unknown;
  session_id: unknown;
  user_id: unknown;
  type: unknown;
  payload: unknown;
  created_at: unknown;
}

interface HeldDeliveryRow {
  id: unknown;
  user_id: unknown;
  route_id: unknown;
  message_id: unknown;
  delivery_id: unknown;
  turn_id: unknown;
  payload: unknown;
  created_at: unknown;
}

export interface OpaqueCursorPayload {
  v: 1;
  kind: 'message' | 'event';
  id: string;
  createdAt: string;
}

/**
 * Safe helper to handle SQLite changes / integers without generic Number coercion.
 */
export function toSafeInt(val: unknown): number {
  if (typeof val === 'number') {
    if (!Number.isFinite(val) || !Number.isInteger(val) || val < 0 || val > Number.MAX_SAFE_INTEGER) {
      throw new PlatformError('Invalid change count integer', 'INTERNAL_ERROR', 500);
    }
    return val;
  }
  if (typeof val === 'bigint') {
    if (val < 0n || val > 9007199254740991n) {
      throw new PlatformError('BigInt change count overflow', 'INTERNAL_ERROR', 500);
    }
    return Number(val);
  }
  throw new PlatformError('Unexpected change count type', 'INTERNAL_ERROR', 500);
}

/**
 * Strict canonical ISO 8601 UTC date validator.
 */
export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    return false;
  }
  try {
    const d = new Date(value);
    return !Number.isNaN(d.getTime()) && d.toISOString() === value;
  } catch {
    return false;
  }
}

/**
 * Generate canonical prefix_32hex identifier.
 */
export function generate32HexId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('hex').toLowerCase()}`;
}

/**
 * Base64URL encode opaque cursor with exact canonical keys.
 */
export function encodeOpaqueCursor(payload: OpaqueCursorPayload): string {
  if (payload.v !== 1 || (payload.kind !== 'message' && payload.kind !== 'event')) {
    throw new ValidationError('Invalid cursor payload');
  }
  if (typeof payload.id !== 'string' || payload.id.length === 0) {
    throw new ValidationError('Invalid cursor ID');
  }
  if (!isValidIsoDate(payload.createdAt)) {
    throw new ValidationError('Invalid cursor createdAt timestamp');
  }

  const json = JSON.stringify({
    createdAt: payload.createdAt,
    id: payload.id,
    kind: payload.kind,
    v: 1,
  });
  return Buffer.from(json, 'utf8').toString('base64url');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Decodes, strictly validates format/schema/canonical shape, and verifies that the cursor exists
 * in the database under the exact (userId, sessionId, kind) scope.
 * Direct raw IDs are strictly rejected; only opaque base64url JSON cursors are allowed.
 */
export function decodeAndValidateCursor(
  db: DatabaseSync,
  rawCursor: string,
  expectedKind: 'message' | 'event',
  userId: string,
  sessionId: string
): { id: string; createdAt: string } {
  if (typeof rawCursor !== 'string' || rawCursor.length === 0 || rawCursor.length > 512) {
    throw new ValidationError('Invalid cursor: cursor must be a non-empty string under 512 characters');
  }

  // Must match valid base64url characters
  if (!/^[A-Za-z0-9_-]+$/.test(rawCursor)) {
    throw new ValidationError('Invalid cursor: malformed cursor encoding or characters');
  }

  let parsed: unknown;
  try {
    const jsonStr = Buffer.from(rawCursor, 'base64url').toString('utf8');
    if (!jsonStr.startsWith('{') || !jsonStr.endsWith('}')) {
      throw new ValidationError('Invalid cursor: not a valid JSON cursor');
    }
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    if (err instanceof ValidationError) {
      throw err;
    }
    throw new ValidationError('Invalid cursor: malformed cursor JSON');
  }

  if (!isRecord(parsed)) {
    throw new ValidationError('Invalid cursor: payload must be a JSON object');
  }

  const keys = Object.keys(parsed).sort();
  const expectedKeys = ['createdAt', 'id', 'kind', 'v'];
  const altExpectedKeys = ['createdAt', 'id', 'kind', 'version'];

  const matchesStandard = keys.length === expectedKeys.length && keys.every((k, i) => k === expectedKeys[i]);
  const matchesAlt = keys.length === altExpectedKeys.length && keys.every((k, i) => k === altExpectedKeys[i]);

  if (!matchesStandard && !matchesAlt) {
    throw new ValidationError('Invalid cursor: canonical shape mismatch');
  }

  const versionVal = matchesStandard ? parsed['v'] : parsed['version'];
  if (versionVal !== 1) {
    throw new ValidationError('Invalid cursor: unsupported cursor version');
  }
  if (parsed['kind'] !== expectedKind) {
    throw new ValidationError('Invalid cursor: cursor kind mismatch');
  }
  if (typeof parsed['id'] !== 'string' || parsed['id'].length === 0 || parsed['id'].length > 128) {
    throw new ValidationError('Invalid cursor: invalid id format in cursor');
  }
  if (typeof parsed['createdAt'] !== 'string' || !isValidIsoDate(parsed['createdAt'])) {
    throw new ValidationError('Invalid cursor: invalid createdAt in cursor');
  }

  const cursorId = parsed['id'];

  const tableName = expectedKind === 'message' ? 'web_messages' : 'web_events';
  const verifyStmt = db.prepare(`
    SELECT id, created_at FROM ${tableName}
    WHERE id = ? AND user_id = ? AND session_id = ?
    LIMIT 1
  `);
  const row = verifyStmt.get(cursorId, userId, sessionId) as { id: unknown; created_at: unknown } | undefined;

  if (!row || typeof row.id !== 'string' || typeof row.created_at !== 'string' || !isValidIsoDate(row.created_at)) {
    throw new ValidationError('Invalid cursor: cursor row not found or does not belong to the requested tenant/session');
  }

  return {
    id: row.id,
    createdAt: row.created_at,
  };
}

interface MessageAttachmentRow {
  id: unknown;
  message_id: unknown;
  user_id: unknown;
  space_id: unknown;
  relative_path: unknown;
  snapshot_path: unknown;
  etag: unknown;
  size: unknown;
  media_type: unknown;
  display_name: unknown;
  created_at: unknown;
}

function parseMessageAttachmentRow(r: MessageAttachmentRow, spaceIdOverride?: string): PublicMessageAttachment {
  if (
    typeof r.id !== 'string' ||
    typeof r.relative_path !== 'string' ||
    typeof r.snapshot_path !== 'string' ||
    typeof r.etag !== 'string' ||
    typeof r.media_type !== 'string' ||
    typeof r.size !== 'number' ||
    !Number.isSafeInteger(r.size) ||
    r.size < 0
  ) {
    throw new PlatformError('Corrupted message_attachments row in database', 'DATABASE_CORRUPTED', 500);
  }

  const spaceId = spaceIdOverride || (typeof r.space_id === 'string' ? r.space_id : '');
  if (!spaceId) {
    throw new PlatformError('Missing space_id for attachment download reference', 'DATABASE_CORRUPTED', 500);
  }

  const displayName = typeof r.display_name === 'string' && r.display_name.trim().length > 0
    ? r.display_name.trim().normalize('NFC')
    : undefined;

  return {
    id: r.id,
    relativePath: r.relative_path,
    etag: r.etag,
    size: r.size,
    mediaType: r.media_type,
    ...(displayName ? { displayName } : {}),
    downloadUrl: `/api/spaces/${encodeURIComponent(spaceId)}/files/download?path=${encodeURIComponent(r.snapshot_path)}`,
  };
}

/**
 * Queries attachments associated with a given message from SQLite message_attachments table.
 */
function queryMessageAttachments(db: DatabaseSync, messageId: string, spaceId?: string): PublicMessageAttachment[] {
  const stmt = db.prepare(`
    SELECT id, message_id, user_id, space_id, relative_path, snapshot_path, etag, size, media_type, display_name, created_at
    FROM message_attachments
    WHERE message_id = ?
    ORDER BY rowid ASC
  `);
  const rows = stmt.all(messageId) as unknown as MessageAttachmentRow[];
  return rows.map((r) => parseMessageAttachmentRow(r, spaceId));
}

/**
 * Batch queries attachments for multiple messages from SQLite message_attachments table.
 */
function queryBatchMessageAttachments(db: DatabaseSync, messageIds: string[]): Map<string, PublicMessageAttachment[]> {
  const result = new Map<string, PublicMessageAttachment[]>();
  if (messageIds.length === 0) return result;

  const placeholders = messageIds.map(() => '?').join(',');
  const stmt = db.prepare(`
    SELECT id, message_id, user_id, space_id, relative_path, snapshot_path, etag, size, media_type, display_name, created_at
    FROM message_attachments
    WHERE message_id IN (${placeholders})
    ORDER BY rowid ASC
  `);
  const rows = stmt.all(...messageIds) as unknown as MessageAttachmentRow[];
  for (const r of rows) {
    if (typeof r.message_id !== 'string') continue;
    const msgId = r.message_id;
    const list = result.get(msgId) || [];
    list.push(parseMessageAttachmentRow(r));
    result.set(msgId, list);
  }
  return result;
}

/**
 * Queries reply reference associated with a given message from SQLite message_references table.
 */
function queryMessageReference(db: DatabaseSync, messageId: string): WebMessageReplyReference | undefined {
  try {
    const stmt = db.prepare(`
      SELECT reply_to_message_id, quote_snippet, source_role
      FROM message_references
      WHERE message_id = ?
      LIMIT 1
    `);
    const row = stmt.get(messageId) as { reply_to_message_id: string | null; quote_snippet: string; source_role: string | null } | undefined;
    if (row && row.reply_to_message_id) {
      return {
        messageId: row.reply_to_message_id,
        role: row.source_role || undefined,
        snippet: row.quote_snippet || '',
      };
    }
  } catch {
    // If message_references table does not exist or query fails
  }
  return undefined;
}

/**
 * Batch queries reply references for multiple messages from SQLite message_references table.
 */
function queryBatchMessageReferences(db: DatabaseSync, messageIds: string[]): Map<string, WebMessageReplyReference> {
  const result = new Map<string, WebMessageReplyReference>();
  if (messageIds.length === 0) return result;
  try {
    const placeholders = messageIds.map(() => '?').join(',');
    const stmt = db.prepare(`
      SELECT message_id, reply_to_message_id, quote_snippet, source_role
      FROM message_references
      WHERE message_id IN (${placeholders})
    `);
    const rows = stmt.all(...messageIds) as Array<{
      message_id: string;
      reply_to_message_id: string | null;
      quote_snippet: string;
      source_role: string | null;
    }>;
    for (const r of rows) {
      if (r && r.message_id && r.reply_to_message_id) {
        result.set(r.message_id, {
          messageId: r.reply_to_message_id,
          role: r.source_role || undefined,
          snippet: r.quote_snippet || '',
        });
      }
    }
  } catch {
    // If table not present
  }
  return result;
}

/**
 * Computes canonical request SHA-256 hash using exact raw JSON {sessionId, content, attachments?, replyToMessageId?}.
 */
export function computeCanonicalRequestHash(sessionId: string, content: string, attachments?: readonly CanonicalAttachment[], replyToMessageId?: string): string {
  const normalized = JSON.stringify({
    sessionId,
    content,
    ...(attachments && attachments.length > 0
      ? {
          attachments: attachments.map((a) => ({
            path: a.relativePath,
            etag: a.etag,
          })),
        }
      : {}),
    ...(replyToMessageId ? { replyToMessageId } : {}),
  });
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * SQLite Web Message, Event, and Delivery Inbox persistence layer.
 * Enforces atomic multi-table transaction ingestions and strict multi-tenant isolation.
 */
export class SqliteWebMessageStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * Atomically ingests a web delivery in a single SQLite BEGIN IMMEDIATE transaction:
   * 1. Validates all inputs strictly (no optionals/aliases, required dshSessionId).
   * 2. Checks active status on session route and parent space under write lock.
   * 3. Validates dshSessionId matches route record exactly.
   * 4. Checks for idempotency duplicate or collision under (user_id, idempotency_key).
   * 5. For fresh claimant, generates 32hex IDs and atomically inserts:
   *    - idempotency_records ('held')
   *    - delivery_inbox ('held' with minimal payload {content, timestamp})
   *    - web_messages ('delivered', role='user', metadata=NULL)
   *    - web_events ('message')
   *    - turn_runs ('queued')
   */
  async ingestWebDelivery(params: IngestWebDeliveryParams): Promise<IngestWebDeliveryResult> {
    if (!params || typeof params !== 'object') {
      throw new ValidationError('Ingest params must be a non-null object');
    }

    const { userId, sessionId, spaceId, dshSessionId, idempotencyKey, content, timestamp } = params;

    if (typeof userId !== 'string' || userId.length === 0 || userId.length > 128) {
      throw new ValidationError('userId must be a non-empty string under 128 characters');
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 128) {
      throw new ValidationError('sessionId must be a non-empty string under 128 characters');
    }
    if (typeof spaceId !== 'string' || spaceId.length === 0 || spaceId.length > 128) {
      throw new ValidationError('spaceId must be a non-empty string under 128 characters');
    }
    if (typeof dshSessionId !== 'string' || dshSessionId.length === 0 || dshSessionId.length > 128) {
      throw new ValidationError('dshSessionId must be a non-empty string under 128 characters');
    }
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey.length > 256) {
      throw new ValidationError('idempotencyKey must be a non-empty string under 256 characters');
    }
    if (typeof content !== 'string' || content.length === 0 || Buffer.byteLength(content, 'utf8') > 65536) {
      throw new ValidationError('content must be a non-empty string under 64 KiB');
    }
    if (!timestamp || typeof timestamp !== 'string' || !isValidIsoDate(timestamp)) {
      throw new ValidationError('Canonical ISO timestamp is required');
    }

    const requestHash = computeCanonicalRequestHash(sessionId, content, params.attachments);

    let inTransaction = false;
    this.db.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    try {
      // 0. Strict session route and parent space authoritative active verification
      const routeCheckStmt = this.db.prepare(`
        SELECT sr.id as route_id, sr.user_id, sr.space_id, sr.status as route_status, sr.execution_mode as route_mode,
               sr.dsh_session_id, s.id as space_pk, s.status as space_status, s.execution_mode as space_mode
        FROM session_routes sr
        LEFT JOIN spaces s ON sr.space_id = s.id AND s.user_id = sr.user_id
        WHERE sr.id = ? AND sr.user_id = ?
        LIMIT 1
      `);
      const routeRow = routeCheckStmt.get(sessionId, userId) as {
        route_id: unknown;
        user_id: unknown;
        space_id: unknown;
        route_status: unknown;
        route_mode: unknown;
        dsh_session_id: unknown;
        space_pk: unknown;
        space_status: unknown;
        space_mode: unknown;
      } | undefined;

      if (!routeRow || typeof routeRow.route_id !== 'string') {
        this.rollbackSafe();
        inTransaction = false;
        throw new PlatformError('Session route not found for user', 'NOT_FOUND', 404);
      }

      if (spaceId !== routeRow.space_id) {
        this.rollbackSafe();
        inTransaction = false;
        throw new PlatformError('Session route space mismatch', 'SPACE_MISMATCH', 409);
      }

      if (dshSessionId !== routeRow.dsh_session_id) {
        this.rollbackSafe();
        inTransaction = false;
        throw new PlatformError('Session route dshSessionId mismatch', 'SESSION_MISMATCH', 409);
      }

      if (routeRow.route_status && routeRow.route_status !== 'active') {
        this.rollbackSafe();
        inTransaction = false;
        throw new PlatformError('Session is not active and cannot accept new turns', 'SESSION_ARCHIVED', 409);
      }

      if (routeRow.space_status && routeRow.space_status !== 'active') {
        this.rollbackSafe();
        inTransaction = false;
        throw new PlatformError('Space is not active and cannot accept new turns', 'SPACE_ARCHIVED', 409);
      }

      // 1. Check idempotency record under strict lock
      const checkStmt = this.db.prepare(`
        SELECT id, idempotency_key, session_id, turn_id, delivery_id, request_hash, state, response_payload
        FROM idempotency_records
        WHERE user_id = ? AND idempotency_key = ?
        LIMIT 1
      `);
      const existing = checkStmt.get(userId, idempotencyKey) as IdempotencyRow | undefined;

      if (existing) {
        if (typeof existing.session_id !== 'string' || typeof existing.request_hash !== 'string' || typeof existing.turn_id !== 'string') {
          this.rollbackSafe();
          inTransaction = false;
          throw new PlatformError('Corrupted idempotency record in database', 'DATABASE_CORRUPTED', 500);
        }

        // Idempotency key collision check: same key with different payload or session => 409 Conflict
        if (existing.session_id !== sessionId || existing.request_hash !== requestHash) {
          this.rollbackSafe();
          inTransaction = false;
          throw new PlatformError(
            'Idempotency-Key was already used with different request parameters or session.',
            'IDEMPOTENCY_CONFLICT',
            409
          );
        }

        // Fetch the corresponding user message
        const msgStmt = this.db.prepare(`
          SELECT id, session_id, user_id, role, content, status, route_key, turn_id, created_at
          FROM web_messages
          WHERE user_id = ? AND turn_id = ? AND role = 'user'
          LIMIT 1
        `);
        const msgRow = msgStmt.get(userId, existing.turn_id) as WebMessageRow | undefined;

        this.rollbackSafe();
        inTransaction = false;

        if (!msgRow || typeof msgRow.id !== 'string' || typeof msgRow.content !== 'string' || typeof msgRow.created_at !== 'string') {
          throw new PlatformError('Database invariant violation: idempotency record exists without matching user message', 'INVARIANT_VIOLATION', 500);
        }

        const role = msgRow.role === 'user' ? 'user' : (msgRow.role === 'assistant' ? 'assistant' : 'system');
        const status = msgRow.status === 'delivered' ? 'delivered' : (msgRow.status === 'pending' ? 'pending' : 'failed');
        const existingAttachments = queryMessageAttachments(this.db, msgRow.id, spaceId);
        const existingReplyRef = queryMessageReference(this.db, msgRow.id);

        const messageRecord: WebMessageRecord = {
          id: msgRow.id,
          role,
          content: msgRow.content,
          status,
          createdAt: msgRow.created_at,
          ...(existingAttachments.length > 0 ? { attachments: existingAttachments } : {}),
          ...(existingReplyRef ? { replyReference: existingReplyRef } : {}),
        };

        const existingState: 'held' | 'processing' | 'completed' | 'failed' =
          existing.state === 'held' || existing.state === 'processing' || existing.state === 'completed' || existing.state === 'failed'
            ? existing.state
            : 'held';

        return {
          isClaimant: false,
          deliveryId: typeof existing.delivery_id === 'string' ? existing.delivery_id : '',
          turnId: existing.turn_id,
          messageId: msgRow.id,
          runId: '',
          state: existingState,
          message: messageRecord,
        };
      }

      // Validate referenced message if replyToMessageId provided
      let resolvedReplyRef: WebMessageReplyReference | undefined;
      if (params.replyToMessageId) {
        const refMsg = this.db.prepare(`
          SELECT id, role, content
          FROM web_messages
          WHERE id = ? AND user_id = ?
          LIMIT 1
        `).get(params.replyToMessageId, userId) as { id: string; role: string; content: string } | undefined;

        if (!refMsg) {
          this.rollbackSafe();
          inTransaction = false;
          throw new PlatformError(`Referenced message "${params.replyToMessageId}" not found for user`, 'NOT_FOUND', 404);
        }

        const snippet = refMsg.content ? refMsg.content.slice(0, 200) : '';
        resolvedReplyRef = {
          messageId: refMsg.id,
          role: refMsg.role || undefined,
          snippet,
        };
      }

      // 2. Fresh claimant: Generate canonical 32-hex identifiers internally
      const turnId = generate32HexId('turn');
      const messageId = generate32HexId('msg');
      const deliveryId = params.deliveryId || (idempotencyKey.startsWith('deliv_') ? idempotencyKey : generate32HexId('deliv'));
      const runId = generate32HexId('run');
      const eventId = generate32HexId('evt');
      const idemId = generate32HexId('idem');
      const inboxId = generate32HexId('inbox');
      const routeKey = `${userId}:web:${spaceId}:${sessionId}`;
      const minimalDeliveryPayload = JSON.stringify({
        content,
        timestamp,
      });

      // 2a. Insert placeholder into idempotency_records
      this.db.prepare(`
        INSERT INTO idempotency_records (
          id, user_id, idempotency_key, session_id, delivery_id, turn_id, request_hash, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'held', ?, ?)
      `).run(
        idemId,
        userId,
        idempotencyKey,
        sessionId,
        deliveryId,
        turnId,
        requestHash,
        timestamp,
        timestamp
      );

      // 2b. Insert into delivery_inbox (state = 'held', minimal payload {content, timestamp})
      this.db.prepare(`
        INSERT INTO delivery_inbox (
          id, user_id, route_id, message_id, delivery_id, payload, status, turn_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'held', ?, ?, ?)
      `).run(
        inboxId,
        userId,
        sessionId,
        messageId,
        deliveryId,
        minimalDeliveryPayload,
        turnId,
        timestamp,
        timestamp
      );

      // 2c. Insert user message into web_messages (metadata is always null)
      this.db.prepare(`
        INSERT INTO web_messages (
          id, session_id, user_id, role, content, status, route_key, turn_id, metadata, created_at
        ) VALUES (?, ?, ?, 'user', ?, 'delivered', ?, ?, NULL, ?)
      `).run(
        messageId,
        sessionId,
        userId,
        content,
        routeKey,
        turnId,
        timestamp
      );

      // 2c-2. Insert attachments if provided into message_attachments
      if (params.attachments && params.attachments.length > 0) {
        const attInsertStmt = this.db.prepare(`
          INSERT INTO message_attachments (
            id, message_id, user_id, space_id, relative_path, snapshot_path, etag, size, media_type, display_name, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const journalLinkStmt = this.db.prepare(`
          UPDATE attachment_snapshot_journal
          SET status = 'linked', updated_at = CURRENT_TIMESTAMP
          WHERE space_id = ? AND snapshot_path = ? AND status = 'copied'
        `);

        for (const att of params.attachments) {
          const attId = att.id || generate32HexId('att');
          attInsertStmt.run(
            attId,
            messageId,
            userId,
            spaceId,
            att.relativePath,
            att.snapshotPath,
            att.etag,
            att.size,
            att.mediaType,
            att.displayName ?? null,
            timestamp
          );
          journalLinkStmt.run(spaceId, att.snapshotPath);
        }
      }

      // 2c-3. Insert message reference if replyToMessageId provided
      if (resolvedReplyRef) {
        const refId = generate32HexId('ref');
        this.db.prepare(`
          INSERT INTO message_references (
            id, message_id, user_id, reply_to_message_id, quote_snippet, source_role, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          refId,
          messageId,
          userId,
          resolvedReplyRef.messageId,
          resolvedReplyRef.snippet,
          resolvedReplyRef.role || null,
          timestamp
        );
      }

      const publicAttachments: PublicMessageAttachment[] = (params.attachments && params.attachments.length > 0)
        ? params.attachments.map((att) => ({
            id: att.id,
            relativePath: att.relativePath,
            etag: att.etag,
            size: att.size,
            mediaType: att.mediaType,
            ...(att.displayName ? { displayName: att.displayName } : {}),
            downloadUrl: att.downloadReference || `/api/spaces/${encodeURIComponent(spaceId)}/files/download?path=${encodeURIComponent(att.snapshotPath)}`,
          }))
        : [];

      // 2d. Insert minimal safe user message event into web_events
      const publicMessage: WebMessageRecord = {
        id: messageId,
        role: 'user',
        content,
        status: 'delivered',
        createdAt: timestamp,
        ...(publicAttachments.length > 0 ? { attachments: publicAttachments } : {}),
        ...(resolvedReplyRef ? { replyReference: resolvedReplyRef } : {}),
      };

      const eventPayloadStr = JSON.stringify({
        message: publicMessage,
      });

      this.db.prepare(`
        INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
        VALUES (?, ?, ?, 'message', ?, ?)
      `).run(
        eventId,
        sessionId,
        userId,
        eventPayloadStr,
        timestamp
      );

      // 2e. Insert queued turn into turn_runs
      const executionMode = (routeRow.space_mode || routeRow.route_mode || 'container') as string;
      this.db.prepare(`
        INSERT INTO turn_runs (
          id, turn_id, space_id, route_id, user_id, execution_mode, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)
      `).run(
        runId,
        turnId,
        spaceId,
        sessionId,
        userId,
        executionMode,
        timestamp,
        timestamp
      );

      this.db.exec('COMMIT');
      inTransaction = false;

      return {
        isClaimant: true,
        deliveryId,
        turnId,
        messageId,
        runId,
        state: 'held',
        message: publicMessage,
      };
    } catch (err) {
      if (inTransaction) {
        try {
          this.db.exec('ROLLBACK');
        } catch (rollbackErr) {
          throw new AggregateError([err, rollbackErr], 'Database transaction failed and rollback also failed');
        }
      }
      throw err;
    }
  }

  private rollbackSafe(): void {
    try {
      this.db.exec('ROLLBACK');
    } catch {
      // rollback ignored
    }
  }

  /**
   * Atomically claims a held delivery in a single transaction:
   * CAS delivery_inbox from 'held' -> 'processing',
   * CAS idempotency_records from 'held' -> 'processing',
   * and verifies turn_runs status is 'queued' or 'running'.
   * Returns true if and only if all CAS transitions succeeded.
   */
  async claimHeldDelivery(userId: string, deliveryId: string, idempotencyKey: string, turnId: string): Promise<boolean> {
    if (typeof userId !== 'string' || typeof deliveryId !== 'string' || typeof idempotencyKey !== 'string' || typeof turnId !== 'string') {
      throw new ValidationError('Invalid arguments for claimHeldDelivery');
    }

    let inTransaction = false;
    this.db.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    try {
      const inboxStmt = this.db.prepare(`
        UPDATE delivery_inbox
        SET status = 'processing', processed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND delivery_id = ? AND status = 'held'
      `);
      const inboxRes = inboxStmt.run(userId, deliveryId);

      const idemStmt = this.db.prepare(`
        UPDATE idempotency_records
        SET state = 'processing', updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND idempotency_key = ? AND state = 'held'
      `);
      const idemRes = idemStmt.run(userId, idempotencyKey);

      const turnStmt = this.db.prepare(`
        SELECT status FROM turn_runs WHERE turn_id = ? AND user_id = ? LIMIT 1
      `);
      const turnRow = turnStmt.get(turnId, userId) as { status?: unknown } | undefined;

      const inboxChanges = toSafeInt(inboxRes.changes);
      const idemChanges = toSafeInt(idemRes.changes);

      if (inboxChanges === 0 || idemChanges === 0 || !turnRow || (turnRow.status !== 'queued' && turnRow.status !== 'running')) {
        this.rollbackSafe();
        inTransaction = false;
        return false;
      }

      this.db.exec('COMMIT');
      inTransaction = false;
      return true;
    } catch (err) {
      if (inTransaction) {
        try {
          this.db.exec('ROLLBACK');
        } catch (rollbackErr) {
          throw new AggregateError([err, rollbackErr], 'claimHeldDelivery failed and database ROLLBACK also failed');
        }
      }
      throw err;
    }
  }

  /**
   * Startup crash recovery:
   * Atomically resets stranded 'processing' delivery_inbox records back to 'held',
   * 'processing' idempotency_records back to 'held',
   * and 'running' turn_runs back to 'queued' across all tenants.
   */
  async recoverDanglingDeliveriesOnStartup(): Promise<{ recoveredInboxCount: number; recoveredTurnsCount: number }> {
    let inTransaction = false;
    this.db.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    try {
      const inboxRes = this.db.prepare(`
        UPDATE delivery_inbox
        SET status = 'held', updated_at = CURRENT_TIMESTAMP
        WHERE status = 'processing'
      `).run();

      this.db.prepare(`
        UPDATE idempotency_records
        SET state = 'held', updated_at = CURRENT_TIMESTAMP
        WHERE state = 'processing'
      `).run();

      const turnRes = this.db.prepare(`
        UPDATE turn_runs
        SET status = 'interrupted', error = 'Interrupted due to platform restart', finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE status = 'running'
      `).run();

      this.db.exec('COMMIT');
      inTransaction = false;
      return {
        recoveredInboxCount: toSafeInt(inboxRes.changes),
        recoveredTurnsCount: toSafeInt(turnRes.changes),
      };
    } catch (err) {
      if (inTransaction) {
        try {
          this.db.exec('ROLLBACK');
        } catch (rollbackErr) {
          throw new AggregateError([err, rollbackErr], 'recoverDanglingDeliveriesOnStartup failed and database ROLLBACK also failed');
        }
      }
      throw err;
    }
  }

  /**
   * Lists all held delivery inbox records for startup recovery redriving.
   */
  async listHeldDeliveries(): Promise<HeldDeliveryRecord[]> {
    const stmt = this.db.prepare(`
      SELECT id, user_id, route_id, message_id, delivery_id, turn_id, payload, created_at
      FROM delivery_inbox
      WHERE status = 'held'
      ORDER BY created_at ASC
    `);
    const rows = stmt.all() as unknown as HeldDeliveryRow[];

    const result: HeldDeliveryRecord[] = [];
    for (const r of rows) {
      if (
        typeof r.id !== 'string' ||
        typeof r.user_id !== 'string' ||
        typeof r.route_id !== 'string' ||
        typeof r.message_id !== 'string' ||
        typeof r.delivery_id !== 'string' ||
        typeof r.turn_id !== 'string' ||
        typeof r.payload !== 'string' ||
        typeof r.created_at !== 'string'
      ) {
        throw new PlatformError('Corrupted delivery_inbox record', 'DATABASE_CORRUPTED', 500);
      }
      result.push({
        id: r.id,
        userId: r.user_id,
        routeId: r.route_id,
        messageId: r.message_id,
        deliveryId: r.delivery_id,
        turnId: r.turn_id,
        payload: r.payload,
        createdAt: r.created_at,
      });
    }
    return result;
  }

  /**
   * CAS updates delivery_inbox status from one state to another.
   */
  async updateDeliveryInboxStatus(
    userId: string,
    deliveryId: string,
    fromStatus: string,
    toStatus: string,
    error?: string
  ): Promise<boolean> {
    if (typeof userId !== 'string' || typeof deliveryId !== 'string') {
      throw new ValidationError('Invalid arguments for updateDeliveryInboxStatus');
    }
    const stmt = this.db.prepare(`
      UPDATE delivery_inbox
      SET status = ?, error = ?, processed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND delivery_id = ? AND status = ?
    `);
    const res = stmt.run(toStatus, error ?? null, userId, deliveryId, fromStatus);
    return toSafeInt(res.changes) > 0;
  }

  /**
   * CAS updates idempotency_records state from one state to another.
   */
  async updateIdempotencyState(
    userId: string,
    idempotencyKey: string,
    fromState: string,
    toState: string,
    responsePayload?: Record<string, unknown>
  ): Promise<boolean> {
    if (typeof userId !== 'string' || typeof idempotencyKey !== 'string') {
      throw new ValidationError('Invalid arguments for updateIdempotencyState');
    }
    const payloadStr = responsePayload ? JSON.stringify(responsePayload) : null;
    const stmt = this.db.prepare(`
      UPDATE idempotency_records
      SET state = ?, response_payload = COALESCE(?, response_payload), updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND idempotency_key = ? AND state = ?
    `);
    const res = stmt.run(toState, payloadStr, userId, idempotencyKey, fromState);
    return toSafeInt(res.changes) > 0;
  }

  /**
   * Fetches public message history for a session belonging to a specific user.
   * Supports bidirectional keyset pagination via opaque cursor (created_at, id).
   * - Initial fetch (no before, no after): returns latest `limit` messages in ascending order (old -> new).
   * - History fetch (before=<cursor>): returns up to `limit` messages strictly older than the cursor, in ascending order (old -> new).
   * - Catch-up fetch (after=<cursor>): returns up to `limit` messages strictly newer than the cursor, in ascending order (old -> new).
   * Strips internal metadata and fields.
   */
  async listMessages(
    userId: string,
    sessionId: string,
    options: { limit?: number; before?: string; after?: string; cursor?: string } = {}
  ): Promise<{ messages: WebMessageRecord[]; hasMore: boolean; olderCursor: string | null; newerCursor: string | null }> {
    if (typeof userId !== 'string' || userId.length === 0 || userId.length > 128) {
      throw new ValidationError('Invalid userId format');
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 128) {
      throw new ValidationError('Invalid sessionId format');
    }

    if (options.cursor !== undefined) {
      throw new ValidationError('Legacy "cursor" parameter is removed; use "before" for historical pagination or "after" for forward catch-up');
    }

    if (options.before !== undefined && options.after !== undefined) {
      throw new ValidationError("Cannot specify both 'before' and 'after' options");
    }

    const limitNum = typeof options.limit === 'number' && Number.isInteger(options.limit) ? options.limit : 50;
    const limit = Math.min(Math.max(limitNum, 1), 100);

    let rows: WebMessageRow[];
    let shouldReverse = false;

    if (options.before !== undefined) {
      const decoded = decodeAndValidateCursor(this.db, options.before, 'message', userId, sessionId);
      const query = `
        SELECT id, session_id, user_id, role, content, status, route_key, turn_id, created_at
        FROM web_messages
        WHERE session_id = ? AND user_id = ?
          AND (created_at < ? OR (created_at = ? AND id < ?))
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `;
      const stmt = this.db.prepare(query);
      rows = stmt.all(sessionId, userId, decoded.createdAt, decoded.createdAt, decoded.id, limit + 1) as unknown as WebMessageRow[];
      shouldReverse = true;
    } else if (options.after !== undefined) {
      const decoded = decodeAndValidateCursor(this.db, options.after, 'message', userId, sessionId);
      const query = `
        SELECT id, session_id, user_id, role, content, status, route_key, turn_id, created_at
        FROM web_messages
        WHERE session_id = ? AND user_id = ?
          AND (created_at > ? OR (created_at = ? AND id > ?))
        ORDER BY created_at ASC, id ASC
        LIMIT ?
      `;
      const stmt = this.db.prepare(query);
      rows = stmt.all(sessionId, userId, decoded.createdAt, decoded.createdAt, decoded.id, limit + 1) as unknown as WebMessageRow[];
      shouldReverse = false;
    } else {
      // Initial: latest messages
      const query = `
        SELECT id, session_id, user_id, role, content, status, route_key, turn_id, created_at
        FROM web_messages
        WHERE session_id = ? AND user_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `;
      const stmt = this.db.prepare(query);
      rows = stmt.all(sessionId, userId, limit + 1) as unknown as WebMessageRow[];
      shouldReverse = true;
    }

    const hasMore = rows.length > limit;
    const selectedRows = rows.slice(0, limit);
    if (shouldReverse) {
      selectedRows.reverse();
    }

    const msgIds = selectedRows.map((r) => String(r.id));
    const attachmentsMap = queryBatchMessageAttachments(this.db, msgIds);
    const referencesMap = queryBatchMessageReferences(this.db, msgIds);

    const records: WebMessageRecord[] = [];
    for (const r of selectedRows) {
      if (
        typeof r.id !== 'string' ||
        typeof r.content !== 'string' ||
        typeof r.created_at !== 'string' ||
        !isValidIsoDate(r.created_at)
      ) {
        throw new PlatformError('Corrupted web_messages row in database', 'DATABASE_CORRUPTED', 500);
      }

      if (r.role !== 'user' && r.role !== 'assistant' && r.role !== 'system') {
        throw new PlatformError('Corrupted message role in database', 'DATABASE_CORRUPTED', 500);
      }
      if (r.status !== 'pending' && r.status !== 'delivered' && r.status !== 'failed') {
        throw new PlatformError('Corrupted message status in database', 'DATABASE_CORRUPTED', 500);
      }

      const atts = attachmentsMap.get(String(r.id));
      const ref = referencesMap.get(String(r.id));
      records.push({
        id: r.id,
        role: r.role,
        content: r.content,
        status: r.status,
        createdAt: r.created_at,
        ...(atts && atts.length > 0 ? { attachments: atts } : {}),
        ...(ref ? { replyReference: ref } : {}),
      });
    }

    let olderCursor: string | null = null;
    let newerCursor: string | null = null;

    if (records.length > 0) {
      const firstRecord = records[0];
      const lastRecord = records[records.length - 1];
      olderCursor = encodeOpaqueCursor({
        v: 1,
        kind: 'message',
        id: firstRecord.id,
        createdAt: firstRecord.createdAt,
      });
      newerCursor = encodeOpaqueCursor({
        v: 1,
        kind: 'message',
        id: lastRecord.id,
        createdAt: lastRecord.createdAt,
      });
    }

    return {
      messages: records,
      hasMore,
      olderCursor,
      newerCursor,
    };
  }

  /**
   * Retrieves a single public message by ID belonging to a specific session and user.
   */
  async getMessage(userId: string, sessionId: string, messageId: string): Promise<WebMessageRecord | null> {
    if (typeof userId !== 'string' || typeof sessionId !== 'string' || typeof messageId !== 'string') {
      throw new ValidationError('Invalid arguments for getMessage');
    }

    const row = this.db.prepare(`
      SELECT id, session_id, user_id, role, content, status, route_key, turn_id, created_at
      FROM web_messages
      WHERE id = ? AND session_id = ? AND user_id = ?
      LIMIT 1
    `).get(messageId, sessionId, userId) as unknown as WebMessageRow | undefined;

    if (!row) return null;

    if (
      typeof row.id !== 'string' ||
      typeof row.content !== 'string' ||
      typeof row.created_at !== 'string' ||
      !isValidIsoDate(row.created_at)
    ) {
      throw new PlatformError('Corrupted web_messages row in database', 'DATABASE_CORRUPTED', 500);
    }
    if (row.role !== 'user' && row.role !== 'assistant' && row.role !== 'system') {
      throw new PlatformError('Corrupted message role in database', 'DATABASE_CORRUPTED', 500);
    }
    if (row.status !== 'pending' && row.status !== 'delivered' && row.status !== 'failed') {
      throw new PlatformError('Corrupted message status in database', 'DATABASE_CORRUPTED', 500);
    }

    const atts = queryMessageAttachments(this.db, row.id);
    const ref = queryMessageReference(this.db, row.id);

    return {
      id: row.id,
      role: row.role,
      content: row.content,
      status: row.status,
      createdAt: row.created_at,
      ...(atts.length > 0 ? { attachments: atts } : {}),
      ...(ref ? { replyReference: ref } : {}),
    };
  }

  /**
   * Retrieves internal message record with turnId and routeKey for delivery runtime gateway.
   * Strips database metadata column.
   */
  async getInternalMessage(userId: string, sessionId: string, messageId: string): Promise<InternalStoredMessage | null> {
    if (typeof userId !== 'string' || typeof sessionId !== 'string' || typeof messageId !== 'string') {
      throw new ValidationError('Invalid arguments for getInternalMessage');
    }

    const row = this.db.prepare(`
      SELECT id, session_id, user_id, role, content, status, route_key, turn_id, created_at
      FROM web_messages
      WHERE id = ? AND session_id = ? AND user_id = ?
      LIMIT 1
    `).get(messageId, sessionId, userId) as unknown as WebMessageRow | undefined;

    if (!row) return null;

    if (
      typeof row.id !== 'string' ||
      typeof row.session_id !== 'string' ||
      typeof row.user_id !== 'string' ||
      typeof row.content !== 'string' ||
      typeof row.route_key !== 'string' ||
      typeof row.created_at !== 'string' ||
      !isValidIsoDate(row.created_at)
    ) {
      throw new PlatformError('Corrupted web_messages row in database', 'DATABASE_CORRUPTED', 500);
    }

    const role = row.role === 'user' || row.role === 'assistant' || row.role === 'system' ? row.role : 'user';
    const status = row.status === 'pending' || row.status === 'delivered' || row.status === 'failed' ? row.status : 'delivered';
    const atts = queryMessageAttachments(this.db, row.id);
    const ref = queryMessageReference(this.db, row.id);

    return {
      id: row.id,
      sessionId: row.session_id,
      userId: row.user_id,
      role,
      content: row.content,
      status,
      routeKey: row.route_key,
      turnId: typeof row.turn_id === 'string' ? row.turn_id : null,
      createdAt: row.created_at,
      ...(atts.length > 0 ? { attachments: atts } : {}),
      ...(ref ? { replyReference: ref } : {}),
    };
  }

  /**
   * Retrieves internal message record by turnId for delivery runtime gateway redrive.
   * Strips database metadata column.
   */
  async getInternalMessageByTurn(userId: string, sessionId: string, turnId: string): Promise<InternalStoredMessage | null> {
    if (typeof userId !== 'string' || typeof sessionId !== 'string' || typeof turnId !== 'string') {
      throw new ValidationError('Invalid arguments for getInternalMessageByTurn');
    }

    const row = this.db.prepare(`
      SELECT id, session_id, user_id, role, content, status, route_key, turn_id, created_at
      FROM web_messages
      WHERE turn_id = ? AND session_id = ? AND user_id = ?
      LIMIT 1
    `).get(turnId, sessionId, userId) as unknown as WebMessageRow | undefined;

    if (!row) return null;

    if (
      typeof row.id !== 'string' ||
      typeof row.session_id !== 'string' ||
      typeof row.user_id !== 'string' ||
      typeof row.content !== 'string' ||
      typeof row.route_key !== 'string' ||
      typeof row.created_at !== 'string' ||
      !isValidIsoDate(row.created_at)
    ) {
      throw new PlatformError('Corrupted web_messages row in database', 'DATABASE_CORRUPTED', 500);
    }

    const role = row.role === 'user' || row.role === 'assistant' || row.role === 'system' ? row.role : 'user';
    const status = row.status === 'pending' || row.status === 'delivered' || row.status === 'failed' ? row.status : 'delivered';
    const atts = queryMessageAttachments(this.db, row.id);
    const ref = queryMessageReference(this.db, row.id);

    return {
      id: row.id,
      sessionId: row.session_id,
      userId: row.user_id,
      role,
      content: row.content,
      status,
      routeKey: row.route_key,
      turnId: typeof row.turn_id === 'string' ? row.turn_id : null,
      createdAt: row.created_at,
      ...(atts.length > 0 ? { attachments: atts } : {}),
      ...(ref ? { replyReference: ref } : {}),
    };
  }

  /**
   * Inserts a single message directly into web_messages.
   * Validates required timestamp strictly without fallbacks. Inserts NULL for metadata.
   */
  async insertMessage(message: {
    id: string;
    sessionId: string;
    userId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    status?: 'pending' | 'delivered' | 'failed';
    routeKey?: string;
    turnId?: string | null;
    createdAt: string;
  }): Promise<WebMessageRecord> {
    if (!message || typeof message !== 'object') {
      throw new ValidationError('Message must be an object');
    }
    if (typeof message.id !== 'string' || message.id.length === 0) {
      throw new ValidationError('Message ID is required');
    }
    if (typeof message.sessionId !== 'string' || message.sessionId.length === 0) {
      throw new ValidationError('Session ID is required');
    }
    if (typeof message.userId !== 'string' || message.userId.length === 0) {
      throw new ValidationError('User ID is required');
    }
    if (typeof message.content !== 'string') {
      throw new ValidationError('Content is required');
    }
    if (!message.createdAt || typeof message.createdAt !== 'string' || !isValidIsoDate(message.createdAt)) {
      throw new ValidationError('Valid ISO createdAt timestamp is required');
    }

    const createdAt = message.createdAt;
    const role: 'user' | 'assistant' | 'system' =
      message.role === 'assistant' || message.role === 'system' ? message.role : 'user';
    const status: 'pending' | 'delivered' | 'failed' =
      message.status === 'pending' || message.status === 'failed' ? message.status : 'delivered';
    const routeKey = message.routeKey || `${message.userId}:web:${message.sessionId}`;

    this.db.prepare(`
      INSERT OR REPLACE INTO web_messages (
        id, session_id, user_id, role, content, status, route_key, turn_id, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(
      message.id,
      message.sessionId,
      message.userId,
      role,
      message.content,
      status,
      routeKey,
      message.turnId ?? null,
      createdAt
    );

    return {
      id: message.id,
      role,
      content: message.content,
      status,
      createdAt,
    };
  }

  /**
   * Inserts a single event directly into web_events.
   * Validates required timestamp strictly without fallbacks.
   */
  async insertEvent(event: {
    id?: string;
    sessionId: string;
    userId: string;
    type: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }): Promise<WebEventRecord> {
    const results = await this.insertEventsBatch([event]);
    return results[0];
  }

  /**
   * Inserts a batch of events atomically into web_events in a single transaction.
   */
  async insertEventsBatch(events: Array<{
    id?: string;
    sessionId: string;
    userId: string;
    type: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }>): Promise<WebEventRecord[]> {
    if (!Array.isArray(events) || events.length === 0) {
      return [];
    }

    const records: WebEventRecord[] = [];
    const preparedRows: Array<{
      id: string;
      sessionId: string;
      userId: string;
      type: string;
      payloadStr: string;
      createdAt: string;
      record: WebEventRecord;
    }> = [];
    let lastTimeMs = 0;

    for (const event of events) {
      if (!event || typeof event !== 'object') {
        throw new ValidationError('Event must be an object');
      }
      if (typeof event.sessionId !== 'string' || event.sessionId.length === 0) {
        throw new ValidationError('Session ID is required');
      }
      if (typeof event.userId !== 'string' || event.userId.length === 0) {
        throw new ValidationError('User ID is required');
      }
      if (typeof event.type !== 'string' || event.type.length === 0) {
        throw new ValidationError('Event type is required');
      }
      if (!isRecord(event.payload)) {
        throw new ValidationError('Event payload must be a record');
      }
      if (!event.createdAt || typeof event.createdAt !== 'string' || !isValidIsoDate(event.createdAt)) {
        throw new ValidationError('Valid ISO createdAt timestamp is required');
      }

      let eventTimeMs = new Date(event.createdAt).getTime();
      if (Number.isNaN(eventTimeMs) || eventTimeMs <= lastTimeMs) {
        eventTimeMs = Math.max(Date.now(), lastTimeMs + 1);
      }
      lastTimeMs = eventTimeMs;
      const createdAt = new Date(eventTimeMs).toISOString();

      const timeHex = eventTimeMs.toString(16).padStart(12, '0');
      const randHex = randomBytes(10).toString('hex').toLowerCase();
      const id = event.id && event.id.length > 0 ? event.id : `evt_${timeHex}${randHex}`;

      let record: WebEventRecord;
      let sanitizedPayload: Record<string, unknown>;

      switch (event.type) {
        case 'message': {
          const rawMsg = event.payload['message'] && isRecord(event.payload['message']) ? event.payload['message'] : event.payload;
          const msgRole = rawMsg['role'];
          if (msgRole !== 'user' && msgRole !== 'assistant' && msgRole !== 'system') {
            throw new ValidationError('Invalid message role in event payload');
          }
          const msgStatus = rawMsg['status'];
          const validStatus = (msgStatus === 'pending' || msgStatus === 'delivered' || msgStatus === 'failed') ? msgStatus : 'delivered';
          const msgRecord: WebMessageRecord = {
            id: typeof rawMsg['id'] === 'string' ? rawMsg['id'] : id,
            role: msgRole,
            content: typeof rawMsg['content'] === 'string' ? rawMsg['content'] : '',
            status: validStatus,
            createdAt: typeof rawMsg['createdAt'] === 'string' ? rawMsg['createdAt'] : createdAt,
          };
          sanitizedPayload = { message: msgRecord };
          record = {
            id,
            type: 'message',
            payload: { message: msgRecord },
            createdAt,
          };
          break;
        }
        case 'assistant_delta': {
          const streamId = typeof event.payload['streamId'] === 'string' ? event.payload['streamId'] : generate32HexId('msgstream');
          const delta = typeof event.payload['delta'] === 'string' ? event.payload['delta'] : '';
          const accumulatedLength = typeof event.payload['accumulatedLength'] === 'number' && Number.isFinite(event.payload['accumulatedLength'])
            ? Math.max(0, Math.floor(event.payload['accumulatedLength']))
            : delta.length;
          sanitizedPayload = { streamId, delta, accumulatedLength };
          record = {
            id,
            type: 'assistant_delta',
            payload: { streamId, delta, accumulatedLength },
            createdAt,
          };
          break;
        }
        case 'assistant_stream_end': {
          const streamId = typeof event.payload['streamId'] === 'string' ? event.payload['streamId'] : generate32HexId('msgstream');
          sanitizedPayload = { streamId };
          record = {
            id,
            type: 'assistant_stream_end',
            payload: { streamId },
            createdAt,
          };
          break;
        }
        case 'thinking': {
          const streamId = typeof event.payload['streamId'] === 'string' ? event.payload['streamId'] : undefined;
          sanitizedPayload = {
            status: 'thinking',
            ...(streamId ? { streamId } : {}),
          };
          record = {
            id,
            type: 'thinking',
            payload: {
              status: 'thinking',
              ...(streamId ? { streamId } : {}),
            },
            createdAt,
          };
          break;
        }
        case 'tool_status': {
          const rawToolName = event.payload['toolName'] ?? event.payload['name'];
          const toolName = sanitizeToolName(rawToolName);
          const rawStatus = event.payload['status'];
          const status = (rawStatus === 'started' || rawStatus === 'completed' || rawStatus === 'failed') ? rawStatus : 'started';
          sanitizedPayload = { toolName, status };
          record = {
            id,
            type: 'tool_status',
            payload: { toolName, status },
            createdAt,
          };
          break;
        }
        case 'turn_status':
        case 'turn_failed':
        case 'turn_cancelled':
        case 'status_update': {
          // Remove internal turnId from public payload if present
          const cleanPayload: WebStatusEventPayload = {};
          const rawStatus = event.payload['status'];
          if (
            rawStatus === 'queued' ||
            rawStatus === 'running' ||
            rawStatus === 'completed' ||
            rawStatus === 'failed' ||
            rawStatus === 'interrupted'
          ) {
            cleanPayload.status = rawStatus;
          }
          if (typeof event.payload['code'] === 'string') cleanPayload.code = event.payload['code'];
          sanitizedPayload = cleanPayload;
          record = {
            id,
            type: event.type,
            payload: cleanPayload,
            createdAt,
          };
          break;
        }
        case 'error': {
          const code = typeof event.payload['code'] === 'string' ? event.payload['code'] : 'INTERNAL_ERROR';
          sanitizedPayload = { code };
          record = {
            id,
            type: 'error',
            payload: { code },
            createdAt,
          };
          break;
        }
        default:
          throw new ValidationError(`Unsupported event type: ${event.type}`);
      }

      preparedRows.push({
        id,
        sessionId: event.sessionId,
        userId: event.userId,
        type: event.type,
        payloadStr: JSON.stringify(sanitizedPayload),
        createdAt,
        record,
      });
    }

    const insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO web_events (id, session_id, user_id, type, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    let startedTx = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      startedTx = true;
    } catch (_txErr: unknown) {
      // Already in active transaction
    }

    try {
      for (const row of preparedRows) {
        insertStmt.run(row.id, row.sessionId, row.userId, row.type, row.payloadStr, row.createdAt);
        records.push(row.record);
      }
      if (startedTx) {
        this.db.exec('COMMIT');
      }
    } catch (err: unknown) {
      if (startedTx) {
        try {
          this.db.exec('ROLLBACK');
        } catch (rbErr: unknown) {
          throw new AggregateError([err, rbErr], 'Failed to rollback transaction during insertEventsBatch');
        }
      }
      throw err;
    }

    return records;
  }

  /**
   * Polls events for a session after a given opaque cursor.
   * Supports keyset pagination via opaque cursor (created_at, id).
   */
  async pollEvents(
    userId: string,
    sessionId: string,
    options: { after?: string; cursor?: string; limit?: number } | string = {}
  ): Promise<{ events: WebEventRecord[]; hasMore: boolean; nextCursor?: string | null }> {
    if (typeof userId !== 'string' || userId.length === 0 || userId.length > 128) {
      throw new ValidationError('Invalid userId format');
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 128) {
      throw new ValidationError('Invalid sessionId format');
    }

    const rawCursor = typeof options === 'string' ? options : (options.cursor ?? options.after);
    const limitNum = typeof options === 'object' && typeof options.limit === 'number' && Number.isInteger(options.limit)
      ? options.limit
      : 50;
    const limit = Math.min(Math.max(limitNum, 1), 100);

    let query = `
      SELECT id, session_id, user_id, type, payload, created_at
      FROM web_events
      WHERE session_id = ? AND user_id = ?
    `;
    const params: (string | number)[] = [sessionId, userId];

    if (rawCursor) {
      const decoded = decodeAndValidateCursor(this.db, rawCursor, 'event', userId, sessionId);
      query += ` AND (created_at > ? OR (created_at = ? AND id > ?))`;
      params.push(decoded.createdAt, decoded.createdAt, decoded.id);
    }

    query += ` ORDER BY created_at ASC, id ASC LIMIT ?`;
    params.push(limit + 1);

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as unknown as WebEventRow[];

    const hasMore = rows.length > limit;
    const selectedRows = rows.slice(0, limit);

    const events: WebEventRecord[] = [];
    for (const r of selectedRows) {
      if (
        typeof r.id !== 'string' ||
        typeof r.type !== 'string' ||
        typeof r.payload !== 'string' ||
        typeof r.created_at !== 'string' ||
        !isValidIsoDate(r.created_at)
      ) {
        throw new PlatformError('Corrupted web_events row in database', 'DATABASE_CORRUPTED', 500);
      }

      let parsedPayload: Record<string, unknown>;
      try {
        const json = JSON.parse(r.payload);
        if (!isRecord(json)) {
          throw new Error('Not an object');
        }
        parsedPayload = json;
      } catch {
        throw new PlatformError('Corrupted payload JSON in web_events', 'DATABASE_CORRUPTED', 500);
      }

      let record: WebEventRecord;
      switch (r.type) {
        case 'message': {
          const rawMsg = parsedPayload['message'] && isRecord(parsedPayload['message']) ? parsedPayload['message'] : parsedPayload;
          const msgRole = rawMsg['role'];
          if (msgRole !== 'user' && msgRole !== 'assistant' && msgRole !== 'system') {
            throw new PlatformError('Corrupted message event: invalid role', 'DATABASE_CORRUPTED', 500);
          }
          const msgStatus = rawMsg['status'];
          const validStatus = (msgStatus === 'pending' || msgStatus === 'delivered' || msgStatus === 'failed') ? msgStatus : 'delivered';
          const msgRecord: WebMessageRecord = {
            id: typeof rawMsg['id'] === 'string' ? rawMsg['id'] : r.id,
            role: msgRole,
            content: typeof rawMsg['content'] === 'string' ? rawMsg['content'] : '',
            status: validStatus,
            createdAt: typeof rawMsg['createdAt'] === 'string' ? rawMsg['createdAt'] : r.created_at,
          };
          record = {
            id: r.id,
            type: 'message',
            payload: { message: msgRecord },
            createdAt: r.created_at,
          };
          break;
        }
        case 'assistant_delta': {
          const streamId = typeof parsedPayload['streamId'] === 'string' ? parsedPayload['streamId'] : r.id;
          const delta = typeof parsedPayload['delta'] === 'string' ? parsedPayload['delta'] : '';
          const accumulatedLength = typeof parsedPayload['accumulatedLength'] === 'number' && Number.isFinite(parsedPayload['accumulatedLength'])
            ? parsedPayload['accumulatedLength']
            : delta.length;
          record = {
            id: r.id,
            type: 'assistant_delta',
            payload: { streamId, delta, accumulatedLength },
            createdAt: r.created_at,
          };
          break;
        }
        case 'assistant_stream_end': {
          const streamId = typeof parsedPayload['streamId'] === 'string' ? parsedPayload['streamId'] : r.id;
          record = {
            id: r.id,
            type: 'assistant_stream_end',
            payload: { streamId },
            createdAt: r.created_at,
          };
          break;
        }
        case 'thinking': {
          const streamId = typeof parsedPayload['streamId'] === 'string' ? parsedPayload['streamId'] : undefined;
          record = {
            id: r.id,
            type: 'thinking',
            payload: {
              status: 'thinking',
              ...(streamId ? { streamId } : {}),
            },
            createdAt: r.created_at,
          };
          break;
        }
        case 'tool_status': {
          const rawToolName = parsedPayload['toolName'] ?? parsedPayload['name'];
          const toolName = sanitizeToolName(rawToolName);
          const rawStatus = parsedPayload['status'];
          const status = (rawStatus === 'started' || rawStatus === 'completed' || rawStatus === 'failed') ? rawStatus : 'started';
          record = {
            id: r.id,
            type: 'tool_status',
            payload: { toolName, status },
            createdAt: r.created_at,
          };
          break;
        }
        case 'turn_status':
        case 'turn_failed':
        case 'turn_cancelled':
        case 'status_update': {
          record = {
            id: r.id,
            type: r.type,
            payload: parsedPayload as WebStatusEventPayload,
            createdAt: r.created_at,
          };
          break;
        }
        case 'error': {
          const code = typeof parsedPayload['code'] === 'string' ? parsedPayload['code'] : 'INTERNAL_ERROR';
          record = {
            id: r.id,
            type: 'error',
            payload: {
              ...parsedPayload,
              code,
            },
            createdAt: r.created_at,
          };
          break;
        }
        default:
          throw new PlatformError(`Corrupted web_events row: unknown type ${r.type}`, 'DATABASE_CORRUPTED', 500);
      }

      events.push(record);
    }

    let nextCursor: string | null = null;
    if (events.length > 0) {
      const lastEvent = events[events.length - 1];
      nextCursor = encodeOpaqueCursor({
        v: 1,
        kind: 'event',
        id: lastEvent.id,
        createdAt: lastEvent.createdAt,
      });
    } else if (rawCursor) {
      nextCursor = rawCursor;
    }

    return {
      events,
      hasMore,
      nextCursor: nextCursor ?? undefined,
    };
  }
}
