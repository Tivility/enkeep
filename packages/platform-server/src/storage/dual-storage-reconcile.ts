import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  PlatformError,
  NotFoundError,
  ValidationError,
  type ExecutionMode,
} from '@enkeep/platform-core';
import {
  parseDshSessionJsonl,
  readAndParseDshSessionFile,
  computeCanonicalMessagesHash,
  computeSha256,
  generateDeterministicMessageId,
  type DshSessionEvent,
  type DshSessionHeader,
  type ProjectedWebMessage,
  type ParsedDshSession,
} from './session-event-parser.js';

export type ReconciliationStatus =
  | 'matched'
  | 'drift'
  | 'missing'
  | 'uninitialized'
  | 'unavailable'
  | 'parse_error'
  | 'merged_archive';

export type DshReadStatus =
  | 'FOUND'
  | 'MISSING'
  | 'UNAVAILABLE'
  | 'PARSE_ERROR';

export type DiscrepancyType =
  | 'missingInSqlite'
  | 'orphanInSqlite'
  | 'contentMismatch'
  | 'roleMismatch';

export interface ReconciliationDiscrepancy {
  readonly type: DiscrepancyType;
  readonly position: number;
  readonly sourceSeq?: number;
  readonly dshMessageId?: string;
  readonly sqliteMessageId?: string;
  readonly dshRole?: string;
  readonly sqliteRole?: string;
  readonly dshContent?: string;
  readonly sqliteContent?: string;
}

export interface SessionReconciliationReport {
  readonly userId: string;
  readonly sessionId: string;
  readonly dshSessionId?: string;
  readonly canonicalSessionId?: string;
  readonly spaceId?: string;
  readonly status: ReconciliationStatus;
  readonly dshReadStatus?: DshReadStatus;
  readonly platformMessageCount: number;
  readonly dshMessageCount: number;
  readonly platformHash: string;
  readonly dshHash: string;
  readonly checkedAt: string;
  readonly discrepancies?: ReconciliationDiscrepancy[];
  readonly details?: Record<string, unknown>;
  readonly isArchived?: boolean;
  readonly isCanonical?: boolean;
  readonly executionMode?: ExecutionMode;
  readonly generationNumber?: number;
}

export interface ReconcileAllReport {
  readonly userId: string;
  readonly totalSessions: number;
  readonly matchedCount: number;
  readonly driftCount: number;
  readonly missingCount: number;
  readonly uninitializedCount?: number;
  readonly unavailableCount?: number;
  readonly parseErrorCount?: number;
  readonly archivedCount?: number;
  readonly activeCount?: number;
  readonly mergedArchiveCount?: number;
  readonly reports: SessionReconciliationReport[];
  readonly generatedAt: string;
}

export interface ReconcileAllOptions {
  readonly dshSessionsDir?: string;
  readonly filterStatus?: 'active' | 'archived' | 'all';
}

export interface RepairSessionOptions {
  readonly dryRun?: boolean;
  readonly deleteOrphans?: boolean;
  readonly expectedSnapshotHash?: string;
  readonly expectedGeneration?: number;
}

export interface RepairSessionResult {
  readonly userId: string;
  readonly sessionId: string;
  readonly status: 'repaired' | 'unchanged';
  readonly repairedCount: number;
  readonly updatedCount?: number;
  readonly deletedOrphansCount?: number;
  readonly unresolvedCount?: number;
  readonly unresolvedDiscrepancies?: ReconciliationDiscrepancy[];
  readonly dryRun: boolean;
  readonly repairedAt: string;
  readonly discrepancies?: ReconciliationDiscrepancy[];
  readonly details?: Record<string, unknown>;
}

export interface DshSessionReadResult {
  readonly status: DshReadStatus;
  readonly isEmpty: boolean;
  readonly messageCount: number;
  readonly canonicalHash: string;
  readonly parsedSession?: ParsedDshSession;
  readonly error?: string;
  readonly resolvedPath?: string;
  readonly executionMode?: ExecutionMode;
  readonly rawSha256?: string;
}

export interface SessionLogReaderContext {
  readonly userId: string;
  readonly routeId: string;
  readonly dshSessionId: string;
  readonly executionMode: ExecutionMode;
  readonly spaceFolder: string;
  readonly candidatePaths: readonly string[];
}

export type SessionLogReader = (
  context: SessionLogReaderContext
) => Promise<DshSessionReadResult | null>;

export interface DualStorageReconcileOptions {
  readonly db: DatabaseSync;
  readonly dshHome?: string;
  readonly sessionLogReader?: SessionLogReader;
  readonly runtimeArtifactPort?: any;
  readonly fileProvider?: any;
  readonly maxStreamCapBytes?: number;
}

interface SqliteWebMessageRow {
  id: string;
  session_id: string;
  user_id: string;
  role: string;
  content: string;
  status: string;
  route_key: string;
  turn_id: string | null;
  created_at: string;
}

interface RouteAndSpaceRow {
  id: string;
  space_id: string;
  user_id: string;
  channel: string;
  peer_id?: string;
  native_context_id?: string;
  dsh_session_id: string;
  route_status: string;
  current_generation: number;
  route_execution_mode: string;
  space_folder: string | null;
  space_execution_mode: string | null;
  space_status: string | null;
  canonical_session_id: string | null;
}

/**
 * Derives canonical project directory key according to official DSH persistence rules.
 */
export function computeDshProjectKey(cwd: string): string {
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
  const slug = readable.replace(/^-+/, '') || 'root';
  return `--${slug.slice(0, 251)}--`;
}

/**
 * Derives canonical path segment encoding for session directory.
 */
export function encodeSessionSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch;
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
    }
  }
  return out;
}

/**
 * Dual Storage Reconciliation & Repair Service
 *
 * Implements read-only reconciliation reports and safe idempotent repair between
 * Platform SQLite web_messages and DSH Runtime JSONL event streams.
 *
 * Invariants:
 * - Read-only report strictly does NOT mutate SQLite or files.
 * - Repair command is explicit, admin-authenticated, transactional, and additive-only.
 * - Destructive deletion of orphans is unconditionally rejected in this feature.
 * - DSH JSONL is runtime authority for conversation history, but platform deliveries are preserved.
 * - Runtime selection uses authoritative Space/generation resolver, not stale route.execution_mode.
 * - Concurrency guard: detects snapshot file changes during repair and raises 409 CONFLICT.
 * - Audit logs recorded with fixed actions with zero path leaks.
 */
export class DualStorageReconcileService {
  private readonly db: DatabaseSync;
  private readonly dshHome: string;
  private readonly sessionLogReader?: SessionLogReader;
  private readonly runtimeArtifactPort?: any;
  private readonly fileProvider?: any;
  private readonly maxStreamCapBytes: number;

