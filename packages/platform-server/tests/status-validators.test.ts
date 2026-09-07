/**
 * Status Validator Tests
 *
 * Validates the truthful, minimal contracts for:
 * 1. UserRuntimeStatus
 * 2. OperationsReadinessStatus (producer and worker)
 *
 * @module @enkeep/platform-server/tests/status-validators
 */

import { describe, it, expect } from 'vitest';
import {
  validateUserRuntimeStatus,
  validateOperationsProducerStatus,
  validateOperationsWorkerStatus,
  validateOperationsReadinessStatus,
  ALLOWED_TOOLS_UNAVAILABLE_REASONS,
  type UserRuntimeStatus,
  type OperationsReadinessStatus,
} from '../src/index.js';

describe('Truthful Minimal Status Validators', () => {
  const validPlugins = {
    receiptStore: true,
    inbound: true,
    eventRelay: true,
    tools: true,
    externalInteraction: true,
    affinityPolicy: true,
    llmAffinity: true,
  };

  const validHealthyStatus: UserRuntimeStatus = {
    userId: 'alice',
    status: 'ok',
    networkMode: 'none',
    dshReady: true,
    uptimeSeconds: 120,
    version: '0.1.0-alpha',
    enkeepBundleLoaded: true,
    toolsCount: 4,
    plugins: { ...validPlugins },
    toolsOperational: true,
    toolsUnavailableReason: null,
  };

  describe('validateUserRuntimeStatus', () => {
    it('accepts a fully compliant UserRuntimeStatus with status ok and operational tools', () => {
      const validated = validateUserRuntimeStatus(validHealthyStatus);
      expect(validated).not.toBeNull();
      expect(validated).toEqual(validHealthyStatus);
    });

    it('accepts status "degraded" and "error"', () => {
      expect(validateUserRuntimeStatus({ ...validHealthyStatus, status: 'degraded' })?.status).toBe('degraded');
      expect(validateUserRuntimeStatus({ ...validHealthyStatus, status: 'error' })?.status).toBe('error');
    });

    it('accepts toolsOperational false with every allowed reason code', () => {
      for (const reason of ALLOWED_TOOLS_UNAVAILABLE_REASONS) {
        const input = {
          ...validHealthyStatus,
          toolsOperational: false,
          toolsUnavailableReason: reason,
        };
        const validated = validateUserRuntimeStatus(input);
        expect(validated).not.toBeNull();
        expect(validated?.toolsOperational).toBe(false);
        expect(validated?.toolsUnavailableReason).toBe(reason);
      }
    });

    it('strictly rejects legacy status values (healthy, starting, stopped, unavailable)', () => {
      expect(validateUserRuntimeStatus({ ...validHealthyStatus, status: 'healthy' })).toBeNull();
      expect(validateUserRuntimeStatus({ ...validHealthyStatus, status: 'starting' })).toBeNull();
      expect(validateUserRuntimeStatus({ ...validHealthyStatus, status: 'stopped' })).toBeNull();
      expect(validateUserRuntimeStatus({ ...validHealthyStatus, status: 'unavailable' })).toBeNull();
    });

    it('strictly rejects extraneous keys (available, containerId, containerName, volume, sessionId)', () => {
      expect(validateUserRuntimeStatus({ ...validHealthyStatus, available: true })).toBeNull();
      expect(validateUserRuntimeStatus({ ...validHealthyStatus, containerId: 'c1234567890' })).toBeNull();
      expect(validateUserRuntimeStatus({ ...validHealthyStatus, containerName: 'enkeep-demo-alice' })).toBeNull();
      expect(validateUserRuntimeStatus({ ...validHealthyStatus, volume: 'vol_alice' })).toBeNull();
      expect(validateUserRuntimeStatus({ ...validHealthyStatus, sessionId: 'ses_123' })).toBeNull();
      expect(validateUserRuntimeStatus({ ...validHealthyStatus, totalEvents: 10 })).toBeNull();
    });

    it('strictly rejects invalid userId (empty, spaces, special symbols)', () => {
      expect(validateUserRuntimeStatus({ ...validHealthyStatus, userId: '' })).toBeNull();
      expect(validateUserRuntimeStatus({ ...validHealthyStatus, userId: '   ' })).toBeNull();
      expect(validateUserRuntimeStatus({ ...validHealthyStatus, userId: 'alice/admin' })).toBeNull();
      expect(validateUserRuntimeStatus({ ...validHealthyStatus, userId: 'alice@domain' })).toBeNull();
    });

    it('strictly requires networkMode to be "none"', () => {
      expect(validateUserRuntimeStatus({ ...validHealthyStatus, networkMode: 'bridge' })).toBeNull();
      expect(validateUserRuntimeStatus({ ...validHealthyStatus, networkMode: 'host' })).toBeNull();
      expect(validateUserRuntimeStatus({ ...validHealthyStatus, networkMode: 'none ' })).toBeNull();
    });

    it('strictly enforces uptimeSeconds to be a finite, non-negative number', () => {
      expect(validateUserRuntimeStatus({ ...validHealthyStatus, uptimeSeconds: -1 })).toBeNull();
      expect(validateUserRuntimeStatus({ ...validHealthyStatus, uptimeSeconds: NaN })).toBeNull();
      expect(validateUserRuntimeStatus({ ...validHealthyStatus, uptimeSeconds: Infinity })).toBeNull();
      expect(validateUserRuntimeStatus({ ...validHealthyStatus, uptimeSeconds: '120' as any })).toBeNull();
      expect(validateUserRuntimeStatus({ ...validHealthyStatus, uptimeSeconds: 0 })?.uptimeSeconds).toBe(0);
    });

    it('strictly enforces version to be a non-empty string', () => {
      expect(validateUserRuntimeStatus({ ...validHealthyStatus, version: '' })).toBeNull();
      expect(validateUserRuntimeStatus({ ...validHealthyStatus, version: '   ' })).toBeNull();
      expect(validateUserRuntimeStatus({ ...validHealthyStatus, version: 123 as any })).toBeNull();
    });

    it('strictly enforces toolsCount to be a non-negative safe integer', () => {
      expect(validateUserRuntimeStatus({ ...validHealthyStatus, toolsCount: -1 })).toBeNull();
      expect(validateUserRuntimeStatus({ ...validHealthyStatus, toolsCount: 1.5 })).toBeNull();
      expect(validateUserRuntimeStatus({ ...validHealthyStatus, toolsCount: NaN })).toBeNull();
      expect(validateUserRuntimeStatus({ ...validHealthyStatus, toolsCount: 0 })?.toolsCount).toBe(0);
    });

    it('strictly enforces plugins to have exactly 7 boolean keys', () => {
      // Missing a key
      const { receiptStore, ...missingKeyPlugins } = validPlugins;
      expect(validateUserRuntimeStatus({ ...validHealthyStatus, plugins: missingKeyPlugins as any })).toBeNull();

      // Extra key
      expect(validateUserRuntimeStatus({ ...validHealthyStatus, plugins: { ...validPlugins, extraPlugin: true } })).toBeNull();

      // Non-boolean value
      expect(validateUserRuntimeStatus({ ...validHealthyStatus, plugins: { ...validPlugins, receiptStore: 'true' as any } })).toBeNull();
    });

    it('strictly enforces toolsOperational relationship: true => reason null', () => {
      expect(validateUserRuntimeStatus({
        ...validHealthyStatus,
        toolsOperational: true,
        toolsUnavailableReason: 'PLATFORM_CLIENT_UNAVAILABLE',
      })).toBeNull();

      expect(validateUserRuntimeStatus({
        ...validHealthyStatus,
        toolsOperational: true,
        toolsUnavailableReason: 'Arbitrary error message' as any,
      })).toBeNull();
    });

    it('strictly enforces toolsOperational relationship: false => exact reason code required', () => {
      expect(validateUserRuntimeStatus({
        ...validHealthyStatus,
        toolsOperational: false,
        toolsUnavailableReason: null,
      })).toBeNull();

      expect(validateUserRuntimeStatus({
        ...validHealthyStatus,
        toolsOperational: false,
        toolsUnavailableReason: 'Random unwhitelisted error code' as any,
      })).toBeNull();
    });
  });

  describe('validateOperationsProducerStatus', () => {
    it('accepts available: true with unavailableReason: null', () => {
      const validated = validateOperationsProducerStatus({
        available: true,
        unavailableReason: null,
      });
      expect(validated).toEqual({
        available: true,
        unavailableReason: null,
      });
    });

    it('accepts available: false with unavailableReason: OPERATIONS_PROVIDER_UNAVAILABLE', () => {
      const validated = validateOperationsProducerStatus({
        available: false,
        unavailableReason: 'OPERATIONS_PROVIDER_UNAVAILABLE',
      });
      expect(validated).toEqual({
        available: false,
        unavailableReason: 'OPERATIONS_PROVIDER_UNAVAILABLE',
      });
    });

    it('rejects available: true with non-null unavailableReason', () => {
      expect(validateOperationsProducerStatus({
        available: true,
        unavailableReason: 'OPERATIONS_PROVIDER_UNAVAILABLE',
      })).toBeNull();
    });

    it('rejects available: false with null or unknown unavailableReason', () => {
      expect(validateOperationsProducerStatus({
        available: false,
        unavailableReason: null,
      })).toBeNull();

      expect(validateOperationsProducerStatus({
        available: false,
        unavailableReason: 'UNKNOWN_REASON' as any,
      })).toBeNull();
    });

    it('rejects extraneous keys (status, mode, enabled, etc.)', () => {
      expect(validateOperationsProducerStatus({
        available: true,
        unavailableReason: null,
        status: 'available',
      })).toBeNull();

      expect(validateOperationsProducerStatus({
        available: true,
        unavailableReason: null,
        mode: 'active',
      })).toBeNull();
    });
  });

  describe('validateOperationsWorkerStatus', () => {
    it('accepts available: true, running: true, unavailableReason: null', () => {
      const validated = validateOperationsWorkerStatus({
        available: true,
        running: true,
        unavailableReason: null,
      });
      expect(validated).toEqual({
        available: true,
        running: true,
        unavailableReason: null,
      });
    });

    it('accepts available: true, running: false, unavailableReason: null', () => {
      const validated = validateOperationsWorkerStatus({
        available: true,
        running: false,
        unavailableReason: null,
      });
      expect(validated).toEqual({
        available: true,
        running: false,
        unavailableReason: null,
      });
    });

    it('accepts available: false, running: false with WORKER_DISABLED or WORKER_UNAVAILABLE', () => {
      expect(validateOperationsWorkerStatus({
        available: false,
        running: false,
        unavailableReason: 'WORKER_DISABLED',
      })).toEqual({
        available: false,
        running: false,
        unavailableReason: 'WORKER_DISABLED',
      });

      expect(validateOperationsWorkerStatus({
        available: false,
        running: false,
        unavailableReason: 'WORKER_UNAVAILABLE',
      })).toEqual({
        available: false,
        running: false,
        unavailableReason: 'WORKER_UNAVAILABLE',
      });
    });

    it('strictly enforces running => available: running cannot be true if available is false', () => {
      expect(validateOperationsWorkerStatus({
        available: false,
        running: true,
        unavailableReason: 'WORKER_UNAVAILABLE',
      })).toBeNull();
    });

    it('strictly rejects available: true with non-null unavailableReason', () => {
      expect(validateOperationsWorkerStatus({
        available: true,
        running: true,
        unavailableReason: 'WORKER_DISABLED',
      })).toBeNull();
    });

    it('strictly rejects available: false with null or invalid reason code', () => {
      expect(validateOperationsWorkerStatus({
        available: false,
        running: false,
        unavailableReason: null,
      })).toBeNull();

      expect(validateOperationsWorkerStatus({
        available: false,
        running: false,
        unavailableReason: 'UNKNOWN_CODE' as any,
      })).toBeNull();
    });

    it('rejects extraneous keys (status, mode, enabled, etc.)', () => {
      expect(validateOperationsWorkerStatus({
        available: true,
        running: false,
        unavailableReason: null,
        status: 'idle',
      })).toBeNull();

      expect(validateOperationsWorkerStatus({
        available: true,
        running: false,
        unavailableReason: null,
        enabled: true,
      })).toBeNull();
    });
  });

  describe('validateOperationsReadinessStatus', () => {
    it('accepts valid nested producer and worker without any top-level status/mode fields', () => {
      const validOps: OperationsReadinessStatus = {
        producer: {
          available: true,
          unavailableReason: null,
        },
        worker: {
          available: true,
          running: false,
          unavailableReason: null,
        },
      };

      const validated = validateOperationsReadinessStatus(validOps);
      expect(validated).not.toBeNull();
      expect(validated).toEqual(validOps);
      expect(Object.keys(validated!)).toEqual(['producer', 'worker']);
    });

    it('rejects top-level status, available, mode, or aliases', () => {
      const opsWithTopFields = {
        producer: {
          available: true,
          unavailableReason: null,
        },
        worker: {
          available: true,
          running: false,
          unavailableReason: null,
        },
        available: true,
        status: 'available',
        mode: 'active',
      };

      expect(validateOperationsReadinessStatus(opsWithTopFields)).toBeNull();
    });

    it('rejects if either producer or worker is invalid', () => {
      expect(validateOperationsReadinessStatus({
        producer: { available: true, unavailableReason: 'OPERATIONS_PROVIDER_UNAVAILABLE' },
        worker: { available: true, running: false, unavailableReason: null },
      })).toBeNull();

      expect(validateOperationsReadinessStatus({
        producer: { available: true, unavailableReason: null },
        worker: { available: false, running: true, unavailableReason: 'WORKER_UNAVAILABLE' },
      })).toBeNull();
    });
  });
});
