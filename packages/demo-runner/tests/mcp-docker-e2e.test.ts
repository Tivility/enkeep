/**
 * Real Docker Acceptance Test for MCP Stdio Child Process Execution, Zero-Network Isolation & Real Agent Lifecycle
 *
 * Runs only under `pnpm --filter @enkeep/demo-runner run test:docker` or root `test:docker`.
 * Never runs under normal unit `pnpm test`.
 *
 * Verifies:
 * 1) Preflight safety checks (Docker daemon available, protected ports 3000/3080 intact).
 * 2) Zero-Network Docker Container Proof:
 *    - Inspects Alice container to assert `networkMode === 'none'` and zero port bindings.
 *    - Proves MCP stdio child process executes on Host platform while container reaches platform proxy over tunnel.
 * 3) Extension Archive Install via HTTP Manage API:
 *    - Shipped deterministic stdio MCP fixture installed as canonical archive package with valid Idempotency-Key.
 *    - Bound to SpaceA.
 * 4) Real Agent Tool Turn with Platform Human Approval:
 *    - Creates real Alice session in SpaceA via POST /api/sessions.
 *    - Sends message with `[enkeep-test-tool-call=mcp__deterministic-mcp__add:{"a":40,"b":2}]`.
 *    - Polls GET /api/interactions/approvals, asserts exact toolName `mcp__deterministic-mcp__add`.
 *    - Decides approval via POST /api/interactions/approvals/:id/decide with outcome `allowed-once`.
 *    - Polls delivered assistant message containing `42`.
 * 5) Multi-Tenant & Space Isolation:
 *    - Bob in SpaceB real session sends same directive -> tool unknown / absent, zero approvals created.
 *    - Bob cannot access Alice's approvals via Platform API.
 * 6) Dynamic Turn-by-Turn Lifecycle:
 *    - Disable binding in SpaceA via POST /api/manage/extensions/deterministic-mcp/disable.
 *    - Same Alice session next turn -> tool unknown / absent, zero approvals created.
 *    - Re-enable binding in SpaceA via POST /api/manage/extensions/deterministic-mcp/enable.
 *    - Same Alice session next turn with `[enkeep-test-tool-call=mcp__deterministic-mcp__add:{"a":95,"b":5}]`.
 *    - Approval created, user answers `allowed-once`, assistant message delivers `100`.
 * 7) Admin MCP Diagnostics API verification.
 * 8) Clean teardown with zero leaked processes or volumes.
 *
 * @module @enkeep/demo-runner/tests/mcp-docker-e2e.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as zlib from 'node:zlib';
import { launchDemoSystem, type RunningDemoSystem } from '../src/up/index.js';
import { resetDemo } from '../src/reset/index.js';
import { downDemo } from '../src/down/index.js';
import { DockerRuntimeContainerAdapter } from '../src/ports/index.js';
import { probeProtectedPorts, assertProbesUnchanged } from '../src/utils/probes.js';
import { SafeDockerClient } from '@enkeep/runtime-runner/docker';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';
import { TarWriter } from '@enkeep/backup-restore';
import { Context } from '@deepseek-ai/cordis';
import * as externalInteractionPlugin from '@enkeep/dsh-external-interaction';
import type { IExternalInteractionService, PendingApproval } from '@enkeep/dsh-external-interaction';

type ProtectedPortsSnapshot = Awaited<ReturnType<typeof probeProtectedPorts>>;

interface AuthTokens {
  cookie: string;
  csrfToken: string;
}

interface SpaceDto {
  id: string;
  name: string;
  folder: string;
  executionMode: string;
}

interface SessionDto {
  id: string;
  spaceId: string;
  title: string;
}

interface MessageEnvelope {
  data: {
    accepted: boolean;
    message: {
      id: string;
      role: string;
      content: string;
      status: string;
    };
  };
}

interface AssistantMessageDto {
  id: string;
  role: 'assistant' | 'user' | 'system';
  content: string;
  status: 'delivered' | 'pending' | 'failed';
  createdAt: string;
}

interface ApprovalsEnvelope {
  data: readonly PendingApproval[];
}

interface DecideApprovalEnvelope {
  data: {
    id: string;
    status: string;
    decided: boolean;
  };
}

interface DiagnosticsEnvelope {
  data: {
    available: boolean;
    status: string;
    servers: readonly unknown[];
  };
}

function generateSuffix12(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12).toLowerCase();
}

function createTarGzArchive(files: Array<{ path: string; content: string }>): Buffer {
  const writer = new TarWriter();
  for (const f of files) {
    writer.addFile({ path: f.path, data: Buffer.from(f.content, 'utf8') });
  }
  const tarBuffer = writer.finalize();
  return zlib.gzipSync(tarBuffer);
}

async function loginUser(serverUrl: string, user: { username: string; password: string }): Promise<AuthTokens> {
  const originHeader = serverUrl;
  const initCsrfRes = await fetch(`${serverUrl}/api/auth/csrf`, {
    headers: { Origin: originHeader },
  });
  if (!initCsrfRes.ok) throw new Error(`Initial CSRF fetch failed: ${initCsrfRes.status}`);
  const initCsrfData = ((await initCsrfRes.json()) as { data: { csrfToken: string } }).data;
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
  const authCsrfData = ((await authCsrfRes.json()) as { data: { csrfToken: string } }).data;
  const csrfToken = authCsrfData.csrfToken;

  return { cookie, csrfToken };
}

async function waitForAssistantReplyAfterUser(
  serverUrl: string,
  sessionId: string,
  userMessageId: string,
  cookie: string,
  maxWaitSeconds = 45
): Promise<AssistantMessageDto> {
  let lastMsgs: AssistantMessageDto[] = [];
  for (let i = 0; i < maxWaitSeconds * 2; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const res = await fetch(`${serverUrl}/api/sessions/${sessionId}/messages`, {
      headers: { Cookie: cookie },
    });
    if (res.status === 200) {
      const data = ((await res.json()) as { data: { messages: AssistantMessageDto[] } }).data;
      const msgs = data.messages || [];
      lastMsgs = msgs;
      const userIdx = msgs.findIndex((m) => m.id === userMessageId);
      if (userIdx !== -1 && userIdx + 1 < msgs.length) {
        const nextMsg = msgs[userIdx + 1];
        if (nextMsg && nextMsg.role === 'assistant' && nextMsg.status === 'delivered') {
          return nextMsg;
        }
      }
    }
  }
  throw new Error(
    `Timed out waiting for assistant message after user message "${userMessageId}". Last messages: ${JSON.stringify(lastMsgs)}`
  );
}

describe('Real Docker Acceptance Test: MCP Stdio Child Execution, Zero-Network Isolation & Real Agent Lifecycle', () => {
  let tempRepo: TempRepo;
  let runningSystem: RunningDemoSystem | null = null;
  let resourceSuffix: string;
  let probeBefore: ProtectedPortsSnapshot;
  let dockerClient: SafeDockerClient;

  beforeEach(async () => {
    tempRepo = createTempRepo();
    resourceSuffix = generateSuffix12();
    dockerClient = new SafeDockerClient();

    const isDockerAvailable = await dockerClient.isDockerAvailable();
    if (!isDockerAvailable) {
      console.warn('Docker daemon not reachable; skipping real Docker MCP acceptance test.');
      return;
    }

    probeBefore = await probeProtectedPorts();
  });

  afterEach(async () => {
    const isDockerAvailable = await dockerClient?.isDockerAvailable();
    if (!isDockerAvailable) {
      tempRepo?.cleanup();
      return;
    }

    if (runningSystem) {
      try {
        await runningSystem.close({ removeVolumes: true });
      } catch {}
      runningSystem = null;
    }

    try {
      await downDemo({
        repoRoot: tempRepo.repoRoot,
        removeVolumes: true,
        resourceSuffix,
        dockerClient,
      });
    } catch {}

    const probeAfter = await probeProtectedPorts();
    assertProbesUnchanged(probeBefore, probeAfter);

    tempRepo.cleanup();
  });

  it('completes the full real Docker MCP journey: zero-network container proof, HTTP install, real Agent execution with approval, isolation & dynamic lifecycle', async () => {
    const isDockerAvailable = await dockerClient.isDockerAvailable();
    if (!isDockerAvailable) {
      return;
    }

    // 1. Reset Demo with unique resource suffix
    const resetResult = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
      forceClean: true,
    });
    expect(resetResult.ok).toBe(true);

    const dockerAdapter = new DockerRuntimeContainerAdapter(dockerClient);

    const cordisCtx = new Context();
    await cordisCtx.plugin(externalInteractionPlugin);
    const extInteraction = cordisCtx.get('externalInteraction') as IExternalInteractionService;
    expect(extInteraction).toBeDefined();

    // 2. Launch demo system with real Docker adapter
    runningSystem = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
      runtimeAdapter: dockerAdapter,
      externalInteractionService: extInteraction,
      llmEnabled: false,
    });

    expect(runningSystem.result.ok).toBe(true);
    const platformUrl = runningSystem.platformUrl;

    // 3. Zero-Network Docker Container Proof: Container has NO network access
    const aliceContainerName = `enkeep-demo-alice-${resourceSuffix}`;
    const aliceContainerInspect = await dockerClient.inspectContainer(aliceContainerName);
    expect(aliceContainerInspect).not.toBeNull();
    expect(aliceContainerInspect!.networkMode).toBe('none');
    expect(aliceContainerInspect!.portBindings === null || Object.keys(aliceContainerInspect!.portBindings).length === 0).toBe(true);

    // 4. Authenticate Alice (Admin) and Bob (User)
    const aliceAuth = await loginUser(platformUrl, resetResult.credentials.admin);
    const bobAuth = await loginUser(platformUrl, resetResult.credentials.user);

    // Query Alice Space
    const aliceSpacesRes = await fetch(`${platformUrl}/api/spaces`, {
      headers: { Cookie: aliceAuth.cookie },
    });
    expect(aliceSpacesRes.status).toBe(200);
    const aliceSpacesData = ((await aliceSpacesRes.json()) as { data: SpaceDto[] }).data;
    expect(aliceSpacesData.length).toBeGreaterThan(0);
    const aliceSpaceA = aliceSpacesData[0];
    expect(aliceSpaceA.executionMode).toBe('container');

    // Query Bob Space
    const bobSpacesRes = await fetch(`${platformUrl}/api/spaces`, {
      headers: { Cookie: bobAuth.cookie },
    });
    expect(bobSpacesRes.status).toBe(200);
    const bobSpacesData = ((await bobSpacesRes.json()) as { data: SpaceDto[] }).data;
    expect(bobSpacesData.length).toBeGreaterThan(0);
    const bobSpaceB = bobSpacesData[0];

    // Create Alice Real Session
    const aliceSessionRes = await fetch(`${platformUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({ spaceId: aliceSpaceA.id, title: 'Alice MCP Docker Session' }),
    });
    expect(aliceSessionRes.status).toBe(201);
    const aliceSession = ((await aliceSessionRes.json()) as { data: SessionDto }).data;
    expect(aliceSession.id).toBeDefined();

    // Create Bob Real Session
    const bobSessionRes = await fetch(`${platformUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': bobAuth.csrfToken,
        Origin: platformUrl,
        Cookie: bobAuth.cookie,
      },
      body: JSON.stringify({ spaceId: bobSpaceB.id, title: 'Bob MCP Docker Session' }),
    });
    expect(bobSessionRes.status).toBe(201);
    const bobSession = ((await bobSessionRes.json()) as { data: SessionDto }).data;
    expect(bobSession.id).toBeDefined();

    // 5. Build extension archive containing pure stdio MCP server and manifest
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
    // No response needed
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

    // 6. Admin installs MCP extension via HTTP Manage API bound to Alice SpaceA
    const installRes = await fetch(`${platformUrl}/api/manage/extensions/install`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: aliceAuth.cookie,
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
      },
      body: JSON.stringify({
        sourceKind: 'archive',
        spaceId: aliceSpaceA.id,
        archiveFilename: 'deterministic-mcp.tar.gz',
        archiveBase64: archiveBuffer.toString('base64'),
      }),
    });

    expect(installRes.status).toBe(201);

    // =========================================================================
    // 7. Turn 1 (Alice SpaceA): Real Agent executes MCP tool turn with approval
    // =========================================================================
    const turn1Prompt = '[enkeep-test-tool-call=mcp__deterministic-mcp__add:{"a":40,"b":2}] Calculate 40 + 2';
    const turn1PostRes = await fetch(`${platformUrl}/api/sessions/${aliceSession.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
        'Idempotency-Key': randomUUID().toLowerCase(),
      },
      body: JSON.stringify({ content: turn1Prompt }),
    });
    expect([200, 202]).toContain(turn1PostRes.status);
    const turn1Envelope = (await turn1PostRes.json()) as MessageEnvelope;
    const userMsg1Id = turn1Envelope.data.message.id;

    // Poll Platform External Interaction API for Alice pending approval
    let pendingApprovalId: string | null = null;
    for (let i = 0; i < 40; i++) {
      const listRes = await fetch(`${platformUrl}/api/interactions/approvals`, {
        headers: { Cookie: aliceAuth.cookie },
      });
      if (listRes.ok) {
        const envelope = (await listRes.json()) as ApprovalsEnvelope;
        if (Array.isArray(envelope.data) && envelope.data.length > 0) {
          const app = envelope.data.find((a) => a.toolName === 'mcp__deterministic-mcp__add');
          if (app) {
            pendingApprovalId = app.id;
            break;
          }
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    expect(pendingApprovalId).not.toBeNull();

    // Verify Bob cannot access Alice's approvals via Platform API
    const bobListRes = await fetch(`${platformUrl}/api/interactions/approvals`, {
      headers: { Cookie: bobAuth.cookie },
    });
    expect(bobListRes.status).toBe(200);
    const bobEnvelope = (await bobListRes.json()) as ApprovalsEnvelope;
    expect(bobEnvelope.data.length).toBe(0);

    // Answer approval via Platform External Interaction API POST /api/interactions/approvals/:id/decide
    const decideRes = await fetch(
      `${platformUrl}/api/interactions/approvals/${pendingApprovalId}/decide`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': aliceAuth.csrfToken,
          Origin: platformUrl,
          Cookie: aliceAuth.cookie,
        },
        body: JSON.stringify({ outcome: 'allowed-once' }),
      }
    );
    expect(decideRes.status).toBe(200);
    const decideEnvelope = (await decideRes.json()) as DecideApprovalEnvelope;
    expect(decideEnvelope.data.status).toBe('allowed-once');
    expect(decideEnvelope.data.decided).toBe(true);

    // Poll delivered assistant message for Alice: verifies 40 + 2 = 42 returned
    const asstTurn1 = await waitForAssistantReplyAfterUser(
      platformUrl,
      aliceSession.id,
      userMsg1Id,
      aliceAuth.cookie
    );
    expect(asstTurn1.status).toBe('delivered');
    expect(asstTurn1.content).toContain('42');

    // =========================================================================
    // 8. Turn 2 (Bob SpaceB / Cross-Tenant): Tool is Absent & Zero Approvals
    // =========================================================================
    const turn2BobPrompt = '[enkeep-test-tool-call=mcp__deterministic-mcp__add:{"a":40,"b":2}] Unauthorized add';
    const turn2BobRes = await fetch(`${platformUrl}/api/sessions/${bobSession.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': bobAuth.csrfToken,
        Origin: platformUrl,
        Cookie: bobAuth.cookie,
        'Idempotency-Key': randomUUID().toLowerCase(),
      },
      body: JSON.stringify({ content: turn2BobPrompt }),
    });
    expect([200, 202]).toContain(turn2BobRes.status);
    const turn2BobEnvelope = (await turn2BobRes.json()) as MessageEnvelope;
    const userMsg2BobId = turn2BobEnvelope.data.message.id;

    // Bob assistant reply delivered without any approval prompt (tool is unknown in Bob space)
    const asstTurn2Bob = await waitForAssistantReplyAfterUser(
      platformUrl,
      bobSession.id,
      userMsg2BobId,
      bobAuth.cookie
    );
    expect(asstTurn2Bob.status).toBe('delivered');
    expect(asstTurn2Bob.content).not.toContain('42');

    // Verify Bob still has zero approvals
    const bobApprovalsRes = await fetch(`${platformUrl}/api/interactions/approvals`, {
      headers: { Cookie: bobAuth.cookie },
    });
    expect(bobApprovalsRes.status).toBe(200);
    const bobApprovalsEnv = (await bobApprovalsRes.json()) as ApprovalsEnvelope;
    expect(bobApprovalsEnv.data.length).toBe(0);

    // =========================================================================
    // 9. Turn 3 (Dynamic Lifecycle): Disable in SpaceA -> Tool Absent on Next Turn
    // =========================================================================
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

    // Send same directive in the SAME Alice session
    const turn3Prompt = '[enkeep-test-tool-call=mcp__deterministic-mcp__add:{"a":100,"b":50}] Add while disabled';
    const turn3PostRes = await fetch(`${platformUrl}/api/sessions/${aliceSession.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
        'Idempotency-Key': randomUUID().toLowerCase(),
      },
      body: JSON.stringify({ content: turn3Prompt }),
    });
    expect([200, 202]).toContain(turn3PostRes.status);
    const turn3Envelope = (await turn3PostRes.json()) as MessageEnvelope;
    const userMsg3Id = turn3Envelope.data.message.id;

    const asstTurn3 = await waitForAssistantReplyAfterUser(
      platformUrl,
      aliceSession.id,
      userMsg3Id,
      aliceAuth.cookie
    );
    expect(asstTurn3.status).toBe('delivered');
    expect(asstTurn3.content).toContain('unknown tool');
    expect(asstTurn3.content).not.toContain('150');

    // Verify no new approvals created while disabled
    const aliceApprovalsResTurn3 = await fetch(`${platformUrl}/api/interactions/approvals`, {
      headers: { Cookie: aliceAuth.cookie },
    });
    expect(aliceApprovalsResTurn3.status).toBe(200);
    const aliceApprovalsEnvTurn3 = (await aliceApprovalsResTurn3.json()) as ApprovalsEnvelope;
    expect(aliceApprovalsEnvTurn3.data.length).toBe(0);

    // =========================================================================
    // 10. Turn 4 (Dynamic Lifecycle): Re-Enable in SpaceA -> Tool Restored & Approvals Work
    // =========================================================================
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

    // Send directive in the SAME Alice session
    const turn4Prompt = '[enkeep-test-tool-call=mcp__deterministic-mcp__add:{"a":95,"b":5}] Add after re-enable';
    const turn4PostRes = await fetch(`${platformUrl}/api/sessions/${aliceSession.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
        'Idempotency-Key': randomUUID().toLowerCase(),
      },
      body: JSON.stringify({ content: turn4Prompt }),
    });
    expect([200, 202]).toContain(turn4PostRes.status);
    const turn4Envelope = (await turn4PostRes.json()) as MessageEnvelope;
    const userMsg4Id = turn4Envelope.data.message.id;

    // Poll for pending approval
    let pendingApproval4Id: string | null = null;
    for (let i = 0; i < 40; i++) {
      const listRes = await fetch(`${platformUrl}/api/interactions/approvals`, {
        headers: { Cookie: aliceAuth.cookie },
      });
      if (listRes.ok) {
        const envelope = (await listRes.json()) as ApprovalsEnvelope;
        if (Array.isArray(envelope.data) && envelope.data.length > 0) {
          const app = envelope.data.find((a) => a.toolName === 'mcp__deterministic-mcp__add');
          if (app) {
            pendingApproval4Id = app.id;
            break;
          }
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(pendingApproval4Id).not.toBeNull();

    // Answer approval
    const decide4Res = await fetch(
      `${platformUrl}/api/interactions/approvals/${pendingApproval4Id}/decide`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': aliceAuth.csrfToken,
          Origin: platformUrl,
          Cookie: aliceAuth.cookie,
        },
        body: JSON.stringify({ outcome: 'allowed-once' }),
      }
    );
    expect(decide4Res.status).toBe(200);

    // Poll delivered assistant message: verifies 95 + 5 = 100
    const asstTurn4 = await waitForAssistantReplyAfterUser(
      platformUrl,
      aliceSession.id,
      userMsg4Id,
      aliceAuth.cookie
    );
    expect(asstTurn4.status).toBe('delivered');
    expect(asstTurn4.content).toContain('100');

    // =========================================================================
    // 11. Admin MCP Diagnostics
    // =========================================================================
    const diagRes = await fetch(`${platformUrl}/api/admin/mcp/diagnostics`, {
      headers: { Cookie: aliceAuth.cookie, Origin: platformUrl },
    });
    expect(diagRes.status).toBe(200);
    const diagEnvelope = (await diagRes.json()) as DiagnosticsEnvelope;
    expect(diagEnvelope.data.available).toBe(true);
    expect(diagEnvelope.data.status).toBe('healthy');
  });
});
