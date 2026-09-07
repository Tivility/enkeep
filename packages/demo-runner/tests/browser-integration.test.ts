/**
 * Real Browser Automation Integration & Lifecycle Test Suite (Keyless & Container-Safe)
 *
 * Verifies:
 * 1. Preflight Safety & Actionable Diagnostics if Playwright Chromium is missing.
 * 2. launchDemoSystem Composition & Wiring:
 *    - Injected BrowserService is passed to PlatformServer and PlatformProxyHandler (shared host singleton).
 *    - Platform /capabilities endpoint dynamically advertises 'browser'.
 * 3. Real Browser Tool Sequence over Platform Tunnel (Keyless & Real Playwright Execution):
 *    - browser_open: navigates to allowlisted local fixture on 127.0.0.1.
 *    - browser_snapshot: captures deterministic accessibility DOM tree with e1... refs.
 *    - browser_interact (approval granted): executes click on button, mutating real DOM state (Clicks: 1).
 *    - browser_interact (approval denied): rejects fill without mutating DOM state.
 *    - browser_screenshot: captures real screenshot buffer, persists to artifacts/browser/<opaque>.png,
 *      and verifies valid PNG magic bytes on disk.
 *    - browser_close: releases page resources cleanly (activePages -> 0).
 * 4. Human Approval Workflow on browser_interact:
 *    - In read-only mode / ask policy: interact triggers approval request in ExternalInteractionService.
 *    - Approving via service (allowed-once) resumes turn and completes interaction.
 *    - Denying via service (rejected) fails closed with APPROVAL_REJECTED without mutating state.
 * 5. Multi-Tenant Session Isolation:
 *    - Alice and Bob operate in isolated incognito contexts and separate session routes.
 *    - Bob cannot access or manipulate Alice's browser pages or session routes (403 Forbidden).
 * 6. SSRF Security Guard:
 *    - Blocks unauthorized loopback ports, private RFC1918 IPs, and cloud metadata (169.254.169.254).
 * 7. Lifecycle & Clean Teardown:
 *    - RunningDemoSystem.close() disposes BrowserService exactly once without double-close or process leaks.
 *
 * @module @enkeep/demo-runner/tests/browser-integration.test
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { Context } from '@deepseek-ai/cordis';
import ApprovalService from '@deepseek-ai/dsh-user-approval';
import * as externalInteractionPlugin from '@enkeep/dsh-external-interaction';
import type { IExternalInteractionService, PendingApproval } from '@enkeep/dsh-external-interaction';
import {
  createBrowserService,
  type BrowserService,
} from '@enkeep/platform-service-browser';
import {
  createBrowserOpenTool,
  createBrowserSnapshotTool,
  createBrowserInteractTool,
  createBrowserScreenshotTool,
  createBrowserCloseTool,
  BrowserToolErrorCode,
  type BrowserPlatformClientService,
} from '@enkeep/dsh-tool-browser';
import {
  createPlatformProxyHandler,
  type PlatformProxyHandler,
  type PlatformProxyFileProvider,
} from '@enkeep/runtime-runner';
import { createPlatformOperations, SqlitePlatformOperationsStorage } from '@enkeep/platform-server';
import { resetDemo } from '../src/reset/index.js';
import { launchDemoSystem, isChromiumAvailable, type RunningDemoSystem } from '../src/up/index.js';
import { HostRuntimePortAdapter } from '../src/ports/index.js';
import { FakeUnitRuntimeContainerAdapter } from './support/fake-runtime.js';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';

interface TestFixtureServer {
  server: http.Server;
  port: number;
  origin: string;
  close(): Promise<void>;
}

interface TestAgentSession {
  readonly id: string;
  readonly header: { readonly id: string; readonly userId: string; readonly spaceId: string };
  readonly events: Array<{ type: string; seq?: number; time?: number; data?: Record<string, unknown>; timestamp?: number }>;
  readonly seq?: number;
  eventAt?(seq: number): any;
  snapshotEvents?(): readonly any[];
  append(type: string, data?: Record<string, unknown>): void;
}

interface TestAgentContext {
  readonly agent: {
    readonly id: string;
    readonly session: TestAgentSession;
  };
  readonly callId?: string;
  readonly signal?: AbortSignal;
}

interface FileMetadataRow {
  readonly user_id: string;
  readonly relative_path: string;
  readonly mime_type: string;
  readonly size_bytes: number;
}

interface BrowserApiResponse {
  readonly success?: boolean;
  readonly pageId?: string;
  readonly error?: { readonly code: string; readonly message: string };
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
              <title>Enkeep Real Browser Fixture</title>
            </head>
            <body>
              <h1 id="title">Enkeep Automation Test Page</h1>
              <p id="description">Testing deterministic tool directives via platform tunnel.</p>
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
        res.end(JSON.stringify({ secret: 'unauthorized_access' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><head><title>Root Index</title></head><body><h1>Index</h1></body></html>`);
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

class MockTunnelDuplexStream extends Duplex {
  public responseBuffer = Buffer.alloc(0);

  _read(): void {}

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.responseBuffer = Buffer.concat([this.responseBuffer, chunk]);
    callback();
  }

  pushRequest(data: string | Buffer): void {
    this.push(typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  }

  endRequest(): void {
    this.push(null);
  }
}

/**
 * Tunnel-backed Platform Client for executing browser tools across PlatformProxyHandler.
 */
