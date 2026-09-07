import { describe, it, expect } from 'vitest';
import {
  computeAgentProfilePromptHash as serverComputePromptHash,
  canonicalJsonStringify,
  validatePromptSections,
  ALLOWED_RUNTIME_PROFILE_KEYS,
  type RuntimeAgentProfileSnapshot,
} from '../src/profiles/profile-service.js';
import {
  computeAgentProfilePromptHash as runtimeComputePromptHash,
  validateAgentProfileSnapshot as runtimeValidateSnapshot,
  ALLOWED_PROFILE_KEYS as RUNTIME_ALLOWED_PROFILE_KEYS,
} from '../../runtime-runner/src/runtime/agent-profile.js';

describe('Cross-Package Agent Profile Canonical Prompt Hash & Contract Compatibility', () => {
  const testVectors = [
    {
      name: 'All Empty Sections',
      sections: { identity: '', soul: '', agents: '', tools: '' },
    },
    {
      name: 'Single Section Populated',
      sections: { identity: 'You are an autonomous AI agent.', soul: '', agents: '', tools: '' },
    },
    {
      name: 'Full Realistic Production Prompt',
      sections: {
        identity: 'You are an AI assistant powered by DeepSeek Harness in workspace /workspace/app.',
        soul: 'Be direct, pragmatic, and helpful. Prioritize safety and clarity in all operations.',
        agents: '1. subagent: delegate tasks.\n2. workflow: run multi-agent workflows.\n3. ralph: iterative Ralph loop.',
        tools: '1. read: read files.\n2. write: write files.\n3. edit: edit files.\n4. bash: execute commands safely.',
      },
    },
    {
      name: 'CJK and Multilingual Characters',
      sections: {
        identity: '你是运行在 Enkeep 平台的专业开发助手。',
        soul: '常に明確で簡潔な説明を提供してください。',
        agents: '각 하위 에이전트에게 명확한 역할을 부여하세요.',
        tools: 'Инструменты: чтение, запись, выполнение команд.',
      },
    },
    {
      name: 'Complex Whitespace (tabs, carriage returns, unix newlines)',
      sections: {
        identity: 'Line 1\r\nLine 2\tTabbed\nLine 3\n\n\nTrailing',
        soul: '\t\tIndented soul\r\nMultiple\r\nLines',
        agents: 'Agent A\n\tAgent B\n\tAgent C',
        tools: 'Tool 1\r\nTool 2\r\n',
      },
    },
    {
      name: 'Symbols and JSON Escapes',
      sections: {
        identity: 'Escapes: "double quotes" and \'single quotes\', \\backslashes\\ and /slashes/',
        soul: 'Symbols: ~!@#$%^&*()_+`-={}|[]\\:";\'<>?,./',
        agents: 'Formatting: <b>html-like</b> & amp; {braces}',
        tools: 'Regex: ^[a-z0-9_-]{1,64}$',
      },
    },
    {
      name: 'Large 64 KiB Limit Vector',
      sections: {
        identity: 'A'.repeat(16384),
        soul: 'B'.repeat(16384),
        agents: 'C'.repeat(16384),
        tools: 'D'.repeat(16384),
      },
    },
  ];

  it('produces 100% identical SHA-256 hashes across all test vectors between platform-server and runtime-runner', () => {
    for (const vector of testVectors) {
      const serverHash = serverComputePromptHash(vector.sections);
      const runtimeHash = runtimeComputePromptHash(vector.sections);

      expect(serverHash).toBe(runtimeHash);
      expect(serverHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('agrees on canonical JSON stringification order: agents -> identity -> soul -> tools', () => {
    const s = {
      tools: 'T',
      identity: 'I',
      soul: 'S',
      agents: 'A',
    };
    const stringified = canonicalJsonStringify(s);
    expect(stringified).toBe('{"agents":"A","identity":"I","soul":"S","tools":"T"}');
  });

  it('validates that platform-server RuntimeAgentProfileSnapshot exactly satisfies runtime-runner validateAgentProfileSnapshot', () => {
    const snapshot: RuntimeAgentProfileSnapshot = {
      profileId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
      version: 3,
      promptHash: serverComputePromptHash({
        identity: 'Server Identity',
        soul: 'Server Soul',
        agents: 'Server Agents',
        tools: 'Server Tools',
      }),
      identity: 'Server Identity',
      soul: 'Server Soul',
      agents: 'Server Agents',
      tools: 'Server Tools',
    };

    // Verify snapshot keys match the 7 allowed runtime keys
    expect(new Set(Object.keys(snapshot))).toEqual(ALLOWED_RUNTIME_PROFILE_KEYS);
    expect(new Set(Object.keys(snapshot))).toEqual(RUNTIME_ALLOWED_PROFILE_KEYS);

    // Must be accepted by runtime runner validator
    const validated = runtimeValidateSnapshot(snapshot);
    expect(validated).toBeDefined();
    expect(validated.profileId).toBe(snapshot.profileId);
    expect(validated.version).toBe(3);
    expect(validated.promptHash).toBe(snapshot.promptHash);
  });
});
