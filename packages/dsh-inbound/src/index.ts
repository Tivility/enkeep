/**
 * DSH Inbound Plugin.
 *
 * Receives authenticated platform transport requests (followup/cancel),
 * verifies idempotency against receipt store, and dispatches to ctx.agents.
 *
 * @module @enkeep/dsh-inbound
 */

import type { Context } from '@deepseek-ai/cordis';
import type { InboundConfig } from './types.js';
import { InboundService } from './service.js';

export * from './types.js';
export * from './errors.js';
export * from './wire-parser.js';
export * from './service.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    inbound: InboundService;
  }
}

/** Cordis plugin name */
export const name = 'dsh-inbound';

/** Injected services */
export const inject = ['agents'];

/** Plugin configuration type alias */
export type Config = InboundConfig;

/** Plugin configuration Standard Schema validator */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'enkeep',
    validate(value: unknown) {
      if (value === undefined || value === null) {
        return { value: {} as InboundConfig };
      }
      if (typeof value !== 'object') {
        return { issues: [{ message: 'Config must be an object' }] };
      }
      const c = value as Record<string, unknown>;
      return {
        value: {
          defaultTarget: typeof c['defaultTarget'] === 'string' ? (c['defaultTarget'] as InboundConfig['defaultTarget']) : 'followup',
          wireParser: c['wireParser'] as InboundConfig['wireParser'],
        } as InboundConfig,
      };
    },
  },
};

/**
 * Apply function for Cordis composition.
 *
 * @param ctx Plugin context (injected with agents)
 * @param config Plugin configuration
 */
export function apply(ctx: Context, config?: InboundConfig): void {
  const service = new InboundService(ctx, config);

  ctx.effect(() => {
    return () => {
      // Disposer effect for cleanup
    };
  }, 'inbound.lifecycle()');

  ctx.provide('inbound', service);
}
