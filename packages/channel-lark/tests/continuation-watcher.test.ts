import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakeLarkTransport } from '../src/transport.js';
import { ContinuationWatcher } from '../src/continuation-watcher.js';
import type { StreamEventSource } from '../src/types.js';

describe('ContinuationWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('produces exactly one new streaming card (create, >=1 push, finalize completed) and one delivered outbox row on autonomous continuation turn', async () => {
    const transport = new FakeLarkTransport();
    await transport.start();

    const routeId = 'session_route_cont_1';
    const inboundMsgId = 'om_user_turn_1';
    const chatId = 'oc_test_chat_cont';

    // Sequence of web_events representing a follow-up runtime turn triggered by background subagent
    const events: Array<{
      rowId: number;
      type: 'assistant_delta' | 'assistant_stream_end' | 'turn_status';
      delta?: string;
      streamId?: string;
      status?: string;
    }> = [
      // Follow-up turn started
      { rowId: 10, type: 'turn_status', status: 'running' },
      { rowId: 11, type: 'assistant_delta', delta: 'Subagent 1 completed. ', streamId: 'msgstream_sub_1' },
      { rowId: 12, type: 'assistant_stream_end', streamId: 'msgstream_sub_1' },
      { rowId: 13, type: 'assistant_delta', delta: 'Final summary: All 3 tasks done.', streamId: 'msgstream_sub_2' },
      { rowId: 14, type: 'assistant_stream_end', streamId: 'msgstream_sub_2' },
      { rowId: 15, type: 'turn_status', status: 'completed' },
    ];

    const fakeSource: StreamEventSource = {
      listAssistantEvents: vi.fn().mockImplementation(async (_rId, afterRowId) => {
        return events.filter((e) => e.rowId > afterRowId);
      }),
    };

    const outboxItems: any[] = [];
    const mockChannelRepo: any = {
      createOutboxItem: vi.fn().mockImplementation(async (item) => {
        outboxItems.push(item);
        return item;
      }),
    };

    const watcher = new ContinuationWatcher({
      sessionRouteId: routeId,
      accountId: 'acc_lark_1',
      userId: 'usr_1',
      nativeContextId: chatId,
      streamEventSource: fakeSource,
      transport,
      channelRepo: mockChannelRepo,
      replyTarget: {
        chatId,
        replyToMessageId: inboundMsgId,
        rootId: inboundMsgId,
        threadId: inboundMsgId,
      },
      initialCursor: 9, // cursor after previous turn completed at rowId 9
      hasActiveInboundTracker: () => false,
      pollIntervalMs: 100,
      inactivityTimeoutMs: 15 * 60 * 1000,
    });

    watcher.start();

    // Advance timers so initial tick runs and detached tracker processes events
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);

    // 1. Verify streaming card was opened and received pushes
    expect(transport.streamingCalls.length).toBeGreaterThanOrEqual(3);
    const createCall = transport.streamingCalls[0];
    expect(createCall.type).toBe('card_create');
    expect(createCall.params.chatId).toBe(chatId);
    expect(createCall.params.replyToMessageId).toBe(inboundMsgId);

    const pushCalls = transport.streamingCalls.filter((c) => c.type === 'push');
    expect(pushCalls.length).toBeGreaterThanOrEqual(1);

    const finalizeCall = transport.streamingCalls.find((c) => c.type === 'finalize');
    expect(finalizeCall).toBeDefined();
    expect(finalizeCall?.status).toBe('completed');
    expect(finalizeCall?.content).toBe('Subagent 1 completed. \n\nFinal summary: All 3 tasks done.');

    // 2. Exactly one delivered outbox row recorded with card messageId
    expect(mockChannelRepo.createOutboxItem).toHaveBeenCalledTimes(1);
    expect(outboxItems.length).toBe(1);
    expect(outboxItems[0].status).toBe('delivered');
    expect(outboxItems[0].sessionId).toBe(routeId);
    expect(outboxItems[0].replyToNativeId).toBe(inboundMsgId);

    const outboxPayload = JSON.parse(outboxItems[0].payloadJson);
    expect(outboxPayload.format).toBe('markdown');
    expect(outboxPayload.messageId).toBe(finalizeCall?.messageId);
    expect(outboxPayload.text).toBe('Subagent 1 completed. \n\nFinal summary: All 3 tasks done.');

    watcher.stop();
  });

  it('a running turn already tracked by an inbound tracker does not spawn a second card', async () => {
    const transport = new FakeLarkTransport();
    await transport.start();

    const routeId = 'session_route_cont_2';
    const chatId = 'oc_test_chat_guard';

    // Inbound turn is running
    let inboundTrackerRunning = true;

    const events: Array<{
      rowId: number;
      type: 'assistant_delta' | 'assistant_stream_end' | 'turn_status';
      delta?: string;
      status?: string;
    }> = [
      { rowId: 20, type: 'turn_status', status: 'running' },
      { rowId: 21, type: 'assistant_delta', delta: 'Inbound message reply' },
      { rowId: 22, type: 'turn_status', status: 'completed' },
    ];

    const fakeSource: StreamEventSource = {
      listAssistantEvents: vi.fn().mockImplementation(async (_rId, afterRowId) => {
        return events.filter((e) => e.rowId > afterRowId);
      }),
    };

    const mockChannelRepo: any = {
      createOutboxItem: vi.fn(),
    };

    const watcher = new ContinuationWatcher({
      sessionRouteId: routeId,
      accountId: 'acc_lark_1',
      userId: 'usr_1',
      nativeContextId: chatId,
      streamEventSource: fakeSource,
      transport,
      channelRepo: mockChannelRepo,
      replyTarget: {
        chatId,
        replyToMessageId: 'om_inbound',
      },
      initialCursor: 19,
      hasActiveInboundTracker: () => inboundTrackerRunning,
      pollIntervalMs: 100,
    });

    watcher.start();

    // Advance time while inbound tracker is active
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);

    // Watcher must NOT have created any streaming card because inbound tracker is handling this turn!
    expect(transport.streamingCalls.length).toBe(0);
    expect(mockChannelRepo.createOutboxItem).not.toHaveBeenCalled();

    // And watcher advanced its cursor past the inbound events to avoid double-processing
    expect(watcher.getCursor()).toBe(22);

    watcher.stop();
  });

  it('stops watcher on inactivity timeout', async () => {
    const transport = new FakeLarkTransport();
    await transport.start();

    const fakeSource: StreamEventSource = {
      listAssistantEvents: vi.fn().mockResolvedValue([]),
    };

    const onStopped = vi.fn();

    const watcher = new ContinuationWatcher({
      sessionRouteId: 'session_route_timeout',
      accountId: 'acc_lark_1',
      userId: 'usr_1',
      nativeContextId: 'oc_test',
      streamEventSource: fakeSource,
      transport,
      channelRepo: { createOutboxItem: vi.fn() } as any,
      replyTarget: { chatId: 'oc_test' },
      initialCursor: 0,
      hasActiveInboundTracker: () => false,
      pollIntervalMs: 100,
      inactivityTimeoutMs: 15 * 60 * 1000, // 15 minutes
      onStopped,
    });

    watcher.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(watcher.isActive()).toBe(true);
    expect(onStopped).not.toHaveBeenCalled();

    // Advance by 14 minutes: still active
    await vi.advanceTimersByTimeAsync(14 * 60 * 1000);
    expect(watcher.isActive()).toBe(true);

    // Advance past 15 minutes
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(watcher.isActive()).toBe(false);
    expect(onStopped).toHaveBeenCalledTimes(1);
  });

  it('delivers two back-to-back follow-up turns in ONE poll batch as two cards and two outbox rows', async () => {
    const transport = new FakeLarkTransport();
    await transport.start();

    const routeId = 'session_route_back_to_back';
    const inboundMsgId = 'om_user_turn_btb';
    const chatId = 'oc_test_chat_btb';

    // Single array simulating events in SQLite where Turn A and Turn B were emitted in quick succession
    const events: Array<{
      rowId: number;
      type: 'assistant_delta' | 'assistant_stream_end' | 'turn_status';
      delta?: string;
      streamId?: string;
      status?: string;
    }> = [
      // Turn A
      { rowId: 101, type: 'turn_status', status: 'running' },
      { rowId: 102, type: 'assistant_delta', delta: 'Turn A message', streamId: 'strm_a' },
      { rowId: 103, type: 'turn_status', status: 'completed' },
      // Turn B immediately following
      { rowId: 104, type: 'turn_status', status: 'running' },
      { rowId: 105, type: 'assistant_delta', delta: 'Turn B message', streamId: 'strm_b' },
      { rowId: 106, type: 'turn_status', status: 'completed' },
    ];

    const fakeSource: StreamEventSource = {
      listAssistantEvents: vi.fn().mockImplementation(async (_rId, afterRowId) => {
        return events.filter((e) => e.rowId > afterRowId);
      }),
    };

    const outboxItems: any[] = [];
    const mockChannelRepo: any = {
      createOutboxItem: vi.fn().mockImplementation(async (item) => {
        outboxItems.push(item);
        return item;
      }),
    };

    const watcher = new ContinuationWatcher({
      sessionRouteId: routeId,
      accountId: 'acc_lark_1',
      userId: 'usr_1',
      nativeContextId: chatId,
      streamEventSource: fakeSource,
      transport,
      channelRepo: mockChannelRepo,
      replyTarget: {
        chatId,
        replyToMessageId: inboundMsgId,
        rootId: inboundMsgId,
        threadId: inboundMsgId,
      },
      initialCursor: 100,
      hasActiveInboundTracker: () => false,
      pollIntervalMs: 100,
      inactivityTimeoutMs: 15 * 60 * 1000,
    });

    watcher.start();

    // Allow ticks and tracker processing to settle
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);

    // Assert: two card creations and two finalizations
    const cardCreates = transport.streamingCalls.filter((c) => c.type === 'card_create');
    expect(cardCreates.length).toBe(2);

    const finalizes = transport.streamingCalls.filter((c) => c.type === 'finalize');
    expect(finalizes.length).toBe(2);
    expect(finalizes[0].content).toBe('Turn A message');
    expect(finalizes[0].status).toBe('completed');
    expect(finalizes[1].content).toBe('Turn B message');
    expect(finalizes[1].status).toBe('completed');

    // Assert: two outbox rows delivered
    expect(outboxItems.length).toBe(2);
    expect(outboxItems[0].status).toBe('delivered');
    expect(outboxItems[1].status).toBe('delivered');

    const payloadA = JSON.parse(outboxItems[0].payloadJson);
    expect(payloadA.text).toBe('Turn A message');
    expect(payloadA.messageId).toBe(finalizes[0].messageId);

    const payloadB = JSON.parse(outboxItems[1].payloadJson);
    expect(payloadB.text).toBe('Turn B message');
    expect(payloadB.messageId).toBe(finalizes[1].messageId);

    watcher.stop();
  });

  it('delivers two follow-up turns separated by ~5 s with a slow (1 s) finalize as both cards delivered', async () => {
    const transport = new FakeLarkTransport();
    transport.finalizeDelayMs = 1000;
    await transport.start();

    const routeId = 'session_route_slow_finalize_separated';
    const inboundMsgId = 'om_user_turn_slow';
    const chatId = 'oc_test_chat_slow';

    const events: Array<{
      rowId: number;
      type: 'assistant_delta' | 'assistant_stream_end' | 'turn_status';
      delta?: string;
      streamId?: string;
      status?: string;
    }> = [
      // Follow-up Turn 1 initially
      { rowId: 101, type: 'turn_status', status: 'running' },
      { rowId: 102, type: 'assistant_delta', delta: 'Turn 1 result', streamId: 'strm_1' },
      { rowId: 103, type: 'turn_status', status: 'completed' },
    ];

    const fakeSource: StreamEventSource = {
      listAssistantEvents: vi.fn().mockImplementation(async (_rId, afterRowId) => {
        return events.filter((e) => e.rowId > afterRowId);
      }),
    };

    const outboxItems: any[] = [];
    const mockChannelRepo: any = {
      createOutboxItem: vi.fn().mockImplementation(async (item) => {
        outboxItems.push(item);
        return item;
      }),
    };

    const watcher = new ContinuationWatcher({
      sessionRouteId: routeId,
      accountId: 'acc_lark_slow',
      userId: 'usr_slow',
      nativeContextId: chatId,
      streamEventSource: fakeSource,
      transport,
      channelRepo: mockChannelRepo,
      replyTarget: {
        chatId,
        replyToMessageId: inboundMsgId,
        rootId: inboundMsgId,
        threadId: inboundMsgId,
      },
      initialCursor: 100,
      hasActiveInboundTracker: () => false,
      pollIntervalMs: 100,
      inactivityTimeoutMs: 15 * 60 * 1000,
    });

    watcher.start();

    // Advance 100 ms for tracker 1 to start and process events 101-103
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);

    // Now finalize is in flight (taking 1000 ms).
    // Tick watcher several times during the 1 s finalize
    await vi.advanceTimersByTimeAsync(500);
    expect(outboxItems.length).toBe(0); // finalize not finished yet

    // Complete the 1000 ms finalize
    await vi.advanceTimersByTimeAsync(600);
    expect(outboxItems.length).toBe(1); // Turn 1 card finalized and recorded

    // Advance ~5 seconds with no new events
    await vi.advanceTimersByTimeAsync(5000);

    // Now push Turn 2 events (separated by ~5s)
    events.push(
      { rowId: 104, type: 'turn_status', status: 'running' },
      { rowId: 105, type: 'assistant_delta', delta: 'Turn 2 result', streamId: 'strm_2' },
      { rowId: 106, type: 'turn_status', status: 'completed' }
    );

    // Advance timers for Turn 2 tracker to start and run its 1 s finalize
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1100);

    // Both cards must be created and finalized
    const cardCreates = transport.streamingCalls.filter((c) => c.type === 'card_create');
    expect(cardCreates.length).toBe(2);

    const finalizes = transport.streamingCalls.filter((c) => c.type === 'finalize');
    expect(finalizes.length).toBe(2);
    expect(finalizes[0].content).toBe('Turn 1 result');
    expect(finalizes[0].status).toBe('completed');
    expect(finalizes[1].content).toBe('Turn 2 result');
    expect(finalizes[1].status).toBe('completed');

    // Both outbox items delivered
    expect(outboxItems.length).toBe(2);
    expect(outboxItems[0].status).toBe('delivered');
    expect(outboxItems[1].status).toBe('delivered');

    watcher.stop();
  });

  it('skips card creation and advances cursor when hasPendingPlatformTurn is true, but creates card when false', async () => {
    const transport = new FakeLarkTransport();
    await transport.start();

    const routeId = 'session_route_platform_pending_guard';
    const chatId = 'oc_test_pending_chat';
    const inboundMsgId = 'om_pending_test';

    const events: Array<{
      rowId: number;
      type: 'assistant_delta' | 'assistant_stream_end' | 'turn_status';
      delta?: string;
      status?: string;
    }> = [
      { rowId: 50, type: 'turn_status', status: 'running' },
    ];

    let pendingTurn = true;
    const fakeSource: StreamEventSource = {
      listAssistantEvents: vi.fn().mockImplementation(async (_r, after) => {
        return events.filter((e) => e.rowId > after);
      }),
      hasPendingPlatformTurn: vi.fn().mockImplementation(async () => pendingTurn),
    };

    const mockChannelRepo: any = {
      createOutboxItem: vi.fn(),
    };

    const watcher = new ContinuationWatcher({
      sessionRouteId: routeId,
      accountId: 'acc_lark_1',
      userId: 'usr_1',
      nativeContextId: chatId,
      streamEventSource: fakeSource,
      transport,
      channelRepo: mockChannelRepo,
      replyTarget: {
        chatId,
        replyToMessageId: inboundMsgId,
      },
      initialCursor: 40,
      hasActiveInboundTracker: () => false,
      pollIntervalMs: 100,
    });

    watcher.start();

    // With hasPendingPlatformTurn = true:
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.streamingCalls.length).toBe(0);
    expect(watcher.getCursor()).toBe(50);
    expect(mockChannelRepo.createOutboxItem).not.toHaveBeenCalled();

    // Now switch hasPendingPlatformTurn to false and simulate autonomous continuation turn
    pendingTurn = false;
    events.push(
      { rowId: 51, type: 'turn_status', status: 'running' },
      { rowId: 52, type: 'assistant_delta', delta: 'Autonomous followup' },
      { rowId: 53, type: 'turn_status', status: 'completed' }
    );

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);

    // Card should now be created and finalized
    expect(transport.streamingCalls.some((c) => c.type === 'card_create')).toBe(true);
    const finalizeCall = transport.streamingCalls.find((c) => c.type === 'finalize');
    expect(finalizeCall).toBeDefined();
    expect(finalizeCall?.content).toBe('Autonomous followup');
    expect(mockChannelRepo.createOutboxItem).toHaveBeenCalledTimes(1);

    watcher.stop();
  });
});
