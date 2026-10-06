/**
 * Subagent Model Selection Backfill Test Suite
 *
 * Verifies:
 * 1. An existing (non-fresh) top-level session without projection gets it recorded once
 *    on load and the subagent tool schema exposes provider/model.
 * 2. A session with an existing projection is unchanged.
 * 3. A subagent child session is not touched.
 *
 * @module @enkeep/runtime-runner/tests/subagent-model-backfill.test
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
import {
  subagentModelSelectionPolicy,
  recordSubagentModelSelection,
  backfillSubagentModelSelection,
} from '../src/runtime/official-plugins.js';

describe('Subagent Model Selection Backfill for Existing Sessions', () => {
  let tmpDir: string;
  let dshHome: string;
  let spacesDir: string;
  let spacePath: string;
  let runtime: DshBootedRuntime | undefined;
  const trackedHandles: AgentHandle[] = [];

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-subagent-backfill-test-'));
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
      runtime = undefined;
    }

    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('1. an existing (non-fresh) top-level session without projection gets it recorded once on load and the subagent tool schema exposes provider/model', async () => {
    const sessionId = 'ses_00000000000000000000000000000001';

    // Step 1: Boot runtime with subagents model selection disabled to create an existing session without projection
    const runtime1 = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
      subagents: {
        modelSelectionSettings: false,
      },
    });

    const agent1 = await runtime1.getOrCreateAgent(sessionId, null, 'space-synthetic-01');
    // Run one turn so the session has real persisted history (non-fresh: firstLiveSeq > 0)
    const turnResult = await runtime1.sendFollowup(
      'Synthetic setup prompt',
      sessionId,
      'turn_00000000000000000000000000000001',
      null,
    );
    expect(turnResult.status).toBe('completed');
    expect(agent1.session.seq).toBeGreaterThan(0);

    // Verify session initially has NO subagent model selection policy recorded
    const events1 = agent1.session.snapshotEvents();
    expect(events1.some((e: any) => e.type === 'subagent/model-selection-policy')).toBe(false);

    // Tool schema in runtime1 does NOT expose provider/model because modelSelectionSettings was false
    const toolsRegistry1 = agent1.ctx.get('tools')!;
    const schema1 = toolsRegistry1.schemas(agent1).find((s) => s.name === 'subagent');
    expect((schema1?.parameters as any)?.properties?.provider).toBeUndefined();

    await runtime1.dispose();

    // Step 2: Boot runtime2 with subagents model selection enabled (default) and resume the existing session
    const runtime2 = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
    });
    runtime = runtime2;

    const resumedAgent = await runtime2.getOrCreateAgent(sessionId, null, 'space-synthetic-01');
    expect(resumedAgent.session.firstLiveSeq).toBeGreaterThan(0);

    // Verify projection was recorded ONCE on load
    const events2 = resumedAgent.session.snapshotEvents();
    const policyEvents = events2.filter((e: any) => e.type === 'subagent/model-selection-policy');
    expect(policyEvents).toHaveLength(1);
    expect(policyEvents[0].data.allowedModels.length).toBeGreaterThan(0);

    // Verify subagent tool schema now exposes provider/model/reasoning_effort
    const toolsRegistry2 = resumedAgent.ctx.get('tools')!;
    const subagentSchema2 = toolsRegistry2.schemas(resumedAgent).find((s) => s.name === 'subagent');
    expect(subagentSchema2).toBeDefined();
    const props = (subagentSchema2?.parameters as any)?.properties;
    expect(props.provider).toBeDefined();
    expect(props.model).toBeDefined();
    expect(props.reasoning_effort).toBeDefined();

    // Verify companion tool list_subagent_models is present
    expect(toolsRegistry2.get('list_subagent_models', resumedAgent)).toBeDefined();
  });

  it('2. a session with an existing projection is unchanged', async () => {
    const sessionId = 'ses_00000000000000000000000000000002';

    // Boot runtime1 with custom routes and demo LLM adapter
    const initialProviders = {
      'cpa-synthetic-fixed': {
        models: [{ id: 'synth-fixed-model' }],
      },
    };

    const runtime1 = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
      providers: initialProviders,
      provider: 'cpa-synthetic-fixed',
      model: 'synth-fixed-model',
      llmEnabled: false,
    });

    const agent1 = await runtime1.getOrCreateAgent(sessionId, null, 'space-synthetic-01');
    // Session is fresh initially and records initialProviders projection
    await runtime1.sendFollowup(
      'Synthetic turn 1',
      sessionId,
      'turn_00000000000000000000000000000002',
      null,
    );

    const initialPolicyEvents = agent1.session.snapshotEvents().filter((e: any) => e.type === 'subagent/model-selection-policy');
    expect(initialPolicyEvents).toHaveLength(1);
    expect(initialPolicyEvents[0].data.allowedModels).toEqual([
      { provider: 'cpa-synthetic-fixed', model: 'synth-fixed-model' },
    ]);

    await runtime1.dispose();

    // Boot runtime2 with DIFFERENT providers and demo LLM adapter
    const runtime2 = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
      providers: {
        'cpa-synthetic-new': {
          models: [{ id: 'synth-new-model' }],
        },
      },
      provider: 'cpa-synthetic-new',
      model: 'synth-new-model',
      llmEnabled: false,
    });
    runtime = runtime2;

    const resumedAgent = await runtime2.getOrCreateAgent(sessionId, null, 'space-synthetic-01');

    // Existing projection MUST be unchanged: still exactly 1 event and retaining the original route
    const currentEvents = resumedAgent.session.snapshotEvents();
    const currentPolicyEvents = currentEvents.filter((e: any) => e.type === 'subagent/model-selection-policy');
    expect(currentPolicyEvents).toHaveLength(1);
    expect(currentPolicyEvents[0].data.allowedModels).toEqual([
      { provider: 'cpa-synthetic-fixed', model: 'synth-fixed-model' },
    ]);
  });

  it('3. a subagent child session is not touched', async () => {
    const parentSessionId = 'ses_00000000000000000000000000000003';

    runtime = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
    });

    const parentAgent = await runtime.getOrCreateAgent(parentSessionId, null, 'space-synthetic-01');
    const subagentsService = parentAgent.ctx.get('subagents')!;
    expect(subagentsService).toBeDefined();

    // Spawn a child agent
    const spawnRun = await subagentsService.start('spawn', {
      label: 'synthetic-child-task',
      prompt: [{ type: 'text', text: 'Synthesize report' }],
      parent: parentAgent,
      signal: new AbortController().signal,
    });
    const result = await spawnRun.result;
    expect(result.stopReason).toBe('completed');

    // Find the spawned child session from sessions registry
    const sessionsRegistry = runtime.context.get('sessions')!;
    const allSessions = sessionsRegistry.list();
    const childSession = allSessions.find((s) => s.header.origin === 'subagent' && s.header.parentSession === parentSessionId);
    expect(childSession).toBeDefined();
    expect(childSession!.header.origin).toBe('subagent');

    const countBefore = childSession!.snapshotEvents().filter((e: any) => e.type === 'subagent/model-selection-policy').length;

    // Invoke backfill directly on child session - must not touch it
    backfillSubagentModelSelection(runtime.context, childSession);

    const countAfter = childSession!.snapshotEvents().filter((e: any) => e.type === 'subagent/model-selection-policy').length;
    expect(countAfter).toBe(countBefore);
  });
});
