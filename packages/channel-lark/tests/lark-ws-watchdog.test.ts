import { describe, it, expect } from 'vitest';
import { CredentialedLarkTransport, type LarkSdkClientFactory } from '../src/transport.js';

type WsState = 'connected' | 'reconnecting' | 'failed' | 'idle';

/** Fake SDK boundary whose websocket clients report a controllable connection state. */
function makeFactory() {
  const clients: Array<{
    state: WsState;
    closed: boolean;
    forceClosed?: boolean;
    options: any;
    triggerReady: () => void;
  }> = [];
  const factory: LarkSdkClientFactory = {
    createClient: () => ({}),
    createWSClient: (options) => {
      const record = {
        state: 'idle' as WsState,
        closed: false,
        forceClosed: false,
        options,
        triggerReady: () => {
          if (options?.onReady) {
            options.onReady();
          }
        },
      };
      clients.push(record);
      return {
        getConnectionStatus: () => ({ state: record.state, reconnectAttempts: 0 }),
        start: async () => {
          record.state = 'connected';
        },
        close: async (closeOpts?: { force?: boolean }) => {
          record.closed = true;
          if (closeOpts?.force) {
            record.forceClosed = true;
          }
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

  it('passes pingTimeout: 10 to wsConfig and force-closes late ready client after stop()', async () => {
    const { factory, clients } = makeFactory();
    const transport = makeTransport(factory);
    await transport.start();
    expect(clients).toHaveLength(1);
    expect(clients[0].options?.wsConfig).toEqual({ pingTimeout: 10 });

    await transport.stop();
    expect(transport.connected).toBe(false);

    // Simulate delayed onReady arriving after transport has been stopped
    clients[0].triggerReady();
    expect(clients[0].forceClosed).toBe(true);
    expect(transport.connected).toBe(false);
  });

  it('force-closes retired client when late onReady fires after watchdog restart', async () => {
    const { factory, clients } = makeFactory();
    const transport = makeTransport(factory);
    await transport.start();
    expect(clients).toHaveLength(1);
    const clientA = clients[0];

    // Trigger watchdog restart: clientA fails and is replaced by clientB
    clientA.state = 'failed';
    await transport.checkWsHealth(1_000_000);
    expect(clients).toHaveLength(2);
    const clientB = clients[1];

    // Late onReady arrives on retired clientA
    clientA.triggerReady();
    expect(clientA.forceClosed).toBe(true);

    // clientB finishes ready normally and becomes connected
    clientB.triggerReady();
    expect(clientB.forceClosed).toBe(false);
    expect(transport.connected).toBe(true);

    await transport.stop();
  });
});
