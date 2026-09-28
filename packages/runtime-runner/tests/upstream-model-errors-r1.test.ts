import { describe, it, expect, vi } from 'vitest';
import { PassThrough, Duplex } from 'node:stream';
import {
  LlmProxyHandler,
  extractTurnResultFromEvents,
  extractUpstreamErrorFromEvents,
  UpstreamModelError,
  parseDshConfigFiles,
  type SessionEvent,
} from '../src/index.js';

const FIXTURE_CORDIS = `
- id: llm-pi-ai
  config:
    providers:
      cpa-claude:
        displayName: Claude
        apiKeyEnv: CPA_TOKEN
        api: anthropic-messages
        baseURL: https://gw.example.com
        defaultContextWindow: 1000000
        defaultMaxTokens: 128000
        models:
          - id: claude-fable-5
`;

const FIXTURE_SETTINGS = `
agent-default-model:
  provider: cpa-claude
  model: claude-fable-5
`;

const FIXTURE_ENV = `
CPA_TOKEN=test-token-123
`;

describe('Upstream Model Transient Errors & Retry Backoff (R1)', () => {
  const config = parseDshConfigFiles(FIXTURE_CORDIS, FIXTURE_SETTINGS, FIXTURE_ENV, '/tmp/mock-dsh');

  it('retries 429 RATE_LIMIT with backoff up to 3 times before succeeding on 4th attempt', async () => {
    let attempts = 0;
    const delays: number[] = [];

    const mockFetch = vi.fn(async () => {
      attempts++;
      if (attempts <= 3) {
        return new Response(JSON.stringify({ error: { message: 'Rate limit exceeded', code: 'RATE_LIMIT' } }), {
          status: 429,
          statusText: 'Too Many Requests',
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('event: message_start\ndata: {}\n\nevent: message_stop\ndata: {}\n\n', {
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    const handler = new LlmProxyHandler({
      deploymentConfig: config,
      fetchImpl: mockFetch as unknown as typeof fetch,
      sleepFn: async (ms) => {
        delays.push(ms);
      },
    });

    const inStream = new PassThrough();
    const outStream = new PassThrough();
    const clientStream = Duplex.from({ readable: inStream, writable: outStream });

    const handlePromise = handler.handle(clientStream, { kind: 'llm' });
    inStream.write('POST /llm/cpa-claude/v1/messages HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nAuthorization: in-container\r\nContent-Length: 2\r\n\r\n{}');
    inStream.end();

    const chunks: Buffer[] = [];
    for await (const chunk of outStream) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    await handlePromise;

    expect(attempts).toBe(4); // 1 initial + 3 retries
    expect(delays.length).toBe(3);
    const resp = Buffer.concat(chunks).toString('utf8');
    expect(resp).toContain('HTTP/1.1 200 OK');
  });

  it('honors Retry-After header within cap on 429 response', async () => {
    let attempts = 0;
    const delays: number[] = [];

    const mockFetch = vi.fn(async () => {
      attempts++;
      if (attempts <= 1) {
        return new Response('{}', {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'retry-after': '2' },
        });
      }
      return new Response('event: message_stop\ndata: {}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    const handler = new LlmProxyHandler({
      deploymentConfig: config,
      fetchImpl: mockFetch as unknown as typeof fetch,
      sleepFn: async (ms) => {
        delays.push(ms);
      },
    });

    const inStream = new PassThrough();
    const outStream = new PassThrough();
    const clientStream = Duplex.from({ readable: inStream, writable: outStream });

    const handlePromise = handler.handle(clientStream, { kind: 'llm' });
    inStream.write('POST /llm/cpa-claude/v1/messages HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nAuthorization: in-container\r\nContent-Length: 2\r\n\r\n{}');
    inStream.end();

    for await (const _chunk of outStream) {}
    await handlePromise;

    expect(attempts).toBe(2);
    expect(delays.length).toBe(1);
    expect(delays[0]).toBe(2000); // 2 seconds from retry-after header
  });

  it('retries network error (fetchErr) up to 3 times and writes 502 after exhaustion', async () => {
    let attempts = 0;
    const delays: number[] = [];

    const mockFetch = vi.fn(async () => {
      attempts++;
      throw new Error('connect ECONNREFUSED 127.0.0.1:443');
    });

    const handler = new LlmProxyHandler({
      deploymentConfig: config,
      fetchImpl: mockFetch as unknown as typeof fetch,
      sleepFn: async (ms) => {
        delays.push(ms);
      },
    });

    const inStream = new PassThrough();
    const outStream = new PassThrough();
    const clientStream = Duplex.from({ readable: inStream, writable: outStream });

    const handlePromise = handler.handle(clientStream, { kind: 'llm' });
    inStream.write('POST /llm/cpa-claude/v1/messages HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nAuthorization: in-container\r\nContent-Length: 2\r\n\r\n{}');
    inStream.end();

    const chunks: Buffer[] = [];
    for await (const chunk of outStream) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    await handlePromise;

    expect(attempts).toBe(4); // 1 initial + 3 retries
    expect(delays.length).toBe(3);
    const resp = Buffer.concat(chunks).toString('utf8');
    expect(resp).toContain('HTTP/1.1 502 Bad Gateway');
    expect(resp).toContain('upstream_fetch_error');
  });

  it('does NOT retry when partial stream bytes have already been sent to client', async () => {
    let attempts = 0;

    const mockFetch = vi.fn(async () => {
      attempts++;
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode('event: message_start\ndata: {}\n\n'));
          // Mid-stream error
          controller.error(new Error('Network socket disconnected mid-stream'));
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    const handler = new LlmProxyHandler({
      deploymentConfig: config,
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const inStream = new PassThrough();
    const outStream = new PassThrough();
    const clientStream = Duplex.from({ readable: inStream, writable: outStream });
    clientStream.on('error', () => {});
    outStream.on('error', () => {});

    const handlePromise = handler.handle(clientStream, { kind: 'llm' });
    inStream.write('POST /llm/cpa-claude/v1/messages HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nAuthorization: in-container\r\nContent-Length: 2\r\n\r\n{}');
    inStream.end();

    const received: Buffer[] = [];
    outStream.on('data', (chunk) => {
      received.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });

    await handlePromise;

    // Must NOT replay/retry after partial stream
    expect(attempts).toBe(1);
    expect(Buffer.concat(received).toString('utf8')).toContain('HTTP/1.1 200 OK');
  });

  it('fails fast on 401 Unauthorized without retrying', async () => {
    let attempts = 0;

    const mockFetch = vi.fn(async () => {
      attempts++;
      return new Response(JSON.stringify({ error: { message: 'Invalid API key', type: 'authentication_error' } }), {
        status: 401,
        statusText: 'Unauthorized',
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const handler = new LlmProxyHandler({
      deploymentConfig: config,
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const inStream = new PassThrough();
    const outStream = new PassThrough();
    const clientStream = Duplex.from({ readable: inStream, writable: outStream });

    const handlePromise = handler.handle(clientStream, { kind: 'llm' });
    inStream.write('POST /llm/cpa-claude/v1/messages HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nAuthorization: in-container\r\nContent-Length: 2\r\n\r\n{}');
    inStream.end();

    for await (const _chunk of outStream) {}
    await handlePromise;

    expect(attempts).toBe(1);
  });
});

describe('dsh-boot Upstream Error Class Preservation', () => {
  it('extractTurnResultFromEvents extracts upstreamError from turn/end event', () => {
    const events: SessionEvent[] = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
      {
        type: 'assistant/chunk',
        data: {
          turn: 1,
          step: 1,
          chunk: {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: {
                message: '502 {"error":{"message":"Upstream returned status 502","type":"invalid_request_error","code":"upstream_transient_error"}}',
                code: 'INVALID_REQUEST',
              },
            },
          },
        },
      },
      { type: 'step/end', data: { turn: 1, step: 1 } },
      {
        type: 'turn/end',
        data: {
          turn: 1,
          reason: {
            kind: 'error',
            error: {
              message: '502 {"error":{"message":"Upstream returned status 502","type":"invalid_request_error","code":"upstream_transient_error"}}',
              code: 'INVALID_REQUEST',
            },
          },
        },
      },
    ] as any;

    const result = extractTurnResultFromEvents(events, 0);
    expect(result.replyText).toBe('');
    expect(result.isCancelled).toBe(false);
    expect(result.upstreamError).toBeDefined();
    expect(result.upstreamError?.statusCode).toBe(502);
    expect(result.upstreamError?.code).toBe('INVALID_REQUEST');
  });

  it('extractTurnResultFromEvents extracts 429 RATE_LIMIT correctly', () => {
    const events: SessionEvent[] = [
      { type: 'turn/start', data: { turn: 2 } },
      {
        type: 'turn/end',
        data: {
          turn: 2,
          reason: {
            kind: 'error',
            error: {
              message: '429 {"error":{"message":"Upstream returned status 429","type":"invalid_request_error","code":"upstream_transient_error"}}',
              code: 'RATE_LIMIT',
            },
          },
        },
      },
    ] as any;

    const result = extractTurnResultFromEvents(events, 0);
    expect(result.upstreamError?.statusCode).toBe(429);
    expect(result.upstreamError?.code).toBe('RATE_LIMIT');
  });

  it('extractUpstreamErrorFromEvents extracts error from earlier chunk if turn/end omitted', () => {
    const events: SessionEvent[] = [
      {
        type: 'assistant/chunk',
        data: {
          turn: 1,
          step: 1,
          chunk: {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: {
                message: 'Upstream gateway request failed (status 503)',
                code: 'UPSTREAM_ERROR',
              },
            },
          },
        },
      },
    ] as any;

    const extracted = extractUpstreamErrorFromEvents(events);
    expect(extracted).toBeDefined();
    expect(extracted?.statusCode).toBe(503);
    expect(extracted?.code).toBe('UPSTREAM_ERROR');
  });

  it('UpstreamModelError retains name, code, and statusCode properties', () => {
    const err = new UpstreamModelError('Rate limited by upstream provider', {
      code: 'RATE_LIMIT',
      statusCode: 429,
    });
    expect(err.name).toBe('UpstreamModelError');
    expect(err.code).toBe('RATE_LIMIT');
    expect(err.statusCode).toBe(429);
    expect(err.message).toBe('Rate limited by upstream provider');
  });
});
