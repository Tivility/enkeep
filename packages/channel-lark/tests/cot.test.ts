import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  LarkCotManager,
  cotPlacement,
  toolMeta,
  entryEvents,
  type LarkCotApiClient,
  type CotState,
} from '../src/cot.js';
import { LarkChannelGateway } from '../src/gateway.js';
import { FakeLarkTransport } from '../src/transport.js';

describe('C6: Native Thinking Message (Feishu im.v1 message_cot)', () => {
  let mockRequest: ReturnType<typeof vi.fn>;
  let apiClient: LarkCotApiClient;

  beforeEach(() => {
    mockRequest = vi.fn().mockImplementation(async (options: any) => {
      if (options.method === 'POST' && options.url === '/open-apis/im/v1/message_cot') {
        return {
          code: 0,
          data: {
            cot_id: 'cot_test_123',
            message_id: 'om_cot_msg_456',
          },
        };
      }
      return { code: 0, data: {} };
    });
    apiClient = { request: mockRequest };
  });

  describe('Placement & Tool Meta', () => {
    it('cotPlacement: topic/thread target uses rootId with reply_in_thread: true', () => {
      const placement = cotPlacement({
        chatId: 'oc_chat_1',
        rootId: 'om_root_999',
        turnId: 'om_turn_1',
      });
      expect(placement).toEqual({
        origin_message_id: 'om_root_999',
        reply_in_thread: true,
      });
    });

    it('cotPlacement: replyToMessageId targets message without reply_in_thread', () => {
      const placement = cotPlacement({
        chatId: 'oc_chat_1',
        replyToMessageId: 'om_msg_777',
      });
      expect(placement).toEqual({
        origin_message_id: 'om_msg_777',
      });
    });

    it('cotPlacement: synthetic non-om_ turn IDs are not used as origin_message_id', () => {
      const placement = cotPlacement({
        chatId: 'oc_chat_1',
        turnId: 'turn_sched_123',
      });
      expect(placement).toEqual({});
    });

    it('toolMeta: categorizes tool names to Feishu icons and readable titles', () => {
      expect(toolMeta('bash')).toEqual({ icon: 'bash', title: '执行命令' });
      expect(toolMeta('write_file')).toEqual({ icon: 'write', title: '编辑文件' });
      expect(toolMeta('read_file')).toEqual({ icon: 'read', title: '读取文件' });
      expect(toolMeta('grep_search')).toEqual({ icon: 'search', title: '搜索' });
      expect(toolMeta('plan_task')).toEqual({ icon: 'task', title: '任务规划' });
      expect(toolMeta('custom_tool')).toEqual({ icon: 'default', title: 'custom_tool' });
    });

    it('entryEvents: constructs AG-UI protocol events for thinking, tool call, and tool result', () => {
      const state: CotState = {
        turnId: 'om_turn_1',
        chatId: 'oc_chat_1',
        sentCount: 0,
        pumping: false,
        disabled: false,
        settled: false,
      };

      const thinkEvts = entryEvents(state, { kind: 'thinking', text: 'Analyzing database index...' }, 0);
      expect(thinkEvts).toHaveLength(3);
      expect(thinkEvts[0].event_type).toBe('REASONING_MESSAGE_START');
      expect(thinkEvts[1].event_type).toBe('REASONING_MESSAGE_CONTENT');
      expect(JSON.parse(thinkEvts[1].content).delta).toBe('Analyzing database index...');
      expect(thinkEvts[2].event_type).toBe('REASONING_MESSAGE_END');

      const toolEvts = entryEvents(
        state,
        { kind: 'tool_call', id: 'call_1', name: 'bash', args: '{"cmd":"ls -la"}' },
        1
      );
      expect(toolEvts).toHaveLength(3);
      expect(toolEvts[0].event_type).toBe('TOOL_CALL_START');
      const startPayload = JSON.parse(toolEvts[0].content);
      expect(startPayload.toolCallId).toBe('call_1');
      expect(startPayload.icon).toBe('bash');
      expect(startPayload.parentMessageId).toBe(state.lastReasoningId);
      expect(toolEvts[1].event_type).toBe('TOOL_CALL_ARGS');
      expect(toolEvts[2].event_type).toBe('TOOL_CALL_END');

      const resEvts = entryEvents(state, { kind: 'tool_result', id: 'call_1', result: 'file1.txt\nfile2.txt' }, 2);
      expect(resEvts).toHaveLength(1);
      expect(resEvts[0].event_type).toBe('TOOL_CALL_RESULT');
      const resPayload = JSON.parse(resEvts[0].content);
      expect(resPayload.toolCallId).toBe('call_1');
      expect(JSON.parse(resPayload.content)).toEqual({ type: 'code', code: 'file1.txt\nfile2.txt' });
    });
  });

  describe('LarkCotManager Lifecycle & On/Off Control', () => {
    it('does not create CoT bubble when master switch is disabled', async () => {
      const manager = new LarkCotManager({ enabled: false, apiClient });
      const handled = await manager.handleThinkingUpdate({
        turnId: 'om_turn_1',
        chatId: 'oc_chat_1',
        entries: [{ kind: 'thinking', text: 'Step 1' }],
      });
      expect(handled).toBe(false);
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('respects per-chat on/off switch dynamically', async () => {
      const manager = new LarkCotManager({ enabled: true, apiClient });

      // Chat 1 is opted out
      manager.setChatCotMode('oc_chat_muted', false);
      expect(manager.isCotEnabledForChat('oc_chat_muted')).toBe(false);

      const handledMuted = await manager.handleThinkingUpdate({
        turnId: 'om_turn_muted',
        chatId: 'oc_chat_muted',
        entries: [{ kind: 'thinking', text: 'Should not create' }],
      });
      expect(handledMuted).toBe(false);
      expect(mockRequest).not.toHaveBeenCalled();

      // Chat 2 is allowed
      expect(manager.isCotEnabledForChat('oc_chat_active')).toBe(true);
      const handledActive = await manager.handleThinkingUpdate({
        turnId: 'om_turn_active',
        chatId: 'oc_chat_active',
        entries: [{ kind: 'thinking', text: 'Should create' }],
      });
      expect(handledActive).toBe(true);
      expect(mockRequest).toHaveBeenCalled();

      // Un-mute Chat 1
      manager.setChatCotMode('oc_chat_muted', true);
      expect(manager.isCotEnabledForChat('oc_chat_muted')).toBe(true);
    });

    it('only creates bubble if model stream exposes substantive thinking content', async () => {
      const manager = new LarkCotManager({ enabled: true, apiClient });

      // Empty entries array
      const handledEmpty = await manager.handleThinkingUpdate({
        turnId: 'om_turn_empty',
        chatId: 'oc_chat_1',
        entries: [],
      });
      expect(handledEmpty).toBe(false);
      expect(mockRequest).not.toHaveBeenCalled();

      // Whitespace only
      const handledBlank = await manager.handleThinkingUpdate({
        turnId: 'om_turn_blank',
        chatId: 'oc_chat_1',
        entries: [{ kind: 'thinking', text: '   ' }],
      });
      expect(handledBlank).toBe(false);
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('executes full turn lifecycle: create -> prologue -> reasoning updates -> finalize completed', async () => {
      const manager = new LarkCotManager({ enabled: true, apiClient });

      // 1. Initial thinking update
      const update1 = await manager.handleThinkingUpdate({
        turnId: 'om_turn_full',
        chatId: 'oc_chat_1',
        rootId: 'om_topic_root',
        entries: [{ kind: 'thinking', text: 'Step 1: Inspecting schema' }],
      });
      expect(update1).toBe(true);
      expect(manager.hasActiveCot('om_turn_full')).toBe(true);

      // Verify POST create was called
      const postCalls = mockRequest.mock.calls.filter(([c]) => c.method === 'POST');
      expect(postCalls.length).toBeGreaterThanOrEqual(1);
      const createCall = postCalls[0][0];
      expect(createCall.url).toBe('/open-apis/im/v1/message_cot');
      expect(createCall.data).toEqual({
        receive_id: 'oc_chat_1',
        origin_message_id: 'om_topic_root',
        reply_in_thread: true,
      });

      // Verify PUT prologue + reasoning events
      const putCalls1 = mockRequest.mock.calls.filter(([c]) => c.method === 'PUT');
      expect(putCalls1.length).toBeGreaterThanOrEqual(2);
      const prologueEvents = putCalls1[0][0].data.events;
      expect(prologueEvents.map((e: any) => e.event_type)).toEqual(['RUN_STARTED', 'REASONING_START']);

      const firstThinkingEvents = putCalls1[1][0].data.events;
      expect(firstThinkingEvents.map((e: any) => e.event_type)).toEqual([
        'REASONING_MESSAGE_START',
        'REASONING_MESSAGE_CONTENT',
        'REASONING_MESSAGE_END',
      ]);

      // 2. Incremental tool call update
      await manager.handleThinkingUpdate({
        turnId: 'om_turn_full',
        chatId: 'oc_chat_1',
        entries: [
          { kind: 'thinking', text: 'Step 1: Inspecting schema' },
          { kind: 'tool_call', id: 'call_99', name: 'grep', args: '{"pattern":"index"}' },
        ],
      });

      const putCalls2 = mockRequest.mock.calls.filter(([c]) => c.method === 'PUT');
      const toolEvents = putCalls2[putCalls2.length - 1][0].data.events;
      expect(toolEvents.map((e: any) => e.event_type)).toEqual([
        'TOOL_CALL_START',
        'TOOL_CALL_ARGS',
        'TOOL_CALL_END',
      ]);

      // 3. Finalize completed
      const finalized = await manager.finalizeTurn('om_turn_full', 'completed');
      expect(finalized).toBe(true);

      const putCalls3 = mockRequest.mock.calls.filter(([c]) => c.method === 'PUT');
      const terminalEvents = putCalls3[putCalls3.length - 1][0].data.events;
      expect(terminalEvents.map((e: any) => e.event_type)).toEqual([
        'REASONING_END',
        'RUN_FINISHED',
      ]);
      expect(JSON.parse(terminalEvents[1].content).status).toBe('done');
    });

    it('handles abortTurn: terminates with status interrupted', async () => {
      const manager = new LarkCotManager({ enabled: true, apiClient });

      await manager.handleThinkingUpdate({
        turnId: 'om_turn_abort',
        chatId: 'oc_chat_1',
        entries: [{ kind: 'thinking', text: 'Thinking before cancelled...' }],
      });

      const aborted = await manager.abortTurn('om_turn_abort');
      expect(aborted).toBe(true);

      const putCalls = mockRequest.mock.calls.filter(([c]) => c.method === 'PUT');
      const lastPutEvents = putCalls[putCalls.length - 1][0].data.events;
      expect(lastPutEvents.some((e: any) => e.event_type === 'RUN_FINISHED')).toBe(true);
      const finishedEvt = lastPutEvents.find((e: any) => e.event_type === 'RUN_FINISHED');
      expect(JSON.parse(finishedEvt.content).status).toBe('interrupted');
    });

    it('best-effort fault tolerance: handles API failure gracefully without crashing', async () => {
      mockRequest.mockImplementationOnce(async (options: any) => {
        if (options.method === 'POST') {
          throw new Error('500 Feishu internal error');
        }
        return { code: 0, data: {} };
      });

      const manager = new LarkCotManager({ enabled: true, apiClient });
      const handled = await manager.handleThinkingUpdate({
        turnId: 'om_turn_err',
        chatId: 'oc_chat_1',
        entries: [{ kind: 'thinking', text: 'Will fail create' }],
      });

      // Failed create disables CoT for this turn without throwing
      expect(handled).toBe(false);
      expect(manager.hasActiveCot('om_turn_err')).toBe(false);

      // Subsequent update on disabled turn returns false
      const handledNext = await manager.handleThinkingUpdate({
        turnId: 'om_turn_err',
        chatId: 'oc_chat_1',
        entries: [{ kind: 'thinking', text: 'Will be skipped' }],
      });
      expect(handledNext).toBe(false);
    });

    it('skip & report when turn has no CoT created: finalizeTurn and abortTurn return false safely', async () => {
      const manager = new LarkCotManager({ enabled: true, apiClient });
      // When model stream exposed no thinking content
      const finalized = await manager.finalizeTurn('om_turn_no_thinking', 'completed');
      expect(finalized).toBe(false);
      const aborted = await manager.abortTurn('om_turn_no_thinking');
      expect(aborted).toBe(false);
      expect(mockRequest).not.toHaveBeenCalled();
    });
  });

  describe('Integration with LarkChannelGateway', () => {
    it('gateway exposes cotManager, setChatCotMode, and isCotEnabledForChat', () => {
      const transport = new FakeLarkTransport();
      const fakeRepo: any = {
        findAccountById: vi.fn().mockResolvedValue({ id: 'test_account', status: 'active' }),
        updateInboxStatus: vi.fn(),
        createOutboxItem: vi.fn(),
      };
      const fakeRouteRepo: any = {
        findById: vi.fn(),
      };
      const fakeRuntimeGateway: any = {
        dispatchInboundTurn: vi.fn(),
        cancelCurrentTurn: vi.fn(),
      };

      const gateway = new LarkChannelGateway({
        account: {
          id: 'test_account',
          userId: 'usr_1',
          name: 'Bot',
          state: 'active',
          credentials: { appId: 'cli_1', appSecret: 'sec_1' },
        },
        transport,
        channelRepo: fakeRepo,
        sessionRouteRepo: fakeRouteRepo,
        runtimeGateway: fakeRuntimeGateway,
        enableCot: true,
        cotApiClient: apiClient,
      });

      expect(gateway.cotManager).toBeDefined();
      expect(gateway.isCotEnabledForChat('oc_test')).toBe(true);

      gateway.setChatCotMode('oc_test', false);
      expect(gateway.isCotEnabledForChat('oc_test')).toBe(false);

      gateway.setChatCotMode('oc_test', true);
      expect(gateway.isCotEnabledForChat('oc_test')).toBe(true);
    });

    it('gateway.handleTurnCompleted finalizes active CoT message', async () => {
      const transport = new FakeLarkTransport();
      await transport.start();
      const fakeRepo: any = {
        findAccountById: vi.fn().mockResolvedValue({ id: 'test_account', status: 'active' }),
        findOutboxById: vi.fn().mockResolvedValue(null),
        findInboxByEvent: vi.fn().mockResolvedValue({
          id: 'inbox_1',
          payloadJson: JSON.stringify({ chatId: 'oc_test' }),
        }),
        createOutboxItem: vi.fn().mockResolvedValue({ id: 'out_1' }),
      };
      const fakeRouteRepo: any = {
        findById: vi.fn().mockResolvedValue({
          id: 'session_1',
          nativeContextId: 'ctx_1',
        }),
      };
      const fakeRuntimeGateway: any = {
        dispatchInboundTurn: vi.fn(),
      };

      const gateway = new LarkChannelGateway({
        account: {
          id: 'test_account',
          userId: 'usr_1',
          name: 'Bot',
          state: 'active',
          credentials: { appId: 'cli_1', appSecret: 'sec_1' },
        },
        transport,
        channelRepo: fakeRepo,
        sessionRouteRepo: fakeRouteRepo,
        runtimeGateway: fakeRuntimeGateway,
        enableCot: true,
        cotApiClient: apiClient,
      });

      // Start CoT on gateway
      await gateway.handleCotThinkingUpdate({
        turnId: 'turn_gw_complete',
        chatId: 'oc_test',
        entries: [{ kind: 'thinking', text: 'Gateway thinking...' }],
      });
      expect(gateway.cotManager.hasActiveCot('turn_gw_complete')).toBe(true);

      // Complete turn
      await gateway.handleTurnCompleted({
        sessionId: 'session_1',
        turnId: 'turn_gw_complete',
        chatId: 'oc_test',
        replyText: 'Final answer',
        nativeEventId: 'evt_1',
      });

      // CoT should be settled with status done
      const putCalls = mockRequest.mock.calls.filter(([c]) => c.method === 'PUT');
      const terminalEvents = putCalls[putCalls.length - 1][0].data.events;
      expect(terminalEvents.some((e: any) => e.event_type === 'RUN_FINISHED')).toBe(true);
      const finished = terminalEvents.find((e: any) => e.event_type === 'RUN_FINISHED');
      expect(JSON.parse(finished.content).status).toBe('done');
    });

    it('gateway.handleCardAction stop_reply aborts active CoT message', async () => {
      const transport = new FakeLarkTransport();
      await transport.start();
      const fakeRepo: any = {
        findAccountById: vi.fn().mockResolvedValue({ id: 'test_account', status: 'active' }),
        updateInboxStatus: vi.fn(),
      };
      const fakeRouteRepo: any = {
        findById: vi.fn(),
      };
      const fakeRuntimeGateway: any = {
        cancelTurn: vi.fn().mockResolvedValue({ success: true }),
      };

      const gateway = new LarkChannelGateway({
        account: {
          id: 'test_account',
          userId: 'usr_1',
          name: 'Bot',
          state: 'active',
          credentials: { appId: 'cli_1', appSecret: 'sec_1' },
        },
        transport,
        channelRepo: fakeRepo,
        sessionRouteRepo: fakeRouteRepo,
        runtimeGateway: fakeRuntimeGateway,
        enableCot: true,
        cotApiClient: apiClient,
      });

      // Start CoT on gateway
      await gateway.handleCotThinkingUpdate({
        turnId: 'turn_gw_stop',
        chatId: 'oc_test',
        entries: [{ kind: 'thinking', text: 'Thinking before user clicks stop...' }],
      });
      expect(gateway.cotManager.hasActiveCot('turn_gw_stop')).toBe(true);

      // Stop action from sender
      const cardActionEvent = {
        header: {
          event_id: 'evt_card_act_1',
          event_type: 'card.action.trigger',
          create_time: '1234567890',
        },
        event: {
          operator: { open_id: 'ou_operator_1' },
          action: {
            value: {
              action: 'stop_reply',
              turnId: 'turn_gw_stop',
              sessionId: 'session_1',
            },
          },
          context: {
            open_chat_id: 'oc_test',
            open_message_id: 'om_card_msg_1',
          },
        },
      };

      // Mock operator is allowed
      (gateway as any).isOperatorAllowedCallback = () => true;

      const actionRes = await gateway.handleCardAction(cardActionEvent as any);
      expect(actionRes.handled).toBe(true);
      expect(actionRes.toast?.content).toBe('已停止回复');

      // Verify CoT was aborted with RUN_FINISHED status interrupted
      const putCalls = mockRequest.mock.calls.filter(([c]) => c.method === 'PUT');
      const terminalEvents = putCalls[putCalls.length - 1][0].data.events;
      const finished = terminalEvents.find((e: any) => e.event_type === 'RUN_FINISHED');
      expect(JSON.parse(finished.content).status).toBe('interrupted');
    });
  });
});
