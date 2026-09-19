import { describe, it, expect } from 'vitest';
import { stripBotMentions, extractTextAndResources } from '../src/parser.js';

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

describe('parser: extractTextAndResources image handling', () => {
  it('extracts single standalone image message as supported image resource', () => {
    const raw = JSON.stringify({ image_key: 'img_v3_test_single_001' });
    const res = extractTextAndResources('image', raw);
    expect(res.text).toBe('[图片]');
    expect(res.resources).toHaveLength(1);
    expect(res.resources[0]).toEqual({
      type: 'image',
      key: 'img_v3_test_single_001',
      name: 'img_v3_test_single_001.jpg',
    });
    expect((res.resources[0] as any).unsupported).toBeUndefined();
  });

  it('extracts rich-text post with 4 images as supported image resources', () => {
    const postPayload = {
      zh_cn: {
        title: '4张图片分析',
        content: [
          [
            { tag: 'text', text: '请分析这4张图片：' },
            { tag: 'img', image_key: 'img_001' },
            { tag: 'img', image_key: 'img_002' },
          ],
          [
            { tag: 'img', image_key: 'img_003' },
            { tag: 'img', image_key: 'img_004' },
          ],
        ],
      },
    };
    const res = extractTextAndResources('post', JSON.stringify(postPayload));
    expect(res.text).toContain('4张图片分析');
    expect(res.text).toContain('[图片]');
    expect(res.resources).toHaveLength(4);
    expect(res.resources.map((r) => r.key)).toEqual(['img_001', 'img_002', 'img_003', 'img_004']);
    for (const r of res.resources) {
      expect(r.type).toBe('image');
      expect((r as any).unsupported).toBeUndefined();
    }
  });

  it('preserves unsupported: true for file type in post and standalone file', () => {
    const filePost = {
      zh_cn: {
        content: [
          [
            { tag: 'file', file_key: 'file_001', file_name: 'doc.pdf' },
            { tag: 'img', image_key: 'img_valid' },
          ],
        ],
      },
    };
    const res = extractTextAndResources('post', JSON.stringify(filePost));
    expect(res.resources).toHaveLength(2);
    const fileRes = res.resources.find((r) => r.type === 'file');
    const imgRes = res.resources.find((r) => r.type === 'image');
    expect(fileRes?.unsupported).toBe(true);
    expect(imgRes?.unsupported).toBeUndefined();
  });

  it('parses standalone PDF file as candidate without hardcoded placeholder', () => {
    const fileMsg = { file_key: 'file_pdf_123', file_name: 'Audit_Report.pdf' };
    const res = extractTextAndResources('file', JSON.stringify(fileMsg));
    expect(res.text).toBe('[文件: Audit_Report.pdf]');
    expect(res.resources).toHaveLength(1);
    expect(res.resources[0]).toEqual({
      type: 'file',
      key: 'file_pdf_123',
      name: 'Audit_Report.pdf',
      unsupported: undefined,
    });
  });

  it('parses generic non-PDF file formats (.md, .zip, .docx) as supported candidate', () => {
    const mdMsg = { file_key: 'file_md_456', file_name: 'notes.md' };
    const resMd = extractTextAndResources('file', JSON.stringify(mdMsg));
    expect(resMd.text).toBe('[文件: notes.md]');
    expect(resMd.resources[0].unsupported).toBeUndefined();

    const zipMsg = { file_key: 'file_zip_456', file_name: 'archive.zip' };
    const resZip = extractTextAndResources('file', JSON.stringify(zipMsg));
    expect(resZip.text).toBe('[文件: archive.zip]');
    expect(resZip.resources[0].unsupported).toBeUndefined();
  });

  it('sanitizes dangerous claimed filenames for safe display', () => {
    const attackMsg = {
      file_key: 'file_atk_789',
      file_name: '../../../../etc/passwd\x00\x1b[31m.pdf',
    };
    const res = extractTextAndResources('file', JSON.stringify(attackMsg));
    expect(res.resources[0].name).not.toContain('..');
    expect(res.resources[0].name).not.toContain('\x00');
    expect(res.resources[0].name).toBe('passwd.pdf');
  });
});
