/**
 * Error Handling, Limits, and Cancellation Tests for @enkeep/dsh-tool-browser
 *
 * Validates:
 * 1. Missing platformClient throws BROWSER_TOOL_UNAVAILABLE (503).
 * 2. Invalid platform HTTP responses throw INVALID_BROWSER_RESPONSE (502).
 * 3. browser_close requires exact non-empty pageId.
 * 4. AbortSignal cancellation propagation.
 *
 * @module @enkeep/dsh-tool-browser/tests/error-and-limits.test
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createBrowserOpenTool,
  createBrowserSnapshotTool,
  createBrowserInteractTool,
  createBrowserScreenshotTool,
  createBrowserCloseTool,
} from '../src/index.js';
import { BrowserToolErrorCode } from '../src/errors.js';

describe('dsh-tool-browser: Errors, Limits & Cancellation', () => {
  const mockAgent = {
    id: 'agent_err_test',
    session: {
      id: 'ses_err_1',
      header: { id: 'ses_err_1', userId: 'usr_1', spaceId: 'spc_1' },
    },
  };

  it('throws BROWSER_TOOL_UNAVAILABLE when platformClient is missing', async () => {
    const openTool = createBrowserOpenTool(() => undefined);
    const snapshotTool = createBrowserSnapshotTool(() => undefined);
    const interactTool = createBrowserInteractTool(() => undefined);
    const screenshotTool = createBrowserScreenshotTool(() => undefined);
    const closeTool = createBrowserCloseTool(() => undefined);

    const execCtx = { agent: mockAgent } as any;

    await expect(openTool.execute({ url: 'https://example.com' }, execCtx)).rejects.toThrowError(
      expect.objectContaining({ code: BrowserToolErrorCode.BROWSER_TOOL_UNAVAILABLE })
    );

    await expect(snapshotTool.execute({ pageId: 'p1' }, execCtx)).rejects.toThrowError(
      expect.objectContaining({ code: BrowserToolErrorCode.BROWSER_TOOL_UNAVAILABLE })
    );

    await expect(
      interactTool.execute({ pageId: 'p1', action: 'click', ref: '@e1' }, execCtx)
    ).rejects.toThrowError(
      expect.objectContaining({ code: BrowserToolErrorCode.BROWSER_TOOL_UNAVAILABLE })
    );

    await expect(screenshotTool.execute({ pageId: 'p1' }, execCtx)).rejects.toThrowError(
      expect.objectContaining({ code: BrowserToolErrorCode.BROWSER_TOOL_UNAVAILABLE })
    );

    await expect(closeTool.execute({ pageId: 'p1' }, execCtx)).rejects.toThrowError(
      expect.objectContaining({ code: BrowserToolErrorCode.BROWSER_TOOL_UNAVAILABLE })
    );
  });

  it('throws INVALID_BROWSER_RESPONSE when platform returns invalid structure', async () => {
    const mockClient = {
      request: vi.fn().mockResolvedValue({ status: 500, data: null }),
    };

    const openTool = createBrowserOpenTool(() => mockClient);
    await expect(
      openTool.execute({ url: 'https://example.com' }, { agent: mockAgent } as any)
    ).rejects.toThrowError(
      expect.objectContaining({ code: BrowserToolErrorCode.INVALID_BROWSER_RESPONSE })
    );
  });

  it('browser_close requires exact non-empty pageId string', async () => {
    const mockClient = { request: vi.fn() };
    const closeTool = createBrowserCloseTool(() => mockClient);

    await expect(
      closeTool.execute({ pageId: '' }, { agent: mockAgent } as any)
    ).rejects.toThrowError(
      expect.objectContaining({ code: BrowserToolErrorCode.INVALID_ARGUMENT })
    );

    await expect(
      closeTool.execute({ pageId: '   ' }, { agent: mockAgent } as any)
    ).rejects.toThrowError(
      expect.objectContaining({ code: BrowserToolErrorCode.INVALID_ARGUMENT })
    );

    await expect(
      closeTool.execute(null as any, { agent: mockAgent } as any)
    ).rejects.toThrowError(
      expect.objectContaining({ code: BrowserToolErrorCode.INVALID_ARGUMENT })
    );
  });

  it('passes AbortSignal to platform request options', async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      status: 200,
      data: { success: true, pageId: 'p1', closed: true },
    });
    const mockClient = { request: mockRequest };
    const closeTool = createBrowserCloseTool(() => mockClient);

    const controller = new AbortController();
    await closeTool.execute(
      { pageId: 'p1' },
      { agent: mockAgent, signal: controller.signal } as any
    );

    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockRequest.mock.calls[0][1].signal).toBe(controller.signal);
  });
});
