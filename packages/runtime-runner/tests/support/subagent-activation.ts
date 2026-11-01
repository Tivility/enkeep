/**
 * Test helper for DSH 0.2.1 subagents: start a child through `startActivation` with caller delivery and
 * expose the run shape the suites assert on (`id`, `localAgent`, `result`, `dispose`).
 */
import type { Agent } from '@deepseek-ai/dsh-agent';

export interface StartedSubagent {
  readonly id: string;
  /** The child Agent while it is resident (looked up by child session id). */
  readonly localAgent: Agent | undefined;
  readonly result: Promise<any>;
  dispose(): Promise<void>;
}

export async function startSubagent(
  subagents: any,
  provider: 'spawn' | 'fork' | string,
  options: { label: string; prompt: any[]; parent: Agent; signal?: AbortSignal; [key: string]: unknown }
): Promise<StartedSubagent> {
  const { label, prompt, parent, signal, ...rest } = options;
  const activation = await subagents.startActivation({
    provider,
    label,
    request: { parent, prompt, ...rest },
    signal: signal ?? new AbortController().signal,
    delivery: 'caller',
  });
  const agents = (parent as any).ctx?.get?.('agents') ?? (parent as any).ctx?.agents;
  return {
    id: String(activation.childId),
    get localAgent() {
      return agents?.get?.(activation.childId) as Agent | undefined;
    },
    result: activation.result,
    dispose: () => activation.dispose(),
  };
}

/** Wait until the parent's delegated children settle (DSH 0.2.1 delegations return before the child finishes). */
export async function waitForSubagents(parent: Agent): Promise<void> {
  const subagents = (parent as any).ctx?.get?.('subagents');
  for (let i = 0; i < 50; i++) {
    if (!(await subagents.waitForChildren(parent))) return;
  }
}

