import { describe, it, expect } from 'vitest';
import {
  isValidIdFormat,
  makeBranded,
  parseBranded,
  makeSessionId,
  makeRunId,
  makeExecutionId,
  makeTaskId,
  makeWorkspaceId,
  makeContainerId,
  makeUserId,
  makeRuntimeIdentity,
  makePlatformUserId,
  parseRuntimeIdentity,
  parsePlatformUserId,
  makeRequestId,
  makeSpaceId,
  makeArtifactId,
  makeRuntimeWorkspaceSegment,
  parseRuntimeWorkspaceSegment,
  isValidRuntimeWorkspaceSegment,
  makeSessionSeq,
  parseSessionSeq,
  isValidSessionSeq,
  makeSessionLogOffset,
  parseSessionLogOffset,
  isValidSessionLogOffset,
  MAX_ID_LENGTH,
} from '../src/index.js';

describe('Protocol Branded Types', () => {
  describe('isValidIdFormat', () => {
    it('accepts valid ID strings', () => {
      expect(isValidIdFormat('sess-12345')).toBe(true);
      expect(isValidIdFormat('run_abc_123')).toBe(true);
      expect(isValidIdFormat('uuid:123-456-789')).toBe(true);
      expect(isValidIdFormat('simple-id.test')).toBe(true);
      expect(isValidIdFormat('a'.repeat(MAX_ID_LENGTH))).toBe(true);
    });

    it('rejects invalid or unsafe strings', () => {
      expect(isValidIdFormat('')).toBe(false);
      expect(isValidIdFormat(' ')).toBe(false);
      expect(isValidIdFormat('id with spaces')).toBe(false);
      expect(isValidIdFormat('id/with/slashes')).toBe(false);
      expect(isValidIdFormat('id\nwith\nnewlines')).toBe(false);
      expect(isValidIdFormat('id\x00nullbyte')).toBe(false);
      expect(isValidIdFormat('../traversal')).toBe(false);
      expect(isValidIdFormat('a'.repeat(MAX_ID_LENGTH + 1))).toBe(false);
      expect(isValidIdFormat(12345)).toBe(false);
      expect(isValidIdFormat(null)).toBe(false);
      expect(isValidIdFormat(undefined)).toBe(false);
    });
  });

  describe('makeBranded & parseBranded', () => {
    it('creates branded types for valid input', () => {
      const id = makeBranded('test-run-1', 'RunId');
      expect(id).toBe('test-run-1');

      const parsed = parseBranded('test-run-2', 'RunId');
      expect(parsed).toBe('test-run-2');
    });

    it('throws TypeError in makeBranded for invalid input', () => {
      expect(() => makeBranded('', 'RunId')).toThrow(TypeError);
      expect(() => makeBranded('bad id space', 'RunId')).toThrow(TypeError);
      expect(() => makeBranded(123 as any, 'RunId')).toThrow(TypeError);
    });

    it('returns null in parseBranded for invalid input', () => {
      expect(parseBranded('', 'RunId')).toBeNull();
      expect(parseBranded('bad id space', 'RunId')).toBeNull();
      expect(parseBranded(null, 'RunId')).toBeNull();
    });
  });

  describe('concrete factory functions', () => {
    it('creates branded types with appropriate factories', () => {
      const sessionId = makeSessionId('sess-100');
      const runId = makeRunId('run-200');
      const execId = makeExecutionId('exec-300');
      const taskId = makeTaskId('task-400');
      const wsId = makeWorkspaceId('ws-500');
      const containerId = makeContainerId('container-600');
      const userId = makeUserId('user-700');
      const runtimeIdentity = makeRuntimeIdentity('alice');
      const platformUserId = makePlatformUserId('2fa8b6c0-4389-411a-8fc7-60bf03b717b0');
      const reqId = makeRequestId('req-800');
      const spaceId = makeSpaceId('space-900');
      const artifactId = makeArtifactId('art-1000');
      const workspaceSeg = makeRuntimeWorkspaceSegment('alice-space');

      expect(sessionId).toBe('sess-100');
      expect(runId).toBe('run-200');
      expect(execId).toBe('exec-300');
      expect(taskId).toBe('task-400');
      expect(wsId).toBe('ws-500');
      expect(containerId).toBe('container-600');
      expect(userId).toBe('user-700');
      expect(runtimeIdentity).toBe('alice');
      expect(platformUserId).toBe('2fa8b6c0-4389-411a-8fc7-60bf03b717b0');
      expect(parseRuntimeIdentity('bob')).toBe('bob');
      expect(parsePlatformUserId('11111111-1111-4111-8111-111111111111')).toBe('11111111-1111-4111-8111-111111111111');
      expect(parseRuntimeIdentity('')).toBeNull();
      expect(parsePlatformUserId(null)).toBeNull();
      expect(reqId).toBe('req-800');
      expect(spaceId).toBe('space-900');
      expect(artifactId).toBe('art-1000');
      expect(workspaceSeg).toBe('alice-space');
      expect(parseRuntimeWorkspaceSegment('group-123')).toBe('group-123');
      expect(parseRuntimeWorkspaceSegment('space/child')).toBeNull();
      expect(parseRuntimeWorkspaceSegment('../escape')).toBeNull();
      expect(isValidRuntimeWorkspaceSegment('valid-segment.1')).toBe(true);
      expect(isValidRuntimeWorkspaceSegment('')).toBe(false);
      expect(isValidRuntimeWorkspaceSegment('.')).toBe(false);
      expect(isValidRuntimeWorkspaceSegment('..')).toBe(false);
      expect(isValidRuntimeWorkspaceSegment('/root')).toBe(false);
      expect(() => makeRuntimeWorkspaceSegment('../escape')).toThrow(TypeError);

      // SessionSeq tests
      const sessionSeq = makeSessionSeq(42);
      expect(sessionSeq).toBe(42);
      expect(isValidSessionSeq(0)).toBe(true);
      expect(isValidSessionSeq(100)).toBe(true);
      expect(isValidSessionSeq(-1)).toBe(false);
      expect(isValidSessionSeq(1.5)).toBe(false);
      expect(isValidSessionSeq('0')).toBe(false);
      expect(parseSessionSeq(10)).toBe(10);
      expect(parseSessionSeq(-5)).toBeNull();
      expect(() => makeSessionSeq(-1)).toThrow(TypeError);

      // SessionLogOffset tests
      const sessionOffset = makeSessionLogOffset(100);
      expect(sessionOffset).toBe(100);
      expect(isValidSessionLogOffset(0)).toBe(true);
      expect(isValidSessionLogOffset(9999)).toBe(true);
      expect(isValidSessionLogOffset(-1)).toBe(false);
      expect(isValidSessionLogOffset('100')).toBe(false);
      expect(parseSessionLogOffset(50)).toBe(50);
      expect(parseSessionLogOffset(-1)).toBeNull();
      expect(() => makeSessionLogOffset(-10)).toThrow(TypeError);
    });
  });
});
