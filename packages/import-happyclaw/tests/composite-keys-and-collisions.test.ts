import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deterministicMessageId,
  detectIdCollisions,
  executeMultiUserMigration,
  planMultiUserMigration,
} from '../src/index.js'

describe('Composite Key Disambiguation & ID Collision Detection (MIG-2)', () => {
  let tempDir: string
  let sourceDbPath: string
  let targetDbPath: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'enkeep-mig2-test-'))
    sourceDbPath = join(tempDir, 'source.db')
    targetDbPath = join(tempDir, 'platform.db')

    // Create target platform.db schema
    const targetDb = new DatabaseSync(targetDbPath)
    targetDb.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        status TEXT NOT NULL DEFAULT 'active',
        display_name TEXT NOT NULL DEFAULT '',
        must_change_password INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );

      CREATE TABLE spaces (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        folder TEXT NOT NULL,
        execution_mode TEXT NOT NULL DEFAULT 'container',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );

      CREATE TABLE session_routes (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        channel TEXT NOT NULL,
        account_id TEXT NOT NULL DEFAULT 'default',
        native_context_id TEXT NOT NULL DEFAULT '',
        peer_id TEXT NOT NULL DEFAULT '',
        dsh_session_id TEXT NOT NULL,
        execution_mode TEXT NOT NULL DEFAULT 'container',
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        status TEXT NOT NULL DEFAULT 'active',
        title TEXT
      );

      CREATE TABLE session_generations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        route_id TEXT NOT NULL,
        generation_number INTEGER NOT NULL DEFAULT 1,
        dsh_session_id TEXT NOT NULL,
        reset_reason TEXT NOT NULL DEFAULT 'initial',
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );

      CREATE TABLE session_sources (
        id TEXT PRIMARY KEY,
        route_id TEXT NOT NULL REFERENCES session_routes(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        UNIQUE(user_id, source_type, source_id)
      );

      CREATE TABLE web_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session_routes(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'delivered',
        route_key TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );

      CREATE TABLE web_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session_routes(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );

      CREATE TABLE message_attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES web_messages(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        snapshot_path TEXT NOT NULL,
        etag TEXT NOT NULL,
        size INTEGER NOT NULL,
        media_type TEXT NOT NULL,
        display_name TEXT,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );

      CREATE TABLE fixed_import_receipts (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source_fingerprint TEXT NOT NULL,
        importer_version TEXT NOT NULL,
        id_algorithm TEXT NOT NULL,
        target_dsh TEXT NOT NULL,
        session_format INTEGER NOT NULL,
        source_chats_count INTEGER NOT NULL,
        source_messages_count INTEGER NOT NULL,
        imported_messages_count INTEGER NOT NULL,
        dropped_messages_count INTEGER NOT NULL,
        attachments_count INTEGER NOT NULL,
        canonical_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        PRIMARY KEY (user_id, source_fingerprint)
      );

      CREATE TABLE fixed_import_provenance (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source_fingerprint TEXT NOT NULL,
        source_chat_jid TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        target_space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        target_route_id TEXT NOT NULL REFERENCES session_routes(id) ON DELETE CASCADE,
        target_dsh_session_id TEXT NOT NULL,
        target_message_id TEXT NOT NULL REFERENCES web_messages(id) ON DELETE CASCADE,
        target_event_id TEXT NOT NULL REFERENCES web_events(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );
    `)
    targetDb.close()
  })

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  describe('1. Deterministic Message ID Generation', () => {
    it('derives stable IDs deterministically from composite key (chat_jid, message_id)', () => {
      const chatA = 'feishu:oc_68e3076d1a02e6e213729a3089734eef'
      const chatB = 'web:06225a75-a81d-4820-a06c-26158287e6e3'
      const commonMsgId = 'om_x100b6f3e0a7dd8a0b1213275c0e0b9d'

      const idA = deterministicMessageId(chatA, commonMsgId)
      const idB = deterministicMessageId(chatB, commonMsgId)

      // Both follow msg_hpc_${24_hex} format (total 32 chars)
      expect(idA).toMatch(/^msg_hpc_[0-9a-f]{24}$/)
      expect(idB).toMatch(/^msg_hpc_[0-9a-f]{24}$/)
      expect(idA).toHaveLength(32)
      expect(idB).toHaveLength(32)

      // Identical raw message ID across different chats yields DIFFERENT deterministic IDs
      expect(idA).not.toBe(idB)

      // Repeated invocation on same composite key yields 100% byte-identical ID
      const idA2 = deterministicMessageId(chatA, commonMsgId)
      expect(idA2).toBe(idA)
    })
  })

  describe('2. Multi-Chat Fixture with Duplicate Message IDs (cxx Production Case)', () => {
    const cxxUid = '27045ebd-2590-4511-a823-1b89aeaa0c72'
    const feishuJid = 'feishu:oc_68e3076d1a02e6e213729a3089734eef'
    const webJid = 'web:06225a75-a81d-4820-a06c-26158287e6e3'
    const sharedMsgId = 'om_x100b6f3e0a7dd8a0b1213275c0e0b9d'

    function setupSourceDbWithDuplicateIds(): void {
      const srcDb = new DatabaseSync(sourceDbPath)
      srcDb.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          display_name TEXT,
          role TEXT NOT NULL DEFAULT 'member',
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
        );

        CREATE TABLE workspaces (
          jid TEXT PRIMARY KEY,
          name TEXT,
          folder TEXT,
          execution_mode TEXT NOT NULL DEFAULT 'container',
          is_home INTEGER NOT NULL DEFAULT 0,
          owner_user_id TEXT NOT NULL
        );

        CREATE TABLE chats (
          jid TEXT PRIMARY KEY,
          name TEXT,
          last_message_time TEXT
        );

        CREATE TABLE messages (
          id TEXT,
          chat_jid TEXT,
          sender TEXT,
          content TEXT,
          timestamp TEXT,
          is_from_me INTEGER,
          attachments TEXT,
          PRIMARY KEY (id, chat_jid)
        );

        INSERT INTO users (id, username, display_name, role, status) VALUES
          ('${cxxUid}', 'cxx', 'XX', 'member', 'active');

        INSERT INTO workspaces (jid, name, folder, execution_mode, is_home, owner_user_id) VALUES
          ('${feishuJid}', '电竞', 'flow-feishu', 'container', 0, '${cxxUid}'),
          ('${webJid}', '电竞天才', 'flow-web', 'container', 0, '${cxxUid}');

        INSERT INTO chats (jid, name, last_message_time) VALUES
          ('${feishuJid}', '电竞', '2026-09-24T02:00:00Z'),
          ('${webJid}', '电竞天才', '2026-09-24T02:05:00Z');

        -- Duplicate message ID om_x100b6f3e0a7dd8a0b1213275c0e0b9d in both chats!
        INSERT INTO messages (id, chat_jid, sender, content, timestamp, is_from_me, attachments) VALUES
          ('${sharedMsgId}', '${feishuJid}', 'cxx', 'Message in Feishu stream', '2026-09-24T02:00:00Z', 0, null),
          ('m_feishu_2', '${feishuJid}', 'bot', 'Reply in Feishu', '2026-09-24T02:01:00Z', 1, null),
          ('${sharedMsgId}', '${webJid}', 'cxx', 'Bridged message in Web stream', '2026-09-24T02:05:00Z', 0, null),
          ('m_web_2', '${webJid}', 'bot', 'Reply in Web', '2026-09-24T02:06:00Z', 1, null);
      `)
      srcDb.close()
    }

    it('dry-run reports 0 collisions because composite keys disambiguate web_messages IDs', async () => {
      setupSourceDbWithDuplicateIds()

      const dryRunResult = await executeMultiUserMigration({
        sourcePath: sourceDbPath,
        targetDbPath,
        select: { users: ['cxx'] },
        dryRun: true,
      })

      expect(dryRunResult.success).toBe(true)
      expect(dryRunResult.dryRun).toBe(true)
      expect(dryRunResult.plan.collisions).toHaveLength(0)
      expect(dryRunResult.plan.summary.totalMessages).toBe(4)
    })

    it('executes live migration successfully without UNIQUE constraint failed: web_messages.id', async () => {
      setupSourceDbWithDuplicateIds()

      const result = await executeMultiUserMigration({
        sourcePath: sourceDbPath,
        targetDbPath,
        select: { users: ['cxx'] },
        dryRun: false,
      })

      expect(result.success).toBe(true)

      const targetDb = new DatabaseSync(targetDbPath, { readOnly: true })

      // Verify all 4 messages are inserted
      const messages = targetDb.prepare('SELECT id, session_id, role, content FROM web_messages').all() as any[]
      expect(messages).toHaveLength(4)

      const expectedFeishuMsgId = deterministicMessageId(feishuJid, sharedMsgId)
      const expectedWebMsgId = deterministicMessageId(webJid, sharedMsgId)

      expect(expectedFeishuMsgId).not.toBe(expectedWebMsgId)

      const msgFeishu = messages.find((m) => m.id === expectedFeishuMsgId)
      const msgWeb = messages.find((m) => m.id === expectedWebMsgId)

      expect(msgFeishu).toBeDefined()
      expect(msgFeishu.content).toBe('Message in Feishu stream')

      expect(msgWeb).toBeDefined()
      expect(msgWeb.content).toBe('Bridged message in Web stream')

      // Verify fixed_import_provenance preserves original composite key (chat_jid, message_id)
      const provs = targetDb.prepare('SELECT source_chat_jid, source_message_id, target_message_id FROM fixed_import_provenance').all() as any[]
      expect(provs).toHaveLength(4)

      const provFeishu = provs.find((p) => p.target_message_id === expectedFeishuMsgId)
      expect(provFeishu).toBeDefined()
      expect(provFeishu.source_chat_jid).toBe(feishuJid)
      expect(provFeishu.source_message_id).toBe(sharedMsgId)

      const provWeb = provs.find((p) => p.target_message_id === expectedWebMsgId)
      expect(provWeb).toBeDefined()
      expect(provWeb.source_chat_jid).toBe(webJid)
      expect(provWeb.source_message_id).toBe(sharedMsgId)

      // Verify web_events uses targetMsgId
      const events = targetDb.prepare('SELECT id, payload FROM web_events').all() as any[]
      expect(events).toHaveLength(4)
      for (const ev of events) {
        const payload = JSON.parse(ev.payload)
        expect(payload.id).toMatch(/^msg_hpc_[0-9a-f]{24}$/)
      }

      targetDb.close()
    })

    it('is completely idempotent on re-run with zero duplicate records or constraints failure', async () => {
      setupSourceDbWithDuplicateIds()

      // Run 1
      await executeMultiUserMigration({
        sourcePath: sourceDbPath,
        targetDbPath,
        select: { users: ['cxx'] },
        dryRun: false,
      })

      // Run 2 (re-run)
      const rerunResult = await executeMultiUserMigration({
        sourcePath: sourceDbPath,
        targetDbPath,
        select: { users: ['cxx'] },
        dryRun: false,
      })

      expect(rerunResult.success).toBe(true)

      const targetDb = new DatabaseSync(targetDbPath, { readOnly: true })
      const messages = targetDb.prepare('SELECT id FROM web_messages').all() as any[]
      expect(messages).toHaveLength(4)

      const provs = targetDb.prepare('SELECT id FROM fixed_import_provenance').all() as any[]
      expect(provs).toHaveLength(4)

      const events = targetDb.prepare('SELECT id FROM web_events').all() as any[]
      expect(events).toHaveLength(4)

      targetDb.close()
    })
  })

  describe('3. Dry-Run Collision Detection: Within-Batch Collisions', () => {
    it('detects duplicate message IDs within the batch when composite keys collide', async () => {
      const srcDb = new DatabaseSync(sourceDbPath)
      srcDb.exec(`
        CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE, display_name TEXT, role TEXT, status TEXT, created_at TEXT DEFAULT (CURRENT_TIMESTAMP));
        CREATE TABLE workspaces (jid TEXT PRIMARY KEY, name TEXT, folder TEXT, execution_mode TEXT, is_home INTEGER, owner_user_id TEXT);
        CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT);
        CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, attachments TEXT);

        INSERT INTO users (id, username, display_name, role, status) VALUES ('u1', 'alice', 'Alice', 'member', 'active');
        INSERT INTO workspaces VALUES ('chat:1', 'Space 1', 'spc1', 'container', 0, 'u1');
        INSERT INTO chats VALUES ('chat:1', 'Chat 1', '2026-09-24T00:00:00Z');
        -- Duplicate identical row (chat:1, m_dupe) twice
        INSERT INTO messages VALUES
          ('m_dupe', 'chat:1', 'alice', 'First', '2026-09-24T00:00:00Z', 0, null),
          ('m_dupe', 'chat:1', 'alice', 'Duplicate same composite key', '2026-09-24T00:01:00Z', 0, null);
      `)
      srcDb.close()

      const plan = planMultiUserMigration({
        sourcePath: sourceDbPath,
        targetDbPath,
        select: { users: ['alice'] },
        dryRun: true,
      })

      expect(plan.collisions.length).toBeGreaterThan(0)
      const msgCollision = plan.collisions.find((c) => c.table === 'web_messages')
      expect(msgCollision).toBeDefined()
      expect(msgCollision?.reason).toBe('within_batch')
      expect(msgCollision?.sourceMessageId).toBe('m_dupe')

      // executeMultiUserMigration throws fast during dryRun when collisions exist
      await expect(
        executeMultiUserMigration({
          sourcePath: sourceDbPath,
          targetDbPath,
          select: { users: ['alice'] },
          dryRun: true,
        })
      ).rejects.toThrow(/ID collision detected/)
    })
  })

  describe('4. Dry-Run Collision Detection: Against Enkeep Database', () => {
    it('detects when planned message ID already belongs to another user in Enkeep', async () => {
      const srcDb = new DatabaseSync(sourceDbPath)
      srcDb.exec(`
        CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE, display_name TEXT, role TEXT, status TEXT, created_at TEXT DEFAULT (CURRENT_TIMESTAMP));
        CREATE TABLE workspaces (jid TEXT PRIMARY KEY, name TEXT, folder TEXT, execution_mode TEXT, is_home INTEGER, owner_user_id TEXT);
        CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT);
        CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, attachments TEXT, PRIMARY KEY (id, chat_jid));

        INSERT INTO users (id, username, display_name, role, status) VALUES ('u_incoming', 'bob', 'Bob', 'member', 'active');
        INSERT INTO workspaces VALUES ('chat:target', 'Space Target', 'spc_target', 'container', 0, 'u_incoming');
        INSERT INTO chats VALUES ('chat:target', 'Chat Target', '2026-09-24T00:00:00Z');
        INSERT INTO messages VALUES ('m_collide', 'chat:target', 'bob', 'Incoming message', '2026-09-24T00:00:00Z', 0, null);
      `)
      srcDb.close()

      // Calculate what ID bob's message will produce
      const collidingMsgId = deterministicMessageId('chat:target', 'm_collide')

      // Pre-seed target Enkeep platform.db with this ID owned by another user (e.g. owner-user)
      const targetDb = new DatabaseSync(targetDbPath)
      targetDb.exec(`
        INSERT INTO users (id, username, password_hash) VALUES ('u_owner', 'owner-user', 'passhash');
        INSERT INTO spaces (id, user_id, name, folder) VALUES ('spc_owner', 'u_owner', 'Owner Space', 'owner-folder');
        INSERT INTO session_routes (id, space_id, user_id, channel, dsh_session_id) VALUES ('ses_owner', 'spc_owner', 'u_owner', 'web', 'dsh_1');
        INSERT INTO web_messages (id, session_id, user_id, role, content, route_key) VALUES
          ('${collidingMsgId}', 'ses_owner', 'u_owner', 'user', 'Owner message already having this ID', 'web:default:owner');
      `)
      targetDb.close()

      // Dry-run should detect collision against enkeep
      const plan = planMultiUserMigration({
        sourcePath: sourceDbPath,
        targetDbPath,
        select: { users: ['bob'] },
        dryRun: true,
      })

      expect(plan.collisions.length).toBeGreaterThan(0)
      const collision = plan.collisions.find((c) => c.table === 'web_messages')
      expect(collision).toBeDefined()
      expect(collision?.reason).toBe('against_enkeep')
      expect(collision?.conflictingUserId).toBe('u_owner')
      expect(collision?.targetUserId).toBe('u_incoming')

      // executeMultiUserMigration dry-run must fail with collision error
      await expect(
        executeMultiUserMigration({
          sourcePath: sourceDbPath,
          targetDbPath,
          select: { users: ['bob'] },
          dryRun: true,
        })
      ).rejects.toThrow(/ID collision detected: \[web_messages\] msg_hpc_.*\(against_enkeep\)/)
    })
  })
})
