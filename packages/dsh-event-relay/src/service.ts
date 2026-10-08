/**
 * Event Relay Service implementation.
 *
 * Listens to DSH session events, maintains per-session bounded buffers,
 * supports subscriber dispatch, per-session cursor acknowledgement,
 * and high-performance batched non-blocking streaming forwarding to platform.
 *
 * @module @enkeep/dsh-event-relay
 */

import { randomBytes } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type {
  AssistantStreamFrame,
  ContainerStreamingEventFrame,
  EventRelayConfig,
  EventRelayDiagnostics,
  IEventRelayService,
  PollEventsOptions,
  PollEventsResult,
  RelayEnvelope,
  RelaySubscriber,
} from './types.js';
import type { IPlatformClientService } from './index.js';
import { BoundedEventBuffer, parseCursorSeq } from './bounded-buffer.js';
import { EventRelayValidationError } from './errors.js';

interface SessionStreamState {
  streamId: string;
  accumulatedLength: number;
  accumulatedReasoningLength?: number;
  activeToolName?: string;
  turn?: number;
  step?: number;
  ended?: boolean;
  outcome?: unknown;
}

interface SessionJobRecord {
  jobId: string;
  jobName?: string;
  originTurnId: string;
  matched: boolean;
  createdAt: number;
}

export class EventRelayService implements IEventRelayService {
  readonly consumer: string;
  readonly batchIntervalMs: number;
  readonly maxBatchSizeBytes: number;
  readonly maxPendingBytes: number;

  private readonly ctx: Context;
  private readonly buffer: BoundedEventBuffer;
  private readonly subscribers = new Set<RelaySubscriber>();

  // Streaming forwarding state
  private readonly sessionStreams = new Map<string, SessionStreamState>();
  private readonly sessionLastMappedSeq = new Map<string, number>();
  private readonly activeTurnContexts = new Map<string, { platformTurnId: string; originTurnId?: string; causeChildId?: string; dshIntTurn?: number }>();
  private readonly dshIntTurnMap = new Map<string, { platformTurnId: string; originTurnId?: string; causeChildId?: string }>();
  private readonly pendingAutonomousOrigins = new Map<string, Array<{ originTurnId: string; causeChildId: string }>>();
  private readonly activeTurnSessions = new Set<string>();
  private readonly childOriginMap = new Map<string, string>();
  private readonly sessionToolCalls = new Map<string, Map<string, string>>();
  private readonly sessionPendingToolCalls = new Map<string, Array<{ callId?: string; toolName: string; jobName?: string }>>();
  private readonly sessionJobs = new Map<string, SessionJobRecord[]>();
  private pendingOutboundFrames: ContainerStreamingEventFrame[] = [];
  private pendingOutboundBytes = 0;
  private batchTimer: NodeJS.Timeout | null = null;
  private isFlushing = false;
  private isDisposed = false;

  // Diagnostics
  private flushCount = 0;
  private flushFailureCount = 0;
  private droppedDeltaCount = 0;
  private subscriberErrorCount = 0;
  private lastFlushErrorCode: string | null = null;
  private lastFlushErrorMessage: string | null = null;
  private readonly ingestedEventTypes: Record<string, number> = {};
  private readonly mappedFrameCounts: Record<string, number> = {};
  private readonly platformPostStatusCounts: Record<string, number> = {};
  private lastFrameTimeMs = 0;

  private readonly flushTimeoutMs: number;
  private readonly flushBackoffMs: number;
  private flushStartedAt = 0;
  private nextFlushAllowedAt = 0;

  constructor(ctx: Context, config?: EventRelayConfig) {
    this.ctx = ctx;
    this.consumer = config?.consumer ?? 'default';
    this.buffer = new BoundedEventBuffer(config?.maxBufferSize ?? 1000);
    this.batchIntervalMs = Math.min(Math.max(config?.batchIntervalMs ?? 30, 20), 50);
    this.maxBatchSizeBytes = config?.maxBatchSizeBytes ?? 32768; // 32KB
    this.maxPendingBytes = config?.maxPendingBytes ?? 262144; // 256KB
    this.flushTimeoutMs = config?.flushTimeoutMs ?? 15000;
    this.flushBackoffMs = config?.flushBackoffMs ?? 1000;

    this.startBatchTimer();
  }

  get maxBufferSize(): number {
    return this.buffer.capacity;
  }

  private get receiptStore() {
    return this.ctx.get('receiptStore');
  }

  private get platformClient(): IPlatformClientService | undefined {
    return this.ctx.get('platformClient') ?? (this.ctx as unknown as { platformClient?: IPlatformClientService }).platformClient;
  }

  getBufferSize(sessionId?: string): number {
    return this.buffer.getBufferSize(sessionId);
  }

  getDiagnostics(): EventRelayDiagnostics {
    return {
      flushCount: this.flushCount,
      flushFailureCount: this.flushFailureCount,
      droppedDeltaCount: this.droppedDeltaCount,
      subscriberErrorCount: this.subscriberErrorCount,
      lastFlushErrorCode: this.lastFlushErrorCode,
      lastFlushErrorMessage: this.lastFlushErrorMessage,
      ingestedEventTypes: { ...this.ingestedEventTypes },
      mappedFrameCounts: { ...this.mappedFrameCounts },
      platformPostStatusCounts: { ...this.platformPostStatusCounts },
    };
  }

  private startBatchTimer(): void {
    if (this.batchTimer || this.isDisposed) return;
    this.batchTimer = setInterval(() => {
      if (this.pendingOutboundFrames.length > 0) {
        void this.flushOutbound().catch((flushErr: unknown) => {
          this.recordFlushFailure(flushErr);
        });
      }
    }, this.batchIntervalMs);
  }

  private stopBatchTimer(): void {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
  }

  private recordFlushFailure(err: unknown): void {
    this.flushFailureCount++;
    if (err instanceof Error) {
      this.lastFlushErrorCode = 'FLUSH_ERROR';
      this.lastFlushErrorMessage = err.message;
    } else {
      this.lastFlushErrorCode = 'FLUSH_ERROR';
      this.lastFlushErrorMessage = String(err);
    }
  }

  private readonly attachedAgentScopes = new WeakSet<object>();

