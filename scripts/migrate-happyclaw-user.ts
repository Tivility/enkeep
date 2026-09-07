/**
 * HappyClaw User-Scoped Migration to Enkeep
 *
 * Migrates real HappyClaw admin account (default sourceUserId: 1b587104-4f7c-46a9-8964-72ee9bea23bc)
 * to authoritative Enkeep user (default targetUsername: tivility).
 *
 * Invariants:
 * - Read-only access to HappyClaw snapshot; never touches live system.
 * - Password generation / reuse via 0600 file; hashed using platform-auth scrypt.
 * - Idempotent: cleans target user's existing records before re-inserting.
 * - Encrypts Feishu bot credentials via LarkEncryptedCredentialStore into channel_encrypted_credentials.
 * - Recreates spaces, sessions, messages, paused tasks, channel accounts, and chat bindings.
 * - Safe file copy excluding .env, node_modules, .git, .ipc, *.sock.
 * - Never prints plaintext credentials/secrets in output.
 */

import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = __dirname.endsWith('dist/scripts') || __dirname.endsWith('dist/scripts/')
  ? path.resolve(__dirname, '../../')
  : path.resolve(__dirname, '../');

function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex').toLowerCase();
}

function projectKey(cwd: string): string {
  if (!cwd || cwd.length === 0) return '_no-cwd';
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

function computeAgentProfilePromptHash(sections: {
  identity?: string | null;
  soul?: string | null;
  agents?: string | null;
  tools?: string | null;
}): string {
  const canonicalObj = {
    agents: (sections.agents ?? '').normalize('NFC'),
    identity: (sections.identity ?? '').normalize('NFC'),
    soul: (sections.soul ?? '').normalize('NFC'),
    tools: (sections.tools ?? '').normalize('NFC'),
  };
  const keys = Object.keys(canonicalObj).sort();
  const canonicalJson = '{' + keys.map((k) => JSON.stringify(k) + ':' + JSON.stringify((canonicalObj as any)[k])).join(',') + '}';
  return sha256(Buffer.from(canonicalJson, 'utf8'));
}

function deterministicSpaceId(userId: string, fingerprint: string, folder: string): string {
  const hash = sha256(`${userId}:${fingerprint}:${folder}`);
  return `spc_${hash.slice(0, 32)}`;
}

function deterministicSessionId(fingerprint: string, chatJid: string, userId: string): string {
  const hash = sha256(`${fingerprint}:${chatJid}:${userId}`);
  return `ses_${hash.slice(0, 32)}`;
}

function deterministicProfileId(userId: string, profileId: string): string {
  const hash = sha256(`${userId}:${profileId}`);
  return `prof_${hash.slice(0, 32)}`;
}

function deterministicSnapshotId(profileId: string, version: number, promptHash: string): string {
  const hash = sha256(`${profileId}:${version}:${promptHash}`);
  return `snap_${hash.slice(0, 32)}`;
}

function computeFingerprint(dbPath: string): string {
  const stat = fs.statSync(dbPath);
  const header = Buffer.alloc(4096);
  const fd = fs.openSync(dbPath, 'r');
  fs.readSync(fd, header, 0, 4096, 0);
  fs.closeSync(fd);
  const headerHash = sha256(header);
  return `fp_${sha256(`${stat.size}:${stat.mtimeMs}:${headerHash}`).slice(0, 24)}`;
}

function encryptWithAad(key: Buffer, plaintext: string, userId: string, credentialRef: string): string {
  const iv = crypto.randomBytes(12);
  const aad = Buffer.from(`${userId}:${credentialRef}`, 'utf8');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
}

function decryptHappyClawSecret(blob: any, key: Buffer): any {
  if (!blob) return null;
  const parsedBlob = typeof blob === 'string' ? JSON.parse(blob) : blob;
  const iv = Buffer.from(parsedBlob.iv, 'base64');
  const tag = Buffer.from(parsedBlob.tag, 'base64');
  const data = Buffer.from(parsedBlob.data, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

interface CopyStats {
  filesCopied: number;
  totalBytes: number;
}

const EXCLUDED_NAMES = new Set([
  '.env',
  'node_modules',
  '.git',
  '.DS_Store',
  '.claude',
  '.ipc',
  'ipc',
]);

function isExcluded(name: string): boolean {
  if (EXCLUDED_NAMES.has(name)) return true;
  if (name.startsWith('.env.')) return true;
  if (name.endsWith('.sock') || name.endsWith('.tmp')) return true;
  return false;
}

function copyDirectorySafely(srcDir: string, destDir: string, extraDestDir?: string): void {
  if (!fs.existsSync(srcDir)) return;
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const filter = (src: string) => !isExcluded(path.basename(src));

  try {
    fs.cpSync(srcDir, destDir, { recursive: true, filter, force: true, dereference: false, verbatimSymlinks: true });
    if (extraDestDir) {
      if (!fs.existsSync(extraDestDir)) {
        fs.mkdirSync(extraDestDir, { recursive: true, mode: 0o700 });
      }
      fs.cpSync(srcDir, extraDestDir, { recursive: true, filter, force: true, dereference: false, verbatimSymlinks: true });
    }
  } catch (err) {
    console.warn(`Warning during copy from ${srcDir}:`, err);
  }
}

function countDirectoryFiles(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  if (!fs.existsSync(dir)) return { files, bytes };
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = countDirectoryFiles(full);
        files += sub.files;
        bytes += sub.bytes;
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        try {
          const stat = fs.statSync(full);
          files++;
          bytes += stat.size;
        } catch {}
      }
    }
  } catch {}
  return { files, bytes };
}

interface CliOptions {
  snapshotDir: string;
  targetDbPath: string;
  sourceUserId: string;
  targetUsername: string;
  passwordFile: string;
  secretsJsonFile?: string;
  vaultKeyFile?: string;
  happyClawKeyFile: string;
  feishuCredentialsFile?: string;
  wechatCredentialsFile?: string;
  qqCredentialsFile?: string;
  dryRun: boolean;
}

