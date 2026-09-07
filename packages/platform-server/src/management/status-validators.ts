/**
 * Strict Status Validators for Runtime & Operations Readiness Contracts
 *
 * Implements truthful, minimal contract validation for:
 * - UserRuntimeStatus (successful runtime health query only)
 * - OperationsReadinessStatus (nested producer & worker contracts only)
 *
 * @module @enkeep/platform-server/management/status-validators
 */

import type {
  PluginReadinessStatus,
  ToolsUnavailableReasonCode,
  UserRuntimeStatus,
  OperationsProducerStatus,
  OperationsProducerUnavailableReason,
  OperationsWorkerStatus,
  OperationsWorkerUnavailableReason,
  OperationsReadinessStatus,
} from './types.js';

export const VALID_RUNTIME_HEALTH_STATUSES = new Set<UserRuntimeStatus['status']>(['ok', 'degraded', 'error']);

export function isRuntimeHealthStatus(val: unknown): val is UserRuntimeStatus['status'] {
  switch (val) {
    case 'ok':
    case 'degraded':
    case 'error':
      return true;
    default:
      return false;
  }
}

export const EXACT_CORDIS_PLUGIN_KEYS = [
  'receiptStore',
  'inbound',
  'eventRelay',
  'tools',
  'externalInteraction',
  'affinityPolicy',
  'llmAffinity',
] as const;

export const EXACT_USER_RUNTIME_KEYS = [
  'userId',
  'status',
  'networkMode',
  'dshReady',
  'uptimeSeconds',
  'version',
  'enkeepBundleLoaded',
  'toolsCount',
  'plugins',
  'toolsOperational',
  'toolsUnavailableReason',
] as const;

export const ALLOWED_TOOLS_UNAVAILABLE_REASONS = [
  'PLATFORM_CLIENT_UNAVAILABLE',
  'TOOLS_REGISTRY_UNAVAILABLE',
  'TOOLS_SCHEMA_PROBE_FAILED',
  'TOOLS_SCHEMA_INCOMPLETE',
] as const;

export const ALLOWED_TOOLS_UNAVAILABLE_CODES = new Set<ToolsUnavailableReasonCode>(
  ALLOWED_TOOLS_UNAVAILABLE_REASONS
);

export const ALLOWED_OPERATIONS_PRODUCER_UNAVAILABLE_REASONS = [
  'OPERATIONS_PROVIDER_UNAVAILABLE',
] as const;

export const ALLOWED_OPERATIONS_PRODUCER_UNAVAILABLE_CODES = new Set<OperationsProducerUnavailableReason>(
  ALLOWED_OPERATIONS_PRODUCER_UNAVAILABLE_REASONS
);

export const ALLOWED_OPERATIONS_WORKER_UNAVAILABLE_REASONS = [
  'WORKER_DISABLED',
  'WORKER_UNAVAILABLE',
] as const;

export const ALLOWED_OPERATIONS_WORKER_UNAVAILABLE_CODES = new Set<OperationsWorkerUnavailableReason>(
  ALLOWED_OPERATIONS_WORKER_UNAVAILABLE_REASONS
);

const USER_ID_REGEX = /^(?:usr_[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-zA-Z0-9_-]+)$/;

export function isToolsUnavailableReasonCode(code: unknown): code is ToolsUnavailableReasonCode {
  switch (code) {
    case 'PLATFORM_CLIENT_UNAVAILABLE':
    case 'TOOLS_REGISTRY_UNAVAILABLE':
    case 'TOOLS_SCHEMA_PROBE_FAILED':
    case 'TOOLS_SCHEMA_INCOMPLETE':
      return true;
    default:
      return false;
  }
}

export function isOperationsProducerUnavailableReason(code: unknown): code is OperationsProducerUnavailableReason {
  return code === 'OPERATIONS_PROVIDER_UNAVAILABLE';
}

export function isOperationsWorkerUnavailableReason(code: unknown): code is OperationsWorkerUnavailableReason {
  switch (code) {
    case 'WORKER_DISABLED':
    case 'WORKER_UNAVAILABLE':
      return true;
    default:
      return false;
  }
}

