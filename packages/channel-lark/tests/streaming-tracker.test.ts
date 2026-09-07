import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakeLarkTransport } from '../src/transport.js';
import { StreamingReplyTracker } from '../src/streaming-tracker.js';
import type { StreamEventSource } from '../src/types.js';

describe('StreamingReplyTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stream_end does not stop polling and finalize uses turn completion', async () => {
    const transport = new FakeLarkTransport();
    await transport.start();

    const events: Array<{ rowId: number; type: 'assistant_delta' | 'assistant_stream_end' | 'turn_status'; delta?: string; streamId?: string; status?: string }> = [
      { rowId: 1, type: 'assistant_delta', delta: 'Hello ', streamId: 's1' },
      { rowId: 2, type: 'assistant_delta', delta: 'world!', streamId: 's1' },
    ];

    const fakeSource: StreamEventSource = {
      listAssistantEvents: vi.fn().mockImplementation(async (_routeId, afterRowId) => {
        return events.filter((e) => e.rowId > afterRowId);
      }),
    };

    const tracker = new StreamingReplyTracker({
      transport,
      streamEventSource: fakeSource,
      sessionRouteId: 'session_1',
      cardParams: {
        chatId: 'oc_test_chat',
      },
      pollIntervalMs: 100,
    });

    tracker.start();

    // Let the initial tick run
    await vi.advanceTimersByTimeAsync(0);

    expect(transport.streamingCalls.length).toBe(2);
    expect(transport.streamingCalls[0].type).toBe('card_create');
    expect(transport.streamingCalls[1].type).toBe('push');
    expect(transport.streamingCalls[1].content).toBe('Hello world!');

    // Add stream end
    events.push({ rowId: 3, type: 'assistant_stream_end', streamId: 's1' });

    await vi.advanceTimersByTimeAsync(100);

    // Stream end alone should not push new text, but tracker continues polling!
    // Add deltas after stream end on the same streamId (e.g. follow-up summary report)
    events.push({ rowId: 4, type: 'assistant_delta', delta: ' More after stream_end', streamId: 's1' });

    await vi.advanceTimersByTimeAsync(100);

    // Polling DID NOT STOP on stream_end: push call received the new delta!
    const pushes = transport.streamingCalls.filter((c) => c.type === 'push');
    expect(pushes.length).toBe(2);
    expect(pushes[1].content).toBe('Hello world! More after stream_end');

    // Finalize on turn completion
    const finalResult = await tracker.finalize('Hello world! More after stream_end', 'completed');
    expect(finalResult.handled).toBe(true);
    expect(finalResult.messageId).toMatch(/^om_/);

    const finalizeCall = transport.streamingCalls.find((c) => c.type === 'finalize');
    expect(finalizeCall).toBeDefined();
    expect(finalizeCall?.content).toBe('Hello world! More after stream_end');
    expect(finalizeCall?.status).toBe('completed');
  });

  it('cursor snapshot ignores pre-existing rows from previous turns', async () => {
    const transport = new FakeLarkTransport();
    await transport.start();

    // Pre-existing events from previous turn
    const events: Array<{ rowId: number; type: 'assistant_delta' | 'assistant_stream_end' | 'turn_status'; delta?: string; streamId?: string }> = [
      { rowId: 100, type: 'assistant_delta', delta: 'Old turn content' },
      { rowId: 101, type: 'assistant_stream_end' },
    ];

    const fakeSource: StreamEventSource = {
      getLatestRowId: vi.fn().mockResolvedValue(101),
      listAssistantEvents: vi.fn().mockImplementation(async (_routeId, afterRowId) => {
        return events.filter((e) => e.rowId > afterRowId);
      }),
    };

    const tracker = new StreamingReplyTracker({
      transport,
      streamEventSource: fakeSource,
      sessionRouteId: 'session_snapshot',
      cardParams: {
        chatId: 'oc_test_chat',
      },
      pollIntervalMs: 100,
    });

    tracker.start();
    await vi.advanceTimersByTimeAsync(0);

    // Since initial cursor snapshots to 101, old turn content was not pushed!
    expect(transport.streamingCalls.filter((c) => c.type === 'push').length).toBe(0);

    // Now new turn events arrive
    events.push({ rowId: 102, type: 'assistant_delta', delta: 'New turn reply', streamId: 's2' });
    await vi.advanceTimersByTimeAsync(100);

    const pushes = transport.streamingCalls.filter((c) => c.type === 'push');
    expect(pushes.length).toBe(1);
    expect(pushes[0].content).toBe('New turn reply');
  });

  it('handles multi-segment concatenation with paragraph break when streamId changes after stream_end', async () => {
    const transport = new FakeLarkTransport();
    await transport.start();

    const events: Array<{ rowId: number; type: 'assistant_delta' | 'assistant_stream_end' | 'turn_status'; delta?: string; streamId?: string }> = [
      // Segment 1 (pre-tool text)
      { rowId: 1, type: 'assistant_delta', delta: 'Segment 1 text', streamId: 'msgstream_seg1' },
      { rowId: 2, type: 'assistant_stream_end', streamId: 'msgstream_seg1' },
      // Segment 2 (post-tool text on new streamId)
      { rowId: 3, type: 'assistant_delta', delta: 'Segment 2 text', streamId: 'msgstream_seg2' },
      { rowId: 4, type: 'assistant_stream_end', streamId: 'msgstream_seg2' },
    ];

    const fakeSource: StreamEventSource = {
      listAssistantEvents: vi.fn().mockImplementation(async (_routeId, afterRowId) => {
        return events.filter((e) => e.rowId > afterRowId);
      }),
    };

    const tracker = new StreamingReplyTracker({
      transport,
      streamEventSource: fakeSource,
      sessionRouteId: 'session_multi',
      cardParams: {
        chatId: 'oc_test_chat',
      },
      pollIntervalMs: 100,
    });

    tracker.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(tracker.getAccumulatedText()).toBe('Segment 1 text\n\nSegment 2 text');
    const finalPush = transport.streamingCalls.filter((c) => c.type === 'push').pop();
    expect(finalPush?.content).toBe('Segment 1 text\n\nSegment 2 text');
  });

  it('returns handled false when failStreamingCard is true', async () => {
    const transport = new FakeLarkTransport();
    transport.failStreamingCard = true;
    await transport.start();

    const fakeSource: StreamEventSource = {
      listAssistantEvents: vi.fn().mockResolvedValue([]),
    };

    const tracker = new StreamingReplyTracker({
      transport,
      streamEventSource: fakeSource,
      sessionRouteId: 'session_2',
      cardParams: {
        chatId: 'oc_fail_chat',
      },
      pollIntervalMs: 100,
    });

    tracker.start();
    await vi.advanceTimersByTimeAsync(0);

    const result = await tracker.finalize('Fallback text', 'completed');
    expect(result.handled).toBe(false);
    expect(result.messageId).toBeUndefined();
  });

  it('returns handled true with degraded flag if session finalize throws when card exists', async () => {
    const transport = new FakeLarkTransport();
    await transport.start();

    const fakeSource: StreamEventSource = {
      listAssistantEvents: vi.fn().mockResolvedValue([]),
    };

    // Mock createStreamingCard session finalize failure
    const origCreateStreamingCard = transport.createStreamingCard.bind(transport);
    transport.createStreamingCard = async (params) => {
      const session = await origCreateStreamingCard(params);
      if (session) {
        session.finalize = async () => {
          throw new Error('Lark API 500 error');
        };
      }
      return session;
    };

    // New tracker with failing finalize
    const failingTracker = new StreamingReplyTracker({
      transport,
      streamEventSource: fakeSource,
      sessionRouteId: 'session_3',
      cardParams: {
        chatId: 'oc_test_chat_3',
      },
      pollIntervalMs: 100,
    });

    failingTracker.start();
    await vi.advanceTimersByTimeAsync(0);

    const result = await failingTracker.finalize('Fallback on throw', 'completed');
    expect(result.handled).toBe(true);
    expect(result.messageId).toMatch(/^om_/);
    expect(result.degraded).toBe(true);
  });

  it('stops cursor at terminal completed row when batch contains a second turn and does not accumulate second turn deltas', async () => {
    const transport = new FakeLarkTransport();
    await transport.start();

    // Batch contains turn 1 completed followed immediately by turn 2 running + deltas
    const events: Array<{
      rowId: number;
      type: 'assistant_delta' | 'assistant_stream_end' | 'turn_status';
      delta?: string;
      streamId?: string;
      status?: string;
    }> = [
      { rowId: 10, type: 'assistant_delta', delta: 'Turn 1 text', streamId: 's1' },
      { rowId: 11, type: 'turn_status', status: 'completed' },
      { rowId: 12, type: 'turn_status', status: 'running' },
      { rowId: 13, type: 'assistant_delta', delta: 'Turn 2 text', streamId: 's2' },
    ];

    const fakeSource: StreamEventSource = {
      listAssistantEvents: vi.fn().mockResolvedValue(events),
    };

    const tracker = new StreamingReplyTracker({
      transport,
      streamEventSource: fakeSource,
      sessionRouteId: 'session_batch_terminal',
      cardParams: {
        chatId: 'oc_test_chat_terminal',
      },
      initialCursor: 0,
      pollIntervalMs: 100,
    });

    tracker.start();
    await vi.advanceTimersByTimeAsync(0);

    // Cursor stops at row 11 (the completed row)
    expect(tracker.getCursor()).toBe(11);
    // Turn 2 text is NOT accumulated
    expect(tracker.getAccumulatedText()).toBe('Turn 1 text');
    expect(tracker.isActive()).toBe(false);

    const res = await tracker.finalize('Turn 1 final', 'completed');
    expect(res.handled).toBe(true);
    expect(tracker.getCursor()).toBe(11);
  });

  it('tool_status running count line appears in pushed text and not in finalized text', async () => {
    const transport = new FakeLarkTransport();
    await transport.start();

    const events: Array<{
      rowId: number;
      type: 'assistant_delta' | 'assistant_stream_end' | 'turn_status' | 'tool_status';
      delta?: string;
      streamId?: string;
      status?: string;
      toolName?: string;
    }> = [
      { rowId: 1, type: 'assistant_delta', delta: 'Working on task...', streamId: 's1' },
      { rowId: 2, type: 'tool_status', toolName: 'subagent', status: 'started' },
    ];

    const fakeSource: StreamEventSource = {
      listAssistantEvents: vi.fn().mockImplementation(async (_r, after) => {
        return events.filter((e) => e.rowId > after);
      }),
    };

    const tracker = new StreamingReplyTracker({
      transport,
      streamEventSource: fakeSource,
      sessionRouteId: 'session_tool_status',
      cardParams: {
        chatId: 'oc_test_chat_tool',
      },
      initialCursor: 0,
      pollIntervalMs: 100,
    });

    tracker.start();
    await vi.advanceTimersByTimeAsync(0);

    // Pushed text should contain the running tool count status line
    const pushes = transport.streamingCalls.filter((c) => c.type === 'push');
    expect(pushes.length).toBeGreaterThanOrEqual(1);
    const lastPush = pushes[pushes.length - 1];
    expect(lastPush.content).toContain('Working on task...');
    expect(lastPush.content).toContain('⏳ 后台任务运行中：subagent ×1');

    // Tool finishes
    events.push({ rowId: 3, type: 'tool_status', toolName: 'subagent', status: 'completed' });
    events.push({ rowId: 4, type: 'turn_status', status: 'completed' });

    await vi.advanceTimersByTimeAsync(100);

    // Finalize
    const res = await tracker.finalize('Final task report', 'completed');
    expect(res.handled).toBe(true);

    const finalizeCall = transport.streamingCalls.find((c) => c.type === 'finalize');
    expect(finalizeCall).toBeDefined();
    // Final text must NOT have the status line
    expect(finalizeCall?.content).toBe('Final task report');
    expect(finalizeCall?.content).not.toContain('⏳ 后台任务运行中');
  });

  it('stops polling after maxDurationMs', async () => {
    const transport = new FakeLarkTransport();
    await transport.start();

    const fakeSource: StreamEventSource = {
      listAssistantEvents: vi.fn().mockResolvedValue([]),
    };

    const tracker = new StreamingReplyTracker({
      transport,
      streamEventSource: fakeSource,
      sessionRouteId: 'session_timeout',
      cardParams: {
        chatId: 'oc_test_chat_timeout',
      },
      pollIntervalMs: 100,
      maxDurationMs: 500,
    });

    tracker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fakeSource.listAssistantEvents).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(600);
    const callsAfterTimeout = (fakeSource.listAssistantEvents as any).mock.calls.length;

    await vi.advanceTimersByTimeAsync(300);
    expect((fakeSource.listAssistantEvents as any).mock.calls.length).toBe(callsAfterTimeout);
  });

  it('subagent counter drops to 0 with empty accumulated text does not push empty text', async () => {
    const transport = new FakeLarkTransport();
    await transport.start();

    const events: Array<{
      rowId: number;
      type: 'assistant_delta' | 'assistant_stream_end' | 'turn_status' | 'tool_status';
      delta?: string;
      streamId?: string;
      status?: string;
      toolName?: string;
    }> = [
      { rowId: 1, type: 'tool_status', toolName: 'subagent', status: 'started' },
    ];

    const fakeSource: StreamEventSource = {
      listAssistantEvents: vi.fn().mockImplementation(async (_r, after) => {
        return events.filter((e) => e.rowId > after);
      }),
    };

    const tracker = new StreamingReplyTracker({
      transport,
      streamEventSource: fakeSource,
      sessionRouteId: 'session_empty_subagent',
      cardParams: {
        chatId: 'oc_test_chat_empty_subagent',
      },
      initialCursor: 0,
      pollIntervalMs: 100,
    });

    tracker.start();
    await vi.advanceTimersByTimeAsync(0);

    // Initial push contains subagent status line
    const pushes1 = transport.streamingCalls.filter((c) => c.type === 'push');
    expect(pushes1.length).toBe(1);
    expect(pushes1[0].content).toContain('⏳ 后台任务运行中：subagent ×1');

    // Subagent completes before any delta arrives; accumulatedText is still empty
    events.push({ rowId: 2, type: 'tool_status', toolName: 'subagent', status: 'completed' });
    await vi.advanceTimersByTimeAsync(100);

    // No pushText('') call should be made!
    const pushes2 = transport.streamingCalls.filter((c) => c.type === 'push');
    expect(pushes2.length).toBe(1);
    expect(pushes2.some((c) => !c.content || c.content.trim() === '')).toBe(false);

    // Finalize with actual reply text
    const res = await tracker.finalize('Final answer after subagent', 'completed');
    expect(res.handled).toBe(true);

    const finalizeCall = transport.streamingCalls.find((c) => c.type === 'finalize');
    expect(finalizeCall).toBeDefined();
    expect(finalizeCall?.content).toBe('Final answer after subagent');
  });

  it('waits in queued state without creating card or accumulating earlier deltas, then streams upon becoming running', async () => {
    const transport = new FakeLarkTransport();
    await transport.start();

    // Pre-existing events from a previous turn
    const events: Array<{
      rowId: number;
      type: 'assistant_delta' | 'assistant_stream_end' | 'turn_status';
      delta?: string;
      streamId?: string;
      status?: string;
    }> = [
      { rowId: 1, type: 'assistant_delta', delta: 'Turn 1 delta 1', streamId: 's1' },
      { rowId: 2, type: 'assistant_delta', delta: 'Turn 1 delta 2', streamId: 's1' },
    ];

    let stateCallCount = 0;
    const fakeSource: StreamEventSource = {
      getLatestRowId: vi.fn().mockImplementation(async () => {
        return events.length > 0 ? events[events.length - 1].rowId : 0;
      }),
      listAssistantEvents: vi.fn().mockImplementation(async (_routeId, afterRowId) => {
        return events.filter((e) => e.rowId > afterRowId);
      }),
      getPlatformTurnState: vi.fn().mockImplementation(async () => {
        stateCallCount++;
        // 'queued' for 3 ticks, then 'running'
        if (stateCallCount <= 3) {
          return 'queued';
        }
        return 'running';
      }),
    };

    const tracker = new StreamingReplyTracker({
      transport,
      streamEventSource: fakeSource,
      sessionRouteId: 'session_waiting_test',
      turnId: 'turn_2_queued',
      cardParams: {
        chatId: 'oc_test_chat_waiting',
      },
      pollIntervalMs: 100,
    });

    tracker.start();

    // Tick 1 (immediate at 0 ms) -> stateCallCount 1 ('queued')
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.streamingCalls.length).toBe(0);
    expect(tracker.isActive()).toBe(true);

    // Tick 2 (at 100 ms) -> stateCallCount 2 ('queued')
    await vi.advanceTimersByTimeAsync(100);
    expect(transport.streamingCalls.length).toBe(0);
    expect(tracker.isActive()).toBe(true);

    // Tick 3 (at 200 ms) -> stateCallCount 3 ('queued')
    await vi.advanceTimersByTimeAsync(100);
    expect(transport.streamingCalls.length).toBe(0);
    expect(tracker.isActive()).toBe(true);
    expect(tracker.getAccumulatedText()).toBe('');

    // Tick 4 (at 300 ms) -> stateCallCount 4 ('running')
    // Cursor snapshots to latest (2), card is created, no pre-existing rows accumulated
    await vi.advanceTimersByTimeAsync(100);
    expect(transport.streamingCalls.length).toBe(1);
    expect(transport.streamingCalls[0].type).toBe('card_create');
    expect(tracker.getAccumulatedText()).toBe('');
    expect(tracker.isActive()).toBe(true);

    // New event arrives for this turn
    events.push({ rowId: 3, type: 'assistant_delta', delta: 'Turn 2 running reply', streamId: 's2' });
    await vi.advanceTimersByTimeAsync(100);

    const pushes = transport.streamingCalls.filter((c) => c.type === 'push');
    expect(pushes.length).toBe(1);
    expect(pushes[0].content).toBe('Turn 2 running reply');
    expect(tracker.getAccumulatedText()).toBe('Turn 2 running reply');
    expect(tracker.isActive()).toBe(true);

    const res = await tracker.finalize('Turn 2 running reply', 'completed');
    expect(res.handled).toBe(true);
  });
});
