/**
 * Pre-migration normalizer for DSH Session generations.
 *
 * Implements Class A and Class B normalizations for historical v0 sessions:
 * - (A) Removes `data.source.sourceId` from `user/message` events.
 * - (B) Defers pre-step surface events (user/message etc. before the first step/start)
 *       into the first step.
 * - Migrates through the DSH 0.2 session-format catalog and publishes `session.v4.jsonl`
 *   with exact canonical naming, atomic publish, and 0o600 permissions.
 * - NEVER modifies or deletes `session.jsonl`.
 * - Skips sessions already having a v4 generation.
 * - Verifies each output by opening with DSH 0.2 JSONL persistence (read) and comparing
 *   user and assistant message counts.
 *
 * @module @enkeep/runtime-runner/runtime/session-premigrate
 */

import fs from 'node:fs';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import { createSessionFormatCatalogWithChildren } from '@deepseek-ai/dsh-session-format-catalog';

export const PACKED_CHUNK_TYPES = new Set([
  'text-chunks',
  'reasoning-chunks',
  'tool-call-chunks',
]);

/**
 * Classifies whether a row is a non-event streaming chunk record in DSH v0.
 */
export function isChunkRecord(row: any): boolean {
  return typeof row?.type === 'string' && PACKED_CHUNK_TYPES.has(row.type);
}

/**
 * Remaps sequence references across an array of session events using oldSeq -> newSeq mapping.
 * Shared between pre-migration normalization and fork seed export.
 *
 * Covers every seq-referencing field defined across DSH 0.1.2 (v0) and DSH 0.2 (v1-v4):
 * - sourceEventSeqs on surface-eligible events (number[] or v0 [[start, end]] ranges)
 * - surfaceOp on replace operations (start/end in v0/v1/v2, startSeq/endSeq in v3/v4)
 * - developer/message: headerSeq
 * - compaction/summary & compaction/prune: shadowedRange (start/end, startSeq/endSeq) and shadowedSeqs
 * - command/done: sourceEventSeq
 * - session/title & session/title-llm-request: messageSeqs
 * - session-log-deepseek/delivery-accepted: throughSeq
 * - image/offload: targets[{ seq }]
 * - Any other *Seq or *Seqs member on event data
 */
