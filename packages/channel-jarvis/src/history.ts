/**
 * Sessions active in a time window (`sessions.history`, Persona issue nwverse/persona#11529): the window, the
 * order and the cursor every runtime's `listHistory` shares.
 *
 * Ported from the Persona runtime SDK, `integrations/runtime-sdk/lib/history.js` at commit e4b2e0fa98 (PR
 * nwverse/persona#11534; unchanged by a5bbdc6cff, #11546), and kept semantically identical to it: same param checks,
 * same time key (`active_at`, else `updated_at`, else `started_at`), same `[since, until)` window, same order
 * (newest first, ties by session id ascending), same opaque cursor (base64url JSON `{t, k}`), same default and
 * maximum limit, same normalization of a driver's answer. Only the types are added. Change it only together with
 * the SDK.
 *
 * @module @enkeep/channel-jarvis/history
 */

import { RpcError } from './rpc.js';

export const HISTORY_LIMIT = 200;
export const HISTORY_MAX = 500;

/** `sessions.history`'s params as the node sends them. */
export interface HistoryQuery {
  since: string;
  until?: string;
  cursor?: string;
  limit?: number;
}

/** What a source's `listHistory` gets: the params checked, `until` filled in (now when left out). */
export interface HistoryParams {
  since: string;
  until: string;
  cursor: string;
  limit: number;
}

export interface HistoryPageResult<R> {
  rows: R[];
  /** Opaque; empty on the last page. */
  next_cursor: string;
  /** Whether the rows given are all the runtime has for the window. */
  complete: boolean;
}

type AnyRow = Record<string, unknown> | null | undefined;

/** A row's time: when it was last active (active_at), else updated_at, else started_at. 0 when none parses. */
export const historyAt = (r: AnyRow): number =>
  Date.parse(r?.active_at as string) || Date.parse(r?.updated_at as string) || Date.parse(r?.started_at as string) || 0;

const deleted = (r: AnyRow): boolean => r?.status === 'deleted' || r?.deleted === true;
const bad = (message: string) => new RpcError(message, 'invalid');

/** sessions.history's params checked: since / until in ms (until defaults to now), limit within 1…500. */
export function historyParams(p: Record<string, unknown> = {}): { since: number; until: number; limit: number; cursor: string } {
  const since = Date.parse(p.since as string);
  if (typeof p.since !== 'string' || Number.isNaN(since)) throw bad('since must be an RFC 3339 time');
  let until = Date.now();
  if (p.until != null && p.until !== '') {
    until = Date.parse(p.until as string);
    if (typeof p.until !== 'string' || Number.isNaN(until)) throw bad('until must be an RFC 3339 time');
  }
  let limit = HISTORY_LIMIT;
  if (p.limit != null) {
    limit = Math.trunc(Number(p.limit));
    if (!(limit >= 1)) throw bad('limit must be a positive number');
    limit = Math.min(limit, HISTORY_MAX);
  }
  const cursor = typeof p.cursor === 'string' ? p.cursor : '';
  return { since, until, limit, cursor };
}

function decode(c: string): { t: number; k: string } | undefined {
  if (!c) return undefined;
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString()) as { t?: unknown; k?: unknown };
    if (typeof v.t === 'number' && typeof v.k === 'string') return { t: v.t, k: v.k };
  } catch {}
  throw bad('malformed cursor');
}

/**
 * One page of rows in [since, until) by active_at (else updated_at, else started_at), newest first (ties by
 * session_id), after cursor; deleted rows (status "deleted" or deleted: true) left out. `complete`: whether the rows
 * given are all the runtime has for the window (default true).
 */
export function historyPage<R>(
  rows: readonly R[] | null | undefined,
  params: Record<string, unknown> | HistoryQuery,
  o: { complete?: boolean; id?: (row: R) => string; updatedAt?: (row: R) => number } = {}
): HistoryPageResult<R> {
  const { since, until, limit, cursor } = historyParams(params as Record<string, unknown>);
  const after = decode(cursor);
  const id = o.id ?? ((r: R) => String((r as AnyRow)?.session_id ?? ''));
  const t = o.updatedAt ?? ((r: R) => historyAt(r as AnyRow));
  const list: Array<{ r: R; u: number; k: string }> = [];
  for (const r of rows ?? []) {
    const k = id(r);
    const u = t(r);
    if (!k || !u || u < since || u >= until || deleted(r as AnyRow)) continue;
    if (after && (u > after.t || (u === after.t && k <= after.k))) continue;
    list.push({ r, u, k });
  }
  list.sort((a, b) => b.u - a.u || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  const page = list.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page.map((x) => x.r),
    next_cursor: list.length > limit && last ? Buffer.from(JSON.stringify({ t: last.u, k: last.k })).toString('base64url') : '',
    complete: o.complete !== false,
  };
}

/** What a source's listHistory answered, as sessions.history returns it. */
export function historyResult(res: unknown): HistoryPageResult<Record<string, unknown>> {
  const r = res as { rows?: unknown; next_cursor?: unknown; complete?: unknown } | null | undefined;
  return {
    rows: Array.isArray(r?.rows)
      ? (r.rows as AnyRow[]).filter(
          (row): row is Record<string, unknown> => !!row && typeof row.session_id === 'string' && row.session_id !== '' && !deleted(row)
        )
      : [],
    next_cursor: typeof r?.next_cursor === 'string' ? r.next_cursor : '',
    complete: r?.complete === true,
  };
}
