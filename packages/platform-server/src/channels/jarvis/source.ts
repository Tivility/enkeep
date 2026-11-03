/**
 * The platform side of the Jarvis channel for ONE connection: a {@link JarvisChannelSource} scoped
 * to the user who owns the Jarvis channel account (docs/jarvis-channel.md §3.4–3.6).
 *
 * - Sessions are the user's active session routes (`ses_<hex>`); a route's DSH session id stays
 *   inside this module.
 * - History and images come from the user's runtime (`readSessionEvents` / `readAttachment`); live
 *   events and text deltas from the {@link RuntimeSessionEventHub}.
 * - Sends go through the delivery gateway like any channel (idempotency, queueing, quotas,
 *   `channel_turn_origins` with channel `jarvis`, so Lark/WeChat never reply to these turns).
 * - Approval cards come from the shared {@link ApprovalBridge}, question cards from the shared
 *   {@link QuestionBridge}; the first answer wins. An answer that arrives after its question
 *   expired is sent as the user's next message to the session.
 *
 * Every call is filtered by the connection's user id: a session id of another user is "not found".
 *
 * @module @enkeep/platform-server/channels/jarvis/source
 */

import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  RpcError,
  errorCode,
  type DshSessionEvent,
  type JarvisChannelSource,
  type JarvisLogger,
  type JarvisSessionRow,
  type JarvisSourceListener,
  type PendingApprovalCard,
  type PendingQuestionCard,
  type QuestionAnswers,
  type ReadEventsQuery,
  type ReadEventsResult,
} from '@enkeep/channel-jarvis';
import { PlatformError } from '@enkeep/platform-core';
import { formatLateQuestionAnswers } from '@enkeep/dsh-external-interaction/user-questions';
import type { InboundEnvelope, InboundEnvelopeAttachmentItem } from '@enkeep/web-channel';
import type { ApprovalBridge, BridgedApproval } from '../../interactions/approval-bridge.js';
import type { BridgedQuestion, QuestionBridge } from '../../interactions/question-bridge.js';
import type { HubSessionEvent, HubTurnChunk, RuntimeSessionEventHub } from '../../runtime/session-event-hub.js';
import type { RuntimeSessionReader } from '../../runtime/delivery-gateway.js';

/** Where container runtimes keep the spaces (`DSH_SPACES` inside the runtime image). */
export const DEFAULT_RUNTIME_SPACES_DIR = '/home/dsh/spaces';
export const JARVIS_LIST_MAX_SESSIONS = 80;
export const JARVIS_LIST_RECENT_MS = 7 * 24 * 60 * 60 * 1000;
export const JARVIS_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const JARVIS_LAST_TEXT_CHARS = 200;
export const JARVIS_START_TITLE_CHARS = 40;
/** Prefix of a refusal reason queued as the next message of the session. */
export const JARVIS_REJECT_REASON_PREFIX = '拒绝理由：';
export const JARVIS_SLASH_REFUSAL = 'Jarvis 里不能使用斜杠命令；停止、新建、改名请用对应的按钮。';
/** client_msg_id prefix of an answer delivered as a message because its question expired. */
export const JARVIS_LATE_ANSWER_MSG_PREFIX = 'question-late-';
const IMAGE_ONLY_CONTENT = '[图片]';
const SUPPORTED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']);
const TOOL_INPUT_LOOKUP_EVENTS = 200;
const TOOL_INPUT_LOOKUP_TIMEOUT_MS = 5_000;
const MAX_CACHED_CALLS_PER_SESSION = 64;
const MAX_CACHED_SESSIONS = 200;
const UNMAPPED_TTL_MS = 15_000;
const MAX_DELTA_CHARS = 256 * 1024;
const MAX_CACHED_REVS = 2000;

/** The idempotency key of a Jarvis send: `idem_jarvis_` + 32 hex of sha256(accountId:clientMsgId). */
export function jarvisIdempotencyKey(accountId: string, clientMsgId: string): string {
  return `idem_jarvis_${createHash('sha256').update(`${accountId}:${clientMsgId}`, 'utf8').digest('hex').slice(0, 32)}`;
}

/** What the source needs from the delivery gateway. */
export interface JarvisDeliveryPort {
  dispatchInbound(envelope: InboundEnvelope): Promise<{ turnId: string; isDuplicate: boolean }>;
  getCurrentTurnStatus(userId: string, sessionId: string): Promise<{ status: string } | null>;
  cancelCurrentTurn(userId: string, sessionId: string): Promise<boolean>;
}

/** The session operations the HTTP routes use (PlatformWebApi). */
export interface JarvisSessionApi {
  createSession(userId: string, input: { spaceId: string; title?: string | null; forceNew?: boolean }): Promise<{ id: string }>;
  updateSession(userId: string, sessionId: string, input: { title?: string | null }): Promise<unknown>;
  archiveSession(userId: string, sessionId: string): Promise<unknown>;
}

/** The image ingestor Lark and WeChat use (`TenantScopedLarkImageIngestor`). */
export interface JarvisImageIngestor {
  ingestImage(params: {
    userId: string;
    spaceId: string;
    messageId: string;
    fileKey: string;
    buffer: Buffer;
    contentType?: string;
  }): Promise<{ path: string; etag: string; mediaType: string; displayName: string }>;
}

export interface PlatformJarvisSourceOptions {
  userId: string;
  accountId: string;
  db: DatabaseSync;
  gateway: JarvisDeliveryPort;
  /** Session create/rename/archive; absent → those calls answer `unavailable`. */
  sessionApi?: JarvisSessionApi | (() => JarvisSessionApi | undefined);
  approvals?: ApprovalBridge;
  /** `ask_user_question` questions (cards); absent → answering a question is `unavailable`. */
  questions?: QuestionBridge;
  events?: RuntimeSessionEventHub;
  reader?: Partial<RuntimeSessionReader>;
  imageIngestor?: JarvisImageIngestor;
  /** The spaces directory as the runtime sees it. Defaults to {@link DEFAULT_RUNTIME_SPACES_DIR}. */
  runtimeSpacesDir?: (space: { userId: string; executionMode: string }) => string;
  /**
   * Checked before every listing and every request from the node; false → `onRevoked` and the call
   * fails with `unauthorized` (the account's token was rotated or revoked, possibly by another process).
   */
  isAuthorized?: () => boolean;
  onRevoked?: () => void;
  log?: JarvisLogger;
  now?: () => number;
}

