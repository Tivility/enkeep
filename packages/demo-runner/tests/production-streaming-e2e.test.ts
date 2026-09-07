import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, readFileSync, globSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  bootDshRuntime,
  createPlatformProxyHandler,
  createEventsStreamHandler,
  loadDshDeploymentConfig,
  type DshBootedRuntime,
} from '@enkeep/runtime-runner';
import { SqliteWebMessageStore } from '@enkeep/platform-server';
import { SqlitePlatformWebApiAdapter } from '@enkeep/platform-server';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { DeliveryRuntimeGateway } from '@enkeep/platform-server';

const ALICE_PLATFORM_ID = '55555555-5555-4555-8555-555555555555';

describe('Production End-to-End Streaming Chain (AgentLoop -> EventRelay -> Tunnel -> web_events -> PollEvents)', () => {
  let tempDir: string;
  let dbPath: string;
  let db: DatabaseSync;
  let messageStore: SqliteWebMessageStore;
  let storage: SqlitePlatformStorage;
  let api: SqlitePlatformWebApiAdapter;
  let runtime: DshBootedRuntime;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `enkeep-stream-e2e-${randomUUID()}`);
    mkdirSync(join(tempDir, 'dsh', 'data'), { recursive: true });
    mkdirSync(join(tempDir, 'spaces'), { recursive: true });
    dbPath = join(tempDir, 'platform.db');

    db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL DEFAULT 'hash',
        role TEXT NOT NULL DEFAULT 'user',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );
      CREATE TABLE spaces (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        folder TEXT NOT NULL DEFAULT 'default',
        execution_mode TEXT NOT NULL DEFAULT 'container',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );
      CREATE TABLE session_routes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        channel TEXT NOT NULL DEFAULT 'web',
        account_id TEXT NOT NULL DEFAULT 'acc',
        native_context_id TEXT NOT NULL,
        peer_id TEXT NOT NULL DEFAULT 'peer',
        dsh_session_id TEXT NOT NULL,
        execution_mode TEXT NOT NULL DEFAULT 'container',
        status TEXT NOT NULL DEFAULT 'active',
        title TEXT,
        current_generation INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );
      CREATE TABLE session_generations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session_routes(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL,
        reset_reason TEXT,
        is_current INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );
      CREATE TABLE turn_runs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        route_id TEXT NOT NULL REFERENCES session_routes(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        started_at TEXT,
        finished_at TEXT,
        error TEXT,
        execution_mode TEXT NOT NULL DEFAULT 'container',
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        UNIQUE(user_id, route_id, turn_id)
      );
      CREATE TABLE delivery_inbox (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        route_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'processing',
        payload TEXT,
        error TEXT,
        turn_id TEXT,
        received_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        processed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );
      CREATE TABLE idempotency_records (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'processing',
        response_payload TEXT,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );
      CREATE TABLE web_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'delivered',
        route_key TEXT NOT NULL,
        turn_id TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );
      CREATE TABLE web_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );
      CREATE INDEX IF NOT EXISTS idx_web_events_session_id ON web_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_web_events_user_id ON web_events(user_id);
      CREATE INDEX IF NOT EXISTS idx_web_events_created_at ON web_events(created_at);
    `);

    db.prepare(`INSERT INTO users (id, username) VALUES ('${ALICE_PLATFORM_ID}', 'alice')`).run();
    db.prepare(`INSERT INTO spaces (id, user_id, name) VALUES ('spc_1', '${ALICE_PLATFORM_ID}', 'Main')`).run();
    db.prepare(`INSERT INTO session_routes (id, user_id, space_id, native_context_id, dsh_session_id) VALUES ('ses_1', '${ALICE_PLATFORM_ID}', 'spc_1', 'ses_1', 'ses_00000000000000000000000000000001')`).run();

    messageStore = new SqliteWebMessageStore(db);
    storage = new SqlitePlatformStorage(db);
    api = new SqlitePlatformWebApiAdapter({
      db,
      storage,
      messageStore,
    });
  });

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
    }
    try {
      db.close();
    } catch {}
    try {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {}
  });

  it('runs real AgentLoop turn with deterministic chunk delays, streams deltas into web_events, and pollEvents observes >= 2 deltas with TTFT < Final', async () => {
    // 1. Setup mock PlatformProxyHandler attached to platform database
    const platformHandler = createPlatformProxyHandler({
      platformUserId: ALICE_PLATFORM_ID,
      runtimeIdentity: 'alice',
      db,
    });

    const mockRequest = async (path: string, options?: any) => {
      if (path.includes('/events') && options?.body) {
        const stream = {
          write: () => true,
          end: () => {},
          destroy: () => {},
          writableEnded: false,
        } as any;
        await (platformHandler as any).handlePublishEvents(
          {
            method: 'POST',
            url: path,
            headers: {},
            body: Buffer.from(typeof options.body === 'string' ? options.body : JSON.stringify(options.body), 'utf8'),
          },
          stream
        );
      }
      return { status: 200, data: { success: true } };
    };

    // 2. Boot official DSH runtime with mock platformClient and deterministic demo adapter with 50ms chunk delay
    runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: join(tempDir, 'dsh'),
      spacesDir: join(tempDir, 'spaces'),
      llmEnabled: false,
      chunkDelayMs: 50,
      platformClient: {
        request: mockRequest,
      },
    } as any);

    const sessionId = 'ses_1';
    const dshSessionId = 'ses_00000000000000000000000000000001';
    const turnId = 'turn_00000000000000000000000000000001';
    const deliveryId = 'del_00000000000000000000000000000001';
    const idempotencyKey = randomUUID();

    // 3. Setup DeliveryRuntimeGateway with real DSH turn execution
    const gateway = new DeliveryRuntimeGateway({
      database: db,
      storage,
      messageStore,
      executor: {
        execute: async (req: any) => {
          const result = await runtime.sendFollowup(req.content, req.dshSessionId, req.turnId);
          return {
            replyText: result.replyText || 'fallback',
            usage: result.usage,
          };
        },
        cancel: async (_cancelUserId, cancelSessionId) => {
          return runtime.cancelTurn(cancelSessionId);
        },
      },
      quotaMode: 'disabled',
      profileResolver: {
        resolve: async () => null,
      },
    });

    const startTime = Date.now();

    // 4. Dispatch inbound message
    const dispatchResult = await gateway.dispatchInbound({
      id: deliveryId,
      userId: ALICE_PLATFORM_ID,
      sessionId,
      content: 'Explain quantum computing step by step.',
      timestamp: new Date().toISOString(),
    });

    expect(dispatchResult.accepted).toBe(true);

    // 5. Concurrently poll /events while turn is executing in background worker
    const observedEvents: any[] = [];
    let firstDeltaTime: number | null = null;
    let finalMessageTime: number | null = null;
    let pollCursor: string | undefined = undefined;

    const pollDeadline = Date.now() + 10000;
    while (Date.now() < pollDeadline) {
      const pollRes = await api.pollEvents(ALICE_PLATFORM_ID, sessionId, pollCursor);
      if (pollRes.nextCursor) {
        pollCursor = pollRes.nextCursor;
      }
      for (const ev of pollRes.events) {
        observedEvents.push(ev);
        const now = Date.now();
        if (ev.type === 'assistant_delta') {
          if (firstDeltaTime === null) {
            firstDeltaTime = now;
          }
        }
        if (ev.type === 'message' && (ev as any).message?.role === 'assistant') {
          finalMessageTime = now;
        }
      }

      if (finalMessageTime !== null) {
        break;
      }
      await new Promise((r) => setTimeout(r, 60));
    }

    // Await gateway worker completion
    await gateway.drain(5000);

    // 6. Assertions on streaming events in web_events & poll output
    const deltas = observedEvents.filter((e) => e.type === 'assistant_delta');
    expect(deltas.length).toBeGreaterThanOrEqual(2);

    // StreamId and accumulated length check
    expect(deltas[0].streamId).toMatch(/^msgstream_[0-9a-f]{32}$/);
    expect(deltas[0].accumulatedLength).toBeGreaterThan(0);
    expect(deltas[1].accumulatedLength).toBeGreaterThan(deltas[0].accumulatedLength);

    // Final authoritative assistant message check
    const finalMsgEvent = observedEvents.find((e) => e.type === 'message' && e.message?.role === 'assistant');
    expect(finalMsgEvent).toBeDefined();

    // TTFT Latency assertion: First delta arrived strictly before final message completion
    expect(firstDeltaTime).not.toBeNull();
    expect(finalMessageTime).not.toBeNull();
    expect(firstDeltaTime!).toBeLessThan(finalMessageTime!);

    // 7. Authoritative Diagnostics & Persistent Session JSONL Verification
    const relayDiag = (runtime.context as any).eventRelay?.getDiagnostics();
    expect(relayDiag?.ingestedEventTypes?.['assistant/chunk']).toBeGreaterThanOrEqual(2);
    expect(relayDiag?.ingestedEventTypes?.['turn/start']).toBeGreaterThanOrEqual(1);

    const sessionFiles = globSync('**/*.jsonl', { cwd: join(tempDir, 'dsh', 'sessions') });
    expect(sessionFiles.length).toBeGreaterThanOrEqual(1);
    const jsonlContent = readFileSync(join(tempDir, 'dsh', 'sessions', sessionFiles[0]), 'utf8');
    const jsonlLines = jsonlContent.trim().split('\n').map((l) => JSON.parse(l));
    const jsonlChunks = jsonlLines.filter((e) => e.type === 'assistant/chunk');
    expect(jsonlChunks.length).toBeGreaterThanOrEqual(2);

    const ttftMs = firstDeltaTime! - startTime;
    const totalMs = finalMessageTime! - startTime;
    console.log(`[Production E2E Streaming Evidence] Deltas: ${deltas.length}, TTFT: ${ttftMs}ms, Total: ${totalMs}ms`);
  });

  const localConfig = loadDshDeploymentConfig();
  const hasLocalConfigAndToken = Boolean(
    localConfig &&
    localConfig.providers &&
    (localConfig.providers['cpa-gemini'] || localConfig.providers['cpa-claude']) &&
    localConfig.tokens['CPA_TOKEN'] &&
    localConfig.tokens['CPA_TOKEN'].trim().length > 0
  );

  it.skipIf(!hasLocalConfigAndToken)(
    'runs real AsterGate LLM stream through AgentLoop -> EventRelay -> web_events -> pollEvents with real token deltas',
    async () => {
      const activeProvider = localConfig?.providers['cpa-gemini'] ? 'cpa-gemini' : 'cpa-claude';
      const activeModel = activeProvider === 'cpa-gemini' ? 'gemini-3.7-flash-tiered' : 'claude-fable-5';

      // Setup live LlmProxyHandler server to proxy real AsterGate gateway requests
      const proxyHandler = (await import('@enkeep/runtime-runner')).createLlmProxyHandler({ deploymentConfig: localConfig });
      const http = await import('node:http');

      const llmServer = http.createServer((req, res) => {
        proxyHandler.handleHttpRequest(req, res);
      });

      const llmPort = await new Promise<number>((resolve) => {
        llmServer.listen(0, '127.0.0.1', () => {
          const addr = llmServer.address();
          resolve(typeof addr === 'object' && addr ? addr.port : 0);
        });
      });

      try {
        // 1. Setup mock PlatformProxyHandler attached to platform database
        const platformHandler = createPlatformProxyHandler({
          platformUserId: ALICE_PLATFORM_ID,
          runtimeIdentity: 'alice',
          db,
        });

        const mockRequest = async (path: string, options?: any) => {
          if (path.includes('/events') && options?.body) {
            const stream = {
              write: () => true,
              end: () => {},
              destroy: () => {},
              writableEnded: false,
            } as any;
            await (platformHandler as any).handlePublishEvents(
              {
                method: 'POST',
                url: path,
                headers: {},
                body: Buffer.from(typeof options.body === 'string' ? options.body : JSON.stringify(options.body), 'utf8'),
              },
              stream
            );
          }
          return { status: 200, data: { success: true } };
        };

        // 2. Boot official DSH runtime with real LLM provider pointing to llmServer
        runtime = await bootDshRuntime({
          userId: 'alice',
          dshHome: join(tempDir, 'dsh'),
          spacesDir: join(tempDir, 'spaces'),
          llmEnabled: true,
          provider: activeProvider,
          model: activeModel,
          llmBaseUrl: `http://127.0.0.1:${llmPort}/llm`,
          providers: {
            [activeProvider]: {
              ...localConfig!.providers[activeProvider],
              baseURL: `http://127.0.0.1:${llmPort}/llm/${activeProvider}`,
              apiKeyEnv: 'IN_CONTAINER_PLACEHOLDER',
            },
          },
          platformClient: {
            request: mockRequest,
          },
        } as any);

        const sessionId = 'ses_1';
        const deliveryId = 'del_live_000000000000000000000000001';

        const gateway = new DeliveryRuntimeGateway({
          database: db,
          storage,
          messageStore,
          executor: {
            execute: async (req: any) => {
              const result = await runtime.sendFollowup(req.content, req.dshSessionId, req.turnId);
              return {
                replyText: result.replyText || 'fallback',
                usage: result.usage,
              };
            },
            cancel: async (_cancelUserId, cancelSessionId) => {
              return runtime.cancelTurn(cancelSessionId);
            },
          },
          quotaMode: 'disabled',
          profileResolver: {
            resolve: async () => null,
          },
        });

        const startTime = Date.now();

        await gateway.dispatchInbound({
          id: deliveryId,
          userId: ALICE_PLATFORM_ID,
          sessionId,
          content: 'Count numbers 1 to 5 and explain each briefly.',
          timestamp: new Date().toISOString(),
        });

        const observedEvents: any[] = [];
        let firstDeltaTime: number | null = null;
        let finalMessageTime: number | null = null;
        let pollCursor: string | undefined = undefined;

        const pollDeadline = Date.now() + 25000;
        while (Date.now() < pollDeadline) {
          const pollRes = await api.pollEvents(ALICE_PLATFORM_ID, sessionId, pollCursor);
          if (pollRes.nextCursor) {
            pollCursor = pollRes.nextCursor;
          }
          for (const ev of pollRes.events) {
            observedEvents.push(ev);
            const now = Date.now();
            if (ev.type === 'assistant_delta') {
              if (firstDeltaTime === null) {
                firstDeltaTime = now;
              }
            }
            if (ev.type === 'message' && (ev as any).message?.role === 'assistant') {
              finalMessageTime = now;
            }
          }

          if (finalMessageTime !== null) {
            break;
          }
          await new Promise((r) => setTimeout(r, 60));
        }

        await gateway.drain(10000);

        const deltas = observedEvents.filter((e) => e.type === 'assistant_delta');
        expect(deltas.length).toBeGreaterThanOrEqual(1);

        const finalMsgEvent = observedEvents.find((e) => e.type === 'message' && e.message?.role === 'assistant');
        expect(finalMsgEvent).toBeDefined();

        // Authoritative Diagnostics & Persistent Session JSONL Verification for real LLM stream
        const relayDiag = (runtime.context as any).eventRelay?.getDiagnostics();
        expect(relayDiag?.ingestedEventTypes?.['assistant/chunk']).toBeGreaterThanOrEqual(1);

        const sessionFiles = globSync('**/*.jsonl', { cwd: join(tempDir, 'dsh', 'sessions') });
        expect(sessionFiles.length).toBeGreaterThanOrEqual(1);
        const jsonlContent = readFileSync(join(tempDir, 'dsh', 'sessions', sessionFiles[0]), 'utf8');
        const jsonlLines = jsonlContent.trim().split('\n').map((l) => JSON.parse(l));
        const jsonlChunks = jsonlLines.filter((e) => e.type === 'assistant/chunk');
        expect(jsonlChunks.length).toBeGreaterThanOrEqual(1);

        if (firstDeltaTime !== null && finalMessageTime !== null) {
          expect(firstDeltaTime).toBeLessThanOrEqual(finalMessageTime);
          const liveTtft = firstDeltaTime - startTime;
          const liveTotal = finalMessageTime - startTime;
          console.log(`[Live Production AsterGate E2E Evidence] Deltas: ${deltas.length}, TTFT: ${liveTtft}ms, Total: ${liveTotal}ms`);
        }
      } finally {
        await new Promise<void>((resolve) => llmServer.close(() => resolve()));
      }
    },
    30000
  );
});
