import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { en, zhCN } from '../src/static/i18n.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('Web UI Background Tasks & Timestamp Formatting Suite', () => {
  const appJsSource = readFileSync(resolve(__dirname, '../src/static/app.js'), 'utf-8');
  const indexHtmlSource = readFileSync(resolve(__dirname, '../src/static/index.html'), 'utf-8');

  describe('1. Message Local Timestamp Formatting (YYYY-MM-DD HH:mm:ss)', () => {
    it('formats valid Date or ISO string as YYYY-MM-DD HH:mm:ss in local time', () => {
      // Extract formatTime function from app.js
      const formatTimeMatch = appJsSource.match(/function formatTime\([\s\S]*?\n\}/);
      expect(formatTimeMatch).not.toBeNull();

      const formatTime = new Function(
        'tr',
        `
        ${formatTimeMatch![0]}
        return formatTime;
      `
      )((_k: string, _p: any, fb: string) => fb);

      const fixedDate = new Date(2026, 9, 8, 14, 30, 45); // 2026-10-08 14:30:45 local
      const formatted = formatTime(fixedDate);
      expect(formatted).toBe('2026-10-08 14:30:45');

      const isoStr = fixedDate.toISOString();
      const formattedIso = formatTime(isoStr);
      expect(formattedIso).toBe('2026-10-08 14:30:45');
    });

    it('returns "Timestamp unavailable" fallback for null, undefined, or invalid dates', () => {
      const formatTimeMatch = appJsSource.match(/function formatTime\([\s\S]*?\n\}/);
      const formatTime = new Function(
        'tr',
        `
        ${formatTimeMatch![0]}
        return formatTime;
      `
      )((_k: string, _p: any, fb: string) => fb);

      expect(formatTime(null)).toBe('Timestamp unavailable');
      expect(formatTime(undefined)).toBe('Timestamp unavailable');
      expect(formatTime('invalid-date-string')).toBe('Timestamp unavailable');
    });

    it('app.js renderMessages uses formatTime for message timestamp display', () => {
      expect(appJsSource).toContain('timeText = formatTime(d)');
    });
  });

  describe('2. Session Header Background Tasks Badge', () => {
    it('index.html contains #btn-session-bg in chat-title-group without forbidden inline styles', () => {
      expect(indexHtmlSource).toContain('id="btn-session-bg"');
      expect(indexHtmlSource).not.toMatch(/id="btn-session-bg"[^>]*style=/);
    });

    it('updates badge visibility and count correctly', () => {
      // Extract updateSessionBackgroundBadge
      const fnMatch = appJsSource.match(/function updateSessionBackgroundBadge\([\s\S]*?\n\}/);
      expect(fnMatch).not.toBeNull();

      let textContent = '';
      let isHidden = true;

      const mockBadge = {
        get textContent() {
          return textContent;
        },
        set textContent(v) {
          textContent = v;
        },
        classList: {
          add: (cls: string) => {
            if (cls === 'hidden') isHidden = true;
          },
          remove: (cls: string) => {
            if (cls === 'hidden') isHidden = false;
          },
        },
      };

      const mockDocument = {
        getElementById: (id: string) => (id === 'btn-session-bg' ? mockBadge : null),
      };

      const state = {
        currentSessionId: 'ses_test_001',
        backgroundTasks: [],
      };

      const updateBadge = new Function(
        'document',
        'state',
        'tr',
        'formatNumber',
        `
        ${fnMatch![0]}
        return updateSessionBackgroundBadge;
      `
      )(
        mockDocument,
        state,
        (k: string, p: any, fb: string) => (p?.count ? `${p.count} Background` : fb),
        (n: number) => String(n)
      );

      // 1. Zero running tasks -> badge hidden
      updateBadge([]);
      expect(isHidden).toBe(true);

      // 2. 2 running tasks -> badge visible with '2 Background'
      const sampleTasks = [
        { id: 't1', status: 'running' },
        { id: 't2', status: 'running' },
        { id: 't3', status: 'completed' },
      ];
      updateBadge(sampleTasks);
      expect(isHidden).toBe(false);
      expect(textContent).toBe('2 Background');

      // 3. All tasks completed -> badge hidden
      updateBadge([{ id: 't1', status: 'completed' }]);
      expect(isHidden).toBe(true);
    });
  });

  describe('3. Background Tasks Modal List & Stop Action', () => {
    it('index.html contains #modal-background-tasks container', () => {
      expect(indexHtmlSource).toContain('id="modal-background-tasks"');
      expect(indexHtmlSource).toContain('id="bg-tasks-content"');
      expect(indexHtmlSource).toContain('id="modal-bg-tasks-title"');
    });

    it('contains i18n keys for all background task columns and actions in en and zh-CN', () => {
      const requiredKeys = [
        'tasks.bgHeaderTitle',
        'tasks.bgModalTitle',
        'tasks.bgRunningCount',
        'tasks.bgNoTasksTitle',
        'tasks.bgNoTasksSubtitle',
        'tasks.bgUnavailableTitle',
        'tasks.bgUnavailableSubtitle',
        'tasks.bgColKind',
        'tasks.bgColId',
        'tasks.bgColName',
        'tasks.bgColStatus',
        'tasks.bgColProgress',
        'tasks.bgColStarted',
        'tasks.bgColActions',
        'tasks.bgBtnStop',
        'tasks.bgStopping',
        'tasks.bgStopSuccess',
        'tasks.bgStopFailed',
        'tasks.bgStalledTag',
      ];

      for (const key of requiredKeys) {
        expect((en as any)[key], `Missing English key ${key}`).toBeDefined();
        expect((zhCN as any)[key], `Missing Chinese key ${key}`).toBeDefined();
      }
    });

    it('defines openBackgroundTasksModal and manages 30s auto-refresh interval', () => {
      expect(appJsSource).toContain('function openBackgroundTasksModal(');
      expect(appJsSource).toContain('bgModalRefreshTimer = setInterval(');
      expect(appJsSource).toMatch(/30_?000/);
      expect(appJsSource).toContain("fullId === 'modal-background-tasks'");
    });

    it('renders Stop button for running tasks calling POST /api/sessions/:sessionId/background/:taskId/stop', () => {
      expect(appJsSource).toContain('/api/sessions/${sessionId}/background/${encodeURIComponent(targetTaskId)}/stop');
      expect(appJsSource).toContain("method: 'POST'");
    });
  });
});
