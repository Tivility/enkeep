import type { DatabaseSync } from 'node:sqlite';
import {
  type PlatformStorage,
  type User,
  type PublicExtensionSummary,
  type PublicExtensionDetail,
  type PublicExtensionVersion,
  type PublicExtensionBinding,
  type ExtensionActivationPlan,
  type ExtensionPlanResolver,
} from '@enkeep/platform-core';
import {
  ExtensionCatalogService,
  type ExtensionCatalogServiceConfig,
} from '../extensions/extension-catalog-service.js';
import type {
  SkillBinding,
  PublicSkillSummary,
  PublicSkillDetail,
  InstallSkillInput,
  UpdateSkillInput,
  RollbackSkillInput,
  SetSkillBindingInput,
  SkillDiffPreview,
  GitCredentialResolverPort,
  GitResolvedCredentials,
} from './skill-types.js';
import type { GitSourcePolicy } from './git-source-policy.js';

export type SkillCatalogServiceConfig = ExtensionCatalogServiceConfig;

export class SkillCatalogService implements ExtensionPlanResolver {
  private readonly extensionCatalogService: ExtensionCatalogService;
  public readonly gitSourcePolicy: GitSourcePolicy;

  constructor(
    storageOrService: PlatformStorage | ExtensionCatalogService,
    db?: DatabaseSync,
    config?: SkillCatalogServiceConfig
  ) {
    if (storageOrService instanceof ExtensionCatalogService) {
      this.extensionCatalogService = storageOrService;
    } else {
      if (!db || !config) {
        throw new Error('DatabaseSync and config are required when initializing SkillCatalogService with PlatformStorage');
      }
      this.extensionCatalogService = new ExtensionCatalogService(storageOrService, db, config);
    }
    this.gitSourcePolicy = this.extensionCatalogService.gitSourcePolicy;
  }

  public async resolveGitCredentials(
    userId: string,
    credentialRef?: string
  ): Promise<GitResolvedCredentials | undefined> {
    return this.extensionCatalogService.resolveGitCredentials(userId, credentialRef);
  }

  public async resolveForSpace(userId: string, platformSpaceId: string): Promise<ExtensionActivationPlan> {
    return this.extensionCatalogService.resolveForSpace(userId, platformSpaceId);
  }

