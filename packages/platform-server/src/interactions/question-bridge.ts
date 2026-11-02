/**
 * Host-side bridge of `ask_user_question` questions.
 *
 * A question is asked inside a user's runtime (the `ask_user_question` tool, composed only when
 * the runtime env has ENKEEP_USER_QUESTIONS=1). The runtime daemon pushes `question/asked` (the
 * full pending record) and `question/settled` over that user's transport and offers the
 * `listQuestions` / `answerQuestion` ops. This bridge subscribes to every user's runtime
 * transport (one slot per runtime, like the {@link ApprovalBridge}), keeps the pending questions
 * per user with their session route id and expiry, validates answers before they go to the
 * runtime, answers through the transport (the first answer wins) and emits `asked` / `settled`
 * exactly once per question.
 *
 * Channels (Web, Jarvis, later Lark) share one instance. An answer that arrives after the
 * question expired is refused by the runtime (`question/expired`); the bridge reports `expired`
 * with the question so the channel can deliver the answer as the user's next message
 * (`formatLateQuestionAnswers`).
 *
 * The bridge never trusts a container-reported user id: a question belongs to the user whose
 * transport reported it. Question ids are only unique per runtime, so pending questions are keyed
 * by user and id.
 *
 * @module @enkeep/platform-server/interactions/question-bridge
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  normalizeAskUserQuestionInput,
  resolveQuestionTimeoutMs,
  validateQuestionAnswers,
  type QuestionAnswer,
  type UserQuestion,
} from '@enkeep/dsh-external-interaction/user-questions';

/**
 * Final state of a question:
 * - `answered`: answered (through this bridge, by any channel);
 * - `expired`: nobody answered before the runtime's timeout;
 * - `cancelled`: withdrawn in the runtime (turn interrupted, runtime shutting down);
 * - `unavailable`: the runtime no longer has it (restarted, detached).
 */
export type QuestionSettledOutcome = 'answered' | 'expired' | 'cancelled' | 'unavailable';

/** What settled the question. */
export type QuestionSettledSource =
  /** `question/settled` from the runtime (or a runtime error code) without our answer winning. */
  | 'runtime'
  /** An answer given through this bridge. */
  | 'answer'
  /** The runtime no longer lists the question (e.g. the runtime restarted while it was pending). */
  | 'reconcile'
  /** Local expiry: `expiresAt` plus grace passed without any runtime event. */
  | 'expiry'
  /** The user's transport was detached (runtime stopped/removed). */
  | 'detached';

/** One question as seen by host-side channels. Immutable snapshot. */
export interface BridgedQuestion {
  /** The runtime's question id (the tool call id when usable). */
  readonly id: string;
  readonly userId: string;
  /** Platform session route id (`session_routes.id`) when resolvable, otherwise the DSH session id. */
  readonly sessionId: string;
  /** DSH session id reported by the runtime. */
  readonly dshSessionId: string;
  /** False when `sessionId` could not be mapped to a platform route (e.g. a subagent session). */
  readonly routeResolved: boolean;
  readonly turnId?: string;
  readonly callId?: string;
  readonly questions: readonly UserQuestion[];
  /** The plan under review (plan-review questions; never set by the current runtime). */
  readonly plan?: string;
  readonly createdAt: string;
  /** When the runtime stops waiting (createdAt + timeoutMs). */
  readonly expiresAt: string;
  readonly timeoutMs: number;
}

export interface QuestionAskedEvent {
  readonly question: BridgedQuestion;
}

export interface QuestionSettledEvent {
  readonly question: BridgedQuestion;
  readonly outcome: QuestionSettledOutcome;
  readonly source: QuestionSettledSource;
  /** Channel label passed to `answer` (e.g. `web`, `jarvis`) when answered here. */
  readonly decidedBy?: string;
  /** The accepted answers (outcome `answered`). */
  readonly answers?: readonly QuestionAnswer[];
  readonly decidedAt: string;
}

export interface QuestionBridgeEventMap {
  asked: QuestionAskedEvent;
  settled: QuestionSettledEvent;
}

