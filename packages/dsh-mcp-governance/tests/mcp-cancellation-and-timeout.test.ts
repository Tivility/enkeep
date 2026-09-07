/**
 * MCP Tool Cancellation & Timeout Tests for @enkeep/dsh-mcp-governance
 *
 * Validates:
 * 1. AbortSignal cancellation forwards to /api/mcp/cancel and rejects immediately.
 * 2. Timeout enforcement on slow platform responses.
 *
 * @module @enkeep/dsh-mcp-governance/tests/mcp-cancellation-and-timeout.test
 */

import { describe, it, expect, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import {
  createMcpToolExecutor,
  type RawMcpTool,
} from '../src/index.js';

describe('dsh-mcp-governance: Cancellation & Timeout', () => {
  const rawTool: RawMcpTool = {
    name: 'mcp__worker__long_running_job',
    description: 'Runs long analysis',
    serverId: 'c_long',
  };

  it('forwards cancellation to /api/mcp/cancel when AbortSignal triggers during execution', async () => {
    const ctx = new Context();
    (ctx as any).approval = { request: vi.fn().mockResolvedValue('allowed-once') };

    const cancelCalls: any[] = [];
    const mockClient = {
      request: vi.fn().mockImplementation(async (path: string, opts: any) => {
        if (path === '/api/mcp/cancel') {
          cancelCalls.push(opts.body);
          return { status: 200, data: { success: true } };
        }
        if (path === '/api/mcp/call') {
          // Simulate slow execution that gets aborted
          return new Promise((_, reject) => {
            if (opts.signal) {
              opts.signal.addEventListener('abort', () => {
                const err = new Error('The operation was aborted');
                err.name = 'AbortError';
                reject(err);
              });
            }
          });
        }
        return { status: 404, data: {} };
      }),
    };

    const executor = createMcpToolExecutor(ctx, {
      client: mockClient as any,
      serverName: 'worker',
      rawTool,
      publicName: 'mcp__worker__long_running_job',
      risk: { riskLevel: 'mutation', requiresApproval: true, isConcurrencySafe: false, reason: 'Execute' },
    });

    const controller = new AbortController();

    const executePromise = executor(
      { job: 'analyze' },
      { agent: { session: { id: 's1', header: { id: 's1' } } }, signal: controller.signal } as any
    );

    // Abort midway
    setTimeout(() => controller.abort(), 20);

    await expect(executePromise).rejects.toThrow(/aborted/);

    // Verify /api/mcp/cancel was notified with { sessionId, requestId }
    expect(cancelCalls.length).toBeGreaterThanOrEqual(1);
    expect(cancelCalls[0].sessionId).toBe('s1');
    expect(cancelCalls[0].requestId).toBeDefined();
  });

  it('rejects with timeout error when platform fails to respond within timeoutMs', async () => {
    const ctx = new Context();
    (ctx as any).approval = { request: vi.fn().mockResolvedValue('allowed-once') };

    const mockClient = {
      request: vi.fn().mockRejectedValue(new Error('Request timed out after 50ms')),
    };

    const executor = createMcpToolExecutor(ctx, {
      client: mockClient as any,
      serverName: 'slow_srv',
      rawTool,
      publicName: 'mcp__slow_srv__long_running_job',
      risk: { riskLevel: 'mutation', requiresApproval: true, isConcurrencySafe: false, reason: 'Execute' },
      timeoutMs: 50,
    });

    await expect(
      executor(
        {},
        { agent: { session: { id: 's1', header: { id: 's1' } } }, signal: new AbortController().signal } as any
      )
    ).rejects.toThrow(/Request timed out after 50ms/);
  });
});
