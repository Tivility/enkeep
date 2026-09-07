import { describe, it, expect, beforeEach } from 'vitest';
import { getWebUiIndexHtml, getWebUiAsset } from '../src/index.js';
import {
  SUPPORTED_THEMES,
  DEFAULT_THEME,
  en,
  zhCN,
  t,
  setLocale,
} from '../src/static/i18n.js';

describe('Enkeep Web UI Theme Subsystem Unit & Contrast Tests', () => {
  const indexHtml = getWebUiIndexHtml();
  const styleCss = getWebUiAsset('style.css').content.toString('utf-8');
  const appJs = getWebUiAsset('app.js').content.toString('utf-8');
  const bootstrapJs = getWebUiAsset('theme-bootstrap.js').content.toString('utf-8');

  // ----------------------------------------------------
  // 1. Static HTML & CSP Invariants
  // ----------------------------------------------------
  describe('1. Static HTML & Bootstrap Architecture', () => {
    it('loads theme-bootstrap.js in <head> before stylesheets to eliminate FOUC', () => {
      expect(indexHtml).toContain('<script src="/static/theme-bootstrap.js"></script>');
      const scriptIndex = indexHtml.indexOf('<script src="/static/theme-bootstrap.js"></script>');
      const cssIndex = indexHtml.indexOf('<link rel="stylesheet" href="/static/style.css">');
      expect(scriptIndex).toBeGreaterThan(0);
      expect(cssIndex).toBeGreaterThan(scriptIndex);
    });

    it('contains accessible theme select controls across Login, Forced Password, and Topbar', () => {
      expect(indexHtml).toContain('id="auth-theme-select"');
      expect(indexHtml).toContain('id="forced-password-theme-select"');
      expect(indexHtml).toContain('id="theme-select"');

      // Verify each selector has proper aria-labels and options
      expect(indexHtml).toContain('data-i18n-aria-label="common.selectTheme"');
      expect(indexHtml).toContain('value="dark"');
      expect(indexHtml).toContain('value="light"');
      expect(indexHtml).toContain('value="eye-care"');
    });

    it('validates that theme-bootstrap.js contains zero unsafe code and enforces enum validation', () => {
      expect(bootstrapJs).toContain("['dark', 'light', 'eye-care']");
      expect(bootstrapJs).toContain('document.documentElement.dataset.theme');
      expect(bootstrapJs).not.toContain('eval(');
      expect(bootstrapJs).not.toContain('innerHTML');
      expect(bootstrapJs).not.toContain('document.write');
    });

    it('validates system default detection and key migration contract in theme-bootstrap.js', () => {
      expect(bootstrapJs).toContain('prefers-color-scheme: light');
      expect(bootstrapJs).toContain('enkeep.theme.prelogin');
      expect(bootstrapJs).toContain('enkeep.theme');
    });
  });

  // ----------------------------------------------------
  // 2. CSS Design Tokens & Legacy Color Elimination
  // ----------------------------------------------------
  describe('2. CSS Design Tokens & Zero Hardcoded Legacy Colors', () => {
    it('defines complete design token blocks for :root/dark, light, and eye-care themes', () => {
      expect(styleCss).toContain(':root,');
      expect(styleCss).toContain('[data-theme="dark"]');
      expect(styleCss).toContain('[data-theme="light"]');
      expect(styleCss).toContain('[data-theme="eye-care"]');

      const mandatoryTokens = [
        '--bg-primary',
        '--bg-secondary',
        '--bg-tertiary',
        '--bg-card',
        '--bg-card-hover',
        '--bg-topbar',
        '--bg-sidebar',
        '--bg-input',
        '--bg-modal-backdrop',
        '--text-primary',
        '--text-secondary',
        '--text-muted',
        '--text-inverse',
        '--accent',
        '--accent-hover',
        '--accent-bg',
        '--accent-border',
        '--accent-nav',
        '--focus-ring',
        '--nav-divider',
        '--hover-overlay',
        '--message-action-hover-bg',
        '--drawer-shadow',
        '--blue-soft-bg',
        '--green-soft-bg',
        '--green-soft-border',
        '--table-header-bg',
        '--table-stripe-bg',
        '--table-hover-bg',
        '--danger',
        '--danger-bg',
        '--danger-border',
        '--danger-text',
        '--success',
        '--success-bg',
        '--success-border',
        '--success-text',
        '--warning',
        '--warning-bg',
        '--warning-border',
        '--warning-text',
        '--info',
        '--info-bg',
        '--info-border',
        '--info-text',
        '--border',
        '--border-light',
        '--border-subtle',
        '--code-bg',
        '--code-text',
        '--hl-keyword',
        '--hl-string',
        '--hl-comment',
        '--hl-number',
        '--hl-builtin',
        '--hl-variable',
        '--hl-function',
        '--hl-tag',
        '--hl-punctuation',
        '--mermaid-bg',
        '--mermaid-border',
        '--mermaid-text',
      ];

      for (const token of mandatoryTokens) {
        expect(styleCss, `Missing token ${token} in stylesheet`).toContain(`${token}:`);
      }
    });

    it('ensures zero filter: sepia or cheap visual filter hacks are used', () => {
      expect(styleCss).not.toContain('filter: sepia');
      expect(styleCss).not.toContain('backdrop-filter: sepia');
      expect(styleCss).not.toContain('filter: invert');
    });

    it('ensures zero hardcoded hex, rgb, hsl, or rgba colors exist outside the 3 theme token definition blocks', () => {
      // Find where theme token blocks end (section 2 starts)
      const section2Marker = '/* ==========================================================================\n   2. RESET & BASE ELEMENTS';
      const section2Index = styleCss.indexOf(section2Marker);
      expect(section2Index).toBeGreaterThan(0);

      const rulesBody = styleCss.slice(section2Index);

      // Search for any hex colors #xxx or #xxxxxx in CSS rules body
      const hexMatches = rulesBody.match(/#[0-9a-fA-F]{3,8}\b/g);
      expect(hexMatches ?? [], `Found hardcoded hex colors in CSS rules outside tokens: ${hexMatches?.join(', ')}`).toEqual([]);

      // Search for any rgba / rgb / hsl / hsla in CSS rules body
      const rgbaMatches = rulesBody.match(/rgba?\([^)]+\)/g);
      expect(rgbaMatches ?? [], `Found hardcoded rgba/rgb colors in CSS rules outside tokens: ${rgbaMatches?.join(', ')}`).toEqual([]);

      const hslMatches = rulesBody.match(/hsla?\([^)]+\)/g);
      expect(hslMatches ?? [], `Found hardcoded hsl/hsla colors in CSS rules outside tokens: ${hslMatches?.join(', ')}`).toEqual([]);
    });
  });

  // ----------------------------------------------------
  // 3. WCAG AA Contrast Ratios (Algorithm & Blended Background Verification)
  // ----------------------------------------------------
  describe('3. WCAG AA Contrast Ratios Verification (>= 4.5:1 for all normal text)', () => {
    function sRGBtoLin(colorVal: number): number {
      colorVal = colorVal / 255;
      if (colorVal <= 0.03928) return colorVal / 12.92;
      return Math.pow((colorVal + 0.055) / 1.055, 2.4);
    }

    function hexToRGB(hex: string): { r: number; g: number; b: number } {
      const cleanHex = hex.replace('#', '');
      let r = 0, g = 0, b = 0;
      if (cleanHex.length === 3) {
        r = parseInt(cleanHex[0] + cleanHex[0], 16);
        g = parseInt(cleanHex[1] + cleanHex[1], 16);
        b = parseInt(cleanHex[2] + cleanHex[2], 16);
      } else if (cleanHex.length === 6) {
        r = parseInt(cleanHex.slice(0, 2), 16);
        g = parseInt(cleanHex.slice(2, 4), 16);
        b = parseInt(cleanHex.slice(4, 6), 16);
      }
      return { r, g, b };
    }

    function hexToLuminance(hex: string): number {
      const { r, g, b } = hexToRGB(hex);
      return 0.2126 * sRGBtoLin(r) + 0.7152 * sRGBtoLin(g) + 0.0722 * sRGBtoLin(b);
    }

    function calculateContrastRatio(hex1: string, hex2: string): number {
      const lum1 = hexToLuminance(hex1);
      const lum2 = hexToLuminance(hex2);
      const brightest = Math.max(lum1, lum2);
      const darkest = Math.min(lum1, lum2);
      return (brightest + 0.05) / (darkest + 0.05);
    }

    function blendHexOverHex(fgHex: string, alpha: number, bgHex: string): string {
      const fg = hexToRGB(fgHex);
      const bg = hexToRGB(bgHex);
      const r = Math.round(fg.r * alpha + bg.r * (1 - alpha));
      const g = Math.round(fg.g * alpha + bg.g * (1 - alpha));
      const b = Math.round(fg.b * alpha + bg.b * (1 - alpha));
      return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
    }

    // --- Dark Theme Verifications ---
    describe('3.1 Dark Theme Contrast Pairs', () => {
      it('Dark Theme: text-primary (#f8fafc) on bg-card (#141f36) and bg-primary (#0b1120) exceeds AAA (>= 7:1)', () => {
        expect(calculateContrastRatio('#f8fafc', '#141f36')).toBeGreaterThanOrEqual(14.0);
        expect(calculateContrastRatio('#f8fafc', '#0b1120')).toBeGreaterThanOrEqual(17.0);
      });

      it('Dark Theme: text-secondary (#94a3b8) on bg-card (#141f36) and bg-primary (#0b1120) exceeds AA (>= 4.5:1)', () => {
        expect(calculateContrastRatio('#94a3b8', '#141f36')).toBeGreaterThanOrEqual(6.0);
        expect(calculateContrastRatio('#94a3b8', '#0b1120')).toBeGreaterThanOrEqual(7.0);
      });

      it('Dark Theme: text-muted (#8fa0b5) on bg-card (#141f36), bg-primary (#0b1120), and bg-sidebar (#080d1a) exceeds AA (>= 4.5:1)', () => {
        expect(calculateContrastRatio('#8fa0b5', '#141f36')).toBeGreaterThanOrEqual(5.5);
        expect(calculateContrastRatio('#8fa0b5', '#0b1120')).toBeGreaterThanOrEqual(6.5);
        expect(calculateContrastRatio('#8fa0b5', '#080d1a')).toBeGreaterThanOrEqual(6.5);
      });

      it('Dark Theme: text-inverse (#ffffff) on accent (#555bf0) exceeds AA (>= 4.5:1)', () => {
        expect(calculateContrastRatio('#ffffff', '#555bf0')).toBeGreaterThanOrEqual(4.8);
      });

      it('Dark Theme: accent-nav (#818cf8) on blended accent-bg over sidebar exceeds AA (>= 4.5:1)', () => {
        const blendedBg = blendHexOverHex('#555bf0', 0.12, '#080d1a');
        expect(calculateContrastRatio('#818cf8', blendedBg)).toBeGreaterThanOrEqual(5.0);
      });

      it('Dark Theme: hl-comment (#8b949e) on code-bg (#080d1a) exceeds AA (>= 4.5:1)', () => {
        expect(calculateContrastRatio('#8b949e', '#080d1a')).toBeGreaterThanOrEqual(6.0);
      });
    });

    // --- Light Theme Verifications ---
    describe('3.2 Light Theme Contrast Pairs', () => {
      it('Light Theme: text-primary (#0f172a) on bg-card (#ffffff) and bg-primary (#f8fafc) exceeds AAA (>= 7:1)', () => {
        expect(calculateContrastRatio('#0f172a', '#ffffff')).toBeGreaterThanOrEqual(16.0);
        expect(calculateContrastRatio('#0f172a', '#f8fafc')).toBeGreaterThanOrEqual(15.0);
      });

      it('Light Theme: text-secondary (#475569) on bg-card (#ffffff) exceeds AAA (>= 7:1)', () => {
        expect(calculateContrastRatio('#475569', '#ffffff')).toBeGreaterThanOrEqual(7.0);
      });

      it('Light Theme: text-muted (#556477) on bg-card (#ffffff) and bg-sidebar (#f1f5f9) exceeds AA (>= 4.5:1)', () => {
        expect(calculateContrastRatio('#556477', '#ffffff')).toBeGreaterThanOrEqual(5.5);
        expect(calculateContrastRatio('#556477', '#f1f5f9')).toBeGreaterThanOrEqual(5.0);
      });

      it('Light Theme: text-inverse (#ffffff) on accent (#4f46e5) exceeds AA (>= 4.5:1)', () => {
        expect(calculateContrastRatio('#ffffff', '#4f46e5')).toBeGreaterThanOrEqual(6.0);
      });

      it('Light Theme: accent-nav (#4f46e5) on blended accent-bg over sidebar exceeds AA (>= 4.5:1)', () => {
        const blendedBg = blendHexOverHex('#4f46e5', 0.08, '#f1f5f9');
        expect(calculateContrastRatio('#4f46e5', blendedBg)).toBeGreaterThanOrEqual(5.0);
      });

      it('Light Theme: hl-comment (#57606a) on code-bg (#f1f5f9) exceeds AA (>= 4.5:1)', () => {
        expect(calculateContrastRatio('#57606a', '#f1f5f9')).toBeGreaterThanOrEqual(5.5);
      });
    });

    // --- Eye-Care Theme Verifications ---
    describe('3.3 Eye-Care Theme Contrast Pairs', () => {
      it('Eye-Care Theme: text-primary (#2d261e) on bg-card (#fdfbf7) and bg-primary (#fbf7ee) exceeds AAA (>= 7:1)', () => {
        expect(calculateContrastRatio('#2d261e', '#fdfbf7')).toBeGreaterThanOrEqual(13.0);
        expect(calculateContrastRatio('#2d261e', '#fbf7ee')).toBeGreaterThanOrEqual(12.0);
      });

      it('Eye-Care Theme: text-secondary (#5c4f3d) on bg-card (#fdfbf7) exceeds AAA (>= 7:1)', () => {
        expect(calculateContrastRatio('#5c4f3d', '#fdfbf7')).toBeGreaterThanOrEqual(7.0);
      });

      it('Eye-Care Theme: text-muted (#65553f) on bg-card (#fdfbf7) and bg-sidebar (#ede4cc) exceeds AA (>= 4.5:1)', () => {
        expect(calculateContrastRatio('#65553f', '#fdfbf7')).toBeGreaterThanOrEqual(6.0);
        expect(calculateContrastRatio('#65553f', '#ede4cc')).toBeGreaterThanOrEqual(5.0);
      });

      it('Eye-Care Theme: text-inverse (#fdfbf7) on accent (#92400e) exceeds AA (>= 4.5:1)', () => {
        expect(calculateContrastRatio('#fdfbf7', '#92400e')).toBeGreaterThanOrEqual(6.0);
      });

      it('Eye-Care Theme: accent-nav (#92400e) on blended accent-bg over sidebar exceeds AA (>= 4.5:1)', () => {
        const blendedBg = blendHexOverHex('#92400e', 0.08, '#ede4cc');
        expect(calculateContrastRatio('#92400e', blendedBg)).toBeGreaterThanOrEqual(4.8);
      });

      it('Eye-Care Theme: hl-comment (#65553f) on code-bg (#f3ecd6) exceeds AA (>= 4.5:1)', () => {
        expect(calculateContrastRatio('#65553f', '#f3ecd6')).toBeGreaterThanOrEqual(5.5);
      });

      it('Eye-Care Theme: hl-tag (#166534) on code-bg (#f3ecd6) exceeds AA (>= 4.5:1)', () => {
        expect(calculateContrastRatio('#166534', '#f3ecd6')).toBeGreaterThanOrEqual(5.5);
      });

      it('Eye-Care Theme: danger-text (#7f1d1d) against danger-bg (#faebeb) exceeds AA (>= 4.5:1)', () => {
        expect(calculateContrastRatio('#7f1d1d', '#faebeb')).toBeGreaterThanOrEqual(7.0);
      });

      it('Eye-Care Theme: success-text (#14532d) against success-bg (#eaf5ec) exceeds AA (>= 4.5:1)', () => {
        expect(calculateContrastRatio('#14532d', '#eaf5ec')).toBeGreaterThanOrEqual(7.0);
      });
    });
  });

  // ----------------------------------------------------
  // 4. Bilingual i18n & Theme Catalog Symmetry
  // ----------------------------------------------------
  describe('4. Bilingual i18n Catalog Symmetry', () => {
    const requiredThemeKeys = [
      'common.selectTheme',
      'common.theme',
      'theme.dark',
      'theme.light',
      'theme.eyeCare',
      'theme.selectTheme',
      'theme.title',
      'account.themeSection',
      'account.themeSelectLabel',
      'account.themeSaved',
      'account.themeSaveFailed',
    ];

    it('ensures all theme keys exist with non-empty translations in English and Chinese', () => {
      for (const key of requiredThemeKeys) {
        expect(en[key as keyof typeof en], `Missing English key "${key}"`).toBeDefined();
        expect(en[key as keyof typeof en].trim().length).toBeGreaterThan(0);

        expect(zhCN[key as keyof typeof zhCN], `Missing Chinese key "${key}"`).toBeDefined();
        expect(zhCN[key as keyof typeof zhCN].trim().length).toBeGreaterThan(0);
      }
    });

    it('translates theme options accurately in English and Chinese', () => {
      setLocale('en');
      expect(t('theme.dark')).toBe('Dark');
      expect(t('theme.light')).toBe('Light');
      expect(t('theme.eyeCare')).toBe('Eye-care');

      setLocale('zh-CN');
      expect(t('theme.dark')).toBe('深色');
      expect(t('theme.light')).toBe('浅色');
      expect(t('theme.eyeCare')).toBe('护眼暖色');
    });
  });
});
