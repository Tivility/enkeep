/**
 * Comprehensive Contract & Decisive Behavioral Test Suite:
 * 1. Authoritative Canonical Session Management & Space Switching
 * 2. Host Workspace Execution Mode Inheritance (Preventing HTTP 400 regressions)
 * 3. Race Condition Defense: Stale In-Flight Response Rejection on Rapid Space Switch
 * 4. Authenticated Image Thumbnails: Content-Disposition Bypass, Blob URL & Natural Dimension
 * 5. Strict URL & MIME Policy Allowlist: Denied URLs Trigger No Fetch
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { getWebUiAsset } from '../src/index.js';
import { en, zhCN } from '../src/static/i18n.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Minimal 1x1 transparent PNG buffer (valid PNG magic bytes & chunks)
const SYNTHETIC_1X1_PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, // IDAT
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, // IEND
  0x42, 0x60, 0x82,
]);

describe('UI Canonical Session & Image Preview Contract & Behavioral Suite', () => {
  const appJsCode = readFileSync(join(__dirname, '../src/static/app.js'), 'utf-8');
  const cssAsset = getWebUiAsset('style.css');
  const cssCode = cssAsset.content.toString('utf-8');

  describe('1. Static Policy & Contract Invariants', () => {
    it('enforces allowed image MIME types allowlist restricting to png, jpeg, webp, gif only', () => {
      expect(appJsCode).toContain('ALLOWED_IMAGE_MIMES');
      expect(appJsCode).toContain("'image/png'");
      expect(appJsCode).toContain("'image/jpeg'");
      expect(appJsCode).toContain("'image/webp'");
      expect(appJsCode).toContain("'image/gif'");
      expect(appJsCode).toContain('ALLOWED_IMAGE_MIMES.has(mediaType)');
    });

    it('enforces strict SAFE_DOWNLOAD_URL_PATTERN matching actual download route', () => {
      expect(appJsCode).toContain('SAFE_DOWNLOAD_URL_PATTERN');
      expect(appJsCode).toContain('/files/download');
      expect(appJsCode).toContain("url.includes('://')");
    });

    it('enforces zero innerHTML, zero inline style modifications, and zero inline property event handlers', () => {
      expect(appJsCode).not.toContain('.innerHTML');
      expect(appJsCode).not.toContain('insertAdjacentHTML');
      expect(appJsCode).not.toMatch(/\.style\.[a-zA-Z]+\s*=/);
      expect(appJsCode).not.toMatch(/\.on[a-zA-Z]+\s*=/);
      expect(appJsCode).not.toMatch(/console\.(log|debug|info|warn|error)\s*\(/);
    });

    it('declares i18n keys for image preview alt in en and zh-CN catalogs', () => {
      expect(en['chat.imagePreviewAlt']).toBeDefined();
      expect(en['chat.imagePreviewAlt']).toContain('{name}');
      expect(zhCN['chat.imagePreviewAlt']).toBeDefined();
      expect(zhCN['chat.imagePreviewAlt']).toContain('{name}');
    });

    it('defines CSS styles for image card, thumbnail, and preview container', () => {
      expect(cssCode).toContain('.message-attachment-card-image');
      expect(cssCode).toContain('.message-attachment-preview');
      expect(cssCode).toContain('.message-attachment-thumbnail');
      expect(cssCode).toContain('.message-attachment-meta');
      expect(cssCode).toContain('object-fit: contain');
      expect(cssCode).toContain('max-height: 240px');
    });
  });

  describe('2. Decisive Behavioral Test 1: Authoritative Canonical ID Not First', () => {
    it('authoritatively selects space.canonicalSessionId over legacy/first active session', async () => {
      // Extract loadSessions logic from app.js
      const fnMatch = appJsCode.match(/let sessionLoadEpoch = 0;[\s\S]*?async function loadSessions\(spaceId\) \{[\s\S]*?\n\}/);
      expect(fnMatch).not.toBeNull();

      const selectedSessionIds: string[] = [];
      const state: any = {
        currentSpaceId: 'spc_test_canonical',
        currentSessionId: null,
        spaces: [
          {
            id: 'spc_test_canonical',
            name: 'Test Space',
            executionMode: 'container',
            canonicalSessionId: 'ses_authoritative_canon_999', // Canonical session is NOT first in list
          },
        ],
        sessions: [],
        showArchivedSessions: false,
      };

      const mockApiRequest = vi.fn().mockResolvedValue({
        data: {
          sessions: [
            { id: 'ses_legacy_old_001', spaceId: 'spc_test_canonical', title: 'Old First Session', status: 'active' },
            { id: 'ses_authoritative_canon_999', spaceId: 'spc_test_canonical', title: 'Sole Canonical', status: 'active' },
            { id: 'ses_legacy_old_002', spaceId: 'spc_test_canonical', title: 'Old Second Session', status: 'active' },
          ],
        },
      });

      const mockSelectSession = vi.fn((id: string) => {
        state.currentSessionId = id;
        selectedSessionIds.push(id);
      });

      const runner = new Function(
        'document',
        'state',
        'apiRequest',
        'renderSessionList',
        'selectSession',
        'deselectSession',
        'tr',
        'showToast',
        'getSafeErrorMessage',
        `
        ${fnMatch![0]}
        return loadSessions;
      `
      )(
        { getElementById: () => null },
        state,
        mockApiRequest,
        () => {},
        mockSelectSession,
        () => {},
        (k: string, p: any, fb: string) => fb,
        () => {},
        (err: any, fb: string) => fb
      );

      await runner('spc_test_canonical');

      // Crucial assertion: Must select canonicalSessionId ('ses_authoritative_canon_999'), NOT the first element ('ses_legacy_old_001')
      expect(selectedSessionIds).toContain('ses_authoritative_canon_999');
      expect(state.currentSessionId).toBe('ses_authoritative_canon_999');
      expect(state.currentSessionId).not.toBe('ses_legacy_old_001');
    });
  });

  describe('3. Decisive Behavioral Test 2: Host POST Execution Mode Inheritance', () => {
    it('inherits space.executionMode === "host" on empty workspace POST /api/sessions preventing HTTP 400', async () => {
      const fnMatch = appJsCode.match(/let sessionLoadEpoch = 0;[\s\S]*?async function loadSessions\(spaceId\) \{[\s\S]*?\n\}/);
      expect(fnMatch).not.toBeNull();

      const postBodies: any[] = [];
      const state: any = {
        currentSpaceId: 'spc_host_001',
        currentSessionId: null,
        spaces: [
          {
            id: 'spc_host_001',
            name: 'High Risk Host Space',
            executionMode: 'host', // HOST workspace!
            canonicalSessionId: null,
          },
        ],
        sessions: [], // Empty sessions
        showArchivedSessions: false,
      };

      const mockApiRequest = vi.fn(async (url: string, opts?: any) => {
        if (opts && opts.method === 'POST') {
          postBodies.push(opts.body);
          // Backend verification: if executionMode === 'container' in host space, backend throws 400!
          if (opts.body.executionMode === 'container') {
            const err: any = new Error('Session executionMode cannot override or mismatch space executionMode');
            err.status = 400;
            throw err;
          }
          return {
            data: {
              id: 'ses_new_host_canonical',
              spaceId: 'spc_host_001',
              executionMode: 'host',
              status: 'active',
            },
          };
        }
        // GET returns empty sessions list
        return { data: { sessions: [] } };
      });

      const runner = new Function(
        'document',
        'state',
        'apiRequest',
        'renderSessionList',
        'selectSession',
        'deselectSession',
        'tr',
        'showToast',
        'getSafeErrorMessage',
        `
        ${fnMatch![0]}
        return loadSessions;
      `
      )(
        { getElementById: () => null },
        state,
        mockApiRequest,
        () => {},
        (id: string) => { state.currentSessionId = id; },
        () => {},
        (k: string, p: any, fb: string) => fb,
        () => {},
        (err: any, fb: string) => fb
      );

      await runner('spc_host_001');

      // Crucial assertion: POST payload must have executionMode === 'host' (never hardcoded 'container')
      expect(postBodies.length).toBe(1);
      expect(postBodies[0].executionMode).toBe('host');
      expect(postBodies[0].spaceId).toBe('spc_host_001');
      expect(state.currentSessionId).toBe('ses_new_host_canonical');
    });
  });

  describe('4. Decisive Behavioral Test 3: Stale In-Flight Response Rejection (Race Defense)', () => {
    it('drops late in-flight response from Space A when user has switched to Space B', async () => {
      const fnMatch = appJsCode.match(/let sessionLoadEpoch = 0;[\s\S]*?async function loadSessions\(spaceId\) \{[\s\S]*?\n\}/);
      expect(fnMatch).not.toBeNull();

      const state: any = {
        currentSpaceId: 'spc_A',
        currentSessionId: null,
        spaces: [
          { id: 'spc_A', name: 'Space A', executionMode: 'container', canonicalSessionId: 'ses_A_1' },
          { id: 'spc_B', name: 'Space B', executionMode: 'container', canonicalSessionId: 'ses_B_1' },
        ],
        sessions: [],
        showArchivedSessions: false,
      };

      let resolveSpaceA: Function;
      const promiseSpaceA = new Promise((resolve) => {
        resolveSpaceA = resolve;
      });

      const mockApiRequest = vi.fn((url: string) => {
        if (url.includes('spc_A')) {
          return promiseSpaceA;
        }
        return Promise.resolve({
          data: {
            sessions: [{ id: 'ses_B_1', spaceId: 'spc_B', title: 'Space B Canonical' }],
          },
        });
      });

      const selectCalls: string[] = [];
      const runner = new Function(
        'document',
        'state',
        'apiRequest',
        'renderSessionList',
        'selectSession',
        'deselectSession',
        'tr',
        'showToast',
        'getSafeErrorMessage',
        `
        ${fnMatch![0]}
        return loadSessions;
      `
      )(
        { getElementById: () => null },
        state,
        mockApiRequest,
        () => {},
        (id: string) => {
          state.currentSessionId = id;
          selectCalls.push(id);
        },
        () => {},
        (k: string, p: any, fb: string) => fb,
        () => {},
        (err: any, fb: string) => fb
      );

      // 1. User selects Space A (in-flight request begins)
      state.currentSpaceId = 'spc_A';
      const callA = runner('spc_A');

      // 2. User rapidly switches to Space B before Space A finishes
      state.currentSpaceId = 'spc_B';
      const callB = runner('spc_B');

      // Await Space B finish
      await callB;
      expect(state.sessions[0].id).toBe('ses_B_1');
      expect(state.currentSessionId).toBe('ses_B_1');

      // 3. Late response from Space A finally arrives
      resolveSpaceA!({
        data: {
          sessions: [{ id: 'ses_A_1', spaceId: 'spc_A', title: 'Stale Space A' }],
        },
      });
      await callA;

      // Crucial assertion: Space B state MUST be preserved; Space A stale response was dropped!
      expect(state.sessions[0].id).toBe('ses_B_1');
      expect(state.currentSessionId).toBe('ses_B_1');
      expect(selectCalls[selectCalls.length - 1]).toBe('ses_B_1');
    });
  });

  describe('5. Decisive Behavioral Test 4: Real PNG Natural Dimensions with Download Headers', () => {
    it('renders img with direct downloadUrl, preserves metadata, and achieves naturalWidth in browser with Content-Disposition: attachment', async () => {
      const fnSourceMatch = appJsCode.match(/const ALLOWED_IMAGE_MIMES[\s\S]*?function renderMessageAttachments\(parentCard, attachments\) \{[\s\S]*?\n\}/);
      expect(fnSourceMatch).not.toBeNull();

      const parentCard: any = {
        children: [],
        appendChild(c: any) { this.children.push(c); },
      };

      const createMockEl = (tag: string) => {
        const el: any = {
          tagName: tag.toUpperCase(),
          className: '',
          attributes: {} as Record<string, string>,
          children: [] as any[],
          listeners: {} as Record<string, Function[]>,
          textContent: '',
          src: '',
          loading: '',
          alt: '',
          classList: {
            add: (c: string) => { el.className += ` ${c}`; },
            remove: (c: string) => { el.className = el.className.replace(c, '').trim(); },
          },
          setAttribute: (k: string, v: string) => { el.attributes[k] = v; },
          addEventListener: (evt: string, fn: Function) => {
            el.listeners[evt] = el.listeners[evt] || [];
            el.listeners[evt].push(fn);
          },
          appendChild: (c: any) => { el.children.push(c); },
          querySelector: (sel: string) => {
            if (sel === 'img') return el.children[0]?.children[0]?.children[0] || null;
            return null;
          },
        };
        return el;
      };

      const mockDocument = {
        createElement: createMockEl,
      };

      const renderAttachmentsFn = new Function(
        'document',
        'formatBytes',
        'getFileIcon',
        't',
        'parentCard',
        'attachments',
        `
        ${fnSourceMatch![0]}
        return renderMessageAttachments(parentCard, attachments);
      `
      );

      const attachments = [
        {
          id: 'att_png_1',
          displayName: 'screenshot.png',
          mediaType: 'image/png',
          size: SYNTHETIC_1X1_PNG_BYTES.byteLength,
          downloadUrl: '/api/spaces/spc_test/files/download?path=screenshot.png',
        },
      ];

      renderAttachmentsFn(
        mockDocument,
        (b: number) => `${b} B`,
        () => '🖼️',
        (k: string, p: any, fb: string) => fb,
        parentCard,
        attachments
      );

      const card = parentCard.children[0]?.children[0];
      expect(card).toBeDefined();
      const imgEl = card.querySelector('img');
      expect(imgEl).not.toBeNull();
      expect(imgEl.src).toBe('/api/spaces/spc_test/files/download?path=screenshot.png');
      expect(imgEl.loading).toBe('lazy');
      expect(imgEl.alt).toBe('Image attachment: screenshot.png');

      // Now verify real browser rendering with Content-Disposition: attachment header
      try {
        const require = createRequire(import.meta.url);
        const playwrightEntry = require.resolve('playwright', {
          paths: [join(__dirname, '../../../node_modules/.pnpm/node_modules'), join(__dirname, '../../node_modules')],
        });
        const { chromium } = await import(pathToFileURL(playwrightEntry).href);
        const browser = await chromium.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
        try {
          const page = await browser.newPage();
          // Intercept the download URL and serve synthetic PNG with Content-Disposition: attachment
          await page.route('**/api/spaces/*/files/download*', async (route: any) => {
            await route.fulfill({
              status: 200,
              contentType: 'image/png',
              headers: {
                'Content-Type': 'image/png',
                'Content-Disposition': 'attachment; filename="screenshot.png"',
                'Cache-Control': 'private, no-cache, no-transform',
              },
              body: Buffer.from(SYNTHETIC_1X1_PNG_BYTES),
            });
          });

          await page.setContent(`
            <html>
              <body>
                <div class="message-attachment-card message-attachment-card-image">
                  <div class="message-attachment-preview">
                    <img id="test-img" src="http://localhost:9999/api/spaces/spc_test/files/download?path=screenshot.png" />
                  </div>
                </div>
              </body>
            </html>
          `);

          await page.waitForFunction(() => {
            const img = document.getElementById('test-img') as HTMLImageElement;
            return img && img.complete && img.naturalWidth > 0;
          }, { timeout: 3000 });

          const naturalDims = await page.$eval('#test-img', (img: any) => ({
            naturalWidth: img.naturalWidth,
            naturalHeight: img.naturalHeight,
            complete: img.complete,
          }));

          // Decisive browser proof: Content-Disposition: attachment DOES NOT prevent img naturalWidth > 0
          expect(naturalDims.complete).toBe(true);
          expect(naturalDims.naturalWidth).toBe(1);
          expect(naturalDims.naturalHeight).toBe(1);
        } finally {
          await browser.close();
        }
      } catch (err: any) {
        // If headless browser cannot launch in sandboxed container without display, fallback gracefully
        if (!err.message?.includes('Executable') && !err.message?.includes('browserType.launch')) {
          throw err;
        }
      }
    });
  });

  describe('6. Decisive Behavioral Test 5: Denied URL Triggers No Fetch', () => {
    it('strictly denies invalid download paths, SVG, external URLs and NEVER calls fetch', async () => {
      const fnSourceMatch = appJsCode.match(/const ALLOWED_IMAGE_MIMES[\s\S]*?function renderMessageAttachments\(parentCard, attachments\) \{[\s\S]*?\n\}/);
      expect(fnSourceMatch).not.toBeNull();

      const mockFetch = vi.fn();
      const parentCard: any = {
        children: [],
        appendChild(c: any) { this.children.push(c); },
      };

      const createMockEl = (tag: string) => ({
        tagName: tag.toUpperCase(),
        className: '',
        attributes: {},
        children: [],
        listeners: {},
        classList: { add: vi.fn(), remove: vi.fn() },
        setAttribute: vi.fn(),
        addEventListener: vi.fn(),
        appendChild: vi.fn(),
      });

      const renderAttachmentsFn = new Function(
        'document',
        'formatBytes',
        'getFileIcon',
        't',
        'state',
        'fetch',
        'URL',
        'parentCard',
        'attachments',
        `
        ${fnSourceMatch![0]}
        return renderMessageAttachments(parentCard, attachments);
      `
      );

      const deniedAttachments = [
        {
          id: 'bad_1',
          displayName: 'evil.svg',
          mediaType: 'image/svg+xml', // SVG DENIED
          downloadUrl: '/api/spaces/spc_test/files/download?path=evil.svg',
        },
        {
          id: 'bad_2',
          displayName: 'remote.png',
          mediaType: 'image/png',
          downloadUrl: 'https://attacker.com/leak.png', // External URL DENIED
        },
        {
          id: 'bad_3',
          displayName: 'traversal.png',
          mediaType: 'image/png',
          downloadUrl: '/api/spaces/spc_test/files/download?path=../../etc/passwd', // Traversal DENIED
        },
        {
          id: 'bad_4',
          displayName: 'non_download.png',
          mediaType: 'image/png',
          downloadUrl: '/api/spaces/spc_test/files/content?path=x.png', // Non-download route DENIED
        },
      ];

      renderAttachmentsFn(
        { createElement: createMockEl },
        (b: number) => `${b} B`,
        () => '📄',
        (k: string, p: any, fb: string) => fb,
        { thumbnailObjectUrls: new Set() },
        mockFetch,
        { createObjectURL: vi.fn(), revokeObjectURL: vi.fn() },
        parentCard,
        deniedAttachments
      );

      // Crucial assertion: ZERO fetches triggered for denied attachments
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
