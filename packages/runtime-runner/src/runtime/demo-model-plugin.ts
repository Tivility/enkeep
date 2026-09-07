/**
 * Deterministic Demo Model Plugin for Enkeep DSH Runtime
 *
 * Implements an LlmAdapter that generates deterministic, reproducible responses
 * without requiring real API keys, credentials, or external network access.
 * Uses standard official @deepseek-ai/dsh-llm ESM package imports.
 * Supports optional chunkDelayMs for deterministic cancellation testing.
 *
 * @module @enkeep/runtime-runner/runtime/demo-model-plugin
 */

import type { Context } from '@deepseek-ai/cordis';
import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  ToolCallId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
  type Message,
} from '@deepseek-ai/dsh-llm';

export const DEMO_PROVIDER_ID = 'demo-provider';
export const DEMO_MODEL_ID = 'demo-model';

interface InstructionChangeEntry {
  readonly action?: 'replace' | 'remove' | 'add' | 'set' | string;
  readonly scope?: string;
  readonly path?: string;
  readonly digest?: string;
}

interface AgentInstructionSourcePayload {
  readonly kind?: string;
  readonly form?: string;
  readonly baseline?: boolean;
  readonly changes?: readonly InstructionChangeEntry[];
  readonly plugin?: string;
}

function extractMessageContentText(msg: Message | undefined | null): string {
  if (!msg || !msg.content) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    let acc = '';
    for (const b of msg.content) {
      if (typeof b === 'string') {
        acc += b + '\n';
      } else if (b && typeof b === 'object' && 'text' in b && typeof (b as any).text === 'string') {
        acc += (b as any).text + '\n';
      }
    }
    return acc;
  }
  return '';
}

function normalizeInstructionScope(scopeOrPath: string): string {
  if (scopeOrPath.includes('\0')) {
    const [dir, file] = scopeOrPath.split('\0');
    const normDir =
      dir === '~/.dsh' || dir === '$DSH_HOME' || dir === 'user-global'
        ? 'user-global'
        : dir === '.' || dir === ''
        ? '.'
        : dir;
    return `${normDir}\0${file || 'AGENTS.md'}`;
  }
  const p = scopeOrPath.replace(/\\/g, '/');
  if (
    p === '~/.dsh/AGENTS.md' ||
    p === '$DSH_HOME/AGENTS.md' ||
    p.startsWith('user-global/') ||
    p.startsWith('user-global\0')
  ) {
    return 'user-global\0AGENTS.md';
  }
  const base = p.split('/').pop() || p;
  const dir = p.includes('/') ? p.substring(0, p.lastIndexOf('/')) : '.';
  const normDir = dir === '.' || dir === '' ? '.' : dir;
  return `${normDir}\0${base}`;
}

export function extractInstructionTokens(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const matches = text.match(/INSTRUCTION_TOKEN_[A-Za-z0-9_]+/g) || [];
  return Array.from(new Set(matches)).sort();
}

function isLikelyPath(str: string): boolean {
  if (!str) return false;
  const s = str.trim();
  if (s.startsWith('INSTRUCTION_TOKEN_')) return false;
  return (
    s.includes('.md') ||
    s.includes('/') ||
    s.includes('\\') ||
    s.startsWith('~') ||
    s.startsWith('$') ||
    s === '.' ||
    s.endsWith('.txt')
  );
}

interface ParsedInstructionSection {
  headerType: 'initial' | 'additional' | 'updated' | 'removed';
  rawPath: string;
  scopeKey: string;
  body: string;
  tokens: string[];
}

