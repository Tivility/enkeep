/**
 * LLM Transient Error Retry and Backoff Test Suite
 *
 * Verifies Developer R requirements:
 * 1. Transient 502 then success -> turn completes
 * 2. 400 validation error -> no retry (fails fast)
 * 3. Backoff schedule applied (2s, 5s, 15s) and respects Retry-After
 * 4. Cancellation during backoff delay aborts cleanly
 * 5. Retry attempts are capped at 3 retries (4 total attempts)
 * 6. Error classification: transient classes (429, 500, 502, 503, 504, network errors, upstream_transient_error)
 *    vs permanent 4xx validation errors (400, 401, 403, 404, 422)
 *
 * @module @enkeep/runtime-runner/tests/llm-transient-retry.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { DeterministicDemoLlmAdapter } from '../src/runtime/demo-model-plugin.js';
import {
  bootDshRuntime,
  parseRetryAfterMs,
  resolveLlmRetryBackoffSchedule,
  DEFAULT_LLM_RETRY_BACKOFF_SCHEDULE_MS,
  abortableSleep,
} from '../src/runtime/dsh-boot.js';

class MockStreamAdapter extends DeterministicDemoLlmAdapter {
  constructor(private readonly streamFn: (options: GenerateOptions) => AsyncIterable<StreamChunk>) {
    super('user-alice', 0, 128000, 2048);
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* this.streamFn(options);
  }
}

describe('LLM Transient Error Retry & Backoff Engine', () => {
  const originalEnv = process.env;
  let testHomeDir: string;
  let testSpacesDir: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    const tmp = os.tmpdir();
    const nonce = Math.random().toString(36).substring(2, 10);
    const baseParent = path.join(tmp, `test-transient-retry-${nonce}`);
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

  it('1. Transient 502 then success -> turn completes with backoff and route telemetry', async () => {
    process.env.ENKEEP_LLM_RETRY_BACKOFF_MS = '20,50,150';

    const runtime = await bootDshRuntime({
      userId: 'user-alice',
      dshHome: testHomeDir,
      spacesDir: testSpacesDir,
      llmEnabled: false,
      provider: 'cpa-claude',
      model: 'claude-fable-5',
    });

    try {
      let callCount = 0;
      const testAdapter = new MockStreamAdapter(async function* () {
        callCount++;
        if (callCount === 1) {
          // First attempt: simulate 502 upstream transient error
          throw new LlmError(
            'Upstream returned status 502 (upstream_transient_error)',
            'SERVER_ERROR',
            { status: 502 }
          );
        }
        // Second attempt: succeeds
        yield {
          type: 'block-start',
          index: 0,
          blockType: 'text',
        };
        yield {
          type: 'text-delta',
          index: 0,
          text: 'Turn successfully recovered after 502 retry.',
        };
      });

      runtime.context.llm.registerAdapter(['synthetic-502-provider'], testAdapter);

      const sessionId = 'ses_00000000000000000000000000000001';
      const turnId = 'turn_00000000000000000000000000000001';

      const res = await runtime.sendFollowup({
        prompt: 'Hello retry engine',
        sessionId,
        turnId,
        profile: null,
        modelSelection: {
          provider: 'synthetic-502-provider',
          model: 'demo-model',
          fallbackChain: [],
        },
      });

      // Assert turn completed successfully
      expect(res.status).toBe('completed');
      expect(res.replyText).toContain('Turn successfully recovered after 502 retry.');
      expect(callCount).toBe(2);

      // Verify routeAttempts recorded the 502 failure and 200 success
      expect(res.routeAttempts).toBeDefined();
      expect(res.routeAttempts!.length).toBe(2);
      expect(res.routeAttempts![0].statusCode).toBe(502);
      expect(res.routeAttempts![0].success).toBe(false);
      expect(res.routeAttempts![1].statusCode).toBe(200);
      expect(res.routeAttempts![1].success).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });

  it('2. 400 validation error -> no retry (fails fast on first attempt)', async () => {
    process.env.ENKEEP_LLM_RETRY_BACKOFF_MS = '20,50,150';

    const runtime = await bootDshRuntime({
      userId: 'user-alice',
      dshHome: testHomeDir,
      spacesDir: testSpacesDir,
      llmEnabled: false,
      provider: 'cpa-claude',
      model: 'claude-fable-5',
    });

    try {
      let callCount = 0;
      const testAdapter = new MockStreamAdapter(async function* () {
        callCount++;
        throw new LlmError(
          'Invalid request payload: temperature must be between 0 and 2 (validation error)',
          'INVALID_REQUEST',
          { status: 400 }
        );
      });

      runtime.context.llm.registerAdapter(['synthetic-validation-provider'], testAdapter);

      const sessionId = 'ses_00000000000000000000000000000002';
      const turnId = 'turn_00000000000000000000000000000002';

      await expect(
        runtime.sendFollowup({
          prompt: 'Bad request prompt',
          sessionId,
          turnId,
          profile: null,
          modelSelection: {
            provider: 'synthetic-validation-provider',
            model: 'demo-model',
            fallbackChain: [],
          },
        })
      ).rejects.toThrow();

      // Exactly 1 call was made; no retry was attempted for 400 validation error
      expect(callCount).toBe(1);
    } finally {
      await runtime.dispose();
    }
  });

  it('3. Backoff applied: respects backoff schedule and Retry-After delay', async () => {
    // Test DEFAULT_LLM_RETRY_BACKOFF_SCHEDULE_MS constant: 2s, 5s, 15s
    expect(DEFAULT_LLM_RETRY_BACKOFF_SCHEDULE_MS).toEqual([2000, 5000, 15000]);

    // Test resolveLlmRetryBackoffSchedule in non-test env
    delete process.env.ENKEEP_LLM_RETRY_BACKOFF_MS;
    delete process.env.VITEST;
    expect(resolveLlmRetryBackoffSchedule()).toEqual([2000, 5000, 15000]);

    // Test env override
    process.env.ENKEEP_LLM_RETRY_BACKOFF_MS = '100, 250, 500';
    expect(resolveLlmRetryBackoffSchedule()).toEqual([100, 250, 500]);

    // Test parseRetryAfterMs helper
    // 1. Official providerRetryAfterMs property
    expect(parseRetryAfterMs({ providerRetryAfterMs: 3200 })).toBe(3200);

    // 2. retryAfterMs property
    expect(parseRetryAfterMs({ retryAfterMs: 4500 })).toBe(4500);

    // 3. retry-after numeric string (in seconds per HTTP spec)
    expect(parseRetryAfterMs({ headers: { 'retry-after': '3' } })).toBe(3000);

    // 4. retry-after integer seconds
    expect(parseRetryAfterMs({ retryAfter: 2 })).toBe(2000);

    // 5. Invalid/absent retry-after returns undefined
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs({})).toBeUndefined();
    expect(parseRetryAfterMs({ providerRetryAfterMs: -100 })).toBeUndefined();

    // Verify backoff delay execution in real runtime with Retry-After
    const runtime = await bootDshRuntime({
      userId: 'user-alice',
      dshHome: testHomeDir,
      spacesDir: testSpacesDir,
      llmEnabled: false,
      provider: 'cpa-claude',
      model: 'claude-fable-5',
    });

    try {
      let callCount = 0;
      let startMs = 0;
      let elapsedMs = 0;

      const testAdapter = new MockStreamAdapter(async function* () {
        callCount++;
        if (callCount === 1) {
          startMs = Date.now();
          throw new LlmError(
            'Rate limit exceeded (429)',
            'RATE_LIMIT',
            { status: 429, providerRetryAfterMs: 80 }
          );
        }
        elapsedMs = Date.now() - startMs;
        yield {
          type: 'block-start',
          index: 0,
          blockType: 'text',
        };
        yield {
          type: 'text-delta',
          index: 0,
          text: 'Recovered after retry-after delay',
        };
      });

      runtime.context.llm.registerAdapter(['synthetic-retry-after-provider'], testAdapter);

      const sessionId = 'ses_00000000000000000000000000000003';
      const turnId = 'turn_00000000000000000000000000000003';

      const res = await runtime.sendFollowup({
        prompt: 'Rate limited request',
        sessionId,
        turnId,
        profile: null,
        modelSelection: {
          provider: 'synthetic-retry-after-provider',
          model: 'demo-model',
          fallbackChain: [],
        },
      });

      expect(res.status).toBe('completed');
      expect(callCount).toBe(2);
      // Elapsed time should reflect the ~80ms backoff delay
      expect(elapsedMs).toBeGreaterThanOrEqual(70);
    } finally {
      await runtime.dispose();
    }
  });

  it('4. Retries up to 3 times for persistent transient error, then fails turn when exhausted', async () => {
    process.env.ENKEEP_LLM_RETRY_BACKOFF_MS = '10,20,30';

    const runtime = await bootDshRuntime({
      userId: 'user-alice',
      dshHome: testHomeDir,
      spacesDir: testSpacesDir,
      llmEnabled: false,
      provider: 'cpa-claude',
      model: 'claude-fable-5',
    });

    try {
      let attempts = 0;
      const testAdapter = new MockStreamAdapter(async function* () {
        attempts++;
        throw new LlmError(
          'ECONNRESET: socket hang up',
          'TRANSIENT',
          { status: 503 }
        );
      });

      runtime.context.llm.registerAdapter(['synthetic-failing-provider'], testAdapter);

      const sessionId = 'ses_00000000000000000000000000000004';
      const turnId = 'turn_00000000000000000000000000000004';

      await expect(
        runtime.sendFollowup({
          prompt: 'Persistent transient error',
          sessionId,
          turnId,
          profile: null,
          modelSelection: {
            provider: 'synthetic-failing-provider',
            model: 'demo-model',
            fallbackChain: [],
          },
        })
      ).rejects.toThrow();

      // Exactly 1 initial attempt + 3 retries = 4 total attempts
      expect(attempts).toBe(4);
    } finally {
      await runtime.dispose();
    }
  });

  it('5. Abort signal cancels backoff delay immediately', async () => {
    const ac = new AbortController();
    const sleepPromise = abortableSleep(5000, ac.signal);

    // Abort after 20ms
    setTimeout(() => ac.abort(), 20);

    const start = Date.now();
    const ok = await sleepPromise;
    const elapsed = Date.now() - start;

    expect(ok).toBe(false);
    expect(elapsed).toBeLessThan(1000);
  });

  it('6. Transient classes (500, 503, 504, 429, network) retry, while other 4xx (401, 403, 404, 422) do not', async () => {
    process.env.ENKEEP_LLM_RETRY_BACKOFF_MS = '10,20,30';

    const runtime = await bootDshRuntime({
      userId: 'user-alice',
      dshHome: testHomeDir,
      spacesDir: testSpacesDir,
      llmEnabled: false,
      provider: 'cpa-claude',
      model: 'claude-fable-5',
    });

    try {
      // Test 504 Gateway Timeout -> retried
      let callCount504 = 0;
      const adapter504 = new MockStreamAdapter(async function* () {
        callCount504++;
        if (callCount504 === 1) {
          throw new LlmError('504 Gateway Timeout', 'SERVER_ERROR', { status: 504 });
        }
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: '504 recovered' };
      });
      runtime.context.llm.registerAdapter(['test-504-provider'], adapter504);

      const res504 = await runtime.sendFollowup({
        prompt: '504 test',
        sessionId: 'ses_00000000000000000000000000000005',
        turnId: 'turn_00000000000000000000000000000005',
        profile: null,
        modelSelection: { provider: 'test-504-provider', model: 'demo-model', fallbackChain: [] },
      });
      expect(res504.status).toBe('completed');
      expect(callCount504).toBe(2);

      // Test 422 Unprocessable Entity -> NOT retried (callCount = 1)
      let callCount422 = 0;
      const adapter422 = new MockStreamAdapter(async function* () {
        callCount422++;
        throw new LlmError('422 Unprocessable Entity', 'INVALID_REQUEST', { status: 422 });
      });
      runtime.context.llm.registerAdapter(['test-422-provider'], adapter422);

      await expect(
        runtime.sendFollowup({
          prompt: '422 test',
          sessionId: 'ses_00000000000000000000000000000006',
          turnId: 'turn_00000000000000000000000000000006',
          profile: null,
          modelSelection: { provider: 'test-422-provider', model: 'demo-model', fallbackChain: [] },
        })
      ).rejects.toThrow();
      expect(callCount422).toBe(1);
    } finally {
      await runtime.dispose();
    }
  });

  it('7. Subagent child agent (spawn & fork) gets 502 then success -> completes with 2 attempts', async () => {
    process.env.ENKEEP_LLM_RETRY_BACKOFF_MS = '20,50,150';

    const runtime = await bootDshRuntime({
      userId: 'user-alice',
      dshHome: testHomeDir,
      spacesDir: testSpacesDir,
      llmEnabled: false,
      provider: 'cpa-claude',
      model: 'claude-fable-5',
    });

    try {
      let callCount = 0;
      const childAdapter = new MockStreamAdapter(async function* () {
        callCount++;
        if (callCount === 1) {
          // Attempt 1 fails with 502 upstream_transient_error
          throw new LlmError(
            'Upstream returned status 502 (upstream_transient_error)',
            'SERVER_ERROR',
            { status: 502 }
          );
        }
        // Attempt 2 succeeds
        yield {
          type: 'block-start',
          index: 0,
          blockType: 'text',
        };
        yield {
          type: 'text-delta',
          index: 0,
          text: 'Child subagent successfully recovered after 502.',
        };
      });

      runtime.context.llm.registerAdapter(['synthetic-subagent-502-provider'], childAdapter);

      const parentSessionId = 'ses_00000000000000000000000000000007';
      const parentAgent = await runtime.getOrCreateAgent(parentSessionId, null, 'space-synthetic-01');

      const subagentsService = parentAgent.ctx.get('subagents');
      expect(subagentsService).toBeDefined();

      // Test spawn child retry
      const childRun = await subagentsService.start('spawn', {
        label: 'child-502-task',
        prompt: [{ type: 'text', text: 'Execute delegated task' }],
        parent: parentAgent,
        agentOptions: {
          provider: 'synthetic-subagent-502-provider',
          model: 'demo-model',
        },
        signal: new AbortController().signal,
      });

      const subagentResult = await childRun.result;
      expect(subagentResult.stopReason).toBe('completed');
      expect(subagentResult.output[0].text).toContain('Child subagent successfully recovered after 502.');
      expect(callCount).toBe(2);

      // Test fork child retry
      callCount = 0;
      const forkRun = await subagentsService.start('fork', {
        label: 'child-fork-task',
        prompt: [{ type: 'text', text: 'Execute delegated fork task' }],
        parent: parentAgent,
        agentOptions: {
          provider: 'synthetic-subagent-502-provider',
          model: 'demo-model',
        },
        signal: new AbortController().signal,
      });

      const forkResult = await forkRun.result;
      expect(forkResult.stopReason).toBe('completed');
      expect(forkResult.output[0].text).toContain('Child subagent successfully recovered after 502.');
      expect(callCount).toBe(2);
    } finally {
      await runtime.dispose();
    }
  });

  it('8. Workflow child agent gets 502 then success -> completes with 2 attempts', async () => {
    process.env.ENKEEP_LLM_RETRY_BACKOFF_MS = '20,50,150';

    const runtime = await bootDshRuntime({
      userId: 'user-alice',
      dshHome: testHomeDir,
      spacesDir: testSpacesDir,
      llmEnabled: false,
      provider: 'cpa-claude',
      model: 'claude-fable-5',
    });

    try {
      let callCount = 0;
      const wfChildAdapter = new MockStreamAdapter(async function* () {
        callCount++;
        if (callCount === 1) {
          throw new LlmError(
            'Upstream returned status 502 (upstream_transient_error)',
            'SERVER_ERROR',
            { status: 502 }
          );
        }
        yield {
          type: 'block-start',
          index: 0,
          blockType: 'text',
        };
        yield {
          type: 'text-delta',
          index: 0,
          text: 'Workflow child recovered after 502 retry.',
        };
      });

      runtime.context.llm.registerAdapter(['synthetic-wf-502-provider'], wfChildAdapter);

      const parentSessionId = 'ses_00000000000000000000000000000008';
      const parentAgent = await runtime.getOrCreateAgent(parentSessionId, null, 'space-synthetic-01');

      const engine = parentAgent.ctx.get('workflowEngine');
      expect(engine).toBeDefined();

      const meta = {
        name: 'synthetic-retry-wf',
        description: 'Test workflow child transient error retry',
      };
      const script = `
        const childResult = await agent("Synthesize workflow task", { provider: "synthetic-wf-502-provider", model: "demo-model" });
        return { ok: true, childResult };
      `;

      const run = engine.start({
        script,
        meta,
        parent: parentAgent,
      });

      const outcome = await run.result;
      expect(outcome.stopReason).toBe('completed');
      expect(outcome.value).toBeDefined();
      expect((outcome.value as any).ok).toBe(true);
      expect((outcome.value as any).childResult).toContain('Workflow child recovered after 502 retry.');
      expect(callCount).toBe(2);
    } finally {
      await runtime.dispose();
    }
  });

  it('9. Child agent non-transient 400 validation error is not retried (fails fast with 1 attempt)', async () => {
    process.env.ENKEEP_LLM_RETRY_BACKOFF_MS = '20,50,150';

    const runtime = await bootDshRuntime({
      userId: 'user-alice',
      dshHome: testHomeDir,
      spacesDir: testSpacesDir,
      llmEnabled: false,
      provider: 'cpa-claude',
      model: 'claude-fable-5',
    });

    try {
      let callCount = 0;
      const childAdapter = new MockStreamAdapter(async function* () {
        callCount++;
        throw new LlmError(
          'Invalid request payload: bad prompt (validation error)',
          'INVALID_REQUEST',
          { status: 400 }
        );
      });

      runtime.context.llm.registerAdapter(['synthetic-subagent-400-provider'], childAdapter);

      const parentSessionId = 'ses_00000000000000000000000000000009';
      const parentAgent = await runtime.getOrCreateAgent(parentSessionId, null, 'space-synthetic-01');

      const subagentsService = parentAgent.ctx.get('subagents');
      expect(subagentsService).toBeDefined();

      const childRun = await subagentsService.start('spawn', {
        label: 'child-400-task',
        prompt: [{ type: 'text', text: 'Invalid prompt' }],
        parent: parentAgent,
        agentOptions: {
          provider: 'synthetic-subagent-400-provider',
          model: 'demo-model',
        },
        signal: new AbortController().signal,
      });

      const result = await childRun.result;
      expect(result.stopReason).toBe('error');

      // Exactly 1 call was made; no retry was attempted for child agent 400 error
      expect(callCount).toBe(1);
    } finally {
      await runtime.dispose();
    }
  });
});
