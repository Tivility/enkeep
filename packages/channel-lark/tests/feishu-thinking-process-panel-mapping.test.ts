import { describe, it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  FakeLarkTransport,
  isReasoningModelOrEffort,
} from '../src/transport.js';
import { StreamingReplyTracker } from '../src/streaming-tracker.js';
import { LarkChannelGateway } from '../src/gateway.js';
import type { StreamEventSource } from '../src/types.js';

describe('I3: Feishu Thinking & Process Panels Content Mapping & Placeholder Fixes', () => {
  describe('1. Model & Reasoning Effort Capability Detection', () => {
    it('isReasoningModelOrEffort correctly identifies reasoning models and configurations', () => {
      // Non-reasoning model without effort
      expect(isReasoningModelOrEffort({ model: 'claude-opus-5', reasoningEffort: null })).toBe(false);
      expect(isReasoningModelOrEffort({ model: 'claude-sonnet-5', reasoningEffort: undefined })).toBe(false);
      expect(isReasoningModelOrEffort({ model: 'gpt-4o', reasoningEffort: null })).toBe(false);
      expect(isReasoningModelOrEffort({ model: 'deepseek-chat', reasoningEffort: null })).toBe(false);

      // Model with reasoning effort specified
      expect(isReasoningModelOrEffort({ model: 'claude-opus-5-5', reasoningEffort: 'high' })).toBe(true);
      expect(isReasoningModelOrEffort({ model: 'claude-sonnet-5', reasoningEffort: 'low' })).toBe(true);
      expect(isReasoningModelOrEffort({ model: 'custom-model', reasoningEffort: 'max' })).toBe(true);

      // Native reasoning models without explicit effort
      expect(isReasoningModelOrEffort({ model: 'deepseek-reasoner' })).toBe(true);
      expect(isReasoningModelOrEffort({ model: 'deepseek-r1-distill' })).toBe(true);
      expect(isReasoningModelOrEffort({ model: 'o1-preview' })).toBe(true);
      expect(isReasoningModelOrEffort({ model: 'o3-mini' })).toBe(true);
      expect(isReasoningModelOrEffort({ model: 'qwq-32b-preview' })).toBe(true);
    });

    it('gateway disables withThinkingPanel when session model override lacks reasoning capability', async () => {
      const db = new DatabaseSync(':memory:');
      db.exec(`
        CREATE TABLE model_selection_overrides (
          id TEXT PRIMARY KEY,
          user_id TEXT,
          owner_type TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          reasoning_effort TEXT,
          fallback_chain TEXT,
          revision TEXT NOT NULL
        );
      `);

      // Insert session override with non-reasoning model (synthetic test data)
      db.prepare(`
        INSERT INTO model_selection_overrides (id, user_id, owner_type, owner_id, provider, model, reasoning_effort, revision)
        VALUES ('mso_test_001', 'usr_test_001', 'session', 'ses_test_non_reasoning', 'test_provider', 'claude-opus-5', NULL, 'rev_1')
      `).run();

      const transport = new FakeLarkTransport();
      await transport.start();

      const mockRepo = {
        findAccountById: vi.fn().mockResolvedValue({ id: 'acc_test_01', status: 'active', defaultSpaceId: 'spc_default' }),
        findBindingByContext: vi.fn().mockResolvedValue({ id: 'bind_test_01', spaceId: 'spc_default', groupActivationMode: 'always' }),
        findInboxByEvent: vi.fn().mockResolvedValue(null),
        createInboxItem: vi.fn().mockImplementation((item) => Promise.resolve({ item: { ...item, id: 'inbox_test_01' }, isDuplicate: false })),
        claimInboxForProcessing: vi.fn().mockImplementation((id) => Promise.resolve({ id, status: 'processing', attempts: 1, payloadJson: JSON.stringify({ parsed: { chatId: 'oc_test_chat_01', messageId: 'om_test_msg_01' } }) })),
        updateInboxStatus: vi.fn().mockResolvedValue(undefined),
        findOutboxById: vi.fn().mockResolvedValue(null),
        createOutboxItem: vi.fn().mockImplementation((item) => Promise.resolve({ ...item, id: 'outbox_test_01' })),
        updateOutboxStatus: vi.fn().mockResolvedValue(undefined),
        listUndeliveredOutbox: vi.fn().mockResolvedValue([]),
      };

      const mockRouteRepo = {
        findByRouteIdentity: vi.fn().mockResolvedValue({ id: 'ses_test_non_reasoning', spaceId: 'spc_default', nativeContextId: 'oc_test_chat_01' }),
        findRouteByChatAndNativeContext: vi.fn().mockResolvedValue({ id: 'ses_test_non_reasoning', spaceId: 'spc_default', nativeContextId: 'oc_test_chat_01' }),
        findById: vi.fn().mockResolvedValue({ id: 'ses_test_non_reasoning', nativeContextId: 'oc_test_chat_01' }),
        createRoute: vi.fn().mockResolvedValue({ id: 'ses_test_non_reasoning', spaceId: 'spc_default', nativeContextId: 'oc_test_chat_01' }),
        create: vi.fn().mockResolvedValue({ id: 'ses_test_non_reasoning', spaceId: 'spc_default', nativeContextId: 'oc_test_chat_01' }),
      };

      const mockStreamEventSource: StreamEventSource & { db: any } = {
        db,
        listAssistantEvents: vi.fn().mockResolvedValue([]),
        getLatestRowId: vi.fn().mockResolvedValue(0),
      };

      const mockRuntimeGateway = {
        dispatchInbound: vi.fn().mockResolvedValue({
          executionMode: 'runtime',
          turnId: 'turn_test_non_reasoning',
        }),
      };

      const gateway = new LarkChannelGateway({
        account: {
          id: 'acc_test_01',
          userId: 'usr_test_01',
        },
        transport,
        channelRepo: mockRepo as any,
        sessionRouteRepo: mockRouteRepo as any,
        runtimeGateway: mockRuntimeGateway as any,
        streamEventSource: mockStreamEventSource,
      });

      const rawEvent = {
        header: {
          event_id: 'evt_test_nr_01',
          event_type: 'im.message.receive_v1',
          create_time: '1700000000000',
        },
        event: {
          sender: {
            sender_id: { open_id: 'ou_test_user_01' },
            sender_type: 'user',
          },
          message: {
            message_id: 'om_test_msg_01',
            chat_id: 'oc_test_chat_01',
            chat_type: 'p2p',
            message_type: 'text',
            content: JSON.stringify({ text: 'Simple greeting without reasoning' }),
            create_time: '1700000000000',
          },
        },
      };

      const result = await gateway.handleInboundEvent(rawEvent);
      expect(result.handled).toBe(true);

      const tracker = (gateway as any).activeTrackers.get('idem_lark_acc_test_01_evt_test_nr_01');
      expect(tracker).toBeDefined();
      // withThinkingPanel is FALSE because model lacks reasoning capability!
      expect((tracker as any).withThinkingPanel).toBe(false);

      // Initial card should NOT have thinking panel pre-rendered
      const createCall = transport.streamingCalls.find((c) => c.type === 'card_create');
      expect(createCall).toBeDefined();
      const elements = createCall?.card.body.elements;
      const thinkingEl = elements.find((e: any) => e.element_id === 'thinking_panel' || e.element_id === 'thinking_content');
      expect(thinkingEl).toBeUndefined();

      // Tool status panel is collapsed by default (expandStatusPanel: false)
      const statusPanel = elements.find((e: any) => e.element_id === 'tool_status_panel');
      expect(statusPanel).toBeDefined();
      expect(statusPanel.expanded).toBe(false);
    });
  });

  describe('2. Finalize Clean-up: No Empty Tool / Thinking Panels', () => {
    it('finalize does NOT render empty "暂无工具调用" panel when toolStatus is empty', async () => {
      const transport = new FakeLarkTransport();
      await transport.start();

      const session = await transport.createStreamingCard({
        chatId: 'oc_test_finalize_clean',
        withStatusPanel: true,
        withThinkingPanel: false,
      });
      expect(session).not.toBeNull();

      // Finalize with NO tools and NO thinking
      await session!.finalize('Clean concise answer without tools.', 'completed');

      const finalizeCall = transport.streamingCalls.find((c) => c.type === 'finalize');
      expect(finalizeCall).toBeDefined();
      const elements = finalizeCall?.card.body.elements;

      // Should ONLY contain main markdown answer, NO collapsible panels, NO hr divider
      const panel = elements.find((e: any) => e.tag === 'collapsible_panel');
      expect(panel).toBeUndefined();
      const hr = elements.find((e: any) => e.tag === 'hr');
      expect(hr).toBeUndefined();

      const bodyMarkdown = elements.find((e: any) => e.tag === 'markdown');
      expect(bodyMarkdown?.content).toBe('Clean concise answer without tools.');
    });
  });

  describe('3. Inline <think> Incremental Streaming & Content Extraction', () => {
    it('StreamingReplyTracker extracts inline <think> tags during streaming and calls pushThinking', async () => {
      vi.useFakeTimers();
      try {
        const transport = new FakeLarkTransport();
        await transport.start();

        const events: any[] = [
          {
            rowId: 1,
            type: 'assistant_delta',
            delta: '<think>\nEvaluating step 1\nEvaluating step 2\n</think>\n\nHere is the answer.',
          },
        ];
        const mockStreamEventSource: StreamEventSource = {
          listAssistantEvents: vi.fn().mockImplementation(async (_r, after) => {
            return events.filter((e) => e.rowId > after);
          }),
          getLatestRowId: vi.fn().mockResolvedValue(0),
        };

        const tracker = new StreamingReplyTracker({
          transport,
          streamEventSource: mockStreamEventSource,
          sessionRouteId: 'ses_test_inline_think',
          initialCursor: 0,
          pollIntervalMs: 50,
          withThinkingPanel: true,
          withStatusPanel: true,
          cardParams: {
            chatId: 'oc_test_think_stream',
            withThinkingPanel: true,
            withStatusPanel: true,
          },
        });

        tracker.start();
        await vi.advanceTimersByTimeAsync(100);

        // Verify pushThinking was called with formatted thinking content
        const pushThinkingCall = transport.streamingCalls.find((c) => c.type === 'push_thinking');
        expect(pushThinkingCall).toBeDefined();
        expect(pushThinkingCall?.content).toContain('> Evaluating step 1');
        expect(pushThinkingCall?.content).toContain('> Evaluating step 2');

        // Verify pushText only received the clean answer (without <think> tags)
        const pushTextCall = transport.streamingCalls.find((c) => c.type === 'push');
        expect(pushTextCall).toBeDefined();
        expect(pushTextCall?.content).toBe('Here is the answer.');
        expect(pushTextCall?.content).not.toContain('<think>');

        tracker.stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('4. Finalize Failure Graceful Degradation', () => {
    it('when session.finalize fails, fallback pushText cleans placeholders so they do not freeze on "正在思考…"', async () => {
      const transport = new FakeLarkTransport();
      await transport.start();

      const session = await transport.createStreamingCard({
        chatId: 'oc_test_fail_degrade',
        withThinkingPanel: true,
        withStatusPanel: true,
      });

      // Force session finalize to fail
      session!.finalize = vi.fn().mockRejectedValue(new Error('Simulated Lark CardKit 500'));

      const events: any[] = [];
      const mockStreamEventSource: StreamEventSource = {
        listAssistantEvents: vi.fn().mockResolvedValue(events),
        getLatestRowId: vi.fn().mockResolvedValue(0),
      };

      const tracker = new StreamingReplyTracker({
        transport,
        streamEventSource: mockStreamEventSource,
        sessionRouteId: 'ses_test_fail_degrade',
        withThinkingPanel: true,
        withStatusPanel: true,
        cardParams: {
          chatId: 'oc_test_fail_degrade',
        },
      });

      (tracker as any).cardSession = session;
      (tracker as any).cardSessionPromise = Promise.resolve(session);

      const res = await tracker.finalize('Final fallback answer', 'completed');
      expect(res.handled).toBe(true);
      expect(res.degraded).toBe(true);

      // Verify pushText fallback was called with fallbackStatus and fallbackThinking
      const pushCalls = transport.streamingCalls.filter((c) => c.type === 'push');
      const lastPush = pushCalls[pushCalls.length - 1];
      expect(lastPush).toBeDefined();
      expect(lastPush.content).toContain('Final fallback answer');
      expect(lastPush.content).toContain('完整内容见附件');
      // Placeholders are cleared to non-frozen values!
      expect(lastPush.thinkingText).toBe("<font color='grey'>无思考过程</font>");
      expect(lastPush.toolStatus).toBe("<font color='grey'>无工具调用</font>");
    });
  });
});