  constructor(options: DualStorageReconcileOptions) {
    if (!options || !options.db) {
      throw new ValidationError('DatabaseSync db instance is required');
    }
    this.db = options.db;
    this.dshHome = options.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    this.sessionLogReader = options.sessionLogReader;
    this.runtimeArtifactPort = options.runtimeArtifactPort;
    this.fileProvider = options.fileProvider;
    this.maxStreamCapBytes = options.maxStreamCapBytes ?? (32 * 1024 * 1024); // 32 MiB bounded streaming cap
  }

  /**
   * Compares SQLite web_messages with DSH projected messages to detect exact discrepancies.
   */
  public detectDiscrepancies(
    sqliteMessages: readonly SqliteWebMessageRow[],
    dshMessages: readonly ProjectedWebMessage[]
  ): ReconciliationDiscrepancy[] {
    const discrepancies: ReconciliationDiscrepancy[] = [];
    const maxLen = Math.max(sqliteMessages.length, dshMessages.length);

    for (let i = 0; i < maxLen; i++) {
      const dshMsg = dshMessages[i];
      const sqlMsg = sqliteMessages[i];

      if (dshMsg && !sqlMsg) {
        discrepancies.push({
          type: 'missingInSqlite',
          position: i,
          sourceSeq: dshMsg.sourceSeq,
          dshMessageId: dshMsg.id,
          dshRole: dshMsg.role,
          dshContent: dshMsg.content,
        });
      } else if (!dshMsg && sqlMsg) {
        discrepancies.push({
          type: 'orphanInSqlite',
          position: i,
          sqliteMessageId: sqlMsg.id,
          sqliteRole: sqlMsg.role,
          sqliteContent: sqlMsg.content,
        });
      } else if (dshMsg && sqlMsg) {
        if (dshMsg.role !== sqlMsg.role) {
          discrepancies.push({
            type: 'roleMismatch',
            position: i,
            sourceSeq: dshMsg.sourceSeq,
            dshMessageId: dshMsg.id,
            sqliteMessageId: sqlMsg.id,
            dshRole: dshMsg.role,
            sqliteRole: sqlMsg.role,
            dshContent: dshMsg.content,
            sqliteContent: sqlMsg.content,
          });
        } else if (dshMsg.content !== sqlMsg.content) {
          discrepancies.push({
            type: 'contentMismatch',
            position: i,
            sourceSeq: dshMsg.sourceSeq,
            dshMessageId: dshMsg.id,
            sqliteMessageId: sqlMsg.id,
            dshRole: dshMsg.role,
            sqliteRole: sqlMsg.role,
            dshContent: dshMsg.content,
            sqliteContent: sqlMsg.content,
          });
        }
      }
    }

    return discrepancies;
  }

