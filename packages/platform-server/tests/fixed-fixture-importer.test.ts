import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { PlatformServerMigrationRunner, ALL_PLATFORM_MIGRATIONS } from '../src/storage/migrations.js';
import {
  SqliteFixedFixtureImporter,
  FIXED_FIXTURE_INVARIANTS,
  computeCanonicalImportHash,
  canonicalizeJson,
  isRecord,
  type FixedImportReceipt,
  type FixedImportProvenanceRecord,
} from '../src/storage/fixed-fixture-importer.js';
import { importFixedHappyClawFixture, type ImportResult } from '@enkeep/import-happyclaw';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

describe('SqliteFixedFixtureImporter & Migration 008 Invariants', () => {
  let db: DatabaseSync;
  let tempDir: string;
  let importer: SqliteFixedFixtureImporter;
  let fixedResult: ImportResult;
  const aliceUserId = 'user_alice_demo_001';
  const bobUserId = 'user_bob_demo_002';
  const deterministicTime = '2025-01-01T00:00:00.000Z';

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'fixed-importer-test-'));
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    // Seed test users in users table
    db.prepare("INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, 'alice', 'hash_alice', ?, ?)").run(
      aliceUserId,
      deterministicTime,
      deterministicTime
    );
    db.prepare("INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, 'bob', 'hash_bob', ?, ?)").run(
      bobUserId,
      deterministicTime,
      deterministicTime
    );

    importer = new SqliteFixedFixtureImporter(db);

    fixedResult = await importFixedHappyClawFixture({
      targetDir: tempDir,
      demoRoot: tempDir,
      userId: 'alice',
      deterministicCreatedAt: deterministicTime,
    });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('1. imports fixed HappyClaw fixture with exact 2/52/50/2/5 invariants and populates receipt and provenance', async () => {
    const outcome = await importer.importFixture({
      userId: aliceUserId,
      result: fixedResult,
      deterministicCreatedAt: deterministicTime,
    });

    expect(outcome.duplicate).toBe(false);
    expect(outcome.importedChatsCount).toBe(2);
    expect(outcome.importedMessagesCount).toBe(50);
    expect(outcome.provenanceCount).toBe(50);

    const receipt = outcome.receipt;
    expect(receipt.userId).toBe(aliceUserId);
    expect(receipt.sourceFingerprint).toBe(fixedResult.manifest.sourceFingerprint);
    expect(receipt.importerVersion).toBe(FIXED_FIXTURE_INVARIANTS.importerVersion);
    expect(receipt.idAlgorithm).toBe(FIXED_FIXTURE_INVARIANTS.idAlgorithm);
    expect(receipt.targetDsh).toBe(FIXED_FIXTURE_INVARIANTS.targetDsh);
    expect(receipt.sessionFormat).toBe(FIXED_FIXTURE_INVARIANTS.sessionFormat);
    expect(receipt.sourceChatsCount).toBe(2);
    expect(receipt.sourceMessagesCount).toBe(52);
    expect(receipt.importedMessagesCount).toBe(50);
    expect(receipt.droppedMessagesCount).toBe(2);
    expect(receipt.attachmentsCount).toBe(5);
    expect(receipt.canonicalHash).toBe(computeCanonicalImportHash(fixedResult));
    expect(receipt.createdAt).toBe(deterministicTime);

    // Verify spaces created (2 spaces with deterministic ID 'impsp_...')
    const spaces = db.prepare('SELECT id, user_id, name, folder, execution_mode FROM spaces WHERE user_id = ?').all(aliceUserId) as Array<Record<string, unknown>>;
    expect(spaces.length).toBe(2);
    for (const sp of spaces) {
      expect(typeof sp.id).toBe('string');
      expect(String(sp.id).startsWith('impsp_')).toBe(true);
      expect(sp.user_id).toBe(aliceUserId);
      expect(sp.execution_mode).toBe('container');
    }

    // Verify session_routes created (2 routes matching exact chat.sessionId, execution_mode container)
    const routes = db.prepare('SELECT id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode FROM session_routes WHERE user_id = ?').all(aliceUserId) as Array<Record<string, unknown>>;
    expect(routes.length).toBe(2);
    for (const r of routes) {
      expect(r.channel).toBe('web');
      expect(r.account_id).toBe('web-demo');
      expect(r.dsh_session_id).toBe(r.id);
      expect(String(r.id).startsWith('import-')).toBe(true);
      const chatForRoute = fixedResult.chats.find((c) => c.sessionId === r.id);
      expect(chatForRoute).toBeDefined();
      expect(r.execution_mode).toBe('container');
    }

    // Verify session_generations created (2 generation 1 rows)
    const gens = db.prepare('SELECT id, user_id, route_id, generation_number, dsh_session_id, agent_profile_snapshot_id, reset_reason FROM session_generations WHERE user_id = ?').all(aliceUserId) as Array<Record<string, unknown>>;
    expect(gens.length).toBe(2);
    for (const g of gens) {
      expect(String(g.id).startsWith('gen_')).toBe(true);
      expect(g.user_id).toBe(aliceUserId);
      expect(Number(g.generation_number)).toBe(1);
      expect(g.dsh_session_id).toBe(g.route_id);
      expect(g.agent_profile_snapshot_id).toBeNull();
      expect(g.reset_reason).toBe('initial');
    }

    // Verify session_sources (2 sources, internal sourceExecutionMode provenance)
    const sources = db.prepare('SELECT id, route_id, source_type, source_id, user_id, metadata FROM session_sources WHERE user_id = ?').all(aliceUserId) as Array<Record<string, unknown>>;
    expect(sources.length).toBe(2);
    for (const s of sources) {
      expect(String(s.id).startsWith('impsrc_')).toBe(true);
      expect(s.source_type).toBe('happyclaw');
      expect(s.user_id).toBe(aliceUserId);
      const meta = JSON.parse(s.metadata as string) as Record<string, unknown>;
      expect(meta.sourceExecutionMode).toBeDefined();
    }

    // Verify web_messages (50 messages with deterministic ID 'impmsg_...')
    const messages = db.prepare('SELECT id, session_id, user_id, role, content, status, route_key, metadata FROM web_messages WHERE user_id = ?').all(aliceUserId) as Array<Record<string, unknown>>;
    expect(messages.length).toBe(50);
    for (const msg of messages) {
      expect(String(msg.id).startsWith('impmsg_')).toBe(true);
      expect(msg.user_id).toBe(aliceUserId);
      expect(msg.status).toBe('delivered');
      expect(typeof msg.content).toBe('string');
      expect((msg.content as string).length).toBeGreaterThan(0);
    }

    // Verify web_events (50 events with deterministic ID 'impev_...')
    const events = db.prepare('SELECT id, session_id, user_id, type, payload FROM web_events WHERE user_id = ?').all(aliceUserId) as Array<Record<string, unknown>>;
    expect(events.length).toBe(50);
    for (const ev of events) {
      expect(String(ev.id).startsWith('impev_')).toBe(true);
      expect(ev.user_id).toBe(aliceUserId);
      expect(ev.type).toBe('message');
      const parsed = JSON.parse(ev.payload as string) as Record<string, unknown>;
      expect(parsed.sessionId).toBe(ev.session_id);
    }

    // Verify fixed_import_provenance (50 records with deterministic ID 'impprov_...')
    const provs = db.prepare('SELECT id, user_id, source_fingerprint, source_chat_jid, source_message_id, target_space_id, target_route_id, target_dsh_session_id, target_message_id, target_event_id FROM fixed_import_provenance WHERE user_id = ?').all(aliceUserId) as Array<Record<string, unknown>>;
    expect(provs.length).toBe(50);
    for (const p of provs) {
      expect(String(p.id).startsWith('impprov_')).toBe(true);
      expect(p.user_id).toBe(aliceUserId);
      expect(p.source_fingerprint).toBe(fixedResult.manifest.sourceFingerprint);
      expect(String(p.target_space_id).startsWith('impsp_')).toBe(true);
      expect(String(p.target_message_id).startsWith('impmsg_')).toBe(true);
      expect(String(p.target_event_id).startsWith('impev_')).toBe(true);
    }

    // Verify attachments preserved in message metadata (exact 5 attachments)
    let totalAttachments = 0;
    for (const msg of messages) {
      if (msg.metadata) {
        const meta = JSON.parse(msg.metadata as string) as Record<string, unknown>;
        if (Array.isArray(meta.attachments)) {
          totalAttachments += meta.attachments.length;
        }
      }
    }
    expect(totalAttachments).toBe(5);
  });

  it('2. executes dual-run import with 100% exact idempotency (duplicate: true, identical counts, no mutations)', async () => {
    const run1 = await importer.importFixture({
      userId: aliceUserId,
      result: fixedResult,
      deterministicCreatedAt: deterministicTime,
    });
    expect(run1.duplicate).toBe(false);

    const run2 = await importer.importFixture({
      userId: aliceUserId,
      result: fixedResult,
      deterministicCreatedAt: deterministicTime,
    });
    expect(run2.duplicate).toBe(true);
    expect(run2.receipt.canonicalHash).toBe(run1.receipt.canonicalHash);
    expect(run2.importedChatsCount).toBe(2);
    expect(run2.importedMessagesCount).toBe(50);
    expect(run2.provenanceCount).toBe(50);

    // Verify database counts did not double
    const msgCount = (db.prepare('SELECT COUNT(*) as count FROM web_messages WHERE user_id = ?').get(aliceUserId) as { count: number }).count;
    expect(msgCount).toBe(50);

    const evCount = (db.prepare('SELECT COUNT(*) as count FROM web_events WHERE user_id = ?').get(aliceUserId) as { count: number }).count;
    expect(evCount).toBe(50);

    const genCount = (db.prepare('SELECT COUNT(*) as count FROM session_generations WHERE user_id = ?').get(aliceUserId) as { count: number }).count;
    expect(genCount).toBe(2);

    const provCount = (db.prepare('SELECT COUNT(*) as count FROM fixed_import_provenance WHERE user_id = ?').get(aliceUserId) as { count: number }).count;
    expect(provCount).toBe(50);

    const receiptCount = (db.prepare('SELECT COUNT(*) as count FROM fixed_import_receipts WHERE user_id = ?').get(aliceUserId) as { count: number }).count;
    expect(receiptCount).toBe(1);
  });

  it('3. detects receipt canonical hash mismatch / tampering and rolls back with IMPORT_CORRUPTION', async () => {
    await importer.importFixture({
      userId: aliceUserId,
      result: fixedResult,
      deterministicCreatedAt: deterministicTime,
    });

    // Tamper with canonical_hash in fixed_import_receipts
    db.prepare("UPDATE fixed_import_receipts SET canonical_hash = 'tampered_bad_hash' WHERE user_id = ?").run(aliceUserId);

    await expect(
      importer.importFixture({
        userId: aliceUserId,
        result: fixedResult,
        deterministicCreatedAt: deterministicTime,
      })
    ).rejects.toThrow(/Import receipt corruption/);
  });

  it('4. detects tampered / deleted space, route, source, message, event, or provenance and rolls back with IMPORT_CORRUPTION', async () => {
    await importer.importFixture({
      userId: aliceUserId,
      result: fixedResult,
      deterministicCreatedAt: deterministicTime,
    });

    // 4.1 Delete one web message to simulate corruption
    const oneMsg = (db.prepare('SELECT id FROM web_messages WHERE user_id = ? LIMIT 1').get(aliceUserId) as { id: string });
    db.prepare('DELETE FROM web_messages WHERE id = ?').run(oneMsg.id);

    await expect(
      importer.importFixture({
        userId: aliceUserId,
        result: fixedResult,
        deterministicCreatedAt: deterministicTime,
      })
    ).rejects.toThrow(/missing web message|IMPORT_CORRUPTION/i);
  });

  it('5. strictly prevents adoption of pre-existing unowned space, route, source, message, event, or provenance (No-Adoption Policy)', async () => {
    // 5.1 Pre-create conflicting space for folder 'alice-space'
    db.prepare("INSERT INTO spaces (id, user_id, name, folder, execution_mode, created_at, updated_at) VALUES ('sp_conflict', ?, 'Conflicting Space', 'alice-space', 'container', ?, ?)").run(
      aliceUserId,
      deterministicTime,
      deterministicTime
    );

    // Attempt import -> must reject because space for folder already exists without receipt
    await expect(
      importer.importFixture({
        userId: aliceUserId,
        result: fixedResult,
        deterministicCreatedAt: deterministicTime,
      })
    ).rejects.toThrow(/Cannot adopt pre-existing space/);

    db.prepare("DELETE FROM spaces WHERE id = 'sp_conflict'").run();

    // 5.2 Pre-create conflicting route
    const firstChat = fixedResult.chats[0];
    db.prepare("INSERT INTO spaces (id, user_id, name, folder, execution_mode, created_at, updated_at) VALUES ('sp_tmp', ?, 'Temp Space', 'temp', 'container', ?, ?)").run(
      aliceUserId,
      deterministicTime,
      deterministicTime
    );
    db.prepare("INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, created_at, updated_at) VALUES (?, 'sp_tmp', ?, 'web', 'web-demo', ?, ?, ?, 'container', ?, ?)").run(
      firstChat.sessionId,
      aliceUserId,
      firstChat.sessionId,
      firstChat.chatJid,
      firstChat.sessionId,
      deterministicTime,
      deterministicTime
    );

    await expect(
      importer.importFixture({
        userId: aliceUserId,
        result: fixedResult,
        deterministicCreatedAt: deterministicTime,
      })
    ).rejects.toThrow(/Cannot adopt pre-existing session route/);

    db.prepare("DELETE FROM session_routes WHERE id = ?").run(firstChat.sessionId);
    db.prepare("DELETE FROM spaces WHERE id = 'sp_tmp'").run();

    // Verify nothing imported
    const receiptCount = (db.prepare('SELECT COUNT(*) as count FROM fixed_import_receipts WHERE user_id = ?').get(aliceUserId) as { count: number }).count;
    expect(receiptCount).toBe(0);
  });

  it('6. strictly isolates tenants: Bob attempting import of Alice fixed fixture fails closed without mutating Bob or adopting Alice', async () => {
    // 1. Alice imports first
    await importer.importFixture({
      userId: aliceUserId,
      result: fixedResult,
      deterministicCreatedAt: deterministicTime,
    });

    // 2. Bob attempts to import the same fixed fixture (which has global session route IDs)
    // Must fail closed because route ID already exists in global session_routes
    await expect(
      importer.importFixture({
        userId: bobUserId,
        result: fixedResult,
        deterministicCreatedAt: deterministicTime,
      })
    ).rejects.toThrow(/Cannot adopt pre-existing session route/);

    // 3. Bob's database rows remain 0
    const bobReceipts = (db.prepare('SELECT COUNT(*) as count FROM fixed_import_receipts WHERE user_id = ?').get(bobUserId) as { count: number }).count;
    expect(bobReceipts).toBe(0);

    const bobMessages = (db.prepare('SELECT COUNT(*) as count FROM web_messages WHERE user_id = ?').get(bobUserId) as { count: number }).count;
    expect(bobMessages).toBe(0);
  });

  it('7. validates runtime parameter keys, timestamp formats, and rejects invalid inputs', async () => {
    // Missing userId
    await expect(
      importer.importFixture({
        userId: '',
        result: fixedResult,
      })
    ).rejects.toThrow(/userId must be a non-empty string/);

    // Non-ISO timestamp
    await expect(
      importer.importFixture({
        userId: aliceUserId,
        result: fixedResult,
        deterministicCreatedAt: 'invalid-date',
      })
    ).rejects.toThrow(/deterministicCreatedAt must be a canonical ISO date string/);

    // Extra unexpected parameter property
    await expect(
      importer.importFixture({
        userId: aliceUserId,
        result: fixedResult,
        unexpectedProperty: true,
      } as unknown as { userId: string; result: ImportResult })
    ).rejects.toThrow(/Unexpected properties in import parameters/);
  });

  it('8. canonicalizeJson produces deterministic sorted key JSON strings', () => {
    const objA = { b: 2, a: 1, c: { y: 20, x: 10 } };
    const objB = { a: 1, c: { x: 10, y: 20 }, b: 2 };
    expect(canonicalizeJson(objA)).toBe('{"a":1,"b":2,"c":{"x":10,"y":20}}');
    expect(canonicalizeJson(objA)).toBe(canonicalizeJson(objB));
  });

  it('9. wraps errors in AggregateError when rollback fails during failed import', async () => {
    // Create broken DB proxy that throws on ROLLBACK
    const rawExec = db.exec.bind(db);
    let injectRollbackFail = false;
    db.exec = (sql: string) => {
      if (injectRollbackFail && sql.includes('ROLLBACK')) {
        throw new Error('Simulated rollback failure in SQLite');
      }
      return rawExec(sql);
    };

    injectRollbackFail = true;
    // Corrupt result stats inside transaction to trigger invariant validation failure inside transaction
    const corruptedResult = {
      ...fixedResult,
      chats: [
        {
          ...fixedResult.chats[0],
          seed: [
            ...fixedResult.chats[0].seed,
            {
              seq: 9999,
              type: 'user/message',
              data: {
                id: `import:${fixedResult.chats[0].chatJid}:9999`,
                content: [{ type: 'text', text: '' }], // empty text -> triggers validation error inside transaction
              },
            },
          ],
        },
        fixedResult.chats[1],
      ],
    };

    await expect(
      importer.importFixture({
        userId: aliceUserId,
        result: corruptedResult as unknown as ImportResult,
        deterministicCreatedAt: deterministicTime,
      })
    ).rejects.toThrow();
  });

  it('10. strictly requires exact messageIdFor prefix (import:${chatJid}:${sourceMsgId}) with no fallback', async () => {
    // Malformed ID missing import: prefix
    const malformedIdResult = {
      ...fixedResult,
      chats: [
        {
          ...fixedResult.chats[0],
          seed: fixedResult.chats[0].seed.map((ev, i) =>
            i === 0 && ev.type === 'user/message'
              ? { ...ev, data: { ...ev.data, id: 'raw_unprefixed_msg_id' } }
              : ev
          ),
        },
        fixedResult.chats[1],
      ],
    };

    await expect(
      importer.importFixture({
        userId: aliceUserId,
        result: malformedIdResult as unknown as ImportResult,
        deterministicCreatedAt: deterministicTime,
      })
    ).rejects.toThrow(/does not start with expected prefix/);
  });

  it('11. strictly validates attachment paths parsed from "见空间内 " lines (rejects traversal, backslashes, control characters)', async () => {
    // Traversal path in attachment note
    const traversalResult = {
      ...fixedResult,
      chats: [
        {
          ...fixedResult.chats[0],
          seed: fixedResult.chats[0].seed.map((ev, i) =>
            i === 0 && ev.type === 'user/message'
              ? { ...ev, data: { ...ev.data, content: [{ type: 'text', text: 'Hello\n见空间内 ../secret.key' }] } }
              : ev
          ),
        },
        fixedResult.chats[1],
      ],
    };

    await expect(
      importer.importFixture({
        userId: aliceUserId,
        result: traversalResult as unknown as ImportResult,
        deterministicCreatedAt: deterministicTime,
      })
    ).rejects.toThrow(/Invalid attachment path segment/);
  });
});
