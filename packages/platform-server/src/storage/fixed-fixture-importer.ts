import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { PlatformError, ValidationError } from '@enkeep/platform-core';
import type { ImportResult, CompiledChat, SeedEvent } from '@enkeep/import-happyclaw';
import { buildRouteKey, DEFAULT_WEB_ACCOUNT_ID, WEB_CHANNEL_NAME } from '@enkeep/web-channel';

export const FIXED_FIXTURE_INVARIANTS = Object.freeze({
  chats: 2,
  sourceMessages: 52,
  importedPeopleTalk: 50,
  droppedEmpty: 2,
  attachments: 5,
  idAlgorithm: 'sha256-chatJid-v1',
  importerVersion: '0.1.0',
  targetDsh: '@deepseek-ai/dsh-session@0.1.1-rc.2',
  sessionFormat: 0,
});

export interface FixedImportReceipt {
  readonly userId: string;
  readonly sourceFingerprint: string;
  readonly importerVersion: string;
  readonly idAlgorithm: string;
  readonly targetDsh: string;
  readonly sessionFormat: number;
  readonly sourceChatsCount: number;
  readonly sourceMessagesCount: number;
  readonly importedMessagesCount: number;
  readonly droppedMessagesCount: number;
  readonly attachmentsCount: number;
  readonly canonicalHash: string;
  readonly createdAt: string;
}

export interface FixedImportProvenanceRecord {
  readonly id: string;
  readonly userId: string;
  readonly sourceFingerprint: string;
  readonly sourceChatJid: string;
  readonly sourceMessageId: string;
  readonly targetSpaceId: string;
  readonly targetRouteId: string;
  readonly targetDshSessionId: string;
  readonly targetMessageId: string;
  readonly targetEventId: string;
  readonly createdAt: string;
}

export interface FixedFixtureImportParams {
  readonly userId: string;
  readonly result: ImportResult;
  readonly deterministicCreatedAt?: string;
}

export interface FixedFixtureImportResult {
  readonly duplicate: boolean;
  readonly receipt: FixedImportReceipt;
  readonly importedChatsCount: number;
  readonly importedMessagesCount: number;
  readonly provenanceCount: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const keys = Object.keys(record).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (keys.length !== sortedExpected.length) return false;
  return keys.every((k, i) => k === sortedExpected[i]);
}

const ATTACHMENT_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const IMPORTED_SESSION_ID_PATTERN = /^import-[0-9a-f]{32}$/;
const FOLDER_PATTERN = /^[A-Za-z0-9._-]+$/;

function validateRelativeAttachmentPath(rawPath: string): void {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new ValidationError('Attachment path must be a non-empty string');
  }
  if (rawPath.startsWith('/') || rawPath.includes('\\')) {
    throw new ValidationError('Invalid attachment path: absolute paths and backslashes are forbidden');
  }
  if (/[\x00-\x1F\x7F]/.test(rawPath)) {
    throw new ValidationError('Invalid attachment path: control characters are forbidden');
  }
  const segments = rawPath.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      throw new ValidationError('Invalid attachment path segment: dot and empty segments are forbidden');
    }
    if (!ATTACHMENT_SEGMENT_PATTERN.test(segment)) {
      throw new ValidationError('Invalid attachment path segment: forbidden characters');
    }
  }
}

/**
 * Stable, recursive canonical JSON serializer for fixed importer hash stability.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalizeJson(item)).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries = keys.map((key) => {
    const v = obj[key];
    return JSON.stringify(key) + ':' + canonicalizeJson(v);
  });
  return '{' + entries.join(',') + '}';
}

/**
 * Computes a deterministic SHA-256 canonical hash over the complete normalized import payload.
 */
export function computeCanonicalImportHash(result: ImportResult): string {
  const payload = {
    sourceFingerprint: result.manifest.sourceFingerprint,
    importerVersion: result.manifest.importerVersion,
    idAlgorithm: result.manifest.idAlgorithm,
    targetDsh: result.manifest.targetDsh,
    sessionFormat: result.manifest.sessionFormat,
    stats: result.stats,
    mapping: result.mapping,
    chats: result.chats.map((chat) => ({
      chatJid: chat.chatJid,
      folder: chat.folder,
      sessionId: chat.sessionId,
      report: chat.report,
      seed: chat.seed,
    })),
  };
  const canonicalJsonStr = canonicalizeJson(payload);
  return createHash('sha256').update(canonicalJsonStr).digest('hex');
}

const ALLOWED_IMPORT_RESULT_KEYS = Object.freeze(['chats', 'manifest', 'mapping', 'stats', 'targetDir']);
const ALLOWED_MANIFEST_KEYS = Object.freeze([
  'anomalies',
  'chatReports',
  'createdAt',
  'idAlgorithm',
  'importerVersion',
  'sessionFormat',
  'sourceFingerprint',
  'stats',
  'targetDsh',
]);
const ALLOWED_STATS_KEYS = Object.freeze([
  'attachments',
  'chats',
  'consecutiveAssistantMessages',
  'consecutiveUserMessages',
  'droppedEmpty',
  'importedPeopleTalk',
  'sourceMessages',
  'unpairedAssistants',
]);
const ALLOWED_CHAT_KEYS = Object.freeze(['anomalies', 'chatJid', 'folder', 'report', 'seed', 'sessionId']);
const ALLOWED_CHAT_REPORT_KEYS = Object.freeze([
  'attachments',
  'chatJid',
  'consecutiveAssistantMessages',
  'consecutiveUserMessages',
  'droppedEmpty',
  'executionMode',
  'folder',
  'importedPeopleTalk',
  'sessionId',
  'sourceMessages',
  'unpairedAssistants',
]);

