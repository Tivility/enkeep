import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  ModelSelectionService,
  ModelCircuitBreakerRegistry,
  DeliveryRuntimeGateway,
  SqliteWebMessageStore,
  classifyError,
} from '../src/index.js';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';

describe('Model Selection Circuit Breaker & Fallback Engine', () => {
  let db: DatabaseSync;
  let service: ModelSelectionService;
  let simulatedClock = 1000000;

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    simulatedClock = 1000000;
    service = new ModelSelectionService({
      db,
      circuitBreakerConfig: {
        consecutiveFailuresThreshold: 3,
        cooldownDurationMs: 30000,
        halfOpenMaxTrials: 1,
        now: () => simulatedClock,
      },
    });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  describe('1. Error Classification (classifyError)', () => {
    it('classifies 401 and 403 as permanent AUTH_FAILURE', () => {
      const c401 = classifyError(401);
      expect(c401.isAuthOrPermanent).toBe(true);
      expect(c401.isTransient).toBe(false);
      expect(c401.errorType).toBe('AUTH_FAILURE');

      const c403 = classifyError({ status: 403, message: 'Forbidden access' });
      expect(c403.isAuthOrPermanent).toBe(true);
      expect(c403.isTransient).toBe(false);
      expect(c403.errorType).toBe('AUTH_FAILURE');

      const cMsg = classifyError('Invalid API Key provided');
      expect(cMsg.isAuthOrPermanent).toBe(true);
      expect(cMsg.isTransient).toBe(false);
      expect(cMsg.errorType).toBe('AUTH_FAILURE');
    });

    it('classifies 400 and 422 as permanent INVALID_REQUEST', () => {
      const c400 = classifyError(400);
      expect(c400.isAuthOrPermanent).toBe(true);
      expect(c400.isTransient).toBe(false);
      expect(c400.errorType).toBe('INVALID_REQUEST');

      const c422 = classifyError({ statusCode: 422, message: 'Unprocessable Entity' });
      expect(c422.isAuthOrPermanent).toBe(true);
      expect(c422.isTransient).toBe(false);
    });

    it('classifies 429 as transient RATE_LIMIT', () => {
      const c429 = classifyError(429);
      expect(c429.isTransient).toBe(true);
      expect(c429.isAuthOrPermanent).toBe(false);
      expect(c429.errorType).toBe('RATE_LIMIT');

      const cMsg = classifyError('Too Many Requests: Rate limit exceeded');
      expect(cMsg.isTransient).toBe(true);
      expect(cMsg.errorType).toBe('RATE_LIMIT');
    });

    it('classifies 500, 502, 503, 504 and network errors as transient', () => {
      const c503 = classifyError(503);
      expect(c503.isTransient).toBe(true);
      expect(c503.isAuthOrPermanent).toBe(false);

      const cTimeout = classifyError(new Error('ETIMEDOUT: Connection timed out'));
      expect(cTimeout.isTransient).toBe(true);
      expect(cTimeout.errorType).toBe('TRANSIENT_NETWORK');

      const cConnReset = classifyError(new Error('ECONNRESET: socket hang up'));
      expect(cConnReset.isTransient).toBe(true);
      expect(cConnReset.errorType).toBe('TRANSIENT_NETWORK');
    });
  });

  describe('2. Circuit Breaker State Transitions (closed -> open -> half-open -> closed)', () => {
    it('starts in closed state and allows execution', () => {
      const check = service.circuitRegistry.canExecute('demo-provider', 'demo-model');
      expect(check.allowed).toBe(true);
      expect(check.state).toBe('closed');
    });

    it('trips to open state after consecutive transient failures meet threshold (3)', () => {
      const p = 'test-provider';
      const m = 'test-model';

      // Failure 1
      const f1 = service.circuitRegistry.recordFailure(p, m, { status: 503, message: 'Unavailable' });
      expect(f1.state).toBe('closed');
      expect(f1.consecutiveFailures).toBe(1);

      // Failure 2
      const f2 = service.circuitRegistry.recordFailure(p, m, { status: 503, message: 'Unavailable' });
      expect(f2.state).toBe('closed');
      expect(f2.consecutiveFailures).toBe(2);

      // Failure 3 -> Trips breaker
      const f3 = service.circuitRegistry.recordFailure(p, m, { status: 503, message: 'Unavailable' });
      expect(f3.state).toBe('open');
      expect(f3.consecutiveFailures).toBe(3);

      // Now execution is blocked
      const check = service.circuitRegistry.canExecute(p, m);
      expect(check.allowed).toBe(false);
      expect(check.state).toBe('open');
      expect(check.reason).toContain('Circuit breaker is open');
    });

    it('transitions to half-open after cooldown period (30s) and probes with single trial', () => {
      const p = 'test-provider';
      const m = 'test-model';

      // Trip breaker
      service.circuitRegistry.recordFailure(p, m, { status: 503 });
      service.circuitRegistry.recordFailure(p, m, { status: 503 });
      service.circuitRegistry.recordFailure(p, m, { status: 503 });

      expect(service.circuitRegistry.canExecute(p, m).allowed).toBe(false);

      // Advance clock by 10s (< 30s cooldown) -> still open
      simulatedClock += 10000;
      expect(service.circuitRegistry.canExecute(p, m).allowed).toBe(false);

      // Advance clock by another 21s (total 31s > 30s cooldown) -> half-open trial allowed
      simulatedClock += 21000;
      const trialCheck = service.circuitRegistry.canExecute(p, m);
      expect(trialCheck.allowed).toBe(true);
      expect(trialCheck.state).toBe('half-open');

      // Second concurrent trial while half-open trial in progress is rejected
      const concurrentCheck = service.circuitRegistry.canExecute(p, m);
      expect(concurrentCheck.allowed).toBe(false);
      expect(concurrentCheck.state).toBe('half-open');

      // Successful trial settles breaker back to closed
      service.circuitRegistry.recordSuccess(p, m, 45);
      const settledCheck = service.circuitRegistry.canExecute(p, m);
      expect(settledCheck.allowed).toBe(true);
      expect(settledCheck.state).toBe('closed');
    });

    it('re-trips to open if half-open trial fails', () => {
      const p = 'test-provider';
      const m = 'test-model';

      // Trip breaker
      service.circuitRegistry.recordFailure(p, m, { status: 503 });
      service.circuitRegistry.recordFailure(p, m, { status: 503 });
      service.circuitRegistry.recordFailure(p, m, { status: 503 });

      // Advance clock past cooldown
      simulatedClock += 35000;
      expect(service.circuitRegistry.canExecute(p, m).allowed).toBe(true); // Enters half-open

      // Trial fails
      const fTrial = service.circuitRegistry.recordFailure(p, m, { status: 503 });
      expect(fTrial.state).toBe('open');

      // Immediately blocked again
      expect(service.circuitRegistry.canExecute(p, m).allowed).toBe(false);
    });

    it('resetCircuitBreakers manually resets single or all tripped breakers', () => {
      const p1 = 'provider1';
      const m1 = 'model1';
      const p2 = 'provider2';
      const m2 = 'model2';

      // Trip both
      for (let i = 0; i < 3; i++) {
        service.circuitRegistry.recordFailure(p1, m1, 503);
        service.circuitRegistry.recordFailure(p2, m2, 503);
      }

      expect(service.circuitRegistry.canExecute(p1, m1).allowed).toBe(false);
      expect(service.circuitRegistry.canExecute(p2, m2).allowed).toBe(false);

      // Reset p1 only
      const resetP1 = service.circuitRegistry.reset(p1, m1);
      expect(resetP1).toBe(1);
      expect(service.circuitRegistry.canExecute(p1, m1).allowed).toBe(true);
      expect(service.circuitRegistry.canExecute(p2, m2).allowed).toBe(false);

      // Reset all
      const resetAll = service.circuitRegistry.reset();
      expect(resetAll).toBe(2);
      expect(service.circuitRegistry.canExecute(p2, m2).allowed).toBe(true);
    });
  });

  describe('3. Ordered Fallback Chain Execution (executeWithFallback)', () => {
    it('executes primary model successfully without invoking fallback chain', async () => {
      const effective = {
        provider: 'primary-provider',
        model: 'primary-model',
        fallbackChain: [
          { provider: 'backup-provider', model: 'backup-model' },
        ],
        source: 'space' as const,
        revision: 'rev1',
      };

      const executeFn = vi.fn().mockResolvedValue('primary response');

      const outcome = await service.executeWithFallback(effective, executeFn);
      expect(outcome.result).toBe('primary response');
      expect(outcome.usedModel.provider).toBe('primary-provider');
      expect(outcome.fallbackUsed).toBe(false);
      expect(outcome.attempts.length).toBe(1);
      expect(outcome.attempts[0].success).toBe(true);
      expect(executeFn).toHaveBeenCalledTimes(1);
    });

    it('switches to fallback candidate on primary transient failure (503/429)', async () => {
      const effective = {
        provider: 'primary-provider',
        model: 'primary-model',
        fallbackChain: [
          { provider: 'backup-provider', model: 'backup-model' },
        ],
        source: 'session' as const,
        revision: 'rev2',
      };

      const executeFn = vi.fn().mockImplementation(async (target) => {
        if (target.provider === 'primary-provider') {
          const err = new Error('503 Service Unavailable');
          (err as any).status = 503;
          throw err;
        }
        return 'backup response';
      });

      const outcome = await service.executeWithFallback(effective, executeFn);
      expect(outcome.result).toBe('backup response');
      expect(outcome.usedModel.provider).toBe('backup-provider');
      expect(outcome.fallbackUsed).toBe(true);
      expect(outcome.attempts.length).toBe(2);
      expect(outcome.attempts[0].success).toBe(false);
      expect(outcome.attempts[0].statusCode).toBe(503);
      expect(outcome.attempts[1].success).toBe(true);
    });

    it('skips open circuit candidates immediately and proceeds to next healthy fallback', async () => {
      const p1 = 'primary-provider';
      const m1 = 'primary-model';
      const p2 = 'backup-provider';
      const m2 = 'backup-model';

      // Trip primary breaker
      for (let i = 0; i < 3; i++) {
        service.circuitRegistry.recordFailure(p1, m1, 503);
      }

      const effective = {
        provider: p1,
        model: m1,
        fallbackChain: [
          { provider: p2, model: m2 },
        ],
        source: 'platform' as const,
        revision: 'rev3',
      };

      const executeFn = vi.fn().mockResolvedValue('backup success');

      const outcome = await service.executeWithFallback(effective, executeFn);
      expect(outcome.result).toBe('backup success');
      expect(outcome.usedModel.provider).toBe(p2);
      expect(outcome.fallbackUsed).toBe(true);
      expect(outcome.attempts[0].errorType).toBe('CIRCUIT_OPEN');
      expect(outcome.attempts[1].success).toBe(true);
      expect(executeFn).toHaveBeenCalledTimes(1); // Primary wasn't even called
    });

    it('fails fast on AUTH_FAILURE (401/403) without unsafe fallback', async () => {
      const effective = {
        provider: 'primary-provider',
        model: 'primary-model',
        fallbackChain: [
          { provider: 'backup-provider', model: 'backup-model' },
        ],
        source: 'user' as const,
        revision: 'rev4',
      };

      const executeFn = vi.fn().mockImplementation(async () => {
        const err = new Error('401 Unauthorized: Invalid API Key');
        (err as any).status = 401;
        throw err;
      });

      await expect(service.executeWithFallback(effective, executeFn)).rejects.toThrow(/Unauthorized/);
      expect(executeFn).toHaveBeenCalledTimes(1); // Did NOT try backup
    });

    it('throws 503 SERVICE_UNAVAILABLE when all candidates in fallback chain fail', async () => {
      const effective = {
        provider: 'p1',
        model: 'm1',
        fallbackChain: [
          { provider: 'p2', model: 'm2' },
          { provider: 'p3', model: 'm3' },
        ],
        source: 'dsh_default' as const,
        revision: 'rev5',
      };

      const executeFn = vi.fn().mockRejectedValue(new Error('500 Internal Server Error'));

      await expect(service.executeWithFallback(effective, executeFn)).rejects.toThrow();
      expect(executeFn).toHaveBeenCalledTimes(3);
    });

    it('DeliveryRuntimeGateway invokes executor.execute exactly once with effective modelSelection including fallbackChain', async () => {
      const storage = new SqlitePlatformStorage(db);
      const messageStore = new SqliteWebMessageStore(db);

      // Seed user, space and route
      db.prepare("INSERT INTO users (id, username, password_hash, status) VALUES ('u_fb', 'ufb', 'hash', 'active')").run();
      db.prepare("INSERT INTO spaces (id, user_id, name, folder, status) VALUES ('sp_fallback', 'u_fb', 'FB Space', 'fb-space', 'active')").run();
      db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode) VALUES ('ses_fb', 'u_fb', 'sp_fallback', 'web', 'web-demo', 'ses_fb', 'p1', 'dsh_fb', 'container')").run();

      // Configure session model override with fallbackChain using valid catalog providers
      await service.setOverride('u_fb', 'session', 'ses_fb', {
        provider: 'cpa-claude',
        model: 'claude-fable-5',
        fallbackChain: [{ provider: 'cpa-gemini', model: 'gemini-3.7-flash-tiered' }],
      });

      const calls: any[] = [];
      const executor = {
        execute: async (req: any) => {
          calls.push(req);
          return {
            replyText: `Executed via model: ${req.modelSelection?.model}`,
            usage: { totalTokens: 42 },
          };
        },
        cancel: async () => true,
      };

      const gateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor,
        quotaMode: 'disabled',
        modelSelectionService: service,
        profileResolver: { resolve: async () => null },
      });

      const dispatchRes = await gateway.dispatchInbound({
        id: 'deliv_fb_1',
        userId: 'u_fb',
        sessionId: 'ses_fb',
        content: 'Test fallback execution in delivery gateway',
        timestamp: new Date().toISOString(),
      });

      expect(dispatchRes.accepted).toBe(true);
      await gateway.drain(1000);

      // Verify executor was called exactly once with effective model and fallbackChain
      expect(calls.length).toBe(1);
      expect(calls[0].modelSelection?.provider).toBe('cpa-claude');
      expect(calls[0].modelSelection?.model).toBe('claude-fable-5');
      expect(calls[0].modelSelection?.fallbackChain).toEqual([
        { provider: 'cpa-gemini', model: 'gemini-3.7-flash-tiered', reasoningEffort: undefined },
      ]);

      // Verify turn completed with replyText
      const msgs = await messageStore.listMessages('u_fb', 'ses_fb');
      expect(msgs.messages.length).toBe(2);
      expect(msgs.messages[1].role).toBe('assistant');
      expect(msgs.messages[1].content).toContain('Executed via model: claude-fable-5');

      const turnStatus = await gateway.getTurnStatus('u_fb', dispatchRes.turnId);
      expect(turnStatus?.status).toBe('completed');
    });
  });

  describe('4. Rolling Database Health Telemetry (model_health table)', () => {
    it('persists telemetry records in model_health table without prompt or content', async () => {
      await service.recordHealth({
        provider: 'cpa-claude',
        model: 'claude-fable-5',
        latencyMs: 124,
        statusCode: 200,
        success: true,
        apiCalls: 1,
        tokens: 350,
      });

      await service.recordHealth({
        provider: 'cpa-gpt',
        model: 'gpt-4o',
        latencyMs: 890,
        statusCode: 503,
        success: false,
        errorType: 'TRANSIENT_NETWORK',
        apiCalls: 1,
        tokens: 0,
      });

      const rows = db.prepare('SELECT * FROM model_health ORDER BY created_at ASC').all() as any[];
      expect(rows.length).toBe(2);

      // Verify no sensitive prompt columns exist in table
      const columns = Object.keys(rows[0]);
      expect(columns).not.toContain('prompt');
      expect(columns).not.toContain('content');
      expect(columns).not.toContain('messages');
      expect(columns).not.toContain('replyText');

      expect(rows[0].provider).toBe('cpa-claude');
      expect(rows[0].success).toBe(1);
      expect(rows[0].tokens).toBe(350);

      expect(rows[1].provider).toBe('cpa-gpt');
      expect(rows[1].success).toBe(0);
      expect(rows[1].error_type).toBe('TRANSIENT_NETWORK');
    });
  });
});
