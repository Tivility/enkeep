import { describe, it, expect } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import {
  DeterministicDemoLlmAdapter,
  computeEffectiveInstructionTokens,
} from '../src/runtime/demo-model-plugin.js';
import type {
  GenerateOptions,
  RequestMessage,
  StreamChunk,
} from '@deepseek-ai/dsh-llm';
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm';

import * as affinityInvariant from '@enkeep/dsh-affinity-policy/invariant';
import * as bundleInvariant from '@enkeep/dsh-enkeep-bundle/invariant';
import * as interactionInvariant from '@enkeep/dsh-external-interaction/invariant';

async function collectStream(stream: AsyncIterable<StreamChunk>): Promise<string> {
  let text = '';
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') {
      text += chunk.text;
    }
  }
  return text;
}

describe('WP-llm: Demo Model Protocol & Invariant Pureness', () => {
  it('recognizes native role: "tool" messages with toolCallId and content', async () => {
    const adapter = new DeterministicDemoLlmAdapter('user-alice');

    const options: GenerateOptions = {
      provider: 'demo-provider',
      model: 'demo-model',
      messages: [
        {
          id: MessageId('msg_00000000000000000000000000000001'),
          role: 'user',
          content: [{ type: 'text', text: 'Call tool and summarize' }],
          source: { kind: 'user' },
        },
        {
          id: MessageId('msg_00000000000000000000000000000002'),
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              id: ToolCallId('call_test_001'),
              name: 'query_inventory',
              arguments: '{"item":"widget"}',
            },
          ],
          source: { kind: 'model', provider: 'demo-provider', model: 'demo-model' },
        },
        {
          id: MessageId('msg_00000000000000000000000000000003'),
          role: 'tool',
          toolCallId: ToolCallId('call_test_001'),
          content: [{ type: 'text', text: '{"stock":42,"warehouse":"zone-a"}' }],
          source: { kind: 'tool', callId: ToolCallId('call_test_001') },
        },
      ],
    };

    const output = await collectStream(adapter.stream(options));
    expect(output).toContain('(Result: {"stock":42,"warehouse":"zone-a"})');
    expect(output).toContain('Received turn: "Call tool and summarize');
  });

  it('ignores deprecated { type: "tool-result" } content blocks inside messages', async () => {
    const adapter = new DeterministicDemoLlmAdapter('user-alice');

    const options: GenerateOptions = {
      provider: 'demo-provider',
      model: 'demo-model',
      messages: [
        {
          id: MessageId('msg_00000000000000000000000000000001'),
          role: 'user',
          content: [
            { type: 'text', text: 'Check inventory' },
            // Legacy block shape that should now be ignored
            {
              type: 'tool-result',
              toolCallId: 'call_legacy_001',
              content: 'legacy-data-should-not-appear',
            } as any,
          ],
          source: { kind: 'user' },
        },
      ],
    };

    const output = await collectStream(adapter.stream(options));
    expect(output).not.toContain('legacy-data-should-not-appear');
  });

  it('reads system prompt from leading role: "system" message surface', async () => {
    const adapter = new DeterministicDemoLlmAdapter('user-alice');

    const options: GenerateOptions = {
      provider: 'demo-provider',
      model: 'demo-model',
      messages: [
        {
          id: MessageId('msg_00000000000000000000000000000000'),
          role: 'system',
          content: [{ type: 'text', text: 'Special system prompt for demo model' }],
          source: { kind: 'system-prompt' },
        },
        {
          id: MessageId('msg_00000000000000000000000000000001'),
          role: 'user',
          content: [{ type: 'text', text: 'Prompt with [enkeep-test-echo-instructions]' }],
          source: { kind: 'user' },
        },
      ],
    };

    const output = await collectStream(adapter.stream(options));
    expect(output).toContain('Echoed instructions tokens:');
  });

  it('supports RequestUserInput in messages without id or source', async () => {
    const adapter = new DeterministicDemoLlmAdapter('user-alice');

    const rawUserMessage: RequestMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'Hand-built one-shot question' }],
    };

    const options: GenerateOptions = {
      provider: 'demo-provider',
      model: 'demo-model',
      messages: [rawUserMessage],
    };

    const output = await collectStream(adapter.stream(options));
    expect(output).toContain('Hand-built one-shot question');
  });

  it('computeEffectiveInstructionTokens reads from messages[0] when role === "system"', () => {
    const messages: RequestMessage[] = [
      {
        id: MessageId('msg_00000000000000000000000000000000'),
        role: 'system',
        content: [{ type: 'text', text: 'Guidance: INSTRUCTION_TOKEN_SYSTEM_BASE_01' }],
        source: { kind: 'system-prompt' },
      },
    ];

    const tokens = computeEffectiveInstructionTokens(messages);
    expect(tokens).toEqual(['INSTRUCTION_TOKEN_SYSTEM_BASE_01']);
  });

  it('counts role: "tool" messages correctly for prompt-controlled sequential tool calls', async () => {
    const adapter = new DeterministicDemoLlmAdapter('user-alice');

    const promptWithTwoTools =
      '[enkeep-test-tool-call=tool_one:{"step":1}] and [enkeep-test-tool-call=tool_two:{"step":2}]';

    // First request: no tool result yet -> should yield first tool call
    const options1: GenerateOptions = {
      provider: 'demo-provider',
      model: 'demo-model',
      messages: [
        {
          id: MessageId('msg_00000000000000000000000000000001'),
          role: 'user',
          content: [{ type: 'text', text: promptWithTwoTools }],
          source: { kind: 'user' },
        },
      ],
    };

    const chunks1: StreamChunk[] = [];
    for await (const chunk of adapter.stream(options1)) {
      chunks1.push(chunk);
    }
    const finish1 = chunks1.find((c) => c.type === 'finish');
    expect(finish1).toBeDefined();
    if (finish1 && finish1.type === 'finish') {
      expect(finish1.reason.kind).toBe('tool-calls');
    }

    // Second request: first tool result present as role: 'tool' -> should yield second tool call
    const options2: GenerateOptions = {
      provider: 'demo-provider',
      model: 'demo-model',
      messages: [
        {
          id: MessageId('msg_00000000000000000000000000000001'),
          role: 'user',
          content: [{ type: 'text', text: promptWithTwoTools }],
          source: { kind: 'user' },
        },
        {
          id: MessageId('msg_00000000000000000000000000000002'),
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              id: ToolCallId('call_step_1'),
              name: 'tool_one',
              arguments: '{"step":1}',
            },
          ],
          source: { kind: 'model', provider: 'demo-provider', model: 'demo-model' },
        },
        {
          id: MessageId('msg_00000000000000000000000000000003'),
          role: 'tool',
          toolCallId: ToolCallId('call_step_1'),
          content: [{ type: 'text', text: '{"result":"step1-done"}' }],
          source: { kind: 'tool', callId: ToolCallId('call_step_1') },
        },
      ],
    };

    const chunks2: StreamChunk[] = [];
    for await (const chunk of adapter.stream(options2)) {
      chunks2.push(chunk);
    }
    const toolDelta2 = chunks2.find((c) => c.type === 'tool-call-delta');
    expect(toolDelta2).toBeDefined();
    if (toolDelta2 && toolDelta2.type === 'tool-call-delta') {
      expect(toolDelta2.name).toBe('tool_two');
    }
  });

  it('companion invariant modules apply cleanly as no-ops without dsh-invariants', () => {
    const ctx = new Context();
    expect(() => ctx.plugin(affinityInvariant)).not.toThrow();
    expect(() => ctx.plugin(bundleInvariant)).not.toThrow();
    expect(() => ctx.plugin(interactionInvariant)).not.toThrow();
  });
});
