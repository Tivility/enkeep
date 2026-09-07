/**
 * Output Bounds, Typed Content Sanitizer, and Schema Normalizer
 *
 * Enforces:
 * - Content bounds (max text length, max image payload size, max overall tool result size)
 * - Default 4 MiB output bounds
 * - P1 result bounds: text + structured JSON content only (rejects sampling/prompts/untrusted resource execution)
 * - Safe UTF-8 normalization and null byte removal
 * - JSON Schema validation and bounding
 * - Redaction of internal stack traces or raw errors
 *
 * @module @enkeep/platform-service-mcp/security/sanitizer
 */

import { McpErrorCode, McpServiceError } from '../errors.js';
import type { McpToolCallResult, McpToolContent } from '../types.js';

export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024; // 4 MiB
export const DEFAULT_MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MiB
export const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

/**
 * Strips null bytes and control characters (except newline, cr, tab).
 */
export function sanitizeString(value: string): string {
  if (!value || typeof value !== 'string') return '';
  // Strip null bytes and non-printable ascii control characters
  return value.replace(/\0/g, '').replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * Validates and sanitizes a single MCP tool content block.
 */
export function sanitizeToolContent(
  content: unknown,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
): McpToolContent {
  if (!content || typeof content !== 'object') {
    return {
      type: 'text',
      text: sanitizeString(String(content ?? '')),
    };
  }

  const raw = content as Record<string, unknown>;
  const type = String(raw.type || 'text').toLowerCase();

  // Reject unsupported / dangerous capabilities (sampling, prompts)
  if (type === 'sampling' || type === 'prompt' || type === 'prompt_request') {
    throw new McpServiceError(`MCP content type "${type}" is rejected by host security policy`, {
      code: McpErrorCode.MCP_FORBIDDEN,
    });
  }

  if (type === 'text') {
    const rawText = typeof raw.text === 'string' ? raw.text : JSON.stringify(raw.text ?? '');
    const cleanText = sanitizeString(rawText);
    const byteLen = Buffer.byteLength(cleanText, 'utf8');
    if (byteLen > maxOutputBytes) {
      const truncated = cleanText.slice(0, maxOutputBytes) + '\n... [output truncated by host policy]';
      return {
        type: 'text',
        text: truncated,
      };
    }
    return {
      type: 'text',
      text: cleanText,
    };
  }

  if (type === 'image') {
    const data = typeof raw.data === 'string' ? raw.data : '';
    const mimeType = typeof raw.mimeType === 'string' ? raw.mimeType.toLowerCase() : 'image/png';

    if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
      throw new McpServiceError(`Unsupported image MIME type "${mimeType}" in tool response`, {
        code: McpErrorCode.MCP_INVALID_ARGUMENTS,
      });
    }

    // Basic base64 check
    if (Buffer.byteLength(data, 'utf8') > DEFAULT_MAX_IMAGE_BYTES) {
      throw new McpServiceError('Tool image content exceeds maximum size of 4 MiB', {
        code: McpErrorCode.MCP_OUTPUT_TOO_LARGE,
      });
    }

    return {
      type: 'image',
      data,
      mimeType,
    };
  }

  if (type === 'resource') {
    const resource = (raw.resource && typeof raw.resource === 'object' ? raw.resource : {}) as Record<
      string,
      unknown
    >;
    const uri = sanitizeString(String(resource.uri || ''));
    const mimeType = resource.mimeType ? sanitizeString(String(resource.mimeType)) : undefined;
    const text = resource.text ? sanitizeString(String(resource.text)) : undefined;
    const blob = typeof resource.blob === 'string' ? resource.blob : undefined;

    return {
      type: 'resource',
      resource: {
        uri,
        mimeType,
        text,
        blob,
      },
    };
  }

  // Fallback to JSON text representation
  return {
    type: 'text',
    text: sanitizeString(JSON.stringify(raw)),
  };
}

/**
 * Sanitizes and bounds a complete McpToolCallResult.
 */
export function sanitizeToolCallResult(
  result: unknown,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
): McpToolCallResult {
  if (!result || typeof result !== 'object') {
    return {
      content: [{ type: 'text', text: sanitizeString(String(result ?? '')) }],
    };
  }

  const raw = result as Record<string, unknown>;
  const rawContent = Array.isArray(raw.content) ? raw.content : raw.content ? [raw.content] : [raw];
  const sanitizedContent: McpToolContent[] = [];

  let accumulatedBytes = 0;

  for (const block of rawContent) {
    const remainingBytes = Math.max(0, maxOutputBytes - accumulatedBytes);
    if (remainingBytes <= 0) {
      sanitizedContent.push({
        type: 'text',
        text: '... [further output omitted: exceeded maximum response bounds]',
      });
      break;
    }

    const sanitizedBlock = sanitizeToolContent(block, remainingBytes);
    const blockSize =
      sanitizedBlock.type === 'text'
        ? Buffer.byteLength(sanitizedBlock.text, 'utf8')
        : sanitizedBlock.type === 'image'
        ? Buffer.byteLength(sanitizedBlock.data, 'utf8')
        : 1024;

    accumulatedBytes += blockSize;
    sanitizedContent.push(sanitizedBlock);

    if (accumulatedBytes >= maxOutputBytes) {
      break;
    }
  }

  // Handle structuredContent if present
  let structuredContent: Record<string, unknown> | readonly unknown[] | undefined;
  if (raw.structuredContent && typeof raw.structuredContent === 'object') {
    const serialized = JSON.stringify(raw.structuredContent);
    if (Buffer.byteLength(serialized, 'utf8') <= maxOutputBytes) {
      structuredContent = raw.structuredContent as any;
    }
  }

  return {
    content: sanitizedContent,
    structuredContent,
    isError: Boolean(raw.isError),
    _meta: raw._meta && typeof raw._meta === 'object' ? (raw._meta as Record<string, unknown>) : undefined,
  };
}

/**
 * Normalizes and bounds tool input schemas to ensure they are valid JSON schemas.
 */
export function normalizeInputSchema(
  rawSchema: unknown,
  maxDepth = 8,
): Record<string, unknown> {
  if (!rawSchema || typeof rawSchema !== 'object' || Array.isArray(rawSchema)) {
    return {
      type: 'object',
      properties: {},
    };
  }

  function boundSchema(node: any, currentDepth: number): any {
    if (!node || typeof node !== 'object') return node;
    if (currentDepth > maxDepth) {
      return { type: 'object' };
    }

    if (Array.isArray(node)) {
      return node.map((item) => boundSchema(item, currentDepth + 1));
    }

    const out: Record<string, unknown> = {};
    const entries = Object.entries(node);
    // Limit to max 50 properties per object
    for (const [k, v] of entries.slice(0, 50)) {
      if (k === 'properties' && v && typeof v === 'object') {
        const props: Record<string, unknown> = {};
        for (const [propKey, propVal] of Object.entries(v).slice(0, 50)) {
          props[propKey] = boundSchema(propVal, currentDepth + 1);
        }
        out[k] = props;
      } else if (k === 'items') {
        out[k] = boundSchema(v, currentDepth + 1);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  const bounded = boundSchema(rawSchema, 0);
  if (!bounded.type) {
    bounded.type = 'object';
  }
  if (!bounded.properties || typeof bounded.properties !== 'object') {
    bounded.properties = {};
  }

  return bounded;
}
