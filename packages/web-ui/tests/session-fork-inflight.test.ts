/**
 * Unit Tests for In-Flight Form Submit Guards (Fork Session & Create Session)
 *
 * Verifies that double-submitting the fork session form or create session form
 * (e.g. double click or rapid Enter) does not trigger duplicate API requests.
 */

import { describe, it, expect, vi } from 'vitest';
import { getWebUiAsset } from '../src/index.js';

describe('Form Double-Submit Guards', () => {
  const jsAsset = getWebUiAsset('app.js');
  const jsCode = jsAsset.content.toString('utf-8');

  it('declares forkSubmitInFlight and createSessionSubmitInFlight module flags', () => {
    expect(jsCode).toContain('let forkSubmitInFlight = false;');
    expect(jsCode).toContain('let createSessionSubmitInFlight = false;');
  });

  it('dispatches two fork submit events synchronously and calls apiRequest for /fork exactly once', async () => {
    // Extract handleForkSession and its in-flight flag
    const forkMatch = jsCode.match(/let forkSubmitInFlight = false;[\s\S]*?async function handleForkSession\(e\) \{[\s\S]*?\n\}/);
    expect(forkMatch).not.toBeNull();

    let forkResolve: (val: any) => void;
    const pendingForkPromise = new Promise((resolve) => {
      forkResolve = resolve;
    });

    const apiRequestMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/fork')) {
        return pendingForkPromise;
      }
      return Promise.resolve({ data: {} });
    });

    const mockSubmitBtn = {
      disabled: false,
    };

    const mockForm = {
      querySelector: vi.fn((sel: string) => {
        if (sel === 'button[type="submit"]') return mockSubmitBtn;
        return null;
      }),
    };

    const mockDoc = {
      getElementById: vi.fn((id: string) => {
        if (id === 'fork-session-title-input') return { value: 'Branch title' };
        if (id === 'fork-space-select') return { value: 'spc_target' };
        if (id === 'fork-source-message-id') return { value: 'msg_123' };
        if (id === 'fork-source-turn-id') return { value: 'turn_456' };
        if (id === 'btn-submit-fork-session') return mockSubmitBtn;
        return null;
      }),
    };

    const state = {
      currentSessionId: 'ses_origin_1',
      currentSpaceId: 'spc_origin',
    };

    const runner = new Function(
      'document',
      'state',
      'apiRequest',
      'showToast',
      'tr',
      'closeModal',
      'selectSpace',
      'loadSessions',
      'selectSession',
      'getSafeErrorMessage',
      `
      ${forkMatch![0]}
      return handleForkSession;
    `
    )(
      mockDoc,
      state,
      apiRequestMock,
      vi.fn(),
      (k: string, p: any, fb: string) => fb,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      (err: any, fb: string) => fb
    );

    const event1 = {
      preventDefault: vi.fn(),
      target: mockForm,
    };
    const event2 = {
      preventDefault: vi.fn(),
      target: mockForm,
    };

    // Dispatch two submit events synchronously
    const call1 = runner(event1);
    const call2 = runner(event2);

    expect(mockSubmitBtn.disabled).toBe(true);

    // Complete the first fork call
    forkResolve!({ data: { id: 'ses_forked_new' } });

    await Promise.all([call1, call2]);

    // Assert apiRequest for /fork was called exactly once
    const forkCalls = apiRequestMock.mock.calls.filter((args) => typeof args[0] === 'string' && args[0].includes('/fork'));
    expect(forkCalls).toHaveLength(1);
    expect(mockSubmitBtn.disabled).toBe(false);
  });

  it('dispatches two create-session submit events synchronously and calls apiRequest for /api/sessions exactly once', async () => {
    const createMatch = jsCode.match(/let createSessionSubmitInFlight = false;[\s\S]*?async function handleCreateSession\(e\) \{[\s\S]*?\n\}/);
    expect(createMatch).not.toBeNull();

    let createResolve: (val: any) => void;
    const pendingCreatePromise = new Promise((resolve) => {
      createResolve = resolve;
    });

    const apiRequestMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/sessions') {
        return pendingCreatePromise;
      }
      return Promise.resolve({ data: {} });
    });

    const mockSubmitBtn = {
      disabled: false,
    };

    const mockForm = {
      querySelector: vi.fn((sel: string) => {
        if (sel === 'button[type="submit"]') return mockSubmitBtn;
        return null;
      }),
      reset: vi.fn(),
    };

    const mockDoc = {
      getElementById: vi.fn((id: string) => {
        if (id === 'session-space-select') return { value: 'spc_default' };
        if (id === 'session-title-input') return { value: 'My New Session' };
        if (id === 'create-session-form') return mockForm;
        return null;
      }),
    };

    const state = {
      currentSpaceId: 'spc_default',
      spaces: [{ id: 'spc_default', executionMode: 'container' }],
    };

    const runner = new Function(
      'document',
      'state',
      'apiRequest',
      'showToast',
      'tr',
      'closeModal',
      'renderSpaceSelect',
      'loadSessions',
      'selectSession',
      'showSafeError',
      `
      ${createMatch![0]}
      return handleCreateSession;
    `
    )(
      mockDoc,
      state,
      apiRequestMock,
      vi.fn(),
      (k: string, p: any, fb: string) => fb,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn()
    );

    const event1 = {
      preventDefault: vi.fn(),
      target: mockForm,
    };
    const event2 = {
      preventDefault: vi.fn(),
      target: mockForm,
    };

    // Dispatch two submit events synchronously
    const call1 = runner(event1);
    const call2 = runner(event2);

    expect(mockSubmitBtn.disabled).toBe(true);

    // Complete the first call
    createResolve!({ data: { id: 'ses_created_1', title: 'My New Session' } });

    await Promise.all([call1, call2]);

    // Assert apiRequest for /api/sessions was called exactly once
    const sessionCalls = apiRequestMock.mock.calls.filter((args) => args[0] === '/api/sessions');
    expect(sessionCalls).toHaveLength(1);
    expect(mockSubmitBtn.disabled).toBe(false);
  });
});
