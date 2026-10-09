import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RuntimeDaemon } from '../src/runtime/daemon.js';
import { DAEMON_OPS } from '../src/runtime/daemon-protocol.js';

describe('RuntimeDaemon activity status RPC and diagnostics', () => {
  let tmpDir: string;
  let dshHome: string;
  let spacesDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-daemon-activity-test-'));
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

  it('reflects idle status when no turns or jobs are running', async () => {
    const daemon = new RuntimeDaemon({
      userId: 'alice',
      dshHome,
      spacesDir,
      contextWindow: 2000,
      maxTokens: 512,
    });

    await daemon.start();

    const status = await daemon.getStatus();
    expect(status.isIdle).toBe(true);
    expect(status.activeTurnsCount).toBe(0);
    expect(status.autonomousTurnsCount).toBe(0);
    expect(status.runningJobsCount).toBe(0);
    expect(status.liveSubagentsCount).toBe(0);
    expect(status.pendingInboxItemsCount).toBe(0);

    const rpcRes = await daemon.handleRequest({
      id: 'req-check-idle',
      op: DAEMON_OPS.ACTIVITY_STATUS,
    });
    expect(rpcRes.ok).toBe(true);
    if ('activity' in rpcRes) {
      expect(rpcRes.activity.isIdle).toBe(true);
    }
  });

  it('reflects an active autonomous continuation turn when triggered', async () => {
    const sessionId = 'ses_00000000000000000000000000000088';
    const spaceName = 'space-auto-turn';
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

    // Ensure session/agent exists in daemon
    const res1 = await daemon.submitTurnAndWait({
      id: 'req-init',
      op: 'submitTurn',
      turnId: 'turn_00000000000000000000000000000001',
      sessionId,
      prompt: 'Initial task prompt',
      workspaceFolder: spaceName,
    });
    expect(res1.status).toBe('completed');

    // Idle immediately after completed turn
    const idleStatus = await daemon.getStatus();
    expect(idleStatus.isIdle).toBe(true);
    expect(idleStatus.activeTurnsCount).toBe(0);

    // Simulate an autonomous continuation turn started by Cordis (e.g. from background workflow completion or wake)
    const ctx = (daemon as any).bootedRuntime.context;
    const session = (daemon as any).agents.get(sessionId).agent.session;
    ctx.emit('session/event', session, {
      type: 'turn/start',
      seq: 10,
      data: { turn: 2 },
    });

    // Daemon status must now reflect an active autonomous turn
    const busyStatus = await daemon.getStatus();
    expect(busyStatus.isIdle).toBe(false);
    expect(busyStatus.activeTurnsCount).toBe(1);
    expect(busyStatus.autonomousTurnsCount).toBe(1);
    expect(busyStatus.activeTurns[0].sessionId).toBe(sessionId);
    expect(busyStatus.activeTurns[0].autonomous).toBe(true);
    expect(busyStatus.activeTurns[0].turnNumber).toBe(2);
    expect(busyStatus.sessions[sessionId].activeTurn?.autonomous).toBe(true);

    // End autonomous turn
    ctx.emit('session/event', session, {
      type: 'turn/end',
      seq: 15,
      data: { turn: 2, reason: { kind: 'completed' } },
    });

    const settledStatus = await daemon.getStatus();
    expect(settledStatus.isIdle).toBe(true);
    expect(settledStatus.activeTurnsCount).toBe(0);
    expect(settledStatus.autonomousTurnsCount).toBe(0);
  });

  it('reflects running jobs including workflow jobs', async () => {
    const daemon = new RuntimeDaemon({
      userId: 'alice',
      dshHome,
      spacesDir,
      contextWindow: 2000,
      maxTokens: 512,
    });

    await daemon.start();

    const ctx = (daemon as any).bootedRuntime.context;

    // Provide mock job registry with a running workflow job and bash job
    const fakeJobs = [
      {
        id: 'job-workflow-101',
        kind: 'workflow',
        label: 'Autonomous Multi-Agent Workflow Execution',
        owner: 'ses_00000000000000000000000000000001',
        status: 'running',
        startedAt: Date.now() - 5000,
      },
      {
        id: 'job-bash-102',
        kind: 'bash',
        label: 'Background test task',
        owner: 'ses_00000000000000000000000000000001',
        status: 'running',
        startedAt: Date.now() - 2000,
      },
    ];

    ctx.provide('jobs', {
      list: () => fakeJobs,
    });

    const status = await daemon.getStatus();
    expect(status.isIdle).toBe(false);
    expect(status.runningJobsCount).toBe(2);
    expect(status.runningWorkflowJobsCount).toBe(1);
    expect(status.runningJobs.map((j) => j.id)).toContain('job-workflow-101');
    expect(status.runningJobs.map((j) => j.id)).toContain('job-bash-102');

    // Verify over RPC
    const rpcRes = await daemon.handleRequest({
      id: 'req-check-jobs',
      op: 'activityStatus',
    });
    expect(rpcRes.ok).toBe(true);
    if ('activity' in rpcRes) {
      expect(rpcRes.activity.isIdle).toBe(false);
      expect(rpcRes.activity.runningJobsCount).toBe(2);
      expect(rpcRes.activity.runningWorkflowJobsCount).toBe(1);
    }
  });

  it('reflects live background subagents', async () => {
    const daemon = new RuntimeDaemon({
      userId: 'alice',
      dshHome,
      spacesDir,
      contextWindow: 2000,
      maxTokens: 512,
    });

    await daemon.start();
    const ctx = (daemon as any).bootedRuntime.context;

    // Simulate subagent start event
    ctx.emit('subagent/start', {
      id: 'subagent_run_999',
      provider: 'spawn',
      sessionId: 'ses_child_001',
      parentSession: 'ses_parent_001',
    });

    const status = await daemon.getStatus();
    expect(status.isIdle).toBe(false);
    expect(status.liveSubagentsCount).toBe(1);
    expect(status.liveSubagents[0].id).toBe('subagent_run_999');

    // Simulate subagent end event
    ctx.emit('subagent/end', {
      id: 'subagent_run_999',
    });

    const statusAfter = await daemon.getStatus();
    expect(statusAfter.isIdle).toBe(true);
    expect(statusAfter.liveSubagentsCount).toBe(0);
  });

  it('reflects pending inbox items per session', async () => {
    const sessionId = 'ses_00000000000000000000000000000077';
    const spaceName = 'space-inbox-test';
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

    // Create session / agent in daemon
    await daemon.submitTurnAndWait({
      id: 'req-init',
      op: 'submitTurn',
      turnId: 'turn_00000000000000000000000000000001',
      sessionId,
      prompt: 'Initial task prompt',
      workspaceFolder: spaceName,
    });

    const agent = (daemon as any).agents.get(sessionId).agent;
    // Add pending message to inbox
    agent.inbox.splice('next-turn', 0, 0, [
      { id: 'msg-pending-1', role: 'user', content: [{ type: 'text', text: 'Queued turn prompt' }] },
    ]);

    const status = await daemon.getStatus();
    expect(status.isIdle).toBe(false);
    expect(status.pendingInboxItemsCount).toBe(1);
    expect(status.sessions[sessionId].pendingInboxItemsCount).toBe(1);
    expect(status.sessions[sessionId].pendingNextTurnCount).toBe(1);

    // Clear inbox
    agent.inbox.clear();
    const statusClean = await daemon.getStatus();
    expect(statusClean.isIdle).toBe(true);

    await daemon.shutdown();
  });

  it('P-02 / A-04: aggregates background jobs across caller sessions in getActivityStatus', async () => {
    const parentSessionId = 'ses_00000000000000000000000000000088';
    const jobId = 'job_workflow_0000000000000001';

    const daemon = new RuntimeDaemon({
      userId: 'alice',
      dshHome,
      spacesDir,
    });

    await daemon.start();
    const ctx = (daemon as any).bootedRuntime.context;

    // Track a known session
    (daemon as any).agents.set(parentSessionId, { sessionId: parentSessionId });

    // Mock jobs service where list(caller) only returns jobs when caller === parentSessionId
    const mockJobsService = {
      list: vi.fn((caller?: any) => {
        if (caller === parentSessionId) {
          return [
            {
              id: jobId,
              kind: 'workflow',
              label: 'distributed-analysis-workflow',
              status: 'running',
              owner: parentSessionId,
              startedAt: Date.now() - 10000,
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

    const status = await daemon.getStatus();
    expect(status.isIdle).toBe(false);
    expect(status.runningJobsCount).toBe(1);
    expect(status.runningWorkflowJobsCount).toBe(1);
    expect(status.runningJobs[0].id).toBe(jobId);

    await daemon.shutdown();
  });

  it('P-02: dormant/idle continuable subagents in agent registry are NOT counted as active', async () => {
    const childSessionId = 'ses_subagent_idle_00000001';

    const daemon = new RuntimeDaemon({
      userId: 'alice',
      dshHome,
      spacesDir,
    });

    await daemon.start();
    const ctx = (daemon as any).bootedRuntime.context;

    // Mock agent registry with an idle continuable subagent
    const idleSubagent = {
      id: childSessionId,
      status: 'idle',
      session: {
        header: {
          origin: 'subagent',
          parentSession: 'ses_parent_0001',
          createdAt: Date.now() - 60000,
        },
      },
    };
    const mockAgentRegistry = {
      list: () => [idleSubagent],
      get: (id: any) => (id === childSessionId ? idleSubagent : undefined),
    };
    ctx.get = (name: string) => {
      if (name === 'agents') return mockAgentRegistry;
      return undefined;
    };

    const status = await daemon.getStatus();
    // Idle subagent must NOT be counted into liveSubagents
    expect(status.liveSubagentsCount).toBe(0);
    expect(status.isIdle).toBe(true);

    // If the subagent changes status to running, it IS counted
    (idleSubagent as any).status = 'running';
    const busyStatus = await daemon.getStatus();
    expect(busyStatus.liveSubagentsCount).toBe(1);
    expect(busyStatus.isIdle).toBe(false);

    await daemon.shutdown();
  });
});