/**
 * Validates a raw object against the truthful, minimal UserRuntimeStatus contract.
 *
 * Requirements:
 * - Only represents a successfully queried runtime health state.
 * - Exact 11 keys required; extraneous keys (available, containerId, etc.) rejected.
 * - userId: alphanumeric / underscore / dash / UUID / canonical prefix. Raw exact, no trim.
 * - status: 'ok' | 'degraded' | 'error' only (starting/stopped/unavailable rejected).
 * - networkMode: strictly 'none'.
 * - uptimeSeconds: finite number >= 0.
 * - version: raw non-empty string, NFC-normalized, bounded length, no control chars.
 * - enkeepBundleLoaded: boolean.
 * - toolsCount: finite safe integer >= 0.
 * - plugins: exact 7 boolean keys.
 * - toolsOperational & toolsUnavailableReason relationship:
 *   - toolsOperational === true => toolsUnavailableReason MUST be null.
 *   - toolsOperational === false => toolsUnavailableReason MUST be an exact union reason code.
 */
export function validateUserRuntimeStatus(raw: unknown): UserRuntimeStatus | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const rawKeys = Object.keys(raw);
  const allowedKeys = new Set<string>([...EXACT_USER_RUNTIME_KEYS, 'instanceId', 'mode']);
  for (const k of rawKeys) {
    if (!allowedKeys.has(k)) {
      return null;
    }
  }

  const r = raw as Record<string, unknown>;

  // Check all exact required keys are present on the record
  for (const key of EXACT_USER_RUNTIME_KEYS) {
    if (!(key in r)) {
      return null;
    }
  }

  // Optional instanceId
  let instanceId: string | undefined = undefined;
  if ('instanceId' in r) {
    if (typeof r.instanceId !== 'string' || r.instanceId.trim().length === 0) {
      return null;
    }
    instanceId = r.instanceId;
  }

  // Optional mode
  let mode: 'container' | 'host' | undefined = undefined;
  if ('mode' in r) {
    if (r.mode !== 'container' && r.mode !== 'host') {
      return null;
    }
    mode = r.mode;
  }

  // 1. userId (raw exact, no trim)
  if (typeof r.userId !== 'string' || r.userId.length === 0 || !USER_ID_REGEX.test(r.userId)) {
    return null;
  }
  const userId = r.userId;

  // 2. status ('ok' | 'degraded' | 'error')
  if (!isRuntimeHealthStatus(r.status)) {
    return null;
  }
  const status = r.status;

  // 3. networkMode ('none' only)
  if (r.networkMode !== 'none') {
    return null;
  }

  // 4. dshReady
  if (typeof r.dshReady !== 'boolean') {
    return null;
  }
  const dshReady = r.dshReady;

  // 5. uptimeSeconds (finite >= 0)
  if (typeof r.uptimeSeconds !== 'number' || !Number.isFinite(r.uptimeSeconds) || r.uptimeSeconds < 0) {
    return null;
  }
  const uptimeSeconds = r.uptimeSeconds;

  // 6. version (raw non-empty NFC-normalized string <= 128 bytes, no control chars, not whitespace-only)
  if (
    typeof r.version !== 'string' ||
    r.version.trim().length === 0 ||
    r.version.length > 128 ||
    r.version !== r.version.normalize('NFC') ||
    /[\u0000-\u001F\u007F-\u009F]/.test(r.version)
  ) {
    return null;
  }
  const version = r.version;

  // 7. enkeepBundleLoaded
  if (typeof r.enkeepBundleLoaded !== 'boolean') {
    return null;
  }
  const enkeepBundleLoaded = r.enkeepBundleLoaded;

  // 8. toolsCount (finite safe integer >= 0)
  if (typeof r.toolsCount !== 'number' || !Number.isSafeInteger(r.toolsCount) || r.toolsCount < 0) {
    return null;
  }
  const toolsCount = r.toolsCount;

  // 9. plugins (exact 7 boolean keys)
  if (!r.plugins || typeof r.plugins !== 'object' || Array.isArray(r.plugins) || Object.keys(r.plugins).length !== EXACT_CORDIS_PLUGIN_KEYS.length) {
    return null;
  }
  const p = r.plugins as Record<string, unknown>;
  for (const key of EXACT_CORDIS_PLUGIN_KEYS) {
    if (typeof p[key] !== 'boolean') {
      return null;
    }
  }
  const plugins: PluginReadinessStatus = {
    receiptStore: p.receiptStore as boolean,
    inbound: p.inbound as boolean,
    eventRelay: p.eventRelay as boolean,
    tools: p.tools as boolean,
    externalInteraction: p.externalInteraction as boolean,
    affinityPolicy: p.affinityPolicy as boolean,
    llmAffinity: p.llmAffinity as boolean,
  };

  // 10. toolsOperational & 11. toolsUnavailableReason
  if (typeof r.toolsOperational !== 'boolean') {
    return null;
  }
  const toolsOperational = r.toolsOperational;

  let toolsUnavailableReason: ToolsUnavailableReasonCode | null = null;
  if (toolsOperational === true) {
    if (r.toolsUnavailableReason !== null) {
      return null;
    }
    toolsUnavailableReason = null;
  } else {
    if (!isToolsUnavailableReasonCode(r.toolsUnavailableReason)) {
      return null;
    }
    toolsUnavailableReason = r.toolsUnavailableReason;
  }

  return {
    userId,
    status,
    networkMode: 'none',
    dshReady,
    uptimeSeconds,
    version,
    enkeepBundleLoaded,
    toolsCount,
    plugins,
    toolsOperational,
    toolsUnavailableReason,
    ...(instanceId !== undefined ? { instanceId } : {}),
    ...(mode !== undefined ? { mode } : {}),
  };
}

