import { describe, it, expect } from 'vitest';
import { InMemoryPlatformWebApi } from './test-platform-api.js';
import { NotFoundError, TenantAccessDeniedError, UnauthorizedError } from '@enkeep/platform-core';

describe('PlatformWebApi In-Memory Contract & Multi-Tenancy Tests', () => {
  const aliceId = 'usr_alice123';
  const bobId = 'usr_bob456';

  it('authenticates user login and verifies cookie tokens', async () => {
    const api = new InMemoryPlatformWebApi();

    // Valid login for Alice
    const loginRes = await api.login('alice', 'password123');
    expect(loginRes.user.username).toBe('alice');
    expect(loginRes.user.id).toBe(aliceId);
    expect(loginRes.cookieHeader).toContain('enkeep_session=');

    // Invalid login attempt
    await expect(api.login('alice', 'wrong-pass')).rejects.toThrow(UnauthorizedError);

    // Authenticate via Cookie header
    const authSuccess = await api.authenticateCookie(loginRes.cookieHeader);
    expect(authSuccess).not.toBeNull();
    expect(authSuccess?.user.id).toBe(aliceId);

    // Logout and verify cookie is revoked
    await api.logout(authSuccess!.session.id);
    const authAfterLogout = await api.authenticateCookie(loginRes.cookieHeader);
    expect(authAfterLogout).toBeNull();
  });

  it('strictly isolates spaces between tenants', async () => {
    const api = new InMemoryPlatformWebApi();

    // Alice creates a private space
    const aliceSpace = await api.createSpace(aliceId, {
      name: 'Alice Secret Lab',
    });

    // Alice can view her own space
    const aliceSpaces = await api.listSpaces(aliceId);
    expect(aliceSpaces.some((s) => s.id === aliceSpace.id)).toBe(true);

    const aliceGotSpace = await api.getSpace(aliceId, aliceSpace.id);
    expect(aliceGotSpace?.name).toBe('Alice Secret Lab');

    // Bob CANNOT list Alice's space
    const bobSpaces = await api.listSpaces(bobId);
    expect(bobSpaces.some((s) => s.id === aliceSpace.id)).toBe(false);

    // Bob CANNOT get Alice's space
    const bobGotSpace = await api.getSpace(bobId, aliceSpace.id);
    expect(bobGotSpace).toBeNull();

    // Bob CANNOT create a session in Alice's space
    await expect(
      api.createSession(bobId, { spaceId: aliceSpace.id })
    ).rejects.toThrow(TenantAccessDeniedError);
  });

  it('strictly isolates sessions and messages between tenants', async () => {
    const api = new InMemoryPlatformWebApi();

    const aliceSpace = (await api.listSpaces(aliceId))[0];
    const aliceSession = await api.createSession(aliceId, {
      spaceId: aliceSpace.id,
      title: 'alice_laptop',
    });

    // Seed Alice message
    api.seedMessage(aliceId, aliceSession.id, 'Alice confidential task prompt');

    // Alice can read her own messages
    const aliceHistory = await api.listMessages(aliceId, aliceSession.id);
    expect(aliceHistory.messages).toHaveLength(1);
    expect(aliceHistory.messages[0].content).toBe('Alice confidential task prompt');

    // Bob CANNOT get Alice's session
    const bobGotSession = await api.getSession(bobId, aliceSession.id);
    expect(bobGotSession).toBeNull();

    // Bob CANNOT read Alice's messages
    await expect(
      api.listMessages(bobId, aliceSession.id)
    ).rejects.toThrow(NotFoundError);

    // Bob CANNOT poll events from Alice's session
    await expect(
      api.pollEvents(bobId, aliceSession.id)
    ).rejects.toThrow(NotFoundError);
  });

  it('supports message listing and incremental polling', async () => {
    const api = new InMemoryPlatformWebApi();
    const aliceSpace = (await api.listSpaces(aliceId))[0];
    const aliceSession = await api.createSession(aliceId, { spaceId: aliceSpace.id });

    // Seed initial message
    api.seedMessage(aliceId, aliceSession.id, 'Initial question');

    const history = await api.listMessages(aliceId, aliceSession.id);
    expect(history.messages).toHaveLength(1);
    expect(history.messages[0].content).toBe('Initial question');

    // Seed new message and poll
    api.seedMessage(aliceId, aliceSession.id, 'Testing incremental polling');

    // Poll events from start
    const poll1 = await api.pollEvents(aliceId, aliceSession.id);
    expect(poll1.events.length).toBeGreaterThanOrEqual(1);
    const lastEventId = poll1.events[poll1.events.length - 1].id;

    // Poll with cursor
    const poll2 = await api.pollEvents(aliceId, aliceSession.id, lastEventId);
    expect(poll2.events).toHaveLength(0);
  });

  it('supports space and session archive/restore lifecycle', async () => {
    const api = new InMemoryPlatformWebApi();
    const aliceSpace = (await api.listSpaces(aliceId))[0];
    const aliceSession = await api.createSession(aliceId, { spaceId: aliceSpace.id, title: 'Archive Test' });

    // Archive space
    const archSpace = await api.archiveSpace(aliceId, aliceSpace.id);
    expect(archSpace.status).toBe('archived');

    // Restoring session when parent space is archived should fail
    await expect(api.restoreSession(aliceId, aliceSession.id)).rejects.toThrow();

    // Restore space
    const restoredSpace = await api.restoreSpace(aliceId, aliceSpace.id);
    expect(restoredSpace.status).toBe('active');

    // Restore session
    const restoredSession = await api.restoreSession(aliceId, aliceSession.id);
    expect(restoredSession.status).toBe('active');
  });

  it('supports online session fork with tenant isolation and prefix boundary', async () => {
    const api = new InMemoryPlatformWebApi();
    const aliceSpace = (await api.listSpaces(aliceId))[0];
    const sourceSession = await api.createSession(aliceId, { spaceId: aliceSpace.id, title: 'Mainline' });

    api.seedMessage(aliceId, sourceSession.id, 'Msg 1: Plan');
    api.seedMessage(aliceId, sourceSession.id, 'Msg 2: Code');

    const msgs = (await api.listMessages(aliceId, sourceSession.id)).messages;
    const msg1Id = msgs[0].id;

    // Fork prefix
    const forked = await api.forkSession(aliceId, sourceSession.id, {
      fromMessageId: msg1Id,
      title: 'Branch Msg1',
    });
    expect(forked.status).toBe('active');
    expect(forked.title).toBe('Branch Msg1');

    const forkedMsgs = (await api.listMessages(aliceId, forked.id)).messages;
    expect(forkedMsgs).toHaveLength(1);
    expect(forkedMsgs[0].content).toBe('Msg 1: Plan');

    // Cross-tenant fork rejected
    await expect(api.forkSession(bobId, sourceSession.id)).rejects.toThrow(NotFoundError);
  });
});