export function validateImportResultStructure(result: unknown): asserts result is ImportResult {
  if (!isRecord(result)) {
    throw new ValidationError('ImportResult must be a non-null object');
  }

  if (!hasExactKeys(result, ALLOWED_IMPORT_RESULT_KEYS)) {
    throw new ValidationError('ImportResult has invalid keys');
  }

  if (typeof result.targetDir !== 'string' || result.targetDir.length === 0) {
    throw new ValidationError('ImportResult.targetDir must be a non-empty string');
  }

  // Validate manifest
  if (!isRecord(result.manifest) || !hasExactKeys(result.manifest, ALLOWED_MANIFEST_KEYS)) {
    throw new ValidationError('ImportResult.manifest has invalid keys or is not an object');
  }

  const manifest = result.manifest;
  if (typeof manifest.sourceFingerprint !== 'string' || !manifest.sourceFingerprint.startsWith('sha256:') || manifest.sourceFingerprint.length !== 71) {
    throw new ValidationError('ImportResult.manifest.sourceFingerprint must be a valid sha256 fingerprint string');
  }
  if (manifest.importerVersion !== FIXED_FIXTURE_INVARIANTS.importerVersion) {
    throw new ValidationError('Unexpected manifest.importerVersion');
  }
  if (manifest.idAlgorithm !== FIXED_FIXTURE_INVARIANTS.idAlgorithm) {
    throw new ValidationError('Unexpected manifest.idAlgorithm');
  }
  if (manifest.targetDsh !== FIXED_FIXTURE_INVARIANTS.targetDsh) {
    throw new ValidationError('Unexpected manifest.targetDsh');
  }
  if (manifest.sessionFormat !== FIXED_FIXTURE_INVARIANTS.sessionFormat) {
    throw new ValidationError('Unexpected manifest.sessionFormat');
  }
  if (typeof manifest.createdAt !== 'string' || manifest.createdAt.length === 0) {
    throw new ValidationError('ImportResult.manifest.createdAt must be a non-empty string');
  }
  const parsedManifestCreatedAt = Date.parse(manifest.createdAt);
  if (Number.isNaN(parsedManifestCreatedAt) || new Date(parsedManifestCreatedAt).toISOString() !== manifest.createdAt) {
    throw new ValidationError('ImportResult.manifest.createdAt must be a canonical ISO date string');
  }
  if (!Array.isArray(manifest.anomalies)) {
    throw new ValidationError('ImportResult.manifest.anomalies must be an array');
  }
  if (!Array.isArray(manifest.chatReports) || manifest.chatReports.length !== FIXED_FIXTURE_INVARIANTS.chats) {
    throw new ValidationError('ImportResult.manifest.chatReports has invalid length');
  }

  // Validate stats
  if (!isRecord(result.stats) || !hasExactKeys(result.stats, ALLOWED_STATS_KEYS)) {
    throw new ValidationError('ImportResult.stats has invalid keys or is not an object');
  }

  const stats = result.stats;
  if (
    stats.chats !== FIXED_FIXTURE_INVARIANTS.chats ||
    stats.sourceMessages !== FIXED_FIXTURE_INVARIANTS.sourceMessages ||
    stats.importedPeopleTalk !== FIXED_FIXTURE_INVARIANTS.importedPeopleTalk ||
    stats.droppedEmpty !== FIXED_FIXTURE_INVARIANTS.droppedEmpty ||
    stats.attachments !== FIXED_FIXTURE_INVARIANTS.attachments
  ) {
    throw new ValidationError('Fixed fixture stats mismatch');
  }

  // Verify manifest.stats exact match
  if (!isRecord(manifest.stats) || !hasExactKeys(manifest.stats, ALLOWED_STATS_KEYS)) {
    throw new ValidationError('ImportResult.manifest.stats has invalid keys or is not an object');
  }
  for (const k of ALLOWED_STATS_KEYS) {
    if ((manifest.stats as Record<string, unknown>)[k] !== (stats as Record<string, unknown>)[k]) {
      throw new ValidationError('Fixed fixture manifest stats mismatch');
    }
  }

  // Validate chats
  if (!Array.isArray(result.chats) || result.chats.length !== FIXED_FIXTURE_INVARIANTS.chats) {
    throw new ValidationError('ImportResult.chats must contain exact invariant chats');
  }

  let totalSourceMessages = 0;
  let totalImportedPeopleTalk = 0;
  let totalDroppedEmpty = 0;
  let totalAttachments = 0;

  for (let i = 0; i < result.chats.length; i++) {
    const chat = result.chats[i];
    if (!isRecord(chat) || !hasExactKeys(chat, ALLOWED_CHAT_KEYS)) {
      throw new ValidationError('Chat item has invalid structure');
    }
    if (typeof chat.chatJid !== 'string' || chat.chatJid.length === 0) {
      throw new ValidationError('Chat has invalid chatJid');
    }
    if (typeof chat.folder !== 'string' || chat.folder.length === 0 || !FOLDER_PATTERN.test(chat.folder)) {
      throw new ValidationError('Chat has invalid folder');
    }
    if (typeof chat.sessionId !== 'string' || !IMPORTED_SESSION_ID_PATTERN.test(chat.sessionId)) {
      throw new ValidationError('Chat has invalid sessionId');
    }
    if (!Array.isArray(chat.seed)) {
      throw new ValidationError('Chat has invalid seed array');
    }
    if (!Array.isArray(chat.anomalies)) {
      throw new ValidationError('Chat has invalid anomalies array');
    }
    if (!isRecord(chat.report) || !hasExactKeys(chat.report, ALLOWED_CHAT_REPORT_KEYS)) {
      throw new ValidationError('Chat has invalid report object');
    }

    const report = chat.report;
    if (report.chatJid !== chat.chatJid || report.folder !== chat.folder || report.sessionId !== chat.sessionId) {
      throw new ValidationError('Chat report identity mismatch');
    }

    if (
      typeof report.sourceMessages !== 'number' || !Number.isSafeInteger(report.sourceMessages) ||
      typeof report.importedPeopleTalk !== 'number' || !Number.isSafeInteger(report.importedPeopleTalk) ||
      typeof report.droppedEmpty !== 'number' || !Number.isSafeInteger(report.droppedEmpty) ||
      typeof report.attachments !== 'number' || !Number.isSafeInteger(report.attachments)
    ) {
      throw new ValidationError('Chat report contains invalid numeric counts');
    }

    totalSourceMessages += report.sourceMessages;
    totalImportedPeopleTalk += report.importedPeopleTalk;
    totalDroppedEmpty += report.droppedEmpty;
    totalAttachments += report.attachments;
  }

  if (
    totalSourceMessages !== FIXED_FIXTURE_INVARIANTS.sourceMessages ||
    totalImportedPeopleTalk !== FIXED_FIXTURE_INVARIANTS.importedPeopleTalk ||
    totalDroppedEmpty !== FIXED_FIXTURE_INVARIANTS.droppedEmpty ||
    totalAttachments !== FIXED_FIXTURE_INVARIANTS.attachments
  ) {
    throw new ValidationError('Authoritative manifest aggregate counts mismatch');
  }

  // Validate mapping
  if (!isRecord(result.mapping)) {
    throw new ValidationError('ImportResult.mapping must be an object');
  }
  for (const chat of result.chats) {
    const mapEntry = result.mapping[chat.chatJid];
    if (!isRecord(mapEntry)) {
      throw new ValidationError('Missing mapping entry for chat');
    }
    if (mapEntry.sessionId !== chat.sessionId || mapEntry.folder !== chat.folder || mapEntry.chatJid !== chat.chatJid) {
      throw new ValidationError('Mapping entry mismatch for chat');
    }
  }
}

export function validateImportParams(params: unknown): asserts params is FixedFixtureImportParams {
  if (!isRecord(params)) {
    throw new ValidationError('Fixed fixture import parameters must be a non-null object');
  }

  const allowedKeys = ['deterministicCreatedAt', 'result', 'userId'];
  if (!hasExactKeys(params, allowedKeys) && !hasExactKeys(params, ['result', 'userId'])) {
    throw new ValidationError('Unexpected properties in import parameters');
  }

  if (typeof params.userId !== 'string' || params.userId.length === 0) {
    throw new ValidationError('userId must be a non-empty string');
  }

  validateImportResultStructure(params.result);

  if (params.deterministicCreatedAt !== undefined) {
    if (typeof params.deterministicCreatedAt !== 'string' || params.deterministicCreatedAt.length === 0) {
      throw new ValidationError('deterministicCreatedAt must be a non-empty string when provided');
    }
    const parsed = Date.parse(params.deterministicCreatedAt);
    if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== params.deterministicCreatedAt) {
      throw new ValidationError('deterministicCreatedAt must be a canonical ISO date string');
    }
  }
}

