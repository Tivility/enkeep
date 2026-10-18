import { describe, it, expect } from 'vitest';
import { CredentialedLarkTransport, type LarkSdkClientFactory } from '../src/transport.js';

type WsState = 'connected' | 'reconnecting' | 'failed' | 'idle';

/** Fake SDK boundary whose websocket clients report a controllable connection state. */
function makeFactory() {
  const clients: Array<{ state: WsState; closed: boolean }> = [];
  const factory: LarkSdkClientFactory = {
    createClient: () => ({}),
    createWSClient: () => {
      const record = { state: 'idle' as WsState, closed: false };
      clients.push(record);
      return {
        getConnectionStatus: () => ({ state: record.state, reconnectAttempts: 0 }),
        start: async () => {
          record.state = 'connected';
        },
        close: async () => {
          record.closed = true;
        },
      };
    },
  };
  return { factory, clients };
}

function makeTransport(factory: LarkSdkClientFactory) {
  return new CredentialedLarkTransport({
    account: {
      id: 'acc_test_ws_1',
      userId: 'user-alice',
      appId: 'cli_test0000000000001',
      appSecret: 'test-secret',
      botOpenId: 'ou_test0000000000000000000000000001',
      brand: 'feishu',
    },
    clientFactory: factory,
  });
}

describe('Lark websocket watchdog', () => {
  it('recreates the websocket client after the SDK gives up reconnecting', async () => {
    const { factory, clients } = makeFactory();
    const transport = makeTransport(factory);
    await transport.start();
    expect(clients).toHaveLength(1);

    // The SDK exhausted its reconnect budget (e.g. a long network outage).
    clients[0].state = 'failed';
    await transport.checkWsHealth(1_000_000);

    expect(clients[0].closed).toBe(true);
    expect(clients).toHaveLength(2);
    expect(transport.connected).toBe(true);

    await transport.stop();
  });

  it('leaves the SDK alone while it is still reconnecting, and restarts a client stuck idle', async () => {
    const { factory, clients } = makeFactory();
    const transport = makeTransport(factory);
    await transport.start();

    clients[0].state = 'reconnecting';
    await transport.checkWsHealth(1_000_000);
    await transport.checkWsHealth(1_060_000);
    expect(clients).toHaveLength(1);

    clients[0].state = 'idle';
    await transport.checkWsHealth(1_120_000);
    expect(clients).toHaveLength(1); // one idle observation is not enough
    await transport.checkWsHealth(1_180_000);
    expect(clients).toHaveLength(2);

    await transport.stop();
  });

  it('backs off between consecutive restarts and stops after stop()', async () => {
    const { factory, clients } = makeFactory();
    const transport = makeTransport(factory);
    await transport.start();

    clients[0].state = 'failed';
    await transport.checkWsHealth(1_000_000);
    expect(clients).toHaveLength(2);

    // The new client fails again immediately: the next restart waits for the backoff.
    clients[1].state = 'failed';
    await transport.checkWsHealth(1_010_000);
    expect(clients).toHaveLength(2);
    await transport.checkWsHealth(1_031_000);
    expect(clients).toHaveLength(3);

    await transport.stop();
    clients[2].state = 'failed';
    await transport.checkWsHealth(9_000_000);
    expect(clients).toHaveLength(3);
  });
});
