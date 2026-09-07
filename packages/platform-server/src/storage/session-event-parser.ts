import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { PlatformError, ValidationError } from '@enkeep/platform-core';

// ============================================================================
// DSH Official Event Types & Invariant Envelopes
// ============================================================================

export interface DshSessionHeader {
  readonly type: 'session';
  readonly version: number;
  readonly id: string;
  readonly createdAt: number;
  readonly cwd?: string;
  readonly parentSession?: string;
  readonly seedLength?: number;
  readonly origin?: 'subagent';
  readonly delegationDepth: number;
  readonly agentPreset?: string;
}

export type DshContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'image'; attachment: unknown }
  | { type: 'tool-call'; id: string; name: string; arguments: string }
  | { type: 'tool-result'; toolCallId: string; content: DshContentBlock[]; isError?: boolean }
  | { type: string; [key: string]: unknown };

export interface DshUserMessageData {
  readonly id?: string;
  readonly role?: 'user';
  readonly content: DshContentBlock[] | string;
  readonly source?: { kind: string; [key: string]: unknown };
}

export interface DshAssistantMessageData {
  readonly turn?: number;
  readonly step?: number;
  readonly message: {
    readonly id?: string;
    readonly role?: 'assistant';
    readonly content: DshContentBlock[] | string;
    readonly source?: { kind: string; [key: string]: unknown };
  };
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly reasoningTokens?: number;
  };
  readonly interrupted?: true;
}

export interface DshSessionEnvelope<T = unknown> {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: T;
  readonly surfaceOp?: string | { op: string; start: number; end: number };
  readonly sourceEventSeqs?: number[];
  readonly ignorable?: true;
}

export type DshSessionEvent =
  | (DshSessionEnvelope<DshUserMessageData> & { readonly type: 'user/message' })
  | (DshSessionEnvelope<DshAssistantMessageData> & { readonly type: 'assistant/message' })
  | DshSessionEnvelope<Record<string, unknown>>;

export interface ProjectedWebMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly turnId: string | null;
  readonly sourceSeq: number;
  readonly time: number;
  readonly createdAt: string;
  readonly attachments?: readonly any[];
  readonly replyReference?: {
    readonly messageId: string;
    readonly role?: string;
    readonly snippet: string;
  };
}

export interface ParsedDshSession {
  readonly header: DshSessionHeader;
  readonly events: DshSessionEvent[];
  readonly projectedMessages: ProjectedWebMessage[];
  readonly canonicalHash: string;
  readonly fileSnapshot: {
    readonly size: number;
    readonly mtimeMs: number;
    readonly rawSha256: string;
  };
}

// ============================================================================
// Official DSH Session Library Loader Helper
// ============================================================================

interface DshOfficialSessionModule {
  readonly Session?: unknown;
  readonly decodeStorageRecord?: (record: unknown) => DshSessionEvent[];
  readonly SESSION_FORMAT_VERSION?: number;
}

let cachedOfficialSessionModule: DshOfficialSessionModule | null | undefined = undefined;

/**
 * Dynamically resolves and loads the official @deepseek-ai/dsh-session library if available.
 */