function toSafeInteger(val: unknown): number {
  if (typeof val === 'number' && Number.isSafeInteger(val)) {
    return val;
  }
  if (typeof val === 'bigint') {
    if (val >= BigInt(Number.MIN_SAFE_INTEGER) && val <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(val);
    }
  }
  throw new PlatformError('Corrupted numeric field in database row', 'IMPORT_CORRUPTION');
}

function requireChangesOne(res: { changes: number | bigint }): void {
  const changes = res.changes;
  if (typeof changes === 'number') {
    if (changes === 1) return;
  } else if (typeof changes === 'bigint') {
    if (changes === 1n) return;
  }
  throw new PlatformError('Database statement did not change exactly one row', 'IMPORT_INSERT_FAILED');
}

interface ReceiptDbRow {
  readonly user_id: string;
  readonly source_fingerprint: string;
  readonly importer_version: string;
  readonly id_algorithm: string;
  readonly target_dsh: string;
  readonly session_format: number;
  readonly source_chats_count: number;
  readonly source_messages_count: number;
  readonly imported_messages_count: number;
  readonly dropped_messages_count: number;
  readonly attachments_count: number;
  readonly canonical_hash: string;
  readonly created_at: string;
}

function parseReceiptDbRow(row: unknown): ReceiptDbRow {
  if (!isRecord(row)) {
    throw new PlatformError('Corrupted receipt row in database', 'IMPORT_CORRUPTION');
  }
  const {
    user_id,
    source_fingerprint,
    importer_version,
    id_algorithm,
    target_dsh,
    session_format,
    source_chats_count,
    source_messages_count,
    imported_messages_count,
    dropped_messages_count,
    attachments_count,
    canonical_hash,
    created_at,
  } = row;

  if (
    typeof user_id !== 'string' ||
    typeof source_fingerprint !== 'string' ||
    typeof importer_version !== 'string' ||
    typeof id_algorithm !== 'string' ||
    typeof target_dsh !== 'string' ||
    typeof canonical_hash !== 'string' ||
    typeof created_at !== 'string'
  ) {
    throw new PlatformError('Corrupted receipt row string fields', 'IMPORT_CORRUPTION');
  }

  return {
    user_id,
    source_fingerprint,
    importer_version,
    id_algorithm,
    target_dsh,
    session_format: toSafeInteger(session_format),
    source_chats_count: toSafeInteger(source_chats_count),
    source_messages_count: toSafeInteger(source_messages_count),
    imported_messages_count: toSafeInteger(imported_messages_count),
    dropped_messages_count: toSafeInteger(dropped_messages_count),
    attachments_count: toSafeInteger(attachments_count),
    canonical_hash,
    created_at,
  };
}

interface SpaceDbRow {
  readonly id: string;
  readonly user_id: string;
  readonly name: string;
  readonly folder: string;
  readonly execution_mode: string;
}

function parseSpaceDbRow(row: unknown): SpaceDbRow {
  if (!isRecord(row)) {
    throw new PlatformError('Corrupted space row in database', 'IMPORT_CORRUPTION');
  }
  const { id, user_id, name, folder, execution_mode } = row;
  if (
    typeof id !== 'string' ||
    typeof user_id !== 'string' ||
    typeof name !== 'string' ||
    typeof folder !== 'string' ||
    typeof execution_mode !== 'string'
  ) {
    throw new PlatformError('Corrupted space row field types', 'IMPORT_CORRUPTION');
  }
  return { id, user_id, name, folder, execution_mode };
}

interface SessionRouteDbRow {
  readonly id: string;
  readonly space_id: string;
  readonly user_id: string;
  readonly channel: string;
  readonly account_id: string;
  readonly native_context_id: string;
  readonly peer_id: string;
  readonly dsh_session_id: string;
  readonly execution_mode: string;
}

function parseSessionRouteDbRow(row: unknown): SessionRouteDbRow {
  if (!isRecord(row)) {
    throw new PlatformError('Corrupted session route row in database', 'IMPORT_CORRUPTION');
  }
  const { id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode } = row;
  if (
    typeof id !== 'string' ||
    typeof space_id !== 'string' ||
    typeof user_id !== 'string' ||
    typeof channel !== 'string' ||
    typeof account_id !== 'string' ||
    typeof native_context_id !== 'string' ||
    typeof peer_id !== 'string' ||
    typeof dsh_session_id !== 'string' ||
    typeof execution_mode !== 'string'
  ) {
    throw new PlatformError('Corrupted session route row field types', 'IMPORT_CORRUPTION');
  }
  return { id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode };
}

interface SessionGenerationDbRow {
  readonly id: string;
  readonly user_id: string;
  readonly route_id: string;
  readonly generation_number: number;
  readonly dsh_session_id: string;
  readonly agent_profile_snapshot_id: string | null;
  readonly reset_reason: string;
}

function parseSessionGenerationDbRow(row: unknown): SessionGenerationDbRow {
  if (!isRecord(row)) {
    throw new PlatformError('Corrupted session generation row in database', 'IMPORT_CORRUPTION');
  }
  const { id, user_id, route_id, generation_number, dsh_session_id, agent_profile_snapshot_id, reset_reason } = row;
  if (
    typeof id !== 'string' ||
    typeof user_id !== 'string' ||
    typeof route_id !== 'string' ||
    typeof dsh_session_id !== 'string' ||
    (agent_profile_snapshot_id !== null && typeof agent_profile_snapshot_id !== 'string') ||
    typeof reset_reason !== 'string'
  ) {
    throw new PlatformError('Corrupted session generation row field types', 'IMPORT_CORRUPTION');
  }
  return {
    id,
    user_id,
    route_id,
    generation_number: toSafeInteger(generation_number),
    dsh_session_id,
    agent_profile_snapshot_id,
    reset_reason,
  };
}

interface SessionSourceDbRow {
  readonly id: string;
  readonly route_id: string;
  readonly source_type: string;
  readonly source_id: string;
  readonly user_id: string;
  readonly metadata: string | null;
}

function parseSessionSourceDbRow(row: unknown): SessionSourceDbRow {
  if (!isRecord(row)) {
    throw new PlatformError('Corrupted session source row in database', 'IMPORT_CORRUPTION');
  }
  const { id, route_id, source_type, source_id, user_id, metadata } = row;
  if (
    typeof id !== 'string' ||
    typeof route_id !== 'string' ||
    typeof source_type !== 'string' ||
    typeof source_id !== 'string' ||
    typeof user_id !== 'string' ||
    (metadata !== null && typeof metadata !== 'string')
  ) {
    throw new PlatformError('Corrupted session source row field types', 'IMPORT_CORRUPTION');
  }
  return { id, route_id, source_type, source_id, user_id, metadata };
}

interface WebMessageDbRow {
  readonly id: string;
  readonly session_id: string;
  readonly user_id: string;
  readonly role: string;
  readonly content: string;
  readonly status: string;
  readonly route_key: string;
  readonly metadata: string | null;
}

