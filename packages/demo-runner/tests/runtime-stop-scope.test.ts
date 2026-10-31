/**
 * Demo management provider stopRuntime: a mode-scoped stop (auto-upgrade) stops only that mode.
 */

import { describe, it, expect } from 'vitest';
import { stopUserRuntimeHandles } from '../src/up/runtime-stop.js';

function fakeHandle(name: string, events: string[]) {
  return {
    rawHandle: { pid: 42 },
    async stop() { events.push(`${name}:stop`); },
    async teardown(removeVolume?: boolean) { events.push(`${name}:teardown:${removeVolume === true}`); },
  };
}

function maps(events: string[]) {
  return {
    hostRuntimeHandles: new Map([['bob', fakeHandle('host', events)]]),
    runtimeHandles: new Map([['bob', fakeHandle('container', events)]]),
  };
}

const quiet = () => {};

describe('stopUserRuntimeHandles', () => {
  it('container mode (auto-upgrade rebuild) leaves the host runtime running', async () => {
    const events: string[] = [];
    const m = maps(events);
    const r = await stopUserRuntimeHandles(m, 'bob', 'container', quiet);
    expect(r).toMatchObject({ stopped: true, stoppedModes: ['container'] });
    expect(events).toEqual(['container:stop', 'container:teardown:false']);
    expect(m.hostRuntimeHandles.has('bob')).toBe(true);
    expect(m.runtimeHandles.has('bob')).toBe(false);
  });

  it('host mode leaves the container running; the -host alias resolves to the user', async () => {
    const events: string[] = [];
    const m = maps(events);
    const r = await stopUserRuntimeHandles(m, 'bob-host', 'host', quiet);
    expect(r).toMatchObject({ stopped: true, stoppedModes: ['host'], normalizedUserId: 'bob' });
    expect(events).toEqual(['host:stop', 'host:teardown:false']);
    expect(m.runtimeHandles.has('bob')).toBe(true);
  });

  it('no mode stops both (explicit stop), volumes kept', async () => {
    const events: string[] = [];
    const m = maps(events);
    const r = await stopUserRuntimeHandles(m, 'bob', undefined, quiet);
    expect(r.stoppedModes).toEqual(['host', 'container']);
    expect(events.filter((e) => e.includes('teardown'))).toEqual(['host:teardown:false', 'container:teardown:false']);
  });

  it('nothing to stop for the requested mode', async () => {
    const events: string[] = [];
    const m = { hostRuntimeHandles: new Map([['bob', fakeHandle('host', events)]]), runtimeHandles: new Map() };
    expect(await stopUserRuntimeHandles(m as any, 'bob', 'container', quiet)).toMatchObject({ stopped: false, stoppedModes: [] });
    expect(events).toEqual([]);
  });
});