/**
 * Validates OperationsProducerStatus.
 *
 * Rules:
 * - Exact keys: ['available', 'unavailableReason']
 * - available === true => unavailableReason === null
 * - available === false => unavailableReason === 'OPERATIONS_PROVIDER_UNAVAILABLE'
 */
export function validateOperationsProducerStatus(raw: unknown): OperationsProducerStatus | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const keys = Object.keys(raw);
  if (keys.length !== 2) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (!('available' in r) || !('unavailableReason' in r)) {
    return null;
  }
  if (typeof r.available !== 'boolean') {
    return null;
  }

  if (r.available) {
    if (r.unavailableReason !== null) {
      return null;
    }
    return {
      available: true,
      unavailableReason: null,
    };
  } else {
    if (r.unavailableReason !== 'OPERATIONS_PROVIDER_UNAVAILABLE') {
      return null;
    }
    return {
      available: false,
      unavailableReason: 'OPERATIONS_PROVIDER_UNAVAILABLE',
    };
  }
}

/**
 * Validates OperationsWorkerStatus.
 *
 * Rules:
 * - Exact keys: ['available', 'running', 'unavailableReason']
 * - running => available (if running === true, available must be true)
 * - available === true => unavailableReason === null
 * - available === false => running === false and unavailableReason is 'WORKER_DISABLED' | 'WORKER_UNAVAILABLE'
 */
export function validateOperationsWorkerStatus(raw: unknown): OperationsWorkerStatus | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const keys = Object.keys(raw);
  if (keys.length !== 3) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (!('available' in r) || !('running' in r) || !('unavailableReason' in r)) {
    return null;
  }
  if (typeof r.available !== 'boolean' || typeof r.running !== 'boolean') {
    return null;
  }

  // running => available
  if (r.running && !r.available) {
    return null;
  }

  if (r.available) {
    if (r.unavailableReason !== null) {
      return null;
    }
    return {
      available: true,
      running: r.running,
      unavailableReason: null,
    };
  } else {
    if (r.running) {
      return null;
    }
    if (!isOperationsWorkerUnavailableReason(r.unavailableReason)) {
      return null;
    }
    return {
      available: false,
      running: false,
      unavailableReason: r.unavailableReason,
    };
  }
}

/**
 * Validates OperationsReadinessStatus.
 *
 * Rules:
 * - Exact keys: ['producer', 'worker']
 * - No top fields (no status/mode/enabled/aliases)
 * - Validates nested producer and worker structures strictly.
 */
export function validateOperationsReadinessStatus(raw: unknown): OperationsReadinessStatus | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const keys = Object.keys(raw);
  if (keys.length !== 2) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (!('producer' in r) || !('worker' in r)) {
    return null;
  }

  const producer = validateOperationsProducerStatus(r.producer);
  if (!producer) {
    return null;
  }

  const worker = validateOperationsWorkerStatus(r.worker);
  if (!worker) {
    return null;
  }

  return {
    producer,
    worker,
  };
}
