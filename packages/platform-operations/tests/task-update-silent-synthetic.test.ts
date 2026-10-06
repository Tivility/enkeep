import { describe, it, expect } from 'vitest';
import { validateUpdateTaskInput } from '../src/types/task.js';
import { ValidationError } from '../src/errors/index.js';

describe('Synthetic Task Update Silent & Immutability Validation', () => {
  it('allows silent=true and silent=false at root level', () => {
    const res1 = validateUpdateTaskInput({ silent: true });
    expect(res1.silent).toBe(true);
    expect(res1.payload?.silent).toBe(true);

    const res2 = validateUpdateTaskInput({ silent: false });
    expect(res2.silent).toBe(false);
    expect(res2.payload?.silent).toBe(false);
  });

  it('allows silent=true and silent=false inside payload object', () => {
    const res1 = validateUpdateTaskInput({ payload: { silent: true } });
    expect(res1.silent).toBe(true);
    expect(res1.payload?.silent).toBe(true);

    const res2 = validateUpdateTaskInput({ payload: { silent: false } });
    expect(res2.silent).toBe(false);
    expect(res2.payload?.silent).toBe(false);
  });

  it('allows consistent silent in both root and payload', () => {
    const res = validateUpdateTaskInput({ silent: true, payload: { silent: true } });
    expect(res.silent).toBe(true);
    expect(res.payload?.silent).toBe(true);
  });

  it('rejects conflicting silent values in root and payload', () => {
    expect(() =>
      validateUpdateTaskInput({ silent: true, payload: { silent: false } })
    ).toThrow(ValidationError);
    expect(() =>
      validateUpdateTaskInput({ silent: true, payload: { silent: false } })
    ).toThrow(/Conflicting silent values/i);
  });

  it('rejects non-boolean silent at root and payload', () => {
    expect(() =>
      validateUpdateTaskInput({ silent: 'true' as any })
    ).toThrow(ValidationError);
    expect(() =>
      validateUpdateTaskInput({ silent: 1 as any })
    ).toThrow(/Task silent must be a boolean/i);

    expect(() =>
      validateUpdateTaskInput({ payload: { silent: 'false' as any } })
    ).toThrow(ValidationError);
    expect(() =>
      validateUpdateTaskInput({ payload: { silent: null as any } })
    ).toThrow(/Task payload silent must be a boolean/i);
  });

  it('strictly rejects other immutable payload keys (sessionId, sessionPolicy, contextMode, spaceId, spaceFolder, delivery)', () => {
    const forbiddenPayloadKeys = [
      { sessionId: 'ses_00000000000000000000000000000001' },
      { sessionPolicy: 'isolated' },
      { contextMode: 'group' },
      { spaceId: 'spc_00000000000000000000000000000001' },
      { spaceFolder: 'subfolder' },
      { delivery: { channel: 'lark', accountId: 'acc_01', nativeContextId: 'chat_01' } },
    ];

    for (const item of forbiddenPayloadKeys) {
      expect(() =>
        validateUpdateTaskInput({ payload: item })
      ).toThrow(ValidationError);
      expect(() =>
        validateUpdateTaskInput({ payload: item })
      ).toThrow(/Task session and space bindings are immutable/i);
    }
  });

  it('strictly rejects unknown/immutable payload keys', () => {
    expect(() =>
      validateUpdateTaskInput({ payload: { unknownField: 'test' } })
    ).toThrow(ValidationError);
    expect(() =>
      validateUpdateTaskInput({ payload: { unknownField: 'test' } })
    ).toThrow(/is immutable and cannot be updated/i);
  });

  it('strictly rejects forbidden root immutable keys', () => {
    const forbiddenRootKeys = [
      { userId: 'usr_00000000000000000000000000000001' },
      { user_id: 'usr_00000000000000000000000000000001' },
      { id: 'task_00000000000000000000000000000001' },
      { status: 'running' },
      { createdAt: '2026-01-01T00:00:00.000Z' },
      { updatedAt: '2026-01-01T00:00:00.000Z' },
      { claimCount: 1 },
      { claimantId: 'worker_01' },
      { leaseExpiresAt: '2026-01-01T00:00:00.000Z' },
      { currentRun: null },
      { result: null },
      { error: null },
      { errorCode: null },
      { idempotencyKey: '00000000-0000-4000-8000-000000000001' },
    ];

    for (const item of forbiddenRootKeys) {
      expect(() =>
        validateUpdateTaskInput(item)
      ).toThrow(ValidationError);
    }
  });
});
