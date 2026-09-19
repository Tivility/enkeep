#!/usr/bin/env node
/**
 * Workspace Task Consumer: Dependency-Free Staged Task Consumer (v2: Manifest & Section Ref Support)
 *
 * Contract:
 * - Envelope schemaVersion: '1.0.0'
 * - Capabilities:
 *   1) pipeline_observation: inline `records` or section-referenced observations
 *   2) pipeline_aggregation: manifest-referenced section files (observations, buffers, memory basis)
 * - Safe relative refs: no traversal (..), no absolute paths, verified byteLength & SHA-256 checksums
 * - Strict caps: No file may exceed 1 MiB (1048576 bytes); over-cap fails explicitly
 * - Checkpoint safety: Commit occurs ONLY after all downstream extraction/aggregation outputs are persisted
 * - Zero database access, zero network calls, zero external npm dependencies
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export const MAX_ALLOWED_FILE_BYTES = 1024 * 1024; // 1 MiB strict cap

export function parseGuidanceLocation(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(/\[Staged Pipeline Input Location:\s*([^\]]+)\]/);
  return match ? match[1].trim() : null;
}

export function validateSafeRelativePath(relPath, paramName = 'section path') {
  if (typeof relPath !== 'string' || !relPath.trim()) {
    throw new Error(`[VALIDATION_ERROR] ${paramName} must be a non-empty string`);
  }
  const trimmed = relPath.trim();
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) {
    throw new Error(`[SECURITY_ERROR] ${paramName}: absolute paths are forbidden (${trimmed})`);
  }
  const normalized = trimmed.replace(/\\/g, '/');
  const segments = normalized.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new Error(`[SECURITY_ERROR] ${paramName}: path traversal or empty segments are forbidden (${trimmed})`);
    }
  }
  return segments.join('/');
}

export function validateStagedEnvelope(envelope, rawByteLength) {
  if (rawByteLength !== undefined && rawByteLength > MAX_ALLOWED_FILE_BYTES) {
    throw new Error(`[DATA_OVER_CAP] Input manifest size (${rawByteLength} bytes) exceeds strict 1 MiB cap. Failing explicitly.`);
  }
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('[VALIDATION_ERROR] Staged input is not a valid object');
  }
  if (envelope.schemaVersion !== '1.0.0') {
    throw new Error(`[VALIDATION_ERROR] Unsupported schemaVersion: "${envelope.schemaVersion}", expected "1.0.0"`);
  }
  if (!envelope.taskRunId || typeof envelope.taskRunId !== 'string') {
    throw new Error('[VALIDATION_ERROR] Missing or invalid taskRunId in staged input');
  }
  if (!envelope.capability || typeof envelope.capability !== 'string') {
    throw new Error('[VALIDATION_ERROR] Missing or invalid capability in staged input');
  }
  if (!envelope.window || typeof envelope.window !== 'object') {
    throw new Error('[VALIDATION_ERROR] Missing window in staged input');
  }
  if (!envelope.window.checkpointWatermark || typeof envelope.window.checkpointWatermark !== 'object') {
    throw new Error('[VALIDATION_ERROR] Missing window.checkpointWatermark in staged input');
  }
  return true;
}

/**
 * Resolves and validates a section file referenced in a manifest
 */
export function loadAndVerifySectionFile(runDir, sectionRef, sectionKey) {
  if (!sectionRef || typeof sectionRef !== 'object') {
    throw new Error(`[VALIDATION_ERROR] Missing section metadata for "${sectionKey}"`);
  }
  const safeRelPath = validateSafeRelativePath(sectionRef.path, `Section "${sectionKey}" path`);
  const fullPath = path.join(runDir, safeRelPath);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`[SECTION_NOT_FOUND] Referenced section file for "${sectionKey}" not found at: ${safeRelPath}`);
  }

  const buf = fs.readFileSync(fullPath);
  const actualBytes = buf.byteLength;

  if (actualBytes > MAX_ALLOWED_FILE_BYTES) {
    throw new Error(`[DATA_OVER_CAP] Section "${sectionKey}" size (${actualBytes} bytes) exceeds strict 1 MiB cap. Failing explicitly.`);
  }

  if (typeof sectionRef.sizeBytes === 'number' && actualBytes !== sectionRef.sizeBytes) {
    throw new Error(`[INTEGRITY_ERROR] Section "${sectionKey}" size mismatch: manifest stated ${sectionRef.sizeBytes}, actual ${actualBytes}`);
  }

  if (sectionRef.sha256) {
    const actualSha256 = crypto.createHash('sha256').update(buf).digest('hex');
    if (actualSha256 !== sectionRef.sha256) {
      throw new Error(`[INTEGRITY_ERROR] Section "${sectionKey}" SHA-256 hash mismatch! Stated: ${sectionRef.sha256}, actual: ${actualSha256}`);
    }
  }

  return buf.toString('utf8');
}

