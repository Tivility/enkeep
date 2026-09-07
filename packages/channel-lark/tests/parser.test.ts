import { describe, it, expect } from 'vitest';
import { stripBotMentions } from '../src/parser.js';

describe('parser: stripBotMentions', () => {
  const botOpenId = 'ou_bot_123';
  const botMentions = [
    { key: '@_user_1', name: '测试机器人', openId: botOpenId, id: { open_id: botOpenId } },
  ];
  const otherUserMentions = [
    { key: '@_user_1', name: '测试机器人', openId: botOpenId, id: { open_id: botOpenId } },
    { key: '@_user_2', name: 'Alice', openId: 'ou_alice_456', id: { open_id: 'ou_alice_456' } },
  ];

  it('removes leading bot mention (placeholder and resolved forms)', () => {
    expect(stripBotMentions('@_user_1 hello world', botMentions, botOpenId)).toBe('hello world');
    expect(stripBotMentions('@测试机器人 hello world', botMentions, botOpenId)).toBe('hello world');
  });

  it('removes middle bot mention (placeholder and resolved forms)', () => {
    expect(stripBotMentions('hello @_user_1 world', botMentions, botOpenId)).toBe('hello world');
    expect(stripBotMentions('hello @测试机器人 world', botMentions, botOpenId)).toBe('hello world');
  });

  it('removes trailing bot mention (placeholder and resolved forms)', () => {
    expect(stripBotMentions('2 @_user_1', botMentions, botOpenId)).toBe('2');
    expect(stripBotMentions('2 @测试机器人', botMentions, botOpenId)).toBe('2');
  });

  it("keeps other users' mentions as @name", () => {
    expect(stripBotMentions('2 @测试机器人 @Alice', otherUserMentions, botOpenId)).toBe('2 @Alice');
    expect(stripBotMentions('@Alice 2 @_user_1', otherUserMentions, botOpenId)).toBe('@Alice 2');
    expect(stripBotMentions('@Alice @测试机器人 please review', otherUserMentions, botOpenId)).toBe('@Alice please review');
  });

  it("returns '' for mention-only text", () => {
    expect(stripBotMentions('@_user_1', botMentions, botOpenId)).toBe('');
    expect(stripBotMentions('@测试机器人', botMentions, botOpenId)).toBe('');
    expect(stripBotMentions('   @测试机器人   ', botMentions, botOpenId)).toBe('');
    expect(stripBotMentions('@测试机器人 @_user_1', botMentions, botOpenId)).toBe('');
  });
});
