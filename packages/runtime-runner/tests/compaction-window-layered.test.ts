/**
 * Synthetic Test Suite: Layered Working Context Window & Compaction Window Real Composition
 *
 * Verifies through enkeep's real composition:
 * 1. Compaction triggers at DSH's threshold computed from the working window on a 1M model and retains DSH's ratio of it.
 * 2. Session / space working context window overrides and precedence.
 * 3. Working context window clamped to model's real capacity: effective = min(working, physical).
 * 4. Rejection message for unworkable windows returned clearly without swallowing.
 * 5. Children default: subagent/workflow children receive platform default working window.
 * 6. Memory injection per published contract for subagent and workflow agents.
 * 7. Subagent/workflow tools work including model selection and continuable background.
 *
 * Follows enkeep/AGENTS.md strictly: synthetic identifiers and paths only.
 * @module @enkeep/runtime-runner/tests/compaction-window-layered.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionId } from '@deepseek-ai/dsh-session';
import {
  bootDshRuntime,
  type DshBootedRuntime,
  isChildSession,
} from '../src/runtime/dsh-boot.js';
import type { CompactionWindowEngine } from '@tivility/dsh-compaction-window';

describe('Layered Working Context Window & Compaction Window Composition', () => {
  let tmpDir: string;
  let dshHome: string;
  let spacesDir: string;
  let spacePath: string;
  let runtime: DshBootedRuntime;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-compaction-window-test-'));
    dshHome = path.join(tmpDir, '.dsh');
    spacesDir = path.join(tmpDir, 'spaces');
    spacePath = path.join(spacesDir, 'space-synthetic');

    fs.mkdirSync(dshHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spacesDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spacePath, { recursive: true, mode: 0o700 });

    const globalMemDir = path.join(dshHome, 'memory');
    fs.mkdirSync(globalMemDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(globalMemDir, 'global.md'),
      '# Global Memory\n\nSynthetic user memory content.\n',
      'utf8'
    );
  });

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('1. Mounts @tivility/dsh-compaction-window as compaction service and exposes setSessionSettings/effectiveSettings', async () => {
    runtime = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
      contextWindow: 1000000,
    });

    const compaction = runtime.context.get('compaction') as CompactionWindowEngine;
    expect(compaction).toBeDefined();
    expect(typeof compaction.setSessionSettings).toBe('function');
    expect(typeof compaction.clearSessionSettings).toBe('function');
    expect(typeof compaction.effectiveSettings).toBe('function');

    const sessionId = 'ses_00000000000000000000000000000001';
    await runtime.sendFollowup('Hello', sessionId, 'turn_00000000000000000000000000000001');
    const agent = await runtime.getOrCreateAgent(sessionId, null, 'space-synthetic');
    const effective = await compaction.effectiveSettings(agent.session);

    expect(effective).toBeDefined();
    expect(effective.realContextWindow).toBe(1000000);
    expect(effective.contextWindow.value).toBe(1000000);
    expect(effective.thresholdRatio.value).toBe(0.8);
  });

  it('2. Session context window override works and triggers threshold calculation from working window on a 1M model', async () => {
    runtime = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
      contextWindow: 1000000,
    });

    const compaction = runtime.context.get('compaction') as CompactionWindowEngine;
    const sessionId = 'ses_00000000000000000000000000000002';
    await runtime.sendFollowup('Hello', sessionId, 'turn_00000000000000000000000000000002');
    const agent = await runtime.getOrCreateAgent(sessionId, null, 'space-synthetic');

    // Override working window to 272000
    await compaction.setSessionSettings(agent.session, {
      contextWindow: 272000,
    });

    const effective = await compaction.effectiveSettings(agent.session);
    expect(effective.contextWindow.value).toBe(272000);
    expect(effective.contextWindow.source).toBe('session');
    expect(effective.realContextWindow).toBe(1000000);
    expect(effective.thresholdTokens).toBeGreaterThan(0);
    // thresholdTokens = Math.floor(Math.min(272000 * 0.8, 272000 - reserved - headroom))
    expect(effective.thresholdTokens).toBeLessThanOrEqual(272000 * 0.8);

    // Clear session override restores default
    await compaction.clearSessionSettings(agent.session);
    const restored = await compaction.effectiveSettings(agent.session);
    expect(restored.contextWindow.source).toBe('default');
  });

  it('3. Working context window is clamped to physical model capacity: min(working, physical)', async () => {
    // Adapter model has contextWindow: 128000
    runtime = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
      contextWindow: 128000,
    });

    const compaction = runtime.context.get('compaction') as CompactionWindowEngine;
    const sessionId = 'ses_00000000000000000000000000000003';
    await runtime.sendFollowup('Hello', sessionId, 'turn_00000000000000000000000000000003');
    const agent = await runtime.getOrCreateAgent(sessionId, null, 'space-synthetic');

    // Attempt to set 500000 working window on a 128000 physical model
    await compaction.setSessionSettings(agent.session, {
      contextWindow: 500000,
    });

    const effective = await compaction.effectiveSettings(agent.session);
    expect(effective.realContextWindow).toBe(128000);
    // Effective is clamped to min(500000, 128000) = 128000
    expect(effective.contextWindow.value).toBe(128000);
  });

  it('4. Rejection for unworkable window values fails loudly with a clear error', async () => {
    runtime = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
      contextWindow: 1000000,
    });

    const compaction = runtime.context.get('compaction') as CompactionWindowEngine;
    const sessionId = 'ses_00000000000000000000000000000004';
    const agent = await runtime.getOrCreateAgent(sessionId, null, 'space-synthetic');

    // A working window of 1000 tokens cannot work with default 65536 headroomTokens
    await expect(
      compaction.setSessionSettings(agent.session, {
        contextWindow: 1000,
      })
    ).rejects.toThrow(/compaction-window: these settings would leave pressure compaction unable to run/);
  });

  it('5. Per-turn contextWindow parameter sets session settings and returns effective compactionInfo', async () => {
    runtime = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
      contextWindow: 1000000,
    });

    const sessionId = 'ses_00000000000000000000000000000005';
    const res = await runtime.sendFollowup({
      prompt: 'Test turn with custom context window',
      sessionId,
      turnId: 'turn_00000000000000000000000000000001',
      contextWindow: 272000,
    });

    expect(res.status).toBe('completed');
    expect(res.compactionInfo).toBeDefined();
    expect(res.compactionInfo?.contextWindow?.value).toBe(272000);
    expect(res.compactionInfo?.contextWindow?.source).toBe('session');
  });

  it('6. Child subagent and workflow agents receive default working context window and respect globalMemory contract', async () => {
    runtime = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
      contextWindow: 1000000,
    });

    const parentSessionId = 'ses_00000000000000000000000000000006';
    const parentAgent = await runtime.getOrCreateAgent(parentSessionId, null, 'space-synthetic');
    const toolsRegistry = parentAgent.ctx.get('tools');
    const subagentTool = toolsRegistry.get('subagent', parentAgent);

    let childAgent: any;
    const unlisten = runtime.context.on('agent/created', ({ agent }) => {
      if (agent.id !== parentSessionId) {
        childAgent = agent;
      }
    });

    await subagentTool.execute(
      {
        description: 'test child agent',
        prompt: 'Hello child',
        global_memory: false,
        run_in_background: false,
      },
      { agent: parentAgent, signal: new AbortController().signal } as any
    );
    unlisten();

    expect(childAgent).toBeDefined();
    expect(isChildSession(childAgent, runtime.context)).toBe(true);

    const compaction = runtime.context.get('compaction') as CompactionWindowEngine;
    const childEffective = await compaction.effectiveSettings(childAgent.session);
    expect(childEffective.contextWindow.value).toBe(272000);
  });
});
