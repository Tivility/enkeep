/**
 * Genuine DSH Runtime Boot, Session Persistence, Multi-Session Switching,
 * Restart-Resume, Checksum-Verified Seed Import, and Turn Cancellation Tests
 *
 * @module @enkeep/runtime-runner/tests/dsh-runtime-boot.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import {
  bootDshRuntime,
  validateDshRuntimeBootConfig,
  PersistedSessionResumeError,
  computeSessionEventsChecksum,
  canonicalJsonStringify,
  TOOLS_UNAVAILABLE_REASONS,
  type SessionSeedReceipt,
  type DshRuntimeBootConfig,
} from '../src/index.js';

function findJsonlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { recursive: true });
  return entries
    .map((e) => path.join(dir, String(e)))
    .filter((p) => {
      try {
        return fs.statSync(p).isFile() && p.endsWith('.jsonl');
      } catch {
        return false;
      }
    });
}

describe('Official DSH Runtime Boot & Followup Integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-pkg-dsh-boot-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('boots genuine DSH runtime, applies typed bundle entries via @enkeep/dsh-enkeep-bundle, and returns full plugin readiness without YAML', async () => {
    const aliceHome = path.join(tmpDir, 'alice', '.dsh');
    const aliceSpaces = path.join(tmpDir, 'alice', 'spaces');
    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const health = await runtime.getHealth();
      expect(health.status).toBe('ok');
      expect(health.userId).toBe('alice');
      expect(health.dshReady).toBe(true);
      expect(health.enkeepBundleLoaded).toBe(true);
      expect(health.toolsCount).toBeGreaterThanOrEqual(4);
      expect(health.plugins).toBeDefined();
      expect(health.plugins.receiptStore).toBe(true);
      expect(health.plugins.inbound).toBe(true);
      expect(health.plugins.eventRelay).toBe(true);
      expect(health.plugins.tools).toBe(true);
      expect(health.toolsOperational).toBe(false);
      expect(health.toolsUnavailableReason).toBe(TOOLS_UNAVAILABLE_REASONS.PLATFORM_CLIENT_UNAVAILABLE);
      expect(health.plugins.externalInteraction).toBe(true);
      expect(health.plugins.affinityPolicy).toBe(true);
      expect(health.plugins.llmAffinity).toBe(true);
      expect(health.version).toBe('0.1.1-rc.2');

      // Verify receipts sqlite DB was created under $DSH_HOME/data/receipts.db
      const receiptsDbPath = path.join(aliceHome, 'data', 'receipts.db');
      expect(fs.existsSync(receiptsDbPath)).toBe(true);

      // Verify directory permissions mode 0o700 on created directories
      const statDshHome = fs.statSync(aliceHome);
      expect((statDshHome.mode & 0o777)).toBe(0o700);
      const statSpaces = fs.statSync(aliceSpaces);
      expect((statSpaces.mode & 0o777)).toBe(0o700);
    } finally {
      await runtime.dispose();
    }
  });

  it('strictly validates spacesDir and enforces sibling containment under dirname(dshHome)', () => {
    const aliceHome = path.join(tmpDir, 'alice', '.dsh');
    const aliceSpaces = path.join(tmpDir, 'alice', 'spaces');

    // Non-plain-object input
    expect(() => validateDshRuntimeBootConfig(null)).toThrow(/plain object/i);
    expect(() => validateDshRuntimeBootConfig('invalid')).toThrow(/plain object/i);

    // Unexpected keys
    expect(() =>
      validateDshRuntimeBootConfig({
        userId: 'alice',
        dshHome: aliceHome,
        spacesDir: aliceSpaces,
        unknownKey: 'hack',
      })
    ).toThrow(/Unexpected boot configuration key/);

    // Missing spacesDir
    const missingSpaces: Omit<DshRuntimeBootConfig, 'spacesDir'> = {
      userId: 'alice',
      dshHome: aliceHome,
    };
    expect(() => validateDshRuntimeBootConfig(missingSpaces)).toThrow(/Invalid or missing "spacesDir"/);

    // Relative spacesDir
    expect(() =>
      validateDshRuntimeBootConfig({
        userId: 'alice',
        dshHome: aliceHome,
        spacesDir: 'relative/spaces',
      })
    ).toThrow(/Invalid or missing "spacesDir"/);

    // Non-sibling spacesDir (arbitrary path rejected)
    expect(() =>
      validateDshRuntimeBootConfig({
        userId: 'alice',
        dshHome: aliceHome,
        spacesDir: path.join(tmpDir, 'other', 'spaces'),
      })
    ).toThrow(/must be a sibling directory under dirname\(dshHome\)/);

    // Non-spaces basename rejected
    expect(() =>
      validateDshRuntimeBootConfig({
        userId: 'alice',
        dshHome: aliceHome,
        spacesDir: path.join(tmpDir, 'alice', 'custom-spaces'),
      })
    ).toThrow(/named "spaces"/);

    // Invalid provider/model
    expect(() =>
      validateDshRuntimeBootConfig({
        userId: 'alice',
        dshHome: aliceHome,
        spacesDir: aliceSpaces,
        provider: 'bad/provider',
      })
    ).toThrow(/Invalid "provider"/);

    expect(() =>
      validateDshRuntimeBootConfig({
        userId: 'alice',
        dshHome: aliceHome,
        spacesDir: aliceSpaces,
        model: 'bad/model',
      })
    ).toThrow(/Invalid "model"/);

    // Invalid chunkDelayMs
    expect(() =>
      validateDshRuntimeBootConfig({
        userId: 'alice',
        dshHome: aliceHome,
        spacesDir: aliceSpaces,
        chunkDelayMs: -1,
      })
    ).toThrow(/Invalid "chunkDelayMs"/);

    expect(() =>
      validateDshRuntimeBootConfig({
        userId: 'alice',
        dshHome: aliceHome,
        spacesDir: aliceSpaces,
        chunkDelayMs: 20000,
      })
    ).toThrow(/Invalid "chunkDelayMs"/);

    // Valid configuration produces normalized boot config
    const validated = validateDshRuntimeBootConfig({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
      provider: 'custom-provider',
      model: 'custom-model',
      chunkDelayMs: 100,
    });
    expect(validated.userId).toBe('alice');
    expect(validated.dshHome).toBe(aliceHome);
    expect(validated.spacesDir).toBe(aliceSpaces);
    expect(validated.provider).toBe('custom-provider');
    expect(validated.model).toBe('custom-model');
    expect(validated.chunkDelayMs).toBe(100);
  });

  it('enforces mode 0o700 even on pre-existing directories created with mode 0o755', async () => {
    const aliceHome = path.join(tmpDir, 'alice-perms', '.dsh');
    const aliceSpaces = path.join(tmpDir, 'alice-perms', 'spaces');

    // Create directories with permissive mode 0o755
    fs.mkdirSync(aliceHome, { recursive: true, mode: 0o755 });
    fs.mkdirSync(aliceSpaces, { recursive: true, mode: 0o755 });
    fs.chmodSync(aliceHome, 0o755);
    fs.chmodSync(aliceSpaces, 0o755);

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const statHome = fs.statSync(aliceHome);
      expect((statHome.mode & 0o777)).toBe(0o700);

      const statSpaces = fs.statSync(aliceSpaces);
      expect((statSpaces.mode & 0o777)).toBe(0o700);
    } finally {
      await runtime.dispose();
    }
  });

  it('supports full bundle unload / disposal and reload cycles without state corruption', async () => {
    const aliceHome = path.join(tmpDir, 'alice', '.dsh');
    const aliceSpaces = path.join(tmpDir, 'alice', 'spaces');

    // Cycle 1: Boot, verify plugins, and dispose
    const runtime1 = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });
    const health1 = await runtime1.getHealth();
    expect(health1.enkeepBundleLoaded).toBe(true);
    await runtime1.dispose();

    // Cycle 2: Boot fresh runtime on same volume, verify plugins re-emerge cleanly
    const runtime2 = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });
    try {
      const health2 = await runtime2.getHealth();
      expect(health2.enkeepBundleLoaded).toBe(true);
      expect(health2.plugins.receiptStore).toBe(true);
      expect(health2.plugins.inbound).toBe(true);
      expect(health2.plugins.eventRelay).toBe(true);
      expect(health2.plugins.tools).toBe(true);
      expect(health2.toolsOperational).toBe(false);
      expect(health2.plugins.externalInteraction).toBe(true);
      expect(health2.plugins.affinityPolicy).toBe(true);
      expect(health2.plugins.llmAffinity).toBe(true);
    } finally {
      await runtime2.dispose();
    }
  });

  it('runs multi-turn conversation and verifies JSONL persistence is flushed and intact', async () => {
    const aliceHome = path.join(tmpDir, 'alice', '.dsh');
    const aliceSpaces = path.join(tmpDir, 'alice', 'spaces');
    const sessionId = 'ses_11111111111111111111111111111111';

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      // Turn 1
      const turn1Resp = await runtime.sendFollowup(
        'Turn 1: Initialize user project profile.',
        sessionId,
        'turn_11111111111111111111111111111111',
        null
      );
      expect(turn1Resp.status).toBe('completed');
      expect(turn1Resp.replyText).toContain('[DemoModel:alice]');
      expect(turn1Resp.eventsCount).toBeGreaterThan(0);
      expect(turn1Resp.persisted).toBe(true);

      // Turn 2
      const turn2Resp = await runtime.sendFollowup(
        'Turn 2: Run code analysis on workspace.',
        sessionId,
        'turn_22222222222222222222222222222222',
        null
      );
      expect(turn2Resp.status).toBe('completed');
      expect(turn2Resp.replyText).toContain('[DemoModel:alice]');
      expect(turn2Resp.eventsCount).toBeGreaterThan(turn1Resp.eventsCount);
      expect(turn2Resp.persisted).toBe(true);

      // Verify physical JSONL file was written
      const sessionsDir = path.join(aliceHome, 'sessions');
      const jsonlFiles = findJsonlFiles(sessionsDir);
      expect(jsonlFiles.length).toBeGreaterThan(0);

      const jsonlContent = fs.readFileSync(jsonlFiles[0] as string, 'utf8');
      expect(jsonlContent).toContain(sessionId);
      expect(jsonlContent).toContain('Turn 1: Initialize user project profile.');
      expect(jsonlContent).toContain('Turn 2: Run code analysis on workspace.');
    } finally {
      await runtime.dispose();
    }
  });

  it('supports multiple independent sessions simultaneously within one booted runtime', async () => {
    const aliceHome = path.join(tmpDir, 'alice', '.dsh');
    const aliceSpaces = path.join(tmpDir, 'alice', 'spaces');
    const sessionA = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const sessionB = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const respA1 = await runtime.sendFollowup(
        'Thread A: Step 1',
        sessionA,
        'turn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
        null
      );
      expect(respA1.sessionId).toBe(sessionA);
      expect(respA1.status).toBe('completed');

      const respB1 = await runtime.sendFollowup(
        'Thread B: Step 1',
        sessionB,
        'turn_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1',
        null
      );
      expect(respB1.sessionId).toBe(sessionB);
      expect(respB1.status).toBe('completed');

      const respA2 = await runtime.sendFollowup(
        'Thread A: Step 2',
        sessionA,
        'turn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2',
        null
      );
      expect(respA2.sessionId).toBe(sessionA);
      expect(respA2.eventsCount).toBeGreaterThan(respA1.eventsCount);
    } finally {
      await runtime.dispose();
    }
  });

  it('successfully resumes existing session from persisted JSONL on new runtime instance', async () => {
    const aliceHome = path.join(tmpDir, 'alice', '.dsh');
    const aliceSpaces = path.join(tmpDir, 'alice', 'spaces');
    const sessionId = 'ses_22222222222222222222222222222222';

    // Instance 1: write initial turn
    const runtime1 = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });
    const turn1Resp = await runtime1.sendFollowup(
      'Pre-restart instruction: save database schema.',
      sessionId,
      'turn_22222222222222222222222222222221',
      null
    );
    expect(turn1Resp.status).toBe('completed');
    await runtime1.dispose();

    // Instance 2: boot fresh runtime on the same directory and continue session
    const runtime2 = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });
    try {
      const turn2Resp = await runtime2.sendFollowup(
        'Post-restart instruction: migrate data tables.',
        sessionId,
        'turn_22222222222222222222222222222222',
        null
      );
      expect(turn2Resp.status).toBe('completed');
      expect(turn2Resp.eventsCount).toBeGreaterThan(turn1Resp.eventsCount);

      // Verify that both turns exist in the persisted file
      const jsonlFiles = findJsonlFiles(path.join(aliceHome, 'sessions'));
      const combinedLog = fs.readFileSync(jsonlFiles[0] as string, 'utf8');
      expect(combinedLog).toContain('Pre-restart instruction: save database schema.');
      expect(combinedLog).toContain('Post-restart instruction: migrate data tables.');
    } finally {
      await runtime2.dispose();
    }
  });

  it('fails loudly with PersistedSessionResumeError on corrupt persisted session file', async () => {
    const aliceHome = path.join(tmpDir, 'alice', '.dsh');
    const aliceSpaces = path.join(tmpDir, 'alice', 'spaces');
    const corruptSessionId = 'ses_33333333333333333333333333333333';

    // Create a legitimate session first
    const initRuntime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });
    await initRuntime.sendFollowup(
      'Legitimate turn before corruption.',
      corruptSessionId,
      'turn_33333333333333333333333333333331',
      null
    );
    await initRuntime.dispose();

    // Intentionally corrupt the session file with garbage data
    const jsonlFiles = findJsonlFiles(path.join(aliceHome, 'sessions'));
    expect(jsonlFiles.length).toBeGreaterThan(0);
    fs.writeFileSync(jsonlFiles[0] as string, 'INVALID_JSON_CORRUPT_BYTE_STREAM\n{not: json}\n', 'utf8');

    // Attempt to boot fresh runtime and resume corrupted session
    const resumeRuntime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      await expect(
        resumeRuntime.sendFollowup(
          'Attempt turn on corrupted session',
          corruptSessionId,
          'turn_33333333333333333333333333333332',
          null
        )
      ).rejects.toThrow(PersistedSessionResumeError);
    } finally {
      await resumeRuntime.dispose();
    }
  });

  it('imports seed with verified canonical checksum and supports idempotent duplicate import', async () => {
    const aliceHome = path.join(tmpDir, 'alice', '.dsh');
    const aliceSpaces = path.join(tmpDir, 'alice', 'spaces');
    const importedSessionId = 'import-00000000000000000000000000000001';

    // Construct valid seed SessionEvents conforming to @deepseek-ai/dsh-session invariants
    const seedEvents: SessionEvent[] = [
      {
        seq: 0,
        time: 1700000000000,
        type: 'turn/start',
        data: {
          turn: 1,
        },
      } as SessionEvent,
      {
        seq: 1,
        time: 1700000000001,
        type: 'user/message',
        surfaceOp: 'append',
        data: {
          id: 'msg-seed-1',
          role: 'user',
          content: [{ type: 'text', text: 'Hello from HappyClaw historical transcript.' }],
          source: { kind: 'user' },
        },
      } as SessionEvent,
      {
        seq: 2,
        time: 1700000000002,
        type: 'step/start',
        data: {
          turn: 1,
          step: 1,
        },
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
            id: 'msg-seed-2',
            role: 'assistant',
            content: [{ type: 'text', text: 'Acknowledged historical message.' }],
            source: { kind: 'model', provider: 'import', model: 'happyclaw' },
          },
        },
      } as SessionEvent,
      {
        seq: 4,
        time: 1700000000004,
        type: 'step/end',
        data: {
          turn: 1,
          step: 1,
        },
      } as SessionEvent,
      {
        seq: 5,
        time: 1700000000005,
        type: 'turn/end',
        data: {
          turn: 1,
          reason: { kind: 'completed' },
        },
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
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      // 1. Initial import
      const result1 = await runtime.importSeed(importedSessionId, seedEvents, receipt, null);
      expect(result1.sessionId).toBe(importedSessionId);
      expect(result1.persisted).toBe(true);
      expect(result1.receipt.checksum).toBe(checksum);
      expect(result1.receipt.canonicalBytes).toBe(canonicalBytes);
      expect(result1.duplicate).toBe(false);

      // 2. Idempotent re-import with exact same receipt
      const result2 = await runtime.importSeed(importedSessionId, seedEvents, receipt, null);
      expect(result2.sessionId).toBe(importedSessionId);
      expect(result2.persisted).toBe(true);
      expect(result2.receipt.canonicalBytes).toBe(canonicalBytes);
      expect(result2.duplicate).toBe(true);

      // 3. Verify receipt was persisted in receiptStore SQLite service
      const receiptStore = runtime.context.receiptStore;
      expect(receiptStore).toBeDefined();
      const storedReceipt = await receiptStore.getSeedImportReceipt(importedSessionId);
      expect(storedReceipt).toBeDefined();
      expect(storedReceipt.sessionId).toBe(importedSessionId);
      expect(storedReceipt.checksum).toBe(checksum);
      expect(storedReceipt.canonicalBytes).toBe(canonicalBytes);
      expect(storedReceipt.eventCount).toBe(seedEvents.length);
      expect(storedReceipt.algorithm).toBe('sha256-session-events-v1');

      // 4. Mismatched checksum import rejection
      const invalidReceipt: SessionSeedReceipt = {
        algorithm: 'sha256-session-events-v1',
        checksum: '0000000000000000000000000000000000000000000000000000000000000000',
        canonicalBytes,
        eventCount: seedEvents.length,
      };

      await expect(
        runtime.importSeed('ses_44444444444444444444444444444444', seedEvents, invalidReceipt, null)
      ).rejects.toThrow(/checksum verification failed/i);

      // 5. Continue conversation after imported seed
      const followupResp = await runtime.sendFollowup(
        'Turn 3: Post-import question to agent.',
        importedSessionId,
        'turn_44444444444444444444444444444443',
        null
      );
      expect(followupResp.status).toBe('completed');
      expect(followupResp.eventsCount).toBeGreaterThan(4);
    } finally {
      await runtime.dispose();
    }
  });

  it('supports guarded prefix re-import after followup turns: duplicate is true, total eventsCount is preserved, receipt reflects original seed, and session remains resumable', async () => {
    const aliceHome = path.join(tmpDir, 'alice', '.dsh');
    const aliceSpaces = path.join(tmpDir, 'alice', 'spaces');
    const sessionId = 'ses_55555555555555555555555555555555';

    const seedEvents: SessionEvent[] = [
      {
        seq: 0,
        time: 1700000000000,
        type: 'turn/start',
        data: {
          turn: 1,
        },
      } as SessionEvent,
      {
        seq: 1,
        time: 1700000000001,
        type: 'user/message',
        surfaceOp: 'append',
        data: {
          id: 'msg-seed-prefix-1',
          role: 'user',
          content: [{ type: 'text', text: 'Seeded question from transcript.' }],
          source: { kind: 'user' },
        },
      } as SessionEvent,
      {
        seq: 2,
        time: 1700000000002,
        type: 'step/start',
        data: {
          turn: 1,
          step: 1,
        },
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
            id: 'msg-seed-prefix-2',
            role: 'assistant',
            content: [{ type: 'text', text: 'Seeded answer from assistant.' }],
            source: { kind: 'model', provider: 'import', model: 'happyclaw' },
          },
        },
      } as SessionEvent,
      {
        seq: 4,
        time: 1700000000004,
        type: 'step/end',
        data: {
          turn: 1,
          step: 1,
        },
      } as SessionEvent,
      {
        seq: 5,
        time: 1700000000005,
        type: 'turn/end',
        data: {
          turn: 1,
          reason: { kind: 'completed' },
        },
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

    const runtime1 = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      // 1. Fresh import original seed -> duplicate is false
      const freshImport = await runtime1.importSeed(sessionId, seedEvents, receipt, null);
      expect(freshImport.sessionId).toBe(sessionId);
      expect(freshImport.duplicate).toBe(false);
      expect(freshImport.persisted).toBe(true);
      expect(freshImport.eventsCount).toBe(seedEvents.length);
      expect(freshImport.receipt.checksum).toBe(checksum);
      expect(freshImport.receipt.canonicalBytes).toBe(canonicalBytes);
      expect(freshImport.receipt.eventCount).toBe(seedEvents.length);

      // 2. Append a real followup to same session
      const followup1 = await runtime1.sendFollowup(
        'Turn 2: Followup after original seed import.',
        sessionId,
        'turn_55555555555555555555555555555552',
        null
      );
      expect(followup1.status).toBe('completed');
      expect(followup1.eventsCount).toBeGreaterThan(seedEvents.length);
      const totalEventsAfterFollowup1 = followup1.eventsCount;

      // 3. Re-import exact original seed -> duplicate is true
      const reimport = await runtime1.importSeed(sessionId, seedEvents, receipt, null);
      expect(reimport.sessionId).toBe(sessionId);
      expect(reimport.duplicate).toBe(true);
      expect(reimport.persisted).toBe(true);

      // eventsCount remains total > original
      expect(reimport.eventsCount).toBe(totalEventsAfterFollowup1);
      expect(reimport.eventsCount).toBeGreaterThan(seedEvents.length);

      // returned receipt still matches original seed checksum/canonicalBytes/eventCount seed.length
      expect(reimport.receipt.algorithm).toBe('sha256-session-events-v1');
      expect(reimport.receipt.checksum).toBe(checksum);
      expect(reimport.receipt.canonicalBytes).toBe(canonicalBytes);
      expect(reimport.receipt.eventCount).toBe(seedEvents.length);

      // 4. Send subsequent followup to ensure session remains active and not corrupted
      const followup2 = await runtime1.sendFollowup(
        'Turn 3: Subsequent followup after reimport.',
        sessionId,
        'turn_55555555555555555555555555555553',
        null
      );
      expect(followup2.status).toBe('completed');
      expect(followup2.eventsCount).toBeGreaterThan(totalEventsAfterFollowup1);
    } finally {
      await runtime1.dispose();
    }

    // 5. Verify subsequent session remains resumable on a new runtime instance and appended events are not truncated
    const runtime2 = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const followup3 = await runtime2.sendFollowup(
        'Turn 4: Post-restart instruction.',
        sessionId,
        'turn_55555555555555555555555555555554',
        null
      );
      expect(followup3.status).toBe('completed');
      expect(followup3.eventsCount).toBeGreaterThan(seedEvents.length);

      // Verify physical JSONL persistence contains all seed and followup events without truncation
      const jsonlFiles = findJsonlFiles(path.join(aliceHome, 'sessions'));
      expect(jsonlFiles.length).toBeGreaterThan(0);
      const combinedLog = fs.readFileSync(jsonlFiles[0] as string, 'utf8');
      expect(combinedLog).toContain('Seeded question from transcript.');
      expect(combinedLog).toContain('Turn 2: Followup after original seed import.');
      expect(combinedLog).toContain('Turn 3: Subsequent followup after reimport.');
      expect(combinedLog).toContain('Turn 4: Post-restart instruction.');
    } finally {
      await runtime2.dispose();
    }
  });

  it('supports in-process turn cancellation using cancelTurn(turnId)', async () => {
    const aliceHome = path.join(tmpDir, 'alice', '.dsh');
    const aliceSpaces = path.join(tmpDir, 'alice', 'spaces');
    const sessionId = 'ses_66666666666666666666666666666666';
    const turnId = 'turn_66666666666666666666666666666666';

    // Boot with chunkDelayMs to simulate slow streaming LLM response
    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
      chunkDelayMs: 50,
    });

    try {
      const followupPromise = runtime.sendFollowup('Slow query to be cancelled', sessionId, turnId, null);

      // Trigger cancellation after slight delay while turn is actively streaming
      await new Promise((r) => setTimeout(r, 40));
      const cancelled = await runtime.cancelTurn(turnId);
      expect(cancelled).toBe(true);

      const resp = await followupPromise;
      expect(resp.status).toBe('cancelled');
      expect(resp.turnId).toBe(turnId);
    } finally {
      await runtime.dispose();
    }
  });

  it('supports prompt-controlled delay and immediate cancellation with [enkeep-test-delay-ms=5000]', async () => {
    const aliceHome = path.join(tmpDir, 'alice', '.dsh');
    const aliceSpaces = path.join(tmpDir, 'alice', 'spaces');
    const sessionId = 'ses_77777777777777777777777777777777';
    const turnId = 'turn_77777777777777777777777777777777';

    // Boot standard runtime with default 0 chunk delay
    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const followupPromise = runtime.sendFollowup(
        'Long running operation [enkeep-test-delay-ms=5000]',
        sessionId,
        turnId,
        null
      );

      // Verify turn is actively streaming / delayed
      await new Promise((r) => setTimeout(r, 60));
      const cancelled = await runtime.cancelTurn(turnId);
      expect(cancelled).toBe(true);

      const resp = await followupPromise;
      expect(resp.status).toBe('cancelled');
      expect(resp.turnId).toBe(turnId);
    } finally {
      await runtime.dispose();
    }
  });

  it('strictly requires sessionId for sendFollowup without falling back to last active session', async () => {
    const aliceHome = path.join(tmpDir, 'alice', '.dsh');
    const aliceSpaces = path.join(tmpDir, 'alice', 'spaces');
    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const sessionId = 'ses_0123456789abcdef0123456789abcdef';
      await runtime.sendFollowup(
        'Turn 1 initialize',
        sessionId,
        'turn_0123456789abcdef0123456789abcdef',
        null
      );

      // Attempting sendFollowup without sessionId or empty sessionId must throw
      await expect((runtime as any).sendFollowup('Turn 2 prompt', '', 'turn_0123456789abcdef0123456789abcde1', null)).rejects.toThrow(/sessionId is required/);
      await expect((runtime as any).sendFollowup('Turn 2 prompt', undefined, 'turn_0123456789abcdef0123456789abcde2', null)).rejects.toThrow(/sessionId is required/);
      await expect((runtime as any).sendFollowup('Turn 2 prompt', null, 'turn_0123456789abcdef0123456789abcde3', null)).rejects.toThrow(/sessionId is required/);
    } finally {
      await runtime.dispose();
    }
  });

  it('strictly validates userId and rejects fallback or invalid patterns', async () => {
    const invalidHome = path.join(tmpDir, 'invalid', '.dsh');
    const invalidSpaces = path.join(tmpDir, 'invalid', 'spaces');

    // Missing userId
    await expect(
      bootDshRuntime({
        userId: '',
        dshHome: invalidHome,
        spacesDir: invalidSpaces,
      })
    ).rejects.toThrow(/Invalid or missing "userId"/);

    // Invalid userId characters
    await expect(
      bootDshRuntime({
        userId: 'alice/../bad',
        dshHome: invalidHome,
        spacesDir: invalidSpaces,
      })
    ).rejects.toThrow(/Invalid or missing "userId"/);
  });

  it('guarantees complete isolation between distinct user runtime instances (Alice vs Bob)', async () => {
    const aliceHome = path.join(tmpDir, 'alice', '.dsh');
    const aliceSpaces = path.join(tmpDir, 'alice', 'spaces');
    const bobHome = path.join(tmpDir, 'bob', '.dsh');
    const bobSpaces = path.join(tmpDir, 'bob', 'spaces');

    const aliceRuntime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    const bobRuntime = await bootDshRuntime({
      userId: 'bob',
      dshHome: bobHome,
      spacesDir: bobSpaces,
    });

    try {
      const aliceResp = await aliceRuntime.sendFollowup(
        'Secret message from Alice: Project Alpha',
        'ses_88888888888888888888888888888888',
        'turn_88888888888888888888888888888881',
        null
      );
      const bobResp = await bobRuntime.sendFollowup(
        'Secret message from Bob: Project Beta',
        'ses_88888888888888888888888888888888',
        'turn_88888888888888888888888888888882',
        null
      );

      expect(aliceResp.replyText).toContain('[DemoModel:alice]');
      expect(aliceResp.replyText).toContain('Project Alpha');

      expect(bobResp.replyText).toContain('[DemoModel:bob]');
      expect(bobResp.replyText).toContain('Project Beta');

      // Assert distinct physical file storage
      const aliceJsonl = findJsonlFiles(path.join(aliceHome, 'sessions'));
      const bobJsonl = findJsonlFiles(path.join(bobHome, 'sessions'));

      expect(aliceJsonl.length).toBeGreaterThan(0);
      expect(bobJsonl.length).toBeGreaterThan(0);

      const aliceContent = fs.readFileSync(aliceJsonl[0] as string, 'utf8');
      const bobContent = fs.readFileSync(bobJsonl[0] as string, 'utf8');

      expect(aliceContent).toContain('Project Alpha');
      expect(aliceContent).not.toContain('Project Beta');

      expect(bobContent).toContain('Project Beta');
      expect(bobContent).not.toContain('Project Alpha');
    } finally {
      await aliceRuntime.dispose();
      await bobRuntime.dispose();
    }
  });

  it('guarantees bundle composition is 100% typed code without runtime YAML parsing or file reading', async () => {
    const isolationDir = path.join(tmpDir, 'isolated-env');
    fs.mkdirSync(isolationDir, { recursive: true });
    const isolatedHome = path.join(isolationDir, '.dsh');

    // Spy on fs.readFileSync to verify no .yml or .yaml files are read during boot
    const originalReadFileSync = fs.readFileSync;
    const yamlReadAttempts: string[] = [];
    const readSpy = (targetPath: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]): ReturnType<typeof fs.readFileSync> => {
      if (typeof targetPath === 'string' && (targetPath.endsWith('.yml') || targetPath.endsWith('.yaml'))) {
        yamlReadAttempts.push(targetPath);
      }
      return originalReadFileSync(targetPath, options);
    };
    fs.readFileSync = readSpy as typeof fs.readFileSync;

    try {
      const runtime = await bootDshRuntime({
        userId: 'isolation-user',
        dshHome: isolatedHome,
        spacesDir: path.join(isolationDir, 'spaces'),
      });

      const health = await runtime.getHealth();
      expect(health.status).toBe('ok');
      expect(health.enkeepBundleLoaded).toBe(true);
      expect(yamlReadAttempts).toHaveLength(0);

      await runtime.dispose();
    } finally {
      fs.readFileSync = originalReadFileSync;
    }
  });

  it('bootDshRuntime fails loudly with security violation when process.getuid is unavailable', async () => {
    const originalGetuid = process.getuid;
    try {
      (process as unknown as { getuid?: () => number }).getuid = undefined;
      const aliceHome = path.join(tmpDir, 'alice', '.dsh');
      const aliceSpaces = path.join(tmpDir, 'alice', 'spaces');
      await expect(
        bootDshRuntime({
          userId: 'alice',
          dshHome: aliceHome,
          spacesDir: aliceSpaces,
        })
      ).rejects.toThrow(/process\.getuid is required/);
    } finally {
      process.getuid = originalGetuid;
    }
  });

  it('getTurnResultAfterSeq and extractTurnResultFromEvents independently derive exact authoritative replyText from session events', async () => {
    const aliceHome = path.join(tmpDir, 'alice-turn-extract', '.dsh');
    const aliceSpaces = path.join(tmpDir, 'alice-turn-extract', 'spaces');

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
      llmEnabled: false,
    });

    try {
      const sessionId = 'ses_99999999999999999999999999999999';
      const agent = await runtime.getOrCreateAgent(sessionId);
      const beforeSeq1 = agent.session.seq;

      const turn1Prompt = 'First turn prompt for result extraction';
      const turn1Id = 'turn_99999999999999999999999999999991';
      const res1 = await runtime.sendFollowup(turn1Prompt, sessionId, turn1Id, null);

      const turn1Derived = runtime.getTurnResultAfterSeq!(sessionId, beforeSeq1);
      expect(turn1Derived).toBeDefined();
      expect(turn1Derived?.replyText).toBe(res1.replyText);
      expect(turn1Derived?.replyText).toBe(
        `[DemoModel:alice] Received turn: "${turn1Prompt}". Official DSH agent loop active, session persisted successfully.`
      );
      expect(turn1Derived?.isCancelled).toBe(false);

      const beforeSeq2 = agent.session.seq;
      const turn2Prompt = 'Second turn followup prompt';
      const turn2Id = 'turn_99999999999999999999999999999992';
      const res2 = await runtime.sendFollowup(turn2Prompt, sessionId, turn2Id, null);

      const turn2Derived = runtime.getTurnResultAfterSeq!(sessionId, beforeSeq2);
      expect(turn2Derived).toBeDefined();
      expect(turn2Derived?.replyText).toBe(res2.replyText);
      expect(turn2Derived?.replyText).toBe(
        `[DemoModel:alice] Received turn: "${turn2Prompt}". Official DSH agent loop active, session persisted successfully.`
      );
      expect(turn2Derived?.isCancelled).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });
});