function parseWebMessageDbRow(row: unknown): WebMessageDbRow {
  if (!isRecord(row)) {
    throw new PlatformError('Corrupted web message row in database', 'IMPORT_CORRUPTION');
  }
  const { id, session_id, user_id, role, content, status, route_key, metadata } = row;
  if (
    typeof id !== 'string' ||
    typeof session_id !== 'string' ||
    typeof user_id !== 'string' ||
    typeof role !== 'string' ||
    typeof content !== 'string' ||
    typeof status !== 'string' ||
    typeof route_key !== 'string' ||
    (metadata !== null && typeof metadata !== 'string')
  ) {
    throw new PlatformError('Corrupted web message row field types', 'IMPORT_CORRUPTION');
  }
  return { id, session_id, user_id, role, content, status, route_key, metadata };
}

interface WebEventDbRow {
  readonly id: string;
  readonly session_id: string;
  readonly user_id: string;
  readonly type: string;
  readonly payload: string;
}

function parseWebEventDbRow(row: unknown): WebEventDbRow {
  if (!isRecord(row)) {
    throw new PlatformError('Corrupted web event row in database', 'IMPORT_CORRUPTION');
  }
  const { id, session_id, user_id, type, payload } = row;
  if (
    typeof id !== 'string' ||
    typeof session_id !== 'string' ||
    typeof user_id !== 'string' ||
    typeof type !== 'string' ||
    typeof payload !== 'string'
  ) {
    throw new PlatformError('Corrupted web event row field types', 'IMPORT_CORRUPTION');
  }
  return { id, session_id, user_id, type, payload };
}

interface FixedImportProvenanceDbRow {
  readonly id: string;
  readonly user_id: string;
  readonly source_fingerprint: string;
  readonly source_chat_jid: string;
  readonly source_message_id: string;
  readonly target_space_id: string;
  readonly target_route_id: string;
  readonly target_dsh_session_id: string;
  readonly target_message_id: string;
  readonly target_event_id: string;
}

function parseFixedImportProvenanceDbRow(row: unknown): FixedImportProvenanceDbRow {
  if (!isRecord(row)) {
    throw new PlatformError('Corrupted provenance row in database', 'IMPORT_CORRUPTION');
  }
  const {
    id,
    user_id,
    source_fingerprint,
    source_chat_jid,
    source_message_id,
    target_space_id,
    target_route_id,
    target_dsh_session_id,
    target_message_id,
    target_event_id,
  } = row;
  if (
    typeof id !== 'string' ||
    typeof user_id !== 'string' ||
    typeof source_fingerprint !== 'string' ||
    typeof source_chat_jid !== 'string' ||
    typeof source_message_id !== 'string' ||
    typeof target_space_id !== 'string' ||
    typeof target_route_id !== 'string' ||
    typeof target_dsh_session_id !== 'string' ||
    typeof target_message_id !== 'string' ||
    typeof target_event_id !== 'string'
  ) {
    throw new PlatformError('Corrupted provenance row field types', 'IMPORT_CORRUPTION');
  }
  return {
    id,
    user_id,
    source_fingerprint,
    source_chat_jid,
    source_message_id,
    target_space_id,
    target_route_id,
    target_dsh_session_id,
    target_message_id,
    target_event_id,
  };
}

function parseCountRow(row: unknown): number {
  if (!isRecord(row)) {
    throw new PlatformError('Corrupted count row in database', 'IMPORT_CORRUPTION');
  }
  return toSafeInteger(row.count);
}

interface MessageItem {
  chat: CompiledChat;
  event: SeedEvent;
  role: 'user' | 'assistant';
  content: string;
  sourceMsgId: string;
  msgId: string;
  eventId: string;
  provId: string;
  metadataStr: string | null;
}

function processAndValidateSeedEvents(
  chats: readonly CompiledChat[],
  userId: string,
  sourceFingerprint: string
): { items: MessageItem[]; totalAttachments: number } {
  const items: MessageItem[] = [];
  let totalAttachments = 0;

  for (const chat of chats) {
    for (const event of chat.seed) {
      if (typeof event.time !== 'number' || !Number.isSafeInteger(event.time) || event.time < 0) {
        throw new ValidationError('Invalid seed event time');
      }
      if (typeof event.seq !== 'number' || !Number.isSafeInteger(event.seq) || event.seq < 0) {
        throw new ValidationError('Invalid seed event seq');
      }
      if (typeof event.type !== 'string' || event.type.length === 0) {
        throw new ValidationError('Invalid seed event type');
      }

      if (event.type !== 'user/message' && event.type !== 'assistant/message') {
        continue;
      }

      let role: 'user' | 'assistant';
      let text = '';
      let rawId = '';

      if (event.type === 'user/message') {
        role = 'user';
        if (!isRecord(event.data)) {
          throw new ValidationError('Malformed user/message event data');
        }
        const contentBlocks = event.data.content;
        if (!Array.isArray(contentBlocks) || contentBlocks.length === 0) {
          throw new ValidationError('Missing user message content blocks');
        }
        const textParts: string[] = [];
        for (const block of contentBlocks) {
          if (!isRecord(block) || typeof block.text !== 'string') {
            throw new ValidationError('Invalid user message text block');
          }
          textParts.push(block.text);
        }
        text = textParts.join('');
        if (typeof event.data.id !== 'string' || event.data.id.length === 0) {
          throw new ValidationError('Missing or invalid id in user message event');
        }
        rawId = event.data.id;
      } else {
        role = 'assistant';
        if (!isRecord(event.data) || !isRecord(event.data.message)) {
          throw new ValidationError('Malformed assistant/message event data');
        }
        const msgObj = event.data.message;
        const contentBlocks = msgObj.content;
        if (!Array.isArray(contentBlocks) || contentBlocks.length === 0) {
          throw new ValidationError('Missing assistant message content blocks');
        }
        const textParts: string[] = [];
        for (const block of contentBlocks) {
          if (!isRecord(block) || typeof block.text !== 'string') {
            throw new ValidationError('Invalid assistant message text block');
          }
          textParts.push(block.text);
        }
        text = textParts.join('');
        if (typeof msgObj.id !== 'string' || msgObj.id.length === 0) {
          throw new ValidationError('Missing or invalid id in assistant message event');
        }
        rawId = msgObj.id;
      }

      if (text.length === 0) {
        throw new ValidationError('Encountered empty message text');
      }

      const prefix = `import:${chat.chatJid}:`;
      if (!rawId.startsWith(prefix)) {
        throw new ValidationError('Message rawId does not start with expected prefix');
      }
      const sourceMsgId = rawId.slice(prefix.length);
      if (sourceMsgId.length === 0) {
        throw new ValidationError('Empty source message ID in message rawId');
      }

      // Generate deterministic collision-resistant full hashes
      const msgId = `impmsg_${createHash('sha256').update(`${userId}:${sourceFingerprint}:${chat.chatJid}:${sourceMsgId}`).digest('hex')}`;
      const eventId = `impev_${createHash('sha256').update(`${userId}:${sourceFingerprint}:${chat.chatJid}:${sourceMsgId}:${event.seq}`).digest('hex')}`;
      const provId = `impprov_${createHash('sha256').update(`${userId}:${sourceFingerprint}:${chat.chatJid}:${sourceMsgId}`).digest('hex')}`;

      // Extract attachment references if present
      const lines = text.split('\n');
      const attachmentPaths = lines
        .filter((l) => l.startsWith('见空间内 '))
        .map((l) => l.slice('见空间内 '.length))
        .filter((p) => p.length > 0);

      let metadataStr: string | null = null;
      if (attachmentPaths.length > 0) {
        for (const p of attachmentPaths) {
          validateRelativeAttachmentPath(p);
        }
        totalAttachments += attachmentPaths.length;
        metadataStr = JSON.stringify({
          attachments: attachmentPaths.map((p) => ({
            path: p,
            name: p.includes('/') ? p.split('/').slice(-1)[0] : p,
          })),
          attachmentCount: attachmentPaths.length,
        });
      }

      items.push({
        chat,
        event,
        role,
        content: text,
        sourceMsgId,
        msgId,
        eventId,
        provId,
        metadataStr,
      });
    }
  }

  return { items, totalAttachments };
}