export type QuestionAnswerStatus =
  /** The runtime took this answer. */
  | 'answered'
  /** Answered elsewhere first, or cancelled. */
  | 'already_settled'
  /** Another answer to the same question is on its way to the runtime. */
  | 'already_answering'
  | 'not_found'
  /** The question timed out: deliver the (validated) answers as a message instead. */
  | 'expired'
  /** The answers do not fit the questions (`error` says why). */
  | 'invalid'
  /** No runtime transport that can answer (or the runtime does not offer questions). */
  | 'transport_unavailable'
  /** The runtime could not be reached; the question stays pending. */
  | 'failed';

export interface QuestionAnswerResult {
  /** True when this answer is the question's answer. */
  readonly ok: boolean;
  readonly status: QuestionAnswerStatus;
  readonly outcome?: QuestionSettledOutcome;
  /** `answered`: the accepted answers; `expired`: the validated answers for a late message. */
  readonly answers?: readonly QuestionAnswer[];
  /** `expired`: the question (to word a late answer with `formatLateQuestionAnswers`). */
  readonly question?: BridgedQuestion;
  /** `invalid`: why the answers were refused. */
  readonly error?: string;
}

export interface QuestionAnswerOptions {
  /** Restrict to questions of this user (tenant check); omit for system callers. */
  readonly userId?: string;
  /** Channel label reported in the `settled` event (e.g. `web`, `jarvis`). */
  readonly decidedBy?: string;
}

/**
 * Structural subset of the runtime-runner daemon transports used by the bridge (any EventEmitter
 * emitting the daemon `stream` events works).
 */
