/**
 * Comprehensive Unit Tests for Controlled Directory Mounts Web UI Subsystem
 *
 * Requirements:
 * 1. Admin active Space header & management details button opens Controlled Mounts modal.
 * 2. Canonical API contract:
 *    - GET /api/admin/spaces/:spaceId/mounts -> data.mounts (PublicSpaceMount[])
 *    - POST /api/admin/spaces/:spaceId/mounts -> exact body { name, sourcePath, mode } (all 3 required, mode explicit)
 *    - DELETE /api/admin/spaces/:spaceId/mounts/:mountId -> 200 OK
 * 3. Mounts list renders name, sourcePath, RO/RW badge, and createdAt.
 * 4. sourcePath is selectable plain text, NEVER rendered as an <a> URL and NEVER saved to localStorage.
 * 5. Add form provides slug (name), path (sourcePath), mode (explicit default UI 'ro', body 'mode').
 * 6. Warning notice for real host path, Docker runtime container restart, and next-turn effect.
 * 7. Delete button requires confirmation with next-turn warning.
 * 8. Non-admin users have zero mount management buttons and handle 403 responses safely.
 * 9. Archived spaces disable adding mounts and show archived notice.
 * 10. Strict negative invariants: No path picker, no auto scan, no mountPoint, no hostPath, no old API.
 * 11. Symmetrical i18n translations (en & zh-CN) and safe DOM rendering (zero innerHTML).
 */

import { describe, it, expect } from 'vitest';
import { getWebUiIndexHtml, getWebUiAsset } from '../src/index.js';
import { en, zhCN, t } from '../src/static/i18n.js';

