/**
 * Comprehensive Unit and Invariant Test Suite for Chat Composer Attachments,
 * Attachment Tray, Workspace File Picker Modal, and Message Cards.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWebUiIndexHtml, getWebUiAsset } from '../src/index.js';
import { en, zhCN } from '../src/static/i18n.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('Chat Attachments & Composer Workspace Picker Contract', () => {
  let appJsCode: string;
  let htmlCode: string;
  let cssCode: string;

  beforeEach(() => {
    appJsCode = readFileSync(join(__dirname, '../src/static/app.js'), 'utf-8');
    htmlCode = getWebUiIndexHtml();
    const cssAsset = getWebUiAsset('style.css');
    cssCode = cssAsset.content.toString('utf-8');
  });

  describe('1. HTML Markup & Static DOM Contract', () => {
    it('contains composer attachment button, hidden multiple file input, and attachment tray in index.html', () => {
      expect(htmlCode).toContain('id="btn-attach"');
      expect(htmlCode).toContain('id="chat-file-input"');
      expect(htmlCode).toContain('type="file"');
      expect(htmlCode).toContain('multiple');
      expect(htmlCode).toContain('id="composer-attachment-tray"');
      expect(htmlCode).toContain('id="attach-menu"');
      expect(htmlCode).toContain('id="btn-attach-local"');
      expect(htmlCode).toContain('id="btn-attach-workspace"');
    });

    it('contains Workspace File Picker Modal with accessible dialog attributes', () => {
      expect(htmlCode).toContain('id="modal-file-picker"');
      expect(htmlCode).toContain('role="dialog"');
      expect(htmlCode).toContain('aria-modal="true"');
      expect(htmlCode).toContain('aria-labelledby="modal-file-picker-title"');
      expect(htmlCode).toContain('id="file-picker-search-input"');
      expect(htmlCode).toContain('id="file-picker-breadcrumbs"');
      expect(htmlCode).toContain('id="file-picker-list"');
      expect(htmlCode).toContain('id="btn-file-picker-select"');
      expect(htmlCode).toContain('id="file-picker-selected-count"');
    });

    it('ensures all static attachment elements have i18n data attributes', () => {
      expect(htmlCode).toContain('data-i18n-title="chat.attachTitle"');
      expect(htmlCode).toContain('data-i18n="chat.attachLocal"');
      expect(htmlCode).toContain('data-i18n="chat.attachWorkspace"');
      expect(htmlCode).toContain('data-i18n="modal.filePickerTitle"');
      expect(htmlCode).toContain('data-i18n-placeholder="modal.filePickerSearchPlaceholder"');
      expect(htmlCode).toContain('data-i18n="modal.filePickerSelect"');
    });
  });

  describe('2. State Management & Upload Queue Contract', () => {
    it('declares attachment state variables in app.js', () => {
      expect(appJsCode).toContain('activeAttachments: []');
      expect(appJsCode).toContain('drafts: {}');
      expect(appJsCode).toContain('composerUploadQueue: []');
      expect(appJsCode).toContain('activeComposerUploadCount: 0');
      expect(appJsCode).toContain('filePickerCurrentPath: \'.\'');
      expect(appJsCode).toContain('filePickerSelectedEntries: new Map()');
    });

    it('defines bounded concurrency (max 2) for composer uploads', () => {
      expect(appJsCode).toContain('MAX_CONCURRENT_UPLOADS = 2');
      expect(appJsCode).toContain('state.activeComposerUploadCount < MAX_CONCURRENT_UPLOADS');
    });

    it('ensures uploads directory exists before uploading without throwing on 409', () => {
      expect(appJsCode).toContain('ensureUploadsDir');
      expect(appJsCode).toContain('/files/mkdir');
      expect(appJsCode).toContain('body: { path: \'uploads\' }');
    });

    it('uploads to uploads/ directory with unique prefix to avoid conflicts and preserves displayName', () => {
      expect(appJsCode).toContain('path=uploads');
      expect(appJsCode).toContain('uuidPrefix');
      expect(appJsCode).toContain('sanitizeClientFilename');
    });
  });

  describe('3. File Validation, Prechecks & Drag/Drop/Paste', () => {
    it('enforces 10 attachments limit, 50MB single file limit, and 50MB total size limit', () => {
      expect(appJsCode).toContain('MAX_ATTACHMENTS = 10');
      expect(appJsCode).toContain('MAX_FILE_SIZE = 50 * 1024 * 1024');
      expect(appJsCode).toContain('MAX_TOTAL_SIZE = 50 * 1024 * 1024');
      expect(appJsCode).toContain('chat.maxAttachmentsExceeded');
      expect(appJsCode).toContain('chat.maxFileSizeExceeded');
      expect(appJsCode).toContain('chat.maxTotalSizeExceeded');
    });

    it('prevents duplicate attachments in active tray', () => {
      expect(appJsCode).toContain('chat.fileAlreadyAttached');
    });

    it('implements drag & drop on composer and prevents default window navigation', () => {
      expect(appJsCode).toContain('setupComposerDragAndDrop');
      expect(appJsCode).toContain('dragenter');
      expect(appJsCode).toContain('dragover');
      expect(appJsCode).toContain('dragleave');
      expect(appJsCode).toContain('drop');
      expect(appJsCode).toContain('drag-over');
    });

    it('implements image clipboard paste naming pasted-image-<timestamp>.png and keeps plain text native', () => {
      expect(appJsCode).toContain('setupComposerPasteHandler');
      expect(appJsCode).toContain('item.type && item.type.startsWith(\'image/\')');
      expect(appJsCode).toContain('pasted-image-');
      expect(appJsCode).toContain('.png');
    });
  });

  describe('4. Message Sending & Card Rendering Contract', () => {
    it('sends ready attachments [{ path, etag, displayName }] in POST message body', () => {
      expect(appJsCode).toContain('readyAttachments');
      expect(appJsCode).toContain('path: a.path');
      expect(appJsCode).toContain('etag: a.etag');
      expect(appJsCode).toContain('displayName: a.displayName');
    });

    it('clears active attachments and tray on success, restores on failure', () => {
      expect(appJsCode).toContain('state.activeAttachments = savedAttachments');
      expect(appJsCode).toContain('savedAttachments = [...state.activeAttachments]');
    });

    it('renders safe message attachment cards for user, assistant, and system messages', () => {
      expect(appJsCode).toContain('renderMessageAttachments');
      expect(appJsCode).toContain('message-attachments-container');
      expect(appJsCode).toContain('message-attachment-card');
      expect(appJsCode).toContain('message-attachment-name');
      expect(appJsCode).toContain('message-attachment-size');
      expect(appJsCode).toContain('attachment-download-btn');
    });

    it('verifies safe download link (/api/spaces/ prefix only) with download attribute and zero id/etag display', () => {
      expect(appJsCode).toContain('att.downloadUrl.startsWith(\'/api/spaces/\')');
      expect(appJsCode).toContain('downloadLink.download = displayName');
      expect(appJsCode).toContain('downloadLink.target = \'_blank\'');
      expect(appJsCode).toContain('downloadLink.rel = \'noopener noreferrer\'');
      expect(appJsCode).not.toContain('att.id +');
      expect(appJsCode).not.toContain('att.etag +');
    });
  });

  describe('5. Session Isolation, Drafts & Space Switching', () => {
    it('persists draft text and attachments per session', () => {
      expect(appJsCode).toContain('state.drafts[state.currentSessionId] = {');
      expect(appJsCode).toContain('state.drafts[sessionId]');
    });

    it('prompts confirmation when switching spaces with unsent attachments', () => {
      expect(appJsCode).toContain('chat.confirmSwitchSpaceTitle');
      expect(appJsCode).toContain('chat.confirmSwitchSpaceMessage');
      expect(appJsCode).toContain('showConfirmation(');
    });
  });

  describe('6. Internationalization (i18n) Completeness', () => {
    const requiredKeys = [
      'chat.attach',
      'chat.attachTitle',
      'chat.attachLocal',
      'chat.attachWorkspace',
      'chat.attachmentDownload',
      'chat.attachmentDownloadAria',
      'chat.attachmentsTrayAria',
      'chat.cancelUpload',
      'chat.confirmSwitchSpaceMessage',
      'chat.confirmSwitchSpaceTitle',
      'chat.dropFilesHere',
      'chat.emptyContentWithAttachments',
      'chat.fileAlreadyAttached',
      'chat.maxAttachmentsExceeded',
      'chat.maxFileSizeExceeded',
      'chat.maxTotalSizeExceeded',
      'chat.retryUpload',
      'chat.uploadFailed',
      'chat.uploadProgress',
      'chat.uploadSuccess',
      'chat.uploading',
      'modal.filePickerEmpty',
      'modal.filePickerItemAria',
      'modal.filePickerLoading',
      'modal.filePickerMaxSelected',
      'modal.filePickerNavigateUp',
      'modal.filePickerNoMatch',
      'modal.filePickerRootFolder',
      'modal.filePickerSearchAria',
      'modal.filePickerSearchPlaceholder',
      'modal.filePickerSelect',
      'modal.filePickerSelectedCount',
      'modal.filePickerTitle',
    ];

    it('contains all required attachment keys in English catalog', () => {
      for (const key of requiredKeys) {
        expect(key in en, `Missing English key: ${key}`).toBe(true);
        expect((en as any)[key].trim().length).toBeGreaterThan(0);
      }
    });

    it('contains all required attachment keys in Simplified Chinese catalog', () => {
      for (const key of requiredKeys) {
        expect(key in zhCN, `Missing Chinese key: ${key}`).toBe(true);
        expect((zhCN as any)[key].trim().length).toBeGreaterThan(0);
      }
    });
  });

  describe('7. CSS Styling & Security Invariants', () => {
    it('includes attachment tray, attachment cards, and file picker styles in style.css', () => {
      expect(cssCode).toContain('.composer-attachment-tray');
      expect(cssCode).toContain('.attachment-tray-item');
      expect(cssCode).toContain('.attachment-tray-item.status-uploading');
      expect(cssCode).toContain('.attachment-tray-item.status-error');
      expect(cssCode).toContain('.attachment-tray-item.status-ready');
      expect(cssCode).toContain('.message-attachments-container');
      expect(cssCode).toContain('.message-attachment-card');
      expect(cssCode).toContain('.file-picker-list');
      expect(cssCode).toContain('.file-picker-item');
      expect(cssCode).toContain('.file-picker-breadcrumbs');
      expect(cssCode).toContain('.visually-hidden');
    });

    it('enforces zero innerHTML across app.js', () => {
      expect(appJsCode).not.toContain('.innerHTML');
      expect(appJsCode).not.toContain('insertAdjacentHTML');
    });

    it('enforces zero inline style modifications across app.js', () => {
      expect(appJsCode).not.toMatch(/\.style\.[a-zA-Z]+\s*=/);
      expect(appJsCode).not.toMatch(/setAttribute\s*\(\s*['"]style['"]/);
    });

    it('enforces zero inline property event handlers across app.js', () => {
      expect(appJsCode).not.toMatch(/\.on[a-zA-Z]+\s*=/);
    });

    it('enforces zero console logging in app.js', () => {
      expect(appJsCode).not.toMatch(/console\.(log|debug|info|warn|error)\s*\(/);
    });
  });
});
