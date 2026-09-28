import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionActivationPlan } from '@enkeep/protocol';
import { bootDshRuntime, type DshBootedRuntime } from '../src/runtime/dsh-boot.js';

describe('G06: Dynamic Skill Install Activation & Scoped Quiesce Lifecycle', () => {
  let tempDir: string;
  let dshHome: string;
  let spacesDir: string;
  let runtime: DshBootedRuntime | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-g06-skill-lifecycle-test-'));
    dshHome = path.join(tempDir, '.dsh');
    spacesDir = path.join(tempDir, 'spaces');

    fs.mkdirSync(dshHome, { recursive: true });
    fs.mkdirSync(path.join(spacesDir, 'space-alpha'), { recursive: true });
    fs.mkdirSync(path.join(spacesDir, 'space-beta'), { recursive: true });
  });

  afterEach(async () => {
    if (runtime) {
      try {
        await runtime.dispose();
      } catch {}
      runtime = undefined;
    }
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('installs generic skill dynamically, updates plan, and recognizes skill in next turn while restoring history', async () => {
    runtime = await bootDshRuntime({
      userId: 'test-user',
      dshHome,
      spacesDir,
    });

    const sessionId = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    // 1. Turn 1: Initial query in space-alpha before skill is installed
    const turn1Res = await runtime.sendFollowup({
      prompt: 'Hello, please establish the initial session context',
      sessionId,
      turnId: 'turn_11111111111111111111111111111111',
      workspaceFolder: 'space-alpha',
    });
    expect(turn1Res.status).toBe('completed');
    expect(turn1Res.eventsCount).toBeGreaterThan(0);
    const initialEventsCount = turn1Res.eventsCount;

    // Verify agent is cached in memory
    expect(runtime.agentHandles?.has(sessionId)).toBe(true);
    const originalHandle = runtime.agentHandles?.get(sessionId);
    expect(originalHandle).toBeDefined();

    // 2. Install generic harmless skill to space-alpha/.skills/generic-calc
    const skillDir = path.join(spacesDir, 'space-alpha', '.skills', 'generic-calc');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---
name: generic-calc
description: A safe generic math computation utility
---
# Calculation Rules
Calculate result deterministically.
`,
      'utf8'
    );

    // 3. Update ExtensionActivationPlan for space-alpha
    const planWithSkill: ExtensionActivationPlan = {
      generation: 2,
      contributions: [
        {
          kind: 'skill',
          contributionId: 'c_generic_calc',
          contributionKey: 'generic-calc',
          name: 'generic-calc',
          enabled: true,
          modelInvocable: true,
          userInvocable: true,
          version: 1,
        },
      ],
      skills: [
        {
          kind: 'skill',
          contributionId: 'c_generic_calc',
          contributionKey: 'generic-calc',
          name: 'generic-calc',
          enabled: true,
          modelInvocable: true,
          userInvocable: true,
          version: 1,
        },
      ],
    };

    expect(typeof runtime.updateExtensionPlan).toBe('function');
    await runtime.updateExtensionPlan!('space-alpha', planWithSkill);

    // Scoped quiesce: idle agent handle should be safely disposed and evicted
    expect(runtime.agentHandles?.has(sessionId)).toBe(false);
    expect(runtime.isSessionDirty?.(sessionId)).toBe(true);

    // 4. Turn 2: Next turn in same session invokes the new skill via demo tool-call
    const turn2Res = await runtime.sendFollowup({
      prompt: 'Execute calculation [enkeep-test-tool-call=skill:{"name":"generic-calc"}]',
      sessionId,
      turnId: 'turn_22222222222222222222222222222222',
      workspaceFolder: 'space-alpha',
    });

    expect(turn2Res.status).toBe('completed');
    expect(turn2Res.replyText).toContain('generic-calc');
    // History must be preserved and monotonically advanced across resume
    expect(turn2Res.eventsCount).toBeGreaterThan(initialEventsCount);

    // Rebuild succeeded: dirty marker must now be cleared and new handle cached
    expect(runtime.isSessionDirty?.(sessionId)).toBe(false);
    expect(runtime.agentHandles?.has(sessionId)).toBe(true);
    const newHandle = runtime.agentHandles?.get(sessionId);
    expect(newHandle).toBeDefined();
    expect(newHandle).not.toBe(originalHandle);

    // Direct assertion on actual skillsService.list enumeration via existing exposed context (not just string stub)
    const skillsService = runtime.context.get('skills');
    expect(skillsService).toBeDefined();
    const discoveredSkills = await skillsService.list({
      scope: newHandle!.agent,
      cwd: path.join(spacesDir, 'space-alpha'),
    });
    expect(discoveredSkills.map((s: any) => s.name)).toContain('generic-calc');
    const calcDetail = await skillsService.get('generic-calc', {
      scope: newHandle!.agent,
      cwd: path.join(spacesDir, 'space-alpha'),
    });
    expect(calcDetail?.name).toBe('generic-calc');
    expect(calcDetail?.content).toContain('Calculate result deterministically');
  });

  it('handles plan update during busy execution by deferring safely to turn boundary and clearing dirty marker only on rebuild success', async () => {
    runtime = await bootDshRuntime({
      userId: 'test-user',
      dshHome,
      spacesDir,
    });

    const sessionId = 'ses_cccccccccccccccccccccccccccccccc';

    // 1. Establish initial agent in space-alpha
    const turn1Res = await runtime.sendFollowup({
      prompt: 'Initial query in space alpha',
      sessionId,
      turnId: 'turn_33333333333333333333333333333331',
      workspaceFolder: 'space-alpha',
    });
    expect(turn1Res.status).toBe('completed');
    expect(runtime.agentHandles?.has(sessionId)).toBe(true);

    // 2. Simulate busy condition: an active turn is currently in-flight for sessionId
    const busyTurnId = 'turn_33333333333333333333333333333332';
    // We register active turn in runtime's activeTurns map to test busy guard
    const activeHandleBefore = runtime.agentHandles!.get(sessionId)!;

    // Install a new generic skill
    const skillDir = path.join(spacesDir, 'space-alpha', '.skills', 'generic-audit');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---
name: generic-audit
description: Harmless audit inspector
---
# Audit
Audit completed.
`,
      'utf8'
    );

    const planWithAudit: ExtensionActivationPlan = {
      generation: 2,
      contributions: [
        {
          kind: 'skill',
          contributionId: 'c_audit',
          contributionKey: 'generic-audit',
          name: 'generic-audit',
          enabled: true,
          modelInvocable: true,
          userInvocable: true,
          version: 1,
        },
      ],
      skills: [
        {
          kind: 'skill',
          contributionId: 'c_audit',
          contributionKey: 'generic-audit',
          name: 'generic-audit',
          enabled: true,
          modelInvocable: true,
          userInvocable: true,
          version: 1,
        },
      ],
    };

    // Simulate in-flight busy turn by starting a followup that runs or holds active turns
    // While busy, call updateExtensionPlan
    // We test this deterministically by updating the plan through workspace handle or runtime
    const wsHandle = (runtime as any).sessionWorkspaceHandles?.get?.(sessionId);

    // Update extension plan while session is considered busy or executing
    // When updateExtensionPlan is called on a session with an active turn:
    // It must NOT dispose the handle immediately
    // Let's verify busy deferral:
    // We can simulate an active turn by creating an ActiveTurnInfo in activeTurns
    const rawActiveTurns = runtime.activeTurns as Map<string, any> | undefined;
    expect(rawActiveTurns).toBeDefined();
    if (rawActiveTurns) {
      rawActiveTurns.set(busyTurnId, {
        turnId: busyTurnId,
        sessionId,
        agent: activeHandleBefore.agent,
        pid: process.pid,
        nonce: 'busy-nonce',
        createdAt: new Date().toISOString(),
        cancelRequested: false,
      });
    }

    try {
      // Trigger plan update during simulated busy turn
      await runtime.updateExtensionPlan!('space-alpha', planWithAudit);

      // Busy deferral invariant: the active handle MUST NOT be destroyed mid-turn!
      expect(runtime.agentHandles?.has(sessionId)).toBe(true);
      expect(runtime.agentHandles?.get(sessionId)).toBe(activeHandleBefore);
      // But it MUST be marked dirty
      expect(runtime.isSessionDirty?.(sessionId)).toBe(true);
      expect(runtime.isSessionBusy?.(sessionId)).toBe(true);
    } finally {
      // Busy turn completes at its boundary
      if (rawActiveTurns) {
        rawActiveTurns.delete(busyTurnId);
      }
    }

    // Now safe boundary reached: Turn 2 executes, picks up dirty marker, evicts old handle,
    // rebuilds agent from persisted history with fresh skills, and clears dirty marker
    const turn2Res = await runtime.sendFollowup({
      prompt: 'Execute audit [enkeep-test-tool-call=skill:{"name":"generic-audit"}]',
      sessionId,
      turnId: 'turn_33333333333333333333333333333333',
      workspaceFolder: 'space-alpha',
    });

    expect(turn2Res.status).toBe('completed');
    expect(turn2Res.replyText).toContain('generic-audit');
    expect(runtime.isSessionDirty?.(sessionId)).toBe(false);
    expect(runtime.agentHandles?.has(sessionId)).toBe(true);
    const postRebuildHandle = runtime.agentHandles?.get(sessionId);
    expect(postRebuildHandle).toBeDefined();
    expect(postRebuildHandle).not.toBe(activeHandleBefore);

    // Direct skillsService enumeration proof after boundary rebuild
    const skillsService = runtime.context.get('skills');
    expect(skillsService).toBeDefined();
    const discoveredSkills = await skillsService.list({
      scope: postRebuildHandle!.agent,
      cwd: path.join(spacesDir, 'space-alpha'),
    });
    expect(discoveredSkills.map((s: any) => s.name)).toContain('generic-audit');
  });

  it('maintains strict cross-space isolation: updating space-alpha does not evict or affect space-beta agent', async () => {
    runtime = await bootDshRuntime({
      userId: 'test-user',
      dshHome,
      spacesDir,
    });

    const sessionA = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const sessionB = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    // 1. Establish active sessions in Space A and Space B
    const turnARes1 = await runtime.sendFollowup({
      prompt: 'Query in Space A',
      sessionId: sessionA,
      turnId: 'turn_44444444444444444444444444444441',
      workspaceFolder: 'space-alpha',
    });
    expect(turnARes1.status).toBe('completed');

    const turnBRes1 = await runtime.sendFollowup({
      prompt: 'Query in Space B',
      sessionId: sessionB,
      turnId: 'turn_44444444444444444444444444444442',
      workspaceFolder: 'space-beta',
    });
    expect(turnBRes1.status).toBe('completed');

    // Both handles are live in memory
    expect(runtime.agentHandles?.has(sessionA)).toBe(true);
    expect(runtime.agentHandles?.has(sessionB)).toBe(true);
    const handleBBefore = runtime.agentHandles?.get(sessionB);
    expect(handleBBefore).toBeDefined();

    // 2. Install skill exclusively into Space A
    const skillDirA = path.join(spacesDir, 'space-alpha', '.skills', 'alpha-exclusive-skill');
    fs.mkdirSync(skillDirA, { recursive: true });
    fs.writeFileSync(
      path.join(skillDirA, 'SKILL.md'),
      `---
name: alpha-exclusive-skill
description: Exclusive skill in Space Alpha
---
# Alpha instructions
Alpha output.
`,
      'utf8'
    );

    const planA: ExtensionActivationPlan = {
      generation: 2,
      contributions: [
        {
          kind: 'skill',
          contributionId: 'c_alpha',
          contributionKey: 'alpha-exclusive-skill',
          name: 'alpha-exclusive-skill',
          enabled: true,
          modelInvocable: true,
          userInvocable: true,
          version: 1,
        },
      ],
      skills: [
        {
          kind: 'skill',
          contributionId: 'c_alpha',
          contributionKey: 'alpha-exclusive-skill',
          name: 'alpha-exclusive-skill',
          enabled: true,
          modelInvocable: true,
          userInvocable: true,
          version: 1,
        },
      ],
    };

    // 3. Update extension plan ONLY for space-alpha
    await runtime.updateExtensionPlan!('space-alpha', planA);

    // Cross-space verification: Space B agent MUST be 100% unaffected!
    expect(runtime.isSessionDirty?.(sessionB)).toBe(false);
    expect(runtime.agentHandles?.has(sessionB)).toBe(true);
    expect(runtime.agentHandles?.get(sessionB)).toBe(handleBBefore);

    // Space A agent is quiesced / marked dirty
    expect(runtime.isSessionDirty?.(sessionA)).toBe(true);

    // 4. Space A can now use the new skill on next turn
    const turnARes2 = await runtime.sendFollowup({
      prompt: 'Execute alpha skill [enkeep-test-tool-call=skill:{"name":"alpha-exclusive-skill"}]',
      sessionId: sessionA,
      turnId: 'turn_44444444444444444444444444444443',
      workspaceFolder: 'space-alpha',
    });
    expect(turnARes2.status).toBe('completed');
    expect(turnARes2.replyText).toContain('alpha-exclusive-skill');

    // 5. Space B CANNOT load Space A's exclusive skill
    const turnBRes2 = await runtime.sendFollowup({
      prompt: 'Try to load Space A skill [enkeep-test-tool-call=skill:{"name":"alpha-exclusive-skill"}]',
      sessionId: sessionB,
      turnId: 'turn_44444444444444444444444444444444',
      workspaceFolder: 'space-beta',
    });
    expect(turnBRes2.replyText).toContain('unknown or no longer available');

    // Cross-space catalog enumeration proof via existing exposed context
    const skillsService = runtime.context.get('skills');
    expect(skillsService).toBeDefined();
    const handleA = runtime.agentHandles?.get(sessionA);
    const handleB = runtime.agentHandles?.get(sessionB);
    expect(handleA).toBeDefined();
    expect(handleB).toBeDefined();
    const skillsAlpha = await skillsService.list({
      scope: handleA!.agent,
      cwd: path.join(spacesDir, 'space-alpha'),
    });
    const skillsBeta = await skillsService.list({
      scope: handleB!.agent,
      cwd: path.join(spacesDir, 'space-beta'),
    });
    expect(skillsAlpha.map((s: any) => s.name)).toContain('alpha-exclusive-skill');
    expect(skillsBeta.map((s: any) => s.name)).not.toContain('alpha-exclusive-skill');
  });

  it('preserves dirty marker when rebuild fails, preventing false-clean state', async () => {
    runtime = await bootDshRuntime({
      userId: 'test-user',
      dshHome,
      spacesDir,
    });

    const sessionId = 'ses_dddddddddddddddddddddddddddddddd';

    // 1. Initial turn
    const turn1Res = await runtime.sendFollowup({
      prompt: 'Initial query',
      sessionId,
      turnId: 'turn_55555555555555555555555555555551',
      workspaceFolder: 'space-alpha',
    });
    expect(turn1Res.status).toBe('completed');

    // 2. Mark dirty via plan update
    const plan: ExtensionActivationPlan = {
      generation: 2,
      contributions: [
        {
          kind: 'skill',
          contributionId: 'c_fail',
          contributionKey: 'fail-skill',
          name: 'fail-skill',
          enabled: true,
          modelInvocable: true,
          userInvocable: true,
        },
      ],
      skills: [
        {
          kind: 'skill',
          contributionId: 'c_fail',
          contributionKey: 'fail-skill',
          name: 'fail-skill',
          enabled: true,
          modelInvocable: true,
          userInvocable: true,
        },
      ],
    };
    await runtime.updateExtensionPlan!('space-alpha', plan);
    expect(runtime.isSessionDirty?.(sessionId)).toBe(true);

    // 3. Deliberately corrupt the session persistence file on disk so resume will fail loud
    const findSessionFile = (dir: string): string | undefined => {
      if (!fs.existsSync(dir)) return undefined;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          const found = findSessionFile(full);
          if (found) return found;
        } else if (e.name.endsWith('.jsonl')) {
          return full;
        }
      }
      return undefined;
    };

    const sessionFile = findSessionFile(runtime.sessionsDir) ?? findSessionFile(dshHome);
    expect(sessionFile).toBeDefined();
    if (sessionFile) {
      fs.writeFileSync(sessionFile, '{ CORRUPTED INVALID SYNTAX JSON\n', 'utf8');
    }

    // 4. Turn 2 must fail loud and dirty marker must NOT be cleared
    await expect(
      runtime.sendFollowup({
        prompt: 'Turn 2 with corrupted persistence',
        sessionId,
        turnId: 'turn_55555555555555555555555555555552',
        workspaceFolder: 'space-alpha',
      })
    ).rejects.toThrow();

    // Invariant: Dirty marker is cleared ONLY once rebuild success
    expect(runtime.isSessionDirty?.(sessionId)).toBe(true);
  });
});
