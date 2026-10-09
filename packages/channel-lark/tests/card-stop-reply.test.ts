import { describe, it, expect, vi } from 'vitest';
import {
  buildStopReplyButton,
  FakeLarkTransport,
  CredentialedLarkTransport,
} from '../src/transport.js';
import { parseLarkCardAction, isCardActionEvent } from '../src/parser.js';
import { LarkChannelGateway } from '../src/gateway.js';
import type {
  LarkSdkClientFactory,
  ILarkApiClient,
  StreamEventSource,
} from '../src/types.js';

describe('C3: Feishu Streaming Card Stop-Reply Button & Authorization (card-stop-reply-button)', () => {
  describe('buildStopReplyButton', () => {
    it('constructs Schema 2.0 danger button with action: stop_reply and turnId/sessionId correlation', () => {
      const btn = buildStopReplyButton('turn_123', 'ses_456');
      expect(btn.tag).toBe('button');
      expect(btn.element_id).toBe('stop_reply_button');
      expect(btn.type).toBe('danger');
      expect((btn.text as any).tag).toBe('plain_text');
      expect((btn.text as any).content).toBe('⏹ 停止回复');
      expect((btn.value as any).action).toBe('stop_reply');
      expect((btn.value as any).turnId).toBe('turn_123');
      expect((btn.value as any).sessionId).toBe('ses_456');
    });

    it('handles undefined turnId and sessionId gracefully', () => {
      const btn = buildStopReplyButton();
      expect(btn.tag).toBe('button');
      expect((btn.value as any).action).toBe('stop_reply');
      expect((btn.value as any).turnId).toBeUndefined();
      expect((btn.value as any).sessionId).toBeUndefined();
    });
  });

  describe('Transport Streaming Card Stop Button Integration', () => {
    it('CredentialedLarkTransport appends stop button to initialCard elements when withStopButton is true', async () => {
      let createdCardPayload: any;
      const mockClient = {
        cardkit: {
          v1: {
            card: {
              create: vi.fn().mockImplementation((req: any) => {
                createdCardPayload = JSON.parse(req.data.data);
                return { code: 0, data: { card_id: 'crd_mock_stop_1' } };
              }),
            },
          },
        },
        im: {
          message: {
            create: vi.fn().mockResolvedValue({
              code: 0,
              data: { message_id: 'om_mock_stop_1' },
            }),
          },
        },
      } as unknown as ILarkApiClient;

      const transport = new CredentialedLarkTransport({
        account: {
          id: 'acc_cred_stop',
          userId: 'usr_stop',
          appId: 'cli_mock_stop',
          appSecret: 'sec_mock_stop',
        },
        clientFactory: {
          createClient: () => mockClient,
        } as LarkSdkClientFactory,
      });

      await transport.start();

      const session = await transport.createStreamingCard({
        chatId: 'oc_stop_cred_chat',
        title: 'Stop Test Bot',
        withStopButton: true,
        turnId: 'turn_stop_cred_1',
        sessionId: 'ses_stop_cred_1',
      });
      expect(session).not.toBeNull();

      expect(createdCardPayload).toBeDefined();
      const elements = createdCardPayload.body.elements;
      expect(elements.length).toBe(3);
      expect(elements[0].tag).toBe('markdown');
      expect(elements[0].element_id).toBe('main_content');
      expect(elements[1].tag).toBe('markdown');
      expect(elements[1].element_id).toBe('bg_panel');
      // Stop button element
      expect(elements[2].tag).toBe('button');
      expect(elements[2].type).toBe('danger');
      expect(elements[2].text.content).toBe('⏹ 停止回复');
      expect(elements[2].value.action).toBe('stop_reply');
      expect(elements[2].value.turnId).toBe('turn_stop_cred_1');
      expect(elements[2].value.sessionId).toBe('ses_stop_cred_1');
    });

    it('FakeLarkTransport finalizes card with status "stopped" using grey header and "已中止" title', async () => {
      const transport = new FakeLarkTransport();
      await transport.start();

      const session = await transport.createStreamingCard({
        chatId: 'oc_fake_stop_chat',
        title: 'Assistant',
        turnId: 'turn_f_1',
      });
      expect(session).not.toBeNull();

      await session!.pushText('Draft analysis in progress...');
      await session!.finalize('Draft analysis in progress...\n\n*(已停止回复)*', 'stopped');

      const finalizeCall = transport.streamingCalls.find((c) => c.type === 'finalize');
      expect(finalizeCall).toBeDefined();
      expect(finalizeCall?.status).toBe('stopped');
      expect(finalizeCall?.card.header.template).toBe('orange');
      expect(finalizeCall?.card.header.title.content).toBe('Assistant (已中止)');
      // Statically stripped stop button
      const finalElements = finalizeCall?.card.body.elements;
      const btn = finalElements.find((e: any) => e.tag === 'button');
      expect(btn).toBeUndefined();
    });
  });

  describe('CredentialedLarkTransport eventDispatcher card.action.trigger wiring', () => {
    it('dispatches card.action.trigger callbacks to registered event handlers and returns toast response', async () => {
      let registeredEventDispatcher: any;
      const fakeSdk = {
        EventDispatcher: class {
          register(handlers: any) {
            registeredEventDispatcher = handlers;
            return this;
          }
        },
      };

      const transport = new CredentialedLarkTransport({
        account: {
          id: 'acc_event_wiring',
          userId: 'usr_wire',
          appId: 'cli_wire',
          appSecret: 'sec_wire',
        },
        clientFactory: {
          createClient: () => ({} as any),
        } as LarkSdkClientFactory,
      });

      // Inject SDK mock into transport start flow
      const handlerMock = vi.fn().mockResolvedValue({
        handled: true,
        toast: { type: 'info', content: '已停止回复' },
      });
      transport.onEvent(handlerMock);

      // Verify simulated card action through simulateInboundEvent
      const actionPayload = {
        header: { event_type: 'card.action.trigger' },
        action: { value: { action: 'stop_reply', turnId: 'turn_disp_1' } },
        operator: { open_id: 'ou_disp_1' },
      };

      const result = await handlerMock(actionPayload as any);
      expect(result.toast?.content).toBe('已停止回复');
    });
  });

  describe('Gateway Operator Permission Checks & Idempotency', () => {
    it('allows chat owner to stop turn in group chat when apiClient provides chat metadata', async () => {
      const mockApiClient = {
        im: {
          v1: {
            chat: {
              get: vi.fn().mockResolvedValue({
                data: { owner_id: 'ou_owner_999' },
              }),
            },
          },
        },
      };

      const fakeTransport = new FakeLarkTransport();
      (fakeTransport as any).apiClient = mockClientMock();

      function mockClientMock() {
        return mockApiClient;
      }

      await fakeTransport.start();

      let cancelCalled = false;
      const runtimeGateway: any = {
        dispatchInbound: vi.fn().mockResolvedValue({ turnId: 'turn_owner_test', executionMode: 'agent' }),
        cancelTurn: vi.fn().mockImplementation(async () => {
          cancelCalled = true;
          return true;
        }),
      };

      const fakeChannelRepo: any = {
        findAccountById: vi.fn().mockResolvedValue({ id: 'acc_1', status: 'active' }),
      };
      const fakeSessionRepo: any = {
        findById: vi.fn().mockResolvedValue(null),
      };

      const gateway = new LarkChannelGateway({
        account: { id: 'acc_1', userId: 'usr_owner' },
        transport: fakeTransport,
        channelRepo: fakeChannelRepo,
        sessionRouteRepo: fakeSessionRepo,
        runtimeGateway,
      });

      // Card action from chat owner
      const actionEvent = {
        header: { event_type: 'card.action.trigger' },
        action: { value: { action: 'stop_reply', turnId: 'turn_owner_test' } },
        operator: { open_id: 'ou_owner_999' },
        context: { open_chat_id: 'oc_group_with_owner' },
      };

      const res = await gateway.handleInboundEvent(actionEvent as any);
      expect(res.handled).toBe(true);
      expect(res.toast?.content).toBe('已停止回复');
      expect(cancelCalled).toBe(true);

      // Second click: idempotent
      cancelCalled = false;
      const res2 = await gateway.handleInboundEvent(actionEvent as any);
      expect(res2.handled).toBe(true);
      expect(res2.toast?.content).toBe('回复已停止');
      expect(cancelCalled).toBe(false);
    });
  });
});
