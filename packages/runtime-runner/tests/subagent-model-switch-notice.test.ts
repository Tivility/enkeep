/**
 * Subagent Model Switch Notice Isolation Test Suite
 *
 * Verifies that:
 * 1. Child agent executing on a distinct model from its parent over 5 steps receives 0 model-switch notices.
 * 2. Top-level session experiencing a genuine model switch produces exactly 1 model-switch notice.
 *
 * @module @enkeep/runtime-runner/tests/subagent-model-switch-notice.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AgentHandle } from '@deepseek-ai/dsh-agent';
import {
  bootDshRuntime,
  type DshBootedRuntime,
} from '../src/runtime/dsh-boot.js';

describe('Subagent Model Switch Notice Filtering', () => {
  let tmpDir: string;
  let dshHome: string;
  let spacesDir: string;
  let spacePath: string;
  let runtime: DshBootedRuntime;
  const trackedHandles: AgentHandle[] = [];

  const customProviders = {
    'cpa-synthetic-parent': {
      models: [
        { id: 'synth-parent-model' },
      ],
    },
    'cpa-synthetic-child': {
      models: [
        { id: 'synth-child-model' },
      ],
    },
  };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-model-switch-test-'));
    dshHome = path.join(tmpDir, '.dsh');
    spacesDir = path.join(tmpDir, 'spaces');
    spacePath = path.join(spacesDir, 'space-synthetic-01');

    fs.mkdirSync(dshHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spacesDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spacePath, { recursive: true, mode: 0o700 });
  });

  afterEach(async () => {
    for (const handle of trackedHandles) {
      try {
        await handle.dispose();
      } catch {}
    }
    trackedHandles.length = 0;

    if (runtime) {
      await runtime.dispose();
    }

    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('child on a different model than parent over 5 steps produces 0 model-selection notices', async () => {
    runtime = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
      providers: customProviders,
      provider: 'cpa-synthetic-parent',
      model: 'synth-parent-model',
      llmEnabled: false,
    });

    const parentSessionId = 'ses_00000000000000000000000000000001';
    const parentAgent = await runtime.getOrCreateAgent(parentSessionId, null, 'space-synthetic-01');

    const toolsRegistry = parentAgent.ctx.get('tools');
    const subagentTool = toolsRegistry.get('subagent', parentAgent);
    expect(subagentTool).toBeDefined();

    // 4 tool calls + final assistant turn = 5 steps in the child session
    const promptWith5Steps =
      '[enkeep-test-tool-call=check_quota:{"resource":"all"}]' +
      '[enkeep-test-tool-call=check_quota:{"resource":"all"}]' +
      '[enkeep-test-tool-call=check_quota:{"resource":"all"}]' +
      '[enkeep-test-tool-call=check_quota:{"resource":"all"}]' +
      'Complete task with 5 steps';

    const subagentResult = await subagentTool.execute(
      {
        description: 'Synthetic 5-step child execution',
        prompt: promptWith5Steps,
        provider: 'cpa-synthetic-child',
        model: 'synth-child-model',
        run_in_background: false,
      },
      { agent: parentAgent, signal: new AbortController().signal } as any
    );

    expect(subagentResult).toBeDefined();
    expect(subagentResult.kind).toBe('foreground');

    // Locate child session persistence file
    const sessionsDir = path.join(dshHome, 'sessions');
    const sessionFiles: string[] = [];
    if (fs.existsSync(sessionsDir)) {
      const entries = fs.readdirSync(sessionsDir, { recursive: true });
      for (const e of entries) {
        const full = path.join(sessionsDir, String(e));
        if (fs.statSync(full).isFile() && (full.endsWith('.jsonl') || full.endsWith('.v4.jsonl'))) {
          sessionFiles.push(full);
        }
      }
    }

    const childSessionFile = sessionFiles.find((f) => !f.includes(parentSessionId));
    expect(childSessionFile).toBeDefined();

    const lines = fs.readFileSync(childSessionFile!, 'utf8').trim().split('\n');
    const events = lines.map((l) => JSON.parse(l));

    // Verify child agent executed across 5 steps
    const stepStartEvents = events.filter((e) => e.type === 'step/start');
    expect(stepStartEvents.length).toBe(5);

    // Verify child executed with explicit child model
    const initialHeader = events.find((e) => e.type === 'request/header');
    expect(initialHeader).toBeDefined();
    expect(initialHeader.data.header.config.provider).toBe('cpa-synthetic-child');
    expect(initialHeader.data.header.config.model).toBe('synth-child-model');

    // Verify that NO model-selection notices were injected into the child session
    const modelSelectionNotices = events.filter(
      (e) => e.type === 'user/message' && e.data?.source?.kind === 'model-selection'
    );
    expect(modelSelectionNotices.length).toBe(0);
  });

  it('genuine model change of top-level session yields exactly one notice', async () => {
    runtime = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
      providers: customProviders,
      provider: 'cpa-synthetic-parent',
      model: 'synth-parent-model',
      llmEnabled: false,
    });

    const topSessionId = 'ses_00000000000000000000000000000002';

    // Turn 1: Executes with default parent model (synth-parent-model)
    const turn1Res = await runtime.sendFollowup({
      prompt: 'Turn 1 initial prompt',
      sessionId: topSessionId,
      turnId: 'turn_00000000000000000000000000000001',
      profile: null,
    });
    expect(turn1Res.status).toBe('completed');
    expect(turn1Res.modelInfo?.provider).toBe('cpa-synthetic-parent');
    expect(turn1Res.modelInfo?.model).toBe('synth-parent-model');

    // Turn 2: Genuine model change to synth-child-model via modelSelection
    const turn2Res = await runtime.sendFollowup({
      prompt: 'Turn 2 after model switch',
      sessionId: topSessionId,
      turnId: 'turn_00000000000000000000000000000002',
      profile: null,
      modelSelection: {
        provider: 'cpa-synthetic-child',
        model: 'synth-child-model',
        source: 'session',
      },
    });
    expect(turn2Res.status).toBe('completed');
    expect(turn2Res.modelInfo?.provider).toBe('cpa-synthetic-child');
    expect(turn2Res.modelInfo?.model).toBe('synth-child-model');

    // Turn 3: Continues with synth-child-model (no new switch)
    const turn3Res = await runtime.sendFollowup({
      prompt: 'Turn 3 continuation with same model',
      sessionId: topSessionId,
      turnId: 'turn_00000000000000000000000000000003',
      profile: null,
    });
    expect(turn3Res.status).toBe('completed');

    // Locate top-level session persistence file
    const sessionsDir = path.join(dshHome, 'sessions');
    const sessionFiles: string[] = [];
    if (fs.existsSync(sessionsDir)) {
      const entries = fs.readdirSync(sessionsDir, { recursive: true });
      for (const e of entries) {
        const full = path.join(sessionsDir, String(e));
        if (fs.statSync(full).isFile() && (full.endsWith('.jsonl') || full.endsWith('.v4.jsonl'))) {
          sessionFiles.push(full);
        }
      }
    }

    const topSessionFile = sessionFiles.find((f) => f.includes(topSessionId));
    expect(topSessionFile).toBeDefined();

    const lines = fs.readFileSync(topSessionFile!, 'utf8').trim().split('\n');
    const events = lines.map((l) => JSON.parse(l));

    // Verify exactly 1 model-selection notice was emitted across the entire session
    const modelSelectionNotices = events.filter(
      (e) => e.type === 'user/message' && e.data?.source?.kind === 'model-selection'
    );
    expect(modelSelectionNotices.length).toBe(1);

    const noticeText = modelSelectionNotices[0].data?.content?.[0]?.text;
    expect(noticeText).toContain('[model changed:');
    expect(noticeText).toContain('synth-parent-model');
    expect(noticeText).toContain('synth-child-model');
  });
});
