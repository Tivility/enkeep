import type { LifecycleStatus } from './agent-profile.js';
import type { CacheRetention } from './cache-retention.js';

export type ExecutionMode = 'container' | 'host';

export interface Space {
  id: string;
  userId: string; // Tenant/Owner ID
  name: string;
  folder: string;
  executionMode: ExecutionMode;
  status: LifecycleStatus;
  canonicalSessionId?: string | null;
  agentProfileId?: string | null;
  agentProfileSnapshotId?: string | null;
  cacheRetention?: CacheRetention | null;
  contextWindow?: number | null;
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
  canonicalSessionId?: string | null;
  agentProfileId?: string | null;
  agentProfileSnapshotId?: string | null;
  cacheRetention?: CacheRetention | null;
  contextWindow?: number | null;
}

export interface UpdateSpaceInput {
  name?: string;
  folder?: string;
  executionMode?: ExecutionMode;
  status?: LifecycleStatus;
  canonicalSessionId?: string | null;
  agentProfileId?: string | null;
  agentProfileSnapshotId?: string | null;
  cacheRetention?: CacheRetention | null;
  contextWindow?: number | null;
}
