import { describe, it, expect } from 'vitest';
import { getChatLevelNativeContextId, isTopicNativeContextId } from '../src/index.js';

describe('inbound-route-resolver topic helpers', () => {
  it('applies topic semantics to lark channel only', () => {
    const larkThread = 'oc_test0000000000000000000000000001:om_test_thread_001';
    const larkMain = 'oc_test0000000000000000000000000001';

    // Lark thread: topic true, chat level stripped
    expect(isTopicNativeContextId(larkThread, 'lark')).toBe(true);
    expect(isTopicNativeContextId(larkThread)).toBe(true);
    expect(getChatLevelNativeContextId(larkThread, 'lark')).toBe('oc_test0000000000000000000000000001');
    expect(getChatLevelNativeContextId(larkThread)).toBe('oc_test0000000000000000000000000001');

    // Lark main stream: topic false, chat level unchanged
    expect(isTopicNativeContextId(larkMain, 'lark')).toBe(false);
    expect(isTopicNativeContextId(larkMain)).toBe(false);
    expect(getChatLevelNativeContextId(larkMain, 'lark')).toBe(larkMain);
  });

  it('preserves nativeContextId and marks isTopic false for non-lark channels (wechat, qq)', () => {
    const wechatCtx = 'wechat:test-peer-01@im.wechat';
    expect(isTopicNativeContextId(wechatCtx, 'wechat')).toBe(false);
    expect(getChatLevelNativeContextId(wechatCtx, 'wechat')).toBe(wechatCtx);

    const qqCtx = 'qq:12345678:sub';
    expect(isTopicNativeContextId(qqCtx, 'qq')).toBe(false);
    expect(getChatLevelNativeContextId(qqCtx, 'qq')).toBe(qqCtx);
  });
});