function parseInstructionSections(text: string): ParsedInstructionSection[] {
  let innerText = text;
  const reminderMatches = text.match(/<system-reminder>([\s\S]*?)<\/system-reminder>/g);
  if (reminderMatches && reminderMatches.length > 0) {
    innerText = reminderMatches.map((m) => m.replace(/<\/?system-reminder>/g, '')).join('\n\n');
  }

  const headerRegex =
    /(?:^|\n)(?:(Updated instructions(?: from)?[:\s]*)|(Additional instructions(?: from)?[:\s]*)|(Instructions from[:\s]*)|(Instructions removed[:\s]*)|(<agent-instructions\s+path=["']([^"']+)["']>))\s*([^\n\r<]*)/gi;
  const matches: Array<{
    type: 'initial' | 'additional' | 'updated' | 'removed';
    rawPath: string;
    index: number;
    length: number;
  }> = [];

  let m: RegExpExecArray | null;
  while ((m = headerRegex.exec(innerText)) !== null) {
    let type: 'initial' | 'additional' | 'updated' | 'removed' = 'initial';
    if (m[1]) type = 'updated';
    else if (m[2]) type = 'additional';
    else if (m[3]) type = 'initial';
    else if (m[4]) type = 'removed';
    else if (m[5]) type = 'initial';

    const candidateTagPath = m[6];
    const candidateTail = m[7] ? m[7].trim() : '';
    let rawPath = '';
    let headerLength = m[0].length;

    if (candidateTagPath) {
      rawPath = candidateTagPath.trim();
    } else if (isLikelyPath(candidateTail)) {
      rawPath = candidateTail;
    } else {
      const prefixMatch = m[1] || m[2] || m[3] || m[4] || '';
      const leadingNewline = m[0].startsWith('\n') ? 1 : 0;
      headerLength = leadingNewline + prefixMatch.length;
    }

    matches.push({
      type,
      rawPath,
      index: m.index,
      length: headerLength,
    });
  }

  if (matches.length === 0) {
    return [];
  }

  const sections: ParsedInstructionSection[] = [];
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const nextIdx = i + 1 < matches.length ? matches[i + 1].index : innerText.length;
    const body = innerText.slice(cur.index + cur.length, nextIdx).trim();
    const scopeKey = cur.rawPath ? normalizeInstructionScope(cur.rawPath) : '.\0AGENTS.md';
    sections.push({
      headerType: cur.type,
      rawPath: cur.rawPath,
      scopeKey,
      body,
      tokens: extractInstructionTokens(body),
    });
  }
  return sections;
}

/**
 * Computes deterministic effective instructions across ALL historical agent-instructions messages.
 * Faithfully adheres to DSH baseline and replacement semantics:
 * - Iterates chronologically through all messages where source.kind === 'agent-instructions' (or role === 'system').
 * - Normalizes scopes per candidate (user-global\0AGENTS.md, .\0AGENTS.md, etc.).
 * - Replaces or removes scopes on explicit replacement/removal changes or newer baselines.
 * - Ignores regular user, assistant, and tool messages to prevent instruction token leakage.
 */
