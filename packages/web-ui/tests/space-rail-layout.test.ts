/**
 * Test Suite for Space Rail UI Layout Redesign
 *
 * Verifies:
 * (a) #space-rail renders one row per option of #space-select and clicking a row updates #space-select.value and dispatches change
 * (b) Collapsed state toggles class and persists to localStorage with key 'enkeep.spaceRail.collapsed'
 * (c) All getElementById('...') references in app.js still exist in static index.html
 * (d) Invariants: zero innerHTML, zero inline styles, zero console.log in app.js
 * (e) Responsive rules for space rail drawer and sidebar toggle
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getWebUiIndexHtml, getWebUiAsset } from '../src/index.js';
import { en, zhCN } from '../src/static/i18n.js';

describe('Space Rail & UI Redesign Contract Tests', () => {
  const html = getWebUiIndexHtml();
  const jsAsset = getWebUiAsset('app.js');
  const cssAsset = getWebUiAsset('style.css');
  const jsCode = jsAsset.content.toString('utf-8');
  const cssCode = cssAsset.content.toString('utf-8');

  describe('1. Static DOM Structure & Elements', () => {
    it('contains #space-rail with header, toggle button, search input, list and footer', () => {
      expect(html).toContain('id="space-rail"');
      expect(html).toContain('id="btn-toggle-space-rail"');
      expect(html).toContain('id="space-rail-search-wrapper"');
      expect(html).toContain('id="space-rail-search-input"');
      expect(html).toContain('id="space-rail-list"');
      expect(html).toContain('id="btn-new-space"');
      expect(html).toContain('id="btn-toggle-archived-spaces"');
    });

    it('keeps select#space-select in DOM with hidden class', () => {
      expect(html).toContain('id="space-select"');
      expect(html).toMatch(/<select[^>]*id="space-select"[^>]*class="[^"]*hidden[^"]*"/);
    });

    it('contains space header with current space name, mode badge and kebab menu in sidebar', () => {
      expect(html).toContain('id="current-space-name"');
      expect(html).toContain('id="space-mode-badge"');
      expect(html).toContain('id="btn-space-kebab"');
      expect(html).toContain('id="space-kebab-menu"');
      expect(html).toContain('id="btn-rename-space"');
      expect(html).toContain('id="btn-manage-mounts"');
      expect(html).toContain('id="btn-archive-space"');
      expect(html).toContain('id="btn-restore-space"');
    });

    it('relocates #nav-management to topbar and #nav-workspace to view-management', () => {
      expect(html).toContain('id="nav-management"');
      expect(html).toContain('data-view="management"');
      expect(html).toContain('id="nav-workspace"');
      expect(html).toContain('data-view="workspace"');
      expect(html).toContain('id="user-menu-trigger"');
      expect(html).toContain('id="user-menu-dropdown"');
      expect(html).toContain('id="nav-account"');
      expect(html).toContain('id="btn-logout"');
    });
  });

  describe('2. Space Rail Rendering and Row Selection', () => {
    it('renders one row per option in #space-select and clicking updates select.value and dispatches change', () => {
      // Simulate DOM environment
      const listeners: Record<string, Function[]> = {};
      const select = {
        id: 'space-select',
        value: 'space-1',
        options: [
          { value: 'space-1', textContent: 'Engineering [Docker]' },
          { value: 'space-2', textContent: 'Research [Host]' },
          { value: 'space-3', textContent: 'Archive (Archived) [Docker]' },
        ],
        dispatchEvent: (event: any) => {
          (listeners['change'] || []).forEach((fn) => fn(event));
        },
        addEventListener: (evt: string, fn: Function) => {
          listeners[evt] = listeners[evt] || [];
          listeners[evt].push(fn);
        },
      };

      const railListChildren: any[] = [];
      const railList = {
        id: 'space-rail-list',
        children: railListChildren,
        replaceChildren: () => {
          railListChildren.length = 0;
        },
        appendChild: (child: any) => {
          railListChildren.push(child);
        },
      };

      const searchWrapper = {
        classList: {
          add: (cls: string) => {},
          remove: (cls: string) => {},
        },
      };

      const elements: Record<string, any> = {
        'space-select': select,
        'space-rail-list': railList,
        'space-rail-search-wrapper': searchWrapper,
      };

      const docMock = {
        getElementById: (id: string) => elements[id] || null,
        createElement: (tag: string) => {
          const el: any = {
            tagName: tag.toUpperCase(),
            children: [],
            dataset: {},
            classList: {
              _classes: new Set<string>(),
              add(c: string) { this._classes.add(c); },
              remove(c: string) { this._classes.delete(c); },
              contains(c: string) { return this._classes.has(c); },
            },
            setAttribute: (k: string, v: string) => { el[k] = v; },
            appendChild: (child: any) => { el.children.push(child); },
            addEventListener: (evt: string, handler: Function) => {
              el._clickHandler = handler;
            },
            click: () => {
              if (el._clickHandler) el._clickHandler();
            },
          };
          return el;
        },
      };

      // Extract renderSpaceRail function
      const fnCode = jsCode.match(/function renderSpaceRail\(spaces\) \{[\s\S]*?\n\}/)![0];
      const stateMock = { currentSpaceId: 'space-1', spaces: [] };
      const trMock = (k: string, p: any, def: string) => def;

      const { renderSpaceRail } = new Function(
        'document',
        'state',
        'tr',
        `
        ${fnCode}
        return { renderSpaceRail };
      `
      )(docMock, stateMock, trMock);

      // Render rail from select options
      renderSpaceRail();

      expect(railList.children.length).toBe(select.options.length);
      expect(railList.children[0].dataset.spaceId).toBe('space-1');
      expect(railList.children[1].dataset.spaceId).toBe('space-2');
      expect(railList.children[2].dataset.spaceId).toBe('space-3');

      // Click row 2
      let changeFired = false;
      select.addEventListener('change', () => {
        changeFired = true;
      });

      railList.children[1].click();
      expect(select.value).toBe('space-2');
      expect(changeFired).toBe(true);
    });
  });

  describe('3. Collapsed State & localStorage Persistence', () => {
    it('toggles collapsed class and persists to localStorage key enkeep.spaceRail.collapsed', () => {
      const storage: Record<string, string> = {};
      const localStorageMock = {
        getItem: (k: string) => storage[k] ?? null,
        setItem: (k: string, v: string) => { storage[k] = String(v); },
      };

      const classes = new Set<string>();
      let toggleListener: Function | null = null;

      const railEl = {
        classList: {
          add: (c: string) => classes.add(c),
          remove: (c: string) => classes.delete(c),
          toggle: (c: string) => {
            if (classes.has(c)) classes.delete(c);
            else classes.add(c);
            return classes.has(c);
          },
          contains: (c: string) => classes.has(c),
        },
      };

      const toggleBtn = {
        addEventListener: (evt: string, fn: Function) => {
          if (evt === 'click') toggleListener = fn;
        },
      };

      const docMock = {
        getElementById: (id: string) => {
          if (id === 'space-rail') return railEl;
          if (id === 'btn-toggle-space-rail') return toggleBtn;
          return null;
        },
      };

      const fnCode = jsCode.match(/function initSpaceRail\(\) \{[\s\S]*?\n\}/)![0];
      const { initSpaceRail } = new Function(
        'document',
        'localStorage',
        'state',
        `
        ${fnCode}
        return { initSpaceRail };
      `
      )(docMock, localStorageMock, {});

      initSpaceRail();

      expect(classes.has('collapsed')).toBe(false);
      expect(toggleListener).not.toBeNull();

      // Click to collapse
      toggleListener!();
      expect(classes.has('collapsed')).toBe(true);
      expect(storage['enkeep.spaceRail.collapsed']).toBe('true');

      // Click to expand
      toggleListener!();
      expect(classes.has('collapsed')).toBe(false);
      expect(storage['enkeep.spaceRail.collapsed']).toBe('false');
    });
  });

  describe('4. getElementById Preservation Invariant', () => {
    it('confirms every getElementById call in app.js exists in index.html (except dynamic/modal targets)', () => {
      const idMatches = [...jsCode.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
      const uniqueIds = Array.from(new Set(idMatches));

      // Dynamic IDs created at runtime or inside dynamic management views / modals
      const dynamicOrRuntimeIds = new Set([
        'modal-backdrop',
        'tab-btn-',
        'space-mode-badge-item',
        'channel-tab-',
        'plugin-modal-',
        'dynamic-',
        'files-upload-tray',
        'staged-v2-sel-count',
        'staged-v2-step2-next',
        'staged-sel-count',
        'staged-step2-next',
        'chat-pagination-bar',
        'nav-admin-section', // Verified absent by management-console.test.ts invariant
      ]);

      const missingIds: string[] = [];
      uniqueIds.forEach((id) => {
        if (Array.from(dynamicOrRuntimeIds).some((dyn) => id.includes(dyn))) {
          return;
        }
        if (!html.includes(`id="${id}"`)) {
          missingIds.push(id);
        }
      });

      expect(missingIds).toEqual([]);
    });
  });

  describe('5. Security, Invariant & Code Cleanliness', () => {
    it('enforces zero innerHTML assignments and insertAdjacentHTML across entire app.js', () => {
      expect(jsCode).not.toContain('.innerHTML');
      expect(jsCode).not.toMatch(/innerHTML\s*=/);
      expect(jsCode).not.toContain('insertAdjacentHTML');
    });

    it('enforces zero inline style modifications across entire app.js', () => {
      expect(jsCode).not.toContain('.style.');
      expect(jsCode).not.toContain('.style =');
      expect(jsCode).not.toMatch(/\.style\[/);
    });

    it('enforces zero console logging calls across entire app.js', () => {
      expect(jsCode).not.toMatch(/console\.(log|error|warn|info|debug)\s*\(/);
    });
  });

  describe('6. CSS Responsive & Layout Rules', () => {
    it('defines .space-rail and .space-rail.collapsed with proper dimension tokens', () => {
      expect(cssCode).toContain('.space-rail');
      expect(cssCode).toContain('.space-rail.collapsed');
      expect(cssCode).toContain('--space-rail-width');
      expect(cssCode).toContain('--space-rail-collapsed-width');
    });

    it('defines responsive rules for off-canvas drawer under 900px', () => {
      expect(cssCode).toContain('@media (max-width: 900px)');
      expect(cssCode).toContain('drawer-open');
    });
  });

  describe('7. i18n Localization Keys', () => {
    it('defines all required rail and redesign keys in both en and zh-CN', () => {
      const requiredKeys = [
        'chat.backToChat',
        'chat.searchSpacesPlaceholder',
        'chat.spaceActions',
        'chat.toggleRailTitle',
      ];

      requiredKeys.forEach((key) => {
        expect(en[key as keyof typeof en]).toBeDefined();
        expect(zhCN[key as keyof typeof zhCN]).toBeDefined();
      });
    });
  });
});
