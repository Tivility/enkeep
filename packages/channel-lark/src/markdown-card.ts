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
