/**
 * Lark (Feishu) cards for `ask_user_question` questions: the question card (one-click buttons for
 * a single single-select question, a form otherwise), its settled states, and the mapping from a
 * `card.action.trigger` callback (button value / form_value) back to question answers.
 *
 * Option values on the card are option indices ("0", "1", …); they are mapped back to the
 * offered labels here, so long or unusual labels never travel through the callback.
 *
 * @module @enkeep/channel-lark/question-card
 */

/** Card action type carried by every question card control. */
export const QUESTION_CARD_ACTION = 'answer_question';

const RECOMMENDED_SUFFIX = /\s*\(recommended\)\s*$/i;
const MAX_INPUT_LENGTH = 1000;

/** One option of a question (as the runtime normalized it). */
export interface LarkQuestionOptionView {
  readonly label: string;
  readonly description?: string;
}

/** One question of an `ask_user_question` call. */
export interface LarkQuestionItemView {
  readonly id: string;
  readonly question: string;
  readonly header?: string;
  readonly options: readonly LarkQuestionOptionView[];
  readonly multiSelect: boolean;
}

/** The pending question set a card is built for. */
export interface LarkQuestionView {
  /** Bridge question id (the tool call id when usable). */
  readonly id: string;
  /** Platform session route id. */
  readonly sessionId: string;
  readonly turnId?: string;
  readonly questions: readonly LarkQuestionItemView[];
  readonly timeoutMs: number;
}

/** An answer to one question (the platform `QuestionAnswer` shape). */
export interface LarkQuestionAnswer {
  readonly id: string;
  readonly selected: string[];
  readonly custom?: string;
}

/** How a settled card reads. */
export type LarkQuestionCardState =
  | { readonly kind: 'answered'; readonly answers: readonly LarkQuestionAnswer[]; readonly via?: string }
  | { readonly kind: 'expired' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unavailable' };

/** Callback payload put on the card's controls. */
export interface QuestionCardActionValue {
  readonly action: typeof QUESTION_CARD_ACTION;
  readonly qid: string;
  readonly sessionId: string;
  readonly turnId?: string;
  /** Open id of the user the question is addressed to (the sender of the asking turn). */
  readonly sid?: string;
  /** Option index of a one-click button. */
  readonly opt?: string;
}

/** Whether an option label carries the model's "(Recommended)" marker. */
export function isRecommendedOption(label: string): boolean {
  return RECOMMENDED_SUFFIX.test(label);
}

/** The label as shown to the user: "(Recommended)" becomes "（推荐）". */
export function displayOptionLabel(label: string): string {
  return isRecommendedOption(label) ? `${label.replace(RECOMMENDED_SUFFIX, '')}（推荐）` : label;
}

/** Whether a question set gets one-click buttons (exactly one single-select question with options). */
export function usesButtonLayout(view: Pick<LarkQuestionView, 'questions'>): boolean {
  return view.questions.length === 1 && view.questions[0].options.length > 0 && !view.questions[0].multiSelect;
}

/** "10 分钟" / "45 秒" / "1 小时 30 分钟". */
export function formatWaitZh(ms: number): string {
  const totalSec = Math.max(1, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec} 秒`;
  const totalMin = Math.round(totalSec / 60);
  if (totalMin < 60) return `${totalMin} 分钟`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

function plain(content: string): { tag: 'plain_text'; content: string } {
  return { tag: 'plain_text', content };
}

/** Escapes characters Lark markdown would interpret, so model text is shown as written. */
function escapeMd(text: string): string {
  return text.replace(/([\\*_~`[\]<>])/g, '\\$1');
}

function cardTitle(view: Pick<LarkQuestionView, 'questions'>): string {
  const header = view.questions.length === 1 ? view.questions[0].header?.trim() : undefined;
  return header && header.length > 0 ? header : '需要你确认';
}

function questionHeading(q: LarkQuestionItemView, index: number, total: number): string {
  const prefix = total > 1 ? `${index + 1}. ` : '';
  const header = total > 1 && q.header?.trim() ? `${escapeMd(q.header.trim())}：` : '';
  const multi = q.multiSelect ? '（可多选）' : '';
  return `**${prefix}${header}${escapeMd(q.question)}**${multi}`;
}

function optionDescriptions(q: LarkQuestionItemView): string | null {
  const lines = q.options
    .filter((o) => typeof o.description === 'string' && o.description.trim().length > 0)
    .map((o) => `- ${escapeMd(displayOptionLabel(o.label))}：${escapeMd((o.description as string).trim())}`);
  return lines.length > 0 ? `<font color='grey'>${lines.join('\n')}</font>` : null;
}

