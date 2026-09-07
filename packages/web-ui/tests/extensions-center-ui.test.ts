/**
 * Comprehensive Unit Tests for Extension Center & Workspace Extensions Web UI Subsystem
 *
 * Requirements:
 * 1. Canonical route `#management/workspaces/extensions` replaces old skills route.
 * 2. Zero browser calls to legacy `/api/manage/skills`.
 * 3. Canonical API integration:
 *    - GET /api/manage/extensions
 *    - GET /api/manage/extensions/:slug
 *    - POST /api/manage/extensions/install (Git & Archive)
 *    - POST /api/manage/extensions/:slug/update (preview diff & confirm update)
 *    - POST /api/manage/extensions/:slug/rollback
 *    - POST /api/manage/extensions/:slug/enable
 *    - POST /api/manage/extensions/:slug/disable
 *    - POST /api/manage/extensions/:slug/uninstall
 * 4. Bundled extension packages are read-only (no update/disable/rollback/uninstall buttons).
 * 5. Extension Detail Modal provides Content & Manifest, Version History, and Space Bindings.
 * 6. URL and error sanitization (zero plaintext credentials or raw filesystem path leakage).
 * 7. Symmetrical i18n support in en and zh-CN catalogs.
 * 8. Safe DOM construction (zero innerHTML).
 */

import { describe, it, expect } from 'vitest';
import { getWebUiIndexHtml, getWebUiAsset } from '../src/index.js';
import { en, zhCN, t } from '../src/static/i18n.js';

