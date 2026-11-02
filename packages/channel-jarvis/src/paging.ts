/**
 * `session.items` paging over mapped items (§8.4), built on bounded `source.readEvents` reads.
 *
 * - no position: the last `turns` turns (default 2), or the last `limit` items when only `limit` is
 *   given; read backwards in chunks until enough turns/items are found or a work cap is hit;
 * - `before_seq`: the same, over items with seq < before_seq;
 * - `after_seq`: items with seq > after_seq, oldest first, up to `limit`; returns `from_seq =
 *   after_seq` and `more_after` when it stopped early;
 * - `from_seq` + `through_seq`: the items with from_seq ≤ seq ≤ through_seq (`{items, more}`).
 *
 * A turn starts at the person's message ({@link isTurnStart}). Pages never split one event's items,
 * so `before_seq = items[0].seq` / `after_seq = to_seq` continue cleanly.
 *
 * @module @enkeep/channel-jarvis/paging
 */

import { isTurnStart, mapEvent, type JarvisItem } from './mapper.js';
import { RpcError } from './rpc.js';
import type { DshSessionEvent, JarvisChannelSource, ReadEventsResult } from './source.js';

export interface ItemsQuery {
  before_seq?: number;
  after_seq?: number;
  turns?: number;
  limit?: number;
  from_seq?: number;
  through_seq?: number;
}

export interface ItemsPage {
  items: JarvisItem[];
  has_more: boolean;
  more_after?: boolean;
  history: string;
  to_seq: number;
  from_seq?: number;
}

export interface RangePage {
  items: JarvisItem[];
  more: boolean;
  history: string;
  to_seq: number;
}

export interface PagingLimits {
  /** Events per `readEvents` call. */
  chunkEvents: number;
  /** Events read per request at most. */
  maxScanEvents: number;
  /** Items per page at most. */
  maxItems: number;
  /** Rough size of a page's items at most (bytes). */
  maxBytes: number;
  defaultTurns: number;
  defaultAfterLimit: number;
}

export const DEFAULT_PAGING_LIMITS: PagingLimits = {
  chunkEvents: 200,
  maxScanEvents: 5000,
  maxItems: 1000,
  maxBytes: 8 * 1024 * 1024,
  defaultTurns: 2,
  defaultAfterLimit: 500,
};

/** A rough wire size of an item (text and tool input dominate). */
export function estimateItemSize(item: JarvisItem): number {
  let size = 200;
  if (item.text) size += item.text.length * 2;
  if (item.tool_input) size += JSON.stringify(item.tool_input).length;
  return size;
}

function optionalSeq(params: Record<string, unknown>, key: keyof ItemsQuery, min: number): number | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new RpcError(`${key} must be an integer ≥ ${min}`, 'invalid_params');
  }
  return value;
}

/** Validate the paging fields of `session.items` params. */
export function parseItemsQuery(params: Record<string, unknown>): ItemsQuery {
  const query: ItemsQuery = {};
  const before = optionalSeq(params, 'before_seq', 1);
  const after = optionalSeq(params, 'after_seq', 0);
  const turns = optionalSeq(params, 'turns', 1);
  const limit = optionalSeq(params, 'limit', 1);
  const from = optionalSeq(params, 'from_seq', 0);
  const through = optionalSeq(params, 'through_seq', 0);
  if (before !== undefined) query.before_seq = before;
  if (after !== undefined) query.after_seq = after;
  if (turns !== undefined) query.turns = turns;
  if (limit !== undefined) query.limit = limit;
  if (from !== undefined) query.from_seq = from;
  if (through !== undefined) query.through_seq = through;
  return query;
}

/** Answer a `session.items` request (a range query when `from_seq` and `through_seq` are both set). */
export async function readItems(
  source: JarvisChannelSource,
  sessionId: string,
  query: ItemsQuery,
  limits: PagingLimits = DEFAULT_PAGING_LIMITS,
): Promise<ItemsPage | RangePage> {
  if (query.from_seq !== undefined && query.through_seq !== undefined) {
    return readRange(source, sessionId, query.from_seq, query.through_seq, query.limit, limits);
  }
  if (query.after_seq !== undefined) return readAfter(source, sessionId, query.after_seq, query.limit, limits);
  return readTail(source, sessionId, query, limits);
}

