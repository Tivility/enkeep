import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { en, zhCN } from '../src/static/i18n.js';

describe('Management Tasks UI: Schedule Type, Runs History, Pause/Resume & i18n', () => {
  let htmlContent: string;
  let jsContent: string;

  beforeEach(() => {
    htmlContent = readFileSync(resolve(__dirname, '../src/static/index.html'), 'utf-8');
    jsContent = readFileSync(resolve(__dirname, '../src/static/app.js'), 'utf-8');
  });

  describe('1. HTML Markup & Modal Elements', () => {
    it('includes dedicated task runs history modal with accessible aria attributes', () => {
      expect(htmlContent).toContain('id="modal-task-runs"');
      expect(htmlContent).toContain('role="dialog"');
      expect(htmlContent).toContain('aria-modal="true"');
      expect(htmlContent).toContain('aria-labelledby="task-runs-modal-title"');
      expect(htmlContent).toContain('id="task-runs-modal-title"');
      expect(htmlContent).toContain('id="task-runs-content"');
      expect(htmlContent).toContain('data-close="modal-task-runs"');
    });
  });

  describe('2. JavaScript App Task View Logic', () => {
    it('contains schedule type selector and dynamic parameter view handler', () => {
      expect(jsContent).toContain('task-schedule-type-select');
      expect(jsContent).toContain('task-dynamic-param-group');
      expect(jsContent).toContain('task-due-date-input');
      expect(jsContent).toContain('task-cron-input');
      expect(jsContent).toContain('task-interval-input');
      expect(jsContent).toContain('updateDynamicParamView');
    });

    it('contains pause and resume action buttons and API integration', () => {
      expect(jsContent).toContain('/pause');
      expect(jsContent).toContain('/resume');
      expect(jsContent).toContain('tasks.btnPause');
      expect(jsContent).toContain('tasks.btnResume');
    });

    it('contains runs history modal trigger and rendering function', () => {
      expect(jsContent).toContain('function showTaskRunsModal(');
      expect(jsContent).toContain('/runs');
      expect(jsContent).toContain('tasks.colAttempt');
      expect(jsContent).toContain('tasks.colTokens');
      expect(jsContent).toContain('tasks.colErrorCode');
    });

    it('guarantees zero inline style assignments', () => {
      expect(jsContent).not.toMatch(/style\s*=/i);
      expect(jsContent).not.toContain('.style.');
      expect(jsContent).not.toContain('.style =');
    });

    it('guarantees app lacks ap.reason and strictly renders validated safeSummary or localized generic', () => {
      expect(jsContent).not.toContain('ap.reason');
      expect(jsContent).toContain('safeSummary');
      expect(jsContent).toContain('approvals.genericSummary');
    });

    it('guarantees notifications webhook test logic lacks statusText and durationMs and uses responseTimeMs and statusCode', () => {
      const webhookTestFunc = jsContent.match(/btnTestWebhook\.addEventListener\('click'[\s\S]*?finally\s*\{/)?.[0] || '';
      expect(webhookTestFunc.length).toBeGreaterThan(0);
      expect(webhookTestFunc).not.toContain('statusText');
      expect(webhookTestFunc).not.toContain('durationMs');
      expect(webhookTestFunc).toContain('responseTimeMs');
      expect(webhookTestFunc).toContain('statusCode');
      expect(webhookTestFunc).not.toContain('err.message');
    });

    it('guarantees webhook test failure maps fixed errorCodes to i18n keys without leaking raw error/message/body', () => {
      expect(jsContent).toContain('getWebhookErrorMessage');
      expect(jsContent).toContain('WEBHOOK_HTTP_ERROR');
      expect(jsContent).toContain('WEBHOOK_NETWORK');
      expect(jsContent).toContain('WEBHOOK_TIMEOUT');
      expect(jsContent).toContain('WEBHOOK_POLICY_REJECTED');
      expect(jsContent).toContain('WEBHOOK_CIPHER_ERROR');
      expect(jsContent).toContain('notifications.errorWebhookHttp');
      expect(jsContent).toContain('notifications.errorWebhookNetwork');
      expect(jsContent).toContain('notifications.errorWebhookTimeout');
      expect(jsContent).toContain('notifications.errorWebhookPolicyRejected');
      expect(jsContent).toContain('notifications.errorWebhookCipher');
      expect(jsContent).toContain('notifications.errorWebhookUnknown');
    });

    it('guarantees strict risk level handling and zero dynamic fallback for approval badges', () => {
      expect(jsContent).toContain('approvals.riskLow');
      expect(jsContent).toContain('approvals.riskMedium');
      expect(jsContent).toContain('approvals.riskHigh');
      expect(jsContent).toContain('approvals.riskCritical');
      expect(jsContent).toContain('approvals.riskUnknown');
    });
  });

  describe('3. Bilingual i18n Dictionary Support (EN and ZH-CN)', () => {
    const requiredTaskKeys = [
      'tasks.title',
      'tasks.subtitle',
      'tasks.btnSchedule',
      'tasks.btnRunNow',
      'tasks.btnPause',
      'tasks.btnResume',
      'tasks.btnRunsHistory',
      'tasks.btnCancel',
      'tasks.formScheduleType',
      'tasks.typeOnce',
      'tasks.typeCron',
      'tasks.typeInterval',
      'tasks.formCron',
      'tasks.formInterval',
      'tasks.formDueDate',
      'tasks.formPriority',
      'tasks.formPrompt',
      'tasks.formTitle',
      'tasks.colTitle',
      'tasks.colScheduleType',
      'tasks.colPriority',
      'tasks.colStatus',
      'tasks.colNextRun',
      'tasks.colCreatedAt',
      'tasks.colActions',
      'tasks.runsModalTitle',
      'tasks.runsEmptyTitle',
      'tasks.runsEmptyDesc',
      'tasks.colAttempt',
      'tasks.colScheduledFor',
      'tasks.colStartedAt',
      'tasks.colCompletedAt',
      'tasks.colTurnId',
      'tasks.colTokens',
      'tasks.colErrorCode',
      'tasks.statusPaused',
      'tasks.statusActive',
      'notifications.errorWebhookHttp',
      'notifications.errorWebhookNetwork',
      'notifications.errorWebhookTimeout',
      'notifications.errorWebhookPolicyRejected',
      'notifications.errorWebhookCipher',
      'notifications.errorWebhookUnknown',
      'notifications.testSuccess',
      'notifications.testFailed',
      'notifications.testSuccessToast',
      'approvals.genericSummary',
      'approvals.riskLow',
      'approvals.riskMedium',
      'approvals.riskHigh',
      'approvals.riskCritical',
      'approvals.riskUnknown',
    ];

    it('provides all task scheduler and run history keys in English catalog', () => {
      for (const k of requiredTaskKeys) {
        expect(en[k as keyof typeof en]).toBeDefined();
        expect(typeof en[k as keyof typeof en]).toBe('string');
        expect(en[k as keyof typeof en].length).toBeGreaterThan(0);
      }
    });

    it('provides all task scheduler and run history keys in Chinese (zh-CN) catalog', () => {
      for (const k of requiredTaskKeys) {
        expect(zhCN[k as keyof typeof zhCN]).toBeDefined();
        expect(typeof zhCN[k as keyof typeof zhCN]).toBe('string');
        expect(zhCN[k as keyof typeof zhCN].length).toBeGreaterThan(0);
      }
    });
  });
});
