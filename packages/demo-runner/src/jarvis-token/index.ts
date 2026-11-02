/**
 * `demo-runner jarvis-token issue|revoke` — issue or revoke a user's Jarvis token without the Web UI,
 * for operators on the machine that holds the platform data directory (docs/jarvis-channel.md §9).
 *
 * - Every value comes from a flag (`--data-dir`, `--user`, `--token-file`); nothing defaults to a
 *   machine path or an environment variable.
 * - `issue` creates the user's Jarvis channel account when there is none (an existing, active
 *   administrator only — the rule of the management API) or rotates its token. The token goes only
 *   to `--token-file` (created with mode 0600; a symlink or a file owned by someone else is
 *   refused). Without `--token-file` it is printed once to stdout, with a warning on stderr.
 * - `revoke` deletes the user's Jarvis account, which removes its token — the same semantics as
 *   `DELETE /api/manage/channels/accounts/:id`.
 * - Accounts and tokens go through the platform's own path: a ChannelManagementService with the
 *   Jarvis account lifecycle (same checks, same token store, audit entries marked `via: 'cli'`).
 *   No server is started; the database is opened next to a possibly running platform (SQLite WAL,
 *   a busy timeout, one short statement at a time) and never created or migrated here.
 * - A running platform refuses an old token at once (tokens are looked up by hash); its live
 *   connections that still use it are dropped at their next check — this process cannot reach them.
 *
 * Output never contains a token hash, and the token only in the case above.
 *
 * @module @enkeep/demo-runner/jarvis-token
 */

import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  statSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ChannelAccount } from '@enkeep/platform-core';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import {
  ChannelManagementService,
  JarvisAccountLifecycle,
  JARVIS_CHANNEL_TYPE,
} from '@enkeep/platform-server';

export const JARVIS_TOKEN_USAGE = `Usage:
  demo-runner jarvis-token issue  --data-dir <data-dir> --user <username> [--token-file <token-file>] [--json]
  demo-runner jarvis-token revoke --data-dir <data-dir> --user <username> [--json]

  issue   Create the user's Jarvis account (active administrators only) or rotate its token.
          The token is written only to --token-file (mode 0600); without it, it is printed once.
  revoke  Delete the user's Jarvis account and its token (as the Web card's delete does).`;

/** How long a statement waits for the running platform's write lock (ms). */
export const JARVIS_TOKEN_BUSY_TIMEOUT_MS = 5000;

/** What a running platform does with live connections of a token this command replaced or removed. */
export const JARVIS_TOKEN_LIVE_CONNECTION_NOTE =
  'Note: a running platform refuses the old token at once; a jarvisd connection that still uses it is dropped at its next check (its next request, or within about 30 seconds). This command cannot close live connections itself.';

export type JarvisTokenAction = 'issue' | 'revoke';

export interface JarvisTokenCliArgs {
  action: JarvisTokenAction;
  dataDir: string;
  username: string;
  tokenFile?: string;
  json: boolean;
}

/** A refusal or bad input: printed as is, exit code 1 (2 for usage errors). */
export class JarvisTokenCliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'JarvisTokenCliError';
    this.exitCode = exitCode;
  }
}

function usageError(message: string): JarvisTokenCliError {
  return new JarvisTokenCliError(`${message}\n\n${JARVIS_TOKEN_USAGE}`, 2);
}

const VALUE_FLAGS = new Set(['--data-dir', '--user', '--token-file']);
const BOOLEAN_FLAGS = new Set(['--json']);

/**
 * Parses `jarvis-token <issue|revoke> --data-dir <dir> --user <name> [--token-file <path>] [--json]`
 * (`args` starts with `jarvis-token`). Missing or unknown flags are errors; nothing has a default.
 */
