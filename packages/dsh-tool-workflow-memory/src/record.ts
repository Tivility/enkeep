/**
 * Live-progress mirror and durable recording for workflow runs.
 * Upstream source: @deepseek-ai/dsh-tool-workflow@0.2.0-rc.2 (lib/index.js)
 * @module @enkeep/dsh-tool-workflow-memory/record
 */

import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { WorkflowRunId, WorkflowStopReason } from '@deepseek-ai/dsh-workflow';

function renderRecordingError(error: unknown): string {
  try {
    return String(error);
  } catch {
    return '[unrenderable thrown value]';
  }
}

export function createWorkflowRecordMirror(ctx: Context) {
  const active = new Map<string, any>();
  ctx.on('workflow/phase', (info: any, title: string) => {
    const job = active.get(info.id);
    if (job === undefined) return;
    job.updateProgress(title);
    job.append(`▸ ${title}\n`, { channel: 'log' });
  });
  ctx.on('workflow/log', (info: any, message: string) => {
    active.get(info.id)?.append(`${message}\n`, { channel: 'log' });
  });
  ctx.on('workflow/agent-start', (info: any, agent: any) => {
    active.get(info.id)?.append(`agent #${agent.seq} ${agent.label} started\n`, { channel: 'log' });
  });
  ctx.on('workflow/agent-end', (info: any, agent: any) => {
    active.get(info.id)?.append(`agent #${agent.seq} ${agent.outcome}\n`, { channel: 'log' });
  });
  return {
    start(runId: string, job: any) {
      active.set(runId, job);
    },
    stop(runId: string) {
      active.delete(runId);
    },
  };
}

export function createWorkflowRecorder(ctx: Context) {
  const active = new Map<WorkflowRunId, Session>();
  const append = (session: Session, type: string, data: any) => {
    const appendRecord = session.append.bind(session) as any;
    try {
      appendRecord(type, data);
      return true;
    } catch (error) {
      ctx.logger?.warn?.(`tool-workflow: disabled durable record after ${type} append failed: ${renderRecordingError(error)}`);
      return false;
    }
  };
  ctx.on('workflow/agent-start', (info: any, agent: any) => {
    const session = active.get(info.id);
    if (session === undefined) return;
    if (!append(session, 'tool-workflow/agent-start', {
      runId: info.id,
      seq: agent.seq,
      label: agent.label,
      ...agent.phase === undefined ? {} : { phase: agent.phase },
      childId: agent.childId,
    })) active.delete(info.id);
  });
  ctx.on('workflow/agent-end', (info: any, agent: any) => {
    const session = active.get(info.id);
    if (session === undefined) return;
    if (!append(session, 'tool-workflow/agent-end', {
      runId: info.id,
      seq: agent.seq,
      outcome: agent.outcome,
    })) active.delete(info.id);
  });
  return {
    start(session: Session, run: any) {
      if (append(session, 'tool-workflow/run-start', { runId: run.id, name: run.meta.name })) {
        active.set(run.id, session);
      }
    },
    finish(runId: WorkflowRunId, stopReason: WorkflowStopReason) {
      const session = active.get(runId);
      if (session !== undefined) append(session, 'tool-workflow/run-end', { runId, stopReason });
      active.delete(runId);
    },
    abandon(runId: WorkflowRunId) {
      active.delete(runId);
    },
  };
}
