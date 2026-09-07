import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import {
  DshPlatformClient,
  ClientHttpError,
  ClientTimeoutError,
  ClientConnectionError,
} from '../src/index.js';

describe('DshPlatformClient HTTP Loopback Transport Tests', () => {
  let server: http.Server;
  let serverPort: number;
  let receivedRequests: Array<{
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: string;
  }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        receivedRequests.push({
          method: req.method || 'GET',
          url: req.url || '/',
          headers: req.headers,
          body,
        });

        if (req.url?.startsWith('/platform/capabilities') || req.url === '/capabilities') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ success: true, capabilities: ['messages', 'files', 'tasks', 'quota'] }));
          return;
        }

        if (req.url?.startsWith('/platform/api/manage/quota/check') || req.url?.startsWith('/api/manage/quota/check')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              success: true,
              data: {
                allowed: true,
                usage: { tokens: 10, messages: 5, turns: 2, storage_bytes: 1024, api_calls: 3 },
                activeReservations: { tokens: 0, messages: 0, turns: 0, storage_bytes: 0, api_calls: 0 },
                limit: { tokens: 1000, messages: 100, turns: 50, storage_bytes: 1048576, api_calls: 500 },
                remaining: { tokens: 990, messages: 95, turns: 48, storage_bytes: 1047552, api_calls: 497 },
                resetAt: null,
              },
            })
          );
          return;
        }

        if (req.url?.startsWith('/platform/api/messages') || req.url === '/api/messages') {
          const parsed = body ? JSON.parse(body) : {};
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              success: true,
              messageId: 'msg_test123',
              recipient: parsed.recipient || 'user',
              timestamp: '2026-08-27T00:00:00.000Z',
            })
          );
          return;
        }

        if (req.url?.startsWith('/platform/api/files') || req.url === '/api/files') {
          const parsed = body ? JSON.parse(body) : {};
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              success: true,
              fileId: 'file_test123',
              path: parsed.path || 'file.txt',
              size: parsed.size || 10,
              recipient: parsed.recipient || 'user',
            })
          );
          return;
        }

        if (req.url?.startsWith('/platform/api/manage/tasks') || req.url === '/api/manage/tasks') {
          const parsed = body ? JSON.parse(body) : {};
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              success: true,
              data: {
                isIdempotentHit: false,
                task: {
                  id: 'task_0123456789abcdef0123456789abcdef',
                  title: parsed.title || 'Task',
                  status: 'pending',
                  priority: parsed.priority || 'medium',
                  dueDate: parsed.dueDate || null,
                  createdAt: '2026-08-27T00:00:00.000Z',
                },
              },
            })
          );
          return;
        }

        if (req.url === '/platform/timeout') {
          // Do not reply to trigger timeout
          return;
        }

        if (req.url === '/platform/error-500') {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Internal Server Error' } }));
          return;
        }

        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not Found' } }));
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        serverPort = typeof addr === 'object' && addr ? addr.port : 8787;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('performs GET /platform/capabilities handshake successfully', async () => {
    const client = new DshPlatformClient({
      baseURL: `http://127.0.0.1:${serverPort}/platform`,
    });

    const res = await client.get<{ success: boolean; capabilities: string[] }>('/capabilities');
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.capabilities).toContain('messages');
    expect(res.data.capabilities).toContain('quota');
  });

  it('performs POST /api/messages with JSON payload and parses response', async () => {
    const client = new DshPlatformClient({
      baseURL: `http://127.0.0.1:${serverPort}/platform`,
    });

    const res = await client.post<{ success: boolean; messageId: string }>('/api/messages', {
      recipient: 'ses_123',
      content: 'Hello World',
    });

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.messageId).toBe('msg_test123');
  });

  it('performs GET /api/manage/quota/check?metrics=all', async () => {
    const client = new DshPlatformClient({
      baseURL: `http://127.0.0.1:${serverPort}/platform`,
    });

    const res = await client.get<{ success: boolean; data: any }>('/api/manage/quota/check', {
      query: { metrics: 'all' },
    });

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data.allowed).toBe(true);
    expect(res.data.data.usage.tokens).toBe(10);
  });

  it('enforces request timeout on hanging endpoint', async () => {
    const client = new DshPlatformClient({
      baseURL: `http://127.0.0.1:${serverPort}/platform`,
      timeoutMs: 100,
    });

    await expect(client.get('/timeout')).rejects.toThrow(ClientTimeoutError);
  });

  it('converts HTTP 500 into ClientHttpError', async () => {
    const client = new DshPlatformClient({
      baseURL: `http://127.0.0.1:${serverPort}/platform`,
      maxRetries: 0,
    });

    await expect(client.get('/error-500')).rejects.toThrow(ClientHttpError);
  });

  it('throws ClientConnectionError when connecting to inactive port', async () => {
    const client = new DshPlatformClient({
      baseURL: 'http://127.0.0.1:49999/platform',
      timeoutMs: 500,
    });

    await expect(client.get('/capabilities')).rejects.toThrow(ClientConnectionError);
  });
});
