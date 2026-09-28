import { describe, it, expect } from 'vitest';
import {
  splitTableRow,
  isDelimiterRow,
  parseColumnAlignment,
  parseMarkdownTable,
  markdownToCardElements,
  buildCardElementsFromMarkdown,
  optimizeMarkdownStyle,
  chunkMarkdown,
  type LarkCardTableElement,
  type LarkCardMarkdownElement,
} from '../src/markdown-card.js';

describe('Fix C5: Markdown Table to Lark Schema 2.0 Native Table Element', () => {
  describe('splitTableRow', () => {
    it('splits standard pipe-enclosed rows and trims cell contents', () => {
      const row = '| Header 1 |  Header 2  | Header 3 |';
      const cells = splitTableRow(row);
      expect(cells).toEqual(['Header 1', 'Header 2', 'Header 3']);
    });

    it('splits rows without leading or trailing outer pipes', () => {
      const row = 'Col A | Col B | Col C';
      const cells = splitTableRow(row);
      expect(cells).toEqual(['Col A', 'Col B', 'Col C']);
    });

    it('respects escaped pipes (\\|) without splitting cells', () => {
      const row = '| File \\| Path | Description |';
      const cells = splitTableRow(row);
      expect(cells).toEqual(['File | Path', 'Description']);
    });

    it('respects pipes inside inline code spans', () => {
      const row = '| Command | Syntax `ls | grep foo` | Result |';
      const cells = splitTableRow(row);
      expect(cells).toEqual(['Command', 'Syntax `ls | grep foo`', 'Result']);
    });

    it('respects pipes inside double-backtick code spans', () => {
      const row = '| Key | Value ``a | b`` | Note |';
      const cells = splitTableRow(row);
      expect(cells).toEqual(['Key', 'Value ``a | b``', 'Note']);
    });
  });

  describe('isDelimiterRow & parseColumnAlignment', () => {
    it('correctly detects GFM table delimiter rows', () => {
      expect(isDelimiterRow('| --- | --- |')).toBe(true);
      expect(isDelimiterRow('|:---|:---:|---:|')).toBe(true);
      expect(isDelimiterRow('--- | ---')).toBe(true);
      expect(isDelimiterRow('| - | - |')).toBe(true);
    });

    it('rejects non-delimiter lines', () => {
      expect(isDelimiterRow('---')).toBe(false); // Horizontal rule without pipes
      expect(isDelimiterRow('| Header 1 | Header 2 |')).toBe(false);
      expect(isDelimiterRow('| --- | text |')).toBe(false);
      expect(isDelimiterRow('')).toBe(false);
    });

    it('parses column text alignment from delimiter syntax', () => {
      expect(parseColumnAlignment(':---:')).toBe('center');
      expect(parseColumnAlignment('---:')).toBe('right');
      expect(parseColumnAlignment(':---')).toBe('left');
      expect(parseColumnAlignment('---')).toBeUndefined();
    });
  });

  describe('parseMarkdownTable', () => {
    it('converts a multi-column table to Feishu Schema 2.0 native table structure', () => {
      const mdTable = [
        '| Module | Status | Notes |',
        '| :--- | :---: | ---: |',
        '| `auth.ts` | ✅ Done | Security patch applied |',
        '| `token.ts` | ⚠️ Pending | Under review |',
      ];

      const tableEl = parseMarkdownTable(mdTable);
      expect(tableEl).not.toBeNull();
      if (!tableEl) return;

      expect(tableEl.tag).toBe('table');
      expect(tableEl.row_height).toBe('low');
      expect(tableEl.page_size).toBe(2);
      expect(tableEl.header_style).toEqual({
        text_align: 'left',
        text_size: 'normal',
        background_style: 'grey',
        text_color: 'default',
        bold: true,
        lines: 1,
      });

      // Columns check
      expect(tableEl.columns).toHaveLength(3);
      expect(tableEl.columns[0]).toEqual({
        name: 'c0',
        display_name: 'Module',
        data_type: 'lark_md',
        width: 'auto',
        align: 'left',
      });
      expect(tableEl.columns[1]).toEqual({
        name: 'c1',
        display_name: 'Status',
        data_type: 'lark_md',
        width: 'auto',
        align: 'center',
      });
      expect(tableEl.columns[2]).toEqual({
        name: 'c2',
        display_name: 'Notes',
        data_type: 'lark_md',
        width: 'auto',
        align: 'right',
      });

      // Rows check
      expect(tableEl.rows).toEqual([
        { c0: '`auth.ts`', c1: '✅ Done', c2: 'Security patch applied' },
        { c0: '`token.ts`', c1: '⚠️ Pending', c2: 'Under review' },
      ]);
    });

    it('supports 5-column technical comparison tables per live acceptance requirement', () => {
      const fiveColTable = `
| Capability | HappyClaw | Enkeep | Botmux | Native Feishu |
| --- | --- | --- | --- | --- |
| CardKit Schema 2.0 | Yes | Yes | Yes | Yes |
| Native Table Container | No | Yes | Yes | Yes |
| Streaming CoT Bubble | No | Opt-in | Yes | Yes |
`;

      const tableEl = parseMarkdownTable(fiveColTable);
      expect(tableEl).not.toBeNull();
      if (!tableEl) return;

      expect(tableEl.columns).toHaveLength(5);
      expect(tableEl.columns.map((c) => c.display_name)).toEqual([
        'Capability',
        'HappyClaw',
        'Enkeep',
        'Botmux',
        'Native Feishu',
      ]);
      expect(tableEl.columns.every((c) => c.data_type === 'lark_md')).toBe(true);
      expect(tableEl.columns.every((c) => c.width === 'auto')).toBe(true);

      expect(tableEl.rows).toHaveLength(3);
      expect(tableEl.rows[1]).toEqual({
        c0: 'Native Table Container',
        c1: 'No',
        c2: 'Yes',
        c3: 'Yes',
        c4: 'Yes',
      });
    });

    it('handles tables with zero body rows (header + delimiter only)', () => {
      const emptyTable = '| Col 1 | Col 2 |\n| --- | --- |';
      const tableEl = parseMarkdownTable(emptyTable);
      expect(tableEl).not.toBeNull();
      if (!tableEl) return;

      expect(tableEl.page_size).toBe(1);
      expect(tableEl.columns).toHaveLength(2);
      expect(tableEl.rows).toEqual([]);
    });

    it('caps page_size at 10 when rows exceed 10', () => {
      const lines = ['| Index | Val |', '| --- | --- |'];
      for (let i = 1; i <= 25; i++) {
        lines.push(`| ${i} | v${i} |`);
      }

      const tableEl = parseMarkdownTable(lines);
      expect(tableEl).not.toBeNull();
      if (!tableEl) return;

      expect(tableEl.rows).toHaveLength(25);
      expect(tableEl.page_size).toBe(10);
    });

    it('returns null for non-table input', () => {
      expect(parseMarkdownTable('')).toBeNull();
      expect(parseMarkdownTable('Just regular paragraph text')).toBeNull();
      expect(parseMarkdownTable(['# Heading', 'Paragraph'])).toBeNull();
    });
  });

  describe('markdownToCardElements & buildCardElementsFromMarkdown', () => {
    it('returns markdown element when markdown contains no tables', () => {
      const text = '# Overview\nThis is a standard response with **bold** text.';
      const elements = markdownToCardElements(text);

      expect(elements).toHaveLength(1);
      expect(elements[0].tag).toBe('markdown');
      // Heading demoted to H4
      expect((elements[0] as LarkCardMarkdownElement).content).toContain('#### Overview');
    });

    it('returns table element when markdown contains only a table', () => {
      const text = '| Feature | Support |\n| --- | --- |\n| Table | Supported |';
      const elements = markdownToCardElements(text);

      expect(elements).toHaveLength(1);
      expect(elements[0].tag).toBe('table');
      const tableEl = elements[0] as LarkCardTableElement;
      expect(tableEl.columns).toHaveLength(2);
      expect(tableEl.rows).toHaveLength(1);
    });

    it('preserves exact sequential ordering across mixed text, tables, and code blocks', () => {
      const doc = `
# Executive Summary
Here is the baseline performance report.

\`\`\`typescript
interface Config {
  retries: number;
}
\`\`\`

Below is the comparison matrix:

| Metric | Target | Actual |
| --- | --- | --- |
| Latency | < 200ms | 120ms |
| Error Rate | < 0.1% | 0.02% |

### Next Steps
1. Deploy to staging
2. Validate metrics

| Action | Owner |
| --- | --- |
| Staging rollout | @dev |

Final closing remarks.
`;

      const elements = markdownToCardElements(doc);

      // Expected order:
      // 1. Markdown (Executive Summary + code block + "Below is the comparison matrix:")
      // 2. Table (Comparison matrix)
      // 3. Markdown (Next steps)
      // 4. Table (Action / Owner)
      // 5. Markdown (Final closing remarks)
      expect(elements).toHaveLength(5);

      expect(elements[0].tag).toBe('markdown');
      const md0 = elements[0] as LarkCardMarkdownElement;
      expect(md0.content).toContain('#### Executive Summary');
      expect(md0.content).toContain('```typescript\ninterface Config');
      expect(md0.content).toContain('Below is the comparison matrix:');

      expect(elements[1].tag).toBe('table');
      const tbl1 = elements[1] as LarkCardTableElement;
      expect(tbl1.columns.map((c) => c.display_name)).toEqual(['Metric', 'Target', 'Actual']);
      expect(tbl1.rows).toHaveLength(2);

      expect(elements[2].tag).toBe('markdown');
      const md2 = elements[2] as LarkCardMarkdownElement;
      expect(md2.content).toContain('##### Next Steps');
      expect(md2.content).toContain('1. Deploy to staging');

      expect(elements[3].tag).toBe('table');
      const tbl3 = elements[3] as LarkCardTableElement;
      expect(tbl3.columns.map((c) => c.display_name)).toEqual(['Action', 'Owner']);
      expect(tbl3.rows).toHaveLength(1);

      expect(elements[4].tag).toBe('markdown');
      const md4 = elements[4] as LarkCardMarkdownElement;
      expect(md4.content).toContain('Final closing remarks.');
    });

    it('never extracts tables from inside fenced code blocks', () => {
      const doc = `
Here is an example markdown file containing a table:

\`\`\`markdown
# Sample Doc
| Fake | Col |
| --- | --- |
| Inside | CodeBlock |
\`\`\`

And outside is the actual table:

| Real | Col |
| --- | --- |
| 1 | 2 |
`;

      const elements = markdownToCardElements(doc);

      expect(elements).toHaveLength(2);
      expect(elements[0].tag).toBe('markdown');
      const mdEl = elements[0] as LarkCardMarkdownElement;
      expect(mdEl.content).toContain('```markdown');
      expect(mdEl.content).toContain('| Fake | Col |');

      expect(elements[1].tag).toBe('table');
      const tblEl = elements[1] as LarkCardTableElement;
      expect(tblEl.columns.map((c) => c.display_name)).toEqual(['Real', 'Col']);
      expect(tblEl.rows).toEqual([{ c0: '1', c1: '2' }]);
    });

    it('chunks long non-table text blocks safely at maxChunkLen', () => {
      const longText = 'Paragraph A: ' + 'X'.repeat(2500) + '\n\nParagraph B: ' + 'Y'.repeat(2500);
      const table = '| Key | Val |\n| --- | --- |\n| 1 | 2 |';
      const doc = `${longText}\n\n${table}`;

      const elements = markdownToCardElements(doc, { maxChunkLen: 3000 });

      // Paragraph A (~2500) -> Element 0 (markdown)
      // Paragraph B (~2500) -> Element 1 (markdown)
      // Table -> Element 2 (table)
      expect(elements).toHaveLength(3);
      expect(elements[0].tag).toBe('markdown');
      expect(elements[1].tag).toBe('markdown');
      expect(elements[2].tag).toBe('table');
    });

    it('honors emptyFallback option when text is empty', () => {
      expect(markdownToCardElements('')).toEqual([]);
      expect(markdownToCardElements('   ')).toEqual([]);
      expect(markdownToCardElements('', { emptyFallback: '(空回复)' })).toEqual([
        { tag: 'markdown', content: '(空回复)' },
      ]);
    });

    it('buildCardElementsFromMarkdown is an alias of markdownToCardElements', () => {
      const doc = '| A | B |\n| --- | --- |\n| 1 | 2 |';
      expect(buildCardElementsFromMarkdown(doc)).toEqual(markdownToCardElements(doc));
    });
  });
});
