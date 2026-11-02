/**
 * Read-only access to persisted DSH session history for the daemon's `readSessionEvents` and
 * `readAttachment` ops.
 *
 * Guarantees:
 * - Reads go through DSH's `SessionPersistence` service with `open(id, 'read')`: a read handle
 *   never takes write ownership or the per-session `session.lock`, works while another handle or
 *   process writes the session, and never publishes a format migration. Nothing here activates
 *   or resumes an Agent, flushes a session, or writes a file (attachments are read through the
 *   attachment store's `readImage`, which only verifies and caches bytes in memory).
 * - Events come back exactly as stored: original DSH seqs, no renumbering, no copies altered.
 *
 * Cost: the JSONL backend has no ranged read. `handle.read()` decodes the whole current log file
 * (zstd frames + JSON) and slices; the backend memoizes the last decoded logs per file revision
 * (2 entries), so paging an unchanged log re-uses that decode, while a session that is still
 * appending re-decodes on each read. Each read also lists the persistence root's project
 * directories to locate the session. Pages are then selected in memory.
 *
 * @module @enkeep/runtime-runner/runtime/session-history
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import {
  DAEMON_ERROR_CODES,
  MAX_JSON_DEPTH,
  READ_ATTACHMENT_MAX_BYTES,
  READ_ATTACHMENT_MAX_CHUNK_BYTES,
  READ_SESSION_EVENTS_DEFAULT_LIMIT,
  READ_SESSION_EVENTS_DEFAULT_MAX_BYTES,
  READ_SESSION_EVENTS_MAX_BYTES_CAP,
  READ_SESSION_EVENTS_MAX_LIMIT,
  SESSION_HISTORY_ERROR_CODES,
  validateJsonDepth,
  type OmittedSessionEvent,
  type ReadAttachmentChunk,
  type ReadAttachmentChunkParams,
  type ReadSessionEventsParams,
  type ReadSessionEventsResult,
} from './daemon-protocol.js';
import { detectImageInfo } from './workspace-attachments.js';

// ---------------------------------------------------------------------------
// Structural views of the DSH services used (kept minimal so tests can supply fakes)
// ---------------------------------------------------------------------------

/** The subset of a DSH `SessionHeader` this module reads. */
export interface SessionHistoryHeader {
  readonly id: string;
  readonly cwd?: string;
}

/** The subset of a read-only DSH `SessionHandle` this module uses. */
export interface SessionHistoryReadHandle {
  read(offset?: number, length?: number): Promise<{ readonly events: readonly SessionEvent[] }>;
  close(): Promise<void>;
}

/** The subset of DSH `SessionPersistence` (`ctx.sessionPersistence`) this module uses. */
export interface SessionHistoryPersistence {
  stat(id: SessionId): Promise<{ readonly header: SessionHistoryHeader } | undefined>;
  open(id: SessionId, access: 'read'): Promise<SessionHistoryReadHandle>;
}

/** The subset of a live DSH `Session` this module uses (unflushed tail only). */
export interface SessionHistoryLiveSession {
  readonly seq: number;
  snapshotEvents(fromSeq?: number, toSeqExclusive?: number): readonly SessionEvent[];
}

/** The subset of DSH `SessionStore` (`ctx.sessions`) this module uses: live lookup only. */
export interface SessionHistoryLiveStore {
  get(id: SessionId): SessionHistoryLiveSession | undefined;
}

/** A DSH image attachment reference as it appears in an `image` content block. */
export interface SessionImageRef {
  readonly attachmentId: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly name?: string;
}

/** The subset of DSH `AttachmentStore` (`ctx.attachments`) this module uses. */
export interface SessionHistoryAttachmentStore {
  readImage(ref: any, signal?: AbortSignal): Promise<{ readonly data: Uint8Array }>;
}

export interface SessionHistoryDeps {
  readonly persistence: SessionHistoryPersistence | undefined;
  /** When present, unflushed events of live sessions can be included. */
  readonly sessions?: SessionHistoryLiveStore;
  readonly attachments?: SessionHistoryAttachmentStore;
  /** Root of the user's spaces; path attachments must resolve inside it. */
  readonly spacesDir?: string;
}

/** A failure with a stable wire code (see {@link SESSION_HISTORY_ERROR_CODES}). */
export class SessionHistoryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SessionHistoryError';
    this.code = code;
  }
}

