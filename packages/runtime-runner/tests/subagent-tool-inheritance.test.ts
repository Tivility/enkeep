/**
 * G08a Subagent Tool & Scope Inheritance Regression Test Suite
 *
 * Verifies real Cordis and DSH runtime execution:
 * 1. Spawn subagent executes real workspace write and read tools on disk (real ToolFs).
 * 2. Fork subagent inherits workspace directory and executes real bash commands in workspace cwd (real ToolBash).
 * 3. ToolFilter restriction isolates child tools without contaminating parent agent capabilities.
 * 4. G08b lineage metadata (parentSession, cwd, origin, delegationDepth) and cold resume scope inheritance.
 *
 * @module @enkeep/runtime-runner/tests/subagent-tool-inheritance.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SubagentRun } from '@deepseek-ai/dsh-subagent';
import type { AgentHandle } from '@deepseek-ai/dsh-agent';
import {
  bootDshRuntime,
  type DshBootedRuntime,
} from '../src/runtime/dsh-boot.js';
import {
  scopeOf,
  scopeParentOf,
} from '../src/runtime/child-scope.js';

describe('G08a: Subagent Tool & Scope Inheritance E2E', () => {
  let tmpDir: string;
  let dshHome: string;
  let spacesDir: string;
  let spaceAlphaPath: string;
  let runtime: DshBootedRuntime;
  const trackedRuns: SubagentRun[] = [];
  const trackedHandles: AgentHandle[] = [];

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-g08a-subagent-'));
    dshHome = path.join(tmpDir, '.dsh');
    spacesDir = path.join(tmpDir, 'spaces');
    spaceAlphaPath = path.join(spacesDir, 'space-alpha');

    fs.mkdirSync(dshHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spacesDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spaceAlphaPath, { recursive: true, mode: 0o700 });

    runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome,
      spacesDir,
    });
  });

  afterEach(async () => {
    // Teardown own child lifecycle cleanup registry
    for (const run of trackedRuns) {
      try {
        await run.dispose();
      } catch {}
    }
    trackedRuns.length = 0;

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

  // Test 1: Spawn child agent executes real workspace write and read tools on disk
  it('1. Spawn child agent executes real workspace write and read tools on disk (Spawn write -> read)', async () => {
    const parentSessionId = 'ses_00000000000000000000000000000001';
    const parentAgent = await runtime.getOrCreateAgent(parentSessionId, null, 'space-alpha');
    const subagentsService = parentAgent.ctx.get('subagents');
    expect(subagentsService).toBeDefined();

    const writePrompt = 'Write file [enkeep-test-tool-call=write:{"file_path":"sub_test.txt","content":"hello from child"}]';
    const writeRun = await subagentsService.start('spawn', {
      label: 'child-write-task',
      prompt: [{ type: 'text', text: writePrompt }],
      parent: parentAgent,
      signal: new AbortController().signal,
    });
    trackedRuns.push(writeRun);

    const writeResult = await writeRun.result;
    expect(writeResult.stopReason).toBe('completed');
    expect(writeResult.output[0].text).toContain('sub_test.txt');

    // Assert physical file exists on disk within space boundary
    const targetFilePath = path.join(spaceAlphaPath, 'sub_test.txt');
    expect(fs.existsSync(targetFilePath)).toBe(true);
    expect(fs.readFileSync(targetFilePath, 'utf8')).toBe('hello from child');

    // Now spawn child to read the newly created file
    const readPrompt = 'Read file [enkeep-test-tool-call=read:{"file_path":"sub_test.txt"}]';
    const readRun = await subagentsService.start('spawn', {
      label: 'child-read-task',
      prompt: [{ type: 'text', text: readPrompt }],
      parent: parentAgent,
      signal: new AbortController().signal,
    });
    trackedRuns.push(readRun);

    const readResult = await readRun.result;
    expect(readResult.stopReason).toBe('completed');
    expect(readResult.output[0].text).toContain('hello from child');
  });

  // Test 2: Fork child agent inherits workspace directory and executes bash command
  it('2. Fork child agent inherits workspace directory and executes bash command (Fork bash execution)', async () => {
    const parentSessionId = 'ses_00000000000000000000000000000002';
    const parentAgent = await runtime.getOrCreateAgent(parentSessionId, null, 'space-alpha');
    const subagentsService = parentAgent.ctx.get('subagents');

    const bashPrompt = 'Run bash [enkeep-test-tool-call=bash:{"command":"pwd","description":"Check working directory"}]';
    const forkRun = await subagentsService.start('fork', {
      label: 'child-bash-task',
      prompt: [{ type: 'text', text: bashPrompt }],
      parent: parentAgent,
      signal: new AbortController().signal,
    });
    trackedRuns.push(forkRun);

    const bashResult = await forkRun.result;
    expect(bashResult.stopReason).toBe('completed');

    // The output should contain the real physical workspace path
    const realSpaceAlpha = fs.realpathSync(spaceAlphaPath);
    expect(bashResult.output[0].text).toMatch(new RegExp(realSpaceAlpha.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '|' + spaceAlphaPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  // Test 3: ToolFilter restriction isolates child tools without contaminating parent
  it('3. ToolFilter restriction isolates child tools without contaminating parent (ToolFilter isolation)', async () => {
    const parentSessionId = 'ses_00000000000000000000000000000003';
    const parentAgent = await runtime.getOrCreateAgent(parentSessionId, null, 'space-alpha');
    const subagentsService = parentAgent.ctx.get('subagents');

    // Verify parent has write and read tools
    const parentToolsBefore = parentAgent.ctx.tools.schemas(parentAgent).map((t: any) => t.name);
    expect(parentToolsBefore).toContain('write');
    expect(parentToolsBefore).toContain('read');

    // Start subagent with toolFilter denying write
    const deniedPrompt = 'Attempt write [enkeep-test-tool-call=write:{"file_path":"should_not_exist.txt","content":"blocked"}]';
    const filteredRun = await subagentsService.start('spawn', {
      label: 'child-filtered-task',
      prompt: [{ type: 'text', text: deniedPrompt }],
      parent: parentAgent,
      toolFilter: { deny: ['write'] },
      signal: new AbortController().signal,
    });
    trackedRuns.push(filteredRun);

    const childAgent = filteredRun.localAgent;
    const childTools = childAgent.ctx.tools.schemas(childAgent).map((t: any) => t.name);

    // Child must NOT have write tool, but must retain read tool
    expect(childTools).not.toContain('write');
    expect(childTools).toContain('read');

    // Execution of write tool by child must fail
    const filteredResult = await filteredRun.result;
    expect(filteredResult.output[0].text).toContain('Error: unknown tool "write"');
    expect(fs.existsSync(path.join(spaceAlphaPath, 'should_not_exist.txt'))).toBe(false);

    // Parent agent tools must remain intact without pollution
    const parentToolsAfter = parentAgent.ctx.tools.schemas(parentAgent).map((t: any) => t.name);
    expect(parentToolsAfter).toContain('write');
    expect(parentToolsAfter).toContain('read');
  });

  // Test 4: Subagent lineage, space metadata, and cold resume scope inheritance
  it('4. Subagent lineage, space metadata, and cold resume scope inheritance (Lineage & Cold Resume)', async () => {
    const parentSessionId = 'ses_00000000000000000000000000000004';
    const parentAgent = await runtime.getOrCreateAgent(parentSessionId, null, 'space-alpha');
    const subagentsService = parentAgent.ctx.get('subagents');

    const metaRun = await subagentsService.start('spawn', {
      label: 'child-meta-task',
      prompt: [{ type: 'text', text: 'Hello subagent' }],
      parent: parentAgent,
      signal: new AbortController().signal,
    });
    trackedRuns.push(metaRun);

    const child = metaRun.localAgent;
    const childHeader = child.session.header;
    const childId = child.id;

    // Verify G08b lineage metadata
    expect(childHeader.parentSession).toBe(parentSessionId);
    expect(childHeader.cwd).toBe(spaceAlphaPath);
    expect(childHeader.origin).toBe('subagent');
    expect(childHeader.delegationDepth).toBe(1);

    await metaRun.result;
    await metaRun.dispose();

    // Verify cold resume retains scope inheritance
    const resumedHandle = await runtime.context.agents.resume({
      resumeSessionId: childId,
      agentOptions: {},
    });
    trackedHandles.push(resumedHandle);

    const resumedChild = resumedHandle.agent;
    const resumedChildScope = scopeOf(resumedChild.ctx);
    const parentScope = scopeOf(parentAgent.ctx);

    expect(resumedChildScope).toBeDefined();
    expect(parentScope).toBeDefined();
    expect(scopeParentOf(resumedChildScope!)).toBe(parentScope);
  });

  // Test 5: Concurrent separate Parent A and Parent B subagents maintain strict FS isolation and own read/write
  it('5. Concurrent separate Parent A and Parent B subagents maintain strict FS isolation and own read/write (Cross-space FS isolation & Disposal)', async () => {
    const spaceBetaPath = path.join(spacesDir, 'space-beta');
    fs.mkdirSync(spaceBetaPath, { recursive: true, mode: 0o700 });

    const parentSessionIdA = 'ses_00000000000000000000000000000005';
    const parentSessionIdB = 'ses_00000000000000000000000000000006';

    const parentA = await runtime.getOrCreateAgent(parentSessionIdA, null, 'space-alpha');
    const parentB = await runtime.getOrCreateAgent(parentSessionIdB, null, 'space-beta');

    const subagentsA = parentA.ctx.get('subagents');
    const subagentsB = parentB.ctx.get('subagents');
    expect(subagentsA).toBeDefined();
    expect(subagentsB).toBeDefined();

    // Verify parent tools before child execution
    const parentAToolsBefore = parentA.ctx.tools.schemas(parentA).map((t: any) => t.name);
    const parentBToolsBefore = parentB.ctx.tools.schemas(parentB).map((t: any) => t.name);
    expect(parentAToolsBefore).toContain('write');
    expect(parentBToolsBefore).toContain('write');

    // Concurrently start write runs in Child A (space-alpha) and Child B (space-beta)
    const writePromptA = 'Write file [enkeep-test-tool-call=write:{"file_path":"alpha_file.txt","content":"data-from-alpha"}]';
    const writePromptB = 'Write file [enkeep-test-tool-call=write:{"file_path":"beta_file.txt","content":"data-from-beta"}]';

    const [runA, runB] = await Promise.all([
      subagentsA.start('spawn', {
        label: 'child-a-write',
        prompt: [{ type: 'text', text: writePromptA }],
        parent: parentA,
        signal: new AbortController().signal,
      }),
      subagentsB.start('spawn', {
        label: 'child-b-write',
        prompt: [{ type: 'text', text: writePromptB }],
        parent: parentB,
        signal: new AbortController().signal,
      }),
    ]);
    trackedRuns.push(runA, runB);

    // Verify child context fs isolation points to their own workspace without cross-space contamination
    const childAgentA = runA.localAgent;
    const childAgentB = runB.localAgent;
    expect(childAgentA.ctx.fs?.config?.cwd).toBe(spaceAlphaPath);
    expect(childAgentB.ctx.fs?.config?.cwd).toBe(spaceBetaPath);

    const [resA, resB] = await Promise.all([runA.result, runB.result]);
    expect(resA.stopReason).toBe('completed');
    expect(resB.stopReason).toBe('completed');

    // Prove physical file writes remain strictly in their respective spaces
    const fileInAlpha = path.join(spaceAlphaPath, 'alpha_file.txt');
    const fileInBeta = path.join(spaceBetaPath, 'beta_file.txt');
    const leakedInBeta = path.join(spaceBetaPath, 'alpha_file.txt');
    const leakedInAlpha = path.join(spaceAlphaPath, 'beta_file.txt');

    expect(fs.existsSync(fileInAlpha)).toBe(true);
    expect(fs.readFileSync(fileInAlpha, 'utf8')).toBe('data-from-alpha');
    expect(fs.existsSync(leakedInBeta)).toBe(false);

    expect(fs.existsSync(fileInBeta)).toBe(true);
    expect(fs.readFileSync(fileInBeta, 'utf8')).toBe('data-from-beta');
    expect(fs.existsSync(leakedInAlpha)).toBe(false);

    // Concurrently read files back through children to verify independent read isolation
    const readPromptA = 'Read file [enkeep-test-tool-call=read:{"file_path":"alpha_file.txt"}]';
    const readPromptB = 'Read file [enkeep-test-tool-call=read:{"file_path":"beta_file.txt"}]';

    const [readRunA, readRunB] = await Promise.all([
      subagentsA.start('spawn', {
        label: 'child-a-read',
        prompt: [{ type: 'text', text: readPromptA }],
        parent: parentA,
        signal: new AbortController().signal,
      }),
      subagentsB.start('spawn', {
        label: 'child-b-read',
        prompt: [{ type: 'text', text: readPromptB }],
        parent: parentB,
        signal: new AbortController().signal,
      }),
    ]);
    trackedRuns.push(readRunA, readRunB);

    const [readResA, readResB] = await Promise.all([readRunA.result, readRunB.result]);
    expect(readResA.stopReason).toBe('completed');
    expect(readResB.stopReason).toBe('completed');
    expect(readResA.output[0].text).toContain('data-from-alpha');
    expect(readResB.output[0].text).toContain('data-from-beta');

    // Dispose child runs and prove parent tools are not polluted or corrupted
    await Promise.all([runA.dispose(), runB.dispose(), readRunA.dispose(), readRunB.dispose()]);

    const parentAToolsAfter = parentA.ctx.tools.schemas(parentA).map((t: any) => t.name);
    const parentBToolsAfter = parentB.ctx.tools.schemas(parentB).map((t: any) => t.name);
    expect(parentAToolsAfter).toEqual(parentAToolsBefore);
    expect(parentBToolsAfter).toEqual(parentBToolsBefore);
  });
});
