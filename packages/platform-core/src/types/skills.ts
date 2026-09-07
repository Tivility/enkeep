/**
 * Skill Governance Types and Canonical DTOs
 *
 * Defines authoritative interfaces for skill packages, versioning, bindings,
 * operations, provenance, and sanitized DTOs that strictly prevent host path leakage.
 *
 * @module @enkeep/platform-core/types/skills
 */

export type SkillScope = 'space' | 'global';
export type SkillSourceType = 'git' | 'upload' | 'bundled';
export type SkillStatus = 'active' | 'quarantined' | 'archived' | 'deleted';
export type SkillOperationType = 'install' | 'update' | 'rollback' | 'uninstall' | 'enable' | 'disable';
export type SkillOperationStatus = 'pending' | 'completed' | 'failed';

export interface SkillInvocationPolicy {
  readonly modelInvocable: boolean;
  readonly userInvocable: boolean;
}

export interface SkillPackage {
  id: string;
  userId: string;
  name: string;
  scope: SkillScope;
  spaceId?: string | null;
  version: number;
  sourceType: SkillSourceType;
  sourceUrl?: string | null; // Sanitized: auth tokens and passwords redacted
  sourceRef?: string | null; // Branch, tag, or ref
  commitSha?: string | null; // Immutable 40-hex Git commit SHA
  subdirectory?: string | null;
  contentHash: string; // SHA-256 hash of the skill payload
  manifestJson?: string | null; // Parsed frontmatter and manifest metadata
  status: SkillStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SkillPackageVersion {
  id: string;
  packageId: string;
  version: number;
  commitSha?: string | null;
  contentHash: string;
  manifestJson?: string | null;
  changeSummary?: string | null;
  createdAt: string;
}

export interface SkillBinding {
  id: string;
  userId: string;
  spaceId: string;
  skillName: string;
  enabled: boolean;
  packageId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SkillOperation {
  id: string;
  userId: string;
  operationType: SkillOperationType;
  skillName: string;
  targetScope: SkillScope;
  targetSpaceId?: string | null;
  idempotencyKey?: string | null;
  requestHash: string;
  status: SkillOperationStatus;
  detailsJson?: string | null;
  errorMessage?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublicSkillSummary {
  name: string;
  description: string;
  whenToUse?: string;
  version?: number;
  source: 'bundled' | 'global' | 'space';
  sourceType?: SkillSourceType;
  enabled: boolean;
  status: SkillStatus;
  hash: string;
  invocation: SkillInvocationPolicy;
  scope: 'bundled' | 'global' | 'space';
  spaceId?: string | null;
  commitSha?: string | null;
  sourceUrl?: string | null;
  hasUpdates?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface PublicSkillVersion {
  version: number;
  commitSha?: string | null;
  contentHash: string;
  changeSummary?: string | null;
  createdAt: string;
}

export interface PublicSkillBinding {
  spaceId: string;
  spaceName?: string;
  enabled: boolean;
  updatedAt: string;
}

export interface PublicSkillDetail {
  summary: PublicSkillSummary;
  content: string; // SKILL.md body text without leaking absolute path
  manifest?: Record<string, unknown>;
  versions?: PublicSkillVersion[];
  bindings?: PublicSkillBinding[];
}

export interface GitResolvedCredentials {
  readonly authToken?: string;
  readonly sshPrivateKey?: string;
  readonly knownHosts?: string;
  readonly knownHostsFile?: string;
}

export interface GitCredentialResolverPort {
  resolveCredentials(
    userId: string,
    credentialRef: string
  ): Promise<GitResolvedCredentials | null>;
}

export interface GitInstallSourceInput {
  repositoryUrl: string;
  ref?: string;
  subdirectory?: string;
  expectedCommit?: string;
  credentialRef?: string;
  authToken?: string; // Passed in-memory for host git execution; never persisted or logged
  sshPrivateKey?: string; // Passed in-memory for host git execution; never persisted or logged
  knownHostsFile?: string; // Passed in-memory for host git execution; never persisted or logged
}

export interface InstallSkillInput {
  userId: string;
  scope: SkillScope;
  spaceId?: string | null;
  sourceType: 'git' | 'upload';
  gitSource?: GitInstallSourceInput;
  archiveBuffer?: Buffer;
  archiveFilename?: string;
  signature?: string;
  expectedChecksum?: string;
  idempotencyKey?: string;
}

export interface UpdateSkillInput {
  userId: string;
  skillName: string;
  scope?: SkillScope;
  spaceId?: string | null;
  ref?: string;
  expectedCommit?: string;
  confirmDiff?: boolean;
  credentialRef?: string;
  authToken?: string;
  sshPrivateKey?: string;
  knownHostsFile?: string;
  idempotencyKey?: string;
}

export interface RollbackSkillInput {
  userId: string;
  skillName: string;
  targetVersion: number;
  scope?: SkillScope;
  spaceId?: string | null;
  idempotencyKey?: string;
}

export interface SetSkillBindingInput {
  userId: string;
  spaceId: string;
  skillName: string;
  enabled: boolean;
}

export interface SkillDiffPreview {
  skillName: string;
  currentCommit?: string | null;
  targetCommit: string;
  currentVersion: number;
  targetVersion: number;
  changedFiles: Array<{
    path: string;
    status: 'added' | 'modified' | 'deleted';
  }>;
  diffSummary: string;
  requiresConfirmation: boolean;
}