  attachAgent(agentCtx: Context): () => void {
    if (!agentCtx || typeof agentCtx.on !== 'function') {
      return () => {};
    }
    const scopeKey = agentCtx as unknown as object;
    if (this.attachedAgentScopes.has(scopeKey)) {
      return () => {};
    }
    this.attachedAgentScopes.add(scopeKey);

    const disposers: Array<() => void> = [];

    const unsubEvent = agentCtx.on('session/event', (s: Session, event: SessionEvent) => {
      this.ingest(s, event);
    });
    if (typeof unsubEvent === 'function') disposers.push(unsubEvent);

    const unsubStream = agentCtx.on('agent/assistant-stream', (payload: any) => {
      const session = payload?.agent?.session ?? payload?.session;
      const frame = payload?.frame;
      if (session && frame) {
        this.ingestAssistantStream(session, frame);
      }
    });
    if (typeof unsubStream === 'function') disposers.push(unsubStream);

    const unsubFlush = agentCtx.on('session/flush', async (_s: Session) => {
      await this.flush();
    });
    if (typeof unsubFlush === 'function') disposers.push(unsubFlush);

    return () => {
      for (const d of disposers) {
        d();
      }
      this.attachedAgentScopes.delete(scopeKey);
    };
  }

  bindTurnContext(sessionId: string, context: { turnId: string; originTurnId?: string; causeChildId?: string; dshIntTurn?: number }): () => void {
    if (!sessionId) return () => {};
    this.pendingAutonomousOrigins.delete(sessionId);
    this.activeTurnContexts.set(sessionId, {
      platformTurnId: context.turnId,
      originTurnId: context.originTurnId,
      causeChildId: context.causeChildId,
      dshIntTurn: context.dshIntTurn,
    });
    if (typeof context.dshIntTurn === 'number') {
      this.dshIntTurnMap.set(`${sessionId}:${context.dshIntTurn}`, {
        platformTurnId: context.turnId,
        originTurnId: context.originTurnId,
        causeChildId: context.causeChildId,
      });
    }
    return () => {
      const cur = this.activeTurnContexts.get(sessionId);
      if (cur?.platformTurnId === context.turnId) {
        this.activeTurnContexts.delete(sessionId);
      }
    };
  }

  recordChildInitiation(childId: string, originatingTurnId: string): void {
    if (childId && originatingTurnId) {
      this.childOriginMap.set(childId, originatingTurnId);
    }
  }

  resolveOriginTurnId(childId: string): string | undefined {
    if (!childId) return undefined;
    return this.childOriginMap.get(childId);
  }

  private extractStructuredJob(data: any): { jobId: string; jobName?: string } | undefined {
    if (!data || typeof data !== 'object') return undefined;
    const candidates = [
      data,
      data.meta,
      data.result,
      data.value,
      data.data,
      data.message?.meta,
      data.message?.data,
    ];
    for (const c of candidates) {
      if (!c || typeof c !== 'object') continue;
      const jobId = typeof c.jobId === 'string' && c.jobId.trim().length > 0 ? c.jobId.trim()
        : typeof c.job_id === 'string' && c.job_id.trim().length > 0 ? c.job_id.trim()
        : undefined;
      if (jobId) {
        const jobName = typeof c.jobName === 'string' && c.jobName.trim().length > 0 ? c.jobName.trim()
          : typeof c.workflowName === 'string' && c.workflowName.trim().length > 0 ? c.workflowName.trim()
          : typeof c.name === 'string' && c.name.trim().length > 0 ? c.name.trim()
          : typeof c.label === 'string' && c.label.trim().length > 0 ? c.label.trim()
          : undefined;
        return { jobId, jobName };
      }
    }
    if (Array.isArray(data.message?.content)) {
      for (const block of data.message.content) {
        if (!block || typeof block !== 'object') continue;
        const jobId = typeof block.jobId === 'string' && block.jobId.trim().length > 0 ? block.jobId.trim()
          : typeof block.job_id === 'string' && block.job_id.trim().length > 0 ? block.job_id.trim()
          : typeof block.meta?.jobId === 'string' && block.meta.jobId.trim().length > 0 ? block.meta.jobId.trim()
          : undefined;
        if (jobId) {
          const jobName = typeof block.jobName === 'string' && block.jobName.trim().length > 0 ? block.jobName.trim()
            : typeof block.label === 'string' && block.label.trim().length > 0 ? block.label.trim()
            : typeof block.meta?.name === 'string' && block.meta.name.trim().length > 0 ? block.meta.name.trim()
            : undefined;
          return { jobId, jobName };
        }
      }
    }
    return undefined;
  }

  private extractStructuredSubagent(data: any): string | undefined {
    if (!data || typeof data !== 'object') return undefined;
    const candidates = [
      data,
      data.meta,
      data.result,
      data.value,
      data.data,
      data.message?.meta,
      data.message?.data,
    ];
    for (const c of candidates) {
      if (!c || typeof c !== 'object') continue;
      const subId = typeof c.subagentId === 'string' && c.subagentId.trim().length > 0 ? c.subagentId.trim()
        : typeof c.subagent_id === 'string' && c.subagent_id.trim().length > 0 ? c.subagent_id.trim()
        : undefined;
      if (subId) return subId;
    }
    if (Array.isArray(data.message?.content)) {
      for (const block of data.message.content) {
        if (!block || typeof block !== 'object') continue;
        const subId = typeof block.subagentId === 'string' && block.subagentId.trim().length > 0 ? block.subagentId.trim()
          : typeof block.meta?.subagentId === 'string' && block.meta.subagentId.trim().length > 0 ? block.meta.subagentId.trim()
          : undefined;
        if (subId) return subId;
      }
    }
    return undefined;
  }

