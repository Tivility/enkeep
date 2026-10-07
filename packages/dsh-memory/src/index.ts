/**
 * Memory Plugin for DeepSeek Harness (Enkeep Runtime)
 *
 * Provides:
 * 1. MemoryService on Cordis context (`ctx.memory`).
 * 2. Mounts global and space memory into active agent contexts.
 * 3. Injects model-visible `<enkeep_memory>` prompt section into SystemPromptRegistry (order 50).
 * 4. Provides `memory_search`, `memory_read`, `memory_write` tools.
 * 5. Full lifecycle cleanup with zero resource leaks.
 *
 * @module @enkeep/dsh-memory
 */

import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { MemoryService } from './service.js';

import type { MemoryPluginConfig } from './types.js';

export * from './types.js';
export * from './prompt.js';
export * from './tools/memory-search.js';
export * from './tools/memory-read.js';
export * from './tools/memory-write.js';
export * from './service.js';

export const name = 'enkeep-dsh-memory';

export const inject = [];

export type Config = MemoryPluginConfig;

export const Config: Schema<Config> = Schema.object({
  defaultMaxGlobalBytes: Schema.natural().default(20_480).description('Default maximum global memory bytes to inject (20 KiB)'),
  injectGlobalMemory: Schema.union(['always', 'never', 'auto'] as const).default('always').description('Global memory injection mode'),
});

/**
 * Functional Cordis plugin that registers the MemoryService.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.plugin(MemoryService, config);
}
