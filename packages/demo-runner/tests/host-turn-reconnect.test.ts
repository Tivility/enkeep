import { describe, it, expect, vi } from 'vitest';
import { isHostTransportDrop, sendTurnWithHostReconnect } from '../src/up/index.js';

function dropError(): Error {
  const err = new Error('Host daemon error: Host daemon transport disconnected while turn was executing');
  err.name = 'HostRuntimeExitedError';
  return err;
}

const okResult = { status: 'completed', replyText: 'ok', persisted: true } as any;

function handle(sendTurn: (...args: any[]) => any, journal: string = 'absent') {
  return {
    sendTurn: vi.fn(sendTurn),
    inspectTurnResult: vi.fn(async () => ({ status: journal })),
  } as any;
}

describe('host turn dispatch across a dropped connection', () => {
  it('classifies host transport drops and nothing else', () => {
    expect(isHostTransportDrop(dropError())).toBe(true);
    expect(isHostTransportDrop(new Error('400 invalid_request_error'))).toBe(false);
    expect(isHostTransportDrop('not an error')).toBe(false);
  });

  it('resubmits once on a fresh connection when the turn never started', async () => {
    const stale = handle(async () => { throw dropError(); });
    const fresh = handle(async () => okResult, 'absent');
    const res = await sendTurnWithHostReconnect(stale, { turnId: 'turn_1' } as any, {
      isHost: true,
      turnId: 'turn_1',
      reconnect: async () => fresh,
    });
    expect(res).toBe(okResult);
    expect(fresh.inspectTurnResult).toHaveBeenCalledWith('turn_1');
    expect(fresh.sendTurn).toHaveBeenCalledTimes(1);
  });

  it('does not resubmit a turn the runtime already started', async () => {
    for (const journal of ['running', 'completed', 'failed']) {
      const stale = handle(async () => { throw dropError(); });
      const fresh = handle(async () => okResult, journal);
      await expect(
        sendTurnWithHostReconnect(stale, {} as any, { isHost: true, turnId: 'turn_2', reconnect: async () => fresh })
      ).rejects.toThrow('transport disconnected');
      expect(fresh.sendTurn).not.toHaveBeenCalled();
    }
  });

  it('leaves other failures and container runtimes untouched', async () => {
    const reconnect = vi.fn();
    const modelError = handle(async () => { throw new Error('400 invalid_request_error'); });
    await expect(
      sendTurnWithHostReconnect(modelError, {} as any, { isHost: true, turnId: 't', reconnect })
    ).rejects.toThrow('400');
    const container = handle(async () => { throw dropError(); });
    await expect(
      sendTurnWithHostReconnect(container, {} as any, { isHost: false, turnId: 't', reconnect })
    ).rejects.toThrow('transport disconnected');
    expect(reconnect).not.toHaveBeenCalled();
  });
});
