/**
 * DSH Event Relay Plugin.
 *
 * Listens to `session/event`, keeps bounded per-session buffers of event envelopes,
 * and provides per-session polling, real-time subscription, backpressure, and cursor acknowledgement.
 *
 * @module @enkeep/dsh-event-relay
 */

import type { Context } from '@deepseek-ai/cordis';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { EventRelayConfig } from './types.js';
import { EventRelayService } from './service.js';

export * from './types.js';
export * from './errors.js';
export * from './bounded-buffer.js';
export * from './service.js';

export interface IPlatformClientResponse<T = unknown> {
  readonly status: number;
  readonly headers?: Record<string, string | string[] | undefined>;
  readonly data: T;
  readonly rawBody?: Buffer;
  readonly requestId?: string;
}

export interface IPlatformClientService {
  request<T = unknown>(
    path: string,
    options?: {
      method?: string;
      body?: unknown;
      timeoutMs?: number;
      maxRetries?: number;
      query?: Record<string, string | number | boolean | undefined | null>;
    }
  ): Promise<IPlatformClientResponse<T>>;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    eventRelay: EventRelayService;
    platformClient?: any;
  }
}

/** Cordis plugin name */
export const name = 'dsh-event-relay';

/** Injected services (optional receiptStore resolved dynamically) */
export const inject = [];

/** Plugin configuration type alias */
export type Config = EventRelayConfig;

/** Plugin configuration Standard Schema validator */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'enkeep',
    validate(value: unknown) {
      if (value === undefined || value === null) {
        return { value: {} as EventRelayConfig };
      }
      if (typeof value !== 'object') {
        return { issues: [{ message: 'Config must be an object' }] };
      }
      const c = value as Record<string, unknown>;
      return {
        value: {
          maxBufferSize: typeof c['maxBufferSize'] === 'number' ? c['maxBufferSize'] : 1000,
          consumer: typeof c['consumer'] === 'string' ? c['consumer'] : 'default',
          batchIntervalMs: typeof c['batchIntervalMs'] === 'number' ? c['batchIntervalMs'] : 30,
          maxBatchSizeBytes: typeof c['maxBatchSizeBytes'] === 'number' ? c['maxBatchSizeBytes'] : 32768,
          maxPendingBytes: typeof c['maxPendingBytes'] === 'number' ? c['maxPendingBytes'] : 262144,
        } as EventRelayConfig,
      };
    },
  },
};

/**
 * Apply function for Cordis composition.
 *
 * @param ctx Plugin context
 * @param config Plugin configuration
 */
export function apply(ctx: Context, config?: EventRelayConfig): void {
  const service = new EventRelayService(ctx, config);

  ctx.effect(() => {
    return () => {
      service.clear();
    };
  }, 'eventRelay.lifecycle()');

  ctx.provide('eventRelay', service);
}
