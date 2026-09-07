export interface SessionGeneration {
  id: string;
  userId: string; // Tenant/Owner ID
  routeId: string;
  generationNumber: number;
  dshSessionId: string;
  agentProfileSnapshotId?: string | null;
  resetReason?: string | null;
  createdAt: string;
}

export interface CreateSessionGenerationInput {
  id?: string;
  userId: string;
  routeId: string;
  generationNumber?: number;
  dshSessionId?: string;
  agentProfileSnapshotId?: string | null;
  resetReason?: string | null;
}
