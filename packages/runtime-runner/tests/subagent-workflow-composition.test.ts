/**
 * Subagent Model Selection & Workflow Tool Composition Test Suite
 *
 * Verifies:
 * 1. Subagent tool schema exposes provider/model/reasoning_effort params and allowed list derived from config.
 * 2. Companion discovery tool list_subagent_models is registered.
 * 3. Workflow tool is registered on the workspace agent.
 * 4. Synthetic workflow script running one child agent via the demo LLM provider succeeds end-to-end.
 *
 * @module @enkeep/runtime-runner/tests/subagent-workflow-composition.test
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
  DEFAULT_ENKEEP_PROVIDERS,
  extractAllowedModelRoutes,
} from '../src/runtime/official-plugins.js';

describe('Subagent Model Selection & Workflow Tool Composition', () => {
  let tmpDir: string;
  let dshHome: string;
  let spacesDir: string;
  let spacePath: string;
  let runtime: DshBootedRuntime;
  const trackedHandles: AgentHandle[] = [];

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-subagent-wf-test-'));
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

  it('1. Host subagentModelSelection service is mounted with allowedModels extracted from config', async () => {
    const customProviders = {
      'cpa-synthetic-alpha': {
        models: [
          { id: 'synth-model-fast' },
          { id: 'synth-model-pro' },
        ],
      },
      'cpa-synthetic-beta': {
        models: [
          { id: 'synth-beta-preview' },
        ],
      },
    };

    runtime = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
      providers: customProviders,
    });

    const settingsService = runtime.context.get('subagentModelSelection');
    expect(settingsService).toBeDefined();

    const current = settingsService.current();
    expect(current.enabled).toBe(true);
    expect(current.allowedModels).toEqual(
      expect.arrayContaining([
        { provider: 'cpa-synthetic-alpha', model: 'synth-model-fast' },
        { provider: 'cpa-synthetic-alpha', model: 'synth-model-pro' },
        { provider: 'cpa-synthetic-beta', model: 'synth-beta-preview' },
      ])
    );
  });

  it('2. Subagent tool schema exposes provider/model/reasoning_effort params and list_subagent_models tool is registered', async () => {
    const customProviders = {
      'cpa-synthetic-provider': {
        models: [
          { id: 'synth-model-01' },
          { id: 'synth-model-02' },
        ],
      },
    };

    runtime = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
      providers: customProviders,
    });

    const sessionId = 'ses_00000000000000000000000000000001';
    const agent = await runtime.getOrCreateAgent(sessionId, null, 'space-synthetic-01');

    const toolsRegistry = agent.ctx.get('tools');
    expect(toolsRegistry).toBeDefined();

    // Verify subagent tool registration
    const subagentTool = toolsRegistry.get('subagent', agent);
    expect(subagentTool).toBeDefined();

    // Verify tool schema exposes provider, model, reasoning_effort
    const schemas = toolsRegistry.schemas(agent);
    const subagentSchema = schemas.find((s) => s.name === 'subagent');
    expect(subagentSchema).toBeDefined();

    const properties = (subagentSchema?.parameters as any)?.properties;
    expect(properties).toBeDefined();
    expect(properties.provider).toBeDefined();
    expect(properties.model).toBeDefined();
    expect(properties.reasoning_effort).toBeDefined();

    // Verify companion list_subagent_models tool is registered
    const listModelsTool = toolsRegistry.get('list_subagent_models', agent);
    expect(listModelsTool).toBeDefined();

    const listModelsSchema = schemas.find((s) => s.name === 'list_subagent_models');
    expect(listModelsSchema).toBeDefined();

    // Verify subagentModelSelection has the allowed routes derived from config
    const currentSettings = runtime.context.subagentModelSelection.current();
    expect(currentSettings.enabled).toBe(true);
    expect(currentSettings.allowedModels).toEqual(
      expect.arrayContaining([
        { provider: 'cpa-synthetic-provider', model: 'synth-model-01' },
        { provider: 'cpa-synthetic-provider', model: 'synth-model-02' },
      ])
    );

    // Execute list_subagent_models tool and verify it executes without error
    const callResult = await listModelsTool.execute({}, { agent, signal: new AbortController().signal } as any);
    expect(typeof callResult).toBe('string');
  });

  it('3. Subagent_fork tool does not enable modelSelectionSettings', async () => {
    runtime = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
    });

    const sessionId = 'ses_00000000000000000000000000000002';
    const agent = await runtime.getOrCreateAgent(sessionId, null, 'space-synthetic-01');

    const toolsRegistry = agent.ctx.get('tools');
    const schemas = toolsRegistry.schemas(agent);

    const forkSchema = schemas.find((s) => s.name === 'subagent_fork');
    expect(forkSchema).toBeDefined();

    // subagent_fork must not have model selection properties
    const forkProps = (forkSchema?.parameters as any)?.properties;
    expect(forkProps.provider).toBeUndefined();
    expect(forkProps.model).toBeUndefined();
  });

  it('4. Workflow tool is registered and capabilities status reports it active', async () => {
    runtime = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
    });

    const sessionId = 'ses_00000000000000000000000000000003';
    const agent = await runtime.getOrCreateAgent(sessionId, null, 'space-synthetic-01');

    const toolsRegistry = agent.ctx.get('tools');
    expect(toolsRegistry).toBeDefined();

    const workflowTool = toolsRegistry.get('workflow', agent);
    expect(workflowTool).toBeDefined();

    const schemas = toolsRegistry.schemas(agent);
    const workflowSchema = schemas.find((s) => s.name === 'workflow');
    expect(workflowSchema).toBeDefined();
    expect((workflowSchema?.parameters as any)?.properties?.script).toBeDefined();
    expect((workflowSchema?.parameters as any)?.properties?.meta).toBeDefined();

    // Verify workflowEngine is present on workspace agent context
    const engine = agent.ctx.get('workflowEngine');
    expect(engine).toBeDefined();

    // Verify ptcRuntime is present on workspace agent context
    const ptcRuntime = agent.ctx.get('ptcRuntime');
    expect(ptcRuntime).toBeDefined();

    // Verify capabilities
    const capabilities = await runtime.getCapabilities!();
    expect(capabilities.workflow).toBe(true);
    expect(capabilities.subagentModelSelection).toBe(true);
  });

  it('5. Synthetic workflow script runs one child agent via fake provider and succeeds end-to-end', async () => {
    runtime = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
    });

    const sessionId = 'ses_00000000000000000000000000000004';
    const parentAgent = await runtime.getOrCreateAgent(sessionId, null, 'space-synthetic-01');

    const engine = parentAgent.ctx.get('workflowEngine');
    expect(engine).toBeDefined();

    const meta = {
      name: 'synthetic-single-agent-wf',
      description: 'Run one synthetic child agent and aggregate outcome',
    };
    const script = `
      const childResult = await agent("Synthesize test response");
      return { ok: true, childResult };
    `;

    const run = engine.start({
      script,
      meta,
      parent: parentAgent,
    });

    const outcome = await run.result;
    expect(outcome.stopReason).toBe('completed');
    expect(outcome.agentsStarted).toBe(1);
    expect(outcome.value).toBeDefined();
    expect((outcome.value as any).ok).toBe(true);
    expect((outcome.value as any).childResult).toBeDefined();
  });

  it('6. Workflow tool execute directly invokes workflow and returns foreground result', async () => {
    runtime = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
    });

    const sessionId = 'ses_00000000000000000000000000000005';
    const parentAgent = await runtime.getOrCreateAgent(sessionId, null, 'space-synthetic-01');

    const toolsRegistry = parentAgent.ctx.get('tools');
    const workflowTool = toolsRegistry.get('workflow', parentAgent);
    expect(workflowTool).toBeDefined();

    const meta = {
      name: 'synthetic-tool-exec-wf',
      description: 'Execute synthetic workflow tool',
    };
    const script = `
      return { computation: 42 * 2 };
    `;

    const execResult = await workflowTool.execute(
      { meta, script },
      { agent: parentAgent, signal: new AbortController().signal } as any
    );

    expect(execResult).toBeDefined();
    expect(execResult.kind).toBe('foreground');
    expect(execResult.result).toEqual({ computation: 84 });
  });

  it('7. Subagent with explicit provider and model uses selected model, not parent model', async () => {
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

    runtime = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
      providers: customProviders,
      provider: 'cpa-synthetic-parent',
      model: 'synth-parent-model',
      llmEnabled: false,
    });

    const parentSessionId = 'ses_00000000000000000000000000000007';
    const parentAgent = await runtime.getOrCreateAgent(parentSessionId, null, 'space-synthetic-01');

    const toolsRegistry = parentAgent.ctx.get('tools');
    const subagentTool = toolsRegistry.get('subagent', parentAgent);
    expect(subagentTool).toBeDefined();

    const subagentResult = await subagentTool.execute(
      {
        description: 'Synthetic child delegation',
        prompt: 'Reply with TEST_PONG',
        provider: 'cpa-synthetic-child',
        model: 'synth-child-model',
        run_in_background: false,
      },
      { agent: parentAgent, signal: new AbortController().signal } as any
    );

    expect(subagentResult).toBeDefined();
    expect(subagentResult.kind).toBe('foreground');

    // Verify child session persistence records used cpa-synthetic-child / synth-child-model
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

    // Filter for the child session file (not parentSessionId)
    const childSessionFile = sessionFiles.find((f) => !f.includes(parentSessionId));
    expect(childSessionFile).toBeDefined();

    const lines = fs.readFileSync(childSessionFile!, 'utf8').trim().split('\n');
    const events = lines.map((l) => JSON.parse(l));

    const requestContext = events.find((e) => e.type === 'request/context');
    expect(requestContext).toBeDefined();
    expect(requestContext.data.provider).toBe('cpa-synthetic-child');
    expect(requestContext.data.model).toBe('synth-child-model');

    const requestHeader = events.find((e) => e.type === 'request/header');
    expect(requestHeader).toBeDefined();
    expect(requestHeader.data.header.config.provider).toBe('cpa-synthetic-child');
    expect(requestHeader.data.header.config.model).toBe('synth-child-model');
  });
});
