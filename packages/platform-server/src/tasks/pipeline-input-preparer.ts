import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  ValidationError,
  NotFoundError,
  PlatformError,
} from '@enkeep/platform-core';
import type {
  TaskInputPreparationContext,
  TaskInputPreparationResult,
  TaskInputPreparer,
  TaskExecutionBudget,
} from '@enkeep/platform-operations';
import type {
  RuntimeFileApiService,
  TenantRuntimeFileProvider,
  CanonicalFileOperationRequest,
  CanonicalFileOperationResult,
} from '../files/runtime-file-api.js';

export type PipelineCapabilityType = 'pipeline_observation' | 'pipeline_aggregation';

export interface StagedFileRef {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface PipelinePreparationRegistration {
  readonly capability: PipelineCapabilityType;
  readonly targetSpaceId?: string;
  readonly sourceSpaceIds?: readonly string[];
  readonly checkpointPath?: string;
  readonly stagedInputPrefix?: string;
  readonly maxRecordsLimit?: number;
  readonly maxChunkSizeBytes?: number;
  readonly maxTotalSizeBytes?: number;
  readonly enablePagination?: boolean;
  readonly maxWaitMs?: number;
}

export type TenantMemoryReader = (
  userId: string,
  logicalName: string
) => Promise<string | null> | string | null;

export interface PipelineTaskPreparerOptions {
  readonly database: DatabaseSync;
  readonly fileService?: RuntimeFileApiService | TenantRuntimeFileProvider | (() => any);
  readonly registrations?: Map<string, PipelinePreparationRegistration>;
  readonly requiredTaskIds?: Set<string>;
  readonly manifestPath?: string;
  readonly dataRoot?: string;
  readonly dshHome?: string;
  readonly readTenantMemory?: TenantMemoryReader;
}

export interface StagedPipelineObservationEnvelope {
  readonly schemaVersion: '1.0.0';
  readonly taskRunId: string;
  readonly capability: 'pipeline_observation';
  readonly window: {
    readonly sinceCreatedAt: string | null;
    readonly sinceId: string | null;
    readonly checkpointWatermark: {
      readonly createdAt: string | null;
      readonly id: string | null;
    };
  };
  readonly recordsCount: number;
  readonly records?: Array<{
    readonly id: string;
    readonly sessionId: string;
    readonly role: string;
    readonly content: string;
    readonly createdAt: string;
  }>;
  readonly sections?: Record<string, StagedFileRef>;
}

export interface StagedPipelineAggregationEnvelope {
  readonly schemaVersion: '1.0.0';
  readonly taskRunId: string;
  readonly capability: 'pipeline_aggregation';
  readonly window: {
    readonly sinceDate: string;
    readonly untilDate: string;
    readonly lookbackDays: 7;
    readonly timeZone: 'America/Los_Angeles';
    readonly checkpointWatermark: {
      readonly date: string;
      readonly hash: string;
    };
  };
  readonly sections: {
    readonly observations: StagedFileRef & {
      readonly spacesCount: number;
      readonly totalObservationsCount: number;
    };
    readonly buffers: StagedFileRef & {
      readonly knowledgeBufferSize: number;
      readonly interactionBufferSize: number;
      readonly knowledgeArchivesCount: number;
      readonly interactionArchivesCount: number;
    };
    readonly memoryBasis: {
      readonly cognitiveProfile: StagedFileRef;
      readonly aiChatKnowledge: StagedFileRef;
      readonly knowledgeIndex: StagedFileRef;
      readonly interactionRules: StagedFileRef;
    };
  };
}

export type StagedPipelineInputEnvelope =
  | StagedPipelineObservationEnvelope
  | StagedPipelineAggregationEnvelope;

const RUN_ID_SAFE_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;
const DEFAULT_MAX_RECORDS_LIMIT = 1000;
const DEFAULT_MAX_CHUNK_SIZE_BYTES = 1024 * 1024; // 1 MiB per file
const DEFAULT_MAX_TOTAL_SIZE_BYTES = 5 * 1024 * 1024; // 5 MiB total

export function computeLosAngelesCompletedSevenDays(refDate = new Date()): { sinceDate: string; untilDate: string } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const untilDate = formatter.format(refDate);
  const [y, m, d] = untilDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 7);
  const sinceDate = dt.toISOString().slice(0, 10);
  return { sinceDate, untilDate };
}

/**
 * Validates relative path strictly against absolute paths, traversal (..), empty segments,
 * and encoded traversal sequences.
 */
export function validatePipelineRelativePath(rawPath: string, paramName = 'path'): string {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new ValidationError(`Invalid ${paramName}: path must be a non-empty string`);
  }
  const trimmed = rawPath.trim();
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) {
    throw new ValidationError(`Invalid ${paramName}: absolute paths are forbidden`);
  }
  if (/[\0<>:"|?*\x00-\x1f]/.test(trimmed)) {
    throw new ValidationError(`Invalid ${paramName}: control or illegal characters are forbidden`);
  }
  const normalized = trimmed.replace(/\\/g, '/');
  const segments = normalized.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new ValidationError(`Invalid ${paramName}: path traversal or empty segments are forbidden`);
    }
    if (seg.includes('%')) {
      try {
        const decoded = decodeURIComponent(seg);
        if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
          throw new ValidationError(`Invalid ${paramName}: encoded path traversal is forbidden`);
        }
      } catch (decodeErr) {
        if (decodeErr instanceof ValidationError) throw decodeErr;
        throw new ValidationError(`Invalid ${paramName}: malformed percent-encoding or path traversal`);
      }
    }
  }
  return segments.join('/');
}

