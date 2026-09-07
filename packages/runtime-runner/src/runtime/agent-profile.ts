/**
 * Official DSH Agent Profile Implementation for Enkeep Runtime
 *
 * Implements strict validation, canonical SHA-256 hash computation,
 * safe in-container injection via official `ctx.systemPrompt.section` scoped API,
 * and fail-closed session-drift protection.
 *
 * @module @enkeep/runtime-runner/runtime/agent-profile
 */

import crypto from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { canonicalJsonStringify } from './dsh-boot.js';

export const PROFILE_ID_PATTERN = /^[A-Za-z0-9_\-:.]{1,128}$/;

export function isValidProfileId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && PROFILE_ID_PATTERN.test(id);
}

/**
 * Maximum combined UTF-8 byte length for the 4 prompt sections (64 KiB).
 */
export const MAX_PROFILE_PROMPT_BYTES = 64 * 1024; // 65,536 bytes

/**
 * Regex pattern for strictly valid prompt hash (64-character lowercase hex SHA-256).
 */
export const PROMPT_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Disallowed control and format characters:
 * - Unicode general category Cc (Control) except \t (U+0009), \n (U+000A), \r (U+000D)
 * - Unicode general category Cf (Format, including bidi controls, zero-width spaces, invisible characters)
 * - Unicode Line Separator U+2028 and Paragraph Separator U+2029
 */
export const FORBIDDEN_CONTROL_CHARS_PATTERN = /[^\P{Cc}\t\n\r]|\p{Cf}|[\u2028\u2029]/u;

/**
 * Disallowed prompt template variable tokens `{{` and `}}`.
 * Official systemPrompt assembly throws if template variable tokens are present.
 */
export const TEMPLATE_VARIABLE_PATTERN = /\{\{|\}\}/;

/**
 * Allowed top-level keys in AgentProfileSnapshot.
 */
export const ALLOWED_PROFILE_KEYS = new Set([
  'profileId',
  'version',
  'promptHash',
  'identity',
  'soul',
  'agents',
  'tools',
]);

/**
 * Scoped system prompt section names for the 4 profile prompt parts.
 */
export const PROFILE_SECTION_NAMES = {
  identity: 'profile:identity',
  soul: 'profile:soul',
  agents: 'profile:agents',
  tools: 'profile:tools',
} as const;

/**
 * Scoped system prompt section orders (ascending, appending after deployment persona 0).
 * Preserves harness identity (-100) and deployment persona (0).
 */
export const PROFILE_SECTION_ORDERS = {
  identity: 10,
  soul: 20,
  agents: 30,
  tools: 40,
} as const;

/**
 * Raw Agent Profile Snapshot provided via execution request.
 * Contains exactly 7 allowed keys.
 */
export interface AgentProfileSnapshot {
  readonly profileId: string;
  readonly version: number | string;
  readonly promptHash: string;
  readonly identity: string;
  readonly soul: string;
  readonly agents: string;
  readonly tools: string;
}

/**
 * Strictly validated and normalized Agent Profile.
 * Contains exactly 7 keys with zero extras.
 */
export interface ValidatedAgentProfile {
  readonly profileId: string;
  readonly version: number;
  readonly promptHash: string;
  readonly identity: string;
  readonly soul: string;
  readonly agents: string;
  readonly tools: string;
}

/**
 * Fixed validation error codes for AgentProfileValidationError.
 */
export type AgentProfileValidationErrorCode =
  | 'INVALID_SNAPSHOT_OBJECT'
  | 'UNEXPECTED_KEY'
  | 'INVALID_PROFILE_ID'
  | 'INVALID_VERSION'
  | 'INVALID_SECTION_TYPE'
  | 'NON_NFC_NORMALIZATION'
  | 'FORBIDDEN_CONTROL_CHARS'
  | 'FORBIDDEN_TEMPLATE_VARIABLE'
  | 'MAX_BYTES_EXCEEDED'
  | 'INVALID_PROMPT_HASH_FORMAT'
  | 'PROMPT_HASH_MISMATCH';

