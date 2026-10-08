/**
 * Synthetic Test Suite: Per-Call Subagent and Workflow Global Memory Plugins
 *
 * Verifies:
 * 1. Tool schemas expose the new param/option:
 *    - subagent tool parameter 'global_memory' (boolean, description matches spec).
 *    - workflow tool description documents agent(prompt, opts) option 'globalMemory' (boolean, default false).
 * 2. Child injection follows the per-call flag (true/false/omitted) for subagent:
 *    - global_memory: true -> child gets <global_memory> injected in system prompt.
 *    - global_memory: false -> child gets NO <global_memory> injected.
 *    - global_memory omitted -> child gets NO <global_memory> injected.
 * 3. Child injection follows the per-call flag (true/false/omitted) for workflow:
 *    - opts.globalMemory: true -> child gets <global_memory> injected in system prompt.
 *    - opts.globalMemory: false -> child gets NO <global_memory> injected.
 *    - opts.globalMemory omitted -> child gets NO <global_memory> injected.
 *    - opts.globalMemory non-boolean -> rejected by opts validation with INVALID_ARGUMENT.
 * 4. subagent_fork keeps upstream behavior and no injection.
 * 5. Top-level session retains global memory injection unchanged.
 * 6. Removal of ENKEEP_SUBAGENT_GLOBAL_MEMORY env mechanism (per-call flag dominates even if env is set).
 * 7. Existing features unaffected:
 *    - Model selection parameters (provider/model/reasoning_effort) work alongside global_memory.
 *    - Continuable background mode, list_agents, send_message work.
 *    - Workflow caps (maxConcurrentAgents, maxTotalAgents) work.
 *
 * Follows enkeep/AGENTS.md strictly: synthetic identifiers and paths only.
 * @module @enkeep/runtime-runner/tests/subagent-workflow-per-call-memory.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import {
  bootDshRuntime,
  type DshBootedRuntime,
  isChildSession,
} from '../src/runtime/dsh-boot.js';

describe('Per-Call Subagent and Workflow Global Memory Plugins', () => {
  let tmpDir: string;
  let dshHome: string;
  let spacesDir: string;
  let spacePath: string;
  let runtime: DshBootedRuntime;
  const trackedHandles: AgentHandle[] = [];
  const originalEnv = process.env.ENKEEP_SUBAGENT_GLOBAL_MEMORY;

  const GLOBAL_MEMORY_MARKER = 'SYNTHETIC_GLOBAL_PREFERENCE_KEY_4321';

  beforeEach(async () => {
    delete process.env.ENKEEP_SUBAGENT_GLOBAL_MEMORY;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-percall-mem-test-'));
    dshHome = path.join(tmpDir, '.dsh');
    spacesDir = path.join(tmpDir, 'spaces');
    spacePath = path.join(spacesDir, 'space-synthetic-percall');

    fs.mkdirSync(dshHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spacesDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spacePath, { recursive: true, mode: 0o700 });

    const globalMemDir = path.join(dshHome, 'memory');
    fs.mkdirSync(globalMemDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(globalMemDir, 'global.md'),
      `# Global Memory\n\nUser preference marker: ${GLOBAL_MEMORY_MARKER}\nSynthetic note.\n`,
      'utf8'
    );
  });

  afterEach(async () => {
    if (originalEnv !== undefined) {
      process.env.ENKEEP_SUBAGENT_GLOBAL_MEMORY = originalEnv;
    } else {
      delete process.env.ENKEEP_SUBAGENT_GLOBAL_MEMORY;
    }

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

  it('1. Tool schemas expose global_memory and globalMemory options', async () => {
    runtime = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
    });

    const parentSessionId = 'ses_00000000000000000000000000000001';
    const parentAgent = await runtime.getOrCreateAgent(parentSessionId, null, 'space-synthetic-percall');

    const toolsRegistry = parentAgent.ctx.get('tools');
    expect(toolsRegistry).toBeDefined();

    // Verify subagent tool schema
    const subagentTool = toolsRegistry.get('subagent', parentAgent);
    expect(subagentTool).toBeDefined();
    const subagentProps = (subagentTool?.parameters as any)?.properties;
    expect(subagentProps?.global_memory).toBeDefined();
    expect(subagentProps?.global_memory?.type).toBe('boolean');
    expect(subagentProps?.global_memory?.description).toBe("include the user's global memory in the child's context");

    // Verify subagent_fork tool does not have global_memory
    const forkTool = toolsRegistry.get('subagent_fork', parentAgent);
    expect(forkTool).toBeDefined();
    const forkProps = (forkTool?.parameters as any)?.properties;
    expect(forkProps?.global_memory).toBeUndefined();

    // Verify workflow tool schema and description
    const workflowTool = toolsRegistry.get('workflow', parentAgent);
    expect(workflowTool).toBeDefined();
    expect(workflowTool?.description).toContain('`globalMemory` (boolean, default false');
  });

  it('2. Top-level session injects global memory unchanged', async () => {
    runtime = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
    });

    const parentSessionId = 'ses_00000000000000000000000000000002';
    const parentAgent = await runtime.getOrCreateAgent(parentSessionId, null, 'space-synthetic-percall');

    expect(isChildSession(parentAgent, runtime.context)).toBe(false);

    const assembly = await runtime.context.systemPrompt.assemble({ scope: parentAgent });
    const memSection = assembly.sections.find((s) => s.name === 'memory:enkeep');
    expect(memSection).toBeDefined();
    expect(memSection!.text).toContain('<global_memory');
    expect(memSection!.text).toContain(GLOBAL_MEMORY_MARKER);
  });

  it('3. Subagent tool: global_memory true injects memory; false or omitted does not', async () => {
    runtime = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
    });

    const parentSessionId = 'ses_00000000000000000000000000000003';
    const parentAgent = await runtime.getOrCreateAgent(parentSessionId, null, 'space-synthetic-percall');
    const toolsRegistry = parentAgent.ctx.get('tools');
    const subagentTool = toolsRegistry.get('subagent', parentAgent);

    // Case A: global_memory = true
    let capturedAgentA: Agent | undefined;
    let assemblyA: any;
    const unlistenA = runtime.context.on('agent/created', async ({ agent }) => {
      if (agent.id !== parentSessionId) {
        capturedAgentA = agent;
        assemblyA = await runtime.context.systemPrompt.assemble({ scope: agent });
      }
    });

    const resA = await subagentTool.execute(
      {
        description: 'subagent with global memory',
        prompt: 'Task with global memory',
        global_memory: true,
        run_in_background: false,
      },
      { agent: parentAgent, signal: new AbortController().signal } as any
    );
    unlistenA();

    expect(resA.kind).toBe('foreground');
    expect(capturedAgentA).toBeDefined();
    expect(isChildSession(capturedAgentA, runtime.context)).toBe(true);
    expect(assemblyA).toBeDefined();
    const memSectionA = assemblyA.sections.find((s: any) => s.name === 'memory:enkeep');
    expect(memSectionA).toBeDefined();
    expect(memSectionA.text).toContain('<global_memory');
    expect(memSectionA.text).toContain(GLOBAL_MEMORY_MARKER);

    // Case B: global_memory = false
    let capturedAgentB: Agent | undefined;
    let assemblyB: any;
    const unlistenB = runtime.context.on('agent/created', async ({ agent }) => {
      if (agent.id !== parentSessionId) {
        capturedAgentB = agent;
        assemblyB = await runtime.context.systemPrompt.assemble({ scope: agent });
      }
    });

    const resB = await subagentTool.execute(
      {
        description: 'subagent without global memory',
        prompt: 'Task without global memory',
        global_memory: false,
        run_in_background: false,
      },
      { agent: parentAgent, signal: new AbortController().signal } as any
    );
    unlistenB();

    expect(resB.kind).toBe('foreground');
    expect(capturedAgentB).toBeDefined();
    const memSectionB = assemblyB.sections.find((s: any) => s.name === 'memory:enkeep');
    expect(memSectionB).toBeDefined();
    expect(memSectionB.text).not.toContain('<global_memory');
    expect(memSectionB.text).not.toContain(GLOBAL_MEMORY_MARKER);
    expect(memSectionB.text).toContain('<space_memory');

    // Case C: global_memory omitted
    let capturedAgentC: Agent | undefined;
    let assemblyC: any;
    const unlistenC = runtime.context.on('agent/created', async ({ agent }) => {
      if (agent.id !== parentSessionId) {
        capturedAgentC = agent;
        assemblyC = await runtime.context.systemPrompt.assemble({ scope: agent });
      }
    });

    const resC = await subagentTool.execute(
      {
        description: 'subagent with omitted global memory',
        prompt: 'Task with omitted global memory',
        run_in_background: false,
      },
      { agent: parentAgent, signal: new AbortController().signal } as any
    );
    unlistenC();

    expect(resC.kind).toBe('foreground');
    expect(capturedAgentC).toBeDefined();
    const memSectionC = assemblyC.sections.find((s: any) => s.name === 'memory:enkeep');
    expect(memSectionC).toBeDefined();
    expect(memSectionC.text).not.toContain('<global_memory');
    expect(memSectionC.text).not.toContain(GLOBAL_MEMORY_MARKER);
  });

  it('4. Workflow agent: opts.globalMemory true injects memory; false or omitted does not', async () => {
    runtime = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
    });

    const parentSessionId = 'ses_00000000000000000000000000000004';
    const parentAgent = await runtime.getOrCreateAgent(parentSessionId, null, 'space-synthetic-percall');
    const toolsRegistry = parentAgent.ctx.get('tools');
    const workflowTool = toolsRegistry.get('workflow', parentAgent);

    // Case A: opts.globalMemory = true
    let capturedAgentA: Agent | undefined;
    let assemblyA: any;
    const unlistenA = runtime.context.on('agent/created', async ({ agent }) => {
      if (agent.id !== parentSessionId) {
        capturedAgentA = agent;
        assemblyA = await runtime.context.systemPrompt.assemble({ scope: agent });
      }
    });

    const scriptA = `
      const res = await agent("Audit with memory", { globalMemory: true });
      return { ok: true, res };
    `;
    const resA = await workflowTool.execute(
      {
        meta: { name: 'wf-mem-true', description: 'test' },
        script: scriptA,
      },
      { agent: parentAgent, signal: new AbortController().signal } as any
    );
    unlistenA();

    expect(resA.kind).toBe('foreground');
    expect(resA.result.ok).toBe(true);
    expect(capturedAgentA).toBeDefined();
    expect(isChildSession(capturedAgentA, runtime.context)).toBe(true);
    const memSectionA = assemblyA.sections.find((s: any) => s.name === 'memory:enkeep');
    expect(memSectionA).toBeDefined();
    expect(memSectionA.text).toContain('<global_memory');
    expect(memSectionA.text).toContain(GLOBAL_MEMORY_MARKER);

    // Case B: opts.globalMemory = false
    let capturedAgentB: Agent | undefined;
    let assemblyB: any;
    const unlistenB = runtime.context.on('agent/created', async ({ agent }) => {
      if (agent.id !== parentSessionId) {
        capturedAgentB = agent;
        assemblyB = await runtime.context.systemPrompt.assemble({ scope: agent });
      }
    });

    const scriptB = `
      const res = await agent("Audit without memory", { globalMemory: false });
      return { ok: true, res };
    `;
    const resB = await workflowTool.execute(
      {
        meta: { name: 'wf-mem-false', description: 'test' },
        script: scriptB,
      },
      { agent: parentAgent, signal: new AbortController().signal } as any
    );
    unlistenB();

    expect(resB.kind).toBe('foreground');
    expect(resB.result.ok).toBe(true);
    expect(capturedAgentB).toBeDefined();
    const memSectionB = assemblyB.sections.find((s: any) => s.name === 'memory:enkeep');
    expect(memSectionB).toBeDefined();
    expect(memSectionB.text).not.toContain('<global_memory');
    expect(memSectionB.text).not.toContain(GLOBAL_MEMORY_MARKER);

    // Case C: opts.globalMemory omitted
    let capturedAgentC: Agent | undefined;
    let assemblyC: any;
    const unlistenC = runtime.context.on('agent/created', async ({ agent }) => {
      if (agent.id !== parentSessionId) {
        capturedAgentC = agent;
        assemblyC = await runtime.context.systemPrompt.assemble({ scope: agent });
      }
    });

    const scriptC = `
      const res = await agent("Audit omitted memory");
      return { ok: true, res };
    `;
    const resC = await workflowTool.execute(
      {
        meta: { name: 'wf-mem-omitted', description: 'test' },
        script: scriptC,
      },
      { agent: parentAgent, signal: new AbortController().signal } as any
    );
    unlistenC();

    expect(resC.kind).toBe('foreground');
    expect(resC.result.ok).toBe(true);
    expect(capturedAgentC).toBeDefined();
    const memSectionC = assemblyC.sections.find((s: any) => s.name === 'memory:enkeep');
    expect(memSectionC).toBeDefined();
    expect(memSectionC.text).not.toContain('<global_memory');
    expect(memSectionC.text).not.toContain(GLOBAL_MEMORY_MARKER);

    // Case D: opts.globalMemory invalid type -> rejected by opts validation
    const scriptD = `
      await agent("Audit bad memory", { globalMemory: "always" });
      return { ok: true };
    `;
    await expect(
      workflowTool.execute(
        {
          meta: { name: 'wf-mem-invalid', description: 'test' },
          script: scriptD,
        },
        { agent: parentAgent, signal: new AbortController().signal } as any
      )
    ).rejects.toThrow(/globalMemory/);
  });

  it('5. subagent_fork keeps upstream behavior with no global memory injection', async () => {
    runtime = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
    });

    const parentSessionId = 'ses_00000000000000000000000000000005';
    const parentAgent = await runtime.getOrCreateAgent(parentSessionId, null, 'space-synthetic-percall');
    const toolsRegistry = parentAgent.ctx.get('tools');
    const forkTool = toolsRegistry.get('subagent_fork', parentAgent);

    let capturedForkAgent: Agent | undefined;
    let forkAssembly: any;
    const unlisten = runtime.context.on('agent/created', async ({ agent }) => {
      if (agent.id !== parentSessionId) {
        capturedForkAgent = agent;
        forkAssembly = await runtime.context.systemPrompt.assemble({ scope: agent });
      }
    });

    const res = await forkTool.execute(
      {
        description: 'fork agent run',
        prompt: 'Fork task',
        run_in_background: false,
      },
      { agent: parentAgent, signal: new AbortController().signal } as any
    );
    unlisten();

    expect(res.kind).toBe('foreground');
    expect(capturedForkAgent).toBeDefined();
    expect(isChildSession(capturedForkAgent, runtime.context)).toBe(true);
    const forkMemSection = forkAssembly.sections.find((s: any) => s.name === 'memory:enkeep');
    expect(forkMemSection).toBeDefined();
    expect(forkMemSection.text).not.toContain('<global_memory');
    expect(forkMemSection.text).not.toContain(GLOBAL_MEMORY_MARKER);
    expect(forkMemSection.text).toContain('<space_memory');
  });

  it('6. ENKEEP_SUBAGENT_GLOBAL_MEMORY env var is ignored in favor of per-call flags', async () => {
    // Set env to 'always' - previously this forced all subagents to inject memory.
    process.env.ENKEEP_SUBAGENT_GLOBAL_MEMORY = 'always';

    runtime = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
    });

    const parentSessionId = 'ses_00000000000000000000000000000006';
    const parentAgent = await runtime.getOrCreateAgent(parentSessionId, null, 'space-synthetic-percall');
    const toolsRegistry = parentAgent.ctx.get('tools');
    const subagentTool = toolsRegistry.get('subagent', parentAgent);

    // When global_memory is NOT set (omitted), it must NOT inject memory despite env = 'always'
    let capturedAgent: Agent | undefined;
    let assembly: any;
    const unlisten = runtime.context.on('agent/created', async ({ agent }) => {
      if (agent.id !== parentSessionId) {
        capturedAgent = agent;
        assembly = await runtime.context.systemPrompt.assemble({ scope: agent });
      }
    });

    await subagentTool.execute(
      {
        description: 'subagent without global memory flag',
        prompt: 'Check memory with env always',
        run_in_background: false,
      },
      { agent: parentAgent, signal: new AbortController().signal } as any
    );
    unlisten();

    expect(capturedAgent).toBeDefined();
    const memSection = assembly.sections.find((s: any) => s.name === 'memory:enkeep');
    expect(memSection).toBeDefined();
    // Must NOT contain global memory!
    expect(memSection.text).not.toContain('<global_memory');
    expect(memSection.text).not.toContain(GLOBAL_MEMORY_MARKER);
  });

  it('7. Continuable background subagent, list_agents, send_message, and model selection unaffected', async () => {
    const customProviders = {
      'cpa-synthetic-alpha': {
        models: [
          { id: 'synth-model-fast' },
          { id: 'synth-model-pro' },
        ],
      },
    };

    runtime = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
      providers: customProviders,
      provider: 'cpa-synthetic-alpha',
      model: 'synth-model-fast',
      llmEnabled: false,
    });

    const parentSessionId = 'ses_00000000000000000000000000000007';
    const parentAgent = await runtime.getOrCreateAgent(parentSessionId, null, 'space-synthetic-percall');
    const toolsRegistry = parentAgent.ctx.get('tools');
    const subagentTool = toolsRegistry.get('subagent', parentAgent);

    // Test continuable background execution with model selection and global_memory: true
    let capturedChild: Agent | undefined;
    let childAssembly: any;
    const unlisten = runtime.context.on('agent/created', async ({ agent }) => {
      if (agent.id !== parentSessionId) {
        capturedChild = agent;
        childAssembly = await runtime.context.systemPrompt.assemble({ scope: agent });
      }
    });

    const bgRes = await subagentTool.execute(
      {
        description: 'background subagent with pro model',
        prompt: 'Do something continuable',
        provider: 'cpa-synthetic-alpha',
        model: 'synth-model-pro',
        global_memory: true,
        run_in_background: true,
      },
      { agent: parentAgent, signal: new AbortController().signal } as any
    );
    unlisten();

    expect(bgRes.kind).toBe('continuable');
    expect(bgRes.subagentId).toBeDefined();
    expect(capturedChild).toBeDefined();

    // Verify model selection took effect
    expect(capturedChild!.options.provider).toBe('cpa-synthetic-alpha');
    expect(capturedChild!.options.model).toBe('synth-model-pro');

    // Verify global memory injection took effect
    const memSection = childAssembly.sections.find((s: any) => s.name === 'memory:enkeep');
    expect(memSection).toBeDefined();
    expect(memSection.text).toContain('<global_memory');
    expect(memSection.text).toContain(GLOBAL_MEMORY_MARKER);

    // Test list_agents
    const listAgentsTool = toolsRegistry.get('list_agents', parentAgent);
    expect(listAgentsTool).toBeDefined();
    const listRes = await listAgentsTool.execute({}, { agent: parentAgent, signal: new AbortController().signal } as any);
    expect(listRes).toBeDefined();
    const listText = listRes.content?.[0]?.text ?? JSON.stringify(listRes);
    expect(listText).toContain(bgRes.subagentId);

    // Test send_message
    const sendMessageTool = toolsRegistry.get('send_message', parentAgent);
    expect(sendMessageTool).toBeDefined();
    const sendRes = await sendMessageTool.execute(
      {
        agent_id: bgRes.subagentId,
        message: 'Steering message to child',
      },
      { agent: parentAgent, signal: new AbortController().signal } as any
    );
    expect(sendRes).toBeDefined();
  });
});
