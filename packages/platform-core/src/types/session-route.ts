import type { ExecutionMode } from './space.js';
import type { LifecycleStatus } from './agent-profile.js';

export interface SessionRoute {
  id: string;
  spaceId: string;
  userId: string; // Tenant/Owner ID
  channel: string;
  accountId: string;
  nativeContextId: string;
  peerId: string;
  dshSessionId: string;
  executionMode: ExecutionMode;
  status: LifecycleStatus;
  title?: string | null;
  lastResetAt?: string | null;
  resetCount: number;
  currentGeneration: number;
  agentProfileId?: string | null;
  agentProfileSnapshotId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSessionRouteInput {
  id?: string;
  spaceId: string;
  userId: string;
  channel: string;
  accountId?: string; // Defaults to 'default'
  nativeContextId: string;
  peerId?: string; // Defaults to nativeContextId if omitted
  dshSessionId: string;
  executionMode?: ExecutionMode;
  status?: LifecycleStatus;
  title?: string | null;
  agentProfileId?: string | null;
  agentProfileSnapshotId?: string | null;
}

export interface UpdateSessionRouteInput {
  spaceId?: string;
  dshSessionId?: string;
  status?: LifecycleStatus;
  title?: string | null;
  agentProfileId?: string | null;
  agentProfileSnapshotId?: string | null;
}

export interface ResetSessionRouteInput {
  dshSessionId: string;
  resetReason?: string | null;
  agentProfileSnapshotId?: string | null;
}

export interface SessionSource {
  id: string;
  routeId: string;
  sourceType: string;
  sourceId: string;
  userId: string; // Tenant/Owner ID
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

export interface CreateSessionSourceInput {
  id?: string;
  routeId: string;
  sourceType: string;
  sourceId: string;
  userId: string;
  metadata?: Record<string, unknown> | null;
}
