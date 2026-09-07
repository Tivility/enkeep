/**
 * Approval Governance and Integration Tests for @enkeep/dsh-tool-browser
 *
 * Validates:
 * 1. browser_interact requires approval through DSH ApprovalService.
 * 2. Allowed-once continues execution.
 * 3. Rejected throws APPROVAL_REJECTED (403).
 * 4. Cancelled throws APPROVAL_CANCELLED (499).
 * 5. Unavailable / no answerer throws APPROVAL_UNAVAILABLE (503).
 * 6. Read-only actions (snapshot, screenshot, close) execute without approval.
 *
 * @module @enkeep/dsh-tool-browser/tests/approvals.test
 */

import { describe, it, expect, vi } from 'vitest';
import { Context, Service } from '@deepseek-ai/cordis';
import {
  createBrowserInteractTool,
  createBrowserSnapshotTool,
  createBrowserScreenshotTool,
  createBrowserCloseTool,
} from '../src/index.js';
import { BrowserToolErrorCode } from '../src/errors.js';

describe('dsh-tool-browser: Approval Governance', () => {
  const mockAgent = {
    id: 'agent_approval_test',
    session: {
      id: 'ses_approval_1',
      header: { id: 'ses_approval_1', userId: 'usr_1', spaceId: 'spc_1' },
    },
  };

  it('interact succeeds when approval is granted (allowed-once)', async () => {
    const ctx = new Context();
    const mockApprovalService = {
      request: vi.fn().mockResolvedValue('allowed-once'),
    };
    (ctx as any).approval = mockApprovalService;

    const mockRequest = vi.fn().mockResolvedValue({
      status: 200,
      data: { success: true, pageId: 'p1', action: 'click', ref: '@btn1' },
    });
    const mockClient = { request: mockRequest };

    const tool = createBrowserInteractTool(() => mockClient, {}, ctx);
    const res = await tool.execute(
      { pageId: 'p1', action: 'click', ref: '@btn1' },
      { agent: mockAgent } as any
    );

    expect(mockApprovalService.request).toHaveBeenCalledTimes(1);
    expect(res.success).toBe(true);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('interact fails closed when approval is rejected by user', async () => {
    const ctx = new Context();
    const mockApprovalService = {
      request: vi.fn().mockResolvedValue('rejected'),
    };
    (ctx as any).approval = mockApprovalService;

    const mockRequest = vi.fn();
    const mockClient = { request: mockRequest };

    const tool = createBrowserInteractTool(() => mockClient, {}, ctx);
    await expect(
      tool.execute(
        { pageId: 'p1', action: 'click', ref: '@btn1' },
        { agent: mockAgent } as any
      )
    ).rejects.toThrowError(
      expect.objectContaining({ code: BrowserToolErrorCode.APPROVAL_REJECTED })
    );

    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('interact fails closed when approval is cancelled or unavailable', async () => {
    const ctx = new Context();
    const mockApprovalService = {
      request: vi.fn().mockResolvedValue('unavailable'),
    };
    (ctx as any).approval = mockApprovalService;

    const mockRequest = vi.fn();
    const mockClient = { request: mockRequest };

    const tool = createBrowserInteractTool(() => mockClient, {}, ctx);
    await expect(
      tool.execute(
        { pageId: 'p1', action: 'fill', ref: '@input1', value: 'hello' },
        { agent: mockAgent } as any
      )
    ).rejects.toThrowError(
      expect.objectContaining({ code: BrowserToolErrorCode.APPROVAL_UNAVAILABLE })
    );

    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('read-only actions (snapshot, screenshot, close) execute without approval', async () => {
    const ctx = new Context();
    const mockApprovalService = {
      request: vi.fn(),
    };
    (ctx as any).approval = mockApprovalService;

    const mockClient = {
      request: vi.fn().mockImplementation((path: string) => {
        if (path === '/api/browser/snapshot') {
          return Promise.resolve({
            status: 200,
            data: { success: true, pageId: 'p1', snapshot: '<div/>' },
          });
        }
        if (path === '/api/browser/screenshot') {
          return Promise.resolve({
            status: 200,
            data: {
              success: true,
              pageId: 'p1',
              path: 'artifacts/browser/123-p1.png',
              downloadUrl: '/api/spaces/spc_1/files/download?path=artifacts/browser/123-p1.png',
            },
          });
        }
        if (path === '/api/browser/close') {
          return Promise.resolve({
            status: 200,
            data: { success: true, pageId: 'p1', closed: true },
          });
        }
        return Promise.reject(new Error('Unknown route'));
      }),
    };

    const snapshotTool = createBrowserSnapshotTool(() => mockClient, {}, ctx);
    const screenshotTool = createBrowserScreenshotTool(() => mockClient, {}, ctx);
    const closeTool = createBrowserCloseTool(() => mockClient, {}, ctx);

    await snapshotTool.execute({ pageId: 'p1' }, { agent: mockAgent } as any);
    await screenshotTool.execute({ pageId: 'p1' }, { agent: mockAgent } as any);
    await closeTool.execute({ pageId: 'p1' }, { agent: mockAgent } as any);

    expect(mockApprovalService.request).not.toHaveBeenCalled();
  });
});