/**
 * Fixed error messages mapped strictly by error code.
 * Contains no raw values, IDs, session identifiers, hashes, computed hashes, field names, or counts.
 */
export const AGENT_PROFILE_VALIDATION_MESSAGES: Record<AgentProfileValidationErrorCode, string> = {
  INVALID_SNAPSHOT_OBJECT: 'Agent profile snapshot must be a non-null plain object.',
  UNEXPECTED_KEY: 'Agent profile snapshot contains unexpected keys.',
  INVALID_PROFILE_ID: 'Agent profile ID is invalid or missing.',
  INVALID_VERSION: 'Agent profile version must be a positive safe integer.',
  INVALID_SECTION_TYPE: 'Agent profile prompt section must be a string.',
  NON_NFC_NORMALIZATION: 'Agent profile prompt section must be in Unicode NFC normalized form.',
  FORBIDDEN_CONTROL_CHARS: 'Agent profile prompt section contains forbidden control or format characters.',
  FORBIDDEN_TEMPLATE_VARIABLE: 'Agent profile prompt section contains forbidden template variable syntax.',
  MAX_BYTES_EXCEEDED: 'Agent profile prompt sections total size exceeds maximum allowable limit.',
  INVALID_PROMPT_HASH_FORMAT: 'Agent profile prompt hash must be a 64-character lowercase hex SHA-256 string.',
  PROMPT_HASH_MISMATCH: 'Agent profile prompt hash does not match computed hash.',
};

/**
 * Fixed error thrown when Agent Profile snapshot validation fails.
 * Takes a fixed code only and maps to fixed generic messages with no dynamic value interpolation.
 */
export class AgentProfileValidationError extends Error {
  public readonly code: AgentProfileValidationErrorCode;

  constructor(code: AgentProfileValidationErrorCode) {
    const message = AGENT_PROFILE_VALIDATION_MESSAGES[code] ?? 'Agent profile snapshot validation failed.';
    super(message);
    this.name = 'AgentProfileValidationError';
    this.code = code;
  }
}

/**
 * Fixed session mismatch error code.
 */
export type AgentProfileSessionMismatchErrorCode = 'SESSION_MISMATCH';

/**
 * Fixed session mismatch error message.
 * Contains no raw values, IDs, session identifiers, or hashes.
 */
export const AGENT_PROFILE_SESSION_MISMATCH_MESSAGES: Record<AgentProfileSessionMismatchErrorCode, string> = {
  SESSION_MISMATCH:
    'Agent profile session mismatch: existing profile snapshot does not match incoming profile configuration. Generational reset or agent recreation is required.',
};

/**
 * Error thrown when a session is invoked with a differing profile prompt hash
 * without an explicit generational reset or agent disposal.
 * Error message uses fixed description without raw values or hashes.
 */
export class AgentProfileSessionMismatchError extends Error {
  public readonly code: AgentProfileSessionMismatchErrorCode;

  constructor(codeOrSessionId: string = 'SESSION_MISMATCH') {
    void codeOrSessionId;
    const message = AGENT_PROFILE_SESSION_MISMATCH_MESSAGES.SESSION_MISMATCH;
    super(message);
    this.name = 'AgentProfileSessionMismatchError';
    this.code = 'SESSION_MISMATCH';
  }
}

/**
 * Computes canonical SHA-256 hash (64 lowercase hex characters) over the four prompt sections.
 *
 * Uses deterministic sorted canonical JSON serialization of the 4 sections
 * ({ agents, identity, soul, tools }) to guarantee cross-platform and byte-exact reproducibility.
 *
 * @param sections - The four text sections of the profile.
 * @returns Canonical 64-char lowercase hex SHA-256 hash.
 */
export function computeAgentProfilePromptHash(sections: {
  readonly identity: string;
  readonly soul: string;
  readonly agents: string;
  readonly tools: string;
}): string {
  const canonicalPayload = {
    agents: sections.agents,
    identity: sections.identity,
    soul: sections.soul,
    tools: sections.tools,
  };
  const canonicalJson = canonicalJsonStringify(canonicalPayload);
  return crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex').toLowerCase();
}

