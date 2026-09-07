/**
 * Scope Derivation and Isolation Tests for @enkeep/dsh-tool-browser
 *
 * Validates:
 * 1. Scope derives strictly from initiator agent context (agent.session.header).
 * 2. Never accepts or trusts model arguments for userId, spaceId, or sessionId.
 * 3. Throws BROWSER_CONTEXT_UNAVAILABLE when session context is missing.
 *
 * @module @enkeep/dsh-tool-browser/tests/scope-derivation.test
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createBrowserOpenTool,
  createBrowserSnapshotTool,
  resolveCallerScope,
} from '../src/index.js';
import { BrowserToolErrorCode } from '../src/errors.js';

describe('dsh-tool-browser: Scope Derivation & Isolation', () => {
  it('derives userId, spaceId, and sessionId from active Agent session', () => {
    const mockAgent = {
      id: 'agent_alice_1',
      session: {
        id: 'ses_1234567890abcdef1234567890abcdef',
        header: {
          id: 'ses_1234567890abcdef1234567890abcdef',
          userId: 'usr_alice_001',
          spaceId: 'spc_engineering',
        },
      },
    };

    const scope = resolveCallerScope({ agent: mockAgent } as any);
    expect(scope.sessionId).toBe('ses_1234567890abcdef1234567890abcdef');
    expect(scope.userId).toBe('usr_alice_001');
    expect(scope.spaceId).toBe('spc_engineering');
    expect(scope.agent).toBe(mockAgent);
  });

  it('fails closed when active session cannot be resolved', () => {
    expect(() => resolveCallerScope({} as any)).toThrowError(
      expect.objectContaining({
        code: BrowserToolErrorCode.BROWSER_CONTEXT_UNAVAILABLE,
      })
    );
  });

  it('passes authoritative initiator scope to platform client RPC and ignores rogue args', async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      status: 200,
      data: {
        success: true,
        pageId: 'page_abc123',
        url: 'https://example.com',
      },
    });

    const mockClient = { request: mockRequest };
    const tool = createBrowserOpenTool(() => mockClient);

    const mockAgent = {
      id: 'agent_bob',
      session: {
        id: 'ses_bob_valid_123',
        header: {
          id: 'ses_bob_valid_123',
          userId: 'usr_bob_authoritative',
          spaceId: 'spc_bob_private',
        },
      },
    };

    const rogueArgs = {
      url: 'https://example.com',
      userId: 'usr_hacker_spoofed',
      spaceId: 'spc_victim_space',
      sessionId: 'ses_victim_session',
    };

    const res = await tool.execute(rogueArgs as any, { agent: mockAgent } as any);
    expect(res.pageId).toBe('page_abc123');

    expect(mockRequest).toHaveBeenCalledTimes(1);
    const callArgs = mockRequest.mock.calls[0];
    expect(callArgs[0]).toBe('/api/browser/open');
    expect(callArgs[1].body).toEqual({
      url: 'https://example.com/',
      userId: 'usr_bob_authoritative',
      spaceId: 'spc_bob_private',
      sessionId: 'ses_bob_valid_123',
    });
  });
});