/** Index of the first item of the event `items[index]` belongs to. */
function eventStart(items: readonly JarvisItem[], index: number): number {
  let i = index;
  while (i > 0 && items[i - 1]!.seq === items[index]!.seq) i--;
  return i;
}

/** Turn-start indexes; a start at index 0 counts only when nothing older exists. */
function turnStarts(items: readonly JarvisItem[], olderExists: boolean): number[] {
  const starts: number[] = [];
  for (let i = 0; i < items.length; i++) {
    if (isTurnStart(items[i]!, items[i - 1]) && (i > 0 || !olderExists)) starts.push(i);
  }
  return starts;
}

/** Move `start` forward (to event boundaries) until the page's rough size fits `maxBytes`. */
function fitBytes(items: readonly JarvisItem[], start: number, maxBytes: number): number {
  let total = 0;
  for (let i = items.length - 1; i >= start; i--) {
    total += estimateItemSize(items[i]!);
    if (total > maxBytes) {
      // Keep at least the newest event.
      let next = i + 1;
      while (next < items.length && items[next]!.seq === items[i]!.seq) next++;
      return next >= items.length ? eventStart(items, items.length - 1) : next;
    }
  }
  return start;
}

async function readTail(source: JarvisChannelSource, sessionId: string, query: ItemsQuery, limits: PagingLimits): Promise<ItemsPage> {
  const turnsMode = query.turns !== undefined || query.limit === undefined;
  const turns = query.turns ?? limits.defaultTurns;
  const limit = Math.min(query.limit ?? limits.maxItems, limits.maxItems);

  // DSH seq < before_seq - 1  ⇔  Jarvis seq < before_seq.
  let cursor = query.before_seq !== undefined ? query.before_seq - 1 : Number.MAX_SAFE_INTEGER;
  let collected: JarvisItem[] = [];
  let olderExists = false;
  let first: ReadEventsResult | null = null;
  let scanned = 0;
  let bytes = 0;

  for (;;) {
    const res = await source.readEvents(sessionId, { beforeSeq: cursor, limit: limits.chunkEvents });
    if (!first) first = res;
    else if (res.history !== first.history) break;
    const events = res.events.filter((e) => e.seq < cursor);
    scanned += events.length;
    const items: JarvisItem[] = [];
    for (const event of events) items.push(...mapEvent(event));
    for (const item of items) bytes += estimateItemSize(item);
    collected = items.concat(collected);
    olderExists = res.hasMore && events.length > 0;
    if (!olderExists) break;
    cursor = events[0]!.seq;
    if (turnsMode ? turnStarts(collected, true).length >= turns : collected.length >= limit) break;
    if (scanned >= limits.maxScanEvents || bytes >= limits.maxBytes || collected.length >= limits.maxItems * 4) break;
  }

  let start = 0;
  if (turnsMode) {
    const starts = turnStarts(collected, olderExists);
    if (starts.length >= turns) start = starts[starts.length - turns]!;
  }
  start = Math.max(start, collected.length - limit);
  if (start > 0 && start < collected.length) start = eventStart(collected, start);
  start = fitBytes(collected, start, limits.maxBytes);

  const lastSeq = first ? first.lastSeq : -1;
  const end = lastSeq + 1;
  return {
    items: collected.slice(start),
    has_more: start > 0 || olderExists,
    history: first ? first.history : '',
    to_seq: query.before_seq !== undefined ? Math.min(query.before_seq - 1, end) : end,
  };
}

