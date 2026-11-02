/**
 * The runtime side of the Jarvis runtime protocol for one connection (§8.3–8.4).
 *
 * On {@link JarvisRuntime.start}: subscribe to the source, send `runtime.hello`, then keep the node
 * up to date — `runtime.sessions` (debounced, plus a periodic refresh), `session.items` and
 * `session.delta` for watched sessions, `interaction.create` / `interaction.cancel` for approval and
 * question cards — and answer the node's requests.
 *
 * @module @enkeep/channel-jarvis/runtime
 */

import { randomBytes } from 'node:crypto';
import {
  fullItem,
  imageSource,
  itemSeqOf,
  lightToolInput,
  mapEvent,
  mapToolName,
  toWireItem,
  type JarvisItem,
} from './mapper.js';
import { DEFAULT_PAGING_LIMITS, parseItemsQuery, readItems, type PagingLimits } from './paging.js';
import { Peer, RpcError, describe, errorCode, type JarvisLogger, type MessageSocket } from './rpc.js';
import type {
  DshSessionEvent,
  JarvisChannelSource,
  JarvisSessionRow,
  JarvisSourceListener,
  PendingApprovalCard,
  PendingQuestionCard,
  QuestionAnswers,
} from './source.js';

/** Random per process: tells the node whether enkeep restarted. */
export const JARVIS_RUNTIME_INSTANCE = randomBytes(8).toString('hex');

export interface JarvisRuntimeTiming {
  helloTimeoutMs: number;
  /** Default timeout of other calls to the node. */
  callTimeoutMs: number;
  sessionsDebounceMs: number;
  sessionsRefreshMs: number;
  /** Live events of a watched session are coalesced this long into one push. */
  itemsCoalesceMs: number;
  /** At most one `session.delta` per session this often. */
  deltaThrottleMs: number;
  /** Retry interval of `interaction.create` after `node_gone`. */
  nodeGoneRetryMs: number;
  /** Stop retrying after `node_gone` persisted this long. */
  nodeGoneWindowMs: number;
}

export const DEFAULT_RUNTIME_TIMING: JarvisRuntimeTiming = {
  helloTimeoutMs: 15_000,
  callTimeoutMs: 30_000,
  sessionsDebounceMs: 300,
  sessionsRefreshMs: 30_000,
  itemsCoalesceMs: 80,
  deltaThrottleMs: 120,
  nodeGoneRetryMs: 1_000,
  nodeGoneWindowMs: 120_000,
};

export interface JarvisRuntimeOptions {
  /** enkeep's version (`runtime.hello`). */
  version: string;
  /** Defaults to `Enkeep`. */
  name?: string;
  /** Defaults to `enkeep`. */
  launcher?: string;
  /** Defaults to `DeepSeek Harness`. */
  launcherModel?: string;
  /** How long the phone may take to answer a card without its own expiry. Defaults to 600 s. */
  approvalTimeoutSeconds?: number;
  log: JarvisLogger;
  timing?: Partial<JarvisRuntimeTiming>;
  paging?: Partial<PagingLimits>;
  /** Clock for tests. */
  now?: () => number;
}

/** What the node answered to `runtime.hello`. */
export interface NodeHello {
  protocol?: unknown;
  node_version?: unknown;
  hub?: unknown;
  features?: unknown;
}

export const MAX_TOUCHED_SESSIONS = 50;
export const MAX_REMEMBERED_SENDS = 500;
export const MAX_SEND_IMAGES = 20;
export const MAX_SEND_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_APPROVAL_TIMEOUT_SECONDS = 600;
const CARD_CALL_MARGIN_MS = 60_000;

const APPROVE_LABEL = /approve|accept|\byes\b|\bok\b|proceed|continue|confirm|批准|同意|确认|继续|执行|通过|可以/i;
const REJECT_LABEL = /reject|deny|decline|refuse|\bno\b|revise|change|拒绝|驳回|修改|否|不/i;

interface LiveEvent {
  event: DshSessionEvent;
  history: string;
}