export function remapEventSequences<T = any>(
  events: T[],
  oldSeqToNewSeq: ReadonlyMap<number, number> | Map<number, number>
): void {
  const mapSeq = (oldSeq: number): number | undefined => {
    return oldSeqToNewSeq.has(oldSeq) ? oldSeqToNewSeq.get(oldSeq) : oldSeq;
  };

  for (const ev of events as any[]) {
    if (!ev || typeof ev !== 'object') continue;

    // 1. sourceEventSeqs on surface-eligible events (or any event with sourceEventSeqs)
    if (Array.isArray(ev.sourceEventSeqs)) {
      ev.sourceEventSeqs = ev.sourceEventSeqs
        .map((entry: any) => {
          if (typeof entry === 'number') {
            return mapSeq(entry);
          }
          if (Array.isArray(entry) && entry.length === 2) {
            const start = typeof entry[0] === 'number' ? mapSeq(entry[0]) : entry[0];
            const end = typeof entry[1] === 'number' ? mapSeq(entry[1]) : entry[1];
            return [start, end];
          }
          return entry;
        })
        .filter((s: any): boolean => {
          if (typeof s === 'number') {
            return Number.isSafeInteger(s) && s >= 0 && (ev.seq === undefined || s < ev.seq);
          }
          if (Array.isArray(s) && s.length === 2) {
            return (
              typeof s[0] === 'number' &&
              typeof s[1] === 'number' &&
              Number.isSafeInteger(s[0]) &&
              Number.isSafeInteger(s[1]) &&
              s[0] >= 0 &&
              s[1] >= s[0] &&
              (ev.seq === undefined || s[1] < ev.seq)
            );
          }
          return false;
        });
    }

    // 2. surfaceOp on surface-eligible events (replace operation requires start/end or startSeq/endSeq)
    if (ev.surfaceOp && typeof ev.surfaceOp === 'object' && ev.surfaceOp.op === 'replace') {
      const rawStart = ev.surfaceOp.startSeq ?? ev.surfaceOp.start;
      const rawEnd = ev.surfaceOp.endSeq ?? ev.surfaceOp.end;
      const mappedStart = typeof rawStart === 'number' ? mapSeq(rawStart) : undefined;
      const mappedEnd = typeof rawEnd === 'number' ? mapSeq(rawEnd) : undefined;
      if (typeof mappedStart === 'number' && typeof mappedEnd === 'number') {
        if (ev.surfaceOp.startSeq !== undefined || ev.surfaceOp.start === undefined) {
          ev.surfaceOp = {
            op: 'replace',
            startSeq: mappedStart,
            endSeq: mappedEnd,
          };
        } else {
          ev.surfaceOp = {
            op: 'replace',
            start: mappedStart,
            end: mappedEnd,
          };
        }
      }
    }

    // 3. developer/message: headerSeq referencing earlier request/header
    if (ev.type === 'developer/message' && ev.data && typeof ev.data.headerSeq === 'number') {
      const mappedHeader = mapSeq(ev.data.headerSeq);
      if (typeof mappedHeader === 'number') {
        ev.data = {
          ...ev.data,
          headerSeq: mappedHeader,
        };
      }
    }

    // 4. compaction/summary and compaction/prune: shadowedRange (start/end or startSeq/endSeq) and shadowedSeqs
    if ((ev.type === 'compaction/summary' || ev.type === 'compaction/prune') && ev.data) {
      let dataModified = false;
      let newShadowedRange = ev.data.shadowedRange;
      let newShadowedSeqs = ev.data.shadowedSeqs;

      if (newShadowedRange && typeof newShadowedRange === 'object') {
        const rawStart = newShadowedRange.startSeq ?? newShadowedRange.start;
        const rawEnd = newShadowedRange.endSeq ?? newShadowedRange.end;
        const mappedStart = typeof rawStart === 'number' ? mapSeq(rawStart) : undefined;
        const mappedEnd = typeof rawEnd === 'number' ? mapSeq(rawEnd) : undefined;
        if (typeof mappedStart === 'number' && typeof mappedEnd === 'number') {
          newShadowedRange = {
            ...newShadowedRange,
            ...(newShadowedRange.start !== undefined || newShadowedRange.startSeq === undefined ? { start: mappedStart } : {}),
            ...(newShadowedRange.end !== undefined || newShadowedRange.endSeq === undefined ? { end: mappedEnd } : {}),
            ...(newShadowedRange.startSeq !== undefined ? { startSeq: mappedStart } : {}),
            ...(newShadowedRange.endSeq !== undefined ? { endSeq: mappedEnd } : {}),
          };
          dataModified = true;
        }
      }

      if (Array.isArray(newShadowedSeqs)) {
        newShadowedSeqs = newShadowedSeqs
          .map((s: number) => (typeof s === 'number' ? mapSeq(s) : s))
          .filter((s: number | undefined): s is number => typeof s === 'number' && Number.isSafeInteger(s) && s >= 0);
        dataModified = true;
      }

      if (dataModified) {
        ev.data = {
          ...ev.data,
          ...(newShadowedRange !== undefined ? { shadowedRange: newShadowedRange } : {}),
          ...(newShadowedSeqs !== undefined ? { shadowedSeqs: newShadowedSeqs } : {}),
        };
      }
    }

    // 5. command/done: sourceEventSeq
    if (ev.type === 'command/done' && ev.data && typeof ev.data.sourceEventSeq === 'number') {
      const mappedSource = mapSeq(ev.data.sourceEventSeq);
      if (typeof mappedSource === 'number') {
        ev.data = {
          ...ev.data,
          sourceEventSeq: mappedSource,
        };
      }
    }

    // 6. session/title and session/title-llm-request: messageSeqs
    if ((ev.type === 'session/title' || ev.type === 'session/title-llm-request') && ev.data && Array.isArray(ev.data.messageSeqs)) {
      ev.data = {
        ...ev.data,
        messageSeqs: ev.data.messageSeqs
          .map((s: number) => (typeof s === 'number' ? mapSeq(s) : s))
          .filter((s: number | undefined): s is number => typeof s === 'number' && Number.isSafeInteger(s) && s >= 0),
      };
    }

    // 7. session-log-deepseek/delivery-accepted: throughSeq
    if (ev.type === 'session-log-deepseek/delivery-accepted' && ev.data && typeof ev.data.throughSeq === 'number') {
      const mappedThrough = mapSeq(ev.data.throughSeq);
      if (typeof mappedThrough === 'number') {
        ev.data = {
          ...ev.data,
          throughSeq: mappedThrough,
        };
      }
    }

    // 8. image/offload: targets: [{ seq }]
    if (ev.type === 'image/offload' && ev.data && Array.isArray(ev.data.targets)) {
      ev.data = {
        ...ev.data,
        targets: ev.data.targets.map((t: any) => {
          if (t && typeof t === 'object' && typeof t.seq === 'number') {
            const mapped = mapSeq(t.seq);
            return typeof mapped === 'number' ? { ...t, seq: mapped } : t;
          }
          return t;
        }),
      };
    }

    // 9. Generic remap for any other *Seq or *Seqs member on ev.data
    const EXPLICIT_DATA_KEYS = new Set([
      'headerSeq',
      'sourceEventSeq',
      'throughSeq',
      'messageSeqs',
      'shadowedSeqs',
      'shadowedRange',
      'targets',
    ]);
    if (ev.data && typeof ev.data === 'object') {
      let modifiedData: any = null;
      for (const [key, val] of Object.entries(ev.data)) {
        if (key === 'seq' || EXPLICIT_DATA_KEYS.has(key)) continue;
        if (key.endsWith('Seq') && typeof val === 'number') {
          const mapped = mapSeq(val);
          if (typeof mapped === 'number' && mapped !== val) {
            modifiedData = modifiedData ?? { ...ev.data };
            modifiedData[key] = mapped;
          }
        } else if (key.endsWith('Seqs') && Array.isArray(val)) {
          let listChanged = false;
          const mappedList = val.map((s: any) => {
            if (typeof s === 'number') {
              const m = mapSeq(s);
              if (typeof m === 'number' && m !== s) {
                listChanged = true;
                return m;
              }
            }
            return s;
          });
          if (listChanged) {
            modifiedData = modifiedData ?? { ...ev.data };
            modifiedData[key] = mappedList;
          }
        }
      }
      if (modifiedData) {
        ev.data = modifiedData;
      }
    }
  }
}

