import { ValidationError, PlatformError } from '@enkeep/platform-core';
import type { ModelSelectionService } from '../models/model-selection-service.js';

export interface ParsedChatCommand {
  command: 'model' | 'effort';
  type: 'model' | 'effort';
  subcommand: 'list' | 'reset' | 'set' | 'show' | 'unknown';
  action: 'list' | 'reset' | 'set' | 'show' | 'unknown';
  arg?: string;
  target?: string;
  effort?: string;
  raw: string;
}

const MODEL_USAGE = `Usage:
  /model - Show current effective model
  /model list - List available models
  /model <provider/model> or <modelId> - Set session model override
  /model reset - Reset session model override`;

const EFFORT_USAGE = `Usage:
  /effort list - List supported reasoning efforts for current model
  /effort <name> - Set reasoning effort for current session
  /effort reset - Reset reasoning effort override`;

/**
 * Parses in-chat slash commands starting with /model or /effort at a word boundary.
 * Returns null if the content does not match.
 */
export function parseChatCommand(content: unknown): ParsedChatCommand | null {
  if (typeof content !== 'string') {
    return null;
  }

  const trimmed = content.trim();
  const match = trimmed.match(/^\/(model|effort)(?:[\s\t\r\n]+(.*))?$/);
  if (!match) {
    return null;
  }

  const cmd = match[1] as 'model' | 'effort';
  const rest = match[2] !== undefined ? match[2].trim() : '';

  if (cmd === 'model') {
    if (!rest) {
      return {
        command: 'model',
        type: 'model',
        subcommand: 'show',
        action: 'show',
        raw: trimmed,
      };
    }
    if (rest === 'list') {
      return {
        command: 'model',
        type: 'model',
        subcommand: 'list',
        action: 'list',
        raw: trimmed,
      };
    }
    if (rest === 'reset') {
      return {
        command: 'model',
        type: 'model',
        subcommand: 'reset',
        action: 'reset',
        raw: trimmed,
      };
    }
    if (rest === 'help' || rest === '--help' || rest === '-h' || /\s/.test(rest)) {
      return {
        command: 'model',
        type: 'model',
        subcommand: 'unknown',
        action: 'unknown',
        arg: rest,
        raw: trimmed,
      };
    }
    return {
      command: 'model',
      type: 'model',
      subcommand: 'set',
      action: 'set',
      arg: rest,
      target: rest,
      raw: trimmed,
    };
  }

  // cmd === 'effort'
  if (!rest) {
    return {
      command: 'effort',
      type: 'effort',
      subcommand: 'unknown',
      action: 'unknown',
      raw: trimmed,
    };
  }
  if (rest === 'list') {
    return {
      command: 'effort',
      type: 'effort',
      subcommand: 'list',
      action: 'list',
      raw: trimmed,
    };
  }
  if (rest === 'reset') {
    return {
      command: 'effort',
      type: 'effort',
      subcommand: 'reset',
      action: 'reset',
      raw: trimmed,
    };
  }
  if (rest === 'help' || rest === '--help' || rest === '-h' || /\s/.test(rest)) {
    return {
      command: 'effort',
      type: 'effort',
      subcommand: 'unknown',
      action: 'unknown',
      arg: rest,
      raw: trimmed,
    };
  }
  return {
    command: 'effort',
    type: 'effort',
    subcommand: 'set',
    action: 'set',
    arg: rest,
    effort: rest,
    raw: trimmed,
  };
}

export class ChatCommandService {
  constructor(private readonly modelSelectionService: ModelSelectionService) {}

  async execute(params: {
    userId: string;
    sessionId: string;
    spaceId: string;
    content: string;
  }): Promise<{ replyText: string }> {
    try {
      const parsed = parseChatCommand(params.content);
      if (!parsed) {
        return { replyText: 'Unrecognized command.' };
      }

      if (parsed.command === 'model') {
        return await this.executeModelCommand(params, parsed);
      }

      return await this.executeEffortCommand(params, parsed);
    } catch (err: unknown) {
      if (err instanceof ValidationError || err instanceof PlatformError) {
        return { replyText: err.message };
      }
      if (err instanceof Error) {
        return { replyText: err.message };
      }
      return { replyText: String(err) };
    }
  }

