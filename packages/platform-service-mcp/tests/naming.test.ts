/**
 * Canonical Tool Naming & Sanitization Unit Tests
 *
 * @module @enkeep/platform-service-mcp/tests/naming.test
 */

import { describe, it, expect } from 'vitest';
import {
  toContributionKeySlug,
  sanitizeRawToolName,
  buildCanonicalToolName,
  isValidCanonicalToolName,
  parseCanonicalToolName,
} from '../src/naming.js';

describe('MCP Canonical Tool Naming & Sanitization', () => {
  describe('toContributionKeySlug', () => {
    it('preserves clean alphanumeric slugs with dashes and underscores', () => {
      expect(toContributionKeySlug('github')).toBe('github');
      expect(toContributionKeySlug('sqlite-db_1')).toBe('sqlite-db_1');
      expect(toContributionKeySlug('test-stdio-server')).toBe('test-stdio-server');
    });

    it('sanitizes invalid characters and collapses multiple underscores', () => {
      expect(toContributionKeySlug('git.hub@service')).toBe('git_hub_service');
      expect(toContributionKeySlug('server__with__double')).toBe('server_with_double');
      expect(toContributionKeySlug('___my_server___')).toBe('my_server');
    });

    it('falls back to "server" for empty or non-string inputs', () => {
      expect(toContributionKeySlug('')).toBe('server');
      expect(toContributionKeySlug('!!!')).toBe('server');
      expect(toContributionKeySlug(null as any)).toBe('server');
    });
  });

  describe('sanitizeRawToolName', () => {
    it('preserves clean tool names matching [A-Za-z0-9_.-]+ without double underscores', () => {
      expect(sanitizeRawToolName('echo')).toBe('echo');
      expect(sanitizeRawToolName('add')).toBe('add');
      expect(sanitizeRawToolName('create_issue')).toBe('create_issue');
      expect(sanitizeRawToolName('list.items-v1')).toBe('list.items-v1');
    });

    it('sanitizes invalid characters and collapses multiple underscores', () => {
      expect(sanitizeRawToolName('create.issue@v1')).toBe('create.issue_v1');
      expect(sanitizeRawToolName('tool__with__double')).toBe('tool_with_double');
      expect(sanitizeRawToolName('___clean_tool___')).toBe('clean_tool');
    });

    it('falls back to "tool" for empty or non-string inputs', () => {
      expect(sanitizeRawToolName('')).toBe('tool');
      expect(sanitizeRawToolName('$$$')).toBe('tool');
      expect(sanitizeRawToolName(null as any)).toBe('tool');
    });
  });

  describe('buildCanonicalToolName', () => {
    it('constructs canonical mcp__<slug>__<rawToolName> names', () => {
      expect(buildCanonicalToolName('github', 'create_issue')).toBe('mcp__github__create_issue');
      expect(buildCanonicalToolName('test-stdio-server', 'echo')).toBe('mcp__test-stdio-server__echo');
      expect(buildCanonicalToolName('sqlite_contrib', 'read_query')).toBe('mcp__sqlite_contrib__read_query');
    });

    it('sanitizes both slug and tool name preventing segment ambiguity', () => {
      expect(buildCanonicalToolName('my__server', 'tool__action')).toBe('mcp__my_server__tool_action');
    });
  });

  describe('isValidCanonicalToolName', () => {
    it('accepts valid canonical 3-segment tool names', () => {
      expect(isValidCanonicalToolName('mcp__github__create_issue')).toBe(true);
      expect(isValidCanonicalToolName('mcp__test-stdio-server__echo')).toBe(true);
      expect(isValidCanonicalToolName('mcp__sqlite__read.query-1')).toBe(true);
    });

    it('rejects non-canonical names (bare, old server__add, malformed, extra segments)', () => {
      expect(isValidCanonicalToolName('add')).toBe(false);
      expect(isValidCanonicalToolName('server__add')).toBe(false);
      expect(isValidCanonicalToolName('mcp__add')).toBe(false);
      expect(isValidCanonicalToolName('mcp____add')).toBe(false);
      expect(isValidCanonicalToolName('mcp__server__')).toBe(false);
      expect(isValidCanonicalToolName('mcp__server__add__extra')).toBe(false);
      expect(isValidCanonicalToolName('notmcp__server__add')).toBe(false);
      expect(isValidCanonicalToolName('mcp__server$name__add')).toBe(false);
      expect(isValidCanonicalToolName('mcp__server__add tool')).toBe(false);
      expect(isValidCanonicalToolName('')).toBe(false);
      expect(isValidCanonicalToolName(null as any)).toBe(false);
    });
  });

  describe('parseCanonicalToolName', () => {
    it('parses valid canonical names into slug and rawToolName', () => {
      expect(parseCanonicalToolName('mcp__github__create_issue')).toEqual({
        slug: 'github',
        rawToolName: 'create_issue',
      });
      expect(parseCanonicalToolName('mcp__test-stdio-server__echo')).toEqual({
        slug: 'test-stdio-server',
        rawToolName: 'echo',
      });
    });

    it('returns null for invalid or ambiguous names', () => {
      expect(parseCanonicalToolName('add')).toBeNull();
      expect(parseCanonicalToolName('server__add')).toBeNull();
      expect(parseCanonicalToolName('mcp__server__add__extra')).toBeNull();
    });
  });
});
