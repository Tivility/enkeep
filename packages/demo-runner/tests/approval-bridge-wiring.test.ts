/**
 * The platform ApprovalBridge is wired by launchDemoSystem itself (the CLI `up` path passes no
 * externalInteractionService): runtime approval events reach /api/interactions/approvals and
 * answers go back through the user's runtime transport. Offline: fake runtime adapter + fake
 * daemon transport, platform on an ephemeral 127.0.0.1 port.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { resetDemo } from '../src/reset/index.js';
import { launchDemoSystem, type RunningDemoSystem } from '../src/up/index.js';
import type { UserRuntimeHandle } from '../src/ports/index.js';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';
import { FakeUnitRuntimeContainerAdapter } from './support/fake-runtime.js';

class FakeDaemonTransport extends EventEmitter {
  readonly answers: Array<{ approvalId: string; decision: string }> = [];
  isConnected(): boolean {
    return true;
  }
  async answerApproval(_sessionId: string, approvalId: string, decision: string) {
    this.answers.push({ approvalId, decision });
    return { ok: true, answered: true, approvalId };
  }
}

/** Fake adapter whose handles expose a daemon transport, like the real container handles. */
class TransportFakeAdapter extends FakeUnitRuntimeContainerAdapter {
  readonly transports = new Map<string, FakeDaemonTransport>();

  override async startUserRuntime(options: Parameters<FakeUnitRuntimeContainerAdapter['startUserRuntime']>[0]): Promise<UserRuntimeHandle> {
    const handle = await super.startUserRuntime(options);
    const transport = new FakeDaemonTransport();
    this.transports.set(options.userId, transport);
    (handle as any).rawHandle = { transport };
    return handle;
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

describe('launchDemoSystem approval bridge wiring', () => {
  let tempRepo: TempRepo;
  let system: RunningDemoSystem | null = null;

  beforeEach(() => {
    tempRepo = createTempRepo();
  });

  afterEach(async () => {
    if (system) {
      await system.close({ removeVolumes: true });
      system = null;
    }
    tempRepo.cleanup();
  });

  it('serves runtime approvals and answers them without an injected externalInteractionService', async () => {
    const reset = await resetDemo({ repoRoot: tempRepo.repoRoot });
    const adapter = new TransportFakeAdapter();
    system = await launchDemoSystem({ repoRoot: tempRepo.repoRoot, runtimeAdapter: adapter });

    expect(system.approvalBridge).toBeDefined();
    expect(system.platformServer.approvalBridge).toBe(system.approvalBridge);

    const bob = await system.storage.users.findByUsername(reset.credentials.user.username);
    expect(bob).toBeDefined();
    const bobHandle = system.runtimeHandles.get(bob!.id)!;
    const transport = adapter.transports.get(bobHandle.userId)!;
    expect(transport).toBeDefined();
    expect(system.approvalBridge.hasTransport(bob!.id)).toBe(true);

    const spaces = await system.storage.forTenant(bob!.id).spaces.list();
    expect(spaces.length).toBeGreaterThan(0);
    const created = await system.storage.forTenant(bob!.id).sessionRoutes.create({
      id: 'ses_000000000000000000000000000000a1',
      spaceId: spaces[0].id,
      channel: 'web',
      nativeContextId: 'ses_000000000000000000000000000000a1',
      dshSessionId: 'ses_000000000000000000000000000000b1',
    });
    const route = { id: created.id, dsh_session_id: 'ses_000000000000000000000000000000b1' };

    const approvalId = '00000000-0000-4000-8000-0000000000a1';
    const now = Date.now();
    transport.emit('stream', {
      type: 'event',
      event: 'turn/event',
      sessionId: route.dsh_session_id,
      turnId: 'turn_test_demo_0001',
      seq: 3,
      timestamp: now,
      sessionEvent: { type: 'approval/asked', seq: 3, time: now, data: { id: approvalId, toolName: 'bash', callId: 'call_test_demo_0001' } },
    });
    transport.emit('stream', {
      type: 'event',
      event: 'approval/asked',
      sessionId: route.dsh_session_id,
      turnId: 'turn_test_demo_0001',
      timestamp: now,
      approval: { id: approvalId, toolName: 'bash', risk: 'medium', safeSummary: 'Approval requested' },
    });
    await new Promise((r) => setImmediate(r));

    const auth = await login(system.platformUrl, reset.credentials.user.username, reset.credentials.user.password);
    const list = (await (
      await fetch(`${system.platformUrl}/api/interactions/approvals?sessionId=${route.id}`, { headers: { Cookie: auth.cookie } })
    ).json()) as any;
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).toMatchObject({ id: approvalId, sessionId: route.id, toolName: 'bash', risk: 'high', status: 'pending' });

    const decide = await fetch(`${system.platformUrl}/api/interactions/approvals/${approvalId}/decide`, {
      method: 'POST',
      headers: {
        Cookie: auth.cookie,
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': auth.csrfToken,
        Origin: system.platformUrl,
      },
      body: JSON.stringify({ outcome: 'rejected' }),
    });
    expect(decide.status).toBe(200);
    expect(((await decide.json()) as any).data).toEqual({ id: approvalId, status: 'rejected', decided: true });
    expect(transport.answers).toEqual([{ approvalId, decision: 'rejected' }]);
  });
});
