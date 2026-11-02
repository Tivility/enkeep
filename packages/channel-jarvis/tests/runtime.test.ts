import { afterEach, describe, expect, it } from 'vitest';
import { Peer, RpcError } from '../src/rpc.js';
import { JARVIS_RUNTIME_INSTANCE, JarvisRuntime, type JarvisRuntimeOptions } from '../src/runtime.js';
import type { JarvisSessionRow } from '../src/source.js';
import {
  FakeSource,
  SESSION_A,
  SESSION_B,
  SESSION_C,
  approvalCard,
  assistantMessage,
  conversation,
  delay,
  memorySocketPair,
  questionCard,
  row,
  toolResult,
  userMessage,
  waitFor,
  type MemorySocket,
} from './helpers.js';

interface NodeEvent {
  event: string;
  params: Record<string, unknown>;
}

interface Harness {
  runtime: JarvisRuntime;
  source: FakeSource;
  node: Peer;
  nodeSocket: MemorySocket;
  events: NodeEvent[];
  requests: Array<{ method: string; params: Record<string, unknown> }>;
  /** Answer node-side requests (runtime.hello is answered with `hello`). */
  respond: (method: string, params: Record<string, unknown>) => unknown;
  of(event: string): Array<Record<string, unknown>>;
}

const harnesses: Harness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.runtime.stop();
});

async function setup(options: { hello?: Record<string, unknown>; source?: FakeSource; runtime?: Partial<JarvisRuntimeOptions>; start?: boolean } = {}): Promise<Harness> {
  const [runtimeSocket, nodeSocket] = memorySocketPair();
  const source = options.source ?? new FakeSource();
  const node = new Peer(nodeSocket, { idPrefix: 'n', defaultTimeoutMs: 2000 });
  const harness: Harness = {
    runtime: undefined as unknown as JarvisRuntime,
    source,
    node,
    nodeSocket,
    events: [],
    requests: [],
    respond: () => ({}),
    of(event) {
      return harness.events.filter((e) => e.event === event).map((e) => e.params);
    },
  };
  node.setEventHandler((event, params) => harness.events.push({ event, params: params as Record<string, unknown> }));
  node.setRequestHandler(async (method, params) => {
    harness.requests.push({ method, params: params as Record<string, unknown> });
    if (method === 'runtime.hello') return options.hello ?? { protocol: 1, node_version: '0.0.0-test', hub: true, features: [] };
    return harness.respond(method, params as Record<string, unknown>);
  });
  harness.runtime = new JarvisRuntime(runtimeSocket, source, {
    version: '0.0.0-test',
    log: {},
    timing: { sessionsDebounceMs: 15, itemsCoalesceMs: 15, deltaThrottleMs: 60, nodeGoneRetryMs: 5, nodeGoneWindowMs: 2000 },
    ...options.runtime,
  });
  harnesses.push(harness);
  if (options.start !== false) {
    await harness.runtime.start();
    await waitFor(() => harness.of('runtime.sessions').length >= 1);
  }
  return harness;
}

