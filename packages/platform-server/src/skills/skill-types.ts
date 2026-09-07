import type {
  SkillPackage,
  SkillPackageVersion,
  SkillBinding,
  SkillOperation,
  SkillScope,
  SkillSourceType,
  SkillStatus,
  SkillOperationType,
  SkillInvocationPolicy,
  PublicSkillSummary,
  PublicSkillDetail,
  PublicSkillVersion,
  PublicSkillBinding,
  GitInstallSourceInput,
  InstallSkillInput,
  UpdateSkillInput,
  RollbackSkillInput,
  SetSkillBindingInput,
  SkillDiffPreview,
  GitResolvedCredentials,
  GitCredentialResolverPort,
} from '@enkeep/platform-core';

export {
  type SkillPackage,
  type SkillPackageVersion,
  type SkillBinding,
  type SkillOperation,
  type SkillScope,
  type SkillSourceType,
  type SkillStatus,
  type SkillOperationType,
  type SkillInvocationPolicy,
  type PublicSkillSummary,
  type PublicSkillDetail,
  type PublicSkillVersion,
  type PublicSkillBinding,
  type GitInstallSourceInput,
  type InstallSkillInput,
  type UpdateSkillInput,
  type RollbackSkillInput,
  type SetSkillBindingInput,
  type SkillDiffPreview,
  type GitResolvedCredentials,
  type GitCredentialResolverPort,
};

export interface ParsedSkillFrontmatter {
  name: string;
  description: string;
  whenToUse?: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  metadata?: Record<string, unknown>;
  content: string;
}

export interface ValidatedSkillPayload {
  name: string;
  description: string;
  whenToUse?: string;
  invocation: SkillInvocationPolicy;
  content: string; // SKILL.md body text
  metadata?: Record<string, unknown>;
  contentHash: string; // Lowercase SHA-256 of entire skill directory / files
  fileCount: number;
  totalBytes: number;
  // Extended for unified extension packages:
  slug?: string;
  isMcp?: boolean;
  isCli?: boolean;
  contributions?: import('../extensions/extension-manifest-validator.js').CanonicalExtensionContribution[];
}
