import { describe, it, expect } from 'vitest';
import {
  buildRouteKey,
  parseRouteKey,
  isValidRouteKey,
  DEFAULT_WEB_ACCOUNT_ID,
  WEB_CHANNEL_NAME,
} from '../src/route-key.js';

describe('Web Channel Route Key Module', () => {
  it('builds a deterministic route key with userId, channel, accountId, and nativeContextId', () => {
    const key = buildRouteKey({
      userId: 'usr_alice123',
      channel: 'web',
      accountId: 'web-demo',
      nativeContextId: 'ses_001',
    });

    expect(key).toBe('usr_alice123:web:web-demo:ses_001');
  });

  it('uses default web channel and web-demo accountId when omitted', () => {
    const key = buildRouteKey({
      userId: 'usr_bob456',
      nativeContextId: 'tab_chat_42',
    });

    expect(key).toBe(`usr_bob456:${WEB_CHANNEL_NAME}:${DEFAULT_WEB_ACCOUNT_ID}:tab_chat_42`);
  });

  it('throws on empty or non-string userId or nativeContextId', () => {
    expect(() => buildRouteKey({ userId: '', nativeContextId: 'ses_1' })).toThrow(TypeError);
    expect(() => buildRouteKey({ userId: 'u1', nativeContextId: '' })).toThrow(TypeError);
    expect(() => buildRouteKey({ userId: null as any, nativeContextId: 'ses_1' })).toThrow(TypeError);
  });

  it('parses valid route key into component parts', () => {
    const parsed = parseRouteKey('usr_alice123:web:web-demo:ses_001');
    expect(parsed).toEqual({
      userId: 'usr_alice123',
      channel: 'web',
      accountId: 'web-demo',
      nativeContextId: 'ses_001',
    });
  });

  it('correctly handles nativeContextId containing colon separators', () => {
    const parsed = parseRouteKey('usr_alice:web:web-demo:room:sub:123');
    expect(parsed.userId).toBe('usr_alice');
    expect(parsed.channel).toBe('web');
    expect(parsed.accountId).toBe('web-demo');
    expect(parsed.nativeContextId).toBe('room:sub:123');
  });

  it('validates route keys with isValidRouteKey', () => {
    expect(isValidRouteKey('usr_1:web:web-demo:ses_1')).toBe(true);
    expect(isValidRouteKey('invalid-key')).toBe(false);
    expect(isValidRouteKey('')).toBe(false);
    expect(isValidRouteKey(null)).toBe(false);
  });
});
