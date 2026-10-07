import { describe, it, expect, vi } from 'vitest';
import { FakeLarkTransport } from '../src/transport.js';
import { StreamingReplyTracker } from '../src/streaming-tracker.js';
import { LarkChannelGateway } from '../src/gateway.js';
import type { StreamEventSource } from '../src/types.js';

describe('Item B: Manual Stop Lark Streaming Card Finalization (Synthetic Tests)', () => {
  const userId = 'u_synth_lark_stop_user';
  const sessionId = 'ses_synth_lark_stop_route';
  const turnId = 'turn_synth_lark_stop_001';
  const chatId = 'oc_synth_lark_stop_chat';
  const messageId = 'om_synth_lark_stop_msg';

  describe('1. Stop via Card Action finalizes card as stopped with partial content & without stop button', () => {
    it('finalizes streaming card as stopped with partial content, ⏹ 已停止 status bar, and no stop button even when terminal event was already reached', async () => {
      const transport = new FakeLarkTransport();
      await transport.start();

      let events: any[] = [];
      const streamSource: StreamEventSource = {
        listAssistantEvents: async (_routeId, cursor) => events.filter((e) => e.rowId > (cursor ?? 0)),
      };

      const tracker = new StreamingReplyTracker({
        transport,
        streamEventSource: streamSource,
        sessionRouteId: sessionId,
        turnId,
        withStatusBar: true,
        withStopButton: true,
        cardParams: {
          chatId,
          turnId,
          sessionId,
          withStopButton: true,
        },
      });

      tracker.start();
      // Wait for card creation
      await (tracker as any).cardSessionPromise;

      // Simulate partial streamed text
      events = [
        { type: 'turn_status', rowId: 1, status: 'running' },
        { type: 'assistant_delta', rowId: 2, delta: 'Synthetic partial analysis report content...' },
      ];
      // Tick to consume events
      await (tracker as any).pollTick();
      expect(tracker.getAccumulatedText()).toBe('Synthetic partial analysis report content...');

      // Simulate the race condition: terminalReached is set by pollTick observing interrupted turn
      events = [
        ...events,
        { type: 'turn_status', rowId: 3, status: 'interrupted' },
      ];
      await (tracker as any).pollTick();

      // Tracker's terminalReached is now true, so isActive() is false
      expect(tracker.isActive()).toBe(false);
      // But because it has not been settled/finalized yet, isSettled() is false (or settled by auto-finalize)

      // Setup gateway and register tracker
      const runtimeGateway: any = {
        dispatchInbound: vi.fn(),
        cancelTurn: vi.fn().mockResolvedValue(true),
        cancelCurrentTurn: vi.fn().mockResolvedValue(true),
      };

      const fakeChannelRepo: any = {
        findAccountById: vi.fn().mockResolvedValue({ id: 'acc_synth_stop_1', status: 'active' }),
      };
      const fakeSessionRepo: any = {
        findById: vi.fn().mockResolvedValue(null),
      };

      const gateway = new LarkChannelGateway({
        account: { id: 'acc_synth_stop_1', userId },
        transport,
        channelRepo: fakeChannelRepo,
        sessionRouteRepo: fakeSessionRepo,
        runtimeGateway,
      });

      // Register tracker in gateway
      (gateway as any).registerTracker('idem_synth_stop_test', tracker);

      // Trigger card action stop_reply
      const actionEvent = {
        header: { event_type: 'card.action.trigger' },
        action: { value: { action: 'stop_reply', turnId, sessionId } },
        operator: { open_id: 'ou_synth_operator_001' },
        context: { open_chat_id: chatId },
      };

      const actionRes = await gateway.handleInboundEvent(actionEvent as any);
      expect(actionRes.handled).toBe(true);

      // Find finalize call
      const finalizeCall = transport.streamingCalls.find((c) => c.type === 'finalize');
      expect(finalizeCall).toBeDefined();
      expect(finalizeCall?.status).toBe('stopped');

      const card = finalizeCall?.card;
      // Header must be orange and indicate stopped
      expect(card.header.template).toBe('orange');
      expect(card.header.title.content).toMatch(/已中止/);

      const elements = card.body.elements;
      // Partial text must be preserved
      const textElement = elements.find((e: any) => e.tag === 'markdown' && e.content.includes('Synthetic partial analysis report content...'));
      expect(textElement).toBeDefined();

      // Status line ⏹ 已停止 must be rendered
      const statusBar = elements.find((e: any) => e.element_id === 'streaming_status_bar');
      expect(statusBar).toBeDefined();
      expect(statusBar.content).toBe("<font color='grey'>⏹ 已停止</font>");

      // Stop button must be removed
      const stopBtn = elements.find((e: any) => e.tag === 'button');
      expect(stopBtn).toBeUndefined();
    });
  });

  describe('2. /stop command finalizes card & sends no extra message', () => {
    it('notifies card controller, finalizes card as stopped, and sends no extra plain-text message', async () => {
      const transport = new FakeLarkTransport();
      await transport.start();

      let events: any[] = [
        { type: 'turn_status', rowId: 1, status: 'running' },
        { type: 'assistant_delta', rowId: 2, delta: 'Generating financial data analysis...' },
      ];
      const streamSource: StreamEventSource = {
        listAssistantEvents: async (_routeId, cursor) => events.filter((e) => e.rowId > (cursor ?? 0)),
      };

      const runningTurnId = 'turn_synth_running_001';
      const tracker = new StreamingReplyTracker({
        transport,
        streamEventSource: streamSource,
        sessionRouteId: sessionId,
        turnId: runningTurnId,
        cardParams: {
          chatId,
          turnId: runningTurnId,
          sessionId,
          withStopButton: true,
        },
      });

      tracker.start();
      await (tracker as any).cardSessionPromise;
      await (tracker as any).pollTick();

      let cancelCalled = false;
      const runtimeGateway: any = {
        dispatchInbound: vi.fn().mockImplementation(async (envelope: any) => {
          if (envelope.content === '/stop') {
            cancelCalled = true;
            return {
              accepted: true,
              turnId: 'turn_synth_stop_cmd_001',
              executionMode: 'command',
            };
          }
          return { accepted: true, turnId: 'turn_other', executionMode: 'runtime' };
        }),
        cancelCurrentTurn: vi.fn().mockImplementation(async () => {
          cancelCalled = true;
          return true;
        }),
      };

      const fakeChannelRepo: any = {
        findAccountById: vi.fn().mockResolvedValue({ id: 'acc_synth_stop_2', status: 'active', defaultSpaceId: 'spc_synth' }),
        findBindingByContext: vi.fn().mockResolvedValue({ id: 'cb_synth_1', spaceId: 'spc_synth', nativeContextId: chatId }),
        findInboxByEvent: vi.fn().mockResolvedValue(null),
        createInboxItem: vi.fn().mockImplementation(async (item: any) => ({ item: { ...item, id: 'inbox_1' }, isDuplicate: false })),
        claimInboxForProcessing: vi.fn().mockImplementation(async (id: any) => ({ id, status: 'processing' })),
        updateInboxStatus: vi.fn().mockImplementation(async (id: any, status: any) => ({ id, status })),
        createOutboxItem: vi.fn().mockImplementation(async (item: any) => item),
        findOutboxById: vi.fn().mockResolvedValue(null),
      };
      const fakeSessionRepo: any = {
        findById: vi.fn().mockResolvedValue({
          id: sessionId,
          userId,
          spaceId: 'spc_synth',
          nativeContextId: chatId,
        }),
        getOrCreateCanonicalSession: vi.fn().mockResolvedValue({
          id: sessionId,
          userId,
          spaceId: 'spc_synth',
          nativeContextId: chatId,
        }),
        findOrCreateRouteByBinding: vi.fn().mockResolvedValue({
          id: sessionId,
          userId,
          spaceId: 'spc_synth',
          nativeContextId: chatId,
        }),
      };

      const gateway = new LarkChannelGateway({
        account: { id: 'acc_synth_stop_2', userId },
        transport,
        channelRepo: fakeChannelRepo,
        sessionRouteRepo: fakeSessionRepo,
        runtimeGateway,
      });

      // Register the active tracker for the running turn under its session route
      (gateway as any).registerTracker('idem_synth_running_turn', tracker);

      // Inbound /stop message event
      const stopInboundEvent = {
        header: {
          event_type: 'im.message.receive_v1',
          event_id: 'evt_synth_stop_cmd_1',
        },
        event: {
          message: {
            message_id: 'om_synth_stop_cmd_1',
            chat_id: chatId,
            chat_type: 'p2p',
            message_type: 'text',
            content: JSON.stringify({ text: '/stop' }),
          },
          sender: {
            sender_id: { open_id: 'ou_synth_sender_001' },
          },
        },
      };

      const inboundRes = await gateway.handleInboundEvent(stopInboundEvent as any);
      expect(inboundRes.handled).toBe(true);
      expect(cancelCalled).toBe(true);

      // Card must be finalized as stopped
      const finalizeCall = transport.streamingCalls.find((c) => c.type === 'finalize');
      expect(finalizeCall).toBeDefined();
      expect(finalizeCall?.status).toBe('stopped');

      const card = finalizeCall?.card;
      expect(card.header.template).toBe('orange');
      expect(card.header.title.content).toMatch(/已中止/);

      const elements = card.body.elements;
      // Partial content kept
      const textEl = elements.find((e: any) => e.content?.includes('Generating financial data analysis...'));
      expect(textEl).toBeDefined();

      // Status line rendered
      const statusBar = elements.find((e: any) => e.element_id === 'streaming_status_bar');
      expect(statusBar).toBeDefined();
      expect(statusBar.content).toBe("<font color='grey'>⏹ 已停止</font>");

      // No stop button
      expect(elements.find((e: any) => e.tag === 'button')).toBeUndefined();

      // When the command turn completes, handleTurnCompleted must NOT send an extra plain-text reply
      const outboxRes = await gateway.handleTurnCompleted({
        sessionId,
        turnId: 'turn_synth_stop_cmd_001',
        replyText: 'cancelled',
        executionMode: 'command',
        chatId,
        nativeEventId: 'evt_synth_stop_cmd_1',
      });

      expect(outboxRes).toBeNull();
      // No plain-text message sent via transport
      expect(transport.sentReplies.length).toBe(0);
    });
  });

  describe('3. Completed and Failed Card Rendering Remain Unchanged', () => {
    it('completed card: violet header, no streaming_status_bar, no stop button', async () => {
      const transport = new FakeLarkTransport();
      await transport.start();

      const session = await transport.createStreamingCard({
        chatId,
        title: 'Assistant',
        turnId: 'turn_completed_test',
        withStopButton: true,
      });

      expect(session).not.toBeNull();
      await session!.pushText('Final completed response content.');
      await session!.finalize('Final completed response content.', 'completed');

      const finalizeCall = transport.streamingCalls.find((c) => c.type === 'finalize');
      expect(finalizeCall).toBeDefined();
      expect(finalizeCall?.status).toBe('completed');

      const card = finalizeCall?.card;
      expect(card.header.template).toBe('violet');
      expect(card.header.title.content).toBe('Assistant');

      const elements = card.body.elements;
      // streaming_status_bar must NOT be present in completed card
      const statusBar = elements.find((e: any) => e.element_id === 'streaming_status_bar');
      expect(statusBar).toBeUndefined();

      // stop button must NOT be present
      const stopBtn = elements.find((e: any) => e.tag === 'button');
      expect(stopBtn).toBeUndefined();
    });

    it('failed card: red header, no streaming_status_bar, no stop button', async () => {
      const transport = new FakeLarkTransport();
      await transport.start();

      const session = await transport.createStreamingCard({
        chatId,
        title: 'Assistant',
        turnId: 'turn_failed_test',
        withStopButton: true,
      });

      expect(session).not.toBeNull();
      await session!.finalize('Execution failed due to upstream timeout', 'failed');

      const finalizeCall = transport.streamingCalls.find((c) => c.type === 'finalize');
      expect(finalizeCall).toBeDefined();
      expect(finalizeCall?.status).toBe('failed');

      const card = finalizeCall?.card;
      expect(card.header.template).toBe('red');
      expect(card.header.title.content).toContain('(处理失败)');

      const elements = card.body.elements;
      // streaming_status_bar must NOT be present in failed card
      const statusBar = elements.find((e: any) => e.element_id === 'streaming_status_bar');
      expect(statusBar).toBeUndefined();

      // stop button must NOT be present
      const stopBtn = elements.find((e: any) => e.tag === 'button');
      expect(stopBtn).toBeUndefined();
    });
  });
});