function invalid(message: string): SessionHistoryError {
  return new SessionHistoryError(DAEMON_ERROR_CODES.INVALID_PARAMETERS, message);
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ATTACHMENT_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_PATH_LENGTH = 4096;

function requireSessionId(value: unknown): string {
  if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) {
    throw invalid('"sessionId" must be a DSH session id');
  }
  return value;
}

function optionalInteger(value: unknown, name: string, min: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw invalid(`"${name}" must be an integer >= ${min}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Log loading
// ---------------------------------------------------------------------------

interface LoadedSessionLog {
  readonly header: SessionHistoryHeader;
  /** Persisted events followed by the unflushed tail (if requested), ascending, contiguous. */
  readonly events: readonly SessionEvent[];
  readonly persistedCount: number;
}

function isNotFoundError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'SessionPersistenceNotFoundError';
}

/**
 * Read one session's log through DSH persistence (read handle only) and, optionally, append the
 * events a live in-memory session committed past the persisted end.
 */
async function loadSessionLog(
  deps: SessionHistoryDeps,
  sessionId: string,
  includeUnflushed: boolean
): Promise<LoadedSessionLog> {
  const persistence = deps.persistence;
  if (!persistence || typeof persistence.stat !== 'function' || typeof persistence.open !== 'function') {
    throw new SessionHistoryError(DAEMON_ERROR_CODES.INTERNAL_ERROR, 'Session persistence is not available');
  }
  const sid = SessionId(sessionId);

  let snapshot: { readonly header: SessionHistoryHeader } | undefined;
  try {
    snapshot = await persistence.stat(sid);
  } catch (err: unknown) {
    if (isNotFoundError(err)) snapshot = undefined;
    else throw new SessionHistoryError(SESSION_HISTORY_ERROR_CODES.SESSION_UNREADABLE, 'Session log could not be read');
  }
  if (!snapshot) {
    throw new SessionHistoryError(SESSION_HISTORY_ERROR_CODES.SESSION_NOT_FOUND, 'Session not found');
  }

  let persisted: readonly SessionEvent[];
  try {
    const handle = await persistence.open(sid, 'read');
    try {
      persisted = (await handle.read()).events;
    } finally {
      await handle.close().catch(() => {});
    }
  } catch (err: unknown) {
    if (isNotFoundError(err)) {
      throw new SessionHistoryError(SESSION_HISTORY_ERROR_CODES.SESSION_NOT_FOUND, 'Session not found');
    }
    throw new SessionHistoryError(SESSION_HISTORY_ERROR_CODES.SESSION_UNREADABLE, 'Session log could not be read');
  }

  let events: readonly SessionEvent[] = persisted;
  if (includeUnflushed && deps.sessions && typeof deps.sessions.get === 'function') {
    const tail = readUnflushedTail(deps.sessions, sid, persisted.length);
    if (tail.length > 0) events = persisted.concat(tail);
  }

  return { header: snapshot.header, events, persistedCount: persisted.length };
}

/**
 * Events a live session holds in memory beyond `persistedCount` (the JSONL write-behind window).
 * Pure in-memory read: no flush, no agent activation. Any inconsistency yields no tail.
 */
function readUnflushedTail(
  sessions: SessionHistoryLiveStore,
  sid: SessionId,
  persistedCount: number
): readonly SessionEvent[] {
  try {
    const live = sessions.get(sid);
    if (!live || typeof live.snapshotEvents !== 'function') return [];
    const liveCount = Number(live.seq);
    if (!Number.isSafeInteger(liveCount) || liveCount <= persistedCount) return [];
    const tail = live.snapshotEvents(persistedCount, liveCount);
    for (let i = 0; i < tail.length; i++) {
      if (tail[i]?.seq !== persistedCount + i) return [];
    }
    return tail;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// readSessionEvents
// ---------------------------------------------------------------------------

/** Index of the first event with seq > `seq` (events ascending by seq). */
function firstIndexAfter(events: readonly SessionEvent[], seq: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (events[mid]!.seq > seq) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Index of the first event with seq >= `seq`. */
function firstIndexAtOrAfter(events: readonly SessionEvent[], seq: number): number {
  return firstIndexAfter(events, seq - 1);
}

/** Serialized size of one event inside the response array, or why it can never be sent. */
function measureEvent(event: SessionEvent): { bytes: number; reason?: OmittedSessionEvent['reason'] } {
  try {
    // Response envelope → events array → event: the event sits at depth 2 of the frame.
    validateJsonDepth(event, 2, MAX_JSON_DEPTH);
  } catch {
    return { bytes: 0, reason: 'too-deep' };
  }
  const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8') + 1; // + array separator
  if (bytes > READ_SESSION_EVENTS_MAX_BYTES_CAP) return { bytes, reason: 'too-large' };
  return { bytes };
}

/**
 * Select one page of a session log. See {@link ReadSessionEventsParams} for the paging contract.
 */
export function selectSessionEventsPage(
  events: readonly SessionEvent[],
  options: { afterSeq?: number; beforeSeq?: number; limit: number; maxBytes: number }
): { events: SessionEvent[]; hasMore: boolean; omitted: OmittedSessionEvent[] } {
  const { afterSeq, beforeSeq, limit, maxBytes } = options;
  const page: SessionEvent[] = [];
  const omitted: OmittedSessionEvent[] = [];
  let used = 0;

  // Returns false when the page is full (byte budget) and `event` was not taken. The first
  // takeable event is always taken, so paging progresses even past an event above `maxBytes`.
  const take = (event: SessionEvent): boolean => {
    const measured = measureEvent(event);
    if (measured.reason) {
      omitted.push({ seq: event.seq, type: String(event.type), bytes: measured.bytes, reason: measured.reason });
      return true;
    }
    if (page.length > 0 && used + measured.bytes > maxBytes) return false;
    used += measured.bytes;
    page.push(event);
    return true;
  };

  if (afterSeq !== undefined) {
    const start = firstIndexAfter(events, afterSeq);
    const end = beforeSeq !== undefined ? firstIndexAtOrAfter(events, beforeSeq) : events.length;
    let i = start;
    while (i < end && i - start < limit) {
      if (!take(events[i]!)) break;
      i++;
    }
    return { events: page, hasMore: i < end, omitted };
  }

  // Newest first while budgeting (so the newest events win), then back to ascending order.
  const end = beforeSeq !== undefined ? firstIndexAtOrAfter(events, beforeSeq) : events.length;
  let i = end - 1;
  while (i >= 0 && end - 1 - i < limit) {
    if (!take(events[i]!)) break;
    i--;
  }
  page.reverse();
  omitted.reverse();
  return { events: page, hasMore: i >= 0, omitted };
}

/**
 * One page of a DSH session log, read-only (see module docs for guarantees and cost).
 * @throws SessionHistoryError with code `session/not-found`, `session/unreadable` or `INVALID_PARAMETERS`.
 */
export async function readSessionEventsPage(
  deps: SessionHistoryDeps,
  params: ReadSessionEventsParams
): Promise<ReadSessionEventsResult> {
  const sessionId = requireSessionId(params?.sessionId);
  const afterSeq = optionalInteger(params.afterSeq, 'afterSeq', -1);
  const beforeSeq = optionalInteger(params.beforeSeq, 'beforeSeq', 0);
  const rawLimit = optionalInteger(params.limit, 'limit', 1);
  const rawMaxBytes = optionalInteger(params.maxBytes, 'maxBytes', 1);
  if (params.includeUnflushed !== undefined && typeof params.includeUnflushed !== 'boolean') {
    throw invalid('"includeUnflushed" must be a boolean');
  }
  const limit = Math.min(rawLimit ?? READ_SESSION_EVENTS_DEFAULT_LIMIT, READ_SESSION_EVENTS_MAX_LIMIT);
  const maxBytes = Math.min(rawMaxBytes ?? READ_SESSION_EVENTS_DEFAULT_MAX_BYTES, READ_SESSION_EVENTS_MAX_BYTES_CAP);

  const log = await loadSessionLog(deps, sessionId, params.includeUnflushed !== false);
  const all = log.events;
  const page = selectSessionEventsPage(all, { afterSeq, beforeSeq, limit, maxBytes });

  const lastSeq = all.length > 0 ? all[all.length - 1]!.seq : -1;
  const persistedLastSeq = log.persistedCount > 0 ? all[log.persistedCount - 1]!.seq : -1;
  return {
    dshSessionId: String(log.header?.id ?? sessionId),
    events: page.events,
    lastSeq,
    persistedLastSeq,
    hasMore: page.hasMore,
    ...(page.omitted.length > 0 ? { omitted: page.omitted } : {}),
  };
}

// ---------------------------------------------------------------------------
// readAttachment
// ---------------------------------------------------------------------------

function isImageRefCandidate(value: unknown): value is { type: 'image'; attachment: SessionImageRef } {
  if (!value || typeof value !== 'object') return false;
  const v = value as { type?: unknown; attachment?: { attachmentId?: unknown } };
  return v.type === 'image' && !!v.attachment && typeof v.attachment.attachmentId === 'string';
}

/** Find the image reference with `attachmentId` cited anywhere in the events (newest first). */
export function findImageRef(events: readonly SessionEvent[], attachmentId: string): SessionImageRef | undefined {
  for (let e = events.length - 1; e >= 0; e--) {
    const stack: Array<{ value: unknown; depth: number }> = [{ value: events[e], depth: 0 }];
    while (stack.length > 0) {
      const { value, depth } = stack.pop()!;
      if (!value || typeof value !== 'object' || depth > MAX_JSON_DEPTH) continue;
      if (isImageRefCandidate(value) && value.attachment.attachmentId === attachmentId) {
        return value.attachment;
      }
      const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
      for (const child of children) {
        if (child && typeof child === 'object') stack.push({ value: child, depth: depth + 1 });
      }
    }
  }
  return undefined;
}

/** Whether any event's serialized form contains one of `texts` (as a JSON string fragment). */
function eventsCiteAny(events: readonly SessionEvent[], texts: Iterable<string>): boolean {
  const needles = [...texts].filter(Boolean).map((t) => JSON.stringify(t).slice(1, -1)).filter(Boolean);
  if (needles.length === 0) return false;
  for (let e = events.length - 1; e >= 0; e--) {
    const serialized = JSON.stringify(events[e]);
    if (needles.some((needle) => serialized.includes(needle))) return true;
  }
  return false;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function notFound(message = 'Attachment not found'): SessionHistoryError {
  return new SessionHistoryError(SESSION_HISTORY_ERROR_CODES.ATTACHMENT_NOT_FOUND, message);
}

function tooLarge(): SessionHistoryError {
  return new SessionHistoryError(
    SESSION_HISTORY_ERROR_CODES.ATTACHMENT_TOO_LARGE,
    `Attachment exceeds ${READ_ATTACHMENT_MAX_BYTES} bytes`
  );
}

interface LoadedImage {
  readonly data: Buffer;
  readonly mime: string;
  readonly width?: number;
  readonly height?: number;
  readonly name?: string;
}

async function loadImageById(
  deps: SessionHistoryDeps,
  events: readonly SessionEvent[],
  attachmentId: string
): Promise<LoadedImage> {
  if (!ATTACHMENT_ID_PATTERN.test(attachmentId)) {
    throw invalid('"attachmentId" must be a DSH image attachment id (sha256:<64 hex>)');
  }
  const ref = findImageRef(events, attachmentId);
  if (!ref) throw notFound();
  if (typeof ref.bytes === 'number' && ref.bytes > READ_ATTACHMENT_MAX_BYTES) throw tooLarge();
  const store = deps.attachments;
  if (!store || typeof store.readImage !== 'function') throw notFound('Attachment store is not available');

  let data: Uint8Array;
  try {
    data = (await store.readImage(ref)).data;
  } catch (err: unknown) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === 'ATTACHMENT_NOT_FOUND' || code === 'INVALID_ATTACHMENT_REF') throw notFound();
    throw new SessionHistoryError(SESSION_HISTORY_ERROR_CODES.ATTACHMENT_UNREADABLE, 'Attachment could not be read');
  }
  if (data.byteLength > READ_ATTACHMENT_MAX_BYTES) throw tooLarge();
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return {
    data: buf,
    mime: String(ref.mediaType),
    width: typeof ref.width === 'number' ? ref.width : undefined,
    height: typeof ref.height === 'number' ? ref.height : undefined,
    name: typeof ref.name === 'string' ? ref.name : undefined,
  };
}

async function loadImageByPath(
  deps: SessionHistoryDeps,
  header: SessionHistoryHeader,
  events: readonly SessionEvent[],
  rawPath: string
): Promise<LoadedImage> {
  if (rawPath.length === 0 || rawPath.length > MAX_PATH_LENGTH || rawPath.includes('\0')) {
    throw invalid('"path" must be a non-empty file path');
  }
  const cwd = header?.cwd;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw notFound();

  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await fs.promises.realpath(cwd);
    realTarget = await fs.promises.realpath(path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath));
  } catch {
    throw notFound();
  }
  // The file must live in the session's working directory (its space), itself inside spacesDir.
  if (!isInside(realTarget, realRoot)) throw notFound();
  if (deps.spacesDir) {
    let realSpaces: string;
    try {
      realSpaces = await fs.promises.realpath(deps.spacesDir);
    } catch {
      throw notFound();
    }
    if (!isInside(realRoot, realSpaces)) throw notFound();
  }
  // ...and the session's own events must cite it (as given, cwd-relative, or absolute).
  const absolute = path.resolve(cwd, rawPath);
  if (!eventsCiteAny(events, new Set([rawPath, path.relative(cwd, absolute), absolute]))) throw notFound();

  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(realTarget, fs.constants.O_RDONLY);
  } catch {
    throw notFound();
  }
  let data: Buffer;
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw notFound();
    if (st.size > READ_ATTACHMENT_MAX_BYTES) throw tooLarge();
    data = await handle.readFile();
  } finally {
    await handle.close().catch(() => {});
  }
  if (data.byteLength > READ_ATTACHMENT_MAX_BYTES) throw tooLarge();
  const info = data.byteLength > 0 ? detectImageInfo(data) : null;
  if (!info) {
    throw new SessionHistoryError(SESSION_HISTORY_ERROR_CODES.ATTACHMENT_NOT_IMAGE, 'Attachment is not a supported image');
  }
  return { data, mime: info.mediaType, width: info.width, height: info.height, name: path.basename(realTarget) };
}

/**
 * One chunk of an image cited by a session's events, read-only.
 * @throws SessionHistoryError with code `session/not-found`, `attachment/not-found`,
 *   `attachment/too-large`, `attachment/not-image`, `attachment/unreadable` or `INVALID_PARAMETERS`.
 */
export async function readSessionAttachmentChunk(
  deps: SessionHistoryDeps,
  params: ReadAttachmentChunkParams
): Promise<ReadAttachmentChunk> {
  const sessionId = requireSessionId(params?.sessionId);
  const hasId = params.attachmentId !== undefined && params.attachmentId !== null;
  const hasPath = params.path !== undefined && params.path !== null;
  if (hasId === hasPath) throw invalid('Exactly one of "attachmentId" or "path" is required');
  if (hasId && typeof params.attachmentId !== 'string') throw invalid('"attachmentId" must be a string');
  if (hasPath && typeof params.path !== 'string') throw invalid('"path" must be a string');
  const offset = optionalInteger(params.offset, 'offset', 0) ?? 0;
  const maxChunk = Math.min(
    optionalInteger(params.maxChunkBytes, 'maxChunkBytes', 1) ?? READ_ATTACHMENT_MAX_CHUNK_BYTES,
    READ_ATTACHMENT_MAX_CHUNK_BYTES
  );

  const log = await loadSessionLog(deps, sessionId, true);
  const image = hasId
    ? await loadImageById(deps, log.events, params.attachmentId as string)
    : await loadImageByPath(deps, log.header, log.events, params.path as string);

  const total = image.data.byteLength;
  if (offset > 0 && offset >= total) throw invalid('"offset" is past the end of the attachment');
  const chunk = image.data.subarray(offset, Math.min(total, offset + maxChunk));
  const sha256 = createHash('sha256').update(image.data).digest('hex');
  return {
    mime: image.mime,
    bytes: total,
    offset,
    chunkBytes: chunk.byteLength,
    data: chunk.toString('base64'),
    done: offset + chunk.byteLength >= total,
    sha256,
    ...(image.width !== undefined ? { width: image.width } : {}),
    ...(image.height !== undefined ? { height: image.height } : {}),
    ...(image.name !== undefined ? { name: image.name } : {}),
  };
}
