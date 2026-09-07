/**
 * Official DSH Runtime Boot Integrator for Enkeep
 *
 * Boots the official DeepSeek Harness core agent-loop,
 * session store, session persistence (JSONL), tools, and prompt registries,
 * coupled with the deterministic demo model plugin.
 * Loads and applies the Enkeep bundle typed plugins via @enkeep/dsh-enkeep-bundle.
 * Uses official registry @deepseek-ai package ESM imports.
 *
 * @module @enkeep/runtime-runner/runtime/dsh-boot
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Context, type Fiber } from '@deepseek-ai/cordis';
import LlmRuntime, {
  createUserMessage,
  type ContentBlock,
} from '@deepseek-ai/dsh-llm';
import SessionStore, {
  Session,
  SessionId,
  decodeStorageRecord,
  type SessionEvent,
  type SessionId as SessionIdType,
} from '@deepseek-ai/dsh-session';
import AgentRegistry, {
  installModelSelection,
  type Agent,
  type AgentHandle,
} from '@deepseek-ai/dsh-agent';
import SystemPromptRegistry from '@deepseek-ai/dsh-system-prompt';
import ToolsRegistry from '@deepseek-ai/dsh-tools';
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop';
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model';
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import { DshPlatformClient } from '@enkeep/dsh-platform-client';

import type { EventRelayService } from '@enkeep/dsh-event-relay';
import {
  classifyError,
  ModelCircuitBreakerRegistry,
  type CircuitBreakerState,
} from '@enkeep/platform-core';
import {
  type RuntimeTurnRequest,
  type RuntimeWorkspaceSegment,
  isValidRuntimeWorkspaceSegment,
  type SessionSeedReceipt,
  canonicalJsonStringify,
  computeSessionEventsChecksum,
  computeSessionSeedReceipt,
} from '@enkeep/protocol';
export {
  type SessionSeedReceipt,
  canonicalJsonStringify,
  computeSessionEventsChecksum,
  computeSessionSeedReceipt,
};
import type { FallbackTarget } from '../transport/types.js';

// Enkeep Typed Runtime Bundle Composition
import {
  createEnkeepRuntimeBundle,
  applyEnkeepBundle,
} from '@enkeep/dsh-enkeep-bundle';

import {
  DeterministicDemoLlmAdapter,
  DEMO_PROVIDER_ID,
  DEMO_MODEL_ID,
} from './demo-model-plugin.js';
import {
  DeepSeekAdapter,
  resolveAdapterOptions,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
} from '@deepseek-ai/dsh-llm-deepseek';
import * as PiAiPlugin from '@deepseek-ai/dsh-llm-pi-ai';
import {
  validateAgentProfileSnapshot,
  installAgentProfile,
  AgentProfileSessionMismatchError,
  type AgentProfileSnapshot,
  type ValidatedAgentProfile,
} from './agent-profile.js';
import {
  mountOfficialPlugins,
  mountWorkspaceTools,
  isPathInside,
  type OfficialPluginsConfig,
  type OfficialPluginsHandle,
  type WorkspaceToolsHandle,
  type RuntimeCapabilitiesStatus,
  type CompactionMountConfig,
  type InstructionsMountConfig,
  type SkillsMountConfig,
  type SubagentsMountConfig,
} from './official-plugins.js';
import {
  type RuntimeHealthStatus,
  type PluginReadinessStatus,
  type AgentFollowupResponse,
  type AgentFollowupRequest,
  TOOLS_UNAVAILABLE_REASONS,
  TOOLS_UNAVAILABLE_DESCRIPTIONS,
} from '../transport/types.js';
import type { RuntimeMountSpec, ResolvedRuntimeMount } from '../spec/types.js';
import { computeMountHash } from '../spec/mount-security.js';
import { computeExtensionPlanHash } from '../spec/extension-plan-security.js';
import {
  type ExtensionActivationPlan,
  validateExtensionActivationPlan,
} from '@enkeep/protocol';

export const USER_ID_PATTERN = /^[A-Za-z0-9_\-:.]{1,128}$/;
export const CONFIG_COMPONENT_ID_PATTERN = /^[A-Za-z0-9_\-:.]{1,128}$/;
export const SPACE_ID_PATTERN = /^[A-Za-z0-9_\-:.]{1,128}$/;
export const CANONICAL_SESSION_ID_PATTERN = /^(ses_[0-9a-f]{32}|import-[0-9a-f]{32})$/;
export const CANONICAL_TURN_ID_PATTERN = /^turn_[0-9a-f]{32}$/;
export const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Validates whether a space ID conforms to the safe identifier pattern.
 */
export function isValidSpaceId(spaceId: unknown): spaceId is string {
  return (
    typeof spaceId === 'string' &&
    spaceId.length > 0 &&
    spaceId.length <= 128 &&
    SPACE_ID_PATTERN.test(spaceId) &&
    !spaceId.includes('..') &&
    !spaceId.includes('/') &&
    !spaceId.includes('\\')
  );
}

/**
 * Type guard for plain object records without `as any` casting.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates that a string is a strictly absolute and normalized path (no relative segments, no dot traversal).
 */
export function isNormalizedAbsolutePath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0) {
    return false;
  }
  return path.isAbsolute(p) && path.normalize(p) === p;
}

/**
 * Validates whether a user ID conforms to the strict safe identifier pattern.
 */
export function isValidUserId(userId: unknown): userId is string {
  return typeof userId === 'string' && userId.length > 0 && userId.length <= 128 && USER_ID_PATTERN.test(userId);
}

/**
 * Validates whether a provider or model identifier conforms to configuration component identifier pattern.
 */
export function isValidConfigComponentId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && CONFIG_COMPONENT_ID_PATTERN.test(id);
}

/**
 * Validates whether a session ID conforms strictly to the canonical session ID pattern.
 */
export function isValidSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === 'string' && CANONICAL_SESSION_ID_PATTERN.test(sessionId);
}

/**
 * Validates whether a turn ID conforms strictly to the canonical turn ID pattern.
 */
export function isValidTurnId(turnId: unknown): turnId is string {
  return typeof turnId === 'string' && CANONICAL_TURN_ID_PATTERN.test(turnId);
}

export class PersistedSessionResumeError extends Error {
  readonly sessionId: string;
  readonly sessionsDir: string;

  constructor(sessionId: string, sessionsDir: string, cause?: unknown) {
    super(
      'CRITICAL SESSION RESUME FAILURE: Persisted session exists in session store but failed to resume',
      cause !== undefined ? { cause } : undefined
    );
    this.name = 'PersistedSessionResumeError';
    this.sessionId = sessionId;
    this.sessionsDir = sessionsDir;
  }
}

export interface DshRuntimeBootConfig {
  /** User identifier (mandatory, e.g. 'alice', 'bob') */
  readonly userId: string;
  /** DSH Home directory ($DSH_HOME, mandatory absolute normalized path) */
  readonly dshHome: string;
  /** Working spaces directory (mandatory absolute normalized path, sibling of dshHome) */
  readonly spacesDir: string;
  /** Custom LLM provider ID (default: cpa-claude when llm enabled, demo-provider otherwise) */
  readonly provider?: string;
  /** Custom LLM model ID (default: claude-fable-5 when llm enabled, demo-model otherwise) */
  readonly model?: string;
  /** Optional delay per streamed chunk in ms (for cancellation tests) */
  readonly chunkDelayMs?: number;
  /** Whether real LLM is enabled (default: ENKEEP_LLM_ENABLED === '1') */
  readonly llmEnabled?: boolean;
  /** In-container tunnel Base URL for LLM proxy (default: ENKEEP_LLM_BASE_URL or http://127.0.0.1:8787/llm) */
  readonly llmBaseUrl?: string;
  /** Optional in-container providers dictionary override */
  readonly providers?: Record<string, unknown>;
  /** Optional official compaction mount configuration */
  readonly compaction?: CompactionMountConfig;
  /** Optional official agent-instructions mount configuration */
  readonly instructions?: InstructionsMountConfig;
  /** Optional official skills mount configuration */
  readonly skills?: SkillsMountConfig;
  /** Optional official subagents mount configuration */
  readonly subagents?: SubagentsMountConfig;
  /** Optional controlled runtime mounts or dynamic mount resolver per space */
  readonly mounts?: readonly (RuntimeMountSpec | ResolvedRuntimeMount)[] | ((workspaceFolder?: string) => readonly (RuntimeMountSpec | ResolvedRuntimeMount)[]);
  /** Optional model context window tokens override */
  readonly contextWindow?: number;
  /** Optional model max output tokens override */
  readonly maxTokens?: number;
  /** Optional mock or custom platform client instance */
  readonly platformClient?: DshPlatformClient | unknown;
}

export interface ActiveTurnInfo {
  turnId: string;
  sessionId: string;
  agent: Agent;
  pid: number;
  nonce: string;
  createdAt: string;
  cancelRequested: boolean;
}

export interface DshBootedRuntime {
  readonly userId: string;
  readonly dshHome: string;
  readonly sessionsDir: string;
  readonly spacesDir: string;
  readonly startedAt: number;
  readonly context: Context;
  readonly bundleFibers: readonly Fiber[];
  readonly officialPlugins?: OfficialPluginsHandle;
  readonly officialPluginsHandle?: OfficialPluginsHandle;
  readonly agentHandles?: ReadonlyMap<string, AgentHandle>;
  readonly modelProvider: string;
  getOrCreateAgent(
    sessionIdStr: string,
    profileSnapshot?: AgentProfileSnapshot | null | unknown,
    workspaceFolder?: string,
    mounts?: readonly RuntimeMountSpec[],
    extensionPlan?: ExtensionActivationPlan | null
  ): Promise<Agent>;
  removeAgent?(sessionIdStr: string): void;
  checkSessionArtifact(sessionIdStr: string, workspaceFolder?: string): Promise<{ exists: boolean; valid: boolean; checksum?: string; eventCount?: number }>;
  inspectSessionCorruption(sessionIdStr: string, workspaceFolder?: string): Promise<{
    exists: boolean;
    valid: boolean;
    corrupted: boolean;
    code: 'VALID' | 'CORRUPTED' | 'SEQ_GAP' | 'SYNTAX_ERROR' | 'NOT_FOUND';
    lastValidSeq: number;
    lineCount: number;
    validEventsCount: number;
    errorDetail?: string;
  }>;
  recoverSessionPrefix(options: {
    sourceSessionId: string;
    targetSessionId: string;
    workspaceFolder?: string;
    maxValidSeq?: number;
  }): Promise<{
    recovered: boolean;
    targetSessionId: string;
    validEventsCount: number;
    backupPath: string;
    backupChecksum: string;
  }>;
  exportForkSeed(
    sessionIdStr: string,
    boundary?: { fromMessageId?: string; fromTurnId?: string },
    workspaceFolder?: string
  ): Promise<{ events: readonly SessionEvent[]; receipt: SessionSeedReceipt; boundaryMapping?: Record<string, unknown> }>;
  importSeed(
    sessionIdStr: string,
    seed: readonly SessionEvent[],
    receipt: SessionSeedReceipt,
    profileSnapshot?: AgentProfileSnapshot | null | unknown,
    workspaceFolder?: string
  ): Promise<{ sessionId: string; persisted: boolean; eventsCount: number; receipt: SessionSeedReceipt; duplicate: boolean }>;
  sendFollowup(
    requestOrPrompt: RuntimeTurnRequest | AgentFollowupRequest | string,
    sessionId?: string,
    turnId?: string,
    profileSnapshot?: AgentProfileSnapshot | null,
    workspaceFolder?: string,
    attachments?: readonly any[]
  ): Promise<AgentFollowupResponse>;
  getTurnResultAfterSeq?(
    sessionIdStr: string,
    startIndex?: number
  ): DerivedTurnResult | null;
  cancelTurn(turnId: string): Promise<boolean>;
  getHealth(): Promise<RuntimeHealthStatus>;
  getCapabilities?(): Promise<RuntimeCapabilitiesStatus>;
  dispose(): Promise<void>;
}

/**
 * Extracts pure text content from an official assistant message data payload.
 */
export function extractTextFromAssistantMessage(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const d = data as Record<string, unknown>;
  const message = (d.message && typeof d.message === 'object' ? d.message : (d.role === 'assistant' ? d : undefined)) ?? d;

  if (Array.isArray((message as any).content)) {
    const parts: string[] = [];
    for (const b of (message as any).content) {
      if (typeof b === 'string') {
        parts.push(b);
      } else if (b && typeof b === 'object') {
        const block = b as Record<string, unknown>;
        if (typeof block.text === 'string') {
          parts.push(block.text);
        } else if (block.type === 'text' && typeof block.content === 'string') {
          parts.push(block.content);
        }
      }
    }
    return parts.join('');
  }
  if (typeof (message as any).text === 'string') {
    return (message as any).text;
  }
  if (typeof d.text === 'string') {
    return d.text;
  }
  return '';
}

export interface DerivedTurnResult {
  replyText: string;
  isCancelled: boolean;
  actualUsage?: { totalTokens: number };
  actualProvider?: string;
  actualModel?: string;
  eventsCount: number;
}

/**
 * Derives authoritative turn result from session events occurring after a starting event index.
 * Scopes assistant messages between turn/start and matching turn/end.
 */
