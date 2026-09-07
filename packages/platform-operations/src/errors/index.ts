import {
  PlatformError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  TenantAccessDeniedError,
  ValidationError,
} from '@enkeep/platform-core';

export {
  PlatformError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  TenantAccessDeniedError,
  ValidationError,
};

export class PlatformOperationsError extends PlatformError {
  constructor(message: string, code = 'PLATFORM_OPERATIONS_ERROR', status = 500) {
    super(message, code, status);
  }
}

// --- Quota & Budget Errors ---

export class QuotaExceededError extends PlatformOperationsError {
  readonly resource: string;
  readonly requested: number;
  readonly available: number;

  constructor(resource: string, requested: number, available: number, message?: string) {
    super(
      message || `Quota exceeded for resource "${resource}": requested ${requested}, available ${available}`,
      'QUOTA_EXCEEDED',
      429
    );
    this.resource = resource;
    this.requested = requested;
    this.available = available;
  }
}

export class InvalidReservationError extends PlatformOperationsError {
  readonly reservationId: string;

  constructor(reservationId: string, message = 'Invalid or non-existent reservation') {
    super(message, 'INVALID_RESERVATION', 400);
    this.reservationId = reservationId;
  }
}

export class ReservationExpiredError extends PlatformOperationsError {
  readonly reservationId: string;

  constructor(reservationId: string, message = 'Reservation has expired') {
    super(message, 'RESERVATION_EXPIRED', 400);
    this.reservationId = reservationId;
  }
}

export class ReservationSettledError extends PlatformOperationsError {
  readonly reservationId: string;
  readonly currentStatus: string;

  constructor(reservationId: string, currentStatus: string) {
    super(
      `Reservation "${reservationId}" is already ${currentStatus}`,
      'RESERVATION_ALREADY_SETTLED',
      409
    );
    this.reservationId = reservationId;
    this.currentStatus = currentStatus;
  }
}

// --- Task Errors ---

export class TaskNotFoundError extends NotFoundError {
  readonly taskId: string;

  constructor(taskId: string) {
    super(`Task "${taskId}" not found`, 'TASK_NOT_FOUND');
    this.taskId = taskId;
  }
}

export class TaskConflictError extends PlatformOperationsError {
  readonly taskId: string;

  constructor(taskId: string, message: string) {
    super(message, 'TASK_CONFLICT', 409);
    this.taskId = taskId;
  }
}

export class TaskAlreadyClaimedError extends TaskConflictError {
  readonly claimantId: string;

  constructor(taskId: string, claimantId: string) {
    super(taskId, `Task "${taskId}" is already claimed by worker "${claimantId}"`);
    this.claimantId = claimantId;
  }
}

export class TaskAlreadyCompletedError extends TaskConflictError {
  constructor(taskId: string) {
    super(taskId, `Task "${taskId}" is already completed and cannot be modified`);
  }
}

export class TaskLeaseExpiredError extends TaskConflictError {
  constructor(taskId: string) {
    super(taskId, `Lease for task "${taskId}" has expired`);
  }
}

// --- Path & File Errors ---

export class PathPolicyViolationError extends ForbiddenError {
  readonly path: string;
  readonly violationReason: string;

  constructor(path: string, violationReason: string) {
    super(`Path policy violation for "${path}": ${violationReason}`, 'PATH_POLICY_VIOLATION');
    this.path = path;
    this.violationReason = violationReason;
  }
}

// --- Idempotency Errors ---

export class IdempotencyConflictError extends PlatformOperationsError {
  readonly idempotencyKey: string;

  constructor(idempotencyKey: string, message = `Idempotency key collision with differing payload: "${idempotencyKey}"`) {
    super(message, 'IDEMPOTENCY_CONFLICT', 409);
    this.idempotencyKey = idempotencyKey;
  }
}
