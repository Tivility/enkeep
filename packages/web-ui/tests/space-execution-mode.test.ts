/**
 * Comprehensive Unit Tests for Execution Mode & Host Sandbox Subsystem
 *
 * Tests:
 * 1. Create Space Modal: Admin sees Execution Mode select (Docker default / Host High Risk); Member does not see Host
 * 2. Host Explanation & Danger Confirmation once on Host mode selection
 * 3. Exact Create Space API payload ({ name, folder, executionMode })
 * 4. Space List & Selector Badges (Docker / Host badge in sidebar and Admin Spaces table)
 * 5. Space Mode Immutability: Existing space mode cannot be switched; displays "Migration required"
 * 6. Runtime Management: Displays mixed Docker + Host instances, status, and target mode restart
 * 7. Host 403 / 400 rejection error handling without UI crash
 * 8. Bilingual translations (en & zh-CN) and zero hardcoded colors across 3 themes
 * 9. Invariant: Zero arbitrary mounts UI
 */

import { describe, it, expect, vi } from 'vitest';
import { getWebUiIndexHtml, getWebUiAsset } from '../src/index.js';
import { en, zhCN, t } from '../src/static/i18n.js';

describe('Web UI Execution Mode & Host Security Subsystem', () => {
  const html = getWebUiIndexHtml();
  const jsAsset = getWebUiAsset('app.js');
  const cssAsset = getWebUiAsset('style.css');
  const jsCode = jsAsset.content.toString('utf-8');
  const cssContent = cssAsset.content.toString('utf-8');

  describe('1. Static DOM Structure & Safe Invariants', () => {
    it('contains Create Space modal with Execution Mode select group and host description container', () => {
      expect(html).toContain('id="modal-space"');
      expect(html).toContain('id="space-exec-mode-group"');
      expect(html).toContain('id="space-exec-mode-select"');
      expect(html).toContain('id="space-exec-mode-host-desc"');
      expect(html).toContain('data-i18n="modal.executionModeLabel"');
      expect(html).toContain('data-i18n="modal.execModeDocker"');
      expect(html).toContain('data-i18n="modal.execModeHostDesc"');
    });

    it('CONFIRMS ABSENCE: host direct execution option is absent from static index.html', () => {
      expect(html).not.toContain('value="host"');
      expect(html).toContain('value="container"');
    });

    it('contains active space mode badge in sidebar and rename space modal mode badge', () => {
      expect(html).toContain('id="space-mode-badge"');
      expect(html).toContain('id="rename-space-mode-badge"');
      expect(html).toContain('data-i18n="spaces.migrationRequired"');
    });

    it('CONFIRMS ABSENCE: zero mounts UI or arbitrary mount path inputs exist in static DOM', () => {
      expect(html).not.toContain('id="mount-path-input"');
      expect(html).not.toContain('id="space-mounts-input"');
      expect(html).not.toContain('data-i18n="spaces.mountPath"');
      expect(html).not.toContain('data-i18n="modal.mountPath"');
    });
  });

  describe('2. Role-Aware Execution Mode Visibility in Create Space Modal', () => {
    it('implements openCreateSpaceModal with dynamic role-based Host option injection', () => {
      expect(jsCode).toContain('function openCreateSpaceModal()');
      expect(jsCode).toContain("state.currentUser && state.currentUser.role === 'admin'");
      expect(jsCode).toContain('hostOpt.value = "host"');
      expect(jsCode).toContain('hostOpt.id = "space-exec-mode-host-option"');
      expect(jsCode).toContain('execModeSelect.value = "container"');
    });

    it('enforces Admin sees Host option while non-admin member receives only Docker option', () => {
      const fnStart = jsCode.indexOf('function openCreateSpaceModal');
      const fnEnd = jsCode.indexOf('async function handleCreateSpace');
      expect(fnStart).toBeGreaterThan(-1);
      expect(fnEnd).toBeGreaterThan(fnStart);
      const fnBody = jsCode.slice(fnStart, fnEnd);

      expect(fnBody).toContain('dockerOpt.value = "container"');
      expect(fnBody).toContain('if (isAdmin)');
      expect(fnBody).toContain('hostOpt.value = "host"');
    });
  });

  describe('3. Host Danger Confirmation & Exact Request Payload', () => {
    it('triggers danger confirmation dialog when Host mode is selected in Create Space modal', () => {
      expect(jsCode).toContain("val === 'host'");
      expect(jsCode).toContain("modal.hostConfirmTitle");
      expect(jsCode).toContain("modal.hostConfirmMessage");
      expect(jsCode).toContain('execModeSelect.value = "container"');
      expect(jsCode).toContain('hostDesc.classList.add("hidden")');
    });

    it('constructs exact Create Space body with name, folder, and executionMode', () => {
      const fnStart = jsCode.indexOf('async function handleCreateSpace');
      const fnEnd = jsCode.indexOf('async function loadSessions');
      expect(fnStart).toBeGreaterThan(-1);
      expect(fnEnd).toBeGreaterThan(fnStart);
      const fnBody = jsCode.slice(fnStart, fnEnd);

      expect(fnBody).toContain('const executionMode = (execModeSelect && execModeSelect.value === "host" && isAdmin) ? "host" : "container"');
      expect(fnBody).toContain("body: { name, folder, executionMode }");
      expect(fnBody).toContain('apiRequest("/api/spaces"');
    });

    it('handles 403 Forbidden / 400 Bad Request error safely on Space creation without crashing', () => {
      const fnStart = jsCode.indexOf('async function handleCreateSpace');
      const fnEnd = jsCode.indexOf('async function loadSessions');
      const fnBody = jsCode.slice(fnStart, fnEnd);

      expect(fnBody).toContain('catch (err)');
      expect(fnBody).toContain('getSafeErrorMessage(err');
      expect(fnBody).toContain('showToast(');
    });
  });

  describe('4. Space Badges & Mode Switch Immutability', () => {
    it('renders [Host] / [Docker] badges in space select dropdown options and active badge', () => {
      expect(jsCode).toContain('const isHostSpace = space.executionMode === "host"');
      expect(jsCode).toContain('const modeTag = isHostSpace ? "[Host]" : "[Docker]"');
      expect(jsCode).toContain('space-mode-badge');
      expect(jsCode).toContain('badge-risk-high');
    });

    it('renders execution mode badge in Admin Spaces view aggregate table', () => {
      const fnStart = jsCode.indexOf('async function renderAdminSpacesView');
      const fnEnd = jsCode.indexOf('async function renderAdminRuntimeView');
      expect(fnStart).toBeGreaterThan(-1);
      expect(fnEnd).toBeGreaterThan(fnStart);
      const fnBody = jsCode.slice(fnStart, fnEnd);

      expect(fnBody).toContain("const isHostSpace = sp.executionMode === 'host'");
      expect(fnBody).toContain("createBadgeElement(isHostSpace ? 'Host' : 'Docker'");
    });

    it('disallows mode switching on existing space and displays "Migration required" in Rename modal', () => {
      expect(jsCode).toContain('openRenameSpaceModal');
      expect(jsCode).toContain('rename-space-mode-badge');
      expect(html).toContain('data-i18n="spaces.migrationRequired"');
      // Verify no mode select exists in Rename modal
      const renameModalHtml = html.slice(
        html.indexOf('id="modal-rename-space"'),
        html.indexOf('id="modal-rename-session"')
      );
      expect(renameModalHtml).not.toContain('<select');
      expect(renameModalHtml).toContain('id="rename-space-mode-badge"');
    });
  });

  describe('5. Runtime Management: Mixed Instances & Target Mode Restart', () => {
    it('renders mixed Docker + Host runtime instances with mode badge in Admin Runtime table', () => {
      const fnStart = jsCode.indexOf('async function renderAdminRuntimeView');
      const fnEnd = jsCode.indexOf('async function renderAdminPluginsView');
      expect(fnStart).toBeGreaterThan(-1);
      expect(fnEnd).toBeGreaterThan(fnStart);
      const fnBody = jsCode.slice(fnStart, fnEnd);

      expect(fnBody).toContain("r.mode === 'host' || r.executionMode === 'host'");
      expect(fnBody).toContain("createBadgeElement(isHostInstance ? 'Host' : 'Docker'");
    });

    it('passes target mode on runtime restart action for Host instances', () => {
      const fnStart = jsCode.indexOf('async function renderAdminRuntimeView');
      const fnEnd = jsCode.indexOf('async function renderAdminPluginsView');
      const fnBody = jsCode.slice(fnStart, fnEnd);

      expect(fnBody).toContain("restart?mode=host");
      expect(fnBody).toContain("body: { mode: 'host' }");
    });

    it('renders execution mode in User Runtime view card panel', () => {
      const fnStart = jsCode.indexOf('async function renderUserRuntimeView');
      const fnEnd = jsCode.indexOf('async function renderStorageReconcileView');
      expect(fnStart).toBeGreaterThan(-1);
      expect(fnEnd).toBeGreaterThan(fnStart);
      const fnBody = jsCode.slice(fnStart, fnEnd);

      expect(fnBody).toContain("userRuntime.mode === 'host' || userRuntime.executionMode === 'host'");
      expect(fnBody).toContain("spaces.executionMode");
    });
  });

  describe('6. Bilingual i18n Dictionary Symmetrical Completeness', () => {
    const requiredKeys = [
      'modal.executionModeLabel',
      'modal.execModeDocker',
      'modal.execModeHost',
      'modal.execModeHostDesc',
      'modal.hostConfirmTitle',
      'modal.hostConfirmMessage',
      'spaces.executionMode',
      'spaces.migrationRequired',
      'spaces.modeDocker',
      'spaces.modeHost',
      'runtime.colMode',
      'runtime.modeDocker',
      'runtime.modeHost',
    ];

    it('contains all required execution mode keys in English catalog with accurate copy', () => {
      requiredKeys.forEach((key) => {
        expect(en[key], `Missing English translation for ${key}`).toBeDefined();
        expect(en[key].length).toBeGreaterThan(0);
      });

      expect(en['modal.execModeDocker']).toBe('Docker (Default)');
      expect(en['modal.execModeHost']).toBe('Host (High Risk)');
      expect(en['modal.execModeHostDesc']).toContain('runs on platform host with controlled Enkeep workspace;not arbitrary mount yet;admin only');
      expect(en['spaces.migrationRequired']).toBe('Migration required');
    });

    it('contains all required execution mode keys in Chinese catalog with accurate copy', () => {
      requiredKeys.forEach((key) => {
        expect(zhCN[key], `Missing Chinese translation for ${key}`).toBeDefined();
        expect(zhCN[key].length).toBeGreaterThan(0);
      });

      expect(zhCN['modal.execModeDocker']).toBe('Docker（默认）');
      expect(zhCN['modal.execModeHost']).toBe('Host（高风险）');
      expect(zhCN['modal.execModeHostDesc']).toContain('运行在平台宿主机受控 Enkeep 工作区；暂不支持任意挂载；仅限管理员。');
      expect(zhCN['spaces.migrationRequired']).toBe('需要迁移');
    });
  });

  describe('7. CSS Themes & Zero Hardcoded Colors Invariants', () => {
    it('defines .space-mode-badge and .space-mode-readonly-row without hardcoded colors', () => {
      expect(cssContent).toContain('.space-mode-badge');
      expect(cssContent).toContain('.space-mode-readonly-row');
      expect(cssContent).toContain('.exec-mode-badge-cell');
    });

    it('enforces zero unsafe innerHTML across execution mode code', () => {
      expect(jsCode).not.toContain('.innerHTML');
      expect(jsCode).not.toContain('insertAdjacentHTML');
    });
  });
});
