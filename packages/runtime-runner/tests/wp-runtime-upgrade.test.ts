/**
 * Synthetic tests for WP-runtime DSH 0.2.0-rc.2 upgrade:
 * - Handle-based persistence (stat, open/close)
 * - Session file discovery (v4-first with v0 fallback)
 * - importSeed producing valid v4 session through DSH format catalog
 * - Daemon streaming push from agent/assistant-stream
 * - Automatic migration of existing v0 session.jsonl on resume
 *
 * Rules: AGENTS.md synthetic data only.
 * @module @enkeep/runtime-runner/tests/wp-runtime-upgrade.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import {
  bootDshRuntime,
  computeSessionEventsChecksum,
  canonicalJsonStringify,
  type SessionSeedReceipt,
} from '../src/index.js';
import { RuntimeDaemon } from '../src/runtime/daemon.js';
import { DAEMON_STREAM_EVENTS } from '../src/runtime/daemon-protocol.js';

describe('WP-runtime DSH 0.2.0-rc.2 Upgrade Suite', () => {
  let tmpDir: string;
  let aliceHome: string;
  let aliceSpaces: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-wp-runtime-test-'));
    aliceHome = path.join(tmpDir, 'alice', '.dsh');
    aliceSpaces = path.join(tmpDir, 'alice', 'spaces');
    fs.mkdirSync(aliceHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(aliceSpaces, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(aliceSpaces, '.git'), { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('automatically migrates existing v0 session.jsonl to session.v4.jsonl on resume', async () => {
    const sessionId = 'ses_00000000000000000000000000000001';
    const spaceFolder = 'spc_00000000000000000000000000000001';
    const spacePath = path.join(aliceSpaces, spaceFolder);
    fs.mkdirSync(spacePath, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(spacePath, '.git'), { recursive: true });

    // Boot DSH runtime initially to resolve authoritative persistence layout
    const runtime = await bootDshRuntime({
      userId: 'user-alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
      llmEnabled: false,
    });

    let sessionDir: string;
    try {
      const persistence = runtime.context.sessionPersistence as any;
      const targetLoc = persistence.locate({
        id: sessionId,
        cwd: spacePath,
        version: 0,
        createdAt: 1700000000000,
        isSeeded: false,
        delegationDepth: 0,
      });
      sessionDir = path.dirname(targetLoc.path);
    } finally {
      await runtime.dispose();
    }

    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

    // Construct valid synthetic v0 session.jsonl
    const v0Lines = [
      JSON.stringify({
        type: 'session',
        version: 0,
        id: sessionId,
        createdAt: 1700000000000,
        cwd: spacePath,
        delegationDepth: 0,
      }),
      JSON.stringify({
        type: 'turn/start',
        seq: 0,
        time: 1700000000000,
        data: { turn: 1 },
      }),
      JSON.stringify({
        type: 'step/start',
        seq: 1,
        time: 1700000000001,
        data: { turn: 1, step: 1 },
      }),
      JSON.stringify({
        type: 'user/message',
        seq: 2,
        time: 1700000000002,
        surfaceOp: 'append',
        data: {
          id: 'msg_synth_v0_user_1',
          role: 'user',
          content: [{ type: 'text', text: 'Initial question from synthetic v0 transcript.' }],
          source: { kind: 'user' },
        },
      }),
      JSON.stringify({
        type: 'assistant/message',
        seq: 3,
        time: 1700000000003,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'msg_synth_v0_asst_1',
            role: 'assistant',
            content: [{ type: 'text', text: 'Answer stored in v0 format.' }],
            source: { kind: 'model', provider: 'mock', model: 'mock' },
          },
        },
      }),
      JSON.stringify({
        type: 'step/end',
        seq: 4,
        time: 1700000000004,
        data: { turn: 1, step: 1 },
      }),
      JSON.stringify({
        type: 'turn/end',
        seq: 5,
        time: 1700000000005,
        data: { turn: 1, reason: { kind: 'completed' } },
      }),
      '',
    ].join('\n');

    const v0LogPath = path.join(sessionDir, 'session.jsonl');
    fs.writeFileSync(v0LogPath, v0Lines, 'utf8');

    // Boot fresh DSH runtime on the existing directory
    const resumedRuntime = await bootDshRuntime({
      userId: 'user-alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
      llmEnabled: false,
    });

    try {
      // Resume the v0 session by sending turn 2
      const turn2Resp = await resumedRuntime.sendFollowup(
        'Follow-up query building on v0 history.',
        sessionId,
        'turn_00000000000000000000000000000002',
        null,
        spaceFolder
      );

      expect(turn2Resp.status).toBe('completed');
      expect(turn2Resp.persisted).toBe(true);

      // Verify DSH automatically created session.v4.jsonl beside session.jsonl
      const v4LogPath = path.join(sessionDir, 'session.v4.jsonl');
      expect(fs.existsSync(v4LogPath)).toBe(true);
      expect(fs.existsSync(v0LogPath)).toBe(true);

      // Verify v4 header and contents
      const v4Content = fs.readFileSync(v4LogPath, 'utf8');
      const headerLine = JSON.parse(v4Content.split('\n')[0]);
      expect(headerLine.version).toBe(4);
      expect(headerLine.id).toBe(sessionId);
      expect(v4Content).toContain('Initial question from synthetic v0 transcript.');
      expect(v4Content).toContain('Follow-up query building on v0 history.');
    } finally {
      await resumedRuntime.dispose();
    }
  });

  it('handles persistence handle API (stat for existence, open/close for reads)', async () => {
    const runtime = await bootDshRuntime({
      userId: 'user-alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
      llmEnabled: false,
    });

    try {
      const sessionId = 'ses_00000000000000000000000000000002';
      const persistence = runtime.context.sessionPersistence;
      expect(persistence).toBeDefined();

      // 1. Non-existent session returns undefined on stat
      const statNonExistent = await persistence.stat(SessionId(sessionId));
      expect(statNonExistent).toBeUndefined();

      // 2. Create session via sendFollowup
      await runtime.sendFollowup(
        'Test prompt for handle persistence.',
        sessionId,
        'turn_00000000000000000000000000000001',
        null
      );

      // 3. Existing session returns stat snapshot
      const statExisting = await persistence.stat(SessionId(sessionId));
      expect(statExisting).toBeDefined();
      expect(statExisting?.header.version).toBe(4);
      expect(statExisting?.header.id).toBe(sessionId);

      // 4. Open read handle, read events, and close
      const handle = await persistence.open(SessionId(sessionId), 'read');
      try {
        expect(handle.access).toBe('read');
        const readResult = await handle.read();
        expect(readResult.events.length).toBeGreaterThan(0);
        expect(readResult.events.some((e) => e.type === 'turn/start')).toBe(true);
      } finally {
        await handle.close();
      }
    } finally {
      await runtime.dispose();
    }
  });

  it('imports seed producing a valid v4 session through format catalog while preserving receipt checksum', async () => {
    const sessionId = 'ses_00000000000000000000000000000003';
    const seedEvents: SessionEvent[] = [
      {
        seq: 0,
        time: 1700000000000,
        type: 'turn/start',
        data: { turn: 1 },
      } as SessionEvent,
      {
        seq: 1,
        time: 1700000000001,
        type: 'user/message',
        surfaceOp: 'append',
        data: {
          id: 'msg_seed_synth_1',
          role: 'user',
          content: [{ type: 'text', text: 'Seeded question from HappyClaw transcript.' }],
          source: { kind: 'user' },
        },
      } as SessionEvent,
      {
        seq: 2,
        time: 1700000000002,
        type: 'step/start',
        data: { turn: 1, step: 1 },
      } as SessionEvent,
      {
        seq: 3,
        time: 1700000000003,
        type: 'assistant/message',
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'msg_seed_synth_2',
            role: 'assistant',
            content: [{ type: 'text', text: 'Seeded answer from imported transcript.' }],
            source: { kind: 'model', provider: 'import', model: 'happyclaw' },
          },
        },
      } as SessionEvent,
      {
        seq: 4,
        time: 1700000000004,
        type: 'step/end',
        data: { turn: 1, step: 1 },
      } as SessionEvent,
      {
        seq: 5,
        time: 1700000000005,
        type: 'turn/end',
        data: { turn: 1, reason: { kind: 'completed' } },
      } as SessionEvent,
      {
        seq: 6,
        time: 1700000000006,
        type: 'session/end-seed',
        data: {},
      } as SessionEvent,
    ];

    const checksum = computeSessionEventsChecksum(seedEvents);
    const canonicalJson = canonicalJsonStringify(seedEvents);
    const canonicalBytes = Buffer.byteLength(canonicalJson, 'utf8');
    const receipt: SessionSeedReceipt = {
      algorithm: 'sha256-session-events-v1',
      checksum,
      canonicalBytes,
      eventCount: seedEvents.length,
    };

    const runtime = await bootDshRuntime({
      userId: 'user-alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
      llmEnabled: false,
    });

    try {
      // 1. Initial import
      const result1 = await runtime.importSeed(sessionId, seedEvents, receipt, null);
      expect(result1.sessionId).toBe(sessionId);
      expect(result1.persisted).toBe(true);
      expect(result1.receipt.checksum).toBe(checksum);
      expect(result1.receipt.canonicalBytes).toBe(canonicalBytes);
      expect(result1.duplicate).toBe(false);

      // 2. Verify stored session is valid v4 in persistence
      const persistence = runtime.context.sessionPersistence;
      const stat = await persistence.stat(SessionId(sessionId));
      expect(stat).toBeDefined();
      expect(stat?.header.version).toBe(4);

      // 3. Idempotent re-import
      const result2 = await runtime.importSeed(sessionId, seedEvents, receipt, null);
      expect(result2.sessionId).toBe(sessionId);
      expect(result2.duplicate).toBe(true);
      expect(result2.receipt.checksum).toBe(checksum);

      // 4. Continue conversation after seed
      const followup = await runtime.sendFollowup(
        'Post-seed followup question.',
        sessionId,
        'turn_00000000000000000000000000000004',
        null
      );
      expect(followup.status).toBe('completed');
      expect(followup.persisted).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });

  it('pushes daemon stream chunks from agent/assistant-stream event', async () => {
    const daemon = new RuntimeDaemon({
      userId: 'user-alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
      llmEnabled: false,
    });

    await daemon.start();

    const streamedChunks: any[] = [];
    daemon.on('stream', (ev) => {
      if (ev.event === DAEMON_STREAM_EVENTS.TURN_CHUNK) {
        streamedChunks.push(ev);
      }
    });

    try {
      const sessionId = 'ses_00000000000000000000000000000005';
      const bootedRuntime = (daemon as any).bootedRuntime;
      const agent = await bootedRuntime.getOrCreateAgent(sessionId);
      const turnId = 'turn_00000000000000000000000000000005';

      // Track active turn in daemon
      (daemon as any).currentTurns.set(sessionId, { turnId });

      // Emit transient chunk frame via agent/assistant-stream
      bootedRuntime.context.emit('agent/assistant-stream', {
        agent,
        frame: {
          type: 'chunk',
          attemptId: 'att_01',
          revision: 1,
          index: 0,
          time: Date.now(),
          chunk: {
            type: 'text-delta',
            index: 0,
            text: 'Hello streamed token',
          },
        },
      });

      expect(streamedChunks.length).toBe(1);
      expect(streamedChunks[0].event).toBe('turn/chunk');
      expect(streamedChunks[0].turnId).toBe(turnId);
      expect(streamedChunks[0].sessionId).toBe(sessionId);
      expect(streamedChunks[0].chunk).toEqual({
        type: 'text-delta',
        index: 0,
        text: 'Hello streamed token',
      });
    } finally {
      await daemon.shutdown();
    }
  });

  it('discovers session log v4-first with fallback to legacy v0 session.jsonl', async () => {
    const runtime = await bootDshRuntime({
      userId: 'user-alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
      llmEnabled: false,
    });

    try {
      const sessionIdV4 = 'ses_00000000000000000000000000000006';
      const sessionIdV0 = 'ses_00000000000000000000000000000007';
      const spaceFolder = 'spc_00000000000000000000000000000002';
      const spacePath = path.join(aliceSpaces, spaceFolder);
      fs.mkdirSync(spacePath, { recursive: true, mode: 0o700 });

      const persistence = runtime.context.sessionPersistence as any;
      const v4Target = persistence.locate({
        id: sessionIdV4,
        cwd: spacePath,
        version: 4,
        createdAt: 1700000000000,
        isSeeded: false,
        delegationDepth: 0,
      }).path;
      const sessionDirV4 = path.dirname(v4Target);
      fs.mkdirSync(sessionDirV4, { recursive: true, mode: 0o700 });

      const v0Target = persistence.locate({
        id: sessionIdV0,
        cwd: spacePath,
        version: 0,
        createdAt: 1700000000000,
        isSeeded: false,
        delegationDepth: 0,
      }).path;
      const sessionDirV0 = path.dirname(v0Target);
      fs.mkdirSync(sessionDirV0, { recursive: true, mode: 0o700 });

      // Directory 1: Has both session.v4.jsonl and session.jsonl
      fs.writeFileSync(path.join(sessionDirV4, 'session.jsonl'), 'legacy\n', 'utf8');
      fs.writeFileSync(path.join(sessionDirV4, 'session.v4.jsonl'), 'current_v4\n', 'utf8');

      // Directory 2: Has only session.jsonl
      fs.writeFileSync(path.join(sessionDirV0, 'session.jsonl'), 'legacy_only\n', 'utf8');

      // Check discovery via internal checkSessionArtifact or path probe
      const artifact1 = await runtime.checkSessionArtifact(sessionIdV4, spaceFolder);
      expect(artifact1.exists).toBe(true);

      const artifact2 = await runtime.checkSessionArtifact(sessionIdV0, spaceFolder);
      expect(artifact2.exists).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });

  describe('seed conflict detection and idempotency', () => {
    const makeSeedEvents = (text: string): SessionEvent[] => [
      {
        seq: 0,
        time: 1700000000000,
        type: 'turn/start',
        data: { turn: 1 },
      } as SessionEvent,
      {
        seq: 1,
        time: 1700000000001,
        type: 'user/message',
        surfaceOp: 'append',
        data: {
          id: 'msg_seed_synth_1',
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        },
      } as SessionEvent,
      {
        seq: 2,
        time: 1700000000002,
        type: 'step/start',
        data: { turn: 1, step: 1 },
      } as SessionEvent,
      {
        seq: 3,
        time: 1700000000003,
        type: 'assistant/message',
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'msg_seed_synth_2',
            role: 'assistant',
            content: [{ type: 'text', text: `Answer to ${text}` }],
            source: { kind: 'model', provider: 'import', model: 'happyclaw' },
          },
        },
      } as SessionEvent,
      {
        seq: 4,
        time: 1700000000004,
        type: 'step/end',
        data: { turn: 1, step: 1 },
      } as SessionEvent,
      {
        seq: 5,
        time: 1700000000005,
        type: 'turn/end',
        data: { turn: 1, reason: { kind: 'completed' } },
      } as SessionEvent,
      {
        seq: 6,
        time: 1700000000006,
        type: 'session/end-seed',
        data: {},
      } as SessionEvent,
    ];

    const makeReceipt = (events: SessionEvent[]): SessionSeedReceipt => {
      const checksum = computeSessionEventsChecksum(events);
      const canonicalJson = canonicalJsonStringify(events);
      const canonicalBytes = Buffer.byteLength(canonicalJson, 'utf8');
      return {
        algorithm: 'sha256-session-events-v1',
        checksum,
        canonicalBytes,
        eventCount: events.length,
      };
    };

    it('same seed re-import is idempotent', async () => {
      const sessionId = 'ses_00000000000000000000000000000010';
      const seedEvents = makeSeedEvents('Idempotency test query');
      const receipt = makeReceipt(seedEvents);

      const runtime = await bootDshRuntime({
        userId: 'user-alice',
        dshHome: aliceHome,
        spacesDir: aliceSpaces,
        llmEnabled: false,
      });

      try {
        const first = await runtime.importSeed(sessionId, seedEvents, receipt, null);
        expect(first.sessionId).toBe(sessionId);
        expect(first.duplicate).toBe(false);
        expect(first.persisted).toBe(true);
        expect(first.eventsCount).toBe(seedEvents.length);
        expect(first.receipt.checksum).toBe(receipt.checksum);

        const second = await runtime.importSeed(sessionId, seedEvents, receipt, null);
        expect(second.sessionId).toBe(sessionId);
        expect(second.duplicate).toBe(true);
        expect(second.persisted).toBe(true);
        expect(second.eventsCount).toBe(seedEvents.length);
        expect(second.receipt.checksum).toBe(receipt.checksum);
      } finally {
        await runtime.dispose();
      }
    });

    it('different seed against existing session throws CONFLICT', async () => {
      const sessionId = 'ses_00000000000000000000000000000011';
      const seedA = makeSeedEvents('Original seed content');
      const receiptA = makeReceipt(seedA);
      const seedB = makeSeedEvents('Mutated different seed content');
      const receiptB = makeReceipt(seedB);

      const runtime = await bootDshRuntime({
        userId: 'user-alice',
        dshHome: aliceHome,
        spacesDir: aliceSpaces,
        llmEnabled: false,
      });

      try {
        await runtime.importSeed(sessionId, seedA, receiptA, null);

        // Attempting to import different seed against same sessionId must throw CONFLICT
        await expect(runtime.importSeed(sessionId, seedB, receiptB, null)).rejects.toThrow(/CONFLICT/);

        // Even after followup turns exist on session, different seed still throws CONFLICT
        const followup = await runtime.sendFollowup(
          'Followup on session A.',
          sessionId,
          'turn_00000000000000000000000000000013',
          null
        );
        expect(followup.status).toBe('completed');
        await expect(runtime.importSeed(sessionId, seedB, receiptB, null)).rejects.toThrow(/CONFLICT/);
      } finally {
        await runtime.dispose();
      }
    });

    it('existing session with follow-up turns detected', async () => {
      const sessionId = 'ses_00000000000000000000000000000012';
      const seedEvents = makeSeedEvents('Seed for followup detection');
      const receipt = makeReceipt(seedEvents);

      const runtime = await bootDshRuntime({
        userId: 'user-alice',
        dshHome: aliceHome,
        spacesDir: aliceSpaces,
        llmEnabled: false,
      });

      try {
        const initial = await runtime.importSeed(sessionId, seedEvents, receipt, null);
        expect(initial.duplicate).toBe(false);
        expect(initial.eventsCount).toBe(seedEvents.length);

        // Append a followup turn
        const followup = await runtime.sendFollowup(
          'Post-seed followup question for detection test.',
          sessionId,
          'turn_00000000000000000000000000000012',
          null
        );
        expect(followup.status).toBe('completed');

        // Re-import the seed on the session that now has follow-up turns
        const reimport = await runtime.importSeed(sessionId, seedEvents, receipt, null);
        expect(reimport.sessionId).toBe(sessionId);
        expect(reimport.duplicate).toBe(true);
        expect(reimport.persisted).toBe(true);
        // Follow-up turns detected: eventsCount reflects totalEvents > seedEvents.length
        expect(reimport.eventsCount).toBeGreaterThan(seedEvents.length);
        // Receipt remains computed over original raw seed
        expect(reimport.receipt.checksum).toBe(receipt.checksum);
        expect(reimport.receipt.eventCount).toBe(seedEvents.length);
      } finally {
        await runtime.dispose();
      }
    });
  });
});