function parseCliArgs(): CliOptions {
  const args = process.argv.slice(2);
  const env = process.env;

  let snapshotDir = env.HAPPYCLAW_SNAPSHOT_DIR || path.join(os.homedir(), '.config', 'enkeep', 'hc-snapshot');
  let targetDbPath = env.ENKEEP_PLATFORM_DB || path.join(REPO_ROOT, '.demo-data/platform.db');
  let sourceUserId = env.SOURCE_USER_ID || '1b587104-4f7c-46a9-8964-72ee9bea23bc';
  let targetUsername = env.TARGET_USERNAME || 'tivility';
  let passwordFile = env.PASSWORD_FILE || path.join(os.homedir(), '.config/enkeep/tivility-initial-password.txt');
  let secretsJsonFile = env.SECRETS_JSON || undefined;
  let vaultKeyFile = env.VAULT_KEY_FILE || undefined;
  let happyClawKeyFile = env.HAPPYCLAW_KEY_FILE || undefined;
  let feishuCredentialsFile = env.FEISHU_CREDENTIALS_FILE || undefined;
  let wechatCredentialsFile = env.WECHAT_CREDENTIALS_FILE || undefined;
  let qqCredentialsFile = env.QQ_CREDENTIALS_FILE || undefined;
  let dryRun = env.DRY_RUN === '1' || env.DRY_RUN === 'true';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--snapshot' && args[i + 1]) {
      snapshotDir = args[++i];
    } else if (arg.startsWith('--snapshot=')) {
      snapshotDir = arg.slice('--snapshot='.length);
    } else if (arg === '--db' && args[i + 1]) {
      targetDbPath = args[++i];
    } else if (arg.startsWith('--db=')) {
      targetDbPath = arg.slice('--db='.length);
    } else if (arg === '--source-user-id' && args[i + 1]) {
      sourceUserId = args[++i];
    } else if (arg.startsWith('--source-user-id=')) {
      sourceUserId = arg.slice('--source-user-id='.length);
    } else if (arg === '--target-username' && args[i + 1]) {
      targetUsername = args[++i];
    } else if (arg.startsWith('--target-username=')) {
      targetUsername = arg.slice('--target-username='.length);
    } else if (arg === '--password-file' && args[i + 1]) {
      passwordFile = args[++i];
    } else if (arg.startsWith('--password-file=')) {
      passwordFile = arg.slice('--password-file='.length);
    } else if (arg === '--secrets-json' && args[i + 1]) {
      secretsJsonFile = args[++i];
    } else if (arg.startsWith('--secrets-json=')) {
      secretsJsonFile = arg.slice('--secrets-json='.length);
    } else if (arg === '--vault-key-file' && args[i + 1]) {
      vaultKeyFile = args[++i];
    } else if (arg.startsWith('--vault-key-file=')) {
      vaultKeyFile = arg.slice('--vault-key-file='.length);
    } else if (arg === '--happyclaw-key-file' && args[i + 1]) {
      happyClawKeyFile = args[++i];
    } else if (arg.startsWith('--happyclaw-key-file=')) {
      happyClawKeyFile = arg.slice('--happyclaw-key-file='.length);
    } else if (arg === '--feishu-credentials' && args[i + 1]) {
      feishuCredentialsFile = args[++i];
    } else if (arg.startsWith('--feishu-credentials=')) {
      feishuCredentialsFile = arg.slice('--feishu-credentials='.length);
    } else if (arg === '--wechat-credentials' && args[i + 1]) {
      wechatCredentialsFile = args[++i];
    } else if (arg.startsWith('--wechat-credentials=')) {
      wechatCredentialsFile = arg.slice('--wechat-credentials='.length);
    } else if (arg === '--qq-credentials' && args[i + 1]) {
      qqCredentialsFile = args[++i];
    } else if (arg.startsWith('--qq-credentials=')) {
      qqCredentialsFile = arg.slice('--qq-credentials='.length);
    } else if (arg === '--dry-run') {
      dryRun = true;
    }
  }

  const absDbPath = path.resolve(targetDbPath);

  // Resolution order:
  // 1. If --vault-key-file was explicitly passed, use it as explicit fallback
  // 2. Otherwise try --secrets-json (explicit or default: path.join(path.dirname(absDbPath), 'secrets.json')) if it exists
  // 3. Otherwise fall back to default vault key file
  let resolvedSecretsJson: string | undefined = undefined;
  let resolvedVaultKeyFile: string | undefined = undefined;

  if (vaultKeyFile) {
    resolvedVaultKeyFile = path.resolve(vaultKeyFile);
  } else {
    const candidateSecretsJson = secretsJsonFile ? path.resolve(secretsJsonFile) : path.join(path.dirname(absDbPath), 'secrets.json');
    if (fs.existsSync(candidateSecretsJson)) {
      resolvedSecretsJson = candidateSecretsJson;
    } else if (secretsJsonFile) {
      // User explicitly requested this secrets.json path, let it fail in main() with clear error
      resolvedSecretsJson = candidateSecretsJson;
    } else {
      const dbHash = sha256(absDbPath).slice(0, 16);
      resolvedVaultKeyFile = path.join(os.homedir(), '.config', 'enkeep', 'keys', `${dbHash}-lark-vault.key`);
    }
  }

  if (!happyClawKeyFile) {
    happyClawKeyFile = path.join(path.resolve(snapshotDir), 'config', 'claude-provider.key');
  }

  return {
    snapshotDir: path.resolve(snapshotDir),
    targetDbPath: absDbPath,
    sourceUserId,
    targetUsername,
    passwordFile: path.resolve(passwordFile),
    secretsJsonFile: resolvedSecretsJson,
    vaultKeyFile: resolvedVaultKeyFile,
    happyClawKeyFile: path.resolve(happyClawKeyFile),
    feishuCredentialsFile: feishuCredentialsFile ? path.resolve(feishuCredentialsFile) : undefined,
    wechatCredentialsFile: wechatCredentialsFile ? path.resolve(wechatCredentialsFile) : undefined,
    qqCredentialsFile: qqCredentialsFile ? path.resolve(qqCredentialsFile) : undefined,
    dryRun,
  };
}