  async listSkills(
    userOrId: string | User,
    options: {
      spaceId?: string;
      source?: 'bundled' | 'global' | 'space';
      enabled?: boolean;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<PublicSkillSummary[]> {
    const extSummaries = await this.extensionCatalogService.listPackages(userOrId, {
      spaceId: options.spaceId,
      kind: 'skill',
      limit: options.limit,
      offset: options.offset,
    });

    let items: PublicSkillSummary[] = extSummaries.map((s: PublicExtensionSummary) => {
      const contrib = s.contributions[0];
      return {
        name: s.slug,
        description: s.description ?? contrib?.description ?? '',
        whenToUse: contrib?.whenToUse,
        version: s.installedVersion,
        source: (s.sourceKind === 'builtin' ? 'bundled' : (options.spaceId ? 'space' : 'global')) as 'bundled' | 'global' | 'space',
        sourceType: (s.sourceKind === 'builtin' ? 'bundled' : (s.sourceKind === 'git' ? 'git' : 'upload')) as 'bundled' | 'git' | 'upload',
        enabled: s.enabled,
        status: (s.status === 'active' ? 'active' : 'archived') as 'active' | 'archived',
        hash: s.integritySha256,
        invocation: {
          modelInvocable: contrib?.modelInvocable ?? true,
          userInvocable: contrib?.userInvocable ?? true,
        },
        scope: (s.sourceKind === 'builtin' ? 'bundled' : (options.spaceId ? 'space' : 'global')) as 'bundled' | 'global' | 'space',
        spaceId: options.spaceId ?? null,
        commitSha: s.sourceRef ?? null,
        sourceUrl: s.sourceRef ?? null,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      };
    });

    if (options.source) {
      items = items.filter((i: PublicSkillSummary) => i.source === options.source);
    }
    if (options.enabled !== undefined) {
      items = items.filter((i: PublicSkillSummary) => i.enabled === options.enabled);
    }

    return items;
  }

  async getSkill(
    userOrId: string | User,
    skillName: string,
    spaceId?: string
  ): Promise<PublicSkillDetail> {
    const detail = await this.extensionCatalogService.getPackage(userOrId, skillName, spaceId);
    const contrib = detail.contributions[0];

    const summary: PublicSkillSummary = {
      name: detail.slug,
      description: detail.description ?? contrib?.description ?? '',
      whenToUse: contrib?.whenToUse,
      version: detail.installedVersion,
      source: detail.sourceKind === 'builtin' ? 'bundled' : (spaceId ? 'space' : 'global'),
      sourceType: detail.sourceKind === 'builtin' ? 'bundled' : (detail.sourceKind === 'git' ? 'git' : 'upload'),
      enabled: detail.enabled,
      status: detail.status === 'active' ? 'active' : 'archived',
      hash: detail.integritySha256,
      invocation: {
        modelInvocable: contrib?.modelInvocable ?? true,
        userInvocable: contrib?.userInvocable ?? true,
      },
      scope: (detail.sourceKind === 'builtin' ? 'bundled' : (spaceId ? 'space' : 'global')) as 'bundled' | 'global' | 'space',
      spaceId: spaceId ?? null,
      commitSha: detail.sourceRef ?? null,
      sourceUrl: detail.sourceRef ?? null,
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
    };

    return {
      summary,
      content: detail.content ?? '',
      manifest: contrib?.manifest,
      versions: detail.versions.map((v: PublicExtensionVersion) => ({
        version: v.version,
        commitSha: v.commitSha,
        contentHash: v.integritySha256,
        changeSummary: v.changeSummary,
        createdAt: v.createdAt,
      })),
      bindings: detail.bindings.map((b: PublicExtensionBinding) => ({
        spaceId: b.spaceId,
        enabled: b.enabled,
        updatedAt: b.updatedAt,
      })),
    };
  }

  async installSkill(input: InstallSkillInput): Promise<PublicSkillDetail> {
    let detail: PublicExtensionDetail;
    if (input.sourceType === 'git') {
      detail = await this.extensionCatalogService.installGit({
        userId: input.userId,
        repositoryUrl: input.gitSource!.repositoryUrl,
        ref: input.gitSource?.ref,
        subdirectory: input.gitSource?.subdirectory,
        expectedCommit: input.gitSource?.expectedCommit,
        credentialRef: input.gitSource?.credentialRef,
        authToken: input.gitSource?.authToken,
        sshPrivateKey: input.gitSource?.sshPrivateKey,
        knownHostsFile: input.gitSource?.knownHostsFile,
        targetSpaceId: input.spaceId ?? null,
        expectedChecksum: input.expectedChecksum,
        idempotencyKey: input.idempotencyKey,
      });
    } else {
      detail = await this.extensionCatalogService.installArchive({
        userId: input.userId,
        archiveBuffer: input.archiveBuffer!,
        archiveFilename: input.archiveFilename,
        targetSpaceId: input.spaceId ?? null,
        expectedChecksum: input.expectedChecksum,
        idempotencyKey: input.idempotencyKey,
      });
    }

    return this.getSkill(input.userId, detail.slug, input.spaceId ?? undefined);
  }

  async updateSkill(input: UpdateSkillInput): Promise<PublicSkillDetail | SkillDiffPreview> {
    const res = await this.extensionCatalogService.update({
      userId: input.userId,
      slug: input.skillName,
      ref: input.ref,
      expectedCommit: input.expectedCommit,
      confirmDiff: input.confirmDiff,
      credentialRef: input.credentialRef,
      authToken: input.authToken,
      sshPrivateKey: input.sshPrivateKey,
      knownHostsFile: input.knownHostsFile,
      targetSpaceId: input.spaceId ?? null,
      idempotencyKey: input.idempotencyKey,
    });

    if ('requiresConfirmation' in res) {
      return res as SkillDiffPreview;
    }

    return this.getSkill(input.userId, input.skillName, input.spaceId ?? undefined);
  }

  async rollbackSkill(input: RollbackSkillInput): Promise<PublicSkillDetail> {
    await this.extensionCatalogService.rollback({
      userId: input.userId,
      slug: input.skillName,
      targetVersion: input.targetVersion,
      targetSpaceId: input.spaceId ?? null,
      idempotencyKey: input.idempotencyKey,
    });

    return this.getSkill(input.userId, input.skillName, input.spaceId ?? undefined);
  }

  async enableSkill(input: SetSkillBindingInput): Promise<SkillBinding> {
    const binding = await this.extensionCatalogService.enable(input.userId, input.spaceId, input.skillName);

    return {
      id: binding.id,
      userId: input.userId,
      spaceId: binding.spaceId,
      skillName: input.skillName,
      enabled: binding.enabled,
      createdAt: new Date().toISOString(),
      updatedAt: binding.updatedAt,
    };
  }

  async disableSkill(input: SetSkillBindingInput): Promise<SkillBinding> {
    const binding = await this.extensionCatalogService.disable(input.userId, input.spaceId, input.skillName);

    return {
      id: binding.id,
      userId: input.userId,
      spaceId: binding.spaceId,
      skillName: input.skillName,
      enabled: binding.enabled,
      createdAt: new Date().toISOString(),
      updatedAt: binding.updatedAt,
    };
  }

  async uninstallSkill(
    userOrId: string | User,
    skillName: string,
    spaceId?: string
  ): Promise<boolean> {
    return this.extensionCatalogService.uninstall(userOrId, skillName, spaceId);
  }
}
