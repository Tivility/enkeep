/**
 * Browser Tools Service & Cordis Lifecycle Orchestration
 *
 * Implements:
 * 1. BrowserToolService on Cordis context (`ctx.browserTools`).
 * 2. Capability probing against Platform Client (`/api/browser/capabilities` or `/capabilities`).
 * 3. Registers `browser_open`, `browser_snapshot`, `browser_interact`, `browser_screenshot`, `browser_close`.
 * 4. Supports revocable effect lifecycle and dynamic late mounting for HMR / disposal.
 *
 * @module @enkeep/dsh-tool-browser/service
 */

import { Service, Context, type Fiber } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type {
  BrowserPlatformClientService,
  BrowserPluginConfig,
} from './types.js';
import { createBrowserOpenTool } from './tools/browser-open.js';
import { createBrowserSnapshotTool } from './tools/browser-snapshot.js';
import { createBrowserInteractTool } from './tools/browser-interact.js';
import { createBrowserScreenshotTool } from './tools/browser-screenshot.js';
import { createBrowserCloseTool } from './tools/browser-close.js';

export class BrowserToolService extends Service {
  static inject = [];

  private readonly config: BrowserPluginConfig;

  constructor(ctx: Context, config: BrowserPluginConfig = {}) {
    super(ctx, 'browserTools');
    this.config = config;

    this.initTools(ctx);
  }

  /**
   * Resolves the PlatformClient service from context.
   */
  public resolvePlatformClient(): BrowserPlatformClientService | undefined {
    return this.ctx.get('platformClient') ?? (this.ctx as unknown as { platformClient?: BrowserPlatformClientService }).platformClient;
  }

  /**
   * Honest capability check: queries whether the remote platform browser service is reachable and enabled.
   */
  public async probeBrowserCapability(): Promise<boolean> {
    const client = this.resolvePlatformClient();
    if (!client || typeof client.request !== 'function') {
      return false;
    }

    try {
      const res = await client.request<{
        success?: boolean;
        capabilities?: string[];
        browser?: boolean;
      }>('/capabilities', {
        method: 'GET',
        timeoutMs: 2000,
        maxRetries: 0,
      });

      if (res && res.status === 200 && res.data) {
        if (res.data.browser === true) return true;
        if (Array.isArray(res.data.capabilities) && res.data.capabilities.includes('browser')) {
          return true;
        }
        if (res.data.success === true) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Creates the 5 browser tool definitions.
   */
  public createTools(scopedCtx?: Context): ToolDefinition[] {
    const getClient = () => this.resolvePlatformClient();
    const effectiveCtx = scopedCtx ?? this.ctx;

    return [
      createBrowserOpenTool(getClient, this.config, effectiveCtx),
      createBrowserSnapshotTool(getClient, this.config, effectiveCtx),
      createBrowserInteractTool(getClient, this.config, effectiveCtx),
      createBrowserScreenshotTool(getClient, this.config, effectiveCtx),
      createBrowserCloseTool(getClient, this.config, effectiveCtx),
    ];
  }

  /**
   * Registers tools into the Cordis tools registry with revocable effect lifecycle.
   */
  private initTools(ctx: Context): void {
    let registered = false;

    const registerWithTools = (targetCtx: Context): (() => void) | undefined => {
      const toolsService = targetCtx.get('tools');
      if (toolsService && typeof toolsService.register === 'function') {
        const tools = this.createTools(targetCtx);
        const disposers: Array<() => void> = [];
        for (const tool of tools) {
          const dispose = toolsService.register(tool);
          if (typeof dispose === 'function') {
            disposers.push(dispose);
          }
        }
        registered = true;
        return () => {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch {
              // ignore disposal errors
            }
          }
        };
      }
      return undefined;
    };

    // Immediate registration if tools service is already present
    const immediateDispose = registerWithTools(ctx);

    // Also register via inject for dynamic/late tools service mounting
    ctx.inject(['tools'], (toolsCtx) => {
      toolsCtx.effect(() => {
        if (registered && immediateDispose) return immediateDispose;
        return registerWithTools(toolsCtx) ?? (() => {});
      });
    });
  }
}
