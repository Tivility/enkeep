import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RuntimeDaemon } from '../src/runtime/daemon.js';

describe('Piece 2(a): RuntimeDaemon compactSession handler', () => {
  let tmpDir: string;
  let dshHome: string;
  let spacesDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-daemon-compact-test-'));
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

  it('boots an agent with turns of fake messages, calls handleCompactSession directly, gains compaction/summary event and has fewer live messages', async () => {
    const sessionId = 'ses_00000000000000000000000000000099';
    const spaceName = 'space-compact-test';
    const spacePath = path.join(spacesDir, spaceName);
    fs.mkdirSync(spacePath, { recursive: true, mode: 0o700 });

    const daemon = new RuntimeDaemon({
      userId: 'alice',
      dshHome,
      spacesDir,
      contextWindow: 2000,
      maxTokens: 512,
      compaction: {
        thresholdRatio: 0.9, // High threshold so auto compaction does not trigger early
        retainTokens: 10,
        auto: false,
      },
    });

    await daemon.start();

    try {
      // 1. Send Turn 1
      const res1 = await daemon.submitTurnAndWait({
        id: 'req-1',
        op: 'submitTurn',
        turnId: 'turn_00000000000000000000000000000001',
        sessionId,
        prompt: 'Step 1: First user message with initial task description.',
        workspaceFolder: spaceName,
      });
      expect(res1.status).toBe('completed');

      // 2. Send Turn 2 with repeated text to increase message size
      const res2 = await daemon.submitTurnAndWait({
        id: 'req-2',
        op: 'submitTurn',
        turnId: 'turn_00000000000000000000000000000002',
        sessionId,
        prompt: 'Step 2: Second user message with detailed architectural plan. '.repeat(10),
        workspaceFolder: spaceName,
      });
      expect(res2.status).toBe('completed');

      // 3. Send Turn 3
      const res3 = await daemon.submitTurnAndWait({
        id: 'req-3',
        op: 'submitTurn',
        turnId: 'turn_00000000000000000000000000000003',
        sessionId,
        prompt: 'Step 3: Third user message with implementation verification.',
        workspaceFolder: spaceName,
      });
      expect(res3.status).toBe('completed');

      // 4. Measure live messages/nodes before manual compaction
      const tokenMeter = (daemon as any).bootedRuntime.context.get('tokenMeter');
      expect(tokenMeter).toBeDefined();

      const managedEntry = (daemon as any).agents.get(sessionId);
      expect(managedEntry).toBeDefined();

      const measurementBefore = tokenMeter.measure(managedEntry.agent.session);
      const liveNodesBefore = measurementBefore.nodes.length;
      expect(liveNodesBefore).toBeGreaterThanOrEqual(3);

      // 5. Call handleCompactSession directly
      const compactRes = await daemon.handleCompactSession({
        id: 'req-compact-1',
        op: 'compactSession',
        sessionId,
      });

      expect(compactRes.ok).toBe(true);
      if (compactRes.ok) {
        expect(compactRes.eventsBefore).toBeGreaterThan(0);
        expect(compactRes.eventsAfter).toBeGreaterThan(compactRes.eventsBefore);
        expect(compactRes.summaryChars).toBeGreaterThan(0);
      }

      // 6. Assert live surface messages/nodes decreased
      const measurementAfter = tokenMeter.measure(managedEntry.agent.session);
      const liveNodesAfter = measurementAfter.nodes.length;
      expect(liveNodesAfter).toBeLessThan(liveNodesBefore);

      // 7. Assert session gained compaction summary event
      const sessionEvents = managedEntry.agent.session.snapshotEvents();
      const eventTypes = sessionEvents.map((e: any) => e.type);
      expect(eventTypes).toContain('compaction/start');
      expect(eventTypes).toContain('compaction/summary');
      expect(eventTypes).toContain('compaction/end');

      // 8. Rejection test when a turn is active
      (daemon as any).currentTurns.set(sessionId, { turnId: 'turn_active_fake' });
      const busyRes = await daemon.handleCompactSession({
        id: 'req-compact-busy',
        op: 'compactSession',
        sessionId,
      });
      expect(busyRes.ok).toBe(false);
      expect((busyRes as any).error?.code).toBe('TURN_ACTIVE');
      (daemon as any).currentTurns.delete(sessionId);
    } finally {
      await daemon.shutdown();
    }
  });

  it('routes compactSession via handleRequest and isolates changes to target session only', async () => {
    const sessionA = 'ses_0000000000000000000000000000000a';
    const sessionB = 'ses_0000000000000000000000000000000b';
    const spaceName = 'space-multi-session';
    const spacePath = path.join(spacesDir, spaceName);
    fs.mkdirSync(spacePath, { recursive: true, mode: 0o700 });

    const daemon = new RuntimeDaemon({
      userId: 'alice',
      dshHome,
      spacesDir,
      contextWindow: 2000,
      maxTokens: 512,
      compaction: {
        thresholdRatio: 0.9,
        retainTokens: 10,
        auto: false,
      },
    });

    await daemon.start();

    try {
      // Seed session A with turns
      await daemon.submitTurnAndWait({
        id: 'req-a1',
        op: 'submitTurn',
        turnId: 'turn_000000000000000000000000000000a1',
        sessionId: sessionA,
        prompt: 'Session A message 1: initial task specification.',
        workspaceFolder: spaceName,
      });
      await daemon.submitTurnAndWait({
        id: 'req-a2',
        op: 'submitTurn',
        turnId: 'turn_000000000000000000000000000000a2',
        sessionId: sessionA,
        prompt: 'Session A message 2: detailed implementation plan. '.repeat(10),
        workspaceFolder: spaceName,
      });
      await daemon.submitTurnAndWait({
        id: 'req-a3',
        op: 'submitTurn',
        turnId: 'turn_000000000000000000000000000000a3',
        sessionId: sessionA,
        prompt: 'Session A message 3: execution log verification.',
        workspaceFolder: spaceName,
      });

      // Seed session B with turns
      await daemon.submitTurnAndWait({
        id: 'req-b1',
        op: 'submitTurn',
        turnId: 'turn_000000000000000000000000000000b1',
        sessionId: sessionB,
        prompt: 'Session B message 1: independent task context.',
        workspaceFolder: spaceName,
      });
      await daemon.submitTurnAndWait({
        id: 'req-b2',
        op: 'submitTurn',
        turnId: 'turn_000000000000000000000000000000b2',
        sessionId: sessionB,
        prompt: 'Session B message 2: independent followup step.',
        workspaceFolder: spaceName,
      });

      const entryB = (daemon as any).agents.get(sessionB);
      expect(entryB).toBeDefined();
      const eventsBBefore = entryB.agent.session.snapshotEvents().length;
      const tokenMeter = (daemon as any).bootedRuntime.context.get('tokenMeter');
      const nodesBBefore = tokenMeter.measure(entryB.agent.session).nodes.length;

      // Execute compaction via handleRequest route for session A
      const routeRes = await daemon.handleRequest({
        id: 'req-route-compact-a',
        op: 'compactSession',
        sessionId: sessionA,
      });

      expect(routeRes.ok).toBe(true);
      expect(routeRes.op).toBe('compactSession');
      const compactRes = routeRes as any;
      expect(compactRes.eventsBefore).toBeGreaterThan(0);
      expect(compactRes.eventsAfter).toBeGreaterThan(compactRes.eventsBefore);
      expect(compactRes.summaryChars).toBeGreaterThan(0);

      // Verify Session B was strictly untouched
      const eventsBAfter = entryB.agent.session.snapshotEvents().length;
      const nodesBAfter = tokenMeter.measure(entryB.agent.session).nodes.length;
      expect(eventsBAfter).toBe(eventsBBefore);
      expect(nodesBAfter).toBe(nodesBBefore);
      const eventTypesB = entryB.agent.session.snapshotEvents().map((e: any) => e.type);
      expect(eventTypesB).not.toContain('compaction/start');
      expect(eventTypesB).not.toContain('compaction/summary');
      expect(eventTypesB).not.toContain('compaction/end');
    } finally {
      await daemon.shutdown();
    }
  });

  it('returns explicit COMPACTION_UNSUPPORTED error when compaction service is unavailable', async () => {
    const sessionId = 'ses_00000000000000000000000000000099';
    const spaceName = 'space-compact-unsupported';
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

    try {
      await daemon.submitTurnAndWait({
        id: 'req-1',
        op: 'submitTurn',
        turnId: 'turn_00000000000000000000000000000001',
        sessionId,
        prompt: 'Initial message before mocking unsupported compaction.',
        workspaceFolder: spaceName,
      });

      // Temporarily mock compaction service as undefined
      const origGet = (daemon as any).bootedRuntime.context.get.bind((daemon as any).bootedRuntime.context);
      (daemon as any).bootedRuntime.context.get = (name: string) => {
        if (name === 'compaction') return undefined;
        return origGet(name);
      };

      const unsupportedRes = await daemon.handleCompactSession({
        id: 'req-compact-unsupported',
        op: 'compactSession',
        sessionId,
      });

      expect(unsupportedRes.ok).toBe(false);
      expect((unsupportedRes as any).error?.code).toBe('COMPACTION_UNSUPPORTED');
      expect((unsupportedRes as any).error?.message).toContain('Explicit compaction is unsupported');

      // Restore context.get
      (daemon as any).bootedRuntime.context.get = origGet;
    } finally {
      await daemon.shutdown();
    }
  });
});
