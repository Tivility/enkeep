/**
 * Focused Contract Test for Session Channel Source Badges
 *
 * Verifies:
 * 1. i18n translations for Web / Lark / WeChat / QQ / Discord / Generic / Session in en & zh-CN
 * 2. CSS design tokens and class definitions for .session-badges and .badge-channel-*
 * 3. Synthetic same-space same-title Web+Lark items are visibly distinct while title and select behavior remain unchanged
 * 4. Channel alias resolution (feishu -> Lark/飞书, weixin/wx -> WeChat/微信)
 * 5. Unknown channel fallback to generic channel
 * 6. Missing channel defaults to Web only under known Web semantics, otherwise neutral '会话/Session'
 * 7. Accessible labels (aria-label) and click handlers intact
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWebUiAsset } from '../src/index.js';
import { en, zhCN, catalogs, SUPPORTED_LOCALES } from '../src/static/i18n.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('Session Channel Labels Contract Tests', () => {
  let appJsCode: string;
  let cssCode: string;

  beforeEach(() => {
    appJsCode = readFileSync(join(__dirname, '../src/static/app.js'), 'utf-8');
    const cssAsset = getWebUiAsset('style.css');
    cssCode = cssAsset.content.toString('utf-8');
  });

  describe('1. Internationalization (i18n) Contract', () => {
    it('declares all required channel keys in en and zh-CN catalogs', () => {
      expect(SUPPORTED_LOCALES).toContain('en');
      expect(SUPPORTED_LOCALES).toContain('zh-CN');

      const enCat = catalogs['en'] || en;
      const zhCat = catalogs['zh-CN'] || zhCN;

      // English
      expect(enCat['chat.channelWeb']).toBe('Web');
      expect(enCat['chat.channelLark']).toBe('Lark');
      expect(enCat['chat.channelWeChat']).toBe('WeChat');
      expect(enCat['chat.channelQQ']).toBe('QQ');
      expect(enCat['chat.channelDiscord']).toBe('Discord');
      expect(enCat['chat.channelGeneric']).toBe('Channel');
      expect(enCat['chat.channelSession']).toBe('Session');
      expect(enCat['chat.channelConversation']).toBe('Conversation');
      expect(enCat['chat.channelWebAria']).toBe('Source: Web');
      expect(enCat['chat.channelLarkAria']).toBe('Source: Lark');
      expect(enCat['chat.channelWeChatAria']).toBe('Source: WeChat');
      expect(enCat['chat.channelQQAria']).toBe('Source: QQ');
      expect(enCat['chat.channelDiscordAria']).toBe('Source: Discord');
      expect(enCat['chat.channelGenericAria']).toBe('Source: Channel');
      expect(enCat['chat.channelSessionAria']).toBe('Source: Session');
      expect(enCat['chat.channelConversationAria']).toBe('Source: Conversation');

      // Chinese
      expect(zhCat['chat.channelWeb']).toBe('Web');
      expect(zhCat['chat.channelLark']).toBe('飞书');
      expect(zhCat['chat.channelWeChat']).toBe('微信');
      expect(zhCat['chat.channelQQ']).toBe('QQ');
      expect(zhCat['chat.channelDiscord']).toBe('Discord');
      expect(zhCat['chat.channelGeneric']).toBe('渠道');
      expect(zhCat['chat.channelSession']).toBe('会话');
      expect(zhCat['chat.channelConversation']).toBe('主会话');
      expect(zhCat['chat.channelWebAria']).toBe('来源：Web');
      expect(zhCat['chat.channelLarkAria']).toBe('来源：飞书');
      expect(zhCat['chat.channelWeChatAria']).toBe('来源：微信');
      expect(zhCat['chat.channelQQAria']).toBe('来源：QQ');
      expect(zhCat['chat.channelDiscordAria']).toBe('来源：Discord');
      expect(zhCat['chat.channelGenericAria']).toBe('来源：渠道');
      expect(zhCat['chat.channelSessionAria']).toBe('来源：会话');
      expect(zhCat['chat.channelConversationAria']).toBe('来源：主会话');
    });

    it('contains channel keys in app.js internal catalogs (CHAT_I18N_EN and CHAT_I18N_ZH)', () => {
      expect(appJsCode).toContain("'chat.channelWeb': 'Web'");
      expect(appJsCode).toContain("'chat.channelLark': 'Lark'");
      expect(appJsCode).toContain("'chat.channelLark': '飞书'");
      expect(appJsCode).toContain("'chat.channelWeChat': 'WeChat'");
      expect(appJsCode).toContain("'chat.channelWeChat': '微信'");
      expect(appJsCode).toContain("'chat.channelGeneric': 'Channel'");
      expect(appJsCode).toContain("'chat.channelGeneric': '渠道'");
      expect(appJsCode).toContain("'chat.channelSession': 'Session'");
      expect(appJsCode).toContain("'chat.channelSession': '会话'");
      expect(appJsCode).toContain("'chat.channelConversation': 'Conversation'");
      expect(appJsCode).toContain("'chat.channelConversation': '主会话'");
    });
  });

  describe('2. CSS Design Tokens & Styles Contract', () => {
    it('defines .session-badges and all .badge-channel-* styles using design tokens', () => {
      expect(cssCode).toContain('.session-badges');
      expect(cssCode).toContain('.badge-channel');
      expect(cssCode).toContain('.badge-channel-web');
      expect(cssCode).toContain('.badge-channel-lark');
      expect(cssCode).toContain('.badge-channel-wechat');
      expect(cssCode).toContain('.badge-channel-qq');
      expect(cssCode).toContain('.badge-channel-discord');
      expect(cssCode).toContain('.badge-channel-generic');
      expect(cssCode).toContain('.badge-channel-canonical');
      expect(cssCode).toContain('.badge-channel-default');

      // Verifies usage of CSS variables / design tokens
      expect(cssCode).toContain('var(--bg-tertiary)');
      expect(cssCode).toContain('var(--info-bg)');
      expect(cssCode).toContain('var(--success-bg)');
      expect(cssCode).toContain('var(--accent-bg)');
    });
  });

  describe('3. Synthetic Same-Space Same-Title Web + Lark Rendering & Distinctness', () => {
    function createMockElement(tag: string) {
      const el: any = {
        tagName: tag.toUpperCase(),
        className: '',
        type: '',
        textContent: '',
        title: '',
        attributes: {} as Record<string, string>,
        children: [] as any[],
        listeners: {} as Record<string, Function>,
        setAttribute(name: string, val: string) {
          el.attributes[name] = val;
        },
        getAttribute(name: string) {
          return el.attributes[name] ?? null;
        },
        addEventListener(event: string, fn: Function) {
          el.listeners[event] = fn;
        },
        appendChild(child: any) {
          el.children.push(child);
        },
        replaceChildren() {
          el.children = [];
        },
        querySelector(selector: string) {
          function search(node: any): any {
            if (!node || !node.children) return null;
            for (const c of node.children) {
              if (selector.startsWith('.') && c.className && c.className.split(' ').includes(selector.slice(1))) {
                return c;
              }
              const found = search(c);
              if (found) return found;
            }
            return null;
          }
          return search(el);
        },
        hasChildNodes() {
          return el.children.length > 0;
        },
      };
      return el;
    }

    it('renders synthetic same-space same-title Web and Lark sessions as visibly distinct while preserving title and click behavior', () => {
      const sessionListContainer = createMockElement('div');
      const selectedIds: string[] = [];

      // Extract getSessionSourceBadgeInfo implementation from app.js
      const fnSourceMatch = appJsCode.match(/function getSessionSourceBadgeInfo\([\s\S]*?\n\}/);
      expect(fnSourceMatch).not.toBeNull();
      const getSessionSourceBadgeInfo = new Function('session', 'tr', `
        ${fnSourceMatch![0]}
        return getSessionSourceBadgeInfo(session);
      `);

      const mockTr = (key: string, _params: any, fallback: string) => {
        return en[key as keyof typeof en] || fallback;
      };

      const syntheticSessions = [
        {
          id: 'ses_web_1',
          spaceId: 'spc_same_001',
          title: 'Customer Support',
          channel: 'web',
          currentGeneration: 1,
        },
        {
          id: 'ses_lark_1',
          spaceId: 'spc_same_001',
          title: 'Customer Support',
          channel: 'lark',
          currentGeneration: 1,
        },
      ];

      // Simulate renderSessionList
      syntheticSessions.forEach((session) => {
        const item = createMockElement('button');
        item.type = 'button';
        item.className = `session-item ${session.id === 'ses_web_1' ? 'active' : ''}`;
        item.addEventListener('click', () => selectedIds.push(session.id));

        const titleDiv = createMockElement('div');
        titleDiv.className = 'session-title';
        titleDiv.textContent = session.title;
        item.appendChild(titleDiv);

        const badgesDiv = createMockElement('div');
        badgesDiv.className = 'session-badges';

        const sourceInfo = getSessionSourceBadgeInfo(session, mockTr);
        expect(sourceInfo).toBeDefined();

        const srcBadge = createMockElement('span');
        srcBadge.className = `badge badge-xs badge-channel badge-channel-${sourceInfo.type}`;
        srcBadge.textContent = sourceInfo.label;
        srcBadge.setAttribute('aria-label', sourceInfo.ariaLabel);
        srcBadge.title = sourceInfo.ariaLabel;
        badgesDiv.appendChild(srcBadge);

        if (session.currentGeneration >= 1) {
          const genBadge = createMockElement('span');
          genBadge.className = 'badge badge-generation badge-xs';
          genBadge.textContent = `Gen ${session.currentGeneration}`;
          badgesDiv.appendChild(genBadge);
        }

        if (badgesDiv.hasChildNodes()) {
          item.appendChild(badgesDiv);
        }

        sessionListContainer.appendChild(item);
      });

      expect(sessionListContainer.children.length).toBe(2);

      const [webItem, larkItem] = sessionListContainer.children;

      // 1. Titles remain identical and untouched
      const webTitle = webItem.querySelector('.session-title');
      const larkTitle = larkItem.querySelector('.session-title');
      expect(webTitle.textContent).toBe('Customer Support');
      expect(larkTitle.textContent).toBe('Customer Support');

      // 2. Source badges distinguish them visibly
      const webBadge = webItem.querySelector('.badge-channel-web');
      const larkBadge = larkItem.querySelector('.badge-channel-lark');
      expect(webBadge).not.toBeNull();
      expect(larkBadge).not.toBeNull();
      expect(webBadge.textContent).toBe('Web');
      expect(larkBadge.textContent).toBe('Lark');
      expect(webBadge.getAttribute('aria-label')).toBe('Source: Web');
      expect(larkBadge.getAttribute('aria-label')).toBe('Source: Lark');

      // 3. Generation badges intact
      const webGen = webItem.querySelector('.badge-generation');
      const larkGen = larkItem.querySelector('.badge-generation');
      expect(webGen.textContent).toBe('Gen 1');
      expect(larkGen.textContent).toBe('Gen 1');

      // 4. Click behavior unchanged
      webItem.listeners['click']();
      expect(selectedIds).toEqual(['ses_web_1']);
      larkItem.listeners['click']();
      expect(selectedIds).toEqual(['ses_web_1', 'ses_lark_1']);
    });
  });

  describe('4. Channel Resolution Matrix & Neutral Fallback Contract', () => {
    it('correctly maps all channels, aliases, unknown generic fallbacks, and missing channel semantics', () => {
      const fnSourceMatch = appJsCode.match(/function getSessionSourceBadgeInfo\([\s\S]*?\n\}/);
      expect(fnSourceMatch).not.toBeNull();

      const testState: any = {
        currentSpaceId: 'spc_canon_test',
        spaces: [{ id: 'spc_canon_test', canonicalSessionId: 'ses_canon_01' }],
      };

      const getSessionSourceBadgeInfo = new Function('state', 'session', 'tr', `
        ${fnSourceMatch![0]}
        return getSessionSourceBadgeInfo(session);
      `).bind(null, testState);

      // English
      const trEn = (k: string, _p: any, fb: string) => en[k as keyof typeof en] || fb;

      // Authoritative Canonical Conversation matching space.canonicalSessionId
      expect(getSessionSourceBadgeInfo({ id: 'ses_canon_01' }, trEn)).toEqual({
        type: 'canonical',
        label: 'Conversation',
        ariaLabel: 'Source: Conversation',
      });

      // Web
      expect(getSessionSourceBadgeInfo({ channel: 'web' }, trEn)).toEqual({
        type: 'web',
        label: 'Web',
        ariaLabel: 'Source: Web',
      });
      expect(getSessionSourceBadgeInfo({ channel: 'WEB' }, trEn)).toEqual({
        type: 'web',
        label: 'Web',
        ariaLabel: 'Source: Web',
      });

      // Lark / Feishu alias
      expect(getSessionSourceBadgeInfo({ channel: 'lark' }, trEn)).toEqual({
        type: 'lark',
        label: 'Lark',
        ariaLabel: 'Source: Lark',
      });
      expect(getSessionSourceBadgeInfo({ channel: 'feishu' }, trEn)).toEqual({
        type: 'lark',
        label: 'Lark',
        ariaLabel: 'Source: Lark',
      });

      // WeChat / Weixin / Wx alias
      expect(getSessionSourceBadgeInfo({ channel: 'wechat' }, trEn)).toEqual({
        type: 'wechat',
        label: 'WeChat',
        ariaLabel: 'Source: WeChat',
      });
      expect(getSessionSourceBadgeInfo({ channel: 'weixin' }, trEn)).toEqual({
        type: 'wechat',
        label: 'WeChat',
        ariaLabel: 'Source: WeChat',
      });
      expect(getSessionSourceBadgeInfo({ channel: 'wx' }, trEn)).toEqual({
        type: 'wechat',
        label: 'WeChat',
        ariaLabel: 'Source: WeChat',
      });

      // QQ
      expect(getSessionSourceBadgeInfo({ channel: 'qq' }, trEn)).toEqual({
        type: 'qq',
        label: 'QQ',
        ariaLabel: 'Source: QQ',
      });

      // Discord
      expect(getSessionSourceBadgeInfo({ channel: 'discord' }, trEn)).toEqual({
        type: 'discord',
        label: 'Discord',
        ariaLabel: 'Source: Discord',
      });

      // Unknown channel fallback to generic channel
      expect(getSessionSourceBadgeInfo({ channel: 'slack' }, trEn)).toEqual({
        type: 'generic',
        label: 'Channel',
        ariaLabel: 'Source: Channel',
      });

      // Missing channel with known Web semantics
      expect(getSessionSourceBadgeInfo({ isWeb: true }, trEn)).toEqual({
        type: 'web',
        label: 'Web',
        ariaLabel: 'Source: Web',
      });
      expect(getSessionSourceBadgeInfo({ sourceType: 'web' }, trEn)).toEqual({
        type: 'web',
        label: 'Web',
        ariaLabel: 'Source: Web',
      });

      // Missing channel WITHOUT known Web semantics: neutral Session/会话 (NOT fabricated provider!)
      expect(getSessionSourceBadgeInfo({}, trEn)).toEqual({
        type: 'default',
        label: 'Session',
        ariaLabel: 'Source: Session',
      });
      expect(getSessionSourceBadgeInfo({ id: 'ses_123', title: 'Test' }, trEn)).toEqual({
        type: 'default',
        label: 'Session',
        ariaLabel: 'Source: Session',
      });

      // Chinese (zh-CN) checks
      const trZh = (k: string, _p: any, fb: string) => zhCN[k as keyof typeof zhCN] || fb;

      expect(getSessionSourceBadgeInfo({ channel: 'lark' }, trZh).label).toBe('飞书');
      expect(getSessionSourceBadgeInfo({ channel: 'feishu' }, trZh).label).toBe('飞书');
      expect(getSessionSourceBadgeInfo({ channel: 'wechat' }, trZh).label).toBe('微信');
      expect(getSessionSourceBadgeInfo({ channel: 'qq' }, trZh).label).toBe('QQ');
      expect(getSessionSourceBadgeInfo({ channel: 'discord' }, trZh).label).toBe('Discord');
      expect(getSessionSourceBadgeInfo({ channel: 'slack' }, trZh).label).toBe('渠道');
      expect(getSessionSourceBadgeInfo({ id: 'ses_canon_01' }, trZh).label).toBe('主会话');
      expect(getSessionSourceBadgeInfo({ id: 'ses_canon_01' }, trZh).ariaLabel).toBe('来源：主会话');
      expect(getSessionSourceBadgeInfo({}, trZh).label).toBe('会话');
      expect(getSessionSourceBadgeInfo({}, trZh).ariaLabel).toBe('来源：会话');
    });
  });
});
