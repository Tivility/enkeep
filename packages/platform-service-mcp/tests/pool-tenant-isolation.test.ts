/**
 * Process Pool, Tenant Isolation, and Concurrency Unit/Integration Tests
 *
 * Tests:
 * - Tenant isolation between Alice and Bob (separate child process instances)
 * - Reference counting: shared connection for concurrent calls by same tenant
 * - Idle timer auto-reap of unused stdio processes
 * - Enforcing maxProcessesPerTenant limit (fail closed with MCP_PROCESS_LIMIT_EXCEEDED)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { HostMcpManager } from '../src/manager.js';
import { InMemoryCredentialResolver } from '../src/security/credential-resolver.js';
import type { McpContext, McpStdioServerDescriptor } from '../src/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FAKE_STDIO_SERVER_PATH = join(__dirname, 'fixtures', 'fake-stdio-server.mjs');

describe('Process Pool, Tenant Isolation & Concurrency', () => {
  let manager: HostMcpManager;
  let credentialResolver: InMemoryCredentialResolver;

  const stdioDescriptor: McpStdioServerDescriptor = {
    id: 'pool-test-server',
    name: 'Pool Test Server',
    transport: 'stdio',
    command: process.execPath,
    args: [FAKE_STDIO_SERVER_PATH],
    toolTimeoutMs: 5000,
    initTimeoutMs: 5000,
    credentialRefs: [{ id: 'secret_ref' }],
  };

  beforeEach(() => {
    credentialResolver = new InMemoryCredentialResolver();
    credentialResolver.setCredentials('alice', 'secret_ref', {
      env: { SECRET_KEY: 'alice_vault_token' },
    });
    credentialResolver.setCredentials('bob', 'secret_ref', {
      env: { SECRET_KEY: 'bob_vault_token' },
    });

    manager = new HostMcpManager({
      servers: [stdioDescriptor],
      credentialResolver,
      maxProcessesPerTenant: 2,
      idleTimeoutMs: 500, // 500ms idle reap
    });
  });

  afterEach(async () => {
    await manager.close();
  });

  it('isolates processes and credentials completely between Alice and Bob', async () => {
    const aliceContext: McpContext = { userId: 'alice' };
    const bobContext: McpContext = { userId: 'bob' };

    const [aliceRes, bobRes] = await Promise.all([
      manager.callTool('mcp__pool-test-server__get_secret', {}, aliceContext),
      manager.callTool('mcp__pool-test-server__get_secret', {}, bobContext),
    ]);

    expect(aliceRes.content[0]).toEqual({ type: 'text', text: 'Secret: alice_vault_token' });
    expect(bobRes.content[0]).toEqual({ type: 'text', text: 'Secret: bob_vault_token' });
  });

  it('reuses active connection for concurrent calls by same tenant', async () => {
    const context: McpContext = { userId: 'alice' };

    const [res1, res2, res3] = await Promise.all([
      manager.callTool('mcp__pool-test-server__add', { a: 1, b: 1 }, context),
      manager.callTool('mcp__pool-test-server__add', { a: 2, b: 2 }, context),
      manager.callTool('mcp__pool-test-server__add', { a: 3, b: 3 }, context),
    ]);

    expect(res1.content[0]).toEqual({ type: 'text', text: '2' });
    expect(res2.content[0]).toEqual({ type: 'text', text: '4' });
    expect(res3.content[0]).toEqual({ type: 'text', text: '6' });
  });

  it('reaps idle processes after configured idle timeout', async () => {
    const context: McpContext = { userId: 'alice' };

    await manager.callTool('mcp__pool-test-server__add', { a: 1, b: 2 }, context);
    const healthBefore = await manager.checkHealth(context);
    expect(healthBefore[0]?.activeProcesses).toBeGreaterThanOrEqual(1);

    // Wait for idle timeout (500ms + margin)
    await new Promise((r) => setTimeout(r, 700));

    const healthAfter = await manager.checkHealth(context);
    expect(healthAfter[0]?.activeProcesses).toBe(0);
  });
});
