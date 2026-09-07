import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type {
  ToolDefinition,
  PlatformClientService,
  QuotaQueryPayload,
  CheckQuotaResult,
  ToolExecutionContext,
  ToolResult,
} from '../types.js';
import {
  createPlatformToolUnavailableError,
  createInvalidPlatformResponseError,
} from '../errors.js';

export const FIXED_QUOTA_METRICS = [
  'tokens',
  'messages',
  'turns',
  'storage_bytes',
  'api_calls',
] as const;

export const FIXED_QUOTA_METRICS_SET = new Set<string>(FIXED_QUOTA_METRICS);

export type FixedQuotaMetric = (typeof FIXED_QUOTA_METRICS)[number];

export interface CheckQuotaArgs {
  resource?: FixedQuotaMetric | 'all' | string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isCheckQuotaResult(value: unknown): value is CheckQuotaResult {
  return (
    isRecord(value) &&
    typeof value.allowed === 'boolean' &&
    isRecord(value.usage) &&
    isRecord(value.activeReservations) &&
    isRecord(value.limit) &&
    isRecord(value.remaining) &&
    (typeof value.resetAt === 'string' || value.resetAt === null)
  );
}

function isValidIsoDateOrNull(val: unknown): val is string | null {
  if (val === null) return true;
  if (typeof val !== 'string' || val.trim() === '') return false;
  const d = new Date(val);
  return !Number.isNaN(d.getTime()) && d.toISOString() === val;
}

function hasExactKeys(obj: unknown, expectedKeys: string[]): obj is Record<string, unknown> {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const keys = Object.keys(obj);
  if (keys.length !== expectedKeys.length) return false;
  const set = new Set(expectedKeys);
  return keys.every((k) => set.has(k));
}

function validateAndSanitizeQuotaNumbers(
  data: CheckQuotaResult
): CheckQuotaResult {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw createInvalidPlatformResponseError(
      'Platform quota telemetry payload is missing or invalid'
    );
  }

  if (
    !hasExactKeys(data as unknown as Record<string, unknown>, [
      'activeReservations',
      'allowed',
      'limit',
      'remaining',
      'resetAt',
      'usage',
    ])
  ) {
    throw createInvalidPlatformResponseError(
      'Platform quota telemetry contains invalid or unexpected fields'
    );
  }

  if (typeof data.allowed !== 'boolean') {
    throw createInvalidPlatformResponseError(
      'Platform quota telemetry allowed must be a strict boolean'
    );
  }

  if (data.resetAt === undefined || !isValidIsoDateOrNull(data.resetAt)) {
    throw createInvalidPlatformResponseError(
      'Platform quota telemetry resetAt must be a valid exact ISO 8601 string or null'
    );
  }

  if (!data.usage || typeof data.usage !== 'object' || Array.isArray(data.usage)) {
    throw createInvalidPlatformResponseError(
      'Platform quota telemetry usage must be a valid object'
    );
  }
  if (
    !data.activeReservations ||
    typeof data.activeReservations !== 'object' ||
    Array.isArray(data.activeReservations)
  ) {
    throw createInvalidPlatformResponseError(
      'Platform quota telemetry activeReservations must be a valid object'
    );
  }
  if (!data.limit || typeof data.limit !== 'object' || Array.isArray(data.limit)) {
    throw createInvalidPlatformResponseError(
      'Platform quota telemetry limit must be a valid object'
    );
  }
  if (!data.remaining || typeof data.remaining !== 'object' || Array.isArray(data.remaining)) {
    throw createInvalidPlatformResponseError(
      'Platform quota telemetry remaining must be a valid object'
    );
  }

  const expectedMetrics = [...FIXED_QUOTA_METRICS];

