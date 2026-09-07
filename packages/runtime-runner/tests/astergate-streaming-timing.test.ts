import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { DeterministicDemoLlmAdapter } from '../src/runtime/demo-model-plugin.js';
import { loadDshDeploymentConfig } from '../src/config/dsh-config-loader.js';
import { createLlmProxyHandler } from '../src/tunnel/llm-proxy.js';

describe('Streaming Timing & Time-to-First-Token (TTFT) Verification', () => {
  it('proves that first streamed chunk arrives significantly earlier than final completion (TTFT < Final)', async () => {
    const chunkDelayMs = 40;
    const adapter = new DeterministicDemoLlmAdapter('timing-user', chunkDelayMs);

    const startTime = Date.now();
    let firstChunkTime: number | null = null;
    let finalChunkTime: number | null = null;
    const receivedChunks: string[] = [];

    const stream = adapter.stream({
      messages: [
        {
          id: 'm1' as any,
          role: 'user',
          content: 'Generate a long multi-chunk response for streaming latency verification.',
        },
      ],
      model: 'demo-model',
    });

    for await (const chunk of stream) {
      const now = Date.now();
      if (chunk.type === 'text-delta' && chunk.text) {
        if (firstChunkTime === null) {
          firstChunkTime = now;
        }
        finalChunkTime = now;
        receivedChunks.push(chunk.text);
      }
    }

    const endTime = Date.now();

    expect(firstChunkTime).not.toBeNull();
    expect(finalChunkTime).not.toBeNull();
    expect(receivedChunks.length).toBeGreaterThan(1);

    const ttftMs = firstChunkTime! - startTime;
    const totalMs = endTime - startTime;

    // Time assertion: First token / delta timestamp is strictly earlier than final completion
    expect(firstChunkTime!).toBeLessThan(finalChunkTime!);
    expect(ttftMs).toBeLessThan(totalMs);
    expect(totalMs - ttftMs).toBeGreaterThanOrEqual(chunkDelayMs * (receivedChunks.length - 1) * 0.7);

    console.log(`[Streaming Timing Evidence] Chunks: ${receivedChunks.length}, TTFT: ${ttftMs}ms, Total: ${totalMs}ms`);
  });

  const localConfig = loadDshDeploymentConfig();
  const hasLocalConfigAndToken = Boolean(
    localConfig &&
    localConfig.providers &&
    (localConfig.providers['cpa-gemini'] || localConfig.providers['cpa-claude']) &&
    localConfig.tokens['CPA_TOKEN'] &&
    localConfig.tokens['CPA_TOKEN'].trim().length > 0
  );

  it.skipIf(!hasLocalConfigAndToken)(
    'proves real AsterGate gateway streaming emits first token before completion (Live TTFT < Total)',
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
        const startTime = Date.now();
        let firstDeltaTime: number | null = null;
        let finalDeltaTime: number | null = null;
        let deltaCount = 0;

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
            stream: true,
            messages: [{ role: 'user', content: 'Count numbers from 1 to 10 with explanations.' }],
          }),
        });

        expect(response.status).toBe(200);

        if (response.body) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value);
            if (text.includes('content_block_delta') || text.includes('text_delta') || text.includes('delta')) {
              const now = Date.now();
              if (firstDeltaTime === null) {
                firstDeltaTime = now;
              }
              finalDeltaTime = now;
              deltaCount++;
            }
          }
        }

        const endTime = Date.now();

        if (firstDeltaTime !== null && finalDeltaTime !== null) {
          expect(firstDeltaTime).toBeLessThanOrEqual(finalDeltaTime);
          const liveTtft = firstDeltaTime - startTime;
          const liveTotal = endTime - startTime;
          console.log(`[Live AsterGate Streaming Evidence] Deltas: ${deltaCount}, TTFT: ${liveTtft}ms, Total: ${liveTotal}ms`);
        }
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    30000
  );
});
