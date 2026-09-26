import { describe, it, expect, vi } from 'vitest';
import {
  FakeLarkTransport,
  buildCollapsibleThinkingPanel,
  applyThinkingLengthGuard,
  formatThinkingContent,
  stripThinkingTags,
  extractThinkingFromText,
  THINKING_MAX_CONTENT_LENGTH,
  THINKING_TRUNCATION_NOTICE,
} from '../src/transport.js';
import { StreamingReplyTracker } from '../src/streaming-tracker.js';
import type { CardToolStatusEntry, CardFinalMetadata, StreamEventSource } from '../src/types.js';

describe('K3b: Feishu Thinking Collapsible Panel (HC Alignment)', () => {
  it('buildCollapsibleThinkingPanel creates Schema 2.0 collapsible_panel with blue-50 tint and markdown content', () => {
    const panel = buildCollapsibleThinkingPanel({
      content: 'Thinking trace line 1\nThinking trace line 2',
      expanded: false,
      elementId: 'thinking_panel',
      contentElementId: 'thinking_content',
    });

    expect(panel.tag).toBe('collapsible_panel');
    expect(panel.expanded).toBe(false);
    expect(panel.element_id).toBe('thinking_panel');
    const header = panel.header as any;
    expect(header.title.tag).toBe('markdown');
    expect(header.title.content).toBe('**💭 思考过程**');
    expect(header.background_color).toBe('blue-50');
    const elements = panel.elements as any[];
    expect(elements[0].tag).toBe('markdown');
    expect(elements[0].element_id).toBe('thinking_content');
    expect(elements[0].content).toBe('Thinking trace line 1\nThinking trace line 2');
  });

  it('applyThinkingLengthGuard respects C1 length guard (truncates thinking content with notice if long)', () => {
    const shortText = 'Short thinking reasoning';
    expect(applyThinkingLengthGuard(shortText)).toBe(shortText);

    const longText = 'A'.repeat(5000);
    const guarded = applyThinkingLengthGuard(longText, THINKING_MAX_CONTENT_LENGTH);
    expect(guarded.length).toBeLessThanOrEqual(THINKING_MAX_CONTENT_LENGTH);
    expect(guarded).toContain(THINKING_TRUNCATION_NOTICE);
    expect(guarded.startsWith(THINKING_TRUNCATION_NOTICE)).toBe(true);
  });

  it('formatThinkingContent formats streamed reasoning into HC-style blockquote', () => {
    const raw = 'First I inspect schema\nThen query index';
    const formatted = formatThinkingContent(raw);
    expect(formatted).toBe('> First I inspect schema\n> Then query index');

    const empty = formatThinkingContent('');
    expect(empty).toBe("<font color='grey'>正在思考…</font>");
  });

  it('stripThinkingTags and extractThinkingFromText cleanly extract thinking and isolate final answer', () => {
    const mixed = '<think>\nInternal reasoning step 1\nInternal reasoning step 2\n</think>\n\nHere is the real answer.';
    const extracted = extractThinkingFromText(mixed);
    expect(extracted.text).toBe('Here is the real answer.');
    expect(extracted.thinking).toBe('Internal reasoning step 1\nInternal reasoning step 2');

    expect(stripThinkingTags(mixed)).toBe('Here is the real answer.');
  });

  it('FakeLarkTransport finalize renders thinking panel placed above process panel and body', async () => {
    const transport = new FakeLarkTransport();
    await transport.start();

    const session = await transport.createStreamingCard({
      chatId: 'oc_test_k3b',
      withStatusPanel: true,
      withThinkingPanel: true,
    });
    expect(session).not.toBeNull();

    const toolEntries: CardToolStatusEntry[] = [
      { toolName: 'web_search', status: 'completed' },
    ];
    const metadata: CardFinalMetadata = {
      model: 'deepseek-reasoner',
      durationSeconds: 4.2,
    };
    const thinkingText = 'DeepSeek R1 reasoning chain:\n1. Deconstruct user intent\n2. Verify edge cases';

    await session!.finalize('The final conclusion for the user.', 'completed', metadata, toolEntries, thinkingText);

    const finalizeCall = transport.streamingCalls.find((c) => c.type === 'finalize');
    expect(finalizeCall).toBeDefined();
    const elements = finalizeCall?.card.body.elements;

    // Structural order: [0: Thinking Panel, 1: Process Panel, 2: hr divider, 3: Body, 4: Footer]
    expect(elements[0].tag).toBe('collapsible_panel');
    expect(elements[0].expanded).toBe(false); // collapsed in final card
    expect(elements[0].header.title.content).toBe('**💭 思考过程**');
    expect(elements[0].header.background_color).toBe('blue-50');
    expect(elements[0].elements[0].content).toBe(thinkingText);

    expect(elements[1].tag).toBe('collapsible_panel');
    expect(elements[1].expanded).toBe(false);
    expect(elements[1].header.title.content).toBe('**🔧 执行过程**');
    expect(elements[1].header.background_color).toBe('wathet-50');
    expect(elements[1].elements[0].content).toContain('✅ **web_search**: 已完成');

    expect(elements[2].tag).toBe('hr');

    expect(elements[3].tag).toBe('markdown');
    expect(elements[3].content).toBe('The final conclusion for the user.');

    expect(elements[4].tag).toBe('markdown');
    expect(elements[4].text_size).toBe('notation');
    expect(elements[4].content).toContain('🤖 deepseek-reasoner');
  });

  it('StreamingReplyTracker tracks K1 reasoning_delta events and finalizes with collapsed thinking panel above answer', async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeLarkTransport();
      await transport.start();

      const events: Array<{
        rowId: number;
        type: 'assistant_delta' | 'assistant_stream_end' | 'turn_status' | 'tool_status' | 'reasoning_delta' | 'thinking';
        delta?: string;
        streamId?: string;
        status?: string;
        toolName?: string;
      }> = [
        { rowId: 1, type: 'reasoning_delta', delta: 'Analyzing query constraints... ', streamId: 's_r1' },
        { rowId: 2, type: 'reasoning_delta', delta: 'Formulating step-by-step resolution.', streamId: 's_r1' },
        { rowId: 3, type: 'tool_status', toolName: 'sql_query', status: 'started' },
        { rowId: 4, type: 'tool_status', toolName: 'sql_query', status: 'completed' },
        { rowId: 5, type: 'assistant_delta', delta: 'Resolved answer based on database records.', streamId: 's_ans' },
        { rowId: 6, type: 'turn_status', status: 'completed' },
      ];

      const fakeSource: StreamEventSource = {
        listAssistantEvents: vi.fn().mockImplementation(async (_r, after) => {
          return events.filter((e) => e.rowId > after);
        }),
      };

      const tracker = new StreamingReplyTracker({
        transport,
        streamEventSource: fakeSource,
        sessionRouteId: 'session_k3b_reasoning',
        cardParams: {
          chatId: 'oc_test_k3b_tracker',
          withStatusPanel: true,
          withThinkingPanel: true,
        },
        initialCursor: 0,
        pollIntervalMs: 50,
      });

      tracker.start();
      await vi.advanceTimersByTimeAsync(100);

      expect(tracker.getAccumulatedThinking()).toBe(
        'Analyzing query constraints... Formulating step-by-step resolution.'
      );
      expect(tracker.getAccumulatedText()).toBe('Resolved answer based on database records.');

      const finalizeResult = await tracker.finalize('Resolved answer based on database records.', 'completed');
      expect(finalizeResult.handled).toBe(true);

      const finalizeCall = transport.streamingCalls.find((c) => c.type === 'finalize');
      expect(finalizeCall).toBeDefined();
      const elements = finalizeCall?.card.body.elements;

      // 0: Collapsed thinking panel
      expect(elements[0].tag).toBe('collapsible_panel');
      expect(elements[0].expanded).toBe(false);
      expect(elements[0].header.title.content).toBe('**💭 思考过程**');
      expect(elements[0].header.background_color).toBe('blue-50');
      expect(elements[0].elements[0].content).toBe(
        'Analyzing query constraints... Formulating step-by-step resolution.'
      );

      // 1: Collapsed tool status panel
      expect(elements[1].tag).toBe('collapsible_panel');
      expect(elements[1].expanded).toBe(false);
      expect(elements[1].header.title.content).toBe('**🔧 执行过程**');
      expect(elements[1].header.background_color).toBe('wathet-50');
      expect(elements[1].elements[0].content).toContain('✅ **sql_query**: 已完成');

      // 2: Divider hr
      expect(elements[2].tag).toBe('hr');

      // 3: Pure body answer
      expect(elements[3].tag).toBe('markdown');
      expect(elements[3].content).toBe('Resolved answer based on database records.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Streaming card phase: initial card expands thinking panel placed above status and main_content', async () => {
    const transport = new FakeLarkTransport();
    await transport.start();

    const session = await transport.createStreamingCard({
      chatId: 'oc_test_k3b_streaming',
      withThinkingPanel: true,
      withStatusPanel: true,
    });
    expect(session).not.toBeNull();

    const createCall = transport.streamingCalls.find((c) => c.type === 'card_create');
    const initialElements = createCall?.card.body.elements;

    // Element 0: Thinking panel (expanded: true during streaming)
    expect(initialElements[0].tag).toBe('collapsible_panel');
    expect(initialElements[0].expanded).toBe(true);
    expect(initialElements[0].header.title.content).toBe('**💭 思考过程**');
    expect(initialElements[0].header.background_color).toBe('blue-50');
    expect(initialElements[0].elements[0].element_id).toBe('thinking_content');

    // Element 1: Process panel (expanded: true during streaming)
    expect(initialElements[1].tag).toBe('collapsible_panel');
    expect(initialElements[1].expanded).toBe(true);
    expect(initialElements[1].header.title.content).toBe('**🔧 执行过程**');
    expect(initialElements[1].elements[0].element_id).toBe('tool_status_content');

    // Element 2: Main content
    expect(initialElements[2].tag).toBe('markdown');
    expect(initialElements[2].element_id).toBe('main_content');

    // Push thinking update
    await session?.pushThinking?.('> Reasoning step in progress...');
    const pushThinkingCall = transport.streamingCalls.find((c) => c.type === 'push_thinking');
    expect(pushThinkingCall).toBeDefined();
    expect(pushThinkingCall?.content).toBe('> Reasoning step in progress...');
  });

  it('C6 Native CoT path selection: does NOT double-render thinking panel when CoT is active for chat', async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeLarkTransport();
      await transport.start();

      const events: Array<{
        rowId: number;
        type: 'assistant_delta' | 'turn_status' | 'reasoning_delta';
        delta?: string;
        status?: string;
      }> = [
        { rowId: 1, type: 'reasoning_delta', delta: 'Native CoT is already handling this bubble' },
        { rowId: 2, type: 'assistant_delta', delta: 'Final answer for CoT chat' },
        { rowId: 3, type: 'turn_status', status: 'completed' },
      ];

      const fakeSource: StreamEventSource = {
        listAssistantEvents: vi.fn().mockImplementation(async (_r, after) => {
          return events.filter((e) => e.rowId > after);
        }),
      };

      // Chat config explicitly has CoT enabled
      const tracker = new StreamingReplyTracker({
        transport,
        streamEventSource: fakeSource,
        sessionRouteId: 'session_k3b_cot',
        enableCot: true, // Master or per-chat CoT enabled
        cardParams: {
          chatId: 'oc_cot_chat',
        },
        initialCursor: 0,
      });

      expect(tracker.isCotActiveForTurn()).toBe(true);

      tracker.start();
      await vi.advanceTimersByTimeAsync(50);

      // Reasoning was tracked
      expect(tracker.getAccumulatedThinking()).toBe('Native CoT is already handling this bubble');

      // Finalize turn
      await tracker.finalize('Final answer for CoT chat', 'completed');

      const finalizeCall = transport.streamingCalls.find((c) => c.type === 'finalize');
      expect(finalizeCall).toBeDefined();
      const elements = finalizeCall?.card.body.elements;

      // Thinking panel MUST NOT be in the card because C6 native CoT handles it!
      const thinkingPanel = elements.find(
        (e: any) => e.tag === 'collapsible_panel' && e.header?.title?.content === '**💭 思考过程**'
      );
      expect(thinkingPanel).toBeUndefined();

      // Main answer is directly delivered
      expect(elements[0].tag).toBe('markdown');
      expect(elements[0].content).toBe('Final answer for CoT chat');
    } finally {
      vi.useRealTimers();
    }
  });

  it('strips <think> tags from textToFinalize so body contains only final answer and routes think content to thinking panel', async () => {
    const transport = new FakeLarkTransport();
    await transport.start();

    const session = await transport.createStreamingCard({
      chatId: 'oc_test_strip_think',
    });
    expect(session).not.toBeNull();

    const textWithTags = '<think>\nSecret chain of thoughts\n</think>\nActual pure answer';
    await session!.finalize(textWithTags, 'completed');

    const finalizeCall = transport.streamingCalls.find((c) => c.type === 'finalize');
    const elements = finalizeCall?.card.body.elements;

    // Elements: [0: Thinking Panel, 1: hr divider, 2: Body]
    expect(elements[0].tag).toBe('collapsible_panel');
    expect(elements[0].expanded).toBe(false);
    expect(elements[0].elements[0].content).toBe('Secret chain of thoughts');

    expect(elements[1].tag).toBe('hr');

    expect(elements[2].tag).toBe('markdown');
    expect(elements[2].content).toBe('Actual pure answer');
  });

  it('Real Inbound Gateway Path: tracks reasoning_delta from Lark inbound handler to card creation and finalizes with thinking panel', async () => {
    const transport = new FakeLarkTransport();
    await transport.start();

    const mockRepo = {
      findAccountById: vi.fn().mockResolvedValue({ id: 'acc_k3b_test', status: 'active', defaultSpaceId: 'space_default' }),
      findBindingByContext: vi.fn().mockResolvedValue({ id: 'bind_1', spaceId: 'space_default', groupActivationMode: 'always' }),
      findInboxByEvent: vi.fn().mockResolvedValue(null),
      createInboxItem: vi.fn().mockImplementation((item) => Promise.resolve({ item: { ...item, id: 'inbox_1' }, isDuplicate: false })),
      claimInboxForProcessing: vi.fn().mockImplementation((id) => Promise.resolve({ id, status: 'processing', attempts: 1, payloadJson: JSON.stringify({ parsed: { chatId: 'oc_inbound_k3b', messageId: 'om_human_k3b_001' } }) })),
      updateInboxStatus: vi.fn().mockResolvedValue(undefined),
      findOutboxById: vi.fn().mockResolvedValue(null),
      createOutboxItem: vi.fn().mockImplementation((item) => Promise.resolve({ ...item, id: 'outbox_1' })),
      updateOutboxStatus: vi.fn().mockResolvedValue(undefined),
      listUndeliveredOutbox: vi.fn().mockResolvedValue([]),
    };

    const mockRouteRepo = {
      findByRouteIdentity: vi.fn().mockResolvedValue({ id: 'route_k3b_1', spaceId: 'space_default', nativeContextId: 'oc_inbound_k3b' }),
      findRouteByChatAndNativeContext: vi.fn().mockResolvedValue({ id: 'route_k3b_1', spaceId: 'space_default', nativeContextId: 'oc_inbound_k3b' }),
      findById: vi.fn().mockResolvedValue({ id: 'route_k3b_1', nativeContextId: 'oc_inbound_k3b' }),
      createRoute: vi.fn().mockResolvedValue({ id: 'route_k3b_1', spaceId: 'space_default', nativeContextId: 'oc_inbound_k3b' }),
      create: vi.fn().mockResolvedValue({ id: 'route_k3b_1', spaceId: 'space_default', nativeContextId: 'oc_inbound_k3b' }),
    };

    const events: any[] = [];
    const mockStreamEventSource: StreamEventSource = {
      listAssistantEvents: vi.fn().mockImplementation(async () => events),
      getLatestRowId: vi.fn().mockResolvedValue(0),
    };

    const mockRuntimeGateway = {
      dispatchInbound: vi.fn().mockResolvedValue({
        executionMode: 'runtime',
        turnId: 'turn_k3b_123',
      }),
    };

    const { LarkChannelGateway } = await import('../src/gateway.js');
    const gateway = new LarkChannelGateway({
      account: {
        id: 'acc_k3b_test',
        userId: 'usr_k3b',
      },
      transport,
      channelRepo: mockRepo as any,
      sessionRouteRepo: mockRouteRepo as any,
      runtimeGateway: mockRuntimeGateway as any,
      streamEventSource: mockStreamEventSource,
    });

    // 1. Inbound event arrives
    const rawEvent = {
      header: {
        event_id: 'evt_k3b_001',
        event_type: 'im.message.receive_v1',
        create_time: '1700000000000',
      },
      event: {
        sender: {
          sender_id: { open_id: 'ou_human_k3b' },
          sender_type: 'user',
        },
        message: {
          message_id: 'om_human_k3b_001',
          chat_id: 'oc_inbound_k3b',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: 'Calculate something with reasoning' }),
          create_time: '1700000000000',
        },
      },
    };

    const inRes = await gateway.handleInboundEvent(rawEvent);
    expect(inRes.handled).toBe(true);

    const tracker = (gateway as any).activeTrackers.get('idem_lark_acc_k3b_test_evt_k3b_001');
    expect(tracker).toBeDefined();
    expect((tracker as any).withThinkingPanel).toBe(true);
    expect((tracker as any).withStatusPanel).toBe(true);

    // Initial streaming card should have been created with thinking panel
    const createCall = transport.streamingCalls.find((c) => c.type === 'card_create');
    expect(createCall).toBeDefined();
    const initialElements = createCall?.card.body.elements;
    expect(initialElements[0].tag).toBe('collapsible_panel');
    expect(initialElements[0].header.background_color).toBe('blue-50');

    // 2. Stream events: reasoning_delta + tool_status + assistant_delta
    events.push({
      rowId: 1,
      type: 'reasoning_delta',
      delta: 'Reasoning step 1: analyze input.\nReasoning step 2: compute value.',
      streamId: 's_r1',
    });
    events.push({
      rowId: 2,
      type: 'tool_status',
      toolName: 'calculator',
      status: 'completed',
    });
    events.push({
      rowId: 3,
      type: 'assistant_delta',
      delta: 'The calculated answer is 42.',
      streamId: 's_a1',
    });

    // 3. Turn completes
    await gateway.handleTurnCompleted({
      sessionId: 'route_k3b_1',
      turnId: 'turn_k3b_123',
      replyText: 'The calculated answer is 42.',
      idempotencyKey: 'idem_lark_acc_k3b_test_evt_k3b_001',
      chatId: 'oc_inbound_k3b',
    });

    const finalizeCall = transport.streamingCalls.find((c) => c.type === 'finalize');
    expect(finalizeCall).toBeDefined();
    expect(finalizeCall?.status).toBe('completed');
    expect(finalizeCall?.card.header.template).toBe('violet');

    const elements = finalizeCall?.card.body.elements;
    // Structural layout: [0: Thinking Panel, 1: Tool Panel, 2: hr, 3: Body, 4: Footer]
    expect(elements[0].tag).toBe('collapsible_panel');
    expect(elements[0].expanded).toBe(false);
    expect(elements[0].header.title.content).toBe('**💭 思考过程**');
    expect(elements[0].header.background_color).toBe('blue-50');
    expect(elements[0].elements[0].content).toContain('Reasoning step 1: analyze input.');

    expect(elements[1].tag).toBe('collapsible_panel');
    expect(elements[1].expanded).toBe(false);
    expect(elements[1].header.title.content).toBe('**🔧 执行过程**');
    expect(elements[1].header.background_color).toBe('wathet-50');
    expect(elements[1].elements[0].content).toContain('✅ **calculator**: 已完成');

    expect(elements[2].tag).toBe('hr');

    expect(elements[3].tag).toBe('markdown');
    expect(elements[3].content).toBe('The calculated answer is 42.');

    expect(elements[4].tag).toBe('markdown');
    expect(elements[4].text_size).toBe('notation');
  });
});
