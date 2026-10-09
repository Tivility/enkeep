import { describe, it, expect, vi } from 'vitest';
import {
  FakeLarkTransport,
  buildStreamingStatusLine,
  formatDuration,
  formatToolStatusMarkdown,
  isSubagentTool,
} from '../src/transport.js';
import { StreamingReplyTracker } from '../src/streaming-tracker.js';
import type {
  CardToolStatusEntry,
  StreamAssistantEvent,
  StreamEventSource,
} from '../src/types.js';

describe('I4 & I5: Subagent Progress and Elapsed/Last-Activity Indicator (Parity Alignment)', () => {
  describe('I4: Subagent Progress & Panel Rendering', () => {
    it('isSubagentTool identifies subagent by isSubagent flag or tool name', () => {
      expect(isSubagentTool({ toolName: 'subagent', status: 'running' })).toBe(true);
      expect(isSubagentTool({ toolName: 'subagent_fork', status: 'running' })).toBe(true);
      expect(isSubagentTool({ toolName: 'create_task', status: 'running' })).toBe(true);
      expect(isSubagentTool({ toolName: 'custom_worker', status: 'running', isSubagent: true })).toBe(true);
      expect(isSubagentTool({ toolName: 'web_search', status: 'running' })).toBe(false);
      expect(isSubagentTool({ toolName: 'bash', status: 'running' })).toBe(false);
    });

    it('formatToolStatusMarkdown prioritizes subagents at top with dynamic tags, elapsed duration, and description', () => {
      const now = 1_700_000_010_000;
      const entries: CardToolStatusEntry[] = [
        {
          toolName: 'web_search',
          status: 'running',
        },
        {
          toolName: 'subagent',
          status: 'running',
          startTime: now - 3_500,
          description: 'synthetic subagent task description',
        },
        {
          toolName: 'subagent_fork',
          status: 'completed',
          startTime: now - 15_000,
          endTime: now - 5_000,
          description: 'synthetic secondary subtask done',
        },
      ];

      const md = formatToolStatusMarkdown(entries, now);
      expect(md).not.toBeNull();

      // Top section has subagent header
      expect(md).toContain('🤖 **子任务 / Subagents**');
      // Running subagent with blue tag, elapsed duration, and description
      expect(md).toContain("<text_tag color='blue'>运行</text_tag> 🤖 **subagent**: 正在执行… <font color='grey'>· 3.5s</font>");
      expect(md).toContain('synthetic subagent task description');

      // Completed subagent with green tag and duration
      expect(md).toContain("<text_tag color='green'>完成</text_tag> 🤖 **subagent_fork**: 已完成 <font color='grey'>· 10s</font>");
      expect(md).toContain('synthetic secondary subtask done');

      // Normal tool below
      expect(md).toContain('🔨 **工具调用**');
      expect(md).toContain('🔨 **web_search**: 正在执行…');

      // Verify subagent section appears before ordinary tool calls
      const subagentIdx = md!.indexOf('🤖 **子任务 / Subagents**');
      const toolIdx = md!.indexOf('🔨 **工具调用**');
      expect(subagentIdx).toBeLessThan(toolIdx);
    });

    it('StreamingReplyTracker tracks subagent metadata and timestamps across started and completed events', async () => {
      vi.useFakeTimers();
      try {
        const transport = new FakeLarkTransport();
        await transport.start();

        const events: StreamAssistantEvent[] = [
          {
            rowId: 1,
            type: 'tool_status',
            toolName: 'subagent',
            status: 'started',
            description: 'synthetic subagent analyzing data',
          },
        ];

        const fakeSource: StreamEventSource = {
          listAssistantEvents: async (_r, after) => events.filter((e) => e.rowId > after),
        };

        const tracker = new StreamingReplyTracker({
          transport,
          streamEventSource: fakeSource,
          sessionRouteId: 'ses_test_synthetic_i4',
          cardParams: { chatId: 'oc_test_chat_synthetic_i4' },
          withStatusPanel: true,
          pollIntervalMs: 100,
        });

        tracker.start();
        await vi.advanceTimersByTimeAsync(0);

        const activeEntries = tracker.getToolStatusEntries();
        expect(activeEntries.length).toBe(1);
        expect(activeEntries[0].toolName).toBe('subagent');
        expect(activeEntries[0].status).toBe('running');
        expect(activeEntries[0].isSubagent).toBe(true);
        expect(activeEntries[0].startTime).toBeDefined();
        expect(activeEntries[0].description).toBe('synthetic subagent analyzing data');

        // Subagent completes after 4 seconds
        vi.advanceTimersByTime(4000);
        events.push({
          rowId: 2,
          type: 'tool_status',
          toolName: 'subagent',
          status: 'completed',
        });
        await vi.advanceTimersByTimeAsync(100);

        const updatedEntries = tracker.getToolStatusEntries();
        expect(updatedEntries.length).toBe(1);
        expect(updatedEntries[0].status).toBe('completed');
        expect(updatedEntries[0].endTime).toBeDefined();
        expect(updatedEntries[0].endTime!).toBeGreaterThanOrEqual(updatedEntries[0].startTime!);

        await tracker.finalize('synthetic final text', 'completed');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('I5: Elapsed, Last-Activity Indicator & Bounded Heartbeat', () => {
    it('formatDuration accurately formats duration buckets', () => {
      expect(formatDuration(undefined)).toBe('-');
      expect(formatDuration(-1)).toBe('-');
      expect(formatDuration(0)).toBe('0s');
      expect(formatDuration(450)).toBe('450ms');
      expect(formatDuration(5000)).toBe('5s');
      expect(formatDuration(12500)).toBe('12.5s');
      expect(formatDuration(60000)).toBe('1m');
      expect(formatDuration(135000)).toBe('2m 15s');
    });

    it('buildStreamingStatusLine constructs valid Schema 2.0 status element with 5s bucketing and liveness', () => {
      const now = 1_700_000_015_000;
      // Normal running status within stale threshold
      const line1 = buildStreamingStatusLine({
        elapsedMs: 12_500,
        nowMs: now,
        lastActivityAt: now - 10_000,
      });
      expect(line1).toContain("⏳ 已用 10s · 更新 <local_datetime millisecond='1700000015000' format_type='time_sec'></local_datetime>");
      expect(line1).not.toContain('无新事件');

      // Stale running status (>120s silence)
      const line2 = buildStreamingStatusLine({
        elapsedMs: 150_000,
        nowMs: now,
        lastActivityAt: now - 130_000,
        staleThresholdMs: 120_000,
      });
      expect(line2).toContain('⏳ 已用 2m 30s');
      expect(line2).toContain('· 2m 10s 无新事件，仍在运行');

      // Running tool status line tests
      const lineJob = buildStreamingStatusLine({
        elapsedMs: 600_000,
        nowMs: now,
        lastActivityAt: now - 451_000,
        runningTool: 'job_output',
      });
      expect(lineJob).toContain('⏳ 已用 10m');
      expect(lineJob).toContain('· 等待后台任务结果（job_output）');
      expect(lineJob).toContain('· 7m 31s 无新事件，仍在运行');

      const lineWorkflow = buildStreamingStatusLine({
        elapsedMs: 30_000,
        nowMs: now,
        runningTool: 'workflow',
      });
      expect(lineWorkflow).toContain('· 运行 workflow …');

      const lineOther = buildStreamingStatusLine({
        elapsedMs: 30_000,
        nowMs: now,
        runningTool: 'web_search',
      });
      expect(lineOther).toContain('· web_search 执行中');
    });

    it('createStreamingCard includes streaming_status_bar element when withStatusBar is enabled', async () => {
      const transport = new FakeLarkTransport();
      await transport.start();

      const session = await transport.createStreamingCard({
        chatId: 'oc_test_status_bar',
        withStatusBar: true,
      });
      expect(session).not.toBeNull();

      const createCall = transport.streamingCalls.find((c) => c.type === 'card_create');
      expect(createCall).toBeDefined();
      const elements = createCall?.card.body.elements;
      const statusBar = elements.find((e: any) => e.element_id === 'streaming_status_bar');
      expect(statusBar).toBeDefined();
      expect(statusBar.tag).toBe('markdown');
      expect(statusBar.text_size).toBe('notation');
      expect(statusBar.content).toContain('⏳ 已用 0s');
    });

    it('idle heartbeat updates status line in bounded 5s intervals during long-running tool execution without text changes', async () => {
      vi.useFakeTimers();
      try {
        const transport = new FakeLarkTransport();
        await transport.start();

        const events: StreamAssistantEvent[] = [
          { rowId: 1, type: 'assistant_delta', delta: 'Initial synthetic report started...', streamId: 's1' },
          { rowId: 2, type: 'tool_status', toolName: 'subagent', status: 'started' },
        ];

        const fakeSource: StreamEventSource = {
          listAssistantEvents: async (_r, after) => events.filter((e) => e.rowId > after),
        };

        const tracker = new StreamingReplyTracker({
          transport,
          streamEventSource: fakeSource,
          sessionRouteId: 'ses_test_synthetic_i5',
          cardParams: { chatId: 'oc_test_chat_synthetic_i5' },
          withStatusBar: true,
          pollIntervalMs: 500,
        });

        tracker.start();
        await vi.advanceTimersByTimeAsync(0);

        // First push containing text
        const initialPushes = transport.streamingCalls.filter((c) => c.type === 'push');
        expect(initialPushes.length).toBe(1);

        // Advance 2 seconds: no text changes, under 5s bucket -> no pushStatusLine
        await vi.advanceTimersByTimeAsync(2000);
        const statusCallsAt2s = transport.streamingCalls.filter((c) => c.type === 'push_status_line');
        expect(statusCallsAt2s.length).toBe(0);

        // Advance past 5 seconds (to 5.5s): 5s bucket threshold reached -> exactly 1 heartbeat pushStatusLine
        await vi.advanceTimersByTimeAsync(3500);
        const statusCallsAt5s = transport.streamingCalls.filter((c) => c.type === 'push_status_line');
        expect(statusCallsAt5s.length).toBe(1);
        expect(statusCallsAt5s[0].content).toContain('⏳ 已用 5s');

        // Advance another 5 seconds (to 10.5s): second bounded heartbeat push
        await vi.advanceTimersByTimeAsync(5000);
        const statusCallsAt10s = transport.streamingCalls.filter((c) => c.type === 'push_status_line');
        expect(statusCallsAt10s.length).toBe(2);
        expect(statusCallsAt10s[1].content).toContain('⏳ 已用 10s');

        tracker.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('final card removes streaming_status_bar and shows total elapsed in footer metadata', async () => {
      vi.useFakeTimers();
      try {
        const transport = new FakeLarkTransport();
        await transport.start();

        const fakeSource: StreamEventSource = {
          listAssistantEvents: async () => [],
        };

        const tracker = new StreamingReplyTracker({
          transport,
          streamEventSource: fakeSource,
          sessionRouteId: 'ses_test_synthetic_final',
          cardParams: { chatId: 'oc_test_chat_synthetic_final' },
          withStatusBar: true,
          pollIntervalMs: 100,
        });

        tracker.start();
        await vi.advanceTimersByTimeAsync(0);

        // Simulate 4.5 seconds execution time
        vi.advanceTimersByTime(4500);

        const res = await tracker.finalize('synthetic final answer content', 'completed');
        expect(res.handled).toBe(true);

        const finalizeCall = transport.streamingCalls.find((c) => c.type === 'finalize');
        expect(finalizeCall).toBeDefined();

        const elements = finalizeCall?.card.body.elements;
        // streaming_status_bar must be removed from final card
        const liveStatusBar = elements.find((e: any) => e.element_id === 'streaming_status_bar');
        expect(liveStatusBar).toBeUndefined();

        // Footer must be present and display total elapsed
        const footerElement = elements.find((e: any) => e.text_size === 'notation');
        expect(footerElement).toBeDefined();
        expect(footerElement.content).toMatch(/⏱ \d+(\.\d+)?s/);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
