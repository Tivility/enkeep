/**
 * Test helpers: an in-memory message socket pair, synthetic DSH events and a fake source.
 * All values are synthetic.
 */

import type {
  DshSessionEvent,
  JarvisChannelSource,
  JarvisSessionRow,
  JarvisSourceListener,
  PendingApprovalCard,
  PendingQuestionCard,
  QuestionAnswers,
  ReadEventsQuery,
  ReadEventsResult,
} from '../src/source.js';
import type { MessageSocket } from '../src/rpc.js';

export interface MemorySocket extends MessageSocket {
  /** Frames this side sent. */
  readonly sent: string[];
  readonly closed: boolean;
}

/** Two connected sockets; delivery is asynchronous (microtask), close reaches both sides. */
export function memorySocketPair(): [MemorySocket, MemorySocket] {
  const make = (): MemorySocket & { deliver(data: string): void; shut(code: number, reason: string): void; peer?: ReturnType<typeof make> } => {
    const messageListeners: Array<(data: string) => void> = [];
    const closeListeners: Array<(code: number, reason: string) => void> = [];
    const side = {
      sent: [] as string[],
      closed: false,
      peer: undefined as ReturnType<typeof make> | undefined,
      send(data: string): void {
        if (side.closed) return;
        side.sent.push(data);
        const target = side.peer!;
        queueMicrotask(() => target.deliver(data));
      },
      onMessage(listener: (data: string) => void): void {
        messageListeners.push(listener);
      },
      onClose(listener: (code: number, reason: string) => void): void {
        closeListeners.push(listener);
      },
      close(code = 1000, reason = ''): void {
        if (side.closed) return;
        side.shut(code, reason);
        side.peer!.shut(code, reason);
      },
      deliver(data: string): void {
        if (side.closed) return;
        for (const l of messageListeners) l(data);
      },
      shut(code: number, reason: string): void {
        if (side.closed) return;
        side.closed = true;
        for (const l of closeListeners) l(code, reason);
      },
    };
    return side;
  };
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

export async function waitFor<T>(probe: () => T | undefined | null | false, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Synthetic DSH events

export const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

export function ev(seq: number, type: string, data: unknown, extra: Record<string, unknown> = {}): DshSessionEvent {
  return { seq, type, time: T0 + seq * 1000, data, ...extra };
}

export function userMessage(seq: number, content: unknown, source: unknown = { kind: 'user' }): DshSessionEvent {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  return ev(seq, 'user/message', { id: `msg_u${seq}`, role: 'user', content: blocks, source }, { surfaceOp: 'append' });
}

export function assistantMessage(seq: number, blocks: unknown[], extra: Record<string, unknown> = {}): DshSessionEvent {
  return ev(
    seq,
    'assistant/message',
    {
      turn: 1,
      step: 1,
      message: { id: `msg_a${seq}`, role: 'assistant', content: blocks, source: { kind: 'model', provider: 'synth', model: 'synth-model' } },
      stream: [],
      ...extra,
    },
    { surfaceOp: 'append' },
  );
}

export function toolResult(seq: number, callId: string, content: unknown[], isError = false, error?: unknown): DshSessionEvent {
  const data: Record<string, unknown> = {
    turn: 1,
    step: 1,
    message: { id: `msg_t${seq}`, role: 'tool', content, source: { kind: 'tool', callId }, toolCallId: callId, isError },
  };
  if (error !== undefined) data.error = error;
  return ev(seq, 'tool/result', data, { surfaceOp: 'append' });
}

export function turnStart(seq: number, turn = 1): DshSessionEvent {
  return ev(seq, 'turn/start', { turn });
}

export function turnEnd(seq: number, reason: unknown = { kind: 'completed' }, turn = 1): DshSessionEvent {
  return ev(seq, 'turn/end', { turn, reason });
}

/** `turns` turns of 4 events each: turn/start, user text, assistant text, turn/end. */
export function conversation(turns: number): DshSessionEvent[] {
  const events: DshSessionEvent[] = [];
  for (let t = 0; t < turns; t++) {
    const base = t * 4;
    events.push(turnStart(base, t + 1));
    events.push(userMessage(base + 1, `question ${t + 1}`));
    events.push(assistantMessage(base + 2, [{ type: 'text', text: `answer ${t + 1}` }]));
    events.push(turnEnd(base + 3, { kind: 'completed' }, t + 1));
  }
  return events;
}

// ---------------------------------------------------------------------------
// Fake source

export const SESSION_A = 'ses_00000000000000000000000000000001';
export const SESSION_B = 'ses_00000000000000000000000000000002';
export const SESSION_C = 'ses_00000000000000000000000000000003';

export function row(sessionId: string, status: JarvisSessionRow['status'] = 'idle', title = 'Synthetic session'): JarvisSessionRow {
  return { session_id: sessionId, title, status, updated_at: new Date(T0).toISOString(), cwd: '/tmp/enkeep-test/space-one' };
}

export class FakeSource implements JarvisChannelSource {
  readonly logs = new Map<string, { history: string; events: DshSessionEvent[] }>();
  rows: JarvisSessionRow[] = [];
  /** Rows only `getSession` knows (not listed). */
  readonly hidden = new Map<string, JarvisSessionRow>();
  readonly listeners = new Set<JarvisSourceListener>();
  readonly reads: Array<{ sessionId: string; query: ReadEventsQuery }> = [];
  readonly sent: Array<{ sessionId: string; text: string; images: unknown[]; clientMsgId: string }> = [];
  readonly approvals: Array<{ id: string; decision: { allow: boolean; message?: string } }> = [];
  readonly answers: Array<{ id: string; answers: QuestionAnswers }> = [];
  readonly images = new Map<string, { mime: string; data: string }>();
  readonly calls: string[] = [];
  sendImpl: ((params: { clientMsgId: string }) => Promise<void>) | null = null;

  setLog(sessionId: string, events: DshSessionEvent[], history = `dsh:synthetic-${sessionId.slice(-4)}`): void {
    this.logs.set(sessionId, { history, events: [...events] });
  }

  /** Append to the log; `notify` also emits the live event. */
  append(sessionId: string, event: DshSessionEvent, notify = true): void {
    const log = this.logs.get(sessionId)!;
    log.events.push(event);
    if (notify) for (const l of this.listeners) l.sessionEvent(sessionId, event, log.history);
  }

  emit<K extends keyof JarvisSourceListener>(name: K, ...args: Parameters<JarvisSourceListener[K]>): void {
    for (const l of this.listeners) (l[name] as (...a: unknown[]) => void)(...args);
  }

  async listSessions(): Promise<JarvisSessionRow[]> {
    this.calls.push('listSessions');
    return this.rows.map((r) => ({ ...r }));
  }

  async getSession(sessionId: string): Promise<JarvisSessionRow | null> {
    return this.rows.find((r) => r.session_id === sessionId) ?? this.hidden.get(sessionId) ?? null;
  }

  async readEvents(sessionId: string, query: ReadEventsQuery): Promise<ReadEventsResult> {
    this.reads.push({ sessionId, query });
    const log = this.logs.get(sessionId);
    if (!log) throw Object.assign(new Error('unknown session'), { code: 'not_found' });
    const all = log.events;
    const lastSeq = all.length > 0 ? all[all.length - 1]!.seq : -1;
    const limit = query.limit ?? 200;
    let page: DshSessionEvent[];
    let hasMore: boolean;
    if (query.afterSeq !== undefined) {
      const after = all.filter((e) => e.seq > query.afterSeq!);
      page = after.slice(0, limit);
      hasMore = after.length > page.length;
    } else if (query.beforeSeq !== undefined) {
      const before = all.filter((e) => e.seq < query.beforeSeq!);
      page = before.slice(Math.max(0, before.length - limit));
      hasMore = before.length > page.length;
    } else {
      page = all.slice(0, limit);
      hasMore = all.length > page.length;
    }
    return { events: page, history: log.history, lastSeq, hasMore };
  }

  async readImage(_sessionId: string, ref: string): Promise<{ mime: string; data: string }> {
    const image = this.images.get(ref);
    if (!image) throw Object.assign(new Error('no image'), { code: 'not_found' });
    return image;
  }

  async send(params: { sessionId: string; text: string; images: Array<{ mime: string; data: string; name?: string }>; clientMsgId: string }): Promise<void> {
    this.sent.push(params);
    if (this.sendImpl) await this.sendImpl(params);
  }

  async interrupt(sessionId: string): Promise<void> {
    this.calls.push(`interrupt:${sessionId}`);
  }

  async start(params: { cwd: string; prompt?: string }): Promise<JarvisSessionRow> {
    this.calls.push(`start:${params.cwd}`);
    const created = row(SESSION_C, 'working', 'New session');
    this.hidden.set(SESSION_C, created);
    return created;
  }

  async rename(sessionId: string, title: string): Promise<void> {
    this.calls.push(`rename:${sessionId}:${title}`);
  }

  async close(sessionId: string): Promise<void> {
    this.calls.push(`close:${sessionId}`);
  }

  async answerApproval(id: string, decision: { allow: boolean; message?: string }): Promise<void> {
    this.approvals.push({ id, decision });
  }

  async answerQuestion(id: string, answers: QuestionAnswers): Promise<void> {
    this.answers.push({ id, answers });
  }

  subscribe(listener: JarvisSourceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function approvalCard(overrides: Partial<PendingApprovalCard> = {}): PendingApprovalCard {
  return {
    id: 'apr_00000000000000000000000000000001',
    sessionId: SESSION_B,
    toolName: 'bash',
    callId: 'call_synth_0001',
    toolInput: { command: 'ls -la' },
    summary: 'ls -la',
    reason: 'Command needs approval',
    ...overrides,
  };
}

export function questionCard(overrides: Partial<PendingQuestionCard> = {}): PendingQuestionCard {
  return {
    id: 'qst_00000000000000000000000000000001',
    sessionId: SESSION_A,
    callId: 'call_synth_0002',
    questions: [
      {
        id: 'q1',
        question: 'Which database?',
        header: 'Database',
        options: [{ label: 'SQLite', description: 'Embedded' }, { label: 'Postgres' }],
      },
      {
        id: 'q2',
        question: 'Which features?',
        options: [{ label: 'Search' }, { label: 'Export' }, { label: 'Sync' }],
        multiSelect: true,
      },
    ],
    ...overrides,
  };
}