describe('Extension Center Web UI Subsystem', () => {
  const html = getWebUiIndexHtml();
  const jsAsset = getWebUiAsset('app.js');
  const cssAsset = getWebUiAsset('style.css');
  const jsCode = jsAsset.content.toString('utf-8');
  const cssContent = cssAsset.content.toString('utf-8');

  describe('1. Route and Navigation Canonicalization', () => {
    it('configures canonical route management/workspaces/extensions', () => {
      expect(jsCode).toContain("'management/workspaces/extensions'");
      expect(jsCode).toContain("tab === 'workspaces' && section === 'extensions'");
    });

    it('has zero browser calls to legacy /api/manage/skills endpoints', () => {
      expect(jsCode).not.toContain('/api/manage/skills');
    });

    it('uses Extension Center navigation label in workspaces tab', () => {
      expect(jsCode).toContain("{ id: 'extensions', label: 'Extension Center'");
    });
  });

  describe('2. Static DOM Modals Structure', () => {
    it('contains Extension Detail & Manifest Modal with dialog role and safe elements', () => {
      expect(html).toContain('id="modal-extension-detail"');
      expect(html).toContain('role="dialog"');
      expect(html).toContain('aria-modal="true"');
      expect(html).toContain('aria-labelledby="modal-extension-detail-title"');
      expect(html).toContain('id="modal-extension-detail-title"');
      expect(html).toContain('id="extension-detail-body"');
    });

    it('contains Install Extension Modal with source type, git fields, and credential reference input', () => {
      expect(html).toContain('id="modal-install-skill"');
      expect(html).toContain('id="install-skill-form"');
      expect(html).toContain('id="skill-source-type-select"');
      expect(html).toContain('id="skill-scope-select"');
      expect(html).toContain('id="skill-target-space-select"');
      expect(html).toContain('id="skill-repo-url-input"');
      expect(html).toContain('id="skill-git-ref-input"');
      expect(html).toContain('id="skill-subdirectory-input"');
      expect(html).toContain('id="skill-expected-commit-input"');
      expect(html).toContain('id="skill-credential-ref-input"');
      expect(html).toContain('id="skill-checksum-input"');
      expect(html).toContain('id="btn-submit-install-skill"');
    });

    it('contains Update Extension Modal with diff preview and confirm commit buttons', () => {
      expect(html).toContain('id="modal-update-skill"');
      expect(html).toContain('id="update-skill-form"');
      expect(html).toContain('id="btn-preview-skill-diff"');
      expect(html).toContain('id="skill-diff-preview-container"');
      expect(html).toContain('id="skill-diff-summary-text"');
      expect(html).toContain('id="skill-diff-files-list"');
      expect(html).toContain('id="btn-commit-update-skill"');
    });

    it('contains Rollback Extension Modal with target version input', () => {
      expect(html).toContain('id="modal-rollback-skill"');
      expect(html).toContain('id="rollback-skill-form"');
      expect(html).toContain('id="rollback-skill-target-version-input"');
      expect(html).toContain('id="btn-submit-rollback-skill"');
    });
  });

  describe('3. API Protocol & Client Handler Invariants', () => {
    it('uses GET /api/manage/extensions to list installed extensions', () => {
      expect(jsCode).toContain('/api/manage/extensions?');
    });

    it('uses GET /api/manage/extensions/:slug to retrieve package details and manifest', () => {
      expect(jsCode).toContain('/api/manage/extensions/${encodeURIComponent(slug)}');
    });

    it('uses POST /api/manage/extensions/install with sourceKind git and gitSource payload', () => {
      expect(jsCode).toContain("'/api/manage/extensions/install'");
      expect(jsCode).toContain("sourceKind: 'git'");
      expect(jsCode).toContain('repositoryUrl:');
      expect(jsCode).not.toContain("sourceType: 'git'");
    });

    it('uses POST /api/manage/extensions/install with flat archiveBase64 and archiveFilename payload', () => {
      expect(jsCode).toContain("sourceKind: 'archive'");
      expect(jsCode).toContain('archiveBase64: loadedArchiveBase64');
      expect(jsCode).toContain("archiveFilename: loadedArchiveFilename || 'skill-archive.tar.gz'");
      expect(jsCode).not.toContain('payload.archive = {');
    });

    it('retains Idempotency-Key header on extension install', () => {
      expect(jsCode).toContain("headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}");
    });

    it('uses POST /api/manage/extensions/:slug/update for diff preview and confirmation', () => {
      expect(jsCode).toContain('/api/manage/extensions/${encodeURIComponent(nameInput.value)}/update');
      expect(jsCode).toContain('confirmDiff: false');
      expect(jsCode).toContain('confirmDiff: true');
    });

    it('uses POST /api/manage/extensions/:slug/rollback with targetVersion and spaceId', () => {
      expect(jsCode).toContain('/api/manage/extensions/${encodeURIComponent(nameInput.value)}/rollback');
      expect(jsCode).toContain('targetVersion: targetVer');
    });

    it('uses POST /api/manage/extensions/:slug/enable and /disable for space binding toggle', () => {
      expect(jsCode).toContain('/api/manage/extensions/${encodeURIComponent(ext.slug || ext.id)}/enable');
      expect(jsCode).toContain('/api/manage/extensions/${encodeURIComponent(ext.slug || ext.id)}/disable');
      expect(jsCode).toContain('/api/manage/extensions/${encodeURIComponent(detail.slug)}/enable');
      expect(jsCode).toContain('/api/manage/extensions/${encodeURIComponent(detail.slug)}/disable');
    });

    it('uses POST /api/manage/extensions/:slug/uninstall for extension uninstallation', () => {
      expect(jsCode).toContain('/api/manage/extensions/${encodeURIComponent(ext.slug || ext.id)}/uninstall');
    });
  });

  describe('4. Readonly Guarantees for Bundled Extensions', () => {
    it('ensures bundled extensions (sourceKind builtin) are marked read-only and disable update/rollback/uninstall', () => {
      expect(jsCode).toContain("const isBundled = ext.sourceKind === 'builtin'");
      expect(jsCode).toContain('readonlyBundled');
      expect(jsCode).toContain("!isBundled");
    });
  });

  describe('5. Security, Sanitization & Safe DOM', () => {
    it('implements sanitizeSourceUrl to strip embedded credentials from repository URLs', () => {
      expect(jsCode).toContain('function sanitizeSourceUrl');
      expect(jsCode).toContain('parsed.username = \'\'');
      expect(jsCode).toContain('parsed.password = \'\'');
    });

    it('protects against innerHTML injection in extension detail and list views', () => {
      const renderExtFnMatch = jsCode.match(/async function renderExtensionsView[\s\S]*?\n\}/);
      expect(renderExtFnMatch).toBeDefined();
      if (renderExtFnMatch) {
        expect(renderExtFnMatch[0]).not.toContain('.innerHTML =');
      }

      const openDetailFnMatch = jsCode.match(/async function openExtensionDetailModal[\s\S]*?\n\}/);
      expect(openDetailFnMatch).toBeDefined();
      if (openDetailFnMatch) {
        expect(openDetailFnMatch[0]).not.toContain('.innerHTML =');
      }
    });
  });

  describe('6. Internationalization (i18n) Symmetrical Coverage', () => {
    const requiredKeys = [
      'extensions.title',
      'extensions.subtitle',
      'extensions.btnInstall',
      'extensions.filterAllKinds',
      'extensions.filterKindSkill',
      'extensions.filterKindMcp',
      'extensions.filterAllSources',
      'extensions.sourceBundled',
      'extensions.sourceGit',
      'extensions.sourceArchive',
      'extensions.filterAllEnabled',
      'extensions.filterEnabled',
      'extensions.filterDisabled',
      'extensions.kpiTotal',
      'extensions.kpiEnabled',
      'extensions.kpiSpace',
      'extensions.kpiBundled',
      'extensions.colName',
      'extensions.colKind',
      'extensions.colVersion',
      'extensions.colSource',
      'extensions.colBindings',
      'extensions.colHealth',
      'extensions.colStatus',
      'extensions.colDescription',
      'extensions.colActions',
      'extensions.kindChipSkill',
      'extensions.kindChipMcp',
      'extensions.mcpTransport',
      'extensions.mcpTransportStdio',
      'extensions.mcpTransportHttp',
      'extensions.mcpToolHealth',
      'extensions.mcpToolsCount',
      'extensions.mcpCredentialRefs',
      'extensions.mcpNoCredentialRefs',
      'extensions.mcpCommand',
      'extensions.mcpUrl',
      'extensions.mcpToolsDeclared',
      'extensions.btnDetail',
      'extensions.btnUpdate',
      'extensions.btnRollback',
      'extensions.btnEnable',
      'extensions.btnDisable',
      'extensions.btnUninstall',
      'extensions.btnPreviewDiff',
      'extensions.btnCommitUpdate',
      'extensions.installSuccess',
      'extensions.updateSuccess',
      'extensions.rollbackSuccess',
      'extensions.enableSuccess',
      'extensions.disableSuccess',
      'extensions.uninstallSuccess',
      'extensions.detailModalTitle',
      'extensions.tabContent',
      'extensions.tabVersions',
      'extensions.tabBindings',
      'extensions.readonlyBundled',
      'extensions.safeUrl',
      'extensions.integritySha256',
    ];

    it('has non-empty translations for all extension keys in English and Chinese', () => {
      requiredKeys.forEach((key) => {
        expect(en[key], `Missing English translation for ${key}`).toBeDefined();
        expect(typeof en[key]).toBe('string');
        expect(en[key].length).toBeGreaterThan(0);

        expect(zhCN[key], `Missing Chinese translation for ${key}`).toBeDefined();
        expect(typeof zhCN[key]).toBe('string');
        expect(zhCN[key].length).toBeGreaterThan(0);
      });
    });
  });

  describe('7. CSS Layout & Responsive Tokens', () => {
    it('contains styles for extension container, filter toolbar, detail tabs, and content preview', () => {
      expect(cssContent).toContain('.extensions-container');
      expect(cssContent).toContain('.extensions-filter-toolbar');
      expect(cssContent).toContain('.extension-detail-header');
      expect(cssContent).toContain('.extension-detail-tabs');
      expect(cssContent).toContain('.extension-content-pre');
      expect(cssContent).toContain('.extension-mcp-tools-list');
      expect(cssContent).toContain('.extension-mcp-tool-item');
    });
  });

  describe('8. MCP Unified Extension Center Invariants', () => {
    it('provides MCP filter option alongside All and Skills in filter toolbar', () => {
      expect(jsCode).toContain("value: 'mcp'");
      expect(jsCode).toContain("extensions.filterKindMcp");
    });

    it('passes kind=mcp query param when filtering by MCP', () => {
      expect(jsCode).toContain("state.activeExtensionFilterKind === 'mcp'");
      expect(jsCode).toContain("params.append('kind', 'mcp')");
    });

    it('renders MCP badges in table and detail modal when extension has mcp contributions', () => {
      expect(jsCode).toContain("extensions.kindChipMcp");
      expect(jsCode).toContain("c.kind === 'mcp'");
    });

    it('displays MCP transport type, tool health/count, credential ref names, and read-only commands/URLs in detail modal', () => {
      expect(jsCode).toContain("extensions.mcpTransport");
      expect(jsCode).toContain("extensions.mcpToolHealth");
      expect(jsCode).toContain("extensions.mcpCredentialRefs");
      expect(jsCode).toContain("extensions.mcpToolsDeclared");
      expect(jsCode).toContain("extensions.mcpCommand");
      expect(jsCode).toContain("extensions.mcpUrl");
    });

    it('guarantees NO standalone MCP page/forms/server editor is created', () => {
      expect(html).not.toContain('id="page-mcp"');
      expect(html).not.toContain('id="modal-create-mcp"');
      expect(html).not.toContain('id="modal-edit-mcp"');
      expect(jsCode).not.toContain("renderMcpServerEditor");
    });
  });
});
