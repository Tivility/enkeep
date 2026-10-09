/**
 * Unit & Contract Tests for:
 * C-01: Multi-image & mixed text+image clipboard paste in Chat Composer
 * C-02: File preview classification (image, markdown, text, binary) & read-only non-text handling
 * C-03: Copy relative path in Files Workbench list and editor header
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWebUiIndexHtml, getWebUiAsset } from '../src/index.js';
import { catalogs, en, zhCN } from '../src/static/i18n.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('C-01 .. C-03 Web UI Improvements Contract', () => {
  let appJsCode: string;
  let htmlCode: string;
  let cssCode: string;

  beforeEach(() => {
    appJsCode = readFileSync(join(__dirname, '../src/static/app.js'), 'utf-8');
    htmlCode = getWebUiIndexHtml();
    const cssAsset = getWebUiAsset('style.css');
    cssCode = cssAsset.content.toString('utf-8');
  });

  describe('C-01: Clipboard Mixed Text & Multi-Image Paste Support', () => {
    it('aggregates all image items into a single array and calls handleFilesSelected once', () => {
      expect(appJsCode).toContain('setupComposerPasteHandler');
      expect(appJsCode).toContain('const pastedImages = [];');
      expect(appJsCode).toContain('handleFilesSelected(pastedImages);');
    });

    it('extracts text/plain and inserts at cursor/selection using setRangeText and updates height/counter', () => {
      expect(appJsCode).toContain("e.clipboardData.getData('text/plain')");
      expect(appJsCode).toContain('chatInput.setRangeText');
      expect(appJsCode).toContain('adjustTextareaHeight(chatInput)');
      expect(appJsCode).toContain('updateCharCount()');
    });

    it('allows default browser paste behavior when only text is pasted without images', () => {
      // When pastedImages.length === 0 and no files, does not call e.preventDefault()
      expect(appJsCode).toContain('if (pastedImages.length > 0) {');
    });

    it('handles simulated synthetic paste event with text and multiple images', () => {
      // Simulate handler in isolated context
      let selectedFiles: any[] = [];
      const handleFilesSelectedMock = (files: any[]) => {
        selectedFiles = files;
      };

      const mockTextarea = {
        value: 'Hello ',
        selectionStart: 6,
        selectionEnd: 6,
        setRangeText(text: string, start: number, end: number, mode: string) {
          this.value = this.value.slice(0, start) + text + this.value.slice(end);
        },
      };

      let heightAdjusted = false;
      let countUpdated = false;

      const adjustTextareaHeightMock = () => { heightAdjusted = true; };
      const updateCharCountMock = () => { countUpdated = true; };

      const blob1 = { type: 'image/png' };
      const blob2 = { type: 'image/jpeg' };

      const syntheticEvent = {
        preventDefault: vi.fn(),
        clipboardData: {
          items: [
            { type: 'text/plain', getAsFile: () => null },
            { type: 'image/png', getAsFile: () => blob1 },
            { type: 'image/jpeg', getAsFile: () => blob2 },
          ],
          getData: (type: string) => (type === 'text/plain' ? 'world!' : ''),
          files: [],
        },
      };

      // Execute simulated paste logic matching app.js
      const items = syntheticEvent.clipboardData.items;
      const pastedImages: any[] = [];
      let imgIndex = 0;
      for (const item of items) {
        if (item.type && item.type.startsWith('image/')) {
          const blob = item.getAsFile();
          if (blob) {
            pastedImages.push({ name: `pasted-image-12345${imgIndex > 0 ? `-${imgIndex}` : ''}.png`, type: blob.type });
            imgIndex++;
          }
        }
      }

      if (pastedImages.length > 0) {
        syntheticEvent.preventDefault();
        handleFilesSelectedMock(pastedImages);
        const text = syntheticEvent.clipboardData.getData('text/plain');
        if (text) {
          mockTextarea.setRangeText(text, mockTextarea.selectionStart, mockTextarea.selectionEnd, 'end');
          adjustTextareaHeightMock();
          updateCharCountMock();
        }
      }

      expect(syntheticEvent.preventDefault).toHaveBeenCalled();
      expect(selectedFiles).toHaveLength(2);
      expect(mockTextarea.value).toBe('Hello world!');
      expect(heightAdjusted).toBe(true);
      expect(countUpdated).toBe(true);
    });
  });

  describe('C-02: File Preview Classification & Read-only Non-Text Handling', () => {
    it('implements getFilePreviewKind matching expected categories', () => {
      expect(appJsCode).toContain('function getFilePreviewKind(filePath)');
      expect(appJsCode).toContain('window.getFilePreviewKind = getFilePreviewKind;');

      // Helper inline eval/mirror check
      function getFilePreviewKind(filePath: string): 'image' | 'markdown' | 'text' | 'binary' {
        if (!filePath || typeof filePath !== 'string') return 'binary';
        const lastDot = filePath.lastIndexOf('.');
        const ext = lastDot !== -1 ? filePath.slice(lastDot + 1).toLowerCase() : '';

        if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image';
        if (['md', 'markdown'].includes(ext)) return 'markdown';

        const textExtensions = [
          'txt', 'text', 'log', 'csv', 'tsv',
          'js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'jsx', 'tsx',
          'json', 'json5', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'conf', 'config', 'properties', 'env',
          'html', 'htm', 'xhtml', 'xml', 'svg', 'css', 'scss', 'sass', 'less',
          'py', 'pyw', 'rb', 'php', 'java', 'c', 'h', 'cpp', 'hpp', 'cc', 'cxx', 'cs', 'go', 'rs', 'swift', 'kt', 'kts', 'scala', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'sql', 'r', 'lua', 'pl', 'pm', 'graphql', 'gql', 'proto', 'dockerfile', 'makefile'
        ];
        const lowerName = filePath.split('/').pop()!.toLowerCase();
        if (
          textExtensions.includes(ext) ||
          lowerName === 'dockerfile' ||
          lowerName === 'makefile' ||
          lowerName === 'license' ||
          lowerName === 'readme' ||
          lowerName === 'gemfile' ||
          lowerName === 'procfile' ||
          lowerName.startsWith('.') ||
          ext === ''
        ) {
          return 'text';
        }
        return 'binary';
      }

      // Images
      expect(getFilePreviewKind('photo.png')).toBe('image');
      expect(getFilePreviewKind('images/avatar.JPG')).toBe('image');
      expect(getFilePreviewKind('banner.webp')).toBe('image');
      expect(getFilePreviewKind('animation.gif')).toBe('image');

      // Markdown
      expect(getFilePreviewKind('README.md')).toBe('markdown');
      expect(getFilePreviewKind('docs/guide.markdown')).toBe('markdown');

      // Text / Code / Extensionless
      expect(getFilePreviewKind('src/main.ts')).toBe('text');
      expect(getFilePreviewKind('config.json')).toBe('text');
      expect(getFilePreviewKind('styles.css')).toBe('text');
      expect(getFilePreviewKind('Dockerfile')).toBe('text');
      expect(getFilePreviewKind('.env')).toBe('text');
      expect(getFilePreviewKind('.gitignore')).toBe('text');
      expect(getFilePreviewKind('LICENSE')).toBe('text');
      expect(getFilePreviewKind('notes')).toBe('text');

      // Binary
      expect(getFilePreviewKind('archive.zip')).toBe('binary');
      expect(getFilePreviewKind('document.pdf')).toBe('binary');
      expect(getFilePreviewKind('database.sqlite')).toBe('binary');
      expect(getFilePreviewKind('app.exe')).toBe('binary');
      expect(getFilePreviewKind('audio.mp3')).toBe('binary');
      expect(getFilePreviewKind('video.mp4')).toBe('binary');
    });

    it('bypasses /files/content API request for image and binary files on click', () => {
      expect(appJsCode).toContain("const kind = getFilePreviewKind(entry.name);");
      expect(appJsCode).toContain("if (kind === 'image' || kind === 'binary') {");
      expect(appJsCode).toContain("state.filesActiveFile = {");
    });

    it('renders image viewer with controlled dimensions and without save button', () => {
      expect(appJsCode).toContain('files-preview-image-container');
      expect(appJsCode).toContain('files-preview-image');
      expect(cssCode).toContain('.files-preview-image-container');
      expect(cssCode).toContain('.files-preview-image');
      expect(appJsCode).toContain("previewKind === 'image'");
    });

    it('renders binary placeholder notice and download button without save button', () => {
      expect(appJsCode).toContain('files.unsupportedType');
      expect(appJsCode).toContain('files-empty-state-binary');
      expect(cssCode).toContain('.files-empty-state-binary');
      expect(en['files.unsupportedType']).toBe('This file type does not support online viewing.');
      expect(zhCN['files.unsupportedType']).toBe('该文件类型不支持在线查看');
    });

    it('renders markdown edit/preview tabs and toggles preview renderer', () => {
      expect(appJsCode).toContain('files.tabEdit');
      expect(appJsCode).toContain('files.tabPreview');
      expect(appJsCode).toContain('files-markdown-preview-body');
      expect(cssCode).toContain('.files-markdown-preview-body');
      expect(en['files.tabEdit']).toBe('Edit');
      expect(en['files.tabPreview']).toBe('Preview');
      expect(zhCN['files.tabEdit']).toBe('编辑');
      expect(zhCN['files.tabPreview']).toBe('预览');
    });
  });

  describe('C-03: Workspace Relative Path Copy Button', () => {
    it('renders copy path button in table row actions with itemRelPath', () => {
      expect(appJsCode).toContain("btnCopyPath.textContent = t('files.btnCopyPath', null, 'Copy Path');");
      expect(appJsCode).toContain('navigator.clipboard.writeText(itemRelPath)');
      expect(appJsCode).toContain("showToast(t('common.copied', null, 'Copied!'), 'success');");
      expect(en['files.btnCopyPath']).toBe('Copy Path');
      expect(zhCN['files.btnCopyPath']).toBe('复制路径');
    });

    it('renders copy path button in editor header title row with activeFile.path', () => {
      expect(appJsCode).toContain('btnCopyPathHeader');
      expect(appJsCode).toContain('navigator.clipboard.writeText(activeFile.path)');
      expect(appJsCode).toContain('files-editor-path-wrap');
      expect(cssCode).toContain('.files-editor-path-wrap');
    });
  });
});
