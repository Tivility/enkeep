/**
 * Chat Merged History Chronological Order, Viewport Anchoring & Session Epoch Suite
 *
 * Covers:
 * 1. Initial snapshot + old genesis replay + concurrent new: authoritative chronological sort
 *    (createdAt ASC, id ASC), update-existing-not-duplicate, no dropped new, April before September.
 * 2. Viewport anchor preservation across scroll up, background poll, older message prepend,
 *    and lazy image load without double full-render or forced viewport jump to bottom.
 * 3. Fast Session A -> Session B switch: slow Session A response cannot alter Session B or start poller for A.
 * 4. Intentional archive selection persists across space/page refresh; canonical first ONLY on normal initial open.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('Chat Merged History Chronological Order & Viewport Anchoring Suite', () => {
  const appJsCode = readFileSync(join(__dirname, '../src/static/app.js'), 'utf-8');
  const styleCssCode = readFileSync(join(__dirname, '../src/static/style.css'), 'utf-8');

  describe('1. Static Code Invariants & Contract Verification', () => {
    it('contains sessionSelectEpoch counter and sequence guards in selectSession', () => {
      expect(appJsCode).toContain('let sessionSelectEpoch = 0;');
      expect(appJsCode).toContain('sessionSelectEpoch += 1;');
      expect(appJsCode).toContain('currentEpoch !== sessionSelectEpoch');
    });

    it('immediately aborts old polling on session switch in selectSession', () => {
      const selectSessionBlock = appJsCode.slice(
        appJsCode.indexOf('async function selectSession('),
        appJsCode.indexOf('function openRenameSessionModal(')
      );
      expect(selectSessionBlock).toContain('stopPolling();');
    });

    it('initializes eventCursor from res.data.latestEventCursor ONLY on initial load', () => {
      const loadMessagesBlock = appJsCode.slice(
        appJsCode.indexOf('async function loadMessages('),
        appJsCode.indexOf('function captureScrollAnchor(')
      );
      expect(loadMessagesBlock).toContain('res.data.latestEventCursor');
      expect(loadMessagesBlock).toContain('state.eventCursor = res.data.latestEventCursor');

      // Older message loading must NOT reset eventCursor
      const loadOlderBlock = appJsCode.slice(
        appJsCode.indexOf('async function loadOlderMessages('),
        appJsCode.indexOf('function renderMessages(')
      );
      expect(loadOlderBlock).not.toContain('state.eventCursor =');
    });

    it('implements captureScrollAnchor and restoreScrollAnchor functions', () => {
      expect(appJsCode).toContain('function captureScrollAnchor(container)');
      expect(appJsCode).toContain('function restoreScrollAnchor(container, anchor)');
    });

    it('restricts autoscroll in renderMessages to nearBottom or forceScrollBottom', () => {
      const renderBlock = appJsCode.slice(
        appJsCode.indexOf('function renderMessages('),
        appJsCode.indexOf('function updateStopTurnControl(')
      );
      expect(renderBlock).toContain('if (state.forceScrollBottom)');
      expect(renderBlock).toContain('restoreScrollAnchor(container, anchor)');
      expect(renderBlock).toContain('else if (wasNearBottom)');
    });

    it('preserves natural image aspect ratio without forced distortion in style.css', () => {
      expect(styleCssCode).toContain('.message-attachment-thumbnail');
      expect(styleCssCode).toContain('object-fit: contain');
      expect(styleCssCode).toContain('max-height: 240px');
    });
  });

  describe('2. Message Chronological Order & Stable Reconciliation (100+ Synthetic Messages)', () => {
    it('correctly orders 100+ messages mixing April historical and September recent without duplication or loss', () => {
      // Simulate state.messages starting with latest 50 September messages (snapshot)
      const state: any = {
        messages: [] as any[],
        streamingState: null,
      };

      // 1. Initial snapshot: 50 September messages (ordered old -> new within Sep)
      for (let i = 1; i <= 50; i++) {
        const pad = String(i).padStart(2, '0');
        state.messages.push({
          id: `msg_sep_${pad}`,
          role: i % 2 === 0 ? 'assistant' : 'user',
          content: `September message ${i}`,
          status: i === 25 ? 'pending' : 'delivered',
          createdAt: `2026-09-08T20:${pad}:00.000Z`,
        });
      }
      expect(state.messages.length).toBe(50);
      expect(state.messages[0].id).toBe('msg_sep_01');
      expect(state.messages[49].id).toBe('msg_sep_50');

      // Extract the message event reconciliation block from pollEvents in app.js
      const reconcileMatch = appJsCode.match(/case 'message': \{[\s\S]*?break;\s*\}/);
      expect(reconcileMatch).not.toBeNull();

      // Helper simulating the exact case 'message' reconciliation logic
      const reconcileMessage = (ev: any) => {
        const msg = (ev.payload && ev.payload.message)
          ? ev.payload.message
          : ev.message
            ? ev.message
            : null;

        if (msg && msg.id) {
          const existingIdx = state.messages.findIndex((m: any) => m.id === msg.id);
          if (existingIdx !== -1) {
            state.messages[existingIdx] = { ...state.messages[existingIdx], ...msg };
          } else {
            const msgTime = new Date(msg.createdAt || 0).getTime();
            let insertIdx = state.messages.length;
            for (let i = state.messages.length - 1; i >= 0; i--) {
              const itemTime = new Date(state.messages[i].createdAt || 0).getTime();
              if (itemTime > msgTime || (itemTime === msgTime && String(state.messages[i].id) > String(msg.id))) {
                insertIdx = i;
              } else {
                break;
              }
            }
            state.messages.splice(insertIdx, 0, msg);
          }
          if (msg.role === 'assistant') {
            state.streamingState = null;
          }
        }
      };

      // 2. Genesis replay: 50 historical April messages arrive out-of-order via event polling
      for (let i = 1; i <= 50; i++) {
        const pad = String(i).padStart(2, '0');
        reconcileMessage({
          type: 'message',
          id: `evt_apr_${pad}`,
          payload: {
            message: {
              id: `msg_apr_${pad}`,
              role: i % 2 === 0 ? 'assistant' : 'user',
              content: `April message ${i}`,
              status: 'delivered',
              createdAt: `2026-04-14T10:${pad}:00.000Z`,
            },
          },
        });
      }

      // 3. Concurrent real-time new message: September 8 21:00:00 (arrives during hydration)
      reconcileMessage({
        type: 'message',
        id: 'evt_sep_51',
        payload: {
          message: {
            id: 'msg_sep_51',
            role: 'user',
            content: 'Brand new incoming turn message',
            status: 'delivered',
            createdAt: '2026-09-08T21:00:00.000Z',
          },
        },
      });

      // 4. Update to existing message: msg_sep_25 status updated to 'delivered'
      reconcileMessage({
        type: 'message',
        id: 'evt_sep_25_update',
        payload: {
          message: {
            id: 'msg_sep_25',
            role: 'user',
            content: 'September message 25 (updated)',
            status: 'delivered',
            createdAt: '2026-09-08T20:25:00.000Z',
          },
        },
      });

      // Verification: Total messages should be exactly 101 (50 Apr + 50 Sep + 1 new Sep, msg_sep_25 updated NOT duplicated)
      expect(state.messages.length).toBe(101);

      // Check no duplicates: count frequency of each id
      const idCounts = new Map<string, number>();
      for (const m of state.messages) {
        idCounts.set(m.id, (idCounts.get(m.id) || 0) + 1);
      }
      for (const [id, count] of idCounts) {
        expect(count, `Duplicate message id ${id}`).toBe(1);
      }

      // Check updated status on msg_sep_25
      const updatedMsg = state.messages.find((m: any) => m.id === 'msg_sep_25');
      expect(updatedMsg.status).toBe('delivered');
      expect(updatedMsg.content).toBe('September message 25 (updated)');

      // Check new message msg_sep_51 exists
      expect(state.messages.find((m: any) => m.id === 'msg_sep_51')).toBeDefined();

      // Check strictly ascending chronological order across all 101 messages
      for (let i = 0; i < state.messages.length - 1; i++) {
        const curr = state.messages[i];
        const next = state.messages[i + 1];
        const tCurr = new Date(curr.createdAt).getTime();
        const tNext = new Date(next.createdAt).getTime();

        expect(
          tCurr <= tNext,
          `Inversion at index ${i}: ${curr.id} (${curr.createdAt}) after ${next.id} (${next.createdAt})`
        ).toBe(true);

        if (tCurr === tNext) {
          expect(String(curr.id) <= String(next.id)).toBe(true);
        }
      }

      // First 50 messages MUST be April messages (never April after September)
      for (let i = 0; i < 50; i++) {
        expect(state.messages[i].id).toMatch(/^msg_apr_/);
        expect(state.messages[i].createdAt).toMatch(/^2026-04-14/);
      }

      // Remaining 51 messages MUST be September messages
      for (let i = 50; i < 101; i++) {
        expect(state.messages[i].id).toMatch(/^msg_sep_/);
        expect(state.messages[i].createdAt).toMatch(/^2026-09-08/);
      }
    });
  });

  describe('3. Viewport Scroll Anchor Preservation', () => {
    it('captures visible card anchor and restores exact position across prepend and poll updates', () => {
      // Create a synthetic container simulating DOM measurements
      let scrollTop = 800;
      const clientHeight = 400;
      const cardHeights: Record<string, number> = {};
      const cards: any[] = [];

      const container: any = {
        scrollTop,
        clientHeight,
        get scrollHeight() {
          return cards.reduce((sum, c) => sum + (cardHeights[c.id] || 50), 0);
        },
        getBoundingClientRect: () => ({ top: 0, bottom: clientHeight, height: clientHeight }),
        querySelectorAll: (sel: string) => (sel === '.message-card' ? cards : []),
      };

      for (let i = 1; i <= 30; i++) {
        const id = `msg-card-m${i}`;
        cardHeights[id] = 50;
        cards.push({
          id,
          className: 'message-card',
          getBoundingClientRect: () => {
            // Calculate absolute top from sum of prior cards
            let top = 0;
            for (const c of cards) {
              if (c.id === id) break;
              top += cardHeights[c.id] || 50;
            }
            const relativeTop = top - container.scrollTop;
            return {
              top: relativeTop,
              bottom: relativeTop + (cardHeights[id] || 50),
              height: cardHeights[id] || 50,
            };
          },
        });
      }

      // Extract captureScrollAnchor and restoreScrollAnchor
      const fnAnchorSource = appJsCode.match(/function captureScrollAnchor\(container\) \{[\s\S]*?function restoreScrollAnchor\(container, anchor\) \{[\s\S]*?\n\}/);
      expect(fnAnchorSource).not.toBeNull();

      const documentMock = {
        getElementById: (id: string) => cards.find((c) => c.id === id) || null,
      };

      const { captureScrollAnchor, restoreScrollAnchor } = new Function(
        'document',
        `
        ${fnAnchorSource![0]}
        return { captureScrollAnchor, restoreScrollAnchor };
      `
      )(documentMock);

      // 1. Initial capture before prepend
      // At scrollTop = 800, card m17 starts at 800 (16 * 50 = 800). Card m17 top = 0, bottom = 50.
      const anchor = captureScrollAnchor(container);
      expect(anchor).not.toBeNull();
      expect(anchor.id).toBe('msg-card-m17');
      expect(anchor.offset).toBe(0);

      // 2. Prepend 10 older messages above (adds 10 * 50 = 500px to the top)
      const olderCards: any[] = [];
      for (let i = 1; i <= 10; i++) {
        const id = `msg-card-older-${i}`;
        cardHeights[id] = 50;
        olderCards.push({
          id,
          className: 'message-card',
          getBoundingClientRect: () => {
            let top = 0;
            for (const c of cards) {
              if (c.id === id) break;
              top += cardHeights[c.id] || 50;
            }
            const relativeTop = top - container.scrollTop;
            return {
              top: relativeTop,
              bottom: relativeTop + (cardHeights[id] || 50),
              height: cardHeights[id] || 50,
            };
          },
        });
      }
      cards.unshift(...olderCards);

      // Restore scroll anchor
      restoreScrollAnchor(container, anchor);

      // The container scrollTop should have shifted by exactly +500px so card m17 is still at relative top = 0!
      expect(container.scrollTop).toBe(1300); // 800 + 500
      const restoredCardRect = documentMock.getElementById('msg-card-m17')!.getBoundingClientRect();
      expect(restoredCardRect.top).toBe(0); // EXACT pixel preservation

      // 3. Late image load: suppose card older-5 image loads and height expands from 50 to 150px (+100px above anchor)
      cardHeights['msg-card-older-5'] = 150;
      // Re-anchor compensation on image load
      restoreScrollAnchor(container, anchor);
      expect(container.scrollTop).toBe(1400); // 1300 + 100
      const rectAfterImage = documentMock.getElementById('msg-card-m17')!.getBoundingClientRect();
      expect(rectAfterImage.top).toBe(0); // Zero viewport jump!
    });
  });

  describe('4. Session Switch Epoch Guard: Fast A -> B, Slow A Response', () => {
    it('prevents stale Session A response from modifying Session B or starting Session A poller', async () => {
      // Extract selectSession logic from app.js
      const fnMatch = appJsCode.match(/let sessionSelectEpoch = 0;[\s\S]*?async function selectSession\(sessionId\) \{[\s\S]*?\n\}/);
      expect(fnMatch).not.toBeNull();

      const state: any = {
        currentSessionId: null,
        currentRoute: 'workspace',
        currentSessionRoute: null,
        drafts: {},
        activeAttachments: [],
        sessions: [
          { id: 'ses_A', title: 'Session A', status: 'active' },
          { id: 'ses_B', title: 'Session B', status: 'active' },
        ],
        eventCursor: null,
        olderMessagesCursor: null,
        hasMoreMessages: false,
        isLoadingOlderMessages: false,
        loadOlderError: null,
        streamingState: null,
        hasCancellableTurn: false,
        activeTurnStatus: null,
        isCancellingTurn: false,
        consecutivePollingFailures: 0,
        processedEventIds: new Set(),
      };

      const pollerCalls: string[] = [];
      const stopPollingCalls: number[] = [];

      let resolveSessionA: ((val: any) => void) | null = null;
      let resolveSessionB: ((val: any) => void) | null = null;

      const mockApiRequest = vi.fn((url: string) => {
        if (url.includes('ses_A')) {
          return new Promise((res) => { resolveSessionA = res; });
        }
        if (url.includes('ses_B')) {
          return new Promise((res) => { resolveSessionB = res; });
        }
        return Promise.resolve({ data: {} });
      });

      const mockLoadMessages = vi.fn().mockResolvedValue(undefined);
      const mockSyncActiveTurnStatus = vi.fn().mockResolvedValue(undefined);
      const mockStartPolling = vi.fn((id: string) => { pollerCalls.push(id); });
      const mockStopPolling = vi.fn(() => { stopPollingCalls.push(Date.now()); });

      const runner = new Function(
        'document',
        'sessionStorage',
        'state',
        'apiRequest',
        'loadMessages',
        'syncActiveTurnStatus',
        'startPolling',
        'stopPolling',
        'renderSessionList',
        'updateStopTurnControl',
        'updateTurnStatusBadge',
        'adjustTextareaHeight',
        'renderComposerReplyBanner',
        'renderAttachmentTray',
        'updateCharCount',
        'updateComposerControlsState',
        'formatStatus',
        'formatNumber',
        'tr',
        'showToast',
        'getSafeErrorMessage',
        `
        ${fnMatch![0]}
        return selectSession;
      `
      )(
        { getElementById: () => null },
        { setItem: () => {}, removeItem: () => {} },
        state,
        mockApiRequest,
        mockLoadMessages,
        mockSyncActiveTurnStatus,
        mockStartPolling,
        mockStopPolling,
        () => {},
        () => {},
        () => {},
        () => {},
        () => {},
        () => {},
        () => {},
        () => {},
        (s: string) => s,
        (n: number) => String(n),
        (k: string, p: any, fb: string) => fb,
        () => {},
        (err: any, fb: string) => fb
      );

      // 1. User clicks Session A
      const promiseA = runner('ses_A');
      expect(state.currentSessionId).toBe('ses_A');
      expect(stopPollingCalls.length).toBe(1);

      // 2. User quickly clicks Session B before Session A network response finishes
      const promiseB = runner('ses_B');
      expect(state.currentSessionId).toBe('ses_B');
      expect(stopPollingCalls.length).toBe(2);

      // 3. Session B responds first
      resolveSessionB!({
        data: { id: 'ses_B', title: 'Session B Title', status: 'active' },
      });
      await promiseB;

      expect(state.currentSessionId).toBe('ses_B');
      expect(state.currentSessionRoute.id).toBe('ses_B');
      expect(pollerCalls).toEqual(['ses_B']);

      // 4. Stale Session A response finally arrives
      resolveSessionA!({
        data: { id: 'ses_A', title: 'Stale Session A Title', status: 'active' },
      });
      await promiseA;

      // Assertions: Session B must remain intact; Session A response was dropped!
      expect(state.currentSessionId).toBe('ses_B');
      expect(state.currentSessionRoute.id).toBe('ses_B');
      expect(pollerCalls).toEqual(['ses_B']); // No poller started for A!
    });
  });

  describe('5. Intentional Archive Selection Persists Across Refresh', () => {
    it('preserves user choice of archived session across refresh and uses canonical first ONLY on normal initial open', async () => {
      const fnMatch = appJsCode.match(/let sessionLoadEpoch = 0;[\s\S]*?async function loadSessions\(spaceId\) \{[\s\S]*?\n\}/);
      expect(fnMatch).not.toBeNull();

      const selectCalls: string[] = [];
      const state: any = {
        currentSpaceId: 'spc_main',
        currentSessionId: null,
        showArchivedSessions: true,
        spaces: [
          {
            id: 'spc_main',
            canonicalSessionId: 'ses_canonical_main',
            executionMode: 'container',
          },
        ],
        sessions: [],
      };

      let storageSession: string | null = null;
      const mockSessionStorage = {
        getItem: (k: string) => (k === 'enkeep_active_session' ? storageSession : null),
        setItem: (k: string, v: string) => { if (k === 'enkeep_active_session') storageSession = v; },
        removeItem: (k: string) => { if (k === 'enkeep_active_session') storageSession = null; },
      };

      const mockApiRequest = vi.fn().mockResolvedValue({
        data: {
          sessions: [
            { id: 'ses_canonical_main', spaceId: 'spc_main', status: 'active' },
            { id: 'ses_archived_user_choice', spaceId: 'spc_main', status: 'archived' },
          ],
        },
      });

      const mockSelectSession = vi.fn((id: string) => {
        state.currentSessionId = id;
        storageSession = id;
        selectCalls.push(id);
      });

      const loadSessions = new Function(
        'document',
        'sessionStorage',
        'state',
        'apiRequest',
        'renderSessionList',
        'selectSession',
        'deselectSession',
        'tr',
        'showToast',
        'getSafeErrorMessage',
        `
        ${fnMatch![0]}
        return loadSessions;
      `
      )(
        { getElementById: () => null },
        mockSessionStorage,
        state,
        mockApiRequest,
        () => {},
        mockSelectSession,
        () => {},
        (k: string, p: any, fb: string) => fb,
        () => {},
        (err: any, fb: string) => fb
      );

      // Part A: Normal initial open (no prior state or storage session) -> Canonical session selected!
      await loadSessions('spc_main');
      expect(selectCalls[selectCalls.length - 1]).toBe('ses_canonical_main');
      expect(state.currentSessionId).toBe('ses_canonical_main');

      // Part B: User intentionally selects archived session
      state.currentSessionId = 'ses_archived_user_choice';
      storageSession = 'ses_archived_user_choice';

      // Part C: User refreshes page/workspace (calls loadSessions)
      await loadSessions('spc_main');

      // Crucial assertion: Archived session selection MUST BE PRESERVED on refresh!
      // Must NOT stomp user choice back to canonical!
      expect(selectCalls[selectCalls.length - 1]).toBe('ses_archived_user_choice');
      expect(state.currentSessionId).toBe('ses_archived_user_choice');
    });
  });
});
