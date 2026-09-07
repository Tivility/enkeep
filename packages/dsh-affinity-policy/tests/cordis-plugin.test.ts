import { describe, it, expect } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import * as affinityPolicyPlugin from '../src/index.js';

async function* dummyStream(): AsyncIterable<StreamChunk> {
  yield { type: 'delta', delta: 'ok' } as any;
}

describe('dsh-affinity-policy: Cordis plugin and dispose lifecycle', () => {
  it('mounts and intercepts llm/stream, then stops intercepting on dispose', async () => {
    const ctx = new Context();
    const fork = await ctx.plugin(affinityPolicyPlugin);

    const invalidOptions: GenerateOptions = {
      provider: 'deepseek',
      model: 'deepseek-chat',
      messages: [],
    };

    // When plugin is active, it throws on missing sessionId
    await expect(async () => {
      await ctx.waterfall('llm/stream', invalidOptions, () => dummyStream());
    }).rejects.toThrow(/missing or invalid sessionId/);

    // Dispose the plugin
    await fork.dispose();

    // After dispose, waterfall passes through to fallback
    let fallbackCalled = false;
    const stream = await ctx.waterfall('llm/stream', invalidOptions, () => {
      fallbackCalled = true;
      return dummyStream();
    });

    expect(fallbackCalled).toBe(true);
    expect(stream).toBeDefined();
  });

  it('can start and stop independently multiple times', async () => {
    const ctx = new Context();

    const fork1 = await ctx.plugin(affinityPolicyPlugin);
    await fork1.dispose();

    const fork2 = await ctx.plugin(affinityPolicyPlugin);
    await fork2.dispose();
  });
});
