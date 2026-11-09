/**
 * Text form of `ask_user_question` questions for channels without question cards (WeChat, and
 * Lark when a card cannot be sent), and parsing of a typed reply back into answers.
 *
 * A reply that is exactly a list of option codes ("A" for a single question, "1A 2B", "1AC" for a
 * multi-select) maps to the offered options; anything else is the user's own words and becomes
 * the free-text answer of every question.
 *
 * @module @enkeep/platform-server/interactions/question-text
 */

import {
  MAX_CUSTOM_ANSWER_LENGTH,
  type QuestionAnswer,
  type UserQuestion,
} from '@enkeep/dsh-external-interaction/user-questions';

const RECOMMENDED_SUFFIX = /\s*\(recommended\)\s*$/i;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** "(Recommended)" shown as "（推荐）". */
function displayLabel(label: string): string {
  return RECOMMENDED_SUFFIX.test(label) ? `${label.replace(RECOMMENDED_SUFFIX, '')}（推荐）` : label;
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

/** Plain-text rendering of a question set (no markdown: WeChat shows text as is). */
export function renderQuestionText(questions: readonly UserQuestion[], timeoutMs: number): string {
  const single = questions.length === 1;
  const lines: string[] = [
    `${single ? '需要你确认一个问题' : `需要你确认 ${questions.length} 个问题`}（${formatWaitZh(timeoutMs)}内回复，超时我按推荐继续）：`,
    '',
  ];
  questions.forEach((q, i) => {
    const header = q.header?.trim() ? `${q.header.trim()}：` : '';
    const multi = q.multiSelect ? '（可多选）' : '';
    lines.push(single ? `${header}${q.question}${multi}` : `${i + 1}. ${header}${q.question}${multi}`);
    q.options.forEach((o, j) => {
      lines.push(`${single ? '' : '   '}${LETTERS[j]}. ${displayLabel(o.label)}`);
    });
  });
  const anyOptions = questions.some((q) => q.options.length > 0);
  lines.push('');
  if (!anyOptions) {
    lines.push('直接回复你的回答即可。');
  } else if (single) {
    lines.push(`回复字母（如「A」${questions[0].multiSelect ? '，多选写「AC」' : ''}），或直接用你自己的话说。`);
  } else {
    lines.push('回复编号（如「1A 2B」），或直接用你自己的话说。');
  }
  return lines.join('\n');
}

/** Full-width ASCII to half-width, trimmed, upper-cased. */
function normalizeCodes(text: string): string {
  return text
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .trim()
    .toUpperCase();
}

/**
 * Option codes of a reply, or null when the reply is not (exactly and validly) a code list.
 * Single question: "A" / "AC". Several: "1A 2B", "1a,2b", "1AC 2B".
 */
export function parseOptionCodes(questions: readonly UserQuestion[], text: string): QuestionAnswer[] | null {
  const raw = normalizeCodes(text);
  if (raw.length === 0 || raw.length > 64) return null;
  const segments: Array<{ index: number; letters: string }> = [];
  if (questions.length === 1 && /^[A-Z]+$/.test(raw)) {
    segments.push({ index: 0, letters: raw });
  } else {
    if (!/^(\d+[A-Z]+)([\s,，、;；]*\d+[A-Z]+)*$/.test(raw)) return null;
    const re = /(\d+)([A-Z]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      segments.push({ index: Number(m[1]) - 1, letters: m[2] });
    }
  }
  const answers = new Map<number, string[]>();
  for (const seg of segments) {
    const q = questions[seg.index];
    if (!q || q.options.length === 0 || answers.has(seg.index)) return null;
    const labels: string[] = [];
    for (const letter of seg.letters) {
      const optIndex = LETTERS.indexOf(letter);
      if (optIndex < 0 || optIndex >= q.options.length) return null;
      const label = q.options[optIndex].label;
      if (labels.includes(label)) return null;
      labels.push(label);
    }
    if (!q.multiSelect && labels.length > 1) return null;
    answers.set(seg.index, labels);
  }
  return questions
    .map((q, i) => (answers.has(i) ? { id: q.id, selected: answers.get(i)! } : undefined))
    .filter((a): a is QuestionAnswer => a !== undefined);
}

/** Answers from a typed reply: option codes when the reply is exactly that, else free text for every question. */
export function parseQuestionReply(questions: readonly UserQuestion[], text: string): QuestionAnswer[] {
  const codes = parseOptionCodes(questions, text);
  if (codes && codes.length > 0) return codes;
  const custom = text.trim().slice(0, MAX_CUSTOM_ANSWER_LENGTH);
  return questions.map((q) => ({ id: q.id, selected: [], custom }));
}
