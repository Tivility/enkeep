/**
 * Host-side hub of the runtimes' live DSH session streams.
 *
 * Every user's runtime transport pushes `turn/event` (a persisted DSH session event, with its DSH
 * seq) and `turn/chunk` (model output deltas) for all sessions of that runtime. Like the
 * ApprovalBridge, the hub is attached to each user's transport when the runtime is bound (one slot
 * per runtime: a user can have a container and a host runtime) and fans the pushes out per user to
 * subscribers (e.g. the Jarvis channel's per-connection sources). It also remembers the newest seq
 * and activity time seen per DSH session, which channels use as a cheap content revision.
 *
 * The daemon broadcasts without replay: after a reconnect (`runtimeChanged` with `connected`)
 * subscribers resynchronize by reading the session log (`readSessionEvents`).
 *
 * @module @enkeep/platform-server/runtime/session-event-hub
 */

/** A DSH session event pushed live by a user's runtime. */
export interface HubSessionEvent {
  readonly userId: string;
  /** DSH session id (may be a subagent/workflow child session). */
  readonly dshSessionId: string;
  /** Original DSH seq (from 0). */
  readonly seq: number;
  /** The submitted platform turn, when known (absent for autonomous turns). */
  readonly turnId?: string;
  /** Push time (ms since epoch). */
  readonly timestamp: number;
  /** The event exactly as DSH stored it (`{seq, type, time, data, …}`). */
  readonly event: { readonly seq: number; readonly type: string; readonly [key: string]: unknown };
}

/** A live model output delta (`turn/chunk`). */
export interface HubTurnChunk {
  readonly userId: string;
  readonly dshSessionId: string;
  readonly turnId?: string;
  readonly timestamp: number;
  /** DSH assistant stream chunk, e.g. `{ type: 'text-delta', index, text }`. */
  readonly chunk: { readonly type: string; readonly text?: string; readonly [key: string]: unknown };
}

export interface HubRuntimeChange {
  readonly userId: string;
  readonly slot: string;
  /** `attached`: a runtime transport was bound; `connected`: it reconnected (pushes may have gaps); `detached`: it went away. */
  readonly state: 'attached' | 'connected' | 'detached';
}

export interface RuntimeSessionEventListener {
  sessionEvent?(event: HubSessionEvent): void;
  turnChunk?(chunk: HubTurnChunk): void;
  runtimeChanged?(change: HubRuntimeChange): void;
}

/**
 * Structural subset of a runtime daemon transport. Transports with `onSessionEvent` /
 * `onTurnChunk` (runtime-runner's host-side helpers) are used through them; otherwise the hub
 * reads the daemon `stream` events itself.
 */
