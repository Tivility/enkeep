#!/usr/bin/env node
/**
 * Read-Only Verifier for Migrated HappyClaw User in Enkeep
 *
 * Verifies:
 * 1. User "tivility" exists, role = 'admin', status = 'active', quota limits = -1.
 * 2. Resource counts: spaces (34), session routes (58), messages (>12k), tasks (25 paused), bindings (26).
 * 3. Feishu channel account: status = 'active', default_space_id set to main--host, encrypted credential row present.
 * 4. Audit of legacy/demo tenants (alice, bob, hpc_admin_shadow).
 *
 * Strictly read-only; never writes or modifies database.
 * Never prints secrets/passwords/payloads.
 */

import { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
let dbPath = process.env.ENKEEP_PLATFORM_DB || path.resolve('.demo-data/platform.db');
let targetUsername = process.env.TARGET_USERNAME || 'tivility';
let vaultKeyFile = process.env.VAULT_KEY_FILE || undefined;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--db' && args[i + 1]) {
    dbPath = path.resolve(args[++i]);
  } else if (arg.startsWith('--db=')) {
    dbPath = path.resolve(arg.slice('--db='.length));
  } else if (arg === '--username' && args[i + 1]) {
    targetUsername = args[++i];
  } else if (arg.startsWith('--username=')) {
    targetUsername = arg.slice('--username='.length);
  } else if (arg === '--vault-key-file' && args[i + 1]) {
    vaultKeyFile = path.resolve(args[++i]);
  } else if (arg.startsWith('--vault-key-file=')) {
    vaultKeyFile = path.resolve(arg.slice('--vault-key-file='.length));
  }
}

console.log('=== Verifying Migrated Enkeep User ===');
console.log(`Database: ${dbPath}`);
console.log(`Target Username: ${targetUsername}\n`);

