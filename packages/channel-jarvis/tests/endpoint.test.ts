import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JARVIS_RUNTIME_PATH, JARVIS_SUBPROTOCOL, createJarvisEndpoint, type JarvisConnection, type JarvisEndpoint } from '../src/endpoint.js';
import { JarvisRuntime } from '../src/runtime.js';
import { FakeSource, SESSION_A, row, waitFor } from './helpers.js';

const GOOD_TOKEN = 'test-token-alice-0000000000000000';
const ALICE = { accountId: 'jca_00000000000000000000000000000001', userId: 'user-alice' };

let server: Server;
let endpoint: JarvisEndpoint;
let port: number;
let connections: JarvisConnection[];
let tokensSeen: string[];

beforeEach(async () => {
  connections = [];
  tokensSeen = [];
  endpoint = createJarvisEndpoint({
    authenticate: async (token) => {
      tokensSeen.push(token);
      return token === GOOD_TOKEN ? ALICE : null;
    },
    onConnection: (connection) => {
      connections.push(connection);
      const source = new FakeSource();
      source.rows = [row(SESSION_A, 'idle')];
      void new JarvisRuntime(connection.socket, source, { version: '0.0.0-test', log: {} }).start();
    },
  });
  server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== JARVIS_RUNTIME_PATH) return socket.destroy();
    void endpoint.handleUpgrade(req, socket, head);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  endpoint.closeAll();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A raw upgrade attempt; resolves with the HTTP status (101 when upgraded). */
function upgradeStatus(headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path: JARVIS_RUNTIME_PATH,
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

const goodHeaders = { Authorization: `Bearer ${GOOD_TOKEN}`, 'Sec-WebSocket-Protocol': JARVIS_SUBPROTOCOL };

interface Client {
  ws: WebSocket;
  frames: Array<Record<string, unknown>>;
  closed: Promise<{ code: number; reason: string }>;
}

function connect(token = GOOD_TOKEN): Client {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${JARVIS_RUNTIME_PATH}`, {
    protocols: [JARVIS_SUBPROTOCOL],
    headers: { Authorization: `Bearer ${token}` },
  } as unknown as string[]);
  const frames: Array<Record<string, unknown>> = [];
  ws.addEventListener('message', (e) => {
    const frame = JSON.parse(String(e.data)) as Record<string, unknown>;
    frames.push(frame);
    if (frame.method === 'runtime.hello') {
      ws.send(JSON.stringify({ id: frame.id, result: { protocol: 1, node_version: '0.0.0-test', hub: true, features: [] } }));
    }
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason })),
  );
  return { ws, frames, closed };
}

describe('Jarvis endpoint', () => {
  it('refuses a request carrying Origin with 403', async () => {
    expect(await upgradeStatus({ ...goodHeaders, Origin: 'http://127.0.0.1:1' })).toBe(403);
    expect(tokensSeen).toEqual([]);
  });

  it('refuses a missing or unknown token with 401', async () => {
    expect(await upgradeStatus({ 'Sec-WebSocket-Protocol': JARVIS_SUBPROTOCOL })).toBe(401);
    expect(await upgradeStatus({ Authorization: 'Bearer wrong-token', 'Sec-WebSocket-Protocol': JARVIS_SUBPROTOCOL })).toBe(401);
    expect(await upgradeStatus({ Authorization: `Basic ${GOOD_TOKEN}`, 'Sec-WebSocket-Protocol': JARVIS_SUBPROTOCOL })).toBe(401);
  });

  it('refuses a missing subprotocol with 400', async () => {
    expect(await upgradeStatus({ Authorization: `Bearer ${GOOD_TOKEN}` })).toBe(400);
    expect(await upgradeStatus({ Authorization: `Bearer ${GOOD_TOKEN}`, 'Sec-WebSocket-Protocol': 'other.v1' })).toBe(400);
    expect(connections).toEqual([]);
  });

  it('runs the validate hook first', async () => {
    endpoint.closeAll();
    endpoint = createJarvisEndpoint({
      authenticate: async () => ALICE,
      onConnection: () => undefined,
      validate: (req) => (req.headers.host === `127.0.0.1:${port}` ? 421 : null),
    });
    expect(await upgradeStatus(goodHeaders)).toBe(421);
  });

  it('upgrades a good request with the subprotocol; the runtime says hello first', async () => {
    expect(await upgradeStatus(goodHeaders)).toBe(101);
    const client = connect();
    await waitFor(() => client.frames.some((f) => f.event === 'runtime.sessions'));
    expect(client.ws.protocol).toBe(JARVIS_SUBPROTOCOL);
    expect(client.frames[0]).toMatchObject({ method: 'runtime.hello', params: { runtime: 'enkeep', agent: 'dsh' } });
    expect(client.frames.find((f) => f.event === 'runtime.sessions')!.params).toEqual({ sessions: [row(SESSION_A, 'idle')] });
    expect(connections.at(-1)).toMatchObject(ALICE);

    // Requests from the node are answered over the same socket.
    client.ws.send(JSON.stringify({ id: 'n1', method: 'session.nope', params: {} }));
    const answer = await waitFor(() => client.frames.find((f) => f.id === 'n1'));
    expect(answer.error).toMatchObject({ code: 'unsupported' });
    client.ws.close();
    await client.closed;
  });

  it('replaces the older connection of the same account', async () => {
    const first = connect();
    await waitFor(() => first.frames.some((f) => f.event === 'runtime.sessions'));
    const second = connect();
    await waitFor(() => second.frames.some((f) => f.event === 'runtime.sessions'));
    expect(await first.closed).toEqual({ code: 4000, reason: 'replaced' });
    expect(second.ws.readyState).toBe(WebSocket.OPEN);
    expect(endpoint.size).toBe(1);
    second.ws.close();
    await second.closed;
    await waitFor(() => endpoint.size === 0);
  });

  it('closes everything on closeAll and refuses later upgrades', async () => {
    const client = connect();
    await waitFor(() => client.frames.some((f) => f.event === 'runtime.sessions'));
    endpoint.closeAll();
    expect((await client.closed).code).toBe(1001);
    expect(await upgradeStatus(goodHeaders)).toBe(503);
  });
});
