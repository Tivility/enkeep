/**
 * User questions inside the external interaction plugin: the env gate, the enkeep-local
 * `userQuestions` service and `ask_user_question` tool, the pending record, answers,
 * expiry and cancellation. Synthetic sessions only.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Context, Service } from '@deepseek-ai/cordis';
import * as externalInteractionPlugin from '../src/index.js';
import {
  ASK_USER_QUESTION_TOOL_NAME,
  DEFAULT_QUESTION_TIMEOUT_MS,
  QUESTION_TIMEOUT_ENV,
  USER_QUESTIONS_ENV,
  formatLateQuestionAnswers,
  formatQuestionAnswers,
  formatQuestionExpired,
  normalizeAskUserQuestionInput,
  resolveQuestionTimeoutMs,
  resolveUserQuestionsEnabled,
  validateQuestionAnswers,
  type PendingQuestion,
  type QuestionSettlement,
} from '../src/user-questions.js';
import type { AskUserQuestionToolDefinition } from '../src/ask-user-question-tool.js';
import type { ExternalInteractionService } from '../src/service.js';

class FakeToolsRegistry extends Service {
  readonly tools = new Map<string, AskUserQuestionToolDefinition>();
  constructor(ctx: Context) {
    super(ctx, 'tools');
  }
  register(tool: AskUserQuestionToolDefinition) {
    this.tools.set(tool.name, tool);
    return () => this.tools.delete(tool.name);
  }
}

const SESSION = 'ses_00000000000000000000000000000071';

const QUESTIONS_ARGS = {
  questions: [
    {
      id: 'mode',
      question: 'Which deployment mode should the synthetic service use?',
      header: 'Mode',
      options: [
        { label: 'Docker (Recommended)', description: 'Isolated and reproducible.' },
        { label: 'Host' },
      ],
    },
    {
      id: 'extras',
      question: 'Which extras?',
      options: [{ label: 'Metrics' }, { label: 'Tracing' }, { label: 'Backups' }],
      multi_select: true,
    },
    { id: 'notes', question: 'Anything else to know?' },
  ],
};

function exec(signal: AbortSignal, overrides: Record<string, unknown> = {}) {
  return {
    callId: 'call_synthetic_0001',
    agent: { id: SESSION, session: { id: SESSION, meta: { source: 'web' }, header: {} } } as any,
    signal,
    ...overrides,
  };
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('user question policy', () => {
  it('gates on ENKEEP_USER_QUESTIONS=1 only (explicit config wins)', () => {
    expect(resolveUserQuestionsEnabled({ env: {} })).toBe(false);
    expect(resolveUserQuestionsEnabled({ env: { [USER_QUESTIONS_ENV]: '1' } })).toBe(true);
    expect(resolveUserQuestionsEnabled({ env: { [USER_QUESTIONS_ENV]: ' 1 ' } })).toBe(true);
    for (const off of ['0', 'true', 'yes', '']) {
      expect(resolveUserQuestionsEnabled({ env: { [USER_QUESTIONS_ENV]: off } })).toBe(false);
    }
    expect(resolveUserQuestionsEnabled({ configured: false, env: { [USER_QUESTIONS_ENV]: '1' } })).toBe(false);
    expect(resolveUserQuestionsEnabled({ configured: true, env: {} })).toBe(true);
  });

  it('resolves the question timeout: configured > ENKEEP_QUESTION_TIMEOUT_MS (1 s..24 h) > 10 min', () => {
    expect(resolveQuestionTimeoutMs()).toBe(DEFAULT_QUESTION_TIMEOUT_MS);
    expect(DEFAULT_QUESTION_TIMEOUT_MS).toBe(600_000);
    expect(resolveQuestionTimeoutMs({ env: { [QUESTION_TIMEOUT_ENV]: '120000' } })).toBe(120_000);
    for (const bad of ['999', '86400001', '2m', '-1', '']) {
      expect(resolveQuestionTimeoutMs({ env: { [QUESTION_TIMEOUT_ENV]: bad } })).toBe(600_000);
    }
    expect(resolveQuestionTimeoutMs({ configured: 5_000, env: { [QUESTION_TIMEOUT_ENV]: '120000' } })).toBe(5_000);
    expect(resolveQuestionTimeoutMs({ configured: 10 })).toBe(1_000);
  });

  it('normalizes tool input (multi_select → multiSelect) and enforces the limits', () => {
    const ok = normalizeAskUserQuestionInput(QUESTIONS_ARGS);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.value).toEqual([
      {
        id: 'mode',
        question: 'Which deployment mode should the synthetic service use?',
        header: 'Mode',
        options: [{ label: 'Docker (Recommended)', description: 'Isolated and reproducible.' }, { label: 'Host' }],
        multiSelect: false,
      },
      {
        id: 'extras',
        question: 'Which extras?',
        options: [{ label: 'Metrics' }, { label: 'Tracing' }, { label: 'Backups' }],
        multiSelect: true,
      },
      { id: 'notes', question: 'Anything else to know?', options: [], multiSelect: false },
    ]);
    expect(Object.isFrozen(ok.value[0]!.options)).toBe(true);

    const q = (i: number) => ({ id: `q${i}`, question: `Question ${i}?` });
    const fails = [
      undefined,
      {},
      { questions: [] },
      { questions: [q(1), q(2), q(3), q(4), q(5)] },
      { questions: [q(1), q(1)] },
      { questions: [{ id: 'a', question: '   ' }] },
      { questions: [{ id: 'a', question: 'x', options: Array.from({ length: 7 }, (_, i) => ({ label: `o${i}` })) }] },
      { questions: [{ id: 'a', question: 'x', options: [{ label: 'same' }, { label: 'same' }] }] },
      { questions: [{ id: 'a', question: 'x', multi_select: 'yes' }] },
    ];
    for (const input of fails) {
      expect(normalizeAskUserQuestionInput(input).ok).toBe(false);
    }
    expect(normalizeAskUserQuestionInput({ questions: [q(1), q(2), q(3), q(4)] }).ok).toBe(true);
  });

  it('validates answers against the questions asked', () => {
    const parsed = normalizeAskUserQuestionInput(QUESTIONS_ARGS);
    if (!parsed.ok) throw new Error(parsed.error);
    const questions = parsed.value;
    expect(
      validateQuestionAnswers(questions, [
        { id: 'notes', selected: [], custom: '  Synthetic note.  ' },
        { id: 'extras', selected: ['Metrics', 'Backups'] },
        { id: 'mode', selected: ['Host'] },
      ])
    ).toEqual({
      ok: true,
      value: [
        { id: 'mode', selected: ['Host'] },
        { id: 'extras', selected: ['Metrics', 'Backups'] },
        { id: 'notes', selected: [], custom: 'Synthetic note.' },
      ],
    });
    expect(validateQuestionAnswers(questions, [])).toEqual({ ok: true, value: [] });
    const invalid = [
      'Host',
      [{ id: 'unknown', selected: [] }],
      [{ id: 'mode', selected: ['Docker'] }],
      [{ id: 'mode', selected: ['Host', 'Docker (Recommended)'] }],
      [{ id: 'extras', selected: ['Metrics', 'Metrics'] }],
      [{ id: 'notes', selected: ['anything'] }],
      [{ id: 'mode', selected: 'Host' }],
      [{ id: 'mode', selected: ['Host'] }, { id: 'mode', selected: [] }],
      [{ id: 'notes', custom: 42 }],
    ];
    for (const answers of invalid) {
      expect(validateQuestionAnswers(questions, answers).ok).toBe(false);
    }
  });

  it('words answers, skips, expiry and late answers for the model', () => {
    const parsed = normalizeAskUserQuestionInput(QUESTIONS_ARGS);
    if (!parsed.ok) throw new Error(parsed.error);
    const text = formatQuestionAnswers(parsed.value, [
      { id: 'mode', selected: ['Host'], custom: 'on the synthetic box' },
      { id: 'extras', selected: [] },
    ]);
    expect(text).toBe(
      [
        'The user answered:',
        '- mode ("Which deployment mode should the synthetic service use?"): Host; in their own words: "on the synthetic box"',
        '- extras ("Which extras?"): skipped',
        '- notes ("Anything else to know?"): skipped',
      ].join('\n')
    );
    expect(formatQuestionExpired(600_000)).toContain('did not answer within 10 min');
    expect(formatQuestionExpired(45_000)).toContain('within 45 s');
    const late = formatLateQuestionAnswers(
      { questions: parsed.value, createdAt: '2026-01-01T00:00:00.000Z' },
      [{ id: 'mode', selected: ['Docker (Recommended)'] }]
    );
    expect(late).toContain('2026-01-01T00:00:00.000Z');
    expect(late).toContain('- mode ("Which deployment mode should the synthetic service use?"): Docker (Recommended)');
  });
});

describe('ask_user_question composition and lifecycle', () => {
  let ctx: Context;
  let registry: FakeToolsRegistry;
  let savedGate: string | undefined;
  let savedTimeout: string | undefined;

  beforeEach(() => {
    savedGate = process.env[USER_QUESTIONS_ENV];
    savedTimeout = process.env[QUESTION_TIMEOUT_ENV];
    delete process.env[USER_QUESTIONS_ENV];
    delete process.env[QUESTION_TIMEOUT_ENV];
    ctx = new Context();
    registry = new FakeToolsRegistry(ctx);
  });

  afterEach(() => {
    if (savedGate === undefined) delete process.env[USER_QUESTIONS_ENV];
    else process.env[USER_QUESTIONS_ENV] = savedGate;
    if (savedTimeout === undefined) delete process.env[QUESTION_TIMEOUT_ENV];
    else process.env[QUESTION_TIMEOUT_ENV] = savedTimeout;
  });

  it('adds neither the tool nor the userQuestions service without the gate', async () => {
    await ctx.plugin(externalInteractionPlugin, { defaultTimeoutMs: 60_000 });
    expect(registry.tools.has(ASK_USER_QUESTION_TOOL_NAME)).toBe(false);
    expect(ctx.get('userQuestions')).toBeUndefined();
    expect(ctx.get('externalInteraction')).toBeDefined();
  });

  it('composes both with ENKEEP_USER_QUESTIONS=1 and removes them on dispose', async () => {
    process.env[USER_QUESTIONS_ENV] = '1';
    const fiber = await ctx.plugin(externalInteractionPlugin, { defaultTimeoutMs: 60_000 });
    const tool = registry.tools.get(ASK_USER_QUESTION_TOOL_NAME);
    expect(tool).toBeDefined();
    expect(tool!.description).toMatch(/sparingly/);
    expect(tool!.parameters.required).toEqual(['questions']);
    expect(ctx.get('userQuestions')).toBeDefined();
    expect((ctx.get('externalInteraction') as unknown as ExternalInteractionService).questionTimeoutMs).toBe(600_000);
    await fiber.dispose();
    expect(registry.tools.has(ASK_USER_QUESTION_TOOL_NAME)).toBe(false);
  });

  it('holds the question with a full record, answers the tool call, and settles once', async () => {
    await ctx.plugin(externalInteractionPlugin, { userQuestions: true, questionTimeoutMs: 120_000 });
    const service = ctx.get('externalInteraction') as unknown as ExternalInteractionService;
    const tool = registry.tools.get(ASK_USER_QUESTION_TOOL_NAME)!;
    const asked: PendingQuestion[] = [];
    const settled: QuestionSettlement[] = [];
    service.onQuestionAsked((q) => asked.push(q));
    service.onQuestionSettled((s) => settled.push(s));

    const controller = new AbortController();
    const call = tool.execute(QUESTIONS_ARGS, exec(controller.signal));
    const pending = await waitFor(() => service.listPendingQuestions()[0]);

    expect(pending).toMatchObject({
      id: 'call_synthetic_0001',
      sessionId: SESSION,
      callId: 'call_synthetic_0001',
      sessionSource: 'web',
      timeoutMs: 120_000,
      status: 'pending',
    });
    expect(pending.plan).toBeUndefined();
    expect(pending.questions.map((q) => [q.id, q.multiSelect, q.options.length])).toEqual([
      ['mode', false, 2],
      ['extras', true, 3],
      ['notes', false, 0],
    ]);
    expect(Date.parse(pending.expiresAt) - Date.parse(pending.createdAt)).toBe(120_000);
    expect(asked).toEqual([pending]);
    expect(service.listPendingQuestions({ sessionId: 'ses_00000000000000000000000000000072' })).toEqual([]);

    expect(service.tryAnswerQuestion(pending.id, [{ id: 'mode', selected: ['Nope'] }])).toMatchObject({
      ok: false,
      code: 'invalid-answers',
    });
    const answers = [
      { id: 'mode', selected: ['Docker (Recommended)'] },
      { id: 'notes', selected: [], custom: 'Synthetic constraint.' },
    ];
    const attempt = service.tryAnswerQuestion(pending.id, answers);
    expect(attempt).toMatchObject({ ok: true, answers });

    const result = await call;
    expect(result).toEqual({ questionId: pending.id, outcome: 'answered', answers });
    const [block] = tool.output.render(QUESTIONS_ARGS, result);
    expect((block as any).text).toContain('Docker (Recommended)');
    expect((block as any).text).toContain('in their own words: "Synthetic constraint."');
    expect((block as any).text).toContain('- extras ("Which extras?"): skipped');

    expect(settled).toEqual([
      expect.objectContaining({ id: pending.id, sessionId: SESSION, outcome: 'answered', answers }),
    ]);
    expect(service.listPendingQuestions()).toEqual([]);
    expect(service.tryAnswerQuestion(pending.id, answers)).toMatchObject({ ok: false, code: 'already-settled' });
    expect(service.tryAnswerQuestion('q_unknown', answers)).toMatchObject({ ok: false, code: 'not-found' });
    expect(service.getQuestion(pending.id)).toMatchObject({ status: 'answered', answers });

    // The tool call id is taken: the next question with the same call id gets a fresh id.
    const again = tool.execute(QUESTIONS_ARGS, exec(controller.signal));
    const second = await waitFor(() => service.listPendingQuestions()[0]);
    expect(second.id).toMatch(/^q_[0-9a-f]{32}$/);
    expect(second.callId).toBe('call_synthetic_0001');
    service.answerQuestion(second.id, []);
    await expect(again).resolves.toMatchObject({ outcome: 'answered', answers: [] });
  });

  it('expires after the question timeout and tells the model', async () => {
    process.env[QUESTION_TIMEOUT_ENV] = '1000';
    await ctx.plugin(externalInteractionPlugin, { userQuestions: true });
    const service = ctx.get('externalInteraction') as unknown as ExternalInteractionService;
    const tool = registry.tools.get(ASK_USER_QUESTION_TOOL_NAME)!;
    const settled: QuestionSettlement[] = [];
    service.onQuestionSettled((s) => settled.push(s));

    const result = await tool.execute({ questions: [{ id: 'q1', question: 'Proceed?' }] }, exec(new AbortController().signal));
    expect(result).toMatchObject({ outcome: 'expired', waitedMs: 1_000 });
    expect((tool.output.render({}, result)[0] as any).text).toContain('did not answer within 1 s');
    expect(settled).toEqual([expect.objectContaining({ outcome: 'expired', sessionId: SESSION })]);
    expect(service.tryAnswerQuestion(settled[0]!.id, [{ id: 'q1', selected: [], custom: 'late' }])).toMatchObject({
      ok: false,
      code: 'expired',
      question: expect.objectContaining({ status: 'expired', sessionId: SESSION }),
    });
  });

  it('settles cancelled when the tool call is aborted, and refuses subagent sessions', async () => {
    await ctx.plugin(externalInteractionPlugin, { userQuestions: true });
    const service = ctx.get('externalInteraction') as unknown as ExternalInteractionService;
    const tool = registry.tools.get(ASK_USER_QUESTION_TOOL_NAME)!;
    const settled: QuestionSettlement[] = [];
    service.onQuestionSettled((s) => settled.push(s));

    const controller = new AbortController();
    const call = tool.execute({ questions: [{ id: 'q1', question: 'Proceed?' }] }, exec(controller.signal));
    const pending = await waitFor(() => service.listPendingQuestions()[0]);
    controller.abort(new Error('turn interrupted'));
    await expect(call).rejects.toMatchObject({ name: 'AbortError' });
    expect(settled).toEqual([expect.objectContaining({ id: pending.id, outcome: 'cancelled' })]);
    expect(service.listPendingQuestions()).toEqual([]);

    const child = exec(new AbortController().signal, {
      agent: { session: { id: 'ses_00000000000000000000000000000073', header: { parentSession: SESSION } } },
    });
    await expect(tool.execute({ questions: [{ id: 'q1', question: 'Proceed?' }] }, child)).rejects.toThrow(/main agent/);
    await expect(tool.execute({ questions: [] }, exec(new AbortController().signal))).rejects.toThrow(/Invalid/);
    expect(service.listPendingQuestions()).toEqual([]);
  });

  it('cancels pending questions when the plugin is disposed', async () => {
    const fiber = await ctx.plugin(externalInteractionPlugin, { userQuestions: true });
    const service = ctx.get('externalInteraction') as unknown as ExternalInteractionService;
    const tool = registry.tools.get(ASK_USER_QUESTION_TOOL_NAME)!;
    const call = tool.execute({ questions: [{ id: 'q1', question: 'Proceed?' }] }, exec(new AbortController().signal));
    await waitFor(() => service.listPendingQuestions()[0]);
    await fiber.dispose();
    await expect(call).rejects.toMatchObject({ name: 'AbortError' });
  });
});
