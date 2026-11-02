/**
 * Pure approval policy helpers (no Cordis/DSH runtime imports) shared by the in-container
 * external interaction plugin and the host-side platform ApprovalBridge.
 *
 * @module @enkeep/dsh-external-interaction/approval-policy
 */

import type { ApprovalRiskLevel } from './types.js';

/** Default wait for a human answer to an approval or question (60 s). */
export const DEFAULT_INTERACTION_TIMEOUT_MS = 60_000;

/**
 * Deployment setting for how long an approval waits for a human answer, in milliseconds.
 * Read by the in-container plugin (overrides the composed default) and by the platform
 * ApprovalBridge (expected expiry of approvals whose container did not report one).
 */
export const APPROVAL_TIMEOUT_ENV = 'ENKEEP_APPROVAL_TIMEOUT_MS';

/** Bounds accepted for {@link APPROVAL_TIMEOUT_ENV}: 1 s .. 24 h. */
export const MIN_APPROVAL_TIMEOUT_MS = 1_000;
export const MAX_APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * Parses an approval timeout value (decimal milliseconds). Returns undefined when the value is
 * missing, not a plain non-negative integer, or outside the accepted bounds.
 */
export function parseApprovalTimeoutMs(raw: unknown): number | undefined {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw >= MIN_APPROVAL_TIMEOUT_MS && raw <= MAX_APPROVAL_TIMEOUT_MS
      ? raw
      : undefined;
  }
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!/^\d{1,9}$/.test(trimmed)) return undefined;
  return parseApprovalTimeoutMs(Number.parseInt(trimmed, 10));
}

/**
 * Effective approval timeout. Precedence: explicit `configured` value, then the
 * `ENKEEP_APPROVAL_TIMEOUT_MS` environment value, then `fallback`, then 60 s.
 * Composed values (`configured`, `fallback`) only need to be positive integers; the environment
 * value must also lie within the accepted bounds. Invalid values at any level are ignored.
 */
export function resolveApprovalTimeoutMs(options: {
  configured?: number;
  env?: Readonly<Record<string, string | undefined>>;
  fallback?: number;
} = {}): number {
  return (
    positiveMs(options.configured) ??
    parseApprovalTimeoutMs(options.env?.[APPROVAL_TIMEOUT_ENV]) ??
    positiveMs(options.fallback) ??
    DEFAULT_INTERACTION_TIMEOUT_MS
  );
}

function positiveMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * Classifies tool execution risk level and produces a safe human-readable summary
 * without leaking raw command arguments, secrets, or internal paths.
 */
export function classifyToolRiskAndSummary(
  toolName: string,
  reason?: string
): { risk: ApprovalRiskLevel; safeSummary: string } {
  switch (toolName) {
    case 'bash':
      return {
        risk: 'high',
        safeSummary: reason ?? 'Execute shell command in space workspace',
      };
    case 'write':
      return {
        risk: 'medium',
        safeSummary: reason ?? 'Write or replace file in space workspace',
      };
    case 'edit':
      return {
        risk: 'medium',
        safeSummary: reason ?? 'Edit file content in space workspace',
      };
    case 'subagent':
    case 'subagent_fork':
      return {
        risk: 'medium',
        safeSummary: reason ?? `Spawn subagent (${toolName})`,
      };
    case 'interrupt_agent':
      return {
        risk: 'low',
        safeSummary: reason ?? 'Interrupt subagent execution',
      };
    case 'send_platform_message':
    case 'send_message':
      return {
        risk: 'low',
        safeSummary: reason ?? 'Send outbound message notification',
      };
    case 'create_task':
      return {
        risk: 'low',
        safeSummary: reason ?? 'Create platform task',
      };
    default:
      return {
        risk: 'medium',
        safeSummary: reason ?? `Execute tool "${toolName}"`,
      };
  }
}
