/**
 * Content Normalization, Spill Bounding, and Safe Result Formatting for MCP Tools
 *
 * Normalizes raw MCP response blocks (text, image, resource, audio) to DSH ContentBlock / McpExecutionResult:
 * - Text: Flattened and bounded. If length exceeds maxInlineBytes (default 64KB), spills to session spill store or creates a head-tail bounded preview.
 * - Image: Validates media type (PNG, JPEG, WebP, GIF) and base64.
 * - Resource Link / Embedded Resource: Formats safely without leaking internal secrets.
 * - Safe Error Handling: Transforms raw errors into sanitized messages, preventing stack traces or credential leaks from reaching the model.
 *
 * @module @enkeep/dsh-mcp-governance/normalizer
 */

import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { TextRetainer } from '@deepseek-ai/dsh-output-retention';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type {
  RawMcpCallToolResult,
  RawMcpContentBlock,
  McpExecutionResult,
  SpillStoreService,
} from './types.js';

export const DEFAULT_MAX_INLINE_BYTES = 64 * 1024; // 64 KB

const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const CANONICAL_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRawMcpContentBlock(block: unknown): block is RawMcpContentBlock {
  return isRecord(block) && typeof block.type === 'string';
}

/**
 * Normalizes a raw tool execution result from PlatformClient into a canonical McpExecutionResult
 * and formatted ContentBlock array.
 *
 * @param result - Raw result from server
 * @param toolName - Public tool name for diagnostics
 * @param maxInlineBytes - Maximum allowed inline byte length before spill/truncation
 * @param ctx - Cordis context (optional, for spill store access)
 * @param sessionId - Session identifier for spill ownership
 * @returns Normalized McpExecutionResult and ContentBlock[]
 */
export async function normalizeMcpResult(
  rawInput: RawMcpCallToolResult,
  toolName: string,
  maxInlineBytes = DEFAULT_MAX_INLINE_BYTES,
  ctx?: Context,
  sessionId?: string
): Promise<{
  value: McpExecutionResult;
  content: ContentBlock[];
  isError: boolean;
}> {
  const result: RawMcpCallToolResult =
    isRecord(rawInput) && isRecord(rawInput.data) && (Array.isArray(rawInput.data.content) || rawInput.data.isError !== undefined || rawInput.data.toolResult !== undefined)
      ? (rawInput.data as RawMcpCallToolResult)
      : rawInput;

  // Check explicit error flag from MCP protocol
  if (result.isError === true) {
    const errorText = extractTextContent(result.content, toolName);
    const sanitizedError = sanitizeErrorMessage(errorText || 'Tool execution failed');
    return {
      value: {
        content: [{ type: 'text', text: sanitizedError }],
      },
      content: [{ type: 'text', text: sanitizedError }],
      isError: true,
    };
  }

  // Handle legacy or non-array content
  let rawBlocks: readonly RawMcpContentBlock[] = [];
  if (Array.isArray(result.content)) {
    rawBlocks = result.content;
  } else if ('toolResult' in result && result.toolResult !== undefined) {
    rawBlocks = [
      {
        type: 'text',
        text: typeof result.toolResult === 'string' ? result.toolResult : JSON.stringify(result.toolResult),
      },
    ];
  } else {
    rawBlocks = [{ type: 'text', text: '(no output)' }];
  }

  const jsonBlocks: JsonValue[] = [];
  const contentBlocks: ContentBlock[] = [];
  const textRuns: string[] = [];

  const flushText = async (): Promise<void> => {
    if (textRuns.length === 0) return;
    const combined = textRuns.splice(0).join('\n');
    const bounded = await boundTextContent(combined, toolName, maxInlineBytes, ctx, sessionId);
    contentBlocks.push({ type: 'text', text: bounded });
  };

  for (const block of rawBlocks) {
    if (!isRawMcpContentBlock(block)) {
      textRuns.push('[unsupported MCP content block: expected object]');
      jsonBlocks.push({ type: 'text', text: '[unsupported block]' });
      continue;
    }

    const type = block.type || 'text';
    jsonBlocks.push(block as unknown as JsonValue);

    switch (type) {
      case 'text': {
        const text = typeof block.text === 'string' ? block.text : '';
        textRuns.push(text);
        break;
      }
      case 'image': {
        await flushText();
        const mimeType = block.mimeType;
        const data = block.data;
        if (
          typeof mimeType === 'string' &&
          IMAGE_MEDIA_TYPES.has(mimeType) &&
          typeof data === 'string' &&
          CANONICAL_BASE64_PATTERN.test(data)
        ) {
          contentBlocks.push({
            type: 'text',
            text: `[MCP Image: ${mimeType} (${Math.round((data.length * 3) / 4)} bytes)]`,
          });
        } else {
          contentBlocks.push({
            type: 'text',
            text: `[image unavailable: ${mimeType || 'unknown format'}; invalid image data]`,
          });
        }
        break;
      }
      case 'resource_link': {
        const name = typeof block.name === 'string' ? block.name : 'resource';
        const uri = typeof block.uri === 'string' ? sanitizeUri(block.uri) : 'unknown://';
        textRuns.push(`Resource Link: ${name} (${uri})`);
        break;
      }
      case 'resource': {
        textRuns.push('[embedded resource received; raw data available in execution record]');
        break;
      }
      case 'audio': {
        textRuns.push('[audio content received; raw data available in execution record]');
        break;
      }
      default: {
        textRuns.push(`[unsupported MCP content type: ${type}]`);
        break;
      }
    }
  }

  await flushText();

  const finalContent: ContentBlock[] =
    contentBlocks.length > 0
      ? contentBlocks
      : [{ type: 'text', text: `(${toolName} returned no model-visible content)` }];

  const value: McpExecutionResult = {
    content: jsonBlocks,
    ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
  };

  return {
    value,
    content: finalContent,
    isError: false,
  };
}

