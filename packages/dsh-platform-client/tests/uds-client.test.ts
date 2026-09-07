import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  DshPlatformClient,
  ClientConnectionError,
  ClientHttpError,
  ClientResponseTooLargeError,
  ClientTimeoutError,
} from '../src/index.js';
import {
  ProtocolHeaders,
  ProtocolErrorCode,
  createErrorEnvelope,
  createSuccessEnvelope,
  makeRequestId,
} from '@enkeep/protocol';

describe('DshPlatformClient HTTP-over-UDS Integration Tests', () => {
  let server: http.Server | null = null;
  let socketPath: string;

  beforeEach(() => {
    // macOS has a 104-char limit for UDS paths. Using /tmp with a short random name guarantees < 50 chars.
    const randomId = crypto.randomBytes(6).toString('hex');
    socketPath = path.join('/tmp', `dsh-test-${randomId}.sock`);

    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server!.close(() => resolve());
      });
      server = null;
    }
    if (fs.existsSync(socketPath)) {
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // ignore
      }
    }
  });

  function startServer(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      server = http.createServer(handler);
      server.on('error', reject);
      server.listen(socketPath, () => resolve());
    });
  }

  it('performs basic GET, POST, PUT, DELETE requests over UDS', async () => {
    await startServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (req.method === 'GET' && url.pathname === '/items') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ items: ['a', 'b', 'c'] }));
        } else if (req.method === 'POST' && url.pathname === '/items') {
          const parsed = JSON.parse(body);
          res.statusCode = 201;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ created: parsed.name }));
        } else if (req.method === 'PUT' && url.pathname === '/items/1') {
          const parsed = JSON.parse(body);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ updated: true, name: parsed.name }));
        } else if (req.method === 'PATCH' && url.pathname === '/items/1') {
          const parsed = JSON.parse(body);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ patched: true, name: parsed.name }));
        } else if (req.method === 'DELETE' && url.pathname === '/items/1') {
          res.statusCode = 204;
          res.end();
        } else {
          res.statusCode = 404;
          res.end();
        }
      });
    });

    const client = new DshPlatformClient({ socketPath });

    // GET
    const getRes = await client.get<{ items: string[] }>('/items');
    expect(getRes.status).toBe(200);
    expect(getRes.data.items).toEqual(['a', 'b', 'c']);

    // POST
    const postRes = await client.post<{ created: string }>('/items', { name: 'new-item' });
    expect(postRes.status).toBe(201);
    expect(postRes.data.created).toBe('new-item');

    // PUT
    const putRes = await client.put<{ updated: boolean; name: string }>('/items/1', {
      name: 'modified',
    });
    expect(putRes.status).toBe(200);
    expect(putRes.data.updated).toBe(true);

    // PATCH
    const patchRes = await client.patch<{ patched: boolean; name: string }>('/items/1', {
      name: 'patched',
    });
    expect(patchRes.status).toBe(200);
    expect(patchRes.data.patched).toBe(true);

    // DELETE
    const delRes = await client.delete('/items/1');
    expect(delRes.status).toBe(204);
  });

  it('correctly handles query parameters', async () => {
    let capturedUrl: string | undefined;

    await startServer((req, res) => {
      capturedUrl = req.url;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });

    const client = new DshPlatformClient({ socketPath });
    await client.get('/search', {
      query: {
        q: 'hello world',
        page: 2,
        active: true,
        ignored: undefined,
      },
    });

    expect(capturedUrl).toBe('/search?q=hello+world&page=2&active=true');
  });

  it('validates socketPath in constructor', () => {
    expect(() => new DshPlatformClient({ socketPath: '' })).toThrow(TypeError);
    expect(() => new DshPlatformClient({ socketPath: null as any })).toThrow(TypeError);
  });

  it('passes Bearer Token with static string and dynamic async token function', async () => {
    let capturedAuth: string | undefined;

    await startServer((req, res) => {
      capturedAuth = req.headers['authorization'];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });

    // Static token
    const clientStatic = new DshPlatformClient({
      socketPath,
      bearerToken: 'static-secret-token',
    });
    await clientStatic.get('/auth-test');
    expect(capturedAuth).toBe('Bearer static-secret-token');

    // Dynamic token provider
    let tokenCounter = 1;
    const clientDynamic = new DshPlatformClient({
      socketPath,
      bearerToken: async () => `dynamic-secret-${tokenCounter++}`,
    });
    await clientDynamic.get('/auth-test');
    expect(capturedAuth).toBe('Bearer dynamic-secret-1');

    await clientDynamic.get('/auth-test');
    expect(capturedAuth).toBe('Bearer dynamic-secret-2');
  });

  it('generates and propagates Request ID header', async () => {
    let capturedRequestId: string | undefined;

    await startServer((req, res) => {
      capturedRequestId = req.headers[ProtocolHeaders.REQUEST_ID] as string;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });

    const client = new DshPlatformClient({ socketPath });

    // Automatic UUID generation
    const res1 = await client.get('/test');
    expect(capturedRequestId).toBeDefined();
    expect(res1.requestId).toBe(capturedRequestId);

    // Custom explicit RequestId
    const customReqId = makeRequestId('custom-trace-id-1234');
    const res2 = await client.get('/test', { requestId: customReqId });
    expect(capturedRequestId).toBe('custom-trace-id-1234');
    expect(res2.requestId).toBe('custom-trace-id-1234');
  });

  it('parses server ErrorEnvelope into ClientHttpError', async () => {
    await startServer((req, res) => {
      res.statusCode = 403;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify(
          createErrorEnvelope({
            code: ProtocolErrorCode.FORBIDDEN,
            message: 'Container not authorized for this workspace',
            status: 403,
            details: [{ message: 'Missing workspace binding' }],
          })
        )
      );
    });

    const client = new DshPlatformClient({ socketPath });

    try {
      await client.get('/unauthorized-resource');
      expect.unreachable('Should have thrown ClientHttpError');
    } catch (err: any) {
      expect(err).toBeInstanceOf(ClientHttpError);
      expect(err.status).toBe(403);
      expect(err.code).toBe(ProtocolErrorCode.FORBIDDEN);
      expect(err.message).toBe('Container not authorized for this workspace');
      expect(err.details).toHaveLength(1);
    }
  });

  it('enforces request timeout', async () => {
    await startServer((req, res) => {
      // Deliberately delay response past client timeout
      setTimeout(() => {
        res.end('delayed');
      }, 300);
    });

    const client = new DshPlatformClient({ socketPath, timeoutMs: 50, maxRetries: 0 });

    await expect(client.get('/timeout-test')).rejects.toThrow(ClientTimeoutError);
  });

  it('enforces maximum response body size limits', async () => {
    await startServer((req, res) => {
      res.setHeader('content-type', 'text/plain');
      // Send 50KB in chunks
      res.write('a'.repeat(25 * 1024));
      setTimeout(() => {
        res.write('b'.repeat(25 * 1024));
        res.end();
      }, 20);
    });

    const client = new DshPlatformClient({
      socketPath,
      maxResponseBodyBytes: 10 * 1024, // 10KB limit
    });

    await expect(client.get('/large-response')).rejects.toThrow(ClientResponseTooLargeError);
  });

  it('retries idempotent requests on transient 503 and succeeds after server recovers', async () => {
    let callCount = 0;

    await startServer((req, res) => {
      callCount++;
      if (callCount < 3) {
        res.statusCode = 503;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ message: 'Service initializing' }));
      } else {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, attempt: callCount }));
      }
    });

    const client = new DshPlatformClient({
      socketPath,
      maxRetries: 4,
      retryInitialDelayMs: 20,
      retryMaxDelayMs: 50,
    });

    // GET is idempotent -> should retry and succeed on 3rd attempt
    const res = await client.get<{ ok: boolean; attempt: number }>('/retry-test');
    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
    expect(res.data.attempt).toBe(3);
    expect(callCount).toBe(3);
  });

  it('does NOT retry non-idempotent POST requests on transient errors', async () => {
    let callCount = 0;

    await startServer((req, res) => {
      callCount++;
      res.statusCode = 503;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ message: 'Temporarily unavailable' }));
    });

    const client = new DshPlatformClient({
      socketPath,
      maxRetries: 3,
      retryInitialDelayMs: 20,
    });

    // POST is NOT idempotent by default -> should fail immediately without retrying
    await expect(client.post('/non-idempotent', { payload: 123 })).rejects.toThrow(
      ClientHttpError
    );

    expect(callCount).toBe(1);
  });

  it('retries POST when explicitly marked idempotent: true in options', async () => {
    let callCount = 0;

    await startServer((req, res) => {
      callCount++;
      if (callCount < 2) {
        res.statusCode = 502;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ message: 'Bad gateway' }));
      } else {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ success: true }));
      }
    });

    const client = new DshPlatformClient({
      socketPath,
      maxRetries: 3,
      retryInitialDelayMs: 20,
    });

    const res = await client.post<{ success: boolean }>(
      '/idempotent-post',
      { data: 'safe' },
      { idempotent: true }
    );

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(callCount).toBe(2);
  });

  it('throws ClientConnectionError when connecting to a non-existent socket', async () => {
    const nonExistentSocket = '/tmp/dsh-non-existent-12345.sock';
    const client = new DshPlatformClient({
      socketPath: nonExistentSocket,
      maxRetries: 0,
    });

    await expect(client.get('/health')).rejects.toThrow(ClientConnectionError);
  });

  it('aborts request when AbortSignal is triggered', async () => {
    await startServer((req, res) => {
      setTimeout(() => {
        res.end('done');
      }, 500);
    });

    const client = new DshPlatformClient({ socketPath });
    const controller = new AbortController();

    setTimeout(() => {
      controller.abort();
    }, 50);

    await expect(client.get('/abort-test', { signal: controller.signal })).rejects.toThrow(
      /aborted/i
    );
  });
});
