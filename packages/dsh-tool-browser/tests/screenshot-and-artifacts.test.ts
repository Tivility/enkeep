/**
 * Screenshot & Artifact Persistence Tests for @enkeep/dsh-tool-browser
 *
 * Validates:
 * 1. browser_screenshot returns virtual relative artifact path (artifacts/browser/<ts>-<id>.png) and download URL.
 * 2. Never returns raw base64 bytes to the model.
 * 3. Correctly propagates fullPage option to Platform RPC.
 *
 * @module @enkeep/dsh-tool-browser/tests/screenshot-and-artifacts.test
 */

import { describe, it, expect, vi } from 'vitest';
import { createBrowserScreenshotTool } from '../src/index.js';
import { BrowserToolErrorCode } from '../src/errors.js';

describe('dsh-tool-browser: Screenshot Artifacts & Path Return', () => {
  const mockAgent = {
    id: 'agent_screenshot',
    session: {
      id: 'ses_screenshot_1',
      header: { id: 'ses_screenshot_1', userId: 'usr_alice', spaceId: 'spc_demo' },
    },
  };

  it('returns artifact relative path and download URL without raw base64', async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      status: 200,
      data: {
        success: true,
        pageId: 'p_screen_1',
        path: 'artifacts/browser/1725000000000-page1.png',
        downloadUrl: '/api/spaces/spc_demo/files/download?path=artifacts%2Fbrowser%2F1725000000000-page1.png',
        width: 1280,
        height: 800,
        sizeBytes: 154200,
      },
    });

    const mockClient = { request: mockRequest };
    const tool = createBrowserScreenshotTool(() => mockClient);

    const res = await tool.execute(
      { pageId: 'p_screen_1', fullPage: true },
      { agent: mockAgent } as any
    );

    expect(res.success).toBe(true);
    expect(res.pageId).toBe('p_screen_1');
    expect(res.path).toBe('artifacts/browser/1725000000000-page1.png');
    expect(res.downloadUrl).toBe(
      '/api/spaces/spc_demo/files/download?path=artifacts%2Fbrowser%2F1725000000000-page1.png'
    );
    expect(res.width).toBe(1280);
    expect(res.height).toBe(800);
    expect((res as any).base64).toBeUndefined();
    expect((res as any).data).toBeUndefined();

    // Verify RPC payload
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockRequest.mock.calls[0][0]).toBe('/api/browser/screenshot');
    expect(mockRequest.mock.calls[0][1].body).toEqual({
      pageId: 'p_screen_1',
      fullPage: true,
      userId: 'usr_alice',
      spaceId: 'spc_demo',
      sessionId: 'ses_screenshot_1',
    });
  });

  it('fails if platform response is missing artifact path', async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      status: 200,
      data: {
        success: true,
        pageId: 'p_screen_1',
        // missing path!
      },
    });

    const mockClient = { request: mockRequest };
    const tool = createBrowserScreenshotTool(() => mockClient);

    await expect(
      tool.execute({ pageId: 'p_screen_1' }, { agent: mockAgent } as any)
    ).rejects.toThrowError(
      expect.objectContaining({ code: BrowserToolErrorCode.INVALID_BROWSER_RESPONSE })
    );
  });
});