  private async executeModelCommand(
    params: { userId: string; sessionId: string; spaceId: string },
    parsed: ParsedChatCommand
  ): Promise<{ replyText: string }> {
    const { userId, sessionId, spaceId } = params;

    if (parsed.subcommand === 'unknown') {
      return { replyText: MODEL_USAGE };
    }

    if (parsed.subcommand === 'show') {
      const effective = await this.modelSelectionService.resolveEffectiveModel({
        sessionId,
        spaceId,
        userId,
      });
      const effortStr = effective.reasoningEffort ?? 'default';
      return {
        replyText: `Current model: ${effective.provider}/${effective.model} (${effective.source}, effort: ${effortStr})`,
      };
    }

    if (parsed.subcommand === 'list') {
      const catalog = this.modelSelectionService.getDshCatalog();
      const effective = await this.modelSelectionService.resolveEffectiveModel({
        sessionId,
        spaceId,
        userId,
      });

      const lines: string[] = [];
      for (const [pId, prov] of Object.entries(catalog.providers || {})) {
        for (const m of prov.models || []) {
          const modelKey = `${pId}/${m.id}`;
          if (pId === effective.provider && m.id === effective.model) {
            const effortStr = effective.reasoningEffort ? `effort: ${effective.reasoningEffort}` : 'effort: default';
            lines.push(`* ${modelKey} (${effective.source}, ${effortStr})`);
          } else {
            lines.push(modelKey);
          }
        }
      }

      if (lines.length === 0) {
        return { replyText: 'No models available in catalog.' };
      }
      return { replyText: lines.join('\n') };
    }

    if (parsed.subcommand === 'reset') {
      await this.modelSelectionService.deleteOverride('session', sessionId, userId);
      return { replyText: 'Session model override reset.' };
    }

    // parsed.subcommand === 'set'
    const target = parsed.target || '';
    const catalog = this.modelSelectionService.getDshCatalog();

    let targetProvider = '';
    let targetModel = '';

    if (target.includes('/')) {
      const slashIdx = target.indexOf('/');
      targetProvider = target.slice(0, slashIdx).trim();
      targetModel = target.slice(slashIdx + 1).trim();
    } else {
      const candidates: Array<{ provider: string; model: string }> = [];
      for (const [pId, prov] of Object.entries(catalog.providers || {})) {
        for (const m of prov.models || []) {
          if (m.id === target) {
            candidates.push({ provider: pId, model: m.id });
          }
        }
      }

      if (candidates.length === 0) {
        return {
          replyText: `Model "${target}" not found in catalog. Use "/model list" to see available models.\n\n${MODEL_USAGE}`,
        };
      }
      if (candidates.length > 1) {
        const candidateList = candidates.map((c) => `${c.provider}/${c.model}`).join(', ');
        return {
          replyText: `Model "${target}" is ambiguous across providers. Please specify one of: ${candidateList}`,
        };
      }

      targetProvider = candidates[0]!.provider;
      targetModel = candidates[0]!.model;
    }

    // Validate provider and model against catalog
    this.modelSelectionService.validateProviderAndModel(targetProvider, targetModel);

    // Resolve current effective effort to decide whether to keep or nullify
    const currentEffective = await this.modelSelectionService.resolveEffectiveModel({
      sessionId,
      spaceId,
      userId,
    });
    const currentEffort = currentEffective.reasoningEffort;

    const prov = catalog.providers?.[targetProvider];
    const modelDef = prov?.models?.find((m) => m.id === targetModel);

    let newEffort: string | null = null;
    let effortNotice: string | null = null;

    if (currentEffort) {
      if (
        modelDef?.reasoningEfforts &&
        Object.prototype.hasOwnProperty.call(modelDef.reasoningEfforts, currentEffort)
      ) {
        newEffort = currentEffort;
      } else {
        newEffort = null;
        effortNotice = `Reasoning effort "${currentEffort}" is not supported by ${targetProvider}/${targetModel} and was reset to null.`;
      }
    } else {
      newEffort = null;
    }

    await this.modelSelectionService.setOverride(userId, 'session', sessionId, {
      provider: targetProvider,
      model: targetModel,
      reasoningEffort: newEffort,
      fallbackChain: null,
    });

    let reply = `Session model set to ${targetProvider}/${targetModel}.`;
    if (newEffort) {
      reply += ` (effort: ${newEffort})`;
    }
    if (effortNotice) {
      reply += ` ${effortNotice}`;
    }
    return { replyText: reply };
  }

  private async executeEffortCommand(
    params: { userId: string; sessionId: string; spaceId: string },
    parsed: ParsedChatCommand
  ): Promise<{ replyText: string }> {
    const { userId, sessionId, spaceId } = params;

    if (parsed.subcommand === 'unknown') {
      return { replyText: EFFORT_USAGE };
    }

    const effective = await this.modelSelectionService.resolveEffectiveModel({
      sessionId,
      spaceId,
      userId,
    });

    if (parsed.subcommand === 'list') {
      const catalog = this.modelSelectionService.getDshCatalog();
      const prov = catalog.providers?.[effective.provider];
      const modelDef = prov?.models?.find((m) => m.id === effective.model);

      const supported = modelDef?.reasoningEfforts ? Object.keys(modelDef.reasoningEfforts) : [];
      const currentEffortStr = effective.reasoningEffort ?? 'default';

      if (supported.length === 0) {
        return {
          replyText: `Model ${effective.provider}/${effective.model} has no effort options. (Current effort: ${currentEffortStr})`,
        };
      }

      return {
        replyText: `Supported efforts for ${effective.provider}/${effective.model}: ${supported.join(', ')}\nCurrent effort: ${currentEffortStr}`,
      };
    }

    if (parsed.subcommand === 'reset') {
      const existing = await this.modelSelectionService.getOverride('session', sessionId);
      if (existing && existing.provider && existing.model) {
        await this.modelSelectionService.setOverride(userId, 'session', sessionId, {
          provider: existing.provider,
          model: existing.model,
          reasoningEffort: null,
          fallbackChain: null,
        });
        return {
          replyText: `Reasoning effort reset for session (${existing.provider}/${existing.model}).`,
        };
      }

      return {
        replyText: 'No session override active; reasoning effort is already at default.',
      };
    }

    // parsed.subcommand === 'set'
    const effortName = parsed.effort || '';
    this.modelSelectionService.validateProviderAndModel(
      effective.provider,
      effective.model,
      effortName
    );

    await this.modelSelectionService.setOverride(userId, 'session', sessionId, {
      provider: effective.provider,
      model: effective.model,
      reasoningEffort: effortName,
      fallbackChain: null,
    });

    return {
      replyText: `Reasoning effort set to "${effortName}" for session (${effective.provider}/${effective.model}).`,
    };
  }
}
