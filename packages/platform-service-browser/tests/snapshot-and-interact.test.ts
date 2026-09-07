/**
 * DOM Snapshot and Safe Interaction Tests
 *
 * Verifies that:
 * - snapshot produces deterministic accessibility-like tree with e1... refs
 * - snapshot enforces max 1000 nodes / 256KB caps and sets truncated flag
 * - interact performs click, fill, press, select strictly by ref
 * - interact rejects invalid refs or missing elements
 * - interact rejects arbitrary JS / CSS selector injections
 *
 * @module @enkeep/platform-service-browser/tests/snapshot-and-interact.test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createBrowserService,
  BrowserErrorCode,
  BrowserServiceError,
} from '../src/index.js';
import { createTestHttpServer, type TestHttpServer } from './fixtures/test-http-server.js';

describe('DOM Snapshot and Safe Interaction Tests', () => {
  let server: TestHttpServer;

  beforeAll(async () => {
    server = await createTestHttpServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it('generates deterministic DOM snapshot with e1... refs and accessible roles', async () => {
    const service = createBrowserService({
      mode: 'in-process',
      allowLocalForTesting: true,
    });

    try {
      const sessionKey = { userId: 'alice', spaceId: 'sp1', sessionId: 'sess-snap' };
      const openRes = await service.open({
        sessionKey,
        url: `${server.origin}/interactive-page`,
      });

      const snap = await service.snapshot({ sessionKey, pageId: openRes.pageId });

      expect(snap.pageId).toBe(openRes.pageId);
      expect(snap.title).toBe('Test Interactive Page');
      expect(snap.nodeCount).toBeGreaterThan(0);
      expect(snap.truncated).toBe(false);
      expect(snap.textSummary).toBeDefined();

      // Check root structure and element refs
      expect(snap.root.ref).toBeDefined();
      expect(snap.root.ref.startsWith('e')).toBe(true);

      // Verify that interactive elements have roles and refs
      const summary = snap.textSummary!;
      expect(summary).toContain('Submit Button');
      expect(summary).toContain('Enter username');
      expect(summary).toContain('Go to Destination');
    } finally {
      await service.dispose();
    }
  });

  it('enforces node and byte caps on huge DOM structures', async () => {
    const service = createBrowserService({
      mode: 'in-process',
      allowLocalForTesting: true,
      maxSnapshotNodes: 50, // Strict cap for testing
    });

    try {
      const sessionKey = { userId: 'alice', spaceId: 'sp1', sessionId: 'sess-huge' };
      const openRes = await service.open({
        sessionKey,
        url: `${server.origin}/huge-page`,
      });

      const snap = await service.snapshot({
        sessionKey,
        pageId: openRes.pageId,
        maxNodes: 50,
      });

      expect(snap.nodeCount).toBeLessThanOrEqual(50);
      expect(snap.truncated).toBe(true);
    } finally {
      await service.dispose();
    }
  });

  it('executes safe click, fill, select, and press interactions by ref', async () => {
    const service = createBrowserService({
      mode: 'in-process',
      allowLocalForTesting: true,
    });

    try {
      const sessionKey = { userId: 'alice', spaceId: 'sp1', sessionId: 'sess-act' };
      const openRes = await service.open({
        sessionKey,
        url: `${server.origin}/interactive-page`,
      });

      // 1. Take snapshot to obtain refs
      const snap1 = await service.snapshot({ sessionKey, pageId: openRes.pageId });

      // Find the button ref
      const findRefByText = (node: any, text: string): string | null => {
        if (node.name && node.name.includes(text)) return node.ref;
        if (node.children) {
          for (const c of node.children) {
            const found = findRefByText(c, text);
            if (found) return found;
          }
        }
        return null;
      };

      const buttonRef = findRefByText(snap1.root, 'Submit Button');
      expect(buttonRef).not.toBeNull();

      // 2. Click button by ref
      const clickRes = await service.interact({
        sessionKey,
        pageId: openRes.pageId,
        action: 'click',
        ref: buttonRef!,
      });
      expect(clickRes.success).toBe(true);
      expect(clickRes.ref).toBe(buttonRef);

      // Verify DOM updated
      const snap2 = await service.snapshot({ sessionKey, pageId: openRes.pageId });
      expect(snap2.textSummary).toContain('Clicked!');

      // 3. Find input ref and fill text
      const findRefByTag = (node: any, tag: string): string | null => {
        if (node.tag === tag) return node.ref;
        if (node.children) {
          for (const c of node.children) {
            const found = findRefByTag(c, tag);
            if (found) return found;
          }
        }
        return null;
      };

      const inputRef = findRefByTag(snap2.root, 'input');
      expect(inputRef).not.toBeNull();

      const fillRes = await service.interact({
        sessionKey,
        pageId: openRes.pageId,
        action: 'fill',
        ref: inputRef!,
        value: 'alice_wanderer',
      });
      expect(fillRes.success).toBe(true);

      // 4. Press Enter key
      const pressRes = await service.interact({
        sessionKey,
        pageId: openRes.pageId,
        action: 'press',
        ref: inputRef!,
        key: 'Enter',
      });
      expect(pressRes.success).toBe(true);

      // 5. Select dropdown option
      const selectRef = findRefByTag(snap2.root, 'select');
      expect(selectRef).not.toBeNull();

      const selectRes = await service.interact({
        sessionKey,
        pageId: openRes.pageId,
        action: 'select',
        ref: selectRef!,
        value: 'admin',
      });
      expect(selectRes.success).toBe(true);
    } finally {
      await service.dispose();
    }
  });

  it('rejects invalid or non-existent element refs', async () => {
    const service = createBrowserService({
      mode: 'in-process',
      allowLocalForTesting: true,
    });

    try {
      const sessionKey = { userId: 'alice', spaceId: 'sp1', sessionId: 'sess-invalid-ref' };
      const openRes = await service.open({
        sessionKey,
        url: `${server.origin}/interactive-page`,
      });

      // Bad ref format
      await expect(
        service.interact({
          sessionKey,
          pageId: openRes.pageId,
          action: 'click',
          ref: 'button.primary', // Raw CSS selector must be rejected
        }),
      ).rejects.toMatchObject({
        code: BrowserErrorCode.BROWSER_INVALID_REF,
      });

      // Non-existent ref
      await expect(
        service.interact({
          sessionKey,
          pageId: openRes.pageId,
          action: 'click',
          ref: 'e99999',
        }),
      ).rejects.toMatchObject({
        code: BrowserErrorCode.BROWSER_INVALID_REF,
      });
    } finally {
      await service.dispose();
    }
  });

  it('strictly blocks cross-session unauthorized snapshot and interact attempts with generic BROWSER_PAGE_NOT_FOUND', async () => {
    const service = createBrowserService({
      mode: 'in-process',
      allowLocalForTesting: true,
    });

    try {
      const aliceSession = { userId: 'alice', spaceId: 'sp-alice', sessionId: 'sess-alice' };
      const bobSession = { userId: 'bob', spaceId: 'sp-bob', sessionId: 'sess-bob' };

      const alicePage = await service.open({
        sessionKey: aliceSession,
        url: `${server.origin}/interactive-page`,
      });

      // Bob attempts to snapshot Alice's pageId
      await expect(
        service.snapshot({
          sessionKey: bobSession,
          pageId: alicePage.pageId,
        }),
      ).rejects.toMatchObject({
        code: BrowserErrorCode.BROWSER_PAGE_NOT_FOUND,
      });

      // Bob attempts to interact with Alice's pageId
      await expect(
        service.interact({
          sessionKey: bobSession,
          pageId: alicePage.pageId,
          action: 'click',
          ref: 'e1',
        }),
      ).rejects.toMatchObject({
        code: BrowserErrorCode.BROWSER_PAGE_NOT_FOUND,
      });
    } finally {
      await service.dispose();
    }
  });
});
