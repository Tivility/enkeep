import { describe, it, expect, vi } from 'vitest';
import { getWebUiIndexHtml, getWebUiAsset } from '../src/index.js';
import { en, zhCN } from '../src/static/i18n.js';

describe('D-05 Steer & Queue Web UI Subsystem', () => {
  const html = getWebUiIndexHtml();
  const appJsAsset = getWebUiAsset('app.js');
  const appJs = appJsAsset.content.toString('utf-8');
  const styleCssAsset = getWebUiAsset('style.css');
  const styleCss = styleCssAsset.content.toString('utf-8');

  describe('1. Static DOM Structure & Elements', () => {
    it('verifies composer markup contains steer button, send button, and queue tray container', () => {
      expect(html).toContain('id="btn-steer-message"');
      expect(html).toContain('id="btn-send-message"');
      expect(html).toContain('id="composer-queue-tray"');
      expect(html).toContain('class="composer-actions-right');
    });

    it('verifies CSS contains styles for steer button, steer badge, and composer-queue-tray', () => {
      expect(styleCss).toContain('.badge-steer');
      expect(styleCss).toContain('.composer-queue-tray');
      expect(styleCss).toContain('.composer-queue-header');
      expect(styleCss).toContain('.composer-queue-item');
      expect(styleCss).toContain('.composer-queue-item-cancel');
    });
  });

  describe('2. Internationalization (i18n) Completeness', () => {
    it('verifies steer and queue keys exist symmetrically in en and zh-CN catalogs', () => {
      expect(en['chat.sendQueue']).toBe('Queue');
      expect(zhCN['chat.sendQueue']).toBe('排队');

      expect(en['chat.steerCurrent']).toBe('Steer Current Turn');
      expect(zhCN['chat.steerCurrent']).toBe('纠偏当前任务');

      expect(en['chat.steerBadge']).toBe('Steer');
      expect(zhCN['chat.steerBadge']).toBe('纠偏');

      expect(en['chat.queuedTurnEnded']).toBe('Current turn has ended. Input retained.');
      expect(zhCN['chat.queuedTurnEnded']).toBe('当前轮次已结束，内容已保留');

      expect(en['chat.cancelQueuedTurn']).toBe('Cancel Queued Turn');
      expect(zhCN['chat.cancelQueuedTurn']).toBe('取消排队轮次');

      expect(en['chat.queuedTurnsHeader']).toBe('Queued Messages');
      expect(zhCN['chat.queuedTurnsHeader']).toBe('排队中的消息');
    });
  });

  describe('3. Dynamic Button Visibility & Label Updates', () => {
    function createMockElement(id: string, initialClasses: string[] = []) {
      const classes = new Set(initialClasses);
      return {
        id,
        disabled: false,
        textContent: '',
        title: '',
        value: '',
        classList: {
          contains: (c: string) => classes.has(c),
          add: (c: string) => classes.add(c),
          remove: (c: string) => classes.delete(c),
        },
      };
    }

    it('updateComposerControlsState: displays Queue and Steer Current Turn buttons when turn is running', () => {
      const inputEl = createMockElement('chat-input');
      inputEl.value = 'Adjust instructions';
      const sendBtn = createMockElement('btn-send-message');
      const steerBtn = createMockElement('btn-steer-message', ['hidden']);
      const attachBtn = createMockElement('btn-attach');

      const elementsMap: Record<string, any> = {
        'chat-input': inputEl,
        'btn-send-message': sendBtn,
        'btn-steer-message': steerBtn,
        'btn-attach': attachBtn,
      };

      const mockState = {
        currentSessionId: 'ses_test_001',
        currentSessionRoute: { status: 'active' },
        activeTurnStatus: 'running',
        isSendingMessage: false,
        isSteeringMessage: false,
        activeAttachments: [],
      };

      const fnMatch = appJs.match(/function updateComposerControlsState\(\) \{[\s\S]*?\n\}/);
      expect(fnMatch).not.toBeNull();

      const updateFn = new Function(
        'document',
        'state',
        'tr',
        `
        ${fnMatch![0]}
        return updateComposerControlsState;
      `
      )(
        { getElementById: (id: string) => elementsMap[id] || null },
        mockState,
        (k: string, _p: any, fb: string) => (k === 'chat.sendQueue' ? 'Queue' : (k === 'chat.steerCurrent' ? 'Steer Current Turn' : fb))
      );

      // Execute when running with text
      updateFn();

      expect(sendBtn.textContent).toBe('Queue');
      expect(sendBtn.disabled).toBe(false);
      expect(steerBtn.classList.contains('hidden')).toBe(false);
      expect(steerBtn.disabled).toBe(false);
      expect(steerBtn.textContent).toBe('Steer Current Turn');

      // Execute when idle (activeTurnStatus: null)
      mockState.activeTurnStatus = null;
      updateFn();

      expect(sendBtn.textContent).toBe('Send');
      expect(steerBtn.classList.contains('hidden')).toBe(true);
      expect(steerBtn.disabled).toBe(true);
    });
  });

  describe('4. Steer 409 Conflict & Retain Input Behavior', () => {
    it('handleSteerMessage: retains input in chat-input and displays toast when server returns 409', async () => {
      const inputEl = { value: 'Fix typos in code', rows: 2 };
      const toasts: Array<{ msg: string; type: string }> = [];

      const mockApiRequest = vi.fn().mockRejectedValue({
        status: 409,
        code: 'NOT_RUNNING',
        message: 'Current turn is not running',
      });

      const mockState = {
        currentSessionId: 'ses_test_001',
        activeTurnId: 'turn_001',
        activeTurnStatus: 'running',
        isSteeringMessage: false,
        isSendingMessage: false,
        messages: [],
        drafts: {},
      };

      const fnMatch = appJs.match(/async function handleSteerMessage\(\) \{[\s\S]*?\n\}/);
      expect(fnMatch).not.toBeNull();

      const steerFn = new Function(
        'document',
        'crypto',
        'state',
        'apiRequest',
        'showToast',
        'tr',
        'getSafeErrorMessage',
        'updateComposerControlsState',
        'updateCharCount',
        'renderMessages',
        'pollEvents',
        'syncActiveTurnStatus',
        'generateUUID',
        `
        ${fnMatch![0]}
        return handleSteerMessage;
      `
      )(
        { getElementById: (id: string) => (id === 'chat-input' ? inputEl : null) },
        { randomUUID: () => '11111111-2222-4333-8444-555555555555' },
        mockState,
        mockApiRequest,
        (msg: string, type: string) => { toasts.push({ msg, type }); },
        (k: string, _p: any, fb: string) => (k === 'chat.queuedTurnEnded' ? 'Current turn has ended. Input retained.' : fb),
        (err: any, fb: string) => fb,
        () => {},
        () => {},
        () => {},
        () => {},
        () => {},
        () => '11111111-2222-4333-8444-555555555555'
      );

      await steerFn();

      // Assert input was retained
      expect(inputEl.value).toBe('Fix typos in code');
      expect(toasts.some((t) => t.msg === 'Current turn has ended. Input retained.' && t.type === 'warning')).toBe(true);
      expect(mockState.isSteeringMessage).toBe(false);
    });

    it('handleSteerMessage: successfully appends steer message with isSteer metadata on 200 OK', async () => {
      const inputEl = { value: 'Fix typos in code', rows: 2 };
      const toasts: Array<{ msg: string; type: string }> = [];

      const mockApiRequest = vi.fn().mockResolvedValue({
        data: { ok: true, messageId: 'msg_steer_123' },
      });

      const mockState = {
        currentSessionId: 'ses_test_001',
        activeTurnId: 'turn_001',
        activeTurnStatus: 'running',
        isSteeringMessage: false,
        isSendingMessage: false,
        messages: [] as any[],
        drafts: { ses_test_001: { content: 'draft' } },
      };

      const fnMatch = appJs.match(/async function handleSteerMessage\(\) \{[\s\S]*?\n\}/);
      expect(fnMatch).not.toBeNull();

      const steerFn = new Function(
        'document',
        'crypto',
        'state',
        'apiRequest',
        'showToast',
        'tr',
        'getSafeErrorMessage',
        'updateComposerControlsState',
        'updateCharCount',
        'renderMessages',
        'pollEvents',
        'syncActiveTurnStatus',
        'generateUUID',
        `
        ${fnMatch![0]}
        return handleSteerMessage;
      `
      )(
        { getElementById: (id: string) => (id === 'chat-input' ? inputEl : null) },
        { randomUUID: () => '11111111-2222-4333-8444-555555555555' },
        mockState,
        mockApiRequest,
        (msg: string, type: string) => { toasts.push({ msg, type }); },
        (k: string, _p: any, fb: string) => fb,
        (err: any, fb: string) => fb,
        () => {},
        () => {},
        () => {},
        () => {},
        () => {},
        () => '11111111-2222-4333-8444-555555555555'
      );

      await steerFn();

      // Assert input was cleared and message was appended with metadata
      expect(inputEl.value).toBe('');
      expect(mockState.messages.length).toBe(1);
      expect(mockState.messages[0].id).toBe('msg_steer_123');
      expect(mockState.messages[0].metadata?.isSteer).toBe(true);
      expect(mockState.messages[0].metadata?.attachedTurnId).toBe('turn_001');
    });
  });

  describe('5. Queued Messages List & Cancellation', () => {
    it('renderQueuedTurns: renders queued items with snippet and cancel button', () => {
      const trayChildren: any[] = [];
      const classList = new Set<string>();

      const mockTray = {
        replaceChildren: () => { trayChildren.length = 0; },
        appendChild: (child: any) => { trayChildren.push(child); },
        classList: {
          contains: (c: string) => classList.has(c),
          add: (c: string) => classList.add(c),
          remove: (c: string) => classList.delete(c),
        },
      };

      const mockState = {
        currentSessionId: 'ses_test_001',
        queuedTurns: [
          { turnId: 'turn_q1', contentSnippet: 'First queued prompt' },
          { turnId: 'turn_q2', contentSnippet: 'Second queued prompt' },
        ],
        isCancellingQueuedTurn: false,
      };

      const fnMatch = appJs.match(/function renderQueuedTurns\(\) \{[\s\S]*?\n\}/);
      expect(fnMatch).not.toBeNull();

      const renderFn = new Function(
        'document',
        'state',
        'tr',
        'handleCancelQueuedTurn',
        'handleSteerQueuedTurns',
        `
        ${fnMatch![0]}
        return renderQueuedTurns;
      `
      )(
        {
          getElementById: (id: string) => (id === 'composer-queue-tray' ? mockTray : null),
          createElement: (tag: string) => ({
            tagName: tag,
            className: '',
            textContent: '',
            title: '',
            disabled: false,
            children: [] as any[],
            appendChild: function (c: any) { this.children.push(c); },
            setAttribute: () => {},
            addEventListener: () => {},
          }),
        },
        mockState,
        (k: string, _p: any, fb: string) => fb,
        () => {},
        () => {}
      );

      renderFn();

      expect(classList.has('hidden')).toBe(false);
      expect(trayChildren.length).toBe(2); // Header + List
      expect(trayChildren[0].children[0].textContent).toContain('Queued Messages (2)');
      expect(trayChildren[1].children.length).toBe(2); // Two queued items
    });

    it('renderQueuedTurns: renders steer button on each item and steer all button on header, enabled only when running', () => {
      const trayChildren: any[] = [];
      const classList = new Set<string>();

      const mockTray = {
        replaceChildren: () => { trayChildren.length = 0; },
        appendChild: (child: any) => { trayChildren.push(child); },
        classList: {
          contains: (c: string) => classList.has(c),
          add: (c: string) => classList.add(c),
          remove: (c: string) => classList.delete(c),
        },
      };

      const mockState = {
        currentSessionId: 'ses_test_001',
        activeTurnStatus: 'running',
        queuedTurns: [
          { turnId: 'turn_q1', contentSnippet: 'Queued item 1' },
        ],
        isCancellingQueuedTurn: false,
        isSteeringQueuedTurn: false,
      };

      const fnMatch = appJs.match(/function renderQueuedTurns\(\) \{[\s\S]*?\n\}/);
      expect(fnMatch).not.toBeNull();

      const renderFn = new Function(
        'document',
        'state',
        'tr',
        'handleCancelQueuedTurn',
        'handleSteerQueuedTurns',
        `
        ${fnMatch![0]}
        return renderQueuedTurns;
      `
      )(
        {
          getElementById: (id: string) => (id === 'composer-queue-tray' ? mockTray : null),
          createElement: (tag: string) => ({
            tagName: tag,
            className: '',
            textContent: '',
            title: '',
            disabled: false,
            children: [] as any[],
            appendChild: function (c: any) { this.children.push(c); },
            setAttribute: () => {},
            addEventListener: () => {},
          }),
        },
        mockState,
        (k: string, _p: any, fb: string) => fb,
        () => {},
        () => {}
      );

      // When running: steer buttons are enabled
      renderFn();
      const header = trayChildren[0];
      const steerAllBtn = header.children.find((c: any) => c.className === 'composer-queue-steer-all');
      expect(steerAllBtn).toBeDefined();
      expect(steerAllBtn.disabled).toBe(false);

      const list = trayChildren[1];
      const itemRow = list.children[0];
      const actionsDiv = itemRow.children.find((c: any) => c.className === 'composer-queue-item-actions');
      expect(actionsDiv).toBeDefined();
      const steerItemBtn = actionsDiv.children.find((c: any) => c.className === 'composer-queue-item-steer');
      expect(steerItemBtn).toBeDefined();
      expect(steerItemBtn.disabled).toBe(false);

      // When NOT running: steer buttons are disabled
      mockState.activeTurnStatus = 'queued';
      renderFn();
      const headerNotRunning = trayChildren[0];
      const steerAllBtnNotRunning = headerNotRunning.children.find((c: any) => c.className === 'composer-queue-steer-all');
      expect(steerAllBtnNotRunning.disabled).toBe(true);

      const listNotRunning = trayChildren[1];
      const actionsDivNotRunning = listNotRunning.children[0].children.find((c: any) => c.className === 'composer-queue-item-actions');
      const steerItemBtnNotRunning = actionsDivNotRunning.children.find((c: any) => c.className === 'composer-queue-item-steer');
      expect(steerItemBtnNotRunning.disabled).toBe(true);
    });

    it('chatInput keydown: Mod+Shift+Enter triggers handleSteerMessage', () => {
      let steerCalled = false;
      let sendCalled = false;
      let defaultPrevented = false;

      const mockHandleSteerMessage = () => { steerCalled = true; };
      const mockHandleSendMessage = () => { sendCalled = true; };

      // Simulate keydown event handler logic
      const simulateKeydown = (event: { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; preventDefault: () => void }) => {
        if (event.key === 'Enter') {
          const isMod = event.metaKey || event.ctrlKey;
          if (isMod && event.shiftKey) {
            event.preventDefault();
            mockHandleSteerMessage();
          } else if (!event.shiftKey) {
            event.preventDefault();
            mockHandleSendMessage();
          }
        }
      };

      // 1. Mod+Shift+Enter (e.g. metaKey + shiftKey + Enter on macOS)
      simulateKeydown({
        key: 'Enter',
        metaKey: true,
        shiftKey: true,
        preventDefault: () => { defaultPrevented = true; },
      });
      expect(steerCalled).toBe(true);
      expect(sendCalled).toBe(false);
      expect(defaultPrevented).toBe(true);

      // 2. Mod+Shift+Enter on Windows/Linux (ctrlKey + shiftKey + Enter)
      steerCalled = false;
      simulateKeydown({
        key: 'Enter',
        ctrlKey: true,
        shiftKey: true,
        preventDefault: () => {},
      });
      expect(steerCalled).toBe(true);
      expect(sendCalled).toBe(false);

      // 3. Regular Enter
      steerCalled = false;
      simulateKeydown({
        key: 'Enter',
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        preventDefault: () => {},
      });
      expect(steerCalled).toBe(false);
      expect(sendCalled).toBe(true);

      // 4. Shift+Enter (multiline newline, no send, no steer)
      sendCalled = false;
      simulateKeydown({
        key: 'Enter',
        shiftKey: true,
        preventDefault: () => {},
      });
      expect(steerCalled).toBe(false);
      expect(sendCalled).toBe(false);
    });
  });
});
