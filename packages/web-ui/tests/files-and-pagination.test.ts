/**
 * Unit and DOM Invariant Tests for Files Workbench & Chat Message Pagination
 *
 * Verifies:
 * 1. Files Workbench Upload & Drag/Drop structures, bounded concurrency, cancelability, and XHR progress
 * 2. Files 409 Conflict handling, ETag resolution, and explicit overwrite confirmation (no auto-overwrite)
 * 3. Native streaming download via real <a> elements with download attribute (no memory buffering)
 * 4. Directory non-downloadability and size/type formatting
 * 5. Chat pagination logic: singleflight, deduplication, scroll anchor delta, session reset, loop prevention
 * 6. CSP & Strict Security: Zero innerHTML, Zero inline styles, Zero inline property handlers, Zero console.log
 * 7. English & Chinese localization completeness for Files and Pagination
 */

import { describe, it, expect } from 'vitest';
import { getWebUiIndexHtml, getWebUiAsset } from '../src/index.js';
import { catalogs, en, zhCN } from '../src/static/i18n.js';

describe('Files Workbench & Chat Pagination Unit & Security Tests', () => {
  const jsAsset = getWebUiAsset('app.js');
  const jsCode = jsAsset.content.toString('utf-8');
  const cssAsset = getWebUiAsset('style.css');
  const cssCode = cssAsset.content.toString('utf-8');
  const html = getWebUiIndexHtml();

  describe('1. Files Workbench UI & Upload Pipeline', () => {
    it('defines file upload queue and bounded concurrency state in app.js', () => {
      expect(jsCode).toContain('fileUploadQueue: []');
      expect(jsCode).toContain('activeUploadCount: 0');
      expect(jsCode).toContain('filesDropZoneActive: false');
      expect(jsCode).toContain('const MAX_CONCURRENT = 2');
    });

    it('implements single file multipart upload via XMLHttpRequest with X-Enkeep-CSRF, Idempotency-Key, and progress listeners', () => {
      expect(jsCode).toContain('function uploadSingleFile(');
      expect(jsCode).toContain('new XMLHttpRequest()');
      expect(jsCode).toContain("xhr.setRequestHeader('Idempotency-Key'");
      expect(jsCode).toContain("xhr.setRequestHeader('X-Enkeep-CSRF'");
      expect(jsCode).toContain("xhr.upload.addEventListener('progress'");
      expect(jsCode).toContain("xhr.addEventListener('load'");
      expect(jsCode).toContain("xhr.addEventListener('error'");
      expect(jsCode).toContain("xhr.addEventListener('abort'");
      expect(jsCode).toContain("new FormData()");
      expect(jsCode).toContain("formData.append('file'");
    });

    it('enforces 409 Conflict detection and explicit user overwrite confirmation with ETag', () => {
      expect(jsCode).toContain('xhr.status === 409 && !item.isOverwrite');
      expect(jsCode).toContain('files.confirmOverwrite');
      expect(jsCode).toContain('showConfirmDialog(');
      expect(jsCode).toContain("overwrite=true");
      expect(jsCode).toContain("xhr.setRequestHeader('If-Match'");
      expect(jsCode).toContain('item.isOverwrite = true');
    });

    it('implements cancelable uploads via xhr.abort()', () => {
      expect(jsCode).toContain('item.xhr.abort()');
      expect(jsCode).toContain("item.status = 'cancelled'");
      expect(jsCode).toContain('files.uploadCancelled');
    });

    it('provides drag & drop zone support with visual active state', () => {
      expect(jsCode).toContain('files-dropzone');
      expect(jsCode).toContain('files-dropzone-active');
      expect(jsCode).toContain("addEventListener('dragover'");
      expect(jsCode).toContain("addEventListener('dragenter'");
      expect(jsCode).toContain("addEventListener('dragleave'");
      expect(jsCode).toContain("addEventListener('drop'");
      expect(cssCode).toContain('.files-dropzone');
      expect(cssCode).toContain('.files-dropzone-active');
    });

    it('implements streaming browser download via anchor download attribute without memory blob buffering', () => {
      expect(jsCode).toContain('function triggerNativeDownload(');
      expect(jsCode).toContain("document.createElement('a')");
      expect(jsCode).toContain('anchor.href = downloadUrl');
      expect(jsCode).toContain('anchor.download = filename');
      expect(jsCode).toContain('anchor.click()');
      expect(jsCode).toContain('anchor.remove()');
      expect(jsCode).toContain('/files/download?path=');
    });

    it('disallows downloading directories and renders download button only for files', () => {
      expect(jsCode).toContain('if (!isDir) {');
      expect(jsCode).toContain('btnDownload');
      expect(jsCode).toContain('files.btnDownload');
    });

    it('includes upload tray and progress bar CSS components', () => {
      expect(cssCode).toContain('.files-upload-tray');
      expect(cssCode).toContain('.files-upload-item');
      expect(cssCode).toContain('.files-upload-progress-bar-bg');
      expect(cssCode).toContain('.files-upload-progress-bar-fill');
    });
  });

  describe('2. Chat Message Pagination & History Loading', () => {
    it('defines message pagination state in app.js', () => {
      expect(jsCode).toContain('hasMoreMessages: false');
      expect(jsCode).toContain('isLoadingOlderMessages: false');
      expect(jsCode).toContain('loadOlderError: null');
      expect(jsCode).toContain('olderMessagesCursor: null');
      expect(jsCode).not.toContain('olderCursor: null');
      expect(jsCode).not.toContain('state.olderCursor');
    });

    it('initial load requests initial 50 messages and sets hasMore flag', () => {
      expect(jsCode).toContain('/api/sessions/${sessionId}/messages?limit=50');
      expect(jsCode).toContain('state.hasMoreMessages = Boolean(');
      expect(jsCode).toContain('state.olderMessagesCursor =');
      expect(jsCode).not.toContain('state.olderCursor');
    });

    it('loadOlderMessages enforces singleflight, state.olderMessagesCursor, and no nextCursor in message loading', () => {
      expect(jsCode).toContain('if (state.isLoadingOlderMessages || !state.hasMoreMessages || !cursor) return;');
      expect(jsCode).toContain('state.isLoadingOlderMessages = true');
      expect(jsCode).toContain('/messages?limit=50&before=');
      expect(jsCode).toContain('const cursor = state.olderMessagesCursor;');
      const messageLoadBlock = jsCode.slice(
        jsCode.indexOf('async function loadMessages('),
        jsCode.indexOf('function renderMessages(')
      );
      expect(messageLoadBlock).not.toContain('res.data.nextCursor');
      expect(messageLoadBlock).not.toContain('nextCursor');
      expect(jsCode).toContain('state.eventCursor = res.data.nextCursor');
    });

    it('deduplicates and prepends loaded older messages by public message ID', () => {
      expect(jsCode).toContain('const existingIds = new Set(state.messages.map((m) => m.id))');
      expect(jsCode).toContain('const filtered = olderMessages.filter((m) => !existingIds.has(m.id))');
      expect(jsCode).toContain('state.messages = [...filtered, ...state.messages]');
    });

    it('maintains visual scroll position via scrollHeight delta', () => {
      expect(jsCode).toContain('const prevScrollHeight = container ? container.scrollHeight : 0');
      expect(jsCode).toContain('const prevScrollTop = container ? container.scrollTop : 0');
      expect(jsCode).toContain('container.scrollTop = (newScrollHeight - prevScrollHeight) + prevScrollTop');
    });

    it('prevents infinite loops when initial message count is small or hasMore is false', () => {
      expect(jsCode).toContain('if (messagesContainer.scrollTop < 80)');
      expect(jsCode).toContain('state.hasMoreMessages && !state.isLoadingOlderMessages');
    });

    it('clears and resets pagination state on session switch', () => {
      expect(jsCode).toContain('state.olderMessagesCursor = null');
      expect(jsCode).toContain('state.eventCursor = null');
      expect(jsCode).not.toContain('state.olderCursor');
    });

    it('provides accessible Load Older button, loading spinner, and retry button on failure', () => {
      expect(jsCode).toContain('chat-pagination-bar');
      expect(jsCode).toContain('btn-load-older-messages');
      expect(jsCode).toContain('chat-pagination-loading');
      expect(jsCode).toContain('btn-retry-load-older');
      expect(cssCode).toContain('.chat-pagination-bar');
      expect(cssCode).toContain('.btn-load-older');
      expect(cssCode).toContain('.chat-pagination-spinner');
      expect(cssCode).toContain('.chat-pagination-retry-btn');
    });
  });

  describe('3. Strict Security & CSP Compliance', () => {
    it('enforces zero innerHTML and insertAdjacentHTML across entire app.js', () => {
      expect(jsCode).not.toContain('.innerHTML');
      expect(jsCode).not.toContain('.insertAdjacentHTML');
    });

    it('enforces zero inline style attributes in app.js and index.html', () => {
      expect(jsCode).not.toContain('.style.');
      expect(jsCode).not.toContain(".setAttribute('style'");
      expect(jsCode).not.toContain('.setAttribute("style"');
      expect(html).not.toMatch(/<[^>]+style\s*=/i);
    });

    it('enforces zero inline event property handlers in app.js', () => {
      expect(jsCode).not.toMatch(/\.on[a-zA-Z]+\s*=/);
    });

    it('enforces zero console.log in app.js', () => {
      expect(jsCode).not.toContain('console.log(');
    });
  });

  describe('4. Localization Completeness for Files & Pagination', () => {
    const requiredKeys = [
      'files.btnUpload',
      'files.btnCancelUpload',
      'files.btnDownload',
      'files.btnDownloadFile',
      'files.btnDownloadSelected',
      'files.cannotDownloadDir',
      'files.confirmOverwrite',
      'files.confirmOverwriteTitle',
      'files.dragDropActive',
      'files.dragDropZone',
      'files.uploadProgress',
      'files.uploadSuccess',
      'files.uploadFailed',
      'files.uploadCancelled',
      'files.uploadInProgress',
      'files.batchUploadComplete',
      'chat.loadOlder',
      'chat.loadOlderAria',
      'chat.loadingOlder',
      'chat.loadOlderFailed',
      'chat.retryLoadOlder',
      'chat.noOlderMessages',
    ];

    it('contains all required Files & Pagination keys in both English and Simplified Chinese catalogs', () => {
      for (const key of requiredKeys) {
        expect(key in en, `Missing English key "${key}"`).toBe(true);
        expect(key in zhCN, `Missing Simplified Chinese key "${key}"`).toBe(true);
        expect(en[key as keyof typeof en].trim().length).toBeGreaterThan(0);
        expect(zhCN[key as keyof typeof zhCN].trim().length).toBeGreaterThan(0);
      }
    });
  });
});