interface RouteRow {
  id: string;
  title: string | null;
  space_id: string;
  dsh_session_id: string;
  status: string;
  updated_at: string | null;
  created_at: string | null;
  space_name: string | null;
  space_folder: string;
  space_mode: string | null;
  space_status: string | null;
}

interface SpaceRow {
  id: string;
  name: string | null;
  folder: string;
  execution_mode: string | null;
}

interface DeltaState {
  routeId: string;
  turnId?: string;
  text: string;
}

const ROUTE_SELECT = `
  SELECT r.id, r.title, r.space_id, r.dsh_session_id, r.status, r.updated_at, r.created_at,
         s.name AS space_name, s.folder AS space_folder, s.execution_mode AS space_mode, s.status AS space_status
  FROM session_routes r
  JOIN spaces s ON s.id = r.space_id AND s.user_id = r.user_id`;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Platform timestamps are ISO strings or SQLite `YYYY-MM-DD HH:MM:SS` (UTC). */
export function timestampMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const sqlite = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const ms = Date.parse(sqlite);
  return Number.isNaN(ms) ? undefined : ms;
}

function isActive(status: string | null | undefined): boolean {
  return status === undefined || status === null || status === 'active';
}

function truncateChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('') : text;
}

function decodeBase64(data: string): Buffer | null {
  let body = data.trim();
  const dataUrl = /^data:[^;,]*;base64,/i.exec(body);
  if (dataUrl) body = body.slice(dataUrl[0].length);
  body = body.replace(/\s+/g, '');
  if (body.length === 0 || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(body)) return null;
  return Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Map platform and runtime errors to rpc errors the node may see; others become generic. */
export function toJarvisRpcError(err: unknown): Error {
  if (err instanceof RpcError) return err;
  if (err instanceof PlatformError) {
    const message = err.message;
    if (err.status === 404) return new RpcError(message, 'not_found');
    if (err.status === 400) return new RpcError(message, 'invalid_params');
    if (err.status === 401 || err.status === 403) return new RpcError(message, 'forbidden');
    if (err.status === 413) return new RpcError(message, 'too_large');
    if (err.status === 429 || err.code === 'QUOTA_EXCEEDED') return new RpcError(message, 'quota_exceeded');
    if (err.status === 409) {
      if (err.code === 'SESSION_ARCHIVED' || err.code === 'SPACE_ARCHIVED') return new RpcError(message, 'not_found');
      if (err.code === 'RECOVERY_REQUIRED') return new RpcError(message, 'blocked');
      if (err.code === 'CONFLICT') return new RpcError(message, 'busy');
      return new RpcError(message, 'conflict');
    }
    if (err.status === 503) return new RpcError(message, 'unavailable');
    return new Error('internal error');
  }
  const code = errorCode(err);
  if (code === 'session/not-found' || code === 'attachment/not-found') return new RpcError('not found', 'not_found');
  if (code === 'attachment/too-large') return new RpcError('image too large', 'too_large');
  if (code === 'attachment/not-image') return new RpcError('not an image', 'invalid_params');
  // Anything else may carry internals: a plain error makes the engine answer `internal`.
  return new Error('internal error');
}

/** Tool calls (`{id, name, arguments}`) of an `assistant/message` event. */
export function toolCallsOf(event: DshSessionEvent): Array<{ id: string; name: string; input: Record<string, unknown> }> {
  if (event.type !== 'assistant/message') return [];
  const message = asRecord(asRecord(event.data)?.message);
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  const calls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  for (const raw of content) {
    const block = asRecord(raw);
    if (!block || block.type !== 'tool-call' || typeof block.id !== 'string') continue;
    let args: unknown = block.arguments ?? block.input;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = { input: args };
      }
    }
    calls.push({ id: block.id, name: typeof block.name === 'string' ? block.name : 'unknown', input: asRecord(args) ?? {} });
  }
  return calls;
}

export class PlatformJarvisSource implements JarvisChannelSource {
  readonly userId: string;
  readonly accountId: string;
  private readonly options: PlatformJarvisSourceOptions;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly listeners = new Set<JarvisSourceListener>();
  private unsubscribers: Array<() => void> = [];
  private readonly dshToRoute = new Map<string, { routeId: string | null; at: number }>();
  private readonly toolCalls = new Map<string, Map<string, Record<string, unknown>>>();
  private readonly deltas = new Map<string, DeltaState>();
  /** Last rev listed per session: never goes backwards within this connection. */
  private readonly revs = new Map<string, { base: number; rev: number }>();
  /** done / idle of a session's latest finished turn, valid while its key (event watermark + latest turn) holds. */
  private readonly finished = new Map<string, { key: string; status: 'done' | 'idle' }>();
  /** Where turns came from, once resolved (continuation chains grow one turn at a time: resolve incrementally). */
  private readonly origins = new Map<string, 'chat' | 'jarvis' | 'task' | 'none'>();
  /** When this Jarvis account was created (ms); null once looked up and unknown. */
  private accountCreatedMs: number | null | undefined;
  private closed = false;

  constructor(options: PlatformJarvisSourceOptions) {
    this.options = options;
    this.userId = options.userId;
    this.accountId = options.accountId;
    this.db = options.db;
    this.now = options.now ?? Date.now;
  }

  // ───────────────────────────── Sessions ─────────────────────────────

  /** Refuses the call (and drops the connection) once the connection's token is no longer valid. */
  private authorize(): void {
    if (this.options.isAuthorized && !this.options.isAuthorized()) {
      this.options.onRevoked?.();
      throw new RpcError('this Jarvis token is no longer valid', 'unauthorized');
    }
  }