export function computeEffectiveInstructionTokens(
  messages: readonly Message[],
  system?: string
): string[] {
  const scopeTokensMap = new Map<string, Set<string>>();
  let systemTokens = new Set<string>();

  if (typeof system === 'string') {
    for (const t of extractInstructionTokens(system)) {
      systemTokens.add(t);
    }
  }

  if (Array.isArray(messages)) {
    for (const m of messages) {
      const msg = m as any;
      if (!msg || typeof msg !== 'object') continue;

      const source = msg.source as AgentInstructionSourcePayload | undefined;
      const isSystemRole = msg.role === 'system';
      const isAgentInstructions =
        source &&
        typeof source === 'object' &&
        (source.kind === 'agent-instructions' ||
          source.plugin === 'agent-instructions' ||
          source.form === 'instructions');

      if (!isSystemRole && !isAgentInstructions) {
        continue;
      }

      const msgText = extractMessageContentText(msg);

      if (isSystemRole && !isAgentInstructions) {
        for (const t of extractInstructionTokens(msgText)) {
          systemTokens.add(t);
        }
        continue;
      }

      const isBaseline = source?.baseline === true;
      const changes = Array.isArray(source?.changes) ? source.changes : [];
      const parsedSections = parseInstructionSections(msgText);

      if (isBaseline) {
        // Complete baseline resets prior scopes and initial system tokens
        scopeTokensMap.clear();
        systemTokens.clear();

        if (parsedSections.length > 0) {
          for (const s of parsedSections) {
            scopeTokensMap.set(s.scopeKey, new Set(s.tokens));
          }
        } else if (changes.length > 0) {
          const allMsgTokens = extractInstructionTokens(msgText);
          for (const c of changes) {
            const sKey = normalizeInstructionScope(c.scope || c.path || '.');
            if (c.action === 'remove') {
              scopeTokensMap.delete(sKey);
            } else {
              scopeTokensMap.set(sKey, new Set(allMsgTokens));
            }
          }
        } else {
          const allMsgTokens = extractInstructionTokens(msgText);
          scopeTokensMap.set('.\0AGENTS.md', new Set(allMsgTokens));
        }
      } else {
        // Incremental update
        if (changes.length > 0) {
          for (const c of changes) {
            const sKey = normalizeInstructionScope(c.scope || c.path || '.');
            if (c.action === 'remove') {
              scopeTokensMap.delete(sKey);
            } else {
              const matchedSection = parsedSections.find(
                (s) => s.scopeKey === sKey || (c.path && s.rawPath === c.path)
              );
              if (matchedSection) {
                scopeTokensMap.set(sKey, new Set(matchedSection.tokens));
              } else if (parsedSections.length === 1 && changes.length === 1) {
                scopeTokensMap.set(sKey, new Set(parsedSections[0].tokens));
              } else {
                const allMsgTokens = extractInstructionTokens(msgText);
                scopeTokensMap.set(sKey, new Set(allMsgTokens));
              }
            }
          }
        } else if (parsedSections.length > 0) {
          for (const s of parsedSections) {
            if (s.headerType === 'removed') {
              scopeTokensMap.delete(s.scopeKey);
            } else {
              scopeTokensMap.set(s.scopeKey, new Set(s.tokens));
            }
          }
        } else {
          const allMsgTokens = extractInstructionTokens(msgText);
          scopeTokensMap.set('.\0AGENTS.md', new Set(allMsgTokens));
        }

        // If replacement actions occurred, clear baseline systemTokens
        if (
          changes.some((c) => c.action === 'replace' || c.action === 'set') ||
          parsedSections.some((s) => s.headerType === 'updated')
        ) {
          systemTokens.clear();
        }
      }
    }
  }

  const effectiveTokens = new Set<string>(systemTokens);
  for (const [, tokens] of scopeTokensMap) {
    for (const t of tokens) {
      effectiveTokens.add(t);
    }
  }

  return Array.from(effectiveTokens).sort();
}

function isAgentInstructionUpdateMessage(msg: Message | undefined | null): boolean {
  if (!msg || typeof msg !== 'object') return false;
  const source = (msg as { source?: AgentInstructionSourcePayload }).source;
  if (!source || typeof source !== 'object') return false;
  if (source.kind !== 'agent-instructions') return false;
  if (source.baseline === true) return false;
  if (Array.isArray(source.changes) && source.changes.length > 0) {
    return source.changes.some(
      (c) => c && typeof c === 'object' && (c.action === 'replace' || c.action === 'remove' || c.action === 'add' || c.action === 'set')
    );
  }
  return source.form === 'instructions';
}

function isAgentInstructionBaselineOrSystemMessage(msg: Message | undefined | null): boolean {
  if (!msg || typeof msg !== 'object') return false;
  const source = (msg as { source?: AgentInstructionSourcePayload }).source;
  if (msg.role === 'system') return true;
  if (source && typeof source === 'object') {
    if (source.kind === 'agent-instructions' || source.plugin === 'agent-instructions' || source.form === 'instructions') {
      return true;
    }
  }
  return false;
}

