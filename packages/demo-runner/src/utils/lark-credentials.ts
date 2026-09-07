/**
 * Safe Lark Test Credentials Loader, Scoped Resolver, and Provisioner
 *
 * Implements strict opt-in loading of Feishu/Lark test credentials from an isolated 0600 file,
 * fail-closed validation, non-leaking credential resolution bound strictly to Alice and fixed credentialRef,
 * and idempotent test space & channel account provisioning.
 *
 * @module @enkeep/demo-runner/utils/lark-credentials
 */

import { existsSync, lstatSync, readFileSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import type {
  PlatformStorage,
  Space,
  ChannelAccount,
  ChannelBinding,
} from '@enkeep/platform-core';
import type {
  LarkCredentialResolver,
  LarkResolvedCredentials,
} from '@enkeep/channel-lark';

export function getLarkTestCredentialRef(appId: string): string {
  return `lark-test-${appId}`;
}

export function getLarkTestAccountId(appId: string): string {
  return `acc_lark_test_${appId}`;
}

export const LARK_TEST_SPACE_FOLDER = 'lark-live-test' as const;
export const LARK_TEST_SPACE_NAME = '飞书真实渠道测试' as const;

export interface LarkTestCredentials {
  readonly appId: string;
  readonly appSecret: string;
  readonly domain: 'feishu' | 'lark';
  readonly botOpenId?: string;
}

export interface LarkTestEnvironment {
  readonly space: Space;
  readonly account: ChannelAccount;
}

/**
 * Extracts Lark test credentials file path from CLI arguments or environment variable.
 * Priority: CLI `--lark-test-credentials <file>` > env `ENKEEP_LARK_TEST_CREDENTIALS_FILE` > undefined.
 */
export function parseLarkTestCredentialsPath(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  let rawPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--lark-test-credentials') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new Error('Safety Violation: --lark-test-credentials requires a file path.');
      }
      rawPath = next;
      break;
    } else if (arg.startsWith('--lark-test-credentials=')) {
      const val = arg.slice('--lark-test-credentials='.length);
      if (!val) {
        throw new Error('Safety Violation: --lark-test-credentials requires a file path.');
      }
      rawPath = val;
      break;
    }
  }

  if (rawPath === undefined && env.ENKEEP_LARK_TEST_CREDENTIALS_FILE !== undefined && env.ENKEEP_LARK_TEST_CREDENTIALS_FILE !== '') {
    rawPath = env.ENKEEP_LARK_TEST_CREDENTIALS_FILE;
  }

  if (!rawPath) {
    return undefined;
  }

  return rawPath.trim();
}

/**
 * Loads, validates and parses Lark test credentials from an explicit 0600 file owned by current user.
 * Strictly prevents symlinks, permission leaks, and secrets in error messages.
 */
