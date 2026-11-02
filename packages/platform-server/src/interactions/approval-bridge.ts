/**
 * Host-side approval bridge.
 *
 * Approvals are asked inside each user's runtime container: the in-container
 * ExternalInteractionService suspends the tool call and the runtime daemon pushes
 * `approval/asked` / `approval/decided` events (plus the raw DSH `turn/event` audit pair) over
 * that user's DaemonTransport stream. This bridge subscribes to every user's transport, keeps the
 * pending approvals per user, maps DSH session ids to platform session route ids, emits typed
 * `asked` / `settled` events and answers through the transport's `answerApproval` op.
 *
 * It implements the approval half of {@link IExternalInteractionService}, so it backs the existing
 * `/api/interactions/approvals*` routes and `getCurrentTurnStatus`'s `waiting_approval` for every
 * startup path. Channels (Web, Lark, Jarvis) share one instance: the first answer wins and every
 * other channel learns about it through `settled`.
 *
 * The bridge never trusts a container-reported user id: an approval belongs to the user whose
 * transport reported it.
 *
 * @module @enkeep/platform-server/interactions/approval-bridge
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  ApprovalRiskLevel,
  IExternalInteractionService,
  PendingApproval,
  PendingQuestion,
} from '@enkeep/dsh-external-interaction';
import {
  classifyToolRiskAndSummary,
  resolveApprovalTimeoutMs,
} from '@enkeep/dsh-external-interaction/approval-policy';

/** Answer a channel can give to a pending approval. */
export type ApprovalDecision = 'allowed-once' | 'rejected';

/**
 * Final state of an approval:
 * - `allowed-once` / `rejected`: answered (by any channel, or directly in the runtime);
 * - `cancelled`: withdrawn (cancel route, aborted turn);
 * - `expired`: nobody answered before the runtime's timeout;
 * - `unavailable`: the runtime gave up for another reason (container restarted, no answerer).
 */
export type ApprovalSettledOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'expired' | 'unavailable';

/** What settled the approval. */
export type ApprovalSettledSource =
  /** `approval/decided` from the runtime without a platform answer in flight. */
  | 'runtime'
  /** An answer given through this bridge (`decide` / `cancel` / the HTTP routes). */
  | 'answer'
  /** The runtime no longer lists the approval (e.g. container restarted while it was pending). */
  | 'reconcile'
  /** Local expiry: `expiresAt` plus grace passed without any runtime event. */
  | 'expiry'
  /** The user's transport was detached (runtime stopped/removed). */
  | 'detached';

/** One approval as seen by host-side channels. Immutable snapshot. */
export interface BridgedApproval {
  readonly id: string;
  readonly userId: string;
  /** Platform session route id (`session_routes.id`) when resolvable, otherwise the DSH session id. */
  readonly sessionId: string;
  /** DSH session id reported by the runtime. */
  readonly dshSessionId: string;
  /** False when `sessionId` could not be mapped to a platform route (e.g. a subagent session). */
  readonly routeResolved: boolean;
  readonly turnId?: string;
  readonly toolName: string;
  readonly callId?: string;
  readonly reason?: string;
  readonly risk: ApprovalRiskLevel;
  readonly safeSummary: string;
  readonly createdAt: string;
  /** When the runtime stops waiting (createdAt + timeoutMs). */
  readonly expiresAt: string;
  readonly timeoutMs: number;
}

export interface ApprovalAskedEvent {
  readonly approval: BridgedApproval;
}

export interface ApprovalSettledEvent {
  readonly approval: BridgedApproval;
  readonly outcome: ApprovalSettledOutcome;
  readonly source: ApprovalSettledSource;
  /** Channel label passed to `decide`/`cancel` (e.g. `web`, `lark`, `jarvis`) when answered here. */
  readonly decidedBy?: string;
  readonly decidedAt: string;
}

export interface ApprovalBridgeEventMap {
  asked: ApprovalAskedEvent;
  settled: ApprovalSettledEvent;
}

export interface ApprovalDecisionResult {
  /** True when the requested answer is (or already was) the approval's outcome. */
  readonly ok: boolean;
  readonly status:
    | 'answered'
    | 'already_settled'
    | 'already_answering'
    | 'not_found'
    | 'transport_unavailable'
    | 'failed';
  readonly outcome?: ApprovalSettledOutcome;
}

export interface ApprovalDecisionOptions {
  /** Restrict to approvals of this user (tenant check); omit for admin/system callers. */
  readonly userId?: string;
  /** Channel label reported in the `settled` event (e.g. `web`, `jarvis`). */
  readonly decidedBy?: string;
}

