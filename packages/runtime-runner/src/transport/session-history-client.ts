/**
 * Host-side helpers for DSH-native session history: typed subscriptions to the daemon's
 * `turn/event` / `turn/chunk` pushes and the `readSessionEvents` / `readAttachment` ops.
 * Shared by the Docker daemon transport and the host-mode UDS transport.
 *
 * The daemon broadcasts pushes to the connected bridge only, without replay: after a
 * (re)connect (`'connected'` on the transport), resynchronize with
 * `readSessionEvents({ sessionId, afterSeq: <last seq seen> })`.
 *
 * @module @enkeep/runtime-runner/transport/session-history-client
 */

import crypto from 'node:crypto';
import type { EventEmitter } from 'node:events';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import {
  DAEMON_OPS,
  DAEMON_STREAM_EVENTS,
  DaemonProtocolError,
  READ_ATTACHMENT_MAX_BYTES,
  SESSION_HISTORY_ERROR_CODES,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonStreamEvent,
  type ReadAttachmentParams,
  type ReadAttachmentRequest,
  type ReadAttachmentResponse,
  type ReadAttachmentResult,
  type ReadSessionEventsParams,
  type ReadSessionEventsRequest,
  type ReadSessionEventsResponse,
  type ReadSessionEventsResult,
} from '../runtime/daemon-protocol.js';

/** A DSH session event pushed live by a user's runtime (`turn/event`). */
export interface HostSessionEvent {
  /** The runtime owner, when the transport knows it. */
  readonly userId?: string;
  /** DSH session id (may be a subagent/workflow child session). */
  readonly sessionId: string;
  /** Original DSH seq (from 0). */
  readonly seq: number;
  /** Push time (ms epoch); the event's own commit time is `sessionEvent.time`. */
  readonly timestamp: number;
  /** The submitted turn it belongs to; absent for autonomous/background turns. */
  readonly turnId?: string;
  readonly sessionEvent: SessionEvent;
}

/** A live model output delta pushed by a user's runtime (`turn/chunk`). */
export interface HostTurnChunk {
  readonly userId?: string;
  /** DSH session id. */
  readonly sessionId: string;
  readonly timestamp: number;
  /** The submitted turn it belongs to; absent for autonomous turns. */
  readonly turnId?: string;
  /** DSH assistant stream chunk, e.g. `{ type: 'text-delta', index, text }`, `reasoning-delta`, `tool-call-delta`. */
  readonly chunk: { readonly type: string; readonly text?: string; readonly [key: string]: unknown };
}

export type HostSessionEventListener = (event: HostSessionEvent) => void;
export type HostTurnChunkListener = (chunk: HostTurnChunk) => void;

/** The request function of a daemon transport (rejects on `ok: false` with the daemon's error code). */
export type DaemonRequestFn = (req: DaemonRequest, timeoutMs?: number) => Promise<DaemonResponse>;

function safeCall<T>(listener: (value: T) => void, value: T): void {
  try {
    listener(value);
  } catch {
    // A failing subscriber must not break the transport's stream dispatch.
  }
}

/** Subscribe to `turn/event` pushes on a transport's `'stream'`; returns the unsubscribe function. */
export function subscribeSessionEvents(
  emitter: EventEmitter,
  userId: string | undefined,
  listener: HostSessionEventListener
): () => void {
  const onStream = (event: DaemonStreamEvent) => {
    if (!event || event.event !== DAEMON_STREAM_EVENTS.TURN_EVENT) return;
    const sessionEvent = event.sessionEvent;
    if (!sessionEvent || typeof event.sessionId !== 'string' || !event.sessionId) return;
    const seq = typeof event.seq === 'number' ? event.seq : sessionEvent.seq;
    if (typeof seq !== 'number') return;
    safeCall(listener, {
      ...(userId ? { userId } : {}),
      sessionId: event.sessionId,
      seq,
      timestamp: typeof event.timestamp === 'number' ? event.timestamp : Date.now(),
      ...(event.turnId ? { turnId: event.turnId } : {}),
      sessionEvent,
    });
  };
  emitter.on('stream', onStream);
  return () => {
    emitter.removeListener('stream', onStream);
  };
}

