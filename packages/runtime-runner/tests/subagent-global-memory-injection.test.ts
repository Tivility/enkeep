/**
 * Subagent Global Memory Injection Configuration Test Suite
 *
 * Validates:
 * 1. Top-level session injects global memory by default into systemPrompt.
 * 2. Child session (subagent spawn & fork) gets no global memory injection by default (ENKEEP_SUBAGENT_GLOBAL_MEMORY='never').
 * 3. Child session with ENKEEP_SUBAGENT_GLOBAL_MEMORY='always' gets global memory injected.
 * 4. Memory tools (memory_search, memory_read, memory_write) remain available to child sessions.
 * 5. Workflow agent child is treated as a child session (no global memory by default; injected with 'always').
 * 6. dsh-memory plugin config is honored when configured on Cordis context.
 *
 * @module @enkeep/runtime-runner/tests/subagent-global-memory-injection.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Context, Service } from '@deepseek-ai/cordis';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import { MemoryService } from '@enkeep/dsh-memory';
import {
  bootDshRuntime,
  type DshBootedRuntime,
  isChildSession,
  resolveSubagentGlobalMemoryMode,
} from '../src/runtime/dsh-boot.js';

describe('Subagent Global Memory Injection Configuration', () => {
  let tmpDir: string;
  let dshHome: string;
  let spacesDir: string;
  let spacePath: string;
  let runtime: DshBootedRuntime;
  const trackedHandles: AgentHandle[] = [];
  const originalEnv = process.env.ENKEEP_SUBAGENT_GLOBAL_MEMORY;

  const GLOBAL_MEMORY_MARKER = 'SYNTHETIC_GLOBAL_PREFERENCE_KEY_9988';

  beforeEach(async () => {
    delete process.env.ENKEEP_SUBAGENT_GLOBAL_MEMORY;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-subagent-mem-test-'));
    dshHome = path.join(tmpDir, '.dsh');
    spacesDir = path.join(tmpDir, 'spaces');
    spacePath = path.join(spacesDir, 'space-synthetic-alpha');

    fs.mkdirSync(dshHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spacesDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spacePath, { recursive: true, mode: 0o700 });

    const globalMemDir = path.join(dshHome, 'memory');
    fs.mkdirSync(globalMemDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(globalMemDir, 'global.md'),
      `# Global Memory\n\nUser preference marker: ${GLOBAL_MEMORY_MARKER}\nKeep this safe.\n`,
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

  it('1. Top-level session injects global memory by default', async () => {
    runtime = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
    });

    const sessionId = 'ses_00000000000000000000000000000001';
    const parentAgent = await runtime.getOrCreateAgent(sessionId, null, 'space-synthetic-alpha');

    expect(isChildSession(parentAgent, runtime.context)).toBe(false);

    const assembly = await runtime.context.systemPrompt.assemble({ scope: parentAgent });
    const memSection = assembly.sections.find((s) => s.name === 'memory:enkeep');

    expect(memSection).toBeDefined();
    expect(memSection!.text).toContain('<global_memory');
    expect(memSection!.text).toContain(GLOBAL_MEMORY_MARKER);
    expect(memSection!.text).toContain('<space_memory');
  });

  it('2. Child session gets no global memory injection by default (ENKEEP_SUBAGENT_GLOBAL_MEMORY unset / default)', async () => {
    expect(resolveSubagentGlobalMemoryMode()).toBe('never');

    runtime = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
    });

    const parentSessionId = 'ses_00000000000000000000000000000002';
    const parentAgent = await runtime.getOrCreateAgent(parentSessionId, null, 'space-synthetic-alpha');

    const subagentsService = parentAgent.ctx.get('subagents');
    expect(subagentsService).toBeDefined();

    // Spawn child agent
    const spawnRun = await subagentsService.start('spawn', {
      label: 'test-child-spawn',
      prompt: [{ type: 'text', text: 'Hello child agent' }],
      parent: parentAgent,
      signal: new AbortController().signal,
    });

    const childAgent = spawnRun.localAgent!;
    expect(childAgent).toBeDefined();
    expect(isChildSession(childAgent, runtime.context)).toBe(true);

    const childAssembly = await runtime.context.systemPrompt.assemble({ scope: childAgent });
    const childMemSection = childAssembly.sections.find((s) => s.name === 'memory:enkeep');

    expect(childMemSection).toBeDefined();
    // Default child should NOT contain global memory
    expect(childMemSection!.text).not.toContain('<global_memory');
    expect(childMemSection!.text).not.toContain(GLOBAL_MEMORY_MARKER);
    // Space memory section is still present
    expect(childMemSection!.text).toContain('<space_memory');

    // Memory tools remain available to the child
    const childTools = childAgent.ctx.tools.schemas(childAgent).map((t: any) => t.name);
    expect(childTools).toContain('memory_search');
    expect(childTools).toContain('memory_read');
    expect(childTools).toContain('memory_write');

    await spawnRun.result;
    await spawnRun.dispose();

    // Fork child agent also gets no global memory
    const forkRun = await subagentsService.start('fork', {
      label: 'test-child-fork',
      prompt: [{ type: 'text', text: 'Hello fork agent' }],
      parent: parentAgent,
      signal: new AbortController().signal,
    });

    const forkAgent = forkRun.localAgent!;
    expect(forkAgent).toBeDefined();
    expect(isChildSession(forkAgent, runtime.context)).toBe(true);

    const forkAssembly = await runtime.context.systemPrompt.assemble({ scope: forkAgent });
    const forkMemSection = forkAssembly.sections.find((s) => s.name === 'memory:enkeep');

    expect(forkMemSection).toBeDefined();
    expect(forkMemSection!.text).not.toContain('<global_memory');
    expect(forkMemSection!.text).not.toContain(GLOBAL_MEMORY_MARKER);

    // Memory tools remain available
    const forkTools = forkAgent.ctx.tools.schemas(forkAgent).map((t: any) => t.name);
    expect(forkTools).toContain('memory_search');
    expect(forkTools).toContain('memory_read');
    expect(forkTools).toContain('memory_write');

    await forkRun.result;
    await forkRun.dispose();
  });

  it('3. With env ENKEEP_SUBAGENT_GLOBAL_MEMORY = always, child session does inject global memory', async () => {
    process.env.ENKEEP_SUBAGENT_GLOBAL_MEMORY = 'always';
    expect(resolveSubagentGlobalMemoryMode()).toBe('always');

    runtime = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
    });

    const parentSessionId = 'ses_00000000000000000000000000000003';
    const parentAgent = await runtime.getOrCreateAgent(parentSessionId, null, 'space-synthetic-alpha');

    const subagentsService = parentAgent.ctx.get('subagents');
    expect(subagentsService).toBeDefined();

    const spawnRun = await subagentsService.start('spawn', {
      label: 'test-child-always-mem',
      prompt: [{ type: 'text', text: 'Hello child agent with memory' }],
      parent: parentAgent,
      signal: new AbortController().signal,
    });

    const childAgent = spawnRun.localAgent!;
    expect(childAgent).toBeDefined();
    expect(isChildSession(childAgent, runtime.context)).toBe(true);

    const childAssembly = await runtime.context.systemPrompt.assemble({ scope: childAgent });
    const childMemSection = childAssembly.sections.find((s) => s.name === 'memory:enkeep');

    expect(childMemSection).toBeDefined();
    // With env 'always', global memory IS injected into child
    expect(childMemSection!.text).toContain('<global_memory');
    expect(childMemSection!.text).toContain(GLOBAL_MEMORY_MARKER);

    // Memory tools remain available
    const childTools = childAgent.ctx.tools.schemas(childAgent).map((t: any) => t.name);
    expect(childTools).toContain('memory_search');

    await spawnRun.result;
    await spawnRun.dispose();
  });

  it('4. Workflow agent child is treated as a child session (never by default, always with env)', async () => {
    // Phase A: default env ('never') -> workflow agent child has no global memory
    runtime = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
    });

    const parentSessionId = 'ses_00000000000000000000000000000004';
    const parentAgent = await runtime.getOrCreateAgent(parentSessionId, null, 'space-synthetic-alpha');

    const engine = parentAgent.ctx.get('workflowEngine');
    expect(engine).toBeDefined();

    let capturedChildAgent: Agent | undefined;
    let childAssembly: any;
    const unlisten = runtime.context.on('agent/created', async ({ agent }) => {
      if (agent.id !== parentSessionId) {
        capturedChildAgent = agent;
        childAssembly = await runtime.context.systemPrompt.assemble({ scope: agent });
      }
    });

    const meta = {
      name: 'synthetic-wf-mem-test',
      description: 'Run one child agent and verify memory injection',
    };
    const script = `
      const childResult = await agent("Synthesize response");
      return { ok: true, childResult };
    `;

    const run = engine.start({
      script,
      meta,
      parent: parentAgent,
    });

    const outcome = await run.result;
    unlisten();

    expect(outcome.stopReason).toBe('completed');
    expect(capturedChildAgent).toBeDefined();
    expect(isChildSession(capturedChildAgent, runtime.context)).toBe(true);

    expect(childAssembly).toBeDefined();
    const childMemSection = childAssembly.sections.find((s: any) => s.name === 'memory:enkeep');

    expect(childMemSection).toBeDefined();
    expect(childMemSection!.text).not.toContain('<global_memory');
    expect(childMemSection!.text).not.toContain(GLOBAL_MEMORY_MARKER);
    expect(childMemSection!.text).toContain('<space_memory');

    // Memory tools remain available on workflow child
    const childTools = capturedChildAgent!.ctx.tools.schemas(capturedChildAgent).map((t: any) => t.name);
    expect(childTools).toContain('memory_search');

    await runtime.dispose();

    // Phase B: with env 'always' -> workflow agent child gets global memory
    process.env.ENKEEP_SUBAGENT_GLOBAL_MEMORY = 'always';
    runtime = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
    });

    const parentSessionIdB = 'ses_00000000000000000000000000000005';
    const parentAgentB = await runtime.getOrCreateAgent(parentSessionIdB, null, 'space-synthetic-alpha');

    const engineB = parentAgentB.ctx.get('workflowEngine');
    let capturedChildAgentB: Agent | undefined;
    let childAssemblyB: any;
    const unlistenB = runtime.context.on('agent/created', async ({ agent }) => {
      if (agent.id !== parentSessionIdB) {
        capturedChildAgentB = agent;
        childAssemblyB = await runtime.context.systemPrompt.assemble({ scope: agent });
      }
    });

    const runB = engineB.start({
      script,
      meta,
      parent: parentAgentB,
    });

    const outcomeB = await runB.result;
    unlistenB();

    expect(outcomeB.stopReason).toBe('completed');
    expect(capturedChildAgentB).toBeDefined();
    expect(isChildSession(capturedChildAgentB, runtime.context)).toBe(true);

    expect(childAssemblyB).toBeDefined();
    const childMemSectionB = childAssemblyB.sections.find((s: any) => s.name === 'memory:enkeep');

    expect(childMemSectionB).toBeDefined();
    expect(childMemSectionB!.text).toContain('<global_memory');
    expect(childMemSectionB!.text).toContain(GLOBAL_MEMORY_MARKER);
  });

  it('5. dsh-memory plugin config is honored when configured on context', async () => {
    const testCtx = new Context();
    const customMemService = new MemoryService(testCtx, { injectGlobalMemory: 'never' });

    class MockToolsService extends Service {
      public tools: any[] = [];
      constructor(c: Context) { super(c, 'tools'); }
      register(tool: any) { this.tools.push(tool); return () => {}; }
    }
    class MockSystemPromptService extends Service {
      public sections: any[] = [];
      constructor(c: Context) { super(c, 'systemPrompt'); }
      section(sec: any) { this.sections.push(sec); return () => {}; }
    }

    await testCtx.plugin(MockToolsService);
    await testCtx.plugin(MockSystemPromptService);

    const isolatedCtx = testCtx.isolate(['tools', 'systemPrompt']);
    const mountHandle = customMemService.mountAgentMemory(isolatedCtx, {
      dshHome,
      spacePath,
      userId: 'user-synthetic-alice',
    });

    expect(mountHandle.snapshot.globalMemory).toBeUndefined();
    expect(mountHandle.registeredTools).toEqual(['memory_search', 'memory_read', 'memory_write']);
    mountHandle.dispose();
  });
});
