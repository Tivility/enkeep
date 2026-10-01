import { describe, it, expect, vi } from 'vitest';
import {
  FakeLarkTransport,
  buildToolsTimelineText,
  parseToolParam,
  truncate,
  formatToolStatusMarkdown,
  type ToolCallView,
} from '../src/transport.js';
import { StreamingReplyTracker } from '../src/streaming-tracker.js';
import type { CardToolStatusEntry, StreamAssistantEvent, StreamEventSource } from '../src/types.js';

describe('Feishu Card Tool Display & HappyClaw Alignment (Issues 1001 / FT)', () => {
  describe('D1 & D2: parseToolParam & Skill Display Name Mapping', () => {
    it('parseToolParam extracts standard labeled parameters across tool categories', () => {
      expect(parseToolParam('read', '/synthetic/path/file.txt')).toEqual({
        label: 'path',
        value: '/synthetic/path/file.txt',
      });
      expect(parseToolParam('write', '/synthetic/output.md')).toEqual({
        label: 'path',
        value: '/synthetic/output.md',
      });
      expect(parseToolParam('edit', '/synthetic/config.json')).toEqual({
        label: 'path',
        value: '/synthetic/config.json',
      });
      expect(parseToolParam('glob', '**/*.ts')).toEqual({
        label: 'path',
        value: '**/*.ts',
      });
      expect(parseToolParam('bash', 'npm test -- --run')).toEqual({
        label: 'cmd',
        value: 'npm test -- --run',
      });
      expect(parseToolParam('grep', 'synthetic_search_regex')).toEqual({
        label: 'pattern',
        value: 'synthetic_search_regex',
      });
      expect(parseToolParam('subagent', 'execute synthetic delegation task')).toEqual({
        label: 'task',
        value: 'execute synthetic delegation task',
      });
      expect(parseToolParam('web_fetch', 'https://synthetic.example.com/api/v1')).toEqual({
        label: 'url',
        value: 'https://synthetic.example.com/api/v1',
      });
      expect(parseToolParam('custom_tool', 'arbitrary synthetic input argument')).toEqual({
        label: 'input',
        value: 'arbitrary synthetic input argument',
      });
      expect(parseToolParam('bash', undefined)).toBeNull();
      expect(parseToolParam('bash', '')).toBeNull();
    });

    it('parseToolParam unwraps JSON-encoded arguments string', () => {
      const jsonArgs = JSON.stringify({
        command: 'echo "synthetic output"',
        timeout: 1000,
      });
      expect(parseToolParam('bash', jsonArgs)).toEqual({
        label: 'cmd',
        value: 'echo "synthetic output"',
      });

      const pathArgs = JSON.stringify({
        file_path: '/synthetic/repo/package.json',
      });
      expect(parseToolParam('read', pathArgs)).toEqual({
        label: 'path',
        value: '/synthetic/repo/package.json',
      });
    });

    it('truncate clips string to character limit with ellipsis', () => {
      expect(truncate('short text', 20)).toBe('short text');
      expect(truncate('12345678901234567890', 10)).toBe('123456789…');
    });

    it('buildToolsTimelineText renders skill business name instead of generic tool name', () => {
      const tools: ToolCallView[] = [
        {
          name: 'Skill',
          skillName: 'synthetic-code-reviewer',
          status: 'complete',
          durationMs: 2,
        },
      ];
      const text = buildToolsTimelineText(tools);
      expect(text).toContain("<text_tag color='green'>完成</text_tag> `synthetic-code-reviewer` <font color='grey'>(2ms)</font>");
      expect(text).not.toContain('`Skill`');
    });
  });

  describe('D3 & D4: Repeated Invocations & Execution Durations', () => {
    it('renders distinct entries with command parameters and duration for repeated calls', () => {
      const tools: ToolCallView[] = [
        {
          name: 'bash',
          status: 'complete',
          durationMs: 116,
          summary: 'git status --short',
        },
        {
          name: 'bash',
          status: 'complete',
          durationMs: 254,
          summary: 'pnpm test --run',
        },
        {
          name: 'bash',
          status: 'complete',
          durationMs: 118,
          summary: 'git diff HEAD',
        },
      ];

      const text = buildToolsTimelineText(tools);
      // Each entry has its own cmd summary and distinct duration
      expect(text).toContain("<text_tag color='green'>完成</text_tag> `bash` <font color='grey'>(116ms)</font>\n  <font color='grey'>cmd: git status --short</font>");
      expect(text).toContain("<text_tag color='green'>完成</text_tag> `bash` <font color='grey'>(254ms)</font>\n  <font color='grey'>cmd: pnpm test --run</font>");
      expect(text).toContain("<text_tag color='green'>完成</text_tag> `bash` <font color='grey'>(118ms)</font>\n  <font color='grey'>cmd: git diff HEAD</font>");
    });
  });

  describe('D5: Schema 2.0 State Badges', () => {
    it('uses Schema 2.0 text_tag for running (blue), complete (green), and failed (red)', () => {
      const tools: ToolCallView[] = [
        { name: 'read', status: 'running', durationMs: 450, summary: '/path/a.ts' },
        { name: 'write', status: 'complete', durationMs: 120, summary: '/path/b.ts' },
        { name: 'bash', status: 'error', durationMs: 980, summary: 'false' },
      ];
      const text = buildToolsTimelineText(tools);
      expect(text).toContain("<text_tag color='blue'>运行</text_tag> `read` <font color='grey'>(450ms)</font>");
      expect(text).toContain("<text_tag color='green'>完成</text_tag> `write` <font color='grey'>(120ms)</font>");
      expect(text).toContain("<text_tag color='red'>失败</text_tag> `bash` <font color='grey'>(980ms)</font>");
    });
  });

  describe('D7: Max Visible 8 Items & Collapse', () => {
    it('truncates 22 tool calls to 8 visible items and adds collapsed count indicator', () => {
      const tools: ToolCallView[] = Array.from({ length: 22 }, (_, i) => ({
        name: 'bash',
        status: i === 21 ? 'running' : 'complete',
        durationMs: 100 + i,
        summary: `echo "synthetic step ${i + 1}"`,
      }));

      const text = buildToolsTimelineText(tools, { maxVisible: 8 });
      const lines = text.split('\n').filter((l) => l.includes('<text_tag'));
      expect(lines.length).toBe(8);
      expect(text).toContain("<font color='grey'>… 另有 14 条工具记录已收起</font>");
      // Priority: running item is preserved in visible list
      expect(text).toContain("<text_tag color='blue'>运行</text_tag> `bash`");
    });
  });

  describe('D9: Hierarchical Subagent Nesting Indentation', () => {
    it('applies 4-space indentation for nested subagent tool calls', () => {
      const tools: ToolCallView[] = [
        { name: 'agent', status: 'running', durationMs: 500, summary: 'parent agent task' },
        { name: 'read', status: 'complete', durationMs: 30, summary: '/inner/file.ts', isNested: true },
      ];
      const text = buildToolsTimelineText(tools);
      expect(text).toContain("<text_tag color='blue'>运行</text_tag> `agent`");
      expect(text).toContain("    <text_tag color='green'>完成</text_tag> `read`");
    });
  });

  describe('D10: AskUserQuestion Filtering', () => {
    it('filters out AskUserQuestion from buildToolsTimelineText', () => {
      const tools: ToolCallView[] = [
        { name: 'AskUserQuestion', status: 'running', durationMs: 1000, summary: 'Which mode do you prefer?' },
        { name: 'read', status: 'complete', durationMs: 50, summary: '/file.ts' },
      ];
      const text = buildToolsTimelineText(tools);
      expect(text).not.toContain('AskUserQuestion');
      expect(text).toContain('`read`');
    });

    it('filters out AskUserQuestion from formatToolStatusMarkdown', () => {
      const entries: CardToolStatusEntry[] = [
        { toolName: 'AskUserQuestion', status: 'running', description: 'Question text' },
      ];
      const md = formatToolStatusMarkdown(entries);
      expect(md).toBeNull();
    });
  });

  describe('D6 & Terminal Settlement in StreamingReplyTracker', () => {
    it('settles lingering running tools to failed when turn terminates with interrupted or failed', async () => {
      vi.useFakeTimers();
      try {
        const transport = new FakeLarkTransport();
        await transport.start();

        const events: StreamAssistantEvent[] = [
          { rowId: 1, type: 'tool_status', toolName: 'bash', status: 'started', description: 'sleep 100' },
          { rowId: 2, type: 'turn_status', status: 'interrupted' },
        ];

        const fakeSource: StreamEventSource = {
          listAssistantEvents: async (_r, after) => events.filter((e) => e.rowId > after),
        };

        const tracker = new StreamingReplyTracker({
          transport,
          streamEventSource: fakeSource,
          sessionRouteId: 'ses_synthetic_interrupted_turn',
          cardParams: {
            chatId: 'oc_synthetic_interrupted',
            withStatusPanel: true,
          },
          initialCursor: 0,
          pollIntervalMs: 50,
        });

        tracker.start();
        await vi.advanceTimersByTimeAsync(100);

        const res = await tracker.finalize('Execution stopped by user', 'stopped');
        expect(res.handled).toBe(true);

        const toolEntries = tracker.getToolStatusEntries();
        expect(toolEntries.length).toBe(1);
        expect(toolEntries[0].status).toBe('failed');
        expect(toolEntries[0].endTime).toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('StreamingReplyTracker extracts args into description and ignores AskUserQuestion', async () => {
      vi.useFakeTimers();
      try {
        const transport = new FakeLarkTransport();
        await transport.start();

        const events: StreamAssistantEvent[] = [
          {
            rowId: 1,
            type: 'tool_status',
            toolName: 'AskUserQuestion',
            status: 'started',
            args: { question: 'Confirm action?' },
          },
          {
            rowId: 2,
            type: 'tool_status',
            toolName: 'read',
            status: 'started',
            args: { file_path: '/synthetic/workspace/target.ts' },
          },
          {
            rowId: 3,
            type: 'tool_status',
            toolName: 'read',
            status: 'completed',
          },
          { rowId: 4, type: 'turn_status', status: 'completed' },
        ];

        const fakeSource: StreamEventSource = {
          listAssistantEvents: async (_r, after) => events.filter((e) => e.rowId > after),
        };

        const tracker = new StreamingReplyTracker({
          transport,
          streamEventSource: fakeSource,
          sessionRouteId: 'ses_synthetic_args_extraction',
          cardParams: {
            chatId: 'oc_synthetic_args',
            withStatusPanel: true,
          },
          initialCursor: 0,
          pollIntervalMs: 50,
        });

        tracker.start();
        await vi.advanceTimersByTimeAsync(100);

        const toolEntries = tracker.getToolStatusEntries();
        // AskUserQuestion must be filtered out
        expect(toolEntries.some((e) => e.toolName === 'AskUserQuestion')).toBe(false);
        // read tool must have extracted file_path description
        const readEntry = toolEntries.find((e) => e.toolName === 'read');
        expect(readEntry).toBeDefined();
        expect(readEntry?.description).toBe('/synthetic/workspace/target.ts');
        expect(readEntry?.status).toBe('completed');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('D8: Final Card Status Panel Title Customization', () => {
    it('uses statusPanelTitle parameter for final collapsed panel header', async () => {
      const transport = new FakeLarkTransport();
      await transport.start();

      const session = await transport.createStreamingCard({
        chatId: 'oc_synthetic_panel_title',
        withStatusPanel: true,
        statusPanelTitle: '**🛠 工具时间轴**',
      });
      expect(session).not.toBeNull();

      const toolEntries: CardToolStatusEntry[] = [
        {
          toolName: 'bash',
          status: 'completed',
          description: 'synthetic test command',
          startTime: 1000,
          endTime: 1250,
        },
      ];

      await session!.finalize('Synthetic completed reply', 'completed', undefined, toolEntries);
      const finalizeCall = transport.streamingCalls.find((c) => c.type === 'finalize');
      expect(finalizeCall).toBeDefined();

      const elements = finalizeCall?.card.body.elements;
      const statusPanel = elements.find((el: any) => el.tag === 'collapsible_panel');
      expect(statusPanel).toBeDefined();
      expect(statusPanel.header.title.content).toBe('**🛠 工具时间轴**');
      expect(statusPanel.elements[0].content).toContain("<text_tag color='green'>完成</text_tag> `bash` <font color='grey'>(250ms)</font>");
      expect(statusPanel.elements[0].content).toContain('cmd: synthetic test command');
    });
  });
});