describe('JarvisRuntime: hello and sessions', () => {
  it('sends runtime.hello first with the runtime fields', async () => {
    const h = await setup();
    const [runtimeFirst] = (h.nodeSocket as unknown as { peer: MemorySocket }).peer.sent;
    const frame = JSON.parse(runtimeFirst!);
    expect(frame.method).toBe('runtime.hello');
    expect(frame.id).toMatch(/^e\d+$/);
    expect(frame.params).toEqual({
      runtime: 'enkeep',
      name: 'Enkeep',
      agent: 'dsh',
      version: '0.0.0-test',
      instance: JARVIS_RUNTIME_INSTANCE,
      launcher: 'enkeep',
      launcher_model: 'DeepSeek Harness',
      caps: { start: true, send: true, interrupt: true, rename: true, close: true },
    });
    expect(JARVIS_RUNTIME_INSTANCE).toMatch(/^[0-9a-f]{16}$/);
    expect(h.runtime.hubConnected).toBe(true);
  });

  it('closes the connection when hello fails', async () => {
    const [runtimeSocket, nodeSocket] = memorySocketPair();
    const node = new Peer(nodeSocket);
    node.setRequestHandler(() => {
      throw new RpcError('bad protocol', 'unsupported');
    });
    const runtime = new JarvisRuntime(runtimeSocket, new FakeSource(), { version: '0.0.0-test', log: {} });
    await runtime.start();
    expect(nodeSocket.closed).toBe(true);
  });

  it('pushes sessions on change, forces blocked for pending cards and keeps touched sessions', async () => {
    const source = new FakeSource();
    source.rows = [row(SESSION_A, 'working'), row(SESSION_B, 'done')];
    source.hidden.set(SESSION_C, row(SESSION_C, 'idle', 'Old session'));
    const h = await setup({ source, hello: { protocol: 1, hub: false } });
    expect(h.of('runtime.sessions')[0]!.sessions).toEqual(source.rows);

    // A card waits on B (no hub: not asked, but B is blocked).
    source.emit('approvalAsked', approvalCard({ sessionId: SESSION_B }));
    const blocked = await waitFor(() => {
      const last = h.of('runtime.sessions').at(-1)!.sessions as JarvisSessionRow[];
      return last.find((r) => r.session_id === SESSION_B)?.status === 'blocked' ? last : null;
    });
    expect(blocked.find((r) => r.session_id === SESSION_A)!.status).toBe('working');
    expect(h.requests.some((r) => r.method === 'interaction.create')).toBe(false);

    // The phone sends to C, which listSessions does not return: C is listed from now on.
    source.logs.set(SESSION_C, { history: 'dsh:c', events: [] });
    await h.node.call('session.send', { session_id: SESSION_C, text: 'hello', client_msg_id: 'cm_0001' });
    const withC = await waitFor(() => {
      const last = h.of('runtime.sessions').at(-1)!.sessions as JarvisSessionRow[];
      return last.some((r) => r.session_id === SESSION_C) ? last : null;
    });
    expect(withC).toHaveLength(3);

    // Settled elsewhere: B goes back to its own status.
    source.emit('approvalSettled', approvalCard().id);
    await waitFor(() => {
      const last = h.of('runtime.sessions').at(-1)!.sessions as JarvisSessionRow[];
      return last.find((r) => r.session_id === SESSION_B)?.status === 'done';
    });

    // Debounced: a burst of changes is one push.
    const before = h.of('runtime.sessions').length;
    for (let i = 0; i < 10; i++) source.emit('sessionsChanged');
    await delay(60);
    expect(h.of('runtime.sessions').length - before).toBe(1);
  });

  it('refreshes periodically', async () => {
    const h = await setup({ runtime: { timing: { sessionsRefreshMs: 30 } } });
    await waitFor(() => h.of('runtime.sessions').length >= 3);
  });

  it('lists a session waiting for an answer even when listSessions does not', async () => {
    const source = new FakeSource();
    const unlisted = 'ses_00000000000000000000000000000004';
    source.hidden.set(unlisted, row(unlisted, 'working'));
    const h = await setup({ source, hello: { protocol: 1, hub: false } });
    source.emit('approvalAsked', approvalCard({ sessionId: unlisted }));
    const sessions = await waitFor(() => {
      const last = h.of('runtime.sessions').at(-1)!.sessions as JarvisSessionRow[];
      return last.length === 1 ? last : null;
    });
    expect(sessions[0]).toMatchObject({ session_id: unlisted, status: 'blocked' });
  });
});

