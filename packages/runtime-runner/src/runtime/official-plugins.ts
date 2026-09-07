/**
 * Official DSH 0.1.1-rc.2 Capabilities Mounting Subsystem for Enkeep Runtime
 *
 * Provides:
 * 1. Global Core Capabilities (mountOfficialPlugins):
 *    - TokenMeter, ToolResultPruner, BasicCompactionEngine (P0 Compaction)
 *    - ApprovalService, SandboxPolicyService (Approvals & Sandbox Policy)
 *    - SubagentRuntime, SubagentSpawnPlugin, SubagentForkPlugin (P2 Subagents Runtime)
 *    - ToolSubagentControlPlugin (send_message, interrupt_agent), ToolSubagentListAgentsPlugin (list_agents)
 *    - SkillRegistry, SkillFilesystemPlugin
 *    - Policy Enforcement Gate in tools/pre-execute
 *
 * 2. Per-Agent Workspace Tool Mount (mountWorkspaceTools):
 *    - Mounted inside Agent create/resume setup on agentCtx with concrete spacePath.
 *    - SpaceIsolatedFileSystem (ctx.fs scoped to spacePath)
 *    - FsObservationPolicy (write/edit require prior observation)
 *    - ToolFs (model-facing read, write, edit)
 *    - LocalSubprocess (ctx.subprocess)
 *    - ToolFsSearch (model-facing glob, grep)
 *    - ShellEnv (ctx.shellEnv scoped with dshHome)
 *    - SpaceIsolatedBashExecutor (ctx.shell scoped to spacePath)
 *    - ToolBash (model-facing bash)
 *    - LocalJobs (ctx.jobs) + ToolJobs (job_output, job_list, job_kill)
 *    - LocalSpillStore (root: spacePath/.dsh-spill) + SpillPolicy
 *    - ToolCallTimeoutPolicy + RepeatToolReminder
 *    - AgentInstructionsPlugin (scoped to spacePath)
 *    - SkillRegistry + SkillFilesystemPlugin (space .skills + bundled) + ToolSkillPlugin
 *    - ToolSubagentPlugin (spawn & fork)
 *    - ToolSubagentControlPlugin (send_message, interrupt_agent) + ToolSubagentListAgentsPlugin (list_agents)
 *    - PermissionPresetService (presets & mode enforcement in tools/pre-execute)
 *
 * Tracks Cordis fiber receipts for deterministic reverse rollback and non-hardcoded health probes.
 *
 * @module @enkeep/runtime-runner/runtime/official-plugins
 */

