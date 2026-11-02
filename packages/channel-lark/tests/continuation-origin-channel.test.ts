import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakeLarkTransport } from '../src/transport.js';
import { ContinuationWatcher } from '../src/continuation-watcher.js';
import type { StreamEventSource } from '../src/types.js';

/**
 * A session route can be shared by Lark, WeChat, Web and Jarvis. The Lark continuation watcher
 * must only deliver autonomous turns whose causal origin is a Lark turn.
 */
describe('ContinuationWatcher origin channel check', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function buildWatcher(originChannel: string | undefined) {
    const routeId = 'ses_00000000000000000000000000000001';
    const chatId = 'oc_test0000000000000000000000000001';
    const turnId = 'turn_auto_test_origin_0001';
    const originTurnId = 'turn_origin_test_origin_0001';
    const events: any[] = [
      { rowId: 30, type: 'turn_status', status: 'running', turnId, originTurnId },
      { rowId: 31, type: 'assistant_delta', delta: 'Background work done.', streamId: 'msgstream_origin_1', turnId },
      { rowId: 32, type: 'assistant_stream_end', streamId: 'msgstream_origin_1', turnId },
      { rowId: 33, type: 'turn_status', status: 'completed', turnId },
    ];
    const transport = new FakeLarkTransport();
    const source: StreamEventSource = {
      listAssistantEvents: vi.fn().mockImplementation(async (_rId, afterRowId) => events.filter((e) => e.rowId > afterRowId)),
      resolveTurnOrigin: vi.fn().mockResolvedValue({
        turnId: originTurnId,
        userId: 'user-alice',
        sessionId: routeId,
        accountId: 'acc_test_origin_01',
        ...(originChannel !== undefined ? { channel: originChannel } : {}),
        chatId: originChannel === 'lark' || originChannel === undefined ? chatId : 'jarvis-context-01',
        nativeContextId: originChannel === 'lark' || originChannel === undefined ? chatId : 'jarvis-context-01',
        replyToMessageId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    };
    const channelRepo: any = {
      createOutboxItem: vi.fn().mockImplementation(async (item) => item),
      upsertStreamingCard: vi.fn().mockResolvedValue(undefined),
    };
    const watcher = new ContinuationWatcher({
      sessionRouteId: routeId,
      accountId: 'acc_test_lark_01',
      userId: 'user-alice',
      nativeContextId: chatId,
      streamEventSource: source,
      transport,
      channelRepo,
      replyTarget: { chatId },
      initialCursor: 29,
      hasActiveInboundTracker: () => false,
      pollIntervalMs: 100,
      inactivityTimeoutMs: 15 * 60 * 1000,
    });
    return { watcher, transport, channelRepo };
  }

  for (const foreign of ['jarvis', 'wechat', 'web']) {
    it(`does not open a Lark card for an autonomous turn that originated from ${foreign}`, async () => {
      const { watcher, transport, channelRepo } = buildWatcher(foreign);
      await transport.start();
      watcher.start();
      for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(100);

      expect(transport.streamingCalls).toHaveLength(0);
      expect(channelRepo.createOutboxItem).not.toHaveBeenCalled();
      expect(watcher.getCursor()).toBe(33);
      watcher.stop();
    });
  }

  it('still delivers an autonomous turn whose origin is lark (or has no channel field)', async () => {
    for (const channel of ['lark', undefined]) {
      const { watcher, transport, channelRepo } = buildWatcher(channel);
      await transport.start();
      watcher.start();
      for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(100);

      const finalize = transport.streamingCalls.find((c) => c.type === 'finalize');
      expect(finalize?.status).toBe('completed');
      expect(channelRepo.createOutboxItem).toHaveBeenCalledTimes(1);
      watcher.stop();
    }
  });
});
