/**
 * Test Platform Server Manager for Contract E2E Tests.
 *
 * Configures and boots real PlatformServer with SQLite storage, real Web UI,
 * explicit in-process TestOnlyContractRuntimeGateway, and loopback 127.0.0.1:0 binding.
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  PlatformServer,
  SqliteWebMessageStore,
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  TEST_TENANT_QUOTA_DEFAULTS,
  DefaultRuntimeMountReconciler,
  type TenantRuntimeFileProvider,
  type CanonicalFileOperationRequest,
  type CanonicalFileOperationResult,
  type CanonicalStreamingReadRequest,
  type CanonicalStreamingReadResult,
} from '@enkeep/platform-server';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { NotFoundError, PlatformError, type FixtureProvisionResult } from '@enkeep/platform-core';
import { DefaultAuthService, provisionFixtures } from '@enkeep/platform-auth';
import { TestOnlyContractRuntimeGateway } from './test-only-runtime-gateway.js';

import type { InboundEnvelope } from '@enkeep/web-channel';
import type { ManagementRuntimeProvider } from '@enkeep/platform-server';

export const TEST_COOKIE_SECRET = 'web-e2e-contract-cookie-secret-32-chars-minimum!';
export const TEST_CSRF_TOKEN = 'web-e2e-contract-csrf-token-32-chars-minimum!!';

function computeEtag(data: string | Buffer): string {
  const hash = createHash('sha256').update(data).digest('hex').toLowerCase();
  return `"${hash}"`;
}

export function createMockFileProvider(): TenantRuntimeFileProvider {
  const spaceStorage = new Map<string, { buffer: Buffer; mtimeMs: number }>();
  const directories = new Set<string>();

  return {
    async execute(userId: string, spaceId: string, req: CanonicalFileOperationRequest): Promise<CanonicalFileOperationResult> {
      const storageKey = `${spaceId}:${req.path}`;

      if (req.op === 'mkdir') {
        const dirKey = `${spaceId}:${req.path}`;
        if (req.requireAbsent && (directories.has(dirKey) || spaceStorage.has(dirKey))) {
          throw new PlatformError(`Directory or file "${req.path}" already exists`, 'CONFLICT', 409);
        }
        directories.add(dirKey);
        return {
          op: 'mkdir',
          path: req.path,
          type: 'directory',
          size: 0,
          mtimeMs: Date.now(),
          etag: computeEtag(Buffer.from(req.path)),
        };
      }

      if (req.op === 'delete') {
        const existing = spaceStorage.get(storageKey);
        if (!existing) {
          throw new NotFoundError(`File "${req.path}" not found`);
        }
        if (req.expectedEtag) {
          const currentEtag = computeEtag(existing.buffer);
          if (currentEtag !== req.expectedEtag) {
            throw new PlatformError('ETag mismatch', 'CONFLICT', 409);
          }
        }
        spaceStorage.delete(storageKey);
        return {
          op: 'delete',
          path: req.path,
          type: 'file',
          size: existing.buffer.length,
          mtimeMs: existing.mtimeMs,
          etag: computeEtag(existing.buffer),
        };
      }

      if (req.op === 'read') {
        const item = spaceStorage.get(storageKey);
        if (!item) {
          throw new NotFoundError(`File "${req.path}" not found`);
        }
        const encoding = req.encoding ?? 'utf8';
        const content = encoding === 'base64' ? item.buffer.toString('base64') : item.buffer.toString('utf8');
        return {
          op: 'read',
          path: req.path,
          content,
          encoding,
          type: 'file',
          size: item.buffer.length,
          mtimeMs: item.mtimeMs,
          etag: computeEtag(item.buffer),
        };
      }

      if (req.op === 'list') {
        const relPath = req.path || '.';
        const entries: Array<{ name: string; type: 'file' | 'directory'; size: number; mtimeMs: number; etag: string }> = [];
        const seenDirs = new Set<string>();

        // Files
        for (const [key, val] of spaceStorage.entries()) {
          if (key.startsWith(`${spaceId}:`)) {
            const rel = key.slice(`${spaceId}:`.length);
            if (rel.startsWith('.tmp.') || rel.includes('.stage.tmp') || rel.includes('.rollback.tmp')) {
              continue;
            }
            if (relPath === '.' || relPath === '') {
              const slashIdx = rel.indexOf('/');
              if (slashIdx === -1) {
                entries.push({
                  name: rel,
                  type: 'file',
                  size: val.buffer.length,
                  mtimeMs: val.mtimeMs,
                  etag: computeEtag(val.buffer),
                });
              } else {
                const dirName = rel.slice(0, slashIdx);
                if (!seenDirs.has(dirName)) {
                  seenDirs.add(dirName);
                  entries.push({
                    name: dirName,
                    type: 'directory',
                    size: 0,
                    mtimeMs: val.mtimeMs,
                    etag: computeEtag(dirName),
                  });
                }
              }
            } else {
              const prefix = `${relPath}/`;
              if (rel.startsWith(prefix)) {
                const rest = rel.slice(prefix.length);
                const slashIdx = rest.indexOf('/');
                if (slashIdx === -1) {
                  entries.push({
                    name: rest,
                    type: 'file',
                    size: val.buffer.length,
                    mtimeMs: val.mtimeMs,
                    etag: computeEtag(val.buffer),
                  });
                } else {
                  const dirName = rest.slice(0, slashIdx);
                  if (!seenDirs.has(dirName)) {
                    seenDirs.add(dirName);
                    entries.push({
                      name: dirName,
                      type: 'directory',
                      size: 0,
                      mtimeMs: val.mtimeMs,
                      etag: computeEtag(dirName),
                    });
                  }
                }
              }
            }
          }
        }

        // Directories created via mkdir
        for (const dirKey of directories) {
          if (dirKey.startsWith(`${spaceId}:`)) {
            const rel = dirKey.slice(`${spaceId}:`.length);
            if (relPath === '.' || relPath === '') {
              const slashIdx = rel.indexOf('/');
              const dirName = slashIdx === -1 ? rel : rel.slice(0, slashIdx);
              if (!seenDirs.has(dirName)) {
                seenDirs.add(dirName);
                entries.push({
                  name: dirName,
                  type: 'directory',
                  size: 0,
                  mtimeMs: Date.now(),
                  etag: computeEtag(dirName),
                });
              }
            } else if (rel.startsWith(`${relPath}/`)) {
              const rest = rel.slice(`${relPath}/`.length);
              const slashIdx = rest.indexOf('/');
              const dirName = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
              if (!seenDirs.has(dirName)) {
                seenDirs.add(dirName);
                entries.push({
                  name: dirName,
                  type: 'directory',
                  size: 0,
                  mtimeMs: Date.now(),
                  etag: computeEtag(dirName),
                });
              }
            }
          }
        }

        return {
          op: 'list',
          path: relPath,
          entries,
          truncated: false,
        };
      }

      if (req.op === 'write') {
        const existing = spaceStorage.get(storageKey);
        if (req.requireAbsent && existing) {
          throw new PlatformError(`File "${req.path}" already exists`, 'CONFLICT', 409);
        }
        if (req.expectedEtag) {
          if (!existing) {
            throw new PlatformError('Precondition failed (file missing)', 'CONFLICT', 409);
          }
          const currentEtag = computeEtag(existing.buffer);
          if (currentEtag !== req.expectedEtag) {
            throw new PlatformError('Precondition failed (ETag mismatch)', 'CONFLICT', 409);
          }
        }

        const buf = req.encoding === 'base64' ? Buffer.from(req.content, 'base64') : Buffer.from(req.content, 'utf8');
        const now = Date.now();
        spaceStorage.set(storageKey, { buffer: buf, mtimeMs: now });
        return {
          op: 'write',
          path: req.path,
          type: 'file',
          size: buf.length,
          mtimeMs: now,
          etag: computeEtag(buf),
        };
      }

      if (req.op === 'stat') {
        const item = spaceStorage.get(storageKey);
        if (!item) {
          throw new NotFoundError(`File "${req.path}" not found`);
        }
        return {
          op: 'stat',
          path: req.path,
          type: 'file',
          size: item.buffer.length,
          mtimeMs: item.mtimeMs,
          etag: computeEtag(item.buffer),
        };
      }

      if (req.op === 'sniff') {
        const item = spaceStorage.get(storageKey);
        if (!item) {
          throw new NotFoundError(`File "${req.path}" not found`);
        }
        const p = req.path.toLowerCase();
        let mediaType = 'text/plain';
        if (p.endsWith('.png')) mediaType = 'image/png';
        else if (p.endsWith('.jpg') || p.endsWith('.jpeg')) mediaType = 'image/jpeg';
        else if (p.endsWith('.pdf')) mediaType = 'application/pdf';
        else if (p.endsWith('.json')) mediaType = 'application/json';

        const etag = computeEtag(item.buffer);
        const headerSlice = item.buffer.slice(0, 512);
        return {
          op: 'sniff',
          path: req.path,
          type: 'file',
          size: item.buffer.length,
          mtimeMs: item.mtimeMs,
          etag,
          headerBytesBase64: headerSlice.toString('base64'),
        };
      }

      if (req.op === 'copy') {
        const item = spaceStorage.get(storageKey);
        if (!item) {
          throw new NotFoundError(`File "${req.path}" not found for copy`);
        }
        const actualEtag = computeEtag(item.buffer);
        if (req.expectedEtag && actualEtag !== req.expectedEtag) {
          throw new PlatformError(`ETag mismatch on copy "${req.path}"`, 'CONFLICT', 409);
        }
        const targetStorageKey = `${spaceId}:${req.targetPath}`;
        if (req.requireAbsent && spaceStorage.has(targetStorageKey)) {
          throw new PlatformError(`Destination "${req.targetPath}" already exists`, 'CONFLICT', 409);
        }
        const now = Date.now();
        spaceStorage.set(targetStorageKey, { buffer: item.buffer, mtimeMs: now });
        return {
          op: 'copy',
          path: req.path,
          targetPath: req.targetPath,
          type: 'file',
          size: item.buffer.length,
          mtimeMs: now,
          etag: actualEtag,
        };
      }

      throw new PlatformError('Operation not supported in test mock', 'NOT_SUPPORTED', 400);
    },

    async stageBinaryStream(
      userId: string,
      spaceId: string,
      req: any,
      inStream: NodeJS.ReadableStream
    ): Promise<any> {
      const chunks: Buffer[] = [];
      let totalSize = 0;
      const maxBytes = req.maxSizeBytes ?? (50 * 1024 * 1024);
      const hasher = createHash('sha256');

      await new Promise<void>((resolve, reject) => {
        inStream.on('data', (chunk) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalSize += buf.length;
          if (totalSize > maxBytes) {
            const err = new PlatformError('Payload too large', 'PAYLOAD_TOO_LARGE', 413);
            if (typeof (inStream as any).destroy === 'function') {
              (inStream as any).destroy(err);
            }
            reject(err);
            return;
          }
          hasher.update(buf);
          chunks.push(buf);
        });
        inStream.on('error', reject);
        inStream.on('end', resolve);
      });

      const fullBuffer = Buffer.concat(chunks);
      const sha256Hex = hasher.digest('hex').toLowerCase();
      const stageToken = `.${req.path.split('/').pop() || 'file'}.${randomUUID().replace(/-/g, '').slice(0, 16)}.stage.tmp`;

      spaceStorage.set(`${spaceId}:${stageToken}`, { buffer: fullBuffer, mtimeMs: Date.now() });

      return {
        op: 'stage',
        path: req.path,
        stageToken,
        size: fullBuffer.length,
        sha256: sha256Hex,
        etag: `"${sha256Hex}"`,
      };
    },

    async commitStage(
      userId: string,
      spaceId: string,
      req: any
    ): Promise<any> {
      const staged = spaceStorage.get(`${spaceId}:${req.stageToken}`);
      if (!staged) {
        throw new PlatformError('Staged file not found', 'INVALID_REQUEST', 400);
      }
      spaceStorage.delete(`${spaceId}:${req.stageToken}`);

      const targetKey = `${spaceId}:${req.path}`;
      const existing = spaceStorage.get(targetKey);

      if (req.requireAbsent && existing) {
        throw new PlatformError(`File "${req.path}" already exists`, 'CONFLICT', 409);
      }

      if (req.expectedEtag) {
        if (!existing) {
          throw new NotFoundError(`File "${req.path}" not found for update`);
        }
        const currentEtag = computeEtag(existing.buffer);
        if (currentEtag !== req.expectedEtag) {
          throw new PlatformError(`ETag mismatch`, 'CONFLICT', 409);
        }
      }

      let rollbackToken: string | undefined;
      if (existing && !req.requireAbsent) {
        rollbackToken = req.rollbackToken || `.${req.path.split('/').pop() || 'file'}.${randomUUID().replace(/-/g, '').slice(0, 16)}.rollback.tmp`;
        spaceStorage.set(`${spaceId}:${rollbackToken}`, { buffer: existing.buffer, mtimeMs: existing.mtimeMs });
      }

      const now = Date.now();
      spaceStorage.set(targetKey, { buffer: staged.buffer, mtimeMs: now });

      return {
        op: 'write',
        path: req.path,
        type: 'file',
        size: staged.buffer.length,
        mtimeMs: now,
        etag: computeEtag(staged.buffer),
        rollbackToken,
      };
    },

    async finalizeStage(
      userId: string,
      spaceId: string,
      req: any
    ): Promise<void> {
      if (req.rollbackToken) {
        spaceStorage.delete(`${spaceId}:${req.rollbackToken}`);
      }
    },

    async rollbackCommit(
      userId: string,
      spaceId: string,
      req: any
    ): Promise<void> {
      const targetKey = `${spaceId}:${req.path}`;
      if (req.rollbackToken) {
        const backup = spaceStorage.get(`${spaceId}:${req.rollbackToken}`);
        if (backup) {
          spaceStorage.set(targetKey, backup);
          spaceStorage.delete(`${spaceId}:${req.rollbackToken}`);
        }
      }
    },

    async readBinaryStream(
      userId: string,
      spaceId: string,
      req: CanonicalStreamingReadRequest
    ): Promise<CanonicalStreamingReadResult> {
      const storageKey = `${spaceId}:${req.path}`;
      const existing = spaceStorage.get(storageKey);
      if (!existing) {
        throw new NotFoundError(`File "${req.path}" not found`);
      }

      const fullBuf = existing.buffer;
      let streamBuf = fullBuf;
      let range = req.range;

      if (range) {
        streamBuf = fullBuf.subarray(range.start, range.end + 1);
      }

      return {
        op: 'read',
        path: req.path,
        type: 'file',
        size: streamBuf.length,
        totalSize: fullBuf.length,
        mtimeMs: existing.mtimeMs,
        etag: computeEtag(fullBuf),
        range,
        stream: Readable.from([streamBuf]),
      };
    },

    async abortStage(
      userId: string,
      spaceId: string,
      req: any
    ): Promise<void> {
      if (req.stageToken) {
        spaceStorage.delete(`${spaceId}:${req.stageToken}`);
      }
    },

    async readGlobalInstructions(
      userId: string
    ): Promise<{ content: string; etag: string | null; size: number; mtimeMs: number; exists: boolean }> {
      const storageKey = `global:${userId}:AGENTS.md`;
      const existing = spaceStorage.get(storageKey);
      if (!existing) {
        return {
          content: '',
          etag: null,
          size: 0,
          mtimeMs: 0,
          exists: false,
        };
      }
      const content = existing.buffer.toString('utf8');
      return {
        content,
        etag: computeEtag(existing.buffer),
        size: existing.buffer.length,
        mtimeMs: existing.mtimeMs,
        exists: true,
      };
    },

    async writeGlobalInstructions(
      userId: string,
      content: string,
      options?: { expectedEtag?: string | null; requireAbsent?: boolean }
    ): Promise<{ etag: string; size: number; mtimeMs: number }> {
      const storageKey = `global:${userId}:AGENTS.md`;
      const existing = spaceStorage.get(storageKey);
      const normalized = content.normalize('NFC');
      const buf = Buffer.from(normalized, 'utf8');

      if (options?.requireAbsent && existing) {
        throw new PlatformError('File already exists', 'CONFLICT', 409);
      }
      if (options?.expectedEtag) {
        if (!existing) {
          throw new PlatformError('Precondition failed (file missing)', 'CONFLICT', 409);
        }
        const currentEtag = computeEtag(existing.buffer);
        if (currentEtag !== options.expectedEtag) {
          throw new PlatformError('Precondition failed (ETag mismatch)', 'CONFLICT', 409);
        }
      }

      const now = Date.now();
      spaceStorage.set(storageKey, { buffer: buf, mtimeMs: now });
      return {
        etag: computeEtag(buf),
        size: buf.length,
        mtimeMs: now,
      };
    },
  };
}

export interface TestPlatformServerOptions {
  dbPath?: string;
  database?: DatabaseSync;
  csrfToken?: string;
  cookieSecret?: string;
  autoReply?: boolean;
  autoReplyDelayMs?: number;
  customResponder?: (envelope: InboundEnvelope, turnId: string) => Promise<{ content: string; error?: string }>;
  managementProvider?: ManagementRuntimeProvider;
  fileProvider?: TenantRuntimeFileProvider;
  stagedImportsDir?: string;
  allowlistedImportRoots?: readonly string[];
  externalInteractionService?: any;
  gitSourcePolicy?: any;
}

export interface RunningTestServer {
  server: PlatformServer;
  storage: SqlitePlatformStorage;
  messageStore: SqliteWebMessageStore;
  runtimeGateway: TestOnlyContractRuntimeGateway;
  authService: DefaultAuthService;
  fileProvider: TenantRuntimeFileProvider;
  db: DatabaseSync;
  url: string;
  port: number;
  csrfToken: string;
  fixtures: FixtureProvisionResult;
  stop(): Promise<void>;
}

export type TestPlatformServerHandle = RunningTestServer;

export async function createAndStartTestPlatformServer(
  options: TestPlatformServerOptions = {}
): Promise<RunningTestServer> {
  const dbPath = options.dbPath ?? ':memory:';
  const db = options.database ?? new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  } catch {}

  // 1. Initialize storage and stores
  const storage = new SqlitePlatformStorage(db);
  const messageStore = new SqliteWebMessageStore(db);
  const fileProvider = options.fileProvider ?? createMockFileProvider();

  // 2. Initialize in-process TestOnly Fake Runtime Gateway
  const runtimeGateway = new TestOnlyContractRuntimeGateway({
    storage,
    messageStore,
    fileProvider,
    autoReply: options.autoReply ?? true,
    autoReplyDelayMs: options.autoReplyDelayMs ?? 20,
    customResponder: options.customResponder,
  });

  // 3. Initialize Auth Service
  const cookieSecret = options.cookieSecret ?? TEST_COOKIE_SECRET;
  const csrfToken = options.csrfToken ?? TEST_CSRF_TOKEN;

  const authService = new DefaultAuthService(storage, {
    cookieSecret,
    cookieSecure: false,
    cookieSameSite: 'Strict',
    cookieName: 'enkeep_session',
  });

  // 4. Initialize and start PlatformServer on 127.0.0.1:0
  const server = new PlatformServer({
    database: db,
    storage,
    authService,
    cookieSecret,
    runtimeGateway,
    csrfToken,
    quotaDefaults: TEST_TENANT_QUOTA_DEFAULTS,
    managementProvider: options.managementProvider,
    fileProvider,
    stagedImportsDir: options.stagedImportsDir,
    allowlistedImportRoots: options.allowlistedImportRoots,
    externalInteractionService: options.externalInteractionService,
    gitSourcePolicy: options.gitSourcePolicy,
    mountReconciler: new DefaultRuntimeMountReconciler({
      preflight: async (p) => ({ realPath: p }),
      reconcile: async () => {},
    }),
    host: '127.0.0.1',
    port: 0,
    autoRecover: true,
  });

  const address = await server.start();

  // 5. Seed default fixture accounts (Alice admin, Bob user, Charlie disabled)
  const fixtures = await provisionFixtures(storage, authService, {
    adminPassword: 'AliceSecurePass123!',
    userPassword: 'BobSecurePass123!',
    disabledPassword: 'CharlieDisabledPass123!',
  });

  // Seed quota limits for all test users
  try {
    const allUsers = await storage.users.list();
    for (const u of allUsers) {
      const q = server.operationsService.forTenant(u.id).quota;
      await q.setLimit({ resource: 'storage_bytes', limit: 104857600 });
      await q.setLimit({ resource: 'tokens', limit: 65536 });
      await q.setLimit({ resource: 'messages', limit: 1000 });
      await q.setLimit({ resource: 'turns', limit: 500 });
      await q.setLimit({ resource: 'api_calls', limit: 5000 });
    }
  } catch {}

  return {
    server,
    storage,
    messageStore,
    runtimeGateway,
    authService,
    fileProvider,
    db,
    url: address.url,
    port: address.port,
    csrfToken,
    fixtures,
    stop: async () => {
      runtimeGateway.clearPending();
      await server.stop();
    },
  };
}
