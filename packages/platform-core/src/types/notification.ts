export type TaskNotificationChannel = 'in_app' | 'webhook';

export type TaskNotificationEventType =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'started';

export type TaskNotificationDeliveryStatus =
  | 'pending'
  | 'delivered'
  | 'failed'
  | 'dead_letter';

export interface TaskNotificationSubscription {
  id: string;
  taskId: string;
  userId: string;
  channel: TaskNotificationChannel;
  destination: string | null;
  secretConfigured: boolean;
  secretFingerprint: string | null;
  enabled: boolean;
  events: TaskNotificationEventType[];
  createdAt: string;
  updatedAt: string;
}

export interface TaskNotificationDelivery {
  id: string;
  subscriptionId: string;
  taskId: string;
  runId: string | null;
  userId: string;
  channel: TaskNotificationChannel;
  event: TaskNotificationEventType;
  status: TaskNotificationDeliveryStatus;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  lastError: string | null;
  payload: Record<string, unknown>;
  responseStatus: number | null;
  responseTimeMs: number | null;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskNotificationSubscriptionInput {
  taskId: string;
  userId: string;
  channel: TaskNotificationChannel;
  destination?: string | null;
  secret?: string | null;
  events?: TaskNotificationEventType[];
  enabled?: boolean;
}

export interface UpdateTaskNotificationSubscriptionInput {
  id: string;
  userId: string;
  destination?: string | null;
  secret?: string | null;
  events?: TaskNotificationEventType[];
  enabled?: boolean;
}

export interface CredentialCipherPort {
  encrypt(plaintext: string): string | Promise<string>;
  decrypt(ciphertext: string): string | Promise<string>;
}
