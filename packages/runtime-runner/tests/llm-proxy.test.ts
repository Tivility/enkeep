/**
 * LLM Proxy StreamHandler and In-Container Pi-Ai Adapter Unit & E2E Tests
 *
 * Tests:
 * - Config loader parsing from fixture YAML (single source of truth for providers and models)
 * - LlmProxyHandler host whitelist (accepts configured hosts like gw.example.com, rejects unlisted hosts with 403)
 * - Missing config / token returns 503 fixed error (no fallback, no forgery)
 * - Placeholder credential replacement for Authorization: Bearer and x-api-key
 * - SSE chunk-by-chunk stream forwarding and route dispatch (/llm/<providerKey>/...)
 * - In-container dsh-boot official PiAiAdapter registration when ENKEEP_LLM_ENABLED=1
 * - In-container dsh-boot DemoModel fallback when ENKEEP_LLM_ENABLED is unset
 * - Health reporting modelProvider: 'deepseek' | 'demo'
 * - Real usage.totalTokens extraction and validation
 * - Opt-in live E2E test with local $DSH_HOME config against real gateway (graceful skip when missing)
 *
 * @module @enkeep/runtime-runner/tests/llm-proxy.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough, Duplex } from 'node:stream';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LlmProxyHandler,
  createLlmProxyHandler,
  parseLlmProviderRoute,
  buildUpstreamUrl,
  isPlaceholderCredential,
  parseDshConfigFiles,
  createInContainerProvidersSpec,
  loadDshDeploymentConfig,
  bootDshRuntime,
  type DshDeploymentConfig,
} from '../src/index.js';

const FIXTURE_CORDIS_PATCH_YML = `
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
            reasoningEfforts:
              low: low
              high: high
      cpa-gpt:
        displayName: GPT
        apiKeyEnv: CPA_TOKEN
        api: openai-completions
        baseURL: https://gw.example.com/v1
        defaultContextWindow: 920000
        defaultMaxTokens: 128000
        models:
          - id: gpt-5.6-sol
      cpa-gemini:
        displayName: Gemini
        apiKeyEnv: CPA_TOKEN
        api: anthropic-messages
        baseURL: https://gw.example.com
        defaultContextWindow: 1000000
        defaultMaxTokens: 64000
        models:
          - id: gemini-3.7-flash-tiered

- id: agent-default-model
  config:
    provider: cpa-claude
    model: claude-fable-5
`;

const FIXTURE_SETTINGS_YAML = `
agent-default-model:
  provider: cpa-claude
  model: claude-fable-5
  reasoningEffort: high
`;

const FIXTURE_ENV = `
CPA_TOKEN=test-secret-token-xyz-123
`;

describe('DSH Deployment Config Loader Unit Tests (Fixture-driven)', () => {
  it('parses providers, default model, tokens, and allowed hosts from fixture content', () => {
    const config = parseDshConfigFiles(FIXTURE_CORDIS_PATCH_YML, FIXTURE_SETTINGS_YAML, FIXTURE_ENV, '/tmp/mock-dsh');
    expect(config).toBeDefined();
    expect(Object.keys(config.providers)).toEqual(['cpa-claude', 'cpa-gpt', 'cpa-gemini']);
    expect(config.providers['cpa-claude']?.api).toBe('anthropic-messages');
    expect(config.providers['cpa-claude']?.baseURL).toBe('https://gw.example.com');
    expect(config.providers['cpa-gpt']?.api).toBe('openai-completions');
    expect(config.providers['cpa-gpt']?.baseURL).toBe('https://gw.example.com/v1');
    expect(config.defaultModel).toEqual({
      provider: 'cpa-claude',
      model: 'claude-fable-5',
      reasoningEffort: 'high',
    });
    expect(config.tokens['CPA_TOKEN']).toBe('test-secret-token-xyz-123');
    expect(config.allowedHosts).toContain('gw.example.com');
  });

  it('rewrites in-container providers spec with tunnel baseURL and placeholder apiKeyEnv', () => {
    const config = parseDshConfigFiles(FIXTURE_CORDIS_PATCH_YML, undefined, undefined);
    const inContainer = createInContainerProvidersSpec(config.providers, 'http://127.0.0.1:8787/llm');
    expect(inContainer['cpa-claude']?.baseURL).toBe('http://127.0.0.1:8787/llm/cpa-claude');
    expect(inContainer['cpa-claude']?.apiKeyEnv).toBe('IN_CONTAINER_PLACEHOLDER');
    expect(inContainer['cpa-gpt']?.baseURL).toBe('http://127.0.0.1:8787/llm/cpa-gpt');
    expect(inContainer['cpa-gpt']?.apiKeyEnv).toBe('IN_CONTAINER_PLACEHOLDER');
    expect(inContainer['cpa-claude']?.defaultContextWindow).toBe(1000000);
  });
});

describe('LlmProxyHandler Unit Tests', () => {
  const originalEnv = process.env;
  let fixtureConfig: DshDeploymentConfig;

  beforeEach(() => {
    process.env = { ...originalEnv };
    fixtureConfig = parseDshConfigFiles(FIXTURE_CORDIS_PATCH_YML, FIXTURE_SETTINGS_YAML, FIXTURE_ENV);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('Route and Path Parsing', () => {
    it('correctly parses providerKey and remainingPath from /llm/<providerKey>/...', () => {
      expect(parseLlmProviderRoute('/llm/cpa-claude/v1/messages')).toEqual({
        providerKey: 'cpa-claude',
        remainingPath: '/v1/messages',
      });
      expect(parseLlmProviderRoute('/llm/cpa-gpt/chat/completions')).toEqual({
        providerKey: 'cpa-gpt',
        remainingPath: '/chat/completions',
      });
      expect(parseLlmProviderRoute('/llm/cpa-gemini')).toEqual({
        providerKey: 'cpa-gemini',
        remainingPath: '/',
      });
    });

    it('builds upstream URL without duplicate /v1 prefixes', () => {
      expect(buildUpstreamUrl('https://gw.example.com/v1', '/chat/completions')).toBe(
        'https://gw.example.com/v1/chat/completions'
      );
      expect(buildUpstreamUrl('https://gw.example.com/v1', '/v1/chat/completions')).toBe(
        'https://gw.example.com/v1/chat/completions'
      );
      expect(buildUpstreamUrl('https://gw.example.com', '/v1/messages')).toBe(
        'https://gw.example.com/v1/messages'
      );
    });

    it('identifies placeholder credentials correctly', () => {
      expect(isPlaceholderCredential('in-container-placeholder')).toBe(true);
      expect(isPlaceholderCredential('Bearer in-container-placeholder')).toBe(true);
      expect(isPlaceholderCredential('in-container')).toBe(true);
      expect(isPlaceholderCredential('Bearer in-container')).toBe(true);
      expect(isPlaceholderCredential('IN_CONTAINER_PLACEHOLDER')).toBe(true);
      expect(isPlaceholderCredential('sk-real-secret-12345')).toBe(false);
      expect(isPlaceholderCredential(undefined)).toBe(false);
    });
  });

  describe('Host Whitelist and Security Filtering', () => {
    it('returns 403 Forbidden when request targets forbidden or unwhitelisted host', async () => {
      const handler = new LlmProxyHandler({
        deploymentConfig: {
          ...fixtureConfig,
          providers: {
            'evil-provider': {
              api: 'openai-completions',
              baseURL: 'https://evil.untrusted.com/v1',
            },
          },
          // allowedHosts only contains gw.example.com
          allowedHosts: ['gw.example.com'],
        },
      });

      const inStream = new PassThrough();
      const outStream = new PassThrough();
      const clientStream = Duplex.from({ readable: inStream, writable: outStream });

      const handlePromise = handler.handle(clientStream, { kind: 'llm' });

      inStream.write('POST /llm/evil-provider/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nContent-Length: 2\r\n\r\n{}');
      inStream.end();

      const chunks: Buffer[] = [];
      for await (const chunk of outStream) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      await handlePromise;

      const rawResponse = Buffer.concat(chunks).toString('utf8');
      expect(rawResponse).toContain('HTTP/1.1 403 Forbidden');
      expect(rawResponse).toContain('forbidden_host');
    });
  });

  describe('Missing Configuration or Token 503 Handling', () => {
    it('returns 503 Service Unavailable when deployment config is missing or empty', async () => {
      const handler = new LlmProxyHandler({
        deploymentConfig: {
          dshHome: '/nonexistent',
          providers: {},
          defaultModel: { provider: 'none', model: 'none' },
          tokens: {},
          allowedHosts: [],
        },
      });

      const inStream = new PassThrough();
      const outStream = new PassThrough();
      const clientStream = Duplex.from({ readable: inStream, writable: outStream });

      const handlePromise = handler.handle(clientStream, { kind: 'llm' });

      inStream.write('POST /llm/cpa-claude/v1/messages HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nContent-Length: 2\r\n\r\n{}');
      inStream.end();

      const chunks: Buffer[] = [];
      for await (const chunk of outStream) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      await handlePromise;

      const rawResponse = Buffer.concat(chunks).toString('utf8');
      expect(rawResponse).toContain('HTTP/1.1 503 Service Unavailable');
      expect(rawResponse).toContain('missing_llm_config');
    });

    it('returns 503 Service Unavailable when API token is missing in platform config', async () => {
      const handler = new LlmProxyHandler({
        deploymentConfig: {
          ...fixtureConfig,
          tokens: {}, // Missing token
        },
      });

      const inStream = new PassThrough();
      const outStream = new PassThrough();
      const clientStream = Duplex.from({ readable: inStream, writable: outStream });

      const handlePromise = handler.handle(clientStream, { kind: 'llm' });

      inStream.write('POST /llm/cpa-claude/v1/messages HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nContent-Length: 2\r\n\r\n{}');
      inStream.end();

      const chunks: Buffer[] = [];
      for await (const chunk of outStream) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      await handlePromise;

      const rawResponse = Buffer.concat(chunks).toString('utf8');
      expect(rawResponse).toContain('HTTP/1.1 503 Service Unavailable');
      expect(rawResponse).toContain('missing_api_token');
    });
  });

  describe('Placeholder Token Replacement and SSE Streaming', () => {
    it('replaces placeholder authorization header with real token and streams SSE response', async () => {
      let capturedUrl = '';
      let capturedAuth = '';
      let capturedHost = '';

      const mockSseChunks = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[]}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello via AsterGate"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];

      const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(url);
        const headers = new Headers(init?.headers);
        capturedAuth = headers.get('authorization') || headers.get('x-api-key') || '';
        capturedHost = headers.get('host') || '';

        const stream = new ReadableStream({
          async start(controller) {
            for (const chunk of mockSseChunks) {
              controller.enqueue(Buffer.from(chunk, 'utf8'));
            }
            controller.close();
          },
        });

        return new Response(stream, {
          status: 200,
          statusText: 'OK',
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          },
        });
      });

      const handler = new LlmProxyHandler({
        deploymentConfig: fixtureConfig,
        fetchImpl: mockFetch as unknown as typeof fetch,
      });

      const inStream = new PassThrough();
      const outStream = new PassThrough();
      const clientStream = Duplex.from({ readable: inStream, writable: outStream });

      const handlePromise = handler.handle(clientStream, { kind: 'llm' });

      const requestBody = JSON.stringify({
        model: 'claude-fable-5',
        messages: [{ role: 'user', content: 'Say hello' }],
        stream: true,
      });

      inStream.write(
        `POST /llm/cpa-claude/v1/messages HTTP/1.1\r\n` +
        `Host: 127.0.0.1:8787\r\n` +
        `Authorization: Bearer in-container-placeholder\r\n` +
        `Content-Type: application/json\r\n` +
        `Content-Length: ${Buffer.byteLength(requestBody)}\r\n\r\n` +
        requestBody
      );
      inStream.end();

      const receivedChunks: Buffer[] = [];
      for await (const chunk of outStream) {
        receivedChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      await handlePromise;

      expect(capturedUrl).toBe('https://gw.example.com/v1/messages');
      expect(capturedAuth).toBe('Bearer test-secret-token-xyz-123');
      expect(capturedHost).toBe('gw.example.com');

      const fullResponse = Buffer.concat(receivedChunks).toString('utf8');
      expect(fullResponse).toContain('HTTP/1.1 200 OK');
      expect(fullResponse).toContain('content-type: text/event-stream');
      expect(fullResponse).toContain('event: message_start');
      expect(fullResponse).toContain('Hello via AsterGate');

      // Invariant: Real token is never leaked in downstream response wire bytes
      expect(fullResponse).not.toContain('test-secret-token-xyz-123');
    });

    it('executes fallback chain when primary provider returns 503 transient error and records health', async () => {
      const calls: string[] = [];
      const recordedHealth: any[] = [];

      const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = String(url);
        calls.push(urlStr);

        // First call to claude fails with 503
        if (urlStr.startsWith('https://gw.example.com/v1/messages')) {
          return new Response(JSON.stringify({ error: 'Claude service unavailable' }), {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Fallback to gemini succeeds
        return new Response('data: {"type":"chunk","text":"Fallback reply from Gemini"}\n\n', {
          status: 200,
          statusText: 'OK',
          headers: { 'Content-Type': 'text/event-stream' },
        });
      });

      const multiProviderConfig = {
        ...fixtureConfig,
        providers: {
          ...fixtureConfig.providers,
          'cpa-gemini': {
            id: 'cpa-gemini',
            displayName: 'Gemini',
            api: 'google-vertex',
            apiKeyEnv: 'CPA_TOKEN',
            baseURL: 'https://gw.example.com/v1/gemini',
            models: [{ id: 'gemini-3.7-flash-tiered' }],
          },
        },
      };

      const mockRoutingPort = {
        canExecute: vi.fn(() => ({ allowed: true, state: 'closed' })),
        recordHealth: vi.fn(async (h) => { recordedHealth.push(h); }),
      };

      const handler = new LlmProxyHandler({
        deploymentConfig: multiProviderConfig,
        fetchImpl: mockFetch as unknown as typeof fetch,
        modelRoutingPort: mockRoutingPort,
      });

      const inStream = new PassThrough();
      const outStream = new PassThrough();
      const clientStream = Duplex.from({ readable: inStream, writable: outStream });

      const handlePromise = handler.handle(clientStream, { kind: 'llm' });

      const requestBody = JSON.stringify({
        model: 'claude-fable-5',
        messages: [{ role: 'user', content: 'Test prompt' }],
      });

      const fallbackChainHeader = JSON.stringify([
        { provider: 'cpa-gemini', model: 'gemini-3.7-flash-tiered' },
      ]);

      inStream.write(
        `POST /llm/cpa-claude/v1/messages HTTP/1.1\r\n` +
        `Host: 127.0.0.1:8787\r\n` +
        `Authorization: in-container-placeholder\r\n` +
        `x-enkeep-fallback-chain: ${fallbackChainHeader}\r\n` +
        `Content-Type: application/json\r\n` +
        `Content-Length: ${Buffer.byteLength(requestBody)}\r\n\r\n` +
        requestBody
      );
      inStream.end();

      const receivedChunks: Buffer[] = [];
      for await (const chunk of outStream) {
        receivedChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      await handlePromise;

      expect(calls.length).toBe(2);
      expect(calls[0]).toContain('messages');
      expect(calls[1]).toContain('gemini');

      const fullResponse = Buffer.concat(receivedChunks).toString('utf8');
      expect(fullResponse).toContain('HTTP/1.1 200 OK');
      expect(fullResponse).toContain('x-enkeep-model-provider: cpa-gemini');
      expect(fullResponse).toContain('x-enkeep-model-id: gemini-3.7-flash-tiered');
      expect(fullResponse).toContain('x-enkeep-fallback-used: true');
      expect(fullResponse).toContain('Fallback reply from Gemini');

      expect(recordedHealth.length).toBe(2);
      expect(recordedHealth[0].provider).toBe('cpa-claude');
      expect(recordedHealth[0].success).toBe(false);
      expect(recordedHealth[1].provider).toBe('cpa-gemini');
      expect(recordedHealth[1].success).toBe(true);
    });

    it('fails fast without fallback when primary returns 401 Unauthorized', async () => {
      const calls: string[] = [];
      const mockFetch = vi.fn(async (url: string | URL | Request) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ error: 'Unauthorized key' }), {
          status: 401,
          statusText: 'Unauthorized',
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const multiProviderConfig = {
        ...fixtureConfig,
        providers: {
          ...fixtureConfig.providers,
          'cpa-gemini': {
            id: 'cpa-gemini',
            displayName: 'Gemini',
            api: 'google-vertex',
            apiKeyEnv: 'CPA_TOKEN',
            baseURL: 'https://gw.example.com/v1/gemini',
            models: [{ id: 'gemini-3.7-flash-tiered' }],
          },
        },
      };

      const handler = new LlmProxyHandler({
        deploymentConfig: multiProviderConfig,
        fetchImpl: mockFetch as unknown as typeof fetch,
      });

      const inStream = new PassThrough();
      const outStream = new PassThrough();
      const clientStream = Duplex.from({ readable: inStream, writable: outStream });

      const handlePromise = handler.handle(clientStream, { kind: 'llm' });

      const requestBody = JSON.stringify({ model: 'claude-fable-5' });
      const fallbackChainHeader = JSON.stringify([
        { provider: 'cpa-gemini', model: 'gemini-3.7-flash-tiered' },
      ]);

      inStream.write(
        `POST /llm/cpa-claude/v1/messages HTTP/1.1\r\n` +
        `Host: 127.0.0.1:8787\r\n` +
        `Authorization: in-container-placeholder\r\n` +
        `x-enkeep-fallback-chain: ${fallbackChainHeader}\r\n` +
        `Content-Type: application/json\r\n` +
        `Content-Length: ${Buffer.byteLength(requestBody)}\r\n\r\n` +
        requestBody
      );
      inStream.end();

      const receivedChunks: Buffer[] = [];
      for await (const chunk of outStream) {
        receivedChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      await handlePromise;

      // Fail-fast: only 1 attempt, no fallback to gemini!
      expect(calls.length).toBe(1);
      const fullResponse = Buffer.concat(receivedChunks).toString('utf8');
      expect(fullResponse).toContain('HTTP/1.1 401 Unauthorized');
    });

    it('does NOT fallback to next model when upstream stream fails mid-stream after bytes sent', async () => {
      const calls: string[] = [];
      const recordedHealth: any[] = [];
      const mockRoutingPort = {
        canExecute: vi.fn(() => ({ allowed: true, state: 'closed' })),
        recordHealth: vi.fn((h) => recordedHealth.push(h)),
      };

      const mockFetch = vi.fn(async (url: string | URL | Request) => {
        const u = String(url);
        calls.push(u);
        if (u.includes('messages')) {
          // Stream that yields one chunk and then throws a network/stream error
          const brokenStream = new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode('event: message\ndata: {"chunk": 1}\n\n'));
              // Simulate broken connection mid-stream
              controller.error(new Error('Connection reset by peer mid-stream'));
            },
          });
          return new Response(brokenStream, {
            status: 200,
            statusText: 'OK',
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }
        return new Response('Fallback should NOT be called', { status: 200 });
      });

      const multiProviderConfig = {
        ...fixtureConfig,
        providers: {
          ...fixtureConfig.providers,
          'cpa-gemini': {
            id: 'cpa-gemini',
            displayName: 'Gemini',
            api: 'google-vertex',
            apiKeyEnv: 'CPA_TOKEN',
            baseURL: 'https://gw.example.com/v1/gemini',
            models: [{ id: 'gemini-3.7-flash-tiered' }],
          },
        },
      };

      const handler = new LlmProxyHandler({
        deploymentConfig: multiProviderConfig,
        fetchImpl: mockFetch as unknown as typeof fetch,
        modelRoutingPort: mockRoutingPort,
      });

      const inStream = new PassThrough();
      const outStream = new PassThrough();
      const clientStream = Duplex.from({ readable: inStream, writable: outStream });
      clientStream.on('error', () => {});
      outStream.on('error', () => {});

      const handlePromise = handler.handle(clientStream, { kind: 'llm' });

      const requestBody = JSON.stringify({ model: 'claude-fable-5' });
      const fallbackChainHeader = JSON.stringify([
        { provider: 'cpa-gemini', model: 'gemini-3.7-flash-tiered' },
      ]);

      inStream.write(
        `POST /llm/cpa-claude/v1/messages HTTP/1.1\r\n` +
        `Host: 127.0.0.1:8787\r\n` +
        `Authorization: in-container-placeholder\r\n` +
        `x-enkeep-fallback-chain: ${fallbackChainHeader}\r\n` +
        `Content-Type: application/json\r\n` +
        `Content-Length: ${Buffer.byteLength(requestBody)}\r\n\r\n` +
        requestBody
      );
      inStream.end();

      const receivedChunks: Buffer[] = [];
      outStream.on('data', (chunk) => {
        receivedChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      });

      await handlePromise;

      // Must NOT attempt gemini fallback when stream already started!
      expect(calls.length).toBe(1);
      expect(calls[0]).toContain('messages');

      // Health failure recorded for mid-stream error
      expect(recordedHealth.length).toBe(2); // 1 initial 200, 1 mid-stream failure
      expect(recordedHealth[1].errorType).toBe('STREAM_MID_FAILURE');
      expect(recordedHealth[1].success).toBe(false);
    });

    it('circuit breaker: skips open circuit primary candidate on next request and routes directly to fallback', async () => {
      const calls: string[] = [];
      let breakerState = 'open';
      const mockRoutingPort = {
        canExecute: vi.fn((prov: string) => {
          if (prov === 'cpa-claude') {
            return { allowed: breakerState !== 'open', state: breakerState, reason: 'Circuit tripped' };
          }
          return { allowed: true, state: 'closed' };
        }),
        recordHealth: vi.fn(),
      };

      const mockFetch = vi.fn(async (url: string | URL | Request) => {
        calls.push(String(url));
        return new Response('Fallback success from Gemini', {
          status: 200,
          statusText: 'OK',
          headers: { 'Content-Type': 'text/plain' },
        });
      });

      const multiProviderConfig = {
        ...fixtureConfig,
        providers: {
          ...fixtureConfig.providers,
          'cpa-gemini': {
            id: 'cpa-gemini',
            displayName: 'Gemini',
            api: 'google-vertex',
            apiKeyEnv: 'CPA_TOKEN',
            baseURL: 'https://gw.example.com/v1/gemini',
            models: [{ id: 'gemini-3.7-flash-tiered' }],
          },
        },
      };

      const handler = new LlmProxyHandler({
        deploymentConfig: multiProviderConfig,
        fetchImpl: mockFetch as unknown as typeof fetch,
        modelRoutingPort: mockRoutingPort,
      });

      const inStream = new PassThrough();
      const outStream = new PassThrough();
      const clientStream = Duplex.from({ readable: inStream, writable: outStream });

      const handlePromise = handler.handle(clientStream, { kind: 'llm' });

      const requestBody = JSON.stringify({ model: 'claude-fable-5' });
      const fallbackChainHeader = JSON.stringify([
        { provider: 'cpa-gemini', model: 'gemini-3.7-flash-tiered' },
      ]);

      inStream.write(
        `POST /llm/cpa-claude/v1/messages HTTP/1.1\r\n` +
        `Host: 127.0.0.1:8787\r\n` +
        `Authorization: in-container-placeholder\r\n` +
        `x-enkeep-fallback-chain: ${fallbackChainHeader}\r\n` +
        `Content-Type: application/json\r\n` +
        `Content-Length: ${Buffer.byteLength(requestBody)}\r\n\r\n` +
        requestBody
      );
      inStream.end();

      const receivedChunks: Buffer[] = [];
      for await (const chunk of outStream) {
        receivedChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      await handlePromise;

      // Primary was skipped due to open circuit; only fallback Gemini was called!
      expect(calls.length).toBe(1);
      expect(calls[0]).toContain('gemini');

      const fullResponse = Buffer.concat(receivedChunks).toString('utf8');
      expect(fullResponse).toContain('x-enkeep-model-provider: cpa-gemini');
      expect(fullResponse).toContain('x-enkeep-fallback-used: true');
    });
  });
});

describe('In-Container DSH Boot with Pi-Ai Adapter Tests', () => {
  const originalEnv = process.env;
  let testHomeDir: string;
  let testSpacesDir: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    const tmp = os.tmpdir();
    const nonce = Math.random().toString(36).substring(2, 10);
    const baseParent = path.join(tmp, `test-dsh-env-${nonce}`);
    testHomeDir = path.join(baseParent, 'home');
    testSpacesDir = path.join(baseParent, 'spaces');

    fs.mkdirSync(testHomeDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(testSpacesDir, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    process.env = originalEnv;
    try {
      fs.rmSync(path.dirname(testHomeDir), { recursive: true, force: true });
    } catch {}
  });

  it('boots in DemoModel mode when ENKEEP_LLM_ENABLED is not set and reports modelProvider: "demo"', async () => {
    delete process.env.ENKEEP_LLM_ENABLED;

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: testHomeDir,
      spacesDir: testSpacesDir,
    });

    try {
      expect(runtime.modelProvider).toBe('demo');
      const health = await runtime.getHealth();
      expect(health.status).toBe('ok');
      expect(health.modelProvider).toBe('demo');

      const followupRes = await runtime.sendFollowup(
        'Hello demo',
        'ses_0123456789abcdef0123456789abcdef',
        'turn_0123456789abcdef0123456789abcdef',
        null
      );
      expect(followupRes.status).toBe('completed');
      if (followupRes.status === 'completed') {
        expect(followupRes.replyText).toContain('[DemoModel:alice]');
        expect(followupRes.usage?.totalTokens).toBeGreaterThanOrEqual(1);
      }
    } finally {
      await runtime.dispose();
    }
  });

  it('boots in PiAiAdapter mode when ENKEEP_LLM_ENABLED=1 with in-container rewritten providers', async () => {
    process.env.ENKEEP_LLM_ENABLED = '1';
    process.env.ENKEEP_LLM_PROVIDER = 'cpa-claude';
    process.env.ENKEEP_LLM_MODEL = 'claude-fable-5';

    // Mock local tunnel server on 127.0.0.1
    const mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        // Assert container sends in-container placeholder token
        const auth = req.headers['authorization'] || req.headers['x-api-key'];
        if (!auth || (!auth.includes('in-container') && !auth.includes('IN_CONTAINER'))) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Expected placeholder token' }));
          return;
        }

        // Return mock Anthropic SSE stream with valid message_start usage
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_mock","type":"message","role":"assistant","content":[],"model":"claude-fable-5","usage":{"input_tokens":10,"output_tokens":0}}}\n\n');
        res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Mock Claude response through tunnel"}}\n\n');
        res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
        res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":15}}\n\n');
        res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        res.end();
      });
    });

    const mockPort = await new Promise<number>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => {
        const addr = mockServer.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 8787);
      });
    });

    const inContainerProviders = {
      'cpa-claude': {
        displayName: 'Claude',
        apiKeyEnv: 'IN_CONTAINER_PLACEHOLDER',
        api: 'anthropic-messages',
        baseURL: `http://127.0.0.1:${mockPort}/llm/cpa-claude`,
        defaultContextWindow: 1000000,
        defaultMaxTokens: 128000,
        models: [
          { id: 'claude-fable-5' },
        ],
      },
    };

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
      expect(runtime.modelProvider).toBe('cpa-claude');
      const health = await runtime.getHealth();
      expect(health.status).toBe('ok');
      expect(health.modelProvider).toBe('cpa-claude');

      const followupRes = await runtime.sendFollowup(
        'Hello Claude',
        'ses_0123456789abcdef0123456789abcdef',
        'turn_0123456789abcdef0123456789abcdef',
        null
      );

      expect(followupRes.status).toBe('completed');
      if (followupRes.status === 'completed') {
        expect(followupRes.replyText).toBe('Mock Claude response through tunnel');
        expect(followupRes.usage?.totalTokens).toBeGreaterThanOrEqual(1);
      }
    } finally {
      await runtime.dispose();
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    }
  });

  it('fails closed with MISSING_CREDENTIAL when in-container placeholder env variable is missing', async () => {
    process.env.ENKEEP_LLM_ENABLED = '1';
    process.env.ENKEEP_LLM_PROVIDER = 'cpa-claude';
    process.env.ENKEEP_LLM_MODEL = 'claude-fable-5';
    // Explicitly delete placeholder variable
    delete process.env.IN_CONTAINER_PLACEHOLDER;

    const inContainerProviders = {
      'cpa-claude': {
        displayName: 'Claude',
        apiKeyEnv: 'IN_CONTAINER_PLACEHOLDER',
        api: 'anthropic-messages',
        baseURL: `http://127.0.0.1:8787/llm/cpa-claude`,
        models: [{ id: 'claude-fable-5' }],
      },
    };

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: testHomeDir,
      spacesDir: testSpacesDir,
      llmEnabled: true,
      provider: 'cpa-claude',
      model: 'claude-fable-5',
      providers: inContainerProviders,
    });

    // Explicitly ensure the variable remains deleted after boot
    delete process.env.IN_CONTAINER_PLACEHOLDER;

    try {
      await expect(
        runtime.sendFollowup(
          'Hello without placeholder token',
          'ses_0123456789abcdef0123456789abcdef',
          'turn_0123456789abcdef0123456789abcdef',
          null
        )
      ).rejects.toThrow(/FAIL-CLOSED: Assistant completed turn but produced empty replyText|MISSING_CREDENTIAL|no credential/);
    } finally {
      await runtime.dispose();
    }
  });
});

describe('Live Opt-In Real Gateway E2E Test (cpa-gemini)', () => {
  const localConfig = loadDshDeploymentConfig();
  const hasLocalConfigAndToken = Boolean(
    localConfig &&
    localConfig.providers &&
    localConfig.providers['cpa-gemini'] &&
    localConfig.tokens['CPA_TOKEN'] &&
    localConfig.tokens['CPA_TOKEN'].trim().length > 0
  );

  it.skipIf(!hasLocalConfigAndToken)(
    'executes real end-to-end completion against AsterGate gateway via LlmProxyHandler',
    async () => {
      const proxyHandler = createLlmProxyHandler({ deploymentConfig: localConfig });

      const server = http.createServer((req, res) => {
        proxyHandler.handleHttpRequest(req, res);
      });

      const port = await new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          resolve(typeof addr === 'object' && addr ? addr.port : 0);
        });
      });

      try {
        const response = await fetch(`http://127.0.0.1:${port}/llm/cpa-gemini/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': 'in-container-placeholder',
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'gemini-3.7-flash-tiered',
            max_tokens: 1024,
            messages: [{ role: 'user', content: 'Reply with only the exact word "ENKEEP_GATEWAY_SUCCESS".' }],
          }),
        });

        expect(response.status).toBe(200);
        const json: any = await response.json();
        const contentText = (json.content || []).map((c: any) => c.text || '').join('');
        expect(contentText).toContain('ENKEEP_GATEWAY_SUCCESS');
        expect(contentText).not.toContain('[DemoModel');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    30000
  );

  if (!hasLocalConfigAndToken) {
    it('informs developer that live gateway E2E test was safely skipped without local DSH configuration', () => {
      console.log('ℹ Opt-in Live Gateway E2E test was safely skipped because $DSH_HOME deployment config or CPA_TOKEN is not available.');
      expect(true).toBe(true);
    });
  }
});