/**
 * Transactional SQLite Importer for fixed HappyClaw fixtures.
 */
export class SqliteFixedFixtureImporter {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async importFixture(params: FixedFixtureImportParams): Promise<FixedFixtureImportResult> {
    validateImportParams(params);

    const { userId, result } = params;
    const createdAt = params.deterministicCreatedAt ?? result.manifest.createdAt;
    const canonicalHash = computeCanonicalImportHash(result);
    const { items, totalAttachments } = processAndValidateSeedEvents(
      result.chats,
      userId,
      result.manifest.sourceFingerprint
    );

    if (items.length !== FIXED_FIXTURE_INVARIANTS.importedPeopleTalk) {
      throw new ValidationError('Extracted message count mismatch');
    }
    if (totalAttachments !== FIXED_FIXTURE_INVARIANTS.attachments) {
      throw new ValidationError('Extracted attachments count mismatch');
    }

    let inTransaction = false;
    this.db.exec('BEGIN IMMEDIATE;');
    inTransaction = true;

    try {
      // 1. Check for existing receipt for (userId, sourceFingerprint)
      const rawReceiptRow = this.db.prepare(`
        SELECT user_id, source_fingerprint, importer_version, id_algorithm, target_dsh,
               session_format, source_chats_count, source_messages_count,
               imported_messages_count, dropped_messages_count, attachments_count,
               canonical_hash, created_at
        FROM fixed_import_receipts
        WHERE user_id = ? AND source_fingerprint = ?
      `).get(userId, result.manifest.sourceFingerprint);

      if (rawReceiptRow) {
        const receiptRow = parseReceiptDbRow(rawReceiptRow);

        // Deep field-by-field verification of duplicate import
        this.verifyDuplicateImportDeep(userId, result, items, receiptRow, canonicalHash);

        this.db.exec('COMMIT;');
        inTransaction = false;

        const receipt: FixedImportReceipt = {
          userId: receiptRow.user_id,
          sourceFingerprint: receiptRow.source_fingerprint,
          importerVersion: receiptRow.importer_version,
          idAlgorithm: receiptRow.id_algorithm,
          targetDsh: receiptRow.target_dsh,
          sessionFormat: receiptRow.session_format,
          sourceChatsCount: receiptRow.source_chats_count,
          sourceMessagesCount: receiptRow.source_messages_count,
          importedMessagesCount: receiptRow.imported_messages_count,
          droppedMessagesCount: receiptRow.dropped_messages_count,
          attachmentsCount: receiptRow.attachments_count,
          canonicalHash: receiptRow.canonical_hash,
          createdAt: receiptRow.created_at,
        };

        return {
          duplicate: true,
          receipt,
          importedChatsCount: result.chats.length,
          importedMessagesCount: items.length,
          provenanceCount: items.length,
        };
      }

      // 2. No existing receipt: Assert NO pre-existing colliding resources (Strict No-Adoption Policy)
      this.assertNoCollidingResources(userId, result, items);

      // 3. Insert spaces, routes, session_sources, messages, events, receipt, provenance, and generation1 rows
      // 3.1 Spaces
      const spaceInsertStmt = this.db.prepare(`
        INSERT INTO spaces (id, user_id, name, folder, execution_mode, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'container', ?, ?)
      `);

      for (const chat of result.chats) {
        const spaceId = `impsp_${createHash('sha256').update(`${userId}:${result.manifest.sourceFingerprint}:${chat.folder}`).digest('hex')}`;
        const spaceName = chat.folder === 'alice-space' ? 'Alice Project Space' : chat.folder === 'bob-space' ? 'Bob Migration Space' : chat.folder;
        const res = spaceInsertStmt.run(spaceId, userId, spaceName, chat.folder, createdAt, createdAt);
        requireChangesOne(res);
      }

      // 3.2 Session Routes
      const execMode = 'container' as const;
      const routeInsertStmt = this.db.prepare(`
        INSERT INTO session_routes (
          id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const chat of result.chats) {
        const spaceId = `impsp_${createHash('sha256').update(`${userId}:${result.manifest.sourceFingerprint}:${chat.folder}`).digest('hex')}`;
        const res = routeInsertStmt.run(
          chat.sessionId,
          spaceId,
          userId,
          WEB_CHANNEL_NAME,
          DEFAULT_WEB_ACCOUNT_ID,
          chat.sessionId,
          chat.chatJid,
          chat.sessionId,
          execMode,
          createdAt,
          createdAt
        );
        requireChangesOne(res);
      }

      // 3.3 Session Generations (Migration 009 Generation 1 Row is Mandatory)
      const genInsertStmt = this.db.prepare(`
        INSERT INTO session_generations (
          id, user_id, route_id, generation_number, dsh_session_id, agent_profile_snapshot_id, reset_reason, created_at
        ) VALUES (?, ?, ?, 1, ?, NULL, 'initial', ?)
      `);

      for (const chat of result.chats) {
        const genId = `gen_${createHash('sha256').update(`${userId}:${result.manifest.sourceFingerprint}:${chat.sessionId}:gen1`).digest('hex').slice(0, 32)}`;
        const genRes = genInsertStmt.run(genId, userId, chat.sessionId, chat.sessionId, createdAt);
        requireChangesOne(genRes);
      }

      // 3.4 Session Sources
      const sourceInsertStmt = this.db.prepare(`
        INSERT INTO session_sources (
          id, route_id, source_type, source_id, user_id, metadata, created_at
        ) VALUES (?, ?, 'happyclaw', ?, ?, ?, ?)
      `);

      for (const chat of result.chats) {
        const sourceRowId = `impsrc_${createHash('sha256').update(`${userId}:${result.manifest.sourceFingerprint}:${chat.chatJid}`).digest('hex')}`;
        const metaStr = JSON.stringify({
          folder: chat.folder,
          sourceExecutionMode: chat.report.executionMode,
          sourceMessages: chat.report.sourceMessages,
          importedMessages: chat.report.importedPeopleTalk,
          droppedEmpty: chat.report.droppedEmpty,
          attachments: chat.report.attachments,
        });
        const res = sourceInsertStmt.run(sourceRowId, chat.sessionId, chat.chatJid, userId, metaStr, createdAt);
        requireChangesOne(res);
      }

      // 3.5 Web Messages
      const msgInsertStmt = this.db.prepare(`
        INSERT INTO web_messages (
          id, session_id, user_id, role, content, status, route_key, metadata, created_at
        ) VALUES (?, ?, ?, ?, ?, 'delivered', ?, ?, ?)
      `);

      // 3.6 Web Events
      const eventInsertStmt = this.db.prepare(`
        INSERT INTO web_events (
          id, session_id, user_id, type, payload, created_at
        ) VALUES (?, ?, ?, 'message', ?, ?)
      `);

      for (const item of items) {
        const routeKey = buildRouteKey({
          userId,
          channel: WEB_CHANNEL_NAME,
          accountId: DEFAULT_WEB_ACCOUNT_ID,
          nativeContextId: item.chat.sessionId,
        });

        const msgRes = msgInsertStmt.run(
          item.msgId,
          item.chat.sessionId,
          userId,
          item.role,
          item.content,
          routeKey,
          item.metadataStr,
          createdAt
        );
        requireChangesOne(msgRes);

        const eventPayload = {
          id: item.msgId,
          sessionId: item.chat.sessionId,
          userId,
          role: item.role,
          content: item.content,
          routeKey,
          createdAt,
          message: {
            id: item.msgId,
            sessionId: item.chat.sessionId,
            userId,
            role: item.role,
            content: item.content,
            status: 'delivered',
            routeKey,
            timestamp: createdAt,
            metadata: item.metadataStr ? JSON.parse(item.metadataStr) : undefined,
          },
        };

        const evRes = eventInsertStmt.run(
          item.eventId,
          item.chat.sessionId,
          userId,
          JSON.stringify(eventPayload),
          createdAt
        );
        requireChangesOne(evRes);
      }

      // 3.7 Fixed Import Receipt (Inserted before provenance so FK references succeed)
      const receiptInsertStmt = this.db.prepare(`
        INSERT INTO fixed_import_receipts (
          user_id, source_fingerprint, importer_version, id_algorithm, target_dsh,
          session_format, source_chats_count, source_messages_count,
          imported_messages_count, dropped_messages_count, attachments_count,
          canonical_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const receiptRes = receiptInsertStmt.run(
        userId,
        result.manifest.sourceFingerprint,
        result.manifest.importerVersion,
        result.manifest.idAlgorithm,
        result.manifest.targetDsh,
        result.manifest.sessionFormat,
        result.stats.chats,
        result.stats.sourceMessages,
        result.stats.importedPeopleTalk,
        result.stats.droppedEmpty,
        result.stats.attachments,
        canonicalHash,
        createdAt
      );
      requireChangesOne(receiptRes);

      // 3.8 Fixed Import Provenance
      const provInsertStmt = this.db.prepare(`
        INSERT INTO fixed_import_provenance (
          id, user_id, source_fingerprint, source_chat_jid, source_message_id,
          target_space_id, target_route_id, target_dsh_session_id,
          target_message_id, target_event_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const item of items) {
        const targetSpaceId = `impsp_${createHash('sha256').update(`${userId}:${result.manifest.sourceFingerprint}:${item.chat.folder}`).digest('hex')}`;
        const provRes = provInsertStmt.run(
          item.provId,
          userId,
          result.manifest.sourceFingerprint,
          item.chat.chatJid,
          item.sourceMsgId,
          targetSpaceId,
          item.chat.sessionId,
          item.chat.sessionId,
          item.msgId,
          item.eventId,
          createdAt
        );
        requireChangesOne(provRes);
      }

      this.db.exec('COMMIT;');
      inTransaction = false;

      const newReceipt: FixedImportReceipt = {
        userId,
        sourceFingerprint: result.manifest.sourceFingerprint,
        importerVersion: result.manifest.importerVersion,
        idAlgorithm: result.manifest.idAlgorithm,
        targetDsh: result.manifest.targetDsh,
        sessionFormat: result.manifest.sessionFormat,
        sourceChatsCount: result.stats.chats,
        sourceMessagesCount: result.stats.sourceMessages,
        importedMessagesCount: result.stats.importedPeopleTalk,
        droppedMessagesCount: result.stats.droppedEmpty,
        attachmentsCount: result.stats.attachments,
        canonicalHash,
        createdAt,
      };

      return {
        duplicate: false,
        receipt: newReceipt,
        importedChatsCount: result.chats.length,
        importedMessagesCount: items.length,
        provenanceCount: items.length,
      };
    } catch (primaryErr) {
      if (inTransaction) {
        try {
          this.db.exec('ROLLBACK;');
        } catch (rollbackErr) {
          throw new AggregateError(
            [primaryErr, rollbackErr],
            'Fixed fixture import failed and database ROLLBACK also failed'
          );
        }
      }
      throw primaryErr;
    }
  }

  /**
   * Asserts no collisions exist across spaces, routes, sources, messages, events, provenance, receipts, and generations.
   */
  private assertNoCollidingResources(
    userId: string,
    result: ImportResult,
    items: MessageItem[]
  ): void {
    // 1. Space collisions
    const spaceCheckStmt = this.db.prepare('SELECT id FROM spaces WHERE id = ? OR (user_id = ? AND folder = ?) LIMIT 1');
    for (const chat of result.chats) {
      const spaceId = `impsp_${createHash('sha256').update(`${userId}:${result.manifest.sourceFingerprint}:${chat.folder}`).digest('hex')}`;
      const row = spaceCheckStmt.get(spaceId, userId, chat.folder);
      if (row) {
        throw new PlatformError(
          'Cannot adopt pre-existing space without valid import receipt',
          'IMPORT_COLLISION'
        );
      }
    }

    // 2. Route collisions (global and tenant-scoped)
    const routeCheckStmt = this.db.prepare('SELECT id FROM session_routes WHERE id = ? OR dsh_session_id = ? OR (user_id = ? AND channel = ? AND account_id = ? AND native_context_id = ?) LIMIT 1');
    for (const chat of result.chats) {
      const row = routeCheckStmt.get(chat.sessionId, chat.sessionId, userId, WEB_CHANNEL_NAME, DEFAULT_WEB_ACCOUNT_ID, chat.sessionId);
      if (row) {
        throw new PlatformError(
          'Cannot adopt pre-existing session route without valid import receipt',
          'IMPORT_COLLISION'
        );
      }
    }

    // 3. Generations collisions
    const genCheckStmt = this.db.prepare('SELECT id FROM session_generations WHERE id = ? OR (route_id = ? AND generation_number = 1) OR (user_id = ? AND route_id = ?) LIMIT 1');
    for (const chat of result.chats) {
      const genId = `gen_${createHash('sha256').update(`${userId}:${result.manifest.sourceFingerprint}:${chat.sessionId}:gen1`).digest('hex').slice(0, 32)}`;
      const row = genCheckStmt.get(genId, chat.sessionId, userId, chat.sessionId);
      if (row) {
        throw new PlatformError(
          'Cannot adopt pre-existing session generation without valid import receipt',
          'IMPORT_COLLISION'
        );
      }
    }

    // 4. Source collisions
    const sourceCheckStmt = this.db.prepare('SELECT id FROM session_sources WHERE id = ? OR (user_id = ? AND source_type = ? AND source_id = ?) OR route_id = ? LIMIT 1');
    for (const chat of result.chats) {
      const sourceId = `impsrc_${createHash('sha256').update(`${userId}:${result.manifest.sourceFingerprint}:${chat.chatJid}`).digest('hex')}`;
      const row = sourceCheckStmt.get(sourceId, userId, 'happyclaw', chat.chatJid, chat.sessionId);
      if (row) {
        throw new PlatformError(
          'Cannot adopt pre-existing session source without valid import receipt',
          'IMPORT_COLLISION'
        );
      }
    }

    // 5. Message collisions
    const msgCheckStmt = this.db.prepare('SELECT id FROM web_messages WHERE id = ? OR (user_id = ? AND session_id = ? AND id = ?) LIMIT 1');
    for (const item of items) {
      const row = msgCheckStmt.get(item.msgId, userId, item.chat.sessionId, item.msgId);
      if (row) {
        throw new PlatformError(
          'Cannot adopt pre-existing web message without valid import receipt',
          'IMPORT_COLLISION'
        );
      }
    }

    // 6. Event collisions
    const evCheckStmt = this.db.prepare('SELECT id FROM web_events WHERE id = ? OR (user_id = ? AND session_id = ? AND id = ?) LIMIT 1');
    for (const item of items) {
      const row = evCheckStmt.get(item.eventId, userId, item.chat.sessionId, item.eventId);
      if (row) {
        throw new PlatformError(
          'Cannot adopt pre-existing web event without valid import receipt',
          'IMPORT_COLLISION'
        );
      }
    }

    // 7. Provenance collisions
    const provCheckStmt = this.db.prepare('SELECT id FROM fixed_import_provenance WHERE id = ? OR (user_id = ? AND source_fingerprint = ? AND source_chat_jid = ? AND source_message_id = ?) LIMIT 1');
    for (const item of items) {
      const row = provCheckStmt.get(item.provId, userId, result.manifest.sourceFingerprint, item.chat.chatJid, item.sourceMsgId);
      if (row) {
        throw new PlatformError(
          'Cannot adopt pre-existing provenance record without valid import receipt',
          'IMPORT_COLLISION'
        );
      }
    }
  }

  /**
   * Performs deep, field-by-field verification of the entire import tree for duplicate requests.
   */
  private verifyDuplicateImportDeep(
    userId: string,
    result: ImportResult,
    items: MessageItem[],
    receiptRow: ReceiptDbRow,
    expectedCanonicalHash: string
  ): void {
    // 1. Verify receipt fields with exact types
    if (receiptRow.canonical_hash !== expectedCanonicalHash) {
      throw new PlatformError(
        'Import receipt corruption: canonical hash mismatch',
        'IMPORT_CORRUPTION'
      );
    }
    if (
      receiptRow.user_id !== userId ||
      receiptRow.source_fingerprint !== result.manifest.sourceFingerprint ||
      receiptRow.importer_version !== FIXED_FIXTURE_INVARIANTS.importerVersion ||
      receiptRow.id_algorithm !== FIXED_FIXTURE_INVARIANTS.idAlgorithm ||
      receiptRow.target_dsh !== FIXED_FIXTURE_INVARIANTS.targetDsh ||
      receiptRow.session_format !== FIXED_FIXTURE_INVARIANTS.sessionFormat ||
      receiptRow.source_chats_count !== FIXED_FIXTURE_INVARIANTS.chats ||
      receiptRow.source_messages_count !== FIXED_FIXTURE_INVARIANTS.sourceMessages ||
      receiptRow.imported_messages_count !== FIXED_FIXTURE_INVARIANTS.importedPeopleTalk ||
      receiptRow.dropped_messages_count !== FIXED_FIXTURE_INVARIANTS.droppedEmpty ||
      receiptRow.attachments_count !== FIXED_FIXTURE_INVARIANTS.attachments
    ) {
      throw new PlatformError('Import receipt corruption: stored receipt invariants mismatch', 'IMPORT_CORRUPTION');
    }

    // 2. Verify spaces
    const spaceStmt = this.db.prepare('SELECT id, user_id, name, folder, execution_mode FROM spaces WHERE id = ? AND user_id = ?');
    for (const chat of result.chats) {
      const spaceId = `impsp_${createHash('sha256').update(`${userId}:${result.manifest.sourceFingerprint}:${chat.folder}`).digest('hex')}`;
      const rawSpace = spaceStmt.get(spaceId, userId);
      if (!rawSpace) {
        throw new PlatformError('Import corruption: missing space for existing receipt', 'IMPORT_CORRUPTION');
      }
      const spaceRow = parseSpaceDbRow(rawSpace);
      if (spaceRow.folder !== chat.folder || spaceRow.execution_mode !== 'container') {
        throw new PlatformError('Import corruption: corrupted space attributes', 'IMPORT_CORRUPTION');
      }
    }

    // 3. Verify session routes
    const routeStmt = this.db.prepare('SELECT id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode FROM session_routes WHERE id = ? AND user_id = ?');
    for (const chat of result.chats) {
      const spaceId = `impsp_${createHash('sha256').update(`${userId}:${result.manifest.sourceFingerprint}:${chat.folder}`).digest('hex')}`;
      const rawRoute = routeStmt.get(chat.sessionId, userId);
      if (!rawRoute) {
        throw new PlatformError('Import corruption: missing session route for existing receipt', 'IMPORT_CORRUPTION');
      }
      const routeRow = parseSessionRouteDbRow(rawRoute);
      if (
        routeRow.space_id !== spaceId ||
        routeRow.channel !== WEB_CHANNEL_NAME ||
        routeRow.account_id !== DEFAULT_WEB_ACCOUNT_ID ||
        routeRow.native_context_id !== chat.sessionId ||
        routeRow.peer_id !== chat.chatJid ||
        routeRow.dsh_session_id !== chat.sessionId ||
        routeRow.execution_mode !== 'container'
      ) {
        throw new PlatformError('Import corruption: corrupted session route attributes', 'IMPORT_CORRUPTION');
      }
    }

    // 4. Verify session generations (Mandatory)
    const genStmt = this.db.prepare('SELECT id, user_id, route_id, generation_number, dsh_session_id, agent_profile_snapshot_id, reset_reason FROM session_generations WHERE route_id = ? AND user_id = ? AND generation_number = 1');
    for (const chat of result.chats) {
      const rawGen = genStmt.get(chat.sessionId, userId);
      if (!rawGen) {
        throw new PlatformError('Import corruption: missing session generation for existing receipt', 'IMPORT_CORRUPTION');
      }
      const genRow = parseSessionGenerationDbRow(rawGen);
      if (
        genRow.user_id !== userId ||
        genRow.route_id !== chat.sessionId ||
        genRow.generation_number !== 1 ||
        genRow.dsh_session_id !== chat.sessionId ||
        genRow.agent_profile_snapshot_id !== null ||
        genRow.reset_reason !== 'initial'
      ) {
        throw new PlatformError('Import corruption: corrupted session generation attributes', 'IMPORT_CORRUPTION');
      }
    }

    // 5. Verify session sources
    const sourceStmt = this.db.prepare('SELECT id, route_id, source_type, source_id, user_id, metadata FROM session_sources WHERE id = ? AND user_id = ?');
    for (const chat of result.chats) {
      const sourceId = `impsrc_${createHash('sha256').update(`${userId}:${result.manifest.sourceFingerprint}:${chat.chatJid}`).digest('hex')}`;
      const rawSource = sourceStmt.get(sourceId, userId);
      if (!rawSource) {
        throw new PlatformError('Import corruption: missing session source for existing receipt', 'IMPORT_CORRUPTION');
      }
      const sourceRow = parseSessionSourceDbRow(rawSource);
      if (sourceRow.route_id !== chat.sessionId || sourceRow.source_type !== 'happyclaw' || sourceRow.source_id !== chat.chatJid) {
        throw new PlatformError('Import corruption: corrupted session source attributes', 'IMPORT_CORRUPTION');
      }
    }

    // 6. Verify web messages
    const msgStmt = this.db.prepare('SELECT id, session_id, user_id, role, content, status, route_key, metadata FROM web_messages WHERE id = ? AND user_id = ? AND session_id = ?');
    for (const item of items) {
      const routeKey = buildRouteKey({
        userId,
        channel: WEB_CHANNEL_NAME,
        accountId: DEFAULT_WEB_ACCOUNT_ID,
        nativeContextId: item.chat.sessionId,
      });

      const rawMsg = msgStmt.get(item.msgId, userId, item.chat.sessionId);
      if (!rawMsg) {
        throw new PlatformError('Import corruption: missing web message for existing receipt', 'IMPORT_CORRUPTION');
      }
      const msgRow = parseWebMessageDbRow(rawMsg);
      if (
        msgRow.role !== item.role ||
        msgRow.content !== item.content ||
        msgRow.status !== 'delivered' ||
        msgRow.route_key !== routeKey ||
        (item.metadataStr !== null && msgRow.metadata !== item.metadataStr)
      ) {
        throw new PlatformError('Import corruption: corrupted web message attributes', 'IMPORT_CORRUPTION');
      }
    }

    // 7. Verify web events
    const evStmt = this.db.prepare('SELECT id, session_id, user_id, type, payload FROM web_events WHERE id = ? AND user_id = ? AND session_id = ?');
    for (const item of items) {
      const rawEv = evStmt.get(item.eventId, userId, item.chat.sessionId);
      if (!rawEv) {
        throw new PlatformError('Import corruption: missing web event for existing receipt', 'IMPORT_CORRUPTION');
      }
      const evRow = parseWebEventDbRow(rawEv);
      if (evRow.type !== 'message' || typeof evRow.payload !== 'string') {
        throw new PlatformError('Import corruption: corrupted web event payload', 'IMPORT_CORRUPTION');
      }
    }

    // 8. Verify provenance
    const provStmt = this.db.prepare('SELECT id, user_id, source_fingerprint, source_chat_jid, source_message_id, target_space_id, target_route_id, target_dsh_session_id, target_message_id, target_event_id FROM fixed_import_provenance WHERE id = ? AND user_id = ?');
    for (const item of items) {
      const targetSpaceId = `impsp_${createHash('sha256').update(`${userId}:${result.manifest.sourceFingerprint}:${item.chat.folder}`).digest('hex')}`;
      const rawProv = provStmt.get(item.provId, userId);
      if (!rawProv) {
        throw new PlatformError('Import corruption: missing provenance record for existing receipt', 'IMPORT_CORRUPTION');
      }
      const provRow = parseFixedImportProvenanceDbRow(rawProv);
      if (
        provRow.source_fingerprint !== result.manifest.sourceFingerprint ||
        provRow.source_chat_jid !== item.chat.chatJid ||
        provRow.source_message_id !== item.sourceMsgId ||
        provRow.target_space_id !== targetSpaceId ||
        provRow.target_route_id !== item.chat.sessionId ||
        provRow.target_dsh_session_id !== item.chat.sessionId ||
        provRow.target_message_id !== item.msgId ||
        provRow.target_event_id !== item.eventId
      ) {
        throw new PlatformError('Import corruption: corrupted provenance record attributes', 'IMPORT_CORRUPTION');
      }
    }

    // 9. Strict row count checks
    const spaceIds = result.chats.map((c) => `impsp_${createHash('sha256').update(`${userId}:${result.manifest.sourceFingerprint}:${c.folder}`).digest('hex')}`);
    const spaceCount = parseCountRow(this.db.prepare('SELECT COUNT(*) as count FROM spaces WHERE user_id = ? AND id IN (?, ?)').get(userId, spaceIds[0], spaceIds[1]));
    if (spaceCount !== FIXED_FIXTURE_INVARIANTS.chats) {
      throw new PlatformError('Import corruption: space count mismatch', 'IMPORT_CORRUPTION');
    }

    const routeCount = parseCountRow(this.db.prepare('SELECT COUNT(*) as count FROM session_routes WHERE user_id = ? AND id IN (?, ?)').get(userId, result.chats[0].sessionId, result.chats[1].sessionId));
    if (routeCount !== FIXED_FIXTURE_INVARIANTS.chats) {
      throw new PlatformError('Import corruption: route count mismatch', 'IMPORT_CORRUPTION');
    }

    const genCount = parseCountRow(this.db.prepare('SELECT COUNT(*) as count FROM session_generations WHERE user_id = ? AND route_id IN (?, ?)').get(userId, result.chats[0].sessionId, result.chats[1].sessionId));
    if (genCount !== FIXED_FIXTURE_INVARIANTS.chats) {
      throw new PlatformError('Import corruption: generation count mismatch', 'IMPORT_CORRUPTION');
    }

    const msgCount = parseCountRow(this.db.prepare('SELECT COUNT(*) as count FROM web_messages WHERE user_id = ? AND session_id IN (?, ?)').get(userId, result.chats[0].sessionId, result.chats[1].sessionId));
    if (msgCount !== FIXED_FIXTURE_INVARIANTS.importedPeopleTalk) {
      throw new PlatformError('Import corruption: message count mismatch', 'IMPORT_CORRUPTION');
    }

    const evCount = parseCountRow(this.db.prepare('SELECT COUNT(*) as count FROM web_events WHERE user_id = ? AND session_id IN (?, ?)').get(userId, result.chats[0].sessionId, result.chats[1].sessionId));
    if (evCount !== FIXED_FIXTURE_INVARIANTS.importedPeopleTalk) {
      throw new PlatformError('Import corruption: event count mismatch', 'IMPORT_CORRUPTION');
    }

    const provCount = parseCountRow(this.db.prepare('SELECT COUNT(*) as count FROM fixed_import_provenance WHERE user_id = ? AND source_fingerprint = ?').get(userId, result.manifest.sourceFingerprint));
    if (provCount !== FIXED_FIXTURE_INVARIANTS.importedPeopleTalk) {
      throw new PlatformError('Import corruption: provenance count mismatch', 'IMPORT_CORRUPTION');
    }
  }
}