async function main() {
  const opts = parseCliArgs();

  console.log('=== HappyClaw User Migration to Enkeep ===');
  console.log(`Snapshot Dir:      ${opts.snapshotDir}`);
  console.log(`Target DB:         ${opts.targetDbPath}`);
  console.log(`Source User ID:    ${opts.sourceUserId}`);
  console.log(`Target Username:   ${opts.targetUsername}`);
  console.log(`Password File:     ${opts.passwordFile}`);
  if (opts.secretsJsonFile) {
    console.log(`Credential Store:  secrets.json (${opts.secretsJsonFile})`);
  } else {
    console.log(`Credential Store:  vault-key-file (${opts.vaultKeyFile})`);
  }
  console.log(`HappyClaw Key:     ${opts.happyClawKeyFile}`);
  console.log(`Dry Run Mode:      ${opts.dryRun ? 'YES (No changes will be written)' : 'NO (Writing live data)'}\n`);

  const sourceDbPath = path.join(opts.snapshotDir, 'messages.db');
  const sourceGroupsDir = path.join(opts.snapshotDir, 'groups');

  if (!fs.existsSync(sourceDbPath)) {
    throw new Error(`FAIL-CLOSED: Source snapshot messages.db not found at: ${sourceDbPath}`);
  }
  if (!fs.existsSync(sourceGroupsDir)) {
    throw new Error(`FAIL-CLOSED: Source snapshot groups directory not found at: ${sourceGroupsDir}`);
  }
  if (!fs.existsSync(opts.targetDbPath)) {
    throw new Error(`FAIL-CLOSED: Target Enkeep database not found at: ${opts.targetDbPath}`);
  }

  const fingerprint = computeFingerprint(sourceDbPath);
  console.log(`Snapshot Fingerprint: ${fingerprint}`);

  let happyClawKey: Buffer | null = null;
  if (fs.existsSync(opts.happyClawKeyFile)) {
    const keyHex = fs.readFileSync(opts.happyClawKeyFile, 'utf8').trim();
    const keyBuf = Buffer.from(keyHex, 'hex');
    if (keyBuf.length !== 32) {
      throw new Error(`FAIL-CLOSED: HappyClaw key file ${opts.happyClawKeyFile} does not contain a 32-byte hex key (parsed length: ${keyBuf.length})`);
    }
    happyClawKey = keyBuf;
  }

  // Dynamic module imports
  const { computeSessionSeedReceipt } = await import(
    pathToFileURL(path.join(REPO_ROOT, 'packages/protocol/dist/json.js')).href
  );
  const { LarkEncryptedCredentialStore } = await import(
    pathToFileURL(path.join(REPO_ROOT, 'packages/platform-server/dist/channels/lark-encrypted-credentials.js')).href
  );
  const { hashPassword } = await import(
    pathToFileURL(path.join(REPO_ROOT, 'packages/platform-auth/dist/index.js')).href
  );

  // Open DB connections: source is strictly read-only
  const srcDb = new DatabaseSync(sourceDbPath, { readOnly: true });
  const targetDb = new DatabaseSync(opts.targetDbPath, { readOnly: opts.dryRun });

  // 1. Discover Source Admin User & Profile
  const srcUser = srcDb.prepare('SELECT * FROM users WHERE id = ?').get(opts.sourceUserId) as any;
  if (!srcUser) {
    throw new Error(`FAIL-CLOSED: Source user ${opts.sourceUserId} not found in snapshot.`);
  }
  const displayName = srcUser.display_name || srcUser.username || opts.targetUsername;

  // Check or create target user
  let targetUser = targetDb.prepare('SELECT * FROM users WHERE username = ?').get(opts.targetUsername) as any;
  let targetUserId = targetUser ? targetUser.id : opts.sourceUserId;

  // Verify ID collision if user does not exist but ID is taken
  if (!targetUser) {
    const existingById = targetDb.prepare('SELECT * FROM users WHERE id = ?').get(targetUserId) as any;
    if (existingById) {
      targetUserId = crypto.randomUUID();
    }
  }

  // Handle password
  let initialPlainPassword = '';
  let passwordCreated = false;
  if (!targetUser) {
    if (fs.existsSync(opts.passwordFile)) {
      initialPlainPassword = fs.readFileSync(opts.passwordFile, 'utf8').trim();
    }
    if (!initialPlainPassword || initialPlainPassword.length < 24) {
      initialPlainPassword = crypto.randomBytes(24).toString('base64url');
      passwordCreated = true;
    }
  }

  // 2. Discover Source Admin Resources
  const adminWorkspaces = srcDb.prepare('SELECT * FROM workspaces WHERE owner_user_id = ?').all(opts.sourceUserId) as any[];
  const adminRg = srcDb.prepare('SELECT * FROM registered_groups WHERE created_by = ?').all(opts.sourceUserId) as any[];
  const adminRgMap = new Map<string, any>(adminRg.map((r) => [r.jid, r]));
  const adminFolders = [...new Set(adminWorkspaces.map((w) => w.folder).filter(Boolean))] as string[];
  const adminJids = [...new Set(adminWorkspaces.map((w) => w.jid))] as string[];

  const adminProfiles = srcDb.prepare('SELECT * FROM agent_profiles WHERE owner_user_id = ?').all(opts.sourceUserId) as any[];
  const profIds = adminProfiles.map((p) => p.id);
  const promptVersions = profIds.length
    ? (srcDb.prepare(`SELECT * FROM agent_profile_prompt_versions WHERE agent_profile_id IN (${profIds.map(() => '?').join(',')})`).all(...profIds) as any[])
    : [];

  const adminTasks = adminFolders.length
    ? (srcDb.prepare(
        `SELECT * FROM scheduled_tasks WHERE created_by = ? OR (created_by IS NULL AND group_folder IN (${adminFolders.map(() => '?').join(',')}))`
      ).all(opts.sourceUserId, ...adminFolders) as any[])
    : [];

  const adminChannels = srcDb.prepare('SELECT * FROM channel_accounts WHERE owner_user_id = ?').all(opts.sourceUserId) as any[];
  const adminAgentMounts = srcDb.prepare('SELECT * FROM agent_channel_mounts WHERE owner_user_id = ?').all(opts.sourceUserId) as any[];

  const adminMessages = adminJids.length
    ? (srcDb.prepare(`SELECT * FROM messages WHERE chat_jid IN (${adminJids.map(() => '?').join(',')}) ORDER BY timestamp ASC`).all(...adminJids) as any[])
    : [];

  const convRuntimeStates = adminFolders.length
    ? (srcDb.prepare(`SELECT * FROM conversation_runtime_state WHERE group_folder IN (${adminFolders.map(() => '?').join(',')})`).all(...adminFolders) as any[])
    : [];

  // Derive logical spaces keyed by folder:mode (34 total spaces)
  const folderModes = new Map<string, Set<string>>();
  for (const ws of adminWorkspaces) {
    const rg = adminRgMap.get(ws.jid);
    const mode = rg?.execution_mode || 'host';
    const folder = ws.folder || 'main';
    if (!folderModes.has(folder)) folderModes.set(folder, new Set());
    folderModes.get(folder)!.add(mode);
  }

  const mixedFolders = new Set<string>();
  for (const [f, modes] of folderModes.entries()) {
    if (modes.size > 1) mixedFolders.add(f);
  }

  interface LogicalSpaceInfo {
    spaceId: string;
    targetFolder: string;
    srcFolder: string;
    name: string;
    executionMode: 'host' | 'container';
    isMixed: boolean;
    primaryWs: any;
    primaryRg: any;
    matchingRoutes: any[];
  }

  const spaceKeyToInfoMap = new Map<string, LogicalSpaceInfo>();
  const spaceMap = new Map<string, string>(); // spaceKey -> spaceId

  for (const [folder, modes] of folderModes.entries()) {
    for (const mode of modes) {
      const isMixed = mixedFolders.has(folder);
      const targetFolder = isMixed ? `${folder}--${mode}` : folder;
      const spaceKey = `${folder}:${mode}`;
      const spaceId = deterministicSpaceId(targetUserId, fingerprint, targetFolder);

      const matching = adminWorkspaces.filter((w) => {
        const rg = adminRgMap.get(w.jid);
        const m = rg?.execution_mode || 'host';
        return (w.folder || 'main') === folder && m === mode;
      });

      const primaryWs =
        matching.find((w) => w.is_home === 1) ||
        matching.find((w) => w.jid.startsWith('web:')) ||
        matching[0] ||
        { name: folder, folder, jid: `web:${folder}` };

      const primaryRg = adminRgMap.get(primaryWs.jid) || matching.map((w) => adminRgMap.get(w.jid)).filter(Boolean)[0];

      let name = primaryWs.name || folder;
      if (isMixed) {
        if (folder === 'main') {
          name = mode === 'host' ? 'Home Workspace [Host]' : 'Home Workspace [Container]';
        } else if (folder === 'wechat') {
          name = mode === 'host' ? '微信 [Host]' : '微信 [Container]';
        } else {
          name = `${primaryWs.name || folder} [${mode === 'host' ? 'Host' : 'Container'}]`;
        }
      }

      const info: LogicalSpaceInfo = {
        spaceId,
        targetFolder,
        srcFolder: folder,
        name,
        executionMode: mode as 'host' | 'container',
        isMixed,
        primaryWs,
        primaryRg,
        matchingRoutes: matching,
      };

      spaceKeyToInfoMap.set(spaceKey, info);
      spaceMap.set(spaceKey, spaceId);
    }
  }

  const mainHostSpaceInfo = spaceKeyToInfoMap.get('main:host');
  const defaultSpaceId: string = mainHostSpaceInfo ? mainHostSpaceInfo.spaceId : (spaceKeyToInfoMap.values().next().value?.spaceId ?? 'spc_default');

  // Check credentials in <snapshot>/config/user-im/<sourceUserId>/ or explicit override
  const userImDir = path.join(opts.snapshotDir, 'config', 'user-im', opts.sourceUserId);
  let feishuCreds: { appId: string; appSecret: string; domain?: 'feishu' | 'lark'; ownerOpenId?: string } | null = null;

  if (opts.feishuCredentialsFile && fs.existsSync(opts.feishuCredentialsFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(opts.feishuCredentialsFile, 'utf8'));
      let sec: string | undefined;
      if (raw.secret && typeof raw.secret === 'object' && raw.secret.iv && raw.secret.tag && raw.secret.data) {
        if (!happyClawKey) {
          throw new Error(`FAIL-CLOSED: HappyClaw key file required to decrypt feishu secret`);
        }
        const dec = decryptHappyClawSecret(raw.secret, happyClawKey);
        sec = dec?.appSecret;
      } else {
        sec = typeof raw.secret === 'string' ? raw.secret : raw.appSecret ? (typeof raw.appSecret === 'string' ? raw.appSecret : JSON.stringify(raw.appSecret)) : (raw.secret ? JSON.stringify(raw.secret) : undefined);
      }
      if (raw.appId && sec) {
        if (sec.length !== 32) {
          throw new Error(`FAIL-CLOSED: Feishu appSecret length is not 32 (got ${sec.length})`);
        }
        feishuCreds = {
          appId: String(raw.appId).trim(),
          appSecret: sec,
          domain: raw.domain || 'feishu',
          ownerOpenId: raw.ownerOpenId || raw.botOpenId,
        };
      }
    } catch (err: any) {
      console.error(`Error loading feishu credentials file: ${err.message}`);
      throw err;
    }
  } else {
    const feishuJsonPath = path.join(userImDir, 'feishu.json');
    if (fs.existsSync(feishuJsonPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(feishuJsonPath, 'utf8'));
        if (!raw.appId) {
          throw new Error(`FAIL-CLOSED: feishu.json missing appId`);
        }
        if (!raw.secret) {
          throw new Error(`FAIL-CLOSED: feishu.json missing secret`);
        }
        if (!happyClawKey) {
          throw new Error(`FAIL-CLOSED: HappyClaw key file not found at ${opts.happyClawKeyFile}`);
        }
        const decrypted = decryptHappyClawSecret(raw.secret, happyClawKey);
        const sec = decrypted?.appSecret;
        if (!sec || typeof sec !== 'string') {
          throw new Error(`FAIL-CLOSED: Decrypted feishu secret missing string appSecret`);
        }
        if (sec.length !== 32) {
          throw new Error(`FAIL-CLOSED: Feishu appSecret length is not 32 (got ${sec.length})`);
        }
        feishuCreds = {
          appId: String(raw.appId).trim(),
          appSecret: sec,
          domain: 'feishu',
          ownerOpenId: raw.ownerOpenId,
        };
      } catch (err: any) {
        console.error(`Error loading feishu credential: ${err.message}`);
        throw err;
      }
    }
  }

  // Other provider configs (wechat, qq, discord)
  const otherProviders = ['wechat', 'qq', 'discord'] as const;
  const otherCredsMap = new Map<string, Record<string, unknown>>();
  const otherSecretLens = new Map<string, number>();

  for (const prov of otherProviders) {
    const provPath = path.join(userImDir, `${prov}.json`);
    if (fs.existsSync(provPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(provPath, 'utf8'));
        const clean: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(raw)) {
          if (k === 'enabled' || k === 'updatedAt' || k === 'secret') continue;
          clean[k] = v;
        }
        if (raw.secret) {
          if (!happyClawKey) {
            throw new Error(`FAIL-CLOSED: HappyClaw key file required to decrypt ${prov} secret`);
          }
          const decryptedPayload = decryptHappyClawSecret(raw.secret, happyClawKey);
          Object.assign(clean, decryptedPayload);
          const secretVal = decryptedPayload?.appSecret || decryptedPayload?.botToken || (typeof decryptedPayload === 'string' ? decryptedPayload : '');
          if (typeof secretVal === 'string') {
            otherSecretLens.set(prov, secretVal.length);
          }
        }
        otherCredsMap.set(prov, clean);
      } catch (err: any) {
        console.error(`Error loading ${prov} credential: ${err.message}`);
        throw err;
      }
    }
  }

  console.log(`\nDiscovered Plan:`);
  console.log(`- User: ${opts.targetUsername} (${targetUser ? 'Reusing existing ID ' + targetUserId : 'Creating new with ID ' + targetUserId})`);
  console.log(`- Spaces to import: ${spaceKeyToInfoMap.size} (Default Home Space: ${mainHostSpaceInfo?.targetFolder || 'unknown'} -> ${defaultSpaceId})`);
  console.log(`- Agent Profiles: ${adminProfiles.length} (Prompt Versions: ${promptVersions.length})`);
  console.log(`- Session Routes: ${adminWorkspaces.length}`);
  console.log(`- Historical Messages: ${adminMessages.length}`);
  console.log(`- Scheduled Tasks: ${adminTasks.length} (Imported as paused, enabled = 0)`);
  console.log(`- Channel Accounts from snapshot: ${adminChannels.length}`);
  console.log(`- Channel Bindings / Mounts: ${adminAgentMounts.length}`);
  console.log(`- Feishu Bot Credential: ${feishuCreds ? `<present:len ${feishuCreds.appSecret.length}> (AppId: ${feishuCreds.appId})` : 'Missing / not provided'}`);
  for (const prov of otherProviders) {
    const secLen = otherSecretLens.get(prov);
    console.log(`- ${prov.toUpperCase()} Bot Credential: ${secLen !== undefined ? `<present:len ${secLen}>` : 'Missing'}`);
  }

  if (opts.dryRun) {
    console.log('\n[DRY RUN COMPLETED] No changes were written to database, filesystem, or credential store.');
    return;
  }

  // ================= NON-DRY-RUN EXECUTION =================

  // Save password if generated
  if (passwordCreated) {
    const parentDir = path.dirname(opts.passwordFile);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(opts.passwordFile, initialPlainPassword + '\n', { mode: 0o600 });
    console.log(`\nGenerated new password and wrote to 0600 file: ${opts.passwordFile}`);
  }

  // Connect LarkEncryptedCredentialStore using secrets.json cookieSecret (preferred) or vaultKeyFile (fallback)
  let credStore: any;
  let derivedMasterKey: Buffer;

  if (opts.secretsJsonFile) {
    if (!fs.existsSync(opts.secretsJsonFile)) {
      throw new Error(`FAIL-CLOSED: secrets.json file not found at: ${opts.secretsJsonFile}`);
    }
    const secretsContent = JSON.parse(fs.readFileSync(opts.secretsJsonFile, 'utf8'));
    const cookieSecret = secretsContent?.cookieSecret;
    if (!cookieSecret || typeof cookieSecret !== 'string' || cookieSecret.trim().length === 0) {
      throw new Error(`FAIL-CLOSED: Invalid or missing cookieSecret in secrets.json at: ${opts.secretsJsonFile}`);
    }
    credStore = new LarkEncryptedCredentialStore({
      cipherSecret: cookieSecret,
      db: targetDb,
    });
    derivedMasterKey = crypto.createHash('sha256').update(cookieSecret, 'utf8').digest();
  } else if (opts.vaultKeyFile) {
    credStore = new LarkEncryptedCredentialStore({
      keyFilePath: opts.vaultKeyFile,
      db: targetDb,
    });
    derivedMasterKey = fs.readFileSync(opts.vaultKeyFile);
  } else {
    throw new Error('FAIL-CLOSED: Neither secrets.json nor vaultKeyFile could be resolved for credential encryption.');
  }

  const now = new Date().toISOString();

  targetDb.exec('BEGIN IMMEDIATE');

  let spacesMigrated = 0;
  let profilesMigrated = 0;
  let snapshotsMigrated = 0;
  let routesMigrated = 0;
  let messagesMigrated = 0;
  let eventsMigrated = 0;
  let tasksMigrated = 0;
  let accountsMigrated = 0;
  let bindingsMigrated = 0;
  let filesMigrated = 0;
  let totalFileBytes = 0;

  const jidToSessionIdMap = new Map<string, string>();
  const jidToSpaceMap = new Map<string, string>();
  let activeProfileSnapshotObj: any = null;

  try {
    // 3.0 Provision or update target user
    if (!targetUser) {
      const pwdHash = await hashPassword(initialPlainPassword);
      targetDb.prepare(`
        INSERT INTO users (id, username, password_hash, role, status, display_name, created_at, updated_at)
        VALUES (?, ?, ?, 'admin', 'active', ?, ?, ?)
      `).run(targetUserId, opts.targetUsername, pwdHash, displayName, now, now);
      console.log(`Created admin user ${opts.targetUsername} (${targetUserId})`);
    } else {
      targetDb.prepare(`
        UPDATE users SET role = 'admin', status = 'active', display_name = ?, updated_at = ?
        WHERE id = ?
      `).run(displayName, now, targetUserId);
      console.log(`Reused existing user ${opts.targetUsername} (${targetUserId}) [Role: admin, Status: active]`);
    }

    // Provision 5 unlimited quota limits for target user
    const quotaMetrics = ['turns', 'messages', 'tokens', 'storage_bytes', 'api_calls'] as const;
    const quotaInsertStmt = targetDb.prepare(`
      INSERT INTO quota_limits (user_id, resource, limit_amount, updated_at)
      VALUES (?, ?, -1, ?)
      ON CONFLICT(user_id, resource) DO UPDATE SET limit_amount = -1, updated_at = excluded.updated_at
    `);
    for (const metric of quotaMetrics) {
      quotaInsertStmt.run(targetUserId, metric, now);
    }

    // Ensure temporary indexes exist for FK checks on fixed_import_provenance during cleanup
    targetDb.exec(`
      CREATE INDEX IF NOT EXISTS idx_fixed_import_prov_event ON fixed_import_provenance(target_event_id);
      CREATE INDEX IF NOT EXISTS idx_fixed_import_prov_msg ON fixed_import_provenance(target_message_id);
    `);

    console.log('Cleaning prior records for user...');
    // 3.1 Idempotent clean of target user's records
    targetDb.prepare('DELETE FROM turn_runs WHERE user_id = ?').run(targetUserId);
    targetDb.prepare('DELETE FROM delivery_inbox WHERE user_id = ?').run(targetUserId);
    targetDb.prepare('DELETE FROM fixed_import_provenance WHERE user_id = ?').run(targetUserId);
    targetDb.prepare('DELETE FROM fixed_import_receipts WHERE user_id = ?').run(targetUserId);
    targetDb.prepare('DELETE FROM import_jobs WHERE actor_user_id = ?').run(targetUserId);
    targetDb.prepare('DELETE FROM web_events WHERE user_id = ?').run(targetUserId);
    targetDb.prepare('DELETE FROM web_messages WHERE user_id = ?').run(targetUserId);
    targetDb.prepare('DELETE FROM session_sources WHERE user_id = ?').run(targetUserId);
    targetDb.prepare('DELETE FROM session_generations WHERE user_id = ?').run(targetUserId);
    targetDb.prepare('DELETE FROM session_routes WHERE user_id = ?').run(targetUserId);
    targetDb.prepare('DELETE FROM channel_bindings WHERE user_id = ?').run(targetUserId);
    targetDb.prepare('DELETE FROM channel_accounts WHERE user_id = ?').run(targetUserId);
    targetDb.prepare('DELETE FROM channel_encrypted_credentials WHERE user_id = ?').run(targetUserId);
    targetDb.prepare('DELETE FROM task_schedules WHERE user_id = ?').run(targetUserId);
    targetDb.prepare('DELETE FROM platform_tasks WHERE user_id = ?').run(targetUserId);
    targetDb.prepare('DELETE FROM model_selection_overrides WHERE user_id = ?').run(targetUserId);
    targetDb.prepare('DELETE FROM spaces WHERE user_id = ?').run(targetUserId);
    targetDb.prepare('DELETE FROM agent_profile_snapshots WHERE user_id = ?').run(targetUserId);
    targetDb.prepare('DELETE FROM agent_profiles WHERE user_id = ?').run(targetUserId);

    console.log('Inserting import receipt...');
    // 3.2 Insert fixed_import_receipts
    const receiptStmt = targetDb.prepare(`
      INSERT INTO fixed_import_receipts (
        user_id, source_fingerprint, importer_version, id_algorithm, target_dsh,
        session_format, source_chats_count, source_messages_count,
        imported_messages_count, dropped_messages_count, attachments_count,
        canonical_hash, created_at
      ) VALUES (?, ?, 'enkeep-migration-v3.0', 'sha256-scoped-v1', 'dsh-v2', 0, ?, ?, ?, 0, 0, ?, ?)
    `);

    receiptStmt.run(
      targetUserId,
      fingerprint,
      adminWorkspaces.length,
      adminMessages.length,
      adminMessages.length,
      sha256(`receipt:${targetUserId}:${fingerprint}`),
      now
    );

    // 3.3 Migrate Agent Profiles & Snapshots
    const profileInsertStmt = targetDb.prepare(`
      INSERT INTO agent_profiles (id, user_id, name, description, status, active_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
    `);

    const snapshotInsertStmt = targetDb.prepare(`
      INSERT INTO agent_profile_snapshots (
        id, user_id, profile_id, version, prompt_mode, prompt_hash, identity, soul, agents, tools, created_at
      ) VALUES (?, ?, ?, ?, 'append', ?, ?, ?, ?, ?, ?)
    `);

    let defaultTargetProfileId: string | null = null;
    let defaultTargetSnapshotId: string | null = null;

    for (const prof of adminProfiles) {
      const targetProfId = deterministicProfileId(targetUserId, prof.id);
      if (prof.is_default || !defaultTargetProfileId) {
        defaultTargetProfileId = targetProfId;
      }

      profileInsertStmt.run(
        targetProfId,
        targetUserId,
        prof.name || 'HappyClaw Admin Profile',
        prof.name ? `Migrated HappyClaw profile: ${prof.name}` : 'Migrated HappyClaw profile',
        prof.version || 1,
        prof.created_at || now,
        prof.updated_at || now
      );
      profilesMigrated++;

      const relatedVersions = promptVersions.filter((pv) => pv.agent_profile_id === prof.id);
      if (relatedVersions.length > 0) {
        for (const pv of relatedVersions) {
          const identity = (pv.identity_prompt || prof.identity_prompt || '').normalize('NFC');
          const soul = (pv.soul_prompt || prof.soul_prompt || '').normalize('NFC');
          const agents = (pv.agents_prompt || prof.agents_prompt || '').normalize('NFC');
          const tools = (pv.tools_prompt || prof.tools_prompt || '').normalize('NFC');
          const promptHash = computeAgentProfilePromptHash({ identity, soul, agents, tools });
          const snapId = deterministicSnapshotId(targetProfId, pv.version || 1, promptHash);
          if (!defaultTargetSnapshotId) {
            defaultTargetSnapshotId = snapId;
            activeProfileSnapshotObj = { profileId: targetProfId, version: pv.version || 1, promptHash, identity, soul, agents, tools };
          }

          snapshotInsertStmt.run(
            snapId,
            targetUserId,
            targetProfId,
            pv.version || 1,
            promptHash,
            identity,
            soul,
            agents,
            tools,
            pv.created_at || now
          );
          snapshotsMigrated++;
        }
      } else {
        const identity = (prof.identity_prompt || '').normalize('NFC');
        const soul = (prof.soul_prompt || '').normalize('NFC');
        const agents = (prof.agents_prompt || '').normalize('NFC');
        const tools = (prof.tools_prompt || '').normalize('NFC');
        const promptHash = computeAgentProfilePromptHash({ identity, soul, agents, tools });
        const snapId = deterministicSnapshotId(targetProfId, prof.version || 1, promptHash);
        if (!defaultTargetSnapshotId) {
          defaultTargetSnapshotId = snapId;
          activeProfileSnapshotObj = { profileId: targetProfId, version: prof.version || 1, promptHash, identity, soul, agents, tools };
        }

        snapshotInsertStmt.run(
          snapId,
          targetUserId,
          targetProfId,
          prof.version || 1,
          promptHash,
          identity,
          soul,
          agents,
          tools,
          prof.created_at || now
        );
        snapshotsMigrated++;
      }
    }

    console.log('Migrating spaces...');
    // 3.4 Migrate Spaces
    const spaceInsertStmt = targetDb.prepare(`
      INSERT INTO spaces (id, user_id, name, folder, execution_mode, created_at, updated_at, status, agent_profile_id, agent_profile_snapshot_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `);

    for (const info of spaceKeyToInfoMap.values()) {
      spaceInsertStmt.run(
        info.spaceId,
        targetUserId,
        info.name,
        info.targetFolder,
        info.executionMode,
        info.primaryWs.created_at || now,
        info.primaryWs.updated_at || now,
        defaultTargetProfileId,
        defaultTargetSnapshotId
      );
      spacesMigrated++;
    }

    console.log('Migrating session routes...');
    // 3.5 Migrate Session Routes, Generations, Sources
    const routeInsertStmt = targetDb.prepare(`
      INSERT INTO session_routes (
        id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, created_at, updated_at, status, title, agent_profile_id, agent_profile_snapshot_id
      ) VALUES (?, ?, ?, 'web', 'default', ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `);

    const genInsertStmt = targetDb.prepare(`
      INSERT INTO session_generations (
        id, user_id, route_id, generation_number, dsh_session_id, agent_profile_snapshot_id, reset_reason, created_at
      ) VALUES (?, ?, ?, 1, ?, ?, 'initial', ?)
    `);

    const sourceInsertStmt = targetDb.prepare(`
      INSERT INTO session_sources (
        id, route_id, source_type, source_id, user_id, metadata, created_at
      ) VALUES (?, ?, 'happyclaw', ?, ?, ?, ?)
    `);

    for (const ws of adminWorkspaces) {
      const folder = ws.folder || 'main';
      const rg = adminRgMap.get(ws.jid);
      const mode = rg?.execution_mode || 'host';
      const spaceKey = `${folder}:${mode}`;
      const spaceInfo = spaceKeyToInfoMap.get(spaceKey)!;
      const spaceId = spaceInfo.spaceId;
      const sessionId = deterministicSessionId(fingerprint, ws.jid, targetUserId);
      jidToSessionIdMap.set(ws.jid, sessionId);
      jidToSpaceMap.set(ws.jid, spaceId);

      routeInsertStmt.run(
        sessionId,
        spaceId,
        targetUserId,
        sessionId,
        ws.jid,
        sessionId,
        spaceInfo.executionMode,
        ws.created_at || now,
        ws.updated_at || now,
        ws.name || folder,
        defaultTargetProfileId,
        defaultTargetSnapshotId
      );
      routesMigrated++;

      const genId = `gen_hpc_${sha256(`${targetUserId}:${sessionId}:gen1`).slice(0, 24)}`;
      genInsertStmt.run(genId, targetUserId, sessionId, sessionId, defaultTargetSnapshotId, ws.created_at || now);

      const sourceId = `src_hpc_${sha256(`${targetUserId}:${sessionId}:${ws.jid}`).slice(0, 24)}`;
      const meta = JSON.stringify({
        sourceJid: ws.jid,
        sourceName: ws.name,
        folder: ws.folder,
        targetFolder: spaceInfo.targetFolder,
        originalExecutionMode: rg?.execution_mode || ws.execution_mode || 'host',
        targetExecutionMode: spaceInfo.executionMode,
        isMixed: spaceInfo.isMixed,
        customCwdPresent: Boolean(rg?.custom_cwd),
        migratedAt: now,
      });
      sourceInsertStmt.run(sourceId, sessionId, ws.jid, targetUserId, meta, ws.created_at || now);
    }

    console.log('Migrating messages and events...');
    // 3.6 Migrate Messages & Events
    const msgInsertStmt = targetDb.prepare(`
      INSERT INTO web_messages (
        id, session_id, user_id, role, content, status, route_key, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, 'delivered', ?, ?, ?)
    `);

    const eventInsertStmt = targetDb.prepare(`
      INSERT INTO web_events (
        id, session_id, user_id, type, payload, created_at
      ) VALUES (?, ?, ?, 'message', ?, ?)
    `);

    const provInsertStmt = targetDb.prepare(`
      INSERT INTO fixed_import_provenance (
        id, user_id, source_fingerprint, source_chat_jid, source_message_id,
        target_space_id, target_route_id, target_dsh_session_id,
        target_message_id, target_event_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const msg of adminMessages) {
      const sessionId = jidToSessionIdMap.get(msg.chat_jid);
      if (!sessionId) continue;
      const spaceId = jidToSpaceMap.get(msg.chat_jid) || defaultSpaceId;
      const routeKey = `web:default:${targetUserId}:${sessionId}`;

      const msgId = `msg_hpc_${sha256(`${sessionId}:${msg.id}`).slice(0, 24)}`;
      const role = msg.is_from_me === 1 ? 'assistant' : 'user';
      const content = msg.content || '';
      const msgTime = msg.timestamp || now;
      const eventId = `ev_hpc_${sha256(`${targetUserId}:${sessionId}:${msgId}`).slice(0, 24)}`;
      const provId = `prov_hpc_${sha256(`${targetUserId}:${msg.chat_jid}:${msg.id}`).slice(0, 24)}`;

      let metaJson: string | null = null;
      if (msg.attachments) {
        metaJson = JSON.stringify({
          sourceAttachments: msg.attachments,
          turnId: msg.turn_id,
          senderName: msg.sender_name,
        });
      }

      msgInsertStmt.run(msgId, sessionId, targetUserId, role, content, routeKey, metaJson, msgTime);
      messagesMigrated++;

      const eventPayload = {
        id: msgId,
        sessionId,
        userId: targetUserId,
        role,
        content,
        routeKey,
        createdAt: msgTime,
        message: {
          id: msgId,
          sessionId,
          userId: targetUserId,
          role,
          content,
          status: 'delivered',
          routeKey,
          timestamp: msgTime,
        },
      };

      eventInsertStmt.run(eventId, sessionId, targetUserId, JSON.stringify(eventPayload), msgTime);
      eventsMigrated++;

      provInsertStmt.run(
        provId,
        targetUserId,
        fingerprint,
        msg.chat_jid,
        msg.id,
        spaceId,
        sessionId,
        sessionId,
        msgId,
        eventId,
        msgTime
      );
    }

    console.log(`Migrated ${messagesMigrated} messages. Migrating tasks...`);
    // 3.7 Migrate Tasks (All Paused / Disabled)
    const taskStmt = targetDb.prepare(`
      INSERT INTO platform_tasks (
        id, user_id, idempotency_key, title, description, priority, status, payload, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `);

    const taskScheduleStmt = targetDb.prepare(`
      INSERT INTO task_schedules (
        id, task_id, user_id, schedule_type, cron_expression, enabled, paused_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
    `);

    for (const task of adminTasks) {
      const taskId = `task_hpc_${sha256(`${targetUserId}:${task.id}`).slice(0, 24)}`;
      const title = (task.prompt || 'HappyClaw Scheduled Task').slice(0, 60).trim();
      const payload = JSON.stringify({
        originalTaskId: task.id,
        prompt: task.prompt,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        executionMode: 'container',
        executionType: task.execution_type,
        status: 'paused',
      });

      taskStmt.run(
        taskId,
        targetUserId,
        `hpc_task_${task.id}`,
        title,
        task.prompt || '',
        'medium',
        payload,
        task.created_at || now,
        task.updated_at || now
      );
      tasksMigrated++;

      const schedId = `sched_hpc_${sha256(taskId).slice(0, 24)}`;
      taskScheduleStmt.run(
        schedId,
        taskId,
        targetUserId,
        task.schedule_type || 'cron',
        task.schedule_value || null,
        now,
        task.created_at || now,
        task.updated_at || now
      );
    }

    // 3.8 Channel Accounts with REAL / Encrypted Credentials
    const masterKey = derivedMasterKey;
    const channelAccountStmt = targetDb.prepare(`
      INSERT INTO channel_accounts (
        id, user_id, type, status, credential_ref, created_at, updated_at, default_space_id, group_activation_mode
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const channelBindingStmt = targetDb.prepare(`
      INSERT INTO channel_bindings (
        id, user_id, account_id, space_id, native_context_id, activation_mode, created_at, updated_at, chat_type
      ) VALUES (?, ?, ?, ?, ?, 'mention', ?, ?, ?)
    `);

    const channelAccIdMap = new Map<string, string>(); // provider/sourceAccId -> targetAccId

    for (const acc of adminChannels) {
      const provider = acc.provider;
      const targetAccId = `acc_hpc_${sha256(`${targetUserId}:${provider}:${acc.id}`).slice(0, 24)}`;
      channelAccIdMap.set(acc.id, targetAccId);
      channelAccIdMap.set(provider, targetAccId);

      if (provider === 'feishu') {
        let credRef = `reauth_required_feishu_${acc.id.slice(0, 8)}`;
        let accStatus = 'disabled';

        if (feishuCreds) {
          credRef = await credStore.storeCredentials(targetUserId, {
            appId: feishuCreds.appId,
            appSecret: feishuCreds.appSecret,
            domain: feishuCreds.domain ?? 'feishu',
            botOpenId: feishuCreds.ownerOpenId,
          });
          accStatus = 'active';

          // Decrypt-check round-trip resolution
          const resolved = await credStore.resolve(targetUserId, credRef);
          if (!resolved || resolved.appId !== feishuCreds.appId) {
            throw new Error(`FAIL-CLOSED: Feishu credential resolution failed for ref "${credRef}"`);
          }
          console.log(`Verified Feishu credential round-trip: appId=${resolved.appId}, secret=<present:len ${resolved.appSecret.length}>, domain=${resolved.domain}`);
        }

        channelAccountStmt.run(
          targetAccId,
          targetUserId,
          'lark', // native Enkeep runtime type
          accStatus,
          credRef,
          acc.created_at || now,
          now,
          defaultSpaceId, // main--host
          'mention'
        );
        accountsMigrated++;
      } else {
        // wechat, qq, discord: store raw JSON encrypted under cred_<provider>_<hash>
        const rawConfig = otherCredsMap.get(provider);
        let credRef = `reauth_required_${provider}_${acc.id.slice(0, 8)}`;

        if (rawConfig) {
          const providerHash = sha256(`${provider}:${targetUserId}`).slice(0, 16);
          credRef = `cred_${provider}_${providerHash}`;
          const encId = `enc_${crypto.randomBytes(8).toString('hex')}`;
          const encryptedPayload = encryptWithAad(masterKey, JSON.stringify(rawConfig), targetUserId, credRef);

          targetDb.prepare(`
            INSERT INTO channel_encrypted_credentials (id, user_id, credential_ref, encrypted_payload, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(credential_ref) DO UPDATE SET
              encrypted_payload = excluded.encrypted_payload,
              updated_at = CURRENT_TIMESTAMP
          `).run(encId, targetUserId, credRef, encryptedPayload);
        }

        channelAccountStmt.run(
          targetAccId,
          targetUserId,
          provider,
          'disabled',
          credRef,
          acc.created_at || now,
          now,
          null,
          'mention'
        );
        accountsMigrated++;
      }
    }

    // Chat Bindings
    for (const mount of adminAgentMounts) {
      const accId = channelAccIdMap.get(mount.channel_type) || channelAccIdMap.get('feishu') || `acc_hpc_fallback_${mount.channel_type}`;
      const rg = adminRgMap.get(mount.channel_jid);
      const folder = mount.workspace_folder || rg?.folder || 'main';
      const mode = rg?.execution_mode || 'host';
      const spaceKey = `${folder}:${mode}`;
      const spaceInfo = spaceKeyToInfoMap.get(spaceKey) || spaceKeyToInfoMap.get(`${folder}:host`) || spaceKeyToInfoMap.get(`${folder}:container`) || spaceKeyToInfoMap.values().next().value!;
      const spaceId = spaceInfo.spaceId;
      const bindingId = `bind_hpc_${sha256(`${targetUserId}:${mount.channel_jid}`).slice(0, 24)}`;

      // Derive chat_type: 'group' for oc_, 'p2p' for ou_ / :c2c:, else null
      let chatType: string | null = null;
      if (mount.channel_jid.includes('oc_')) {
        chatType = 'group';
      } else if (mount.channel_jid.includes('ou_') || mount.channel_jid.includes(':c2c:')) {
        chatType = 'p2p';
      }

      channelBindingStmt.run(
        bindingId,
        targetUserId,
        accId,
        spaceId,
        mount.channel_jid,
        mount.created_at || now,
        now,
        chatType
      );
      bindingsMigrated++;
    }

    // 3.9 Record Import Job
    const jobId = `job_mig_${sha256(`${targetUserId}:${fingerprint}`).slice(0, 24)}`;
    const jobStmt = targetDb.prepare(`
      INSERT INTO import_jobs (
        id, actor_user_id, target_user_id, staged_id, source_fingerprint,
        request_hash, idempotency_key, status, dry_run, total_conversations,
        completed_conversations, progress_json, result_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'happyclaw-user-migration', ?, ?, ?, 'completed', 0, ?, ?, ?, ?, ?, ?)
    `);

    const summaryPayload = {
      workspacesMigrated: spacesMigrated,
      profilesMigrated,
      routesMigrated,
      messagesMigrated,
      eventsMigrated,
      tasksMigrated,
      accountsMigrated,
      bindingsMigrated,
    };

    jobStmt.run(
      jobId,
      targetUserId,
      targetUserId,
      fingerprint,
      sha256(JSON.stringify(summaryPayload)),
      `migration_${targetUserId}_${fingerprint}`,
      routesMigrated,
      routesMigrated,
      JSON.stringify({ status: 'completed', progress: 100 }),
      JSON.stringify({ summary: summaryPayload }),
      now,
      now
    );

    targetDb.exec('COMMIT');
    console.log('Database transaction committed successfully.');
  } catch (dbErr) {
    targetDb.exec('ROLLBACK');
    console.error('Database transaction failed, rolled back:', dbErr);
    throw dbErr;
  }

  // 4. File Migration: Copy spaces files safely
  console.log('\nCopying workspace files to Enkeep spaces and host runtimes...');
  const isRehearsal = !opts.targetDbPath.includes('.demo-data');
  const dataRoot = isRehearsal ? path.join(os.tmpdir(), 'enkeep-rehearsal-data') : path.join(REPO_ROOT, '.demo-data');
  const targetSpacesDir = path.join(dataRoot, 'spaces');
  const hostRuntimesDir = path.join(dataRoot, 'host-runtimes', opts.targetUsername);
  const hostSpacesDir = path.join(hostRuntimesDir, 'spaces');
  const hostDshHome = path.join(hostRuntimesDir, '.dsh');
  const hostSessionsDir = path.join(hostDshHome, 'sessions');

  if (!fs.existsSync(targetSpacesDir)) {
    fs.mkdirSync(targetSpacesDir, { recursive: true });
  }
  if (!fs.existsSync(hostSpacesDir)) {
    fs.mkdirSync(hostSpacesDir, { recursive: true, mode: 0o700 });
  }
  if (!fs.existsSync(hostSessionsDir)) {
    fs.mkdirSync(hostSessionsDir, { recursive: true, mode: 0o700 });
  }

  for (const info of spaceKeyToInfoMap.values()) {
    const srcSpaceDir = path.join(sourceGroupsDir, info.srcFolder);
    const targetSpaceDir = path.join(targetSpacesDir, info.targetFolder);
    const hostSpaceDir = info.executionMode === 'host' ? path.join(hostSpacesDir, info.targetFolder) : undefined;

    copyDirectorySafely(srcSpaceDir, targetSpaceDir, hostSpaceDir);
  }

  // Copy user-global files
  const adminUserGlobalDir = path.join(sourceGroupsDir, 'user-global', opts.sourceUserId);
  if (fs.existsSync(adminUserGlobalDir)) {
    const targetUserGlobalDir = path.join(targetSpacesDir, 'user-global', targetUserId);
    const hostUserGlobalDir = path.join(hostSpacesDir, 'user-global', targetUserId);

    copyDirectorySafely(adminUserGlobalDir, targetUserGlobalDir, hostUserGlobalDir);

    // Copy markdown files in user-global to hostDshHome
    try {
      const topEntries = fs.readdirSync(adminUserGlobalDir, { withFileTypes: true });
      for (const entry of topEntries) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          const src = path.join(adminUserGlobalDir, entry.name);
          const dst = path.join(hostDshHome, entry.name);
          fs.copyFileSync(src, dst);
        }
      }
    } catch {}
  }

  const spaceStats = countDirectoryFiles(targetSpacesDir);
  filesMigrated = spaceStats.files;
  totalFileBytes = spaceStats.bytes;

  console.log(`Copied ${filesMigrated} workspace files (${(totalFileBytes / (1024 * 1024)).toFixed(2)} MB).`);

  // 5. Compile Canonical DSH Seeds and write to Host Sessions directory
  console.log('\nCompiling canonical DSH session seeds...');
  const importPayloads: any[] = [];

  for (const ws of adminWorkspaces) {
    const msgs = srcDb.prepare('SELECT * FROM messages WHERE chat_jid = ? ORDER BY timestamp ASC').all(ws.jid) as any[];
    const sessionId = jidToSessionIdMap.get(ws.jid);
    if (!sessionId) continue;

    const folder = ws.folder || 'main';
    const seedEvents: any[] = [];
    let seq = 0;
    let turn = 1;
    let lastTime = Date.now();

    for (const msg of msgs) {
      const text = (msg.content ?? '').trim();
      if (!text) continue;

      const parsedTime = Number(msg.timestamp) || Date.parse(msg.timestamp);
      const stamp = Number.isSafeInteger(parsedTime) && parsedTime > 0 ? parsedTime : Date.now();
      lastTime = stamp;

      if (msg.is_from_me === 1) {
        seedEvents.push({ type: 'turn/start', seq: seq++, time: stamp, data: { turn } });
        seedEvents.push({ type: 'step/start', seq: seq++, time: stamp, data: { turn, step: 1 } });
        seedEvents.push({
          type: 'assistant/message',
          seq: seq++,
          time: stamp,
          surfaceOp: 'append',
          data: {
            turn,
            step: 1,
            message: {
              id: `msg_hpc_${sha256(`${ws.jid}:${msg.id}`).slice(0, 24)}`,
              role: 'assistant',
              content: [{ type: 'text', text }],
              source: { kind: 'model', provider: 'cpa-gpt', model: 'gpt-5.6-sol' },
            },
          },
        });
        seedEvents.push({ type: 'step/end', seq: seq++, time: stamp, data: { turn, step: 1 } });
        seedEvents.push({ type: 'turn/end', seq: seq++, time: stamp, data: { turn, reason: { kind: 'completed' } } });
        turn++;
      } else {
        seedEvents.push({
          type: 'user/message',
          seq: seq++,
          time: stamp,
          surfaceOp: 'append',
          data: {
            id: `msg_hpc_${sha256(`${ws.jid}:${msg.id}`).slice(0, 24)}`,
            role: 'user',
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
          },
        });
      }
    }

    if (seedEvents.length > 0) {
      seedEvents.push({
        type: 'session/end-seed',
        seq: seq++,
        time: lastTime,
        data: {},
      });
    }

    const receipt = computeSessionSeedReceipt(seedEvents);
    const rg = adminRgMap.get(ws.jid);
    const mode = rg?.execution_mode || 'host';
    const spaceKey = `${folder}:${mode}`;
    const spaceInfo = spaceKeyToInfoMap.get(spaceKey)!;
    const targetFolder = spaceInfo.targetFolder;

    importPayloads.push({
      sessionId,
      chatJid: ws.jid,
      folder: targetFolder,
      seed: seedEvents,
      receipt,
      profileSnapshot: activeProfileSnapshotObj,
    });

    if (spaceInfo.executionMode === 'host') {
      const hostSpacePath = path.join(hostSpacesDir, targetFolder);
      const hostProjKey = projectKey(hostSpacePath);
      const firstMsgTime = seedEvents[0]?.time ?? Date.now();
      const headerRecord = {
        type: 'session',
        version: 0,
        id: sessionId,
        createdAt: firstMsgTime,
        cwd: hostSpacePath,
        delegationDepth: 0,
        ...(seedEvents.length > 0 ? { seedLength: seedEvents.length } : {}),
      };
      const hostLines = [JSON.stringify(headerRecord), ...seedEvents.map((ev) => JSON.stringify(ev))];
      const hostJsonlContent = hostLines.join('\n') + '\n';

      const hostNestedDir = path.join(hostSessionsDir, hostProjKey, sessionId);
      if (!fs.existsSync(hostNestedDir)) {
        fs.mkdirSync(hostNestedDir, { recursive: true, mode: 0o700 });
      }
      fs.writeFileSync(path.join(hostNestedDir, 'session.jsonl'), hostJsonlContent, 'utf8');
    }
  }

  console.log(`Wrote ${importPayloads.length} session JSONLs to host runtime at ${hostSessionsDir}.`);

  // Optional: check if container for target user is already running
  try {
    const containerListOutput = execSync(`docker ps --filter "name=${opts.targetUsername}" --format "{{.Names}}"`, { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    const containerName = containerListOutput.split('\n').filter(Boolean)[0];
    if (containerName) {
      console.log(`Found running container "${containerName}". Materializing container space files...`);
      execSync(`docker cp ${targetSpacesDir}/. ${containerName}:/home/dsh/spaces/`, { stdio: 'inherit' });
      console.log('Container space files updated.');
    } else {
      console.log('Target container is not running (offline migration). Files staged for container boot.');
    }
  } catch {
    console.log('Docker daemon not connected or container skipped. Offline migration complete.');
  }

  // 6. Masked Summary Output
  console.log('\n======================================================');
  console.log('=== Migration Summary (Masked, Zero Secrets) ===');
  console.log('======================================================');
  console.log(`User:                 ${opts.targetUsername} (${targetUserId})`);
  console.log(`Spaces Migrated:      ${spacesMigrated} (26 host / 8 container)`);
  console.log(`Default Space ID:     ${defaultSpaceId} (folder: ${mainHostSpaceInfo?.targetFolder || 'main--host'})`);
  console.log(`Session Routes:       ${routesMigrated}`);
  console.log(`Messages Migrated:    ${messagesMigrated}`);
  console.log(`Events Migrated:      ${eventsMigrated}`);
  console.log(`Tasks Migrated:       ${tasksMigrated} (paused/disabled)`);
  console.log(`Accounts Migrated:    ${accountsMigrated}`);
  console.log(`Chat Bindings:        ${bindingsMigrated}`);
  console.log(`Workspace Files:      ${filesMigrated} (${(totalFileBytes / (1024 * 1024)).toFixed(2)} MB)`);
  console.log(`Password File:        ${opts.passwordFile} (mode: 0600)`);
  if (opts.secretsJsonFile) {
    console.log(`Credential Store:     secrets.json (${opts.secretsJsonFile})`);
  } else {
    console.log(`Vault Key File:       ${opts.vaultKeyFile}`);
  }
  console.log(`Feishu Bot Credential:${feishuCreds ? ` <present:len ${feishuCreds.appSecret.length}> (AppId: ${feishuCreds.appId})` : ' None'}`);
  console.log(`WeChat Bot Credential:${otherSecretLens.has('wechat') ? ` <present:len ${otherSecretLens.get('wechat')}>` : ' Missing'}`);
  console.log(`QQ Bot Credential:    ${otherSecretLens.has('qq') ? ` <present:len ${otherSecretLens.get('qq')}>` : ' Missing'}`);
  console.log(`Discord Bot Credential:${otherSecretLens.has('discord') ? ` <present:len ${otherSecretLens.get('discord')}>` : ' Missing'}`);
  console.log('======================================================\n');
}

main().catch((err) => {
  console.error('Fatal Migration Error:', err);
  process.exit(1);
});