  async listSessions(): Promise<JarvisSessionRow[]> {
    this.authorize();
    const routes = this.db
      .prepare(`${ROUTE_SELECT} WHERE r.user_id = ? AND r.status = 'active' AND (s.status IS NULL OR s.status = 'active')`)
      .all(this.userId) as unknown as RouteRow[];
    if (routes.length === 0) return [];

    // One indexed single-row read per session (see lastMessageAtOf): a GROUP BY over the user's messages reads
    // created_at past every message's content and blocked the event loop for seconds on large databases.
    const lastMessageAt = new Map<string, string>();
    for (const r of routes) {
      const at = this.lastMessageAtOf(r.id);
      if (at) lastMessageAt.set(r.id, at);
    }
    const pinned = this.busyRouteIds();
    const cutoff = this.now() - JARVIS_LIST_RECENT_MS;
    const candidates = routes.filter((r) => pinned.has(r.id) || this.activityMs(r, lastMessageAt.get(r.id)) >= cutoff);

    const rows = await Promise.all(candidates.map((r) => this.rowOf(r, lastMessageAt.get(r.id))));
    const byNewest = (a: JarvisSessionRow, b: JarvisSessionRow) =>
      b.updated_at.localeCompare(a.updated_at) || a.session_id.localeCompare(b.session_id);
    const always = rows.filter((r) => r.status === 'working' || r.status === 'blocked');
    const rest = rows.filter((r) => r.status !== 'working' && r.status !== 'blocked').sort(byNewest);
    const picked = [...always, ...rest.slice(0, Math.max(0, JARVIS_LIST_MAX_SESSIONS - always.length))];
    return picked.sort(byNewest);
  }

  async getSession(sessionId: string): Promise<JarvisSessionRow | null> {
    this.authorize();
    const route = this.ownedRoute(sessionId);
    if (!route || !isActive(route.status) || !isActive(route.space_status)) return null;
    return this.rowOf(route);
  }

  // ───────────────────────────── History ─────────────────────────────

