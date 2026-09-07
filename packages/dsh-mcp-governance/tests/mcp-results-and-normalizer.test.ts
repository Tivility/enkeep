/**
 * MCP Results Normalization, Content Bounding & Error Sanitization Tests for @enkeep/dsh-mcp-governance
 *
 * @module @enkeep/dsh-mcp-governance/tests/mcp-results-and-normalizer.test
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeMcpResult,
  sanitizeErrorMessage,
} from '../src/index.js';

describe('dsh-mcp-governance: Results & Normalizer', () => {
  describe('1. Content Normalization', () => {
    it('normalizes standard text blocks into canonical format', async () => {
      const raw = {
        content: [
          { type: 'text', text: 'Hello from MCP' },
          { type: 'text', text: 'Second line' },
        ],
      };

      const result = await normalizeMcpResult(raw, 'mcp__test__tool');
      expect(result.isError).toBe(false);
      expect(result.content).toEqual([
        { type: 'text', text: 'Hello from MCP\nSecond line' },
      ]);
      expect(result.value.content).toHaveLength(2);
    });

    it('validates and formats valid base64 image blocks', async () => {
      const validPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
      const raw = {
        content: [
          {
            type: 'image',
            mimeType: 'image/png',
            data: validPngBase64,
          },
        ],
      };

      const result = await normalizeMcpResult(raw, 'mcp__test__img');
      expect(result.isError).toBe(false);
      expect(result.content[0].type).toBe('text');
      expect((result.content[0] as any).text).toContain('[MCP Image: image/png');
    });

    it('handles structuredContent transparently', async () => {
      const raw = {
        content: [{ type: 'text', text: 'Data returned' }],
        structuredContent: { count: 42, items: ['a', 'b'] },
      };

      const result = await normalizeMcpResult(raw, 'mcp__test__structured');
      expect(result.isError).toBe(false);
      expect(result.value.structuredContent).toEqual({ count: 42, items: ['a', 'b'] });
    });
  });

  describe('2. Content Bounding (maxInlineBytes)', () => {
    it('bounds oversized text content within maxInlineBytes limit', async () => {
      const hugeText = 'X'.repeat(100_000); // 100 KB
      const raw = {
        content: [{ type: 'text', text: hugeText }],
      };

      const maxBytes = 10_000; // 10 KB
      const result = await normalizeMcpResult(raw, 'mcp__test__huge', maxBytes);

      expect(result.content[0].type).toBe('text');
      const rendered = (result.content[0] as any).text;
      expect(rendered).toContain('bytes omitted exceeding 10000 byte limit');
      expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThan(20_000);
    });
  });

  describe('3. Error Sanitization', () => {
    it('scrubs node stack traces and internal module paths', () => {
      const dirtyError = `Error: Connection failed
    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1605:16)
    at /app/node_modules/pg/lib/connection.js:56:12
    at Object.<anonymous> (/internal/process/task_queues.js:95:5)`;

      const clean = sanitizeErrorMessage(dirtyError);
      expect(clean).not.toContain('at TCPConnectWrap');
      expect(clean).not.toContain('node_modules');
      expect(clean).not.toContain('/internal/');
      expect(clean).toContain('Error: Connection failed');
    });

    it('scrubs bearer tokens and sensitive credentials from error messages', () => {
      const dirtyError = 'Failed to connect to upstream with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 and password=SuperSecretPassword123';
      const clean = sanitizeErrorMessage(dirtyError);

      expect(clean).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
      expect(clean).not.toContain('SuperSecretPassword123');
      expect(clean).toContain('Bearer [REDACTED]');
      expect(clean).toContain('password=[REDACTED]');
    });
  });
});