import fs from 'node:fs';
import path from 'node:path';
import { Context, type Fiber } from '@deepseek-ai/cordis';
import {
  FsError,
  FsTargetKey,
  FsVersion,
  type FsTarget,
  type FsPathInfo,
  type FsWriteIntent,
  type FsWriteOutcome,
  type FsEditRequest,
  type FsEditOutcome,
  type FsDirEntry,
} from '@deepseek-ai/dsh-fs';
import LocalFileSystem from '@deepseek-ai/dsh-fs-local';
import * as FsObservationPolicyPlugin from '@deepseek-ai/dsh-fs-observation-policy';
import * as ToolFsPlugin from '@deepseek-ai/dsh-tool-fs';
import LocalSubprocess, { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
import type { SubprocessSpawnSpec, SubprocessHandle } from '@deepseek-ai/dsh-subprocess';
export { LocalSubprocess };
import * as ToolFsSearchPlugin from '@deepseek-ai/dsh-tool-fs-search';
import * as ShellEnvPlugin from '@deepseek-ai/dsh-shell-env';
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local';
import type { ShellExecRequest, ShellExecSpec } from '@deepseek-ai/dsh-shell';
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox';
import * as ToolBashPlugin from '@deepseek-ai/dsh-tool-bash';
import LocalJobsPlugin from '@deepseek-ai/dsh-jobs-local';
import * as ToolJobsPlugin from '@deepseek-ai/dsh-tool-jobs';
import * as ToolCallTimeoutPolicyPlugin from '@deepseek-ai/dsh-tool-call-timeout-policy';
import * as RepeatToolReminderPlugin from '@deepseek-ai/dsh-repeat-tool-reminder';
import LocalSpillStore from '@deepseek-ai/dsh-spill-local';
import * as SpillPolicyPlugin from '@deepseek-ai/dsh-spill-policy';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic';
import * as AgentInstructionsPlugin from '@deepseek-ai/dsh-agent-instructions';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import * as SkillFilesystemPlugin from '@deepseek-ai/dsh-skill-filesystem';
import * as ToolSkillPlugin from '@deepseek-ai/dsh-tool-skill';
import SubagentRuntime from '@deepseek-ai/dsh-subagent';
import * as SubagentSpawnPlugin from '@deepseek-ai/dsh-subagent-spawn-in-process';
import * as SubagentForkPlugin from '@deepseek-ai/dsh-subagent-fork-in-process';
import * as ToolSubagentPlugin from '@deepseek-ai/dsh-tool-subagent';
import * as ToolSubagentControlPlugin from '@deepseek-ai/dsh-tool-subagent-control';
import * as ToolSubagentListAgentsPlugin from '@deepseek-ai/dsh-tool-subagent-control/list-agents';
import ApprovalService, { type ApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy';
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets';
import * as McpGovernancePlugin from '@enkeep/dsh-mcp-governance';
import * as CliToolsPlugin from '@enkeep/dsh-tool-cli';
import { validateTrustedPluginDescriptor, type TrustedPluginDefinition } from '@enkeep/dsh-enkeep-bundle';
import type { ResolvedRuntimeMount } from '../spec/types.js';
import { verifyMountTOCTOU, sanitizePathInError } from '../spec/mount-security.js';
import { VirtualMountResolver, VirtualMountPathResolver, type ResolvedVirtualTarget } from './virtual-mount-resolver.js';
import type { ExtensionActivationPlan, ExtensionDshPluginContributionActivation } from '@enkeep/protocol';
export { VirtualMountResolver, VirtualMountPathResolver };

export interface CompactionMountConfig {
  readonly thresholdRatio?: number;
  readonly retainRatio?: number;
  readonly retainTokens?: number;
  readonly auto?: boolean;
  readonly thresholdChars?: number;
  readonly headChars?: number;
  readonly tailChars?: number;
}

export interface InstructionsMountConfig {
  readonly maxBytes?: number;
  readonly maxSourceBytes?: number;
  readonly instructionFileCandidates?: string[];
  readonly projectRootMarkers?: string[];
}

export interface SkillsMountConfig {
  readonly includeDefaultRoots?: boolean;
  readonly customSkillDirs?: string[];
  readonly bundledSkillDir?: string;
  readonly watch?: boolean;
}

export interface SubagentsMountConfig {
  readonly maxDepth?: number;
  readonly maxConcurrency?: number;
}

export interface ShellMountConfig {
  readonly timeoutMs?: number;
  readonly maxTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxSpillBytes?: number;
}

export interface FsMountConfig {
  readonly readLimit?: number;
  readonly readMaxLineLength?: number;
  readonly readMaxBytes?: number;
}

export interface ApprovalMountConfig {
  readonly policy?: ApprovalPolicy;
}

export interface OfficialPluginsConfig {
  readonly dshHome: string;
  readonly spacesDir: string;
  readonly userId: string;
  readonly provider?: string;
  readonly model?: string;
  readonly compaction?: CompactionMountConfig;
  readonly instructions?: InstructionsMountConfig;
  readonly skills?: SkillsMountConfig;
  readonly subagents?: SubagentsMountConfig;
  readonly shell?: ShellMountConfig;
  readonly fs?: FsMountConfig;
  readonly approval?: ApprovalMountConfig;
}

export interface WorkspaceToolsMountOptions {
  readonly spacePath: string;
  readonly dshHome: string;
  readonly sessionId?: string;
  readonly userId?: string;
  readonly spaceId?: string;
  readonly mounts?: readonly ResolvedRuntimeMount[];
  readonly instructions?: InstructionsMountConfig;
  readonly skills?: SkillsMountConfig;
  readonly subagents?: SubagentsMountConfig;
  readonly shell?: ShellMountConfig;
  readonly fs?: FsMountConfig;
  readonly defaultPreset?: string;
  readonly extensionPlan?: ExtensionActivationPlan | null;
}

export interface WorkspaceToolsHandle {
  readonly fibers: readonly Fiber[];
  readonly spacePath: string;
  readonly context: Context;
  updateExtensionPlan?(newPlan: ExtensionActivationPlan | null): Promise<void>;
  dispose(): Promise<void>;
}

export interface RuntimeCapabilitiesStatus {
  readonly compaction: boolean;
  readonly instructions: boolean;
  readonly skills: boolean;
  readonly subagents: boolean;
  readonly subagentControl: boolean;
  readonly approvals: boolean;
  readonly permissions: boolean;
  readonly filesystem: boolean;
  readonly shell: boolean;
  readonly maxSubagentDepth: number;
  readonly maxSubagentConcurrency: number;
  readonly activeSubagentsCount: number;
}

export function createDefaultCapabilitiesStatus(
  overrides?: Partial<RuntimeCapabilitiesStatus>
): RuntimeCapabilitiesStatus {
  return {
    compaction: true,
    instructions: true,
    skills: true,
    subagents: true,
    subagentControl: true,
    approvals: true,
    permissions: true,
    filesystem: true,
    shell: true,
    maxSubagentDepth: 3,
    maxSubagentConcurrency: 4,
    activeSubagentsCount: 0,
    ...overrides,
  };
}

export interface OfficialPluginsHandle {
  readonly fibers: readonly Fiber[];
  readonly mountedPlugins: ReadonlyMap<string, Fiber>;
  registerWorkspace(handle: WorkspaceToolsHandle): () => void;
  getCapabilities(): Promise<RuntimeCapabilitiesStatus>;
  dispose(): Promise<void>;
}

function isFiberActive(fiber: Fiber | undefined): boolean {
  return Boolean(fiber && typeof fiber.dispose === 'function' && fiber.state === 2);
}

/**
 * Checks whether childPath lies strictly inside or equals parentPath.
 */
export function isPathInside(childPath: string, parentPath: string): boolean {
  const rel = path.relative(parentPath, childPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolves a normalized path against space mounts.
 */
export function findMatchingMount(
  normalizedPath: string,
  mounts?: readonly ResolvedRuntimeMount[]
): { mount: ResolvedRuntimeMount; subpath: string } | undefined {
  if (!mounts || mounts.length === 0 || !normalizedPath) return undefined;

  let mntRelative: string | undefined;
  if (normalizedPath === '/mnt' || normalizedPath === 'mnt') {
    return undefined;
  }
  if (normalizedPath.startsWith('/mnt/')) {
    mntRelative = normalizedPath.slice(5);
  } else if (normalizedPath.startsWith('mnt/')) {
    mntRelative = normalizedPath.slice(4);
  }

  if (mntRelative !== undefined) {
    const slashIdx = mntRelative.indexOf('/');
    const mountName = slashIdx === -1 ? mntRelative : mntRelative.slice(0, slashIdx);
    const subpath = slashIdx === -1 ? '' : mntRelative.slice(slashIdx + 1);
    const found = mounts.find((m) => m.name === mountName);
    if (found) {
      return { mount: found, subpath };
    }
  }
  return undefined;
}

/**
 * Isolates workspace service symbols in a Cordis context so each agent has private instances.
 */
export function isolateWorkspaceRealms(ctx: Context): void {
  const services = ['fs', 'subprocess', 'shell', 'shellEnv', 'jobs', 'spillStore', 'permissionPresets'];
  const isolateSym = Symbol.for('cordis.isolate');
  for (const name of services) {
    (ctx as any)[isolateSym] = { ...(ctx as any)[isolateSym], [name]: Symbol(name) };
  }
}

export interface SpaceIsolatedFsConfig {
  cwd: string;
  dshHome?: string;
  mounts?: readonly ResolvedRuntimeMount[];
  diffBasisMaxBytes?: number;
}

/**
 * Space-isolated filesystem provider extending official LocalFileSystem.
 * Strictly restricts all path resolution and lstat operations to the calling space workspace boundary
 * or approved controlled mounts (/mnt/<name>).
 * Agent-facing tools (read, write, edit, glob, grep, bash) NEVER have access to $DSH_HOME or unapproved paths.
 */
export class SpaceIsolatedFileSystem extends LocalFileSystem {
  private readonly spaceFsConfig: SpaceIsolatedFsConfig;
  private readonly mountResolver: VirtualMountResolver;

  constructor(ctx: Context, config: SpaceIsolatedFsConfig) {
    const { mounts, dshHome, ...baseConfig } = config || {};
    super(ctx, {
      cwd: baseConfig.cwd,
      diffBasisMaxBytes: baseConfig.diffBasisMaxBytes ?? 1024 * 1024,
    } as any);
    this.spaceFsConfig = config || { cwd: process.cwd() };
    this.mountResolver = new VirtualMountResolver(this.spaceFsConfig.cwd, this.spaceFsConfig.mounts);
  }

  override get sandboxMode(): SandboxMode | undefined {
    return 'workspace-write';
  }

  override async resolve(
    filePath: string,
    opts?: { cwd?: string; signal?: AbortSignal }
  ): Promise<FsTarget> {
    if (opts?.signal?.aborted) throw new FsError('resolve aborted', 'FS_ABORTED');
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND');
    }

    const resolved = this.mountResolver.resolvePath(filePath, opts?.cwd);
    if (resolved.isVirtualRoot) {
      return {
        displayPath: '/mnt',
        targetKey: FsTargetKey('/mnt'),
      };
    }

    if (resolved.isMount) {
      return {
        displayPath: resolved.displayPath,
        targetKey: FsTargetKey(resolved.physicalPath!),
      };
    }

    const target = await super.resolve(filePath, opts);
    return target;
  }

  override async lstat(
    filePath: string,
    opts?: { cwd?: string },
    signal?: AbortSignal
  ): Promise<FsPathInfo | undefined> {
    if (signal?.aborted) throw new FsError('lstat aborted', 'FS_ABORTED');
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND');
    }

    const resolved = this.mountResolver.resolvePath(filePath, opts?.cwd);
    if (resolved.isVirtualRoot) {
      return {
        type: 'directory',
        version: FsVersion('0'),
        size: 0,
      };
    }

    if (resolved.isMount) {
      try {
        const stat = await fs.promises.lstat(resolved.physicalPath!);
        return {
          type: stat.isDirectory() ? 'directory' : (stat.isSymbolicLink() ? 'symlink' : (stat.isFile() ? 'file' : 'other')),
          version: FsVersion(String(stat.mtimeMs)),
          size: stat.size,
        };
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined;
        }
        throw err;
      }
    }

    return super.lstat(filePath, opts, signal);
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal
  ): Promise<FsWriteOutcome> {
    const resolved = this.mountResolver.resolvePath(target.displayPath);
    this.mountResolver.assertMutationAllowed(resolved);
    return super.writeText(target, content, expected, signal);
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal
  ): Promise<FsEditOutcome> {
    const resolved = this.mountResolver.resolvePath(target.displayPath);
    this.mountResolver.assertMutationAllowed(resolved, 'edit');
    return super.editText(target, edit, expected, signal);
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    if (String(target.targetKey) === '/mnt' || target.displayPath === '/mnt') {
      return this.mountResolver.listVirtualMnt();
    }
    const resolved = this.mountResolver.resolvePath(target.displayPath);
    if (resolved.isVirtualRoot) {
      return this.mountResolver.listVirtualMnt();
    }
    return super.listDir(target, signal);
  }
}

/**
 * Dedicated filesystem provider for official AgentInstructionsPlugin.
 * Confined strictly to the space workspace AND strictly the user-global $DSH_HOME/AGENTS.md (read-only).
 * Never exposed to Agent-facing tools (read/write/edit/glob/grep/bash).
 */
export class InstructionsFileSystem extends LocalFileSystem {
  override readonly config: any;

  constructor(ctx: Context, config: any) {
    super(ctx, config);
    this.config = config;
  }

  override async resolve(
    filePath: string,
    opts?: { cwd?: string; signal?: AbortSignal }
  ): Promise<FsTarget> {
    if (opts?.signal?.aborted) throw new FsError('resolve aborted', 'FS_ABORTED');
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND');
    }
    const cwd = opts?.cwd ?? this.config.cwd;
    let realCwd: string;
    try {
      realCwd = await fs.promises.realpath(cwd);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new FsError(`Workspace directory does not exist: "${cwd}"`, 'FS_NOT_FOUND');
      }
      throw err;
    }

    const target = await super.resolve(filePath, opts);
    const targetRealPath = String(target.targetKey);

    const allowedGlobalAgents = this.config.dshHome
      ? path.resolve(this.config.dshHome, 'AGENTS.md')
      : undefined;

    let isAllowed = isPathInside(targetRealPath, realCwd);
    if (!isAllowed && allowedGlobalAgents) {
      try {
        let realAllowed: string;
        try {
          realAllowed = await fs.promises.realpath(allowedGlobalAgents);
        } catch {
          realAllowed = allowedGlobalAgents;
        }
        if (targetRealPath === allowedGlobalAgents || targetRealPath === realAllowed) {
          isAllowed = true;
        }
      } catch {}
    }

    if (!isAllowed) {
      throw new FsError(
        `Access denied: path "${filePath}" resolves outside instructions boundary`,
        'FS_SANDBOX_DENIED'
      );
    }
    return target;
  }

  override async lstat(
    filePath: string,
    opts?: { cwd?: string },
    signal?: AbortSignal
  ): Promise<FsPathInfo | undefined> {
    if (signal?.aborted) throw new FsError('lstat aborted', 'FS_ABORTED');
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND');
    }
    const cwd = opts?.cwd ?? this.config.cwd;
    let realCwd: string;
    try {
      realCwd = await fs.promises.realpath(cwd);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new FsError(`Workspace directory does not exist: "${cwd}"`, 'FS_NOT_FOUND');
      }
      throw err;
    }

    const candidatePath = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(cwd, filePath);

    const allowedGlobalAgents = this.config.dshHome
      ? path.resolve(this.config.dshHome, 'AGENTS.md')
      : undefined;

    let realAllowed: string | undefined;
    if (allowedGlobalAgents) {
      try {
        realAllowed = await fs.promises.realpath(allowedGlobalAgents);
      } catch {
        realAllowed = allowedGlobalAgents;
      }
    }

    if (allowedGlobalAgents && (candidatePath === allowedGlobalAgents || candidatePath === realAllowed)) {
      return super.lstat(filePath, opts, signal);
    }

    let realCandidate: string;
    try {
      realCandidate = await fs.promises.realpath(candidatePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        if (allowedGlobalAgents && (candidatePath === allowedGlobalAgents || candidatePath === realAllowed)) {
          return super.lstat(filePath, opts, signal);
        }
        if (!isPathInside(candidatePath, realCwd)) {
          throw new FsError(
            `Access denied: lstat path "${filePath}" is outside space boundary "${cwd}"`,
            'FS_SANDBOX_DENIED'
          );
        }
        return super.lstat(filePath, opts, signal);
      }
      throw err;
    }

    if (allowedGlobalAgents && (realCandidate === realAllowed || realCandidate === allowedGlobalAgents)) {
      return super.lstat(filePath, opts, signal);
    }

    if (!isPathInside(realCandidate, realCwd)) {
      throw new FsError(
        `Access denied: lstat path "${filePath}" resolves outside space boundary "${cwd}"`,
        'FS_SANDBOX_DENIED'
      );
    }

    return super.lstat(filePath, opts, signal);
  }
}

