import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { ALL_PLATFORM_MIGRATIONS } from '@enkeep/platform-core';
import { PlatformServerMigrationRunner } from '../src/storage/migrations.js';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { DefaultAuthService, provisionFixtures } from '@enkeep/platform-auth';
import { PlatformServer } from '../src/server/server.js';
import { TarWriter } from '@enkeep/backup-restore';
import type { RuntimeGateway } from '@enkeep/web-channel';
import { validateExtensionActivationPlan } from '@enkeep/platform-core';

function createTarGzArchive(files: Array<{ path: string; content: string }>): Buffer {
  const writer = new TarWriter();
  for (const f of files) {
    writer.addFile({ path: f.path, data: Buffer.from(f.content, 'utf8') });
  }
  const tarBuffer = writer.finalize();
  return zlib.gzipSync(tarBuffer);
}

describe('CLI Extension Catalog & Platform Integration', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let authService: DefaultAuthService;
  let server: PlatformServer;
  let baseUrl: string;
  let csrfToken: string;

  let tempDir: string;
  let dshHome: string;
  let spacesDir: string;

  let aliceUserId: string;
  let bobUserId: string;
  let aliceCookie: string;
  let bobCookie: string;
  let aliceSpaceId: string;
  let bobSpaceId: string;

  const mockRuntimeGateway: RuntimeGateway = {
    async dispatchInbound() {
      return { accepted: true, turnId: 'turn_mock', dshSessionId: 'ses_mock' };
    },
    async getTurnStatus() {
      return { turnId: 'turn_mock', status: 'completed' as const };
    },
    async cancelTurn() {
      return true;
    },
  };

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-cli-cat-test-'));
    dshHome = path.join(tempDir, 'dsh-home');
    spacesDir = path.join(tempDir, 'spaces');

    fs.mkdirSync(dshHome, { recursive: true });
    fs.mkdirSync(spacesDir, { recursive: true });

    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    csrfToken = 'csrf_token_min_32_chars_for_cli_catalog_test_12345';

    storage = new SqlitePlatformStorage(db);
    authService = new DefaultAuthService(storage, {
      cookieSecret: 'test_cookie_secret_at_least_32_chars_long_12345',
    });

    server = new PlatformServer({
      database: db,
      storage,
      authService,
      host: '127.0.0.1',
      port: 0,
      cookieSecret: 'test_cookie_secret_at_least_32_chars_long_12345',
      csrfToken,
      runtimeGateway: mockRuntimeGateway,
      dshHome,
      spacesDir,
    });

    const addr = await server.start();
    baseUrl = addr.url;

    // Provision fixtures: Alice (Admin), Bob (User)
    const fixtures = await provisionFixtures(storage, authService, {
      adminUsername: 'alice',
      adminPassword: 'AlicePassword123!',
      userUsername: 'bob',
      userPassword: 'BobPassword123!',
      disabledUsername: 'charlie',
      disabledPassword: 'CharliePassword123!',
    });

    aliceUserId = fixtures.admin.id;
    bobUserId = fixtures.user.id;
    aliceSpaceId = fixtures.adminContainerSpace.id;
    bobSpaceId = fixtures.userContainerSpace.id;

    fs.mkdirSync(path.join(spacesDir, fixtures.adminContainerSpace.folder), { recursive: true });
    fs.mkdirSync(path.join(spacesDir, fixtures.userContainerSpace.folder), { recursive: true });

    // Log in Alice (Admin)
    const aliceLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ username: 'alice', password: 'AlicePassword123!' }),
    });
    expect(aliceLogin.status).toBe(200);
    aliceCookie = aliceLogin.headers.get('set-cookie')?.split(';')[0] || '';

    // Log in Bob (User)
    const bobLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ username: 'bob', password: 'BobPassword123!' }),
    });
    expect(bobLogin.status).toBe(200);
    bobCookie = bobLogin.headers.get('set-cookie')?.split(';')[0] || '';
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('installs deterministic CLI extension via archive and resolves ExtensionActivationPlan', async () => {
    const extJson = {
      schemaVersion: 1,
      slug: 'calc-cli',
      name: 'Calculator CLI',
      description: 'Performs calculations via CLI',
      contributions: [
        {
          kind: 'cli',
          key: 'calc-cli',
          manifest: {
            name: 'Calculator CLI Tool',
            description: 'Computes arithmetic expression',
            command: 'node',
            script: 'calc.mjs',
            fixedArgs: ['--mode=eval'],
            timeoutMs: 5000,
          },
        },
      ],
    };

    const calcScript = `
console.log('Calculation result');
`;

    const archive = createTarGzArchive([
      { path: 'extension.json', content: JSON.stringify(extJson) },
      { path: 'calc.mjs', content: calcScript },
    ]);

    // Install to Alice Space
    const res = await fetch(`${baseUrl}/api/manage/extensions/install`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
        Cookie: aliceCookie,
      },
      body: JSON.stringify({
        sourceKind: 'archive',
        archiveBase64: archive.toString('base64'),
        archiveFilename: 'calc-cli.tar.gz',
        spaceId: aliceSpaceId,
      }),
    });

    expect(res.status).toBe(201);
    const detail = ((await res.json()) as any).data;
    expect(detail.slug).toBe('calc-cli');
    expect(detail.contributions[0].kind).toBe('cli');
    expect(detail.contributions[0].runtimeAdapterAvailable).toBe(true);

    // Resolve plan for Alice Space
    const plan = await server.extensionService.resolveForSpace(aliceUserId, aliceSpaceId);
    expect(plan).toBeDefined();
    expect(plan.cli).toHaveLength(1);
    expect(plan.cli![0].kind).toBe('cli');
    expect(plan.cli![0].contributionKey).toBe('calc-cli');
    expect(plan.cli![0].command).toBe('node');
    expect(plan.cli![0].script).toBe('calc.mjs');
    expect(plan.cli![0].artifactRelPath).toBe('.extensions/calc-cli/calc.mjs');
    expect(plan.cli![0].fixedArgs).toEqual(['--mode=eval']);

    const validated = validateExtensionActivationPlan(plan);
    expect(validated.cli).toHaveLength(1);

    // Disable binding
    const disableRes = await fetch(`${baseUrl}/api/manage/extensions/calc-cli/disable`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
        Cookie: aliceCookie,
      },
      body: JSON.stringify({ spaceId: aliceSpaceId }),
    });
    expect(disableRes.status).toBe(200);

    const planAfterDisable = await server.extensionService.resolveForSpace(aliceUserId, aliceSpaceId);
    expect(planAfterDisable.cli).toHaveLength(0);
  });

  it('rejects non-admin (Bob) from installing CLI extension with 403 Forbidden', async () => {
    const extJson = {
      schemaVersion: 1,
      slug: 'bob-cli',
      name: 'Bob CLI',
      contributions: [
        {
          kind: 'cli',
          key: 'bob-cli',
          manifest: {
            command: 'node',
            script: 'cli.mjs',
          },
        },
      ],
    };

    const archive = createTarGzArchive([
      { path: 'extension.json', content: JSON.stringify(extJson) },
      { path: 'cli.mjs', content: 'console.log("hi");' },
    ]);

    const res = await fetch(`${baseUrl}/api/manage/extensions/install`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
        Cookie: bobCookie,
      },
      body: JSON.stringify({
        sourceKind: 'archive',
        archiveBase64: archive.toString('base64'),
        archiveFilename: 'bob-cli.tar.gz',
        spaceId: bobSpaceId,
      }),
    });

    expect(res.status).toBe(403);
  });

  it('rejects non-node command or missing script with 400 Bad Request', async () => {
    // 1. Non-node command
    const nonNodeJson = {
      schemaVersion: 1,
      slug: 'sh-cli',
      name: 'Shell CLI',
      contributions: [
        {
          kind: 'cli',
          key: 'sh-cli',
          manifest: {
            command: 'bash',
            script: 'script.sh',
          },
        },
      ],
    };

    const nonNodeArchive = createTarGzArchive([
      { path: 'extension.json', content: JSON.stringify(nonNodeJson) },
      { path: 'script.sh', content: 'echo hello' },
    ]);

    const res1 = await fetch(`${baseUrl}/api/manage/extensions/install`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
        Cookie: aliceCookie,
      },
      body: JSON.stringify({
        sourceKind: 'archive',
        archiveBase64: nonNodeArchive.toString('base64'),
      }),
    });
    expect(res1.status).toBe(400);

    // 2. Missing script in archive
    const missingScriptJson = {
      schemaVersion: 1,
      slug: 'missing-cli',
      name: 'Missing CLI',
      contributions: [
        {
          kind: 'cli',
          key: 'missing-cli',
          manifest: {
            command: 'node',
            script: 'not-found.mjs',
          },
        },
      ],
    };

    const missingScriptArchive = createTarGzArchive([
      { path: 'extension.json', content: JSON.stringify(missingScriptJson) },
    ]);

    const res2 = await fetch(`${baseUrl}/api/manage/extensions/install`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
        Cookie: aliceCookie,
      },
      body: JSON.stringify({
        sourceKind: 'archive',
        archiveBase64: missingScriptArchive.toString('base64'),
      }),
    });
    expect(res2.status).toBe(400);
  });
});
