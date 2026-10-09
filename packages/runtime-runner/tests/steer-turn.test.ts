/**
 * Deterministic Test Suite for D-01 & D-02 (Runtime Runner Steer Protocol and Daemon Injection)
 *
 * Verifies:
 * 1. Protocol framing: SteerRequest encoding / decoding, validation of parameters.
 * 2. Daemon handleSteer:
 *    - Running turn matches expectedTurnId -> agent.steer called with UserMessage.
 *    - Attachments -> agent.inject called before agent.steer.
 *    - Agent idle or not running -> returns ok: false, TURN_NOT_RUNNING error.
 *    - TurnId mismatch -> returns ok: false, TURN_NOT_RUNNING error.
 * 3. Transport and Adapter pass-through: Host & Docker adapter and transport call steerTurn.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  DAEMON_OPS,
  DAEMON_ERROR_CODES,
  decodeDaemonRequest,
  decodeDaemonMessage,
  encodeDaemonMessage,
  type SteerRequest,
  type SteerResponse,
  DaemonProtocolError,
} from '../src/runtime/daemon-protocol.js';
import { RuntimeDaemon } from '../src/runtime/daemon.js';

describe('D-01: Daemon Protocol Steer Framing & Validation', () => {
  it('correctly decodes valid SteerRequest and encodes SteerResponse', () => {
    const steerReq: SteerRequest = {
      id: 'req_steer_001',
      op: 'steer',
      sessionId: 'ses_00000000000000000000000000000001',
      expectedTurnId: 'turn_00000000000000000000000000000001',
      message: 'Please focus only on step 2',
      clientRequestId: 'cr_00000001',
    };

    const encoded = encodeDaemonMessage(steerReq);
    const decoded = decodeDaemonRequest(encoded) as SteerRequest;

    expect(decoded.op).toBe(DAEMON_OPS.STEER);
    expect(decoded.sessionId).toBe(steerReq.sessionId);
    expect(decoded.expectedTurnId).toBe(steerReq.expectedTurnId);
    expect(decoded.message).toBe(steerReq.message);
    expect(decoded.clientRequestId).toBe(steerReq.clientRequestId);

    const steerResp: SteerResponse = {
      id: 'req_steer_001',
      op: 'steer',
      ok: true,
      steered: true,
      sessionId: steerReq.sessionId,
      turnId: steerReq.expectedTurnId,
      clientRequestId: steerReq.clientRequestId,
    };

    const encodedResp = encodeDaemonMessage(steerResp);
    const decodedResp = decodeDaemonMessage(encodedResp) as SteerResponse;
    expect(decodedResp.ok).toBe(true);
    expect(decodedResp.steered).toBe(true);
    expect(decodedResp.turnId).toBe(steerReq.expectedTurnId);
  });

  it('rejects SteerRequest with missing mandatory fields', () => {
    expect(() => {
      decodeDaemonRequest(
        Buffer.from(
          JSON.stringify({
            id: 'req_bad',
            op: 'steer',
            sessionId: '',
            expectedTurnId: 'turn_1',
            message: 'hello',
          }),
          'utf8'
        )
      );
    }).toThrow(DaemonProtocolError);

    expect(() => {
      decodeDaemonRequest(
        Buffer.from(
          JSON.stringify({
            id: 'req_bad',
            op: 'steer',
            sessionId: 'ses_1',
            expectedTurnId: '',
            message: 'hello',
          }),
          'utf8'
        )
      );
    }).toThrow(DaemonProtocolError);

    expect(() => {
      decodeDaemonRequest(
        Buffer.from(
          JSON.stringify({
            id: 'req_bad',
            op: 'steer',
            sessionId: 'ses_1',
            expectedTurnId: 'turn_1',
            message: '',
          }),
          'utf8'
        )
      );
    }).toThrow(DaemonProtocolError);
  });
});

describe('D-02: RuntimeDaemon handleSteer soft-guidance injection', () => {
  let tmpDir: string;
  let dshHome: string;
  let spacesDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-steer-test-'));
    dshHome = path.join(tmpDir, 'alice', '.dsh');
    spacesDir = path.join(tmpDir, 'alice', 'spaces');
    fs.mkdirSync(dshHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spacesDir, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('calls agent.steer when agent is running and expectedTurnId matches', async () => {
    const daemon = new RuntimeDaemon({
      userId: 'alice',
      dshHome,
      spacesDir,
    });

    const mockAgent = {
      steer: vi.fn(),
      inject: vi.fn(),
      session: { seq: 5 },
    };

    const sessionId = 'ses_00000000000000000000000000000001';
    const turnId = 'turn_00000000000000000000000000000001';

    // Seed running agent entry in daemon
    (daemon as any).isStarted = true;
    (daemon as any).agents.set(sessionId, {
      sessionId,
      agent: mockAgent,
      status: 'running',
      pendingQueue: [],
      lastUsed: Date.now(),
      currentTurn: {
        turnId,
        item: { request: { turnId, sessionId } },
        startedAt: Date.now(),
        cancelRequested: false,
      },
    });

    (daemon as any).currentTurns.set(sessionId, {
      turnId,
      item: { request: { turnId, sessionId } },
      startedAt: Date.now(),
      cancelRequested: false,
    });

    const res = await daemon.handleRequest({
      id: 'req_test_steer_1',
      op: 'steer',
      sessionId,
      expectedTurnId: turnId,
      message: 'Keep going with bullet points only',
      clientRequestId: 'cr_test_1',
    });

    expect(res.ok).toBe(true);
    expect((res as SteerResponse).steered).toBe(true);
    expect((res as SteerResponse).turnId).toBe(turnId);
    expect(mockAgent.steer).toHaveBeenCalledTimes(1);

    const steerArg = mockAgent.steer.mock.calls[0][0];
    expect(steerArg).toBeDefined();
    expect(steerArg.content).toEqual([{ type: 'text', text: 'Keep going with bullet points only' }]);
    expect(steerArg.source).toEqual({ kind: 'user' });
  });

  it('injects attachment guidance before calling agent.steer if attachments are provided', async () => {
    const daemon = new RuntimeDaemon({
      userId: 'alice',
      dshHome,
      spacesDir,
    });

    const mockAgent = {
      steer: vi.fn(),
      inject: vi.fn(),
      session: { seq: 5 },
    };

    const sessionId = 'ses_00000000000000000000000000000002';
    const turnId = 'turn_00000000000000000000000000000002';

    (daemon as any).isStarted = true;
    (daemon as any).agents.set(sessionId, {
      sessionId,
      agent: mockAgent,
      status: 'running',
      pendingQueue: [],
      lastUsed: Date.now(),
      currentTurn: {
        turnId,
        item: { request: { turnId, sessionId } },
        startedAt: Date.now(),
        cancelRequested: false,
      },
    });

    (daemon as any).currentTurns.set(sessionId, {
      turnId,
      item: { request: { turnId, sessionId } },
      startedAt: Date.now(),
      cancelRequested: false,
    });

    const res = await daemon.handleRequest({
      id: 'req_test_steer_2',
      op: 'steer',
      sessionId,
      expectedTurnId: turnId,
      message: 'Look at this new note',
      attachments: [
        {
          snapshotPath: 'note.txt',
          displayName: 'note.txt',
          mediaType: 'text/plain',
          size: 100,
          etag: 'etag_123',
        },
      ],
    });

    expect(res.ok).toBe(true);
    expect(mockAgent.inject).toHaveBeenCalledTimes(1);
    expect(mockAgent.steer).toHaveBeenCalledTimes(1);
  });

  it('returns TURN_NOT_RUNNING error when turn is not running or turnId mismatches', async () => {
    const daemon = new RuntimeDaemon({
      userId: 'alice',
      dshHome,
      spacesDir,
    });

    const sessionId = 'ses_00000000000000000000000000000003';
    const runningTurnId = 'turn_00000000000000000000000000000003';
    const otherTurnId = 'turn_00000000000000000000000000000099';

    const mockAgent = {
      steer: vi.fn(),
      inject: vi.fn(),
      session: { seq: 1 },
    };

    (daemon as any).isStarted = true;

    // Case 1: Session not loaded at all
    const res1 = await daemon.handleRequest({
      id: 'req_not_found',
      op: 'steer',
      sessionId: 'ses_unknown',
      expectedTurnId: runningTurnId,
      message: 'test message',
    });
    expect(res1.ok).toBe(false);
    expect((res1 as any).error.code).toBe(DAEMON_ERROR_CODES.TURN_NOT_RUNNING);

    // Case 2: Session is idle
    (daemon as any).agents.set(sessionId, {
      sessionId,
      agent: mockAgent,
      status: 'idle',
      pendingQueue: [],
      lastUsed: Date.now(),
    });

    const res2 = await daemon.handleRequest({
      id: 'req_idle',
      op: 'steer',
      sessionId,
      expectedTurnId: runningTurnId,
      message: 'test message',
    });
    expect(res2.ok).toBe(false);
    expect((res2 as any).error.code).toBe(DAEMON_ERROR_CODES.TURN_NOT_RUNNING);
    expect(mockAgent.steer).not.toHaveBeenCalled();

    // Case 3: Running, but expectedTurnId mismatches
    (daemon as any).agents.get(sessionId).status = 'running';
    (daemon as any).agents.get(sessionId).currentTurn = {
      turnId: runningTurnId,
      item: { request: { turnId: runningTurnId, sessionId } },
      startedAt: Date.now(),
      cancelRequested: false,
    };
    (daemon as any).currentTurns.set(sessionId, {
      turnId: runningTurnId,
      item: { request: { turnId: runningTurnId, sessionId } },
      startedAt: Date.now(),
      cancelRequested: false,
    });

    const res3 = await daemon.handleRequest({
      id: 'req_mismatch',
      op: 'steer',
      sessionId,
      expectedTurnId: otherTurnId,
      message: 'test message',
    });
    expect(res3.ok).toBe(false);
    expect((res3 as any).error.code).toBe(DAEMON_ERROR_CODES.TURN_NOT_RUNNING);
    expect(mockAgent.steer).not.toHaveBeenCalled();
  });
});

describe('D-01: Host and Docker Transport & Adapter Pass-Through', () => {
  it('Host transport steerTurn sends STEER op and parses response', async () => {
    const { HostDaemonTransport } = await import('../src/host/transport.js');
    const transport = new HostDaemonTransport({ socketPath: '/tmp/test.sock' });
    const requestSpy = vi.spyOn(transport as any, 'request').mockResolvedValue({
      id: 'req_1',
      op: 'steer',
      ok: true,
      steered: true,
      sessionId: 'ses_00000000000000000000000000000001',
      turnId: 'turn_00000000000000000000000000000001',
    });

    const res = await transport.steerTurn(
      'ses_00000000000000000000000000000001',
      'turn_00000000000000000000000000000001',
      'Focus here',
      undefined,
      'cr_1'
    );

    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy.mock.calls[0][0].op).toBe(DAEMON_OPS.STEER);
    expect(requestSpy.mock.calls[0][0].sessionId).toBe('ses_00000000000000000000000000000001');
    expect(requestSpy.mock.calls[0][0].expectedTurnId).toBe('turn_00000000000000000000000000000001');
    expect(requestSpy.mock.calls[0][0].message).toBe('Focus here');
    expect(requestSpy.mock.calls[0][0].clientRequestId).toBe('cr_1');
    expect(res.ok).toBe(true);
    expect(res.steered).toBe(true);
  });

  it('Docker transport steerTurn sends STEER op and parses response', async () => {
    const { DaemonDockerTransport } = await import('../src/transport/daemon-transport.js');
    const fakeClient = {} as any;
    const transport = new DaemonDockerTransport({
      containerName: 'c_test',
      client: fakeClient,
      ownership: { expectedUserId: 'alice', expectedDataRoot: '/data' },
    });
    const requestSpy = vi.spyOn(transport as any, 'request').mockResolvedValue({
      id: 'req_2',
      op: 'steer',
      ok: true,
      steered: true,
      sessionId: 'ses_00000000000000000000000000000002',
      turnId: 'turn_00000000000000000000000000000002',
    });

    const res = await transport.steerTurn(
      'ses_00000000000000000000000000000002',
      'turn_00000000000000000000000000000002',
      'Docker steer test',
      undefined,
      'cr_2'
    );

    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy.mock.calls[0][0].op).toBe(DAEMON_OPS.STEER);
    expect(requestSpy.mock.calls[0][0].sessionId).toBe('ses_00000000000000000000000000000002');
    expect(requestSpy.mock.calls[0][0].expectedTurnId).toBe('turn_00000000000000000000000000000002');
    expect(requestSpy.mock.calls[0][0].message).toBe('Docker steer test');
    expect(requestSpy.mock.calls[0][0].clientRequestId).toBe('cr_2');
    expect(res.ok).toBe(true);
    expect(res.steered).toBe(true);
  });
});
