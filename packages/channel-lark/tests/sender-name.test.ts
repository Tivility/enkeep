import { describe, it, expect, vi } from 'vitest';
import {
  createFeishuSenderNameResolver,
  classifyFeishuError,
} from '../src/sender-name.js';

describe('createFeishuSenderNameResolver', () => {
  it('resolves sender name from chat members first, caching and falling back to contact lookup', async () => {
    const listChatMembers = vi.fn(async (chatId: string) => {
      return {
        members: [
          { openId: 'ou_user_alpha', name: 'User Alpha' },
          { openId: 'ou_user_beta', name: 'User Beta' },
        ],
        hasMore: false,
      };
    });

    const lookup = vi.fn(async (openId: string) => {
      if (openId === 'ou_user_gamma') {
        return 'User Gamma';
      }
      return undefined;
    });

    const resolver = createFeishuSenderNameResolver({
      listChatMembers,
      lookup,
    });

    // 1. Resolve Alpha in group chat -> fetched from chat members
    const nameAlpha = await resolver.resolve('ou_user_alpha', 'oc_test_chat_001');
    expect(nameAlpha).toBe('User Alpha');
    expect(listChatMembers).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalled();

    // 2. Resolve Beta -> already populated in cache from previous chat members call
    const nameBeta = await resolver.resolve('ou_user_beta', 'oc_test_chat_001');
    expect(nameBeta).toBe('User Beta');
    expect(listChatMembers).toHaveBeenCalledTimes(1);

    // 3. Resolve Gamma (not in chat members) -> falls back to contact lookup
    const nameGamma = await resolver.resolve('ou_user_gamma', 'oc_test_chat_001');
    expect(nameGamma).toBe('User Gamma');
    expect(lookup).toHaveBeenCalledWith('ou_user_gamma');

    // 4. Mention name caching directly populates cache without API call
    resolver.cacheMentionName('ou_user_delta', 'User Delta');
    expect(resolver.peek('ou_user_delta')).toBe('User Delta');
    const nameDelta = await resolver.resolve('ou_user_delta', 'oc_test_chat_001');
    expect(nameDelta).toBe('User Delta');
  });

  it('backs off on missing scope (99991672) and gracefully returns undefined without throwing', async () => {
    let callCount = 0;
    const missingScopeErr = { code: 99991672, msg: 'No permission' };
    const listChatMembers = vi.fn(async () => {
      callCount++;
      throw missingScopeErr;
    });

    const onMissingScope = vi.fn();
    const resolver = createFeishuSenderNameResolver({
      listChatMembers,
      onMissingScope,
      timeoutMs: 500,
    });

    // First call triggers error and sets backoff
    const result1 = await resolver.resolve('ou_user_unknown', 'oc_test_chat_002');
    expect(result1).toBeUndefined();
    expect(callCount).toBe(1);
    expect(onMissingScope).toHaveBeenCalledWith('chat_members', missingScopeErr);

    // Second call within backoff period skips API call
    const result2 = await resolver.resolve('ou_user_unknown2', 'oc_test_chat_002');
    expect(result2).toBeUndefined();
    expect(callCount).toBe(1);
  });
});
