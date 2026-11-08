import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import {
  PlatformServer,
  SqliteWebMessageStore,
  SELF_CHECK_TOKEN_FILE_NAME,
  SELF_CHECK_TOKEN_HEADER,
  issueSelfCheckToken,
  verifySelfCheckToken,
  readMigrationStatus,
} from '../src/index.js';
import { createPlatformServerHandler } from '../src/server/handler.js';
import { PlatformServerMigrationRunner, ALL_PLATFORM_MIGRATIONS } from '../src/storage/migrations.js';
import { TestOnlyRuntimeGateway } from './test-runtime-gateway.js';

const CSRF = 'test-suite-selfcheck-csrf-token-32-chars!';
const COOKIE_SECRET = 'test-secret-key-32-chars-long-super-safe!';

function newTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-test-selfcheck-'));
}

function newServer(db: DatabaseSync, tokenFile?: string, extra: Record<string, unknown> = {}): PlatformServer {
  const storage = new SqlitePlatformStorage(db);
  const messageStore = new SqliteWebMessageStore(db);
  const runtimeGateway = new TestOnlyRuntimeGateway({ storage, messageStore, autoReply: false });
  return new PlatformServer({
    database: db,
    host: '127.0.0.1',
    port: 0,
    cookieSecret: COOKIE_SECRET,
    csrfToken: CSRF,
    runtimeGateway,
    ...(tokenFile ? { selfCheckTokenFile: tokenFile } : {}),
    ...extra,
  });
}

function readToken(file: string): string {
  return fs.readFileSync(file, 'utf8').trim();
}