/**
 * Extracts bounded delay in milliseconds (1..10000) from exact lowercase prompt test token:
 * `[enkeep-test-delay-ms=N]`.
 * Rejects non-canonical N, 0, leading zeros, >10000, or malformed tokens by throwing RangeError.
 */
export function extractPromptDelayMs(input: string | GenerateOptions): number | undefined {
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  const regex = /\[enkeep-test-delay-ms=(\d+)\]/g;
  let match: RegExpExecArray | null;
  let delay: number | undefined;
  while ((match = regex.exec(text)) !== null) {
    const raw = match[1];
    if (raw.length > 1 && raw.startsWith('0')) {
      throw new RangeError('Invalid delay token: leading zeros are not allowed');
    }
    const val = Number(raw);
    if (!Number.isSafeInteger(val) || val < 1 || val > 10000) {
      throw new RangeError('Invalid delay token: delay must be between 1 and 10000 ms');
    }
    delay = val;
  }
  return delay;
}

export interface ExtractedTestToolCall {
  toolName: string;
  argsJson: string;
}

/**
 * Extracts multiple sequential tool call specification tokens from prompt:
 * `[enkeep-test-tool-call=<toolName>:<jsonArgs>]`
 */
export function extractPromptToolCalls(input: string | GenerateOptions): ExtractedTestToolCall[] {
  let allText = '';
  if (typeof input === 'string') {
    allText = input;
  } else if (input && Array.isArray((input as GenerateOptions).messages)) {
    // Scan backwards from the latest user message
    for (let i = (input as GenerateOptions).messages.length - 1; i >= 0; i--) {
      const msg = (input as GenerateOptions).messages[i] as any;
      if (msg && (msg.role === 'user' || msg.source?.kind === 'user')) {
        if (typeof msg.content === 'string') {
          allText = msg.content;
        } else if (Array.isArray(msg.content)) {
          for (const b of msg.content) {
            if (typeof b === 'string') allText += b + ' ';
            else if (b && typeof b === 'object' && 'text' in b && typeof b.text === 'string') allText += b.text + ' ';
          }
        }
        if (allText.includes('[enkeep-test-tool-call=')) {
          break;
        }
      }
    }
  }

  const results: ExtractedTestToolCall[] = [];
  const prefix = '[enkeep-test-tool-call=';
  let searchIdx = 0;

  while (searchIdx < allText.length) {
    const startIdx = allText.indexOf(prefix, searchIdx);
    if (startIdx === -1) break;

    const colonIdx = allText.indexOf(':', startIdx + prefix.length);
    if (colonIdx === -1) break;

    const toolName = allText.slice(startIdx + prefix.length, colonIdx).trim();
    const rest = allText.slice(colonIdx + 1);

    let depth = 1;
    let endIdx = -1;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '[') depth++;
      else if (rest[i] === ']') {
        depth--;
        if (depth === 0) {
          endIdx = i;
          break;
        }
      }
    }

    if (endIdx === -1) break;
    const argsJson = rest.slice(0, endIdx).trim();
    results.push({ toolName, argsJson });
    searchIdx = colonIdx + 1 + endIdx + 1;
  }

  return results;
}

/**
 * Extracts tool call specification token from prompt:
 * `[enkeep-test-tool-call=<toolName>:<jsonArgs>]`
 */
export function extractPromptToolCall(input: string | GenerateOptions): ExtractedTestToolCall | undefined {
  const calls = extractPromptToolCalls(input);
  return calls.length > 0 ? calls[0] : undefined;
}

/**
 * Concrete Deterministic Demo LLM Adapter for keyless runtime execution.
 */
export class DeterministicDemoLlmAdapter extends LlmAdapter {
  constructor(
    private readonly userIdentifier = 'demo-user',
    private readonly chunkDelayMs: number = 0,
    private readonly contextWindow: number = 128000,
    private readonly defaultMaxTokens: number = 2048
  ) {
    super();
  }

