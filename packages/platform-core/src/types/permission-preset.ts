export type PermissionPresetName = 'read-only' | 'workspace-write' | 'danger-full-access' | 'custom';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ApprovalPolicy = 'ask' | 'never';

export interface PermissionPresetRecord {
  id: string;
  userId: string;
  spaceId?: string | null;
  profileId?: string | null;
  preset: PermissionPresetName;
  sandboxMode: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface SetPermissionPresetInput {
  id?: string;
  userId: string;
  spaceId?: string | null;
  profileId?: string | null;
  preset: PermissionPresetName;
  sandboxMode?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
  revision?: number;
}