export const ALLOWED_MEMORY_LOGICAL_NAMES = new Set([
  'cognitive/cognitive-profile.md',
  'knowledge/AI-Chat-Knowledge.md',
  'knowledge/KNOWLEDGE-INDEX.md',
  'interaction/interaction-rules.md',
]);

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function isValidIsoDateString(str: string): boolean {
  if (typeof str !== 'string') return false;
  const trimmed = str.trim();
  if (!ISO_DATE_REGEX.test(trimmed)) return false;
  const time = Date.parse(trimmed);
  if (Number.isNaN(time)) return false;
  // Disallow far future timestamps (> 5 minutes into future)
  if (time > Date.now() + 5 * 60 * 1000) return false;
  return true;
}

export function isFileNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;

  const status = (err as { status?: unknown }).status;
  if (status !== undefined && status !== 404) {
    return false;
  }

  const code = (err as { code?: unknown }).code;
  if (
    code === 'PROVIDER_PROTOCOL_ERROR' ||
    code === 'PROTOCOL_ERROR' ||
    code === 'BAD_GATEWAY' ||
    code === 'FORBIDDEN' ||
    code === 'EACCES' ||
    code === 'EPERM' ||
    code === 'SECURITY_VIOLATION' ||
    code === 'SERVICE_UNAVAILABLE' ||
    code === 'RUNTIME_UNAVAILABLE' ||
    code === 'CONTAINER_OFFLINE' ||
    code === 'QUOTA_EXCEEDED' ||
    code === 'VALIDATION_ERROR' ||
    code === 'INVALID_PATH' ||
    code === 'PATH_TRAVERSAL' ||
    code === 'CONFLICT' ||
    code === 'PRECONDITION_FAILED'
  ) {
    return false;
  }

  const msg = typeof (err as { message?: unknown }).message === 'string'
    ? (err as { message: string }).message
    : '';

  // Non-file entities (space, tenant, user, session, route) are authorization/scope errors, not optional file absence
  if (/\b(space|tenant|user|session|route)\b.*not found/i.test(msg)) {
    return false;
  }

  if (
    code === 'NOT_FOUND' ||
    code === 'ENOENT' ||
    code === 'FS_NOT_FOUND' ||
    code === 'DIRECTORY_NOT_FOUND'
  ) {
    return true;
  }

  if (err instanceof NotFoundError) {
    return true;
  }

  if (status === 404 && (msg.includes('ENOENT') || /file.*not found/i.test(msg) || msg === 'Not Found')) {
    return true;
  }

  if (msg.includes('ENOENT') || /file.*not found/i.test(msg)) {
    return true;
  }

  return false;
}

export class PipelineTaskInputPreparerService {
  private readonly db: DatabaseSync;
  private readonly fileService?: RuntimeFileApiService | TenantRuntimeFileProvider | (() => any);
  private readonly registrations: Map<string, PipelinePreparationRegistration>;
  private readonly requiredTaskIds: Set<string>;
  private readonly dataRoot?: string;
  private readonly dshHome?: string;
  private readonly injectedMemoryReader?: TenantMemoryReader;

  constructor(options: PipelineTaskPreparerOptions) {
    this.db = options.database;
    this.fileService = options.fileService;
    this.registrations = new Map(options.registrations ?? []);
    this.requiredTaskIds = new Set(options.requiredTaskIds ?? []);
    this.dataRoot = options.dataRoot;
    this.dshHome = options.dshHome;
    this.injectedMemoryReader = options.readTenantMemory;

    if (options.manifestPath) {
      this.loadFromManifestFile(options.manifestPath);
    }
  }

  loadFromManifestFile(manifestPath: string): void {
    if (!fs.existsSync(manifestPath)) {
      throw new NotFoundError(`Pipeline manifest file not found at: ${manifestPath}`);
    }
    const raw = fs.readFileSync(manifestPath, 'utf8');
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new ValidationError(`Invalid JSON in pipeline manifest file: ${manifestPath}`);
    }

    // Load explicit required task IDs
    if (Array.isArray(parsed.requiredTaskIds)) {
      for (const id of parsed.requiredTaskIds) {
        if (typeof id === 'string' && id.trim()) {
          this.requiredTaskIds.add(id.trim());
        }
      }
    }

