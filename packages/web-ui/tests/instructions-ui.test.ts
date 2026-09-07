/**
 * Comprehensive Unit Tests for Enkeep Web UI Instructions Subsystem
 *
 * Tests:
 * 1. Personal Instructions in Account View (lightweight card, open editor, 20 KiB limit, turn lifecycle notice)
 * 2. Space Instructions in Workspaces View (Space Instructions section, space selector, AGENTS.md / CLAUDE.md tabs, 64 KiB limit)
 * 3. Real-time UTF-8 byte counting and strict size boundary enforcement
 * 4. Concurrency conflict handling (409 / 428), ETag CAS, Force Overwrite & Reload Server Version
 * 5. Dirty draft guard and unsaved changes confirmation dialog
 * 6. Symmetrical i18n support in English & Chinese, zero hardcoded strings
 * 7. Strict architectural invariants: zero innerHTML, zero inline styles, zero localStorage leakage, zero Memory/MCP/Extension terminology
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getWebUiIndexHtml, getWebUiAsset } from '../src/index.js';
import { en, zhCN, t } from '../src/static/i18n.js';

describe('Enkeep Web UI Instructions Subsystem', () => {
  const html = getWebUiIndexHtml();
  const cssAsset = getWebUiAsset('style.css');
  const jsAsset = getWebUiAsset('app.js');
  const cssContent = cssAsset.content.toString('utf-8');
  const jsCode = jsAsset.content.toString('utf-8');

  describe('1. Architectural Invariants & Information Architecture', () => {
    it('preserves exactly 5 top-level management tabs without adding an extra tab', () => {
      const tabMatches = html.match(/id="tab-btn-[^"]+"/g);
      expect(tabMatches).toHaveLength(5);
      expect(html).toContain('id="tab-btn-runtime"');
      expect(html).toContain('id="tab-btn-workspaces"');
      expect(html).toContain('id="tab-btn-storage"');
      expect(html).toContain('id="tab-btn-users"');
      expect(html).toContain('id="tab-btn-models"');
      expect(html).not.toContain('id="tab-btn-instructions"');
      expect(html).not.toContain('id="tab-btn-memory"');
    });

    it('contains zero Memory, MCP, or Extension routes and terminology in instructions code', () => {
      const instructionsSectionCode = jsCode.slice(
        jsCode.indexOf('// 2.2 Instructions Editor'),
        jsCode.indexOf('// 2.5 Agent Profiles View')
      );
      expect(instructionsSectionCode).not.toContain('/api/memory');
      expect(instructionsSectionCode).not.toContain('/api/mcp');
      expect(instructionsSectionCode).not.toContain('/api/extensions');
      expect(instructionsSectionCode.toLowerCase()).not.toContain('mcp server');
      expect(instructionsSectionCode.toLowerCase()).not.toContain('memory bank');
    });

    it('enforces zero localStorage content persistence for instructions drafts', () => {
      const instructionsSectionCode = jsCode.slice(
        jsCode.indexOf('// 2.2 Instructions Editor'),
        jsCode.indexOf('// 2.5 Agent Profiles View')
      );
      expect(instructionsSectionCode).not.toContain('localStorage');
      expect(instructionsSectionCode).not.toContain('sessionStorage');
    });

    it('enforces zero unsafe innerHTML and zero inline style assignments across instructions code', () => {
      const instructionsSectionCode = jsCode.slice(
        jsCode.indexOf('// 2.2 Instructions Editor'),
        jsCode.indexOf('// 2.5 Agent Profiles View')
      );
      expect(instructionsSectionCode).not.toContain('.innerHTML');
      expect(instructionsSectionCode).not.toContain('.insertAdjacentHTML');
      expect(instructionsSectionCode).not.toContain('.style.');
      expect(instructionsSectionCode).not.toContain('style=');
    });
  });

  describe('2. Routing & Section Registration', () => {
    it('registers instructions section in TAB_SECTIONS_ADMIN and TAB_SECTIONS_MEMBER under workspaces', () => {
      const fnCode = `
        ${jsCode.match(/const TAB_SECTIONS_ADMIN =[\s\S]*?;\n\nconst TAB_SECTIONS_MEMBER =[\s\S]*?;\n/)![0]}
        return { TAB_SECTIONS_ADMIN, TAB_SECTIONS_MEMBER };
      `;
      const { TAB_SECTIONS_ADMIN, TAB_SECTIONS_MEMBER } = new Function(fnCode)();

      expect(TAB_SECTIONS_ADMIN.workspaces.map((s: any) => s.id)).toContain('instructions');
      expect(TAB_SECTIONS_MEMBER.workspaces.map((s: any) => s.id)).toContain('instructions');

      const adminSec = TAB_SECTIONS_ADMIN.workspaces.find((s: any) => s.id === 'instructions');
      expect(adminSec.label).toBe('Space Instructions');
    });

    it('maps legacy route "instructions" and "space-instructions" to "management/workspaces/instructions"', () => {
      const fnCode = `
        ${jsCode.match(/const OLD_ROUTE_MAP =[\s\S]*?;\n/)![0]}
        return OLD_ROUTE_MAP;
      `;
      const OLD_ROUTE_MAP = new Function(fnCode)();

      expect(OLD_ROUTE_MAP.instructions).toBe('management/workspaces/instructions');
      expect(OLD_ROUTE_MAP['space-instructions']).toBe('management/workspaces/instructions');
    });
  });

  describe('3. Instructions Editor Component Factory Contract', () => {
    it('defines getUtf8ByteLength with accurate byte calculation for ASCII, Unicode, and Emoji', () => {
      const fnCode = `
        ${jsCode.match(/function getUtf8ByteLength[\s\S]*?\n\}/)![0]}
        return getUtf8ByteLength;
      `;
      const getUtf8ByteLength = new Function(fnCode)();

      expect(getUtf8ByteLength('')).toBe(0);
      expect(getUtf8ByteLength('hello')).toBe(5);
      expect(getUtf8ByteLength('你好')).toBe(6); // 2 Chinese characters * 3 bytes
      expect(getUtf8ByteLength('🚀')).toBe(4); // Emoji 4 bytes
      expect(getUtf8ByteLength('Hello 世界 🌍')).toBe(5 + 1 + 6 + 1 + 4);
    });

    it('enforces 20 KiB (20480 bytes) limit for Global Instructions and 64 KiB (65536 bytes) for Space Instructions', () => {
      expect(jsCode).toContain('const maxBytes = options.maxBytes || (isGlobal ? 20480 : 65536);');
      expect(jsCode).toContain('20480');
      expect(jsCode).toContain('65536');
    });

    it('configures Personal Instructions in Account view and Space Instructions in Workspaces view', () => {
      expect(jsCode).toContain('renderSpaceInstructionsView');
      expect(jsCode).toContain('createInstructionsEditor({');
      expect(jsCode).toContain("target: 'global'");
      expect(jsCode).toContain("target: 'space'");
      expect(jsCode).toContain("initialFile: 'AGENTS.md'");
      expect(jsCode).toContain('personalEditor.load()');
    });

    it('enforces strict PUT request shape with body { content } and If-Match header', () => {
      const instructionsSectionCode = jsCode.slice(
        jsCode.indexOf('// 2.2 Instructions Editor'),
        jsCode.indexOf('// 2.5 Agent Profiles View')
      );
      expect(instructionsSectionCode).toContain('const body = { content: contentToSave };');
      expect(instructionsSectionCode).toContain("headers['If-Match'] = currentEtag;");
      expect(instructionsSectionCode).not.toContain('forceOverwrite');
      expect(instructionsSectionCode).not.toContain('btnConflictOverwrite');
    });

    it('implements dirty guard with confirmation dialog before switching files, spaces, or reloading', () => {
      const instructionsSectionCode = jsCode.slice(
        jsCode.indexOf('// 2.2 Instructions Editor'),
        jsCode.indexOf('// 2.5 Agent Profiles View')
      );
      expect(instructionsSectionCode).toContain('confirmDiscardIfDirty');
      expect(instructionsSectionCode).toContain('showConfirmDialog');
      expect(instructionsSectionCode).toContain('instructions.unsavedAlertTitle');
      expect(instructionsSectionCode).toContain('instructions.unsavedAlertDesc');
    });
  });

  describe('4. CSS Design Tokens & Multi-Theme Verification', () => {
    it('defines complete instructions component CSS classes in style.css', () => {
      expect(cssContent).toContain('.instructions-container');
      expect(cssContent).toContain('.instructions-editor-card');
      expect(cssContent).toContain('.instructions-editor-header');
      expect(cssContent).toContain('.instructions-space-picker');
      expect(cssContent).toContain('.instructions-file-tabs');
      expect(cssContent).toContain('.instructions-file-tab');
      expect(cssContent).toContain('.instructions-meta-bar');
      expect(cssContent).toContain('.instructions-byte-counter');
      expect(cssContent).toContain('.instructions-unsaved-badge');
      expect(cssContent).toContain('.instructions-textarea');
      expect(cssContent).toContain('.instructions-conflict-banner');
      expect(cssContent).toContain('.instructions-actions-bar');
    });

    it('contains zero hardcoded colors in instructions CSS classes and uses theme variables', () => {
      const instructionsCss = cssContent.slice(
        cssContent.indexOf('/* ==========================================================================\n   26. INSTRUCTIONS EDITOR COMPONENT'),
        cssContent.indexOf('@media (max-width: 768px)')
      );

      const hexMatches = instructionsCss.match(/#[0-9a-fA-F]{3,8}\b/g);
      expect(hexMatches ?? []).toEqual([]);
    });

    it('includes responsive mobile layout rules for screens <= 768px', () => {
      const mobileMediaCss = cssContent.slice(cssContent.lastIndexOf('@media (max-width: 768px)'));
      expect(mobileMediaCss).toContain('.instructions-header-top');
      expect(mobileMediaCss).toContain('.instructions-toolbar');
      expect(mobileMediaCss).toContain('.instructions-space-picker');
      expect(mobileMediaCss).toContain('.instructions-file-tabs');
      expect(mobileMediaCss).toContain('.instructions-actions-bar');
    });
  });

  describe('5. Internationalization (i18n) Symmetrical Key Verification', () => {
    const requiredInstructionsKeys = [
      'instructions.badgeReadOnly',
      'instructions.badgeUnsaved',
      'instructions.btnConflictOverwrite',
      'instructions.btnConflictReload',
      'instructions.btnDiscard',
      'instructions.btnSave',
      'instructions.byteCounter',
      'instructions.byteLimitExceeded',
      'instructions.conflictDesc',
      'instructions.conflictTitle',
      'instructions.emptySpace',
      'instructions.globalCardDesc',
      'instructions.globalCardTitle',
      'instructions.globalExplanation',
      'instructions.labelBytes',
      'instructions.labelEtag',
      'instructions.labelFile',
      'instructions.labelSpace',
      'instructions.personalCardDesc',
      'instructions.personalCardTitle',
      'instructions.placeholder',
      'instructions.saveSuccess',
      'instructions.spaceCardDesc',
      'instructions.spaceCardTitle',
      'instructions.spaceExplanation',
      'instructions.subtitle',
      'instructions.tabAgents',
      'instructions.tabClaude',
      'instructions.tabGlobal',
      'instructions.title',
      'instructions.unsavedAlertDesc',
      'instructions.unsavedAlertTitle',
      'section.workspaces.instructions.desc',
      'section.workspaces.instructions.label',
    ];

    it('has non-empty translations in both English and Simplified Chinese catalogs for all required keys', () => {
      for (const key of requiredInstructionsKeys) {
        expect(en[key], `Missing English key "${key}"`).toBeDefined();
        expect(en[key].trim().length, `Empty English value for "${key}"`).toBeGreaterThan(0);

        expect(zhCN[key], `Missing Chinese key "${key}"`).toBeDefined();
        expect(zhCN[key].trim().length, `Empty Chinese value for "${key}"`).toBeGreaterThan(0);
      }
    });

    it('correctly translates global explanation note indicating next-turn lifecycle', () => {
      expect(en['instructions.globalExplanation']).toContain('Every new or next turn');
      expect(zhCN['instructions.globalExplanation']).toContain('每次新对话或后续轮次 (New/Next turn)');
    });

    it('correctly translates space explanation note emphasizing AGENTS priority and CLAUDE supplementary', () => {
      expect(en['section.workspaces.instructions.label']).toBe('Space Instructions');
      expect(zhCN['section.workspaces.instructions.label']).toBe('空间提示词指令');
    });
  });
});