export function parseJarvisTokenArgs(args: readonly string[]): JarvisTokenCliArgs {
  const rest = args[0] === 'jarvis-token' ? args.slice(1) : args.slice();
  const action = rest.shift();
  if (action !== 'issue' && action !== 'revoke') {
    throw usageError(action ? `Unknown jarvis-token action "${action}".` : 'Missing jarvis-token action (issue or revoke).');
  }
  const values = new Map<string, string>();
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    if (BOOLEAN_FLAGS.has(name)) {
      if (name !== arg) throw usageError(`${name} takes no value.`);
      json = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw usageError(`Unknown argument "${arg}".`);
    let value: string | undefined;
    if (name !== arg) {
      value = arg.slice(eq + 1);
    } else {
      value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) value = undefined;
      else i++;
    }
    if (value === undefined || value.trim() === '') throw usageError(`${name} requires a value.`);
    if (values.has(name)) throw usageError(`${name} given more than once.`);
    values.set(name, value);
  }
  const dataDir = values.get('--data-dir');
  const username = values.get('--user');
  if (!dataDir) throw usageError('--data-dir <data-dir> is required.');
  if (!username) throw usageError('--user <username> is required.');
  const tokenFile = values.get('--token-file');
  if (tokenFile !== undefined && action === 'revoke') throw usageError('--token-file is only used by issue.');
  return { action, dataDir, username, ...(tokenFile !== undefined ? { tokenFile } : {}), json };
}

// ─────────────────────────── Database ───────────────────────────

interface PlatformDb {
  db: DatabaseSync;
  storage: SqlitePlatformStorage;
  service: ChannelManagementService;
  lifecycle: JarvisAccountLifecycle;
}

/** Opens `<data-dir>/platform.db` of an existing, migrated platform (never creates one). */
function openPlatformDb(dataDir: string): PlatformDb {
  const root = resolve(dataDir);
  let rootStat: Stats;
  try {
    rootStat = statSync(root);
  } catch {
    throw new JarvisTokenCliError(`--data-dir "${root}" does not exist.`);
  }
  if (!rootStat.isDirectory()) throw new JarvisTokenCliError(`--data-dir "${root}" is not a directory.`);
  const dbPath = join(root, 'platform.db');
  let dbStat: Stats;
  try {
    dbStat = statSync(dbPath);
  } catch {
    throw new JarvisTokenCliError(`No platform database at "${dbPath}"; --data-dir must be the platform's data directory.`);
  }
  if (!dbStat.isFile()) throw new JarvisTokenCliError(`"${dbPath}" is not a regular file.`);

  const db = new DatabaseSync(dbPath);
  try {
    // Wait for the running platform's write lock instead of failing at once.
    db.exec(`PRAGMA busy_timeout = ${JARVIS_TOKEN_BUSY_TIMEOUT_MS};`);
    const hasTokens = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channel_account_tokens' LIMIT 1")
      .get();
    if (!hasTokens) {
      throw new JarvisTokenCliError(
        'This platform database has no Jarvis tokens yet (migration 046). Start the upgraded platform once so its migrations run, then retry.'
      );
    }
    const storage = new SqlitePlatformStorage(db);
    const lifecycle = new JarvisAccountLifecycle({ db, storage, auditDetails: { via: 'cli' } });
    const service = new ChannelManagementService(storage, undefined, undefined, { [JARVIS_CHANNEL_TYPE]: lifecycle });
    return { db, storage, service, lifecycle };
  } catch (err) {
    db.close();
    throw err;
  }
}

function closeQuietly(db: DatabaseSync): void {
  try {
    db.close();
  } catch {}
}

/** The user's Jarvis account: the one holding a token, else the oldest. */
async function findJarvisAccount(platform: PlatformDb, userId: string): Promise<ChannelAccount | null> {
  const accounts = await platform.storage.forTenant(userId).channels.listAccounts(JARVIS_CHANNEL_TYPE);
  return accounts.find((a) => platform.lifecycle.tokens.has(a.id)) ?? accounts[0] ?? null;
}

// ─────────────────────────── Token file ───────────────────────────

