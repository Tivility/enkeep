import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import * as dshToolsPlugin from '../src/index.js';
import type { ToolDefinition } from '../src/types.js';

class MockToolsService extends Service {
  public registeredTools: ToolDefinition[] = [];

  constructor(ctx: Context) {
    super(ctx, 'tools');
  }

  register(tool: ToolDefinition) {
    this.registeredTools.push(tool);
    return () => {
      const index = this.registeredTools.indexOf(tool);
      if (index !== -1) {
        this.registeredTools.splice(index, 1);
      }
    };
  }
}

describe('dsh-tools: Cordis plugin and dispose lifecycle', () => {
  const dummyWorkspaceRoot = path.join(os.tmpdir(), 'dsh-plugin-test-ws');

  it('registers all 4 tools on ctx.tools service and cleans up on dispose', async () => {
    const ctx = new Context();
    const toolsService = new MockToolsService(ctx);

    const fork = await ctx.plugin(dshToolsPlugin, { workspaceRoot: dummyWorkspaceRoot });

    expect(toolsService.registeredTools.length).toBe(4);
    const names = toolsService.registeredTools.map((t) => t.name);
    expect(names).toContain('send_platform_message');
    expect(names).toContain('send_file');
    expect(names).toContain('create_task');
    expect(names).toContain('check_quota');

    // Dispose test
    await fork.dispose();
    expect(toolsService.registeredTools.length).toBe(0);
  });

  it('handles late service mounting when tools service is mounted after the plugin', async () => {
    const ctx = new Context();
    const fork = await ctx.plugin(dshToolsPlugin, { workspaceRoot: dummyWorkspaceRoot });

    // Tools not available yet
    expect(fork).toBeDefined();

    // Mount tools service later
    const toolsService = new MockToolsService(ctx);
    await fork.await();

    expect(toolsService.registeredTools.length).toBe(4);

    await fork.dispose();
    expect(toolsService.registeredTools.length).toBe(0);
  });

  it('can start, stop, and restart independently multiple times', async () => {
    const ctx = new Context();
    const toolsService = new MockToolsService(ctx);

    const fork1 = await ctx.plugin(dshToolsPlugin, { workspaceRoot: dummyWorkspaceRoot });
    expect(toolsService.registeredTools.length).toBe(4);
    await fork1.dispose();
    expect(toolsService.registeredTools.length).toBe(0);

    const fork2 = await ctx.plugin(dshToolsPlugin, { workspaceRoot: dummyWorkspaceRoot });
    expect(toolsService.registeredTools.length).toBe(4);
    await fork2.dispose();
    expect(toolsService.registeredTools.length).toBe(0);
  });

  it('fails validation when workspaceBoundaryRoot is missing or not absolute', async () => {
    const ctx = new Context();
    await expect(ctx.plugin(dshToolsPlugin as any, {} as any)).rejects.toThrow();
    await expect(ctx.plugin(dshToolsPlugin as any, { workspaceBoundaryRoot: 'relative/path' } as any)).rejects.toThrow();
    await expect(ctx.plugin(dshToolsPlugin as any, { workspaceRoot: 'relative/path' } as any)).rejects.toThrow();
  });
});