/**
 * Commits checkpoint file atomically with de2 checkpointWatermark format
 */
export function commitCheckpoint(checkpointPath, watermark) {
  if (!watermark) {
    throw new Error('[CHECKPOINT_ERROR] Cannot commit checkpoint without valid watermark');
  }
  const dir = path.dirname(checkpointPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Monotonic safety check if existing checkpoint exists
  if (fs.existsSync(checkpointPath)) {
    try {
      const existingRaw = fs.readFileSync(checkpointPath, 'utf8').trim();
      if (existingRaw.startsWith('{')) {
        const existing = JSON.parse(existingRaw);
        const exCreated = existing.createdAt ?? existing.lastCreatedAt;
        const newCreated = watermark.createdAt ?? watermark.lastCreatedAt;
        if (exCreated && newCreated) {
          if (newCreated < exCreated) {
            throw new Error(`[CHECKPOINT_REGRESSION] New watermark timestamp (${newCreated}) is earlier than existing checkpoint (${exCreated})`);
          }
          if (newCreated === exCreated && existing.id && watermark.id && watermark.id < existing.id) {
            throw new Error(`[CHECKPOINT_REGRESSION] New watermark id (${watermark.id}) is earlier than existing checkpoint id (${existing.id})`);
          }
        }
        if (existing.date && watermark.date && watermark.date < existing.date) {
          throw new Error(`[CHECKPOINT_REGRESSION] New watermark date (${watermark.date}) is earlier than existing checkpoint (${existing.date})`);
        }
      }
    } catch (err) {
      if (err.message && err.message.includes('[CHECKPOINT_REGRESSION]')) throw err;
    }
  }

  const payload = JSON.stringify({
    ...watermark,
    committedAt: new Date().toISOString(),
  }, null, 2);

  const tmpFile = `${checkpointPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
  fs.writeFileSync(tmpFile, payload + '\n', 'utf8');
  fs.renameSync(tmpFile, checkpointPath);
}

/**
 * Normalizes stage receipt from receipts container
 */
export function normalizeStageReceipt(receipts, stage) {
  if (!receipts || typeof receipts !== 'object') return undefined;
  if (receipts[stage] !== undefined) return receipts[stage];
  const receiptKey = `${stage}Receipt`;
  if (receipts[receiptKey] !== undefined) return receipts[receiptKey];
  const persistedKey = `${stage}Persisted`;
  if (receipts[persistedKey] !== undefined) return receipts[persistedKey];
  return undefined;
}

/**
 * Validates receipt for a specific downstream stage (cognitive, knowledge, interaction)
 */
export function validateStageReceipt(receipt, stage, expectedSha256, expectedRecordIds = []) {
  if (receipt === true) {
    return { status: 'changed', legacy: true };
  }
  if (!receipt || typeof receipt !== 'object') {
    throw new Error(`[PERSIST_INCOMPLETE] Cannot advance checkpoint: missing one or more verified persistence receipts (cognitive, knowledge, interaction) - stage "${stage}" is missing or unfulfilled`);
  }
  const status = receipt.status;
  if (!status || typeof status !== 'string') {
    throw new Error(`[PERSIST_INCOMPLETE] Cannot advance checkpoint: missing one or more verified persistence receipts (cognitive, knowledge, interaction) - stage "${stage}" missing status`);
  }
  if (status === 'changed' || status === 'persisted') {
    if (receipt.outputPath !== undefined && (typeof receipt.outputPath !== 'string' || !receipt.outputPath.trim())) {
      throw new Error(`[VALIDATION_ERROR] Stage "${stage}" changed receipt has invalid outputPath`);
    }
    return { status: 'changed', outputPath: receipt.outputPath, hash: receipt.hash };
  }
  if (status === 'no_change' || status === 'verified_no_change') {
    if (receipt.stage && receipt.stage !== stage) {
      throw new Error(`[VALIDATION_ERROR] Stage mismatch for "${stage}": receipt states "${receipt.stage}"`);
    }
    if (!receipt.inputSha256 || typeof receipt.inputSha256 !== 'string') {
      throw new Error(`[VALIDATION_ERROR] Stage "${stage}" no_change receipt missing inputSha256`);
    }
    if (expectedSha256 && receipt.inputSha256 !== expectedSha256) {
      throw new Error(`[INTEGRITY_MISMATCH] Stage "${stage}" inputSha256 mismatch (expected ${expectedSha256}, got ${receipt.inputSha256})`);
    }
    if (!Array.isArray(receipt.coveredSourceIds)) {
      throw new Error(`[VALIDATION_ERROR] Stage "${stage}" no_change receipt missing coveredSourceIds array`);
    }

    // Validate each element is a non-empty string and verify uniqueness
    const coveredSet = new Set();
    for (let i = 0; i < receipt.coveredSourceIds.length; i++) {
      const id = receipt.coveredSourceIds[i];
      if (typeof id !== 'string' || !id.trim()) {
        throw new Error(`[VALIDATION_ERROR] Stage "${stage}" coveredSourceIds contains non-string or empty element at index ${i}`);
      }
      if (coveredSet.has(id)) {
        throw new Error(`[VALIDATION_ERROR] Stage "${stage}" coveredSourceIds contains duplicate id: "${id}"`);
      }
      coveredSet.add(id);
    }

    const expectedSet = new Set(expectedRecordIds);

    // Check missing
    const missing = expectedRecordIds.filter((id) => !coveredSet.has(id));
    if (missing.length > 0) {
      throw new Error(`[INCOMPLETE_COVERAGE] Stage "${stage}" did not examine all staged source records (missing: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '...' : ''})`);
    }

    // Check extra
    const extra = receipt.coveredSourceIds.filter((id) => !expectedSet.has(id));
    if (extra.length > 0) {
      throw new Error(`[INVALID_COVERAGE] Stage "${stage}" coveredSourceIds contains IDs not in staged input (extra: ${extra.slice(0, 3).join(', ')}${extra.length > 3 ? '...' : ''})`);
    }
    if (!receipt.reason || typeof receipt.reason !== 'string' || !receipt.reason.trim()) {
      throw new Error(`[VALIDATION_ERROR] Stage "${stage}" no_change receipt requires non-empty reason`);
    }
    return {
      status: 'no_change',
      stage,
      inputSha256: receipt.inputSha256,
      coveredSourceIds: receipt.coveredSourceIds,
      reason: receipt.reason.trim(),
    };
  }

  // Any unverified/failed/partial status
  throw new Error(`[PERSIST_INCOMPLETE] Cannot advance checkpoint: missing one or more verified persistence receipts (cognitive, knowledge, interaction) - stage "${stage}" outcome is "${status}"`);
}

/**
 * Main consumer entrypoint for both daily and weekly pipelines
 */
export function processStagedExtraction(options) {
  const { inputPathOrGuidance, checkpointFilePath, dryRun = false } = options;

  let resolvedPath = inputPathOrGuidance;
  const fromGuidance = parseGuidanceLocation(inputPathOrGuidance);
  if (fromGuidance) {
    resolvedPath = fromGuidance;
  }

  if (!resolvedPath) {
    throw new Error('[INPUT_NOT_SPECIFIED] No input path or guidance provided');
  }

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`[INPUT_NOT_FOUND] Staged input file does not exist: ${resolvedPath}`);
  }

  const runDir = path.dirname(resolvedPath);
  const buf = fs.readFileSync(resolvedPath);
  const rawByteLength = buf.byteLength;
  const rawStr = buf.toString('utf8');

  let envelope;
  try {
    envelope = JSON.parse(rawStr);
  } catch (err) {
    throw new Error(`[PARSE_ERROR] Failed to parse JSON staged input: ${err.message}`);
  }

  validateStagedEnvelope(envelope, rawByteLength);

  const loadedSections = {};

  // If envelope has section references (e.g. for weekly aggregation or chunked daily)
  if (envelope.sections && typeof envelope.sections === 'object') {
    for (const [key, sectionMeta] of Object.entries(envelope.sections)) {
      if (sectionMeta && typeof sectionMeta === 'object') {
        if (typeof sectionMeta.path === 'string') {
          // Direct section file (e.g. observations, buffers)
          loadedSections[key] = loadAndVerifySectionFile(runDir, sectionMeta, key);
        } else {
          // Nested section group (e.g. memoryBasis: { cognitiveProfile, aiChatKnowledge, ... })
          loadedSections[key] = {};
          for (const [subKey, subMeta] of Object.entries(sectionMeta)) {
            if (subMeta && typeof subMeta.path === 'string') {
              loadedSections[key][subKey] = loadAndVerifySectionFile(runDir, subMeta, `${key}.${subKey}`);
            }
          }
        }
      }
    }
  }

  const watermark = envelope.window.checkpointWatermark;
  const actualInputSha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const sourceRecordIds = Array.isArray(envelope.records)
    ? envelope.records.map((r) => r.id)
    : [];
  const recordsCount = envelope.recordsCount ?? sourceRecordIds.length;

  return {
    success: true,
    envelope,
    resolvedPath,
    runDir,
    taskRunId: envelope.taskRunId,
    capability: envelope.capability,
    recordsCount,
    sourceRecordIds,
    inputSha256: actualInputSha256,
    loadedSections,
    watermark,
    /**
     * Gated checkpoint advance: requires verified receipts from all 3 downstream subagents.
     * Supports both changed (written output) and verified_no_change (examined input without observations).
     */
    commitCheckpointAfterPersist: (persistReceipts) => {
      if (!persistReceipts || typeof persistReceipts !== 'object') {
        throw new Error('[PERSIST_INCOMPLETE] Cannot advance checkpoint: missing one or more verified persistence receipts (cognitive, knowledge, interaction)');
      }
      const stages = ['cognitive', 'knowledge', 'interaction'];
      const validatedOutcomes = {};
      for (const stg of stages) {
        const raw = normalizeStageReceipt(persistReceipts, stg);
        const outcome = validateStageReceipt(raw, stg, actualInputSha256, sourceRecordIds);
        if (outcome.status === 'no_change' && recordsCount > 0 && sourceRecordIds.length === 0) {
          throw new Error(`[UNSUPPORTED_NO_CHANGE] Cannot claim verified_no_change on chunked manifest without inline source records (recordsCount: ${recordsCount})`);
        }
        validatedOutcomes[stg] = outcome;
      }
      if (!dryRun) {
        commitCheckpoint(checkpointFilePath, watermark);
      }
      return true;
    }
  };
}

if (process.argv[1] && process.argv[1].endsWith('workspace-task-consumer.mjs')) {
  const args = process.argv.slice(2);
  const inputArg = args[0] || 'pipeline/inputs/latest/input.json';
  const checkpointArg = args[1] || 'pipeline/.cognitive-last-checkpoint';
  try {
    const res = processStagedExtraction({
      inputPathOrGuidance: inputArg,
      checkpointFilePath: checkpointArg,
      dryRun: true,
    });
    console.log('Staged envelope 1.0.0 validated. Capability:', res.capability, 'TaskRunId:', res.taskRunId);
    if (Object.keys(res.loadedSections).length > 0) {
      console.log('Loaded manifest sections:', Object.keys(res.loadedSections));
    }
  } catch (err) {
    console.error('Consumer error:', err.message);
    process.exit(1);
  }
}
