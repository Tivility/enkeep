/**
 * launchDemoSystem wires the Jarvis channel: the `jarvis` channel manager is registered, the
 * platform server upgrades `/api/jarvis/runtime`, each runtime transport is attached to the
 * session event hub (live pushes) and the turn executor reads session history from the runtime
 * handle. Offline: fake runtime adapter + fake daemon transport, platform on 127.0.0.1:0.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { resetDemo } from '../src/reset/index.js';
import { launchDemoSystem, type RunningDemoSystem } from '../src/up/index.js';
import type { UserRuntimeHandle } from '../src/ports/index.js';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';
import { FakeUnitRuntimeContainerAdapter } from './support/fake-runtime.js';

const SUBPROTOCOL = 'jarvis-runtime.v1';
const ROUTE = 'ses_000000000000000000000000000000c1';
const DSH = 'ses_000000000000000000000000000000d1';

class FakeDaemonTransport extends EventEmitter {
  isConnected(): boolean {
    return true;
  }
}

/** Fake adapter whose handles expose a daemon transport and the session history read op. */
class JarvisFakeAdapter extends FakeUnitRuntimeContainerAdapter {
  readonly transports = new Map<string, FakeDaemonTransport>();
  readonly reads: Array<Record<string, unknown>> = [];

  override async startUserRuntime(options: Parameters<FakeUnitRuntimeContainerAdapter['startUserRuntime']>[0]): Promise<UserRuntimeHandle> {
    const handle = await super.startUserRuntime(options);
    const transport = new FakeDaemonTransport();
    this.transports.set(options.userId, transport);
    (handle as any).rawHandle = {
      transport,
      readSessionEvents: async (params: Record<string, unknown>) => {
        this.reads.push(params);
        return {
          dshSessionId: params.sessionId,
          events: [
            { seq: 0, type: 'user/message', time: 1_000, data: { content: [{ type: 'text', text: 'synthetic question' }], source: { kind: 'user' } } },
            { seq: 1, type: 'assistant/message', time: 2_000, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'synthetic answer' }] } } },
          ],
          lastSeq: 1,
          persistedLastSeq: 1,
          hasMore: false,
        };
      },
    };
    return handle;
  }
}

