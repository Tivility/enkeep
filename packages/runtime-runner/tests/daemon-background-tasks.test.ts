import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scopeTarget } from '@deepseek-ai/dsh-scope';
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

  it('determines parent of subagent using DSH 0.2 listener context (carrierKeyOf / scopeTarget) with payload identity only', async () => {
    const parentSessionId = 'ses_00000000000000000000000000000005';
    const childSessionId = 'ses_00000000000000000000000000000006';

    const daemon = new RuntimeDaemon({
      userId: 'alice',
      dshHome,
      spacesDir,
      contextWindow: 2000,
      maxTokens: 512,
    });

    await daemon.start();
    const ctx = (daemon as any).bootedRuntime.context;

    // DSH 0.2 event shape: payload has { runId, provider, id, local } (no parentSession field in payload)
    // and parent is passed in scope carrier
    const parentAgentStub = {
      id: parentSessionId,
      session: { id: parentSessionId },
    };
    const carrier = scopeTarget(ctx.subagents || {}, parentAgentStub as any);

    // Emit subagent/start with carrier as `this`
    ctx.emit(carrier, 'subagent/start', {
      runId: 'run-dsh02-001',
      provider: 'spawn',
      id: childSessionId,
      local: true,
    });

    const tasks = await daemon.listBackgroundTasks(parentSessionId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(childSessionId);
    expect(tasks[0].kind).toBe('subagent');
    expect(tasks[0].status).toBe('running');

    // Emit subagent/end with carrier
    ctx.emit(carrier, 'subagent/end', {
      runId: 'run-dsh02-001',
      provider: 'spawn',
      id: childSessionId,
      local: true,
      stopReason: 'completed',
    });

    await daemon.shutdown();
  });

  it('indexes and lists continuable background subagents with step count and lastActivityAt from session events', async () => {
    const parentSessionId = 'ses_00000000000000000000000000000040';
    const childSessionId = 'ses_00000000000000000000000000000041';

    const daemon = new RuntimeDaemon({
      userId: 'alice',
      dshHome,
      spacesDir,
      contextWindow: 2000,
      maxTokens: 512,
    });

    await daemon.start();
    const ctx = (daemon as any).bootedRuntime.context;

    const parentAgentStub = {
      id: parentSessionId,
      session: { id: parentSessionId },
    };
    const carrier = scopeTarget(ctx.subagents || {}, parentAgentStub as any);

    // Emit start with DSH 0.2 payload
    ctx.emit(carrier, 'subagent/start', {
      runId: 'run-bg-sub-001',
      provider: 'spawn',
      id: childSessionId,
      local: true,
    });

    // Simulate session events on child session: descriptor event and multiple step/start events
    const childSessionStub = {
      id: childSessionId,
      header: {
        id: childSessionId,
        origin: 'subagent',
        parentSession: parentSessionId,
        createdAt: Date.now() - 5000,
      },
      events: [] as any[],
      snapshotEvents() {
        return this.events;
      },
      eventAt(seq: number) {
        return this.events.find((e: any) => e.seq === seq);
      },
    };

    const ev1 = {
      type: 'subagent/descriptor',
      seq: 0,
      time: Date.now() - 4000,
      data: {
        version: 3,
        mode: 'continuable',
        provider: 'spawn',
        label: 'Background Analysis Worker',
      },
    };
    childSessionStub.events.push(ev1);
    ctx.emit('session/event', childSessionStub, ev1);

    const ev2 = {
      type: 'step/start',
      seq: 1,
      time: Date.now() - 3000,
      data: { turn: 1, step: 1 },
    };
    childSessionStub.events.push(ev2);
    ctx.emit('session/event', childSessionStub, ev2);

    const ev3 = {
      type: 'step/start',
      seq: 2,
      time: Date.now() - 1000,
      data: { turn: 1, step: 2 },
    };
    childSessionStub.events.push(ev3);
    ctx.emit('session/event', childSessionStub, ev3);

    const tasks = await daemon.listBackgroundTasks(parentSessionId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(childSessionId);
    expect(tasks[0].name).toBe('Background Analysis Worker');
    expect(tasks[0].progress?.step).toBe(2);
    expect(tasks[0].status).toBe('running');

    // Emit subagent/end (epoch settlement)
    ctx.emit(carrier, 'subagent/end', {
      runId: 'run-bg-sub-001',
      provider: 'spawn',
      id: childSessionId,
      local: true,
      stopReason: 'completed',
    });

    // Continuable background subagent remains in list after completion (2h retention)
    const postEndTasks = await daemon.listBackgroundTasks(parentSessionId);
    expect(postEndTasks).toHaveLength(1);
    expect(postEndTasks[0].status).toBe('completed');
    expect(postEndTasks[0].progress?.step).toBe(2);

    await daemon.shutdown();
  });

  it('excludes finished foreground one-shot subagents while keeping running one-shots and continuable background subagents', async () => {
    const parentSessionId = 'ses_00000000000000000000000000000050';
    const fgChildSessionId = 'ses_00000000000000000000000000000051';
    const bgChildSessionId = 'ses_00000000000000000000000000000052';

    const daemon = new RuntimeDaemon({
      userId: 'alice',
      dshHome,
      spacesDir,
      contextWindow: 2000,
      maxTokens: 512,
    });

    await daemon.start();
    const ctx = (daemon as any).bootedRuntime.context;

    const parentAgentStub = {
      id: parentSessionId,
      session: { id: parentSessionId },
    };
    const carrier = scopeTarget(ctx.subagents || {}, parentAgentStub as any);

    // 1. Start foreground one-shot child
    ctx.emit(carrier, 'subagent/start', {
      runId: 'run-fg-001',
      provider: 'spawn',
      id: fgChildSessionId,
      local: true,
    });

    const fgSessionStub = {
      id: fgChildSessionId,
      header: { id: fgChildSessionId, origin: 'subagent', parentSession: parentSessionId },
      events: [] as any[],
      snapshotEvents() {
        return this.events;
      },
      eventAt(seq: number) {
        return this.events.find((e: any) => e.seq === seq);
      },
    };
    const fgDesc = {
      type: 'subagent/descriptor',
      seq: 0,
      time: Date.now() - 2000,
      data: {
        version: 3,
        mode: 'one-shot',
        provider: 'spawn',
        label: 'Foreground One-Shot Task',
      },
    };
    fgSessionStub.events.push(fgDesc);
    ctx.emit('session/event', fgSessionStub, fgDesc);

    // 2. Start background continuable child
    ctx.emit(carrier, 'subagent/start', {
      runId: 'run-bg-001',
      provider: 'spawn',
      id: bgChildSessionId,
      local: true,
    });

    const bgSessionStub = {
      id: bgChildSessionId,
      header: { id: bgChildSessionId, origin: 'subagent', parentSession: parentSessionId },
      events: [] as any[],
      snapshotEvents() {
        return this.events;
      },
      eventAt(seq: number) {
        return this.events.find((e: any) => e.seq === seq);
      },
    };
    const bgDesc = {
      type: 'subagent/descriptor',
      seq: 0,
      time: Date.now() - 1000,
      data: {
        version: 3,
        mode: 'continuable',
        provider: 'spawn',
        label: 'Background Long-Running Task',
      },
    };
    bgSessionStub.events.push(bgDesc);
    ctx.emit('session/event', bgSessionStub, bgDesc);

    // Both are running -> both in background task list
    let tasks = await daemon.listBackgroundTasks(parentSessionId);
    expect(tasks).toHaveLength(2);

    // Foreground one-shot finishes
    ctx.emit(carrier, 'subagent/end', {
      runId: 'run-fg-001',
      provider: 'spawn',
      id: fgChildSessionId,
      local: true,
      stopReason: 'completed',
    });

    // After foreground one-shot finishes, it must be excluded; background continuable is kept
    tasks = await daemon.listBackgroundTasks(parentSessionId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(bgChildSessionId);
    expect(tasks[0].name).toBe('Background Long-Running Task');

    await daemon.shutdown();
  });

  it('discovers subagents via sessionQuery and ctx.subagents.listChildren lineage', async () => {
    const parentSessionId = 'ses_00000000000000000000000000000060';
    const subagentSessionId = 'ses_00000000000000000000000000000061';

    const daemon = new RuntimeDaemon({
      userId: 'alice',
      dshHome,
      spacesDir,
      contextWindow: 2000,
      maxTokens: 512,
    });

    await daemon.start();
    const ctx = (daemon as any).bootedRuntime.context;

    // Mock subagents.listChildren to return a continuable subagent child
    const subagentsService = ctx.get('subagents');
    if (subagentsService) {
      subagentsService.listChildren = async (parentSid: any) => {
        if (String(parentSid) === parentSessionId) {
          return [
            {
              id: subagentSessionId,
              createdAt: Date.now() - 10000,
              mode: 'continuable',
              label: 'Lineage Discovered Worker',
            },
          ];
        }
        return [];
      };
    }

    const tasks = await daemon.listBackgroundTasks(parentSessionId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(subagentSessionId);
    expect(tasks[0].name).toBe('Lineage Discovered Worker');
    expect(tasks[0].kind).toBe('subagent');

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

    const sessionStub = {
      id: parentSessionId,
      header: { id: parentSessionId },
      events: [] as any[],
      snapshotEvents() {
        return this.events;
      },
      eventAt(seq: number) {
        return this.events.find((e: any) => e.seq === seq);
      },
    };

    // Simulate agent starts via session event tool-workflow/agent-start
    const evStart1 = {
      seq: 0,
      type: 'tool-workflow/agent-start',
      data: { runId: workflowRunId },
    };
    sessionStub.events.push(evStart1);
    ctx.emit('session/event', sessionStub, evStart1);

    const evStart2 = {
      seq: 1,
      type: 'tool-workflow/agent-start',
      data: { runId: workflowRunId },
    };
    sessionStub.events.push(evStart2);
    ctx.emit('session/event', sessionStub, evStart2);

    tasks = await daemon.listBackgroundTasks(parentSessionId);
    expect(tasks[0].progress?.agentsTotal).toBe(2);
    expect(tasks[0].progress?.agentsDone).toBe(0);

    // Simulate one agent ending via session event tool-workflow/agent-end
    const evEnd1 = {
      seq: 2,
      type: 'tool-workflow/agent-end',
      data: { runId: workflowRunId, outcome: 'completed' },
    };
    sessionStub.events.push(evEnd1);
    ctx.emit('session/event', sessionStub, evEnd1);

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

  it('preserves cancelled status when subagent/end fires after stopBackgroundTask', async () => {
    const parentSessionId = 'ses_00000000000000000000000000000070';
    const childSessionId = 'ses_00000000000000000000000000000071';

    const daemon = new RuntimeDaemon({
      userId: 'alice',
      dshHome,
      spacesDir,
    });

    await daemon.start();
    const ctx = (daemon as any).bootedRuntime.context;

    const parentAgentStub = {
      id: parentSessionId,
      session: { id: parentSessionId },
    };
    const carrier = scopeTarget(ctx.subagents || {}, parentAgentStub as any);

    // 1. Subagent starts
    ctx.emit(carrier, 'subagent/start', {
      runId: 'run-stop-sa-001',
      provider: 'spawn',
      id: childSessionId,
      local: true,
      label: 'Synthetic Worker to Stop',
    });

    const tasksBefore = await daemon.listBackgroundTasks(parentSessionId);
    expect(tasksBefore).toHaveLength(1);
    expect(tasksBefore[0].status).toBe('running');

    // 2. User stops subagent via stopBackgroundTask
    const stopResult = await daemon.stopBackgroundTask(parentSessionId, tasksBefore[0].shortId);
    expect(stopResult.stopped).toBe(true);

    const tasksAfterStop = await daemon.listBackgroundTasks(parentSessionId);
    expect(tasksAfterStop[0].status).toBe('cancelled');

    // 3. Subagent process terminates and emits subagent/end (DSH 0.2 may emit aborted, completed, or no stopReason)
    ctx.emit(carrier, 'subagent/end', {
      runId: 'run-stop-sa-001',
      provider: 'spawn',
      id: childSessionId,
      local: true,
      stopReason: 'completed', // e.g. daemon maps every subagent/end to completed bug reproduction
    });

    const tasksAfterEnd = await daemon.listBackgroundTasks(parentSessionId);
    expect(tasksAfterEnd[0].status).toBe('cancelled');
    expect(tasksAfterEnd[0].finishedAt).toBeDefined();

    await daemon.shutdown();
  });

  it('maps DSH 0.2 subagent stopReasons correctly: aborted/interrupted/cancelled -> cancelled, error/failed -> failed', async () => {
    const parentSessionId = 'ses_00000000000000000000000000000080';
    const childAbortedId = 'ses_00000000000000000000000000000081';
    const childErrorId = 'ses_00000000000000000000000000000082';
    const childCompletedId = 'ses_00000000000000000000000000000083';

    const daemon = new RuntimeDaemon({
      userId: 'alice',
      dshHome,
      spacesDir,
    });

    await daemon.start();
    const ctx = (daemon as any).bootedRuntime.context;

    const parentAgentStub = {
      id: parentSessionId,
      session: { id: parentSessionId },
    };
    const carrier = scopeTarget(ctx.subagents || {}, parentAgentStub as any);

    // 1. Aborted subagent
    ctx.emit(carrier, 'subagent/start', {
      runId: 'run-abort-001',
      provider: 'spawn',
      id: childAbortedId,
      local: true,
      label: 'Aborted Worker',
    });
    ctx.emit(carrier, 'subagent/end', {
      runId: 'run-abort-001',
      provider: 'spawn',
      id: childAbortedId,
      local: true,
      stopReason: 'aborted',
    });

    // 2. Errored subagent
    ctx.emit(carrier, 'subagent/start', {
      runId: 'run-err-001',
      provider: 'spawn',
      id: childErrorId,
      local: true,
      label: 'Error Worker',
    });
    ctx.emit(carrier, 'subagent/end', {
      runId: 'run-err-001',
      provider: 'spawn',
      id: childErrorId,
      local: true,
      stopReason: 'error',
    });

    // 3. Completed subagent
    ctx.emit(carrier, 'subagent/start', {
      runId: 'run-comp-001',
      provider: 'spawn',
      id: childCompletedId,
      local: true,
      label: 'Completed Worker',
    });
    ctx.emit(carrier, 'subagent/end', {
      runId: 'run-comp-001',
      provider: 'spawn',
      id: childCompletedId,
      local: true,
      stopReason: 'completed',
    });

    const tasks = await daemon.listBackgroundTasks(parentSessionId);
    const abortedTask = tasks.find((t) => t.id === childAbortedId);
    const errorTask = tasks.find((t) => t.id === childErrorId);
    const completedTask = tasks.find((t) => t.id === childCompletedId);

    expect(abortedTask?.status).toBe('cancelled');
    expect(errorTask?.status).toBe('failed');
    expect(completedTask?.status).toBe('completed');

    await daemon.shutdown();
  });

  it('maps workflow jobs stopped via stopBackgroundTask or killed to cancelled and errors to failed', async () => {
    const parentSessionId = 'ses_00000000000000000000000000000090';
    const wfKilledRunId = 'wf_00000000000000000000000000000091';
    const wfFailedRunId = 'wf_00000000000000000000000000000092';

    const daemon = new RuntimeDaemon({
      userId: 'alice',
      dshHome,
      spacesDir,
    });

    await daemon.start();
    const ctx = (daemon as any).bootedRuntime.context;

    // 1. Workflow stopped via stopBackgroundTask
    ctx.emit('workflow/start', {
      runId: wfKilledRunId,
      parentSession: parentSessionId,
      meta: { name: 'workflow-to-kill' },
    });

    const tasksBefore = await daemon.listBackgroundTasks(parentSessionId);
    const wfTask = tasksBefore.find((t) => t.id === wfKilledRunId);
    expect(wfTask?.status).toBe('running');

    await daemon.stopBackgroundTask(parentSessionId, wfTask!.shortId);

    // Later workflow/end fires with completed or killed
    ctx.emit('workflow/end', { runId: wfKilledRunId }, { stopReason: 'completed' });

    // 2. Workflow failing with error
    ctx.emit('workflow/start', {
      runId: wfFailedRunId,
      parentSession: parentSessionId,
      meta: { name: 'workflow-failing' },
    });
    ctx.emit('workflow/end', { runId: wfFailedRunId }, { stopReason: 'failed' });

    const tasksAfter = await daemon.listBackgroundTasks(parentSessionId);
    const killedTask = tasksAfter.find((t) => t.id === wfKilledRunId);
    const failedTask = tasksAfter.find((t) => t.id === wfFailedRunId);

    expect(killedTask?.status).toBe('cancelled');
    expect(failedTask?.status).toBe('failed');

    await daemon.shutdown();
  });

  it('A-03: single subagent start and end event results in exactly 1 agentsTotal and 1 agentsDone', async () => {
    const parentSessionId = 'ses_00000000000000000000000000000095';
    const workflowRunId = 'wf_00000000000000000000000000000096';

    const daemon = new RuntimeDaemon({
      userId: 'alice',
      dshHome,
      spacesDir,
    });

    await daemon.start();
    const ctx = (daemon as any).bootedRuntime.context;

    ctx.emit('workflow/start', {
      runId: workflowRunId,
      parentSession: parentSessionId,
      meta: { name: 'single-agent-counting' },
    });

    const sessionStub = {
      id: parentSessionId,
      header: { id: parentSessionId },
      events: [] as any[],
      snapshotEvents() { return this.events; },
      eventAt(seq: number) { return this.events.find((e: any) => e.seq === seq); },
    };

    const evStart = {
      seq: 0,
      type: 'tool-workflow/agent-start',
      data: { runId: workflowRunId },
    };
    sessionStub.events.push(evStart);
    ctx.emit('session/event', sessionStub, evStart);

    // Also emit legacy global workflow/agent-start to verify daemon does not double count
    ctx.emit('workflow/agent-start', { runId: workflowRunId });

    let tasks = await daemon.listBackgroundTasks(parentSessionId);
    expect(tasks[0].progress?.agentsTotal).toBe(1);
    expect(tasks[0].progress?.agentsDone).toBe(0);

    const evEnd = {
      seq: 1,
      type: 'tool-workflow/agent-end',
      data: { runId: workflowRunId, outcome: 'completed' },
    };
    sessionStub.events.push(evEnd);
    ctx.emit('session/event', sessionStub, evEnd);

    // Also emit legacy global workflow/agent-end to verify daemon does not double count
    ctx.emit('workflow/agent-end', { runId: workflowRunId });

    tasks = await daemon.listBackgroundTasks(parentSessionId);
    expect(tasks[0].progress?.agentsTotal).toBe(1);
    expect(tasks[0].progress?.agentsDone).toBe(1);

    await daemon.shutdown();
  });

  it('A-04: listBackgroundTasks lists session jobs when caller === sessionId is required', async () => {
    const parentSessionId = 'ses_00000000000000000000000000000097';
    const jobId = 'job_00000000000000000000000000000098';

    const daemon = new RuntimeDaemon({
      userId: 'alice',
      dshHome,
      spacesDir,
    });

    await daemon.start();
    const ctx = (daemon as any).bootedRuntime.context;

    // Mock jobs registry with owner filtering matching DSH jobs-local contract
    const mockJobsService = {
      list: vi.fn((caller?: any) => {
        if (caller === parentSessionId) {
          return [
            {
              id: jobId,
              kind: 'job',
              label: 'session-owned-backup-job',
              status: 'running',
              owner: parentSessionId,
              startedAt: Date.now() - 5000,
            },
          ];
        }
        return [];
      }),
    };
    ctx.get = (name: string) => {
      if (name === 'jobs') return mockJobsService;
      return undefined;
    };

    const tasks = await daemon.listBackgroundTasks(parentSessionId);
    expect(mockJobsService.list).toHaveBeenCalledWith(parentSessionId);
    expect(tasks.some((t) => t.id === jobId)).toBe(true);

    await daemon.shutdown();
  });

  it('A-05: stopBackgroundTask returns stopped: false when underlying interrupt throws or fails', async () => {
    const parentSessionId = 'ses_00000000000000000000000000000099';
    const childSessionId = 'ses_00000000000000000000000000000100';

    const daemon = new RuntimeDaemon({
      userId: 'alice',
      dshHome,
      spacesDir,
    });

    await daemon.start();
    const ctx = (daemon as any).bootedRuntime.context;

    // Track a running task in tracker
    const parentAgentStub = { id: parentSessionId, session: { id: parentSessionId } };
    const carrier = scopeTarget(ctx.subagents || {}, parentAgentStub as any);
    ctx.emit(carrier, 'subagent/start', {
      runId: 'run-stop-fail-001',
      provider: 'spawn',
      id: childSessionId,
      local: true,
      label: 'Worker failing to stop',
    });

    // Mock subagents service to throw on interrupt
    const subagentsService = ctx.get('subagents');
    if (subagentsService) {
      subagentsService.interrupt = () => {
        throw new Error('Process lock error');
      };
    }

    const tasksBefore = await daemon.listBackgroundTasks(parentSessionId);
    expect(tasksBefore[0].status).toBe('running');

    const stopRes = await daemon.stopBackgroundTask(parentSessionId, tasksBefore[0].shortId);
    expect(stopRes.stopped).toBe(false);

    const tasksAfter = await daemon.listBackgroundTasks(parentSessionId);
    expect(tasksAfter[0].status).toBe('running');

    await daemon.shutdown();
  });

  it('lists tasks without waiting for a slow persisted-session scan', async () => {
    const parentSessionId = 'ses_00000000000000000000000000000031';
    const daemon = new RuntimeDaemon({ userId: 'alice', dshHome, spacesDir, contextWindow: 2000, maxTokens: 512 });
    await daemon.start();
    const ctx = (daemon as any).bootedRuntime.context;

    // A session-query service whose full listing takes far longer than any RPC budget.
    let releaseScan: () => void = () => {};
    const slowScan = new Promise<void>((resolve) => { releaseScan = resolve; });
    const historicalChild = 'ses_00000000000000000000000000000032';
    const fakeQuery = {
      listSessions: vi.fn(async () => {
        await slowScan;
        return [{ header: { id: historicalChild, origin: 'subagent', parentSession: parentSessionId, createdAt: Date.now() } }];
      }),
      readSession: vi.fn(async () => { throw new Error('must not read persisted logs on the listing path'); }),
    };
    const realGet = ctx.get.bind(ctx);
    const getSpy = vi.spyOn(ctx, 'get').mockImplementation((name: any) => (name === 'sessionQuery' ? fakeQuery : realGet(name)));

    ctx.emit('subagent/start', { id: 'ses_00000000000000000000000000000033', runId: 'run-live', provider: 'spawn', label: 'Live Worker', parentSession: parentSessionId });

    const started = Date.now();
    const first = await daemon.listBackgroundTasks(parentSessionId);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(first.map((t) => t.id)).toEqual(['ses_00000000000000000000000000000033']);
    expect(fakeQuery.readSession).not.toHaveBeenCalled();

    // Once the background scan completes, its lineage is used by later listings.
    releaseScan();
    await (daemon as any).subagentLineageRefresh;
    const second = await daemon.listBackgroundTasks(parentSessionId);
    expect(second.map((t) => t.id).sort()).toEqual([historicalChild, 'ses_00000000000000000000000000000033'].sort());
    expect(fakeQuery.listSessions).toHaveBeenCalledTimes(1);

    getSpy.mockRestore();
    await daemon.shutdown();
  });
});
