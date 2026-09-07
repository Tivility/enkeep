/**
 * PlatformProxyHandler MCP Operations & Routes Test Suite
 *
 * Validates:
 * 1. Canonical MCP internal routes on PlatformProxyHandler:
 *    - GET /api/mcp/tools (with required query sessionId)
 *    - POST /api/mcp/call (with strict body { sessionId, toolName, args, requestId })
 *    - POST /api/mcp/cancel (with strict body { sessionId, requestId })
 *    - GET /api/mcp/health (user-level health)
 * 2. Fail-closed on old aliases and unauthorized routes (HTTP 404):
 *    - GET /api/mcp/:contributionId/tools -> 404
 *    - POST /api/mcp/tools/call -> 404
 *    - GET /mcp/tools -> 404
 *    - POST /mcp/call -> 404
 *    - POST /api/mcp/reconcile -> 404
 *    - POST /reconcile -> 404
 * 3. Method restrictions (HTTP 405 Method Not Allowed).
 * 4. Strict request validation:
 *    - Rejects missing or extra/spoofed parameters (HTTP 400).
 *    - Rejects invalid parameter types.
 * 5. Tenant isolation & space resolution:
 *    - Cross-tenant session spoofing is blocked (HTTP 403).
 * 6. Audit logging:
 *    - Safe noarg values for mcp.call (excludes args payload).
 *    - mcp.cancel audit logging.
 * 7. Capability advertising:
 *    - Advertises 'mcp' in /capabilities when mcpService is present and healthy.
 *    - Omits 'mcp' when mcpService is missing or unhealthy.
 * 8. Unconfigured service behavior (HTTP 503).
 *
 * @module @enkeep/runtime-runner/tests/platform-proxy-mcp.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Duplex, PassThrough } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import {
  PlatformProxyHandler,
  createPlatformProxyHandler,
  PLATFORM_STREAM_KIND,
  type PlatformProxyMcpService,
  type McpProxyContext,
} from '../src/tunnel/platform-proxy.js';

const ALICE_PLATFORM_ID = '11111111-1111-4111-8111-111111111111';
const BOB_PLATFORM_ID = '22222222-2222-4222-8222-222222222222';

function createTestDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');

  db.exec(`
    CREATE TABLE spaces (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      folder TEXT NOT NULL
    );

    INSERT INTO spaces (id, user_id, name, folder) VALUES ('sp_alice', '${ALICE_PLATFORM_ID}', 'Workspace', 'default');
    INSERT INTO spaces (id, user_id, name, folder) VALUES ('sp_bob', '${BOB_PLATFORM_ID}', 'Workspace', 'default');

    CREATE TABLE session_routes (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      dsh_session_id TEXT NOT NULL
    );

    INSERT INTO session_routes (id, space_id, user_id, channel, peer_id, dsh_session_id)
    VALUES ('ses_alice_1', 'sp_alice', '${ALICE_PLATFORM_ID}', 'web', 'peer_alice', 'dsh_ses_alice_1');
    INSERT INTO session_routes (id, space_id, user_id, channel, peer_id, dsh_session_id)
    VALUES ('ses_bob_1', 'sp_bob', '${BOB_PLATFORM_ID}', 'web', 'peer_bob', 'dsh_ses_bob_1');

    CREATE TABLE auth_audit_log (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );
  `);

  return db;
}

function createMockStream(): { clientStream: Duplex; serverStream: Duplex } {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();

  const clientStream = new Duplex({
    read(size) {
      return serverToClient.read(size);
    },
    write(chunk, encoding, callback) {
      return clientToServer.write(chunk, encoding, callback);
    },
    final(callback) {
      clientToServer.end(callback);
    },
  });

  const serverStream = new Duplex({
    read(size) {
      return clientToServer.read(size);
    },
    write(chunk, encoding, callback) {
      return serverToClient.write(chunk, encoding, callback);
    },
    final(callback) {
      serverToClient.end(callback);
    },
  });

  serverToClient.on('data', (chunk) => clientStream.push(chunk));
  serverToClient.on('end', () => clientStream.push(null));
  clientToServer.on('data', (chunk) => serverStream.push(chunk));
  clientToServer.on('end', () => serverStream.push(null));

  return { clientStream, serverStream };
}

async function sendHttpRequest(
  handler: PlatformProxyHandler,
  method: string,
  path: string,
  body?: unknown,
  userId = 'alice'
): Promise<{ status: number; headers: Record<string, string>; json: any }> {
  const { clientStream, serverStream } = createMockStream();

  const handlePromise = handler.handle(serverStream, {
    kind: PLATFORM_STREAM_KIND,
    userId,
  });

  const payload = body !== undefined ? JSON.stringify(body) : '';
  const headers = [
    `${method} ${path} HTTP/1.1`,
    'Host: 127.0.0.1:8787',
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(payload, 'utf8')}`,
    'Connection: close',
    '',
    '',
  ].join('\r\n');

  clientStream.write(headers);
  if (payload) {
    clientStream.write(payload);
  }
  clientStream.end();

  const chunks: Buffer[] = [];
  for await (const chunk of clientStream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  await handlePromise;

  const rawRes = Buffer.concat(chunks).toString('utf8');
  const headerEnd = rawRes.indexOf('\r\n\r\n');
  const headerText = rawRes.slice(0, headerEnd);
  const bodyText = rawRes.slice(headerEnd + 4);

  const statusLine = headerText.split('\r\n')[0] || '';
  const statusCode = parseInt(statusLine.split(' ')[1] || '500', 10);

  let json: any = null;
  try {
    json = JSON.parse(bodyText);
  } catch {}

  return { status: statusCode, headers: {}, json };
}

describe('PlatformProxyHandler MCP Integration & Canonical Routes', () => {
  let db: DatabaseSync;
  let mockMcpService: PlatformProxyMcpService;

  beforeEach(() => {
    db = createTestDatabase();
    mockMcpService = {
      listTools: vi.fn().mockImplementation(async (_ctx: McpProxyContext) => {
        return [
          {
            serverId: 'github_contrib',
            name: 'mcp__github_contrib__search_repos',
            description: 'Search GitHub',
            originalName: 'search_repos',
            inputSchema: { type: 'object' },
          },
          {
            serverId: 'sqlite_contrib',
            name: 'mcp__sqlite_contrib__read_query',
            description: 'Read SQLite',
            originalName: 'read_query',
            inputSchema: { type: 'object' },
          },
        ];
      }),
      callTool: vi.fn().mockImplementation(async (name: string, args: Record<string, unknown>, ctx: McpProxyContext) => {
        return {
          content: [{ type: 'text', text: `Called ${name} with ${JSON.stringify(args)}` }],
          structuredContent: { tool: name, args, sessionId: ctx.sessionId },
        };
      }),
      checkHealth: vi.fn().mockResolvedValue([
        {
          serverId: 'github_contrib',
          status: 'healthy',
          circuitState: 'CLOSED',
          consecutiveFailures: 0,
          activeProcesses: 1,
        },
      ]),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    db.close();
  });

  describe('1. Canonical Routes & Happy Path', () => {
    it('handles GET /api/mcp/tools?sessionId=ses_alice_1 and lists all tools with canonical names', async () => {
      const handler = createPlatformProxyHandler({
        platformUserId: ALICE_PLATFORM_ID,
        runtimeIdentity: 'alice',
        db,
        mcpService: mockMcpService,
      });

      const res = await sendHttpRequest(handler, 'GET', '/api/mcp/tools?sessionId=ses_alice_1');
      expect(res.status).toBe(200);
      expect(res.json.success).toBe(true);
      expect(res.json.data.tools).toHaveLength(2);
      expect(res.json.data.tools[0].name).toBe('mcp__github_contrib__search_repos');
      expect(res.json.data.tools[1].name).toBe('mcp__sqlite_contrib__read_query');
      expect(mockMcpService.listTools).toHaveBeenCalledWith({
        userId: ALICE_PLATFORM_ID,
        spaceId: 'sp_alice',
        sessionId: 'ses_alice_1',
      });
    });

    it('handles POST /api/mcp/call with strict body { sessionId, toolName, args, requestId } and canonical tool name', async () => {
      const handler = createPlatformProxyHandler({
        platformUserId: ALICE_PLATFORM_ID,
        runtimeIdentity: 'alice',
        db,
        mcpService: mockMcpService,
      });

      const res = await sendHttpRequest(handler, 'POST', '/api/mcp/call', {
        sessionId: 'ses_alice_1',
        toolName: 'mcp__sqlite_contrib__read_query',
        args: { sql: 'SELECT 1', secret_key: 'topsecret' },
        requestId: 'req_12345',
      });

      expect(res.status).toBe(200);
      expect(res.json.success).toBe(true);
      expect(res.json.data.content[0].text).toContain('SELECT 1');
      expect(res.json.data.structuredContent.sessionId).toBe('ses_alice_1');
      expect(mockMcpService.callTool).toHaveBeenCalledWith(
        'mcp__sqlite_contrib__read_query',
        { sql: 'SELECT 1', secret_key: 'topsecret' },
        {
          userId: ALICE_PLATFORM_ID,
          spaceId: 'sp_alice',
          sessionId: 'ses_alice_1',
          requestId: 'req_12345',
        }
      );

      // Verify safe no-arg audit logging: secret_key / sql must NOT be in audit log
      const auditRow = db.prepare("SELECT * FROM auth_audit_log WHERE action = 'mcp.call'").get() as any;
      expect(auditRow).toBeDefined();
      const details = JSON.parse(auditRow.details);
      expect(details.toolName).toBe('mcp__sqlite_contrib__read_query');
      expect(details.sessionId).toBe('ses_alice_1');
      expect(details.spaceId).toBe('sp_alice');
      expect(details.requestId).toBe('req_12345');
      expect(details.args).toBeUndefined();
      expect(JSON.stringify(details)).not.toContain('topsecret');
    });

    it('handles POST /api/mcp/cancel with strict body { sessionId, requestId }', async () => {
      const handler = createPlatformProxyHandler({
        platformUserId: ALICE_PLATFORM_ID,
        runtimeIdentity: 'alice',
        db,
        mcpService: mockMcpService,
      });

      const res = await sendHttpRequest(handler, 'POST', '/api/mcp/cancel', {
        sessionId: 'ses_alice_1',
        requestId: 'req_cancel_1',
      });

      expect(res.status).toBe(200);
      expect(res.json.success).toBe(true);
      expect(mockMcpService.cancel).toHaveBeenCalledWith({
        requestId: 'req_cancel_1',
        context: {
          userId: ALICE_PLATFORM_ID,
          spaceId: 'sp_alice',
          sessionId: 'ses_alice_1',
          requestId: 'req_cancel_1',
        },
      });

      // Verify audit log for cancel
      const auditRow = db.prepare("SELECT * FROM auth_audit_log WHERE action = 'mcp.cancel'").get() as any;
      expect(auditRow).toBeDefined();
      const details = JSON.parse(auditRow.details);
      expect(details.requestId).toBe('req_cancel_1');
      expect(details.sessionId).toBe('ses_alice_1');
      expect(details.spaceId).toBe('sp_alice');
    });

    it('handles GET /api/mcp/health (user level, no session required)', async () => {
      const handler = createPlatformProxyHandler({
        platformUserId: ALICE_PLATFORM_ID,
        runtimeIdentity: 'alice',
        db,
        mcpService: mockMcpService,
      });

      const res = await sendHttpRequest(handler, 'GET', '/api/mcp/health');
      expect(res.status).toBe(200);
      expect(res.json.success).toBe(true);
      expect(res.json.data.health).toHaveLength(1);
      expect(res.json.data.health[0].status).toBe('healthy');
      expect(mockMcpService.checkHealth).toHaveBeenCalledWith({
        userId: ALICE_PLATFORM_ID,
      });
    });
  });

  describe('2. Strict Parameter Validation & Spoofing Rejection', () => {
    it('rejects GET /api/mcp/tools when sessionId query parameter is missing (400)', async () => {
      const handler = createPlatformProxyHandler({
        platformUserId: ALICE_PLATFORM_ID,
        runtimeIdentity: 'alice',
        db,
        mcpService: mockMcpService,
      });

      const res = await sendHttpRequest(handler, 'GET', '/api/mcp/tools');
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe('VALIDATION_ERROR');
      expect(res.json.error.message).toContain('sessionId');
    });

    it('rejects GET /api/mcp/tools with unknown query parameters (400)', async () => {
      const handler = createPlatformProxyHandler({
        platformUserId: ALICE_PLATFORM_ID,
        runtimeIdentity: 'alice',
        db,
        mcpService: mockMcpService,
      });

      const res = await sendHttpRequest(handler, 'GET', '/api/mcp/tools?sessionId=ses_alice_1&spoofedSpaceId=evil');
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe('VALIDATION_ERROR');
      expect(res.json.error.message).toContain('Unknown query parameter');
    });

    it('rejects POST /api/mcp/call when required fields are missing (400)', async () => {
      const handler = createPlatformProxyHandler({
        platformUserId: ALICE_PLATFORM_ID,
        runtimeIdentity: 'alice',
        db,
        mcpService: mockMcpService,
      });

      // Missing toolName
      const res1 = await sendHttpRequest(handler, 'POST', '/api/mcp/call', {
        sessionId: 'ses_alice_1',
      });
      expect(res1.status).toBe(400);
      expect(res1.json.error.code).toBe('VALIDATION_ERROR');

      // Missing sessionId
      const res2 = await sendHttpRequest(handler, 'POST', '/api/mcp/call', {
        toolName: 'mcp__sqlite_contrib__read_query',
      });
      expect(res2.status).toBe(400);
      expect(res2.json.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects POST /api/mcp/call with unknown or spoofed payload fields (400)', async () => {
      const handler = createPlatformProxyHandler({
        platformUserId: ALICE_PLATFORM_ID,
        runtimeIdentity: 'alice',
        db,
        mcpService: mockMcpService,
      });

      const res = await sendHttpRequest(handler, 'POST', '/api/mcp/call', {
        sessionId: 'ses_alice_1',
        toolName: 'mcp__sqlite_contrib__read_query',
        args: {},
        userId: 'spoofed_user_id', // Spoofed
      });
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe('VALIDATION_ERROR');
      expect(res.json.error.message).toContain('Unknown parameter "userId"');
    });

    it('rejects POST /api/mcp/cancel with unknown or spoofed payload fields (400)', async () => {
      const handler = createPlatformProxyHandler({
        platformUserId: ALICE_PLATFORM_ID,
        runtimeIdentity: 'alice',
        db,
        mcpService: mockMcpService,
      });

      const res = await sendHttpRequest(handler, 'POST', '/api/mcp/cancel', {
        sessionId: 'ses_alice_1',
        requestId: 'req_1',
        contributionId: 'sqlite_contrib', // Extra/unsupported key
      });
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe('VALIDATION_ERROR');
      expect(res.json.error.message).toContain('Unknown parameter "contributionId"');
    });

    it('rejects POST /api/mcp/cancel when requestId is missing (400)', async () => {
      const handler = createPlatformProxyHandler({
        platformUserId: ALICE_PLATFORM_ID,
        runtimeIdentity: 'alice',
        db,
        mcpService: mockMcpService,
      });

      const res = await sendHttpRequest(handler, 'POST', '/api/mcp/cancel', {
        sessionId: 'ses_alice_1',
      });
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('3. Old Aliases & Unauthorized Paths Fail-Closed (404)', () => {
    it('rejects contributionId in path route /api/mcp/:contributionId/tools with 404', async () => {
      const handler = createPlatformProxyHandler({
        platformUserId: ALICE_PLATFORM_ID,
        runtimeIdentity: 'alice',
        db,
        mcpService: mockMcpService,
      });

      const res = await sendHttpRequest(handler, 'GET', '/api/mcp/sqlite_contrib/tools');
      expect(res.status).toBe(404);
      expect(res.json.error.code).toBe('NOT_FOUND');
    });

    it('rejects legacy /api/mcp/tools/call route with 404', async () => {
      const handler = createPlatformProxyHandler({
        platformUserId: ALICE_PLATFORM_ID,
        runtimeIdentity: 'alice',
        db,
        mcpService: mockMcpService,
      });

      const res = await sendHttpRequest(handler, 'POST', '/api/mcp/tools/call', {
        sessionId: 'ses_alice_1',
        toolName: 'mcp__sqlite_contrib__read_query',
      });
      expect(res.status).toBe(404);
      expect(res.json.error.code).toBe('NOT_FOUND');
    });

    it('rejects /mcp/* un-prefixed routes with 404', async () => {
      const handler = createPlatformProxyHandler({
        platformUserId: ALICE_PLATFORM_ID,
        runtimeIdentity: 'alice',
        db,
        mcpService: mockMcpService,
      });

      const res1 = await sendHttpRequest(handler, 'GET', '/mcp/tools');
      expect(res1.status).toBe(404);

      const res2 = await sendHttpRequest(handler, 'POST', '/mcp/call', {
        sessionId: 'ses_alice_1',
        toolName: 'mcp__sqlite_contrib__read_query',
      });
      expect(res2.status).toBe(404);
    });

    it('rejects /api/mcp/reconcile and /reconcile routes with 404', async () => {
      const handler = createPlatformProxyHandler({
        platformUserId: ALICE_PLATFORM_ID,
        runtimeIdentity: 'alice',
        db,
        mcpService: mockMcpService,
      });

      const res1 = await sendHttpRequest(handler, 'POST', '/api/mcp/reconcile', { contributions: [] });
      expect(res1.status).toBe(404);

      const res2 = await sendHttpRequest(handler, 'POST', '/reconcile', { contributions: [] });
      expect(res2.status).toBe(404);
    });
  });

  describe('4. Method Not Allowed Checks (405)', () => {
    it('returns 405 on wrong HTTP methods for canonical MCP routes', async () => {
      const handler = createPlatformProxyHandler({
        platformUserId: ALICE_PLATFORM_ID,
        runtimeIdentity: 'alice',
        db,
        mcpService: mockMcpService,
      });

      const res1 = await sendHttpRequest(handler, 'POST', '/api/mcp/tools');
      expect(res1.status).toBe(405);

      const res2 = await sendHttpRequest(handler, 'GET', '/api/mcp/call');
      expect(res2.status).toBe(405);

      const res3 = await sendHttpRequest(handler, 'GET', '/api/mcp/cancel');
      expect(res3.status).toBe(405);

      const res4 = await sendHttpRequest(handler, 'POST', '/api/mcp/health');
      expect(res4.status).toBe(405);
    });
  });

  describe('5. Tenant Isolation & Space Routing', () => {
    it('rejects requests for sessions belonging to other tenants (HTTP 403)', async () => {
      const handler = createPlatformProxyHandler({
        platformUserId: ALICE_PLATFORM_ID,
        runtimeIdentity: 'alice',
        db,
        mcpService: mockMcpService,
      });

      // Bob's session requested by Alice's handler
      const resTools = await sendHttpRequest(handler, 'GET', '/api/mcp/tools?sessionId=ses_bob_1');
      expect(resTools.status).toBe(403);
      expect(resTools.json.error.code).toBe('FORBIDDEN');

      const resCall = await sendHttpRequest(handler, 'POST', '/api/mcp/call', {
        sessionId: 'ses_bob_1',
        toolName: 'mcp__sqlite_contrib__read_query',
        args: {},
      });
      expect(resCall.status).toBe(403);
      expect(resCall.json.error.code).toBe('FORBIDDEN');

      const resCancel = await sendHttpRequest(handler, 'POST', '/api/mcp/cancel', {
        sessionId: 'ses_bob_1',
        requestId: 'req_1',
      });
      expect(resCancel.status).toBe(403);
      expect(resCancel.json.error.code).toBe('FORBIDDEN');
    });
  });

  describe('6. Capabilities Advertising & Health Checks', () => {
    it('advertises "mcp" capability when mcpService is present and healthy', async () => {
      const handler = createPlatformProxyHandler({
        platformUserId: ALICE_PLATFORM_ID,
        runtimeIdentity: 'alice',
        db,
        mcpService: mockMcpService,
      });

      const res = await sendHttpRequest(handler, 'GET', '/capabilities');
      expect(res.status).toBe(200);
      expect(res.json.capabilities).toContain('mcp');
    });

    it('omits "mcp" capability when mcpService reports unhealthy', async () => {
      const unhealthyMcp: PlatformProxyMcpService = {
        listTools: vi.fn().mockResolvedValue([]),
        callTool: vi.fn().mockResolvedValue({ content: [] }),
        cancel: vi.fn().mockResolvedValue(undefined),
        checkHealth: vi.fn().mockRejectedValue(new Error('Gateway down')),
      };

      const handler = createPlatformProxyHandler({
        platformUserId: ALICE_PLATFORM_ID,
        runtimeIdentity: 'alice',
        db,
        mcpService: unhealthyMcp,
      });

      const res = await sendHttpRequest(handler, 'GET', '/capabilities');
      expect(res.status).toBe(200);
      expect(res.json.capabilities).not.toContain('mcp');
    });
  });

  describe('7. Unconfigured MCP Service Behavior (503)', () => {
    it('returns 503 Service Unavailable for MCP routes when mcpService is not configured', async () => {
      const handler = createPlatformProxyHandler({
        platformUserId: ALICE_PLATFORM_ID,
        runtimeIdentity: 'alice',
        db,
        // No mcpService
      });

      const res1 = await sendHttpRequest(handler, 'GET', '/api/mcp/tools?sessionId=ses_alice_1');
      expect(res1.status).toBe(503);
      expect(res1.json.error.code).toBe('SERVICE_UNAVAILABLE');

      const res2 = await sendHttpRequest(handler, 'POST', '/api/mcp/call', {
        sessionId: 'ses_alice_1',
        toolName: 'mcp__sqlite_contrib__read_query',
      });
      expect(res2.status).toBe(503);
      expect(res2.json.error.code).toBe('SERVICE_UNAVAILABLE');

      const res3 = await sendHttpRequest(handler, 'POST', '/api/mcp/cancel', {
        sessionId: 'ses_alice_1',
        requestId: 'req_1',
      });
      expect(res3.status).toBe(503);
      expect(res3.json.error.code).toBe('SERVICE_UNAVAILABLE');

      const res4 = await sendHttpRequest(handler, 'GET', '/api/mcp/health');
      expect(res4.status).toBe(503);
      expect(res4.json.error.code).toBe('SERVICE_UNAVAILABLE');
    });
  });
});