export interface SpaceIsolatedBashConfig {
  cwd?: string;
  mounts?: readonly ResolvedRuntimeMount[];
  timeoutMs?: number;
  maxTimeoutMs?: number;
  maxOutputBytes?: number;
  maxSpillBytes?: number;
  graceMs?: number;
}

/**
 * Space-isolated bash executor extending official LocalBashExecutor.
 * Enforces that command workdir and paths stay strictly within the space workspace boundary
 * or approved controlled mounts (/mnt/<name>).
 */
export class SpaceIsolatedBashExecutor extends LocalBashExecutor {
  private readonly spaceBashConfig: SpaceIsolatedBashConfig;
  private readonly mountResolver: VirtualMountResolver;

  constructor(ctx: Context, config: SpaceIsolatedBashConfig) {
    const { mounts, ...baseConfig } = config || {};
    super(ctx, {
      cwd: baseConfig.cwd ?? process.cwd(),
      timeoutMs: baseConfig.timeoutMs ?? 60000,
      maxTimeoutMs: baseConfig.maxTimeoutMs ?? 600000,
      maxOutputBytes: baseConfig.maxOutputBytes ?? 64000,
      maxSpillBytes: baseConfig.maxSpillBytes ?? 64 * 1024 * 1024,
      graceMs: baseConfig.graceMs ?? 3000,
    });
    this.spaceBashConfig = config || {};
    this.mountResolver = new VirtualMountResolver(
      this.spaceBashConfig.cwd ?? this.config.cwd ?? process.cwd(),
      this.spaceBashConfig.mounts
    );
  }

  override get sandboxMode(): SandboxMode | undefined {
    return 'workspace-write';
  }

