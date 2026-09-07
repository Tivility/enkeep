/**
 * Reset Dual-Run Idempotency, Tenant Isolation, and Web Message Visibility Tests
 *
 * Verifies:
 * 1. Dual execution of demo:reset is fully idempotent, produces byte-stable manifests,
 *    and never throws duplicate key or constraint violation errors.
 * 2. SQLite storage for Alice contains >= 20 user and >= 20 assistant messages for the imported session.
 * 3. Bob tenant queries return ZERO records for Alice's spaces, sessions, messages, or events.
 *
 * @module @enkeep/demo-runner/tests/reset-idempotency-and-isolation.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { SqliteWebMessageStore } from '@enkeep/platform-server';
import { resetDemo } from '../src/reset/index.js';
import { launchDemoSystem, loadAndVerifyFixedSeeds } from '../src/up/index.js';
import { getDemoPathConfig } from '../src/config.js';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';
import { FakeUnitRuntimeContainerAdapter } from './support/fake-runtime.js';

describe('Demo Reset Dual-Run Idempotency & Multi-Tenant SQLite Isolation', () => {
  let tempRepo: TempRepo;

  beforeEach(() => {
    tempRepo = createTempRepo();
  });

  afterEach(() => {
    tempRepo.cleanup();
  });

  it('executes demo:reset twice in succession with 100% idempotency and byte-stable output', async () => {
    const fixedTimestamp = '2026-03-30T12:00:00.000Z';

    // 1. First reset run
    const result1 = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      forceClean: true,
      deterministicCreatedAt: fixedTimestamp,
    });

    expect(result1.ok).toBe(true);
    expect(result1.importedChatsCount).toBeGreaterThanOrEqual(1);
    expect(result1.importedMessagesCount).toBeGreaterThanOrEqual(40);
    expect(existsSync(result1.manifestPath)).toBe(true);
    const manifestContent1 = readFileSync(result1.manifestPath, 'utf8');

    // Inspect SQLite row counts after first reset
    const db1 = new DatabaseSync(result1.dbPath);
    const msgCount1 = (db1.prepare('SELECT COUNT(*) as count FROM web_messages').get() as { count: number }).count;
    const eventCount1 = (db1.prepare('SELECT COUNT(*) as count FROM web_events').get() as { count: number }).count;
    const spaceCount1 = (db1.prepare('SELECT COUNT(*) as count FROM spaces').get() as { count: number }).count;
    const routeCount1 = (db1.prepare('SELECT COUNT(*) as count FROM session_routes').get() as { count: number }).count;
    const sourceCount1 = (db1.prepare('SELECT COUNT(*) as count FROM session_sources').get() as { count: number }).count;
    db1.close();

    expect(msgCount1).toBeGreaterThanOrEqual(40);
    expect(eventCount1).toBeGreaterThanOrEqual(40);

    // 2. Second reset run (with forceClean: false to test non-destructive idempotency)
    const result2 = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      forceClean: false,
      deterministicCreatedAt: fixedTimestamp,
    });

    expect(result2.ok).toBe(true);
    expect(result2.importedChatsCount).toBe(result1.importedChatsCount);
    expect(result2.importedMessagesCount).toBe(result1.importedMessagesCount);
    const manifestContent2 = readFileSync(result2.manifestPath, 'utf8');

    // Manifests must be byte-identical
    expect(manifestContent1).toBe(manifestContent2);

    // Inspect SQLite row counts after second reset (MUST be 100% identical without duplicates)
    const db2 = new DatabaseSync(result2.dbPath);
    const msgCount2 = (db2.prepare('SELECT COUNT(*) as count FROM web_messages').get() as { count: number }).count;
    const eventCount2 = (db2.prepare('SELECT COUNT(*) as count FROM web_events').get() as { count: number }).count;
    const spaceCount2 = (db2.prepare('SELECT COUNT(*) as count FROM spaces').get() as { count: number }).count;
    const routeCount2 = (db2.prepare('SELECT COUNT(*) as count FROM session_routes').get() as { count: number }).count;
    const sourceCount2 = (db2.prepare('SELECT COUNT(*) as count FROM session_sources').get() as { count: number }).count;
    db2.close();

    expect(msgCount2).toBe(msgCount1);
    expect(eventCount2).toBe(eventCount1);
    expect(spaceCount2).toBe(spaceCount1);
    expect(routeCount2).toBe(routeCount1);
    expect(sourceCount2).toBe(sourceCount1);
  });

  it('populates Alice SQLite database with >= 20 user + >= 20 assistant messages while strictly isolating from Bob', async () => {
    const resetResult = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      forceClean: true,
    });
    expect(resetResult.ok).toBe(true);

    const db = new DatabaseSync(resetResult.dbPath);
    const storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);

    const aliceUser = await storage.users.findByUsername('alice');
    const bobUser = await storage.users.findByUsername('bob');

    expect(aliceUser).not.toBeNull();
    expect(bobUser).not.toBeNull();
    const aliceId = aliceUser!.id;
    const bobId = bobUser!.id;

    const aliceTenant = storage.forTenant(aliceId);
    const bobTenant = storage.forTenant(bobId);

    // 1. Verify Alice has imported space
    const aliceSpaces = await aliceTenant.spaces.list();
    expect(aliceSpaces.length).toBeGreaterThanOrEqual(1);
    const aliceImportedSpace = aliceSpaces.find((s) => s.folder === 'alice-space');
    expect(aliceImportedSpace).toBeDefined();

    // 2. Verify Alice has imported session route
    const aliceRoutes = await aliceTenant.sessionRoutes.list();
    expect(aliceRoutes.length).toBeGreaterThanOrEqual(1);
    const targetSession = aliceRoutes[0]!;
    const sessionId = targetSession.id;

    // 3. Verify Alice has >= 20 user and >= 20 assistant messages
    const aliceHistory = await messageStore.listMessages(aliceId, sessionId, { limit: 100 });
    const messages = aliceHistory.messages;
    expect(messages.length).toBeGreaterThanOrEqual(40);

    const userMsgs = messages.filter((m) => m.role === 'user');
    const asstMsgs = messages.filter((m) => m.role === 'assistant');

    expect(userMsgs.length).toBeGreaterThanOrEqual(20);
    expect(asstMsgs.length).toBeGreaterThanOrEqual(20);

    // Verify messages have valid non-empty content
    for (const msg of messages) {
      expect(msg.content).toBeDefined();
      expect(msg.content.trim().length).toBeGreaterThan(0);
      expect(msg.status).toBe('delivered');
    }

    // 4. Multi-Tenant Isolation Assertion: Bob queries MUST return ZERO records for Alice's data
    const bobSpaces = await bobTenant.spaces.list();
    const bobHasAliceSpace = bobSpaces.some((s) => s.folder === 'alice-space' || s.id === aliceImportedSpace?.id);
    expect(bobHasAliceSpace).toBe(false);

    const bobQueryAliceSession = await bobTenant.sessionRoutes.findById(sessionId);
    expect(bobQueryAliceSession).toBeNull();

    const bobQueryAliceMessages = await messageStore.listMessages(bobId, sessionId, { limit: 100 });
    expect(bobQueryAliceMessages.messages).toHaveLength(0);

    const bobRawMessagesQuery = db.prepare('SELECT * FROM web_messages WHERE session_id = ? AND user_id = ?').all(sessionId, bobId);
    expect(bobRawMessagesQuery).toHaveLength(0);

    const bobRawEventsQuery = db.prepare('SELECT * FROM web_events WHERE session_id = ? AND user_id = ?').all(sessionId, bobId);
    expect(bobRawEventsQuery).toHaveLength(0);

    // 5. Container-Only Invariant: Zero spaces have execution_mode = 'host'
    const hostSpaces = db.prepare("SELECT * FROM spaces WHERE execution_mode = 'host'").all();
    expect(hostSpaces).toHaveLength(0);
    expect((resetResult.spaces as Record<string, unknown>).aliceHostSpace).toBeUndefined();
    expect(resetResult.spaces.aliceContainerSpace.executionMode).toBe('container');
    expect(resetResult.spaces.bobContainerSpace.executionMode).toBe('container');

    await storage.close();
  });

  it('demo:up fails closed on historical DB containing execution_mode=host without altering or deleting legacy data', async () => {
    // 1. Reset initial demo environment
    const resetResult = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      forceClean: true,
    });
    expect(resetResult.ok).toBe(true);

    // 2. Simulate historical DB by inserting legacy records with execution_mode = 'host'
    const db = new DatabaseSync(resetResult.dbPath);
    const aliceUser = db.prepare("SELECT id FROM users WHERE username = 'alice'").get() as { id: string };
    expect(aliceUser).toBeDefined();

    db.prepare(`
      INSERT INTO spaces (id, user_id, name, folder, execution_mode)
      VALUES ('legacy_sp_host', ?, 'Legacy Alice Host Space', 'legacy-host', 'host')
    `).run(aliceUser.id);

    db.prepare(`
      INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode)
      VALUES ('legacy_ses_host', 'legacy_sp_host', ?, 'web', 'web-demo', 'ctx_legacy', 'p_legacy', 'dsh_legacy', 'host')
    `).run(aliceUser.id);

    db.prepare(`
      INSERT INTO turn_runs (id, user_id, space_id, route_id, turn_id, status, execution_mode)
      VALUES ('legacy_turn_host', ?, 'legacy_sp_host', 'legacy_ses_host', 'turn_legacy', 'completed', 'host')
    `).run(aliceUser.id);

    // Verify raw host records exist before startup
    const preHostSpaces = db.prepare("SELECT * FROM spaces WHERE execution_mode = 'host'").all();
    const preHostRoutes = db.prepare("SELECT * FROM session_routes WHERE execution_mode = 'host'").all();
    const preHostTurns = db.prepare("SELECT * FROM turn_runs WHERE execution_mode = 'host'").all();
    expect(preHostSpaces.length).toBe(1);
    expect(preHostRoutes.length).toBe(1);
    expect(preHostTurns.length).toBe(1);

    const preSpaceCount = (db.prepare('SELECT COUNT(*) as c FROM spaces').get() as { c: number }).c;
    const preRouteCount = (db.prepare('SELECT COUNT(*) as c FROM session_routes').get() as { c: number }).c;
    const preTurnCount = (db.prepare('SELECT COUNT(*) as c FROM turn_runs').get() as { c: number }).c;
    db.close();

    // 3. Attempt to launch demo system with demo:up -> MUST fail closed with guidance to demo:reset
    const fakeAdapter = new FakeUnitRuntimeContainerAdapter();
    await expect(
      launchDemoSystem({
        repoRoot: tempRepo.repoRoot,
        runtimeAdapter: fakeAdapter,
      })
    ).rejects.toThrow(/FAIL-CLOSED: Legacy host execution mode detected in demo database.*demo:reset/);

    // 4. Verify post-failure state in SQLite: host records are preserved untouched for audit (NO silent rewrite, NO data deletion)
    const verifyDb = new DatabaseSync(resetResult.dbPath);
    const postHostSpaces = verifyDb.prepare("SELECT * FROM spaces WHERE execution_mode = 'host'").all();
    const postHostRoutes = verifyDb.prepare("SELECT * FROM session_routes WHERE execution_mode = 'host'").all();
    const postHostTurns = verifyDb.prepare("SELECT * FROM turn_runs WHERE execution_mode = 'host'").all();

    expect(postHostSpaces).toHaveLength(1);
    expect(postHostRoutes).toHaveLength(1);
    expect(postHostTurns).toHaveLength(1);

    // Verify no data was deleted or corrupted
    const postSpaceCount = (verifyDb.prepare('SELECT COUNT(*) as c FROM spaces').get() as { c: number }).c;
    const postRouteCount = (verifyDb.prepare('SELECT COUNT(*) as c FROM session_routes').get() as { c: number }).c;
    const postTurnCount = (verifyDb.prepare('SELECT COUNT(*) as c FROM turn_runs').get() as { c: number }).c;

    expect(postSpaceCount).toBe(preSpaceCount);
    expect(postRouteCount).toBe(preRouteCount);
    expect(postTurnCount).toBe(preTurnCount);

    const legacySpace = verifyDb.prepare("SELECT * FROM spaces WHERE id = 'legacy_sp_host'").get() as { execution_mode: string; name: string };
    expect(legacySpace.execution_mode).toBe('host');
    expect(legacySpace.name).toBe('Legacy Alice Host Space');

    const legacyRoute = verifyDb.prepare("SELECT * FROM session_routes WHERE id = 'legacy_ses_host'").get() as { execution_mode: string };
    expect(legacyRoute.execution_mode).toBe('host');

    const legacyTurn = verifyDb.prepare("SELECT * FROM turn_runs WHERE id = 'legacy_turn_host'").get() as { execution_mode: string };
    expect(legacyTurn.execution_mode).toBe('host');

    verifyDb.close();
  });

  it('repeatedly launches launchDemoSystem 5 times in succession with 100% seed import idempotency and zero corruption', async () => {
    const fixedTimestamp = '2026-03-30T12:00:00.000Z';
    const resetResult = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      forceClean: true,
      deterministicCreatedAt: fixedTimestamp,
    });
    expect(resetResult.ok).toBe(true);

    const fakeAdapter = new FakeUnitRuntimeContainerAdapter();

    for (let iteration = 1; iteration <= 5; iteration++) {
      const running = await launchDemoSystem({
        repoRoot: tempRepo.repoRoot,
        runtimeAdapter: fakeAdapter,
      });

      expect(running.result.ok).toBe(true);
      expect(running.runtimeHandles.size).toBe(2);

      // Verify that after launch, Alice runtime handle is healthy
      const aliceUser = await running.storage.users.findByUsername('alice');
      expect(aliceUser).toBeDefined();
      const aliceHandle = running.runtimeHandles.get(aliceUser!.id);
      expect(aliceHandle).toBeDefined();

      const health = await aliceHandle!.checkHealth();
      expect(health.status).toBe('ok');
      expect(health.dshReady).toBe(true);

      // Cleanly close platform system preserving volumes and db for next iteration
      await running.close({ removeVolumes: false });
    }
  });

  it('concurrently imports seeds across Alice and Bob runtime handles safely', async () => {
    const fixedTimestamp = '2026-03-30T12:00:00.000Z';
    const resetResult = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      forceClean: true,
      deterministicCreatedAt: fixedTimestamp,
    });
    expect(resetResult.ok).toBe(true);

    const fakeAdapter = new FakeUnitRuntimeContainerAdapter();
    const running = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      runtimeAdapter: fakeAdapter,
    });

    try {
      const aliceUser = await running.storage.users.findByUsername('alice');
      const bobUser = await running.storage.users.findByUsername('bob');
      const aliceHandle = running.runtimeHandles.get(aliceUser!.id)!;
      const bobHandle = running.runtimeHandles.get(bobUser!.id)!;

      const seedAlice = [
        { type: 'session/created', seq: 0, time: 1000, data: { id: 'ses_alice_conc_001' } },
        { type: 'user/message', seq: 1, time: 1001, data: { text: 'Alice concurrent seed' } },
      ];
      const seedBob = [
        { type: 'session/created', seq: 0, time: 1000, data: { id: 'ses_bob_conc_001' } },
        { type: 'user/message', seq: 1, time: 1001, data: { text: 'Bob concurrent seed' } },
      ];

      // Concurrently import into Alice and Bob handles
      const [resAlice, resBob] = await Promise.all([
        aliceHandle.importSeed!('ses_alice_conc_001', seedAlice),
        bobHandle.importSeed!('ses_bob_conc_001', seedBob),
      ]);

      expect(['ok', 'completed', 'imported']).toContain(resAlice.status);
      expect(resAlice.sessionId).toBe('ses_alice_conc_001');
      expect(resAlice.persisted).toBe(true);
      expect(resAlice.eventsCount).toBe(2);

      expect(['ok', 'completed', 'imported']).toContain(resBob.status);
      expect(resBob.sessionId).toBe('ses_bob_conc_001');
      expect(resBob.persisted).toBe(true);
      expect(resBob.eventsCount).toBe(2);

      // Concurrent re-import of same seeds (idempotency check)
      const [reAlice, reBob] = await Promise.all([
        aliceHandle.importSeed!('ses_alice_conc_001', seedAlice),
        bobHandle.importSeed!('ses_bob_conc_001', seedBob),
      ]);

      expect(['ok', 'completed', 'imported']).toContain(reAlice.status);
      expect(reAlice.duplicate).toBe(true);
      expect(['ok', 'completed', 'imported']).toContain(reBob.status);
      expect(reBob.duplicate).toBe(true);
    } finally {
      await running.close({ removeVolumes: true });
    }
  });

  it('verifies exact fixture receipt from reset -> import -> append turn -> restart -> reimport same seed receipt', async () => {
    const fixedTimestamp = '2026-03-30T12:00:00.000Z';
    const resetResult = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      forceClean: true,
      deterministicCreatedAt: fixedTimestamp,
    });
    expect(resetResult.ok).toBe(true);

    const pathOptions = { repoRoot: tempRepo.repoRoot };
    const paths = getDemoPathConfig(pathOptions);
    const verifiedSeeds = loadAndVerifyFixedSeeds(paths.importDir, pathOptions);
    expect(verifiedSeeds.length).toBe(2);

    const targetSeed = verifiedSeeds[0];
    const { sessionId, seedEvents, receipt } = targetSeed;

    const fakeAdapter = new FakeUnitRuntimeContainerAdapter();

    // 1. Initial Launch & Seed Import
    const running1 = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      runtimeAdapter: fakeAdapter,
    });
    expect(running1.result.ok).toBe(true);

    const aliceUser = await running1.storage.users.findByUsername('alice');
    const aliceHandle1 = running1.runtimeHandles.get(aliceUser!.id)!;

    // 2. Append a turn to the imported session
    const turnRes = await aliceHandle1.sendTurn!({
      prompt: 'Followup turn on imported seed session',
      sessionId,
      turnId: 'turn_seed_followup_001',
    });
    expect(turnRes.replyText).toBeDefined();

    // 3. Restart / Close without removing volumes
    await running1.close({ removeVolumes: false });

    // 4. Relaunch demo system (simulating restart)
    const running2 = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      runtimeAdapter: fakeAdapter,
    });
    expect(running2.result.ok).toBe(true);

    try {
      const aliceHandle2 = running2.runtimeHandles.get(aliceUser!.id)!;

      // 5. Reimport same seed and receipt directly on handle
      const reimportRes = await aliceHandle2.importSeed!(sessionId, seedEvents, receipt);
      expect(['ok', 'completed', 'imported']).toContain(reimportRes.status);
      expect(reimportRes.persisted).toBe(true);
      expect(reimportRes.duplicate).toBe(true);
      expect(reimportRes.receipt.checksum).toBe(receipt.checksum);
      expect(reimportRes.receipt.canonicalBytes).toBe(receipt.canonicalBytes);
      expect(reimportRes.receipt.eventCount).toBe(receipt.eventCount);
      expect(reimportRes.receipt.algorithm).toBe('sha256-session-events-v1');
    } finally {
      await running2.close({ removeVolumes: true });
    }
  });
});