function baseValue(view: LarkQuestionView, senderId?: string): QuestionCardActionValue {
  return {
    action: QUESTION_CARD_ACTION,
    qid: view.id,
    sessionId: view.sessionId,
    ...(view.turnId ? { turnId: view.turnId } : {}),
    ...(senderId ? { sid: senderId } : {}),
  };
}

function footer(view: LarkQuestionView): Record<string, unknown> {
  return {
    tag: 'markdown',
    content: `<font color='grey'>也可以直接在话题里打字回复 · ${formatWaitZh(view.timeoutMs)}内有效，超时后按推荐继续</font>`,
  };
}

function wrapCard(title: string, template: string, elements: Record<string, unknown>[]): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: title } },
    header: { title: plain(title), template },
    body: { elements },
  };
}

/**
 * The question card. A single single-select question gets one button per option (one click
 * answers); anything else is a form with a dropdown per question, an optional free-text input per
 * question and one submit button.
 */
export function buildQuestionCard(view: LarkQuestionView, options: { senderId?: string } = {}): Record<string, unknown> {
  const value = baseValue(view, options.senderId);
  const elements: Record<string, unknown>[] = [];
  const total = view.questions.length;

  if (usesButtonLayout(view)) {
    const q = view.questions[0];
    elements.push({ tag: 'markdown', content: `**${escapeMd(q.question)}**` });
    const desc = optionDescriptions(q);
    if (desc) elements.push({ tag: 'markdown', content: desc });
    q.options.forEach((option, index) => {
      elements.push({
        tag: 'button',
        element_id: `q_opt_${index}`,
        text: plain(displayOptionLabel(option.label)),
        type: isRecommendedOption(option.label) ? 'primary_filled' : 'default',
        width: 'fill',
        behaviors: [{ type: 'callback', value: { ...value, opt: String(index) } }],
      });
    });
    elements.push(footer(view));
    return wrapCard(cardTitle(view), 'orange', elements);
  }

  const formElements: Record<string, unknown>[] = [];
  view.questions.forEach((q, index) => {
    formElements.push({ tag: 'markdown', content: questionHeading(q, index, total) });
    const desc = optionDescriptions(q);
    if (desc) formElements.push({ tag: 'markdown', content: desc });
    if (q.options.length > 0) {
      formElements.push({
        tag: q.multiSelect ? 'multi_select_static' : 'select_static',
        name: `q${index}_sel`,
        placeholder: plain(q.multiSelect ? '选择一项或多项' : '选择一项'),
        width: 'fill',
        options: q.options.map((option, optIndex) => ({
          text: plain(displayOptionLabel(option.label)),
          value: String(optIndex),
        })),
      });
    }
    formElements.push({
      tag: 'input',
      name: `q${index}_txt`,
      placeholder: plain(q.options.length > 0 ? '可选：用自己的话补充' : '在这里回答'),
      input_type: 'multiline_text',
      rows: 2,
      max_length: MAX_INPUT_LENGTH,
      width: 'fill',
    });
  });
  formElements.push({
    tag: 'button',
    name: 'q_submit',
    text: plain('提交'),
    type: 'primary_filled',
    form_action_type: 'submit',
    behaviors: [{ type: 'callback', value }],
  });
  elements.push({ tag: 'form', name: 'q_form', elements: formElements });
  elements.push(footer(view));
  return wrapCard(cardTitle(view), 'orange', elements);
}

function answerSummary(view: Pick<LarkQuestionView, 'questions'>, answers: readonly LarkQuestionAnswer[]): string {
  const byId = new Map(answers.map((a) => [a.id, a] as const));
  return view.questions
    .map((q, index) => {
      const a = byId.get(q.id);
      const parts: string[] = [];
      if (a && a.selected.length > 0) parts.push(a.selected.map(displayOptionLabel).join('、'));
      if (a?.custom) parts.push(`「${a.custom.length > 200 ? `${a.custom.slice(0, 199)}…` : a.custom}」`);
      const reply = parts.length > 0 ? parts.join(' ') : '（未回答）';
      const name = q.header?.trim() || (view.questions.length > 1 ? `第 ${index + 1} 题` : q.question);
      return `- ${escapeMd(name)} → ${escapeMd(reply)}`;
    })
    .join('\n');
}