interface WatchState {
  sessionId: string;
  closed: boolean;
  /** History of the last push (null before the first). */
  history: string | null;
  /** The last pushed `to_seq` (null: the next push starts wherever its events start). */
  toSeq: number | null;
  catchUp: boolean;
  /** A gap was already repaired by reading once; the next gap is reported as a jump. */
  repairTried: boolean;
  queue: LiveEvent[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  pumping: boolean;
  dirty: boolean;
  delta: { lastSentAt: number | null; pending: string | null; timer: ReturnType<typeof setTimeout> | null };
}

type CardState = 'waiting' | 'asking' | 'answering' | 'dismissed' | 'failed';

interface OpenCard {
  key: string;
  id: string;
  sessionId: string;
  approval?: PendingApprovalCard;
  question?: PendingQuestionCard;
  state: CardState;
  abort: AbortController | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function invalid(message: string): RpcError {
  return new RpcError(message, 'invalid_params');
}

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value.length === 0) throw invalid(`${key} is required`);
  return value;
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw invalid(`${key} must be a string`);
  return value;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Sort live events by seq within each run of one history, keeping the runs in arrival order. */
function sortWithinHistories(events: LiveEvent[]): LiveEvent[] {
  const runs: LiveEvent[][] = [];
  for (const live of events) {
    const run = runs[runs.length - 1];
    if (run && run[0]!.history === live.history) run.push(live);
    else runs.push([live]);
  }
  return runs.flatMap((run) => run.sort((a, b) => a.event.seq - b.event.seq));
}

function parseImages(raw: unknown): Array<{ mime: string; data: string; name?: string }> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw invalid('images must be an array');
  if (raw.length > MAX_SEND_IMAGES) throw invalid(`at most ${MAX_SEND_IMAGES} images per message`);
  return raw.map((entry, i) => {
    const image = asRecord(entry);
    const data = image?.data;
    const mime = image?.mime ?? image?.media_type ?? image?.mediaType;
    if (typeof data !== 'string' || data.length === 0 || typeof mime !== 'string' || mime.length === 0) {
      throw invalid(`images[${i}] needs mime and data`);
    }
    if (Math.floor((data.length * 3) / 4) > MAX_SEND_IMAGE_BYTES) {
      throw new RpcError(`images[${i}] is larger than ${MAX_SEND_IMAGE_BYTES} bytes`, 'too_large');
    }
    const out: { mime: string; data: string; name?: string } = { mime, data };
    if (typeof image?.name === 'string' && image.name.length > 0) out.name = image.name;
    return out;
  });
}

/** Map a question card's resolution (`{answers: {<question text>: "<label>[, <label>]" | text}}`). */
export function questionAnswersOf(card: PendingQuestionCard, resolution: Record<string, unknown>): QuestionAnswers | null {
  const answers = asRecord(resolution.answers);
  if (!answers) return null;
  return card.questions.map((q) => {
    const value = answers[q.question] ?? answers[q.id] ?? (q.header !== undefined ? answers[q.header] : undefined);
    const labels = (q.options ?? []).map((o) => o.label);
    if (Array.isArray(value)) {
      const strings = value.filter((v): v is string => typeof v === 'string');
      const selected = strings.filter((v) => labels.includes(v));
      const other = strings.filter((v) => !labels.includes(v)).join(', ');
      return other ? { id: q.id, selected, custom: other } : { id: q.id, selected };
    }
    if (typeof value !== 'string' || value.trim().length === 0) return { id: q.id, selected: [] };
    const text = value.trim();
    if (labels.includes(text)) return { id: q.id, selected: [text] };
    if (q.multiSelect) {
      const parts = text
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      if (parts.length > 0 && parts.every((p) => labels.includes(p))) return { id: q.id, selected: parts };
    }
    return { id: q.id, selected: [], custom: value };
  });
}

/**
 * Map a plan card's resolution (`{approve:true}` / `{approve:false, feedback}`): approve picks the
 * first option that means approve (else the first option, else `approve`); a rejection picks an
 * option that means reject when there is one (`reject` without options), feedback goes in `custom`.
 */
