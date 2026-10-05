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
 * Defers pre-step surface events (user/message, assistant/message, tool/result, surfaceOp)
 * that appear before the first step/start into that first step.
 *
 * Never touches non-event records (chunk lines) and never renumbers/injects seq unless
 * pre-step surface events were present and required deferral.
 *
 * Reusable helper extracted from `importSeed` in `dsh-boot.ts`.
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

  // Renumber sequence numbers only on event records; never inject seq into chunk lines
  let currentSeq = 0;
  for (const row of rows) {
    if (isChunkRecord(row)) {
      const data = (row as any).data;
      const count = Array.isArray(data?.args)
        ? data.args.length
        : Array.isArray(data?.texts)
          ? data.texts.length
          : 1;
      currentSeq += count;
    } else {
      (row as any).seq = currentSeq;
      currentSeq += 1;
    }
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