/**
 * Structural subset of the runtime-runner DaemonTransport used by the bridge (any EventEmitter
 * emitting the daemon `stream` events works).
 */
export interface ApprovalRuntimeTransport {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off?(event: string, listener: (...args: any[]) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
  answerApproval?(sessionId: string, approvalId: string, decision: ApprovalDecision): Promise<unknown>;
  listApprovals?(sessionId: string): Promise<unknown>;
}

export interface ApprovalBridgeLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface ApprovalBridgeOptions {
  /** Platform database, used to map DSH session ids to session route ids. */
  readonly db?: DatabaseSync;
  /** Custom DSH session id -> route id mapping (overrides the `db` lookup). */
  readonly resolveRouteId?: (userId: string, dshSessionId: string) => string | null | undefined;
  /** Expected runtime approval timeout. Default: `ENKEEP_APPROVAL_TIMEOUT_MS` from `env`, else 60 s. */
  readonly timeoutMs?: number;
  /** Environment used to resolve the timeout (default `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Clock (ms since epoch). */
  readonly now?: () => number;
  /** Grace after `expiresAt` before a still-pending approval is expired locally. Default 5 s. */
  readonly expiryGraceMs?: number;
  /** How long settled approvals stay readable via `getPendingApproval`. Default 10 min. */
  readonly settledRetentionMs?: number;
  /** Max settled approvals kept. Default 500. */
  readonly maxSettled?: number;
  /** Max wait for runtime enrichment (listApprovals) before `asked` is emitted. Default 1.5 s. */
  readonly announceWaitMs?: number;
  readonly logger?: ApprovalBridgeLogger;
}

/** `PendingApproval` (route payload) plus the expiry time a client can show. */
export type PendingApprovalView = PendingApproval & { expiresAt: string };

interface AnswerInFlight {
  readonly daemonDecision: ApprovalDecision;
  readonly localOutcome: ApprovalSettledOutcome;
  readonly decidedBy?: string;
  promise: Promise<ApprovalDecisionResult>;
}

interface Entry {
  readonly id: string;
  readonly userId: string;
  /** Runtime slot (attachment) that reported the approval; answers go back through it. */
  readonly attachmentId: string;
  readonly seq: number;
  dshSessionId: string;
  sessionId: string;
  routeResolved: boolean;
  turnId?: string;
  toolName: string;
  callId?: string;
  reason?: string;
  risk: ApprovalRiskLevel;
  safeSummary: string;
  /** risk/safeSummary come from the runtime's own approval service (authoritative). */
  authoritative: boolean;
  createdAtMs: number;
  timeoutMs: number;
  announced: boolean;
  announceScheduled: boolean;
  expiryTimer?: NodeJS.Timeout;
  answering?: AnswerInFlight;
}

interface SettledRecord {
  readonly approval: BridgedApproval;
  readonly outcome: ApprovalSettledOutcome;
  readonly settledAtMs: number;
  readonly decidedAt: string;
}

interface Attachment {
  /** `userId` + slot. */
  readonly id: string;
  readonly userId: string;
  readonly slot: string;
  readonly transport: ApprovalRuntimeTransport;
  readonly onStream: (event: unknown) => void;
  readonly onConnected: () => void;
  reconciling?: Promise<void>;
  /** Follow-up run requested while a reconcile was in flight (shared by all requesters). */
  rerun?: Promise<void>;
}

const RISK_LEVELS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'critical']);
/** Placeholder summary the daemon push uses when the DSH event carries none. */
const DAEMON_DEFAULT_SUMMARY = 'Approval requested';
/** A runtime `unavailable` this close to expiresAt counts as expiry. */
const EXPIRY_TOLERANCE_MS = 2_000;
const DEFAULT_SLOT = 'default';

