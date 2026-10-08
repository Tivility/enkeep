import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  bootDshRuntime,
  type BootedDshRuntime,
} from '../src/runtime/dsh-boot.js';
import { HostLlmProxyServer } from '../src/host/llm-proxy-server.js';
import type { DshDeploymentConfig } from '../src/config/dsh-config-loader.js';
import {
  resolveTopLevelCacheRetention,
  resolveChildCacheRetention,
  getPlatformTopLevelCacheRetention,
  getPlatformChildCacheRetention,
} from '@enkeep/platform-core';

describe('Layered Prompt Cache Retention in Runtime (Synthetic End-to-End Tests)', () => {
  let tempDir: string;
  let dshHome: string;
  let spacesDir: string;
  let runtime: BootedDshRuntime;
  let mockUpstreamServer: http.Server;
  let mockUpstreamPort: number;
  let proxyServer: HostLlmProxyServer;
  let proxyBaseUrl: string;

  const capturedRequests: Array<{ url: string; headers: http.IncomingHttpHeaders; body: any }> = [];
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    delete process.env.ENKEEP_CACHE_RETENTION_TOP;
    delete process.env.ENKEEP_CACHE_RETENTION_CHILD;
    process.env.CPA_TOKEN = 'synthetic-token-xyz';
    process.env.IN_CONTAINER_PLACEHOLDER = 'in-container';

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-cache-runtime-test-'));
    dshHome = path.join(tempDir, '.dsh');
    spacesDir = path.join(tempDir, 'spaces');
    fs.mkdirSync(dshHome, { recursive: true });
    fs.mkdirSync(spacesDir, { recursive: true });

    capturedRequests.length = 0;

    // 1. Setup mock upstream HTTP gateway
    mockUpstreamServer = http.createServer((req, res) => {
      const url = req.url || '';
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        let parsedBody: any = null;
        try {
          parsedBody = JSON.parse(rawBody);
        } catch {
          parsedBody = rawBody;
        }
        capturedRequests.push({ url, headers: req.headers, body: parsedBody });

        if (url.includes('/claude')) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });
          res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-3-7-sonnet-20250219","usage":{"input_tokens":10,"output_tokens":0}}}\n\n');
          res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
          res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Synthetic Anthropic response"}}\n\n');
          res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
          res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}\n\n');
          res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
          res.end();
        } else if (url.includes('/openai')) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });
          res.write('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1234567890,"model":"gpt-5.6-sol","choices":[{"index":0,"delta":{"role":"assistant","content":"Synthetic OpenAI response"},"finish_reason":null}]}\n\n');
          res.write('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1234567890,"model":"gpt-5.6-sol","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      });
    });

    mockUpstreamPort = await new Promise<number>((resolve) => {
      mockUpstreamServer.listen(0, '127.0.0.1', () => {
        const addr = mockUpstreamServer.address() as AddressInfo;
        resolve(addr.port);
      });
    });

    // 2. Setup HostLlmProxyServer pointing to mock upstream
    const deploymentConfig: DshDeploymentConfig = {
      defaultModel: 'cpa-claude/claude-3-7-sonnet-20250219',
      allowedHosts: ['127.0.0.1', 'localhost'],
      tokens: {
        CPA_TOKEN: 'synthetic-token-xyz',
      },
      providers: {
        'cpa-claude': {
          id: 'cpa-claude',
          displayName: 'Claude',
          api: 'anthropic-messages',
          apiKeyEnv: 'CPA_TOKEN',
          baseURL: `http://127.0.0.1:${mockUpstreamPort}/claude`,
          models: [{ id: 'claude-3-7-sonnet-20250219' }],
        },
        'cpa-gpt': {
          id: 'cpa-gpt',
          displayName: 'OpenAI GPT',
          api: 'openai-completions',
          apiKeyEnv: 'CPA_TOKEN',
          baseURL: `http://127.0.0.1:${mockUpstreamPort}/openai`,
          models: [{ id: 'gpt-5.6-sol' }],
        },
      },
    };

    proxyServer = new HostLlmProxyServer({
      deploymentConfig,
    });
    proxyBaseUrl = await proxyServer.start();
  });

  afterEach(async () => {
    if (runtime) {
      try {
        await runtime.dispose();
      } catch {}
    }
    if (mockUpstreamServer) {
      await new Promise<void>((resolve) => mockUpstreamServer.close(() => resolve()));
    }
    process.env = { ...originalEnv };
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('1. End-to-end Anthropic request has cache_control ttl 1h for long, default (no ttl) for short, and no cache_control for none', async () => {
    process.env.ENKEEP_LLM_PROXY_TOKEN = proxyServer.getAuthToken();

    runtime = await bootDshRuntime({
      userId: 'alice_synth',
      dshHome,
      spacesDir,
      provider: 'cpa-claude',
      model: 'claude-3-7-sonnet-20250219',
      llmEnabled: true,
      llmBaseUrl: proxyBaseUrl,
      providers: {
        'cpa-claude': {
          id: 'cpa-claude',
          displayName: 'Claude',
          api: 'anthropic-messages',
          apiKeyEnv: 'CPA_TOKEN',
          baseURL: `${proxyBaseUrl}/cpa-claude`,
          models: [{ id: 'claude-3-7-sonnet-20250219' }],
        },
      },
    });

    const sessionId = 'ses_00000000000000000000000000000001';

    // Step A: Turn with cacheRetention: 'long'
    const turn1Id = 'turn_00000000000000000000000000000001';
    const res1 = await runtime.sendFollowup({
      prompt: 'Test turn 1 with long retention',
      sessionId,
      turnId: turn1Id,
      profile: null,
      cacheRetention: 'long',
    });
    expect(res1.status).toBe('completed');
    expect(capturedRequests.length).toBe(1);

    const req1 = capturedRequests[0]!;
    expect(req1.url).toContain('/claude');
    // Verify outgoing Anthropic body has cache_control with ttl: '1h'
    const req1Body = req1.body;
    let foundLongTtl = false;
    const checkTtl = (obj: any) => {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) {
        for (const item of obj) checkTtl(item);
        return;
      }
      if (obj.cache_control && typeof obj.cache_control === 'object') {
        expect(obj.cache_control.type).toBe('ephemeral');
        expect(obj.cache_control.ttl).toBe('1h');
        foundLongTtl = true;
      }
      for (const val of Object.values(obj)) checkTtl(val);
    };
    checkTtl(req1Body);
    expect(foundLongTtl).toBe(true);

    // Step B: Turn with cacheRetention: 'short'
    capturedRequests.length = 0;
    const turn2Id = 'turn_00000000000000000000000000000002';
    const res2 = await runtime.sendFollowup({
      prompt: 'Test turn 2 with short retention',
      sessionId,
      turnId: turn2Id,
      profile: null,
      cacheRetention: 'short',
    });
    expect(res2.status).toBe('completed');
    expect(capturedRequests.length).toBe(1);

    const req2 = capturedRequests[0]!;
    const req2Body = req2.body;
    let foundShortCache = false;
    const checkShort = (obj: any) => {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) {
        for (const item of obj) checkShort(item);
        return;
      }
      if (obj.cache_control && typeof obj.cache_control === 'object') {
        expect(obj.cache_control.type).toBe('ephemeral');
        expect(obj.cache_control.ttl).toBeUndefined();
        foundShortCache = true;
      }
      for (const val of Object.values(obj)) checkShort(val);
    };
    checkShort(req2Body);
    expect(foundShortCache).toBe(true);

    // Step C: Turn with cacheRetention: 'none'
    capturedRequests.length = 0;
    const turn3Id = 'turn_00000000000000000000000000000003';
    const res3 = await runtime.sendFollowup({
      prompt: 'Test turn 3 with none retention',
      sessionId,
      turnId: turn3Id,
      profile: null,
      cacheRetention: 'none',
    });
    expect(res3.status).toBe('completed');
    expect(capturedRequests.length).toBe(1);

    const req3 = capturedRequests[0]!;
    const req3Body = req3.body;
    let foundAnyCacheControl = false;
    const checkNone = (obj: any) => {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) {
        for (const item of obj) checkNone(item);
        return;
      }
      if (obj.cache_control !== undefined) {
        foundAnyCacheControl = true;
      }
      for (const val of Object.values(obj)) checkNone(val);
    };
    checkNone(req3Body);
    expect(foundAnyCacheControl).toBe(false);
  });

  it('2. OpenAI path gets prompt_cache_retention: "24h" for long, and no prompt_cache_retention for short/none', async () => {
    process.env.ENKEEP_LLM_PROXY_TOKEN = proxyServer.getAuthToken();

    runtime = await bootDshRuntime({
      userId: 'alice_synth',
      dshHome,
      spacesDir,
      provider: 'cpa-gpt',
      model: 'gpt-5.6-sol',
      llmEnabled: true,
      llmBaseUrl: proxyBaseUrl,
      providers: {
        'cpa-gpt': {
          id: 'cpa-gpt',
          displayName: 'OpenAI GPT',
          api: 'openai-completions',
          apiKeyEnv: 'CPA_TOKEN',
          baseURL: `${proxyBaseUrl}/cpa-gpt`,
          models: [{ id: 'gpt-5.6-sol' }],
        },
      },
    });

    const sessionId = 'ses_00000000000000000000000000000002';

    // Step A: OpenAI with long retention
    const turn1Id = 'turn_00000000000000000000000000000001';
    const res1 = await runtime.sendFollowup({
      prompt: 'OpenAI prompt with long retention',
      sessionId,
      turnId: turn1Id,
      profile: null,
      cacheRetention: 'long',
    });
    expect(res1.status).toBe('completed');
    expect(capturedRequests.length).toBe(1);

    const req1 = capturedRequests[0]!;
    expect(req1.url).toContain('/openai');
    expect(req1.body.prompt_cache_retention).toBe('24h');

    // Step B: OpenAI with short retention
    capturedRequests.length = 0;
    const turn2Id = 'turn_00000000000000000000000000000002';
    const res2 = await runtime.sendFollowup({
      prompt: 'OpenAI prompt with short retention',
      sessionId,
      turnId: turn2Id,
      profile: null,
      cacheRetention: 'short',
    });
    expect(res2.status).toBe('completed');
    expect(capturedRequests.length).toBe(1);

    const req2 = capturedRequests[0]!;
    expect(req2.body.prompt_cache_retention).toBeUndefined();

    // Step C: OpenAI with none retention
    capturedRequests.length = 0;
    const turn3Id = 'turn_00000000000000000000000000000003';
    const res3 = await runtime.sendFollowup({
      prompt: 'OpenAI prompt with none retention',
      sessionId,
      turnId: turn3Id,
      profile: null,
      cacheRetention: 'none',
    });
    expect(res3.status).toBe('completed');
    expect(capturedRequests.length).toBe(1);

    const req3 = capturedRequests[0]!;
    expect(req3.body.prompt_cache_retention).toBeUndefined();
    expect(req3.body.prompt_cache_key).toBeUndefined();
  });

  it('3. Subagent / child agent requests strictly resolve child default (short), even when parent session is configured with long or none', async () => {
    process.env.ENKEEP_LLM_PROXY_TOKEN = proxyServer.getAuthToken();

    runtime = await bootDshRuntime({
      userId: 'alice_synth',
      dshHome,
      spacesDir,
      provider: 'cpa-claude',
      model: 'claude-3-7-sonnet-20250219',
      llmEnabled: true,
      llmBaseUrl: proxyBaseUrl,
      providers: {
        'cpa-claude': {
          id: 'cpa-claude',
          displayName: 'Claude',
          api: 'anthropic-messages',
          apiKeyEnv: 'CPA_TOKEN',
          baseURL: `${proxyBaseUrl}/cpa-claude`,
          models: [{ id: 'claude-3-7-sonnet-20250219' }],
        },
      },
    });

    const topSessionId = 'ses_00000000000000000000000000000003';

    // Top-level session has 'long' retention
    const topRes = resolveTopLevelCacheRetention({ sessionRetention: 'long' });
    expect(topRes.retention).toBe('long');

    // Child subagent strictly resolves child default 'short'
    const childRetention = resolveChildCacheRetention();
    expect(childRetention.retention).toBe('short');
    expect(childRetention.source).toBe('child_default');

    // Send a turn on top-level session
    const turn1Id = 'turn_00000000000000000000000000000001';
    await runtime.sendFollowup({
      prompt: 'Top-level turn with long',
      sessionId: topSessionId,
      turnId: turn1Id,
      profile: null,
      cacheRetention: 'long',
    });
    expect(capturedRequests.length).toBe(1);

    // Verify outgoing Anthropic body has ttl: '1h' on top-level session
    const topBody = capturedRequests[0]!.body;
    let foundTopTtl = false;
    const inspectTopTtl = (obj: any) => {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) {
        for (const item of obj) inspectTopTtl(item);
        return;
      }
      if (obj.cache_control && typeof obj.cache_control === 'object') {
        if (obj.cache_control.ttl === '1h') foundTopTtl = true;
      }
      for (const val of Object.values(obj)) inspectTopTtl(val);
    };
    inspectTopTtl(topBody);
    expect(foundTopTtl).toBe(true);

    // Trigger a child session request
    capturedRequests.length = 0;
    const childSessionId = 'ses_0000000000000000000000000000000c';
    const childTurnId = 'turn_0000000000000000000000000000000c';
    await runtime.sendFollowup({
      prompt: 'Child agent turn',
      sessionId: childSessionId,
      turnId: childTurnId,
      profile: null,
      cacheRetention: 'short',
    });
    expect(capturedRequests.length).toBe(1);

    // Check outgoing Anthropic body on child request has default (no ttl)
    const childBody = capturedRequests[0]!.body;
    let foundChildTtl = false;
    let foundChildCacheControl = false;
    const inspectChild = (obj: any) => {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) {
        for (const item of obj) inspectChild(item);
        return;
      }
      if (obj.cache_control && typeof obj.cache_control === 'object') {
        foundChildCacheControl = true;
        if (obj.cache_control.ttl) foundChildTtl = true;
      }
      for (const val of Object.values(obj)) inspectChild(val);
    };
    inspectChild(childBody);
    expect(foundChildCacheControl).toBe(true);
    expect(foundChildTtl).toBe(false);
  });

  it('4. Real subagent and workflow child agents run through composition, complete step 1 with JSON-serializable request/header, and use short retention', async () => {
    process.env.ENKEEP_LLM_PROXY_TOKEN = proxyServer.getAuthToken();

    runtime = await bootDshRuntime({
      userId: 'alice_synth',
      dshHome,
      spacesDir,
      provider: 'cpa-claude',
      model: 'claude-3-7-sonnet-20250219',
      llmEnabled: true,
      llmBaseUrl: proxyBaseUrl,
      providers: {
        'cpa-claude': {
          id: 'cpa-claude',
          displayName: 'Claude',
          api: 'anthropic-messages',
          apiKeyEnv: 'CPA_TOKEN',
          baseURL: `${proxyBaseUrl}/cpa-claude`,
          models: [{ id: 'claude-3-7-sonnet-20250219' }],
        },
      },
    });

    const parentSessionId = 'ses_00000000000000000000000000000004';

    // Step A: Top-level turn with long cache retention
    const turn1Id = 'turn_00000000000000000000000000000001';
    await runtime.sendFollowup({
      prompt: 'Top-level turn with long cache retention',
      sessionId: parentSessionId,
      turnId: turn1Id,
      profile: null,
      cacheRetention: 'long',
    });
    expect(capturedRequests.length).toBe(1);

    // Verify parent outgoing request had ttl: '1h'
    const parentBody = capturedRequests[0]!.body;
    let foundParentTtl = false;
    const inspectTtl = (obj: any) => {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) {
        for (const item of obj) inspectTtl(item);
        return;
      }
      if (obj.cache_control && typeof obj.cache_control === 'object') {
        if (obj.cache_control.ttl === '1h') foundParentTtl = true;
      }
      for (const val of Object.values(obj)) inspectTtl(val);
    };
    inspectTtl(parentBody);
    expect(foundParentTtl).toBe(true);

    // Step B: Dispatch real subagent tool execution under parent agent
    capturedRequests.length = 0;
    const parentAgent = await runtime.getOrCreateAgent(parentSessionId, null, 'space-synthetic-01');
    const toolsRegistry = parentAgent.ctx.get('tools');
    const subagentTool = toolsRegistry.get('subagent', parentAgent);
    expect(subagentTool).toBeDefined();

    const subagentResult = await subagentTool.execute(
      {
        description: 'verify-child-delegation',
        prompt: 'Say CHILD_PONG in one word',
        run_in_background: false,
      },
      { agent: parentAgent, signal: new AbortController().signal } as any
    );

    expect(subagentResult).toBeDefined();
    expect(subagentResult.kind).toBe('foreground');
    expect(subagentResult.output?.[0]?.text).toBe('Synthetic Anthropic response');

    // Verify subagent child session jsonl has valid JSON-serializable request/header
    const sessionsDir = path.join(dshHome, 'sessions');
    const sessionFiles: string[] = [];
    if (fs.existsSync(sessionsDir)) {
      const entries = fs.readdirSync(sessionsDir, { recursive: true });
      for (const e of entries) {
        const full = path.join(sessionsDir, String(e));
        if (fs.statSync(full).isFile() && (full.endsWith('.jsonl') || full.endsWith('.v4.jsonl'))) {
          sessionFiles.push(full);
        }
      }
    }

    const subagentSessionFile = sessionFiles.find((f) => !f.includes(parentSessionId));
    expect(subagentSessionFile).toBeDefined();

    const subLines = fs.readFileSync(subagentSessionFile!, 'utf8').trim().split('\n');
    const subEvents = subLines.map((l) => JSON.parse(l));

    const requestHeaderEvent = subEvents.find((e) => e.type === 'request/header');
    expect(requestHeaderEvent).toBeDefined();
    expect(requestHeaderEvent.data.header.config.provider).toBe('cpa-claude');
    expect(requestHeaderEvent.data.header.config.model).toBe('claude-3-7-sonnet-20250219');
    // Ensure no undefined keys exist in serialized event
    expect(JSON.stringify(requestHeaderEvent.data)).not.toContain('undefined');

    // Verify child outgoing Anthropic request has short retention (ephemeral, no ttl 1h)
    expect(capturedRequests.length).toBeGreaterThanOrEqual(1);
    const childReqBody = capturedRequests[0]!.body;
    let foundChildReqTtl = false;
    let foundChildReqCacheControl = false;
    const inspectChildReq = (obj: any) => {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) {
        for (const item of obj) inspectChildReq(item);
        return;
      }
      if (obj.cache_control && typeof obj.cache_control === 'object') {
        foundChildReqCacheControl = true;
        if (obj.cache_control.ttl) foundChildReqTtl = true;
      }
      for (const val of Object.values(obj)) inspectChildReq(val);
    };
    inspectChildReq(childReqBody);
    expect(foundChildReqCacheControl).toBe(true);
    expect(foundChildReqTtl).toBe(false);

    // Step C: Dispatch real workflow tool execution with child agent under parent agent
    capturedRequests.length = 0;
    const workflowTool = toolsRegistry.get('workflow', parentAgent);
    expect(workflowTool).toBeDefined();

    const meta = {
      name: 'synthetic-subagent-wf-test',
      description: 'Run workflow with child agent',
    };
    const script = `
      const childRes = await agent("Synthesize test response");
      return { ok: true, childRes };
    `;

    const wfResult = await workflowTool.execute(
      { meta, script },
      { agent: parentAgent, signal: new AbortController().signal } as any
    );

    expect(wfResult).toBeDefined();
    expect(wfResult.kind).toBe('foreground');
    expect(wfResult.result?.ok).toBe(true);
    expect(wfResult.result?.childRes).toBe('Synthetic Anthropic response');

    // Verify workflow child session also has valid request/header
    const updatedSessionFiles: string[] = [];
    if (fs.existsSync(sessionsDir)) {
      const entries = fs.readdirSync(sessionsDir, { recursive: true });
      for (const e of entries) {
        const full = path.join(sessionsDir, String(e));
        if (fs.statSync(full).isFile() && (full.endsWith('.jsonl') || full.endsWith('.v4.jsonl'))) {
          updatedSessionFiles.push(full);
        }
      }
    }

    const wfSessionFiles = updatedSessionFiles.filter((f) => !f.includes(parentSessionId) && f !== subagentSessionFile);
    expect(wfSessionFiles.length).toBeGreaterThanOrEqual(1);

    const wfChildLines = fs.readFileSync(wfSessionFiles[0]!, 'utf8').trim().split('\n');
    const wfChildEvents = wfChildLines.map((l) => JSON.parse(l));

    const wfRequestHeader = wfChildEvents.find((e) => e.type === 'request/header');
    expect(wfRequestHeader).toBeDefined();
    expect(wfRequestHeader.data.header.config.provider).toBe('cpa-claude');
    expect(wfRequestHeader.data.header.config.model).toBe('claude-3-7-sonnet-20250219');
    expect(JSON.stringify(wfRequestHeader.data)).not.toContain('undefined');
  });
});
