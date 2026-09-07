/**
 * Unified Extension Catalog Types and Canonical DTOs
 *
 * Defines authoritative discriminated interfaces for extension packages, versions,
 * contributions (skill, mcp, cli, dsh-plugin, browser), specifications subtables,
 * bindings, health, operations, runtime adapters, and sanitized public DTOs.
 *
 * @module @enkeep/platform-core/types/extensions
 */

export type ExtensionKind = 'skill' | 'mcp' | 'cli' | 'dsh-plugin' | 'browser';
export type ExtensionSourceKind = 'git' | 'archive' | 'builtin';
export type ExtensionPackageStatus = 'active' | 'disabled';
export type ExtensionContributionStatus = 'active' | 'disabled';

// ---- Database Entities (Migration 30) ----

export interface ExtensionPackageRecord {
  id: string;
  userId: string;
  slug: string;
  name: string;
  description?: string | null;
  sourceKind: ExtensionSourceKind;
  sourceRef?: string | null;
  installedVersion: number;
  activeVersion: number;
  status: ExtensionPackageStatus;
  integritySha256: string;
  provenanceJson?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExtensionContributionRecord {
  id: string;
  packageId: string;
  kind: ExtensionKind;
  contributionKey: string;
  manifestJson: string;
  status: ExtensionContributionStatus;
  createdAt?: string;
  updatedAt?: string;
}

export interface ExtensionBindingRecord {
  id: string;
  userId: string;
  spaceId: string;
  contributionId: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ExtensionVersionRecord {
  id: string;
  packageId: string;
  version: number;
  sourceKind: ExtensionSourceKind;
  sourceRef?: string | null;
  commitSha?: string | null;
  integritySha256: string;
  manifestJson?: string | null;
  artifactPath?: string | null;
  changeSummary?: string | null;
  createdAt: string;
}

// ---- Public DTOs (Strictly Sanitized & Redacted) ----

export interface PublicExtensionContribution {
  id: string;
  packageId: string;
  kind: ExtensionKind;
  contributionKey: string;
  name: string;
  description?: string | null;
  whenToUse?: string;
  status: ExtensionContributionStatus;
  runtimeAdapterAvailable: boolean;
  modelInvocable: boolean;
  userInvocable: boolean;
  manifest?: Record<string, unknown>;
}

export interface PublicExtensionBinding {
  id: string;
  spaceId: string;
  spaceName?: string;
  contributionId: string;
  contributionKey: string;
  kind: ExtensionKind;
  enabled: boolean;
  updatedAt: string;
}

export interface PublicExtensionVersion {
  version: number;
  sourceKind: ExtensionSourceKind;
  sourceRef?: string | null;
  commitSha?: string | null;
  integritySha256: string;
  changeSummary?: string | null;
  createdAt: string;
}

export interface PublicExtensionSummary {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  sourceKind: ExtensionSourceKind;
  sourceRef?: string | null;
  installedVersion: number;
  activeVersion: number;
  status: ExtensionPackageStatus;
  integritySha256: string;
  enabled: boolean;
  contributions: PublicExtensionContribution[];
  createdAt: string;
  updatedAt: string;
}

export interface PublicExtensionDetail extends PublicExtensionSummary {
  provenance?: Record<string, unknown> | null;
  versions: PublicExtensionVersion[];
  bindings: PublicExtensionBinding[];
  content?: string; // markdown body for skill contributions (without absolute path leakage)
}

// ---- Skill / Extension Operations Inputs ----

export interface InstallGitExtensionInput {
  userId: string;
  repositoryUrl: string;
  ref?: string;
  subdirectory?: string;
  expectedCommit?: string;
  credentialRef?: string;
  authToken?: string;
  sshPrivateKey?: string;
  knownHostsFile?: string;
  targetSpaceId?: string | null;
  expectedChecksum?: string;
  idempotencyKey?: string;
}

export interface InstallArchiveExtensionInput {
  userId: string;
  archiveBuffer: Buffer;
  archiveFilename?: string;
  targetSpaceId?: string | null;
  expectedChecksum?: string;
  idempotencyKey?: string;
}

export interface UpdateExtensionInput {
  userId: string;
  slug: string;
  ref?: string;
  expectedCommit?: string;
  confirmDiff?: boolean;
  credentialRef?: string;
  authToken?: string;
  sshPrivateKey?: string;
  knownHostsFile?: string;
  targetSpaceId?: string | null;
  idempotencyKey?: string;
}

export interface RollbackExtensionInput {
  userId: string;
  slug: string;
  targetVersion: number;
  targetSpaceId?: string | null;
  idempotencyKey?: string;
}

export interface SetExtensionBindingInput {
  userId: string;
  spaceId: string;
  slugOrContributionKey: string;
  enabled: boolean;
  kind?: ExtensionKind;
}

// ---- Extension Runtime Adapter Contract ----

export interface ExtensionRuntimeContext {
  userId: string;
  spaceId?: string | null;
  sessionId?: string | null;
  homeSpaceId?: string | null;
}

export interface ExtensionExecutionResult {
  success: boolean;
  output?: unknown;
  error?: string;
  errorCode?: string;
}

export interface ExtensionRuntimeAdapter {
  readonly kind: ExtensionKind;
  readonly active: boolean;
  initialize?(): Promise<void>;
  shutdown?(): Promise<void>;
  resolveEffectiveTools?(context: ExtensionRuntimeContext): Promise<unknown[]>;
  executeContribution?(
    contributionId: string,
    action: string,
    params: Record<string, unknown>,
    context: ExtensionRuntimeContext
  ): Promise<ExtensionExecutionResult>;
}

// ---- Extension Activation Plan (Transient per turn) ----

/**
 * Activated generic extension contribution descriptor for Skills.
 */
export interface ExtensionSkillContributionActivation {
  readonly kind: 'skill';
  readonly contributionId: string;
  readonly contributionKey: string;
  readonly name: string;
  readonly description?: string | null;
  readonly whenToUse?: string | null;
  readonly version?: number;
  readonly enabled: boolean;
  readonly modelInvocable: boolean;
  readonly userInvocable: boolean;
  readonly artifactRelPath?: string;
  readonly contentHash?: string;
}

/**
 * Activated generic extension contribution descriptor for MCP Servers.
 */
export interface ExtensionMcpContributionActivation {
  readonly kind: 'mcp';
  readonly contributionId: string;
  readonly contributionKey?: string;
  readonly name: string;
  readonly description?: string | null;
  readonly whenToUse?: string | null;
  readonly version?: number;
  readonly enabled: boolean;
  readonly modelInvocable?: boolean;
  readonly userInvocable?: boolean;
  readonly artifactRelPath?: string;
  readonly contentHash?: string;
  readonly transport?: 'stdio' | 'streamable-http';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly url?: string;
  readonly headers?: Record<string, string>;
  readonly credentialRefs?: readonly { id: string; type?: string; scope?: string }[];
  readonly toolTimeoutMs?: number;
}

/**
 * Activated generic extension contribution descriptor for CLI Tools.
 */
export interface ExtensionCliContributionActivation {
  readonly kind: 'cli';
  readonly contributionId: string;
  readonly contributionKey: string;
  readonly name: string;
  readonly description?: string | null;
  readonly whenToUse?: string | null;
  readonly version?: number;
  readonly enabled: boolean;
  readonly modelInvocable?: boolean;
  readonly userInvocable?: boolean;
  readonly artifactRelPath?: string;
  readonly contentHash?: string;
  readonly command?: string;
  readonly script?: string;
  readonly fixedArgs?: readonly string[];
  readonly executionMode?: 'container' | 'host' | 'space';
  readonly timeoutMs?: number;
}

/**
 * Activated generic extension contribution descriptor for Trusted DSH Plugins.
 */
export interface ExtensionDshPluginContributionActivation {
  readonly kind: 'dsh-plugin';
  readonly contributionId: string;
  readonly contributionKey: string;
  readonly trustedPluginId: string;
  readonly name: string;
  readonly description?: string | null;
  readonly whenToUse?: string | null;
  readonly version: number;
  readonly integrity: string;
  readonly enabled: boolean;
  readonly config?: Record<string, unknown>;
}

/**
 * Discriminated union of generic extension contribution activations.
 * Supports 'skill', 'mcp', 'cli', and 'dsh-plugin' contributions.
 */
export type ExtensionContributionActivation =
  | ExtensionSkillContributionActivation
  | ExtensionMcpContributionActivation
  | ExtensionCliContributionActivation
  | ExtensionDshPluginContributionActivation;

/**
 * Generic Extension Activation Plan injected transiently per turn.
 * Encapsulates generation versioning and active contribution descriptors.
 */
export interface ExtensionActivationPlan {
  readonly generation: number;
  readonly contributions: readonly ExtensionContributionActivation[];
  /** Convenience accessor for active skill contributions */
  readonly skills: readonly ExtensionSkillContributionActivation[];
  /** Convenience accessor for active mcp contributions */
  readonly mcp?: readonly ExtensionMcpContributionActivation[];
  /** Convenience accessor for active cli contributions */
  readonly cli?: readonly ExtensionCliContributionActivation[];
  /** Convenience accessor for active dsh-plugin contributions */
  readonly plugins?: readonly ExtensionDshPluginContributionActivation[];
}

/**
 * Validates an extension activation plan and ensures strict fail-closed rejection
 * of any unhandled contribution kinds. Currently permits 'skill', 'mcp', 'cli', and 'dsh-plugin'.
 */
export function validateExtensionActivationPlan(plan: unknown): ExtensionActivationPlan {
  if (!plan || typeof plan !== 'object') {
    throw new Error('ExtensionActivationPlan must be a non-null object');
  }

  const raw = plan as Record<string, unknown>;
  if (typeof raw.generation !== 'number' || !Number.isInteger(raw.generation) || raw.generation < 0) {
    throw new Error('ExtensionActivationPlan generation must be a non-negative integer');
  }

  const contributionsRaw: unknown[] = [];
  if (Array.isArray(raw.contributions)) {
    contributionsRaw.push(...raw.contributions);
  } else {
    if (Array.isArray(raw.skills)) {
      contributionsRaw.push(...raw.skills);
    }
    if (Array.isArray(raw.mcp)) {
      contributionsRaw.push(...raw.mcp);
    }
    if (Array.isArray(raw.cli)) {
      contributionsRaw.push(...raw.cli);
    }
    if (Array.isArray(raw.plugins)) {
      contributionsRaw.push(...raw.plugins);
    }
  }

  const validatedSkills: ExtensionSkillContributionActivation[] = [];
  const validatedMcp: ExtensionMcpContributionActivation[] = [];
  const validatedCli: ExtensionCliContributionActivation[] = [];
  const validatedPlugins: ExtensionDshPluginContributionActivation[] = [];
  const validatedContributions: ExtensionContributionActivation[] = [];

  for (let i = 0; i < contributionsRaw.length; i++) {
    const item = contributionsRaw[i];
    if (!item || typeof item !== 'object') {
      throw new Error(`Extension contribution at index ${i} must be an object`);
    }

    const c = item as Record<string, unknown>;
    const kind = c.kind ?? 'skill';

    if (kind !== 'skill' && kind !== 'mcp' && kind !== 'cli' && kind !== 'dsh-plugin') {
      throw new Error(
        `FAIL-CLOSED: Unknown or unsupported extension contribution kind "${String(kind)}" at index ${i}. Only "skill", "mcp", "cli", and "dsh-plugin" are activated.`
      );
    }

    if (typeof c.contributionId !== 'string' || !c.contributionId.trim()) {
      throw new Error(`Extension contribution at index ${i} requires a non-empty string contributionId`);
    }
    if (typeof c.name !== 'string' || !c.name.trim()) {
      throw new Error(`Extension contribution at index ${i} requires a non-empty string name`);
    }

    if (kind === 'skill') {
      const skillContrib: ExtensionSkillContributionActivation = {
        kind: 'skill',
        contributionId: c.contributionId.trim(),
        contributionKey: typeof c.contributionKey === 'string' && c.contributionKey.trim() ? c.contributionKey.trim() : c.name.trim(),
        name: c.name.trim(),
        description: typeof c.description === 'string' ? c.description : null,
        whenToUse: typeof c.whenToUse === 'string' ? c.whenToUse : null,
        version: typeof c.version === 'number' ? c.version : undefined,
        enabled: c.enabled !== false,
        modelInvocable: c.modelInvocable !== false,
        userInvocable: c.userInvocable !== false,
        artifactRelPath: typeof c.artifactRelPath === 'string' ? c.artifactRelPath : undefined,
        contentHash: typeof c.contentHash === 'string' ? c.contentHash : undefined,
      };
      validatedSkills.push(skillContrib);
      validatedContributions.push(skillContrib);
    } else if (kind === 'mcp') {
      const mcpContrib: ExtensionMcpContributionActivation = {
        kind: 'mcp',
        contributionId: c.contributionId.trim(),
        contributionKey: typeof c.contributionKey === 'string' && c.contributionKey.trim() ? c.contributionKey.trim() : c.name.trim(),
        name: c.name.trim(),
        description: typeof c.description === 'string' ? c.description : null,
        whenToUse: typeof c.whenToUse === 'string' ? c.whenToUse : null,
        version: typeof c.version === 'number' ? c.version : undefined,
        enabled: c.enabled !== false,
        modelInvocable: c.modelInvocable !== false,
        userInvocable: c.userInvocable !== false,
        artifactRelPath: typeof c.artifactRelPath === 'string' ? c.artifactRelPath : undefined,
        contentHash: typeof c.contentHash === 'string' ? c.contentHash : undefined,
        transport: c.transport as ('stdio' | 'streamable-http') | undefined,
        command: typeof c.command === 'string' ? c.command : undefined,
        args: Array.isArray(c.args) ? c.args.map(String) : undefined,
        cwd: typeof c.cwd === 'string' ? c.cwd : undefined,
        url: typeof c.url === 'string' ? c.url : undefined,
        headers: c.headers && typeof c.headers === 'object' && !Array.isArray(c.headers) ? c.headers as Record<string, string> : undefined,
        credentialRefs: Array.isArray(c.credentialRefs) ? c.credentialRefs as { id: string; type?: string; scope?: string }[] : undefined,
        toolTimeoutMs: typeof c.toolTimeoutMs === 'number' ? c.toolTimeoutMs : undefined,
      };
      validatedMcp.push(mcpContrib);
      validatedContributions.push(mcpContrib);
    } else if (kind === 'cli') {
      const cliContrib: ExtensionCliContributionActivation = {
        kind: 'cli',
        contributionId: c.contributionId.trim(),
        contributionKey: typeof c.contributionKey === 'string' && c.contributionKey.trim() ? c.contributionKey.trim() : c.name.trim(),
        name: c.name.trim(),
        description: typeof c.description === 'string' ? c.description : null,
        whenToUse: typeof c.whenToUse === 'string' ? c.whenToUse : null,
        version: typeof c.version === 'number' ? c.version : undefined,
        enabled: c.enabled !== false,
        modelInvocable: c.modelInvocable !== false,
        userInvocable: c.userInvocable !== false,
        artifactRelPath: typeof c.artifactRelPath === 'string' ? c.artifactRelPath : undefined,
        contentHash: typeof c.contentHash === 'string' ? c.contentHash : undefined,
        command: typeof c.command === 'string' ? c.command : 'node',
        script: typeof c.script === 'string' ? c.script : undefined,
        fixedArgs: Array.isArray(c.fixedArgs) ? c.fixedArgs.map(String) : (Array.isArray(c.args) ? c.args.map(String) : undefined),
        executionMode: (c.executionMode === 'container' || c.executionMode === 'host' || c.executionMode === 'space') ? c.executionMode : undefined,
        timeoutMs: typeof c.timeoutMs === 'number' ? c.timeoutMs : undefined,
      };
      validatedCli.push(cliContrib);
      validatedContributions.push(cliContrib);
    } else if (kind === 'dsh-plugin') {
      if (typeof c.trustedPluginId !== 'string' || !c.trustedPluginId.trim()) {
        throw new Error(`Extension contribution at index ${i} requires a non-empty string trustedPluginId`);
      }
      if (typeof c.version !== 'number' || !Number.isInteger(c.version) || c.version < 1) {
        throw new Error(`Extension contribution at index ${i} requires a positive integer version`);
      }
      if (typeof c.integrity !== 'string' || !c.integrity.trim()) {
        throw new Error(`Extension contribution at index ${i} requires a non-empty string integrity`);
      }

      const pluginContrib: ExtensionDshPluginContributionActivation = {
        kind: 'dsh-plugin',
        contributionId: c.contributionId.trim(),
        contributionKey: typeof c.contributionKey === 'string' && c.contributionKey.trim() ? c.contributionKey.trim() : c.name.trim(),
        trustedPluginId: c.trustedPluginId.trim(),
        name: c.name.trim(),
        description: typeof c.description === 'string' ? c.description : null,
        whenToUse: typeof c.whenToUse === 'string' ? c.whenToUse : null,
        version: c.version,
        integrity: c.integrity.trim(),
        enabled: c.enabled !== false,
        config: c.config && typeof c.config === 'object' && !Array.isArray(c.config) ? c.config as Record<string, unknown> : undefined,
      };
      validatedPlugins.push(pluginContrib);
      validatedContributions.push(pluginContrib);
    }
  }

  return {
    generation: raw.generation as number,
    contributions: Object.freeze(validatedContributions),
    skills: Object.freeze(validatedSkills),
    mcp: Object.freeze(validatedMcp),
    cli: Object.freeze(validatedCli),
    plugins: Object.freeze(validatedPlugins),
  };
}