export function planAnswersOf(card: PendingQuestionCard, resolution: Record<string, unknown>): QuestionAnswers | null {
  if (typeof resolution.approve !== 'boolean') return null;
  const q = card.questions[0];
  const id = q?.id ?? 'plan';
  const labels = (q?.options ?? []).map((o) => o.label);
  if (resolution.approve) {
    const label = labels.find((l) => APPROVE_LABEL.test(l) && !REJECT_LABEL.test(l)) ?? labels[0] ?? 'approve';
    return [{ id, selected: [label] }];
  }
  const feedback = typeof resolution.feedback === 'string' ? resolution.feedback.trim() : '';
  const rejectLabel = labels.length > 0 ? labels.find((l) => REJECT_LABEL.test(l)) : 'reject';
  const answer: QuestionAnswers[number] = { id, selected: rejectLabel ? [rejectLabel] : [] };
  if (feedback) answer.custom = feedback;
  return [answer];
}

export class JarvisRuntime {
  readonly peer: Peer;
  private readonly socket: MessageSocket;
  private readonly source: JarvisChannelSource;
  private readonly options: JarvisRuntimeOptions;
  private readonly timing: JarvisRuntimeTiming;
  private readonly paging: PagingLimits;
  private readonly log: JarvisLogger;
  private readonly now: () => number;

  private started = false;
  private stopped = false;
  private ready = false;
  private hub = false;
  private hello: NodeHello | null = null;
  private unsubscribe: (() => void) | null = null;

  private sessionsTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private sessionsPushing = false;
  private sessionsDirty = false;
  /** Sessions the phone sent to or started, oldest first. */
  private touched: string[] = [];

  private readonly watches = new Map<string, WatchState>();
  private readonly sends = new Map<string, Promise<{ ok: true }>>();
  private readonly cards = new Map<string, OpenCard>();

  constructor(socket: MessageSocket, source: JarvisChannelSource, options: JarvisRuntimeOptions) {
    this.socket = socket;
    this.source = source;
    this.options = options;
    this.timing = { ...DEFAULT_RUNTIME_TIMING, ...options.timing };
    this.paging = { ...DEFAULT_PAGING_LIMITS, ...options.paging };
    this.log = options.log;
    this.now = options.now ?? Date.now;
    this.peer = new Peer(socket, {
      idPrefix: 'e',
      defaultTimeoutMs: this.timing.callTimeoutMs,
      log: this.log,
      onRequest: (method, params) => this.handle(method, params),
      onEvent: (event, params) => this.onNodeEvent(event, params),
    });
    socket.onClose(() => this.stop());
  }

  /** Whether the node said a hub is connected (cards are only asked then). */
  get hubConnected(): boolean {
    return this.hub;
  }

  /** The node's `runtime.hello` answer, once received. */
  get nodeHello(): NodeHello | null {
    return this.hello;
  }

  /** Send `runtime.hello` and start pushing. Resolves once the node answered (or the connection gave up). */
  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    this.unsubscribe = this.source.subscribe(this.listener());

    let hello: NodeHello;
    try {
      hello = (asRecord(await this.peer.call('runtime.hello', this.helloParams(), { timeoutMs: this.timing.helloTimeoutMs })) ?? {}) as NodeHello;
    } catch (err) {
      if (this.stopped) return;
      this.log.warn?.({ err: describe(err) }, 'jarvis runtime: runtime.hello failed; closing');
      this.socket.close(1011, 'hello failed');
      this.stop();
      return;
    }
    if (this.stopped) return;
    this.hello = hello;
    this.hub = hello.hub !== false;
    this.ready = true;
    this.log.info?.({ protocol: hello.protocol, hub: this.hub }, 'jarvis runtime: node answered hello');