if (!fs.existsSync(dbPath)) {
  console.error(`FAIL-CLOSED: Database file does not exist at: ${dbPath}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });

let failures = 0;
function assert(condition, message) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    failures++;
  } else {
    console.log(`✅ PASS: ${message}`);
  }
}

// 1. Verify Target User
const user = db.prepare('SELECT id, username, role, status, display_name FROM users WHERE username = ?').get(targetUsername);
assert(user !== undefined, `User "${targetUsername}" exists in users table`);

if (!user) {
  console.error(`Stopping verification: user "${targetUsername}" not found.`);
  process.exit(1);
}

const targetUserId = user.id;
console.log(`   User ID: ${targetUserId}, Display Name: ${user.display_name}`);
assert(user.role === 'admin', `User role is "admin" (got "${user.role}")`);
assert(user.status === 'active', `User status is "active" (got "${user.status}")`);

// Quota Limits Check
const quotaRows = db.prepare('SELECT resource, limit_amount FROM quota_limits WHERE user_id = ?').all(targetUserId);
assert(quotaRows.length === 5, `User has exactly 5 quota limits configured (found ${quotaRows.length})`);
const allUnlimited = quotaRows.every((r) => r.limit_amount === -1);
assert(allUnlimited, 'All 5 quota limits configured with limit_amount = -1 (unlimited)');

// 2. Resource Counts Check
const spacesCount = db.prepare('SELECT COUNT(*) as c FROM spaces WHERE user_id = ?').get(targetUserId).c;
assert(spacesCount === 34, `Spaces count matches expected 34 (found ${spacesCount})`);

const hostSpacesCount = db.prepare("SELECT COUNT(*) as c FROM spaces WHERE user_id = ? AND execution_mode = 'host'").get(targetUserId).c;
const containerSpacesCount = db.prepare("SELECT COUNT(*) as c FROM spaces WHERE user_id = ? AND execution_mode = 'container'").get(targetUserId).c;
console.log(`   Execution Modes: ${hostSpacesCount} host, ${containerSpacesCount} container`);

const routesCount = db.prepare('SELECT COUNT(*) as c FROM session_routes WHERE user_id = ?').get(targetUserId).c;
assert(routesCount === 58 || routesCount === 59, `Session routes count matches expected 58 or 59 (found ${routesCount})`);

const messagesCount = db.prepare('SELECT COUNT(*) as c FROM web_messages WHERE user_id = ?').get(targetUserId).c;
assert(messagesCount >= 12249, `Messages count >= 12,249 (found ${messagesCount})`);

const tasksCount = db.prepare('SELECT COUNT(*) as c FROM platform_tasks WHERE user_id = ?').get(targetUserId).c;
assert(tasksCount === 25, `Platform tasks count matches expected 25 (found ${tasksCount})`);

const enabledSchedules = db.prepare('SELECT COUNT(*) as c FROM task_schedules WHERE user_id = ? AND enabled = 1').get(targetUserId).c;
assert(enabledSchedules === 0, 'All task schedules are paused/disabled (enabled = 0)');

const accountsCount = db.prepare('SELECT COUNT(*) as c FROM channel_accounts WHERE user_id = ?').get(targetUserId).c;
assert(accountsCount >= 3, `Channel accounts count >= 3 (found ${accountsCount})`);

const bindingsCount = db.prepare('SELECT COUNT(*) as c FROM channel_bindings WHERE user_id = ?').get(targetUserId).c;
assert(bindingsCount === 26, `Channel chat bindings count matches expected 26 (found ${bindingsCount})`);

// Skill Packages Check (M21 skill_packages & M30 extension_packages)
const skillPackagesCount = db.prepare('SELECT COUNT(*) as c FROM skill_packages WHERE user_id = ?').get(targetUserId).c;
assert(skillPackagesCount >= 25, `Skill package count >= 25 for user (found ${skillPackagesCount})`);

const extensionPackagesCount = db.prepare('SELECT COUNT(*) as c FROM extension_packages WHERE user_id = ?').get(targetUserId).c;
console.log(`   Skill packages: ${skillPackagesCount} (M21), Extension packages: ${extensionPackagesCount} (M30)`);

// 3. Feishu / Lark Channel Account & Encrypted Credentials
const larkAccount = db.prepare(
  "SELECT id, type, status, credential_ref, default_space_id, group_activation_mode FROM channel_accounts WHERE user_id = ? AND (type = 'lark' OR type = 'feishu')"
).get(targetUserId);

assert(larkAccount !== undefined, 'Feishu/Lark channel account exists for user');
if (larkAccount) {
  assert(larkAccount.status === 'active', `Feishu account is "active" (got "${larkAccount.status}")`);
  assert(larkAccount.group_activation_mode === 'mention', `Group activation mode is "mention" (got "${larkAccount.group_activation_mode}")`);
  assert(Boolean(larkAccount.default_space_id), `Default space ID is configured (${larkAccount.default_space_id})`);

  // Verify default space points to main--host
  const defaultSpace = db.prepare('SELECT name, folder, execution_mode FROM spaces WHERE id = ?').get(larkAccount.default_space_id);
  if (defaultSpace) {
    assert(defaultSpace.folder === 'main--host', `Default space points to "main--host" (got "${defaultSpace.folder}")`);
    console.log(`   Default Space: "${defaultSpace.name}" [folder: ${defaultSpace.folder}, mode: ${defaultSpace.execution_mode}]`);
  } else {
    assert(false, 'Default space record not found in spaces table');
  }

  // Verify Encrypted Credential in channel_encrypted_credentials
  if (larkAccount.credential_ref) {
    const encRow = db.prepare(
      'SELECT id, user_id, credential_ref, length(encrypted_payload) as payload_len FROM channel_encrypted_credentials WHERE user_id = ? AND credential_ref = ?'
    ).get(targetUserId, larkAccount.credential_ref);

    assert(encRow !== undefined, `Encrypted credential row exists in channel_encrypted_credentials for ref "${larkAccount.credential_ref}"`);
    if (encRow) {
      console.log(`   Encrypted Credential Row: ${encRow.id} (<present:len ${encRow.payload_len}>)`);

      // Decrypt-check with vault key if available
      if (vaultKeyFile && fs.existsSync(vaultKeyFile)) {
        try {
          const REPO_ROOT = path.resolve('.');
          const { LarkEncryptedCredentialStore } = await import(
            pathToFileURL(path.join(REPO_ROOT, 'packages/platform-server/dist/channels/lark-encrypted-credentials.js')).href
          );
          const store = new LarkEncryptedCredentialStore({ keyFilePath: vaultKeyFile, db });
          const resolved = await store.resolve(targetUserId, larkAccount.credential_ref);
          assert(resolved !== null, 'LarkEncryptedCredentialStore successfully resolves decrypted credential');
          if (resolved) {
            assert(Boolean(resolved.appId), `Resolved credentials contain appId (${resolved.appId})`);
            assert(Boolean(resolved.appSecret), `Resolved credentials contain appSecret (<present:len ${resolved.appSecret.length}>)`);
            assert(resolved.domain === 'feishu' || resolved.domain === 'lark', `Resolved credentials domain is valid (${resolved.domain})`);
            console.log(`   Decrypted Feishu Payload Round-Trip: appId=${resolved.appId}, appSecret=<present:len ${resolved.appSecret.length}>, domain=${resolved.domain}${resolved.botOpenId ? ', botOpenId=' + resolved.botOpenId : ''}`);
          }
        } catch (decErr) {
          console.error('Decryption verification error:', decErr);
          assert(false, `LarkEncryptedCredentialStore failed to resolve credential: ${decErr.message}`);
        }
      }
    }
  }
}

// Verify other channel accounts (wechat, qq, discord)
const expectedOtherProviders = ['wechat', 'qq', 'discord'];
for (const prov of expectedOtherProviders) {
  const acc = db.prepare('SELECT id, type, status, credential_ref FROM channel_accounts WHERE user_id = ? AND type = ?').get(targetUserId, prov);
  assert(acc !== undefined, `Channel account for "${prov}" exists (id: ${acc?.id})`);
  if (acc) {
    assert(acc.status === 'disabled', `Channel account "${prov}" status is "disabled" (got "${acc.status}")`);
    const encRow = db.prepare('SELECT id, length(encrypted_payload) as payload_len FROM channel_encrypted_credentials WHERE user_id = ? AND credential_ref = ?').get(targetUserId, acc.credential_ref);
    assert(encRow !== undefined, `Encrypted credential row exists for "${prov}" (ref: ${acc.credential_ref}, <present:len ${encRow?.payload_len}>)`);
  }
}

// 4. Audit Legacy / Demo Tenants (alice, bob, hpc_admin_shadow)
console.log('\n--- Legacy / Demo Tenants Audit ---');
const legacyUsers = ['alice', 'bob', 'hpc_admin_shadow'];
for (const leg of legacyUsers) {
  const legUser = db.prepare('SELECT id, username FROM users WHERE username = ?').get(leg);
  if (legUser) {
    const legSpaces = db.prepare('SELECT COUNT(*) as c FROM spaces WHERE user_id = ?').get(legUser.id).c;
    const legRoutes = db.prepare('SELECT COUNT(*) as c FROM session_routes WHERE user_id = ?').get(legUser.id).c;
    const legMsgs = db.prepare('SELECT COUNT(*) as c FROM web_messages WHERE user_id = ?').get(legUser.id).c;
    console.log(`ℹ️  Legacy user "${leg}" still present: ${legSpaces} spaces, ${legRoutes} routes, ${legMsgs} messages (clean up after verify)`);
  } else {
    console.log(`✅ Legacy user "${leg}" has no rows in database`);
  }
}

console.log('\n======================================================');
if (failures === 0) {
  console.log(`🎉 ALL CHECKS PASSED! Migration verification successful for "${targetUsername}".`);
  process.exit(0);
} else {
  console.error(`💥 VERIFICATION FAILED: ${failures} check(s) did not pass.`);
  process.exit(1);
}