  if (!hasExactKeys(data.limit as Record<string, unknown>, expectedMetrics)) {
    throw createInvalidPlatformResponseError(
      'Platform quota telemetry limit keys must exact match fixed metrics'
    );
  }
  if (!hasExactKeys(data.usage as Record<string, unknown>, expectedMetrics)) {
    throw createInvalidPlatformResponseError(
      'Platform quota telemetry usage keys must exact match fixed metrics'
    );
  }
  if (
    !hasExactKeys(
      data.activeReservations as Record<string, unknown>,
      expectedMetrics
    )
  ) {
    throw createInvalidPlatformResponseError(
      'Platform quota telemetry activeReservations keys must exact match fixed metrics'
    );
  }
  if (!hasExactKeys(data.remaining as Record<string, unknown>, expectedMetrics)) {
    throw createInvalidPlatformResponseError(
      'Platform quota telemetry remaining keys must exact match fixed metrics'
    );
  }

  const sanitizedUsage: Record<string, number> = {};
  const sanitizedReservations: Record<string, number> = {};
  const sanitizedLimit: Record<string, number> = {};
  const sanitizedRemaining: Record<string, number> = {};

  let computedOverallAllowed = true;

  for (const metric of expectedMetrics) {
    if (!FIXED_QUOTA_METRICS_SET.has(metric)) {
      throw createInvalidPlatformResponseError(
        'Platform quota telemetry contains invalid non-fixed metric'
      );
    }

    const limitVal = (data.limit as Record<string, unknown>)[metric];
    if (
      typeof limitVal !== 'number' ||
      !Number.isSafeInteger(limitVal) ||
      limitVal < 0
    ) {
      throw createInvalidPlatformResponseError(
        'Platform quota telemetry limit must be a non-negative safe integer'
      );
    }

    const usageVal = (data.usage as Record<string, unknown>)[metric];
    if (
      typeof usageVal !== 'number' ||
      !Number.isSafeInteger(usageVal) ||
      usageVal < 0
    ) {
      throw createInvalidPlatformResponseError(
        'Platform quota telemetry usage must be a non-negative safe integer'
      );
    }

    const resVal = (data.activeReservations as Record<string, unknown>)[metric];
    if (
      typeof resVal !== 'number' ||
      !Number.isSafeInteger(resVal) ||
      resVal < 0
    ) {
      throw createInvalidPlatformResponseError(
        'Platform quota telemetry activeReservations must be a non-negative safe integer'
      );
    }

    const remainingVal = (data.remaining as Record<string, unknown>)[metric];
    if (
      typeof remainingVal !== 'number' ||
      !Number.isSafeInteger(remainingVal) ||
      remainingVal < 0
    ) {
      throw createInvalidPlatformResponseError(
        'Platform quota telemetry remaining must be a non-negative safe integer'
      );
    }

    const effectiveUsed = usageVal + resVal;
    const expectedRemaining = Math.max(0, limitVal - effectiveUsed);
    if (remainingVal !== expectedRemaining) {
      throw createInvalidPlatformResponseError(
        'Platform quota telemetry remaining does not match expected calculated remaining'
      );
    }

    if (effectiveUsed >= limitVal) {
      computedOverallAllowed = false;
    }

    sanitizedLimit[metric] = limitVal;
    sanitizedUsage[metric] = usageVal;
    sanitizedReservations[metric] = resVal;
    sanitizedRemaining[metric] = remainingVal;
  }

  if (data.allowed !== computedOverallAllowed) {
    throw createInvalidPlatformResponseError(
      'Platform quota telemetry allowed contradicts numerical evaluation'
    );
  }

  return {
    allowed: data.allowed,
    usage: sanitizedUsage,
    activeReservations: sanitizedReservations,
    limit: sanitizedLimit,
    remaining: sanitizedRemaining,
    resetAt: data.resetAt,
  };
}