export function resolveOfficialDshSessionModule(): DshOfficialSessionModule | null {
  if (cachedOfficialSessionModule !== undefined) {
    return cachedOfficialSessionModule;
  }

  const startDir = path.dirname(fileURLToPath(import.meta.url));
  let dir = startDir;

  for (let i = 0; i < 10; i++) {
    const directPath = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js');
    if (fs.existsSync(directPath)) {
      try {
        const mod = importFreshModule(directPath);
        if (mod) {
          cachedOfficialSessionModule = mod;
          return mod;
        }
      } catch {}
    }

    const pnpmDir = path.join(dir, 'node_modules', '.pnpm');
    if (fs.existsSync(pnpmDir)) {
      try {
        const entries = fs.readdirSync(pnpmDir);
        for (const entry of entries) {
          if (entry.startsWith('@deepseek-ai+dsh-session@')) {
            const candidate = path.join(pnpmDir, entry, 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js');
            if (fs.existsSync(candidate)) {
              const mod = importFreshModule(candidate);
              if (mod) {
                cachedOfficialSessionModule = mod;
                return mod;
              }
            }
          }
        }
      } catch {}
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  cachedOfficialSessionModule = null;
  return null;
}

function importFreshModule(modulePath: string): DshOfficialSessionModule | null {
  try {
    // Dynamic synchronous require or ESM path
    const url = pathToFileURL(modulePath).href;
    // In node we can require or inspect
    const resolved = require(modulePath);
    return resolved as DshOfficialSessionModule;
  } catch {
    return null;
  }
}

// ============================================================================
// Deterministic Message Identity & Helpers
// ============================================================================

export function computeSha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Computes deterministic message ID for DSH source events without an explicit ID.
 */
export function generateDeterministicMessageId(
  sessionId: string,
  seq: number,
  role: string,
  content: string
): string {
  const hash = computeSha256(`${sessionId}:${seq}:${role}:${content}`).slice(0, 24);
  return `msg_dsh_${hash}`;
}

/**
 * Computes canonical SHA256 over projected web messages list.
 */
export function computeCanonicalMessagesHash(messages: ReadonlyArray<{ role: string; content: string }>): string {
  const payload = JSON.stringify(
    messages.map((m) => ({
      role: m.role,
      content: m.content,
    }))
  );
  return computeSha256(payload);
}

/**
 * Extracts visible plain text from DSH content blocks.
 * Reasonings and tool-calls are strictly filtered out of visible user-facing message text.
 */
export function extractVisibleTextFromContentBlocks(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }

  const textPieces: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const typedBlock = block as Record<string, unknown>;
    if (typedBlock.type === 'text' && typeof typedBlock.text === 'string') {
      textPieces.push(typedBlock.text);
    }
    // Note: reasoning, tool-call, tool-result, image blocks without text are skipped for text projection
  }

  return textPieces.join('');
}

// ============================================================================
// Fail-Closed JSONL & Storage Record Parser
// ============================================================================

/**
 * Expands storage records (such as packed chunk rows) into standard SessionEvents.
 */
export function decodeStorageRecordFallback(record: unknown): DshSessionEnvelope[] {
  if (!record || typeof record !== 'object') {
    throw new ValidationError('Storage record must be a non-null object');
  }

  const rec = record as Record<string, unknown>;
  const type = rec.type;
  if (typeof type !== 'string') {
    throw new ValidationError('Storage record missing string "type" field');
  }

  // Handle packed chunk rows if encountered
  if (type === 'text-chunks' || type === 'reasoning-chunks' || type === 'tool-call-chunks') {
    const seq0 = rec.seq0;
    const time0 = rec.time0;
    const data = rec.data as Record<string, unknown> | undefined;

    if (typeof seq0 !== 'number' || typeof time0 !== 'number' || !data) {
      throw new ValidationError(`Malformed chunk row ${type}`);
    }

    const dt = Array.isArray(data.dt) ? (data.dt as number[]) : [];
    const turn = Number(data.turn ?? 0);
    const step = Number(data.step ?? 0);
    const index = Number(data.index ?? 0);
    const expanded: DshSessionEnvelope[] = [];

    if (type === 'text-chunks') {
      const texts = Array.isArray(data.texts) ? (data.texts as string[]) : [];
      let curTime = time0;
      for (let k = 0; k < texts.length; k++) {
        if (k > 0) curTime += dt[k - 1] ?? 0;
        expanded.push({
          type: 'assistant/chunk',
          seq: seq0 + k,
          time: curTime,
          data: {
            turn,
            step,
            chunk: {
              type: 'text-delta',
              index,
              text: texts[k],
            },
          },
        });
      }
    } else if (type === 'reasoning-chunks') {
      const texts = Array.isArray(data.texts) ? (data.texts as string[]) : [];
      let curTime = time0;
      for (let k = 0; k < texts.length; k++) {
        if (k > 0) curTime += dt[k - 1] ?? 0;
        expanded.push({
          type: 'assistant/chunk',
          seq: seq0 + k,
          time: curTime,
          data: {
            turn,
            step,
            chunk: {
              type: 'reasoning-delta',
              index,
              text: texts[k],
            },
          },
        });
      }
    } else if (type === 'tool-call-chunks') {
      const args = Array.isArray(data.args) ? (data.args as string[]) : [];
      const id = data.id as string;
      const name = data.name as string | undefined;
      let curTime = time0;
      for (let k = 0; k < args.length; k++) {
        if (k > 0) curTime += dt[k - 1] ?? 0;
        expanded.push({
          type: 'assistant/chunk',
          seq: seq0 + k,
          time: curTime,
          data: {
            turn,
            step,
            chunk: {
              type: 'tool-call-delta',
              index,
              id,
              name: k === 0 ? name : undefined,
              argumentsDelta: args[k],
            },
          },
        });
      }
    }

    return expanded;
  }

  // Standard session event envelope
  if (typeof rec.seq !== 'number' || typeof rec.time !== 'number') {
    throw new ValidationError(`Invalid session event envelope: missing numeric seq or time (type=${type})`);
  }

  return [rec as unknown as DshSessionEnvelope];
}

/**
 * Validates session header record (line 1 of JSONL).
 */
export function validateSessionHeader(record: unknown): DshSessionHeader {
  if (!record || typeof record !== 'object') {
    throw new ValidationError('Session header line must be a JSON object');
  }

  const h = record as Record<string, unknown>;
  if (h.type !== 'session') {
    throw new ValidationError(`First line of DSH JSONL must be a session header with type='session', got type='${h.type}'`);
  }

  if (typeof h.version !== 'number' || !Number.isSafeInteger(h.version) || h.version < 0) {
    throw new ValidationError('Session header requires non-negative integer version');
  }

  if (typeof h.id !== 'string' || !h.id.trim()) {
    throw new ValidationError('Session header requires non-empty string id');
  }

  if (typeof h.createdAt !== 'number' || !Number.isSafeInteger(h.createdAt) || h.createdAt < 0) {
    throw new ValidationError('Session header requires non-negative integer createdAt');
  }

  return {
    type: 'session',
    version: h.version,
    id: h.id,
    createdAt: h.createdAt,
    cwd: typeof h.cwd === 'string' ? h.cwd : undefined,
    parentSession: typeof h.parentSession === 'string' ? h.parentSession : undefined,
    seedLength: typeof h.seedLength === 'number' ? h.seedLength : undefined,
    origin: h.origin === 'subagent' ? 'subagent' : undefined,
    delegationDepth: typeof h.delegationDepth === 'number' ? h.delegationDepth : 0,
    agentPreset: typeof h.agentPreset === 'string' ? h.agentPreset : undefined,
  };
}

/**
 * Validates that an envelope is a legal DshSessionEnvelope.
 */
export function validateSessionEnvelope(raw: unknown, expectedSeq: number): DshSessionEnvelope {
  if (!raw || typeof raw !== 'object') {
    throw new ValidationError(`Event at seq ${expectedSeq} is not a valid JSON object`);
  }

  const env = raw as Record<string, unknown>;
  if (typeof env.type !== 'string' || !env.type.trim()) {
    throw new ValidationError(`Event at seq ${expectedSeq} has invalid or missing "type"`);
  }

  if (typeof env.seq !== 'number' || !Number.isSafeInteger(env.seq) || env.seq < 0) {
    throw new ValidationError(`Event "${env.type}" has invalid numeric seq`);
  }

  if (env.seq !== expectedSeq) {
    throw new ValidationError(`Sequence break in session log: expected seq ${expectedSeq}, found ${env.seq} for event "${env.type}"`);
  }

  if (typeof env.time !== 'number' || !Number.isSafeInteger(env.time) || env.time < 0) {
    throw new ValidationError(`Event "${env.type}" at seq ${env.seq} has invalid non-negative integer time`);
  }

  if (env.data === undefined) {
    throw new ValidationError(`Event "${env.type}" at seq ${env.seq} is missing required "data" payload`);
  }

  return env as unknown as DshSessionEnvelope;
}

// ============================================================================
// Canonical Projection to web_messages
// ============================================================================

/**
 * Projects DSH session events into canonical public web_messages records.
 *
 * Rules:
 * 1. user/message -> ProjectedWebMessage role='user'
 *    - content from data.content (ContentBlock[] or string)
 *    - id from data.id or deterministic ID
 * 2. assistant/message -> ProjectedWebMessage role='assistant'
 *    - content from data.message.content (ContentBlock[] or string)
 *    - reasoning and tool-call blocks are filtered out
 *    - if resulting visible text is empty (e.g. only tool call), NOT a final message -> skipped
 *    - if interrupted: true with visible text, included
 *    - id from data.message.id or data.id or deterministic ID
 * 3. All other events (assistant/chunk, tool/call, tool/result, turn/start, etc.) are NOT final messages.
 */
export function projectCanonicalWebMessages(
  events: readonly DshSessionEvent[],
  sessionId: string
): ProjectedWebMessage[] {
  const projected: ProjectedWebMessage[] = [];
  let currentTurnNumber: number | null = null;
  let pendingAttachments: any[] | null = null;
  let pendingReplyRef: { messageId: string; role?: string; snippet: string } | null = null;

  for (const event of events) {
    if (event.type === 'enkeep/attachments') {
      const data = event.data as { attachments?: any[] } | undefined;
      if (data && Array.isArray(data.attachments)) {
        pendingAttachments = data.attachments;
      }
      continue;
    }

    if (event.type === 'enkeep/reply-reference') {
      const data = event.data as { replyToMessageId?: string; messageId?: string; role?: string; snippet?: string } | undefined;
      if (data && (data.replyToMessageId || data.messageId)) {
        pendingReplyRef = {
          messageId: data.replyToMessageId || data.messageId || '',
          role: data.role,
          snippet: data.snippet || '',
        };
      }
      continue;
    }

    if (event.type === 'turn/start') {
      const turnData = event.data as { turn?: number } | undefined;
      if (typeof turnData?.turn === 'number') {
        currentTurnNumber = turnData.turn;
      }
      continue;
    }

    if (event.type === 'user/message') {
      const data = event.data as DshUserMessageData | undefined;
      if (!data) continue;

      // Filter out internal context/plugin/synthetic messages from becoming public user messages
      if (data.source && data.source.kind !== 'user') {
        continue;
      }

      const text = extractVisibleTextFromContentBlocks(data.content);
      // Even empty user message if explicitly sent is a message, but usually has text
      const id = data.id && typeof data.id === 'string' && data.id.trim()
        ? data.id
        : generateDeterministicMessageId(sessionId, event.seq, 'user', text);

      const turnId = currentTurnNumber !== null ? `turn_${currentTurnNumber}` : null;
      const createdAt = new Date(event.time).toISOString();

      const userAtts = pendingAttachments;
      pendingAttachments = null;
      const userReplyRef = pendingReplyRef;
      pendingReplyRef = null;

      projected.push({
        id,
        role: 'user',
        content: text,
        turnId,
        sourceSeq: event.seq,
        time: event.time,
        createdAt,
        ...(userAtts && userAtts.length > 0 ? { attachments: userAtts } : {}),
        ...(userReplyRef ? { replyReference: userReplyRef } : {}),
      });
      continue;
    }

    if (event.type === 'assistant/message') {
      const data = event.data as DshAssistantMessageData | undefined;
      if (!data || !data.message) continue;

      const text = extractVisibleTextFromContentBlocks(data.message.content);
      // If assistant message has NO visible text (e.g., purely tool calls), it is not a final user-visible response
      if (!text || text.trim() === '') {
        continue;
      }

      const rawId = data.message.id || (data as unknown as { id?: string }).id;
      const id = rawId && typeof rawId === 'string' && rawId.trim()
        ? rawId
        : generateDeterministicMessageId(sessionId, event.seq, 'assistant', text);

      const turnNum = data.turn ?? currentTurnNumber;
      const turnId = turnNum !== null ? `turn_${turnNum}` : null;
      const createdAt = new Date(event.time).toISOString();

      projected.push({
        id,
        role: 'assistant',
        content: text,
        turnId,
        sourceSeq: event.seq,
        time: event.time,
        createdAt,
      });
      continue;
    }

    // Explicitly reject/skip any non-message types from becoming web_messages:
    // assistant/chunk, tool/call, tool/result, todo/write, request/header, request/context, session/end-seed, turn/end, step/start, step/end
  }

  return projected;
}

// ============================================================================
// Full Session JSONL Parser
// ============================================================================

export interface ParseDshSessionOptions {
  readonly sessionId: string;
}

/**
 * Strict fail-closed parser for DSH session.jsonl file content.
 * Fails loud on malformed lines, missing session header, or sequence discontinuities.
 */
export function parseDshSessionJsonl(
  rawContent: string | Buffer,
  options: ParseDshSessionOptions
): ParsedDshSession {
  const contentStr = typeof rawContent === 'string' ? rawContent : rawContent.toString('utf8');
  const rawBytes = typeof rawContent === 'string' ? Buffer.from(rawContent, 'utf8') : rawContent;
  const rawSha256 = computeSha256(rawBytes);

  const lines = contentStr.split('\n');
  const nonEmptyLines = lines
    .map((line, idx) => ({ text: line.trim(), lineNumber: idx + 1 }))
    .filter((item) => item.text.length > 0);

  if (nonEmptyLines.length === 0) {
    throw new ValidationError('Session JSONL is completely empty; header line is required');
  }

  // 1. Parse & validate header line (must be first non-empty line)
  const headerLine = nonEmptyLines[0];
  let parsedHeaderJson: unknown;
  try {
    parsedHeaderJson = JSON.parse(headerLine.text);
  } catch (err) {
    throw new ValidationError(`Malformed JSON on session header line ${headerLine.lineNumber}: ${(err as Error).message}`);
  }

  const header = validateSessionHeader(parsedHeaderJson);

  // 2. Parse & validate event lines
  const officialMod = resolveOfficialDshSessionModule();
  const events: DshSessionEvent[] = [];
  let expectedSeq = 0;

  for (let i = 1; i < nonEmptyLines.length; i++) {
    const item = nonEmptyLines[i];
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(item.text);
    } catch (err) {
      throw new ValidationError(`Malformed JSON on line ${item.lineNumber}: ${(err as Error).message}`);
    }

    let decodedEvents: DshSessionEnvelope[];
    if (officialMod?.decodeStorageRecord) {
      try {
        decodedEvents = officialMod.decodeStorageRecord(parsedJson) as DshSessionEnvelope[];
      } catch (err) {
        throw new ValidationError(`Official decoder rejected line ${item.lineNumber}: ${(err as Error).message}`);
      }
    } else {
      decodedEvents = decodeStorageRecordFallback(parsedJson);
    }

    for (const rawEv of decodedEvents) {
      const validatedEv = validateSessionEnvelope(rawEv, expectedSeq);
      events.push(validatedEv as DshSessionEvent);
      expectedSeq++;
    }
  }

  // 3. Project canonical web_messages
  const projectedMessages = projectCanonicalWebMessages(events, options.sessionId);
  const canonicalHash = computeCanonicalMessagesHash(projectedMessages);

  return {
    header,
    events,
    projectedMessages,
    canonicalHash,
    fileSnapshot: {
      size: rawBytes.byteLength,
      mtimeMs: Date.now(),
      rawSha256,
    },
  };
}

/**
 * Reads and parses a DSH session.jsonl file with file snapshot metadata.
 */
export async function readAndParseDshSessionFile(
  filePath: string,
  options: ParseDshSessionOptions
): Promise<ParsedDshSession> {
  if (!filePath || typeof filePath !== 'string' || !filePath.trim()) {
    throw new ValidationError('Session JSONL file path is required');
  }

  if (!fs.existsSync(filePath)) {
    throw new PlatformError(`Session JSONL file not found at ${filePath}`, 'NOT_FOUND', 404);
  }

  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new PlatformError('DSH JSONL path must be a regular file, not a symbolic link or directory', 'SECURITY_VIOLATION', 403);
  }

  const rawBytes = fs.readFileSync(filePath);
  const parsed = parseDshSessionJsonl(rawBytes, options);

  return {
    ...parsed,
    fileSnapshot: {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      rawSha256: computeSha256(rawBytes),
    },
  };
}
