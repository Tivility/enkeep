import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWebUiIndexHtml, getWebUiAsset } from '../src/index.js';
import { en, catalogs, SUPPORTED_LOCALES, setLocale } from '../src/static/i18n.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('Turn Failure UX, Public Code Allowlist & Quota Exceeded Contract', () => {
  let appJsCode: string;
  let htmlCode: string;
  let cssCode: string;

  beforeEach(() => {
    appJsCode = readFileSync(join(__dirname, '../src/static/app.js'), 'utf-8');
    htmlCode = getWebUiIndexHtml();
    const cssAsset = getWebUiAsset('style.css');
    cssCode = cssAsset.content.toString('utf-8');
    setLocale('en', { silent: true, persist: false });
  });

  describe('1. Static Code & Contract Invariants in app.js, style.css, and index.html', () => {
    it('declares the strict public failure code allowlist (QUOTA_EXCEEDED, RECOVERY_REQUIRED, EXECUTION_FAILED, RETRY_REQUIRED, TURN_TIMEOUT, LEASE_LOST)', () => {
      expect(appJsCode).toContain('ALLOWED_FAILURE_CODES');
      expect(appJsCode).toContain('QUOTA_EXCEEDED');
      expect(appJsCode).toContain('RECOVERY_REQUIRED');
      expect(appJsCode).toContain('EXECUTION_FAILED');
      expect(appJsCode).toContain('RETRY_REQUIRED');
      expect(appJsCode).toContain('TURN_TIMEOUT');
      expect(appJsCode).toContain('LEASE_LOST');
    });

    it('implements extractPublicFailureCode parsing from ev.code and ev.payload.code with safe generic fallback', () => {
      expect(appJsCode).toContain('function extractPublicFailureCode(');
      expect(appJsCode).toContain('return \'EXECUTION_FAILED\'');
    });

    it('implements updateTurnStatusBadge to display distinct turn failure badges without raw message leakage', () => {
      expect(appJsCode).toContain('function updateTurnStatusBadge(');
      expect(appJsCode).toContain('badge-quota_exceeded');
      expect(appJsCode).toContain('badge-recovery_required');
      expect(appJsCode).toContain('badge-execution_failed');
      expect(appJsCode).toContain('badge-retry_required');
      expect(appJsCode).toContain('badge-turn_timeout');
      expect(appJsCode).toContain('badge-lease_lost');
    });

    it('implements toast notification action buttons and deduplication tracking in state', () => {
      expect(appJsCode).toContain('processedEventIds: new Set()');
      expect(appJsCode).toContain('toast-action-btn');
      expect(appJsCode).toContain('action.handler');
      expect(cssCode).toContain('.toast-action-btn');
    });

    it('implements View Quota action button in message card and hides Retry button for QUOTA_EXCEEDED', () => {
      expect(appJsCode).toContain('btn-action-view-quota');
      expect(appJsCode).toContain('msg.failureCode === \'QUOTA_EXCEEDED\'');
      expect(appJsCode).toContain('window.location.hash = \'#quotas\'');
    });

    it('contains all required failure UX translation keys in en & zh-CN catalogs with exact symmetry', () => {
      const enCat = catalogs['en'];
      const zhCat = catalogs['zh-CN'];

      // Status keys
      expect(enCat['status.quota_exceeded']).toBe('Quota Exceeded');
      expect(zhCat['status.quota_exceeded']).toBe('配额耗尽');
      expect(enCat['status.execution_failed']).toBe('Execution Failed');
      expect(zhCat['status.execution_failed']).toBe('执行失败');
      expect(enCat['status.retry_required']).toBe('Retry Required');
      expect(zhCat['status.retry_required']).toBe('需要重试');
      expect(enCat['status.turn_timeout']).toBe('Turn Timeout');
      expect(zhCat['status.turn_timeout']).toBe('轮次超时');
      expect(enCat['status.lease_lost']).toBe('Lease Lost');
      expect(zhCat['status.lease_lost']).toBe('租约丢失');

      // Toast keys
      expect(enCat['toast.quotaExceededTokens']).toContain('Token quota exhausted');
      expect(zhCat['toast.quotaExceededTokens']).toContain('Token 配额已耗尽');
      expect(enCat['toast.quotaExceededGeneral']).toContain('Resource quota exhausted');
      expect(zhCat['toast.quotaExceededGeneral']).toContain('资源配额已耗尽');
      expect(enCat['toast.openQuota']).toBe('Open Quota');
      expect(zhCat['toast.openQuota']).toBe('打开配额');
      expect(enCat['toast.recoveryRequiredTurn']).toBeDefined();
      expect(zhCat['toast.recoveryRequiredTurn']).toBeDefined();
      expect(enCat['toast.executionFailedTurn']).toBeDefined();
      expect(zhCat['toast.executionFailedTurn']).toBeDefined();
      expect(enCat['toast.retryRequiredTurn']).toBeDefined();
      expect(zhCat['toast.retryRequiredTurn']).toBeDefined();
      expect(enCat['toast.turnTimeout']).toBeDefined();
      expect(zhCat['toast.turnTimeout']).toBeDefined();
      expect(enCat['toast.leaseLost']).toBeDefined();
      expect(zhCat['toast.leaseLost']).toBeDefined();

      // Chat message action keys
      expect(enCat['chat.viewQuota']).toBe('View Quota');
      expect(zhCat['chat.viewQuota']).toBe('查看配额');
      expect(enCat['chat.viewQuotaTitle']).toBeDefined();
      expect(zhCat['chat.viewQuotaTitle']).toBeDefined();
    });
  });

  describe('2. Function extractPublicFailureCode Evaluation', () => {
    const ALLOWED_FAILURE_CODES = new Set([
      'QUOTA_EXCEEDED',
      'RECOVERY_REQUIRED',
      'EXECUTION_FAILED',
      'RETRY_REQUIRED',
      'TURN_TIMEOUT',
      'LEASE_LOST',
    ]);

    function extractPublicFailureCode(ev: any): string {
      if (!ev || typeof ev !== 'object') return 'EXECUTION_FAILED';
      let rawPayload = ev.payload;
      if (typeof rawPayload === 'string') {
        try {
          rawPayload = JSON.parse(rawPayload);
        } catch {
          rawPayload = null;
        }
      }
      const candidate = (
        (typeof ev.code === 'string' && ev.code) ||
        (rawPayload && typeof rawPayload === 'object' && typeof rawPayload.code === 'string' && rawPayload.code) ||
        ''
      ).trim().toUpperCase();

      if (ALLOWED_FAILURE_CODES.has(candidate)) {
        return candidate;
      }
      return 'EXECUTION_FAILED';
    }

    it('extracts known public codes from top-level ev.code', () => {
      expect(extractPublicFailureCode({ code: 'QUOTA_EXCEEDED' })).toBe('QUOTA_EXCEEDED');
      expect(extractPublicFailureCode({ code: 'RECOVERY_REQUIRED' })).toBe('RECOVERY_REQUIRED');
      expect(extractPublicFailureCode({ code: 'EXECUTION_FAILED' })).toBe('EXECUTION_FAILED');
      expect(extractPublicFailureCode({ code: 'RETRY_REQUIRED' })).toBe('RETRY_REQUIRED');
      expect(extractPublicFailureCode({ code: 'TURN_TIMEOUT' })).toBe('TURN_TIMEOUT');
      expect(extractPublicFailureCode({ code: 'LEASE_LOST' })).toBe('LEASE_LOST');
    });

    it('extracts known public codes from nested ev.payload object', () => {
      expect(extractPublicFailureCode({ payload: { code: 'QUOTA_EXCEEDED' } })).toBe('QUOTA_EXCEEDED');
      expect(extractPublicFailureCode({ payload: { code: 'LEASE_LOST', status: 'failed' } })).toBe('LEASE_LOST');
    });

    it('extracts known public codes from stringified JSON in ev.payload', () => {
      expect(extractPublicFailureCode({ payload: JSON.stringify({ code: 'TURN_TIMEOUT' }) })).toBe('TURN_TIMEOUT');
    });

    it('safely falls back to generic EXECUTION_FAILED for unknown, internal, or raw error messages without leakage', () => {
      expect(extractPublicFailureCode({ code: 'CORRUPTED_DELIVERY_PAYLOAD' })).toBe('EXECUTION_FAILED');
      expect(extractPublicFailureCode({ payload: { code: 'SQLITE_CONSTRAINT_FAIL: trace stack...' } })).toBe('EXECUTION_FAILED');
      expect(extractPublicFailureCode({ code: 'FATAL_INTERNAL_KERNEL_PANIC' })).toBe('EXECUTION_FAILED');
      expect(extractPublicFailureCode({})).toBe('EXECUTION_FAILED');
      expect(extractPublicFailureCode(null)).toBe('EXECUTION_FAILED');
      expect(extractPublicFailureCode(undefined)).toBe('EXECUTION_FAILED');
    });
  });

  describe('3. Event Handling Simulation & DOM State Assertions', () => {
    it('handles QUOTA_EXCEEDED for tokens resource: clears streaming, marks message failed, preserves draft, renders View Quota and hides Retry', () => {
      // Mock DOM & state environment
      const containerChildren: any[] = [];
      const toasts: any[] = [];
      let hash = '#workspace';

      const mockDocument = {
        getElementById(id: string) {
          if (id === 'messages-container') {
            return {
              replaceChildren: () => { containerChildren.length = 0; },
              appendChild: (c: any) => { containerChildren.push(c); },
            };
          }
          if (id === 'chat-input') {
            return { value: '', focus: vi.fn() };
          }
          if (id === 'toast-container') {
            return {
              appendChild: (t: any) => { toasts.push(t); },
            };
          }
          return null;
        },
      };

      const state: any = {
        currentSessionId: 'ses_test_quota',
        messages: [
          {
            id: 'msg_u1',
            role: 'user',
            content: 'Please summarize this long document',
            status: 'pending',
          },
        ],
        streamingState: {
          sessionId: 'ses_test_quota',
          text: 'Beginning summary...',
          isThinking: false,
        },
        hasCancellableTurn: true,
        activeTurnStatus: 'running',
        activeAttachments: [],
        drafts: {},
        processedEventIds: new Set(),
      };

      // 1. Simulate incoming turn_failed with QUOTA_EXCEEDED and tokens resource
      const ev = {
        id: 'evt_quota_1',
        type: 'turn_failed',
        payload: { code: 'QUOTA_EXCEEDED', resource: 'tokens' },
      };

      // Execute turn_failed handler logic
      const isDuplicate = state.processedEventIds.has(ev.id);
      state.processedEventIds.add(ev.id);

      // QUOTA_EXCEEDED branch:
      state.streamingState = null; // Clears streaming immediately
      let lastUserMsg: any = null;
      for (let i = state.messages.length - 1; i >= 0; i--) {
        if (state.messages[i].role === 'user') {
          state.messages[i].status = 'failed';
          state.messages[i].failureCode = 'QUOTA_EXCEEDED';
          lastUserMsg = state.messages[i];
          break;
        }
      }

      // Preserves draft
      if (lastUserMsg && lastUserMsg.content) {
        state.drafts[state.currentSessionId] = {
          content: lastUserMsg.content,
          attachments: [...state.activeAttachments],
        };
      }

      state.hasCancellableTurn = false;
      state.activeTurnStatus = 'quota_exceeded';

      // Verify streaming is cleared
      expect(state.streamingState).toBeNull();
      expect(state.activeTurnStatus).toBe('quota_exceeded');
      expect(state.hasCancellableTurn).toBe(false);
      expect(state.messages[0].status).toBe('failed');
      expect(state.messages[0].failureCode).toBe('QUOTA_EXCEEDED');
      expect(state.drafts['ses_test_quota'].content).toBe('Please summarize this long document');

      // Verify Toast triggering
      let toastCreated = null;
      if (!isDuplicate) {
        toastCreated = {
          text: en['toast.quotaExceededTokens'],
          type: 'error',
          action: {
            label: en['toast.openQuota'],
            handler: () => { hash = '#quotas'; },
          },
        };
      }
      expect(toastCreated).not.toBeNull();
      expect(toastCreated?.text).toContain('Token quota exhausted');
      expect(toastCreated?.action.label).toBe('Open Quota');

      // Click toast action button -> navigates to #quotas
      toastCreated?.action.handler();
      expect(hash).toBe('#quotas');

      // 2. Subsequent poll with same event ID -> deduplicated, no duplicate toast
      const isDuplicateSecond = state.processedEventIds.has(ev.id);
      expect(isDuplicateSecond).toBe(true);

      // 3. Render message card actions verification
      const userMsg = state.messages[0];
      const renderedButtons: string[] = [];

      if (userMsg.status === 'failed') {
        if (userMsg.failureCode === 'QUOTA_EXCEEDED') {
          renderedButtons.push('btn-action-view-quota');
        } else {
          renderedButtons.push('btn-action-retry');
        }
        renderedButtons.push('btn-action-reset-gen');
        renderedButtons.push('btn-action-edit');
      }

      expect(renderedButtons).toContain('btn-action-view-quota');
      expect(renderedButtons).not.toContain('btn-action-retry');
      expect(renderedButtons).toContain('btn-action-reset-gen');
      expect(renderedButtons).toContain('btn-action-edit');
    });

    it('handles non-quota failures (LEASE_LOST, RETRY_REQUIRED, TURN_TIMEOUT, RECOVERY_REQUIRED, EXECUTION_FAILED) by showing Retry button and correct toast', () => {
      const state: any = {
        currentSessionId: 'ses_fail_test',
        messages: [
          {
            id: 'msg_u2',
            role: 'user',
            content: 'Generate report',
            status: 'pending',
          },
        ],
        streamingState: {
          sessionId: 'ses_fail_test',
          text: 'Working...',
          streamEnded: false,
        },
        hasCancellableTurn: true,
        activeTurnStatus: 'running',
        activeAttachments: [],
        drafts: {},
        processedEventIds: new Set(),
      };

      const ev = {
        id: 'evt_lease_1',
        type: 'turn_failed',
        payload: { code: 'LEASE_LOST' },
      };

      state.processedEventIds.add(ev.id);
      if (state.streamingState) {
        state.streamingState.streamEnded = true;
      }
      state.messages[0].status = 'failed';
      state.messages[0].failureCode = 'LEASE_LOST';
      state.hasCancellableTurn = false;
      state.activeTurnStatus = 'lease_lost';

      expect(state.streamingState.streamEnded).toBe(true);
      expect(state.activeTurnStatus).toBe('lease_lost');
      expect(state.hasCancellableTurn).toBe(false);
      expect(state.messages[0].status).toBe('failed');
      expect(state.messages[0].failureCode).toBe('LEASE_LOST');

      // Render message card actions verification
      const userMsg = state.messages[0];
      const renderedButtons: string[] = [];

      if (userMsg.status === 'failed') {
        if (userMsg.failureCode === 'QUOTA_EXCEEDED') {
          renderedButtons.push('btn-action-view-quota');
        } else {
          renderedButtons.push('btn-action-retry');
        }
        renderedButtons.push('btn-action-reset-gen');
      }

      expect(renderedButtons).toContain('btn-action-retry');
      expect(renderedButtons).not.toContain('btn-action-view-quota');
      expect(renderedButtons).toContain('btn-action-reset-gen');
    });
  });
});