interface PreparedTokenFile {
  path: string;
  write(token: string): void;
  abort(): void;
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

/**
 * Opens the token file before anything changes in the database: a new file is created with mode
 * 0600 (O_EXCL); an existing one must be a regular file owned by the current user (never a
 * symlink) and is set to 0600. The token is written later; `abort` leaves an existing file as it
 * was and removes a file created here.
 */
function prepareTokenFile(rawPath: string): PreparedTokenFile {
  const path = resolve(rawPath);
  const refuse = (why: string) => new JarvisTokenCliError(`Refusing to write the token to "${path}": ${why}.`);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;

  let existing: Stats | null = null;
  try {
    existing = lstatSync(path);
  } catch (err) {
    if (errorCode(err) !== 'ENOENT') throw refuse(`cannot inspect it (${errorCode(err) ?? 'error'})`);
  }

  let fd: number;
  let created: boolean;
  if (existing) {
    if (existing.isSymbolicLink()) throw refuse('it is a symbolic link');
    if (!existing.isFile()) throw refuse('it is not a regular file');
    if (uid !== undefined && existing.uid !== uid) throw refuse('it is owned by another user');
    try {
      fd = openSync(path, fsConstants.O_WRONLY | noFollow);
    } catch (err) {
      throw refuse(`cannot open it (${errorCode(err) ?? 'error'})`);
    }
    const opened = fstatSync(fd);
    if (opened.dev !== existing.dev || opened.ino !== existing.ino) {
      closeSync(fd);
      throw refuse('it changed while being opened');
    }
    created = false;
  } else {
    try {
      fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
    } catch (err) {
      throw refuse(`cannot create it (${errorCode(err) ?? 'error'})`);
    }
    created = true;
  }
  try {
    fchmodSync(fd, 0o600);
  } catch (err) {
    closeSync(fd);
    if (created) unlinkSync(path);
    throw refuse(`cannot set its mode to 0600 (${errorCode(err) ?? 'error'})`);
  }

  let done = false;
  return {
    path,
    write(token: string) {
      if (done) return;
      done = true;
      try {
        ftruncateSync(fd, 0);
        writeSync(fd, token, 0, 'utf8');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
    abort() {
      if (done) return;
      done = true;
      try {
        closeSync(fd);
      } catch {}
      if (created) {
        try {
          unlinkSync(path);
        } catch {}
      }
    },
  };
}

// ─────────────────────────── Operations ───────────────────────────

export interface IssueJarvisTokenOptions {
  dataDir: string;
  username: string;
  tokenFile?: string;
}

export interface IssueJarvisTokenResult {
  accountId: string;
  /** A new account was created (otherwise the existing account's token was rotated). */
  created: boolean;
  /** The account is active (a disabled account's token does not authenticate). */
  accountActive: boolean;
  /** Absolute path the token was written to, or null when no token file was given. */
  tokenFile: string | null;
  /** The token, only when no token file was given. */
  token?: string;
}

export async function issueJarvisToken(options: IssueJarvisTokenOptions): Promise<IssueJarvisTokenResult> {
  const platform = openPlatformDb(options.dataDir);
  try {
    const user = await platform.storage.users.findByUsername(options.username);
    if (!user) throw new JarvisTokenCliError(`User "${options.username}" not found.`);
    if (user.status !== 'active') throw new JarvisTokenCliError(`User "${options.username}" is not active.`);
    if (user.role !== 'admin') {
      throw new JarvisTokenCliError(`Jarvis tokens are limited to administrators; "${options.username}" is not an administrator.`);
    }

    // The token file is checked and opened before anything changes.
    const target = options.tokenFile !== undefined ? prepareTokenFile(options.tokenFile) : null;
    try {
      const existing = await findJarvisAccount(platform, user.id);
      let accountId: string;
      let token: string;
      let accountActive: boolean;
      if (existing) {
        ({ token } = await platform.service.rotateAccountToken(user.id, existing.id));
        accountId = existing.id;
        accountActive = existing.status === 'active';
      } else {
        const created = await platform.service.createAccount(user.id, { type: JARVIS_CHANNEL_TYPE });
        if (typeof created.token !== 'string') throw new JarvisTokenCliError('The platform did not issue a token.');
        token = created.token;
        accountId = created.id;
        accountActive = created.status === 'active';
      }
      if (target) {
        target.write(token);
        return { accountId, created: !existing, accountActive, tokenFile: target.path };
      }
      return { accountId, created: !existing, accountActive, tokenFile: null, token };
    } catch (err) {
      target?.abort();
      throw err;
    }
  } finally {
    closeQuietly(platform.db);
  }
}

export interface RevokeJarvisTokenOptions {
  dataDir: string;
  username: string;
}

export interface RevokeJarvisTokenResult {
  /** The deleted account, or null when the user had none. */
  accountId: string | null;
  deleted: boolean;
}

/** Deletes the user's Jarvis account (and with it its token), like the management API's DELETE. */
export async function revokeJarvisToken(options: RevokeJarvisTokenOptions): Promise<RevokeJarvisTokenResult> {
  const platform = openPlatformDb(options.dataDir);
  try {
    const user = await platform.storage.users.findByUsername(options.username);
    if (!user) throw new JarvisTokenCliError(`User "${options.username}" not found.`);
    const account = await findJarvisAccount(platform, user.id);
    if (!account) return { accountId: null, deleted: false };
    const deleted = await platform.service.deleteAccount(user.id, account.id);
    // The row is gone with the account (foreign key cascade); make sure no token survives.
    platform.lifecycle.tokens.revoke(account.id);
    return { accountId: account.id, deleted };
  } finally {
    closeQuietly(platform.db);
  }
}

// ─────────────────────────── CLI ───────────────────────────

export interface JarvisTokenCliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

const processIo: JarvisTokenCliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

/** Runs `jarvis-token …` (`args` starts with `jarvis-token`); returns the exit code. */
export async function runJarvisTokenCli(args: readonly string[], io: JarvisTokenCliIo = processIo): Promise<number> {
  const json = args.includes('--json');
  try {
    const parsed = parseJarvisTokenArgs(args);
    if (parsed.action === 'issue') {
      const result = await issueJarvisToken(parsed);
      if (result.tokenFile === null) {
        io.stderr('Warning: no --token-file given, so the token is printed once on stdout. Store it in a file only you can read (mode 0600) and do not share it; it is not shown again.');
        io.stderr(`account-id: ${result.accountId}`);
      }
      if (parsed.json) {
        io.stdout(
          JSON.stringify({
            ok: true,
            action: 'issue',
            accountId: result.accountId,
            created: result.created,
            accountActive: result.accountActive,
            tokenFile: result.tokenFile,
            ...(result.token !== undefined ? { token: result.token } : {}),
          })
        );
      } else if (result.tokenFile !== null) {
        io.stdout(`account-id: ${result.accountId}`);
        io.stdout(`token-file: ${result.tokenFile}`);
      } else {
        io.stdout(result.token!);
      }
      io.stderr(result.created ? 'Created the Jarvis account and issued its token.' : 'Rotated the token of the existing Jarvis account; the previous token no longer works.');
      if (!result.accountActive) {
        io.stderr('Warning: this Jarvis account is disabled; its token does not authenticate until the account is enabled again.');
      }
      if (!result.created) io.stderr(JARVIS_TOKEN_LIVE_CONNECTION_NOTE);
      return 0;
    }

    const result = await revokeJarvisToken(parsed);
    if (parsed.json) {
      io.stdout(JSON.stringify({ ok: true, action: 'revoke', accountId: result.accountId, deleted: result.deleted }));
    } else if (result.accountId === null) {
      io.stdout(`No Jarvis account for user "${parsed.username}"; nothing to revoke.`);
    } else {
      io.stdout(`account-id: ${result.accountId}`);
      io.stdout(`deleted: ${result.deleted}`);
    }
    if (result.accountId !== null) io.stderr(JARVIS_TOKEN_LIVE_CONNECTION_NOTE);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const exitCode = err instanceof JarvisTokenCliError ? err.exitCode : 1;
    if (json) io.stdout(JSON.stringify({ ok: false, error: message }));
    else io.stderr(`Error: ${message}`);
    return exitCode;
  }
}
