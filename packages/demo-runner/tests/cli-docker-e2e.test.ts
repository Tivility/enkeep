/**
 * Real Docker Acceptance Test for CLI Tool Contribution Execution, Platform Human Approval & Dynamic Lifecycle
 *
 * Runs under `pnpm run test:cli` or `pnpm --filter @enkeep/demo-runner run test:cli`.
 *
 * Verifies:
 * 1) Extension Archive Installation:
 *    - Extension archive with `extension.json` declaring `kind: 'cli'` with `command: 'node'`, `script: 'cli.mjs'`, and `fixedArgs`.
 *    - Installed and bound to SpaceA by Admin (Alice).
 * 2) Real Agent Execution in Docker Container Runtime:
 *    - Model executes namespaced tool `cli__deterministic_cli__run` with arguments `["add", "40", "2"]`.
 *    - Intercepted by Platform Human Approval API.
 *    - Decided `allowed-once` by user.
 *    - CLI script executes inside container workspace and returns stdout `OUT:SUM=42`.
 *    - Assistant delivers verified output.
 * 3) Multi-Tenant & Space Isolation:
 *    - SpaceB (Bob) cannot see or execute the CLI tool; zero approvals created.
 * 4) Dynamic Turn-by-Turn Lifecycle:
 *    - Disable binding in SpaceA -> tool is absent on next turn, zero approvals created.
 *    - Re-enable binding in SpaceA -> tool is active again on next turn, approval requested, delivers `OUT:PROD=42`.
 *
 * @module @enkeep/demo-runner/tests/cli-docker-e2e.test
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

describe('Real Docker Acceptance Test: CLI Contribution Execution, Approval & Dynamic Turn Lifecycle', () => {
  let tempRepo: TempRepo;
  let runningSystem: RunningDemoSystem | null = null;
  let resourceSuffix: string;
  let probeBefore: ProtectedPortsSnapshot | undefined;
  let dockerClient: SafeDockerClient;

  beforeEach(async () => {
    tempRepo = createTempRepo();
    resourceSuffix = generateSuffix12();
    dockerClient = new SafeDockerClient();

    const isDockerAvailable = await dockerClient.isDockerAvailable();
    if (!isDockerAvailable) {
      console.warn('Docker daemon not reachable; skipping real Docker CLI acceptance test.');
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

    if (probeBefore) {
      const probeAfter = await probeProtectedPorts();
      assertProbesUnchanged(probeBefore, probeAfter);
    }

    tempRepo.cleanup();
  });

  it('installs CLI contribution, executes via real container Agent with approval, and disappears when disabled', async () => {
    const isDockerAvailable = await dockerClient.isDockerAvailable();
    if (!isDockerAvailable) {
      return;
    }

    // 1. Reset demo environment
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

    // 3. Authenticate Alice (Admin) and Bob (User)
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
      body: JSON.stringify({ spaceId: aliceSpaceA.id, title: 'Alice CLI Docker Session' }),
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
      body: JSON.stringify({ spaceId: bobSpaceB.id, title: 'Bob CLI Docker Session' }),
    });
    expect(bobSessionRes.status).toBe(201);
    const bobSession = ((await bobSessionRes.json()) as { data: SessionDto }).data;
    expect(bobSession.id).toBeDefined();

    // 4. Build extension archive containing CLI contribution and script
    const cliScriptContent = `
const args = process.argv.slice(2);
let prefix = '';
const nonFlagArgs = [];
for (const arg of args) {
  if (arg.startsWith('--prefix=')) {
    prefix = arg.slice(9);
  } else {
    nonFlagArgs.push(arg);
  }
}
const [op, a, b] = nonFlagArgs;
if (op === 'add') {
  const sum = Number(a) + Number(b);
  console.log(\`\${prefix}SUM=\${sum}\`);
} else if (op === 'multiply') {
  const prod = Number(a) * Number(b);
  console.log(\`\${prefix}PROD=\${prod}\`);
} else {
  console.log(\`\${prefix}ARGS=\${args.join(',')}\`);
}
`;

    const extensionJson = {
      schemaVersion: 1,
      slug: 'deterministic-cli',
      name: 'Deterministic CLI Fixture',
      description: 'Shipped deterministic CLI contribution fixture',
      contributions: [
        {
          kind: 'cli',
          key: 'deterministic-cli',
          manifest: {
            name: 'deterministic-cli',
            description: 'Deterministic CLI tool fixture with math operations',
            command: 'node',
            script: 'cli.mjs',
            fixedArgs: ['--prefix=OUT:'],
            timeoutMs: 15000,
          },
        },
      ],
    };

    const archiveBuffer = createTarGzArchive([
      { path: 'extension.json', content: JSON.stringify(extensionJson, null, 2) },
      { path: 'cli.mjs', content: cliScriptContent },
    ]);

    // 5. Admin installs CLI extension via HTTP Manage API bound to Alice SpaceA
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
        archiveFilename: 'deterministic-cli.tar.gz',
        archiveBase64: archiveBuffer.toString('base64'),
      }),
    });

    expect(installRes.status).toBe(201);

    // =========================================================================
    // 6. Turn 1 (Alice SpaceA): Real Agent executes CLI tool turn with approval
    // =========================================================================
    const turn1Prompt = '[enkeep-test-tool-call=cli__deterministic_cli__run:{"args":["add","40","2"]}] Calculate 40 + 2';
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
          const app = envelope.data.find((a) => a.toolName === 'cli__deterministic_cli__run');
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

    // Poll delivered assistant message for Alice: verifies OUT:SUM=42 returned
    const asstTurn1 = await waitForAssistantReplyAfterUser(
      platformUrl,
      aliceSession.id,
      userMsg1Id,
      aliceAuth.cookie
    );
    expect(asstTurn1.status).toBe('delivered');
    expect(asstTurn1.content).toContain('OUT:SUM=42');

    // =========================================================================
    // 7. Turn 2 (Bob SpaceB / Cross-Tenant): Tool is Absent & Zero Approvals
    // =========================================================================
    const turn2BobPrompt = '[enkeep-test-tool-call=cli__deterministic_cli__run:{"args":["add","40","2"]}] Unauthorized add';
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

    // Bob turn completes with error / unknown tool (zero approvals created)
    await new Promise((r) => setTimeout(r, 2000));
    const bobApprovalRes = await fetch(`${platformUrl}/api/interactions/approvals`, {
      headers: { Cookie: bobAuth.cookie },
    });
    const bobApprovals = (await bobApprovalRes.json()) as ApprovalsEnvelope;
    expect(bobApprovals.data.length).toBe(0);

    const asstTurn2Bob = await waitForAssistantReplyAfterUser(
      platformUrl,
      bobSession.id,
      userMsg2BobId,
      bobAuth.cookie
    );
    expect(asstTurn2Bob.status).toBe('delivered');
    expect(asstTurn2Bob.content).not.toContain('OUT:SUM=42');

    // =========================================================================
    // 8. Turn 3: Disable Binding in SpaceA -> Tool disappears on Next Turn
    // =========================================================================
    const disableRes = await fetch(
      `${platformUrl}/api/manage/extensions/deterministic-cli/disable`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': aliceAuth.csrfToken,
          Origin: platformUrl,
          Cookie: aliceAuth.cookie,
        },
        body: JSON.stringify({ spaceId: aliceSpaceA.id }),
      }
    );
    expect(disableRes.status).toBe(200);

    const turn3Prompt = '[enkeep-test-tool-call=cli__deterministic_cli__run:{"args":["multiply","6","7"]}] Multiply while disabled';
    const turn3Res = await fetch(`${platformUrl}/api/sessions/${aliceSession.id}/messages`, {
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
    expect([200, 202]).toContain(turn3Res.status);
    const turn3Envelope = (await turn3Res.json()) as MessageEnvelope;
    const userMsg3Id = turn3Envelope.data.message.id;

    // Zero approvals created because tool is disabled / unmounted
    await new Promise((r) => setTimeout(r, 2000));
    const aliceApprovalRes3 = await fetch(`${platformUrl}/api/interactions/approvals`, {
      headers: { Cookie: aliceAuth.cookie },
    });
    const aliceApprovals3 = (await aliceApprovalRes3.json()) as ApprovalsEnvelope;
    expect(aliceApprovals3.data.length).toBe(0);

    const asstTurn3 = await waitForAssistantReplyAfterUser(
      platformUrl,
      aliceSession.id,
      userMsg3Id,
      aliceAuth.cookie
    );
    expect(asstTurn3.status).toBe('delivered');
    expect(asstTurn3.content).not.toContain('OUT:PROD=42');

    // =========================================================================
    // 9. Turn 4: Re-Enable Binding -> Tool works with Approval
    // =========================================================================
    const enableRes = await fetch(
      `${platformUrl}/api/manage/extensions/deterministic-cli/enable`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': aliceAuth.csrfToken,
          Origin: platformUrl,
          Cookie: aliceAuth.cookie,
        },
        body: JSON.stringify({ spaceId: aliceSpaceA.id }),
      }
    );
    expect(enableRes.status).toBe(200);

    const turn4Prompt = '[enkeep-test-tool-call=cli__deterministic_cli__run:{"args":["multiply","6","7"]}] Multiply after re-enable';
    const turn4Res = await fetch(`${platformUrl}/api/sessions/${aliceSession.id}/messages`, {
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
    expect([200, 202]).toContain(turn4Res.status);
    const turn4Envelope = (await turn4Res.json()) as MessageEnvelope;
    const userMsg4Id = turn4Envelope.data.message.id;

    // Poll Platform External Interaction API for Alice pending approval
    let pendingApproval4Id: string | null = null;
    for (let i = 0; i < 40; i++) {
      const listRes = await fetch(`${platformUrl}/api/interactions/approvals`, {
        headers: { Cookie: aliceAuth.cookie },
      });
      if (listRes.ok) {
        const envelope = (await listRes.json()) as ApprovalsEnvelope;
        if (Array.isArray(envelope.data) && envelope.data.length > 0) {
          const app = envelope.data.find((a) => a.toolName === 'cli__deterministic_cli__run');
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

    // Poll delivered assistant message: verifies OUT:PROD=42
    const asstTurn4 = await waitForAssistantReplyAfterUser(
      platformUrl,
      aliceSession.id,
      userMsg4Id,
      aliceAuth.cookie
    );
    expect(asstTurn4.status).toBe('delivered');
    expect(asstTurn4.content).toContain('OUT:PROD=42');
  });
});