/** Subscribe to `turn/chunk` pushes on a transport's `'stream'`; returns the unsubscribe function. */
export function subscribeTurnChunks(
  emitter: EventEmitter,
  userId: string | undefined,
  listener: HostTurnChunkListener
): () => void {
  const onStream = (event: DaemonStreamEvent) => {
    if (!event || event.event !== DAEMON_STREAM_EVENTS.TURN_CHUNK) return;
    if (!event.chunk || typeof event.sessionId !== 'string' || !event.sessionId) return;
    safeCall(listener, {
      ...(userId ? { userId } : {}),
      sessionId: event.sessionId,
      timestamp: typeof event.timestamp === 'number' ? event.timestamp : Date.now(),
      ...(event.turnId ? { turnId: event.turnId } : {}),
      chunk: event.chunk as HostTurnChunk['chunk'],
    });
  };
  emitter.on('stream', onStream);
  return () => {
    emitter.removeListener('stream', onStream);
  };
}

function newRequestId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

/** Run `readSessionEvents` and strip the envelope. Daemon errors reject with their `code`. */
export async function readSessionEventsVia(
  request: DaemonRequestFn,
  params: ReadSessionEventsParams,
  timeoutMs?: number
): Promise<ReadSessionEventsResult> {
  const req: ReadSessionEventsRequest = {
    id: newRequestId('read_events'),
    op: DAEMON_OPS.READ_SESSION_EVENTS,
    sessionId: params.sessionId,
    ...(params.afterSeq !== undefined ? { afterSeq: params.afterSeq } : {}),
    ...(params.beforeSeq !== undefined ? { beforeSeq: params.beforeSeq } : {}),
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
    ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
    ...(params.includeUnflushed !== undefined ? { includeUnflushed: params.includeUnflushed } : {}),
  };
  const res = (await request(req, timeoutMs)) as ReadSessionEventsResponse;
  return {
    dshSessionId: res.dshSessionId,
    events: Array.isArray(res.events) ? res.events : [],
    lastSeq: res.lastSeq,
    persistedLastSeq: res.persistedLastSeq,
    hasMore: Boolean(res.hasMore),
    ...(res.omitted && res.omitted.length > 0 ? { omitted: res.omitted } : {}),
  };
}

function unreadable(message: string): DaemonProtocolError {
  return new DaemonProtocolError(SESSION_HISTORY_ERROR_CODES.ATTACHMENT_UNREADABLE, message);
}

/**
 * Read a whole image attachment through `readAttachment` chunks (each frame stays under the
 * 10 MiB limit), verifying offsets, size and sha256 across chunks.
 */
export async function readAttachmentVia(
  request: DaemonRequestFn,
  params: ReadAttachmentParams,
  timeoutMs?: number
): Promise<ReadAttachmentResult> {
  const parts: Buffer[] = [];
  let offset = 0;
  let first: ReadAttachmentResponse | undefined;
  // 20 MiB at 6 MiB per chunk needs 4 chunks; the bound only stops a misbehaving daemon.
  for (let i = 0; i < 16; i++) {
    const req: ReadAttachmentRequest = {
      id: newRequestId('read_attachment'),
      op: DAEMON_OPS.READ_ATTACHMENT,
      sessionId: params.sessionId,
      ...(params.attachmentId !== undefined ? { attachmentId: params.attachmentId } : {}),
      ...(params.path !== undefined ? { path: params.path } : {}),
      offset,
    };
    const res = (await request(req, timeoutMs)) as ReadAttachmentResponse;
    if (!first) {
      first = res;
      if (typeof res.bytes !== 'number' || res.bytes > READ_ATTACHMENT_MAX_BYTES) {
        throw new DaemonProtocolError(SESSION_HISTORY_ERROR_CODES.ATTACHMENT_TOO_LARGE, 'Attachment is too large');
      }
    } else if (res.sha256 !== first.sha256 || res.bytes !== first.bytes || res.mime !== first.mime) {
      throw unreadable('Attachment changed while it was being read');
    }
    if (res.offset !== offset) throw unreadable('Attachment chunk out of order');
    const chunk = Buffer.from(typeof res.data === 'string' ? res.data : '', 'base64');
    if (chunk.byteLength !== res.chunkBytes) throw unreadable('Attachment chunk is truncated');
    parts.push(chunk);
    offset += chunk.byteLength;
    if (res.done) break;
    if (chunk.byteLength === 0) throw unreadable('Attachment read made no progress');
  }
  if (!first) throw unreadable('Attachment read returned nothing');
  const data = Buffer.concat(parts);
  if (data.byteLength !== first.bytes) throw unreadable('Attachment is incomplete');
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  if (sha256 !== first.sha256) throw unreadable('Attachment failed integrity verification');
  return {
    mime: first.mime,
    data: data.toString('base64'),
    bytes: first.bytes,
    sha256,
    ...(first.width !== undefined ? { width: first.width } : {}),
    ...(first.height !== undefined ? { height: first.height } : {}),
    ...(first.name !== undefined ? { name: first.name } : {}),
  };
}