describe('JarvisRuntime: node requests', () => {
  it('serves session.items, session.item (full text) and session.image', async () => {
    const source = new FakeSource();
    source.setLog(SESSION_A, [
      userMessage(0, 'show me'),
      toolResult(1, 'call_synth_1', [
        { type: 'text', text: 'z'.repeat(5000) },
        { type: 'image', attachment: { attachmentId: 'sha256:00ff', mediaType: 'image/png', bytes: 4, width: 1, height: 1 } },
      ]),
    ]);
    source.images.set('att:sha256:00ff', { mime: 'image/png', data: 'iVBORw==' });
    const h = await setup({ source });

    const page = (await h.node.call('session.items', { session_id: SESSION_A })) as { items: Array<Record<string, unknown>>; to_seq: number };
    expect(page.to_seq).toBe(2);
    expect(page.items.map((i) => i.id)).toEqual(['1#0', '2#0', '2#1']);
    expect(page.items[1]!.full_size).toBe(5000);
    expect(page.items[1]!.role).toBe('user');
    expect(page.items[2]).toMatchObject({ role: 'user', kind: 'image', tool_use_id: 'call_synth_1', image: { mime: 'image/png', data: '', lazy: true } });
    expect(page.items[0]).not.toHaveProperty('person');
    expect(page.items[2]).not.toHaveProperty('ref');

    const full = (await h.node.call('session.item', { session_id: SESSION_A, item_id: '2#0' })) as Record<string, unknown>;
    expect(full).toMatchObject({ id: '2#0', role: 'user', kind: 'tool_result', text: 'z'.repeat(5000) });
    expect(full).not.toHaveProperty('full_size');

    expect(await h.node.call('session.image', { session_id: SESSION_A, item_id: '2#1' })).toEqual({ mime: 'image/png', data: 'iVBORw==' });
    await expect(h.node.call('session.item', { session_id: SESSION_A, item_id: '9#0' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(h.node.call('session.item', { session_id: SESSION_A, item_id: 'bogus' })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(h.node.call('session.items', { session_id: 'ses_unknown' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('answers unknown methods with unsupported and hides uncoded errors', async () => {
    const source = new FakeSource();
    source.interrupt = async () => {
      throw new Error('container path /tmp/enkeep-test/x failed');
    };
    const h = await setup({ source });
    await expect(h.node.call('terminal.open', {})).rejects.toMatchObject({ code: 'unsupported' });
    const err = (await h.node.call('session.interrupt', { session_id: SESSION_A }).catch((e: unknown) => e)) as RpcError;
    expect(err.code).toBe('internal');
    expect(err.message).toBe('internal error');
  });

  it('handles interrupt, rename, close and start', async () => {
    const h = await setup();
    expect(await h.node.call('session.interrupt', { session_id: SESSION_A })).toEqual({ ok: true });
    expect(await h.node.call('session.rename', { session_id: SESSION_A, title: 'Renamed' })).toEqual({ ok: true });
    expect(await h.node.call('session.close', { session_id: SESSION_A })).toEqual({ ok: true });
    const started = (await h.node.call('session.start', { cwd: '/tmp/enkeep-test/space-one', prompt: 'begin' })) as { session: JarvisSessionRow };
    expect(started.session.session_id).toBe(SESSION_C);
    expect(h.source.calls).toEqual(
      expect.arrayContaining([`interrupt:${SESSION_A}`, `rename:${SESSION_A}:Renamed`, `close:${SESSION_A}`, 'start:/tmp/enkeep-test/space-one']),
    );
    // The started session is listed (touched) even though listSessions does not return it.
    await waitFor(() => (h.of('runtime.sessions').at(-1)!.sessions as JarvisSessionRow[]).some((r) => r.session_id === SESSION_C));
    await expect(h.node.call('session.rename', { session_id: SESSION_A })).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('delivers a client_msg_id once; a failed delivery may be retried', async () => {
    const h = await setup();
    let release!: () => void;
    h.source.sendImpl = () => new Promise<void>((r) => (release = r));
    const params = { session_id: SESSION_A, text: 'only once', client_msg_id: 'cm_0001', images: [{ mime: 'image/png', data: 'AAAA', name: 'a.png' }] };
    const first = h.node.call('session.send', params);
    const retry = h.node.call('session.send', params);
    await waitFor(() => h.source.sent.length === 1);
    release();
    expect(await first).toEqual({ ok: true });
    expect(await retry).toEqual({ ok: true });
    expect(await h.node.call('session.send', params)).toEqual({ ok: true });
    expect(h.source.sent).toHaveLength(1);
    expect(h.source.sent[0]).toEqual({ sessionId: SESSION_A, text: 'only once', images: [{ mime: 'image/png', data: 'AAAA', name: 'a.png' }], clientMsgId: 'cm_0001' });

    let fail = true;
    h.source.sendImpl = async () => {
      if (fail) throw Object.assign(new Error('busy'), { code: 'busy' });
    };
    const failing = { session_id: SESSION_A, text: 'retry me', client_msg_id: 'cm_0002' };
    await expect(h.node.call('session.send', failing)).rejects.toMatchObject({ code: 'busy' });
    fail = false;
    expect(await h.node.call('session.send', failing)).toEqual({ ok: true });
    expect(h.source.sent.filter((s) => s.clientMsgId === 'cm_0002')).toHaveLength(2);

    await expect(h.node.call('session.send', { session_id: SESSION_A, text: ' ', client_msg_id: 'cm_0003' })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(h.node.call('session.send', { session_id: SESSION_A, text: 'x' })).rejects.toMatchObject({ code: 'invalid_params' });
  });
});

describe('JarvisRuntime: watch', () => {
  function batches(h: Harness): Array<Record<string, unknown>> {
    return h.of('session.items');
  }

  it('catches up after since_seq in pages, then pushes live batches with continuous seqs', async () => {
    const source = new FakeSource();
    source.rows = [row(SESSION_A, 'working')];
    source.setLog(SESSION_A, conversation(3), 'dsh:history-one'); // dsh seqs 0..11
    const h = await setup({ source, runtime: { paging: { chunkEvents: 3 } } });

    expect(await h.node.call('session.watch', { session_id: SESSION_A, since_seq: 4 })).toEqual({ ok: true });
    await waitFor(() => batches(h).at(-1)?.to_seq === 12);
    const caught = batches(h);
    expect(caught.length).toBeGreaterThan(1);
    expect(caught[0]!.from_seq).toBe(4);
    for (let i = 1; i < caught.length; i++) expect(caught[i]!.from_seq).toBe(caught[i - 1]!.to_seq);
    const caughtTexts = caught.flatMap((b) => (b.items as Array<{ text?: string }>).map((i) => i.text));
    expect(caughtTexts).toEqual(['question 2', 'answer 2', 'question 3', 'answer 3']);
    expect(caught.every((b) => b.history === 'dsh:history-one' && b.session_id === SESSION_A)).toBe(true);

    // Live events within the coalescing window become one batch.
    source.append(SESSION_A, userMessage(12, 'question 4'));
    source.append(SESSION_A, assistantMessage(13, [{ type: 'text', text: 'answer 4' }]));
    await waitFor(() => batches(h).at(-1)?.to_seq === 14);
    const live = batches(h).at(-1)!;
    expect(live.from_seq).toBe(12);
    expect((live.items as Array<{ id: string }>).map((i) => i.id)).toEqual(['13#0', '14#0']);

    // An event whose notification was lost is read back: still continuous.
    source.append(SESSION_A, userMessage(14, 'missed'), false);
    source.append(SESSION_A, assistantMessage(15, [{ type: 'text', text: 'after the gap' }]));
    await waitFor(() => batches(h).at(-1)?.to_seq === 16);
    const after = batches(h).filter((b) => (b.to_seq as number) > 14);
    expect(after[0]!.from_seq).toBe(14);
    expect(after.flatMap((b) => (b.items as Array<{ text?: string }>).map((i) => i.text))).toEqual(['missed', 'after the gap']);

    // A replaced log (new history) is pushed with its new history.
    source.setLog(SESSION_A, [userMessage(0, 'fresh start')], 'dsh:history-two');
    source.append(SESSION_A, assistantMessage(1, [{ type: 'text', text: 'new log' }]));
    const replaced = await waitFor(() => batches(h).find((b) => b.history === 'dsh:history-two'));
    expect(replaced.from_seq).toBe(1);
    expect(replaced.to_seq).toBe(2);

    // Unwatched: nothing more.
    await h.node.call('session.unwatch', { session_id: SESSION_A });
    const count = batches(h).length;
    source.append(SESSION_A, userMessage(2, 'not pushed'));
    await delay(40);
    expect(batches(h).length).toBe(count);
  });

  it('since_seq 0 starts live, and events that yield no item still advance the seq', async () => {
    const source = new FakeSource();
    source.rows = [row(SESSION_A)];
    source.setLog(SESSION_A, conversation(1));
    const h = await setup({ source });
    await h.node.call('session.watch', { session_id: SESSION_A, since_seq: 0 });
    await delay(20);
    expect(batches(h)).toHaveLength(0);
    for (const event of conversation(2).slice(4)) source.append(SESSION_A, event);
    const batch = await waitFor(() => batches(h).at(-1));
    expect(batch.from_seq).toBe(4);
    expect(batch.to_seq).toBe(8);
    expect((batch.items as unknown[]).length).toBe(2);
  });

  it('refuses to watch an unknown session', async () => {
    const h = await setup();
    await expect(h.node.call('session.watch', { session_id: 'ses_unknown', since_seq: 0 })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('throttles deltas: the first at once, then at most one per interval; null ends with an empty string', async () => {
    const source = new FakeSource();
    source.rows = [row(SESSION_A, 'working')];
    source.setLog(SESSION_A, []);
    const h = await setup({ source });
    await h.node.call('session.watch', { session_id: SESSION_A, since_seq: 0 });

    source.emit('delta', SESSION_B, 'not watched');
    source.emit('delta', SESSION_A, 'H');
    await waitFor(() => h.of('session.delta').length === 1);
    source.emit('delta', SESSION_A, 'He');
    source.emit('delta', SESSION_A, 'Hel');
    source.emit('delta', SESSION_A, 'Hell');
    await delay(20);
    expect(h.of('session.delta')).toHaveLength(1);
    await waitFor(() => h.of('session.delta').length === 2);
    source.emit('delta', SESSION_A, null);
    await waitFor(() => h.of('session.delta').length === 3);
    expect(h.of('session.delta')).toEqual([
      { session_id: SESSION_A, text: 'H' },
      { session_id: SESSION_A, text: 'Hell' },
      { session_id: SESSION_A, text: '' },
    ]);
    // After the end marker the next text goes out at once.
    source.emit('delta', SESSION_A, 'N');
    await waitFor(() => h.of('session.delta').length === 4);
  });
});

describe('JarvisRuntime: interactions', () => {
  it('asks permission and answers allow', async () => {
    const h = await setup();
    h.respond = (method) => (method === 'interaction.create' ? { allow: true } : {});
    h.source.emit('approvalAsked', approvalCard());
    await waitFor(() => h.source.approvals.length === 1);
    expect(h.source.approvals[0]).toEqual({ id: approvalCard().id, decision: { allow: true } });
    const asked = h.requests.find((r) => r.method === 'interaction.create')!.params;
    expect(asked).toEqual({
      interaction: {
        id: approvalCard().id,
        kind: 'permission',
        session_id: SESSION_B,
        tool_name: 'Bash',
        tool_input: { command: 'ls -la' },
        tool_use_id: 'call_synth_0001',
        summary: 'ls -la',
        reason: 'Command needs approval',
      },
      timeout_seconds: 600,
    });
  });

  it('answers deny with the message; uses the card expiry for timeout_seconds', async () => {
    const now = Date.UTC(2026, 0, 1);
    const h = await setup({ runtime: { now: () => now } });
    h.respond = () => ({ allow: false, message: 'Use a dry run first' });
    h.source.emit('approvalAsked', approvalCard({ expiresAt: new Date(now + 90_000).toISOString() }));
    await waitFor(() => h.source.approvals.length === 1);
    expect(h.source.approvals[0]!.decision).toEqual({ allow: false, message: 'Use a dry run first' });
    expect(h.requests.find((r) => r.method === 'interaction.create')!.params.timeout_seconds).toBe(90);
  });

  it('does nothing on dismiss', async () => {
    const h = await setup();
    h.respond = () => ({ dismiss: true });
    h.source.emit('approvalAsked', approvalCard());
    await waitFor(() => h.requests.some((r) => r.method === 'interaction.create'));
    await delay(20);
    expect(h.source.approvals).toEqual([]);
  });

  it('cancels the card when it is settled elsewhere', async () => {
    const h = await setup();
    let answer!: (value: unknown) => void;
    h.respond = () => new Promise((r) => (answer = r));
    h.source.emit('approvalAsked', approvalCard());
    await waitFor(() => h.requests.some((r) => r.method === 'interaction.create'));
    h.source.emit('approvalSettled', approvalCard().id);
    await waitFor(() => h.of('interaction.cancel').length === 1);
    expect(h.of('interaction.cancel')[0]).toEqual({ id: approvalCard().id });
    answer({ allow: true });
    await delay(20);
    expect(h.source.approvals).toEqual([]);
  });

  it('asks only when a hub is connected', async () => {
    const h = await setup({ hello: { protocol: 1, hub: false } });
    h.respond = () => ({ allow: true });
    h.source.emit('approvalAsked', approvalCard());
    await delay(30);
    expect(h.requests.some((r) => r.method === 'interaction.create')).toBe(false);
    h.node.notify('runtime.hub', { connected: true });
    await waitFor(() => h.source.approvals.length === 1);
  });

  it('retries the same id on node_gone', async () => {
    const h = await setup();
    let attempts = 0;
    h.respond = () => {
      attempts++;
      if (attempts < 3) throw new RpcError('node restarted', 'node_gone');
      return { allow: true };
    };
    h.source.emit('approvalAsked', approvalCard());
    await waitFor(() => h.source.approvals.length === 1);
    const ids = h.requests.filter((r) => r.method === 'interaction.create').map((r) => (r.params.interaction as { id: string }).id);
    expect(ids).toEqual([approvalCard().id, approvalCard().id, approvalCard().id]);
  });

  it('gives up on node_gone after the retry window', async () => {
    const h = await setup({ runtime: { timing: { nodeGoneRetryMs: 5, nodeGoneWindowMs: 30, sessionsDebounceMs: 15 } } });
    h.respond = () => {
      throw new RpcError('node restarted', 'node_gone');
    };
    h.source.emit('approvalAsked', approvalCard());
    await delay(120);
    const count = h.requests.filter((r) => r.method === 'interaction.create').length;
    expect(count).toBeGreaterThan(1);
    await delay(40);
    expect(h.requests.filter((r) => r.method === 'interaction.create').length).toBe(count);
  });

  it('asks questions and maps the answers', async () => {
    const h = await setup();
    h.respond = () => ({ answers: { 'Which database?': 'SQLite', 'Which features?': 'Search, Sync' } });
    h.source.emit('questionAsked', questionCard());
    await waitFor(() => h.source.answers.length === 1);
    expect(h.source.answers[0]).toEqual({
      id: questionCard().id,
      answers: [
        { id: 'q1', selected: ['SQLite'] },
        { id: 'q2', selected: ['Search', 'Sync'] },
      ],
    });
    const asked = h.requests.find((r) => r.method === 'interaction.create')!.params.interaction;
    expect(asked).toEqual({
      id: questionCard().id,
      kind: 'question',
      session_id: SESSION_A,
      tool_use_id: 'call_synth_0002',
      questions: [
        { question: 'Which database?', header: 'Database', options: [{ label: 'SQLite', description: 'Embedded' }, { label: 'Postgres' }], multi_select: false },
        { question: 'Which features?', options: [{ label: 'Search' }, { label: 'Export' }, { label: 'Sync' }], multi_select: true },
      ],
    });

    h.respond = () => ({ answers: { 'Which database?': 'Something embedded and small' } });
    h.source.emit('questionAsked', questionCard({ id: 'qst_00000000000000000000000000000002' }));
    await waitFor(() => h.source.answers.length === 2);
    expect(h.source.answers[1]!.answers).toEqual([
      { id: 'q1', selected: [], custom: 'Something embedded and small' },
      { id: 'q2', selected: [] },
    ]);
  });

  it('asks plan reviews and maps approve / feedback', async () => {
    const h = await setup();
    const plan = (id: string, withOptions: boolean) =>
      questionCard({
        id,
        plan: '1. Add tests\n2. Ship',
        questions: withOptions ? [{ id: 'plan_q', question: 'Approve the plan?', options: [{ label: 'Revise' }, { label: 'Approve' }] }] : [],
      });

    h.respond = () => ({ approve: true });
    h.source.emit('questionAsked', plan('qst_plan_0001', true));
    await waitFor(() => h.source.answers.length === 1);
    expect(h.source.answers[0]!.answers).toEqual([{ id: 'plan_q', selected: ['Approve'] }]);
    expect(h.requests.find((r) => r.method === 'interaction.create')!.params.interaction).toEqual({
      id: 'qst_plan_0001',
      kind: 'plan',
      session_id: SESSION_A,
      tool_use_id: 'call_synth_0002',
      plan: '1. Add tests\n2. Ship',
    });

    h.respond = () => ({ approve: false, feedback: 'Add a rollback step' });
    h.source.emit('questionAsked', plan('qst_plan_0002', true));
    await waitFor(() => h.source.answers.length === 2);
    expect(h.source.answers[1]!.answers).toEqual([{ id: 'plan_q', selected: ['Revise'], custom: 'Add a rollback step' }]);

    h.respond = () => ({ approve: true });
    h.source.emit('questionAsked', plan('qst_plan_0003', false));
    await waitFor(() => h.source.answers.length === 3);
    expect(h.source.answers[2]!.answers).toEqual([{ id: 'plan', selected: ['approve'] }]);
  });

  it('cancels a question settled elsewhere and stops on close', async () => {
    const h = await setup();
    h.respond = () => new Promise(() => undefined);
    h.source.emit('questionAsked', questionCard());
    await waitFor(() => h.requests.some((r) => r.method === 'interaction.create'));
    h.source.emit('questionSettled', questionCard().id);
    await waitFor(() => h.of('interaction.cancel').length === 1);

    h.nodeSocket.close(1000, 'bye');
    expect(h.source.listeners.size).toBe(0);
  });
});