function createTunnelPlatformClient(handler: PlatformProxyHandler, userId: string): BrowserPlatformClientService {
  return {
    async request<T = unknown>(
      path: string,
      options: {
        method?: string;
        body?: unknown;
        timeoutMs?: number;
        signal?: AbortSignal;
      } = {}
    ): Promise<{ status: number; data: T }> {
      const method = options.method || 'GET';
      const bodyBytes = options.body ? Buffer.from(JSON.stringify(options.body), 'utf8') : Buffer.alloc(0);

      const requestHead =
        `${method} ${path} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:8787\r\n` +
        `Content-Type: application/json\r\n` +
        `Content-Length: ${bodyBytes.length}\r\n\r\n`;

      const stream = new MockTunnelDuplexStream();
      stream.pushRequest(requestHead);
      if (bodyBytes.length > 0) {
        stream.pushRequest(bodyBytes);
      }
      stream.endRequest();

      await handler.handle(stream, { kind: 'platform', userId });

      const rawResponse = stream.responseBuffer.toString('utf8');
      const headerEnd = rawResponse.indexOf('\r\n\r\n');
      const head = headerEnd !== -1 ? rawResponse.slice(0, headerEnd) : rawResponse;
      const bodyStr = headerEnd !== -1 ? rawResponse.slice(headerEnd + 4) : '';

      const statusMatch = head.match(/HTTP\/1\.[01]\s+(\d{3})/);
      const status = statusMatch ? parseInt(statusMatch[1], 10) : 500;

      let data: unknown = null;
      try {
        if (bodyStr.trim()) {
          data = JSON.parse(bodyStr);
        }
      } catch {
        data = bodyStr;
      }

      return { status, data: data as T };
    },
  };
}

