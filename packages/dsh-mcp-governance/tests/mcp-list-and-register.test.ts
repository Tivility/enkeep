/**
 * MCP List & Dynamic Registration Tests for @enkeep/dsh-mcp-governance
 *
 * @module @enkeep/dsh-mcp-governance/tests/mcp-list-and-register.test
 */

import { describe, it, expect, vi } from 'vitest';
import { Context, Service } from '@deepseek-ai/cordis';
import {
  McpGovernanceService,
  type ExtensionActivationPlan,
  type RawMcpTool,
} from '../src/index.js';

class MockToolsService extends Service {
  public registered = new Map<string, any>();
  constructor(ctx: Context) {
    super(ctx, 'tools');
  }
  register(tool: any) {
    this.registered.set(tool.name, tool);
    return () => {
      this.registered.delete(tool.name);
    };
  }
}

describe('dsh-mcp-governance: List & Dynamic Registration', () => {
  it('requests /api/mcp/tools with sessionId query and registers dynamic tools in ToolsRegistry', async () => {
    const ctx = new Context();
    ctx.plugin(MockToolsService);
    const service = new McpGovernanceService(ctx);

    const mockTools: RawMcpTool[] = [
      {
        name: 'mcp__sqlite__query_records',
        description: 'Queries database records matching criteria',
        serverId: 'contrib_sqlite',
        inputSchema: {
          type: 'object',
          properties: {
            table: { type: 'string', description: 'Table name' },
            limit: { type: 'number', description: 'Max records' },
          },
          required: ['table'],
        },
      },
      {
        name: 'mcp__sqlite__count_rows',
        description: 'Counts rows in table',
        serverId: 'contrib_sqlite',
        inputSchema: {
          type: 'object',
          properties: {
            table: { type: 'string' },
          },
        },
      },
    ];

    const mockRequest = vi.fn().mockImplementation(async (path: string, options?: any) => {
      if (path === '/api/mcp/tools' && options?.query?.sessionId === 'ses_test_123') {
        return {
          status: 200,
          data: { tools: mockTools },
        };
      }
      return { status: 404, data: {} };
    });

    const plan: ExtensionActivationPlan = {
      generation: 1,
      contributions: [
        {
          kind: 'mcp',
          contributionId: 'contrib_sqlite',
          name: 'sqlite',
          enabled: true,
        },
      ],
      skills: [],
      mcp: [
        {
          kind: 'mcp',
          contributionId: 'contrib_sqlite',
          name: 'sqlite',
          enabled: true,
        },
      ],
    };

    (ctx as any).session = { id: 'ses_test_123', header: { id: 'ses_test_123' } };

    const handle = await service.mountActivationPlan(ctx, plan, {
      platformClient: { request: mockRequest } as any,
    });

    expect(mockRequest).toHaveBeenCalledWith(
      '/api/mcp/tools',
      expect.objectContaining({
        method: 'GET',
        query: { sessionId: 'ses_test_123' },
      })
    );

    expect(handle.registeredTools.size).toBe(2);
    expect(handle.registeredTools.has('mcp__sqlite__query_records')).toBe(true);
    expect(handle.registeredTools.has('mcp__sqlite__count_rows')).toBe(true);

    const toolsService = ctx.get('tools') as MockToolsService;
    expect(toolsService.registered.has('mcp__sqlite__query_records')).toBe(true);
    expect(toolsService.registered.has('mcp__sqlite__count_rows')).toBe(true);

    // Verify health
    const health = service.getHealthStatus();
    expect(health.mcpConfigured).toBe(true);
    expect(health.mcpOperational).toBe(true);
    expect(health.toolCount).toBe(2);
    expect(health.serverCount).toBe(1);

    await handle.dispose();
    expect(toolsService.registered.size).toBe(0);
  });

  it('returns empty disposer immediately when plan has no MCP contributions', async () => {
    const ctx = new Context();
    ctx.plugin(MockToolsService);
    const service = new McpGovernanceService(ctx);

    const mockRequest = vi.fn();

    const plan: ExtensionActivationPlan = {
      generation: 1,
      contributions: [],
      skills: [],
      mcp: [],
    };

    const handle = await service.mountActivationPlan(ctx, plan, {
      platformClient: { request: mockRequest } as any,
    });

    expect(mockRequest).not.toHaveBeenCalled();
    expect(handle.registeredTools.size).toBe(0);
    await handle.dispose();
  });

  it('fails plan activation when duplicate tool names collide within the plan', async () => {
    const ctx = new Context();
    ctx.plugin(MockToolsService);
    const service = new McpGovernanceService(ctx);

    const mockTools: RawMcpTool[] = [
      {
        name: 'mcp__dup_server__ping',
        description: 'First ping tool',
        serverId: 'contrib_dup',
        inputSchema: { type: 'object' },
      },
      {
        name: 'mcp__dup_server__ping',
        description: 'Colliding duplicate ping tool',
        serverId: 'contrib_dup',
        inputSchema: { type: 'object' },
      },
    ];

    const mockRequest = vi.fn().mockResolvedValue({
      status: 200,
      data: { tools: mockTools },
    });

    const plan: ExtensionActivationPlan = {
      generation: 1,
      contributions: [
        {
          kind: 'mcp',
          contributionId: 'contrib_dup',
          name: 'dup_server',
          enabled: true,
        },
      ],
      skills: [],
      mcp: [
        {
          kind: 'mcp',
          contributionId: 'contrib_dup',
          name: 'dup_server',
          enabled: true,
        },
      ],
    };

    (ctx as any).session = { id: 'ses_dup', header: { id: 'ses_dup' } };

    await expect(
      service.mountActivationPlan(ctx, plan, {
        platformClient: { request: mockRequest } as any,
      })
    ).rejects.toThrow(/FAIL-CLOSED: Tool name collision detected for "mcp__dup_server__ping"/);

    const toolsService = ctx.get('tools') as MockToolsService;
    expect(toolsService.registered.size).toBe(0);
  });

  it('skips tools requiring unsupported taskSupport: required', async () => {
    const ctx = new Context();
    ctx.plugin(MockToolsService);
    const service = new McpGovernanceService(ctx);

    const mockTools: RawMcpTool[] = [
      {
        name: 'mcp__srv__async_task_tool',
        description: 'Requires task support',
        serverId: 'c1',
        inputSchema: { type: 'object' },
        execution: { taskSupport: 'required' },
      },
      {
        name: 'mcp__srv__supported_tool',
        description: 'Standard tool',
        serverId: 'c1',
        inputSchema: { type: 'object' },
      },
    ];

    const mockRequest = vi.fn().mockResolvedValue({
      status: 200,
      data: { tools: mockTools },
    });

    const plan: ExtensionActivationPlan = {
      generation: 1,
      contributions: [
        {
          kind: 'mcp',
          contributionId: 'c1',
          name: 'srv',
          enabled: true,
        },
      ],
      skills: [],
      mcp: [
        {
          kind: 'mcp',
          contributionId: 'c1',
          name: 'srv',
          enabled: true,
        },
      ],
    };

    (ctx as any).session = { id: 'ses_srv', header: { id: 'ses_srv' } };

    const handle = await service.mountActivationPlan(ctx, plan, {
      platformClient: { request: mockRequest } as any,
    });

    expect(handle.registeredTools.size).toBe(1);
    expect(handle.registeredTools.has('mcp__srv__supported_tool')).toBe(true);
    expect(handle.registeredTools.has('mcp__srv__async_task_tool')).toBe(false);

    await handle.dispose();
  });

  it('handles unreachable platform service gracefully with health tracking', async () => {
    const ctx = new Context();
    ctx.plugin(MockToolsService);
    const service = new McpGovernanceService(ctx);

    const mockRequest = vi.fn().mockRejectedValue(new Error('Connection refused'));

    const plan: ExtensionActivationPlan = {
      generation: 1,
      contributions: [
        {
          kind: 'mcp',
          contributionId: 'unreachable_contrib',
          name: 'offline_server',
          enabled: true,
        },
      ],
      skills: [],
      mcp: [
        {
          kind: 'mcp',
          contributionId: 'unreachable_contrib',
          name: 'offline_server',
          enabled: true,
        },
      ],
    };

    (ctx as any).session = { id: 'ses_unreachable', header: { id: 'ses_unreachable' } };

    const handle = await service.mountActivationPlan(ctx, plan, {
      platformClient: { request: mockRequest } as any,
    });

    expect(handle.registeredTools.size).toBe(0);
    const health = service.getHealthStatus();
    expect(health.mcpConfigured).toBe(true);
    expect(health.mcpOperational).toBe(false);
    expect(health.servers[0].status).toBe('unreachable');
    expect(health.servers[0].error).toContain('Connection refused');

    await handle.dispose();
  });
});
