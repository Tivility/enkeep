import type { ExecutionMode } from './space.js';

export type TurnRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'interrupted'
  | 'failed';

export type ProcessStepKind = 'thinking' | 'tool' | 'task';
export type ProcessStepStatus = 'running' | 'completed' | 'failed';

export interface ProcessStepItem {
  id: string;
  kind: ProcessStepKind;
  name: string;
  status: ProcessStepStatus;
  summary?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  facts?: string;
}

export interface TurnRun {
  id: string;
  userId: string; // Tenant/Owner ID
  spaceId: string;
  routeId: string;
  turnId: string;
  status: TurnRunStatus;
  startedAt?: string | null;
  finishedAt?: string | null;
  error?: string | null;
  executionMode: ExecutionMode;
  stepsJson?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTurnRunInput {
  id?: string;
  userId: string;
  spaceId: string;
  routeId: string;
  turnId: string;
  status?: TurnRunStatus;
  startedAt?: string | null;
  executionMode?: ExecutionMode;
}

export interface UpdateTurnRunStatusInput {
  status: TurnRunStatus;
  startedAt?: string | null;
  finishedAt?: string | null;
  error?: string | null;
  stepsJson?: string | null;
}
