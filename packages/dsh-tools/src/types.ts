import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type {
  ToolCallView,
  ToolResultView,
  ToolResult,
  ToolRunContext,
  ToolExecution,
  ToolExecutionResult,
  ToolDefinition,
  ToolOutputDefinition,
} from '@deepseek-ai/dsh-tools';

export type {
  ToolCallView,
  ToolResultView,
  ToolResult,
  ToolRunContext,
  ToolExecution,
  ToolExecutionResult,
  ToolDefinition,
  ToolOutputDefinition,
};

/**
 * Narrow platform client service interface and tool execution types.
 */

export interface MessagePayload {
  recipient: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface SendMessageResult {
  success: boolean;
  messageId: string;
  recipient: string;
  timestamp: string;
}

export interface FilePayload {
  recipient: string;
  path: string;
  filename: string;
  size: number;
  content?: Buffer | string;
  checksum?: string;
  encoding?: string;
  description?: string;
}

export interface SendFileResult {
  success: boolean;
  fileId: string;
  path: string;
  size: number;
  recipient: string;
}

export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export type TaskStatus =
  | 'pending'
  | 'claimed'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TaskScheduleType = 'once' | 'cron' | 'interval';

export type TaskScheduleMisfirePolicy = 'coalesce' | 'skip';

export type TaskScheduleOverlapPolicy = 'skip';

export type AgentPromptSessionPolicy = 'existing_session' | 'isolated';
export type AgentPromptContextMode = 'group' | 'isolated';

/**
 * Strict TaskPayload matching canonical PlatformServer POST /api/manage/tasks body.
 * Title, prompt, sessionId, optional sessionPolicy/contextMode, priority, and dueDate are permitted.
 */
export interface TaskPayload {
  readonly title: string;
  readonly prompt: string;
  readonly sessionId: string;
  readonly sessionPolicy?: AgentPromptSessionPolicy;
  readonly contextMode?: AgentPromptContextMode;
  readonly priority?: TaskPriority;
  readonly dueDate?: string;
}

export interface CreateTaskResult {
  readonly success: true;
  readonly taskId: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly isIdempotentHit: boolean;
}

/**
 * Strict UpdateTaskPayload matching canonical PlatformServer PUT /api/manage/tasks/:id body.
 * Task ownership (userId) and space/session bindings are strictly excluded.
 */
export interface UpdateTaskPayload {
  readonly title?: string;
  readonly prompt?: string;
  readonly priority?: TaskPriority;
  readonly description?: string | null;
  readonly assignee?: string | null;
  readonly scheduleType?: TaskScheduleType;
  readonly cronExpression?: string | null;
  readonly intervalSeconds?: number | null;
  readonly dueDate?: string | null;
  readonly timezone?: string;
  readonly misfirePolicy?: TaskScheduleMisfirePolicy;
  readonly overlapPolicy?: TaskScheduleOverlapPolicy;
  readonly silent?: boolean;
}

export interface UpdateTaskArgs {
  readonly taskId: string;
  readonly title?: string;
  readonly prompt?: string;
  readonly priority?: TaskPriority;
  readonly description?: string | null;
  readonly assignee?: string | null;
  readonly scheduleType?: TaskScheduleType;
  readonly cronExpression?: string | null;
  readonly intervalSeconds?: number | null;
  readonly dueDate?: string | null;
  readonly timezone?: string;
  readonly misfirePolicy?: TaskScheduleMisfirePolicy;
  readonly overlapPolicy?: TaskScheduleOverlapPolicy;
  readonly silent?: boolean;
}

export interface UpdateTaskResult {
  readonly success: true;
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly updated: true;
  readonly title?: string;
  readonly scheduleType?: TaskScheduleType;
  readonly nextRunAt?: string | null;
}

export interface CancelTaskArgs {
  readonly taskId: string;
}

export interface CancelTaskResult {
  readonly success: true;
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly cancelled: true;
}

export interface TaskSummary {
  readonly taskId: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly priority?: TaskPriority | null;
  readonly nextRunAt?: string | null;
  readonly dueDate?: string | null;
  readonly createdAt?: string | null;
  readonly lastRun?: string | null;
  readonly lastRunAt?: string | null;
}

export interface ListTasksArgs {
  readonly status?: TaskStatus;
  readonly limit?: number;
  readonly offset?: number;
}

export interface ListTasksResult {
  readonly success: true;
  readonly tasks: readonly TaskSummary[];
  readonly count: number;
}

export interface GetTaskArgs {
  readonly taskId: string;
}

export interface GetTaskResult {
  readonly success: true;
  readonly task: TaskSummary;
}

export interface QuotaQueryPayload {
  resource?: string;
  limit?: number;
  offset?: number;
}

export interface CheckQuotaResult {
  allowed: boolean;
  usage: Record<string, number>;
  activeReservations: Record<string, number>;
  limit: Record<string, number>;
  remaining: Record<string, number>;
  resetAt: string | null;
}

/**
 * Narrow Platform Client Service Interface consumed by Enkeep DSH Tools.
 * Uses canonical request method for HTTP endpoints.
 */
export interface PlatformClientService {
  sendMessage?(payload: MessagePayload): Promise<SendMessageResult>;
  sendFile?(payload: FilePayload): Promise<SendFileResult>;
  checkQuota?(payload: QuotaQueryPayload): Promise<CheckQuotaResult>;
  updateTask?(taskId: string, payload: UpdateTaskPayload): Promise<UpdateTaskResult>;
  cancelTask?(taskId: string): Promise<CancelTaskResult>;
  listTasks?(options?: ListTasksArgs): Promise<ListTasksResult>;
  getTask?(taskId: string): Promise<GetTaskResult>;
  request?<T = unknown>(path: string, options?: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string | undefined>;
    query?: Record<string, string | number | boolean | undefined | null>;
    signal?: AbortSignal;
    [key: string]: unknown;
  }): Promise<{ data: T; status: number; headers?: Record<string, unknown> }>;
}

export type ToolExecutionContext = ToolRunContext | {
  agent?: Agent | {
    id?: string;
    session?: unknown;
    idempotencyKey?: string;
    [key: string]: unknown;
  };
  sessionId?: string;
  session?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
  [key: string]: unknown;
};

/**
 * Cordis Tools Service contract (ctx.tools).
 */
export interface ToolsRegistryService {
  register(tool: ToolDefinition): () => void;
  get?(name: string): ToolDefinition | undefined;
  list?(): readonly ToolDefinition[];
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    platformClient?: any;
  }
}