  private extractChildInfoFromToolResult(event: SessionEvent, sessionId?: string): { childId: string; jobName?: string; isJob: boolean } | undefined {
    try {
      const data = event.data as any;
      if (!data || typeof data !== 'object') return undefined;

      // 1. Structured fields prefer
      const structuredJob = this.extractStructuredJob(data);
      if (structuredJob) {
        return { childId: structuredJob.jobId, jobName: structuredJob.jobName, isJob: true };
      }
      const structuredSubagent = this.extractStructuredSubagent(data);
      if (structuredSubagent) {
        return { childId: structuredSubagent, isJob: false };
      }

      // 2. Text patterns from message content
      const cleanId = (id: string) => id.replace(/[.,;:\s]+$/, '').trim();
      const msg = data.message;
      if (msg) {
        const texts: string[] = [];
        const collect = (val: unknown) => {
          if (!val) return;
          if (typeof val === 'string') {
            texts.push(val);
          } else if (Array.isArray(val)) {
            for (const item of val) collect(item);
          } else if (typeof val === 'object') {
            if (typeof (val as any).text === 'string') texts.push((val as any).text);
            if ((val as any).content) collect((val as any).content);
          }
        };
        collect(msg.content);

        for (const txt of texts) {
          // (a) Workflow tool pattern: workflow "<name>" started in the background as job <jobId>
          const wfMatch = txt.match(/workflow\s+["']([^"']+)["']\s+started\s+in\s+the\s+background\s+as\s+job\s+([A-Za-z0-9_\-:.]{1,128})/i)
            ?? txt.match(/workflow\s+([^\s]+)\s+started\s+in\s+the\s+background\s+as\s+job\s+([A-Za-z0-9_\-:.]{1,128})/i);
          if (wfMatch) {
            return { childId: cleanId(wfMatch[2]), jobName: wfMatch[1].trim(), isJob: true };
          }

          // (b) Generic "started in the background as job <id>"
          const bgAsJobMatch = txt.match(/started\s+in\s+the\s+background\s+as\s+job\s+([A-Za-z0-9_\-:.]{1,128})/i);
          if (bgAsJobMatch) {
            let jobName: string | undefined;
            if (sessionId) {
              const callId = this.extractCallIdFromToolResult(event);
              const pending = this.sessionPendingToolCalls.get(sessionId);
              const matched = callId && pending ? pending.find(p => p.callId === callId) : pending?.[0];
              jobName = matched?.jobName;
            }
            return { childId: cleanId(bgAsJobMatch[1]), jobName, isJob: true };
          }

          // (c) "started background [subagent] job <id>"
          const bgJobMatch = txt.match(/started\s+background\s+(?:subagent\s+)?job\s+([A-Za-z0-9_\-:.]{1,128})/i);
          if (bgJobMatch) {
            let jobName: string | undefined;
            if (sessionId) {
              const callId = this.extractCallIdFromToolResult(event);
              const pending = this.sessionPendingToolCalls.get(sessionId);
              const matched = callId && pending ? pending.find(p => p.callId === callId) : pending?.[0];
              jobName = matched?.jobName;
            }
            return { childId: cleanId(bgJobMatch[1]), jobName, isJob: true };
          }

          // (d) "started subagent <id>"
          const subMatch = txt.match(/started\s+subagent\s+([A-Za-z0-9_\-:.]{1,128})/i);
          if (subMatch) {
            return { childId: cleanId(subMatch[1]), isJob: false };
          }
        }
      }
    } catch {}
    return undefined;
  }

  private extractChildIdFromToolResult(event: SessionEvent): string | undefined {
    return this.extractChildInfoFromToolResult(event)?.childId;
  }

  private extractChildIdFromStructuredSource(source: unknown, sessionId?: string, itemOrData?: unknown): string | undefined {
    if (!source || typeof source !== 'object') return undefined;
    const s = source as Record<string, unknown>;
    if ((s.kind === 'subagent-settled' || s.kind === 'agent-message') && typeof s.senderSessionId === 'string' && s.senderSessionId.trim().length > 0) {
      return s.senderSessionId.trim();
    }
    if (s.kind === 'tool-jobs' || (s.kind === 'plugin' && s.plugin === 'tool-jobs')) {
      // (1) Resolve from structured fields if present
      const structuredJobId = typeof s.jobId === 'string' && s.jobId.trim().length > 0 ? s.jobId.trim()
        : typeof s.job_id === 'string' && s.job_id.trim().length > 0 ? s.job_id.trim()
        : typeof s.id === 'string' && s.id.trim().length > 0 ? s.id.trim()
        : (itemOrData && typeof itemOrData === 'object') ? (
            typeof (itemOrData as any).jobId === 'string' && (itemOrData as any).jobId.trim().length > 0 ? (itemOrData as any).jobId.trim()
            : typeof (itemOrData as any).job_id === 'string' && (itemOrData as any).job_id.trim().length > 0 ? (itemOrData as any).job_id.trim()
            : typeof (itemOrData as any).meta?.jobId === 'string' && (itemOrData as any).meta.jobId.trim().length > 0 ? (itemOrData as any).meta.jobId.trim()
            : undefined
          ) : undefined;

      if (structuredJobId) {
        if (sessionId) {
          const jobs = this.sessionJobs.get(sessionId);
          if (jobs) {
            const match = jobs.find(j => !j.matched && j.jobId === structuredJobId);
            if (match) match.matched = true;
          }
        }
        return structuredJobId;
      }

      // (2) Resolve from summary by matching the job NAME recorded at start (workflow name) within the same session
      const summary = typeof s.summary === 'string' ? s.summary
        : (itemOrData && typeof itemOrData === 'object' && typeof (itemOrData as any).summary === 'string') ? (itemOrData as any).summary
        : '';

      if (sessionId && summary) {
        const jobs = this.sessionJobs.get(sessionId);
        if (jobs && jobs.length > 0) {
          const unmatchedWithNames = jobs.filter(j => !j.matched && typeof j.jobName === 'string' && j.jobName.trim().length > 0);
          unmatchedWithNames.sort((a, b) => (b.jobName?.length ?? 0) - (a.jobName?.length ?? 0));
          for (const candidate of unmatchedWithNames) {
            const name = candidate.jobName!.trim();
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const nameRegex = new RegExp(`(?:^|[\\s"':,])${escaped}(?:[\\s"'\\],:]|$)`, 'i');
            if (nameRegex.test(summary) || summary.includes(name)) {
              candidate.matched = true;
              return candidate.jobId;
            }
          }
        }
      }

      // (3) Fall back to the most recent unmatched job mapping of that session
      if (sessionId) {
        const jobs = this.sessionJobs.get(sessionId);
        if (jobs && jobs.length > 0) {
          const unmatched = jobs.filter(j => !j.matched);
          if (unmatched.length > 0) {
            const fallbackJob = unmatched[unmatched.length - 1];
            fallbackJob.matched = true;
            return fallbackJob.jobId;
          }
        }
      }

      // (4) Fallback: match from summary regex or content text for standalone/legacy events
      if (summary) {
        const match = summary.match(/(?:job\s+)?([a-zA-Z0-9_\-]+-\d+)/i);
        if (match) return match[1].replace(/[.,;:\s]+$/, '').trim();
      }

      if (itemOrData && typeof itemOrData === 'object') {
        const msg = (itemOrData as any).message ?? itemOrData;
        const texts: string[] = [];
        const collect = (val: any) => {
          if (!val) return;
          if (typeof val === 'string') texts.push(val);
          else if (Array.isArray(val)) for (const item of val) collect(item);
          else if (typeof val === 'object') {
            if (typeof val.text === 'string') texts.push(val.text);
            if (val.content) collect(val.content);
          }
        };
        collect(msg.content ?? (itemOrData as any).content);
        for (const txt of texts) {
          const textMatch = txt.match(/background\s+job\s+([A-Za-z0-9_\-:.]{1,128})/i);
          if (textMatch) return textMatch[1].replace(/[.,;:\s]+$/, '').trim();
        }
      }
    }
    return undefined;
  }

