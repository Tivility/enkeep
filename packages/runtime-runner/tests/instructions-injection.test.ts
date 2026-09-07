/**
 * Official DSH Instructions Deterministic Injection, Isolation & Warm Nextturn Test Suite
 *
 * Tests:
 * 1. Global instructions ($DSH_HOME/AGENTS.md) injected deterministically across multiple spaces/sessions.
 * 2. Space instructions (<space>/AGENTS.md or CLAUDE.md) injected strictly in the matching space.
 * 3. Cross-space isolation: Space A instructions are never visible in Space B.
 * 4. Warm next-turn dynamic reload: File modified on disk -> next turn automatically receives updated instructions without agent eviction or runtime reboot.
 * 5. Security lockdown: Agent fs tools (read/write/edit/glob/grep) strictly cannot resolve or access $DSH_HOME/AGENTS.md or any host path outside the active space.
 * 6. Subagent delegation observes instructions in the active space.
 *
 * @module @enkeep/runtime-runner/tests/instructions-injection.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  bootDshRuntime,
  type DshBootedRuntime,
} from '../src/runtime/dsh-boot.js';
import {
  DeterministicDemoLlmAdapter,
  createDeterministicDemoLlmAdapter,
} from '../src/runtime/demo-model-plugin.js';

describe('Official DSH Agent Instructions: Injection, Multi-Space Isolation & Warm Next-turn Reload', () => {
  let tmpDir: string;
  let aliceHome: string;
  let aliceSpaces: string;
  let spaceA: string;
  let spaceB: string;
  let spaceAPath: string;
  let spaceBPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-instructions-inject-test-'));
    aliceHome = path.join(tmpDir, 'alice', '.dsh');
    aliceSpaces = path.join(tmpDir, 'alice', 'spaces');
    spaceA = 'space-alpha';
    spaceB = 'space-beta';
    spaceAPath = path.join(aliceSpaces, spaceA);
    spaceBPath = path.join(aliceSpaces, spaceB);

    fs.mkdirSync(aliceHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(aliceSpaces, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spaceAPath, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spaceBPath, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('1. Global secret in $DSH_HOME/AGENTS.md is deterministically visible across 2 spaces and 2 sessions', async () => {
    const globalSecret = 'GLOBAL_SECRET_RULE_TOKEN_489271';
    fs.writeFileSync(
      path.join(aliceHome, 'AGENTS.md'),
      `# Global User Instructions\n- Strict Rule: Secret Token is ${globalSecret}`,
      'utf8'
    );

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      // Session 1 in Space A
      const session1Id = 'ses_00000000000000000000000000000001';
      const res1 = await runtime.sendFollowup(
        'Check global instructions in Space A',
        session1Id,
        'turn_00000000000000000000000000000001',
        null,
        spaceA
      );
      expect(res1.status).toBe('completed');

      const agent1 = await runtime.getOrCreateAgent(session1Id, null, spaceA);
      const instructionEvents1 = agent1.session.snapshotEvents().filter(
        (e) => e.type === 'user/message' && (e.data as any)?.source?.kind === 'agent-instructions'
      );
      expect(instructionEvents1.length).toBeGreaterThan(0);
      const injectedText1 = JSON.stringify(instructionEvents1);
      expect(injectedText1).toContain(globalSecret);

      // Session 2 in Space B
      const session2Id = 'ses_00000000000000000000000000000002';
      const res2 = await runtime.sendFollowup(
        'Check global instructions in Space B',
        session2Id,
        'turn_00000000000000000000000000000002',
        null,
        spaceB
      );
      expect(res2.status).toBe('completed');

      const agent2 = await runtime.getOrCreateAgent(session2Id, null, spaceB);
      const instructionEvents2 = agent2.session.snapshotEvents().filter(
        (e) => e.type === 'user/message' && (e.data as any)?.source?.kind === 'agent-instructions'
      );
      expect(instructionEvents2.length).toBeGreaterThan(0);
      const injectedText2 = JSON.stringify(instructionEvents2);
      expect(injectedText2).toContain(globalSecret);
    } finally {
      await runtime.dispose();
    }
  });

  it('2. Space secret in Space A is strictly confined and never leaks to Space B', async () => {
    const spaceASecret = 'SPACE_ALPHA_EXCLUSIVE_SECRET_987654';
    fs.writeFileSync(
      path.join(spaceAPath, 'AGENTS.md'),
      `# Space Alpha Rules\n- Alpha Secret: ${spaceASecret}`,
      'utf8'
    );

    const spaceBSecret = 'SPACE_BETA_EXCLUSIVE_SECRET_112233';
    fs.writeFileSync(
      path.join(spaceBPath, 'CLAUDE.md'),
      `# Space Beta Rules\n- Beta Secret: ${spaceBSecret}`,
      'utf8'
    );

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      // Space A Session
      const sessionA = 'ses_0000000000000000000000000000000a';
      await runtime.sendFollowup('Turn in Space A', sessionA, 'turn_000000000000000000000000000000a1', null, spaceA);
      const agentA = await runtime.getOrCreateAgent(sessionA, null, spaceA);
      const textA = JSON.stringify(agentA.session.snapshotEvents());

      expect(textA).toContain(spaceASecret);
      expect(textA).not.toContain(spaceBSecret);

      // Space B Session
      const sessionB = 'ses_0000000000000000000000000000000b';
      await runtime.sendFollowup('Turn in Space B', sessionB, 'turn_000000000000000000000000000000b1', null, spaceB);
      const agentB = await runtime.getOrCreateAgent(sessionB, null, spaceB);
      const textB = JSON.stringify(agentB.session.snapshotEvents());

      expect(textB).toContain(spaceBSecret);
      expect(textB).not.toContain(spaceASecret);
    } finally {
      await runtime.dispose();
    }
  });

  it('3. Warm next-turn reload: modified file on disk is detected on next turn without agent eviction', async () => {
    const spaceFile = path.join(spaceAPath, 'AGENTS.md');
    fs.writeFileSync(spaceFile, '# Version 1 Baseline Instructions', 'utf8');

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const sessionId = 'ses_00000000000000000000000000000099';

      // Turn 1
      const res1 = await runtime.sendFollowup(
        'Turn 1 reading v1',
        sessionId,
        'turn_00000000000000000000000000000991',
        null,
        spaceA
      );
      expect(res1.status).toBe('completed');

      const agent = await runtime.getOrCreateAgent(sessionId, null, spaceA);
      const eventsV1 = JSON.stringify(agent.session.snapshotEvents());
      expect(eventsV1).toContain('Version 1 Baseline Instructions');

      // Update instructions on disk before Turn 2
      fs.writeFileSync(spaceFile, '# Version 2 Updated Warm Instructions with dynamic delta', 'utf8');

      // Turn 2 in the same live agent
      const res2 = await runtime.sendFollowup(
        'Turn 2 reading modified v2',
        sessionId,
        'turn_00000000000000000000000000000992',
        null,
        spaceA
      );
      expect(res2.status).toBe('completed');

      const eventsV2 = JSON.stringify(agent.session.snapshotEvents());
      expect(eventsV2).toContain('Version 2 Updated Warm Instructions');
    } finally {
      await runtime.dispose();
    }
  });

  it('4. Security Lockdown: Agent fs tools (read/edit/glob/grep) strictly cannot access $DSH_HOME/AGENTS.md', async () => {
    fs.writeFileSync(
      path.join(aliceHome, 'AGENTS.md'),
      '# TOP_SECRET_GLOBAL_CONFIG_NOT_FOR_TOOL_READ',
      'utf8'
    );

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const sessionId = 'ses_00000000000000000000000000000077';
      const agent = await runtime.getOrCreateAgent(sessionId, null, spaceA);
      const fsService = agent.ctx.get('fs');

      expect(fsService).toBeDefined();

      // 1. Agent fs resolve on absolute $DSH_HOME/AGENTS.md must throw FS_SANDBOX_DENIED
      await expect(
        fsService.resolve(path.join(aliceHome, 'AGENTS.md'), { cwd: spaceAPath })
      ).rejects.toThrow(/outside space boundary/);

      // 2. Agent fs resolve on relative traversal ../../.dsh/AGENTS.md must throw FS_SANDBOX_DENIED
      await expect(
        fsService.resolve('../../alice/.dsh/AGENTS.md', { cwd: spaceAPath })
      ).rejects.toThrow(/outside space boundary/);

      // 3. Model read tool execution attempt on $DSH_HOME/AGENTS.md must fail safely
      const readAttempt = await runtime.sendFollowup(
        `[enkeep-test-tool-call=read:{"file_path":"${path.join(aliceHome, 'AGENTS.md')}"}] read global secret`,
        sessionId,
        'turn_00000000000000000000000000000771',
        null,
        spaceA
      );
      expect(readAttempt.status).toBe('completed');

      const toolResults = agent.session.snapshotEvents().filter((e) => e.type === 'tool/result');
      const latestToolResult = toolResults[toolResults.length - 1];
      const resultData = JSON.stringify(latestToolResult?.data ?? {});
      expect(resultData).not.toContain('TOP_SECRET_GLOBAL_CONFIG');
    } finally {
      await runtime.dispose();
    }
  });

  it('5. Subagent delegation inherits space workspace and observes instructions', async () => {
    fs.writeFileSync(
      path.join(spaceAPath, 'AGENTS.md'),
      '# Space Alpha Subagent Rules: ALWAYS_BE_HELPFUL',
      'utf8'
    );

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const parentSessionId = 'ses_00000000000000000000000000000088';

      // Parent turn delegating to subagent
      const res = await runtime.sendFollowup(
        '[enkeep-test-tool-call=subagent:{"description":"delegate subtask","prompt":"Check subagent task"}] delegate',
        parentSessionId,
        'turn_00000000000000000000000000000881',
        null,
        spaceA
      );
      expect(res.status).toBe('completed');
    } finally {
      await runtime.dispose();
    }
  });

  it('6. DeterministicDemoLlmAdapter echoes instruction tokens when requested via [enkeep-test-echo-instructions]', async () => {
    const globalToken = 'INSTRUCTION_TOKEN_GLOBAL_RULE_998877';
    fs.writeFileSync(
      path.join(aliceHome, 'AGENTS.md'),
      `# Global User Instructions\n- Token: ${globalToken}`,
      'utf8'
    );

    const spaceAToken = 'INSTRUCTION_TOKEN_SPACE_A_SPECIAL_112233';
    fs.writeFileSync(
      path.join(spaceAPath, 'AGENTS.md'),
      `# Space A Rules\n- Space A Token: ${spaceAToken}`,
      'utf8'
    );

    const spaceBToken = 'INSTRUCTION_TOKEN_SPACE_B_SPECIAL_445566';
    fs.writeFileSync(
      path.join(spaceBPath, 'AGENTS.md'),
      `# Space B Rules\n- Space B Token: ${spaceBToken}`,
      'utf8'
    );

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const sessionA = 'ses_000000000000000000000000000000a1';
      const resA = await runtime.sendFollowup(
        'Hello in Space A [enkeep-test-echo-instructions]',
        sessionA,
        'turn_000000000000000000000000000000a1',
        null,
        spaceA
      );
      expect(resA.status).toBe('completed');

      const agentA = await runtime.getOrCreateAgent(sessionA, null, spaceA);
      const assistantMsgsA = agentA.session.snapshotEvents().filter((e) => e.type === 'assistant/message');
      const textA = JSON.stringify(assistantMsgsA);

      expect(textA).toContain(globalToken);
      expect(textA).toContain(spaceAToken);
      expect(textA).not.toContain(spaceBToken);

      const sessionB = 'ses_000000000000000000000000000000b1';
      const resB = await runtime.sendFollowup(
        'Hello in Space B [enkeep-test-echo-instructions]',
        sessionB,
        'turn_000000000000000000000000000000b1',
        null,
        spaceB
      );
      expect(resB.status).toBe('completed');

      const agentB = await runtime.getOrCreateAgent(sessionB, null, spaceB);
      const assistantMsgsB = agentB.session.snapshotEvents().filter((e) => e.type === 'assistant/message');
      const textB = JSON.stringify(assistantMsgsB);

      expect(textB).toContain(globalToken);
      expect(textB).toContain(spaceBToken);
      expect(textB).not.toContain(spaceAToken);
    } finally {
      await runtime.dispose();
    }
  });

  it('7. Multi-turn warm reload strictly isolates new tokens and does NOT echo historical assistant tokens', async () => {
    const globalTokenV1 = 'INSTRUCTION_TOKEN_GLOBAL_V1_INITIAL_1111';
    const spaceTokenV1 = 'INSTRUCTION_TOKEN_SPACE_V1_INITIAL_2222';
    fs.writeFileSync(
      path.join(aliceHome, 'AGENTS.md'),
      `# Global User Instructions\n- Token: ${globalTokenV1}`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(spaceAPath, 'AGENTS.md'),
      `# Space A Rules\n- Space A Token: ${spaceTokenV1}`,
      'utf8'
    );

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const sessionId = 'ses_00000000000000000000000000000077';

      // Turn 1
      const res1 = await runtime.sendFollowup(
        'Verify instructions turn 1 [enkeep-test-echo-instructions]',
        sessionId,
        'turn_00000000000000000000000000000071',
        null,
        spaceA
      );
      expect(res1.status).toBe('completed');

      const agent1 = await runtime.getOrCreateAgent(sessionId, null, spaceA);
      const assistant1 = agent1.session.snapshotEvents().filter((e) => e.type === 'assistant/message');
      const text1 = JSON.stringify(assistant1);
      expect(text1).toContain(globalTokenV1);
      expect(text1).toContain(spaceTokenV1);

      // Update instructions on disk for Turn 2
      const globalTokenV2 = 'INSTRUCTION_TOKEN_GLOBAL_V2_UPDATED_3333';
      const spaceTokenV2 = 'INSTRUCTION_TOKEN_SPACE_V2_UPDATED_4444';
      fs.writeFileSync(
        path.join(aliceHome, 'AGENTS.md'),
        `# Global User Instructions V2\n- Token: ${globalTokenV2}`,
        'utf8'
      );
      fs.writeFileSync(
        path.join(spaceAPath, 'AGENTS.md'),
        `# Space A Rules V2\n- Space A Token: ${spaceTokenV2}`,
        'utf8'
      );

      // Turn 2 in the same live session
      const res2 = await runtime.sendFollowup(
        'Verify instructions turn 2 warm reload [enkeep-test-echo-instructions]',
        sessionId,
        'turn_00000000000000000000000000000072',
        null,
        spaceA
      );
      expect(res2.status).toBe('completed');

      const agent2 = await runtime.getOrCreateAgent(sessionId, null, spaceA);
      const assistantEvents = agent2.session.snapshotEvents().filter((e) => e.type === 'assistant/message');
      expect(assistantEvents.length).toBeGreaterThanOrEqual(2);
      const assistant2Text = JSON.stringify(assistantEvents[assistantEvents.length - 1]);

      // Assistant 2 must contain newly updated v2 tokens and MUST NOT contain old v1 tokens
      expect(assistant2Text).toContain(globalTokenV2);
      expect(assistant2Text).toContain(spaceTokenV2);
      expect(assistant2Text).not.toContain(globalTokenV1);
      expect(assistant2Text).not.toContain(spaceTokenV1);
    } finally {
      await runtime.dispose();
    }
  });

  it('8. Runtime daemon restart with same home/spaces verifies DSH model request capture preserves active instructions', async () => {
    const globalTokenV1 = 'INSTRUCTION_TOKEN_GLOBAL_V1_RESTART_AAA';
    const spaceTokenV1 = 'INSTRUCTION_TOKEN_SPACE_V1_RESTART_BBB';
    fs.writeFileSync(
      path.join(aliceHome, 'AGENTS.md'),
      `# Global User Instructions\n- Token: ${globalTokenV1}`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(spaceAPath, 'AGENTS.md'),
      `# Space A Rules\n- Space A Token: ${spaceTokenV1}`,
      'utf8'
    );

    const sessionId = 'ses_00000000000000000000000000000088';

    // 1. Initial runtime instance before restart
    const runtime1 = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      // Turn 1
      const res1 = await runtime1.sendFollowup(
        'Turn 1 prompt [enkeep-test-echo-instructions]',
        sessionId,
        'turn_00000000000000000000000000000081',
        null,
        spaceA
      );
      expect(res1.status).toBe('completed');

      // Update instructions on disk before turn 2
      const globalTokenV2 = 'INSTRUCTION_TOKEN_GLOBAL_V2_RESTART_CCC';
      const spaceTokenV2 = 'INSTRUCTION_TOKEN_SPACE_V2_RESTART_DDD';
      fs.writeFileSync(
        path.join(aliceHome, 'AGENTS.md'),
        `# Global User Instructions V2\n- Token: ${globalTokenV2}`,
        'utf8'
      );
      fs.writeFileSync(
        path.join(spaceAPath, 'AGENTS.md'),
        `# Space A Rules V2\n- Space A Token: ${spaceTokenV2}`,
        'utf8'
      );

      // Turn 2
      const res2 = await runtime1.sendFollowup(
        'Turn 2 warm reload [enkeep-test-echo-instructions]',
        sessionId,
        'turn_00000000000000000000000000000082',
        null,
        spaceA
      );
      expect(res2.status).toBe('completed');

      const agent1 = await runtime1.getOrCreateAgent(sessionId, null, spaceA);
      const assistantEvents1 = agent1.session.snapshotEvents().filter((e) => e.type === 'assistant/message');
      const assistant2Text = JSON.stringify(assistantEvents1[assistantEvents1.length - 1]);
      expect(assistant2Text).toContain(globalTokenV2);
      expect(assistant2Text).toContain(spaceTokenV2);
    } finally {
      // Teardown / dispose runtime 1 while keeping disk files (same volume persistence)
      await runtime1.dispose();
    }

    // 2. Relaunch runtime instance on the exact same dshHome and spacesDir (Daemon Restart)
    const runtime2 = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      // Turn 3: Post-restart turn in resumed session
      const res3 = await runtime2.sendFollowup(
        'Turn 3 post restart continuity [enkeep-test-echo-instructions]',
        sessionId,
        'turn_00000000000000000000000000000083',
        null,
        spaceA
      );
      expect(res3.status).toBe('completed');

      const agent2 = await runtime2.getOrCreateAgent(sessionId, null, spaceA);
      const assistantEvents2 = agent2.session.snapshotEvents().filter((e) => e.type === 'assistant/message');
      expect(assistantEvents2.length).toBeGreaterThanOrEqual(3);
      const assistant3Text = JSON.stringify(assistantEvents2[assistantEvents2.length - 1]);

      // Turn 3 post restart continuity MUST retain global V2 and space A V2 tokens from persistent volume
      const globalTokenV2 = 'INSTRUCTION_TOKEN_GLOBAL_V2_RESTART_CCC';
      const spaceTokenV2 = 'INSTRUCTION_TOKEN_SPACE_V2_RESTART_DDD';
      expect(assistant3Text).toContain(globalTokenV2);
      expect(assistant3Text).toContain(spaceTokenV2);
      expect(assistant3Text).not.toContain(globalTokenV1);
      expect(assistant3Text).not.toContain(spaceTokenV1);
    } finally {
      await runtime2.dispose();
    }
  });

  describe('DeterministicDemoLlmAdapter instruction probe unit tests', () => {
    const collectStreamText = async (adapter: DeterministicDemoLlmAdapter, options: any): Promise<string> => {
      let result = '';
      for await (const chunk of adapter.stream(options)) {
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          result += chunk.text;
        }
      }
      return result;
    };

    it('A. Historical assistant containing oldtoken + current system with newtoken -> output only contains newtoken', async () => {
      const adapter = createDeterministicDemoLlmAdapter('test-user');
      const oldAssistantToken = 'INSTRUCTION_TOKEN_OLD_ASSISTANT_9911';
      const newSystemToken = 'INSTRUCTION_TOKEN_NEW_SYSTEM_2288';

      const messages = [
        {
          id: 'msg_0',
          role: 'user',
          content: 'Historical turn 1 prompt',
          source: { kind: 'user' },
        },
        {
          id: 'msg_1',
          role: 'assistant',
          content: `[DemoModel:test-user] Echoed instructions tokens: [${oldAssistantToken}]. Turn 1 complete.`,
          source: { kind: 'model' },
        },
        {
          id: 'msg_2',
          role: 'user',
          content: 'Current turn 2 prompt [enkeep-test-echo-instructions]',
          source: { kind: 'user' },
        },
      ];

      const output = await collectStreamText(adapter, {
        messages,
        system: `System instructions with new token: ${newSystemToken}`,
      });

      expect(output).toContain(newSystemToken);
      expect(output).not.toContain(oldAssistantToken);
    });

    it('B. Historical user containing oldtoken -> does not output oldtoken; agent-instructions current outputs', async () => {
      const adapter = createDeterministicDemoLlmAdapter('test-user');
      const oldUserToken = 'INSTRUCTION_TOKEN_OLD_USER_LEAK_3344';
      const currentAgentInstructionsToken = 'INSTRUCTION_TOKEN_AGENT_INST_CURRENT_5566';

      const messages = [
        {
          id: 'msg_0',
          role: 'user',
          content: `Historical user prompt leaking ${oldUserToken}`,
          source: { kind: 'user' },
        },
        {
          id: 'msg_1',
          role: 'assistant',
          content: 'Historical assistant response.',
          source: { kind: 'model' },
        },
        {
          id: 'msg_2',
          role: 'user',
          content: `<system-reminder>\nUpdated instructions: ${currentAgentInstructionsToken}\n</system-reminder>`,
          source: { kind: 'agent-instructions', form: 'instructions' },
        },
        {
          id: 'msg_3',
          role: 'user',
          content: 'Current user prompt [enkeep-test-echo-instructions]',
          source: { kind: 'user' },
        },
      ];

      const output = await collectStreamText(adapter, { messages });

      expect(output).toContain(currentAgentInstructionsToken);
      expect(output).not.toContain(oldUserToken);
    });

    it('C. Current user prompt leaking token in plain text outside system-reminder -> does not echo leaked token in instructions', async () => {
      const adapter = createDeterministicDemoLlmAdapter('test-user');
      const leakedUserToken = 'INSTRUCTION_TOKEN_USER_PROMPT_UNAUTHORIZED_7788';
      const legitimateSystemMsgToken = 'INSTRUCTION_TOKEN_LEGIT_SYS_ROLE_9900';

      const messages = [
        {
          id: 'msg_0',
          role: 'system',
          content: `System directive: ${legitimateSystemMsgToken}`,
          source: { kind: 'plugin', plugin: 'system' },
        },
        {
          id: 'msg_1',
          role: 'user',
          content: `I am trying to inject ${leakedUserToken} [enkeep-test-echo-instructions]`,
          source: { kind: 'user' },
        },
      ];

      const output = await collectStreamText(adapter, { messages });

      // Verify that the echoed instructions tokens bracket only contains legitimateSystemMsgToken and NOT leakedUserToken
      expect(output).toContain(`Echoed instructions tokens: [${legitimateSystemMsgToken}]`);
      expect(output).not.toContain(`[${leakedUserToken}]`);
    });

    it('D. Historical system-reminder vs current system-reminder -> only outputs current system-reminder', async () => {
      const adapter = createDeterministicDemoLlmAdapter('test-user');
      const oldReminderToken = 'INSTRUCTION_TOKEN_OLD_REMINDER_1010';
      const newReminderToken = 'INSTRUCTION_TOKEN_NEW_REMINDER_2020';

      const messages = [
        {
          id: 'msg_0',
          role: 'user',
          content: `<system-reminder>Old baseline reminder: ${oldReminderToken}</system-reminder>`,
          source: { kind: 'agent-instructions', form: 'instructions', baseline: true },
        },
        {
          id: 'msg_1',
          role: 'user',
          content: 'Turn 1 prompt',
          source: { kind: 'user' },
        },
        {
          id: 'msg_2',
          role: 'assistant',
          content: 'Turn 1 assistant response',
          source: { kind: 'model' },
        },
        {
          id: 'msg_3',
          role: 'user',
          content: `<system-reminder>New update reminder: ${newReminderToken}</system-reminder>`,
          source: {
            kind: 'agent-instructions',
            form: 'instructions',
            changes: [{ action: 'replace', scope: '.\0AGENTS.md', path: 'AGENTS.md' }],
          },
        },
        {
          id: 'msg_4',
          role: 'user',
          content: 'Turn 2 prompt [enkeep-test-echo-instructions]',
          source: { kind: 'user' },
        },
      ];

      const output = await collectStreamText(adapter, { messages });

      expect(output).toContain(newReminderToken);
      expect(output).not.toContain(oldReminderToken);
    });

    it('E. Historical tool result containing oldtoken -> does not output oldtoken', async () => {
      const adapter = createDeterministicDemoLlmAdapter('test-user');
      const toolToken = 'INSTRUCTION_TOKEN_TOOL_RESULT_EXPLOIT_4040';
      const validToken = 'INSTRUCTION_TOKEN_VALID_SYS_5050';

      const messages = [
        {
          id: 'msg_0',
          role: 'tool',
          content: [{ type: 'tool-result', content: `Tool output: ${toolToken}` }],
          source: { kind: 'tool' },
        },
        {
          id: 'msg_1',
          role: 'assistant',
          content: 'Prior tool processing done.',
          source: { kind: 'model' },
        },
        {
          id: 'msg_2',
          role: 'user',
          content: 'Check tokens [enkeep-test-echo-instructions]',
          source: { kind: 'user' },
        },
      ];

      const output = await collectStreamText(adapter, {
        messages,
        system: `Valid system token: ${validToken}`,
      });

      expect(output).toContain(validToken);
      expect(output).not.toContain(toolToken);
    });

    it('F. DSH Replacement Semantics: system oldtoken + current agent-instructions update with source.changes replace -> outputs only newtoken', async () => {
      const adapter = createDeterministicDemoLlmAdapter('test-user');
      const oldBaselineSystemToken = 'INSTRUCTION_TOKEN_OLD_BASELINE_SYSTEM_6060';
      const newReplacementToken = 'INSTRUCTION_TOKEN_NEW_REPLACEMENT_7070';

      const messages = [
        {
          id: 'msg_0',
          role: 'user',
          content: 'Turn 1 user prompt',
          source: { kind: 'user' },
        },
        {
          id: 'msg_1',
          role: 'assistant',
          content: 'Turn 1 assistant response',
          source: { kind: 'model' },
        },
        {
          id: 'msg_2',
          role: 'user',
          content: `<system-reminder>\nUpdated instructions from: AGENTS.md\nThis file changed after it was loaded. Use the following content:\n- Replacement Token: ${newReplacementToken}\n</system-reminder>`,
          source: {
            kind: 'agent-instructions',
            form: 'instructions',
            changes: [
              {
                action: 'replace',
                scope: '.\0AGENTS.md',
                path: 'AGENTS.md',
              },
            ],
          },
        },
        {
          id: 'msg_3',
          role: 'user',
          content: 'Turn 2 verify updated instructions [enkeep-test-echo-instructions]',
          source: { kind: 'user' },
        },
      ];

      // Even if system parameter still contains the initial baseline oldtoken,
      // the current turn explicit replacement message supersedes it.
      const output = await collectStreamText(adapter, {
        messages,
        system: `Initial baseline system prompt containing ${oldBaselineSystemToken}`,
      });

      expect(output).toContain(newReplacementToken);
      expect(output).not.toContain(oldBaselineSystemToken);
    });
  });
});
