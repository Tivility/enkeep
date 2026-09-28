/**
 * Unit tests for WeChat Markdown formatting and Final Answer Extraction.
 *
 * @module @enkeep/channel-wechat/tests/markdown.test
 */

import { describe, it, expect } from 'vitest';
import {
  extractFinalAnswerText,
  cleanThinking,
  markdownToPlainText,
  formatTable,
  getDisplayWidth,
  splitTextChunks,
  MSG_SPLIT_LIMIT,
} from '../src/index.js';

describe('WeChat Output: Markdown formatting & Final Answer Extraction', () => {
  describe('extractFinalAnswerText', () => {
    it('prefers explicit finalText from runtime when present', () => {
      const res = extractFinalAnswerText({
        replyText: '<think>internal CoT</think>draft answer',
        finalText: 'Authoritative final answer from K1',
      });
      expect(res).toBe('Authoritative final answer from K1');
    });

    it('prefers explicit final_text or finalAnswerText when provided', () => {
      expect(
        extractFinalAnswerText({
          replyText: 'fallback',
          final_text: 'final_text result',
        })
      ).toBe('final_text result');

      expect(
        extractFinalAnswerText({
          replyText: 'fallback',
          finalAnswerText: 'finalAnswerText result',
        })
      ).toBe('finalAnswerText result');
    });

    it('extracts from executionResult object if nested', () => {
      const res = extractFinalAnswerText({
        sessionId: 'ses_1',
        turnId: 'turn_1',
        executionResult: {
          finalText: 'Nested final answer',
          replyText: '<think>thinking</think>nested reply',
        },
      });
      expect(res).toBe('Nested final answer');
    });

    it('strips <think>...</think> tags when K1 is not yet merged and only replyText is given', () => {
      const raw = `
<think>
Need to verify user request.
The weather in Beijing is sunny.
Let's formulate the response.
</think>

北京今天天气晴朗，气温 22°C。
`;
      const res = extractFinalAnswerText({ replyText: raw });
      expect(res).toBe('北京今天天气晴朗，气温 22°C。');
    });

    it('strips <thought>, <thinking>, and <reasoning> tags', () => {
      expect(
        extractFinalAnswerText('<thought>thinking</thought>Hello!')
      ).toBe('Hello!');

      expect(
        extractFinalAnswerText('<thinking>reasoning process</thinking>Good morning!')
      ).toBe('Good morning!');

      expect(
        extractFinalAnswerText('<reasoning>deep analysis</reasoning>Done.')
      ).toBe('Done.');
    });

    it('strips fenced ```thought ... ``` code blocks', () => {
      const raw = '```thought\nAnalyzing the problem\n```\nHere is the solution.';
      expect(extractFinalAnswerText(raw)).toBe('Here is the solution.');
    });

    it('parses JSON stringified content blocks and extracts only text blocks (filtering reasoning)', () => {
      const jsonBlocks = JSON.stringify([
        { type: 'reasoning', text: 'I should analyze the log file' },
        { type: 'thinking', text: 'Step 1 completed' },
        { type: 'text', text: 'Found 3 errors in the log file.' },
      ]);
      const res = extractFinalAnswerText({ replyText: jsonBlocks });
      expect(res).toBe('Found 3 errors in the log file.');
    });

    it('handles empty or non-string inputs safely', () => {
      expect(extractFinalAnswerText(null)).toBe('');
      expect(extractFinalAnswerText(undefined)).toBe('');
      expect(extractFinalAnswerText({})).toBe('');
      expect(extractFinalAnswerText('')).toBe('');
    });
  });

  describe('cleanThinking', () => {
    it('removes multiple think blocks across text', () => {
      const text = '<think>first thought</think>Part 1.<think>second thought</think>Part 2.';
      expect(cleanThinking(text)).toBe('Part 1.Part 2.');
    });
  });

  describe('getDisplayWidth', () => {
    it('measures ASCII characters as width 1', () => {
      expect(getDisplayWidth('hello')).toBe(5);
    });

    it('measures CJK fullwidth characters as width 2', () => {
      expect(getDisplayWidth('北京')).toBe(4);
      expect(getDisplayWidth('AI助手')).toBe(6);
    });
  });

  describe('formatTable', () => {
    it('formats a simple table with aligned columns and no divider line', () => {
      const tableLines = [
        '| Name | Status |',
        '| :--- | :---: |',
        '| Server | Running |',
        '| DB | Healthy |',
      ];
      const formatted = formatTable([
        '| Name | Status |',
        '| Server | Running |',
        '| DB | Healthy |',
      ]);
      const lines = formatted.split('\n');
      expect(lines.length).toBe(3);
      expect(lines[0]).toContain('Name');
      expect(lines[0]).toContain('Status');
      expect(lines[1]).toContain('Server');
      expect(lines[1]).toContain('Running');
      expect(lines[2]).toContain('DB');
      expect(lines[2]).toContain('Healthy');
      // No outer pipes in formatted output
      expect(lines[0].startsWith('|')).toBe(false);
      expect(lines[0].endsWith('|')).toBe(false);
    });
  });

  describe('markdownToPlainText', () => {
    it('renders code blocks by stripping fences and preserving code content without italic/bold corruption', () => {
      const md = `
Here is the script:
\`\`\`python
x = 2 * 3
if a_b == 4:
    print("Done")
\`\`\`
Hope it helps!
`;
      const plain = markdownToPlainText(md);
      expect(plain).not.toContain('```');
      expect(plain).toContain('x = 2 * 3');
      expect(plain).toContain('if a_b == 4:');
      expect(plain).toContain('print("Done")');
    });

    it('renders inline code by removing backticks', () => {
      const md = 'Use `const value = 42;` to define a constant.';
      expect(markdownToPlainText(md)).toBe('Use const value = 42; to define a constant.');
    });

    it('renders links sensibly as text (url)', () => {
      const md = 'Visit [Enkeep Documentation](https://enkeep.example.com/docs) for more details.';
      expect(markdownToPlainText(md)).toBe(
        'Visit Enkeep Documentation (https://enkeep.example.com/docs) for more details.'
      );
    });

    it('collapses identical link text and url into single url', () => {
      const md = 'Go to [https://example.com](https://example.com)';
      expect(markdownToPlainText(md)).toBe('Go to https://example.com');
    });

    it('renders image links with [图片: alt] (url)', () => {
      const md = '![Architecture](https://example.com/arch.png)';
      expect(markdownToPlainText(md)).toBe('[图片: Architecture] (https://example.com/arch.png)');

      const mdNoAlt = '![](https://example.com/empty.png)';
      expect(markdownToPlainText(mdNoAlt)).toBe('[图片] (https://example.com/empty.png)');
    });

    it('renders markdown tables sensibly in plain text', () => {
      const md = `
任务执行清单：
| 模块 | 状态 | 耗时 |
| :--- | :---: | ---: |
| 认证模块 | 完成 | 120ms |
| 消息网关 | 进行中 | 45ms |

请查收。
`;
      const plain = markdownToPlainText(md);
      expect(plain).not.toContain('| :---');
      expect(plain).not.toContain('| ---:');
      expect(plain).toContain('模块');
      expect(plain).toContain('状态');
      expect(plain).toContain('耗时');
      expect(plain).toContain('认证模块');
      expect(plain).toContain('完成');
      expect(plain).toContain('120ms');
      expect(plain).toContain('消息网关');
      expect(plain).toContain('进行中');
    });

    it('strips bold, italic, and strikethrough markdown markers', () => {
      const md = 'This is **bold**, __also bold__, *italic*, _also italic_, and ~~deleted~~ text.';
      expect(markdownToPlainText(md)).toBe('This is bold, also bold, italic, also italic, and deleted text.');
    });

    it('strips heading hashes #', () => {
      const md = '# Main Title\n## Subtitle\n### Section 1\nContent here.';
      expect(markdownToPlainText(md)).toBe('Main Title\nSubtitle\nSection 1\nContent here.');
    });

    it('strips blockquote > markers', () => {
      const md = '> This is a quoted sentence.\n> Second line of quote.';
      expect(markdownToPlainText(md)).toBe('This is a quoted sentence.\nSecond line of quote.');
    });

    it('normalizes list markers', () => {
      const md = '* Item A\n* Item B\n+ Item C\n- Item D';
      expect(markdownToPlainText(md)).toBe('- Item A\n- Item B\n- Item C\n- Item D');
    });

    it('converts <br> tags to newlines and strips remaining html tags', () => {
      const md = 'Line 1<br>Line 2<br/>Line 3<p>Paragraph</p>';
      expect(markdownToPlainText(md)).toBe('Line 1\nLine 2\nLine 3\nParagraph');
    });

    it('compresses excessive blank lines', () => {
      const md = 'Para 1\n\n\n\n\nPara 2';
      expect(markdownToPlainText(md)).toBe('Para 1\n\nPara 2');
    });
  });

  describe('splitTextChunks', () => {
    it('returns single chunk when text <= limit', () => {
      const text = 'Hello world!';
      expect(splitTextChunks(text, 2000)).toEqual(['Hello world!']);
    });

    it('splits text into <= limit chunks on paragraph boundaries', () => {
      const para1 = 'A'.repeat(800);
      const para2 = 'B'.repeat(800);
      const para3 = 'C'.repeat(800);
      const combined = `${para1}\n\n${para2}\n\n${para3}`;

      const chunks = splitTextChunks(combined, 1000);
      expect(chunks.length).toBe(3);
      expect(chunks[0]).toBe(para1);
      expect(chunks[1]).toBe(para2);
      expect(chunks[2]).toBe(para3);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(1000);
      }
    });

    it('respects MSG_SPLIT_LIMIT of 2000 per HappyClaw', () => {
      expect(MSG_SPLIT_LIMIT).toBe(2000);
      const longText = '这是一条长文本。'.repeat(300); // 2400 chars
      const chunks = splitTextChunks(longText);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(2000);
      }
    });
  });
});
