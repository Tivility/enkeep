/**
 * Stdio MCP Server Lifecycle Integration Tests
 *
 * Tests:
 * - Real SDK handshake, initialization & tool listing
 * - Successful tool call invocation (echo, add)
 * - Ephemeral secret injection via CredentialResolverPort
 * - Execution timeout enforcement
 * - Cancellation propagation via AbortSignal
 * - Process crash detection and recovery
 * - Output bounding and runaway output process termination
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { HostMcpManager } from '../src/manager.js';
import { InMemoryCredentialResolver } from '../src/security/credential-resolver.js';
import { McpErrorCode, McpServiceError } from '../src/errors.js';
import type { McpContext, McpStdioServerDescriptor } from '../src/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FAKE_STDIO_SERVER_PATH = join(__dirname, 'fixtures', 'fake-stdio-server.mjs');

describe('Stdio MCP Server Lifecycle & Protocol Integration', () => {
  let manager: HostMcpManager;
  let credentialResolver: InMemoryCredentialResolver;

  const stdioDescriptor: McpStdioServerDescriptor = {
    id: 'test-stdio-server',
    name: 'Test Stdio Server',
    transport: 'stdio',
    command: process.execPath, // node binary
    args: [FAKE_STDIO_SERVER_PATH],
    toolTimeoutMs: 3000,
    initTimeoutMs: 5000,
    credentialRefs: [{ id: 'test_secret' }],
  };

  beforeEach(() => {
    credentialResolver = new InMemoryCredentialResolver();
    credentialResolver.setCredentials('alice', 'test_secret', {
      env: { SECRET_KEY: 'alice_super_secret_token' },
    });

    manager = new HostMcpManager({
      servers: [stdioDescriptor],
      credentialResolver,
      idleTimeoutMs: 1000, // fast idle for testing
    });
  });

  afterEach(async () => {
    await manager.close();
  });

  it('lists tools from fake stdio MCP server successfully with canonical public names', async () => {
    const context: McpContext = { userId: 'alice' };
    const tools = await manager.listTools(context);

    expect(tools.length).toBeGreaterThanOrEqual(4);
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('mcp__test-stdio-server__echo');
    expect(toolNames).toContain('mcp__test-stdio-server__add');
    expect(toolNames).toContain('mcp__test-stdio-server__get_secret');

    // Descriptors preserve originalName internally
    const echoDef = tools.find((t) => t.name === 'mcp__test-stdio-server__echo');
    expect(echoDef?.originalName).toBe('echo');
    expect(echoDef?.serverId).toBe('test-stdio-server');
  });

  it('executes tool call (echo, add) using canonical public names and receives typed content results', async () => {
    const context: McpContext = { userId: 'alice' };

    const echoRes = await manager.callTool('mcp__test-stdio-server__echo', { message: 'Hello MCP' }, context);
    expect(echoRes.content[0]).toEqual({ type: 'text', text: 'Echo: Hello MCP' });

    const addRes = await manager.callTool('mcp__test-stdio-server__add', { a: 10, b: 25 }, context);
    expect(addRes.content[0]).toEqual({ type: 'text', text: '35' });
  });

  it('rejects bare tool names, old server__add format, and malformed names', async () => {
    const context: McpContext = { userId: 'alice' };

    // Reject bare 'add'
    await expect(manager.callTool('add', { a: 1, b: 2 }, context)).rejects.toThrowError(
      /canonical/i,
    );

    // Reject old 'test-stdio-server__add' without 'mcp__' prefix
    await expect(manager.callTool('test-stdio-server__add', { a: 1, b: 2 }, context)).rejects.toThrowError(
      /canonical/i,
    );

    // Reject ambiguous extra segments
    await expect(manager.callTool('mcp__test-stdio-server__add__extra', { a: 1, b: 2 }, context)).rejects.toThrowError(
      /canonical/i,
    );

    // Reject empty slug
    await expect(manager.callTool('mcp____add', { a: 1, b: 2 }, context)).rejects.toThrowError(
      /canonical/i,
    );
  });

  it('injects ephemeral credentials into downstream stdio process without logging them', async () => {
    const aliceContext: McpContext = { userId: 'alice' };
    const res = await manager.callTool('mcp__test-stdio-server__get_secret', {}, aliceContext);
    expect(res.content[0]).toEqual({ type: 'text', text: 'Secret: alice_super_secret_token' });

    // Bob has no credential registered -> default/empty
    const bobContext: McpContext = { userId: 'bob' };
    const bobRes = await manager.callTool('mcp__test-stdio-server__get_secret', {}, bobContext);
    expect(bobRes.content[0]).toEqual({ type: 'text', text: 'Secret: no-secret-provided' });
  });

  it('enforces execution timeout on hanging tool call', async () => {
    const context: McpContext = { userId: 'alice' };
    await expect(manager.callTool('mcp__test-stdio-server__hang', {}, context)).rejects.toThrowError(
      /timed out|timeout/i,
    );
  });

  it('propagates cancellation via AbortSignal to child execution', async () => {
    const controller = new AbortController();
    const context: McpContext = { userId: 'alice', signal: controller.signal };

    const callPromise = manager.callTool('mcp__test-stdio-server__echo', { message: 'slow', delayMs: 2000 }, context);

    // Abort after 100ms
    setTimeout(() => {
      controller.abort(new Error('User cancelled turn'));
    }, 100);

    await expect(callPromise).rejects.toThrowError(/cancel|abort/i);
  });

  it('cancels in-flight tool invocation via manager.cancel({ requestId, context })', async () => {
    const context: McpContext = { userId: 'alice', requestId: 'req_cancel_test_1' };

    const callPromise = manager.callTool('mcp__test-stdio-server__echo', { message: 'slow', delayMs: 2000 }, context);

    // Cancel after 100ms via requestId
    setTimeout(async () => {
      await manager.cancel({ requestId: 'req_cancel_test_1', context });
    }, 100);

    await expect(callPromise).rejects.toThrowError(/cancel/i);
  });

  it('handles child process crash and recovers on subsequent call', async () => {
    const context: McpContext = { userId: 'alice' };

    // Trigger crash
    await expect(manager.callTool('mcp__test-stdio-server__crash', {}, context)).rejects.toThrow();

    // Small delay for process exit detection
    await new Promise((r) => setTimeout(r, 200));

    // Next call should cleanly re-spawn and succeed
    const res = await manager.callTool('mcp__test-stdio-server__add', { a: 5, b: 5 }, context);
    expect(res.content[0]).toEqual({ type: 'text', text: '10' });
  });

  it('bounds and truncates massive tool output', async () => {
    const context: McpContext = { userId: 'alice' };
    const res = await manager.callTool('mcp__test-stdio-server__huge_output', { sizeBytes: 6000000 }, context);

    expect(res.content[0]?.type).toBe('text');
    if (res.content[0]?.type === 'text') {
      expect(Buffer.byteLength(res.content[0].text, 'utf8')).toBeLessThanOrEqual(4 * 1024 * 1024 + 100);
      expect(res.content[0].text).toContain('[output truncated by host policy]');
    }
  });
});
