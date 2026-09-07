/**
 * MCP Governance Plugin for DeepSeek Harness (Enkeep Runtime)
 *
 * Provides:
 * 1. McpGovernanceService on Cordis context (`ctx.mcpGovernance`).
 * 2. Mounts ExtensionActivationPlan and governs tools dynamically.
 * 3. Enforces schema security, depth limits, and prompt injection shielding.
 * 4. Bridges tool execution to PlatformClient POST /api/mcp/call with cancellation & spill bounding.
 * 5. Full lifecycle cleanup with zero resource leaks.
 *
 * @module @enkeep/dsh-mcp-governance
 */

import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { McpGovernanceService } from './service.js';

export * from './types.js';
export * from './scope.js';
export * from './schema-security.js';
export * from './normalizer.js';
export * from './approval-policy.js';
export * from './executor.js';
export * from './service.js';

export const name = 'dsh-mcp-governance';

export const inject = [];

export interface Config {
  defaultTimeoutMs?: number;
  maxInlineBytes?: number;
  maxSchemaDepth?: number;
  maxSchemaSizeBytes?: number;
}

export const Config: Schema<Config> = Schema.object({
  defaultTimeoutMs: Schema.natural().default(60_000).description('Default tool call timeout in milliseconds'),
  maxInlineBytes: Schema.natural().default(65_536).description('Max inline bytes before spill / truncation'),
  maxSchemaDepth: Schema.natural().default(16).description('Max schema nesting depth'),
  maxSchemaSizeBytes: Schema.natural().default(262_144).description('Max schema size in bytes'),
});

/**
 * Functional Cordis plugin that registers the McpGovernanceService.
 */
export function apply(ctx: Context, _config: Config = {}): void {
  ctx.plugin(McpGovernanceService);
}

export default McpGovernanceService;