    // Load task capabilities
    const tasksObj = parsed.tasks ?? parsed.pipelineTasks;
    if (tasksObj && typeof tasksObj === 'object' && !Array.isArray(tasksObj)) {
      for (const [taskId, reg] of Object.entries(tasksObj)) {
        if (reg && typeof reg === 'object' && (reg as any).capability) {
          this.registerCapability(taskId, reg as PipelinePreparationRegistration);
        }
      }
    }
  }

  registerCapability(
    taskId: string,
    registration: PipelinePreparationRegistration,
    required = true
  ): void {
    if (!taskId || typeof taskId !== 'string' || !taskId.trim()) {
      throw new ValidationError('Invalid taskId for pipeline capability registration');
    }
    const cleanId = taskId.trim();
    this.registrations.set(cleanId, registration);
    if (required) {
      this.requiredTaskIds.add(cleanId);
    }
  }

  markRequired(taskId: string): void {
    if (taskId && typeof taskId === 'string') {
      this.requiredTaskIds.add(taskId.trim());
    }
  }

  asPreparerHook(): TaskInputPreparer {
    return async (context: TaskInputPreparationContext): Promise<TaskInputPreparationResult | void> => {
      return await this.prepare(context);
    };
  }

  async prepare(context: TaskInputPreparationContext): Promise<TaskInputPreparationResult | void> {
    const { task, payload, tenantId, runId } = context;

    const isRequired = this.requiredTaskIds.has(task.id);
    const registration = this.registrations.get(task.id);

    // If task is required to have pipeline staging but has no valid registration -> FAIL CLOSED
    if (isRequired && !registration) {
      throw new PlatformError(
        `[PIPELINE_PREPARATION_FAILED] Task "${task.id}" requires pipeline staging but registration is missing`,
        'MISSING_PIPELINE_BINDING',
        500
      );
    }

    // If task is not registered and not required -> clean no-op (ordinary tasks unaffected)
    if (!registration) {
      return;
    }

    // Determine executionBudget for registered pipeline observation/aggregation tasks
    // Finite safe integer <= 900000, default 900000, invalid fail closed
    const rawMaxWaitMs = registration.maxWaitMs ?? 900_000;
    if (
      typeof rawMaxWaitMs !== 'number' ||
      !Number.isSafeInteger(rawMaxWaitMs) ||
      rawMaxWaitMs <= 0 ||
      rawMaxWaitMs > 900_000
    ) {
      throw new ValidationError(
        '[INVALID_EXECUTION_BUDGET] Registered task maxWaitMs must be a finite integer between 1 and 900000'
      );
    }
    const executionBudget: TaskExecutionBudget = {
      maxWaitMs: rawMaxWaitMs,
    };

    if (!runId || !RUN_ID_SAFE_REGEX.test(runId)) {
      throw new ValidationError('Task runId must match safe identifier format [a-zA-Z0-9_-]{1,128}');
    }

    // 1. Authoritative target space resolution and boundary verification
    let targetSpaceId = registration.targetSpaceId ?? payload.spaceId;
    if (!targetSpaceId) {
      const routeRow = this.db
        .prepare('SELECT space_id FROM session_routes WHERE id = ? AND user_id = ? LIMIT 1')
        .get(payload.sessionId, tenantId) as { space_id?: string } | undefined;
      if (!routeRow || !routeRow.space_id) {
        throw new NotFoundError('[SPACE_NOT_FOUND] Session route or target space not found for tenant');
      }
      targetSpaceId = routeRow.space_id;
    }

    const spaceRow = this.db
      .prepare('SELECT id, folder, status FROM spaces WHERE id = ? AND user_id = ? LIMIT 1')
      .get(targetSpaceId, tenantId) as { id: string; folder: string; status: string } | undefined;
    if (!spaceRow || spaceRow.status !== 'active') {
      throw new ValidationError('[INVALID_SPACE] Target space is missing or not active for tenant');
    }

    const checkpointPath = validatePipelineRelativePath(
      registration.checkpointPath ?? 'pipeline/.cognitive-last-checkpoint',
      'checkpointPath'
    );
    const stagedPrefix = validatePipelineRelativePath(
      registration.stagedInputPrefix ?? 'pipeline/inputs',
      'stagedInputPrefix'
    );
    const stagedPath = `${stagedPrefix}/${runId}/input.json`;
    const maxRecords = registration.maxRecordsLimit ?? DEFAULT_MAX_RECORDS_LIMIT;
    const maxSizeBytes = registration.maxChunkSizeBytes ?? DEFAULT_MAX_CHUNK_SIZE_BYTES;

    // 2. Retry Immutability: Check if staged input for this exact runId already exists
    // If it exists, verify its integrity and REUSE it without re-querying or overwriting
    try {
      const existingRead = await this.executeFileOp(tenantId, targetSpaceId, {
        op: 'read',
        path: stagedPath,
        encoding: 'utf8',
      });

      if (existingRead && 'content' in existingRead && typeof existingRead.content === 'string') {
        try {
          const parsed = JSON.parse(existingRead.content);
          if (parsed && parsed.schemaVersion === '1.0.0' && parsed.taskRunId === runId) {
            // Valid existing run input: reuse without overwriting
            return {
              preparedPrompt: `[Staged Pipeline Input Location: ${stagedPath}]\n\n${payload.prompt}`,
              stagedPath,
              executionBudget,
            };
          }
        } catch {}
        // If content is corrupted for same run, throw rather than silently overwriting
        throw new PlatformError(
          `[IMMUTABLE_INPUT_CONFLICT] Staged input for run "${runId}" exists but is corrupted. Overwriting same run input is forbidden.`,
          'IMMUTABLE_INPUT_CONFLICT',
          409
        );
      }
    } catch (readErr: any) {
      if (readErr instanceof PlatformError && readErr.code === 'IMMUTABLE_INPUT_CONFLICT') {
        throw readErr;
      }
      if (!isFileNotFoundError(readErr)) {
        throw readErr;
      }
      // File legitimately absent: proceed to generation
    }

    if (registration.capability === 'pipeline_aggregation') {
      return await this.prepareAggregation({
        tenantId,
        targetSpaceId,
        runId,
        stagedPrefix,
        stagedPath,
        checkpointPath,
        registration,
        payloadPrompt: payload.prompt,
        executionBudget,
      });
    }

    return await this.prepareObservation({
      tenantId,
      targetSpaceId,
      runId,
      stagedPath,
      checkpointPath,
      registration,
      payloadPrompt: payload.prompt,
      executionBudget,
    });
  }

  private async prepareAggregation(params: {
    tenantId: string;
    targetSpaceId: string;
    runId: string;
    stagedPrefix: string;
    stagedPath: string;
    checkpointPath: string;
    registration: PipelinePreparationRegistration;
    payloadPrompt: string;
    executionBudget: TaskExecutionBudget;
  }): Promise<TaskInputPreparationResult> {
    const { tenantId, targetSpaceId, runId, stagedPrefix, stagedPath, checkpointPath, registration, payloadPrompt, executionBudget } = params;
    const maxChunkBytes = registration.maxChunkSizeBytes ?? DEFAULT_MAX_CHUNK_SIZE_BYTES;
    const maxTotalBytes = registration.maxTotalSizeBytes ?? DEFAULT_MAX_TOTAL_SIZE_BYTES;
    const runDir = `${stagedPrefix}/${runId}`;

    // 1. Calculate DST-aware 7 completed calendar days in America/Los_Angeles: [sinceDate, untilDate)
    const { sinceDate, untilDate } = computeLosAngelesCompletedSevenDays();

    // 2. Read existing checkpoint if present (read-only, never advance during prep)
    let checkpointDate = sinceDate;
    try {
      const cpRead = await this.executeFileOp(tenantId, targetSpaceId, { op: 'read', path: checkpointPath, encoding: 'utf8' });
      if (cpRead && 'content' in cpRead && typeof cpRead.content === 'string') {
        const trimmed = cpRead.content.trim();
        if (trimmed) checkpointDate = trimmed;
      }
    } catch (cpErr: any) {
      if (!isFileNotFoundError(cpErr)) {
        throw cpErr;
      }
      // Checkpoint is optional: legitimately absent defaults to sinceDate
    }

    // 3. Resolve eligible source spaces for observations
    let eligibleSpaces: Array<{ id: string; folder: string; name: string }>;
    if (registration.sourceSpaceIds && registration.sourceSpaceIds.length > 0) {
      const placeholders = registration.sourceSpaceIds.map(() => '?').join(', ');
      eligibleSpaces = this.db
        .prepare(`SELECT id, folder, name FROM spaces WHERE user_id = ? AND status = 'active' AND id IN (${placeholders})`)
        .all(tenantId, ...registration.sourceSpaceIds) as Array<{ id: string; folder: string; name: string }>;
      if (eligibleSpaces.length === 0) {
        throw new ValidationError('[INVALID_SPACE_SCOPE] None of the specified source spaces are active for tenant');
      }
    } else {
      eligibleSpaces = this.db
        .prepare("SELECT id, folder, name FROM spaces WHERE user_id = ? AND status = 'active'")
        .all(tenantId) as Array<{ id: string; folder: string; name: string }>;
    }

    // 4. Collect observations from eligible spaces within [sinceDate, untilDate)
    const spaceObservations: Array<{ spaceId: string; folder: string; name: string; observations: string[] }> = [];
    let totalObsCount = 0;

    for (const sp of eligibleSpaces) {
      try {
        const obsRead = await this.executeFileOp(tenantId, sp.id, { op: 'read', path: 'observations.md', encoding: 'utf8' });
        if (obsRead && 'content' in obsRead && typeof obsRead.content === 'string' && obsRead.content.trim().length > 0) {
          const lines = obsRead.content.split('\n');
          const filteredLines: string[] = [];
          for (const line of lines) {
            const dateMatch = line.match(/\b(20\d\d-[01]\d-[0-3]\d)\b/);
            if (dateMatch) {
              const d = dateMatch[1];
              if (d >= sinceDate && d < untilDate) {
                filteredLines.push(line);
              }
            } else if (line.trim().length > 0) {
              filteredLines.push(line);
            }
          }
          if (filteredLines.length > 0) {
            spaceObservations.push({
              spaceId: sp.id,
              folder: sp.folder,
              name: sp.name,
              observations: filteredLines,
            });
            totalObsCount += filteredLines.length;
          }
        }
      } catch (obsErr: any) {
        if (!isFileNotFoundError(obsErr)) {
          throw obsErr;
        }
        // observations.md is optional per space; legitimately absent file produces no records
      }
    }

    const observationsSerialized = JSON.stringify(spaceObservations, null, 2);
    const obsBytes = Buffer.byteLength(observationsSerialized, 'utf8');
    if (obsBytes > maxChunkBytes) {
      throw new PlatformError(
        `[DATA_OVER_CAP] Aggregation observations chunk (${obsBytes} bytes) exceeds per-file cap (${maxChunkBytes} bytes)`,
        'DATA_OVER_CAP',
        422
      );
    }
    const obsSha256 = createHash('sha256').update(observationsSerialized).digest('hex');

    // 5. Collect buffers from target space (knowledge-buffer.md, interaction-buffer.md, archives)
    let knowledgeBuffer = '';
    try {
      const kbRead = await this.executeFileOp(tenantId, targetSpaceId, { op: 'read', path: 'pipeline/knowledge-buffer.md', encoding: 'utf8' });
      if (kbRead && 'content' in kbRead && typeof kbRead.content === 'string') knowledgeBuffer = kbRead.content;
    } catch (kbErr: any) {
      if (!isFileNotFoundError(kbErr)) {
        throw kbErr;
      }
      // knowledge-buffer.md is optional: legitimately absent defaults to empty
    }

    let interactionBuffer = '';
    try {
      const ibRead = await this.executeFileOp(tenantId, targetSpaceId, { op: 'read', path: 'pipeline/interaction-buffer.md', encoding: 'utf8' });
      if (ibRead && 'content' in ibRead && typeof ibRead.content === 'string') interactionBuffer = ibRead.content;
    } catch (ibErr: any) {
      if (!isFileNotFoundError(ibErr)) {
        throw ibErr;
      }
      // interaction-buffer.md is optional: legitimately absent defaults to empty
    }

    const buffersData = {
      knowledgeBuffer,
      knowledgeArchives: [] as Array<{ week: string; content: string }>,
      interactionBuffer,
      interactionArchives: [] as Array<{ week: string; content: string }>,
    };

    const buffersSerialized = JSON.stringify(buffersData, null, 2);
    const bufBytes = Buffer.byteLength(buffersSerialized, 'utf8');
    if (bufBytes > maxChunkBytes) {
      throw new PlatformError(
        `[DATA_OVER_CAP] Aggregation buffers chunk (${bufBytes} bytes) exceeds per-file cap (${maxChunkBytes} bytes)`,
        'DATA_OVER_CAP',
        422
      );
    }
    const bufSha256 = createHash('sha256').update(buffersSerialized).digest('hex');

    // 6. Collect 4 memory basis files from authoritative tenant memory root
    const logicalMemoryMap: Record<string, string> = {
      cognitiveProfile: 'cognitive/cognitive-profile.md',
      aiChatKnowledge: 'knowledge/AI-Chat-Knowledge.md',
      knowledgeIndex: 'knowledge/KNOWLEDGE-INDEX.md',
      interactionRules: 'interaction/interaction-rules.md',
    };

    const memoryFilesMap: Record<string, { content: string; sizeBytes: number; sha256: string }> = {};

    for (const [key, logicalName] of Object.entries(logicalMemoryMap)) {
      const content = await this.readLogicalMemoryFile(tenantId, logicalName);
      const sizeBytes = Buffer.byteLength(content, 'utf8');
      if (sizeBytes > maxChunkBytes) {
        throw new PlatformError(
          `[DATA_OVER_CAP] Memory basis file "${logicalName}" (${sizeBytes} bytes) exceeds per-file cap (${maxChunkBytes} bytes)`,
          'DATA_OVER_CAP',
          422
        );
      }
      const sha256 = createHash('sha256').update(content).digest('hex');
      memoryFilesMap[key] = { content, sizeBytes, sha256 };
    }

    // 7. Check total bounded size across all parts
    const totalBytes = obsBytes + bufBytes + Object.values(memoryFilesMap).reduce((acc, m) => acc + m.sizeBytes, 0);
    if (totalBytes > maxTotalBytes) {
      throw new PlatformError(
        `[DATA_OVER_CAP] Total aggregation input size (${totalBytes} bytes) exceeds maximum configured total cap (${maxTotalBytes} bytes)`,
        'DATA_OVER_CAP',
        422
      );
    }

    // 8. Stage parts with requireAbsent: true
    const obsRelPath = `${runDir}/observations.json`;
    await this.executeFileOp(tenantId, targetSpaceId, { op: 'write', path: obsRelPath, content: observationsSerialized, encoding: 'utf8', requireAbsent: true });

    const bufRelPath = `${runDir}/buffers.json`;
    await this.executeFileOp(tenantId, targetSpaceId, { op: 'write', path: bufRelPath, content: buffersSerialized, encoding: 'utf8', requireAbsent: true });

    const memRelRefs: Record<string, StagedFileRef> = {};
    const memFileNames: Record<string, string> = {
      cognitiveProfile: 'memory/cognitive-profile.md',
      aiChatKnowledge: 'memory/AI-Chat-Knowledge.md',
      knowledgeIndex: 'memory/KNOWLEDGE-INDEX.md',
      interactionRules: 'memory/interaction-rules.md',
    };

    for (const [k, relSub] of Object.entries(memFileNames)) {
      const fullPath = `${runDir}/${relSub}`;
      const memInfo = memoryFilesMap[k];
      await this.executeFileOp(tenantId, targetSpaceId, { op: 'write', path: fullPath, content: memInfo.content, encoding: 'utf8', requireAbsent: true });
      memRelRefs[k] = {
        path: relSub,
        sizeBytes: memInfo.sizeBytes,
        sha256: memInfo.sha256,
      };
    }

    const combinedBasisHash = createHash('sha256')
      .update(`${obsSha256}:${bufSha256}:${Object.values(memRelRefs).map(m => m.sha256).join(':')}`)
      .digest('hex');

    // 9. Final input manifest LAST after all parts written & verified
    const aggregationEnvelope: StagedPipelineAggregationEnvelope = {
      schemaVersion: '1.0.0',
      taskRunId: runId,
      capability: 'pipeline_aggregation',
      window: {
        sinceDate,
        untilDate,
        lookbackDays: 7,
        timeZone: 'America/Los_Angeles',
        checkpointWatermark: {
          date: untilDate,
          hash: combinedBasisHash,
        },
      },
      sections: {
        observations: {
          path: 'observations.json',
          sizeBytes: obsBytes,
          sha256: obsSha256,
          spacesCount: spaceObservations.length,
          totalObservationsCount: totalObsCount,
        },
        buffers: {
          path: 'buffers.json',
          sizeBytes: bufBytes,
          sha256: bufSha256,
          knowledgeBufferSize: Buffer.byteLength(knowledgeBuffer, 'utf8'),
          interactionBufferSize: Buffer.byteLength(interactionBuffer, 'utf8'),
          knowledgeArchivesCount: buffersData.knowledgeArchives.length,
          interactionArchivesCount: buffersData.interactionArchives.length,
        },
        memoryBasis: {
          cognitiveProfile: memRelRefs.cognitiveProfile,
          aiChatKnowledge: memRelRefs.aiChatKnowledge,
          knowledgeIndex: memRelRefs.knowledgeIndex,
          interactionRules: memRelRefs.interactionRules,
        },
      },
    };

    const manifestSerialized = JSON.stringify(aggregationEnvelope, null, 2);
    await this.executeFileOp(tenantId, targetSpaceId, { op: 'write', path: stagedPath, content: manifestSerialized, encoding: 'utf8', requireAbsent: true });

    return {
      preparedPrompt: `[Staged Pipeline Input Location: ${stagedPath}]\n\n${payloadPrompt}`,
      stagedPath,
      executionBudget,
    };
  }

  private async prepareObservation(params: {
    tenantId: string;
    targetSpaceId: string;
    runId: string;
    stagedPath: string;
    checkpointPath: string;
    registration: PipelinePreparationRegistration;
    payloadPrompt: string;
    executionBudget: TaskExecutionBudget;
  }): Promise<TaskInputPreparationResult> {
    const { tenantId, targetSpaceId, runId, stagedPath, checkpointPath, registration, payloadPrompt, executionBudget } = params;
    const maxRecords = registration.maxRecordsLimit ?? DEFAULT_MAX_RECORDS_LIMIT;
    const maxSizeBytes = registration.maxChunkSizeBytes ?? DEFAULT_MAX_CHUNK_SIZE_BYTES;

    // 3. Read checkpoint watermark strictly through tenant-scoped file API
    let sinceCreatedAt: string | null = null;
    let sinceId: string | null = null;

    try {
      const checkpointRead = await this.executeFileOp(tenantId, targetSpaceId, {
        op: 'read',
        path: checkpointPath,
        encoding: 'utf8',
      });

      if (checkpointRead && 'content' in checkpointRead && typeof checkpointRead.content === 'string') {
        const trimmed = checkpointRead.content.trim();
        if (!trimmed) {
          throw new PlatformError(
            `[INVALID_CHECKPOINT] Checkpoint file "${checkpointPath}" is empty. Failing explicitly.`,
            'INVALID_CHECKPOINT',
            422
          );
        }

        if (trimmed.startsWith('{')) {
          let parsed: any;
          try {
            parsed = JSON.parse(trimmed);
          } catch (jsonErr: any) {
            throw new PlatformError(
              `[INVALID_CHECKPOINT] Checkpoint file "${checkpointPath}" contains malformed JSON: ${jsonErr.message}`,
              'INVALID_CHECKPOINT',
              422
            );
          }

          const cAt = parsed.createdAt ?? parsed.lastCreatedAt;
          if (!cAt || typeof cAt !== 'string' || !isValidIsoDateString(cAt)) {
            throw new PlatformError(
              `[INVALID_CHECKPOINT] Checkpoint file "${checkpointPath}" contains invalid or future createdAt ISO timestamp: "${cAt}"`,
              'INVALID_CHECKPOINT',
              422
            );
          }

          const cid = parsed.id ?? parsed.lastId;
          if (cid !== undefined && cid !== null && (typeof cid !== 'string' || !cid.trim())) {
            throw new PlatformError(
              `[INVALID_CHECKPOINT] Checkpoint file "${checkpointPath}" contains invalid id: "${cid}"`,
              'INVALID_CHECKPOINT',
              422
            );
          }

          sinceCreatedAt = cAt.trim();
          sinceId = (typeof cid === 'string' && cid.trim()) ? cid.trim() : null;
        } else {
          // Plain timestamp string in primary checkpoint
          if (!isValidIsoDateString(trimmed)) {
            throw new PlatformError(
              `[INVALID_CHECKPOINT] Checkpoint file "${checkpointPath}" contains invalid ISO date string: "${trimmed}"`,
              'INVALID_CHECKPOINT',
              422
            );
          }
          sinceCreatedAt = trimmed;
          sinceId = null;
        }
      }
    } catch (readErr: any) {
      if (readErr instanceof PlatformError && readErr.code === 'INVALID_CHECKPOINT') {
        throw readErr;
      }
      if (!isFileNotFoundError(readErr)) {
        throw readErr;
      }

      // Checkpoint strictly absent (ENOENT/NOT_FOUND): try documented legacy .cognitive-last-date
      try {
        const legacyRead = await this.executeFileOp(tenantId, targetSpaceId, {
          op: 'read',
          path: '.cognitive-last-date',
          encoding: 'utf8',
        });

        if (legacyRead && 'content' in legacyRead && typeof legacyRead.content === 'string') {
          const trimmed = legacyRead.content.trim();
          if (!trimmed) {
            throw new PlatformError(
              `[INVALID_CHECKPOINT] Legacy checkpoint ".cognitive-last-date" is empty. Failing explicitly.`,
              'INVALID_CHECKPOINT',
              422
            );
          }

          if (trimmed.startsWith('{')) {
            let parsed: any;
            try {
              parsed = JSON.parse(trimmed);
            } catch (jsonErr: any) {
              throw new PlatformError(
                `[INVALID_CHECKPOINT] Legacy checkpoint ".cognitive-last-date" contains malformed JSON: ${jsonErr.message}`,
                'INVALID_CHECKPOINT',
                422
              );
            }

            const cAt = parsed.createdAt ?? parsed.lastCreatedAt;
            if (!cAt || typeof cAt !== 'string' || !isValidIsoDateString(cAt)) {
              throw new PlatformError(
                `[INVALID_CHECKPOINT] Legacy checkpoint ".cognitive-last-date" contains invalid ISO timestamp: "${cAt}"`,
                'INVALID_CHECKPOINT',
                422
              );
            }
            const cid = parsed.id ?? parsed.lastId;
            sinceCreatedAt = cAt.trim();
            sinceId = (typeof cid === 'string' && cid.trim()) ? cid.trim() : null;
          } else {
            if (!isValidIsoDateString(trimmed)) {
              throw new PlatformError(
                `[INVALID_CHECKPOINT] Legacy checkpoint ".cognitive-last-date" contains invalid ISO date string: "${trimmed}"`,
                'INVALID_CHECKPOINT',
                422
              );
            }
            sinceCreatedAt = trimmed;
            sinceId = null;
          }
        }
      } catch (legacyErr: any) {
        if (legacyErr instanceof PlatformError && legacyErr.code === 'INVALID_CHECKPOINT') {
          throw legacyErr;
        }
        if (!isFileNotFoundError(legacyErr)) {
          throw legacyErr;
        }
        // Both primary and legacy checkpoints genuinely absent: start from earliest available
        sinceCreatedAt = null;
        sinceId = null;
      }
    }

    // 4. Resolve source spaces canonical scope strictly bound to tenant
    let eligibleSpaceIds: string[];
    if (registration.sourceSpaceIds && registration.sourceSpaceIds.length > 0) {
      // Validate all configured source spaces belong to tenant and are active
      const placeholders = registration.sourceSpaceIds.map(() => '?').join(', ');
      const rows = this.db
        .prepare(`SELECT id FROM spaces WHERE user_id = ? AND status = 'active' AND id IN (${placeholders})`)
        .all(tenantId, ...registration.sourceSpaceIds) as Array<{ id: string }>;
      eligibleSpaceIds = rows.map((r) => r.id);
      if (eligibleSpaceIds.length === 0) {
        throw new ValidationError('[INVALID_SPACE_SCOPE] None of the specified source spaces are active for tenant');
      }
    } else {
      // Default: all active canonical spaces of this tenant
      const rows = this.db
        .prepare('SELECT id FROM spaces WHERE user_id = ? AND status = \'active\'')
        .all(tenantId) as Array<{ id: string }>;
      eligibleSpaceIds = rows.map((r) => r.id);
    }

    // 5. Query web_messages strictly scoped to tenant + eligible spaces with active canonical session routes
    const spacePlaceholders = eligibleSpaceIds.map(() => '?').join(', ');
    let querySql = `
      SELECT m.id, m.session_id, m.role, m.content, m.status, m.turn_id, m.created_at
      FROM web_messages m
      WHERE m.user_id = ?
        AND m.session_id IN (
          SELECT r.id
          FROM session_routes r
          JOIN spaces s ON r.space_id = s.id AND r.user_id = s.user_id
          WHERE r.user_id = ?
            AND r.status = 'active'
            AND s.status = 'active'
            AND (
              r.id = s.canonical_session_id
              OR (s.canonical_session_id IS NULL AND r.id = (
                SELECT r2.id FROM session_routes r2
                WHERE r2.space_id = s.id AND r2.user_id = s.user_id AND r2.status = 'active'
                ORDER BY r2.created_at ASC LIMIT 1
              ))
            )
            AND s.id IN (${spacePlaceholders})
        )
    `;
    const queryParams: any[] = [tenantId, tenantId, ...eligibleSpaceIds];

    if (sinceCreatedAt && sinceId) {
      // Keyset cursor: strictly greater than composite watermark
      querySql += ` AND (m.created_at > ? OR (m.created_at = ? AND m.id > ?))`;
      queryParams.push(sinceCreatedAt, sinceCreatedAt, sinceId);
    } else if (sinceCreatedAt) {
      // Timestamp-only cursor: inclusive >= without fabricated max ID to preserve same-ms records
      querySql += ` AND m.created_at >= ?`;
      queryParams.push(sinceCreatedAt);
    }

    // Limit to maxRecords + 1 to detect when chunking or pagination boundary is reached
    const fetchLimit = maxRecords + 1;
    querySql += ` ORDER BY m.created_at ASC, m.id ASC LIMIT ${fetchLimit}`;

    const rawMessages = this.db.prepare(querySql).all(...queryParams) as Array<{
      id: string;
      session_id: string;
      role: string;
      content: string;
      status: string;
      created_at: string;
    }>;

    if (rawMessages.length > maxRecords && !registration.enablePagination) {
      throw new PlatformError(
        `[DATA_OVER_CAP] Input message count (${rawMessages.length}) exceeds maximum limit (${maxRecords}). Staging halted without advancing checkpoint.`,
        'DATA_OVER_CAP',
        422
      );
    }

    // Sanitize records: strictly exclude credentials, tokens, or system internal rows
    const sanitizedRecords = rawMessages.map((m) => ({
      id: m.id,
      sessionId: m.session_id,
      role: m.role,
      content: m.content,
      createdAt: m.created_at,
    }));

    const runDir = path.dirname(stagedPath);

    // If records fit within maxRecords limit, stage inline (or chunk if raw bytes exceed maxSizeBytes)
    const canStageInline = sanitizedRecords.length <= maxRecords;
    let serializedInline = '';
    let inlineBytes = 0;

    if (canStageInline) {
      const maxCreatedAt = sanitizedRecords.length > 0
        ? sanitizedRecords[sanitizedRecords.length - 1].createdAt
        : sinceCreatedAt;
      const maxId = sanitizedRecords.length > 0
        ? sanitizedRecords[sanitizedRecords.length - 1].id
        : sinceId;

      const inlineEnvelope: StagedPipelineInputEnvelope = {
        schemaVersion: '1.0.0',
        taskRunId: runId,
        capability: 'pipeline_observation',
        window: {
          sinceCreatedAt,
          sinceId,
          checkpointWatermark: {
            createdAt: maxCreatedAt,
            id: maxId,
          },
        },
        recordsCount: sanitizedRecords.length,
        records: sanitizedRecords,
      };

      serializedInline = JSON.stringify(inlineEnvelope, null, 2);
      inlineBytes = Buffer.byteLength(serializedInline, 'utf8');

      if (inlineBytes <= maxSizeBytes) {
        // Fits inline under 1 MiB chunk limit
        await this.executeFileOp(tenantId, targetSpaceId, {
          op: 'write',
          path: stagedPath,
          content: serializedInline,
          encoding: 'utf8',
          requireAbsent: true,
        });

        return {
          preparedPrompt: `[Staged Pipeline Input Location: ${stagedPath}]\n\n${payloadPrompt}`,
          stagedPath,
          executionBudget,
        };
      }
    }

    // When records exceed maxRecords OR serialized size exceeds maxChunkSizeBytes,
    // partition into bounded parts (each <= maxSizeBytes), write parts first, and write manifest last
    // Take at most maxRecords for this batch (bounded upper watermark)
    const batchRecords = sanitizedRecords.slice(0, maxRecords);
    if (batchRecords.length === 0) {
      throw new PlatformError(
        `[DATA_OVER_CAP] Input records cannot be staged within configured caps`,
        'DATA_OVER_CAP',
        422
      );
    }

    const parts: Array<{ relPath: string; fullPath: string; content: string; sizeBytes: number; sha256: string }> = [];
    let currentPartRecords: typeof batchRecords = [];
    let partIndex = 1;

    for (const rec of batchRecords) {
      currentPartRecords.push(rec);
      const testContent = JSON.stringify(currentPartRecords, null, 2);
      const testBytes = Buffer.byteLength(testContent, 'utf8');
      if (testBytes > maxSizeBytes) {
        if (currentPartRecords.length === 1) {
          throw new PlatformError(
            `[DATA_OVER_CAP] Single record (${testBytes} bytes) exceeds maximum chunk cap (${maxSizeBytes} bytes)`,
            'DATA_OVER_CAP',
            422
          );
        }
        // Pop last record, finalize current part
        currentPartRecords.pop();
        const partContent = JSON.stringify(currentPartRecords, null, 2);
        const partBytes = Buffer.byteLength(partContent, 'utf8');
        const partSha256 = createHash('sha256').update(partContent).digest('hex');
        const relSub = `parts/part-${String(partIndex).padStart(4, '0')}.json`;
        parts.push({
          relPath: relSub,
          fullPath: `${runDir}/${relSub}`,
          content: partContent,
          sizeBytes: partBytes,
          sha256: partSha256,
        });
        partIndex++;
        currentPartRecords = [rec];
      }
    }

    if (currentPartRecords.length > 0) {
      const partContent = JSON.stringify(currentPartRecords, null, 2);
      const partBytes = Buffer.byteLength(partContent, 'utf8');
      const partSha256 = createHash('sha256').update(partContent).digest('hex');
      const relSub = `parts/part-${String(partIndex).padStart(4, '0')}.json`;
      parts.push({
        relPath: relSub,
        fullPath: `${runDir}/${relSub}`,
        content: partContent,
        sizeBytes: partBytes,
        sha256: partSha256,
      });
    }

    // Write all immutable parts first with requireAbsent: true
    for (const part of parts) {
      await this.executeFileOp(tenantId, targetSpaceId, {
        op: 'write',
        path: part.fullPath,
        content: part.content,
        encoding: 'utf8',
        requireAbsent: true,
      });
    }

    // Upper watermark reflects strictly the last processed record of this batch
    const lastStagedRecord = batchRecords[batchRecords.length - 1];
    const upperWatermarkCreatedAt = lastStagedRecord.createdAt;
    const upperWatermarkId = lastStagedRecord.id;

    // Construct manifest envelope with sections referencing the parts
    const sectionsObj: Record<string, StagedFileRef> = {};
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      sectionsObj[`part_${i + 1}`] = {
        path: p.relPath,
        sizeBytes: p.sizeBytes,
        sha256: p.sha256,
      };
    }

    const manifestEnvelope: StagedPipelineObservationEnvelope = {
      schemaVersion: '1.0.0',
      taskRunId: runId,
      capability: 'pipeline_observation',
      window: {
        sinceCreatedAt,
        sinceId,
        checkpointWatermark: {
          createdAt: upperWatermarkCreatedAt,
          id: upperWatermarkId,
        },
      },
      recordsCount: batchRecords.length,
      sections: sectionsObj,
    };

    const manifestContent = JSON.stringify(manifestEnvelope, null, 2);
    const manifestBytes = Buffer.byteLength(manifestContent, 'utf8');

    if (manifestBytes > maxSizeBytes) {
      throw new PlatformError(
        `[DATA_OVER_CAP] Staged manifest size (${manifestBytes} bytes) exceeds maximum configured chunk cap (${maxSizeBytes} bytes)`,
        'DATA_OVER_CAP',
        422
      );
    }

    // Write staged manifest last after all parts written & verified
    await this.executeFileOp(tenantId, targetSpaceId, {
      op: 'write',
      path: stagedPath,
      content: manifestContent,
      encoding: 'utf8',
      requireAbsent: true,
    });

    return {
      preparedPrompt: `[Staged Pipeline Input Location: ${stagedPath}]\n\n${payloadPrompt}`,
      stagedPath,
      executionBudget,
    };
  }

  private async executeFileOp(
    userId: string,
    spaceId: string,
    request: CanonicalFileOperationRequest
  ): Promise<CanonicalFileOperationResult> {
    const raw = typeof this.fileService === 'function' ? (this.fileService as Function)() : this.fileService;
    const service = raw as any;
    if (service && typeof service.execute === 'function') {
      return await service.execute(userId, spaceId, request);
    }
    throw new Error('File service provider does not support canonical execute API');
  }

  private async readLogicalMemoryFile(userId: string, logicalName: string): Promise<string> {
    if (!ALLOWED_MEMORY_LOGICAL_NAMES.has(logicalName)) {
      throw new ValidationError(`[FORBIDDEN_MEMORY_PATH] Logical memory name "${logicalName}" is not permitted`);
    }

    if (this.injectedMemoryReader) {
      const res = await this.injectedMemoryReader(userId, logicalName);
      if (typeof res === 'string') {
        return res;
      }
      throw new NotFoundError(`[MISSING_MEMORY_FILE] Required memory file "${logicalName}" not found`);
    }

    const userRow = this.db
      .prepare('SELECT username, status FROM users WHERE id = ?')
      .get(userId) as { username?: string; status?: string } | undefined;
    if (!userRow || !userRow.username || userRow.status !== 'active') {
      throw new PlatformError(
        `[AUTHORIZATION_FAILURE] Active user with ID "${userId}" not found in tenant repository`,
        'AUTHORIZATION_FAILURE',
        403
      );
    }
    const username = userRow.username;

    const resolvedRoot =
      this.dataRoot ??
      this.dshHome ??
      (process.env.ENKEEP_DATA_ROOT || process.env.DSH_HOME || path.join(process.cwd(), '.dsh'));

    const memoryRoot = path.join(resolvedRoot, 'host-runtimes', username, '.dsh', 'memory');
    const targetFile = path.join(memoryRoot, logicalName);

    const absMemoryRoot = path.resolve(memoryRoot);
    const absTargetFile = path.resolve(targetFile);

    if (!absTargetFile.startsWith(absMemoryRoot + path.sep)) {
      throw new PlatformError(
        `[SECURITY_VIOLATION] Memory file "${logicalName}" escapes root boundary`,
        'SECURITY_VIOLATION',
        403
      );
    }

    if (!fs.existsSync(absTargetFile)) {
      throw new NotFoundError(`[MISSING_MEMORY_FILE] Required memory file "${logicalName}" not found`);
    }

    const realTargetFile = fs.realpathSync(absTargetFile);
    const realMemoryRoot = fs.existsSync(absMemoryRoot) ? fs.realpathSync(absMemoryRoot) : absMemoryRoot;
    if (!realTargetFile.startsWith(realMemoryRoot + path.sep) && realTargetFile !== realMemoryRoot) {
      throw new PlatformError(
        `[SECURITY_VIOLATION] Memory file "${logicalName}" escapes root boundary via symlink`,
        'SECURITY_VIOLATION',
        403
      );
    }

    return fs.readFileSync(realTargetFile, 'utf8');
  }
}
