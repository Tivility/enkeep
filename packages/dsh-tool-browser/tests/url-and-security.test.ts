/**
 * URL Validation, Bounding, and Error Sanitization Tests for @enkeep/dsh-tool-browser
 *
 * Validates:
 * 1. Safe URL protocols (http, https).
 * 2. Strict rejection of javascript:, file:, data:, vbscript:, null bytes, malformed URLs, overly long URLs.
 * 3. Output bounding on DOM snapshots.
 * 4. Error sanitization (stripping internal paths and stack traces).
 *
 * @module @enkeep/dsh-tool-browser/tests/url-and-security.test
 */

import { describe, it, expect } from 'vitest';
import {
  validateSafeUrl,
  boundSnapshot,
  sanitizeBrowserError,
  DEFAULT_MAX_SNAPSHOT_LENGTH,
} from '../src/security.js';
import { BrowserToolError, BrowserToolErrorCode } from '../src/errors.js';

describe('dsh-tool-browser: Security & Bounding', () => {
  describe('validateSafeUrl', () => {
    it('accepts valid HTTPS and HTTP URLs', () => {
      expect(validateSafeUrl('https://example.com')).toBe('https://example.com/');
      expect(validateSafeUrl('http://127.0.0.1:8080/path?query=1#hash')).toBe('http://127.0.0.1:8080/path?query=1#hash');
      expect(validateSafeUrl('https://sub.domain.org/foo/bar')).toBe('https://sub.domain.org/foo/bar');
    });

    it('rejects dangerous javascript: schemes', () => {
      expect(() => validateSafeUrl('javascript:alert(document.cookie)')).toThrowError(
        expect.objectContaining({ code: BrowserToolErrorCode.UNSAFE_URL })
      );
      expect(() => validateSafeUrl('JAVASCRIPT:void(0)')).toThrowError(
        expect.objectContaining({ code: BrowserToolErrorCode.UNSAFE_URL })
      );
    });

    it('rejects file: and data: schemes', () => {
      expect(() => validateSafeUrl('file:///etc/passwd')).toThrowError(
        expect.objectContaining({ code: BrowserToolErrorCode.UNSAFE_URL })
      );
      expect(() => validateSafeUrl('data:text/html,<script>alert(1)</script>')).toThrowError(
        expect.objectContaining({ code: BrowserToolErrorCode.UNSAFE_URL })
      );
    });

    it('rejects vbscript: and unknown schemes', () => {
      expect(() => validateSafeUrl('vbscript:msgbox(1)')).toThrowError(
        expect.objectContaining({ code: BrowserToolErrorCode.UNSAFE_URL })
      );
      expect(() => validateSafeUrl('gopher://old.internet.org')).toThrowError(
        expect.objectContaining({ code: BrowserToolErrorCode.UNSAFE_URL })
      );
    });

    it('rejects null byte injection and empty strings', () => {
      expect(() => validateSafeUrl('https://example.com/\0evil')).toThrowError(
        expect.objectContaining({ code: BrowserToolErrorCode.UNSAFE_URL })
      );
      expect(() => validateSafeUrl('')).toThrowError(
        expect.objectContaining({ code: BrowserToolErrorCode.UNSAFE_URL })
      );
      expect(() => validateSafeUrl('   ')).toThrowError(
        expect.objectContaining({ code: BrowserToolErrorCode.UNSAFE_URL })
      );
    });

    it('rejects URLs exceeding MAX_URL_LENGTH (2048)', () => {
      const longUrl = 'https://example.com/' + 'a'.repeat(2100);
      expect(() => validateSafeUrl(longUrl)).toThrowError(
        expect.objectContaining({ code: BrowserToolErrorCode.UNSAFE_URL })
      );
    });
  });

  describe('boundSnapshot', () => {
    it('preserves snapshots within limit', () => {
      const normalSnapshot = '<div><h1>Title</h1><button>Click</button></div>';
      expect(boundSnapshot(normalSnapshot, 100)).toBe(normalSnapshot);
    });

    it('truncates oversized snapshots with clear notice', () => {
      const oversized = 'a'.repeat(1000);
      const bounded = boundSnapshot(oversized, 500);
      expect(bounded.startsWith('a'.repeat(500))).toBe(true);
      expect(bounded).toContain('[Snapshot truncated: 1000 total chars exceeded limit of 500 chars]');
    });
  });

  describe('sanitizeBrowserError', () => {
    it('formats BrowserToolError with clean code and message', () => {
      const err = new BrowserToolError('Target element not found', BrowserToolErrorCode.ELEMENT_NOT_FOUND, 404);
      expect(sanitizeBrowserError(err)).toBe('[Browser Error ELEMENT_NOT_FOUND] Target element not found');
    });

    it('strips internal filesystem paths from generic errors', () => {
      const err = new Error('Failed to open /var/lib/docker/overlay2/data/internal-file.sock: connection refused');
      const sanitized = sanitizeBrowserError(err);
      expect(sanitized).not.toContain('/var/lib/docker');
      expect(sanitized).toContain('<path>');
    });
  });
});
