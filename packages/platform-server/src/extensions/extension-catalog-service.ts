import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  PlatformError,
  NotFoundError,
  ValidationError,
  ForbiddenError,
  type PlatformStorage,
  type User,
  type ExtensionKind,
  type ExtensionSourceKind,
  type ExtensionPackageStatus,
  type ExtensionContributionStatus,
  type ExtensionPackageRecord,
  type ExtensionVersionRecord,
  type ExtensionContributionRecord,
  type ExtensionBindingRecord,
  type PublicExtensionSummary,
  type PublicExtensionDetail,
  type PublicExtensionContribution,
  type PublicExtensionBinding,
  type PublicExtensionVersion,
  type InstallGitExtensionInput,
  type InstallArchiveExtensionInput,
  type UpdateExtensionInput,
  type RollbackExtensionInput,
  type SetExtensionBindingInput,
  type SkillDiffPreview,
  type Space,
  type ExtensionActivationPlan,
  type ExtensionContributionActivation,
  type ExtensionSkillContributionActivation,
  type ExtensionMcpContributionActivation,
  type ExtensionCliContributionActivation,
  type ExtensionDshPluginContributionActivation,
  type ExtensionPlanResolver,
  type AuthAuditAction,
  type BrowserService,
  type BrowserServiceHealth,
  type PlatformProxyMcpService,
  type McpContributionReconciler,
} from '@enkeep/platform-core';
import {
  listTrustedPlugins,
  getTrustedPlugin,
  type TrustedPluginDefinition,
} from '@enkeep/dsh-enkeep-bundle';
import {
  validateSkillName,
  parseSkillMarkdown,
  validateSkillDirectory,
  sanitizeRepositoryUrl,
  updateSkillFrontmatterInvocation,
} from '../skills/security-validator.js';
import { stageGitSkill, previewGitDiff, createSecureTempDir, cleanupStaleGitTempDirs } from '../skills/git-installer.js';
import { stageArchiveSkill } from '../skills/archive-installer.js';
import {
  type GitSourcePolicy,
  DEFAULT_GIT_SOURCE_POLICY,
} from '../skills/git-source-policy.js';
import type {
  GitCredentialResolverPort,
  GitResolvedCredentials,
} from '../skills/skill-types.js';
import type { TenantRuntimeFileProvider } from '../files/runtime-file-api.js';

export interface ExtensionCatalogServiceConfig {
  dshHome: string;
  spacesDir: string;
  bundledSkillDir?: string;
  gitSourcePolicy?: GitSourcePolicy;
  credentialResolver?: GitCredentialResolverPort;
  browserService?: BrowserService;
  mcpService?: PlatformProxyMcpService;
  mcpReconciler?: McpContributionReconciler;
  fileProvider?: TenantRuntimeFileProvider;
}

export type ExtensionServiceConfig = ExtensionCatalogServiceConfig;

export class ExtensionCatalogService implements ExtensionPlanResolver {
  private readonly storage: PlatformStorage;
  private readonly dshHome: string;
  private readonly spacesDir: string;
  private readonly bundledSkillDir?: string;
  public readonly gitSourcePolicy: GitSourcePolicy;
  private readonly credentialResolver?: GitCredentialResolverPort;
  private browserService?: BrowserService;
  private mcpService?: PlatformProxyMcpService;
  private mcpReconciler?: McpContributionReconciler;
  private fileProvider?: TenantRuntimeFileProvider;

  constructor(
    storage: PlatformStorage,
    dbOrConfig: DatabaseSync | ExtensionCatalogServiceConfig,
    maybeConfig?: ExtensionCatalogServiceConfig
  ) {
    this.storage = storage;
    const config: ExtensionCatalogServiceConfig = (
      maybeConfig ?? (dbOrConfig && !('prepare' in dbOrConfig) ? dbOrConfig : undefined)
    ) as ExtensionCatalogServiceConfig;

    if (!config) {
      throw new Error('ExtensionCatalogService requires configuration');
    }

    this.dshHome = path.resolve(config.dshHome);
    this.spacesDir = path.resolve(config.spacesDir);
    this.bundledSkillDir = config.bundledSkillDir ? path.resolve(config.bundledSkillDir) : undefined;
    this.gitSourcePolicy = config.gitSourcePolicy ?? DEFAULT_GIT_SOURCE_POLICY;
    this.credentialResolver = config.credentialResolver;
    this.browserService = config.browserService;
    this.mcpService = config.mcpService;
    this.mcpReconciler = config.mcpReconciler;
    this.fileProvider = config.fileProvider;

    // Run startup stale temp directory cleanup
    const staleCleanup = cleanupStaleGitTempDirs();
    if (staleCleanup.errors.length > 0) {
      throw new PlatformError(
        `Failed to clean up stale ephemeral temp directories during extension service initialization (${staleCleanup.errors.length} error(s), primary code: ${staleCleanup.errors[0].code})`,
        'STALE_TEMP_CLEANUP_FAILED',
        500
      );
    }
  }

  public setBrowserService(browserService?: BrowserService): void {
    this.browserService = browserService;
  }

  public setMcpService(mcpService?: PlatformProxyMcpService): void {
    this.mcpService = mcpService;
  }

  public setMcpReconciler(mcpReconciler?: McpContributionReconciler): void {
    this.mcpReconciler = mcpReconciler;
  }

  public setFileProvider(fileProvider?: TenantRuntimeFileProvider): void {
    this.fileProvider = fileProvider;
  }

  public async resolveGitCredentials(
    userId: string,
    credentialRef?: string
  ): Promise<GitResolvedCredentials | undefined> {
    if (!credentialRef) return undefined;
    if (!this.credentialResolver) {
      throw new PlatformError(
        'Git credential resolution service is not configured on platform',
        'SERVICE_UNAVAILABLE',
        503
      );
    }
    const resolved = await this.credentialResolver.resolveCredentials(userId, credentialRef);
    if (!resolved) {
      throw new ValidationError(`Credential reference "${credentialRef}" not found or unauthorized for user`);
    }
    return resolved;
  }

