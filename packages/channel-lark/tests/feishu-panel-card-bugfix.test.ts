import { describe, it, expect, vi } from 'vitest';
import { FakeLarkTransport, CredentialedLarkTransport } from '../src/transport.js';

describe('Feishu/Lark Streaming Card Background Tasks Panel Fixes', () => {
  const FEISHU_ELEMENT_ID_REGEX = /^[A-Za-z][A-Za-z0-9_]{0,19}$/;

  function extractElementIds(obj: any): string[] {
    const ids: string[] = [];
    if (!obj || typeof obj !== 'object') return ids;
    if (typeof obj.element_id === 'string') {
      ids.push(obj.element_id);
    }
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        ids.push(...extractElementIds(obj[key]));
      }
    }
    return ids;
  }

  function createMockApiClient(overrides: { cardUpdateResult?: any } = {}) {
    let createdInitialCard: any;
    let finalizedCard: any;
    let patchCount = 0;
    let updateCount = 0;
    const cardElementCalls: any[] = [];

    const client: any = {
      cardkit: {
        v1: {
          card: {
            create: async (req: any) => {
              createdInitialCard = JSON.parse(req.data.data);
              return { code: 0, data: { card_id: 'crd_synth_001' } };
            },
            settings: async () => ({ code: 0, data: {} }),
            update: async (req: any) => {
              updateCount++;
              finalizedCard = JSON.parse(req.data.card.data);
              if (overrides.cardUpdateResult) {
                return typeof overrides.cardUpdateResult === 'function'
                  ? overrides.cardUpdateResult(updateCount)
                  : overrides.cardUpdateResult;
              }
              return { code: 0, data: {} };
            },
          },
          cardElement: {
            content: async (req: any) => {
              cardElementCalls.push(req);
              return { code: 0, data: {} };
            },
          },
        },
      },
      im: {
        message: {
          reply: async () => ({ code: 0, data: { message_id: 'om_synth_001' } }),
          create: async () => ({ code: 0, data: { message_id: 'om_synth_001' } }),
          patch: async () => {
            patchCount++;
            return { code: 0, data: {} };
          },
        },
      },
    };

    return {
      client,
      getCreatedInitialCard: () => createdInitialCard,
      getFinalizedCard: () => finalizedCard,
      getPatchCount: () => patchCount,
      getUpdateCount: () => updateCount,
      getCardElementCalls: () => cardElementCalls,
    };
  }

  describe('(a) element_id validation against Feishu schema rules', () => {
    it('validates all element_ids emitted by FakeLarkTransport meet Feishu rule: <=20 chars, ^[A-Za-z][A-Za-z0-9_]{0,19}$', async () => {
      const transport = new FakeLarkTransport();
      await transport.start();

      const session = await transport.createStreamingCard({
        chatId: 'oc_synth_chat_001',
        title: 'Validation Test',
        withStatusBar: true,
        withStopButton: true,
        withThinkingPanel: true,
        withStatusPanel: true,
      });

      expect(session).not.toBeNull();

      // Collect initial card
      const initialCardCall = transport.streamingCalls.find((c) => c.type === 'card_create');
      const initialIds = extractElementIds(initialCardCall?.card);
      expect(initialIds.length).toBeGreaterThan(0);
      for (const id of initialIds) {
        expect(id).toMatch(FEISHU_ELEMENT_ID_REGEX);
        expect(id.length).toBeLessThanOrEqual(20);
      }

      // Finalize with panel
      await session!.finalize(
        'Some test response text',
        'completed',
        undefined,
        [{ toolName: 'test_tool', status: 'completed' }],
        'Thinking process...',
        '**🔄 后台任务**\n• [subagent] worker-1 · running · 10s'
      );

      const finalizeCall = transport.streamingCalls.find((c) => c.type === 'finalize');
      const finalizeIds = extractElementIds(finalizeCall?.card);
      expect(finalizeIds.length).toBeGreaterThan(0);
      for (const id of finalizeIds) {
        expect(id).toMatch(FEISHU_ELEMENT_ID_REGEX);
        expect(id.length).toBeLessThanOrEqual(20);
      }

      // Stopped card
      const stoppedSession = await transport.createStreamingCard({
        chatId: 'oc_synth_chat_001',
        title: 'Stopped Test',
      });
      await stoppedSession!.finalize('Partial text', 'stopped');
      const stoppedCall = transport.streamingCalls.filter((c) => c.type === 'finalize')[1];
      const stoppedIds = extractElementIds(stoppedCall?.card);
      for (const id of stoppedIds) {
        expect(id).toMatch(FEISHU_ELEMENT_ID_REGEX);
        expect(id.length).toBeLessThanOrEqual(20);
      }

      await transport.stop();
    });

    it('validates all element_ids emitted by CredentialedLarkTransport meet Feishu rule', async () => {
      const mockApi = createMockApiClient();

      const transport = new CredentialedLarkTransport({
        account: {
          id: 'acc_synth_val',
          appId: 'cli_mock_val',
          appSecret: 'sec_mock_val',
        },
        apiClient: mockApi.client,
      });

      const session = await transport.createStreamingCard({
        chatId: 'oc_synth_chat_002',
        title: 'Credentialed Validation Test',
        withStatusBar: true,
        withStopButton: true,
        withThinkingPanel: true,
        withStatusPanel: true,
      });

      expect(session).not.toBeNull();
      const initialIds = extractElementIds(mockApi.getCreatedInitialCard());
      expect(initialIds.length).toBeGreaterThan(0);
      for (const id of initialIds) {
        expect(id).toMatch(FEISHU_ELEMENT_ID_REGEX);
        expect(id.length).toBeLessThanOrEqual(20);
      }

      await session!.finalize(
        'Credentialed final response',
        'completed',
        undefined,
        [{ toolName: 'db_search', status: 'completed' }],
        'Thinking...',
        '✅ 后台任务已全部完成'
      );

      const finalIds = extractElementIds(mockApi.getFinalizedCard());
      expect(finalIds.length).toBeGreaterThan(0);
      for (const id of finalIds) {
        expect(id).toMatch(FEISHU_ELEMENT_ID_REGEX);
        expect(id.length).toBeLessThanOrEqual(20);
      }
    });
  });

  describe('(b) Panel update during streaming does NOT build or push final card', () => {
    it('FakeLarkTransport: panel update before finalize records panel text without building a final card; finalize includes panel', async () => {
      const transport = new FakeLarkTransport();
      await transport.start();

      const session = await transport.createStreamingCard({
        chatId: 'oc_synth_chat_stream',
        title: 'Live Streaming Card',
      });
      expect(session).not.toBeNull();

      await session!.pushText('Partial streamed reply...');

      // Update background panel while still streaming
      await session!.updateBackgroundPanel?.('**🔄 后台任务**\n• [subagent] worker-1 · running · 5s');

      // Check update_background_panel record has NO final card attached before finalize
      const bgCall = transport.streamingCalls.find((c) => c.type === 'update_background_panel');
      expect(bgCall).toBeDefined();
      expect(bgCall?.card).toBeUndefined();
      expect(bgCall?.panelText).toBe('**🔄 后台任务**\n• [subagent] worker-1 · running · 5s');

      // Ensure no finalize was dispatched prematurely
      expect(transport.streamingCalls.some((c) => c.type === 'finalize')).toBe(false);

      // Now finalize
      await session!.finalize('Final complete reply.', 'completed');

      const finalizeCall = transport.streamingCalls.find((c) => c.type === 'finalize');
      expect(finalizeCall).toBeDefined();
      expect(finalizeCall?.content).toBe('Final complete reply.');
      expect(finalizeCall?.status).toBe('completed');
      expect(finalizeCall?.panelText).toBe('**🔄 后台任务**\n• [subagent] worker-1 · running · 5s');

      // The finalized card must contain both the final text and the bg_panel
      const card = finalizeCall?.card;
      const elements = card.body.elements;
      const mainText = elements.find((e: any) => e.tag === 'markdown' && e.content === 'Final complete reply.');
      expect(mainText).toBeDefined();

      const bgPanel = elements.find((e: any) => e.element_id === 'bg_panel');
      expect(bgPanel).toBeDefined();
      expect(bgPanel.content).toBe('**🔄 后台任务**\n• [subagent] worker-1 · running · 5s');

      await transport.stop();
    });

    it('CredentialedLarkTransport: panel update before finalize updates bg_panel via cardElement.content without calling card.update or message.patch; finalize renders panel', async () => {
      const mockApi = createMockApiClient();

      const transport = new CredentialedLarkTransport({
        account: {
          id: 'acc_synth_stream',
          appId: 'cli_mock_stream',
          appSecret: 'sec_mock_stream',
        },
        apiClient: mockApi.client,
      });

      const session = await transport.createStreamingCard({
        chatId: 'oc_synth_chat_stream_real',
        title: 'Live Task',
      });

      // Initial card should contain empty bg_panel
      const initialCard = mockApi.getCreatedInitialCard();
      expect(initialCard.body.elements.find((e: any) => e.element_id === 'bg_panel')).toBeDefined();

      await session!.pushText('Live streaming tokens...');

      // Panel update during streaming
      await session!.updateBackgroundPanel?.('**🔄 后台任务**\n• [job] worker-1 · running · 10s');

      // cardElement.content should have been called for bg_panel!
      const elementCalls = mockApi.getCardElementCalls();
      const bgPanelCall = elementCalls.find((c: any) => c.path?.element_id === 'bg_panel');
      expect(bgPanelCall).toBeDefined();
      expect(bgPanelCall.data?.content).toBe('**🔄 后台任务**\n• [job] worker-1 · running · 10s');

      // card.update and message.patch must NOT have been called yet!
      expect(mockApi.getUpdateCount()).toBe(0);
      expect(mockApi.getPatchCount()).toBe(0);

      // Finalize the session
      await session!.finalize('Complete live answer.', 'completed');

      // Finalize should call card.update once
      expect(mockApi.getUpdateCount()).toBe(1);
      const lastUpdatedCard = mockApi.getFinalizedCard();
      expect(lastUpdatedCard).toBeDefined();
      expect(lastUpdatedCard.header.title.content).toBe('Live Task');
      expect(lastUpdatedCard.header.template).toBe('violet');

      const elements = lastUpdatedCard.body.elements;
      const contentEl = elements.find((e: any) => e.content === 'Complete live answer.');
      expect(contentEl).toBeDefined();

      const panelEl = elements.find((e: any) => e.element_id === 'bg_panel');
      expect(panelEl).toBeDefined();
      expect(panelEl.content).toBe('**🔄 后台任务**\n• [job] worker-1 · running · 10s');
    });
  });

  describe('(c) Panel update after finalize keeps text, header, icon identical', () => {
    it('rebuilds exactly the same final card finalize produced plus updated panel', async () => {
      const mockApi = createMockApiClient();

      const transport = new CredentialedLarkTransport({
        account: {
          id: 'acc_synth_post_fin',
          appId: 'cli_mock_post_fin',
          appSecret: 'sec_mock_post_fin',
        },
        apiClient: mockApi.client,
      });

      const session = await transport.createStreamingCard({
        chatId: 'oc_synth_chat_post_fin',
        title: 'Analysis Result',
      });

      await session!.finalize(
        'Original finalize report content.',
        'completed',
        { promptTokens: 100, completionTokens: 200, totalCostUsd: 0.005, durationMs: 1200 },
        undefined,
        'Deep thinking details',
        '**🔄 后台任务**\n• [subagent] worker-1 · running · 15s'
      );

      const firstFinalCard = JSON.parse(JSON.stringify(mockApi.getFinalizedCard()));
      expect(firstFinalCard.header.title.content).toBe('Analysis Result');
      expect(firstFinalCard.header.template).toBe('violet');

      // Later, the background poller finishes tasks
      await session!.updateBackgroundPanel?.('✅ 后台任务已全部完成');

      const secondFinalCard = mockApi.getFinalizedCard();
      // Header, template, main content, thinking panel, and footer metadata must be identical
      expect(secondFinalCard.header).toEqual(firstFinalCard.header);

      const mainContent1 = firstFinalCard.body.elements.find((e: any) => e.content === 'Original finalize report content.');
      const mainContent2 = secondFinalCard.body.elements.find((e: any) => e.content === 'Original finalize report content.');
      expect(mainContent2).toEqual(mainContent1);

      // Panel content is updated to complete
      const panelEl = secondFinalCard.body.elements.find((e: any) => e.element_id === 'bg_panel');
      expect(panelEl.content).toBe('✅ 后台任务已全部完成');
    });
  });

  describe('(d) Panel update does not fallback to message.patch if card.update fails', () => {
    it('CredentialedLarkTransport: skips message.patch when card.update fails on a panel-only update', async () => {
      const mockApi = createMockApiClient({
        cardUpdateResult: (count: number) => {
          if (count > 1) {
            return { code: 300301, msg: 'Card element error' };
          }
          return { code: 0, data: {} };
        },
      });

      const transport = new CredentialedLarkTransport({
        account: {
          id: 'acc_synth_safe_patch',
          appId: 'cli_mock_safe_patch',
          appSecret: 'sec_mock_safe_patch',
        },
        apiClient: mockApi.client,
      });

      const session = await transport.createStreamingCard({
        chatId: 'oc_synth_chat_safe_patch',
        title: 'Safe Patch Test',
      });

      // 1. Finalize succeeds (updateCount = 1)
      await session!.finalize('Important finalized text.', 'completed');
      expect(mockApi.getPatchCount()).toBe(0);

      // 2. Post-finalize panel update fails at card.update (updateCount = 2 -> returns 300301)
      await session!.updateBackgroundPanel?.('✅ 后台任务已全部完成');

      // Must NOT have called message.patch for panel-only update
      expect(mockApi.getPatchCount()).toBe(0);
    });
  });

  describe('(e) Stopped and failed cards keep their status across panel updates', () => {
    it('stopped card maintains orange header and (已中止) title on panel update', async () => {
      const transport = new FakeLarkTransport();
      await transport.start();

      const session = await transport.createStreamingCard({
        chatId: 'oc_synth_chat_stopped',
        title: 'Task Stopped Test',
      });

      await session!.finalize('Partial response before stop', 'stopped');

      const finalizeCall = transport.streamingCalls.find((c) => c.type === 'finalize');
      expect(finalizeCall?.card.header.template).toBe('orange');
      expect(finalizeCall?.card.header.title.content).toContain('(已中止)');

      // Background task update after stop
      await session!.updateBackgroundPanel?.('✅ 后台任务已全部完成');

      const bgCall = transport.streamingCalls.find((c) => c.type === 'update_background_panel');
      expect(bgCall?.card.header.template).toBe('orange');
      expect(bgCall?.card.header.title.content).toContain('(已中止)');
      expect(bgCall?.card.body.elements.find((e: any) => e.element_id === 'bg_panel')?.content).toBe('✅ 后台任务已全部完成');

      await transport.stop();
    });

    it('failed card maintains red header and (处理失败) title on panel update', async () => {
      const transport = new FakeLarkTransport();
      await transport.start();

      const session = await transport.createStreamingCard({
        chatId: 'oc_synth_chat_failed',
        title: 'Task Failed Test',
      });

      await session!.finalize('Error details', 'failed');

      const finalizeCall = transport.streamingCalls.find((c) => c.type === 'finalize');
      expect(finalizeCall?.card.header.template).toBe('red');
      expect(finalizeCall?.card.header.title.content).toContain('(处理失败)');

      // Background task update after failure
      await session!.updateBackgroundPanel?.('✅ 后台任务已全部完成');

      const bgCall = transport.streamingCalls.find((c) => c.type === 'update_background_panel');
      expect(bgCall?.card.header.template).toBe('red');
      expect(bgCall?.card.header.title.content).toContain('(处理失败)');

      await transport.stop();
    });
  });
});
