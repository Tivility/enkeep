/**
 * Cordis Plugin Lifecycle and Capability Probing Tests for @enkeep/dsh-tool-browser
 *
 * Validates:
 * 1. Mounting BrowserToolService on Cordis context.
 * 2. Automatic registration into ctx.tools registry.
 * 3. HMR & Fiber disposal cleanly removes all 5 tools with zero leaks.
 * 4. Honest capability probing against PlatformClient.
 *
 * @module @enkeep/dsh-tool-browser/tests/cordis-plugin-lifecycle.test
 */

import { describe, it, expect, vi } from 'vitest';
import { Context, Service } from '@deepseek-ai/cordis';
import { BrowserToolService, apply } from '../src/index.js';

class MockToolsService extends Service {
  public registered: Array<{ name: string }> = [];

  constructor(ctx: Context) {
    super(ctx, 'tools');
  }

  register(tool: { name: string }) {
    this.registered.push(tool);
    return () => {
      const idx = this.registered.indexOf(tool);
      if (idx !== -1) {
        this.registered.splice(idx, 1);
      }
    };
  }
}

describe('dsh-tool-browser: Cordis Lifecycle & Capabilities', () => {
  it('mounts BrowserToolService and registers tools into ctx.tools', async () => {
    const ctx = new Context();
    const toolsService = new MockToolsService(ctx);

    const fiber = await ctx.plugin(apply, {
      maxSnapshotLength: 32_000,
      defaultTimeoutMs: 15_000,
    });

    expect(ctx.browserTools).toBeDefined();
    expect(toolsService.registered.map((t) => t.name)).toEqual([
      'browser_open',
      'browser_snapshot',
      'browser_interact',
      'browser_screenshot',
      'browser_close',
    ]);

    // Test HMR / fiber disposal
    await fiber.dispose();
    expect(toolsService.registered).toHaveLength(0);
  });

  it('probes capability honestly against platform client /capabilities', async () => {
    const ctx = new Context();

    // 1. Without platform client: probe returns false
    const service1 = new BrowserToolService(ctx);
    expect(await service1.probeBrowserCapability()).toBe(false);

    // 2. With platform client returning capability true: probe returns true
    const mockClientCapable = {
      request: vi.fn().mockResolvedValue({
        status: 200,
        data: { success: true, capabilities: ['browser', 'mcp'], browser: true },
      }),
    };
    (ctx as any).platformClient = mockClientCapable;
    expect(await service1.probeBrowserCapability()).toBe(true);

    // 3. With platform client reporting error / unready: probe returns false
    const mockClientDown = {
      request: vi.fn().mockRejectedValue(new Error('Network refused')),
    };
    (ctx as any).platformClient = mockClientDown;
    expect(await service1.probeBrowserCapability()).toBe(false);
  });
});