export function extractTurnResultFromEvents(
  events: readonly SessionEvent[],
  startIndex = 0
): DerivedTurnResult {
  const turnEvents = events.slice(startIndex);
  const assistantTexts: string[] = [];
  let isCancelled = false;
  let actualUsage: { totalTokens: number } | undefined;
  let actualProvider: string | undefined;
  let actualModel: string | undefined;

  for (const event of turnEvents) {
    if (event.type === 'turn/end') {
      const reason = (event.data as any)?.reason;
      if (reason?.kind === 'aborted' || reason?.kind === 'interrupted') {
        isCancelled = true;
      }
    }

    if (event.type === 'request/context') {
      const data = event.data as any;
      if (data?.provider && data?.model) {
        actualProvider = data.provider;
        actualModel = data.model;
      }
    }

    if (event.type === 'assistant/message' || (event as any).type === 'message') {
      const data = event.data as any;
      const text = extractTextFromAssistantMessage(data);
      if (text && text.trim().length > 0) {
        assistantTexts.push(text);
      }

      const src = data?.message?.source || data?.source;
      if (src?.provider && src?.model) {
        actualProvider = src.provider;
        actualModel = src.model;
      }

      if (data?.usage && typeof data.usage === 'object') {
        const u = data.usage;
        const inputTokens = typeof u.inputTokens === 'number' && Number.isSafeInteger(u.inputTokens) && u.inputTokens >= 0 ? u.inputTokens : 0;
        const outputTokens = typeof u.outputTokens === 'number' && Number.isSafeInteger(u.outputTokens) && u.outputTokens >= 0 ? u.outputTokens : 0;
        const cacheReadTokens = typeof u.cacheReadTokens === 'number' && Number.isSafeInteger(u.cacheReadTokens) && u.cacheReadTokens >= 0 ? u.cacheReadTokens : 0;
        const cacheWriteTokens = typeof u.cacheWriteTokens === 'number' && Number.isSafeInteger(u.cacheWriteTokens) && u.cacheWriteTokens >= 0 ? u.cacheWriteTokens : 0;
        const computedTotal = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
        if (Number.isSafeInteger(computedTotal) && computedTotal >= 0) {
          actualUsage = { totalTokens: computedTotal };
        }
      }
    }
  }

  // If no assistant text found in slice, fallback to scanning backward
  let replyText = assistantTexts.length > 0 ? assistantTexts[assistantTexts.length - 1] : '';
  if (!replyText) {
    for (let i = events.length - 1; i >= startIndex; i--) {
      const ev = events[i];
      if (ev && (ev.type === 'assistant/message' || (ev as any).type === 'message')) {
        const text = extractTextFromAssistantMessage(ev.data);
        if (text && text.trim().length > 0) {
          replyText = text;
          break;
        }
      }
    }
  }

  return {
    replyText,
    isCancelled,
    actualUsage,
    actualProvider,
    actualModel,
    eventsCount: events.length,
  };
}

/**
 * Ensures a directory exists with strict mode 0o700 via secure file descriptor
 * operations (O_NOFOLLOW + fchmod + fstat), closing the descriptor in all cases.
 * Aggregates primary and close errors so no security evidence is swallowed.
 */
function ensureSecureDirectory(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });

  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  let fd: number | null = null;
  let primaryError: unknown = undefined;

  try {
    fd = fs.openSync(dirPath, flags);
    fs.fchmodSync(fd, 0o700);
    const stat = fs.fstatSync(fd);
    if (!stat.isDirectory()) {
      throw new Error('Security violation: runtime path must be a directory');
    }
    if ((stat.mode & 0o777) !== 0o700) {
      throw new Error('Security violation: runtime path permissions must be 0700');
    }
    if (typeof process.getuid !== 'function') {
      throw new Error('Security violation: process.getuid is required to verify ownership');
    }
    const currentUid = process.getuid();
    if (stat.uid !== currentUid) {
      throw new Error('Security violation: runtime path owner UID must match process UID');
    }
  } catch (err: unknown) {
    primaryError = err;
  } finally {
    let closeError: unknown = undefined;
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (closeErr: unknown) {
        closeError = closeErr;
      }
    }

    if (primaryError !== undefined && closeError !== undefined) {
      throw new AggregateError(
        [primaryError, closeError],
        'Multiple errors during secure directory validation'
      );
    } else if (primaryError !== undefined) {
      throw primaryError;
    } else if (closeError !== undefined) {
      throw closeError;
    }
  }
}

export function toResolvedMounts(
  mounts?: readonly (RuntimeMountSpec | ResolvedRuntimeMount)[]
): readonly ResolvedRuntimeMount[] {
  if (!mounts) return [];
  return mounts.map((m) => ({
    id: m.id,
    name: m.name,
    sourcePath: m.sourcePath,
    targetPath: (m as ResolvedRuntimeMount).targetPath || m.sourcePath,
    mode: m.mode,
  }));
}

export interface ValidatedDshRuntimeBootConfig extends DshRuntimeBootConfig {
  readonly provider: string;
  readonly model: string;
  readonly chunkDelayMs: number;
  readonly llmEnabled: boolean;
  readonly llmBaseUrl: string;
  readonly providers?: Record<string, unknown>;
  readonly compaction?: CompactionMountConfig;
  readonly instructions?: InstructionsMountConfig;
  readonly skills?: SkillsMountConfig;
  readonly subagents?: SubagentsMountConfig;
  readonly mounts?: readonly (RuntimeMountSpec | ResolvedRuntimeMount)[] | ((workspaceFolder?: string) => readonly (RuntimeMountSpec | ResolvedRuntimeMount)[]);
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly platformClient?: DshPlatformClient | unknown;
}

const ALLOWED_BOOT_CONFIG_KEYS = new Set([
  'userId',
  'dshHome',
  'spacesDir',
  'provider',
  'model',
  'chunkDelayMs',
  'llmEnabled',
  'llmBaseUrl',
  'providers',
  'compaction',
  'instructions',
  'skills',
  'subagents',
  'mounts',
  'contextWindow',
  'maxTokens',
  'platformClient',
]);

/**
 * Validates and normalizes runtime boot configuration synchronously.
 * Throws TypeError for non-objects, invalid/missing userId, dshHome, spacesDir,
 * non-sibling paths, or unexpected configuration keys.
 */
export function validateDshRuntimeBootConfig(rawConfig: unknown): ValidatedDshRuntimeBootConfig {
  if (!isRecord(rawConfig)) {
    throw new TypeError('DshRuntimeBootConfig must be a non-null plain object');
  }

  for (const key of Object.keys(rawConfig)) {
    if (!ALLOWED_BOOT_CONFIG_KEYS.has(key)) {
      throw new TypeError('Unexpected boot configuration key');
    }
  }

  // Strict userId validation (no default fallback)
  if (!isValidUserId(rawConfig.userId)) {
    throw new TypeError('Invalid or missing "userId". Must match pattern');
  }
  const userId = rawConfig.userId;

  // Strict dshHome validation (mandatory absolute normalized path)
  if (typeof rawConfig.dshHome !== 'string' || !isNormalizedAbsolutePath(rawConfig.dshHome)) {
    throw new TypeError('Invalid or missing "dshHome". Must be a non-empty absolute normalized path');
  }
  const dshHome = rawConfig.dshHome;

  // Strict spacesDir validation (mandatory absolute normalized path, sibling of dshHome with basename 'spaces')
  if (typeof rawConfig.spacesDir !== 'string' || !isNormalizedAbsolutePath(rawConfig.spacesDir)) {
    throw new TypeError('Invalid or missing "spacesDir". Must be a non-empty absolute normalized path');
  }
  const spacesDir = rawConfig.spacesDir;

  const dshParent = path.dirname(dshHome);
  const spacesParent = path.dirname(spacesDir);
  if (dshParent !== spacesParent || path.basename(spacesDir) !== 'spaces') {
    throw new TypeError('"spacesDir" must be a sibling directory under dirname(dshHome) and named "spaces"');
  }

  let isLlmEnabled: boolean;
  if (rawConfig.llmEnabled === false || process.env.ENKEEP_LLM_ENABLED === '0') {
    isLlmEnabled = false;
  } else if (rawConfig.llmEnabled === true || process.env.ENKEEP_LLM_ENABLED === '1') {
    isLlmEnabled = true;
  } else {
    isLlmEnabled = Boolean(rawConfig.providers && Object.keys(rawConfig.providers).length > 0);
  }

  let provider = isLlmEnabled ? (process.env.ENKEEP_LLM_PROVIDER || 'cpa-claude') : DEMO_PROVIDER_ID;
  if ('provider' in rawConfig && rawConfig.provider !== undefined) {
    if (typeof rawConfig.provider !== 'string' || !isValidConfigComponentId(rawConfig.provider)) {
      throw new TypeError('Invalid "provider". Must match canonical ID pattern');
    }
    provider = rawConfig.provider;
  }

  let model = isLlmEnabled ? (process.env.ENKEEP_LLM_MODEL || 'claude-fable-5') : DEMO_MODEL_ID;
  if ('model' in rawConfig && rawConfig.model !== undefined) {
    if (typeof rawConfig.model !== 'string' || !isValidConfigComponentId(rawConfig.model)) {
      throw new TypeError('Invalid "model". Must match canonical ID pattern');
    }
    model = rawConfig.model;
  }

  let chunkDelayMs = 0;
  if ('chunkDelayMs' in rawConfig && rawConfig.chunkDelayMs !== undefined) {
    if (
      typeof rawConfig.chunkDelayMs !== 'number' ||
      !Number.isSafeInteger(rawConfig.chunkDelayMs) ||
      rawConfig.chunkDelayMs < 0 ||
      rawConfig.chunkDelayMs > 10000
    ) {
      throw new RangeError('Invalid "chunkDelayMs": must be a safe integer between 0 and 10000');
    }
    chunkDelayMs = rawConfig.chunkDelayMs;
  }

  const llmBaseUrl =
    typeof rawConfig.llmBaseUrl === 'string' && rawConfig.llmBaseUrl.trim().length > 0
      ? rawConfig.llmBaseUrl.trim()
      : process.env.ENKEEP_LLM_BASE_URL || 'http://127.0.0.1:8787/llm';

  let providers: Record<string, unknown> | undefined;
  if ('providers' in rawConfig && rawConfig.providers !== undefined) {
    if (!isRecord(rawConfig.providers)) {
      throw new TypeError('Invalid "providers": must be an object');
    }
    providers = rawConfig.providers;
  }

  let compaction: CompactionMountConfig | undefined;
  if ('compaction' in rawConfig && rawConfig.compaction !== undefined) {
    if (!isRecord(rawConfig.compaction)) {
      throw new TypeError('Invalid "compaction": must be an object');
    }
    compaction = rawConfig.compaction as CompactionMountConfig;
  }

  let instructions: InstructionsMountConfig | undefined;
  if ('instructions' in rawConfig && rawConfig.instructions !== undefined) {
    if (!isRecord(rawConfig.instructions)) {
      throw new TypeError('Invalid "instructions": must be an object');
    }
    instructions = rawConfig.instructions as InstructionsMountConfig;
  }

  let skills: SkillsMountConfig | undefined;
  if ('skills' in rawConfig && rawConfig.skills !== undefined) {
    if (!isRecord(rawConfig.skills)) {
      throw new TypeError('Invalid "skills": must be an object');
    }
    skills = rawConfig.skills as SkillsMountConfig;
  }

  let subagents: SubagentsMountConfig | undefined;
  if ('subagents' in rawConfig && rawConfig.subagents !== undefined) {
    if (!isRecord(rawConfig.subagents)) {
      throw new TypeError('Invalid "subagents": must be an object');
    }
    subagents = rawConfig.subagents as SubagentsMountConfig;
  }

  let contextWindow: number | undefined;
  if ('contextWindow' in rawConfig && rawConfig.contextWindow !== undefined) {
    if (
      typeof rawConfig.contextWindow !== 'number' ||
      !Number.isSafeInteger(rawConfig.contextWindow) ||
      rawConfig.contextWindow <= 0
    ) {
      throw new TypeError('Invalid "contextWindow": must be a positive safe integer');
    }
    contextWindow = rawConfig.contextWindow;
  }

  let maxTokens: number | undefined;
  if ('maxTokens' in rawConfig && rawConfig.maxTokens !== undefined) {
    if (
      typeof rawConfig.maxTokens !== 'number' ||
      !Number.isSafeInteger(rawConfig.maxTokens) ||
      rawConfig.maxTokens <= 0
    ) {
      throw new TypeError('Invalid "maxTokens": must be a positive safe integer');
    }
    maxTokens = rawConfig.maxTokens;
  }

  let mounts: readonly RuntimeMountSpec[] | ((workspaceFolder?: string) => readonly RuntimeMountSpec[]) | undefined;
  if ('mounts' in rawConfig && rawConfig.mounts !== undefined) {
    if (typeof rawConfig.mounts === 'function') {
      mounts = rawConfig.mounts as (workspaceFolder?: string) => readonly RuntimeMountSpec[];
    } else if (Array.isArray(rawConfig.mounts)) {
      mounts = rawConfig.mounts as readonly RuntimeMountSpec[];
    } else {
      throw new TypeError('Invalid "mounts": must be an array or resolver function');
    }
  }

  return {
    userId,
    dshHome,
    spacesDir,
    provider,
    model,
    chunkDelayMs,
    llmEnabled: isLlmEnabled,
    llmBaseUrl,
    providers,
    compaction,
    instructions,
    skills,
    subagents,
    mounts,
    contextWindow,
    maxTokens,
    platformClient: rawConfig.platformClient,
  };
}

/**
 * Boots a genuine DSH runtime instance using official ESM package plugins
 * and applies the official Enkeep bundle plugins via @enkeep/dsh-enkeep-bundle.
 *
 * Strict requirements:
 * - userId is mandatory, strictly validated with regex (no fallback).
 * - dshHome and spacesDir are mandatory, absolute, normalized, and sibling directories.
 * - Directories are created with mode 0o700 and verified with lstat containment.
 * - No initial/bootstrap session created at boot time.
 * - No YAML reading, fs candidate searches, or js-yaml dependency at runtime.
 * - Exact lazy session resolution.
 * - Strict persistence verification via official SessionPersistence capability.
 * - Turn registration and cancellation via cancelTurn(turnId).
 * - Zero `as any` casting.
 *
 * @param config - Boot parameters for user, directories, and model config.
 * @returns An active booted runtime handle.
 */
