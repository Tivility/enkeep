/**
 * CompositeDeliveryTurnExecutor forwards the read-only history ops (Jarvis history and images) to
 * the runtime of the session's space execution mode (synthetic, offline).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { CompositeDeliveryTurnExecutor, RuntimeProviderRegistry } from '../src/runtime/provider-registry.js';
import type { DeliveryTurnExecutor } from '../src/runtime/delivery-gateway.js';

const ALICE = 'user-alice';
const BOB = 'user-bob';
const CONTAINER_SPACE = 'spc_00000000000000000000000000000051';
const HOST_SPACE = 'spc_00000000000000000000000000000052';
const DSH = 'ses_00000000000000000000000000000151';

function fakeExecutor(mode: string, calls: Array<Record<string, unknown>>, withReads = true): DeliveryTurnExecutor {
  return {
    execute: async () => ({ replyText: 'synthetic' }),
    cancel: async () => true,
    ...(withReads
      ? {
          readSessionEvents: async (userId: string, params: any) => {
            calls.push({ mode, op: 'readSessionEvents', userId, ...params });
            return { dshSessionId: params.dshSessionId, events: [{ seq: 0, type: 'user/message' }], lastSeq: 0, hasMore: false };
          },
          readAttachment: async (userId: string, params: any) => {
            calls.push({ mode, op: 'readAttachment', userId, ...params });
            return { mime: 'image/png', data: 'iVBORw0KGgo=' };
          },
        }
      : {}),
  };
}

describe('CompositeDeliveryTurnExecutor read ops', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE spaces (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, execution_mode TEXT)');
    db.prepare('INSERT INTO spaces (id, user_id, execution_mode) VALUES (?, ?, ?)').run(CONTAINER_SPACE, ALICE, 'container');
    db.prepare('INSERT INTO spaces (id, user_id, execution_mode) VALUES (?, ?, ?)').run(HOST_SPACE, ALICE, 'host');
  });

  afterEach(() => {
    db.close();
  });

  it('routes readSessionEvents and readAttachment by the space execution mode', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const registry = new RuntimeProviderRegistry();
    registry.registerProvider({ mode: 'container', turnExecutor: fakeExecutor('container', calls) });
    registry.registerProvider({ mode: 'host', turnExecutor: fakeExecutor('host', calls) });
    const composite = new CompositeDeliveryTurnExecutor(registry, db);

    const page = await composite.readSessionEvents(ALICE, { platformSpaceId: HOST_SPACE, dshSessionId: DSH, afterSeq: 3, limit: 10 });
    expect(page.lastSeq).toBe(0);
    await composite.readSessionEvents(ALICE, { platformSpaceId: CONTAINER_SPACE, dshSessionId: DSH });
    const image = await composite.readAttachment(ALICE, { platformSpaceId: HOST_SPACE, dshSessionId: DSH, attachmentId: 'sha256:abc' });
    expect(image).toEqual({ mime: 'image/png', data: 'iVBORw0KGgo=' });
    expect(calls).toEqual([
      { mode: 'host', op: 'readSessionEvents', userId: ALICE, platformSpaceId: HOST_SPACE, dshSessionId: DSH, afterSeq: 3, limit: 10 },
      { mode: 'container', op: 'readSessionEvents', userId: ALICE, platformSpaceId: CONTAINER_SPACE, dshSessionId: DSH },
      { mode: 'host', op: 'readAttachment', userId: ALICE, platformSpaceId: HOST_SPACE, dshSessionId: DSH, attachmentId: 'sha256:abc' },
    ]);

    // Another user's space is unknown; nothing reaches a runtime.
    await expect(composite.readSessionEvents(BOB, { platformSpaceId: HOST_SPACE, dshSessionId: DSH })).rejects.toMatchObject({
      code: 'session/not-found',
    });
    expect(calls).toHaveLength(3);
  });

  it('reports unsupported when the mode\'s executor has no read ops', async () => {
    const registry = new RuntimeProviderRegistry();
    registry.registerProvider({ mode: 'container', turnExecutor: fakeExecutor('container', [], false) });
    const composite = new CompositeDeliveryTurnExecutor(registry, db);
    await expect(composite.readSessionEvents(ALICE, { platformSpaceId: CONTAINER_SPACE, dshSessionId: DSH })).rejects.toMatchObject({
      code: 'unsupported',
    });
    await expect(composite.readAttachment(ALICE, { platformSpaceId: CONTAINER_SPACE, dshSessionId: DSH, path: 'x.png' })).rejects.toMatchObject({
      code: 'unsupported',
    });
    // No provider for host spaces.
    await expect(composite.readSessionEvents(ALICE, { platformSpaceId: HOST_SPACE, dshSessionId: DSH })).rejects.toMatchObject({
      code: 'RUNTIME_UNAVAILABLE',
    });
  });
});
