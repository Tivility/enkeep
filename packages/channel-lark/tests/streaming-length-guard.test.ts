import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  applyStreamingLengthGuard,
  STREAMING_MAX_CONTENT_LENGTH,
  STREAMING_MAX_LENGTH,
  STREAMING_TRUNCATION_NOTICE,
  StreamingReplyTracker,
} from '../src/streaming-tracker.js';
import {
  FakeLarkTransport,
  CredentialedLarkTransport,
} from '../src/transport.js';
import type { StreamEventSource, ILarkApiClient } from '../src/types.js';

describe('C1: Streaming Per-Element Length Guard (card-streaming-length-guard)', () => {
  describe('applyStreamingLengthGuard pure function', () => {
    it('preserves text when length is below or equal to threshold', () => {
      const shortText = 'Hello Lark streaming card';
      expect(applyStreamingLengthGuard(shortText)).toBe(shortText);

      const exactText = 'a'.repeat(STREAMING_MAX_LENGTH);
      expect(applyStreamingLengthGuard(exactText)).toBe(exactText);
      expect(applyStreamingLengthGuard(exactText).length).toBe(STREAMING_MAX_LENGTH);
    });

    it('truncates with sliding window and notice when length exceeds 3800', () => {
      const longText = 'prefix_' + 'x'.repeat(4990) + '_suffix_latest';
      expect(longText.length).toBeGreaterThan(4000);

      const guarded = applyStreamingLengthGuard(longText);

      // Must be safely within 3800 characters
      expect(guarded.length).toBeLessThanOrEqual(STREAMING_MAX_LENGTH);
      expect(guarded.length).toBe(STREAMING_MAX_LENGTH);

      // Must include truncation notice
      expect(guarded.startsWith(STREAMING_TRUNCATION_NOTICE)).toBe(true);

      // Sliding window: must include the latest content at the tail
      expect(guarded.endsWith('_suffix_latest')).toBe(true);
      expect(guarded.includes('prefix_')).toBe(false);
    });

    it('supports custom maxLength and notice', () => {
      const text = 'abcdefghijklmnopqrstuvwxyz';
      const customNotice = '... ';
      const guarded = applyStreamingLengthGuard(text, 10, customNotice);

      expect(guarded.length).toBe(10);
      expect(guarded.startsWith('... ')).toBe(true);
      expect(guarded).toBe('... uvwxyz');
    });

    it('safely handles notice longer than maxLength', () => {
      const text = '1234567890abcdefghij';
      const guarded = applyStreamingLengthGuard(text, 5, 'very_long_notice_here');

      expect(guarded.length).toBe(5);
      expect(guarded).toBe('fghij');
    });
  });

  describe('StreamingReplyTracker with FakeLarkTransport', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('pushes >4000 char deltas with payload length <= 3800 at all times, preserving full text in finalize', async () => {
      const transport = new FakeLarkTransport();
      await transport.start();

      // Generate a 5000 character stream across 3 deltas
      const chunk1 = 'Part 1: ' + 'A'.repeat(1500) + '\n\n';
      const chunk2 = 'Part 2: ' + 'B'.repeat(2000) + '\n\n';
      const chunk3 = 'Part 3: ' + 'C'.repeat(1500) + ' THE_END';
      const fullText = chunk1 + chunk2 + chunk3;
      expect(fullText.length).toBeGreaterThan(5000);

      const events: Array<{
        rowId: number;
        type: 'assistant_delta' | 'assistant_stream_end' | 'turn_status';
        delta?: string;
        streamId?: string;
        status?: string;
      }> = [
        { rowId: 1, type: 'assistant_delta', delta: chunk1, streamId: 's1' },
      ];

      const fakeSource: StreamEventSource = {
        listAssistantEvents: vi.fn().mockImplementation(async (_routeId, afterRowId) => {
          return events.filter((e) => e.rowId > afterRowId);
        }),
      };

      const tracker = new StreamingReplyTracker({
        transport,
        streamEventSource: fakeSource,
        sessionRouteId: 'session_c1_guard',
        cardParams: {
          chatId: 'oc_test_c1',
        },
        pollIntervalMs: 100,
      });

      tracker.start();

      // Tick 1: 1500 chars (<= 3800, no truncation)
      await vi.advanceTimersByTimeAsync(0);

      let pushes = transport.streamingCalls.filter((c) => c.type === 'push');
      expect(pushes.length).toBe(1);
      expect(pushes[0].content).toBe(chunk1);
      expect(pushes[0].content!.length).toBeLessThanOrEqual(STREAMING_MAX_CONTENT_LENGTH);

      // Tick 2: add chunk2 -> accumulated = 3500+ chars (still <= 3800)
      events.push({ rowId: 2, type: 'assistant_delta', delta: chunk2, streamId: 's1' });
      await vi.advanceTimersByTimeAsync(100);

      pushes = transport.streamingCalls.filter((c) => c.type === 'push');
      expect(pushes.length).toBe(2);
      expect(pushes[1].content!.length).toBeLessThanOrEqual(STREAMING_MAX_CONTENT_LENGTH);
      expect(pushes[1].content!.endsWith('Part 2: ' + 'B'.repeat(2000) + '\n\n')).toBe(true);

      // Tick 3: add chunk3 -> accumulated = >5000 chars (> 3800, trigger guard)
      events.push({ rowId: 3, type: 'assistant_delta', delta: chunk3, streamId: 's1' });
      await vi.advanceTimersByTimeAsync(100);

      pushes = transport.streamingCalls.filter((c) => c.type === 'push');
      expect(pushes.length).toBe(3);

      // CRITICAL ACCEPTANCE ASSERTION: Streaming push payload MUST be <= 3800
      for (const push of pushes) {
        expect(push.content!.length).toBeLessThanOrEqual(STREAMING_MAX_CONTENT_LENGTH);
      }

      // The last push must contain truncation notice and the latest generated content
      const lastPush = pushes[pushes.length - 1];
      expect(lastPush.content!.length).toBe(STREAMING_MAX_CONTENT_LENGTH);
      expect(lastPush.content!.startsWith(STREAMING_TRUNCATION_NOTICE)).toBe(true);
      expect(lastPush.content!.endsWith('THE_END')).toBe(true);

      // Finalize the tracker
      events.push({ rowId: 4, type: 'turn_status', status: 'completed' });
      const finalizeResult = await tracker.finalize(fullText, 'completed');
      expect(finalizeResult.handled).toBe(true);

      // CRITICAL ACCEPTANCE ASSERTION: Full 5000+ chars passed to finalize for multi-chunk rendering
      const finalizeCall = transport.streamingCalls.find((c) => c.type === 'finalize');
      expect(finalizeCall).toBeDefined();
      expect(finalizeCall?.content).toBe(fullText);
      expect(finalizeCall?.content?.length).toBe(fullText.length);
    });

    it('sliding window updates as additional tokens arrive while exceeding 3800 chars', async () => {
      const transport = new FakeLarkTransport();
      await transport.start();

      const initialMassive = 'x'.repeat(4000);
      const events: Array<{
        rowId: number;
        type: 'assistant_delta' | 'assistant_stream_end' | 'turn_status';
        delta?: string;
        streamId?: string;
      }> = [
        { rowId: 1, type: 'assistant_delta', delta: initialMassive, streamId: 's1' },
      ];

      const fakeSource: StreamEventSource = {
        listAssistantEvents: vi.fn().mockImplementation(async (_routeId, afterRowId) => {
          return events.filter((e) => e.rowId > afterRowId);
        }),
      };

      const tracker = new StreamingReplyTracker({
        transport,
        streamEventSource: fakeSource,
        sessionRouteId: 'session_sliding_test',
        cardParams: { chatId: 'oc_test' },
        pollIntervalMs: 50,
      });

      tracker.start();
      await vi.advanceTimersByTimeAsync(0);

      let pushes = transport.streamingCalls.filter((c) => c.type === 'push');
      expect(pushes.length).toBe(1);
      expect(pushes[0].content!.length).toBe(STREAMING_MAX_CONTENT_LENGTH);

      // Push additional new token
      events.push({ rowId: 2, type: 'assistant_delta', delta: ' [NEW_STREAM_TOKEN_123]', streamId: 's1' });
      await vi.advanceTimersByTimeAsync(50);

      pushes = transport.streamingCalls.filter((c) => c.type === 'push');
      expect(pushes.length).toBe(2);
      expect(pushes[1].content!.length).toBe(STREAMING_MAX_CONTENT_LENGTH);
      // Newest token is visible in sliding window
      expect(pushes[1].content!.endsWith('[NEW_STREAM_TOKEN_123]')).toBe(true);

      tracker.stop();
    });
  });

  describe('Integration with CredentialedLarkTransport & CardKit (Offline Mock)', () => {
    it('pushes <= 3800 payload to cardElement.content and finalizes with multiple chunked elements', async () => {
      const cardElementCalls: any[] = [];
      const cardUpdateCalls: any[] = [];

      const mockApiClient: ILarkApiClient = {
        cardkit: {
          v1: {
            card: {
              create: async () => ({ code: 0, data: { card_id: 'crd_c1_test' } }),
              settings: async () => ({ code: 0, data: {} }),
              update: async (payload: any) => {
                cardUpdateCalls.push(payload);
                return { code: 0, data: {} };
              },
            },
            cardElement: {
              content: async (payload: any) => {
                cardElementCalls.push(payload);
                return { code: 0, data: {} };
              },
            },
          },
        },
        im: {
          message: {
            reply: async () => ({ code: 0, data: { message_id: 'om_c1_msg' } }),
            create: async () => ({ code: 0, data: { message_id: 'om_c1_msg' } }),
            patch: async () => ({ code: 0, data: {} }),
          },
        },
      };

      const transport = new CredentialedLarkTransport({
        account: {
          id: 'acc_c1_test',
          userId: 'usr_c1',
          appId: 'cli_mock_c1',
          appSecret: 'sec_mock_c1',
          brand: 'feishu',
        },
        clientFactory: {
          createClient: () => mockApiClient,
        },
      });

      await transport.start();

      const long5000Text = Array.from({ length: 50 }, (_, i) => `Paragraph ${i + 1}: ${'z'.repeat(90)}`).join('\n\n');
      expect(long5000Text.length).toBeGreaterThan(5000);

      const events = [
        { rowId: 1, type: 'assistant_delta' as const, delta: long5000Text, streamId: 's1' },
      ];

      const fakeSource: StreamEventSource = {
        listAssistantEvents: async () => events,
      };

      const tracker = new StreamingReplyTracker({
        transport,
        streamEventSource: fakeSource,
        sessionRouteId: 'session_cred_transport',
        cardParams: {
          chatId: 'oc_real_c1',
          title: 'C1 Report',
        },
        pollIntervalMs: 50,
      });

      tracker.start();

      // Wait a tick for async card creation and delta push
      await new Promise((r) => setTimeout(r, 150));

      // Verify cardElement.content payload length <= 3800
      expect(cardElementCalls.length).toBeGreaterThan(0);
      for (const call of cardElementCalls) {
        expect(call.data.content.length).toBeLessThanOrEqual(STREAMING_MAX_CONTENT_LENGTH);
        expect(call.data.content.length).toBe(STREAMING_MAX_CONTENT_LENGTH);
      }

      // Finalize
      await tracker.finalize(long5000Text, 'completed');

      // Verify final card update contains chunked elements (chunkMarkdown <= 4000 each)
      expect(cardUpdateCalls.length).toBe(1);
      const updatePayload = cardUpdateCalls[0];
      const parsedCard = JSON.parse(updatePayload.data.card.data);
      const elements = parsedCard.body.elements;

      // Must be split into at least 2 markdown elements for >5000 chars
      expect(elements.length).toBeGreaterThanOrEqual(2);
      for (const el of elements) {
        expect(el.tag).toBe('markdown');
        expect(el.content.length).toBeLessThanOrEqual(4000);
      }

      // Full text is preserved across all chunks
      const combinedText = elements.map((el: any) => el.content).join('');
      expect(combinedText.includes('Paragraph 1:')).toBe(true);
      expect(combinedText.includes('Paragraph 50:')).toBe(true);

      await transport.stop();
    });
  });
});
