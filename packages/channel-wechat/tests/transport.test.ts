import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  CredentialedWeChatTransport,
  classifyWeChatConnectionError,
  createWeChatTransport,
  jitteredWeChatRetryDelay,
  splitTextChunks,
  weChatConnectionErrorMessage,
  type WeChatConnectionState,
  type WeChatParsedMessage,
} from '../src/transport.js';

interface MockServerState {
  server: http.Server;
  url: string;
  requests: Array<{
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: Record<string, unknown>;
  }>;
  getUpdatesHandler?: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: Record<string, unknown>
  ) => void;
  sendMessageHandler?: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: Record<string, unknown>
  ) => void;
  getConfigHandler?: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: Record<string, unknown>
  ) => void;
  sendTypingHandler?: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: Record<string, unknown>
  ) => void;
}

function createMockServer(): Promise<MockServerState> {
  return new Promise((resolve) => {
    const state: MockServerState = {
      server: null as unknown as http.Server,
      url: '',
      requests: [],
    };

    const server = http.createServer((req, res) => {
      let bodyData = '';
      req.on('data', (chunk) => {
        bodyData += chunk;
      });
      req.on('end', () => {
        let body: Record<string, unknown> = {};
        try {
          body = bodyData ? JSON.parse(bodyData) : {};
        } catch {
          // not json
        }

        state.requests.push({
          method: req.method || 'GET',
          url: req.url || '/',
          headers: req.headers,
          body,
        });

        if (req.url === '/ilink/bot/getupdates') {
          if (state.getUpdatesHandler) {
            state.getUpdatesHandler(req, res, body);
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: 'cursor_default' }));
          return;
        }

        if (req.url === '/ilink/bot/sendmessage') {
          if (state.sendMessageHandler) {
            state.sendMessageHandler(req, res, body);
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ret: 0 }));
          return;
        }

        if (req.url === '/ilink/bot/getconfig') {
          if (state.getConfigHandler) {
            state.getConfigHandler(req, res, body);
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ret: 0, typing_ticket: 'ticket_mock_123' }));
          return;
        }

        if (req.url === '/ilink/bot/sendtyping') {
          if (state.sendTypingHandler) {
            state.sendTypingHandler(req, res, body);
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ret: 0 }));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ret: -1, errmsg: 'Not found' }));
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      state.server = server;
      state.url = `http://127.0.0.1:${addr.port}`;
      resolve(state);
    });
  });
}

describe('CredentialedWeChatTransport Unit Tests', () => {
  test('classifyWeChatConnectionError maps error causes correctly', () => {
    const timeoutErr = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
    });
    expect(classifyWeChatConnectionError(timeoutErr)).toBe('connect_timeout');

    const resetErr = new Error('read ECONNRESET', {
      cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
    });
    expect(classifyWeChatConnectionError(resetErr)).toBe('connection_reset');

    const tlsErr = Object.assign(new Error('certificate has expired'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    expect(classifyWeChatConnectionError(tlsErr)).toBe('tls_error');

    const apiErr = Object.assign(new Error('api returned error'), { code: 'WECHAT_API_ERROR' });
    expect(classifyWeChatConnectionError(apiErr)).toBe('api_error');

    const reqTimeout = Object.assign(new Error('WeChat API timed out'), { code: 'WECHAT_REQUEST_TIMEOUT' });
    expect(classifyWeChatConnectionError(reqTimeout)).toBe('request_timeout');
  });

  test('weChatConnectionErrorMessage provides user-friendly localized messages', () => {
    expect(weChatConnectionErrorMessage('connect_timeout')).toContain('连接微信服务超时');
    expect(weChatConnectionErrorMessage('request_timeout')).toContain('微信长轮询暂时无响应');
    expect(weChatConnectionErrorMessage('connection_reset')).toContain('被中断');
    expect(weChatConnectionErrorMessage('tls_error')).toContain('TLS');
    expect(weChatConnectionErrorMessage('api_error')).toContain('微信服务返回异常');
    expect(weChatConnectionErrorMessage('network_error')).toContain('暂时无法访问微信服务');
  });

  test('jitteredWeChatRetryDelay applies +-20% jitter bounds', () => {
    expect(jitteredWeChatRetryDelay(3000, () => 0)).toBe(2400); // 3000 * 0.8
    expect(jitteredWeChatRetryDelay(3000, () => 0.5)).toBe(3000); // 3000 * 1.0
    expect(jitteredWeChatRetryDelay(3000, () => 1.0)).toBe(3600); // 3000 * 1.2
  });

  test('splitTextChunks splits long text gracefully across paragraph and punctuation boundaries', () => {
    const shortText = 'Hello world!';
    expect(splitTextChunks(shortText, 2000)).toEqual(['Hello world!']);

    // Long text with double newlines
    const p1 = 'A'.repeat(1200);
    const p2 = 'B'.repeat(1200);
    const combined = `${p1}\n\n${p2}`;
    const chunks = splitTextChunks(combined, 2000);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(p1);
    expect(chunks[1]).toBe(p2);

    // Hard boundary test without newlines
    const hardText = 'X'.repeat(4500);
    const hardChunks = splitTextChunks(hardText, 2000);
    expect(hardChunks.length).toBe(3);
    expect(hardChunks[0].length).toBe(2000);
    expect(hardChunks[1].length).toBe(2000);
    expect(hardChunks[2].length).toBe(500);
    expect(hardChunks.join('')).toBe(hardText);
  });
});

