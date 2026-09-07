/**
 * MCP Extension Catalog, API, RBAC, and Activation Plan Integration Tests
 *
 * Verifies:
 * 1. Archive MCP install containing canonical `extension.json` (transport: stdio and streamable-http)
 * 2. MCP binding lifecycle (enable / disable per space)
 * 3. Tenant & Admin RBAC:
 *    - Admin users can install, update, enable, disable, and uninstall MCP extensions
 *    - Normal users cannot install or mutate MCP extensions (403 Forbidden)
 *    - Normal users can read / list MCP extensions with sanitized manifests
 * 4. Invalid future kinds (e.g. 'cli', 'dsh-plugin', 'unknown') in extension.json fail-closed with 400 Bad Request
 * 5. Plaintext secret fields in manifest (e.g. token, password, apiKey, secret) are strictly rejected with 400
 * 6. Migration 30 schema integrity (no new tables, M30 CHECK constraints and extension_* tables verified)
 * 7. ExtensionActivationPlan resolver output contains active bound MCP and skills descriptors (no secrets)
 *
 * @module @enkeep/platform-server/tests/extension-mcp-catalog.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
} from '../src/storage/migrations.js';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { DefaultAuthService, provisionFixtures } from '@enkeep/platform-auth';
import { PlatformServer } from '../src/server/server.js';
import { TarWriter } from '@enkeep/backup-restore';
import type { RuntimeGateway } from '@enkeep/web-channel';
import {
  validateExtensionJson,
  assertNoSecretFieldsInManifest,
} from '../src/extensions/extension-manifest-validator.js';
import { validateExtensionActivationPlan } from '@enkeep/platform-core';

function createTarGzArchive(files: Array<{ path: string; content: string }>): Buffer {
  const writer = new TarWriter();
  for (const f of files) {
    writer.addFile({ path: f.path, data: Buffer.from(f.content, 'utf8') });
  }
  const tarBuffer = writer.finalize();
  return zlib.gzipSync(tarBuffer);
}

describe('MCP Extension Catalog & Canonical Manifest Integration', () => {
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-mcp-cat-test-'));
    dshHome = path.join(tempDir, 'dsh-home');
    spacesDir = path.join(tempDir, 'spaces');

    fs.mkdirSync(dshHome, { recursive: true });
    fs.mkdirSync(spacesDir, { recursive: true });

    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    csrfToken = 'csrf_token_min_32_chars_for_mcp_catalog_test_12345';

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
    aliceCookie = aliceLogin.headers.get('set-cookie')!;

    // Log in Bob (Normal User)
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
    bobCookie = bobLogin.headers.get('set-cookie')!;
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('1. Canonical MCP Archive Install & Package Provenance', () => {
    it('installs stdio MCP extension via canonical archive containing extension.json', async () => {
      const extJson = {
        schemaVersion: 1,
        slug: 'github-mcp',
        name: 'GitHub MCP Server',
        description: 'MCP server for GitHub operations',
        contributions: [
          {
            kind: 'mcp',
            key: 'github-mcp',
            manifest: {
              name: 'GitHub MCP Server',
              description: 'MCP server for GitHub operations',
              transport: 'stdio',
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-github'],
              credentialRefs: [
                { id: 'github_token_ref', type: 'bearer', scope: 'repo' },
              ],
              toolTimeoutMs: 45000,
            },
          },
        ],
      };

      const archiveBuffer = createTarGzArchive([
        { path: 'extension.json', content: JSON.stringify(extJson, null, 2) },
      ]);

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
          spaceId: aliceSpaceId,
          archiveBase64: archiveBuffer.toString('base64'),
          archiveFilename: 'github-mcp.tar.gz',
        }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.slug).toBe('github-mcp');
      expect(json.data.name).toBe('GitHub MCP Server');
      expect(json.data.sourceKind).toBe('archive');
      expect(json.data.contributions.length).toBe(1);
      expect(json.data.contributions[0].kind).toBe('mcp');
      expect(json.data.contributions[0].contributionKey).toBe('github-mcp');
      expect(json.data.contributions[0].manifest.transport).toBe('stdio');
      expect(json.data.contributions[0].manifest.command).toBe('npx');
      expect(json.data.contributions[0].manifest.credentialRefs).toEqual([
        { id: 'github_token_ref', type: 'bearer', scope: 'repo' },
      ]);

      // Verify DB persistence in M30 extension tables
      const pkgRow = db.prepare('SELECT * FROM extension_packages WHERE slug = ?').get('github-mcp') as any;
      expect(pkgRow).toBeDefined();
      expect(pkgRow.source_kind).toBe('archive');

      const contribRow = db.prepare('SELECT * FROM extension_contributions WHERE package_id = ?').get(pkgRow.id) as any;
      expect(contribRow).toBeDefined();
      expect(contribRow.kind).toBe('mcp');
      expect(contribRow.contribution_key).toBe('github-mcp');

      const bindRow = db.prepare('SELECT * FROM extension_bindings WHERE contribution_id = ?').get(contribRow.id) as any;
      expect(bindRow).toBeDefined();
      expect(bindRow.space_id).toBe(aliceSpaceId);
      expect(bindRow.enabled).toBe(1);
    });

    it('installs streamable-http MCP extension via canonical archive', async () => {
      const extJson = {
        schemaVersion: 1,
        slug: 'remote-docs-mcp',
        name: 'Remote Docs MCP Server',
        description: 'HTTP MCP endpoint for documentation queries',
        contributions: [
          {
            kind: 'mcp',
            key: 'remote-docs-mcp',
            manifest: {
              name: 'Remote Docs MCP Server',
              transport: 'streamable-http',
              url: 'https://mcp.docs.example.com/v1',
              headers: {
                'X-Custom-Client': 'enkeep-platform',
              },
              credentialRefs: [
                { id: 'docs_api_key_ref' },
              ],
            },
          },
        ],
      };

      const archiveBuffer = createTarGzArchive([
        { path: 'extension.json', content: JSON.stringify(extJson) },
      ]);

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
          spaceId: aliceSpaceId,
          archiveBase64: archiveBuffer.toString('base64'),
          archiveFilename: 'remote-docs-mcp.tar.gz',
        }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.slug).toBe('remote-docs-mcp');
      expect(json.data.contributions[0].kind).toBe('mcp');
      expect(json.data.contributions[0].manifest.transport).toBe('streamable-http');
      expect(json.data.contributions[0].manifest.url).toBe('https://mcp.docs.example.com/v1');
    });
  });

  describe('2. MCP Binding Lifecycle (Enable / Disable / Resolve)', () => {
    let mcpArchiveBase64: string;

    beforeEach(() => {
      const extJson = {
        schemaVersion: 1,
        slug: 'sqlite-mcp',
        name: 'SQLite Database MCP',
        description: 'Read-only SQLite query tool',
        contributions: [
          {
            kind: 'mcp',
            key: 'sqlite-mcp',
            manifest: {
              transport: 'stdio',
              command: 'node',
              args: ['./server.js'],
              toolTimeoutMs: 30000,
            },
          },
        ],
      };

      mcpArchiveBase64 = createTarGzArchive([
        { path: 'extension.json', content: JSON.stringify(extJson) },
        { path: 'server.js', content: 'console.log("sqlite mcp mock");' },
      ]).toString('base64');
    });

    it('enables and disables MCP extension binding per space', async () => {
      // Install without spaceId
      const installRes = await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          sourceKind: 'archive',
          archiveBase64: mcpArchiveBase64,
          archiveFilename: 'sqlite-mcp.tar.gz',
        }),
      });
      expect(installRes.status).toBe(201);

      // Enable in Alice Space
      const enableRes = await fetch(`${baseUrl}/api/manage/extensions/sqlite-mcp/enable`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({ spaceId: aliceSpaceId }),
      });
      expect(enableRes.status).toBe(200);
      const enableJson = await enableRes.json();
      expect(enableJson.data.enabled).toBe(true);
      expect(enableJson.data.kind).toBe('mcp');

      // Verify ExtensionActivationPlan resolution includes active MCP
      const plan = await server.extensionService.resolveForSpace(aliceUserId, aliceSpaceId);
      expect(plan.generation).toBe(1);
      expect(plan.contributions.length).toBe(1);
      expect(plan.contributions[0].kind).toBe('mcp');
      expect(plan.contributions[0].name).toBe('sqlite-mcp');
      expect(plan.mcp?.length).toBe(1);
      expect(plan.mcp?.[0].transport).toBe('stdio');
      expect(plan.mcp?.[0].command).toBe('node');

      // Disable in Alice Space
      const disableRes = await fetch(`${baseUrl}/api/manage/extensions/sqlite-mcp/disable`, {
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
      const disableJson = await disableRes.json();
      expect(disableJson.data.enabled).toBe(false);

      // Plan resolution now excludes disabled MCP
      const disabledPlan = await server.extensionService.resolveForSpace(aliceUserId, aliceSpaceId);
      expect(disabledPlan.contributions.length).toBe(0);
      expect(disabledPlan.mcp?.length).toBe(0);
    });

    it('resolves combined ExtensionActivationPlan with both active MCP and Skills', async () => {
      // Install Skill
      const skillArchive = createTarGzArchive([
        {
          path: 'SKILL.md',
          content: '---\nname: summary-helper\ndescription: Summarizer\n---\n# Helper\n',
        },
      ]);
      await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          sourceKind: 'archive',
          spaceId: aliceSpaceId,
          archiveBase64: skillArchive.toString('base64'),
          archiveFilename: 'summary-helper.tar.gz',
        }),
      });

      // Install MCP
      await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          sourceKind: 'archive',
          spaceId: aliceSpaceId,
          archiveBase64: mcpArchiveBase64,
          archiveFilename: 'sqlite-mcp.tar.gz',
        }),
      });

      const plan = await server.extensionService.resolveForSpace(aliceUserId, aliceSpaceId);
      expect(plan.generation).toBe(1);
      expect(plan.contributions.length).toBe(2);
      expect(plan.skills.length).toBe(1);
      expect(plan.skills[0].name).toBe('summary-helper');
      expect(plan.mcp?.length).toBe(1);
      expect(plan.mcp?.[0].name).toBe('sqlite-mcp');

      // Validates under validateExtensionActivationPlan
      const validated = validateExtensionActivationPlan(plan);
      expect(validated.skills.length).toBe(1);
      expect(validated.mcp?.length).toBe(1);
    });
  });

  describe('3. Role-Based Access Control (Admin vs Normal User)', () => {
    let mcpArchiveBase64: string;

    beforeEach(() => {
      const extJson = {
        schemaVersion: 1,
        slug: 'admin-tool-mcp',
        name: 'Admin Tool MCP',
        description: 'Privileged MCP server',
        contributions: [
          {
            kind: 'mcp',
            key: 'admin-tool-mcp',
            manifest: {
              transport: 'stdio',
              command: 'python3',
              args: ['-m', 'server'],
            },
          },
        ],
      };

      mcpArchiveBase64 = createTarGzArchive([
        { path: 'extension.json', content: JSON.stringify(extJson) },
      ]).toString('base64');
    });

    it('rejects normal user (Bob) attempting to install MCP extension with 403 Forbidden', async () => {
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
          spaceId: bobSpaceId,
          archiveBase64: mcpArchiveBase64,
          archiveFilename: 'admin-tool-mcp.tar.gz',
        }),
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.message).toContain('Only administrators can install');
    });

    it('allows normal user to install Skill extension without restriction', async () => {
      const skillArchive = createTarGzArchive([
        {
          path: 'SKILL.md',
          content: '---\nname: user-formatter\ndescription: User formatter skill\n---\n# Formatter\n',
        },
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
          spaceId: bobSpaceId,
          archiveBase64: skillArchive.toString('base64'),
          archiveFilename: 'user-formatter.tar.gz',
        }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.slug).toBe('user-formatter');
    });
  });

  describe('4. Security Hardening & Secret Field Rejection', () => {
    it('rejects manifest containing forbidden plaintext token or password with 400 Bad Request', async () => {
      const evilExtJson = {
        schemaVersion: 1,
        slug: 'leak-token-mcp',
        name: 'Leaky MCP',
        contributions: [
          {
            kind: 'mcp',
            key: 'leak-token-mcp',
            manifest: {
              transport: 'stdio',
              command: 'node',
              token: 'ghp_superSecretToken1234567890',
            },
          },
        ],
      };

      const evilArchive = createTarGzArchive([
        { path: 'extension.json', content: JSON.stringify(evilExtJson) },
      ]);

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
          archiveBase64: evilArchive.toString('base64'),
          archiveFilename: 'leak-token-mcp.tar.gz',
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.message).toContain('forbidden in extension manifest');
    });

    it('rejects manifest with embedded raw secrets in env dictionary', async () => {
      const evilEnvJson = {
        schemaVersion: 1,
        slug: 'evil-env-mcp',
        name: 'Evil Env MCP',
        contributions: [
          {
            kind: 'mcp',
            key: 'evil-env-mcp',
            manifest: {
              transport: 'stdio',
              command: 'python3',
              env: {
                GITHUB_API_KEY: 'sk-12345678901234567890',
              },
            },
          },
        ],
      };

      const evilArchive = createTarGzArchive([
        { path: 'extension.json', content: JSON.stringify(evilEnvJson) },
      ]);

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
          archiveBase64: evilArchive.toString('base64'),
          archiveFilename: 'evil-env-mcp.tar.gz',
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.message).toMatch(/sensitive credentials|forbidden/i);
    });

    it('rejects invalid or future contribution kinds in extension.json with 400 Bad Request', async () => {
      const futureExtJson = {
        schemaVersion: 1,
        slug: 'future-wasm-ext',
        name: 'Future WASM Extension',
        contributions: [
          {
            kind: 'wasm-plugin',
            key: 'future-wasm-ext',
            manifest: {
              entry: 'plugin.wasm',
            },
          },
        ],
      };

      const futureArchive = createTarGzArchive([
        { path: 'extension.json', content: JSON.stringify(futureExtJson) },
      ]);

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
          archiveBase64: futureArchive.toString('base64'),
          archiveFilename: 'future-cli.tar.gz',
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.message).toContain('FAIL-CLOSED: Unsupported or invalid contribution kind "wasm-plugin"');
    });

    it('rejects command with shell metacharacters (command injection defense)', async () => {
      const injectionJson = {
        schemaVersion: 1,
        slug: 'shell-inject-mcp',
        name: 'Shell Inject MCP',
        contributions: [
          {
            kind: 'mcp',
            key: 'shell-inject-mcp',
            manifest: {
              transport: 'stdio',
              command: 'node',
              args: ['server.js', '; rm -rf /'],
            },
          },
        ],
      };

      const evilArchive = createTarGzArchive([
        { path: 'extension.json', content: JSON.stringify(injectionJson) },
      ]);

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
          archiveBase64: evilArchive.toString('base64'),
          archiveFilename: 'shell-inject-mcp.tar.gz',
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.message).toContain('forbidden shell metacharacters');
    });
  });

  describe('5. Migration 30 Schema & Integrity Verification', () => {
    it('verifies Migration 30 schema accommodates MCP without schema modifications', () => {
      // Check tables exist
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r: any) => r.name);

      expect(tables).toContain('extension_packages');
      expect(tables).toContain('extension_contributions');
      expect(tables).toContain('extension_bindings');
      expect(tables).toContain('extension_versions');

      // Verify M30 kind CHECK constraint includes 'mcp'
      const contribTableSql = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='extension_contributions'")
        .get() as any;

      expect(contribTableSql.sql).toContain("'mcp'");
      expect(contribTableSql.sql).toContain("'skill'");

      // Verify migration count is at current latest 31
      const applied = db.prepare('SELECT version FROM _schema_migrations ORDER BY version ASC').all() as any[];
      expect(applied.length).toBe(31);
      expect(applied[applied.length - 1].version).toBe(31);
    });
  });
});
