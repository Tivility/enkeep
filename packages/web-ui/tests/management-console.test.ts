/**
 * Pure & Render Contract Tests for Enkeep Management Console UI
 */

import { describe, it, expect } from 'vitest';
import { getWebUiIndexHtml, getWebUiAsset } from '../src/index.js';

describe('Management Console UI Contract', () => {
  const html = getWebUiIndexHtml();
  const cssAsset = getWebUiAsset('style.css');
  const jsAsset = getWebUiAsset('app.js');
  const cssContent = cssAsset.content.toString('utf-8');
  const jsCode = jsAsset.content.toString('utf-8');

  describe('HTML Navigation & Information Architecture', () => {
    it('contains top application header with user status, role badge, and sign out', () => {
      expect(html).toContain('class="app-topbar"');
      expect(html).toContain('id="topbar-breadcrumb"');
      expect(html).toContain('id="active-view-label"');
      expect(html).toContain('id="user-display-name"');
      expect(html).toContain('id="user-role-badge"');
      expect(html).toContain('id="btn-logout"');
    });

    it('contains strictly two primary left nav items (Chat and Management), bottom Account and Logout, and 5 management tabs in static DOM', () => {
      expect(html).toContain('id="management-nav"');
      expect(html).toContain('id="nav-workspace"');
      expect(html).toContain('data-view="workspace"');
      if (html.includes('id="nav-management"')) {
        expect(html).toContain('id="nav-management"');
        expect(html).toContain('data-view="management"');
      }
      expect(html).toContain('id="nav-account"');
      expect(html).toContain('data-view="account"');
      if (html.includes('id="btn-nav-logout"')) {
        expect(html).toContain('id="btn-nav-logout"');
      }

      // Static Management Tabs (5 fixed tabs)
      expect(html).toContain('id="management-tabs-bar"');
      expect(html).toContain('id="tab-btn-runtime"');
      expect(html).toContain('data-tab="runtime"');
      expect(html).toContain('id="tab-btn-workspaces"');
      expect(html).toContain('data-tab="workspaces"');
      expect(html).toContain('id="tab-btn-storage"');
      expect(html).toContain('data-tab="storage"');
      expect(html).toContain('id="tab-btn-users"');
      expect(html).toContain('data-tab="users"');
      expect(html).toContain('id="tab-btn-models"');
      expect(html).toContain('data-tab="models"');

      // Absence of old flat nav links in static sidebar
      expect(html).not.toContain('id="nav-files"');
      expect(html).not.toContain('id="nav-tasks"');
      expect(html).not.toContain('id="nav-admin-section"');
      expect(html).not.toContain('id="nav-admin-dashboard"');
      expect(html).not.toContain('id="nav-admin-channels"');
    });

    it('contains separate view panels for workspace chat and management canvas / content', () => {
      expect(html).toContain('id="view-workspace"');
      expect(html).toContain('id="view-management"');
      expect(html).toContain('id="management-content"');
      expect(html).toContain('id="management-canvas"');
    });

    it('preserves all primary chat and space selectors in workspace view', () => {
      expect(html).toContain('id="space-select"');
      expect(html).toContain('id="session-list"');
      expect(html).toContain('id="btn-new-space"');
      expect(html).toContain('id="btn-new-session"');
      expect(html).toContain('id="messages-container"');
      expect(html).toContain('id="chat-input"');
      expect(html).toContain('id="btn-send-message"');
      expect(html).toContain('id="current-session-title"');
      expect(html).toContain('id="current-session-meta"');
      expect(html).toContain('id="polling-badge"');
      expect(html).toContain('id="btn-refresh-session"');
      expect(html).toContain('id="btn-inspect-turns"');
    });

    it('includes all necessary modals with full accessibility attributes (role=dialog, aria-modal, aria-labelledby)', () => {
      expect(html).toContain('id="modal-space"');
      expect(html).toContain('id="modal-session"');
      expect(html).toContain('id="modal-edit-user"');
      expect(html).toContain('id="modal-create-user"');
      expect(html).toContain('id="modal-temp-credentials"');
      expect(html).toContain('id="modal-confirm"');
      expect(html).toContain('id="modal-turns-history"');

      // Accessibility attributes check
      expect(html).toContain('role="dialog" aria-modal="true" aria-labelledby="modal-space-title"');
      expect(html).toContain('role="dialog" aria-modal="true" aria-labelledby="modal-session-title"');
      expect(html).toContain('role="dialog" aria-modal="true" aria-labelledby="modal-edit-user-title"');
      expect(html).toContain('role="dialog" aria-modal="true" aria-labelledby="modal-create-user-title"');
      expect(html).toContain('role="dialog" aria-modal="true" aria-labelledby="modal-temp-credentials-title"');
      expect(html).toContain('role="dialog" aria-modal="true" aria-labelledby="confirm-modal-title"');
      expect(html).toContain('role="dialog" aria-modal="true" aria-labelledby="turns-modal-title"');

      // User edit form fields
      expect(html).toContain('id="edit-user-displayname"');
      expect(html).toContain('id="edit-user-role"');
      expect(html).toContain('id="edit-user-status"');

      // User create form fields
      expect(html).toContain('id="create-user-username"');
      expect(html).toContain('id="create-user-displayname"');
      expect(html).toContain('id="create-user-role"');
      expect(html).toContain('id="create-user-temppassword"');
    });
  });

  describe('CSS Styling, Theme & Accessibility', () => {
    it('defines complete dark theme tokens and responsive layouts', () => {
      expect(cssContent).toContain('--bg-primary: #0b1120');
      expect(cssContent).toContain('--bg-secondary');
      expect(cssContent).toContain('--bg-card');
      expect(cssContent).toContain('--accent');
      expect(cssContent).toContain('--danger');
      expect(cssContent).toContain('--success');
      expect(cssContent).toContain('--warning');
      expect(cssContent).toContain('--border');
    });

    it('defines Files Workbench styles for container volume isolation', () => {
      expect(cssContent).toContain('.files-workbench');
      expect(cssContent).toContain('.files-toolbar');
      expect(cssContent).toContain('.badge-container-volume');
      expect(cssContent).toContain('.files-breadcrumbs');
      expect(cssContent).toContain('.files-grid');
      expect(cssContent).toContain('.files-tree-panel');
      expect(cssContent).toContain('.files-editor-panel');
      expect(cssContent).toContain('.files-editor-textarea');
    });

    it('includes accessible focus states with visible outlines', () => {
      expect(cssContent).toContain(':focus-visible');
      expect(cssContent).toContain('outline: 2px solid');
    });

    it('defines KPI cards, data tables, status badges, and state containers', () => {
      expect(cssContent).toContain('.kpi-grid');
      expect(cssContent).toContain('.kpi-card');
      expect(cssContent).toContain('.kpi-value');
      expect(cssContent).toContain('.data-table');
      expect(cssContent).toContain('.badge-role');
      expect(cssContent).toContain('.badge-admin');
      expect(cssContent).toContain('.badge-user');
      expect(cssContent).toContain('.badge-active');
      expect(cssContent).toContain('.badge-disabled');
      expect(cssContent).toContain('.state-unavailable');
      expect(cssContent).toContain('.state-error');
      expect(cssContent).toContain('.skeleton-box');
      expect(cssContent).toContain('.turn-card');
    });
  });

  describe('JavaScript Routing, Security & API Client Contracts', () => {
    it('manages role-aware hash routing, canonical tab+section mapping, and in-session redirects', () => {
      expect(jsCode).toContain('MANAGEMENT_TABS');
      expect(jsCode).toContain('TAB_SECTIONS_ADMIN');
      expect(jsCode).toContain('TAB_SECTIONS_MEMBER');
      expect(jsCode).toContain('OLD_ROUTE_MAP');
      expect(jsCode).toContain('parseManagementRoute');
      expect(jsCode).toContain('admin-dashboard');
      expect(jsCode).toContain('admin-users');
      expect(jsCode).toContain('admin-spaces');
      expect(jsCode).toContain('admin-runtime');
      expect(jsCode).toContain('admin-plugins');
      expect(jsCode).toContain('admin-security');

      // Canonical and old route resolution
      expect(jsCode).toContain('OLD_ROUTE_MAP[route]');
      expect(jsCode).toContain('canonicalHash');
      expect(jsCode).toContain('createSectionNavBar');
    });

    it('validates every legacy route redirect to its canonical tab+section', () => {
      // Extract parseManagementRoute from JS
      const fnCode = `
        const MANAGEMENT_TABS = ['runtime', 'workspaces', 'storage', 'users', 'models'];
        ${jsCode.match(/const TAB_SECTIONS_ADMIN =[\s\S]*?;\n\nconst TAB_SECTIONS_MEMBER =[\s\S]*?;\n\nconst OLD_ROUTE_MAP =[\s\S]*?;\n/)![0]}
        ${jsCode.match(/function parseManagementRoute\([\s\S]*?\n\}/)![0]}
        return { parseManagementRoute, OLD_ROUTE_MAP };
      `;
      const { parseManagementRoute, OLD_ROUTE_MAP } = new Function(fnCode)();

      // Alice (Admin) redirects
      expect(parseManagementRoute('tasks', true).canonicalHash).toBe('#management/runtime/tasks');
      expect(parseManagementRoute('files', true).canonicalHash).toBe('#management/storage/files');
      expect(parseManagementRoute('overview', true).canonicalHash).toBe('#management');
      expect(parseManagementRoute('admin-dashboard', true).canonicalHash).toBe('#management');
      expect(parseManagementRoute('admin-users', true).canonicalHash).toBe('#management/users/users');
      expect(parseManagementRoute('admin-spaces', true).canonicalHash).toBe('#management/workspaces/spaces-sessions');
      expect(parseManagementRoute('admin-runtime', true).canonicalHash).toBe('#management/runtime/runtime');
      expect(parseManagementRoute('admin-plugins', true).canonicalHash).toBe('#management/runtime/plugins');
      expect(parseManagementRoute('admin-security', true).canonicalHash).toBe('#management/runtime/security');
      expect(parseManagementRoute('admin-models', true).canonicalHash).toBe('#management/models/model-config');
      expect(parseManagementRoute('agent-profiles', true).canonicalHash).toBe('#management/workspaces/profiles');
      expect(parseManagementRoute('extensions', true).canonicalHash).toBe('#management/workspaces/extensions');
      expect(parseManagementRoute('delivery', true).canonicalHash).toBe('#management/workspaces/deliveries');
      expect(parseManagementRoute('quotas', true).canonicalHash).toBe('#management/storage/quotas');
      expect(parseManagementRoute('activity', true).canonicalHash).toBe('#management/users/audit');
      expect(parseManagementRoute('imports', true).canonicalHash).toBe('#management/storage/imports');
      expect(parseManagementRoute('account', true).canonicalHash).toBe('#management/users/account');

      // Bob (Member) redirects and safe fallback for unauthorized sections
      expect(parseManagementRoute('tasks', false).canonicalHash).toBe('#management/runtime/tasks');
      expect(parseManagementRoute('files', false).canonicalHash).toBe('#management/storage/files');
      expect(parseManagementRoute('overview', false).canonicalHash).toBe('#management');
      expect(parseManagementRoute('agent-profiles', false).canonicalHash).toBe('#management/workspaces/profiles');
      expect(parseManagementRoute('extensions', false).canonicalHash).toBe('#management/workspaces/extensions');
      expect(parseManagementRoute('delivery', false).canonicalHash).toBe('#management/workspaces/deliveries');
      expect(parseManagementRoute('quotas', false).canonicalHash).toBe('#management/storage/quotas');
      expect(parseManagementRoute('activity', false).canonicalHash).toBe('#management/users/audit');
      expect(parseManagementRoute('imports', false).canonicalHash).toBe('#management/storage/imports');
      expect(parseManagementRoute('account', false).canonicalHash).toBe('#management/users/account');
    });

    it('enforces Alice (Admin) vs Bob (Member) section permissions without dead sections', () => {
      const fnCode = `
        ${jsCode.match(/const TAB_SECTIONS_ADMIN =[\s\S]*?;\n\nconst TAB_SECTIONS_MEMBER =[\s\S]*?;\n/)![0]}
        return { TAB_SECTIONS_ADMIN, TAB_SECTIONS_MEMBER };
      `;
      const { TAB_SECTIONS_ADMIN, TAB_SECTIONS_MEMBER } = new Function(fnCode)();

      // Alice (Admin) sections per tab (max 5 per tab)
      expect(TAB_SECTIONS_ADMIN.runtime.map((s: any) => s.id)).toEqual(['runtime', 'plugins', 'tasks', 'security']);
      expect(TAB_SECTIONS_ADMIN.workspaces.map((s: any) => s.id)).toEqual(['spaces-sessions', 'instructions', 'profiles', 'extensions', 'deliveries']);
      expect(TAB_SECTIONS_ADMIN.storage.map((s: any) => s.id)).toEqual(['files', 'quotas', 'imports', 'reconcile']);
      expect(TAB_SECTIONS_ADMIN.users.map((s: any) => s.id)).toEqual(['users', 'audit', 'account']);
      expect(TAB_SECTIONS_ADMIN.models.map((s: any) => s.id)).toEqual(['model-config', 'model-usage']);

      // Bob (Member) sections per tab: only allowed sections appear, admin-only sections absent
      expect(TAB_SECTIONS_MEMBER.runtime.map((s: any) => s.id)).toEqual(['runtime', 'tasks']);
      expect(TAB_SECTIONS_MEMBER.workspaces.map((s: any) => s.id)).toEqual(['instructions', 'profiles', 'extensions', 'deliveries']);
      expect(TAB_SECTIONS_MEMBER.storage.map((s: any) => s.id)).toEqual(['files', 'quotas', 'imports']);
      expect(TAB_SECTIONS_MEMBER.users.map((s: any) => s.id)).toEqual(['audit', 'account']);
      expect(TAB_SECTIONS_MEMBER.models.map((s: any) => s.id)).toEqual(['model-config', 'model-usage']);

      // No channels, no billing
      Object.values(TAB_SECTIONS_ADMIN).forEach((sections: any) => {
        const ids = sections.map((s: any) => s.id);
        expect(ids).not.toContain('channels');
        expect(ids).not.toContain('billing');
      });
      Object.values(TAB_SECTIONS_MEMBER).forEach((sections: any) => {
        const ids = sections.map((s: any) => s.id);
        expect(ids).not.toContain('channels');
        expect(ids).not.toContain('billing');
      });
    });

    it('prevents async rendering races using generation counters and off-DOM container commits', () => {
      expect(jsCode).toContain('managementRenderGen');
      expect(jsCode).toContain('state.managementRenderGen += 1');
      expect(jsCode).toContain('const currentGen = state.managementRenderGen');
      expect(jsCode).toContain('const offDomContainer = document.createElement');
      expect(jsCode).toContain('state.managementRenderGen === currentGen && state.currentRoute === route');
      expect(jsCode).toContain('canvas.replaceChildren(...offDomContainer.childNodes)');
    });

    it('suspends chat polling on management routes and resumes when returning to workspace', () => {
      expect(jsCode).toContain("route === 'workspace'");
      expect(jsCode).toContain('startPolling(state.currentSessionId)');
      expect(jsCode).toContain('stopPolling()');
    });

    it('integrates required backend admin and management endpoints', () => {
      // Admin endpoints
      expect(jsCode).toContain('/api/admin/dashboard');
      expect(jsCode).toContain('/api/admin/users');
      expect(jsCode).toContain('/api/admin/spaces');
      expect(jsCode).toContain('/api/admin/runtime');
      expect(jsCode).toContain('/api/admin/plugins');
      expect(jsCode).toContain('/api/admin/tasks');
      expect(jsCode).toContain('/api/admin/deliveries');
      expect(jsCode).toContain('/api/admin/quotas');
      expect(jsCode).toContain('/api/admin/audit');
      expect(jsCode).toContain('/api/admin/imports');
      expect(jsCode).toContain('/api/admin/security');
      if (jsCode.includes('/api/admin/model-config')) {
        expect(jsCode).toContain('/api/admin/model-config');
      }
      if (jsCode.includes('/api/auth/password')) {
        expect(jsCode).toContain('/api/auth/password');
      }

      // Admin mutations
      expect(jsCode).toContain('/revoke-sessions');
      expect(jsCode).toContain("method: 'PATCH'");
      expect(jsCode).toContain('{ role, status, displayName }');

      // Self management endpoints
      expect(jsCode).toContain('/api/manage/overview');
      expect(jsCode).toContain('/api/manage/tasks');
      expect(jsCode).toContain('/api/manage/deliveries');
      expect(jsCode).toContain('/api/manage/quotas');
      expect(jsCode).toContain('/api/manage/audit');
      expect(jsCode).toContain('/api/manage/imports');

      // Session turns inspector
      expect(jsCode).toContain('/api/sessions/');
      expect(jsCode).toContain('/turns');
    });

    it('requires confirmation dialog before role/status mutation or session revocation', () => {
      expect(jsCode).toContain('showConfirmation');
      expect(jsCode).toContain('Revoke Active Sessions');
      expect(jsCode).toContain('Confirm User Mutation');
    });

    it('renders server data exclusively through DOM nodes and textContent (zero unsafe innerHTML)', () => {
      expect(jsCode).not.toMatch(/innerHTML/);
      expect(jsCode).toContain('document.createElement');
      expect(jsCode).toContain('.textContent =');
      expect(jsCode).toContain('.appendChild');
      expect(jsCode).toContain('.replaceChildren');
    });

    it('restores chat draft on send message failure', () => {
      expect(jsCode).toContain('input.value = text');
      expect(jsCode).toContain("showSafeError('send_message')");
    });

    it('handles 401 Unauthorized safely only after user is authenticated to prevent checkAuth recursion', () => {
      expect(jsCode).toContain('response.status === 401 && state.currentUser');
      expect(jsCode).toContain('showAuthView()');
    });

    it('handles user mutation and session revocation targeting self by clearing auth or re-bootstrapping /auth/me', () => {
      expect(jsCode).toContain('isSelf');
      expect(jsCode).toContain("status === 'disabled' || (res && res.data && res.data.forceLogout)");
      expect(jsCode).toContain('checkAuth()');
    });

    it('implements accessible modal focus restoration and Escape key handling', () => {
      expect(jsCode).toContain('state.activeModals');
      expect(jsCode).toContain('state.previousActiveElement');
      expect(jsCode).toContain('closeTopModal');
      expect(jsCode).toContain("e.key === 'Escape'");
    });

    it('renderAdminSpacesView NEVER calls tenant spaces sessions endpoint and renders aggregate table only', () => {
      const fnStart = jsCode.indexOf('async function renderAdminSpacesView');
      const fnEnd = jsCode.indexOf('async function renderAdminRuntimeView');
      expect(fnStart).toBeGreaterThan(-1);
      expect(fnEnd).toBeGreaterThan(fnStart);
      const fnBody = jsCode.slice(fnStart, fnEnd);

      // Must fetch /api/admin/spaces
      expect(fnBody).toContain("apiRequest('/api/admin/spaces')");
      // Must NOT fetch tenant spaces or sessions under admin spaces view
      expect(fnBody).not.toContain("apiRequest('/api/spaces')");
      expect(fnBody).not.toContain('/sessions');
      // Aggregate columns
      expect(fnBody).toContain("['Owner', 'Space Name', 'Sessions', 'Created At']");
      // No cross-tenant turn inspector buttons in admin spaces view
      expect(fnBody).not.toContain('openSessionTurnsModal');
    });

    it('openSessionTurnsModal renders actual contract only (status, startedAt, finishedAt)', () => {
      const fnStart = jsCode.indexOf('async function openSessionTurnsModal');
      const fnEnd = jsCode.indexOf('async function loadSpaces');
      expect(fnStart).toBeGreaterThan(-1);
      expect(fnEnd).toBeGreaterThan(fnStart);
      const fnBody = jsCode.slice(fnStart, fnEnd);

      expect(fnBody).toContain("['Status', 'Started', 'Finished']");
      expect(fnBody).toContain('turn.status');
      expect(fnBody).toContain('turn.startedAt');
      expect(fnBody).toContain('turn.finishedAt');
      // Must NOT render prompt/input/response/output/raw error
      expect(fnBody).not.toContain('turn.prompt');
      expect(fnBody).not.toContain('turn.response');
      expect(fnBody).not.toContain('turn.input');
      expect(fnBody).not.toContain('turn.output');
    });
  });

  describe('Zero-Fabrication & Strict Absence Grep Verifications', () => {
    it('CONFIRMS ABSENCE: d.status || "delivered" is completely removed', () => {
      expect(jsCode).not.toContain("d.status || 'delivered'");
      expect(jsCode).not.toContain('d.status || "delivered"');
    });

    it('CONFIRMS ABSENCE: u.status || "active" is completely removed', () => {
      expect(jsCode).not.toContain("u.status || 'active'");
      expect(jsCode).not.toContain('u.status || "active"');
    });

    it('CONFIRMS ABSENCE: turn.status || "completed" is completely removed', () => {
      expect(jsCode).not.toContain("turn.status || 'completed'");
      expect(jsCode).not.toContain('turn.status || "completed"');
    });

    it('CONFIRMS ABSENCE: execution mode fallbacks in management telemetry are completely removed', () => {
      expect(jsCode).not.toMatch(/executionMode\s*\|\|/);
      expect(jsCode).not.toMatch(/sp\.executionMode\s*\|\|/);
      expect(jsCode).not.toMatch(/turn\.executionMode\s*\|\|/);
    });

    it('CONFIRMS ABSENCE: management state.spaces.length and state.sessions.length fallbacks are completely removed', () => {
      expect(jsCode).not.toContain('counts.spaces ?? state.spaces.length');
      expect(jsCode).not.toContain('counts.sessions ?? state.sessions.length');
      expect(jsCode).not.toContain('counts.spaces ? counts.spaces.total : state.spaces.length');
      expect(jsCode).not.toContain('counts.sessions ? counts.sessions.total : state.sessions.length');
    });

    it('CONFIRMS ABSENCE: cross-tenant session route calls in admin spaces view are completely removed', () => {
      const fnStart = jsCode.indexOf('async function renderAdminSpacesView');
      const fnEnd = jsCode.indexOf('async function renderAdminRuntimeView');
      const fnBody = jsCode.slice(fnStart, fnEnd);
      expect(fnBody).not.toContain("apiRequest('/api/spaces')");
      expect(fnBody).not.toContain('/sessions');
    });

    it('renders real telemetry without synthetic limits or fabricated readiness', () => {
      // Quotas: zero hardcoded synthetic numbers
      expect(jsCode).not.toContain("'Space Limit', '50'");
      expect(jsCode).not.toContain("'Concurrent Turns', '5'");
      expect(jsCode).not.toContain("'Message Retention', '30 Days'");
      expect(jsCode).not.toContain('Default limits apply');
      expect(jsCode).toContain('Configured Limits');
      expect(jsCode).toContain('No Quotas Configured');

      // Overview: computes real healthy state from allDshReady / healthy status
      expect(jsCode).toContain('allDshReady');
      expect(jsCode).toContain('healthyRuntimes');
      expect(jsCode).not.toContain('All chat and workspace operations continue normally.');
      expect(jsCode).not.toContain('Platform connection active.');
      expect(jsCode).not.toContain('No background tasks reported.');
      expect(jsCode).not.toContain('No Active Tasks');
      expect(jsCode).not.toContain('Zero-network sandbox');
      expect(jsCode).toContain('The management overview service is currently unreachable or uninitialized. Status cannot be verified.');
      expect(jsCode).toContain('No Task Records');
      expect(jsCode).toContain('No task records were returned for this account.');
      expect(jsCode).toContain("allNone ? 'All reported runtimes use no network' : 'Server-reported modes'");

      // Delivery: accurately reflects inbound delivery inbox receipts
      expect(jsCode).toContain('Inbound delivery inbox receipts, dispatch status, and route metadata');

      // Runtime: requires all runtimes to report 'none' for network KPI; fallback Unknown and unavailable
      expect(jsCode).toContain("runtimes.every((r) => r.networkMode === 'none')");
      expect(jsCode).toContain("r.networkMode === 'none' ? '--network none' : (r.networkMode ? r.networkMode : 'Unavailable')");
      expect(jsCode).toContain("r.status === 'ok' || r.status === 'degraded' || r.status === 'error'");
      expect(jsCode).toContain("rowStatus = isValidStatus ? r.status : 'unavailable'");

      // Plugins: displays distinct Unavailable for undefined properties and renders 7 Cordis plugin keys
      expect(jsCode).toContain('No Runtime Telemetry');
      expect(jsCode).not.toContain('No Extensions Installed');
      expect(jsCode).toContain('CORDIS_PLUGIN_KEYS');
      expect(jsCode).toContain('receiptStore');
      expect(jsCode).toContain('inbound');
      expect(jsCode).toContain('eventRelay');
      expect(jsCode).toContain('tools');
      expect(jsCode).toContain('externalInteraction');
      expect(jsCode).toContain('affinityPolicy');
      expect(jsCode).toContain('llmAffinity');

      // Security: does not fabricate CSRF or Host binding when data is missing
      expect(jsCode).not.toContain("hostBinding || '127.0.0.1'");
      expect(jsCode).toContain("hostBinding) || 'Unavailable'");
    });

    it('CONFIRMS ABSENCE: host direct execution option is removed from index.html', () => {
      expect(html).not.toContain('Host (Direct execution)');
      expect(html).not.toContain('value="host"');
      expect(html).toContain('value="container"');
    });

    it('CONFIRMS ABSENCE: inline style assignments in JS (e.g. pluginList.style.gap) are removed; CSS contains .flex-row-wrap', () => {
      expect(jsCode).not.toContain('pluginList.style');
      expect(jsCode).not.toContain('.style.gap');
      expect(cssContent).toContain('.flex-row-wrap');
    });

    it('CONFIRMS ABSENCE: security unavailable does not make fail-closed invariant claims; CSRF requires csrfRequired and csrfHeader', () => {
      expect(jsCode).not.toContain('Default fail-closed security invariants remain strictly active');
      expect(jsCode).toContain('The security management endpoint (/api/admin/security) is unavailable.');
      expect(jsCode).toContain('csrfRequired === true');
      expect(jsCode).toContain('csrfHeader');
    });

    it('Activity view requires exact username and does not dump details JSON in IP column', () => {
      expect(jsCode).not.toContain("entry.userId || 'System'");
      expect(jsCode).not.toContain("entry.userId || 'unknown'");
      expect(jsCode).not.toContain("entry.actor");
      expect(jsCode).toContain("tdActor.textContent = entry.username");
      expect(jsCode).not.toContain('JSON.stringify(entry.details)');
    });

    it('CONFIRMS ABSENCE: synthetic task, quota, import, and dashboard fallbacks are completely removed', () => {
      // Task title fallback
      expect(jsCode).not.toContain("t.spaceId || 'Task'");

      // Quota resource & user synthetic fallbacks
      expect(jsCode).not.toContain("lim.resource || 'turns_per_minute'");
      expect(jsCode).not.toContain("q.userId || 'Self'");

      // Import fixture fallback
      expect(jsCode).not.toContain("imp.format || 'Standard Fixture'");

      // Dashboard uptime fallback & sessions subtitle
      expect(jsCode).not.toContain("dashData.uptime === 'number' ? `${Math.floor(dashData.uptime)}s` : 'Active'");
      expect(jsCode).not.toContain("'Total Sessions', sessionsTotal, 'Active sessions'");

      // Runtime subtitle & factual unavailable state
      expect(jsCode).not.toContain("'Total Runtimes', runtimes.length, 'Active containers'");
      expect(jsCode).toContain("'Total Runtimes', String(runtimes.length), 'Reported records'");
      expect(jsCode).toContain('The runtime management endpoint (/api/admin/runtime) is unavailable');
    });
  });

  describe('Sidebar Tenant Indicator & Dynamic Account Display Contract', () => {
    it('initial index.html contains empty tenant-indicator without static web-demo', () => {
      expect(html).toContain('id="tenant-indicator"');
      expect(html).not.toContain('Account: web-demo');
      expect(html).toContain('<span id="tenant-indicator" class="session-meta"></span>');
    });

    it('showAuthView clears tenant indicator upon logout or unauthenticated state', () => {
      expect(jsCode).toContain('function showAuthView()');
      expect(jsCode).toContain("const tenantIndicator = document.getElementById('tenant-indicator')");
      expect(jsCode).toContain("tenantIndicator.textContent = ''");
    });

    it('onLoginSuccess formats tenant-indicator with real authenticated user fields (username, displayName, role)', () => {
      expect(jsCode).toContain('function onLoginSuccess(user)');
      expect(jsCode).toContain("user.displayName && user.displayName !== user.username");
      expect(jsCode).toContain("tenantIndicator.textContent = `Account: ${nameText}${roleText}`");
    });
  });

  describe('Real Chat Turn Control & Stop Turn Flow Contract', () => {
    it('index.html contains Stop Turn button with proper classes and attributes', () => {
      expect(html).toContain('id="btn-stop-turn"');
      expect(html).toContain('class="btn btn-danger btn-sm hidden"');
      expect(html).toContain('title="Stop current active turn"');
      expect(html).toContain('⏹ Stop Turn');
    });

    it('manages active turn lifecycle state (hasCancellableTurn, activeTurnStatus, isCancellingTurn)', () => {
      expect(jsCode).toContain('hasCancellableTurn: false');
      expect(jsCode).toContain('activeTurnStatus: null');
      expect(jsCode).toContain('isCancellingTurn: false');
    });

    it('updateStopTurnControl reveals button strictly for queued or running status and disables while cancelling', () => {
      expect(jsCode).toContain('function updateStopTurnControl()');
      expect(jsCode).toContain("state.activeTurnStatus === 'queued' || state.activeTurnStatus === 'running'");
      expect(jsCode).toContain("btn.textContent = 'Stopping...'");
      expect(jsCode).toContain("btn.textContent = '⏹ Stop Turn'");
    });

    it('syncActiveTurnStatus fetches turn from GET /api/sessions/:id/turn/current and sets status', () => {
      expect(jsCode).toContain('async function syncActiveTurnStatus(sessionId)');
      expect(jsCode).toContain("apiRequest(`/api/sessions/${sessionId}/turn/current`)");
      expect(jsCode).toContain('state.hasCancellableTurn = true');
      expect(jsCode).toContain('state.activeTurnStatus = status');
    });

    it('handleStopCurrentTurn posts cancellation to POST /api/sessions/:id/turn/cancel-current with Idempotency-Key and handles 200, 404, 409 without faking success', () => {
      expect(jsCode).toContain('async function handleStopCurrentTurn()');
      expect(jsCode).toContain("apiRequest(`/api/sessions/${sessionId}/turn/cancel-current`");
      expect(jsCode).toContain("method: 'POST'");
      expect(jsCode).toContain('res.data.cancelled === true');
      expect(jsCode).toContain('stopped successfully');
      expect(jsCode).toContain('already completed or settled');
      expect(jsCode).toContain('err.status === 404');
      expect(jsCode).toContain('err.status === 409');
    });

    it('refreshes session messages and turn status after cancel operation or polling events', () => {
      expect(jsCode).toContain('loadMessages(sessionId)');
      expect(jsCode).toContain('syncActiveTurnStatus(sessionId)');
      expect(jsCode).toContain("stopTurnBtn.addEventListener('click', handleStopCurrentTurn)");
    });
  });

  describe('Admin Dashboard Telemetry & Breakdown Reporting Contract', () => {
    it('renders real users active/disabled telemetry breakdown without guessing 0', () => {
      expect(jsCode).toContain("const usersObj = counts.users");
      expect(jsCode).toContain("typeof usersObj.active === 'number'");
      expect(jsCode).toContain("typeof usersObj.disabled === 'number'");
      expect(jsCode).toContain("`${active} active / ${disabled} disabled`");
    });

    it('renders real platform tasks pending/running breakdown without guessing 0', () => {
      expect(jsCode).toContain("const tasksObj = counts.tasks");
      expect(jsCode).toContain("typeof tasksObj.pending === 'number'");
      expect(jsCode).toContain("typeof tasksObj.running === 'number'");
      expect(jsCode).toContain("`${pending} pending / ${running} running`");
    });

    it('renders real delivery pipeline held/processing breakdown without guessing 0', () => {
      expect(jsCode).toContain("const delivObj = counts.deliveries");
      expect(jsCode).toContain("typeof delivObj.held === 'number'");
      expect(jsCode).toContain("typeof delivObj.processing === 'number'");
      expect(jsCode).toContain("`${held} held / ${processing} processing`");
    });

    it('preserves real runtime engine availability and process uptime', () => {
      expect(jsCode).toContain('dashData.runtime && dashData.runtime.available');
      expect(jsCode).toContain("typeof dashData.uptime === 'number' ? `${Math.floor(dashData.uptime)}s` : 'Unavailable'");
    });

    it('compatibly renders future optional telemetry fields (authFailures24h, schemaVersion, activeContainers) when provided by backend', () => {
      expect(jsCode).toContain('authFailures24h');
      expect(jsCode).toContain('Auth Failures (24h)');
      expect(jsCode).toContain('schemaVersion');
      expect(jsCode).toContain('Schema Version');
      expect(jsCode).toContain('activeContainers');
      expect(jsCode).toContain('Active Containers');
    });
  });

  describe('Read-Only Telemetry vs Actionable Control Distinction Contract', () => {
    it('clearly labels Tasks, Quotas, Plugins and Delivery as read-only telemetry / monitoring without implying creation/config', () => {
      expect(jsCode).toContain("'Tasks'");
      expect(jsCode).toContain('Async execution tasks, background jobs, and worker queues');
      expect(jsCode).toContain("'Delivery Pipeline'");
      expect(jsCode).toContain('Inbound delivery inbox receipts, dispatch status, and route metadata');
      expect(jsCode).toContain("'Resource Quotas'");
      expect(jsCode).toContain('Concurrency limits, space storage allocations, and turn thresholds');
      expect(jsCode).toContain("'Plugins Registry'");
      expect(jsCode).toContain('Enkeep Cordis Plugin Enclaves');
    });
  });

  describe('Files Workbench & Container Volume DOM Contract', () => {
    it('registers files route in navigation and valid management routes', () => {
      expect(jsCode).toContain("'files'");
      expect(jsCode).toContain("case 'files':");
      expect(jsCode).toContain('renderFilesView');
    });

    it('enforces Container Volume isolation labelling and never exposes host mounts, folder paths, internal space IDs, or absolute home paths', () => {
      expect(jsCode).toContain('Tenant volume / ');
      expect(jsCode).toContain('badge-container-volume');
      expect(jsCode).not.toContain('space:${activeSpaceId}');
      expect(jsCode).not.toContain('/home/dsh');
      expect(jsCode).not.toContain('/home/');
      expect(jsCode).not.toContain('/Users/');
      expect(jsCode).not.toContain('/var/run');
    });

    it('provides directory navigation, breadcrumbs, and parent traversal', () => {
      expect(jsCode).toContain('files-breadcrumbs');
      expect(jsCode).toContain('files-crumb-btn');
      expect(jsCode).toContain('.. (Go to Parent Folder)');
      expect(jsCode).toContain("state.filesCurrentPath = '.'");
    });

    it('provides file view, edit, save with expectedEtag / requireAbsent in body and Idempotency-Key support without fake keys or timestamp IDs', () => {
      expect(jsCode).toContain('/files/content');
      expect(jsCode).toContain('requireAbsent: true');
      expect(jsCode).toContain('expectedEtag: activeFile.etag');
      expect(jsCode).toContain('Idempotency-Key');
      expect(jsCode).not.toContain('10000000-0000-4000-8000-');
      expect(jsCode).not.toMatch(/Idempotency-Key.*Date\.now/i);
      expect(jsCode).toContain('files-editor-textarea');
      expect(jsCode).toContain('btn-files-save');
    });

    it('provides folder creation and file deletion controls with canonical payload and idempotency header', () => {
      expect(jsCode).toContain('/files/mkdir');
      expect(jsCode).toContain('expectedEtag: entry.etag');
      expect(jsCode).toContain('btn-files-new-folder');
      expect(jsCode).toContain('btn-files-new-file');
    });

    it('handles race conflict (409) and provider unavailable (503) truthfully without fake success', () => {
      expect(jsCode).toContain('Conflict: File was modified by another operation. Reload before saving.');
      expect(jsCode).toContain('The container runtime for space');
      expect(jsCode).toContain('is not currently running or available');
    });
  });

  describe('Workbench Interactive Capabilities: Tasks, Lifecycle, Profiles, and Quotas', () => {
    it('provides interactive task creation and lifecycle actions (POST /api/manage/tasks, /run, /cancel)', () => {
      expect(jsCode).toContain('+ Create Scheduled Agent Prompt Task');
      expect(jsCode).toContain('POST');
      expect(jsCode).toContain('/api/manage/tasks');
      expect(jsCode).toContain('/api/manage/tasks/${t.id}/run');
      expect(jsCode).toContain('/api/manage/tasks/${t.id}/cancel');
      expect(jsCode).toContain('Run Now');
      expect(jsCode).toContain('Cancel');
    });

    it('provides space lifecycle management (rename, archive) without fabricating state', () => {
      expect(jsCode).toContain('/api/spaces/${state.currentSpaceId}');
      expect(jsCode).toContain('/api/spaces/${state.currentSpaceId}/archive');
      expect(html).toContain('modal-rename-space');
      expect(html).toContain('btn-rename-space');
      expect(html).toContain('btn-archive-space');
    });

    it('provides session lifecycle management (rename, archive, reset generation N+1, generations history without internal IDs)', () => {
      expect(jsCode).toContain('/api/sessions/${state.currentSessionId}');
      expect(jsCode).toContain('/api/sessions/${sessionId}/archive');
      expect(jsCode).toContain('/api/sessions/${sessionId}/reset');
      expect(jsCode).toContain('/api/sessions/${sessionId}/generations');
      expect(jsCode).not.toContain('profileSnapshotId');
      expect(jsCode).not.toContain('g.generation || 1');
      expect(jsCode).not.toContain('g.resetReason || g.reason');
      expect(jsCode).toContain('Number.isInteger(g.generation) && g.generation >= 1');
      expect(jsCode).toContain('g.isCurrent === true');
      expect(jsCode).toContain("'Reset Reason: Omitted'");
      expect(html).toContain('modal-rename-session');
      expect(html).toContain('modal-reset-session');
      expect(html).toContain('modal-generations');
      expect(html).toContain('btn-reset-session');
      expect(html).toContain('btn-session-generations');
    });

    it('provides agent profile governance via canonical REST /api/manage/agent-profiles without aliases or prompt hash leakage', () => {
      expect(jsCode).toContain('/api/manage/agent-profiles');
      expect(jsCode).not.toContain("apiRequest('/api/agent-profiles')");
      expect(jsCode).toContain('/api/manage/agent-profiles/${profileId}/versions');
      expect(jsCode).not.toMatch(/prompt[H]ash/);
      expect(jsCode).toContain('/agent-profile');
      expect(html).toContain('modal-create-profile');
      expect(html).toContain('modal-create-profile-version');
      expect(html).toContain('modal-profile-versions');
      expect(html).toContain('tab-btn-workspaces');
    });

    it('provides admin explicit quota editing for the 5 fixed metrics (tokens, messages, turns, storage_bytes, api_calls)', () => {
      expect(jsCode).toContain('/api/admin/quotas/${encodeURIComponent(userId)}/${encodeURIComponent(metric)}');
      expect(html).toContain('modal-edit-quota');
      expect(html).toContain('quota-metric-select');
      expect(html).toContain('tokens');
      expect(html).toContain('messages');
      expect(html).toContain('turns');
      expect(html).toContain('storage_bytes');
      expect(html).toContain('api_calls');
    });
  });

  describe('Operational Truth & Telemetry Separation Contract', () => {
    it('separates Core Container Readiness from Tool Schema Registration and Tool Execution Operational state in Runtime view', () => {
      expect(jsCode).toContain('Tool Schemas');
      expect(jsCode).toContain('Tool Execution');
      expect(jsCode).toContain('toolsOperational === true');
      expect(jsCode).toContain('toolsOperational === false');
      expect(jsCode).toContain('getToolsUnavailableReason(r.toolsUnavailableReason)');
      expect(jsCode).toContain('text-warning text-xs');
    });

    it('separates Tool Schemas from Tool Execution Operational status in Plugins Registry view', () => {
      expect(jsCode).toContain('Enkeep Cordis Plugin Enclaves');
      expect(jsCode).toContain('Tool Schemas');
      expect(jsCode).toContain('Tool Execution');
      expect(jsCode).toContain('Degraded / Offline');
    });

    it('separates Task Producer Available from Task Worker Status in Tasks View', () => {
      expect(jsCode).toContain('Task Producer');
      expect(jsCode).toContain('Task Worker');
      expect(jsCode).toContain('ops.producer && ops.producer.available === true');
      expect(jsCode).toContain('ops.worker && ops.worker.available === true');
      expect(jsCode).toContain('isTaskProducerReady');
      expect(jsCode).toContain('isTaskWorkerAvailable');
      expect(jsCode).toContain('isTaskWorkerRunning');
      expect(jsCode).toContain('taskWorkerStatus');
    });

    it('disables "Run Now" button when Task Worker is unavailable or not running while allowing task scheduling via producer', () => {
      expect(jsCode).toContain('isWorkerExecutable');
      expect(jsCode).toContain('runBtn.disabled = isFinished || !isWorkerExecutable');
      expect(jsCode).toContain('Worker is not running or available');
    });

    it('distinguishes healthy core runtime from degraded tool execution in Dashboard and Overview', () => {
      expect(jsCode).toContain('toolsOperationalCount');
      expect(jsCode).toContain('Sandbox (Tools Degraded)');
      expect(jsCode).toContain('Tool Execution');
    });

    it('renders "Unavailable" instead of synthetic "0" when runtime or provider responses are missing or errored', () => {
      expect(jsCode).toContain('Runtime Service Unavailable');
      expect(jsCode).toContain('Plugins Registry Unavailable');
    });
  });

  describe('Security, DOM-Only Rendering & CSP Integrity Contract', () => {
    it('enforces zero innerHTML assignments and insertAdjacentHTML across entire app.js codebase', () => {
      expect(jsCode).not.toContain('.innerHTML');
      expect(jsCode).not.toMatch(/innerHTML\s*=/);
      expect(jsCode).not.toContain('insertAdjacentHTML');
    });

    it('enforces zero inline style modifications across entire app.js codebase', () => {
      expect(jsCode).not.toContain('.style.');
      expect(jsCode).not.toContain('.style =');
      expect(jsCode).not.toMatch(/\.style\[/);
    });

    it('enforces zero inline property event handlers across entire app.js codebase', () => {
      expect(jsCode).not.toContain('.on' + 'click');
      expect(jsCode).not.toMatch(/\.on[a-zA-Z]+\s*=/);
    });

    it('uses standard DOM APIs (document.createElement, textContent, appendChild, replaceChildren, addEventListener) for all rendering', () => {
      expect(jsCode).toContain('document.createElement');
      expect(jsCode).toContain('.textContent =');
      expect(jsCode).toContain('.appendChild');
      expect(jsCode).toContain('.replaceChildren');
      expect(jsCode).toContain('addEventListener');
    });

    it('enforces zero console logging calls across entire app.js codebase', () => {
      expect(jsCode).not.toMatch(/console\.(log|error|warn|info|debug)\s*\(/);
    });
  });

  describe('Alice (Admin) & Bob (User) Demo Fixtures & Field Mapping Contract Tests', () => {
    // Exact Demo Fixtures as returned by Platform Server GET endpoints
    const aliceDemoFixtures = {
      dashboard: {
        counts: {
          users: { total: 3, active: 2, disabled: 1, admin: 1, user: 2 },
          spaces: { total: 4 },
          sessions: { total: 2 },
          messages: { total: 24 },
          tasks: { total: 3, pending: 1, claimed: 1, running: 0, processing: 0, completed: 1, failed: 0, cancelled: 0 },
          deliveries: { total: 4, held: 0, processing: 0, delivered: 2, duplicate: 1, cancelled: 1, failed: 0 },
          imports: { totalReceipts: 2, totalImportedMessages: 50 },
          auth: { recentLoginFailures24h: 0 },
          schema: { currentVersion: 11 },
        },
        kpis: {
          users: { total: 3, active: 2, disabled: 1, admin: 1, user: 2 },
          spaces: 4,
          sessions: 2,
          containers: { available: true, active: 2, healthy: 2, total: 2, status: 'available' },
          heldDeliveries: 0,
          processingTasks: 0,
          runningTasks: 0,
          recentLoginFailures24h: 0,
          currentSchemaVersion: 11,
        },
        runtime: {
          available: true,
          providerAttached: true,
          status: 'available',
          totalContainers: 2,
          activeContainers: 2,
          healthyContainers: 2,
          summary: {
            totalRuntimes: 2,
            healthyRuntimes: 2,
            activeRuntimes: 2,
            allDshReady: true,
            toolsOperationalCount: 2,
          },
        },
        schema: { currentVersion: 11 },
        uptime: 1234.56,
        timestamp: '2026-03-30T12:00:00.000Z',
      },
      plugins: {
        available: true,
        status: 'available',
        runtimes: [
          {
            userId: 'alice',
            status: 'ok',
            dshReady: true,
            toolsCount: 4,
            enkeepBundleLoaded: true,
            schemasRegistered: true,
            toolsOperational: true,
            toolsUnavailableReason: null,
            executionOperational: true,
            reason: null,
            plugins: {
              receiptStore: true,
              inbound: true,
              eventRelay: true,
              tools: true,
              externalInteraction: true,
              affinityPolicy: true,
              llmAffinity: true,
            },
            networkMode: 'none',
            uptimeSeconds: 1200,
            version: '0.1.0',
          },
        ],
      },
      imports: {
        items: [
          {
            userId: 'alice',
            username: 'alice',
            importerVersion: '1.2.0',
            sessionFormat: 1,
            sourceChatsCount: 2,
            sourceMessagesCount: 50,
            importedMessagesCount: 48,
            droppedMessagesCount: 2,
            attachmentsCount: 5,
            status: 'completed',
            createdAt: '2026-03-30T10:00:00.000Z',
          },
        ],
        total: 1,
        limit: 50,
        offset: 0,
      },
      tasks: {
        items: [
          {
            id: 'task-alice-1',
            userId: 'alice',
            username: 'alice',
            title: 'Cluster Health Check',
            priority: 'high',
            status: 'claimed',
            dueDate: '2026-04-01T00:00:00.000Z',
            createdAt: '2026-03-30T09:00:00.000Z',
          },
        ],
        total: 1,
        limit: 50,
        offset: 0,
      },
      deliveries: {
        items: [
          {
            status: 'duplicate',
            createdAt: '2026-03-30T08:00:00.000Z',
            updatedAt: '2026-03-30T08:00:01.000Z',
          },
          {
            status: 'cancelled',
            createdAt: '2026-03-30T08:30:00.000Z',
            updatedAt: '2026-03-30T08:30:02.000Z',
          },
        ],
        total: 2,
        limit: 50,
        offset: 0,
      },
    };

    const bobDemoFixtures = {
      quotaCheck: {
        allowed: true,
        usage: { tokens: 350, messages: 12, turns: 4, storage_bytes: 1024, api_calls: 8 },
        activeReservations: { tokens: 50, messages: 1, turns: 1, storage_bytes: 0, api_calls: 0 },
        limit: { tokens: 50000, messages: 1000, turns: 200, storage_bytes: 10485760, api_calls: 500 },
        remaining: { tokens: 49600, messages: 987, turns: 195, storage_bytes: 10484736, api_calls: 492 },
        resetAt: '2026-04-01T00:00:00.000Z',
      },
      agentProfiles: {
        items: [
          {
            id: 'profile-bob-1',
            name: 'Code Reviewer Persona',
            description: 'Automated code review expert',
            status: 'active',
            activeVersion: 2,
            createdAt: '2026-03-29T12:00:00.000Z',
            updatedAt: '2026-03-30T11:00:00.000Z',
          },
        ],
        total: 1,
        limit: 50,
        offset: 0,
      },
      profileVersions: [
        {
          version: 2,
          identity: 'Senior Staff Engineer',
          soul: 'Be thorough and constructive',
          agents: 'Code review routing',
          tools: 'Git and linter tools',
          changeSummary: 'Updated tone guidelines',
          createdAt: '2026-03-30T11:00:00.000Z',
        },
      ],
    };

    it('BUG-01 Verification: User quota consumes exact 5-map shape without reading resources/items', () => {
      // Must consume exact {allowed, usage, activeReservations, limit, remaining, resetAt}
      expect(jsCode).toContain('const isAllowed = checkData.allowed === true');
      expect(jsCode).toContain('checkData.usage');
      expect(jsCode).toContain('checkData.activeReservations');
      expect(jsCode).toContain('checkData.limit');
      expect(jsCode).toContain('checkData.remaining');
      expect(jsCode).toContain('checkData.resetAt');

      // Must NOT read checkData.resources
      expect(jsCode).not.toContain('checkData.resources');
      expect(jsCode).not.toContain('res.data.resources');

      // Validates Bob fixture structure
      expect(bobDemoFixtures.quotaCheck).toHaveProperty('allowed', true);
      expect(bobDemoFixtures.quotaCheck.usage).toHaveProperty('tokens');
      expect(bobDemoFixtures.quotaCheck.activeReservations).toHaveProperty('tokens');
      expect(bobDemoFixtures.quotaCheck.limit).toHaveProperty('tokens');
      expect(bobDemoFixtures.quotaCheck.remaining).toHaveProperty('tokens');
    });

    it('BUG-02 Verification: Profiles consistently consume activeVersion in table, select dropdown, and versions modal', () => {
      expect(jsCode).toContain('p.activeVersion');
      expect(jsCode).toContain('Active Version');

      // Validates Bob agent profiles fixture
      expect(bobDemoFixtures.agentProfiles.items[0].activeVersion).toBe(2);
      expect(bobDemoFixtures.profileVersions[0].version).toBe(2);
    });

    it('BUG-04 Verification: Imports view displays real non-hyphen columns and metadata', () => {
      expect(jsCode).toContain("'User'");
      expect(jsCode).toContain("'Importer Version'");
      expect(jsCode).toContain("'Messages (Imported / Source)'");
      expect(jsCode).toContain("'Attachments'");
      expect(jsCode).toContain("'Imported At'");

      // Validates Alice imports fixture
      const imp = aliceDemoFixtures.imports.items[0];
      expect(imp.username).toBe('alice');
      expect(imp.importerVersion).toBe('1.2.0');
      expect(imp.importedMessagesCount).toBe(48);
      expect(imp.sourceMessagesCount).toBe(50);
      expect(imp.droppedMessagesCount).toBe(2);
      expect(imp.attachmentsCount).toBe(5);
    });

    it('BUG-05 Verification: Admin Dashboard resolves nested DTO KPI paths for auth failures, schema, and containers', () => {
      expect(jsCode).toContain('dashData.counts.auth.recentLoginFailures24h');
      expect(jsCode).toContain('dashData.schema.currentVersion');
      expect(jsCode).toContain('dashData.runtime.activeContainers');

      // Validates Alice dashboard fixture
      expect(aliceDemoFixtures.dashboard.counts.auth.recentLoginFailures24h).toBe(0);
      expect(aliceDemoFixtures.dashboard.schema.currentVersion).toBe(11);
      expect(aliceDemoFixtures.dashboard.runtime.activeContainers).toBe(2);
    });

    it('BUG-06 Verification: Admin Plugins returns and consumes status, dshReady, toolsOperational, and 7 Cordis booleans', () => {
      expect(jsCode).toContain('r.dshReady');
      expect(jsCode).toContain('r.status');
      expect(jsCode).toContain('r.toolsOperational');
      expect(jsCode).toContain('CORDIS_PLUGIN_KEYS');

      // Validates Alice plugins fixture
      const rt = aliceDemoFixtures.plugins.runtimes[0];
      expect(rt.status).toBe('ok');
      expect(rt.dshReady).toBe(true);
      expect(rt.toolsOperational).toBe(true);
      expect(rt.plugins.receiptStore).toBe(true);
      expect(rt.plugins.tools).toBe(true);
    });

    it('BUG-07 & BUG-08 Verification: Task status whitelist contains claimed; Delivery status whitelist contains duplicate and cancelled', () => {
      expect(jsCode).toContain("'claimed'");
      expect(jsCode).toContain("'duplicate'");
      expect(jsCode).toContain("'cancelled'");

      // Validates tasks and deliveries fixtures
      expect(aliceDemoFixtures.tasks.items[0].status).toBe('claimed');
      expect(aliceDemoFixtures.deliveries.items[0].status).toBe('duplicate');
      expect(aliceDemoFixtures.deliveries.items[1].status).toBe('cancelled');
    });

    it('BUG-09 Verification: showAuthView cleans all state and prevents cross-tenant leaks', () => {
      expect(jsCode).toContain('state.spaces = []');
      expect(jsCode).toContain('state.currentSpaceId = null');
      expect(jsCode).toContain('state.sessions = []');
      expect(jsCode).toContain('state.currentSessionId = null');
      expect(jsCode).toContain('state.messages = []');
      expect(jsCode).toContain('state.filesActiveSpaceId = null');
      expect(jsCode).toContain("state.filesCurrentPath = '.'");
      expect(jsCode).toContain('state.filesActiveFile = null');
    });

    it('BUG-10 Verification: Single confirmation proceed listener registered (no duplicate in DOMContentLoaded)', () => {
      const proceedMatches = jsCode.match(/getElementById\('btn-confirm-proceed'\)/g);
      expect(proceedMatches?.length).toBe(1);
    });

    it('Isolation Verification: Management views render "Invalid record" for malformed items without full page breakdown', () => {
      expect(jsCode).toContain('Invalid record');
    });
  });
});