export const remapSeedEventSequences = remapEventSequences;

/**
 * Defers pre-step surface events (user/message, assistant/message, tool/result, surfaceOp)
 * that appear before the first step/start into that first step.
 *
 * Never touches non-event records (chunk lines) and never renumbers/injects seq unless
 * pre-step surface events were present and required deferral.
 *
 * Resequences minimally (only shifting numbers where needed) and remaps all sequence
 * references across the session using the shared `remapEventSequences` helper.
 */
export function deferPreStepSurfaceEvents<T extends { type: string; seq?: number }>(events: readonly T[]): T[] {
  const rows: T[] = [];
  let stepStartFound = false;
  const deferredSurface: T[] = [];
  let hasPreStepSurface = false;

  for (let i = 0; i < events.length; i++) {
    const ev = structuredClone(events[i]) as T;
    if (!stepStartFound) {
      if (ev.type === 'turn/start') {
        rows.push(ev);
      } else if (ev.type === 'step/start') {
        rows.push(ev);
        stepStartFound = true;
        for (const def of deferredSurface) rows.push(def);
        deferredSurface.length = 0;
      } else if (
        (ev as any).surfaceOp ||
        ev.type === 'user/message' ||
        ev.type === 'assistant/message' ||
        ev.type === 'tool/result' ||
        ev.type === 'system/message'
      ) {
        hasPreStepSurface = true;
        deferredSurface.push(ev);
      } else {
        rows.push(ev);
      }
    } else {
      rows.push(ev);
    }
  }
  if (!stepStartFound && deferredSurface.length > 0) {
    for (const def of deferredSurface) rows.push(def);
    deferredSurface.length = 0;
  }

  // If no pre-step surface events were deferred, do not touch or renumber events
  if (!hasPreStepSurface) {
    return structuredClone(events) as T[];
  }

  // Minimal resequencing: only shift sequence numbers when needed to maintain dense order
  const oldSeqToNewSeq = new Map<number, number>();
  let currentSeq = 0;
  for (const row of rows) {
    if (isChunkRecord(row)) {
      const data = (row as any).data;
      const count = Array.isArray(data?.args)
        ? data.args.length
        : Array.isArray(data?.texts)
          ? data.texts.length
          : 1;
      const oldSeq0 = (row as any).seq0;
      if (typeof oldSeq0 === 'number') {
        for (let c = 0; c < count; c++) {
          oldSeqToNewSeq.set(oldSeq0 + c, currentSeq + c);
        }
        if (oldSeq0 !== currentSeq) {
          (row as any).seq0 = currentSeq;
        }
      }
      currentSeq += count;
    } else {
      const oldSeq = (row as any).seq;
      if (typeof oldSeq === 'number') {
        oldSeqToNewSeq.set(oldSeq, currentSeq);
        if (oldSeq !== currentSeq) {
          (row as any).seq = currentSeq;
        }
      } else {
        (row as any).seq = currentSeq;
      }
      currentSeq += 1;
    }
  }

  const hasSeqChanges = Array.from(oldSeqToNewSeq.entries()).some(([oldS, newS]) => oldS !== newS);
  if (hasSeqChanges) {
    remapEventSequences(rows, oldSeqToNewSeq);
  }

  return rows;
}