  public async resolveForSpace(userId: string, platformSpaceId: string): Promise<ExtensionActivationPlan> {
    const space = await this.storage.forTenant(userId).spaces.findById(platformSpaceId);
    if (!space) {
      return { generation: 0, contributions: [], skills: [] };
    }

    const tenantStorage = this.storage.forTenant(userId);
    const bindings = await tenantStorage.extensionBindings.listBySpace(platformSpaceId);
    const activeContributions: ExtensionContributionActivation[] = [];
    const activeSkills: ExtensionSkillContributionActivation[] = [];
    const activeMcp: ExtensionMcpContributionActivation[] = [];
    const activeCli: ExtensionCliContributionActivation[] = [];
    const activePlugins: ExtensionDshPluginContributionActivation[] = [];

    for (const b of bindings) {
      if (!b.enabled) continue;
      const contrib = await tenantStorage.extensionPackages.findContributionById(b.contributionId);
      if (!contrib || contrib.status !== 'active') continue;

      const pkg = await tenantStorage.extensionPackages.findById(contrib.packageId);
      if (!pkg || pkg.status !== 'active') continue;

      let manifest: Record<string, unknown>;
      try {
        manifest = JSON.parse(contrib.manifestJson);
      } catch (err) {
        throw new PlatformError(
          `Persisted extension contribution "${contrib.id}" contains corrupted invalid JSON manifest`,
          'INVALID_MANIFEST',
          500
        );
      }

      if (contrib.kind === 'skill') {
        const skillPath = path.join(this.resolveSpacePath(userId, space.folder), '.skills', contrib.contributionKey, 'SKILL.md');
        if (fs.existsSync(skillPath)) {
          const isModelInvocable = manifest.invocation ? (manifest.invocation as Record<string, unknown>).modelInvocable !== false : true;
          const isUserInvocable = manifest.invocation ? (manifest.invocation as Record<string, unknown>).userInvocable !== false : true;

          const skillActivation: ExtensionSkillContributionActivation = {
            kind: 'skill',
            contributionId: b.contributionId,
            contributionKey: contrib.contributionKey,
            name: (manifest.name as string) || contrib.contributionKey,
            description: (manifest.description as string) ?? contrib.contributionKey,
            whenToUse: (manifest.whenToUse as string) || undefined,
            version: pkg.activeVersion,
            enabled: true,
            contentHash: pkg.integritySha256,
            modelInvocable: isModelInvocable,
            userInvocable: isUserInvocable,
          };
          activeSkills.push(skillActivation);
          activeContributions.push(skillActivation);
        }
      } else if (contrib.kind === 'mcp') {
        const pkgDir = this.findPackageDirectory(userId, space.folder, pkg.slug, true);
        let artifactRelPath: string | undefined;
        if (Array.isArray(manifest.args) && manifest.args.length > 0 && typeof manifest.args[0] === 'string' && !path.isAbsolute(manifest.args[0])) {
          artifactRelPath = manifest.args[0];
        } else if (pkgDir && fs.existsSync(path.join(pkgDir, 'server.mjs'))) {
          artifactRelPath = 'server.mjs';
        }

        const mcpActivation: ExtensionMcpContributionActivation = {
          kind: 'mcp',
          contributionId: b.contributionId,
          contributionKey: contrib.contributionKey,
          name: (manifest.name as string) || contrib.contributionKey,
          description: (manifest.description as string) ?? null,
          whenToUse: (manifest.whenToUse as string) ?? null,
          version: pkg.activeVersion,
          enabled: true,
          modelInvocable: true,
          userInvocable: true,
          artifactRelPath,
          transport: manifest.transport as ('stdio' | 'streamable-http') | undefined,
          command: typeof manifest.command === 'string' ? manifest.command : undefined,
          args: Array.isArray(manifest.args) ? manifest.args.map(String) : undefined,
          cwd: typeof manifest.cwd === 'string' ? manifest.cwd : undefined,
          url: typeof manifest.url === 'string' ? manifest.url : undefined,
          headers: manifest.headers && typeof manifest.headers === 'object' && !Array.isArray(manifest.headers) ? manifest.headers as Record<string, string> : undefined,
          credentialRefs: Array.isArray(manifest.credentialRefs) ? manifest.credentialRefs as { id: string; type?: string; scope?: string }[] : undefined,
          toolTimeoutMs: typeof manifest.toolTimeoutMs === 'number' ? manifest.toolTimeoutMs : undefined,
          contentHash: pkg.integritySha256,
        };
        activeMcp.push(mcpActivation);
        activeContributions.push(mcpActivation);
      } else if (contrib.kind === 'cli') {
        const scriptRel = typeof manifest.script === 'string' ? manifest.script : undefined;
        const artifactRelPath = scriptRel ? path.posix.join('.extensions', pkg.slug, scriptRel) : undefined;

        const cliActivation: ExtensionCliContributionActivation = {
          kind: 'cli',
          contributionId: b.contributionId,
          contributionKey: contrib.contributionKey,
          name: (manifest.name as string) || contrib.contributionKey,
          description: (manifest.description as string) ?? null,
          whenToUse: (manifest.whenToUse as string) ?? null,
          version: pkg.activeVersion,
          enabled: true,
          modelInvocable: true,
          userInvocable: true,
          artifactRelPath,
          contentHash: pkg.integritySha256,
          command: typeof manifest.command === 'string' ? manifest.command : 'node',
          script: scriptRel,
          fixedArgs: Array.isArray(manifest.fixedArgs) ? manifest.fixedArgs.map(String) : (Array.isArray(manifest.args) ? manifest.args.map(String) : undefined),
          executionMode: (manifest.executionMode === 'container' || manifest.executionMode === 'host' || manifest.executionMode === 'space') ? manifest.executionMode : undefined,
          timeoutMs: typeof manifest.timeoutMs === 'number' ? manifest.timeoutMs : undefined,
        };
        activeCli.push(cliActivation);
        activeContributions.push(cliActivation);
      } else if (contrib.kind === 'dsh-plugin') {
        const trustedPluginId = (manifest.trustedPluginId as string) || (pkg.sourceRef as string) || contrib.contributionKey;
        const pluginDef = getTrustedPlugin(trustedPluginId);
        if (pluginDef) {
          const integrity = (manifest.integrity as string) || pkg.integritySha256 || pluginDef.integritySha256 || '';

          const pluginActivation: ExtensionDshPluginContributionActivation = {
            kind: 'dsh-plugin',
            contributionId: b.contributionId,
            contributionKey: contrib.contributionKey,
            trustedPluginId: pluginDef.trustedPluginId,
            name: (manifest.name as string) || pluginDef.name || contrib.contributionKey,
            description: (manifest.description as string) ?? pluginDef.description ?? null,
            whenToUse: (manifest.whenToUse as string) ?? pluginDef.manifest?.whenToUse ?? null,
            version: typeof manifest.version === 'number' ? manifest.version : pkg.activeVersion,
            integrity,
            enabled: true,
            config: manifest.config && typeof manifest.config === 'object' && !Array.isArray(manifest.config) ? manifest.config as Record<string, unknown> : undefined,
          };
          activePlugins.push(pluginActivation);
          activeContributions.push(pluginActivation);
        }
      }
    }

    // Lazy reconcile MCP contributions for active user
    void this.notifyMcpReconcile(userId);

    return {
      generation: 1,
      contributions: activeContributions,
      skills: activeSkills,
      mcp: activeMcp,
      cli: activeCli,
      plugins: activePlugins,
    };
  }

  public findPackageDirectory(
    userId: string,
    spaceFolder: string | undefined,
    slug: string,
    isMcp = false
  ): string | undefined {
    const candidates: string[] = [];
    if (spaceFolder) {
      try {
        const spacePath = this.resolveSpacePath(userId, spaceFolder);
        candidates.push(path.join(spacePath, isMcp ? '.extensions' : '.skills', slug));
        candidates.push(path.join(spacePath, isMcp ? '.skills' : '.extensions', slug));
      } catch {}
    }
    candidates.push(path.join(this.dshHome, isMcp ? 'extensions' : 'skills', slug));
    candidates.push(path.join(this.dshHome, isMcp ? 'skills' : 'extensions', slug));

    for (const c of candidates) {
      if (fs.existsSync(c)) {
        return c;
      }
    }
    return undefined;
  }

  /**
   * Resolves all active MCP contributions across all spaces for a user,
   * mapped into full McpServerDescriptor structures with spaceIds and host package roots.
   */
  public async resolveAllMcpForUser(userId: string): Promise<readonly any[]> {
    const tenantStorage = this.storage.forTenant(userId);
    const spaces = await tenantStorage.spaces.list();

    // Map contributionId -> aggregated info
    const mcpMap = new Map<string, {
      contrib: ExtensionContributionRecord;
      pkg: ExtensionPackageRecord;
      manifest: Record<string, unknown>;
      spaceIds: Set<string>;
      preferredSpaceFolder?: string;
    }>();

    for (const space of spaces) {
      const bindings = await tenantStorage.extensionBindings.listBySpace(space.id);
      for (const b of bindings) {
        if (!b.enabled) continue;
        const contrib = await tenantStorage.extensionPackages.findContributionById(b.contributionId);
        if (!contrib || contrib.status !== 'active' || contrib.kind !== 'mcp') continue;

        const pkg = await tenantStorage.extensionPackages.findById(contrib.packageId);
        if (!pkg || pkg.status !== 'active') continue;

        let manifest: Record<string, unknown>;
        try {
          manifest = JSON.parse(contrib.manifestJson);
        } catch {
          continue;
        }

        let existing = mcpMap.get(contrib.id);
        if (!existing) {
          existing = {
            contrib,
            pkg,
            manifest,
            spaceIds: new Set<string>(),
            preferredSpaceFolder: space.folder,
          };
          mcpMap.set(contrib.id, existing);
        }
        existing.spaceIds.add(space.id);
      }
    }

    const descriptors: any[] = [];
    for (const item of mcpMap.values()) {
      const { contrib, pkg, manifest, spaceIds, preferredSpaceFolder } = item;
      const pkgDir = this.findPackageDirectory(userId, preferredSpaceFolder, pkg.slug, true) ?? path.join(this.dshHome, 'extensions', pkg.slug);

      const transport = (manifest.transport as string) ?? 'stdio';
      if (transport === 'stdio') {
        const rawArgs: unknown[] = Array.isArray(manifest.args)
          ? manifest.args
          : Array.isArray(manifest.argv)
          ? manifest.argv
          : [];

        let resolvedArgs: string[] = [];
        if (rawArgs.length > 0) {
          resolvedArgs = rawArgs.map((arg) => {
            const str = String(arg);
            if (pkgDir && !path.isAbsolute(str) && fs.existsSync(path.join(pkgDir, str))) {
              return path.join(pkgDir, str);
            }
            return str;
          });
        } else if (pkgDir && fs.existsSync(path.join(pkgDir, 'server.mjs'))) {
          resolvedArgs = [path.join(pkgDir, 'server.mjs')];
        }

        let resolvedCwd = pkgDir;
        if (typeof manifest.cwd === 'string' && manifest.cwd.trim()) {
          resolvedCwd = path.isAbsolute(manifest.cwd) ? manifest.cwd : path.resolve(pkgDir, manifest.cwd);
        }

        const descriptor = {
          id: contrib.contributionKey || contrib.id,
          contributionId: contrib.contributionKey || contrib.id,
          name: (manifest.name as string) || contrib.contributionKey,
          description: (manifest.description as string) ?? undefined,
          version: String(pkg.activeVersion),
          transport: 'stdio',
          command: typeof manifest.command === 'string' ? manifest.command : process.execPath,
          args: resolvedArgs,
          argv: resolvedArgs,
          cwd: resolvedCwd,
          packageRoots: pkgDir && fs.existsSync(pkgDir) ? [pkgDir] : [],
          spaceIds: Array.from(spaceIds),
          adminApproved: true,
          source: 'user-extension',
          credentialRefs: Array.isArray(manifest.credentialRefs) ? manifest.credentialRefs : undefined,
          toolTimeoutMs: typeof manifest.toolTimeoutMs === 'number' ? manifest.toolTimeoutMs : undefined,
        };
        descriptors.push(descriptor);
      } else {
        const descriptor = {
          id: contrib.contributionKey || contrib.id,
          contributionId: contrib.contributionKey || contrib.id,
          name: (manifest.name as string) || contrib.contributionKey,
          description: (manifest.description as string) ?? undefined,
          version: String(pkg.activeVersion),
          transport: 'streamable-http',
          url: (manifest.url as string) || '',
          headers: manifest.headers && typeof manifest.headers === 'object' && !Array.isArray(manifest.headers) ? manifest.headers : undefined,
          spaceIds: Array.from(spaceIds),
          adminApproved: true,
          source: 'user-extension',
          credentialRefs: Array.isArray(manifest.credentialRefs) ? manifest.credentialRefs : undefined,
          toolTimeoutMs: typeof manifest.toolTimeoutMs === 'number' ? manifest.toolTimeoutMs : undefined,
        };
        descriptors.push(descriptor);
      }
    }

    return descriptors;
  }