const VIA_LABELS: Record<string, string> = {
  web: 'Web 端',
  jarvis: 'Jarvis',
  'lark-text': '话题里的文字回复',
  'wechat-text': '微信回复',
};

/** The settled card: no controls, one line on how the question ended. */
export function buildSettledQuestionCard(view: LarkQuestionView, state: LarkQuestionCardState): Record<string, unknown> {
  const title = cardTitle(view);
  const questionsMd = view.questions.map((q, i) => questionHeading(q, i, view.questions.length)).join('\n');
  switch (state.kind) {
    case 'answered': {
      const via = state.via && VIA_LABELS[state.via] ? `（来自${VIA_LABELS[state.via]}）` : '';
      return wrapCard(`${title} · 已回答`, 'green', [
        { tag: 'markdown', content: questionsMd },
        { tag: 'markdown', content: `**已回答${via}**\n${answerSummary(view, state.answers)}` },
      ]);
    }
    case 'expired':
      return wrapCard(`${title} · 已超时`, 'grey', [
        { tag: 'markdown', content: questionsMd },
        { tag: 'markdown', content: "<font color='grey'>已超时，Agent 按推荐继续；需要修正请直接在话题里回复。</font>" },
      ]);
    case 'cancelled':
      return wrapCard(`${title} · 已取消`, 'grey', [
        { tag: 'markdown', content: questionsMd },
        { tag: 'markdown', content: "<font color='grey'>已取消（本轮已停止）。</font>" },
      ]);
    case 'unavailable':
    default:
      return wrapCard(`${title} · 已失效`, 'grey', [
        { tag: 'markdown', content: questionsMd },
        { tag: 'markdown', content: "<font color='grey'>这个问题已失效（运行环境已重启或问题已撤回）。</font>" },
      ]);
  }
}

function asIndex(raw: unknown, max: number): number | undefined {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d+$/.test(text)) return undefined;
  const n = Number(text);
  return n >= 0 && n < max ? n : undefined;
}

/**
 * Answers from a question card callback: a button's `opt`, or a form's `q<i>_sel` / `q<i>_txt`
 * values. Returns `null` when nothing was answered (an empty form, or a stale option index).
 */
export function answersFromCardAction(
  view: Pick<LarkQuestionView, 'questions'>,
  actionValue: Record<string, unknown> | undefined,
  formValue: Record<string, unknown> | undefined
): LarkQuestionAnswer[] | null {
  const opt = actionValue?.opt;
  if (opt !== undefined && view.questions.length > 0) {
    const q = view.questions[0];
    const index = asIndex(opt, q.options.length);
    if (index === undefined) return null;
    return [{ id: q.id, selected: [q.options[index].label] }];
  }
  const answers: LarkQuestionAnswer[] = [];
  view.questions.forEach((q, i) => {
    const rawSel = formValue?.[`q${i}_sel`];
    const rawList = Array.isArray(rawSel) ? rawSel : rawSel === undefined || rawSel === null || rawSel === '' ? [] : [rawSel];
    const selected: string[] = [];
    for (const raw of rawList) {
      const index = asIndex(raw, q.options.length);
      if (index === undefined) continue;
      const label = q.options[index].label;
      if (!selected.includes(label)) selected.push(label);
    }
    const kept = q.multiSelect ? selected : selected.slice(0, 1);
    const rawTxt = formValue?.[`q${i}_txt`];
    const custom = typeof rawTxt === 'string' ? rawTxt.trim().slice(0, MAX_INPUT_LENGTH) : '';
    if (kept.length > 0 || custom.length > 0) {
      answers.push({ id: q.id, selected: kept, ...(custom ? { custom } : {}) });
    }
  });
  return answers.length > 0 ? answers : null;
}

/** Reads a question card action value (null when the payload is not one). */
export function parseQuestionCardActionValue(value: Record<string, unknown> | undefined): QuestionCardActionValue | null {
  if (!value || value.action !== QUESTION_CARD_ACTION) return null;
  if (typeof value.qid !== 'string' || value.qid.length === 0) return null;
  if (typeof value.sessionId !== 'string' || value.sessionId.length === 0) return null;
  return {
    action: QUESTION_CARD_ACTION,
    qid: value.qid,
    sessionId: value.sessionId,
    ...(typeof value.turnId === 'string' ? { turnId: value.turnId } : {}),
    ...(typeof value.sid === 'string' && value.sid ? { sid: value.sid } : {}),
    ...(typeof value.opt === 'string' || typeof value.opt === 'number' ? { opt: String(value.opt) } : {}),
  };
}
