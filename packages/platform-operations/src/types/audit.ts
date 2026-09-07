export type OperationAuditAction =
  | 'message_sent'
  | 'message_delivered'
  | 'message_failed'
  | 'message_idempotent_hit'
  | 'file_dispatched'
  | 'file_policy_violation'
  | 'task_created'
  | 'task_claimed'
  | 'task_lease_renewed'
  | 'task_completed'
  | 'task_failed'
  | 'task_cancelled'
  | 'task_recovered'
  | 'quota_checked'
  | 'quota_reserved'
  | 'quota_committed'
  | 'quota_overage_committed'
  | 'quota_released'
  | 'quota_limit_updated'
  | 'quota_exceeded'
  | 'quota_reservations_expired';

export interface OperationAuditLog {
  id: string;
  userId: string;
  action: OperationAuditAction | string;
  resourceType: 'message' | 'file' | 'task' | 'quota' | 'system' | string;
  resourceId?: string | null;
  details?: Record<string, unknown> | null;
  createdAt: string;
}

export interface CreateOperationAuditLogInput {
  id?: string;
  userId: string;
  action: OperationAuditAction | string;
  resourceType: 'message' | 'file' | 'task' | 'quota' | 'system' | string;
  resourceId?: string | null;
  details?: Record<string, unknown> | null;
  createdAt?: string;
}

export interface AuditQueryOptions {
  userId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  limit?: number;
  offset?: number;
  from?: string;
  to?: string;
}
