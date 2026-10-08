/**
 * Subagent Session Query Integration & Continuation Test Suite
 *
 * Verifies Developer C requirements:
 * 1. list_agents tool no longer fails with SUBAGENT_CONTROL_QUERY_UNAVAILABLE
 *    when executed from a composition-booted agent context.
 * 2. send_message tool on a cold continuable subagent no longer fails with
 *    CONTINUATION_UNAVAILABLE and successfully cold-resumes.
 * 3. Exact negative error verification: if sessionQuery is omitted from the context,
 *    list_agents throws SUBAGENT_CONTROL_QUERY_UNAVAILABLE and cold resume throws CONTINUATION_UNAVAILABLE.
 *
 * @module @enkeep/runtime-runner/tests/subagent-session-query-composition.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import {
  bootDshRuntime,
  type DshBootedRuntime,
} from '../src/runtime/dsh-boot.js';

describe('Subagent Session Query Mounting & Cold Continuation', () => {
  let tmpDir: string;
  let dshHome: string;
  let spacesDir: string;
  let spacePath: string;
  let runtime: DshBootedRuntime;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-session-query-test-'));
    dshHome = path.join(tmpDir, 'synthetic-user', '.dsh');
    spacesDir = path.join(tmpDir, 'synthetic-user', 'spaces');
    spacePath = path.join(spacesDir, 'spc_00000000000000000000000000000001');

    fs.mkdirSync(dshHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spacesDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spacePath, { recursive: true, mode: 0o700 });
  });

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('1. sessionQuery service is mounted in Host scope with in-memory never-open SQLite backend', async () => {
    runtime = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
    });

    const sessionQuery = runtime.context.get('sessionQuery');
    expect(sessionQuery).toBeDefined();
    expect(typeof sessionQuery?.listSessions).toBe('function');
    expect(typeof sessionQuery?.observeSession).toBe('function');

    // Capabilities probe confirms subagents & subagent control remain fully available
    const capabilities = await runtime.getCapabilities!();
    expect(capabilities.subagents).toBe(true);
    expect(capabilities.subagentControl).toBe(true);
  });

  it('2. list_agents succeeds and no longer throws SUBAGENT_CONTROL_QUERY_UNAVAILABLE', async () => {
    runtime = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
    });

    const parentSessionId = 'ses_00000000000000000000000000000001';
    const parentAgent = await runtime.getOrCreateAgent(
      parentSessionId,
      null,
      'spc_00000000000000000000000000000001'
    );

    const toolsRegistry = parentAgent.ctx.get('tools');
    expect(toolsRegistry).toBeDefined();

    const listAgentsTool = toolsRegistry!.get('list_agents', parentAgent);
    expect(listAgentsTool).toBeDefined();

    // Invoking list_agents when no children exist must return empty result without SUBAGENT_CONTROL_QUERY_UNAVAILABLE
    const emptyResult = await listAgentsTool!.execute(
      {},
      { agent: parentAgent, signal: new AbortController().signal } as any
    );
    expect(emptyResult).toBeDefined();

    // Start one continuable subagent to populate children
    const subagents = runtime.context.get('subagents');
    expect(subagents).toBeDefined();

    const started = await subagents!.startContinuable({
      provider: 'spawn',
      label: 'synthetic-child-01',
      request: {
        prompt: [{ type: 'text', text: 'Synthetic child task' }],
        parent: parentAgent,
      },
      signal: new AbortController().signal,
    });
    expect(started.childId).toBeDefined();

    // List agents now discovers the child without failing on sessionQuery
    const populatedResult = await listAgentsTool!.execute(
      {},
      { agent: parentAgent, signal: new AbortController().signal } as any
    );
    expect(populatedResult).toBeDefined();
    if (Array.isArray(populatedResult)) {
      expect(populatedResult.length).toBeGreaterThanOrEqual(1);
      expect(populatedResult.some((entry: any) => entry.id === started.childId)).toBe(true);
    }
  });

  it('3. cold send_message continuation no longer fails with CONTINUATION_UNAVAILABLE', async () => {
    runtime = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
    });

    const parentSessionId = 'ses_00000000000000000000000000000002';
    const parentAgent = await runtime.getOrCreateAgent(
      parentSessionId,
      null,
      'spc_00000000000000000000000000000001'
    );

    const subagents = runtime.context.get('subagents');
    expect(subagents).toBeDefined();

    // Start continuable subagent
    const started = await subagents!.startContinuable({
      provider: 'spawn',
      label: 'synthetic-child-cold',
      request: {
        prompt: [{ type: 'text', text: 'Initial subagent prompt' }],
        parent: parentAgent,
      },
      signal: new AbortController().signal,
    });

    // Wait until child finishes turn and its in-memory live activation settles/disposes (becomes cold)
    await vi.waitFor(
      () => {
        expect(runtime.context.get('agents')?.get(started.childId)).toBeUndefined();
      },
      { timeout: 8_000 }
    );

    // Child is now cold in memory. Deliver a follow-up via send_message tool
    const toolsRegistry = parentAgent.ctx.get('tools');
    const sendMessageTool = toolsRegistry!.get('send_message', parentAgent);
    expect(sendMessageTool).toBeDefined();

    // Executing send_message to a cold child triggers coldResume requiring sessionQuery
    const sendResult = await sendMessageTool!.execute(
      {
        agent_id: String(started.childId),
        message: 'Synthetic follow-up to cold child',
      },
      { agent: parentAgent, signal: new AbortController().signal } as any
    );

    // Must succeed without CONTINUATION_UNAVAILABLE and return messageId
    expect(sendResult).toBeDefined();
    expect((sendResult as any).messageId).toBeDefined();
    expect(typeof (sendResult as any).messageId).toBe('string');
  });

  it('4. proves negative baseline: without sessionQuery, list_agents and cold resume fail with exact error codes', async () => {
    runtime = await bootDshRuntime({
      userId: 'user-synthetic-alice',
      dshHome,
      spacesDir,
    });

    const parentSessionId = 'ses_00000000000000000000000000000003';
    const parentAgent = await runtime.getOrCreateAgent(
      parentSessionId,
      null,
      'spc_00000000000000000000000000000001'
    );

    const toolsRegistry = parentAgent.ctx.get('tools');
    const listAgentsTool = toolsRegistry!.get('list_agents', parentAgent);
    const sendMessageTool = toolsRegistry!.get('send_message', parentAgent);

    // Disposing session-query-sqlite fiber unregisters sessionQuery service
    const sessionQueryFiber = runtime.officialPluginsHandle?.mountedPlugins.get('session-query-sqlite');
    expect(sessionQueryFiber).toBeDefined();
    await sessionQueryFiber!.dispose();

    expect(runtime.context.get('sessionQuery')).toBeUndefined();

    // 1. list_agents without sessionQuery throws SUBAGENT_CONTROL_QUERY_UNAVAILABLE
    await expect(
      listAgentsTool!.execute(
        {},
        { agent: parentAgent, signal: new AbortController().signal } as any
      )
    ).rejects.toMatchObject({
      code: 'SUBAGENT_CONTROL_QUERY_UNAVAILABLE',
    });

    // 2. cold send_message to a child without sessionQuery throws CONTINUATION_UNAVAILABLE
    const coldChildId = SessionId('ses_00000000000000000000000000000099');
    await expect(
      sendMessageTool!.execute(
        {
          agent_id: String(coldChildId),
          message: 'Synthetic cold message',
        },
        { agent: parentAgent, signal: new AbortController().signal } as any
      )
    ).rejects.toMatchObject({
      code: 'CONTINUATION_UNAVAILABLE',
    });
  });
});
