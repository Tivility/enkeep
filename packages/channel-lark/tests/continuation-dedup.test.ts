import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakeLarkTransport } from '../src/transport.js';
import { ContinuationWatcher } from '../src/continuation-watcher.js';
import type { StreamEventSource } from '../src/types.js';

describe('Item C: Subagent Continuation Deduplication & Deterministic Outbox ID', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers every autonomous turn (also a second wake-up from the same subagent) and skips a replayed turn', async () => {
    const transport = new FakeLarkTransport();
    await transport.start();

    const routeId = 'session_route_synth_001';
    const chatId = 'oc_test_chat_synth_001';
    const inboundMsgId = 'om_test_inbound_synth_001';
    const parentTurnId = 'turn_synth_parent_000000000000001';
    const childId1 = 'ses_synth_child_0000000000000001';
    const childId2 = 'ses_synth_child_0000000000000002';

    const events: Array<{
      rowId: number;
      type: 'assistant_delta' | 'assistant_stream_end' | 'turn_status';
      delta?: string;
      streamId?: string;
      status?: string;
      turnId?: string;
      originTurnId?: string;
      causeChildId?: string;
    }> = [];

    const fakeSource: StreamEventSource = {
      listAssistantEvents: vi.fn().mockImplementation(async (_rId, afterRowId) => {
        return events.filter((e) => e.rowId > afterRowId);
      }),
      resolveTurnOrigin: vi.fn().mockResolvedValue({
        chatId,
        replyToMessageId: inboundMsgId,
      }),
    };

    const outboxMap = new Map<string, any>();
    const mockChannelRepo: any = {
      createOutboxItem: vi.fn().mockImplementation(async (item) => {
        outboxMap.set(item.id, item);
        return item;
      }),
      findOutboxById: vi.fn().mockImplementation(async (id: string) => {
        return outboxMap.get(id) ?? null;
      }),
    };

    const watcher = new ContinuationWatcher({
      sessionRouteId: routeId,
      accountId: 'acc_synth_lark_001',
      userId: 'usr_synth_alice_001',
      nativeContextId: chatId,
      streamEventSource: fakeSource,
      transport,
      channelRepo: mockChannelRepo,
      replyTarget: {
        chatId,
        replyToMessageId: inboundMsgId,
      },
      initialCursor: 0,
      hasActiveInboundTracker: () => false,
      pollIntervalMs: 50,
      inactivityTimeoutMs: 60_000,
    });

    watcher.start();

    // --- Phase 1: Child 1 finishes first time -> should produce 1 card and outbox item cont_<parent>_<child1> ---
    events.push(
      { rowId: 10, type: 'turn_status', status: 'running', turnId: 'turn_auto_001', originTurnId: parentTurnId, causeChildId: childId1 },
      { rowId: 11, type: 'assistant_delta', delta: 'Child 1 completed task.', streamId: 'stream_child_1' },
      { rowId: 12, type: 'turn_status', status: 'completed', turnId: 'turn_auto_001', originTurnId: parentTurnId, causeChildId: childId1 }
    );

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);

    expect(transport.streamingCalls.filter((c) => c.type === 'card_create')).toHaveLength(1);
    const expectedOutboxId1 = `cont_${parentTurnId}_turn_auto_001`;
    expect(outboxMap.has(expectedOutboxId1)).toBe(true);
    expect(outboxMap.get(expectedOutboxId1).status).toBe('delivered');

    // --- Phase 2: a second wake-up from Child 1 (e.g. progress message, then completion notice) is its
    // own model turn with its own reply -> MUST be delivered ---
    events.push(
      { rowId: 13, type: 'turn_status', status: 'running', turnId: 'turn_auto_002', originTurnId: parentTurnId, causeChildId: childId1 },
      { rowId: 14, type: 'assistant_delta', delta: 'Duplicate notice for child 1', streamId: 'stream_child_1_dup' },
      { rowId: 15, type: 'turn_status', status: 'completed', turnId: 'turn_auto_002', originTurnId: parentTurnId, causeChildId: childId1 }
    );

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);

    expect(transport.streamingCalls.filter((c) => c.type === 'card_create')).toHaveLength(2);
    expect(outboxMap.has(`cont_${parentTurnId}_turn_auto_002`)).toBe(true);

    // --- Phase 2b: the same autonomous turn replayed (same turnId) -> skipped ---
    events.push(
      { rowId: 151, type: 'turn_status', status: 'running', turnId: 'turn_auto_002', originTurnId: parentTurnId, causeChildId: childId1 },
      { rowId: 152, type: 'assistant_delta', delta: 'Duplicate notice for child 1', streamId: 'stream_child_1_dup' },
      { rowId: 153, type: 'turn_status', status: 'completed', turnId: 'turn_auto_002', originTurnId: parentTurnId, causeChildId: childId1 }
    );
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    expect(transport.streamingCalls.filter((c) => c.type === 'card_create')).toHaveLength(2);
    expect(watcher.getCursor()).toBeGreaterThanOrEqual(153);

    // --- Phase 3: Child 2 completes for SAME parent turn -> MUST deliver its own card ---
    events.push(
      { rowId: 160, type: 'turn_status', status: 'running', turnId: 'turn_auto_003', originTurnId: parentTurnId, causeChildId: childId2 },
      { rowId: 161, type: 'assistant_delta', delta: 'Child 2 completed task.', streamId: 'stream_child_2' },
      { rowId: 162, type: 'turn_status', status: 'completed', turnId: 'turn_auto_003', originTurnId: parentTurnId, causeChildId: childId2 }
    );

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);

    // 3 cards in total (two turns from Child 1, one from Child 2)
    expect(transport.streamingCalls.filter((c) => c.type === 'card_create')).toHaveLength(3);
    const expectedOutboxId2 = `cont_${parentTurnId}_turn_auto_003`;
    expect(outboxMap.has(expectedOutboxId2)).toBe(true);

    watcher.stop();
  });

  it('falls back to turnId when causeChildId is absent and deduplicates on replay', async () => {
    const transport = new FakeLarkTransport();
    await transport.start();

    const routeId = 'session_route_synth_002';
    const chatId = 'oc_test_chat_synth_002';
    const inboundMsgId = 'om_test_inbound_synth_002';
    const parentTurnId = 'turn_synth_parent_000000000000002';
    const autonomousTurnId = 'turn_synth_auto_fallback_001';

    const events: Array<{
      rowId: number;
      type: 'assistant_delta' | 'assistant_stream_end' | 'turn_status';
      delta?: string;
      streamId?: string;
      status?: string;
      turnId?: string;
      originTurnId?: string;
      causeChildId?: string;
    }> = [
      { rowId: 30, type: 'turn_status', status: 'running', turnId: autonomousTurnId, originTurnId: parentTurnId },
      { rowId: 31, type: 'assistant_delta', delta: 'Autonomous fallback reply.', streamId: 'stream_fb_1' },
      { rowId: 32, type: 'turn_status', status: 'completed', turnId: autonomousTurnId, originTurnId: parentTurnId },
    ];

    const fakeSource: StreamEventSource = {
      listAssistantEvents: vi.fn().mockImplementation(async (_rId, afterRowId) => {
        return events.filter((e) => e.rowId > afterRowId);
      }),
      resolveTurnOrigin: vi.fn().mockResolvedValue({
        chatId,
        replyToMessageId: inboundMsgId,
      }),
    };

    const outboxMap = new Map<string, any>();
    const mockChannelRepo: any = {
      createOutboxItem: vi.fn().mockImplementation(async (item) => {
        outboxMap.set(item.id, item);
        return item;
      }),
      findOutboxById: vi.fn().mockImplementation(async (id: string) => {
        return outboxMap.get(id) ?? null;
      }),
    };

    const watcher = new ContinuationWatcher({
      sessionRouteId: routeId,
      accountId: 'acc_synth_lark_002',
      userId: 'usr_synth_alice_002',
      nativeContextId: chatId,
      streamEventSource: fakeSource,
      transport,
      channelRepo: mockChannelRepo,
      replyTarget: {
        chatId,
        replyToMessageId: inboundMsgId,
      },
      initialCursor: 0,
      hasActiveInboundTracker: () => false,
      pollIntervalMs: 50,
      inactivityTimeoutMs: 60_000,
    });

    watcher.start();

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);

    // Fallback outbox ID: cont_<parentTurnId>_<turnId>
    const expectedOutboxId = `cont_${parentTurnId}_${autonomousTurnId}`;
    expect(outboxMap.has(expectedOutboxId)).toBe(true);
    expect(transport.streamingCalls.filter((c) => c.type === 'card_create')).toHaveLength(1);

    // Replay same events: should skip without new card
    watcher.extend(29);
    await vi.advanceTimersByTimeAsync(50);
    expect(transport.streamingCalls.filter((c) => c.type === 'card_create')).toHaveLength(1);

    watcher.stop();
  });

  it('sends the reply as plain text when the continuation card cannot be created', async () => {
    const transport = new FakeLarkTransport();
    await transport.start();
    (transport as any).createStreamingCard = vi.fn().mockResolvedValue(null);
    const sendReply = vi.spyOn(transport, 'sendReply');

    const chatId = 'oc_test_chat_synth_003';
    const parentTurnId = 'turn_synth_parent_000000000000003';
    const events: any[] = [
      { rowId: 40, type: 'turn_status', status: 'running', turnId: 'turn_auto_040', originTurnId: parentTurnId, causeChildId: 'ses_synth_child_0000000000000040' },
      { rowId: 41, type: 'assistant_delta', delta: 'Progress: line A is back.', streamId: 'stream_40' },
      { rowId: 42, type: 'turn_status', status: 'completed', turnId: 'turn_auto_040', originTurnId: parentTurnId },
    ];
    const outboxMap = new Map<string, any>();
    const watcher = new ContinuationWatcher({
      sessionRouteId: 'session_route_synth_003',
      accountId: 'acc_synth_lark_003',
      userId: 'usr_synth_alice_003',
      nativeContextId: chatId,
      streamEventSource: {
        listAssistantEvents: vi.fn().mockImplementation(async (_r, after) => events.filter((e) => e.rowId > after)),
        resolveTurnOrigin: vi.fn().mockResolvedValue({ chatId, replyToMessageId: 'om_test_inbound_synth_003' }),
      } as StreamEventSource,
      transport,
      channelRepo: {
        createOutboxItem: vi.fn().mockImplementation(async (item) => { outboxMap.set(item.id, item); return item; }),
        findOutboxById: vi.fn().mockImplementation(async (id: string) => outboxMap.get(id) ?? null),
      } as any,
      replyTarget: { chatId },
      initialCursor: 39,
      hasActiveInboundTracker: () => false,
      pollIntervalMs: 50,
      inactivityTimeoutMs: 60_000,
    });
    watcher.start();
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(50);

    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0][0]).toMatchObject({ chatId, content: 'Progress: line A is back.', replyToMessageId: 'om_test_inbound_synth_003' });
    expect(outboxMap.get(`cont_${parentTurnId}_turn_auto_040`)?.status).toBe('delivered');
    watcher.stop();
  });
});
