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
  });
});