async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function login(serverUrl: string, username: string, password: string) {
  const init = (await (await fetch(`${serverUrl}/api/auth/csrf`, { headers: { Origin: serverUrl } })).json()) as any;
  const res = await fetch(`${serverUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Enkeep-CSRF': init.data.csrfToken, Origin: serverUrl },
    body: JSON.stringify({ username, password }),
  });
  expect(res.ok).toBe(true);
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  const csrf = (await (await fetch(`${serverUrl}/api/auth/csrf`, { headers: { Cookie: cookie, Origin: serverUrl } })).json()) as any;
  return { cookie, csrfToken: csrf.data.csrfToken as string };
}

function upgradeStatus(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        ...headers,
      },
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('launchDemoSystem Jarvis wiring', () => {
  let tempRepo: TempRepo;
  let system: RunningDemoSystem | null = null;
  let ws: WebSocket | null = null;

  beforeEach(() => {
    tempRepo = createTempRepo();
  });

  afterEach(async () => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    ws = null;
    if (system) {
      await system.close({ removeVolumes: true });
      system = null;
    }
    tempRepo.cleanup();
  });

  it('registers the jarvis manager, upgrades /api/jarvis/runtime and serves history and live events', async () => {
    const reset = await resetDemo({ repoRoot: tempRepo.repoRoot });
    const adapter = new JarvisFakeAdapter();
    system = await launchDemoSystem({ repoRoot: tempRepo.repoRoot, runtimeAdapter: adapter });

    expect(system.jarvisRuntimeManager).toBeDefined();
    expect(system.platformServer.channelService.getSupportedTypes()).toContain('jarvis');
    const port = Number(new URL(system.platformUrl).port);
    expect(await upgradeStatus(port, '/api/jarvis/runtime', { 'Sec-WebSocket-Protocol': SUBPROTOCOL })).toBe(401);
    expect(await upgradeStatus(port, '/api/not-a-socket', { 'Sec-WebSocket-Protocol': SUBPROTOCOL })).toBe(404);

    const admin = await system.storage.users.findByUsername(reset.credentials.admin.username);
    expect(admin).toBeDefined();
    expect(system.sessionEventHub.hasTransport(admin!.id)).toBe(true);
    const spaces = await system.storage.forTenant(admin!.id).spaces.list();
    await system.storage.forTenant(admin!.id).sessionRoutes.create({
      id: ROUTE,
      spaceId: spaces[0]!.id,
      channel: 'web',
      nativeContextId: ROUTE,
      dshSessionId: DSH,
      title: 'Synthetic demo session',
    });

    const auth = await login(system.platformUrl, reset.credentials.admin.username, reset.credentials.admin.password);
    const created = await fetch(`${system.platformUrl}/api/manage/channels/accounts`, {
      method: 'POST',
      headers: { Cookie: auth.cookie, 'Content-Type': 'application/json', 'X-Enkeep-CSRF': auth.csrfToken, Origin: system.platformUrl },
      body: JSON.stringify({ type: 'jarvis' }),
    });
    expect(created.status).toBe(201);
    const token = ((await created.json()) as any).data.token as string;

    ws = new WebSocket(`ws://127.0.0.1:${port}/api/jarvis/runtime`, {
      protocols: [SUBPROTOCOL],
      headers: { Authorization: `Bearer ${token}` },
    } as unknown as string[]);
    const socket = ws;
    const frames: Array<Record<string, any>> = [];
    socket.addEventListener('message', (e) => {
      const frame = JSON.parse(String(e.data)) as Record<string, any>;
      frames.push(frame);
      if (frame.method === 'runtime.hello') {
        socket.send(JSON.stringify({ id: frame.id, result: { protocol: 1, node_version: '0.0.0-test', hub: true, features: [] } }));
      }
    });
    const sessions = await waitFor(() => frames.find((f) => f.event === 'runtime.sessions'));
    expect(sessions.params.sessions.map((s: any) => s.session_id)).toContain(ROUTE);

    // History comes from the runtime handle through the turn executor.
    socket.send(JSON.stringify({ id: 'n1', method: 'session.items', params: { session_id: ROUTE } }));
    const items = await waitFor(() => frames.find((f) => f.id === 'n1'));
    expect(items.result.history).toBe(`dsh:${DSH}`);
    expect(items.result.items.map((i: any) => [i.role, i.text])).toEqual([
      ['user', 'synthetic question'],
      ['assistant', 'synthetic answer'],
    ]);
    expect(adapter.reads[0]).toMatchObject({ sessionId: DSH });

    // Live events reach the node through the hub attached in bindRuntimeServices.
    socket.send(JSON.stringify({ id: 'n2', method: 'session.watch', params: { session_id: ROUTE, since_seq: 2 } }));
    await waitFor(() => frames.find((f) => f.id === 'n2'));
    const handle = system.runtimeHandles.get(admin!.id)!;
    adapter.transports.get(handle.userId)!.emit('stream', {
      type: 'event',
      event: 'turn/event',
      sessionId: DSH,
      turnId: '',
      seq: 2,
      timestamp: Date.now(),
      sessionEvent: { seq: 2, type: 'assistant/message', time: 3_000, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'live synthetic text' }] } } },
    });
    const pushed = await waitFor(() => frames.find((f) => f.event === 'session.items' && f.params.to_seq === 3));
    expect(pushed.params).toMatchObject({ session_id: ROUTE, from_seq: 2, to_seq: 3, history: `dsh:${DSH}` });
    expect(pushed.params.items[0]).toMatchObject({ role: 'assistant', text: 'live synthetic text' });
  });

  it('can be disabled', async () => {
    await resetDemo({ repoRoot: tempRepo.repoRoot });
    system = await launchDemoSystem({ repoRoot: tempRepo.repoRoot, runtimeAdapter: new JarvisFakeAdapter(), jarvisChannel: false });
    expect(system.jarvisRuntimeManager).toBeUndefined();
    expect(system.platformServer.channelService.getSupportedTypes()).not.toContain('jarvis');
    const port = Number(new URL(system.platformUrl).port);
    expect(await upgradeStatus(port, '/api/jarvis/runtime', { 'Sec-WebSocket-Protocol': SUBPROTOCOL })).toBe(404);
  });
});
