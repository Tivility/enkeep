/**
 * Feishu Markdown Card formatting and safe boundary chunking.
 * Implements fence protection, heading demotion (H1->H4, H2..H6->H5),
 * table `<br>` padding, and code-block-safe chunking at 4000 chars.
 *
 * Distilled from HappyClaw (feishu-markdown-style.ts, feishu-streaming-card.ts).
 *
 * @module @enkeep/channel-lark/markdown-card
 */

/**
 * Optimize Markdown style for Feishu CardKit Schema 2.0 rendering.
 *
 * Key transformations:
 * 1. Code block protection (preserve code blocks during transformations)
 * 2. Heading demotion: H1 -> H4, H2..H6 -> H5 (card headings are disproportionately large)
 * 3. Table spacing: `<br>` padding around tables
 * 4. Restore code blocks with `<br>` wrapping
 * 5. Excessive blank line compression (3+ -> 2)
 * 6. Strip non-img_ image references
 */
export function optimizeMarkdownStyle(text: string): string {
  if (!text || typeof text !== 'string') return '';

  try {
    let r = _optimizeMarkdownStyle(text);
    r = stripInvalidImageKeys(r);
    return r;
  } catch {
    return text;
  }
}

function _optimizeMarkdownStyle(text: string): string {
  // 1. Extract code blocks, protect with placeholders
  const MARK = '___CB_';
  const codeBlocks: string[] = [];
  let r = text.replace(/```[\s\S]*?```/g, (m) => {
    return `${MARK}${codeBlocks.push(m) - 1}___`;
  });

  // 2. Heading demotion (only when text contains H1~H3)
  const hasH1toH3 = /^#{1,3} /m.test(text);
  if (hasH1toH3) {
    r = r.replace(/^#{2,6} (.+)$/gm, '##### $1'); // H2~H6 -> H5
    r = r.replace(/^# (.+)$/gm, '#### $1'); // H1 -> H4
  }

  // 3. Consecutive heading spacing
  r = r.replace(/^(#{4,5} .+)\n{1,2}(#{4,5} )/gm, '$1\n<br>\n$2');

  // 4. Table spacing
  // 4a. Non-table line followed by table line -> add blank line
  r = r.replace(/^([^|\n].*)\n(\|.+\|)/gm, '$1\n\n$2');
  // 4b. Table block preceded by blank line -> insert <br>
  r = r.replace(/\n\n((?:\|.+\|[^\S\n]*\n?)+)/g, '\n\n<br>\n\n$1');
  // 4c. Table block trailing -> append <br>
  r = r.replace(/((?:^\|.+\|[^\S\n]*\n?)+)/gm, '$1\n<br>\n');
  // 4d. Plain text before table: collapse extra blank lines
  r = r.replace(/^((?!#{4,5} )(?!\*\*).+)\n\n(<br>)\n\n(\|)/gm, '$1\n$2\n$3');
  // 4d2. Bold text before table
  r = r.replace(/^(\*\*.+)\n\n(<br>)\n\n(\|)/gm, '$1\n$2\n\n$3');
  // 4e. Plain text after table: collapse extra blank lines
  r = r.replace(/(\|[^\n]*\n)\n(<br>\n)((?!#{4,5} )(?!\*\*))/gm, '$1$2$3');

  // 5. Restore code blocks with <br> wrapping
  // Replacer function prevents $& / $1 replacement corruption
  codeBlocks.forEach((block, i) => {
    r = r.replace(`${MARK}${i}___`, () => `\n<br>\n${block}\n<br>\n`);
  });

  // 6. Compress excessive blank lines (3+ -> 2)
  r = r.replace(/\n{3,}/g, '\n\n');

  return r;
}

const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

/**
 * Strips `![alt](value)` where value is not a valid Feishu image key (`img_xxx`).
 */
export function stripInvalidImageKeys(text: string): string {
  if (!text.includes('![')) return text;
  return text.replace(IMAGE_RE, (fullMatch, _alt, value) => {
    if (value.startsWith('img_')) return fullMatch;
    return '';
  });
}

export interface CodeBlockRange {
  open: number;
  close: number;
  lang: string;
}

/**
 * Scan text for fenced code block ranges (``` ... ```).
 */
export function findCodeBlockRanges(text: string): CodeBlockRange[] {
  const ranges: CodeBlockRange[] = [];
  const regex = /^```(\w*)\s*$/gm;
  let match: RegExpExecArray | null;
  let openMatch: RegExpExecArray | null = null;
  let openLang = '';

  while ((match = regex.exec(text)) !== null) {
    if (!openMatch) {
      openMatch = match;
      openLang = match[1] || '';
    } else {
      ranges.push({
        open: openMatch.index,
        close: match.index + match[0].length,
        lang: openLang,
      });
      openMatch = null;
      openLang = '';
    }
  }

  // Unclosed code block - treat from open to end of text
  if (openMatch) {
    ranges.push({
      open: openMatch.index,
      close: text.length,
      lang: openLang,
    });
  }

  return ranges;
}

/**
 * Check if a position falls strictly inside a code block range.
 */
export function findContainingBlock(pos: number, ranges: CodeBlockRange[]): CodeBlockRange | null {
  for (const r of ranges) {
    if (pos > r.open && pos < r.close) return r;
  }
  return null;
}

/**
 * Splits text respecting fenced code block boundaries and paragraph breaks.
 * Ensures chunks do not exceed `maxLen` characters (default 4000 for Feishu markdown element).
 * When splitting inside a code block, safely closes the block in the first chunk
 * and reopens it with the same language tag in the subsequent chunk.
 */
export function chunkMarkdown(text: string, maxLen = 4000): string[] {
  if (!text || text.length <= maxLen) {
    return [text || ''];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    const ranges = findCodeBlockRanges(remaining);

    // Find a split point around maxLen
    let idx = remaining.lastIndexOf('\n\n', maxLen);
    if (idx < maxLen * 0.3) idx = remaining.lastIndexOf('\n', maxLen);
    if (idx < maxLen * 0.3) idx = maxLen;

    const block = findContainingBlock(idx, ranges);

    if (block) {
      // Split point is inside a code block
      if (block.open > 0 && block.open > maxLen * 0.3) {
        // Retreat to just before the code block opening
        const retreatIdx = remaining.lastIndexOf('\n', block.open);
        idx = retreatIdx > maxLen * 0.3 ? retreatIdx : block.open;
        chunks.push(remaining.slice(0, idx).trimEnd());
        remaining = remaining.slice(idx).replace(/^\n+/, '');
      } else {
        // Block starts too early to retreat - split inside but close/reopen fence
        const chunk = remaining.slice(0, idx).trimEnd() + '\n```';
        chunks.push(chunk);
        const reopener = '```' + block.lang + '\n';
        remaining = reopener + remaining.slice(idx).replace(/^\n/, '');
      }
    } else {
      chunks.push(remaining.slice(0, idx).trimEnd());
      remaining = remaining.slice(idx).replace(/^\n+/, '');
    }
  }

  if (remaining && remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Feishu CardKit Schema 2.0 Native Table Component Integration (Fix C5)
// ---------------------------------------------------------------------------

export interface LarkCardTableColumn {
  name: string;
  display_name: string;
  data_type: 'lark_md' | 'text';
  width: string;
  align?: 'left' | 'center' | 'right';
}

export interface LarkCardTableHeaderStyle {
  text_align: 'left' | 'center' | 'right';
  text_size: 'normal' | 'heading' | string;
  background_style: 'grey' | 'default' | 'none' | string;
  text_color: 'default' | 'grey' | string;
  bold: boolean;
  lines: number;
}

export interface LarkCardTableElement {
  tag: 'table';
  page_size: number;
  row_height: 'low' | 'middle' | 'high';
  header_style: LarkCardTableHeaderStyle;
  columns: LarkCardTableColumn[];
  rows: Array<Record<string, string>>;
}

export interface LarkCardMarkdownElement {
  tag: 'markdown';
  content: string;
}

export type LarkCardBodyElement =
  | LarkCardMarkdownElement
  | LarkCardTableElement
  | { tag: string; [key: string]: any };

export type LarkCardElement = LarkCardBodyElement;

/**
 * Splits a Markdown table row into individual cell strings.
 * Safely handles escaped pipes (`\|`) and pipes inside inline code (`` `...` ``).
 */
export function splitTableRow(rowText: string): string[] {
  let content = rowText.trim();
  if (content.startsWith('|')) {
    content = content.slice(1);
  }
  if (content.endsWith('|') && !content.endsWith('\\|')) {
    content = content.slice(0, -1);
  }

  const cells: string[] = [];
  let current = '';
  let i = 0;

  while (i < content.length) {
    const ch = content[i];

    // Escaped pipe \|
    if (ch === '\\' && i + 1 < content.length && content[i + 1] === '|') {
      current += '|';
      i += 2;
      continue;
    }

    // Code span: count backticks
    if (ch === '`') {
      let runLen = 1;
      while (i + runLen < content.length && content[i + runLen] === '`') {
        runLen++;
      }
      const ticks = '`'.repeat(runLen);
      current += ticks;
      i += runLen;

      // Find matching closing ticks
      const closeIdx = content.indexOf(ticks, i);
      if (closeIdx !== -1) {
        current += content.slice(i, closeIdx + runLen);
        i = closeIdx + runLen;
      }
      continue;
    }

    if (ch === '|') {
      cells.push(current.trim());
      current = '';
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  cells.push(current.trim());
  return cells;
}

/**
 * Checks whether a row matches GFM table delimiter syntax (e.g. `| --- | :---: | ---: |`).
 */
export function isDelimiterRow(rowText: string): boolean {
  const trimmed = rowText.trim();
  if (!trimmed.includes('-')) return false;
  if (!trimmed.includes('|')) return false;

  const cells = splitTableRow(trimmed);
  if (cells.length === 0) return false;

  for (const cell of cells) {
    if (!/^:?-{1,}:?$/.test(cell)) {
      return false;
    }
  }

  return true;
}

/**
 * Parses column text alignment from a delimiter cell (`:---:` -> center, `---:` -> right, `:---` -> left).
 */
export function parseColumnAlignment(cell: string): 'left' | 'center' | 'right' | undefined {
  const trimmed = cell.trim();
  const startsWithColon = trimmed.startsWith(':');
  const endsWithColon = trimmed.endsWith(':');

  if (startsWithColon && endsWithColon) {
    return 'center';
  }
  if (endsWithColon) {
    return 'right';
  }
  if (startsWithColon) {
    return 'left';
  }
  return undefined;
}

/**
 * Parses GFM table markdown lines into a Feishu Schema 2.0 native `table` element.
 */
export function parseMarkdownTable(input: string[] | string): LarkCardTableElement | null {
  const lines = (Array.isArray(input) ? input : input.split('\n'))
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) return null;

  const headerLine = lines[0];
  const delimiterLine = lines[1];

  if (!isDelimiterRow(delimiterLine)) return null;

  const delimiterCells = splitTableRow(delimiterLine);
  const headerCells = splitTableRow(headerLine);

  if (delimiterCells.length === 0) return null;

  const numCols = delimiterCells.length;

  const columns: LarkCardTableColumn[] = delimiterCells.map((delimCell, idx) => {
    const rawHeader = headerCells[idx] ?? '';
    const align = parseColumnAlignment(delimCell);
    const col: LarkCardTableColumn = {
      name: `c${idx}`,
      display_name: rawHeader || ' ',
      data_type: 'lark_md',
      width: 'auto',
    };
    if (align) {
      col.align = align;
    }
    return col;
  });

  const bodyLines = lines.slice(2);
  const rows: Array<Record<string, string>> = [];

  for (const bodyLine of bodyLines) {
    if (isDelimiterRow(bodyLine)) continue;
    const cells = splitTableRow(bodyLine);
    const rowObj: Record<string, string> = {};
    for (let i = 0; i < numCols; i++) {
      rowObj[`c${i}`] = cells[i] ?? '';
    }
    rows.push(rowObj);
  }

  return {
    tag: 'table',
    page_size: Math.min(10, Math.max(1, rows.length || 1)),
    row_height: 'low',
    header_style: {
      text_align: 'left',
      text_size: 'normal',
      background_style: 'grey',
      text_color: 'default',
      bold: true,
      lines: 1,
    },
    columns,
    rows,
  };
}

export interface MarkdownToCardElementsOptions {
  maxChunkLen?: number;
  emptyFallback?: string;
}

/**
 * Transforms Markdown content into a sequence of Feishu Schema 2.0 CardKit body elements.
 * GFM pipe tables are parsed into native `table` containers with adaptive columns and lark_md cells.
 * Non-table text is safely chunked (at code block / paragraph boundaries) into `markdown` elements.
 * The original sequential ordering between text, code blocks, and tables is preserved.
 */
export function markdownToCardElements(
  text: string,
  options?: MarkdownToCardElementsOptions | number
): LarkCardBodyElement[] {
  if (!text || typeof text !== 'string') {
    const fallback = typeof options === 'object' ? options?.emptyFallback : undefined;
    return fallback ? [{ tag: 'markdown', content: fallback }] : [];
  }

  const maxChunkLen =
    typeof options === 'number'
      ? options
      : options?.maxChunkLen ?? 4000;
  const emptyFallback =
    typeof options === 'object' ? options?.emptyFallback : undefined;

  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');

  const elements: LarkCardBodyElement[] = [];
  let lastTextIndex = 0;

  let inCodeBlock = false;
  let codeFence = '';

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Track fenced code blocks to prevent parsing tables inside code fences
    if (!inCodeBlock) {
      const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
      if (fenceMatch) {
        inCodeBlock = true;
        codeFence = fenceMatch[1];
        i++;
        continue;
      }
    } else {
      if (trimmed.startsWith(codeFence)) {
        inCodeBlock = false;
        codeFence = '';
      }
      i++;
      continue;
    }

    // Outside code blocks, check for table start (header row + delimiter row)
    if (i + 1 < lines.length && trimmed !== '') {
      const nextLine = lines[i + 1];
      if (isDelimiterRow(nextLine)) {
        const headerCells = splitTableRow(trimmed);
        const delimiterCells = splitTableRow(nextLine);

        const isTable =
          delimiterCells.length >= 2 ||
          (delimiterCells.length === 1 && trimmed.startsWith('|') && trimmed.endsWith('|'));

        if (isTable && headerCells.length > 0) {
          // Flush any preceding non-table text
          if (lastTextIndex < i) {
            let textSegment = lines.slice(lastTextIndex, i).join('\n').trim();
            // Strip any artificial trailing <br> that may have surrounded table
            textSegment = textSegment.replace(/(?:<br>\s*)+$/, '').trim();
            if (textSegment) {
              const optimized = optimizeMarkdownStyle(textSegment);
              const chunks = chunkMarkdown(optimized, maxChunkLen);
              for (const chunk of chunks) {
                if (chunk.trim()) {
                  elements.push({ tag: 'markdown', content: chunk });
                }
              }
            }
          }

          // Gather table rows
          let tableEnd = i + 2;
          while (tableEnd < lines.length) {
            const tableLineTrimmed = lines[tableEnd].trim();
            if (tableLineTrimmed === '') break;
            if (tableLineTrimmed.startsWith('```') || tableLineTrimmed.startsWith('~~~')) break;
            if (!tableLineTrimmed.includes('|')) break;
            tableEnd++;
          }

          const tableLines = lines.slice(i, tableEnd);
          const tableElement = parseMarkdownTable(tableLines);
          if (tableElement) {
            elements.push(tableElement);
          } else {
            // Fallback: emit as markdown if table parsing failed
            const rawTable = tableLines.join('\n');
            const optimized = optimizeMarkdownStyle(rawTable);
            elements.push({ tag: 'markdown', content: optimized });
          }

          lastTextIndex = tableEnd;
          i = tableEnd;
          continue;
        }
      }
    }

    i++;
  }

  // Flush remaining non-table text
  if (lastTextIndex < lines.length) {
    let remaining = lines.slice(lastTextIndex).join('\n').trim();
    // Strip any artificial leading <br>
    remaining = remaining.replace(/^(?:\s*<br>)+/, '').trim();
    if (remaining) {
      const optimized = optimizeMarkdownStyle(remaining);
      const chunks = chunkMarkdown(optimized, maxChunkLen);
      for (const chunk of chunks) {
        if (chunk.trim()) {
          elements.push({ tag: 'markdown', content: chunk });
        }
      }
    }
  }

  if (elements.length === 0 && emptyFallback) {
    elements.push({ tag: 'markdown', content: emptyFallback });
  }

  return elements;
}

/** Alias for markdownToCardElements */
export const buildCardElementsFromMarkdown = markdownToCardElements;