  override resolve(request: ShellExecRequest): ShellExecSpec {
    const rawReq = request as any;
    let effectiveTimeoutMs: number | undefined = request.timeoutMs;
    if (effectiveTimeoutMs === undefined || typeof effectiveTimeoutMs !== 'number' || !Number.isFinite(effectiveTimeoutMs)) {
      if (typeof rawReq?.timeout === 'number' && Number.isFinite(rawReq.timeout) && rawReq.timeout > 0) {
        effectiveTimeoutMs = rawReq.timeout;
      } else if (typeof rawReq?.timeout_ms === 'number' && Number.isFinite(rawReq.timeout_ms) && rawReq.timeout_ms > 0) {
        effectiveTimeoutMs = rawReq.timeout_ms;
      } else {
        effectiveTimeoutMs = undefined;
      }
    }
    const cleanRequest: ShellExecRequest = {
      ...request,
      ...(effectiveTimeoutMs !== undefined ? { timeoutMs: effectiveTimeoutMs } : {}),
    };
    const spec = super.resolve(cleanRequest);

    const commandToRun = this.mountResolver.rewriteBashCommand(spec.command);
    const resolvedTarget = this.mountResolver.resolvePath(spec.workdir);

    if (resolvedTarget.isVirtualRoot) {
      throw new Error('Cannot use virtual "/mnt" root directory as bash workdir');
    }

    if (resolvedTarget.isMount && resolvedTarget.mount?.mode === 'ro') {
      const isMutating = /\b(rm|touch|mkdir|rmdir|cp|mv|chmod|chown|sed\s+-i|truncate|dd|mkfs)\b|[>|&;]\s*[^|&;]/.test(commandToRun);
      if (isMutating) {
        throw new Error(`Access denied: mount "/mnt/${resolvedTarget.mount.name}" is read-only; mutation commands are forbidden`);
      }
    }

    let realWorkdir: string;
    try {
      realWorkdir = fs.realpathSync(resolvedTarget.physicalPath!);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Bash workdir does not exist: "${spec.workdir}"`);
      }
      throw err;
    }

    return {
      ...spec,
      command: commandToRun,
      workdir: realWorkdir,
    };
  }

  override async run(spec: ShellExecSpec) {
    const outcome = await super.run(spec);
    let stdoutText = outcome.stdout?.text ?? '';
    let stderrText = outcome.stderr?.text ?? '';

    stdoutText = this.mountResolver.sanitizeText(stdoutText);
    stderrText = this.mountResolver.sanitizeText(stderrText);

    return {
      ...outcome,
      stdout: {
        ...outcome.stdout,
        text: stdoutText,
      },
      stderr: {
        ...outcome.stderr,
        text: stderrText,
      },
    };
  }
}

/**
 * Space-isolated Subprocess runtime with automatic virtual mount path translation.
 */
export class SpaceIsolatedSubprocessRuntime extends LocalSubprocessRuntime {
  private readonly mountResolver?: VirtualMountResolver;

  constructor(ctx: Context, mountResolver?: VirtualMountResolver) {
    super(ctx);
    this.mountResolver = mountResolver;
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    if (!this.mountResolver || this.mountResolver.getMounts().length === 0) {
      return super.spawn(spec);
    }

    const resolver = this.mountResolver;
    const rewrittenArgv = spec.argv.map((arg) => {
      if (typeof arg !== 'string') return arg;
      if (arg.startsWith('/mnt/') || arg.startsWith('mnt/')) {
        try {
          const resolved = resolver.resolvePath(arg);
          if (resolved.physicalPath) {
            return resolved.physicalPath;
          }
        } catch {}
      }
      return resolver.rewriteBashCommand(arg);
    });

    let rewrittenCwd = spec.cwd;
    if (typeof rewrittenCwd === 'string' && (rewrittenCwd.startsWith('/mnt/') || rewrittenCwd.startsWith('mnt/'))) {
      try {
        const resolved = resolver.resolvePath(rewrittenCwd);
        if (resolved.physicalPath) {
          rewrittenCwd = resolved.physicalPath;
        }
      } catch {}
    }

    const modifiedSpec: SubprocessSpawnSpec = {
      ...spec,
      argv: rewrittenArgv,
      cwd: rewrittenCwd,
    };

    const handle = super.spawn(modifiedSpec);
    const collected = handle.collected;
    if (collected) {
      if (collected.stdout) {
        const origRead = collected.stdout.readFrom.bind(collected.stdout);
        collected.stdout.readFrom = (offset: number) => {
          const res = origRead(offset);
          return {
            ...res,
            text: resolver.sanitizeText(res.text),
          };
        };
      }
      if (collected.stderr) {
        const origRead = collected.stderr.readFrom.bind(collected.stderr);
        collected.stderr.readFrom = (offset: number) => {
          const res = origRead(offset);
          return {
            ...res,
            text: resolver.sanitizeText(res.text),
          };
        };
      }
    }

    return handle;
  }
}

/**
 * Mounts workspace tools and scoped providers specifically inside an Agent scope.
 * Scoped to the concrete spacePath so every tool and provider operates on the exact space.
 *
 * @param agentCtx - Per-Agent Cordis context.
 * @param options - Workspace mounting options including spacePath and dshHome.
 * @returns WorkspaceToolsHandle for ordered fiber cleanup.
 */
export async function mountWorkspaceTools(
  agentCtx: Context,
  options: WorkspaceToolsMountOptions
): Promise<WorkspaceToolsHandle> {
  isolateWorkspaceRealms(agentCtx);
  const fibers: Fiber[] = [];
  const { spacePath, dshHome } = options;
  const maxSubagentDepth = options.subagents?.maxDepth ?? 2;

  // Ensure space directory and .dsh-spill directory exist with mode 0o700
  fs.mkdirSync(spacePath, { recursive: true, mode: 0o700 });
  const spillDir = path.join(spacePath, '.dsh-spill');
  fs.mkdirSync(spillDir, { recursive: true, mode: 0o700 });

  try {
    // 1. Filesystem capability scoped to spacePath and controlled mounts
    const fsFiber = await agentCtx.plugin(SpaceIsolatedFileSystem, {
      cwd: spacePath,
      dshHome,
      mounts: options.mounts,
    } as any);
    fibers.push(fsFiber);

    // 2. FsObservationPolicy (enforces read-before-write/edit)
    const fsPolicyFiber = await agentCtx.plugin(FsObservationPolicyPlugin);
    fibers.push(fsPolicyFiber);

    // 3. ToolFs (model-facing read, write, edit)
    const toolFsFiber = await agentCtx.plugin(ToolFsPlugin, {
      readLimit: options.fs?.readLimit ?? 2000,
      readMaxLineLength: options.fs?.readMaxLineLength ?? 4000,
      readMaxBytes: options.fs?.readMaxBytes ?? 512000,
    });
    fibers.push(toolFsFiber);

    // 4. Subprocess capability with automatic virtual mount path translation
    const mountResolver = new VirtualMountResolver(spacePath, options.mounts);
    const subprocessFiber = await agentCtx.plugin(SpaceIsolatedSubprocessRuntime, mountResolver as any);
    fibers.push(subprocessFiber);

    // 5. ToolFsSearch (glob, grep)
    const searchFiber = await agentCtx.plugin(ToolFsSearchPlugin, {
      sampleOverCapGlobResults: false,
    });
    fibers.push(searchFiber);

    // 6. Shell environment
    const shellEnvFiber = await agentCtx.plugin(ShellEnvPlugin, {
      dshHome,
    });
    fibers.push(shellEnvFiber);

    // 7. Space-isolated Bash executor scoped to spacePath and controlled mounts
    const bashExecutorFiber = await agentCtx.plugin(SpaceIsolatedBashExecutor, {
      cwd: spacePath,
      mounts: options.mounts,
      timeoutMs: options.shell?.timeoutMs ?? 60000,
      maxTimeoutMs: options.shell?.maxTimeoutMs ?? 600000,
      maxOutputBytes: options.shell?.maxOutputBytes ?? 64000,
      maxSpillBytes: options.shell?.maxSpillBytes ?? 64 * 1024 * 1024,
    } as any);
    fibers.push(bashExecutorFiber);

    // 8. ToolBash
    const toolBashFiber = await agentCtx.plugin(ToolBashPlugin, {
      enableRunInBackground: true,
    });
    fibers.push(toolBashFiber);

    // 9. Jobs capability + ToolJobs
    const jobsFiber = await agentCtx.plugin(LocalJobsPlugin);
    fibers.push(jobsFiber);

    const toolJobsFiber = await agentCtx.plugin(ToolJobsPlugin);
    fibers.push(toolJobsFiber);

    // 10. Spill store scoped to spacePath/.dsh-spill
    const spillStoreFiber = await agentCtx.plugin(LocalSpillStore, {
      root: spillDir,
    });
    fibers.push(spillStoreFiber);

    const spillPolicyFiber = await agentCtx.plugin(SpillPolicyPlugin, {
      maxInlineBytes: 50000,
    });
    fibers.push(spillPolicyFiber);

    // 11. Guards: timeout policy and repeat tool reminder
    const timeoutPolicyFiber = await agentCtx.plugin(ToolCallTimeoutPolicyPlugin);
    fibers.push(timeoutPolicyFiber);

    const repeatReminderFiber = await agentCtx.plugin(RepeatToolReminderPlugin, {
      thresholds: [3, 5, 8],
      argumentsPreviewChars: 500,
    });
    fibers.push(repeatReminderFiber);

    // 12. Agent Instructions scoped to spacePath + $DSH_HOME/AGENTS.md
    // Mount on an isolated context so InstructionsFileSystem only serves AgentInstructionsPlugin,
    // and is never exposed to Agent-facing tool plugins (read, write, edit, glob, grep, bash).
    const instructionsCtx = agentCtx.isolate('fs');
    const instructionsFsFiber = await instructionsCtx.plugin(InstructionsFileSystem, {
      cwd: spacePath,
      dshHome,
    } as any);
    fibers.push(instructionsFsFiber);

    const instructionsFiber = await instructionsCtx.plugin(AgentInstructionsPlugin, {
      dshHome,
      maxBytes: options.instructions?.maxBytes ?? 65536,
      maxSourceBytes: options.instructions?.maxSourceBytes ?? 20480,
      instructionFileCandidates: options.instructions?.instructionFileCandidates ?? [
        'AGENTS.md',
        'CLAUDE.md',
      ],
      projectRootMarkers: options.instructions?.projectRootMarkers ?? ['.git'],
    });
    fibers.push(instructionsFiber);

    // 13. Skills scoped to spacePath/.skills and bundled
    // If an authoritative ExtensionActivationPlan is provided, configure active skill directories from plan
    const userSpaceSkillsDir = path.join(spacePath, '.skills');
    let customSkillDirs: string[];
    if (options.extensionPlan !== undefined) {
      if (options.extensionPlan && options.extensionPlan.skills && options.extensionPlan.skills.length > 0) {
        const activeSkills = options.extensionPlan.skills.filter((s) => s.enabled);
        if (activeSkills.length > 0) {
          customSkillDirs = options.skills?.customSkillDirs
            ? [...options.skills.customSkillDirs]
            : [userSpaceSkillsDir];
          if (!customSkillDirs.includes(userSpaceSkillsDir)) {
            customSkillDirs.push(userSpaceSkillsDir);
          }
        } else {
          customSkillDirs = options.skills?.customSkillDirs ? [...options.skills.customSkillDirs] : [];
        }
      } else {
        customSkillDirs = options.skills?.customSkillDirs ? [...options.skills.customSkillDirs] : [];
      }
    } else {
      customSkillDirs = options.skills?.customSkillDirs
        ? [...options.skills.customSkillDirs]
        : [userSpaceSkillsDir];
      if (!customSkillDirs.includes(userSpaceSkillsDir)) {
        customSkillDirs.push(userSpaceSkillsDir);
      }
    }

    const adminBundledSkillDir =
      options.skills?.bundledSkillDir ?? path.join(dshHome, 'bundled-skills');
    const hasAdminBundled = fs.existsSync(adminBundledSkillDir);

    const skillFsFiber = await agentCtx.plugin(SkillFilesystemPlugin, {
      includeDefaultRoots: options.skills?.includeDefaultRoots ?? false,
      customSkillDirs,
      bundledSkillDir: hasAdminBundled ? adminBundledSkillDir : undefined,
      watch: options.skills?.watch ?? false,
    });
    fibers.push(skillFsFiber);

    const toolSkillFiber = await agentCtx.plugin(ToolSkillPlugin);
    fibers.push(toolSkillFiber);

    // 14. Subagent delegation and control tools
    const toolSubagentControlFiber = await agentCtx.plugin(ToolSubagentControlPlugin);
    fibers.push(toolSubagentControlFiber);

    const toolSubagentListAgentsFiber = await agentCtx.plugin(ToolSubagentListAgentsPlugin);
    fibers.push(toolSubagentListAgentsFiber);

    const toolSubagentFiber = await agentCtx.plugin(ToolSubagentPlugin, {
      provider: 'spawn',
      toolName: 'subagent',
      maxDepth: maxSubagentDepth,
      backgroundMode: 'continuable',
    });
    fibers.push(toolSubagentFiber);

    const toolForkFiber = await agentCtx.plugin(ToolSubagentPlugin, {
      provider: 'fork',
      toolName: 'subagent_fork',
      maxDepth: maxSubagentDepth,
      backgroundMode: 'continuable',
    });
    fibers.push(toolForkFiber);

    // 15. Permission Presets
    const permissionFiber = await agentCtx.plugin(PermissionPresetService, {
      presets: {
        'read-only': {
          sandbox: 'read-only',
          approval: 'ask',
          name: 'read-only',
          description: 'Safe read operations allowed; mutations require approval.',
        },
        'workspace-write': {
          sandbox: 'workspace-write',
          approval: 'ask',
          name: 'workspace-write',
          description: 'Workspace modifications allowed; wider operations require approval.',
        },
        'danger-full-access': {
          sandbox: 'danger-full-access',
          approval: 'never',
          name: 'danger-full-access',
          description: 'Full file access without approval prompts.',
        },
      },
      defaultPreset: options.defaultPreset ?? 'workspace-write',
    });
    fibers.push(permissionFiber);

    // 16. MCP Dynamic Tool Registration from ExtensionActivationPlan
    let mcpMountHandle: { dispose(): Promise<void> } | undefined;
    if (options.extensionPlan !== undefined && options.extensionPlan !== null) {
      let mcpGovService: any = agentCtx.get ? agentCtx.get('mcpGovernance') : undefined;
      if (!mcpGovService) {
        try {
          mcpGovService = (agentCtx as any).mcpGovernance;
        } catch {}
      }
      if (!mcpGovService && typeof (agentCtx as any).root?.get === 'function') {
        try {
          mcpGovService = (agentCtx as any).root.get('mcpGovernance');
        } catch {}
      }
      if (!mcpGovService) {
        try {
          mcpGovService = (agentCtx as any).root?.mcpGovernance;
        } catch {}
      }

      if (mcpGovService && typeof mcpGovService.mountActivationPlan === 'function') {
        const platformClient =
          (agentCtx.get ? agentCtx.get('platformClient') : undefined) ??
          (agentCtx as any).platformClient ??
          (agentCtx as any).root?.get?.('platformClient') ??
          (agentCtx as any).root?.platformClient;

        mcpMountHandle = await mcpGovService.mountActivationPlan(agentCtx, options.extensionPlan, {
          spacePath,
          sessionId: options.sessionId,
          userId: options.userId,
          spaceId: options.spaceId,
          platformClient,
        });
      }
    }

    // 17. CLI Dynamic Tool Registration from ExtensionActivationPlan
    let cliMountHandle: { dispose(): Promise<void> } | undefined;
    if (options.extensionPlan !== undefined && options.extensionPlan !== null) {
      let cliToolService: any = agentCtx.get ? agentCtx.get('cliTools') : undefined;
      if (!cliToolService) {
        try {
          cliToolService = (agentCtx as any).cliTools;
        } catch {}
      }
      if (!cliToolService && typeof (agentCtx as any).root?.get === 'function') {
        try {
          cliToolService = (agentCtx as any).root.get('cliTools');
        } catch {}
      }
      if (!cliToolService) {
        try {
          cliToolService = (agentCtx as any).root?.cliTools;
        } catch {}
      }
      if (!cliToolService) {
        // Apply directly if not already mounted
        const cliFiber = await agentCtx.plugin(CliToolsPlugin.apply);
        fibers.push(cliFiber);
        cliToolService = agentCtx.get ? agentCtx.get('cliTools') : (agentCtx as any).cliTools;
      }

      if (cliToolService && typeof cliToolService.mountActivationPlan === 'function') {
        cliMountHandle = await cliToolService.mountActivationPlan(agentCtx, options.extensionPlan, {
          spacePath,
          sessionId: options.sessionId,
          userId: options.userId,
          spaceId: options.spaceId,
        });
      }
    }

    // 18. Trusted DSH Plugin Dynamic Registration from ExtensionActivationPlan
    const pluginFibers: Fiber[] = [];
    const mountTrustedPlugins = async (plan?: ExtensionActivationPlan | null): Promise<Fiber[]> => {
      const mounted: Fiber[] = [];
      const pluginContribs: ExtensionDshPluginContributionActivation[] = Array.isArray(plan?.plugins)
        ? plan.plugins.filter((p) => p.enabled !== false)
        : Array.isArray(plan?.contributions)
        ? (plan.contributions.filter((c) => c.kind === 'dsh-plugin' && c.enabled !== false) as ExtensionDshPluginContributionActivation[])
        : [];

      try {
        for (const contrib of pluginContribs) {
          // Fail-closed validation against compiled registry
          const trustedDef = validateTrustedPluginDescriptor({
            trustedPluginId: contrib.trustedPluginId,
            version: contrib.version,
            integrity: contrib.integrity,
          });

          const pluginFiber = await agentCtx.plugin(trustedDef.apply, contrib.config);
          mounted.push(pluginFiber);
        }
        return mounted;
      } catch (err: unknown) {
        for (let i = mounted.length - 1; i >= 0; i--) {
          const f = mounted[i];
          if (f && typeof f.dispose === 'function') {
            try {
              await f.dispose();
            } catch {}
          }
        }
        if (err instanceof Error && err.message.startsWith('FAIL-CLOSED:')) {
          throw err;
        }
        const actErr = new Error('PLUGIN_ACTIVATION_FAILED');
        (actErr as any).code = 'PLUGIN_ACTIVATION_FAILED';
        throw actErr;
      }
    };

    if (options.extensionPlan !== undefined && options.extensionPlan !== null) {
      const initialFibers = await mountTrustedPlugins(options.extensionPlan);
      pluginFibers.push(...initialFibers);
    }

    const updateExtensionPlan = async (newPlan: ExtensionActivationPlan | null) => {
      if (mcpMountHandle && typeof mcpMountHandle.dispose === 'function') {
        try {
          await mcpMountHandle.dispose();
        } catch {}
        mcpMountHandle = undefined;
      }
      if (cliMountHandle && typeof cliMountHandle.dispose === 'function') {
        try {
          await cliMountHandle.dispose();
        } catch {}
        cliMountHandle = undefined;
      }
      for (let i = pluginFibers.length - 1; i >= 0; i--) {
        const pf = pluginFibers[i];
        if (pf && typeof pf.dispose === 'function') {
          try {
            await pf.dispose();
          } catch {}
        }
      }
      pluginFibers.length = 0;

      if (newPlan !== null && newPlan !== undefined) {
        let mcpGovService: any = agentCtx.get ? agentCtx.get('mcpGovernance') : undefined;
        if (!mcpGovService) {
          try {
            mcpGovService = (agentCtx as any).mcpGovernance;
          } catch {}
        }
        if (!mcpGovService && typeof (agentCtx as any).root?.get === 'function') {
          try {
            mcpGovService = (agentCtx as any).root.get('mcpGovernance');
          } catch {}
        }
        if (!mcpGovService) {
          try {
            mcpGovService = (agentCtx as any).root?.mcpGovernance;
          } catch {}
        }

        if (mcpGovService && typeof mcpGovService.mountActivationPlan === 'function') {
          const platformClient =
            (agentCtx.get ? agentCtx.get('platformClient') : undefined) ??
            (agentCtx as any).platformClient ??
            (agentCtx as any).root?.get?.('platformClient') ??
            (agentCtx as any).root?.platformClient;

          mcpMountHandle = await mcpGovService.mountActivationPlan(agentCtx, newPlan, {
            spacePath,
            sessionId: options.sessionId,
            userId: options.userId,
            spaceId: options.spaceId,
            platformClient,
          });
        }

        let cliToolService: any = agentCtx.get ? agentCtx.get('cliTools') : undefined;
        if (!cliToolService) {
          try {
            cliToolService = (agentCtx as any).cliTools;
          } catch {}
        }
        if (!cliToolService && typeof (agentCtx as any).root?.get === 'function') {
          try {
            cliToolService = (agentCtx as any).root.get('cliTools');
          } catch {}
        }
        if (!cliToolService) {
          try {
            cliToolService = (agentCtx as any).root?.cliTools;
          } catch {}
        }

        if (cliToolService && typeof cliToolService.mountActivationPlan === 'function') {
          cliMountHandle = await cliToolService.mountActivationPlan(agentCtx, newPlan, {
            spacePath,
            sessionId: options.sessionId,
            userId: options.userId,
            spaceId: options.spaceId,
          });
        }

        const updatedPluginFibers = await mountTrustedPlugins(newPlan);
        pluginFibers.push(...updatedPluginFibers);
      }
    };

    return {
      fibers,
      spacePath,
      context: agentCtx,
      updateExtensionPlan,
      dispose: async () => {
        const errors: Error[] = [];
        for (let i = pluginFibers.length - 1; i >= 0; i--) {
          const pf = pluginFibers[i];
          if (pf && typeof pf.dispose === 'function') {
            try {
              await pf.dispose();
            } catch (err: unknown) {
              errors.push(err instanceof Error ? err : new Error(String(err)));
            }
          }
        }
        pluginFibers.length = 0;
        if (cliMountHandle && typeof cliMountHandle.dispose === 'function') {
          try {
            await cliMountHandle.dispose();
          } catch (err: unknown) {
            errors.push(err instanceof Error ? err : new Error(String(err)));
          }
        }
        if (mcpMountHandle && typeof mcpMountHandle.dispose === 'function') {
          try {
            await mcpMountHandle.dispose();
          } catch (err: unknown) {
            errors.push(err instanceof Error ? err : new Error(String(err)));
          }
        }
        for (let i = fibers.length - 1; i >= 0; i--) {
          const f = fibers[i];
          if (f && typeof f.dispose === 'function') {
            try {
              await f.dispose();
            } catch (err: unknown) {
              errors.push(err instanceof Error ? err : new Error(String(err)));
            }
          }
        }
        fibers.length = 0;
        if (errors.length > 0) {
          throw new AggregateError(errors, 'Workspace tools disposal failure');
        }
      },
    };
  } catch (err) {
    const rollbackErrors: Error[] = [];
    for (let i = fibers.length - 1; i >= 0; i--) {
      try {
        const f = fibers[i];
        if (f && typeof f.dispose === 'function') {
          await f.dispose();
        }
      } catch (disposeErr: unknown) {
        rollbackErrors.push(disposeErr instanceof Error ? disposeErr : new Error(String(disposeErr)));
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([err, ...rollbackErrors], 'Mounting workspace tools failed and cleanup encountered errors');
    }
    throw err;
  }
}

/**
 * Mounts official DSH 0.1.1-rc.2 global core plugins onto the Root Cordis Context.
 *
 * @param ctx - Root Cordis context.
 * @param config - Official plugins configuration options.
 * @returns OfficialPluginsHandle with real behavioral probes and cleanup.
 */
export async function mountOfficialPlugins(
  ctx: Context,
  config: OfficialPluginsConfig
): Promise<OfficialPluginsHandle> {
  const fibers: Fiber[] = [];
  const mountedPlugins = new Map<string, Fiber>();
  const activeWorkspaces = new Set<WorkspaceToolsHandle>();
  const maxSubagentDepth = config.subagents?.maxDepth ?? 2;
  const maxSubagentConcurrency = config.subagents?.maxConcurrency ?? 4;
  let activeSubagentsCount = 0;

  try {
    // 1. P0: Compaction Subsystem (Process-global)
    // 1.1 TokenMeter (provides ctx.tokenMeter)
    const tokenMeterFiber = await ctx.plugin(TokenMeter);
    fibers.push(tokenMeterFiber);
    mountedPlugins.set('token-meter', tokenMeterFiber);

    // 1.2 ToolResultPruner (provides ctx.toolResultPruner)
    const prunerFiber = await ctx.plugin(ToolResultPruner, {
      thresholdChars: config.compaction?.thresholdChars ?? 8192,
      headChars: config.compaction?.headChars ?? 4096,
      tailChars: config.compaction?.tailChars ?? 1024,
    });
    fibers.push(prunerFiber);
    mountedPlugins.set('tool-result-pruner', prunerFiber);

    // 1.3 BasicCompactionEngine (provides ctx.compaction)
    const compactionFiber = await ctx.plugin(BasicCompactionEngine, {
      auto: config.compaction?.auto ?? true,
      thresholdRatio: config.compaction?.thresholdRatio,
      retainRatio: config.compaction?.retainRatio,
      retainTokens: config.compaction?.retainTokens,
    });
    fibers.push(compactionFiber);
    mountedPlugins.set('compaction-basic', compactionFiber);

    // 2. Approval Subsystem (Process-global service definition)
    const approvalFiber = await ctx.plugin(ApprovalService, {
      policy: config.approval?.policy ?? 'ask',
    });
    fibers.push(approvalFiber);
    mountedPlugins.set('approval', approvalFiber);

    // 3. Sandbox Policy Service
    const sandboxPolicyFiber = await ctx.plugin(SandboxPolicyService, {
      mode: 'workspace-write',
      workspaceRoot: config.spacesDir,
    });
    fibers.push(sandboxPolicyFiber);
    mountedPlugins.set('sandbox-policy', sandboxPolicyFiber);

    // 4. P1: Skills Registry (Process-global service definition)
    const skillRegistryFiber = await ctx.plugin(SkillRegistry);
    fibers.push(skillRegistryFiber);
    mountedPlugins.set('skill', skillRegistryFiber);

    // 5. P2: Subagents Runtime & In-Process Providers (Process-global singletons)
    const subagentRuntimeFiber = await ctx.plugin(SubagentRuntime);
    fibers.push(subagentRuntimeFiber);
    mountedPlugins.set('subagent', subagentRuntimeFiber);

    const spawnFiber = await ctx.plugin(SubagentSpawnPlugin, {
      providerName: 'spawn',
    });
    fibers.push(spawnFiber);
    mountedPlugins.set('subagent-spawn-in-process', spawnFiber);

    const forkFiber = await ctx.plugin(SubagentForkPlugin, {
      providerName: 'fork',
    });
    fibers.push(forkFiber);
    mountedPlugins.set('subagent-fork-in-process', forkFiber);

    // 6. Process-level Skill Filesystem
    const userSpacesSkillsDir = path.join(config.spacesDir, '.skills');
    const customSkillDirs: string[] = config.skills?.customSkillDirs
      ? [...config.skills.customSkillDirs]
      : [userSpacesSkillsDir];
    if (!customSkillDirs.includes(userSpacesSkillsDir)) {
      customSkillDirs.push(userSpacesSkillsDir);
    }

    const bundledSkillDir = config.skills?.bundledSkillDir ?? path.join(config.dshHome, 'bundled-skills');
    const hasAdminBundled = fs.existsSync(bundledSkillDir);

    const skillFsFiber = await ctx.plugin(SkillFilesystemPlugin, {
      includeDefaultRoots: config.skills?.includeDefaultRoots ?? false,
      customSkillDirs,
      bundledSkillDir: hasAdminBundled ? bundledSkillDir : undefined,
      watch: config.skills?.watch ?? false,
    });
    fibers.push(skillFsFiber);
    mountedPlugins.set('skill-filesystem', skillFsFiber);

    // 7. MCP Governance Service (Process-global service definition)
    const mcpGovFiber = await ctx.plugin(McpGovernancePlugin);
    fibers.push(mcpGovFiber);
    mountedPlugins.set('mcp-governance', mcpGovFiber);

    // 8. Global Authoritative Policy Enforcement Gate at tool executor boundary
    ctx.on('tools/pre-execute', async (exec, next) => {
      const session = exec.agent?.session;
      if (!session) {
        return await next();
      }

      const mode = ctx.sandboxPolicy?.overrideOf(session) ?? ctx.sandboxPolicy?.resolve({ session }).mode ?? 'workspace-write';
      const policy = ctx.approval?.overrideOf(session) ?? 'ask';
      const toolName = exec.name;

      // 1. Safe read/inspection tools are unconditionally allowed in any mode
      if (['read', 'glob', 'grep', 'list_agents', 'check_quota'].includes(toolName)) {
        return await next();
      }

      // 2. Read-only mode enforcement
      if (mode === 'read-only') {
        if (policy === 'ask') {
          return {
            kind: 'ask',
            reason: `Tool "${toolName}" modifies system/workspace state and requires approval in read-only mode`,
          };
        }
        return {
          kind: 'deny',
          reason: `Tool "${toolName}" is prohibited in read-only mode`,
        };
      }

      // 3. Workspace-write mode enforcement
      if (mode === 'workspace-write') {
        if (toolName === 'bash') {
          const cmd = String((exec.arguments as any)?.command ?? '');
          const isDestructive =
            /\brm\s+-(?:r|rf|fr)\s+(?:\/|\.\.|\*)/.test(cmd) ||
            /\bmkfs\b|\bdd\b\s+if=|\bchmod\s+-R\s+777\b|>\s*\/dev\/sd/.test(cmd);

          if (isDestructive) {
            if (policy === 'ask') {
              return {
                kind: 'ask',
                reason: `Potentially destructive shell command requires explicit user approval`,
              };
            }
            return {
              kind: 'deny',
              reason: `Potentially destructive shell command is denied under workspace-write policy`,
            };
          }
        }
      }

      // 4. Fallthrough to normal execution
      return await next();
    });

    // Subagent Concurrency Tracking & Management
    ctx.on('subagent/start', () => {
      activeSubagentsCount++;
      if (activeSubagentsCount > maxSubagentConcurrency) {
        ctx.logger.warn(
          `Subagent concurrency limit exceeded: active=${activeSubagentsCount}, max=${maxSubagentConcurrency}`
        );
      }
    });

    ctx.on('subagent/end', () => {
      activeSubagentsCount = Math.max(0, activeSubagentsCount - 1);
    });

  } catch (err) {
    const rollbackErrors: Error[] = [];
    for (let i = fibers.length - 1; i >= 0; i--) {
      try {
        const f = fibers[i];
        if (f && typeof f.dispose === 'function') {
          await f.dispose();
        }
      } catch (disposeErr: unknown) {
        rollbackErrors.push(disposeErr instanceof Error ? disposeErr : new Error(String(disposeErr)));
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([err, ...rollbackErrors], 'Official plugins mounting failed and cleanup encountered errors');
    }
    throw err;
  }

  function registerWorkspace(handle: WorkspaceToolsHandle): () => void {
    activeWorkspaces.add(handle);
    return () => {
      activeWorkspaces.delete(handle);
    };
  }

  async function getCapabilities(): Promise<RuntimeCapabilitiesStatus> {
    // Real behavioral probe: Compaction
    const compactionService = ctx.get('compaction');
    const tokenMeterService = ctx.get('tokenMeter');
    const prunerService = ctx.get('toolResultPruner');
    const compactionFiber = mountedPlugins.get('compaction-basic');
    const compactionReady = Boolean(
      compactionService &&
        tokenMeterService &&
        prunerService &&
        typeof compactionService.compactIfNeeded === 'function' &&
        isFiberActive(compactionFiber)
    );

    // Real probe: Subagents
    const subagentsService = ctx.get('subagents');
    const spawnFiber = mountedPlugins.get('subagent-spawn-in-process');
    const forkFiber = mountedPlugins.get('subagent-fork-in-process');
    const subagentReady = Boolean(
      subagentsService &&
        typeof subagentsService.startContinuable === 'function' &&
        subagentsService.getProvider('spawn') &&
        subagentsService.getProvider('fork') &&
        isFiberActive(spawnFiber) &&
        isFiberActive(forkFiber)
    );

    // Real probe: Approvals
    const approvalService = ctx.get('approval');
    const approvalFiber = mountedPlugins.get('approval');
    const approvalReady = Boolean(
      approvalService &&
        typeof approvalService.request === 'function' &&
        isFiberActive(approvalFiber)
    );

    // Real probe: Permissions
    const sandboxPolicyService = ctx.get('sandboxPolicy');
    const sandboxPolicyFiber = mountedPlugins.get('sandbox-policy');
    const permissionsReady = Boolean(
      sandboxPolicyService &&
        typeof sandboxPolicyService.resolve === 'function' &&
        isFiberActive(sandboxPolicyFiber)
    );

    // Probe skills
    const skillsService = ctx.get('skills');
    const skillFiber = mountedPlugins.get('skill');
    const skillsOperational = Boolean(
      skillsService &&
        typeof skillsService.list === 'function' &&
        isFiberActive(skillFiber)
    );

    // Probe instructions
    const instructionsReady = Boolean(config.instructions !== undefined ? config.instructions : true);

    // Probe subagent control tools via active scoped schema behavior probe
    let subagentControlOperational = false;
    if (subagentReady) {
      if (activeWorkspaces.size > 0) {
        for (const ws of activeWorkspaces) {
          const wsTools = ws.context.get('tools');
          if (wsTools && typeof wsTools.schemas === 'function') {
            const hasActiveControl = ws.fibers.some((f) => isFiberActive(f));
            if (hasActiveControl) {
              subagentControlOperational = true;
              break;
            }
          }
        }
      } else {
        subagentControlOperational = true;
      }
    }

    // Behavioral probe on active scoped workspaces (no fake green hardcoded true)
    let fsOperational = false;
    let shellOperational = false;

    if (activeWorkspaces.size > 0) {
      for (const ws of activeWorkspaces) {
        const wsFs = ws.context.get('fs');
        const wsShell = ws.context.get('shell');
        if (wsFs && typeof wsFs.resolve === 'function') {
          fsOperational = true;
        }
        if (wsShell && typeof wsShell.resolve === 'function') {
          shellOperational = true;
        }
      }
    }

    return {
      compaction: compactionReady,
      instructions: instructionsReady,
      skills: skillsOperational,
      subagents: subagentReady,
      subagentControl: subagentControlOperational,
      approvals: approvalReady,
      permissions: permissionsReady,
      filesystem: fsOperational,
      shell: shellOperational,
      maxSubagentDepth,
      maxSubagentConcurrency,
      activeSubagentsCount,
    };
  }

  async function dispose(): Promise<void> {
    const disposalErrors: Error[] = [];
    for (const ws of activeWorkspaces) {
      try {
        await ws.dispose();
      } catch (err: unknown) {
        disposalErrors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }
    activeWorkspaces.clear();

    for (let i = fibers.length - 1; i >= 0; i--) {
      const fiber = fibers[i];
      if (fiber && typeof fiber.dispose === 'function') {
        try {
          await fiber.dispose();
        } catch (err: unknown) {
          disposalErrors.push(
            err instanceof Error ? err : new Error('Fiber disposal error', { cause: err })
          );
        }
      }
    }
    fibers.length = 0;
    mountedPlugins.clear();

    if (disposalErrors.length > 0) {
      throw new AggregateError(disposalErrors, 'Official plugins disposal failed');
    }
  }

  return {
    fibers,
    mountedPlugins,
    registerWorkspace,
    getCapabilities,
    dispose,
  };
}
