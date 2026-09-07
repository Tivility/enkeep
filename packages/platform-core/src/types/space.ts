import type { LifecycleStatus } from './agent-profile.js';

export type ExecutionMode = 'container' | 'host';

export interface Space {
  id: string;
  userId: string; // Tenant/Owner ID
  name: string;
  folder: string;
  executionMode: ExecutionMode;
  status: LifecycleStatus;
  agentProfileId?: string | null;
  agentProfileSnapshotId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSpaceInput {
  id?: string;
  userId: string;
  name: string;
  folder: string;
  executionMode?: ExecutionMode;
  status?: LifecycleStatus;
  agentProfileId?: string | null;
  agentProfileSnapshotId?: string | null;
}

export interface UpdateSpaceInput {
  name?: string;
  folder?: string;
  executionMode?: ExecutionMode;
  status?: LifecycleStatus;
  agentProfileId?: string | null;
  agentProfileSnapshotId?: string | null;
}
