import * as path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import type { PlatformClientService, ToolDefinition } from './types.js';
import { createSendPlatformMessageTool } from './tools/send-platform-message.js';
import { createSendFileTool } from './tools/send-file.js';
import { createCreateTaskTool } from './tools/create-task.js';
import { createCheckQuotaTool } from './tools/check-quota.js';

export * from './types.js';
export * from './errors.js';
export {
  FileSecurityError,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  MAX_PATH_LENGTH,
  MAX_FILENAME_LENGTH,
  readValidatedFile,
  withValidatedFile,
  validateFileContainment,
  setDefaultFileSecurityHooks,
  getDefaultFileSecurityHooks,
  createSimulatedFdResolver,
  type FileSecurityHooks,
  type ValidateFileOptions,
  type ValidatedFile,
  type ValidatedFileWithContent,
} from './file-security.js';
export * from './tools/send-platform-message.js';
export * from './tools/send-message.js';
export * from './tools/send-file.js';
export * from './tools/create-task.js';
export * from './tools/check-quota.js';

export const name = 'enkeep-dsh-tools';

export const inject = [];

export interface Config {
  workspaceBoundaryRoot?: string;
  /** @deprecated Legacy alias for workspaceBoundaryRoot */
  workspaceRoot?: string;
  maxFileSizeBytes?: number;
  hooks?: import('./file-security.js').FileSecurityHooks;
}

export const Config: Schema<Config> = Schema.object({
  workspaceBoundaryRoot: Schema.string().description('Required absolute boundary root path for workspace containment (e.g. /home/dsh/spaces)'),
  workspaceRoot: Schema.string().description('Legacy alias for workspaceBoundaryRoot'),
  maxFileSizeBytes: Schema.natural().description('Maximum allowed file size in bytes for send_file'),
});

/**
 * Functional Cordis plugin that registers send_platform_message, send_file, create_task, and check_quota tools.
 * Supports both immediate and dynamic/late tools service mounting with full revocable effect lifecycle.
 */
export function apply(ctx: Context, config: Config): void {
  const boundaryRoot = config?.workspaceBoundaryRoot ?? config?.workspaceRoot;
  if (
    !boundaryRoot ||
    typeof boundaryRoot !== 'string' ||
    boundaryRoot.trim() === '' ||
    !path.isAbsolute(boundaryRoot)
  ) {
    throw new TypeError('enkeep-dsh-tools plugin requires a valid absolute workspaceBoundaryRoot configuration');
  }

  const getClient = (): PlatformClientService | undefined => {
    return ctx.platformClient ?? (ctx.get ? ctx.get('platformClient') : undefined);
  };

  const sendPlatformMessageTool = createSendPlatformMessageTool(getClient);
  const sendFileTool = createSendFileTool(
    getClient,
    {
      workspaceBoundaryRoot: boundaryRoot,
      maxSizeBytes: config.maxFileSizeBytes,
      hooks: config.hooks,
      context: ctx,
    },
    ctx
  );
  const createTaskTool = createCreateTaskTool(getClient);
  const checkQuotaTool = createCheckQuotaTool(getClient);

  const tools: ToolDefinition[] = [
    sendPlatformMessageTool,
    sendFileTool,
    createTaskTool,
    checkQuotaTool,
  ];

  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.effect(() => {
      const toolsService = toolsCtx.get('tools');
      if (!toolsService || typeof toolsService.register !== 'function') {
        throw new Error('enkeep-dsh-tools plugin activation failed: "tools" registry service is unavailable on Context');
      }

      const disposers = tools.map((tool) => toolsService.register(tool));
      return () => {
        for (const dispose of disposers) {
          if (typeof dispose === 'function') {
            try {
              dispose();
            } catch {
              // Ignore cleanup errors during teardown
            }
          }
        }
      };
    }, 'enkeep-dsh-tools.toolsService()');
  });
}