  /**
   * Reconciles active MCP contributions with configured MCP manager / reconciler.
   */
  public async notifyMcpReconcile(userId: string): Promise<void> {
    try {
      if (this.mcpService && typeof this.mcpService.reconcile === 'function') {
        const allUserMcp = await this.resolveAllMcpForUser(userId);
        await this.mcpService.reconcile(allUserMcp);
      } else if (this.mcpReconciler && typeof this.mcpReconciler.reconcile === 'function') {
        const allUserMcp = await this.resolveAllMcpForUser(userId);
        await this.mcpReconciler.reconcile(allUserMcp);
      }
    } catch {
      // Reconcile notifications must fail gracefully without failing caller transaction
    }
  }

  private async syncFilesToSpace(
    userId: string,
    spaceId: string,
    sourceDir: string,
    destPrefix: string
  ): Promise<void> {
    if (!this.fileProvider) return;
    try {
      const entries = fs.readdirSync(sourceDir, { recursive: true });
      for (const entry of entries) {
        const relPath = String(entry).replaceAll('\\', '/');
        const fullPath = path.join(sourceDir, relPath);
        try {
          const stat = fs.lstatSync(fullPath);
          if (stat.isFile()) {
            const fileBuffer = fs.readFileSync(fullPath);
            const targetPath = path.posix.join(destPrefix, relPath);
            let statRes: any;
            try {
              statRes = await this.fileProvider.execute(userId, spaceId, {
                op: 'stat',
                path: targetPath,
              });
            } catch {}

            if (statRes && statRes.type === 'file' && typeof statRes.etag === 'string') {
              await this.fileProvider.execute(userId, spaceId, {
                op: 'write',
                path: targetPath,
                content: fileBuffer.toString('utf8'),
                expectedEtag: statRes.etag,
              });
            } else {
              await this.fileProvider.execute(userId, spaceId, {
                op: 'write',
                path: targetPath,
                content: fileBuffer.toString('utf8'),
                requireAbsent: true,
              });
            }
          }
        } catch {}
      }
    } catch {}
  }

  private resolveSpacePath(userId: string, spaceFolder: string): string {
    const spacePath = path.join(this.spacesDir, spaceFolder);
    const resolved = path.resolve(spacePath);
    if (!resolved.startsWith(this.spacesDir + path.sep) && resolved !== this.spacesDir) {
      throw new ValidationError(`Space folder "${spaceFolder}" escapes root spaces boundary`);
    }
    return resolved;
  }

  private async getSpaceForUser(userId: string, spaceId: string): Promise<Space> {
    const space = await this.storage.forTenant(userId).spaces.findById(spaceId);
    if (!space) {
      throw new NotFoundError(`Target space "${spaceId}" not found for user`);
    }
    return space;
  }

  private async recordAudit(userId: string, action: AuthAuditAction, details: Record<string, unknown>): Promise<void> {
    try {
      if (this.storage.auditLogs && typeof this.storage.auditLogs.create === 'function') {
        const user = await this.storage.users.findById(userId);
        await this.storage.auditLogs.create({
          userId,
          username: user?.username ?? null,
          action,
          details,
        });
      }
    } catch {
      // Audit logging must not block primary transaction
    }
  }

  private extractUserId(userOrId: string | User): string {
    if (typeof userOrId === 'string') {
      if (!userOrId.trim()) {
        throw new ValidationError('User ID cannot be empty');
      }
      return userOrId;
    }
    return userOrId.id;
  }

  /**
   * Install an extension package from a Git repository.
   */
  async installGit(input: InstallGitExtensionInput): Promise<PublicExtensionDetail> {
    if (!input.userId) {
      throw new ValidationError('User ID is required');
    }
    if (!input.repositoryUrl) {
      throw new ValidationError('Repository URL is required');
    }

    const user = await this.storage.users.findById(input.userId);
    if (!user) {
      throw new NotFoundError(`User "${input.userId}" not found`);
    }

    let resolvedCreds: GitResolvedCredentials | undefined;
    if (input.credentialRef) {
      resolvedCreds = await this.resolveGitCredentials(input.userId, input.credentialRef);
    }

    const gitSource = {
      repositoryUrl: input.repositoryUrl,
      ref: input.ref,
      subdirectory: input.subdirectory,
      expectedCommit: input.expectedCommit,
      credentialRef: input.credentialRef,
      authToken: resolvedCreds?.authToken ?? input.authToken,
      sshPrivateKey: resolvedCreds?.sshPrivateKey ?? input.sshPrivateKey,
      knownHostsFile: resolvedCreds?.knownHostsFile ?? input.knownHostsFile,
    };

    // Stage Git repository into isolated temp sandbox
    const staged = await stageGitSkill(gitSource, this.gitSourcePolicy);

    try {
      if (input.expectedChecksum && staged.payload.contentHash.toLowerCase() !== input.expectedChecksum.toLowerCase()) {
        throw new ValidationError(
          `Staged extension checksum mismatch: expected "${input.expectedChecksum}", got "${staged.payload.contentHash}"`
        );
      }

      if ((staged.payload.isMcp || staged.payload.isCli) && user.role !== 'admin') {
        throw new ForbiddenError('Only administrators can install MCP or CLI extensions');
      }

      const slug = staged.payload.slug || staged.payload.name;
      let space: Space | undefined;
      let targetDirRoot: string;
      if (input.targetSpaceId) {
        space = await this.getSpaceForUser(input.userId, input.targetSpaceId);
        targetDirRoot = path.join(this.resolveSpacePath(input.userId, space.folder), (staged.payload.isMcp || staged.payload.isCli) ? '.extensions' : '.skills');
      } else {
        targetDirRoot = path.join(this.dshHome, (staged.payload.isMcp || staged.payload.isCli) ? 'extensions' : 'skills');
      }

      fs.mkdirSync(targetDirRoot, { recursive: true });
      const destSkillDir = path.join(targetDirRoot, slug);

      // Copy staged files to physical space destination
      if (fs.existsSync(destSkillDir)) {
        fs.rmSync(destSkillDir, { recursive: true, force: true });
      }
      fs.cpSync(staged.targetDir, destSkillDir, { recursive: true });

      if (this.fileProvider && input.targetSpaceId) {
        const extBase = (staged.payload.isMcp || staged.payload.isCli) ? '.extensions' : '.skills';
        await this.syncFilesToSpace(input.userId, input.targetSpaceId, staged.targetDir, path.posix.join(extBase, slug));
      }

      const sanitizedUrl = sanitizeRepositoryUrl(input.repositoryUrl);
      const pkgRepo = this.storage.forTenant(input.userId).extensionPackages;
      const bindRepo = this.storage.forTenant(input.userId).extensionBindings;

      const existingPkg = await pkgRepo.findBySlug(slug);
      let pkg: ExtensionPackageRecord;
      const isSameContent = existingPkg !== null && existingPkg.integritySha256 === staged.payload.contentHash;
      const versionNum = existingPkg ? (isSameContent ? existingPkg.installedVersion : existingPkg.installedVersion + 1) : 1;

      const provenance = {
        sourceKind: 'git',
        sourceUrl: sanitizedUrl,
        ref: input.ref ?? 'HEAD',
        commitSha: staged.commitSha,
        subdirectory: input.subdirectory ?? null,
        credentialRef: input.credentialRef ?? null,
        contentHash: staged.payload.contentHash,
        fileCount: staged.payload.fileCount,
        totalBytes: staged.payload.totalBytes,
      };

      if (existingPkg) {
        pkg = await pkgRepo.update(existingPkg.id, {
          name: staged.payload.name,
          description: staged.payload.description,
          sourceKind: 'git',
          sourceRef: sanitizedUrl,
          installedVersion: versionNum,
          activeVersion: versionNum,
          status: 'active',
          integritySha256: staged.payload.contentHash,
          provenanceJson: JSON.stringify(provenance),
        });
      } else {
        pkg = await pkgRepo.create({
          slug,
          name: staged.payload.name,
          description: staged.payload.description,
          sourceKind: 'git',
          sourceRef: sanitizedUrl,
          installedVersion: 1,
          activeVersion: 1,
          status: 'active',
          integritySha256: staged.payload.contentHash,
          provenanceJson: JSON.stringify(provenance),
        });
      }

      // Record Version if not duplicate content
      if (!isSameContent) {
        await pkgRepo.createVersion({
          packageId: pkg.id,
          version: versionNum,
          sourceKind: 'git',
          sourceRef: sanitizedUrl,
          commitSha: staged.commitSha,
          integritySha256: staged.payload.contentHash,
          manifestJson: JSON.stringify({
            name: staged.payload.name,
            description: staged.payload.description,
            whenToUse: staged.payload.whenToUse,
            invocation: staged.payload.invocation,
            contributions: staged.payload.contributions,
          }),
          changeSummary: `Git install @ ${staged.commitSha.slice(0, 8)}`,
        });
      }

      // Record Contributions
      const contributions = staged.payload.contributions && staged.payload.contributions.length > 0
        ? staged.payload.contributions
        : [
            {
              kind: 'skill' as const,
              key: slug,
              manifest: {
                name: staged.payload.name,
                description: staged.payload.description,
                whenToUse: staged.payload.whenToUse,
                entrypoint: 'SKILL.md',
                invocation: staged.payload.invocation,
              },
            },
          ];

      for (const contribDef of contributions) {
        const existingContrib = await pkgRepo.findContributionByKey(pkg.id, contribDef.kind, contribDef.key);
        let contrib: ExtensionContributionRecord;
        if (!existingContrib) {
          contrib = await pkgRepo.createContribution({
            packageId: pkg.id,
            kind: contribDef.kind,
            contributionKey: contribDef.key,
            manifestJson: JSON.stringify(contribDef.manifest),
            status: 'active',
          });
        } else {
          contrib = await pkgRepo.updateContribution(existingContrib.id, {
            manifestJson: JSON.stringify(contribDef.manifest),
            status: 'active',
          });
        }

        // Set Binding if space specified
        if (input.targetSpaceId) {
          await bindRepo.setBinding(input.targetSpaceId, contrib.id, true);
        }
      }

      await this.recordAudit(input.userId, existingPkg ? 'extension.updated' : 'extension.installed', {
        packageId: pkg.id,
        slug: pkg.slug,
        version: versionNum,
        sourceKind: 'git',
        targetSpaceId: input.targetSpaceId ?? null,
      });

      await this.notifyMcpReconcile(input.userId);

      return this.getPackage(input.userId, pkg.slug, input.targetSpaceId ?? undefined);
    } finally {
      if (staged.cleanup) {
        staged.cleanup();
      }
    }
  }

