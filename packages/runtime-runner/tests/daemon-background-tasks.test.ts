import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RuntimeDaemon } from '../src/runtime/daemon.js';
import { DAEMON_OPS } from '../src/runtime/daemon-protocol.js';

describe('RuntimeDaemon Background Tasks RPC & Tracking', () => {
  let tmpDir: string;
  let dshHome: string;
  let spacesDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-daemon-bg-test-'));
    dshHome = path.join(tmpDir, 'alice', '.dsh');
    spacesDir = path.join(tmpDir, 'alice', 'spaces');

    fs.mkdirSync(dshHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spacesDir, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('tracks subagent lifecycle, last activity, shortId, and stop operation', async () => {
    const parentSessionId = 'ses_00000000000000000000000000000001';
    const childSessionId = 'ses_00000000000000000000000000000002';
    const spaceName = 'space-subagent';
    const spacePath = path.join(spacesDir, spaceName);
    fs.mkdirSync(spacePath, { recursive: true, mode: 0o700 });

    const daemon = new RuntimeDaemon({
      userId: 'alice',
      dshHome,
      spacesDir,
      contextWindow: 2000,
      maxTokens: 512,
    });

    await daemon.start();

    // 1. Initial background tasks list is empty
    const initTasks = await daemon.listBackgroundTasks(parentSessionId);
    expect(initTasks).toHaveLength(0);

    // 2. Simulate subagent/start lifecycle event
    const ctx = (daemon as any).bootedRuntime.context;
    ctx.emit('subagent/start', {
      id: childSessionId,
      runId: 'run-sa-001',
      provider: 'spawn',
      label: 'Synthetic Subagent Worker',
      parentSession: parentSessionId,
    });

    const runningTasks = await daemon.listBackgroundTasks(parentSessionId);
    expect(runningTasks).toHaveLength(1);
    expect(runningTasks[0].id).toBe(childSessionId);
    expect(runningTasks[0].kind).toBe('subagent');
    expect(runningTasks[0].name).toBe('Synthetic Subagent Worker');
    expect(runningTasks[0].status).toBe('running');
    expect(runningTasks[0].shortId.length).toBeGreaterThanOrEqual(4);
    expect(runningTasks[0].stalled).toBe(false);

    // 3. Stop background task via RPC
    const stopRes = await daemon.handleRequest({
      id: 'req-stop-sa',
      op: DAEMON_OPS.STOP_BACKGROUND_TASK,
      sessionId: parentSessionId,
      taskId: runningTasks[0].shortId,
    } as any);
    expect(stopRes.ok).toBe(true);
    expect((stopRes as any).stopped).toBe(true);

    const postStopTasks = await daemon.listBackgroundTasks(parentSessionId);
    expect(postStopTasks[0].status).toBe('cancelled');
    expect(postStopTasks[0].finishedAt).toBeDefined();

    await daemon.shutdown();
  });

  it('tracks workflow progress events (agentsTotal, agentsDone) and completion', async () => {
    const parentSessionId = 'ses_00000000000000000000000000000010';
    const workflowRunId = 'wf_00000000000000000000000000000099';

    const daemon = new RuntimeDaemon({
      userId: 'alice',
      dshHome,
      spacesDir,
      contextWindow: 2000,
      maxTokens: 512,
    });

    await daemon.start();
    const ctx = (daemon as any).bootedRuntime.context;

    // Simulate workflow/start lifecycle event
    ctx.emit('workflow/start', {
      runId: workflowRunId,
      parentSession: parentSessionId,
      meta: { name: 'synthetic-audit-pipeline' },
    });

    let tasks = await daemon.listBackgroundTasks(parentSessionId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].kind).toBe('workflow');
    expect(tasks[0].name).toBe('synthetic-audit-pipeline');
    expect(tasks[0].status).toBe('running');
    expect(tasks[0].progress?.agentsTotal).toBe(0);
    expect(tasks[0].progress?.agentsDone).toBe(0);

    // Simulate agent starts
    ctx.emit('workflow/agent-start', { runId: workflowRunId }, { seq: 1 });
    ctx.emit('workflow/agent-start', { runId: workflowRunId }, { seq: 2 });

    tasks = await daemon.listBackgroundTasks(parentSessionId);
    expect(tasks[0].progress?.agentsTotal).toBe(2);
    expect(tasks[0].progress?.agentsDone).toBe(0);

    // Simulate one agent ending
    ctx.emit('workflow/agent-end', { runId: workflowRunId }, { seq: 1, outcome: 'completed' });

    tasks = await daemon.listBackgroundTasks(parentSessionId);
    expect(tasks[0].progress?.agentsTotal).toBe(2);
    expect(tasks[0].progress?.agentsDone).toBe(1);

    // Simulate workflow end
    ctx.emit('workflow/end', { runId: workflowRunId }, { stopReason: 'completed' });

    const completedTasks = await daemon.listBackgroundTasks(parentSessionId);
    expect(completedTasks[0].status).toBe('completed');
    expect(completedTasks[0].finishedAt).toBeDefined();

    await daemon.shutdown();
  });

  it('marks tasks as stalled after 10 minutes of inactivity', async () => {
    const parentSessionId = 'ses_00000000000000000000000000000020';
    const childSessionId = 'ses_00000000000000000000000000000021';

    const daemon = new RuntimeDaemon({
      userId: 'alice',
      dshHome,
      spacesDir,
    });

    await daemon.start();
    const ctx = (daemon as any).bootedRuntime.context;

    ctx.emit('subagent/start', {
      id: childSessionId,
      runId: 'run-sa-stall',
      parentSession: parentSessionId,
      label: 'Stalled Worker',
    });

    // Manually backdate lastActivityAt to 15 minutes ago
    const tracker = (daemon as any).backgroundTasksTracker.get(childSessionId);
    expect(tracker).toBeDefined();
    tracker.lastActivityAt = new Date(Date.now() - 15 * 60 * 1000).toISOString();

    const tasks = await daemon.listBackgroundTasks(parentSessionId);
    expect(tasks[0].stalled).toBe(true);

    await daemon.shutdown();
  });

  it('retains completed tasks for 2 hours and prunes older ones', async () => {
    const parentSessionId = 'ses_00000000000000000000000000000030';
    const freshDoneId = 'ses_00000000000000000000000000000031';
    const expiredDoneId = 'ses_00000000000000000000000000000032';

    const daemon = new RuntimeDaemon({
      userId: 'alice',
      dshHome,
      spacesDir,
    });

    await daemon.start();
    const tracker = (daemon as any).backgroundTasksTracker;

    // Fresh finished task (30 min ago)
    tracker.set(freshDoneId, {
      id: freshDoneId,
      parentSessionId,
      kind: 'subagent',
      name: 'Fresh Finished Task',
      status: 'completed',
      startedAt: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
      finishedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      lastActivityAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });

    // Expired finished task (3 hours ago)
    tracker.set(expiredDoneId, {
      id: expiredDoneId,
      parentSessionId,
      kind: 'subagent',
      name: 'Expired Finished Task',
      status: 'completed',
      startedAt: new Date(Date.now() - 4 * 3600 * 1000).toISOString(),
      finishedAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
      lastActivityAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
    });

    const tasks = await daemon.listBackgroundTasks(parentSessionId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(freshDoneId);
    expect(tracker.has(expiredDoneId)).toBe(false); // Pruned

    await daemon.shutdown();
  });
});