export interface SessionEventRuntimeTransport {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off?(event: string, listener: (...args: any[]) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
  onSessionEvent?(listener: (event: {
    sessionId: string;
    seq: number;
    timestamp: number;
    turnId?: string;
    sessionEvent: unknown;
  }) => void): () => void;
  onTurnChunk?(listener: (chunk: {
    sessionId: string;
    timestamp: number;
    turnId?: string;
    chunk: unknown;
  }) => void): () => void;
}

export interface RuntimeSessionEventHubOptions {
  /** Max DSH sessions whose newest seq is remembered. Default 5000. */
  readonly maxTrackedSessions?: number;
  /**
   * An agent turn (DSH `turn/start` without its `turn/end`) with no event for this long no longer counts
   * as running: its runtime may have died without the hub noticing. Default 2 hours.
   */
  readonly activeTurnStaleMs?: number;
  readonly logger?: { warn(message: string, meta?: Record<string, unknown>): void };
}

interface Attachment {
  readonly key: string;
  readonly userId: string;
  readonly slot: string;
  readonly transport: SessionEventRuntimeTransport;
  readonly cleanups: Array<() => void>;
}

interface SeqMark {
  seq: number;
  at: number;
}

const DEFAULT_SLOT = 'default';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function attachmentKey(userId: string, slot: string): string {
  return `${userId}\u0000${slot}`;
}

function seqKey(userId: string, dshSessionId: string): string {
  return `${userId}\u0000${dshSessionId}`;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export class RuntimeSessionEventHub {
  private readonly attachments = new Map<string, Attachment>();
  private readonly listeners = new Map<string, Set<RuntimeSessionEventListener>>();
  private readonly seqs = new Map<string, SeqMark>();
  /** Agent turns in flight per user + DSH session (seen `turn/start`, not yet `turn/end`): when started, last event. */
  private readonly turns = new Map<string, { since: number; at: number }>();
  private readonly activeTurnStaleMs: number;
  private readonly maxTracked: number;
  private readonly logger: { warn(message: string, meta?: Record<string, unknown>): void };
  private disposed = false;

  constructor(options: RuntimeSessionEventHubOptions = {}) {
    this.maxTracked = options.maxTrackedSessions ?? 5000;
    this.activeTurnStaleMs = options.activeTurnStaleMs ?? 2 * 60 * 60 * 1000;
    this.logger = options.logger ?? {
      warn: (message, meta) => console.warn(`[session-event-hub] ${message}`, meta ?? {}),
    };
  }

  // ──────────────────────────── Transports ────────────────────────────

  /**
   * Subscribes to one runtime transport of a user. Attaching to an occupied slot replaces the
   * previous transport (e.g. after a container restart).
   * @returns a function that detaches this transport.
   */
  attachTransport(userId: string, transport: SessionEventRuntimeTransport, options: { slot?: string } = {}): () => void {
    if (this.disposed) throw new Error('RuntimeSessionEventHub is disposed');
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new TypeError('attachTransport requires a userId');
    }
    const slot = options.slot ?? DEFAULT_SLOT;
    const key = attachmentKey(userId, slot);
    const existing = this.attachments.get(key);
    if (existing && existing.transport === transport) {
      return () => this.detachIf(existing);
    }
    if (existing) {
      this.unsubscribe(existing);
      this.attachments.delete(key);
    }

    const attachment: Attachment = { key, userId, slot, transport, cleanups: [] };
    const current = () => !this.disposed && this.attachments.get(key) === attachment;

    if (typeof transport.onSessionEvent === 'function' && typeof transport.onTurnChunk === 'function') {
      attachment.cleanups.push(
        transport.onSessionEvent((e) => {
          if (current()) this.acceptEvent(userId, e.sessionId, e.seq, e.turnId, e.timestamp, e.sessionEvent);
        })
      );
      attachment.cleanups.push(
        transport.onTurnChunk((c) => {
          if (current()) this.acceptChunk(userId, c.sessionId, c.turnId, c.timestamp, c.chunk);
        })
      );
    } else {
      const onStream = (raw: unknown) => {
        if (!current() || !isRecord(raw)) return;
        if (raw.event === 'turn/event') {
          const sessionEvent = raw.sessionEvent;
          const seq = typeof raw.seq === 'number' ? raw.seq : isRecord(sessionEvent) ? sessionEvent.seq : undefined;
          if (typeof raw.sessionId === 'string' && typeof seq === 'number') {
            this.acceptEvent(userId, raw.sessionId, seq, nonEmpty(raw.turnId), typeof raw.timestamp === 'number' ? raw.timestamp : Date.now(), sessionEvent);
          }
        } else if (raw.event === 'turn/chunk' && typeof raw.sessionId === 'string') {
          this.acceptChunk(userId, raw.sessionId, nonEmpty(raw.turnId), typeof raw.timestamp === 'number' ? raw.timestamp : Date.now(), raw.chunk);
        }
      };
      transport.on('stream', onStream);
      attachment.cleanups.push(() => this.removeListener(transport, 'stream', onStream));
    }
    const onConnected = () => {
      if (current()) this.emitChange({ userId, slot, state: 'connected' });
    };
    transport.on('connected', onConnected);
    attachment.cleanups.push(() => this.removeListener(transport, 'connected', onConnected));

    this.attachments.set(key, attachment);
    this.emitChange({ userId, slot, state: 'attached' });
    return () => this.detachIf(attachment);
  }

  /** Unsubscribes a user's transport (one slot, or every slot when `slot` is omitted). */
  detachTransport(userId: string, options: { slot?: string } = {}): void {
    for (const attachment of Array.from(this.attachments.values())) {
      if (attachment.userId !== userId) continue;
      if (options.slot !== undefined && attachment.slot !== options.slot) continue;
      this.unsubscribe(attachment);
      this.attachments.delete(attachment.key);
      this.forgetTurns(userId);
      this.emitChange({ userId, slot: attachment.slot, state: 'detached' });
    }
  }

  hasTransport(userId: string, slot?: string): boolean {
    for (const attachment of this.attachments.values()) {
      if (attachment.userId === userId && (slot === undefined || attachment.slot === slot)) return true;
    }
    return false;
  }

  // ──────────────────────────── Subscribers ────────────────────────────

  /** Live events of one user's runtimes. Returns an unsubscribe function. */
  subscribe(userId: string, listener: RuntimeSessionEventListener): () => void {
    let set = this.listeners.get(userId);
    if (!set) {
      set = new Set();
      this.listeners.set(userId, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(userId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(userId);
    };
  }

  /** Newest DSH seq seen for a session (live or recorded through {@link noteSeq}). */
  lastSeq(userId: string, dshSessionId: string): number | undefined {
    return this.seqs.get(seqKey(userId, dshSessionId))?.seq;
  }

  /**
   * The agent turn running in a session right now, as seen live: any turn, including the autonomous ones the
   * runtime starts by itself (continuations after background work) that the platform's turn records never show.
   * Undefined when none is running, or when the turn has been silent for longer than `activeTurnStaleMs`.
   * Forgotten when the user's runtime transport detaches; not known across a platform restart until the turn's
   * next `turn/start`.
   */
  activeTurn(userId: string, dshSessionId: string, now: number = Date.now()): { since: number } | undefined {
    const turn = this.turns.get(seqKey(userId, dshSessionId));
    if (!turn) return undefined;
    if (now - turn.at > this.activeTurnStaleMs) return undefined;
    return { since: turn.since };
  }

  /** When the newest event of a session was seen (ms since epoch). */
  lastActivityAt(userId: string, dshSessionId: string): number | undefined {
    return this.seqs.get(seqKey(userId, dshSessionId))?.at;
  }

  /** Records a seq learnt elsewhere (e.g. the `lastSeq` of a log read); never moves backwards. */
  noteSeq(userId: string, dshSessionId: string, seq: number, at?: number): void {
    if (!Number.isSafeInteger(seq) || seq < 0) return;
    const key = seqKey(userId, dshSessionId);
    const existing = this.seqs.get(key);
    if (existing && existing.seq >= seq) return;
    this.seqs.delete(key);
    this.seqs.set(key, { seq, at: at ?? existing?.at ?? Date.now() });
    while (this.seqs.size > this.maxTracked) {
      const oldest = this.seqs.keys().next().value as string;
      this.seqs.delete(oldest);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const attachment of this.attachments.values()) this.unsubscribe(attachment);
    this.attachments.clear();
    this.listeners.clear();
    this.seqs.clear();
    this.turns.clear();
  }

  /** A runtime of the user went away: its turns in flight are gone with it (or unknown until they say otherwise). */
  private forgetTurns(userId: string): void {
    const prefix = seqKey(userId, '');
    for (const key of Array.from(this.turns.keys())) {
      if (key.startsWith(prefix)) this.turns.delete(key);
    }
  }

  // ──────────────────────────── Internals ────────────────────────────

  private acceptEvent(userId: string, dshSessionId: string, seq: number, turnId: string | undefined, timestamp: number, raw: unknown): void {
    if (!dshSessionId || !Number.isSafeInteger(seq) || seq < 0 || !isRecord(raw) || typeof raw.type !== 'string') return;
    const event = (typeof raw.seq === 'number' ? raw : { ...raw, seq }) as HubSessionEvent['event'];
    this.noteSeq(userId, dshSessionId, seq, timestamp);
    const key = seqKey(userId, dshSessionId);
    const mark = this.seqs.get(key);
    if (mark && mark.seq === seq) mark.at = timestamp;
    if (raw.type === 'turn/start') {
      this.turns.set(key, { since: timestamp, at: timestamp });
      while (this.turns.size > this.maxTracked) this.turns.delete(this.turns.keys().next().value as string);
    } else if (raw.type === 'turn/end') {
      this.turns.delete(key);
    } else {
      const turn = this.turns.get(key);
      if (turn && timestamp > turn.at) turn.at = timestamp;
    }
    const payload: HubSessionEvent = {
      userId,
      dshSessionId,
      seq,
      ...(turnId ? { turnId } : {}),
      timestamp,
      event,
    };
    this.emit(userId, (l) => l.sessionEvent?.(payload));
  }

  private acceptChunk(userId: string, dshSessionId: string, turnId: string | undefined, timestamp: number, raw: unknown): void {
    if (!dshSessionId || !isRecord(raw) || typeof raw.type !== 'string') return;
    const payload: HubTurnChunk = {
      userId,
      dshSessionId,
      ...(turnId ? { turnId } : {}),
      timestamp,
      chunk: raw as HubTurnChunk['chunk'],
    };
    this.emit(userId, (l) => l.turnChunk?.(payload));
  }

  private emitChange(change: HubRuntimeChange): void {
    this.emit(change.userId, (l) => l.runtimeChanged?.(change));
  }

  private emit(userId: string, call: (listener: RuntimeSessionEventListener) => void): void {
    const set = this.listeners.get(userId);
    if (!set) return;
    for (const listener of Array.from(set)) {
      try {
        call(listener);
      } catch (err) {
        this.logger.warn('listener failed', { error: err instanceof Error ? err.name : typeof err });
      }
    }
  }

  private unsubscribe(attachment: Attachment): void {
    for (const cleanup of attachment.cleanups.splice(0)) {
      try {
        cleanup();
      } catch {}
    }
  }

  private detachIf(attachment: Attachment): void {
    if (this.attachments.get(attachment.key) === attachment) {
      this.detachTransport(attachment.userId, { slot: attachment.slot });
    }
  }

  private removeListener(transport: SessionEventRuntimeTransport, event: string, listener: (...args: any[]) => void): void {
    if (typeof transport.off === 'function') transport.off(event, listener);
    else if (typeof transport.removeListener === 'function') transport.removeListener(event, listener);
  }
}