  override providerInfo(provider: string) {
    return {
      id: provider,
      name: 'Deterministic Demo Provider',
    };
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return [
      {
        provider,
        id: DEMO_MODEL_ID,
        name: 'Deterministic Demo Model (Zero-Key)',
      },
    ];
  }

  override async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal
  ): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: `Deterministic Demo Model (${model})`,
      context: { contextWindow: this.contextWindow },
      defaultMaxTokens: this.defaultMaxTokens,
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('low'), name: 'Low' },
          { id: ReasoningEffortId('medium'), name: 'Medium' },
          { id: ReasoningEffortId('high'), name: 'High' },
          { id: ReasoningEffortId('max'), name: 'Max' },
          { id: ReasoningEffortId('xhigh'), name: 'Extra High' },
          { id: ReasoningEffortId('off'), name: 'Off' },
        ],
        defaultEffort: ReasoningEffortId('medium'),
      },
    };
  }

  /**
   * Extracts bounded delay in milliseconds (1..10000) from exact lowercase prompt test token:
   * `[enkeep-test-delay-ms=N]`.
   * Rejects non-canonical N, 0, leading zeros, >10000, or malformed tokens by throwing RangeError.
   */
  private extractPromptDelayMs(options: GenerateOptions): number {
    return extractPromptDelayMs(options) || 0;
  }

  /**
   * Generates a deterministic response based on conversation history and call purpose.
   */
  private generateDeterministicResponse(
    messages: readonly Message[],
    purpose?: string,
    system?: string
  ): string {
    let userMsg: any = undefined;
    let userMsgIdx = -1;
    if (Array.isArray(messages)) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i] as any;
        if (m && (m.role === 'user' || m.source?.kind === 'user')) {
          let text = '';
          if (typeof m.content === 'string') text = m.content;
          else if (Array.isArray(m.content)) {
            for (const b of m.content) {
              if (typeof b === 'string') text += b;
              else if (b && typeof b === 'object' && typeof b.text === 'string') text += b.text;
            }
          }
          if (m.source?.kind === 'user' && !text.startsWith('Current runtime context.')) {
            userMsg = m;
            userMsgIdx = i;
            break;
          }
          if (!userMsg) {
            userMsg = m;
            userMsgIdx = i;
          }
        }
      }
    }
    if (!userMsg && messages.length > 0) {
      userMsg = messages[messages.length - 1];
      userMsgIdx = messages.length - 1;
    }

    // Find the last assistant message from a prior turn (i.e. before userMsgIdx).
    // All messages after this prior assistant message belong to the current turn / request.
    let lastPriorAssistantIdx = -1;
    if (Array.isArray(messages) && userMsgIdx >= 0) {
      for (let i = userMsgIdx - 1; i >= 0; i--) {
        const m = messages[i] as any;
        if (m && (m.role === 'assistant' || m.source?.kind === 'model')) {
          lastPriorAssistantIdx = i;
          break;
        }
      }
    }
    const currentTurnStartIdx = lastPriorAssistantIdx >= 0 ? lastPriorAssistantIdx + 1 : 0;

    let userText = '';
    if (userMsg) {
      if (typeof userMsg.content === 'string') {
        userText = userMsg.content;
      } else if (Array.isArray(userMsg.content)) {
        for (const block of userMsg.content) {
          if (typeof block === 'string') {
            userText += block;
          } else if (block && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string') {
            userText += block.text;
          }
        }
      }
    }

    // Also extract tool results content if any tools were executed in the current turn
    let toolResultsText = '';
    if (Array.isArray(messages)) {
      const currentTurnMessages = messages.slice(currentTurnStartIdx);
      for (const m of currentTurnMessages) {
        const msg = m as any;
        if (msg && (msg.role === 'tool' || msg.source?.kind === 'tool' || (Array.isArray(msg.content) && msg.content.some((b: any) => b && (b.type === 'tool-result' || b.type === 'tool_result'))))) {
          if (Array.isArray(msg.content)) {
            for (const b of msg.content) {
              if (b && (b.type === 'tool-result' || b.type === 'tool_result')) {
                if (Array.isArray(b.content)) {
                  for (const sub of b.content) {
                    if (sub && typeof sub === 'object' && typeof sub.text === 'string') {
                      toolResultsText += (toolResultsText ? ' ' : '') + sub.text;
                    }
                  }
                } else if (typeof b.content === 'string') {
                  toolResultsText += (toolResultsText ? ' ' : '') + b.content;
                }
              }
            }
          }
        }
      }
    }

    if (
      purpose === 'compaction' ||
      userText.includes('acting as a compaction engine') ||
      userText.includes('Condense the conversation ABOVE')
    ) {
      return [
        '## Primary Request and Intent',
        `- User conversations summarized with ${messages.length} prior turns.`,
        '',
        '## Key Technical Concepts',
        '- (none)',
        '',
        '## Files and Code',
        '- (none)',
        '',
        '## Errors and Fixes',
        '- (none)',
        '',
        '## Pending Jobs',
        '- (none)',
        '',
        '## Current Work',
        '- Compaction checkpoint committed successfully.',
        '',
        '## Next Step',
        '- (none)',
        '',
        '## Critical Context',
        '- Retained essential session facts and context for continuous multi-turn execution.',
      ].join('\n');
    }

    // Check for explicit test directive [enkeep-test-echo-instructions]
    // Faithfully handles DSH baseline and replacement semantics across historical and current agent-instructions:
    if (userText.includes('[enkeep-test-echo-instructions]')) {
      const effectiveTokens = computeEffectiveInstructionTokens(messages, system);
      const tokensFormatted = effectiveTokens.length > 0 ? effectiveTokens.join(', ') : 'none';

      const effectiveText = toolResultsText ? `${userText} (Result: ${toolResultsText})` : userText;
      return (
        `[DemoModel:${this.userIdentifier}] Echoed instructions tokens: [${tokensFormatted}]. Received turn: "${effectiveText}". ` +
        `Official DSH agent loop active, session persisted successfully.`
      );
    }

    if (userText.trim() === '' && !toolResultsText) {
      return `[DemoModel:${this.userIdentifier}] Agent runtime initialized. Ready for instructions.`;
    }

    const effectiveText = toolResultsText ? `${userText} (Result: ${toolResultsText})` : userText;

    return (
      `[DemoModel:${this.userIdentifier}] Received turn: "${effectiveText}". ` +
      `Official DSH agent loop active, session persisted successfully.`
    );
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.signal?.aborted) {
      throw new LlmError('Request aborted by signal', 'ABORTED');
    }

    // Check for explicit prompt-controlled delay token (e.g. [enkeep-test-delay-ms=5000])
    const promptDelayMs = this.extractPromptDelayMs(options);
    if (promptDelayMs > 0) {
      const ok = await abortableSleep(promptDelayMs, options.signal);
      if (!ok || options.signal?.aborted) {
        throw new LlmError('Request aborted during delay', 'ABORTED');
      }
    }

    const allMessagesText = typeof options === 'string' ? options : (options.messages || []).map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join(' ');

    // Check for explicit prompt-controlled simulated provider error token (e.g. [enkeep-test-fail-provider=cpa-claude:503])
    const failProviderMatch = allMessagesText.match(/\[enkeep-test-fail-provider=([a-zA-Z0-9_\-]+):(\d+)\]/);
    if (failProviderMatch) {
      const targetProv = failProviderMatch[1];
      const targetStatus = parseInt(failProviderMatch[2], 10);
      if (options.provider === targetProv) {
        if (targetStatus === 401 || targetStatus === 403) {
          throw new LlmError(`Simulated ${targetStatus} Authentication failure`, 'AUTH', { status: targetStatus });
        } else if (targetStatus === 400 || targetStatus === 422) {
          throw new LlmError(`Simulated ${targetStatus} Bad Request failure`, 'INVALID_REQUEST', { status: targetStatus });
        } else if (targetStatus === 429) {
          throw new LlmError(`Simulated ${targetStatus} Rate Limit failure`, 'RATE_LIMIT', { status: targetStatus });
        } else {
          throw new LlmError(`Simulated ${targetStatus} Service Unavailable failure`, 'SERVER_ERROR', { status: targetStatus });
        }
      }
    }

    // Check for explicit prompt-controlled simulated model error token (e.g. [enkeep-test-fail-model=claude-fable-5:503])
    const failModelMatch = allMessagesText.match(/\[enkeep-test-fail-model=([a-zA-Z0-9_\-.]+):(\d+)\]/);
    if (failModelMatch) {
      const targetMod = failModelMatch[1];
      const targetStatus = parseInt(failModelMatch[2], 10);
      if (options.model === targetMod) {
        if (targetStatus === 401 || targetStatus === 403) {
          throw new LlmError(`Simulated ${targetStatus} Authentication failure`, 'AUTH', { status: targetStatus });
        } else {
          throw new LlmError(`Simulated ${targetStatus} Service Unavailable failure`, 'SERVER_ERROR', { status: targetStatus });
        }
      }
    }

    // Check for explicit prompt-controlled midstream failure token (e.g. [enkeep-test-midstream-fail=cpa-claude])
    const midstreamMatch = allMessagesText.match(/\[enkeep-test-midstream-fail=([a-zA-Z0-9_\-]+)\]/);
    if (midstreamMatch) {
      const targetProv = midstreamMatch[1];
      if (options.provider === targetProv) {
        yield {
          type: 'block-start',
          index: 0,
          blockType: 'text',
        };
        yield {
          type: 'text-delta',
          index: 0,
          text: 'Midstream partial chunk...',
        };
        throw new LlmError('Simulated midstream connection dropped', 'TRANSIENT', { status: 500 });
      }
    }

    // Check for explicit prompt-controlled tool call token(s) (e.g. [enkeep-test-tool-call=check_quota:{"resource":"all"}])
    const promptToolCalls = extractPromptToolCalls(options);
    let lastUserIdx = -1;
    if (Array.isArray(options.messages)) {
      for (let i = options.messages.length - 1; i >= 0; i--) {
        const m = options.messages[i] as any;
        let text = '';
        if (typeof m?.content === 'string') text = m.content;
        else if (Array.isArray(m?.content)) {
          for (const b of m.content) {
            if (typeof b === 'string') text += b + ' ';
            else if (b && typeof b === 'object' && typeof b.text === 'string') text += b.text + ' ';
          }
        }
        if (text.includes('[enkeep-test-tool-call=')) {
          lastUserIdx = i;
          break;
        }
      }
    }
    const messagesSinceLastUser = lastUserIdx >= 0 ? options.messages.slice(lastUserIdx + 1) : options.messages;
    const toolResultsCount = messagesSinceLastUser.filter((m: any) => {
      if (m.role === 'tool' || m.source?.kind === 'tool') return true;
      if (Array.isArray(m.content)) {
        return m.content.some((b: any) => b && (b.type === 'tool-result' || b.type === 'tool_result'));
      }
      return false;
    }).length;

    if (promptToolCalls.length > 0 && toolResultsCount < promptToolCalls.length) {
      const toolCall = promptToolCalls[toolResultsCount];
      const callId = ToolCallId(`call_${Date.now()}_${toolResultsCount}`);
      yield {
        type: 'block-start',
        index: 0,
        blockType: 'tool-call',
      };
      yield {
        type: 'tool-call-delta',
        index: 0,
        id: callId,
        name: toolCall.toolName,
        argumentsDelta: toolCall.argsJson,
      };
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: callId,
          name: toolCall.toolName,
          arguments: toolCall.argsJson,
        },
      };
      yield {
        type: 'usage',
        usage: {
          inputTokens: 15,
          outputTokens: 15,
        },
      };
      yield {
        type: 'finish',
        reason: { kind: 'tool-calls' },
      };
      return;
    }

    // Check for explicit prompt-controlled thinking token (e.g. [enkeep-test-thinking=Analyzing request])
    const thinkingMatch = allMessagesText.match(/\[enkeep-test-thinking=([^\]]+)\]/);
    if (thinkingMatch) {
      const thinkingText = thinkingMatch[1].trim();
      yield {
        type: 'block-start',
        index: 0,
        blockType: 'reasoning',
      };
      yield {
        type: 'reasoning-delta',
        index: 0,
        text: thinkingText,
      };
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'reasoning',
          text: thinkingText,
        },
      };
    }

    const text = this.generateDeterministicResponse(options.messages, options.purpose, options.system);

    // Yield text block start
    yield {
      type: 'block-start',
      index: 0,
      blockType: 'text',
    };

    // Stream text in chunks
    const chunkSize = 16;
    for (let i = 0; i < text.length; i += chunkSize) {
      if (options.signal?.aborted) {
        throw new LlmError('Request aborted during chunk streaming', 'ABORTED');
      }
      if (this.chunkDelayMs > 0) {
        const ok = await abortableSleep(this.chunkDelayMs, options.signal);
        if (!ok || options.signal?.aborted) {
          throw new LlmError('Request aborted during chunk delay', 'ABORTED');
        }
      }
      if (options.signal?.aborted) {
        throw new LlmError('Request aborted before chunk yield', 'ABORTED');
      }
      const slice = text.slice(i, i + chunkSize);
      yield {
        type: 'text-delta',
        index: 0,
        text: slice,
      };
    }

    if (options.signal?.aborted) {
      throw new LlmError('Request aborted before finish', 'ABORTED');
    }

    // Yield block end with assembled content
    yield {
      type: 'block-end',
      index: 0,
      block: {
        type: 'text',
        text,
      },
    };

    // Yield token usage
    yield {
      type: 'usage',
      usage: {
        inputTokens: Math.max(1, Math.round(text.length / 4)),
        outputTokens: Math.max(1, Math.round(text.length / 3)),
      },
    };

    // Yield terminal finish event
    yield {
      type: 'finish',
      reason: { kind: 'stop' },
    };
  }
}