/**
 * Strips legacy `data.source.sourceId` from a `user/message` event if present (Class A normalization).
 */
export function stripV0SourceId<T extends { type: string }>(event: T): T {
  if (
    event.type === 'user/message' &&
    (event as any).data?.source &&
    typeof (event as any).data.source === 'object'
  ) {
    if ('sourceId' in (event as any).data.source) {
      delete (event as any).data.source.sourceId;
    }
  }
  return event;
}

/**
 * Applies full in-memory normalization to a stream of v0 session events:
 * 1. Strips `data.source.sourceId` from `user/message`.
 * 2. Defers pre-step surface events into the first step.
 */
export function normalizeV0Events<T extends { type: string; seq?: number }>(events: readonly T[]): T[] {
  const stripped = events.map((ev) => stripV0SourceId(structuredClone(ev)));
  return deferPreStepSurfaceEvents(stripped);
}

/**
 * Determines whether an error corresponds to DSH SessionFormatUnsupportedError.
 */
export function isSessionFormatUnsupportedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const anyErr = err as any;
  if (anyErr.name === 'SessionFormatUnsupportedError') return true;
  if (anyErr.constructor?.name === 'SessionFormatUnsupportedError') return true;
  if (anyErr.name === 'SessionFormatUnsupportedMigrationError') return true;
  if (anyErr.constructor?.name === 'SessionFormatUnsupportedMigrationError') return true;
  const msg = typeof anyErr.message === 'string' ? anyErr.message : '';
  if (
    msg.includes('SessionFormatUnsupportedError') ||
    msg.includes('SessionFormatUnsupportedMigrationError') ||
    msg.includes('refuses this format v') ||
    msg.includes('cannot acquire a system head') ||
    msg.includes('pre-step surface') ||
    msg.includes('unexpected member "sourceId"')
  ) {
    return true;
  }
  return false;
}

/**
 * Determines whether an error corresponds to Class A (unexpected member "sourceId" in user/message source).
 */
export function isClassAError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('unexpected member "sourceId"') ||
    msg.includes("unexpected member 'sourceId'")
  );
}

/**
 * Determines whether an error corresponds to Class B (pre-step surface rejection).
 */
export function isClassBError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('cannot acquire a system head') ||
    msg.includes('surface before first step') ||
    msg.includes('pre-step surface')
  );
}

export interface PremigrateSessionOptions {
  sessionsRoot?: string;
  dryRun?: boolean;
  persistenceInstance?: any;
}

export interface PremigrateSessionResult {
  sessionId: string;
  sessionDir: string;
  status: 'migrated' | 'skipped' | 'failed';
  originalEventCount?: number;
  migratedEventCount?: number;
  userMessageCount?: number;
  assistantMessageCount?: number;
  removedSourceIdsCount?: number;
  deferredSurfaceCount?: number;
  reason?: string;
  error?: string;
}

/**
 * Pre-migrates a single session directory.
 */
