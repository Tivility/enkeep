/**
 * Test Double / Fake Runtime Container Adapter for hermetic unit testing
 *
 * @module @enkeep/demo-runner/tests/support/fake-runtime
 */

import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  computeSessionEventsChecksum,
  canonicalJsonStringify,
  executeFileOperation,
  type FileOperationRequest,
} from '@enkeep/runtime-runner';
import {
  validateTurnPrompt,
  type RuntimeContainerPort,
  type UserRuntimeHandle,
  type UserRuntimeHealthInfo,
} from '../../src/ports/index.js';
import type { SignedContainerMetadata, DemoPathOptions, DemoRunnerMode } from '../../src/types.js';
import type { RuntimeAgentProfileSnapshot } from '@enkeep/platform-server';
import {
  readSignedContainerMeta,
  writeSignedContainerMeta,
  writeSignedVolumeMeta,
  readSignedVolumeMeta,
  removeSignedContainerMeta,
  removeSignedVolumeMeta,
  listSignedContainers,
  generateRunId,
} from '../../src/utils/crypto-meta.js';
import {
  RUN_ID_LABEL_KEY,
  VOLUME_ID_LABEL_KEY,
  validateResourceSuffix,
  getDemoPathConfig,
} from '../../src/config.js';

export class FakeUnitRuntimeContainerAdapter implements RuntimeContainerPort {
  readonly unitOnly = true;
  private readonly importedSessions = new Set<string>();

  async startUserRuntime(options: {
    userId: 'alice' | 'bob' | string;
    image?: string;
    repoRoot?: string;
    dataRoot?: string;
    mode?: DemoRunnerMode;
    resourceSuffix?: string;
    timeoutMs?: number;
    mounts?: readonly any[];
  }): Promise<UserRuntimeHandle> {
    const pathOptions: DemoPathOptions = {
      repoRoot: options.repoRoot,
      dataRoot: options.dataRoot,
      mode: options.mode,
      resourceSuffix: options.resourceSuffix,
    };
    validateResourceSuffix(options.resourceSuffix);

    const suffix = options.resourceSuffix ? `-${options.resourceSuffix}` : '';
    const containerName = `enkeep-demo-${options.userId}${suffix}`;
    const volumeName = `enkeep-demo-dsh-${options.userId}${suffix}`;
    const existingVolMeta = readSignedVolumeMeta(volumeName, pathOptions);
    const containerId = randomBytes(32).toString('hex').toLowerCase();
    const runId = generateRunId();
    const volumeId = existingVolMeta?.volumeId ?? `vol_${randomBytes(16).toString('hex').toLowerCase()}`;

    writeSignedVolumeMeta(
      {
        userId: options.userId,
        volumeName,
        volumeId,
        runId,
      },
      pathOptions
    );

    const meta = writeSignedContainerMeta(
      {
        userId: options.userId,
        containerName,
        containerId,
        image: options.image ?? 'enkeep-demo-runtime:latest',
        volumeName,
        volumeId,
        labels: {
          [RUN_ID_LABEL_KEY]: runId,
          [VOLUME_ID_LABEL_KEY]: volumeId,
        },
        runId,
      },
      pathOptions
    );

    const importedSessions = this.importedSessions;

    return {
      userId: options.userId,
      containerName,
      containerId,
      volumeId,
      runId,
      volumeCreated: !existingVolMeta,
      meta,
      async sendTurn(request: import('@enkeep/protocol').RuntimeTurnRequest) {
        validateTurnPrompt(request.prompt);
        return {
          replyText: `[DemoModel:${options.userId}] Processed: ${request.prompt}`,
          eventsCount: 1,
          persisted: true as const,
        };
      },
      async checkSessionArtifact(_sessionId: string, _workspaceFolder?: string) {
        return {
          exists: true,
          valid: true,
          checksum: '0000000000000000000000000000000000000000000000000000000000000000',
          eventCount: 1,
        };
      },
      async exportForkSeed(
        sessionId: string,
        boundary?: { fromMessageId?: string; fromTurnId?: string },
        _workspaceFolder?: string
      ) {
        const events = [
          {
            type: 'user/message',
            seq: 0,
            time: Date.now(),
            surfaceOp: 'append',
            data: { id: boundary?.fromMessageId ?? 'm1', role: 'user', content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } },
          },
          {
            type: 'turn/start',
            seq: 1,
            time: Date.now(),
            data: { turn: 1 },
          },
          {
            type: 'step/start',
            seq: 2,
            time: Date.now(),
            data: { turn: 1, step: 1 },
          },
          {
            type: 'assistant/message',
            seq: 3,
            time: Date.now(),
            surfaceOp: 'append',
            data: { turn: 1, step: 1, message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Hi' }], source: { kind: 'model', provider: 'demo', model: 'fake' } } },
          },
          {
            type: 'step/end',
            seq: 4,
            time: Date.now(),
            data: { turn: 1, step: 1 },
          },
          {
            type: 'turn/end',
            seq: 5,
            time: Date.now(),
            data: { turn: 1, reason: { kind: 'completed' } },
          },
          {
            type: 'session/end-seed',
            seq: 6,
            time: Date.now(),
            data: {},
          },
        ];
        const checksum = computeSessionEventsChecksum(events);
        const canonicalJson = canonicalJsonStringify(events);
        const canonicalBytes = Buffer.byteLength(canonicalJson, 'utf8');
        return {
          events,
          receipt: {
            algorithm: 'sha256-session-events-v1' as const,
            checksum,
            canonicalBytes,
            eventCount: events.length,
          },
          boundaryMapping: {
            sessionId,
            boundary,
          },
        };
      },
      async importSeed(sessionId: string, seed: readonly unknown[]) {
        const checksum = computeSessionEventsChecksum(seed);
        const canonicalJson = canonicalJsonStringify(seed);
        const canonicalBytes = Buffer.byteLength(canonicalJson, 'utf8');
        const isDup = importedSessions.has(sessionId);
        importedSessions.add(sessionId);
        return {
          status: 'completed',
          sessionId,
          persisted: true,
          eventsCount: Array.isArray(seed) ? seed.length : 1,
          receipt: {
            algorithm: 'sha256-session-events-v1' as const,
            checksum,
            canonicalBytes,
            eventCount: Array.isArray(seed) ? seed.length : 1,
          },
          duplicate: isDup,
        };
      },
      async cancelTurn(turnId: string) {
        return {
          status: 'cancelled',
          turnId,
        };
      },
      async inspectTurnResult(turnId: string) {
        return {
          status: 'absent' as const,
        };
      },
      async checkHealth(): Promise<UserRuntimeHealthInfo> {
        return {
          status: 'ok',
          dshReady: true,
          version: '1.0.0-mock',
          userId: options.userId,
          uptimeSeconds: 42,
          enkeepBundleLoaded: true,
          toolsCount: 6,
          plugins: {
            receiptStore: true,
            inbound: true,
            eventRelay: true,
            tools: true,
            externalInteraction: true,
            affinityPolicy: true,
            llmAffinity: true,
          },
          toolsOperational: true,
          toolsUnavailableReason: null,
          modelProvider: 'demo',
        };
      },
      async fileOperation(request: FileOperationRequest) {
        const paths = getDemoPathConfig(pathOptions);
        try {
          const result = executeFileOperation(request, {
            spacesDir: join(paths.dataRoot, 'spaces'),
            lockBaseDir: join(paths.dataRoot, '.file-locks'),
            procStatReader: () => ({ starttime: 10000 }),
          });
          return {
            status: 'ok' as const,
            requestId: 'req_mock_file_op',
            userId: options.userId,
            fileResult: result,
          };
        } catch (err: any) {
          return {
            status: 'error' as const,
            code: err?.code || 'EXEC_CONTAINER_ERROR',
            error: err?.message || String(err),
          };
        }
      },
      async stop() {},
      async teardown(removeVolume = false) {
        removeSignedContainerMeta(containerName, pathOptions);
        if (removeVolume) {
          removeSignedVolumeMeta(volumeName, pathOptions);
        }
      },
    };
  }

