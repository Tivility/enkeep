import { describe, it, expect } from 'vitest';
import {
  validateScriptTaskPayload,
  validateTaskPayload,
  validateScriptTaskResult,
  validateTaskResult,
  validateUpdateTaskInput,
  ALLOWED_SCRIPT_TASK_PAYLOAD_KEYS,
  ALLOWED_SCRIPT_TASK_RESULT_KEYS,
  MAX_PROMPT_BYTES,
} from '../src/types/task.js';
import { ValidationError } from '../src/errors/index.js';

describe('Script Task Payload & Result Contract (D6 / F-16)', () => {
  const validSpaceId = 'spc_0123456789abcdef0123456789abcdef';

  describe('validateScriptTaskPayload', () => {
    it('validates a standard script task payload', () => {
      const payload = {
        type: 'script' as const,
        command: 'bash scripts/health-check.sh',
        spaceId: validSpaceId,
        spaceFolder: 'space-f16-test',
        timeoutMs: 60000,
      };

      const validated = validateScriptTaskPayload(payload);
      expect(validated.type).toBe('script');
      expect(validated.command).toBe('bash scripts/health-check.sh');
      expect(validated.spaceId).toBe(validSpaceId);
      expect(validated.spaceFolder).toBe('space-f16-test');
      expect(validated.timeoutMs).toBe(60000);
    });

    it('rejects unrecognized fields', () => {
      const payload = {
        type: 'script' as const,
        command: 'echo hello',
        spaceId: validSpaceId,
        unknownField: 'bad',
      };

      expect(() => validateScriptTaskPayload(payload)).toThrow(ValidationError);
      expect(() => validateScriptTaskPayload(payload)).toThrow(/unrecognized or forbidden fields/);
    });

    it('rejects invalid or empty command', () => {
      expect(() =>
        validateScriptTaskPayload({
          type: 'script',
          command: '',
          spaceId: validSpaceId,
        })
      ).toThrow(ValidationError);

      expect(() =>
        validateScriptTaskPayload({
          type: 'script',
          command: '   ',
          spaceId: validSpaceId,
        })
      ).toThrow(ValidationError);

      expect(() =>
        validateScriptTaskPayload({
          type: 'script',
          command: 123 as any,
          spaceId: validSpaceId,
        })
      ).toThrow(ValidationError);
    });

    it('rejects oversized command exceeding 64KiB', () => {
      const oversized = 'a'.repeat(MAX_PROMPT_BYTES + 1);
      expect(() =>
        validateScriptTaskPayload({
          type: 'script',
          command: oversized,
          spaceId: validSpaceId,
        })
      ).toThrow(ValidationError);
    });

    it('rejects invalid spaceId format', () => {
      expect(() =>
        validateScriptTaskPayload({
          type: 'script',
          command: 'echo 1',
          spaceId: 'invalid-space-id',
        })
      ).toThrow(ValidationError);
    });

    it('rejects invalid spaceFolder format (traversal attempt)', () => {
      expect(() =>
        validateScriptTaskPayload({
          type: 'script',
          command: 'echo 1',
          spaceId: validSpaceId,
          spaceFolder: '../escape',
        })
      ).toThrow(ValidationError);
    });

    it('validates timeoutMs bounds (positive, <= 3600000)', () => {
      expect(() =>
        validateScriptTaskPayload({
          type: 'script',
          command: 'echo 1',
          spaceId: validSpaceId,
          timeoutMs: -1,
        })
      ).toThrow(ValidationError);

      expect(() =>
        validateScriptTaskPayload({
          type: 'script',
          command: 'echo 1',
          spaceId: validSpaceId,
          timeoutMs: 0,
        })
      ).toThrow(ValidationError);

      expect(() =>
        validateScriptTaskPayload({
          type: 'script',
          command: 'echo 1',
          spaceId: validSpaceId,
          timeoutMs: 3_600_001,
        })
      ).toThrow(ValidationError);

      expect(() =>
        validateScriptTaskPayload({
          type: 'script',
          command: 'echo 1',
          spaceId: validSpaceId,
          timeoutMs: 12.34,
        })
      ).toThrow(ValidationError);

      const valid = validateScriptTaskPayload({
        type: 'script',
        command: 'echo 1',
        spaceId: validSpaceId,
        timeoutMs: 300000,
      });
      expect(valid.timeoutMs).toBe(300000);
    });

    it('validates delivery target and silent conflict', () => {
      const validDelivery = {
        channel: 'lark',
        accountId: 'acc_123',
        nativeContextId: 'chat_456',
      };

      const res = validateScriptTaskPayload({
        type: 'script',
        command: 'echo 1',
        spaceId: validSpaceId,
        delivery: validDelivery,
      });
      expect(res.delivery).toEqual(validDelivery);

      expect(() =>
        validateScriptTaskPayload({
          type: 'script',
          command: 'echo 1',
          spaceId: validSpaceId,
          delivery: validDelivery,
          silent: true,
        })
      ).toThrow(ValidationError);
    });
  });

  describe('validateTaskPayload polymorphic dispatcher', () => {
    it('dispatches script payload correctly', () => {
      const payload = {
        type: 'script' as const,
        command: 'hostname',
        spaceId: validSpaceId,
      };
      const res = validateTaskPayload(payload);
      expect(res.type).toBe('script');
      expect((res as any).command).toBe('hostname');
    });

    it('dispatches agent_prompt payload correctly', () => {
      const payload = {
        type: 'agent_prompt' as const,
        prompt: 'Do something',
        sessionId: 'ses_0123456789abcdef0123456789abcdef',
        sessionPolicy: 'existing_session' as const,
      };
      const res = validateTaskPayload(payload);
      expect(res.type).toBe('agent_prompt');
      expect((res as any).prompt).toBe('Do something');
    });
  });

  describe('validateScriptTaskResult & validateTaskResult', () => {
    it('validates successful script result with stdout, stderr, exitCode 0', () => {
      const now = new Date().toISOString();
      const raw = {
        status: 'completed',
        completedAt: now,
        stdout: '{"status":"healthy"}',
        stderr: '',
        exitCode: 0,
        durationMs: 42,
      };

      const validated = validateScriptTaskResult(raw);
      expect(validated.status).toBe('completed');
      expect(validated.stdout).toBe('{"status":"healthy"}');
      expect(validated.stderr).toBe('');
      expect(validated.exitCode).toBe(0);
      expect(validated.durationMs).toBe(42);
    });

    it('validates script result with non-zero exit code', () => {
      const now = new Date().toISOString();
      const raw = {
        status: 'completed',
        completedAt: now,
        stdout: '',
        stderr: 'command not found',
        exitCode: 127,
        durationMs: 15,
      };

      const validated = validateTaskResult(raw);
      expect(validated.status).toBe('completed');
      expect((validated as any).exitCode).toBe(127);
      expect((validated as any).stderr).toBe('command not found');
    });

    it('rejects invalid exitCode or durationMs', () => {
      const now = new Date().toISOString();
      expect(() =>
        validateScriptTaskResult({
          status: 'completed',
          completedAt: now,
          stdout: '',
          stderr: '',
          exitCode: '0' as any,
          durationMs: 10,
        })
      ).toThrow(ValidationError);

      expect(() =>
        validateScriptTaskResult({
          status: 'completed',
          completedAt: now,
          stdout: '',
          stderr: '',
          exitCode: 0,
          durationMs: -5,
        })
      ).toThrow(ValidationError);
    });
  });

  describe('validateUpdateTaskInput for script tasks', () => {
    it('allows updating command, script_command, and timeoutMs', () => {
      const updated = validateUpdateTaskInput({
        command: 'bash scripts/new-check.sh',
        timeoutMs: 120000,
      });
      expect(updated.command).toBe('bash scripts/new-check.sh');
      expect(updated.timeoutMs).toBe(120000);
    });

    it('allows updating payload with command and timeoutMs', () => {
      const updated = validateUpdateTaskInput({
        payload: {
          command: 'python run.py',
          timeoutMs: 60000,
        },
      });
      expect(updated.payload?.command).toBe('python run.py');
      expect(updated.payload?.timeoutMs).toBe(60000);
    });

    it('rejects updating immutable spaceId or spaceFolder in payload', () => {
      expect(() =>
        validateUpdateTaskInput({
          payload: {
            spaceId: 'spc_new',
          },
        })
      ).toThrow(ValidationError);

      expect(() =>
        validateUpdateTaskInput({
          payload: {
            spaceFolder: 'new_folder',
          },
        })
      ).toThrow(ValidationError);
    });
  });
});
