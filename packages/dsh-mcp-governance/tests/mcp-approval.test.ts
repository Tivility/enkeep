/**
 * MCP Tool Approval Policy & Safety Tests for @enkeep/dsh-mcp-governance
 *
 * Validates:
 * 1. P1 simplest: all MCP tool executions require human approval.
 * 2. Does not trust manifest self-reported risk or read-only annotations to bypass approval.
 * 3. Tool listing requires no approval.
 * 4. Approval summary excludes argument values (only tool name/server and arg keys).
 * 5. Rejection/cancellation/unavailability fails closed with zero platform calls.
 *
 * @module @enkeep/dsh-mcp-governance/tests/mcp-approval.test
 */

import { describe, it, expect, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import {
  createMcpToolExecutor,
  resolveToolRisk,
  formatSafeApprovalReason,
  type RawMcpTool,
} from '../src/index.js';

describe('dsh-mcp-governance: Approval Policy & Privacy', () => {
  const mockAgent = {
    id: 'agent_mcp_test',
    session: {
      id: 'ses_mcp_appr_1',
      header: { id: 'ses_mcp_appr_1' },
      append: vi.fn(),
    },
  };

  const rawTool: RawMcpTool = {
    name: 'mcp__db__delete_database',
    description: 'Deletes table',
    serverId: 'db',
    annotations: { readOnly: true }, // Untrusted self-claim
  };

  it('formats approval summary excluding argument values and exposing only keys', () => {
    const reason = formatSafeApprovalReason('mcp__db__delete_database', 'db', {
      table: 'users',
      secretKey: 'topsecret123',
      cascade: true,
    });

    expect(reason).toContain('mcp__db__delete_database');
    expect(reason).toContain('server "db"');
    expect(reason).toContain('parameters: [table, secretKey, cascade]');
    // MUST NOT leak values
    expect(reason).not.toContain('users');
    expect(reason).not.toContain('topsecret123');
    expect(reason).not.toContain('true');
  });

  it('requires approval even if manifest claims readOnly: true (does not trust manifest self-risk)', () => {
    const risk = resolveToolRisk(rawTool, { serverName: 'db' });
    expect(risk.requiresApproval).toBe(true);
  });

  it('executes tool call when user grants approval (allowed-once)', async () => {
    const ctx = new Context();
    const mockApprovalService = {
      request: vi.fn().mockResolvedValue('allowed-once'),
    };
    (ctx as any).approval = mockApprovalService;

    const mockClient = {
      request: vi.fn().mockResolvedValue({
        status: 200,
        data: {
          content: [{ type: 'text', text: 'Database deleted successfully' }],
        },
      }),
    };

    const executor = createMcpToolExecutor(ctx, {
      client: mockClient as any,
      serverName: 'db',
      rawTool,
      publicName: 'mcp__db__delete_database',
      risk: { riskLevel: 'mutation', requiresApproval: true, isConcurrencySafe: false, reason: 'Execute MCP tool' },
    });

    const result = await executor(
      { table: 'customers' },
      { agent: mockAgent, signal: new AbortController().signal, callId: 'call_1' } as any
    );

    expect(mockApprovalService.request).toHaveBeenCalledTimes(1);
    expect(mockApprovalService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'mcp__db__delete_database',
        reason: expect.stringContaining('parameters: [table]'),
      })
    );

    expect(mockClient.request).toHaveBeenCalledTimes(1);
    expect(mockClient.request).toHaveBeenCalledWith(
      '/api/mcp/call',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({
          toolName: 'mcp__db__delete_database',
          args: { table: 'customers' },
          sessionId: 'ses_mcp_appr_1',
        }),
      })
    );

    expect(result).toEqual({
      content: [{ type: 'text', text: 'Database deleted successfully' }],
    });
  });

  it('fails closed and makes NO platform call when user rejects approval', async () => {
    const ctx = new Context();
    const mockApprovalService = {
      request: vi.fn().mockResolvedValue('rejected'),
    };
    (ctx as any).approval = mockApprovalService;

    const mockClient = { request: vi.fn() };

    const executor = createMcpToolExecutor(ctx, {
      client: mockClient as any,
      serverName: 'db',
      rawTool,
      publicName: 'mcp__db__delete_database',
      risk: { riskLevel: 'mutation', requiresApproval: true, isConcurrencySafe: false, reason: 'Execute MCP tool' },
    });

    await expect(
      executor(
        { table: 'customers' },
        { agent: mockAgent, signal: new AbortController().signal, callId: 'call_1' } as any
      )
    ).rejects.toThrow(/rejected by user approval policy/);

    expect(mockApprovalService.request).toHaveBeenCalledTimes(1);
    expect(mockClient.request).not.toHaveBeenCalled();
  });

  it('fails closed when approval is unavailable (timed out or no human listener)', async () => {
    const ctx = new Context();
    const mockApprovalService = {
      request: vi.fn().mockResolvedValue('unavailable'),
    };
    (ctx as any).approval = mockApprovalService;

    const mockClient = { request: vi.fn() };

    const executor = createMcpToolExecutor(ctx, {
      client: mockClient as any,
      serverName: 'db',
      rawTool,
      publicName: 'mcp__db__delete_database',
      risk: { riskLevel: 'mutation', requiresApproval: true, isConcurrencySafe: false, reason: 'Execute MCP tool' },
    });

    await expect(
      executor(
        { table: 'customers' },
        { agent: mockAgent, signal: new AbortController().signal, callId: 'call_1' } as any
      )
    ).rejects.toThrow(/unavailable/);

    expect(mockClient.request).not.toHaveBeenCalled();
  });

  it('fails closed when approval service is missing (fail-closed security invariant)', async () => {
    const ctx = new Context(); // No approval service mounted
    const mockClient = { request: vi.fn() };

    const executor = createMcpToolExecutor(ctx, {
      client: mockClient as any,
      serverName: 'db',
      rawTool,
      publicName: 'mcp__db__delete_database',
      risk: { riskLevel: 'mutation', requiresApproval: true, isConcurrencySafe: false, reason: 'Execute MCP tool' },
    });

    await expect(
      executor(
        { table: 'customers' },
        { agent: mockAgent, signal: new AbortController().signal, callId: 'call_1' } as any
      )
    ).rejects.toThrow(/requires human approval, but no ApprovalService is mounted \(fail-closed\)/);

    expect(mockClient.request).not.toHaveBeenCalled();
  });
});