    void this.pushSessions();
    this.refreshTimer = setInterval(() => void this.pushSessions(), this.timing.sessionsRefreshMs);
    this.refreshTimer.unref?.();
    this.askWaitingCards();
  }

  /** Stop pushing and drop the connection's state; closes the socket if still open. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.sessionsTimer) clearTimeout(this.sessionsTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.sessionsTimer = null;
    this.refreshTimer = null;
    for (const w of this.watches.values()) this.closeWatch(w);
    this.watches.clear();
    for (const card of this.cards.values()) card.abort?.abort();
    this.cards.clear();
    this.peer.close();
    this.socket.close(1001, 'runtime stopped');
  }

  private helloParams(): Record<string, unknown> {
    return {
      runtime: 'enkeep',
      name: this.options.name ?? 'Enkeep',
      agent: 'dsh',
      version: this.options.version,
      instance: JARVIS_RUNTIME_INSTANCE,
      launcher: this.options.launcher ?? 'enkeep',
      launcher_model: this.options.launcherModel ?? 'DeepSeek Harness',
      caps: { start: true, send: true, interrupt: true, rename: true, close: true },
    };
  }

  private listener(): JarvisSourceListener {
    return {
      sessionsChanged: () => this.scheduleSessions(),
      sessionEvent: (sessionId, event, history) => this.onSessionEvent(sessionId, event, history),
      delta: (sessionId, text) => this.onDelta(sessionId, text),
      approvalAsked: (card) => this.addCard({ key: `a:${card.id}`, id: card.id, sessionId: card.sessionId, approval: card }),
      approvalSettled: (id) => this.settleCard(`a:${id}`),
      questionAsked: (card) => this.addCard({ key: `q:${card.id}`, id: card.id, sessionId: card.sessionId, question: card }),
      questionSettled: (id) => this.settleCard(`q:${id}`),
    };
  }

  private onNodeEvent(event: string, params: unknown): void {
    if (event === 'runtime.hub') {
      const connected = asRecord(params)?.connected === true;
      const was = this.hub;
      this.hub = connected;
      this.log.info?.({ hub: connected }, 'jarvis runtime: hub state');
      if (connected && !was) this.askWaitingCards();
      return;
    }
    this.log.debug?.({ event }, 'jarvis runtime: ignored node event');
  }

  // -------------------------------------------------------------------------
  // Node requests

  private async handle(method: string, raw: unknown): Promise<unknown> {
    const params = asRecord(raw) ?? {};
    try {
      switch (method) {
        case 'session.items':
          return await this.items(params);
        case 'session.item':
          return await this.item(params);
        case 'session.image':
          return await this.image(params);
        case 'session.watch':
          return await this.watch(params);
        case 'session.unwatch':
          return this.unwatch(params);
        case 'session.send':
          return await this.send(params);
        case 'session.interrupt':
          await this.source.interrupt(requireString(params, 'session_id'));
          return { ok: true };
        case 'session.rename': {
          const sessionId = requireString(params, 'session_id');
          const title = requireString(params, 'title');
          await this.source.rename(sessionId, title);
          this.scheduleSessions();
          return { ok: true };
        }
        case 'session.close': {
          const sessionId = requireString(params, 'session_id');
          await this.source.close(sessionId);
          this.touched = this.touched.filter((id) => id !== sessionId);
          const w = this.watches.get(sessionId);
          if (w) this.closeWatch(w);
          this.watches.delete(sessionId);
          this.scheduleSessions();
          return { ok: true };
        }
        case 'session.start':
          return await this.startSession(params);
        default:
          throw new RpcError(`unsupported method: ${method}`, 'unsupported');
      }
    } catch (err) {
      if (errorCode(err)) throw err;
      // Errors without a code may carry internals; the node gets a generic one.
      this.log.warn?.({ method, err: describe(err) }, 'jarvis runtime: request failed');
      throw new RpcError('internal error', 'internal');
    }
  }

  private async items(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = requireString(params, 'session_id');
    const page = await readItems(this.source, sessionId, parseItemsQuery(params), this.paging);
    return { ...page, items: page.items.map(toWireItem) };
  }

  private async eventOfItem(sessionId: string, itemId: string): Promise<DshSessionEvent> {
    const seq = itemSeqOf(itemId);
    if (seq === null) throw invalid('item_id must look like <seq>#<n>');
    const dshSeq = seq - 1;
    const res = await this.source.readEvents(sessionId, { afterSeq: dshSeq - 1, limit: 1 });
    const event = res.events.find((e) => e.seq === dshSeq);
    if (!event) throw new RpcError('no such item', 'not_found');
    return event;
  }

  /** `session.item`: the item itself, untruncated. */
  private async item(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = requireString(params, 'session_id');
    const itemId = requireString(params, 'item_id');
    const item = fullItem(await this.eventOfItem(sessionId, itemId), itemId);
    if (!item) throw new RpcError('no such item', 'not_found');
    return toWireItem(item);
  }

  private async image(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = requireString(params, 'session_id');
    const itemId = requireString(params, 'item_id');
    const from = imageSource(await this.eventOfItem(sessionId, itemId), itemId);
    if (!from) throw new RpcError('no such image', 'not_found');
    if ('ref' in from) {
      const image = await this.source.readImage(sessionId, from.ref);
      return { mime: image.mime, data: image.data };
    }
    return { mime: from.mime, data: from.data };
  }

  private async send(params: Record<string, unknown>): Promise<{ ok: true }> {
    const sessionId = requireString(params, 'session_id');
    const clientMsgId = requireString(params, 'client_msg_id');
    const text = optionalString(params, 'text') ?? '';
    const images = parseImages(params.images);
    if (text.trim().length === 0 && images.length === 0) throw invalid('text or images required');

    const earlier = this.sends.get(clientMsgId);
    if (earlier) return earlier;
    const delivery = this.source.send({ sessionId, text, images, clientMsgId }).then(() => ({ ok: true as const }));
    this.sends.set(clientMsgId, delivery);
    // A failed delivery may be retried with the same id.
    delivery.catch(() => {
      if (this.sends.get(clientMsgId) === delivery) this.sends.delete(clientMsgId);
    });
    while (this.sends.size > MAX_REMEMBERED_SENDS) {
      const oldest = this.sends.keys().next().value as string;
      this.sends.delete(oldest);
    }
    this.touch(sessionId);
    this.scheduleSessions();
    return delivery;
  }

  private async startSession(params: Record<string, unknown>): Promise<unknown> {
    const cwd = requireString(params, 'cwd');
    const prompt = optionalString(params, 'prompt');
    const row = await this.source.start(prompt !== undefined && prompt.trim().length > 0 ? { cwd, prompt } : { cwd });
    this.touch(row.session_id);
    this.scheduleSessions();
    return { session: row };
  }

  private touch(sessionId: string): void {
    this.touched = this.touched.filter((id) => id !== sessionId);
    this.touched.push(sessionId);
    if (this.touched.length > MAX_TOUCHED_SESSIONS) this.touched.splice(0, this.touched.length - MAX_TOUCHED_SESSIONS);
  }

  // -------------------------------------------------------------------------
  // runtime.sessions

  private scheduleSessions(): void {
    if (this.stopped || this.sessionsTimer) return;
    this.sessionsTimer = setTimeout(() => {
      this.sessionsTimer = null;
      void this.pushSessions();
    }, this.timing.sessionsDebounceMs);
  }

  private async pushSessions(): Promise<void> {
    if (!this.ready || this.stopped) return;
    if (this.sessionsPushing) {
      this.sessionsDirty = true;
      return;
    }
    this.sessionsPushing = true;
    try {
      do {
        this.sessionsDirty = false;
        const sessions = await this.collectSessions();
        if (this.stopped) return;
        this.peer.notify('runtime.sessions', { sessions });
      } while (this.sessionsDirty && !this.stopped);
    } catch (err) {
      this.log.warn?.({ err: describe(err) }, 'jarvis runtime: listing sessions failed');
    } finally {
      this.sessionsPushing = false;
    }
  }

  private async collectSessions(): Promise<JarvisSessionRow[]> {
    const rows = [...(await this.source.listSessions())];
    const listed = new Set(rows.map((r) => r.session_id));
    const blocked = new Set([...this.cards.values()].map((c) => c.sessionId));
    // Sessions the phone touched and sessions waiting for an answer are always listed.
    const missing = [...new Set([...this.touched, ...blocked])].filter((id) => !listed.has(id));
    const extra = await Promise.all(
      missing.map((id) =>
        this.source.getSession(id).then(
          (row) => ({ id, row, gone: row === null }),
          () => ({ id, row: null, gone: false }),
        ),
      ),
    );
    const gone = new Set<string>();
    for (const { id, row, gone: isGone } of extra) {
      if (row) rows.push(row);
      else if (isGone) gone.add(id);
    }
    if (gone.size > 0) this.touched = this.touched.filter((id) => !gone.has(id));

    return rows.map((row) => (blocked.has(row.session_id) && row.status !== 'blocked' ? { ...row, status: 'blocked' } : row));
  }

  // -------------------------------------------------------------------------
  // Watches: session.items pushes and session.delta

  private async watch(params: Record<string, unknown>): Promise<{ ok: true }> {
    const sessionId = requireString(params, 'session_id');
    const since = params.since_seq ?? 0;
    if (typeof since !== 'number' || !Number.isSafeInteger(since) || since < 0) throw invalid('since_seq must be an integer ≥ 0');
    if ((await this.source.getSession(sessionId)) === null) throw new RpcError('unknown session', 'not_found');
    if (this.stopped) return { ok: true };

    const previous = this.watches.get(sessionId);
    if (previous) this.closeWatch(previous);
    const w: WatchState = {
      sessionId,
      closed: false,
      history: null,
      toSeq: since > 0 ? since : null,
      catchUp: since > 0,
      repairTried: false,
      queue: [],
      flushTimer: null,
      pumping: false,
      dirty: false,
      delta: { lastSentAt: null, pending: null, timer: null },
    };
    this.watches.set(sessionId, w);
    // Catch up after the response went out.
    if (w.catchUp) setTimeout(() => void this.pump(w), 0);
    return { ok: true };
  }

  private unwatch(params: Record<string, unknown>): { ok: true } {
    const sessionId = requireString(params, 'session_id');
    const w = this.watches.get(sessionId);
    if (w) this.closeWatch(w);
    this.watches.delete(sessionId);
    return { ok: true };
  }

  private closeWatch(w: WatchState): void {
    w.closed = true;
    w.queue = [];
    if (w.flushTimer) clearTimeout(w.flushTimer);
    if (w.delta.timer) clearTimeout(w.delta.timer);
    w.flushTimer = null;
    w.delta.timer = null;
  }

  private onSessionEvent(sessionId: string, event: DshSessionEvent, history: string): void {
    const w = this.watches.get(sessionId);
    if (!w || w.closed) return;
    w.queue.push({ event, history });
    if (!w.flushTimer) {
      w.flushTimer = setTimeout(() => {
        w.flushTimer = null;
        void this.pump(w);
      }, this.timing.itemsCoalesceMs);
    }
  }

  /** Serialize catch-up and live pushes of one watch. */
  private async pump(w: WatchState): Promise<void> {
    if (w.closed || this.stopped) return;
    if (w.pumping) {
      w.dirty = true;
      return;
    }
    w.pumping = true;
    try {
      do {
        w.dirty = false;
        await this.drain(w);
      } while ((w.dirty || w.catchUp) && !w.closed && !this.stopped);
    } catch (err) {
      this.log.warn?.({ sessionId: w.sessionId, err: describe(err) }, 'jarvis runtime: pushing items failed');
    } finally {
      w.pumping = false;
    }
  }

  private async drain(w: WatchState): Promise<void> {
    if (w.catchUp) {
      w.catchUp = false;
      try {
        await this.catchUp(w);
      } catch (err) {
        this.log.warn?.({ sessionId: w.sessionId, err: describe(err) }, 'jarvis runtime: catch-up read failed');
      }
      w.repairTried = true;
      if (w.closed || this.stopped) return;
    }
    if (w.queue.length === 0) return;

    const queued = sortWithinHistories(w.queue.splice(0));
    let run: LiveEvent[] = [];
    const flush = (): void => {
      if (run.length > 0) this.pushBatch(w, run.map((r) => r.event), run[0]!.history);
      run = [];
    };
    for (let i = 0; i < queued.length; i++) {
      const live = queued[i]!;
      if (w.history !== null && live.history !== w.history) {
        // The log was replaced: push with the new history from where its events start.
        flush();
        w.history = live.history;
        w.toSeq = null;
      }
      const tail = run.length > 0 ? run[run.length - 1]!.event.seq + 1 : w.toSeq;
      const seq = live.event.seq + 1;
      if (tail !== null && seq <= tail) continue;
      if (tail !== null && seq - 1 > tail) {
        flush();
        if (!w.repairTried) {
          // Missing events: read them before going on.
          w.queue.unshift(...queued.slice(i));
          w.catchUp = true;
          return;
        }
        // Still missing after a read: say so with the new from_seq.
        w.toSeq = null;
      }
      run.push(live);
    }
    flush();
    w.repairTried = false;
  }

  /** Push everything after the watch's `toSeq`, in pages. */
  private async catchUp(w: WatchState): Promise<void> {
    let cursor = w.toSeq ?? 0;
    for (;;) {
      const res = await this.source.readEvents(w.sessionId, { afterSeq: cursor - 1, limit: this.paging.chunkEvents });
      if (w.closed || this.stopped) return;
      const events = res.events.filter((e) => e.seq + 1 > cursor);
      if (events.length > 0) {
        if (w.history !== null && res.history !== w.history) w.toSeq = null;
        this.pushBatch(w, events, res.history);
        cursor = w.toSeq ?? cursor;
      } else {
        const end = res.lastSeq + 1;
        if (end < cursor || (w.history !== null && res.history !== w.history)) {
          // The log no longer reaches the node's seq (replaced): say where it ends now.
          this.peer.notify('session.items', { session_id: w.sessionId, items: [], history: res.history, from_seq: end, to_seq: end });
          w.toSeq = end;
        }
        w.history = res.history;
        return;
      }
      if (!res.hasMore) return;
    }
  }

  private pushBatch(w: WatchState, events: readonly DshSessionEvent[], history: string): void {
    const first = events[0]!;
    const last = events[events.length - 1]!;
    const from = w.toSeq ?? first.seq;
    const to = last.seq + 1;
    const items: JarvisItem[] = [];
    for (const event of events) items.push(...mapEvent(event));
    this.peer.notify('session.items', {
      session_id: w.sessionId,
      items: items.map(toWireItem),
      history,
      from_seq: from,
      to_seq: to,
    });
    w.toSeq = to;
    w.history = history;
  }

  private onDelta(sessionId: string, text: string | null): void {
    const w = this.watches.get(sessionId);
    if (!w || w.closed) return;
    const d = w.delta;
    if (text === null) {
      if (d.timer) clearTimeout(d.timer);
      d.timer = null;
      d.pending = null;
      d.lastSentAt = null;
      this.peer.notify('session.delta', { session_id: sessionId, text: '' });
      return;
    }
    d.pending = text;
    if (d.timer) return;
    const wait = d.lastSentAt === null ? 0 : d.lastSentAt + this.timing.deltaThrottleMs - this.now();
    if (wait <= 0) {
      this.flushDelta(w);
      return;
    }
    d.timer = setTimeout(() => {
      d.timer = null;
      this.flushDelta(w);
    }, wait);
  }

  private flushDelta(w: WatchState): void {
    const d = w.delta;
    if (w.closed || d.pending === null) return;
    this.peer.notify('session.delta', { session_id: w.sessionId, text: d.pending });
    d.pending = null;
    d.lastSentAt = this.now();
  }

  // -------------------------------------------------------------------------
  // Interactions

  private addCard(card: Omit<OpenCard, 'state' | 'abort'>): void {
    if (this.stopped) return;
    const existing = this.cards.get(card.key);
    if (existing) {
      // The same card again (e.g. replayed on subscribe): refresh its content only.
      existing.approval = card.approval;
      existing.question = card.question;
      return;
    }
    const open: OpenCard = { ...card, state: 'waiting', abort: null };
    this.cards.set(card.key, open);
    this.scheduleSessions();
    if (this.ready && this.hub) void this.ask(open);
  }

  private settleCard(key: string): void {
    const card = this.cards.get(key);
    if (!card) return;
    this.cards.delete(key);
    if (card.state === 'asking') {
      card.abort?.abort();
      this.peer.notify('interaction.cancel', { id: card.id });
    }
    this.scheduleSessions();
  }

  private askWaitingCards(): void {
    if (!this.ready || !this.hub || this.stopped) return;
    for (const card of this.cards.values()) {
      if (card.state === 'waiting' || card.state === 'failed') void this.ask(card);
    }
  }

  private timeoutSecondsOf(card: OpenCard): number {
    const base = this.options.approvalTimeoutSeconds ?? DEFAULT_APPROVAL_TIMEOUT_SECONDS;
    const expiresAt = card.approval?.expiresAt ?? card.question?.expiresAt;
    const expiry = expiresAt !== undefined ? Date.parse(expiresAt) : NaN;
    if (Number.isNaN(expiry)) return base;
    return Math.min(base, Math.floor((expiry - this.now()) / 1000));
  }

  private interactionOf(card: OpenCard): Record<string, unknown> {
    if (card.approval) {
      const a = card.approval;
      const interaction: Record<string, unknown> = {
        id: a.id,
        kind: 'permission',
        session_id: a.sessionId,
        tool_name: mapToolName(a.toolName),
        tool_input: lightToolInput(a.toolInput ?? {}).input,
      };
      if (a.callId !== undefined) interaction.tool_use_id = a.callId;
      if (a.summary !== undefined) interaction.summary = a.summary;
      if (a.reason !== undefined) interaction.reason = a.reason;
      return interaction;
    }
    const q = card.question!;
    const interaction: Record<string, unknown> = { id: q.id, session_id: q.sessionId };
    if (q.callId !== undefined) interaction.tool_use_id = q.callId;
    if (q.plan !== undefined) {
      interaction.kind = 'plan';
      interaction.plan = q.plan;
      return interaction;
    }
    interaction.kind = 'question';
    interaction.questions = q.questions.map((item) => {
      const out: Record<string, unknown> = {
        question: item.question,
        options: (item.options ?? []).map((o) => (o.description !== undefined ? { label: o.label, description: o.description } : { label: o.label })),
        multi_select: item.multiSelect === true,
      };
      if (item.header !== undefined) out.header = item.header;
      return out;
    });
    return interaction;
  }

  private async ask(card: OpenCard): Promise<void> {
    if (card.state === 'asking') return;
    card.state = 'asking';
    const abort = new AbortController();
    card.abort = abort;
    const current = (): boolean => this.cards.get(card.key) === card && !abort.signal.aborted && !this.stopped;
    let goneSince: number | null = null;

    while (current()) {
      const timeoutSeconds = this.timeoutSecondsOf(card);
      if (timeoutSeconds <= 0) {
        card.state = 'failed';
        card.abort = null;
        return;
      }
      let resolution: unknown;
      try {
        resolution = await this.peer.call(
          'interaction.create',
          { interaction: this.interactionOf(card), timeout_seconds: timeoutSeconds },
          { signal: abort.signal, timeoutMs: timeoutSeconds * 1000 + CARD_CALL_MARGIN_MS },
        );
      } catch (err) {
        if (!current()) return;
        const code = errorCode(err);
        if (code === 'node_gone') {
          // The node restarted: ask again with the same id for a while.
          goneSince ??= this.now();
          if (this.now() - goneSince < this.timing.nodeGoneWindowMs) {
            await sleep(this.timing.nodeGoneRetryMs, abort.signal);
            continue;
          }
        }
        this.log.warn?.({ id: card.id, code }, 'jarvis runtime: interaction.create failed');
        card.state = 'failed';
        card.abort = null;
        return;
      }
      card.abort = null;
      if (!current()) return;
      await this.resolve(card, resolution);
      return;
    }
  }

  private async resolve(card: OpenCard, resolution: unknown): Promise<void> {
    const r = asRecord(resolution);
    if (r?.dismiss === true) {
      // The phone did not answer: the card stays for the other channels.
      card.state = 'dismissed';
      return;
    }
    card.state = 'answering';
    try {
      if (!r) throw new Error('resolution is not an object');
      if (card.approval) {
        if (typeof r.allow !== 'boolean') throw new Error('permission resolution without allow');
        const message = typeof r.message === 'string' && r.message.trim().length > 0 ? r.message : undefined;
        await this.source.answerApproval(card.id, r.allow ? { allow: true } : message ? { allow: false, message } : { allow: false });
      } else {
        const q = card.question!;
        const answers = q.plan !== undefined ? planAnswersOf(q, r) : questionAnswersOf(q, r);
        if (!answers) throw new Error(`${q.plan !== undefined ? 'plan' : 'question'} resolution of unknown shape`);
        await this.source.answerQuestion(card.id, answers);
      }
      if (this.cards.get(card.key) === card) this.cards.delete(card.key);
      this.scheduleSessions();
    } catch (err) {
      this.log.warn?.({ id: card.id, err: describe(err) }, 'jarvis runtime: answering a card failed');
      card.state = 'failed';
    }
  }
}