  /**
   * Reads a session log file safely using bounded stream/buffer reading up to configured cap.
   * Never silently catches to [] or 0 messages.
   */
  public async readSessionLogFromDisk(
    filePath: string,
    sessionId: string
  ): Promise<DshSessionReadResult> {
    try {
      if (!fs.existsSync(filePath)) {
        return {
          status: 'MISSING',
          isEmpty: true,
          messageCount: 0,
          canonicalHash: computeCanonicalMessagesHash([]),
        };
      }

      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        return {
          status: 'PARSE_ERROR',
          isEmpty: true,
          messageCount: 0,
          canonicalHash: computeCanonicalMessagesHash([]),
          error: 'Session log path is not a regular file',
        };
      }

      if (stat.size === 0) {
        return {
          status: 'FOUND',
          isEmpty: true,
          messageCount: 0,
          canonicalHash: computeCanonicalMessagesHash([]),
          rawSha256: computeSha256(Buffer.alloc(0)),
          resolvedPath: path.basename(filePath),
        };
      }

      if (stat.size > this.maxStreamCapBytes) {
        return {
          status: 'PARSE_ERROR',
          isEmpty: false,
          messageCount: 0,
          canonicalHash: computeCanonicalMessagesHash([]),
          error: `Session file size (${stat.size} bytes) exceeds bounded stream cap (${this.maxStreamCapBytes} bytes)`,
        };
      }

      const parsed = await readAndParseDshSessionFile(filePath, { sessionId });
      return {
        status: 'FOUND',
        isEmpty: parsed.projectedMessages.length === 0,
        messageCount: parsed.projectedMessages.length,
        canonicalHash: parsed.canonicalHash,
        parsedSession: parsed,
        resolvedPath: path.basename(filePath),
        rawSha256: parsed.fileSnapshot.rawSha256,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: 'PARSE_ERROR',
        isEmpty: true,
        messageCount: 0,
        canonicalHash: computeCanonicalMessagesHash([]),
        error: msg,
      };
    }
  }

  /**
   * Resolves authoritative Space execution mode, generation, and session IDs for a route.
   */
  private resolveRouteAndSpace(userId: string, sessionId: string): {
    route: RouteAndSpaceRow | null;
    dshSessionId: string;
    routeId: string;
    authoritativeMode: ExecutionMode;
    spaceFolder: string;
    isArchived: boolean;
    isCanonical: boolean;
    currentGeneration: number;
    canonicalSessionId?: string | null;
  } {
    const route = this.db.prepare(`
      SELECT 
        sr.*,
        sr.status as route_status,
        sr.current_generation,
        sr.execution_mode as route_execution_mode,
        s.folder as space_folder,
        s.execution_mode as space_execution_mode,
        s.status as space_status,
        s.canonical_session_id
      FROM session_routes sr
      LEFT JOIN spaces s ON sr.space_id = s.id AND sr.user_id = s.user_id
      WHERE sr.user_id = ? AND (sr.id = ? OR sr.dsh_session_id = ?)
      LIMIT 1
    `).get(userId, sessionId, sessionId) as RouteAndSpaceRow | undefined;

    if (route) {
      // Check generation consistency in session_generations
      let effectiveDshId = route.dsh_session_id;
      let genNum = route.current_generation ?? 1;

      try {
        const latestGen = this.db.prepare(`
          SELECT dsh_session_id, generation_number
          FROM session_generations
          WHERE route_id = ? AND user_id = ?
          ORDER BY generation_number DESC LIMIT 1
        `).get(route.id, userId) as { dsh_session_id: string; generation_number: number } | undefined;

        if (latestGen && latestGen.dsh_session_id) {
          effectiveDshId = latestGen.dsh_session_id;
          genNum = latestGen.generation_number;
        }
      } catch {}

      // Authoritative space execution mode takes strict precedence over route.execution_mode
      const authoritativeMode = (route.space_execution_mode || route.route_execution_mode || 'container') as ExecutionMode;
      const spaceFolder = route.space_folder || 'default';
      const isArchived = route.route_status === 'archived' || route.space_status === 'archived';
      const isCanonical = !route.canonical_session_id || route.canonical_session_id === route.id;

      return {
        route,
        dshSessionId: effectiveDshId,
        routeId: route.id,
        authoritativeMode,
        spaceFolder,
        isArchived,
        isCanonical,
        currentGeneration: genNum,
        canonicalSessionId: route.canonical_session_id,
      };
    }

    // Fallback: route not found in session_routes, derive minimal context
    return {
      route: null,
      dshSessionId: sessionId,
      routeId: sessionId,
      authoritativeMode: 'host',
      spaceFolder: 'default',
      isArchived: false,
      isCanonical: true,
      currentGeneration: 1,
      canonicalSessionId: null,
    };
  }

  /**
   * Internal reader backed by runtime provider, official project key, and space resolution.
   */
  private async readSessionLog(
    userId: string,
    routeId: string,
    dshSessionId: string,
    authoritativeMode: ExecutionMode,
    spaceFolder: string,
    explicitPath?: string,
    dshSessionsDir?: string
  ): Promise<DshSessionReadResult> {
    // 1. If explicitPath provided and exists, read from it directly
    if (explicitPath) {
      if (fs.existsSync(explicitPath)) {
        return this.readSessionLogFromDisk(explicitPath, routeId);
      } else {
        return {
          status: 'MISSING',
          isEmpty: true,
          messageCount: 0,
          canonicalHash: computeCanonicalMessagesHash([]),
        };
      }
    }

    // 2. Custom injected reader hook (if supplied)
    if (this.sessionLogReader) {
      const customRes = await this.sessionLogReader({
        userId,
        routeId,
        dshSessionId,
        executionMode: authoritativeMode,
        spaceFolder,
        candidatePaths: [],
      });
      if (customRes) {
        return customRes;
      }
    }

    // 3. Prefer unified runtimeArtifactPort if available (supports both host and container via HostRuntimePortAdapter / DockerRuntimeAdapter)
    if (this.runtimeArtifactPort) {
      try {
        if (typeof this.runtimeArtifactPort.checkSessionArtifact === 'function') {
          const check = await this.runtimeArtifactPort.checkSessionArtifact({
            userId,
            dshSessionId,
            workspaceFolder: spaceFolder,
          });

          if (check && check.exists && check.valid && typeof this.runtimeArtifactPort.exportForkSeed === 'function') {
            const exported = await this.runtimeArtifactPort.exportForkSeed({
              userId,
              sourceDshSessionId: dshSessionId,
              workspaceFolder: spaceFolder,
            });

            if (exported && Array.isArray(exported.events)) {
              const projected = parseDshSessionJsonl(
                [
                  JSON.stringify({ type: 'session', version: 0, id: dshSessionId, createdAt: Date.now(), delegationDepth: 0 }),
                  ...exported.events.map((e: unknown) => JSON.stringify(e)),
                ].join('\n') + '\n',
                { sessionId: routeId }
              );

              return {
                status: 'FOUND',
                isEmpty: projected.projectedMessages.length === 0,
                messageCount: projected.projectedMessages.length,
                canonicalHash: projected.canonicalHash,
                parsedSession: projected,
                executionMode: authoritativeMode,
                resolvedPath: `${authoritativeMode}:${dshSessionId}`,
                rawSha256: exported.receipt?.checksum,
              };
            }
          } else if (check && !check.exists) {
            // Artifact check confirmed session does not exist in active runtime handle
            // Fall through to filesystem roots check below
          } else if (check && !check.valid) {
            return {
              status: 'PARSE_ERROR',
              isEmpty: false,
              messageCount: 0,
              canonicalHash: computeCanonicalMessagesHash([]),
              error: 'Session artifact invalid in runtime',
              executionMode: authoritativeMode,
            };
          }
        } else if (typeof this.runtimeArtifactPort.exportForkSeed === 'function') {
          const exported = await this.runtimeArtifactPort.exportForkSeed({
            userId,
            sourceDshSessionId: dshSessionId,
            workspaceFolder: spaceFolder,
          });

          if (exported && Array.isArray(exported.events)) {
            const projected = parseDshSessionJsonl(
              [
                JSON.stringify({ type: 'session', version: 0, id: dshSessionId, createdAt: Date.now(), delegationDepth: 0 }),
                ...exported.events.map((e: unknown) => JSON.stringify(e)),
              ].join('\n') + '\n',
              { sessionId: routeId }
            );

            return {
              status: 'FOUND',
              isEmpty: projected.projectedMessages.length === 0,
              messageCount: projected.projectedMessages.length,
              canonicalHash: projected.canonicalHash,
              parsedSession: projected,
              executionMode: authoritativeMode,
              resolvedPath: `${authoritativeMode}:${dshSessionId}`,
              rawSha256: exported.receipt?.checksum,
            };
          }
        }
      } catch (portErr: unknown) {
        const msg = portErr instanceof Error ? portErr.message : String(portErr);
        if (!msg.includes('NOT_FOUND') && !msg.includes('SESSION_NOT_FOUND')) {
          // Non-404 runtime communication error
          return {
            status: 'UNAVAILABLE',
            isEmpty: true,
            messageCount: 0,
            canonicalHash: computeCanonicalMessagesHash([]),
            error: msg,
            executionMode: authoritativeMode,
          };
        }
      }
    }

    // 4. Resolve per-user and global filesystem roots matching HostRuntimePortAdapter & container layouts
    let encId = dshSessionId;
    try {
      encId = encodeSessionSegment(dshSessionId);
    } catch {}

    // HostRuntimePortAdapter uses userRecord.username as the directory slug on disk
    // (e.g. <dataRoot>/host-runtimes/<username>/.dsh), not user UUID.
    let username = userId;
    try {
      const userRow = this.db
        .prepare('SELECT username FROM users WHERE id = ?')
        .get(userId) as { username: string } | undefined;
      if (userRow && userRow.username) {
        username = userRow.username;
      }
    } catch {}

    const runtimeIdentities = Array.from(new Set([username, userId]));

    const candidateSessionRoots: string[] = [];
    const candidateSpaceCwds: string[] = [];

    if (dshSessionsDir) {
      candidateSessionRoots.push(dshSessionsDir);
    }

    // Host per-user runtime layout (<dataRoot>/host-runtimes/<username>/.dsh/sessions)
    for (const ident of runtimeIdentities) {
      candidateSessionRoots.push(path.join(this.dshHome, 'host-runtimes', ident, '.dsh', 'sessions'));
      candidateSessionRoots.push(path.join(this.dshHome, 'host-runtimes', ident, 'sessions'));
      candidateSpaceCwds.push(path.join(this.dshHome, 'host-runtimes', ident, 'spaces', spaceFolder));
      candidateSpaceCwds.push(path.join(this.dshHome, 'host-runtimes', ident, '.dsh', 'spaces', spaceFolder));
    }

    // Direct dshHome layout (<dshHome>/sessions)
    candidateSessionRoots.push(path.join(this.dshHome, 'sessions'));
    candidateSessionRoots.push(path.join(this.dshHome, '.dsh', 'sessions'));

    // Container volume layout resolution (tenant-specific authoritative mapping with validated user/labels and root containment; NO directory-wide guessing)
      const volumesManifestDir = path.join(this.dshHome, 'volumes');
      const containersDir = path.join(this.dshHome, 'containers');
      const verifiedTenantVolumes = new Set<string>();

      for (const ident of runtimeIdentities) {
        // A. Inspect container metadata for this exact tenant identity (authoritative mapping)
        const cPath = path.join(containersDir, `enkeep-demo-${ident}.json`);
        if (fs.existsSync(cPath)) {
          try {
            const cMeta = JSON.parse(fs.readFileSync(cPath, 'utf8'));
            const cUser = cMeta.userId || (cMeta.labels && cMeta.labels['enkeep.user']);
            const vName = cMeta.volumeName;
            if (
              (cUser === userId || cUser === username) &&
              typeof vName === 'string' &&
              !vName.includes('/') &&
              !vName.includes('\\') &&
              !vName.includes('..') &&
              /^enkeep-demo-dsh-[a-z0-9][a-z0-9_-]{0,60}$/.test(vName) &&
              (vName === `enkeep-demo-dsh-${ident}` || vName.startsWith(`enkeep-demo-dsh-${ident}-`))
            ) {
              const vPath = path.join(volumesManifestDir, `${vName}.json`);
              if (fs.existsSync(vPath)) {
                try {
                  const vMeta = JSON.parse(fs.readFileSync(vPath, 'utf8'));
                  const vUser = vMeta.userId || (vMeta.labels && vMeta.labels['enkeep.user']);
                  if (vUser === userId || vUser === username) {
                    verifiedTenantVolumes.add(vName);
                  }
                } catch {}
              } else {
                verifiedTenantVolumes.add(vName);
              }
            }
          } catch {}
        }

        // B. Inspect direct signed volume metadata for this exact tenant identity (authoritative mapping)
        const directVPath = path.join(volumesManifestDir, `enkeep-demo-dsh-${ident}.json`);
        if (fs.existsSync(directVPath)) {
          try {
            const vMeta = JSON.parse(fs.readFileSync(directVPath, 'utf8'));
            const vUser = vMeta.userId || (vMeta.labels && vMeta.labels['enkeep.user']);
            const vName = vMeta.volumeName;
            if (
              (vUser === userId || vUser === username) &&
              typeof vName === 'string' &&
              !vName.includes('/') &&
              !vName.includes('\\') &&
              !vName.includes('..') &&
              /^enkeep-demo-dsh-[a-z0-9][a-z0-9_-]{0,60}$/.test(vName) &&
              (vName === `enkeep-demo-dsh-${ident}` || vName.startsWith(`enkeep-demo-dsh-${ident}-`))
            ) {
              verifiedTenantVolumes.add(vName);
            }
          } catch {}
        }
      }

      // Root containment verification for verified tenant-only volumes (fail closed if not strictly contained)
      for (const vName of verifiedTenantVolumes) {
        // 1. OrbStack volume containment
        const orbBase = path.join(os.homedir(), 'OrbStack', 'docker', 'volumes');
        const orbVol = path.resolve(orbBase, vName);
        if (orbVol.startsWith(path.resolve(orbBase) + path.sep) && fs.existsSync(orbVol)) {
          for (const sub of ['.dsh/sessions', 'dsh-sessions', 'sessions']) {
            const subDir = path.resolve(orbVol, sub);
            if (subDir.startsWith(orbVol + path.sep) && fs.existsSync(subDir)) {
              candidateSessionRoots.push(subDir);
            }
          }
        }

        // 2. Standard Docker volume containment
        const dockerBase = '/var/lib/docker/volumes';
        const dockerVol = path.resolve(dockerBase, vName, '_data');
        if (dockerVol.startsWith(path.resolve(dockerBase) + path.sep) && fs.existsSync(dockerVol)) {
          for (const sub of ['.dsh/sessions', 'dsh-sessions', 'sessions']) {
            const subDir = path.resolve(dockerVol, sub);
            if (subDir.startsWith(dockerVol + path.sep) && fs.existsSync(subDir)) {
              candidateSessionRoots.push(subDir);
            }
          }
        }

        // 3. dshHome/volumes local volume containment (for isolated local test fixture roots)
        const localVol = path.resolve(volumesManifestDir, vName);
        if (localVol.startsWith(path.resolve(volumesManifestDir) + path.sep) && fs.existsSync(localVol)) {
          for (const sub of ['.dsh/sessions', 'dsh-sessions', 'sessions']) {
            const subDir = path.resolve(localVol, sub);
            if (subDir.startsWith(localVol + path.sep) && fs.existsSync(subDir)) {
              candidateSessionRoots.push(subDir);
            }
          }
        }
      }

    candidateSpaceCwds.push(path.join(this.dshHome, 'spaces', spaceFolder));
    candidateSpaceCwds.push(`/home/dsh/spaces/${spaceFolder}`);

    // Derive all possible project keys
    const projectKeys = new Set<string>();
    for (const cwd of candidateSpaceCwds) {
      projectKeys.add(computeDshProjectKey(cwd));
    }
    // Also include default/root project keys
    projectKeys.add(computeDshProjectKey(`/home/dsh/spaces`));
    projectKeys.add(computeDshProjectKey(path.join(this.dshHome, 'spaces')));

    const candidatePaths: string[] = [];
    let knownRootExists = false;

    for (const root of candidateSessionRoots) {
      if (fs.existsSync(root)) {
        knownRootExists = true;
        for (const pKey of projectKeys) {
          candidatePaths.push(path.join(root, pKey, encId, 'session.jsonl'));
          candidatePaths.push(path.join(root, pKey, dshSessionId, 'session.jsonl'));
        }
        // Flat candidates within this existing root
        candidatePaths.push(path.join(root, dshSessionId, 'session.jsonl'));
        candidatePaths.push(path.join(root, encId, 'session.jsonl'));
        candidatePaths.push(path.join(root, `${dshSessionId}.jsonl`));
        candidatePaths.push(path.join(root, `${encId}.jsonl`));

        // Search subdirectories inside this existing root
        try {
          const entries = fs.readdirSync(root, { withFileTypes: true });
          for (const ent of entries) {
            if (ent.isDirectory()) {
              candidatePaths.push(path.join(root, ent.name, encId, 'session.jsonl'));
              candidatePaths.push(path.join(root, ent.name, dshSessionId, 'session.jsonl'));
            }
          }
        } catch {}
      }
    }

    // Check candidate paths on disk
    for (const cand of candidatePaths) {
      if (fs.existsSync(cand)) {
        const res = await this.readSessionLogFromDisk(cand, routeId);
        return {
          ...res,
          executionMode: authoritativeMode,
          resolvedPath: path.basename(cand),
        };
      }
    }

    // Invariant: If no runtime session root exists or was resolvable, it is UNAVAILABLE (not false uninitialized).
    // 0 SQL rows alone is not proof of uninitialized when the root is missing/wrong.
    if (!knownRootExists) {
      return {
        status: 'UNAVAILABLE',
        isEmpty: true,
        messageCount: 0,
        canonicalHash: computeCanonicalMessagesHash([]),
        error: `Runtime sessions directory is not accessible for user ${userId} at ${this.dshHome}`,
        executionMode: authoritativeMode,
      };
    }

    // A valid root exists, but the session log does not exist in it -> truly MISSING
    return {
      status: 'MISSING',
      isEmpty: true,
      messageCount: 0,
      canonicalHash: computeCanonicalMessagesHash([]),
      executionMode: authoritativeMode,
    };
  }

  /**
   * Verifies if an archived route was superseded by a canonical route within the same space and tenant,
   * supported by proven merge evidence (moved messages, duplicate provenance join, explicit merge marker,
   * or reparented session sources).
   *
   * Invariants:
   * 1. Must be archived (route.route_status === 'archived' || route.space_status === 'archived')
   * 2. Canonical route must be configured, different from this route, and exist in SAME space & SAME tenant with status='active'
   * 3. Proven consolidation relation must exist:
   *    a) Exact moved messages in web_messages where session_id = canonRoute.id and route_key LIKE '%:' || route.id
   *    b) Exact duplicate provenance match where fixed_import_provenance on route shares source_message_id with canonRoute
   *    c) Explicit merge marker in title (e.g. '[Merged into ...]')
   *    d) Reparented non-web session source matching route.peer_id and creation timestamp while route has 0 remaining sources
   *    e) Canonical session_sources with explicit metadata link referencing route.id or dshId
   * 4. Ordinary archived unmerged fixture (no canonical pointer, or mere co-existence with same import source / workspace)
   *    strictly rejects merged_archive to prevent false proof.
   */
  public verifyMergedArchive(
    userId: string,
    route: RouteAndSpaceRow | null,
    effectiveDshSessionId?: string
  ): {
    isMergedArchive: boolean;
    canonicalSessionId?: string;
    evidence?: string;
    retentionInfo?: string;
  } {
    if (!route) return { isMergedArchive: false };

    const isArchived = route.route_status === 'archived' || route.space_status === 'archived';
    if (!isArchived) return { isMergedArchive: false };

    const canonicalSessionId = route.canonical_session_id;
    if (!canonicalSessionId || canonicalSessionId === route.id) {
      return { isMergedArchive: false };
    }

    // 1. Strict cross-space / cross-tenant / active status validation:
    // Canonical route must exist in SAME tenant AND SAME space with status = 'active'!
    const canonRoute = this.db.prepare(`
      SELECT id, space_id, user_id, status FROM session_routes
      WHERE id = ? AND user_id = ? AND space_id = ? AND status = 'active'
    `).get(canonicalSessionId, userId, route.space_id) as { id: string; space_id: string; user_id: string; status: string } | undefined;

    if (!canonRoute) {
      // Reject cross-tenant, cross-space, or non-active canonical pointer!
      return { isMergedArchive: false };
    }

    const dshId = effectiveDshSessionId || route.dsh_session_id;
    const peerId = route.peer_id ?? '';

    // 2. Proven consolidation relation:
    // A. Check for exact reparented/moved messages from route.id to canonRoute.id
    try {
      const movedRow = this.db.prepare(`
        SELECT COUNT(*) as c FROM web_messages
        WHERE session_id = ? AND user_id = ? AND route_key LIKE ?
      `).get(canonRoute.id, userId, `%:${route.id}`) as { c: number } | undefined;
      const movedCount = movedRow ? Number(movedRow.c) : 0;
      if (movedCount > 0) {
        return {
          isMergedArchive: true,
          canonicalSessionId: canonRoute.id,
          evidence: `web_messages (${movedCount} moved message records)`,
          retentionInfo: `Historical messages reparented to canonical session merge (${movedCount} messages moved; route archived)`,
        };
      }
    } catch {}

    // B. Check for exact duplicate provenance matching canonical route
    try {
      const dupRow = this.db.prepare(`
        SELECT COUNT(*) as c
        FROM fixed_import_provenance f_arch
        JOIN fixed_import_provenance f_canon
          ON f_arch.source_message_id = f_canon.source_message_id
          AND f_arch.source_chat_jid = f_canon.source_chat_jid
        WHERE f_arch.target_route_id = ? AND f_canon.target_route_id = ?
          AND f_arch.user_id = ? AND f_canon.user_id = ?
      `).get(route.id, canonRoute.id, userId, userId) as { c: number } | undefined;
      const dupCount = dupRow ? Number(dupRow.c) : 0;
      if (dupCount > 0) {
        return {
          isMergedArchive: true,
          canonicalSessionId: canonRoute.id,
          evidence: `fixed_import_provenance duplicate match (${dupCount} duplicate records on canonical)`,
          retentionInfo: `Historical messages superseded by canonical session merge; duplicate originals retained on obsolete route (${dupCount} provenance records)`,
        };
      }
    } catch {}

    // C. Check for reparented non-web session sources with exact timestamp & peer_id match
    if (route.channel !== 'web' && route.peer_id) {
      try {
        const directSources = this.db.prepare(`
          SELECT COUNT(*) as c FROM session_sources
          WHERE user_id = ? AND route_id = ?
        `).get(userId, route.id) as { c: number } | undefined;
        if (!directSources || Number(directSources.c) === 0) {
          const reparented = this.db.prepare(`
            SELECT COUNT(*) as c FROM session_sources
            WHERE route_id = ? AND user_id = ? AND (source_id = ? OR source_id = ?) AND created_at = ?
          `).get(canonRoute.id, userId, route.peer_id, `feishu:${route.peer_id}`, (route as any).created_at) as { c: number } | undefined;
          const reparentedCount = reparented ? Number(reparented.c) : 0;
          if (reparentedCount > 0) {
            return {
              isMergedArchive: true,
              canonicalSessionId: canonRoute.id,
              evidence: `reparented session_sources (${reparentedCount} records on canonical)`,
              retentionInfo: `Historical channel route superseded by canonical session merge (${reparentedCount} reparented source records)`,
            };
          }
        }
      } catch {}
    }

    // E. Check canonical session_sources establishing explicit relation to this route's identity
    try {
      const canonSources = this.db.prepare(`
        SELECT source_id, metadata FROM session_sources
        WHERE user_id = ? AND route_id = ?
      `).all(userId, canonRoute.id) as Array<{ source_id: string; metadata: string | null }>;

      // Check if this route still holds direct session_sources
      const directSources = this.db.prepare(`
        SELECT COUNT(*) as c FROM session_sources
        WHERE user_id = ? AND route_id = ?
      `).get(userId, route.id) as { c: number } | undefined;
      const hasDirectSources = directSources && Number(directSources.c) > 0;

      for (const src of canonSources) {
        const sId = src.source_id || '';
        const meta = src.metadata || '';

        const routeIdMatch = meta.includes(route.id);
        const dshIdMatch = dshId && meta.includes(dshId);
        const isGenericPeer = !peerId || peerId === 'web:main' || peerId === 'web:default' || peerId === 'main';
        const specificPeerMatch = !hasDirectSources && !isGenericPeer && (sId === peerId || sId === `feishu:${peerId}`);

        if (routeIdMatch || dshIdMatch || specificPeerMatch) {
          return {
            isMergedArchive: true,
            canonicalSessionId: canonRoute.id,
            evidence: `canonical session_sources retained relation (source_id: ${sId})`,
            retentionInfo: `Historical route superseded by canonical session merge (retained source relation: ${sId})`,
          };
        }
      }
    } catch {}

    // No persistent merge evidence found -> DO NOT base classification only on same-space pointer
    return { isMergedArchive: false };
  }

  /**
   * Generates a read-only reconciliation report for a single session.
   */
  async reconcileSession(
    userId: string,
    sessionId: string,
    dshJsonlPath?: string
  ): Promise<SessionReconciliationReport> {
    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      throw new ValidationError('userId is required');
    }
    if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new ValidationError('sessionId is required');
    }

    const checkedAt = new Date().toISOString();

    // 1. Resolve route, space, authoritative mode and generation
    const resolved = this.resolveRouteAndSpace(userId, sessionId);
    const targetRouteId = resolved.routeId;
    const targetDshSessionId = resolved.dshSessionId;

    // 2. Query platform web_messages
    const msgRows = this.db.prepare(`
      SELECT id, session_id, user_id, role, content, status, route_key, turn_id, created_at
      FROM web_messages
      WHERE user_id = ? AND (session_id = ? OR route_key = ?)
      ORDER BY created_at ASC, id ASC
    `).all(userId, targetRouteId, targetRouteId) as unknown as SqliteWebMessageRow[];

    const platformMessageCount = msgRows.length;
    const platformHash = computeCanonicalMessagesHash(
      msgRows.map((m) => ({ role: m.role, content: m.content }))
    );

    // 3. Read DSH session log via authoritative provider/reader
    const dshRead = await this.readSessionLog(
      userId,
      targetRouteId,
      targetDshSessionId,
      resolved.authoritativeMode,
      resolved.spaceFolder,
      dshJsonlPath
    );

    const dshMessageCount = dshRead.messageCount;
    const dshHash = dshRead.canonicalHash;

    // 4. Compute discrepancies and classification status
    let status: ReconciliationStatus;
    const details: Record<string, unknown> = {};
    let discrepancies: ReconciliationDiscrepancy[] | undefined = undefined;

    if (resolved.isArchived) {
      details.archived = true;
    }
    if (dshRead.executionMode) {
      details.executionMode = dshRead.executionMode;
    }
    if (resolved.currentGeneration > 1) {
      details.generation = resolved.currentGeneration;
    }

    // Check for verified merged archive:
    const mergeVerification = this.verifyMergedArchive(userId, resolved.route, targetDshSessionId);

    if (dshRead.status === 'UNAVAILABLE') {
      status = 'unavailable';
      details.reason = 'dsh_runtime_unavailable';
      if (dshRead.error) details.error = dshRead.error;
    } else if (dshRead.status === 'PARSE_ERROR') {
      status = 'parse_error';
      details.reason = 'dsh_jsonl_parse_error';
      if (dshRead.error) details.error = dshRead.error;
    } else if (mergeVerification.isMergedArchive) {
      status = 'merged_archive';
      details.mergedArchive = true;
      details.canonicalSessionId = mergeVerification.canonicalSessionId;
      if (resolved.route?.space_id) {
        details.spaceId = resolved.route.space_id;
      }
      details.reason = 'superseded_by_canonical_merge';
      if (mergeVerification.retentionInfo) {
        details.retentionInfo = mergeVerification.retentionInfo;
      }
      if (mergeVerification.evidence) {
        details.mergeEvidence = mergeVerification.evidence;
      }

      // Compute discrepancies against local archived JSONL as expected projection differences
      if (dshRead.status === 'FOUND') {
        discrepancies = this.detectDiscrepancies(
          msgRows,
          dshRead.parsedSession?.projectedMessages ?? []
        );
        if (discrepancies.length > 0 || platformMessageCount !== dshMessageCount || platformHash !== dshHash) {
          details.expectedProjectionDifference = true;
          details.platformMessageCount = platformMessageCount;
          details.dshMessageCount = dshMessageCount;
          details.discrepancyCount = discrepancies.length;
        }
      } else if (dshRead.status === 'MISSING') {
        details.expectedProjectionDifference = true;
      }
    } else if (dshRead.status === 'MISSING') {
      if (platformMessageCount === 0) {
        // Active or archived placeholder with 0 messages in SQLite and no JSONL yet
        // Distinct from missing49/runtime corruption
        status = 'uninitialized';
        details.reason = 'uninitialized_session_placeholder';
      } else {
        // Platform has messages, but runtime log is missing
        status = 'missing';
        details.reason = 'dsh_jsonl_missing';
      }
    } else {
      // DSH log FOUND
      if (platformMessageCount === 0 && dshMessageCount > 0) {
        status = 'missing';
        details.reason = 'platform_messages_missing';
        discrepancies = this.detectDiscrepancies(msgRows, dshRead.parsedSession?.projectedMessages ?? []);
      } else {
        discrepancies = this.detectDiscrepancies(
          msgRows,
          dshRead.parsedSession?.projectedMessages ?? []
        );

        if (
          discrepancies.length > 0 ||
          platformHash !== dshHash ||
          platformMessageCount !== dshMessageCount
        ) {
          status = 'drift';
          details.platformMessageCount = platformMessageCount;
          details.dshMessageCount = dshMessageCount;
          details.discrepancyCount = discrepancies.length;
        } else {
          status = 'matched';
        }
      }
    }

    return {
      userId,
      sessionId: targetRouteId,
      dshSessionId: targetDshSessionId,
      canonicalSessionId: mergeVerification.isMergedArchive
        ? mergeVerification.canonicalSessionId
        : (resolved.canonicalSessionId || undefined),
      spaceId: resolved.route?.space_id || undefined,
      status,
      dshReadStatus: dshRead.status,
      platformMessageCount,
      dshMessageCount,
      platformHash,
      dshHash,
      checkedAt,
      discrepancies: discrepancies && discrepancies.length > 0 ? discrepancies : undefined,
      details: Object.keys(details).length > 0 ? details : undefined,
      isArchived: resolved.isArchived,
      isCanonical: resolved.isCanonical,
      executionMode: resolved.authoritativeMode,
      generationNumber: resolved.currentGeneration,
    };
  }

  /**
   * Generates a read-only reconciliation report across all sessions for a tenant.
   * Preserves full inventory but can filter active canonical vs archived in report summary.
   */
  async reconcileAllSessions(
    userId: string,
    optionsOrDir?: string | ReconcileAllOptions
  ): Promise<ReconcileAllReport> {
    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      throw new ValidationError('userId is required');
    }

    const dshSessionsDir =
      typeof optionsOrDir === 'string'
        ? optionsOrDir
        : optionsOrDir?.dshSessionsDir;

    const filterStatus =
      typeof optionsOrDir === 'object' && optionsOrDir !== null
        ? optionsOrDir.filterStatus
        : undefined;

    const routes = this.db.prepare(`
      SELECT id, dsh_session_id, status FROM session_routes WHERE user_id = ?
      ORDER BY created_at ASC
    `).all(userId) as Array<{ id: string; dsh_session_id: string; status: string }>;

    const reports: SessionReconciliationReport[] = [];
    let matchedCount = 0;
    let driftCount = 0;
    let missingCount = 0;
    let uninitializedCount = 0;
    let unavailableCount = 0;
    let parseErrorCount = 0;
    let archivedCount = 0;
    let activeCount = 0;
    let mergedArchiveCount = 0;

    for (const r of routes) {
      if (r.status === 'archived') {
        archivedCount++;
      } else {
        activeCount++;
      }

      if (filterStatus === 'active' && r.status === 'archived') {
        continue;
      }
      if (filterStatus === 'archived' && r.status !== 'archived') {
        continue;
      }

      let jsonlPath: string | undefined = undefined;
      if (dshSessionsDir && fs.existsSync(dshSessionsDir)) {
        const candidatePath = path.join(dshSessionsDir, r.dsh_session_id, 'session.jsonl');
        if (fs.existsSync(candidatePath)) {
          jsonlPath = candidatePath;
        }
      }

      const rep = await this.reconcileSession(userId, r.id, jsonlPath);
      reports.push(rep);

      if (rep.status === 'merged_archive') {
        mergedArchiveCount++;
      }

      // KPIs default compare active canonical only with separate archivedCount!
      // When filterStatus === 'archived', summary counts reflect archived sessions.
      const shouldCountInKpis =
        filterStatus === 'archived'
          ? rep.isArchived
          : (!rep.isArchived);

      if (shouldCountInKpis) {
        if (rep.status === 'matched') matchedCount++;
        else if (rep.status === 'drift') driftCount++;
        else if (rep.status === 'missing') missingCount++;
        else if (rep.status === 'uninitialized') uninitializedCount++;
        else if (rep.status === 'unavailable') unavailableCount++;
        else if (rep.status === 'parse_error') parseErrorCount++;
      }
    }

    return {
      userId,
      totalSessions: reports.length,
      matchedCount,
      driftCount,
      missingCount,
      uninitializedCount,
      unavailableCount,
      parseErrorCount,
      archivedCount,
      activeCount,
      mergedArchiveCount,
      reports,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Explicit idempotent admin repair command.
   *
   * Safety invariants:
   * - HARD REFUSE when source is unreadable, missing, parse-failed, or unavailable.
   * - HARD REFUSE when source is empty (0 messages) while SQLite is positive (>0 messages).
   * - HARD REFUSE when active or queued turn run is in progress for this session.
   * - HARD REFUSE when generation or tenant mismatch is detected.
   * - Additive-only by default: deletes are unconditionally disabled in this feature.
   * - Never deletes data or fabricates "matched".
   */
  async repairSession(
    userId: string,
    sessionId: string,
    dshJsonlPath?: string,
    options: RepairSessionOptions = {}
  ): Promise<RepairSessionResult> {
    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      throw new ValidationError('userId is required');
    }
    if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new ValidationError('sessionId is required');
    }

    // 1. Resolve session route, space, and generation
    const resolved = this.resolveRouteAndSpace(userId, sessionId);
    const targetRouteId = resolved.routeId;
    const targetDshSessionId = resolved.dshSessionId;

    // Hard refuse: verified merged archive session
    const mergeVerification = this.verifyMergedArchive(userId, resolved.route, targetDshSessionId);
    if (mergeVerification.isMergedArchive) {
      throw new PlatformError(
        `Repair refused: Session ${targetRouteId} is an archived session that has been merged into canonical session ${mergeVerification.canonicalSessionId}. Direct repair is rejected to prevent duplicating history back.`,
        'OPERATION_NOT_ALLOWED',
        403
      );
    }

    // Hard refuse: wrong generation
    if (
      options.expectedGeneration !== undefined &&
      resolved.currentGeneration !== options.expectedGeneration
    ) {
      throw new PlatformError(
        `Generation mismatch: expected generation ${options.expectedGeneration}, but route is at generation ${resolved.currentGeneration}`,
        'CONFLICT',
        409
      );
    }

    // Hard refuse: active or queued turn run
    const activeTurnsCount = (
      this.db.prepare(`
        SELECT COUNT(*) as c FROM turn_runs
        WHERE user_id = ? AND route_id = ? AND status IN ('running', 'queued')
      `).get(userId, targetRouteId) as { c: number }
    ).c;

    if (activeTurnsCount > 0) {
      throw new PlatformError(
        'Repair refused: An active or queued turn run is currently in progress for this session',
        'CONFLICT',
        409
      );
    }

    // Hard refuse: unconditional server-side rejection of destructive deleteOrphans in this feature
    if (options.deleteOrphans) {
      throw new PlatformError(
        'Repair refused: Destructive orphan deletion is disabled for storage safety. Only additive repair is permitted.',
        'OPERATION_NOT_ALLOWED',
        403
      );
    }

    // 2. Read runtime session log
    const dshRead = await this.readSessionLog(
      userId,
      targetRouteId,
      targetDshSessionId,
      resolved.authoritativeMode,
      resolved.spaceFolder,
      dshJsonlPath
    );

    // Hard refuse: source unreadable / missing / parse error / unavailable
    if (dshRead.status !== 'FOUND') {
      throw new PlatformError(
        `Repair refused: Runtime session source is ${dshRead.status} (${dshRead.error || 'file not found or unreadable'})`,
        'PRECONDITION_FAILED',
        412
      );
    }

    // 3. Query existing SQLite web_messages
    const existingRows = this.db.prepare(`
      SELECT id, session_id, user_id, role, content, status, route_key, turn_id, created_at
      FROM web_messages
      WHERE user_id = ? AND (session_id = ? OR route_key = ?)
      ORDER BY created_at ASC, id ASC
    `).all(userId, targetRouteId, targetRouteId) as unknown as SqliteWebMessageRow[];

    const platformMessageCount = existingRows.length;
    const dshMessages = dshRead.parsedSession?.projectedMessages ?? [];
    const dshMessageCount = dshMessages.length;

    // Hard refuse: source empty while SQL positive
    if (dshMessageCount === 0 && platformMessageCount > 0) {
      throw new PlatformError(
        `Repair refused: Runtime session source is empty (0 messages) while SQLite has ${platformMessageCount} messages; aborting to prevent data loss`,
        'PRECONDITION_FAILED',
        412
      );
    }

    // Concurrency snapshot hash check
    const initialSnapshotSha256 = dshRead.rawSha256;
    if (
      options.expectedSnapshotHash &&
      initialSnapshotSha256 &&
      options.expectedSnapshotHash !== initialSnapshotSha256
    ) {
      throw new PlatformError(
        'File snapshot hash mismatch before repair execution',
        'CONFLICT',
        409
      );
    }

    const dryRun = Boolean(options.dryRun);
    const nowIso = new Date().toISOString();

    const discrepancies = this.detectDiscrepancies(existingRows, dshMessages);

    let repairedCount = 0;
    const unresolvedDiscrepancies: ReconciliationDiscrepancy[] = [];

    for (const disc of discrepancies) {
      if (disc.type === 'missingInSqlite') {
        repairedCount++;
      } else {
        // contentMismatch, roleMismatch, orphanInSqlite remain UNTOUCHED in default repair
        unresolvedDiscrepancies.push(disc);
      }
    }

    // Fast-path: already matched
    if (discrepancies.length === 0) {
      return {
        userId,
        sessionId: targetRouteId,
        status: 'unchanged',
        repairedCount: 0,
        unresolvedCount: 0,
        dryRun,
        repairedAt: nowIso,
        discrepancies: [],
        unresolvedDiscrepancies: [],
      };
    }

    if (!dryRun) {
      // Re-verify snapshot if path exists on disk
      if (dshJsonlPath && fs.existsSync(dshJsonlPath) && initialSnapshotSha256) {
        const currentBytes = fs.readFileSync(dshJsonlPath);
        const currentSha256 = computeSha256(currentBytes);
        if (currentSha256 !== initialSnapshotSha256) {
          throw new PlatformError(
            'Session JSONL modified concurrently while preparing repair; aborting',
            'CONFLICT',
            409
          );
        }
      }

      this.db.exec('BEGIN IMMEDIATE');
      let inTx = true;

      try {
        // In-transaction revalidation of quiescence and generation consistency
        const txActiveTurns = (
          this.db.prepare(`
            SELECT COUNT(*) as c FROM turn_runs
            WHERE user_id = ? AND route_id = ? AND status IN ('running', 'queued')
          `).get(userId, targetRouteId) as { c: number }
        ).c;

        if (txActiveTurns > 0) {
          throw new PlatformError(
            'Repair refused: Concurrent turn run was queued or started during transaction',
            'CONFLICT',
            409
          );
        }

        const txRoute = this.db.prepare(`
          SELECT current_generation FROM session_routes WHERE user_id = ? AND id = ?
        `).get(userId, targetRouteId) as { current_generation: number } | undefined;

        if (txRoute && options.expectedGeneration !== undefined && txRoute.current_generation !== options.expectedGeneration) {
          throw new PlatformError(
            `Generation conflict: expected ${options.expectedGeneration}, but found ${txRoute.current_generation}`,
            'CONFLICT',
            409
          );
        }

        // Strict INSERT ON CONFLICT DO NOTHING: never mutates existing rows
        const insertStmt = this.db.prepare(`
          INSERT INTO web_messages (
            id, session_id, user_id, role, content, status, route_key, turn_id, created_at
          ) VALUES (?, ?, ?, ?, ?, 'delivered', ?, ?, ?)
          ON CONFLICT(id) DO NOTHING
        `);

        let actualInsertedCount = 0;

        // Strictly insert missing messages only; existing rows untouched
        for (const disc of discrepancies) {
          if (disc.type === 'missingInSqlite') {
            const dshMsg = dshMessages[disc.position];
            if (dshMsg) {
              const runRes = insertStmt.run(
                dshMsg.id,
                targetRouteId,
                userId,
                dshMsg.role,
                dshMsg.content,
                targetRouteId,
                dshMsg.turnId,
                dshMsg.createdAt
              );

              if (runRes.changes > 0) {
                actualInsertedCount++;
              }

              if (dshMsg.attachments && dshMsg.attachments.length > 0) {
                try {
                  const attInsertStmt = this.db.prepare(`
                    INSERT INTO message_attachments (
                      id, message_id, user_id, space_id, relative_path, snapshot_path, etag, size, media_type, display_name, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO NOTHING
                  `);
                  for (const att of dshMsg.attachments) {
                    attInsertStmt.run(
                      att.id || `att_${dshMsg.id}_${att.etag}`,
                      dshMsg.id,
                      userId,
                      targetRouteId,
                      att.relativePath,
                      att.snapshotPath,
                      att.etag,
                      att.size,
                      att.mediaType,
                      att.displayName ?? null,
                      dshMsg.createdAt
                    );
                  }
                } catch {
                  // Ignore if message_attachments table not migrated yet
                }
              }
            }
          }
        }

        // Record structured audit log (honest accounting: does NOT pretend drift was fixed)
        try {
          const auditId = `aud_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
          const detailsStr = JSON.stringify({
            action: 'storage_repaired',
            sessionId: targetRouteId,
            dshSessionId: targetDshSessionId,
            repairedCount: actualInsertedCount,
            unresolvedCount: unresolvedDiscrepancies.length,
            dryRun: false,
          });
          this.db.prepare(`
            INSERT INTO auth_audit_log (id, user_id, username, action, details, created_at)
            VALUES (?, ?, ?, 'storage_repaired', ?, CURRENT_TIMESTAMP)
          `).run(auditId, userId, userId, detailsStr);
        } catch {
          // Ignore audit write failure inside repair
        }

        this.db.exec('COMMIT');
        inTx = false;
        repairedCount = actualInsertedCount;
      } catch (txErr) {
        if (inTx) {
          try {
            this.db.exec('ROLLBACK');
          } catch {}
        }
        throw txErr;
      }
    }

    return {
      userId,
      sessionId: targetRouteId,
      status: repairedCount > 0 ? 'repaired' : 'unchanged',
      repairedCount,
      unresolvedCount: unresolvedDiscrepancies.length > 0 ? unresolvedDiscrepancies.length : undefined,
      unresolvedDiscrepancies: unresolvedDiscrepancies.length > 0 ? unresolvedDiscrepancies : undefined,
      dryRun,
      repairedAt: nowIso,
      discrepancies,
    };
  }
}
