import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatBackgroundTaskLine,
  formatBackgroundPanel,
  LarkBackgroundPanelManager,
} from '../src/background-panel.js';
import type { BackgroundTask, LarkStreamingCardSession } from '../src/types.js';
import { FakeLarkTransport } from '../src/transport.js';

describe('Feishu/Lark Background Tasks Panel & Handoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('1. Task Line & Panel Markdown Formatter', () => {
    it('formats running task with kind, name, status, progress, and elapsed time', () => {
      const now = 1760000060000;
      const task: BackgroundTask = {
        id: 'ses_child_0000000000000001',
        shortId: 'c001',
        kind: 'subagent',
        name: 'synthetic-audit-worker',
        status: 'running',
        startedAt: new Date(now - 45000).toISOString(),
        lastActivityAt: new Date(now - 5000).toISOString(),
        stalled: false,
        progress: {
          agentsDone: 2,
          agentsTotal: 5,
        },
      };

      const line = formatBackgroundTaskLine(task, { now });
      expect(line).toBe('[subagent] synthetic-audit-worker · running · 2/5 agents · 45s');
    });

    it('formats step progress for job/workflow tasks', () => {
      const now = 1760000060000;
      const task: BackgroundTask = {
        id: 'job_0000000000000001',
        shortId: 'j001',
        kind: 'job',
        name: 'data-indexing-job',
        status: 'running',
        startedAt: new Date(now - 120000).toISOString(),
        lastActivityAt: new Date(now - 1000).toISOString(),
        stalled: false,
        progress: {
          step: 3,
        },
      };

      const line = formatBackgroundTaskLine(task, { now });
      expect(line).toBe('[job] data-indexing-job · running · step 3 · 2m');
    });

    it('marks stalled task with "⚠️ 可能卡住"', () => {
      const now = 1760000060000;
      const task: BackgroundTask = {
        id: 'ses_child_0000000000000002',
        shortId: 'c002',
        kind: 'workflow',
        name: 'heavy-codegen-flow',
        status: 'running',
        startedAt: new Date(now - 900000).toISOString(),
        lastActivityAt: new Date(now - 700000).toISOString(),
        stalled: true,
      };

      const line = formatBackgroundTaskLine(task, { now });
      expect(line).toContain('running ⚠️ 可能卡住');
      expect(line).toContain('[workflow] heavy-codegen-flow');
    });

    it('A-07: formats completed task as completed without assuming incorporated into active turn', () => {
      const now = 1760000060000;
      const task: BackgroundTask = {
        id: 'ses_child_0000000000000003',
        shortId: 'c003',
        kind: 'subagent',
        name: 'parallel-researcher',
        status: 'completed',
        startedAt: new Date(now - 30000).toISOString(),
        finishedAt: new Date(now - 5000).toISOString(),
        lastActivityAt: new Date(now - 5000).toISOString(),
        stalled: false,
      };

      const line = formatBackgroundTaskLine(task, { completedDuringActiveTurn: true, now });
      expect(line).toBe('[subagent] parallel-researcher · completed · 25s');
      expect(line).not.toContain('并入当前回复');
    });

    it('A-06: collapses to "✅ 后台任务已全部完成" ONLY when all tasks are completed', () => {
      const tasks: BackgroundTask[] = [
        {
          id: 'ses_child_0000000000000001',
          shortId: 'c001',
          kind: 'subagent',
          name: 'worker-1',
          status: 'completed',
          startedAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          stalled: false,
        },
        {
          id: 'ses_child_0000000000000002',
          shortId: 'c002',
          kind: 'job',
          name: 'job-2',
          status: 'completed',
          startedAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          stalled: false,
        },
      ];

      const panel = formatBackgroundPanel(tasks);
      expect(panel).toBe('✅ 后台任务已全部完成');
    });

    it('A-06: shows categorized breakdown when mixed with failed or cancelled tasks', () => {
      const tasks: BackgroundTask[] = [
        {
          id: 'ses_child_0000000000000001',
          shortId: 'c001',
          kind: 'subagent',
          name: 'worker-1',
          status: 'completed',
          startedAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          stalled: false,
        },
        {
          id: 'ses_child_0000000000000002',
          shortId: 'c002',
          kind: 'job',
          name: 'job-2',
          status: 'cancelled',
          startedAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          stalled: false,
        },
        {
          id: 'ses_child_0000000000000003',
          shortId: 'c003',
          kind: 'workflow',
          name: 'flow-3',
          status: 'failed',
          startedAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          stalled: false,
        },
      ];

      const panel = formatBackgroundPanel(tasks);
      expect(panel).toBe('后台任务已结束 (完成 1，失败 1，已停止 1)');
      expect(panel).not.toContain('全部完成');
    });
  });

  describe('2. LarkBackgroundPanelManager Handoff & Polling Lifecycle', () => {
    function createMockCardSession(cardId: string, messageId: string) {
      const updates: Array<string | null> = [];
      const session: LarkStreamingCardSession = {
        cardId,
        messageId,
        pushText: vi.fn(),
        finalize: vi.fn(),
        updateBackgroundPanel: vi.fn(async (panelText: string | null) => {
          updates.push(panelText);
        }),
      };
      return { session, updates };
    }

    it('renders panel on latest card and hands off when new card is registered', async () => {
      const sessionRouteId = 'session_route_test_001';
      const chatContextId = 'oc_test_chat_001';
      let mockTasks: BackgroundTask[] = [
        {
          id: 'task_001',
          shortId: 't001',
          kind: 'subagent',
          name: 'child-agent-1',
          status: 'running',
          startedAt: new Date(Date.now() - 10000).toISOString(),
          lastActivityAt: new Date().toISOString(),
          stalled: false,
          originTurnId: 'turn_001',
        },
      ];

      const manager = new LarkBackgroundPanelManager({
        getBackgroundTasks: async (_sessionId, options) => {
          expect(options?.chatContextId).toBe(chatContextId);
          return { items: mockTasks, updatedAt: new Date().toISOString() };
        },
        pollIntervalMs: 30_000,
      });

      // 1. Register Card 1 (Turn 1 launches task_001)
      const card1 = createMockCardSession('crd_001', 'om_msg_001');
      await manager.registerCard(sessionRouteId, chatContextId, card1.session, 'turn_001');

      expect(card1.updates.length).toBe(1);
      expect(card1.updates[0]).toContain('**🔄 后台任务**');
      expect(card1.updates[0]).toContain('[subagent] child-agent-1 · running');

      // 2. Register Card 2 (Turn 2 arrives in the same chat)
      const card2 = createMockCardSession('crd_002', 'om_msg_002');
      await manager.registerCard(sessionRouteId, chatContextId, card2.session, 'turn_002');

      // Card 1 collapses to notice since it launched 1 task
      expect(card1.updates[card1.updates.length - 1]).toBe('本轮启动了 1 个后台任务，进度见最新消息');

      // Card 2 now shows the active background panel
      expect(card2.updates.length).toBe(1);
      expect(card2.updates[0]).toContain('**🔄 后台任务**');
      expect(card2.updates[0]).toContain('[subagent] child-agent-1 · running');

      // 3. Register Card 3 (Turn 3 arrived without Turn 2 launching any tasks)
      const card3 = createMockCardSession('crd_003', 'om_msg_003');
      await manager.registerCard(sessionRouteId, chatContextId, card3.session, 'turn_003');

      // Card 2 did not launch tasks -> panel removed
      expect(card2.updates[card2.updates.length - 1]).toBeNull();

      // Card 3 receives the active background panel
      expect(card3.updates.length).toBe(1);
      expect(card3.updates[0]).toContain('**🔄 后台任务**');

      manager.dispose();
    });

    it('polls every ~30s while tasks are running and stops polling once all complete', async () => {
      const sessionRouteId = 'session_route_test_002';
      const chatContextId = 'oc_test_chat_002';
      let callCount = 0;

      let mockTasks: BackgroundTask[] = [
        {
          id: 'task_002',
          shortId: 't002',
          kind: 'job',
          name: 'background-crawler',
          status: 'running',
          startedAt: new Date(Date.now() - 5000).toISOString(),
          lastActivityAt: new Date().toISOString(),
          stalled: false,
        },
      ];

      const manager = new LarkBackgroundPanelManager({
        getBackgroundTasks: async () => {
          callCount++;
          return { items: mockTasks, updatedAt: new Date().toISOString() };
        },
        pollIntervalMs: 30_000,
      });

      const card = createMockCardSession('crd_poll_001', 'om_msg_poll_001');
      await manager.registerCard(sessionRouteId, chatContextId, card.session, 'turn_poll_1');

      expect(callCount).toBe(1);
      expect(card.updates[0]).toContain('[job] background-crawler · running');

      // Advance time by 30 seconds -> poll tick 2
      await vi.advanceTimersByTimeAsync(30_000);
      expect(callCount).toBe(2);

      // Advance time by another 30 seconds -> poll tick 3
      await vi.advanceTimersByTimeAsync(30_000);
      expect(callCount).toBe(3);

      // Now task completes
      mockTasks = [
        {
          id: 'task_002',
          shortId: 't002',
          kind: 'job',
          name: 'background-crawler',
          status: 'completed',
          startedAt: new Date(Date.now() - 65000).toISOString(),
          finishedAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          stalled: false,
        },
      ];

      // Next poll tick -> callCount is 4
      await vi.advanceTimersByTimeAsync(30_000);
      expect(callCount).toBe(4);
      expect(card.updates[card.updates.length - 1]).toBe('✅ 后台任务已全部完成');

      // Finalize turn -> triggers one final tick to settle and stop polling -> callCount becomes 5
      await manager.onTurnFinalized(sessionRouteId, chatContextId, 'turn_poll_1');
      expect(callCount).toBe(5);

      // Further time advancement should NOT trigger any new polls
      await vi.advanceTimersByTimeAsync(60_000);
      expect(callCount).toBe(5);

      manager.dispose();
    });

    it('A-01: retains panel and marks "⚠️ 状态暂不可用" when gateway returns available: false, keeping polling', async () => {
      const sessionRouteId = 'session_route_test_avail';
      const chatContextId = 'oc_test_chat_avail';
      let availableFlag = false;

      const card = createMockCardSession('crd_avail_001', 'om_msg_avail_001');
      const manager = new LarkBackgroundPanelManager({
        getBackgroundTasks: async () => {
          if (!availableFlag) {
            return { items: [], updatedAt: new Date().toISOString(), available: false };
          }
          return {
            items: [
              {
                id: 'task_avail_001',
                shortId: 'a001',
                kind: 'subagent',
                name: 'worker-avail',
                status: 'running',
                startedAt: new Date().toISOString(),
                lastActivityAt: new Date().toISOString(),
                stalled: false,
              },
            ],
            updatedAt: new Date().toISOString(),
            available: true,
          };
        },
        pollIntervalMs: 30_000,
      });

      await manager.registerCard(sessionRouteId, chatContextId, card.session, 'turn_avail_1');
      expect(card.updates[card.updates.length - 1]).toContain('⚠️ 状态暂不可用');
      expect(card.updates[card.updates.length - 1]).not.toBe('✅ 后台任务已全部完成');

      // Polling continues after 30s
      availableFlag = true;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(card.updates[card.updates.length - 1]).toContain('[subagent] worker-avail · running');

      manager.dispose();
    });

    it('A-02: keeps polling while turn is active even when tasks list is initially empty', async () => {
      const sessionRouteId = 'session_route_test_init_empty';
      const chatContextId = 'oc_test_chat_init_empty';
      let currentTasks: BackgroundTask[] = [];

      const card = createMockCardSession('crd_init_empty', 'om_msg_init_empty');
      const manager = new LarkBackgroundPanelManager({
        getBackgroundTasks: async () => {
          return { items: currentTasks, updatedAt: new Date().toISOString(), available: true };
        },
        pollIntervalMs: 30_000,
      });

      // Register card in an active turn (turnId: 'turn_active_1') with no tasks yet
      await manager.registerCard(sessionRouteId, chatContextId, card.session, 'turn_active_1');

      // Now subagent is launched later in the turn
      currentTasks = [
        {
          id: 'task_late_001',
          shortId: 'l001',
          kind: 'subagent',
          name: 'late-launched-worker',
          status: 'running',
          startedAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          stalled: false,
          originTurnId: 'turn_active_1',
        },
      ];

      // Next polling tick
      await vi.advanceTimersByTimeAsync(30_000);
      expect(card.updates.length).toBeGreaterThan(0);
      expect(card.updates[card.updates.length - 1]).toContain('[subagent] late-launched-worker · running');

      // When turn finalizes and task completes
      currentTasks[0].status = 'completed';
      currentTasks[0].finishedAt = new Date().toISOString();
      await manager.onTurnFinalized(sessionRouteId, chatContextId, 'turn_active_1');
      expect(card.updates[card.updates.length - 1]).toBe('✅ 后台任务已全部完成');

      manager.dispose();
    });

    it('does not falsely report "✅ 后台任务已全部完成" when task list drops to empty', async () => {
      const sessionRouteId = 'session_route_test_no_false_complete';
      const chatContextId = 'oc_test_chat_no_false_complete';
      let currentTasks: BackgroundTask[] = [
        {
          id: 'task_running_001',
          shortId: 'r001',
          kind: 'workflow',
          name: 'active-workflow',
          status: 'running',
          startedAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          stalled: false,
          originTurnId: 'turn_rfc_1',
        },
      ];

      const card = createMockCardSession('crd_rfc_001', 'om_msg_rfc_001');
      const manager = new LarkBackgroundPanelManager({
        getBackgroundTasks: async () => {
          return { items: currentTasks, updatedAt: new Date().toISOString(), available: true };
        },
        pollIntervalMs: 30_000,
      });

      // Register card in an active turn
      await manager.registerCard(sessionRouteId, chatContextId, card.session, 'turn_rfc_1');
      expect(card.updates[card.updates.length - 1]).toContain('[workflow] active-workflow · running');

      // Now simulate task query returning empty list (e.g. context filter mismatch or temporary disappearance)
      currentTasks = [];
      await vi.advanceTimersByTimeAsync(30_000);

      // It must NOT report "✅ 后台任务已全部完成"
      expect(card.updates[card.updates.length - 1]).not.toBe('✅ 后台任务已全部完成');

      // Finalize turn while task list is still empty -> panel cleared (null) rather than false complete
      await manager.onTurnFinalized(sessionRouteId, chatContextId, 'turn_rfc_1');
      expect(card.updates[card.updates.length - 1]).toBeNull();

      manager.dispose();
    });
  });

  describe('3. FakeLarkTransport Card Background Panel Rendering', () => {
    it('integrates with FakeLarkTransport to record update_background_panel streaming calls', async () => {
      const transport = new FakeLarkTransport();
      await transport.start();

      const session = await transport.createStreamingCard({
        chatId: 'oc_test_chat_003',
        title: 'Task Result',
      });
      expect(session).not.toBeNull();

      await session!.finalize('Here is the main response text', 'completed');
      expect(transport.streamingCalls.some((c) => c.type === 'finalize')).toBe(true);

      // Call updateBackgroundPanel
      await session!.updateBackgroundPanel?.('**🔄 后台任务**\n• [subagent] worker-1 · running · 10s');

      const bgCall = transport.streamingCalls.find((c) => c.type === 'update_background_panel');
      expect(bgCall).toBeDefined();
      expect(bgCall?.panelText).toBe('**🔄 后台任务**\n• [subagent] worker-1 · running · 10s');
      expect(JSON.stringify(bgCall?.card)).toContain('bg_panel');

      await transport.stop();
    });
  });
});