  /**
   * Install an extension package from an archive buffer.
   */
  async installArchive(input: InstallArchiveExtensionInput): Promise<PublicExtensionDetail> {
    if (!input.userId) {
      throw new ValidationError('User ID is required');
    }
    if (!input.archiveBuffer || input.archiveBuffer.length === 0) {
      throw new ValidationError('Archive buffer cannot be empty');
    }

    const user = await this.storage.users.findById(input.userId);
    if (!user) {
      throw new NotFoundError(`User "${input.userId}" not found`);
    }

    const staged = await stageArchiveSkill(
      input.archiveBuffer,
      input.archiveFilename ?? 'skill.tar.gz'
    );

    try {
      if ((staged.payload.isMcp || staged.payload.isCli) && user.role !== 'admin') {
        throw new ForbiddenError('Only administrators can install MCP or CLI extensions');
      }

      const slug = staged.payload.slug || staged.payload.name;
      let space: Space | undefined;
      let targetDirRoot: string;
      if (input.targetSpaceId) {
        space = await this.getSpaceForUser(input.userId, input.targetSpaceId);
        targetDirRoot = path.join(this.resolveSpacePath(input.userId, space.folder), (staged.payload.isMcp || staged.payload.isCli) ? '.extensions' : '.skills');
      } else {
        targetDirRoot = path.join(this.dshHome, (staged.payload.isMcp || staged.payload.isCli) ? 'extensions' : 'skills');
      }

      fs.mkdirSync(targetDirRoot, { recursive: true });
      const destSkillDir = path.join(targetDirRoot, slug);

      if (fs.existsSync(destSkillDir)) {
        fs.rmSync(destSkillDir, { recursive: true, force: true });
      }
      fs.cpSync(staged.targetDir, destSkillDir, { recursive: true });

      if (this.fileProvider && input.targetSpaceId) {
        const extBase = (staged.payload.isMcp || staged.payload.isCli) ? '.extensions' : '.skills';
        await this.syncFilesToSpace(input.userId, input.targetSpaceId, staged.targetDir, path.posix.join(extBase, slug));
      }

      const pkgRepo = this.storage.forTenant(input.userId).extensionPackages;
      const bindRepo = this.storage.forTenant(input.userId).extensionBindings;

      const existingPkg = await pkgRepo.findBySlug(slug);
      let pkg: ExtensionPackageRecord;
      const isSameContent = existingPkg !== null && existingPkg.integritySha256 === staged.payload.contentHash;
      const versionNum = existingPkg ? (isSameContent ? existingPkg.installedVersion : existingPkg.installedVersion + 1) : 1;

      const provenance = {
        sourceKind: 'archive',
        filename: input.archiveFilename ?? 'archive.tar.gz',
        contentHash: staged.payload.contentHash,
        fileCount: staged.payload.fileCount,
        totalBytes: staged.payload.totalBytes,
      };

      if (existingPkg) {
        pkg = await pkgRepo.update(existingPkg.id, {
          name: staged.payload.name,
          description: staged.payload.description,
          sourceKind: 'archive',
          sourceRef: input.archiveFilename ?? 'archive.tar.gz',
          installedVersion: versionNum,
          activeVersion: versionNum,
          status: 'active',
          integritySha256: staged.payload.contentHash,
          provenanceJson: JSON.stringify(provenance),
        });
      } else {
        pkg = await pkgRepo.create({
          slug,
          name: staged.payload.name,
          description: staged.payload.description,
          sourceKind: 'archive',
          sourceRef: input.archiveFilename ?? 'archive.tar.gz',
          installedVersion: 1,
          activeVersion: 1,
          status: 'active',
          integritySha256: staged.payload.contentHash,
          provenanceJson: JSON.stringify(provenance),
        });
      }

      // Record Version if not duplicate content
      if (!isSameContent) {
        await pkgRepo.createVersion({
          packageId: pkg.id,
          version: versionNum,
          sourceKind: 'archive',
          sourceRef: input.archiveFilename ?? 'archive.tar.gz',
          integritySha256: staged.payload.contentHash,
          manifestJson: JSON.stringify({
            name: staged.payload.name,
            description: staged.payload.description,
            whenToUse: staged.payload.whenToUse,
            invocation: staged.payload.invocation,
            contributions: staged.payload.contributions,
          }),
          changeSummary: `Archive upload: ${input.archiveFilename ?? 'archive.tar.gz'}`,
        });
      }

      // Record Contributions
      const contributions = staged.payload.contributions && staged.payload.contributions.length > 0
        ? staged.payload.contributions
        : [
            {
              kind: 'skill' as const,
              key: slug,
              manifest: {
                name: staged.payload.name,
                description: staged.payload.description,
                whenToUse: staged.payload.whenToUse,
                entrypoint: 'SKILL.md',
                invocation: staged.payload.invocation,
              },
            },
          ];

      for (const contribDef of contributions) {
        const existingContrib = await pkgRepo.findContributionByKey(pkg.id, contribDef.kind, contribDef.key);
        let contrib: ExtensionContributionRecord;
        if (!existingContrib) {
          contrib = await pkgRepo.createContribution({
            packageId: pkg.id,
            kind: contribDef.kind,
            contributionKey: contribDef.key,
            manifestJson: JSON.stringify(contribDef.manifest),
            status: 'active',
          });
        } else {
          contrib = await pkgRepo.updateContribution(existingContrib.id, {
            manifestJson: JSON.stringify(contribDef.manifest),
            status: 'active',
          });
        }

        // Set Binding if space specified
        if (input.targetSpaceId) {
          await bindRepo.setBinding(input.targetSpaceId, contrib.id, true);
        }
      }

      await this.recordAudit(input.userId, existingPkg ? 'extension.updated' : 'extension.installed', {
        packageId: pkg.id,
        slug: pkg.slug,
        version: versionNum,
        sourceKind: 'archive',
        targetSpaceId: input.targetSpaceId ?? null,
      });

      await this.notifyMcpReconcile(input.userId);

      return this.getPackage(input.userId, pkg.slug, input.targetSpaceId ?? undefined);
    } finally {
      if (staged.cleanup) {
        staged.cleanup();
      }
    }
  }