/**
 * Abortable sleep utility that yields early upon AbortSignal firing.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    let timer: NodeJS.Timeout | null = null;

    const onAbort = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      signal?.removeEventListener('abort', onAbort);
      resolve(false);
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    timer = setTimeout(() => {
      timer = null;
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve(true);
    }, ms);
  });
}

/**
 * Creates an instance of DeterministicDemoLlmAdapter.
 */
export function createDeterministicDemoLlmAdapter(
  userIdentifier = 'demo-user',
  chunkDelayMs = 0,
  contextWindow = 128000,
  defaultMaxTokens = 2048
): DeterministicDemoLlmAdapter {
  return new DeterministicDemoLlmAdapter(userIdentifier, chunkDelayMs, contextWindow, defaultMaxTokens);
}

/**
 * Helper to mount the demo model plugin onto a Cordis context.
 */
export function mountDemoModelPlugin(
  ctx: Context,
  userId = 'demo-user',
  provider = DEMO_PROVIDER_ID,
  chunkDelayMs = 0,
  contextWindow = 128000,
  defaultMaxTokens = 2048
): void {
  const adapter = new DeterministicDemoLlmAdapter(userId, chunkDelayMs, contextWindow, defaultMaxTokens);
  ctx.effect(() => {
    const handle = ctx.llm.registerAdapter([provider], adapter);
    return () => {
      handle();
    };
  }, 'demo-model-plugin.register');
}
