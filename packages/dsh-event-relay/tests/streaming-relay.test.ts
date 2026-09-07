import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { Session, type SessionEvent } from '@deepseek-ai/dsh-session';
import { EventRelayService } from '../src/service.js';

describe('EventRelayService Streaming & Batching Pipeline', () => {
  let ctx: Context;
  let mockPlatformClient: {
    request: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    ctx = new Context();
    mockPlatformClient = {
      request: vi.fn().mockResolvedValue({ status: 200, data: { success: true } }),
    };
    ctx.platformClient = mockPlatformClient as any;
  });

  it('maps DSH turn/start, assistant/chunk, tool/call, tool/result, and turn/end into typed platform streaming frames', async () => {
    const service = new EventRelayService(ctx, { batchIntervalMs: 25 });
    const session = { id: 'ses_00000000000000000000000000000001' } as Session;

    // 1. turn/start
    const ev1: SessionEvent = {
      type: 'turn/start',
      seq: 1,
      time: Date.now(),
      data: { turn: 1 },
    };
    service.ingest(session, ev1);

    // 2. assistant/chunk (thinking / reasoning-delta)
    const ev2: SessionEvent = {
      type: 'assistant/chunk',
      seq: 2,
      time: Date.now(),
      data: {
        turn: 1,
        step: 1,
        chunk: {
          type: 'reasoning-delta',
          text: 'Thinking about the problem...',
        } as any,
      },
    };
    service.ingest(session, ev2);

    // 3. assistant/chunk (text-delta)
    const ev3: SessionEvent = {
      type: 'assistant/chunk',
      seq: 3,
      time: Date.now(),
      data: {
        turn: 1,
        step: 1,
        chunk: {
          type: 'text-delta',
          text: 'Hello ',
        } as any,
      },
    };
    service.ingest(session, ev3);

    const ev4: SessionEvent = {
      type: 'assistant/chunk',
      seq: 4,
      time: Date.now(),
      data: {
        turn: 1,
        step: 1,
        chunk: {
          type: 'text-delta',
          text: 'world!',
        } as any,
      },
    };
    service.ingest(session, ev4);

    // 4. tool/call
    const ev5: SessionEvent = {
      type: 'tool/call',
      seq: 5,
      time: Date.now(),
      data: {
        turn: 1,
        step: 1,
        callId: 'call_1' as any,
        name: 'check_quota',
        arguments: '{"resource":"tokens"}',
      },
    };
    service.ingest(session, ev5);

    // 5. tool/result
    const ev6: SessionEvent = {
      type: 'tool/result',
      seq: 6,
      time: Date.now(),
      data: {
        turn: 1,
        step: 1,
        message: { content: 'quota ok' } as any,
      },
    };
    service.ingest(session, ev6);

    // 6. assistant/message
    const ev7: SessionEvent = {
      type: 'assistant/message',
      seq: 7,
      time: Date.now(),
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'msg_1' as any,
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello world!' }],
          source: { kind: 'model', provider: 'demo', model: 'demo' },
        },
      },
    };
    service.ingest(session, ev7);

    // 7. turn/end
    const ev8: SessionEvent = {
      type: 'turn/end',
      seq: 8,
      time: Date.now(),
      data: {
        turn: 1,
        reason: { kind: 'completed' },
      },
    };
    service.ingest(session, ev8);

    // Explicit flush
    await service.flush();

    expect(mockPlatformClient.request).toHaveBeenCalled();
    const calls = mockPlatformClient.request.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);

    const firstCall = calls[0];
    expect(firstCall[0]).toBe('/api/events');
    expect(firstCall[1].method).toBe('POST');

    const batchedEvents = firstCall[1].body.events;
    expect(Array.isArray(batchedEvents)).toBe(true);

    const types = batchedEvents.map((e: any) => e.type);
    expect(types).toContain('turn_started');
    expect(types).toContain('thinking_delta');
    expect(types).toContain('assistant_delta');
    expect(types).toContain('tool_started');
    expect(types).toContain('tool_completed');
    expect(types).toContain('assistant_stream_end');
    expect(types).toContain('turn_completed');

    // Verify streamId format and accumulatedLength
    const deltas = batchedEvents.filter((e: any) => e.type === 'assistant_delta');
    expect(deltas.length).toBe(2);
    expect(deltas[0].payload.streamId).toMatch(/^msgstream_[0-9a-f]{32}$/);
    expect(deltas[0].payload.delta).toBe('Hello ');
    expect(deltas[0].payload.accumulatedLength).toBe(6);

    expect(deltas[1].payload.streamId).toBe(deltas[0].payload.streamId);
    expect(deltas[1].payload.delta).toBe('world!');
    expect(deltas[1].payload.accumulatedLength).toBe(12);

    // Verify tool payload does not leak arguments
    const toolStarted = batchedEvents.find((e: any) => e.type === 'tool_started');
    expect(toolStarted.payload.toolName).toBe('check_quota');
    expect(toolStarted.payload.arguments).toBeUndefined();

    // Verify diagnostics recorded clean flush count
    const diag = service.getDiagnostics();
    expect(diag.flushCount).toBeGreaterThanOrEqual(1);
    expect(diag.flushFailureCount).toBe(0);

    service.clear();
  });

  it('enforces 256KB backpressure cap by dropping intermediate deltas without dropping control events', async () => {
    const service = new EventRelayService(ctx, {
      maxPendingBytes: 1024, // Small 1KB limit for testing
      batchIntervalMs: 50,
    });
    const session = { id: 'ses_backpressure_test_0000000001' } as Session;

    // Ingest turn start
    service.ingest(session, {
      type: 'turn/start',
      seq: 1,
      time: Date.now(),
      data: { turn: 1 },
    });

    // Ingest huge flood of text deltas (exceeding 1KB)
    for (let i = 0; i < 50; i++) {
      service.ingest(session, {
        type: 'assistant/chunk',
        seq: 2 + i,
        time: Date.now(),
        data: {
          turn: 1,
          step: 1,
          chunk: {
            type: 'text-delta',
            text: `chunk_${i}_` + 'x'.repeat(100),
          } as any,
        },
      });
    }

    // Ingest terminal turn/end
    service.ingest(session, {
      type: 'turn/end',
      seq: 100,
      time: Date.now(),
      data: {
        turn: 1,
        reason: { kind: 'completed' },
      },
    });

    await service.flush();

    expect(mockPlatformClient.request).toHaveBeenCalled();
    const allDispatchedEvents = mockPlatformClient.request.mock.calls.flatMap((c) => c[1].body.events);

    // Control events MUST be preserved
    const turnStarts = allDispatchedEvents.filter((e) => e.type === 'turn_started');
    const turnEnds = allDispatchedEvents.filter((e) => e.type === 'turn_completed');
    expect(turnStarts.length).toBe(1);
    expect(turnEnds.length).toBe(1);

    // Total dispatched deltas should be bounded (some intermediate deltas dropped)
    const deltas = allDispatchedEvents.filter((e) => e.type === 'assistant_delta');
    expect(deltas.length).toBeLessThan(50);

    const diag = service.getDiagnostics();
    expect(diag.droppedDeltaCount).toBeGreaterThan(0);

    service.clear();
  });

  it('records flush failures in diagnostics without throwing or blocking LLM turn on intermediate deltas', async () => {
    mockPlatformClient.request.mockRejectedValue(new Error('Network down'));
    const service = new EventRelayService(ctx, { batchIntervalMs: 20 });
    const session = { id: 'ses_network_failure_test_00001' } as Session;

    expect(() => {
      service.ingest(session, {
        type: 'turn/start',
        seq: 1,
        time: Date.now(),
        data: { turn: 1 },
      });

      service.ingest(session, {
        type: 'assistant/chunk',
        seq: 2,
        time: Date.now(),
        data: {
          turn: 1,
          step: 1,
          chunk: { type: 'text-delta', text: 'hi' } as any,
        },
      });
    }).not.toThrow();

    await service.flush();

    const diag = service.getDiagnostics();
    expect(diag.flushFailureCount).toBeGreaterThan(0);
    expect(diag.lastFlushErrorCode).toBe('FLUSH_ERROR');
    expect(diag.lastFlushErrorMessage).toContain('Network down');

    service.clear();
  });
});