  /**
   * Idempotently synchronizes the compiled trusted plugin registry into SQLite
   * for a specific tenant (user).
   */
  public async syncTenantTrustedPlugins(userId: string): Promise<void> {
    const tenantStorage = this.storage.forTenant(userId);
    const pkgRepo = tenantStorage.extensionPackages;
    const plugins = listTrustedPlugins();

    for (const p of plugins) {
      let pkg = await pkgRepo.findBySlug(p.slug);
      if (!pkg) {
        const pkgId = `pkg_builtin_${p.slug.replace(/[^a-zA-Z0-9_]/g, '_')}`;
        try {
          pkg = await pkgRepo.create({
            id: pkgId,
            slug: p.slug,
            name: p.name,
            description: p.description,
            sourceKind: 'builtin',
            sourceRef: p.trustedPluginId,
            installedVersion: p.version,
            activeVersion: p.version,
            status: 'active',
            integritySha256: p.integritySha256,
            provenanceJson: JSON.stringify({
              scope: 'builtin',
              trustedPluginId: p.trustedPluginId,
              compiled: true,
            }),
          });
        } catch {
          // If already inserted concurrently, find it
          pkg = await pkgRepo.findBySlug(p.slug);
        }
      }

      if (pkg) {
        const contribs = await pkgRepo.listContributions(pkg.id);
        const exists = contribs.some((c) => c.contributionKey === p.slug && c.kind === 'dsh-plugin');
        if (!exists) {
          const contribId = `contrib_builtin_${p.slug.replace(/[^a-zA-Z0-9_]/g, '_')}`;
          try {
            await pkgRepo.createContribution({
              id: contribId,
              packageId: pkg.id,
              kind: 'dsh-plugin',
              contributionKey: p.slug,
              manifestJson: JSON.stringify({
                ...p.manifest,
                trustedPluginId: p.trustedPluginId,
                version: p.version,
                integrity: p.integritySha256,
              }),
              status: 'active',
            });
          } catch {
            // Ignore if contribution already created
          }
        }
      }
    }
  }

  /**
   * Idempotently synchronizes trusted plugin registry across all registered tenants.
   */
  public async syncAllTenantsTrustedPlugins(): Promise<void> {
    const users = await this.storage.users.list();
    for (const user of users) {
      try {
        await this.syncTenantTrustedPlugins(user.id);
      } catch {
        // Non-fatal per-tenant sync
      }
    }
  }

  /**
   * Updates an existing extension package to latest or specified ref.
   */
  async update(input: UpdateExtensionInput): Promise<PublicExtensionDetail | SkillDiffPreview> {
    if (input.slug === 'browser' || input.slug === 'pkg_builtin_browser' || getTrustedPlugin(input.slug)) {
      throw new ValidationError('Built-in extensions cannot be updated');
    }
    const user = await this.storage.users.findById(input.userId);
    if (!user) {
      throw new NotFoundError(`User "${input.userId}" not found`);
    }

    const pkg = await this.storage.forTenant(input.userId).extensionPackages.findBySlug(input.slug);
    if (!pkg) {
      throw new NotFoundError(`Extension package "${input.slug}" not found for user`);
    }
    if (pkg.sourceKind === 'builtin') {
      throw new ValidationError('Built-in extensions cannot be updated');
    }

    const contribs = await this.storage.forTenant(input.userId).extensionPackages.listContributions(pkg.id);
    const hasMcp = contribs.some((c) => c.kind === 'mcp');
    if (hasMcp && user.role !== 'admin') {
      throw new ForbiddenError('Only administrators can update MCP extensions');
    }

    if (pkg.sourceKind !== 'git') {
      throw new ValidationError(`Package "${input.slug}" is not a Git-based extension and cannot be updated via Git ref`);
    }

    const versions = await this.storage.forTenant(input.userId).extensionPackages.listVersions(pkg.id);
    const latestVersion = versions[0];
    const baseCommitSha = latestVersion?.commitSha ?? pkg.sourceRef;

    let resolvedCreds: GitResolvedCredentials | undefined;
    if (input.credentialRef) {
      resolvedCreds = await this.resolveGitCredentials(input.userId, input.credentialRef);
    }

    const gitSource = {
      repositoryUrl: pkg.sourceRef!,
      ref: input.ref,
      expectedCommit: input.expectedCommit,
      credentialRef: input.credentialRef,
      authToken: resolvedCreds?.authToken ?? input.authToken,
      sshPrivateKey: resolvedCreds?.sshPrivateKey ?? input.sshPrivateKey,
      knownHostsFile: resolvedCreds?.knownHostsFile ?? input.knownHostsFile,
    };

    // If confirmation is required and confirmDiff is not true, provide diff preview
    if (!input.confirmDiff && baseCommitSha) {
      const preview = await previewGitDiff(gitSource, baseCommitSha, this.gitSourcePolicy);
      if (preview.requiresConfirmation) {
        return preview;
      }
    }

    // Apply install/update
    return this.installGit({
      userId: input.userId,
      repositoryUrl: gitSource.repositoryUrl,
      ref: gitSource.ref,
      expectedCommit: gitSource.expectedCommit,
      credentialRef: gitSource.credentialRef,
      targetSpaceId: input.targetSpaceId,
      idempotencyKey: input.idempotencyKey,
    });
  }

  /**
   * Rollback extension to a previously recorded version.
   */
  async rollback(input: RollbackExtensionInput): Promise<PublicExtensionDetail> {
    if (input.slug === 'browser' || input.slug === 'pkg_builtin_browser' || getTrustedPlugin(input.slug)) {
      throw new ValidationError('Built-in extensions cannot be rolled back');
    }
    const user = await this.storage.users.findById(input.userId);
    if (!user) {
      throw new NotFoundError(`User "${input.userId}" not found`);
    }

    const pkgRepo = this.storage.forTenant(input.userId).extensionPackages;

    const pkg = await pkgRepo.findBySlug(input.slug);
    if (!pkg) {
      throw new NotFoundError(`Extension package "${input.slug}" not found for user`);
    }
    if (pkg.sourceKind === 'builtin') {
      throw new ValidationError('Built-in extensions cannot be rolled back');
    }

    const contribs = await pkgRepo.listContributions(pkg.id);
    const hasMcp = contribs.some((c) => c.kind === 'mcp');
    if (hasMcp && user.role !== 'admin') {
      throw new ForbiddenError('Only administrators can rollback MCP extensions');
    }

    const targetVer = await pkgRepo.getVersion(pkg.id, input.targetVersion);
    if (!targetVer) {
      throw new NotFoundError(`Version ${input.targetVersion} not found for extension "${input.slug}"`);
    }

    let targetDirRoot: string;
    if (input.targetSpaceId) {
      const space = await this.getSpaceForUser(input.userId, input.targetSpaceId);
      targetDirRoot = path.join(this.resolveSpacePath(input.userId, space.folder), hasMcp ? '.extensions' : '.skills');
    } else {
      targetDirRoot = path.join(this.dshHome, hasMcp ? 'extensions' : 'skills');
    }

    // If it was Git-based and commitSha is recorded, checkout that exact commit into target dir
    if (pkg.sourceKind === 'git' && targetVer.commitSha && pkg.sourceRef) {
      const staged = await stageGitSkill({
        repositoryUrl: pkg.sourceRef,
        ref: targetVer.commitSha,
        expectedCommit: targetVer.commitSha,
      }, this.gitSourcePolicy);

      try {
        fs.mkdirSync(targetDirRoot, { recursive: true });
        const destSkillDir = path.join(targetDirRoot, staged.payload.slug || staged.payload.name);
        if (fs.existsSync(destSkillDir)) {
          fs.rmSync(destSkillDir, { recursive: true, force: true });
        }
        fs.cpSync(staged.targetDir, destSkillDir, { recursive: true });
      } finally {
        staged.cleanup();
      }
    }

    // Direct rollback active version metadata update
    await pkgRepo.update(pkg.id, {
      activeVersion: targetVer.version,
      integritySha256: targetVer.integritySha256,
    });

    await this.recordAudit(input.userId, 'extension.rollback', {
      packageId: pkg.id,
      slug: pkg.slug,
      targetVersion: input.targetVersion,
      targetSpaceId: input.targetSpaceId ?? null,
    });

    return this.getPackage(input.userId, pkg.slug, input.targetSpaceId ?? undefined);
  }

