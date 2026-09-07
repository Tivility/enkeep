/**
 * @enkeep/dsh-tool-cli
 *
 * Deterministic CLI Tool Provider and Extension Activation for Enkeep Runtime
 *
 * @module @enkeep/dsh-tool-cli
 */

export * from './types.js';
export * from './errors.js';
export * from './approvals.js';
export * from './scope.js';
export * from './executor.js';
export * from './service.js';

import type { Context } from '@deepseek-ai/cordis';
import { CliToolService } from './service.js';
import type { CliPluginConfig } from './types.js';

export const name = 'cli-tools';
export type Config = CliPluginConfig;

export function apply(ctx: Context, config: CliPluginConfig = {}) {
  return ctx.plugin(CliToolService, config);
}
