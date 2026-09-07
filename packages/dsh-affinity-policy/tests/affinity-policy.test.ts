import { describe, it, expect, beforeEach } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import * as affinityPolicyPlugin from '../src/index.js';
import { AffinityPolicyError } from '../src/types.js';

async function* fakeStream(): AsyncIterable<StreamChunk> {
  yield { type: 'delta', delta: 'Hello world' } as any;
  yield { type: 'finish', finish: { kind: 'stop' } } as any;
}

describe('dsh-affinity-policy', () => {
  let ctx: Context;

  beforeEach(() => {
    ctx = new Context();
  });

  it('allows requests with valid sessionId through llm/stream without wire mutation', async () => {
    await ctx.plugin(affinityPolicyPlugin);

    const options: GenerateOptions = {
      provider: 'deepseek',
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hello' } as any],
      sessionId: 'session-12345' as any,
    };

    const originalOptions = { ...options };

    let downstreamCalled = false;
    const stream = await ctx.waterfall('llm/stream', options, () => {
      downstreamCalled = true;
      return fakeStream();
    });

    expect(downstreamCalled).toBe(true);

    // Verify stream yields
    const chunks: any[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBe(2);

    // Verify options were NOT mutated (no wire injection)
    expect(options).toEqual(originalOptions);
  });

  it('fails loud when sessionId is missing', async () => {
    await ctx.plugin(affinityPolicyPlugin);

    const options: GenerateOptions = {
      provider: 'deepseek',
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hello' } as any],
      // sessionId missing
    };

    let downstreamCalled = false;
    await expect(async () => {
      await ctx.waterfall('llm/stream', options, () => {
        downstreamCalled = true;
        return fakeStream();
      });
    }).rejects.toThrowError(AffinityPolicyError);

    expect(downstreamCalled).toBe(false);
  });

  it('fails loud when sessionId is empty or whitespace', async () => {
    await ctx.plugin(affinityPolicyPlugin);

    const options: GenerateOptions = {
      provider: 'deepseek',
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hello' } as any],
      sessionId: '   ' as any,
    };

    await expect(async () => {
      await ctx.waterfall('llm/stream', options, () => fakeStream());
    }).rejects.toThrowError(/missing or invalid sessionId/);
  });

  it('allows exempt auxiliary requests when exemptAuxiliary is enabled', async () => {
    await ctx.plugin(affinityPolicyPlugin, { exemptAuxiliary: true });

    const compactionOptions: GenerateOptions = {
      provider: 'deepseek',
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'summarize' } as any],
      purpose: 'compaction',
      // sessionId is intentionally absent
    };

    let called = false;
    const stream = await ctx.waterfall('llm/stream', compactionOptions, () => {
      called = true;
      return fakeStream();
    });

    expect(called).toBe(true);
    expect(stream).toBeDefined();
  });

  it('allows exempt purposes when specific exemptPurposes are configured', async () => {
    await ctx.plugin(affinityPolicyPlugin, { exemptPurposes: ['session-title'] });

    const titleOptions: GenerateOptions = {
      provider: 'deepseek',
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'title' } as any],
      purpose: 'session-title',
    };

    let called = false;
    const stream = await ctx.waterfall('llm/stream', titleOptions, () => {
      called = true;
      return fakeStream();
    });

    expect(called).toBe(true);
    expect(stream).toBeDefined();
  });
});
