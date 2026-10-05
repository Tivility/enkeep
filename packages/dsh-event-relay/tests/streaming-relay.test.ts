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

  it('maps DSH turn/start, agent/assistant-stream, tool/call, tool/result, and turn/end into typed platform streaming frames', async () => {
    const service = new EventRelayService(ctx, { batchIntervalMs: 25 });
    const session = { id: 'ses_00000000000000000000000000000001' } as Session;
    const agentCtx = new Context();
    service.attachAgent(agentCtx);

    // 1. turn/start
    const ev1: SessionEvent = {
      type: 'turn/start',
      seq: 1,
      time: Date.now(),
      data: { turn: 1 },
    };
    service.ingest(session, ev1);

    // 2. agent/assistant-stream (start)
    agentCtx.emit('agent/assistant-stream', {
      agent: { session },
      frame: {
        type: 'start',
        turn: 1,
        step: 1,
      },
    });

    // 3. agent/assistant-stream (thinking / reasoning-delta)
    agentCtx.emit('agent/assistant-stream', {
      agent: { session },
      frame: {
        type: 'chunk',
        chunk: {
          type: 'reasoning-delta',
          text: 'Thinking about the problem...',
        },
      },
    });

    // 4. agent/assistant-stream (text-delta)
    agentCtx.emit('agent/assistant-stream', {
      agent: { session },
      frame: {
        type: 'chunk',
        chunk: {
          type: 'text-delta',
          text: 'Hello ',
        },
      },
    });

    agentCtx.emit('agent/assistant-stream', {
      agent: { session },
      frame: {
        type: 'chunk',
        chunk: {
          type: 'text-delta',
          text: 'world!',
        },
      },
    });

    // 5. agent/assistant-stream (end)
    agentCtx.emit('agent/assistant-stream', {
      agent: { session },
      frame: {
        type: 'end',
        outcome: {
          kind: 'committed',
          eventType: 'assistant/message',
          seq: 7,
        },
      },
    });

    // 6. tool/call
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

    // 7. tool/result
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

    // 8. assistant/message
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

    // 9. turn/end
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
    expect(types).toContain('reasoning_delta');
    expect(types).toContain('assistant_delta');
    expect(types).toContain('tool_started');
    expect(types).toContain('tool_completed');
    expect(types).toContain('assistant_stream_end');
    expect(types).toContain('turn_completed');

    // Verify reasoning_delta carries delta text and status without polluting assistant_delta
    const reasoningDelta = batchedEvents.find((e: any) => e.type === 'reasoning_delta');
    expect(reasoningDelta).toBeDefined();
    expect(reasoningDelta.payload.delta).toBe('Thinking about the problem...');
    expect(reasoningDelta.payload.status).toBe('thinking');
    expect(reasoningDelta.payload.accumulatedLength).toBe('Thinking about the problem...'.length);

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

    // Ingest huge flood of text deltas (exceeding 1KB) via agent/assistant-stream
    for (let i = 0; i < 50; i++) {
      service.ingestAssistantStream(session, {
        type: 'chunk',
        turn: 1,
        chunk: {
          type: 'text-delta',
          text: `chunk_${i}_` + 'x'.repeat(100),
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

      service.ingestAssistantStream(session, {
        type: 'chunk',
        turn: 1,
        chunk: { type: 'text-delta', text: 'hi' },
      });
    }).not.toThrow();

    await service.flush();

    const diag = service.getDiagnostics();
    expect(diag.flushFailureCount).toBeGreaterThan(0);
    expect(diag.lastFlushErrorCode).toBe('FLUSH_ERROR');
    expect(diag.lastFlushErrorMessage).toContain('Network down');

    service.clear();
  });

  it('re-queues batch and delivers subsequent frames when fake client first request never resolves', async () => {
    let callCount = 0;
    const requestCalls: any[] = [];
    mockPlatformClient.request = vi.fn().mockImplementation(async (_path: string, options: any) => {
      callCount++;
      requestCalls.push(options);
      if (callCount === 1) {
        // First request never resolves (simulating hang / stall)
        return new Promise(() => {});
      }
      return { status: 200, data: { success: true } };
    });

    const service = new EventRelayService(ctx, {
      flushTimeoutMs: 50,
      flushBackoffMs: 20,
      batchIntervalMs: 20,
    });
    const session = { id: 'ses_00000000000000000000000000000001' } as Session;

    // 1. Ingest first event
    service.ingest(session, {
      type: 'turn/start',
      seq: 1,
      time: Date.now(),
      data: { turn: 1 },
    });

    // Manually trigger flush; first request hangs and will time out in 50ms
    const flushPromise = service.flush();

    // 2. Ingest second event while first flush is in-flight / timed out
    service.ingest(session, {
      type: 'turn/end',
      seq: 2,
      time: Date.now(),
      data: { turn: 1, reason: { kind: 'completed' } },
    });

    await flushPromise;

    // Wait for backoff (20ms) and next flush
    await new Promise((r) => setTimeout(r, 60));
    await service.flush();

    // Assert that the first request was called (and timed out)
    expect(callCount).toBeGreaterThanOrEqual(2);

    // Later frames (and re-queued frames) are delivered
    const secondCallEvents = requestCalls[1].body.events;
    const types = secondCallEvents.map((e: any) => e.type);
    expect(types).toContain('turn_started');
    expect(types).toContain('turn_completed');

    service.clear();
  });

  it('resolves tool name and call id for two interleaved tool calls of different names with results in reverse order', async () => {
    const service = new EventRelayService(ctx, { batchIntervalMs: 20 });
    const session = { id: 'ses_synthetic_interleaved_0000000001' } as Session;

    // 1. turn/start
    service.ingest(session, {
      type: 'turn/start',
      seq: 1,
      time: 100,
      data: { turn: 1 },
    });

    // 2. First tool call: web_search with callId call_search_01
    service.ingest(session, {
      type: 'tool/call',
      seq: 2,
      time: 101,
      data: {
        turn: 1,
        step: 1,
        callId: 'call_search_01' as any,
        name: 'web_search',
        arguments: '{"queries":["test"]}',
      },
    });

    // 3. Second interleaved tool call: bash with callId call_bash_02
    service.ingest(session, {
      type: 'tool/call',
      seq: 3,
      time: 102,
      data: {
        turn: 1,
        step: 2,
        callId: 'call_bash_02' as any,
        name: 'bash',
        arguments: '{"command":"ls"}',
      },
    });

    // 4. First result in reverse order: bash result arrives first
    service.ingest(session, {
      type: 'tool/result',
      seq: 4,
      time: 103,
      data: {
        turn: 1,
        step: 2,
        message: {
          role: 'tool',
          toolCallId: 'call_bash_02' as any,
          content: 'file1.txt\nfile2.txt',
        } as any,
      },
    });

    // 5. Second result in reverse order: web_search result arrives second
    service.ingest(session, {
      type: 'tool/result',
      seq: 5,
      time: 104,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          toolCallId: 'call_search_01' as any,
          content: 'search results',
        } as any,
      },
    });

    // 6. turn/end
    service.ingest(session, {
      type: 'turn/end',
      seq: 6,
      time: 105,
      data: { turn: 1, reason: { kind: 'completed' } },
    });

    await service.flush();

    expect(mockPlatformClient.request).toHaveBeenCalled();
    const calls = mockPlatformClient.request.mock.calls;
    const allEvents: any[] = calls.flatMap((c) => c[1].body.events);

    const startedFrames = allEvents.filter((e) => e.type === 'tool_started');
    const completedFrames = allEvents.filter((e) => e.type === 'tool_completed');

    expect(startedFrames).toHaveLength(2);
    expect(completedFrames).toHaveLength(2);

    // Verify started frames have correct toolName and callId
    expect(startedFrames[0].payload.toolName).toBe('web_search');
    expect(startedFrames[0].payload.callId).toBe('call_search_01');
    expect((startedFrames[0] as any).callId).toBe('call_search_01');

    expect(startedFrames[1].payload.toolName).toBe('bash');
    expect(startedFrames[1].payload.callId).toBe('call_bash_02');
    expect((startedFrames[1] as any).callId).toBe('call_bash_02');

    // Verify completed frames in order of receipt:
    // First completed frame was bash (call_bash_02)
    expect(completedFrames[0].payload.toolName).toBe('bash');
    expect(completedFrames[0].payload.status).toBe('completed');
    expect(completedFrames[0].payload.callId).toBe('call_bash_02');
    expect((completedFrames[0] as any).callId).toBe('call_bash_02');

    // Second completed frame was web_search (call_search_01)
    expect(completedFrames[1].payload.toolName).toBe('web_search');
    expect(completedFrames[1].payload.status).toBe('completed');
    expect(completedFrames[1].payload.callId).toBe('call_search_01');
    expect((completedFrames[1] as any).callId).toBe('call_search_01');

    service.clear();
  });

  it('resolves tool name and call id for two parallel subagent tool calls without falling back to phantom tool', async () => {
    const service = new EventRelayService(ctx, { batchIntervalMs: 20 });
    const session = { id: 'ses_synthetic_parallel_subagent_00000001' } as Session;

    service.ingest(session, {
      type: 'turn/start',
      seq: 1,
      time: 100,
      data: { turn: 1 },
    });

    service.ingest(session, {
      type: 'tool/call',
      seq: 2,
      time: 101,
      data: {
        turn: 1,
        step: 1,
        callId: 'call_subagent_01' as any,
        name: 'subagent',
        arguments: '{"task":"one"}',
      },
    });

    service.ingest(session, {
      type: 'tool/call',
      seq: 3,
      time: 102,
      data: {
        turn: 1,
        step: 1,
        callId: 'call_subagent_02' as any,
        name: 'subagent',
        arguments: '{"task":"two"}',
      },
    });

    service.ingest(session, {
      type: 'tool/result',
      seq: 4,
      time: 103,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          toolCallId: 'call_subagent_01' as any,
          content: 'started subagent ses_child_01',
        } as any,
      },
    });

    service.ingest(session, {
      type: 'tool/result',
      seq: 5,
      time: 104,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          toolCallId: 'call_subagent_02' as any,
          content: 'started subagent ses_child_02',
        } as any,
      },
    });

    service.ingest(session, {
      type: 'turn/end',
      seq: 6,
      time: 105,
      data: { turn: 1, reason: { kind: 'completed' } },
    });

    await service.flush();

    const calls = mockPlatformClient.request.mock.calls;
    const allEvents: any[] = calls.flatMap((c) => c[1].body.events);
    const completedFrames = allEvents.filter((e) => e.type === 'tool_completed');

    expect(completedFrames).toHaveLength(2);
    // Neither should have toolName === 'tool' (phantom tool bug)
    expect(completedFrames[0].payload.toolName).toBe('subagent');
    expect(completedFrames[0].payload.callId).toBe('call_subagent_01');
    expect(completedFrames[1].payload.toolName).toBe('subagent');
    expect(completedFrames[1].payload.callId).toBe('call_subagent_02');

    service.clear();
  });

  it('resolves tool name, call id, and error status for canonical DSH 0.2 tool/result structure', async () => {
    const service = new EventRelayService(ctx, { batchIntervalMs: 20 });
    const session = { id: 'ses_synthetic_dsh02_structure_00000001' } as Session;

    service.ingest(session, {
      type: 'turn/start',
      seq: 1,
      time: 100,
      data: { turn: 1 },
    });

    // 1. Tool call 1: read_file
    service.ingest(session, {
      type: 'tool/call',
      seq: 2,
      time: 101,
      data: {
        turn: 1,
        step: 1,
        callId: 'call_read_01' as any,
        name: 'read',
        arguments: '{"file_path":"test.txt"}',
      },
    });

    // 2. Tool call 2: bash
    service.ingest(session, {
      type: 'tool/call',
      seq: 3,
      time: 102,
      data: {
        turn: 1,
        step: 2,
        callId: 'call_bash_02' as any,
        name: 'bash',
        arguments: '{"command":"npm test"}',
      },
    });

    // 3. DSH 0.2 Canonical Tool result 1: success using message.source.callId and message.content[0].toolCallId
    service.ingest(session, {
      type: 'tool/result',
      seq: 4,
      time: 103,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'msg_res_01' as any,
          role: 'user',
          source: { kind: 'tool', callId: 'call_read_01' },
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call_read_01',
              content: [{ type: 'text', text: 'file content' }],
              isError: false,
            },
          ],
        } as any,
      },
    });

    // 4. DSH 0.2 Canonical Tool result 2: failure using content[0].isError
    service.ingest(session, {
      type: 'tool/result',
      seq: 5,
      time: 104,
      data: {
        turn: 1,
        step: 2,
        message: {
          id: 'msg_res_02' as any,
          role: 'user',
          source: { kind: 'tool', callId: 'call_bash_02' },
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call_bash_02',
              content: [{ type: 'text', text: 'command failed' }],
              isError: true,
            },
          ],
        } as any,
        error: { name: 'ProcessError', code: 'EXIT_1' },
      },
    });

    service.ingest(session, {
      type: 'turn/end',
      seq: 6,
      time: 105,
      data: { turn: 1, reason: { kind: 'completed' } },
    });

    await service.flush();

    const calls = mockPlatformClient.request.mock.calls;
    const allEvents: any[] = calls.flatMap((c) => c[1].body.events);
    const completedFrames = allEvents.filter((e) => e.type === 'tool_completed');

    expect(completedFrames).toHaveLength(2);
    expect(completedFrames[0].payload.toolName).toBe('read');
    expect(completedFrames[0].payload.callId).toBe('call_read_01');
    expect(completedFrames[0].payload.status).toBe('completed');

    expect(completedFrames[1].payload.toolName).toBe('bash');
    expect(completedFrames[1].payload.callId).toBe('call_bash_02');
    expect(completedFrames[1].payload.status).toBe('failed');

    service.clear();
  });
});