export function createCheckQuotaTool(
  getClient: () => PlatformClientService | undefined
): ToolDefinition {
  return {
    name: 'check_quota',
    description:
      'Check authoritative usage, quotas, and resource limits on the Enkeep platform via canonical management API.',
    parameters: {
      type: 'object',
      properties: {
        resource: {
          type: 'string',
          enum: ['tokens', 'messages', 'turns', 'storage_bytes', 'api_calls', 'all'],
          description:
            'Optional resource identifier for display/presentation (metrics telemetry always returns all 5 fixed metrics: "tokens", "messages", "turns", "storage_bytes", "api_calls").',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          allowed: { type: 'boolean' },
          usage: { type: 'object' },
          activeReservations: { type: 'object' },
          limit: { type: 'object' },
          remaining: { type: 'object' },
          resetAt: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        },
        required: ['allowed', 'usage', 'activeReservations', 'limit', 'remaining', 'resetAt'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: JsonValue): ContentBlock[] => {
        if (isCheckQuotaResult(value)) {
          return [
            {
              type: 'text',
              text: `Quota status: ${value.allowed ? 'ALLOWED' : 'EXCEEDED'}. Usage: ${JSON.stringify(value.usage)}, ActiveReservations: ${JSON.stringify(value.activeReservations)}, Remaining: ${JSON.stringify(value.remaining)}`,
            },
          ];
        }
        return [{ type: 'text', text: 'Quota checked' }];
      },
    },
    async execute(
      rawArgs: unknown,
      _context?: ToolExecutionContext
    ): Promise<CheckQuotaResult> {
      // Validate optional resource argument if provided
      if (isRecord(rawArgs) && rawArgs.resource !== undefined && rawArgs.resource !== null) {
        if (
          typeof rawArgs.resource !== 'string' ||
          rawArgs.resource.length === 0 ||
          rawArgs.resource !== rawArgs.resource.trim()
        ) {
          throw new TypeError('check_quota resource argument must be an exact non-empty string');
        }
        const trimmedResource = rawArgs.resource;
        if (
          trimmedResource !== 'all' &&
          !FIXED_QUOTA_METRICS_SET.has(trimmedResource)
        ) {
          throw new TypeError(
            'Invalid quota resource. Allowed fixed metrics: tokens, messages, turns, storage_bytes, api_calls, or all'
          );
        }
      }

      const client = getClient();
      if (!client) {
        throw createPlatformToolUnavailableError(
          'Enkeep Platform Client service is not available (ctx.platformClient is missing)'
        );
      }

      const payload: QuotaQueryPayload = {
        resource: 'all',
      };

      if (typeof client.checkQuota === 'function') {
        const result = await client.checkQuota(payload);
        if (!result || typeof result !== 'object') {
          throw createInvalidPlatformResponseError(
            'Platform checkQuota returned an invalid or empty response'
          );
        }
        return validateAndSanitizeQuotaNumbers(result);
      }

      if (typeof client.request === 'function') {
        // Canonical PlatformServer Authenticated Management API: GET /api/manage/quota/check?metrics=all
        const res = await client.request<{
          success?: boolean;
          data?: CheckQuotaResult;
        }>('/api/manage/quota/check', {
          method: 'GET',
          query: {
            metrics: 'all',
          },
        });

        if (!res || typeof res !== 'object' || typeof res.status !== 'number') {
          throw createInvalidPlatformResponseError(
            'Platform request returned an invalid HTTP response structure'
          );
        }

        if (res.status < 200 || res.status >= 300) {
          throw createInvalidPlatformResponseError(
            'Platform request failed'
          );
        }

        const rawData = res.data;
        if (!hasExactKeys(rawData, ['data', 'success'])) {
          throw createInvalidPlatformResponseError(
            'Platform request response body is missing or invalid'
          );
        }

        if (rawData.success !== true) {
          throw createInvalidPlatformResponseError(
            'Platform request returned unsuccessful error envelope'
          );
        }

        const data = rawData.data;
        if (!data || typeof data !== 'object') {
          throw createInvalidPlatformResponseError(
            'Platform request response data payload is missing or invalid'
          );
        }

        return validateAndSanitizeQuotaNumbers(data as CheckQuotaResult);
      }

      throw createPlatformToolUnavailableError(
        'PlatformClient does not implement checkQuota or request method'
      );
    },
    presentCall: (rawArgs: unknown) => ({
      card: 'generic',
      title: isRecord(rawArgs) && typeof rawArgs.resource === 'string'
        ? `Check quota for ${rawArgs.resource}`
        : 'Check overall quota',
    }),
    presentResult: (_args: unknown, result: ToolResult) => ({
      card: 'generic',
      title: !result.isError ? 'Quota checked' : 'Quota check failed',
    }),
  };
}
