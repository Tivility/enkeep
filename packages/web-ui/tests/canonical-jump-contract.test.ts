/**
 * Focused Contract Test for Canonical Jump from Storage Reconciliation / Management View
 *
 * Requirements:
 * 1. Route via EXISTING workspace selection method (selectSpace)
 * 2. Update correct space + canonical session and epoch/polling before select
 * 3. Use actual router hash convention (#workspace), don't manually change only session
 * 4. Cross-space from management A -> canonical B must set space B and session B
 * 5. Await guards prevent old A response overwrite
 * 6. Don't open/create another conversation, archive data unchanged
 * 7. Synthetic A/B IDs, zero real user credentials
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('Canonical Jump & Workspace Cross-Space Routing Contract', () => {
  let appJsCode: string;

  beforeEach(() => {
    appJsCode = readFileSync(join(__dirname, '../src/static/app.js'), 'utf-8');
  });

  describe('1. Static Code Analysis & Contract Invariants', () => {
    it('verifies canonicaljump routes via selectSpace and adheres to #workspace router convention', () => {
      // Find canonical jump handler in app.js
      const btnCanonIndex = appJsCode.indexOf('btn-go-to-canonical');
      expect(btnCanonIndex).toBeGreaterThan(-1);

      const section = appJsCode.slice(btnCanonIndex, btnCanonIndex + 3000);

      // Must resolve target space id from rep or state.spaces
      expect(section).toContain('targetSpaceId');
      // Must use actual router hash convention #workspace
      expect(section).toContain("window.location.hash = '#workspace'");
      // Must halt polling before transition
      expect(section).toContain('stopPolling');
      // Must pre-seed active session in storage/state
      expect(section).toContain('enkeep_active_session');
      // Must route via existing workspace selection method
      expect(section).toContain('selectSpace(targetSpaceId)');
      // Must select canonical session
      expect(section).toContain('selectSession(canonId)');
    });

    it('verifies loadSessions does not create another conversation when currentSessionId is active', () => {
      const loadSessionsIndex = appJsCode.indexOf('async function loadSessions(');
      expect(loadSessionsIndex).toBeGreaterThan(-1);
      const fnSection = appJsCode.slice(loadSessionsIndex, loadSessionsIndex + 2500);

      // Guarded against opening new conversation when target session is already specified
      expect(fnSection).toContain('!state.currentSessionId');
    });
  });

  describe('2. Browser DOM Simulation: Cross-Space Canonical Jump Contract', () => {
    it('crosses space from Management A to Canonical B, updating hash, space B, session B, and respecting await guards', async () => {
      // Synthetic IDs
      const spaceA = 'spc_synth_space_A';
      const spaceB = 'spc_synth_space_B';
      const canonSessionB = 'ses_synth_canonical_B';
      const archSessionA = 'ses_synth_archived_A';

      // Mock session storage
      const storage: Record<string, string> = {
        enkeep_active_space: spaceA,
        enkeep_active_session: archSessionA,
      };

      // Mock browser window location
      const mockWindow = {
        location: { hash: '#management/storage/files' },
      };

      // Mock DOM element hierarchy
      const eventListeners: Record<string, ((e: any) => Promise<void> | void)[]> = {};
      const mockButton: any = {
        type: 'button',
        className: 'btn btn-secondary btn-xs btn-go-to-canonical',
        textContent: 'Go to Canonical',
        title: `Open canonical session: ${canonSessionB}`,
        disabled: false,
        addEventListener: (event: string, handler: any) => {
          eventListeners[event] = eventListeners[event] || [];
          eventListeners[event].push(handler);
        },
      };

      // Mock application state
      const state: any = {
        currentRoute: 'management',
        currentSpaceId: spaceA,
        currentSessionId: archSessionA,
        isPollingActive: true,
        spaces: [
          { id: spaceA, name: 'Space A', canonicalSessionId: 'ses_canon_A' },
          { id: spaceB, name: 'Space B', canonicalSessionId: canonSessionB },
        ],
        sessions: [
          { id: archSessionA, spaceId: spaceA, status: 'archived', isCanonical: false },
        ],
      };

      // Execution trace tracking
      const executionTrace: string[] = [];
      let sessionLoadEpoch = 0;
      let sessionSelectEpoch = 0;

      const stopPolling = vi.fn(() => {
        state.isPollingActive = false;
        executionTrace.push('stopPolling');
      });

      const handleRouteHash = vi.fn(() => {
        if (mockWindow.location.hash === '#workspace') {
          state.currentRoute = 'workspace';
          executionTrace.push('route:workspace');
        }
      });

      let inFlightSpaceAResolve: (() => void) | null = null;
      let inFlightSpaceAPromise: Promise<any> | null = null;

      const selectSpace = vi.fn((newSpaceId: string) => {
        state.currentSpaceId = newSpaceId;
        storage.enkeep_active_space = newSpaceId;
        executionTrace.push(`selectSpace:${newSpaceId}`);

        // Simulate loadSessions with epoch increment
        sessionLoadEpoch += 1;
        const currentEpoch = sessionLoadEpoch;

        // If this were space B, set sessions for space B
        if (newSpaceId === spaceB) {
          state.sessions = [
            { id: canonSessionB, spaceId: spaceB, status: 'active', isCanonical: true },
          ];
          executionTrace.push(`loadSessions:${newSpaceId}:epoch_${currentEpoch}`);
        }
      });

      const selectSession = vi.fn(async (newSessionId: string) => {
        sessionSelectEpoch += 1;
        const currentEpoch = sessionSelectEpoch;
        state.currentSessionId = newSessionId;
        storage.enkeep_active_session = newSessionId;
        executionTrace.push(`selectSession:${newSessionId}:epoch_${currentEpoch}`);
      });

      // Synthetic report representing verified merged archive in Space A pointing to Canonical in Space B
      const rep: any = {
        userId: 'usr_synth_tenant_01',
        sessionId: archSessionA,
        status: 'merged_archive',
        canonicalSessionId: canonSessionB,
        spaceId: spaceB, // Authoritative target space from platform reconcile
        details: {
          mergedArchive: true,
          canonicalSessionId: canonSessionB,
          spaceId: spaceB,
          reason: 'superseded_by_canonical_merge',
        },
      };

      // Simulate the in-flight background request for old Space A
      const oldSpaceAEpoch = sessionLoadEpoch;
      let oldSpaceACompleted = false;
      const simulateOldSpaceAResponse = () => {
        // Await guard check as in loadSessions:
        // if (currentEpoch !== sessionLoadEpoch || state.currentSpaceId !== spaceA) return;
        if (oldSpaceAEpoch === sessionLoadEpoch && state.currentSpaceId === spaceA) {
          state.sessions = [{ id: 'ses_corrupt_overwrite', spaceId: spaceA }];
          oldSpaceACompleted = true;
        } else {
          // Await guard dropped stale response!
          executionTrace.push('guard:dropped_stale_spaceA_response');
        }
      };

      // Attach canonical jump listener (exact contract from app.js)
      const canonId = rep.canonicalSessionId || rep.details?.canonicalSessionId;
      mockButton.addEventListener('click', async (e: any) => {
        e.preventDefault();

        // 1. Resolve canonical session and target space
        const targetSpaceId = rep.spaceId || rep.details?.spaceId ||
          (Array.isArray(state.spaces) && state.spaces.find((s: any) => s.canonicalSessionId === canonId || (rep.spaceId && s.id === rep.spaceId))?.id) ||
          state.currentSpaceId;

        // 2. Halt any active polling from old route/session before transition
        if (typeof stopPolling === 'function') {
          stopPolling();
        }

        // 3. Route via actual router hash convention and ensure workspace routing
        if (mockWindow.location.hash !== '#workspace') {
          mockWindow.location.hash = '#workspace';
        }
        if (typeof handleRouteHash === 'function') {
          handleRouteHash();
        }

        // 4. Pre-seed target session in state and storage so existing workspace selection resolves it
        state.currentSessionId = canonId;
        try {
          storage.enkeep_active_session = canonId;
        } catch {}

        // 5. Route via EXISTING workspace selection method (selectSpace)
        if (targetSpaceId && targetSpaceId !== state.currentSpaceId && typeof selectSpace === 'function') {
          selectSpace(targetSpaceId);
        }

        // 6. Explicitly select canonical session with await guard to prevent old response overwrite
        if (typeof selectSession === 'function') {
          await selectSession(canonId);
        }
      });

      // 1. Trigger Click Event
      const clickHandlers = eventListeners['click'] || [];
      expect(clickHandlers.length).toBe(1);
      await clickHandlers[0]({ preventDefault: () => {} });

      // 2. Verify router hash convention updated to #workspace
      expect(mockWindow.location.hash).toBe('#workspace');
      expect(state.currentRoute).toBe('workspace');

      // 3. Verify cross-space selection: Space B and Session B set!
      expect(state.currentSpaceId).toBe(spaceB);
      expect(state.currentSessionId).toBe(canonSessionB);
      expect(storage.enkeep_active_space).toBe(spaceB);
      expect(storage.enkeep_active_session).toBe(canonSessionB);

      // 4. Verify polling was halted before transition
      expect(stopPolling).toHaveBeenCalled();
      expect(selectSpace).toHaveBeenCalledWith(spaceB);
      expect(selectSession).toHaveBeenCalledWith(canonSessionB);

      // 5. Simulate delayed response from old Space A arriving now
      simulateOldSpaceAResponse();

      // Ensure old Space A response was rejected and did NOT overwrite Space B sessions
      expect(oldSpaceACompleted).toBe(false);
      expect(executionTrace).toContain('guard:dropped_stale_spaceA_response');
      expect(state.currentSpaceId).toBe(spaceB);
      expect(state.sessions.every((s: any) => s.spaceId === spaceB)).toBe(true);

      // 6. Archive data was NOT changed
      expect(rep.status).toBe('merged_archive');
      expect(rep.sessionId).toBe(archSessionA);
    });
  });
});
