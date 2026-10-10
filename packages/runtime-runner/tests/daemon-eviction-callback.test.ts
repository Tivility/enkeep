/**
 * Synthetic tests for:
 * (1) sweepIdleAgents busy check & lastUsed refresh (autonomous turn, running workflow/job, live subagent)
 * (2) host / docker idleAgentTimeoutMs configuration passing from platform env
 * (3) background workflow/subagent abnormal termination callback to parent agent with dedup
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RuntimeDaemon } from '../src/runtime/daemon.js';
import { DaemonSettlementJournal } from '../src/runtime/daemon-settlement-journal.js';
import { HostRuntimeAdapter } from '../src/host/adapter.js';
import { DockerRuntimeAdapter } from '../src/docker/adapter.js';

describe('Daemon Eviction and Abnormal Termination Callback Tests', () => {
  let tmpDir: string;
  let dshHome: string;
  let spacesDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-evict-cb-test-'));
    dshHome = path.join(tmpDir, '.dsh');
    spacesDir = path.join(tmpDir, 'spaces');
    fs.mkdirSync(dshHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spacesDir, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
    delete process.env.DSH_IDLE_AGENT_TIMEOUT_MS;
    delete process.env.ENKEEP_EXECUTION_BUDGET_MS;
  });

  describe('(1) sweepIdleAgents busy checks and lastUsed refresh', () => {
    it('does NOT evict session when background workflow is running and refreshes lastUsed', async () => {
      const daemon = new RuntimeDaemon({
        userId: 'alice-synth',
        dshHome,
        spacesDir,
        idleAgentTimeoutMs: 50, // Short 50ms timeout
      });

      const parentSid = 'ses_00000000000000000000000000000001';
      const fakeEntry: any = {
        sessionId: parentSid,
        status: 'idle',
        lastUsed: Date.now() - 1000, // 1s ago, normally would be evicted
        currentTurn: undefined,
        agent: { session: { seq: 1 } },
        agentHandle: { dispose: vi.fn() },
        sessionLock: { release: vi.fn() },
      };

      (daemon as any).agents.set(parentSid, fakeEntry);

      // Register running workflow in backgroundTasksTracker
      (daemon as any).backgroundTasksTracker.set('wf_run_01', {
        id: 'wf_run_01',
        parentSessionId: parentSid,
        kind: 'workflow',
        name: 'test-wf',
        status: 'running',
        startedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
      });

      const initialLastUsed = fakeEntry.lastUsed;
      await (daemon as any).sweepIdleAgents();

      // Session must NOT be evicted and lastUsed should be refreshed
      expect((daemon as any).agents.has(parentSid)).toBe(true);
      expect(fakeEntry.lastUsed).toBeGreaterThan(initialLastUsed);
      expect(fakeEntry.agentHandle.dispose).not.toHaveBeenCalled();

      // Mark workflow as completed
      (daemon as any).backgroundTasksTracker.get('wf_run_01')!.status = 'completed';
      fakeEntry.lastUsed = Date.now() - 100; // Expired again

      await (daemon as any).sweepIdleAgents();

      // Now with no active tasks, it must be evicted
      expect((daemon as any).agents.has(parentSid)).toBe(false);
      expect(fakeEntry.agentHandle.dispose).toHaveBeenCalled();
    });

    it('does NOT evict session when autonomous turn is in flight', async () => {
      const daemon = new RuntimeDaemon({
        userId: 'alice-synth',
        dshHome,
        spacesDir,
        idleAgentTimeoutMs: 50,
      });

      const parentSid = 'ses_00000000000000000000000000000002';
      const fakeEntry: any = {
        sessionId: parentSid,
        status: 'idle',
        lastUsed: Date.now() - 1000,
        currentTurn: undefined,
        agent: { session: { seq: 1 } },
        agentHandle: { dispose: vi.fn() },
        sessionLock: { release: vi.fn() },
      };

      (daemon as any).agents.set(parentSid, fakeEntry);
      (daemon as any).autonomousTurnsTracker.set(parentSid, {
        sessionId: parentSid,
        turnNumber: 2,
        startedAt: Date.now(),
      });

      await (daemon as any).sweepIdleAgents();
      expect((daemon as any).agents.has(parentSid)).toBe(true);

      (daemon as any).autonomousTurnsTracker.delete(parentSid);
      fakeEntry.lastUsed = Date.now() - 100;

      await (daemon as any).sweepIdleAgents();
      expect((daemon as any).agents.has(parentSid)).toBe(false);
    });

    it('does NOT evict session when live child subagent is running', async () => {
      const daemon = new RuntimeDaemon({
        userId: 'alice-synth',
        dshHome,
        spacesDir,
        idleAgentTimeoutMs: 50,
      });

      const parentSid = 'ses_00000000000000000000000000000003';
      const fakeEntry: any = {
        sessionId: parentSid,
        status: 'idle',
        lastUsed: Date.now() - 1000,
        currentTurn: undefined,
        agent: { session: { seq: 1 } },
        agentHandle: { dispose: vi.fn() },
        sessionLock: { release: vi.fn() },
      };

      (daemon as any).agents.set(parentSid, fakeEntry);
      (daemon as any).liveSubagentsTracker.set('sub_01', {
        id: 'sub_01',
        parentSession: parentSid,
        startedAt: Date.now(),
      });

      await (daemon as any).sweepIdleAgents();
      expect((daemon as any).agents.has(parentSid)).toBe(true);

      (daemon as any).liveSubagentsTracker.delete('sub_01');
      fakeEntry.lastUsed = Date.now() - 100;

      await (daemon as any).sweepIdleAgents();
      expect((daemon as any).agents.has(parentSid)).toBe(false);
    });
  });

  describe('(2) Platform idleAgentTimeoutMs config passing', () => {
    it('HostRuntimeAdapter sets DSH_IDLE_AGENT_TIMEOUT_MS to configured platform value', () => {
      const adapter = new HostRuntimeAdapter();
      const spec = adapter.createDefaultUserSpec({
        userId: 'alice-synth',
        dataRoot: tmpDir,
        idleAgentTimeoutMs: 172800000,
      });

      expect(spec.idleAgentTimeoutMs).toBe(172800000);
    });

    it('DockerRuntimeAdapter injects DSH_IDLE_AGENT_TIMEOUT_MS into container environment', () => {
      const adapter = new DockerRuntimeAdapter();
      const spec = adapter.createDefaultUserSpec({
        userId: 'alice-synth',
        idleAgentTimeoutMs: 172800000,
      });

      expect(spec.environment.DSH_IDLE_AGENT_TIMEOUT_MS).toBe('172800000');
    });

    it('DockerRuntimeAdapter falls back to process.env.ENKEEP_EXECUTION_BUDGET_MS', () => {
      process.env.ENKEEP_EXECUTION_BUDGET_MS = '172800000';
      const adapter = new DockerRuntimeAdapter();
      const spec = adapter.createDefaultUserSpec({
        userId: 'alice-synth',
      });

      expect(spec.environment.DSH_IDLE_AGENT_TIMEOUT_MS).toBe('172800000');
    });
  });

  describe('(3) Abnormal termination callback to parent session with dedup', () => {
    it('DaemonSettlementJournal records and dedups notified settlements across restarts', () => {
      const journal1 = new DaemonSettlementJournal(dshHome);
      expect(journal1.isNotified('task_abnormal_01')).toBe(false);

      journal1.recordNotified({
        taskId: 'task_abnormal_01',
        parentSessionId: 'ses_00000000000000000000000000000001',
        kind: 'workflow',
        status: 'failed',
        reason: 'process terminated unexpectedly',
        notifiedAt: new Date().toISOString(),
      });

      expect(journal1.isNotified('task_abnormal_01')).toBe(true);

      // Re-instantiate journal (simulating process restart)
      const journal2 = new DaemonSettlementJournal(dshHome);
      expect(journal2.isNotified('task_abnormal_01')).toBe(true);
    });

    it('dispatches anomaly callback when workflow fails and native notice is absent', async () => {
      vi.useFakeTimers();
      const daemon = new RuntimeDaemon({
        userId: 'alice-synth',
        dshHome,
        spacesDir,
      });

      const parentSid = 'ses_00000000000000000000000000000005';
      const followupMock = vi.fn();
      const parentAgent: any = {
        sessionId: parentSid,
        status: 'idle',
        agent: {
          session: { seq: 2 },
          followup: followupMock,
        },
      };

      vi.spyOn(daemon as any, 'getOrCreateManagedAgent').mockResolvedValue(parentAgent);

      (daemon as any).scheduleAnomalyCallback({
        taskId: 'wf_fail_01',
        parentSessionId: parentSid,
        kind: 'workflow',
        name: 'batch-pipeline',
        status: 'failed',
        reason: 'Execution timeout exceeded',
      });

      // Fast-forward past the 2000ms debounce
      await vi.advanceTimersByTimeAsync(2100);

      expect(followupMock).toHaveBeenCalledTimes(1);
      const callArg = followupMock.mock.calls[0][0];
      expect(callArg.source.kind).toBe('task-anomaly');
      expect(callArg.source.senderSessionId).toBe('wf_fail_01');
      expect(callArg.content[0].text).toContain('batch-pipeline');
      expect(callArg.content[0].text).toContain('失败');

      // Second check: journal prevents duplicate dispatch
      await (daemon as any).dispatchAnomalyCallback({
        taskId: 'wf_fail_01',
        parentSessionId: parentSid,
        kind: 'workflow',
        name: 'batch-pipeline',
        status: 'failed',
        reason: 'Execution timeout exceeded',
      });
      expect(followupMock).toHaveBeenCalledTimes(1); // Still 1

      vi.useRealTimers();
    });

    it('suppresses anomaly callback when native notice is observed within 2s', async () => {
      vi.useFakeTimers();
      const daemon = new RuntimeDaemon({
        userId: 'alice-synth',
        dshHome,
        spacesDir,
      });

      const parentSid = 'ses_00000000000000000000000000000006';
      const followupMock = vi.fn();
      const parentAgent: any = {
        sessionId: parentSid,
        status: 'idle',
        agent: {
          session: { seq: 2 },
          followup: followupMock,
        },
      };
      vi.spyOn(daemon as any, 'getOrCreateManagedAgent').mockResolvedValue(parentAgent);

      (daemon as any).scheduleAnomalyCallback({
        taskId: 'sub_fail_02',
        parentSessionId: parentSid,
        kind: 'subagent',
        name: 'researcher',
        status: 'failed',
        reason: 'API rate limit',
      });

      // Native notice arrives at 500ms
      await vi.advanceTimersByTimeAsync(500);
      (daemon as any).recordObservedNativeNotice({ senderSessionId: 'sub_fail_02' });

      // Fast-forward past 2000ms
      await vi.advanceTimersByTimeAsync(2000);

      expect(followupMock).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('suppresses anomaly callback for subagents started inside a workflow', async () => {
      vi.useFakeTimers();
      const daemon = new RuntimeDaemon({
        userId: 'alice-synth',
        dshHome,
        spacesDir,
      });

      const parentSid = 'ses_00000000000000000000000000000010';
      const followupMock = vi.fn();
      const parentAgent: any = {
        sessionId: parentSid,
        status: 'idle',
        agent: {
          session: { seq: 1 },
          followup: followupMock,
        },
      };
      vi.spyOn(daemon as any, 'getOrCreateManagedAgent').mockResolvedValue(parentAgent);

      // Simulate a mock Context to test attachCordisListeners
      const listeners: Record<string, Function[]> = {};
      const fakeCtx: any = {
        on: vi.fn((event: string, handler: Function) => {
          listeners[event] = listeners[event] || [];
          listeners[event].push(handler);
          return () => {};
        }),
        get: vi.fn(),
      };

      (daemon as any).attachCordisListeners(fakeCtx);

      const workflowChildId = 'sub_internal_wf_child_01';

      // 1. tool-workflow/agent-start fires with childId
      listeners['session/event'][0](
        { id: parentSid },
        {
          type: 'tool-workflow/agent-start',
          seq: 2,
          data: { runId: 'wf_run_99', childId: workflowChildId, label: 'internal-worker' },
        }
      );

      // 2. subagent/start fires for this childId
      listeners['subagent/start'][0].call(
        { session: { id: parentSid } },
        { id: workflowChildId, label: 'internal-worker', runInBackground: true }
      );

      // 3. subagent/end fires with failure
      listeners['subagent/end'][0].call(
        { session: { id: parentSid } },
        { id: workflowChildId, outcome: 'failed' }
      );

      // Advance past debounce
      await vi.advanceTimersByTimeAsync(3000);

      // Must NOT callback parent agent
      expect(followupMock).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('suppresses anomaly callback for foreground subagents', async () => {
      vi.useFakeTimers();
      const daemon = new RuntimeDaemon({
        userId: 'alice-synth',
        dshHome,
        spacesDir,
      });

      const parentSid = 'ses_00000000000000000000000000000011';
      const followupMock = vi.fn();
      const parentAgent: any = {
        sessionId: parentSid,
        status: 'idle',
        agent: {
          session: { seq: 1 },
          followup: followupMock,
        },
      };
      vi.spyOn(daemon as any, 'getOrCreateManagedAgent').mockResolvedValue(parentAgent);

      const listeners: Record<string, Function[]> = {};
      const fakeCtx: any = {
        on: vi.fn((event: string, handler: Function) => {
          listeners[event] = listeners[event] || [];
          listeners[event].push(handler);
          return () => {};
        }),
        get: vi.fn(),
      };
      (daemon as any).attachCordisListeners(fakeCtx);

      const fgChildId = 'sub_fg_child_01';

      // Foreground subagent: runInBackground is false / not continuable
      listeners['subagent/start'][0].call(
        { session: { id: parentSid } },
        { id: fgChildId, label: 'foreground-worker', runInBackground: false, mode: 'one-shot' }
      );

      listeners['subagent/end'][0].call(
        { session: { id: parentSid } },
        { id: fgChildId, outcome: 'failed' }
      );

      await vi.advanceTimersByTimeAsync(3000);
      expect(followupMock).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('dispatches anomaly callback for background subagent failure when native notice is absent', async () => {
      vi.useFakeTimers();
      const daemon = new RuntimeDaemon({
        userId: 'alice-synth',
        dshHome,
        spacesDir,
        anomalyCallbackWaitMs: 500, // Custom wait time
      });

      const parentSid = 'ses_00000000000000000000000000000012';
      const followupMock = vi.fn();
      const parentAgent: any = {
        sessionId: parentSid,
        status: 'idle',
        agent: {
          session: { seq: 1 },
          followup: followupMock,
        },
      };
      vi.spyOn(daemon as any, 'getOrCreateManagedAgent').mockResolvedValue(parentAgent);

      const listeners: Record<string, Function[]> = {};
      const fakeCtx: any = {
        on: vi.fn((event: string, handler: Function) => {
          listeners[event] = listeners[event] || [];
          listeners[event].push(handler);
          return () => {};
        }),
        get: vi.fn(),
      };
      (daemon as any).attachCordisListeners(fakeCtx);

      const bgChildId = 'sub_bg_child_01';

      listeners['subagent/start'][0].call(
        { session: { id: parentSid } },
        { id: bgChildId, label: 'background-worker', runInBackground: true, mode: 'continuable' }
      );

      listeners['subagent/end'][0].call(
        { session: { id: parentSid } },
        { id: bgChildId, outcome: 'failed', stopReason: 'process crash' }
      );

      await vi.advanceTimersByTimeAsync(600);
      expect(followupMock).toHaveBeenCalledTimes(1);
      const callArg = followupMock.mock.calls[0][0];
      expect(callArg.source.senderSessionId).toBe(bgChildId);
      expect(callArg.content[0].text).toContain('子代理');
      expect(callArg.content[0].text).toContain('background-worker');
      expect(callArg.content[0].text).toContain('失败');

      vi.useRealTimers();
    });

    it('suppresses anomaly callback when background task is explicitly stopped via stopBackgroundTask', async () => {
      vi.useFakeTimers();
      const daemon = new RuntimeDaemon({
        userId: 'alice-synth',
        dshHome,
        spacesDir,
      });

      const parentSid = 'ses_00000000000000000000000000000013';
      const followupMock = vi.fn();
      const parentAgent: any = {
        sessionId: parentSid,
        status: 'idle',
        agent: {
          session: { seq: 1 },
          followup: followupMock,
        },
      };
      vi.spyOn(daemon as any, 'getOrCreateManagedAgent').mockResolvedValue(parentAgent);

      const listeners: Record<string, Function[]> = {};
      const fakeCtx: any = {
        on: vi.fn((event: string, handler: Function) => {
          listeners[event] = listeners[event] || [];
          listeners[event].push(handler);
          return () => {};
        }),
        get: vi.fn((service: string) => {
          if (service === 'jobs') {
            return { kill: vi.fn().mockReturnValue('requested') };
          }
          return undefined;
        }),
      };
      (daemon as any)._fakeContextForTest = fakeCtx;
      (daemon as any).attachCordisListeners(fakeCtx);

      const wfRunId = 'wf_run_stopped_01';
      (daemon as any).backgroundTasksTracker.set(wfRunId, {
        id: wfRunId,
        parentSessionId: parentSid,
        kind: 'workflow',
        name: 'stopping-wf',
        status: 'running',
        startedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        isBackground: true,
      });

      // User calls stopBackgroundTask
      await daemon.stopBackgroundTask(parentSid, wfRunId);

      // Workflow ends with cancelled/killed
      listeners['workflow/end'][0]({ id: wfRunId, outcome: 'killed' });

      await vi.advanceTimersByTimeAsync(3000);
      expect(followupMock).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('suppresses anomaly callback when parent turn cancellation cascades to tasks', async () => {
      vi.useFakeTimers();
      const daemon = new RuntimeDaemon({
        userId: 'alice-synth',
        dshHome,
        spacesDir,
      });

      const parentSid = 'ses_00000000000000000000000000000014';
      const turnId = 'turn_cascade_01';
      const followupMock = vi.fn();
      const parentAgent: any = {
        sessionId: parentSid,
        status: 'running',
        agent: {
          session: { seq: 1 },
          cancel: vi.fn(),
          followup: followupMock,
        },
      };
      (daemon as any).agents.set(parentSid, parentAgent);
      (daemon as any).currentTurns.set(parentSid, {
        turnId,
        startedAt: Date.now(),
        cancelRequested: false,
      });

      const listeners: Record<string, Function[]> = {};
      const fakeCtx: any = {
        on: vi.fn((event: string, handler: Function) => {
          listeners[event] = listeners[event] || [];
          listeners[event].push(handler);
          return () => {};
        }),
        get: vi.fn(),
      };
      (daemon as any).attachCordisListeners(fakeCtx);

      const taskId = 'sub_cascade_task_01';
      (daemon as any).backgroundTasksTracker.set(taskId, {
        id: taskId,
        parentSessionId: parentSid,
        kind: 'subagent',
        name: 'cascade-subagent',
        status: 'running',
        startedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        isBackground: true,
      });

      // Cancel turn
      await (daemon as any).handleCancel({ id: 'req_1', op: 'cancel', turnId });

      // Subagent ends after cascade cancel
      listeners['subagent/end'][0].call(
        { session: { id: parentSid } },
        { id: taskId, outcome: 'cancelled', stopReason: 'aborted' }
      );

      await vi.advanceTimersByTimeAsync(3000);
      expect(followupMock).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('recovers interrupted tasks on startup, notifies parent once, and does not repeat on next start', async () => {
      const parentSid = 'ses_00000000000000000000000000000020';

      // 1. In a first daemon lifecycle, a background subagent starts and gets journaled
      const daemon1 = new RuntimeDaemon({
        userId: 'alice-synth',
        dshHome,
        spacesDir,
      });

      const listeners1: Record<string, Function[]> = {};
      const fakeCtx1: any = {
        on: vi.fn((event: string, handler: Function) => {
          listeners1[event] = listeners1[event] || [];
          listeners1[event].push(handler);
          return () => {};
        }),
        get: vi.fn(),
      };
      (daemon1 as any).attachCordisListeners(fakeCtx1);

      const bgTaskId = 'sub_interrupted_by_crash_01';
      listeners1['subagent/start'][0].call(
        { session: { id: parentSid } },
        { id: bgTaskId, label: 'crashed-agent', runInBackground: true, mode: 'continuable' }
      );

      // Verify task was written to active task journal
      const activeRecords = (daemon1 as any).activeTaskJournal.listRemainingRecords();
      expect(activeRecords.some((r: any) => r.taskId === bgTaskId)).toBe(true);

      // Simulate crash: daemon1 terminates without subagent/end ever firing

      // 2. Start a new daemon instance (simulating process restart)
      const daemon2 = new RuntimeDaemon({
        userId: 'alice-synth',
        dshHome,
        spacesDir,
      });

      const followupMock2 = vi.fn();
      const parentAgent2: any = {
        sessionId: parentSid,
        status: 'idle',
        agent: {
          session: { seq: 5 },
          followup: followupMock2,
        },
      };
      vi.spyOn(daemon2 as any, 'getOrCreateManagedAgent').mockResolvedValue(parentAgent2);

      // Call notifyInterruptedTasksOnStartup
      await (daemon2 as any).notifyInterruptedTasksOnStartup();

      // Parent must be notified exactly once with expected text
      expect(followupMock2).toHaveBeenCalledTimes(1);
      const callArg = followupMock2.mock.calls[0][0];
      expect(callArg.content[0].text).toBe(
        '后台子代理 "crashed-agent" 因运行时重启中断，未完成。请决定是否重新发起。'
      );
      expect(callArg.source.senderSessionId).toBe(bgTaskId);

      // The active record must now be deleted from disk
      const remainingAfterNotify = (daemon2 as any).activeTaskJournal.listRemainingRecords();
      expect(remainingAfterNotify.some((r: any) => r.taskId === bgTaskId)).toBe(false);

      // 3. Start a third daemon instance or call notify again - must NOT notify again
      const daemon3 = new RuntimeDaemon({
        userId: 'alice-synth',
        dshHome,
        spacesDir,
      });
      const followupMock3 = vi.fn();
      const parentAgent3: any = {
        sessionId: parentSid,
        status: 'idle',
        agent: {
          session: { seq: 6 },
          followup: followupMock3,
        },
      };
      vi.spyOn(daemon3 as any, 'getOrCreateManagedAgent').mockResolvedValue(parentAgent3);

      await (daemon3 as any).notifyInterruptedTasksOnStartup();
      expect(followupMock3).not.toHaveBeenCalled();
    });
  });
});
