import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { type SourceRawCredential } from '../types.js'

export interface SyntheticFixtureResult {
  readonly dbPath: string
  readonly groupsDir: string
  readonly fakeCredentials: readonly SourceRawCredential[]
}

/**
 * Creates a focused synthetic 3-workspace HappyClaw snapshot for Migration V2 validation:
 * 1. Alice Space: Standard workspace, users, profiles, CLAUDE.md, chats, tasks, Lark channel metadata, valid Lark credentials
 * 2. Bob Space: Untrusted plugin ("untrusted-remote-exec-plugin"), verified skill, MCP, WeChat channel, valid WeChat credentials
 * 3. Charlie Space: Expired credentials requiring reauthorization (`reauthorization_required`), quotas, custom model prefs
 */
export function createSyntheticV2Fixture(targetDir: string): SyntheticFixtureResult {
  const dbDir = join(targetDir, 'db')
  const groupsDir = join(targetDir, 'groups')
  mkdirSync(dbDir, { recursive: true })
  mkdirSync(groupsDir, { recursive: true })

  const dbPath = join(dbDir, 'messages.db')
  const db = new DatabaseSync(dbPath)

  db.exec(`
    CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO router_state (key, value) VALUES ('schema_version', '64');

    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT,
      role TEXT,
      name TEXT
    );

    CREATE TABLE agent_profiles (
      id TEXT PRIMARY KEY,
      name TEXT,
      description TEXT,
      system_prompt TEXT,
      version INTEGER
    );

    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      profile_id TEXT,
      workspace_id TEXT,
      system_prompt TEXT
    );

    CREATE TABLE workspaces (
      jid TEXT PRIMARY KEY,
      name TEXT,
      folder TEXT,
      execution_mode TEXT,
      created_by TEXT
    );

    CREATE TABLE chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      attachments TEXT
    );

    CREATE TABLE skills (
      id TEXT PRIMARY KEY,
      name TEXT,
      scope TEXT,
      space_id TEXT,
      source_type TEXT,
      source_url TEXT,
      content_hash TEXT
    );

    CREATE TABLE mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT,
      transport TEXT,
      command TEXT,
      args TEXT,
      workspace_id TEXT
    );

    CREATE TABLE plugins (
      id TEXT PRIMARY KEY,
      name TEXT,
      workspace_id TEXT,
      source TEXT,
      status TEXT,
      trusted INTEGER,
      capabilities TEXT
    );

    CREATE TABLE scheduled_tasks (
      id TEXT PRIMARY KEY,
      title TEXT,
      prompt TEXT,
      cron_expression TEXT,
      priority TEXT,
      workspace_id TEXT,
      group_jid TEXT
    );

    CREATE TABLE channel_accounts (
      id TEXT PRIMARY KEY,
      type TEXT,
      name TEXT,
      status TEXT,
      credential_ref TEXT
    );

    CREATE TABLE channel_mounts (
      id TEXT PRIMARY KEY,
      account_id TEXT,
      workspace_id TEXT,
      group_jid TEXT,
      native_context_id TEXT,
      activation_mode TEXT,
      channel TEXT
    );

    CREATE TABLE quotas (
      id TEXT PRIMARY KEY,
      resource TEXT,
      limit_val INTEGER,
      user_id TEXT
    );

    CREATE TABLE conversation_runtime_state (
      id TEXT PRIMARY KEY,
      provider TEXT,
      model TEXT,
      reasoning_effort TEXT,
      user_id TEXT,
      workspace_id TEXT
    );
  `)

  // 1. Users & Profiles
  db.exec(`
    INSERT INTO users (id, username, role, name) VALUES
      ('usr_alice', 'alice', 'admin', 'Alice Admin'),
      ('usr_bob', 'bob', 'user', 'Bob Builder'),
      ('usr_charlie', 'charlie', 'user', 'Charlie Pilot');

    INSERT INTO agent_profiles (id, name, description, system_prompt, version) VALUES
      ('prof_alice_general', 'Alice Assistant', 'Primary AI copilot', 'You are Alice helper.', 1),
      ('prof_bob_analyst', 'Bob Analyst', 'Data analyst profile', 'You analyze data strictly.', 2),
      ('prof_charlie_researcher', 'Charlie Researcher', 'Research specialist', 'You provide deep research summaries.', 1);

    INSERT INTO agents (id, name, profile_id, workspace_id, system_prompt) VALUES
      ('agent_alice', 'Alice Copilot', 'prof_alice_general', 'web:alice-space', 'You are Alice helper.'),
      ('agent_bob', 'Bob Agent', 'prof_bob_analyst', 'feishu:bob-space', 'You analyze data strictly.'),
      ('agent_charlie', 'Charlie Agent', 'prof_charlie_researcher', 'web:charlie-space', 'You provide deep research summaries.');
  `)

  // 2. Workspaces & Chats
  db.exec(`
    INSERT INTO workspaces (jid, name, folder, execution_mode, created_by) VALUES
      ('web:alice-space', 'Alice Workspace', 'alice-space', 'container', 'usr_alice'),
      ('feishu:bob-space', 'Bob Space', 'bob-space', 'container', 'usr_bob'),
      ('web:charlie-space', 'Charlie Space', 'charlie-space', 'container', 'usr_charlie');

    INSERT INTO chats (jid, name, last_message_time) VALUES
      ('web:alice-space', 'Alice Workspace', '2026-08-01T12:05:00.000Z'),
      ('feishu:bob-space', 'Bob Space', '2026-08-01T12:10:00.000Z'),
      ('web:charlie-space', 'Charlie Space', '2026-08-01T12:15:00.000Z');

    INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, attachments) VALUES
      ('m_a1', 'web:alice-space', 'alice', 'Alice', 'Hello, preparing Pilot migration.', '2026-08-01T12:00:00.000Z', 0, NULL),
      ('m_a2', 'web:alice-space', 'assistant', 'Alice Copilot', 'I will assist with workspace readiness.', '2026-08-01T12:01:00.000Z', 1, NULL),
      ('m_b1', 'feishu:bob-space', 'bob', 'Bob', 'Testing external plugins and MCP tools.', '2026-08-01T12:08:00.000Z', 0, NULL),
      ('m_b2', 'feishu:bob-space', 'assistant', 'Bob Agent', 'Loaded tools and verified capabilities.', '2026-08-01T12:09:00.000Z', 1, NULL),
      ('m_c1', 'web:charlie-space', 'charlie', 'Charlie', 'Testing channel credentials and quota constraints.', '2026-08-01T12:14:00.000Z', 0, NULL),
      ('m_c2', 'web:charlie-space', 'assistant', 'Charlie Agent', 'Quota check confirmed within limits.', '2026-08-01T12:15:00.000Z', 1, NULL);
  `)

  // 3. Extensions, Skills, MCP, Plugins (Bob has untrusted plugin)
  db.exec(`
    INSERT INTO skills (id, name, scope, space_id, source_type, source_url, content_hash) VALUES
      ('sk_alice_git', 'git-workflow-skill', 'space', 'web:alice-space', 'git', 'https://github.com/example/git-skill.git', 'sha256:1111aaaa'),
      ('sk_bob_chart', 'chart-maker-skill', 'space', 'feishu:bob-space', 'upload', NULL, 'sha256:2222bbbb');

    INSERT INTO mcp_servers (id, name, transport, command, args, workspace_id) VALUES
      ('mcp_bob_postgres', 'postgres-mcp', 'stdio', 'npx -y @modelcontextprotocol/server-postgres', '{"db":"test"}', 'feishu:bob-space');

    INSERT INTO plugins (id, name, workspace_id, source, status, trusted, capabilities) VALUES
      ('plg_bob_untrusted', 'untrusted-remote-exec-plugin', 'feishu:bob-space', 'https://untrusted.cdn/plugin.tar.gz', 'untrusted', 0, '["eval","remote_shell"]'),
      ('plg_alice_trusted', 'alice-calendar-plugin', 'web:alice-space', 'builtin', 'active', 1, '["calendar_read"]');
  `)

  // 4. Scheduled Tasks
  db.exec(`
    INSERT INTO scheduled_tasks (id, title, prompt, cron_expression, priority, workspace_id, group_jid) VALUES
      ('task_alice_sync', 'Daily Workspace Sync', 'Summarize daily progress across tasks', '0 9 * * *', 'normal', 'web:alice-space', 'web:alice-space'),
      ('task_bob_metrics', 'Weekly Metrics Report', 'Run PostgreSQL queries and build summary', '0 18 * * 5', 'high', 'feishu:bob-space', 'feishu:bob-space');
  `)

  // 5. Channel Accounts & Mounts (Lark & WeChat)
  db.exec(`
    INSERT INTO channel_accounts (id, type, name, status, credential_ref) VALUES
      ('acc_alice_lark', 'lark', 'Alice Lark Bot', 'active', 'cred_alice_lark'),
      ('acc_bob_wechat', 'wechat', 'Bob WeChat Service', 'active', 'cred_bob_wechat'),
      ('acc_charlie_lark', 'lark', 'Charlie Expired Lark', 'active', 'cred_charlie_lark');

    INSERT INTO channel_mounts (id, account_id, workspace_id, group_jid, native_context_id, activation_mode, channel) VALUES
      ('mnt_alice_lark', 'acc_alice_lark', 'web:alice-space', 'web:alice-space', 'oc_alice_chat_123', 'mention', 'lark'),
      ('mnt_bob_wechat', 'acc_bob_wechat', 'feishu:bob-space', 'feishu:bob-space', 'wx_bob_room_456', 'always', 'wechat'),
      ('mnt_charlie_lark', 'acc_charlie_lark', 'web:charlie-space', 'web:charlie-space', 'oc_charlie_chat_789', 'mention', 'lark');
  `)

  // 6. Quotas & Model Preferences
  db.exec(`
    INSERT INTO quotas (id, resource, limit_val, user_id) VALUES
      ('q_charlie_tokens', 'tokens', 100000, 'usr_charlie'),
      ('q_charlie_storage', 'storage_bytes', 52428800, 'usr_charlie');

    INSERT INTO conversation_runtime_state (id, provider, model, reasoning_effort, user_id, workspace_id) VALUES
      ('rt_charlie', 'anthropic', 'claude-3-7-sonnet', 'max', 'usr_charlie', 'web:charlie-space');
  `)

  db.close()

  // 7. Workspace Folders and Instructions (CLAUDE.md, memory.md)
  const aliceSpaceDir = join(groupsDir, 'alice-space')
  const bobSpaceDir = join(groupsDir, 'bob-space')
  const charlieSpaceDir = join(groupsDir, 'charlie-space')
  mkdirSync(aliceSpaceDir, { recursive: true })
  mkdirSync(bobSpaceDir, { recursive: true })
  mkdirSync(charlieSpaceDir, { recursive: true })

  writeFileSync(
    join(aliceSpaceDir, 'CLAUDE.md'),
    '# Alice Space Instructions\n\nAlways provide concise executive summaries and verify code changes.',
    'utf8'
  )
  writeFileSync(
    join(bobSpaceDir, 'memory.md'),
    '# Bob Space Memory\n\nTrack PostgreSQL schema changes and maintain query efficiency.',
    'utf8'
  )
  writeFileSync(
    join(charlieSpaceDir, 'CLAUDE.md'),
    '# Charlie Space Instructions\n\nEnforce strict quota budgeting and audit logging on model invocations.',
    'utf8'
  )

  // Global CLAUDE.md
  writeFileSync(
    join(groupsDir, 'CLAUDE.md'),
    '# Global HappyClaw System Instructions\n\nDefault system behavioral instructions across all workspaces.',
    'utf8'
  )

  // Fake Credentials for SourceCredentialReader
  const fakeCredentials: SourceRawCredential[] = [
    {
      credentialId: 'cred_alice_lark',
      channelType: 'lark',
      accountId: 'acc_alice_lark',
      accountName: 'Alice Lark Bot',
      secretPayload: {
        appId: 'cli_synthetic_alice_123',
        appSecret: 'sec_synthetic_alice_secret_xyz',
      },
      requiresReauth: false,
    },
    {
      credentialId: 'cred_bob_wechat',
      channelType: 'wechat',
      accountId: 'acc_bob_wechat',
      accountName: 'Bob WeChat Service',
      secretPayload: {
        botToken: 'wx_synthetic_bob_token_456',
        ilinkBotId: 'bot_synthetic_bob_789',
      },
      requiresReauth: false,
    },
    {
      credentialId: 'cred_charlie_lark',
      channelType: 'lark',
      accountId: 'acc_charlie_lark',
      accountName: 'Charlie Expired Lark',
      secretPayload: {
        appId: 'cli_synthetic_charlie_expired',
        appSecret: 'sec_synthetic_charlie_invalid',
      },
      requiresReauth: true, // Marked as requiring reauth!
    },
  ]

  return {
    dbPath,
    groupsDir,
    fakeCredentials,
  }
}
