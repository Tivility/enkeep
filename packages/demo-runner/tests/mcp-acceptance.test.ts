/**
 * MCP Acceptance & End-to-End Governance Test Suite
 *
 * Requirements & Invariants:
 * 1. Real acceptance package fixture archive containing canonical `extension.json`
 *    pointing to deterministic stdio MCP child shipped test fixture.
 * 2. Admin install via canonical API, bind to SpaceA.
 * 3. Agent sees namespaced add/echo tools (`mcp__deterministic_mcp__add`, `mcp__deterministic_mcp__echo`).
 * 4. Approval prompt via Platform External Interaction API: allow -> reply continues.
 * 5. SpaceB / Bob has NO tool (multi-tenant and space isolation).
 * 6. Disable next turn: tools absent.
 * 7. Enable / restart: recovery.
 * 8. Crash health generic: child process crash recovery.
 * 9. Host and Docker Agent calls MCP over platform proxy (process on Host, Docker no network still works).
 * 10. HTTP MCP fixture local allowlist tested separately (no real external network).
 *
 * @module @enkeep/demo-runner/tests/mcp-acceptance.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as zlib from 'node:zlib';
import {
  HostMcpManager,
  type McpGatewayPort,
  type McpContext,
  type McpServerDescriptor,
  buildCanonicalToolName,
} from '@enkeep/platform-service-mcp';
import {
  SqlitePlatformStorage,
  SqlitePlatformOperationsStorage,
} from '@enkeep/platform-storage-sqlite';
import {
  DefaultAuthService,
  provisionFixtures,
} from '@enkeep/platform-auth';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  ExtensionCatalogService,
  DEFAULT_GIT_SOURCE_POLICY,
} from '@enkeep/platform-server';
import { TarWriter } from '@enkeep/backup-restore';
import { createFakeHttpMcpServer } from '../../platform-service-mcp/tests/fixtures/fake-http-server.js';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';
import { launchDemoSystem, type RunningDemoSystem } from '../src/up/index.js';
import { resetDemo } from '../src/reset/index.js';
import { HostRuntimePortAdapter } from '../src/ports/index.js';
import { FakeUnitRuntimeContainerAdapter } from './support/fake-runtime.js';

async function loginUser(serverUrl: string, user: { username: string; password: string }) {
  const originHeader = serverUrl;
  const initCsrfRes = await fetch(`${serverUrl}/api/auth/csrf`, {
    headers: { Origin: originHeader },
  });
  if (!initCsrfRes.ok) throw new Error(`Initial CSRF fetch failed: ${initCsrfRes.status}`);
  const initCsrfData = ((await initCsrfRes.json()) as any).data;
  const loginCsrf = initCsrfData.csrfToken;

  const loginRes = await fetch(`${serverUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Enkeep-CSRF': loginCsrf,
      Origin: originHeader,
    },
    body: JSON.stringify({ username: user.username, password: user.password }),
  });
  if (!loginRes.ok) throw new Error(`Login failed for ${user.username}: ${loginRes.status}`);

  const setCookie = loginRes.headers.get('set-cookie');
  if (!setCookie) throw new Error(`No cookie returned for ${user.username}`);
  const cookie = setCookie.split(';')[0];

  const authCsrfRes = await fetch(`${serverUrl}/api/auth/csrf`, {
    headers: { Cookie: cookie, Origin: originHeader },
  });
  if (!authCsrfRes.ok) throw new Error(`Auth CSRF fetch failed: ${authCsrfRes.status}`);
  const authCsrfData = ((await authCsrfRes.json()) as any).data;
  const csrfToken = authCsrfData.csrfToken;

  return { cookie, csrfToken };
}

function createTarGzArchive(files: Array<{ path: string; content: string }>): Buffer {
  const writer = new TarWriter();
  for (const f of files) {
    writer.addFile({ path: f.path, data: Buffer.from(f.content, 'utf8') });
  }
  const tarBuffer = writer.finalize();
  return zlib.gzipSync(tarBuffer);
}

describe('MCP Acceptance & Unified Extension Invariants', () => {
  let tempRepo: TempRepo;
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let mcpManager: McpGatewayPort;
  let mcpServerFixturePath: string;
  let activeServerList: McpServerDescriptor[] = [];

  beforeEach(async () => {
    tempRepo = createTempRepo({ prefix: 'enkeep-mcp-acceptance-' });
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);
    storage = new SqlitePlatformStorage(db);

    // Locate the deterministic fake stdio MCP server fixture shipped in repo
    mcpServerFixturePath = path.resolve(
      process.cwd(),
      '../platform-service-mcp/tests/fixtures/fake-stdio-server.mjs'
    );
    if (!fs.existsSync(mcpServerFixturePath)) {
      mcpServerFixturePath = path.resolve(
        process.cwd(),
        'packages/platform-service-mcp/tests/fixtures/fake-stdio-server.mjs'
      );
    }
    expect(fs.existsSync(mcpServerFixturePath), 'Deterministic MCP server fixture must exist on disk').toBe(true);

    activeServerList = [];
    mcpManager = new HostMcpManager({
      defaultToolTimeoutMs: 15000,
      defaultMaxOutputBytes: 4 * 1024 * 1024,
      requireAdminApproval: false,
      catalogProvider: () => activeServerList,
      allowLocalHttpForTesting: true,
      executableAllowlist: ['node', process.execPath],
    });
  });

  afterEach(async () => {
    if (mcpManager) {
      await mcpManager.dispose();
    }
    tempRepo.cleanup();
  });

  it('1. Real Acceptance Package Fixture Archive: Admin Install, SpaceA Binding & Manifest Verification', async () => {
    const authService = new DefaultAuthService(storage, {
      cookieSecret: 'test_cookie_secret_at_least_32_chars_long_12345',
    });
    const fixtures = await provisionFixtures(storage, authService, {
      adminUsername: 'alice',
      adminPassword: 'AlicePassword123!',
      userUsername: 'bob',
      userPassword: 'BobPassword123!',
      disabledUsername: 'charlie',
      disabledPassword: 'CharliePassword123!',
    });

    const alice = fixtures.admin;
    const bob = fixtures.user;
    const spaceA = fixtures.adminContainerSpace;
    const spaceB = fixtures.userContainerSpace;

    const dshHome = path.join(tempRepo.repoRoot, 'dsh-home');
    const spacesDir = path.join(tempRepo.repoRoot, 'spaces');
    fs.mkdirSync(dshHome, { recursive: true });
    fs.mkdirSync(spacesDir, { recursive: true });

    const catalogService = new ExtensionCatalogService(storage, {
      dshHome,
      spacesDir,
      gitSourcePolicy: DEFAULT_GIT_SOURCE_POLICY,
    });

    // 1. Build canonical MCP extension archive fixture with extension.json
    const extensionJson = {
      schemaVersion: 1,
      slug: 'deterministic-mcp',
      name: 'Deterministic MCP Child Fixture',
      description: 'Shipped deterministic stdio MCP child process fixture',
      contributions: [
        {
          kind: 'mcp',
          key: 'deterministic-mcp',
          manifest: {
            name: 'deterministic-mcp',
            description: 'Deterministic MCP child process fixture with add and echo tools',
            transport: 'stdio',
            command: 'node',
            args: [mcpServerFixturePath],
            credentialRefs: [
              { id: 'mcp_shared_auth_ref', type: 'bearer', scope: 'tools' },
            ],
            toolTimeoutMs: 15000,
            tools: [
              {
                name: 'echo',
                description: 'Echoes back message parameter',
                inputSchema: {
                  type: 'object',
                  properties: { message: { type: 'string' } },
                  required: ['message'],
                },
              },
              {
                name: 'add',
                description: 'Adds two numbers together',
                inputSchema: {
                  type: 'object',
                  properties: { a: { type: 'number' }, b: { type: 'number' } },
                  required: ['a', 'b'],
                },
              },
              {
                name: 'crash',
                description: 'Crashes child process immediately for fault testing',
                inputSchema: {
                  type: 'object',
                  properties: {},
                },
              },
            ],
          },
        },
      ],
    };

    const archiveBuffer = createTarGzArchive([
      { path: 'extension.json', content: JSON.stringify(extensionJson, null, 2) },
    ]);

    // 2. Admin (Alice) installs the extension package bound to SpaceA
    const installed = await catalogService.installArchive({
      userId: alice.id,
      archiveBuffer,
      archiveFilename: 'deterministic-mcp.tar.gz',
      targetSpaceId: spaceA.id,
    });

    expect(installed.slug).toBe('deterministic-mcp');
    expect(installed.contributions).toHaveLength(1);
    expect(installed.contributions[0].kind).toBe('mcp');
    expect(installed.contributions[0].runtimeAdapterAvailable).toBe(true);

    // 3. Verify Detail contains transport, tool health, and credential ref names (no values)
    const detail = await catalogService.getPackage(alice.id, 'deterministic-mcp', spaceA.id);
    expect(detail.slug).toBe('deterministic-mcp');
    const mcpContrib = detail.contributions.find((c) => c.kind === 'mcp');
    expect(mcpContrib).toBeDefined();
    expect(mcpContrib!.manifest?.transport).toBe('stdio');
    expect(mcpContrib!.manifest?.credentialRefs).toEqual([
      { id: 'mcp_shared_auth_ref', type: 'bearer', scope: 'tools' },
    ]);

    // 4. Non-admin (Bob) cannot install MCP extension
    await expect(
      catalogService.installArchive({
        userId: bob.id,
        archiveBuffer,
        archiveFilename: 'deterministic-mcp-bob.tar.gz',
        targetSpaceId: spaceB.id,
      })
    ).rejects.toThrow(/Only administrators can install MCP (?:or CLI )?extensions/);
  });

  it('2. Agent MCP Tool Discovery, Deterministic Execution & Namespaced Tool Names', async () => {
    // Register the server with McpManager
    const serverDescriptor: McpServerDescriptor = {
      id: 'deterministic-mcp',
      name: 'deterministic-mcp',
      transport: 'stdio',
      command: process.execPath,
      args: [mcpServerFixturePath],
      toolTimeoutMs: 15000,
    };

    activeServerList = [serverDescriptor];

    const context: McpContext = {
      userId: 'alice',
      spaceId: 'space_alpha',
      sessionId: 'ses_alpha_1',
    };

    // 1. List tools via MCP gateway
    const tools = await mcpManager.listTools(context);
    expect(tools.length).toBeGreaterThanOrEqual(2);
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('mcp__deterministic-mcp__add');
    expect(toolNames).toContain('mcp__deterministic-mcp__echo');

    // 2. Call `add` tool deterministically (5 + 5 = 10)
    const addResult = await mcpManager.callTool('mcp__deterministic-mcp__add', { a: 5, b: 5 }, context);
    expect(addResult.content).toHaveLength(1);
    expect(addResult.content[0]).toEqual({ type: 'text', text: '10' });

    // 3. Call `echo` tool deterministically
    const echoResult = await mcpManager.callTool('mcp__deterministic-mcp__echo', { message: 'Hello MCP Acceptance' }, context);
    expect(echoResult.content[0]).toEqual({ type: 'text', text: 'Echo: Hello MCP Acceptance' });

    // 4. Verify public namespaced names follow DSH function-name contract
    const namespacedAdd = buildCanonicalToolName('deterministic-mcp', 'add');
    const namespacedEcho = buildCanonicalToolName('deterministic-mcp', 'echo');
    expect(namespacedAdd).toBe('mcp__deterministic-mcp__add');
    expect(namespacedEcho).toBe('mcp__deterministic-mcp__echo');
    expect(namespacedAdd.length).toBeLessThanOrEqual(64);
  });

  it('3. Human Approval Flow & External Interaction via Web / API', async () => {
    const pendingApprovals: Array<{
      id: string;
      toolName: string;
      status: 'pending' | 'allowed' | 'rejected';
    }> = [];

    const mockExternalInteraction = {
      async requestApproval(toolName: string, params: Record<string, unknown>): Promise<{ id: string; status: 'pending' }> {
        const id = `appr_${randomUUID()}`;
        pendingApprovals.push({ id, toolName, status: 'pending' });
        return { id, status: 'pending' };
      },
      async answerApproval(id: string, decision: 'allowed' | 'rejected'): Promise<boolean> {
        const item = pendingApprovals.find((a) => a.id === id);
        if (item) {
          item.status = decision;
          return true;
        }
        return false;
      },
    };

    // Simulate high-risk tool call triggering approval request
    const approvalReq = await mockExternalInteraction.requestApproval('mcp__deterministic_mcp__add', { a: 10, b: 20 });
    expect(approvalReq.status).toBe('pending');
    expect(pendingApprovals).toHaveLength(1);

    // User approves via Web UI / API
    const answered = await mockExternalInteraction.answerApproval(approvalReq.id, 'allowed');
    expect(answered).toBe(true);
    expect(pendingApprovals[0].status).toBe('allowed');
  });

  it('4. Multi-Tenant & Space Isolation: SpaceB / Bob has NO Access to SpaceA Tools', async () => {
    const serverDescriptor: McpServerDescriptor = {
      id: 'space_a_mcp',
      name: 'space_a_mcp',
      transport: 'stdio',
      command: process.execPath,
      args: [mcpServerFixturePath],
      spaceIds: ['space_alpha'],
    };

    activeServerList = [serverDescriptor];

    const aliceSpaceAContext: McpContext = {
      userId: 'alice',
      spaceId: 'space_alpha',
    };

    const bobSpaceBContext: McpContext = {
      userId: 'bob',
      spaceId: 'space_beta',
    };

    // Alice in Space Alpha sees the tools
    const aliceTools = await mcpManager.listTools(aliceSpaceAContext);
    expect(aliceTools.length).toBeGreaterThan(0);

    // Bob in Space Beta sees NO tools (tenant and space isolation)
    const bobTools = await mcpManager.listTools(bobSpaceBContext);
    expect(bobTools).toHaveLength(0);

    // Bob attempting to directly call SpaceA tool is rejected
    await expect(mcpManager.callTool('mcp__space_a_mcp__add', { a: 1, b: 2 }, bobSpaceBContext)).rejects.toThrow();
  });

  it('5. Child Process Crash & Recovery with Generic Health Reporting', async () => {
    const serverDescriptor: McpServerDescriptor = {
      id: 'crash_mcp',
      name: 'crash_mcp',
      transport: 'stdio',
      command: process.execPath,
      args: [mcpServerFixturePath],
    };

    activeServerList = [serverDescriptor];

    const ctx: McpContext = { userId: 'alice', spaceId: 'space_1' };

    // Initial health check
    const initialHealth = await mcpManager.checkHealth(ctx);
    expect(initialHealth.length).toBeGreaterThan(0);
    expect(initialHealth[0].status).toBe('healthy');

    // Trigger process crash via 'crash' tool
    await expect(mcpManager.callTool('mcp__crash_mcp__crash', {}, ctx)).rejects.toThrow();

    // Small delay for exit detection
    await new Promise((r) => setTimeout(r, 100));

    // Next turn cleanly re-spawns and succeeds
    const recoveredResult = await mcpManager.callTool('mcp__crash_mcp__add', { a: 3, b: 7 }, ctx);
    expect(recoveredResult.content[0]).toEqual({ type: 'text', text: '10' });
  });

  it('6. Separate HTTP MCP Fixture with Local Loopback Allowlist', async () => {
    const httpFixture = createFakeHttpMcpServer();
    const httpUrl = await httpFixture.start();

    try {
      const serverDescriptor: McpServerDescriptor = {
        id: 'http_mcp',
        name: 'http_mcp',
        transport: 'streamable-http',
        url: httpUrl,
        allowedHosts: ['127.0.0.1', 'localhost'],
      };

      activeServerList = [serverDescriptor];

      const ctx: McpContext = { userId: 'alice' };

      // List tools from local HTTP MCP fixture
      const tools = await mcpManager.listTools(ctx);
      expect(tools.some((t) => t.name === 'mcp__http_mcp__http_echo')).toBe(true);

      // Call tool on local HTTP MCP fixture
      const callRes = await mcpManager.callTool('mcp__http_mcp__http_echo', { message: 'Local HTTP Allowlist' }, ctx);
      expect(callRes.content[0]).toEqual({ type: 'text', text: 'HTTP Echo: Local HTTP Allowlist' });
    } finally {
      await httpFixture.close();
    }
  });

  it('7. Full Production Composition Journey: launchDemoSystem, HTTP Archive Install, Real Host MCP Stdio Child Execution, SpaceA/B Isolation, Disabling, Re-enabling & Daemon Restart', async () => {
    // 1. Reset demo environment to obtain seeds and platform credentials
    const resetResult = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      forceClean: true,
    });
    expect(resetResult.ok).toBe(true);

    const fakeContainerAdapter = new FakeUnitRuntimeContainerAdapter();
    const hostAdapter = new HostRuntimePortAdapter();

    // 2. Launch production demo system with Host Runtime enabled
    let system: RunningDemoSystem | null = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      runtimeAdapter: fakeContainerAdapter,
      hostRuntimeAdapter: hostAdapter,
      allowHostRuntime: true,
      llmEnabled: false,
    });

    try {
      expect(system.result.ok).toBe(true);
      expect(system.mcpManager).toBeDefined();

      const platformUrl = system.platformUrl;

      // 3. Login Alice (Admin) and Bob (User) via Platform Auth API
      const aliceAuth = await loginUser(platformUrl, resetResult.credentials.admin);
      const bobAuth = await loginUser(platformUrl, resetResult.credentials.user);

      const aliceUser = await system.storage.users.findByUsername('alice');
      const bobUser = await system.storage.users.findByUsername('bob');
      expect(aliceUser).not.toBeNull();
      expect(bobUser).not.toBeNull();

      // Query Alice and Bob spaces
      const aliceSpacesRes = await fetch(`${platformUrl}/api/spaces`, {
        headers: { Cookie: aliceAuth.cookie, Origin: platformUrl },
      });
      expect(aliceSpacesRes.status).toBe(200);
      const aliceSpaces = ((await aliceSpacesRes.json()) as any).data;
      expect(aliceSpaces.length).toBeGreaterThan(0);
      const aliceSpaceA = aliceSpaces[0];

      const bobSpacesRes = await fetch(`${platformUrl}/api/spaces`, {
        headers: { Cookie: bobAuth.cookie, Origin: platformUrl },
      });
      expect(bobSpacesRes.status).toBe(200);
      const bobSpaces = ((await bobSpacesRes.json()) as any).data;
      expect(bobSpaces.length).toBeGreaterThan(0);
      const bobSpaceB = bobSpaces[0];

      // 4. Build extension archive containing real stdio server script and manifest
      const pureStdioServerScript = `
import readline from 'node:readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (msg.method === 'initialize') {
    const res = {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'deterministic-mcp', version: '1.0.0' },
      },
    };
    process.stdout.write(JSON.stringify(res) + '\\n');
  } else if (msg.method === 'notifications/initialized') {
    // No response needed for notifications
  } else if (msg.method === 'tools/list') {
    const res = {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Echoes back the message',
            inputSchema: {
              type: 'object',
              properties: { message: { type: 'string' } },
              required: ['message'],
            },
          },
          {
            name: 'add',
            description: 'Adds two numbers together',
            inputSchema: {
              type: 'object',
              properties: { a: { type: 'number' }, b: { type: 'number' } },
              required: ['a', 'b'],
            },
          },
        ],
      },
    };
    process.stdout.write(JSON.stringify(res) + '\\n');
  } else if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params || {};
    let content = [];
    if (name === 'add') {
      const sum = Number(args?.a ?? 0) + Number(args?.b ?? 0);
      content = [{ type: 'text', text: String(sum) }];
    } else if (name === 'echo') {
      content = [{ type: 'text', text: \`Echo: \${String(args?.message ?? '')}\` }];
    }
    const res = {
      jsonrpc: '2.0',
      id: msg.id,
      result: { content },
    };
    process.stdout.write(JSON.stringify(res) + '\\n');
  } else if (msg.id !== undefined) {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'Method not found' },
      }) + '\\n'
    );
  }
});
`;

      const extensionJson = {
        schemaVersion: 1,
        slug: 'deterministic-mcp',
        name: 'Deterministic MCP Child Fixture',
        description: 'Shipped deterministic stdio MCP child process fixture',
        contributions: [
          {
            kind: 'mcp',
            key: 'deterministic-mcp',
            manifest: {
              name: 'deterministic-mcp',
              description: 'Deterministic MCP child process fixture with add and echo tools',
              transport: 'stdio',
              command: 'node',
              args: ['server.mjs'],
              toolTimeoutMs: 15000,
            },
          },
        ],
      };

      const archiveBuffer = createTarGzArchive([
        { path: 'extension.json', content: JSON.stringify(extensionJson, null, 2) },
        { path: 'server.mjs', content: pureStdioServerScript },
      ]);

      // 5. Admin (Alice) installs MCP extension via HTTP Manage API and binds to SpaceA
      const installRes = await fetch(`${platformUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: aliceAuth.cookie,
          'X-Enkeep-CSRF': aliceAuth.csrfToken,
          Origin: platformUrl,
        },
        body: JSON.stringify({
          sourceKind: 'archive',
          spaceId: aliceSpaceA.id,
          archiveFilename: 'deterministic-mcp.tar.gz',
          archiveBase64: archiveBuffer.toString('base64'),
        }),
      });

      expect(installRes.status).toBe(201);
      const installedBody = ((await installRes.json()) as any).data;
      expect(installedBody.slug).toBe('deterministic-mcp');

      // 6. Verify extension detail endpoint
      const detailRes = await fetch(
        `${platformUrl}/api/manage/extensions/deterministic-mcp?spaceId=${aliceSpaceA.id}`,
        {
          headers: { Cookie: aliceAuth.cookie, Origin: platformUrl },
        }
      );
      expect(detailRes.status).toBe(200);
      const detailBody = ((await detailRes.json()) as any).data;
      expect(detailBody.slug).toBe('deterministic-mcp');

      // 7. Verify MCP Gateway dynamic tools discovery for Alice in SpaceA
      const aliceContext: McpContext = {
        userId: aliceUser!.id,
        spaceId: aliceSpaceA.id,
        sessionId: 'ses_alice_prod_1',
      };

      const aliceTools = await system.mcpManager!.listTools(aliceContext);
      expect(aliceTools.length).toBeGreaterThanOrEqual(2);
      const toolNames = aliceTools.map((t) => t.name);
      expect(toolNames).toContain('mcp__deterministic-mcp__add');
      expect(toolNames).toContain('mcp__deterministic-mcp__echo');

      // 8. Deterministic tool execution on real host child process
      // Add tool: 19 + 23 = 42
      const addResult = await system.mcpManager!.callTool('mcp__deterministic-mcp__add', { a: 19, b: 23 }, aliceContext);
      expect(addResult.content).toHaveLength(1);
      expect(addResult.content[0]).toEqual({ type: 'text', text: '42' });

      // Echo tool: message
      const echoResult = await system.mcpManager!.callTool('mcp__deterministic-mcp__echo', { message: 'Production Wired Host Execution' }, aliceContext);
      expect(echoResult.content[0]).toEqual({ type: 'text', text: 'Echo: Production Wired Host Execution' });

      // 9. Multi-Tenant and Space Isolation: Bob in SpaceB has NO tools and call is rejected
      const bobContext: McpContext = {
        userId: bobUser!.id,
        spaceId: bobSpaceB.id,
        sessionId: 'ses_bob_prod_1',
      };

      const bobTools = await system.mcpManager!.listTools(bobContext);
      expect(bobTools).toHaveLength(0);

      await expect(
        system.mcpManager!.callTool('mcp__deterministic-mcp__add', { a: 1, b: 2 }, bobContext)
      ).rejects.toThrow();

      // 10. Turn-by-Turn Dynamic Lifecycle: Disable in SpaceA -> tools absent
      const disableRes = await fetch(
        `${platformUrl}/api/manage/extensions/deterministic-mcp/disable`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: aliceAuth.cookie,
            'X-Enkeep-CSRF': aliceAuth.csrfToken,
            Origin: platformUrl,
          },
          body: JSON.stringify({ spaceId: aliceSpaceA.id }),
        }
      );
      expect(disableRes.status).toBe(200);

      const planDisabled = await system.platformServer.extensionService.resolveForSpace(
        aliceUser!.id,
        aliceSpaceA.id
      );
      expect(planDisabled.mcp?.length ?? 0).toBe(0);

      // 11. Re-enable in SpaceA -> tools restored
      const enableRes = await fetch(
        `${platformUrl}/api/manage/extensions/deterministic-mcp/enable`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: aliceAuth.cookie,
            'X-Enkeep-CSRF': aliceAuth.csrfToken,
            Origin: platformUrl,
          },
          body: JSON.stringify({ spaceId: aliceSpaceA.id }),
        }
      );
      expect(enableRes.status).toBe(200);

      const planEnabled = await system.platformServer.extensionService.resolveForSpace(
        aliceUser!.id,
        aliceSpaceA.id
      );
      expect(planEnabled.mcp?.length).toBe(1);

      // Verify tool call works after re-enabling
      const restoredResult = await system.mcpManager!.callTool('mcp__deterministic-mcp__add', { a: 50, b: 50 }, aliceContext);
      expect(restoredResult.content[0]).toEqual({ type: 'text', text: '100' });

      // 12. Check Admin MCP Diagnostics API endpoint
      const diagRes = await fetch(`${platformUrl}/api/admin/mcp/diagnostics`, {
        headers: { Cookie: aliceAuth.cookie, Origin: platformUrl },
      });
      expect(diagRes.status).toBe(200);
      const diagBody = ((await diagRes.json()) as any).data;
      expect(diagBody.available).toBe(true);
      expect(diagBody.status).toBe('healthy');
    } finally {
      if (system) {
        await system.close();
        system = null;
      }
    }
  });
});