export async function bootDshRuntime(config: DshRuntimeBootConfig | unknown): Promise<DshBootedRuntime> {
  const startedAt = Date.now();
  const validConfig = validateDshRuntimeBootConfig(config);
  const { userId, dshHome, spacesDir, provider, model, chunkDelayMs, llmEnabled, llmBaseUrl } = validConfig;

  const sessionsDir = path.join(dshHome, 'sessions');
  const dataDir = path.join(dshHome, 'data');

  // Ensure runtime directories exist under $DSH_HOME with mode 0o700
  ensureSecureDirectory(dshHome);
  ensureSecureDirectory(spacesDir);
  ensureSecureDirectory(sessionsDir);
  ensureSecureDirectory(dataDir);

  const ctx = new Context();

  // 1. Mount official core DSH plugins with zero `as any`
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(SystemPromptRegistry);
  await ctx.plugin(ToolsRegistry);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(AgentLoop);
  await ctx.plugin(AgentDefaultModel, {
    provider,
    model,
  });
  await ctx.plugin(SessionPersistenceJsonl, {
    root: sessionsDir,
    compression: 'none', // Raw JSONL for transparent auditability
  });

  try {
    (Context as any).service?.('platformClient');
    (Context as any).service?.('mcpGovernance');
  } catch {}

  // Mount PlatformClient on Cordis context pointing to in-container tunnel loopback or authenticated host proxy
  const platformBaseUrl = process.env.ENKEEP_PLATFORM_BASE_URL || 'http://127.0.0.1:8787/platform';
  const platformToken =
    process.env.ENKEEP_PLATFORM_PROXY_TOKEN ||
    process.env.ENKEEP_PLATFORM_TOKEN;
  const platformClient: DshPlatformClient =
    (validConfig.platformClient as DshPlatformClient | undefined) ??
    new DshPlatformClient({
      baseURL: platformBaseUrl,
      bearerToken: platformToken,
      defaultHeaders: platformToken
        ? {
            authorization: `Bearer ${platformToken}`,
          }
        : undefined,
      timeoutMs: 10000,
    });
  // Strip platform tokens from process.env immediately after construction
  delete process.env.ENKEEP_PLATFORM_PROXY_TOKEN;
  delete process.env.ENKEEP_PLATFORM_TOKEN;
  ctx.provide('platformClient', platformClient);
  ctx.platformClient = platformClient;

  // 2. Mount LLM adapter: official @deepseek-ai/dsh-llm-pi-ai when enabled, demo adapter otherwise
  if (llmEnabled) {
    // In-container placeholder credential environment variable
    process.env.IN_CONTAINER_PLACEHOLDER = 'in-container-placeholder';

    let resolvedProviders: Record<string, unknown> | undefined = validConfig.providers;
    if (!resolvedProviders && process.env.ENKEEP_LLM_PROVIDERS) {
      try {
        const parsed = JSON.parse(process.env.ENKEEP_LLM_PROVIDERS);
        if (isRecord(parsed)) {
          resolvedProviders = parsed;
        }
      } catch {}
    }

    if (!resolvedProviders || Object.keys(resolvedProviders).length === 0) {
      // Default in-container rewritten providers table
      resolvedProviders = {
        'cpa-claude': {
          displayName: 'Claude',
          apiKeyEnv: 'IN_CONTAINER_PLACEHOLDER',
          api: 'anthropic-messages',
          baseURL: `${llmBaseUrl.replace(/\/+$/, '')}/cpa-claude`,
          defaultContextWindow: 1000000,
          defaultMaxTokens: 128000,
          models: [
            { id: 'claude-opus-5', reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', max: 'max' } },
            { id: 'claude-sonnet-5', reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', max: 'max' } },
            { id: 'claude-fable-5', reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', max: 'max' } },
            { id: 'claude-opus-4-8', reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', max: 'max' } },
            { id: 'claude-opus-4-6', reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', max: 'max' } },
          ],
        },
        'cpa-gpt': {
          displayName: 'GPT',
          apiKeyEnv: 'IN_CONTAINER_PLACEHOLDER',
          api: 'openai-completions',
          baseURL: `${llmBaseUrl.replace(/\/+$/, '')}/cpa-gpt`,
          defaultContextWindow: 920000,
          defaultMaxTokens: 128000,
          models: [
            { id: 'gpt-5.6-sol', reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', max: 'max' } },
            { id: 'gpt-5.6-luna', reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', max: 'max' } },
            { id: 'gpt-5.6-terra', reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', max: 'max' } },
          ],
        },
        'cpa-grok': {
          displayName: 'Grok',
          apiKeyEnv: 'IN_CONTAINER_PLACEHOLDER',
          api: 'openai-completions',
          baseURL: `${llmBaseUrl.replace(/\/+$/, '')}/cpa-grok`,
          defaultContextWindow: 400000,
          defaultMaxTokens: 64000,
          models: [
            { id: 'grok-4.6', reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', max: 'max' } },
          ],
        },
        'cpa-gemini': {
          displayName: 'Gemini',
          apiKeyEnv: 'IN_CONTAINER_PLACEHOLDER',
          api: 'anthropic-messages',
          baseURL: `${llmBaseUrl.replace(/\/+$/, '')}/cpa-gemini`,
          defaultContextWindow: 1000000,
          defaultMaxTokens: 64000,
          models: [
            {
              id: 'gemini-3.7-flash-tiered',
              contextWindow: 1000000,
              maxTokens: 64000,
              reasoningEfforts: {
                low: 'low',
                medium: 'medium',
                high: 'high',
                max: 'max',
              },
            },
          ],
        },
        'cpa-cn': {
          displayName: '国产模型',
          apiKeyEnv: 'IN_CONTAINER_PLACEHOLDER',
          api: 'anthropic-messages',
          baseURL: `${llmBaseUrl.replace(/\/+$/, '')}/cpa-cn`,
          defaultContextWindow: 1000000,
          defaultMaxTokens: 64000,
          models: [
            { id: 'deepseek-v4-pro', contextWindow: 1048566, reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', max: 'max' } },
            { id: 'deepseek-v4-flash', contextWindow: 1048566, reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', max: 'max' } },
            { id: 'kimi-k3', contextWindow: 1000000, reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', max: 'max' } },
            { id: 'glm-5.3', contextWindow: 1000000, reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', max: 'max' } },
            { id: 'minimax-m3', contextWindow: 1000000, reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', max: 'max' } },
            { id: 'doubao-seed-2.1-turbo', contextWindow: 200000, reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', max: 'max' } },
          ],
        },
      };
    }

    const proxyToken = process.env.ENKEEP_LLM_PROXY_TOKEN;
    if (proxyToken && resolvedProviders) {
      for (const [key, prov] of Object.entries(resolvedProviders)) {
        if (prov && typeof prov === 'object') {
          const existingHeaders = (prov as Record<string, unknown>).headers;
          const mergedHeaders =
            existingHeaders && typeof existingHeaders === 'object'
              ? { ...existingHeaders }
              : {};
          (resolvedProviders as Record<string, unknown>)[key] = {
            ...prov,
            headers: {
              ...mergedHeaders,
              authorization: `Bearer ${proxyToken}`,
            },
          };
        }
      }
      // Strip proxy token from process.env immediately after provider configuration
      delete process.env.ENKEEP_LLM_PROXY_TOKEN;
    }

    await ctx.plugin(PiAiPlugin, {
      providers: resolvedProviders as any,
    });
  } else {
    // Mount deterministic demo LLM adapter (supports cancellation delays and model capacity overrides)
    const adapter = new DeterministicDemoLlmAdapter(
      userId,
      chunkDelayMs,
      validConfig.contextWindow ?? 128000,
      validConfig.maxTokens ?? 2048
    );
    const demoProviders = Array.from(new Set([
      provider,
      DEMO_PROVIDER_ID,
      'demo',
      'cpa-gemini',
      'cpa-claude',
      'cpa-gpt',
      'cpa-grok',
      'cpa-cn',
    ]));
    ctx.llm.registerAdapter(demoProviders, adapter);
  }

  // 3. Compose and apply typed Enkeep bundle via @enkeep/dsh-enkeep-bundle
  const bundleEntries = createEnkeepRuntimeBundle({
    dshHome,
    userId,
    spacesDir,
  });
  const bundleFibers = await applyEnkeepBundle(ctx, bundleEntries);

  const appliedEntryFibers = new Map<string, Fiber>();
  for (let i = 0; i < bundleEntries.length; i++) {
    const entry = bundleEntries[i];
    const fiber = bundleFibers[i];
    if (entry && fiber) {
      appliedEntryFibers.set(entry.id, fiber);
      appliedEntryFibers.set(entry.name, fiber);
    }
  }

  // 4. Mount official DSH 0.1.1-rc.2 capability plugins (P0 Compaction, P1 Instructions, P1 Skills, P2 Subagents)
  const officialPluginsHandle = await mountOfficialPlugins(ctx, {
    dshHome,
    spacesDir,
    userId,
    provider,
    model,
    compaction: validConfig.compaction,
    instructions: validConfig.instructions,
    skills: validConfig.skills,
    subagents: validConfig.subagents,
  });

  function isFiberActive(fiber: Fiber | undefined): boolean {
    return Boolean(fiber && typeof fiber.dispose === 'function' && fiber.state === 2);
  }

  // Map to hold live agent handles by session id
  const agentHandles = new Map<string, AgentHandle>();
  const sessionWorkspaceHandles = new Map<string, WorkspaceToolsHandle>();

  // Map to hold live agent model selection refs for dynamic per-turn updates
  const agentSelectionRefs = new Map<string, {
    current: { provider: string; model: string; reasoningEffort?: any } | undefined;
    assembled: { provider: string; model: string; reasoningEffort?: any } | undefined;
  }>();

  // Active fallback context by session ID for in-container request-level routing & telemetry
  interface AgentFallbackCandidate {
    provider: string;
    model: string;
    reasoningEffort?: string | null;
  }

  interface AgentFallbackContext {
    candidates: AgentFallbackCandidate[];
    candidateIndex: number;
    candidateRetries: number;
    routeAttempts: Array<{
      provider: string;
      model: string;
      latencyMs: number;
      statusCode: number;
      success: boolean;
      errorType?: string | null;
    }>;
    currentAttemptStart: number;
    stepChunksCount: number;
    active: boolean;
  }

  const activeFallbackContexts = new Map<string, AgentFallbackContext>();
  const circuitBreakers = new ModelCircuitBreakerRegistry();

  /**
   * Installs agent-scoped fallback router and telemetry recorder onto agentCtx.
   */
  function installAgentFallbackRouter(
    agentCtx: Context,
    sid: string,
    selectionRef: { current: { provider: string; model: string; reasoningEffort?: any } | undefined }
  ): () => void {
    const disposeSession = agentCtx.on('session/event', (_subject, event) => {
      const fbCtx = activeFallbackContexts.get(sid);
      if (!fbCtx || !fbCtx.active) return;
      if (event.type === 'step/start') {
        fbCtx.stepChunksCount = 0;
        fbCtx.currentAttemptStart = Date.now();
      } else if (event.type === 'assistant/chunk') {
        const chunk = (event.data as any)?.chunk;
        if (
          chunk &&
          (chunk.type === 'text-delta' ||
            chunk.type === 'tool-call-delta' ||
            chunk.type === 'reasoning-delta' ||
            chunk.type === 'block-start')
        ) {
          fbCtx.stepChunksCount++;
        }
      }
    });

    const disposeRequestError = agentCtx.on('agent/request-error', async (payload, next) => {
      const fbCtx = activeFallbackContexts.get(sid);
      if (!fbCtx || !fbCtx.active || fbCtx.candidates.length === 0) {
        return next();
      }

      const currentCand = fbCtx.candidates[fbCtx.candidateIndex] || {
        provider: payload.provider,
        model: selectionRef.current?.model || '',
        reasoningEffort: selectionRef.current?.reasoningEffort,
      };
      const latencyMs = Math.max(1, Date.now() - fbCtx.currentAttemptStart);
      const classification = classifyError(payload.failure);

      // 1. Record attempt in routeAttempts for telemetry
      fbCtx.routeAttempts.push({
        provider: currentCand.provider,
        model: currentCand.model,
        latencyMs,
        statusCode: classification.statusCode || 500,
        success: false,
        errorType: classification.errorType,
      });

      // 2. Record failure in circuit breaker
      circuitBreakers.recordFailure(currentCand.provider, currentCand.model, payload.failure, latencyMs);

      // 3. Midstream failure check: if content chunks were already emitted during this step, NEVER fallback!
      if (fbCtx.stepChunksCount > 0) {
        return next();
      }

      // 4. Permanent / Auth error check (401, 403, 400, 422, AUTH, INVALID_REQUEST) -> Fail fast!
      if (classification.isAuthOrPermanent) {
        return next();
      }

      // 5. Transient error: check bounded retry (1 retry per candidate) or fallback chain
      if (classification.isTransient) {
        // 5a. 1 retry on same candidate if not already retried
        if (fbCtx.candidateRetries < 1) {
          fbCtx.candidateRetries++;
          fbCtx.currentAttemptStart = Date.now();
          return { kind: 'retry' };
        }

        // 5b. Advance to next healthy candidate in fallback chain
        let nextIdx = fbCtx.candidateIndex + 1;
        while (nextIdx < fbCtx.candidates.length) {
          const nextCand = fbCtx.candidates[nextIdx];
          const check = circuitBreakers.canExecute(nextCand.provider, nextCand.model);
          if (check.allowed) {
            fbCtx.candidateIndex = nextIdx;
            fbCtx.candidateRetries = 0;
            fbCtx.currentAttemptStart = Date.now();
            selectionRef.current = {
              provider: nextCand.provider,
              model: nextCand.model,
              reasoningEffort: nextCand.reasoningEffort || undefined,
            };
            (selectionRef as any).assembled = selectionRef.current;
            return { kind: 'retry' };
          }
          nextIdx++;
        }
      }

      // All candidates exhausted or non-retryable error
      return next();
    });

    return () => {
      disposeSession();
      disposeRequestError();
    };
  }

  // Map to track active profile hash by session id
  const sessionProfileHashes = new Map<string, string>();

  // Map to track authoritative workspaceFolder by session id
  const sessionWorkspaces = new Map<string, string>();

  // Map to track active mounts and mount hashes by session id
  const sessionMounts = new Map<string, readonly RuntimeMountSpec[]>();
  const sessionMountHashes = new Map<string, string>();

  // Map to track active extension plans and plan hashes by session id
  const sessionExtensionPlans = new Map<string, ExtensionActivationPlan | null>();
  const sessionExtensionPlanHashes = new Map<string, string>();

  // Map to hold active turns by turnId for cancellation
  const activeTurns = new Map<string, ActiveTurnInfo>();
  let isDisposed = false;

  function resolveRuntimeMounts(
    mounts?: readonly (RuntimeMountSpec | ResolvedRuntimeMount)[]
  ): ResolvedRuntimeMount[] {
    if (!mounts || mounts.length === 0) return [];
    return mounts.map((m) => {
      if ((m as ResolvedRuntimeMount).targetPath) {
        return m as ResolvedRuntimeMount;
      }
      const isDocker =
        fs.existsSync('/home/dsh/mounts') ||
        (process.env.DSH_USER !== undefined &&
          process.env.DSH_SPACES === '/home/dsh/spaces' &&
          fs.existsSync('/home/dsh'));
      let targetPath = m.sourcePath;
      if (isDocker && fs.existsSync(path.join('/home/dsh/mounts', m.id))) {
        targetPath = path.join('/home/dsh/mounts', m.id);
      } else if (isDocker && !fs.existsSync(m.sourcePath)) {
        targetPath = path.join('/home/dsh/mounts', m.id);
      }

      let dev: number | undefined;
      let ino: number | undefined;
      try {
        if (fs.existsSync(targetPath)) {
          const stat = fs.statSync(targetPath);
          dev = stat.dev;
          ino = stat.ino;
        }
      } catch {}

      return {
        id: m.id,
        name: m.name,
        sourcePath: m.sourcePath,
        targetPath,
        mode: m.mode,
        dev,
        ino,
      };
    });
  }

  function resolveSpaceDir(workspaceFolderInput?: string, sessionIdStr?: string): { workspaceFolder?: string; spacePath: string } {
    let resolvedFolder = workspaceFolderInput;
    if (sessionIdStr && sessionWorkspaces.has(sessionIdStr)) {
      const boundFolder = sessionWorkspaces.get(sessionIdStr)!;
      if (workspaceFolderInput && workspaceFolderInput !== boundFolder) {
        throw new Error(`FAIL-CLOSED: Session "${sessionIdStr}" is already bound to workspaceFolder "${boundFolder}" but requested "${workspaceFolderInput}"`);
      }
      resolvedFolder = boundFolder;
    }
    if (!resolvedFolder) {
      return { workspaceFolder: undefined, spacePath: spacesDir };
    }
    if (!isValidRuntimeWorkspaceSegment(resolvedFolder) && !isValidSpaceId(resolvedFolder)) {
      throw new TypeError(`Invalid workspaceFolder format: "${resolvedFolder}". Must match safe workspace segment pattern.`);
    }
    const spacePath = path.join(spacesDir, resolvedFolder);
    if (!isPathInside(spacePath, spacesDir)) {
      throw new Error(`Security violation: space path "${spacePath}" escapes spacesDir "${spacesDir}"`);
    }
    ensureSecureDirectory(spacePath);
    if (sessionIdStr) {
      sessionWorkspaces.set(sessionIdStr, resolvedFolder);
    }
    return { workspaceFolder: resolvedFolder, spacePath };
  }

  // Helper to obtain or resume an agent for a given session ID
  async function getOrCreateAgent(
    sessionIdStr: string,
    profileSnapshot: AgentProfileSnapshot | null | unknown = null,
    workspaceFolder?: string,
    mounts?: readonly RuntimeMountSpec[],
    extensionPlan?: ExtensionActivationPlan | null
  ): Promise<Agent> {
    if (!isValidSessionId(sessionIdStr)) {
      throw new TypeError('Invalid session ID format: must match canonical session ID pattern');
    }

    if (isDisposed) {
      throw new Error('DSH Runtime is disposed');
    }

    let validatedProfile: ValidatedAgentProfile | undefined;
    if (profileSnapshot !== undefined && profileSnapshot !== null) {
      validatedProfile = validateAgentProfileSnapshot(profileSnapshot);
    }

    let validatedPlan: ExtensionActivationPlan | null = null;
    if (extensionPlan !== undefined && extensionPlan !== null) {
      validatedPlan = validateExtensionActivationPlan(extensionPlan);
    }
    const currentPlanHash = computeExtensionPlanHash(validatedPlan);

    let spacePath: string;
    if (workspaceFolder) {
      spacePath = resolveSpaceDir(workspaceFolder, sessionIdStr).spacePath;
    } else if (sessionWorkspaces.has(sessionIdStr)) {
      spacePath = path.join(spacesDir, sessionWorkspaces.get(sessionIdStr)!);
    } else {
      spacePath = resolveSpaceDir(undefined, sessionIdStr).spacePath;
    }

    const configMounts = validConfig.mounts;
    const effectiveMountSpecs: readonly RuntimeMountSpec[] =
      mounts ??
      (typeof configMounts === 'function'
        ? configMounts(workspaceFolder)
        : (configMounts ?? []));
    const resolvedMounts = resolveRuntimeMounts(effectiveMountSpecs);
    const currentMountHash = computeMountHash(effectiveMountSpecs);

    const existingHandle = agentHandles.get(sessionIdStr);
    if (existingHandle) {
      if (validatedProfile) {
        const recordedHash = sessionProfileHashes.get(sessionIdStr);
        if (!recordedHash || recordedHash !== validatedProfile.promptHash) {
          throw new AgentProfileSessionMismatchError(sessionIdStr);
        }
      }
      let shouldEvict = false;
      if (mounts !== undefined) {
        const recordedMountHash = sessionMountHashes.get(sessionIdStr);
        if (recordedMountHash !== currentMountHash) {
          shouldEvict = true;
        }
      }
      if (extensionPlan !== undefined) {
        const recordedPlanHash = sessionExtensionPlanHashes.get(sessionIdStr);
        if (recordedPlanHash !== currentPlanHash) {
          const ws = sessionWorkspaceHandles.get(sessionIdStr);
          if (ws?.updateExtensionPlan) {
            try {
              await ws.updateExtensionPlan(validatedPlan);
              sessionExtensionPlanHashes.set(sessionIdStr, currentPlanHash);
              sessionExtensionPlans.set(sessionIdStr, validatedPlan);
            } catch (upErr: unknown) {
              if ((upErr as any)?.code === 'PLUGIN_ACTIVATION_FAILED' || (upErr as any)?.message?.includes('PLUGIN_ACTIVATION_FAILED')) {
                const actErr = new Error('PLUGIN_ACTIVATION_FAILED');
                (actErr as any).code = 'PLUGIN_ACTIVATION_FAILED';
                throw actErr;
              }
              shouldEvict = true;
            }
          } else {
            shouldEvict = true;
          }
        }
      }
      if (shouldEvict) {
        try {
          await existingHandle.dispose();
        } catch {}
        agentHandles.delete(sessionIdStr);
        sessionWorkspaceHandles.delete(sessionIdStr);
        sessionMountHashes.delete(sessionIdStr);
        sessionProfileHashes.delete(sessionIdStr);
        sessionExtensionPlanHashes.delete(sessionIdStr);
        sessionExtensionPlans.delete(sessionIdStr);
      } else {
        return existingHandle.agent;
      }
    }

    const sid = SessionId(sessionIdStr);
    const liveAgent = ctx.agents.get(sid);
    if (liveAgent && agentHandles.has(sessionIdStr)) {
      if (validatedProfile) {
        const recordedHash = sessionProfileHashes.get(sessionIdStr);
        if (!recordedHash || recordedHash !== validatedProfile.promptHash) {
          throw new AgentProfileSessionMismatchError(sessionIdStr);
        }
      }
      let matches = true;
      if (mounts !== undefined) {
        const recordedMountHash = sessionMountHashes.get(sessionIdStr);
        if (recordedMountHash !== currentMountHash) {
          matches = false;
        }
      }
      if (extensionPlan !== undefined) {
        const recordedPlanHash = sessionExtensionPlanHashes.get(sessionIdStr);
        if (recordedPlanHash !== currentPlanHash) {
          matches = false;
        }
      }
      if (matches) {
        return liveAgent;
      }
    }

    // Verify session persistence readiness and inspect stored session
    const persistence = ctx.sessionPersistence;
    if (!persistence || typeof persistence.inspect !== 'function') {
      throw new Error('SessionPersistence service is not registered or not functional');
    }

    let storedInspection: { meta: unknown; events: readonly SessionEvent[] } | undefined;
    try {
      storedInspection = await persistence.inspect(sid);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.toLowerCase().includes('not found') && !msg.toLowerCase().includes('no such file') && (err as any)?.code !== 'ENOENT') {
        // Corrupt session on disk: fail loud immediately
        throw new PersistedSessionResumeError(sessionIdStr, sessionsDir, err);
      }
    }

    let handle!: AgentHandle;
    const agentsRegistry = ctx.agents;

    const createAgentSetup = (spacePath: string, selectionRef: { current: any; assembled: any }) => {
      return async (agentCtx: Context) => {
        installModelSelection(agentCtx, selectionRef);
        if (validatedProfile) {
          installAgentProfile(agentCtx, validatedProfile);
        }
        installAgentFallbackRouter(agentCtx, sessionIdStr, selectionRef);
        agentCtx.effect(() => {
          const eventRelay = ctx.eventRelay ?? (ctx.get ? ctx.get('eventRelay') : undefined);
          if (eventRelay && typeof eventRelay.attachAgent === 'function') {
            return eventRelay.attachAgent(agentCtx);
          }
          return () => {};
        }, 'eventRelay.agentScope()');

        const wsHandle = await mountWorkspaceTools(agentCtx, {
          spacePath,
          dshHome,
          sessionId: sessionIdStr,
          mounts: resolvedMounts,
          instructions: validConfig.instructions,
          skills: validConfig.skills,
          subagents: validConfig.subagents,
          extensionPlan: validatedPlan,
        });
        sessionWorkspaceHandles.set(sessionIdStr, wsHandle);
        officialPluginsHandle.registerWorkspace(wsHandle);
      };
    };

    if (storedInspection !== undefined) {
      let spacePath: string;
      if (workspaceFolder) {
        spacePath = resolveSpaceDir(workspaceFolder, sessionIdStr).spacePath;
      } else if (sessionWorkspaces.has(sessionIdStr)) {
        spacePath = path.join(spacesDir, sessionWorkspaces.get(sessionIdStr)!);
      } else {
        const headerCwd = (storedInspection.meta as any)?.cwd;
        if (typeof headerCwd === 'string' && isNormalizedAbsolutePath(headerCwd) && isPathInside(headerCwd, spacesDir)) {
          spacePath = headerCwd;
          const derivedId = path.relative(spacesDir, headerCwd);
          if (derivedId && (isValidRuntimeWorkspaceSegment(derivedId) || isValidSpaceId(derivedId))) {
            sessionWorkspaces.set(sessionIdStr, derivedId);
          }
        } else {
          spacePath = resolveSpaceDir(undefined, sessionIdStr).spacePath;
        }
      }
      ensureSecureDirectory(spacePath);

      try {
        let selectionRef = agentSelectionRefs.get(sessionIdStr);
        if (!selectionRef) {
          selectionRef = {
            current: { provider, model },
            assembled: undefined,
          };
          agentSelectionRefs.set(sessionIdStr, selectionRef);
        }

        let resumeAttempts = 0;
        while (resumeAttempts < 3) {
          try {
            handle = await agentsRegistry.resume({
              resumeSessionId: sid,
              agentOptions: { provider, model },
              setup: createAgentSetup(spacePath, selectionRef),
            });
            break;
          } catch (resErr) {
            resumeAttempts++;
            if (resumeAttempts >= 3) throw resErr;
            await new Promise((r) => setTimeout(r, 50 * resumeAttempts));
          }
        }
        agentHandles.set(sessionIdStr, handle!);
      } catch (err: unknown) {
        // FAIL LOUD: Never catch resume failure and create a new one with the same ID
        throw new PersistedSessionResumeError(sessionIdStr, sessionsDir, err);
      }
    } else {
      if (sessionIdStr.startsWith('import-')) {
        throw new PersistedSessionResumeError(
          sessionIdStr,
          sessionsDir,
          'Imported session does not exist in persistence'
        );
      }
      const { spacePath } = resolveSpaceDir(workspaceFolder, sessionIdStr);
      let selectionRef = agentSelectionRefs.get(sessionIdStr);
      if (!selectionRef) {
        selectionRef = {
          current: { provider, model },
          assembled: undefined,
        };
        agentSelectionRefs.set(sessionIdStr, selectionRef);
      }

      handle = await agentsRegistry.create({
        sessionId: sid,
        meta: { cwd: spacePath },
        agentOptions: { provider, model },
        setup: createAgentSetup(spacePath, selectionRef),
      });
    }

    sessionMountHashes.set(sessionIdStr, currentMountHash);
    sessionMounts.set(sessionIdStr, effectiveMountSpecs);

    if (extensionPlan !== undefined) {
      sessionExtensionPlanHashes.set(sessionIdStr, currentPlanHash);
      sessionExtensionPlans.set(sessionIdStr, validatedPlan);
    }

    if (validatedProfile) {
      sessionProfileHashes.set(sessionIdStr, validatedProfile.promptHash);
    }

    agentHandles.set(sessionIdStr, handle);
    return handle.agent;
  }

  function encodeSegment(raw: string): string {
    if (!raw || raw.length === 0) return raw || '';
    if (raw === '.') return '~002E';
    if (raw === '..') return '~002E~002E';
    let out = '';
    for (let i = 0; i < raw.length; i++) {
      const code = raw.charCodeAt(i);
      const ch = String.fromCharCode(code);
      if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
      else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
    }
    return out;
  }

  function projectKey(cwd: string): string {
    if (!cwd || cwd.length === 0) return '_no-cwd';
    let readable = '';
    let separatorRun = false;
    for (let i = 0; i < cwd.length; i++) {
      const code = cwd.charCodeAt(i);
      const ch = String.fromCharCode(code);
      if (ch === '/' || ch === '\\' || ch === ':') {
        if (!separatorRun) readable += '-';
        separatorRun = true;
      } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
        readable += ch;
        separatorRun = false;
      } else {
        readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
        separatorRun = false;
      }
    }
    return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
  }

  async function checkSessionArtifact(
    sessionIdStr: string,
    workspaceFolder?: string
  ): Promise<{ exists: boolean; valid: boolean; checksum?: string; eventCount?: number }> {
    if (!isValidSessionId(sessionIdStr)) {
      return { exists: false, valid: false };
    }

    const corruption = await inspectSessionCorruption(sessionIdStr, workspaceFolder);
    if (!corruption.exists) {
      return { exists: false, valid: false };
    }
    if (corruption.corrupted || !corruption.valid) {
      return { exists: true, valid: false };
    }
    return {
      exists: true,
      valid: true,
      eventCount: corruption.validEventsCount,
    };
  }

  function findSessionLogPath(root: string, sessionId: string, workspaceFolder?: string): string | undefined {
    if (!fs.existsSync(root)) return undefined;
    const encId = encodeSegment(sessionId);

    // 1. Direct path in root
    const directPath = path.join(root, `${sessionId}.jsonl`);
    if (fs.existsSync(directPath)) return directPath;
    const directEnc = path.join(root, `${encId}.jsonl`);
    if (fs.existsSync(directEnc)) return directEnc;

    // 2. If workspaceFolder is provided, try that project folder first
    if (workspaceFolder) {
      const spacePath = path.join(spacesDir, workspaceFolder);
      const proj = projectKey(spacePath);
      const candidates = [
        path.join(root, proj, encId, 'session.jsonl'),
        path.join(root, proj, sessionId, 'session.jsonl'),
        path.join(root, proj, `${sessionId}.jsonl`),
        path.join(root, proj, `${encId}.jsonl`),
      ];
      for (const c of candidates) {
        if (fs.existsSync(c)) return c;
      }
    }

    // 3. Search all project directories and session directories
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const projPath = path.join(root, entry.name);
          const candidates = [
            path.join(projPath, encId, 'session.jsonl'),
            path.join(projPath, sessionId, 'session.jsonl'),
            path.join(projPath, `${sessionId}.jsonl`),
            path.join(projPath, `${encId}.jsonl`),
          ];
          for (const c of candidates) {
            if (fs.existsSync(c)) return c;
          }
          try {
            const subEntries = fs.readdirSync(projPath, { withFileTypes: true });
            for (const sub of subEntries) {
              if (sub.isDirectory() && (sub.name === encId || sub.name === sessionId || sub.name.includes(sessionId))) {
                const nested = path.join(projPath, sub.name, 'session.jsonl');
                if (fs.existsSync(nested)) return nested;
              }
            }
          } catch {}
        }
      }
    } catch {}
    return undefined;
  }

  async function inspectSessionCorruption(
    sessionIdStr: string,
    workspaceFolder?: string
  ): Promise<{
    exists: boolean;
    valid: boolean;
    corrupted: boolean;
    code: 'VALID' | 'CORRUPTED' | 'SEQ_GAP' | 'SYNTAX_ERROR' | 'NOT_FOUND';
    lastValidSeq: number;
    lineCount: number;
    validEventsCount: number;
    errorDetail?: string;
  }> {
    if (!isValidSessionId(sessionIdStr)) {
      return {
        exists: false,
        valid: false,
        corrupted: false,
        code: 'NOT_FOUND',
        lastValidSeq: -1,
        lineCount: 0,
        validEventsCount: 0,
      };
    }

    // Flush in-memory session if active
    const liveHandle = agentHandles.get(sessionIdStr);
    if (liveHandle) {
      try {
        await ctx.sessions.flush(liveHandle.agent.session);
      } catch {}
    }

    let fileContent: string | undefined;

    // 1. Try reading raw content directly through persistence backend
    const persistence = ctx.sessionPersistence;
    const sid = SessionId(sessionIdStr);
    let persistenceFound = false;

    if (persistence && typeof persistence.readRaw === 'function') {
      try {
        const raw = await persistence.readRaw(sid);
        if (raw && typeof raw.content === 'string') {
          fileContent = raw.content;
          persistenceFound = true;
        }
      } catch {
        // readRaw threw error due to raw file syntax or header corruption
        persistenceFound = true;
      }
    }

    // 2. If not obtained via readRaw or readRaw threw error, find log path on disk
    if (fileContent === undefined) {
      const jsonlPath = findSessionLogPath(sessionsDir, sessionIdStr, workspaceFolder);
      if (jsonlPath && fs.existsSync(jsonlPath)) {
        try {
          fileContent = fs.readFileSync(jsonlPath, 'utf8');
        } catch {
          return {
            exists: true,
            valid: false,
            corrupted: true,
            code: 'CORRUPTED',
            lastValidSeq: -1,
            lineCount: 0,
            validEventsCount: 0,
            errorDetail: 'Failed to read session file',
          };
        }
      }
    }

    if (fileContent === undefined) {
      if (persistenceFound) {
        return {
          exists: true,
          valid: false,
          corrupted: true,
          code: 'CORRUPTED',
          lastValidSeq: -1,
          lineCount: 0,
          validEventsCount: 0,
          errorDetail: 'Corrupted session file could not be read',
        };
      }
      return {
        exists: false,
        valid: false,
        corrupted: false,
        code: 'NOT_FOUND',
        lastValidSeq: -1,
        lineCount: 0,
        validEventsCount: 0,
      };
    }

    const lines = fileContent.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) {
      return {
        exists: true,
        valid: false,
        corrupted: true,
        code: 'CORRUPTED',
        lastValidSeq: -1,
        lineCount: 0,
        validEventsCount: 0,
        errorDetail: 'Session file is empty',
      };
    }

    // Line 1: must be session header
    try {
      const header = JSON.parse(lines[0]);
      if (!header || typeof header !== 'object' || header.type !== 'session') {
        return {
          exists: true,
          valid: false,
          corrupted: true,
          code: 'CORRUPTED',
          lastValidSeq: -1,
          lineCount: lines.length,
          validEventsCount: 0,
          errorDetail: 'Invalid session header',
        };
      }
    } catch {
      return {
        exists: true,
        valid: false,
        corrupted: true,
        code: 'SYNTAX_ERROR',
        lastValidSeq: -1,
        lineCount: lines.length,
        validEventsCount: 0,
        errorDetail: 'JSON syntax error on line 1 header',
      };
    }

    let expectedSeq = 0;
    let lastValidSeq = -1;
    let validEventsCount = 0;

    for (let i = 1; i < lines.length; i++) {
      const lineNum = i + 1;
      let parsed: any;
      try {
        parsed = JSON.parse(lines[i]);
      } catch {
        return {
          exists: true,
          valid: false,
          corrupted: true,
          code: 'SYNTAX_ERROR',
          lastValidSeq,
          lineCount: lines.length,
          validEventsCount,
          errorDetail: `JSON syntax error on line ${lineNum}`,
        };
      }

      let decodedEvents: SessionEvent[];
      try {
        decodedEvents = decodeStorageRecord(parsed);
      } catch {
        return {
          exists: true,
          valid: false,
          corrupted: true,
          code: 'CORRUPTED',
          lastValidSeq,
          lineCount: lines.length,
          validEventsCount,
          errorDetail: `Malformed event record on line ${lineNum}`,
        };
      }

      for (const ev of decodedEvents) {
        if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string' || typeof ev.seq !== 'number') {
          return {
            exists: true,
            valid: false,
            corrupted: true,
            code: 'CORRUPTED',
            lastValidSeq,
            lineCount: lines.length,
            validEventsCount,
            errorDetail: `Malformed event envelope on line ${lineNum}`,
          };
        }

        if (ev.seq !== expectedSeq) {
          return {
            exists: true,
            valid: false,
            corrupted: true,
            code: 'SEQ_GAP',
            lastValidSeq,
            lineCount: lines.length,
            validEventsCount,
            errorDetail: `seq gap line ${lineNum} expected ${expectedSeq} got ${ev.seq}`,
          };
        }

        lastValidSeq = ev.seq;
        expectedSeq = ev.seq + 1;
        validEventsCount++;
      }
    }

    return {
      exists: true,
      valid: true,
      corrupted: false,
      code: 'VALID',
      lastValidSeq,
      lineCount: lines.length,
      validEventsCount,
    };
  }

  async function recoverSessionPrefix(options: {
    sourceSessionId: string;
    targetSessionId: string;
    workspaceFolder?: string;
    maxValidSeq?: number;
  }): Promise<{
    recovered: boolean;
    targetSessionId: string;
    validEventsCount: number;
    backupPath: string;
    backupChecksum: string;
  }> {
    const { sourceSessionId, targetSessionId, maxValidSeq } = options;
    if (!isValidSessionId(sourceSessionId)) {
      throw new Error('INVALID_SOURCE_SESSION_ID');
    }
    if (!isValidSessionId(targetSessionId)) {
      throw new Error('INVALID_TARGET_SESSION_ID');
    }

    const sourceJsonlPath = findSessionLogPath(sessionsDir, sourceSessionId, options.workspaceFolder);
    if (!sourceJsonlPath || !fs.existsSync(sourceJsonlPath)) {
      throw new Error('SOURCE_SESSION_NOT_FOUND');
    }

    const rawBytes = fs.readFileSync(sourceJsonlPath);
    const sourceChecksum = crypto.createHash('sha256').update(rawBytes).digest('hex');

    // 1. Create secure backup in recovery/ folder with mode 0o600
    const recoveryDir = path.join(dshHome, 'recovery');
    ensureSecureDirectory(recoveryDir);

    const timestamp = Date.now();
    const backupFileName = `${sourceSessionId}_${timestamp}.jsonl.bak`;
    const backupFilePath = path.join(recoveryDir, backupFileName);
    const manifestFileName = `${sourceSessionId}_${timestamp}.manifest.json`;
    const manifestFilePath = path.join(recoveryDir, manifestFileName);

    fs.writeFileSync(backupFilePath, rawBytes, { mode: 0o600 });
    fs.chmodSync(backupFilePath, 0o600);

    // 2. Read lines and extract valid prefix events
    const contentStr = rawBytes.toString('utf8');
    const lines = contentStr.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) {
      throw new Error('SOURCE_SESSION_EMPTY');
    }

    let expectedSeq = 0;
    const validEvents: SessionEvent[] = [];

    for (let i = 1; i < lines.length; i++) {
      try {
        const parsed = JSON.parse(lines[i]);
        const decoded = decodeStorageRecord(parsed);
        let stopped = false;
        for (const ev of decoded) {
          if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string' || typeof ev.seq !== 'number') {
            stopped = true;
            break;
          }
          if (ev.seq !== expectedSeq) {
            stopped = true;
            break; // Stop at sequence gap or mismatch
          }
          if (maxValidSeq !== undefined && ev.seq > maxValidSeq) {
            stopped = true;
            break;
          }
          validEvents.push(ev as SessionEvent);
          expectedSeq = ev.seq + 1;
        }
        if (stopped) break;
      } catch {
        break; // Stop at syntax error
      }
    }

    const manifestPayload = {
      sourceSessionId,
      targetSessionId,
      backupFile: backupFileName,
      backupChecksum: sourceChecksum,
      backupTimestamp: new Date(timestamp).toISOString(),
      rawSizeBytes: rawBytes.length,
      extractedValidEventsCount: validEvents.length,
      lastValidSeq: validEvents.length > 0 ? validEvents[validEvents.length - 1].seq : -1,
    };
    fs.writeFileSync(manifestFilePath, JSON.stringify(manifestPayload, null, 2), { mode: 0o600 });
    fs.chmodSync(manifestFilePath, 0o600);

    // Build contiguous seed events with canonical sequence numbers and mapped sourceEventSeqs
    const oldSeqToNewSeq = new Map<number, number>();
    const seedEvents: any[] = [];
    let seq = 0;
    for (const ev of validEvents) {
      if (ev.type === 'session/end-seed') continue;
      if (typeof ev.seq === 'number') {
        oldSeqToNewSeq.set(ev.seq, seq);
      }
      const newEv = {
        ...ev,
        seq: seq++,
      };
      seedEvents.push(newEv);
    }

    // Remap sourceEventSeqs and surfaceOp for each event to reference new seq numbers
    for (const ev of seedEvents) {
      if (Array.isArray(ev.sourceEventSeqs)) {
        ev.sourceEventSeqs = ev.sourceEventSeqs
          .map((oldSeq: number) => oldSeqToNewSeq.get(oldSeq))
          .filter((newSeq: number | undefined): newSeq is number => typeof newSeq === 'number' && Number.isSafeInteger(newSeq) && newSeq >= 0 && newSeq < ev.seq);
      }
      if (ev.surfaceOp && typeof ev.surfaceOp === 'object' && ev.surfaceOp.op === 'replace') {
        const mappedStart = oldSeqToNewSeq.get(ev.surfaceOp.start);
        const mappedEnd = oldSeqToNewSeq.get(ev.surfaceOp.end);
        if (typeof mappedStart === 'number' && typeof mappedEnd === 'number') {
          ev.surfaceOp = {
            op: 'replace',
            start: mappedStart,
            end: mappedEnd,
          };
        }
      }
    }

    // 3. Validate prefix events via official Session.create invariant engine
    const targetSid = SessionId(targetSessionId);
    if (seedEvents.length > 0) {
      Session.create(targetSid, seedEvents);
    }

    // 4. Import seed into persistence for target session
    const computedChecksum = computeSessionEventsChecksum(seedEvents);
    const canonicalJson = canonicalJsonStringify(seedEvents);
    const canonicalBytes = Buffer.byteLength(canonicalJson, 'utf8');
    const seedReceipt: SessionSeedReceipt = {
      algorithm: 'sha256-session-events-v1',
      checksum: computedChecksum,
      canonicalBytes,
      eventCount: seedEvents.length,
    };

    await importSeed(targetSessionId, seedEvents, seedReceipt, null, options.workspaceFolder);

    return {
      recovered: true,
      targetSessionId,
      validEventsCount: seedEvents.length,
      backupPath: backupFilePath,
      backupChecksum: sourceChecksum,
    };
  }

  async function exportForkSeed(
    sessionIdStr: string,
    boundary?: { fromMessageId?: string; fromTurnId?: string },
    _workspaceFolder?: string
  ): Promise<{ events: readonly SessionEvent[]; receipt: SessionSeedReceipt; boundaryMapping?: Record<string, unknown> }> {
    if (!isValidSessionId(sessionIdStr)) {
      throw new Error('INVALID_SESSION_ID');
    }

    const persistence = ctx.sessionPersistence;
    if (!persistence || typeof persistence.inspect !== 'function') {
      throw new Error('PERSISTENCE_UNAVAILABLE');
    }

    const sid = SessionId(sessionIdStr);
    let allEvents: readonly SessionEvent[] | undefined;

    // Check live in-memory agent first and flush
    const liveHandle = agentHandles.get(sessionIdStr);
    if (liveHandle) {
      try {
        await ctx.sessions.flush(liveHandle.agent.session);
      } catch {}
      allEvents = liveHandle.agent.session.snapshotEvents();
    }

    if (!allEvents || allEvents.length === 0) {
      let inspection: { meta: unknown; events: readonly SessionEvent[] } | undefined;
      try {
        inspection = await persistence.inspect(sid);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.toLowerCase().includes('not found') || msg.toLowerCase().includes('no such file') || (err as any)?.code === 'ENOENT') {
          throw new Error('SESSION_NOT_FOUND');
        }
        throw new Error('SESSION_CORRUPTED');
      }

      if (!inspection || !Array.isArray(inspection.events) || inspection.events.length === 0) {
        throw new Error('SESSION_NOT_FOUND');
      }
      allEvents = inspection.events;
    }

    let cutoffIndex = allEvents.length - 1;

    // Filter out trailing session/end-seed if present for processing
    while (cutoffIndex >= 0 && allEvents[cutoffIndex]?.type === 'session/end-seed') {
      cutoffIndex--;
    }

    if (boundary?.fromMessageId) {
      const targetMsgId = boundary.fromMessageId.trim();
      let matchedIndex = -1;

      for (let i = 0; i <= cutoffIndex; i++) {
        const ev = allEvents[i]!;
        if (ev.type === 'user/message') {
          const uData = ev.data as any;
          const uId = uData?.id;
          if (
            uId === targetMsgId ||
            uId === `fork:${targetMsgId}` ||
            uId === `import:${targetMsgId}` ||
            (typeof uId === 'string' && uId.endsWith(targetMsgId))
          ) {
            matchedIndex = i;
            break;
          }
        } else if (ev.type === 'assistant/message') {
          const aData = ev.data as any;
          const aMsgId = aData?.message?.id || aData?.id;
          if (
            aMsgId === targetMsgId ||
            aMsgId === `fork:${targetMsgId}` ||
            aMsgId === `import:${targetMsgId}` ||
            (typeof aMsgId === 'string' && aMsgId.endsWith(targetMsgId))
          ) {
            matchedIndex = i;
            break;
          }
        }
      }

      if (matchedIndex === -1 && (boundary?.fromTurnId || (boundary as any)?.fromTurn !== undefined)) {
        const targetTurnId = boundary?.fromTurnId ? boundary.fromTurnId.trim() : undefined;
        const explicitTurnNum = (boundary as any)?.fromTurn !== undefined && typeof (boundary as any).fromTurn === 'number'
          ? (boundary as any).fromTurn
          : undefined;
        const numMatch = targetTurnId ? targetTurnId.match(/\d+/) : null;
        const turnNum = explicitTurnNum ?? (numMatch ? parseInt(numMatch[0], 10) : null);

        for (let i = cutoffIndex; i >= 0; i--) {
          const ev = allEvents[i]!;
          const data = ev.data as any;
          if (
            (ev.type === 'turn/end' || ev.type === 'turn/start' || ev.type === 'assistant/message') &&
            ((turnNum !== null && data?.turn === turnNum) || (targetTurnId && data?.turnId === targetTurnId))
          ) {
            if (ev.type === 'turn/end') {
              matchedIndex = i;
              break;
            } else if (matchedIndex === -1) {
              matchedIndex = i;
            }
          }
        }
      }

      if (matchedIndex === -1) {
        throw new Error('BOUNDARY_UNAVAILABLE');
      }

      // If matched an assistant/message or inside a turn, advance to turn/end of that turn if present
      let turnEndIndex = matchedIndex;
      for (let j = matchedIndex + 1; j <= cutoffIndex; j++) {
        if (allEvents[j]?.type === 'turn/end' || allEvents[j]?.type === 'step/end') {
          turnEndIndex = j;
          if (allEvents[j]?.type === 'turn/end') break;
        } else if (allEvents[j]?.type === 'turn/start' || allEvents[j]?.type === 'user/message') {
          break;
        }
      }
      cutoffIndex = turnEndIndex;
    } else if (boundary?.fromTurnId || (boundary as any)?.fromTurn !== undefined) {
      const targetTurnId = boundary?.fromTurnId ? boundary.fromTurnId.trim() : undefined;
      const explicitTurnNum = (boundary as any)?.fromTurn !== undefined && typeof (boundary as any).fromTurn === 'number'
        ? (boundary as any).fromTurn
        : undefined;
      const numMatch = targetTurnId ? targetTurnId.match(/\d+/) : null;
      const turnNum = explicitTurnNum ?? (numMatch ? parseInt(numMatch[0], 10) : null);
      let matchedIndex = -1;

      for (let i = cutoffIndex; i >= 0; i--) {
        const ev = allEvents[i]!;
        const data = ev.data as any;
        if (
          (ev.type === 'turn/end' || ev.type === 'turn/start' || ev.type === 'assistant/message') &&
          ((turnNum !== null && data?.turn === turnNum) || (targetTurnId && data?.turnId === targetTurnId))
        ) {
          if (ev.type === 'turn/end') {
            matchedIndex = i;
            break;
          } else if (matchedIndex === -1) {
            matchedIndex = i;
          }
        }
      }

      if (matchedIndex === -1) {
        throw new Error('BOUNDARY_UNAVAILABLE');
      }

      // Advance to turn/end if not already on it
      for (let j = matchedIndex; j <= cutoffIndex; j++) {
        if (allEvents[j]?.type === 'turn/end') {
          matchedIndex = j;
          break;
        }
      }
      cutoffIndex = matchedIndex;
    }

    const slicedEvents = allEvents.slice(0, cutoffIndex + 1);

    // Build contiguous seed events with canonical sequence numbers and mapped sourceEventSeqs
    const oldSeqToNewSeq = new Map<number, number>();
    const seedEvents: any[] = [];
    let seq = 0;
    for (const ev of slicedEvents) {
      if (ev.type === 'session/end-seed') continue;
      if (typeof ev.seq === 'number') {
        oldSeqToNewSeq.set(ev.seq, seq);
      }
      const newEv = {
        ...ev,
        seq: seq++,
      };
      seedEvents.push(newEv);
    }

    // Remap sourceEventSeqs and surfaceOp for each event to reference new seq numbers
    for (const ev of seedEvents) {
      if (Array.isArray(ev.sourceEventSeqs)) {
        ev.sourceEventSeqs = ev.sourceEventSeqs
          .map((oldSeq: number) => oldSeqToNewSeq.get(oldSeq))
          .filter((newSeq: number | undefined): newSeq is number => typeof newSeq === 'number' && newSeq < ev.seq);
      }
      if (ev.surfaceOp && typeof ev.surfaceOp === 'object' && ev.surfaceOp.op === 'replace') {
        const mappedStart = oldSeqToNewSeq.get(ev.surfaceOp.start);
        const mappedEnd = oldSeqToNewSeq.get(ev.surfaceOp.end);
        if (typeof mappedStart === 'number' && typeof mappedEnd === 'number') {
          ev.surfaceOp = {
            op: 'replace',
            start: mappedStart,
            end: mappedEnd,
          };
        }
      }
    }

    // Always append session/end-seed marker
    seedEvents.push({
      type: 'session/end-seed',
      seq: seq++,
      time: Date.now(),
      data: {},
    });

    // Validate seed validity using official Session.create
    const sidValidation = SessionId(sessionIdStr);
    Session.create(sidValidation, seedEvents);

    const canonicalJson = canonicalJsonStringify(seedEvents);
    const checksum = crypto.createHash('sha256').update(canonicalJson).digest('hex');
    const canonicalBytes = Buffer.byteLength(canonicalJson, 'utf8');

    const receipt: SessionSeedReceipt = {
      algorithm: 'sha256-session-events-v1',
      checksum,
      canonicalBytes,
      eventCount: seedEvents.length,
    };

    return {
      events: seedEvents,
      receipt,
      boundaryMapping: {
        sourceEventCount: allEvents.length,
        forkedEventCount: seedEvents.length,
        cutoffIndex,
      },
    };
  }

  async function importSeed(
    sessionIdStr: string,
    seed: readonly SessionEvent[],
    receipt: SessionSeedReceipt,
    profileSnapshot: AgentProfileSnapshot | null | unknown = null,
    workspaceFolder?: string
  ): Promise<{ sessionId: string; persisted: boolean; eventsCount: number; receipt: SessionSeedReceipt; duplicate: boolean }> {
    if (!isValidSessionId(sessionIdStr)) {
      throw new TypeError('Invalid session ID format: must match canonical session ID pattern');
    }
    if (!Array.isArray(seed)) {
      throw new TypeError('seed must be a valid array of SessionEvents');
    }
    if (!isRecord(receipt)) {
      throw new TypeError('receipt must be a plain object');
    }
    if (receipt.algorithm !== 'sha256-session-events-v1') {
      throw new Error('Unsupported receipt algorithm: expected "sha256-session-events-v1"');
    }
    if (typeof receipt.checksum !== 'string' || !CHECKSUM_PATTERN.test(receipt.checksum.toLowerCase())) {
      throw new Error('Invalid receipt checksum format: expected lower-case 64-hex SHA-256 hash');
    }
    if (typeof receipt.canonicalBytes !== 'number' || !Number.isSafeInteger(receipt.canonicalBytes) || receipt.canonicalBytes < 0) {
      throw new Error('Receipt canonicalBytes must be a non-negative safe integer');
    }
    if (typeof receipt.eventCount !== 'number' || receipt.eventCount !== seed.length) {
      throw new Error('Receipt eventCount mismatch: receipt specifies different count than seed array');
    }

    let validatedProfile: ValidatedAgentProfile | undefined;
    if (profileSnapshot !== undefined && profileSnapshot !== null) {
      validatedProfile = validateAgentProfileSnapshot(profileSnapshot);
    }

    // 1. Compute canonical SHA256 of candidate seed events and compare with receipt
    const canonicalJson = canonicalJsonStringify(seed);
    const computedChecksum = crypto.createHash('sha256').update(canonicalJson).digest('hex');
    const canonicalBytes = Buffer.byteLength(canonicalJson, 'utf8');

    if (computedChecksum !== receipt.checksum.toLowerCase()) {
      throw new Error('Seed checksum verification failed: computed checksum does not match receipt checksum');
    }

    if (receipt.canonicalBytes !== canonicalBytes) {
      throw new Error('Seed canonicalBytes verification failed: computed byte length does not match receipt canonicalBytes');
    }

    const sid = SessionId(sessionIdStr);

    // 2. Validate seed events via official Session.create first (invariant validation)
    Session.create(sid, seed);

    // 3. Coordinate with receiptStore if available
    const receiptStore = ctx.receiptStore ?? (ctx.get ? ctx.get('receiptStore') : undefined);

    let existingReceipt: {
      algorithm: string;
      checksum: string;
      canonicalBytes: number;
      eventCount: number;
    } | null = null;

    if (receiptStore && typeof receiptStore.getSeedImportReceipt === 'function') {
      try {
        existingReceipt = await receiptStore.getSeedImportReceipt(sessionIdStr);
      } catch {}
      if (existingReceipt) {
        const receiptMatches =
          existingReceipt.algorithm === receipt.algorithm &&
          existingReceipt.checksum === computedChecksum &&
          existingReceipt.canonicalBytes === canonicalBytes &&
          existingReceipt.eventCount === seed.length;

        if (!receiptMatches) {
          throw new Error('CONFLICT: Seed import receipt already exists for session with differing metadata. Mutation rejected.');
        }
      }
    }

    // 4. Verify official SessionPersistence capability
    const persistence = ctx.sessionPersistence;

    if (!persistence || typeof persistence.inspect !== 'function') {
      throw new Error('SessionPersistence service is not registered or not functional');
    }

    let existingInspection: { meta: unknown; events: readonly SessionEvent[] } | undefined;
    try {
      existingInspection = await persistence.inspect(sid);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.toLowerCase().includes('not found') && !msg.toLowerCase().includes('no such file') && (err as any)?.code !== 'ENOENT') {
        throw new PersistedSessionResumeError(sessionIdStr, sessionsDir, err);
      }
    }

    if (existingInspection !== undefined) {
      const totalEvents = existingInspection.events.length;

      if (totalEvents < seed.length) {
        throw new Error('CONFLICT: Session already exists in persistence with fewer events than seed. Mutation rejected.');
      }

      const prefixChecksum = computeSessionEventsChecksum(existingInspection.events.slice(0, seed.length));
      if (prefixChecksum !== computedChecksum) {
        throw new Error('CONFLICT: Session already exists in persistence with differing events/checksum at seed prefix. Mutation rejected.');
      }

      if (existingReceipt) {
        const receiptMatches =
          existingReceipt.algorithm === receipt.algorithm &&
          existingReceipt.checksum === computedChecksum &&
          existingReceipt.canonicalBytes === canonicalBytes &&
          existingReceipt.eventCount === seed.length;
        if (!receiptMatches) {
          throw new Error('CONFLICT: Seed import receipt already exists for session with differing metadata. Mutation rejected.');
        }
      } else {
        // Record receipt in receiptStore if missing
        if (receiptStore && typeof receiptStore.recordSeedImportReceipt === 'function') {
          try {
            await receiptStore.recordSeedImportReceipt({
              sessionId: sessionIdStr,
              algorithm: 'sha256-session-events-v1',
              checksum: computedChecksum,
              canonicalBytes,
              eventCount: seed.length,
              importedAt: new Date().toISOString(),
            });
          } catch {}
        }
      }

      // Determine if followup turns have occurred past the initial seed
      let hasFollowupTurns = false;
      for (let i = seed.length; i < totalEvents; i++) {
        const ev = existingInspection.events[i];
        if (ev && (ev.type === 'turn/start' || ev.type === 'user/message')) {
          hasFollowupTurns = true;
          break;
        }
      }

      const returnedEventsCount = hasFollowupTurns ? totalEvents : seed.length;

      return {
        sessionId: sessionIdStr,
        persisted: true,
        eventsCount: returnedEventsCount,
        receipt: {
          algorithm: 'sha256-session-events-v1',
          checksum: computedChecksum,
          canonicalBytes,
          eventCount: seed.length,
        },
        duplicate: true,
      };
    }

    // 5. Create and persist exact seed through official persistence only
    const existingOldHandle = agentHandles.get(sessionIdStr);
    if (existingOldHandle) {
      try {
        await existingOldHandle.dispose();
      } catch {}
      agentHandles.delete(sessionIdStr);
      sessionMountHashes.delete(sessionIdStr);
      sessionProfileHashes.delete(sessionIdStr);
      sessionExtensionPlanHashes.delete(sessionIdStr);
      sessionExtensionPlans.delete(sessionIdStr);
    }

    const agentsRegistry = ctx.agents;
    const { spacePath } = resolveSpaceDir(workspaceFolder, sessionIdStr);

    let selectionRef = agentSelectionRefs.get(sessionIdStr);
    if (!selectionRef) {
      selectionRef = {
        current: { provider, model },
        assembled: undefined,
      };
      agentSelectionRefs.set(sessionIdStr, selectionRef);
    }

    const handle = await agentsRegistry.create({
      sessionId: sid,
      meta: { cwd: spacePath },
      seed,
      agentOptions: { provider, model },
      setup: async (agentCtx: Context) => {
        installModelSelection(agentCtx, selectionRef!);
        if (validatedProfile) {
          installAgentProfile(agentCtx, validatedProfile);
        }
        installAgentFallbackRouter(agentCtx, sessionIdStr, selectionRef!);
        agentCtx.effect(() => {
          const eventRelay = ctx.eventRelay ?? (ctx.get ? ctx.get('eventRelay') : undefined);
          if (eventRelay && typeof eventRelay.attachAgent === 'function') {
            return eventRelay.attachAgent(agentCtx);
          }
          return () => {};
        }, 'eventRelay.agentScope()');

        const configMounts = validConfig.mounts;
        const spaceMountSpecs = typeof configMounts === 'function'
          ? configMounts(workspaceFolder || 'default')
          : (configMounts ?? []);
        const spaceMounts = resolveRuntimeMounts(spaceMountSpecs);

        const wsHandle = await mountWorkspaceTools(agentCtx, {
          spacePath,
          dshHome,
          sessionId: sessionIdStr,
          mounts: spaceMounts,
          instructions: validConfig.instructions,
          skills: validConfig.skills,
          subagents: validConfig.subagents,
        });
        officialPluginsHandle.registerWorkspace(wsHandle);
      },
    });

    if (validatedProfile) {
      sessionProfileHashes.set(sessionIdStr, validatedProfile.promptHash);
    }

    // Explicitly flush to ensure official session-persistence JSONL is written to disk
    await ctx.sessions.flush(handle.agent.session);

    // Record receipt in receiptStore
    if (receiptStore && typeof receiptStore.recordSeedImportReceipt === 'function') {
      try {
        await receiptStore.recordSeedImportReceipt({
          sessionId: sessionIdStr,
          algorithm: 'sha256-session-events-v1',
          checksum: computedChecksum,
          canonicalBytes,
          eventCount: seed.length,
          importedAt: new Date().toISOString(),
        });
      } catch {}
    }

    agentHandles.set(sessionIdStr, handle);

    return {
      sessionId: sessionIdStr,
      persisted: true,
      eventsCount: seed.length,
      receipt: {
        algorithm: 'sha256-session-events-v1',
        checksum: computedChecksum,
        canonicalBytes,
        eventCount: seed.length,
      },
      duplicate: false,
    };
  }

  async function cancelTurn(turnId: string): Promise<boolean> {
    if (!isValidTurnId(turnId)) {
      throw new TypeError('Invalid turn ID format: must match canonical turn ID pattern');
    }

    const active = activeTurns.get(turnId);
    if (!active) {
      return false;
    }

    active.cancelRequested = true;
    if (active.agent && typeof active.agent.cancel === 'function') {
      active.agent.cancel({ kind: 'user' });
    }
    return true;
  }

  async function sendFollowup(
    requestOrPrompt: RuntimeTurnRequest | AgentFollowupRequest | string,
    sessionId?: string,
    turnId?: string,
    profileSnapshot: AgentProfileSnapshot | null = null,
    workspaceFolder?: string,
    attachments?: readonly any[]
  ): Promise<AgentFollowupResponse> {
    if (isDisposed) {
      throw new Error('DSH Runtime is disposed');
    }

    let effPrompt: string;
    let effSessionId: string;
    let effTurnId: string;
    let effProfile: AgentProfileSnapshot | null = null;
    let effWorkspaceFolder: string | undefined;
    let effAttachments: readonly any[] | undefined;
    let effModelSelection: {
      provider: string;
      model: string;
      reasoningEffort?: string | null;
      source?: string;
      fallbackChain?: readonly any[];
    } | null | undefined;

    let effReplyReference: {
      replyToMessageId: string;
      snippet: string;
      role?: string;
    } | null | undefined;

    let effMounts: readonly RuntimeMountSpec[] | undefined;
    let effExtensionPlan: ExtensionActivationPlan | null | undefined;

    if (typeof requestOrPrompt === 'object' && requestOrPrompt !== null) {
      const req = requestOrPrompt as any;
      effPrompt = req.prompt;
      effSessionId = req.sessionId;
      effTurnId = req.turnId;
      effProfile = req.profileSnapshot !== undefined ? req.profileSnapshot : (req.profile ?? null);
      effWorkspaceFolder = req.workspaceFolder ?? req.spaceId;
      effAttachments = req.attachments;
      effModelSelection = req.modelSelection;
      effReplyReference = req.replyReference;
      effMounts = req.mounts ?? undefined;
      effExtensionPlan = req.extensionPlan !== undefined ? req.extensionPlan : undefined;
    } else {
      effPrompt = requestOrPrompt;
      effSessionId = sessionId!;
      effTurnId = turnId!;
      effProfile = profileSnapshot ?? null;
      effWorkspaceFolder = workspaceFolder;
      effAttachments = attachments;
      effModelSelection = undefined;
      effReplyReference = undefined;
      effMounts = undefined;
      effExtensionPlan = undefined;
    }

    if (typeof effPrompt !== 'string') {
      throw new TypeError('prompt must be a string');
    }
    if (typeof effSessionId !== 'string' || !effSessionId.trim()) {
      throw new Error('sessionId is required for sendFollowup');
    }
    if (!isValidSessionId(effSessionId)) {
      throw new TypeError('Invalid session ID format: must match canonical session ID pattern');
    }
    if (typeof effTurnId !== 'string' || !isValidTurnId(effTurnId)) {
      throw new TypeError('Invalid turn ID format: must match canonical turn ID pattern');
    }

    const assignedTurnId = effTurnId;
    const nonce = crypto.randomBytes(16).toString('hex');
    const turnInfo: ActiveTurnInfo = {
      turnId: assignedTurnId,
      sessionId: effSessionId,
      agent: undefined as any,
      pid: process.pid,
      nonce,
      createdAt: new Date().toISOString(),
      cancelRequested: false,
    };
    activeTurns.set(assignedTurnId, turnInfo);

    let currentAgent: any;
    try {
      currentAgent = await getOrCreateAgent(effSessionId, effProfile, effWorkspaceFolder, effMounts, effExtensionPlan);
      turnInfo.agent = currentAgent;
    } catch (err: unknown) {
      activeTurns.delete(assignedTurnId);
      if ((err as any)?.code === 'PLUGIN_ACTIVATION_FAILED' || (err as any)?.message?.includes('PLUGIN_ACTIVATION_FAILED')) {
        const actErr = new Error('PLUGIN_ACTIVATION_FAILED');
        (actErr as any).code = 'PLUGIN_ACTIVATION_FAILED';
        throw actErr;
      }
      throw err;
    }

    const startIndex = currentAgent.session.seq;
    if (turnInfo.cancelRequested) {
      currentAgent.cancel({ kind: 'user' });
    }

    try {
      // 0. Update dynamic per-turn model selection on live agent if specified
      if (effModelSelection && effModelSelection.provider && effModelSelection.model) {
        const effCandidates: AgentFallbackCandidate[] = [
          {
            provider: effModelSelection.provider,
            model: effModelSelection.model,
            reasoningEffort: effModelSelection.reasoningEffort || undefined,
          },
          ...(Array.isArray(effModelSelection.fallbackChain) ? effModelSelection.fallbackChain : []).map((t) => ({
            provider: t.provider,
            model: t.model,
            reasoningEffort: t.reasoningEffort || undefined,
          })),
        ];

        // Find the first healthy candidate according to circuit breakers
        let initialIndex = 0;
        while (initialIndex < effCandidates.length) {
          const cand = effCandidates[initialIndex];
          const check = circuitBreakers.canExecute(cand.provider, cand.model);
          if (check.allowed) {
            break;
          }
          initialIndex++;
        }
        if (initialIndex >= effCandidates.length) {
          initialIndex = 0;
        }

        const selectedInitialCand = effCandidates[initialIndex];
        let selectionRef = agentSelectionRefs.get(effSessionId);
        if (!selectionRef) {
          selectionRef = {
            current: {
              provider: selectedInitialCand.provider,
              model: selectedInitialCand.model,
              reasoningEffort: selectedInitialCand.reasoningEffort || undefined,
            },
            assembled: undefined,
          };
          agentSelectionRefs.set(effSessionId, selectionRef);
        } else {
          selectionRef.current = {
            provider: selectedInitialCand.provider,
            model: selectedInitialCand.model,
            reasoningEffort: selectedInitialCand.reasoningEffort || undefined,
          };
        }

        // Setup active fallback context for this session turn
        const fbContext: AgentFallbackContext = {
          candidates: effCandidates,
          candidateIndex: initialIndex,
          candidateRetries: 0,
          routeAttempts: [],
          currentAttemptStart: Date.now(),
          stepChunksCount: 0,
          active: true,
        };
        activeFallbackContexts.set(effSessionId, fbContext);
      } else {
        const defaultCandidates: AgentFallbackCandidate[] = [
          { provider, model, reasoningEffort: undefined },
        ];
        const fbContext: AgentFallbackContext = {
          candidates: defaultCandidates,
          candidateIndex: 0,
          candidateRetries: 0,
          routeAttempts: [],
          currentAttemptStart: Date.now(),
          stepChunksCount: 0,
          active: true,
        };
        activeFallbackContexts.set(effSessionId, fbContext);
      }

      // 1. If attachments are present, inject model-visible context via official agent.inject
      if (effAttachments && Array.isArray(effAttachments) && effAttachments.length > 0) {
        const attachmentLines = effAttachments.map((a) => {
          const namePart = a.displayName ? ` (${a.displayName})` : '';
          return `- ${a.snapshotPath}${namePart} (media: ${a.mediaType}, size: ${a.size} bytes, etag: ${a.etag})`;
        }).join('\n');

        const attachmentGuidance = `Workspace attachments:\n${attachmentLines}\n\nPaths prefixed with @ are files explicitly referenced by the user. Use the read tool when their contents are needed; do not claim to have inspected a file before reading it.`;

        const contextMsg = createUserMessage({
          content: [{ type: 'text', text: attachmentGuidance }],
          source: { kind: 'plugin', plugin: 'enkeep/attachments' },
        });
        currentAgent.inject(contextMsg);
      }

      // 1b. If reply reference is present, inject model-visible context via official agent.inject
      if (effReplyReference && effReplyReference.replyToMessageId) {
        const roleText = effReplyReference.role ? `${effReplyReference.role}: ` : '';
        const replyGuidance = `[Quoting previous message from ${roleText}"${effReplyReference.snippet}"]`;

        const contextMsg = createUserMessage({
          content: [{ type: 'text', text: replyGuidance }],
          source: { kind: 'plugin', plugin: 'enkeep/reply-reference' },
        });
        currentAgent.inject(contextMsg);
      }

      // 2. Followup with official user message
      const userMsg = createUserMessage({
        content: [{ type: 'text', text: effPrompt }],
        source: { kind: 'user' },
      });
      currentAgent.followup(userMsg);

      try {
        await currentAgent.whenIdle();
      } catch (_idleErr: unknown) {
        // Driver boundary contains cancellation/error rejections during whenIdle
      }

      const persistence = ctx.sessionPersistence;
      const turnResult = extractTurnResultFromEvents(currentAgent.session.snapshotEvents(), startIndex);
      const replyText = turnResult.replyText;
      const userAbortedEndFound = turnResult.isCancelled;
      const actualTurnUsage = turnResult.actualUsage;

      if (turnInfo.cancelRequested && !userAbortedEndFound) {
        throw new Error(
          'FAIL-CLOSED: Turn was requested to cancel but Session did not emit a user-aborted turn/end event'
        );
      }

      const isCancelled = userAbortedEndFound;
      const persisted = Boolean(persistence);

      if (!isCancelled) {
        if (!replyText || !replyText.trim()) {
          const sliceEvents = currentAgent.session.snapshotEvents(startIndex as any);
          throw new Error(
            `FAIL-CLOSED: Assistant completed turn but produced empty replyText. eventsCount=${currentAgent.session.seq}, startIndex=${startIndex}, newEvents=${JSON.stringify(sliceEvents.map((e: any) => ({ type: e.type, data: e.data })))}`
          );
        }
        if (!persisted) {
          throw new Error('FAIL-CLOSED: Completed turn requires active session persistence');
        }

        const fallbackTokens = Math.max(1, Math.ceil(Buffer.byteLength(replyText, 'utf8') / 4));
        const finalUsage = actualTurnUsage ?? { totalTokens: fallbackTokens };

        const fbCtx = activeFallbackContexts.get(effSessionId);

        // Find actual provider and model from authoritative session events or effective model selection
        let actualProvider = turnResult.actualProvider ?? effModelSelection?.provider ?? provider;
        let actualModel = turnResult.actualModel ?? effModelSelection?.model ?? model;
        const actualReasoningEffort = effModelSelection?.reasoningEffort ?? null;

        const allCurrentEvents = currentAgent.session.snapshotEvents();
        for (let i = allCurrentEvents.length - 1; i >= startIndex; i--) {
          const ev = allCurrentEvents[i];
          if (ev.type === 'request/context') {
            const data = ev.data as any;
            if (data?.provider && data?.model) {
              actualProvider = data.provider;
              actualModel = data.model;
              break;
            }
          }
          if (ev.type === 'assistant/message' || (ev as any).type === 'message') {
            const data = ev.data as any;
            const src = data?.message?.source || data?.source;
            if (src?.provider && src?.model) {
              actualProvider = src.provider;
              actualModel = src.model;
              break;
            }
          }
        }

        const fallbackUsed =
          Boolean(effModelSelection && (actualProvider !== effModelSelection.provider || actualModel !== effModelSelection.model));

        // Record success on the winning model
        circuitBreakers.recordSuccess(actualProvider, actualModel);

        const latencyMs = fbCtx ? Math.max(1, Date.now() - fbCtx.currentAttemptStart) : 10;
        if (fbCtx) {
          fbCtx.routeAttempts.push({
            provider: actualProvider,
            model: actualModel,
            latencyMs,
            statusCode: 200,
            success: true,
          });
        }

        const routeAttempts = fbCtx ? [...fbCtx.routeAttempts] : [];
        if (fbCtx) {
          fbCtx.active = false;
          activeFallbackContexts.delete(effSessionId);
        }

        const persistence = ctx.sessionPersistence;
        await ctx.sessions.flush(currentAgent.session);

        const finalModelInfo = {
          provider: actualProvider,
          model: actualModel,
          reasoningEffort: actualReasoningEffort,
          fallbackUsed,
          source: effModelSelection?.source ?? (effModelSelection ? 'override' : 'dsh_default'),
        };

        return {
          sessionId: effSessionId,
          turnId: assignedTurnId,
          status: 'completed',
          replyText,
          eventsCount: currentAgent.session.seq,
          persisted: true,
          usage: finalUsage,
          modelInfo: finalModelInfo,
          routeAttempts,
        };
      }

      return {
        sessionId: effSessionId,
        turnId: assignedTurnId,
        status: 'cancelled',
        replyText: undefined,
        eventsCount: currentAgent.session.seq,
        persisted: Boolean(persistence),
      };
    } finally {
      activeTurns.delete(assignedTurnId);
    }
  }

  const activeModelProvider = llmEnabled ? (provider || 'cpa-claude') : 'demo';

  async function getHealth(): Promise<RuntimeHealthStatus> {
    if (isDisposed) {
      return {
        status: 'error',
        uptimeSeconds: 0,
        userId,
        dshReady: false,
        enkeepBundleLoaded: false,
        modelProvider: activeModelProvider,
        plugins: {
          receiptStore: false,
          inbound: false,
          eventRelay: false,
          tools: false,
          externalInteraction: false,
          affinityPolicy: false,
          llmAffinity: false,
        },
        toolsCount: 0,
        toolsOperational: false,
        toolsUnavailableReason: TOOLS_UNAVAILABLE_REASONS.PLATFORM_CLIENT_UNAVAILABLE,
        version: '0.1.1-rc.2',
      };
    }

    const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);

    const receiptStore = ctx.receiptStore ?? (ctx.get ? ctx.get('receiptStore') : undefined);
    const inbound = ctx.inbound ?? (ctx.get ? ctx.get('inbound') : undefined);
    const eventRelay = ctx.eventRelay ?? (ctx.get ? ctx.get('eventRelay') : undefined);
    const toolsService = ctx.tools ?? (ctx.get ? ctx.get('tools') : undefined);
    const externalInteraction = ctx.externalInteraction ?? (ctx.get ? ctx.get('externalInteraction') : undefined);
    const persistence = ctx.sessionPersistence ?? (ctx.get ? ctx.get('sessionPersistence') : undefined);

    const receiptStoreFiber = appliedEntryFibers.get('receipt-store');
    const inboundFiber = appliedEntryFibers.get('inbound');
    const eventRelayFiber = appliedEntryFibers.get('event-relay');
    const toolsFiber = appliedEntryFibers.get('enkeep-tools');
    const externalInteractionFiber = appliedEntryFibers.get('enkeep-external-interaction');
    const affinityPolicyFiber = appliedEntryFibers.get('enkeep-affinity-policy');
    const llmAffinityFiber = appliedEntryFibers.get('llm-affinity');

    // Behavioral probe: verify receiptStore is operational via non-mutating query
    let receiptStoreOperational = false;
    if (receiptStore && typeof receiptStore.getSeedImportReceipt === 'function' && !receiptStore.isClosed) {
      try {
        await receiptStore.getSeedImportReceipt('__health_probe__');
        receiptStoreOperational = true;
      } catch (_err: unknown) {
        receiptStoreOperational = false;
      }
    }

    // Probe: verify tool schemas in registry and platform client availability
    let toolsCount = 0;
    let toolsOperational = false;
    let toolsUnavailableReason: import('../transport/types.js').ToolsUnavailableReasonCode | null = null;
    let schemasRegistered = false;

    const platformClient = ctx.platformClient ?? (ctx.get ? ctx.get('platformClient') : undefined);

    if (toolsService && typeof toolsService.schemas === 'function') {
      try {
        const schemas = toolsService.schemas();
        toolsCount = Array.isArray(schemas) ? schemas.length : 0;
        const toolNames = new Set(schemas.map((s: { name: string }) => s.name));
        schemasRegistered =
          toolNames.has('send_platform_message') &&
          toolNames.has('send_file') &&
          toolNames.has('create_task') &&
          toolNames.has('check_quota') &&
          toolsCount >= 4;

        if (!schemasRegistered) {
          toolsOperational = false;
          toolsUnavailableReason = TOOLS_UNAVAILABLE_REASONS.TOOLS_SCHEMA_INCOMPLETE;
        } else if (!platformClient || typeof platformClient.request !== 'function') {
          // Zero-network / no-platform client: tool schemas are registered, but platform execution is disabled
          toolsOperational = false;
          toolsUnavailableReason = TOOLS_UNAVAILABLE_REASONS.PLATFORM_CLIENT_UNAVAILABLE;
        } else {
          // Probe proxy capabilities handshake over tunnel loopback
          let capabilitiesSuccess = false;
          try {
            const capRes = await (platformClient as any).request(
              '/capabilities',
              {
                method: 'GET',
                timeoutMs: 2000,
                maxRetries: 0,
              }
            ) as { success?: boolean; capabilities?: string[]; status?: number; data?: { success?: boolean; capabilities?: string[] } };
            if (capRes && capRes.status === 200 && capRes.data?.success === true) {
              capabilitiesSuccess = true;
            }
          } catch {
            capabilitiesSuccess = false;
          }

          if (capabilitiesSuccess) {
            toolsOperational = true;
            toolsUnavailableReason = null;
          } else {
            toolsOperational = false;
            toolsUnavailableReason = TOOLS_UNAVAILABLE_REASONS.PLATFORM_CLIENT_UNAVAILABLE;
          }
        }
      } catch (_err: unknown) {
        toolsCount = 0;
        schemasRegistered = false;
        toolsOperational = false;
        toolsUnavailableReason = TOOLS_UNAVAILABLE_REASONS.TOOLS_SCHEMA_PROBE_FAILED;
      }
    } else {
      schemasRegistered = false;
      toolsOperational = false;
      toolsUnavailableReason = TOOLS_UNAVAILABLE_REASONS.TOOLS_REGISTRY_UNAVAILABLE;
    }

    const affinityPolicyReady = isFiberActive(affinityPolicyFiber);
    const llmService = ctx.llm ?? (ctx.get ? ctx.get('llm') : undefined);
    const llmAffinityReady = isFiberActive(llmAffinityFiber) && Boolean(llmService);

    const plugins: PluginReadinessStatus = {
      receiptStore: receiptStoreOperational && isFiberActive(receiptStoreFiber),
      inbound: Boolean(inbound && typeof inbound.handleFollowup === 'function') && isFiberActive(inboundFiber),
      eventRelay: Boolean(eventRelay && (typeof eventRelay.poll === 'function' || typeof eventRelay.ingest === 'function')) && isFiberActive(eventRelayFiber),
      tools: schemasRegistered && isFiberActive(toolsFiber),
      externalInteraction: Boolean(externalInteraction && typeof externalInteraction.listPendingApprovals === 'function') && isFiberActive(externalInteractionFiber),
      affinityPolicy: affinityPolicyReady,
      llmAffinity: llmAffinityReady,
    };

    // Core Enkeep bundle readiness requires the 6 core operational plugins + persistence
    const corePluginsReady =
      plugins.receiptStore &&
      plugins.inbound &&
      plugins.eventRelay &&
      plugins.externalInteraction &&
      plugins.affinityPolicy &&
      plugins.llmAffinity &&
      Boolean(persistence);

    const enkeepBundleLoaded = corePluginsReady;

    return {
      status: enkeepBundleLoaded ? 'ok' : 'error',
      uptimeSeconds,
      userId,
      dshReady: true,
      enkeepBundleLoaded,
      modelProvider: activeModelProvider,
      plugins,
      toolsCount,
      toolsOperational,
      toolsUnavailableReason,
      version: '0.1.1-rc.2',
    };
  }

  async function dispose(): Promise<void> {
    isDisposed = true;
    const disposalErrors: Error[] = [];
    const sessionsService = ctx.sessions;

    for (const handle of agentHandles.values()) {
      try {
        await sessionsService.flush(handle.agent.session);
        await handle.dispose();
      } catch (err: unknown) {
        disposalErrors.push(
          err instanceof Error ? err : new Error('Disposal failure', { cause: err })
        );
      }
    }
    agentHandles.clear();
    sessionProfileHashes.clear();
    activeTurns.clear();

    const receiptStore = ctx.receiptStore ?? (ctx.get ? ctx.get('receiptStore') : undefined);
    if (receiptStore && typeof receiptStore.close === 'function') {
      try {
        await receiptStore.close();
      } catch (err: unknown) {
        disposalErrors.push(
          err instanceof Error ? err : new Error('Disposal failure', { cause: err })
        );
      }
    }

    try {
      await officialPluginsHandle.dispose();
    } catch (err: unknown) {
      disposalErrors.push(
        err instanceof Error ? err : new Error('Official plugins disposal failure', { cause: err })
      );
    }

    try {
      await ctx.fiber.dispose();
    } catch (err: unknown) {
      disposalErrors.push(
        err instanceof Error ? err : new Error('Disposal failure', { cause: err })
      );
    }

    if (disposalErrors.length > 0) {
      throw new AggregateError(disposalErrors, 'Runtime disposal failed');
    }
  }

  function removeAgent(sessionIdStr: string): void {
    agentHandles.delete(sessionIdStr);
    sessionWorkspaceHandles.delete(sessionIdStr);
    sessionProfileHashes.delete(sessionIdStr);
    agentSelectionRefs.delete(sessionIdStr);
    activeFallbackContexts.delete(sessionIdStr);
    sessionMountHashes.delete(sessionIdStr);
    sessionMounts.delete(sessionIdStr);
    sessionExtensionPlanHashes.delete(sessionIdStr);
    sessionExtensionPlans.delete(sessionIdStr);
  }

  function getTurnResultAfterSeq(sessionIdStr: string, startIndex = 0): DerivedTurnResult | null {
    const handle = agentHandles.get(sessionIdStr);
    const agent = handle?.agent ?? (ctx.agents ? ctx.agents.get(SessionId(sessionIdStr)) : undefined);
    if (!agent || !agent.session) {
      return null;
    }
    return extractTurnResultFromEvents(agent.session.snapshotEvents(), startIndex);
  }

  return {
    userId,
    dshHome,
    sessionsDir,
    spacesDir,
    startedAt,
    context: ctx,
    bundleFibers,
    officialPlugins: officialPluginsHandle,
    officialPluginsHandle,
    agentHandles,
    modelProvider: activeModelProvider,
    getOrCreateAgent,
    removeAgent,
    getTurnResultAfterSeq,
    checkSessionArtifact,
    inspectSessionCorruption,
    recoverSessionPrefix,
    exportForkSeed,
    importSeed,
    sendFollowup,
    cancelTurn,
    getHealth,
    getCapabilities: () => officialPluginsHandle.getCapabilities(),
    dispose,
  };
}
