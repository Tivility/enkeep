declare module '@tivility/dsh-tool-workflow-memory' {
  import type { Context } from '@deepseek-ai/cordis';
  import type z from '@deepseek-ai/schemastery';

  export const name: string;
  export const inject: string[];
  export interface Config {
    toolName?: string;
    maxResultChars?: number;
    enableRunInBackground?: boolean;
    workerLimits?: {
      maxTotalAgents?: number;
      maxConcurrentAgents?: number;
      maxItemsPerCall?: number;
      syncTimeoutMs?: number;
    };
  }
  export const Config: z<Config>;
  export function apply(ctx: Context, config: Config): void;
}

declare module '@tivility/dsh-tool-workflow-memory/engine' {
  import type { Context } from '@deepseek-ai/cordis';
  import type z from '@deepseek-ai/schemastery';
  import type { WorkflowEngine } from '@deepseek-ai/dsh-workflow';

  export interface Config {
    provider?: string;
    maxConcurrentAgents?: number;
    maxTotalAgents?: number;
    maxItemsPerCall?: number;
    syncTimeoutMs?: number;
  }
  export class PtcWorkflowEngine implements WorkflowEngine {
    static inject: string[];
    static Config: z<Config>;
    constructor(ctx: Context, config?: Config);
  }
  export default PtcWorkflowEngine;
}
