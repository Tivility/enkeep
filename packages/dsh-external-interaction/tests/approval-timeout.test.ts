import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import * as externalInteractionPlugin from '../src/index.js';
import {
  APPROVAL_TIMEOUT_ENV,
  DEFAULT_INTERACTION_TIMEOUT_MS,
  parseApprovalTimeoutMs,
  resolveApprovalTimeoutMs,
} from '../src/approval-policy.js';
import type { ApprovalOutcome, ApprovalRequest } from '../src/types.js';

describe('approval timeout policy', () => {
  it('parses only bounded integer milliseconds', () => {
    expect(parseApprovalTimeoutMs('600000')).toBe(600_000);
    expect(parseApprovalTimeoutMs(' 90000 ')).toBe(90_000);
    expect(parseApprovalTimeoutMs(120_000)).toBe(120_000);
    expect(parseApprovalTimeoutMs('')).toBeUndefined();
    expect(parseApprovalTimeoutMs('10m')).toBeUndefined();
    expect(parseApprovalTimeoutMs('-5')).toBeUndefined();
    expect(parseApprovalTimeoutMs('999')).toBeUndefined();
    expect(parseApprovalTimeoutMs(String(25 * 60 * 60 * 1000))).toBeUndefined();
    expect(parseApprovalTimeoutMs(1.5)).toBeUndefined();
  });

  it('resolves configured > env > fallback > 60 s', () => {
    const env = { [APPROVAL_TIMEOUT_ENV]: '600000' };
    expect(resolveApprovalTimeoutMs()).toBe(DEFAULT_INTERACTION_TIMEOUT_MS);
    expect(resolveApprovalTimeoutMs({ env })).toBe(600_000);
    expect(resolveApprovalTimeoutMs({ env, configured: 30_000 })).toBe(30_000);
    expect(resolveApprovalTimeoutMs({ env: {}, fallback: 45_000 })).toBe(45_000);
    expect(resolveApprovalTimeoutMs({ env: { [APPROVAL_TIMEOUT_ENV]: 'nope' }, fallback: 45_000 })).toBe(45_000);
  });
});

describe('external interaction plugin approval timeout', () => {
  let ctx: Context;
  let saved: string | undefined;

  beforeEach(() => {
    ctx = new Context();
    saved = process.env[APPROVAL_TIMEOUT_ENV];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[APPROVAL_TIMEOUT_ENV];
    else process.env[APPROVAL_TIMEOUT_ENV] = saved;
  });

  function ask(): Promise<ApprovalOutcome> {
    const req: ApprovalRequest = {
      agent: { session: { meta: { source: 'web' }, id: 'session-timeout-1', snapshotEvents: () => [] } } as any,
      toolName: 'bash',
    };
    return ctx.waterfall('approval/request', req, async () => 'unavailable' as ApprovalOutcome);
  }

  it('keeps the composed 60 s default when the env is unset', async () => {
    delete process.env[APPROVAL_TIMEOUT_ENV];
    await ctx.plugin(externalInteractionPlugin, { defaultTimeoutMs: 60_000 });
    const service = ctx.get('externalInteraction')!;
    const pending = ask();
    await new Promise((r) => setTimeout(r, 5));
    const [approval] = service.listPendingApprovals();
    expect(approval.timeoutMs).toBe(60_000);
    service.answerApproval(approval.id, 'rejected');
    await expect(pending).resolves.toBe('rejected');
  });

  it('applies ENKEEP_APPROVAL_TIMEOUT_MS over the composed default for approvals only', async () => {
    process.env[APPROVAL_TIMEOUT_ENV] = '600000';
    await ctx.plugin(externalInteractionPlugin, { defaultTimeoutMs: 60_000 });
    const service = ctx.get('externalInteraction')! as any;
    expect(service.approvalTimeoutMs).toBe(600_000);
    expect(service.timeoutMs).toBe(60_000);
    const pending = ask();
    await new Promise((r) => setTimeout(r, 5));
    const [approval] = service.listPendingApprovals();
    expect(approval.timeoutMs).toBe(600_000);
    service.answerApproval(approval.id, 'allowed-once');
    await expect(pending).resolves.toBe('allowed-once');
  });

  it('lets an explicit approvalTimeoutMs config win over the env', async () => {
    process.env[APPROVAL_TIMEOUT_ENV] = '600000';
    await ctx.plugin(externalInteractionPlugin, { defaultTimeoutMs: 60_000, approvalTimeoutMs: 30_000 });
    expect((ctx.get('externalInteraction') as any).approvalTimeoutMs).toBe(30_000);
  });
});
