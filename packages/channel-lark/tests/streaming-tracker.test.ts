import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  FakeLarkTransport,
  formatCardUsageFooter,
  CredentialedLarkTransport,
} from '../src/transport.js';
import {
  StreamingReplyTracker,
  extractTurnMetricsFromDb,
} from '../src/streaming-tracker.js';
import type {
  StreamEventSource,
  CardFinalMetadata,
  ILarkApiClient,
  LarkSdkClientFactory,
} from '../src/types.js';

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

  describe('C2: Final card compact usage footer (card-final-usage-footer)', () => {
    it('formatCardUsageFooter formats all metadata components accurately', () => {
      const full: CardFinalMetadata = {
        model: 'gpt-4o',
        durationSeconds: 8.4,
        promptTokens: 120,
        completionTokens: 45,
        cost: 0.0152,
      };
      expect(formatCardUsageFooter(full)).toBe(
        "<font color='grey'>🤖 gpt-4o · ⏱ 8.4s · 💡 120+45 tokens · 💰 $0.0152</font>"
      );
    });

    it('formatCardUsageFooter gracefully degrades and omits missing fields without fabricating numbers', () => {
      // Missing cost: cost is omitted
      const noCost: CardFinalMetadata = {
        model: 'claude-3-7-sonnet',
        durationSeconds: 3.2,
        totalTokens: 150,
      };
      expect(formatCardUsageFooter(noCost)).toBe(
        "<font color='grey'>🤖 claude-3-7-sonnet · ⏱ 3.2s · 💡 150 tokens</font>"
      );

      // Only model and duration
      const modelAndDuration: CardFinalMetadata = {
        model: 'deepseek-chat',
        durationMs: 4500,
      };
      expect(formatCardUsageFooter(modelAndDuration)).toBe(
        "<font color='grey'>🤖 deepseek-chat · ⏱ 4.5s</font>"
      );

      // Integer duration format
      const intDuration: CardFinalMetadata = {
        durationSeconds: 5,
        promptTokens: 80,
      };
      expect(formatCardUsageFooter(intDuration)).toBe(
        "<font color='grey'>⏱ 5s · 💡 80 tokens</font>"
      );

      // Only completion tokens
      expect(formatCardUsageFooter({ completionTokens: 40 })).toBe(
        "<font color='grey'>💡 40 tokens</font>"
      );

      // Integer cost format
      expect(formatCardUsageFooter({ model: 'custom', cost: 1 })).toBe(
        "<font color='grey'>🤖 custom · 💰 $1</font>"
      );

      // Empty or invalid returns null (no empty footer element)
      expect(formatCardUsageFooter(undefined)).toBeNull();
      expect(formatCardUsageFooter({})).toBeNull();
      expect(formatCardUsageFooter({ model: '   ' })).toBeNull();
    });

    it('tracker.finalize passes explicit metadata to final card session and renders footer markdown', async () => {
      const transport = new FakeLarkTransport();
      await transport.start();

      const fakeSource: StreamEventSource = {
        listAssistantEvents: vi.fn().mockResolvedValue([]),
      };

      const tracker = new StreamingReplyTracker({
        transport,
        streamEventSource: fakeSource,
        sessionRouteId: 'session_c2_1',
        cardParams: { chatId: 'oc_c2_chat' },
      });

      tracker.start();
      await vi.advanceTimersByTimeAsync(0);

      const metadata: CardFinalMetadata = {
        model: 'claude-3-5-sonnet',
        durationSeconds: 2.4,
        promptTokens: 200,
        completionTokens: 80,
      };

      const res = await tracker.finalize('Task completed successfully', 'completed', metadata);
      expect(res.handled).toBe(true);

      const finalizeCall = transport.streamingCalls.find((c) => c.type === 'finalize');
      expect(finalizeCall).toBeDefined();
      expect(finalizeCall?.metadata).toEqual(metadata);
      expect(finalizeCall?.card).toBeDefined();

      const elements = finalizeCall?.card.body.elements;
      expect(elements.length).toBe(2);
      expect(elements[0].content).toBe('Task completed successfully');
      expect(elements[1].tag).toBe('markdown');
      expect(elements[1].content).toBe(
        "<font color='grey'>🤖 claude-3-5-sonnet · ⏱ 2.4s · 💡 200+80 tokens</font>"
      );
    });

    it('tracker.finalize automatically queries streamEventSource.getTurnMetrics when available', async () => {
      const transport = new FakeLarkTransport();
      await transport.start();

      const queriedMetrics: CardFinalMetadata = {
        model: 'gemini-1.5-pro',
        durationSeconds: 1.8,
        totalTokens: 350,
      };

      const fakeSource: StreamEventSource = {
        listAssistantEvents: vi.fn().mockResolvedValue([]),
        getTurnMetrics: vi.fn().mockResolvedValue(queriedMetrics),
      };

      const tracker = new StreamingReplyTracker({
        transport,
        streamEventSource: fakeSource,
        sessionRouteId: 'session_c2_source',
        turnId: 'turn_source_001',
        cardParams: { chatId: 'oc_c2_chat' },
      });

      tracker.start();
      await vi.advanceTimersByTimeAsync(0);

      const res = await tracker.finalize('Result via getTurnMetrics', 'completed');
      expect(res.handled).toBe(true);
      expect(fakeSource.getTurnMetrics).toHaveBeenCalledWith('session_c2_source', 'turn_source_001');

      const finalizeCall = transport.streamingCalls.find((c) => c.type === 'finalize');
      expect(finalizeCall?.metadata?.model).toBe('gemini-1.5-pro');
      expect(finalizeCall?.metadata?.totalTokens).toBe(350);

      const elements = finalizeCall?.card.body.elements;
      expect(elements[elements.length - 1].content).toBe(
        "<font color='grey'>🤖 gemini-1.5-pro · ⏱ 1.8s · 💡 350 tokens</font>"
      );
    });

    it('tracker.finalize extracts metadata from SQLite turn_runs and related tables', async () => {
      const transport = new FakeLarkTransport();
      await transport.start();

      const fakeDb = {
        prepare: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM turn_runs')) {
            return {
              get: () => ({
                id: 'tr_1',
                turn_id: 'turn_db_001',
                started_at: '2026-03-30T10:00:00.000Z',
                finished_at: '2026-03-30T10:00:03.500Z',
                model: 'qwen-2.5-max',
                user_id: 'usr_c2',
                space_id: 'sp_c2',
              }),
            };
          }
          if (sql.includes('FROM task_runs')) {
            return {
              get: () => ({
                prompt_tokens: 150,
                completion_tokens: 60,
                total_tokens: 210,
              }),
            };
          }
          return { get: () => undefined };
        }),
      };

      const fakeSource: StreamEventSource = {
        listAssistantEvents: vi.fn().mockResolvedValue([]),
      };
      (fakeSource as any).db = fakeDb;

      const tracker = new StreamingReplyTracker({
        transport,
        streamEventSource: fakeSource,
        sessionRouteId: 'session_c2_db',
        turnId: 'turn_db_001',
        cardParams: { chatId: 'oc_c2_chat' },
      });

      tracker.start();
      await vi.advanceTimersByTimeAsync(0);

      const res = await tracker.finalize('Result via SQLite turn_runs', 'completed');
      expect(res.handled).toBe(true);

      const finalizeCall = transport.streamingCalls.find((c) => c.type === 'finalize');
      expect(finalizeCall?.metadata?.model).toBe('qwen-2.5-max');
      expect(finalizeCall?.metadata?.durationSeconds).toBe(3.5);
      expect(finalizeCall?.metadata?.promptTokens).toBe(150);
      expect(finalizeCall?.metadata?.completionTokens).toBe(60);

      const elements = finalizeCall?.card.body.elements;
      expect(elements[elements.length - 1].content).toBe(
        "<font color='grey'>🤖 qwen-2.5-max · ⏱ 3.5s · 💡 150+60 tokens</font>"
      );
    });

    it('CredentialedLarkTransport final card JSON renders footer markdown element at elements bottom', async () => {
      let updatedCardData: any;
      const mockClient = {
        im: {
          v1: {
            message: {
              create: vi.fn().mockResolvedValue({
                code: 0,
                data: { message_id: 'om_cred_card_1' },
              }),
              patch: vi.fn().mockResolvedValue({ code: 0 }),
            },
          },
        },
        cardkit: {
          v1: {
            card: {
              create: vi.fn().mockResolvedValue({
                code: 0,
                data: { card_id: 'card_cred_1' },
              }),
              settings: vi.fn().mockResolvedValue({ code: 0 }),
              update: vi.fn().mockImplementation((req: any) => {
                updatedCardData = JSON.parse(req.data.card.data);
                return { code: 0 };
              }),
              element: {
                content: vi.fn().mockResolvedValue({ code: 0 }),
              },
            },
          },
        },
      } as unknown as ILarkApiClient;

      const transport = new CredentialedLarkTransport({
        account: {
          id: 'acc_c2_test',
          userId: 'usr_c2',
          appId: 'cli_mock_c2',
          appSecret: 'sec_mock_c2',
        },
        clientFactory: {
          createClient: () => mockClient,
        } as LarkSdkClientFactory,
      });

      await transport.start();

      const session = await transport.createStreamingCard({
        chatId: 'oc_test_cred',
        title: 'C2 Test Bot',
      });
      expect(session).not.toBeNull();

      const metadata: CardFinalMetadata = {
        model: 'claude-3-7-sonnet',
        durationSeconds: 4.2,
        promptTokens: 300,
        completionTokens: 110,
        cost: 0.0084,
      };

      await session!.finalize('# Final Header\nActual answer text', 'completed', metadata);

      expect(updatedCardData).toBeDefined();
      expect(updatedCardData.schema).toBe('2.0');
      expect(updatedCardData.header.template).toBe('violet');

      const elements = updatedCardData.body.elements;
      expect(elements.length).toBe(2);
      expect(elements[0].tag).toBe('markdown');
      expect(elements[0].content).toContain('#### Final Header');
      expect(elements[1].tag).toBe('markdown');
      expect(elements[1].content).toBe(
        "<font color='grey'>🤖 claude-3-7-sonnet · ⏱ 4.2s · 💡 300+110 tokens · 💰 $0.0084</font>"
      );
    });
  });
});
