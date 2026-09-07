/**
 * Two-Step AgentLoop Request-Level Fallback & Side Effect Verification Test
 *
 * Verifies that:
 * 1. LLM call 1 succeeds and emits a tool-call with an incrementing side effect.
 * 2. Tool executes exactly once (sideEffectCounter = 1).
 * 3. LLM call 2 primary returns 503 Service Unavailable.
 * 4. LlmProxy transparently falls back to secondary model on LLM call 2 at request-level.
 * 5. LLM call 2 secondary succeeds with final text reply.
 * 6. Assertions verify:
 *    - tool execution count is EXACTLY 1 (tool side effect is NOT duplicated).
 *    - exactly 1 user/message event.
 *    - exactly 1 turn/start event.
 *    - route result has fallbackUsed: true and provider: 'cpa-gemini'.
 *
 * This catches whole-turn retry regression where wrapping the turn re-executed tools.
 *
 * @module @enkeep/runtime-runner/tests/agent-loop-two-step-fallback.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Duplex, PassThrough } from 'node:stream';
import { bootDshRuntime } from '../src/runtime/dsh-boot.js';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { LlmProxyHandler } from '../src/tunnel/llm-proxy.js';
import type { DshDeploymentConfig } from '../src/config/dsh-config-loader.js';

describe('Two-Step AgentLoop Request-Level Fallback Test', () => {
  const originalEnv = process.env;
  let testHomeDir: string;
  let testSpacesDir: string;
  let mockUpstreamServer: http.Server;
  let mockUpstreamPort: number;
  let mockTunnelServer: http.Server;
  let mockTunnelPort: number;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    const tmp = os.tmpdir();
    const nonce = Math.random().toString(36).substring(2, 10);
    const baseParent = path.join(tmp, `test-two-step-fb-${nonce}`);
    testHomeDir = path.join(baseParent, 'home');
    testSpacesDir = path.join(baseParent, 'spaces');

    fs.mkdirSync(testHomeDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(testSpacesDir, { recursive: true, mode: 0o700 });
  });

  afterEach(async () => {
    process.env = originalEnv;
    if (mockUpstreamServer) {
      await new Promise<void>((res) => mockUpstreamServer.close(() => res()));
    }
    if (mockTunnelServer) {
      await new Promise<void>((res) => mockTunnelServer.close(() => res()));
    }
    try {
      fs.rmSync(path.dirname(testHomeDir), { recursive: true, force: true });
    } catch {}
  });

  it('executes tool once on call 1, falls back to secondary on call 2 (503), and completes turn without duplicating tool side effects', async () => {
    let sideEffectCounter = 0;
    const claudeRequests: any[] = [];
    const geminiRequests: any[] = [];

    // 1. Setup mock upstream HTTP gateway
    mockUpstreamServer = http.createServer((req, res) => {
      const url = req.url || '';
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const bodyStr = Buffer.concat(chunks).toString('utf8');

        if (url.includes('/claude')) {
          claudeRequests.push({ url, body: bodyStr });
          if (claudeRequests.length === 1) {
            // Call 1: Primary Claude succeeds with tool_use
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
            });
            res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-fable-5","usage":{"input_tokens":10,"output_tokens":0}}}\n\n');
            res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_inc_1","name":"increment_counter","input":{}}}\n\n');
            res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n');
            res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
            res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":15}}\n\n');
            res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
            res.end();
          } else {
            // Call 2: Primary Claude returns 503 Service Unavailable
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Claude capacity temporarily unavailable', code: 'service_unavailable' } }));
          }
        } else if (url.includes('/gemini')) {
          // Call 2: Fallback Gemini succeeds with final text reply
          geminiRequests.push({ url, body: bodyStr });
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });
          res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","type":"message","role":"assistant","content":[],"model":"gemini-3.7-flash-tiered","usage":{"input_tokens":25,"output_tokens":0}}}\n\n');
          res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
          res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Counter was incremented to 1 successfully."}}\n\n');
          res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
          res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":20}}\n\n');
          res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
          res.end();
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      });
    });

    mockUpstreamPort = await new Promise<number>((resolve) => {
      mockUpstreamServer.listen(0, '127.0.0.1', () => {
        const addr = mockUpstreamServer.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });

    // 2. Setup LlmProxyHandler on platform host side
    const deploymentConfig: DshDeploymentConfig = {
      defaultModel: 'cpa-claude/claude-fable-5',
      allowedHosts: ['127.0.0.1', 'localhost'],
      tokens: {
        CPA_TOKEN: 'real-mock-token-xyz',
      },
      providers: {
        'cpa-claude': {
          id: 'cpa-claude',
          displayName: 'Claude',
          api: 'anthropic-messages',
          apiKeyEnv: 'CPA_TOKEN',
          baseURL: `http://127.0.0.1:${mockUpstreamPort}/claude`,
          models: [{ id: 'claude-fable-5' }],
        },
        'cpa-gemini': {
          id: 'cpa-gemini',
          displayName: 'Gemini',
          api: 'anthropic-messages',
          apiKeyEnv: 'CPA_TOKEN',
          baseURL: `http://127.0.0.1:${mockUpstreamPort}/gemini`,
          models: [{ id: 'gemini-3.7-flash-tiered' }],
        },
      },
    };

    const proxyHandler = new LlmProxyHandler({
      deploymentConfig,
    });

    // 3. Setup mock tunnel server listening at 127.0.0.1 (simulating port 8787)
    mockTunnelServer = http.createServer(async (req, res) => {
      await proxyHandler.handleHttpRequest(req, res);
    });

    mockTunnelPort = await new Promise<number>((resolve) => {
      mockTunnelServer.listen(0, '127.0.0.1', () => {
        const addr = mockTunnelServer.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });

    // 4. Boot DSH runtime pointing to the tunnel server
    const inContainerProviders = {
      'cpa-claude': {
        displayName: 'Claude',
        apiKeyEnv: 'IN_CONTAINER_PLACEHOLDER',
        api: 'anthropic-messages',
        baseURL: `http://127.0.0.1:${mockTunnelPort}/llm/cpa-claude`,
        defaultContextWindow: 1000000,
        defaultMaxTokens: 128000,
        models: [
          {
            id: 'claude-fable-5',
            reasoningEfforts: {
              low: 'low',
              medium: 'medium',
              high: 'high',
              max: 'max',
            },
          },
        ],
      },
      'cpa-gemini': {
        displayName: 'Gemini',
        apiKeyEnv: 'IN_CONTAINER_PLACEHOLDER',
        api: 'anthropic-messages',
        baseURL: `http://127.0.0.1:${mockTunnelPort}/llm/cpa-gemini`,
        defaultContextWindow: 1000000,
        defaultMaxTokens: 128000,
        models: [
          {
            id: 'gemini-3.7-flash-tiered',
            reasoningEfforts: {
              low: 'low',
              medium: 'medium',
              high: 'high',
              max: 'max',
            },
          },
        ],
      },
    };

    process.env.ENKEEP_LLM_ENABLED = '1';
    process.env.IN_CONTAINER_PLACEHOLDER = 'in-container-placeholder';
    process.env.ENKEEP_LLM_BASE_URL = `http://127.0.0.1:${mockTunnelPort}/llm`;

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: testHomeDir,
      spacesDir: testSpacesDir,
      llmEnabled: true,
      provider: 'cpa-claude',
      model: 'claude-fable-5',
      providers: inContainerProviders,
    });

    try {
      // Register custom tool "increment_counter" on cordis Context tools
      const ctx = runtime.context;
      const counterTool = defineTool({
        name: 'increment_counter',
        description: 'Increments the test side effect counter by 1',
        parameters: {},
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, val) => [{ type: 'text', text: JSON.stringify(val) }],
        },
        execute: async () => {
          sideEffectCounter++;
          return {
            success: true,
            currentCount: sideEffectCounter,
          };
        },
      });
      ctx.tools.register(counterTool);

      const sessionId = 'ses_0123456789abcdef0123456789abcdef';
      const turnId = 'turn_0123456789abcdef0123456789abcde1';

      // Execute turn with modelSelection having primary cpa-claude and fallbackChain cpa-gemini
      const followupRes = await runtime.sendFollowup({
        prompt: 'Please increment the counter',
        sessionId,
        turnId,
        profile: null,
        modelSelection: {
          provider: 'cpa-claude',
          model: 'claude-fable-5',
          fallbackChain: [
            { provider: 'cpa-gemini', model: 'gemini-3.7-flash-tiered', reasoningEffort: 'max' },
          ],
        },
      });

      // Assert turn completed successfully
      expect(followupRes.status).toBe('completed');
      expect(followupRes.replyText).toContain('Counter was incremented to 1 successfully.');

      // Assert side effect was executed EXACTLY ONCE (not twice!)
      expect(sideEffectCounter).toBe(1);

      // Assert request breakdown: Claude received 3 calls (1 success on step 1, 2 503 attempts with bounded retry on step 2), Gemini received 1 call (success on step 2)
      expect(claudeRequests.length).toBe(3);
      expect(geminiRequests.length).toBe(1);

      // Assert session events invariant: exactly 1 human user/message, exactly 1 turn/start
      const agent = await runtime.getOrCreateAgent(sessionId);
      const events = agent.session.snapshotEvents();

      const userMessages = events.filter((e) => e.type === 'user/message' && (e.data as any)?.source?.kind === 'user');
      expect(userMessages.length).toBe(1);

      const turnStarts = events.filter((e) => e.type === 'turn/start');
      expect(turnStarts.length).toBe(1);

      const turnEnds = events.filter((e) => e.type === 'turn/end');
      expect(turnEnds.length).toBe(1);

      // Assert request/context event reflects secondary model
      const requestContexts = events.filter((e) => e.type === 'request/context');
      expect(requestContexts.length).toBeGreaterThan(0);
      const lastContext = requestContexts[requestContexts.length - 1];
      expect(lastContext.data.provider).toBe('cpa-gemini');
      expect(lastContext.data.model).toBe('gemini-3.7-flash-tiered');

      // Assert no custom extension events logged in session log
      const customRouteEvents = events.filter((e) => e.type === 'enkeep/model-route-result' || e.type === 'enkeep/model-selection');
      expect(customRouteEvents.length).toBe(0);

      // Assert followup response modelInfo and routeAttempts
      expect(followupRes.modelInfo).toBeDefined();
      expect(followupRes.modelInfo?.provider).toBe('cpa-gemini');
      expect(followupRes.modelInfo?.model).toBe('gemini-3.7-flash-tiered');
      expect((followupRes.modelInfo as any)?.fallbackUsed).toBe(true);
      expect(followupRes.routeAttempts).toBeDefined();
      expect(followupRes.routeAttempts?.length).toBeGreaterThanOrEqual(2);
    } finally {
      await runtime.dispose();
    }
  });
});
