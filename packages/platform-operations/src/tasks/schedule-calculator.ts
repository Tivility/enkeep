import { CronExpressionParser } from 'cron-parser';
import { ValidationError } from '../errors/index.js';
import type {
  TaskScheduleType,
  TaskScheduleMisfirePolicy,
  TaskScheduleOverlapPolicy,
} from '../types/task.js';
import {
  TASK_SCHEDULE_TYPES,
  TASK_SCHEDULE_MISFIRE_POLICIES,
  TASK_SCHEDULE_OVERLAP_POLICIES,
  validateCanonicalDueDate,
} from '../types/task.js';

export const MIN_INTERVAL_SECONDS = 60;
export const MAX_INTERVAL_SECONDS = 31_536_000; // 1 year

/**
 * Validates schedule type strictly ('once', 'cron', 'interval').
 */
export function validateScheduleType(type: unknown): TaskScheduleType {
  if (type === undefined || type === null) {
    return 'once';
  }
  if (typeof type !== 'string' || !TASK_SCHEDULE_TYPES.includes(type as TaskScheduleType)) {
    throw new ValidationError(`Invalid schedule type: "${String(type)}". Expected "once", "cron", or "interval".`);
  }
  return type as TaskScheduleType;
}

/**
 * Validates 5-field cron expression in UTC, requiring minimum recurrence interval of 60 seconds.
 */
export function validateCronExpression(cron: unknown): string {
  if (typeof cron !== 'string' || !cron.trim()) {
    throw new ValidationError('Cron expression is required and must be a non-empty string.');
  }

  const trimmed = cron.trim();
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    throw new ValidationError(
      `Cron expression must have exactly 5 fields (minute, hour, day-of-month, month, day-of-week). Found ${fields.length} fields.`
    );
  }

  try {
    const parser = CronExpressionParser.parse(trimmed, {
      currentDate: new Date('2026-01-01T00:00:00.000Z'),
      tz: 'UTC',
    });
    const t1 = parser.next().getTime();
    const t2 = parser.next().getTime();
    if (t2 - t1 < MIN_INTERVAL_SECONDS * 1000) {
      throw new ValidationError(
        `Cron expression interval cannot be less than ${MIN_INTERVAL_SECONDS} seconds.`
      );
    }
  } catch (err: unknown) {
    if (err instanceof ValidationError) {
      throw err;
    }
    throw new ValidationError(`Invalid cron expression "${trimmed}": ${(err as Error).message}`);
  }

  return trimmed;
}

/**
 * Validates interval in seconds (min 60, max 31,536,000).
 */
export function validateIntervalSeconds(seconds: unknown): number {
  if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds)) {
    throw new ValidationError('Interval seconds must be a safe integer.');
  }
  if (seconds < MIN_INTERVAL_SECONDS) {
    throw new ValidationError(`Interval seconds must be at least ${MIN_INTERVAL_SECONDS} seconds.`);
  }
  if (seconds > MAX_INTERVAL_SECONDS) {
    throw new ValidationError(`Interval seconds cannot exceed ${MAX_INTERVAL_SECONDS} seconds (1 year).`);
  }
  return seconds;
}

/**
 * Validates misfire policy ('coalesce', 'skip').
 */
export function validateMisfirePolicy(policy: unknown): TaskScheduleMisfirePolicy {
  if (policy === undefined || policy === null) {
    return 'coalesce';
  }
  if (typeof policy !== 'string' || !TASK_SCHEDULE_MISFIRE_POLICIES.includes(policy as TaskScheduleMisfirePolicy)) {
    throw new ValidationError(`Invalid misfire policy: "${String(policy)}". Expected "coalesce" or "skip".`);
  }
  return policy as TaskScheduleMisfirePolicy;
}

/**
 * Validates overlap policy ('skip').
 */
export function validateOverlapPolicy(policy: unknown): TaskScheduleOverlapPolicy {
  if (policy === undefined || policy === null) {
    return 'skip';
  }
  if (typeof policy !== 'string' || !TASK_SCHEDULE_OVERLAP_POLICIES.includes(policy as TaskScheduleOverlapPolicy)) {
    throw new ValidationError(`Invalid overlap policy: "${String(policy)}". Expected "skip".`);
  }
  return policy as TaskScheduleOverlapPolicy;
}

export interface ScheduleCalculationParams {
  scheduleType: TaskScheduleType;
  cronExpression?: string | null;
  intervalSeconds?: number | null;
  dueDate?: string | null;
  lastRunAt?: string | null;
  pausedAt?: string | null;
  enabled?: boolean;
}

/**
 * Deterministic calculation of next_run_at with clock injection.
 * DST-free UTC evaluation.
 */
export function computeNextRun(
  params: ScheduleCalculationParams,
  now: Date | string = new Date()
): string | null {
  if (params.enabled === false || params.pausedAt) {
    return null;
  }

  const clock = typeof now === 'string' ? new Date(now) : now;
  if (Number.isNaN(clock.getTime())) {
    throw new ValidationError('Invalid clock date provided for schedule calculation');
  }

  switch (params.scheduleType) {
    case 'once': {
      if (params.dueDate) {
        return validateCanonicalDueDate(params.dueDate);
      }
      return null;
    }

    case 'interval': {
      if (!params.intervalSeconds || params.intervalSeconds < MIN_INTERVAL_SECONDS) {
        return null;
      }
      const intervalMs = params.intervalSeconds * 1000;
      const nextTime = new Date(clock.getTime() + intervalMs);
      return nextTime.toISOString();
    }

    case 'cron': {
      if (!params.cronExpression) {
        return null;
      }
      try {
        const interval = CronExpressionParser.parse(params.cronExpression, {
          currentDate: clock,
          tz: 'UTC',
        });
        const nextDate = interval.next();
        return nextDate.toISOString();
      } catch {
        return null;
      }
    }

    default:
      return null;
  }
}