describe('GET /api/selfcheck (deployment self-check)', () => {
  describe('on a running PlatformServer', () => {
    let tmp: string;
    let db: DatabaseSync;
    let server: PlatformServer | null;
    let baseUrl: string;
    let tokenFile: string;

    beforeEach(async () => {
      tmp = newTmpDir();
      tokenFile = path.join(tmp, SELF_CHECK_TOKEN_FILE_NAME);
      db = new DatabaseSync(':memory:');
      server = newServer(db, tokenFile);
      baseUrl = (await server.start()).url;
    });

    afterEach(async () => {
      if (server) await server.stop();
      try { db.close(); } catch {}
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('writes the token file with mode 0600 before serving', () => {
      const st = fs.statSync(tokenFile);
      expect(st.isFile()).toBe(true);
      expect(st.mode & 0o777).toBe(0o600);
      expect(readToken(tokenFile)).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // No temp files left behind.
      expect(fs.readdirSync(tmp)).toEqual([SELF_CHECK_TOKEN_FILE_NAME]);
    });

    it('returns versions, migrations and health with the token', async () => {
      const res = await fetch(`${baseUrl}/api/selfcheck`, { headers: { [SELF_CHECK_TOKEN_HEADER]: readToken(tokenFile) } });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      const data = json.data;
      expect(Object.keys(data).sort()).toEqual(
        ['health', 'migrations', 'runtimeTarget', 'runtimes', 'startedAt', 'status', 'uptimeSeconds', 'webhookPolicy'].sort()
      );
      expect(data.migrations.upToDate).toBe(true);
      expect(data.migrations.pendingVersions).toEqual([]);
      expect(data.migrations.currentVersion).toBe(data.migrations.latestVersion);
      expect(typeof data.startedAt).toBe('string');
      expect(data.runtimes).toEqual({ total: 0, outdated: 0, items: [] });
    });

    it('refuses a missing or wrong token with 401', async () => {
      const none = await fetch(`${baseUrl}/api/selfcheck`);
      expect(none.status).toBe(401);
      const wrong = await fetch(`${baseUrl}/api/selfcheck`, { headers: { [SELF_CHECK_TOKEN_HEADER]: 'x'.repeat(43) } });
      expect(wrong.status).toBe(401);
      const body = JSON.stringify(await wrong.json());
      expect(body).not.toContain(readToken(tokenFile));
    });

    it('a session cookie does not replace the token', async () => {
      const res = await fetch(`${baseUrl}/api/selfcheck`, { headers: { Cookie: 'enkeep_session=session-test-0001' } });
      expect(res.status).toBe(401);
    });

    it('is GET only', async () => {
      const res = await fetch(`${baseUrl}/api/selfcheck`, {
        method: 'POST',
        headers: { [SELF_CHECK_TOKEN_HEADER]: readToken(tokenFile), Origin: baseUrl, 'X-Enkeep-CSRF': CSRF },
      });
      expect(res.status).toBe(405);
    });

    it('the token grants nothing outside the self-check', async () => {
      const token = readToken(tokenFile);
      for (const p of ['/api/admin/runtime/upgrade-status', '/api/admin/dashboard', '/api/auth/me', '/api/spaces']) {
        const res = await fetch(`${baseUrl}${p}`, { headers: { [SELF_CHECK_TOKEN_HEADER]: token } });
        expect(res.status, p).toBe(401);
      }
    });

    it('issues a new token at every start; the old one stops working', async () => {
      const oldToken = readToken(tokenFile);
      await server!.stop();
      server = newServer(db, tokenFile);
      baseUrl = (await server.start()).url;
      const newToken = readToken(tokenFile);
      expect(newToken).not.toBe(oldToken);
      const stale = await fetch(`${baseUrl}/api/selfcheck`, { headers: { [SELF_CHECK_TOKEN_HEADER]: oldToken } });
      expect(stale.status).toBe(401);
      const fresh = await fetch(`${baseUrl}/api/selfcheck`, { headers: { [SELF_CHECK_TOKEN_HEADER]: newToken } });
      expect(fresh.status).toBe(200);
    });

    it('a second instance that cannot bind the port does not replace the serving token', async () => {
      const token = readToken(tokenFile);
      const port = Number(new URL(baseUrl).port);
      const db2 = new DatabaseSync(':memory:');
      const second = newServer(db2, tokenFile, { port });
      try {
        await expect(second.start()).rejects.toThrow();
      } finally {
        try { await second.stop(); } catch {}
        db2.close();
      }
      expect(readToken(tokenFile)).toBe(token);
      const res = await fetch(`${baseUrl}/api/selfcheck`, { headers: { [SELF_CHECK_TOKEN_HEADER]: token } });
      expect(res.status).toBe(200);
    });

    it('stops accepting the token once the server is stopped', async () => {
      const token = readToken(tokenFile);
      const handlerHashBefore = verifySelfCheckToken(token, (server as any).selfCheckTokenHash);
      expect(handlerHashBefore).toBe(true);
      await server!.stop();
      expect((server as any).selfCheckTokenHash).toBeNull();
      server = null;
    });
  });

  it('starts normally when the token file cannot be written; the route then answers 404', async () => {
    const tmp = newTmpDir();
    const tokenDir = path.join(tmp, SELF_CHECK_TOKEN_FILE_NAME);
    fs.mkdirSync(tokenDir); // a directory where the token file should be
    const db = new DatabaseSync(':memory:');
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
    const server = newServer(db, tokenDir);
    try {
      const { url } = await server.start();
      const res = await fetch(`${url}/api/selfcheck`, { headers: { [SELF_CHECK_TOKEN_HEADER]: 'anything' } });
      expect(res.status).toBe(404);
      expect(errors.join('\n')).toMatch(/could not write the self-check token file/);
      expect(fs.readdirSync(tmp)).toEqual([SELF_CHECK_TOKEN_FILE_NAME]);
    } finally {
      console.error = origError;
      await server.stop();
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reports the effective webhook policy switches', async () => {
    const saved = process.env.ALLOW_TEST_WEBHOOK_LOOPBACK;
    delete process.env.ALLOW_TEST_WEBHOOK_LOOPBACK;
    const cases: Array<[Record<string, unknown>, { allowLoopback: boolean; enforceHttps: boolean }]> = [
      [{ webhookSecurityOptions: { allowTestLoopback: false, enforceHttps: true } }, { allowLoopback: false, enforceHttps: true }],
      [{ webhookSecurityOptions: { allowTestLoopback: true, enforceHttps: false } }, { allowLoopback: true, enforceHttps: false }],
      [{}, { allowLoopback: false, enforceHttps: true }],
    ];
    try {
      for (const [extra, expected] of cases) {
        const tmp = newTmpDir();
        const tokenFile = path.join(tmp, SELF_CHECK_TOKEN_FILE_NAME);
        const db = new DatabaseSync(':memory:');
        const server = newServer(db, tokenFile, extra);
        const { url } = await server.start();
        try {
          const res = await fetch(`${url}/api/selfcheck`, { headers: { [SELF_CHECK_TOKEN_HEADER]: readToken(tokenFile) } });
          expect((await res.json()).data.webhookPolicy).toEqual(expected);
        } finally {
          await server.stop();
          db.close();
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      }
    } finally {
      if (saved !== undefined) process.env.ALLOW_TEST_WEBHOOK_LOOPBACK = saved;
    }
  });

  it('answers 404 when the server was started without a token file', async () => {
    const db = new DatabaseSync(':memory:');
    const server = newServer(db);
    const { url } = await server.start();
    try {
      const res = await fetch(`${url}/api/selfcheck`, { headers: { [SELF_CHECK_TOKEN_HEADER]: 'anything' } });
      expect(res.status).toBe(404);
    } finally {
      await server.stop();
      db.close();
    }
  });

  describe('handler', () => {
    let db: DatabaseSync;
    const TOKEN = 'selfcheck-test-token-000000000000000000001';

    beforeEach(async () => {
      db = new DatabaseSync(':memory:');
      await new PlatformServerMigrationRunner(db).migrate(ALL_PLATFORM_MIGRATIONS);
    });
    afterEach(() => { try { db.close(); } catch {} });

    async function call(remoteAddress: string, token: string | undefined, managementProvider?: any) {
      const tmp = newTmpDir();
      try {
        const hash = issueSelfCheckToken(path.join(tmp, 't'));
        const issued = readToken(path.join(tmp, 't'));
        const handler = createPlatformServerHandler({
          database: db,
          csrfToken: CSRF,
          runtimeGateway: {} as any,
          platformApi: {} as any,
          managementProvider,
          selfCheck: {
            getTokenHash: () => hash,
            getMigrationStatus: () => readMigrationStatus(db, ALL_PLATFORM_MIGRATIONS),
            getStartedAt: () => '2026-01-01T00:00:00.000Z',
          },
        });
        const req: any = {
          method: 'GET',
          url: '/api/selfcheck',
          socket: { localAddress: '127.0.0.1', localPort: 3456, remoteAddress },
          headers: { host: '127.0.0.1:3456', ...(token !== undefined ? { [SELF_CHECK_TOKEN_HEADER]: token === TOKEN ? issued : token } : {}) },
        };
        let body = '';
        const res: any = {
          statusCode: 0,
          setHeader: vi.fn(),
          writeHead(code: number) { this.statusCode = code; },
          end: (chunk: string) => { body = chunk; },
        };
        await handler(req, res);
        return { status: res.statusCode, json: body ? JSON.parse(body) : null };
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }

    it('strips user ids and reports per-runtime versions and counts', async () => {
      const managementProvider = {
        listRuntimes: vi.fn().mockResolvedValue([]),
        getTargetVersion: vi.fn().mockResolvedValue({
          id: 'default', image: 'enkeep-runtime:test-new', daemonCliPath: '/tmp/enkeep-test/new/daemon-cli.js', updatedBy: 'user-alice', updatedAt: '2026-01-01T00:00:00.000Z',
        }),
        getUpgradeStatus: vi.fn().mockResolvedValue([
          { userId: 'user-alice', mode: 'container', currentImage: 'enkeep-runtime:test-old', targetImage: 'enkeep-runtime:test-new', isOutdated: true, isIdle: false, idleDurationSeconds: 3, pendingReason: 'busy' },
          { userId: 'user-bob', mode: 'host', currentDaemonCliPath: '/tmp/enkeep-test/new/daemon-cli.js', targetDaemonCliPath: '/tmp/enkeep-test/new/daemon-cli.js', isOutdated: false, isIdle: true, idleDurationSeconds: 900, pendingReason: 'up_to_date' },
        ]),
      };
      const { status, json } = await call('127.0.0.1', TOKEN, managementProvider);
      expect(status).toBe(200);
      const text = JSON.stringify(json);
      expect(text).not.toContain('user-alice');
      expect(text).not.toContain('user-bob');
      expect(json.data.runtimeTarget).toEqual({ image: 'enkeep-runtime:test-new', daemonCliPath: '/tmp/enkeep-test/new/daemon-cli.js' });
      expect(json.data.runtimes.total).toBe(2);
      expect(json.data.runtimes.outdated).toBe(1);
      expect(json.data.runtimes.items[0]).toEqual({
        mode: 'container', current: 'enkeep-runtime:test-old', target: 'enkeep-runtime:test-new', isOutdated: true, isIdle: false, pendingReason: 'busy',
      });
      expect(json.data.runtimes.items[1].current).toBe('/tmp/enkeep-test/new/daemon-cli.js');
      expect(json.data.health.runtime.available).toBe(true);
    });

    it('reports provider failures as degraded with reasons instead of a 500', async () => {
      const managementProvider = {
        listRuntimes: vi.fn().mockResolvedValue([]),
        getTargetVersion: vi.fn().mockRejectedValue(new Error('boom')),
        getUpgradeStatus: vi.fn().mockRejectedValue(new Error('boom')),
      };
      const { status, json } = await call('127.0.0.1', TOKEN, managementProvider);
      expect(status).toBe(200);
      expect(json.data.status).toBe('degraded');
      expect(json.data.health.errors).toEqual(['upgrade_status_unavailable', 'target_version_unavailable']);
      expect(JSON.stringify(json)).not.toContain('boom');
    });

    it('accepts the IPv6 loopback peer', async () => {
      const { status } = await call('::1', TOKEN);
      expect(status).toBe(200);
    });

    it('refuses non-loopback peers even with the right token', async () => {
      const { status } = await call('10.0.0.5', TOKEN);
      expect(status).toBe(403);
    });

    it('accepts the IPv4-mapped loopback peer', async () => {
      const { status } = await call('::ffff:127.0.0.1', TOKEN);
      expect(status).toBe(200);
    });

    it('refuses a missing token', async () => {
      const { status } = await call('127.0.0.1', undefined);
      expect(status).toBe(401);
    });
  });

  describe('token helpers', () => {
    it('replaces a symlink at the token path instead of writing through it', () => {
      const tmp = newTmpDir();
      try {
        const victim = path.join(tmp, 'victim.txt');
        fs.writeFileSync(victim, 'keep-me');
        const tokenFile = path.join(tmp, SELF_CHECK_TOKEN_FILE_NAME);
        fs.symlinkSync(victim, tokenFile);
        issueSelfCheckToken(tokenFile);
        expect(fs.readFileSync(victim, 'utf8')).toBe('keep-me');
        expect(fs.lstatSync(tokenFile).isSymbolicLink()).toBe(false);
        expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('verifySelfCheckToken rejects empty, oversized, non-string and missing-hash input', () => {
      const tmp = newTmpDir();
      try {
        const file = path.join(tmp, 't');
        const hash = issueSelfCheckToken(file);
        const token = readToken(file);
        expect(verifySelfCheckToken(token, hash)).toBe(true);
        expect(verifySelfCheckToken(`  ${token}  `, hash)).toBe(true);
        expect(verifySelfCheckToken('', hash)).toBe(false);
        expect(verifySelfCheckToken('a'.repeat(1000), hash)).toBe(false);
        expect(verifySelfCheckToken([token], hash)).toBe(false);
        expect(verifySelfCheckToken(token, null)).toBe(false);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('readMigrationStatus reports pending versions', async () => {
      const db = new DatabaseSync(':memory:');
      try {
        await new PlatformServerMigrationRunner(db).migrate(ALL_PLATFORM_MIGRATIONS);
        const latest = Math.max(...ALL_PLATFORM_MIGRATIONS.map((m) => m.version));
        db.prepare('DELETE FROM _schema_migrations WHERE version = ?').run(latest);
        const st = readMigrationStatus(db, ALL_PLATFORM_MIGRATIONS);
        expect(st.upToDate).toBe(false);
        expect(st.pendingVersions).toEqual([latest]);
        expect(st.latestVersion).toBe(latest);
      } finally {
        db.close();
      }
    });
  });
});
