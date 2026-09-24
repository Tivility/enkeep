import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  decryptHappyClawSecretFile,
  encryptHappyClawSecretPayload,
  encryptEnkeepCredential,
  decryptEnkeepCredential,
  createWeChatCredentialRef,
  createWeChatAccountId,
  maskCredentialString,
  resolveHappyClawKey,
  resolveMasterEncryptionKey,
  verifyWeChatEndpointOffline,
  importWeChatCredentials,
  type HappyClawWeChatSecret,
  type EnkeepWeChatCredentialPayload,
} from '../src/wechat-importer.js';

describe('Module I: HappyClaw WeChat Credential Importer & Cutover', () => {
  let tmpDir: string;
  let fakeServer: http.Server | null = null;
  let fakeServerPort: number = 0;
  let receivedAuthHeaders: string[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-importer-test-'));
    receivedAuthHeaders = [];
  });

  afterEach(async () => {
    if (fakeServer) {
      await new Promise<void>((resolve) => {
        fakeServer!.close(() => resolve());
      });
      fakeServer = null;
    }
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Helper to setup mock HappyClaw directory
  function setupMockHappyClaw(keyHex: string): {
    hcDir: string;
    keyFile: string;
    accDir: string;
    dbFile: string;
  } {
    const hcDir = path.join(tmpDir, 'happyclaw');
    const configDir = path.join(hcDir, 'data', 'config');
    const accDir = path.join(configDir, 'channel-accounts');
    const dbDir = path.join(hcDir, 'data', 'db');
    fs.mkdirSync(accDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(dbDir, { recursive: true });

    const keyFile = path.join(configDir, 'claude-provider.key');
    fs.writeFileSync(keyFile, `${keyHex}\n`, { mode: 0o600 });

    const dbFile = path.join(dbDir, 'messages.db');
    const db = new DatabaseSync(dbFile);
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member'
      );
      CREATE TABLE channel_accounts (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        name TEXT NOT NULL,
        secret_ref TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'connected'
      );
      CREATE TABLE registered_groups (
        jid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        folder TEXT NOT NULL,
        created_by TEXT,
        channel_account_id TEXT
      );
    `);
    db.close();

    return { hcDir, keyFile, accDir, dbFile };
  }

  // Helper to setup mock Enkeep target DB
  function setupMockEnkeepDb(): DatabaseSync {
    const dbPath = path.join(tmpDir, 'enkeep-platform.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        status TEXT NOT NULL DEFAULT 'active',
        display_name TEXT
      );
      CREATE TABLE spaces (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        folder TEXT NOT NULL,
        execution_mode TEXT NOT NULL DEFAULT 'container',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );
      CREATE TABLE channel_accounts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        credential_ref TEXT,
        default_space_id TEXT,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );
      CREATE TABLE channel_encrypted_credentials (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        credential_ref TEXT NOT NULL UNIQUE,
        encrypted_payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );
      CREATE TABLE channel_bindings (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        space_id TEXT NOT NULL,
        native_context_id TEXT NOT NULL,
        activation_mode TEXT NOT NULL DEFAULT 'always',
        chat_type TEXT,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        UNIQUE(account_id, native_context_id)
      );
    `);
    return db;
  }

  describe('1. HappyClaw Credential Decryption and Validation', () => {
    it('decrypts mock HappyClaw AES-256-GCM secret and extracts all required fields', () => {
      const rawKey = crypto.randomBytes(32);
      const secretPayload: HappyClawWeChatSecret = {
        botToken: 'mock_bearer_token_58_chars_long_ilink_token_abc123xyz789',
        ilinkBotId: 'bot_mock_ilink_456',
        baseUrl: 'https://ilinkai.weixin.qq.com',
        cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
        getUpdatesBuf: 'cursor_base64_long_string_104_chars_simulated_for_test_purposes_only_sample_data_xyz_abc_def_0123456789==',
        bypassProxy: true,
      };

      const encrypted = encryptHappyClawSecretPayload(secretPayload, rawKey);
      const secretFile = path.join(tmpDir, 'test-secret.json');
      fs.writeFileSync(secretFile, JSON.stringify(encrypted, null, 2), { mode: 0o600 });

      const decrypted = decryptHappyClawSecretFile(secretFile, rawKey);
      expect(decrypted.botToken).toBe(secretPayload.botToken);
      expect(decrypted.ilinkBotId).toBe(secretPayload.ilinkBotId);
      expect(decrypted.baseUrl).toBe(secretPayload.baseUrl);
      expect(decrypted.cdnBaseUrl).toBe(secretPayload.cdnBaseUrl);
      expect(decrypted.getUpdatesBuf).toBe(secretPayload.getUpdatesBuf);
      expect(decrypted.bypassProxy).toBe(true);
    });

    it('fails closed when HappyClaw secret is tampered or decrypt key is wrong', () => {
      const correctKey = crypto.randomBytes(32);
      const wrongKey = crypto.randomBytes(32);
      const secretPayload = {
        botToken: 'secret_token',
        ilinkBotId: 'bot_123',
      };

      const encrypted = encryptHappyClawSecretPayload(secretPayload, correctKey);
      const secretFile = path.join(tmpDir, 'tamper-secret.json');
      fs.writeFileSync(secretFile, JSON.stringify(encrypted));

      expect(() => decryptHappyClawSecretFile(secretFile, wrongKey)).toThrow();
    });

    it('fails closed when required fields are missing', () => {
      const key = crypto.randomBytes(32);
      const incomplete = { baseUrl: 'https://example.com' };
      const encrypted = encryptHappyClawSecretPayload(incomplete, key);
      const secretFile = path.join(tmpDir, 'incomplete.json');
      fs.writeFileSync(secretFile, JSON.stringify(encrypted));

      expect(() => decryptHappyClawSecretFile(secretFile, key)).toThrow(/missing botToken or ilinkBotId/);
    });
  });

  describe('2. Enkeep AAD Re-packaging & Round-trip Integrity', () => {
    it('encrypts and decrypts with strict AAD ${userId}:${credentialRef}', () => {
      const masterKey = crypto.randomBytes(32);
      const userId = 'usr_alice_12345';
      const ilinkBotId = 'bot_alice_ilink';
      const credentialRef = createWeChatCredentialRef(userId, ilinkBotId);

      const payload: EnkeepWeChatCredentialPayload = {
        botToken: 'test_token_content',
        ilinkBotId,
        baseUrl: 'https://ilinkai.weixin.qq.com',
        cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
        getUpdatesBuf: 'cursor_104_chars',
        bypassProxy: true,
      };

      const encryptedEnvelope = encryptEnkeepCredential(masterKey, payload, userId, credentialRef);
      expect(encryptedEnvelope.startsWith('v1:')).toBe(true);

      const decrypted = decryptEnkeepCredential(masterKey, encryptedEnvelope, userId, credentialRef);
      expect(decrypted).toEqual(payload);
    });

    it('fails closed when AAD userId is tampered (cross-tenant attack defense)', () => {
      const masterKey = crypto.randomBytes(32);
      const userAlice = 'usr_alice';
      const userBob = 'usr_bob';
      const credentialRef = 'cred_wechat_shared_ref';

      const encrypted = encryptEnkeepCredential(masterKey, { botToken: 'alice_token' }, userAlice, credentialRef);

      // Decrypting as Bob with same ciphertext must fail
      expect(() => decryptEnkeepCredential(masterKey, encrypted, userBob, credentialRef)).toThrow();
    });

    it('fails closed when ciphertext or tag is modified', () => {
      const masterKey = crypto.randomBytes(32);
      const userId = 'usr_alice';
      const credentialRef = 'cred_wechat_ref';
      const encrypted = encryptEnkeepCredential(masterKey, { botToken: 'test' }, userId, credentialRef);

      const parts = encrypted.split(':');
      // Corrupt dataHex
      const corruptedData = parts[3].slice(0, -2) + (parts[3].endsWith('0') ? '1' : '0');
      const corruptedEnvelope = `v1:${parts[1]}:${parts[2]}:${corruptedData}`;

      expect(() => decryptEnkeepCredential(masterKey, corruptedEnvelope, userId, credentialRef)).toThrow();
    });
  });

  describe('3. End-to-End Migration Orchestration into SQLite', () => {
    it('migrates mock HappyClaw accounts into Enkeep SQLite tables with status: disabled', async () => {
      const keyHex = crypto.randomBytes(32).toString('hex');
      const keyBuf = Buffer.from(keyHex, 'hex');
      const { hcDir, accDir, dbFile } = setupMockHappyClaw(keyHex);
      const targetDb = setupMockEnkeepDb();

      // Seed HappyClaw user and wechat account
      const hcDb = new DatabaseSync(dbFile);
      const hcUserId = 'hc_user_cxx_01';
      const hcAccId = 'hc_acc_cxx_wechat';
      hcDb.prepare('INSERT INTO users (id, username, display_name) VALUES (?, ?, ?)').run(
        hcUserId,
        'cxx',
        'XX'
      );
      hcDb.prepare(
        'INSERT INTO channel_accounts (id, owner_user_id, provider, name, secret_ref, enabled, status) VALUES (?, ?, ?, ?, ?, 1, ?)'
      ).run(hcAccId, hcUserId, 'wechat', '默认微信', `channel-account:${hcAccId}`, 'connected');
      hcDb.prepare(
        'INSERT INTO registered_groups (jid, name, folder, created_by, channel_account_id) VALUES (?, ?, ?, ?, ?)'
      ).run(
        'wechat:owxe59f0c1c911f11e4b9fce97ba@im.wechat',
        '微信私聊',
        'home-cxx',
        hcUserId,
        hcAccId
      );
      hcDb.close();

      // Seed HappyClaw encrypted secret file
      const rawSecret: HappyClawWeChatSecret = {
        botToken: 'mock_token_for_cxx',
        ilinkBotId: 'mock_bot_cxx_123',
        baseUrl: 'https://ilinkai.weixin.qq.com',
        getUpdatesBuf: 'cursor_cxx_104_chars_test_data',
        bypassProxy: true,
      };
      fs.writeFileSync(
        path.join(accDir, `${hcAccId}.json`),
        JSON.stringify(encryptHappyClawSecretPayload(rawSecret, keyBuf), null, 2),
        { mode: 0o600 }
      );

      // Pre-seed Enkeep user and space
      targetDb.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(
        hcUserId,
        'cxx',
        'pwd_hash'
      );
      targetDb.prepare('INSERT INTO spaces (id, user_id, name, folder) VALUES (?, ?, ?, ?)').run(
        'spc_cxx_home',
        hcUserId,
        'XX Home',
        'home-cxx'
      );

      // Run migration
      const report = await importWeChatCredentials({
        hcDir,
        targetDb,
        masterKey: 'enkeep-test-master-key',
        status: 'disabled',
      });

      expect(report.success).toBe(true);
      expect(report.dryRun).toBe(false);
      expect(report.items.length).toBe(1);

      const item = report.items[0];
      expect(item.username).toBe('cxx');
      expect(item.status).toBe('disabled');
      expect(item.cursorLen).toBe(rawSecret.getUpdatesBuf!.length);
      expect(item.ilinkBotIdMasked).toBe('***123');
      expect(item.credentialRef).toBe(createWeChatCredentialRef(hcUserId, rawSecret.ilinkBotId));

      // Verify channel_encrypted_credentials row
      const encRow = targetDb
        .prepare('SELECT * FROM channel_encrypted_credentials WHERE credential_ref = ?')
        .get(item.credentialRef) as any;
      expect(encRow).toBeDefined();
      expect(encRow.user_id).toBe(hcUserId);

      // Verify round-trip resolution
      const decrypted = decryptEnkeepCredential(
        resolveMasterEncryptionKey('enkeep-test-master-key'),
        encRow.encrypted_payload,
        hcUserId,
        item.credentialRef
      );
      expect(decrypted.botToken).toBe(rawSecret.botToken);
      expect(decrypted.ilinkBotId).toBe(rawSecret.ilinkBotId);
      expect(decrypted.getUpdatesBuf).toBe(rawSecret.getUpdatesBuf);

      // Verify channel_accounts row
      const accRow = targetDb.prepare('SELECT * FROM channel_accounts WHERE id = ?').get(item.targetAccountId) as any;
      expect(accRow).toBeDefined();
      expect(accRow.type).toBe('wechat');
      expect(accRow.status).toBe('disabled');
      expect(accRow.credential_ref).toBe(item.credentialRef);
      expect(accRow.default_space_id).toBe('spc_cxx_home');

      // Verify channel_bindings rows
      const bindings = targetDb
        .prepare('SELECT * FROM channel_bindings WHERE account_id = ?')
        .all(item.targetAccountId) as any[];
      expect(bindings.length).toBeGreaterThanOrEqual(1);
      const nativeContextIds = bindings.map((b) => b.native_context_id);
      expect(nativeContextIds).toContain('wechat:owxe59f0c1c911f11e4b9fce97ba');
    });

    it('supports dry-run mode without modifying target database', async () => {
      const keyHex = crypto.randomBytes(32).toString('hex');
      const keyBuf = Buffer.from(keyHex, 'hex');
      const { hcDir, accDir, dbFile } = setupMockHappyClaw(keyHex);
      const targetDb = setupMockEnkeepDb();

      // Seed HappyClaw
      const hcDb = new DatabaseSync(dbFile);
      hcDb.prepare('INSERT INTO users (id, username, display_name) VALUES (?, ?, ?)').run('u1', 'whz', 'whz');
      hcDb.prepare(
        'INSERT INTO channel_accounts (id, owner_user_id, provider, name, secret_ref, enabled, status) VALUES (?, ?, ?, ?, ?, 1, ?)'
      ).run('acc1', 'u1', 'wechat', '默认微信', 'channel-account:acc1', 'connected');
      hcDb.close();

      fs.writeFileSync(
        path.join(accDir, 'acc1.json'),
        JSON.stringify(
          encryptHappyClawSecretPayload(
            {
              botToken: 'token_whz',
              ilinkBotId: 'bot_whz_999',
              getUpdatesBuf: 'whz_cursor_buf',
            },
            keyBuf
          )
        )
      );

      const report = await importWeChatCredentials({
        hcDir,
        targetDb,
        dryRun: true,
      });

      expect(report.dryRun).toBe(true);
      expect(report.items.length).toBe(1);

      // Verify DB was NOT modified
      const countAcc = targetDb.prepare('SELECT count(*) as count FROM channel_accounts').get() as any;
      const countCred = targetDb.prepare('SELECT count(*) as count FROM channel_encrypted_credentials').get() as any;
      expect(countAcc.count).toBe(0);
      expect(countCred.count).toBe(0);
    });

    it('is idempotent when executed repeatedly and updates status on --activate', async () => {
      const keyHex = crypto.randomBytes(32).toString('hex');
      const keyBuf = Buffer.from(keyHex, 'hex');
      const { hcDir, accDir, dbFile } = setupMockHappyClaw(keyHex);
      const targetDb = setupMockEnkeepDb();

      const hcDb = new DatabaseSync(dbFile);
      hcDb.prepare('INSERT INTO users (id, username, display_name) VALUES (?, ?, ?)').run('u1', 'cxx', 'cxx');
      hcDb.prepare(
        'INSERT INTO channel_accounts (id, owner_user_id, provider, name, secret_ref, enabled, status) VALUES (?, ?, ?, ?, ?, 1, ?)'
      ).run('acc1', 'u1', 'wechat', '默认微信', 'channel-account:acc1', 'connected');
      hcDb.close();

      fs.writeFileSync(
        path.join(accDir, 'acc1.json'),
        JSON.stringify(
          encryptHappyClawSecretPayload(
            {
              botToken: 'token_cxx',
              ilinkBotId: 'bot_cxx_888',
              getUpdatesBuf: 'cursor_v1',
            },
            keyBuf
          )
        )
      );

      // Run 1: disabled
      await importWeChatCredentials({
        hcDir,
        targetDb,
        status: 'disabled',
      });

      const accRow1 = targetDb.prepare('SELECT * FROM channel_accounts WHERE id = ?').get('acc_hpc_wechat_u1') as any;
      expect(accRow1.status).toBe('disabled');

      // Run 2: activate
      await importWeChatCredentials({
        hcDir,
        targetDb,
        activate: true,
      });

      const accRow2 = targetDb.prepare('SELECT * FROM channel_accounts WHERE id = ?').get('acc_hpc_wechat_u1') as any;
      expect(accRow2.status).toBe('active');

      // Still only 1 account and 1 credential row
      const countAcc = targetDb.prepare('SELECT count(*) as count FROM channel_accounts').get() as any;
      const countCred = targetDb.prepare('SELECT count(*) as count FROM channel_encrypted_credentials').get() as any;
      expect(countAcc.count).toBe(1);
      expect(countCred.count).toBe(1);
    });

    it('filters migration by specific user', async () => {
      const keyHex = crypto.randomBytes(32).toString('hex');
      const keyBuf = Buffer.from(keyHex, 'hex');
      const { hcDir, accDir, dbFile } = setupMockHappyClaw(keyHex);
      const targetDb = setupMockEnkeepDb();

      const hcDb = new DatabaseSync(dbFile);
      hcDb.prepare('INSERT INTO users (id, username, display_name) VALUES (?, ?, ?)').run('u_cxx', 'cxx', 'cxx');
      hcDb.prepare('INSERT INTO users (id, username, display_name) VALUES (?, ?, ?)').run('u_whz', 'whz', 'whz');
      hcDb.prepare(
        'INSERT INTO channel_accounts (id, owner_user_id, provider, name, secret_ref, enabled, status) VALUES (?, ?, ?, ?, ?, 1, ?)'
      ).run('acc_cxx', 'u_cxx', 'wechat', 'cxx微信', 'channel-account:acc_cxx', 'connected');
      hcDb.prepare(
        'INSERT INTO channel_accounts (id, owner_user_id, provider, name, secret_ref, enabled, status) VALUES (?, ?, ?, ?, ?, 1, ?)'
      ).run('acc_whz', 'u_whz', 'wechat', 'whz微信', 'channel-account:acc_whz', 'connected');
      hcDb.close();

      fs.writeFileSync(
        path.join(accDir, 'acc_cxx.json'),
        JSON.stringify(encryptHappyClawSecretPayload({ botToken: 'tok1', ilinkBotId: 'bot1' }, keyBuf))
      );
      fs.writeFileSync(
        path.join(accDir, 'acc_whz.json'),
        JSON.stringify(encryptHappyClawSecretPayload({ botToken: 'tok2', ilinkBotId: 'bot2' }, keyBuf))
      );

      const report = await importWeChatCredentials({
        hcDir,
        targetDb,
        user: 'cxx',
      });

      expect(report.items.length).toBe(1);
      expect(report.items[0].username).toBe('cxx');
    });
  });

  describe('4. Focused Offline Tests with Local Fake HTTP Server', () => {
    it('verifies fake endpoint connectivity and Authorization header offline', async () => {
      // Start local fake HTTP server
      fakeServer = http.createServer((req, res) => {
        receivedAuthHeaders.push(req.headers['authorization'] || '');
        if (req.url === '/ilink/bot/getconfig') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ret: 0, errcode: 0, errmsg: 'ok' }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      await new Promise<void>((resolve) => {
        fakeServer!.listen(0, '127.0.0.1', () => {
          const addr = fakeServer!.address() as any;
          fakeServerPort = addr.port;
          resolve();
        });
      });

      const fakeBaseUrl = `http://127.0.0.1:${fakeServerPort}`;
      const fakeToken = 'offline_fake_token_value_xyz';

      const check = await verifyWeChatEndpointOffline(fakeBaseUrl, fakeToken);
      expect(check.ok).toBe(true);
      expect(check.status).toBe(200);
      expect(receivedAuthHeaders).toContain(`Bearer ${fakeToken}`);
    });

    it('handles fake endpoint failure response without crashing', async () => {
      fakeServer = http.createServer((req, res) => {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ret: -14, errcode: -14, errmsg: 'session expired' }));
      });

      await new Promise<void>((resolve) => {
        fakeServer!.listen(0, '127.0.0.1', () => {
          const addr = fakeServer!.address() as any;
          fakeServerPort = addr.port;
          resolve();
        });
      });

      const fakeBaseUrl = `http://127.0.0.1:${fakeServerPort}`;
      const check = await verifyWeChatEndpointOffline(fakeBaseUrl, 'any_token');
      expect(check.ok).toBe(false);
      expect(check.status).toBe(401);
    });

    it('handles network connection refused on non-existent port gracefully', async () => {
      const nonExistentUrl = 'http://127.0.0.1:49999';
      const check = await verifyWeChatEndpointOffline(nonExistentUrl, 'token', { timeoutMs: 500 });
      expect(check.ok).toBe(false);
      expect(check.status).toBe(0);
    });
  });

  describe('5. Zero Secrets Leakage Invariant Verification', () => {
    it('masks credential strings and prevents secret leaks in reports', () => {
      expect(maskCredentialString('bot_123456789')).toBe('***789');
      expect(maskCredentialString('ilink_bot_whz')).toBe('***whz');
      expect(maskCredentialString('')).toBe('***');
      expect(maskCredentialString(null)).toBe('***');
      expect(maskCredentialString('abc')).toBe('***abc');

      const item = {
        username: 'whz',
        sourceUserId: 'usr_1',
        targetUserId: 'usr_1',
        sourceAccountId: 'acc_1',
        targetAccountId: 'acc_hpc_wechat_usr_1',
        ilinkBotIdMasked: maskCredentialString('bot_whz_secret_id_123'),
        cursorLen: 108,
        credentialRef: 'cred_wechat_abcdef1234567890',
        status: 'disabled' as const,
        defaultSpaceId: null,
        bindingsCount: 1,
      };

      const serialized = JSON.stringify(item);
      expect(serialized).not.toContain('bot_whz_secret_id_123');
      expect(serialized).toContain('***123');
    });
  });
});