describe('CredentialedWeChatTransport Integration with Mock HTTP Server', () => {
  let mockServer: MockServerState;

  beforeEach(async () => {
    mockServer = await createMockServer();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      mockServer.server.close(() => resolve());
    });
  });

  test('1. 正常长轮询与消息下发 (Normal long-poll, message dispatch, and outbound reply)', async () => {
    const receivedMessages: WeChatParsedMessage[] = [];
    const committedCursors: string[] = [];
    const states: WeChatConnectionState[] = [];

    let pollCount = 0;
    mockServer.getUpdatesHandler = (_req, res, body) => {
      pollCount++;
      if (pollCount === 1) {
        expect(body.get_updates_buf).toBe('init_cursor_001');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ret: 0,
            get_updates_buf: 'cursor_v1',
            msgs: [
              {
                seq: 101,
                message_id: 202,
                from_user_id: 'wx_user_alice@im.user',
                to_user_id: 'bot_id@im.bot',
                message_type: 1, // USER
                context_token: 'ctx_alice_123',
                item_list: [{ type: 1, text_item: { text: 'Hello Enkeep' } }],
              },
            ],
          })
        );
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: 'cursor_v1' }));
      }
    };

    const transport = new CredentialedWeChatTransport({
      botToken: 'mock-bot-token-safe',
      ilinkBotId: 'mock-bot-id',
      baseUrl: mockServer.url,
      initialCursor: 'init_cursor_001',
    });

    transport.onMessage(async (msg) => {
      receivedMessages.push(msg);
    });
    transport.onCursorCommit((cursor) => {
      committedCursors.push(cursor);
    });
    transport.onStateChange((state) => {
      states.push(state);
    });

    await transport.start();
    expect(transport.running).toBe(true);

    // Wait for first poll to complete
    await vi.waitFor(() => {
      expect(receivedMessages.length).toBe(1);
    }, { timeout: 1500 });

    expect(receivedMessages[0]).toMatchObject({
      messageId: '202',
      senderId: 'wx_user_alice@im.user',
      text: 'Hello Enkeep',
      contextToken: 'ctx_alice_123',
      chatId: 'wechat:wx_user_alice@im.user',
    });

    expect(committedCursors).toContain('cursor_v1');
    expect(transport.cursor).toBe('cursor_v1');
    expect(transport.connected).toBe(true);
    expect(states.some((s) => s.status === 'connected')).toBe(true);

    // Verify outbound reply with protocol headers
    const sendResult = await transport.sendReply(
      'wx_user_alice@im.user',
      'ctx_alice_123',
      'Echo: Hello Enkeep'
    );
    expect(sendResult.success).toBe(true);
    expect(sendResult.messageId).toBeDefined();

    const sendReq = mockServer.requests.find((r) => r.url === '/ilink/bot/sendmessage');
    expect(sendReq).toBeDefined();
    expect(sendReq?.headers['authorization']).toBe('Bearer mock-bot-token-safe');
    expect(sendReq?.headers['authorizationtype']).toBe('ilink_bot_token');
    expect(sendReq?.headers['x-wechat-uin']).toBeDefined();
    expect(sendReq?.headers['ilink-app-id']).toBe('bot');
    expect(sendReq?.headers['ilink-app-clientversion']).toBe('131329');

    await transport.stop();
    expect(transport.running).toBe(false);
    expect(transport.connected).toBe(false);
  });

  test('2. 游标提交滞后验证（未消费不提交） (At-least-once: cursor must NOT advance if consumer fails)', async () => {
    let pollAttempts = 0;
    mockServer.getUpdatesHandler = (_req, res, body) => {
      pollAttempts++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ret: 0,
          get_updates_buf: 'cursor_v2_failing',
          msgs: [
            {
              seq: 999,
              from_user_id: 'fault_user@im.user',
              item_list: [{ type: 1, text_item: { text: 'crash me' } }],
            },
          ],
        })
      );
    };

    const committedCursors: string[] = [];
    const transport = new CredentialedWeChatTransport(
      {
        botToken: 'mock-token',
        ilinkBotId: 'mock-bot',
        baseUrl: mockServer.url,
        initialCursor: 'cursor_stable_v1',
      },
      {
        // Speed up retry delay for test
        sleep: async () => {},
      }
    );

    transport.onMessage(async (msg) => {
      if (msg.text === 'crash me') {
        throw new Error('Business database transaction failed');
      }
    });
    transport.onCursorCommit((cursor) => {
      committedCursors.push(cursor);
    });

    await transport.start();

    await vi.waitFor(() => {
      expect(pollAttempts).toBeGreaterThanOrEqual(1);
    }, { timeout: 1500 });

    // Cursor must NOT have committed to cursor_v2_failing
    expect(committedCursors).not.toContain('cursor_v2_failing');
    expect(transport.cursor).toBe('cursor_stable_v1');

    await transport.stop();
  });

  test('3. -14 错误触发 expired 状态并安全跳出 (ERRCODE_SESSION_EXPIRED halts poller immediately)', async () => {
    let pollCount = 0;
    mockServer.getUpdatesHandler = (_req, res) => {
      pollCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ret: -14, errmsg: 'session expired or logged out on phone' }));
    };

    const states: WeChatConnectionState[] = [];
    const transport = new CredentialedWeChatTransport({
      botToken: 'expired-token',
      ilinkBotId: 'bot-id',
      baseUrl: mockServer.url,
    });

    transport.onStateChange((s) => states.push(s));
    await transport.start();

    await vi.waitFor(() => {
      expect(states.some((s) => s.status === 'expired')).toBe(true);
    }, { timeout: 1500 });

    const expiredState = states.find((s) => s.status === 'expired');
    expect(expiredState?.error).toContain('微信授权已过期，请重新扫码连接');
    expect(transport.running).toBe(false);
    expect(transport.connected).toBe(false);

    // Verify polling stopped and does NOT retry
    const countSnapshot = pollCount;
    await new Promise((r) => setTimeout(r, 100));
    expect(pollCount).toBe(countSnapshot);

    await transport.stop();
  });

  test('4. 模拟网络错误与指数抖动重试 (Simulate network errors and recovery)', async () => {
    let pollCount = 0;
    mockServer.getUpdatesHandler = (_req, res) => {
      pollCount++;
      if (pollCount === 1) {
        // Return 500 error first
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Gateway Error');
        return;
      }
      // Recover on subsequent poll
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: 'cursor_recovered' }));
    };

    const states: WeChatConnectionState[] = [];
    let customSleepCalled = false;

    const transport = new CredentialedWeChatTransport(
      {
        botToken: 'retry-token',
        ilinkBotId: 'bot-id',
        baseUrl: mockServer.url,
      },
      {
        sleep: async (ms) => {
          customSleepCalled = true;
          expect(ms).toBeGreaterThanOrEqual(1000);
        },
      }
    );

    transport.onStateChange((s) => states.push(s));
    await transport.start();

    await vi.waitFor(() => {
      expect(states.some((s) => s.status === 'reconnecting')).toBe(true);
      expect(states.some((s) => s.status === 'connected')).toBe(true);
    }, { timeout: 1500 });

    const reconnectingState = states.find((s) => s.status === 'reconnecting');
    expect(reconnectingState).toBeDefined();
    expect(reconnectingState?.consecutiveFailures).toBe(1);
    expect(customSleepCalled).toBe(true);

    await transport.stop();
  });

  test('5. 超过 2000 字符文本分段发送 (Outbound text chunking <= 2000 chars)', async () => {
    const transport = new CredentialedWeChatTransport({
      botToken: 'token',
      ilinkBotId: 'bot-id',
      baseUrl: mockServer.url,
    });

    await transport.start();

    // Create 4500-char message with multiple paragraphs
    const paragraph1 = 'Paragraph 1: ' + 'A'.repeat(1500);
    const paragraph2 = 'Paragraph 2: ' + 'B'.repeat(1500);
    const paragraph3 = 'Paragraph 3: ' + 'C'.repeat(1400);
    const longText = `${paragraph1}\n\n${paragraph2}\n\n${paragraph3}`;

    const outboundRequests: Array<Record<string, unknown>> = [];
    mockServer.sendMessageHandler = (_req, res, body) => {
      outboundRequests.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ret: 0 }));
    };

    const res = await transport.sendReply('recipient_user', 'ctx_tok_456', longText);
    expect(res.success).toBe(true);

    expect(outboundRequests.length).toBe(3);
    for (const req of outboundRequests) {
      const msg = req.msg as Record<string, unknown>;
      const itemList = msg.item_list as Array<Record<string, unknown>>;
      const textItem = itemList[0].text_item as { text: string };
      expect(textItem.text.length).toBeLessThanOrEqual(2000);
    }

    await transport.stop();
  });

  test('6. 单轮询器防重复启动保护 (Single-poller concurrency protection)', async () => {
    let getUpdatesRequests = 0;
    mockServer.getUpdatesHandler = (_req, res) => {
      getUpdatesRequests++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: 'c' }));
    };

    const transport = new CredentialedWeChatTransport({
      botToken: 'token',
      ilinkBotId: 'bot-id',
      baseUrl: mockServer.url,
    });

    await transport.start();
    const initialRunning = transport.running;
    expect(initialRunning).toBe(true);

    // Call start() multiple times concurrently
    await Promise.all([transport.start(), transport.start(), transport.start()]);

    await vi.waitFor(() => {
      expect(getUpdatesRequests).toBeGreaterThanOrEqual(1);
    }, { timeout: 1500 });

    // Only one polling loop should be active
    expect(transport.running).toBe(true);

    await transport.stop();
  });

  test('7. 输入态指示器 (Typing indicator sendTyping)', async () => {
    let getConfigCalled = false;
    let sendTypingCalled = false;

    mockServer.getConfigHandler = (_req, res, body) => {
      getConfigCalled = true;
      expect(body.ilink_user_id).toBe('user_bob');
      expect(body.context_token).toBe('ctx_bob');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ret: 0, typing_ticket: 'ticket_for_bob' }));
    };

    mockServer.sendTypingHandler = (_req, res, body) => {
      sendTypingCalled = true;
      expect(body.ilink_user_id).toBe('user_bob');
      expect(body.typing_ticket).toBe('ticket_for_bob');
      expect(body.status).toBe(1); // 1 = typing
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ret: 0 }));
    };

    const transport = createWeChatTransport({
      botToken: 'token',
      ilinkBotId: 'bot-id',
      baseUrl: mockServer.url,
    });

    await transport.sendTyping('user_bob', 'ctx_bob', true);
    expect(getConfigCalled).toBe(true);
    expect(sendTypingCalled).toBe(true);
  });
});
