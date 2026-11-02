/**
 * ask_user_question in the Web UI (synthetic, static checks): pending questions are fetched with
 * the approvals, shown as cards in the approvals modal (options as radio buttons or checkboxes
 * plus free text) and answered through POST /api/interactions/questions/:id/answer.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { en, zhCN } from '../src/static/i18n.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appJsCode = readFileSync(join(__dirname, '../src/static/app.js'), 'utf-8');

function extract(name: string): string {
  const match = appJsCode.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
  expect(match).not.toBeNull();
  return match![0];
}

describe('user questions in the Web UI', () => {
  it('builds answers from the chosen options and the user\'s own words', () => {
    const build = new Function(`${extract('buildQuestionAnswers')}\nreturn buildQuestionAnswers;`)() as (q: unknown, c: unknown) => unknown;
    const question = {
      id: 'call_test_ui_q1',
      questions: [
        { id: 'mode', question: 'Which mode?', options: [{ label: 'Docker' }, { label: 'Host' }], multiSelect: false },
        { id: 'extras', question: 'Which extras?', options: [{ label: 'Metrics' }, { label: 'Tracing' }], multiSelect: true },
        { id: 'notes', question: 'Anything else?', options: [], multiSelect: false },
        { id: 'skipped', question: 'Skipped?', options: [{ label: 'Yes' }], multiSelect: false },
      ],
    };
    expect(
      build(question, {
        mode: { selected: ['Host', 'Docker'], custom: '' },
        extras: { selected: ['Tracing', 'Unknown', 'Metrics'], custom: '  ' },
        notes: { selected: [], custom: '  synthetic words ' },
        skipped: { selected: [], custom: '' },
      })
    ).toEqual([
      { id: 'mode', selected: ['Host'] },
      { id: 'extras', selected: ['Tracing', 'Metrics'] },
      { id: 'notes', selected: [], custom: 'synthetic words' },
    ]);
    expect(build(question, {})).toEqual([]);
  });

  it('fetches, renders and answers questions next to the approvals', () => {
    expect(appJsCode).toContain('apiRequest(`/api/interactions/questions${query}`)');
    expect(appJsCode).toContain('apiRequest(`/api/interactions/questions/${encodeURIComponent(questionId)}/answer`, {');
    expect(appJsCode).toContain('body: { answers },');
    const render = extract('renderQuestionCard');
    expect(render).toContain("input.type = q.multiSelect ? 'checkbox' : 'radio';");
    expect(render).toContain("document.createElement('textarea')");
    expect(extract('renderApprovalsList')).toContain('renderQuestionCard(q, container)');
    // Polled with the approvals, so the header button and the turn badge count both.
    expect(appJsCode).toMatch(/await fetchPendingQuestions\(sessionId\);\n\s*await fetchPendingApprovals\(sessionId\);/);
    expect(extract('updateTurnStatusBadge')).toContain("t('approvals.questionWaitingBadge', null, 'Waiting for your answer')");
  });

  it('has the question strings in both catalogs', () => {
    for (const key of [
      'approvals.questionAnswerSuccess',
      'approvals.questionBtnSubmit',
      'approvals.questionCardTitle',
      'approvals.questionCustomPlaceholder',
      'approvals.questionExpiresAt',
      'approvals.questionsPendingCount',
      'approvals.questionWaitingBadge',
    ]) {
      expect((en as Record<string, string>)[key]).toBeTruthy();
      expect((zhCN as Record<string, string>)[key]).toBeTruthy();
    }
  });
});
