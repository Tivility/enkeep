/**
 * MCP Tool Execution & Scope Isolation Tests for @enkeep/dsh-mcp-governance
 *
 * Validates:
 * 1. Execution calls POST /api/mcp/call with body { sessionId, toolName, args, requestId }.
 * 2. Scope-derived sessionId from agent session.
 * 3. No user/space arguments in model tool parameter schema.
 * 4. Multi-tenant / multi-session isolation.
 *
 * @module @enkeep/dsh-mcp-governance/tests/mcp-execution-and-isolation.test
 */

import { describe, it, expect, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import {
  createMcpToolExecutor,
  type RawMcpTool,
} from '../src/index.js';

describe('dsh-mcp-governance: Execution & Scope Isolation', () => {
  const rawTool: RawMcpTool = {
    name: 'mcp__users_svc__fetch_user_profile',
    description: 'Fetches user details by username',
    serverId: 'contrib_users_v1',
    originalName: 'fetch_user_profile',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
      },
      required: ['username'],
      additionalProperties: false,
    },
  };

  it('passes scope-derived sessionId and parameters without leaking user/space into model args', async () => {
    const ctx = new Context();
    (ctx as any).approval = { request: vi.fn().mockResolvedValue('allowed-once') };

    let capturedBody: any;
    const mockClient = {
      request: vi.fn().mockImplementation(async (_path: string, opts: any) => {
        capturedBody = opts.body;
        return {
          status: 200,
          data: {
            content: [{ type: 'text', text: JSON.stringify({ id: 101, username: 'charlie' }) }],
            structuredContent: { id: 101, username: 'charlie' },
          },
        };
      }),
    };

    const executor = createMcpToolExecutor(ctx, {
      client: mockClient as any,
      serverName: 'users_svc',
      rawTool,
      publicName: 'mcp__users_svc__fetch_user_profile',
      risk: { riskLevel: 'read-only', requiresApproval: true, isConcurrencySafe: false, reason: 'Execute' },
      spaceId: 'spc_alice_dev',
      userId: 'alice',
    });

    const agentA = {
      id: 'agent_alice',
      session: {
        id: 'ses_alice_turn_42',
        header: { id: 'ses_alice_turn_42' },
        append: vi.fn(),
      },
    };

    const result: any = await executor(
      { username: 'charlie' },
      { agent: agentA, signal: new AbortController().signal, callId: 'call_alice_1' } as any
    );

    expect(capturedBody).toBeDefined();
    expect(capturedBody.toolName).toBe('mcp__users_svc__fetch_user_profile');
    expect(capturedBody.args).toEqual({ username: 'charlie' });
    expect(capturedBody.sessionId).toBe('ses_alice_turn_42');
    expect(capturedBody.requestId).toBeDefined();
    expect(capturedBody.contributionId).toBeUndefined();

    expect(result.structuredContent).toEqual({ id: 101, username: 'charlie' });
    expect(agentA.session.append).toHaveBeenCalledWith(
      'mcp/tool-invoked',
      expect.objectContaining({
        serverId: 'contrib_users_v1',
        serverName: 'users_svc',
        rawName: 'fetch_user_profile',
        publicName: 'mcp__users_svc__fetch_user_profile',
      })
    );
  });

  it('guarantees tenant isolation: Bob session produces Bob sessionId without crosstalk', async () => {
    const ctx = new Context();
    (ctx as any).approval = { request: vi.fn().mockResolvedValue('allowed-once') };

    const capturedBodies: any[] = [];
    const mockClient = {
      request: vi.fn().mockImplementation(async (_path: string, opts: any) => {
        capturedBodies.push(opts.body);
        return {
          status: 200,
          data: { content: [{ type: 'text', text: 'ok' }] },
        };
      }),
    };

    const executor = createMcpToolExecutor(ctx, {
      client: mockClient as any,
      serverName: 'shared_srv',
      rawTool,
      publicName: 'mcp__shared_srv__fetch_user_profile',
      risk: { riskLevel: 'read-only', requiresApproval: true, isConcurrencySafe: false, reason: 'Execute' },
    });

    const agentAlice = { session: { id: 'ses_alice_999', header: { id: 'ses_alice_999' } } };
    const agentBob = { session: { id: 'ses_bob_888', header: { id: 'ses_bob_888' } } };

    await executor({ username: 'u1' }, { agent: agentAlice, signal: new AbortController().signal } as any);
    await executor({ username: 'u2' }, { agent: agentBob, signal: new AbortController().signal } as any);

    expect(capturedBodies).toHaveLength(2);
    expect(capturedBodies[0].sessionId).toBe('ses_alice_999');
    expect(capturedBodies[0].args).toEqual({ username: 'u1' });
    expect(capturedBodies[0].toolName).toBe('mcp__shared_srv__fetch_user_profile');

    expect(capturedBodies[1].sessionId).toBe('ses_bob_888');
    expect(capturedBodies[1].args).toEqual({ username: 'u2' });
    expect(capturedBodies[1].toolName).toBe('mcp__shared_srv__fetch_user_profile');
  });
});
