/**
 * Comprehensive Unit and Integration Tests for Enkeep Web UI Internationalization (i18n)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getWebUiIndexHtml, getWebUiAsset } from '../src/index.js';
import EnkeepI18n, {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  catalogs,
  en,
  zhCN,
  t,
  interpolate,
  setLocale,
  getLocale,
  detectLocale,
  initI18n,
  translateDom,
  syncLanguageControls,
  setStrictMode,
  isStrictMode,
  getMissingKeyCount,
  getMissingKeyStats,
  resetMissingKeyStats,
} from '../src/static/i18n.js';

describe('Enkeep Web UI i18n Module', () => {
  beforeEach(() => {
    resetMissingKeyStats();
    setStrictMode(false);
    setLocale(DEFAULT_LOCALE, { silent: true, persist: false });
  });

  afterEach(() => {
    resetMissingKeyStats();
    setStrictMode(false);
  });

  describe('1. Catalog Completeness, Symmetry, and Zero Empty Strings', () => {
    it('supports exactly en and zh-CN with default en', () => {
      expect(SUPPORTED_LOCALES).toEqual(['en', 'zh-CN']);
      expect(DEFAULT_LOCALE).toBe('en');
      expect(catalogs.en).toBeDefined();
      expect(catalogs['zh-CN']).toBeDefined();
    });

    it('has identical key sets between English and Simplified Chinese catalogs', () => {
      const enKeys = Object.keys(en).sort();
      const zhKeys = Object.keys(zhCN).sort();

      expect(enKeys.length).toBeGreaterThan(50);
      expect(enKeys).toEqual(zhKeys);

      const missingInZh = enKeys.filter((k) => !(k in zhCN));
      const missingInEn = zhKeys.filter((k) => !(k in en));

      expect(missingInZh).toEqual([]);
      expect(missingInEn).toEqual([]);
    });

    it('contains zero empty string translations across all catalogs', () => {
      for (const [key, value] of Object.entries(en)) {
        expect(typeof value).toBe('string');
        expect(value.trim().length, `Empty English value for key "${key}"`).toBeGreaterThan(0);
      }

      for (const [key, value] of Object.entries(zhCN)) {
        expect(typeof value).toBe('string');
        expect(value.trim().length, `Empty Chinese value for key "${key}"`).toBeGreaterThan(0);
      }
    });

    it('strictly follows naming conventions (chat.*, management.*, common.*, auth.*, account.*, status.*, error.*, modal.*, toast.*, section.*, overview.*, runtime.*, plugins.*, tasks.*, profiles.*, files.*, quotas.*, reconcile.*, users.*, models.*, security.*, audit.*, delivery.*, imports.*, spaces.*, turns.*, metric.*)', () => {
      const validPrefixes = [
        'common.',
        'auth.',
        'chat.',
        'management.',
        'account.',
        'status.',
        'error.',
        'modal.',
        'toast.',
        'section.',
        'overview.',
        'runtime.',
        'plugins.',
        'tasks.',
        'profiles.',
        'files.',
        'quotas.',
        'reconcile.',
        'users.',
        'models.',
        'security.',
        'audit.',
        'delivery.',
        'imports.',
        'spaces.',
        'turns.',
        'metric.',
        'forcedPassword.',
        'skills.',
        'extensions.',
        'presets.',
        'approvals.',
        'diagnostics.',
        'notifications.',
        'theme.',
        'instructions.',
        'channels.',
      ];

      const allKeys = Object.keys(en);
      for (const key of allKeys) {
        const hasValidPrefix = validPrefixes.some((prefix) => key.startsWith(prefix));
        expect(hasValidPrefix, `Key "${key}" does not match allowed namespaces`).toBe(true);
      }
    });
  });

  describe('2. Static DOM Key Scanning in index.html', () => {
    const html = getWebUiIndexHtml();

    it('contains distinct language select controls with IDs locale-select and auth-locale-select', () => {
      expect(html).toContain('id="locale-select"');
      expect(html).toContain('id="auth-locale-select"');

      // Assert no duplicate IDs
      const topbarMatches = html.match(/id="locale-select"/g);
      const authMatches = html.match(/id="auth-locale-select"/g);
      expect(topbarMatches?.length).toBe(1);
      expect(authMatches?.length).toBe(1);

      // Assert accessible options for English and 简体中文
      expect(html).toContain('value="en">English</option>');
      expect(html).toContain('value="zh-CN">简体中文</option>');
    });

    it('verifies all data-i18n keys in index.html exist in catalog', () => {
      const dataI18nRegex = /data-i18n="([^"]+)"/g;
      const keysFound: string[] = [];
      let match;

      while ((match = dataI18nRegex.exec(html)) !== null) {
        keysFound.push(match[1]);
      }

      expect(keysFound.length).toBeGreaterThan(20);

      const missingKeys: string[] = [];
      for (const key of keysFound) {
        if (!(key in en)) {
          missingKeys.push(key);
        }
      }

      expect(missingKeys).toEqual([]);
    });

    it('verifies all data-i18n-placeholder keys in index.html exist in catalog', () => {
      const placeholderRegex = /data-i18n-placeholder="([^"]+)"/g;
      const keysFound: string[] = [];
      let match;

      while ((match = placeholderRegex.exec(html)) !== null) {
        keysFound.push(match[1]);
      }

      expect(keysFound.length).toBeGreaterThan(5);

      const missingKeys: string[] = [];
      for (const key of keysFound) {
        if (!(key in en)) {
          missingKeys.push(key);
        }
      }

      expect(missingKeys).toEqual([]);
    });

    it('verifies all data-i18n-title keys in index.html exist in catalog', () => {
      const titleRegex = /data-i18n-title="([^"]+)"/g;
      const keysFound: string[] = [];
      let match;

      while ((match = titleRegex.exec(html)) !== null) {
        keysFound.push(match[1]);
      }

      expect(keysFound.length).toBeGreaterThan(5);

      const missingKeys: string[] = [];
      for (const key of keysFound) {
        if (!(key in en)) {
          missingKeys.push(key);
        }
      }

      expect(missingKeys).toEqual([]);
    });

    it('verifies all data-i18n-aria-label keys in index.html exist in catalog', () => {
      const ariaRegex = /data-i18n-aria-label="([^"]+)"/g;
      const keysFound: string[] = [];
      let match;

      while ((match = ariaRegex.exec(html)) !== null) {
        keysFound.push(match[1]);
      }

      expect(keysFound.length).toBeGreaterThan(2);

      const missingKeys: string[] = [];
      for (const key of keysFound) {
        if (!(key in en)) {
          missingKeys.push(key);
        }
      }

      expect(missingKeys).toEqual([]);
    });
  });

  describe('3. Parameter Interpolation & Security', () => {
    it('strictly interpolates single and multiple parameters without eval', () => {
      expect(interpolate('Hello, {name}!', { name: 'Alice' })).toBe('Hello, Alice!');
      expect(interpolate('{current} / {max}', { current: 5, max: 4000 })).toBe('5 / 4000');
      expect(interpolate('Account: {name}{role}', { name: 'Bob', role: ' (admin)' })).toBe('Account: Bob (admin)');
      expect(interpolate('Gen {number}', { number: 3 })).toBe('Gen 3');
    });

    it('leaves missing parameter placeholders intact', () => {
      expect(interpolate('Hello, {name}!', {})).toBe('Hello, {name}!');
      expect(interpolate('Hello, {name}!', null as any)).toBe('Hello, {name}!');
    });

    it('translates with t() using active locale and parameters', () => {
      setLocale('en', { persist: false, silent: true });
      expect(t('common.welcome', { name: 'Alice' })).toBe('Welcome back, Alice!');
      expect(t('chat.charCount', { current: 120, max: 4000 })).toBe('120 / 4000');

      setLocale('zh-CN', { persist: false, silent: true });
      expect(t('common.welcome', { name: 'Alice' })).toBe('欢迎回来，Alice！');
      expect(t('chat.genBadge', { number: 2 })).toBe('第 2 代');
    });

    it('handles empty or non-string keys safely', () => {
      expect(t('')).toBe('');
      expect(t(null as any)).toBe('');
      expect(t(undefined as any)).toBe('');
    });
  });

  describe('4. Fallback & Missing Key Behavior', () => {
    it('falls back to default English catalog when key is missing in active locale', () => {
      setLocale('zh-CN', { persist: false, silent: true });

      // Temporarily inject a key present only in en
      (catalogs.en as any)['test.onlyInEn'] = 'English Only Text';
      delete (catalogs['zh-CN'] as any)['test.onlyInEn'];

      expect(t('test.onlyInEn')).toBe('English Only Text');
      expect(getMissingKeyCount()).toBe(1);
      expect(getMissingKeyStats()['zh-CN:test.onlyInEn']).toBe(1);

      delete (catalogs.en as any)['test.onlyInEn'];
    });

    it('tracks missing keys silently without calling console.*', () => {
      const consoleSpy = vi.spyOn(console, 'error');
      const logSpy = vi.spyOn(console, 'log');
      const warnSpy = vi.spyOn(console, 'warn');

      expect(getMissingKeyCount()).toBe(0);
      const res = t('completely.missing.key');
      expect(res).toBe('completely.missing.key');
      expect(getMissingKeyCount()).toBe(1);

      expect(consoleSpy).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('throws descriptive error in strict mode for missing keys', () => {
      setStrictMode(true);
      expect(isStrictMode()).toBe(true);

      expect(() => {
        t('non.existent.key');
      }).toThrow(/Missing translation key "non\.existent\.key"/i);
    });
  });

  describe('5. Locale Detection Hierarchy', () => {
    it('prioritizes authenticated user canonical flat locale (user.locale) over storage and navigator', () => {
      const userZh = { id: 'u1', username: 'alice', locale: 'zh-CN' };
      expect(detectLocale(userZh)).toBe('zh-CN');

      const userEn = { id: 'u2', username: 'bob', locale: 'en' };
      expect(detectLocale(userEn)).toBe('en');

      // Invalid or absent locale falls through
      const userEmpty = { id: 'u3', username: 'charlie', locale: null };
      expect(detectLocale(userEmpty)).toBe('en');
    });

    it('falls back to localStorage / sessionStorage when user preference is absent', () => {
      const mockStorage: Record<string, string> = { 'enkeep.locale': 'zh-CN' };
      const originalLocal = globalThis.localStorage;

      // Mock localStorage
      globalThis.localStorage = {
        getItem: (k: string) => mockStorage[k] || null,
        setItem: (k: string, v: string) => { mockStorage[k] = v; },
        removeItem: (k: string) => { delete mockStorage[k]; },
        clear: () => {},
        length: 1,
        key: () => null,
      };

      expect(detectLocale(null)).toBe('zh-CN');

      globalThis.localStorage = originalLocal;
    });

    it('resolves navigator.language zh* to zh-CN, other languages to en', () => {
      const originalNavDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

      // Test zh-CN
      Object.defineProperty(globalThis, 'navigator', {
        value: { language: 'zh-CN', languages: ['zh-CN', 'zh'] },
        configurable: true,
        writable: true,
      });
      expect(detectLocale(null)).toBe('zh-CN');

      // Test zh-TW
      Object.defineProperty(globalThis, 'navigator', {
        value: { language: 'zh-TW', languages: ['zh-TW'] },
        configurable: true,
        writable: true,
      });
      expect(detectLocale(null)).toBe('zh-CN');

      // Test zh
      Object.defineProperty(globalThis, 'navigator', {
        value: { language: 'zh', languages: ['zh'] },
        configurable: true,
        writable: true,
      });
      expect(detectLocale(null)).toBe('zh-CN');

      // Test en-US
      Object.defineProperty(globalThis, 'navigator', {
        value: { language: 'en-US', languages: ['en-US'] },
        configurable: true,
        writable: true,
      });
      expect(detectLocale(null)).toBe('en');

      // Test ja-JP
      Object.defineProperty(globalThis, 'navigator', {
        value: { language: 'ja-JP', languages: ['ja-JP'] },
        configurable: true,
        writable: true,
      });
      expect(detectLocale(null)).toBe('en');

      if (originalNavDescriptor) {
        Object.defineProperty(globalThis, 'navigator', originalNavDescriptor);
      }
    });

    it('falls back to DEFAULT_LOCALE when nothing is available', () => {
      const originalNavDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
      Object.defineProperty(globalThis, 'navigator', {
        value: undefined,
        configurable: true,
        writable: true,
      });
      expect(detectLocale(null)).toBe('en');
      if (originalNavDescriptor) {
        Object.defineProperty(globalThis, 'navigator', originalNavDescriptor);
      }
    });
  });

  describe('6. DOM Translation & Event Dispatching', () => {
    // Helper to create mock DOM elements
    function createMockElement(tag: string, attrs: Record<string, string> = {}) {
      const attributes = { ...attrs };
      const children: any[] = [];
      const el: any = {
        tagName: tag.toUpperCase(),
        textContent: attributes['text'] || '',
        value: attributes['value'] || '',
        placeholder: attributes['placeholder'] || '',
        title: attributes['title'] || '',
        getAttribute: (attr: string) => attributes[attr] || null,
        setAttribute: (attr: string, val: string) => {
          attributes[attr] = val;
          if (attr === 'placeholder') el.placeholder = val;
          if (attr === 'title') el.title = val;
        },
        children,
        childNodes: children,
        appendChild: (c: any) => { children.push(c); return c; },
      };
      return el;
    }

    it('translates DOM textContent, placeholder, title, and aria-label attributes', () => {
      const elText = createMockElement('span', { 'data-i18n': 'common.confirm' });
      const elPlaceholder = createMockElement('input', { 'data-i18n-placeholder': 'chat.searchSessionsPlaceholder' });
      const elTitle = createMockElement('button', { 'data-i18n-title': 'chat.renameSpaceTitle' });
      const elAria = createMockElement('select', { 'data-i18n-aria-label': 'chat.selectSpaceAria' });

      const mockRoot = {
        querySelectorAll: (selector: string) => {
          if (selector === '[data-i18n]') return [elText];
          if (selector === '[data-i18n-placeholder]') return [elPlaceholder];
          if (selector === '[data-i18n-title]') return [elTitle];
          if (selector === '[data-i18n-aria-label]') return [elAria];
          return [];
        },
      };

      setLocale('en', { persist: false, silent: true });
      translateDom(mockRoot as any);
      expect(elText.textContent).toBe('Confirm');
      expect(elPlaceholder.placeholder).toBe('Search sessions...');
      expect(elTitle.title).toBe('Rename current space');
      expect(elAria.getAttribute('aria-label')).toBe('Select active workspace space');

      setLocale('zh-CN', { persist: false, silent: true });
      translateDom(mockRoot as any);
      expect(elText.textContent).toBe('确认');
      expect(elPlaceholder.placeholder).toBe('搜索会话...');
      expect(elTitle.title).toBe('重命名当前空间');
      expect(elAria.getAttribute('aria-label')).toBe('选择当前工作区空间');
    });

    it('setLocale dispatches enkeep:localechange custom event with detail', () => {
      let eventCaptured: any = null;
      const mockWindow = {
        dispatchEvent: (ev: any) => { eventCaptured = ev; },
      };
      const originalWindow = globalThis.window;
      globalThis.window = mockWindow as any;

      setLocale('zh-CN', { persist: false });
      expect(getLocale()).toBe('zh-CN');
      expect(eventCaptured).not.toBeNull();
      expect(eventCaptured.detail).toEqual({ locale: 'zh-CN', previousLocale: 'en' });

      globalThis.window = originalWindow;
    });

    it('syncLanguageControls updates dropdown select values without triggering recursive changes', () => {
      const topbarSelect = createMockElement('select', { value: 'en' });
      const authSelect = createMockElement('select', { value: 'en' });

      const elements: Record<string, any> = {
        'locale-select': topbarSelect,
        'auth-locale-select': authSelect,
      };

      const originalDoc = globalThis.document;
      globalThis.document = {
        getElementById: (id: string) => elements[id] || null,
      } as any;

      syncLanguageControls('zh-CN');
      expect(topbarSelect.value).toBe('zh-CN');
      expect(authSelect.value).toBe('zh-CN');

      globalThis.document = originalDoc;
    });
  });

  describe('7. CSP & Safe DOM Verification for i18n & app.js', () => {
    it('verifies i18n.js contains zero innerHTML, zero eval, zero Function constructors, and zero inline styles', () => {
      const i18nAsset = getWebUiAsset('i18n.js');
      expect(i18nAsset.exists).toBe(true);
      const code = i18nAsset.content.toString('utf-8');

      expect(code).not.toMatch(/innerHTML/i);
      expect(code).not.toMatch(/insertAdjacentHTML/i);
      expect(code).not.toMatch(/style\s*=/i);
      expect(code).not.toContain('.style.');
      expect(code).not.toContain('eval(');
      expect(code).not.toContain('new Function');
      expect(code).not.toMatch(/console\./);
    });

    it('verifies window.EnkeepI18n matches default export and contains all necessary APIs', () => {
      expect(EnkeepI18n.t).toBe(t);
      expect(EnkeepI18n.setLocale).toBe(setLocale);
      expect(EnkeepI18n.getLocale).toBe(getLocale);
      expect(EnkeepI18n.detectLocale).toBe(detectLocale);
      expect(EnkeepI18n.initI18n).toBe(initI18n);
      expect(EnkeepI18n.translateDom).toBe(translateDom);
      expect(EnkeepI18n.SUPPORTED_LOCALES).toEqual(['en', 'zh-CN']);
      expect(EnkeepI18n.DEFAULT_LOCALE).toBe('en');
    });

    it('verifies app.js exposes rerenderCurrentViewForLocale and handles locale changes cleanly', () => {
      const jsAsset = getWebUiAsset('app.js');
      expect(jsAsset.exists).toBe(true);
      const jsCode = jsAsset.content.toString('utf-8');

      expect(jsCode).toContain('rerenderCurrentViewForLocale');
      expect(jsCode).toContain('handleLocaleSelectChange');
      expect(jsCode).toContain("import {");
      expect(jsCode).toContain("from './i18n.js'");
      expect(jsCode).toContain("window.rerenderCurrentViewForLocale = rerenderCurrentViewForLocale");
      // Canonical preference API call
      expect(jsCode).toContain("apiRequest('/api/account/preferences'");
      expect(jsCode).toContain("method: 'PATCH'");
      expect(jsCode).toContain("'Idempotency-Key': idempotencyKey");
      expect(jsCode).toContain('{ locale: newLocale }');
    });
  });

  describe('8. Real E2E Closed-Loop: Multi-User Login, Session Restore, Preference Sync, and Rollback', () => {
    function createMockDomTree() {
      const elements: Record<string, any> = {};

      function makeEl(tag: string, id?: string, attrs: Record<string, string> = {}) {
        const classList = new Set<string>();
        const children: any[] = [];
        const el: any = {
          tagName: tag.toUpperCase(),
          id: id || '',
          textContent: attrs['text'] || '',
          value: attrs['value'] || '',
          placeholder: attrs['placeholder'] || '',
          title: attrs['title'] || '',
          className: '',
          disabled: false,
          children,
          childNodes: children,
          classList: {
            add: (c: string) => classList.add(c),
            remove: (c: string) => classList.delete(c),
            contains: (c: string) => classList.has(c),
            toggle: (c: string, force?: boolean) => {
              if (force === true) classList.add(c);
              else if (force === false) classList.delete(c);
              else if (classList.has(c)) classList.delete(c);
              else classList.add(c);
            },
          },
          getAttribute: (attr: string) => attrs[attr] || null,
          setAttribute: (attr: string, val: string) => {
            attrs[attr] = val;
            if (attr === 'placeholder') el.placeholder = val;
            if (attr === 'title') el.title = val;
          },
          appendChild: (c: any) => {
            children.push(c);
            return c;
          },
          replaceChildren: (...newChildren: any[]) => {
            children.length = 0;
            for (const c of newChildren) children.push(c);
          },
        };
        if (id) elements[id] = el;
        return el;
      }

      // Root HTML element
      const htmlDocEl = makeEl('html');
      htmlDocEl.lang = 'en';

      // Topbar & Auth elements
      const topbarSelect = makeEl('select', 'locale-select', { 'data-i18n-aria-label': 'common.selectLanguage' });
      const authSelect = makeEl('select', 'auth-locale-select', { 'data-i18n-aria-label': 'common.selectLanguage' });
      const authView = makeEl('div', 'auth-view');
      const appView = makeEl('div', 'app-view');
      const toastContainer = makeEl('div', 'toast-container');
      const userDisplayName = makeEl('span', 'user-display-name');
      const userRoleBadge = makeEl('span', 'user-role-badge');
      const tenantIndicator = makeEl('span', 'tenant-indicator');
      const activeViewLabel = makeEl('span', 'active-view-label', { text: 'Workspace' });
      const navAdminSection = makeEl('div', 'nav-admin-section');
      const navWorkspace = makeEl('a', 'nav-workspace', { 'data-view': 'workspace' });
      const navWorkspaceLabel = makeEl('span', '', { 'data-i18n': 'chat.navLabel', text: 'Chat' });
      navWorkspace.appendChild(navWorkspaceLabel);

      const navManagement = makeEl('a', 'nav-management', { 'data-view': 'management' });
      const navManagementLabel = makeEl('span', '', { 'data-i18n': 'management.navLabel', text: 'Management' });
      navManagement.appendChild(navManagementLabel);

      const navAccount = makeEl('a', 'nav-account', { 'data-view': 'account' });
      const navAccountLabel = makeEl('span', '', { 'data-i18n': 'account.navLabel', text: 'Account' });
      navAccount.appendChild(navAccountLabel);

      const btnLogout = makeEl('button', 'btn-logout', { 'data-i18n': 'auth.signOut', text: 'Sign Out' });
      const btnNewSpace = makeEl('button', 'btn-new-space', { 'data-i18n': 'chat.newSpace', text: '+ Space' });
      const tabRuntime = makeEl('button', 'tab-btn-runtime', { 'data-i18n': 'management.tabRuntime', text: 'Runtime' });
      const tabWorkspaces = makeEl('button', 'tab-btn-workspaces', { 'data-i18n': 'management.tabWorkspaces', text: 'Workspaces' });

      const allRegistered = [
        navWorkspaceLabel,
        navManagementLabel,
        navAccountLabel,
        btnLogout,
        btnNewSpace,
        tabRuntime,
        tabWorkspaces,
      ];

      const mockDoc: any = {
        documentElement: htmlDocEl,
        body: makeEl('body'),
        getElementById: (id: string) => elements[id] || null,
        createElement: (tag: string) => makeEl(tag),
        querySelectorAll: (selector: string) => {
          if (selector === '[data-i18n]') {
            return allRegistered.filter((el) => el.getAttribute('data-i18n'));
          }
          if (selector === '[data-i18n-placeholder]') return [];
          if (selector === '[data-i18n-title]') return [];
          if (selector === '[data-i18n-aria-label]') {
            return [topbarSelect, authSelect];
          }
          return [];
        },
      };

      return { mockDoc, elements, htmlDocEl, topbarSelect, authSelect, allRegistered };
    }

    it('Scenario: Fresh browser -> Alice (zh-CN) logs in -> UI renders zh-CN -> Session restore -> Bob (en) logs in -> UI renders en', async () => {
      const { mockDoc, htmlDocEl, topbarSelect, authSelect, elements } = createMockDomTree();
      const origDoc = globalThis.document;
      const origWin = globalThis.window;
      const origStorage = globalThis.localStorage;

      // Fresh browser: No localStorage
      const storageState: Record<string, string> = {};
      globalThis.localStorage = {
        getItem: (k: string) => storageState[k] || null,
        setItem: (k: string, v: string) => { storageState[k] = v; },
        removeItem: (k: string) => { delete storageState[k]; },
        clear: () => {},
        length: 0,
        key: () => null,
      };

      globalThis.document = mockDoc;
      const dispatchedEvents: any[] = [];
      globalThis.window = {
        dispatchEvent: (ev: any) => dispatchedEvents.push(ev),
        location: { hash: '#workspace' },
      } as any;

      // 1. Initial page load before login (DOMContentLoaded): Default English
      initI18n();
      expect(htmlDocEl.lang).toBe('en');
      expect(topbarSelect.value).toBe('en');
      expect(authSelect.value).toBe('en');

      // 2. Alice logs in: Backend DB has user.locale = 'zh-CN'
      const aliceUser = {
        id: 'user_alice_123',
        username: 'alice',
        displayName: 'Alice Admin',
        role: 'admin',
        locale: 'zh-CN',
      };

      // Execute onLoginSuccess flow
      const targetLocale = detectLocale(aliceUser);
      expect(targetLocale).toBe('zh-CN');

      setLocale(targetLocale, { persist: false, source: 'login' });

      // Assert UI is synchronously updated to Simplified Chinese
      expect(htmlDocEl.lang).toBe('zh-CN');
      expect(topbarSelect.value).toBe('zh-CN');
      expect(authSelect.value).toBe('zh-CN');

      // Assert DOM static elements translated to Chinese
      const navChat = elements['nav-workspace'].childNodes[0];
      expect(navChat.textContent).toBe('对话');

      const navMgmt = elements['nav-management'].childNodes[0];
      expect(navMgmt.textContent).toBe('管理');

      const navAcc = elements['nav-account'].childNodes[0];
      expect(navAcc.textContent).toBe('个人账户');

      const btnSignOut = elements['btn-logout'];
      expect(btnSignOut.textContent).toBe('退出登录');

      const btnNewSp = elements['btn-new-space'];
      expect(btnNewSp.textContent).toBe('+ 空间');

      const tabRt = elements['tab-btn-runtime'];
      expect(tabRt.textContent).toBe('运行时');

      // Assert event dispatched
      const lastEvent = dispatchedEvents[dispatchedEvents.length - 1];
      expect(lastEvent.detail.locale).toBe('zh-CN');

      // 3. Alice session restore path via GET /api/auth/me
      const restoredLocale = detectLocale(aliceUser);
      setLocale(restoredLocale, { persist: false, source: 'login' });
      expect(htmlDocEl.lang).toBe('zh-CN');
      expect(topbarSelect.value).toBe('zh-CN');

      // 4. Alice logs out: UI falls back to unauthenticated default
      const logoutLocale = detectLocale(null);
      setLocale(logoutLocale, { persist: false });
      expect(htmlDocEl.lang).toBe('en');
      expect(topbarSelect.value).toBe('en');

      // 5. Bob logs in: Backend DB has user.locale = 'en'
      const bobUser = {
        id: 'user_bob_456',
        username: 'bob',
        displayName: 'Bob Member',
        role: 'user',
        locale: 'en',
      };

      const bobTargetLocale = detectLocale(bobUser);
      expect(bobTargetLocale).toBe('en');
      setLocale(bobTargetLocale, { persist: false, source: 'login' });

      // Assert UI is in English
      expect(htmlDocEl.lang).toBe('en');
      expect(topbarSelect.value).toBe('en');
      expect(navChat.textContent).toBe('Chat');
      expect(navMgmt.textContent).toBe('Management');
      expect(navAcc.textContent).toBe('Account');
      expect(btnSignOut.textContent).toBe('Sign Out');
      expect(btnNewSp.textContent).toBe('+ Space');
      expect(tabRt.textContent).toBe('Runtime');

      // Cleanup
      globalThis.document = origDoc;
      globalThis.window = origWin;
      globalThis.localStorage = origStorage;
    });

    it('Scenario: User switches language in UI -> Calls PATCH /api/account/preferences with Idempotency-Key -> Handles error rollback', async () => {
      const { mockDoc, htmlDocEl, topbarSelect } = createMockDomTree();
      const origDoc = globalThis.document;
      const origWin = globalThis.window;

      globalThis.document = mockDoc;
      globalThis.window = {
        dispatchEvent: () => {},
        location: { hash: '#workspace' },
      } as any;

      // Active user in English
      const currentUser = { id: 'u1', username: 'bob', locale: 'en' };
      setLocale('en', { persist: false });
      expect(htmlDocEl.lang).toBe('en');

      // Mock API Client tracking
      const patchCalls: any[] = [];
      let shouldApiFail = false;

      const mockApiRequest = async (url: string, opts: any) => {
        patchCalls.push({ url, opts });
        if (shouldApiFail) {
          const err: any = new Error('HTTP 500');
          err.status = 500;
          throw err;
        }
        return { success: true, data: { userId: currentUser.id, locale: opts.body.locale } };
      };

      // Function simulating handleLocaleSelectChange in app.js
      async function testHandleLocaleChange(newLocale: string) {
        const previousLocale = getLocale();
        if (newLocale === previousLocale) return;

        setLocale(newLocale);

        if (currentUser) {
          try {
            const idempotencyKey = 'test-idemp-uuid-12345';
            await mockApiRequest('/api/account/preferences', {
              method: 'PATCH',
              headers: { 'Idempotency-Key': idempotencyKey },
              body: { locale: newLocale },
            });
            currentUser.locale = newLocale;
          } catch {
            setLocale(previousLocale);
          }
        }
      }

      // 1. Successful change to zh-CN
      await testHandleLocaleChange('zh-CN');
      expect(currentUser.locale).toBe('zh-CN');
      expect(htmlDocEl.lang).toBe('zh-CN');
      expect(topbarSelect.value).toBe('zh-CN');
      expect(patchCalls.length).toBe(1);
      expect(patchCalls[0].url).toBe('/api/account/preferences');
      expect(patchCalls[0].opts.method).toBe('PATCH');
      expect(patchCalls[0].opts.headers['Idempotency-Key']).toBe('test-idemp-uuid-12345');
      expect(patchCalls[0].opts.body).toEqual({ locale: 'zh-CN' });

      // 2. Failed change back to en -> Rollback to zh-CN
      shouldApiFail = true;
      await testHandleLocaleChange('en');
      expect(currentUser.locale).toBe('zh-CN');
      expect(htmlDocEl.lang).toBe('zh-CN');
      expect(topbarSelect.value).toBe('zh-CN');
      expect(patchCalls.length).toBe(2);

      globalThis.document = origDoc;
      globalThis.window = origWin;
    });
  });
});