/**
 * Type guard for plain object records without `as any`.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates a single prompt section string:
 * 1. String type.
 * 2. Unicode NFC normalization.
 * 3. Absence of forbidden Unicode Cc/Cf control/format characters.
 * 4. Absence of `{{` or `}}` template variable syntax.
 *
 * @param text - The text content to validate.
 * @returns Validated string.
 */
function validateSectionText(text: unknown): string {
  if (typeof text !== 'string') {
    throw new AgentProfileValidationError('INVALID_SECTION_TYPE');
  }

  // Enforce Unicode NFC normalization form without silent mutation
  if (text.normalize('NFC') !== text) {
    throw new AgentProfileValidationError('NON_NFC_NORMALIZATION');
  }

  if (FORBIDDEN_CONTROL_CHARS_PATTERN.test(text)) {
    throw new AgentProfileValidationError('FORBIDDEN_CONTROL_CHARS');
  }

  if (text.includes('{{') || text.includes('}}') || TEMPLATE_VARIABLE_PATTERN.test(text)) {
    throw new AgentProfileValidationError('FORBIDDEN_TEMPLATE_VARIABLE');
  }

  return text;
}

/**
 * Strictly validates an incoming AgentProfileSnapshot.
 *
 * Enforces:
 * - Plain object snapshot with zero unexpected keys.
 * - Valid profileId conforming to canonical safe ID format.
 * - Valid version: positive safe integer (>= 1, aligned with SQLite profile version).
 * - Valid 4 prompt sections (identity, soul, agents, tools) in Unicode NFC normalization.
 * - Total UTF-8 byte length across all 4 sections <= 64 KiB.
 * - No forbidden Unicode Cc/Cf control/format characters.
 * - No `{{...}}` template syntax (any `{{` or `}}`).
 * - promptHash matching exact lowercase 64-hex SHA-256 pattern without uppercase coercion.
 * - Canonical SHA-256 hash match against the 4 sections via constant-time equality.
 *
 * @param raw - Candidate AgentProfileSnapshot value.
 * @returns ValidatedAgentProfile with exact 7 keys and zero extras.
 * @throws AgentProfileValidationError if validation fails.
 */
export function validateAgentProfileSnapshot(raw: unknown): ValidatedAgentProfile {
  if (!isRecord(raw)) {
    throw new AgentProfileValidationError('INVALID_SNAPSHOT_OBJECT');
  }

  // 1. Strict rejection of unexpected keys
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_PROFILE_KEYS.has(key)) {
      throw new AgentProfileValidationError('UNEXPECTED_KEY');
    }
  }

  // 2. profileId validation
  if (!isValidProfileId(raw.profileId)) {
    throw new AgentProfileValidationError('INVALID_PROFILE_ID');
  }
  const profileId = raw.profileId;

  // 3. version validation (positive safe integer >= 1)
  let versionNum: number;
  if (typeof raw.version === 'number') {
    if (!Number.isSafeInteger(raw.version) || raw.version < 1) {
      throw new AgentProfileValidationError('INVALID_VERSION');
    }
    versionNum = raw.version;
  } else if (typeof raw.version === 'string') {
    if (raw.version.trim() !== raw.version) {
      throw new AgentProfileValidationError('INVALID_VERSION');
    }
    if (!/^[1-9]\d*$/.test(raw.version)) {
      throw new AgentProfileValidationError('INVALID_VERSION');
    }
    const parsed = Number(raw.version);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new AgentProfileValidationError('INVALID_VERSION');
    }
    versionNum = parsed;
  } else {
    throw new AgentProfileValidationError('INVALID_VERSION');
  }

  // 4. Sections text validation (NFC normalized, no Cc/Cf controls, no template variables)
  const identity = validateSectionText(raw.identity);
  const soul = validateSectionText(raw.soul);
  const agents = validateSectionText(raw.agents);
  const tools = validateSectionText(raw.tools);

  // 5. Combined UTF-8 byte length check (64 KiB cap)
  const identityBytes = Buffer.byteLength(identity, 'utf8');
  const soulBytes = Buffer.byteLength(soul, 'utf8');
  const agentsBytes = Buffer.byteLength(agents, 'utf8');
  const toolsBytes = Buffer.byteLength(tools, 'utf8');
  const totalBytes = identityBytes + soulBytes + agentsBytes + toolsBytes;

  if (totalBytes > MAX_PROFILE_PROMPT_BYTES) {
    throw new AgentProfileValidationError('MAX_BYTES_EXCEEDED');
  }

  // 6. promptHash validation (strictly lowercase 64-hex SHA-256 pattern, no uppercase acceptance)
  if (typeof raw.promptHash !== 'string' || !PROMPT_HASH_PATTERN.test(raw.promptHash)) {
    throw new AgentProfileValidationError('INVALID_PROMPT_HASH_FORMAT');
  }
  const promptHash = raw.promptHash;

  // 7. Canonical hash match verification with constant-time comparison
  const computedHash = computeAgentProfilePromptHash({ identity, soul, agents, tools });
  const storedBuf = Buffer.from(promptHash, 'utf8');
  const computedBuf = Buffer.from(computedHash, 'utf8');

  if (storedBuf.length !== computedBuf.length || !crypto.timingSafeEqual(storedBuf, computedBuf)) {
    throw new AgentProfileValidationError('PROMPT_HASH_MISMATCH');
  }

  return {
    profileId,
    version: versionNum,
    promptHash,
    identity,
    soul,
    agents,
    tools,
  };
}