export interface QuestionRuntimeTransport {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off?(event: string, listener: (...args: any[]) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
  listQuestions?(sessionId?: string): Promise<unknown>;
  answerQuestion?(questionId: string, answers: readonly QuestionAnswer[]): Promise<unknown>;
}

export interface QuestionBridgeLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface QuestionBridgeOptions {
  /** Platform database, used to map DSH session ids to session route ids. */
  readonly db?: DatabaseSync;
  /** Custom DSH session id -> route id mapping (overrides the `db` lookup). */
  readonly resolveRouteId?: (userId: string, dshSessionId: string) => string | null | undefined;
  /** Expected runtime question timeout when a record carries none. Default: `ENKEEP_QUESTION_TIMEOUT_MS` from `env`, else 10 min. */
  readonly timeoutMs?: number;
  /** Environment used to resolve the timeout (default `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Clock (ms since epoch). */
  readonly now?: () => number;
  /** Grace after `expiresAt` before a still-pending question is expired locally. Default 5 s. */
  readonly expiryGraceMs?: number;
  /** How long settled questions stay readable (late answers need them). Default 1 h. */
  readonly settledRetentionMs?: number;
  /** Max settled questions kept. Default 500. */
  readonly maxSettled?: number;
  readonly logger?: QuestionBridgeLogger;
}

/** A pending question as the HTTP routes return it (no user or DSH ids). */
export interface PendingQuestionView {
  readonly id: string;
  /** The session route id; null when the question belongs to a session without a route (e.g. a subagent). */
  readonly sessionId: string | null;
  readonly callId?: string;
  readonly questions: ReadonlyArray<{
    readonly id: string;
    readonly question: string;
    readonly header?: string;
    readonly options: ReadonlyArray<{ readonly label: string; readonly description?: string }>;
    readonly multiSelect: boolean;
  }>;
  readonly plan?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly timeoutMs: number;
  readonly status: 'pending';
}

/** Route payload of a bridged question. */
export function toPendingQuestionView(question: BridgedQuestion): PendingQuestionView {
  return {
    id: question.id,
    sessionId: question.routeResolved ? question.sessionId : null,
    ...(question.callId ? { callId: question.callId } : {}),
    questions: question.questions.map((q) => ({
      id: q.id,
      question: q.question,
      ...(q.header ? { header: q.header } : {}),
      options: q.options.map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
      multiSelect: q.multiSelect,
    })),
    ...(question.plan !== undefined ? { plan: question.plan } : {}),
    createdAt: question.createdAt,
    expiresAt: question.expiresAt,
    timeoutMs: question.timeoutMs,
    status: 'pending',
  };
}

interface AnswerInFlight {
  readonly decidedBy?: string;
}

interface Entry {
  /** `userId` + question id. */
  readonly key: string;
  readonly id: string;
  readonly userId: string;
  /** Runtime slot (attachment) that reported the question; answers go back through it. */
  readonly attachmentId: string;
  readonly seq: number;
  readonly dshSessionId: string;
  readonly sessionId: string;
  readonly routeResolved: boolean;
  turnId?: string;
  callId?: string;
  questions: readonly UserQuestion[];
  plan?: string;
  createdAtMs: number;
  timeoutMs: number;
  expiryTimer?: NodeJS.Timeout;
  answering?: AnswerInFlight;
}

interface SettledRecord {
  readonly question: BridgedQuestion;
  readonly outcome: QuestionSettledOutcome;
  readonly answers?: readonly QuestionAnswer[];
  readonly settledAtMs: number;
  readonly decidedAt: string;
}

interface Attachment {
  /** `userId` + slot. */
  readonly id: string;
  readonly userId: string;
  readonly slot: string;
  readonly transport: QuestionRuntimeTransport;
  readonly onStream: (event: unknown) => void;
  readonly onConnected: () => void;
  /** Whether the runtime offers questions (from the last `listQuestions`). */
  enabled?: boolean;
  reconciling?: Promise<void>;
  /** Follow-up run requested while a reconcile was in flight (shared by all requesters). */
  rerun?: Promise<void>;
}

const DEFAULT_SLOT = 'default';
/** A runtime `not-found` this close to expiresAt counts as expiry. */
const EXPIRY_TOLERANCE_MS = 2_000;
const MAX_ID_LENGTH = 256;

function compositeKey(userId: string, value: string): string {
  return `${userId}\u0000${value}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, max = 512): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : undefined;
}

function toMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function safeIso(ms: number): string {
  return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();
}

function unrefTimer(timer: NodeJS.Timeout): NodeJS.Timeout {
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

function errorCodeOf(err: unknown): string | undefined {
  const code = isRecord(err) || err instanceof Error ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

function settledOutcomeOf(raw: unknown): QuestionSettledOutcome | undefined {
  return raw === 'answered' || raw === 'expired' || raw === 'cancelled' ? raw : undefined;
}

/** Answers echoed by the runtime, kept only when they still fit the questions. */
function acceptedAnswers(questions: readonly UserQuestion[], raw: unknown): QuestionAnswer[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const result = validateQuestionAnswers(questions, raw);
  return result.ok ? result.value : undefined;
}

export class QuestionBridge {
  private readonly db?: DatabaseSync;
  private readonly customRouteResolver?: (userId: string, dshSessionId: string) => string | null | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly now: () => number;
  private readonly expiryGraceMs: number;
  private readonly settledRetentionMs: number;
  private readonly maxSettled: number;
  private readonly logger: QuestionBridgeLogger;

  private readonly pending = new Map<string, Entry>();
  private readonly settled = new Map<string, SettledRecord>();
  private readonly attachments = new Map<string, Attachment>();
  private readonly listeners: { [K in keyof QuestionBridgeEventMap]: Set<(event: QuestionBridgeEventMap[K]) => void> } = {
    asked: new Set(),
    settled: new Set(),
  };
  private seq = 0;
  private disposed = false;

  constructor(options: QuestionBridgeOptions = {}) {
    this.db = options.db;
    this.customRouteResolver = options.resolveRouteId;
    this.defaultTimeoutMs = resolveQuestionTimeoutMs({ configured: options.timeoutMs, env: options.env ?? process.env });
    this.now = options.now ?? (() => Date.now());
    this.expiryGraceMs = options.expiryGraceMs ?? 5_000;
    this.settledRetentionMs = options.settledRetentionMs ?? 60 * 60 * 1000;
    this.maxSettled = options.maxSettled ?? 500;
    this.logger = options.logger ?? {
      warn: (message, meta) => console.warn(`[question-bridge] ${message}`, meta ?? {}),
    };
  }

  // ──────────────────────────── Transports ────────────────────────────

  /**
   * Subscribes to one runtime transport of a user (one `slot` per runtime: a user can have a
   * container and a host runtime). Attaching to an occupied slot replaces the previous transport.
   * Then the slot's questions are reconciled with the runtime (`listQuestions`), which also
   * backfills questions asked before subscribing; the same happens on the transport's `connected`.
   * @returns a function that detaches this transport.
   */
  attachTransport(userId: string, transport: QuestionRuntimeTransport, options: { slot?: string } = {}): () => void {
    if (this.disposed) throw new Error('QuestionBridge is disposed');
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new TypeError('attachTransport requires a userId');
    }
    const slot = options.slot ?? DEFAULT_SLOT;
    const id = compositeKey(userId, slot);
    const existing = this.attachments.get(id);
    if (existing && existing.transport === transport) {
      return () => this.detachIf(existing);
    }
    if (existing) {
      this.unsubscribe(existing);
      this.attachments.delete(id);
    }
    const attachment: Attachment = {
      id,
      userId,
      slot,
      transport,
      onStream: (event: unknown) => this.handleStreamEvent(attachment, event),
      onConnected: () => {
        void this.reconcileAttachment(attachment);
      },
    };
    this.attachments.set(id, attachment);
    transport.on('stream', attachment.onStream);
    transport.on('connected', attachment.onConnected);
    void this.reconcileAttachment(attachment);
    return () => this.detachIf(attachment);
  }

  /**
   * Unsubscribes a user's transport (one slot, or every slot when `slot` is omitted). By default
   * the questions reported through it settle as `unavailable` (their runtime is gone).
   */
  detachTransport(userId: string, options: { slot?: string; settlePending?: boolean } = {}): void {
    for (const attachment of Array.from(this.attachments.values())) {
      if (attachment.userId !== userId) continue;
      if (options.slot !== undefined && attachment.slot !== options.slot) continue;
      this.unsubscribe(attachment);
      this.attachments.delete(attachment.id);
      if (options.settlePending ?? true) {
        for (const entry of Array.from(this.pending.values())) {
          if (entry.attachmentId === attachment.id) this.settle(entry, 'unavailable', 'detached');
        }
      }
    }
  }

  hasTransport(userId: string, slot?: string): boolean {
    for (const attachment of this.attachments.values()) {
      if (attachment.userId === userId && (slot === undefined || attachment.slot === slot)) return true;
    }
    return false;
  }

  /**
   * Whether one of the user's runtimes offers questions (ENKEEP_USER_QUESTIONS=1), as its last
   * `listQuestions` said; undefined when no runtime answered yet.
   */
  questionsEnabled(userId: string): boolean | undefined {
    let known: boolean | undefined;
    for (const attachment of this.attachments.values()) {
      if (attachment.userId !== userId || attachment.enabled === undefined) continue;
      known = Boolean(known) || attachment.enabled;
    }
    return known;
  }

  /**
   * Re-reads the runtime's pending questions (`listQuestions`) for a user's transports: adds
   * missed ones, refreshes createdAt/timeout, and settles local entries the runtime no longer has.
   */
  async reconcile(userId: string, slot?: string): Promise<void> {
    const targets = Array.from(this.attachments.values()).filter(
      (a) => a.userId === userId && (slot === undefined || a.slot === slot)
    );
    await Promise.all(targets.map((a) => this.reconcileAttachment(a)));
  }

  private reconcileAttachment(attachment: Attachment): Promise<void> {
    if (this.attachments.get(attachment.id) !== attachment || typeof attachment.transport.listQuestions !== 'function') {
      return Promise.resolve();
    }
    if (attachment.reconciling) {
      // A snapshot requested now must be taken after the in-flight one: chain one shared follow-up.
      if (!attachment.rerun) {
        attachment.rerun = attachment.reconciling.then(() => {
          attachment.rerun = undefined;
          return this.reconcileAttachment(attachment);
        });
      }
      return attachment.rerun;
    }
    const startSeq = this.seq;
    const run = (async () => {
      let response: unknown;
      try {
        response = await attachment.transport.listQuestions!();
      } catch (err) {
        this.logger.warn('listQuestions failed', {
          userId: attachment.userId,
          error: err instanceof Error ? err.name : typeof err,
        });
        return;
      }
      if (this.disposed || this.attachments.get(attachment.id) !== attachment) return;
      const items = Array.isArray(response)
        ? response
        : isRecord(response) && Array.isArray(response.questions)
          ? response.questions
          : null;
      if (isRecord(response) && typeof response.enabled === 'boolean') attachment.enabled = response.enabled;
      if (!items) return;

      const listed = new Set<string>();
      for (const item of items) {
        if (!isRecord(item)) continue;
        if (item.status !== undefined && item.status !== 'pending') continue;
        const id = nonEmptyString(item.id, MAX_ID_LENGTH);
        if (!id) continue;
        listed.add(id);
        this.upsert(attachment, item, undefined);
      }
      for (const entry of Array.from(this.pending.values())) {
        if (entry.attachmentId !== attachment.id || listed.has(entry.id)) continue;
        // Only entries known before the list was requested: later asks may not be in the snapshot.
        if (entry.seq > startSeq || entry.answering) continue;
        this.settle(entry, this.unavailableOutcome(entry), 'reconcile');
      }
    })().finally(() => {
      attachment.reconciling = undefined;
    });
    attachment.reconciling = run;
    return run;
  }

  // ──────────────────────────── Bridge API ────────────────────────────

  /** Expected question timeout of this deployment (`ENKEEP_QUESTION_TIMEOUT_MS`, default 10 min). */
  getQuestionTimeoutMs(): number {
    return this.defaultTimeoutMs;
  }

  /** Pending questions, optionally of one user and/or one session (route id or DSH session id). */
  listPending(filter: { userId?: string; sessionId?: string } = {}): BridgedQuestion[] {
    this.sweepExpired();
    const result: BridgedQuestion[] = [];
    for (const entry of this.pending.values()) {
      if (filter.userId && entry.userId !== filter.userId) continue;
      if (filter.sessionId && entry.sessionId !== filter.sessionId && entry.dshSessionId !== filter.sessionId) continue;
      result.push(this.snapshot(entry));
    }
    return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  /** A pending question by id (restricted to one user when `userId` is given). */
  getPending(id: string, userId?: string): BridgedQuestion | undefined {
    this.sweepExpired();
    const entry = this.findPending(id, userId);
    return entry ? this.snapshot(entry) : undefined;
  }

  /** A recently settled question by id (kept for `settledRetentionMs`). */
  getSettled(
    id: string,
    userId?: string
  ): { question: BridgedQuestion; outcome: QuestionSettledOutcome; answers?: readonly QuestionAnswer[]; decidedAt: string } | undefined {
    this.pruneSettled();
    const record = this.findSettled(id, userId);
    if (!record) return undefined;
    return {
      question: record.question,
      outcome: record.outcome,
      ...(record.answers ? { answers: record.answers } : {}),
      decidedAt: record.decidedAt,
    };
  }

  /**
   * Answers a pending question through its user's runtime transport. The answers are validated
   * against the questions first (`invalid`). The first answer wins: a concurrent answer gets
   * `already_answering`, a later one `already_settled`. An expired question gets `expired` with
   * the question and the validated answers, so the caller can deliver them as a message.
   */
  async answer(id: string, answers: unknown, options: QuestionAnswerOptions = {}): Promise<QuestionAnswerResult> {
    this.sweepExpired();
    const entry = typeof id === 'string' ? this.findPending(id, options.userId) : undefined;
    if (!entry) {
      const record = typeof id === 'string' ? this.findSettled(id, options.userId) : undefined;
      if (!record) return { ok: false, status: 'not_found' };
      if (record.outcome === 'expired') return this.expiredResult(record.question, answers);
      return { ok: false, status: 'already_settled', outcome: record.outcome };
    }
    const validated = validateQuestionAnswers(entry.questions, answers);
    if (!validated.ok) return { ok: false, status: 'invalid', error: validated.error };
    if (entry.answering) return { ok: false, status: 'already_answering' };
    const transport = this.attachments.get(entry.attachmentId)?.transport;
    if (!transport || typeof transport.answerQuestion !== 'function') {
      return { ok: false, status: 'transport_unavailable' };
    }

    const answering: AnswerInFlight = { decidedBy: options.decidedBy };
    entry.answering = answering;
    try {
      const response = await transport.answerQuestion(entry.id, validated.value);
      const accepted = (isRecord(response) ? acceptedAnswers(entry.questions, response.answers) : undefined) ?? validated.value;
      if (this.pending.get(entry.key) === entry) {
        this.settle(entry, 'answered', 'answer', options.decidedBy, accepted);
      }
      const record = this.settled.get(entry.key);
      if (record?.outcome === 'answered') {
        return { ok: true, status: 'answered', outcome: 'answered', answers: record.answers ?? accepted };
      }
      return { ok: false, status: 'already_settled', ...(record ? { outcome: record.outcome } : {}) };
    } catch (err) {
      if (this.pending.get(entry.key) === entry && entry.answering === answering) entry.answering = undefined;
      const code = errorCodeOf(err);
      const stillPending = this.pending.get(entry.key) === entry;
      switch (code) {
        case 'question/expired': {
          if (stillPending) this.settle(entry, 'expired', 'runtime');
          return { ok: false, status: 'expired', outcome: 'expired', question: this.snapshot(entry), answers: validated.value };
        }
        case 'question/already-settled': {
          const details = isRecord(err) ? (err as { details?: unknown }).details : undefined;
          const outcome = (isRecord(details) ? settledOutcomeOf(details.status) : undefined) ?? 'unavailable';
          if (stillPending) this.settle(entry, outcome, 'runtime');
          if (outcome === 'expired') {
            return { ok: false, status: 'expired', outcome, question: this.snapshot(entry), answers: validated.value };
          }
          return { ok: false, status: 'already_settled', outcome };
        }
        case 'question/not-found': {
          if (stillPending) this.settle(entry, this.unavailableOutcome(entry), 'runtime');
          return { ok: false, status: 'not_found' };
        }
        case 'question/invalid-answers':
          return { ok: false, status: 'invalid', error: 'the runtime refused these answers' };
        case 'question/unavailable':
          return { ok: false, status: 'transport_unavailable' };
        default:
          this.logger.warn('answerQuestion failed', {
            userId: entry.userId,
            error: err instanceof Error ? err.name : typeof err,
            ...(code ? { code } : {}),
          });
          return { ok: false, status: 'failed' };
      }
    }
  }

  /** Subscribes to bridge events. Returns an unsubscribe function. Listener errors are contained. */
  on<K extends keyof QuestionBridgeEventMap>(event: K, listener: (payload: QuestionBridgeEventMap[K]) => void): () => void {
    const set = this.listeners[event] as Set<(payload: QuestionBridgeEventMap[K]) => void>;
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  off<K extends keyof QuestionBridgeEventMap>(event: K, listener: (payload: QuestionBridgeEventMap[K]) => void): void {
    (this.listeners[event] as Set<(payload: QuestionBridgeEventMap[K]) => void>).delete(listener);
  }

  onAsked(listener: (event: QuestionAskedEvent) => void): () => void {
    return this.on('asked', listener);
  }

  onSettled(listener: (event: QuestionSettledEvent) => void): () => void {
    return this.on('settled', listener);
  }

  /** Unsubscribes every transport and clears timers and state (no events are emitted). */
  dispose(): void {
    this.disposed = true;
    for (const attachment of this.attachments.values()) this.unsubscribe(attachment);
    this.attachments.clear();
    for (const entry of this.pending.values()) {
      if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
    }
    this.pending.clear();
    this.settled.clear();
    this.listeners.asked.clear();
    this.listeners.settled.clear();
  }

  // ──────────────────────────── Internals ────────────────────────────

  private expiredResult(question: BridgedQuestion, answers: unknown): QuestionAnswerResult {
    const validated = validateQuestionAnswers(question.questions, answers);
    if (!validated.ok) return { ok: false, status: 'invalid', error: validated.error };
    return { ok: false, status: 'expired', outcome: 'expired', question, answers: validated.value };
  }

  private findPending(id: string, userId?: string): Entry | undefined {
    if (userId) return this.pending.get(compositeKey(userId, id));
    for (const entry of this.pending.values()) if (entry.id === id) return entry;
    return undefined;
  }

  private findSettled(id: string, userId?: string): SettledRecord | undefined {
    if (userId) return this.settled.get(compositeKey(userId, id));
    for (const record of this.settled.values()) if (record.question.id === id) return record;
    return undefined;
  }

  private unsubscribe(attachment: Attachment): void {
    const { transport } = attachment;
    const remove = (event: string, listener: (...args: any[]) => void) => {
      if (typeof transport.off === 'function') transport.off(event, listener);
      else if (typeof transport.removeListener === 'function') transport.removeListener(event, listener);
    };
    try {
      remove('stream', attachment.onStream);
      remove('connected', attachment.onConnected);
    } catch {}
  }

  private detachIf(attachment: Attachment): void {
    if (this.attachments.get(attachment.id) === attachment) {
      this.detachTransport(attachment.userId, { slot: attachment.slot });
    }
  }

  private handleStreamEvent(attachment: Attachment, raw: unknown): void {
    if (this.disposed || this.attachments.get(attachment.id) !== attachment) return;
    try {
      if (!isRecord(raw)) return;
      if (raw.event === 'question/asked' && isRecord(raw.question)) {
        this.upsert(attachment, raw.question, {
          dshSessionId: nonEmptyString(raw.sessionId, MAX_ID_LENGTH),
          turnId: nonEmptyString(raw.turnId, 128),
          timestampMs: toMs(raw.timestamp),
        });
        return;
      }
      if (raw.event === 'question/settled') {
        const id = nonEmptyString(raw.id, MAX_ID_LENGTH);
        if (id) this.settleFromRuntime(attachment, id, raw.outcome, raw.answers);
      }
    } catch (err) {
      this.logger.warn('failed to process a runtime question event', {
        userId: attachment.userId,
        error: err instanceof Error ? err.name : typeof err,
      });
    }
  }

  /** A `question/asked` push (with its envelope) or a `listQuestions` item. */
  private upsert(
    attachment: Attachment,
    item: Record<string, unknown>,
    envelope: { dshSessionId?: string; turnId?: string; timestampMs?: number } | undefined
  ): void {
    const id = nonEmptyString(item.id, MAX_ID_LENGTH);
    if (!id) return;
    const key = compositeKey(attachment.userId, id);
    const createdAtMs = toMs(item.createdAt) ?? envelope?.timestampMs;
    const timeoutMs =
      typeof item.timeoutMs === 'number' && Number.isSafeInteger(item.timeoutMs) && item.timeoutMs > 0 ? item.timeoutMs : undefined;
    const existing = this.pending.get(key);
    if (existing) {
      if (existing.attachmentId !== attachment.id) {
        this.logger.warn('ignoring a question id already reported by another runtime of the user', { userId: attachment.userId });
        return;
      }
      if (!existing.turnId && envelope?.turnId) existing.turnId = envelope.turnId;
      if (createdAtMs !== undefined) existing.createdAtMs = createdAtMs;
      if (timeoutMs !== undefined) existing.timeoutMs = timeoutMs;
      this.scheduleExpiry(existing);
      return;
    }
    if (this.settled.has(key)) return; // late duplicate of a settled question
    const dshSessionId = nonEmptyString(item.sessionId, MAX_ID_LENGTH) ?? envelope?.dshSessionId;
    if (!dshSessionId) return;
    const normalized = normalizeAskUserQuestionInput({ questions: item.questions });
    if (!normalized.ok) {
      this.logger.warn('ignoring a runtime question of unknown shape', { userId: attachment.userId });
      return;
    }
    const routeId = this.resolveRouteId(attachment.userId, dshSessionId);
    const entry: Entry = {
      key,
      id,
      userId: attachment.userId,
      attachmentId: attachment.id,
      seq: ++this.seq,
      dshSessionId,
      sessionId: routeId ?? dshSessionId,
      routeResolved: Boolean(routeId),
      ...(envelope?.turnId ? { turnId: envelope.turnId } : {}),
      ...(nonEmptyString(item.callId, MAX_ID_LENGTH) ? { callId: nonEmptyString(item.callId, MAX_ID_LENGTH) } : {}),
      questions: normalized.value,
      ...(typeof item.plan === 'string' && item.plan.trim() ? { plan: item.plan } : {}),
      createdAtMs: createdAtMs ?? this.now(),
      timeoutMs: timeoutMs ?? this.defaultTimeoutMs,
    };
    this.pending.set(key, entry);
    this.scheduleExpiry(entry);
    this.emit('asked', { question: this.snapshot(entry) });
  }

  private scheduleExpiry(entry: Entry): void {
    if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
    const delay = Math.max(0, entry.createdAtMs + entry.timeoutMs + this.expiryGraceMs - this.now());
    entry.expiryTimer = unrefTimer(
      setTimeout(() => {
        if (this.pending.get(entry.key) === entry && !entry.answering) this.settle(entry, 'expired', 'expiry');
      }, Math.min(delay, 2_147_000_000))
    );
  }

  private sweepExpired(): number {
    const now = this.now();
    let count = 0;
    for (const entry of Array.from(this.pending.values())) {
      if (!entry.answering && now >= entry.createdAtMs + entry.timeoutMs + this.expiryGraceMs) {
        this.settle(entry, 'expired', 'expiry');
        count++;
      }
    }
    return count;
  }

  private settleFromRuntime(attachment: Attachment, id: string, rawOutcome: unknown, rawAnswers: unknown): void {
    const entry = this.pending.get(compositeKey(attachment.userId, id));
    if (!entry || entry.attachmentId !== attachment.id) return;
    const outcome = settledOutcomeOf(rawOutcome) ?? this.unavailableOutcome(entry);
    const answers = outcome === 'answered' ? acceptedAnswers(entry.questions, rawAnswers) : undefined;
    // Our own answer may be pushed back before the op's response arrives.
    if (entry.answering && outcome === 'answered') {
      this.settle(entry, 'answered', 'answer', entry.answering.decidedBy, answers);
      return;
    }
    this.settle(entry, outcome, 'runtime', undefined, answers);
  }

  private unavailableOutcome(entry: Entry): QuestionSettledOutcome {
    return this.now() >= entry.createdAtMs + entry.timeoutMs - EXPIRY_TOLERANCE_MS ? 'expired' : 'unavailable';
  }

  private settle(
    entry: Entry,
    outcome: QuestionSettledOutcome,
    source: QuestionSettledSource,
    decidedBy?: string,
    answers?: readonly QuestionAnswer[]
  ): void {
    if (this.pending.get(entry.key) !== entry) return;
    this.pending.delete(entry.key);
    if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
    const nowMs = this.now();
    const question = this.snapshot(entry);
    const decidedAt = safeIso(nowMs);
    this.settled.delete(entry.key);
    this.settled.set(entry.key, {
      question,
      outcome,
      ...(answers ? { answers } : {}),
      settledAtMs: nowMs,
      decidedAt,
    });
    this.pruneSettled();
    this.emit('settled', {
      question,
      outcome,
      source,
      ...(decidedBy ? { decidedBy } : {}),
      ...(answers ? { answers } : {}),
      decidedAt,
    });
  }

  private pruneSettled(): void {
    const cutoff = this.now() - this.settledRetentionMs;
    for (const [key, record] of this.settled) {
      if (record.settledAtMs < cutoff || this.settled.size > this.maxSettled) this.settled.delete(key);
      else break;
    }
  }

  private resolveRouteId(userId: string, dshSessionId: string): string | undefined {
    try {
      if (this.customRouteResolver) return this.customRouteResolver(userId, dshSessionId) ?? undefined;
      if (!this.db) return undefined;
      const row = this.db
        .prepare('SELECT id FROM session_routes WHERE dsh_session_id = ? AND user_id = ? LIMIT 1')
        .get(dshSessionId, userId) as { id?: string } | undefined;
      if (row?.id) return row.id;
      const generation = this.db
        .prepare(
          'SELECT route_id FROM session_generations WHERE dsh_session_id = ? AND user_id = ? ORDER BY generation_number DESC LIMIT 1'
        )
        .get(dshSessionId, userId) as { route_id?: string } | undefined;
      return generation?.route_id ?? undefined;
    } catch {
      return undefined;
    }
  }

  private snapshot(entry: Entry): BridgedQuestion {
    return {
      id: entry.id,
      userId: entry.userId,
      sessionId: entry.sessionId,
      dshSessionId: entry.dshSessionId,
      routeResolved: entry.routeResolved,
      ...(entry.turnId ? { turnId: entry.turnId } : {}),
      ...(entry.callId ? { callId: entry.callId } : {}),
      questions: entry.questions,
      ...(entry.plan !== undefined ? { plan: entry.plan } : {}),
      createdAt: safeIso(entry.createdAtMs),
      expiresAt: safeIso(entry.createdAtMs + entry.timeoutMs),
      timeoutMs: entry.timeoutMs,
    };
  }

  private emit<K extends keyof QuestionBridgeEventMap>(event: K, payload: QuestionBridgeEventMap[K]): void {
    for (const listener of Array.from(this.listeners[event] as Set<(p: QuestionBridgeEventMap[K]) => void>)) {
      try {
        listener(payload);
      } catch (err) {
        this.logger.warn(`${event} listener failed`, { error: err instanceof Error ? err.name : typeof err });
      }
    }
  }
}