  private extractCallIdFromToolCall(event: SessionEvent): string | undefined {
    const data = event.data as any;
    if (!data) return undefined;
    if (typeof data.callId === 'string' && data.callId.length > 0) {
      return data.callId;
    }
    if (typeof data.toolCallId === 'string' && data.toolCallId.length > 0) {
      return data.toolCallId;
    }
    if (typeof data.call_id === 'string' && data.call_id.length > 0) {
      return data.call_id;
    }
    if (typeof data.id === 'string' && data.id.length > 0) {
      return data.id;
    }
    if (typeof data.message?.source?.callId === 'string' && data.message.source.callId.length > 0) {
      return data.message.source.callId;
    }
    if (typeof data.message?.callId === 'string' && data.message.callId.length > 0) {
      return data.message.callId;
    }
    if (typeof data.message?.toolCallId === 'string' && data.message.toolCallId.length > 0) {
      return data.message.toolCallId;
    }
    if (typeof data.message?.call_id === 'string' && data.message.call_id.length > 0) {
      return data.message.call_id;
    }
    if (typeof data.message?.id === 'string' && data.message.id.length > 0) {
      return data.message.id;
    }
    return undefined;
  }

  private extractCallIdFromToolResult(event: SessionEvent): string | undefined {
    const data = event.data as any;
    if (!data) return undefined;
    if (typeof data.message?.source?.callId === 'string' && data.message.source.callId.length > 0) {
      return data.message.source.callId;
    }
    if (typeof data.message?.source?.toolCallId === 'string' && data.message.source.toolCallId.length > 0) {
      return data.message.source.toolCallId;
    }
    if (Array.isArray(data.message?.content)) {
      for (const block of data.message.content) {
        if (!block || typeof block !== 'object') continue;
        if (typeof block.toolCallId === 'string' && block.toolCallId.length > 0) {
          return block.toolCallId;
        }
        if (typeof block.callId === 'string' && block.callId.length > 0) {
          return block.callId;
        }
        if (typeof block.call_id === 'string' && block.call_id.length > 0) {
          return block.call_id;
        }
      }
    }
    if (typeof data.message?.toolCallId === 'string' && data.message.toolCallId.length > 0) {
      return data.message.toolCallId;
    }
    if (typeof data.message?.callId === 'string' && data.message.callId.length > 0) {
      return data.message.callId;
    }
    if (typeof data.message?.call_id === 'string' && data.message.call_id.length > 0) {
      return data.message.call_id;
    }
    if (typeof data.message?.id === 'string' && data.message.id.length > 0) {
      return data.message.id;
    }
    if (typeof data.meta?.callId === 'string' && data.meta.callId.length > 0) {
      return data.meta.callId;
    }
    if (typeof data.meta?.toolCallId === 'string' && data.meta.toolCallId.length > 0) {
      return data.meta.toolCallId;
    }
    if (typeof data.toolCallId === 'string' && data.toolCallId.length > 0) {
      return data.toolCallId;
    }
    if (typeof data.callId === 'string' && data.callId.length > 0) {
      return data.callId;
    }
    if (typeof data.call_id === 'string' && data.call_id.length > 0) {
      return data.call_id;
    }
    if (typeof data.id === 'string' && data.id.length > 0) {
      return data.id;
    }
    return undefined;
  }

  private recordPendingAutonomousOrigin(sessionId: string, childId: string): void {
    let originTurnId = this.resolveOriginTurnId(`${sessionId}:${childId}`);
    if (!originTurnId) {
      const jobs = this.sessionJobs.get(sessionId);
      const j = jobs?.find((x) => x.jobId === childId);
      if (j) originTurnId = j.originTurnId;
    }
    if (!originTurnId) {
      originTurnId = this.resolveOriginTurnId(childId);
    }
    if (originTurnId) {
      let list = this.pendingAutonomousOrigins.get(sessionId);
      if (!list) {
        list = [];
        this.pendingAutonomousOrigins.set(sessionId, list);
      }
      list.push({ originTurnId, causeChildId: childId });
    }
  }

  attachSession(session: Session, agentCtx?: Context): () => void {
    if (agentCtx && typeof agentCtx.on === 'function') {
      return this.attachAgent(agentCtx);
    }
    return () => {};
  }

  ingest(session: Session, event: SessionEvent): RelayEnvelope {
    const sessionId = session.id as string;
    const envelope = this.buffer.push(sessionId, event);

    // Record safe diagnostic count (event type only)
    this.ingestedEventTypes[event.type] = (this.ingestedEventTypes[event.type] || 0) + 1;

    // Notify real-time subscribers
    for (const subscriber of this.subscribers) {
      try {
        subscriber(envelope);
      } catch (_subErr: unknown) {
        this.subscriberErrorCount++;
      }
    }

    // Convert DSH session event into streaming event frames (at most once per event seq)
    const lastSeq = this.sessionLastMappedSeq.get(sessionId) ?? -1;
    if (typeof event.seq !== 'number' || event.seq > lastSeq) {
      if (typeof event.seq === 'number') {
        this.sessionLastMappedSeq.set(sessionId, event.seq);
      }
      try {
        this.mapAndQueueStreamingFrames(sessionId, event);
      } catch (mapErr: unknown) {
        this.recordFlushFailure(mapErr);
      }
    }

    return envelope;
  }

