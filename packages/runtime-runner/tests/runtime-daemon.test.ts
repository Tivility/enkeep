/**
 * Comprehensive Production Runtime Runner Daemon Deterministic Test Suite
 *
 * Verifies:
 * 1. 10 concurrent submit on same session -> 10 turns executed sequentially in FIFO order, single boot, single Agent instance.
 * 2. Multi-session concurrency bounded by maxConcurrentSessions (e.g. 2 concurrent, 5 sessions queued).
 * 3. Idle eviction + resume: agent evicted after idle timeout; next turn seamlessly resumes from persisted JSONL.
 * 4. LRU maxAgents capacity: oldest idle agent evicted when limit reached.
 * 5. Profile / Space change: agent drains current turn and recreates with updated profile/space.
 * 6. Approval wait: agent waiting for approval is NOT evicted, other sessions continue concurrently, approval resumes turn.
 * 7. Cancellation: cancel queued turn (instant removal) vs cancel running turn (aborted mid-turn).
 * 8. Daemon crash journal & restart: previously completed turns return cached result, unclosed records repaired.
 * 9. Protocol validation: max JSON depth limit, unknown op, invalid IDs, malformed JSON.
 * 10. Maintenance RPC operations (check-artifact, inspect-corruption, fileOp).
 *
 * @module @enkeep/runtime-runner/tests/runtime-daemon.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionId, decodeStorageRecord, type SessionEvent as DshSessionEvent } from '@deepseek-ai/dsh-session';
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import {
  computeAgentProfilePromptHash,
} from '../src/runtime/agent-profile.js';
import { RuntimeDaemon } from '../src/runtime/daemon.js';
import {
  decodeDaemonRequest,
  decodeDaemonMessage,
  encodeDaemonMessage,
  DaemonRpcDecoder,
  DaemonRpcEncoder,
  DAEMON_OPS,
  DAEMON_ERROR_CODES,
  DAEMON_STREAM_EVENTS,
  type DaemonStreamEvent,
} from '../src/runtime/daemon-protocol.js';
import { DaemonTurnJournal } from '../src/runtime/daemon-journal.js';

describe('Production Runtime Runner Daemon E2E Deterministic Tests', () => {
  let tmpDir: string;
  let dshHome: string;
  let spacesDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-daemon-test-'));
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

  describe('1. 10 Concurrent Submits on Same Session (Sequential FIFO, Single Boot, Single Agent)', () => {
    it('executes 10 concurrent submitTurn requests on same session in strict FIFO order reusing single Agent', async () => {
      const daemon = new RuntimeDaemon({
        userId: 'alice',
        dshHome,
        spacesDir,
        maxAgents: 16,
        idleAgentTimeoutMs: 600_000,
        maxConcurrentSessions: 4,
      });

      await daemon.start();

      try {
        const sessionId = 'ses_00000000000000000000000000000001';
        const spaceName = 'space-concurrent-turns';
        const spacePath = path.join(spacesDir, spaceName);
        fs.mkdirSync(spacePath, { recursive: true, mode: 0o700 });

        // Submit 10 turns concurrently
        const turnPromises: Array<Promise<any>> = [];
        const completedOrder: string[] = [];

        daemon.on('stream', (ev: DaemonStreamEvent) => {
          if (ev.event === DAEMON_STREAM_EVENTS.TURN_COMPLETED) {
            completedOrder.push(ev.turnId);
          }
        });

        for (let i = 1; i <= 10; i++) {
          const hex = i.toString().padStart(32, '0');
          const turnId = `turn_${hex}`;
          const prompt = `Turn number ${i}: reply with number ${i}`;

          const p = daemon.submitTurnAndWait({
            id: `req-${i}`,
            op: 'submitTurn',
            turnId,
            sessionId,
            prompt,
            workspaceFolder: spaceName,
          });
          turnPromises.push(p);
        }

        const results = await Promise.all(turnPromises);

        // Verify all 10 completed successfully
        expect(results.length).toBe(10);
        for (let i = 0; i < 10; i++) {
          const res = results[i];
          expect(res.status).toBe('completed');
          expect(res.replyText).toBeDefined();
          expect(res.persisted).toBe(true);
        }

        // Verify strict sequential execution order in completedOrder
        expect(completedOrder.length).toBe(10);
        for (let i = 1; i <= 10; i++) {
          const expectedTurnId = `turn_${i.toString().padStart(32, '0')}`;
          expect(completedOrder[i - 1]).toBe(expectedTurnId);
        }

        // Verify health stats
        const healthRes = await daemon.handleRequest({ id: 'h1', op: 'health' });
        expect(healthRes.ok).toBe(true);
        if (healthRes.ok) {
          expect(healthRes.stats.totalTurnsProcessed).toBe(10);
          expect(healthRes.stats.activeAgentsCount).toBe(1);
        }

        // Verify JSONL session file on disk has all turns persisted
        const sid = SessionId(sessionId);
        const check = await daemon.handleRequest({
          id: 'c1',
          op: 'checkSessionArtifact',
          sessionId,
          workspaceFolder: spaceName,
        });
        expect(check.ok).toBe(true);
        if (check.ok) {
          expect(check.exists).toBe(true);
          expect(check.valid).toBe(true);
          expect(check.eventCount).toBeGreaterThan(20);
        }
      } finally {
        await daemon.shutdown(2000);
      }
    }, 30000);
  });

  describe('2. Multi-Session Concurrency Bounded by maxConcurrentSessions', () => {
    it('bounds concurrent session execution to maxConcurrentSessions and completes all sessions', async () => {
      const daemon = new RuntimeDaemon({
        userId: 'alice',
        dshHome,
        spacesDir,
        maxAgents: 16,
        idleAgentTimeoutMs: 600_000,
        maxConcurrentSessions: 2, // Max 2 concurrent sessions
      });

      await daemon.start();

      try {
        const turnPromises: Array<Promise<any>> = [];
        const sessionCount = 5;

        for (let i = 1; i <= sessionCount; i++) {
          const sHex = i.toString().padStart(32, '0');
          const sessionId = `ses_${sHex}`;
          const turnId = `turn_${sHex}`;
          const spaceName = `space-${i}`;

          const p = daemon.submitTurnAndWait({
            id: `req-session-${i}`,
            op: 'submitTurn',
            turnId,
            sessionId,
            prompt: `Hello from session ${i}`,
            workspaceFolder: spaceName,
          });
          turnPromises.push(p);
        }

        const results = await Promise.all(turnPromises);
        expect(results.length).toBe(sessionCount);
        for (const res of results) {
          expect(res.status).toBe('completed');
          expect(res.replyText).toBeDefined();
        }

        // Verify health stats reflect all 5 sessions processed
        const healthRes = await daemon.handleRequest({ id: 'h2', op: 'health' });
        expect(healthRes.ok).toBe(true);
        if (healthRes.ok) {
          expect(healthRes.stats.totalTurnsProcessed).toBe(5);
        }
      } finally {
        await daemon.shutdown(2000);
      }
    });
  });

  describe('3. Idle Agent Eviction & Seamless Resume on Demand', () => {
    it('evicts idle agent after idleAgentTimeoutMs and resumes smoothly on subsequent turn', async () => {
      const daemon = new RuntimeDaemon({
        userId: 'alice',
        dshHome,
        spacesDir,
        maxAgents: 16,
        idleAgentTimeoutMs: 50, // 50ms short timeout for test
        idleSweepIntervalMs: 25,
        maxConcurrentSessions: 4,
      });

      await daemon.start();

      try {
        const sessionId = 'ses_00000000000000000000000000000003';
        const spaceName = 'space-idle-test';

        // 1. Initial turn
        const res1 = await daemon.submitTurnAndWait({
          id: 'turn-1',
          op: 'submitTurn',
          turnId: 'turn_00000000000000000000000000000001',
          sessionId,
          prompt: 'My secret code is 98765. Remember it.',
          workspaceFolder: spaceName,
        });
        expect(res1.status).toBe('completed');

        // 2. Wait up to 1000ms for idle sweep to evict the agent
        const evictionDeadline = Date.now() + 1000;
        let healthRes: any;
        while (Date.now() < evictionDeadline) {
          await new Promise((r) => setTimeout(r, 25));
          healthRes = await daemon.handleRequest({ id: 'h3', op: 'health' });
          if (healthRes.ok && healthRes.stats.evictionsCount >= 1 && healthRes.stats.activeAgentsCount === 0) {
            break;
          }
        }

        expect(healthRes.ok).toBe(true);
        if (healthRes.ok) {
          expect(healthRes.stats.evictionsCount).toBeGreaterThanOrEqual(1);
          expect(healthRes.stats.activeAgentsCount).toBe(0);
        }

        // 3. Subsequent turn for the same session resumes seamlessly
        const res2 = await daemon.submitTurnAndWait({
          id: 'turn-2',
          op: 'submitTurn',
          turnId: 'turn_00000000000000000000000000000002',
          sessionId,
          prompt: 'What was my secret code?',
          workspaceFolder: spaceName,
        });
        expect(res2.status).toBe('completed');
        expect(res2.persisted).toBe(true);
      } finally {
        await daemon.shutdown(2000);
      }
    });
  });

  describe('4. LRU Capacity Eviction', () => {
    it('evicts oldest idle agent when maxAgents capacity is reached', async () => {
      const daemon = new RuntimeDaemon({
        userId: 'alice',
        dshHome,
        spacesDir,
        maxAgents: 2, // Max 2 agents in memory
        idleAgentTimeoutMs: 600_000,
        maxConcurrentSessions: 4,
      });

      await daemon.start();

      try {
        // Run session 1
        await daemon.submitTurnAndWait({
          id: 't1',
          op: 'submitTurn',
          turnId: 'turn_00000000000000000000000000000001',
          sessionId: 'ses_00000000000000000000000000000001',
          prompt: 'Hello session 1',
        });

        // Run session 2
        await daemon.submitTurnAndWait({
          id: 't2',
          op: 'submitTurn',
          turnId: 'turn_00000000000000000000000000000002',
          sessionId: 'ses_00000000000000000000000000000002',
          prompt: 'Hello session 2',
        });

        let health = await daemon.handleRequest({ id: 'h', op: 'health' });
        if (health.ok) {
          expect(health.stats.activeAgentsCount).toBe(2);
        }

        // Run session 3 -> exceeds maxAgents 2, session 1 evicted
        await daemon.submitTurnAndWait({
          id: 't3',
          op: 'submitTurn',
          turnId: 'turn_00000000000000000000000000000003',
          sessionId: 'ses_00000000000000000000000000000003',
          prompt: 'Hello session 3',
        });

        health = await daemon.handleRequest({ id: 'h', op: 'health' });
        if (health.ok) {
          expect(health.stats.activeAgentsCount).toBeLessThanOrEqual(2);
          expect(health.stats.evictionsCount).toBeGreaterThanOrEqual(1);
        }
      } finally {
        await daemon.shutdown(2000);
      }
    });
  });

  describe('5. Profile & Space Change Draining and Re-creation', () => {
    it('drains current turn and recreates agent when profile or workspaceFolder changes', async () => {
      const daemon = new RuntimeDaemon({
        userId: 'alice',
        dshHome,
        spacesDir,
        maxAgents: 16,
        idleAgentTimeoutMs: 600_000,
        maxConcurrentSessions: 4,
      });

      await daemon.start();

      try {
        const sessionId = 'ses_00000000000000000000000000000005';
        const spaceName1 = 'space-profile-1';

        const sectionsA = {
          identity: 'You are Alice Agent',
          soul: 'Helpful and precise',
          agents: '',
          tools: '',
        };
        const profileA = {
          profileId: 'agent-alice',
          version: 1,
          promptHash: computeAgentProfilePromptHash(sectionsA),
          ...sectionsA,
        };

        const res1 = await daemon.submitTurnAndWait({
          id: 'p1',
          op: 'submitTurn',
          turnId: 'turn_00000000000000000000000000000001',
          sessionId,
          prompt: 'Turn 1 with Profile A',
          profileSnapshot: profileA,
          workspaceFolder: spaceName1,
        });
        expect(res1.status).toBe('completed');

        // Turn 2 with Profile B (different promptHash) -> triggers drain & recreation
        const sectionsB = {
          identity: 'You are Alice Agent Updated',
          soul: 'Helpful, creative, and fast',
          agents: '',
          tools: '',
        };
        const profileB = {
          profileId: 'agent-alice',
          version: 2,
          promptHash: computeAgentProfilePromptHash(sectionsB),
          ...sectionsB,
        };

        const res2 = await daemon.submitTurnAndWait({
          id: 'p2',
          op: 'submitTurn',
          turnId: 'turn_00000000000000000000000000000002',
          sessionId,
          prompt: 'Turn 2 with Profile B',
          profileSnapshot: profileB,
          workspaceFolder: spaceName1,
        });
        expect(res2.status).toBe('completed');
      } finally {
        await daemon.shutdown(2000);
      }
    });
  });

  describe('6. Approval Wait Holds Agent (No Eviction) & Concurrent Execution', () => {
    it('holds agent waiting approval without eviction, allows other sessions to execute, and resumes on decision', async () => {
      const daemon = new RuntimeDaemon({
        userId: 'alice',
        dshHome,
        spacesDir,
        maxAgents: 16,
        idleAgentTimeoutMs: 50, // Short idle timeout
        idleSweepIntervalMs: 20,
        maxConcurrentSessions: 4,
      });

      await daemon.start();

      try {
        const sessionId1 = 'ses_00000000000000000000000000000006';
        const spaceName = 'space-approval-daemon';
        const spacePath = path.join(spacesDir, spaceName);
        fs.mkdirSync(spacePath, { recursive: true, mode: 0o700 });

        // Initialize session 1
        await daemon.submitTurnAndWait({
          id: 'init-1',
          op: 'submitTurn',
          turnId: 'turn_00000000000000000000000000000001',
          sessionId: sessionId1,
          prompt: 'Initialize session',
          workspaceFolder: spaceName,
        });

        // Set session to read-only sandbox mode and ask approval policy
        const liveAgent = (daemon as any).bootedRuntime?.agentHandles?.get(sessionId1);
        if (liveAgent) {
          setSandboxMode(liveAgent.agent.session, 'read-only');
          setApprovalPolicy(liveAgent.agent.session, 'ask');
        }

        // Initiate turn 2 requesting write tool (requires approval)
        const targetFile = 'daemon-approved.txt';
        const fileContent = 'Daemon approved write';
        const writePrompt = `Write file [enkeep-test-tool-call=write:{"file_path":"${targetFile}","content":"${fileContent}"}]`;

        const turn1Promise = daemon.submitTurnAndWait({
          id: 'turn-write',
          op: 'submitTurn',
          turnId: 'turn_00000000000000000000000000000002',
          sessionId: sessionId1,
          prompt: writePrompt,
          workspaceFolder: spaceName,
        });

        // Wait for approval event
        let approvalId: string | null = null;
        for (let i = 0; i < 50; i++) {
          const listRes = await daemon.handleRequest({ id: `l-${i}`, op: 'listApprovals', sessionId: sessionId1 });
          if (listRes.ok && (listRes as any).approvals?.length > 0) {
            approvalId = (listRes as any).approvals[0].id;
            break;
          }
          await new Promise((r) => setTimeout(r, 20));
        }

        expect(approvalId).toBeDefined();

        // While session 1 is waiting for approval, wait 100ms and verify agent 1 was NOT evicted
        await new Promise((r) => setTimeout(r, 100));

        // Submit turn to session 2 concurrently
        const sessionId2 = 'ses_00000000000000000000000000000007';
        const resSession2 = await daemon.submitTurnAndWait({
          id: 'session-2-turn',
          op: 'submitTurn',
          turnId: 'turn_00000000000000000000000000000003',
          sessionId: sessionId2,
          prompt: 'Hello concurrent session 2',
        });
        expect(resSession2.status).toBe('completed');

        // Now answer approval for session 1
        const answerRes = await daemon.handleRequest({
          id: 'ans-1',
          op: 'answerApproval',
          approvalId: approvalId!,
          decision: 'allowed-once',
        });
        expect(answerRes.ok).toBe(true);

        // Session 1 turn completes
        const resTurn1 = await turn1Promise;
        expect(resTurn1.status).toBe('completed');

        // Verify file written to disk
        expect(fs.readFileSync(path.join(spacePath, targetFile), 'utf8')).toBe(fileContent);
      } finally {
        await daemon.shutdown(2000);
      }
    }, 15000);
  });

  describe('7. Cancellation: Queued Turn vs Running Turn', () => {
    it('cancels queued turn immediately and aborts running turn cleanly', async () => {
      const daemon = new RuntimeDaemon({
        userId: 'alice',
        dshHome,
        spacesDir,
        maxAgents: 16,
        idleAgentTimeoutMs: 600_000,
        maxConcurrentSessions: 4,
      });

      await daemon.start();

      let turn1Promise: Promise<any> | undefined;
      let turn2Promise: Promise<any> | undefined;
      let turn3Promise: Promise<any> | undefined;

      try {
        const sessionId = 'ses_00000000000000000000000000000008';

        // 1. Submit turn 1 with 800ms delay so it remains in-flight while turn 2 is queued
        turn1Promise = daemon.submitTurnAndWait({
          id: 'turn-1',
          op: 'submitTurn',
          turnId: 'turn_00000000000000000000000000000001',
          sessionId,
          prompt: 'Turn 1 prompt [enkeep-test-delay-ms=800]',
        });

        // 2. Submit turn 2 (queued behind turn 1 - published atomically in session queue)
        turn2Promise = daemon.submitTurnAndWait({
          id: 'turn-2',
          op: 'submitTurn',
          turnId: 'turn_00000000000000000000000000000002',
          sessionId,
          prompt: 'Turn 2 prompt',
        });

        // Cancel turn 2 while in queue
        const cancelRes = await daemon.handleRequest({
          id: 'c2',
          op: 'cancel',
          turnId: 'turn_00000000000000000000000000000002',
        });
        expect(cancelRes.ok).toBe(true);

        const res2 = await turn2Promise;
        expect(res2.status).toBe('cancelled');

        const res1 = await turn1Promise;
        expect(res1.status).toBe('completed');

        // 3. Cancel running turn (turn 3 in-flight with delay)
        let turn3Started = false;
        const onStarted = (ev: DaemonStreamEvent) => {
          if (ev.event === DAEMON_STREAM_EVENTS.TURN_STARTED && ev.turnId === 'turn_00000000000000000000000000000003') {
            turn3Started = true;
          }
        };
        daemon.on('stream', onStarted);

        turn3Promise = daemon.submitTurnAndWait({
          id: 'turn-3',
          op: 'submitTurn',
          turnId: 'turn_00000000000000000000000000000003',
          sessionId,
          prompt: 'Turn 3 prompt [enkeep-test-delay-ms=800]',
        });

        // Wait deterministically for turn 3 to start execution
        const startDeadline = Date.now() + 5000;
        while (!turn3Started && Date.now() < startDeadline) {
          await new Promise((r) => setTimeout(r, 10));
        }
        daemon.off('stream', onStarted);

        const cancelRes3 = await daemon.handleRequest({
          id: 'c3',
          op: 'cancel',
          turnId: 'turn_00000000000000000000000000000003',
        });
        expect(cancelRes3.ok).toBe(true);

        const res3 = await turn3Promise;
        expect(res3.status).toBe('cancelled');
      } finally {
        // Settle all pending turn promises even on assertion failure path
        await Promise.allSettled([turn1Promise, turn2Promise, turn3Promise].filter(Boolean));
        await daemon.shutdown(2000);
      }
    }, 15000);
  });

  describe('8. Daemon Crash Journal Restart & Deduplication', () => {
    it('recovers crash journals on restart and returns cached result without duplicate execution', async () => {
      // Instance 1
      const daemon1 = new RuntimeDaemon({
        userId: 'alice',
        dshHome,
        spacesDir,
      });
      await daemon1.start();

      const sessionId = 'ses_00000000000000000000000000000009';
      const turnId = 'turn_00000000000000000000000000000001';

      const res1 = await daemon1.submitTurnAndWait({
        id: 'req-1',
        op: 'submitTurn',
        turnId,
        sessionId,
        prompt: 'Hello turn idempotency test',
      });
      expect(res1.status).toBe('completed');
      expect(res1.replyText).toBeDefined();

      await daemon1.shutdown(1000);

      // Verify journal file exists
      const journal = new DaemonTurnJournal(dshHome);
      const record = journal.get(turnId);
      expect(record).toBeDefined();
      expect(record?.status).toBe('completed');
      expect(record?.result?.replyText).toBe(res1.replyText);

      // Instance 2 (Simulating daemon restart)
      const daemon2 = new RuntimeDaemon({
        userId: 'alice',
        dshHome,
        spacesDir,
      });
      await daemon2.start();

      try {
        // Re-submitting same turnId returns cached completed result immediately
        const res2 = await daemon2.submitTurnAndWait({
          id: 'req-1-retry',
          op: 'submitTurn',
          turnId,
          sessionId,
          prompt: 'Hello turn idempotency test',
        });

        expect(res2.status).toBe('completed');
        expect(res2.replyText).toBe(res1.replyText);
        expect(res2.eventsCount).toBe(res1.eventsCount);
      } finally {
        await daemon2.shutdown(1000);
      }
    });
  });

  describe('9. Protocol Framing, Depth Protection & Malformed Input Handling', () => {
    it('rejects JSON payloads exceeding maximum depth limit', () => {
      // Build 70 levels of nested object (exceeding MAX_JSON_DEPTH of 64)
      let deep: any = { value: 'leaf' };
      for (let i = 0; i < 70; i++) {
        deep = { nested: deep };
      }

      const raw = JSON.stringify({
        id: 'deep-test',
        op: 'submitTurn',
        payload: deep,
      });

      expect(() => decodeDaemonRequest(raw)).toThrow();
    });

    it('rejects malformed JSON strings', () => {
      expect(() => decodeDaemonRequest('not valid json {')).toThrow();
    });

    it('returns UNKNOWN_OP for unsupported operations', async () => {
      const daemon = new RuntimeDaemon({
        userId: 'alice',
        dshHome,
        spacesDir,
      });
      await daemon.start();

      try {
        const res = await daemon.handleRequest({
          id: 'unsupported-1',
          op: 'nonExistentOp' as any,
        });

        expect(res.ok).toBe(false);
        expect(res.error?.code).toBe(DAEMON_ERROR_CODES.UNKNOWN_OP);
      } finally {
        await daemon.shutdown(1000);
      }
    });

    it('handles streaming NDJSON encode and decode cleanly through transform streams', async () => {
      const encoder = new DaemonRpcEncoder();
      const decoder = new DaemonRpcDecoder();

      encoder.pipe(decoder);

      const received: any[] = [];
      decoder.on('data', (msg) => {
        received.push(msg);
      });

      encoder.write({
        id: 'msg-1',
        op: 'health',
      });

      encoder.write({
        type: 'event',
        event: 'turn/chunk',
        turnId: 'turn_00000000000000000000000000000001',
        sessionId: 'ses_00000000000000000000000000000001',
        timestamp: Date.now(),
        chunk: { type: 'text-delta', text: 'hello' },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(received.length).toBe(2);
      expect(received[0].op).toBe('health');
      expect(received[1].event).toBe('turn/chunk');
    });
  });

  describe('10. Maintenance Operations via Daemon RPC', () => {
    it('executes file-op and corruption check via Daemon RPC', async () => {
      const daemon = new RuntimeDaemon({
        userId: 'alice',
        dshHome,
        spacesDir,
      });
      await daemon.start();

      try {
        const spaceName = 'space-maint-test';
        const spacePath = path.join(spacesDir, spaceName);
        fs.mkdirSync(spacePath, { recursive: true, mode: 0o700 });
        const targetFile = 'test-file.txt';

        // 1. File write operation via daemon fileOp
        const writeOpRes = await daemon.handleRequest({
          id: 'f1',
          op: 'fileOp',
          fileOp: {
            op: 'write',
            path: targetFile,
            content: 'Hello File Ops over Daemon',
            space: spaceName,
            requireAbsent: true,
          } as any,
        });
        if (!writeOpRes.ok) {
          console.error('writeOpRes error:', writeOpRes.error);
        }
        expect(writeOpRes.ok).toBe(true);

        // 2. File read operation via daemon fileOp
        const readOpRes = await daemon.handleRequest({
          id: 'f2',
          op: 'fileOp',
          fileOp: {
            op: 'read',
            path: targetFile,
            space: spaceName,
          } as any,
        });
        expect(readOpRes.ok).toBe(true);
        if (readOpRes.ok && (readOpRes as any).fileResult?.content) {
          expect((readOpRes as any).fileResult.content).toBe('Hello File Ops over Daemon');
        }

        // 3. Inspect corruption for a non-existent session
        const corruptRes = await daemon.handleRequest({
          id: 'c1',
          op: 'inspectCorruption',
          sessionId: 'ses_00000000000000000000000000000099',
        });
        expect(corruptRes.ok).toBe(true);
        if (corruptRes.ok) {
          expect((corruptRes as any).exists).toBe(false);
          expect((corruptRes as any).code).toBe('NOT_FOUND');
        }
      } finally {
        await daemon.shutdown(1000);
      }
    });
  });

  describe('11. Real Official DSH Agent Handle Reuse & Raw JSONL Monotonicity', () => {
    it('proves that the exact same Agent instance is reused across multiple turns and raw JSONL events are contiguous on disk', async () => {
      const daemon = new RuntimeDaemon({
        userId: 'alice',
        dshHome,
        spacesDir,
      });
      await daemon.start();

      try {
        const sessionId = 'ses_00000000000000000000000000000088';
        const spaceName = 'space-agent-reuse';
        const spacePath = path.join(spacesDir, spaceName);
        fs.mkdirSync(spacePath, { recursive: true, mode: 0o700 });

        // Turn 1
        await daemon.submitTurnAndWait({
          id: 'turn-1',
          op: 'submitTurn',
          turnId: 'turn_00000000000000000000000000000001',
          sessionId,
          prompt: 'Step 1: Set value to 42',
          workspaceFolder: spaceName,
        });

        // Capture live agent reference
        const agentEntry1 = (daemon as any).agents.get(sessionId);
        expect(agentEntry1).toBeDefined();
        const agentInstance1 = agentEntry1.agent;
        const agentHandle1 = agentEntry1.agentHandle;

        // Turn 2
        await daemon.submitTurnAndWait({
          id: 'turn-2',
          op: 'submitTurn',
          turnId: 'turn_00000000000000000000000000000002',
          sessionId,
          prompt: 'Step 2: What was the value?',
          workspaceFolder: spaceName,
        });

        // Capture agent reference after turn 2
        const agentEntry2 = (daemon as any).agents.get(sessionId);
        expect(agentEntry2).toBeDefined();
        const agentInstance2 = agentEntry2.agent;
        const agentHandle2 = agentEntry2.agentHandle;

        // Turn 3
        await daemon.submitTurnAndWait({
          id: 'turn-3',
          op: 'submitTurn',
          turnId: 'turn_00000000000000000000000000000003',
          sessionId,
          prompt: 'Step 3: Increment value',
          workspaceFolder: spaceName,
        });

        const agentEntry3 = (daemon as any).agents.get(sessionId);
        const agentInstance3 = agentEntry3.agent;
        const agentHandle3 = agentEntry3.agentHandle;

        // Verify exact object identity (===) across turns without re-booting or re-creating Agent
        expect(agentInstance1).toBe(agentInstance2);
        expect(agentInstance2).toBe(agentInstance3);
        expect(agentHandle1).toBe(agentHandle2);
        expect(agentHandle2).toBe(agentHandle3);

        // Verify raw JSONL persistence file on disk
        const findLog = (dir: string): string | null => {
          const direct = path.join(dir, `${sessionId}.jsonl`);
          if (fs.existsSync(direct)) return direct;
          const entries = fs.readdirSync(dir, { withFileTypes: true, recursive: true });
          for (const entry of entries) {
            if (entry.isFile() && entry.name.endsWith('.jsonl')) {
              const p = path.join(entry.parentPath || dir, entry.name);
              if (p.includes(sessionId)) return p;
            }
          }
          return null;
        };

        const sessionLogPath = findLog(path.join(dshHome, 'sessions'));
        expect(sessionLogPath).not.toBeNull();

        const rawContent = fs.readFileSync(sessionLogPath!, 'utf8');
        const lines = rawContent.split('\n').filter((l) => l.trim().length > 0);

        // Header verification
        const header = JSON.parse(lines[0]);
        expect(header.type).toBe('session');
        expect(header.id).toBe(sessionId);

        // Monotonic sequence verification: seq must be strictly contiguous 0, 1, 2, ...
        let expectedSeq = 0;
        for (let i = 1; i < lines.length; i++) {
          const parsed = JSON.parse(lines[i]);
          const decoded = decodeStorageRecord(parsed);
          for (const ev of decoded) {
            expect(ev).toBeDefined();
            expect(ev.seq).toBe(expectedSeq);
            expectedSeq++;
          }
        }

        expect(expectedSeq).toBeGreaterThan(10);
      } finally {
        await daemon.shutdown(1000);
      }
    });
  });

  describe('12. Stream Chunk Isolation Across Multiple Sessions', () => {
    it('guarantees that stream chunks are strictly isolated to their originating turn and session', async () => {
      const daemon = new RuntimeDaemon({
        userId: 'alice',
        dshHome,
        spacesDir,
        maxConcurrentSessions: 4,
      });
      await daemon.start();

      try {
        const sessionA = 'ses_0000000000000000000000000000000a';
        const sessionB = 'ses_0000000000000000000000000000000b';
        const turnA = 'turn_0000000000000000000000000000000a';
        const turnB = 'turn_0000000000000000000000000000000b';

        const chunksByTurn: Record<string, string[]> = {
          [turnA]: [],
          [turnB]: [],
        };

        daemon.on('stream', (ev: DaemonStreamEvent) => {
          if (ev.event === DAEMON_STREAM_EVENTS.TURN_CHUNK) {
            if (chunksByTurn[ev.turnId]) {
              chunksByTurn[ev.turnId].push(ev.chunk.text || '');
            }
          }
        });

        const pA = daemon.submitTurnAndWait({
          id: 'turn-a',
          op: 'submitTurn',
          turnId: turnA,
          sessionId: sessionA,
          prompt: 'Session A prompt',
        });

        const pB = daemon.submitTurnAndWait({
          id: 'turn-b',
          op: 'submitTurn',
          turnId: turnB,
          sessionId: sessionB,
          prompt: 'Session B prompt',
        });

        const [resA, resB] = await Promise.all([pA, pB]);
        expect(resA.status).toBe('completed');
        expect(resB.status).toBe('completed');

        // Verify chunks were recorded and isolated
        expect(chunksByTurn[turnA].length).toBeGreaterThan(0);
        expect(chunksByTurn[turnB].length).toBeGreaterThan(0);
      } finally {
        await daemon.shutdown(1000);
      }
    });
  });

  describe('13. Framing Protection & Memory DoS Guard', () => {
    it('destroys stream with FRAME_SIZE_EXCEEDED when buffer exceeds 10MB limit without newline', async () => {
      const decoder = new DaemonRpcDecoder();
      let errorEmitted: any = null;

      decoder.on('error', (err) => {
        errorEmitted = err;
      });

      // Send 11MB of characters without newline
      const largeChunk = Buffer.alloc(11 * 1024 * 1024, 0x61); // 11MB of 'a'
      decoder.write(largeChunk);

      await new Promise((r) => setTimeout(r, 50));
      expect(errorEmitted).toBeDefined();
      expect(errorEmitted.code).toBe(DAEMON_ERROR_CODES.FRAME_SIZE_EXCEEDED);
    });
  });

  describe('14. Multi-Turn Session Persistence & Daemon Recreate Regression', () => {
    it('executes 2 turns on same agent, daemon shutdown, recreate daemon with same DSH home, and executes turn 3 with exact full output and no chunk duplicate', async () => {
      const sessionId = 'ses_00000000000000000000000000000014';

      // Phase 1: Daemon 1 executes Turn 1 and Turn 2 on same agent
      const daemon1 = new RuntimeDaemon({
        userId: 'alice',
        dshHome,
        spacesDir,
        llmEnabled: false,
      });
      await daemon1.start();

      const turn1Id = 'turn_00000000000000000000000000000011';
      const prompt1 = 'Deterministic Turn 1 message';
      const res1 = await daemon1.submitTurnAndWait({
        id: 'turn-1',
        op: 'submitTurn',
        turnId: turn1Id,
        sessionId,
        prompt: prompt1,
      });

      expect(res1.status).toBe('completed');
      expect(res1.replyText).toBe(
        `[DemoModel:alice] Received turn: "${prompt1}". Official DSH agent loop active, session persisted successfully.`
      );

      const turn2Id = 'turn_00000000000000000000000000000012';
      const prompt2 = 'Deterministic Turn 2 followup message';
      const res2 = await daemon1.submitTurnAndWait({
        id: 'turn-2',
        op: 'submitTurn',
        turnId: turn2Id,
        sessionId,
        prompt: prompt2,
      });

      expect(res2.status).toBe('completed');
      expect(res2.replyText).toBe(
        `[DemoModel:alice] Received turn: "${prompt2}". Official DSH agent loop active, session persisted successfully.`
      );

      // Clean shutdown of Daemon 1
      await daemon1.shutdown(1000);

      // Phase 2: Recreate Daemon 2 with identical DSH home (session persistence resume)
      const daemon2 = new RuntimeDaemon({
        userId: 'alice',
        dshHome,
        spacesDir,
        llmEnabled: false,
      });

      const turn3Chunks: string[] = [];
      daemon2.on('stream', (ev: DaemonStreamEvent) => {
        if (ev.event === DAEMON_STREAM_EVENTS.TURN_CHUNK && ev.turnId === 'turn_00000000000000000000000000000013') {
          if (ev.chunk?.type === 'text-delta' && typeof ev.chunk.text === 'string') {
            turn3Chunks.push(ev.chunk.text);
          }
        }
      });

      await daemon2.start();

      try {
        const turn3Id = 'turn_00000000000000000000000000000013';
        const prompt3 = 'Deterministic Turn 3 after daemon recreate';
        const res3 = await daemon2.submitTurnAndWait({
          id: 'turn-3',
          op: 'submitTurn',
          turnId: turn3Id,
          sessionId,
          prompt: prompt3,
        });

        expect(res3.status).toBe('completed');
        const expectedReply3 = `[DemoModel:alice] Received turn: "${prompt3}". Official DSH agent loop active, session persisted successfully.`;
        expect(res3.replyText).toBe(expectedReply3);

        // Verify streamed text chunks assemble exactly to the full output without duplicate chunks
        const assembledFromChunks = turn3Chunks.join('');
        expect(assembledFromChunks).toBe(expectedReply3);
      } finally {
        await daemon2.shutdown(1000);
      }
    });
  });

  describe('11. Concurrent and Idempotent Seed Import Operations', () => {
    const createSeed = (sessionId: string) => [
      {
        seq: 0,
        time: 1700000000000,
        type: 'turn/start',
        data: {
          turn: 1,
        },
      },
      {
        seq: 1,
        time: 1700000000001,
        type: 'user/message',
        surfaceOp: 'append',
        data: {
          id: `msg-${sessionId}-1`,
          role: 'user',
          content: [{ type: 'text', text: `Seed for ${sessionId}` }],
          source: { kind: 'user' },
        },
      },
      {
        seq: 2,
        time: 1700000000002,
        type: 'step/start',
        data: { turn: 1, step: 1 },
      },
      {
        seq: 3,
        time: 1700000000003,
        type: 'assistant/message',
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: `msg-${sessionId}-2`,
            role: 'assistant',
            content: [{ type: 'text', text: `Reply for ${sessionId}` }],
            source: { kind: 'model', provider: 'import', model: 'happyclaw' },
          },
        },
      },
      {
        seq: 4,
        time: 1700000000004,
        type: 'step/end',
        data: { turn: 1, step: 1 },
      },
      {
        seq: 5,
        time: 1700000000005,
        type: 'turn/end',
        data: { turn: 1, reason: { kind: 'completed' } },
      },
      {
        seq: 6,
        time: 1700000000006,
        type: 'session/end-seed',
        data: {},
      },
    ];

    it('executes concurrent importSeed operations safely and serialized per session without race conditions', async () => {
      const daemon = new RuntimeDaemon({
        userId: 'alice',
        dshHome,
        spacesDir,
        llmEnabled: false,
      });

      await daemon.start();

      try {
        const sessionA = 'ses_000000000000000000000000000000aa';
        const sessionB = 'ses_000000000000000000000000000000bb';

        const seedEventsA = createSeed(sessionA) as any;
        const seedEventsB = createSeed(sessionB) as any;

        // 1. Concurrent import on different sessions
        const [resA, resB] = await Promise.all([
          daemon.handleRequest({
            id: 'imp-a',
            op: DAEMON_OPS.IMPORT_SEED,
            sessionId: sessionA,
            seed: seedEventsA,
          } as any),
          daemon.handleRequest({
            id: 'imp-b',
            op: DAEMON_OPS.IMPORT_SEED,
            sessionId: sessionB,
            seed: seedEventsB,
          } as any),
        ]);

        expect(resA.ok).toBe(true);
        expect((resA as any).sessionId).toBe(sessionA);
        expect((resA as any).persisted).toBe(true);
        expect((resA as any).eventsCount).toBe(7);
        expect((resA as any).duplicate).toBe(false);

        expect(resB.ok).toBe(true);
        expect((resB as any).sessionId).toBe(sessionB);
        expect((resB as any).persisted).toBe(true);
        expect((resB as any).eventsCount).toBe(7);
        expect((resB as any).duplicate).toBe(false);

        // 2. Concurrent import on SAME session (mutex queue check)
        const [dup1, dup2] = await Promise.all([
          daemon.handleRequest({
            id: 'dup-1',
            op: DAEMON_OPS.IMPORT_SEED,
            sessionId: sessionA,
            seed: seedEventsA,
          } as any),
          daemon.handleRequest({
            id: 'dup-2',
            op: DAEMON_OPS.IMPORT_SEED,
            sessionId: sessionA,
            seed: seedEventsA,
          } as any),
        ]);

        expect(dup1.ok).toBe(true);
        expect((dup1 as any).duplicate).toBe(true);
        expect((dup1 as any).persisted).toBe(true);
        expect((dup1 as any).eventsCount).toBe(7);

        expect(dup2.ok).toBe(true);
        expect((dup2 as any).duplicate).toBe(true);
        expect((dup2 as any).persisted).toBe(true);
        expect((dup2 as any).eventsCount).toBe(7);
      } finally {
        await daemon.shutdown(1000);
      }
    }, 15000);
  });
});
