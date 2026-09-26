/**
 * Markdown to Plain Text and Final Answer Extraction for WeChat Channel.
 * Sensibly formats tables, code blocks, and links while stripping thinking/reasoning tags.
 *
 * @module @enkeep/channel-wechat/markdown
 */

import { MSG_SPLIT_LIMIT, splitTextChunks } from './http.js';

export { MSG_SPLIT_LIMIT, splitTextChunks };

export interface WeChatFinalAnswerInput {
  readonly replyText?: string;
  readonly finalText?: string;
  readonly final_text?: string;
  readonly finalAnswerText?: string;
  readonly executionResult?: {
    readonly replyText?: string;
    readonly finalText?: string;
    readonly final_text?: string;
  };
}

/**
 * Extracts only the final user-facing answer text from turn completion payload.
 *
 * Contract:
 * 1. Prefers explicit final text fields from runtime (finalText, final_text, finalAnswerText).
 * 2. If K1 is not yet merged and only replyText is provided, filters out thinking/reasoning blocks
 *    (e.g., <think>...</think>, <thought>...</thought>, ```thought...```, and structured reasoning blocks)
 *    to prevent model internal monologue from leaking into WeChat chat.
 */
export function extractFinalAnswerText(input: WeChatFinalAnswerInput | Record<string, unknown> | string | null | undefined): string {
  if (!input) return '';

  if (typeof input === 'string') {
    return cleanThinking(input);
  }

  const obj = input as WeChatFinalAnswerInput;
  const execRes = obj.executionResult as { finalText?: string; final_text?: string; replyText?: string } | undefined;

  const candidate =
    obj.finalText ??
    obj.final_text ??
    obj.finalAnswerText ??
    execRes?.finalText ??
    execRes?.final_text ??
    obj.replyText ??
    execRes?.replyText ??
    '';

  if (typeof candidate !== 'string') return '';

  return cleanThinking(candidate);
}

/**
 * Strips model thinking/reasoning monologue from text.
 */
export function cleanThinking(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';

  let text = raw.trim();

  // If candidate is a JSON serialized array of content blocks (DSH/Claude event protocol)
  if ((text.startsWith('[') && text.endsWith(']')) || (text.startsWith('{') && text.endsWith('}'))) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        const textPieces: string[] = [];
        for (const block of parsed) {
          if (block && typeof block === 'object') {
            const b = block as Record<string, unknown>;
            if (b.type === 'text' && typeof b.text === 'string') {
              textPieces.push(b.text);
            }
          }
        }
        if (textPieces.length > 0) {
          text = textPieces.join('');
        }
      } else if (parsed && typeof parsed === 'object') {
        const p = parsed as Record<string, unknown>;
        const content = p.content ?? (p.message as Record<string, unknown> | undefined)?.content;
        if (Array.isArray(content)) {
          const textPieces: string[] = [];
          for (const block of content) {
            if (block && typeof block === 'object') {
              const b = block as Record<string, unknown>;
              if (b.type === 'text' && typeof b.text === 'string') {
                textPieces.push(b.text);
              }
            }
          }
          if (textPieces.length > 0) {
            text = textPieces.join('');
          }
        }
      }
    } catch {
      // Not JSON, proceed with string replacement
    }
  }

  // Remove XML-style reasoning tags
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  text = text.replace(/<thought>[\s\S]*?<\/thought>/gi, '');
  text = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
  text = text.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '');

  // Handle leading unclosed <think> tag that ends with </think>
  text = text.replace(/^<think>[\s\S]*?<\/think>\s*/gi, '');

  // Remove markdown fenced thought blocks
  text = text.replace(/```(?:thought|thinking|reasoning)[\s\S]*?```/gi, '');

  return text.trim();
}

/**
 * Calculates visual display width of a string (ASCII = 1, CJK fullwidth = 2).
 */
export function getDisplayWidth(str: string): number {
  let width = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    // CJK characters, fullwidth punctuation and symbols
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x20000 && code <= 0x2a6df) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0x3000 && code <= 0x303f)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/**
 * Checks if a line is a Markdown table separator/divider row (| :--- | :--- |).
 */
function isTableDivider(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('-')) return false;
  const row = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  const cells = row.split('|');
  if (cells.length === 0) return false;
  return cells.every((c) => /^\s*:?-{2,}:?\s*$/.test(c));
}

/**
 * Checks if a line is a potential Markdown table row.
 */
function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  if (isTableDivider(line)) return false;
  return true;
}

/**
 * Sensibly formats Markdown table lines into clean aligned plain text.
 * Strips noisy divider rows (|:---|) and outer pipes (|).
 */
