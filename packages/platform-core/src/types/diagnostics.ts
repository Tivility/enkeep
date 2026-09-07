export type DiagnosticEventType =
  | 'lifecycle_start'
  | 'lifecycle_stop'
  | 'lifecycle_restart'
  | 'health_check'
  | 'tool_failure'
  | 'resource_sample'
  | 'error'
  | 'system';

export type DiagnosticLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RuntimeTelemetryStats {
  cpuPercent?: number;
  memoryUsageBytes?: number;
  memoryLimitBytes?: number;
  pidsCount?: number;
  volumeBytes?: number;
}

export interface RuntimeDiagnosticRecord {
  id: string;
  userId: string;
  containerId?: string | null;
  eventType: DiagnosticEventType;
  level: DiagnosticLogLevel;
  code: string;
  message: string;
  details?: Record<string, unknown> | null;
  stats?: RuntimeTelemetryStats | null;
  createdAt: string;
}

export interface RuntimeDiagnosticsQueryOptions {
  userId: string;
  before?: string;
  limit?: number;
  level?: DiagnosticLogLevel;
}

export interface RuntimeDiagnosticsQueryResult {
  items: RuntimeDiagnosticRecord[];
  nextCursor: string | null;
  total: number;
  limit: number;
}
