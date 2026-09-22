/**
 * Turn Watchdog Timer & Budget Helper
 *
 * Lightweight shared helper managing turn execution budgets, idle activity timers,
 * approval waiting state suspension, and stream progress discrimination for both
 * HostDaemonTransport and DaemonDockerTransport.
 *
 * @module @enkeep/runtime-runner/transport/timer-helper
 */

import {
  DEFAULT_FOLLOWUP_TIMEOUT_MS,
  HC_DEFAULT_EXECUTION_BUDGET_MS,
  HC_DEFAULT_IDLE_TIMEOUT_MS,
} from './types.js';

export interface CalculatedTurnBudgets {
  /** The effective execution budget before grace (ms) */
  readonly rawBudgetMs: number;
  /** The absolute hard cap deadline with grace (ms) */
  readonly clientWaitTimeoutMs: number;
  /** The idle activity window (ms) */
  readonly idleTimeoutMs: number;
}

export interface TurnBudgetInput {
  readonly timeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly maxExecutionBudgetMs?: number;
}

export interface WatchdogOptionsInput {
  readonly defaultTimeoutMs?: number;
  readonly defaultExecutionBudgetMs?: number;
  readonly defaultIdleTimeoutMs?: number;
}

/**
 * Calculates effective execution budget, hard cap with proportional grace,
 * and idle timeout.
 *
 * Invariants:
 * 1. Explicit caller hard budget (maxExecutionBudgetMs or timeoutMs) is preserved untouched without silent expansion.
 * 2. If idleTimeoutMs is not explicitly provided, it defaults to the effective execution budget (rawBudgetMs),
 *    never to an arbitrary smaller clamp (e.g. 300s).
 * 3. Client wait timeout incorporates a finite grace window (min(60_000, rawBudgetMs)).
 */
export function calculateTurnBudgets(
  request: TurnBudgetInput,
  options: WatchdogOptionsInput
): CalculatedTurnBudgets {
  // 1. Determine execution budget (hard cap)
  let rawBudgetMs: number;
  if (request.maxExecutionBudgetMs !== undefined) {
    rawBudgetMs = request.maxExecutionBudgetMs;
  } else if (request.timeoutMs !== undefined) {
    rawBudgetMs = request.timeoutMs;
  } else if (options.defaultExecutionBudgetMs !== undefined) {
    rawBudgetMs = options.defaultExecutionBudgetMs;
  } else if (options.defaultTimeoutMs !== undefined) {
    rawBudgetMs = options.defaultTimeoutMs;
  } else {
    rawBudgetMs = DEFAULT_FOLLOWUP_TIMEOUT_MS;
  }

  // Finite hard cap with proportional grace <= 60s
  const clientWaitTimeoutMs = rawBudgetMs + Math.min(60_000, rawBudgetMs);

  // 2. Determine idle activity timeout
  // Default idle matches the effective execution budget unless configured
  let idleTimeoutMs: number;
  if (request.idleTimeoutMs !== undefined) {
    idleTimeoutMs = request.idleTimeoutMs;
  } else if (options.defaultIdleTimeoutMs !== undefined) {
    idleTimeoutMs = options.defaultIdleTimeoutMs;
  } else {
    idleTimeoutMs = rawBudgetMs;
  }

  return {
    rawBudgetMs,
    clientWaitTimeoutMs,
    idleTimeoutMs,
  };
}

export interface TurnWatchdogWaiter {
  readonly turnId: string;
  readonly sessionId: string;
  readonly resolve: (res: any) => void;
  readonly reject: (err: any) => void;
  timer?: NodeJS.Timeout;
  hardCapTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  readonly createdAt: number;
  lastActivityAt: number;
  readonly idleTimeoutMs: number;
  readonly rawTimeoutMs: number;
  readonly clientWaitTimeoutMs?: number;
  readonly pendingApprovals: Set<string>;
}

/**
 * Completely clears all timers associated with a turn waiter and clears pending approvals.
 */
export function clearWaiterTimers(waiter: TurnWatchdogWaiter): void {
  if (waiter.timer) {
    clearTimeout(waiter.timer);
    waiter.timer = undefined;
  }
  if (waiter.hardCapTimer) {
    clearTimeout(waiter.hardCapTimer);
    waiter.hardCapTimer = undefined;
  }
  if (waiter.idleTimer) {
    clearTimeout(waiter.idleTimer);
    waiter.idleTimer = undefined;
  }
  waiter.pendingApprovals.clear();
}

/**
 * Pauses the idle timer while keeping the overall hard cap timer running.
 * Used during interactive human approval waiting states.
 */
export function pauseWaiterIdleTimer(waiter: TurnWatchdogWaiter): void {
  if (waiter.idleTimer) {
    clearTimeout(waiter.idleTimer);
    waiter.idleTimer = undefined;
  }
}

/**
 * Refreshes or resets the waiter's idle activity timer.
 * If approvals are currently pending, the idle timer remains paused.
 */
export function refreshWaiterIdleTimer(
  waiter: TurnWatchdogWaiter,
  onIdleTimeout: () => void
): void {
  if (waiter.idleTimer) {
    clearTimeout(waiter.idleTimer);
    waiter.idleTimer = undefined;
  }
  if (waiter.pendingApprovals.size > 0) {
    // Under approval wait: do not arm idle timer; overall hard budget still applies
    return;
  }
  waiter.lastActivityAt = Date.now();
  waiter.idleTimer = setTimeout(onIdleTimeout, waiter.idleTimeoutMs);
}

/**
 * Extracts verified approval ID from an approval/asked event.
 * Validates actual schema: requires non-empty string approval id.
 */