  async connectUserRuntime(options: {
    userId: 'alice' | 'bob' | string;
    image?: string;
    repoRoot?: string;
    dataRoot?: string;
    mode?: DemoRunnerMode;
    resourceSuffix?: string;
    timeoutMs?: number;
  }): Promise<UserRuntimeHandle> {
    const pathOptions: DemoPathOptions = {
      repoRoot: options.repoRoot,
      dataRoot: options.dataRoot,
      mode: options.mode,
      resourceSuffix: options.resourceSuffix,
    };
    validateResourceSuffix(options.resourceSuffix);

    const suffix = options.resourceSuffix ? `-${options.resourceSuffix}` : '';
    const containerName = `enkeep-demo-${options.userId}${suffix}`;
    const volumeName = `enkeep-demo-dsh-${options.userId}${suffix}`;
    const existingMeta = readSignedContainerMeta(containerName, pathOptions);

    if (!existingMeta) {
      throw new Error(`FAIL-CLOSED: Cannot connect to user runtime "${options.userId}": No signed container metadata found.`);
    }

    const importedSessions = this.importedSessions;

    return {
      userId: options.userId,
      containerName,
      containerId: existingMeta.containerId,
      volumeId: existingMeta.volumeId,
      runId: existingMeta.runId,
      volumeCreated: false,
      meta: existingMeta,
      async sendTurn(request: import('@enkeep/protocol').RuntimeTurnRequest) {
        validateTurnPrompt(request.prompt);
        return {
          replyText: `[DemoModel:${options.userId}] Processed: ${request.prompt}`,
          eventsCount: 1,
          persisted: true as const,
        };
      },
      async checkSessionArtifact(_sessionId: string, _workspaceFolder?: string) {
        return {
          exists: true,
          valid: true,
          checksum: '0000000000000000000000000000000000000000000000000000000000000000',
          eventCount: 1,
        };
      },
      async exportForkSeed(
        sessionId: string,
        boundary?: { fromMessageId?: string; fromTurnId?: string },
        _workspaceFolder?: string
      ) {
        const events = [
          {
            type: 'user/message',
            seq: 0,
            time: Date.now(),
            surfaceOp: 'append',
            data: { id: boundary?.fromMessageId ?? 'm1', role: 'user', content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } },
          },
          {
            type: 'turn/start',
            seq: 1,
            time: Date.now(),
            data: { turn: 1 },
          },
          {
            type: 'step/start',
            seq: 2,
            time: Date.now(),
            data: { turn: 1, step: 1 },
          },
          {
            type: 'assistant/message',
            seq: 3,
            time: Date.now(),
            surfaceOp: 'append',
            data: { turn: 1, step: 1, message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Hi' }], source: { kind: 'model', provider: 'demo', model: 'fake' } } },
          },
          {
            type: 'step/end',
            seq: 4,
            time: Date.now(),
            data: { turn: 1, step: 1 },
          },
          {
            type: 'turn/end',
            seq: 5,
            time: Date.now(),
            data: { turn: 1, reason: { kind: 'completed' } },
          },
          {
            type: 'session/end-seed',
            seq: 6,
            time: Date.now(),
            data: {},
          },
        ];
        const checksum = computeSessionEventsChecksum(events);
        const canonicalJson = canonicalJsonStringify(events);
        const canonicalBytes = Buffer.byteLength(canonicalJson, 'utf8');
        return {
          events,
          receipt: {
            algorithm: 'sha256-session-events-v1' as const,
            checksum,
            canonicalBytes,
            eventCount: events.length,
          },
          boundaryMapping: {
            sessionId,
            boundary,
          },
        };
      },
      async importSeed(sessionId: string, seed: readonly unknown[]) {
        const checksum = computeSessionEventsChecksum(seed);
        const canonicalJson = canonicalJsonStringify(seed);
        const canonicalBytes = Buffer.byteLength(canonicalJson, 'utf8');
        const isDup = importedSessions.has(sessionId);
        importedSessions.add(sessionId);
        return {
          status: 'completed',
          sessionId,
          persisted: true,
          eventsCount: Array.isArray(seed) ? seed.length : 1,
          receipt: {
            algorithm: 'sha256-session-events-v1' as const,
            checksum,
            canonicalBytes,
            eventCount: Array.isArray(seed) ? seed.length : 1,
          },
          duplicate: isDup,
        };
      },
      async cancelTurn(turnId: string) {
        return {
          status: 'cancelled',
          turnId,
        };
      },
      async inspectTurnResult(turnId: string) {
        return {
          status: 'absent' as const,
        };
      },
      async checkHealth(): Promise<UserRuntimeHealthInfo> {
        return {
          status: 'ok',
          dshReady: true,
          version: '1.0.0-mock',
          userId: options.userId,
          uptimeSeconds: 42,
          enkeepBundleLoaded: true,
          toolsCount: 6,
          plugins: {
            receiptStore: true,
            inbound: true,
            eventRelay: true,
            tools: true,
            externalInteraction: true,
            affinityPolicy: true,
            llmAffinity: true,
          },
          toolsOperational: true,
          toolsUnavailableReason: null,
          modelProvider: 'demo',
        };
      },
      async fileOperation(request: FileOperationRequest) {
        const paths = getDemoPathConfig(pathOptions);
        try {
          const result = executeFileOperation(request, {
            spacesDir: join(paths.dataRoot, 'spaces'),
            lockBaseDir: join(paths.dataRoot, '.file-locks'),
            procStatReader: () => ({ starttime: 10000 }),
          });
          return {
            status: 'ok' as const,
            requestId: 'req_mock_file_op',
            userId: options.userId,
            fileResult: result,
          };
        } catch (err: any) {
          return {
            status: 'error' as const,
            code: err?.code || 'EXEC_CONTAINER_ERROR',
            error: err?.message || String(err),
          };
        }
      },
      async stop() {},
      async teardown(removeVolume = false) {
        removeSignedContainerMeta(containerName, pathOptions);
        if (removeVolume) {
          removeSignedVolumeMeta(volumeName, pathOptions);
        }
      },
    };
  }

  async listActiveRuntimes(options?: DemoPathOptions | string): Promise<SignedContainerMetadata[]> {
    return listSignedContainers(options);
  }

  async stopUserRuntime(containerName: string, removeVolume = false, options?: DemoPathOptions | string): Promise<void> {
    removeSignedContainerMeta(containerName, options);
    if (removeVolume) {
      removeSignedVolumeMeta(`enkeep-demo-dsh-${containerName.replace(/^enkeep-demo-/, '')}`, options);
    }
  }
}
