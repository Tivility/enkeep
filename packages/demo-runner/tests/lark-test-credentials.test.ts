import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import {
  parseLarkTestCredentialsPath,
  loadLarkTestCredentials,
  createLarkTestCredentialResolver,
  ensureLarkTestResources,
  bindLarkChatContext,
  getLarkTestCredentialRef,
  getLarkTestAccountId,
  LARK_TEST_SPACE_FOLDER,
  LARK_TEST_SPACE_NAME,
} from '../src/utils/lark-credentials.js';

describe('Lark Test Credentials & Provisioning', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-lark-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('parseLarkTestCredentialsPath', () => {
    it('parses --lark-test-credentials from args', () => {
      expect(parseLarkTestCredentialsPath(['up', '--lark-test-credentials', '/path/to/cred.json'])).toBe(
        '/path/to/cred.json'
      );
      expect(parseLarkTestCredentialsPath(['up', '--lark-test-credentials=/path/to/cred.json'])).toBe(
        '/path/to/cred.json'
      );
    });

    it('falls back to ENKEEP_LARK_TEST_CREDENTIALS_FILE env var', () => {
      expect(
        parseLarkTestCredentialsPath(['up'], { ENKEEP_LARK_TEST_CREDENTIALS_FILE: '/env/path/cred.json' })
      ).toBe('/env/path/cred.json');
    });

    it('CLI arg takes priority over env var', () => {
      expect(
        parseLarkTestCredentialsPath(['up', '--lark-test-credentials', '/cli/cred.json'], {
          ENKEEP_LARK_TEST_CREDENTIALS_FILE: '/env/path/cred.json',
        })
      ).toBe('/cli/cred.json');
    });

    it('returns undefined if not provided', () => {
      expect(parseLarkTestCredentialsPath(['up'])).toBeUndefined();
      expect(parseLarkTestCredentialsPath(['up'], {})).toBeUndefined();
    });

    it('throws if flag given without value', () => {
      expect(() => parseLarkTestCredentialsPath(['up', '--lark-test-credentials'])).toThrow(
        /--lark-test-credentials requires a file path/
      );
      expect(() => parseLarkTestCredentialsPath(['up', '--lark-test-credentials', '--port', '3900'])).toThrow(
        /--lark-test-credentials requires a file path/
      );
      expect(() => parseLarkTestCredentialsPath(['up', '--lark-test-credentials='])).toThrow(
        /--lark-test-credentials requires a file path/
      );
    });
  });

  describe('loadLarkTestCredentials security checks', () => {
    it('rejects relative path', () => {
      expect(() => loadLarkTestCredentials('relative/cred.json')).toThrow(/must be an absolute path/);
    });

    it('rejects non-existent file', () => {
      expect(() => loadLarkTestCredentials(path.join(tmpDir, 'nonexistent.json'))).toThrow(/does not exist/);
    });

    it('rejects symlinks', () => {
      const realFile = path.join(tmpDir, 'real.json');
      fs.writeFileSync(realFile, JSON.stringify({ appId: 'cli_123', appSecret: 'sec_456' }), { mode: 0o600 });
      const symlinkFile = path.join(tmpDir, 'link.json');
      fs.symlinkSync(realFile, symlinkFile);

      expect(() => loadLarkTestCredentials(symlinkFile)).toThrow(/must not be a symbolic link/);
    });

    it('rejects loose file permissions (0644)', () => {
      const looseFile = path.join(tmpDir, 'loose.json');
      fs.writeFileSync(looseFile, JSON.stringify({ appId: 'cli_123', appSecret: 'sec_456' }), { mode: 0o644 });
      fs.chmodSync(looseFile, 0o644);

      expect(() => loadLarkTestCredentials(looseFile)).toThrow(/must have strict 0600 permissions/);
    });

    it('loads valid 0600 file correctly', () => {
      const validFile = path.join(tmpDir, 'valid.json');
      fs.writeFileSync(
        validFile,
        JSON.stringify({ appId: 'cli_0123456789abcdef', appSecret: 'mockSecret123', domain: 'feishu' }),
        { mode: 0o600 }
      );
      fs.chmodSync(validFile, 0o600);

      const creds = loadLarkTestCredentials(validFile);
      expect(creds.appId).toBe('cli_0123456789abcdef');
      expect(creds.appSecret).toBe('mockSecret123');
      expect(creds.domain).toBe('feishu');
    });

    it('rejects invalid JSON or missing fields', () => {
      const invalidJson = path.join(tmpDir, 'bad.json');
      fs.writeFileSync(invalidJson, 'not-json', { mode: 0o600 });
      fs.chmodSync(invalidJson, 0o600);
      expect(() => loadLarkTestCredentials(invalidJson)).toThrow(/does not contain valid JSON/);

      const missingAppId = path.join(tmpDir, 'no_appid.json');
      fs.writeFileSync(missingAppId, JSON.stringify({ appSecret: 'sec' }), { mode: 0o600 });
      fs.chmodSync(missingAppId, 0o600);
      expect(() => loadLarkTestCredentials(missingAppId)).toThrow(/missing non-empty "appId"/);
    });
  });

  describe('createLarkTestCredentialResolver scoping', () => {
    const aliceUserId = '50802077-7efd-4115-a947-8dac8d40efe4';
    const bobUserId = 'ab18cf93-dbb3-4673-b015-52c1734ee52d';
    const appId = 'cli_0123456789abcdef';
    const botOpenId = 'ou_0123456789abcdef0123456789abcdef';
    const credRef = getLarkTestCredentialRef(appId);
    const creds = {
      appId,
      appSecret: 'test_secret_val',
      domain: 'feishu' as const,
      botOpenId,
    };

    const resolver = createLarkTestCredentialResolver(creds, aliceUserId);

    it('resolves for exact aliceUserId and derived credentialRef', async () => {
      const res = await resolver.resolve(aliceUserId, credRef);
      expect(res).not.toBeNull();
      expect(res?.appId).toBe(appId);
      expect(res?.appSecret).toBe('test_secret_val');
      expect(res?.botOpenId).toBe(botOpenId);
    });

    it('returns null for old pilot credentials (cred_alice_lark, cred_charlie_lark)', async () => {
      expect(await resolver.resolve(aliceUserId, 'cred_alice_lark')).toBeNull();
      expect(await resolver.resolve(aliceUserId, 'cred_charlie_lark')).toBeNull();
      expect(await resolver.resolve(aliceUserId, 'random_ref')).toBeNull();
    });

    it('returns null for other users (Bob, etc.)', async () => {
      expect(await resolver.resolve(bobUserId, credRef)).toBeNull();
      expect(await resolver.resolve('unknown_user', credRef)).toBeNull();
    });
  });

  describe('ensureLarkTestResources & bindLarkChatContext', () => {
    it('idempotently provisions space and channel account, and binds chat', async () => {
      const dbPath = path.join(tmpDir, 'test.db');
      const spacesDir = path.join(tmpDir, 'spaces');
      fs.mkdirSync(spacesDir, { recursive: true });

      const db = new DatabaseSync(dbPath);
      // Run minimal migrations for users, spaces, channel_accounts, channel_bindings
      db.exec(`
        CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT);
        CREATE TABLE spaces (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, folder TEXT UNIQUE, execution_mode TEXT, status TEXT, agent_profile_id TEXT, agent_profile_snapshot_id TEXT, created_at TEXT, updated_at TEXT);
        CREATE TABLE channel_accounts (id TEXT PRIMARY KEY, user_id TEXT, type TEXT, status TEXT, credential_ref TEXT, default_space_id TEXT, group_activation_mode TEXT, created_at TEXT, updated_at TEXT);
        CREATE TABLE channel_bindings (id TEXT PRIMARY KEY, user_id TEXT, account_id TEXT, space_id TEXT, native_context_id TEXT, activation_mode TEXT, chat_type TEXT, created_at TEXT, updated_at TEXT);
      `);

      const aliceUserId = '50802077-7efd-4115-a947-8dac8d40efe4';
      db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'alice', 'hash')`).run(aliceUserId);

      const storage = new SqlitePlatformStorage(db);
      const appId = 'cli_0123456789abcdef';
      const expectedAccountId = getLarkTestAccountId(appId);
      const expectedCredRef = getLarkTestCredentialRef(appId);

      // 1. First provision
      const env1 = await ensureLarkTestResources(storage, aliceUserId, spacesDir, appId);
      expect(env1.space.name).toBe(LARK_TEST_SPACE_NAME);
      expect(env1.space.folder).toBe(LARK_TEST_SPACE_FOLDER);
      expect(env1.account.id).toBe(expectedAccountId);
      expect(env1.account.credentialRef).toBe(expectedCredRef);
      expect(fs.existsSync(path.join(spacesDir, LARK_TEST_SPACE_FOLDER))).toBe(true);

      // 2. Second provision (idempotent - no duplicate creation)
      const env2 = await ensureLarkTestResources(storage, aliceUserId, spacesDir, appId);
      expect(env2.space.id).toBe(env1.space.id);
      expect(env2.account.id).toBe(env1.account.id);

      // Verify count in DB is exactly 1 space and 1 account
      const spacesCount = (db.prepare('SELECT COUNT(*) as c FROM spaces').get() as any).c;
      const accountsCount = (db.prepare('SELECT COUNT(*) as c FROM channel_accounts').get() as any).c;
      expect(spacesCount).toBe(1);
      expect(accountsCount).toBe(1);

      // 3. Bind chat
      const binding = await bindLarkChatContext(storage, aliceUserId, 'oc_test_chat_123', {
        activationMode: 'always',
        accountId: expectedAccountId,
      });
      expect(binding.accountId).toBe(expectedAccountId);
      expect(binding.spaceId).toBe(env1.space.id);
      expect(binding.nativeContextId).toBe('oc_test_chat_123');
      expect(binding.activationMode).toBe('always');

      // 4. Re-bind chat idempotently
      const binding2 = await bindLarkChatContext(storage, aliceUserId, 'oc_test_chat_123', {
        activationMode: 'always',
        accountId: expectedAccountId,
      });
      expect(binding2.id).toBe(binding.id);
    });
  });
});