export function extractVerifiedApprovalAsked(event: unknown): { approvalId: string } | null {
  if (!event || typeof event !== 'object') return null;
  const ev = event as Record<string, unknown>;

  // Case 1: direct daemon stream event: { type: 'event', event: 'approval/asked', approval: { id: string } }
  if (ev.type === 'event' && ev.event === 'approval/asked') {
    const app = ev.approval;
    if (app && typeof app === 'object' && typeof (app as any).id === 'string' && (app as any).id.trim().length > 0) {
      return { approvalId: (app as any).id.trim() };
    }
  }

  // Case 2: wrapped in turn/event: { type: 'event', event: 'turn/event', sessionEvent: { type: 'approval/asked', data: { id: string } } }
  if (ev.type === 'event' && ev.event === 'turn/event') {
    const sev = ev.sessionEvent;
    if (sev && typeof sev === 'object' && (sev as any).type === 'approval/asked') {
      const data = (sev as any).data;
      if (data && typeof data === 'object' && typeof (data as any).id === 'string' && (data as any).id.trim().length > 0) {
        return { approvalId: (data as any).id.trim() };
      }
    }
  }

  return null;
}

/**
 * Extracts verified approval decision ID from an approval/decided event.
 * Validates actual schema: requires non-empty string decision id and valid outcome.
 */
export function extractVerifiedApprovalDecided(event: unknown): { decisionId: string; outcome?: string } | null {
  if (!event || typeof event !== 'object') return null;
  const ev = event as Record<string, unknown>;

  // Case 1: direct daemon stream event: { type: 'event', event: 'approval/decided', decision: { id: string, outcome: string } }
  if (ev.type === 'event' && ev.event === 'approval/decided') {
    const dec = ev.decision;
    if (
      dec &&
      typeof dec === 'object' &&
      typeof (dec as any).id === 'string' &&
      (dec as any).id.trim().length > 0 &&
      typeof (dec as any).outcome === 'string'
    ) {
      return { decisionId: (dec as any).id.trim(), outcome: (dec as any).outcome };
    }
  }

  // Case 2: wrapped in turn/event: { type: 'event', event: 'turn/event', sessionEvent: { type: 'approval/decided', data: { id: string } } }
  if (ev.type === 'event' && ev.event === 'turn/event') {
    const sev = ev.sessionEvent;
    if (sev && typeof sev === 'object' && (sev as any).type === 'approval/decided') {
      const data = (sev as any).data;
      if (data && typeof data === 'object' && typeof (data as any).id === 'string' && (data as any).id.trim().length > 0) {
        return {
          decisionId: (data as any).id.trim(),
          outcome: typeof (data as any).outcome === 'string' ? (data as any).outcome : undefined,
        };
      }
    }
  }

  return null;
}

/**
 * Evaluates whether an incoming daemon push stream event constitutes genuine turn progress.
 *
 * Genuine progress resets the idle activity deadline (watching for hung/stalled agents),
 * whereas background heartbeats, pings, keepalives, and daemon stats are explicitly ignored
 * to prevent stalled or deadlocked turns from becoming immortal.
 */
export function isGenuineTurnProgress(event: unknown): boolean {
  if (!event || typeof event !== 'object') return false;
  const ev = event as Record<string, unknown>;
  if (ev.type !== 'event' || typeof ev.event !== 'string') return false;

  const eventName = ev.event;

  // Background daemon stats, pings, and heartbeats are explicitly NOT genuine progress
  if (
    eventName === 'daemon/stats' ||
    eventName === 'ping' ||
    eventName === 'heartbeat' ||
    eventName === 'keepalive' ||
    eventName === 'agent/evicted' ||
    eventName.startsWith('ping') ||
    eventName.startsWith('heartbeat') ||
    eventName.startsWith('telemetry')
  ) {
    return false;
  }

  // LLM streaming chunks (text-delta, tool-call-delta, reasoning-delta, block-start)
  if (eventName === 'turn/chunk') {
    return true;
  }

  // Turn started represents turn execution kickoff
  if (eventName === 'turn/started') {
    return true;
  }

  // Approval interactions: genuine progress ONLY when actual schema is verified
  if (eventName === 'approval/asked') {
    return extractVerifiedApprovalAsked(event) !== null;
  }
  if (eventName === 'approval/decided') {
    return extractVerifiedApprovalDecided(event) !== null;
  }

  // Session events inside turn/event
  if (eventName === 'turn/event' && ev.sessionEvent && typeof ev.sessionEvent === 'object') {
    const sessionEv = ev.sessionEvent as Record<string, unknown>;
    const t = typeof sessionEv.type === 'string' ? sessionEv.type : '';
    if (!t) return false;

    // Reject keepalives/pings/telemetry embedded in session events
    if (
      t === 'ping' ||
      t === 'heartbeat' ||
      t === 'keepalive' ||
      t === 'daemon/stats' ||
      t.startsWith('ping') ||
      t.startsWith('heartbeat') ||
      t.startsWith('telemetry')
    ) {
      return false;
    }

    // Approval session events: genuine progress ONLY when verified
    if (t === 'approval/asked') {
      return extractVerifiedApprovalAsked(event) !== null;
    }
    if (t === 'approval/decided') {
      return extractVerifiedApprovalDecided(event) !== null;
    }

    // Accept tool executions, assistant messages, reasoning, thoughts, and step boundaries
    return (
      t === 'assistant/chunk' ||
      t === 'assistant/message' ||
      t === 'tool/call' ||
      t === 'tool/result' ||
      t === 'tool/execution' ||
      t === 'step/start' ||
      t === 'step/end' ||
      t === 'turn/start' ||
      t === 'agent/progress' ||
      t === 'thought' ||
      t.startsWith('assistant/') ||
      t.startsWith('tool/') ||
      t.startsWith('step/')
    );
  }

  return false;
}