  /**
   * Enables an extension in a space.
   */
  async enable(userOrId: string | User, spaceId: string, slug: string): Promise<PublicExtensionBinding> {
    const userId = this.extractUserId(userOrId);
    const space = await this.getSpaceForUser(userId, spaceId);
    validateSkillName(slug);

    const user = typeof userOrId === 'object' ? userOrId : await this.storage.users.findById(userId);
    if (!user) {
      throw new NotFoundError(`User "${userId}" not found`);
    }

    const pkgRepo = this.storage.forTenant(userId).extensionPackages;
    const bindRepo = this.storage.forTenant(userId).extensionBindings;

    const pkg = await pkgRepo.findBySlug(slug);
    if (!pkg) {
      throw new NotFoundError(`Extension "${slug}" not found`);
    }

    const contribs = await pkgRepo.listContributions(pkg.id);
    const mainContrib = contribs.find((c) => c.contributionKey === slug) || contribs[0];
    if (!mainContrib) {
      throw new NotFoundError(`No contribution found for extension "${slug}"`);
    }

    const hasMcp = contribs.some((c) => c.kind === 'mcp');
    const hasPlugin = contribs.some((c) => c.kind === 'dsh-plugin');
    if ((hasMcp || hasPlugin) && user.role !== 'admin') {
      throw new ForbiddenError(`Only administrators can enable ${hasPlugin ? 'DSH plugin' : 'MCP'} extensions`);
    }

    // If space-installed skill file exists, update frontmatter
    const spaceSkillsDir = path.join(this.resolveSpacePath(userId, space.folder), '.skills', slug);
    const skillMd = path.join(spaceSkillsDir, 'SKILL.md');
    if (fs.existsSync(skillMd)) {
      const raw = fs.readFileSync(skillMd, 'utf8');
      const updated = updateSkillFrontmatterInvocation(raw, false);
      fs.writeFileSync(skillMd, updated, 'utf8');
    }

    if (this.fileProvider) {
      const isExtOrMcp = hasMcp || contribs.some((c) => c.kind === 'cli');
      const pkgDir = this.findPackageDirectory(userId, space.folder, pkg.slug, isExtOrMcp);
      if (pkgDir && fs.existsSync(pkgDir)) {
        const extBase = isExtOrMcp ? '.extensions' : '.skills';
        await this.syncFilesToSpace(userId, spaceId, pkgDir, path.posix.join(extBase, slug));
      }
    }

    const binding = await bindRepo.setBinding(spaceId, mainContrib.id, true);

    await this.recordAudit(userId, 'extension.enabled', {
      packageId: pkg.id,
      contributionId: mainContrib.id,
      slug,
      spaceId,
    });

    await this.notifyMcpReconcile(userId);

    return {
      id: binding.id,
      spaceId: binding.spaceId,
      spaceName: space.name,
      contributionId: binding.contributionId,
      contributionKey: mainContrib.contributionKey,
      kind: mainContrib.kind,
      enabled: binding.enabled,
      updatedAt: binding.updatedAt,
    };
  }

  /**
   * Disables an extension in a space without deleting files.
   */
  async disable(userOrId: string | User, spaceId: string, slug: string): Promise<PublicExtensionBinding> {
    const userId = this.extractUserId(userOrId);
    const space = await this.getSpaceForUser(userId, spaceId);
    validateSkillName(slug);

    const user = typeof userOrId === 'object' ? userOrId : await this.storage.users.findById(userId);
    if (!user) {
      throw new NotFoundError(`User "${userId}" not found`);
    }

    const pkgRepo = this.storage.forTenant(userId).extensionPackages;
    const bindRepo = this.storage.forTenant(userId).extensionBindings;

    const pkg = await pkgRepo.findBySlug(slug);
    if (!pkg) {
      throw new NotFoundError(`Extension "${slug}" not found`);
    }

    const contribs = await pkgRepo.listContributions(pkg.id);
    const mainContrib = contribs.find((c) => c.contributionKey === slug) || contribs[0];
    if (!mainContrib) {
      throw new NotFoundError(`No contribution found for extension "${slug}"`);
    }

    const hasMcp = contribs.some((c) => c.kind === 'mcp');
    const hasPlugin = contribs.some((c) => c.kind === 'dsh-plugin');
    if ((hasMcp || hasPlugin) && user.role !== 'admin') {
      throw new ForbiddenError(`Only administrators can disable ${hasPlugin ? 'DSH plugin' : 'MCP'} extensions`);
    }

    // If space-installed skill file exists, update frontmatter to disable model invocation
    const spaceSkillsDir = path.join(this.resolveSpacePath(userId, space.folder), '.skills', slug);
    const skillMd = path.join(spaceSkillsDir, 'SKILL.md');
    if (fs.existsSync(skillMd)) {
      const raw = fs.readFileSync(skillMd, 'utf8');
      const updated = updateSkillFrontmatterInvocation(raw, true);
      fs.writeFileSync(skillMd, updated, 'utf8');
    }

    const binding = await bindRepo.setBinding(spaceId, mainContrib.id, false);

    await this.recordAudit(userId, 'extension.disabled', {
      packageId: pkg.id,
      contributionId: mainContrib.id,
      slug,
      spaceId,
    });

    await this.notifyMcpReconcile(userId);

    return {
      id: binding.id,
      spaceId: binding.spaceId,
      spaceName: space.name,
      contributionId: binding.contributionId,
      contributionKey: mainContrib.contributionKey,
      kind: mainContrib.kind,
      enabled: binding.enabled,
      updatedAt: binding.updatedAt,
    };
  }

  /**
   * Uninstalls an extension from a space or global directory.
   */
  async uninstall(
    userOrId: string | User,
    slug: string,
    spaceId?: string | null
  ): Promise<boolean> {
    if (slug === 'browser' || slug === 'pkg_builtin_browser' || getTrustedPlugin(slug)) {
      throw new ValidationError('Built-in extensions cannot be uninstalled');
    }
    const userId = this.extractUserId(userOrId);
    validateSkillName(slug);

    const user = typeof userOrId === 'object' ? userOrId : await this.storage.users.findById(userId);
    if (!user) {
      throw new NotFoundError(`User "${userId}" not found`);
    }

    const pkgRepo = this.storage.forTenant(userId).extensionPackages;
    const bindRepo = this.storage.forTenant(userId).extensionBindings;

    const pkg = await pkgRepo.findBySlug(slug);
    if (pkg && pkg.sourceKind === 'builtin') {
      throw new ValidationError('Built-in extensions cannot be uninstalled');
    }

    if (pkg) {
      const contribs = await pkgRepo.listContributions(pkg.id);
      const hasMcp = contribs.some((c) => c.kind === 'mcp');
      const hasPlugin = contribs.some((c) => c.kind === 'dsh-plugin');
      if ((hasMcp || hasPlugin) && user.role !== 'admin') {
        throw new ForbiddenError('Only administrators can uninstall MCP/Plugin extensions');
      }
    }

    if (!spaceId) {
      if (user.role !== 'admin') {
        throw new ForbiddenError('Only administrators can uninstall global extensions');
      }
      const globalDir = path.join(this.dshHome, 'skills', slug);
      if (fs.existsSync(globalDir)) {
        fs.rmSync(globalDir, { recursive: true, force: true });
      }
      const globalExtDir = path.join(this.dshHome, 'extensions', slug);
      if (fs.existsSync(globalExtDir)) {
        fs.rmSync(globalExtDir, { recursive: true, force: true });
      }
      if (pkg) {
        await pkgRepo.delete(pkg.id);
      }
    } else {
      const space = await this.getSpaceForUser(userId, spaceId);
      const spaceDir = path.join(this.resolveSpacePath(userId, space.folder), '.skills', slug);
      if (fs.existsSync(spaceDir)) {
        fs.rmSync(spaceDir, { recursive: true, force: true });
      }
      const spaceExtDir = path.join(this.resolveSpacePath(userId, space.folder), '.extensions', slug);
      if (fs.existsSync(spaceExtDir)) {
        fs.rmSync(spaceExtDir, { recursive: true, force: true });
      }

      if (pkg) {
        const contribs = await pkgRepo.listContributions(pkg.id);
        for (const c of contribs) {
          await bindRepo.deleteBinding(spaceId, c.id);
        }
      }
    }

    if (pkg) {
      await this.recordAudit(userId, 'extension.uninstalled', {
        packageId: pkg.id,
        slug,
        spaceId: spaceId ?? null,
      });
    }

    await this.notifyMcpReconcile(userId);

    return true;
  }

