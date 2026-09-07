/**
 * DSH Receipt Store SQLite Service Provider Plugin.
 *
 * Persists deliveryId -> messageId, session sources, event cursors, and seed import receipts
 * for single-tenant container environments with schema migrations and
 * restart recovery.
 *
 * @module @enkeep/dsh-receipt-store-sqlite
 */

import type { Context } from '@deepseek-ai/cordis';
import type { ReceiptStoreConfig } from './types.js';
import { SqliteReceiptStore } from './store.js';
import { isRecord } from './errors.js';

export * from './types.js';
export * from './errors.js';
export * from './schema.js';
export * from './store.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    receiptStore: SqliteReceiptStore;
  }
}

/** Cordis plugin name */
export const name = 'dsh-receipt-store-sqlite';

/** Injected services (none required, this is a service provider) */
export const inject = [];

/** Plugin configuration type alias */
export type Config = ReceiptStoreConfig;

type JournalMode = NonNullable<ReceiptStoreConfig['journalMode']>;

function isJournalMode(val: unknown): val is JournalMode {
  return typeof val === 'string' && (
    val === 'wal' ||
    val === 'delete' ||
    val === 'truncate' ||
    val === 'persist' ||
    val === 'memory' ||
    val === 'off'
  );
}

const ALLOWED_CONFIG_KEYS = new Set(['path', 'userId', 'journalMode', 'busyTimeoutMs']);
const CANONICAL_USER_ID_REGEX = /^[A-Za-z0-9_\-:.]{1,128}$/;

/** Plugin configuration standard schema validator */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'enkeep',
    validate(value: unknown) {
      if (!isRecord(value)) {
        return { issues: [{ message: 'Config must be a plain object' }] };
      }

      // 1. Exact own keys check - no unknown properties allowed
      for (const key of Object.keys(value)) {
        if (!ALLOWED_CONFIG_KEYS.has(key)) {
          return { issues: [{ message: `Unexpected configuration key '${key}' is not allowed` }] };
        }
      }

      // 2. path validation (mandatory non-empty string)
      const rawPath = value.path;
      if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
        return { issues: [{ message: 'Config.path is required and must be a non-empty string' }] };
      }
      const trimmedPath = rawPath.trim();

      // 3. userId validation (mandatory canonical non-empty identifier)
      const rawUserId = value.userId;
      if (typeof rawUserId !== 'string' || rawUserId.trim().length === 0) {
        return { issues: [{ message: 'Config.userId is required and must be a non-empty string' }] };
      }
      const trimmedUserId = rawUserId.trim();
      if (!CANONICAL_USER_ID_REGEX.test(trimmedUserId)) {
        return {
          issues: [
            {
              message: `Config.userId must be a valid canonical identifier matching /^[A-Za-z0-9_\\-:.]{1,128}$/ (got '${trimmedUserId}')`,
            },
          ],
        };
      }

      // 4. journalMode validation (optional enum)
      let validatedJournalMode: JournalMode | undefined;
      if ('journalMode' in value && value.journalMode !== undefined) {
        const rawJm = typeof value.journalMode === 'string' ? value.journalMode.toLowerCase() : value.journalMode;
        if (!isJournalMode(rawJm)) {
          return {
            issues: [
              {
                message: `Config.journalMode must be one of: wal, delete, truncate, persist, memory, off (got '${String(value.journalMode)}')`,
              },
            ],
          };
        }
        validatedJournalMode = rawJm;
      }

      // 5. busyTimeoutMs validation (optional integer 1..60000, default 5000 only when absent)
      let validatedBusyTimeout = 5000;
      if ('busyTimeoutMs' in value && value.busyTimeoutMs !== undefined) {
        const rawBt = value.busyTimeoutMs;
        if (typeof rawBt !== 'number' || !Number.isSafeInteger(rawBt) || rawBt < 1 || rawBt > 60000) {
          return {
            issues: [
              {
                message: `Config.busyTimeoutMs must be an integer between 1 and 60000 (got '${String(rawBt)}')`,
              },
            ],
          };
        }
        validatedBusyTimeout = rawBt;
      }

      const validatedConfig: ReceiptStoreConfig = {
        path: trimmedPath,
        userId: trimmedUserId,
        ...(validatedJournalMode ? { journalMode: validatedJournalMode } : {}),
        busyTimeoutMs: validatedBusyTimeout,
      };

      return {
        value: validatedConfig,
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
export function apply(ctx: Context, config: ReceiptStoreConfig): void {
  const store = new SqliteReceiptStore(config);

  ctx.effect(() => {
    store.init();
    return () => store.close();
  }, 'receiptStore.lifecycle()');

  ctx.provide('receiptStore', store);
}
