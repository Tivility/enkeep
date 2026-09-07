import { describe, it, expect } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import * as externalInteractionPlugin from '../src/index.js';
import type { ApprovalRequest, ApprovalOutcome } from '../src/types.js';

describe('dsh-external-interaction: Cordis plugin and dispose lifecycle', () => {
  it('mounts cleanly, attaches approval waterfall handler, and cleans up on dispose', async () => {
    const ctx = new Context();
    const fork = await ctx.plugin(externalInteractionPlugin);

    const service = ctx.get('externalInteraction');
    expect(service).toBeDefined();

    // Trigger an external approval request to create pending state
    const extReq: ApprovalRequest = {
      agent: { session: { meta: { source: 'external' }, id: 'sess-lifecycle', snapshotEvents: () => [] } } as any,
      toolName: 'test_tool',
    };

    const promise = ctx.waterfall('approval/request', extReq, async () => 'allowed-once' as ApprovalOutcome);
    await new Promise((r) => setTimeout(r, 5));

    expect(service?.listPendingApprovals().length).toBe(1);

    // Dispose the plugin — should clean up all pending requests
    await fork.dispose();

    const outcome = await promise;
    expect(outcome).toBe('cancelled');
    expect(service?.listPendingApprovals().length).toBe(0);

    // Verify after dispose that emit/waterfall immediately falls through to next() with no interception
    let nextCalled = false;
    const postDisposeOutcome = await ctx.waterfall('approval/request', extReq, async () => {
      nextCalled = true;
      return 'allowed-once' as ApprovalOutcome;
    });

    expect(nextCalled).toBe(true);
    expect(postDisposeOutcome).toBe('allowed-once');
  });

  it('can start and stop independently multiple times', async () => {
    const ctx = new Context();

    const fork1 = await ctx.plugin(externalInteractionPlugin);
    expect(ctx.get('externalInteraction')).toBeDefined();
    await fork1.dispose();

    const fork2 = await ctx.plugin(externalInteractionPlugin);
    expect(ctx.get('externalInteraction')).toBeDefined();
    await fork2.dispose();
  });
});
