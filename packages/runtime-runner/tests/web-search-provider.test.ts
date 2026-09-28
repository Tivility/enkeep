/**
 * Generic Deterministic Unit Tests for WebSearch Provider Integration in Enkeep
 *
 * Requirements:
 * - Generic deterministic fake searchprovider query yields real tool record;
 *   mocked business provider with zero external calls.
 * - Unconfigured: no advertised web_search tool, web_fetch remains available.
 * - Incorrectly configured: clear error (WEB_PROVIDER_CONFIGURED_MISSING /
 *   WEB_PROVIDER_CONFIGURED_UNAVAILABLE / WEB_PROVIDER_CREDENTIAL_MISSING) respects optional.
 * - Actual model tool exposure (ctx.tools.get('web_search')), not just a service boolean.
 * - Runtime child agent inherits tools.
 * - CPA_TOKEN is not DeepSeek key; credential reference preserved without raw token values.
 *
 * @module @enkeep/runtime-runner/tests/web-search-provider.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WebError, type WebSearchProvider, type WebSearchRequest, type WebSearchResult } from '@deepseek-ai/dsh-web';
import { bootDshRuntime } from '../src/runtime/dsh-boot.js';
import { parseDshConfigFiles } from '../src/config/dsh-config-loader.js';

describe('G09 WebSearch Provider Integration & Model Tool Exposure', () => {
  let tmpDir: string;
  let dshHome: string;
  let spacesDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-web-search-test-'));
    dshHome = path.join(tmpDir, '.dsh');
    spacesDir = path.join(tmpDir, 'spaces');

    fs.mkdirSync(dshHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spacesDir, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('Unconfigured State (No Search Provider Available)', () => {
    it('does NOT advertise web_search tool to model when unconfigured, while web_fetch remains active', async () => {
      const runtime = await bootDshRuntime({
        userId: 'alice',
        dshHome,
        spacesDir,
      });

      try {
        const sessionId = 'ses_0123456789abcdef0123456789abcde1';
        const agent = await runtime.getOrCreateAgent(sessionId);
        const toolsService = agent.ctx.get('tools');
        expect(toolsService).toBeDefined();

        // web_fetch must be available by default
        const fetchTool = toolsService.get('web_fetch', agent);
        expect(fetchTool).toBeDefined();
        expect(fetchTool.name).toBe('web_fetch');

        // web_search must NOT be advertised to model
        const searchTool = toolsService.get('web_search', agent);
        expect(searchTool).toBeUndefined();

        // Direct search on unconfigured web service throws WEB_PROVIDER_UNAVAILABLE
        const web = runtime.context.get('web');
        expect(web).toBeDefined();
        await expect(web.search({ query: 'unconfigured search query' })).rejects.toThrow(WebError);
        try {
          await web.search({ query: 'unconfigured search query' });
        } catch (err) {
          expect(err).toBeInstanceOf(WebError);
          expect((err as WebError).code).toBe('WEB_PROVIDER_UNAVAILABLE');
        }

        // Capabilities probe reports search false, fetch true
        const caps = await runtime.getCapabilities?.();
        expect(caps?.web?.fetch).toBe(true);
        expect(caps?.web?.search).toBe(false);
      } finally {
        await runtime.dispose();
      }
    });
  });

  describe('Incorrectly Configured Provider (Missing or Unavailable)', () => {
    it('throws WEB_PROVIDER_CONFIGURED_MISSING when searchProvider is set but not registered, and hides tool', async () => {
      const runtime = await bootDshRuntime({
        userId: 'alice',
        dshHome,
        spacesDir,
        web: {
          searchProvider: 'non-existent-provider',
        },
      });

      try {
        const sessionId = 'ses_0123456789abcdef0123456789abcde2';
        const agent = await runtime.getOrCreateAgent(sessionId);
        const toolsService = agent.ctx.get('tools');

        // web_search tool is NOT advertised
        expect(toolsService.get('web_search', agent)).toBeUndefined();
        expect(toolsService.get('web_fetch', agent)).toBeDefined();

        const web = runtime.context.get('web');
        await expect(web.search({ query: 'test' })).rejects.toThrow(WebError);
        try {
          await web.search({ query: 'test' });
        } catch (err) {
          expect(err).toBeInstanceOf(WebError);
          expect((err as WebError).code).toBe('WEB_PROVIDER_CONFIGURED_MISSING');
        }
      } finally {
        await runtime.dispose();
      }
    });

    it('hides web_search when registered provider reports available() === false', async () => {
      // Create a mock plugin registering an unavailable provider
      const unavailablePlugin = {
        name: 'test-unavailable-provider-plugin',
        inject: ['web'],
        apply(ctx: any) {
          const unavailableProvider: WebSearchProvider = {
            id: 'unavailable-mock',
            available: () => false,
            search: async () => {
              throw new WebError('Missing credentials', 'WEB_PROVIDER_CREDENTIAL_MISSING');
            },
          };
          ctx.web.registerSearchProvider(unavailableProvider);
        },
      };

      const runtime = await bootDshRuntime({
        userId: 'alice',
        dshHome,
        spacesDir,
        web: {
          searchPlugin: unavailablePlugin,
        },
      });

      try {
        const sessionId = 'ses_0123456789abcdef0123456789abcde3';
        const agent = await runtime.getOrCreateAgent(sessionId);
        const toolsService = agent.ctx.get('tools');

        // Must NOT advertise tool when provider is unavailable
        expect(toolsService.get('web_search', agent)).toBeUndefined();
        expect(toolsService.get('web_fetch', agent)).toBeDefined();

        // Direct search fails with WEB_PROVIDER_UNAVAILABLE
        const web = runtime.context.get('web');
        await expect(web.search({ query: 'test' })).rejects.toThrow(WebError);
        try {
          await web.search({ query: 'test' });
        } catch (err) {
          expect(err).toBeInstanceOf(WebError);
          expect((err as WebError).code).toBe('WEB_PROVIDER_UNAVAILABLE');
        }
      } finally {
        await runtime.dispose();
      }
    });
  });

  describe('Generic Deterministic Fake Search Provider (Mocked Business Provider)', () => {
    it('registers actual model tool web_search, executes queries, and yields real tool records with no external calls', async () => {
      let searchCallCount = 0;
      const recordedQueries: string[] = [];

      const deterministicPlugin = {
        name: 'test-deterministic-search-plugin',
        inject: ['web'],
        apply(ctx: any) {
          const provider: WebSearchProvider = {
            id: 'deterministic-mock',
            available: () => true,
            search: async (request: WebSearchRequest): Promise<WebSearchResult> => {
              searchCallCount++;
              recordedQueries.push(request.query);
              return {
                query: request.query,
                sources: [
                  {
                    url: 'https://docs.deepseek.com/arch',
                    title: 'DeepSeek Harness Architecture',
                    snippet: 'Cordis-based composition with isolated capability seams.',
                  },
                  {
                    url: 'https://enkeep.example.com/guide',
                    title: 'Enkeep Migration Guide',
                    snippet: 'Seamless tool integration and credential isolation.',
                  },
                ],
              };
            },
          };
          ctx.web.registerSearchProvider(provider);
        },
      };

      const runtime = await bootDshRuntime({
        userId: 'alice',
        dshHome,
        spacesDir,
        web: {
          searchPlugin: deterministicPlugin,
          searchProvider: 'deterministic-mock',
        },
      });

      try {
        const sessionId = 'ses_0123456789abcdef0123456789abcde4';
        const agent = await runtime.getOrCreateAgent(sessionId);
        const toolsService = agent.ctx.get('tools');
        expect(toolsService).toBeDefined();

        // Actual model tool exposure verified
        const searchTool = toolsService.get('web_search', agent);
        expect(searchTool).toBeDefined();
        expect(searchTool.name).toBe('web_search');
        expect(searchTool.description).toContain('web');

        // Probing capabilities reflects search active
        const caps = await runtime.getCapabilities?.();
        expect(caps?.web?.search).toBe(true);
        expect(caps?.web?.fetch).toBe(true);
        expect(caps?.web?.provider).toBe('deterministic-mock');

        // Execute model tool with real arguments
        const toolCallId = 'call_web_search_001';
        const result = await searchTool.execute(
          {
            queries: ['DeepSeek Harness Architecture'],
          },
          {
            callId: toolCallId,
          } as any
        );

        expect(result).toBeDefined();
        expect(searchCallCount).toBe(1);
        expect(recordedQueries).toEqual(['DeepSeek Harness Architecture']);

        // Tool record contains formatted sources and content
        const contentText = JSON.stringify(result);
        expect(contentText).toContain('DeepSeek Harness Architecture');
        expect(contentText).toContain('https://docs.deepseek.com/arch');
        expect(contentText).toContain('https://enkeep.example.com/guide');
      } finally {
        await runtime.dispose();
      }
    });

    it('propagates web_search tool availability to subagents (G08 inheritance)', async () => {
      const deterministicPlugin = {
        name: 'test-child-inherited-plugin',
        inject: ['web'],
        apply(ctx: any) {
          const provider: WebSearchProvider = {
            id: 'child-inherited-provider',
            available: () => true,
            search: async (request: WebSearchRequest): Promise<WebSearchResult> => ({
              query: request.query,
              sources: [{ url: 'https://child.example.com', title: 'Child Title', snippet: 'Child Snippet' }],
            }),
          };
          ctx.web.registerSearchProvider(provider);
        },
      };

      const runtime = await bootDshRuntime({
        userId: 'alice',
        dshHome,
        spacesDir,
        web: {
          searchPlugin: deterministicPlugin,
        },
      });

      try {
        const sessionId = 'ses_0123456789abcdef0123456789abcde5';
        const parentAgent = await runtime.getOrCreateAgent(sessionId);
        const parentTools = parentAgent.ctx.get('tools');
        expect(parentTools.get('web_search', parentAgent)).toBeDefined();

        const subagents = runtime.context.get('subagents');
        expect(subagents).toBeDefined();

        // Spawn a subagent to verify tool inheritance
        const run = await subagents.start('spawn', {
          label: 'search-child-worker',
          prompt: [{ type: 'text', text: 'Search child task.' }],
          parent: parentAgent,
          signal: new AbortController().signal,
        });

        expect(run.id).toBeDefined();
        expect(run.localAgent).toBeDefined();

        const childAgent = run.localAgent;
        const childTools = childAgent.ctx.get('tools');
        expect(childTools).toBeDefined();

        const childSearchTool = childTools.get('web_search', childAgent);
        expect(childSearchTool).toBeDefined();
        expect(childSearchTool.name).toBe('web_search');

        const childResult = await childSearchTool.execute(
          {
            queries: ['subagent query'],
          },
          {
            callId: 'call_child_01',
          } as any
        );
        expect(JSON.stringify(childResult)).toContain('https://child.example.com');
      } finally {
        await runtime.dispose();
      }
    });
  });

  describe('DSH Config Loader Web Configuration & Credential Reference Security', () => {
    it('parses web and web-search-deepseek configuration with credential reference, never raw token values', () => {
      const patchYml = `
- id: llm-pi-ai
  config:
    providers:
      cpa-claude:
        displayName: Claude
        apiKeyEnv: CPA_TOKEN
        api: anthropic-messages
        baseURL: https://gw.example.com
- id: web-search-deepseek
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    baseURL: https://api.deepseek.com/anthropic/v1
    model: deepseek-v4-flash
    maxUses: 5
`;
      const settingsYaml = `
web:
  searchProvider: deepseek-official
  fetchProvider: http
web-search-deepseek:
  apiKeyEnv: DEEPSEEK_API_KEY
  baseURL: https://api.deepseek.com/anthropic/v1
  maxUses: 5
`;
      const envContent = `
CPA_TOKEN=cpa-secret-token-not-deepseek-key
DEEPSEEK_API_KEY=ds-test-key-ref-only
`;

      const config = parseDshConfigFiles(patchYml, settingsYaml, envContent, dshHome);
      expect(config.web).toBeDefined();
      expect(config.web?.searchProvider).toBe('deepseek-official');
      expect(config.web?.fetchProvider).toBe('http');

      // Credential reference is preserved as environment variable name, not raw secret
      expect(config.web?.searchConfig?.apiKeyEnv).toBe('DEEPSEEK_API_KEY');
      expect(config.web?.searchConfig?.baseURL).toBe('https://api.deepseek.com/anthropic/v1');
      expect(config.web?.searchConfig?.maxUses).toBe(5);

      // Existing CPA_TOKEN is NOT DeepSeek key and is never copied or aliased
      expect(config.tokens['CPA_TOKEN']).toBe('cpa-secret-token-not-deepseek-key');
      expect(config.tokens['DEEPSEEK_API_KEY']).toBe('ds-test-key-ref-only');
      expect(config.web?.searchConfig?.apiKeyEnv).not.toBe('CPA_TOKEN');

      // Allowed hosts includes the search base URL hostname
      expect(config.allowedHosts).toContain('api.deepseek.com');
    });

    it('gracefully handles absent web configuration without errors', () => {
      const patchYml = `
- id: llm-pi-ai
  config:
    providers:
      cpa-claude:
        apiKeyEnv: CPA_TOKEN
        api: anthropic-messages
        baseURL: https://gw.example.com
`;
      const config = parseDshConfigFiles(patchYml, undefined, undefined, dshHome);
      expect(config.web).toBeUndefined();
    });

    it('mounts official deepseek search provider when configured, keeping CPA_TOKEN isolated from DEEPSEEK_API_KEY', async () => {
      const originalCpa = process.env.CPA_TOKEN;
      const originalDs = process.env.DEEPSEEK_API_KEY;

      try {
        // Set CPA_TOKEN but ensure DEEPSEEK_API_KEY is unset
        process.env.CPA_TOKEN = 'cpa-test-token-value';
        delete process.env.DEEPSEEK_API_KEY;

        const runtimeMissingKey = await bootDshRuntime({
          userId: 'alice',
          dshHome,
          spacesDir,
          web: {
            searchProvider: 'deepseek-official',
            searchConfig: {
              apiKeyEnv: 'DEEPSEEK_API_KEY',
              baseURL: 'https://api.deepseek.com/anthropic/v1',
            },
          },
        });

        const agentMissingKey = await runtimeMissingKey.getOrCreateAgent('ses_0123456789abcdef0123456789abcde6');
        const toolsMissingKey = agentMissingKey.ctx.get('tools');
        const searchToolMissing = toolsMissingKey.get('web_search', agentMissingKey);
        expect(searchToolMissing).toBeDefined();

        // Calling search with missing DEEPSEEK_API_KEY throws WEB_PROVIDER_CREDENTIAL_MISSING
        // CPA_TOKEN is present in env, but provider does NOT use CPA_TOKEN
        await expect(
          searchToolMissing.execute({ queries: ['test'] }, { callId: 'call_no_key' } as any)
        ).rejects.toThrow(/DEEPSEEK_API_KEY/);

        try {
          await searchToolMissing.execute({ queries: ['test'] }, { callId: 'call_no_key' } as any);
        } catch (err: any) {
          expect(err.name).toBe('WebError');
          expect(err.code).toBe('WEB_PROVIDER_CREDENTIAL_MISSING');
          expect(err.message).toContain('DEEPSEEK_API_KEY');
          expect(err.message).not.toContain('CPA_TOKEN');
        }

        await runtimeMissingKey.dispose();

        // Now provide DEEPSEEK_API_KEY
        process.env.DEEPSEEK_API_KEY = 'valid-mock-deepseek-api-key';

        const runtimeWithKey = await bootDshRuntime({
          userId: 'alice',
          dshHome,
          spacesDir,
          web: {
            searchProvider: 'deepseek-official',
            searchConfig: {
              apiKeyEnv: 'DEEPSEEK_API_KEY',
              baseURL: 'https://api.deepseek.com/anthropic/v1',
            },
          },
        });

        const agentWithKey = await runtimeWithKey.getOrCreateAgent('ses_0123456789abcdef0123456789abcde7');
        const toolsWithKey = agentWithKey.ctx.get('tools');

        // With DEEPSEEK_API_KEY available, web_search tool IS advertised
        expect(toolsWithKey.get('web_search', agentWithKey)).toBeDefined();
        expect(toolsWithKey.get('web_fetch', agentWithKey)).toBeDefined();

        await runtimeWithKey.dispose();
      } finally {
        if (originalCpa !== undefined) process.env.CPA_TOKEN = originalCpa;
        else delete process.env.CPA_TOKEN;

        if (originalDs !== undefined) process.env.DEEPSEEK_API_KEY = originalDs;
        else delete process.env.DEEPSEEK_API_KEY;
      }
    });
  });
});
