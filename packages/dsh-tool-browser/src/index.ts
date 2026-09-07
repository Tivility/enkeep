/**
 * Browser Tools Plugin for DeepSeek Harness (Enkeep Runtime)
 *
 * Provides:
 * 1. `BrowserToolService` on Cordis context (`ctx.browserTools`).
 * 2. Five minimal, unambiguous browser interaction tools:
 *    - `browser_open`: Navigate to validated safe URL.
 *    - `browser_snapshot`: Capture bounded accessibility DOM tree.
 *    - `browser_interact`: Click, fill, press, select with human approval.
 *    - `browser_screenshot`: Capture screenshot and persist to workspace artifacts.
 *    - `browser_close`: Close specific open pageId.
 * 3. Scope derivation from initiator Agent session/user/space (never model args).
 * 4. Exact DSH Approvals registry integration.
 * 5. Full lifecycle cleanup with zero resource leaks.
 *
 * @module @enkeep/dsh-tool-browser
 */

import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { BrowserToolService } from './service.js';
import type { BrowserPluginConfig } from './types.js';

export * from './types.js';
export * from './errors.js';
export * from './security.js';
export * from './scope.js';
export * from './approvals.js';
export * from './tools/browser-open.js';
export * from './tools/browser-snapshot.js';
export * from './tools/browser-interact.js';
export * from './tools/browser-screenshot.js';
export * from './tools/browser-close.js';
export * from './service.js';

export const name = 'enkeep-dsh-tool-browser';

export const inject = [];

export interface Config extends BrowserPluginConfig {}

export const Config: Schema<Config> = Schema.object({
  maxSnapshotLength: Schema.natural().default(65_536).description('Maximum allowed snapshot length in characters'),
  defaultTimeoutMs: Schema.natural().default(30_000).description('Default browser RPC timeout in milliseconds'),
  allowedProtocols: Schema.array(Schema.string()).default(['http:', 'https:']).description('Allowed URL protocols for browser navigation'),
  requireApprovalOnOpen: Schema.boolean().default(false).description('Whether navigation requires approval'),
});

/**
 * Functional Cordis plugin that mounts the BrowserToolService.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.plugin(BrowserToolService, config);
}

export default BrowserToolService;
