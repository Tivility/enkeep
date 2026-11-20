/**
 * sessions.history (nwverse/persona#11529): the ported paging helper and the runtime's `caps.history` / request
 * handling, over an in-memory node. The historyPage cases mirror the Persona SDK's test/history.test.js at e4b2e0fa98
 * so the port is checked against the same expectations. All values are synthetic.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { HISTORY_LIMIT, HISTORY_MAX, historyPage, historyResult, type HistoryParams } from '../src/history.js';
import { Peer, RpcError } from '../src/rpc.js';
import { JarvisRuntime } from '../src/runtime.js';
import type { JarvisHistoryRow } from '../src/source.js';
import { FakeSource, memorySocketPair, waitFor } from './helpers.js';

const day = 24 * 60 * 60 * 1000;
const base = Date.parse('2026-11-19T00:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
// 450 sessions, one every 4 hours back from base: about 75 days, so a 90-day window holds them all.
const rows: JarvisHistoryRow[] = Array.from({ length: 450 }, (_, i) => ({
  session_id: `s${String(i).padStart(3, '0')}`,
  status: i % 3 ? 'offline' : 'done',
  updated_at: iso(base - i * 4 * 60 * 60 * 1000),
  archived: i % 7 === 0,
}));

function all(list: readonly JarvisHistoryRow[], params: Record<string, unknown>) {
  const out: JarvisHistoryRow[] = [];
  let cursor = '';
  for (let i = 0; i < 100; i++) {
    const page = historyPage(list, { ...params, cursor });
    out.push(...page.rows);
    if (!page.next_cursor) return { rows: out, pages: i + 1, complete: page.complete };
    cursor = page.next_cursor;
  }
  throw new Error('no last page');
}

describe('historyPage (ported from the Persona runtime SDK)', () => {
  it('pages a window newest first until every row in it is listed once', () => {
    const since = iso(base - 90 * day);
    const got = all(rows, { since, until: iso(base + 1), limit: 100 });
    expect(got.pages).toBe(5);
    expect(got.rows.length).toBe(450);
    expect(new Set(got.rows.map((r) => r.session_id)).size).toBe(450);
    expect(got.rows.map((r) => r.session_id)).toEqual(rows.map((r) => r.session_id));
    expect(got.complete).toBe(true);
    // [since, until): the session at until is out, the one at since in.
    const w = historyPage(rows, { since: rows[10]!.updated_at, until: rows[2]!.updated_at, limit: 500 });
    expect(w.rows.map((r) => r.session_id)).toEqual(['s003', 's004', 's005', 's006', 's007', 's008', 's009', 's010']);
    expect(w.next_cursor).toBe('');
  });

  it('breaks ties by session id, takes started_at when updated_at is missing and clamps the limit', () => {
    const t = iso(base - day);
    const tied = ['c', 'a', 'b', 'e', 'd'].map((id) => ({ session_id: id, updated_at: t }));
    const window = { since: iso(base - 2 * day), until: iso(base), limit: 2 };
    const first = historyPage(tied, window);
    expect(first.rows.map((r) => r.session_id)).toEqual(['a', 'b']);
    const second = historyPage(tied, { ...window, cursor: first.next_cursor });
    expect(second.rows.map((r) => r.session_id)).toEqual(['c', 'd']);
    const third = historyPage(tied, { ...window, cursor: second.next_cursor });
    expect(third.rows.map((r) => r.session_id)).toEqual(['e']);
    expect(third.next_cursor).toBe('');

    const started = historyPage([{ session_id: 'x', started_at: t }, { session_id: 'y' }], { since: iso(base - 2 * day), until: iso(base) });
    expect(started.rows.map((r) => r.session_id)).toEqual(['x']);

    expect(historyPage(rows, { since: iso(base - 90 * day), until: iso(base + 1) }).rows.length).toBe(HISTORY_LIMIT);
    expect(historyPage(rows, { since: iso(base - 90 * day), until: iso(base + 1), limit: 10_000 }).rows.length).toBe(HISTORY_MAX - 50);
    expect(historyPage(rows, { since: iso(base - 90 * day), until: iso(base + 1) }, { complete: false }).complete).toBe(false);
    expect(() => historyPage(rows, {})).toThrow(/since/);
    expect(() => historyPage(rows, { since: 'yesterday' })).toThrow(/since/);
    expect(() => historyPage(rows, { since: t, cursor: 'nope' })).toThrow(/cursor/);
    expect(() => historyPage(rows, { since: t, limit: 0 })).toThrow(/limit/);
  });

  it('windows and orders by active_at before updated_at, and leaves deleted sessions out', () => {
    const list = [
      // Archived today, last active 20 days ago: archiving moved its updated_at, not when it was used.
      { session_id: 'archived-old', archived: true, updated_at: iso(base - day), active_at: iso(base - 20 * day) },
      { session_id: 'archived-in', archived: true, updated_at: iso(base - day), active_at: iso(base - 5 * day), origin: 'automation', user_messages: 0 },
      { session_id: 'plain', updated_at: iso(base - 2 * day), origin: 'user', user_messages: 3 },
      { session_id: 'gone', status: 'deleted', updated_at: iso(base - 2 * day) },
      { session_id: 'gone-too', deleted: true, active_at: iso(base - 3 * day) },
    ];
    const page = historyPage(list, { since: iso(base - 10 * day), until: iso(base) });
    expect(page.rows.map((r) => r.session_id)).toEqual(['plain', 'archived-in']);
    expect(page.rows[1]).toMatchObject({ archived: true, origin: 'automation', user_messages: 0 });
  });

  it('cursors are the SDK\'s: base64url JSON of the last row\'s time and id', () => {
    const page = historyPage(rows, { since: iso(base - 90 * day), until: iso(base + 1), limit: 1 });
    expect(JSON.parse(Buffer.from(page.next_cursor, 'base64url').toString())).toEqual({ t: base, k: 's000' });
  });

  it('historyResult keeps rows with an id that are not deleted, and complete only when said', () => {
    expect(historyResult({ rows: [{ session_id: 'a' }, { title: 'no id' }, null, { session_id: 'd', status: 'deleted' }] })).toEqual({
      rows: [{ session_id: 'a' }],
      next_cursor: '',
      complete: false,
    });
    expect(historyResult(undefined)).toEqual({ rows: [], next_cursor: '', complete: false });
  });
});

class HistorySource extends FakeSource {
  seen: HistoryParams[] = [];
  answer?: (params: HistoryParams) => unknown;
  constructor(private readonly history: JarvisHistoryRow[]) {
    super();
  }
  async listHistory(params: HistoryParams) {
    this.seen.push(params);
    if (this.answer) return this.answer(params) as never;
    return historyPage(this.history, params);
  }
}

const runtimes: JarvisRuntime[] = [];
afterEach(() => {
  for (const r of runtimes.splice(0)) r.stop();
});

/** A node (in-memory) a runtime over `source` said hello to. */
async function connect(source: FakeSource): Promise<{ node: Peer; hello: Record<string, unknown> }> {
  const [runtimeSocket, nodeSocket] = memorySocketPair();
  const node = new Peer(nodeSocket, { idPrefix: 'n', defaultTimeoutMs: 2000 });
  let hello: Record<string, unknown> | undefined;
  node.setEventHandler(() => {});
  node.setRequestHandler(async (method, params) => {
    if (method === 'runtime.hello') {
      hello = params as Record<string, unknown>;
      return { protocol: 1, node_version: '0.0.0-test', hub: true, features: [] };
    }
    return {};
  });
  const runtime = new JarvisRuntime(runtimeSocket, source, { version: '0.0.0-test', log: {} });
  runtimes.push(runtime);
  await runtime.start();
  return { node, hello: await waitFor(() => hello) };
}