  private getOrCreateStreamState(sessionId: string): SessionStreamState {
    let state = this.sessionStreams.get(sessionId);
    if (!state) {
      state = {
        streamId: `msgstream_${randomBytes(16).toString('hex')}`,
        accumulatedLength: 0,
      };
      this.sessionStreams.set(sessionId, state);
    }
    return state;
  }

  private getMonotonicIsoTimestamp(): string {
    const now = Date.now();
    this.lastFrameTimeMs = Math.max(now, this.lastFrameTimeMs + 1);
    return new Date(this.lastFrameTimeMs).toISOString();
  }

  private stampAndEnqueueFrames(sessionId: string, frames: ContainerStreamingEventFrame[], currentTurn?: number): void {
    if (frames.length === 0) return;
    let scopedCtx = (currentTurn !== undefined ? this.dshIntTurnMap.get(`${sessionId}:${currentTurn}`) : undefined) ?? this.activeTurnContexts.get(sessionId);
    let turnId = scopedCtx?.platformTurnId ?? (scopedCtx as any)?.turnId;
    let originTurnId = scopedCtx?.originTurnId;
    let causeChildId = scopedCtx?.causeChildId;

    if (!turnId) {
      const autoTurnId = `turn_auto_${sessionId.slice(0, 8)}_${currentTurn ?? 1}_${randomBytes(4).toString('hex')}`;
      const autoCtx = {
        platformTurnId: autoTurnId,
        originTurnId: undefined,
        causeChildId: undefined,
        dshIntTurn: currentTurn,
      };
      if (currentTurn !== undefined) {
        this.dshIntTurnMap.set(`${sessionId}:${currentTurn}`, autoCtx);
      }
      this.activeTurnContexts.set(sessionId, autoCtx);
      turnId = autoTurnId;
    }

    for (const f of frames) {
      if (turnId && !f.turnId) (f as any).turnId = turnId;
      if (originTurnId && !f.originTurnId) (f as any).originTurnId = originTurnId;
      if (causeChildId) {
        if (!(f as any).causeChildId) (f as any).causeChildId = causeChildId;
        if (f.payload && !(f.payload as any).causeChildId) (f.payload as any).causeChildId = causeChildId;
      }
      this.mappedFrameCounts[f.type] = (this.mappedFrameCounts[f.type] || 0) + 1;
    }
    this.enqueueOutboundFrames(frames);
  }

  ingestAssistantStream(session: Session, frame: AssistantStreamFrame): void {
    if (!session || !frame) return;
    const sessionId = session.id as string;
    if (!sessionId) return;

    if (frame.type === 'start') {
      const streamState: SessionStreamState = {
        streamId: `msgstream_${randomBytes(16).toString('hex')}`,
        accumulatedLength: 0,
        accumulatedReasoningLength: 0,
        turn: frame.turn,
        step: frame.step,
        ended: false,
      };
      this.sessionStreams.set(sessionId, streamState);
      return;
    }

    if (frame.type === 'chunk') {
      const chunk = frame.chunk;
      if (!chunk) return;
      const streamState = this.getOrCreateStreamState(sessionId);
      if (streamState.turn === undefined && typeof (frame as any).turn === 'number') {
        streamState.turn = (frame as any).turn;
      }
      const frames: ContainerStreamingEventFrame[] = [];

      if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
        streamState.accumulatedLength += chunk.text.length;
        frames.push({
          sessionId,
          type: 'assistant_delta',
          payload: {
            streamId: streamState.streamId,
            delta: chunk.text,
            accumulatedLength: streamState.accumulatedLength,
          },
          createdAt: this.getMonotonicIsoTimestamp(),
        });
      } else if (chunk.type === 'reasoning-delta') {
        const deltaText = typeof chunk.text === 'string'
          ? chunk.text
          : (typeof (chunk as any).delta === 'string' ? (chunk as any).delta : '');
        streamState.accumulatedReasoningLength = (streamState.accumulatedReasoningLength || 0) + deltaText.length;
        frames.push({
          sessionId,
          type: 'reasoning_delta',
          payload: {
            streamId: streamState.streamId,
            delta: deltaText,
            accumulatedLength: streamState.accumulatedReasoningLength,
            status: 'thinking',
          },
          createdAt: this.getMonotonicIsoTimestamp(),
        });
      }

      if (frames.length > 0) {
        this.stampAndEnqueueFrames(sessionId, frames, streamState.turn);
      }
      return;
    }

