/**
 * Plan Changes, Tool Unbinding & HMR Lifecycle Tests for @enkeep/dsh-mcp-governance
 *
 * Validates:
 * 1. Mounting ExtensionActivationPlan registers all enabled MCP tools.
 * 2. Unbinding/disabling tools in next turn plan removes them completely from ToolsRegistry.
 * 3. Dispose releases all tools without leaks.
 *
 * @module @enkeep/dsh-mcp-governance/tests/mcp-plan-lifecycle-and-hmr.test
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

describe('dsh-mcp-governance: Plan Lifecycle & Tool Unbinding (HMR)', () => {
  const toolsAll: RawMcpTool[] = [
    { name: 'mcp__git__status', description: 'git status', serverId: 'c_git', inputSchema: { type: 'object' } },
    { name: 'mcp__git__diff', description: 'git diff', serverId: 'c_git', inputSchema: { type: 'object' } },
    { name: 'mcp__fs__read_file', description: 'read file', serverId: 'c_fs', inputSchema: { type: 'object' } },
  ];

  const toolsFsOnly: RawMcpTool[] = [
    { name: 'mcp__fs__read_file', description: 'read file', serverId: 'c_fs', inputSchema: { type: 'object' } },
  ];

  let currentTools = toolsAll;

  const mockClient = {
    request: vi.fn().mockImplementation(async (path: string) => {
      if (path === '/api/mcp/tools') {
        return { status: 200, data: { tools: currentTools } };
      }
      return { status: 404, data: {} };
    }),
  };

  it('updates registered tools dynamically across plan generations and unbinds disabled tools', async () => {
    const ctx = new Context();
    const toolsService = new MockToolsService(ctx);
    const mcpService = new McpGovernanceService(ctx);

    (ctx as any).session = { id: 'ses_hmr_1', header: { id: 'ses_hmr_1' } };

    // Turn 1: Plan with both git and fs contributions enabled
    currentTools = toolsAll;
    const plan1: ExtensionActivationPlan = {
      generation: 1,
      contributions: [
        { kind: 'mcp', contributionId: 'c_git', name: 'git', enabled: true },
        { kind: 'mcp', contributionId: 'c_fs', name: 'fs', enabled: true },
      ],
      skills: [],
      mcp: [
        { kind: 'mcp', contributionId: 'c_git', name: 'git', enabled: true },
        { kind: 'mcp', contributionId: 'c_fs', name: 'fs', enabled: true },
      ],
    };

    const handle1 = await mcpService.mountActivationPlan(ctx, plan1, {
      platformClient: mockClient as any,
    });

    expect(toolsService.registered.size).toBe(3);
    expect(toolsService.registered.has('mcp__git__status')).toBe(true);
    expect(toolsService.registered.has('mcp__git__diff')).toBe(true);
    expect(toolsService.registered.has('mcp__fs__read_file')).toBe(true);

    // Turn 2: Next turn disposes handle1 and mounts plan2 where git is disabled
    await handle1.dispose();
    expect(toolsService.registered.size).toBe(0);

    currentTools = toolsFsOnly;
    const plan2: ExtensionActivationPlan = {
      generation: 2,
      contributions: [
        { kind: 'mcp', contributionId: 'c_git', name: 'git', enabled: false }, // Disabled
        { kind: 'mcp', contributionId: 'c_fs', name: 'fs', enabled: true },
      ],
      skills: [],
      mcp: [
        { kind: 'mcp', contributionId: 'c_git', name: 'git', enabled: false },
        { kind: 'mcp', contributionId: 'c_fs', name: 'fs', enabled: true },
      ],
    };

    const handle2 = await mcpService.mountActivationPlan(ctx, plan2, {
      platformClient: mockClient as any,
    });

    // Only fs tool remains registered; git tools have disappeared
    expect(toolsService.registered.size).toBe(1);
    expect(toolsService.registered.has('mcp__fs__read_file')).toBe(true);
    expect(toolsService.registered.has('mcp__git__status')).toBe(false);
    expect(toolsService.registered.has('mcp__git__diff')).toBe(false);

    await handle2.dispose();
    expect(toolsService.registered.size).toBe(0);
  });
});