async function readAfter(
  source: JarvisChannelSource,
  sessionId: string,
  afterSeq: number,
  requested: number | undefined,
  limits: PagingLimits,
): Promise<ItemsPage> {
  const limit = Math.min(requested ?? limits.defaultAfterLimit, limits.maxItems);
  // Jarvis seq > after_seq  ⇔  DSH seq > after_seq - 1.
  let cursor = afterSeq - 1;
  const items: JarvisItem[] = [];
  let toSeq = afterSeq;
  let history: string | null = null;
  let scanned = 0;
  let bytes = 0;
  let moreAfter = false;

  for (;;) {
    const res = await source.readEvents(sessionId, { afterSeq: cursor, limit: limits.chunkEvents });
    if (history === null) history = res.history;
    else if (res.history !== history) {
      moreAfter = true;
      break;
    }
    const events = res.events.filter((e) => e.seq > cursor);
    const stopped = appendWhole(events, items, limit, limits.maxBytes - bytes, (event, size) => {
      toSeq = event.seq + 1;
      cursor = event.seq;
      bytes += size;
    });
    scanned += events.length;
    if (stopped) {
      moreAfter = true;
      break;
    }
    if (!res.hasMore || events.length === 0) {
      toSeq = Math.max(toSeq, res.lastSeq + 1);
      if (res.lastSeq + 1 < afterSeq) toSeq = res.lastSeq + 1;
      break;
    }
    if (scanned >= limits.maxScanEvents) {
      moreAfter = true;
      break;
    }
  }

  const page: ItemsPage = { items, has_more: afterSeq > 0, history: history ?? '', to_seq: toSeq, from_seq: afterSeq };
  if (moreAfter) page.more_after = true;
  return page;
}

/**
 * Append the items of whole events while they fit; returns true when an event did not fit. `taken`
 * runs for every appended event. The first event is always taken so a page is never empty for size.
 */
function appendWhole(
  events: readonly DshSessionEvent[],
  items: JarvisItem[],
  limit: number,
  bytesLeft: number,
  taken: (event: DshSessionEvent, size: number) => void,
): boolean {
  let left = bytesLeft;
  for (const event of events) {
    const mapped = mapEvent(event);
    const size = mapped.reduce((sum, item) => sum + estimateItemSize(item), 0);
    if (items.length > 0 && (items.length + mapped.length > limit || size > left)) return true;
    items.push(...mapped);
    left -= size;
    taken(event, size);
  }
  return false;
}

async function readRange(
  source: JarvisChannelSource,
  sessionId: string,
  fromSeq: number,
  throughSeq: number,
  requested: number | undefined,
  limits: PagingLimits,
): Promise<RangePage> {
  const limit = Math.min(requested ?? limits.maxItems, limits.maxItems);
  // Jarvis seq ≥ from_seq  ⇔  DSH seq > from_seq - 2.
  let cursor = Math.max(fromSeq, 1) - 2;
  const items: JarvisItem[] = [];
  let toSeq = Math.max(fromSeq - 1, 0);
  let history: string | null = null;
  let scanned = 0;
  let bytes = 0;
  let more = false;

  if (throughSeq < fromSeq) return { items, more: false, history: '', to_seq: toSeq };

  for (;;) {
    const res = await source.readEvents(sessionId, { afterSeq: cursor, limit: limits.chunkEvents });
    if (history === null) history = res.history;
    else if (res.history !== history) {
      more = true;
      break;
    }
    const inRange = res.events.filter((e) => e.seq > cursor && e.seq + 1 <= throughSeq);
    const passed = res.events.some((e) => e.seq + 1 > throughSeq);
    const stopped = appendWhole(inRange, items, limit, limits.maxBytes - bytes, (event, size) => {
      toSeq = event.seq + 1;
      cursor = event.seq;
      bytes += size;
    });
    scanned += inRange.length;
    if (stopped) {
      more = true;
      break;
    }
    if (passed || !res.hasMore || res.events.length === 0) {
      toSeq = Math.min(throughSeq, Math.max(toSeq, res.lastSeq + 1));
      break;
    }
    if (scanned >= limits.maxScanEvents) {
      more = true;
      break;
    }
  }
  return { items, more, history: history ?? '', to_seq: toSeq };
}
