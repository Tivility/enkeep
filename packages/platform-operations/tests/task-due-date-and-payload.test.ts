import { describe, it, expect, beforeEach } from 'vitest';
import { FakePlatformOperationsStorage } from './support/index.js';
import { PlatformOperationsService } from '../src/services/platform-operations-service.js';
import { ValidationError } from '../src/errors/index.js';
import {
  validateAgentPromptPayload,
  ALLOWED_AGENT_PROMPT_PAYLOAD_KEYS,
  MAX_PROMPT_BYTES,
  generateTaskId,
  validateTaskId,
  validateCanonicalDueDate,
} from '../src/types/task.js';
import {
  validateMisfirePolicy,
  validateOverlapPolicy,
} from '../src/tasks/schedule-calculator.js';

describe('Task Payload Contract (agent_prompt) & Due Date Hardening', () => {
  let storage: FakePlatformOperationsStorage;
  let service: PlatformOperationsService;

  const validSessionId = 'ses_0123456789abcdef0123456789abcdef';
  const validSpaceId = 'spc_0123456789abcdef0123456789abcdef';

  beforeEach(() => {
    storage = new FakePlatformOperationsStorage();
    service = new PlatformOperationsService({ storage });
  });

  const defaultPayload = {
    type: 'agent_prompt' as const,
    prompt: 'Execute operation',
    sessionId: validSessionId,
    sessionPolicy: 'existing_session' as const,
  };

  describe('Canonical Task ID & Field Validation Rules', () => {
    it('generates canonical task ID matching task_ + 32 lowercase hex characters when id is omitted', async () => {
      const ops = service.forTenant('user_1');
      const { task } = await ops.tasks.createTask({
        title: 'Auto ID Task',
        payload: defaultPayload,
      });

      expect(task.id).toMatch(/^task_[0-9a-f]{32}$/);
      expect(task.id.length).toBe(37); // 'task_' (5) + 32 hex chars = 37 chars
    });

    it('accepts exact canonical external ID where raw matches regex', async () => {
      const ops = service.forTenant('user_1');
      const customId = 'task_0123456789abcdef0123456789abcdef';
      const { task } = await ops.tasks.createTask({
        id: customId,
        title: 'Custom ID Task',
        payload: defaultPayload,
      });

      expect(task.id).toBe(customId);
    });

    it('rejects external input ID with leading, trailing, or invalid format without silent trimming', async () => {
      const ops = service.forTenant('user_1');

      // Leading whitespace
      await expect(
        ops.tasks.createTask({
          id: ' task_0123456789abcdef0123456789abcdef',
          title: 'Whitespace ID Task',
          payload: defaultPayload,
        })
      ).rejects.toThrow(ValidationError);

      // Trailing whitespace
      await expect(
        ops.tasks.createTask({
          id: 'task_0123456789abcdef0123456789abcdef ',
          title: 'Whitespace ID Task',
          payload: defaultPayload,
        })
      ).rejects.toThrow(ValidationError);

      // Empty string
      await expect(
        ops.tasks.createTask({
          id: '',
          title: 'Empty ID Task',
          payload: defaultPayload,
        })
      ).rejects.toThrow(ValidationError);

      // Whitespace only
      await expect(
        ops.tasks.createTask({
          id: '   ',
          title: 'Whitespace Only ID Task',
          payload: defaultPayload,
        })
      ).rejects.toThrow(ValidationError);

      // Invalid format
      await expect(
        ops.tasks.createTask({
          id: 'invalid_task_id',
          title: 'Invalid ID Task',
          payload: defaultPayload,
        })
      ).rejects.toThrow(ValidationError);
    });

    it('strictly validates title: rejects empty, whitespace-only, or whitespace-padded title', async () => {
      const ops = service.forTenant('user_1');

      // Empty title
      await expect(
        ops.tasks.createTask({
          title: '',
          payload: defaultPayload,
        })
      ).rejects.toThrow(ValidationError);

      // Whitespace only
      await expect(
        ops.tasks.createTask({
          title: '   ',
          payload: defaultPayload,
        })
      ).rejects.toThrow(ValidationError);

      // Padded with leading/trailing whitespace (never silently trimmed)
      await expect(
        ops.tasks.createTask({
          title: '  Padded Title  ',
          payload: defaultPayload,
        })
      ).rejects.toThrow(ValidationError);
    });

    it('strictly validates idempotencyKey: rejects non-canonical UUID-v4 lowercase key', async () => {
      const ops = service.forTenant('user_1');

      await expect(
        ops.tasks.createTask({
          title: 'Task 1',
          idempotencyKey: '',
          payload: defaultPayload,
        })
      ).rejects.toThrow(ValidationError);

      await expect(
        ops.tasks.createTask({
          title: 'Task 2',
          idempotencyKey: '  11111111-2222-4333-8444-555555555555  ',
          payload: defaultPayload,
        })
      ).rejects.toThrow(ValidationError);

      await expect(
        ops.tasks.createTask({
          title: 'Task 3',
          idempotencyKey: 'not-a-uuid',
          payload: defaultPayload,
        })
      ).rejects.toThrow(ValidationError);
    });

    it('strictly validates claimantId in claim, renewLease, complete, fail: rejects whitespace or empty', async () => {
      const ops = service.forTenant('user_1');
      const { task } = await ops.tasks.createTask({
        title: 'Claim Test Task',
        payload: defaultPayload,
      });

      // Claim with empty claimantId
      await expect(
        ops.tasks.claimTask({
          claimantId: '',
        })
      ).rejects.toThrow(ValidationError);

      // Claim with whitespace-padded claimantId
      await expect(
        ops.tasks.claimTask({
          claimantId: ' worker_1 ',
        })
      ).rejects.toThrow(ValidationError);

      // Claim validly
      const claimed = await ops.tasks.claimTask({
        claimantId: 'worker_1',
      });
      expect(claimed?.claimantId).toBe('worker_1');

      // Renew with whitespace claimantId
      await expect(
        ops.tasks.renewLease(task.id, {
          claimantId: ' worker_1 ',
        })
      ).rejects.toThrow(ValidationError);

      // Complete with whitespace claimantId
      await expect(
        ops.tasks.completeTask(task.id, {
          claimantId: ' worker_1 ',
          result: {
            status: 'completed',
            completedAt: new Date().toISOString(),
          },
        })
      ).rejects.toThrow(ValidationError);

      // Fail with whitespace claimantId
      await expect(
        ops.tasks.failTask(task.id, {
          claimantId: ' worker_1 ',
          error: 'TASK_EXECUTION_FAILED',
        })
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('Minimal Strict agent_prompt Task Payload Contract', () => {
    it('accepts valid agent_prompt payloads with required type, prompt, sessionId, sessionPolicy, and optional spaceId', async () => {
      const ops = service.forTenant('user_1');

      const { task } = await ops.tasks.createTask({
        title: 'Summarize Document',
        payload: {
          type: 'agent_prompt',
          prompt: 'Please summarize the quarterly financial report in 3 bullet points.',
          sessionId: validSessionId,
          sessionPolicy: 'existing_session',
          spaceId: validSpaceId,
        },
      });

      expect(task.id).toBeDefined();
      expect(task.payload).toBeDefined();
      expect(task.payload?.type).toBe('agent_prompt');
      expect(task.payload?.prompt).toContain('quarterly financial report');
      expect(task.payload?.sessionId).toBe(validSessionId);
      expect(task.payload?.sessionPolicy).toBe('existing_session');
      expect(task.payload?.spaceId).toBe(validSpaceId);
    });

    it('requires type to be strictly "agent_prompt", sessionPolicy to be "existing_session", and prompt to be non-empty', () => {
      // Missing type
      expect(() =>
        validateAgentPromptPayload({
          prompt: 'Hello',
          sessionId: validSessionId,
          sessionPolicy: 'existing_session',
        })
      ).toThrow(ValidationError);

      // Wrong type
      expect(() =>
        validateAgentPromptPayload({
          type: 'shell_execution' as any,
          prompt: 'Hello',
          sessionId: validSessionId,
          sessionPolicy: 'existing_session',
        })
      ).toThrow(ValidationError);

      // Empty prompt
      expect(() =>
        validateAgentPromptPayload({
          type: 'agent_prompt',
          prompt: '   ',
          sessionId: validSessionId,
          sessionPolicy: 'existing_session',
        })
      ).toThrow(ValidationError);

      // Missing sessionId
      expect(() =>
        validateAgentPromptPayload({
          type: 'agent_prompt',
          prompt: 'Do something',
          sessionPolicy: 'existing_session',
        })
      ).toThrow(ValidationError);

      // Missing or wrong sessionPolicy
      expect(() =>
        validateAgentPromptPayload({
          type: 'agent_prompt',
          prompt: 'Do something',
          sessionId: validSessionId,
        })
      ).toThrow(ValidationError);

      expect(() =>
        validateAgentPromptPayload({
          type: 'agent_prompt',
          prompt: 'Do something',
          sessionId: validSessionId,
          sessionPolicy: 'new_session' as any,
        })
      ).toThrow(ValidationError);
    });

    it('strictly whitelists top-level fields and rejects model, context, metadata, and execution keys', () => {
      // 1. Direct executable key
      expect(() =>
        validateAgentPromptPayload({
          type: 'agent_prompt',
          prompt: 'Valid prompt',
          sessionId: validSessionId,
          sessionPolicy: 'existing_session',
          command: 'rm -rf /',
        })
      ).toThrow(ValidationError);

      // 2. Direct script key
      expect(() =>
        validateAgentPromptPayload({
          type: 'agent_prompt',
          prompt: 'Valid prompt',
          sessionId: validSessionId,
          sessionPolicy: 'existing_session',
          script: 'echo 123',
        })
      ).toThrow(ValidationError);

      // 3. model override is rejected from payload
      expect(() =>
        validateAgentPromptPayload({
          type: 'agent_prompt',
          prompt: 'Valid prompt',
          sessionId: validSessionId,
          sessionPolicy: 'existing_session',
          model: 'gpt-4o',
        })
      ).toThrow(ValidationError);

      // 4. context is rejected from payload
      expect(() =>
        validateAgentPromptPayload({
          type: 'agent_prompt',
          prompt: 'Valid prompt',
          sessionId: validSessionId,
          sessionPolicy: 'existing_session',
          context: { foo: 'bar' },
        })
      ).toThrow(ValidationError);

      // 5. metadata is rejected from payload
      expect(() =>
        validateAgentPromptPayload({
          type: 'agent_prompt',
          prompt: 'Valid prompt',
          sessionId: validSessionId,
          sessionPolicy: 'existing_session',
          metadata: { traceId: '123' },
        })
      ).toThrow(ValidationError);

      // 6. Random arbitrary unknown key
      expect(() =>
        validateAgentPromptPayload({
          type: 'agent_prompt',
          prompt: 'Valid prompt',
          sessionId: validSessionId,
          sessionPolicy: 'existing_session',
          unknownField: 'foo',
        })
      ).toThrow(ValidationError);

      expect(ALLOWED_AGENT_PROMPT_PAYLOAD_KEYS.has('command')).toBe(false);
      expect(ALLOWED_AGENT_PROMPT_PAYLOAD_KEYS.has('model')).toBe(false);
      expect(ALLOWED_AGENT_PROMPT_PAYLOAD_KEYS.has('context')).toBe(false);
      expect(ALLOWED_AGENT_PROMPT_PAYLOAD_KEYS.has('metadata')).toBe(false);
      expect(ALLOWED_AGENT_PROMPT_PAYLOAD_KEYS.has('sessionPolicy')).toBe(true);
    });

    it('permits natural language prompt containing the words "bash", "script", "command" without false positives', async () => {
      const ops = service.forTenant('user_1');

      // Prompt discussing bash and scripts in natural language
      const { task } = await ops.tasks.createTask({
        title: 'Bash Script Explanation Task',
        payload: {
          type: 'agent_prompt',
          prompt: 'Write a comprehensive guide explaining how bash scripts execute shell commands and handle subshell processes.',
          sessionId: validSessionId,
          sessionPolicy: 'existing_session',
        },
      });

      expect(task.status).toBe('pending');
      expect(task.payload?.prompt).toContain('how bash scripts execute shell commands');
    });
  });

  describe('Task Due Date Scheduling Semantics', () => {
    it('rejects tasks with invalid dueDate format', async () => {
      const ops = service.forTenant('user_1');

      await expect(
        ops.tasks.createTask({
          title: 'Invalid Due Date',
          dueDate: 'invalid-date-string-abc',
          payload: defaultPayload,
        })
      ).rejects.toThrow(ValidationError);
    });

    it('does NOT claim tasks with a future dueDate until they become due', async () => {
      const ops = service.forTenant('user_1');

      // Task 1: Due in 1 hour
      const futureDate = new Date(Date.now() + 3600_000).toISOString();
      const { task: futureTask } = await ops.tasks.createTask({
        title: 'Future Task',
        dueDate: futureDate,
        priority: 'urgent',
        payload: defaultPayload,
      });

      // General claim should return null since futureTask is not due yet
      const claimResult = await ops.tasks.claimTask({ claimantId: 'worker_1' });
      expect(claimResult).toBeNull();

      // Preferred claim on future task should also return null
      const preferredClaim = await ops.tasks.claimTask({
        claimantId: 'worker_1',
        preferredTaskId: futureTask.id,
      });
      expect(preferredClaim).toBeNull();
    });

    it('claims tasks with past dueDate or null dueDate immediately', async () => {
      const ops = service.forTenant('user_1');

      // Task 1: Due 10 minutes ago
      const pastDate = new Date(Date.now() - 600_000).toISOString();
      const { task: pastTask } = await ops.tasks.createTask({
        title: 'Past Due Task',
        dueDate: pastDate,
        priority: 'medium',
        payload: defaultPayload,
      });

      // Task 2: No due date
      const { task: immediateTask } = await ops.tasks.createTask({
        title: 'Immediate Task',
        priority: 'medium',
        payload: defaultPayload,
      });

      // Claim 1: pastTask is due and should be picked (earliest due date before null)
      const claim1 = await ops.tasks.claimTask({ claimantId: 'worker_1' });
      expect(claim1?.id).toBe(pastTask.id);

      // Claim 2: immediateTask (null dueDate)
      const claim2 = await ops.tasks.claimTask({ claimantId: 'worker_2' });
      expect(claim2?.id).toBe(immediateTask.id);
    });
  });

  describe('Task Schedule Misfire & Overlap Policies Validation', () => {
    it('validates misfire policy: accepts coalesce and skip, rejects run_all and invalid values', () => {
      expect(validateMisfirePolicy(undefined)).toBe('coalesce');
      expect(validateMisfirePolicy(null)).toBe('coalesce');
      expect(validateMisfirePolicy('coalesce')).toBe('coalesce');
      expect(validateMisfirePolicy('skip')).toBe('skip');

      expect(() => validateMisfirePolicy('run_all')).toThrow(ValidationError);
      expect(() => validateMisfirePolicy('invalid')).toThrow(ValidationError);
      expect(() => validateMisfirePolicy(123)).toThrow(ValidationError);
    });

    it('validates overlap policy: accepts skip only, rejects allow, queue, and invalid values', () => {
      expect(validateOverlapPolicy(undefined)).toBe('skip');
      expect(validateOverlapPolicy(null)).toBe('skip');
      expect(validateOverlapPolicy('skip')).toBe('skip');

      expect(() => validateOverlapPolicy('allow')).toThrow(ValidationError);
      expect(() => validateOverlapPolicy('queue')).toThrow(ValidationError);
      expect(() => validateOverlapPolicy('invalid')).toThrow(ValidationError);
      expect(() => validateOverlapPolicy(true)).toThrow(ValidationError);
    });

    it('creates scheduled tasks with valid policies and rejects unsupported policies in service', async () => {
      const ops = service.forTenant('user_1');

      // Valid policies
      const { task } = await ops.tasks.createTask({
        title: 'Task with valid policies',
        scheduleType: 'cron',
        cronExpression: '0 0 * * *',
        misfirePolicy: 'skip',
        overlapPolicy: 'skip',
        payload: defaultPayload,
      });
      expect(task.schedule?.misfirePolicy).toBe('skip');
      expect(task.schedule?.overlapPolicy).toBe('skip');

      // Reject run_all
      await expect(
        ops.tasks.createTask({
          title: 'Reject run_all',
          scheduleType: 'cron',
          cronExpression: '0 0 * * *',
          misfirePolicy: 'run_all' as any,
          payload: defaultPayload,
        })
      ).rejects.toThrow(ValidationError);

      // Reject allow
      await expect(
        ops.tasks.createTask({
          title: 'Reject allow',
          scheduleType: 'cron',
          cronExpression: '0 0 * * *',
          overlapPolicy: 'allow' as any,
          payload: defaultPayload,
        })
      ).rejects.toThrow(ValidationError);

      // Reject queue
      await expect(
        ops.tasks.createTask({
          title: 'Reject queue',
          scheduleType: 'cron',
          cronExpression: '0 0 * * *',
          overlapPolicy: 'queue' as any,
          payload: defaultPayload,
        })
      ).rejects.toThrow(ValidationError);
    });
  });
});
