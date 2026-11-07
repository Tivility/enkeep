import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGING_LIMITS, parseItemsQuery, readItems, type ItemsPage, type RangePage } from '../src/paging.js';
import { FakeSource, SESSION_A, assistantMessage, conversation, toolResult, turnEnd, turnStart, userMessage } from './helpers.js';

function source(turns: number): FakeSource {
  const s = new FakeSource();
  s.setLog(SESSION_A, conversation(turns), 'dsh:synthetic-history-1');
  return s;
}

const texts = (page: ItemsPage | RangePage): string[] => page.items.map((i) => i.text ?? '');

describe('readItems', () => {
  it('returns the last 2 turns by default with history and to_seq', async () => {
    const page = (await readItems(source(5), SESSION_A, {})) as ItemsPage;
    expect(texts(page)).toEqual(['question 4', 'answer 4', 'question 5', 'answer 5']);
    expect(page.has_more).toBe(true);
    expect(page.history).toBe('dsh:synthetic-history-1');
    expect(page.to_seq).toBe(20); // 20 events, dsh seqs 0..19
    expect(page.items[0]!.seq).toBe(14);
  });

  it('returns the last N turns, reading backwards in bounded chunks', async () => {
    const s = source(100);
    const page = (await readItems(s, SESSION_A, { turns: 3 }, { ...DEFAULT_PAGING_LIMITS, chunkEvents: 5 })) as ItemsPage;
    expect(texts(page)).toEqual(['question 98', 'answer 98', 'question 99', 'answer 99', 'question 100', 'answer 100']);
    expect(page.has_more).toBe(true);
    // 400 events in the log; only a few chunks were read.
    expect(s.reads.length).toBeLessThanOrEqual(4);
    expect(s.reads.every((r) => r.query.limit === 5)).toBe(true);
  });

  it('returns everything when the log has fewer turns', async () => {
    const page = (await readItems(source(1), SESSION_A, { turns: 5 })) as ItemsPage;
    expect(texts(page)).toEqual(['question 1', 'answer 1']);
    expect(page.has_more).toBe(false);
  });

  it('returns the last `limit` items without splitting an event', async () => {
    const s = new FakeSource();
    s.setLog(SESSION_A, [
      userMessage(0, 'q'),
      assistantMessage(1, [
        { type: 'reasoning', text: 'r' },
        { type: 'text', text: 't1' },
        { type: 'tool-call', id: 'call_synth_1', name: 'bash', arguments: '{}' },
      ]),
      toolResult(2, 'call_synth_1', [{ type: 'text', text: 'out' }]),
    ]);
    const page = (await readItems(s, SESSION_A, { limit: 2 })) as ItemsPage;
    // The limit cut inside event seq 2 (3 items): the whole event is kept.
    expect(page.items.map((i) => i.id)).toEqual(['2#0', '2#1', '2#2', '3#0']);
    expect(page.has_more).toBe(true);
  });

  it('pages backwards with before_seq', async () => {
    const s = source(5);
    const first = (await readItems(s, SESSION_A, {})) as ItemsPage;
    const older = (await readItems(s, SESSION_A, { before_seq: first.items[0]!.seq })) as ItemsPage;
    expect(texts(older)).toEqual(['question 2', 'answer 2', 'question 3', 'answer 3']);
    expect(older.has_more).toBe(true);
    const oldest = (await readItems(s, SESSION_A, { before_seq: older.items[0]!.seq })) as ItemsPage;
    expect(texts(oldest)).toEqual(['question 1', 'answer 1']);
    expect(oldest.has_more).toBe(false);
  });

  it('reads forward with after_seq: from_seq, to_seq and more_after', async () => {
    const s = source(5);
    const page = (await readItems(s, SESSION_A, { after_seq: 12, limit: 3 })) as ItemsPage;
    // Jarvis seqs > 12: dsh seq 12 (turn/start, no item), 13 (question 4), 14 (answer 4), 15 (turn/end), 16, 17 (question 5)…
    expect(page.from_seq).toBe(12);
    expect(texts(page)).toEqual(['question 4', 'answer 4', 'question 5']);
    expect(page.more_after).toBe(true);
    expect(page.to_seq).toBe(page.items[page.items.length - 1]!.seq);

    const rest = (await readItems(s, SESSION_A, { after_seq: page.to_seq })) as ItemsPage;
    expect(rest.from_seq).toBe(page.to_seq);
    expect(texts(rest)).toEqual(['answer 5']);
    expect(rest.more_after).toBeUndefined();
    expect(rest.to_seq).toBe(20);

    const none = (await readItems(s, SESSION_A, { after_seq: 20 })) as ItemsPage;
    expect(none.items).toEqual([]);
    expect(none.to_seq).toBe(20);
  });

  it('reads a range from_seq…through_seq', async () => {
    const s = source(5);
    const range = (await readItems(s, SESSION_A, { from_seq: 6, through_seq: 11 })) as RangePage;
    // Jarvis seqs 6..11 = dsh 5..10: question 2, answer 2, turn/end, turn/start, question 3, answer 3.
    expect(texts(range)).toEqual(['question 2', 'answer 2', 'question 3', 'answer 3']);
    expect(range.more).toBe(false);
    expect(range.to_seq).toBe(11);

    const capped = (await readItems(s, SESSION_A, { from_seq: 1, through_seq: 20, limit: 2 })) as RangePage;
    expect(texts(capped)).toEqual(['question 1', 'answer 1']);
    expect(capped.more).toBe(true);
  });

  it('turns are counted from the person, notices included in their turn', async () => {
    const s = new FakeSource();
    s.setLog(SESSION_A, [
      turnStart(0),
      userMessage(1, 'one'),
      turnEnd(2, { kind: 'aborted', reason: { kind: 'user' } }),
      turnStart(3, 2),
      userMessage(4, 'Injected', { kind: 'runtime-context' }),
      userMessage(5, 'two'),
      assistantMessage(6, [{ type: 'text', text: 'reply two' }]),
    ]);
    const page = (await readItems(s, SESSION_A, { turns: 1 })) as ItemsPage;
    expect(texts(page)).toEqual(['two', 'reply two']);
    const both = (await readItems(s, SESSION_A, { turns: 2 })) as ItemsPage;
    expect(texts(both)).toEqual(['one', '已中断', 'two', 'reply two']);
  });

  it('propagates source error codes and validates params', async () => {
    const s = source(1);
    await expect(readItems(s, 'ses_unknown', {})).rejects.toMatchObject({ code: 'not_found' });
    expect(() => parseItemsQuery({ before_seq: -1 })).toThrowError(expect.objectContaining({ code: 'invalid_params' }));
    expect(() => parseItemsQuery({ turns: 'two' })).toThrowError(expect.objectContaining({ code: 'invalid_params' }));
    expect(parseItemsQuery({ after_seq: 0, limit: 10 })).toEqual({ after_seq: 0, limit: 10 });
  });

  it('treats before_seq 0 as not set and returns the newest page', async () => {
    const s = source(5);
    expect(parseItemsQuery({ before_seq: 0 })).toEqual({});
    expect(parseItemsQuery({ before_seq: null })).toEqual({});
    const newest = (await readItems(s, SESSION_A, {})) as ItemsPage;
    const zero = (await readItems(s, SESSION_A, parseItemsQuery({ before_seq: 0 }))) as ItemsPage;
    expect(zero).toEqual(newest);
    expect(texts(zero)).toEqual(['question 4', 'answer 4', 'question 5', 'answer 5']);
    expect(zero.to_seq).toBe(20);
  });

  it('treats turns 0 and limit 0 as not set', async () => {
    const s = source(5);
    expect(parseItemsQuery({ turns: 0, limit: 0 })).toEqual({});
    expect(parseItemsQuery({ turns: null, limit: null })).toEqual({});
    expect(parseItemsQuery({ before_seq: 0, turns: 0, limit: 0 })).toEqual({});
    const newest = (await readItems(s, SESSION_A, {})) as ItemsPage;
    const zero = (await readItems(s, SESSION_A, parseItemsQuery({ before_seq: 0, turns: 0, limit: 0 }))) as ItemsPage;
    expect(zero).toEqual(newest);
    // 0 still means a position where 0 is valid.
    expect(parseItemsQuery({ after_seq: 0, turns: 0 })).toEqual({ after_seq: 0 });
    expect(parseItemsQuery({ from_seq: 0, through_seq: 0, limit: 0 })).toEqual({ from_seq: 0, through_seq: 0 });
    // Negative values are still rejected.
    expect(() => parseItemsQuery({ limit: -1 })).toThrowError(expect.objectContaining({ code: 'invalid_params' }));
  });
});