/**
 * Injects the validated Agent Profile prompt sections into the scoped agent context.
 *
 * Rules:
 * - Uses official `agentCtx.systemPrompt.section()`.
 * - Strictly APPENDS 4 ordered sections (`profile:identity`, `profile:soul`, `profile:agents`, `profile:tools`).
 * - Never sets `complete: true` (which would replace/wipe official harness identity and persona).
 * - Scoped to `agentCtx` so disposal of agent handle or agent context automatically unregisters all sections.
 * - Non-empty sections are registered in strictly ascending order: 10, 20, 30, 40.
 *
 * @param agentCtx - Scoped agent Context.
 * @param profile - Validated agent profile.
 * @returns Composite disposer function.
 */
export function installAgentProfile(agentCtx: Context, profile: ValidatedAgentProfile): () => void {
  const systemPrompt = agentCtx.systemPrompt;
  if (!systemPrompt || typeof systemPrompt.section !== 'function') {
    throw new Error('SystemPrompt service is not available on agent context');
  }

  const disposers: Array<() => void> = [];

  // 1. profile:identity (order 10)
  if (profile.identity.trim().length > 0) {
    const dispose = systemPrompt.section({
      name: PROFILE_SECTION_NAMES.identity,
      order: PROFILE_SECTION_ORDERS.identity,
      text: profile.identity,
      // complete: false is implicit; strictly never set complete: true
    });
    disposers.push(dispose);
  }

  // 2. profile:soul (order 20)
  if (profile.soul.trim().length > 0) {
    const dispose = systemPrompt.section({
      name: PROFILE_SECTION_NAMES.soul,
      order: PROFILE_SECTION_ORDERS.soul,
      text: profile.soul,
    });
    disposers.push(dispose);
  }

  // 3. profile:agents (order 30)
  if (profile.agents.trim().length > 0) {
    const dispose = systemPrompt.section({
      name: PROFILE_SECTION_NAMES.agents,
      order: PROFILE_SECTION_ORDERS.agents,
      text: profile.agents,
    });
    disposers.push(dispose);
  }

  // 4. profile:tools (order 40)
  if (profile.tools.trim().length > 0) {
    const dispose = systemPrompt.section({
      name: PROFILE_SECTION_NAMES.tools,
      order: PROFILE_SECTION_ORDERS.tools,
      text: profile.tools,
    });
    disposers.push(dispose);
  }

  return () => {
    const errors: Error[] = [];
    for (const dispose of disposers) {
      try {
        if (typeof dispose === 'function') {
          dispose();
        }
      } catch (err: unknown) {
        errors.push(err instanceof Error ? err : new Error('Profile section disposer failed'));
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Agent profile disposal failed');
    }
  };
}