export function formatTable(tableLines: string[]): string {
  const rows = tableLines.map((line) => {
    const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    return trimmed.split('|').map((c) => c.trim());
  });

  if (rows.length === 0) return '';

  const numCols = Math.max(...rows.map((r) => r.length));
  const colWidths: number[] = new Array(numCols).fill(0);

  for (const row of rows) {
    for (let c = 0; c < numCols; c++) {
      const cellText = row[c] ?? '';
      const w = getDisplayWidth(cellText);
      if (w > colWidths[c]) {
        colWidths[c] = w;
      }
    }
  }

  // Cap column width to 40 characters to avoid excessive whitespace
  const MAX_COL_WIDTH = 40;
  for (let c = 0; c < numCols; c++) {
    if (colWidths[c] > MAX_COL_WIDTH) {
      colWidths[c] = MAX_COL_WIDTH;
    }
  }

  const formattedRows = rows.map((row) => {
    const formattedCells = [];
    for (let c = 0; c < numCols; c++) {
      const cellText = row[c] ?? '';
      const targetWidth = colWidths[c];
      const curWidth = getDisplayWidth(cellText);
      if (curWidth < targetWidth) {
        formattedCells.push(cellText + ' '.repeat(targetWidth - curWidth));
      } else {
        formattedCells.push(cellText);
      }
    }
    return formattedCells.join(' | ');
  });

  return formattedRows.join('\n');
}

/**
 * Scans markdown text and replaces Markdown tables with cleanly aligned plain text.
 */
function renderMarkdownTables(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (i + 1 < lines.length && isTableRow(line) && isTableDivider(lines[i + 1])) {
      const tableLines: string[] = [line];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) {
        tableLines.push(lines[i]);
        i++;
      }
      result.push(formatTable(tableLines));
    } else {
      result.push(line);
      i++;
    }
  }

  return result.join('\n');
}

/**
 * Converts Markdown text to natural, readable plain text for WeChat IM clients.
 *
 * Implements:
 * 1. Code blocks: protected from inline styling, fences stripped cleanly.
 * 2. Inline code: backticks stripped cleanly.
 * 3. Tables: sensible plain-text column alignment with separator rows removed.
 * 4. Links: [text](url) -> "text (url)" (or plain url when text matches url).
 * 5. Images: ![alt](url) -> "[图片: alt] (url)" or "[图片]".
 * 6. Headings: "# heading" -> "heading".
 * 7. Emphasis: **bold**, __bold__, ~~strike~~, *italic*, _italic_ stripped.
 * 8. Blockquotes: "> quote" -> "quote".
 * 9. Lists: bullet normalization (*, + -> -).
 * 10. Horizontal rules: stripped.
 * 11. HTML line breaks: <br> -> \n.
 */
export function markdownToPlainText(md: string): string {
  if (!md || typeof md !== 'string') return '';

  let text = md.replace(/\r\n/g, '\n');

  // 1. Protect code blocks to avoid formatting code content as markdown
  const codeBlocks: string[] = [];
  text = text.replace(/```[^\n]*\n?([\s\S]*?)\n?```/g, (_m, code) => {
    const idx = codeBlocks.push(code) - 1;
    return `\u0000CB_${idx}\u0000`;
  });

  // 2. Protect inline code
  const inlineCodes: string[] = [];
  text = text.replace(/`([^`\n]+)`/g, (_m, code) => {
    const idx = inlineCodes.push(code) - 1;
    return `\u0000IC_${idx}\u0000`;
  });

  // 3. Render tables
  text = renderMarkdownTables(text);

  // 4. Render images
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, url) => {
    const cleanAlt = alt.trim();
    const cleanUrl = url.trim();
    if (cleanAlt) {
      return `[图片: ${cleanAlt}] (${cleanUrl})`;
    }
    return `[图片] (${cleanUrl})`;
  });

  // 5. Render links
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, linkText, url) => {
    const t = linkText.trim();
    const u = url.trim();
    if (!t || t === u) {
      return u;
    }
    return `${t} (${u})`;
  });

  // 6. Autolinks
  text = text.replace(/<(https?:\/\/[^>]+)>/g, '$1');

  // 7. Headings
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '$1');

  // 8. Blockquotes
  text = text.replace(/^>\s?(.*)$/gm, '$1');

  // 9. Horizontal rules
  text = text.replace(/^(?:[-*_]\s*){3,}$/gm, '');

  // 10. List markers
  text = text.replace(/^(\s*)[*+]\s+/gm, '$1- ');

  // 11. Bold, strikethrough, italic
  text = text.replace(/\*\*(.+?)\*\*/g, '$1');
  text = text.replace(/__(.+?)__/g, '$1');
  text = text.replace(/~~(.+?)~~/g, '$1');
  text = text.replace(/(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '$1');
  text = text.replace(/(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)/g, '$1');

  // 12. HTML tags
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<hr\s*\/?>/gi, '\n');
  text = text.replace(/<\/?(p|div)\b[^>]*>/gi, '\n');
  text = text.replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, '');

  // 13. Restore inline code
  text = text.replace(/\u0000IC_(\d+)\u0000/g, (_m, idx) => {
    return inlineCodes[Number(idx)] ?? '';
  });

  // 14. Restore code blocks
  text = text.replace(/\u0000CB_(\d+)\u0000/g, (_m, idx) => {
    return codeBlocks[Number(idx)] ?? '';
  });

  // 15. Whitespace compression
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return text;
}