  async readEvents(sessionId: string, query: ReadEventsQuery): Promise<ReadEventsResult> {
    this.authorize();
    const route = this.requireRoute(sessionId);
    const history = `dsh:${route.dsh_session_id}`;
    const reader = this.options.reader;
    if (!reader?.readSessionEvents) throw new RpcError('session history is not available', 'unavailable');
    try {
      const page = await reader.readSessionEvents(this.userId, {
        platformSpaceId: route.space_id,
        dshSessionId: route.dsh_session_id,
        ...(query.afterSeq !== undefined ? { afterSeq: query.afterSeq } : {}),
        ...(query.beforeSeq !== undefined ? { beforeSeq: query.beforeSeq } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
      });
      const events = (Array.isArray(page.events) ? page.events : []).filter(
        (e): e is DshSessionEvent => !!e && typeof e.seq === 'number' && typeof e.type === 'string'
      ) as DshSessionEvent[];
      const lastSeq = typeof page.lastSeq === 'number' ? page.lastSeq : events.length > 0 ? events[events.length - 1]!.seq : -1;
      if (lastSeq >= 0) this.options.events?.noteSeq(this.userId, route.dsh_session_id, lastSeq);
      this.cacheToolCalls(route.id, events);
      return { events, history, lastSeq, hasMore: Boolean(page.hasMore) };
    } catch (err) {
      // A session that never ran has no log yet.
      if (errorCode(err) === 'session/not-found') return { events: [], history, lastSeq: -1, hasMore: false };
      throw toJarvisRpcError(err);
    }
  }

  async readImage(sessionId: string, ref: string): Promise<{ mime: string; data: string }> {
    this.authorize();
    const route = this.requireRoute(sessionId);
    const reader = this.options.reader;
    if (!reader?.readAttachment) throw new RpcError('images are not available', 'unavailable');
    const sep = ref.indexOf(':');
    const kind = sep > 0 ? ref.slice(0, sep) : '';
    const value = sep > 0 ? ref.slice(sep + 1) : '';
    if (!value || (kind !== 'att' && kind !== 'path')) throw new RpcError('unknown image reference', 'invalid_params');
    try {
      const image = await reader.readAttachment(this.userId, {
        platformSpaceId: route.space_id,
        dshSessionId: route.dsh_session_id,
        ...(kind === 'att' ? { attachmentId: value } : { path: value }),
      });
      return { mime: image.mime, data: image.data };
    } catch (err) {
      throw toJarvisRpcError(err);
    }
  }

  // ───────────────────────────── Actions ─────────────────────────────

  async send(params: {
    sessionId: string;
    text: string;
    images: Array<{ mime: string; data: string; name?: string }>;
    clientMsgId: string;
  }): Promise<void> {
    this.authorize();
    const text = (params.text ?? '').trim();
    if (text.startsWith('/')) throw new RpcError(JARVIS_SLASH_REFUSAL, 'unsupported');
    if (typeof params.clientMsgId !== 'string' || params.clientMsgId.length === 0 || params.clientMsgId.length > 256) {
      throw new RpcError('client_msg_id must be 1..256 characters', 'invalid_params');
    }
    const images = params.images ?? [];
    if (text.length === 0 && images.length === 0) throw new RpcError('text or images required', 'invalid_params');
    const route = this.ownedRoute(params.sessionId);
    if (!route || !isActive(route.status)) throw new RpcError('unknown session', 'not_found');

    const id = jarvisIdempotencyKey(this.accountId, params.clientMsgId);
    const attachments = images.length > 0 ? await this.ingestImages(route, id, images) : [];
    const envelope: InboundEnvelope = {
      id,
      userId: this.userId,
      sessionId: route.id,
      content: text.length > 0 ? text : IMAGE_ONLY_CONTENT,
      timestamp: new Date(this.now()).toISOString(),
      ...(attachments.length > 0 ? { attachments } : {}),
      channelContext: {
        channel: 'jarvis',
        accountId: this.accountId,
        chatId: route.id,
        nativeContextId: `jarvis:${this.accountId}`,
        nativeEventId: params.clientMsgId,
        senderId: this.userId,
        chatType: 'p2p',
      },
    };
    try {
      await this.options.gateway.dispatchInbound(envelope);
    } catch (err) {
      throw toJarvisRpcError(err);
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    this.authorize();
    const route = this.requireRoute(sessionId);
    try {
      await this.options.gateway.cancelCurrentTurn(this.userId, route.id);
    } catch (err) {
      throw toJarvisRpcError(err);
    }
  }

  async start(params: { cwd: string; prompt?: string }): Promise<JarvisSessionRow> {
    this.authorize();
    const prompt = (params.prompt ?? '').trim();
    if (prompt.startsWith('/')) throw new RpcError(JARVIS_SLASH_REFUSAL, 'unsupported');
    const api = this.sessionApi();
    const space = this.spaceForCwd(params.cwd) ?? this.defaultSpace();
    if (!space) throw new RpcError('no workspace to start a session in', 'not_found');

    let title: string | null = null;
    if (prompt.length > 0) {
      const firstLine = prompt.split(/\r?\n/, 1)[0]!.trim().normalize('NFC');
      title = truncateChars(firstLine, JARVIS_START_TITLE_CHARS).trim() || null;
    }
    let createdId: string;
    try {
      const created = await api.createSession(this.userId, { spaceId: space.id, title, forceNew: true });
      createdId = created.id;
    } catch (err) {
      throw toJarvisRpcError(err);
    }
    if (prompt.length > 0) {
      await this.send({ sessionId: createdId, text: prompt, images: [], clientMsgId: `start-${randomUUID()}` });
    }
    this.emit((l) => l.sessionsChanged());
    const row = await this.getSession(createdId);
    if (!row) throw new RpcError('the new session is gone', 'not_found');
    return row;
  }

  async rename(sessionId: string, title: string): Promise<void> {
    this.authorize();
    const route = this.requireRoute(sessionId);
    const clean = truncateChars((title ?? '').trim().normalize('NFC'), 256).trim();
    if (clean.length === 0) throw new RpcError('title required', 'invalid_params');
    try {
      await this.sessionApi().updateSession(this.userId, route.id, { title: clean });
    } catch (err) {
      throw toJarvisRpcError(err);
    }
    this.emit((l) => l.sessionsChanged());
  }

  async close(sessionId: string): Promise<void> {
    this.authorize();
    const route = this.requireRoute(sessionId);
    try {
      await this.sessionApi().archiveSession(this.userId, route.id);
    } catch (err) {
      throw toJarvisRpcError(err);
    }
    this.emit((l) => l.sessionsChanged());
  }

  // ───────────────────────────── Interactions ─────────────────────────────

  async answerApproval(id: string, decision: { allow: boolean; message?: string }): Promise<void> {
    this.authorize();
    const approvals = this.options.approvals;
    if (!approvals) throw new RpcError('approvals are not available', 'unavailable');
    const pending = approvals.getPending(id, this.userId);
    if (!pending) {
      if (approvals.getSettled(id, this.userId)) throw new RpcError('already answered', 'conflict');
      throw new RpcError('no such approval', 'not_found');
    }
    const result = await approvals.decide(id, decision.allow ? 'allowed-once' : 'rejected', {
      userId: this.userId,
      decidedBy: 'jarvis',
    });
    if (!result.ok) {
      if (result.status === 'not_found') throw new RpcError('no such approval', 'not_found');
      if (result.status === 'transport_unavailable' || result.status === 'failed') {
        throw new RpcError('the runtime could not take the answer', 'unavailable');
      }
      throw new RpcError('already answered', 'conflict');
    }
    const reason = decision.message?.trim();
    if (!decision.allow && reason && pending.routeResolved) {
      // DSH approvals carry no reason: it goes to the agent as the next message of the session.
      try {
        await this.send({
          sessionId: pending.sessionId,
          text: `${JARVIS_REJECT_REASON_PREFIX}${reason}`,
          images: [],
          clientMsgId: `approval-reason-${id}`,
        });
      } catch (err) {
        this.options.log?.warn?.({ code: errorCode(err) }, 'jarvis source: queueing the refusal reason failed');
      }
    }
  }

  async answerQuestion(id: string, answers: QuestionAnswers): Promise<void> {
    this.authorize();
    const questions = this.options.questions;
    if (!questions) throw new RpcError('questions are not available', 'unavailable');
    const result = await questions.answer(id, answers, { userId: this.userId, decidedBy: 'jarvis' });
    if (result.ok) return;
    switch (result.status) {
      case 'expired': {
        // The tool call already told the model nobody answered: the answer goes to the agent as
        // the user's next message of the session (once per question).
        const question = result.question;
        if (!question?.routeResolved) throw new RpcError('the question has expired', 'conflict');
        await this.send({
          sessionId: question.sessionId,
          text: formatLateQuestionAnswers({ questions: [...question.questions], createdAt: question.createdAt }, result.answers ?? []),
          images: [],
          clientMsgId: `${JARVIS_LATE_ANSWER_MSG_PREFIX}${id}`,
        });
        return;
      }
      case 'invalid':
        throw new RpcError(result.error ?? 'the answers do not fit the questions', 'invalid_params');
      case 'not_found':
        throw new RpcError('no such question', 'not_found');
      case 'transport_unavailable':
      case 'failed':
        throw new RpcError('the runtime could not take the answer', 'unavailable');
      default:
        throw new RpcError('already answered', 'conflict');
    }
  }

  // ───────────────────────────── Live ─────────────────────────────

  subscribe(listener: JarvisSourceListener): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.attachLive();
    else {
      this.replayApprovals();
      this.replayQuestions();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.detachLive();
    };
  }

  /** A turn of a session finished (completed or failed): its live text ends and the list changes. */
  notifyTurnSettled(sessionId: string): void {
    for (const [dsh, state] of Array.from(this.deltas)) {
      if (state.routeId === sessionId) this.endDelta(dsh);
    }
    this.emit((l) => l.sessionsChanged());
  }

  /** Drop live subscriptions (the connection is gone). */
  dispose(): void {
    this.closed = true;
    this.listeners.clear();
    this.detachLive();
  }

  private attachLive(): void {
    const events = this.options.events;
    if (events) {
      this.unsubscribers.push(
        events.subscribe(this.userId, {
          sessionEvent: (e) => this.onHubEvent(e),
          turnChunk: (c) => this.onHubChunk(c),
          runtimeChanged: () => this.emit((l) => l.sessionsChanged()),
        })
      );
    }
    const approvals = this.options.approvals;
    if (approvals) {
      this.unsubscribers.push(
        approvals.onAsked((e) => {
          if (e.approval.userId === this.userId) void this.announce(e.approval);
        })
      );
      this.unsubscribers.push(
        approvals.onSettled((e) => {
          if (e.approval.userId !== this.userId) return;
          if (e.decidedBy !== 'jarvis') this.emit((l) => l.approvalSettled(e.approval.id));
          this.emit((l) => l.sessionsChanged());
        })
      );
      this.replayApprovals();
    }
    const questions = this.options.questions;
    if (questions) {
      this.unsubscribers.push(
        questions.onAsked((e) => {
          if (e.question.userId === this.userId) this.announceQuestion(e.question);
        })
      );
      this.unsubscribers.push(
        questions.onSettled((e) => {
          if (e.question.userId !== this.userId) return;
          // The engine drops a card it answered itself; anything else takes it off the phone.
          if (e.decidedBy !== 'jarvis') this.emit((l) => l.questionSettled(e.question.id));
          this.emit((l) => l.sessionsChanged());
        })
      );
      this.replayQuestions();
    }
  }

  private detachLive(): void {
    for (const off of this.unsubscribers.splice(0)) {
      try {
        off();
      } catch {}
    }
    this.deltas.clear();
  }

  private replayApprovals(): void {
    const approvals = this.options.approvals;
    if (!approvals) return;
    for (const approval of approvals.listPending({ userId: this.userId })) void this.announce(approval);
  }

  private replayQuestions(): void {
    const questions = this.options.questions;
    if (!questions) return;
    for (const question of questions.listPending({ userId: this.userId })) this.announceQuestion(question);
  }

  /** A question card for the phone (questions of sessions without a route are not shown). */
  private announceQuestion(question: BridgedQuestion): void {
    if (this.closed || !question.routeResolved) return;
    const card: PendingQuestionCard = {
      id: question.id,
      sessionId: question.sessionId,
      ...(question.callId ? { callId: question.callId } : {}),
      ...(question.plan !== undefined ? { plan: question.plan } : {}),
      questions: question.questions.map((q) => ({
        id: q.id,
        question: q.question,
        ...(q.header ? { header: q.header } : {}),
        options: q.options.map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
        multiSelect: q.multiSelect,
      })),
      expiresAt: question.expiresAt,
    };
    this.emit((l) => l.questionAsked(card));
  }

  private async announce(approval: BridgedApproval): Promise<void> {
    if (!approval.routeResolved) return;
    let toolInput: Record<string, unknown> | undefined;
    try {
      toolInput = await this.toolInputOf(approval.sessionId, approval.callId);
    } catch {
      toolInput = undefined;
    }
    // Settled while the arguments were looked up: nothing to ask.
    if (this.closed || !this.options.approvals?.getPending(approval.id, this.userId)) return;
    const card: PendingApprovalCard = {
      id: approval.id,
      sessionId: approval.sessionId,
      toolName: approval.toolName,
      ...(approval.callId ? { callId: approval.callId } : {}),
      ...(toolInput ? { toolInput } : {}),
      summary: approval.safeSummary,
      ...(approval.reason ? { reason: approval.reason } : {}),
      expiresAt: approval.expiresAt,
    };
    this.emit((l) => l.approvalAsked(card));
  }

  private async toolInputOf(routeId: string, callId: string | undefined): Promise<Record<string, unknown> | undefined> {
    if (!callId) return undefined;
    const cached = this.toolCalls.get(routeId)?.get(callId);
    if (cached) return cached;
    if (!this.options.reader?.readSessionEvents) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), TOOL_INPUT_LOOKUP_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      await Promise.race([this.readEvents(routeId, { limit: TOOL_INPUT_LOOKUP_EVENTS }), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return this.toolCalls.get(routeId)?.get(callId);
  }

  private onHubEvent(e: HubSessionEvent): void {
    const routeId = this.routeOfDsh(e.dshSessionId);
    if (!routeId) return;
    const event = e.event as DshSessionEvent;
    this.cacheToolCalls(routeId, [event]);
    const history = `dsh:${e.dshSessionId}`;
    this.emit((l) => l.sessionEvent(routeId, event, history));
    if (event.type === 'assistant/message') this.endDelta(e.dshSessionId);
    if (event.type === 'turn/end') this.endDelta(e.dshSessionId);
    if (event.type === 'turn/start' || event.type === 'turn/end') this.emit((l) => l.sessionsChanged());
  }

  private onHubChunk(c: HubTurnChunk): void {
    if (c.chunk.type !== 'text-delta' || typeof c.chunk.text !== 'string' || c.chunk.text.length === 0) return;
    const routeId = this.routeOfDsh(c.dshSessionId);
    if (!routeId) return;
    let state = this.deltas.get(c.dshSessionId);
    if (state && c.turnId && state.turnId && state.turnId !== c.turnId) {
      this.endDelta(c.dshSessionId);
      state = undefined;
    }
    if (!state) {
      state = { routeId, ...(c.turnId ? { turnId: c.turnId } : {}), text: '' };
      this.deltas.set(c.dshSessionId, state);
    }
    if (state.text.length >= MAX_DELTA_CHARS) return;
    state.text += c.chunk.text;
    const text = state.text;
    this.emit((l) => l.delta(routeId, text));
  }

  private endDelta(dshSessionId: string): void {
    const state = this.deltas.get(dshSessionId);
    if (!state) return;
    this.deltas.delete(dshSessionId);
    this.emit((l) => l.delta(state.routeId, null));
  }

  private emit(call: (listener: JarvisSourceListener) => void): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        call(listener);
      } catch (err) {
        this.options.log?.warn?.({ err: err instanceof Error ? err.name : typeof err }, 'jarvis source: listener failed');
      }
    }
  }

  // ───────────────────────────── Internals ─────────────────────────────

  private sessionApi(): JarvisSessionApi {
    const raw = this.options.sessionApi;
    const api = typeof raw === 'function' ? raw() : raw;
    if (!api) throw new RpcError('session management is not available', 'unavailable');
    return api;
  }

  private ownedRoute(sessionId: string): RouteRow | null {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
    const row = this.db.prepare(`${ROUTE_SELECT} WHERE r.id = ? AND r.user_id = ? LIMIT 1`).get(sessionId, this.userId) as
      | RouteRow
      | undefined;
    return row ?? null;
  }

  private requireRoute(sessionId: string): RouteRow {
    const route = this.ownedRoute(sessionId);
    if (!route) throw new RpcError('unknown session', 'not_found');
    return route;
  }

  private routeOfDsh(dshSessionId: string): string | null {
    const cached = this.dshToRoute.get(dshSessionId);
    const now = this.now();
    if (cached && (cached.routeId !== null || now - cached.at < UNMAPPED_TTL_MS)) return cached.routeId;
    let routeId: string | null = null;
    try {
      const row = this.db
        .prepare('SELECT id FROM session_routes WHERE dsh_session_id = ? AND user_id = ? LIMIT 1')
        .get(dshSessionId, this.userId) as { id: string } | undefined;
      routeId = row?.id ?? null;
    } catch {
      routeId = null;
    }
    this.dshToRoute.set(dshSessionId, { routeId, at: now });
    if (this.dshToRoute.size > 2000) {
      const oldest = this.dshToRoute.keys().next().value as string;
      this.dshToRoute.delete(oldest);
    }
    return routeId;
  }

  private cacheToolCalls(routeId: string, events: readonly DshSessionEvent[]): void {
    for (const event of events) {
      const calls = toolCallsOf(event);
      if (calls.length === 0) continue;
      let map = this.toolCalls.get(routeId);
      if (!map) {
        map = new Map();
        this.toolCalls.set(routeId, map);
        if (this.toolCalls.size > MAX_CACHED_SESSIONS) {
          const oldest = this.toolCalls.keys().next().value as string;
          this.toolCalls.delete(oldest);
        }
      }
      for (const call of calls) {
        map.delete(call.id);
        map.set(call.id, call.input);
        while (map.size > MAX_CACHED_CALLS_PER_SESSION) map.delete(map.keys().next().value as string);
      }
    }
  }

  private busyRouteIds(): Set<string> {
    const ids = new Set<string>();
    try {
      for (const row of this.db
        .prepare("SELECT DISTINCT route_id FROM turn_runs WHERE user_id = ? AND status IN ('queued', 'running')")
        .all(this.userId) as Array<{ route_id: string }>) {
        ids.add(row.route_id);
      }
    } catch {}
    try {
      for (const row of this.db
        .prepare("SELECT DISTINCT route_id FROM session_recovery_state WHERE user_id = ? AND status = 'recovery_required'")
        .all(this.userId) as Array<{ route_id: string }>) {
        ids.add(row.route_id);
      }
    } catch {}
    for (const approval of this.options.approvals?.listPending({ userId: this.userId }) ?? []) {
      if (approval.routeResolved) ids.add(approval.sessionId);
    }
    for (const question of this.options.questions?.listPending({ userId: this.userId }) ?? []) {
      if (question.routeResolved) ids.add(question.sessionId);
    }
    return ids;
  }

  private activityMs(route: RouteRow, lastMessageAt?: string): number {
    return Math.max(
      timestampMs(route.updated_at) ?? 0,
      timestampMs(route.created_at) ?? 0,
      timestampMs(lastMessageAt) ?? 0,
      this.options.events?.lastActivityAt(this.userId, route.dsh_session_id) ?? 0
    );
  }

  private async statusOf(route: RouteRow, watermark: number | undefined): Promise<JarvisSessionRow['status']> {
    const routeId = route.id;
    if ((this.options.approvals?.listPending({ userId: this.userId, sessionId: routeId }) ?? []).length > 0) return 'blocked';
    if ((this.options.questions?.listPending({ userId: this.userId, sessionId: routeId }) ?? []).length > 0) return 'blocked';
    let turn: { status: string } | null = null;
    try {
      turn = await this.options.gateway.getCurrentTurnStatus(this.userId, routeId);
    } catch {
      turn = null;
    }
    if (turn?.status === 'waiting_approval' || turn?.status === 'recovery_required') return 'blocked';
    if (turn?.status === 'running' || turn?.status === 'queued') return 'working';
    // A turn the runtime started by itself (a continuation after background work) is in no turn record.
    if (this.options.events?.activeTurn(this.userId, route.dsh_session_id, this.now())) return 'working';
    return this.finishedStatus(route, watermark);
  }

  /**
   * done or idle (issue #96): `idle` tells Jarvis the result was already seen elsewhere (shown as seen, no "done"
   * push); `done` leaves it unseen until opened in the app. Decided by the session's latest finished turn:
   *   - started in a chat channel (Lark, WeChat…), including its continuations and tasks delivered there → idle;
   *   - started in Jarvis, including its continuations → done;
   *   - a scheduled task that went to no chat → done;
   *   - started in the Web UI (no origin record) or unknown → idle;
   *   - finished before this Jarvis account existed → idle (no flood of unseen sessions on first connect).
   * No finished turn → idle. Cached per session until its event watermark or latest turn record changes.
   */
  private finishedStatus(route: RouteRow, watermark: number | undefined): 'done' | 'idle' {
    const platform = this.db
      .prepare(
        "SELECT turn_id, finished_at FROM turn_runs WHERE route_id = ? AND +user_id = ? AND +status IN ('completed', 'failed', 'interrupted') ORDER BY rowid DESC LIMIT 1"
      )
      .get(route.id, this.userId) as { turn_id: string; finished_at: string | null } | undefined;
    const key = `${watermark ?? ''}|${platform?.turn_id ?? ''}`;
    const cached = this.finished.get(route.id);
    if (cached && cached.key === key) return cached.status;

    const status = this.classifyFinished(route, platform);
    this.finished.delete(route.id);
    this.finished.set(route.id, { key, status });
    if (this.finished.size > MAX_CACHED_REVS) this.finished.delete(this.finished.keys().next().value as string);
    return status;
  }

  private classifyFinished(route: RouteRow, platform: { turn_id: string; finished_at: string | null } | undefined): 'done' | 'idle' {
    let latest: { finishedMs: number; originTurnId: string | undefined } | undefined;
    if (platform) latest = { finishedMs: timestampMs(platform.finished_at) ?? 0, originTurnId: platform.turn_id };
    const autonomous = this.latestAutonomousTurn(route);
    if (autonomous && (!latest || autonomous.finishedMs > latest.finishedMs)) {
      latest = { finishedMs: autonomous.finishedMs, originTurnId: autonomous.originTurnId };
    }
    if (!latest) return 'idle';
    const accountCreated = this.accountCreatedAt();
    if (accountCreated !== null && latest.finishedMs > 0 && latest.finishedMs < accountCreated) return 'idle';
    if (!latest.originTurnId) return 'idle';
    switch (this.originOf(route, latest.originTurnId)) {
      case 'jarvis':
      case 'task':
        return 'done';
      default:
        return 'idle';
    }
  }

  /**
   * The newest finished turn of the session that is not one of its turn records: an autonomous turn the runtime
   * ran by itself, known only from its `turn_status` event (whose `originTurnId` names the turn that started the
   * background work). Looks at the session's newest 2000 events only, through the session index.
   */
  private latestAutonomousTurn(route: RouteRow): { finishedMs: number; originTurnId: string | undefined } | undefined {
    const row = this.db
      .prepare(
        `SELECT payload, created_at FROM web_events
          WHERE session_id = ? AND +user_id = ? AND type = 'turn_status'
            AND +rowid >= COALESCE((SELECT rowid FROM web_events WHERE session_id = ? ORDER BY rowid DESC LIMIT 1 OFFSET 1999), 0)
            AND json_extract(payload, '$.status') IN ('completed', 'failed', 'interrupted')
          ORDER BY rowid DESC LIMIT 1`
      )
      .get(route.id, this.userId, route.id) as { payload: string; created_at: string | null } | undefined;
    if (!row) return undefined;
    let payload: { turnId?: unknown; originTurnId?: unknown } = {};
    try {
      payload = JSON.parse(row.payload) as typeof payload;
    } catch {
      return undefined;
    }
    const turnId = typeof payload.turnId === 'string' && payload.turnId.length > 0 ? payload.turnId : undefined;
    if (turnId && this.isTurnRecord(route, turnId)) return undefined; // a platform turn: its record says it all
    const originTurnId = typeof payload.originTurnId === 'string' && payload.originTurnId.length > 0 ? payload.originTurnId : undefined;
    return { finishedMs: timestampMs(row.created_at ?? undefined) ?? 0, originTurnId };
  }

  private isTurnRecord(route: RouteRow, turnId: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 AS x FROM turn_runs WHERE user_id = ? AND route_id = ? AND turn_id = ? LIMIT 1')
        .get(this.userId, route.id, turnId) !== undefined
    );
  }

  /**
   * Where a turn came from: a chat channel, Jarvis, a scheduled task, or nothing recorded (Web UI, older turns).
   * A continuation names the turn before it (itself possibly a continuation), so chains are followed up to 50
   * turns back; every turn on a resolved path is remembered, so a growing chain costs one step per new turn.
   */
  private originOf(route: RouteRow, turnId: string): 'chat' | 'jarvis' | 'task' | 'none' {
    const path: string[] = [];
    let result: 'chat' | 'jarvis' | 'task' | 'none' | undefined;
    let current: string | undefined = turnId;
    for (let hop = 0; current && hop < 50; hop++) {
      const known = this.origins.get(current);
      if (known) {
        result = known;
        break;
      }
      path.push(current);
      const origin = this.db
        .prepare('SELECT channel, origin_turn_id FROM channel_turn_origins WHERE turn_id = ? AND +user_id = ? LIMIT 1')
        .get(current, this.userId) as { channel: string | null; origin_turn_id: string | null } | undefined;
      if (origin?.channel) {
        result = origin.channel === 'jarvis' ? 'jarvis' : 'chat';
        break;
      }
      if (this.db.prepare('SELECT 1 AS x FROM task_runs WHERE turn_id = ? AND +user_id = ? LIMIT 1').get(current, this.userId) !== undefined) {
        result = 'task';
        break;
      }
      // A platform turn with no origin record: the Web UI (or a chat turn from before origins were recorded).
      if (this.isTurnRecord(route, current)) {
        result = 'none';
        break;
      }
      // An autonomous turn: follow the turn that started it.
      const next: string | undefined = origin?.origin_turn_id ?? this.autonomousOriginOf(route, current);
      if (!next || path.includes(next)) break;
      current = next;
    }
    if (result === undefined) return 'none'; // not resolvable (yet): treat as seen
    for (const id of path) {
      this.origins.set(id, result);
      if (this.origins.size > MAX_CACHED_REVS * 5) this.origins.delete(this.origins.keys().next().value as string);
    }
    return result;
  }

  /** The `originTurnId` of an autonomous turn's own `turn_status` event (newest 2000 events of the session). */
  private autonomousOriginOf(route: RouteRow, turnId: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT json_extract(payload, '$.originTurnId') AS origin FROM web_events
          WHERE session_id = ? AND +user_id = ? AND type = 'turn_status'
            AND +rowid >= COALESCE((SELECT rowid FROM web_events WHERE session_id = ? ORDER BY rowid DESC LIMIT 1 OFFSET 1999), 0)
            AND json_extract(payload, '$.turnId') = ?
            AND json_extract(payload, '$.originTurnId') IS NOT NULL
          ORDER BY rowid DESC LIMIT 1`
      )
      .get(route.id, this.userId, route.id, turnId) as { origin: string | null } | undefined;
    return typeof row?.origin === 'string' && row.origin.length > 0 ? row.origin : undefined;
  }

  private accountCreatedAt(): number | null {
    if (this.accountCreatedMs !== undefined) return this.accountCreatedMs;
    try {
      const row = this.db
        .prepare('SELECT created_at FROM channel_accounts WHERE id = ? AND user_id = ? LIMIT 1')
        .get(this.options.accountId, this.userId) as { created_at: string | null } | undefined;
      this.accountCreatedMs = timestampMs(row?.created_at ?? undefined) ?? null;
    } catch {
      this.accountCreatedMs = null;
    }
    return this.accountCreatedMs;
  }

  private runtimeCwd(folder: string, executionMode: string | null | undefined): string {
    const mode = executionMode ?? 'container';
    const dir = this.options.runtimeSpacesDir?.({ userId: this.userId, executionMode: mode }) ?? DEFAULT_RUNTIME_SPACES_DIR;
    return path.posix.join(dir, folder);
  }

  /** When the session's newest message was written (its newest row by rowid; one indexed read). */
  private lastMessageAtOf(routeId: string): string | undefined {
    const row = this.db
      .prepare('SELECT created_at FROM web_messages WHERE session_id = ? AND +user_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(routeId, this.userId) as { created_at: string | null } | undefined;
    return row?.created_at ?? undefined;
  }

  private async rowOf(route: RouteRow, lastMessageAt?: string): Promise<JarvisSessionRow> {
    // The newest assistant row by rowid, walking the session index backwards (role sits before content in the row,
    // so non-matching rows are cheap). `+user_id` keeps SQLite off the user index, which would scan every message
    // of the user and sort them.
    const last = this.db
      .prepare(
        "SELECT content FROM web_messages WHERE session_id = ? AND +user_id = ? AND role = 'assistant' ORDER BY rowid DESC LIMIT 1"
      )
      .get(route.id, this.userId) as { content: string | null } | undefined;
    const messageAt = lastMessageAt ?? this.lastMessageAtOf(route.id);
    const watermark = this.watermarkOf(route.id);
    const status = await this.statusOf(route, watermark);
    const rev = this.revOf(route, watermark);
    const updatedMs = this.activityMs(route, messageAt) || this.now();
    const lastText = typeof last?.content === 'string' ? truncateChars(last.content.trim(), JARVIS_LAST_TEXT_CHARS) : '';
    return {
      session_id: route.id,
      title: route.title && route.title.trim().length > 0 ? route.title : (route.space_name ?? route.space_folder),
      cwd: this.runtimeCwd(route.space_folder, route.space_mode),
      status,
      updated_at: new Date(updatedMs).toISOString(),
      ...(rev !== undefined ? { rev } : {}),
      ...(lastText ? { last_text: lastText } : {}),
      space_id: route.space_id,
      ...(route.space_name ? { space_name: route.space_name } : {}),
    };
  }

  /**
   * The session's content revision: the web_events watermark plus the newest DSH seq + 1 seen.
   * Both only grow, so the sum grows whenever either does, including when the seq becomes known
   * (the watermark alone or the seq alone would jump backwards on that switch). Per connection
   * it never goes backwards, even when the DSH log is replaced (session reset) or forgotten.
   */
  private revOf(route: RouteRow, watermark: number | undefined): number | undefined {
    const seq = this.options.events?.lastSeq(this.userId, route.dsh_session_id);
    if (watermark === undefined && seq === undefined) return this.revs.get(route.id)?.rev;
    const base = (watermark ?? 0) + (seq !== undefined ? seq + 1 : 0);
    const previous = this.revs.get(route.id);
    let rev = base;
    if (previous) {
      if (base === previous.base) rev = previous.rev;
      else if (base <= previous.rev) rev = previous.rev + 1;
    }
    this.revs.delete(route.id);
    this.revs.set(route.id, { base, rev });
    if (this.revs.size > MAX_CACHED_REVS) this.revs.delete(this.revs.keys().next().value as string);
    return rev;
  }

  /** The session's newest event row (through the session index; `+user_id` keeps SQLite off the user index). */
  private watermarkOf(routeId: string): number | undefined {
    try {
      const w = this.db
        .prepare('SELECT MAX(rowid) AS w FROM web_events WHERE session_id = ? AND +user_id = ?')
        .get(routeId, this.userId) as { w: number | bigint | null } | undefined;
      if (w?.w !== null && w?.w !== undefined) return Number(w.w);
    } catch {}
    return undefined;
  }

  private activeSpaces(): SpaceRow[] {
    return this.db
      .prepare(
        "SELECT id, name, folder, execution_mode FROM spaces WHERE user_id = ? AND (status IS NULL OR status = 'active') ORDER BY created_at ASC, rowid ASC"
      )
      .all(this.userId) as unknown as SpaceRow[];
  }

  private spaceForCwd(cwd: string): SpaceRow | null {
    const wanted = (cwd ?? '').trim().replace(/\/+$/, '');
    if (!wanted) return null;
    for (const space of this.activeSpaces()) {
      if (wanted === this.runtimeCwd(space.folder, space.execution_mode) || wanted === space.folder || wanted === space.id) return space;
    }
    return null;
  }

  /** The account's default space, else the user's first (main) space. */
  private defaultSpace(): SpaceRow | null {
    const spaces = this.activeSpaces();
    const account = this.db
      .prepare('SELECT default_space_id FROM channel_accounts WHERE id = ? AND user_id = ? LIMIT 1')
      .get(this.accountId, this.userId) as { default_space_id: string | null } | undefined;
    const preferred = account?.default_space_id ? spaces.find((s) => s.id === account.default_space_id) : undefined;
    return preferred ?? spaces[0] ?? null;
  }

  private async ingestImages(
    route: RouteRow,
    messageId: string,
    images: Array<{ mime: string; data: string; name?: string }>
  ): Promise<InboundEnvelopeAttachmentItem[]> {
    const ingestor = this.options.imageIngestor;
    if (!ingestor) throw new RpcError('图片暂时不能发送', 'unsupported');
    const out: InboundEnvelopeAttachmentItem[] = [];
    for (let i = 0; i < images.length; i++) {
      const image = images[i]!;
      const mime = (image.mime ?? '').toLowerCase();
      if (!SUPPORTED_IMAGE_MIMES.has(mime)) throw new RpcError(`images[${i}]: unsupported image type`, 'invalid_params');
      const buffer = decodeBase64(image.data ?? '');
      if (!buffer || buffer.length === 0) throw new RpcError(`images[${i}]: data is not base64`, 'invalid_params');
      if (buffer.length > JARVIS_MAX_IMAGE_BYTES) {
        throw new RpcError(`images[${i}] is larger than ${JARVIS_MAX_IMAGE_BYTES} bytes`, 'too_large');
      }
      try {
        const ingested = await ingestor.ingestImage({
          userId: this.userId,
          spaceId: route.space_id,
          messageId,
          fileKey: `jarvis-image-${i + 1}`,
          buffer,
          contentType: mime,
        });
        out.push({
          path: ingested.path,
          etag: ingested.etag,
          mediaType: ingested.mediaType,
          displayName: ingested.displayName,
        });
      } catch (err) {
        throw toJarvisRpcError(err);
      }
    }
    return out;
  }
}
