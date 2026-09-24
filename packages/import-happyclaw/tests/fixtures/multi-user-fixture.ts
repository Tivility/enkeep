import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface MultiUserFixture {
  readonly rootDir: string
  readonly dbPath: string
  readonly groupsDir: string
  readonly memoryDir: string
  readonly configDir: string
  readonly platformDbPath: string
}

/**
 * Creates a synthetic multi-user HappyClaw test fixture matching the real inventory:
 * - owner-user: admin (owner)
 * - cxx: member with 7 workspaces (5 sharing home-27045ebd...) + Feishu (with credentials) + WeChat (with credentials)
 * - whz: member with 2 workspaces + WeChat account + memory file (2026-08-24.md)
 * - wyg: member with 2 workspaces + Feishu account
 */
export function createSyntheticMultiUserFixture(testRootDir: string): MultiUserFixture {
  const sourceDir = join(testRootDir, 'source')
  const groupsDir = join(sourceDir, 'groups')
  const memoryDir = join(sourceDir, 'memory')
  const configDir = join(sourceDir, 'config')
  const dbDir = join(sourceDir, 'db')

  mkdirSync(groupsDir, { recursive: true })
  mkdirSync(memoryDir, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  mkdirSync(dbDir, { recursive: true })

  const dbPath = join(dbDir, 'messages.db')
  const db = new DatabaseSync(dbPath)

  db.exec(`
    CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO router_state (key, value) VALUES ('schema_version', '64');

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
      owner_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );

    CREATE TABLE registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT,
      folder TEXT,
      execution_mode TEXT NOT NULL DEFAULT 'container',
      is_home INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );

    CREATE TABLE chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      sender TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER NOT NULL DEFAULT 0,
      attachments TEXT
    );

    CREATE TABLE channel_accounts (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      name TEXT,
      status TEXT NOT NULL DEFAULT 'connected',
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );
  `)

  // 1. Insert Users
  db.prepare(`
    INSERT INTO users (id, username, display_name, role, status) VALUES
      ('5df32a3a-15d3-4591-a7c3-8a0233c7a5ca', 'owner-user', 'owner-user Admin', 'admin', 'active'),
      ('27045ebd-2590-4511-a823-1b89aeaa0c72', 'cxx', 'XX', 'member', 'active'),
      ('f1959674-c0f3-44a3-ad89-d3e774d336d4', 'whz', 'whz', 'member', 'active'),
      ('1ee949bc-6b95-4710-a6a7-757464e0143e', 'wyg', 'wyg', 'member', 'active');
  `).run()

  // 2. Insert Workspaces
  // Owner: owner-user (1 home space)
  db.prepare(`
    INSERT INTO workspaces (jid, name, folder, execution_mode, is_home, owner_user_id) VALUES
      ('web:home-owner-user', 'owner-user Home', 'main', 'host', 1, '5df32a3a-15d3-4591-a7c3-8a0233c7a5ca');
  `).run()

  // Member: cxx (7 workspaces, 5 sharing home-27045ebd...)
  const cxxUid = '27045ebd-2590-4511-a823-1b89aeaa0c72'
  const cxxHomeFolder = 'home-27045ebd-2590-4511-a823-1b89aeaa0c72'
  db.prepare(`
    INSERT INTO workspaces (jid, name, folder, execution_mode, is_home, owner_user_id) VALUES
      ('web:home-27045ebd-2590-4511-a823-1b89aeaa0c72', 'cxx Home', '${cxxHomeFolder}', 'container', 1, '${cxxUid}'),
      ('feishu:oc_3700c92c4af3fc43be2561e3cbb8fb9f', '飞书私聊', '${cxxHomeFolder}', 'container', 0, '${cxxUid}'),
      ('wechat:owxe59f0c1c911f11e4b9fce97ba@im.wechat', '微信私聊', '${cxxHomeFolder}', 'container', 0, '${cxxUid}'),
      ('web:ea07e509-ac4b-4292-ae6e-f77abdc7c01d', '拓竹', 'flow-test0015-7637', 'container', 0, '${cxxUid}'),
      ('web:06225a75-a81d-4820-a06c-26158287e6e3', '电竞天才', 'flow-test0017-6d74', 'container', 0, '${cxxUid}'),
      ('feishu:oc_ab939b4da1bfc90a76d9f629266a9173', '拓竹', '${cxxHomeFolder}', 'container', 0, '${cxxUid}'),
      ('feishu:oc_68e3076d1a02e6e213729a3089734eef', '电竞', '${cxxHomeFolder}', 'container', 0, '${cxxUid}');
  `).run()

  // Member: whz (2 workspaces)
  const whzUid = 'f1959674-c0f3-44a3-ad89-d3e774d336d4'
  const whzHomeFolder = 'home-f1959674-c0f3-44a3-ad89-d3e774d336d4'
  db.prepare(`
    INSERT INTO workspaces (jid, name, folder, execution_mode, is_home, owner_user_id) VALUES
      ('web:home-f1959674-c0f3-44a3-ad89-d3e774d336d4', 'whz Home', '${whzHomeFolder}', 'container', 1, '${whzUid}'),
      ('wechat:owx1386223abfe8e2e805f55872a@im.wechat', '微信私聊', '${whzHomeFolder}', 'container', 0, '${whzUid}');
  `).run()

  // Member: wyg (2 workspaces)
  const wygUid = '1ee949bc-6b95-4710-a6a7-757464e0143e'
  const wygHomeFolder = 'home-1ee949bc-6b95-4710-a6a7-757464e0143e'
  db.prepare(`
    INSERT INTO workspaces (jid, name, folder, execution_mode, is_home, owner_user_id) VALUES
      ('web:home-1ee949bc-6b95-4710-a6a7-757464e0143e', 'wyg Home', '${wygHomeFolder}', 'container', 1, '${wygUid}'),
      ('feishu:oc_b42f822fc101f410841163ede1641f7a', '飞书私聊', '${wygHomeFolder}', 'container', 0, '${wygUid}');
  `).run()

  // 3. Insert Chats & Messages
  const insertChat = db.prepare('INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)')
  const insertMsg = db.prepare('INSERT INTO messages (id, chat_jid, sender, content, timestamp, is_from_me, attachments) VALUES (?, ?, ?, ?, ?, ?, ?)')

  // cxx chats
  insertChat.run('web:home-27045ebd-2590-4511-a823-1b89aeaa0c72', 'cxx Home', '2026-09-24T01:18:56Z')
  insertMsg.run('m_cxx_1', 'web:home-27045ebd-2590-4511-a823-1b89aeaa0c72', 'cxx', 'Hello in home', '2026-09-24T01:15:00Z', 0, null)
  insertMsg.run('m_cxx_2', 'web:home-27045ebd-2590-4511-a823-1b89aeaa0c72', 'bot', 'Hello cxx!', '2026-09-24T01:18:56Z', 1, null)

  insertChat.run('feishu:oc_3700c92c4af3fc43be2561e3cbb8fb9f', '飞书私聊', '2026-07-27T14:00:54Z')
  insertMsg.run('m_cxx_fs_1', 'feishu:oc_3700c92c4af3fc43be2561e3cbb8fb9f', 'cxx', 'Feishu DM message', '2026-07-27T14:00:00Z', 0, null)

  insertChat.run('wechat:owxe59f0c1c911f11e4b9fce97ba@im.wechat', '微信私聊', '2026-07-27T14:00:55Z')
  insertMsg.run('m_cxx_wx_1', 'wechat:owxe59f0c1c911f11e4b9fce97ba@im.wechat', 'cxx', 'WeChat DM message', '2026-07-27T14:00:55Z', 0, null)

  // whz chats
  insertChat.run('web:home-f1959674-c0f3-44a3-ad89-d3e774d336d4', 'whz Home', '2026-09-23T19:37:09Z')
  insertMsg.run('m_whz_1', 'web:home-f1959674-c0f3-44a3-ad89-d3e774d336d4', 'whz', 'whz question', '2026-09-23T19:36:00Z', 0, null)
  insertMsg.run('m_whz_2', 'web:home-f1959674-c0f3-44a3-ad89-d3e774d336d4', 'bot', 'whz answer', '2026-09-23T19:37:09Z', 1, null)

  // wyg chats
  insertChat.run('web:home-1ee949bc-6b95-4710-a6a7-757464e0143e', 'wyg Home', '2026-08-08T14:17:10Z')
  insertMsg.run('m_wyg_1', 'web:home-1ee949bc-6b95-4710-a6a7-757464e0143e', 'wyg', 'wyg test message', '2026-08-08T14:17:10Z', 0, null)

  // 4. Channel Accounts
  db.prepare(`
    INSERT INTO channel_accounts (id, owner_user_id, provider, name, status) VALUES
      ('acc_cxx_fs', '${cxxUid}', 'feishu', '默认飞书', 'connected'),
      ('acc_cxx_wx', '${cxxUid}', 'wechat', '默认微信', 'connected'),
      ('acc_whz_wx', '${whzUid}', 'wechat', '默认微信', 'connected'),
      ('acc_wyg_fs', '${wygUid}', 'feishu', 'wyg的飞书机器人', 'connected');
  `).run()

  db.close()

  // 5. Create Workspace Files on Disk
  // cxx files (including secret files to test exclusion!)
  const cxxDir = join(groupsDir, cxxHomeFolder)
  mkdirSync(cxxDir, { recursive: true })
  writeFileSync(join(cxxDir, 'CLAUDE.md'), '# cxx Space Instructions\n')
  writeFileSync(join(cxxDir, 'notes.md'), '# Notes\nSome notes')
  // Secrets that MUST be excluded:
  writeFileSync(join(cxxDir, '.env'), 'SECRET_API_KEY=leak_super_secret\n')
  writeFileSync(join(cxxDir, '.env.production'), 'ANOTHER_SECRET=dont_copy\n')
  mkdirSync(join(cxxDir, 'node_modules'), { recursive: true })
  writeFileSync(join(cxxDir, 'node_modules', 'dep.js'), 'console.log("dep")')

  // flow-test0015-7637
  const tuozhuDir = join(groupsDir, 'flow-test0015-7637')
  mkdirSync(tuozhuDir, { recursive: true })
  writeFileSync(join(tuozhuDir, 'CLAUDE.md'), '# 拓竹 Space Instructions\n')

  // whz files + memory file
  const whzDir = join(groupsDir, whzHomeFolder)
  mkdirSync(whzDir, { recursive: true })
  writeFileSync(join(whzDir, 'CLAUDE.md'), '# whz Instructions\n')

  const whzMemDir = join(memoryDir, whzHomeFolder)
  mkdirSync(whzMemDir, { recursive: true })
  writeFileSync(join(whzMemDir, '2026-08-24.md'), '# Memory Snapshot 2026-08-24\nDaily memory distillation.')

  // wyg files
  const wygDir = join(groupsDir, wygHomeFolder)
  mkdirSync(wygDir, { recursive: true })
  writeFileSync(join(wygDir, 'CLAUDE.md'), '# wyg Instructions\n')

  // 6. Initialize Enkeep Platform Target Database Schema
  const platformDbPath = join(testRootDir, 'platform.db')
  const pDb = new DatabaseSync(platformDbPath)
  pDb.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'active',
      display_name TEXT,
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
      account_id TEXT NOT NULL,
      native_context_id TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      dsh_session_id TEXT NOT NULL,
      execution_mode TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT
    );

    CREATE TABLE session_generations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      route_id TEXT NOT NULL REFERENCES session_routes(id) ON DELETE CASCADE,
      generation_number INTEGER NOT NULL,
      dsh_session_id TEXT NOT NULL,
      reset_reason TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE session_sources (
      id TEXT PRIMARY KEY,
      route_id TEXT NOT NULL REFERENCES session_routes(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      metadata TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE web_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      route_key TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE web_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE channel_accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      credential_ref TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE channel_bindings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
      space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      native_context_id TEXT NOT NULL,
      activation_mode TEXT NOT NULL DEFAULT 'mention',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE channel_encrypted_credentials (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      credential_ref TEXT NOT NULL UNIQUE,
      encrypted_payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );

    CREATE TABLE fixed_import_receipts (
      user_id TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL,
      importer_version TEXT NOT NULL,
      id_algorithm TEXT NOT NULL,
      target_dsh TEXT NOT NULL,
      session_format INTEGER NOT NULL DEFAULT 0,
      source_chats_count INTEGER NOT NULL,
      source_messages_count INTEGER NOT NULL,
      imported_messages_count INTEGER NOT NULL,
      dropped_messages_count INTEGER NOT NULL DEFAULT 0,
      attachments_count INTEGER NOT NULL DEFAULT 0,
      canonical_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
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
      target_message_id TEXT NOT NULL,
      target_event_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- Pre-create existing owner 'owner-user' to test existing user preservation
    INSERT INTO users (id, username, password_hash, role, status, display_name, must_change_password)
    VALUES ('5df32a3a-15d3-4591-a7c3-8a0233c7a5ca', 'owner-user', 'scrypt$16384$8$1$existing_salt$existing_hash', 'admin', 'active', 'owner-user Admin', 0);
  `)
  pDb.close()

  return {
    rootDir: testRootDir,
    dbPath,
    groupsDir,
    memoryDir,
    configDir,
    platformDbPath,
  }
}