  private async discoverBuiltinBrowser(): Promise<PublicExtensionSummary | null> {
    if (!this.browserService) {
      return null;
    }

    let isHealthy = false;
    try {
      const health = await this.browserService.checkHealth();
      isHealthy = health.status === 'healthy';
    } catch {
      isHealthy = false;
    }

    const browserContrib: PublicExtensionContribution = {
      id: 'contrib_builtin_browser',
      packageId: 'pkg_builtin_browser',
      kind: 'browser',
      contributionKey: 'browser',
      name: 'Built-in Browser Automation',
      description: 'Built-in trusted headless browser automation for web browsing and screenshots',
      whenToUse: 'Use when web browsing, page navigation, accessibility snapshots, element interaction, or page screenshots are requested.',
      status: isHealthy ? 'active' : 'disabled',
      runtimeAdapterAvailable: isHealthy,
      modelInvocable: true,
      userInvocable: true,
      manifest: {
        name: 'Built-in Browser Automation',
        description: 'Built-in trusted headless browser automation for web browsing and screenshots',
        kind: 'browser',
        tools: ['browser_open', 'browser_snapshot', 'browser_interact', 'browser_screenshot', 'browser_close'],
        invocation: {
          modelInvocable: true,
          userInvocable: true,
        },
      },
    };

    return {
      id: 'pkg_builtin_browser',
      slug: 'browser',
      name: 'Built-in Browser Automation',
      description: 'Built-in trusted headless browser automation for web browsing and screenshots',
      sourceKind: 'builtin',
      sourceRef: null,
      installedVersion: 1,
      activeVersion: 1,
      status: isHealthy ? 'active' : 'disabled',
      integritySha256: 'builtin_browser_sha256',
      enabled: isHealthy,
      contributions: [browserContrib],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
  }

  private discoverBundledSkills(): PublicExtensionSummary[] {
    if (!this.bundledSkillDir || !fs.existsSync(this.bundledSkillDir)) {
      return [];
    }
    const results: PublicExtensionSummary[] = [];
    try {
      const entries = fs.readdirSync(this.bundledSkillDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillName = entry.name;
        const skillMdPath = path.join(this.bundledSkillDir, skillName, 'SKILL.md');
        if (!fs.existsSync(skillMdPath)) continue;

        try {
          const raw = fs.readFileSync(skillMdPath, 'utf8');
          const parsed = parseSkillMarkdown(raw);
          results.push({
            id: `pkg_bundled_${skillName}`,
            slug: skillName,
            name: parsed.name,
            description: parsed.description,
            sourceKind: 'builtin',
            sourceRef: null,
            installedVersion: 1,
            activeVersion: 1,
            status: 'active',
            integritySha256: crypto.createHash('sha256').update(raw).digest('hex'),
            enabled: true,
            contributions: [
              {
                id: `contrib_bundled_${skillName}`,
                packageId: `pkg_bundled_${skillName}`,
                kind: 'skill',
                contributionKey: skillName,
                name: parsed.name,
                description: parsed.description,
                whenToUse: parsed.whenToUse,
                status: 'active',
                runtimeAdapterAvailable: true,
                modelInvocable: parsed.disableModelInvocation !== true,
                userInvocable: parsed.userInvocable !== false,
                manifest: {
                  name: parsed.name,
                  description: parsed.description,
                  whenToUse: parsed.whenToUse,
                  invocation: {
                    modelInvocable: parsed.disableModelInvocation !== true,
                    userInvocable: parsed.userInvocable !== false,
                  },
                },
              },
            ],
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          });
        } catch {
          // Ignore unparseable bundled skill
        }
      }
    } catch {
      // Ignore filesystem read error
    }
    return results;
  }

  /**
   * Retrieves single package detail with contributions, versions, and bindings.
   */
  async getPackage(
    userOrId: string | User,
    idOrSlug: string,
    spaceId?: string
  ): Promise<PublicExtensionDetail> {
    const userId = this.extractUserId(userOrId);
    await this.syncTenantTrustedPlugins(userId);
    const pkgRepo = this.storage.forTenant(userId).extensionPackages;
    let pkg = await pkgRepo.findById(idOrSlug);
    if (!pkg) {
      pkg = await pkgRepo.findBySlug(idOrSlug);
    }
    if (!pkg) {
      if (idOrSlug === 'browser' || idOrSlug === 'pkg_builtin_browser') {
        const builtinBrowser = await this.discoverBuiltinBrowser();
        if (builtinBrowser) {
          return {
            ...builtinBrowser,
            provenance: { scope: 'builtin' },
            versions: [
              {
                version: 1,
                sourceKind: 'builtin',
                integritySha256: builtinBrowser.integritySha256,
                createdAt: builtinBrowser.createdAt,
              },
            ],
            bindings: [],
            content: '# Built-in Browser Automation\n\nBuilt-in trusted headless browser automation service.',
          };
        }
      }

      if (this.bundledSkillDir) {
        const bundledList = this.discoverBundledSkills();
        const found = bundledList.find((b) => b.id === idOrSlug || b.slug === idOrSlug);
        if (found) {
          const skillMdPath = path.join(this.bundledSkillDir, found.slug, 'SKILL.md');
          const content = fs.existsSync(skillMdPath) ? fs.readFileSync(skillMdPath, 'utf8') : '';
          return {
            ...found,
            provenance: { scope: 'bundled' },
            versions: [
              {
                version: 1,
                sourceKind: 'builtin',
                integritySha256: found.integritySha256,
                createdAt: found.createdAt,
              },
            ],
            bindings: [],
            content,
          };
        }
      }
      throw new NotFoundError(`Extension package "${idOrSlug}" not found`);
    }

    return this.buildPackageDetail(userId, pkg, spaceId);
  }

  /**
   * List packages with flexible filtering.
   */
  async listPackages(
    userOrId: string | User,
    options?: {
      scope?: string;
      spaceId?: string | null;
      kind?: ExtensionKind;
      status?: ExtensionPackageStatus;
      search?: string;
      limit?: number;
      offset?: number;
    }
  ): Promise<PublicExtensionSummary[]> {
    const userId = this.extractUserId(userOrId);
    await this.syncTenantTrustedPlugins(userId);
    const pkgRepo = this.storage.forTenant(userId).extensionPackages;
    const pkgs = await pkgRepo.list({
      kind: options?.kind,
      status: options?.status,
      limit: options?.limit,
      offset: options?.offset,
    });

    const summaries: PublicExtensionSummary[] = [];
    for (const pkg of pkgs) {
      const contribs = await pkgRepo.listContributions(pkg.id);
      const publicContribs = contribs.map((c) => this.mapContribution(c));

      // Calculate effective enabled state in space if requested
      let enabled = pkg.status === 'active';
      if (options?.spaceId) {
        const bindRepo = this.storage.forTenant(userId).extensionBindings;
        const mainContrib = contribs[0];
        if (mainContrib) {
          const binding = await bindRepo.findBySpaceAndContribution(options.spaceId, mainContrib.id);
          if (binding) {
            enabled = binding.enabled;
          }
        }
      }

      summaries.push({
        id: pkg.id,
        slug: pkg.slug,
        name: pkg.name,
        description: pkg.description,
        sourceKind: pkg.sourceKind,
        sourceRef: pkg.sourceRef,
        installedVersion: pkg.installedVersion,
        activeVersion: pkg.activeVersion,
        status: pkg.status,
        integritySha256: pkg.integritySha256,
        enabled,
        contributions: publicContribs,
        createdAt: pkg.createdAt,
        updatedAt: pkg.updatedAt,
      });
    }

    if (this.bundledSkillDir) {
      const bundled = this.discoverBundledSkills();
      for (const b of bundled) {
        if (!summaries.some((s) => s.slug === b.slug)) {
          if (options?.kind && options.kind !== 'skill') continue;
          summaries.push(b);
        }
      }
    }

    if (this.browserService && (!options?.kind || options.kind === 'browser')) {
      const builtinBrowser = await this.discoverBuiltinBrowser();
      if (builtinBrowser && !summaries.some((s) => s.slug === builtinBrowser.slug)) {
        summaries.push(builtinBrowser);
      }
    }

    if (options?.search) {
      const q = options.search.toLowerCase();
      return summaries.filter((s) => s.name.toLowerCase().includes(q) || (s.description && s.description.toLowerCase().includes(q)));
    }

    return summaries;
  }

  /**
   * List contributions across all installed packages, with kind & space filtering.
   */
  async listContributions(
    userOrId: string | User,
    options?: {
      spaceId?: string | null;
      kind?: ExtensionKind;
      status?: ExtensionContributionStatus;
      search?: string;
      limit?: number;
      offset?: number;
    }
  ): Promise<PublicExtensionContribution[]> {
    const userId = this.extractUserId(userOrId);
    await this.syncTenantTrustedPlugins(userId);
    const pkgRepo = this.storage.forTenant(userId).extensionPackages;
    const contribs = await pkgRepo.listAllContributions({
      kind: options?.kind,
      status: options?.status,
      limit: options?.limit,
      offset: options?.offset,
    });

    const results: PublicExtensionContribution[] = contribs.map((c) => this.mapContribution(c));

    if (this.bundledSkillDir && (!options?.kind || options.kind === 'skill')) {
      const bundled = this.discoverBundledSkills();
      for (const b of bundled) {
        for (const c of b.contributions) {
          if (!results.some((r) => r.contributionKey === c.contributionKey && r.kind === c.kind)) {
            results.push(c);
          }
        }
      }
    }

    if (this.browserService && (!options?.kind || options.kind === 'browser')) {
      const builtinBrowser = await this.discoverBuiltinBrowser();
      if (builtinBrowser) {
        for (const c of builtinBrowser.contributions) {
          if (!results.some((r) => r.contributionKey === c.contributionKey && r.kind === c.kind)) {
            results.push(c);
          }
        }
      }
    }

    if (options?.search) {
      const q = options.search.toLowerCase();
      return results.filter((c) => c.name.toLowerCase().includes(q) || (c.description && c.description.toLowerCase().includes(q)));
    }

    return results;
  }

  /**
   * List bindings for a space.
   */
  async listBindings(
    userOrId: string | User,
    options?: { spaceId?: string; sessionId?: string; kind?: ExtensionKind }
  ): Promise<PublicExtensionBinding[]> {
    const userId = this.extractUserId(userOrId);
    const bindRepo = this.storage.forTenant(userId).extensionBindings;
    const pkgRepo = this.storage.forTenant(userId).extensionPackages;
    const spaceRepo = this.storage.forTenant(userId).spaces;

    let records: ExtensionBindingRecord[];
    if (options?.spaceId) {
      records = await bindRepo.listBySpace(options.spaceId);
    } else {
      records = await bindRepo.list();
    }

    const publicBindings: PublicExtensionBinding[] = [];
    for (const r of records) {
      const contrib = await pkgRepo.findContributionById(r.contributionId);
      const space = await spaceRepo.findById(r.spaceId);

      if (options?.kind && contrib?.kind !== options.kind) continue;

      publicBindings.push({
        id: r.id,
        spaceId: r.spaceId,
        spaceName: space?.name,
        contributionId: r.contributionId,
        contributionKey: contrib?.contributionKey ?? '',
        kind: contrib?.kind ?? 'skill',
        enabled: r.enabled,
        updatedAt: r.updatedAt,
      });
    }

    return publicBindings;
  }

  /**
   * Probe health of a contribution.
   */
  async probeContribution(
    userOrId: string | User,
    contributionId: string
  ): Promise<{ id: string; status: ExtensionContributionStatus; healthy: boolean; latencyMs: number }> {
    const userId = this.extractUserId(userOrId);
    const contrib = await this.storage.forTenant(userId).extensionPackages.findContributionById(contributionId);
    if (!contrib) {
      throw new NotFoundError(`Contribution "${contributionId}" not found`);
    }

    const start = Date.now();
    const isSkill = contrib.kind === 'skill';
    const isMcp = contrib.kind === 'mcp';
    const isCli = contrib.kind === 'cli';
    const healthy = (isSkill || isMcp || isCli) && contrib.status === 'active';
    const latencyMs = Date.now() - start;

    return {
      id: contrib.id,
      status: contrib.status,
      healthy,
      latencyMs,
    };
  }

  private mapContribution(c: ExtensionContributionRecord): PublicExtensionContribution {
    let manifest: Record<string, unknown> = {};
    if (c.manifestJson) {
      try {
        const parsed = JSON.parse(c.manifestJson);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          manifest = parsed;
        }
      } catch {
        manifest = {};
      }
    }

    const isSkill = c.kind === 'skill';
    const isMcp = c.kind === 'mcp';
    const isCli = c.kind === 'cli';
    const invocationObj = manifest.invocation && typeof manifest.invocation === 'object' && !Array.isArray(manifest.invocation)
      ? (manifest.invocation as Record<string, unknown>)
      : undefined;
    const isModelInvocable = isSkill
      ? (invocationObj ? invocationObj.modelInvocable !== false : true)
      : (isMcp || isCli)
      ? true
      : false;
    const isUserInvocable = isSkill
      ? (invocationObj ? invocationObj.userInvocable !== false : true)
      : (isMcp || isCli)
      ? true
      : false;
    const name = typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name.trim() : c.contributionKey;
    const description = typeof manifest.description === 'string' ? manifest.description : null;
    const whenToUse = typeof manifest.whenToUse === 'string' ? manifest.whenToUse : undefined;

    return {
      id: c.id,
      packageId: c.packageId,
      kind: c.kind,
      contributionKey: c.contributionKey,
      name,
      description,
      whenToUse,
      status: c.status,
      runtimeAdapterAvailable: isSkill || isMcp || isCli,
      modelInvocable: isModelInvocable,
      userInvocable: isUserInvocable,
      manifest,
    };
  }