function attachmentKey(userId: string, slot: string): string {
  return `${userId}\u0000${slot}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, max = 512): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, max) : undefined;
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

export class ApprovalBridge implements IExternalInteractionService {
  private readonly db?: DatabaseSync;
  private readonly customRouteResolver?: (userId: string, dshSessionId: string) => string | null | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly now: () => number;
  private readonly expiryGraceMs: number;
  private readonly settledRetentionMs: number;
  private readonly maxSettled: number;
  private readonly announceWaitMs: number;
  private readonly logger: ApprovalBridgeLogger;

  private readonly pending = new Map<string, Entry>();
  private readonly settled = new Map<string, SettledRecord>();
  private readonly attachments = new Map<string, Attachment>();
  private readonly listeners: { [K in keyof ApprovalBridgeEventMap]: Set<(event: ApprovalBridgeEventMap[K]) => void> } = {
    asked: new Set(),
    settled: new Set(),
  };
  private seq = 0;
  private disposed = false;

  constructor(options: ApprovalBridgeOptions = {}) {
    this.db = options.db;
    this.customRouteResolver = options.resolveRouteId;
    this.defaultTimeoutMs = resolveApprovalTimeoutMs({
      configured: options.timeoutMs,
      env: options.env ?? process.env,
    });
    this.now = options.now ?? (() => Date.now());
    this.expiryGraceMs = options.expiryGraceMs ?? 5_000;
    this.settledRetentionMs = options.settledRetentionMs ?? 10 * 60 * 1000;
    this.maxSettled = options.maxSettled ?? 500;
    this.announceWaitMs = options.announceWaitMs ?? 1_500;
    this.logger = options.logger ?? {
      warn: (message, meta) => console.warn(`[approval-bridge] ${message}`, meta ?? {}),
    };
  }

  // ──────────────────────────── Transports ────────────────────────────

  /**
   * Subscribes to one runtime transport of a user. A user can run several runtimes (e.g. a
   * container and a host runtime); each gets its own `slot` (default `default`). Attaching to an
   * occupied slot replaces (and unsubscribes) the previous transport, e.g. after a container
   * restart. Then pending approvals of the slot are reconciled against the runtime (when the
   * transport supports `listApprovals`), which also backfills approvals asked before subscribing.
   * @returns a function that detaches this transport.
   */
  attachTransport(userId: string, transport: ApprovalRuntimeTransport, options: { slot?: string } = {}): () => void {
    if (this.disposed) throw new Error('ApprovalBridge is disposed');
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new TypeError('attachTransport requires a userId');
    }
    const slot = options.slot ?? DEFAULT_SLOT;
    const id = attachmentKey(userId, slot);
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
   * the approvals reported through it settle as `unavailable` (their runtime is gone).
   */
  detachTransport(userId: string, options: { slot?: string; settlePending?: boolean } = {}): void {
    for (const attachment of Array.from(this.attachments.values())) {
      if (attachment.userId !== userId) continue;
      if (options.slot !== undefined && attachment.slot !== options.slot) continue;
      this.unsubscribe(attachment);
      this.attachments.delete(attachment.id);
      if (options.settlePending ?? true) {
        for (const entry of Array.from(this.pending.values())) {
          if (entry.attachmentId === attachment.id) {
            this.settle(entry, 'unavailable', 'detached');
          }
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
   * Re-reads the runtime's pending approvals (daemon `listApprovals`) for a user's transports:
   * adds missed ones, refreshes authoritative fields (createdAt, timeoutMs, risk, summary) and
   * settles local entries the runtime no longer has as `unavailable`. No-op without `listApprovals`.
   */
  async reconcile(userId: string, slot?: string): Promise<void> {
    const targets = Array.from(this.attachments.values()).filter(
      (a) => a.userId === userId && (slot === undefined || a.slot === slot)
    );
    await Promise.all(targets.map((a) => this.reconcileAttachment(a)));
  }

  private reconcileAttachment(attachment: Attachment): Promise<void> {
    if (this.attachments.get(attachment.id) !== attachment || typeof attachment.transport.listApprovals !== 'function') {
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
        response = await attachment.transport.listApprovals!('');
      } catch (err) {
        this.logger.warn('listApprovals failed', {
          userId: attachment.userId,
          error: err instanceof Error ? err.name : typeof err,
        });
        return;
      }
      if (this.disposed || this.attachments.get(attachment.id) !== attachment) return;
      const items = Array.isArray(response)
        ? response
        : isRecord(response) && Array.isArray(response.approvals)
          ? response.approvals
          : null;
      if (!items) return;

      const listed = new Set<string>();
      for (const item of items) {
        if (!isRecord(item)) continue;
        const id = nonEmptyString(item.id, 128);
        if (!id) continue;
        if (item.status !== undefined && item.status !== 'pending') continue;
        listed.add(id);
        this.upsertFromRuntimeList(attachment, id, item);
      }
      for (const entry of Array.from(this.pending.values())) {
        if (entry.attachmentId !== attachment.id || listed.has(entry.id)) continue;
        // Only entries known before the list was requested: later asks may not be in the snapshot.
        if (entry.seq > startSeq || entry.answering) continue;
        this.settle(entry, 'unavailable', 'reconcile');
      }
    })().finally(() => {
      attachment.reconciling = undefined;
    });
    attachment.reconciling = run;
    return run;
  }

  // ──────────────────────────── Bridge API ────────────────────────────

  /** Expected approval timeout of this deployment (`ENKEEP_APPROVAL_TIMEOUT_MS`, default 60 s). */
  getApprovalTimeoutMs(): number {
    return this.defaultTimeoutMs;
  }

  /** Pending approvals, optionally for one user and/or one session (route id or DSH session id). */
  listPending(filter: { userId?: string; sessionId?: string } = {}): BridgedApproval[] {
    this.sweepExpired();
    const result: BridgedApproval[] = [];
    for (const entry of this.pending.values()) {
      if (filter.userId && entry.userId !== filter.userId) continue;
      if (filter.sessionId && entry.sessionId !== filter.sessionId && entry.dshSessionId !== filter.sessionId) continue;
      result.push(this.snapshot(entry));
    }
    return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** A pending approval by id (optionally restricted to one user). */
  getPending(id: string, userId?: string): BridgedApproval | undefined {
    this.sweepExpired();
    const entry = this.pending.get(id);
    if (!entry || (userId && entry.userId !== userId)) return undefined;
    return this.snapshot(entry);
  }

  /** Recently settled approval by id (kept for `settledRetentionMs`). */
  getSettled(id: string, userId?: string): { approval: BridgedApproval; outcome: ApprovalSettledOutcome; decidedAt: string } | undefined {
    this.pruneSettled();
    const record = this.settled.get(id);
    if (!record || (userId && record.approval.userId !== userId)) return undefined;
    return { approval: record.approval, outcome: record.outcome, decidedAt: record.decidedAt };
  }

  /**
   * Answers a pending approval through its user's runtime transport. The first answer wins:
   * a concurrent different answer gets `already_answering`, a later one `already_settled`.
   */
  decide(id: string, decision: ApprovalDecision, options: ApprovalDecisionOptions = {}): Promise<ApprovalDecisionResult> {
    if (decision !== 'allowed-once' && decision !== 'rejected') {
      return Promise.resolve({ ok: false, status: 'failed' });
    }
    return this.beginAnswer(id, decision, decision, options).result;
  }

  /**
   * Withdraws a pending approval. The runtime receives a rejection (the tool does not run);
   * the approval settles as `cancelled`.
   */
  cancel(id: string, options: ApprovalDecisionOptions = {}): Promise<ApprovalDecisionResult> {
    return this.beginAnswer(id, 'rejected', 'cancelled', options).result;
  }

  /** Subscribes to bridge events. Returns an unsubscribe function. Listener errors are contained. */
  on<K extends keyof ApprovalBridgeEventMap>(event: K, listener: (payload: ApprovalBridgeEventMap[K]) => void): () => void {
    const set = this.listeners[event] as Set<(payload: ApprovalBridgeEventMap[K]) => void>;
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  off<K extends keyof ApprovalBridgeEventMap>(event: K, listener: (payload: ApprovalBridgeEventMap[K]) => void): void {
    (this.listeners[event] as Set<(payload: ApprovalBridgeEventMap[K]) => void>).delete(listener);
  }

  onAsked(listener: (event: ApprovalAskedEvent) => void): () => void {
    return this.on('asked', listener);
  }

  onSettled(listener: (event: ApprovalSettledEvent) => void): () => void {
    return this.on('settled', listener);
  }

  /** Unsubscribes every transport and clears timers and state (no events are emitted). */
  dispose(): void {
    this.disposed = true;
    for (const attachment of this.attachments.values()) {
      this.unsubscribe(attachment);
    }
    this.attachments.clear();
    for (const entry of this.pending.values()) {
      if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
    }
    this.pending.clear();
    this.settled.clear();
    this.listeners.asked.clear();
    this.listeners.settled.clear();
  }

  // ─────────────── IExternalInteractionService (approvals; routes & turn status) ───────────────

  listPendingApprovals(filter?: { userId?: string; sessionId?: string; status?: string }): readonly PendingApprovalView[] {
    if (filter?.status !== undefined && filter.status !== 'pending') return [];
    return this.listPending({ userId: filter?.userId, sessionId: filter?.sessionId }).map((a) => this.toView(a, 'pending'));
  }

  getPendingApproval(id: string): PendingApprovalView | undefined {
    const pending = this.getPending(id);
    if (pending) return this.toView(pending, 'pending');
    const settled = this.getSettled(id);
    if (!settled) return undefined;
    return {
      ...this.toView(settled.approval, this.viewStatus(settled.outcome)),
      decidedAt: settled.decidedAt,
      decisionOutcome: this.dshOutcome(settled.outcome),
    };
  }

  answerApproval(id: string, outcome: 'allowed-once' | 'rejected'): boolean {
    if (outcome !== 'allowed-once' && outcome !== 'rejected') return false;
    return this.beginAnswer(id, outcome, outcome, {}).accepted;
  }

  cancelApproval(id: string, _reason?: string): boolean {
    return this.beginAnswer(id, 'rejected', 'cancelled', {}).accepted;
  }

  expireStaleApprovals(): number {
    return this.sweepExpired();
  }

  listPendingQuestions(_filter?: { userId?: string; sessionId?: string }): readonly PendingQuestion[] {
    return [];
  }

  getPendingQuestion(_id: string): PendingQuestion | undefined {
    return undefined;
  }

  answerQuestion(_id: string, _answers: unknown): boolean {
    return false;
  }

  cancelQuestion(_id: string, _reason?: string): boolean {
    return false;
  }

  onApprovalAsked(handler: (pending: PendingApproval) => void): () => void {
    return this.on('asked', (event) => handler(this.toView(event.approval, 'pending')));
  }

  onQuestionAsked(_handler: (pending: PendingQuestion) => void): () => void {
    return () => {};
  }

  // ──────────────────────────── Internals ────────────────────────────

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
    const userId = attachment.userId;
    try {
      if (!isRecord(raw)) return;
      const name = raw.event;
      if (name === 'approval/asked' && isRecord(raw.approval)) {
        const approval = raw.approval;
        const id = nonEmptyString(approval.id, 128);
        if (!id) return;
        const risk = typeof approval.risk === 'string' && RISK_LEVELS.has(approval.risk) ? (approval.risk as ApprovalRiskLevel) : undefined;
        const summary = nonEmptyString(approval.safeSummary);
        this.upsertFromEvent(attachment, id, {
          dshSessionId: nonEmptyString(raw.sessionId, 256),
          turnId: nonEmptyString(raw.turnId, 128),
          toolName: nonEmptyString(approval.toolName, 256),
          timestampMs: toMs(raw.timestamp),
          // The daemon push fills `medium` / a placeholder when DSH carries no risk data.
          risk: summary && summary !== DAEMON_DEFAULT_SUMMARY ? risk : undefined,
          safeSummary: summary && summary !== DAEMON_DEFAULT_SUMMARY ? summary : undefined,
        });
        return;
      }
      if (name === 'approval/decided' && isRecord(raw.decision)) {
        const id = nonEmptyString(raw.decision.id, 128);
        if (id) this.settleFromRuntime(attachment, id, raw.decision.outcome);
        return;
      }
      if (name === 'turn/event' && isRecord(raw.sessionEvent)) {
        const sessionEvent = raw.sessionEvent;
        const data = isRecord(sessionEvent.data) ? sessionEvent.data : undefined;
        const id = data ? nonEmptyString(data.id, 128) : undefined;
        if (!data || !id) return;
        if (sessionEvent.type === 'approval/asked') {
          this.upsertFromEvent(attachment, id, {
            dshSessionId: nonEmptyString(raw.sessionId, 256),
            turnId: nonEmptyString(raw.turnId, 128),
            toolName: nonEmptyString(data.toolName, 256),
            callId: nonEmptyString(data.callId, 256),
            reason: nonEmptyString(data.reason, 2_000),
            timestampMs: toMs(raw.timestamp) ?? toMs(sessionEvent.time),
          });
        } else if (sessionEvent.type === 'approval/decided') {
          this.settleFromRuntime(attachment, id, data.outcome);
        }
      }
    } catch (err) {
      this.logger.warn('failed to process runtime approval event', {
        userId,
        error: err instanceof Error ? err.name : typeof err,
      });
    }
  }

  private upsertFromEvent(
    attachment: Attachment,
    id: string,
    data: {
      dshSessionId?: string;
      turnId?: string;
      toolName?: string;
      callId?: string;
      reason?: string;
      timestampMs?: number;
      risk?: ApprovalRiskLevel;
      safeSummary?: string;
    }
  ): void {
    const userId = attachment.userId;
    const existing = this.pending.get(id);
    if (existing) {
      if (existing.attachmentId !== attachment.id) {
        this.logger.warn('ignoring approval id already reported by another runtime', { userId });
        return;
      }
      if (!existing.turnId && data.turnId) existing.turnId = data.turnId;
      if (!existing.callId && data.callId) existing.callId = data.callId;
      if (!existing.reason && data.reason) {
        existing.reason = data.reason;
        if (!existing.authoritative) {
          const classified = classifyToolRiskAndSummary(existing.toolName, existing.reason);
          existing.risk = classified.risk;
          existing.safeSummary = classified.safeSummary;
        }
      }
      if (!existing.authoritative && data.risk && data.safeSummary) {
        existing.risk = data.risk;
        existing.safeSummary = data.safeSummary;
      }
      return;
    }
    if (this.settled.has(id)) return; // late duplicate of a settled approval
    if (!data.dshSessionId) return;

    const toolName = data.toolName ?? 'tool_execution';
    const classified = classifyToolRiskAndSummary(toolName, data.reason);
    const entry = this.createEntry(attachment, id, {
      dshSessionId: data.dshSessionId,
      turnId: data.turnId,
      toolName,
      callId: data.callId,
      reason: data.reason,
      risk: data.risk ?? classified.risk,
      safeSummary: data.safeSummary ?? classified.safeSummary,
      authoritative: false,
      createdAtMs: data.timestampMs ?? this.now(),
      timeoutMs: this.defaultTimeoutMs,
    });
    this.scheduleAnnounce(entry);
  }

  /** Item of the daemon `listApprovals` response (the runtime's own PendingApproval records). */
  private upsertFromRuntimeList(attachment: Attachment, id: string, item: Record<string, unknown>): void {
    const createdAtMs = toMs(item.createdAt);
    const timeoutMs = typeof item.timeoutMs === 'number' && Number.isSafeInteger(item.timeoutMs) && item.timeoutMs > 0
      ? item.timeoutMs
      : undefined;
    const risk = typeof item.risk === 'string' && RISK_LEVELS.has(item.risk) ? (item.risk as ApprovalRiskLevel) : undefined;
    const safeSummary = nonEmptyString(item.safeSummary);
    const toolName = nonEmptyString(item.toolName, 256);
    const callId = nonEmptyString(item.callId, 256);
    const reason = nonEmptyString(item.reason, 2_000);

    const existing = this.pending.get(id);
    if (existing) {
      if (existing.attachmentId !== attachment.id) return;
      if (createdAtMs !== undefined) existing.createdAtMs = createdAtMs;
      if (timeoutMs !== undefined) existing.timeoutMs = timeoutMs;
      if (toolName) existing.toolName = toolName;
      if (callId) existing.callId = callId;
      if (reason) existing.reason = reason;
      if (risk && safeSummary) {
        existing.risk = risk;
        existing.safeSummary = safeSummary;
        existing.authoritative = true;
      }
      this.scheduleExpiry(existing);
      this.announce(existing);
      return;
    }
    if (this.settled.has(id)) return;
    const dshSessionId = nonEmptyString(item.sessionId, 256);
    if (!dshSessionId) return;
    const effectiveTool = toolName ?? 'tool_execution';
    const classified = classifyToolRiskAndSummary(effectiveTool, reason);
    const entry = this.createEntry(attachment, id, {
      dshSessionId,
      toolName: effectiveTool,
      callId,
      reason,
      risk: risk ?? classified.risk,
      safeSummary: safeSummary ?? classified.safeSummary,
      authoritative: Boolean(risk && safeSummary),
      createdAtMs: createdAtMs ?? this.now(),
      timeoutMs: timeoutMs ?? this.defaultTimeoutMs,
    });
    this.announce(entry);
  }

  private createEntry(
    attachment: Attachment,
    id: string,
    data: {
      dshSessionId: string;
      turnId?: string;
      toolName: string;
      callId?: string;
      reason?: string;
      risk: ApprovalRiskLevel;
      safeSummary: string;
      authoritative: boolean;
      createdAtMs: number;
      timeoutMs: number;
    }
  ): Entry {
    const userId = attachment.userId;
    const routeId = this.resolveRouteId(userId, data.dshSessionId);
    const entry: Entry = {
      id,
      userId,
      attachmentId: attachment.id,
      seq: ++this.seq,
      dshSessionId: data.dshSessionId,
      sessionId: routeId ?? data.dshSessionId,
      routeResolved: Boolean(routeId),
      turnId: data.turnId,
      toolName: data.toolName,
      callId: data.callId,
      reason: data.reason,
      risk: data.risk,
      safeSummary: data.safeSummary,
      authoritative: data.authoritative,
      createdAtMs: data.createdAtMs,
      timeoutMs: data.timeoutMs,
      announced: false,
      announceScheduled: false,
    };
    this.pending.set(id, entry);
    this.scheduleExpiry(entry);
    return entry;
  }

  /**
   * Emits `asked` once the entry is enriched: after a runtime reconcile when the transport can list
   * approvals (bounded by `announceWaitMs`), otherwise on the next tick so the paired
   * `turn/event` / `approval/asked` frames are merged first.
   */
  private scheduleAnnounce(entry: Entry): void {
    if (entry.announced || entry.announceScheduled) return;
    entry.announceScheduled = true;
    const attachment = this.attachments.get(entry.attachmentId);
    if (attachment && typeof attachment.transport.listApprovals === 'function') {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.announce(entry);
      };
      const timer = unrefTimer(setTimeout(finish, this.announceWaitMs));
      void this.reconcileAttachment(attachment).finally(() => {
        clearTimeout(timer);
        finish();
      });
      return;
    }
    setImmediate(() => this.announce(entry));
  }

  private announce(entry: Entry): void {
    if (entry.announced || this.pending.get(entry.id) !== entry || this.disposed) return;
    entry.announced = true;
    this.emit('asked', { approval: this.snapshot(entry) });
  }

  private scheduleExpiry(entry: Entry): void {
    if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
    const delay = Math.max(0, entry.createdAtMs + entry.timeoutMs + this.expiryGraceMs - this.now());
    entry.expiryTimer = unrefTimer(
      setTimeout(() => {
        if (this.pending.get(entry.id) === entry && !entry.answering) {
          this.settle(entry, 'expired', 'expiry');
        }
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

  private settleFromRuntime(attachment: Attachment, id: string, rawOutcome: unknown): void {
    const entry = this.pending.get(id);
    if (!entry || entry.attachmentId !== attachment.id) return;
    let outcome: ApprovalSettledOutcome;
    if (rawOutcome === 'allowed-once' || rawOutcome === 'allowed-always') outcome = 'allowed-once';
    else if (rawOutcome === 'rejected') outcome = 'rejected';
    else if (rawOutcome === 'cancelled') outcome = 'cancelled';
    else outcome = this.unavailableOutcome(entry);

    const answering = entry.answering;
    if (answering && outcome === answering.daemonDecision) {
      this.settle(entry, answering.localOutcome, 'answer', answering.decidedBy);
      return;
    }
    this.settle(entry, outcome, 'runtime');
  }

  private unavailableOutcome(entry: Entry): ApprovalSettledOutcome {
    return this.now() >= entry.createdAtMs + entry.timeoutMs - EXPIRY_TOLERANCE_MS ? 'expired' : 'unavailable';
  }

  private settle(entry: Entry, outcome: ApprovalSettledOutcome, source: ApprovalSettledSource, decidedBy?: string): void {
    if (this.pending.get(entry.id) !== entry) return;
    this.pending.delete(entry.id);
    if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
    const nowMs = this.now();
    const approval = this.snapshot(entry);
    const decidedAt = safeIso(nowMs);
    this.settled.set(entry.id, { approval, outcome, settledAtMs: nowMs, decidedAt });
    this.pruneSettled();
    if (entry.announced) {
      this.emit('settled', {
        approval,
        outcome,
        source,
        ...(decidedBy ? { decidedBy } : {}),
        decidedAt,
      });
    }
  }

  private pruneSettled(): void {
    const cutoff = this.now() - this.settledRetentionMs;
    for (const [id, record] of this.settled) {
      if (record.settledAtMs < cutoff || this.settled.size > this.maxSettled) {
        this.settled.delete(id);
      } else {
        break;
      }
    }
  }

  private beginAnswer(
    id: string,
    daemonDecision: ApprovalDecision,
    localOutcome: ApprovalSettledOutcome,
    options: ApprovalDecisionOptions
  ): { accepted: boolean; result: Promise<ApprovalDecisionResult> } {
    this.sweepExpired();
    const entry = this.pending.get(id);
    if (!entry || (options.userId && entry.userId !== options.userId)) {
      const record = this.settled.get(id);
      if (record && (!options.userId || record.approval.userId === options.userId)) {
        const same = record.outcome === localOutcome;
        return { accepted: same, result: Promise.resolve({ ok: same, status: 'already_settled', outcome: record.outcome }) };
      }
      return { accepted: false, result: Promise.resolve({ ok: false, status: 'not_found' }) };
    }
    if (entry.answering) {
      if (entry.answering.localOutcome === localOutcome) {
        return { accepted: true, result: entry.answering.promise };
      }
      return {
        accepted: false,
        result: Promise.resolve({ ok: false, status: 'already_answering', outcome: entry.answering.localOutcome }),
      };
    }
    const transport = this.attachments.get(entry.attachmentId)?.transport;
    if (!transport || typeof transport.answerApproval !== 'function') {
      return { accepted: false, result: Promise.resolve({ ok: false, status: 'transport_unavailable' }) };
    }

    const answering: AnswerInFlight = {
      daemonDecision,
      localOutcome,
      decidedBy: options.decidedBy,
      promise: Promise.resolve({ ok: false, status: 'failed' }),
    };
    entry.answering = answering;
    answering.promise = (async (): Promise<ApprovalDecisionResult> => {
      try {
        const response = await transport.answerApproval!(entry.dshSessionId, entry.id, daemonDecision);
        const answered = !(isRecord(response) && response.answered === false);
        if (this.pending.get(id) === entry) {
          this.settle(entry, answered ? localOutcome : this.unavailableOutcome(entry), answered ? 'answer' : 'runtime', answered ? options.decidedBy : undefined);
        }
        const record = this.settled.get(id);
        const outcome = record?.outcome ?? (answered ? localOutcome : undefined);
        if (answered && outcome === localOutcome) {
          return { ok: true, status: 'answered', outcome };
        }
        return { ok: false, status: 'already_settled', ...(outcome ? { outcome } : {}) };
      } catch (err) {
        if (this.pending.get(id) === entry && entry.answering === answering) {
          entry.answering = undefined;
        }
        this.logger.warn('answerApproval failed', {
          userId: entry.userId,
          error: err instanceof Error ? err.name : typeof err,
        });
        return { ok: false, status: 'failed' };
      }
    })();
    return { accepted: true, result: answering.promise };
  }

  private resolveRouteId(userId: string, dshSessionId: string): string | undefined {
    try {
      if (this.customRouteResolver) {
        return this.customRouteResolver(userId, dshSessionId) ?? undefined;
      }
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

  private snapshot(entry: Entry): BridgedApproval {
    return {
      id: entry.id,
      userId: entry.userId,
      sessionId: entry.sessionId,
      dshSessionId: entry.dshSessionId,
      routeResolved: entry.routeResolved,
      ...(entry.turnId ? { turnId: entry.turnId } : {}),
      toolName: entry.toolName,
      ...(entry.callId ? { callId: entry.callId } : {}),
      ...(entry.reason ? { reason: entry.reason } : {}),
      risk: entry.risk,
      safeSummary: entry.safeSummary,
      createdAt: safeIso(entry.createdAtMs),
      expiresAt: safeIso(entry.createdAtMs + entry.timeoutMs),
      timeoutMs: entry.timeoutMs,
    };
  }

  /** Route payload: the existing PendingApproval shape (no DSH ids, no raw tool arguments). */
  private toView(approval: BridgedApproval, status: PendingApproval['status']): PendingApprovalView {
    return {
      id: approval.id,
      sessionId: approval.sessionId,
      userId: approval.userId,
      sessionSource: 'web',
      toolName: approval.toolName,
      ...(approval.callId ? { callId: approval.callId } : {}),
      ...(approval.reason ? { reason: approval.reason } : {}),
      risk: approval.risk,
      safeSummary: approval.safeSummary,
      preview: {
        toolName: approval.toolName,
        ...(approval.callId ? { callId: approval.callId } : {}),
      },
      createdAt: approval.createdAt,
      timeoutMs: approval.timeoutMs,
      expiresAt: approval.expiresAt,
      status,
    };
  }

  private viewStatus(outcome: ApprovalSettledOutcome): PendingApproval['status'] {
    if (outcome === 'unavailable') return 'expired';
    return outcome;
  }

  private dshOutcome(outcome: ApprovalSettledOutcome): PendingApproval['decisionOutcome'] {
    return outcome === 'expired' ? 'unavailable' : outcome;
  }

  private emit<K extends keyof ApprovalBridgeEventMap>(event: K, payload: ApprovalBridgeEventMap[K]): void {
    for (const listener of Array.from(this.listeners[event] as Set<(p: ApprovalBridgeEventMap[K]) => void>)) {
      try {
        listener(payload);
      } catch (err) {
        this.logger.warn(`${event} listener failed`, { error: err instanceof Error ? err.name : typeof err });
      }
    }
  }
}
