/**
 * Interaction Validation Tests for @enkeep/dsh-tool-browser
 *
 * Validates:
 * 1. browser_interact action validation (click, fill, press, select).
 * 2. Mandatory value parameter for fill and select actions.
 * 3. Element reference validation and rejection of empty/malformed refs.
 *
 * @module @enkeep/dsh-tool-browser/tests/interaction-validation.test
 */

import { describe, it, expect, vi } from 'vitest';
import { createBrowserInteractTool } from '../src/index.js';
import { BrowserToolErrorCode } from '../src/errors.js';

describe('dsh-tool-browser: Interaction Validation', () => {
  const mockAgent = {
    id: 'agent_test',
    session: {
      id: 'ses_test_1',
      header: { id: 'ses_test_1', userId: 'usr_1', spaceId: 'spc_1' },
    },
  };

  it('requires value property when action is "fill"', async () => {
    const mockClient = { request: vi.fn() };
    const tool = createBrowserInteractTool(() => mockClient);

    await expect(
      tool.execute(
        { pageId: 'p1', action: 'fill', ref: '@e1' } as any,
        { agent: mockAgent } as any
      )
    ).rejects.toThrowError(
      expect.objectContaining({ code: BrowserToolErrorCode.INVALID_ARGUMENT })
    );
  });

  it('requires value property when action is "select"', async () => {
    const mockClient = { request: vi.fn() };
    const tool = createBrowserInteractTool(() => mockClient);

    await expect(
      tool.execute(
        { pageId: 'p1', action: 'select', ref: '@e2', value: undefined } as any,
        { agent: mockAgent } as any
      )
    ).rejects.toThrowError(
      expect.objectContaining({ code: BrowserToolErrorCode.INVALID_ARGUMENT })
    );
  });

  it('allows click and press without value', async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      status: 200,
      data: { success: true, pageId: 'p1', action: 'click', ref: '@e3' },
    });
    const mockClient = { request: mockRequest };
    const tool = createBrowserInteractTool(() => mockClient);

    const res = await tool.execute(
      { pageId: 'p1', action: 'click', ref: '@e3' },
      { agent: mockAgent } as any
    );
    expect(res.success).toBe(true);
    expect(res.action).toBe('click');
    expect(res.ref).toBe('@e3');
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid action names', async () => {
    const mockClient = { request: vi.fn() };
    const tool = createBrowserInteractTool(() => mockClient);

    await expect(
      tool.execute(
        { pageId: 'p1', action: 'hover' as any, ref: '@e1' },
        { agent: mockAgent } as any
      )
    ).rejects.toThrowError(
      expect.objectContaining({ code: BrowserToolErrorCode.INVALID_ARGUMENT })
    );
  });

  it('rejects empty ref or empty pageId', async () => {
    const mockClient = { request: vi.fn() };
    const tool = createBrowserInteractTool(() => mockClient);

    await expect(
      tool.execute(
        { pageId: '', action: 'click', ref: '@e1' },
        { agent: mockAgent } as any
      )
    ).rejects.toThrowError(
      expect.objectContaining({ code: BrowserToolErrorCode.INVALID_ARGUMENT })
    );

    await expect(
      tool.execute(
        { pageId: 'p1', action: 'click', ref: '   ' },
        { agent: mockAgent } as any
      )
    ).rejects.toThrowError(
      expect.objectContaining({ code: BrowserToolErrorCode.INVALID_ARGUMENT })
    );
  });
});
