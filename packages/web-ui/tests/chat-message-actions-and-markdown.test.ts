import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWebUiIndexHtml, getWebUiAsset } from '../src/index.js';
import { en, catalogs, SUPPORTED_LOCALES } from '../src/static/i18n.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('Chat Message Actions & Safe Markdown Renderer Test Suite', () => {
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
    it('contains edit-message modal, reply banner, and action buttons in index.html', () => {
      expect(htmlCode).toContain('id="modal-edit-message"');
      expect(htmlCode).toContain('id="edit-message-form"');
      expect(htmlCode).toContain('id="edit-message-content-input"');
      expect(htmlCode).toContain('id="edit-message-source-id"');
      expect(htmlCode).toContain('id="btn-submit-edit-message"');
      expect(htmlCode).toContain('id="composer-reply-banner"');
      expect(htmlCode).toContain('id="modal-fork-session"');
    });

    it('ensures all edit modal and reply elements have i18n data attributes', () => {
      expect(htmlCode).toContain('data-i18n="modal.editMessageTitle"');
      expect(htmlCode).toContain('data-i18n="modal.editMessageNotice"');
      expect(htmlCode).toContain('data-i18n="modal.editMessageContentLabel"');
      expect(htmlCode).toContain('data-i18n-placeholder="modal.editMessageContentPlaceholder"');
      expect(htmlCode).toContain('data-i18n="modal.editMessageButton"');
    });
  });

  describe('2. Internationalization (i18n) Completeness for Message Actions', () => {
    it('contains all required keys in en & zh-CN catalogs', () => {
      expect(SUPPORTED_LOCALES).toContain('en');
      expect(SUPPORTED_LOCALES).toContain('zh-CN');

      const enCat = catalogs['en'];
      const zhCat = catalogs['zh-CN'];

      // English Keys
      expect(enCat['chat.regenerate']).toBe('Regenerate');
      expect(enCat['chat.regenerateTitle']).toBeDefined();
      expect(enCat['chat.edit']).toBe('Edit');
      expect(enCat['chat.editTitle']).toBeDefined();
      expect(enCat['chat.reply']).toBe('Reply');
      expect(enCat['chat.replyTitle']).toBeDefined();
      expect(enCat['chat.forkSession']).toBe('🍴 Fork');
      expect(enCat['chat.forkFromHere']).toBe('Fork from here');
      expect(enCat['chat.replyingTo']).toBeDefined();
      expect(enCat['chat.cancelReply']).toBeDefined();
      expect(enCat['chat.regenerateConfirm']).toBeDefined();
      expect(enCat['chat.editConfirm']).toBeDefined();
      expect(enCat['chat.turnActiveCannotAction']).toBeDefined();
      expect(enCat['modal.editMessageTitle']).toBe('Edit User Message');
      expect(enCat['modal.editMessageButton']).toBe('Send & Branch');

      // Chinese Keys
      expect(zhCat['chat.regenerate']).toBe('重新生成');
      expect(zhCat['chat.edit']).toBe('编辑');
      expect(zhCat['chat.reply']).toBe('引用回复');
      expect(zhCat['chat.forkSession']).toBe('🍴 分支派生');
      expect(zhCat['chat.forkFromHere']).toBe('从此派生分支');
      expect(zhCat['modal.editMessageTitle']).toBe('编辑用户消息');
      expect(zhCat['modal.editMessageButton']).toBe('发送并派生分支');
    });
  });

  describe('3. CSS Styling & CSP Compliance', () => {
    it('defines styles for Markdown GFM tables with alignment classes', () => {
      expect(cssCode).toContain('.markdown-table-wrapper');
      expect(cssCode).toContain('.markdown-table');
      expect(cssCode).toContain('.markdown-table .align-left');
      expect(cssCode).toContain('.markdown-table .align-center');
      expect(cssCode).toContain('.markdown-table .align-right');
    });

    it('defines syntax highlighting CSS classes without inline styles', () => {
      expect(cssCode).toContain('.hljs-keyword');
      expect(cssCode).toContain('.hljs-string');
      expect(cssCode).toContain('.hljs-comment');
      expect(cssCode).toContain('.hljs-number');
      expect(cssCode).toContain('.hljs-built_in');
      expect(cssCode).toContain('.hljs-variable');
      expect(cssCode).toContain('.hljs-function');
      expect(cssCode).toContain('.hljs-tag');
    });

    it('defines reply quotes and composer reply banner styling', () => {
      expect(cssCode).toContain('.message-reply-quote');
      expect(cssCode).toContain('.message-reply-quote-header');
      expect(cssCode).toContain('.message-reply-quote-snippet');
      expect(cssCode).toContain('.composer-reply-banner');
      expect(cssCode).toContain('.composer-reply-info');
      expect(cssCode).toContain('.composer-reply-cancel');
      expect(cssCode).toContain('.highlight-flash');
      expect(cssCode).toContain('@keyframes messageHighlightFlash');
      expect(cssCode).toContain('.chat-rendered-image');
    });
  });

  describe('4. Logic & Security Invariants in app.js', () => {
    it('implements isSafeUrl rejecting unsafe protocols (javascript, data, vbscript)', () => {
      expect(appJsCode).toContain('function isSafeUrl(');
      expect(appJsCode).toContain('javascript|data|vbscript');
    });

    it('implements tokenizeCodeToLowlightAst with language allowlist and AST tokens', () => {
      expect(appJsCode).toContain('function tokenizeCodeToLowlightAst(');
      expect(appJsCode).toContain('HIGHLIGHT_ALLOWLIST');
      expect(appJsCode).toContain('JS_KEYWORDS');
      expect(appJsCode).toContain('PY_KEYWORDS');
      expect(appJsCode).toContain('BASH_KEYWORDS');
      expect(appJsCode).toContain('SQL_KEYWORDS');
      expect(appJsCode).toContain('hljs-keyword');
      expect(appJsCode).toContain('hljs-string');
      expect(appJsCode).toContain('hljs-number');
      expect(appJsCode).toContain('hljs-comment');
    });

    it('implements parseMarkdownTable with strict bounds (MAX_TABLE_ROWS, MAX_TABLE_COLS, MAX_TOTAL_CELLS, MAX_CELL_BYTES)', () => {
      expect(appJsCode).toContain('function parseMarkdownTable(');
      expect(appJsCode).toContain('const MAX_TABLE_ROWS = 100');
      expect(appJsCode).toContain('const MAX_TABLE_COLS = 20');
      expect(appJsCode).toContain('const MAX_TOTAL_CELLS = 1000');
      expect(appJsCode).toContain('const MAX_CELL_BYTES = 1000');
      expect(appJsCode).toContain('align-center');
      expect(appJsCode).toContain('align-right');
      expect(appJsCode).toContain('align-left');
    });

    it('implements message actions (Regenerate, Edit, Reply, Fork) with draft and active turn checks', () => {
      expect(appJsCode).toContain('function handleRegenerateMessage(');
      expect(appJsCode).toContain('function openEditMessageModal(');
      expect(appJsCode).toContain('function handleEditMessage(');
      expect(appJsCode).toContain('function setReplyMessage(');
      expect(appJsCode).toContain('function cancelReplyMessage(');
      expect(appJsCode).toContain('function renderComposerReplyBanner(');
      expect(appJsCode).toContain('btn-action-regenerate');
      expect(appJsCode).toContain('btn-action-edit');
      expect(appJsCode).toContain('btn-action-reply');
      expect(appJsCode).toContain('btn-action-fork');
      expect(appJsCode).toContain('state.hasCancellableTurn');
      expect(appJsCode).toContain('chat.turnActiveCannotAction');
      expect(appJsCode).toContain('chat.unsavedDraftWarning');
    });

    it('implements formatToolName and safe inline markdown image rendering for tool outputs and screenshots', () => {
      expect(appJsCode).toContain('function formatToolName(');
      expect(appJsCode).toContain('chat-rendered-image');
      expect(appJsCode).toContain('chat.tool_');
    });
  });
});
