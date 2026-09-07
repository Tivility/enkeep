/**
 * Real Docker Acceptance Test for Browser Automation E2E Lifecycle, Isolation, Approvals & SSRF
 *
 * Runs only under `pnpm --filter @enkeep/demo-runner run test:docker`,
 * `pnpm --filter @enkeep/demo-runner run test:browser:real`, and root `test:docker` / `test:browser:real`.
 * Never runs under normal unit `pnpm test`.
 *
 * Verifies:
 * 1. Preflight Safety: Docker daemon available, Chromium available, and protected ports (3000/3080) snapshot.
 * 2. Host Local Fixture Allowed in BrowserService test config:
 *    - Creates local HTTP fixture on 127.0.0.1 with interactive elements and counter.
 *    - Injects shared BrowserService singleton into launchDemoSystem with allowLocalForTesting.
 * 3. Zero-Network Docker Container Proof:
 *    - Inspects Alice container to assert `HostConfig.NetworkMode === 'none'` and zero port bindings.
 *    - Proves browser automation executes entirely on Host via Platform tunnel and BrowserService.
 * 4. Deterministic Tool Turns via Official Platform Delivery:
 *    - Must NOT direct construct tool or client: message -> AgentLoop -> DSH browser plugin -> tunnel -> BrowserService.
 *    - Turn 1: `browser_open` opens local fixture URL -> captures delivered assistant message -> extracts `pageId`.
 *    - Turn 2: `browser_snapshot` captures accessibility tree -> verifies DOM text ("Clicks: 0") -> extracts button `@e...` ref.
 *    - Turn 3: `browser_interact` executes click on button -> triggers real human approval via Platform external interaction API (`/api/interactions/approvals`) -> user answers `allowed-once` -> interaction resumes and completes.
 *    - Turn 4: `browser_snapshot` confirms DOM mutation ("Clicks: 1").
 *    - Turn 5: `browser_screenshot` captures viewport -> saved into Docker Space through existing fileProvider (`artifacts/browser/<opaque>.png`) -> downloads PNG from `/api/spaces/:id/files/download` and verifies valid PNG magic bytes.
 *    - Turn 6: `browser_close` releases page resources cleanly -> verifies `activePages === 0`.
 * 5. Multi-Tenant Session Isolation:
 *    - Bob sends a tool turn in Bob's session attempting to use Alice's `pageId` -> rejected with 403 / generic error.
 *    - Bob cannot list or access Alice's pending approvals.
 * 6. SSRF Boundary Enforcement:
 *    - Attempting to open unauthorized private IPs or cloud metadata (169.254.169.254) is rejected by SSRF guard.
 * 7. Clean Teardown:
 *    - System close disposes BrowserService, terminates Chromium workers, tears down containers and volumes with zero resource leaks.
 *
 * @module @enkeep/demo-runner/tests/browser-docker-e2e.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import * as externalInteractionPlugin from '@enkeep/dsh-external-interaction';
import type { IExternalInteractionService, PendingApproval } from '@enkeep/dsh-external-interaction';
import {
  createBrowserService,
  type BrowserService,
} from '@enkeep/platform-service-browser';
import { launchDemoSystem, isChromiumAvailable, type RunningDemoSystem } from '../src/up/index.js';
import { resetDemo } from '../src/reset/index.js';
import { downDemo } from '../src/down/index.js';
import { DockerRuntimeContainerAdapter } from '../src/ports/index.js';
import { probeProtectedPorts, assertProbesUnchanged } from '../src/utils/probes.js';
import { getDemoPathConfig } from '../src/config.js';
import { SafeDockerClient } from '@enkeep/runtime-runner/docker';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';

type ProtectedPortsSnapshot = Awaited<ReturnType<typeof probeProtectedPorts>>;

interface TestFixtureServer {
  server: http.Server;
  port: number;
  origin: string;
  close(): Promise<void>;
}

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

function createLocalFixtureServer(): Promise<TestFixtureServer> {
  return new Promise((resolve, reject) => {
    let clickCount = 0;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

      if (url.pathname === '/app') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head>
              <meta charset="utf-8" />
              <title>Enkeep Real Browser Docker Fixture</title>
            </head>
            <body>
              <h1 id="title">Enkeep Docker Acceptance Browser Page</h1>
              <p id="description">Testing deterministic tool directives via platform tunnel under Docker zero network.</p>
              <div id="counter-display">Clicks: ${clickCount}</div>
              <button id="btn-count" onclick="document.getElementById('counter-display').innerText = 'Clicks: ' + (++window.clicks || 1)">Increment</button>
              <input id="input-search" type="text" placeholder="Type query" />
              <div id="status-box">Status: Ready</div>
              <script>
                window.clicks = ${clickCount};
              </script>
            </body>
          </html>
        `);
        return;
      }

      if (url.pathname === '/secret-admin') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ secret: 'unauthorized_ssrf_admin_secret' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><head><title>Root</title></head><body><h1>Root</h1></body></html>`);
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      const port = addr.port;
      const origin = `http://127.0.0.1:${port}`;
      resolve({
        server,
        port,
        origin,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });

    server.on('error', reject);
  });
}

async function loginUser(serverUrl: string, user: { username: string; password: string }): Promise<AuthTokens> {
  const originHeader = serverUrl;
  const initCsrfRes = await fetch(`${serverUrl}/api/auth/csrf`, {
    headers: { Origin: originHeader },
  });
  if (!initCsrfRes.ok) throw new Error(`Initial CSRF fetch failed: ${initCsrfRes.status}`);
  const initCsrfData = ((await initCsrfRes.json()) as any).data;
  const loginCsrf = initCsrfData.csrfToken as string;

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
  const csrfToken = authCsrfData.csrfToken as string;

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
      const data = ((await res.json()) as any).data;
      const msgs = (data.messages || []) as AssistantMessageDto[];
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

describe('Real Docker Zero-Network Browser Automation E2E Acceptance Suite', () => {
  let tempRepo: TempRepo | null = null;
  let activeResourceSuffix: string | null = null;
  let runGeneratedMetadata = false;
  let probeBefore: ProtectedPortsSnapshot | null = null;
  let runningSystem: RunningDemoSystem | null = null;
  let fixtureServer: TestFixtureServer | null = null;
  let browserService: BrowserService | null = null;

  beforeEach(async () => {
    // 1. Mandatory runtime image check
    const rawRuntimeImage = process.env.ENKEEP_RUNTIME_IMAGE?.trim() || 'enkeep-demo-runtime:acceptance';
    const acceptanceImagePattern = /^(enkeep-demo-runtime:(acceptance|latest)|enkeep-dsh-0\.1\.2-rc\.1-canary(:latest)?)$/;
    if (!acceptanceImagePattern.test(rawRuntimeImage)) {
      throw new Error(
        `FAIL-CLOSED: Invalid runtime image "${rawRuntimeImage}". Acceptance tests require "enkeep-demo-runtime:acceptance", "enkeep-demo-runtime:latest", or "enkeep-dsh-0.1.2-rc.1-canary".`
      );
    }

    // 2. Mandatory Docker availability check
    const dockerClient = new SafeDockerClient();
    const isDockerAvailable = await dockerClient.isDockerAvailable();
    if (!isDockerAvailable) {
      throw new Error('FAIL-CLOSED: Docker daemon is unavailable. Real Docker acceptance tests require an active daemon.');
    }

    // 3. Mandatory Chromium availability check
    const hasChromium = isChromiumAvailable();
    if (!hasChromium) {
      throw new Error('FAIL-CLOSED: Playwright Chromium browser is required for real browser e2e tests.');
    }

    // 4. Protected port baseline snapshot
    probeBefore = await probeProtectedPorts();
  });

  afterEach(async () => {
    const teardownErrors: Error[] = [];

    if (fixtureServer) {
      try {
        await fixtureServer.close();
      } catch (err: unknown) {
        teardownErrors.push(err instanceof Error ? err : new Error(String(err)));
      }
      fixtureServer = null;
    }

    if (runningSystem) {
      try {
        await runningSystem.close({ removeVolumes: true });
      } catch (err: unknown) {
        teardownErrors.push(err instanceof Error ? err : new Error(String(err)));
      }
      runningSystem = null;
    }

    if (browserService) {
      try {
        await browserService.dispose();
      } catch (err: unknown) {
        teardownErrors.push(err instanceof Error ? err : new Error(String(err)));
      }
      browserService = null;
    }

    if (tempRepo && activeResourceSuffix) {
      const paths = getDemoPathConfig({ repoRoot: tempRepo.repoRoot, resourceSuffix: activeResourceSuffix });
      const metadataExists = existsSync(paths.demoDataDir);

      if (runGeneratedMetadata || metadataExists) {
        try {
          const downResult = await downDemo({
            repoRoot: tempRepo.repoRoot,
            resourceSuffix: activeResourceSuffix,
            removeVolumes: true,
          });
          if (!downResult.ok) {
            teardownErrors.push(new Error('Teardown reported failure during afterEach downDemo'));
          }
        } catch (err: unknown) {
          teardownErrors.push(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }

    // Assert zero leaked containers/volumes
    if (activeResourceSuffix) {
      try {
        const dockerClient = new SafeDockerClient();
        const isDockerAvailable = await dockerClient.isDockerAvailable();
        if (isDockerAvailable) {
          const aliceContainer = `enkeep-demo-alice-${activeResourceSuffix}`;
          const bobContainer = `enkeep-demo-bob-${activeResourceSuffix}`;
          const aliceVol = `enkeep-demo-dsh-alice-${activeResourceSuffix}`;
          const bobVol = `enkeep-demo-dsh-bob-${activeResourceSuffix}`;

          const [cA, cB, vA, vB] = await Promise.all([
            dockerClient.inspectContainer(aliceContainer),
            dockerClient.inspectContainer(bobContainer),
            dockerClient.inspectVolume(aliceVol),
            dockerClient.inspectVolume(bobVol),
          ]);

          if (cA !== null) teardownErrors.push(new Error(`LEAK: Container "${aliceContainer}" still exists`));
          if (cB !== null) teardownErrors.push(new Error(`LEAK: Container "${bobContainer}" still exists`));
          if (vA !== null) teardownErrors.push(new Error(`LEAK: Volume "${aliceVol}" still exists`));
          if (vB !== null) teardownErrors.push(new Error(`LEAK: Volume "${bobVol}" still exists`));
        }
      } catch (leakErr: unknown) {
        teardownErrors.push(leakErr instanceof Error ? leakErr : new Error(String(leakErr)));
      }
    }

    // Assert protected ports unchanged
    if (probeBefore) {
      try {
        const probeAfter = await probeProtectedPorts();
        assertProbesUnchanged(probeBefore, probeAfter);
      } catch (portErr: unknown) {
        teardownErrors.push(portErr instanceof Error ? portErr : new Error(String(portErr)));
      }
    }

    if (tempRepo) {
      try {
        tempRepo.cleanup();
      } catch (cleanupErr: unknown) {
        teardownErrors.push(cleanupErr instanceof Error ? cleanupErr : new Error(String(cleanupErr)));
      }
      tempRepo = null;
    }

    if (teardownErrors.length > 0) {
      throw new AggregateError(teardownErrors, 'afterEach cleanup encountered errors');
    }
  });

  it('executes full real browser automation journey in zero-network Docker runtime with approvals, isolation & SSRF defense', async () => {
    // =========================================================================
    // 1. Local Fixture Server on Host
    // =========================================================================
    fixtureServer = await createLocalFixtureServer();
    expect(fixtureServer.port).toBeGreaterThan(0);

    // =========================================================================
    // 2. Shared Host BrowserService with local testing allowlist
    // =========================================================================
    browserService = createBrowserService({
      mode: 'worker',
      allowedHosts: ['127.0.0.1'],
      allowLocalForTesting: true,
      disableChromiumSandboxForTesting: true,
    });
    if (typeof (browserService as any).initialize === 'function') {
      await (browserService as any).initialize();
    }

    const initialHealth = await browserService.checkHealth();
    expect(initialHealth.status).toBe('healthy');
    expect(initialHealth.activePages).toBe(0);
    expect(initialHealth.activeContexts).toBe(0);

    // =========================================================================
    // 3. Demo Reset & launchDemoSystem with real Docker adapter and injected BrowserService
    // =========================================================================
    tempRepo = createTempRepo();
    activeResourceSuffix = generateSuffix12();

    const resetResult = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix: activeResourceSuffix,
    });
    expect(resetResult.ok).toBe(true);

    const dockerClient = new SafeDockerClient();
    const adapter = new DockerRuntimeContainerAdapter(dockerClient);

    const cordisCtx = new Context();
    await cordisCtx.plugin(externalInteractionPlugin);
    const extInteraction = cordisCtx.get('externalInteraction') as IExternalInteractionService;
    expect(extInteraction).toBeDefined();

    runningSystem = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix: activeResourceSuffix,
      runtimeImage: 'enkeep-demo-runtime:acceptance',
      runtimeAdapter: adapter,
      browserService,
      externalInteractionService: extInteraction,
      llmEnabled: false,
    });
    expect(runningSystem.result.ok).toBe(true);
    runGeneratedMetadata = true;

    // Verify injected browserService was initialized by PlatformServer and is healthy
    const postLaunchHealth = await browserService.checkHealth();
    expect(postLaunchHealth.status).toBe('healthy');
    expect(postLaunchHealth.activePages).toBe(0);
    expect(postLaunchHealth.activeContexts).toBe(0);

    const platformUrl = runningSystem.result.platform.url!;
    const aliceAuth = await loginUser(platformUrl, resetResult.credentials.admin);
    const bobAuth = await loginUser(platformUrl, resetResult.credentials.user);

    // Get Alice Space
    const aliceSpacesRes = await fetch(`${platformUrl}/api/spaces`, {
      headers: { Cookie: aliceAuth.cookie },
    });
    expect(aliceSpacesRes.status).toBe(200);
    const aliceSpacesData = ((await aliceSpacesRes.json()) as any).data as SpaceDto[];
    const aliceSpace = aliceSpacesData[0];
    expect(aliceSpace).toBeDefined();
    expect(aliceSpace.executionMode).toBe('container');

    // Create Alice Session
    const aliceSessionRes = await fetch(`${platformUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
      },
      body: JSON.stringify({ spaceId: aliceSpace.id, title: 'Alice Browser Docker Session' }),
    });
    expect(aliceSessionRes.status).toBe(201);
    const aliceSession = (((await aliceSessionRes.json()) as any).data) as SessionDto;
    expect(aliceSession.id).toBeDefined();

    // Get Bob Space
    const bobSpacesRes = await fetch(`${platformUrl}/api/spaces`, {
      headers: { Cookie: bobAuth.cookie },
    });
    expect(bobSpacesRes.status).toBe(200);
    const bobSpacesData = ((await bobSpacesRes.json()) as any).data as SpaceDto[];
    const bobSpace = bobSpacesData[0];
    expect(bobSpace).toBeDefined();

    // Create Bob Session
    const bobSessionRes = await fetch(`${platformUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': bobAuth.csrfToken,
        Origin: platformUrl,
        Cookie: bobAuth.cookie,
      },
      body: JSON.stringify({ spaceId: bobSpace.id, title: 'Bob Browser Docker Session' }),
    });
    expect(bobSessionRes.status).toBe(201);
    const bobSession = (((await bobSessionRes.json()) as any).data) as SessionDto;
    expect(bobSession.id).toBeDefined();

    // =========================================================================
    // 4. Prove Docker container runs with --network none
    // =========================================================================
    const aliceContainerName = `enkeep-demo-alice-${activeResourceSuffix}`;
    const aliceContainerInfo = await dockerClient.inspectContainer(aliceContainerName);
    expect(aliceContainerInfo).not.toBeNull();
    expect(aliceContainerInfo!.networkMode).toBe('none');
    expect(aliceContainerInfo!.portBindings === null || Object.keys(aliceContainerInfo!.portBindings).length === 0).toBe(true);

    // =========================================================================
    // 5. Tool Turn 1: browser_open (Fixture URL)
    // =========================================================================
    const fixtureUrl = `${fixtureServer.origin}/app`;
    const turn1Prompt = `[enkeep-test-tool-call=browser_open:{"url":"${fixtureUrl}"}] Open fixture page`;

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

    const asstTurn1 = await waitForAssistantReplyAfterUser(
      platformUrl,
      aliceSession.id,
      userMsg1Id,
      aliceAuth.cookie
    );
    expect(asstTurn1).toBeDefined();
    expect(asstTurn1.status).toBe('delivered');
    expect(asstTurn1.content).toContain('Opened');
    expect(asstTurn1.content).toContain('page_');

    const pageIdMatch = asstTurn1.content.match(/page_[0-9a-f]+/i);
    expect(pageIdMatch).not.toBeNull();
    const pageId = pageIdMatch![0];

    // Browser health reports 1 active page
    const healthAfterOpen = await browserService.checkHealth();
    expect(healthAfterOpen.activePages).toBe(1);
    expect(healthAfterOpen.activeContexts).toBe(1);

    // =========================================================================
    // 6. Tool Turn 2: browser_snapshot (Accessibility Tree & Semantic Element Refs)
    // =========================================================================
    const turn2Prompt = `[enkeep-test-tool-call=browser_snapshot:{"pageId":"${pageId}"}] Snapshot accessibility tree`;

    const turn2PostRes = await fetch(`${platformUrl}/api/sessions/${aliceSession.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
        'Idempotency-Key': randomUUID().toLowerCase(),
      },
      body: JSON.stringify({ content: turn2Prompt }),
    });
    expect([200, 202]).toContain(turn2PostRes.status);
    const turn2Envelope = (await turn2PostRes.json()) as MessageEnvelope;
    const userMsg2Id = turn2Envelope.data.message.id;

    const asstTurn2 = await waitForAssistantReplyAfterUser(
      platformUrl,
      aliceSession.id,
      userMsg2Id,
      aliceAuth.cookie
    );
    expect(asstTurn2.status).toBe('delivered');
    expect(asstTurn2.content).toContain('Snapshot of');
    expect(asstTurn2.content).toContain('Enkeep Docker Acceptance Browser Page');
    expect(asstTurn2.content).toContain('Clicks: 0');
    expect(asstTurn2.content).toContain('Increment');

    // Parse button ref (@e1, e1, etc.)
    const btnRefMatch = asstTurn2.content.match(/\[(e\d+)\] button "Increment"/);
    const btnRef = btnRefMatch ? btnRefMatch[1] : 'e4';

    // =========================================================================
    // 7. Tool Turn 3: browser_interact (Triggers Human Approval -> Allowed Once)
    // =========================================================================
    const turn3Prompt = `[enkeep-test-tool-call=browser_interact:{"pageId":"${pageId}","action":"click","ref":"${btnRef}"}] Click Increment button`;

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

    // External Interaction Service & Platform API records pending approval
    let pendingApprovalId: string | null = null;
    for (let i = 0; i < 40; i++) {
      // Query Platform API GET /api/interactions/approvals
      const listRes = await fetch(`${platformUrl}/api/interactions/approvals`, {
        headers: { Cookie: aliceAuth.cookie },
      });
      if (listRes.ok) {
        const envelope = (await listRes.json()) as ApprovalsEnvelope;
        if (Array.isArray(envelope.data) && envelope.data.length > 0) {
          const app = envelope.data.find(
            (a) => a.toolName === 'browser_interact' || a.safeSummary?.includes('browser')
          );
          if (app) {
            pendingApprovalId = app.id;
            break;
          }
        }
      }

      await new Promise((r) => setTimeout(r, 250));
    }

    expect(pendingApprovalId).not.toBeNull();

    // Verify Bob cannot access Alice approvals via Platform API
    const bobListRes = await fetch(`${platformUrl}/api/interactions/approvals`, {
      headers: { Cookie: bobAuth.cookie },
    });
    expect(bobListRes.status).toBe(200);
    const bobEnvelope = (await bobListRes.json()) as ApprovalsEnvelope;
    expect(bobEnvelope.data.length).toBe(0);

    // Answer approval strictly via Platform External Interaction API POST /api/interactions/approvals/:id/decide
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

    const asstTurn3 = await waitForAssistantReplyAfterUser(
      platformUrl,
      aliceSession.id,
      userMsg3Id,
      aliceAuth.cookie
    );
    expect(asstTurn3.status).toBe('delivered');
    expect(asstTurn3.content).toContain(`Performed click on ${btnRef}`);

    // =========================================================================
    // 8. Tool Turn 4: browser_snapshot (Verifies DOM Mutated -> Clicks: 1)
    // =========================================================================
    const turn4Prompt = `[enkeep-test-tool-call=browser_snapshot:{"pageId":"${pageId}"}] Verify DOM updated after interaction`;

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

    const asstTurn4 = await waitForAssistantReplyAfterUser(
      platformUrl,
      aliceSession.id,
      userMsg4Id,
      aliceAuth.cookie
    );
    expect(asstTurn4.status).toBe('delivered');
    expect(asstTurn4.content).toContain('Clicks: 1');

    // =========================================================================
    // 9. Tool Turn 5: browser_screenshot (Saved to Docker Space -> Download PNG)
    // =========================================================================
    const turn5Prompt = `[enkeep-test-tool-call=browser_screenshot:{"pageId":"${pageId}"}] Capture screenshot of current view`;

    const turn5PostRes = await fetch(`${platformUrl}/api/sessions/${aliceSession.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
        'Idempotency-Key': randomUUID().toLowerCase(),
      },
      body: JSON.stringify({ content: turn5Prompt }),
    });
    expect([200, 202]).toContain(turn5PostRes.status);
    const turn5Envelope = (await turn5PostRes.json()) as MessageEnvelope;
    const userMsg5Id = turn5Envelope.data.message.id;

    const asstTurn5 = await waitForAssistantReplyAfterUser(
      platformUrl,
      aliceSession.id,
      userMsg5Id,
      aliceAuth.cookie
    );
    expect(asstTurn5.status).toBe('delivered');
    expect(asstTurn5.content).toContain('artifacts/browser/');

    const shotMatch = asstTurn5.content.match(/artifacts\/browser\/[0-9a-f_\-]+\.png/i);
    expect(shotMatch).not.toBeNull();
    const screenshotPath = shotMatch![0];

    // Download screenshot through Platform Server space files download route
    const downloadRes = await fetch(
      `${platformUrl}/api/spaces/${encodeURIComponent(aliceSpace.id)}/files/download?path=${encodeURIComponent(screenshotPath)}`,
      {
        headers: { Cookie: aliceAuth.cookie },
      }
    );
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get('content-type')).toBe('image/png');

    const pngBuffer = Buffer.from(await downloadRes.arrayBuffer());
    expect(pngBuffer.length).toBeGreaterThan(100);

    // Assert PNG header magic bytes (\x89PNG\r\n\x1a\n)
    expect(pngBuffer[0]).toBe(0x89);
    expect(pngBuffer[1]).toBe(0x50); // P
    expect(pngBuffer[2]).toBe(0x4e); // N
    expect(pngBuffer[3]).toBe(0x47); // G
    expect(pngBuffer[4]).toBe(0x0d); // \r
    expect(pngBuffer[5]).toBe(0x0a); // \n
    expect(pngBuffer[6]).toBe(0x1a);
    expect(pngBuffer[7]).toBe(0x0a);

    // =========================================================================
    // 10. Tool Turn 6: browser_close (Clean resource release)
    // =========================================================================
    const turn6Prompt = `[enkeep-test-tool-call=browser_close:{"pageId":"${pageId}"}] Close active page`;

    const turn6PostRes = await fetch(`${platformUrl}/api/sessions/${aliceSession.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
        'Idempotency-Key': randomUUID().toLowerCase(),
      },
      body: JSON.stringify({ content: turn6Prompt }),
    });
    expect([200, 202]).toContain(turn6PostRes.status);
    const turn6Envelope = (await turn6PostRes.json()) as MessageEnvelope;
    const userMsg6Id = turn6Envelope.data.message.id;

    const asstTurn6 = await waitForAssistantReplyAfterUser(
      platformUrl,
      aliceSession.id,
      userMsg6Id,
      aliceAuth.cookie
    );
    expect(asstTurn6.status).toBe('delivered');
    expect(asstTurn6.content).toContain('Closed browser page');

    // Health confirms 0 active pages
    const healthAfterClose = await browserService.checkHealth();
    expect(healthAfterClose.activePages).toBe(0);

    // =========================================================================
    // 11. Multi-Tenant Session Isolation: Bob cannot access Alice's pageId
    // =========================================================================
    const bobHijackPrompt = `[enkeep-test-tool-call=browser_snapshot:{"pageId":"${pageId}"}] Attempt cross-tenant snapshot`;

    const bobPostRes = await fetch(`${platformUrl}/api/sessions/${bobSession.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': bobAuth.csrfToken,
        Origin: platformUrl,
        Cookie: bobAuth.cookie,
        'Idempotency-Key': randomUUID().toLowerCase(),
      },
      body: JSON.stringify({ content: bobHijackPrompt }),
    });
    expect([200, 202]).toContain(bobPostRes.status);
    const bobHijackEnvelope = (await bobPostRes.json()) as MessageEnvelope;
    const bobUserMsgId = bobHijackEnvelope.data.message.id;

    const asstBob = await waitForAssistantReplyAfterUser(
      platformUrl,
      bobSession.id,
      bobUserMsgId,
      bobAuth.cookie
    );
    expect(asstBob.status).toBe('delivered');
    // Result contains error / failure message (403 forbidden / not found / error)
    expect(asstBob.content.toLowerCase()).toMatch(/error|fail|not found|forbidden|403|unauthorized/);

    // Bob cannot list Alice's pending approvals
    const bobListResAfter = await fetch(`${platformUrl}/api/interactions/approvals`, {
      headers: { Cookie: bobAuth.cookie },
    });
    expect(bobListResAfter.status).toBe(200);
    const bobEnvelopeAfter = (await bobListResAfter.json()) as ApprovalsEnvelope;
    expect(bobEnvelopeAfter.data.length).toBe(0);

    // =========================================================================
    // 12. SSRF Boundary Negatives: Private non-allowlisted target is denied
    // =========================================================================
    const ssrfPrompt = `[enkeep-test-tool-call=browser_open:{"url":"http://169.254.169.254/latest/meta-data"}] Try opening cloud metadata`;

    const ssrfPostRes = await fetch(`${platformUrl}/api/sessions/${aliceSession.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        Cookie: aliceAuth.cookie,
        'Idempotency-Key': randomUUID().toLowerCase(),
      },
      body: JSON.stringify({ content: ssrfPrompt }),
    });
    expect([200, 202]).toContain(ssrfPostRes.status);
    const ssrfEnvelope = (await ssrfPostRes.json()) as MessageEnvelope;
    const ssrfUserMsgId = ssrfEnvelope.data.message.id;

    const asstSsrf = await waitForAssistantReplyAfterUser(
      platformUrl,
      aliceSession.id,
      ssrfUserMsgId,
      aliceAuth.cookie
    );
    expect(asstSsrf.status).toBe('delivered');
    expect(asstSsrf.content.toLowerCase()).toMatch(/error|fail|ssrf|forbidden|denied|blocked/);

    // =========================================================================
    // 13. Teardown Verification: No active pages or context leaks
    // =========================================================================
    const finalHealth = await browserService.checkHealth();
    expect(finalHealth.activePages).toBe(0);
  }, 180000);
});
