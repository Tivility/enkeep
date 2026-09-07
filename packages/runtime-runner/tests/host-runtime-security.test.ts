/**
 * Host Runtime Security, Sandbox & LLM Proxy Tests
 *
 * Tests space boundary enforcement, tool PWD control, approval policy on host runtime,
 * constant-time LLM proxy authentication (Bearer / header / opaque path),
 * error message sanitization (no path or secret leaks), and loopback proxy integration.
 *
 * @module @enkeep/runtime-runner/tests/host-runtime-security.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  HostRuntimeAdapter,
  HostLlmProxyServer,
  HostPlatformProxyServer,
  constantTimeCompare,
  type ActiveRuntimeHandle,
} from '../src/index.js';

describe('Host Runtime Security, Authentication & Sandbox Confinement', () => {
  let tmpDataRoot: string;
  let adapter: HostRuntimeAdapter;
  const activeHandles: ActiveRuntimeHandle[] = [];

  beforeEach(() => {
    tmpDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-host-sec-'));
    adapter = new HostRuntimeAdapter();
  });

  afterEach(async () => {
    for (const h of activeHandles) {
      try {
        await h.stop();
      } catch {}
    }
    activeHandles.length = 0;

    if (fs.existsSync(tmpDataRoot)) {
      try {
        fs.rmSync(tmpDataRoot, { recursive: true, force: true });
      } catch {}
    }
  });

  describe('Constant-Time Comparison Utility', () => {
    it('correctly matches equal strings and rejects mismatched strings securely in constant time', () => {
      const token = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
      expect(constantTimeCompare(token, token)).toBe(true);
      expect(constantTimeCompare('wrong', token)).toBe(false);
      expect(constantTimeCompare(undefined, token)).toBe(false);
      expect(constantTimeCompare(null, token)).toBe(false);
      expect(constantTimeCompare(token.slice(0, 10), token)).toBe(false);
      expect(constantTimeCompare('', token)).toBe(false);
      expect(constantTimeCompare(token, '')).toBe(false);
    });
  });

  describe('HostLlmProxyServer Authentication & Error Sanitization', () => {
    it('rejects requests with missing token (HTTP 401, zero handler invocation, generic body)', async () => {
      let handlerInvoked = false;
      const proxyServer = new HostLlmProxyServer({
        fetchImpl: (async () => {
          handlerInvoked = true;
          return new Response('ok');
        }) as any,
      });

      await proxyServer.start();
      const port = proxyServer.getPort()!;

      try {
        // Direct request to /llm/cpa-gemini without token or opaque path
        const res = await fetch(`http://127.0.0.1:${port}/llm/cpa-gemini/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: [] }),
        });

        expect(res.status).toBe(401);
        expect(res.headers.get('content-type')).toContain('application/json');
        const json = await res.json();
        expect(json).toEqual({
          error: {
            code: 'unauthorized',
            message: 'Unauthorized proxy access',
          },
        });
        expect(handlerInvoked).toBe(false);
      } finally {
        await proxyServer.close();
      }
    });

    it('rejects requests with incorrect token (HTTP 401, zero handler invocation, generic body)', async () => {
      let handlerInvoked = false;
      const proxyServer = new HostLlmProxyServer({
        fetchImpl: (async () => {
          handlerInvoked = true;
          return new Response('ok');
        }) as any,
      });

      await proxyServer.start();
      const port = proxyServer.getPort()!;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/llm/cpa-gemini/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer wrong-token-12345',
          },
          body: JSON.stringify({ messages: [] }),
        });

        expect(res.status).toBe(401);
        const json = await res.json();
        expect(json.error.code).toBe('unauthorized');
        expect(handlerInvoked).toBe(false);
      } finally {
        await proxyServer.close();
      }
    });

    it('rejects requests with opaque path prefix alone when token header is missing (HTTP 401)', async () => {
      let handlerInvoked = false;
      const proxyServer = new HostLlmProxyServer({
        fetchImpl: (async () => {
          handlerInvoked = true;
          return new Response(JSON.stringify({ choices: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }) as any,
      });

      const baseUrl = await proxyServer.start();

      try {
        const res = await fetch(`${baseUrl}/cpa-claude/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: [] }),
        });

        expect(res.status).toBe(401);
        const json = await res.json();
        expect(json.error.code).toBe('unauthorized');
        expect(handlerInvoked).toBe(false);
      } finally {
        await proxyServer.close();
      }
    });

    it('rejects requests with valid token but invalid/bare path prefix (HTTP 404)', async () => {
      let handlerInvoked = false;
      const proxyServer = new HostLlmProxyServer({
        fetchImpl: (async () => {
          handlerInvoked = true;
          return new Response(JSON.stringify({ choices: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }) as any,
      });

      await proxyServer.start();
      const port = proxyServer.getPort()!;
      const token = proxyServer.getAuthToken();

      try {
        // Bare route without opaque prefix
        const res = await fetch(`http://127.0.0.1:${port}/llm/cpa-claude/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ messages: [] }),
        });

        expect(res.status).toBe(404);
        const json = await res.json();
        expect(json.error.code).toBe('not_found');
        expect(handlerInvoked).toBe(false);
      } finally {
        await proxyServer.close();
      }
    });

    it('accepts requests with valid Authorization Bearer header and matching opaque path prefix', async () => {
      let handlerInvoked = false;
      const proxyServer = new HostLlmProxyServer({
        fetchImpl: (async () => {
          handlerInvoked = true;
          return new Response(JSON.stringify({ choices: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }) as any,
      });

      const baseUrl = await proxyServer.start();
      const token = proxyServer.getAuthToken();

      try {
        const res = await fetch(`${baseUrl}/cpa-claude/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ messages: [] }),
        });

        expect(handlerInvoked).toBe(true);
        expect(res.status).toBe(200);
      } finally {
        await proxyServer.close();
      }
    });

    it('rejects requests with custom non-Bearer headers alone (HTTP 401)', async () => {
      let handlerInvoked = false;
      const proxyServer = new HostLlmProxyServer({
        fetchImpl: (async () => {
          handlerInvoked = true;
          return new Response(JSON.stringify({ choices: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }) as any,
      });

      const baseUrl = await proxyServer.start();
      const token = proxyServer.getAuthToken();

      try {
        const res = await fetch(`${baseUrl}/cpa-claude/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-enkeep-proxy-token': token,
          },
          body: JSON.stringify({ messages: [] }),
        });

        expect(res.status).toBe(401);
        const json = await res.json();
        expect(json.error.code).toBe('unauthorized');
        expect(handlerInvoked).toBe(false);
      } finally {
        await proxyServer.close();
      }
    });

    it('sanitizes internal handler throws and returns generic 500 without leaking paths or secrets', async () => {
      const proxyServer = new HostLlmProxyServer({
        fetchImpl: (async () => {
          throw new Error('Fatal internal error leaking /secret/system/key/path and credentials');
        }) as any,
      });

      const baseUrl = await proxyServer.start();
      const token = proxyServer.getAuthToken();

      try {
        const res = await fetch(`${baseUrl}/cpa-claude/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ messages: [] }),
        });

        expect(res.status).toBeGreaterThanOrEqual(500);
        const text = await res.text();
        expect(text).not.toContain('/secret/system/key/path');
        expect(text).not.toContain('credentials');
        expect(text).toContain('error');
      } finally {
        await proxyServer.close();
      }
    });

    it('rejects /platform/... routes on HostLlmProxyServer even with valid Bearer token (HTTP 404)', async () => {
      let handlerInvoked = false;
      const proxyServer = new HostLlmProxyServer({
        fetchImpl: (async () => {
          handlerInvoked = true;
          return new Response(JSON.stringify({ choices: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }) as any,
      });

      await proxyServer.start();
      const port = proxyServer.getPort()!;
      const token = proxyServer.getAuthToken();

      try {
        // 1. /platform route with valid token -> 404
        const res1 = await fetch(`http://127.0.0.1:${port}/platform/p_12345/api/browser/open`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ url: 'https://example.com' }),
        });
        expect(res1.status).toBe(404);
        expect(handlerInvoked).toBe(false);

        // 2. /platform route -> 404
        const res2 = await fetch(`http://127.0.0.1:${port}/platform`, {
          method: 'GET',
          headers: {
            authorization: `Bearer ${token}`,
          },
        });
        expect(res2.status).toBe(404);
        expect(handlerInvoked).toBe(false);

        // 3. /api route -> 404
        const res3 = await fetch(`http://127.0.0.1:${port}/api/browser/open`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ url: 'https://example.com' }),
        });
        expect(res3.status).toBe(404);
        expect(handlerInvoked).toBe(false);

        // 4. /capabilities route -> 404
        const res4 = await fetch(`http://127.0.0.1:${port}/capabilities`, {
          method: 'GET',
          headers: {
            authorization: `Bearer ${token}`,
          },
        });
        expect(res4.status).toBe(404);
        expect(handlerInvoked).toBe(false);
      } finally {
        await proxyServer.close();
      }
    });
  });

  describe('Host Platform & Browser Route Authentication & Security Direct Tests', () => {
    it('rejects unauthenticated browser, file, and capabilities requests with HTTP 401', async () => {
      let platformHandlerInvoked = false;
      const mockPlatformHandler = {
        handleHttpRequest: async () => {
          platformHandlerInvoked = true;
        },
      } as any;

      const proxyServer = new HostPlatformProxyServer({
        handler: mockPlatformHandler,
      });

      const platformBaseUrl = await proxyServer.start();

      try {
        // 1. Browser route without auth
        const resBrowser = await fetch(`${platformBaseUrl}/api/browser/open`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com' }),
        });
        expect(resBrowser.status).toBe(401);
        expect(platformHandlerInvoked).toBe(false);

        // 2. File route without auth
        const resFiles = await fetch(`${platformBaseUrl}/api/files`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ recipient: 'ses_1', path: 'file.txt' }),
        });
        expect(resFiles.status).toBe(401);
        expect(platformHandlerInvoked).toBe(false);

        // 3. Capabilities without auth
        const resCap = await fetch(`${platformBaseUrl}/capabilities`, {
          method: 'GET',
        });
        expect(resCap.status).toBe(401);
        expect(platformHandlerInvoked).toBe(false);
      } finally {
        await proxyServer.close();
      }
    });

    it('rejects requests without auth token even with opaque prefix (HTTP 401)', async () => {
      let platformHandlerInvoked = false;
      const mockPlatformHandler = {
        handleHttpRequest: async () => {
          platformHandlerInvoked = true;
        },
      } as any;

      const proxyServer = new HostPlatformProxyServer({
        handler: mockPlatformHandler,
      });

      const baseUrl = await proxyServer.start();

      try {
        const resBareBrowser = await fetch(`${baseUrl}/api/browser/open`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({ url: 'https://example.com' }),
        });
        expect(resBareBrowser.status).toBe(401);
        expect(platformHandlerInvoked).toBe(false);
      } finally {
        await proxyServer.close();
      }
    });

    it('rejects bare /api routes on HostPlatformProxyServer without opaque prefix even with valid Bearer token (HTTP 404)', async () => {
      let platformHandlerInvoked = false;
      const mockPlatformHandler = {
        handleHttpRequest: async () => {
          platformHandlerInvoked = true;
        },
      } as any;

      const proxyServer = new HostPlatformProxyServer({
        handler: mockPlatformHandler,
      });

      await proxyServer.start();
      const port = proxyServer.getPort()!;
      const token = proxyServer.getAuthToken();

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/browser/open`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ url: 'https://example.com' }),
        });
        expect(res.status).toBe(404);
        expect(platformHandlerInvoked).toBe(false);
      } finally {
        await proxyServer.close();
      }
    });

    it('rejects wrong opaque platform prefix on HostPlatformProxyServer even with valid Bearer token (HTTP 404)', async () => {
      let platformHandlerInvoked = false;
      const mockPlatformHandler = {
        handleHttpRequest: async () => {
          platformHandlerInvoked = true;
        },
      } as any;

      const proxyServer = new HostPlatformProxyServer({
        handler: mockPlatformHandler,
      });

      await proxyServer.start();
      const port = proxyServer.getPort()!;
      const token = proxyServer.getAuthToken();

      try {
        const res = await fetch(`http://127.0.0.1:${port}/platform/p_wrong_prefix_12345/api/browser/open`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ url: 'https://example.com' }),
        });
        expect(res.status).toBe(404);
        expect(platformHandlerInvoked).toBe(false);
      } finally {
        await proxyServer.close();
      }
    });

    it('accepts platform requests with valid Bearer token and exact opaque prefix', async () => {
      let platformHandlerInvoked = false;
      const mockPlatformHandler = {
        handleHttpRequest: async (_req: any, res: any) => {
          platformHandlerInvoked = true;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        },
      } as any;

      const proxyServer = new HostPlatformProxyServer({
        handler: mockPlatformHandler,
      });

      const platformBaseUrl = await proxyServer.start();
      const token = proxyServer.getAuthToken();

      try {
        const res = await fetch(`${platformBaseUrl}/api/browser/open`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ url: 'https://example.com' }),
        });
        expect(res.status).toBe(200);
        expect(platformHandlerInvoked).toBe(true);
      } finally {
        await proxyServer.close();
      }
    });

    it('sanitizes platform handler throws and returns generic 500 without leaking error details', async () => {
      const mockPlatformHandler = {
        handleHttpRequest: async () => {
          throw new Error('Secret database connection string leaking in platform stack trace');
        },
      } as any;

      const proxyServer = new HostPlatformProxyServer({
        handler: mockPlatformHandler,
      });

      const platformBaseUrl = await proxyServer.start();
      const token = proxyServer.getAuthToken();

      try {
        const res = await fetch(`${platformBaseUrl}/api/browser/open`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ url: 'https://example.com' }),
        });
        expect(res.status).toBe(500);
        const json = await res.json();
        expect(json).toEqual({
          error: {
            code: 'internal_error',
            message: 'Internal platform proxy error',
          },
        });
      } finally {
        await proxyServer.close();
      }
    });
  });

  describe('Workspace Confinement & End-to-End LLM Proxy Integration', () => {
    it('proves that Host Runtime tools are workspace-confined to their allocated space', async () => {
      const spec = adapter.createDefaultUserSpec({
        userId: 'alice',
        dataRoot: tmpDataRoot,
      });

      const handle = await adapter.startRuntime(spec, 15_000);
      activeHandles.push(handle);

      const sessionId = 'ses_11112222333344445555666677778888';

      // Send turn that creates a file in the workspace
      const turn1 = await handle.sendFollowup({
        prompt: 'Please initialize space workspace files',
        sessionId,
        turnId: 'turn_aaaa1111bbbb2222cccc3333dddd4444',
        workspaceFolder: 'space-confined',
      });

      expect(turn1.status).toBe('completed');

      // Space directory was created inside alice spacesDir
      const expectedSpaceDir = path.join(spec.spacesDir, 'space-confined');
      expect(fs.existsSync(expectedSpaceDir)).toBe(true);

      // Write file via fileOperation and ensure it lands in space-confined
      await handle.fileOperation({
        op: 'write',
        space: 'space-confined',
        path: 'in-space.txt',
        content: 'space isolated content',
        requireAbsent: true,
      });

      expect(fs.existsSync(path.join(expectedSpaceDir, 'in-space.txt'))).toBe(true);

      // Attempting to write outside space boundary with path traversal fails closed
      const traversalWrite = await handle.fileOperation({
        op: 'write',
        space: 'space-confined',
        path: '../escaped.txt',
        content: 'escaped content',
        requireAbsent: true,
      });

      expect(traversalWrite.status).toBe('error');
      expect(fs.existsSync(path.join(spec.spacesDir, 'escaped.txt'))).toBe(false);
    }, 20_000);

    it('integrates with HostLlmProxyServer for cpa-gemini and gemini-3.7-flash-tiered model requests', async () => {
      const recordedRequests: any[] = [];
      const proxyServer = new HostLlmProxyServer({
        deploymentConfig: {
          dshHome: tmpDataRoot,
          providers: {
            'cpa-gemini': {
              api: 'anthropic-messages',
              baseURL: 'https://gw.example.com/v1',
              apiKeyEnv: 'CPA_TOKEN',
              models: [{ id: 'gemini-3.7-flash-tiered' }],
            },
          },
          tokens: {
            CPA_TOKEN: 'real-platform-gemini-key',
          },
          defaultModel: {
            provider: 'cpa-gemini',
            model: 'gemini-3.7-flash-tiered',
            reasoningEffort: 'max',
          },
          allowedHosts: ['gw.example.com'],
        },
        fetchImpl: (async (url: any, init: any) => {
          recordedRequests.push({ url, headers: init?.headers, body: init?.body });
          const mockSse = [
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"gemini-3.7-flash-tiered","usage":{"input_tokens":10,"output_tokens":1}}}\n\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello from Gemini Tiered Max Reasoning!"}}\n\n',
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ].join('');

          return new Response(mockSse, {
            status: 200,
            headers: {
              'content-type': 'text/event-stream',
              'x-enkeep-model-provider': 'cpa-gemini',
            },
          });
        }) as any,
      });

      const proxyBaseUrl = await proxyServer.start();

      try {
        const spec = adapter.createDefaultUserSpec({
          userId: 'alice',
          dataRoot: tmpDataRoot,
          llmEnabled: true,
          llmProvider: 'cpa-gemini',
          llmModel: 'gemini-3.7-flash-tiered',
          llmBaseUrl: proxyBaseUrl,
          llmProxyToken: proxyServer.getAuthToken(),
        });

        const handle = await adapter.startRuntime(spec, 15_000);
        activeHandles.push(handle);

        const health = await handle.checkHealth();
        expect(health.dshReady).toBe(true);
        expect(health.modelProvider).toBe('cpa-gemini');

        const sessionId = 'ses_99998888777766665555444433332222';
        const turnRes = await handle.sendFollowup({
          prompt: 'Say hello with gemini reasoning max',
          sessionId,
          turnId: 'turn_eeee9999ffff8888aaaa7777bbbb6666',
          modelSelection: {
            provider: 'cpa-gemini',
            model: 'gemini-3.7-flash-tiered',
            reasoningEffort: 'max',
          },
        });

        expect(turnRes.status).toBe('completed');
        expect(turnRes.replyText).toContain('Gemini Tiered Max Reasoning');
        expect(recordedRequests.length).toBeGreaterThanOrEqual(1);

        // Verify proxy received the request and replaced placeholder with real token
        const reqHeaders = recordedRequests[0].headers;
        const getHeader = (key: string) => {
          if (!reqHeaders) return undefined;
          if (typeof reqHeaders.get === 'function') return reqHeaders.get(key);
          return reqHeaders[key] || reqHeaders[key.toLowerCase()];
        };
        const authHeader = getHeader('x-api-key') || getHeader('authorization');
        expect(authHeader).toBe('real-platform-gemini-key');

        // Verify signed process.meta.json does NOT contain proxyToken or secrets
        const metaPath = path.join(spec.runDir, 'process.meta.json');
        expect(fs.existsSync(metaPath)).toBe(true);
        const metaContent = fs.readFileSync(metaPath, 'utf8');
        expect(metaContent).not.toContain('real-platform-gemini-key');
        expect(metaContent).not.toContain(proxyServer.getAuthToken());
        expect(metaContent).not.toContain('CPA_TOKEN');
      } finally {
        await proxyServer.close();
      }
    }, 25_000);
  });
});
