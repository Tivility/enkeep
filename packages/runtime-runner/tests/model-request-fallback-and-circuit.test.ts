/**
 * Request-Level Model Fallback, Circuit Breaker & Tool Side-Effect Integration Tests
 *
 * Verifies:
 * 1. Primary fake 503 -> Secondary deterministic success.
 * 2. Multi-step tool side effect executed EXACTLY ONCE (sideEffectCounter = 1).
 * 3. Session JSONL: 1 turn, 1 user message, request/context shows secondary actual model.
 * 4. Circuit breaker trips after threshold (3 consecutive transient failures) -> skips primary immediately on next turn.
 * 5. Auth failure (401/403) fails fast without fallback.
 * 6. Midstream failure (partial text chunks emitted) fails fast without fallback.
 * 7. Telemetry routeAttempts accurately records each attempt.
 *
 * @module @enkeep/runtime-runner/tests/model-request-fallback-and-circuit.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { bootDshRuntime } from '../src/runtime/dsh-boot.js';
import { defineTool } from '@deepseek-ai/dsh-tools';

describe('Production Request-Level Model Fallback & Circuit Breaker Engine', () => {
  const originalEnv = process.env;
  let testHomeDir: string;
  let testSpacesDir: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    const tmp = os.tmpdir();
    const nonce = Math.random().toString(36).substring(2, 10);
    const baseParent = path.join(tmp, `test-fb-circuit-${nonce}`);
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

  it('1. Primary fake 503 falls back to secondary with multi-step tool side effect count = 1 and request/context secondary', async () => {
    let sideEffectCounter = 0;

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: testHomeDir,
      spacesDir: testSpacesDir,
      llmEnabled: false, // Deterministic demo adapter
      provider: 'cpa-claude',
      model: 'claude-fable-5',
    });

    try {
      // Register test tool
      const ctx = runtime.context;
      const counterTool = defineTool({
        name: 'increment_counter',
        description: 'Increments test side effect counter by 1',
        parameters: {},
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, val) => [{ type: 'text', text: JSON.stringify(val) }],
        },
        execute: async () => {
          sideEffectCounter++;
          return { success: true, count: sideEffectCounter };
        },
      });
      ctx.tools.register(counterTool);

      const sessionId = 'ses_0123456789abcdef0123456789abcdef';
      const turnId = 'turn_0123456789abcdef0123456789abcde1';

      // Turn prompt: calls tool first, and simulates primary provider cpa-claude 503 failure
      const prompt =
        'Execute tool [enkeep-test-tool-call=increment_counter:{}] and fail [enkeep-test-fail-provider=cpa-claude:503]';

      const res = await runtime.sendFollowup({
        prompt,
        sessionId,
        turnId,
        profile: null,
        modelSelection: {
          provider: 'cpa-claude',
          model: 'claude-fable-5',
          reasoningEffort: 'max',
          fallbackChain: [
            { provider: 'cpa-gemini', model: 'gemini-3.7-flash-tiered', reasoningEffort: 'max' },
          ],
        },
      });

      expect(res.status).toBe('completed');
      expect(res.replyText).toBeDefined();

      // Tool must be executed EXACTLY ONCE
      expect(sideEffectCounter).toBe(1);

      // modelInfo must reflect fallback used and winning model cpa-gemini
      expect(res.modelInfo?.provider).toBe('cpa-gemini');
      expect(res.modelInfo?.model).toBe('gemini-3.7-flash-tiered');
      expect((res.modelInfo as any)?.fallbackUsed).toBe(true);

      // Verify routeAttempts
      expect(res.routeAttempts).toBeDefined();
      expect(res.routeAttempts!.length).toBeGreaterThanOrEqual(2);
      expect(res.routeAttempts![0].provider).toBe('cpa-claude');
      expect(res.routeAttempts![0].success).toBe(false);
      expect(res.routeAttempts![0].statusCode).toBe(503);
      expect(res.routeAttempts![res.routeAttempts!.length - 1].provider).toBe('cpa-gemini');
      expect(res.routeAttempts![res.routeAttempts!.length - 1].success).toBe(true);

      // Verify session events: 1 turn/start, 1 human user/message, request/context shows cpa-gemini
      const agent = await runtime.getOrCreateAgent(sessionId);
      const events = agent.session.snapshotEvents();

      const turnStarts = events.filter((e) => e.type === 'turn/start');
      expect(turnStarts.length).toBe(1);

      const userMessages = events.filter((e) => e.type === 'user/message' && (e.data as any)?.source?.kind === 'user');
      expect(userMessages.length).toBe(1);

      // Verify official request/context last event provider is secondary (cpa-gemini)
      const requestContexts = events.filter((e) => e.type === 'request/context');
      expect(requestContexts.length).toBeGreaterThan(0);
      const lastContext = requestContexts[requestContexts.length - 1];
      expect(lastContext.data.provider).toBe('cpa-gemini');
      expect(lastContext.data.model).toBe('gemini-3.7-flash-tiered');

      // Verify customRouteEvents length is 0 (no illegal custom events in session log; official known events only)
      const customRouteEvents = events.filter((e) => e.type === 'enkeep/model-route-result' || e.type === 'enkeep/model-selection');
      expect(customRouteEvents.length).toBe(0);
    } finally {
      await runtime.dispose();
    }
  });

  it('2. Auth failure (401/403) fails fast without fallback', async () => {
    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: testHomeDir,
      spacesDir: testSpacesDir,
      llmEnabled: false,
      provider: 'cpa-claude',
      model: 'claude-fable-5',
    });

    try {
      const sessionId = 'ses_0123456789abcdef0123456789abcdef';
      const turnId = 'turn_0123456789abcdef0123456789abcde2';

      const prompt = 'Test auth failure [enkeep-test-fail-provider=cpa-claude:401]';

      await expect(
        runtime.sendFollowup({
          prompt,
          sessionId,
          turnId,
          profile: null,
          modelSelection: {
            provider: 'cpa-claude',
            model: 'claude-fable-5',
            fallbackChain: [
              { provider: 'cpa-gemini', model: 'gemini-3.7-flash-tiered' },
            ],
          },
        })
      ).rejects.toThrow();
    } finally {
      await runtime.dispose();
    }
  });

  it('3. Midstream failure fails fast without fallback to prevent stream corruption', async () => {
    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: testHomeDir,
      spacesDir: testSpacesDir,
      llmEnabled: false,
      provider: 'cpa-claude',
      model: 'claude-fable-5',
    });

    try {
      const sessionId = 'ses_0123456789abcdef0123456789abcdef';
      const turnId = 'turn_0123456789abcdef0123456789abcde3';

      const prompt = 'Test midstream drop [enkeep-test-midstream-fail=cpa-claude]';

      await expect(
        runtime.sendFollowup({
          prompt,
          sessionId,
          turnId,
          profile: null,
          modelSelection: {
            provider: 'cpa-claude',
            model: 'claude-fable-5',
            fallbackChain: [
              { provider: 'cpa-gemini', model: 'gemini-3.7-flash-tiered' },
            ],
          },
        })
      ).rejects.toThrow();
    } finally {
      await runtime.dispose();
    }
  });

  it('4. Circuit breaker trips after threshold and skips primary immediately on subsequent turns', async () => {
    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: testHomeDir,
      spacesDir: testSpacesDir,
      llmEnabled: false,
      provider: 'cpa-claude',
      model: 'claude-fable-5',
    });

    try {
      const sessionId = 'ses_0123456789abcdef0123456789abcdef';

      // Execute 3 consecutive turns that fail on primary with 503 and fallback to secondary
      for (let i = 1; i <= 3; i++) {
        const turnId = `turn_0123456789abcdef0123456789abcd${i}0`;
        const prompt = `Turn ${i} with 503 fail on claude [enkeep-test-fail-provider=cpa-claude:503]`;

        const res = await runtime.sendFollowup({
          prompt,
          sessionId,
          turnId,
          profile: null,
          modelSelection: {
            provider: 'cpa-claude',
            model: 'claude-fable-5',
            fallbackChain: [
              { provider: 'cpa-gemini', model: 'gemini-3.7-flash-tiered' },
            ],
          },
        });

        expect(res.status).toBe('completed');
        expect(res.modelInfo?.provider).toBe('cpa-gemini');
      }

      // On turn 4, primary circuit is now OPEN!
      // Even without fail token in prompt, it should skip cpa-claude immediately and start directly on cpa-gemini
      const turn4Id = 'turn_0123456789abcdef0123456789abcd40';
      const prompt4 = 'Turn 4 normal prompt without fail token';

      const res4 = await runtime.sendFollowup({
        prompt: prompt4,
        sessionId,
        turnId: turn4Id,
        profile: null,
        modelSelection: {
          provider: 'cpa-claude',
          model: 'claude-fable-5',
          fallbackChain: [
            { provider: 'cpa-gemini', model: 'gemini-3.7-flash-tiered' },
          ],
        },
      });

      expect(res4.status).toBe('completed');
      expect(res4.modelInfo?.provider).toBe('cpa-gemini');
      // In routeAttempts for turn 4, cpa-claude was skipped immediately, only cpa-gemini attempted
      expect(res4.routeAttempts?.length).toBe(1);
      expect(res4.routeAttempts![0].provider).toBe('cpa-gemini');
      expect(res4.routeAttempts![0].success).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });
});