export async function premigrateSingleSession(
  sessionDir: string,
  options: PremigrateSessionOptions = {}
): Promise<PremigrateSessionResult> {
  const dryRun = options.dryRun ?? false;
  const canonicalV4Path = path.join(sessionDir, 'session.v4.jsonl');
  const compressedV4Path = path.join(sessionDir, 'session.v4.jsonl.zstd');

  // Idempotency check: Skip sessions already having a v4 generation
  if (fs.existsSync(canonicalV4Path) || fs.existsSync(compressedV4Path)) {
    return {
      sessionId: path.basename(sessionDir),
      sessionDir,
      status: 'skipped',
      reason: 'v4 generation already exists',
    };
  }

  const v0Path = path.join(sessionDir, 'session.jsonl');
  if (!fs.existsSync(v0Path)) {
    return {
      sessionId: path.basename(sessionDir),
      sessionDir,
      status: 'skipped',
      reason: 'no session.jsonl found',
    };
  }

  const rawContent = await fs.promises.readFile(v0Path, 'utf8');
  const lines = rawContent.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return {
      sessionId: path.basename(sessionDir),
      sessionDir,
      status: 'failed',
      error: 'Empty session.jsonl',
    };
  }

  let rawHeader: any;
  try {
    rawHeader = JSON.parse(lines[0]);
  } catch (parseErr) {
    return {
      sessionId: path.basename(sessionDir),
      sessionDir,
      status: 'failed',
      error: `Failed to parse header in session.jsonl: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
    };
  }

  if (rawHeader.type !== 'session' || rawHeader.version !== 0) {
    return {
      sessionId: rawHeader.id ?? path.basename(sessionDir),
      sessionDir,
      status: 'skipped',
      reason: `Not a version 0 session (type=${rawHeader.type}, version=${rawHeader.version})`,
    };
  }

  const sessionId = String(rawHeader.id);
  const rawEvents: any[] = [];
  for (let i = 1; i < lines.length; i++) {
    try {
      rawEvents.push(JSON.parse(lines[i]));
    } catch (evErr) {
      return {
        sessionId,
        sessionDir,
        status: 'failed',
        error: `Failed to parse event row ${i} in session.jsonl: ${evErr instanceof Error ? evErr.message : String(evErr)}`,
      };
    }
  }

  // Count original user and assistant messages for verification
  const originalUserMessages = rawEvents.filter((e) => e.type === 'user/message').length;
  const originalAssistantMessages = rawEvents.filter((e) => e.type === 'assistant/message').length;

  // Migrate through DSH 0.2 session-format catalog
  const catalog = createSessionFormatCatalogWithChildren([]);
  const sourceHeader: Record<string, unknown> = {
    type: 'session',
    version: 0,
    id: sessionId,
    createdAt: rawHeader.createdAt,
    delegationDepth: rawHeader.delegationDepth ?? 0,
    ...(rawHeader.seedLength !== undefined ? { seedLength: rawHeader.seedLength } : {}),
    ...(rawHeader.cwd !== undefined ? { cwd: rawHeader.cwd } : {}),
    ...(rawHeader.parentSession !== undefined ? { parentSession: rawHeader.parentSession } : {}),
    ...(rawHeader.origin !== undefined ? { origin: rawHeader.origin } : {}),
    ...(rawHeader.agentPreset !== undefined ? { agentPreset: rawHeader.agentPreset } : {}),
  };

  // New behavior per dryrun2 RCA:
  // For each session, FIRST attempt the standard DSH 0.2 migration on the ORIGINAL v0 content unchanged.
  // Only if it fails with SessionFormatUnsupportedError, apply ONLY the normalization matching the error:
  // (A) 'source has unexpected member "sourceId"' -> remove data.source.sourceId on user/message events;
  // (B) pre-step surface rejection -> defer only offending pre-step surface events into the first step;
  //     never touch non-event records (chunk lines) and never renumber/inject seq unless DSH rules require it;
  // Allow A then B sequentially if both apply (max 2 normalization passes).
  let currentEvents = structuredClone(rawEvents);
  let removedSourceIdsCount = 0;
  let deferredSurfaceCount = 0;
  let appliedA = false;
  let appliedB = false;

  let artifact: ReturnType<ReturnType<typeof catalog.createRestore>['finish']> | undefined;
  let lastError: unknown;

  for (let pass = 0; pass <= 2; pass++) {
    try {
      const restore = catalog.createRestore(sourceHeader, {
        recovery: 'recoverable',
        validation: 'current',
      });
      for (const row of currentEvents) {
        restore.decodeRow(row);
      }
      artifact = restore.finish();
      lastError = undefined;
      break;
    } catch (migErr) {
      lastError = migErr;
      if (!isSessionFormatUnsupportedError(migErr)) {
        break;
      }
      if (isClassAError(migErr) && !appliedA) {
        appliedA = true;
        let stripped = 0;
        for (const ev of currentEvents) {
          if (ev.type === 'user/message' && ev.data?.source && typeof ev.data.source === 'object') {
            if ('sourceId' in ev.data.source) {
              delete ev.data.source.sourceId;
              stripped++;
            }
          }
        }
        removedSourceIdsCount += stripped;
        continue;
      }
      if (isClassBError(migErr) && !appliedB) {
        appliedB = true;
        let countBeforeStep = 0;
        let firstStepSeen = false;
        for (const ev of currentEvents) {
          if (!firstStepSeen) {
            if (ev.type === 'step/start') {
              firstStepSeen = true;
            } else if (
              ev.surfaceOp ||
              ev.type === 'user/message' ||
              ev.type === 'assistant/message' ||
              ev.type === 'tool/result' ||
              ev.type === 'system/message'
            ) {
              countBeforeStep++;
            }
          }
        }
        deferredSurfaceCount += countBeforeStep;
        currentEvents = deferPreStepSurfaceEvents(currentEvents);
        continue;
      }
      break;
    }
  }

  if (!artifact) {
    return {
      sessionId,
      sessionDir,
      status: 'failed',
      error: `Format catalog migration failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    };
  }

  // Check logical migrated message counts
  const migratedUserMessages = artifact.events.filter((e) => e.type === 'user/message').length;
  const migratedAssistantMessages = artifact.events.filter((e) => e.type === 'assistant/message').length;
  if (
    migratedUserMessages !== originalUserMessages ||
    migratedAssistantMessages !== originalAssistantMessages
  ) {
    return {
      sessionId,
      sessionDir,
      status: 'failed',
      error: `Message count mismatch in migrated artifact: user expected=${originalUserMessages} got=${migratedUserMessages}, assistant expected=${originalAssistantMessages} got=${migratedAssistantMessages}`,
    };
  }

  if (dryRun) {
    return {
      sessionId,
      sessionDir,
      status: 'migrated',
      originalEventCount: rawEvents.length,
      migratedEventCount: artifact.events.length,
      userMessageCount: originalUserMessages,
      assistantMessageCount: originalAssistantMessages,
      removedSourceIdsCount,
      deferredSurfaceCount,
      reason: 'dry-run successful (no writes)',
    };
  }

  // Atomic publish to session.v4.jsonl with 0o600 permissions
  const targetPath = canonicalV4Path;
  const tempPath = path.join(
    sessionDir,
    `.session.v4.jsonl.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`
  );

  let fileHandle: fs.promises.FileHandle | undefined;
  try {
    fileHandle = await fs.promises.open(tempPath, 'wx', 0o600);
    const headerLine = JSON.stringify(
      catalog.encodeCurrentHeader(artifact.header, artifact.inheritedEventCount)
    );
    await fileHandle.writeFile(headerLine + '\n', 'utf8');
    for (const ev of artifact.events) {
      const evLine = JSON.stringify(catalog.encodeCurrentEvent(ev));
      await fileHandle.writeFile(evLine + '\n', 'utf8');
    }
    await fileHandle.sync();
  } catch (writeErr) {
    if (fileHandle) {
      await fileHandle.close().catch(() => {});
    }
    await fs.promises.unlink(tempPath).catch(() => {});
    return {
      sessionId,
      sessionDir,
      status: 'failed',
      error: `Failed to write staged migration file: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
    };
  } finally {
    if (fileHandle) {
      await fileHandle.close().catch(() => {});
    }
  }

  try {
    try {
      await fs.promises.link(tempPath, targetPath);
      await fs.promises.unlink(tempPath);
    } catch (linkErr: any) {
      if (linkErr?.code === 'EEXIST') {
        await fs.promises.unlink(tempPath).catch(() => {});
        throw new Error(`Target file already exists: ${targetPath}`);
      }
      await fs.promises.rename(tempPath, targetPath);
    }
    await fs.promises.chmod(targetPath, 0o600).catch(() => {});
    try {
      const dirH = await fs.promises.open(sessionDir, 'r');
      await dirH.sync();
      await dirH.close();
    } catch {}
  } catch (publishErr) {
    await fs.promises.unlink(tempPath).catch(() => {});
    return {
      sessionId,
      sessionDir,
      status: 'failed',
      error: `Failed to atomically publish target file: ${publishErr instanceof Error ? publishErr.message : String(publishErr)}`,
    };
  }

  // Verification: Open with DSH 0.2 JSONL persistence (read) and compare message counts
  try {
    const sessionsRoot = resolveSessionsRootForDir(sessionDir, options.sessionsRoot);
    let persistence = options.persistenceInstance;
    let localCtx: Context | undefined;
    if (!persistence) {
      localCtx = new Context();
      await localCtx.plugin(SessionPersistenceJsonl, {
        root: sessionsRoot,
        compression: 'none',
      });
      persistence = localCtx.sessionPersistence;
    }

    const handle = await persistence.open(sessionId, 'read');
    let verifiedEvents: readonly any[] = [];
    try {
      const readResult = await handle.read();
      verifiedEvents = readResult.events;
    } finally {
      await handle.close();
    }

    const verifiedUserCount = verifiedEvents.filter((e) => e.type === 'user/message').length;
    const verifiedAssistantCount = verifiedEvents.filter((e) => e.type === 'assistant/message').length;

    if (
      verifiedUserCount !== originalUserMessages ||
      verifiedAssistantCount !== originalAssistantMessages
    ) {
      throw new Error(
        `Persistence read verification count mismatch: expected user=${originalUserMessages}, assistant=${originalAssistantMessages}; read user=${verifiedUserCount}, assistant=${verifiedAssistantCount}`
      );
    }
  } catch (verErr) {
    // Leave no partial or corrupt file on disk
    await fs.promises.unlink(targetPath).catch(() => {});
    return {
      sessionId,
      sessionDir,
      status: 'failed',
      error: `Persistence verification failed: ${verErr instanceof Error ? verErr.message : String(verErr)}`,
    };
  }

  return {
    sessionId,
    sessionDir,
    status: 'migrated',
    originalEventCount: rawEvents.length,
    migratedEventCount: artifact.events.length,
    userMessageCount: originalUserMessages,
    assistantMessageCount: originalAssistantMessages,
    removedSourceIdsCount,
    deferredSurfaceCount,
  };
}

/**
 * Incurs or validates the root sessions directory for a given session directory.
 */
function resolveSessionsRootForDir(sessionDir: string, explicitRoot?: string): string {
  if (explicitRoot && explicitRoot.trim().length > 0) {
    return explicitRoot;
  }
  const parent = path.dirname(sessionDir);
  const parentBase = path.basename(parent);
  if (parentBase.startsWith('--') || parentBase === '_no-cwd') {
    return path.dirname(parent);
  }
  return parent;
}

/**
 * Finds all session directories beneath a root directory.
 */
export function findSessionDirectories(dir: string, maxDepth = 4): string[] {
  if (!fs.existsSync(dir)) return [];
  if (fs.existsSync(path.join(dir, 'session.jsonl')) || fs.existsSync(path.join(dir, 'session.v4.jsonl'))) {
    return [dir];
  }
  if (maxDepth <= 0) return [];
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        results.push(...findSessionDirectories(path.join(dir, entry.name), maxDepth - 1));
      }
    }
  } catch {
    // Ignore unreadable entries
  }
  return results;
}

export interface RunSessionPremigrateOptions {
  sessionsRoot: string;
  dryRun?: boolean;
  sessionIds?: string[];
  reportFile?: string;
  logger?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
}

export interface RunSessionPremigrateResult {
  sessionsRoot: string;
  dryRun: boolean;
  totalScanned: number;
  migratedCount: number;
  skippedCount: number;
  failedCount: number;
  sessions: PremigrateSessionResult[];
}

/**
 * Runs the pre-migration tool across a DSH sessions root.
 */
export async function runSessionPremigrate(
  options: RunSessionPremigrateOptions
): Promise<RunSessionPremigrateResult> {
  const { sessionsRoot, dryRun = false, sessionIds, reportFile, logger } = options;

  if (!sessionsRoot || typeof sessionsRoot !== 'string' || sessionsRoot.trim().length === 0) {
    throw new Error('Missing required option: sessionsRoot');
  }

  if (!fs.existsSync(sessionsRoot)) {
    throw new Error(`Sessions root directory does not exist: ${sessionsRoot}`);
  }

  const allSessionDirs = findSessionDirectories(sessionsRoot);
  const targetIdSet = sessionIds && sessionIds.length > 0 ? new Set(sessionIds) : undefined;

  let persistenceInstance: any;
  if (!dryRun) {
    try {
      const ctx = new Context();
      await ctx.plugin(SessionPersistenceJsonl, {
        root: sessionsRoot,
        compression: 'none',
      });
      persistenceInstance = ctx.sessionPersistence;
    } catch (pErr) {
      logger?.warn?.(`Warning: Failed to pre-warm SessionPersistence: ${String(pErr)}`);
    }
  }

  const sessionResults: PremigrateSessionResult[] = [];
  let migratedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const sDir of allSessionDirs) {
    // If targeted session IDs are specified, filter by session ID
    if (targetIdSet) {
      const dirBase = path.basename(sDir);
      let matched = targetIdSet.has(dirBase);
      if (!matched) {
        // Read header from session.jsonl or session.v4.jsonl to verify
        const checkPaths = [path.join(sDir, 'session.jsonl'), path.join(sDir, 'session.v4.jsonl')];
        for (const cp of checkPaths) {
          if (fs.existsSync(cp)) {
            try {
              const firstLine = fs.readFileSync(cp, 'utf8').split('\n')[0];
              const parsed = JSON.parse(firstLine);
              if (parsed.id && targetIdSet.has(parsed.id)) {
                matched = true;
                break;
              }
            } catch {}
          }
        }
      }
      if (!matched) {
        continue;
      }
    }

    const res = await premigrateSingleSession(sDir, {
      sessionsRoot,
      dryRun,
      persistenceInstance,
    });

    sessionResults.push(res);
    if (res.status === 'migrated') migratedCount++;
    else if (res.status === 'skipped') skippedCount++;
    else if (res.status === 'failed') failedCount++;
  }

  const summary: RunSessionPremigrateResult = {
    sessionsRoot,
    dryRun,
    totalScanned: sessionResults.length,
    migratedCount,
    skippedCount,
    failedCount,
    sessions: sessionResults,
  };

  if (reportFile) {
    const reportData = {
      timestamp: new Date().toISOString(),
      ...summary,
    };
    await fs.promises.mkdir(path.dirname(reportFile), { recursive: true });
    await fs.promises.writeFile(reportFile, JSON.stringify(reportData, null, 2), 'utf8');
  }

  return summary;
}

/**
 * CLI parser and runner for `enkeep-session-premigrate`.
 */
export async function runSessionPremigrateCli(argv: string[]): Promise<void> {
  let sessionsRoot = '';
  let dryRun = false;
  const sessionIds: string[] = [];
  let reportFile: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--sessions-root') {
      sessionsRoot = argv[++i] ?? '';
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--session') {
      const sid = argv[++i];
      if (sid) sessionIds.push(sid);
    } else if (arg === '--report') {
      reportFile = argv[++i];
    } else if (arg === '-h' || arg === '--help') {
      process.stdout.write(
        'Usage: enkeep-session-premigrate --sessions-root <dir> [--dry-run] [--session <id>] [--report <file>]\n'
      );
      process.exit(0);
    }
  }

  if (!sessionsRoot) {
    process.stderr.write('Error: Missing required flag: --sessions-root <dir>\n');
    process.exit(1);
  }

  try {
    const result = await runSessionPremigrate({
      sessionsRoot,
      dryRun,
      sessionIds: sessionIds.length > 0 ? sessionIds : undefined,
      reportFile,
      logger: {
        info: (msg) => process.stdout.write(`${msg}\n`),
        warn: (msg) => process.stderr.write(`${msg}\n`),
        error: (msg) => process.stderr.write(`${msg}\n`),
      },
    });

    process.stdout.write(
      `Pre-migration finished: ${result.totalScanned} scanned, ${result.migratedCount} migrated, ${result.skippedCount} skipped, ${result.failedCount} failed (dryRun=${result.dryRun}).\n`
    );

    if (result.failedCount > 0) {
      for (const s of result.sessions.filter((s) => s.status === 'failed')) {
        process.stderr.write(`Failed session [${s.sessionId}]: ${s.error}\n`);
      }
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(`Pre-migration failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
