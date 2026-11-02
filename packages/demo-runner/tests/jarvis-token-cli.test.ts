/**
 * `demo-runner jarvis-token issue|revoke` (synthetic, offline): a temporary data directory with the
 * platform schema migrated, synthetic users, and a second database connection standing in for a
 * running platform (WAL) whose token store must refuse an old token as soon as the CLI replaced it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { PlatformServerMigrationRunner, ALL_PLATFORM_MIGRATIONS, JarvisTokenStore } from '@enkeep/platform-server';
import {
  JARVIS_TOKEN_LIVE_CONNECTION_NOTE,
  parseJarvisTokenArgs,
  runJarvisTokenCli,
} from '../src/jarvis-token/index.js';
import { runDemoRunnerCli } from '../src/demo-runner.js';

const ADMIN = 'user-alice';
const MEMBER = 'user-bob';
const DISABLED_ADMIN = 'user-carol';
const TOKEN_SHAPE = /^ejv_[A-Za-z0-9_-]{43}$/;

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) }, out, err };
}

describe('demo-runner jarvis-token', () => {
  let root: string;
  let dataDir: string;
  let dbPath: string;
  /** The running platform's own connection to the same database. */
  let platformDb: DatabaseSync;
  let platformTokens: JarvisTokenStore;

  async function cli(...args: string[]) {
    const c = capture();
    const code = await runJarvisTokenCli(['jarvis-token', ...args], c.io);
    return { code, out: c.out, err: c.err, all: [...c.out, ...c.err].join('\n') };
  }

  const tokenRows = () => platformDb.prepare('SELECT account_id, user_id, token_hash FROM channel_account_tokens ORDER BY account_id').all() as any[];
  const jarvisAccounts = (userId: string) =>
    platformDb.prepare("SELECT id, status FROM channel_accounts WHERE user_id = ? AND type = 'jarvis'").all(userId) as any[];
  const jarvisAudit = () =>
    (platformDb.prepare("SELECT action, user_id, details FROM auth_audit_log WHERE action LIKE 'jarvis.%' ORDER BY rowid").all() as any[]).map((r) => ({
      action: r.action,
      userId: r.user_id,
      details: JSON.parse(r.details),
    }));

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'enkeep-test-jarvis-token-'));
    dataDir = join(root, 'data');
    mkdirSync(dataDir);
    dbPath = join(dataDir, 'platform.db');
    platformDb = new DatabaseSync(dbPath);
    await new PlatformServerMigrationRunner(platformDb).migrate(ALL_PLATFORM_MIGRATIONS);
    new SqlitePlatformStorage(platformDb); // WAL + foreign keys, as the platform opens it
    const insert = platformDb.prepare('INSERT INTO users (id, username, password_hash, role, status) VALUES (?, ?, ?, ?, ?)');
    insert.run(ADMIN, 'alice', 'synthetic-hash', 'admin', 'active');
    insert.run(MEMBER, 'bob', 'synthetic-hash', 'user', 'active');
    insert.run(DISABLED_ADMIN, 'carol', 'synthetic-hash', 'admin', 'disabled');
    platformTokens = new JarvisTokenStore(platformDb);
  });

  afterEach(() => {
    platformDb.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('issue creates the account and writes the token only to a new 0600 token file', async () => {
    const tokenFile = join(root, 'jarvis.token');
    const res = await cli('issue', '--data-dir', dataDir, '--user', 'alice', '--token-file', tokenFile);
    expect(res.code).toBe(0);

    const accounts = jarvisAccounts(ADMIN);
    expect(accounts).toEqual([{ id: expect.any(String), status: 'active' }]);
    const accountId = accounts[0].id as string;
    expect(res.out).toEqual([`account-id: ${accountId}`, `token-file: ${tokenFile}`]);

    expect(lstatSync(tokenFile).isFile()).toBe(true);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    const token = readFileSync(tokenFile, 'utf8');
    expect(token).toMatch(TOKEN_SHAPE);
    expect(tokenRows()).toEqual([{ account_id: accountId, user_id: ADMIN, token_hash: sha256(token) }]);
    expect(res.all).not.toContain(token);
    expect(res.all).not.toContain(sha256(token));

    // The running platform accepts it right away.
    expect(platformTokens.authenticate(token)).toEqual({ accountId, userId: ADMIN });
    expect(jarvisAudit()).toEqual([{ action: 'jarvis.token_issued', userId: ADMIN, details: { accountId, via: 'cli' } }]);
  });

  it('issue again rotates the token: the old hash is gone and the platform refuses the old token at once', async () => {
    const tokenFile = join(root, 'jarvis.token');
    expect((await cli('issue', '--data-dir', dataDir, '--user', 'alice', '--token-file', tokenFile)).code).toBe(0);
    const accountId = jarvisAccounts(ADMIN)[0].id as string;
    const first = readFileSync(tokenFile, 'utf8');
    expect(platformTokens.authenticate(first)).not.toBeNull();

    const res = await cli('issue', '--data-dir', dataDir, '--user=alice', `--token-file=${tokenFile}`);
    expect(res.code).toBe(0);
    expect(res.out).toEqual([`account-id: ${accountId}`, `token-file: ${tokenFile}`]);
    expect(res.err).toContain(JARVIS_TOKEN_LIVE_CONNECTION_NOTE);
    const second = readFileSync(tokenFile, 'utf8');
    expect(second).toMatch(TOKEN_SHAPE);
    expect(second).not.toBe(first);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);

    expect(jarvisAccounts(ADMIN)).toHaveLength(1);
    expect(tokenRows()).toEqual([{ account_id: accountId, user_id: ADMIN, token_hash: sha256(second) }]);
    expect(platformTokens.authenticate(first)).toBeNull();
    expect(platformTokens.authenticate(second)).toEqual({ accountId, userId: ADMIN });
    expect(jarvisAudit().map((a) => a.action)).toEqual(['jarvis.token_issued', 'jarvis.token_rotated']);
    expect(jarvisAudit()[1].details).toEqual({ accountId, closedConnections: 0, via: 'cli' });
  });

  it('tightens an existing token file of the current user to 0600 and replaces its content', async () => {
    const tokenFile = join(root, 'existing.token');
    writeFileSync(tokenFile, 'synthetic old content that is longer than a token '.repeat(3), { mode: 0o644 });
    expect((await cli('issue', '--data-dir', dataDir, '--user', 'alice', '--token-file', tokenFile)).code).toBe(0);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(tokenFile, 'utf8')).toMatch(TOKEN_SHAPE);
  });

  it('refuses a non-admin, a disabled admin and an unknown user without changing anything', async () => {
    for (const [user, message] of [
      ['bob', /limited to administrators/],
      ['carol', /not active/],
      ['nobody', /User "nobody" not found/],
    ] as const) {
      const tokenFile = join(root, `${user}.token`);
      const res = await cli('issue', '--data-dir', dataDir, '--user', user, '--token-file', tokenFile);
      expect(res.code).toBe(1);
      expect(res.out).toEqual([]);
      expect(res.err.join('\n')).toMatch(message);
      expect(existsSync(tokenFile)).toBe(false);
    }
    expect(platformDb.prepare("SELECT COUNT(*) AS c FROM channel_accounts WHERE type = 'jarvis'").get()).toEqual({ c: 0 });
    expect(tokenRows()).toEqual([]);
    expect(jarvisAudit()).toEqual([]);
  });

  it('refuses a symlinked token file and leaves the database and the link target alone', async () => {
    const target = join(root, 'elsewhere.txt');
    writeFileSync(target, 'synthetic unrelated content');
    const link = join(root, 'link.token');
    symlinkSync(target, link);
    const res = await cli('issue', '--data-dir', dataDir, '--user', 'alice', '--token-file', link);
    expect(res.code).toBe(1);
    expect(res.err.join('\n')).toMatch(/Refusing to write the token .*symbolic link/);
    expect(readFileSync(target, 'utf8')).toBe('synthetic unrelated content');
    expect(jarvisAccounts(ADMIN)).toEqual([]);
    expect(tokenRows()).toEqual([]);
  });

  it('revoke deletes the account and its token (as the API DELETE does) and is idempotent', async () => {
    const tokenFile = join(root, 'jarvis.token');
    expect((await cli('issue', '--data-dir', dataDir, '--user', 'alice', '--token-file', tokenFile)).code).toBe(0);
    const accountId = jarvisAccounts(ADMIN)[0].id as string;
    const token = readFileSync(tokenFile, 'utf8');

    const res = await cli('revoke', '--data-dir', dataDir, '--user', 'alice');
    expect(res.code).toBe(0);
    expect(res.out).toEqual([`account-id: ${accountId}`, 'deleted: true']);
    expect(res.err).toContain(JARVIS_TOKEN_LIVE_CONNECTION_NOTE);
    expect(jarvisAccounts(ADMIN)).toEqual([]);
    expect(tokenRows()).toEqual([]);
    expect(platformTokens.authenticate(token)).toBeNull();
    expect(jarvisAudit().at(-1)).toEqual({
      action: 'jarvis.token_revoked',
      userId: ADMIN,
      details: { accountId, reason: 'account_deleted', closedConnections: 0, via: 'cli' },
    });

    const again = await cli('revoke', '--data-dir', dataDir, '--user', 'alice');
    expect(again.code).toBe(0);
    expect(again.out).toEqual(['No Jarvis account for user "alice"; nothing to revoke.']);
    expect((await cli('revoke', '--data-dir', dataDir, '--user', 'nobody')).code).toBe(1);

    // A new account can be issued afterwards.
    expect((await cli('issue', '--data-dir', dataDir, '--user', 'alice', '--token-file', join(root, 'next.token'))).code).toBe(0);
    expect(jarvisAccounts(ADMIN)).toHaveLength(1);
  });

  it('prints the token once on stdout, with a warning on stderr, only when no token file is given', async () => {
    const res = await cli('issue', '--data-dir', dataDir, '--user', 'alice');
    expect(res.code).toBe(0);
    expect(res.out).toHaveLength(1);
    const token = res.out[0]!;
    expect(token).toMatch(TOKEN_SHAPE);
    expect(res.err.join('\n')).toMatch(/Warning: no --token-file given/);
    expect(res.err.join('\n')).not.toContain(token);
    expect(tokenRows()[0].token_hash).toBe(sha256(token));

    const json = await cli('issue', '--data-dir', dataDir, '--user', 'alice', '--token-file', join(root, 'j.token'), '--json');
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.out[0]!);
    expect(parsed).toEqual({ ok: true, action: 'issue', accountId: expect.any(String), created: false, accountActive: true, tokenFile: join(root, 'j.token') });
  });

  it('takes every value from flags and fails clearly when one is missing; never creates a database', async () => {
    expect(() => parseJarvisTokenArgs(['jarvis-token', 'issue', '--user', 'alice'])).toThrow(/--data-dir <data-dir> is required/);
    expect(() => parseJarvisTokenArgs(['jarvis-token', 'issue', '--data-dir', dataDir])).toThrow(/--user <username> is required/);
    expect(() => parseJarvisTokenArgs(['jarvis-token', 'issue', '--data-dir', '--user', 'alice'])).toThrow(/--data-dir requires a value/);
    expect(() => parseJarvisTokenArgs(['jarvis-token', 'rotate', '--data-dir', dataDir, '--user', 'alice'])).toThrow(/Unknown jarvis-token action/);
    expect(() => parseJarvisTokenArgs(['jarvis-token', 'revoke', '--data-dir', dataDir, '--user', 'alice', '--token-file', 'x'])).toThrow(/only used by issue/);
    expect(() => parseJarvisTokenArgs(['jarvis-token', 'issue', '--data-dir', dataDir, '--user', 'alice', '--force'])).toThrow(/Unknown argument/);
    expect(parseJarvisTokenArgs(['jarvis-token', 'issue', '--data-dir', dataDir, '--user', 'alice'])).toEqual({
      action: 'issue',
      dataDir,
      username: 'alice',
      json: false,
    });

    const prev = process.env.ENKEEP_DATA_DIR;
    process.env.ENKEEP_DATA_DIR = dataDir;
    try {
      const missing = await cli('issue', '--user', 'alice');
      expect(missing.code).toBe(2);
      expect(missing.err.join('\n')).toMatch(/--data-dir <data-dir> is required/);
    } finally {
      if (prev === undefined) delete process.env.ENKEEP_DATA_DIR;
      else process.env.ENKEEP_DATA_DIR = prev;
    }

    const emptyDir = join(root, 'empty');
    mkdirSync(emptyDir);
    const noDb = await cli('issue', '--data-dir', emptyDir, '--user', 'alice');
    expect(noDb.code).toBe(1);
    expect(noDb.err.join('\n')).toMatch(/No platform database/);
    expect(existsSync(join(emptyDir, 'platform.db'))).toBe(false);
    expect((await cli('issue', '--data-dir', join(root, 'missing'), '--user', 'alice')).err.join('\n')).toMatch(/does not exist/);
  });

  it('is dispatched by the demo-runner CLI', async () => {
    const writes: string[] = [];
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      writes.push(String(chunk));
      return true;
    });
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await runDemoRunnerCli(['jarvis-token', 'issue', '--data-dir', dataDir, '--user', 'alice', '--token-file', join(root, 'cli.token')]);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    const accountId = jarvisAccounts(ADMIN)[0].id as string;
    expect(writes.join('')).toBe(`account-id: ${accountId}\ntoken-file: ${join(root, 'cli.token')}\n`);
  });
});