    if (frame.type === 'end') {
      const streamState = this.sessionStreams.get(sessionId);
      if (streamState) {
        if (!streamState.ended) {
          streamState.ended = true;
          const frames: ContainerStreamingEventFrame[] = [
            {
              sessionId,
              type: 'assistant_stream_end',
              payload: {
                streamId: streamState.streamId,
              },
              createdAt: this.getMonotonicIsoTimestamp(),
            },
          ];
          this.stampAndEnqueueFrames(sessionId, frames, streamState.turn);
        }
        if (frame.outcome) {
          streamState.outcome = frame.outcome;
        }
      }
      return;
    }
  }

  private mapAndQueueStreamingFrames(sessionId: string, event: SessionEvent): void {
    const frames: ContainerStreamingEventFrame[] = [];

    // 1. Tool result: associate returned child ID with initiating platform turn from exact DSH integer turn
    if (event.type === 'tool/result') {
      const intTurn = (event.data as any)?.turn;
      const turnCtx = (intTurn !== undefined ? this.dshIntTurnMap.get(`${sessionId}:${intTurn}`) : undefined) ?? this.activeTurnContexts.get(sessionId);
      const childInfo = this.extractChildInfoFromToolResult(event, sessionId);
      if (childInfo && turnCtx?.platformTurnId) {
        const { childId, jobName, isJob } = childInfo;
        if (isJob) {
          let jobs = this.sessionJobs.get(sessionId);
          if (!jobs) {
            jobs = [];
            this.sessionJobs.set(sessionId, jobs);
          }
          jobs.push({
            jobId: childId,
            jobName,
            originTurnId: turnCtx.platformTurnId,
            matched: false,
            createdAt: Date.now(),
          });
        }
        this.recordChildInitiation(`${sessionId}:${childId}`, turnCtx.platformTurnId);
        if (!isJob) {
          this.recordChildInitiation(childId, turnCtx.platformTurnId);
        }
        const store = this.receiptStore;
        if (store && typeof (store as any).recordChildOrigin === 'function') {
          void (store as any).recordChildOrigin(sessionId, childId, turnCtx.platformTurnId).catch(() => {});
        }
      }
    }

    // 2. Identify child settlement or message from structured source in agent/inbox/spliced or user/message
    if (!this.activeTurnSessions.has(sessionId)) {
      const eventType = event.type as string;
      if (eventType === 'agent/inbox/spliced') {
        const inserted = (event.data as any)?.inserted;
        if (Array.isArray(inserted)) {
          for (const item of inserted) {
            const childId = this.extractChildIdFromStructuredSource(
              item?.source ?? item?.message?.source,
              sessionId,
              item
            );
            if (childId) this.recordPendingAutonomousOrigin(sessionId, childId);
          }
        }
      } else if (eventType === 'user/message') {
        const childId = this.extractChildIdFromStructuredSource(
          (event.data as any)?.source ?? (event.data as any)?.message?.source,
          sessionId,
          event.data
        );
        if (childId) this.recordPendingAutonomousOrigin(sessionId, childId);
      }
    }

    // 3. Autonomous turn start
    if (event.type === 'turn/start') {
      const intTurn = (event.data as any)?.turn;
      const existing = (intTurn !== undefined ? this.dshIntTurnMap.get(`${sessionId}:${intTurn}`) : undefined) ?? this.activeTurnContexts.get(sessionId);
      if (!existing?.platformTurnId) {
        const pendingList = this.pendingAutonomousOrigins.get(sessionId);
        const pending = (pendingList && pendingList.length > 0) ? pendingList.shift() : undefined;
        if (pendingList && pendingList.length === 0) {
          this.pendingAutonomousOrigins.delete(sessionId);
        }
        const autoTurnId = `turn_auto_${sessionId.slice(0, 8)}_${intTurn ?? 1}_${randomBytes(4).toString('hex')}`;
        const autoCtx = {
          platformTurnId: autoTurnId,
          originTurnId: pending?.originTurnId,
          causeChildId: pending?.causeChildId,
          dshIntTurn: intTurn,
        };
        if (intTurn !== undefined) {
          this.dshIntTurnMap.set(`${sessionId}:${intTurn}`, autoCtx);
        }
        this.activeTurnContexts.set(sessionId, autoCtx);
      }
    }

    const currentTurn = (event.data as any)?.turn;
    const scopedCtx = (currentTurn !== undefined ? this.dshIntTurnMap.get(`${sessionId}:${currentTurn}`) : undefined) ?? this.activeTurnContexts.get(sessionId);
    const turnId = scopedCtx?.platformTurnId ?? (scopedCtx as any)?.turnId;
    const originTurnId = scopedCtx?.originTurnId;
    const causeChildId = scopedCtx?.causeChildId;

    switch (event.type) {
      case 'turn/start': {
        this.activeTurnSessions.add(sessionId);
        const streamState = {
          streamId: `msgstream_${randomBytes(16).toString('hex')}`,
          accumulatedLength: 0,
        };
        this.sessionStreams.set(sessionId, streamState);
        frames.push({
          sessionId,
          type: 'turn_started',
          payload: { status: 'running' },
          createdAt: this.getMonotonicIsoTimestamp(),
        });
        break;
      }

      case 'tool/call': {
        const streamState = this.getOrCreateStreamState(sessionId);
        const toolName = typeof event.data.name === 'string' && event.data.name.length > 0 ? event.data.name : 'tool';
        const callId = this.extractCallIdFromToolCall(event);
        const args = (event.data as any).arguments ?? (event.data as any).args;
        const jobName = typeof args?.meta?.name === 'string' ? args.meta.name
          : typeof args?.label === 'string' ? args.label
          : typeof args?.description === 'string' ? args.description
          : undefined;
        streamState.activeToolName = toolName;

        if (callId) {
          let toolMap = this.sessionToolCalls.get(sessionId);
          if (!toolMap) {
            toolMap = new Map();
            this.sessionToolCalls.set(sessionId, toolMap);
          }
          toolMap.set(callId, toolName);
        }

        let pendingList = this.sessionPendingToolCalls.get(sessionId);
        if (!pendingList) {
          pendingList = [];
          this.sessionPendingToolCalls.set(sessionId, pendingList);
        }
        pendingList.push({ callId, toolName, jobName });

        const payload: Record<string, unknown> = {
          toolName,
          status: 'started',
        };
        if (callId) {
          payload.callId = callId;
        }

        const frame: ContainerStreamingEventFrame = {
          sessionId,
          type: 'tool_started',
          payload,
          createdAt: this.getMonotonicIsoTimestamp(),
        };
        if (callId) {
          (frame as any).callId = callId;
        }
        frames.push(frame);
        break;
      }

      case 'tool/result': {
        const streamState = this.getOrCreateStreamState(sessionId);
        const callId = this.extractCallIdFromToolResult(event);
        const toolMap = this.sessionToolCalls.get(sessionId);
        const pendingList = this.sessionPendingToolCalls.get(sessionId);

        let resolvedToolName: string | undefined;
        let resolvedCallId: string | undefined = callId;

        if (callId && toolMap?.has(callId)) {
          resolvedToolName = toolMap.get(callId);
          toolMap.delete(callId);
          if (toolMap.size === 0) {
            this.sessionToolCalls.delete(sessionId);
          }
          if (pendingList) {
            const idx = pendingList.findIndex((item) => item.callId === callId);
            if (idx !== -1) {
              pendingList.splice(idx, 1);
            }
            if (pendingList.length === 0) {
              this.sessionPendingToolCalls.delete(sessionId);
            }
          }
        } else if (pendingList && pendingList.length > 0) {
          const idx = callId ? pendingList.findIndex((item) => item.callId === callId) : -1;
          const [matched] = idx !== -1 ? pendingList.splice(idx, 1) : [pendingList.shift()!];
          resolvedToolName = matched.toolName;
          if (!resolvedCallId) {
            resolvedCallId = matched.callId;
          }
          if (matched.callId && toolMap) {
            toolMap.delete(matched.callId);
            if (toolMap.size === 0) {
              this.sessionToolCalls.delete(sessionId);
            }
          }
          if (pendingList.length === 0) {
            this.sessionPendingToolCalls.delete(sessionId);
          }
        }

        if (!resolvedToolName) {
          const directName = (event.data as any).name ?? (event.data as any).toolName ?? (event.data as any).tool_name ?? (event.data as any).message?.name ?? (event.data as any).message?.toolName ?? (event.data as any).meta?.toolName ?? (event.data as any).meta?.name;
          if (typeof directName === 'string' && directName.length > 0) {
            resolvedToolName = directName;
          }
        }

        const toolName = resolvedToolName ?? streamState.activeToolName ?? 'tool';
        const msgContent = (event.data.message as any)?.content;
        const hasContentError = Array.isArray(msgContent)
          ? msgContent.some((c: any) => c && (c.isError === true || c.type === 'tool-error'))
          : false;
        const hasError = Boolean(
          event.data.error ||
          (event.data as any).isError ||
          (event.data.message as any)?.isError ||
          hasContentError
        );

        const payload: Record<string, unknown> = {
          toolName,
          status: hasError ? 'failed' : 'completed',
        };
        if (resolvedCallId) {
          payload.callId = resolvedCallId;
        }

        const frame: ContainerStreamingEventFrame = {
          sessionId,
          type: 'tool_completed',
          payload,
          createdAt: this.getMonotonicIsoTimestamp(),
        };
        if (resolvedCallId) {
          (frame as any).callId = resolvedCallId;
        }
        frames.push(frame);

        const remainingPending = this.sessionPendingToolCalls.get(sessionId);
        streamState.activeToolName = remainingPending && remainingPending.length > 0
          ? remainingPending[remainingPending.length - 1].toolName
          : undefined;
        break;
      }

      case 'assistant/message': {
        const streamState = this.getOrCreateStreamState(sessionId);
        if (!streamState.ended) {
          streamState.ended = true;
          frames.push({
            sessionId,
            type: 'assistant_stream_end',
            payload: {
              streamId: streamState.streamId,
            },
            createdAt: this.getMonotonicIsoTimestamp(),
          });
        }
        break;
      }

      case 'turn/end': {
        const reasonKind = event.data.reason?.kind;
        const streamState = this.sessionStreams.get(sessionId);

        if (streamState && !streamState.ended) {
          streamState.ended = true;
          frames.push({
            sessionId,
            type: 'assistant_stream_end',
            payload: {
              streamId: streamState.streamId,
            },
            createdAt: this.getMonotonicIsoTimestamp(),
          });
        }

        if (reasonKind === 'aborted' || reasonKind === 'interrupted') {
          frames.push({
            sessionId,
            type: 'turn_cancelled',
            payload: {
              status: 'interrupted',
              code: 'TURN_CANCELLED',
            },
            createdAt: this.getMonotonicIsoTimestamp(),
          });
        } else if (reasonKind === 'error' || reasonKind === 'blocked') {
          frames.push({
            sessionId,
            type: 'turn_failed',
            payload: {
              status: 'failed',
              code: 'TURN_FAILED',
            },
            createdAt: this.getMonotonicIsoTimestamp(),
          });
        } else {
          frames.push({
            sessionId,
            type: 'turn_completed',
            payload: {
              status: 'completed',
            },
            createdAt: this.getMonotonicIsoTimestamp(),
          });
        }

        this.sessionStreams.delete(sessionId);
        this.activeTurnSessions.delete(sessionId);
        this.sessionToolCalls.delete(sessionId);
        this.sessionPendingToolCalls.delete(sessionId);
        if (scopedCtx?.platformTurnId && this.activeTurnContexts.get(sessionId)?.platformTurnId === scopedCtx.platformTurnId) {
          this.activeTurnContexts.delete(sessionId);
        }
        break;
      }
    }

    if (frames.length > 0) {
      this.stampAndEnqueueFrames(sessionId, frames, currentTurn);
    }
  }

  private enqueueOutboundFrames(frames: ContainerStreamingEventFrame[]): void {
    for (const frame of frames) {
      const estimatedBytes = JSON.stringify(frame).length;

      // Backpressure check: if pending bytes exceed maxPendingBytes (256KB),
      // drop intermediate assistant_delta frames to avoid memory exhaustion
      if (this.pendingOutboundBytes + estimatedBytes > this.maxPendingBytes) {
        if (frame.type === 'assistant_delta' || frame.type === 'reasoning_delta') {
          this.droppedDeltaCount++;
          continue;
        } else {
          // For non-delta control frames, drop oldest assistant_delta or reasoning_delta from buffer if needed
          while (
            this.pendingOutboundBytes + estimatedBytes > this.maxPendingBytes &&
            this.pendingOutboundFrames.length > 0
          ) {
            const deltaIdx = this.pendingOutboundFrames.findIndex((f) => f.type === 'assistant_delta' || f.type === 'reasoning_delta');
            if (deltaIdx >= 0) {
              const dropped = this.pendingOutboundFrames.splice(deltaIdx, 1)[0];
              this.pendingOutboundBytes -= JSON.stringify(dropped).length;
              this.droppedDeltaCount++;
            } else {
              break;
            }
          }
        }
      }

      this.pendingOutboundFrames.push(frame);
      this.pendingOutboundBytes += estimatedBytes;
    }

    // Trigger immediate flush if batch size threshold reached
    if (this.pendingOutboundBytes >= this.maxBatchSizeBytes) {
      void this.flushOutbound().catch((flushErr: unknown) => {
        this.recordFlushFailure(flushErr);
      });
    }
  }

  private async flushOutbound(force = false): Promise<void> {
    if (this.isFlushing) {
      if (Date.now() - this.flushStartedAt > this.flushTimeoutMs + 5000) {
        this.isFlushing = false;
      } else {
        return;
      }
    }
    if ((!force && Date.now() < this.nextFlushAllowedAt) || this.pendingOutboundFrames.length === 0) {
      return;
    }
    this.isFlushing = true;
    this.flushStartedAt = Date.now();

    try {
      while (this.pendingOutboundFrames.length > 0) {
        let batchBytes = 0;
        let count = 0;
        while (count < this.pendingOutboundFrames.length && count < 100) {
          const frameBytes = JSON.stringify(this.pendingOutboundFrames[count]).length;
          if (count > 0 && batchBytes + frameBytes > this.maxBatchSizeBytes) {
            break;
          }
          batchBytes += frameBytes;
          count++;
        }
        const batch = this.pendingOutboundFrames.splice(0, count);
        this.pendingOutboundBytes = Math.max(0, this.pendingOutboundBytes - batchBytes);

        const client = this.platformClient;
        if (client && typeof client.request === 'function') {
          let timer: NodeJS.Timeout | undefined;
          try {
            const reqPromise = client.request('/api/events', {
              method: 'POST',
              body: { events: batch },
              timeoutMs: this.flushTimeoutMs,
            });
            const timeoutPromise = new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`Event relay flush request timed out after ${this.flushTimeoutMs}ms`)),
                this.flushTimeoutMs
              );
            });
            const res = await Promise.race([reqPromise, timeoutPromise]);
            const statusKey = String((res && typeof res === 'object' && 'status' in res) ? res.status : 200);
            this.platformPostStatusCounts[statusKey] = (this.platformPostStatusCounts[statusKey] || 0) + 1;
            this.flushCount++;
          } catch (reqErr: unknown) {
            this.platformPostStatusCounts['network_error'] = (this.platformPostStatusCounts['network_error'] || 0) + 1;
            this.recordFlushFailure(reqErr);

            const toRequeue = batch.filter((f) => !(f as any).__retried);
            for (const f of toRequeue) {
              (f as any).__retried = true;
            }
            if (toRequeue.length > 0) {
              this.pendingOutboundFrames.unshift(...toRequeue);
              let requeueBytes = 0;
              for (const f of toRequeue) {
                requeueBytes += JSON.stringify(f).length;
              }
              this.pendingOutboundBytes += requeueBytes;

              while (this.pendingOutboundBytes > this.maxPendingBytes && this.pendingOutboundFrames.length > 0) {
                const deltaIdx = this.pendingOutboundFrames.findIndex((f) => f.type === 'assistant_delta' || f.type === 'reasoning_delta');
                if (deltaIdx >= 0) {
                  const dropped = this.pendingOutboundFrames.splice(deltaIdx, 1)[0];
                  this.pendingOutboundBytes -= JSON.stringify(dropped).length;
                  this.droppedDeltaCount++;
                } else {
                  const dropped = this.pendingOutboundFrames.pop()!;
                  this.pendingOutboundBytes -= JSON.stringify(dropped).length;
                  this.droppedDeltaCount++;
                }
              }
            }

            this.nextFlushAllowedAt = Date.now() + this.flushBackoffMs;
            console.warn('[dsh-event-relay] Outbound flush failed, re-queued batch:', {
              batchCount: batch.length,
              requeuedCount: toRequeue.length,
              pendingFramesCount: this.pendingOutboundFrames.length,
              pendingBytes: this.pendingOutboundBytes,
              error: reqErr instanceof Error ? reqErr.message : String(reqErr),
            });
            break;
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
      }
    } finally {
      this.isFlushing = false;
    }
  }

  async flush(): Promise<void> {
    await this.flushOutbound(true);
  }

  feedHistoricalEvents(session: Session, events: readonly SessionEvent[]): number {
    const sessionId = session.id as string;
    return this.buffer.feedHistoricalEvents(sessionId, events);
  }

  async poll(options: PollEventsOptions): Promise<PollEventsResult> {
    if (!options.sessionId || options.sessionId.trim().length === 0) {
      throw new EventRelayValidationError('sessionId is required for poll()');
    }

    const sessionId = options.sessionId.trim();

    // Query receiptStore for acknowledged cursor if not known
    let ackedCursor: string | null = null;
    const store = this.receiptStore;
    if (store) {
      const stored = await store.getEventCursor(sessionId, this.consumer);
      if (stored) {
        ackedCursor = stored.cursorValue;
        this.buffer.setAcknowledgedSeq(sessionId, parseCursorSeq(stored.cursorValue));
      }
    }

    const effectiveAfterCursor = options.afterCursor ?? (ackedCursor ?? undefined);

    const result = this.buffer.poll({
      sessionId,
      afterCursor: effectiveAfterCursor,
      limit: options.limit,
    });

    return {
      ...result,
      acknowledgedCursor: ackedCursor ?? result.acknowledgedCursor,
    };
  }

  async ack(sessionId: string, cursor: string, consumer?: string): Promise<void> {
    if (!sessionId || sessionId.trim().length === 0) {
      throw new EventRelayValidationError('sessionId is required for ack()');
    }
    if (!cursor || cursor.trim().length === 0) {
      throw new EventRelayValidationError('cursor is required for ack()');
    }

    const targetSessionId = sessionId.trim();
    const targetConsumer = consumer ?? this.consumer;

    // 1. Persist to receiptStore first (FAIL LOUD - do not catch/swallow).
    // If persistence throws, execution stops immediately and buffer is NOT trimmed.
    const store = this.receiptStore;
    if (store) {
      await store.setEventCursor({
        sessionId: targetSessionId,
        consumer: targetConsumer,
        cursorValue: cursor,
      });
    }

    // 2. Trim in-memory buffer ONLY after persistent store successfully records cursor
    this.buffer.ack(targetSessionId, cursor);
  }

  async getAcknowledgedCursor(sessionId: string, consumer?: string): Promise<string | null> {
    if (!sessionId || sessionId.trim().length === 0) {
      throw new EventRelayValidationError('sessionId is required');
    }

    const targetSessionId = sessionId.trim();
    const targetConsumer = consumer ?? this.consumer;

    const store = this.receiptStore;
    if (store) {
      const stored = await store.getEventCursor(targetSessionId, targetConsumer);
      if (stored) {
        return stored.cursorValue;
      }
    }

    const inMemSeq = this.buffer.getAcknowledgedSeq(targetSessionId);
    return inMemSeq > 0 ? `${targetSessionId}:${inMemSeq}` : null;
  }

  subscribe(listener: RelaySubscriber): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  clear(): void {
    this.isDisposed = true;
    this.stopBatchTimer();
    this.pendingOutboundFrames = [];
    this.pendingOutboundBytes = 0;
    this.sessionStreams.clear();
    this.activeTurnSessions.clear();
    this.sessionToolCalls.clear();
    this.sessionPendingToolCalls.clear();
    this.sessionJobs.clear();
    this.pendingAutonomousOrigins.clear();
    this.activeTurnContexts.clear();
    this.dshIntTurnMap.clear();
    this.childOriginMap.clear();
    this.buffer.clear();
    this.subscribers.clear();
  }
}