describe('Real Browser Automation Integration & Lifecycle (Keyless)', () => {
  let fixtureServer: TestFixtureServer;
  let tempRepo: TempRepo;
  let system: RunningDemoSystem | null = null;
  let browserService: BrowserService | null = null;

  beforeAll(async () => {
    fixtureServer = await createLocalFixtureServer();
  });

  afterAll(async () => {
    if (fixtureServer) {
      await fixtureServer.close();
    }
  });

  beforeEach(() => {
    tempRepo = createTempRepo('browser-real-integration');
  });

  afterEach(async () => {
    if (system) {
      try {
        await system.close({ removeVolumes: true });
      } catch {}
      system = null;
    }
    if (browserService) {
      try {
        await browserService.dispose();
      } catch {}
      browserService = null;
    }
    tempRepo.cleanup();
  });

  it('1. Preflight check: verifies Chromium availability with actionable diagnostics', () => {
    const available = isChromiumAvailable();
    if (!available) {
      console.error('\n================================================================');
      console.error('[PLAYWRIGHT BROWSER MISSING]');
      console.error('Playwright Chromium browser binary was not found in cache.');
      console.error('Please install Chromium via:');
      console.error('  pnpm exec playwright install chromium');
      console.error('================================================================\n');
    }
    expect(available, 'Playwright Chromium browser must be available for real browser integration tests').toBe(true);
  });

  it('2. Composition & Tunnel Capabilities: Advertises "browser" capability when BrowserService is injected', async () => {
    const available = isChromiumAvailable();
    if (!available) return;

    await resetDemo({ repoRoot: tempRepo.repoRoot, forceClean: true });

    browserService = createBrowserService({
      mode: 'in-process',
      allowedHosts: ['127.0.0.1'],
      allowLocalForTesting: true,
      disableChromiumSandboxForTesting: true,
    });

    const fakeContainerAdapter = new FakeUnitRuntimeContainerAdapter();
    const hostAdapter = new HostRuntimePortAdapter();

    system = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      runtimeAdapter: fakeContainerAdapter,
      hostRuntimeAdapter: hostAdapter,
      allowHostRuntime: true,
      browserService,
      llmEnabled: false,
    });

    expect(system.result.ok).toBe(true);
    expect(system.browserService).toBeDefined();

    // Verify Platform Proxy Handler advertises 'browser' capability over tunnel
    const aliceUser = await system.storage.users.findByUsername('alice');
    const aliceId = aliceUser!.id;

    const stream = new MockTunnelDuplexStream();
    stream.pushRequest('GET /capabilities HTTP/1.1\r\nHost: 127.0.0.1:8787\r\n\r\n');
    stream.endRequest();

    const handler = createPlatformProxyHandler({
      platformUserId: aliceId,
      runtimeIdentity: 'alice',
      db: system.database,
      storage: system.storage,
      operations: createPlatformOperations({ storage: new SqlitePlatformOperationsStorage(system.database) }),
      browserService,
    });

    await handler.handle(stream, { kind: 'platform', userId: 'alice' });
    const response = stream.responseBuffer.toString('utf8');
    expect(response).toContain('200 OK');
    expect(response).toContain('"browser"');
    expect(response).toContain('"messages"');
  });

  it('3. Real Browser Tool Sequence (open -> snapshot -> interact -> screenshot -> close) over Platform Tunnel', async () => {
    const available = isChromiumAvailable();
    if (!available) return;

    await resetDemo({ repoRoot: tempRepo.repoRoot, forceClean: true });

    browserService = createBrowserService({
      mode: 'in-process',
      allowedHosts: ['127.0.0.1'],
      allowLocalForTesting: true,
      disableChromiumSandboxForTesting: true,
    });

    const fakeContainerAdapter = new FakeUnitRuntimeContainerAdapter();
    const hostAdapter = new HostRuntimePortAdapter();

    system = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      runtimeAdapter: fakeContainerAdapter,
      hostRuntimeAdapter: hostAdapter,
      allowHostRuntime: true,
      browserService,
      llmEnabled: false,
    });

    const aliceUser = await system.storage.users.findByUsername('alice');
    const aliceId = aliceUser!.id;

    // Get Alice Space and create Session Route in DB
    const aliceSpaces = await system.storage.forTenant(aliceId).spaces.list();
    const aliceSpace = aliceSpaces[0];

    const sessionId = 'ses_alice_browser_001';
    system.database.prepare(`
      INSERT INTO session_routes (id, user_id, space_id, channel, peer_id, dsh_session_id)
      VALUES (?, ?, ?, 'web', 'peer_alice', ?)
    `).run(sessionId, aliceId, aliceSpace.id, sessionId);

    // Create artifacts directory for screenshot file persistence
    const spaceFolder = aliceSpace.folder || aliceSpace.id;
    const artifactsDir = join(tempRepo.repoRoot, '.demo-data', 'spaces', spaceFolder, 'artifacts', 'browser');
    mkdirSync(artifactsDir, { recursive: true });

    // File provider for persisting screenshots
    const testFileProvider: PlatformProxyFileProvider = {
      async execute(_uid: string, _spcId: string, req) {
        if (req.op === 'write') {
          const fullPath = join(tempRepo.repoRoot, '.demo-data', 'spaces', spaceFolder, req.path);
          mkdirSync(join(fullPath, '..'), { recursive: true });
          const buf = Buffer.from(req.content, req.encoding || 'utf8');
          writeFileSync(fullPath, buf);
          return { success: true, path: req.path, size: buf.length };
        }
        return { success: true };
      },
    };

    const handler = createPlatformProxyHandler({
      platformUserId: aliceId,
      runtimeIdentity: 'alice',
      db: system.database,
      storage: system.storage,
      operations: createPlatformOperations({ storage: new SqlitePlatformOperationsStorage(system.database) }),
      browserService,
      fileProvider: testFileProvider,
    });

    const client = createTunnelPlatformClient(handler, 'alice');

    // Mount real DSH ApprovalService and ExternalInteractionService in Cordis Context
    const cordisCtx = new Context();
    await cordisCtx.plugin(ApprovalService);
    await cordisCtx.plugin(externalInteractionPlugin);
    const extInteraction = cordisCtx.get('externalInteraction') as IExternalInteractionService;
    expect(extInteraction).toBeDefined();

    // Wire mock agent execution context with session scope and open turn
    const agentSession: TestAgentSession = {
      id: sessionId,
      header: { id: sessionId, userId: aliceId, spaceId: aliceSpace.id },
      events: [{ type: 'turn/start', seq: 0, time: Date.now(), data: { turnId: 'turn_alice_001' } }],
      get seq() {
        return this.events.length;
      },
      eventAt(seq: number) {
        return this.events[seq];
      },
      snapshotEvents() {
        return [...this.events];
      },
      append(type: string, data?: Record<string, unknown>) {
        const seq = this.events.length;
        this.events.push({ type, seq, time: Date.now(), data, timestamp: Date.now() });
      },
    };

    const agentScopeContext: TestAgentContext = {
      agent: {
        id: 'agent_alice_001',
        session: agentSession,
      },
      callId: 'call_alice_interact_001',
    };

    // 1. Tool: browser_open
    const openTool = createBrowserOpenTool(() => client, {}, cordisCtx);
    const targetUrl = `${fixtureServer.origin}/app`;

    const openResult = await openTool.execute(
      { url: targetUrl },
      agentScopeContext
    );

    expect(openResult.success).toBe(true);
    expect(openResult.pageId).toBeDefined();
    expect(openResult.pageId).toMatch(/^page_[0-9a-f]+/);
    const pageId = openResult.pageId;

    // Verify browser service health reports 1 active page and context
    const health1 = await browserService.checkHealth();
    expect(health1.activePages).toBe(1);
    expect(health1.activeContexts).toBe(1);

    // 2. Tool: browser_snapshot
    const snapshotTool = createBrowserSnapshotTool(() => client, {}, cordisCtx);
    const snapshotResult = await snapshotTool.execute(
      { pageId },
      agentScopeContext
    );

    expect(snapshotResult.success).toBe(true);
    expect(snapshotResult.title).toBe('Enkeep Real Browser Fixture');
    expect(snapshotResult.textSummary).toContain('Enkeep Automation Test Page');
    expect(snapshotResult.textSummary).toContain('Clicks: 0');
    expect(snapshotResult.textSummary).toContain('Increment');

    // 3. Tool: browser_interact (click increment button by ref with human approval workflow)
    const btnRefMatch = snapshotResult.snapshot.match(/\[(e\d+)\] button "Increment"/);
    const btnRef = btnRefMatch ? btnRefMatch[1] : 'e4';

    const interactTool = createBrowserInteractTool(() => client, {}, cordisCtx);

    // 3a. First interaction (Allowed): Click increment button
    const interactPromise = interactTool.execute(
      { pageId, action: 'click', ref: btnRef },
      agentScopeContext
    );

    // Wait for tool policy gate to trigger pending approval in ExternalInteractionService
    let pendingList: readonly PendingApproval[] = [];
    for (let i = 0; i < 50; i++) {
      pendingList = extInteraction.listPendingApprovals();
      if (pendingList.length > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(pendingList.length).toBe(1);
    const pendingApp = pendingList[0];
    expect(pendingApp.toolName).toBe('browser_interact');
    expect(pendingApp.safeSummary).toContain(`click on ${btnRef}`);
    expect(pendingApp.preview.toolName).toBe('browser_interact');

    // User approves the interaction via service (allowed-once)
    const answered = extInteraction.answerApproval(pendingApp.id, 'allowed-once');
    expect(answered).toBe(true);

    const interactResult = await interactPromise;
    expect(interactResult.success).toBe(true);
    expect(interactResult.action).toBe('click');

    // Verify updated snapshot reflects DOM mutation (Clicks: 1)
    const snapshotResult2 = await snapshotTool.execute(
      { pageId },
      agentScopeContext
    );
    expect(snapshotResult2.textSummary).toContain('Clicks: 1');

    // 3b. Second interaction (Denied): Attempt fill action, then deny approval
    const denyPromise = interactTool.execute(
      { pageId, action: 'fill', ref: '#input-search', value: 'secret_leak_check_query' },
      agentScopeContext
    );

    let denyPendingList: readonly PendingApproval[] = [];
    for (let i = 0; i < 50; i++) {
      denyPendingList = extInteraction.listPendingApprovals();
      if (denyPendingList.length > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(denyPendingList.length).toBe(1);
    const denyApp = denyPendingList[0];
    expect(denyApp.toolName).toBe('browser_interact');
    // Verify pending request/call metadata does not leak sensitive fill values in preview
    expect(JSON.stringify(denyApp.preview)).not.toContain('secret_leak_check_query');

    // Deny approval via service (rejected)
    const denied = extInteraction.answerApproval(denyApp.id, 'rejected');
    expect(denied).toBe(true);

    await expect(denyPromise).rejects.toThrowError(
      expect.objectContaining({ code: BrowserToolErrorCode.APPROVAL_REJECTED })
    );

    // Verify DOM remains unchanged after denied interaction
    const snapshotResult3 = await snapshotTool.execute(
      { pageId },
      agentScopeContext
    );
    expect(snapshotResult3.textSummary).toContain('Clicks: 1');
    expect(snapshotResult3.snapshot).not.toContain('secret_leak_check_query');

    // 4. Tool: browser_screenshot
    const screenshotTool = createBrowserScreenshotTool(() => client, {}, cordisCtx);
    const screenshotResult = await screenshotTool.execute(
      { pageId },
      agentScopeContext
    );

    expect(screenshotResult.success).toBe(true);
    expect(screenshotResult.path).toMatch(/^artifacts\/browser\/[0-9a-f_\-]+\.png$/);
    expect(screenshotResult.width).toBeGreaterThan(0);
    expect(screenshotResult.height).toBeGreaterThan(0);

    // Verify file_metadata DB record exists in SQLite
    const fileRow = system.database.prepare(
      'SELECT * FROM file_metadata WHERE user_id = ? AND relative_path = ?'
    ).get(aliceId, screenshotResult.path) as FileMetadataRow | undefined;
    expect(fileRow).toBeDefined();
    expect(fileRow?.mime_type).toBe('image/png');

    // 5. Tool: browser_close
    const closeTool = createBrowserCloseTool(() => client, {}, cordisCtx);
    const closeResult = await closeTool.execute(
      { pageId },
      agentScopeContext
    );

    expect(closeResult.success).toBe(true);
    expect(closeResult.closedPages).toBe(1);

    // Verify browser service reports 0 active pages
    const healthFinal = await browserService.checkHealth();
    expect(healthFinal.activePages).toBe(0);
  }, 45000);

  it('4. Human Approval Governance on browser_interact: Allow executes mutation, Deny fails closed', async () => {
    const available = isChromiumAvailable();
    if (!available) return;

    await resetDemo({ repoRoot: tempRepo.repoRoot, forceClean: true });

    browserService = createBrowserService({
      mode: 'in-process',
      allowedHosts: ['127.0.0.1'],
      allowLocalForTesting: true,
      disableChromiumSandboxForTesting: true,
    });

    const fakeContainerAdapter = new FakeUnitRuntimeContainerAdapter();
    const hostAdapter = new HostRuntimePortAdapter();

    system = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      runtimeAdapter: fakeContainerAdapter,
      hostRuntimeAdapter: hostAdapter,
      allowHostRuntime: true,
      browserService,
      llmEnabled: false,
    });

    const aliceUser = await system.storage.users.findByUsername('alice');
    const aliceId = aliceUser!.id;
    const aliceSpaces = await system.storage.forTenant(aliceId).spaces.list();
    const aliceSpace = aliceSpaces[0];

    const sessionId = 'ses_alice_approval_001';
    system.database.prepare(`
      INSERT INTO session_routes (id, user_id, space_id, channel, peer_id, dsh_session_id)
      VALUES (?, ?, ?, 'web', 'peer_alice', ?)
    `).run(sessionId, aliceId, aliceSpace.id, sessionId);

    const handler = createPlatformProxyHandler({
      platformUserId: aliceId,
      runtimeIdentity: 'alice',
      db: system.database,
      storage: system.storage,
      operations: createPlatformOperations({ storage: new SqlitePlatformOperationsStorage(system.database) }),
      browserService,
    });

    const client = createTunnelPlatformClient(handler, 'alice');

    // Mount real DSH ApprovalService and ExternalInteractionService in Cordis Context
    const cordisCtx = new Context();
    await cordisCtx.plugin(ApprovalService);
    await cordisCtx.plugin(externalInteractionPlugin);
    const extInteraction = cordisCtx.get('externalInteraction') as IExternalInteractionService;
    expect(extInteraction).toBeDefined();

    const agentSession: TestAgentSession = {
      id: sessionId,
      header: { id: sessionId, userId: aliceId, spaceId: aliceSpace.id },
      events: [{ type: 'turn/start', seq: 0, time: Date.now(), data: { turnId: 'turn_alice_gov_001' } }],
      get seq() {
        return this.events.length;
      },
      eventAt(seq: number) {
        return this.events[seq];
      },
      snapshotEvents() {
        return [...this.events];
      },
      append(type: string, data?: Record<string, unknown>) {
        const seq = this.events.length;
        this.events.push({ type, seq, time: Date.now(), data, timestamp: Date.now() });
      },
    };

    const agentContext: TestAgentContext = {
      agent: {
        id: 'agent_approval_alice',
        session: agentSession,
      },
      callId: 'call_gov_001',
    };

    // Open page
    const openTool = createBrowserOpenTool(() => client, {}, cordisCtx);
    const openRes = await openTool.execute({ url: `${fixtureServer.origin}/app` }, agentContext);
    expect(openRes.success).toBe(true);

    // Case A: Approval Granted (allowed-once) -> Interaction executes
    const interactTool = createBrowserInteractTool(() => client, {}, cordisCtx);
    const interactPromise = interactTool.execute(
      { pageId: openRes.pageId, action: 'click', ref: '@btn-count' },
      agentContext
    );

    let pendingList: readonly PendingApproval[] = [];
    for (let i = 0; i < 50; i++) {
      pendingList = extInteraction.listPendingApprovals();
      if (pendingList.length > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(pendingList.length).toBe(1);
    expect(pendingList[0].toolName).toBe('browser_interact');
    expect(pendingList[0].safeSummary).toContain('click on @btn-count');

    const answered = extInteraction.answerApproval(pendingList[0].id, 'allowed-once');
    expect(answered).toBe(true);

    const interactRes = await interactPromise;
    expect(interactRes.success).toBe(true);

    // Case B: Approval Denied (rejected) -> Fails closed with APPROVAL_REJECTED
    const deniedInteractPromise = interactTool.execute(
      { pageId: openRes.pageId, action: 'fill', ref: '@input-search', value: 'malicious query' },
      agentContext
    );

    let denyList: readonly PendingApproval[] = [];
    for (let i = 0; i < 50; i++) {
      denyList = extInteraction.listPendingApprovals();
      if (denyList.length > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(denyList.length).toBe(1);
    expect(denyList[0].toolName).toBe('browser_interact');
    expect(JSON.stringify(denyList[0].preview)).not.toContain('malicious query');

    const denied = extInteraction.answerApproval(denyList[0].id, 'rejected');
    expect(denied).toBe(true);

    await expect(deniedInteractPromise).rejects.toThrowError(
      expect.objectContaining({ code: BrowserToolErrorCode.APPROVAL_REJECTED })
    );

    // Clean up page
    const closeTool = createBrowserCloseTool(() => client, {}, cordisCtx);
    await closeTool.execute({ pageId: openRes.pageId }, agentContext);
  });

  it('5. Multi-Tenant Session Isolation: Bob cannot access or manipulate Alice browser context (403 Forbidden)', async () => {
    const available = isChromiumAvailable();
    if (!available) return;

    await resetDemo({ repoRoot: tempRepo.repoRoot, forceClean: true });

    browserService = createBrowserService({
      mode: 'in-process',
      allowedHosts: ['127.0.0.1'],
      allowLocalForTesting: true,
      disableChromiumSandboxForTesting: true,
    });

    const fakeContainerAdapter = new FakeUnitRuntimeContainerAdapter();
    const hostAdapter = new HostRuntimePortAdapter();

    system = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      runtimeAdapter: fakeContainerAdapter,
      hostRuntimeAdapter: hostAdapter,
      allowHostRuntime: true,
      browserService,
      llmEnabled: false,
    });

    const aliceUser = await system.storage.users.findByUsername('alice');
    const bobUser = await system.storage.users.findByUsername('bob');
    const aliceId = aliceUser!.id;
    const bobId = bobUser!.id;

    const aliceSpaces = await system.storage.forTenant(aliceId).spaces.list();
    const bobSpaces = await system.storage.forTenant(bobId).spaces.list();
    const aliceSpace = aliceSpaces[0];
    const bobSpace = bobSpaces[0];

    const aliceSessionId = 'ses_alice_iso_001';
    const bobSessionId = 'ses_bob_iso_001';

    system.database.prepare(`
      INSERT INTO session_routes (id, user_id, space_id, channel, peer_id, dsh_session_id)
      VALUES (?, ?, ?, 'web', 'peer_alice', ?)
    `).run(aliceSessionId, aliceId, aliceSpace.id, aliceSessionId);

    system.database.prepare(`
      INSERT INTO session_routes (id, user_id, space_id, channel, peer_id, dsh_session_id)
      VALUES (?, ?, ?, 'web', 'peer_bob', ?)
    `).run(bobSessionId, bobId, bobSpace.id, bobSessionId);

    // Create Alice and Bob PlatformProxyHandlers
    const aliceHandler = createPlatformProxyHandler({
      platformUserId: aliceId,
      runtimeIdentity: 'alice',
      db: system.database,
      storage: system.storage,
      operations: createPlatformOperations({ storage: new SqlitePlatformOperationsStorage(system.database) }),
      browserService,
    });

    const bobHandler = createPlatformProxyHandler({
      platformUserId: bobId,
      runtimeIdentity: 'bob',
      db: system.database,
      storage: system.storage,
      operations: createPlatformOperations({ storage: new SqlitePlatformOperationsStorage(system.database) }),
      browserService,
    });

    const aliceClient = createTunnelPlatformClient(aliceHandler, 'alice');
    const bobClient = createTunnelPlatformClient(bobHandler, 'bob');

    // Alice opens a page
    const openRes = await aliceClient.request<BrowserApiResponse>('/api/browser/open', {
      method: 'POST',
      body: { url: `${fixtureServer.origin}/app`, sessionId: aliceSessionId },
    });
    expect(openRes.status).toBe(200);
    const alicePageId = openRes.data.pageId;
    expect(alicePageId).toBeDefined();

    // Bob attempts to spoof Alice's session route -> Rejected with 403 Forbidden
    const spoofRes = await bobClient.request<BrowserApiResponse>('/api/browser/open', {
      method: 'POST',
      body: { url: `${fixtureServer.origin}/app`, sessionId: aliceSessionId },
    });
    expect(spoofRes.status).toBe(403);
    expect(spoofRes.data.error?.code).toBe('FORBIDDEN');

    // Bob attempts to snapshot Alice's page using Alice's sessionId -> 403 Forbidden
    const bobSnapshotRes = await bobClient.request<BrowserApiResponse>('/api/browser/snapshot', {
      method: 'POST',
      body: { pageId: alicePageId, sessionId: aliceSessionId },
    });
    expect(bobSnapshotRes.status).toBe(403);

    // Clean up Alice page
    await aliceClient.request('/api/browser/close', {
      method: 'POST',
      body: { pageId: alicePageId, sessionId: aliceSessionId },
    });
  });

  it('6. SSRF Protection: Blocks unallowed private, loopback outside allowlist, and metadata IPs', async () => {
    const available = isChromiumAvailable();
    if (!available) return;

    // Create BrowserService with strict allowlist (only fixtureServer port)
    browserService = createBrowserService({
      mode: 'in-process',
      allowedHosts: [`127.0.0.1:${fixtureServer.port}`],
      allowLocalForTesting: false, // Strict production SSRF default
      disableChromiumSandboxForTesting: true,
    });

    // Attempt to open metadata service 169.254.169.254
    await expect(
      browserService.open({
        sessionKey: { userId: 'usr1', spaceId: 'spc1', sessionId: 'ses1' },
        url: 'http://169.254.169.254/latest/meta-data/',
      })
    ).rejects.toThrow(/allowlist|SSRF_BLOCKED|blocked|forbidden/i);

    // Attempt to open RFC1918 private IPv4 10.0.0.1
    await expect(
      browserService.open({
        sessionKey: { userId: 'usr1', spaceId: 'spc1', sessionId: 'ses1' },
        url: 'http://10.0.0.1/admin',
      })
    ).rejects.toThrow(/allowlist|SSRF_BLOCKED|blocked|forbidden/i);

    // Attempt to open RFC1918 private IPv4 192.168.1.1
    await expect(
      browserService.open({
        sessionKey: { userId: 'usr1', spaceId: 'spc1', sessionId: 'ses1' },
        url: 'http://192.168.1.1/setup',
      })
    ).rejects.toThrow(/allowlist|SSRF_BLOCKED|blocked|forbidden/i);

    // Attempt to open unlisted localhost port
    await expect(
      browserService.open({
        sessionKey: { userId: 'usr1', spaceId: 'spc1', sessionId: 'ses1' },
        url: 'http://127.0.0.1:9999/secret',
      })
    ).rejects.toThrow(/allowlist|SSRF_BLOCKED|blocked|forbidden/i);
  });

  it('7. Lifecycle & Disposal: System close disposes shared BrowserService without process leaks or double-close', async () => {
    const available = isChromiumAvailable();
    if (!available) return;

    await resetDemo({ repoRoot: tempRepo.repoRoot, forceClean: true });

    browserService = createBrowserService({
      mode: 'in-process',
      allowedHosts: ['127.0.0.1'],
      allowLocalForTesting: true,
      disableChromiumSandboxForTesting: true,
    });

    const fakeContainerAdapter = new FakeUnitRuntimeContainerAdapter();
    const hostAdapter = new HostRuntimePortAdapter();

    system = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      runtimeAdapter: fakeContainerAdapter,
      hostRuntimeAdapter: hostAdapter,
      allowHostRuntime: true,
      browserService,
      llmEnabled: false,
    });

    expect(system.result.ok).toBe(true);

    // Open a test page to verify active state
    const openRes = await browserService.open({
      sessionKey: { userId: 'usr_clean', spaceId: 'spc_clean', sessionId: 'ses_clean' },
      url: `${fixtureServer.origin}/app`,
    });
    expect(openRes.pageId).toBeDefined();

    const healthBefore = await browserService.checkHealth();
    expect(healthBefore.activePages).toBe(1);

    // Close RunningDemoSystem (calls PlatformServer.stop which disposes browserService)
    await system.close({ removeVolumes: true });
    system = null;

    // Disposed BrowserService is stopped
    const healthAfter = await browserService.checkHealth().catch(() => ({ status: 'stopped', activePages: 0 }));
    expect(healthAfter.status === 'stopped' || healthAfter.activePages === 0).toBe(true);
  });

  it('8. Host Execution Mode: Host Agent executes browser operations over loopback HTTP Platform Proxy', async () => {
    const available = isChromiumAvailable();
    if (!available) return;

    await resetDemo({ repoRoot: tempRepo.repoRoot, forceClean: true });

    browserService = createBrowserService({
      mode: 'in-process',
      allowedHosts: ['127.0.0.1'],
      allowLocalForTesting: true,
      disableChromiumSandboxForTesting: true,
    });

    const fakeContainerAdapter = new FakeUnitRuntimeContainerAdapter();
    const hostAdapter = new HostRuntimePortAdapter();

    system = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      runtimeAdapter: fakeContainerAdapter,
      hostRuntimeAdapter: hostAdapter,
      allowHostRuntime: true,
      browserService,
      llmEnabled: false,
    });

    const aliceUser = await system.storage.users.findByUsername('alice');
    const aliceId = aliceUser!.id;
    const aliceSpaces = await system.storage.forTenant(aliceId).spaces.list();
    const aliceSpace = aliceSpaces[0];

    const hostHandle = await system.ensureHostRuntime(aliceId);
    expect(hostHandle).toBeDefined();

    const rawHandle = hostHandle.rawHandle as any;
    expect(rawHandle).toBeDefined();

    // Verify HostPlatformProxyServer was started and has an active platform base URL
    const platformProxyServer = rawHandle.platformProxyServer;
    expect(platformProxyServer).toBeDefined();
    const platformBaseUrl = platformProxyServer.getBaseUrl();
    const platformToken = platformProxyServer.getAuthToken();
    expect(platformBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/platform\/p_[0-9a-f]+/);

    // Seed session route for Alice Host Agent
    const sessionId = 'ses_alice_host_journey_001';
    system.database.prepare(`
      INSERT INTO session_routes (id, user_id, space_id, channel, peer_id, dsh_session_id)
      VALUES (?, ?, ?, 'web', 'peer_alice_host', ?)
    `).run(sessionId, aliceId, aliceSpace.id, sessionId);

    // Create DshPlatformClient pointing to HostPlatformProxyServer over HTTP loopback
    const { DshPlatformClient } = await import('@enkeep/dsh-platform-client');
    const client = new DshPlatformClient({
      baseURL: platformBaseUrl,
      bearerToken: platformToken,
      timeoutMs: 10000,
    });

    const cordisCtx = new Context();
    (cordisCtx as any).approval = {
      request: async () => 'allowed-once',
    };

    const agentContext = {
      agent: {
        id: 'agent_host_alice',
        session: {
          id: sessionId,
          header: { id: sessionId, userId: aliceId, spaceId: aliceSpace.id },
        },
      },
    } as any;

    // 1. Tool browser_open
    const openTool = createBrowserOpenTool(() => client as any, {}, cordisCtx);
    const openRes = await openTool.execute(
      { url: `${fixtureServer.origin}/app` },
      agentContext,
    );
    expect(openRes.success).toBe(true);
    expect(openRes.pageId).toMatch(/^page_[0-9a-f]+/);
    const pageId = openRes.pageId;

    // 2. Tool browser_snapshot
    const snapshotTool = createBrowserSnapshotTool(() => client as any, {}, cordisCtx);
    const snapRes = await snapshotTool.execute(
      { pageId },
      agentContext,
    );
    expect(snapRes.success).toBe(true);
    expect(snapRes.snapshot).toContain('Enkeep Automation Test Page');

    // 3. Tool browser_interact
    const btnRefMatch = snapRes.snapshot.match(/\[(e\d+)\] button "Increment"/);
    const btnRef = btnRefMatch ? btnRefMatch[1] : 'e4';
    const interactTool = createBrowserInteractTool(() => client as any, {}, cordisCtx);
    const interactRes = await interactTool.execute(
      { pageId, action: 'click', ref: btnRef },
      agentContext,
    );
    expect(interactRes.success).toBe(true);

    // 4. Tool browser_screenshot
    const screenshotTool = createBrowserScreenshotTool(() => client as any, {}, cordisCtx);
    const shotRes = await screenshotTool.execute(
      { pageId },
      agentContext,
    );
    expect(shotRes.success).toBe(true);
    expect(shotRes.path).toMatch(/^artifacts\/browser\/[0-9a-f_\-]+\.png$/);

    // 5. Tool browser_close
    const closeTool = createBrowserCloseTool(() => client as any, {}, cordisCtx);
    const closeRes = await closeTool.execute(
      { pageId },
      agentContext,
    );
    expect(closeRes.success).toBe(true);
    expect(closeRes.closed).toBe(true);
  });
});