export function loadLarkTestCredentials(filePath: string): LarkTestCredentials {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Safety Violation: Lark test credentials file path must be a non-empty string.');
  }

  if (!isAbsolute(filePath)) {
    throw new Error(`Safety Violation: Lark test credentials path must be an absolute path. Received "${filePath}".`);
  }

  const normalized = normalize(resolve(filePath));

  if (!existsSync(normalized)) {
    throw new Error(`Safety Violation: Lark test credentials file does not exist at "${normalized}".`);
  }

  const stat = lstatSync(normalized);
  if (stat.isSymbolicLink()) {
    throw new Error(`Safety Violation: Lark test credentials file "${normalized}" must not be a symbolic link.`);
  }

  if (!stat.isFile()) {
    throw new Error(`Safety Violation: Lark test credentials path "${normalized}" must be a regular file.`);
  }

  // Strict 0600 file permissions check
  const fileMode = stat.mode & 0o777;
  if (fileMode !== 0o600) {
    throw new Error(
      `Safety Violation: Lark test credentials file "${normalized}" must have strict 0600 permissions (chmod 600), found 0${fileMode.toString(8)}.`
    );
  }

  // POSIX UID check
  if (typeof process.getuid === 'function') {
    const currentUid = process.getuid();
    if (stat.uid !== currentUid) {
      throw new Error(
        `Safety Violation: Lark test credentials file "${normalized}" is owned by UID ${stat.uid}, but current process is running as UID ${currentUid}.`
      );
    }
  }

  let rawContent: string;
  try {
    rawContent = readFileSync(normalized, 'utf-8');
  } catch (_readErr: unknown) {
    throw new Error(`Safety Violation: Failed to read Lark test credentials file "${normalized}".`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch (_jsonErr: unknown) {
    throw new Error(`Safety Violation: Lark test credentials file "${normalized}" does not contain valid JSON.`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Safety Violation: Lark test credentials file must contain a top-level JSON object.');
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.appId !== 'string' || !obj.appId.trim()) {
    throw new Error('Safety Violation: Lark test credentials JSON missing non-empty "appId" string.');
  }

  if (typeof obj.appSecret !== 'string' || !obj.appSecret.trim()) {
    throw new Error('Safety Violation: Lark test credentials JSON missing non-empty "appSecret" string.');
  }

  let domain: 'feishu' | 'lark' = 'feishu';
  if (obj.domain !== undefined) {
    if (obj.domain !== 'feishu' && obj.domain !== 'lark') {
      throw new Error('Safety Violation: Lark test credentials "domain" must be either "feishu" or "lark".');
    }
    domain = obj.domain;
  }

  let botOpenId: string | undefined;
  if (typeof obj.botOpenId === 'string' && obj.botOpenId.trim()) {
    botOpenId = obj.botOpenId.trim();
  }

  return {
    appId: obj.appId.trim(),
    appSecret: obj.appSecret.trim(),
    domain,
    botOpenId,
  };
}

/**
 * Creates a scoped LarkCredentialResolver that resolves ONLY for Alice and the credentialRef
 * derived from the loaded credentials appId (lark-test-${appId}).
 * All unknown users or old credentials (e.g. cred_alice_lark) return null without connecting.
 */
export function createLarkTestCredentialResolver(
  credentials: LarkTestCredentials,
  aliceUserId: string
): LarkCredentialResolver {
  const expectedCredentialRef = getLarkTestCredentialRef(credentials.appId);
  return {
    async resolve(userId: string, credentialRef: string): Promise<LarkResolvedCredentials | null> {
      if (userId === aliceUserId && credentialRef === expectedCredentialRef) {
        return {
          appId: credentials.appId,
          appSecret: credentials.appSecret,
          domain: credentials.domain,
          botOpenId: credentials.botOpenId,
        };
      }
      return null;
    },
  };
}

/**
 * Ensures the dedicated test Space '飞书真实渠道测试' (folder lark-live-test) and
 * Channel Account exist for Alice in an idempotent, non-destructive manner.
 * The credentialRef and accountId are derived from the given appId (or fallback to an existing lark-test account).
 */
export async function ensureLarkTestResources(
  storage: PlatformStorage,
  aliceUserId: string,
  spacesDir: string,
  appId?: string
): Promise<LarkTestEnvironment> {
  const tenant = storage.forTenant(aliceUserId);

  // 1. Ensure dedicated test Space
  let space = await tenant.spaces.findByFolder(LARK_TEST_SPACE_FOLDER);
  if (!space) {
    space = await tenant.spaces.create({
      name: LARK_TEST_SPACE_NAME,
      folder: LARK_TEST_SPACE_FOLDER,
      executionMode: 'container',
      status: 'active',
    });
  } else if (space.status !== 'active') {
    space = await tenant.spaces.update(space.id, { status: 'active' });
  }

  // Ensure workspace directory on disk
  const spaceDirPath = join(spacesDir, LARK_TEST_SPACE_FOLDER);
  if (!existsSync(spaceDirPath)) {
    mkdirSync(spaceDirPath, { recursive: true, mode: 0o700 });
  }

  // 2. Ensure dedicated test Channel Account
  const accounts = await tenant.channels.listAccounts('lark');
  let expectedCredentialRef: string | undefined;
  let expectedAccountId: string | undefined;

  if (appId) {
    expectedCredentialRef = getLarkTestCredentialRef(appId);
    expectedAccountId = getLarkTestAccountId(appId);
  } else {
    // If not provided, check if an existing lark-test-* account exists
    const existingLarkTestAccount = accounts.find((a) => a.credentialRef?.startsWith('lark-test-'));
    if (existingLarkTestAccount) {
      expectedCredentialRef = existingLarkTestAccount.credentialRef ?? undefined;
      expectedAccountId = existingLarkTestAccount.id;
    } else {
      expectedCredentialRef = getLarkTestCredentialRef('cli_0123456789abcdef');
      expectedAccountId = getLarkTestAccountId('cli_0123456789abcdef');
    }
  }

  let account = accounts.find((a) => a.credentialRef === expectedCredentialRef);

  if (!account) {
    account = await tenant.channels.createAccount({
      id: expectedAccountId,
      type: 'lark',
      status: 'active',
      credentialRef: expectedCredentialRef,
      defaultSpaceId: space.id,
    });
  } else if (account.status !== 'active') {
    account = await tenant.channels.updateAccount(account.id, { status: 'active' });
  }

  return {
    space,
    account,
  };
}

/**
 * Binds a specific Lark chatId / contextId to Alice's dedicated test space.
 */
export async function bindLarkChatContext(
  storage: PlatformStorage,
  aliceUserId: string,
  nativeContextId: string,
  options: {
    activationMode?: 'mention' | 'always';
    accountId?: string;
    spaceId?: string;
  } = {}
): Promise<ChannelBinding> {
  const tenant = storage.forTenant(aliceUserId);
  let accountId = options.accountId;

  if (!accountId) {
    const accounts = await tenant.channels.listAccounts('lark');
    const existingLarkTestAccount = accounts.find((a) => a.credentialRef?.startsWith('lark-test-'));
    if (existingLarkTestAccount) {
      accountId = existingLarkTestAccount.id;
    } else {
      accountId = getLarkTestAccountId('cli_0123456789abcdef');
    }
  }

  let spaceId = options.spaceId;

  if (!spaceId) {
    const space = await tenant.spaces.findByFolder(LARK_TEST_SPACE_FOLDER);
    if (!space) {
      throw new Error(`Dedicated test space "${LARK_TEST_SPACE_FOLDER}" not found. Run provision first.`);
    }
    spaceId = space.id;
  }

  const existing = await tenant.channels.findBindingByContext(accountId, nativeContextId);
  if (existing) {
    if (existing.spaceId !== spaceId || (options.activationMode && existing.activationMode !== options.activationMode)) {
      return await tenant.channels.updateBinding(existing.id, {
        spaceId,
        activationMode: options.activationMode ?? existing.activationMode,
      });
    }
    return existing;
  }

  return await tenant.channels.createBinding({
    accountId,
    spaceId,
    nativeContextId,
    activationMode: options.activationMode ?? 'always',
  });
}
