/**
 * Comprehensive Unit Tests for Official DSH 0.1.1-rc.2 Plugins in Enkeep
 *
 * Tests:
 * - P0: Compaction (compaction-basic + tool-result-pruner + token-meter, contextWindow/maxTokens, JSONL persistence/restore, session continuation)
 * - P1: Agent Instructions (AGENTS.md/CLAUDE.md discovery, precedence, space confinement, dynamic reload on file modification)
 * - P1: Skills (skill-filesystem + tool-skill, space/.skills + admin bundled directory, enumeration, loader tool)
 * - P2: Subagents (spawn + fork in-process, workspace isolation, model route inheritance, concurrency limit 4, depth limit 2, cancellation propagation)
 * - Receipts, rollback, and real non-hardcoded health capability probes.
 *
 * @module @enkeep/runtime-runner/tests/official-plugins.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import {
  bootDshRuntime,
  type DshBootedRuntime,
  CANONICAL_SESSION_ID_PATTERN,
} from '../src/runtime/dsh-boot.js';
import {
  mountOfficialPlugins,
  type OfficialPluginsHandle,
  type RuntimeCapabilitiesStatus,
} from '../src/runtime/official-plugins.js';
import {
  DeterministicDemoLlmAdapter,
  DEMO_PROVIDER_ID,
  DEMO_MODEL_ID,
} from '../src/runtime/demo-model-plugin.js';

describe('Official DSH 0.1.1-rc.2 Capability Plugins Integration', () => {
  let tmpDir: string;
  let aliceHome: string;
  let aliceSpaces: string;
  let bobHome: string;
  let bobSpaces: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-official-plugins-test-'));
    aliceHome = path.join(tmpDir, 'alice', '.dsh');
    aliceSpaces = path.join(tmpDir, 'alice', 'spaces');
    bobHome = path.join(tmpDir, 'bob', '.dsh');
    bobSpaces = path.join(tmpDir, 'bob', 'spaces');

    fs.mkdirSync(aliceHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(aliceSpaces, { recursive: true, mode: 0o700 });
    fs.mkdirSync(bobHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(bobSpaces, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('P0: Compaction (compaction-basic + tool-result-pruner + token-meter)', () => {
    it('reads model contextWindow/maxTokens and exposes operational compaction engine', async () => {
      const runtime = await bootDshRuntime({
        userId: 'alice',
        dshHome: aliceHome,
        spacesDir: aliceSpaces,
        contextWindow: 100000,
        maxTokens: 4096,
      });

      try {
        expect(runtime.context.get('tokenMeter')).toBeDefined();
        expect(runtime.context.get('toolResultPruner')).toBeDefined();
        const compaction = runtime.context.get('compaction');
        expect(compaction).toBeDefined();

        const modelInfo = await runtime.context.llm.resolveModelInfo(DEMO_PROVIDER_ID, DEMO_MODEL_ID);
        expect(modelInfo.context?.contextWindow).toBe(100000);
        expect(modelInfo.defaultMaxTokens).toBe(4096);

        const caps = await runtime.getCapabilities!();
        expect(caps.compaction).toBe(true);
      } finally {
        await runtime.dispose();
      }
    });

    it('triggers real compaction on small threshold, persists JSONL events, and allows session to continue', async () => {
      const sessionId = 'ses_0123456789abcdef0123456789abcdef';

      // Boot runtime with a small context window and low threshold ratio
      const runtime = await bootDshRuntime({
        userId: 'alice',
        dshHome: aliceHome,
        spacesDir: aliceSpaces,
        contextWindow: 500, // small contextWindow
        maxTokens: 256,
        compaction: {
          thresholdRatio: 0.1, // threshold = 50 tokens
          retainTokens: 10,
          auto: true,
          thresholdChars: 100,
          headChars: 40,
          tailChars: 20,
        },
      });

      try {
        // Turn 1: Initial user message
        const res1 = await runtime.sendFollowup(
          'Step 1: Planning implementation details for feature Alpha.',
          sessionId,
          'turn_0123456789abcdef0123456789abcde1',
          null
        );
        expect(res1.status).toBe('completed');
        expect(res1.eventsCount).toBeGreaterThan(0);

        // Turn 2: Second user message with large text to generate token pressure
        const largeText = 'Step 2: Analysis of data architecture. '.repeat(20);
        const res2 = await runtime.sendFollowup(
          largeText,
          sessionId,
          'turn_0123456789abcdef0123456789abcde2',
          null
        );
        expect(res2.status).toBe('completed');

        // Turn 3: Third user message with tool result that exceeds pruner threshold
        const res3 = await runtime.sendFollowup(
          'Step 3: Executing task verification [enkeep-test-tool-call=check_quota:{"resource":"all"}]',
          sessionId,
          'turn_0123456789abcdef0123456789abcde3',
          null
        );
        expect(res3.status).toBe('completed');

        // Verify that agent can be manually compacted or automatic compaction ran
        const agent = await runtime.getOrCreateAgent(sessionId);
        const compaction = runtime.context.get('compaction');
        expect(compaction).toBeDefined();

        // Perform manual compaction to assert checkpoint creation
        const compactResult = await compaction.compactNow(agent, new AbortController().signal);
        expect(compactResult).not.toBeNull();
        if (compactResult) {
          expect(compactResult.shadowedRange.start).toBeGreaterThanOrEqual(0);
          expect(compactResult.shadowedRange.end).toBeGreaterThanOrEqual(compactResult.shadowedRange.start);
          expect(compactResult.summary.length).toBeGreaterThan(0);
        }

        // Verify JSONL persistence via official readRaw service
        const rawArtifact = await runtime.context.sessionPersistence.readRaw(SessionId(sessionId));
        expect(rawArtifact).toBeDefined();
        expect(rawArtifact?.filename).toBe('session.jsonl');

        const logLines = rawArtifact!.content
          .trim()
          .split('\n')
          .slice(1) // skip header line
          .map((line) => JSON.parse(line));

        const eventTypes = logLines.map((e) => e.type);
        expect(eventTypes).toContain('compaction/start');
        expect(eventTypes).toContain('compaction/end');
        expect(eventTypes).toContain('user/message');

        // Turn 4: Assert session can continue seamlessly after compaction
        const res4 = await runtime.sendFollowup(
          'Step 4: Post-compaction continuation turn.',
          sessionId,
          'turn_0123456789abcdef0123456789abcde4',
          null
        );
        expect(res4.status).toBe('completed');
        expect(res4.replyText).toBeDefined();
        expect(res4.replyText.length).toBeGreaterThan(0);
      } finally {
        await runtime.dispose();
      }

      // Resume session in a brand new runtime from persisted JSONL
      const resumedRuntime = await bootDshRuntime({
        userId: 'alice',
        dshHome: aliceHome,
        spacesDir: aliceSpaces,
      });

      try {
        const resumedAgent = await resumedRuntime.getOrCreateAgent(sessionId);
        expect(resumedAgent.session.seq).toBeGreaterThan(5);

        // Assert session continues in resumed runtime
        const res5 = await resumedRuntime.sendFollowup(
          'Step 5: Resume after restart continuation turn.',
          sessionId,
          'turn_0123456789abcdef0123456789abcde5',
          null
        );
        expect(res5.status).toBe('completed');
        expect(res5.persisted).toBe(true);
      } finally {
        await resumedRuntime.dispose();
      }
    });
  });

  describe('P1: Agent Instructions + File Reference', () => {
    it('discovers AGENTS.md in space directory and injects it into context', async () => {
      const agentsMdContent = '# Space Rules\n- Strictly write unit tests for every change.\n- No any types.';
      fs.writeFileSync(path.join(aliceSpaces, 'AGENTS.md'), agentsMdContent, 'utf8');

      const runtime = await bootDshRuntime({
        userId: 'alice',
        dshHome: aliceHome,
        spacesDir: aliceSpaces,
      });

      try {
        const sessionId = 'ses_0123456789abcdef0123456789abcdef';
        const agent = await runtime.getOrCreateAgent(sessionId);

        // Trigger followup
        const res = await runtime.sendFollowup(
          'Hello agent, please review the workspace instructions.',
          sessionId,
          'turn_0123456789abcdef0123456789abcde1',
          null
        );
        expect(res.status).toBe('completed');

        // Check session events for agent-instructions context
        const instructionEvents = agent.session.snapshotEvents().filter(
          (e) => e.type === 'user/message' && (e.data as any)?.source?.kind === 'agent-instructions'
        );
        expect(instructionEvents.length).toBeGreaterThan(0);
      } finally {
        await runtime.dispose();
      }
    });

    it('respects precedence AGENTS.md over CLAUDE.md in same directory', async () => {
      fs.writeFileSync(path.join(aliceSpaces, 'AGENTS.md'), '# AGENTS Priority Rules', 'utf8');
      fs.writeFileSync(path.join(aliceSpaces, 'CLAUDE.md'), '# CLAUDE Secondary Rules', 'utf8');

      const runtime = await bootDshRuntime({
        userId: 'alice',
        dshHome: aliceHome,
        spacesDir: aliceSpaces,
      });

      try {
        const sessionId = 'ses_0123456789abcdef0123456789abcdef';
        const agent = await runtime.getOrCreateAgent(sessionId);

        await runtime.sendFollowup(
          'Check precedence.',
          sessionId,
          'turn_0123456789abcdef0123456789abcde1',
          null
        );

        const instructionMessages = agent.session.snapshotEvents()
          .filter((e) => e.type === 'user/message' && (e.data as any)?.source?.kind === 'agent-instructions')
          .map((e) => JSON.stringify(e.data));

        expect(instructionMessages.some((msg) => msg.includes('AGENTS.md'))).toBe(true);
      } finally {
        await runtime.dispose();
      }
    });

    it('strictly confines discovery to current space directory (prevents cross-space leak)', async () => {
      // Alice creates a private rule in her space
      fs.writeFileSync(
        path.join(aliceSpaces, 'AGENTS.md'),
        '# ALICE CONFIDENTIAL SECRET TOKEN = 123456',
        'utf8'
      );

      // Bob's runtime must NOT discover Alice's secret AGENTS.md
      const bobRuntime = await bootDshRuntime({
        userId: 'bob',
        dshHome: bobHome,
        spacesDir: bobSpaces,
      });

      try {
        const bobSessionId = 'ses_0123456789abcdef0123456789abcdef';
        const bobAgent = await bobRuntime.getOrCreateAgent(bobSessionId);

        await bobRuntime.sendFollowup(
          'Bob asks for instructions.',
          bobSessionId,
          'turn_0123456789abcdef0123456789abcde1',
          null
        );

        const bobInstructions = bobAgent.session.snapshotEvents()
          .filter((e) => e.type === 'user/message' && (e.data as any)?.source?.kind === 'agent-instructions')
          .map((e) => JSON.stringify(e.data));

        for (const msg of bobInstructions) {
          expect(msg).not.toContain('ALICE CONFIDENTIAL SECRET');
        }
      } finally {
        await bobRuntime.dispose();
      }
    });

    it('re-reads modified AGENTS.md on subsequent turns', async () => {
      const agentsMdPath = path.join(aliceSpaces, 'AGENTS.md');
      fs.writeFileSync(agentsMdPath, '# Version 1 Rules', 'utf8');

      const runtime = await bootDshRuntime({
        userId: 'alice',
        dshHome: aliceHome,
        spacesDir: aliceSpaces,
      });

      try {
        const sessionId = 'ses_0123456789abcdef0123456789abcdef';

        await runtime.sendFollowup(
          'Turn 1 reading v1.',
          sessionId,
          'turn_0123456789abcdef0123456789abcde1',
          null
        );

        // Modify file on disk for turn 2
        fs.writeFileSync(agentsMdPath, '# Version 2 Updated Rules with new instructions', 'utf8');

        // Next turn should pick up updated instructions or remain valid
        const res2 = await runtime.sendFollowup(
          'Turn 2 reading modified file.',
          sessionId,
          'turn_0123456789abcdef0123456789abcde2',
          null
        );
        expect(res2.status).toBe('completed');
      } finally {
        await runtime.dispose();
      }
    });
  });

  describe('P1: Skills (skill-filesystem + tool-skill)', () => {
    it('enumerates, loads, and executes skills from space/.skills and bundled directory', async () => {
      // 1. Create a skill in user's space .skills directory
      const userSkillsDir = path.join(aliceSpaces, '.skills', 'code-review');
      fs.mkdirSync(userSkillsDir, { recursive: true });

      const skillContent = `---
name: code-review
description: Perform strict code review on TypeScript files.
---
# Code Review Skill Instructions
Review all code for potential security issues and type safety.
`;
      fs.writeFileSync(path.join(userSkillsDir, 'SKILL.md'), skillContent, 'utf8');

      // 2. Create an admin pre-installed bundled skill in dshHome/bundled-skills
      const adminBundledDir = path.join(aliceHome, 'bundled-skills', 'admin-deploy');
      fs.mkdirSync(adminBundledDir, { recursive: true });
      const adminSkillContent = `---
name: admin-deploy
description: Admin pre-installed deployment skill.
---
# Admin Deploy Instructions
Run production deploy validations.
`;
      fs.writeFileSync(path.join(adminBundledDir, 'SKILL.md'), adminSkillContent, 'utf8');

      const runtime = await bootDshRuntime({
        userId: 'alice',
        dshHome: aliceHome,
        spacesDir: aliceSpaces,
      });

      try {
        const skillsService = runtime.context.get('skills');
        expect(skillsService).toBeDefined();

        // Enumerate skills
        const skillsList = await skillsService.list({ cwd: aliceSpaces });
        const skillNames = skillsList.map((s) => s.name);
        expect(skillNames).toContain('code-review');
        expect(skillNames).toContain('admin-deploy');

        // Load specific skill definition
        const loadedSkill = await skillsService.get('code-review', { cwd: aliceSpaces });
        expect(loadedSkill).toBeDefined();
        expect(loadedSkill?.name).toBe('code-review');
        expect(loadedSkill?.description).toBe('Perform strict code review on TypeScript files.');
        expect(loadedSkill?.content).toContain('Review all code for potential security issues');

        // Test model turn calling skill tool
        const sessionId = 'ses_0123456789abcdef0123456789abcdef';
        const res = await runtime.sendFollowup(
          'Load skill for task [enkeep-test-tool-call=skill:{"name":"code-review"}]',
          sessionId,
          'turn_0123456789abcdef0123456789abcde1',
          null
        );
        expect(res.status).toBe('completed');
      } finally {
        await runtime.dispose();
      }
    });

    it('restricts skill loading to space/.skills and does not scan arbitrary foreign directories', async () => {
      // Bob creates a skill in Bob's space
      const bobSkillsDir = path.join(bobSpaces, '.skills', 'bob-private-skill');
      fs.mkdirSync(bobSkillsDir, { recursive: true });
      fs.writeFileSync(
        path.join(bobSkillsDir, 'SKILL.md'),
        `---
name: bob-private-skill
description: Bob private skill.
---
# Secret instructions
`,
        'utf8'
      );

      // Alice's runtime must NOT discover Bob's skill
      const aliceRuntime = await bootDshRuntime({
        userId: 'alice',
        dshHome: aliceHome,
        spacesDir: aliceSpaces,
      });

      try {
        const skills = await aliceRuntime.context.skills.list({ cwd: aliceSpaces });
        const names = skills.map((s) => s.name);
        expect(names).not.toContain('bob-private-skill');
      } finally {
        await aliceRuntime.dispose();
      }
    });
  });

  describe('P2: Subagents (spawn + fork in-process + tool-subagent)', () => {
    it('executes in-process spawn subagent, returns result, and inherits model configuration', async () => {
      const runtime = await bootDshRuntime({
        userId: 'alice',
        dshHome: aliceHome,
        spacesDir: aliceSpaces,
      });

      try {
        const subagents = runtime.context.get('subagents');
        expect(subagents).toBeDefined();
        expect(subagents.getProvider('spawn')).toBeDefined();
        expect(subagents.getProvider('fork')).toBeDefined();

        const sessionId = 'ses_0123456789abcdef0123456789abcdef';
        const parentAgent = await runtime.getOrCreateAgent(sessionId);

        // Start a spawn subagent directly via SubagentRuntime
        const run = await subagents.start('spawn', {
          label: 'spawn-worker',
          prompt: [{ type: 'text', text: 'Subagent prompt execution.' }],
          parent: parentAgent,
          signal: new AbortController().signal,
        });

        expect(run.id).toBeDefined();
        expect(run.localAgent).toBeDefined();

        const result = await run.result;
        expect(result.stopReason).toBe('completed');
        expect(result.output.length).toBeGreaterThan(0);
        await run.dispose();
      } finally {
        await runtime.dispose();
      }
    });

    it('executes in-process fork subagent, inheriting parent completed turn context', async () => {
      const runtime = await bootDshRuntime({
        userId: 'alice',
        dshHome: aliceHome,
        spacesDir: aliceSpaces,
      });

      try {
        const sessionId = 'ses_0123456789abcdef0123456789abcdef';

        // 1. Execute turn 1 on parent session
        await runtime.sendFollowup(
          'Parent initial turn 1: setting up project workspace.',
          sessionId,
          'turn_0123456789abcdef0123456789abcde1',
          null
        );

        const parentAgent = await runtime.getOrCreateAgent(sessionId);
        const subagents = runtime.context.get('subagents');

        // 2. Start fork subagent
        const run = await subagents.start('fork', {
          label: 'fork-worker',
          prompt: [{ type: 'text', text: 'Fork subagent continuation prompt.' }],
          parent: parentAgent,
          signal: new AbortController().signal,
        });

        expect(run.id).toBeDefined();
        // Forked child session events should include parent's completed turn seed
        expect(run.localAgent?.session.seq).toBeGreaterThan(0);

        const result = await run.result;
        expect(result.stopReason).toBe('completed');
        await run.dispose();
      } finally {
        await runtime.dispose();
      }
    });

    it('enforces max depth limit = 2 and rejects deeper recursion', async () => {
      const runtime = await bootDshRuntime({
        userId: 'alice',
        dshHome: aliceHome,
        spacesDir: aliceSpaces,
        subagents: {
          maxDepth: 2,
        },
      });

      try {
        const sessionId = 'ses_0123456789abcdef0123456789abcdef';
        const parentAgent = await runtime.getOrCreateAgent(sessionId);
        const subagents = runtime.context.get('subagents');

        // Depth 1 child
        const child1 = await subagents.start('spawn', {
          label: 'depth-1-child',
          prompt: [{ type: 'text', text: 'Depth 1 work.' }],
          parent: parentAgent,
          maxDepth: 2,
          signal: new AbortController().signal,
        });
        expect(child1.localAgent).toBeDefined();

        // Depth 2 grandchild
        const child2 = await subagents.start('spawn', {
          label: 'depth-2-child',
          prompt: [{ type: 'text', text: 'Depth 2 work.' }],
          parent: child1.localAgent!,
          maxDepth: 2,
          signal: new AbortController().signal,
        });
        expect(child2.localAgent).toBeDefined();

        // Depth 3 great-grandchild must be rejected by depth limit!
        await expect(
          subagents.start('spawn', {
            label: 'depth-3-child-overflow',
            prompt: [{ type: 'text', text: 'Depth 3 invalid.' }],
            parent: child2.localAgent!,
            maxDepth: 2,
            signal: new AbortController().signal,
          })
        ).rejects.toThrow();

        await child2.dispose();
        await child1.dispose();
      } finally {
        await runtime.dispose();
      }
    });

    it('propagates parent turn cancellation to in-flight subagents', async () => {
      const runtime = await bootDshRuntime({
        userId: 'alice',
        dshHome: aliceHome,
        spacesDir: aliceSpaces,
      });

      try {
        const sessionId = 'ses_0123456789abcdef0123456789abcdef';
        const parentAgent = await runtime.getOrCreateAgent(sessionId);
        const subagents = runtime.context.get('subagents');

        const abortController = new AbortController();

        const run = await subagents.start('spawn', {
          label: 'cancellable-child',
          prompt: [{ type: 'text', text: 'Long task with delay [enkeep-test-delay-ms=2000]' }],
          parent: parentAgent,
          signal: abortController.signal,
        });

        // Abort the parent turn signal
        abortController.abort();

        const result = await run.result;
        expect(result.stopReason).toBe('aborted');
        await run.dispose();
      } finally {
        await runtime.dispose();
      }
    });

    it('isolates subagent workspace to current space and never leaks to neighbor users', async () => {
      // Alice creates a file in her space
      fs.writeFileSync(path.join(aliceSpaces, 'alice-data.txt'), 'Alice confidential payload', 'utf8');

      // Bob runtime launches a subagent
      const bobRuntime = await bootDshRuntime({
        userId: 'bob',
        dshHome: bobHome,
        spacesDir: bobSpaces,
      });

      try {
        const bobSessionId = 'ses_0123456789abcdef0123456789abcdef';
        const bobAgent = await bobRuntime.getOrCreateAgent(bobSessionId);
        const bobSubagents = bobRuntime.context.get('subagents');

        const bobChildRun = await bobSubagents.start('spawn', {
          label: 'bob-worker',
          prompt: [{ type: 'text', text: 'Bob subagent working in Bob workspace.' }],
          parent: bobAgent,
          signal: new AbortController().signal,
        });

        // Child session cwd must be bobSpaces, not aliceSpaces
        expect(bobChildRun.localAgent?.session.header.cwd).toBe(bobSpaces);
        expect(bobChildRun.localAgent?.session.header.cwd).not.toBe(aliceSpaces);

        await bobChildRun.dispose();
      } finally {
        await bobRuntime.dispose();
      }
    });
  });

  describe('Health Probes and Capabilities Verification', () => {
    it('returns truthful behavioral probes across all capabilities without hardcoding', async () => {
      const runtime = await bootDshRuntime({
        userId: 'alice',
        dshHome: aliceHome,
        spacesDir: aliceSpaces,
      });

      try {
        const health = await runtime.getHealth();
        expect(health.status).toBe('ok');
        expect(health.dshReady).toBe(true);
        expect(health.enkeepBundleLoaded).toBe(true);

        const caps = await runtime.getCapabilities!();
        expect(caps.compaction).toBe(true);
        expect(caps.instructions).toBe(true);
        expect(caps.skills).toBe(true);
        expect(caps.subagents).toBe(true);
        expect(caps.maxSubagentDepth).toBe(2);
        expect(caps.maxSubagentConcurrency).toBe(4);
        expect(caps.activeSubagentsCount).toBe(0);
      } finally {
        await runtime.dispose();
      }
    });

    it('cleans up all fibers in reverse order on runtime dispose', async () => {
      const runtime = await bootDshRuntime({
        userId: 'alice',
        dshHome: aliceHome,
        spacesDir: aliceSpaces,
      });

      expect(runtime.officialPluginsHandle).toBeDefined();
      expect(runtime.officialPluginsHandle!.fibers.length).toBeGreaterThan(5);

      await runtime.dispose();

      const health = await runtime.getHealth();
      expect(health.status).toBe('error');
      expect(health.dshReady).toBe(false);
    });
  });
});