describe('JarvisRuntime: sessions.history', () => {
  it('declares caps.history when the source lists history, and the node pages sessions.history until the end', async () => {
    const source = new HistorySource(rows);
    const { node, hello } = await connect(source);
    expect((hello.caps as Record<string, unknown>).history).toBe(true);

    const since = iso(base - 90 * day);
    const got: JarvisHistoryRow[] = [];
    let cursor = '';
    let pages = 0;
    do {
      const page = (await node.call('sessions.history', { since, until: iso(base + 1), cursor, limit: 200 })) as {
        rows: JarvisHistoryRow[];
        next_cursor: string;
        complete: boolean;
      };
      got.push(...page.rows);
      expect(page.complete).toBe(true);
      cursor = page.next_cursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(got.length).toBe(450);
    expect(new Set(got.map((r) => r.session_id)).size).toBe(450);
    expect(got.some((r) => r.archived)).toBe(true);

    // until left out: the source gets now, and the limit is clamped to 500.
    await node.call('sessions.history', { since, limit: 9999 });
    const last = source.seen[source.seen.length - 1]!;
    expect(last.limit).toBe(500);
    expect(Math.abs(Date.parse(last.until) - Date.now())).toBeLessThan(60_000);
    await expect(node.call('sessions.history', { until: iso(base) })).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/since/) });
    await expect(node.call('sessions.history', { since, cursor: 'nope' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('a source without listHistory declares no caps.history and refuses sessions.history as unsupported', async () => {
    const { node, hello } = await connect(new FakeSource());
    expect(hello.caps).toEqual({ start: true, send: true, interrupt: true, rename: true, close: true });
    await expect(node.call('sessions.history', { since: iso(base - day) })).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('normalizes what the source answered: rows without an id and deleted rows dropped', async () => {
    const source = new HistorySource([]);
    source.answer = () => ({ rows: [{ session_id: 'a', archived: false }, { title: 'no id' }, { session_id: 'b', status: 'deleted' }], complete: true });
    const { node } = await connect(source);
    expect(await node.call('sessions.history', { since: iso(base - day) })).toEqual({ rows: [{ session_id: 'a', archived: false }], next_cursor: '', complete: true });
  });

  it('a source error with a code reaches the node as that code', async () => {
    const source = new HistorySource([]);
    source.answer = () => {
      throw new RpcError('this Jarvis token is no longer valid', 'unauthorized');
    };
    const { node } = await connect(source);
    await expect(node.call('sessions.history', { since: iso(base - day) })).rejects.toMatchObject({ code: 'unauthorized' });
  });
});