  private async buildPackageDetail(
    userId: string,
    pkg: ExtensionPackageRecord,
    spaceId?: string
  ): Promise<PublicExtensionDetail> {
    const pkgRepo = this.storage.forTenant(userId).extensionPackages;
    const bindRepo = this.storage.forTenant(userId).extensionBindings;
    const spaceRepo = this.storage.forTenant(userId).spaces;

    const contribs = await pkgRepo.listContributions(pkg.id);
    const versions = await pkgRepo.listVersions(pkg.id);

    const publicContribs = contribs.map((c) => this.mapContribution(c));
    const publicVersions: PublicExtensionVersion[] = versions.map((v) => ({
      version: v.version,
      sourceKind: v.sourceKind,
      sourceRef: v.sourceRef,
      commitSha: v.commitSha,
      integritySha256: v.integritySha256,
      changeSummary: v.changeSummary,
      createdAt: v.createdAt,
    }));

    const bindings: PublicExtensionBinding[] = [];
    for (const c of contribs) {
      const bList = await bindRepo.listByContribution(c.id);
      for (const b of bList) {
        const space = await spaceRepo.findById(b.spaceId);
        bindings.push({
          id: b.id,
          spaceId: b.spaceId,
          spaceName: space?.name,
          contributionId: b.contributionId,
          contributionKey: c.contributionKey,
          kind: c.kind,
          enabled: b.enabled,
          updatedAt: b.updatedAt,
        });
      }
    }

    let enabled = pkg.status === 'active';
    if (spaceId && contribs.length > 0) {
      const b = await bindRepo.findBySpaceAndContribution(spaceId, contribs[0].id);
      if (b) {
        enabled = b.enabled;
      }
    }

    let content: string | undefined;
    if (spaceId) {
      const space = await spaceRepo.findById(spaceId);
      if (space) {
        const skillMdPath = path.join(this.resolveSpacePath(userId, space.folder), '.skills', pkg.slug, 'SKILL.md');
        if (fs.existsSync(skillMdPath)) {
          content = fs.readFileSync(skillMdPath, 'utf8');
        }
      }
    } else {
      const globalSkillMd = path.join(this.dshHome, 'skills', pkg.slug, 'SKILL.md');
      if (fs.existsSync(globalSkillMd)) {
        content = fs.readFileSync(globalSkillMd, 'utf8');
      } else if (this.bundledSkillDir) {
        const bundledSkillMd = path.join(this.bundledSkillDir, pkg.slug, 'SKILL.md');
        if (fs.existsSync(bundledSkillMd)) {
          content = fs.readFileSync(bundledSkillMd, 'utf8');
        }
      }
    }

    let provenance: Record<string, unknown> | null = null;
    if (pkg.provenanceJson) {
      try {
        provenance = JSON.parse(pkg.provenanceJson);
      } catch {
        provenance = null;
      }
    }

    return {
      id: pkg.id,
      slug: pkg.slug,
      name: pkg.name,
      description: pkg.description,
      sourceKind: pkg.sourceKind,
      sourceRef: pkg.sourceRef,
      installedVersion: pkg.installedVersion,
      activeVersion: pkg.activeVersion,
      status: pkg.status,
      integritySha256: pkg.integritySha256,
      enabled,
      provenance,
      contributions: publicContribs,
      versions: publicVersions,
      bindings,
      content,
      createdAt: pkg.createdAt,
      updatedAt: pkg.updatedAt,
    };
  }
}

export { ExtensionCatalogService as ExtensionService };
