import { describe, it, expect } from 'vitest';
import { getWebUiIndexHtml, getWebUiAsset } from '../src/index.js';
import { en, DEFAULT_LOCALE, SUPPORTED_LOCALES } from '../src/static/i18n.js';

describe('Chat Lifecycle UI: Archive, Restore & Fork Controls', () => {
  const html = getWebUiIndexHtml();
  const appJsAsset = getWebUiAsset('app.js');
  const appJs = appJsAsset.content.toString('utf-8');

  it('verifies index.html contains all lifecycle buttons and modals', () => {
    // Space lifecycle buttons
    expect(html).toContain('id="btn-archive-space"');
    expect(html).toContain('id="btn-restore-space"');
    expect(html).toContain('id="btn-rename-space"');

    // Session lifecycle buttons & toggle
    expect(html).toContain('id="btn-toggle-archived-sessions"');
    expect(html).toContain('id="btn-archive-session"');
    expect(html).toContain('id="btn-restore-session"');
    expect(html).toContain('id="btn-fork-session"');
    expect(html).toContain('id="btn-reset-session"');

    // Fork Session Modal
    expect(html).toContain('id="modal-fork-session"');
    expect(html).toContain('id="fork-session-form"');
    expect(html).toContain('id="fork-session-title-input"');
    expect(html).toContain('id="fork-space-select"');
    expect(html).toContain('id="fork-source-message-id"');
    expect(html).toContain('id="fork-source-turn-id"');
    expect(html).toContain('id="fork-point-indicator"');
  });

  it('verifies i18n translation keys for all lifecycle operations in en and zh-CN', () => {
    expect(SUPPORTED_LOCALES).toContain('en');
    expect(SUPPORTED_LOCALES).toContain('zh-CN');

    // English keys
    expect(en['chat.restoreSpace']).toBe('Restore');
    expect(en['chat.restoreSession']).toBe('♻️ Restore');
    expect(en['chat.forkSession']).toBe('🍴 Fork');
    expect(en['chat.forkFromHere']).toBe('Fork from here');
    expect(en['chat.showArchived']).toBe('Show Archived');
    expect(en['modal.restoreSpaceConfirmTitle']).toBe('Restore Space');
    expect(en['modal.restoreSessionConfirmTitle']).toBe('Restore Session');
    expect(en['modal.forkSessionTitle']).toBe('Fork Session');
    expect(en['toast.spaceRestored']).toBeDefined();
    expect(en['toast.sessionRestored']).toBeDefined();
    expect(en['toast.sessionForked']).toBeDefined();
  });

  it('verifies app.js contains handlers for restore and fork', () => {
    expect(appJs).toContain('handleRestoreSpace');
    expect(appJs).toContain('handleRestoreSession');
    expect(appJs).toContain('openForkSessionModal');
    expect(appJs).toContain('handleForkSession');
    expect(appJs).toContain('toggleArchivedSessions');
    expect(appJs).toContain('forkFromHere');
  });
});