describe('Controlled Directory Mounts Web UI Subsystem', () => {
  const html = getWebUiIndexHtml();
  const jsAsset = getWebUiAsset('app.js');
  const cssAsset = getWebUiAsset('style.css');
  const jsCode = jsAsset.content.toString('utf-8');
  const cssContent = cssAsset.content.toString('utf-8');

  describe('1. Static DOM Structure & Negative Invariants', () => {
    it('contains Manage Mounts button in Space header actions row', () => {
      expect(html).toContain('id="btn-manage-mounts"');
      expect(html).toContain('data-i18n="chat.mounts"');
      expect(html).toContain('data-i18n-title="chat.mountsTitle"');
    });

    it('contains Controlled Mounts modal with dialog role, title, and warning notice', () => {
      expect(html).toContain('id="modal-space-mounts"');
      expect(html).toContain('role="dialog"');
      expect(html).toContain('aria-modal="true"');
      expect(html).toContain('aria-labelledby="modal-space-mounts-title"');
      expect(html).toContain('id="modal-space-mounts-title"');
      expect(html).toContain('data-i18n="modal.spaceMountsTitle"');
      expect(html).toContain('id="space-mounts-warning"');
      expect(html).toContain('data-i18n="modal.mountHostWarning"');
      expect(html).toContain('id="space-mounts-list-container"');
    });

    it('contains Add Mount form with slug (name), mode (ro/rw), and sourcePath inputs', () => {
      expect(html).toContain('id="add-controlled-mount-form"');
      expect(html).toContain('id="mount-name-input"');
      expect(html).toContain('data-i18n="modal.mountNameLabel"');
      expect(html).toContain('data-i18n-placeholder="modal.mountNamePlaceholder"');
      expect(html).toContain('id="mount-mode-select"');
      expect(html).toContain('data-i18n="modal.mountModeLabel"');
      expect(html).toContain('data-i18n="modal.mountModeRo"');
      expect(html).toContain('data-i18n="modal.mountModeRw"');
      expect(html).toContain('id="mount-source-path-input"');
      expect(html).toContain('data-i18n="modal.mountSourcePathLabel"');
      expect(html).toContain('data-i18n-placeholder="modal.mountSourcePathPlaceholder"');
      expect(html).toContain('id="btn-submit-add-mount"');
      expect(html).toContain('data-i18n="modal.btnAddMount"');
      expect(html).toContain('id="mounts-archived-notice"');
      expect(html).toContain('data-i18n="modal.mountsArchivedNotice"');
    });

    it('CONFIRMS ABSENCE: zero mountPoint, hostPath, path picker, or arbitrary mount inputs in DOM', () => {
      expect(html).not.toContain('id="mount-point-input"');
      expect(html).not.toContain('id="mount-host-path-input"');
      expect(html).not.toContain('id="mount-path-input"');
      expect(html).not.toContain('id="space-mounts-input"');
      expect(html).not.toContain('data-i18n="spaces.mountPath"');
      expect(html).not.toContain('data-i18n="modal.mountPath"');
      expect(html).not.toContain('data-i18n="modal.mountPointLabel"');
      expect(html).not.toContain('data-i18n="modal.mountHostPathLabel"');
      expect(html).not.toContain('data-path-picker');
      expect(html).not.toContain('data-auto-scan');
    });
  });

  describe('2. Canonical API Endpoints & Request Body Construction', () => {
    it('fetches mounts from GET /api/admin/spaces/:spaceId/mounts and parses data.mounts collection', () => {
      const fnStart = jsCode.indexOf('async function loadSpaceMounts');
      const fnEnd = jsCode.indexOf('function openSpaceMountsModal');
      expect(fnStart).toBeGreaterThan(-1);
      expect(fnEnd).toBeGreaterThan(fnStart);
      const fnBody = jsCode.slice(fnStart, fnEnd);

      expect(fnBody).toContain('/api/admin/spaces/${encodeURIComponent(spaceId)}/mounts');
      expect(fnBody).toContain('res.data.mounts');
    });

    it('creates mount via POST /api/admin/spaces/:spaceId/mounts with exact body { name, sourcePath, mode }', () => {
      const fnStart = jsCode.indexOf('async function handleAddControlledMount');
      const fnEnd = jsCode.indexOf('async function handleDeleteControlledMount');
      expect(fnStart).toBeGreaterThan(-1);
      expect(fnEnd).toBeGreaterThan(fnStart);
      const fnBody = jsCode.slice(fnStart, fnEnd);

      expect(fnBody).toContain('/api/admin/spaces/${encodeURIComponent(spaceId)}/mounts');
      expect(fnBody).toContain('body: { name, sourcePath, mode }');
      expect(fnBody).toContain('method: "POST"');
      expect(fnBody).toContain('nameInput');
      expect(fnBody).toContain('sourcePathInput');
      expect(fnBody).toContain('modeSelect');
      expect(fnBody).not.toContain('mountPoint');
      expect(fnBody).not.toContain('hostPath');
    });

    it('deletes mount via DELETE /api/admin/spaces/:spaceId/mounts/:mountId with path mountId', () => {
      const fnStart = jsCode.indexOf('async function handleDeleteControlledMount');
      const fnEnd = jsCode.indexOf('function openCreateSpaceModal');
      expect(fnStart).toBeGreaterThan(-1);
      expect(fnEnd).toBeGreaterThan(fnStart);
      const fnBody = jsCode.slice(fnStart, fnEnd);

      expect(fnBody).toContain('/api/admin/spaces/${encodeURIComponent(spaceId)}/mounts/${encodeURIComponent(mountId)}');
      expect(fnBody).toContain('method: "DELETE"');
      expect(fnBody).toContain('showConfirmation');
    });

    it('CONFIRMS ABSENCE: old /api/spaces/:spaceId/mounts route is completely absent from entire application logic', () => {
      expect(jsCode).not.toContain("`/api/spaces/${encodeURIComponent(spaceId)}/mounts`");
      expect(jsCode).not.toContain("`/api/spaces/${spaceId}/mounts`");
      expect(jsCode).not.toContain("`/api/spaces/${encodeURIComponent(state.currentSpaceId)}/mounts`");
      expect(jsCode).not.toContain("`/api/spaces/${state.currentSpaceId}/mounts`");
    });
  });

  describe('3. Role Visibility & Lifecycle Access Control', () => {
    it('enforces Admin-only visibility for Mounts button in active Space header', () => {
      const fnStart = jsCode.indexOf('function updateSpaceLifecycleControls');
      const fnEnd = jsCode.indexOf('async function handleRestoreSpace');
      expect(fnStart).toBeGreaterThan(-1);
      expect(fnEnd).toBeGreaterThan(fnStart);
      const fnBody = jsCode.slice(fnStart, fnEnd);

      expect(fnBody).toContain("const isAdmin = Boolean(state.currentUser && state.currentUser.role === 'admin')");
      expect(fnBody).toContain('if (isAdmin && hasSpace && !isArchived)');
      expect(fnBody).toContain('mountsBtn.classList.remove("hidden")');
      expect(fnBody).toContain('mountsBtn.disabled = false');
      expect(fnBody).toContain('mountsBtn.classList.add("hidden")');
      expect(fnBody).toContain('mountsBtn.disabled = true');
    });

    it('provides Mounts details button in Admin Spaces management table rows', () => {
      const fnStart = jsCode.indexOf('async function renderAdminSpacesView');
      const fnEnd = jsCode.indexOf('async function renderAdminRuntimeView');
      expect(fnStart).toBeGreaterThan(-1);
      expect(fnEnd).toBeGreaterThan(fnStart);
      const fnBody = jsCode.slice(fnStart, fnEnd);

      expect(fnBody).toContain('btnMounts.textContent = t(\'chat.mounts\', null, \'Mounts\')');
      expect(fnBody).toContain('openSpaceMountsModal(sp.id, sp.name)');
    });

    it('disables mount creation and displays warning notice when target space is archived', () => {
      const fnStart = jsCode.indexOf('function openSpaceMountsModal');
      const fnEnd = jsCode.indexOf('async function handleAddControlledMount');
      expect(fnStart).toBeGreaterThan(-1);
      expect(fnEnd).toBeGreaterThan(fnStart);
      const fnBody = jsCode.slice(fnStart, fnEnd);

      expect(fnBody).toContain('const isArchived = currentSpace && currentSpace.status === "archived"');
      expect(fnBody).toContain('archivedNotice.classList.remove("hidden")');
      expect(fnBody).toContain('nameInput.disabled = Boolean(isArchived)');
      expect(fnBody).toContain('sourcePathInput.disabled = Boolean(isArchived)');
      expect(fnBody).toContain('modeSelect.disabled = Boolean(isArchived)');
      expect(fnBody).toContain('submitBtn.disabled = Boolean(isArchived)');
    });
  });

  describe('4. sourcePath Rendering, Selectable Plain Text & Storage Isolation', () => {
    it('renders sourcePath as selectable plain text without creating <a> link/URL', () => {
      const fnStart = jsCode.indexOf('async function loadSpaceMounts');
      const fnEnd = jsCode.indexOf('function openSpaceMountsModal');
      const fnBody = jsCode.slice(fnStart, fnEnd);

      expect(fnBody).toContain('sourceSpan.className = "user-select-all selectable-path"');
      expect(fnBody).toContain('sourceSpan.textContent = m.sourcePath');
      expect(fnBody).not.toMatch(/document\.createElement\(['"]a['"]\)/);
      expect(fnBody).not.toContain('href');
    });

    it('CONFIRMS ABSENCE: sourcePath is never saved to localStorage or sessionStorage', () => {
      const fnStart = jsCode.indexOf('async function loadSpaceMounts');
      const fnEnd = jsCode.indexOf('function openCreateSpaceModal');
      const fnBody = jsCode.slice(fnStart, fnEnd);

      expect(fnBody).not.toContain('localStorage.setItem');
      expect(fnBody).not.toContain('sessionStorage.setItem');
    });
  });

  describe('5. Error Handling, 403 Safety & Generic Toasts', () => {
    it('handles mount loading errors safely using getSafeErrorMessage', () => {
      const fnStart = jsCode.indexOf('async function loadSpaceMounts');
      const fnEnd = jsCode.indexOf('function openSpaceMountsModal');
      const fnBody = jsCode.slice(fnStart, fnEnd);

      expect(fnBody).toContain('catch (err)');
      expect(fnBody).toContain('getSafeErrorMessage(err');
      expect(fnBody).toContain('toast.failedLoadMounts');
    });

    it('handles mount creation and deletion errors safely using getSafeErrorMessage', () => {
      const fnStart = jsCode.indexOf('async function handleAddControlledMount');
      const fnEnd = jsCode.indexOf('function openCreateSpaceModal');
      const fnBody = jsCode.slice(fnStart, fnEnd);

      expect(fnBody).toContain('getSafeErrorMessage(err');
      expect(fnBody).toContain('toast.failedAddMount');
      expect(fnBody).toContain('toast.failedDeleteMount');
    });
  });

  describe('6. Bilingual Localization & Dictionary Symmetrical Completeness', () => {
    const requiredMountKeys = [
      'chat.mounts',
      'chat.mountsTitle',
      'modal.spaceMountsTitle',
      'modal.spaceMountsSubtitle',
      'modal.mountHostWarning',
      'modal.mountsArchivedNotice',
      'modal.addMountTitle',
      'modal.mountNameLabel',
      'modal.mountNamePlaceholder',
      'modal.mountModeLabel',
      'modal.mountModeRo',
      'modal.mountModeRw',
      'modal.mountSourcePathLabel',
      'modal.mountSourcePathPlaceholder',
      'modal.mountSourcePath',
      'modal.mountCreatedAt',
      'modal.btnAddMount',
      'modal.noMountsFound',
      'modal.deleteMountConfirmTitle',
      'modal.deleteMountConfirmMessage',
      'toast.mountAdded',
      'toast.mountDeleted',
      'toast.failedAddMount',
      'toast.failedDeleteMount',
      'toast.failedLoadMounts',
    ];

    it('contains all required controlled mount keys in English catalog with accurate copy', () => {
      requiredMountKeys.forEach((key) => {
        expect(en[key], `Missing English translation for ${key}`).toBeDefined();
        expect(en[key].length).toBeGreaterThan(0);
      });

      expect(en['chat.mounts']).toBe('Mounts');
      expect(en['modal.mountHostWarning']).toContain('Warning: Mounts use real host filesystem paths');
      expect(en['modal.mountHostWarning']).toContain('Docker runtime');
      expect(en['modal.mountHostWarning']).toContain('next turn');
      expect(en['modal.mountModeRo']).toBe('Read-Only (RO)');
      expect(en['modal.mountModeRw']).toBe('Read-Write (RW)');
    });

    it('contains all required controlled mount keys in Chinese catalog with accurate copy', () => {
      requiredMountKeys.forEach((key) => {
        expect(zhCN[key], `Missing Chinese translation for ${key}`).toBeDefined();
        expect(zhCN[key].length).toBeGreaterThan(0);
      });

      expect(zhCN['chat.mounts']).toBe('挂载');
      expect(zhCN['modal.mountHostWarning']).toContain('警告：受控挂载使用宿主机真实路径');
      expect(zhCN['modal.mountHostWarning']).toContain('Docker 运行时');
      expect(zhCN['modal.mountHostWarning']).toContain('下一轮对话生效');
      expect(zhCN['modal.mountModeRo']).toBe('只读 (Read-Only)');
      expect(zhCN['modal.mountModeRw']).toBe('读写 (Read-Write)');
    });
  });

  describe('7. CSS Themes & Zero Hardcoded Colors Invariants', () => {
    it('defines .mount-item-card, .selectable-path, and .space-row-mounts-btn with design tokens', () => {
      expect(cssContent).toContain('.mount-item-card');
      expect(cssContent).toContain('.selectable-path');
      expect(cssContent).toContain('.space-row-mounts-btn');
      expect(cssContent).toContain('user-select: all');
    });

    it('enforces zero unsafe innerHTML in mounts implementation', () => {
      expect(jsCode).not.toContain('.innerHTML');
      expect(jsCode).not.toContain('insertAdjacentHTML');
    });
  });
});
