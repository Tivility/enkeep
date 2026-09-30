import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HostDaemonTransport } from '../src/host/transport.js';
import { DaemonDockerTransport } from '../src/transport/daemon-transport.js';
import {
  isGenuineTurnProgress,
  extractVerifiedApprovalAsked,
  extractVerifiedApprovalDecided,
  calculateTurnBudgets,
  DEFAULT_FOLLOWUP_TIMEOUT_MS,
  HC_DEFAULT_EXECUTION_BUDGET_MS,
  HC_DEFAULT_IDLE_TIMEOUT_MS,
} from '../src/transport/types.js';
import { DAEMON_STREAM_EVENTS } from '../src/runtime/daemon-protocol.js';

describe('G13 Transport Deadline & Idle Watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('isGenuineTurnProgress and Approval Schema Verification', () => {
    it('recognizes LLM streaming chunks and step boundaries as genuine progress', () => {
      expect(
        isGenuineTurnProgress({
          type: 'event',
          event: DAEMON_STREAM_EVENTS.TURN_CHUNK,
          turnId: 'turn_1',
          chunk: { type: 'text-delta', text: 'analyzing...' },
        })
      ).toBe(true);

      expect(
        isGenuineTurnProgress({
          type: 'event',
          event: DAEMON_STREAM_EVENTS.TURN_STARTED,
          turnId: 'turn_1',
        })
      ).toBe(true);

      expect(
        isGenuineTurnProgress({
          type: 'event',
          event: DAEMON_STREAM_EVENTS.TURN_EVENT,
          turnId: 'turn_1',
          sessionEvent: { type: 'step/start' },
        })
      ).toBe(true);

      expect(
        isGenuineTurnProgress({
          type: 'event',
          event: DAEMON_STREAM_EVENTS.TURN_EVENT,
          turnId: 'turn_1',
          sessionEvent: { type: 'tool/call', data: { name: 'bash' } },
        })
      ).toBe(true);

      expect(
        isGenuineTurnProgress({
          type: 'event',
          event: DAEMON_STREAM_EVENTS.TURN_EVENT,
          turnId: 'turn_1',
          sessionEvent: { type: 'tool/result', data: { output: 'files' } },
        })
      ).toBe(true);
    });

    it('requires verified schema for approval/asked and approval/decided events', () => {
      // Valid daemon stream approval/asked
      expect(
        isGenuineTurnProgress({
          type: 'event',
          event: DAEMON_STREAM_EVENTS.APPROVAL_ASKED,
          turnId: 'turn_1',
          approval: { id: 'app_123', toolName: 'bash', risk: 'high', safeSummary: 'Run shell' },
        })
      ).toBe(true);

      expect(
        extractVerifiedApprovalAsked({
          type: 'event',
          event: DAEMON_STREAM_EVENTS.APPROVAL_ASKED,
          turnId: 'turn_1',
          approval: { id: 'app_123', toolName: 'bash' },
        })
      ).toEqual({ approvalId: 'app_123' });

      // Invalid approval/asked without approval id
      expect(
        isGenuineTurnProgress({
          type: 'event',
          event: DAEMON_STREAM_EVENTS.APPROVAL_ASKED,
          turnId: 'turn_1',
        })
      ).toBe(false);

      expect(
        extractVerifiedApprovalAsked({
          type: 'event',
          event: DAEMON_STREAM_EVENTS.APPROVAL_ASKED,
          turnId: 'turn_1',
          approval: {},
        })
      ).toBeNull();

      // Valid daemon stream approval/decided
      expect(
        isGenuineTurnProgress({
          type: 'event',
          event: DAEMON_STREAM_EVENTS.APPROVAL_DECIDED,
          turnId: 'turn_1',
          decision: { id: 'app_123', outcome: 'allowed-once' },
        })
      ).toBe(true);

      expect(
        extractVerifiedApprovalDecided({
          type: 'event',
          event: DAEMON_STREAM_EVENTS.APPROVAL_DECIDED,
          turnId: 'turn_1',
          decision: { id: 'app_123', outcome: 'allowed-once' },
        })
      ).toEqual({ decisionId: 'app_123', outcome: 'allowed-once' });

      // Invalid approval/decided without outcome
      expect(
        isGenuineTurnProgress({
          type: 'event',
          event: DAEMON_STREAM_EVENTS.APPROVAL_DECIDED,
          turnId: 'turn_1',
          decision: { id: 'app_123' },
        })
      ).toBe(false);

      expect(
        extractVerifiedApprovalDecided({
          type: 'event',
          event: DAEMON_STREAM_EVENTS.APPROVAL_DECIDED,
          turnId: 'turn_1',
          decision: { id: '' },
        })
      ).toBeNull();
    });

    it('ignores background daemon stats, pings, and keepalives to prevent immortal turns', () => {
      expect(
        isGenuineTurnProgress({
          type: 'event',
          event: DAEMON_STREAM_EVENTS.DAEMON_STATS,
        })
      ).toBe(false);

      expect(isGenuineTurnProgress({ type: 'event', event: 'ping' })).toBe(false);
      expect(isGenuineTurnProgress({ type: 'event', event: 'heartbeat' })).toBe(false);
      expect(isGenuineTurnProgress({ type: 'event', event: 'keepalive' })).toBe(false);
      expect(isGenuineTurnProgress({ type: 'event', event: 'agent/evicted' })).toBe(false);

      expect(
        isGenuineTurnProgress({
          type: 'event',
          event: DAEMON_STREAM_EVENTS.TURN_EVENT,
          turnId: 'turn_1',
          sessionEvent: { type: 'ping' },
        })
      ).toBe(false);

      expect(
        isGenuineTurnProgress({
          type: 'event',
          event: DAEMON_STREAM_EVENTS.TURN_EVENT,
          turnId: 'turn_1',
          sessionEvent: { type: 'telemetry/ping' },
        })
      ).toBe(false);
    });
  });

  describe('Budget & Idle Calculation Invariants', () => {
    it('defaults idle timeout to effective execution budget and never clamps to arbitrary 300s', () => {
      // Case 1: unconfigured default uses baseline 3600s
      const b1 = calculateTurnBudgets({}, {});
      expect(b1.rawBudgetMs).toBe(DEFAULT_FOLLOWUP_TIMEOUT_MS); // 3_600_000
      expect(b1.idleTimeoutMs).toBe(3_600_000); // Equal to rawBudgetMs, NOT 300_000!
      expect(b1.clientWaitTimeoutMs).toBe(3_660_000); // 3600s + 60s grace

      // Case 2: caller specifies explicit 900s timeoutMs
      const b2 = calculateTurnBudgets({ timeoutMs: 900_000 }, {});
      expect(b2.rawBudgetMs).toBe(900_000);
      expect(b2.idleTimeoutMs).toBe(900_000); // Default idle matches 900s!
      expect(b2.clientWaitTimeoutMs).toBe(960_000);

      // Case 3: configured options with HC defaults (3600s)
      const b3 = calculateTurnBudgets(
        {},
        {
          defaultExecutionBudgetMs: HC_DEFAULT_EXECUTION_BUDGET_MS,
          defaultIdleTimeoutMs: HC_DEFAULT_IDLE_TIMEOUT_MS,
        }
      );
      expect(b3.rawBudgetMs).toBe(3_600_000);
      expect(b3.idleTimeoutMs).toBe(3_600_000);
      expect(b3.clientWaitTimeoutMs).toBe(3_660_000);

      // Case 4: explicit caller idle override is respected
      const b4 = calculateTurnBudgets({ timeoutMs: 900_000, idleTimeoutMs: 120_000 }, {});
      expect(b4.rawBudgetMs).toBe(900_000);
      expect(b4.idleTimeoutMs).toBe(120_000);
    });
  });

  describe('HostDaemonTransport', () => {
    function createMockHostTransport(options = {}) {
      const transport = new HostDaemonTransport({
        socketPath: '/tmp/test-host-daemon.sock',
        ...options,
      });

      (transport as any).state = 'connected';
      (transport as any).socket = {
        destroyed: false,
        write: vi.fn(),
      };
      (transport as any).request = vi.fn().mockResolvedValue({
        ok: true,
        id: 'submit_ok',
        op: 'submitTurn',
      });

      const cancelCalls: Array<{ turnId: string; reason?: string }> = [];
      transport.cancelTurn = vi.fn().mockImplementation(async (turnId: string, reason?: string) => {
        cancelCalls.push({ turnId, reason });
        return { ok: true, id: 'cancel_ack', op: 'cancel' };
      });

      return { transport, cancelCalls };
    }

    it('Case 1: activity > old 660s within configured hardcap survives and resolves successfully', async () => {
      const { transport, cancelCalls } = createMockHostTransport();

      const turnId = 'turn_host_survive_001';
      const sessionId = 'ses_host_survive_001';

      // 900s execution budget (hardcap: 900s + 60s = 960s), 300s idle timeout
      const submitPromise = transport.sendFollowup({
        turnId,
        sessionId,
        prompt: 'Long academic scraping task (RP-04)',
        timeoutMs: 900_000,
        idleTimeoutMs: 300_000,
      });

      // Advance 200s (below 300s idle), emit genuine tool progress
      await vi.advanceTimersByTimeAsync(200_000);
      (transport as any).handleIncomingMessage({
        type: 'event',
        event: DAEMON_STREAM_EVENTS.TURN_EVENT,
        turnId,
        sessionEvent: { type: 'tool/result', data: { step: 10 } },
      });

      // Advance another 200s (total 400s), emit chunk progress
      await vi.advanceTimersByTimeAsync(200_000);
      (transport as any).handleIncomingMessage({
        type: 'event',
        event: DAEMON_STREAM_EVENTS.TURN_CHUNK,
        turnId,
        chunk: { type: 'text-delta', text: 'processing step 25...' },
      });

      // Advance another 200s (total 600s), emit tool progress
      await vi.advanceTimersByTimeAsync(200_000);
      (transport as any).handleIncomingMessage({
        type: 'event',
        event: DAEMON_STREAM_EVENTS.TURN_EVENT,
        turnId,
        sessionEvent: { type: 'tool/result', data: { step: 35 } },
      });

      // Advance 100s more: total elapsed = 700s (> old 660s watchdog threshold!)
      await vi.advanceTimersByTimeAsync(100_000);

      // Verify that at 700s, turn is STILL ALIVE and cancelTurn was NOT called
      expect(cancelCalls.length).toBe(0);
      expect((transport as any).turnWaiters.has(turnId)).toBe(true);

      // Now complete the turn at 710s
      await vi.advanceTimersByTimeAsync(10_000);
      (transport as any).handleIncomingMessage({
        type: 'event',
        event: DAEMON_STREAM_EVENTS.TURN_COMPLETED,
        turnId,
        result: {
          status: 'completed',
          turnId,
          sessionId,
          replyText: 'Scraping and synthesis completed across 49 steps',
          eventsCount: 49,
          persisted: true,
        },
      });

      const res = await submitPromise;
      expect(res.status).toBe('completed');
      expect((res as any).replyText).toContain('completed across 49 steps');
      expect(cancelCalls.length).toBe(0);
      expect((transport as any).turnWaiters.has(turnId)).toBe(false);
    });

    it('Case 2: idle expires when no activity arrives within idleTimeoutMs', async () => {
      const { transport, cancelCalls } = createMockHostTransport();

      const turnId = 'turn_host_idle_002';
      const sessionId = 'ses_host_idle_002';

      // 900s hard cap, 100s idle timeout
      let submitErr: Error | null = null;
      const submitPromise = transport
        .sendFollowup({
          turnId,
          sessionId,
          prompt: 'Idle test turn',
          timeoutMs: 900_000,
          idleTimeoutMs: 100_000,
        })
        .catch((err) => {
          submitErr = err;
        });

      // Emit initial activity at 40s
      await vi.advanceTimersByTimeAsync(40_000);
      (transport as any).handleIncomingMessage({
        type: 'event',
        event: DAEMON_STREAM_EVENTS.TURN_CHUNK,
        turnId,
        chunk: 'starting work',
      });

      // Advance 99s after activity (total 139s) - still within idle window
      await vi.advanceTimersByTimeAsync(99_000);
      expect(cancelCalls.length).toBe(0);
      expect(submitErr).toBeNull();

      // Advance 2s more: crosses the 100s idle deadline (total 141s)
      await vi.advanceTimersByTimeAsync(2_000);
      await submitPromise;

      expect(submitErr).not.toBeNull();
      expect(submitErr?.message).toContain('timed out after 100000ms');
      expect(cancelCalls.length).toBe(1);
      expect(cancelCalls[0].turnId).toBe(turnId);
      expect(cancelCalls[0].reason).toContain('idle activity deadline expired');
      expect((transport as any).turnWaiters.has(turnId)).toBe(false);
    });

    it('Case 3: explicit overall cap expires despite continuous activity', async () => {
      const { transport, cancelCalls } = createMockHostTransport();

      const turnId = 'turn_host_cap_003';
      const sessionId = 'ses_host_cap_003';

      // Explicit caller budget: 500_000ms (grace: 60s, clientWaitTimeoutMs = 560_000ms)
      // idleTimeoutMs: 100_000ms
      let submitErr: Error | null = null;
      const submitPromise = transport
        .sendFollowup({
          turnId,
          sessionId,
          prompt: 'Continuous activity turn',
          timeoutMs: 500_000,
          idleTimeoutMs: 100_000,
        })
        .catch((err) => {
          submitErr = err;
        });

      // Continuously pulse activity every 50s (well under 100s idle deadline)
      for (let elapsed = 50_000; elapsed < 550_000; elapsed += 50_000) {
        await vi.advanceTimersByTimeAsync(50_000);
        (transport as any).handleIncomingMessage({
          type: 'event',
          event: DAEMON_STREAM_EVENTS.TURN_CHUNK,
          turnId,
          chunk: `heartbeat-like chunk at ${elapsed}`,
        });
        expect(cancelCalls.length).toBe(0);
      }

      // Advance past overall hard cap (500_000 + 60_000 = 560_000ms)
      await vi.advanceTimersByTimeAsync(60_050);
      await submitPromise;

      expect(submitErr).not.toBeNull();
      expect(submitErr?.message).toContain('timed out after 500000ms');
      expect(cancelCalls.length).toBe(1);
      expect(cancelCalls[0].turnId).toBe(turnId);
      expect(cancelCalls[0].reason).toContain('hard cap exceeded');
      expect((transport as any).turnWaiters.has(turnId)).toBe(false);
    });

    it('Case 4: ignore ping/keepalive alone ensures stalled turns do not become immortal', async () => {
      const { transport, cancelCalls } = createMockHostTransport();

      const turnId = 'turn_host_ping_004';
      const sessionId = 'ses_host_ping_004';

      let submitErr: Error | null = null;
      const submitPromise = transport
        .sendFollowup({
          turnId,
          sessionId,
          prompt: 'Turn receiving only keepalives',
          timeoutMs: 900_000,
          idleTimeoutMs: 100_000,
        })
        .catch((err) => {
          submitErr = err;
        });

      // Send ping/stats every 25s for 100s
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(25_000);
        (transport as any).handleIncomingMessage({
          type: 'event',
          event: DAEMON_STREAM_EVENTS.DAEMON_STATS,
          stats: { cpu: 10 },
        });
        (transport as any).handleIncomingMessage({
          type: 'event',
          event: DAEMON_STREAM_EVENTS.TURN_EVENT,
          turnId,
          sessionEvent: { type: 'ping' },
        });
      }

      // At 100s + 1ms, the idle timer must fire despite 4 pings having arrived
      await vi.advanceTimersByTimeAsync(100);
      await submitPromise;

      expect(submitErr).not.toBeNull();
      expect(cancelCalls.length).toBe(1);
      expect(cancelCalls[0].turnId).toBe(turnId);
      expect((transport as any).turnWaiters.has(turnId)).toBe(false);
    });

    it('Case 5: approval/asked pauses idle timer under hard budget, and approval/decided resets it', async () => {
      const { transport, cancelCalls } = createMockHostTransport();

      const turnId = 'turn_host_approval_005';
      const sessionId = 'ses_host_approval_005';

      // 900s execution budget, 100s idle timeout
      const submitPromise = transport.sendFollowup({
        turnId,
        sessionId,
        prompt: 'Interactive approval turn',
        timeoutMs: 900_000,
        idleTimeoutMs: 100_000,
      });

      // At 50s, human approval is asked for bash execution
      await vi.advanceTimersByTimeAsync(50_000);
      (transport as any).handleIncomingMessage({
        type: 'event',
        event: DAEMON_STREAM_EVENTS.APPROVAL_ASKED,
        turnId,
        approval: {
          id: 'app_wait_001',
          toolName: 'bash',
          risk: 'high',
          safeSummary: 'Run bash script',
        },
      });

      // User spends 250s reviewing and deciding (exceeding the 100s idle timeout!)
      await vi.advanceTimersByTimeAsync(250_000);

      // Verify turn is NOT cancelled during approval pause
      expect(cancelCalls.length).toBe(0);
      expect((transport as any).turnWaiters.has(turnId)).toBe(true);

      // User approves at 300s total elapsed
      (transport as any).handleIncomingMessage({
        type: 'event',
        event: DAEMON_STREAM_EVENTS.APPROVAL_DECIDED,
        turnId,
        decision: {
          id: 'app_wait_001',
          outcome: 'allowed-once',
        },
      });

      // Tool outputs result at 350s (resumed idle window)
      await vi.advanceTimersByTimeAsync(50_000);
      (transport as any).handleIncomingMessage({
        type: 'event',
        event: DAEMON_STREAM_EVENTS.TURN_EVENT,
        turnId,
        sessionEvent: { type: 'tool/result', data: { output: 'success' } },
      });

      // Turn completes at 400s
      await vi.advanceTimersByTimeAsync(50_000);
      (transport as any).handleIncomingMessage({
        type: 'event',
        event: DAEMON_STREAM_EVENTS.TURN_COMPLETED,
        turnId,
        result: {
          status: 'completed',
          turnId,
          sessionId,
          replyText: 'Done with approval',
          eventsCount: 5,
          persisted: true,
        },
      });

      const res = await submitPromise;
      expect(res.status).toBe('completed');
      expect(cancelCalls.length).toBe(0);
      expect((transport as any).turnWaiters.has(turnId)).toBe(false);
    });

    it('Case 6: multiple sequential approvals pause and resume correctly, remaining bound by hard budget', async () => {
      const { transport, cancelCalls } = createMockHostTransport();

      const turnId = 'turn_host_multi_app_006';
      const sessionId = 'ses_host_multi_app_006';

      // 400s hard budget (clientWaitTimeoutMs = 460_000ms), 60s idle timeout
      let submitErr: Error | null = null;
      const submitPromise = transport
        .sendFollowup({
          turnId,
          sessionId,
          prompt: 'Multiple approvals turn',
          timeoutMs: 400_000,
          idleTimeoutMs: 60_000,
        })
        .catch((err) => {
          submitErr = err;
        });

      // Approval 1 asked at 30s
      await vi.advanceTimersByTimeAsync(30_000);
      (transport as any).handleIncomingMessage({
        type: 'event',
        event: DAEMON_STREAM_EVENTS.APPROVAL_ASKED,
        turnId,
        approval: { id: 'app_1', toolName: 'write' },
      });

      // Wait 100s (> 60s idle), approval 1 decided
      await vi.advanceTimersByTimeAsync(100_000);
      expect(cancelCalls.length).toBe(0);
      (transport as any).handleIncomingMessage({
        type: 'event',
        event: DAEMON_STREAM_EVENTS.APPROVAL_DECIDED,
        turnId,
        decision: { id: 'app_1', outcome: 'allowed-once' },
      });

      // Some activity at 150s total
      await vi.advanceTimersByTimeAsync(20_000);
      (transport as any).handleIncomingMessage({
        type: 'event',
        event: DAEMON_STREAM_EVENTS.TURN_CHUNK,
        turnId,
        chunk: 'step 2',
      });

      // Approval 2 asked at 170s total
      await vi.advanceTimersByTimeAsync(20_000);
      (transport as any).handleIncomingMessage({
        type: 'event',
        event: DAEMON_STREAM_EVENTS.APPROVAL_ASKED,
        turnId,
        approval: { id: 'app_2', toolName: 'deploy' },
      });

      // While approval 2 is waiting, advance past 460_000ms overall hard budget!
      // Even though approval 2 paused idle, hard budget MUST still cancel the turn.
      await vi.advanceTimersByTimeAsync(300_000); // 170s + 300s = 470s > 460s hardcap
      await submitPromise;

      expect(submitErr).not.toBeNull();
      expect(submitErr?.message).toContain('timed out after 400000ms');
      expect(cancelCalls.length).toBe(1);
      expect(cancelCalls[0].reason).toContain('hard cap exceeded');
      expect((transport as any).turnWaiters.has(turnId)).toBe(false);
    });

    it('Case 7: cancel cleans all timers and prevents phantom rejections', async () => {
      const { transport, cancelCalls } = createMockHostTransport();

      const turnId = 'turn_host_cancel_007';
      const sessionId = 'ses_host_cancel_007';

      const submitPromise = transport.sendFollowup({
        turnId,
        sessionId,
        prompt: 'Cancelled turn',
        timeoutMs: 900_000,
        idleTimeoutMs: 100_000,
      });

      await vi.advanceTimersByTimeAsync(10_000);

      // Daemon sends turn/cancelled event
      (transport as any).handleIncomingMessage({
        type: 'event',
        event: DAEMON_STREAM_EVENTS.TURN_CANCELLED,
        turnId,
        sessionId,
      });

      const res = await submitPromise;
      expect(res.status).toBe('cancelled');
      expect((transport as any).turnWaiters.has(turnId)).toBe(false);

      // Advance fake timers by 2,000,000ms: no timeout calls should occur
      await vi.advanceTimersByTimeAsync(2_000_000);
      expect(cancelCalls.length).toBe(0);
    });
  });

  describe('DaemonDockerTransport', () => {
    function createMockDockerTransport(options = {}) {
      const fakeDocker = { spawnLongRunningExecOwned: vi.fn() };
      const expectation = { containerId: 'cnt_123', expectedOwner: 'alice', expectedProfile: 'default' };
      const transport = new DaemonDockerTransport(fakeDocker as any, expectation as any, options);

      (transport as any).state = 'connected';
      (transport as any).execHandle = {
        stdin: { write: vi.fn(), destroyed: false },
      };
      transport.start = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(transport, 'request').mockResolvedValue({ ok: true, id: 'submit_ok', op: 'submitTurn' } as any);

      const cancelCalls: Array<{ turnId: string; reason?: string }> = [];
      transport.cancelTurn = vi.fn().mockImplementation(async (turnId: string, reason?: string) => {
        cancelCalls.push({ turnId, reason });
        return { ok: true, id: 'cancel_ack', op: 'cancel' };
      });

      return { transport, cancelCalls };
    }

    it('activity > old 660s within configured hardcap survives and resolves successfully', async () => {
      const { transport, cancelCalls } = createMockDockerTransport();

      const turnId = 'turn_docker_survive_001';
      const sessionId = 'ses_docker_survive_001';

      const submitPromise = transport.sendFollowup({
        turnId,
        sessionId,
        prompt: 'Docker scraping turn',
        timeoutMs: 900_000,
        idleTimeoutMs: 300_000,
      });

      // Pulse activity every 200s
      await vi.advanceTimersByTimeAsync(200_000);
      (transport as any).handleIncomingMessage({
        type: 'event',
        event: DAEMON_STREAM_EVENTS.TURN_CHUNK,
        turnId,
        chunk: 'delta 1',
      });

      await vi.advanceTimersByTimeAsync(200_000);
      (transport as any).handleIncomingMessage({
        type: 'event',
        event: DAEMON_STREAM_EVENTS.TURN_CHUNK,
        turnId,
        chunk: 'delta 2',
      });

      await vi.advanceTimersByTimeAsync(200_000);
      (transport as any).handleIncomingMessage({
        type: 'event',
        event: DAEMON_STREAM_EVENTS.TURN_CHUNK,
        turnId,
        chunk: 'delta 3',
      });

      // At 700s (> old 660s threshold): still alive!
      await vi.advanceTimersByTimeAsync(100_000);
      expect(cancelCalls.length).toBe(0);
      expect((transport as any).turnWaiters.has(turnId)).toBe(true);

      // Complete at 720s
      await vi.advanceTimersByTimeAsync(20_000);
      (transport as any).handleIncomingMessage({
        type: 'event',
        event: DAEMON_STREAM_EVENTS.TURN_COMPLETED,
        turnId,
        result: {
          status: 'completed',
          turnId,
          sessionId,
          replyText: 'Docker turn finished',
          eventsCount: 15,
          persisted: true,
        },
      });

      const res = await submitPromise;
      expect(res.status).toBe('completed');
      expect((res as any).replyText).toBe('Docker turn finished');
      expect(cancelCalls.length).toBe(0);
      expect((transport as any).turnWaiters.has(turnId)).toBe(false);
    });

    it('approval pause and multiple approvals work identically in Docker transport', async () => {
      const { transport, cancelCalls } = createMockDockerTransport();

      const turnId = 'turn_docker_app_002';
      const sessionId = 'ses_docker_app_002';

      const submitPromise = transport.sendFollowup({
        turnId,
        sessionId,
        prompt: 'Docker approval turn',
        timeoutMs: 900_000,
        idleTimeoutMs: 50_000,
      });

      // At 20s, approval asked
      await vi.advanceTimersByTimeAsync(20_000);
      (transport as any).handleIncomingMessage({
        type: 'event',
        event: DAEMON_STREAM_EVENTS.APPROVAL_ASKED,
        turnId,
        approval: { id: 'app_dock_1', toolName: 'docker_exec' },
      });

      // User waits 120s (> 50s idle timeout)
      await vi.advanceTimersByTimeAsync(120_000);
      expect(cancelCalls.length).toBe(0);

      // Decided
      (transport as any).handleIncomingMessage({
        type: 'event',
        event: DAEMON_STREAM_EVENTS.APPROVAL_DECIDED,
        turnId,
        decision: { id: 'app_dock_1', outcome: 'allowed-once' },
      });

      // Complete
      await vi.advanceTimersByTimeAsync(20_000);
      (transport as any).handleIncomingMessage({
        type: 'event',
        event: DAEMON_STREAM_EVENTS.TURN_COMPLETED,
        turnId,
        result: {
          status: 'completed',
          turnId,
          sessionId,
          replyText: 'Docker approval finished',
          eventsCount: 2,
          persisted: true,
        },
      });

      const res = await submitPromise;
      expect(res.status).toBe('completed');
      expect(cancelCalls.length).toBe(0);
    });

    it('close cleans all timers for in-flight turn waiters', async () => {
      const { transport } = createMockDockerTransport();

      const turnId = 'turn_docker_close_003';
      const sessionId = 'ses_docker_close_003';

      let submitErr: Error | null = null;
      const submitPromise = transport
        .sendFollowup({
          turnId,
          sessionId,
          prompt: 'Turn closing soon',
          timeoutMs: 900_000,
          idleTimeoutMs: 100_000,
        })
        .catch((err) => {
          submitErr = err;
        });

      await vi.advanceTimersByTimeAsync(10_000);

      await transport.close();
      await submitPromise;

      expect(submitErr).not.toBeNull();
      expect((transport as any).turnWaiters.has(turnId)).toBe(false);

      // Verify no phantom timeouts fire later
      await vi.advanceTimersByTimeAsync(2_000_000);
    });
  });

  describe('Generic Configuration Defaults', () => {
    it('supports generic defaultExecutionBudgetMs and defaultIdleTimeoutMs options', () => {
      const transport = new HostDaemonTransport({
        socketPath: '/tmp/test.sock',
        defaultExecutionBudgetMs: 3_600_000,
        defaultIdleTimeoutMs: 3_600_000,
      });

      expect((transport as any).options.defaultExecutionBudgetMs).toBe(3_600_000);
      expect((transport as any).options.defaultIdleTimeoutMs).toBe(3_600_000);
      expect(HC_DEFAULT_EXECUTION_BUDGET_MS).toBe(3_600_000);
      expect(HC_DEFAULT_IDLE_TIMEOUT_MS).toBe(3_600_000);
      expect(DEFAULT_FOLLOWUP_TIMEOUT_MS).toBe(3_600_000);
    });
  });
});