/**
 * Bounds text content: if under budget, returns as-is; if exceeding maxInlineBytes,
 * attempts to persist via ctx.spillStore, or applies head/tail truncation.
 */
async function boundTextContent(
  text: string,
  toolName: string,
  maxInlineBytes: number,
  ctx?: Context,
  sessionId?: string
): Promise<string> {
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength <= maxInlineBytes) {
    return text;
  }

  // 1. Try ctx.spillStore if available and sessionId present
  const spillStore: SpillStoreService | undefined = ctx?.get
    ? (ctx.get('spillStore') as SpillStoreService | undefined)
    : (ctx as unknown as { spillStore?: SpillStoreService })?.spillStore;

  if (spillStore && typeof spillStore.saveText === 'function' && sessionId) {
    try {
      const spillRef = await spillStore.saveText({
        owner: sessionId,
        suggestedName: toolName,
        source: 'tool',
        toolName,
        content: text,
      });

      const headBytes = Math.min(Math.floor(maxInlineBytes / 2), 1024);
      const tailBytes = Math.min(Math.floor(maxInlineBytes / 2), 1024);
      const retainer = new TextRetainer({ kind: 'headTail', headBytes, tailBytes });
      retainer.push(text);
      const preview = retainer.finish();

      return `${preview}\n\n[Full output (${byteLength} bytes) spilled to ${spillRef.locator}. ${spillRef.guidance || 'Use file tools to inspect.'}]`;
    } catch {
      // Fall through to in-memory head/tail bounding if spill storage fails
    }
  }

  // 2. In-memory Head/Tail Bounding
  const headBytes = Math.floor(maxInlineBytes / 2);
  const tailBytes = Math.floor(maxInlineBytes / 2);
  const retainer = new TextRetainer({ kind: 'headTail', headBytes, tailBytes });
  retainer.push(text);
  const preview = retainer.finish();
  const omittedBytes = byteLength - maxInlineBytes;

  return `${preview}\n\n[... ${omittedBytes} bytes omitted exceeding ${maxInlineBytes} byte limit ...]`;
}

/**
 * Extracts concatenated text from content blocks.
 */
function extractTextContent(content?: readonly RawMcpContentBlock[], toolName = 'tool'): string {
  if (!content || !Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block)) {
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      } else if (typeof block.message === 'string') {
        parts.push(block.message);
      }
    }
  }
  return parts.join('\n') || `(${toolName} execution error)`;
}

/**
 * Sanitizes error messages to prevent internal server stack traces or token leaks.
 */
export function sanitizeErrorMessage(rawError: string): string {
  if (!rawError || typeof rawError !== 'string') return 'Unknown tool execution error';

  // Strip obvious node stack traces
  const lines = rawError.split('\n');
  const safeLines: string[] = [];
  for (const line of lines) {
    if (
      line.trim().startsWith('at ') ||
      line.includes('node_modules') ||
      line.includes('/internal/') ||
      line.includes('node:internal')
    ) {
      continue;
    }
    // Scrub authorization headers / bearer tokens
    const scrubbed = line
      .replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, 'Bearer [REDACTED]')
      .replace(/token=[A-Za-z0-9_\-\.]+/gi, 'token=[REDACTED]')
      .replace(/password=[^\s&]+/gi, 'password=[REDACTED]');
    safeLines.push(scrubbed);
  }

  return safeLines.join('\n').trim() || 'Tool execution encountered an error';
}

/**
 * Sanitizes URI strings.
 */
function sanitizeUri(uri: string): string {
  try {
    const parsed = new URL(uri);
    if (parsed.password || parsed.username) {
      parsed.username = '';
      parsed.password = '';
    }
    return parsed.toString();
  } catch {
    return uri.replace(/[?&](?:token|key|secret|password)=[^&]*/gi, '');
  }
}
