import { describe, it, expect, vi } from 'vitest';
import {
  FakeLarkTransport,
  formatCardUsageFooter,
} from '../src/transport.js';
import { StreamingReplyTracker } from '../src/streaming-tracker.js';
import { LarkChannelGateway } from '../src/gateway.js';
import type { CardToolStatusEntry, CardFinalMetadata, StreamEventSource } from '../src/types.js';

describe('K3a: Feishu Cards C4 Process Panel & HC Alignment', () => {
  it('FakeLarkTransport header state colors align to HC (processing/done/error/stopped)', async () => {
    const transport = new FakeLarkTransport();
    await transport.start();

    // 1. Processing (creation): template blue
    const session = await transport.createStreamingCard({
      chatId: 'oc_test_header',
      title: 'Bot',
      withStatusPanel: true,
    });
    expect(session).not.toBeNull();
    const createCall = transport.streamingCalls.find((c) => c.type === 'card_create');
    expect(createCall?.card.header.template).toBe('blue');

    // 2. Completed (done): template violet, default title '已完成' or explicit title
    await session!.finalize('Done answer', 'completed');
    const finalizeDone = transport.streamingCalls.find((c) => c.type === 'finalize');
    expect(finalizeDone?.card.header.template).toBe('violet');
    expect(finalizeDone?.card.header.title.content).toBe('Bot');

    // 3. Stopped: template orange, title '... (已中止)'
    const stopSession = await transport.createStreamingCard({
      chatId: 'oc_test_header_stop',
    });
    await stopSession!.finalize('(已停止回复)', 'stopped');
    const finalizeStopped = transport.streamingCalls
      .filter((c) => c.type === 'finalize')
      .pop();
    expect(finalizeStopped?.card.header.template).toBe('orange');
    expect(finalizeStopped?.card.header.title.content).toBe('已中止');

    // 4. Failed (error): template red, title '处理失败'
    const failSession = await transport.createStreamingCard({
      chatId: 'oc_test_header_fail',
    });
    await failSession!.finalize('Error', 'failed');
    const finalizeFailed = transport.streamingCalls
      .filter((c) => c.type === 'finalize')
      .pop();
    expect(finalizeFailed?.card.header.template).toBe('red');
    expect(finalizeFailed?.card.header.title.content).toBe('处理失败');
  });

  it('final card inserts hr divider between collapsible process panel and body', async () => {
    const transport = new FakeLarkTransport();
    await transport.start();

    const session = await transport.createStreamingCard({
      chatId: 'oc_test_hr',
      withStatusPanel: true,
    });
    expect(session).not.toBeNull();

    const toolEntries: CardToolStatusEntry[] = [
      { toolName: 'web_search', status: 'completed' },
    ];
    await session!.finalize('Answer with tool execution', 'completed', undefined, toolEntries);

    const finalizeCall = transport.streamingCalls.find((c) => c.type === 'finalize');
    const elements = finalizeCall?.card.body.elements;

    // Elements structure: [collapsible_panel, hr, markdown (body)]
    expect(elements[0].tag).toBe('collapsible_panel');
    expect(elements[0].expanded).toBe(false);
    expect(elements[1].tag).toBe('hr');
    expect(elements[2].tag).toBe('markdown');
    expect(elements[2].content).toBe('Answer with tool execution');
  });

  it('final card footer uses notation text_size and displays tokens/cost only when real data exists', async () => {
    const transport = new FakeLarkTransport();
    await transport.start();

    const session = await transport.createStreamingCard({
      chatId: 'oc_test_footer',
    });

    // Case A: Real tokens and cost exist
    const fullMeta: CardFinalMetadata = {
      model: 'deepseek-chat',
      durationSeconds: 3.5,
      promptTokens: 100,
      completionTokens: 50,
      cost: 0.0025,
    };
    await session!.finalize('Answer A', 'completed', fullMeta);

    const callA = transport.streamingCalls.find((c) => c.type === 'finalize');
    const elementsA = callA?.card.body.elements;
    const footerA = elementsA[elementsA.length - 1];
    expect(footerA.tag).toBe('markdown');
    expect(footerA.text_size).toBe('notation');
    expect(footerA.content).toContain('🤖 deepseek-chat · ⏱ 3.5s · 💡 100+50 tokens · 💰 $0.0025');

    // Case B: DB lacks token/cost fields (missing or 0) -> shows model + time only
    const modelTimeOnlyMeta: CardFinalMetadata = {
      model: 'claude-3-7-sonnet',
      durationSeconds: 2.1,
    };
    const footerBText = formatCardUsageFooter(modelTimeOnlyMeta);
    expect(footerBText).toBe("<font color='grey'>🤖 claude-3-7-sonnet · ⏱ 2.1s</font>");
  });

  it('gateway wires withStatusPanel: true on inbound turns and finalize passes toolStatus to keep collapsed panel', async () => {
    const transport = new FakeLarkTransport();
    await transport.start();

    const mockRepo = {
      findAccountById: vi.fn().mockResolvedValue({ id: 'acc_k3a_test', status: 'active', defaultSpaceId: 'space_default' }),
      findBindingByContext: vi.fn().mockResolvedValue({ id: 'bind_1', spaceId: 'space_default', groupActivationMode: 'always' }),
      findInboxByEvent: vi.fn().mockResolvedValue(null),
      createInboxItem: vi.fn().mockImplementation((item) => Promise.resolve({ item: { ...item, id: 'inbox_1' }, isDuplicate: false })),
      claimInboxForProcessing: vi.fn().mockImplementation((id) => Promise.resolve({ id, status: 'processing', attempts: 1, payloadJson: JSON.stringify({ parsed: { chatId: 'oc_inbound_chat', messageId: 'om_human_k3a_001' } }) })),
      updateInboxStatus: vi.fn().mockResolvedValue(undefined),
      findOutboxById: vi.fn().mockResolvedValue(null),
      createOutboxItem: vi.fn().mockImplementation((item) => Promise.resolve({ ...item, id: 'outbox_1' })),
      updateOutboxStatus: vi.fn().mockResolvedValue(undefined),
      listUndeliveredOutbox: vi.fn().mockResolvedValue([]),
    };

    const mockRouteRepo = {
      findByRouteIdentity: vi.fn().mockResolvedValue({ id: 'route_k3a_1', spaceId: 'space_default', nativeContextId: 'oc_inbound_chat' }),
      findRouteByChatAndNativeContext: vi.fn().mockResolvedValue({ id: 'route_k3a_1', spaceId: 'space_default', nativeContextId: 'oc_inbound_chat' }),
      findById: vi.fn().mockResolvedValue({ id: 'route_k3a_1', nativeContextId: 'oc_inbound_chat' }),
      createRoute: vi.fn().mockResolvedValue({ id: 'route_k3a_1', spaceId: 'space_default', nativeContextId: 'oc_inbound_chat' }),
      create: vi.fn().mockResolvedValue({ id: 'route_k3a_1', spaceId: 'space_default', nativeContextId: 'oc_inbound_chat' }),
    };

    const events: any[] = [];
    const mockStreamEventSource: StreamEventSource = {
      listAssistantEvents: vi.fn().mockImplementation(async () => events),
      getLatestRowId: vi.fn().mockResolvedValue(0),
    };

    const mockRuntimeGateway = {
      dispatchInbound: vi.fn().mockResolvedValue({
        executionMode: 'runtime',
        turnId: 'turn_k3a_123',
      }),
    };

    const gateway = new LarkChannelGateway({
      account: {
        id: 'acc_k3a_test',
        userId: 'usr_k3a',
      },
      transport,
      channelRepo: mockRepo as any,
      sessionRouteRepo: mockRouteRepo as any,
      runtimeGateway: mockRuntimeGateway as any,
      streamEventSource: mockStreamEventSource,
    });

    // 1. Inbound turn dispatch
    const rawEvent = {
      header: {
        event_id: 'evt_k3a_001',
        event_type: 'im.message.receive_v1',
        create_time: '1700000000000',
      },
      event: {
        sender: {
          sender_id: { open_id: 'ou_human_k3a' },
          sender_type: 'user',
        },
        message: {
          message_id: 'om_human_k3a_001',
          chat_id: 'oc_inbound_chat',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: 'Hello bot' }),
          create_time: '1700000000000',
        },
      },
    };

    const inRes = await gateway.handleInboundEvent(rawEvent);
    expect(inRes.handled).toBe(true);

    const activeTracker = (gateway as any).activeTrackers.get('idem_lark_acc_k3a_test_evt_k3a_001');
    expect(activeTracker).toBeDefined();
    expect((activeTracker as any).withStatusPanel).toBe(true);

    // Simulate tool events arriving
    events.push({
      rowId: 1,
      type: 'tool_status',
      toolName: 'web_search',
      status: 'started',
    });
    events.push({
      rowId: 2,
      type: 'tool_status',
      toolName: 'web_search',
      status: 'completed',
    });

    // 2. Complete turn
    await gateway.handleTurnCompleted({
      sessionId: 'route_k3a_1',
      turnId: 'turn_k3a_123',
      replyText: 'Final completed reply',
      idempotencyKey: 'idem_lark_acc_k3a_test_evt_k3a_001',
      chatId: 'oc_inbound_chat',
    });

    const finalizeCall = transport.streamingCalls.find((c) => c.type === 'finalize');
    expect(finalizeCall).toBeDefined();
    expect(finalizeCall?.status).toBe('completed');
    expect(finalizeCall?.card.header.template).toBe('violet');

    const elements = finalizeCall?.card.body.elements;
    // Collapsed tool panel preserved!
    expect(elements[0].tag).toBe('collapsible_panel');
    expect(elements[0].expanded).toBe(false);
    expect(elements[0].elements[0].content).toContain('✅ **web_search**: 已完成');

    // hr divider present
    expect(elements[1].tag).toBe('hr');

    // Body content
    expect(elements[2].tag).toBe('markdown');
    expect(elements[2].content).toBe('Final completed reply');

    // Footer with notation
    expect(elements[3].tag).toBe('markdown');
    expect(elements[3].text_size).toBe('notation');
  });
});
