/**
 * HTTP MCP Transport and SSRF Protection Integration Tests
 *
 * Tests:
 * - Real streamable HTTP connection & tool execution
 * - SSRF blocking of private IP targets (RFC 1918, link-local, loopback)
 * - Safe redirect following & blocking of malicious redirects (e.g. redirecting to AWS metadata 169.254.169.254)
 * - Ephemeral header injection via CredentialResolverPort
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HostMcpManager } from '../src/manager.js';
import { InMemoryCredentialResolver } from '../src/security/credential-resolver.js';
import { createFakeHttpMcpServer } from './fixtures/fake-http-server.js';
import type { McpContext, McpHttpServerDescriptor } from '../src/types.js';

describe('HTTP MCP Transport & SSRF Guard Integration', () => {
  let fakeHttp: ReturnType<typeof createFakeHttpMcpServer>;
  let serverUrl: string;
  let manager: HostMcpManager;
  let credentialResolver: InMemoryCredentialResolver;

  beforeEach(async () => {
    fakeHttp = createFakeHttpMcpServer();
    serverUrl = await fakeHttp.start();

    credentialResolver = new InMemoryCredentialResolver();
    credentialResolver.setCredentials('alice', 'http_auth_ref', {
      headers: { Authorization: 'Bearer alice_http_token' },
    });
  });

  afterEach(async () => {
    if (manager) await manager.close();
    await fakeHttp.close();
  });

  it('connects to HTTP MCP server, lists tools, and executes tool call', async () => {
    const httpDescriptor: McpHttpServerDescriptor = {
      id: 'test-http-server',
      name: 'Test HTTP Server',
      transport: 'streamable-http',
      url: serverUrl,
      credentialRefs: [{ id: 'http_auth_ref' }],
    };

    manager = new HostMcpManager({
      servers: [httpDescriptor],
      credentialResolver,
      allowLocalHttpForTesting: true, // test mode allows localhost
    });

    const context: McpContext = { userId: 'alice' };
    const tools = await manager.listTools(context);

    expect(tools.length).toBe(1);
    expect(tools[0]?.name).toBe('mcp__test-http-server__http_echo');
    expect(tools[0]?.originalName).toBe('http_echo');

    const callRes = await manager.callTool('mcp__test-http-server__http_echo', { message: 'Ping' }, context);
    expect(callRes.content[0]).toEqual({ type: 'text', text: 'HTTP Echo: Ping' });

    // Verify injected ephemeral authorization header arrived at server
    expect(fakeHttp.receivedHeaders['authorization']).toBe('Bearer alice_http_token');
  });

  it('blocks connection to private IP targets without testing bypass', async () => {
    const blockedDescriptor: McpHttpServerDescriptor = {
      id: 'blocked-ssrf-server',
      name: 'Blocked SSRF Server',
      transport: 'streamable-http',
      url: 'https://10.0.0.1/mcp',
    };

    manager = new HostMcpManager({
      servers: [blockedDescriptor],
    });

    const context: McpContext = { userId: 'alice' };
    await expect(manager.callTool('mcp__blocked-ssrf-server__any_tool', {}, context)).rejects.toThrowError(
      /SSRF|Direct private IPv4/i,
    );
  });

  it('blocks malicious redirects pointing to cloud metadata IP (169.254.169.254)', async () => {
    const redirectDescriptor: McpHttpServerDescriptor = {
      id: 'redirect-server',
      name: 'Redirect Server',
      transport: 'streamable-http',
      url: serverUrl.replace('/mcp', '/bad-redirect'),
    };

    manager = new HostMcpManager({
      servers: [redirectDescriptor],
      allowLocalHttpForTesting: true,
    });

    const context: McpContext = { userId: 'alice' };
    await expect(manager.callTool('mcp__redirect-server__any_tool', {}, context)).rejects.toThrowError(
      /SSRF|Direct private IPv4/i,
    );
  });
});
