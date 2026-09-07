import { describe, it, expect } from 'vitest';
import {
  ProtocolHeaders,
  makeContainerId,
  makeWorkspaceId,
  makeSessionId,
  makeRunId,
  makeRequestId,
  type ContainerHandshakeRequest,
  type ContainerHeartbeatRequest,
  type RunStateChangeEvent,
  type ApprovalRequestPayload,
} from '../src/index.js';

describe('Protocol Wire Types & Headers', () => {
  it('defines standard wire headers correctly', () => {
    expect(ProtocolHeaders.REQUEST_ID).toBe('x-request-id');
    expect(ProtocolHeaders.CORRELATION_ID).toBe('x-correlation-id');
    expect(ProtocolHeaders.CONTAINER_ID).toBe('x-enkeep-container-id');
    expect(ProtocolHeaders.SESSION_ID).toBe('x-enkeep-session-id');
    expect(ProtocolHeaders.RUN_ID).toBe('x-enkeep-run-id');
    expect(ProtocolHeaders.WORKSPACE_ID).toBe('x-enkeep-workspace-id');
    expect(ProtocolHeaders.TIMESTAMP).toBe('x-enkeep-timestamp');
  });

  it('correctly constructs type-safe handshake request payload', () => {
    const req: ContainerHandshakeRequest = {
      containerId: makeContainerId('container-dsh-1'),
      workspaceId: makeWorkspaceId('ws-default'),
      clientVersion: '0.1.0',
      dshVersion: '1.0.0',
      nodeVersion: process.version,
      startedAt: new Date().toISOString(),
      metadata: { memoryMb: 512 },
    };

    expect(req.containerId).toBe('container-dsh-1');
    expect(req.workspaceId).toBe('ws-default');
    expect(req.clientVersion).toBe('0.1.0');
  });

  it('correctly constructs type-safe heartbeat request payload', () => {
    const req: ContainerHeartbeatRequest = {
      containerId: makeContainerId('container-dsh-1'),
      state: 'ready',
      activeRunsCount: 0,
      timestamp: new Date().toISOString(),
    };

    expect(req.state).toBe('ready');
    expect(req.activeRunsCount).toBe(0);
  });

  it('correctly constructs type-safe run state event payload', () => {
    const event: RunStateChangeEvent = {
      eventId: makeRequestId('evt-123'),
      runId: makeRunId('run-456'),
      sessionId: makeSessionId('sess-789'),
      containerId: makeContainerId('container-dsh-1'),
      status: 'completed',
      resultSummary: { exitCode: 0 },
      timestamp: new Date().toISOString(),
    };

    expect(event.status).toBe('completed');
    expect(event.runId).toBe('run-456');
  });

  it('correctly constructs type-safe approval request payload', () => {
    const approval: ApprovalRequestPayload = {
      approvalId: makeRequestId('appr-001'),
      runId: makeRunId('run-002'),
      sessionId: makeSessionId('sess-003'),
      containerId: makeContainerId('container-004'),
      actionType: 'bash_exec',
      actionDetails: { command: 'rm -rf /tmp/test' },
      timestamp: new Date().toISOString(),
    };

    expect(approval.actionType).toBe('bash_exec');
    expect(approval.approvalId).toBe('appr-001');
  });
});
