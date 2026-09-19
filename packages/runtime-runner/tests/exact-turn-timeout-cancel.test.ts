import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HostDaemonTransport } from '../src/host/transport.js';
import { DaemonDockerTransport } from '../src/transport/daemon-transport.js';
import { RuntimeDaemon } from '../src/runtime/daemon.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('Exact Turn Timeout Cancellation', () => {
  describe('HostDaemonTransport exact turn cancellation on timeout', () => {
    it('actively requests cancelTurn with matching turnId when followup timeout expires', async () => {
      const transport = new HostDaemonTransport({
        userId: 'alice',
        dshHome: '/tmp/dsh-test-host',
      });

      const cancelCalls: Array<{ turnId: string; reason?: string }> = [];
      transport.cancelTurn = vi.fn().mockImplementation(async (turnId: string, reason?: string) => {
        cancelCalls.push({ turnId, reason });
        return { ok: true, id: 'cancel_test', op: 'cancel' };
      });

      // Mock connected state & request method so submit succeeds and sets up timeout waiter
      (transport as any).state = 'connected';
      (transport as any).socket = {
        destroyed: false,
        write: vi.fn(),
      };
      (transport as any).request = vi.fn().mockResolvedValue({ ok: true, id: 'submit_ok', op: 'submitTurn' });

      const turnId = 'turn_00000000000000000000000000000001';
      const sessionId = 'ses_00000000000000000000000000000001';

      // Submit with 50ms timeout
      const submitPromise = transport.sendFollowup(
        {
          turnId,
          sessionId,
          prompt: 'heavy image ocr turn',
          timeoutMs: 50,
        },
        50
      );

      await expect(submitPromise).rejects.toThrow(/timed out after 50ms/);

      // Verify cancelTurn was called with the exact turnId
      expect(transport.cancelTurn).toHaveBeenCalledTimes(1);
      expect(cancelCalls.length).toBe(1);
      expect(cancelCalls[0].turnId).toBe(turnId);
      expect(cancelCalls[0].reason).toContain('timed out after 50ms');

      // Verify waiter was cleaned up
      expect((transport as any).turnWaiters.has(turnId)).toBe(false);
    });
  });

  describe('DaemonDockerTransport exact turn cancellation on timeout', () => {
    it('actively requests cancelTurn with matching turnId when followup timeout expires', async () => {
      const fakeDocker = { spawnLongRunningExecOwned: vi.fn() };
      const expectation = { containerId: 'cnt_123', expectedOwner: 'alice', expectedProfile: 'default' };
      const transport = new DaemonDockerTransport(fakeDocker as any, expectation as any);

      const cancelCalls: Array<{ turnId: string; reason?: string }> = [];
      transport.cancelTurn = vi.fn().mockImplementation(async (turnId: string, reason?: string) => {
        cancelCalls.push({ turnId, reason });
        return { ok: true, id: 'cancel_test', op: 'cancel' };
      });

      (transport as any).state = 'connected';
      (transport as any).execHandle = {
        stdin: { write: vi.fn(), destroyed: false },
      };
      transport.start = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(transport, 'request').mockResolvedValue({ ok: true, id: 'submit_ok', op: 'submitTurn' } as any);

      const turnId = 'turn_00000000000000000000000000000002';
      const sessionId = 'ses_00000000000000000000000000000002';

      const submitPromise = transport.sendFollowup({
        turnId,
        sessionId,
        prompt: 'docker turn prompt',
        timeoutMs: 50,
      });

      await expect(submitPromise).rejects.toThrow();

      expect(transport.cancelTurn).toHaveBeenCalledTimes(1);
      expect(cancelCalls.length).toBe(1);
      expect(cancelCalls[0].turnId).toBe(turnId);
      expect(cancelCalls[0].reason).toContain('timed out after 50ms');
      expect((transport as any).turnWaiters.has(turnId)).toBe(false);
    });
  });

  describe('RuntimeDaemon exact turn cancellation precision', () => {
    const tmpDir = path.join(os.tmpdir(), `dsh-cancel-test-${Date.now()}`);
    const dshHome = path.join(tmpDir, 'dsh');
    const spacesDir = path.join(tmpDir, 'spaces');

    beforeEach(() => {
      fs.mkdirSync(dshHome, { recursive: true });
      fs.mkdirSync(spacesDir, { recursive: true });
    });

    it('cancels matching queued turn without affecting running or newer turns', async () => {
      const daemon = new RuntimeDaemon({
        userId: 'alice',
        dshHome,
        spacesDir,
        maxAgents: 4,
        maxConcurrentSessions: 2,
      });

      await daemon.start();

      try {
        const sessionId = 'ses_00000000000000000000000000000099';
        const turn1Id = 'turn_00000000000000000000000000000011';
        const turn2Id = 'turn_00000000000000000000000000000022';
        const turn3Id = 'turn_00000000000000000000000000000033';

        // 1. Submit running turn with delay
        const turn1Promise = daemon.submitTurnAndWait({
          id: 'turn-1',
          op: 'submitTurn',
          turnId: turn1Id,
          sessionId,
          prompt: 'Turn 1 prompt [enkeep-test-delay-ms=300]',
        });

        // 2. Submit turn 2 (will be queued behind turn 1)
        const turn2Promise = daemon.submitTurnAndWait({
          id: 'turn-2',
          op: 'submitTurn',
          turnId: turn2Id,
          sessionId,
          prompt: 'Turn 2 prompt',
        });

        // 3. Submit turn 3 (will be queued behind turn 2)
        const turn3Promise = daemon.submitTurnAndWait({
          id: 'turn-3',
          op: 'submitTurn',
          turnId: turn3Id,
          sessionId,
          prompt: 'Turn 3 prompt',
        });

        // Cancel ONLY turn 2
        const cancelRes = await daemon.handleRequest({
          id: 'c2',
          op: 'cancel',
          turnId: turn2Id,
        });
        expect(cancelRes.ok).toBe(true);

        const res2 = await turn2Promise;
        expect(res2.status).toBe('cancelled');

        const res1 = await turn1Promise;
        expect(res1.status).toBe('completed');

        // Turn 3 was NOT cancelled, so it executes and completes!
        const res3 = await turn3Promise;
        expect(res3.status).toBe('completed');
      } finally {
        await daemon.shutdown(1000).catch(() => {});
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
